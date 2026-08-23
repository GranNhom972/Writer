//! Projection JSON ⇄ document CRDT.
//!
//! ⚠️ **Exception assumée à l'ADR-001.** Le cœur du serveur — relais et journal —
//! reste aveugle au schéma : il ne manipule que des updates opaques. Ce module est
//! le seul endroit qui connaît la forme d'un document Write, et il ne sert que sur
//! deux chemins optionnels :
//!
//! - l'**amorçage** d'une session à partir des données fournies par le client
//!   (`data doc` de `POST /api/v1/sessions`) ;
//! - l'**observation** des sauvegardes en JSON (`/api/v1/sessions/{token}/events`),
//!   qui permet à un client non-JavaScript de suivre un document sans réimplémenter
//!   Yjs.
//!
//! Toute autre route continue de traiter le document comme une boîte noire.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use yrs::types::xml::XmlIn;
use yrs::{
    Any, Doc, GetString, Map, Out, ReadTxn, StateVector, Text, Transact, Xml, XmlElementPrelim,
    XmlElementRef, XmlFragment, XmlOut, XmlTextPrelim, XmlTextRef,
};

use crate::error::{AppError, AppResult};

/// Noms partagés avec le client (`client/src/collab/session.ts`).
pub const BODY_FRAGMENT: &str = "write:body";
pub const META_MAP: &str = "write:meta";

/// Bornes de l'amorçage. Un document fourni par un client reste une entrée : il
/// est borné comme n'importe quelle autre.
pub const MAX_BLOCKS: usize = 2_000;
pub const MAX_BLOCK_CHARS: usize = 20_000;
pub const MAX_LIST_ITEMS: usize = 500;

/// Bloc de premier niveau. Volontairement restreint : l'amorçage sert à fournir
/// un document de départ, pas à réimplémenter l'éditeur côté serveur. Le reste de
/// la mise en forme se fait dans l'application.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Block {
    Paragraph {
        #[serde(default)]
        text: String,
    },
    Heading {
        #[serde(default = "level_un")]
        level: u8,
        #[serde(default)]
        text: String,
    },
    BulletList {
        #[serde(default)]
        items: Vec<String>,
    },
    OrderedList {
        #[serde(default)]
        items: Vec<String>,
    },
}

fn level_un() -> u8 {
    1
}

/// « data doc » : le contenu initial d'une session, tel que fourni par le client.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct DocumentData {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default)]
    pub blocks: Vec<Block>,
}

impl DocumentData {
    /// Refuse ce qui ne tient pas dans les bornes, avec un message par champ.
    pub fn validate(&self) -> AppResult<()> {
        if self.blocks.len() > MAX_BLOCKS {
            return Err(AppError::BadRequest(format!(
                "document.blocks: {} blocs, maximum {MAX_BLOCKS}",
                self.blocks.len()
            )));
        }
        for (index, block) in self.blocks.iter().enumerate() {
            let too_long = |text: &str| text.chars().count() > MAX_BLOCK_CHARS;
            match block {
                Block::Paragraph { text } => {
                    if too_long(text) {
                        return Err(AppError::BadRequest(format!(
                            "document.blocks[{index}].text: plus de {MAX_BLOCK_CHARS} caractères"
                        )));
                    }
                }
                Block::Heading { level, text } => {
                    if !(1..=6).contains(level) {
                        return Err(AppError::BadRequest(format!(
                            "document.blocks[{index}].level: attendu entre 1 et 6"
                        )));
                    }
                    if too_long(text) {
                        return Err(AppError::BadRequest(format!(
                            "document.blocks[{index}].text: plus de {MAX_BLOCK_CHARS} caractères"
                        )));
                    }
                }
                Block::BulletList { items } | Block::OrderedList { items } => {
                    if items.len() > MAX_LIST_ITEMS {
                        return Err(AppError::BadRequest(format!(
                            "document.blocks[{index}].items: plus de {MAX_LIST_ITEMS} entrées"
                        )));
                    }
                    if items.iter().any(|item| too_long(item)) {
                        return Err(AppError::BadRequest(format!(
                            "document.blocks[{index}].items: entrée de plus de {MAX_BLOCK_CHARS} caractères"
                        )));
                    }
                }
            }
        }
        Ok(())
    }
}

