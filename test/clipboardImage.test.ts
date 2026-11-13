// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors

/**
 * Pasting an image: which representation of the clipboard wins (`SwTransferable::PasteData`).
 *
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import { imageFromClipboard, isAcceptedImageType, readHtmlImage, type ClipboardSource } from '../src/domain/image/clipboard';
import { IMAGE_PLACEHOLDER } from '../src/domain/document/images';

function clipboard(data: Record<string, string>, files: File[] = []): ClipboardSource {
  return {
    files,
    items: files.map((file) => ({ kind: 'file', type: file.type, getAsFile: () => file })),
    getData: (format) => data[format] ?? '',
  };
}

const png = () => new File([new Uint8Array([137, 80, 78, 71])], 'image.png', { type: 'image/png' });

describe('Image dans le presse-papiers', () => {
  it("colle une capture d'écran (fichier seul)", () => {
    const result = imageFromClipboard(clipboard({}, [png()]));
    expect(result?.kind).toBe('file');
  });

  it("colle « Copier l'image » d'un navigateur (fichier + <img>)", () => {
    const result = imageFromClipboard(
      clipboard({ 'text/html': '<meta charset="utf-8"><img src="https://exemple.org/chat.png">' }, [png()]),
    );
    expect(result?.kind).toBe('file');
  });

  it("accepte l'adresse de l'image donnée comme texte", () => {
    const result = imageFromClipboard(
      clipboard({ 'text/plain': 'https://exemple.org/chat.png', 'text/html': '<img src="https://exemple.org/chat.png">' }, [png()]),
    );
    expect(result?.kind).toBe('file');
  });

  it("colle un fichier copié depuis le gestionnaire de fichiers", () => {
    expect(imageFromClipboard(clipboard({ 'text/plain': '/home/moi/Images/photo.jpg' }, [png()]))?.kind).toBe('file');
  });

  it("se rabat sur l'adresse quand le navigateur ne donne pas les octets", () => {
    const result = imageFromClipboard(clipboard({ 'text/html': '<img src="https://exemple.org/chat.png">' }));
    expect(result).toEqual({ kind: 'src', src: 'https://exemple.org/chat.png' });
  });

  it("refuse une adresse dangereuse", () => {
    expect(imageFromClipboard(clipboard({ 'text/html': '<img src="javascript:alert(1)">' }))).toBeNull();
  });

  it("garde le texte quand une image vient au milieu d'un paragraphe copié", () => {
    const result = imageFromClipboard(
      clipboard(
        { 'text/plain': 'Un paragraphe avec une image', 'text/html': '<p>Un paragraphe <img src="https://exemple.org/a.png"> avec une image</p>' },
        [png()],
      ),
    );
    expect(result).toBeNull();
  });

  it("laisse le collage interne gérer une image copiée depuis l'éditeur", () => {
    expect(
      imageFromClipboard(clipboard({ 'text/plain': IMAGE_PLACEHOLDER, 'text/html': '<img src="data:image/png;base64,AAAA">' })),
    ).toBeNull();
  });

  it('ignore le texte ordinaire', () => {
    expect(imageFromClipboard(clipboard({ 'text/plain': 'Bonjour' }))).toBeNull();
  });

  it('lit la première image et le texte autour', () => {
    expect(readHtmlImage('<p>Avant <img src="a.png"> après</p>')).toEqual({ src: 'a.png', text: 'Avant après' });
  });

  it('distingue les formats gardés tels quels de ceux à convertir', () => {
    expect(isAcceptedImageType('image/png')).toBe(true);
    expect(isAcceptedImageType('image/bmp')).toBe(false);
  });
});
