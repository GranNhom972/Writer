// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors

//! Serving the editor bundle from the server binary itself.
//!
//! The editor calls its API with RELATIVE addresses (`/api/v1/…`) and opens its
//! sync WebSocket on the page's origin. The page and the API therefore have to
//! share one origin. Three setups achieve this, and only one needs no extra piece:
//! this one.
//!
//!   * in development, the proxy in `vite.config.ts` sends `/api` to this server,
//!     hence the `ws: true`, without which upgrading to a WebSocket fails;
//!   * in production, HAProxy routes `writer.<domain>/api` here;
//!   * now, this process also serves the page, and the two meet with no proxy at
//!     all.
//!
//! This is what was missing in a container: the page's image only served static
//! files, so a `/api/v1/…` request received the HTML shell with a 200, and the
//! WebSocket never came up. The document opened empty and nothing was saved.
//!
//! Without `WRITER_WEB_ROOT` none of this is active: the server behaves as before,
//! and Vite or HAProxy serves the page.

use std::path::{Path, PathBuf};

use axum::extract::{Request, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use tower::ServiceExt;
use tower_http::services::{ServeDir, ServeFile};

use crate::state::AppState;

/// Root of the bundle, if it is configured AND really present.
///
/// A path that leads nowhere is reported at startup rather than discovered by
/// producing 404s on every page: the image is built with the bundle inside, so its
/// absence is a build error.
pub fn resolve_root(configured: Option<&str>) -> Option<PathBuf> {
    let brut = configured?.trim();
    if brut.is_empty() {
        return None;
    }
    let racine = PathBuf::from(brut);
    if !racine.join("index.html").is_file() {
        tracing::warn!(
            root = brut,
            "WRITER_WEB_ROOT : index.html introuvable, le bundle ne sera pas servi"
        );
        return None;
    }
    Some(racine)
}

/// Router fallback: anything that is not a known route is a URL of the SPA
/// (`/doc/<id>` in particular), so it gets `index.html`, which the React router
/// will resolve in the browser.
pub async fn spa_fallback(State(state): State<AppState>, requete: Request) -> Response {
    // An unknown `/api/...` must stay a CLEAR 404. Letting it fall into the SPA would
    // return `index.html` with a 200: on the client, `res.ok` would be true and the
    // failure would only show up at `JSON.parse`, as an "Unexpected token <" that
    // points at nothing. That is exactly the symptom the static container had, and it
    // cost a lot of time to read.
    if requete.uri().path().starts_with("/api") {
        return (StatusCode::NOT_FOUND, "route d'API inconnue").into_response();
    }

    let Some(racine) = state.cfg.web_root.as_deref() else {
        return (StatusCode::NOT_FOUND, "ressource inconnue").into_response();
    };

    servir(racine, requete).await
}

async fn servir(racine: &Path, requete: Request) -> Response {
    // Read before handing the request to the service, which consumes it.
    let chemin = requete.uri().path().to_string();

    // Pre-compressed `.br` / `.gz` files made at build time (see the Dockerfile): sent
    // as they are when the browser accepts them, with no compression at run time.
    let service = ServeDir::new(racine)
        .precompressed_br()
        .precompressed_gzip()
        .fallback(ServeFile::new(racine.join("index.html")));

    // `ServeDir` has `Infallible` as its error type: the compiler guarantees this
    // branch cannot exist, since a missing file is already a 404 returned by the
    // service itself.
    let reponse = match service.oneshot(requete).await {
        Ok(reponse) => reponse,
        Err(impossible) => match impossible {},
    };

    let mut reponse = reponse.into_response();
    if est_le_shell(&reponse) {
        interdire_la_revalidation(&mut reponse);
    } else if hashe_par_vite(&chemin) {
        figer_dans_le_cache(&mut reponse);
    }
    reponse
}

/// Does the file carry a content hash in its name? Vite only guarantees that for
/// what it emits itself, in `assets/`.
fn hashe_par_vite(chemin: &str) -> bool {
    chemin.starts_with("/assets/")
}

/// A name that contains its hash designates immutable content: revalidating it can
/// teach the browser nothing.
fn figer_dans_le_cache(reponse: &mut Response) {
    reponse.headers_mut().insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("public, max-age=31536000, immutable"),
    );
}