/// Construit l'update CRDT qui amorce un document vide avec `data`.
///
/// Le résultat est une update ordinaire : elle est appliquée puis journalisée par
/// le même chemin que n'importe quelle frappe, donc durable avant toute connexion.
pub fn seed_update(data: &DocumentData) -> AppResult<Vec<u8>> {
    data.validate()?;

    let doc = Doc::new();
    {
        let body = doc.get_or_insert_xml_fragment(BODY_FRAGMENT);
        let meta = doc.get_or_insert_map(META_MAP);
        let mut txn = doc.transact_mut();

        if let Some(title) = &data.title {
            // Le titre vit dans le CRDT : un renommage se voit chez tous, tout de suite.
            meta.insert(&mut txn, "title", title.clone());
        }

        // Un document Write n'est jamais vide : sans bloc, l'éditeur doit quand même
        // avoir un paragraphe où poser le curseur.
        if data.blocks.is_empty() {
            body.push_back(&mut txn, paragraph(""));
        } else {
            for block in &data.blocks {
                body.push_back(&mut txn, to_xml(block));
            }
        }
    }

    let update = doc
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    Ok(update)
}

fn paragraph(text: &str) -> XmlElementPrelim {
    XmlElementPrelim::new("paragraph", [XmlIn::from(XmlTextPrelim::new(text))])
}

fn to_xml(block: &Block) -> XmlElementPrelim {
    match block {
        Block::Paragraph { text } => paragraph(text),
        Block::Heading { level, text } => {
            let mut element = paragraph(text);
            element.tag = "heading".into();
            // yrs n'écrit que des attributs textuels ; le client lit `level` via
            // `Number(...)`, il accepte donc les deux représentations.
            element.attributes = HashMap::from([("level".into(), level.to_string())]);
            element
        }
        Block::BulletList { items } => list("bullet_list", items),
        Block::OrderedList { items } => list("ordered_list", items),
    }
}

/// `bullet_list > list_item > paragraph`, conformément au schéma ProseMirror
/// (`addListNodes(nodes, 'paragraph block*', 'block')`).
fn list(tag: &str, items: &[String]) -> XmlElementPrelim {
    let entries = items.iter().map(|item| {
        XmlIn::from(XmlElementPrelim::new(
            "list_item",
            [XmlIn::from(paragraph(item))],
        ))
    });
    XmlElementPrelim::new(tag, entries)
}

/// Relit le document CRDT sous la même forme JSON que l'amorçage.
pub fn project(doc: &Doc) -> DocumentData {
    // Les racines sont résolues **avant** d'ouvrir la transaction de lecture :
    // `get_or_insert_*` ouvre sa propre transaction, et yrs n'en admet qu'une.
    let body = doc.get_or_insert_xml_fragment(BODY_FRAGMENT);
    let meta = doc.get_or_insert_map(META_MAP);
    let txn = doc.transact();

    let title = meta.get(&txn, "title").and_then(|value| match value {
        Out::Any(Any::String(s)) => Some(s.to_string()),
        _ => None,
    });

    let blocks = body
        .children(&txn)
        .filter_map(|child| from_xml(&txn, &child))
        .collect();

    DocumentData { title, blocks }
}

fn from_xml<T: ReadTxn>(txn: &T, node: &XmlOut) -> Option<Block> {
    let element = match node {
        XmlOut::Element(element) => element,
        // Texte nu ou fragment imbriqué : hors du contrat d'amorçage, ignoré.
        _ => return None,
    };

    match element.try_tag().map(|tag| tag.as_ref()) {
        Some("paragraph") => Some(Block::Paragraph {
            text: plain_text(txn, element),
        }),
        Some("heading") => Some(Block::Heading {
            level: element
                .get_attribute(txn, "level")
                .and_then(|raw| raw.parse().ok())
                .filter(|level| (1..=6).contains(level))
                .unwrap_or(1),
            text: plain_text(txn, element),
        }),
        Some("bullet_list") => Some(Block::BulletList {
            items: list_items(txn, element),
        }),
        Some("ordered_list") => Some(Block::OrderedList {
            items: list_items(txn, element),
        }),
        // Tableau, image, formule… : représentés par leur type, sans texte. Mieux
        // vaut annoncer un bloc inconnu que faire croire à un document vide.
        Some(_) | None => None,
    }
}

