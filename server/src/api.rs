//! Routes REST v1 (sous-ensemble Write du contrat integration_api_rust.md §2).

use axum::{
    extract::{Path, State},
    http::{header, HeaderMap, StatusCode},
    response::IntoResponse,
    Json,
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;

use crate::auth::identity_from_headers;
use crate::doc::DocHandle;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

const MAX_TITLE_LEN: usize = 200;

#[derive(Debug, Serialize, Deserialize)]
pub struct DocumentMeta {
    pub doc_id: Uuid,
    pub kind: String,
    pub title: String,
    pub owner_id: String,
    pub created_at: String,
}

#[derive(Debug, Deserialize)]
pub struct CreateDocumentRequest {
    #[serde(default)]
    pub title: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct RenameDocumentRequest {
    pub title: String,
}

/// `POST /api/v1/documents`
pub async fn create_document(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Option<Json<CreateDocumentRequest>>,
) -> AppResult<impl IntoResponse> {
    let identity = identity_from_headers(&headers, state.cfg.auth_mode)?;
    if !identity.scope.can_write() {
        return Err(AppError::Forbidden);
    }

    let title = body
        .and_then(|Json(b)| b.title)
        .unwrap_or_else(|| "Document sans titre".to_string());
    if title.chars().count() > MAX_TITLE_LEN {
        return Err(AppError::BadRequest("titre trop long".into()));
    }

    // L'identifiant est généré par le SERVEUR (UUIDv7) : un client ne choisit jamais
    // l'identifiant d'une ressource — correction de la faille `unique_signature` v1.
    let doc_id = Uuid::now_v7();
    let meta = DocumentMeta {
        doc_id,
        kind: "write".into(),
        title,
        owner_id: identity.user_id.clone(),
        created_at: Utc::now().to_rfc3339(),
    };

    let meta_json = serde_json::to_string(&meta)
        .map_err(|e| AppError::BadRequest(format!("métadonnées invalides: {e}")))?;
    let store = state.store.clone();
    let key = doc_id.to_string();
    tokio::task::spawn_blocking(move || store.create(&key, &meta_json))
        .await
        .map_err(|e| AppError::Crdt(e.to_string()))??;

    state.insert_doc(std::sync::Arc::new(DocHandle::new(doc_id)));
    tracing::info!(doc_id = %doc_id, owner = %identity.user_id, "document créé");

    Ok((
        StatusCode::CREATED,
        Json(json!({
            "doc_id": meta.doc_id,
            "kind": meta.kind,
            "title": meta.title,
            "owner": meta.owner_id,
            "created_at": meta.created_at,
            "sync_path": format!("/api/v1/sync/{doc_id}"),
        })),
    ))
}

/// `GET /api/v1/documents`
pub async fn list_documents(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> AppResult<impl IntoResponse> {
    identity_from_headers(&headers, state.cfg.auth_mode)?;

    let store = state.store.clone();
    let ids = tokio::task::spawn_blocking(move || {
        let ids = store.list()?;
        let mut metas = Vec::new();
        for id in ids {
            if let Ok(raw) = store.read_meta(&id) {
                if let Ok(meta) = serde_json::from_str::<DocumentMeta>(&raw) {
                    metas.push(meta);
                }
            }
        }
        Ok::<_, AppError>(metas)
    })
    .await
    .map_err(|e| AppError::Crdt(e.to_string()))??;

    Ok(Json(json!({ "documents": ids })))
}

/// `GET /api/v1/documents/{doc_id}`
pub async fn get_document(
    State(state): State<AppState>,
    Path(doc_id): Path<Uuid>,
    headers: HeaderMap,
) -> AppResult<impl IntoResponse> {
    identity_from_headers(&headers, state.cfg.auth_mode)?;

    let store = state.store.clone();
    let key = doc_id.to_string();
    let raw = tokio::task::spawn_blocking(move || store.read_meta(&key))
        .await
        .map_err(|e| AppError::Crdt(e.to_string()))??;
    let meta: DocumentMeta = serde_json::from_str(&raw)
        .map_err(|e| AppError::BadRequest(format!("métadonnées corrompues: {e}")))?;

    let handle = state.load_doc(doc_id)?;

    Ok(Json(json!({
        "doc_id": meta.doc_id,
        "kind": meta.kind,
        "title": meta.title,
        "owner": meta.owner_id,
        "created_at": meta.created_at,
        "active_clients": handle.active_clients(),
        "state_vector": base64(&handle.state_vector()),
    })))
}

/// `PATCH /api/v1/documents/{doc_id}` — renomme un document.
///
/// Le titre est aussi répliqué par le CRDT (visible immédiatement chez tous) ;
/// cette route le rend durable pour la liste des documents.
pub async fn rename_document(
    State(state): State<AppState>,
    Path(doc_id): Path<Uuid>,
    headers: HeaderMap,
    Json(body): Json<RenameDocumentRequest>,
) -> AppResult<impl IntoResponse> {
    let identity = identity_from_headers(&headers, state.cfg.auth_mode)?;
    if !identity.scope.can_write() {
        return Err(AppError::Forbidden);
    }

    let title = body.title.trim().to_string();
    if title.is_empty() || title.chars().count() > MAX_TITLE_LEN {
        return Err(AppError::BadRequest(
            "titre vide ou trop long".into(),
        ));
    }

    let store = state.store.clone();
    let key = doc_id.to_string();
    let meta = tokio::task::spawn_blocking(move || {
        let raw = store.read_meta(&key)?;
        let mut meta: DocumentMeta = serde_json::from_str(&raw)
            .map_err(|e| AppError::BadRequest(format!("métadonnées corrompues: {e}")))?;
        meta.title = title;
        let updated = serde_json::to_string(&meta)
            .map_err(|e| AppError::BadRequest(format!("métadonnées invalides: {e}")))?;
        store.create(&key, &updated)?;
        Ok::<_, AppError>(meta)
    })
    .await
    .map_err(|e| AppError::Crdt(e.to_string()))??;

    tracing::info!(doc_id = %doc_id, user = %identity.user_id, "document renommé");
    Ok(Json(json!({
        "doc_id": meta.doc_id,
        "kind": meta.kind,
        "title": meta.title,
        "owner": meta.owner_id,
        "created_at": meta.created_at,
    })))
}

/// `GET /api/v1/documents/{doc_id}/restore-points`
///
/// Les états conservés à chaque compaction. Ils existent parce qu'une suppression
/// massive, propagée par un client, devient définitive une fois le journal
/// tronqué : sans ces points, seul un rejeu manuel du journal permettait de
/// revenir en arrière — et seulement tant qu'il n'avait pas été compacté.
pub async fn list_restore_points(
    State(state): State<AppState>,
    Path(doc_id): Path<Uuid>,
    headers: HeaderMap,
) -> AppResult<impl IntoResponse> {
    identity_from_headers(&headers, state.cfg.auth_mode)?;

    let store = state.store.clone();
    let key = doc_id.to_string();
    let points = tokio::task::spawn_blocking(move || store.list_restore_points(&key))
        .await
        .map_err(|e| AppError::Crdt(e.to_string()))??;

    Ok(Json(json!({ "restore_points": points })))
}

#[derive(Debug, Deserialize)]
pub struct RestoreRequest {
    pub restore_point: String,
    #[serde(default)]
    pub title: Option<String>,
}

/// `POST /api/v1/documents/{doc_id}/restore`
///
/// Recrée le contenu d'un point de restauration dans un **nouveau document**.
///
/// Pourquoi un nouveau document : dans un CRDT, une suppression est une pierre
/// tombale définitive. Réinjecter l'ancien état dans le même document ne
/// ressusciterait rien — et le premier client encore connecté avec l'état
/// supprimé le rediffuserait aussitôt. Un document neuf n'a pas ce passé.
pub async fn restore_document(
    State(state): State<AppState>,
    Path(doc_id): Path<Uuid>,
    headers: HeaderMap,
    Json(body): Json<RestoreRequest>,
) -> AppResult<impl IntoResponse> {
    let identity = identity_from_headers(&headers, state.cfg.auth_mode)?;
    if !identity.scope.can_write() {
        return Err(AppError::Forbidden);
    }

    let store = state.store.clone();
    let source = doc_id.to_string();
    let point = body.restore_point.clone();
    let etat = tokio::task::spawn_blocking(move || store.read_restore_point(&source, &point))
        .await
        .map_err(|e| AppError::Crdt(e.to_string()))??;

    let nouveau = Uuid::now_v7();
    let titre = body
        .title
        .unwrap_or_else(|| format!("Restauration du {}", body.restore_point));

    let meta = DocumentMeta {
        doc_id: nouveau,
        kind: "write".into(),
        title: titre,
        owner_id: identity.user_id.clone(),
        created_at: Utc::now().to_rfc3339(),
    };
    let meta_json = serde_json::to_string(&meta)
        .map_err(|e| AppError::BadRequest(format!("métadonnées invalides: {e}")))?;

    let store = state.store.clone();
    let cible = nouveau.to_string();
    let etat_copie = etat.clone();
    tokio::task::spawn_blocking(move || {
        store.create(&cible, &meta_json)?;
        store.write_snapshot(&cible, &etat_copie)
    })
    .await
    .map_err(|e| AppError::Crdt(e.to_string()))??;

    tracing::info!(source = %doc_id, cible = %nouveau, point = %body.restore_point, "document restauré");

    Ok((
        StatusCode::CREATED,
        Json(json!({
            "doc_id": meta.doc_id,
            "title": meta.title,
            "restored_from": { "doc_id": doc_id, "restore_point": body.restore_point },
            "sync_path": format!("/api/v1/sync/{nouveau}"),
        })),
    ))
}

/// `GET /api/v1/documents/{doc_id}/snapshot` — état CRDT compacté (chargement rapide).
pub async fn get_snapshot(
    State(state): State<AppState>,
    Path(doc_id): Path<Uuid>,
    headers: HeaderMap,
) -> AppResult<impl IntoResponse> {
    identity_from_headers(&headers, state.cfg.auth_mode)?;
    let handle = state.load_doc(doc_id)?;
    let state_bytes = handle.full_state();

    Ok((
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/octet-stream")],
        state_bytes,
    ))
}

pub async fn healthz() -> impl IntoResponse {
    Json(json!({ "status": "ok" }))
}

pub async fn readyz(State(state): State<AppState>) -> impl IntoResponse {
    // Le stockage est la seule dépendance dure de cette étape.
    match state.store.list() {
        Ok(_) => (
            StatusCode::OK,
            Json(json!({ "status": "ready", "documents_loaded": state.loaded_count() })),
        ),
        Err(e) => {
            tracing::error!(error = %e, "stockage non prêt");
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({ "status": "unavailable" })),
            )
        }
    }
}

/// Base64 standard sans dépendance externe (usage : exposer un vecteur d'état court).
fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { TABLE[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[n as usize & 63] as char } else { '=' });
    }
    out
}

#[cfg(test)]
mod tests {
    #[test]
    fn base64_matches_reference_vectors() {
        assert_eq!(super::base64(b""), "");
        assert_eq!(super::base64(b"f"), "Zg==");
        assert_eq!(super::base64(b"fo"), "Zm8=");
        assert_eq!(super::base64(b"foo"), "Zm9v");
        assert_eq!(super::base64(b"foobar"), "Zm9vYmFy");
    }
}
