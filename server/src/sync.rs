//! Session WebSocket de synchronisation CRDT — `/api/v1/sync/{doc_id}`.
//!
//! Reprise du relais de l'application Write. Le protocole est celui de
//! `y-protocols` : des trames **binaires** que le serveur valide, journalise et
//! rediffuse sans jamais les ouvrir.
//!
//! Séquence d'une update entrante, dans cet ordre et pas un autre :
//!
//!   1. **valider** — portée suffisante, update décodable ;
//!   2. **journaliser** — écriture avec `fsync` ;
//!   3. **rediffuser** aux pairs.
//!
//! Rediffuser avant de journaliser exposerait à une perte que les pairs
//! auraient déjà affichée.
//!
//! Ce qui a disparu par rapport à la version précédente : la numérotation des
//! révisions, le rattrapage par différentiel d'opérations, la rétention des
//! opérations en attente d'accusé. Le CRDT rend tout cela inutile — un pair en
//! retard annonce son vecteur d'état, et le serveur lui répond par le
//! différentiel exact, quelle que soit la durée de son absence.

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
    AppState, IDLE_TIMEOUT_SECS, MAX_CLIENTS_PER_DOCUMENT, MAX_FRAME_BYTES, MAX_MESSAGES_PER_SECOND,
    MESSAGE_BURST,
};
use crate::store::COMPACTION_THRESHOLD;

// Codes de fermeture normalisés, repris du serveur Write.
const CLOSE_IDLE: u16 = 4408;
const CLOSE_TOO_LARGE: u16 = 4413;
const CLOSE_RATE_LIMITED: u16 = 4429;

pub async fn sync_handler(
    ws: WebSocketUpgrade,
    Path(doc_id): Path<Uuid>,
    State(state): State<AppState>,
    headers: HeaderMap,
) -> AppResult<Response> {
    // 1. Origine (anti-CSWSH) avant toute autre chose : une page hostile ne doit
    //    pas pouvoir ouvrir un WebSocket avec les identifiants de l'usager.
    if !origin_allowed(&headers, &state.cfg.allowed_origins) {
        return Err(AppError::Forbidden);
    }

    // 2. Identité issue du jeton, jamais de l'URL.
    let mut identity = identity_from_headers(&headers, &state.cfg.auth)?;
    identity.ensure_document(doc_id)?;

    // 3. Document partagé : la liste des participants fait foi.
    //
    //    La portée demandée par le jeton ne peut que **restreindre** celle de la
    //    session, jamais l'élargir : sans quoi il suffirait de réclamer `write`
    //    dans son jeton pour l'obtenir.
    if let Some(record) = state.session_for_doc(doc_id) {
        let Some(participant) = record.find_by_user(&identity.user_id) else {
            tracing::warn!(%doc_id, user = %identity.user_id, "accès refusé : hors du partage");
            return Err(AppError::Forbidden);
        };
        identity.scope = identity.scope.min(participant.scope());
    }

    // 4. Le document doit exister ; sinon 404, sans divulguer davantage.
    let handle = state.load_doc(doc_id)?;
    if handle.active_clients() >= MAX_CLIENTS_PER_DOCUMENT {
        return Err(AppError::Forbidden);
    }

    // Le navigateur exige que le serveur sélectionne l'un des sous-protocoles offerts.
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

    /// Seau à jetons : `MAX_MESSAGES_PER_SECOND` en régime établi,
    /// `MESSAGE_BURST` en pointe. Une update Yjs pèse quelques dizaines
    /// d'octets et part à chaque frappe : la rafale doit être large.
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

    // Présences annoncées par cette connexion : à retirer quand elle se ferme,
    // sinon les autres participants gardent un fantôme dans la liste.
    let mut presences: HashMap<u64, u64> = HashMap::new();
    let mut write_refused = false;

    // SyncStep1 : le serveur annonce son vecteur d'état dès l'ouverture. Le
    // client en déduit ce qu'il lui manque, et réciproquement.
    let hello = Message::SyncStep1(handle.state_vector()).encode();
    if sender.send(WsMessage::Binary(hello)).await.is_err() {
        handle.client_left();
        return;
    }

    // Qui est déjà là. La présence ne circule qu'au moment où elle change :
    // sans ce rappel, l'arrivant afficherait une liste de participants vide
    // jusqu'à la prochaine annonce de chacun.
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
                    Ok(None) => break None,          // pair déconnecté
                    Ok(Some(Err(_))) => break None,  // transport rompu
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
                    // Le protocole est binaire : une trame texte est hors contrat.
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
                        // Client trop lent : il a perdu des trames. Le CRDT permet
                        // de le remettre à niveau par un simple SyncStep1 — c'est
                        // précisément ce que l'ancien séquenceur ne pouvait pas
                        // faire, faute de savoir ce qui avait été manqué.
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

    // Annonce du départ : les pairs retirent immédiatement les curseurs et
    // l'avatar de ce participant, sans attendre l'expiration côté client.
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

    // Dernier parti : le document est sauvegardé chez son propriétaire, puis
    // effacé d'ici. Rien n'est fait tout de suite — un rechargement de page
    // passe par ce chemin, et `schedule_close` attend de voir si quelqu'un
    // revient avant de conclure.
    if remaining == 0 {
        crate::hook::schedule_close(state.clone(), handle.clone(), doc_id);
    }
    // Aucun « vidage à la déconnexion » : la durabilité est acquise à l'update
    // près, c'est tout l'intérêt de journaliser avant de rediffuser.
}

