import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import type { Command } from 'prosemirror-state';
import { writeSchema } from '../src/document/schema';
import {
  deleteColumnAt,
  deleteRowAt,
  insertColumnAt,
  insertRowAt,
  insertTable,
  resizeTable,
  setTableAttrs,
  tableInfo,
} from '../src/editor/commands';

/** État avec le curseur placé dans la première cellule d'un tableau r × c. */
function stateWithTable(rows: number, cols: number): EditorState {
  const empty = EditorState.create({
    schema: writeSchema,
    doc: writeSchema.node('doc', null, [writeSchema.node('paragraph')]),
  });
  const withTable = apply(empty, insertTable(rows, cols));

  // Descendre dans la première cellule.
  let cellPos = -1;
  withTable.doc.descendants((node, pos) => {
    if (cellPos === -1 && (node.type.name === 'table_header' || node.type.name === 'table_cell')) {
      cellPos = pos + 1;
    }
    return cellPos === -1;
  });

  return withTable.apply(
    withTable.tr.setSelection(TextSelection.create(withTable.doc, cellPos + 1)),
  );
}

function apply(state: EditorState, command: Command): EditorState {
  let next = state;
  command(state, (tr) => {
    next = state.apply(tr);
  });
  return next;
}

function cellText(state: EditorState, row: number, col: number): string {
  const info = tableInfo(state)!;
  const table = state.doc.nodeAt(info.pos)!;
  return table.child(row).child(col).textContent;
}

function withText(state: EditorState, text: string): EditorState {
  return state.apply(state.tr.insertText(text));
}

describe('insertion de tableau', () => {
  it('crée les dimensions demandées, en-tête compris', () => {
    const state = stateWithTable(3, 4);
    const info = tableInfo(state)!;

    expect(info.rows).toBe(3);
    expect(info.cols).toBe(4);
    expect(info.headerRow).toBe(true);

    const table = state.doc.nodeAt(info.pos)!;
    expect(table.child(0).child(0).type.name).toBe('table_header');
    expect(table.child(1).child(0).type.name).toBe('table_cell');
  });

  it('laisse toujours un paragraphe après un tableau de fin de document', () => {
    // Sans lui, le curseur est piégé : plus moyen d'écrire après le tableau.
    const empty = EditorState.create({
      schema: writeSchema,
      doc: writeSchema.node('doc', null, [writeSchema.node('paragraph')]),
    });
    const state = apply(empty, insertTable(2, 2));
    const dernier = state.doc.child(state.doc.childCount - 1);

    expect(dernier.type.name).toBe('paragraph');
  });

  it('place le curseur dans la première cellule', () => {
    const empty = EditorState.create({
      schema: writeSchema,
      doc: writeSchema.node('doc', null, [writeSchema.node('paragraph')]),
    });
    const state = withText(apply(empty, insertTable(2, 2)), 'Direct');

    expect(cellText(state, 0, 0)).toBe('Direct');
  });

  it('borne les dimensions demandées à l’insertion', () => {
    const empty = EditorState.create({
      schema: writeSchema,
      doc: writeSchema.node('doc', null, [writeSchema.node('paragraph')]),
    });
    const state = apply(empty, insertTable(0, 999));
    const info = tableInfo(state)!;

    expect(info.rows).toBe(1);
    expect(info.cols).toBe(20);
  });

  it('rapporte l’absence de tableau quand le curseur est ailleurs', () => {
    const state = EditorState.create({
      schema: writeSchema,
      doc: writeSchema.node('doc', null, [writeSchema.node('paragraph')]),
    });
    expect(tableInfo(state)).toBeNull();
  });
});

describe('redimensionnement depuis le panneau', () => {
  it('ajoute lignes et colonnes sans toucher au contenu existant', () => {
    let state = withText(stateWithTable(2, 2), 'Titre A');
    state = apply(state, resizeTable(4, 3));

    const info = tableInfo(state)!;
    expect([info.rows, info.cols]).toEqual([4, 3]);
    expect(cellText(state, 0, 0)).toBe('Titre A');
  });

  it('retire les lignes et colonnes par la FIN', () => {
    // Le contenu du début doit survivre : c'est ce que l'usager voit et attend.
    let state = withText(stateWithTable(3, 3), 'garde-moi');
    state = apply(state, resizeTable(2, 2));

    const info = tableInfo(state)!;
    expect([info.rows, info.cols]).toEqual([2, 2]);
    expect(cellText(state, 0, 0)).toBe('garde-moi');
  });

  it('ne descend jamais sous une ligne et une colonne', () => {
    const state = apply(stateWithTable(3, 3), resizeTable(0, 0));
    const info = tableInfo(state)!;
    expect([info.rows, info.cols]).toEqual([1, 1]);
  });

  it('borne les dimensions hautes', () => {
    const state = apply(stateWithTable(2, 2), resizeTable(999, 999));
    const info = tableInfo(state)!;
    expect(info.rows).toBeLessThanOrEqual(50);
    expect(info.cols).toBeLessThanOrEqual(20);
  });

  it('ne produit aucune transaction si la taille ne change pas', () => {
    const state = stateWithTable(3, 3);
    expect(resizeTable(3, 3)(state, undefined)).toBe(false);
  });

  it('conserve les propriétés de bordure après redimensionnement', () => {
    let state = apply(stateWithTable(2, 2), setTableAttrs({ borderWidth: 4, borderColor: '#b42318' }));
    state = apply(state, resizeTable(3, 3));

    const info = tableInfo(state)!;
    expect(info.borderWidth).toBe(4);
    expect(info.borderColor).toBe('#b42318');
  });
});

