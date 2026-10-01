// SPDX-License-Identifier: Apache-2.0 AND GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors
//
// Derivative work of Apache OpenOffice 4.1.16 (© The Apache Software Foundation,
// Apache License 2.0), modified: ported to Rust. See the NOTICE and
// LICENSE-APACHE files.

//! The replicated document in memory, plus the re-broadcast channel.
//!
//! The server is a **relay + log**, not a sequencer: it does not decide the order
//! of modifications, because the CRDT does not need one. Two concurrent updates
//! converge whatever order each replica applies them in, and this property, and
//! only this one, lets two people type in the same paragraph without erasing each
//! other.
//!
//! What the server keeps from its previous role is **durability**. The sequence is
//! still
//!
//!   validate → log (`fsync`) → re-broadcast
//!
//! Re-broadcasting before writing would risk a loss the peers would already have
//! displayed.
//!
//! The content itself is none of its business: it only handles opaque bytes. The
//! only routes that open the document go through `content.rs`, and they are all
//! optional.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::Value;
use tokio::sync::broadcast;
use uuid::Uuid;
use yrs::updates::decoder::Decode;
use yrs::updates::encoder::Encode;
use yrs::{Doc, ReadTxn, StateVector, Transact, Update};

use crate::content;
use crate::error::{AppError, AppResult};

/// A frame re-broadcast to the other clients of the same document.
#[derive(Clone, Debug)]
pub struct Fanout {
    /// Sending connection: it is not sent its own frame back.
    pub origin: u64,
    pub frame: Arc<Vec<u8>>,
    /// True when the frame carries a durable modification (and not presence).
    pub durable: bool,
}

pub struct DocHandle {
    pub id: Uuid,
    doc: Mutex<Doc>,
    pub tx: broadcast::Sender<Fanout>,
    updates_since_snapshot: AtomicUsize,
    /// Number of updates applied since the document was loaded.
    ///
    /// This is **not** a revision in the sense of the old sequencer: nothing depends on
    /// this number, no client announces it, and two replicas can perfectly well hold
    /// different values while carrying the same document. It only fills in the
    /// document's details and the observation feed.
    updates_total: AtomicU64,
    clients: AtomicUsize,
    /// Last presence announced by each connection, ready to be served to whoever
    /// arrives.
    ///
    /// Presence only travels when it changes. Without this registry, a newcomer would
    /// open a shared document on an empty participant list while three people are
    /// working on it, and would have to wait for each one's next announcement, up to
    /// fifteen seconds.
    ///
    /// The table is bounded by the number of simultaneous connections allowed
    /// (`MAX_CLIENTS_PER_DOCUMENT`): each entry leaves when its connection closes.
    presences: Mutex<HashMap<u64, Arc<Vec<u8>>>>,
    /// Occupancy counter, incremented on **every** arrival and every departure. See
    /// `occupancy`: it is what tells "the document stayed empty" apart from "someone
    /// came and went during the grace period".
    occupancy: AtomicU64,
    /// Is a hand-over to CloudServ already scheduled?
    ///
    /// Every keystroke goes through `schedule_checkpoint`: without this marker, a
    /// minute of typing would schedule hundreds of concurrent tasks, all projecting the
    /// same document only to duplicate each other. Only one waits, and it hands over the
    /// most recent state.
    checkpoint_scheduled: AtomicBool,
}

impl DocHandle {
    pub fn new(id: Uuid) -> Self {
        let (tx, _rx) = broadcast::channel(1024);
        Self {
            id,
            doc: Mutex::new(Doc::new()),
            tx,
            updates_since_snapshot: AtomicUsize::new(0),
            updates_total: AtomicU64::new(0),
            clients: AtomicUsize::new(0),
            presences: Mutex::new(HashMap::new()),
            occupancy: AtomicU64::new(0),
            checkpoint_scheduled: AtomicBool::new(false),
        }
    }

    /// Claims the right to schedule a hand-over. Returns `true` if the caller gets it,
    /// `false` if a task is already waiting.
    pub fn claim_checkpoint(&self) -> bool {
        !self.checkpoint_scheduled.swap(true, Ordering::AcqRel)
    }

    /// Gives the slot back once the hand-over has finished, successful or not.
    pub fn release_checkpoint(&self) {
        self.checkpoint_scheduled.store(false, Ordering::Release);
    }

    fn with_doc<T>(&self, f: impl FnOnce(&Doc) -> T) -> T {
        // A poisoned lock would mean a panic during a transaction: we recover the state
        // rather than spread the panic to the whole server. The other documents have
        // nothing to do with it.
        match self.doc.lock() {
            Ok(guard) => f(&guard),
            Err(poisoned) => f(&poisoned.into_inner()),
        }
    }

    /// Applies a CRDT update. Idempotent: replaying the log has no side effect, which
    /// makes reloading safe even after an interrupted compaction.
    pub fn apply_update(&self, bytes: &[u8]) -> AppResult<()> {
        let update = Update::decode_v1(bytes).map_err(|e| AppError::Crdt(e.to_string()))?;
        self.with_doc(|doc| {
            let mut txn = doc.transact_mut();
            txn.apply_update(update);
        });
        self.updates_total.fetch_add(1, Ordering::Relaxed);
        Ok(())
    }

