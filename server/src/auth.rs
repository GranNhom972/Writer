// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Les contributeurs de Writer

//! Identité et portées.
//!
//! Directive : l'identité provient **exclusivement** d'un jeton vérifié, jamais du
//! corps de requête ni d'un paramètre d'URL (faille `username` déclaratif de la v1).
//!
//! ## Deux modes, et un seul est utilisable hors du poste de développement
//!
//! - `AuthMode::Dev` accepte des jetons `dev.<user>.<scope>` en clair. Il permet
//!   de faire tourner un partage sans fournisseur d'identité. Le serveur
//!   **refuse de démarrer** dans ce mode si `WRITER_ENV=production`.
//! - `AuthMode::Jwt` exige un JWT **HS256 dont la signature est vérifiée** avec
//!   le secret partagé `WRITER_JWT_SECRET`. Sans ce secret, aucun jeton n'est
//!   accepté : le mode échoue fermé plutôt que de faire semblant.
//!
//! ## Le billet d'accès émis par CloudServ
//!
//! Quand Writer sert d'éditeur temporaire à CloudServ, c'est CloudServ qui
//! signe les billets, avec ce même secret. Un billet porte une revendication
//! `doc` — l'identifiant du document qu'il ouvre — et Writer refuse de s'en
//! servir sur un **autre** document. Sans ce lien, un billet obtenu
//! légitimement sur un document ouvrirait tous les autres, dont l'identifiant
//! suffirait alors à connaître.
//!
//! C'est ce qui permet à CloudServ de rester seul maître des droits : Writer ne
//! conserve aucune liste de participants pour les documents qu'il héberge pour
//! lui, et une révocation dans CloudServ prend effet à l'expiration du billet.

use axum::http::HeaderMap;
use uuid::Uuid;

use crate::crypto::{base64_url_decode, constant_time_eq, hmac_sha256};
use crate::error::{AppError, AppResult};

/// Durée de validité maximale acceptée pour un billet.
///
/// Un billet est une capacité : il ouvre un document tant qu'il vit, y compris
/// après que CloudServ a révoqué le partage. Deux heures bornent cette fenêtre
/// sans obliger à réémettre au milieu d'une séance de travail.
const MAX_TICKET_LIFETIME_SECS: i64 = 2 * 3600;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Scope {
    Read,
    Comment,
    Write,
}

impl Scope {
    pub fn parse(raw: &str) -> Option<Scope> {
        match raw {
            "read" => Some(Scope::Read),
            "comment" => Some(Scope::Comment),
            "write" => Some(Scope::Write),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Scope::Read => "read",
            Scope::Comment => "comment",
            Scope::Write => "write",
        }
    }

    pub fn can_write(self) -> bool {
        self == Scope::Write
    }
}

#[derive(Debug, Clone)]
pub struct Identity {
    pub user_id: String,
    pub display_name: String,
    pub scope: Scope,
    /// Document auquel le billet est lié, s'il l'est. `None` pour un jeton
    /// d'usage général (mode développement, ou partage géré par Writer).
    pub doc_binding: Option<Uuid>,
}

