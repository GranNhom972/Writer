//! Routes REST v1.

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    Json,
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::auth::identity_from_headers;
use crate::content;
use crate::doc::DocHandle;
use crate::error::{joined, AppError, AppResult};
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
    /// Contenu initial : un `WriterDocumentState` complet, ou rien.
    #[serde(default)]
    pub document: Option<Value>,
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
    let identity = identity_from_headers(&headers, &state.cfg.auth)?;
    if !identity.scope.can_write() {
        return Err(AppError::Forbidden);
    }
    // Un billet délivré pour ouvrir *un* document ne DOIT pas servir à en créer
    // d'autres : ce serait écrire dans le stockage d'un service qui n'en saurait
    // rien, et donc ne le purgerait jamais.
    if identity.doc_binding.is_some() {
        return Err(AppError::Forbidden);
    }

    let (title, contenu) = match body {
        Some(Json(b)) => (b.title, b.document),
        None => (None, None),
    };
    let title = title.unwrap_or_else(|| "Document sans titre".to_string());
    if title.chars().count() > MAX_TITLE_LEN {
        return Err(AppError::BadRequest("titre trop long".into()));
    }

    // Le contenu initial est validé **avant** toute écriture : un document
    // refusé ne doit pas laisser de répertoire derrière lui.
    let contenu = contenu.unwrap_or_else(|| json!({ "blocks": [] }));
    let amorce = content::seed_update(&contenu)?;

    // L'identifiant est généré par le SERVEUR (UUIDv7) : un client ne choisit
    // jamais l'identifiant d'une ressource.
    let doc_id = Uuid::now_v7();
    let meta = DocumentMeta {
        doc_id,
        kind: "writer".into(),
        title,
        owner_id: identity.user_id.clone(),
        created_at: Utc::now().to_rfc3339(),
    };

    let meta_json = serde_json::to_string(&meta)
        .map_err(|e| AppError::Internal(format!("métadonnées non sérialisables: {e}")))?;
    let store = state.store.clone();
    let key = doc_id.to_string();
    let a_ecrire = amorce.clone();
    joined(
        tokio::task::spawn_blocking(move || {
            store.create(&key, &meta_json)?;
            // L'amorce est écrite comme instantané : elle est durable avant que
            // le premier client ne se connecte.
            store.write_snapshot(&key, &a_ecrire)
        })
        .await,
    )??;

    let handle = std::sync::Arc::new(DocHandle::new(doc_id));
    handle.apply_update(&amorce)?;
    state.insert_doc(handle);
    tracing::info!(%doc_id, owner = %identity.user_id, "document créé");

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
    // L'inventaire est réservé aux jetons d'usage général : un billet lié à un
    // document ne doit pas révéler l'existence de tous les autres.
    let identity = identity_from_headers(&headers, &state.cfg.auth)?;
    if identity.doc_binding.is_some() {
        return Err(AppError::Forbidden);
    }

    let store = state.store.clone();
    let metas = joined(
        tokio::task::spawn_blocking(move || {
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
        .await,
    )??;

    Ok(Json(json!({ "documents": metas })))
}

/// `GET /api/v1/documents/{doc_id}`
pub async fn get_document(
    State(state): State<AppState>,
    Path(doc_id): Path<Uuid>,
    headers: HeaderMap,
) -> AppResult<impl IntoResponse> {
    let identity = identity_from_headers(&headers, &state.cfg.auth)?;
    identity.ensure_document(doc_id)?;

    // Document partagé : la liste des participants fait foi, ici comme sur le
    // WebSocket. Sans ce contrôle, connaître un `doc_id` suffirait à lire un
    // document dont on a été exclu.
    if let Some(record) = state.session_for_doc(doc_id) {
        if record.find_by_user(&identity.user_id).is_none() {
            return Err(AppError::Forbidden);
        }
    }

    let store = state.store.clone();
    let key = doc_id.to_string();
    let raw = joined(tokio::task::spawn_blocking(move || store.read_meta(&key)).await)??;
    let meta: DocumentMeta = serde_json::from_str(&raw)
        .map_err(|e| AppError::Internal(format!("métadonnées corrompues: {e}")))?;

    let handle = state.load_doc(doc_id)?;

    Ok(Json(json!({
        "doc_id": meta.doc_id,
        "kind": meta.kind,
        "title": handle.title().unwrap_or(meta.title),
        "owner": meta.owner_id,
        "created_at": meta.created_at,
        "revision": handle.revision(),
        "blocks": handle.block_count(),
        "active_clients": handle.active_clients(),
    })))
}

/// `PATCH /api/v1/documents/{doc_id}` — renomme un document.
///
/// Le titre vit d'abord dans le document répliqué (`set-meta`, visible chez tous
/// immédiatement) ; cette route le rend durable pour la liste des documents, où
/// il est lu sans ouvrir le contenu.
pub async fn rename_document(
    State(state): State<AppState>,
    Path(doc_id): Path<Uuid>,
    headers: HeaderMap,
    Json(body): Json<RenameDocumentRequest>,
) -> AppResult<impl IntoResponse> {
    let identity = identity_from_headers(&headers, &state.cfg.auth)?;
    identity.ensure_document(doc_id)?;
    if !identity.scope.can_write() {
        return Err(AppError::Forbidden);
    }
    if let Some(record) = state.session_for_doc(doc_id) {
        match record.find_by_user(&identity.user_id) {
            Some(participant) if participant.scope().can_write() => {}
            _ => return Err(AppError::Forbidden),
        }
    }

    let title = body.title.trim().to_string();
    if title.is_empty() || title.chars().count() > MAX_TITLE_LEN {
        return Err(AppError::BadRequest("titre vide ou trop long".into()));
    }

    let store = state.store.clone();
    let key = doc_id.to_string();
    let meta = joined(
        tokio::task::spawn_blocking(move || {
            let raw = store.read_meta(&key)?;
            let mut meta: DocumentMeta = serde_json::from_str(&raw)
                .map_err(|e| AppError::Internal(format!("métadonnées corrompues: {e}")))?;
            meta.title = title;
            let updated = serde_json::to_string(&meta)
                .map_err(|e| AppError::Internal(format!("métadonnées non sérialisables: {e}")))?;
            store.create(&key, &updated)?;
            Ok::<_, AppError>(meta)
        })
        .await,
    )??;

    tracing::info!(%doc_id, user = %identity.user_id, "document renommé");
    Ok(Json(json!({
        "doc_id": meta.doc_id,
        "kind": meta.kind,
        "title": meta.title,
        "owner": meta.owner_id,
        "created_at": meta.created_at,
    })))
}

/// `DELETE /api/v1/documents/{doc_id}` — efface le document et ses données.
///
/// C'est la contrepartie de la règle « Writer ne conserve rien » : une fois le
/// document sauvegardé chez celui à qui il appartient, plus rien ne doit en
/// rester ici. La route existe pour que **CloudServ** puisse l'exiger lui-même,
/// sans dépendre du rappel automatique de fin de session (`hook.rs`) — lequel
/// peut avoir échoué, ou n'avoir jamais eu lieu si le serveur a redémarré.
///
/// Deux garde-fous :
///
///  - la portée `write` est exigée, et un billet lié n'efface que **son**
///    document (`ensure_document`, posé plus bas comme sur les autres routes) ;
///  - un document encore ouvert n'est pas effacé. Purger sous les pieds de
///    quelqu'un qui écrit lui ferait perdre ce qu'il vient de taper, et le
///    rappel de fin de session repassera de toute façon.
pub async fn delete_document(
    State(state): State<AppState>,
    Path(doc_id): Path<Uuid>,
    headers: HeaderMap,
) -> AppResult<impl IntoResponse> {
    let identity = identity_from_headers(&headers, &state.cfg.auth)?;
    identity.ensure_document(doc_id)?;
    if !identity.scope.can_write() {
        return Err(AppError::Forbidden);
    }
    if let Some(record) = state.session_for_doc(doc_id) {
        match record.find_by_user(&identity.user_id) {
            Some(participant) if participant.scope().can_write() => {}
            _ => return Err(AppError::Forbidden),
        }
    }

    let store = state.store.clone();
    let key = doc_id.to_string();
    if !joined(tokio::task::spawn_blocking(move || store.exists(&key)).await)? {
        return Err(AppError::NotFound);
    }

    if let Some(handle) = state.doc_if_loaded(doc_id) {
        let actifs = handle.active_clients();
        if actifs > 0 {
            return Err(AppError::Conflict(format!(
                "{actifs} participant(s) encore connecté(s)"
            )));
        }
    }

    crate::hook::purge(&state, doc_id).await;
    tracing::info!(%doc_id, user = %identity.user_id, "document purgé sur demande");

    Ok(StatusCode::NO_CONTENT)
}

/// `GET /api/v1/documents/{doc_id}/snapshot` — l'état complet, en JSON.
///
/// C'est ce que charge un client à l'ouverture, avant même d'établir le
/// WebSocket : le document s'affiche sans attendre la poignée de main.
pub async fn get_snapshot(
    State(state): State<AppState>,
    Path(doc_id): Path<Uuid>,
    headers: HeaderMap,
) -> AppResult<impl IntoResponse> {
    let identity = identity_from_headers(&headers, &state.cfg.auth)?;
    identity.ensure_document(doc_id)?;
    if let Some(record) = state.session_for_doc(doc_id) {
        if record.find_by_user(&identity.user_id).is_none() {
            return Err(AppError::Forbidden);
        }
    }

    let handle = state.load_doc(doc_id)?;
    let (revision, document) = handle.snapshot();

    Ok(Json(json!({
        "doc_id": doc_id,
        "revision": revision,
        "document": document,
    })))
}

/// `GET /api/v1/documents/{doc_id}/restore-points`
///
/// Les états conservés à chaque compaction. Ils existent parce qu'une
/// suppression massive, propagée par un client, devient définitive une fois le
/// journal tronqué : sans ces points, seul un rejeu manuel permettrait de
/// revenir en arrière — et seulement avant compaction.
pub async fn list_restore_points(
    State(state): State<AppState>,
    Path(doc_id): Path<Uuid>,
    headers: HeaderMap,
) -> AppResult<impl IntoResponse> {
    let identity = identity_from_headers(&headers, &state.cfg.auth)?;
    identity.ensure_document(doc_id)?;
    if let Some(record) = state.session_for_doc(doc_id) {
        if record.find_by_user(&identity.user_id).is_none() {
            return Err(AppError::Forbidden);
        }
    }

    let store = state.store.clone();
    let key = doc_id.to_string();
    let points = joined(tokio::task::spawn_blocking(move || store.list_restore_points(&key)).await)??;

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
/// Pourquoi un nouveau : réinjecter l'ancien état dans le document courant le
/// ferait aussitôt écraser par le premier client encore connecté, dont la vue
/// porte l'état supprimé et qui la rediffuserait à la première frappe. Un
/// document neuf n'a pas ce passé.
pub async fn restore_document(
    State(state): State<AppState>,
    Path(doc_id): Path<Uuid>,
    headers: HeaderMap,
    Json(body): Json<RestoreRequest>,
) -> AppResult<impl IntoResponse> {
    let identity = identity_from_headers(&headers, &state.cfg.auth)?;
    identity.ensure_document(doc_id)?;
    if !identity.scope.can_write() {
        return Err(AppError::Forbidden);
    }
    if let Some(record) = state.session_for_doc(doc_id) {
        match record.find_by_user(&identity.user_id) {
            Some(participant) if participant.scope().can_write() => {}
            _ => return Err(AppError::Forbidden),
        }
    }

    let store = state.store.clone();
    let source = doc_id.to_string();
    let point = body.restore_point.clone();
    let etat =
        joined(tokio::task::spawn_blocking(move || store.read_restore_point(&source, &point)).await)??;

    let nouveau = Uuid::now_v7();
    let titre = body
        .title
        .unwrap_or_else(|| format!("Restauration du {}", body.restore_point));

    let meta = DocumentMeta {
        doc_id: nouveau,
        kind: "writer".into(),
        title: titre,
        owner_id: identity.user_id.clone(),
        created_at: Utc::now().to_rfc3339(),
    };
    let meta_json = serde_json::to_string(&meta)
        .map_err(|e| AppError::Internal(format!("métadonnées non sérialisables: {e}")))?;

    let store = state.store.clone();
    let cible = nouveau.to_string();
    joined(
        tokio::task::spawn_blocking(move || {
            store.create(&cible, &meta_json)?;
            // Le point de restauration **est** un état CRDT complet : il devient
            // l'instantané du nouveau document tel quel.
            store.write_snapshot(&cible, &etat)
        })
        .await,
    )??;

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

pub async fn healthz() -> impl IntoResponse {
    Json(json!({ "status": "ok" }))
}

pub async fn readyz(State(state): State<AppState>) -> impl IntoResponse {
    // Le stockage est la seule dépendance dure : s'il répond, le serveur peut
    // accepter du trafic.
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
