//! Erreurs applicatives normalisées RFC 9457 (cf. integration_api_rust.md §1.1).
//!
//! Règle de la directive : aucun `unwrap`/`expect` sur un chemin d'I/O, de réseau
//! ou de désérialisation d'entrée. Tout remonte ici.

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
    #[error("état CRDT illisible: {0}")]
    Crdt(String),
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
        }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, kind) = self.parts();

        // Le détail technique est journalisé, jamais renvoyé au client sur 5xx.
        let detail = match &self {
            AppError::Storage(e) => {
                tracing::error!(error = %e, "défaillance du stockage");
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