/// The SPA shell is the only HTML document in the bundle: its type is enough to
/// recognize it, whatever URL it was reached through.
fn est_le_shell(reponse: &Response) -> bool {
    reponse
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|t| t.starts_with("text/html"))
}

/// Forbid caching AND revalidation of the shell: its content does not change from
/// one deployment to the next (same `ETag`) while its headers do. A 304 carries no
/// `Content-Type` and makes the browser replay the old one.
fn interdire_la_revalidation(reponse: &mut Response) {
    let entetes = reponse.headers_mut();
    entetes.remove(header::ETAG);
    entetes.remove(header::LAST_MODIFIED);
    entetes.insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("no-store"),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn une_racine_absente_ou_vide_desactive_le_service() {
        assert!(resolve_root(None).is_none());
        assert!(resolve_root(Some("")).is_none());
        assert!(resolve_root(Some("   ")).is_none());
        assert!(resolve_root(Some("/chemin/qui/n/existe/pas")).is_none());
    }

    /// Minimal bundle on disk: a shell and an asset hashed by Vite.
    fn bundle_temporaire() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "writer-web-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(dir.join("assets")).unwrap();
        std::fs::write(
            dir.join("index.html"),
            "<!doctype html><title>Writer</title>",
        )
        .unwrap();
        std::fs::write(dir.join("assets/index-a1b2c3.js"), "export default 1;").unwrap();
        dir
    }

    async fn demander(racine: &Path, chemin: &str) -> Response {
        let requete = Request::builder()
            .uri(chemin)
            .body(axum::body::Body::empty())
            .unwrap();
        servir(racine, requete).await
    }

    /// The heart of the bug that was fixed: `/doc/<id>` does not exist on disk, it is a
    /// route of the React router. Without a fallback, the editor answered 404 on its own
    /// opening URL.
    #[tokio::test]
    async fn une_url_de_la_spa_rend_le_shell() {
        let racine = bundle_temporaire();
        for chemin in ["/", "/doc/abc-123", "/doc/abc-123/quelconque"] {
            let reponse = demander(&racine, chemin).await;
            assert_eq!(
                reponse.status(),
                StatusCode::OK,
                "« {chemin} » devrait rendre le shell"
            );
            assert!(est_le_shell(&reponse), "« {chemin} » devrait être du HTML");
        }
        std::fs::remove_dir_all(&racine).ok();
    }

    #[tokio::test]
    async fn le_shell_n_est_ni_mis_en_cache_ni_revalidable() {
        let racine = bundle_temporaire();
        let reponse = demander(&racine, "/").await;
        let entetes = reponse.headers();
        assert_eq!(entetes.get(header::CACHE_CONTROL).unwrap(), "no-store");
        // A 304 carries no Content-Type: the browser would replay the old one, and the
        // page would be DOWNLOADED instead of displayed.
        assert!(entetes.get(header::ETAG).is_none());
        assert!(entetes.get(header::LAST_MODIFIED).is_none());
        std::fs::remove_dir_all(&racine).ok();
    }

    #[tokio::test]
    async fn un_asset_hashe_est_fige_pour_un_an() {
        let racine = bundle_temporaire();
        let reponse = demander(&racine, "/assets/index-a1b2c3.js").await;
        assert_eq!(reponse.status(), StatusCode::OK);
        assert_eq!(
            reponse.headers().get(header::CACHE_CONTROL).unwrap(),
            "public, max-age=31536000, immutable"
        );
        std::fs::remove_dir_all(&racine).ok();
    }

    #[test]
    fn seul_ce_que_vite_hashe_est_fige_dans_le_cache() {
        assert!(hashe_par_vite("/assets/index-a1b2c3.js"));
        // `public/` is copied as is, under a stable name: freezing it for a year would make
        // it impossible to fix one of its files without renaming it.
        assert!(!hashe_par_vite("/favicon.ico"));
        assert!(!hashe_par_vite("/doc/abc"));
        assert!(!hashe_par_vite("/"));
    }
}
