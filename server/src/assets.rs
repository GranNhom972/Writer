// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors

//! Image store of a document.
//!
//! An image inserted into a shared document is replicated to every participant.
//! Leaving it as a `data:` URL inside the paragraph would send it again **on every
//! keystroke** in that paragraph, to everyone: a 2 MB photo would travel the
//! network again for each character typed next to it.
//!
//! So it is uploaded here once, and only its **address** travels afterwards inside
//! the operations: a few dozen bytes.
//!
//! Three rules keep this entry point safe:
//!
//!  - **the type comes from the bytes, never from the client.** The `Content-Type`
//!    header is ignored: we read the first bytes and refuse what we do not
//!    recognize. A file announced as `image/png` that actually contains HTML would
//!    be served from our origin, which is a stored XSS;
//!  - **SVG is refused.** It is a vector format, but also a document that can carry
//!    script. No reliable filtering makes it safe to serve from the application's
//!    origin;
//!  - **the file name is made up here** (random UUIDv4) and never taken from the
//!    request, so no `..` can reach the file system.
//!
//! Reading needs no token: the address IS the capability. The browser forces this,
//! since an `<img src>` cannot send an `Authorization` header. That is why the name
//! is fully random and not a UUIDv7, whose prefix is a timestamp and therefore
//! guessable.

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

/// Maximum size of an image. It is **the same** as the limit announced to the
/// client (`domain/document/images.ts`): two different values would let an image
/// travel the network only to be refused on arrival.
pub const MAX_ASSET_BYTES: usize = 4 * 1024 * 1024;

/// Accepted formats, recognized from their first bytes ("magic bytes").
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

/// Recognizes the format from the real content.
pub fn sniff(bytes: &[u8]) -> Option<ImageKind> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some(ImageKind::Png);
    }
    // JPEG: SOI (FFD8) followed by a marker (FFxx). The first two bytes alone would
    // let a truncated file through.
    if bytes.len() > 3 && bytes[0] == 0xFF && bytes[1] == 0xD8 && bytes[2] == 0xFF {
        return Some(ImageKind::Jpeg);
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some(ImageKind::Gif);
    }
    // WebP: a RIFF container; the full signature fits in twelve bytes.
    if bytes.len() > 11 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        return Some(ImageKind::Webp);
    }
    None
}

/// A valid asset name, and nothing else: `<uuid>.<known extension>`.
///
/// This function is the only boundary between a URL segment and a file path. By
/// construction it refuses anything that is not a name we made ourselves,
/// separators and `..` included.
pub fn parse_asset_name(name: &str) -> Option<(Uuid, ImageKind)> {
    let (stem, ext) = name.rsplit_once('.')?;
    let kind = ImageKind::from_extension(ext)?;
    let id = Uuid::parse_str(stem).ok()?;
    Some((id, kind))
}

/// `POST /api/v1/documents/{doc_id}/assets`: uploads an image.
///
/// Body: the raw bytes of the image. Answer: the address to put in the paragraph's
/// `imageSrc` run.
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

    // The document must exist: without this check we would create an upload folder
    // for any id that is presented.
    let store = state.store.clone();
    let key = doc_id.to_string();
    if !store.exists(&key) {
        return Err(AppError::NotFound);
    }

    // Shared document: only a participant with write permission may upload. The
    // token's scope can only **narrow** the session's scope, never widen it.
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

/// `GET /api/v1/documents/{doc_id}/assets/{name}`: downloads an image (no token
/// needed, see the module notes above).
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
            // The type is the one we recognized at upload: the browser is forbidden to guess
            // a different one when reading.
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
            (header::CONTENT_DISPOSITION, "inline"),
            // The content behind a given name never changes (every upload gets a random name).
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
        // SVG is executable content: refused, whatever the client claims.
        assert_eq!(
            sniff(b"<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>"),
            None
        );
        assert_eq!(sniff(b"<!DOCTYPE html><script>alert(1)</script>"), None);
        assert_eq!(sniff(b"%PDF-1.7"), None);
        assert_eq!(sniff(b""), None);
        // Truncated signatures: a prefix is not an image.
        assert_eq!(sniff(b"\xFF\xD8"), None);
        assert_eq!(sniff(b"RIFF\x00\x00\x00\x00WAVE"), None);
    }

    #[test]
    fn asset_names_are_only_those_we_minted() {
        let id = Uuid::new_v4();
        let name = format!("{id}.png");
        assert_eq!(parse_asset_name(&name), Some((id, ImageKind::Png)));

        // Directory traversal, extensions served as code and free-form names: all are
        // refused before reaching the file system.
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
