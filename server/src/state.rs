// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors

//! Server configuration and shared state.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use dashmap::DashMap;
use uuid::Uuid;

use crate::auth::{AuthMode, AuthSettings};
use crate::doc::DocHandle;
use crate::error::{AppError, AppResult};
use crate::session::SessionRecord;
use crate::store::FileStore;

/// Maximum size of a sync frame.
///
/// An operation carries a whole paragraph; 1 MiB leaves plenty of room for a long
/// paragraph, and cuts off at once a client that tries to send a complete document
/// on every keystroke.
pub const MAX_FRAME_BYTES: usize = 1024 * 1024;
pub const MAX_MESSAGES_PER_SECOND: u32 = 100;
pub const MESSAGE_BURST: u32 = 300;
pub const MAX_CLIENTS_PER_DOCUMENT: usize = 200;

/// Time after which a silent connection is closed.
///
/// A live client always sends something well before this: presence is renewed
/// about every 15 s. A connection silent for longer belongs to a dead page, and
/// keeping it would show the others ghost participants.
pub const IDLE_TIMEOUT_SECS: u64 = 90;

/// Grace period before a document is considered really abandoned.
///
/// Reloading a page closes the WebSocket and immediately opens another. Without
/// this delay every `F5` would close the session, save to CloudServ and create a
/// history version: the history would fill with duplicates, and reopening would
/// reload a document that was never left.
pub const DEFAULT_CLOSE_GRACE_SECS: u64 = 30;

/// Quiet period after which the useful part of the document is handed over to
/// CloudServ.
///
/// Handing it over projects the whole document: doing it on every keystroke would
/// overload CloudServ's network and disk for nothing. So we wait for typing to stop;
/// ten seconds is enough to tell a pause from hesitating between two words.
pub const DEFAULT_CHECKPOINT_QUIET_SECS: u64 = 10;

/// Upper bound between two hand-overs, quiet period or not.
///
/// Without it, continuous typing would never let calm arrive and the document would
/// only be handed over when it closes, which is exactly what this mechanism fixes.
/// This ceiling bounds what a sudden shutdown can cost: two minutes of work at the
/// very worst.
pub const DEFAULT_CHECKPOINT_MAX_SECS: u64 = 120;

#[derive(Debug, Clone)]
pub struct Config {
    pub bind: String,
    pub data_dir: String,
    pub auth: AuthSettings,
    pub allowed_origins: Vec<String>,
    /// Base address of CloudServ, when Writer acts as its temporary editor. When
    /// absent, the server runs on its own and calls nobody.
    pub cloudserv_url: Option<String>,
    pub close_grace_secs: u64,
    pub checkpoint_quiet_secs: u64,
    pub checkpoint_max_secs: u64,
    /// Root folder of the editor bundle, served by this same process when it is set
    /// (`WRITER_WEB_ROOT`). When absent only the API answers, and Vite or HAProxy
    /// serves the page. See `web.rs`.
    pub web_root: Option<std::path::PathBuf>,
}

impl Config {
    pub fn from_env() -> Config {
        let production = std::env::var("WRITER_ENV").as_deref() == Ok("production");
        let mode = match std::env::var("WRITER_AUTH_MODE").as_deref() {
            // Development mode accepts `dev.<anyone>.write`: any identity, any scope, on any
            // document. It is no longer obtained by OMISSION: it has to be written
            // explicitly, and it is still refused in production. `WRITER_ENV` was not set
            // anywhere in the stack, so starting the server through its own `run.sh` was
            // enough to silently fall back into this mode.
            Ok("dev") if !production => AuthMode::Dev,
            _ => AuthMode::Jwt,
        };

        Config {
            web_root: crate::web::resolve_root(std::env::var("WRITER_WEB_ROOT").ok().as_deref()),
            bind: std::env::var("WRITER_BIND").unwrap_or_else(|_| "127.0.0.1:8081".into()),
            data_dir: std::env::var("WRITER_DATA_DIR").unwrap_or_else(|_| "./data".into()),
            auth: AuthSettings {
                mode,
                jwt_secret: std::env::var("WRITER_JWT_SECRET")
                    .ok()
                    .filter(|s| !s.is_empty()),
            },
            cloudserv_url: std::env::var("WRITER_CLOUDSERV_URL")
                .ok()
                .map(|url| url.trim_end_matches('/').to_string())
                .filter(|url| !url.is_empty()),
            close_grace_secs: std::env::var("WRITER_CLOSE_GRACE_SECS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(DEFAULT_CLOSE_GRACE_SECS),
            // `filter(|v| *v > 0)`: a zero would hand over on every keystroke. That is not a
            // setting, it is a fault, so we keep the default.
            checkpoint_quiet_secs: std::env::var("WRITER_CHECKPOINT_QUIET_SECS")
                .ok()
                .and_then(|v| v.parse().ok())
                .filter(|v| *v > 0)
                .unwrap_or(DEFAULT_CHECKPOINT_QUIET_SECS),
            checkpoint_max_secs: std::env::var("WRITER_CHECKPOINT_MAX_SECS")
                .ok()
                .and_then(|v| v.parse().ok())
                .filter(|v| *v > 0)
                .unwrap_or(DEFAULT_CHECKPOINT_MAX_SECS),
            allowed_origins: std::env::var("WRITER_ALLOWED_ORIGINS")
                .unwrap_or_else(|_| {
                    "http://localhost:5174,http://127.0.0.1:5174,\
                     http://localhost:4173,http://127.0.0.1:4173"
                        .into()
                })
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect(),
        }
    }
}

#[derive(Clone)]
pub struct AppState {
    pub cfg: Arc<Config>,
    pub store: Arc<FileStore>,
    docs: Arc<DashMap<Uuid, Arc<DocHandle>>>,
    /// Sessions by `token_session`, and a reverse index to find the session of a
    /// document: the sync WebSocket only knows the `doc_id`, yet that is where the
    /// permissions are applied.
    sessions: Arc<DashMap<String, Arc<SessionRecord>>>,
    doc_sessions: Arc<DashMap<Uuid, String>>,
    next_connection_id: Arc<AtomicU64>,
}

impl AppState {
    pub fn new(cfg: Config, store: FileStore) -> Self {
        Self {
            cfg: Arc::new(cfg),
            store: Arc::new(store),
            docs: Arc::new(DashMap::new()),
            sessions: Arc::new(DashMap::new()),
            doc_sessions: Arc::new(DashMap::new()),
            next_connection_id: Arc::new(AtomicU64::new(1)),
        }
    }

