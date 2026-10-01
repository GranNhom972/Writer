// SPDX-License-Identifier: Apache-2.0 AND GPL-3.0-or-later
// Copyright (C) 2026 Les contributeurs de Writer
//
// Œuvre dérivée et modifiée d'Apache OpenOffice 4.1.16 (© The Apache Software
// Foundation, Apache License 2.0) : portage en TypeScript, fichier modifié par
// rapport à l'original. Voir les fichiers NOTICE et LICENSE-APACHE.

/**
 * Export PDF **par la boîte d'impression du navigateur**.
 *
 * Writer possède son propre moteur PDF (`export.ts`, port de `vcl::PDFWriter`),
 * mais celui-ci ne restitue que ce qu'il sait écrire lui-même : polices Base14,
 * images ré-encodées, mise en page recalculée. Le navigateur, lui, a déjà sous
 * les yeux le rendu exact — polices réelles, images décodées, pagination du
 * moteur de mise en page — et sait le transformer en PDF via la destination
 * « Enregistrer au format PDF ». C'est ce chemin-là que prend l'export.
 *
 * Le rendu imprimé est piloté par la feuille `@media print` de `ui/app.css` :
 * l'interface disparaît, seules les pages A4 subsistent, une par feuille.
 */

/**
 * Ouvre la boîte d'impression, le titre du document en nom de fichier proposé.
 *
 * Les navigateurs pré-remplissent le champ « Nom » de l'export PDF avec
 * `document.title`. On l'y place le temps de l'impression, puis on le remet :
 * l'onglet retrouve son titre habituel dès la boîte refermée.
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
    // `afterprint` est le seul signal fiable : selon le navigateur,
    // `window.print()` rend la main avant ou après la fermeture de la boîte.
    window.addEventListener('afterprint', restore);
  }

  window.print();
}