impl Identity {
    /// Vérifie qu'un billet lié à un document est bien présenté sur celui-ci.
    ///
    /// Un jeton non lié passe : c'est le cas du mode développement et des
    /// partages que Writer gère lui-même, où la liste des participants tient
    /// déjà ce rôle.
    pub fn ensure_document(&self, doc_id: Uuid) -> AppResult<()> {
        match self.doc_binding {
            Some(lie) if lie != doc_id => {
                tracing::warn!(
                    user = %self.user_id,
                    demande = %doc_id,
                    billet = %lie,
                    "billet présenté sur un autre document"
                );
                Err(AppError::Forbidden)
            }
            _ => Ok(()),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthMode {
    Dev,
    Jwt,
}

/// Mode d'authentification et secret de vérification.
#[derive(Debug, Clone)]
pub struct AuthSettings {
    pub mode: AuthMode,
    /// Secret partagé avec CloudServ. Obligatoire en mode JWT.
    pub jwt_secret: Option<String>,
}

impl AuthSettings {
    /// Le mode JWT sans secret n'accepte rien : autant le dire au démarrage
    /// plutôt que de laisser découvrir des 401 inexplicables.
    pub fn is_usable(&self) -> bool {
        match self.mode {
            AuthMode::Dev => true,
            AuthMode::Jwt => self
                .jwt_secret
                .as_ref()
                .is_some_and(|secret| !secret.is_empty()),
        }
    }
}

pub fn identity_from_headers(headers: &HeaderMap, auth: &AuthSettings) -> AppResult<Identity> {
    // 1. En-tête HTTP standard (routes REST).
    if let Some(value) = headers.get(axum::http::header::AUTHORIZATION) {
        let raw = value.to_str().map_err(|_| AppError::Unauthorized)?;
        let token = raw.strip_prefix("Bearer ").ok_or(AppError::Unauthorized)?;
        return verify(token.trim(), auth);
    }

    // 2. Sous-protocole WebSocket : `bearer.<token>` — jamais en query string
    //    (fuite via logs, Referer, historique navigateur).
    if let Some(value) = headers.get(axum::http::header::SEC_WEBSOCKET_PROTOCOL) {
        let raw = value.to_str().map_err(|_| AppError::Unauthorized)?;
        for proto in raw.split(',') {
            if let Some(token) = proto.trim().strip_prefix("bearer.") {
                return verify(token, auth);
            }
        }
    }

    Err(AppError::Unauthorized)
}

fn verify(token: &str, auth: &AuthSettings) -> AppResult<Identity> {
    match auth.mode {
        AuthMode::Dev => verify_dev(token),
        AuthMode::Jwt => {
            let secret = auth
                .jwt_secret
                .as_deref()
                .filter(|s| !s.is_empty())
                .ok_or_else(|| {
                    tracing::error!(
                        "mode JWT sans WRITER_JWT_SECRET : aucun jeton ne peut être vérifié"
                    );
                    AppError::Unauthorized
                })?;
            verify_jwt(token, secret.as_bytes())
        }
    }
}

/// Jeton de développement : `dev.<user_id>.<scope>`, ex. `dev.alice.write`.
fn verify_dev(token: &str) -> AppResult<Identity> {
    let rest = token.strip_prefix("dev.").ok_or(AppError::Unauthorized)?;
    let (user, scope) = rest.split_once('.').ok_or(AppError::Unauthorized)?;
    let scope = Scope::parse(scope).ok_or(AppError::Unauthorized)?;
    if !valid_user_id(user) {
        return Err(AppError::Unauthorized);
    }
    Ok(Identity {
        user_id: user.to_string(),
        display_name: user.to_string(),
        scope,
        doc_binding: None,
    })
}

fn valid_user_id(user: &str) -> bool {
    !user.is_empty()
        && user.len() <= 64
        && user
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Vérifie un JWT HS256 et en tire l'identité.
///
/// Quatre contrôles, et chacun ferme une faille connue :
///
///  1. **`alg` doit valoir exactement `HS256`.** Accepter la valeur annoncée par
///     le jeton, c'est accepter `"alg":"none"` — la vulnérabilité la plus
///     répandue des implémentations JWT.
///  2. **La signature est recalculée** sur `<header>.<payload>` et comparée à
///     temps constant. C'est ce qui manquait à la version précédente, laquelle
///     se contentait de décoder la charge utile : n'importe qui pouvait forger
///     `{"sub":"alice","scope":"write"}`.
///  3. **`exp` est obligatoire** et borné à `MAX_TICKET_LIFETIME_SECS`. Un billet
///     sans expiration est un droit d'accès permanent que rien ne révoque.
///  4. **`doc` lie le billet à un document**, vérifié par `ensure_document` sur
///     chaque route qui en nomme un.
fn verify_jwt(token: &str, secret: &[u8]) -> AppResult<Identity> {
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() != 3 {
        return Err(AppError::Unauthorized);
    }
    let (header_b64, payload_b64, signature_b64) = (parts[0], parts[1], parts[2]);

    // 1. En-tête : algorithme figé, jamais celui que le jeton réclame.
    let header: serde_json::Value = base64_url_decode(header_b64)
        .ok()
        .and_then(|raw| serde_json::from_slice(&raw).ok())
        .ok_or(AppError::Unauthorized)?;
    if header.get("alg").and_then(|a| a.as_str()) != Some("HS256") {
        tracing::warn!(alg = ?header.get("alg"), "jeton refusé : algorithme non supporté");
        return Err(AppError::Unauthorized);
    }

    // 2. Signature.
    let signee = format!("{header_b64}.{payload_b64}");
    let attendue = hmac_sha256(secret, signee.as_bytes());
    let fournie = base64_url_decode(signature_b64).map_err(|_| AppError::Unauthorized)?;
    if !constant_time_eq(&attendue, &fournie) {
        tracing::warn!("jeton refusé : signature invalide");
        return Err(AppError::Unauthorized);
    }

    let claims: serde_json::Value = base64_url_decode(payload_b64)
        .ok()
        .and_then(|raw| serde_json::from_slice(&raw).ok())
        .ok_or(AppError::Unauthorized)?;

    // 3. Expiration — exigée, et pas trop lointaine.
    let exp = claims.get("exp").and_then(|e| e.as_i64()).ok_or_else(|| {
        tracing::warn!("jeton refusé : sans expiration");
        AppError::Unauthorized
    })?;
    let maintenant = chrono::Utc::now().timestamp();
    if maintenant > exp {
        return Err(AppError::Unauthorized);
    }
    if exp - maintenant > MAX_TICKET_LIFETIME_SECS {
        tracing::warn!(exp, "jeton refusé : validité excessive");
        return Err(AppError::Unauthorized);
    }

    let sub = claims
        .get("sub")
        .and_then(|s| s.as_str())
        .ok_or(AppError::Unauthorized)?;
    // Le `sub` sert d'identifiant de participant et se compare à ceux d'une
    // session : il subit la même validation qu'un identifiant de développement.
    if !valid_user_id(sub) {
        return Err(AppError::Unauthorized);
    }

    let display_name = claims
        .get("name")
        .and_then(|s| s.as_str())
        .filter(|n| !n.is_empty() && n.len() <= 128)
        .unwrap_or(sub);

    // Une portée illisible ne DOIT pas ouvrir plus que la lecture.
    let scope = claims
        .get("scope")
        .and_then(|s| s.as_str())
        .and_then(Scope::parse)
        .unwrap_or(Scope::Read);

    // 4. Lien au document. Une valeur présente mais illisible est un refus, pas
    //    un jeton « non lié » : la tolérance transformerait une faute de frappe
    //    en passe-partout.
    let doc_binding = match claims.get("doc") {
        None | Some(serde_json::Value::Null) => None,
        Some(value) => Some(
            value
                .as_str()
                .and_then(|s| Uuid::parse_str(s).ok())
                .ok_or(AppError::Unauthorized)?,
        ),
    };

    Ok(Identity {
        user_id: sub.to_string(),
        display_name: display_name.to_string(),
        scope,
        doc_binding,
    })
}

/// Vérification d'origine à l'ouverture du WebSocket (protection CSWSH).
pub fn origin_allowed(headers: &HeaderMap, allowed: &[String]) -> bool {
    match headers.get(axum::http::header::ORIGIN) {
        Some(value) => value
            .to_str()
            .map(|origin| allowed.iter().any(|a| a == origin))
            .unwrap_or(false),
        // Absence d'Origin = client non navigateur (tests, outils) : autorisé
        // uniquement parce que le jeton reste exigé par ailleurs.
        None => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::base64_url_encode;
    use axum::http::{header, HeaderValue};

    const SECRET: &[u8] = b"secret-partage-avec-cloudserv";

    fn dev() -> AuthSettings {
        AuthSettings {
            mode: AuthMode::Dev,
            jwt_secret: None,
        }
    }

    fn jwt() -> AuthSettings {
        AuthSettings {
            mode: AuthMode::Jwt,
            jwt_secret: Some(String::from_utf8(SECRET.to_vec()).unwrap()),
        }
    }

    /// Fabrique un jeton signé — c'est ce que fait CloudServ.
    fn ticket(claims: serde_json::Value) -> String {
        signe_avec(claims, SECRET, r#"{"alg":"HS256","typ":"JWT"}"#)
    }

    fn signe_avec(claims: serde_json::Value, secret: &[u8], entete: &str) -> String {
        let header_b64 = base64_url_encode(entete.as_bytes());
        let payload_b64 = base64_url_encode(claims.to_string().as_bytes());
        let signature = hmac_sha256(secret, format!("{header_b64}.{payload_b64}").as_bytes());
        format!(
            "{header_b64}.{payload_b64}.{}",
            base64_url_encode(&signature)
        )
    }

    fn dans_une_heure() -> i64 {
        chrono::Utc::now().timestamp() + 3600
    }

    fn headers_with(name: header::HeaderName, value: &str) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert(name, HeaderValue::from_str(value).unwrap());
        h
    }

    fn bearer(token: &str) -> HeaderMap {
        headers_with(header::AUTHORIZATION, &format!("Bearer {token}"))
    }

    #[test]
    fn rejects_missing_token() {
        assert!(identity_from_headers(&HeaderMap::new(), &dev()).is_err());
    }

    #[test]
    fn accepts_dev_bearer() {
        let h = bearer("dev.alice.write");
        let id = identity_from_headers(&h, &dev()).unwrap();
        assert_eq!(id.user_id, "alice");
        assert!(id.scope.can_write());
        assert!(id.doc_binding.is_none());
    }

    #[test]
    fn accepts_websocket_subprotocol() {
        let h = headers_with(header::SEC_WEBSOCKET_PROTOCOL, "bearer.dev.bob.read");
        let id = identity_from_headers(&h, &dev()).unwrap();
        assert_eq!(id.user_id, "bob");
        assert!(!id.scope.can_write());
    }

    #[test]
    fn rejects_hostile_user_ids() {
        let h = bearer("dev.../../etc.write");
        assert!(identity_from_headers(&h, &dev()).is_err());
    }

    #[test]
    fn un_billet_signe_est_accepte() {
        let token = ticket(serde_json::json!({
            "sub": "alice", "name": "Alice", "scope": "write", "exp": dans_une_heure(),
        }));
        let id = identity_from_headers(&bearer(&token), &jwt()).unwrap();
        assert_eq!(id.user_id, "alice");
        assert_eq!(id.display_name, "Alice");
        assert!(id.scope.can_write());
    }

    #[test]
    fn une_signature_forgee_est_refusee() {
        // C'est très exactement l'attaque que la version précédente laissait
        // passer : décoder sans vérifier acceptait ce jeton.
        let token = signe_avec(
            serde_json::json!({ "sub": "alice", "scope": "write", "exp": dans_une_heure() }),
            b"pas-le-bon-secret",
            r#"{"alg":"HS256","typ":"JWT"}"#,
        );
        assert!(identity_from_headers(&bearer(&token), &jwt()).is_err());
    }

    #[test]
    fn une_charge_utile_modifiee_invalide_la_signature() {
        let token = ticket(serde_json::json!({
            "sub": "bob", "scope": "read", "exp": dans_une_heure(),
        }));
        let mut parts: Vec<&str> = token.split('.').collect();
        let eleve = base64_url_encode(
            serde_json::json!({ "sub": "bob", "scope": "write", "exp": dans_une_heure() })
                .to_string()
                .as_bytes(),
        );
        parts[1] = &eleve;
        assert!(identity_from_headers(&bearer(&parts.join(".")), &jwt()).is_err());
    }

    #[test]
    fn alg_none_est_refuse() {
        let claims =
            serde_json::json!({ "sub": "alice", "scope": "write", "exp": dans_une_heure() });
        let header_b64 = base64_url_encode(br#"{"alg":"none","typ":"JWT"}"#);
        let payload_b64 = base64_url_encode(claims.to_string().as_bytes());
        let token = format!("{header_b64}.{payload_b64}.");
        assert!(identity_from_headers(&bearer(&token), &jwt()).is_err());
    }

    #[test]
    fn un_billet_expire_est_refuse() {
        let token = ticket(serde_json::json!({
            "sub": "alice", "scope": "write", "exp": chrono::Utc::now().timestamp() - 1,
        }));
        assert!(identity_from_headers(&bearer(&token), &jwt()).is_err());
    }

    #[test]
    fn un_billet_sans_expiration_est_refuse() {
        let token = ticket(serde_json::json!({ "sub": "alice", "scope": "write" }));
        assert!(identity_from_headers(&bearer(&token), &jwt()).is_err());
    }

    #[test]
    fn un_billet_a_validite_excessive_est_refuse() {
        let token = ticket(serde_json::json!({
            "sub": "alice", "scope": "write",
            "exp": chrono::Utc::now().timestamp() + 30 * 24 * 3600,
        }));
        assert!(identity_from_headers(&bearer(&token), &jwt()).is_err());
    }

    #[test]
    fn le_mode_jwt_sans_secret_naccepte_rien() {
        let sans_secret = AuthSettings {
            mode: AuthMode::Jwt,
            jwt_secret: None,
        };
        assert!(!sans_secret.is_usable());
        let token = ticket(serde_json::json!({
            "sub": "alice", "scope": "write", "exp": dans_une_heure(),
        }));
        assert!(identity_from_headers(&bearer(&token), &sans_secret).is_err());
    }

    #[test]
    fn un_billet_lie_nouvre_que_son_document() {
        let sien = Uuid::now_v7();
        let autre = Uuid::now_v7();
        let token = ticket(serde_json::json!({
            "sub": "alice", "scope": "write", "exp": dans_une_heure(), "doc": sien.to_string(),
        }));
        let id = identity_from_headers(&bearer(&token), &jwt()).unwrap();
        assert_eq!(id.doc_binding, Some(sien));
        assert!(id.ensure_document(sien).is_ok());
        assert!(id.ensure_document(autre).is_err());
    }

    #[test]
    fn un_lien_de_document_illisible_est_un_refus() {
        // Tolérer une valeur illisible ferait d'une faute de frappe un
        // passe-partout : le billet deviendrait valable sur tous les documents.
        let token = ticket(serde_json::json!({
            "sub": "alice", "scope": "write", "exp": dans_une_heure(), "doc": "pas-un-uuid",
        }));
        assert!(identity_from_headers(&bearer(&token), &jwt()).is_err());
    }

    #[test]
    fn un_jeton_non_lie_ouvre_le_document_demande() {
        let id = identity_from_headers(&bearer("dev.alice.write"), &dev()).unwrap();
        assert!(id.ensure_document(Uuid::now_v7()).is_ok());
    }

    #[test]
    fn une_portee_illisible_retombe_en_lecture() {
        let token = ticket(serde_json::json!({
            "sub": "alice", "scope": "administrateur", "exp": dans_une_heure(),
        }));
        let id = identity_from_headers(&bearer(&token), &jwt()).unwrap();
        assert_eq!(id.scope, Scope::Read);
    }

    #[test]
    fn origin_must_be_allowlisted() {
        let allowed = vec!["http://localhost:5173".to_string()];
        let ok = headers_with(header::ORIGIN, "http://localhost:5173");
        let evil = headers_with(header::ORIGIN, "https://evil.example");
        assert!(origin_allowed(&ok, &allowed));
        assert!(!origin_allowed(&evil, &allowed));
    }
}
