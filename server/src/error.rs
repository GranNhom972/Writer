// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Les contributeurs de Writer

//! Erreurs applicatives normalisées RFC 9457.
//!
//! Règle reprise du serveur Write : aucun `unwrap`/`expect` sur un chemin d'I/O,
//! de réseau ou de désérialisation d'entrée. Tout remonte ici, et le détail
//! technique d'une panne interne est **journalisé**, jamais renvoyé au client.

use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("document introuvable")]
    NotFound,
    #[error("aucune session ne porte ce token_session")]
    SessionNotFound,
    #[error("authentification requise")]
    Unauthorized,
    #[error("portée insuffisante")]
    Forbidden,
    #[error("requête invalide: {0}")]
    BadRequest(String),
    #[error("conflit d'état: {0}")]
    Conflict(String),
    #[error("charge utile hors limites")]
    PayloadTooLarge,
    #[error("stockage indisponible")]
    Storage(#[from] std::io::Error),
    /// Update CRDT illisible : trame corrompue ou hostile.
    #[error("état CRDT illisible: {0}")]
    Crdt(String),
    /// Opération de document illisible ou inapplicable — ancien format seulement.
    #[error("opération invalide: {0}")]
    Operation(String),
    /// Défaillance interne : tâche interrompue, verrou empoisonné.
    #[error("erreur interne: {0}")]
    Internal(String),
}

impl AppError {
    fn parts(&self) -> (StatusCode, &'static str) {
        match self {
            AppError::NotFound => (StatusCode::NOT_FOUND, "document-not-found"),
            AppError::SessionNotFound => (StatusCode::NOT_FOUND, "session-not-found"),
            AppError::Unauthorized => (StatusCode::UNAUTHORIZED, "unauthenticated"),
            AppError::Forbidden => (StatusCode::FORBIDDEN, "insufficient-scope"),
            AppError::BadRequest(_) => (StatusCode::BAD_REQUEST, "invalid-request"),
            AppError::Conflict(_) => (StatusCode::CONFLICT, "session-already-exists"),
            AppError::PayloadTooLarge => (StatusCode::PAYLOAD_TOO_LARGE, "payload-too-large"),
            AppError::Storage(_) => (StatusCode::INTERNAL_SERVER_ERROR, "internal"),
            AppError::Crdt(_) => (StatusCode::BAD_REQUEST, "invalid-crdt-update"),
            AppError::Operation(_) => (StatusCode::BAD_REQUEST, "invalid-operation"),
            AppError::Internal(_) => (StatusCode::INTERNAL_SERVER_ERROR, "internal"),
        }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, kind) = self.parts();

        // Le détail technique est journalisé, jamais renvoyé au client sur 5xx :
        // un chemin de fichier ou un message de bibliothèque renseignerait un
        // attaquant sur l'intérieur du serveur.
        let detail = match &self {
            AppError::Storage(e) => {
                tracing::error!(error = %e, "défaillance du stockage");
                "Une erreur interne est survenue.".to_string()
            }
            AppError::Internal(e) => {
                tracing::error!(error = %e, "défaillance interne");
                "Une erreur interne est survenue.".to_string()
            }
            other => other.to_string(),
        };

        let body = json!({
            "type": format!("https://errors.cloudantille.local/{kind}"),
            "title": kind,
            "status": status.as_u16(),
            "detail": detail,
        });
        (status, Json(body)).into_response()
    }
}

pub type AppResult<T> = Result<T, AppError>;

/// Convertit l'échec d'une tâche bloquante en erreur interne.
///
/// `spawn_blocking` échoue quand la tâche a paniqué ou que l'exécuteur s'arrête :
/// dans les deux cas c'est une panne du serveur, pas une faute du client.
pub fn joined<T>(result: Result<T, tokio::task::JoinError>) -> AppResult<T> {
    result.map_err(|e| AppError::Internal(e.to_string()))
}
