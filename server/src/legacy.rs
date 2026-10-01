// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors

//! Reading documents written by the previous version of the server.
//!
//! Until now, synchronization did not relay CRDT updates but typed **block
//! operations**, which the server sequenced and logged as JSON (`journal.jsonl`,
//! `snapshot.json`). The model converged, but only at block granularity: two people
//! writing in the same paragraph each produced a "replace this paragraph", and the
//! last to arrive erased the other. That flaw is what moved synchronization to a
//! CRDT (`content.rs`, `doc.rs`), as in the Write application.
//!
//! So this module no longer synchronizes anything. It only remains to **re-read**
//! what was written before: the first time an old document is loaded, the server
//! replays its log, gets the final JSON state, and uses it to seed the replicated
//! document. Without it, a share created the day before would reopen empty.
//!
//! Nothing here can be reached from the network: no route and no sync frame builds
//! an `Operation` any more.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{AppError, AppResult};

/// Maximum length of a block id. Ids are made up by the client (`newId('p')`), so
/// we cap them to keep the state from growing.
pub const MAX_BLOCK_ID_LEN: usize = 128;

/// Maximum number of blocks in a document. Beyond that it is no longer a document
/// but a database, and pagination on the client would collapse long before.
pub const MAX_BLOCKS: usize = 50_000;

/// One elementary modification of the document.
///
/// The split follows the model: a document is an **ordered sequence of identified
/// blocks**, plus a few global attributes. Each variant touches only one or the
/// other, so two operations on different blocks commute, which is why the common
/// case merges without conflict.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "kebab-case")]
pub enum Operation {
    /// Replaces an existing block. The typing case: the client sends back the whole
    /// paragraph, which stays small.
    ReplaceBlock {
        id: String,
        block: Value,
    },
    /// Inserts a block. A missing `after` means "at the top of the document".
    InsertBlock {
        block: Value,
        #[serde(default)]
        after: Option<String>,
    },
    RemoveBlock {
        id: String,
    },
    /// Reorders: the new complete sequence of ids.
    ReorderBlocks {
        order: Vec<String>,
    },
    /// Metadata (title, author).
    SetMeta {
        meta: Value,
    },
    SetPageSetup {
        page_setup: Value,
    },
    SetDefaults {
        defaults: Value,
    },
    /// Header and footer. `null` removes the furniture.
    SetFurniture {
        furniture: Value,
    },
    /// Replaces the entire document (opening an `.odt`, restoring).
    ///
    /// Deliberately separate from the others: it is the only one that erases other
    /// people's work, and logging it under its own name makes it findable in the
    /// history when someone asks "where did my document go?".
    ReplaceDocument {
        document: Value,
    },
}

/// Id of a JSON block, if it carries a usable one.
fn block_id(block: &Value) -> AppResult<String> {
    let id = block
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::Operation("bloc sans identifiant".into()))?;

    if id.is_empty() || id.len() > MAX_BLOCK_ID_LEN {
        return Err(AppError::Operation(
            "identifiant de bloc hors bornes".into(),
        ));
    }
    Ok(id.to_string())
}

/// The document as the server holds it: JSON, with a minimal contract.
///
/// The server **does not validate the document schema**: the client knows
/// `WriterDocumentState`, and duplicating its definition here would condemn both
/// to evolve together. It only validates what it needs to apply an operation:
/// `blocks` is an array, and a block has an `id`.
#[derive(Debug, Clone)]
pub struct DocumentState {
    pub value: Value,
}

impl Default for DocumentState {
    fn default() -> Self {
        Self {
            value: serde_json::json!({ "blocks": [] }),
        }
    }
}

impl DocumentState {
    pub fn from_value(value: Value) -> AppResult<Self> {
        if !value.is_object() {
            return Err(AppError::Operation("document: objet JSON attendu".into()));
        }
        Ok(Self { value })
    }

