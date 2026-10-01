// SPDX-License-Identifier: Apache-2.0 AND GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors
//
// Derivative work of Apache OpenOffice 4.1.16 (© The Apache Software Foundation,
// Apache License 2.0), modified: ported to Rust. See the NOTICE and
// LICENSE-APACHE files.

//! CRDT synchronization WebSocket session: `/api/v1/sync/{doc_id}`.
//!
//! Taken over from the relay of the Write application. The protocol is
//! `y-protocols`: **binary** frames that the server validates, logs and
//! re-broadcasts without ever opening them.
//!
//! What happens to an incoming update, in this order and no other:
//!
//!   1. **validate**: enough scope, and the update can be decoded;
//!   2. **log**: written to disk with `fsync`;
//!   3. **re-broadcast** to the peers.
//!
//! Re-broadcasting before logging would risk a loss that the peers would already
//! have displayed.
//!
//! What has disappeared compared with the previous version: revision numbering,
//! catch-up by operation diff, and holding operations until they are acknowledged.
//! The CRDT makes all of that unnecessary: a peer that is behind announces its
//! state vector, and the server answers with the exact difference, however long
//! the peer was away.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::{
    extract::{
        ws::{Message as WsMessage, WebSocket, WebSocketUpgrade},
        Path, State,
    },
    http::HeaderMap,
    response::Response,
};
use futures::{sink::SinkExt, stream::StreamExt};
use tokio::sync::broadcast::error::RecvError;
use uuid::Uuid;

use crate::auth::{identity_from_headers, origin_allowed, Identity};
use crate::awareness::{encode_removals, parse_awareness};
use crate::doc::{DocHandle, Fanout};
use crate::error::{AppError, AppResult};
use crate::protocol::Message;
use crate::state::{
    AppState, IDLE_TIMEOUT_SECS, MAX_CLIENTS_PER_DOCUMENT, MAX_FRAME_BYTES,
    MAX_MESSAGES_PER_SECOND, MESSAGE_BURST,
};
use crate::store::COMPACTION_THRESHOLD;

// Standard close codes, taken from the Write server.
const CLOSE_IDLE: u16 = 4408;
const CLOSE_TOO_LARGE: u16 = 4413;
const CLOSE_RATE_LIMITED: u16 = 4429;

pub async fn sync_handler(
    ws: WebSocketUpgrade,
    Path(doc_id): Path<Uuid>,
    State(state): State<AppState>,
    headers: HeaderMap,
) -> AppResult<Response> {
    // 1. Origin check (anti-CSWSH) before anything else: a hostile page must not be
    //    able to open a WebSocket with the user's credentials.
    if !origin_allowed(&headers, &state.cfg.allowed_origins) {
        return Err(AppError::Forbidden);
    }

    // 2. Identity comes from the token, never from the URL.
    let mut identity = identity_from_headers(&headers, &state.cfg.auth)?;
    identity.ensure_document(doc_id)?;

    // 3. Shared document: the participant list decides.
    //
    //    The scope requested by the token can only **narrow** the session's scope,
    //    never widen it: otherwise claiming `write` in your token would be enough to
    //    get it.
    if let Some(record) = state.session_for_doc(doc_id) {
        let Some(participant) = record.find_by_user(&identity.user_id) else {
            tracing::warn!(%doc_id, user = %identity.user_id, "accès refusé : hors du partage");
            return Err(AppError::Forbidden);
        };
        identity.scope = identity.scope.min(participant.scope());
    }

    // 4. The document must exist; otherwise 404, without revealing anything more.
    let handle = state.load_doc(doc_id)?;
    if handle.active_clients() >= MAX_CLIENTS_PER_DOCUMENT {
        return Err(AppError::Forbidden);
    }

    // The browser requires the server to select one of the sub-protocols it offered.
    let selected = offered_bearer_protocol(&headers);
    let mut upgrade = ws
        .max_frame_size(MAX_FRAME_BYTES)
        .max_message_size(MAX_FRAME_BYTES);
    if let Some(proto) = selected {
        upgrade = upgrade.protocols([proto]);
    }

    Ok(upgrade.on_upgrade(move |socket| session(socket, state, handle, identity, doc_id)))
}

