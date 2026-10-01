// SPDX-License-Identifier: Apache-2.0 AND GPL-3.0-or-later
// Copyright (C) 2026 Les contributeurs de Writer
//
// Œuvre dérivée et modifiée d'Apache OpenOffice 4.1.16 (© The Apache Software
// Foundation, Apache License 2.0) : portage en Rust, fichier modifié par
// rapport à l'original. Voir les fichiers NOTICE et LICENSE-APACHE.

//! Serveur de partage du moteur Writer.
//!
//! Rôle : **relais CRDT + journal durable + dépôt d'images**, comme le serveur
//! de l'application Write dont il reprend la couche de synchronisation. Le
//! serveur ne connaît pas le schéma du document : il ne manipule que des updates
//! Yjs opaques et convergentes, ce qui lui évite d'avoir à ordonner quoi que ce
//! soit — et permet à deux personnes d'écrire dans le même paragraphe sans que
//! l'une efface l'autre.
//!
//! Deux chemins **optionnels** font exception, et un seul module les porte
//! (`content.rs`) : l'amorçage d'un partage à partir du document fourni par le
//! client, et la projection en JSON pour l'observation. Le cœur du relais, lui,
//! reste aveugle au contenu.

mod api;
mod assets;
mod auth;
mod awareness;
mod content;
mod crypto;
mod doc;
mod error;
mod events;
mod hook;
mod legacy;
mod protocol;
mod session;
mod state;
mod store;
mod sync;
mod web;

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
                .unwrap_or_else(|_| "writer_server=info,tower_http=warn".into()),
        )
        .init();

    let cfg = Config::from_env();

    if cfg.auth.mode == AuthMode::Dev {
        tracing::warn!(
            "MODE AUTH DÉVELOPPEMENT : jetons `dev.<user>.<scope>` acceptés. \
             Interdit en production (définir WRITER_ENV=production)."
        );
    }

    // Le mode JWT sans secret n'accepterait aucun jeton : tout répondrait 401
    // sans que rien ne dise pourquoi. Mieux vaut refuser de démarrer.
    if !cfg.auth.is_usable() {
        tracing::error!(
            "WRITER_AUTH_MODE=jwt exige WRITER_JWT_SECRET — le même secret que \
             celui dont CloudServ signe ses billets d'accès. Arrêt."
        );
        std::process::exit(1);
    }

    match &cfg.cloudserv_url {
        Some(url) => {
            tracing::info!(%url, grace = cfg.close_grace_secs, "intégration CloudServ active")
        }
        None => tracing::info!(
            "WRITER_CLOUDSERV_URL absent : serveur autonome, aucune sauvegarde ni purge externe"
        ),
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
        // ── Documents ────────────────────────────────────────────────────────
        .route(
            "/api/v1/documents",
            post(api::create_document).get(api::list_documents),
        )
        .route(
            "/api/v1/documents/:doc_id",
            get(api::get_document)
                .patch(api::rename_document)
                .delete(api::delete_document),
        )
        .route("/api/v1/documents/:doc_id/snapshot", get(api::get_snapshot))
        .route(
            "/api/v1/documents/:doc_id/restore-points",
            get(api::list_restore_points),
        )
        .route(
            "/api/v1/documents/:doc_id/restore",
            post(api::restore_document),
        )
        // ── Images ───────────────────────────────────────────────────────────
        //
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
        // ── Partage ──────────────────────────────────────────────────────────
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
            "/api/v1/sessions/:token_session/participants",
            post(session::invite_participant),
        )
        .route(
            "/api/v1/sessions/:token_session/events",
            get(events::events_handler),
        )
        // ── Synchronisation ──────────────────────────────────────────────────
        .route("/api/v1/sync/:doc_id", get(sync::sync_handler))
        // ── Page de l'éditeur ────────────────────────────────────────────────
        //
        // En DERNIER, et en repli : toute URL qui n'est pas une route ci-dessus
        // appartient au routeur React (`/doc/<id>`…). Sans cela, la page devait
        // être servie à part — et alors son origine ne portait pas l'API, ce que
        // ni le `fetch` relatif ni le WebSocket de synchronisation ne tolèrent.
        .fallback(web::spa_fallback)
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let listener = match tokio::net::TcpListener::bind(&bind).await {
        Ok(l) => l,
        Err(e) => {
            tracing::error!(error = %e, %bind, "impossible d'écouter");
            std::process::exit(1);
        }
    };

    tracing::info!(%bind, "serveur Writer démarré");
    if let Err(e) = axum::serve(listener, app).await {
        tracing::error!(error = %e, "arrêt du serveur");
        std::process::exit(1);
    }
}
