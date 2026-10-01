// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Les contributeurs de Writer

//! Persistance : journal d'updates en ajout seul + instantanés compactés.
//!
//! Reprise du `FileStore` de `write/server`. Le journal contient désormais des
//! **updates CRDT binaires** cadrées, et non plus des lignes JSON d'opérations
//! de bloc : c'est la conséquence directe du passage au relais Yjs, où le
//! serveur ne connaît plus le contenu de ce qu'il transporte.
//!
//! On y perd la lisibilité d'un `tail -f` sur le journal, et c'est un vrai
//! regret. On y gagne ce que l'ancien format ne pouvait pas donner : deux
//! personnes écrivant dans le même paragraphe ne s'effacent plus. Le contenu
//! reste consultable en JSON par `GET /documents/{id}/snapshot` et par le flux
//! d'observation, qui projettent le document à la demande (`content.rs`).
//!
//! La durabilité ne change pas : `fsync` avant de rendre la main.
//!
//! ## Documents écrits par la version précédente
//!
//! Les anciens fichiers (`journal.jsonl`, `snapshot.json`) portent des noms
//! différents des nouveaux (`journal.bin`, `snapshot.bin`) : ils ne sont donc
//! jamais lus par erreur. `load_legacy` les relit explicitement au premier
//! chargement d'un document ancien, pour l'amorcer avec son contenu plutôt que
//! de le rouvrir vide.

use std::io::Write;
use std::path::{Path, PathBuf};

use crate::error::{AppError, AppResult};
use crate::legacy::SequencedOperation;

/// Nombre d'updates journalisées avant compaction en instantané.
pub const COMPACTION_THRESHOLD: usize = 500;

/// Points de restauration conservés par document.
pub const MAX_RESTORE_POINTS: usize = 20;

/// Garde de relecture : un document texte n'atteint jamais cette taille.
const MAX_SNAPSHOT_BYTES: u64 = 64 * 1024 * 1024;

/// Un état daté du document, conservé après compaction.
#[derive(Debug, Clone, serde::Serialize)]
pub struct RestorePoint {
    /// Horodatage servant d'identifiant (`20260825T151530.123456`).
    pub id: String,
    pub size_bytes: u64,
}

#[derive(Debug, Default)]
pub struct LoadedDocument {
    /// Instantané compacté (update CRDT complète) s'il existe.
    pub snapshot: Option<Vec<u8>>,
    /// Updates journalisées après l'instantané, dans l'ordre d'arrivée.
    pub updates: Vec<Vec<u8>>,
    /// Trames du journal qu'on n'a pas su relire — annoncées, jamais tues.
    pub corrupted: usize,
}

/// Ce qu'un document de l'ancien format porte encore sur le disque.
#[derive(Debug, Default)]
pub struct LegacyDocument {
    /// Instantané JSON et la révision qu'il représentait.
    pub snapshot: Option<(u64, serde_json::Value)>,
    pub operations: Vec<SequencedOperation>,
}

pub struct FileStore {
    root: PathBuf,
}

impl FileStore {
    pub fn new(root: impl Into<PathBuf>) -> AppResult<Self> {
        let root = root.into();
        std::fs::create_dir_all(&root)?;
        Ok(Self { root })
    }

    fn dir(&self, doc_id: &str) -> PathBuf {
        // `doc_id` est un UUID validé en amont : il ne provient jamais brut du
        // client, donc aucune traversée de répertoire n'est possible ici.
        self.root.join(doc_id)
    }

    fn journal_path(&self, doc_id: &str) -> PathBuf {
        self.dir(doc_id).join("journal.bin")
    }

    fn snapshot_path(&self, doc_id: &str) -> PathBuf {
        self.dir(doc_id).join("snapshot.bin")
    }

    // Ancien format : lu une fois, jamais écrit.
    fn legacy_journal_path(&self, doc_id: &str) -> PathBuf {
        self.dir(doc_id).join("journal.jsonl")
    }

    fn legacy_snapshot_path(&self, doc_id: &str) -> PathBuf {
        self.dir(doc_id).join("snapshot.json")
    }

    fn restore_dir(&self, doc_id: &str) -> PathBuf {
        self.dir(doc_id).join("points")
    }

