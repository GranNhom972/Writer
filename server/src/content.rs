// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors

//! Conversion between JSON and the replicated (CRDT) document.
//!
//! ⚠️ **A deliberate exception to the relay role.** The core of the server
//! (re-broadcast and log) stays blind to the schema: it only handles opaque,
//! convergent updates. This module is the only place that knows the shape of a
//! Writer document, and it is only used on **optional** paths:
//!
//! - **seeding** a share from the document supplied by the client
//!   (`POST /api/v1/sessions`, `POST /api/v1/documents`);
//! - **observing** as JSON (`GET …/snapshot`, the `…/events` feed), which lets a
//!   script follow a document without reimplementing Yjs;
//! - **taking over** a document written by the previous version of the server,
//!   which logged block operations (`legacy.rs`).
//!
//! The schema is the exact mirror of `client/src/domain/collab/crdt.ts`. The two
//! must agree down to the name of each key: this is the only place in the project
//! where two languages describe the same structure.
//!
//! ```text
//!  writer:meta    Map    title, author, createdAt, updatedAt
//!  writer:setup   Map    id, pageSetup, defaults, furniture
//!  writer:blocks  Array  one Map per block
//!      ├─ id, type
//!      ├─ text   Text    paragraph text, formatting carried by attributes
//!      ├─ attrs  Map     paragraph or table attributes
//!      └─ rows   Array   tables: rows → cells → blocks
//! ```

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::{json, Map as JsonMap, Value};
use yrs::types::text::YChange;
use yrs::types::Attrs;
use yrs::{
    Any, Array, ArrayPrelim, ArrayRef, Doc, Map, MapPrelim, MapRef, Out, ReadTxn, StateVector,
    Text, TextPrelim, TextRef, Transact, TransactionMut,
};

use crate::error::{AppError, AppResult};

/// Names of the shared roots, also used by the client. Changing them on one side
/// only would make every share already created unreadable.
pub const BLOCKS_ROOT: &str = "writer:blocks";
pub const META_ROOT: &str = "writer:meta";
pub const SETUP_ROOT: &str = "writer:setup";

/// Id of the fallback paragraph of an empty document. It is fixed and shared with
/// the client: two peers that open an empty document must not each make up a
/// different paragraph.
const EMPTY_BLOCK_ID: &str = "p-vide";

/// Limits for seeding. A document supplied by a client is still an input, so it is
/// bounded like any other.
pub const MAX_BLOCKS: usize = 20_000;
pub const MAX_BLOCK_CHARS: usize = 200_000;

/// Replicated paragraph attributes: mirror of `PARAGRAPH_ATTRS` on the client side.
const PARAGRAPH_ATTRS: &[&str] = &[
    "headingLevel",
    "styleName",
    "alignment",
    "lineSpacing",
    "marginTopPt",
    "marginBottomPt",
    "indentLeftPt",
    "indentRightPt",
    "firstLineIndentPt",
    "pageBreakBefore",
    "orphans",
    "widows",
    "keepTogether",
    "listKind",
    "listId",
    "listLevel",
    "listRestart",
    "listStartValue",
    "listChecked",
];

const TABLE_ATTRS: &[&str] = &["pageBreakBefore", "borderColor", "borderWidthPt"];

const CELL_ATTRS: &[&str] = &[
    "colSpan",
    "rowSpan",
    "widthPercent",
    "backgroundColor",
    "borderColor",
    "paddingPt",
];

/// Character formatting keys: mirror of `RUN_FORMAT_KEYS` on the client side.
const RUN_FORMAT_KEYS: &[&str] = &[
    "bold",
    "italic",
    "underline",
    "strikeThrough",
    "fontFamily",
    "fontSizePt",
    "color",
    "backgroundColor",
    "linkHref",
    "mathLatex",
    "mathDisplay",
    "imageSrc",
    "imageWidthPt",
    "imageHeightPt",
    "imageAlt",
    "imageCropTopPct",
    "imageCropRightPct",
    "imageCropBottomPct",
    "imageCropLeftPct",
];

