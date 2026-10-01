// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors

/**
 * Image adapter: decoding and rasterization by the browser.
 *
 * This module is the counterpart of `CanvasTextMeasurer` in `engine/measure.ts`: layer 2 stays pure, and **this file
 * alone** knows the DOM. The reason is the same as for text measurement: writing our own PNG, JPEG, GIF and WebP
 * decoder would be a project in itself, whereas the browser has one, exact and already loaded.
 *
 * Two services:
 *
 *  - the **natural size** of an image, to insert it at its real dimensions as `SwFEShell::Insert` does;
 *  - a **JPEG rasterization** for the PDF export. A PDF cannot carry a PNG: `/DCTDecode` carries a JPEG as is,
 *    `/FlateDecode` raw pixels. Going through the canvas gives the pixels of any format the browser can read,
 *    transparency flattened included, since PDF has no alpha layer in DeviceRGB.
 */

import { MAX_IMAGE_BYTES } from '../document/images';

export interface NaturalSize {
  widthPx: number;
  heightPx: number;
}

/** Decoded image, ready to become a PDF object. */
export interface RasterImage {
  /** JPEG bytes, to be placed as they are in a `/DCTDecode` stream. */
  jpegBytes: Uint8Array;
  widthPx: number;
  heightPx: number;
}

/**
 * Loads an image and returns its natural size.
 *
 * Fails rather than guess: an invented size would place a frame that matches nothing, and the gap would only show at
 * printing time.
 */
export function probeImageSize(src: string): Promise<NaturalSize> {
  return new Promise((resolve, reject) => {
    if (typeof Image === 'undefined') {
      reject(new Error('Décodage d’image indisponible hors navigateur.'));
      return;
    }
    const image = new Image();
    // Remote images must arrive without credentials and with a CORS header: without it, the canvas would be "tainted" and
    // the PDF export would fail when reading the pixels, long after the insertion.
    image.crossOrigin = 'anonymous';
    image.onload = () =>
      resolve({ widthPx: image.naturalWidth, heightPx: image.naturalHeight });
    image.onerror = () => reject(new Error('Image illisible ou adresse invalide.'));
    image.src = src;
  });
}

/** Reads a local file as a `data:` URL: the form the document carries offline. */
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

/** JPEG quality of the PDF export: beyond it, the visual gain does not pay for the weight. */
const PDF_JPEG_QUALITY = 0.92;

/**
 * Rasterizes an image to JPEG for the PDF export.
 *
 * The background is painted white before the image: a transparency flattened onto black (what a blank canvas converted
 * to JPEG gives) would make any logo with a transparent background unreadable, the most common case.
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

/** Base64 → bytes, with no dependency: `atob` returns a latin-1 byte string. */
export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64.replace(/\s+/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Rasterizes all the images of a document, indexed by address.
 *
 * An image that refuses to decode is **not** an export error: it will be missing from the PDF, where the engine leaves an
 * empty frame in its place, and the rest of the document leaves anyway. Refusing the whole export for a dead address would
 * be out of proportion.
 */
export async function rasterizeAll(sources: readonly string[]): Promise<Map<string, RasterImage>> {
  const out = new Map<string, RasterImage>();
  await Promise.all(
    Array.from(new Set(sources)).map(async (src) => {
      try {
        out.set(src, await rasterizeForPdf(src));
      } catch {
        /* empty frame in the PDF, document exported anyway */
      }
    }),
  );
  return out;
}
