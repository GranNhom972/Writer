//! Projection JSON ⇄ document répliqué (CRDT).
//!
//! ⚠️ **Exception assumée au rôle de relais.** Le cœur du serveur — rediffusion
//! et journal — reste aveugle au schéma : il ne manipule que des updates
//! opaques et convergentes. Ce module est le seul endroit qui connaisse la
//! forme d'un document Writer, et il ne sert que sur des chemins **optionnels** :
//!
//! - l'**amorçage** d'un partage à partir du document fourni par le client
//!   (`POST /api/v1/sessions`, `POST /api/v1/documents`) ;
//! - l'**observation** en JSON (`GET …/snapshot`, flux `…/events`), qui permet
//!   à un script de suivre un document sans réimplémenter Yjs ;
//! - la **reprise** d'un document écrit par la version précédente du serveur,
//!   qui journalisait des opérations de blocs (`legacy.rs`).
//!
//! Le schéma est le miroir exact de `client/src/domain/collab/crdt.ts`. Les deux
//! doivent rester d'accord au nom de clé près : c'est le seul endroit du projet
//! où deux langages décrivent la même structure.
//!
//! ```text
//!  writer:meta    Map    title, author, createdAt, updatedAt
//!  writer:setup   Map    id, pageSetup, defaults, furniture
//!  writer:blocks  Array  un Map par bloc
//!      ├─ id, type
//!      ├─ text   Text    texte du paragraphe, formatage porté par les attributs
//!      ├─ attrs  Map     attributs de paragraphe ou de tableau
//!      └─ rows   Array   tableaux : lignes → cellules → blocs
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

/// Noms des racines partagées avec le client. Les changer d'un seul côté
/// rendrait illisibles tous les partages déjà créés.
pub const BLOCKS_ROOT: &str = "writer:blocks";
pub const META_ROOT: &str = "writer:meta";
pub const SETUP_ROOT: &str = "writer:setup";

/// Identifiant du paragraphe de secours d'un document vide. Fixe, et partagé
/// avec le client : deux pairs qui ouvrent un document vide ne doivent pas
/// fabriquer deux paragraphes différents.
const EMPTY_BLOCK_ID: &str = "p-vide";

/// Bornes de l'amorçage. Un document fourni par un client reste une entrée : il
/// est borné comme n'importe quelle autre.
pub const MAX_BLOCKS: usize = 20_000;
pub const MAX_BLOCK_CHARS: usize = 200_000;

/// Attributs de paragraphe répliqués — miroir de `PARAGRAPH_ATTRS` côté client.
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

/// Clés de formatage de caractère — miroir de `RUN_FORMAT_KEYS` côté client.
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

/// Refuse ce qui ne tient pas dans les bornes, avec un message par champ.
pub fn validate(document: &Value) -> AppResult<()> {
    let blocks = document.get("blocks").and_then(Value::as_array);
    let Some(blocks) = blocks else {
        // Un document sans tableau de blocs n'est pas un document Writer.
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

/* --------------------------------------------------------------- amorçage */

/// Construit l'update CRDT qui amorce un document vide avec `document`.
///
/// Le résultat est une update ordinaire : elle est appliquée puis journalisée
/// par le même chemin que n'importe quelle frappe, donc durable avant toute
/// connexion.
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
            // Un document Writer n'est jamais vide : sans bloc, le curseur
            // n'aurait nulle part où se poser.
            write_paragraph(&mut txn, &yblocks, &json!({ "id": EMPTY_BLOCK_ID }));
        } else {
            for bloc in &blocs {
                write_block(&mut txn, &yblocks, bloc);
            }
        }
    }

    // La transaction est liée avant d'être rendue : dans une expression de
    // queue, l'emprunt survivrait au document et ne compilerait pas.
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
                // Une cellule vide porte quand même un paragraphe : c'est là que
                // le curseur se pose quand on clique dedans.
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

