// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors

//! Callbacks to CloudServ: periodic hand-over and end of session.
//!
//! For CloudServ, Writer is only a **temporary** editor: the document and its
//! history belong to CloudServ, and nothing should remain here once the session is
//! over. This module holds the two steps that make that contract true.
//!
//! ## What Writer keeps, and what it hands back
//!
//! ```text
//!   working state    CRDT log, presence, undo, restore points
//!                    (only meaningful while connected, never leaves this server)
//!
//!   useful part      the projected document, images embedded
//!                    (belongs to CloudServ, handed over regularly)
//! ```
//!
//! ## The periodic hand-over
//!
//! It exists because, without it, a session had **no existence in the Drive** until
//! it was closed. If Writer restarted, all the work since opening was lost: the file
//! on disk had not moved, so CloudServ would reopen an outdated state and nothing
//! would tell it.
//!
//! `schedule_checkpoint` is called on every update. It waits for a quiet moment
//! (projecting the document on every keystroke would be absurd) without ever
//! exceeding `checkpoint_max_secs`, otherwise continuous typing would never hand
//! anything over. That ceiling is exactly what a sudden shutdown can cost.
//!
//! A missed hand-over is not retried: the next one will carry a more recent state.
//! That is what sets it apart from the close callback, where a failure is costly
//! and where we insist.
//!
//! ## What happens when the last participant leaves
//!
//! ```text
//!   last departure
//!        │
//!        ├─ wait for the grace period            (an F5 is not a departure)
//!        ├─ did the document stay empty?         (if so: silent abandon)
//!        ├─ project the document to JSON
//!        ├─ embed the images in it               (the file must be complete)
//!        ├─ signed POST to CloudServ             (CloudServ writes the file
//!        │                                        and creates a version)
//!        └─ purge, and only if CloudServ confirmed
//! ```
//!
//! ## Three rules of correctness
//!
//! 1. **Never purge before confirmation.** If CloudServ cannot be reached, the data
//!    stays in place: it will be saved again on reopening. Losing someone's work
//!    because a neighboring service was restarting would be indefensible.
//! 2. **A document CloudServ does not know is not purged** (404). That is the case
//!    of documents Writer hosts for itself, outside the integration.
//! 3. **The callback is signed** (HMAC-SHA256 of the body, shared secret). Without
//!    it, anybody could tell CloudServ that a session ended and make it write the
//!    document of their choice.
//!
//! ## Why a hand-written HTTP client
//!
//! The server currently has no HTTP client dependency, and this callback is the
//! only outgoing request of the project: one POST line to an internal service.
//! Pulling in `reqwest` and its TLS stack for that alone would be out of
//! proportion.
//!
//! The trade-off is explicit: **only `http://` is supported**. CloudServ is reached
//! over the stack's network (`127.0.0.1:8021` by default). The day this has to leave
//! that perimeter, a real HTTP client must come in here, and the function already
//! refuses an `https://` address rather than pretend to handle it.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use uuid::Uuid;

use crate::crypto::{base64_encode, hmac_sha256, to_hex};
use crate::doc::DocHandle;
use crate::state::AppState;
use crate::store::FileStore;

/// Path of the session-closed callback on the CloudServ side.
const CALLBACK_PATH: &str = "/api/cloud/writer/session-closed";

/// Path of the periodic hand-over (checkpoint) on the CloudServ side.
const CHECKPOINT_PATH: &str = "/api/cloud/writer/session-checkpoint";

/// Number of send attempts, separated by a delay that doubles each time.
///
/// CloudServ may be restarting: trying three times covers an outage of about half
/// a minute without holding the task forever.
const MAX_ATTEMPTS: u32 = 3;
const FIRST_BACKOFF: Duration = Duration::from_secs(2);

/// Cap on how much of the response is read: the server only returns a small JSON.
const MAX_RESPONSE_BYTES: usize = 64 * 1024;
const NETWORK_TIMEOUT: Duration = Duration::from_secs(20);

