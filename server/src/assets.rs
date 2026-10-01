// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Les contributeurs de Writer

//! Dépôt d'images du document.
//!
//! Une image insérée dans un document partagé est répliquée à tous les
//! participants. La laisser en `data:` dans le corps du paragraphe la ferait
//! transiter **à chaque frappe** dans ce paragraphe, pour chacun : une photo de
//! 2 Mo repartirait sur le réseau à chaque caractère tapé à côté d'elle.
//!
//! Elle est donc déposée ici une fois pour toutes, et seule son **adresse**
//! voyage ensuite dans les opérations — quelques dizaines d'octets.
//!
//! Trois règles tiennent la sécurité de ce point d'entrée :
//!
//!  - **le type vient des octets, jamais du client.** L'en-tête `Content-Type`
//!    est ignoré : on lit les premiers octets et on refuse ce qu'on ne
//!    reconnaît pas. Un fichier annoncé `image/png` mais contenant du HTML
//!    serait servi depuis notre origine — c'est un XSS stocké ;
//!  - **le SVG est refusé.** C'est un format vectoriel, mais aussi un document
//!    capable de porter du script. Aucun tri fiable ne le rend sûr à servir
//!    depuis l'origine de l'application ;
//!  - **le nom du fichier est fabriqué ici** (UUIDv4, aléatoire), jamais repris
//!    de la requête. Aucun `..` ne peut donc atteindre le système de fichiers.
//!
//! La lecture ne demande pas de jeton : l'adresse EST la capacité. C'est ce que
//! le navigateur impose, un `<img src>` ne portant pas d'en-tête `Authorization`
//! — d'où un nom entièrement aléatoire, et non un UUIDv7 dont le préfixe est
//! horodaté donc devinable.

use axum::{
    body::Bytes,
    extract::{Path, State},
    http::{header, HeaderMap, StatusCode},
    response::IntoResponse,
    Json,
};
use serde_json::json;
use uuid::Uuid;

use crate::auth::{identity_from_headers, origin_allowed};
use crate::error::{joined, AppError, AppResult};
use crate::state::AppState;

/// Taille maximale d'une image. Elle est **la même** que le plafond annoncé au
/// client (`domain/document/images.ts`) : deux valeurs différentes laisseraient
/// une image partir sur le réseau pour se faire refuser à l'arrivée.
pub const MAX_ASSET_BYTES: usize = 4 * 1024 * 1024;

/// Formats acceptés, reconnus à leurs octets d'en-tête (« magic bytes »).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageKind {
    Png,
    Jpeg,
    Gif,
    Webp,
}

impl ImageKind {
    pub fn extension(self) -> &'static str {
        match self {
            ImageKind::Png => "png",
            ImageKind::Jpeg => "jpg",
            ImageKind::Gif => "gif",
            ImageKind::Webp => "webp",
        }
    }

    pub fn content_type(self) -> &'static str {
        match self {
            ImageKind::Png => "image/png",
            ImageKind::Jpeg => "image/jpeg",
            ImageKind::Gif => "image/gif",
            ImageKind::Webp => "image/webp",
        }
    }

    pub fn from_extension(ext: &str) -> Option<Self> {
        match ext {
            "png" => Some(ImageKind::Png),
            "jpg" => Some(ImageKind::Jpeg),
            "gif" => Some(ImageKind::Gif),
            "webp" => Some(ImageKind::Webp),
            _ => None,
        }
    }
}

/// Reconnaît le format d'après le contenu réel.
pub fn sniff(bytes: &[u8]) -> Option<ImageKind> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some(ImageKind::Png);
    }
    // JPEG : SOI (FFD8) suivi d'un marqueur (FFxx). Les deux premiers octets seuls
    // suffiraient à laisser passer un fichier tronqué.
    if bytes.len() > 3 && bytes[0] == 0xFF && bytes[1] == 0xD8 && bytes[2] == 0xFF {
        return Some(ImageKind::Jpeg);
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some(ImageKind::Gif);
    }
    // WebP : conteneur RIFF, la signature complète tient sur douze octets.
    if bytes.len() > 11 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        return Some(ImageKind::Webp);
    }
    None
}

/// Un nom d'objet valide, et rien d'autre : `<uuid>.<extension connue>`.
///
/// Cette fonction est la seule frontière entre un segment d'URL et un chemin de
/// fichier. Elle refuse par construction tout ce qui n'est pas un nom qu'on a
/// soi-même fabriqué — séparateurs et `..` compris.
pub fn parse_asset_name(name: &str) -> Option<(Uuid, ImageKind)> {
    let (stem, ext) = name.rsplit_once('.')?;
    let kind = ImageKind::from_extension(ext)?;
    let id = Uuid::parse_str(stem).ok()?;
    Some((id, kind))
}

