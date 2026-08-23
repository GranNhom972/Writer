//! Persistance : journal append-only + snapshots compactés.
//!
//! Corrige le défaut majeur de la v1 (« tout en RAM, flush à la déconnexion du
//! dernier client ») : la durabilité ne dépend d'aucun événement de déconnexion.
//! Ordre imposé par la directive : valider → **journaliser** → rediffuser → acquitter.
//!
//! Cette implémentation est un `FileStore` (fichiers locaux). L'adaptateur
//! Postgres décrit dans integration_api_rust.md §4 implémentera le même contrat.

use std::io::Write;
use std::path::{Path, PathBuf};

use crate::error::{AppError, AppResult};

/// Nombre d'updates journalisées avant compaction en snapshot.
pub const COMPACTION_THRESHOLD: usize = 500;

/// Points de restauration conservés par document.
pub const MAX_RESTORE_POINTS: usize = 20;

/// Un état daté du document, conservé après compaction.
#[derive(Debug, Clone, serde::Serialize)]
pub struct RestorePoint {
    /// Horodatage servant d'identifiant (`20260823T151530.123`).
    pub id: String,
    pub size_bytes: u64,
}

pub struct FileStore {
    root: PathBuf,
}

#[derive(Debug, Default)]
pub struct LoadedDocument {
    /// Snapshot compacté (update CRDT complète) s'il existe.
    pub snapshot: Option<Vec<u8>>,
    /// Updates journalisées postérieures au snapshot, dans l'ordre d'arrivée.
    pub updates: Vec<Vec<u8>>,
}

impl FileStore {
    pub fn new(root: impl Into<PathBuf>) -> AppResult<Self> {
        let root = root.into();
        std::fs::create_dir_all(&root)?;
        Ok(Self { root })
    }

    fn dir(&self, doc_id: &str) -> PathBuf {
        // `doc_id` est un UUID validé en amont : il ne provient jamais brut du client
        // (pas de path traversal possible, cf. directive sécurité).
        self.root.join(doc_id)
    }

    fn journal_path(&self, doc_id: &str) -> PathBuf {
        self.dir(doc_id).join("journal.bin")
    }

    fn snapshot_path(&self, doc_id: &str) -> PathBuf {
        self.dir(doc_id).join("snapshot.bin")
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

    /// Ajoute une update au journal durable. `fsync` avant retour : c'est ce qui
    /// autorise l'ACK `durable: true` envoyé au client.
    pub fn append_update(&self, doc_id: &str, update: &[u8]) -> AppResult<usize> {
        std::fs::create_dir_all(self.dir(doc_id))?;
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.journal_path(doc_id))?;

        // Cadrage longueur (u32 LE) + charge utile.
        let len = u32::try_from(update.len()).map_err(|_| AppError::PayloadTooLarge)?;
        file.write_all(&len.to_le_bytes())?;
        file.write_all(update)?;
        file.flush()?;
        file.sync_data()?;

        Ok(self.count_updates(doc_id).unwrap_or(0))
    }

    fn count_updates(&self, doc_id: &str) -> AppResult<usize> {
        Ok(self.load(doc_id)?.updates.len())
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

        Ok(LoadedDocument {
            snapshot,
            updates: decode_journal(&journal),
        })
    }

    // ── Images d'en-tête et de pied ──────────────────────────────────────────

    fn assets_dir(&self, doc_id: &str) -> PathBuf {
        self.dir(doc_id).join("assets")
    }

    /// `name` a traversé `assets::parse_asset_name` : c'est un UUID suivi d'une
    /// extension connue, fabriqué par le serveur. Aucun segment de chemin ne peut
    /// s'y trouver — c'est ce qui rend cette jointure sûre.
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

    // ── Sessions ─────────────────────────────────────────────────────────────
    //
    // Une session vit à part des documents : son identifiant (`token_session`) est
    // fourni par le client, alors qu'un `doc_id` est généré par le serveur. Les
    // mélanger dans la même arborescence rendrait `list()` dépendant d'une entrée
    // dont le nom vient du dehors.