/// Schedules the closing of a document whose last participant has just left.
/// Returns immediately: the waiting happens in a detached task.
pub fn schedule_close(state: AppState, handle: Arc<DocHandle>, doc_id: Uuid) {
    // Without a CloudServ address the server runs on its own: there is nobody to
    // notify and, above all, nothing to purge.
    if state.cfg.cloudserv_url.is_none() {
        return;
    }
    let temoin = handle.occupancy();
    let grace = Duration::from_secs(state.cfg.close_grace_secs);

    tokio::spawn(async move {
        tokio::time::sleep(grace).await;

        // Someone came back, or came and left again (in which case another, more recent
        // close task is the one that counts). Either way this task has nothing left to do.
        if handle.active_clients() > 0 || handle.occupancy() != temoin {
            tracing::debug!(%doc_id, "fermeture annulée : le document a été rouvert");
            return;
        }

        close_document(&state, &handle, doc_id).await;
    });
}

/// Schedules the hand-over of the useful part to CloudServ.
///
/// Called on **every** update received: the useful work is to keep only one of
/// them. Returns immediately, the waiting happens in a detached task.
///
/// ```text
///   keystroke ──▶ is a task already waiting?   yes ─▶ nothing to do
///                               │ no
///                               ▼
///               wait for a quiet moment, without exceeding the ceiling
///                               │
///                               ▼
///               project · embed images · signed POST
/// ```
pub fn schedule_checkpoint(state: AppState, handle: Arc<DocHandle>, doc_id: Uuid) {
    // Without a CloudServ address the server runs on its own: nobody to hand the
    // useful part to, and the document stays here anyway.
    if state.cfg.cloudserv_url.is_none() {
        return;
    }
    if !handle.claim_checkpoint() {
        return;
    }

    let quiet = Duration::from_secs(state.cfg.checkpoint_quiet_secs);
    let plafond = Duration::from_secs(state.cfg.checkpoint_max_secs);

    tokio::spawn(async move {
        let debut = tokio::time::Instant::now();

        // Wait for typing to stop, but not forever. On a document written without a
        // break the quiet moment never comes, and that is precisely the case where not
        // handing over would cost the most.
        loop {
            let avant = handle.revision();
            tokio::time::sleep(quiet).await;
            if handle.revision() == avant {
                break;
            }
            if debut.elapsed() >= plafond {
                tracing::debug!(%doc_id, "plafond atteint : déchargement sans attendre l'accalmie");
                break;
            }
        }

        checkpoint_document(&state, &handle, doc_id).await;
        // Released only now: while sending, one more keystroke must not schedule a second
        // task that would duplicate this one.
        handle.release_checkpoint();
    });
}

/// Hands the current state of the document to CloudServ, without purging anything.
///
/// A failure costs nothing more than a missed hand-over: the data stays here, and
/// the next attempt will carry a more recent state. So we do not retry: insisting
/// would only delay the next quiet moment.
async fn checkpoint_document(state: &AppState, handle: &Arc<DocHandle>, doc_id: Uuid) {
    let Some(base_url) = state.cfg.cloudserv_url.clone() else {
        return;
    };

    let Some((revision, document)) = projeter(state, handle, doc_id).await else {
        return;
    };

    let corps = json!({
        "doc_id": doc_id,
        "revision": revision,
        "title": handle.title(),
        "document": document,
    })
    .to_string();

    let secret = secret_partage(state);
    match post_json(&base_url, CHECKPOINT_PATH, &corps, &secret).await {
        Ok(status) if (200..300).contains(&status) => {
            tracing::info!(%doc_id, revision, "partie utile déchargée dans CloudServ");
        }
        Ok(404) => {
            // The document does not belong to CloudServ: Writer hosts it for itself. Nothing
            // to hand over and, above all, nothing to report as a fault: this case is normal
            // outside the integration.
            tracing::debug!(%doc_id, "document inconnu de CloudServ, déchargement sans objet");
        }
        Ok(status) => {
            tracing::warn!(%doc_id, status, "CloudServ a refusé le déchargement");
        }
        Err(e) => {
            tracing::warn!(%doc_id, error = %e, "déchargement vers CloudServ échoué");
        }
    }
}