const META_KEYS: &[&str] = &["title", "author", "createdAt", "updatedAt"];

/* ------------------------------------------------------------- validation */

/// Rejects what does not fit within the limits, with one message per field.
pub fn validate(document: &Value) -> AppResult<()> {
    let blocks = document.get("blocks").and_then(Value::as_array);
    let Some(blocks) = blocks else {
        // A document without a block array is not a Writer document.
        return match document.get("blocks") {
            None => Ok(()),
            Some(_) => Err(AppError::BadRequest(
                "document.blocks: tableau attendu".into(),
            )),
        };
    };

    if blocks.len() > MAX_BLOCKS {
        return Err(AppError::BadRequest(format!(
            "document.blocks: {} blocs, maximum {MAX_BLOCKS}",
            blocks.len()
        )));
    }

    for (index, block) in blocks.iter().enumerate() {
        if !block.is_object() {
            return Err(AppError::BadRequest(format!(
                "document.blocks[{index}]: objet attendu"
            )));
        }
        let taille: usize = block
            .get("runs")
            .and_then(Value::as_array)
            .map(|runs| {
                runs.iter()
                    .filter_map(|run| run.get("text").and_then(Value::as_str))
                    .map(str::len)
                    .sum()
            })
            .unwrap_or(0);
        if taille > MAX_BLOCK_CHARS {
            return Err(AppError::BadRequest(format!(
                "document.blocks[{index}].runs: plus de {MAX_BLOCK_CHARS} caractères"
            )));
        }
    }
    Ok(())
}

/* --------------------------------------------------------------- seeding */

/// Builds the CRDT update that seeds an empty document with `document`.
///
/// The result is an ordinary update: it is applied and logged through the same path
/// as any keystroke, so it is durable before anybody connects.
pub fn seed_update(document: &Value) -> AppResult<Vec<u8>> {
    validate(document)?;

    let doc = Doc::new();
    {
        let ymeta = doc.get_or_insert_map(META_ROOT);
        let ysetup = doc.get_or_insert_map(SETUP_ROOT);
        let yblocks = doc.get_or_insert_array(BLOCKS_ROOT);
        let mut txn = doc.transact_mut();

        let meta = document.get("meta");
        for key in META_KEYS {
            let valeur = meta
                .and_then(|m| m.get(*key))
                .and_then(Value::as_str)
                .unwrap_or("");
            ymeta.insert(&mut txn, *key, Any::from(valeur.to_string()));
        }

        let id = document
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("doc-partage");
        ysetup.insert(&mut txn, "id", Any::from(id.to_string()));
        for key in ["pageSetup", "defaults", "furniture"] {
            let valeur = document.get(key).map(to_any).unwrap_or(Any::Null);
            ysetup.insert(&mut txn, key, valeur);
        }

        let blocs = document
            .get("blocks")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();

        if blocs.is_empty() {
            // A Writer document is never empty: with no block, the cursor would have
            // nowhere to land.
            write_paragraph(&mut txn, &yblocks, &json!({ "id": EMPTY_BLOCK_ID }));
        } else {
            for bloc in &blocs {
                write_block(&mut txn, &yblocks, bloc);
            }
        }
    }

    // The transaction is bound to a variable before being returned: in a tail
    // expression the borrow would outlive the document and would not compile.
    let update = doc
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    Ok(update)
}

fn write_block(txn: &mut TransactionMut, yblocks: &ArrayRef, block: &Value) {
    if block.get("type").and_then(Value::as_str) == Some("table") {
        write_table(txn, yblocks, block);
    } else {
        write_paragraph(txn, yblocks, block);
    }
}

