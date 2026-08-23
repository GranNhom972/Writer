//! Serveur collaboratif de l'application Write.
//!
//! Rôle (ADR-001) : **relais CRDT + journal durable**. Le serveur ne connaît pas
//! le schéma du document — il ne manipule que des updates opaques et convergentes.

mod api;
mod assets;
mod awareness;
mod auth;
mod content;
mod doc;
mod error;
mod events;
mod protocol;
mod session;
mod state;
mod store;
mod sync;

use axum::{
    extract::DefaultBodyLimit,
    routing::{get, post},
    Router,
};
use tower_http::trace::TraceLayer;

use crate::auth::AuthMode;
use crate::state::{AppState, Config};
use crate::store::FileStore;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .json()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "write_server=info,tower_http=warn".into()),
        )
        .init();

    let cfg = Config::from_env();

    if cfg.auth_mode == AuthMode::Dev {
        tracing::warn!(
            "MODE AUTH DÉVELOPPEMENT : jetons `dev.<user>.<scope>` acceptés. \
             Interdit en production (définir WRITE_ENV=production)."
        );
    }

    let store = match FileStore::new(&cfg.data_dir) {
        Ok(store) => store,
        Err(e) => {
            tracing::error!(error = %e, dir = %cfg.data_dir, "stockage inutilisable, arrêt");
            std::process::exit(1);
        }
    };

    let bind = cfg.bind.clone();
    let state = AppState::new(cfg, store);

    let app = Router::new()
        .route("/healthz", get(api::healthz))
        .route("/readyz", get(api::readyz))
        .route("/api/v1/documents", post(api::create_document).get(api::list_documents))
        .route(
            "/api/v1/documents/:doc_id",
            get(api::get_document).patch(api::rename_document),
        )
        .route("/api/v1/documents/:doc_id/snapshot", get(api::get_snapshot))
        // Le plafond est posé sur la route, pas dans le gestionnaire : une charge
        // hors limites est ainsi coupée à la lecture du corps, sans jamais être
        // rassemblée en mémoire.
        .route(
            "/api/v1/documents/:doc_id/assets",
            post(assets::upload_asset).layer(DefaultBodyLimit::max(assets::MAX_ASSET_BYTES)),
        )
        .route(
            "/api/v1/documents/:doc_id/assets/:name",
            get(assets::get_asset),
        )
        .route(
            "/api/v1/documents/:doc_id/restore-points",
            get(api::list_restore_points),
        )
        .route("/api/v1/documents/:doc_id/restore", post(api::restore_document))
        .route(
            "/api/v1/sessions",
            post(session::create_session).get(session::list_sessions),
        )
        .route("/api/v1/sessions/:token_session", get(session::get_session))
        .route(
            "/api/v1/sessions/:token_session/join",
            post(session::join_session),
        )
        .route(
            "/api/v1/sessions/:token_session/events",
            get(events::events_handler),
        )
        .route("/api/v1/sync/:doc_id", get(sync::sync_handler))
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let listener = match tokio::net::TcpListener::bind(&bind).await {
        Ok(l) => l,
        Err(e) => {
            tracing::error!(error = %e, %bind, "impossible d'écouter");
            std::process::exit(1);
        }
    };

    tracing::info!(%bind, "serveur Write démarré");
    if let Err(e) = axum::serve(listener, app).await {
        tracing::error!(error = %e, "arrêt du serveur");
        std::process::exit(1);
    }
}