/// Projects the document and embeds the images in it. Returns `None` if the
/// projection failed, in which case nothing must be sent.
///
/// Images live in the server's store and are referred to by a relative address.
/// Handing the document over without them would give CloudServ a file full of dead
/// links as soon as the purge happens.
async fn projeter(state: &AppState, handle: &Arc<DocHandle>, doc_id: Uuid) -> Option<(u64, Value)> {
    let (revision, document) = handle.snapshot();
    let store = state.store.clone();
    let cle = doc_id.to_string();

    match tokio::task::spawn_blocking(move || inline_assets(&store, &cle, document)).await {
        Ok(valeur) => Some((revision, valeur)),
        Err(e) => {
            tracing::error!(%doc_id, error = %e, "incorporation des images interrompue");
            None
        }
    }
}

fn secret_partage(state: &AppState) -> Vec<u8> {
    state
        .cfg
        .auth
        .jwt_secret
        .clone()
        .unwrap_or_default()
        .into_bytes()
}

/// Saves to CloudServ, then purges. Any error leaves the data in place.
async fn close_document(state: &AppState, handle: &Arc<DocHandle>, doc_id: Uuid) {
    let Some(base_url) = state.cfg.cloudserv_url.clone() else {
        return;
    };

    // Without a projection there is nothing to save, and above all nothing to purge:
    // the data stays in place for the next attempt.
    let Some((revision, document)) = projeter(state, handle, doc_id).await else {
        tracing::error!(%doc_id, "projection impossible, sauvegarde abandonnée");
        return;
    };

    let corps = json!({
        "doc_id": doc_id,
        "revision": revision,
        "title": handle.title(),
        "document": document,
    })
    .to_string();

    let secret = secret_partage(state);

    let mut delai = FIRST_BACKOFF;
    for tentative in 1..=MAX_ATTEMPTS {
        match post_json(&base_url, CALLBACK_PATH, &corps, &secret).await {
            Ok(status) if (200..300).contains(&status) => {
                tracing::info!(%doc_id, revision, "document sauvegardé dans CloudServ");
                purge(state, doc_id).await;
                return;
            }
            Ok(404) => {
                // CloudServ does not know this document: it does not belong to it. Purging it
                // would erase somebody else's work.
                tracing::info!(%doc_id, "document inconnu de CloudServ, conservé tel quel");
                return;
            }
            Ok(status) => {
                tracing::warn!(%doc_id, status, tentative, "CloudServ a refusé le rappel");
            }
            Err(e) => {
                tracing::warn!(%doc_id, error = %e, tentative, "rappel vers CloudServ échoué");
            }
        }
        if tentative < MAX_ATTEMPTS {
            tokio::time::sleep(delai).await;
            delai *= 2;
        }
    }

    // Final failure: keep everything. The document will be saved again the next time
    // it is opened, when CloudServ asks for it.
    tracing::error!(
        %doc_id,
        "sauvegarde impossible après {MAX_ATTEMPTS} tentatives — données conservées pour reprise"
    );
}

/// Erases the document from disk and from memory.
pub async fn purge(state: &AppState, doc_id: Uuid) {
    let store = state.store.clone();
    let cle = doc_id.to_string();
    match tokio::task::spawn_blocking(move || store.purge(&cle)).await {
        Ok(Ok(())) => {
            state.forget_doc(doc_id);
            tracing::info!(%doc_id, "données temporaires supprimées");
        }
        Ok(Err(e)) => tracing::error!(%doc_id, error = %e, "purge impossible"),
        Err(e) => tracing::error!(%doc_id, error = %e, "purge interrompue"),
    }
}

// ── Embedding images ─────────────────────────────────────────────────────────

/// Prefix of the image addresses served by this server.
fn asset_prefix(doc_id: &str) -> String {
    format!("/api/v1/documents/{doc_id}/assets/")
}

/// Replaces every local image address with a self-contained `data:` URI.
///
/// The document saved in CloudServ must be complete by itself: it is a user's file,
/// not a view onto a server that is about to disappear.
pub fn inline_assets(store: &FileStore, doc_id: &str, mut document: Value) -> Value {
    let prefixe = asset_prefix(doc_id);
    if let Some(blocks) = document.get_mut("blocks").and_then(Value::as_array_mut) {
        for bloc in blocks.iter_mut() {
            inline_block(store, doc_id, &prefixe, bloc);
        }
    }
    document
}