    fn meta_path(&self, doc_id: &str) -> PathBuf {
        self.dir(doc_id).join("meta.json")
    }

    pub fn create(&self, doc_id: &str, meta_json: &str) -> AppResult<()> {
        std::fs::create_dir_all(self.dir(doc_id))?;
        std::fs::write(self.meta_path(doc_id), meta_json)?;
        Ok(())
    }

    pub fn read_meta(&self, doc_id: &str) -> AppResult<String> {
        std::fs::read_to_string(self.meta_path(doc_id)).map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => AppError::NotFound,
            _ => AppError::Storage(e),
        })
    }

    pub fn exists(&self, doc_id: &str) -> bool {
        self.meta_path(doc_id).is_file()
    }

    /// Documents connus du stockage. `_sessions/` n'a pas de `meta.json` : le
    /// répertoire des sessions est donc ignoré sans traitement particulier.
    pub fn list(&self) -> AppResult<Vec<String>> {
        let mut out = Vec::new();
        for entry in std::fs::read_dir(&self.root)? {
            let entry = entry?;
            if entry.path().join("meta.json").is_file() {
                if let Some(name) = entry.file_name().to_str() {
                    out.push(name.to_string());
                }
            }
        }
        Ok(out)
    }

    /// Ajoute une update au journal durable.
    ///
    /// `sync_data` avant de rendre la main : sans lui, la modification vivrait
    /// dans le cache du système, et une coupure de courant la perdrait après
    /// que les pairs l'ont déjà affichée.
    pub fn append_update(&self, doc_id: &str, update: &[u8]) -> AppResult<()> {
        std::fs::create_dir_all(self.dir(doc_id))?;
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.journal_path(doc_id))?;

        // Cadrage longueur (u32 petit-boutiste) puis charge utile : une update
        // binaire n'a pas de séparateur naturel, contrairement à une ligne JSON.
        let len = u32::try_from(update.len()).map_err(|_| AppError::PayloadTooLarge)?;
        file.write_all(&len.to_le_bytes())?;
        file.write_all(update)?;
        file.flush()?;
        file.sync_data()?;
        Ok(())
    }

    pub fn load(&self, doc_id: &str) -> AppResult<LoadedDocument> {
        let snapshot = match std::fs::read(self.snapshot_path(doc_id)) {
            Ok(bytes) => Some(bytes),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(AppError::Storage(e)),
        };

        let journal = match std::fs::read(self.journal_path(doc_id)) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(e) => return Err(AppError::Storage(e)),
        };

        let (updates, corrupted) = decode_journal(&journal);
        Ok(LoadedDocument {
            snapshot,
            updates,
            corrupted,
        })
    }

    /// Le document existe-t-il déjà au nouveau format ?
    ///
    /// Sert à décider s'il faut tenter la reprise de l'ancien : un document
    /// repris une fois porte un instantané binaire, et ne doit plus jamais
    /// repasser par le journal JSON — l'amorcer une seconde fois y ajouterait
    /// un exemplaire de plus du contenu.
    pub fn has_crdt_state(&self, doc_id: &str) -> bool {
        self.snapshot_path(doc_id).is_file() || self.journal_path(doc_id).is_file()
    }

    /// Relit un document de l'ancien format. `None` s'il n'y en a pas.
    pub fn load_legacy(&self, doc_id: &str) -> AppResult<Option<LegacyDocument>> {
        #[derive(serde::Deserialize)]
        struct AncienInstantane {
            revision: u64,
            document: serde_json::Value,
        }

        let snapshot = match std::fs::read(self.legacy_snapshot_path(doc_id)) {
            Ok(bytes) => match serde_json::from_slice::<AncienInstantane>(&bytes) {
                Ok(ancien) => Some((ancien.revision, ancien.document)),
                Err(e) => {
                    tracing::error!(doc_id, error = %e, "ancien instantané illisible");
                    None
                }
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(AppError::Storage(e)),
        };

        let journal = match std::fs::read_to_string(self.legacy_journal_path(doc_id)) {
            Ok(texte) => texte,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
            Err(e) => return Err(AppError::Storage(e)),
        };

        if snapshot.is_none() && journal.trim().is_empty() {
            return Ok(None);
        }

        let mut operations: Vec<SequencedOperation> = journal
            .lines()
            .filter(|ligne| !ligne.trim().is_empty())
            // Ligne tronquée par une coupure en cours d'écriture : ignorée.
            .filter_map(|ligne| serde_json::from_str(ligne).ok())
            .collect();
        operations.sort_by_key(|operation| operation.revision);

        Ok(Some(LegacyDocument {
            snapshot,
            operations,
        }))
    }

    // ── Images déposées ──────────────────────────────────────────────────────

    fn assets_dir(&self, doc_id: &str) -> PathBuf {
        self.dir(doc_id).join("assets")
    }

    /// `name` a traversé `assets::parse_asset_name` : c'est un UUID suivi d'une
    /// extension connue, fabriqué par le serveur. Aucun segment de chemin ne
    /// peut s'y trouver — c'est ce qui rend cette jointure sûre.
    fn asset_path(&self, doc_id: &str, name: &str) -> PathBuf {
        self.assets_dir(doc_id).join(name)
    }

    pub fn write_asset(&self, doc_id: &str, name: &str, bytes: &[u8]) -> AppResult<()> {
        std::fs::create_dir_all(self.assets_dir(doc_id))?;
        let mut file = std::fs::File::create(self.asset_path(doc_id, name))?;
        file.write_all(bytes)?;
        file.sync_data()?;
        Ok(())
    }

    pub fn read_asset(&self, doc_id: &str, name: &str) -> AppResult<Vec<u8>> {
        std::fs::read(self.asset_path(doc_id, name)).map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => AppError::NotFound,
            _ => AppError::Storage(e),
        })
    }

    /// Efface toute trace d'un document : métadonnées, instantané, journal,
    /// points de restauration et images.
    ///
    /// C'est ce qui fait de Writer un éditeur **temporaire** quand il travaille
    /// pour CloudServ : la sauvegarde faite, il ne doit plus rien rester ici.
    /// Un document déjà absent n'est pas une erreur — la purge est appelée sur
    /// un chemin de reprise, où elle peut avoir déjà eu lieu.
    pub fn purge(&self, doc_id: &str) -> AppResult<()> {
        match std::fs::remove_dir_all(self.dir(doc_id)) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(AppError::Storage(e)),
        }
    }

    // ── Sessions ─────────────────────────────────────────────────────────────
    //
    // Une session vit à part des documents : son identifiant (`token_session`)
    // est fourni par le client, alors qu'un `doc_id` est généré par le serveur.
    // Les mélanger dans la même arborescence rendrait `list()` dépendant d'une
    // entrée dont le nom vient du dehors.

    fn sessions_dir(&self) -> PathBuf {
        self.root.join("_sessions")
    }

    fn session_path(&self, token_session: &str) -> PathBuf {
        // `token_session` est validé en amont (`session::valid_token`) :
        // alphanumériques, `-` et `_` uniquement. Aucun `/` ni `..` n'arrive ici.
        self.sessions_dir().join(format!("{token_session}.json"))
    }

    pub fn session_exists(&self, token_session: &str) -> bool {
        self.session_path(token_session).is_file()
    }

    /// Crée la session. Échoue si elle existe déjà — c'est la vérification
    /// d'unicité exprimée là où elle est atomique : dans le système de fichiers.
    /// Un `exists()` suivi d'un `write()` laisserait une fenêtre de course.
    pub fn create_session(&self, token_session: &str, record_json: &str) -> AppResult<()> {
        std::fs::create_dir_all(self.sessions_dir())?;
        let mut file = match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(self.session_path(token_session))
        {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                return Err(AppError::Conflict(format!(
                    "une session porte déjà le jeton « {token_session} »"
                )))
            }
            Err(e) => return Err(AppError::Storage(e)),
        };
        file.write_all(record_json.as_bytes())?;
        file.sync_data()?;
        Ok(())
    }

    /// Réécrit une session existante — ajout ou retrait d'un participant.
    ///
    /// Écriture par fichier temporaire puis renommage : un `write` direct
    /// tronquerait le fichier avant de le remplir, et une coupure au mauvais
    /// moment laisserait une session vide, donc un document inaccessible à tous.
    pub fn replace_session(&self, token_session: &str, record_json: &str) -> AppResult<()> {
        std::fs::create_dir_all(self.sessions_dir())?;
        let cible = self.session_path(token_session);
        let temporaire = cible.with_extension("json.tmp");
        {
            let mut file = std::fs::File::create(&temporaire)?;
            file.write_all(record_json.as_bytes())?;
            file.sync_data()?;
        }
        std::fs::rename(&temporaire, &cible)?;
        Ok(())
    }

    pub fn read_session(&self, token_session: &str) -> AppResult<String> {
        std::fs::read_to_string(self.session_path(token_session)).map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => AppError::NotFound,
            _ => AppError::Storage(e),
        })
    }

    /// Retire une session. Sert au rattrapage : si le document n'a pas pu être
    /// créé après la prise du jeton, laisser la session condamnerait ce jeton.
    pub fn remove_session(&self, token_session: &str) -> AppResult<()> {
        match std::fs::remove_file(self.session_path(token_session)) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(AppError::Storage(e)),
        }
    }

    pub fn list_sessions(&self) -> AppResult<Vec<String>> {
        let dir = match std::fs::read_dir(self.sessions_dir()) {
            Ok(dir) => dir,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(AppError::Storage(e)),
        };
        let mut out = Vec::new();
        for entry in dir {
            let name = entry?.file_name();
            if let Some(token) = name.to_str().and_then(|n| n.strip_suffix(".json")) {
                out.push(token.to_string());
            }
        }
        Ok(out)
    }

    // ── Compaction et points de restauration ─────────────────────────────────

    /// Écrit un instantané compacté puis tronque le journal.
    ///
    /// L'ordre importe : instantané d'abord, journal ensuite. Un arrêt entre les
    /// deux rejoue au pire des opérations déjà incluses ; comme la révision de
    /// l'instantané est connue, le rejeu les ignore. L'inverse perdrait tout ce
    /// que le journal portait.
    pub fn write_snapshot(&self, doc_id: &str, snapshot: &[u8]) -> AppResult<()> {
        std::fs::create_dir_all(self.dir(doc_id))?;
        let brut = snapshot;

        let tmp = self.dir(doc_id).join("snapshot.bin.tmp");
        std::fs::write(&tmp, brut)?;
        std::fs::rename(&tmp, self.snapshot_path(doc_id))?;

        // L'instantané est conservé comme point de restauration : sans cela, une
        // suppression massive devient définitive dès la compaction suivante, le
        // journal qui la contredisait ayant été tronqué.
        self.keep_restore_point(doc_id, brut)?;

        truncate_if_exists(&self.journal_path(doc_id))?;
        Ok(())
    }

    fn keep_restore_point(&self, doc_id: &str, brut: &[u8]) -> AppResult<()> {
        let dossier = self.restore_dir(doc_id);
        std::fs::create_dir_all(&dossier)?;

        // Identifiant unique : deux compactions dans la même milliseconde
        // produiraient sinon le même nom, et l'une écraserait l'autre — le point
        // le plus ancien disparaîtrait sans bruit.
        let horodatage = chrono::Utc::now().format("%Y%m%dT%H%M%S%.6f").to_string();
        let mut chemin = dossier.join(format!("{horodatage}.bin"));
        let mut suffixe = 1;
        while chemin.exists() && suffixe < 100 {
            chemin = dossier.join(format!("{horodatage}-{suffixe}.bin"));
            suffixe += 1;
        }
        std::fs::write(chemin, brut)?;

        let mut points = self.list_restore_points(doc_id)?;
        while points.len() > MAX_RESTORE_POINTS {
            if let Some(ancien) = points.first().cloned() {
                let _ = std::fs::remove_file(dossier.join(format!("{}.bin", ancien.id)));
                points.remove(0);
            } else {
                break;
            }
        }
        Ok(())
    }

    /// Points de restauration, du plus ancien au plus récent.
    pub fn list_restore_points(&self, doc_id: &str) -> AppResult<Vec<RestorePoint>> {
        let dossier = self.restore_dir(doc_id);
        let entrees = match std::fs::read_dir(&dossier) {
            Ok(entrees) => entrees,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(AppError::Storage(e)),
        };

        let mut points = Vec::new();
        for entree in entrees {
            let entree = entree?;
            let nom = entree.file_name();
            let Some(nom) = nom.to_str().and_then(|n| n.strip_suffix(".bin")) else {
                continue;
            };
            points.push(RestorePoint {
                id: nom.to_string(),
                size_bytes: entree.metadata().map(|m| m.len()).unwrap_or(0),
            });
        }

        points.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(points)
    }

    pub fn read_restore_point(&self, doc_id: &str, point_id: &str) -> AppResult<Vec<u8>> {
        // `point_id` vient du client : il ne doit jamais composer un chemin.
        if point_id.is_empty()
            || !point_id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
        {
            return Err(AppError::BadRequest(
                "point de restauration invalide".into(),
            ));
        }

        let chemin = self.restore_dir(doc_id).join(format!("{point_id}.bin"));
        let taille = std::fs::metadata(&chemin)
            .map_err(|e| match e.kind() {
                std::io::ErrorKind::NotFound => AppError::NotFound,
                _ => AppError::Storage(e),
            })?
            .len();
        if taille > MAX_SNAPSHOT_BYTES {
            return Err(AppError::PayloadTooLarge);
        }

        std::fs::read(&chemin).map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => AppError::NotFound,
            _ => AppError::Storage(e),
        })
    }
}