    fn sessions_dir(&self) -> PathBuf {
        self.root.join("_sessions")
    }

    fn session_path(&self, token_session: &str) -> PathBuf {
        // `token_session` est validé en amont (`session::valid_token`) : caractères
        // alphanumériques, `-` et `_` uniquement. Aucun `/` ni `..` ne peut arriver ici.
        self.sessions_dir().join(format!("{token_session}.json"))
    }

    pub fn session_exists(&self, token_session: &str) -> bool {
        self.session_path(token_session).is_file()
    }

    /// Crée la session. Échoue si elle existe déjà — c'est la vérification d'unicité
    /// (étape 2 du protocole) exprimée là où elle est atomique : dans le système de
    /// fichiers. Un `exists()` suivi d'un `write()` laisserait une fenêtre de course.
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

    pub fn read_session(&self, token_session: &str) -> AppResult<String> {
        std::fs::read_to_string(self.session_path(token_session)).map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => AppError::NotFound,
            _ => AppError::Storage(e),
        })
    }

    /// Retire une session. Sert au rattrapage : si le document n'a pas pu être créé
    /// après la prise du jeton, laisser la session en place condamnerait ce jeton.
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

    /// Écrit un snapshot compacté puis tronque le journal.
    /// L'ordre importe : snapshot d'abord, journal ensuite — un crash entre les deux
    /// rejoue au pire des updates déjà incluses, ce que le CRDT absorbe (idempotence).
    pub fn write_snapshot(&self, doc_id: &str, state: &[u8]) -> AppResult<()> {
        std::fs::create_dir_all(self.dir(doc_id))?;
        let tmp = self.dir(doc_id).join("snapshot.bin.tmp");
        std::fs::write(&tmp, state)?;
        std::fs::rename(&tmp, self.snapshot_path(doc_id))?;

        // Le snapshot précédent est conservé comme point de restauration : sans
        // cela, une suppression massive devient définitive dès la compaction
        // suivante — le journal qui la contredisait ayant été tronqué.
        self.keep_restore_point(doc_id, state)?;

        truncate_if_exists(&self.journal_path(doc_id))?;
        Ok(())
    }

    /// Conserve un état daté, et ne garde que les plus récents.
    fn keep_restore_point(&self, doc_id: &str, state: &[u8]) -> AppResult<()> {
        let dossier = self.restore_dir(doc_id);
        std::fs::create_dir_all(&dossier)?;

        // Identifiant unique : deux compactions dans la même milliseconde
        // produiraient sinon le même nom, et l'une écraserait l'autre — le point
        // de restauration le plus ancien disparaîtrait sans bruit.
        let horodatage = chrono::Utc::now().format("%Y%m%dT%H%M%S%.6f").to_string();
        let mut chemin = dossier.join(format!("{horodatage}.bin"));
        let mut suffixe = 1;
        while chemin.exists() && suffixe < 100 {
            chemin = dossier.join(format!("{horodatage}-{suffixe}.bin"));
            suffixe += 1;
        }
        std::fs::write(chemin, state)?;

        // Rotation : les points les plus anciens disparaissent.
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
        if !point_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-') {
            return Err(AppError::BadRequest("point de restauration invalide".into()));
        }

        std::fs::read(self.restore_dir(doc_id).join(format!("{point_id}.bin"))).map_err(|e| {
            match e.kind() {
                std::io::ErrorKind::NotFound => AppError::NotFound,
                _ => AppError::Storage(e),
            }
        })
    }
}

fn truncate_if_exists(path: &Path) -> AppResult<()> {
    match std::fs::OpenOptions::new().write(true).truncate(true).open(path) {
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(AppError::Storage(e)),
    }
}