fn inline_block(store: &FileStore, doc_id: &str, prefixe: &str, bloc: &mut Value) {
    if let Some(runs) = bloc.get_mut("runs").and_then(Value::as_array_mut) {
        for run in runs.iter_mut() {
            inline_run(store, doc_id, prefixe, run);
        }
    }

    // A table carries its own blocks, up to three levels down: rows → cells →
    // blocks. An image in a cell is an image like any other, and forgetting it would
    // only show after the purge.
    if let Some(rows) = bloc.get_mut("rows").and_then(Value::as_array_mut) {
        for row in rows.iter_mut() {
            let Some(cells) = row.get_mut("cells").and_then(Value::as_array_mut) else {
                continue;
            };
            for cell in cells.iter_mut() {
                let Some(blocs) = cell.get_mut("blocks").and_then(Value::as_array_mut) else {
                    continue;
                };
                for interne in blocs.iter_mut() {
                    inline_block(store, doc_id, prefixe, interne);
                }
            }
        }
    }
}

fn inline_run(store: &FileStore, doc_id: &str, prefixe: &str, run: &mut Value) {
    let Some(src) = run.get("imageSrc").and_then(Value::as_str) else {
        return;
    };
    // An image that is already a `data:` URL or points elsewhere has nothing to do
    // here.
    let Some(nom) = src.strip_prefix(prefixe) else {
        return;
    };

    // The name goes through the same validation as when reading: it is the only
    // boundary between an address segment and a file path.
    let Some((_, kind)) = crate::assets::parse_asset_name(nom) else {
        tracing::warn!(%doc_id, nom, "adresse d'image ignorée : nom non conforme");
        return;
    };

    match store.read_asset(doc_id, nom) {
        Ok(octets) => {
            let data_uri = format!(
                "data:{};base64,{}",
                kind.content_type(),
                base64_encode(&octets)
            );
            run["imageSrc"] = Value::String(data_uri);
        }
        Err(e) => {
            // The image is missing: leave the address as it is rather than emptying it. A dead
            // link can be diagnosed, a truncated run cannot be seen, and the rest of the
            // document must be saved whatever happens.
            tracing::warn!(%doc_id, nom, error = %e, "image introuvable, non incorporée");
        }
    }
}

// ── Minimal HTTP client ──────────────────────────────────────────────────────

/// A decomposed address: the authority to connect to, the announced host and the
/// path prefix.
struct Cible {
    adresse: String,
    host: String,
    prefixe: String,
}

fn parse_base_url(base: &str) -> Result<Cible, String> {
    if base.starts_with("https://") {
        return Err("adresse https non gérée par le client interne".to_string());
    }
    let reste = base
        .strip_prefix("http://")
        .ok_or_else(|| format!("adresse sans schéma http: {base}"))?;

    let (autorite, prefixe) = match reste.find('/') {
        Some(index) => (&reste[..index], reste[index..].trim_end_matches('/')),
        None => (reste, ""),
    };
    if autorite.is_empty() {
        return Err("adresse sans hôte".to_string());
    }

    let adresse = if autorite.contains(':') {
        autorite.to_string()
    } else {
        format!("{autorite}:80")
    };

    Ok(Cible {
        adresse,
        host: autorite.to_string(),
        prefixe: prefixe.to_string(),
    })
}

