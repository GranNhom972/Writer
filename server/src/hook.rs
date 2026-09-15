//! Rappels vers CloudServ : déchargement périodique et fin de session.
//!
//! Writer n'est, pour CloudServ, qu'un éditeur **temporaire** : le document et
//! son historique appartiennent à CloudServ, et rien ne doit subsister ici une
//! fois la séance terminée. Ce module tient les deux étapes qui rendent ce
//! contrat vrai.
//!
//! ## Ce que Writer garde, et ce qu'il rend
//!
//! ```text
//!   état de travail   journal CRDT, présence, annulation, points de reprise
//!                     ─ n'a de sens que connecté, ne sort jamais d'ici
//!
//!   partie utile      le document projeté, images incorporées
//!                     ─ appartient à CloudServ, lui est remise régulièrement
//! ```
//!
//! ## Le déchargement périodique
//!
//! Il existe parce qu'une séance n'avait sinon **aucune existence dans le
//! Drive** avant sa fermeture. Un redémarrage de Writer, et tout le travail
//! depuis l'ouverture disparaissait : le fichier sur disque n'ayant pas bougé,
//! CloudServ rouvrait un état périmé sans que rien ne le signale.
//!
//! `schedule_checkpoint` est appelé à chaque update. Il attend l'accalmie —
//! projeter le document à chaque frappe serait absurde — sans jamais dépasser
//! `checkpoint_max_secs`, faute de quoi une frappe continue ne déchargerait
//! jamais. Ce plafond est exactement ce qu'un arrêt brutal peut coûter.
//!
//! Un déchargement manqué n'est pas rattrapé : le suivant emportera un état plus
//! récent. C'est ce qui le distingue du rappel de fermeture, où l'échec se paie
//! et où l'on insiste.
//!
//! ## Ce qui se passe quand le dernier participant s'en va
//!
//! ```text
//!   dernier départ
//!        │
//!        ├─ attendre le délai de grâce           (un F5 n'est pas un départ)
//!        ├─ le document est-il resté vide ?      (sinon : abandon silencieux)
//!        ├─ projeter le document en JSON
//!        ├─ y incorporer les images              (l'artefact doit être complet)
//!        ├─ POST vers CloudServ, signé           (CloudServ écrit le fichier
//!        │                                        et crée une version)
//!        └─ purger — et seulement si CloudServ a confirmé
//! ```
//!
//! ## Trois règles de correction
//!
//! 1. **On ne purge jamais avant confirmation.** Si CloudServ est injoignable,
//!    les données restent en place : elles seront resauvegardées à la
//!    réouverture. Perdre le travail de quelqu'un parce qu'un service voisin
//!    redémarrait serait indéfendable.
//! 2. **Un document que CloudServ ne connaît pas n'est pas purgé** (404). C'est
//!    le cas des documents que Writer héberge pour lui-même, hors intégration.
//! 3. **Le rappel est signé** (HMAC-SHA256 du corps, secret partagé). Sans
//!    cela, n'importe qui pourrait annoncer à CloudServ la fin d'une session et
//!    lui faire écrire le document de son choix.
//!
//! ## Pourquoi un client HTTP écrit à la main
//!
//! Le serveur n'a aujourd'hui aucune dépendance de client HTTP, et ce rappel est
//! la seule requête sortante du projet : une ligne de POST vers un service
//! interne. Y faire entrer `reqwest` et sa pile TLS pour cela seul serait
//! disproportionné.
//!
//! La contrepartie est explicite : **seul `http://` est géré**. CloudServ est
//! joint sur le réseau de la stack (`127.0.0.1:8021` par défaut). Le jour où il
//! faudra sortir de ce périmètre, c'est ici qu'un vrai client HTTP doit entrer —
//! et la fonction refuse déjà une adresse `https://` plutôt que de faire
//! semblant de la traiter.

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