fn write_paragraph(txn: &mut TransactionMut, yblocks: &ArrayRef, block: &Value) {
    let ybloc: MapRef = yblocks.push_back(txn, MapPrelim::default());
    let kind = match block.get("type").and_then(Value::as_str) {
        Some("heading") => "heading",
        _ => "paragraph",
    };
    write_identity(txn, &ybloc, block, kind);

    let ytext: TextRef = ybloc.insert(txn, "text", TextPrelim::new(""));
    if let Some(runs) = block.get("runs").and_then(Value::as_array) {
        write_runs(txn, &ytext, runs);
    }
    write_attrs(txn, &ybloc, block, PARAGRAPH_ATTRS);
}

fn write_table(txn: &mut TransactionMut, yblocks: &ArrayRef, block: &Value) {
    let ybloc: MapRef = yblocks.push_back(txn, MapPrelim::default());
    write_identity(txn, &ybloc, block, "table");
    write_attrs(txn, &ybloc, block, TABLE_ATTRS);

    let yrows: ArrayRef = ybloc.insert(txn, "rows", ArrayPrelim::default());
    for row in block
        .get("rows")
        .and_then(Value::as_array)
        .unwrap_or(&Vec::new())
    {
        let yrow: MapRef = yrows.push_back(txn, MapPrelim::default());
        yrow.insert(txn, "id", Any::from(identifier(row, "tr")));
        if row.get("isHeader").and_then(Value::as_bool) == Some(true) {
            yrow.insert(txn, "isHeader", Any::Bool(true));
        }

        let ycells: ArrayRef = yrow.insert(txn, "cells", ArrayPrelim::default());
        for cell in row
            .get("cells")
            .and_then(Value::as_array)
            .unwrap_or(&Vec::new())
        {
            let ycell: MapRef = ycells.push_back(txn, MapPrelim::default());
            ycell.insert(txn, "id", Any::from(identifier(cell, "tc")));
            write_attrs(txn, &ycell, cell, CELL_ATTRS);

            let yblocs: ArrayRef = ycell.insert(txn, "blocks", ArrayPrelim::default());
            let contenu = cell.get("blocks").and_then(Value::as_array);
            match contenu {
                Some(blocs) if !blocs.is_empty() => {
                    for bloc in blocs {
                        write_paragraph(txn, &yblocs, bloc);
                    }
                }
                // An empty cell still holds a paragraph: that is where the cursor lands when
                // someone clicks inside it.
                _ => write_paragraph(
                    txn,
                    &yblocs,
                    &json!({ "id": format!("{}-p", identifier(cell, "tc")) }),
                ),
            }
        }
    }
}

fn write_identity(txn: &mut TransactionMut, ybloc: &MapRef, block: &Value, kind: &str) {
    ybloc.insert(txn, "id", Any::from(identifier(block, "p")));
    ybloc.insert(txn, "type", Any::from(kind.to_string()));
}

/// The node's id, or a generated one if it has none.
///
/// A block without an id cannot be followed from one replica to the next, so it
/// must be given one here rather than left anonymous; otherwise every peer would
/// believe in a different block.
fn identifier(node: &Value, prefix: &str) -> String {
    match node.get("id").and_then(Value::as_str) {
        Some(id) if !id.is_empty() => id.to_string(),
        _ => format!("{prefix}-{}", uuid::Uuid::now_v7().simple()),
    }
}

fn write_attrs(txn: &mut TransactionMut, ybloc: &MapRef, source: &Value, cles: &[&str]) {
    let yattrs: MapRef = ybloc.insert(txn, "attrs", MapPrelim::default());
    for cle in cles {
        match source.get(*cle) {
            Some(valeur) if !valeur.is_null() => {
                yattrs.insert(txn, *cle, to_any(valeur));
            }
            _ => {}
        }
    }
}