/// Sert à l'arrivant les présences déjà annoncées. Rend `false` si le lien casse.
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

/// Traite une trame et rend ce qu'il faut renvoyer à **l'émetteur**.
/// Ce qui doit partir aux autres passe par `handle.tx`.
#[allow(clippy::too_many_arguments)]
async fn handle_frame(
    state: &AppState,
    handle: &Arc<DocHandle>,
    identity: &Identity,
    connection_id: u64,
    doc_id: Uuid,
    bytes: &[u8],
    presences: &mut HashMap<u64, u64>,
    // Journalisé une seule fois par session : un lecteur émet son état à chaque
    // synchronisation, ce qui inonderait les journaux.
    write_refused: &mut bool,
) -> Vec<Vec<u8>> {
    let Some(message) = Message::decode(bytes) else {
        // Trame illisible ou type non supporté : ignorée, session conservée. La
        // fermer déclencherait une boucle de reconnexion chez un client dont
        // une seule trame est en cause.
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
            // Portée insuffisante : la modification est **ignorée**, pas la
            // session. Fermer la connexion serait une faute : le protocole de
            // synchronisation impose au client d'envoyer son état à l'ouverture
            // (SyncStep2), y compris en lecture seule. La fermer déclencherait
            // une boucle — le client se reconnecte, renvoie son état, se fait
            // fermer, indéfiniment.
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

        // Le client demande qui est là. On lui sert le registre plutôt que de le
        // laisser attendre la prochaine annonce spontanée de chacun.
        Message::QueryAwareness => handle
            .known_presences(connection_id)
            .into_iter()
            .map(|payload| Message::Awareness(payload.as_ref().clone()).encode())
            .collect(),

        // Présence : relayée telle quelle, jamais journalisée (donnée éphémère).
        // On note quels participants transitent par cette connexion, pour
        // pouvoir les retirer à sa fermeture.
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

            // Retenue avant d'être rediffusée : c'est la même charge utile qui
            // servira d'accueil au prochain arrivant.
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
        Err(e) => tracing::error!(%doc_id, author, error = %e, "tâche de journalisation interrompue"),
    }

    if handle.note_update() >= COMPACTION_THRESHOLD {
        handle.reset_update_counter();
        let store = state.store.clone();
        let key = doc_id.to_string();
        let snapshot = handle.full_state();
        // La compaction part en tâche de fond : elle réécrit tout le document,
        // et la faire en ligne bloquerait la frappe de tous les participants le
        // temps d'un `fsync` sur plusieurs mégaoctets.
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

    // Le journal et l'instantané ci-dessus protègent d'un redémarrage de
    // *Writer* : ils ne mettent rien dans le Drive. C'est le déchargement qui
    // remet la partie utile à CloudServ, seul propriétaire du document — et
    // c'est lui qui borne ce qu'une panne coûte à l'utilisateur.
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