/// Chemin du rappel côté CloudServ.
const CALLBACK_PATH: &str = "/api/cloud/writer/session-closed";

/// Chemin du déchargement périodique côté CloudServ.
const CHECKPOINT_PATH: &str = "/api/cloud/writer/session-checkpoint";

/// Tentatives d'envoi, espacées par un délai qui double.
///
/// CloudServ peut être en train de redémarrer : réessayer trois fois couvre une
/// indisponibilité de l'ordre de la demi-minute sans retenir la tâche
/// indéfiniment.
const MAX_ATTEMPTS: u32 = 3;
const FIRST_BACKOFF: Duration = Duration::from_secs(2);

/// Plafond de lecture de la réponse : le serveur ne rend qu'un petit JSON.
const MAX_RESPONSE_BYTES: usize = 64 * 1024;
const NETWORK_TIMEOUT: Duration = Duration::from_secs(20);

/// Programme la fermeture d'un document dont le dernier participant vient de
/// partir. Rend immédiatement : l'attente se fait dans une tâche détachée.
pub fn schedule_close(state: AppState, handle: Arc<DocHandle>, doc_id: Uuid) {
    // Sans adresse de CloudServ, le serveur tourne seul : il n'a personne à
    // prévenir, et surtout rien à purger.
    if state.cfg.cloudserv_url.is_none() {
        return;
    }
    let temoin = handle.occupancy();
    let grace = Duration::from_secs(state.cfg.close_grace_secs);

    tokio::spawn(async move {
        tokio::time::sleep(grace).await;

        // Quelqu'un est revenu — ou est passé et reparti, auquel cas une autre
        // tâche de fermeture, plus récente, fait foi. Dans les deux cas celle-ci
        // n'a plus rien à faire.
        if handle.active_clients() > 0 || handle.occupancy() != temoin {
            tracing::debug!(%doc_id, "fermeture annulée : le document a été rouvert");
            return;
        }

        close_document(&state, &handle, doc_id).await;
    });
}

/// Programme le déchargement de la partie utile vers CloudServ.
///
/// Appelé à **chaque** update reçue : le travail utile est de n'en retenir
/// qu'une. Rend immédiatement, l'attente se fait dans une tâche détachée.
///
/// ```text
///   frappe ──▶ une tâche veille-t-elle déjà ?  oui ─▶ rien à faire
///                              │ non
///                              ▼
///              attendre l'accalmie, sans dépasser le plafond
///                              │
///                              ▼
///              projeter · incorporer les images · POST signé
/// ```
pub fn schedule_checkpoint(state: AppState, handle: Arc<DocHandle>, doc_id: Uuid) {
    // Sans adresse de CloudServ, le serveur tourne seul : personne à qui
    // remettre la partie utile, et le document reste ici de toute façon.
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

        // Attendre que la frappe s'arrête — mais pas indéfiniment. Sur un
        // document écrit sans relâche, l'accalmie ne vient jamais : c'est
        // précisément le cas où ne pas décharger coûterait le plus cher.
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
        // Rendue seulement maintenant : pendant l'envoi, une frappe de plus n'a
        // pas à programmer une seconde tâche qui doublerait celle-ci.
        handle.release_checkpoint();
    });
}

/// Remet à CloudServ l'état courant du document, sans rien purger.
///
/// Un échec ne coûte rien de plus qu'un déchargement manqué : les données
/// restent ici, et la tentative suivante emportera un état plus récent. On ne
/// réessaie donc pas — insister ferait doubler la prochaine accalmie.
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
            // Le document n'appartient pas à CloudServ — Writer l'héberge pour
            // lui-même. Rien à décharger, et surtout rien à signaler comme
            // panne : ce cas est normal hors intégration.
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

/// Projette le document et y incorpore les images. Rend `None` si la projection
/// a échoué — auquel cas rien ne doit être envoyé.
///
/// Les images vivent dans le dépôt du serveur, désignées par une adresse
/// relative. Remettre le document sans elles livrerait à CloudServ un fichier
/// truffé de liens morts dès la purge.
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

