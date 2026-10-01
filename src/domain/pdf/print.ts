// SPDX-License-Identifier: Apache-2.0 AND GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors
//
// Derivative work of Apache OpenOffice 4.1.16 (© The Apache Software Foundation,
// Apache License 2.0), modified: ported to TypeScript. See the NOTICE and
// LICENSE-APACHE files.

/**
 * PDF export **through the browser's print dialog**.
 *
 * Writer has its own PDF engine (`export.ts`, a port of `vcl::PDFWriter`), but it only reproduces what it knows how to
 * write itself: Base 14 fonts, re-encoded images, a recomputed layout. The browser, for its part, already has the exact
 * rendering in front of it (real fonts, decoded images, the layout engine's pagination) and can turn it into a PDF
 * through the "Save as PDF" destination. This is the path the export takes.
 *
 * The printed rendering is driven by the `@media print` stylesheet of `ui/app.css`: the interface disappears and only
 * the A4 pages remain, one per sheet.
 */

/**
 * Opens the print dialog, with the document title as the suggested file name.
 *
 * Browsers pre-fill the "Name" field of the PDF export with `document.title`. We put it there for the duration of the
 * printing, then restore it: the tab gets its usual title back as soon as the dialog is closed.
 */
export function printDocument(title?: string): void {
  const previousTitle = document.title;
  const proposed = (title ?? '').trim();

  const restore = (): void => {
    window.removeEventListener('afterprint', restore);
    document.title = previousTitle;
  };

  if (proposed) {
    document.title = proposed;
    // `afterprint` is the only reliable signal: depending on the browser, `window.print()` returns before or after the
    // dialog closes.
    window.addEventListener('afterprint', restore);
  }

  window.print();
}
