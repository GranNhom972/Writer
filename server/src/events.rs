// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors

//! Live feed of a share: `/api/v1/sessions/{token_session}/events`.
//!
//! The sync WebSocket is for **editing**: it requires tracking revisions and
//! applying operations in order. A script that only wants to know "how is the
//! document doing?" should not have to reimplement that.
//!
//! This feed is therefore the opposite: **read-only**, one frame per batch of
//! durable saves, with the complete document inside. It adds no power (you must be
//! a participant of the share, as for synchronization) and accepts nothing in
//! write direction.

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

/// Aggregation window: without it, a burst of typing would drown the reader.
const COALESCE: Duration = Duration::from_millis(250);
/// Regular keep-alive frame when there is no traffic: it proves the link is still
/// up and stops intermediaries from cutting a connection they consider idle.
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

    // Observing is reading: the same membership is required as for editing.
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

    // Send the current state first: an observer who connects midway must see the
    // document, not only the changes still to come.
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
                // Only modifications count: presence is ephemeral and never logged, so
                // announcing it as a "save" would be false.
                Ok(Fanout { durable: true, .. }) => en_attente += 1,
                Ok(_) => {}
                Err(RecvError::Lagged(_)) => {
                    // Frames were dropped: the document projection stays correct, only the
                    // count is approximate.
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
                // Read-only feed: anything the client sends is ignored, without closing the
                // connection, because a client may legitimately send a ping.
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
        // True by construction: a frame is only re-broadcast after it has been written to
        // the log (`sync.rs`), so everything that reaches this point is already durable.
        "durable": true,
        "revision": revision,
        "operations": operations,
        "active_clients": handle.active_clients(),
        "at": Utc::now().to_rfc3339(),
        "document": document,
    })
}
