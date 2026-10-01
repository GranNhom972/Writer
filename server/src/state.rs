// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Les contributeurs de Writer

//! Configuration et état partagé du serveur.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use dashmap::DashMap;
use uuid::Uuid;

use crate::auth::{AuthMode, AuthSettings};
use crate::doc::DocHandle;
use crate::error::{AppError, AppResult};
use crate::session::SessionRecord;
use crate::store::FileStore;

/// Taille maximale d'une trame de synchronisation.
///
/// Une opération porte un paragraphe entier ; 1 Mio laisse largement la place à
/// un paragraphe long, et coupe net un client qui tenterait d'envoyer un
/// document complet à chaque frappe.
pub const MAX_FRAME_BYTES: usize = 1024 * 1024;
pub const MAX_MESSAGES_PER_SECOND: u32 = 100;
pub const MESSAGE_BURST: u32 = 300;
pub const MAX_CLIENTS_PER_DOCUMENT: usize = 200;

/// Délai au-delà duquel une connexion muette est fermée.
///
/// Un client vivant émet forcément quelque chose bien avant : la présence est
/// renouvelée toutes les ~15 s. Une connexion silencieuse plus longtemps
/// appartient à une page morte — la garder afficherait aux autres des
/// participants fantômes.
pub const IDLE_TIMEOUT_SECS: u64 = 90;

/// Délai de grâce avant de considérer un document réellement abandonné.
///
/// Un rechargement de page ferme le WebSocket et en rouvre un aussitôt. Sans ce
/// délai, chaque `F5` fermerait la session, sauvegarderait dans CloudServ et
/// créerait une version d'historique — l'historique se remplirait de doublons,
/// et la réouverture rechargerait un document qu'on n'a jamais quitté.
pub const DEFAULT_CLOSE_GRACE_SECS: u64 = 30;

/// Accalmie après laquelle la partie utile du document est déchargée vers
/// CloudServ.
///
/// Le déchargement projette le document entier : le faire à chaque frappe
/// saturerait le réseau et le disque de CloudServ pour rien. On attend donc que
/// la frappe s'arrête — dix secondes suffisent à distinguer une pause d'une
/// hésitation entre deux mots.
pub const DEFAULT_CHECKPOINT_QUIET_SECS: u64 = 10;

/// Plafond entre deux déchargements, accalmie ou non.
///
/// Sans lui, une frappe continue ne laisserait jamais venir le calme et le
/// document ne serait déchargé qu'à la fermeture — exactement ce que ce
/// mécanisme corrige. Ce plafond borne donc ce qu'un arrêt brutal peut coûter :
/// au pire deux minutes de travail.
pub const DEFAULT_CHECKPOINT_MAX_SECS: u64 = 120;

#[derive(Debug, Clone)]
pub struct Config {
    pub bind: String,
    pub data_dir: String,
    pub auth: AuthSettings,
    pub allowed_origins: Vec<String>,
    /// Adresse de base de CloudServ, quand Writer lui sert d'éditeur temporaire.
    /// Absente, le serveur fonctionne seul et ne rappelle personne.
    pub cloudserv_url: Option<String>,
    pub close_grace_secs: u64,
    pub checkpoint_quiet_secs: u64,
    pub checkpoint_max_secs: u64,
    /// Racine du bundle de l'éditeur, servi par ce même processus quand elle
    /// est posée (`WRITER_WEB_ROOT`). Absente : seule l'API répond, et c'est
    /// Vite ou HAProxy qui sert la page. Voir `web.rs`.
    pub web_root: Option<std::path::PathBuf>,
}