/// POSTs a signed JSON body. Returns the HTTP status code.
async fn post_json(base: &str, path: &str, body: &str, secret: &[u8]) -> Result<u16, String> {
    let cible = parse_base_url(base)?;
    let chemin = format!("{}{}", cible.prefixe, path);
    let signature = to_hex(&hmac_sha256(secret, body.as_bytes()));

    let requete = format!(
        "POST {chemin} HTTP/1.1\r\n\
         Host: {host}\r\n\
         Content-Type: application/json\r\n\
         Content-Length: {len}\r\n\
         X-Writer-Signature: {signature}\r\n\
         Connection: close\r\n\
         \r\n\
         {body}",
        host = cible.host,
        len = body.len(),
    );

    let echange = async {
        let mut flux = TcpStream::connect(&cible.adresse)
            .await
            .map_err(|e| format!("connexion à {}: {e}", cible.adresse))?;
        flux.write_all(requete.as_bytes())
            .await
            .map_err(|e| format!("envoi: {e}"))?;
        flux.flush().await.map_err(|e| format!("envoi: {e}"))?;

        // `Connection: close`: the server closes, so reading stops by itself. The cap
        // protects against a response that would never end.
        let mut reponse = Vec::new();
        let mut tampon = [0u8; 8192];
        loop {
            let lus = flux
                .read(&mut tampon)
                .await
                .map_err(|e| format!("lecture: {e}"))?;
            if lus == 0 {
                break;
            }
            reponse.extend_from_slice(&tampon[..lus]);
            if reponse.len() >= MAX_RESPONSE_BYTES {
                break;
            }
        }
        Ok::<Vec<u8>, String>(reponse)
    };

    let reponse = tokio::time::timeout(NETWORK_TIMEOUT, echange)
        .await
        .map_err(|_| "délai dépassé".to_string())??;

    parse_status(&reponse)
}