    /// Seeds an **empty** document with JSON content.
    ///
    /// The result is an ordinary update: it then follows the same path as any
    /// keystroke. Seeding a document that is already filled would add a second copy
    /// of the content (a CRDT never replaces, it adds), hence the check on the
    /// caller's side (`content::is_seeded`).
    pub fn seed(&self, document: &Value) -> AppResult<Vec<u8>> {
        let update = content::seed_update(document)?;
        self.apply_update(&update)?;
        Ok(update)
    }

    pub fn is_seeded(&self) -> bool {
        self.with_doc(content::is_seeded)
    }

    pub fn state_vector(&self) -> Vec<u8> {
        self.with_doc(|doc| doc.transact().state_vector().encode_v1())
    }

    /// The difference to send to a peer that announces `client_sv` (SyncStep1).
    pub fn diff(&self, client_sv: &[u8]) -> AppResult<Vec<u8>> {
        let sv = StateVector::decode_v1(client_sv).map_err(|e| AppError::Crdt(e.to_string()))?;
        Ok(self.with_doc(|doc| doc.transact().encode_state_as_update_v1(&sv)))
    }

    /// The complete compacted state, for the snapshot and the restore points.
    pub fn full_state(&self) -> Vec<u8> {
        self.with_doc(|doc| {
            doc.transact()
                .encode_state_as_update_v1(&StateVector::default())
        })
    }

    /// The document projected to JSON, and the count of updates that produced it.
    pub fn snapshot(&self) -> (u64, Value) {
        // The count is read **under the lock**: outside it, an update could slip in
        // between reading the state and reading the number, and the observer would start
        // again from an inconsistent pair.
        self.with_doc(|doc| {
            (
                self.updates_total.load(Ordering::Acquire),
                content::project(doc),
            )
        })
    }

    pub fn revision(&self) -> u64 {
        self.updates_total.load(Ordering::Acquire)
    }

    pub fn title(&self) -> Option<String> {
        self.with_doc(content::title)
    }

    pub fn block_count(&self) -> usize {
        self.with_doc(content::block_count)
    }

    pub fn note_update(&self) -> usize {
        self.updates_since_snapshot.fetch_add(1, Ordering::Relaxed) + 1
    }

    pub fn reset_update_counter(&self) {
        self.updates_since_snapshot.store(0, Ordering::Relaxed);
    }

    /* ------------------------------------------------------------ presence */

    fn with_presences<T>(&self, f: impl FnOnce(&mut HashMap<u64, Arc<Vec<u8>>>) -> T) -> T {
        match self.presences.lock() {
            Ok(mut guard) => f(&mut guard),
            Err(poisoned) => f(&mut poisoned.into_inner()),
        }
    }

    /// Remembers the last presence of a connection (`awareness` payload).
    pub fn note_presence(&self, connection_id: u64, payload: Arc<Vec<u8>>) {
        self.with_presences(|map| {
            map.insert(connection_id, payload);
        });
    }

    /// Forgets a closed connection. Without this call, the next newcomer would be
    /// served the cursor of someone who has left.
    pub fn forget_presence(&self, connection_id: u64) {
        self.with_presences(|map| {
            map.remove(&connection_id);
        });
    }

    /// The known presences, except the caller's own.
    pub fn known_presences(&self, except: u64) -> Vec<Arc<Vec<u8>>> {
        self.with_presences(|map| {
            map.iter()
                .filter(|(id, _)| **id != except)
                .map(|(_, payload)| payload.clone())
                .collect()
        })
    }

    /* ------------------------------------------------------------- clients */

    pub fn client_joined(&self) -> usize {
        self.occupancy.fetch_add(1, Ordering::AcqRel);
        self.clients.fetch_add(1, Ordering::Relaxed) + 1
    }

    pub fn client_left(&self) -> usize {
        self.occupancy.fetch_add(1, Ordering::AcqRel);
        self.clients
            .fetch_sub(1, Ordering::Relaxed)
            .saturating_sub(1)
    }

    pub fn active_clients(&self) -> usize {
        self.clients.load(Ordering::Relaxed)
    }

