// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Les contributeurs de Writer

//! Service du bundle de l'éditeur par le binaire du serveur lui-même.
//!
//! L'éditeur appelle son API en RELATIF (`/api/v1/…`) et ouvre son WebSocket de
//! synchronisation sur l'origine de la page. Page et API doivent donc partager
//! une origine. Trois montages y parviennent, et un seul ne demande aucune
//! pièce en plus : celui-ci.
//!
//!   * en développement, le proxy de `vite.config.ts` renvoie `/api` vers ce
//!     serveur — d'où le `ws: true`, sans lequel la montée en WebSocket échoue ;
//!   * en production, HAProxy route `writer.<domaine>/api` ici ;
//!   * désormais, ce processus sert aussi la page, et les deux se rejoignent
//!     sans proxy du tout.
//!
//! C'est ce qui manquait en conteneur : l'image de la page ne servait que des
//! fichiers statiques, si bien qu'un `/api/v1/…` y recevait le shell HTML avec
//! un 200, et que le WebSocket ne montait jamais. Le document s'ouvrait à vide
//! et rien ne s'enregistrait.
//!
//! Sans `WRITER_WEB_ROOT`, rien de tout cela ne s'active : le serveur se
//! comporte comme avant, et c'est Vite ou HAProxy qui sert la page.

use std::path::{Path, PathBuf};

use axum::extract::{Request, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use tower::ServiceExt;
use tower_http::services::{ServeDir, ServeFile};

use crate::state::AppState;

/// Racine du bundle, si elle est configurée ET réellement présente.
///
/// Un chemin qui ne mène nulle part est signalé au démarrage plutôt que
/// découvert en produisant des 404 sur chaque page : l'image est construite
/// avec le bundle dedans, son absence est une erreur de build.
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

/// Repli du routeur : tout ce qui n'est pas une route connue est une URL de la
/// SPA — `/doc/<id>` en particulier — donc `index.html`, que le routeur React
/// résoudra côté navigateur.
pub async fn spa_fallback(State(state): State<AppState>, requete: Request) -> Response {
    // Un `/api/...` inconnu doit rester un 404 FRANC. Le faire tomber dans la
    // SPA renverrait `index.html` avec un 200 : côté client, `res.ok` serait
    // vrai et l'échec n'apparaîtrait qu'au `JSON.parse`, sous la forme d'un
    // « Unexpected token < » qui ne désigne rien. C'est exactement le
    // symptôme qu'avait le conteneur statique, et il a coûté cher à lire.
    if requete.uri().path().starts_with("/api") {
        return (StatusCode::NOT_FOUND, "route d'API inconnue").into_response();
    }

    let Some(racine) = state.cfg.web_root.as_deref() else {
        return (StatusCode::NOT_FOUND, "ressource inconnue").into_response();
    };

    servir(racine, requete).await
}

async fn servir(racine: &Path, requete: Request) -> Response {
    // Relevé avant de céder la requête au service, qui la consomme.
    let chemin = requete.uri().path().to_string();

    // `.br` / `.gz` précompressés au build (voir le Dockerfile) : servis tels
    // quels quand le navigateur les accepte, sans une compression à
    // l'exécution.
    let service = ServeDir::new(racine)
        .precompressed_br()
        .precompressed_gzip()
        .fallback(ServeFile::new(racine.join("index.html")));

    // `ServeDir` a `Infallible` pour type d'erreur : le compilateur garantit
    // que cette branche ne peut pas exister, un fichier manquant étant déjà un
    // 404 renvoyé par le service lui-même.
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

/// Le fichier porte-t-il un hash de contenu dans son nom ? Vite ne le garantit
/// que pour ce qu'il émet lui-même, dans `assets/`.
fn hashe_par_vite(chemin: &str) -> bool {
    chemin.starts_with("/assets/")
}

/// Un nom contenant son hash désigne un contenu immuable : le revalider ne peut
/// rien apprendre au navigateur.
fn figer_dans_le_cache(reponse: &mut Response) {
    reponse.headers_mut().insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("public, max-age=31536000, immutable"),
    );
}

/// Le shell de la SPA est le seul document HTML du bundle : son type suffit à
/// le reconnaître, quelle que soit l'URL par laquelle on y est arrivé.
fn est_le_shell(reponse: &Response) -> bool {
    reponse
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|t| t.starts_with("text/html"))
}

/// Interdit cache ET revalidation du shell : son contenu ne change pas d'un
/// déploiement à l'autre (même `ETag`) alors que ses en-têtes, eux, changent.
/// Un 304 ne porte pas de `Content-Type` et fait rejouer l'ancien.
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

    /// Bundle minimal sur disque : un shell et un asset hashé par Vite.
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

    /// Le cœur de la panne corrigée : `/doc/<id>` n'existe pas sur le disque,
    /// c'est une route du routeur React. Sans repli, l'éditeur répondait 404
    /// sur sa propre URL d'ouverture.
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
        // Un 304 ne porte pas de Content-Type : le navigateur rejouerait
        // l'ancien, et la page se TÉLÉCHARGERAIT au lieu de s'afficher.
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
        // `public/` est copié tel quel, sous un nom stable : le figer pour un
        // an rendrait impossible d'en corriger un sans le renommer.
        assert!(!hashe_par_vite("/favicon.ico"));
        assert!(!hashe_par_vite("/doc/abc"));
        assert!(!hashe_par_vite("/"));
    }
}
