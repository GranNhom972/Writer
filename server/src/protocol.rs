// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors

//! Encoding and decoding of `y-protocols` messages (lib0).
//!
//! Frames are **binary**. lib0 layout:
//!   varuint  messageType        0 = sync, 1 = awareness, 3 = queryAwareness
//!   sync ->  varuint subType    0 = SyncStep1, 1 = SyncStep2, 2 = Update
//!            varuint8array      payload (state vector or CRDT update)
//!   awareness -> varuint8array  opaque payload (relayed as-is, never logged)
//!   queryAwareness -> nothing   asks for the list of people present

pub const MSG_SYNC: u64 = 0;
pub const MSG_AWARENESS: u64 = 1;
/// `y-websocket` sends this when it connects, to learn who is already there. The
/// relay of the Write application ignored it, so a newcomer had to wait up to
/// fifteen seconds for everyone to announce themselves again.
pub const MSG_QUERY_AWARENESS: u64 = 3;

pub const SYNC_STEP1: u64 = 0;
pub const SYNC_STEP2: u64 = 1;
pub const SYNC_UPDATE: u64 = 2;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Message {
    /// The peer announces its state vector and asks for the difference.
    SyncStep1(Vec<u8>),
    /// Answer to a SyncStep1: an update that covers the difference.
    SyncStep2(Vec<u8>),
    /// An incremental CRDT update.
    Update(Vec<u8>),
    /// Presence (cursors, selections). Ephemeral.
    Awareness(Vec<u8>),
    /// "Who is here?": the peer asks for the presence state the server knows.
    QueryAwareness,
}

pub fn write_varuint(out: &mut Vec<u8>, mut n: u64) {
    loop {
        let mut byte = (n & 0x7f) as u8;
        n >>= 7;
        if n > 0 {
            byte |= 0x80;
            out.push(byte);
        } else {
            out.push(byte);
            break;
        }
    }
}

pub fn write_var_u8array(out: &mut Vec<u8>, payload: &[u8]) {
    write_varuint(out, payload.len() as u64);
    out.extend_from_slice(payload);
}

pub struct Cursor<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Cursor<'a> {
    pub fn new(buf: &'a [u8]) -> Self {
        Self { buf, pos: 0 }
    }

    pub fn read_varuint(&mut self) -> Option<u64> {
        let mut result: u64 = 0;
        let mut shift = 0u32;
        loop {
            let byte = *self.buf.get(self.pos)?;
            self.pos += 1;
            result |= ((byte & 0x7f) as u64).checked_shl(shift)?;
            if byte & 0x80 == 0 {
                return Some(result);
            }
            shift += 7;
            if shift > 63 {
                return None; // malformed varint: refuse instead of panicking
            }
        }
    }

    pub fn read_var_u8array(&mut self) -> Option<&'a [u8]> {
        let len = self.read_varuint()? as usize;
        let end = self.pos.checked_add(len)?;
        let slice = self.buf.get(self.pos..end)?;
        self.pos = end;
        Some(slice)
    }
}

impl Message {
    /// Decodes an incoming frame. `None` means the frame is malformed or of an
    /// unsupported type: we ignore it silently rather than close the session of an
    /// honest client.
    pub fn decode(frame: &[u8]) -> Option<Message> {
        let mut cur = Cursor::new(frame);
        match cur.read_varuint()? {
            MSG_SYNC => {
                let sub = cur.read_varuint()?;
                let payload = cur.read_var_u8array()?.to_vec();
                match sub {
                    SYNC_STEP1 => Some(Message::SyncStep1(payload)),
                    SYNC_STEP2 => Some(Message::SyncStep2(payload)),
                    SYNC_UPDATE => Some(Message::Update(payload)),
                    _ => None,
                }
            }
            MSG_AWARENESS => Some(Message::Awareness(cur.read_var_u8array()?.to_vec())),
            MSG_QUERY_AWARENESS => Some(Message::QueryAwareness),
            _ => None,
        }
    }

    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::new();
        match self {
            Message::SyncStep1(p) => {
                write_varuint(&mut out, MSG_SYNC);
                write_varuint(&mut out, SYNC_STEP1);
                write_var_u8array(&mut out, p);
            }
            Message::SyncStep2(p) => {
                write_varuint(&mut out, MSG_SYNC);
                write_varuint(&mut out, SYNC_STEP2);
                write_var_u8array(&mut out, p);
            }
            Message::Update(p) => {
                write_varuint(&mut out, MSG_SYNC);
                write_varuint(&mut out, SYNC_UPDATE);
                write_var_u8array(&mut out, p);
            }
            Message::Awareness(p) => {
                write_varuint(&mut out, MSG_AWARENESS);
                write_var_u8array(&mut out, p);
            }
            Message::QueryAwareness => write_varuint(&mut out, MSG_QUERY_AWARENESS),
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn varint_roundtrip() {
        for n in [0u64, 1, 127, 128, 300, 16_384, u32::MAX as u64] {
            let mut buf = Vec::new();
            write_varuint(&mut buf, n);
            assert_eq!(Cursor::new(&buf).read_varuint(), Some(n), "valeur {n}");
        }
    }

    #[test]
    fn message_roundtrip() {
        let cases = [
            Message::SyncStep1(vec![0, 1, 2]),
            Message::SyncStep2(vec![9; 300]),
            Message::Update(vec![42]),
            Message::Awareness(vec![7, 7]),
            Message::QueryAwareness,
        ];
        for msg in cases {
            assert_eq!(Message::decode(&msg.encode()), Some(msg.clone()));
        }
    }

    #[test]
    fn malformed_frames_are_rejected_not_panicking() {
        assert_eq!(Message::decode(&[]), None);
        assert_eq!(Message::decode(&[0]), None);
        assert_eq!(Message::decode(&[0, 0, 200]), None); // declared length is larger than the buffer
        assert_eq!(Message::decode(&[99, 0, 0]), None); // unknown message type
    }
}