fn write_runs(txn: &mut TransactionMut, ytext: &TextRef, runs: &[Value]) {
    for run in runs {
        let Some(texte) = run.get("text").and_then(Value::as_str) else {
            continue;
        };
        if texte.is_empty() {
            continue;
        }

        // The insertion position is read again each time rather than counted: the index
        // unit of `yrs` (bytes or UTF-16) is a configuration detail, and the current
        // length always gives the right one.
        let index = ytext.len(&*txn);
        // Always `insert_with_attributes`, even without attributes: it is the only call
        // that **cancels** the formatting still active at that spot. A bare `insert` after
        // a bold range would slip in before the end mark and inherit the bold, so a whole
        // paragraph would turn bold as soon as it started with a bold word.
        ytext.insert_with_attributes(txn, index, texte, run_attributes(run));
    }
}

fn run_attributes(run: &Value) -> Attrs {
    let mut attrs = Attrs::new();
    for cle in RUN_FORMAT_KEYS {
        match run.get(*cle) {
            Some(valeur) if !valeur.is_null() => {
                attrs.insert(Arc::from(*cle), to_any(valeur));
            }
            _ => {}
        }
    }
    attrs
}

/* -------------------------------------------------------------- projection */

/// Reads the replicated document back as the JSON form of a `WriterDocumentState`.
pub fn project(doc: &Doc) -> Value {
    let ymeta = doc.get_or_insert_map(META_ROOT);
    let ysetup = doc.get_or_insert_map(SETUP_ROOT);
    let yblocks = doc.get_or_insert_array(BLOCKS_ROOT);
    let txn = doc.transact();

    let mut meta = JsonMap::new();
    for cle in META_KEYS {
        let valeur = ymeta
            .get(&txn, cle)
            .and_then(out_to_json)
            .unwrap_or(Value::String(String::new()));
        meta.insert((*cle).to_string(), valeur);
    }

    let mut document = JsonMap::new();
    document.insert(
        "id".into(),
        ysetup
            .get(&txn, "id")
            .and_then(out_to_json)
            .unwrap_or_else(|| json!("doc-partage")),
    );
    document.insert("meta".into(), Value::Object(meta));
    for cle in ["pageSetup", "defaults"] {
        if let Some(valeur) = ysetup.get(&txn, cle).and_then(out_to_json) {
            if !valeur.is_null() {
                document.insert(cle.to_string(), valeur);
            }
        }
    }
    if let Some(valeur) = ysetup.get(&txn, "furniture").and_then(out_to_json) {
        if !valeur.is_null() {
            document.insert("furniture".into(), valeur);
        }
    }

    let mut blocks = Vec::new();
    for out in yblocks.iter(&txn) {
        if let Out::YMap(ybloc) = out {
            blocks.push(read_block(&txn, &ybloc));
        }
    }
    document.insert("blocks".into(), Value::Array(blocks));

    Value::Object(document)
}

fn read_block<T: ReadTxn>(txn: &T, ybloc: &MapRef) -> Value {
    let kind = ybloc
        .get(txn, "type")
        .and_then(out_to_json)
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_else(|| "paragraph".into());

    let mut bloc = JsonMap::new();
    bloc.insert(
        "id".into(),
        ybloc
            .get(txn, "id")
            .and_then(out_to_json)
            .unwrap_or(json!("")),
    );
    bloc.insert("type".into(), json!(kind));

    if kind == "table" {
        read_attrs(txn, ybloc, TABLE_ATTRS, &mut bloc);
        let mut rows = Vec::new();
        if let Some(Out::YArray(yrows)) = ybloc.get(txn, "rows") {
            for out in yrows.iter(txn) {
                if let Out::YMap(yrow) = out {
                    rows.push(read_row(txn, &yrow));
                }
            }
        }
        bloc.insert("rows".into(), Value::Array(rows));
        return Value::Object(bloc);
    }

    let runs = match ybloc.get(txn, "text") {
        Some(Out::YText(ytext)) => read_runs(txn, &ytext),
        _ => Vec::new(),
    };
    // An empty paragraph keeps **one** empty run: it carries the formatting that the
    // next keystroke will take, just as a `SwTxtNode` keeps its `SwAttrSet`.
    bloc.insert(
        "runs".into(),
        Value::Array(if runs.is_empty() {
            vec![json!({ "text": "" })]
        } else {
            runs
        }),
    );
    read_attrs(txn, ybloc, PARAGRAPH_ATTRS, &mut bloc);
    Value::Object(bloc)
}

