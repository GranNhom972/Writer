// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors

/**
 * REST client of the sharing server (`writer/server`).
 *
 * Every error comes back in the normalized RFC 9457 form that the server emits, and `ApiError` keeps its code and type:
 * the interface can therefore tell "server unreachable" from "you are not on the list", which do not call for the same
 * message.
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

/** What creating a share and reading it return. */
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

/** What `POST /sessions/{token_session}/join` returns. */
export interface SessionJoin {
  token_session: string;
  doc_id: string;
  title: string;
  user_id: string;
  email: string;
  permission: Permission;
  /** Access token handed out in development mode; `null` in JWT mode. */
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

  /** The server did not answer: the normal case offline, not an anomaly. */
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
        // Joining a share is the only call without a token: it is precisely the one that hands one out.
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

/* ------------------------------------------------------------------ sharing */

export interface ShareRequest {
  tokenSession: string;
  title: string;
  participants: { email: string; permission: Permission }[];
  document: WriterDocumentState;
}

/**
 * Shares a document: creates the session, its participant list and the underlying document.
 *
 * The `token_session` is chosen **here** and not by the server: it travels in a link, and an identifier you can compose
 * yourself ("report-q3-...") stays recognizable in a mailbox.
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

/** Does the share exist? A public read: the addresses are masked in it. */
export function getSession(tokenSession: string): Promise<SessionSummary> {
  return request<SessionSummary>(`/sessions/${encodeURIComponent(tokenSession)}`, null);
}

export function listSessions(): Promise<{ sessions: (SessionSummary & { participants: number })[] }> {
  return request('/sessions', null);
}

/**
 * Joins a share by its token and the participant's address.
 *
 * The permission returned is the one **written in the session**, never the one the client would claim: the WebSocket
 * applies the same rule, so there is nothing to gain by lying here.
 */
export function joinSession(tokenSession: string, email: string): Promise<SessionJoin> {
  return request<SessionJoin>(`/sessions/${encodeURIComponent(tokenSession)}/join`, null, {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
}

/** Adds someone to an existing share. Reserved to participants with write access. */
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
 * Renames a document.
 *
 * The title is already replicated by the `set-meta` operation (visible to everyone at once); this call makes it durable for
 * the document list, where it is read without opening the content.
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
  /** Address to put in the run. Relative: it follows the document. */
  url: string;
  name: string;
  content_type: string;
  size_bytes: number;
}

/**
 * Uploads an image to the server.
 *
 * The body goes **raw**: the server ignores the announced `Content-Type` anyway and recognizes the format from the bytes (a
 * file claimed to be PNG but containing HTML would be served from our origin, which is a stored XSS). A multipart would only
 * add an encoding to undo on both sides.
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
 * Converts a `data:` URL to a `Blob`, to upload it.
 *
 * An image inserted offline lives in the document as a `data:` URL. At sharing time, leaving it as it is would send it over the
 * network again on **every keystroke** in its paragraph, hence this transfer, once, to the server's store.
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

/** A readable, hard-to-guess session token (`MIN_TOKEN_LEN` on the server side). */
export function generateSessionToken(title: string): string {
  const racine = title
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);

  // Randomness is the only part that matters: the token reveals that a share exists, so the make-up of a team. A short suffix
  // would make it enumerable, and the readable part only helps people find their way.
  const octets = new Uint8Array(8);
  crypto.getRandomValues(octets);
  const alea = Array.from(octets, (b) => b.toString(16).padStart(2, '0')).join('');

  return racine ? `${racine}-${alea}` : `document-${alea}`;
}