    fn blocks_mut(&mut self) -> AppResult<&mut Vec<Value>> {
        let object = self
            .value
            .as_object_mut()
            .ok_or_else(|| AppError::Operation("document: objet JSON attendu".into()))?;

        // A document with no `blocks` is one that has just been created: we open it
        // rather than refuse the first keystroke.
        let entry = object
            .entry("blocks")
            .or_insert_with(|| Value::Array(Vec::new()));
        entry
            .as_array_mut()
            .ok_or_else(|| AppError::Operation("document.blocks: tableau attendu".into()))
    }

    pub fn block_count(&self) -> usize {
        self.value
            .get("blocks")
            .and_then(Value::as_array)
            .map(Vec::len)
            .unwrap_or(0)
    }

    /// Applies an operation. The state is only modified on success.
    ///
    /// Each variant validates **before** writing: an operation refused halfway would
    /// leave a document whose state nobody knows and which the log could not
    /// reconstruct.
    pub fn apply(&mut self, operation: &Operation) -> AppResult<()> {
        match operation {
            Operation::ReplaceBlock { id, block } => {
                let incoming = block_id(block)?;
                if &incoming != id {
                    return Err(AppError::Operation(
                        "replace-block: l'identifiant du bloc ne correspond pas".into(),
                    ));
                }
                let blocks = self.blocks_mut()?;
                let position = blocks
                    .iter()
                    .position(|existing| existing.get("id").and_then(Value::as_str) == Some(id));

                match position {
                    Some(index) => blocks[index] = block.clone(),
                    // Replacing a missing block is not an error: the author may have written into a
                    // paragraph that somebody else had just deleted. Refusing it would block their
                    // session, so we add the block, and the concurrent deletion can still be
                    // recovered from the history.
                    None => blocks.push(block.clone()),
                }
                self.guard_size()
            }

            Operation::InsertBlock { block, after } => {
                let id = block_id(block)?;
                let blocks = self.blocks_mut()?;
                if blocks
                    .iter()
                    .any(|existing| existing.get("id").and_then(Value::as_str) == Some(id.as_str()))
                {
                    return Err(AppError::Operation(format!(
                        "insert-block: le bloc « {id} » existe déjà"
                    )));
                }

                match after {
                    None => blocks.insert(0, block.clone()),
                    Some(anchor) => {
                        let index = blocks.iter().position(|existing| {
                            existing.get("id").and_then(Value::as_str) == Some(anchor.as_str())
                        });
                        // The anchor has disappeared: put the block at the end rather than lose it. Its
                        // exact place will be corrected when the blocks are reordered.
                        match index {
                            Some(at) => blocks.insert(at + 1, block.clone()),
                            None => blocks.push(block.clone()),
                        }
                    }
                }
                self.guard_size()
            }

            Operation::RemoveBlock { id } => {
                let blocks = self.blocks_mut()?;
                blocks.retain(|existing| existing.get("id").and_then(Value::as_str) != Some(id));
                Ok(())
            }

            Operation::ReorderBlocks { order } => {
                let blocks = self.blocks_mut()?;
                let mut restant: Vec<Value> = std::mem::take(blocks);
                let mut ordonne = Vec::with_capacity(restant.len());

                for id in order {
                    if let Some(index) = restant
                        .iter()
                        .position(|b| b.get("id").and_then(Value::as_str) == Some(id.as_str()))
                    {
                        ordonne.push(restant.remove(index));
                    }
                }
                // Blocks missing from the requested order are **kept**, at the end: a client whose
                // view is behind must not delete, by omission, a block it has not received yet.
                ordonne.append(&mut restant);
                *blocks = ordonne;
                Ok(())
            }

            Operation::SetMeta { meta } => self.set_field("meta", meta),
            Operation::SetPageSetup { page_setup } => self.set_field("pageSetup", page_setup),
            Operation::SetDefaults { defaults } => self.set_field("defaults", defaults),
            Operation::SetFurniture { furniture } => self.set_field("furniture", furniture),

            Operation::ReplaceDocument { document } => {
                let next = DocumentState::from_value(document.clone())?;
                if next.block_count() > MAX_BLOCKS {
                    return Err(AppError::Operation("document: trop de blocs".into()));
                }
                self.value = next.value;
                Ok(())
            }
        }
    }

