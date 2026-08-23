//! Configuration et état partagé du serveur.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use dashmap::DashMap;
use uuid::Uuid;

use crate::auth::AuthMode;
use crate::doc::DocHandle;
use crate::error::{AppError, AppResult};
use crate::session::SessionRecord;
use crate::store::FileStore;

/// Limites appliquées (integration_api_rust.md §6).
pub const MAX_FRAME_BYTES: usize = 1024 * 1024; // 1 Mio
pub const MAX_MESSAGES_PER_SECOND: u32 = 100;
pub const MESSAGE_BURST: u32 = 300;
pub const MAX_CLIENTS_PER_DOCUMENT: usize = 200;
/// Délai au-delà duquel une connexion muette est fermée.
///
/// Un client vivant émet forcément quelque chose bien avant : la présence est
/// renouvelée toutes les ~15 s et la resynchronisation toutes les 30 s. Une
/// connexion silencieuse plus longtemps appartient donc à une page morte
/// (onglet gelé, navigation sans fermeture propre) — la garder afficherait des
/// participants fantômes à tous les autres.
pub const IDLE_TIMEOUT_SECS: u64 = 90;

#[derive(Debug, Clone)]
pub struct Config {
    pub bind: String,
    pub data_dir: String,
    pub auth_mode: AuthMode,
    pub allowed_origins: Vec<String>,
}

impl Config {
    pub fn from_env() -> Config {
        let production = std::env::var("WRITE_ENV").as_deref() == Ok("production");
        let auth_mode = match std::env::var("WRITE_AUTH_MODE").as_deref() {
            Ok("jwt") => AuthMode::Jwt,
            _ if production => AuthMode::Jwt, // jamais de mode dev en production
            _ => AuthMode::Dev,
        };

        Config {
            bind: std::env::var("WRITE_BIND").unwrap_or_else(|_| "127.0.0.1:8080".into()),
            data_dir: std::env::var("WRITE_DATA_DIR").unwrap_or_else(|_| "./data".into()),
            auth_mode,
            allowed_origins: std::env::var("WRITE_ALLOWED_ORIGINS")
                .unwrap_or_else(|_| "http://localhost:5173,http://127.0.0.1:5173,http://localhost:6000,http://127.0.0.1:6000,http://localhost:6001,http://127.0.0.1:6001,http://localhost:6002,http://127.0.0.1:6002".into())
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
    /// Sessions par `token_session`, et index inverse pour retrouver la session
    /// d'un document : le WebSocket de synchronisation ne connaît que le `doc_id`,
    /// et c'est pourtant là que les permissions doivent s'appliquer.
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

    /// Session par jeton : mémoire d'abord, stockage ensuite. Un redémarrage du
    /// serveur ne DOIT pas invalider les liens déjà distribués.
    pub fn session(&self, token_session: &str) -> AppResult<Arc<SessionRecord>> {
        if !crate::session::valid_token(token_session) {
            // Un jeton mal formé n'a jamais pu être écrit : inutile de toucher au disque.
            return Err(AppError::SessionNotFound);
        }
        if let Some(existing) = self.sessions.get(token_session) {
            return Ok(existing.clone());
        }

        let raw = self.store.read_session(token_session).map_err(|e| match e {
            AppError::NotFound => AppError::SessionNotFound,
            other => other,
        })?;
        let record: SessionRecord = serde_json::from_str(&raw)
            .map_err(|e| AppError::Crdt(format!("session illisible: {e}")))?;
        let record = Arc::new(record);
        self.insert_session(record.clone());
        Ok(record)
    }

    /// Session à laquelle appartient un document, s'il y en a une. Les documents
    /// créés par `POST /documents` n'en ont pas : leur comportement est inchangé.
    pub fn session_for_doc(&self, doc_id: Uuid) -> Option<Arc<SessionRecord>> {
        if let Some(token) = self.doc_sessions.get(&doc_id) {
            return self.sessions.get(token.value()).map(|r| r.clone());
        }

        // Index froid (premier accès après redémarrage) : on le reconstruit depuis
        // le stockage, une fois.
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

    pub fn insert_doc(&self, handle: Arc<DocHandle>) {
        self.docs.insert(handle.id, handle);
    }

    /// Charge le document depuis le stockage durable si nécessaire :
    /// snapshot compacté, puis rejeu du journal (idempotent).
    pub fn load_doc(&self, doc_id: Uuid) -> AppResult<Arc<DocHandle>> {
        if let Some(existing) = self.docs.get(&doc_id) {
            return Ok(existing.clone());
        }

        let key = doc_id.to_string();
        if !self.store.exists(&key) {
            return Err(AppError::NotFound);
        }

        let loaded = self.store.load(&key)?;
        let handle = Arc::new(DocHandle::new(doc_id));

        if let Some(snapshot) = &loaded.snapshot {
            handle.apply_update(snapshot)?;
        }
        for update in &loaded.updates {
            // Une update corrompue isolée ne DOIT pas rendre le document inouvrable.
            if let Err(e) = handle.apply_update(update) {
                tracing::warn!(doc_id = %doc_id, error = %e, "update journalisée ignorée");
            }
        }

        tracing::info!(
            doc_id = %doc_id,
            replayed = loaded.updates.len(),
            snapshot = loaded.snapshot.is_some(),
            "document chargé"
        );

        self.docs.insert(doc_id, handle.clone());
        Ok(handle)
    }

    pub fn loaded_count(&self) -> usize {
        self.docs.len()
    }
}
