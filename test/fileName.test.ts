// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors
import { describe, expect, it } from 'vitest';
import { fileNameForTitle, normalizeTitle, titleFromFileName } from '../src/domain/document/fileName';

describe('Nom du document et nom du fichier', () => {
  it('reprend le nom du fichier ouvert, sans dossier ni extension', () => {
    expect(titleFromFileName('doc_test.odt')).toBe('doc_test');
    expect(titleFromFileName('/home/moi/Rapport final.ODT')).toBe('Rapport final');
    expect(titleFromFileName('C:\\Docs\\modele.ott')).toBe('modele');
    expect(titleFromFileName('notes.v2.odt')).toBe('notes.v2');
  });

  it("retire un .odt tapé par habitude dans la barre de titre", () => {
    expect(normalizeTitle('  rapport.odt ')).toBe('rapport');
    expect(normalizeTitle('rapport')).toBe('rapport');
  });

  it('enregistre sous le nom affiché, nettoyé pour le système de fichiers', () => {
    expect(fileNameForTitle('doc_test')).toBe('doc_test.odt');
    expect(fileNameForTitle('Budget 2026/2027 : v1?')).toBe('Budget 2026-2027 - v1-.odt');
    expect(fileNameForTitle('rapport.odt')).toBe('rapport.odt');
    expect(fileNameForTitle('')).toBe('document.odt');
    expect(fileNameForTitle('   ...  ')).toBe('document.odt');
  });
});