/// Extracts the status code from the response line: `HTTP/1.1 200 OK`.
fn parse_status(reponse: &[u8]) -> Result<u16, String> {
    let ligne = reponse
        .split(|o| *o == b'\n')
        .next()
        .ok_or_else(|| "réponse vide".to_string())?;
    let ligne = String::from_utf8_lossy(ligne);
    let mut morceaux = ligne.split_whitespace();
    let version = morceaux.next().unwrap_or("");
    if !version.starts_with("HTTP/") {
        return Err(format!("réponse non HTTP: {ligne}"));
    }
    morceaux
        .next()
        .and_then(|code| code.parse().ok())
        .ok_or_else(|| format!("statut illisible: {ligne}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn store_temporaire(nom: &str) -> (FileStore, String, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("writer-hook-{nom}-{}", Uuid::new_v4()));
        let store = FileStore::new(&dir).unwrap();
        let doc_id = Uuid::now_v7().to_string();
        (store, doc_id, dir)
    }

    #[test]
    fn une_image_deposee_est_incorporee() {
        let (store, doc_id, dir) = store_temporaire("inline");
        let png = b"\x89PNG\r\n\x1a\n donnees".to_vec();
        let nom = format!("{}.png", Uuid::new_v4());
        store.write_asset(&doc_id, &nom, &png).unwrap();

        let document = json!({
            "blocks": [{
                "id": "p1", "type": "paragraph",
                "runs": [
                    { "text": "avant" },
                    { "text": "\u{fffc}", "imageSrc": format!("/api/v1/documents/{doc_id}/assets/{nom}") },
                ],
            }],
        });

        let sortie = inline_assets(&store, &doc_id, document);
        let src = sortie["blocks"][0]["runs"][1]["imageSrc"].as_str().unwrap();
        assert!(src.starts_with("data:image/png;base64,"));
        assert_eq!(
            src.trim_start_matches("data:image/png;base64,"),
            base64_encode(&png)
        );

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn une_image_dans_une_cellule_de_tableau_est_incorporee() {
        // The case that gets forgotten: the blocks of a cell are not in `blocks` but
        // three levels down.
        let (store, doc_id, dir) = store_temporaire("tableau");
        let gif = b"GIF89a-donnees".to_vec();
        let nom = format!("{}.gif", Uuid::new_v4());
        store.write_asset(&doc_id, &nom, &gif).unwrap();

        let document = json!({
            "blocks": [{
                "id": "t1", "type": "table",
                "rows": [{
                    "id": "r1",
                    "cells": [{
                        "id": "c1",
                        "blocks": [{
                            "id": "p1", "type": "paragraph",
                            "runs": [{ "text": "\u{fffc}", "imageSrc": format!("/api/v1/documents/{doc_id}/assets/{nom}") }],
                        }],
                    }],
                }],
            }],
        });

        let sortie = inline_assets(&store, &doc_id, document);
        let src = sortie["blocks"][0]["rows"][0]["cells"][0]["blocks"][0]["runs"][0]["imageSrc"]
            .as_str()
            .unwrap();
        assert!(src.starts_with("data:image/gif;base64,"));

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn une_adresse_etrangere_nest_pas_touchee() {
        let (store, doc_id, dir) = store_temporaire("etranger");
        let document = json!({
            "blocks": [{
                "id": "p1", "type": "paragraph",
                "runs": [
                    { "text": "a", "imageSrc": "data:image/png;base64,AAAA" },
                    { "text": "b", "imageSrc": "https://exemple.test/photo.png" },
                    // The address of ANOTHER document: purging this one is none of its business, and
                    // reading it would be a leak between documents.
                    { "text": "c", "imageSrc": format!("/api/v1/documents/{}/assets/x.png", Uuid::now_v7()) },
                ],
            }],
        });

        let sortie = inline_assets(&store, &doc_id, document.clone());
        assert_eq!(sortie, document);

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn une_image_manquante_laisse_ladresse_en_place() {
        let (store, doc_id, dir) = store_temporaire("manquante");
        let nom = format!("{}.png", Uuid::new_v4());
        let document = json!({
            "blocks": [{
                "id": "p1", "type": "paragraph",
                "runs": [{ "text": "\u{fffc}", "imageSrc": format!("/api/v1/documents/{doc_id}/assets/{nom}") }],
            }],
        });

        let sortie = inline_assets(&store, &doc_id, document.clone());
        assert_eq!(sortie, document, "le reste du document doit survivre");

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn un_nom_dimage_hostile_est_refuse() {
        let (store, doc_id, dir) = store_temporaire("hostile");
        let document = json!({
            "blocks": [{
                "id": "p1", "type": "paragraph",
                "runs": [{
                    "text": "\u{fffc}",
                    "imageSrc": format!("/api/v1/documents/{doc_id}/assets/../../../etc/passwd"),
                }],
            }],
        });

        let sortie = inline_assets(&store, &doc_id, document.clone());
        assert_eq!(sortie, document);

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn adresse_de_base_decomposee() {
        let cible = parse_base_url("http://127.0.0.1:8021").unwrap();
        assert_eq!(cible.adresse, "127.0.0.1:8021");
        assert_eq!(cible.host, "127.0.0.1:8021");
        assert_eq!(cible.prefixe, "");

        // No port: the default HTTP port, but the `Host` header stays the one the virtual
        // host expects.
        let sans_port = parse_base_url("http://cloudserv.interne").unwrap();
        assert_eq!(sans_port.adresse, "cloudserv.interne:80");
        assert_eq!(sans_port.host, "cloudserv.interne");

        let avec_prefixe = parse_base_url("http://127.0.0.1:8021/cloud/").unwrap();
        assert_eq!(avec_prefixe.prefixe, "/cloud");
    }

    #[test]
    fn https_est_refuse_explicitement() {
        // A clean error is better than a plain-text request to a TLS port.
        assert!(parse_base_url("https://cloudserv.interne").is_err());
        assert!(parse_base_url("cloudserv.interne").is_err());
    }

    #[test]
    fn statut_extrait_de_la_ligne_de_reponse() {
        assert_eq!(parse_status(b"HTTP/1.1 200 OK\r\n\r\n{}").unwrap(), 200);
        assert_eq!(parse_status(b"HTTP/1.1 404 Not Found\r\n").unwrap(), 404);
        assert!(parse_status(b"pas du http").is_err());
        assert!(parse_status(b"").is_err());
    }

    #[test]
    fn la_signature_du_rappel_depend_du_corps() {
        let secret = b"secret";
        let a = to_hex(&hmac_sha256(secret, br#"{"doc_id":"a"}"#));
        let b = to_hex(&hmac_sha256(secret, br#"{"doc_id":"b"}"#));
        assert_ne!(a, b);
        assert_eq!(a.len(), 64);
    }
}