/// Identifiant du nœud, ou un identifiant fabriqué s'il n'en a pas.
///
/// Un bloc sans identifiant ne peut pas être suivi d'une réplique à l'autre :
/// il faut donc lui en donner un ici plutôt que de le laisser anonyme, sinon
/// chaque pair croirait à un bloc différent.
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

        // La position d'insertion est relue à chaque fois plutôt que comptée :
        // l'unité d'index de `yrs` (octets ou UTF-16) est un détail de
        // configuration, et la longueur courante en donne toujours la bonne.
        let index = ytext.len(&*txn);
        // Toujours `insert_with_attributes`, même sans attribut : c'est le seul
        // appel qui **annule** le formatage encore actif à cet endroit. Un
        // `insert` nu après une plage en gras se glisserait avant la marque de
        // fin et hériterait du gras — un paragraphe entier basculait ainsi en
        // gras dès qu'il commençait par un mot en gras.
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

/// Relit le document répliqué sous la forme JSON d'un `WriterDocumentState`.
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
    // Un paragraphe vide garde **un** run vide : c'est le porteur du formatage
    // que prendra la prochaine frappe, comme un `SwTxtNode` garde son `SwAttrSet`.
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
            // Les insertions non textuelles n'existent pas dans ce schéma : une
            // image est un attribut de run, pas un nœud à part.
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

/* ----------------------------------------------------------- métadonnées */

/// Titre courant, tel qu'il vit dans le document répliqué.
pub fn title(doc: &Doc) -> Option<String> {
    let ymeta = doc.get_or_insert_map(META_ROOT);
    let txn = doc.transact();
    match ymeta.get(&txn, "title") {
        Some(Out::Any(Any::String(titre))) if !titre.is_empty() => Some(titre.to_string()),
        _ => None,
    }
}

/// Nombre de blocs de premier niveau — pour la fiche du document, sans ouvrir
/// le contenu.
pub fn block_count(doc: &Doc) -> usize {
    let yblocks = doc.get_or_insert_array(BLOCKS_ROOT);
    let txn = doc.transact();
    yblocks.len(&txn) as usize
}

/// Le document répliqué a-t-il déjà un contenu ?
pub fn is_seeded(doc: &Doc) -> bool {
    block_count(doc) > 0
}

/* ------------------------------------------------------------ conversions */

/// JSON → `Any`, **sans jamais produire de `BigInt`**.
///
/// Ce n'est pas un détail : `Any::BigInt` s'encode dans un type que la
/// bibliothèque JavaScript relit en `BigInt`, et `12n !== 12`. Le client
/// comparerait alors sans fin la valeur qu'il vient d'écrire à celle qu'il
/// relit, et réémettrait une modification à chaque tour.
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
        // Un tampon binaire n'a pas de place dans un document Writer.
        Any::Buffer(_) => Value::Null,
        Any::Array(items) => Value::Array(items.iter().map(any_to_json).collect()),
        Any::Map(map) => Value::Object(
            map.iter()
                .map(|(k, v)| (k.clone(), any_to_json(v)))
                .collect(),
        ),
    }
}

/// Un entier reste un entier dans le JSON rendu : `12` et non `12.0`.
///
/// Le nombre a fait l'aller-retour par un flottant, seule représentation du
/// CRDT. L'écrire tel quel donnerait des tailles de police en `12.0` dans les
/// exports et dans le flux d'observation.
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
        // La propriété qui compte : ce que le client dépose en partageant est
        // exactement ce qu'un observateur relit ensuite en JSON.
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
        // Un entier doit rester entier : `14.0` se retrouverait dans l'export ODF.
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
        // Le curseur du client n'aurait nulle part où se poser.
        let relu = project(&amorcer(&json!({ "blocks": [] })));
        assert_eq!(relu["blocks"].as_array().unwrap().len(), 1);
        assert_eq!(relu["blocks"][0]["id"], EMPTY_BLOCK_ID);
    }

    #[test]
    fn deux_amorcages_concurrents_convergent() {
        // Propriété fondamentale du relais : l'ordre d'application ne change pas
        // le résultat.
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
        // Sans identifiant, deux répliques ne sauraient pas qu'elles parlent du
        // même paragraphe.
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
