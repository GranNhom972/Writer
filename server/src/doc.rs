//! Document CRDT en mémoire + canal de rediffusion.
//!
//! Le serveur est un **relais + journal** (ADR-001) : il ne connaît pas le schéma
//! du document, seulement des updates CRDT opaques et convergentes.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

use tokio::sync::broadcast;
use uuid::Uuid;
use yrs::updates::decoder::Decode;
use yrs::updates::encoder::Encode;
use yrs::{Doc, ReadTxn, StateVector, Transact, Update};

use crate::error::{AppError, AppResult};

/// Trame rediffusée aux autres clients d'un même document.
#[derive(Clone, Debug)]
pub struct Fanout {
    /// Connexion émettrice : elle ne se voit pas rediffuser sa propre trame.
    pub origin: u64,
    pub frame: std::sync::Arc<Vec<u8>>,
}

pub struct DocHandle {
    pub id: Uuid,
    doc: Mutex<Doc>,
    pub tx: broadcast::Sender<Fanout>,
    updates_since_snapshot: AtomicUsize,
    clients: AtomicUsize,
}

impl DocHandle {
    pub fn new(id: Uuid) -> Self {
        let (tx, _rx) = broadcast::channel(1024);
        Self {
            id,
            doc: Mutex::new(Doc::new()),
            tx,
            updates_since_snapshot: AtomicUsize::new(0),
            clients: AtomicUsize::new(0),
        }
    }

    fn with_doc<T>(&self, f: impl FnOnce(&Doc) -> T) -> T {
        // Un mutex empoisonné signifierait un panic pendant une transaction :
        // on récupère l'état plutôt que de propager le panic à tout le serveur.
        match self.doc.lock() {
            Ok(guard) => f(&guard),
            Err(poisoned) => f(&poisoned.into_inner()),
        }
    }

    /// Accès en lecture au document, réservé aux projections optionnelles
    /// (`content.rs`). Le cœur du relais, lui, n'ouvre jamais le contenu.
    pub fn read<T>(&self, f: impl FnOnce(&Doc) -> T) -> T {
        self.with_doc(f)
    }

    /// Applique une update CRDT. Idempotent : rejouer le journal est sans effet de bord.
    pub fn apply_update(&self, bytes: &[u8]) -> AppResult<()> {
        let update = Update::decode_v1(bytes).map_err(|e| AppError::Crdt(e.to_string()))?;
        self.with_doc(|doc| {
            let mut txn = doc.transact_mut();
            txn.apply_update(update);
        });
        Ok(())
    }

    pub fn state_vector(&self) -> Vec<u8> {
        self.with_doc(|doc| doc.transact().state_vector().encode_v1())
    }

    /// Différentiel à envoyer à un pair qui annonce `client_sv` (SyncStep1).
    pub fn diff(&self, client_sv: &[u8]) -> AppResult<Vec<u8>> {
        let sv = StateVector::decode_v1(client_sv).map_err(|e| AppError::Crdt(e.to_string()))?;
        Ok(self.with_doc(|doc| doc.transact().encode_state_as_update_v1(&sv)))
    }

    /// État complet compacté — utilisé pour les snapshots et `GET /snapshot`.
    pub fn full_state(&self) -> Vec<u8> {
        self.with_doc(|doc| {
            doc.transact()
                .encode_state_as_update_v1(&StateVector::default())
        })
    }

    pub fn note_update(&self) -> usize {
        self.updates_since_snapshot.fetch_add(1, Ordering::Relaxed) + 1
    }

    pub fn reset_update_counter(&self) {
        self.updates_since_snapshot.store(0, Ordering::Relaxed);
    }

    pub fn client_joined(&self) -> usize {
        self.clients.fetch_add(1, Ordering::Relaxed) + 1
    }

    pub fn client_left(&self) -> usize {
        self.clients.fetch_sub(1, Ordering::Relaxed).saturating_sub(1)
    }

    pub fn active_clients(&self) -> usize {
        self.clients.load(Ordering::Relaxed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use yrs::{Text, GetString};

    /// Propriété fondamentale attendue du relais : deux clients qui appliquent les
    /// mêmes updates dans des ordres différents convergent vers le même état.
    #[test]
    fn concurrent_updates_converge() {
        let alice = Doc::new();
        let bob = Doc::new();
        let server = DocHandle::new(Uuid::now_v7());

        let a_update = {
            let text = alice.get_or_insert_text("body");
            let mut txn = alice.transact_mut();
            text.insert(&mut txn, 0, "Bonjour ");
            txn.encode_update_v1()
        };
        let b_update = {
            let text = bob.get_or_insert_text("body");
            let mut txn = bob.transact_mut();
            text.insert(&mut txn, 0, "le monde");
            txn.encode_update_v1()
        };

        // Le serveur reçoit dans un ordre, Alice et Bob dans l'autre.
        server.apply_update(&a_update).unwrap();
        server.apply_update(&b_update).unwrap();

        {
            let mut txn = alice.transact_mut();
            let _ = txn.apply_update(Update::decode_v1(&b_update).unwrap());
        }
        {
            let mut txn = bob.transact_mut();
            let _ = txn.apply_update(Update::decode_v1(&a_update).unwrap());
        }

        let a_text = alice.get_or_insert_text("body").get_string(&alice.transact());
        let b_text = bob.get_or_insert_text("body").get_string(&bob.transact());
        assert_eq!(a_text, b_text, "les deux clients doivent converger");
    }

    #[test]
    fn un_instantane_recharge_rend_le_meme_contenu() {
        // Régression : un instantané doit se recharger tel quel. Quand ce chemin
        // échoue, le document paraît vide après un redémarrage alors que les
        // données sont bien sur le disque — symptôme très déroutant.
        let source = Doc::new();
        {
            let texte = source.get_or_insert_text("body");
            let mut txn = source.transact_mut();
            texte.insert(&mut txn, 0, "Notes de réunion et contenu à préserver");
        }
        let instantane = source
            .transact()
            .encode_state_as_update_v1(&StateVector::default());

        let recharge = DocHandle::new(Uuid::now_v7());
        recharge.apply_update(&instantane).expect("instantané applicable");

        let etat = recharge.full_state();
        assert!(etat.len() >= instantane.len() / 2, "état rechargé quasi vide");
        assert!(
            String::from_utf8_lossy(&etat).contains("Notes de réunion"),
            "le texte doit survivre au rechargement",
        );
    }

    #[test]
    fn malformed_update_is_an_error_not_a_panic() {
        let handle = DocHandle::new(Uuid::now_v7());
        assert!(handle.apply_update(&[0xff, 0xff, 0xff]).is_err());
    }
}