fn read_row<T: ReadTxn>(txn: &T, yrow: &MapRef) -> Value {
    let mut row = JsonMap::new();
    row.insert(
        "id".into(),
        yrow.get(txn, "id")
            .and_then(out_to_json)
            .unwrap_or(json!("")),
    );
    if let Some(Out::Any(Any::Bool(true))) = yrow.get(txn, "isHeader") {
        row.insert("isHeader".into(), json!(true));
    }

    let mut cells = Vec::new();
    if let Some(Out::YArray(ycells)) = yrow.get(txn, "cells") {
        for out in ycells.iter(txn) {
            if let Out::YMap(ycell) = out {
                cells.push(read_cell(txn, &ycell));
            }
        }
    }
    row.insert("cells".into(), Value::Array(cells));
    Value::Object(row)
}

fn read_cell<T: ReadTxn>(txn: &T, ycell: &MapRef) -> Value {
    let mut cell = JsonMap::new();
    cell.insert(
        "id".into(),
        ycell
            .get(txn, "id")
            .and_then(out_to_json)
            .unwrap_or(json!("")),
    );
    read_attrs(txn, ycell, CELL_ATTRS, &mut cell);

    let mut blocks = Vec::new();
    if let Some(Out::YArray(yblocs)) = ycell.get(txn, "blocks") {
        for out in yblocs.iter(txn) {
            if let Out::YMap(ybloc) = out {
                blocks.push(read_block(txn, &ybloc));
            }
        }
    }
    cell.insert("blocks".into(), Value::Array(blocks));
    Value::Object(cell)
}

fn read_attrs<T: ReadTxn>(
    txn: &T,
    ybloc: &MapRef,
    cles: &[&str],
    sortie: &mut JsonMap<String, Value>,
) {
    let Some(Out::YMap(yattrs)) = ybloc.get(txn, "attrs") else {
        return;
    };
    for cle in cles {
        if let Some(valeur) = yattrs.get(txn, cle).and_then(out_to_json) {
            if !valeur.is_null() {
                sortie.insert((*cle).to_string(), valeur);
            }
        }
    }
}

fn read_runs<T: ReadTxn>(txn: &T, ytext: &TextRef) -> Vec<Value> {
    let mut runs = Vec::new();
    for chunk in ytext.diff(txn, YChange::identity) {
        let Out::Any(Any::String(texte)) = chunk.insert else {
            // Non-text insertions do not exist in this schema: an image is an attribute of a
            // run, not a separate node.
            continue;
        };
        let mut run = JsonMap::new();
        run.insert("text".into(), json!(texte.as_ref()));
        if let Some(attrs) = chunk.attributes {
            for cle in RUN_FORMAT_KEYS {
                if let Some(valeur) = attrs.get(*cle) {
                    let json = any_to_json(valeur);
                    if !json.is_null() {
                        run.insert((*cle).to_string(), json);
                    }
                }
            }
        }
        runs.push(Value::Object(run));
    }
    runs
}

/* ----------------------------------------------------------- metadata */

/// The current title, as it lives in the replicated document.
pub fn title(doc: &Doc) -> Option<String> {
    let ymeta = doc.get_or_insert_map(META_ROOT);
    let txn = doc.transact();
    match ymeta.get(&txn, "title") {
        Some(Out::Any(Any::String(titre))) if !titre.is_empty() => Some(titre.to_string()),
        _ => None,
    }
}

/// Number of top-level blocks, for the document's details, without opening the
/// content.
pub fn block_count(doc: &Doc) -> usize {
    let yblocks = doc.get_or_insert_array(BLOCKS_ROOT);
    let txn = doc.transact();
    yblocks.len(&txn) as usize
}

