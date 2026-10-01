// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Les contributeurs de Writer

/**
 * Client REST du serveur de partage (`writer/server`).
 *
 * Toute erreur remonte sous la forme normalisée RFC 9457 que le serveur émet, et
 * `ApiError` en conserve le code et le type : l'interface peut ainsi distinguer
 * « serveur injoignable » de « vous n'êtes pas sur la liste », qui n'appellent
 * pas le même message.
 */

import type { WriterDocumentState } from '../document/types';
import { MAX_IMAGE_BYTES } from '../document/images';

export type Permission = 'read' | 'comment' | 'write';

export interface DocumentSummary {
  doc_id: string;
  kind: string;
  title: string;
  owner: string;
  created_at: string;
  revision?: number;
  active_clients?: number;
}

export interface ParticipantSummary {
  user_id: string;
  email: string;
  permission: Permission;
}

/** Ce que renvoient la création d'un partage et sa lecture. */
export interface SessionSummary {
  token_session: string;
  doc_id: string;
  title: string;
  created_at: string;
  created_by: string;
  participants: ParticipantSummary[];
  sync_path: string;
  events_path: string;
}

/** Ce que renvoie `POST /sessions/{token_session}/join`. */
export interface SessionJoin {
  token_session: string;
  doc_id: string;
  title: string;
  user_id: string;
  email: string;
  permission: Permission;
  /** Jeton d'accès délivré en mode développement ; `null` en mode JWT. */
  access_token: string | null;
  auth_mode: 'dev' | 'jwt';
  sync_path: string;
  events_path: string;
  editor_path: string;
}

export interface DocumentSnapshot {
  doc_id: string;
  revision: number;
  document: WriterDocumentState;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly kind: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** Le serveur n'a pas répondu — cas nominal hors ligne, pas une anomalie. */
  get isOffline(): boolean {
    return this.status === 0;
  }
}

async function request<T>(path: string, token: string | null, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        // Rejoindre un partage est le seul appel sans jeton : c'est précisément
        // celui qui en délivre un.
        ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
        ...(init?.headers ?? {}),
      },
    });
  } catch {
    throw new ApiError('Serveur de partage injoignable.', 0, 'offline');
  }

  if (!response.ok) {
    const problem = (await response.json().catch(() => null)) as
      | { detail?: string; title?: string }
      | null;
    throw new ApiError(
      problem?.detail ?? 'Erreur inattendue du serveur.',
      response.status,
      problem?.title ?? 'unknown',
    );
  }

  return (await response.json()) as T;
}

/* ------------------------------------------------------------------ partage */

export interface ShareRequest {
  tokenSession: string;
  title: string;
  participants: { email: string; permission: Permission }[];
  document: WriterDocumentState;
}

/**
 * Partage un document : crée la session, sa liste de participants et le
 * document sous-jacent.
 *
 * Le `token_session` est choisi **ici** et non par le serveur : il voyage dans
 * un lien, et un identifiant qu'on peut composer soi-même (« rapport-q3-… »)
 * reste reconnaissable dans une boîte aux lettres.
 */
export function shareDocument(request_: ShareRequest): Promise<SessionSummary> {
  return request<SessionSummary>('/sessions', null, {
    method: 'POST',
    body: JSON.stringify({
      token_session: request_.tokenSession,
      title: request_.title,
      participants: request_.participants,
      document: request_.document,
    }),
  });
}

/** Le partage existe-t-il ? Lecture publique : les adresses y sont masquées. */
export function getSession(tokenSession: string): Promise<SessionSummary> {
  return request<SessionSummary>(`/sessions/${encodeURIComponent(tokenSession)}`, null);
}

export function listSessions(): Promise<{ sessions: (SessionSummary & { participants: number })[] }> {
  return request('/sessions', null);
}

/**
 * Rejoint un partage par son jeton et l'adresse du participant.
 *
 * La permission renvoyée est celle **inscrite dans la session**, jamais celle
 * que le client réclamerait : le WebSocket applique la même règle, et il n'y a
 * donc rien à gagner à mentir ici.
 */