    /// Marker of comings and goings: read it before waiting and compare it afterwards.
    ///
    /// A simple `active_clients() == 0` is not enough to decide that a document is
    /// abandoned: someone may have arrived **and left** during the grace period, which
    /// leaves the count at zero although the document was reopened in the meantime,
    /// and two concurrent closings would save it twice. This counter never goes back
    /// down: if its value has moved, the closing in progress is no longer the one that
    /// counts.
    pub fn occupancy(&self) -> u64 {
        self.occupancy.load(Ordering::Acquire)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use yrs::{GetString, Text};

    fn trame(texte: &str) -> Arc<Vec<u8>> {
        Arc::new(texte.as_bytes().to_vec())
    }

    /// The fundamental property expected from the relay: two clients that apply the
    /// same updates in different orders converge.
    ///
    /// This is exactly what the old block-operation sequencer could not guarantee: it
    /// needed an order, and two writes to the same block were reduced to the last one
    /// to arrive.
    #[test]
    fn les_updates_concurrentes_convergent() {
        let alice = Doc::new();
        let bob = Doc::new();
        let serveur = DocHandle::new(Uuid::now_v7());

        let update_a = {
            let text = alice.get_or_insert_text("corps");
            let mut txn = alice.transact_mut();
            text.insert(&mut txn, 0, "Bonjour ");
            txn.encode_update_v1()
        };
        let update_b = {
            let text = bob.get_or_insert_text("corps");
            let mut txn = bob.transact_mut();
            text.insert(&mut txn, 0, "le monde");
            txn.encode_update_v1()
        };

        // The server receives in one order, Alice and Bob in the other.
        serveur.apply_update(&update_a).unwrap();
        serveur.apply_update(&update_b).unwrap();
        {
            let mut txn = alice.transact_mut();
            txn.apply_update(Update::decode_v1(&update_b).unwrap());
        }
        {
            let mut txn = bob.transact_mut();
            txn.apply_update(Update::decode_v1(&update_a).unwrap());
        }

        let chez_alice = alice
            .get_or_insert_text("corps")
            .get_string(&alice.transact());
        let chez_bob = bob.get_or_insert_text("corps").get_string(&bob.transact());
        assert_eq!(chez_alice, chez_bob, "les deux répliques doivent converger");
    }

    #[test]
    fn un_instantane_recharge_rend_le_meme_contenu() {
        // Regression: when this path fails, the document looks empty after a restart even
        // though the data is on disk, a very confusing symptom.
        let source = DocHandle::new(Uuid::now_v7());
        source
            .seed(&json!({
                "id": "doc-1",
                "meta": { "title": "Notes de réunion" },
                "blocks": [{ "id": "p0", "type": "paragraph", "runs": [{ "text": "contenu à préserver" }] }]
            }))
            .unwrap();
        let instantane = source.full_state();

        let recharge = DocHandle::new(Uuid::now_v7());
        recharge
            .apply_update(&instantane)
            .expect("instantané applicable");

        let (_, relu) = recharge.snapshot();
        assert_eq!(relu["meta"]["title"], "Notes de réunion");
        assert_eq!(relu["blocks"][0]["runs"][0]["text"], "contenu à préserver");
        assert_eq!(recharge.title().as_deref(), Some("Notes de réunion"));
    }

    #[test]
    fn une_update_illisible_est_une_erreur_pas_un_panic() {
        let handle = DocHandle::new(Uuid::now_v7());
        assert!(handle.apply_update(&[0xff, 0xff, 0xff]).is_err());
    }

    #[test]
    fn un_document_neuf_nest_pas_amorce() {
        let handle = DocHandle::new(Uuid::now_v7());
        assert!(!handle.is_seeded());
        handle
            .seed(&json!({ "blocks": [{ "id": "p0", "runs": [{ "text": "x" }] }] }))
            .unwrap();
        assert!(handle.is_seeded());
    }

    #[test]
    fn larrivant_recoit_les_presences_deja_annoncees() {
        // Without this registry, we would have to wait for each person's next
        // announcement to see who is working on the document.
        let handle = DocHandle::new(Uuid::now_v7());
        handle.note_presence(1, trame("alice"));
        handle.note_presence(2, trame("bob"));

        let mut vues: Vec<Vec<u8>> = handle
            .known_presences(3)
            .iter()
            .map(|f| f.as_ref().clone())
            .collect();
        vues.sort();
        assert_eq!(vues, vec![b"alice".to_vec(), b"bob".to_vec()]);
    }

    #[test]
    fn on_ne_se_voit_pas_soi_meme_dans_laccueil() {
        let handle = DocHandle::new(Uuid::now_v7());
        handle.note_presence(1, trame("alice"));
        handle.note_presence(2, trame("bob"));

        let vues = handle.known_presences(1);
        assert_eq!(vues.len(), 1);
        assert_eq!(vues[0].as_ref(), b"bob");
    }

    #[test]
    fn une_connexion_fermee_ne_laisse_pas_de_curseur_fantome() {
        let handle = DocHandle::new(Uuid::now_v7());
        handle.note_presence(1, trame("alice"));
        handle.forget_presence(1);
        assert!(handle.known_presences(9).is_empty());
    }

    #[test]
    fn une_presence_renouvelee_remplace_la_precedente() {
        // The cursor moves: the newcomer must see the latest position, not the history of
        // announcements.
        let handle = DocHandle::new(Uuid::now_v7());
        handle.note_presence(1, trame("curseur en p1"));
        handle.note_presence(1, trame("curseur en p7"));

        let vues = handle.known_presences(9);
        assert_eq!(vues.len(), 1);
        assert_eq!(vues[0].as_ref(), b"curseur en p7");
    }
}
