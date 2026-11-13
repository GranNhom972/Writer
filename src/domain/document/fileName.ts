// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors

/**
 * Document title ↔ file name.
 *
 * In Writer, the title bar shows the **file's** name, and "Save as" renames the file. Here the document title
 * plays both roles: it is shown and edited in the title bar, and it names the `.odt` that "Save" downloads. One
 * source of truth, so the two can never disagree, which is exactly what went wrong when the sample
 * `doc_test.odt` was displayed under another name.
 *
 * Pure module.
 */

/** Extensions of the OpenDocument text family, removed from a file name to make a title. */
const ODF_TEXT_EXTENSION = /\.(odt|ott|fodt)$/i;

/** Characters that no file system accepts in a name, plus control characters. */
// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[\\/:*?"<>|\u0000-\u001f]/g;

/** Title shown for a document whose name is empty. */
export const UNTITLED = 'Sans titre';

/** Title of a document opened from `fileName`: the name without folder and without extension. */
export function titleFromFileName(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  return base.replace(ODF_TEXT_EXTENSION, '').trim();
}

/**
 * Title typed in the title bar, cleaned up: spaces trimmed, and an `.odt` typed out of habit removed, so the
 * saved file is not called `rapport.odt.odt`.
 */
export function normalizeTitle(input: string): string {
  return input.trim().replace(ODF_TEXT_EXTENSION, '').trim();
}

/** Name of the file "Save" downloads for a document called `title`. */
export function fileNameForTitle(title: string, extension = 'odt'): string {
  const base = normalizeTitle(title)
    .replace(FORBIDDEN, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 180);
  return `${base || 'document'}.${extension}`;
}