export function joinSession(tokenSession: string, email: string): Promise<SessionJoin> {
  return request<SessionJoin>(`/sessions/${encodeURIComponent(tokenSession)}/join`, null, {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
}

/** Ajoute quelqu'un à un partage existant. Réservé aux participants en écriture. */
export function inviteParticipant(
  token: string,
  tokenSession: string,
  email: string,
  permission: Permission,
): Promise<{ session: SessionSummary; editor_path: string }> {
  return request(`/sessions/${encodeURIComponent(tokenSession)}/participants`, token, {
    method: 'POST',
    body: JSON.stringify({ email, permission }),
  });
}

/* ---------------------------------------------------------------- documents */

export function getDocument(token: string, docId: string): Promise<DocumentSummary> {
  return request<DocumentSummary>(`/documents/${docId}`, token);
}

export function getSnapshot(token: string, docId: string): Promise<DocumentSnapshot> {
  return request<DocumentSnapshot>(`/documents/${docId}/snapshot`, token);
}

/**
 * Renomme un document.
 *
 * Le titre est déjà répliqué par l'opération `set-meta` (visible chez tous
 * immédiatement) ; cet appel le rend durable pour la liste des documents, où il
 * est lu sans ouvrir le contenu.
 */
export function renameDocument(
  token: string,
  docId: string,
  title: string,
): Promise<DocumentSummary> {
  return request<DocumentSummary>(`/documents/${docId}`, token, {
    method: 'PATCH',
    body: JSON.stringify({ title }),
  });
}

export interface RestorePoint {
  id: string;
  size_bytes: number;
}

export function listRestorePoints(
  token: string,
  docId: string,
): Promise<{ restore_points: RestorePoint[] }> {
  return request(`/documents/${docId}/restore-points`, token);
}

export function restoreDocument(
  token: string,
  docId: string,
  restorePoint: string,
  title?: string,
): Promise<{ doc_id: string; title: string }> {
  return request(`/documents/${docId}/restore`, token, {
    method: 'POST',
    body: JSON.stringify({ restore_point: restorePoint, ...(title ? { title } : {}) }),
  });
}

/* ------------------------------------------------------------------- images */

export interface UploadedAsset {
  /** Adresse à ranger dans le run. Relative : elle suit le document. */
  url: string;
  name: string;
  content_type: string;
  size_bytes: number;
}

/**
 * Dépose une image sur le serveur.
 *
 * Le corps part **brut** : le serveur ignore de toute façon le `Content-Type`
 * annoncé et reconnaît le format aux octets — un fichier prétendument PNG mais
 * contenant du HTML serait servi depuis notre origine, c'est-à-dire un XSS
 * stocké. Un multipart n'ajouterait ici qu'un encodage à défaire des deux côtés.
 */
export async function uploadAsset(
  token: string,
  docId: string,
  fichier: Blob,
): Promise<UploadedAsset> {
  if (fichier.size > MAX_IMAGE_BYTES) {
    throw new ApiError('Image trop lourde (4 Mo maximum).', 413, 'payload-too-large');
  }

  let response: Response;
  try {
    response = await fetch(`/api/v1/documents/${docId}/assets`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': fichier.type || 'application/octet-stream',
      },
      body: fichier,
    });
  } catch {
    throw new ApiError('Serveur de partage injoignable.', 0, 'offline');
  }

  if (!response.ok) {
    const problem = (await response.json().catch(() => null)) as
      | { detail?: string; title?: string }
      | null;
    throw new ApiError(
      problem?.detail ?? 'Image refusée par le serveur.',
      response.status,
      problem?.title ?? 'unknown',
    );
  }

  return (await response.json()) as UploadedAsset;
}

/**
 * Convertit une `data:` en `Blob`, pour la déposer.
 *
 * Une image insérée hors ligne vit dans le document sous forme de `data:`. Au
 * moment du partage, la laisser telle quelle la ferait repartir sur le réseau à
 * **chaque frappe** dans son paragraphe — d'où ce transfert, une fois, vers le
 * dépôt du serveur.
 */
export function dataUrlToBlob(dataUrl: string): Blob | null {
  const match = /^data:([^;,]+);base64,([\s\S]*)$/i.exec(dataUrl.trim());
  if (!match) return null;
  try {
    const binaire = atob(match[2]!.replace(/\s+/g, ''));
    const octets = new Uint8Array(binaire.length);
    for (let i = 0; i < binaire.length; i += 1) octets[i] = binaire.charCodeAt(i);
    return new Blob([octets], { type: match[1]! });
  } catch {
    return null;
  }
}

/** Un jeton de session lisible et non devinable — `MIN_TOKEN_LEN` côté serveur. */
export function generateSessionToken(title: string): string {
  const racine = title
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);

  // Le hasard est la seule part qui compte : le jeton révèle l'existence d'un
  // partage, donc la composition d'une équipe. Un suffixe court le rendrait
  // énumérable, et la partie lisible ne fait qu'aider à s'y retrouver.
  const octets = new Uint8Array(8);
  crypto.getRandomValues(octets);
  const alea = Array.from(octets, (b) => b.toString(16).padStart(2, '0')).join('');

  return racine ? `${racine}-${alea}` : `document-${alea}`;
}