    fn set_field(&mut self, name: &str, value: &Value) -> AppResult<()> {
        let object = self
            .value
            .as_object_mut()
            .ok_or_else(|| AppError::Operation("document: objet JSON attendu".into()))?;

        // `null` removes the field: this is how a page header is taken away, whereas
        // writing `null` would leave the client with a field that is defined but empty.
        if value.is_null() {
            object.remove(name);
        } else {
            object.insert(name.to_string(), value.clone());
        }
        Ok(())
    }

    fn guard_size(&self) -> AppResult<()> {
        if self.block_count() > MAX_BLOCKS {
            return Err(AppError::Operation("document: trop de blocs".into()));
        }
        Ok(())
    }
}

/// An operation as it was logged: numbered and signed.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SequencedOperation {
    /// Sequence number assigned by the old sequencer.
    pub revision: u64,
    /// Author, for display and history.
    pub author: String,
    #[serde(flatten)]
    pub operation: Operation,
}

/// Replays an old log on top of its snapshot and returns the final state.
///
/// Operations older than the snapshot are already included in it: replaying them
/// would count them twice. Those that no longer apply (a block that has since
/// disappeared) are ignored with a warning rather than making the document
/// impossible to open.
pub fn replay(
    snapshot: Option<(u64, Value)>,
    operations: &[SequencedOperation],
) -> AppResult<Value> {
    let (depuis, depart) = snapshot.unwrap_or((0, serde_json::json!({ "blocks": [] })));
    let mut etat = DocumentState::from_value(depart)?;

    for sequenced in operations {
        if sequenced.revision <= depuis {
            continue;
        }
        if let Err(e) = etat.apply(&sequenced.operation) {
            tracing::warn!(revision = sequenced.revision, error = %e, "opération ancienne ignorée");
        }
    }
    Ok(etat.value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn bloc(id: &str, texte: &str) -> Value {
        json!({ "id": id, "type": "paragraph", "runs": [{ "text": texte }] })
    }

    fn document(ids: &[&str]) -> DocumentState {
        DocumentState::from_value(json!({
            "blocks": ids.iter().map(|id| bloc(id, id)).collect::<Vec<_>>()
        }))
        .unwrap()
    }

    fn ids(state: &DocumentState) -> Vec<String> {
        state.value["blocks"]
            .as_array()
            .unwrap()
            .iter()
            .map(|b| b["id"].as_str().unwrap().to_string())
            .collect()
    }

    #[test]
    fn replace_block_remplace_sur_place() {
        let mut state = document(&["a", "b", "c"]);
        state
            .apply(&Operation::ReplaceBlock {
                id: "b".into(),
                block: bloc("b", "modifié"),
            })
            .unwrap();

        assert_eq!(ids(&state), vec!["a", "b", "c"], "l'ordre ne bouge pas");
        assert_eq!(state.value["blocks"][1]["runs"][0]["text"], "modifié");
    }

    #[test]
    fn replace_block_refuse_un_identifiant_qui_ment() {
        // Without this check, a client could overwrite block "a" by announcing that it
        // modifies "b": the id in the body would override the one in the operation, and the
        // log would become unreadable.
        let mut state = document(&["a", "b"]);
        let resultat = state.apply(&Operation::ReplaceBlock {
            id: "b".into(),
            block: bloc("a", "usurpé"),
        });
        assert!(matches!(resultat, Err(AppError::Operation(_))));
        assert_eq!(state.value["blocks"][0]["runs"][0]["text"], "a");
    }

    #[test]
    fn replace_dun_bloc_supprime_par_un_autre_ne_casse_pas_la_session() {
        // A real concurrent case: Alice types into a paragraph that Bob has just deleted.
        // The operation must go through, because refusing it would close Alice's session.
        let mut state = document(&["a"]);
        state
            .apply(&Operation::ReplaceBlock {
                id: "disparu".into(),
                block: bloc("disparu", "frappe d'Alice"),
            })
            .unwrap();
        assert_eq!(ids(&state), vec!["a", "disparu"]);
    }

    #[test]
    fn insert_block_se_place_apres_son_ancre() {
        let mut state = document(&["a", "c"]);
        state
            .apply(&Operation::InsertBlock {
                block: bloc("b", "b"),
                after: Some("a".into()),
            })
            .unwrap();
        assert_eq!(ids(&state), vec!["a", "b", "c"]);
    }

    #[test]
    fn insert_block_sans_ancre_se_place_en_tete() {
        let mut state = document(&["b"]);
        state
            .apply(&Operation::InsertBlock {
                block: bloc("a", "a"),
                after: None,
            })
            .unwrap();
        assert_eq!(ids(&state), vec!["a", "b"]);
    }

    #[test]
    fn insert_block_dont_lancre_a_disparu_tombe_en_queue() {
        let mut state = document(&["a"]);
        state
            .apply(&Operation::InsertBlock {
                block: bloc("z", "z"),
                after: Some("inconnu".into()),
            })
            .unwrap();
        assert_eq!(ids(&state), vec!["a", "z"], "le bloc n'est jamais perdu");
    }

    #[test]
    fn insert_block_refuse_un_identifiant_deja_pris() {
        let mut state = document(&["a"]);
        let resultat = state.apply(&Operation::InsertBlock {
            block: bloc("a", "doublon"),
            after: None,
        });
        assert!(matches!(resultat, Err(AppError::Operation(_))));
        assert_eq!(ids(&state), vec!["a"]);
    }

    #[test]
    fn reorder_conserve_les_blocs_absents_de_lordre() {
        // A client that is one insertion behind must not delete, by omission, the block it
        // has not received yet.
        let mut state = document(&["a", "b", "c"]);
        state
            .apply(&Operation::ReorderBlocks {
                order: vec!["c".into(), "a".into()],
            })
            .unwrap();
        assert_eq!(ids(&state), vec!["c", "a", "b"]);
    }

    #[test]
    fn set_furniture_null_retire_le_champ() {
        let mut state = document(&["a"]);
        state
            .apply(&Operation::SetFurniture {
                furniture: json!({ "headerLeft": "Titre" }),
            })
            .unwrap();
        assert!(state.value.get("furniture").is_some());

        state
            .apply(&Operation::SetFurniture {
                furniture: Value::Null,
            })
            .unwrap();
        assert!(state.value.get("furniture").is_none());
    }

    #[test]
    fn les_operations_sur_des_blocs_distincts_commutent() {
        // This is the property that makes two parallel editing sessions converge: the
        // result does not depend on the order as long as the blocks differ.
        let alice = Operation::ReplaceBlock {
            id: "a".into(),
            block: bloc("a", "Alice"),
        };
        let bob = Operation::ReplaceBlock {
            id: "b".into(),
            block: bloc("b", "Bob"),
        };

        let mut ordre1 = document(&["a", "b"]);
        ordre1.apply(&alice).unwrap();
        ordre1.apply(&bob).unwrap();

        let mut ordre2 = document(&["a", "b"]);
        ordre2.apply(&bob).unwrap();
        ordre2.apply(&alice).unwrap();

        assert_eq!(ordre1.value, ordre2.value);
    }

    #[test]
    fn une_operation_se_serialise_et_se_relit() {
        // The log contains JSON: what we write must read back identically, otherwise a
        // restart would lose modifications.
        let operation = Operation::InsertBlock {
            block: bloc("x", "contenu"),
            after: Some("w".into()),
        };
        let brut = serde_json::to_string(&operation).unwrap();
        assert!(brut.contains("\"op\":\"insert-block\""));

        let relue: Operation = serde_json::from_str(&brut).unwrap();
        let mut a = document(&["w"]);
        let mut b = document(&["w"]);
        a.apply(&operation).unwrap();
        b.apply(&relue).unwrap();
        assert_eq!(a.value, b.value);
    }

    #[test]
    fn un_bloc_sans_identifiant_est_refuse() {
        let mut state = document(&["a"]);
        let resultat = state.apply(&Operation::InsertBlock {
            block: json!({ "type": "paragraph" }),
            after: None,
        });
        assert!(matches!(resultat, Err(AppError::Operation(_))));
    }
}
