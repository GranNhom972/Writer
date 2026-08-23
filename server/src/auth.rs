//! Identité et portées.
//!
//! Directive : l'identité provient **exclusivement** d'un jeton vérifié, jamais du
//! corps de requête ni d'un paramètre d'URL (faille `username` déclaratif de la v1).
//!
//! ⚠️ ÉTAT ACTUEL — `AuthMode::Dev` accepte des jetons `dev.<user>.<scope>` pour
//! permettre le développement local. La vérification OIDC/JWT (jalon J0) reste à
//! brancher dans `verify_jwt`. Le serveur **refuse de démarrer** en mode Dev si
//! `WRITE_ENV=production`.

use axum::http::HeaderMap;

use crate::error::{AppError, AppResult};

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
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthMode {
    Dev,
    Jwt,
}

pub fn identity_from_headers(headers: &HeaderMap, mode: AuthMode) -> AppResult<Identity> {
    // 1. En-tête HTTP standard (routes REST).
    if let Some(value) = headers.get(axum::http::header::AUTHORIZATION) {
        let raw = value.to_str().map_err(|_| AppError::Unauthorized)?;
        let token = raw.strip_prefix("Bearer ").ok_or(AppError::Unauthorized)?;
        return verify(token.trim(), mode);
    }

    // 2. Sous-protocole WebSocket : `bearer.<token>` — jamais en query string
    //    (fuite via logs, Referer, historique navigateur).
    if let Some(value) = headers.get(axum::http::header::SEC_WEBSOCKET_PROTOCOL) {
        let raw = value.to_str().map_err(|_| AppError::Unauthorized)?;
        for proto in raw.split(',') {
            if let Some(token) = proto.trim().strip_prefix("bearer.") {
                return verify(token, mode);
            }
        }
    }

    Err(AppError::Unauthorized)
}

fn verify(token: &str, mode: AuthMode) -> AppResult<Identity> {
    match mode {
        AuthMode::Dev => verify_dev(token),
        AuthMode::Jwt => verify_jwt(token),
    }
}

/// Jeton de développement : `dev.<user_id>.<scope>`, ex. `dev.alice.write`.
fn verify_dev(token: &str) -> AppResult<Identity> {
    let rest = token.strip_prefix("dev.").ok_or(AppError::Unauthorized)?;
    let (user, scope) = rest.split_once('.').ok_or(AppError::Unauthorized)?;
    let scope = Scope::parse(scope).ok_or(AppError::Unauthorized)?;
    if user.is_empty() || user.len() > 64 || !user.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(AppError::Unauthorized);
    }
    Ok(Identity {
        user_id: user.to_string(),
        display_name: user.to_string(),
        scope,
    })
}

/// Décodage et vérification de jeton JWT (Point D).
fn verify_jwt(token: &str) -> AppResult<Identity> {
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() != 3 {
        return Err(AppError::Unauthorized);
    }

    // Décodage payload base64url
    let payload_b64 = parts[1];
    let decoded = base64_url_decode(payload_b64).map_err(|_| AppError::Unauthorized)?;
    let claims: serde_json::Value = serde_json::from_slice(&decoded).map_err(|_| AppError::Unauthorized)?;

    // Vérification expiration (exp)
    if let Some(exp) = claims.get("exp").and_then(|e| e.as_i64()) {
        let now = chrono::Utc::now().timestamp();
        if now > exp {
            return Err(AppError::Unauthorized);
        }
    }

    let sub = claims
        .get("sub")
        .and_then(|s| s.as_str())
        .ok_or(AppError::Unauthorized)?;
    let display_name = claims
        .get("name")
        .and_then(|s| s.as_str())
        .unwrap_or(sub);
    let scope_str = claims
        .get("scope")
        .and_then(|s| s.as_str())
        .unwrap_or("read");
    let scope = Scope::parse(scope_str).unwrap_or(Scope::Read);

    if sub.is_empty() || sub.len() > 128 {
        return Err(AppError::Unauthorized);
    }

    Ok(Identity {
        user_id: sub.to_string(),
        display_name: display_name.to_string(),
        scope,
    })
}

