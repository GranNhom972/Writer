//! Document répliqué en mémoire + canal de rediffusion.
//!
//! Le serveur est un **relais + journal**, et non un séquenceur : il ne décide
//! pas de l'ordre des modifications, parce que le CRDT n'en a pas besoin. Deux
//! updates concurrentes convergent quel que soit l'ordre dans lequel chaque
//! réplique les applique, et c'est cette propriété — et elle seule — qui permet
//! à deux personnes d'écrire dans le même paragraphe sans s'effacer.
//!
//! Ce que le serveur garde de son rôle précédent : la **durabilité**. La
//! séquence reste
//!
//!   valider → journaliser (`fsync`) → rediffuser
//!
//! Rediffuser avant d'écrire exposerait à une perte que les pairs auraient déjà
//! affichée.
//!
//! Le contenu, lui, ne le regarde pas : il ne manipule que des octets opaques.
//! Les seules routes qui ouvrent le document passent par `content.rs`, et elles
//! sont toutes optionnelles.

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

/// Trame rediffusée aux autres clients d'un même document.
#[derive(Clone, Debug)]
pub struct Fanout {
    /// Connexion émettrice : elle ne se voit pas rediffuser sa propre trame.
    pub origin: u64,
    pub frame: Arc<Vec<u8>>,
    /// Vrai quand la trame porte une modification durable (et non de la présence).
    pub durable: bool,
}

pub struct DocHandle {
    pub id: Uuid,
    doc: Mutex<Doc>,
    pub tx: broadcast::Sender<Fanout>,
    updates_since_snapshot: AtomicUsize,
    /// Nombre d'updates appliquées depuis le chargement.
    ///
    /// Ce n'est **pas** une révision au sens de l'ancien séquenceur : rien ne
    /// dépend de ce numéro, aucun client ne l'annonce, et deux répliques peuvent
    /// parfaitement l'avoir différent tout en portant le même document. Il ne
    /// sert qu'à renseigner la fiche du document et le flux d'observation.
    updates_total: AtomicU64,
    clients: AtomicUsize,
    /// Dernière présence annoncée par chaque connexion, prête à être servie à
    /// qui arrive.
    ///
    /// La présence ne circule qu'au moment où elle change. Sans ce registre, un
    /// arrivant ouvrirait un document partagé sur une liste de participants vide
    /// alors que trois personnes y travaillent, et devrait attendre la
    /// prochaine annonce de chacune — jusqu'à quinze secondes.
    ///
    /// La table est bornée par le nombre de connexions simultanées autorisées
    /// (`MAX_CLIENTS_PER_DOCUMENT`) : chaque entrée part à la fermeture.
    presences: Mutex<HashMap<u64, Arc<Vec<u8>>>>,
    /// Compteur d'occupation, incrémenté à **chaque** arrivée et à chaque
    /// départ. Voir `occupancy` : c'est lui qui distingue « le document est
    /// resté vide » de « quelqu'un est passé pendant le délai de grâce ».
    occupancy: AtomicU64,
    /// Un déchargement vers CloudServ est-il déjà programmé ?
    ///
    /// Chaque frappe passe par `schedule_checkpoint` : sans ce témoin, une
    /// minute de saisie programmerait des centaines de tâches concurrentes, qui
    /// projetteraient toutes le même document pour se doubler les unes les
    /// autres. Une seule attend, et elle décharge l'état le plus récent.
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

    /// Réserve le droit de programmer un déchargement. Rend `true` si l'appelant
    /// l'obtient, `false` si une tâche veille déjà.
    pub fn claim_checkpoint(&self) -> bool {
        !self.checkpoint_scheduled.swap(true, Ordering::AcqRel)
    }

    /// Rend la place, une fois le déchargement terminé — abouti ou non.
    pub fn release_checkpoint(&self) {
        self.checkpoint_scheduled.store(false, Ordering::Release);
    }

    fn with_doc<T>(&self, f: impl FnOnce(&Doc) -> T) -> T {
        // Un verrou empoisonné signifierait un panic pendant une transaction :
        // on récupère l'état plutôt que de propager le panic à tout le serveur.
        // Les autres documents n'y sont pour rien.
        match self.doc.lock() {
            Ok(guard) => f(&guard),
            Err(poisoned) => f(&poisoned.into_inner()),
        }
    }

    /// Applique une update CRDT. Idempotent : rejouer le journal est sans effet
    /// de bord, ce qui rend le rechargement sûr même après une compaction
    /// interrompue.
    pub fn apply_update(&self, bytes: &[u8]) -> AppResult<()> {
        let update = Update::decode_v1(bytes).map_err(|e| AppError::Crdt(e.to_string()))?;
        self.with_doc(|doc| {
            let mut txn = doc.transact_mut();
            txn.apply_update(update);
        });
        self.updates_total.fetch_add(1, Ordering::Relaxed);
        Ok(())
    }

