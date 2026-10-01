// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Les contributeurs de Writer

/**
 * Copie un texte dans le presse-papiers.
 *
 * `navigator.clipboard` n'existe qu'en contexte sécurisé (HTTPS ou localhost) :
 * la page ouverte par l'IP du poste en HTTP, sur le réseau local, n'y a pas
 * accès — le bouton « Copier » ne faisait alors rien. Repli : sélection d'une
 * zone de texte invisible et `execCommand('copy')`, puis le focus est rendu à
 * l'élément qui l'avait.
 */
export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Permission refusée : on tente le repli.
    }
  }
  const previous = document.activeElement as HTMLElement | null;
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.setAttribute('aria-hidden', 'true');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.remove();
    previous?.focus();
  }
}
