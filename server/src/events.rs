//! Flux d'observation d'un partage — `/api/v1/sessions/{token_session}/events`.
//!
//! Le WebSocket de synchronisation sert à **éditer** : il exige de suivre les
//! révisions et d'appliquer les opérations dans l'ordre. Un script qui veut
//! seulement savoir « où en est le document ? » n'a pas à réimplémenter cela.
//!
//! Ce flux est donc l'inverse : **lecture seule**, une trame par lot de
//! sauvegardes durables, avec le document complet dedans. Il n'ajoute aucun
//! pouvoir — il faut être participant du partage, comme pour la synchronisation
//! — et n'accepte rien en écriture.

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
use crate::doc::{DocHandle, Fanout};
use crate::error::{AppError, AppResult};
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
    let identity = identity_from_headers(&headers, &state.cfg.auth)?;

    // Observer, c'est lire : la même appartenance est exigée que pour l'édition.
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
    let ouverture = event(&record, &handle, "snapshot", 0);
    if sender
        .send(WsMessage::Text(ouverture.to_string()))
        .await
        .is_err()
    {
        return;
    }

    let mut en_attente = 0usize;
    let mut coalesce = tokio::time::interval(COALESCE);
    let mut heartbeat = tokio::time::interval(HEARTBEAT);
    coalesce.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        tokio::select! {
            broadcast = fanout.recv() => match broadcast {
                // Seules les modifications comptent : la présence est éphémère et
                // n'est jamais journalisée, l'annoncer comme « sauvegarde » serait faux.
                Ok(Fanout { durable: true, .. }) => en_attente += 1,
                Ok(_) => {}
                Err(RecvError::Lagged(_)) => {
                    // Trames perdues : la projection du document reste juste,
                    // seul le compte est approché.
                    en_attente += 1;
                }
                Err(RecvError::Closed) => break,
            },

            _ = coalesce.tick() => {
                if en_attente > 0 {
                    let charge = event(&record, &handle, "save", en_attente);
                    en_attente = 0;
                    if sender.send(WsMessage::Text(charge.to_string())).await.is_err() {
                        break;
                    }
                    heartbeat.reset();
                }
            }

            _ = heartbeat.tick() => {
                let charge = json!({
                    "type": "heartbeat",
                    "token_session": record.token_session,
                    "revision": handle.revision(),
                    "active_clients": handle.active_clients(),
                    "at": Utc::now().to_rfc3339(),
                });
                if sender.send(WsMessage::Text(charge.to_string())).await.is_err() {
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
    operations: usize,
) -> serde_json::Value {
    let (revision, document) = handle.snapshot();
    json!({
        "type": kind,
        "token_session": record.token_session,
        "doc_id": record.doc_id,
        "title": handle.title().unwrap_or_else(|| record.title.clone()),
        // Vrai par construction : une trame n'est rediffusée qu'après écriture au
        // journal (`sync.rs`), donc tout ce qui arrive ici est déjà durable.
        "durable": true,
        "revision": revision,
        "operations": operations,
        "active_clients": handle.active_clients(),
        "at": Utc::now().to_rfc3339(),
        "document": document,
    })
}
