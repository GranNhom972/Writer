// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors

//! Application errors, normalized as RFC 9457 "problem details".
//!
//! Rule inherited from the Write server: no `unwrap`/`expect` on an I/O, network
//! or input-deserialization path. Everything bubbles up to here, and the technical
//! detail of an internal failure is **logged**, never sent back to the client.

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
    /// Unreadable CRDT update: a corrupted or hostile frame.
    #[error("état CRDT illisible: {0}")]
    Crdt(String),
    /// Unreadable or inapplicable document operation (old format only).
    #[error("opération invalide: {0}")]
    Operation(String),
    /// Internal failure: an interrupted task or a poisoned lock.
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

        // The technical detail is logged and never sent back to the client on a 5xx:
        // a file path or a library error message would tell an attacker about the
        // inside of the server.
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

/// Turns the failure of a blocking task into an internal error.
///
/// `spawn_blocking` fails when the task panicked or the executor is shutting down.
/// Either way it is a server fault, not the client's.
pub fn joined<T>(result: Result<T, tokio::task::JoinError>) -> AppResult<T> {
    result.map_err(|e| AppError::Internal(e.to_string()))
}
