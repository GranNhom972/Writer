//! Sessions collaboratives — `token_session`, participants, permissions.
//!
//! Une **session** nomme un document par un jeton choisi par le client
//! (`token_session`) et lui attache la liste des personnes qui y ont accès, avec
//! l'adresse électronique et la permission de chacune.
//!
//! ## Pourquoi un identifiant fourni par le client, alors que `doc_id` est généré ?
//!
//! Parce que ce sont deux choses différentes, et que la v1 les confondait
//! (`unique_signature`, cf. `AUDIT_CRITIQUE.md`). Ici :
//!
//! - `token_session` **nomme** la session. Il est public, transmis par courriel ou
//!   par lien, et il ne donne aucun droit à lui seul.
//! - l'**appartenance à la liste des participants** ouvre l'accès, et c'est elle
//!   qui fixe la permission. Connaître le jeton ne suffit donc pas.
//! - le `doc_id` reste généré par le serveur (UUIDv7) : c'est lui qui adresse le
//!   document dans le stockage et dans le WebSocket de synchronisation.
//!
//! Le jeton doit néanmoins être **non devinable** (`MIN_TOKEN_LEN`) : il révèle
//! l'existence d'une session, et les adresses des participants sont masquées en
//! lecture pour ne pas transformer cette existence en fuite d'annuaire.

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    Json,
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::Arc;
use uuid::Uuid;

use crate::api::DocumentMeta;
use crate::auth::{identity_from_headers, AuthMode, Scope};
use crate::content::DocumentData;
use crate::doc::DocHandle;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// Longueur minimale d'un `token_session`. Un jeton court serait énumérable :
/// l'existence d'une session, et donc la composition d'une équipe, se devinerait.
pub const MIN_TOKEN_LEN: usize = 12;
pub const MAX_TOKEN_LEN: usize = 128;
pub const MAX_PARTICIPANTS: usize = 200;
const MAX_TITLE_LEN: usize = 200;
const MAX_EMAIL_LEN: usize = 254;

// ── Modèle ───────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Participant {
    pub user_id: String,
    pub email: String,
    pub permission: String,
}