describe('propriétés du tableau', () => {
  it('modifie l’épaisseur du trait en une seule transaction', () => {
    const state = stateWithTable(4, 4);
    let count = 0;
    setTableAttrs({ borderWidth: 3 })(state, () => {
      count += 1;
    });
    // Le trait appartient au tableau : 16 cellules, une seule modification.
    expect(count).toBe(1);
    expect(tableInfo(apply(state, setTableAttrs({ borderWidth: 3 })))!.borderWidth).toBe(3);
  });

  it('accepte une épaisseur nulle', () => {
    const state = apply(stateWithTable(2, 2), setTableAttrs({ borderWidth: 0 }));
    expect(tableInfo(state)!.borderWidth).toBe(0);
  });

  it('bascule la ligne d’en-tête et convertit les cellules', () => {
    let state = apply(stateWithTable(2, 2), setTableAttrs({ headerRow: false }));
    expect(tableInfo(state)!.headerRow).toBe(false);

    // La conversion effective a lieu au redimensionnement suivant.
    state = apply(state, resizeTable(3, 2));
    const info = tableInfo(state)!;
    expect(state.doc.nodeAt(info.pos)!.child(0).child(0).type.name).toBe('table_cell');
  });

  it('échoue proprement hors d’un tableau', () => {
    const state = EditorState.create({
      schema: writeSchema,
      doc: writeSchema.node('doc', null, [writeSchema.node('paragraph')]),
    });
    expect(setTableAttrs({ borderWidth: 2 })(state, undefined)).toBe(false);
    expect(resizeTable(2, 2)(state, undefined)).toBe(false);
  });
});

describe('curseur pendant les changements de dimension', () => {
  it('reste dans le tableau après un redimensionnement', () => {
    // Régression : le curseur était éjecté, ce qui refermait le panneau de
    // propriétés à chaque clic sur « + une ligne ».
    const state = apply(stateWithTable(3, 3), resizeTable(4, 4));
    expect(tableInfo(state)).not.toBeNull();
  });

  it('se rabat sur une cellule existante quand la sienne disparaît', () => {
    let state = stateWithTable(3, 3);
    const info = tableInfo(state)!;

    // Curseur dans la dernière cellule de la dernière ligne.
    const table = state.doc.nodeAt(info.pos)!;
    let pos = info.pos + 1;
    for (let r = 0; r < 2; r += 1) pos += table.child(r).nodeSize;
    pos += 1;
    for (let c = 0; c < 2; c += 1) pos += table.child(2).child(c).nodeSize;
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, pos + 2)));

    state = apply(state, resizeTable(1, 1));

    expect(tableInfo(state)).not.toBeNull();
    expect(tableInfo(state)!.rows).toBe(1);
    // Le curseur suit : on peut taper immédiatement dans ce qui reste.
    expect(withText(state, 'ok').doc.textContent).toContain('ok');
  });
});