/// Does the replicated document already have content?
pub fn is_seeded(doc: &Doc) -> bool {
    block_count(doc) > 0
}

/* ------------------------------------------------------------ conversions */

/// JSON → `Any`, **never producing a `BigInt`**.
///
/// This is not a detail: `Any::BigInt` is encoded in a type that the JavaScript
/// library reads back as a `BigInt`, and `12n !== 12`. The client would then compare
/// the value it has just written with the one it reads back, forever, and re-send
/// a modification on every round.
fn to_any(value: &Value) -> Any {
    match value {
        Value::Null => Any::Null,
        Value::Bool(b) => Any::Bool(*b),
        Value::Number(n) => Any::Number(n.as_f64().unwrap_or(0.0)),
        Value::String(s) => Any::String(s.as_str().into()),
        Value::Array(items) => Any::Array(items.iter().map(to_any).collect::<Vec<_>>().into()),
        Value::Object(map) => {
            let entries: HashMap<String, Any> =
                map.iter().map(|(k, v)| (k.clone(), to_any(v))).collect();
            Any::Map(Arc::new(entries))
        }
    }
}

fn any_to_json(any: &Any) -> Value {
    match any {
        Any::Null | Any::Undefined => Value::Null,
        Any::Bool(b) => json!(b),
        Any::Number(n) => nombre(*n),
        Any::BigInt(i) => json!(i),
        Any::String(s) => json!(s.as_ref()),
        // A binary buffer has no place in a Writer document.
        Any::Buffer(_) => Value::Null,
        Any::Array(items) => Value::Array(items.iter().map(any_to_json).collect()),
        Any::Map(map) => Value::Object(
            map.iter()
                .map(|(k, v)| (k.clone(), any_to_json(v)))
                .collect(),
        ),
    }
}

/// An integer stays an integer in the JSON that is produced: `12`, not `12.0`.
///
/// The number made the round trip through a float, the only representation the
/// CRDT has. Writing it out as it is would give font sizes of `12.0` in the
/// exports and in the observation feed.
fn nombre(valeur: f64) -> Value {
    if valeur.fract() == 0.0 && valeur.abs() < 9.007_199_254_740_992e15 {
        json!(valeur as i64)
    } else {
        json!(valeur)
    }
}