impl Config {
    pub fn from_env() -> Config {
        let production = std::env::var("WRITER_ENV").as_deref() == Ok("production");
        let mode = match std::env::var("WRITER_AUTH_MODE").as_deref() {
            // Le mode développement accepte `dev.<qui-veut>.write` : toute
            // identité, toute portée, sur tout document. Il ne s'obtient plus
            // par OMISSION — il faut l'écrire, et il reste refusé en
            // production. `WRITER_ENV` n'était posé nulle part dans la stack :
            // lancer le serveur par son propre `run.sh` suffisait à retomber
            // silencieusement dans ce mode.
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
            // `filter(|v| *v > 0)` : un zéro déchargerait à chaque frappe. Ce
            // n'est pas un réglage, c'est une panne — on retient le défaut.
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
    /// Sessions par `token_session`, et index inverse pour retrouver la session
    /// d'un document : le WebSocket de synchronisation ne connaît que le
    /// `doc_id`, et c'est pourtant là que les permissions s'appliquent.
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

    /// Session par jeton : mémoire d'abord, stockage ensuite.
    ///
    /// Un redémarrage du serveur ne DOIT pas invalider les liens de partage déjà
    /// distribués — ils vivent dans des courriels que personne ne renverra.
    pub fn session(&self, token_session: &str) -> AppResult<Arc<SessionRecord>> {
        if !crate::session::valid_token(token_session) {
            // Un jeton mal formé n'a jamais pu être écrit : inutile de toucher au disque.
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

    /// Session à laquelle appartient un document, s'il y en a une. Les documents
    /// créés par `POST /documents` n'en ont pas : leur comportement est inchangé.
    pub fn session_for_doc(&self, doc_id: Uuid) -> Option<Arc<SessionRecord>> {
        if let Some(token) = self.doc_sessions.get(&doc_id) {
            return self.sessions.get(token.value()).map(|r| r.clone());
        }

        // Index froid (premier accès après redémarrage) : on le reconstruit
        // depuis le stockage, une seule fois — `session()` remplit les deux tables.
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

    /// Le document est-il déjà chargé en mémoire ? Sert à distinguer « personne
    /// n'y travaille » de « personne ne s'y est jamais connecté ».
    pub fn doc_if_loaded(&self, doc_id: Uuid) -> Option<Arc<DocHandle>> {
        self.docs.get(&doc_id).map(|entry| entry.clone())
    }

    /// Oublie tout ce que la mémoire retient d'un document : la copie répliquée
    /// et, s'il en avait une, sa session de partage.
    ///
    /// Appelé par la purge. Sans le retrait des tables de session, un
    /// `doc_id` réutilisé — ou simplement un jeton de partage resté en cache —
    /// continuerait de désigner un document dont les fichiers n'existent plus.
    pub fn forget_doc(&self, doc_id: Uuid) {
        self.docs.remove(&doc_id);
        if let Some((_, token)) = self.doc_sessions.remove(&doc_id) {
            self.sessions.remove(&token);
        }
    }

    /// Charge le document depuis le stockage durable si nécessaire :
    /// instantané compacté, puis rejeu du journal d'updates.
    ///
    /// Rejouer est **idempotent** : une update CRDT déjà incluse dans
    /// l'instantané n'a aucun effet la seconde fois. C'est ce qui rend le
    /// rechargement sûr même après une compaction interrompue, sans qu'il faille
    /// comparer des numéros de révision comme le faisait le séquenceur.
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
                // Instantané illisible : on repart du journal, qui contient
                // encore tout si la compaction n'a pas eu lieu. Refuser
                // d'ouvrir le document serait pire que de le rouvrir plus ancien.
                tracing::error!(%doc_id, error = %e, "instantané illisible, rejeu du journal seul");
            }
        }

        let mut rejouees = 0usize;
        for update in &charge.updates {
            // Une update isolée qui ne se décode plus ne DOIT pas rendre le
            // document inouvrable : les autres restent parfaitement valides.
            if let Err(e) = handle.apply_update(update) {
                tracing::warn!(%doc_id, error = %e, "update journalisée ignorée");
                continue;
            }
            rejouees += 1;
        }

        if charge.corrupted > 0 {
            tracing::warn!(%doc_id, trames = charge.corrupted, "trames de journal illisibles");
        }

        // Document écrit par la version précédente : rien au nouveau format,
        // mais un journal d'opérations JSON sur le disque. On le rejoue une fois
        // pour en tirer l'état, et on amorce le document répliqué avec.
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

    /// Reprend un document de l'ancien protocole (opérations de blocs en JSON).
    ///
    /// L'amorçage est journalisé aussitôt : sans cela, la reprise recommencerait
    /// à chaque redémarrage, et une frappe faite entre-temps se verrait doublée
    /// par un second exemplaire du contenu d'origine.
    fn reprendre_ancien(&self, key: &str, doc_id: Uuid, handle: &Arc<DocHandle>) -> AppResult<()> {
        // Un document déjà porteur d'un contenu répliqué ne doit jamais être
        // amorcé une seconde fois : un CRDT ne remplace pas, il ajoute, et le
        // document se retrouverait avec deux exemplaires de tout.
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

    /// Sérialise les tests : ils manipulent des variables d'environnement,
    /// qui sont globales au processus.
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

    /// Le mode `dev` accepte `dev.<qui-veut>.write` : toute identité, toute
    /// portée, sur tout document. Il ne doit jamais s'obtenir par omission —
    /// or `WRITER_ENV` n'est posé nulle part dans la stack, et lancer le
    /// serveur par son propre script suffisait à y retomber.
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
