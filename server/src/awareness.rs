//! Cycle de vie des présences (curseurs, participants).
//!
//! Le serveur relaie les trames de présence sans les interpréter… sauf pour une
//! chose : savoir **quels participants appartiennent à quelle connexion**. Sans
//! cela, la fermeture d'un onglet laisse un fantôme dans la liste des présents
//! (« 5 personnes » pour 2 connectés), jusqu'à l'expiration côté client — et pas
//! du tout si le client d'origine reste ouvert en arrière-plan.
//!
//! Format d'une charge utile `awareness` (y-protocols) :
//!   varuint  nombre de participants
//!   pour chacun :
//!     varuint  identifiant de client
//!     varuint  horloge
//!     varstring  état JSON (« null » = participant retiré)

use crate::protocol::{write_var_u8array, write_varuint, Cursor};

/// Un participant annoncé dans une trame de présence.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AwarenessEntry {
    pub client_id: u64,
    pub clock: u64,
    /// `false` quand l'état vaut `null` : le participant s'est retiré lui-même.
    pub present: bool,
}

/// Lit les participants d'une trame. `None` si la trame est malformée.
pub fn parse_awareness(payload: &[u8]) -> Option<Vec<AwarenessEntry>> {
    let mut cursor = Cursor::new(payload);
    let count = cursor.read_varuint()?;

    // Garde-fou : une trame annonçant des millions de participants est hostile
    // ou corrompue ; on refuse plutôt que d'allouer.
    if count > 10_000 {
        return None;
    }

    let mut entries = Vec::with_capacity(count as usize);
    for _ in 0..count {
        let client_id = cursor.read_varuint()?;
        let clock = cursor.read_varuint()?;
        let state = cursor.read_var_u8array()?;
        entries.push(AwarenessEntry {
            client_id,
            clock,
            present: state != b"null",
        });
    }
    Some(entries)
}

/// Construit la trame retirant les participants d'une connexion fermée.
///
/// L'horloge est incrémentée : sans cela, les pairs considéreraient l'information
/// comme périmée et conserveraient le fantôme.
pub fn encode_removals(entries: &[(u64, u64)]) -> Vec<u8> {
    let mut payload = Vec::new();
    write_varuint(&mut payload, entries.len() as u64);
    for (client_id, clock) in entries {
        write_varuint(&mut payload, *client_id);
        write_varuint(&mut payload, clock.saturating_add(1));
        write_var_u8array(&mut payload, b"null");
    }
    payload
}

#[cfg(test)]
mod tests {
    use super::*;

    fn encode_state(client_id: u64, clock: u64, state: &[u8]) -> Vec<u8> {
        let mut payload = Vec::new();
        write_varuint(&mut payload, 1);
        write_varuint(&mut payload, client_id);
        write_varuint(&mut payload, clock);
        write_var_u8array(&mut payload, state);
        payload
    }

    #[test]
    fn reads_a_single_participant() {
        let payload = encode_state(42, 7, br#"{"user":{"name":"alice"}}"#);
        assert_eq!(
            parse_awareness(&payload),
            Some(vec![AwarenessEntry {
                client_id: 42,
                clock: 7,
                present: true
            }])
        );
    }

    #[test]
    fn recognises_self_removal() {
        let payload = encode_state(42, 8, b"null");
        let entries = parse_awareness(&payload).expect("trame lisible");
        assert!(!entries[0].present, "un état null retire le participant");
    }

    #[test]
    fn reads_several_participants() {
        let mut payload = Vec::new();
        write_varuint(&mut payload, 2);
        for (id, clock) in [(1u64, 1u64), (300, 5)] {
            write_varuint(&mut payload, id);
            write_varuint(&mut payload, clock);
            write_var_u8array(&mut payload, b"{}");
        }
        let entries = parse_awareness(&payload).expect("trame lisible");
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[1].client_id, 300);
    }

    #[test]
    fn rejects_malformed_frames_without_panicking() {
        assert_eq!(parse_awareness(&[]), None);
        assert_eq!(parse_awareness(&[1]), None); // participant annoncé, absent
        assert_eq!(parse_awareness(&[1, 42, 7, 200]), None); // longueur > tampon

        // Trame annonçant un nombre absurde de participants.
        let mut hostile = Vec::new();
        write_varuint(&mut hostile, 5_000_000);
        assert_eq!(parse_awareness(&hostile), None);
    }

    #[test]
    fn removal_frame_is_readable_and_increments_the_clock() {
        let payload = encode_removals(&[(42, 7), (43, 0)]);
        let entries = parse_awareness(&payload).expect("trame lisible");

        assert_eq!(entries.len(), 2);
        assert_eq!(
            entries[0],
            AwarenessEntry {
                client_id: 42,
                clock: 8,
                present: false
            }
        );
        assert_eq!(
            entries[1],
            AwarenessEntry {
                client_id: 43,
                clock: 1,
                present: false
            }
        );
    }

    #[test]
    fn removal_frame_is_empty_when_nothing_to_remove() {
        let entries = parse_awareness(&encode_removals(&[])).expect("trame lisible");
        assert!(entries.is_empty());
    }
}
