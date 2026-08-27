/**
 * Export PDF d'un document **contenant des images**.
 *
 * Le moteur PDF est pur : il place des octets JPEG qu'on lui donne, il n'en
 * fabrique pas. Ce fichier est la couture entre les deux — il décode les images
 * par le navigateur (`domain/image/raster.ts`), puis appelle l'export.
 *
 * Il est séparé de `export.ts` pour que ce dernier reste exécutable sans DOM,
 * dans un test comme dans un Web Worker.
 */

import type { WriterDocumentState } from '../document/types';
import type { DocumentLayout } from '../engine/paginate';
import { rasterizeAll } from '../image/raster';
import { collectImageSources, downloadPdf, exportToPdfBlob, type PdfExportOptions } from './export';

/** Prépare les images du document puis rend les options d'export complétées. */
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

/** Télécharge le PDF, images comprises. */
export async function downloadPdfWithImages(
  doc: WriterDocumentState,
  layout: DocumentLayout,
  filename?: string,
  options: PdfExportOptions = {},
): Promise<void> {
  downloadPdf(doc, layout, filename, await withRasterizedImages(doc, options));
}