fn offered_bearer_protocol(headers: &HeaderMap) -> Option<String> {
    let raw = headers
        .get(axum::http::header::SEC_WEBSOCKET_PROTOCOL)?
        .to_str()
        .ok()?;
    raw.split(',')
        .map(str::trim)
        .find(|p| p.starts_with("bearer."))
        .map(str::to_string)
}

struct RateLimiter {
    tokens: f64,
    last: Instant,
}

impl RateLimiter {
    fn new() -> Self {
        Self {
            tokens: MESSAGE_BURST as f64,
            last: Instant::now(),
        }
    }

    /// Token bucket: `MAX_MESSAGES_PER_SECOND` in steady state, `MESSAGE_BURST` at
    /// peak. A Yjs update weighs a few dozen bytes and is sent on every keystroke, so
    /// the burst has to be wide.
    fn allow(&mut self) -> bool {
        let now = Instant::now();
        self.tokens = (self.tokens
            + now.duration_since(self.last).as_secs_f64() * MAX_MESSAGES_PER_SECOND as f64)
            .min(MESSAGE_BURST as f64);
        self.last = now;
        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            true
        } else {
            false
        }
    }
}

async fn session(
    socket: WebSocket,
    state: AppState,
    handle: Arc<DocHandle>,
    identity: Identity,
    doc_id: Uuid,
) {
    let connection_id = state.next_connection_id();
    let clients = handle.client_joined();
    tracing::info!(
        %doc_id, connection_id,
        user = %identity.user_id,
        name = %identity.display_name,
        scope = identity.scope.as_str(),
        clients,
        "session de synchronisation ouverte"
    );

    let (mut sender, mut receiver) = socket.split();
    let mut fanout = handle.tx.subscribe();
    let mut limiter = RateLimiter::new();

    // Presences announced by this connection: to be removed when it closes,
    // otherwise the other participants keep a ghost in their list.
    let mut presences: HashMap<u64, u64> = HashMap::new();
    let mut write_refused = false;

    // SyncStep1: the server announces its state vector as soon as the connection
    // opens. The client works out what it is missing, and vice versa.
    let hello = Message::SyncStep1(handle.state_vector()).encode();
    if sender.send(WsMessage::Binary(hello)).await.is_err() {
        handle.client_left();
        return;
    }

    // Who is already here. Presence only travels when it changes: without this
    // reminder, the newcomer would see an empty participant list until each person
    // announced themselves again.
    if !greet(&mut sender, &handle, connection_id).await {
        handle.client_left();
        return;
    }

    let idle = Duration::from_secs(IDLE_TIMEOUT_SECS);
    let close_code = loop {
        tokio::select! {
            incoming = tokio::time::timeout(idle, receiver.next()) => {
                let frame = match incoming {
                    Err(_) => break Some(CLOSE_IDLE),
                    Ok(None) => break None,          // peer disconnected
                    Ok(Some(Err(_))) => break None,  // transport broken
                    Ok(Some(Ok(frame))) => frame,
                };

                if !limiter.allow() {
                    tracing::warn!(%doc_id, user = %identity.user_id, "quota de messages dépassé");
                    break Some(CLOSE_RATE_LIMITED);
                }

                let bytes = match frame {
                    WsMessage::Binary(b) => b,
                    WsMessage::Close(_) => break None,
                    WsMessage::Ping(_) | WsMessage::Pong(_) => continue,
                    // The protocol is binary: a text frame is outside the contract.
                    WsMessage::Text(_) => continue,
                };

                if bytes.len() > MAX_FRAME_BYTES {
                    break Some(CLOSE_TOO_LARGE);
                }

                let reponses = handle_frame(
                    &state,
                    &handle,
                    &identity,
                    connection_id,
                    doc_id,
                    &bytes,
                    &mut presences,
                    &mut write_refused,
                )
                .await;

                let mut rompu = false;
                for reponse in reponses {
                    if sender.send(WsMessage::Binary(reponse)).await.is_err() {
                        rompu = true;
                        break;
                    }
                }
                if rompu { break None; }
            }

            broadcast = fanout.recv() => {
                match broadcast {
                    Ok(Fanout { origin, frame, .. }) if origin != connection_id => {
                        if sender.send(WsMessage::Binary(frame.as_ref().clone())).await.is_err() {
                            break None;
                        }
                    }
                    Ok(_) => {}
                    Err(RecvError::Lagged(skipped)) => {
                        // Client too slow: it has lost frames. The CRDT lets us bring it back up to date
                        // with a simple SyncStep1, which is exactly what the old sequencer could not do,
                        // since it could not know what had been missed.
                        tracing::warn!(%doc_id, connection_id, skipped, "client en retard, resynchronisation");
                        let resync = Message::SyncStep1(handle.state_vector()).encode();
                        if sender.send(WsMessage::Binary(resync)).await.is_err() {
                            break None;
                        }
                    }
                    Err(RecvError::Closed) => break None,
                }
            }
        }
    };

    if let Some(code) = close_code {
        let _ = sender
            .send(WsMessage::Close(Some(axum::extract::ws::CloseFrame {
                code,
                reason: "".into(),
            })))
            .await;
    }

    // Announce the departure: the peers immediately remove this participant's cursors
    // and avatar, without waiting for the client-side expiry.
    handle.forget_presence(connection_id);
    if !presences.is_empty() {
        let entries: Vec<(u64, u64)> = presences.into_iter().collect();
        let frame = Message::Awareness(encode_removals(&entries)).encode();
        let _ = handle.tx.send(Fanout {
            origin: connection_id,
            frame: Arc::new(frame),
            durable: false,
        });
    }

    let remaining = handle.client_left();
    tracing::info!(%doc_id, connection_id, remaining, "session fermée");

    // Last one out: the document is saved with its owner, then erased from here.
    // Nothing is done right away, because a page reload goes through this path, and
    // `schedule_close` waits to see whether someone comes back before concluding.
    if remaining == 0 {
        crate::hook::schedule_close(state.clone(), handle.clone(), doc_id);
    }
    // No "flush on disconnect": durability is already guaranteed up to the last
    // update, which is the whole point of logging before re-broadcasting.
}

