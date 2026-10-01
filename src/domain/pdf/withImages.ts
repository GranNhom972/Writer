// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors

/**
 * PDF export of a document **that contains images**.
 *
 * The PDF engine is pure: it places the JPEG bytes it is given and does not manufacture them. This file is the seam
 * between the two: it decodes the images through the browser (`domain/image/raster.ts`), then calls the export.
 *
 * It is separate from `export.ts` so that the latter stays runnable without a DOM, in a test as in a Web Worker.
 */

import type { WriterDocumentState } from '../document/types';
import type { DocumentLayout } from '../engine/paginate';
import { rasterizeAll } from '../image/raster';
import { collectImageSources, downloadPdf, exportToPdfBlob, type PdfExportOptions } from './export';

/** Prepares the document's images, then returns the completed export options. */
export async function withRasterizedImages(
  doc: WriterDocumentState,
  options: PdfExportOptions = {},
): Promise<PdfExportOptions> {
  const sources = collectImageSources(doc);
  if (sources.length === 0) return options;
  return { ...options, images: await rasterizeAll(sources) };
}

export async function exportPdfBlobWithImages(
  doc: WriterDocumentState,
  layout: DocumentLayout,
  options: PdfExportOptions = {},
): Promise<Blob> {
  return exportToPdfBlob(doc, layout, await withRasterizedImages(doc, options));
}

/** Downloads the PDF, images included. */
export async function downloadPdfWithImages(
  doc: WriterDocumentState,
  layout: DocumentLayout,
  filename?: string,
  options: PdfExportOptions = {},
): Promise<void> {
  downloadPdf(doc, layout, filename, await withRasterizedImages(doc, options));
}
