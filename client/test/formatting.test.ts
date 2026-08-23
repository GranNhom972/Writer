import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import type { Command } from 'prosemirror-state';
import { writeSchema, MAX_INDENT } from '../src/document/schema';
import {
  adjustFontSize,
  changeIndent,
  clampFontSize,
  clearFormatting,
  insertImage,
  normalizeUrl,
  readFormattingState,
  setFontSize,
  setHighlight,
  setLineHeight,
  setLink,
  setTextColor,
  toggleList,
} from '../src/editor/commands';

function selectedState(text = 'Bonjour'): EditorState {
  const doc = writeSchema.node('doc', null, [
    writeSchema.node('paragraph', null, [writeSchema.text(text)]),
  ]);
  const state = EditorState.create({ schema: writeSchema, doc });
  return state.apply(
    state.tr.setSelection(TextSelection.create(state.doc, 1, state.doc.content.size - 1)),
  );
}

function apply(state: EditorState, command: Command): EditorState {
  let next = state;
  command(state, (tr) => {
    next = state.apply(tr);
  });
  return next;
}

describe('URL — normalisation et sécurité', () => {
  it('complète le schéma manquant en https', () => {
    expect(normalizeUrl('exemple.org')).toBe('https://exemple.org/');
  });

  it('accepte http, https et mailto', () => {
    expect(normalizeUrl('http://exemple.org')).toBe('http://exemple.org/');
    expect(normalizeUrl('mailto:a@b.fr')).toBe('mailto:a@b.fr');
  });

  it('REFUSE les schémas exécutables (vecteur XSS rediffusé aux collaborateurs)', () => {
    expect(normalizeUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeUrl('data:text/html,<script>alert(1)</script>')).toBeNull();
    expect(normalizeUrl('vbscript:msgbox(1)')).toBeNull();
    expect(normalizeUrl('file:///etc/passwd')).toBeNull();
  });

  it('refuse une saisie vide', () => {
    expect(normalizeUrl('   ')).toBeNull();
  });

  it('n’applique pas de lien invalide au document', () => {
    const state = selectedState();
    expect(setLink('javascript:alert(1)')(state, undefined)).toBe(false);
    expect(readFormattingState(apply(state, setLink('exemple.org'))).linkHref).toBe(
      'https://exemple.org/',
    );
  });

  it('refuse une image dont l’adresse n’est pas http(s)', () => {
    const state = selectedState();
    expect(insertImage('javascript:alert(1)', 'alt')(state, undefined)).toBe(false);
    expect(insertImage('mailto:a@b.fr', 'alt')(state, undefined)).toBe(false);
  });
});

describe('taille de police', () => {
  it('borne la taille dans [6, 96]', () => {
    expect(clampFontSize(2)).toBe(6);
    expect(clampFontSize(400)).toBe(96);
    expect(clampFontSize(Number.NaN)).toBe(6);
    expect(clampFontSize(12.4)).toBe(12);
  });

  it('incrémente depuis la taille courante', () => {
    const state = apply(selectedState(), setFontSize(14));
    expect(readFormattingState(apply(state, adjustFontSize(2))).fontSize).toBe(16);
  });

  it('part de la taille par défaut quand aucune n’est appliquée', () => {
    expect(readFormattingState(apply(selectedState(), adjustFontSize(1))).fontSize).toBe(12);
  });
});

describe('attributs de bloc', () => {
  it('applique et borne le retrait', () => {
    let state = selectedState();
    for (let i = 0; i < MAX_INDENT + 3; i += 1) state = apply(state, changeIndent(1));
    expect(readFormattingState(state).indent).toBe(MAX_INDENT);

    for (let i = 0; i < MAX_INDENT + 3; i += 1) state = apply(state, changeIndent(-1));
    expect(readFormattingState(state).indent).toBe(0);
  });

  it('stocke `null` pour l’interligne simple (valeur par défaut)', () => {
    const state = apply(selectedState(), setLineHeight(1.5));
    expect(readFormattingState(state).lineHeight).toBe(1.5);
    const reset = apply(state, setLineHeight(1));
    expect(reset.doc.firstChild?.attrs['lineHeight']).toBeNull();
  });
});

describe('couleurs et effacement de la mise en forme', () => {
  it('applique couleur de texte et surlignage', () => {
    let state = apply(selectedState(), setTextColor('#b42318'));
    state = apply(state, setHighlight('#fff3a3'));
    const format = readFormattingState(state);
    expect(format.textColor).toBe('#b42318');
    expect(format.highlight).toBe('#fff3a3');
  });

  it('efface marques ET attributs de bloc', () => {
    let state = apply(selectedState(), setTextColor('#b42318'));
    state = apply(state, setLineHeight(2));
    state = apply(state, changeIndent(1));

    const cleared = apply(state, clearFormatting);
    const format = readFormattingState(cleared);
    expect(format.textColor).toBeNull();
    expect(format.indent).toBe(0);
    expect(cleared.doc.firstChild?.attrs['lineHeight']).toBeNull();
  });
});

describe('listes', () => {
  it('enveloppe la sélection dans une liste à cocher puis en ressort', () => {
    const state = selectedState();
    const asTask = apply(state, toggleList('task_list'));
    expect(readFormattingState(asTask).listKind).toBe('task_list');

    const plain = apply(asTask, toggleList('task_list'));
    expect(readFormattingState(plain).listKind).toBeNull();
  });

  it('crée une liste à puces distincte de la liste numérotée', () => {
    expect(readFormattingState(apply(selectedState(), toggleList('bullet_list'))).listKind).toBe(
      'bullet_list',
    );
    expect(readFormattingState(apply(selectedState(), toggleList('ordered_list'))).listKind).toBe(
      'ordered_list',
    );
  });
});

describe('lien sans sélection', () => {
  it('insère l’adresse comme texte cliquable plutôt que d’armer une marque fragile', () => {
    const doc = writeSchema.node('doc', null, [writeSchema.node('paragraph')]);
    const empty = EditorState.create({ schema: writeSchema, doc });

    const linked = apply(empty, setLink('exemple.org/ordre-du-jour'));
    const textNode = linked.doc.firstChild?.firstChild;

    expect(textNode?.text).toBe('exemple.org/ordre-du-jour');
    expect(textNode?.marks[0]?.attrs['href']).toBe('https://exemple.org/ordre-du-jour');
  });

  it('accepte un libellé d’affichage distinct de l’adresse', () => {
    const doc = writeSchema.node('doc', null, [writeSchema.node('paragraph')]);
    const empty = EditorState.create({ schema: writeSchema, doc });

    const linked = apply(empty, setLink('exemple.org', 'Ordre du jour'));
    expect(linked.doc.firstChild?.firstChild?.text).toBe('Ordre du jour');
  });
});