/// Serves the newcomer the presences already announced. Returns `false` if the
/// link breaks.
async fn greet(
    sender: &mut futures::stream::SplitSink<WebSocket, WsMessage>,
    handle: &Arc<DocHandle>,
    connection_id: u64,
) -> bool {
    for payload in handle.known_presences(connection_id) {
        let frame = Message::Awareness(payload.as_ref().clone()).encode();
        if sender.send(WsMessage::Binary(frame)).await.is_err() {
            return false;
        }
    }
    true
}

/// Handles one frame and returns what must be sent back to the **sender**.
/// What has to go to the others goes through `handle.tx`.
#[allow(clippy::too_many_arguments)]
async fn handle_frame(
    state: &AppState,
    handle: &Arc<DocHandle>,
    identity: &Identity,
    connection_id: u64,
    doc_id: Uuid,
    bytes: &[u8],
    presences: &mut HashMap<u64, u64>,
    // Logged only once per session: a reader sends its state on every
    // synchronization, which would flood the logs.
    write_refused: &mut bool,
) -> Vec<Vec<u8>> {
    let Some(message) = Message::decode(bytes) else {
        // Unreadable frame or unsupported type: ignored, session kept. Closing it would
        // trigger a reconnection loop for a client of which only one frame is at fault.
        return Vec::new();
    };

    match message {
        Message::SyncStep1(client_sv) => match handle.diff(&client_sv) {
            Ok(diff) => vec![Message::SyncStep2(diff).encode()],
            Err(e) => {
                tracing::warn!(%doc_id, error = %e, "vecteur d'état client illisible");
                Vec::new()
            }
        },

        Message::SyncStep2(update) | Message::Update(update) => {
            // Insufficient scope: the modification is **ignored**, not the session. Closing
            // the connection would be a mistake: the sync protocol requires the client to send
            // its state when it opens (SyncStep2), even in read-only mode. Closing it would
            // create a loop: the client reconnects, sends its state again, gets closed,
            // forever.
            if !identity.scope.can_write() {
                if !*write_refused {
                    *write_refused = true;
                    tracing::info!(%doc_id, user = %identity.user_id, "modifications ignorées (portée lecture)");
                }
                return Vec::new();
            }

            if let Err(e) = handle.apply_update(&update) {
                tracing::warn!(%doc_id, error = %e, "update CRDT rejetée");
                return Vec::new();
            }

            persist_and_compact(state, handle, doc_id, &update, &identity.user_id).await;

            let frame = Message::Update(update).encode();
            let _ = handle.tx.send(Fanout {
                origin: connection_id,
                frame: Arc::new(frame),
                durable: true,
            });
            Vec::new()
        }

        // The client asks who is here. We serve it the registry rather than make it wait
        // for each person's next spontaneous announcement.
        Message::QueryAwareness => handle
            .known_presences(connection_id)
            .into_iter()
            .map(|payload| Message::Awareness(payload.as_ref().clone()).encode())
            .collect(),

        // Presence: relayed as-is, never logged (ephemeral data). We note which
        // participants come through this connection, so we can remove them when it
        // closes.
        Message::Awareness(payload) => {
            if let Some(entries) = parse_awareness(&payload) {
                for entry in entries {
                    if entry.present {
                        presences.insert(entry.client_id, entry.clock);
                    } else {
                        presences.remove(&entry.client_id);
                    }
                }
            }

            // Remembered before being re-broadcast: the same payload will be used as the
            // welcome for the next newcomer.
            handle.note_presence(connection_id, Arc::new(payload.clone()));

            let frame = Message::Awareness(payload).encode();
            let _ = handle.tx.send(Fanout {
                origin: connection_id,
                frame: Arc::new(frame),
                durable: false,
            });
            Vec::new()
        }
    }
}