fn list_items<T: ReadTxn>(txn: &T, element: &XmlElementRef) -> Vec<String> {
    element
        .children(txn)
        .filter_map(|child| match child {
            XmlOut::Element(item) => Some(plain_text(txn, &item)),
            _ => None,
        })
        .collect()
}

/// Texte d'un nœud, marques de mise en forme retirées.
///
/// `GetString` sérialiserait `<strong>` et consorts : utile pour déboguer, illisible
/// dans un flux d'événements. On parcourt donc les fragments de texte.
fn plain_text<T: ReadTxn>(txn: &T, element: &XmlElementRef) -> String {
    fn walk<T: ReadTxn>(txn: &T, node: &XmlOut, out: &mut String) {
        match node {
            XmlOut::Text(text) => out.push_str(&text_of(txn, text)),
            XmlOut::Element(element) => {
                for child in element.children(txn) {
                    walk(txn, &child, out);
                }
            }
            XmlOut::Fragment(fragment) => {
                for child in fragment.children(txn) {
                    walk(txn, &child, out);
                }
            }
        }
    }

    let mut out = String::new();
    for child in element.children(txn) {
        walk(txn, &child, &mut out);
    }
    out
}

fn text_of<T: ReadTxn>(txn: &T, text: &XmlTextRef) -> String {
    let mut out = String::new();
    for chunk in text.diff(txn, yrs::types::text::YChange::identity) {
        if let Out::Any(Any::String(s)) = chunk.insert {
            out.push_str(&s);
        }
    }
    // Une formule ou une image intégrée n'a pas de texte : le fragment est vide, et
    // c'est plus honnête que de rendre `[object Object]`.
    if out.is_empty() {
        let raw = text.get_string(txn);
        if !raw.contains('<') {
            out.push_str(&raw);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use yrs::{Transact, Update};
    use yrs::updates::decoder::Decode;

    fn round_trip(data: &DocumentData) -> DocumentData {
        let update = seed_update(data).expect("amorçage");
        let doc = Doc::new();
        {
            let mut txn = doc.transact_mut();
            txn.apply_update(Update::decode_v1(&update).expect("update valide"));
        }
        project(&doc)
    }

    #[test]
    fn seeded_document_reads_back_identically() {
        let data = DocumentData {
            title: Some("Rapport Q3".into()),
            blocks: vec![
                Block::Heading {
                    level: 2,
                    text: "Contexte".into(),
                },
                Block::Paragraph {
                    text: "Première phrase.".into(),
                },
                Block::BulletList {
                    items: vec!["un".into(), "deux".into()],
                },
                Block::OrderedList {
                    items: vec!["premier".into()],
                },
            ],
        };
        assert_eq!(round_trip(&data), data);
    }

    #[test]
    fn empty_document_still_has_a_paragraph() {
        // Sans cela, l'éditeur ouvre un document sans point d'insertion.
        let projected = round_trip(&DocumentData::default());
        assert_eq!(projected.blocks, vec![Block::Paragraph { text: String::new() }]);
    }

    #[test]
    fn out_of_range_heading_level_is_rejected() {
        let data = DocumentData {
            title: None,
            blocks: vec![Block::Heading {
                level: 9,
                text: "Trop profond".into(),
            }],
        };
        assert!(seed_update(&data).is_err());
    }

    #[test]
    fn oversized_document_is_rejected() {
        let data = DocumentData {
            title: None,
            blocks: (0..MAX_BLOCKS + 1)
                .map(|_| Block::Paragraph { text: String::new() })
                .collect(),
        };
        assert!(seed_update(&data).is_err());
    }
}
