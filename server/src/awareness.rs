// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors

//! Tracks who is present on a document (cursors, participant list).
//!
//! The server forwards presence frames without interpreting them, with one
//! exception: it needs to know **which participants belong to which connection**.
//! Without that, closing a browser tab leaves a "ghost" in the list of people
//! present ("5 people" for 2 connected), until the client side times it out, or
//! forever if the original client stays open in the background.
//!
//! Layout of an `awareness` payload (y-protocols):
//!   varuint  number of participants
//!   for each participant:
//!     varuint    client id
//!     varuint    clock
//!     varstring  JSON state ("null" = participant removed)

use crate::protocol::{write_var_u8array, write_varuint, Cursor};

/// One participant announced inside a presence frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AwarenessEntry {
    pub client_id: u64,
    pub clock: u64,
    /// `false` when the state is `null`: the participant removed themselves.
    pub present: bool,
}

/// Reads the participants out of a frame. Returns `None` if the frame is malformed.
pub fn parse_awareness(payload: &[u8]) -> Option<Vec<AwarenessEntry>> {
    let mut cursor = Cursor::new(payload);
    let count = cursor.read_varuint()?;

    // Safety limit: a frame claiming millions of participants is hostile or
    // corrupted, so we refuse it instead of allocating memory for it.
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

/// Builds the frame that removes the participants of a connection that just closed.
///
/// The clock is incremented on purpose: otherwise the other clients would treat
/// the removal as outdated information and keep the ghost.
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
        assert_eq!(parse_awareness(&[1]), None); // participant announced, then missing
        assert_eq!(parse_awareness(&[1, 42, 7, 200]), None); // declared length is larger than the buffer

        // A frame announcing an absurd number of participants.
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