async fn persist_and_compact(
    state: &AppState,
    handle: &Arc<DocHandle>,
    doc_id: Uuid,
    update: &[u8],
    author: &str,
) {
    let store = state.store.clone();
    let key = doc_id.to_string();
    let payload = update.to_vec();

    match tokio::task::spawn_blocking(move || store.append_update(&key, &payload)).await {
        Ok(Ok(())) => {}
        Ok(Err(e)) => tracing::error!(%doc_id, author, error = %e, "échec de journalisation"),
        Err(e) => {
            tracing::error!(%doc_id, author, error = %e, "tâche de journalisation interrompue")
        }
    }

    if handle.note_update() >= COMPACTION_THRESHOLD {
        handle.reset_update_counter();
        let store = state.store.clone();
        let key = doc_id.to_string();
        let snapshot = handle.full_state();
        // Compaction runs as a background task: it rewrites the whole document, and doing
        // it inline would block everyone's typing for the duration of an `fsync` of
        // several megabytes.
        tokio::spawn(async move {
            let resultat =
                tokio::task::spawn_blocking(move || store.write_snapshot(&key, &snapshot)).await;
            match resultat {
                Ok(Ok(())) => tracing::info!(%doc_id, "instantané écrit, journal compacté"),
                Ok(Err(e)) => tracing::error!(%doc_id, error = %e, "échec de l'instantané"),
                Err(e) => tracing::error!(%doc_id, error = %e, "tâche d'instantané interrompue"),
            }
        });
    }

    // The log and the snapshot above protect against a restart of *Writer*: they put
    // nothing in the Drive. It is the periodic hand-over that gives the useful part to
    // CloudServ, the only owner of the document, and it is what bounds what a failure
    // costs the user.
    crate::hook::schedule_checkpoint(state.clone(), handle.clone(), doc_id);
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::{header, HeaderValue};

    #[test]
    fn le_sous_protocole_porteur_est_extrait() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::SEC_WEBSOCKET_PROTOCOL,
            HeaderValue::from_static("bearer.dev.alice.write"),
        );
        assert_eq!(
            offered_bearer_protocol(&headers).as_deref(),
            Some("bearer.dev.alice.write")
        );
    }

    #[test]
    fn sans_sous_protocole_rien_nest_selectionne() {
        assert!(offered_bearer_protocol(&HeaderMap::new()).is_none());
    }

    #[test]
    fn le_seau_a_jetons_autorise_la_rafale_puis_freine() {
        let mut limiter = RateLimiter::new();
        for _ in 0..MESSAGE_BURST {
            assert!(limiter.allow());
        }
        assert!(!limiter.allow(), "au-delà de la rafale, le seau est vide");
    }
}