describe('opérations ciblées (poignées du tableau)', () => {
  it('insère une colonne à l’endroit visé, pas à la fin', () => {
    let state = withText(stateWithTable(2, 3), 'A');
    state = apply(state, insertColumnAt(1));

    const info = tableInfo(state)!;
    expect(info.cols).toBe(4);
    // La colonne neuve s'intercale : « A » reste en première position.
    expect(cellText(state, 0, 0)).toBe('A');
    expect(cellText(state, 0, 1)).toBe('');
  });

  it('insère une colonne dans TOUTES les lignes', () => {
    const state = apply(stateWithTable(4, 2), insertColumnAt(0));
    const info = tableInfo(state)!;
    const table = state.doc.nodeAt(info.pos)!;

    for (let r = 0; r < table.childCount; r += 1) {
      expect(table.child(r).childCount).toBe(3);
    }
  });

  it('insère une ligne à l’index demandé', () => {
    let state = withText(stateWithTable(2, 2), 'Première');
    state = apply(state, insertRowAt(1));

    expect(tableInfo(state)!.rows).toBe(3);
    expect(cellText(state, 0, 0)).toBe('Première');
    expect(cellText(state, 1, 0)).toBe('');
  });

  it('supprime la ligne visée en conservant les autres', () => {
    let state = stateWithTable(3, 2);
    state = withText(state, 'Ligne 1');
    state = apply(state, insertRowAt(3));
    state = apply(state, deleteRowAt(1));

    expect(cellText(state, 0, 0)).toBe('Ligne 1');
    expect(tableInfo(state)!.rows).toBe(3);
  });

  it('supprime la colonne visée', () => {
    const state = apply(stateWithTable(2, 3), deleteColumnAt(1));
    expect(tableInfo(state)!.cols).toBe(2);
  });

  it('refuse de vider le tableau par ses poignées', () => {
    // Supprimer la dernière ligne ou colonne doit rester un geste explicite
    // (« Supprimer le tableau »), pas la conséquence d'un clic de trop.
    const state = stateWithTable(1, 1);
    expect(deleteRowAt(0)(state, undefined)).toBe(false);
    expect(deleteColumnAt(0)(state, undefined)).toBe(false);
  });

  it('laisse le curseur dans le tableau après chaque opération', () => {
    let state = apply(stateWithTable(2, 2), insertColumnAt(1));
    expect(tableInfo(state)).not.toBeNull();

    state = apply(state, insertRowAt(0));
    expect(tableInfo(state)).not.toBeNull();

    state = apply(state, deleteColumnAt(0));
    expect(tableInfo(state)).not.toBeNull();

    state = apply(state, deleteRowAt(0));
    expect(tableInfo(state)).not.toBeNull();
  });

  it('borne les index hors plage au lieu de casser', () => {
    const state = stateWithTable(2, 2);
    expect(apply(state, insertRowAt(99)).doc).toBeDefined();
    expect(deleteRowAt(99)(state, undefined)).toBe(false);
    expect(deleteColumnAt(-1)(state, undefined)).toBe(false);
  });
});

describe('géométrie du calque de poignées', () => {
  /** Élément de tableau factice : trois colonnes de 100 px, deux lignes de 30 px. */
  function fakeTable(): { table: HTMLElement; container: HTMLElement } {
    const container = document.createElement('div');
    const table = document.createElement('table');

    const rects = new Map<Element, DOMRect>();
    const rect = (x: number, y: number, w: number, h: number): DOMRect =>
      ({ x, y, left: x, top: y, width: w, height: h, right: x + w, bottom: y + h }) as DOMRect;

    rects.set(container, rect(0, 0, 800, 600));
    rects.set(table, rect(100, 50, 300, 60));

    for (let r = 0; r < 2; r += 1) {
      const row = document.createElement('tr');
      rects.set(row, rect(100, 50 + r * 30, 300, 30));
      for (let c = 0; c < 3; c += 1) {
        const cell = document.createElement('td');
        rects.set(cell, rect(100 + c * 100, 50 + r * 30, 100, 30));
        row.appendChild(cell);
      }
      table.appendChild(row);
    }
    container.appendChild(table);

    // jsdom ne calcule aucune géométrie : on la fournit.
    for (const [element, value] of rects) {
      (element as HTMLElement).getBoundingClientRect = () => value;
    }
    return { table, container };
  }

  it('place le calque exactement sur le tableau', async () => {
    const { measureTable } = await import('../src/ui/TableOverlay');
    const { table, container } = fakeTable();
    const geometry = measureTable(table, container)!;

    expect(geometry.left).toBe(100);
    expect(geometry.top).toBe(50);
    expect(geometry.width).toBe(300);
  });

  it('donne un bord par colonne et par ligne, relatifs au tableau', async () => {
    const { measureTable } = await import('../src/ui/TableOverlay');
    const { table, container } = fakeTable();
    const geometry = measureTable(table, container)!;

    // Les « + » d'insertion se posent sur ces bords : 0 puis chaque bord droit.
    expect(geometry.columnEdges).toEqual([100, 200, 300]);
    expect(geometry.rowEdges).toEqual([30, 60]);
  });

  it('renvoie null pour un tableau sans ligne', async () => {
    const { measureTable } = await import('../src/ui/TableOverlay');
    const container = document.createElement('div');
    const table = document.createElement('table');
    container.appendChild(table);
    expect(measureTable(table, container)).toBeNull();
  });
});
