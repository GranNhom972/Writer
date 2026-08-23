//! Flux d'observation d'une session — `/api/v1/sessions/{token_session}/events`.
//!
//! Le WebSocket de synchronisation (`/api/v1/sync/…`) parle le protocole binaire
//! de Yjs : c'est le bon choix pour un éditeur, et un mur pour tout le reste. Un
//! script qui veut seulement **suivre les sauvegardes** devrait sinon réimplémenter
//! un CRDT pour lire trois paragraphes.
//!
//! Ce flux est donc l'inverse : **trames texte JSON, en lecture seule**. Il n'ajoute
//! aucun pouvoir — il faut être participant de la session, comme pour la synchronisation
//! — et n'accepte rien en écriture.
//!
//! Une trame par sauvegarde durable, agrégées sur `COALESCE` pour qu'une frappe
//! rapide ne produise pas un événement par caractère.

use std::sync::Arc;
use std::time::Duration;

use axum::{
    extract::{
        ws::{Message as WsMessage, WebSocket, WebSocketUpgrade},
        Path, State,
    },
    http::HeaderMap,
    response::Response,
};
use chrono::Utc;
use futures::{sink::SinkExt, stream::StreamExt};
use serde_json::json;
use tokio::sync::broadcast::error::RecvError;

use crate::auth::{identity_from_headers, origin_allowed};
use crate::content;
use crate::doc::{DocHandle, Fanout};
use crate::error::{AppError, AppResult};
use crate::protocol::Message;
use crate::session::SessionRecord;
use crate::state::AppState;

/// Fenêtre d'agrégation : au-delà, un flux de frappe noierait le lecteur.
const COALESCE: Duration = Duration::from_millis(250);
/// Sans trafic, une trame de vie régulière : elle prouve que le lien tient et
/// empêche les intermédiaires de couper une connexion jugée inactive.
const HEARTBEAT: Duration = Duration::from_secs(20);

pub async fn events_handler(
    ws: WebSocketUpgrade,
    Path(token_session): Path<String>,
    State(state): State<AppState>,
    headers: HeaderMap,
) -> AppResult<Response> {
    if !origin_allowed(&headers, &state.cfg.allowed_origins) {
        return Err(AppError::Forbidden);
    }

    let record = state.session(&token_session)?;
    let identity = identity_from_headers(&headers, state.cfg.auth_mode)?;

    // Observer, c'est lire : la même appartenance est exigée que pour la synchronisation.
    if record.find_by_user(&identity.user_id).is_none() {
        return Err(AppError::Forbidden);
    }

    let handle = state.load_doc(record.doc_id)?;
    let selected = headers
        .get(axum::http::header::SEC_WEBSOCKET_PROTOCOL)
        .and_then(|value| value.to_str().ok())
        .and_then(|raw| {
            raw.split(',')
                .map(str::trim)
                .find(|p| p.starts_with("bearer."))
                .map(str::to_string)
        });

    let mut upgrade = ws;
    if let Some(proto) = selected {
        upgrade = upgrade.protocols([proto]);
    }

    let observer = identity.user_id;
    Ok(upgrade.on_upgrade(move |socket| stream(socket, handle, record, observer)))
}

async fn stream(
    socket: WebSocket,
    handle: Arc<DocHandle>,
    record: Arc<SessionRecord>,
    observer: String,
) {
    tracing::info!(
        token_session = %record.token_session,
        doc_id = %record.doc_id,
        user = %observer,
        "flux d'événements ouvert"
    );

    let (mut sender, mut receiver) = socket.split();
    let mut fanout = handle.tx.subscribe();

    // État courant d'abord : un observateur qui se branche en cours de route doit
    // voir le document, pas seulement les modifications à venir.
    let snapshot = event(&record, &handle, "snapshot", 0, 0);
    if sender.send(WsMessage::Text(snapshot.to_string())).await.is_err() {
        return;
    }

    let mut pending_updates = 0usize;
    let mut pending_bytes = 0usize;
    let mut coalesce = tokio::time::interval(COALESCE);
    let mut heartbeat = tokio::time::interval(HEARTBEAT);
    coalesce.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        tokio::select! {
            broadcast = fanout.recv() => match broadcast {
                Ok(Fanout { frame, .. }) => {
                    // Seules les updates comptent : la présence est éphémère et n'est
                    // jamais journalisée, l'annoncer comme « sauvegarde » serait faux.
                    if let Some(Message::Update(update)) | Some(Message::SyncStep2(update)) =
                        Message::decode(&frame)
                    {
                        pending_updates += 1;
                        pending_bytes += update.len();
                    }
                }
                Err(RecvError::Lagged(_)) => {
                    // Trames perdues : la projection reste juste, seul le compte est approché.
                    pending_updates += 1;
                }
                Err(RecvError::Closed) => break,
            },

            _ = coalesce.tick() => {
                if pending_updates > 0 {
                    let payload = event(&record, &handle, "save", pending_updates, pending_bytes);
                    pending_updates = 0;
                    pending_bytes = 0;
                    if sender.send(WsMessage::Text(payload.to_string())).await.is_err() {
                        break;
                    }
                    heartbeat.reset();
                }
            }

            _ = heartbeat.tick() => {
                let payload = json!({
                    "type": "heartbeat",
                    "token_session": record.token_session,
                    "active_clients": handle.active_clients(),
                    "at": Utc::now().to_rfc3339(),
                });
                if sender.send(WsMessage::Text(payload.to_string())).await.is_err() {
                    break;
                }
            }

            incoming = receiver.next() => match incoming {
                None | Some(Err(_)) | Some(Ok(WsMessage::Close(_))) => break,
                // Flux en lecture seule : tout ce qui remonte est ignoré, sans
                // fermer la connexion — un client peut légitimement envoyer un ping.
                Some(Ok(_)) => {}
            },
        }
    }

    tracing::info!(
        token_session = %record.token_session,
        user = %observer,
        "flux d'événements fermé"
    );
}

fn event(
    record: &SessionRecord,
    handle: &DocHandle,
    kind: &str,
    updates: usize,
    bytes: usize,
) -> serde_json::Value {
    let document = handle.read(content::project);
    json!({
        "type": kind,
        "token_session": record.token_session,
        "doc_id": record.doc_id,
        "title": document.title.clone().unwrap_or_else(|| record.title.clone()),
        // Vrai par construction : la trame n'est rediffusée qu'après écriture au
        // journal (`sync.rs`), donc tout ce qui arrive ici est déjà durable.
        "durable": true,
        "updates": updates,
        "bytes": bytes,
        "active_clients": handle.active_clients(),
        "at": Utc::now().to_rfc3339(),
        "document": document,
    })
}
