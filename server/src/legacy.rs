// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Les contributeurs de Writer

//! Lecture des documents écrits par la version précédente du serveur.
//!
//! Jusqu'ici, la synchronisation ne relayait pas des updates CRDT mais des
//! **opérations de bloc** typées, que le serveur séquençait et journalisait en
//! JSON (`journal.jsonl`, `snapshot.json`). Le modèle convergeait — mais à la
//! granularité du bloc : deux personnes qui écrivaient dans le même paragraphe
//! produisaient chacune un « remplace ce paragraphe », et la dernière arrivée
//! effaçait l'autre. C'est ce défaut-là qui a fait passer la synchronisation au
//! CRDT (`content.rs`, `doc.rs`), comme dans l'application Write.
//!
//! Ce module ne sert donc plus à synchroniser quoi que ce soit. Il ne subsiste
//! que pour **relire** ce qui a été écrit avant : au premier chargement d'un
//! document ancien, le serveur rejoue son journal, obtient l'état JSON final, et
//! s'en sert pour amorcer le document répliqué. Sans lui, un partage créé la
//! veille se rouvrirait vide.
//!
//! Rien ici n'est atteignable depuis le réseau : aucune route, aucune trame de
//! synchronisation ne construit plus d'`Operation`.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{AppError, AppResult};

/// Longueur maximale d'un identifiant de bloc. Les identifiants sont fabriqués
/// par le client (`newId('p')`) : on borne pour ne pas laisser gonfler l'état.
pub const MAX_BLOCK_ID_LEN: usize = 128;

/// Nombre maximal de blocs dans un document. Au-delà, ce n'est plus un document
/// mais une base de données, et la pagination côté client s'effondrerait bien avant.
pub const MAX_BLOCKS: usize = 50_000;

/// Une modification élémentaire du document.
///
/// Le découpage suit celui du modèle : un document est une **suite ordonnée de
/// blocs identifiés**, plus quelques attributs globaux. Chaque variante ne
/// touche qu'à l'un ou l'autre, ce qui rend deux opérations sur des blocs
/// distincts commutatives — d'où la fusion sans conflit du cas courant.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "kebab-case")]
pub enum Operation {
    /// Remplace un bloc existant. Le cas de la frappe : le client renvoie le
    /// paragraphe entier, qui reste petit.
    ReplaceBlock {
        id: String,
        block: Value,
    },
    /// Insère un bloc. `after` absent = en tête du document.
    InsertBlock {
        block: Value,
        #[serde(default)]
        after: Option<String>,
    },
    RemoveBlock {
        id: String,
    },
    /// Réordonne : la nouvelle suite complète des identifiants.
    ReorderBlocks {
        order: Vec<String>,
    },
    /// Métadonnées (titre, auteur).
    SetMeta {
        meta: Value,
    },
    SetPageSetup {
        page_setup: Value,
    },
    SetDefaults {
        defaults: Value,
    },
    /// En-tête et pied de page. `null` retire le mobilier.
    SetFurniture {
        furniture: Value,
    },
    /// Remplace le document entier — ouverture d'un `.odt`, restauration.
    ///
    /// Volontairement distincte des autres : c'est la seule qui efface le
    /// travail d'autrui, et la journaliser sous son propre nom permet de la
    /// retrouver dans l'historique quand quelqu'un demande « où est passé mon
    /// document ? ».
    ReplaceDocument {
        document: Value,
    },
}

/// Identifiant d'un bloc JSON, s'il en porte un utilisable.
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

/// Le document tel que le serveur le détient : du JSON, avec un contrat minimal.
///
/// Le serveur **ne valide pas le schéma** du document — c'est le client qui
/// connaît `WriterDocumentState`, et dupliquer ici sa définition condamnerait
/// les deux à évoluer ensemble. Il valide seulement ce dont il a besoin pour
/// appliquer une opération : `blocks` est un tableau, un bloc a un `id`.
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

        // Un document sans `blocks` est celui qu'on vient de créer : on l'ouvre
        // plutôt que de refuser la première frappe.
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

    /// Applique une opération. L'état n'est modifié qu'en cas de succès.
    ///
    /// Chaque variante valide **avant** d'écrire : une opération refusée à
    /// mi-chemin laisserait un document dont personne ne connaîtrait l'état, et
    /// que le journal ne permettrait pas de reconstituer.
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
                    // Remplacer un bloc absent n'est pas une erreur : l'auteur a
                    // pu écrire dans un paragraphe qu'un autre venait de
                    // supprimer. Le refuser bloquerait sa session ; on ajoute le
                    // bloc, et la suppression concurrente reste rattrapable par
                    // l'historique.
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
                        // Ancre disparue : on pose en fin plutôt que de perdre le
                        // bloc. Sa place exacte se corrigera au réordonnancement.
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
                // Les blocs absents de l'ordre demandé sont **conservés**, en
                // queue : un client dont la vue est en retard ne doit pas
                // supprimer, par omission, un bloc qu'il n'a pas encore reçu.
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

        // `null` retire le champ : c'est ainsi qu'on enlève un en-tête de page,
        // là où écrire `null` laisserait au client un champ défini mais vide.
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

/// Une opération telle qu'elle était journalisée : numérotée et signée.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SequencedOperation {
    /// Numéro d'ordre attribué par l'ancien séquenceur.
    pub revision: u64,
    /// Auteur, pour l'affichage et l'historique.
    pub author: String,
    #[serde(flatten)]
    pub operation: Operation,
}

/// Rejoue un journal ancien par-dessus son instantané et rend l'état final.
///
/// Les opérations antérieures à l'instantané y sont déjà incluses : les rejouer
/// les compterait deux fois. Celles qui ne s'appliquent plus — un bloc
/// entre-temps disparu — sont ignorées avec un avertissement plutôt que de
/// rendre le document inouvrable.
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
        // Sans ce contrôle, un client pourrait écraser le bloc « a » en annonçant
        // modifier « b » : l'identifiant du corps ferait autorité sur celui de
        // l'opération, et le journal serait illisible.
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
        // Cas concurrent réel : Alice tape dans un paragraphe que Bob vient de
        // supprimer. L'opération doit passer — refuser fermerait la session d'Alice.
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
        // Un client en retard d'une insertion ne doit pas supprimer, par omission,
        // le bloc qu'il n'a pas encore reçu.
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
        // C'est la propriété qui fait converger deux rédactions parallèles : le
        // résultat ne dépend pas de l'ordre tant que les blocs diffèrent.
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
        // Le journal contient du JSON : ce qu'on écrit doit se relire à
        // l'identique, sinon un redémarrage perdrait des modifications.
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