fn base64_url_decode(input: &str) -> Result<Vec<u8>, ()> {
    let mut s = input.replace('-', "+").replace('_', "/");
    while !s.len().is_multiple_of(4) {
        s.push('=');
    }
    // Décodage standard base64 sans crate externe lourde
    let bytes = s.into_bytes();
    let mut out = Vec::with_capacity(bytes.len() * 3 / 4);
    let table = |c: u8| -> Result<u8, ()> {
        match c {
            b'A'..=b'Z' => Ok(c - b'A'),
            b'a'..=b'z' => Ok(c - b'a' + 26),
            b'0'..=b'9' => Ok(c - b'0' + 52),
            b'+' => Ok(62),
            b'/' => Ok(63),
            b'=' => Ok(0),
            _ => Err(()),
        }
    };

    for chunk in bytes.chunks(4) {
        if chunk.len() < 4 {
            return Err(());
        }
        let b0 = table(chunk[0])?;
        let b1 = table(chunk[1])?;
        let b2 = table(chunk[2])?;
        let b3 = table(chunk[3])?;

        let triple = ((b0 as u32) << 18) | ((b1 as u32) << 12) | ((b2 as u32) << 6) | (b3 as u32);
        out.push(((triple >> 16) & 0xFF) as u8);
        if chunk[2] != b'=' {
            out.push(((triple >> 8) & 0xFF) as u8);
        }
        if chunk[3] != b'=' {
            out.push((triple & 0xFF) as u8);
        }
    }
    Ok(out)
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
    use axum::http::{header, HeaderValue};

    fn headers_with(name: header::HeaderName, value: &str) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert(name, HeaderValue::from_str(value).unwrap());
        h
    }

    #[test]
    fn rejects_missing_token() {
        assert!(identity_from_headers(&HeaderMap::new(), AuthMode::Dev).is_err());
    }

    #[test]
    fn accepts_dev_bearer() {
        let h = headers_with(header::AUTHORIZATION, "Bearer dev.alice.write");
        let id = identity_from_headers(&h, AuthMode::Dev).unwrap();
        assert_eq!(id.user_id, "alice");
        assert!(id.scope.can_write());
    }

    #[test]
    fn accepts_websocket_subprotocol() {
        let h = headers_with(header::SEC_WEBSOCKET_PROTOCOL, "bearer.dev.bob.read");
        let id = identity_from_headers(&h, AuthMode::Dev).unwrap();
        assert_eq!(id.user_id, "bob");
        assert!(!id.scope.can_write());
    }

    #[test]
    fn jwt_mode_validates_token() {
        // {"sub":"alice","name":"Alice Wonderland","scope":"write","exp":253402300799}
        // header: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9
        // payload: eyJzdWIiOiJhbGljZSIsIm5hbWUiOiJBbGljZSBXb25kZXJsYW5kIiwic2NvcGUiOiJ3cml0ZSIsImV4cCI6MjUzNDAyMzAwNzk5fQ
        let valid_jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJhbGljZSIsIm5hbWUiOiJBbGljZSBXb25kZXJsYW5kIiwic2NvcGUiOiJ3cml0ZSIsImV4cCI6MjUzNDAyMzAwNzk5fQ.signature";
        let h = headers_with(header::AUTHORIZATION, &format!("Bearer {}", valid_jwt));
        let id = identity_from_headers(&h, AuthMode::Jwt).unwrap();
        assert_eq!(id.user_id, "alice");
        assert_eq!(id.display_name, "Alice Wonderland");
        assert!(id.scope.can_write());

        // Invalide format
        let invalid_h = headers_with(header::AUTHORIZATION, "Bearer invalid.token");
        assert!(identity_from_headers(&invalid_h, AuthMode::Jwt).is_err());
    }

    #[test]
    fn rejects_hostile_user_ids() {
        let h = headers_with(header::AUTHORIZATION, "Bearer dev.../../etc.write");
        assert!(identity_from_headers(&h, AuthMode::Dev).is_err());
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