impl Participant {
    pub fn scope(&self) -> Scope {
        // Une permission illisible ne DOIT pas ouvrir plus de droits qu'écrit :
        // en cas de doute, lecture seule.
        Scope::parse(&self.permission).unwrap_or(Scope::Read)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionRecord {
    pub token_session: String,
    pub doc_id: Uuid,
    pub title: String,
    pub created_at: String,
    pub created_by: String,
    pub participants: Vec<Participant>,
}

impl SessionRecord {
    pub fn find_by_email(&self, email: &str) -> Option<&Participant> {
        let needle = email.trim().to_ascii_lowercase();
        self.participants
            .iter()
            .find(|p| p.email.to_ascii_lowercase() == needle)
    }

    pub fn find_by_user(&self, user_id: &str) -> Option<&Participant> {
        self.participants.iter().find(|p| p.user_id == user_id)
    }
}

// ── Validation des entrées ───────────────────────────────────────────────────

/// `token_session` recevable : il sert de nom de fichier, donc rien qui puisse
/// sortir du répertoire des sessions.
pub fn valid_token(token: &str) -> bool {
    token.len() >= MIN_TOKEN_LEN
        && token.len() <= MAX_TOKEN_LEN
        && token
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Contrôle volontairement sommaire : il écarte les entrées absurdes sans
/// prétendre décider ce qu'est une adresse valide — seul un envoi le prouve.
fn valid_email(email: &str) -> bool {
    if email.is_empty() || email.len() > MAX_EMAIL_LEN || email.chars().any(char::is_whitespace) {
        return false;
    }
    match email.split_once('@') {
        Some((local, domain)) => {
            !local.is_empty() && domain.contains('.') && !domain.starts_with('.') && !domain.ends_with('.')
        }
        None => false,
    }
}

/// Identifiant technique déduit de l'adresse quand le client n'en fournit pas.
fn user_id_from_email(email: &str) -> Option<String> {
    let local = email.split('@').next()?;
    let id: String = local
        .to_ascii_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '_' })
        .collect();
    (!id.is_empty() && id.len() <= 64).then_some(id)
}

fn valid_user_id(user_id: &str) -> bool {
    !user_id.is_empty()
        && user_id.len() <= 64
        && user_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Masque une adresse pour les lectures non authentifiées : `alice@exemple.fr`
/// devient `a****@exemple.fr`. Confirmer une session ne DOIT pas livrer l'annuaire
/// de ses participants.
fn mask_email(email: &str) -> String {
    match email.split_once('@') {
        Some((local, domain)) => {
            let first = local.chars().next().unwrap_or('*');
            format!("{first}{}@{domain}", "*".repeat(local.chars().count().saturating_sub(1)))
        }
        None => "***".to_string(),
    }
}

fn percent_encode(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for byte in raw.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

pub fn editor_path(token_session: &str, email: &str) -> String {
    format!(
        "/?session={}&email={}",
        percent_encode(token_session),
        percent_encode(email)
    )
}

// ── Requêtes ─────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct ParticipantInput {
    #[serde(default)]
    pub user_id: Option<String>,
    pub email: String,
    /// `read`, `comment` ou `write`. Absente, la permission la plus faible s'applique.
    #[serde(default)]
    pub permission: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CreateSessionRequest {
    /// Étape 1 : la signature unique de la session, fournie par le client.
    pub token_session: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub participants: Vec<ParticipantInput>,
    /// « data doc » : contenu initial du document.
    #[serde(default)]
    pub document: Option<DocumentData>,
}

#[derive(Debug, Deserialize)]
pub struct JoinSessionRequest {
    pub email: String,
}

// ── Routes ───────────────────────────────────────────────────────────────────

/// `POST /api/v1/sessions` — étapes 2 et 3 : vérifier l'unicité, puis créer.
pub async fn create_session(
    State(state): State<AppState>,
    Json(body): Json<CreateSessionRequest>,
) -> AppResult<impl IntoResponse> {
    let token_session = body.token_session.trim().to_string();
    if !valid_token(&token_session) {
        return Err(AppError::BadRequest(format!(
            "token_session: {MIN_TOKEN_LEN} à {MAX_TOKEN_LEN} caractères, alphanumériques, « - » ou « _ »"
        )));
    }

    // Étape 2 — vérification explicite : refuser tôt, et avec un message qui dit
    // pourquoi. L'unicité réelle est tranchée plus bas par la création exclusive du
    // fichier de session ; ce test seul laisserait une fenêtre de course entre deux
    // créations simultanées du même jeton.
    {
        let store = state.store.clone();
        let token = token_session.clone();
        let exists = tokio::task::spawn_blocking(move || store.session_exists(&token))
            .await
            .map_err(|e| AppError::Crdt(e.to_string()))?;
        if exists {
            return Err(AppError::Conflict(format!(
                "une session porte déjà le jeton « {token_session} »"
            )));
        }
    }

    let title = body
        .title
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| "Document sans titre".to_string());
    if title.chars().count() > MAX_TITLE_LEN {
        return Err(AppError::BadRequest("title: titre trop long".into()));
    }

    let participants = normalize_participants(body.participants)?;
    let created_by = participants
        .iter()
        .find(|p| p.scope() == Scope::Write)
        .or_else(|| participants.first())
        .map(|p| p.user_id.clone())
        .unwrap_or_else(|| "inconnu".to_string());

    // Le contenu initial est converti en update CRDT **avant** toute écriture :
    // un document invalide ne DOIT pas laisser derrière lui une session à demi créée.
    let data = body.document.unwrap_or_default();
    let seed = crate::content::seed_update(&data)?;

    let doc_id = Uuid::now_v7();
    let record = SessionRecord {
        token_session: token_session.clone(),
        doc_id,
        title: title.clone(),
        created_at: Utc::now().to_rfc3339(),
        created_by,
        participants,
    };
    let record_json = serde_json::to_string_pretty(&record)
        .map_err(|e| AppError::BadRequest(format!("session illisible: {e}")))?;

    // Étape 2 — l'unicité est tranchée par le stockage (création exclusive), donc
    // sans fenêtre de course entre deux créations simultanées du même jeton.
    let store = state.store.clone();
    let token_for_claim = token_session.clone();
    tokio::task::spawn_blocking(move || store.create_session(&token_for_claim, &record_json))
        .await
        .map_err(|e| AppError::Crdt(e.to_string()))??;

    // Étape 3 — le document sous-jacent, puis son contenu initial journalisé.
    if let Err(e) = install_document(&state, &record, &title, &seed).await {
        let store = state.store.clone();
        let token = token_session.clone();
        // Sans ce retrait, le jeton resterait pris par une session sans document.
        let _ = tokio::task::spawn_blocking(move || store.remove_session(&token)).await;
        return Err(e);
    }

    let record = Arc::new(record);
    state.insert_session(record.clone());
    tracing::info!(
        token_session = %record.token_session,
        doc_id = %record.doc_id,
        participants = record.participants.len(),
        blocs = data.blocks.len(),
        "session créée"
    );

    Ok((StatusCode::CREATED, Json(describe(&record, true))))
}

async fn install_document(
    state: &AppState,
    record: &SessionRecord,
    title: &str,
    seed: &[u8],
) -> AppResult<()> {
    let meta = DocumentMeta {
        doc_id: record.doc_id,
        kind: "write".into(),
        title: title.to_string(),
        owner_id: record.created_by.clone(),
        created_at: record.created_at.clone(),
    };
    let meta_json = serde_json::to_string(&meta)
        .map_err(|e| AppError::BadRequest(format!("métadonnées invalides: {e}")))?;

    let store = state.store.clone();
    let key = record.doc_id.to_string();
    let payload = seed.to_vec();
    tokio::task::spawn_blocking(move || {
        store.create(&key, &meta_json)?;
        // Journalisé comme n'importe quelle frappe : le contenu initial est durable
        // avant même que quiconque ouvre le document.
        store.append_update(&key, &payload)?;
        Ok::<_, AppError>(())
    })
    .await
    .map_err(|e| AppError::Crdt(e.to_string()))??;

    let handle = Arc::new(DocHandle::new(record.doc_id));
    handle.apply_update(seed)?;
    state.insert_doc(handle);
    Ok(())
}

/// `GET /api/v1/sessions/{token_session}` — étape 2 : la session existe-t-elle ?
///
/// Lecture publique et volontairement pauvre : elle confirme l'existence et donne
/// de quoi rejoindre, sans livrer les adresses des participants.
pub async fn get_session(
    State(state): State<AppState>,
    Path(token_session): Path<String>,
) -> AppResult<impl IntoResponse> {
    let record = state.session(&token_session)?;
    Ok(Json(describe(&record, false)))
}

/// `GET /api/v1/sessions` — inventaire, utile aux exemples (« rejoindre la dernière »).
pub async fn list_sessions(State(state): State<AppState>) -> AppResult<impl IntoResponse> {
    let store = state.store.clone();
    let tokens = tokio::task::spawn_blocking(move || store.list_sessions())
        .await
        .map_err(|e| AppError::Crdt(e.to_string()))??;

    let mut sessions: Vec<serde_json::Value> = Vec::new();
    for token in tokens {
        if let Ok(record) = state.session(&token) {
            sessions.push(json!({
                "token_session": record.token_session,
                "doc_id": record.doc_id,
                "title": record.title,
                "created_at": record.created_at,
                "participants": record.participants.len(),
            }));
        }
    }
    sessions.sort_by(|a, b| a["created_at"].as_str().cmp(&b["created_at"].as_str()));

    Ok(Json(json!({ "sessions": sessions })))
}

/// `POST /api/v1/sessions/{token_session}/join` — étape 3 côté participant.
///
/// La permission renvoyée est celle **inscrite dans la session**, jamais celle que
/// l'appelant réclame : le WebSocket de synchronisation applique la même règle.
pub async fn join_session(
    State(state): State<AppState>,
    Path(token_session): Path<String>,
    headers: HeaderMap,
    Json(body): Json<JoinSessionRequest>,
) -> AppResult<impl IntoResponse> {
    // Étape 2 — la session doit exister.
    let record = state.session(&token_session)?;

    // Étape 3 — être inscrit sur la liste. `Forbidden` et non `NotFound` : à ce
    // stade l'existence de la session est déjà connue de l'appelant.
    let participant = record
        .find_by_email(&body.email)
        .ok_or(AppError::Forbidden)?
        .clone();

    let access_token = match state.cfg.auth_mode {
        // En développement, l'inscription sur la liste tient lieu d'authentification :
        // c'est ce qui permet à un exemple de tourner sans fournisseur d'identité.
        AuthMode::Dev => Some(format!(
            "dev.{}.{}",
            participant.user_id,
            participant.scope().as_str()
        )),
        // En JWT, l'appelant prouve son identité et le serveur ne délivre rien :
        // il confirme seulement que ce jeton correspond à un participant.
        AuthMode::Jwt => {
            let identity = identity_from_headers(&headers, AuthMode::Jwt)?;
            if identity.user_id != participant.user_id {
                return Err(AppError::Forbidden);
            }
            None
        }
    };

    tracing::info!(
        token_session = %record.token_session,
        doc_id = %record.doc_id,
        user = %participant.user_id,
        permission = participant.scope().as_str(),
        "session rejointe"
    );

    Ok(Json(json!({
        "token_session": record.token_session,
        "doc_id": record.doc_id,
        "title": record.title,
        "user_id": participant.user_id,
        "email": participant.email,
        "permission": participant.scope().as_str(),
        "access_token": access_token,
        "auth_mode": match state.cfg.auth_mode { AuthMode::Dev => "dev", AuthMode::Jwt => "jwt" },
        "sync_path": format!("/api/v1/sync/{}", record.doc_id),
        "events_path": format!("/api/v1/sessions/{}/events", record.token_session),
        "editor_path": editor_path(&record.token_session, &participant.email),
    })))
}

/// Représentation renvoyée par les routes de lecture.
/// `full` n'est vrai qu'au retour immédiat de la création, pour la personne qui vient
/// de fournir elle-même la liste.
fn describe(record: &SessionRecord, full: bool) -> serde_json::Value {
    let participants: Vec<serde_json::Value> = record
        .participants
        .iter()
        .map(|p| {
            json!({
                "user_id": p.user_id,
                "email": if full { p.email.clone() } else { mask_email(&p.email) },
                "permission": p.scope().as_str(),
            })
        })
        .collect();

    json!({
        "token_session": record.token_session,
        "doc_id": record.doc_id,
        "title": record.title,
        "created_at": record.created_at,
        "created_by": record.created_by,
        "participants": participants,
        "sync_path": format!("/api/v1/sync/{}", record.doc_id),
        "events_path": format!("/api/v1/sessions/{}/events", record.token_session),
    })
}

fn normalize_participants(inputs: Vec<ParticipantInput>) -> AppResult<Vec<Participant>> {
    if inputs.is_empty() {
        return Err(AppError::BadRequest(
            "participants: au moins une personne est requise".into(),
        ));
    }
    if inputs.len() > MAX_PARTICIPANTS {
        return Err(AppError::BadRequest(format!(
            "participants: maximum {MAX_PARTICIPANTS}"
        )));
    }

    let mut out: Vec<Participant> = Vec::with_capacity(inputs.len());
    for (index, input) in inputs.into_iter().enumerate() {
        let email = input.email.trim().to_string();
        if !valid_email(&email) {
            return Err(AppError::BadRequest(format!(
                "participants[{index}].email: adresse invalide"
            )));
        }

        let user_id = match input.user_id.map(|id| id.trim().to_string()) {
            Some(id) if !id.is_empty() => id,
            _ => user_id_from_email(&email).ok_or_else(|| {
                AppError::BadRequest(format!(
                    "participants[{index}].user_id: impossible à déduire de l'adresse"
                ))
            })?,
        };
        if !valid_user_id(&user_id) {
            return Err(AppError::BadRequest(format!(
                "participants[{index}].user_id: alphanumérique, « - » ou « _ », 64 caractères maximum"
            )));
        }

        let permission = input.permission.unwrap_or_else(|| "read".into());
        let scope = Scope::parse(&permission).ok_or_else(|| {
            AppError::BadRequest(format!(
                "participants[{index}].permission: attendu « read », « comment » ou « write »"
            ))
        })?;

        // Deux entrées pour la même personne rendraient la permission effective
        // dépendante de l'ordre de lecture.
        if out
            .iter()
            .any(|p| p.email.eq_ignore_ascii_case(&email) || p.user_id == user_id)
        {
            return Err(AppError::BadRequest(format!(
                "participants[{index}]: doublon ({email})"
            )));
        }

        out.push(Participant {
            user_id,
            email,
            permission: scope.as_str().to_string(),
        });
    }

    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(email: &str, permission: &str) -> ParticipantInput {
        ParticipantInput {
            user_id: None,
            email: email.into(),
            permission: Some(permission.into()),
        }
    }

    #[test]
    fn short_or_hostile_tokens_are_refused() {
        assert!(!valid_token("court"));
        assert!(!valid_token("../../etc/passwd-aaaa"));
        assert!(!valid_token("jeton avec espaces"));
        assert!(valid_token("sess-rapport-q3-3f9c2a7d41b8"));
    }

    #[test]
    fn user_id_is_derived_from_the_email_when_absent() {
        let participants = normalize_participants(vec![input("Alice.Martin@exemple.fr", "write")]).unwrap();
        assert_eq!(participants[0].user_id, "alice_martin");
        assert_eq!(participants[0].permission, "write");
    }

    #[test]
    fn duplicate_participants_are_refused() {
        let result = normalize_participants(vec![
            input("alice@exemple.fr", "write"),
            input("ALICE@exemple.fr", "read"),
        ]);
        assert!(matches!(result, Err(AppError::BadRequest(_))));
    }

    #[test]
    fn unknown_permission_is_refused_rather_than_downgraded() {
        // Une faute de frappe (« writte ») doit se voir, pas se traduire en lecture
        // seule silencieuse.
        let result = normalize_participants(vec![input("alice@exemple.fr", "writte")]);
        assert!(matches!(result, Err(AppError::BadRequest(_))));
    }

    #[test]
    fn participants_are_looked_up_by_email_case_insensitively() {
        let record = SessionRecord {
            token_session: "sess-exemple-000001".into(),
            doc_id: Uuid::now_v7(),
            title: "T".into(),
            created_at: "2026-08-22T00:00:00Z".into(),
            created_by: "alice".into(),
            participants: normalize_participants(vec![input("Bob@Exemple.fr", "read")]).unwrap(),
        };
        assert!(record.find_by_email("bob@exemple.fr").is_some());
        assert!(record.find_by_email("carole@exemple.fr").is_none());
    }

    #[test]
    fn masked_email_keeps_the_domain_only() {
        assert_eq!(mask_email("alice@exemple.fr"), "a****@exemple.fr");
    }

    #[test]
    fn editor_path_escapes_the_email() {
        assert_eq!(
            editor_path("sess-abcdefghijkl", "alice+test@exemple.fr"),
            "/?session=sess-abcdefghijkl&email=alice%2Btest%40exemple.fr"
        );
    }
}
