/**
 * Client REST du serveur Rust (integration_api_rust.md §2).
 * Toute erreur est remontée sous la forme normalisée RFC 9457.
 */

export interface DocumentSummary {
  doc_id: string;
  kind: string;
  title: string;
  owner: string;
  created_at: string;
  active_clients?: number;
}

/** Ce que renvoie `POST /sessions/{token_session}/join`. */
export interface SessionJoin {
  token_session: string;
  doc_id: string;
  title: string;
  user_id: string;
  email: string;
  permission: 'read' | 'comment' | 'write';
  /** Jeton d'accès délivré en mode développement ; `null` en mode JWT. */
  access_token: string | null;
  auth_mode: 'dev' | 'jwt';
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
}

async function request<T>(path: string, token: string | null, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        // Rejoindre une session est le seul appel sans jeton : c'est précisément
        // celui qui en délivre un.
        ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
        ...(init?.headers ?? {}),
      },
    });
  } catch {
    // Réseau injoignable : cas nominal hors ligne, pas une anomalie.
    throw new ApiError('Serveur injoignable.', 0, 'offline');
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

export function createDocument(token: string, title: string): Promise<DocumentSummary> {
  return request<DocumentSummary>('/documents', token, {
    method: 'POST',
    body: JSON.stringify({ title }),
  });
}

export function listDocuments(token: string): Promise<{ documents: DocumentSummary[] }> {
  return request<{ documents: DocumentSummary[] }>('/documents', token);
}

export function getDocument(token: string, docId: string): Promise<DocumentSummary> {
  return request<DocumentSummary>(`/documents/${docId}`, token);
}

/**
 * Renomme un document. Le titre vit d'abord dans le CRDT (réplication immédiate) ;
 * cet appel le rend durable côté serveur pour la liste des documents.
 */
export function renameDocument(token: string, docId: string, title: string): Promise<DocumentSummary> {
  return request<DocumentSummary>(`/documents/${docId}`, token, {
    method: 'PATCH',
    body: JSON.stringify({ title }),
  });
}

/** Ce que renvoie le dépôt d'une image d'en-tête. */
export interface UploadedAsset {
  /** Adresse à ranger dans le bloc. Relative : elle suit le document. */
  url: string;
  name: string;
  content_type: string;
  size_bytes: number;
}

/** Taille refusée côté serveur — annoncée ici pour ne pas envoyer pour rien. */
export const MAX_ASSET_BYTES = 4 * 1024 * 1024;

/**
 * Dépose une image d'en-tête ou de pied.
 *
 * Le corps part **brut** : le serveur ignore de toute façon le `Content-Type`
 * annoncé et reconnaît le format aux octets. Un multipart n'apporterait ici
 * qu'un encodage de plus à défaire des deux côtés.
 */
export async function uploadAsset(
  token: string,
  docId: string,
  fichier: Blob,
): Promise<UploadedAsset> {
  if (fichier.size > MAX_ASSET_BYTES) {
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
    throw new ApiError('Serveur injoignable.', 0, 'offline');
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
 * Rejoint une session par sa signature unique (`token_session`) et l'adresse du
 * participant. Le serveur renvoie le `doc_id`, la permission **inscrite dans la
 * session** — jamais celle que le client réclamerait — et, en mode développement,
 * le jeton d'accès correspondant.
 */
export function joinSession(tokenSession: string, email: string): Promise<SessionJoin> {
  return request<SessionJoin>(`/sessions/${encodeURIComponent(tokenSession)}/join`, null, {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
}