/// Relit un journal cadré. Une entrée tronquée (crash en cours d'écriture) est
/// ignorée : on préfère perdre la dernière update non acquittée que refuser le doc.
fn decode_journal(buf: &[u8]) -> Vec<Vec<u8>> {
    let mut out = Vec::new();
    let mut pos = 0usize;
    while pos + 4 <= buf.len() {
        let len = u32::from_le_bytes([buf[pos], buf[pos + 1], buf[pos + 2], buf[pos + 3]]) as usize;
        pos += 4;
        let Some(chunk) = buf.get(pos..pos + len) else {
            break;
        };
        out.push(chunk.to_vec());
        pos += len;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_store() -> (FileStore, PathBuf) {
        let dir = std::env::temp_dir().join(format!("write-store-{}", uuid::Uuid::now_v7()));
        (FileStore::new(&dir).expect("store"), dir)
    }

    #[test]
    fn append_then_load_preserves_order() {
        let (store, dir) = tmp_store();
        store.create("doc1", "{}").unwrap();
        store.append_update("doc1", b"aaa").unwrap();
        store.append_update("doc1", b"bb").unwrap();

        let loaded = store.load("doc1").unwrap();
        assert!(loaded.snapshot.is_none());
        assert_eq!(loaded.updates, vec![b"aaa".to_vec(), b"bb".to_vec()]);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn snapshot_compacts_journal() {
        let (store, dir) = tmp_store();
        store.create("doc2", "{}").unwrap();
        store.append_update("doc2", b"x").unwrap();
        store.write_snapshot("doc2", b"STATE").unwrap();

        let loaded = store.load("doc2").unwrap();
        assert_eq!(loaded.snapshot.as_deref(), Some(&b"STATE"[..]));
        assert!(loaded.updates.is_empty(), "journal tronqué après snapshot");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn session_token_can_only_be_claimed_once() {
        let (store, dir) = tmp_store();
        assert!(!store.session_exists("jeton-de-test"));
        store.create_session("jeton-de-test", "{}").unwrap();
        assert!(store.session_exists("jeton-de-test"));

        // Étape 2 du protocole : rejouer la création doit échouer, pas écraser.
        let rejeu = store.create_session("jeton-de-test", "{\"autre\":true}");
        assert!(matches!(rejeu, Err(AppError::Conflict(_))));
        assert_eq!(store.read_session("jeton-de-test").unwrap(), "{}");
        assert_eq!(store.list_sessions().unwrap(), vec!["jeton-de-test".to_string()]);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn snapshot_leaves_a_restore_point() {
        // Sans point de restauration, une suppression massive devient définitive
        // dès la compaction : le journal qui la contredisait est tronqué.
        let (store, dir) = tmp_store();
        store.create("doc3", "{}").unwrap();

        store.write_snapshot("doc3", b"ETAT-AVANT").unwrap();
        store.write_snapshot("doc3", b"ETAT-VIDE").unwrap();

        let points = store.list_restore_points("doc3").unwrap();
        assert_eq!(points.len(), 2, "chaque compaction laisse une trace");

        let ancien = store.read_restore_point("doc3", &points[0].id).unwrap();
        assert_eq!(ancien, b"ETAT-AVANT", "l'état d'avant reste récupérable");

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn restore_points_are_capped() {
        let (store, dir) = tmp_store();
        store.create("doc4", "{}").unwrap();

        for i in 0..(MAX_RESTORE_POINTS + 5) {
            store.write_snapshot("doc4", format!("etat-{i}").as_bytes()).unwrap();
        }

        let points = store.list_restore_points("doc4").unwrap();
        assert!(points.len() <= MAX_RESTORE_POINTS + 1, "rotation appliquée : {}", points.len());

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn restore_point_id_cannot_escape_the_document() {
        // L'identifiant vient du client : il ne doit jamais composer un chemin.
        let (store, dir) = tmp_store();
        store.create("doc5", "{}").unwrap();

        assert!(store.read_restore_point("doc5", "../../etc/passwd").is_err());
        assert!(store.read_restore_point("doc5", "point/../autre").is_err());

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn truncated_journal_entry_is_ignored() {
        // 4 octets de longueur annonçant 10 octets, mais seulement 2 présents.
        let mut buf = 10u32.to_le_bytes().to_vec();
        buf.extend_from_slice(b"ab");
        assert!(decode_journal(&buf).is_empty());
    }
}