/// `POST /api/v1/documents/{doc_id}/assets`
///
/// Corps : les octets de l'image, bruts. Réponse : l'adresse à ranger dans le
/// run `imageSrc` du paragraphe.
pub async fn upload_asset(
    State(state): State<AppState>,
    Path(doc_id): Path<Uuid>,
    headers: HeaderMap,
    body: Bytes,
) -> AppResult<impl IntoResponse> {
    if !origin_allowed(&headers, &state.cfg.allowed_origins) {
        return Err(AppError::Forbidden);
    }
    let identity = identity_from_headers(&headers, &state.cfg.auth)?;
    identity.ensure_document(doc_id)?;
    if !identity.scope.can_write() {
        return Err(AppError::Forbidden);
    }

    if body.is_empty() {
        return Err(AppError::BadRequest("image vide".into()));
    }
    if body.len() > MAX_ASSET_BYTES {
        return Err(AppError::PayloadTooLarge);
    }

    // Le document doit exister : sans cette vérification, on créerait un
    // répertoire de dépôt pour n'importe quel identifiant présenté.
    let store = state.store.clone();
    let key = doc_id.to_string();
    if !store.exists(&key) {
        return Err(AppError::NotFound);
    }

    // Document partagé : seul un participant en écriture dépose. La portée du
    // jeton ne peut que **restreindre** celle de la session, jamais l'élargir.
    if let Some(record) = state.session_for_doc(doc_id) {
        let Some(participant) = record.find_by_user(&identity.user_id) else {
            return Err(AppError::Forbidden);
        };
        if !participant.scope().can_write() {
            return Err(AppError::Forbidden);
        }
    }

    let kind = sniff(&body).ok_or_else(|| {
        AppError::BadRequest("format non reconnu (PNG, JPEG, GIF ou WebP attendu)".into())
    })?;

    let name = format!("{}.{}", Uuid::new_v4(), kind.extension());
    let taille = body.len();
    let nom = name.clone();
    let octets = body.to_vec();
    joined(tokio::task::spawn_blocking(move || store.write_asset(&key, &nom, &octets)).await)??;

    tracing::info!(doc_id = %doc_id, user = %identity.user_id, %name, taille, "image déposée");

    Ok((
        StatusCode::CREATED,
        Json(json!({
            "url": format!("/api/v1/documents/{doc_id}/assets/{name}"),
            "name": name,
            "content_type": kind.content_type(),
            "size_bytes": taille,
        })),
    ))
}

/// `GET /api/v1/documents/{doc_id}/assets/{name}`
pub async fn get_asset(
    State(state): State<AppState>,
    Path((doc_id, name)): Path<(Uuid, String)>,
) -> AppResult<impl IntoResponse> {
    let (_, kind) = parse_asset_name(&name).ok_or(AppError::NotFound)?;

    let store = state.store.clone();
    let key = doc_id.to_string();
    let nom = name.clone();
    let octets = joined(tokio::task::spawn_blocking(move || store.read_asset(&key, &nom)).await)??;

    Ok((
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, kind.content_type()),
            // Le type est celui qu'on a reconnu à l'envoi : on interdit au
            // navigateur d'en deviner un autre à la lecture.
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
            (header::CONTENT_DISPOSITION, "inline"),
            // Le contenu d'un nom donné ne change jamais (nom aléatoire par dépôt).
            (
                header::CACHE_CONTROL,
                "private, max-age=31536000, immutable",
            ),
        ],
        octets,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sniff_recognises_supported_formats() {
        assert_eq!(sniff(b"\x89PNG\r\n\x1a\n\x00\x00"), Some(ImageKind::Png));
        assert_eq!(sniff(b"\xFF\xD8\xFF\xE0rest"), Some(ImageKind::Jpeg));
        assert_eq!(sniff(b"GIF89a....."), Some(ImageKind::Gif));
        assert_eq!(
            sniff(b"RIFF\x00\x00\x00\x00WEBPVP8 "),
            Some(ImageKind::Webp)
        );
    }

    #[test]
    fn sniff_rejects_everything_else() {
        // Le SVG est un document exécutable : refusé, quoi qu'annonce le client.
        assert_eq!(
            sniff(b"<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>"),
            None
        );
        assert_eq!(sniff(b"<!DOCTYPE html><script>alert(1)</script>"), None);
        assert_eq!(sniff(b"%PDF-1.7"), None);
        assert_eq!(sniff(b""), None);
        // Signatures tronquées : un préfixe n'est pas une image.
        assert_eq!(sniff(b"\xFF\xD8"), None);
        assert_eq!(sniff(b"RIFF\x00\x00\x00\x00WAVE"), None);
    }

    #[test]
    fn asset_names_are_only_those_we_minted() {
        let id = Uuid::new_v4();
        let name = format!("{id}.png");
        assert_eq!(parse_asset_name(&name), Some((id, ImageKind::Png)));

        // Traversée de répertoire, extensions servies comme du code, noms libres :
        // tout est refusé avant d'atteindre le système de fichiers.
        for hostile in [
            "../../../etc/passwd",
            "../meta.json",
            "..%2Fmeta.json",
            "journal.bin",
            "logo.svg",
            "logo.html",
            "logo.png",
            &format!("{id}.svg"),
            &format!("{id}"),
            &format!("{id}.png.html"),
        ] {
            assert!(
                parse_asset_name(hostile).is_none(),
                "accepté à tort: {hostile}"
            );
        }
    }
}
