// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors

/**
 * Copies a text to the clipboard.
 *
 * `navigator.clipboard` only exists in a secure context (HTTPS or localhost): a page opened through the machine's IP over HTTP, on the
 * local network, cannot use it, and the "Copy" button then did nothing. Fallback: select an invisible text area and call
 * `execCommand('copy')`, then give the focus back to the element that had it.
 */
export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Permission denied: we try the fallback.
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