fn out_to_json(out: Out) -> Option<Value> {
    match out {
        Out::Any(any) => Some(any_to_json(&any)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use yrs::updates::decoder::Decode;
    use yrs::Update;

    fn amorcer(document: &Value) -> Doc {
        let doc = Doc::new();
        let update = seed_update(document).expect("amorçage");
        let mut txn = doc.transact_mut();
        txn.apply_update(Update::decode_v1(&update).expect("update lisible"));
        drop(txn);
        doc
    }

    fn document_exemple() -> Value {
        json!({
            "id": "doc-1",
            "meta": { "title": "Rapport", "author": "alice", "createdAt": "hier", "updatedAt": "aujourd'hui" },
            "pageSetup": { "format": "A4", "marginLeftMm": 20 },
            "defaults": { "fontFamily": "Liberation Serif", "fontSizePt": 12 },
            "blocks": [
                {
                    "id": "p0",
                    "type": "heading",
                    "headingLevel": 1,
                    "runs": [{ "text": "Titre" }]
                },
                {
                    "id": "p1",
                    "type": "paragraph",
                    "alignment": "justify",
                    "runs": [
                        { "text": "du " },
                        { "text": "gras", "bold": true, "fontSizePt": 14 },
                        { "text": " et la suite" }
                    ]
                }
            ]
        })
    }

    #[test]
    fn lamorcage_puis_la_relecture_rendent_le_meme_document() {
        // The property that matters: what the client uploads when sharing is exactly what
        // an observer later reads back as JSON.
        let source = document_exemple();
        let relu = project(&amorcer(&source));

        assert_eq!(relu["id"], source["id"]);
        assert_eq!(relu["meta"]["title"], "Rapport");
        assert_eq!(relu["pageSetup"]["marginLeftMm"], 20);
        assert_eq!(relu["blocks"].as_array().unwrap().len(), 2);

        let titre = &relu["blocks"][0];
        assert_eq!(titre["type"], "heading");
        assert_eq!(titre["headingLevel"], 1);
        assert_eq!(titre["runs"][0]["text"], "Titre");

        let paragraphe = &relu["blocks"][1];
        assert_eq!(paragraphe["alignment"], "justify");
        assert_eq!(paragraphe["runs"][1]["text"], "gras");
        assert_eq!(paragraphe["runs"][1]["bold"], true);
        // An integer must stay an integer: `14.0` would end up in the ODF export.
        assert_eq!(paragraphe["runs"][1]["fontSizePt"], 14);
    }

    #[test]
    fn un_tableau_survit_a_laller_retour() {
        let source = json!({
            "id": "doc-t",
            "meta": { "title": "T" },
            "blocks": [{
                "id": "t0",
                "type": "table",
                "rows": [{
                    "id": "tr0",
                    "isHeader": true,
                    "cells": [{
                        "id": "tc0",
                        "widthPercent": 50,
                        "blocks": [{ "id": "c0", "type": "paragraph", "runs": [{ "text": "entête" }] }]
                    }]
                }]
            }]
        });

        let relu = project(&amorcer(&source));
        let table = &relu["blocks"][0];
        assert_eq!(table["type"], "table");
        assert_eq!(table["rows"][0]["isHeader"], true);
        assert_eq!(table["rows"][0]["cells"][0]["widthPercent"], 50);
        assert_eq!(
            table["rows"][0]["cells"][0]["blocks"][0]["runs"][0]["text"],
            "entête"
        );
    }

    #[test]
    fn un_document_sans_bloc_recoit_un_paragraphe() {
        // The client's cursor would have nowhere to land.
        let relu = project(&amorcer(&json!({ "blocks": [] })));
        assert_eq!(relu["blocks"].as_array().unwrap().len(), 1);
        assert_eq!(relu["blocks"][0]["id"], EMPTY_BLOCK_ID);
    }

    #[test]
    fn deux_amorcages_concurrents_convergent() {
        // Fundamental property of the relay: the order in which updates are applied does
        // not change the result.
        let a = amorcer(&document_exemple());
        let b = Doc::new();
        {
            let update = a
                .transact()
                .encode_state_as_update_v1(&StateVector::default());
            let mut txn = b.transact_mut();
            txn.apply_update(Update::decode_v1(&update).unwrap());
        }
        assert_eq!(project(&a), project(&b));
    }

    #[test]
    fn un_document_trop_gros_est_refuse_avant_toute_ecriture() {
        let blocs: Vec<Value> = (0..(MAX_BLOCKS + 1))
            .map(|i| json!({ "id": format!("p{i}"), "runs": [] }))
            .collect();
        assert!(seed_update(&json!({ "blocks": blocs })).is_err());
    }

    #[test]
    fn un_bloc_sans_identifiant_en_recoit_un() {
        // Without an id, two replicas would not know they are talking about the same
        // paragraph.
        let relu = project(&amorcer(&json!({
            "blocks": [{ "type": "paragraph", "runs": [{ "text": "anonyme" }] }]
        })));
        let id = relu["blocks"][0]["id"].as_str().unwrap();
        assert!(
            id.starts_with("p-"),
            "identifiant fabriqué attendu, reçu {id}"
        );
    }

    #[test]
    fn le_titre_se_lit_sans_ouvrir_le_contenu() {
        let doc = amorcer(&document_exemple());
        assert_eq!(title(&doc).as_deref(), Some("Rapport"));
        assert_eq!(block_count(&doc), 2);
        assert!(is_seeded(&doc));
    }
}