    // ── Sessions ─────────────────────────────────────────────────────────────

    pub fn insert_session(&self, record: Arc<SessionRecord>) {
        self.doc_sessions
            .insert(record.doc_id, record.token_session.clone());
        self.sessions.insert(record.token_session.clone(), record);
    }

    /// Session by token: memory first, storage second.
    ///
    /// A server restart MUST NOT invalidate the share links that were already sent
    /// out: they live in e-mails that nobody will send again.
    pub fn session(&self, token_session: &str) -> AppResult<Arc<SessionRecord>> {
        if !crate::session::valid_token(token_session) {
            // A malformed token could never have been written: no need to touch the disk.
            return Err(AppError::SessionNotFound);
        }
        if let Some(existing) = self.sessions.get(token_session) {
            return Ok(existing.clone());
        }

        let raw = self
            .store
            .read_session(token_session)
            .map_err(|e| match e {
                AppError::NotFound => AppError::SessionNotFound,
                other => other,
            })?;
        let record: SessionRecord = serde_json::from_str(&raw)
            .map_err(|e| AppError::Internal(format!("session illisible: {e}")))?;
        let record = Arc::new(record);
        self.insert_session(record.clone());
        Ok(record)
    }

    /// The session a document belongs to, if there is one. Documents created by
    /// `POST /documents` have none: their behavior is unchanged.
    pub fn session_for_doc(&self, doc_id: Uuid) -> Option<Arc<SessionRecord>> {
        if let Some(token) = self.doc_sessions.get(&doc_id) {
            return self.sessions.get(token.value()).map(|r| r.clone());
        }

        // Cold index (first access after a restart): rebuild it from storage, only once.
        // `session()` fills both tables.
        let tokens = self.store.list_sessions().ok()?;
        for token in tokens {
            if let Ok(record) = self.session(&token) {
                if record.doc_id == doc_id {
                    return Some(record);
                }
            }
        }
        None
    }

    pub fn next_connection_id(&self) -> u64 {
        self.next_connection_id.fetch_add(1, Ordering::Relaxed)
    }

    // ── Documents ────────────────────────────────────────────────────────────

    pub fn insert_doc(&self, handle: Arc<DocHandle>) {
        self.docs.insert(handle.id, handle);
    }

    /// Is the document already loaded in memory? Used to tell "nobody is working on
    /// it" from "nobody has ever connected to it".
    pub fn doc_if_loaded(&self, doc_id: Uuid) -> Option<Arc<DocHandle>> {
        self.docs.get(&doc_id).map(|entry| entry.clone())
    }

    /// Forgets everything memory holds about a document: the replicated copy and, if
    /// it had one, its share session.
    ///
    /// Called by the purge. Without removing the session tables, a reused `doc_id`
    /// (or simply a share token left in the cache) would keep designating a document
    /// whose files no longer exist.
    pub fn forget_doc(&self, doc_id: Uuid) {
        self.docs.remove(&doc_id);
        if let Some((_, token)) = self.doc_sessions.remove(&doc_id) {
            self.sessions.remove(&token);
        }
    }