    /// Amorce un document **vide** avec un contenu JSON.
    ///
    /// Le résultat est une update ordinaire : elle suit ensuite le même chemin
    /// que n'importe quelle frappe. Amorcer un document déjà rempli y
    /// ajouterait un second exemplaire du contenu — un CRDT ne remplace jamais,
    /// il ajoute — d'où le contrôle chez l'appelant (`content::is_seeded`).
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

    /// Différentiel à envoyer à un pair qui annonce `client_sv` (SyncStep1).
    pub fn diff(&self, client_sv: &[u8]) -> AppResult<Vec<u8>> {
        let sv = StateVector::decode_v1(client_sv).map_err(|e| AppError::Crdt(e.to_string()))?;
        Ok(self.with_doc(|doc| doc.transact().encode_state_as_update_v1(&sv)))
    }

    /// État complet compacté — pour l'instantané et les points de restauration.
    pub fn full_state(&self) -> Vec<u8> {
        self.with_doc(|doc| {
            doc.transact()
                .encode_state_as_update_v1(&StateVector::default())
        })
    }

    /// Le document, projeté en JSON, et le compte d'updates qui l'a produit.
    pub fn snapshot(&self) -> (u64, Value) {
        // Le compte est lu **sous le verrou** : hors de lui, une update
        // pourrait s'intercaler entre la lecture de l'état et celle du numéro,
        // et l'observateur repartirait d'un couple incohérent.
        self.with_doc(|doc| (self.updates_total.load(Ordering::Acquire), content::project(doc)))
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

    /* ------------------------------------------------------------ présence */

    fn with_presences<T>(&self, f: impl FnOnce(&mut HashMap<u64, Arc<Vec<u8>>>) -> T) -> T {
        match self.presences.lock() {
            Ok(mut guard) => f(&mut guard),
            Err(poisoned) => f(&mut poisoned.into_inner()),
        }
    }

    /// Retient la dernière présence d'une connexion (charge utile `awareness`).
    pub fn note_presence(&self, connection_id: u64, payload: Arc<Vec<u8>>) {
        self.with_presences(|map| {
            map.insert(connection_id, payload);
        });
    }

    /// Oublie une connexion fermée. Sans cet appel, l'arrivant suivant se
    /// verrait servir le curseur de quelqu'un qui est parti.
    pub fn forget_presence(&self, connection_id: u64) {
        self.with_presences(|map| {
            map.remove(&connection_id);
        });
    }

    /// Les présences connues, hors celle de l'appelant.
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
        self.clients.fetch_sub(1, Ordering::Relaxed).saturating_sub(1)
    }

    pub fn active_clients(&self) -> usize {
        self.clients.load(Ordering::Relaxed)
    }

    /// Témoin de va-et-vient, à relever avant d'attendre et à comparer après.
    ///
    /// Un simple `active_clients() == 0` ne suffit pas à décider qu'un document
    /// est abandonné : quelqu'un peut être arrivé **et reparti** pendant le
    /// délai de grâce, ce qui laisse le compte à zéro alors que le document a
    /// été rouvert entre-temps — et deux fermetures concurrentes le
    /// sauvegarderaient deux fois. Ce compteur ne redescend jamais : si sa
    /// valeur a bougé, la fermeture en cours n'est plus celle qui fait foi.
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

    /// La propriété fondamentale attendue du relais : deux clients qui
    /// appliquent les mêmes updates dans des ordres différents convergent.
    ///
    /// C'est exactement ce que l'ancien séquenceur d'opérations de blocs ne
    /// pouvait pas garantir : il fallait un ordre, et deux écritures sur le
    /// même bloc se réduisaient à la dernière arrivée.
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

        // Le serveur reçoit dans un ordre, Alice et Bob dans l'autre.
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

        let chez_alice = alice.get_or_insert_text("corps").get_string(&alice.transact());
        let chez_bob = bob.get_or_insert_text("corps").get_string(&bob.transact());
        assert_eq!(chez_alice, chez_bob, "les deux répliques doivent converger");
    }

    #[test]
    fn un_instantane_recharge_rend_le_meme_contenu() {
        // Régression : quand ce chemin échoue, le document paraît vide après un
        // redémarrage alors que les données sont bien sur le disque — symptôme
        // très déroutant.
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
        recharge.apply_update(&instantane).expect("instantané applicable");

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
        // Sans ce registre, il faudrait attendre la prochaine annonce de chacun
        // pour voir qui travaille sur le document.
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
        // Le curseur bouge : l'arrivant doit voir la dernière position, pas
        // l'historique des annonces.
        let handle = DocHandle::new(Uuid::now_v7());
        handle.note_presence(1, trame("curseur en p1"));
        handle.note_presence(1, trame("curseur en p7"));

        let vues = handle.known_presences(9);
        assert_eq!(vues.len(), 1);
        assert_eq!(vues[0].as_ref(), b"curseur en p7");
    }
}
