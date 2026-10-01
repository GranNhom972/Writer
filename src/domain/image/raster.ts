// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Les contributeurs de Writer

/**
 * Adaptateur d'images : décodage et rastérisation par le navigateur.
 *
 * Ce module est le pendant de `CanvasTextMeasurer` dans `engine/measure.ts` :
 * la couche 2 reste pure, et **ce fichier seul** connaît le DOM. La raison est
 * la même que pour la mesure du texte — écrire nous-mêmes un décodeur PNG, JPEG,
 * GIF et WebP serait un projet à part entière, alors que le navigateur en
 * possède un, exact, déjà chargé.
 *
 * Deux services :
 *
 *  - la **taille naturelle** d'une image, pour l'insérer à ses dimensions
 *    réelles comme le fait `SwFEShell::Insert` ;
 *  - une **rastérisation en JPEG** pour l'export PDF. Un PDF ne sait pas porter
 *    de PNG : `/DCTDecode` transporte un JPEG tel quel, `/FlateDecode` des
 *    pixels bruts. Passer par le canevas donne les pixels de n'importe quel
 *    format que le navigateur sait lire, transparence aplatie comprise — le PDF
 *    n'ayant pas de couche alpha en DeviceRGB.
 */

import { MAX_IMAGE_BYTES } from '../document/images';

export interface NaturalSize {
  widthPx: number;
  heightPx: number;
}

/** Image décodée, prête à devenir un objet PDF. */
export interface RasterImage {
  /** Octets JPEG, à placer tels quels dans un flux `/DCTDecode`. */
  jpegBytes: Uint8Array;
  widthPx: number;
  heightPx: number;
}

/**
 * Charge une image et rend sa taille naturelle.
 *
 * Échoue plutôt que de deviner : une taille inventée poserait un cadre qui ne
 * correspondrait à rien, et l'écart ne se verrait qu'à l'impression.
 */
export function probeImageSize(src: string): Promise<NaturalSize> {
  return new Promise((resolve, reject) => {
    if (typeof Image === 'undefined') {
      reject(new Error('Décodage d’image indisponible hors navigateur.'));
      return;
    }
    const image = new Image();
    // Les images distantes doivent arriver sans identifiants et avec un en-tête
    // CORS : sans lui, le canevas serait « taché » et l'export PDF échouerait
    // au moment de lire les pixels, bien après l'insertion.
    image.crossOrigin = 'anonymous';
    image.onload = () =>
      resolve({ widthPx: image.naturalWidth, heightPx: image.naturalHeight });
    image.onerror = () => reject(new Error('Image illisible ou adresse invalide.'));
    image.src = src;
  });
}

/** Lit un fichier local en `data:` — la forme que porte le document hors ligne. */
export function readFileAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    if (file.size > MAX_IMAGE_BYTES) {
      reject(new Error(`Image trop lourde (${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} Mo maximum).`));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result === 'string') resolve(result);
      else reject(new Error('Lecture du fichier impossible.'));
    };
    reader.onerror = () => reject(new Error('Lecture du fichier impossible.'));
    reader.readAsDataURL(file);
  });
}

/** Qualité JPEG de l'export PDF : au-delà, le gain visuel ne paie plus le poids. */
const PDF_JPEG_QUALITY = 0.92;

/**
 * Rastérise une image en JPEG pour l'export PDF.
 *
 * Le fond est peint en blanc avant l'image : une transparence aplatie sur du
 * noir — ce que donne un canevas vierge converti en JPEG — rendrait illisible
 * tout logo à fond transparent, cas le plus courant.
 */
export async function rasterizeForPdf(src: string): Promise<RasterImage> {
  if (typeof document === 'undefined') {
    throw new Error('Rastérisation indisponible hors navigateur.');
  }

  const image = await loadImage(src);
  const widthPx = Math.max(1, image.naturalWidth);
  const heightPx = Math.max(1, image.naturalHeight);

  const canvas = document.createElement('canvas');
  canvas.width = widthPx;
  canvas.height = heightPx;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D indisponible.');

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, widthPx, heightPx);
  ctx.drawImage(image, 0, 0, widthPx, heightPx);

  const dataUrl = canvas.toDataURL('image/jpeg', PDF_JPEG_QUALITY);
  const comma = dataUrl.indexOf(',');
  if (comma < 0) throw new Error('Rastérisation impossible.');

  return { jpegBytes: base64ToBytes(dataUrl.slice(comma + 1)), widthPx, heightPx };
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Image illisible.'));
    image.src = src;
  });
}

/** Base64 → octets, sans dépendance : `atob` rend une chaîne d'octets latin-1. */
export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64.replace(/\s+/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Rastérise toutes les images d'un document, indexées par adresse.
 *
 * Une image qui refuse de se décoder n'est **pas** une erreur d'export : elle
 * manquera du PDF, où le moteur laissera un cadre vide à sa place, et le reste
 * du document partira quand même. Refuser l'export entier pour une adresse
 * morte serait disproportionné.
 */
export async function rasterizeAll(sources: readonly string[]): Promise<Map<string, RasterImage>> {
  const out = new Map<string, RasterImage>();
  await Promise.all(
    Array.from(new Set(sources)).map(async (src) => {
      try {
        out.set(src, await rasterizeForPdf(src));
      } catch {
        /* cadre vide dans le PDF, document exporté tout de même */
      }
    }),
  );
  return out;
}