    /// Loads the document from durable storage when needed: the compacted snapshot,
    /// then a replay of the update log.
    ///
    /// Replaying is **idempotent**: a CRDT update already included in the snapshot has
    /// no effect the second time. This is what makes reloading safe even after an
    /// interrupted compaction, without having to compare revision numbers as the old
    /// sequencer did.
    pub fn load_doc(&self, doc_id: Uuid) -> AppResult<Arc<DocHandle>> {
        if let Some(existing) = self.docs.get(&doc_id) {
            return Ok(existing.clone());
        }

        let key = doc_id.to_string();
        if !self.store.exists(&key) {
            return Err(AppError::NotFound);
        }

        let handle = Arc::new(DocHandle::new(doc_id));
        let charge = self.store.load(&key)?;

        if let Some(instantane) = &charge.snapshot {
            if let Err(e) = handle.apply_update(instantane) {
                // Unreadable snapshot: start again from the log, which still holds everything if
                // compaction did not happen. Refusing to open the document would be worse than
                // reopening it in an older state.
                tracing::error!(%doc_id, error = %e, "instantané illisible, rejeu du journal seul");
            }
        }

        let mut rejouees = 0usize;
        for update in &charge.updates {
            // A single update that can no longer be decoded MUST NOT make the document
            // impossible to open: the others remain perfectly valid.
            if let Err(e) = handle.apply_update(update) {
                tracing::warn!(%doc_id, error = %e, "update journalisée ignorée");
                continue;
            }
            rejouees += 1;
        }

        if charge.corrupted > 0 {
            tracing::warn!(%doc_id, trames = charge.corrupted, "trames de journal illisibles");
        }

        // Document written by the previous version: nothing in the new format, but a JSON
        // operation log on disk. We replay it once to obtain the state, and seed the
        // replicated document with it.
        if !self.store.has_crdt_state(&key) {
            self.reprendre_ancien(&key, doc_id, &handle)?;
        }

        tracing::info!(
            %doc_id,
            rejouees,
            instantane = charge.snapshot.is_some(),
            blocs = handle.block_count(),
            "document chargé"
        );

        self.docs.insert(doc_id, handle.clone());
        Ok(handle)
    }

    /// Takes over a document from the old protocol (block operations in JSON).
    ///
    /// The seed is logged immediately: without that, the takeover would start again at
    /// every restart, and a keystroke made in between would be doubled by a second copy
    /// of the original content.
    fn reprendre_ancien(&self, key: &str, doc_id: Uuid, handle: &Arc<DocHandle>) -> AppResult<()> {
        // A document that already holds replicated content must never be seeded a second
        // time: a CRDT does not replace, it adds, and the document would end up with two
        // copies of everything.
        if handle.is_seeded() {
            return Ok(());
        }
        let Some(ancien) = self.store.load_legacy(key)? else {
            return Ok(());
        };

        let etat = crate::legacy::replay(ancien.snapshot, &ancien.operations)?;
        let update = handle.seed(&etat)?;
        self.store.write_snapshot(key, &update)?;

        tracing::info!(
            %doc_id,
            operations = ancien.operations.len(),
            blocs = handle.block_count(),
            "document de l'ancien format repris et converti"
        );
        Ok(())
    }

    pub fn loaded_count(&self) -> usize {
        self.docs.len()
    }
}

#[cfg(test)]
mod auth_mode_tests {
    use super::*;

    /// Serializes the tests: they change environment variables, which are global to
    /// the process.
    static VERROU: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn avec_env<T>(paires: &[(&str, Option<&str>)], f: impl FnOnce() -> T) -> T {
        let _g = VERROU.lock().unwrap_or_else(|e| e.into_inner());
        let anciens: Vec<_> = paires
            .iter()
            .map(|(cle, _)| (*cle, std::env::var(cle).ok()))
            .collect();
        for (cle, valeur) in paires {
            match valeur {
                Some(v) => std::env::set_var(cle, v),
                None => std::env::remove_var(cle),
            }
        }
        let resultat = f();
        for (cle, ancien) in anciens {
            match ancien {
                Some(v) => std::env::set_var(cle, v),
                None => std::env::remove_var(cle),
            }
        }
        resultat
    }

    /// `dev` mode accepts `dev.<anyone>.write`: any identity, any scope, on any
    /// document. It must never be obtained by omission, yet `WRITER_ENV` is not set
    /// anywhere in the stack, and starting the server through its own script was
    /// enough to fall back into it.
    #[test]
    fn omission_gives_jwt_not_dev() {
        let mode = avec_env(&[("WRITER_AUTH_MODE", None), ("WRITER_ENV", None)], || {
            Config::from_env().auth.mode
        });
        assert_eq!(mode, AuthMode::Jwt);
    }

    #[test]
    fn dev_mode_must_be_written_explicitly() {
        let mode = avec_env(
            &[("WRITER_AUTH_MODE", Some("dev")), ("WRITER_ENV", None)],
            || Config::from_env().auth.mode,
        );
        assert_eq!(mode, AuthMode::Dev);
    }

    #[test]
    fn production_refuses_dev_mode_even_when_asked() {
        let mode = avec_env(
            &[
                ("WRITER_AUTH_MODE", Some("dev")),
                ("WRITER_ENV", Some("production")),
            ],
            || Config::from_env().auth.mode,
        );
        assert_eq!(mode, AuthMode::Jwt);
    }

    #[test]
    fn an_unknown_value_falls_back_to_jwt() {
        let mode = avec_env(
            &[
                ("WRITER_AUTH_MODE", Some("nimporte-quoi")),
                ("WRITER_ENV", None),
            ],
            || Config::from_env().auth.mode,
        );
        assert_eq!(mode, AuthMode::Jwt);
    }
}