/// Sauvegarde dans CloudServ puis purge. Toute erreur laisse les données en place.
async fn close_document(state: &AppState, handle: &Arc<DocHandle>, doc_id: Uuid) {
    let Some(base_url) = state.cfg.cloudserv_url.clone() else {
        return;
    };

    // Sans projection, rien à sauvegarder — et surtout rien à purger : les
    // données restent en place pour la prochaine tentative.
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
                // CloudServ ne connaît pas ce document : il ne lui appartient
                // pas. Le purger effacerait le travail de quelqu'un d'autre.
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

    // Échec définitif : on garde tout. Le document sera resauvegardé à la
    // prochaine ouverture, quand CloudServ le redemandera.
    tracing::error!(
        %doc_id,
        "sauvegarde impossible après {MAX_ATTEMPTS} tentatives — données conservées pour reprise"
    );
}

/// Efface le document du disque et de la mémoire.
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

// ── Incorporation des images ─────────────────────────────────────────────────

/// Préfixe des adresses d'images servies par ce serveur.
fn asset_prefix(doc_id: &str) -> String {
    format!("/api/v1/documents/{doc_id}/assets/")
}

/// Remplace chaque adresse d'image locale par une URI `data:` autonome.
///
/// Le document sauvegardé dans CloudServ doit se suffire à lui-même : c'est un
/// fichier de l'utilisateur, pas une vue sur un serveur qui, lui, va disparaître.
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

    // Un tableau porte ses propres blocs, jusqu'à trois niveaux plus bas :
    // rows → cells → blocks. Une image dans une cellule est une image comme
    // une autre, et l'oublier ne se verrait qu'après la purge.
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
    // Une image déjà en `data:` ou pointant ailleurs n'a rien à faire ici.
    let Some(nom) = src.strip_prefix(prefixe) else {
        return;
    };

    // Le nom passe par la même validation qu'à la lecture : c'est la seule
    // frontière entre un segment d'adresse et un chemin de fichier.
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
            // L'image manque : on laisse l'adresse telle quelle plutôt que de
            // la vider. Un lien mort se diagnostique, un run amputé ne se voit
            // pas — et le reste du document doit être sauvegardé quoi qu'il arrive.
            tracing::warn!(%doc_id, nom, error = %e, "image introuvable, non incorporée");
        }
    }
}

// ── Client HTTP minimal ──────────────────────────────────────────────────────

/// Adresse décomposée : autorité à joindre, hôte annoncé, préfixe de chemin.
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

/// POST d'un corps JSON signé. Rend le code de statut HTTP.
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

        // `Connection: close` : le serveur ferme, la lecture s'arrête d'elle-même.
        // Le plafond protège d'une réponse qui ne finirait pas.
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

/// Extrait le code de statut de la ligne de réponse : `HTTP/1.1 200 OK`.
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
        // Le cas qu'on oublie : les blocs d'une cellule ne sont pas dans
        // `blocks` mais trois niveaux plus bas.
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
                    // Adresse d'un AUTRE document : la purge de celui-ci ne la
                    // concerne pas, et la lire serait une fuite entre documents.
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

        // Sans port : le port HTTP par défaut, mais l'en-tête `Host` reste
        // celui qu'attend le serveur virtuel.
        let sans_port = parse_base_url("http://cloudserv.interne").unwrap();
        assert_eq!(sans_port.adresse, "cloudserv.interne:80");
        assert_eq!(sans_port.host, "cloudserv.interne");

        let avec_prefixe = parse_base_url("http://127.0.0.1:8021/cloud/").unwrap();
        assert_eq!(avec_prefixe.prefixe, "/cloud");
    }

    #[test]
    fn https_est_refuse_explicitement() {
        // Mieux vaut une erreur nette qu'une requête en clair vers un port TLS.
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
