import { describe, expect, it } from 'vitest';
import { AllSelection, EditorState, TextSelection } from 'prosemirror-state';
import { writeSchema } from '../src/document/schema';
import { readFormattingState, setAlignment, setHeading, toggleBold } from '../src/editor/commands';

function stateWithText(text: string): EditorState {
  const doc = writeSchema.node('doc', null, [
    writeSchema.node('paragraph', null, text ? [writeSchema.text(text)] : []),
  ]);
  const state = EditorState.create({ schema: writeSchema, doc });
  // Sélectionne tout le paragraphe.
  return state.apply(
    state.tr.setSelection(TextSelection.create(state.doc, 1, state.doc.content.size - 1)),
  );
}

function apply(state: EditorState, command: ReturnType<typeof setHeading>): EditorState {
  let next = state;
  command(state, (tr) => {
    next = state.apply(tr);
  });
  return next;
}

describe('commandes d’édition', () => {
  it('applique et retire le gras sur la sélection', () => {
    const state = stateWithText('Bonjour');
    const bold = apply(state, toggleBold);
    expect(readFormattingState(bold).bold).toBe(true);

    const plain = apply(bold, toggleBold);
    expect(readFormattingState(plain).bold).toBe(false);
  });

  it('bascule paragraphe ↔ titre au même niveau (Ctrl+1)', () => {
    const state = stateWithText('Titre');
    const heading = apply(state, setHeading(1));
    expect(readFormattingState(heading).headingLevel).toBe(1);

    const back = apply(heading, setHeading(1));
    expect(readFormattingState(back).blockType).toBe('paragraph');
  });

  it('stocke `null` pour l’alignement par défaut et la valeur sinon', () => {
    const state = stateWithText('Texte');
    const centered = apply(state, setAlignment('center'));
    expect(readFormattingState(centered).alignment).toBe('center');

    const left = apply(centered, setAlignment('left'));
    expect(left.doc.firstChild?.attrs['align']).toBeNull();
    expect(readFormattingState(left).alignment).toBe('left');
  });

  it('ne produit aucune transaction si l’alignement est déjà appliqué', () => {
    const state = stateWithText('Texte');
    expect(setAlignment('left')(state, undefined)).toBe(false);
  });
});

describe('état du ruban', () => {
  it('reflète le style du premier bloc quand la sélection couvre tout le document', () => {
    // Régression observée en navigateur : avec Ctrl+A, `$from.parent` est le nœud
    // `doc` et le ruban n'affichait plus « Titre 1 » comme actif.
    const doc = writeSchema.node('doc', null, [
      writeSchema.node('heading', { level: 1 }, [writeSchema.text('Titre')]),
      writeSchema.node('paragraph', null, [writeSchema.text('Corps')]),
    ]);
    const base = EditorState.create({ schema: writeSchema, doc });
    const all = base.apply(base.tr.setSelection(new AllSelection(base.doc)));

    expect(readFormattingState(all).headingLevel).toBe(1);
    expect(readFormattingState(all).blockType).toBe('heading');
  });
});

describe('libellés de raccourcis', () => {
  it('écrit les touches en capitale, comme partout ailleurs', async () => {
    const { shortcutLabel } = await import('../src/editor/keymap');
    expect(shortcutLabel('Mod-b')).toBe('Ctrl+B');
    expect(shortcutLabel('Mod-p')).toBe('Ctrl+P');
  });

  it('traduit les modificateurs', async () => {
    const { shortcutLabel } = await import('../src/editor/keymap');
    expect(shortcutLabel('Mod-Shift-9')).toBe('Ctrl+Maj+9');
    expect(shortcutLabel('Mod-Enter')).toBe('Ctrl+Enter');
  });
});

describe('saut de page', () => {
  it('ouvre une page où écrire quand il termine le document', async () => {
    const { insertPageBreak } = await import('../src/editor/commands');
    const doc = writeSchema.node('doc', null, [
      writeSchema.node('paragraph', null, [writeSchema.text('Page une')]),
    ]);
    let state = EditorState.create({ schema: writeSchema, doc });
    state = state.apply(state.tr.setSelection(TextSelection.atEnd(state.doc)));

    let suivant = state;
    insertPageBreak(state, (tr) => {
      suivant = state.apply(tr);
    });

    const dernier = suivant.doc.child(suivant.doc.childCount - 1);
    expect(dernier.type.name).toBe('paragraph');
    // Et l'on peut taper immédiatement sur la nouvelle page.
    expect(suivant.apply(suivant.tr.insertText('Page deux')).doc.textContent).toContain('Page deux');
  });
});
