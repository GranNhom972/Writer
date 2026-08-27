/**
 * Partage : projection CRDT, convergence, report du curseur.
 *
 * Le contrat vérifié ici est celui du document répliqué Yjs, repris de
 * l'application Write. Il remplace l'algèbre d'opérations de blocs de la
 * version précédente, dont le défaut n'était pas un bogue mais une limite de
 * modèle : à la granularité du bloc, deux personnes qui écrivent dans le même
 * paragraphe s'effacent l'une l'autre, et aucun test d'algèbre ne pouvait le
 * voir puisque l'algèbre, elle, était juste.
 *
 * C'est donc cette propriété-là — **deux frappes concurrentes dans la même
 * phrase survivent toutes les deux** — que ce fichier surveille en premier.
 *
 * @vitest-environment jsdom
 */

import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import {
  BLOCKS_ROOT,
  deltaToRuns,
  DocumentMirror,
  reconcile,
  remapOffset,
  runsToDelta,
  seed,
  syncText,
  textChange,
} from '../src/domain/collab/crdt';
import { generateSessionToken, dataUrlToBlob } from '../src/domain/collab/api';
import { presenceColor, readShareLink } from '../src/domain/collab/session';
import { initials } from '../src/design/components/PresenceAvatars';
import { createEmptyDocument, createParagraph, createTable } from '../src/domain/document/document';
import { makeRun, runsText } from '../src/domain/document/runs';
import {
  isParagraph,
  isTable,
  type ParagraphNode,
  type TableNode,
  type WriterDocumentState,
} from '../src/domain/document/types';

/* ------------------------------------------------------------------ outils */

const ORIGINE = Symbol('test');

/** Un document de test aux identifiants stables — le diff s'y appuie. */
function docAvec(...textes: string[]): WriterDocumentState {
  const doc = createEmptyDocument('Document de test');
  doc.id = 'doc-test';
  doc.blocks = textes.map((texte, index) => ({
    ...createParagraph(texte),
    id: `p${index}`,
  }));
  return doc;
}

/** Le bloc `index`, en tant que paragraphe. */
function para(doc: WriterDocumentState, index: number): ParagraphNode {
  const block = doc.blocks[index];
  if (!block || !isParagraph(block)) throw new Error(`bloc ${index} : paragraphe attendu`);
  return block;
}

function texteDe(doc: WriterDocumentState, index: number): string {
  return runsText(para(doc, index).runs);
}

/** Le même paragraphe, texte remplacé — comme le ferait une frappe. */
function retexte(doc: WriterDocumentState, index: number, texte: string): WriterDocumentState {
  const blocks = [...doc.blocks];
  blocks[index] = { ...para(doc, index), runs: [makeRun(texte)] };
  return { ...doc, blocks };
}

/** Deux répliques amorcées sur le même contenu, comme deux onglets ouverts. */
function deuxRepliques(document: WriterDocumentState): {
  alice: Y.Doc;
  bob: Y.Doc;
  echanger: () => void;
} {
  const alice = new Y.Doc();
  seed(alice, document, ORIGINE);

  const bob = new Y.Doc();
  Y.applyUpdate(bob, Y.encodeStateAsUpdate(alice));

  const echanger = (): void => {
    // Deux différentiels croisés : exactement ce que fait le relais, sans le
    // réseau. L'ordre d'arrivée ne doit rien changer au résultat.
    const versBob = Y.encodeStateAsUpdate(alice, Y.encodeStateVector(bob));
    const versAlice = Y.encodeStateAsUpdate(bob, Y.encodeStateVector(alice));
    Y.applyUpdate(bob, versBob, ORIGINE);
    Y.applyUpdate(alice, versAlice, ORIGINE);
  };

  return { alice, bob, echanger };
}

function lire(ydoc: Y.Doc): WriterDocumentState {
  return new DocumentMirror(ydoc).read();
}

/* ══════════════════════════════════════════════════════════════════════════
 * Ce que le CRDT apporte, et que le diff de blocs ne pouvait pas donner
 * ══════════════════════════════════════════════════════════════════════════ */