/// Découpe le journal cadré. Une trame tronquée par une coupure en cours
/// d'écriture arrête la lecture : les octets qui suivent, s'il y en a, ne sont
/// plus interprétables — mieux vaut perdre la dernière update que d'appliquer
/// n'importe quoi.
fn decode_journal(bytes: &[u8]) -> (Vec<Vec<u8>>, usize) {
    let mut updates = Vec::new();
    let mut position = 0usize;

    while position + 4 <= bytes.len() {
        let mut entete = [0u8; 4];
        entete.copy_from_slice(&bytes[position..position + 4]);
        let taille = u32::from_le_bytes(entete) as usize;
        position += 4;

        let Some(fin) = position.checked_add(taille) else {
            return (updates, 1);
        };
        if fin > bytes.len() {
            return (updates, 1);
        }
        updates.push(bytes[position..fin].to_vec());
        position = fin;
    }

    (updates, usize::from(position != bytes.len()))
}

fn truncate_if_exists(path: &Path) -> AppResult<()> {
    match std::fs::OpenOptions::new()
        .write(true)
        .truncate(true)
        .open(path)
    {
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(AppError::Storage(e)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_store() -> (FileStore, PathBuf) {
        let dir = std::env::temp_dir().join(format!("writer-store-{}", uuid::Uuid::now_v7()));
        (FileStore::new(&dir).expect("store"), dir)
    }

    #[test]
    fn le_journal_conserve_lordre_des_updates() {
        let (store, dir) = tmp_store();
        store.create("doc1", "{}").unwrap();
        store.append_update("doc1", b"premiere").unwrap();
        store.append_update("doc1", b"seconde").unwrap();

        let charge = store.load("doc1").unwrap();
        assert!(charge.snapshot.is_none());
        assert_eq!(
            charge.updates,
            vec![b"premiere".to_vec(), b"seconde".to_vec()]
        );
        assert_eq!(charge.corrupted, 0);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn linstantane_compacte_le_journal() {
        let (store, dir) = tmp_store();
        store.create("doc2", "{}").unwrap();
        store.append_update("doc2", b"une update").unwrap();
        store.write_snapshot("doc2", b"etat complet").unwrap();

        let charge = store.load("doc2").unwrap();
        assert_eq!(charge.snapshot.as_deref(), Some(&b"etat complet"[..]));
        assert!(
            charge.updates.is_empty(),
            "journal tronqué après compaction"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn une_trame_tronquee_est_ignoree_sans_condamner_le_document() {
        // Coupure pendant l'écriture : la dernière trame est incomplète. Le
        // document doit s'ouvrir quand même, avec l'anomalie annoncée.
        let (store, dir) = tmp_store();
        store.create("doc3", "{}").unwrap();
        store.append_update("doc3", b"complete").unwrap();

        let mut fichier = std::fs::OpenOptions::new()
            .append(true)
            .open(store.journal_path("doc3"))
            .unwrap();
        fichier.write_all(&99u32.to_le_bytes()).unwrap();
        fichier.write_all(b"tronquee").unwrap();

        let charge = store.load("doc3").unwrap();
        assert_eq!(charge.updates, vec![b"complete".to_vec()]);
        assert_eq!(charge.corrupted, 1, "l'anomalie est comptée, pas tue");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn un_document_de_lancien_format_reste_lisible() {
        // Sans cette reprise, un partage créé avant le passage au CRDT se
        // rouvrirait vide alors que son contenu est sur le disque.
        let (store, dir) = tmp_store();
        store.create("ancien", "{}").unwrap();
        std::fs::write(
            store.legacy_snapshot_path("ancien"),
            br#"{"revision":3,"document":{"blocks":[{"id":"p0","type":"paragraph","runs":[{"text":"vieux"}]}]}}"#,
        )
        .unwrap();
        std::fs::write(
            store.legacy_journal_path("ancien"),
            "{\"revision\":4,\"author\":\"alice\",\"op\":\"remove-block\",\"id\":\"p0\"}\n",
        )
        .unwrap();

        assert!(!store.has_crdt_state("ancien"));
        let ancien = store
            .load_legacy("ancien")
            .unwrap()
            .expect("document ancien");
        assert_eq!(ancien.snapshot.as_ref().map(|(r, _)| *r), Some(3));
        assert_eq!(ancien.operations.len(), 1);
        assert_eq!(ancien.operations[0].revision, 4);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn un_document_neuf_na_rien_a_reprendre() {
        let (store, dir) = tmp_store();
        store.create("neuf", "{}").unwrap();
        assert!(store.load_legacy("neuf").unwrap().is_none());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn un_jeton_de_session_ne_se_prend_quune_fois() {
        let (store, dir) = tmp_store();
        assert!(!store.session_exists("jeton-de-test"));
        store.create_session("jeton-de-test", "{}").unwrap();
        assert!(store.session_exists("jeton-de-test"));

        let rejeu = store.create_session("jeton-de-test", "{\"autre\":true}");
        assert!(matches!(rejeu, Err(AppError::Conflict(_))));
        assert_eq!(store.read_session("jeton-de-test").unwrap(), "{}");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn une_session_se_reecrit_sans_se_perdre() {
        let (store, dir) = tmp_store();
        store
            .create_session("jeton-partage-01", "{\"v\":1}")
            .unwrap();
        store
            .replace_session("jeton-partage-01", "{\"v\":2}")
            .unwrap();
        assert_eq!(store.read_session("jeton-partage-01").unwrap(), "{\"v\":2}");
        assert_eq!(store.list_sessions().unwrap(), vec!["jeton-partage-01"]);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn chaque_compaction_laisse_un_point_de_restauration() {
        let (store, dir) = tmp_store();
        store.create("doc4", "{}").unwrap();

        store.write_snapshot("doc4", b"etat 1").unwrap();
        store.write_snapshot("doc4", b"etat 2").unwrap();

        let points = store.list_restore_points("doc4").unwrap();
        assert_eq!(points.len(), 2);

        let ancien = store.read_restore_point("doc4", &points[0].id).unwrap();
        assert_eq!(ancien, b"etat 1", "l'état d'avant reste récupérable");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn les_points_de_restauration_tournent() {
        let (store, dir) = tmp_store();
        store.create("doc5", "{}").unwrap();
        for revision in 0..(MAX_RESTORE_POINTS + 5) {
            store
                .write_snapshot("doc5", format!("etat {revision}").as_bytes())
                .unwrap();
        }
        let points = store.list_restore_points("doc5").unwrap();
        assert!(points.len() <= MAX_RESTORE_POINTS + 1, "rotation appliquée");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn lidentifiant_dun_point_ne_peut_pas_sortir_du_document() {
        let (store, dir) = tmp_store();
        store.create("doc6", "{}").unwrap();
        assert!(store
            .read_restore_point("doc6", "../../etc/passwd")
            .is_err());
        assert!(store.read_restore_point("doc6", "point/../autre").is_err());
        assert!(store.read_restore_point("doc6", "").is_err());
        let _ = std::fs::remove_dir_all(dir);
    }
}
