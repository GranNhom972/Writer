// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors

/**
 * Recognizing an image in the clipboard (OpenOffice: `SwTransferable::PasteData`,
 * `sw/source/ui/dochdl/swdtflvr.cxx`, which picks the best format offered: a bitmap before plain text when
 * the clipboard holds a picture).
 *
 * A clipboard offers **several representations** of the same thing, and the right one depends on where it
 * comes from:
 *
 *  - a screenshot, or an image copied from an image viewer or from OpenOffice: a bitmap file only;
 *  - "Copy image" in a browser: a bitmap file **and** an HTML `<img>`, sometimes the address as text;
 *  - text copied from a web page that contains a picture: text, and HTML with text around the `<img>`.
 *
 * The first two are an image, the third is text: pasting a lone picture out of a paragraph of text would
 * surprise more than it would help. The rule is therefore: an image when the clipboard carries **nothing
 * but** an image, text as soon as real text comes with it.
 *
 * Pure module apart from `DOMParser`, which is read only if it exists.
 */

import { ACCEPTED_IMAGE_TYPES, IMAGE_PLACEHOLDER, isSafeImageSrc } from '../document/images';

/** What a paste brings when it is an image. */
export type ClipboardImage =
  /** Bytes to read: a screenshot, an image copied from another application. */
  | { kind: 'file'; file: File }
  /** An address: an `<img>` copied from a page whose bytes the browser did not hand over. */
  | { kind: 'src'; src: string };

/** The part of `DataTransfer` that is read: a structural type, so tests can build one by hand. */
export interface ClipboardSource {
  readonly files?: ArrayLike<File>;
  readonly items?: ArrayLike<{ kind: string; type: string; getAsFile(): File | null }>;
  getData(format: string): string;
}

/** Formats a paste can carry as a picture: the four the document accepts, plus those converted on the fly. */
const PICTURE_TYPE = /^image\/(png|jpeg|jpg|gif|webp|bmp|x-bmp|tiff|avif|svg\+xml)$/i;

/** Is this file type kept as it is, or must it be converted to PNG first? */
export function isAcceptedImageType(type: string): boolean {
  return (ACCEPTED_IMAGE_TYPES as readonly string[]).includes(type.toLowerCase());
}

/** First picture file of the clipboard, from `items` (where browsers put a screenshot) then `files`. */
function pictureFile(data: ClipboardSource): File | null {
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== 'file' || !PICTURE_TYPE.test(item.type)) continue;
    const file = item.getAsFile();
    if (file) return file;
  }
  for (const file of Array.from(data.files ?? [])) {
    if (PICTURE_TYPE.test(file.type)) return file;
  }
  return null;
}

/** Address of the first `<img>` of a piece of HTML, and the text that surrounds it. */
export function readHtmlImage(html: string): { src: string | null; text: string } {
  if (!html) return { src: null, text: '' };

  if (typeof DOMParser !== 'undefined') {
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    const image = parsed.querySelector('img[src]');
    return {
      src: image?.getAttribute('src')?.trim() || null,
      text: (parsed.body?.textContent ?? '').replace(/\s+/g, ' ').trim(),
    };
  }

  const match = /<img\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(html);
  const text = html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return { src: (match?.[1] ?? match?.[2] ?? match?.[3] ?? '').trim() || null, text };
}

/** A path or address that designates a picture file: what a file manager puts as text next to the file. */
function looksLikePicturePath(text: string): boolean {
  return /^(file:\/\/|\/|[a-z]:\\|https?:\/\/)\S*\.(png|jpe?g|gif|webp|bmp|tiff?|avif|svg)(\?\S*)?$/i.test(text);
}

/**
 * The image a paste brings, or `null` when it must be pasted as text.
 *
 * Text copied from this editor carries the object replacement character for each image: it is left to the
 * internal paste, which keeps the caption, the wrapping and the size.
 */
export function imageFromClipboard(data: ClipboardSource): ClipboardImage | null {
  const text = data.getData('text/plain').trim();
  if (text.includes(IMAGE_PLACEHOLDER)) return null;

  const html = readHtmlImage(data.getData('text/html'));
  // The text only "comes with" the image when it is something else than the image's own address.
  const onlyPicture =
    text.length === 0 ||
    text === html.src ||
    looksLikePicturePath(text) ||
    (html.src !== null && html.text.length === 0);

  const file = pictureFile(data);
  if (file && onlyPicture) return { kind: 'file', file };

  if (html.src && html.text.length === 0 && (text.length === 0 || text === html.src)) {
    return isSafeImageSrc(html.src) ? { kind: 'src', src: html.src } : null;
  }
  return null;
}