describe('convergence : deux personnes dans le même paragraphe', () => {
  it('garde les deux frappes, même au même endroit du même bloc', () => {
    // LE test de non-régression. Avec la synchronisation par diff de blocs,
    // chacune émettait « remplace p0 » et la dernière arrivée gagnait : une
    // phrase entière disparaissait sans le moindre signal.
    const depart = docAvec('Bonjour monde');
    const { alice, bob, echanger } = deuxRepliques(depart);

    reconcile(alice, retexte(lire(alice), 0, 'Bonjour beau monde'), ORIGINE);
    reconcile(bob, retexte(lire(bob), 0, 'Bonjour monde !'), ORIGINE);

    echanger();

    expect(texteDe(lire(alice), 0)).toBe('Bonjour beau monde !');
    expect(texteDe(lire(bob), 0)).toBe('Bonjour beau monde !');
  });

  it('fusionne deux insertions faites au même offset', () => {
    const { alice, bob, echanger } = deuxRepliques(docAvec('AB'));

    reconcile(alice, retexte(lire(alice), 0, 'AXB'), ORIGINE);
    reconcile(bob, retexte(lire(bob), 0, 'AYB'), ORIGINE);
    echanger();

    const chezAlice = texteDe(lire(alice), 0);
    // L'ordre entre X et Y est arbitraire — c'est le CRDT qui tranche — mais il
    // est le **même** des deux côtés, et aucune des deux lettres n'est perdue.
    expect(chezAlice).toBe(texteDe(lire(bob), 0));
    expect(chezAlice).toMatch(/^A[XY][XY]B$/);
  });

  it('n’oppose pas la mise en forme de l’un au texte de l’autre', () => {
    const { alice, bob, echanger } = deuxRepliques(docAvec('gras et suite'));

    // Alice met « gras » en gras ; Bob écrit à la fin du même paragraphe.
    const chezAlice = lire(alice);
    const blocs = [...chezAlice.blocks];
    blocs[0] = {
      ...para(chezAlice, 0),
      runs: [makeRun('gras', { bold: true }), makeRun(' et suite')],
    };
    reconcile(alice, { ...chezAlice, blocks: blocs }, ORIGINE);
    reconcile(bob, retexte(lire(bob), 0, 'gras et suite, ajoutée'), ORIGINE);

    echanger();

    const resultat = para(lire(alice), 0);
    expect(runsText(resultat.runs)).toBe('gras et suite, ajoutée');
    expect(resultat.runs[0]).toMatchObject({ text: 'gras', bold: true });
    expect(lire(bob)).toEqual(lire(alice));
  });

  it('supprime d’un côté ce que l’autre n’a pas touché', () => {
    const { alice, bob, echanger } = deuxRepliques(docAvec('un', 'deux', 'trois'));

    const chezAlice = lire(alice);
    reconcile(
      alice,
      { ...chezAlice, blocks: chezAlice.blocks.filter((b) => b.id !== 'p1') },
      ORIGINE,
    );
    reconcile(bob, retexte(lire(bob), 2, 'trois bis'), ORIGINE);
    echanger();

    const final = lire(alice);
    expect(final.blocks.map((b) => b.id)).toEqual(['p0', 'p2']);
    expect(texteDe(final, 1)).toBe('trois bis');
    expect(lire(bob)).toEqual(final);
  });

  it('converge dans une cellule de tableau comme dans un paragraphe', () => {
    const doc = createEmptyDocument('Tableau');
    doc.id = 'doc-tableau';
    const table = createTable(1, 2);
    table.rows[0]!.cells[0]!.blocks = [{ ...createParagraph('cellule'), id: 'c0' }];
    doc.blocks = [table];

    const { alice, bob, echanger } = deuxRepliques(doc);

    const editerCellule = (ydoc: Y.Doc, texte: string): void => {
      const courant = lire(ydoc);
      const tableau = courant.blocks[0] as TableNode;
      const cellule = tableau.rows[0]!.cells[0]!;
      reconcile(
        ydoc,
        {
          ...courant,
          blocks: [
            {
              ...tableau,
              rows: [
                {
                  ...tableau.rows[0]!,
                  cells: [
                    { ...cellule, blocks: [{ ...cellule.blocks[0]!, runs: [makeRun(texte)] }] },
                    ...tableau.rows[0]!.cells.slice(1),
                  ],
                },
              ],
            },
          ],
        },
        ORIGINE,
      );
    };

    editerCellule(alice, 'cellule modifiée');
    editerCellule(bob, 'cellule');
    echanger();

    const relu = lire(alice);
    const tableau = relu.blocks[0];
    expect(tableau && isTable(tableau)).toBe(true);
    expect(lire(bob)).toEqual(relu);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * Runs ⇄ Y.Text : la correspondance sur laquelle tout repose
 * ══════════════════════════════════════════════════════════════════════════ */

describe('runs et delta', () => {
  it('fait l’aller-retour sans rien perdre du formatage', () => {
    const runs = [
      makeRun('normal '),
      makeRun('gras', { bold: true }),
      makeRun(' et '),
      makeRun('lien', { linkHref: 'https://exemple.fr', color: '#0b5fff' }),
    ];
    expect(deltaToRuns(runsToDelta(runs))).toEqual(runs);
  });

  it('refusionne les plages voisines de formatage identique', () => {
    // Invariant de `SwpHints::MergePortions` : deux plages voisines identiques
    // n'en font qu'une, sinon la comparaison de formatage devient instable.
    const delta = [{ insert: 'abc' }, { insert: 'def' }];
    expect(deltaToRuns(delta)).toEqual([makeRun('abcdef')]);
  });

  it('ignore les attributs qu’il ne connaît pas', () => {
    // Un pair d'une version ultérieure peut poser des attributs inconnus : les
    // recopier casserait la comparaison de formatage, donc la fusion.
    const runs = deltaToRuns([{ insert: 'x', attributes: { bold: true, quelqueChose: 42 } }]);
    expect(runs).toEqual([makeRun('x', { bold: true })]);
  });

  it('n’écrit que la partie modifiée du paragraphe', () => {
    const ydoc = new Y.Doc();
    seed(ydoc, docAvec('Bonjour monde', 'Second paragraphe'), ORIGINE);

    const blocs = ydoc.getArray<Y.Map<unknown>>(BLOCKS_ROOT);
    const texteIntact = blocs.get(1).get('text');

    reconcile(ydoc, retexte(lire(ydoc), 0, 'Bonjour le monde'), ORIGINE);

    // Le paragraphe voisin n'est pas reconstruit : c'est ce qui préserve les
    // modifications concurrentes qu'il pourrait porter, et l'identité d'objet
    // dont le moteur de mise en page se sert pour ne pas tout repaginer.
    expect(blocs.get(1).get('text')).toBe(texteIntact);
  });

  it('ne produit aucune trame quand rien n’a changé', () => {
    const ydoc = new Y.Doc();
    seed(ydoc, docAvec('inchangé'), ORIGINE);

    let trames = 0;
    ydoc.on('update', () => {
      trames += 1;
    });
    reconcile(ydoc, lire(ydoc), ORIGINE);

    expect(trames).toBe(0);
  });

  it('applique la mise en forme à la plage exacte', () => {
    const ytext = new Y.Text();
    const ydoc = new Y.Doc();
    ydoc.getMap('racine').set('t', ytext);

    syncText(ytext, [makeRun('abcdef')]);
    syncText(ytext, [makeRun('abc'), makeRun('def', { italic: true })]);

    expect(deltaToRuns(ytext.toDelta())).toEqual([
      makeRun('abc'),
      makeRun('def', { italic: true }),
    ]);
  });

  it('retire une mise en forme aussi bien qu’elle la pose', () => {
    const ytext = new Y.Text();
    const ydoc = new Y.Doc();
    ydoc.getMap('racine').set('t', ytext);

    syncText(ytext, [makeRun('abc', { bold: true })]);
    syncText(ytext, [makeRun('abc')]);

    expect(deltaToRuns(ytext.toDelta())).toEqual([makeRun('abc')]);
  });
});

describe('textChange : la plage réellement remplacée', () => {
  it('voit une frappe comme une insertion d’un caractère', () => {
    expect(textChange('abc', 'abXc')).toEqual({ at: 2, removed: 0, inserted: 'X' });
  });

  it('voit une suppression comme telle', () => {
    expect(textChange('abcdef', 'abef')).toEqual({ at: 2, removed: 2, inserted: '' });
  });

  it('voit un remplacement de sélection', () => {
    expect(textChange('bonjour', 'bonsoir')).toEqual({ at: 3, removed: 3, inserted: 'soi' });
  });

  it('ne rend rien quand les deux chaînes sont égales', () => {
    expect(textChange('idem', 'idem')).toBeNull();
  });

  it('ne coupe jamais un emoji en deux', () => {
    // Deux emojis distincts partagent leur premier demi-caractère : une borne
    // posée entre les deux laisserait un substitut orphelin dans le document.
    const changement = textChange('a😀b', 'a😁b');
    expect(changement).not.toBeNull();
    const reconstruit =
      'a😀b'.slice(0, changement!.at) +
      changement!.inserted +
      'a😀b'.slice(changement!.at + changement!.removed);
    expect(reconstruit).toBe('a😁b');
    expect(changement!.inserted).toBe('😁');
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * Lecture : ce qui remonte dans l'éditeur
 * ══════════════════════════════════════════════════════════════════════════ */

describe('miroir de lecture', () => {
  it('conserve l’identité des blocs qu’une modification distante n’a pas touchés', () => {
    const ydoc = new Y.Doc();
    seed(ydoc, docAvec('un', 'deux', 'trois'), ORIGINE);

    const miroir = new DocumentMirror(ydoc);
    const avant = miroir.read();

    const pair = new Y.Doc();
    Y.applyUpdate(pair, Y.encodeStateAsUpdate(ydoc));
    reconcile(pair, retexte(lire(pair), 0, 'un modifié'), ORIGINE);

    const evenements: Y.YEvent<Y.AbstractType<unknown>>[] = [];
    ydoc.getArray<Y.Map<unknown>>(BLOCKS_ROOT).observeDeep((events) => evenements.push(...events));
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(pair, Y.encodeStateVector(ydoc)), ORIGINE);
    miroir.invalidate(evenements);

    const apres = miroir.read();
    expect(texteDe(apres, 0)).toBe('un modifié');
    // Les deux autres paragraphes sont les **mêmes objets** : le moteur de mise
    // en page s'en sert pour ne repaginer que ce qui a bougé.
    expect(apres.blocks[1]).toBe(avant.blocks[1]);
    expect(apres.blocks[2]).toBe(avant.blocks[2]);
  });

  it('rend le titre, la mise en page et le style par défaut', () => {
    const depart = docAvec('texte');
    depart.meta.title = 'Rapport trimestriel';
    depart.pageSetup = { ...depart.pageSetup, marginLeftMm: 30 };

    const ydoc = new Y.Doc();
    seed(ydoc, depart, ORIGINE);

    const relu = lire(ydoc);
    expect(relu.meta.title).toBe('Rapport trimestriel');
    expect(relu.pageSetup.marginLeftMm).toBe(30);
    expect(relu.defaults).toEqual(depart.defaults);
    expect(relu.id).toBe('doc-test');
  });

  it('ne rend jamais un document sans bloc', () => {
    // Le curseur n'aurait nulle part où se poser.
    const relu = lire(new Y.Doc());
    expect(relu.blocks).toHaveLength(1);
    expect(texteDe(relu, 0)).toBe('');
  });

  it('conserve les attributs de paragraphe et de liste', () => {
    const depart = docAvec('élément');
    depart.blocks[0] = {
      ...para(depart, 0),
      alignment: 'center',
      listKind: 'ordered',
      listId: 'liste-1',
      listLevel: 2,
      headingLevel: undefined as never,
    };
    delete (depart.blocks[0] as ParagraphNode).headingLevel;

    const ydoc = new Y.Doc();
    seed(ydoc, depart, ORIGINE);

    expect(para(lire(ydoc), 0)).toMatchObject({
      alignment: 'center',
      listKind: 'ordered',
      listId: 'liste-1',
      listLevel: 2,
    });
  });

  it('bascule un paragraphe en titre sans reconstruire son texte', () => {
    const ydoc = new Y.Doc();
    seed(ydoc, docAvec('Deviendra un titre'), ORIGINE);

    const texteAvant = ydoc.getArray<Y.Map<unknown>>(BLOCKS_ROOT).get(0).get('text');
    const courant = lire(ydoc);
    reconcile(
      ydoc,
      {
        ...courant,
        blocks: [{ ...para(courant, 0), type: 'heading', headingLevel: 2 }],
      },
      ORIGINE,
    );

    const relu = para(lire(ydoc), 0);
    expect(relu.type).toBe('heading');
    expect(relu.headingLevel).toBe(2);
    expect(runsText(relu.runs)).toBe('Deviendra un titre');
    // Un titre est un paragraphe avec un niveau, pas un autre nœud : le texte
    // répliqué reste le même, donc les frappes concurrentes y survivent.
    expect(ydoc.getArray<Y.Map<unknown>>(BLOCKS_ROOT).get(0).get('text')).toBe(texteAvant);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * Curseur
 * ══════════════════════════════════════════════════════════════════════════ */

describe('report du curseur', () => {
  it('pousse le point quand on écrit avant lui', () => {
    expect(remapOffset(10, { at: 3, removed: 0, inserted: 'abc' })).toBe(13);
  });

  it('ne touche pas au point quand on écrit après lui', () => {
    expect(remapOffset(2, { at: 5, removed: 0, inserted: 'abc' })).toBe(2);
  });

  it('laisse le point en place quand l’insertion tombe exactement dessus', () => {
    // Le texte du pair s'insère *après* le curseur local : celui-ci ne bouge
    // pas, sans quoi taper à deux au même endroit ferait fuir le caret.
    expect(remapOffset(5, { at: 5, removed: 0, inserted: 'xyz' })).toBe(5);
  });

  it('ramène le point au début d’une suppression qui l’englobe', () => {
    expect(remapOffset(7, { at: 4, removed: 6, inserted: '' })).toBe(4);
  });

  it('décale le point d’après une suppression qui le précède', () => {
    expect(remapOffset(20, { at: 4, removed: 6, inserted: '' })).toBe(14);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * Partage : liens, présence, images
 * ══════════════════════════════════════════════════════════════════════════ */

describe('liens de partage', () => {
  it('lit la signature et l’adresse dans l’URL', () => {
    expect(readShareLink('?session=sess-abcdefghijkl&email=alice%40exemple.fr')).toEqual({
      tokenSession: 'sess-abcdefghijkl',
      email: 'alice@exemple.fr',
    });
  });

  it('rend null quand l’un des deux manque', () => {
    expect(readShareLink('?session=sess-abcdefghijkl')).toBeNull();
    expect(readShareLink('')).toBeNull();
  });

  it('produit un jeton lisible et assez long pour n’être pas énumérable', () => {
    const jeton = generateSessionToken('Rapport trimestriel — T3 2026');
    // 12 caractères minimum côté serveur (`MIN_TOKEN_LEN`).
    expect(jeton.length).toBeGreaterThanOrEqual(12);
    expect(jeton).toMatch(/^[a-z0-9-]+$/);
    expect(jeton).toContain('rapport-trimestriel');
    // 8 octets de hasard : deux appels ne coïncident pas.
    expect(generateSessionToken('Rapport')).not.toBe(generateSessionToken('Rapport'));
  });

  it('produit un jeton valide même sans titre exploitable', () => {
    const jeton = generateSessionToken('中文标题');
    expect(jeton).toMatch(/^[a-z0-9-]{12,128}$/);
  });
});

describe('présence', () => {
  it('donne à chacun la même couleur chez tous', () => {
    // Déterministe et non aléatoire : deux participants doivent pouvoir parler
    // du « curseur rouge » et désigner la même personne.
    expect(presenceColor('alice')).toBe(presenceColor('alice'));
    expect(presenceColor('alice')).toMatch(/^var\(--presence-[1-8]\)$/);
  });

  it('abrège les noms en initiales', () => {
    expect(initials('Alice Martin')).toBe('AM');
    expect(initials('alice')).toBe('AL');
    expect(initials('  ')).toBe('?');
  });
});

describe('images du partage', () => {
  it('convertit une data: en Blob déposable', () => {
    const blob = dataUrlToBlob(
      'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
    );
    expect(blob).not.toBeNull();
    expect(blob!.type).toBe('image/gif');
    expect(blob!.size).toBeGreaterThan(0);
  });

  it('refuse ce qui n’est pas une data: base64', () => {
    expect(dataUrlToBlob('https://exemple.fr/x.png')).toBeNull();
    expect(dataUrlToBlob('data:image/png,pas-du-base64')).toBeNull();
  });
});
