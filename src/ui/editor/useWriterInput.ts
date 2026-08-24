/**
 * Hook central de contrôle. Transposition de `SwEditWin` — la fenêtre qui, dans
 * Writer, traduit les événements de saisie en commandes sur le modèle.
 *
 * Principe, imposé par le cahier des charges : **rien n'est lu depuis le DOM**. Ni le
 * texte, ni la position du curseur, ni les limites de ligne. Le clavier et la
 * souris produisent des commandes, les commandes transforment l'état, et le
 * moteur recalcule la géométrie. Le DOM n'en est que la projection.
 *
 * La saisie passe par une zone de texte invisible plutôt que par
 * `contenteditable` : c'est ce qui permet de recevoir les méthodes de saisie
 * asiatiques, la dictée et le collage système sans jamais laisser le navigateur
 * modifier le document de son propre chef.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from 'react';
import {
  createParagraph,
  createTable,
  insertBlockAfter,
  paragraphIndex,
  paragraphText,
  previousParagraphId,
  removeBlocks,
  replaceParagraph,
} from '../../domain/document/document';
import { normalizeUrl } from '../../domain/document/url';
import type {
  DocumentPosition,
  ListKind,
  ParagraphNode,
  RunFormatting,
  TextRun,
  WriterDocumentState,
} from '../../domain/document/types';
import {
  formattingAt,
  insertTextInRuns,
  makeRun,
  normalizeRuns,
  runFormatting,
  type RunFormatPatch,
} from '../../domain/document/runs';
import {
  caretGeometry,
  collapsedSelection,
  lineBounds,
  makeSelection,
  moveHorizontal,
  moveVertical,
  normalizeSelection,
  positionFromPoint,
  selectionRects,
  wordRangeAt,
  type CaretGeometry,
  type SelectionRect,
} from '../../domain/engine/cursor';
import {
  activeFormatting,
  applyParagraphFormat,
  applyRunFormat,
  changeListLevel,
  clearRunFormat,
  createEditorState,
  deleteBackward,
  deleteForward,
  deleteSelection,
  extractFragment,
  insertBlockPageBreak,
  insertFragment,
  insertLineBreak,
  insertText,
  selectAll,
  selectionText,
  setHeading,
  setSelection,
  splitParagraph,
  toggleList,
  toggleListChecked,
  toggleRunFormat,
  type DocumentFragment,
  type EditorState,
  type ParagraphPatch,
} from '../../domain/engine/edit';
import {
  canRedo,
  canUndo,
  commit,
  createSession,
  deletionGroup,
  redo,
  typingGroup,
  undo,
  type EditorSession,
  type GroupingKey,
} from '../../domain/engine/history';
import { createMeasurer, type TextMeasurer } from '../../domain/engine/measure';
import { paginateDocument, type DocumentLayout, type PlacedParagraph } from '../../domain/engine/paginate';

/**
 * Dernier fragment copié depuis cet éditeur.
 *
 * Le presse-papiers du système ne transporte que du texte et du HTML ; y écrire
 * notre modèle demanderait un type MIME propriétaire, que les navigateurs
 * filtrent. On garde donc le fragment de côté et on le reconnaît au collage par
 * son texte : un copier-coller interne conserve ainsi tout son formatage, et un
 * collage venu d'ailleurs retombe proprement sur le texte brut.
 */
let lastCopied: { text: string; fragment: DocumentFragment } | null = null;

export interface WriterCommands {
  toggleBold: () => void;
  toggleItalic: () => void;
  toggleUnderline: () => void;
  toggleStrike: () => void;
  setFontFamily: (family: string | null) => void;
  setFontSize: (sizePt: number | null) => void;
  setColor: (color: string | null) => void;
  setHighlight: (color: string | null) => void;
  clearFormatting: () => void;
  setHeadingLevel: (level: 0 | 1 | 2 | 3 | 4 | 5 | 6) => void;
  setAlignment: (alignment: ParagraphNode['alignment']) => void;
  setLineSpacing: (spacing: number) => void;
  toggleSpaceBefore: () => void;
  toggleSpaceAfter: () => void;
  indent: (direction: 1 | -1) => void;
  insertPageBreak: () => void;
  adjustFontSize: (delta: number) => void;
  toggleList: (kind: ListKind) => void;
  changeListLevel: (direction: 1 | -1) => void;
  toggleTask: (blockId: string) => void;
  /** Renvoie `false` si l'adresse est refusée : le dialogue le signale alors. */
  setLink: (url: string) => boolean;
  removeLink: () => void;
  insertTable: (rows: number, cols: number) => void;
  insertMath: (latex: string, display: boolean) => void;
  updateMath: (blockId: string, latex: string, display: boolean) => void;
  deleteMath: (blockId: string) => void;
  goToBlock: (blockId: string) => void;
  undo: () => void;
  redo: () => void;
  selectAll: () => void;
  replaceDocument: (doc: WriterDocumentState) => void;
}

export interface WriterController {
  session: EditorSession;
  layout: DocumentLayout;
  measurer: TextMeasurer;
  activeFormat: RunFormatting;
  currentParagraph: ParagraphNode | null;
  caret: CaretGeometry | null;
  rects: SelectionRect[];
  /** Paragraphes posés, regroupés par page — ce que chaque feuille doit peindre. */
  placementsByPage: { blockId: string; placed: PlacedParagraph }[][];
  isFocused: boolean;
  canUndo: boolean;
  canRedo: boolean;
  zoom: number;
  setZoom: (zoom: number) => void;
  inputRef: MutableRefObject<HTMLTextAreaElement | null>;
  focus: () => void;
  run: (label: string, transform: (state: EditorState) => EditorState) => void;
  commands: WriterCommands;
  handlers: {
    onKeyDown: (event: React.KeyboardEvent) => void;
    onCompositionStart: () => void;
    onCompositionEnd: (event: React.CompositionEvent<HTMLTextAreaElement>) => void;
    onFocus: () => void;
    onBlur: () => void;
    onCopy: (event: React.ClipboardEvent) => void;
    onCut: (event: React.ClipboardEvent) => void;
    onPaste: (event: React.ClipboardEvent) => void;
    onPointerDown: (event: React.PointerEvent<HTMLDivElement>, pageIndex: number) => void;
    onPointerMove: (event: React.PointerEvent<HTMLDivElement>, pageIndex: number) => void;
    onPointerUp: (event: React.PointerEvent<HTMLDivElement>, pageIndex: number) => void;
  };
}

const INDENT_STEP_PT = 36; // 1,27 cm — le pas de tabulation par défaut de Writer.
/** Bornes de corps de police, reprises de l'application Write. */
export const MIN_FONT_SIZE_PT = 6;
export const MAX_FONT_SIZE_PT = 96;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2;

/**
 * Actions que le contrôleur déclenche mais n'implémente pas : elles ouvrent une
 * fenêtre du navigateur ou un dialogue, ce qui n'est pas de son ressort.
 */
export interface WriterHooks {
  onPrint?: () => void;
  onOpenFindReplace?: () => void;
  onOpenLink?: () => void;
  onOpenMath?: () => void;
  onEditMath?: (blockId: string, latex: string, display: boolean) => void;
}

export function useWriterInput(
  initialDocument: WriterDocumentState,
  hooks: WriterHooks = {},
): WriterController {
  const measurer = useMemo(() => createMeasurer(), []);
  const [session, setSession] = useState<EditorSession>(() =>
    createSession(createEditorState(initialDocument)),
  );
  const [isFocused, setFocused] = useState(false);
  const [zoom, setZoomState] = useState(1);
  const [fontsTick, setFontsTick] = useState(0);

  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const composing = useRef(false);
  const dragging = useRef(false);

  // Les actions de l'application vivent dans une réf : le gestionnaire clavier
  // peut ainsi les appeler sans les compter parmi ses dépendances, et rester
  // stable d'un rendu à l'autre.
  const hooksRef = useRef(hooks);
  hooksRef.current = hooks;

  /**
   * Les métriques d'une fonte changent au moment où elle finit de charger. Un
   * document mis en page avant ce moment serait mesuré avec la fonte de repli,
   * puis peint avec la vraie : les lignes ne tomberaient pas au bon endroit.
   */
  useEffect(() => {
    if (typeof document === 'undefined' || !document.fonts) return;
    let cancelled = false;
    void document.fonts.ready.then(() => {
      if (!cancelled) setFontsTick((tick) => tick + 1);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const layout = useMemo(
    () => paginateDocument(session.state.doc, { measurer }),
    // `fontsTick` force un recalcul quand les fontes deviennent disponibles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session.state.doc, measurer, fontsTick],
  );

  const focus = useCallback(() => {
    inputRef.current?.focus({ preventScroll: true });
  }, []);

  /**
   * Applique une commande et l'inscrit à l'historique.
   *
   * La transformation **et** la clé de regroupement sont calculées à
   * l'intérieur du réducteur, à partir de l'état courant. Les calculer dehors
   * les figerait à l'état du rendu : deux frappes arrivées dans le même lot —
   * ce que React 18 regroupe systématiquement — partiraient alors du même
   * point de départ, et la seconde écraserait la première.
   */
  const run = useCallback(
    (
      label: string,
      transform: (state: EditorState) => EditorState,
      groupingOf?: (before: EditorState, after: EditorState) => GroupingKey | null,
    ) => {
      setSession((current) => {
        const next = transform(current.state);
        return commit(current, label, next, groupingOf?.(current.state, next) ?? null);
      });
    },
    [],
  );

  /** Déplace le curseur sans rien inscrire à l'historique. */
  const move = useCallback((transform: (state: EditorState) => EditorState) => {
    setSession((current) => ({ ...current, state: transform(current.state) }));
  }, []);

  const caret = useMemo(
    () => caretGeometry(layout, session.state.selection.focus, measurer),
    [layout, session.state.selection.focus, measurer],
  );

  const rects = useMemo(
    () => selectionRects(session.state.doc, layout, session.state.selection, measurer),
    [session.state.doc, layout, session.state.selection, measurer],
  );

  const placementsByPage = useMemo(() => {
    const pages: { blockId: string; placed: PlacedParagraph }[][] = layout.pages.map(() => []);
    for (const [blockId, entries] of layout.placements) {
      for (const entry of entries) {
        pages[entry.pageIndex]?.push({ blockId, placed: entry.placed });
      }
    }
    return pages;
  }, [layout]);

  const activeFormat = useMemo(() => activeFormatting(session.state), [session.state]);

  const currentParagraph = useMemo(
    () => paragraphIndex(session.state.doc).byId.get(session.state.selection.focus.blockId)
      ?.paragraph ?? null,
    [session.state.doc, session.state.selection.focus.blockId],
  );

  /* ------------------------------------------------------------- commandes */

  const patchRun = useCallback(
    (label: string, patch: RunFormatPatch) => {
      run(label, (state) => applyRunFormat(state, patch));
      focus();
    },
    [run, focus],
  );

  const patchParagraph = useCallback(
    (label: string, patch: ParagraphPatch) => {
      run(label, (state) => applyParagraphFormat(state, patch));
      focus();
    },
    [run, focus],
  );

  const commands = useMemo<WriterCommands>(
    () => ({
      toggleBold: () => {
        run('Gras', (state) => toggleRunFormat(state, 'bold'));
        focus();
      },
      toggleItalic: () => {
        run('Italique', (state) => toggleRunFormat(state, 'italic'));
        focus();
      },
      toggleUnderline: () => {
        run('Souligné', (state) => toggleRunFormat(state, 'underline'));
        focus();
      },
      toggleStrike: () => {
        run('Barré', (state) => toggleRunFormat(state, 'strikeThrough'));
        focus();
      },
      setFontFamily: (family) => patchRun('Police', { fontFamily: family }),
      setFontSize: (sizePt) => patchRun('Taille', { fontSizePt: sizePt }),
      setColor: (color) => patchRun('Couleur', { color }),
      setHighlight: (color) => patchRun('Surlignage', { backgroundColor: color }),
      clearFormatting: () => {
        run('Effacer la mise en forme', (state) => clearRunFormat(state));
        focus();
      },
      setHeadingLevel: (level) => {
        run('Style de paragraphe', (state) => setHeading(state, level));
        focus();
      },
      setAlignment: (alignment) => patchParagraph('Alignement', { alignment: alignment ?? null }),
      setLineSpacing: (spacing) => patchParagraph('Interligne', { lineSpacing: spacing }),

      toggleSpaceBefore: () => {
        setSession((current) => {
          const node = currentNode(current.state);
          const pose = (node?.marginTopPt ?? 0) > 0;
          return commit(
            current,
            'Espacement avant',
            applyParagraphFormat(current.state, {
              marginTopPt: pose ? 0 : current.state.doc.defaults.fontSizePt,
            }),
          );
        });
        focus();
      },

      toggleSpaceAfter: () => {
        setSession((current) => {
          const node = currentNode(current.state);
          const pose = (node?.marginBottomPt ?? 0) > 0;
          return commit(
            current,
            'Espacement après',
            applyParagraphFormat(current.state, {
              marginBottomPt: pose ? 0 : current.state.doc.defaults.fontSizePt,
            }),
          );
        });
        focus();
      },

      indent: (direction) => {
        setSession((current) => {
          const node = currentNode(current.state);
          // Dans une liste, `Tab` change le **niveau** : c'est ce que fait
          // Writer, et l'usager n'a pas à savoir dans lequel des deux cas il
          // se trouve pour obtenir le décalage qu'il attend.
          if (node?.listKind !== undefined) {
            return commit(current, 'Niveau de liste', changeListLevel(current.state, direction));
          }
          const now = node?.indentLeftPt ?? 0;
          // Le retrait ne descend pas sous zéro : un retrait négatif ferait
          // sortir le texte de la zone imprimable.
          const next = Math.max(0, now + direction * INDENT_STEP_PT);
          return commit(
            current,
            'Retrait',
            applyParagraphFormat(current.state, { indentLeftPt: next === 0 ? null : next }),
          );
        });
        focus();
      },

      adjustFontSize: (delta) => {
        setSession((current) => {
          const actuel = activeFormatting(current.state).fontSizePt
            ?? current.state.doc.defaults.fontSizePt;
          const taille = Math.max(MIN_FONT_SIZE_PT, Math.min(MAX_FONT_SIZE_PT, actuel + delta));
          return commit(current, 'Taille', applyRunFormat(current.state, { fontSizePt: taille }));
        });
        focus();
      },

      toggleList: (kind) => {
        run('Liste', (state) => toggleList(state, kind));
        focus();
      },

      changeListLevel: (direction) => {
        run('Niveau de liste', (state) => changeListLevel(state, direction));
        focus();
      },

      toggleTask: (blockId) => {
        run('Case à cocher', (state) => toggleListChecked(state, blockId));
        focus();
      },

      setLink: (url) => {
        const normalisee = normalizeUrl(url);
        // Adresse refusée : on le dit au dialogue plutôt que de ne rien faire.
        // Un bouton qui ferme sa fenêtre sans rien poser laisse croire au succès.
        if (!normalisee) return false;
        setSession((current) => {
          // Sans sélection, il n'y a rien à marquer : on insère l'adresse comme
          // texte, puis on la marque. Armer un lien sur un curseur replié ne
          // laisserait rien de visible, et l'usager attend de voir son lien.
          if (current.state.selection.isCollapsed) {
            const avant = current.state.selection.focus;
            const avecTexte = insertText(current.state, url.trim() || normalisee);
            const apres = avecTexte.selection.focus;
            const marque = applyRunFormat(
              {
                ...avecTexte,
                selection: makeSelection(avant, apres),
              },
              { linkHref: normalisee },
            );
            return commit(current, 'Lien', {
              ...marque,
              selection: collapsedSelection(apres),
            });
          }
          return commit(current, 'Lien', applyRunFormat(current.state, { linkHref: normalisee }));
        });
        focus();
        return true;
      },

      removeLink: () => patchRun('Retirer le lien', { linkHref: null }),

      insertTable: (rows, cols) => {
        setSession((current) => {
          const position = current.state.selection.focus;
          const table = createTable(rows, cols);
          let doc = insertBlockAfter(current.state.doc, position.blockId, table);

          // Un paragraphe suit toujours le tableau : sans lui, un tableau en
          // fin de document piège le curseur, qui n'a plus aucune position où
          // aller ensuite.
          const at = doc.blocks.findIndex((block) => block.id === table.id);
          if (at >= 0 && at === doc.blocks.length - 1) {
            doc = { ...doc, blocks: [...doc.blocks, createParagraph('')] };
          }

          // Le curseur va dans la première cellule : c'est là qu'on écrit après
          // avoir posé un tableau.
          const premiere = table.rows[0]?.cells[0]?.blocks[0];
          const next: EditorState = {
            doc,
            selection: premiere
              ? collapsedSelection({ blockId: premiere.id, offset: 0 })
              : current.state.selection,
            pendingFormat: null,
          };
          return commit(current, 'Insérer un tableau', next);
        });
        focus();
      },
      insertMath: (latex, display) => {
        setSession((current) => {
          const position = current.state.selection.focus;
          const formulaText = latex.trim();
          if (!formulaText) return current;

          if (display) {
            const mathParagraph = createParagraph(formulaText, {
              alignment: 'center',
              runs: [
                makeRun(formulaText, {
                  mathLatex: formulaText,
                  mathDisplay: true,
                }),
              ],
            });
            const doc = insertBlockAfter(current.state.doc, position.blockId, mathParagraph);
            return commit(current, 'Insérer formule', {
              ...current.state,
              doc,
              selection: collapsedSelection({ blockId: mathParagraph.id, offset: formulaText.length }),
            });
          } else {
            const base = current.state.selection.isCollapsed ? current.state : deleteSelection(current.state);
            const pos = base.selection.focus;
            const node = paragraphIndex(base.doc).byId.get(pos.blockId);
            if (!node) return current;

            const inherited = formattingAt(node.paragraph.runs, pos.offset);
            const formatting = {
              ...inherited,
              mathLatex: formulaText,
              mathDisplay: false,
            };
            const runs = insertTextInRuns(node.paragraph.runs, pos.offset, formulaText, formatting);
            const doc = replaceParagraph(base.doc, pos.blockId, { ...node.paragraph, runs });

            return commit(current, 'Insérer formule', {
              ...base,
              doc,
              selection: collapsedSelection({
                blockId: pos.blockId,
                offset: pos.offset + formulaText.length,
              }),
              pendingFormat: null,
            });
          }
        });
        focus();
      },

      updateMath: (blockId, latex, display) => {
        setSession((current) => {
          const formulaText = latex.trim();
          if (!formulaText) return current;

          const node = paragraphIndex(current.state.doc).byId.get(blockId);
          if (!node) return current;

          let targetOffset = 0;
          let foundMath = false;
          let offsetAccum = 0;

          const newRuns: TextRun[] = [];
          for (const run of node.paragraph.runs) {
            if (!foundMath && run.mathLatex) {
              foundMath = true;
              targetOffset = offsetAccum + formulaText.length;
              newRuns.push(
                makeRun(formulaText, {
                  ...runFormatting(run),
                  mathLatex: formulaText,
                  mathDisplay: display,
                }),
              );
            } else {
              newRuns.push(run);
            }
            offsetAccum += run.text.length;
          }

          if (!foundMath) {
            targetOffset = formulaText.length;
            newRuns.push(
              makeRun(formulaText, {
                mathLatex: formulaText,
                mathDisplay: display,
              }),
            );
          }

          const updatedParagraph: ParagraphNode = {
            ...node.paragraph,
            runs: normalizeRuns(newRuns),
          };
          if (display) {
            updatedParagraph.alignment = 'center';
          } else if (updatedParagraph.alignment === 'center') {
            delete updatedParagraph.alignment;
          }

          const doc = replaceParagraph(current.state.doc, blockId, updatedParagraph);
          return commit(current, 'Modifier formule', {
            ...current.state,
            doc,
            selection: collapsedSelection({ blockId, offset: targetOffset }),
          });
        });
        focus();
      },

      deleteMath: (blockId) => {
        setSession((current) => {
          const index = paragraphIndex(current.state.doc);
          const node = index.byId.get(blockId);
          if (!node) return current;

          // Si le paragraphe ne contient QUE la formule (bloc display ou paragraphe dédié) :
          if (node.paragraph.runs.length <= 1 || node.paragraph.runs.every((r) => r.mathLatex || !r.text)) {
            const prevId = previousParagraphId(current.state.doc, blockId);
            const doc = removeBlocks(current.state.doc, new Set([blockId]));
            const nextIndex = paragraphIndex(doc);
            const fallbackId = prevId ?? nextIndex.order[0] ?? '';
            return commit(current, 'Supprimer formule', {
              ...current.state,
              doc,
              selection: collapsedSelection({ blockId: fallbackId, offset: 0 }),
            });
          }

          // Si la formule est en ligne au milieu d'autre texte : retirer seulement le run mathématique
          let targetOffset = 0;
          let offsetAccum = 0;
          const remainingRuns: TextRun[] = [];
          for (const run of node.paragraph.runs) {
            if (run.mathLatex) {
              targetOffset = offsetAccum;
            } else {
              remainingRuns.push(run);
              offsetAccum += run.text.length;
            }
          }

          const updatedParagraph: ParagraphNode = {
            ...node.paragraph,
            runs: normalizeRuns(remainingRuns.length > 0 ? remainingRuns : [makeRun('')]),
          };

          const doc = replaceParagraph(current.state.doc, blockId, updatedParagraph);
          return commit(current, 'Supprimer formule', {
            ...current.state,
            doc,
            selection: collapsedSelection({ blockId, offset: targetOffset }),
          });
        });
        focus();
      },

      goToBlock: (blockId) => {
        move((state) => setSelection(state, collapsedSelection({ blockId, offset: 0 })));
        focus();
      },
      insertPageBreak: () => {
        run('Saut de page', (state) => insertBlockPageBreak(state));
        focus();
      },
      undo: () => {
        setSession((current) => undo(current));
        focus();
      },
      redo: () => {
        setSession((current) => redo(current));
        focus();
      },
      selectAll: () => {
        move((state) => selectAll(state));
        focus();
      },
      replaceDocument: (doc) => {
        setSession(createSession(createEditorState(doc)));
        focus();
      },
    }),
    [run, move, patchRun, patchParagraph, focus],
  );

  /* --------------------------------------------------------------- clavier */

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      const { key, shiftKey, altKey } = event;
      const meta = event.ctrlKey || event.metaKey;
      const granularity = meta || altKey ? 'word' : 'character';

      /**
       * Pose le curseur, en étendant la sélection si `Maj` est enfoncée.
       *
       * La cible est une **fonction** de l'état courant, pas une valeur : c'est
       * ce qui rend correct un appui maintenu sur une flèche, dont les
       * répétitions peuvent arriver dans le même lot de rendu.
       */
      const goTo = (
        target: (current: EditorState) => { position: DocumentPosition; desiredX: number | null } | null,
      ): void => {
        event.preventDefault();
        move((current) => {
          const next = target(current);
          if (!next) return current;
          return setSelection(
            current,
            shiftKey
              ? makeSelection(current.selection.anchor, next.position, next.desiredX)
              : collapsedSelection(next.position),
          );
        });
      };

      if (meta && !shiftKey) {
        switch (key.toLowerCase()) {
          case 'b': event.preventDefault(); commands.toggleBold(); return;
          case 'i': event.preventDefault(); commands.toggleItalic(); return;
          case 'u': event.preventDefault(); commands.toggleUnderline(); return;
          case 'a': event.preventDefault(); commands.selectAll(); return;
          case 'z': event.preventDefault(); commands.undo(); return;
          case 'y': event.preventDefault(); commands.redo(); return;
          case 'm': event.preventDefault(); commands.clearFormatting(); return;
          case 'l': event.preventDefault(); commands.setAlignment('left'); return;
          case 'e': event.preventDefault(); commands.setAlignment('center'); return;
          case 'r': event.preventDefault(); commands.setAlignment('right'); return;
          case 'j': event.preventDefault(); commands.setAlignment('justify'); return;
          case 'k': event.preventDefault(); hooksRef.current.onOpenLink?.(); return;
          case 'f': event.preventDefault(); hooksRef.current.onOpenFindReplace?.(); return;
          case 'p': event.preventDefault(); hooksRef.current.onPrint?.(); return;
          case ']': event.preventDefault(); commands.indent(1); return;
          case '[': event.preventDefault(); commands.indent(-1); return;
          case '\\': event.preventDefault(); commands.clearFormatting(); return;
          default: break;
        }
      }

      if (meta && shiftKey) {
        switch (key.toLowerCase()) {
          // `Ctrl+Maj+Z` refait, comme `Ctrl+Y` : les deux conventions
          // coexistent selon les plateformes, refuser l'une surprendrait la
          // moitié des usagers.
          case 'z': event.preventDefault(); commands.redo(); return;
          case 'x': event.preventDefault(); commands.toggleStrike(); return;
          case 'e': event.preventDefault(); hooksRef.current.onOpenMath?.(); return;
          case '&': case '7': event.preventDefault(); commands.toggleList('ordered'); return;
          case 'é': case '8': event.preventDefault(); commands.toggleList('bullet'); return;
          case '"': case '9': event.preventDefault(); commands.toggleList('task'); return;
          case '<': event.preventDefault(); commands.adjustFontSize(-1); return;
          case '>': event.preventDefault(); commands.adjustFontSize(1); return;
          default: break;
        }
      }

      if (meta && key >= '1' && key <= '6' && !shiftKey) {
        event.preventDefault();
        commands.setHeadingLevel(Number(key) as 1 | 2 | 3 | 4 | 5 | 6);
        return;
      }

      switch (key) {
        case 'ArrowLeft':
        case 'ArrowRight': {
          event.preventDefault();
          const direction = key === 'ArrowLeft' ? -1 : 1;
          goTo((current) => {
            // Une sélection non vide se replie sur le bord vers lequel on va,
            // plutôt que de faire un pas depuis la tête : c'est le comportement
            // attendu partout, et il évite de perdre un caractère au passage.
            if (!current.selection.isCollapsed && !shiftKey) {
              const { start, end } = normalizeSelection(current.doc, current.selection);
              return { position: direction < 0 ? start : end, desiredX: null };
            }
            return {
              position: moveHorizontal(
                current.doc,
                current.selection.focus,
                direction,
                granularity,
              ),
              desiredX: null,
            };
          });
          return;
        }

        case 'ArrowUp':
        case 'ArrowDown': {
          event.preventDefault();
          const direction = key === 'ArrowUp' ? -1 : 1;
          goTo((current) =>
            moveVertical(
              current.doc,
              layout,
              current.selection.focus,
              direction,
              current.selection.desiredX ?? null,
              measurer,
            ),
          );
          return;
        }

        case 'Home':
        case 'End': {
          event.preventDefault();
          goTo((current) => {
            // `Ctrl+Origine` / `Ctrl+Fin` visent le document ; sans `Ctrl`, la
            // ligne **visuelle**, pas le paragraphe : sur un paragraphe replié
            // en cinq lignes, `Fin` s'arrête au bout de la ligne où l'on est.
            if (meta) {
              const edge = documentEdgeOffset(current.doc, key === 'Home' ? 'start' : 'end');
              return edge ? { position: edge, desiredX: null } : null;
            }
            const bounds = lineBounds(layout, current.selection.focus);
            if (!bounds) return null;
            return {
              position: {
                blockId: current.selection.focus.blockId,
                offset: key === 'Home' ? bounds.start : bounds.end,
              },
              desiredX: null,
            };
          });
          return;
        }

        case 'Backspace':
        case 'Delete': {
          event.preventDefault();
          const direction = key === 'Backspace' ? -1 : 1;
          run(
            'Suppression',
            (current) =>
              direction < 0
                ? deleteBackward(current, granularity)
                : deleteForward(current, granularity),
            (before, after) => {
              const removed = removedCharacter(before, direction);
              if (!removed) return null;
              return deletionGroup(
                before.selection.focus.blockId,
                before.selection.focus.offset,
                after.selection.focus.offset,
                removed,
              );
            },
          );
          return;
        }

        case 'Enter': {
          event.preventDefault();
          if (meta) commands.insertPageBreak();
          else if (shiftKey) run('Saut de ligne', (current) => insertLineBreak(current));
          else run('Nouveau paragraphe', (current) => splitParagraph(current));
          return;
        }

        case 'Tab': {
          // La tabulation reste dans le document : sortir de l'éditeur au
          // clavier se fait par `Échap` puis `Tab`, sinon on ne pourrait jamais
          // en insérer une.
          event.preventDefault();
          if (shiftKey) {
            commands.indent(-1);
            return;
          }
          // En tête d'un élément de liste, `Tab` imbrique — ailleurs, il insère
          // une vraie tabulation. C'est la règle de Writer : le décalage prime
          // là où il a un sens structurel.
          setSession((current) => {
            const node = currentNode(current.state);
            if (node?.listKind !== undefined && current.state.selection.focus.offset === 0) {
              return commit(current, 'Niveau de liste', changeListLevel(current.state, 1));
            }
            return commit(current, 'Tabulation', insertText(current.state, '\t'));
          });
          return;
        }

        case 'Escape':
          event.preventDefault();
          inputRef.current?.blur();
          return;

        default:
          break;
      }
    },
    // Plus aucune dépendance à l'état : le gestionnaire ne lit que `current`,
    // fourni par le réducteur. Il reste donc stable d'un rendu à l'autre.
    [layout, measurer, move, run, commands],
  );

  /* ------------------------------------------------------- saisie de texte */

  /**
   * Saisie de texte, branchée sur l'événement **natif** `beforeinput`.
   *
   * React expose bien un `onBeforeInput`, mais c'est un émulateur bâti sur
   * `keypress` et `textInput` : il ne porte pas `inputType`. Or c'est
   * précisément par `inputType` que les claviers virtuels annoncent leurs
   * effacements (`deleteContentBackward`), la dictée son insertion et le
   * navigateur son autocomplétion — autant de cas qui, sans cela, modifieraient
   * la zone tampon sans jamais atteindre le modèle.
   */
  const handleBeforeInput = useCallback(
    (event: InputEvent) => {
      // Pendant une composition (méthode de saisie asiatique, dictée), on laisse
      // le navigateur travailler : le texte n'arrive qu'à la fin.
      if (composing.current) return;

      // Rien de ce que fait le navigateur dans la zone tampon ne doit
      // subsister : le document est la seule source de vérité.
      event.preventDefault();

      const data = event.data ?? '';

      switch (event.inputType) {
        case 'insertText':
        case 'insertFromPaste':
        case 'insertFromDrop':
        case 'insertReplacementText':
        case 'insertFromYank':
          if (!data) return;
          run(
            'Saisie',
            (state) => insertText(state, data),
            (before, after) =>
              typingGroup(
                before.selection.focus.blockId,
                before.selection.focus.offset,
                after.selection.focus.offset,
                data,
              ),
          );
          return;

        case 'insertLineBreak':
          run('Saut de ligne', (state) => insertLineBreak(state));
          return;

        case 'insertParagraph':
          run('Nouveau paragraphe', (state) => splitParagraph(state));
          return;

        case 'deleteContentBackward':
        case 'deleteByCut':
          run('Suppression', (state) => deleteBackward(state));
          return;

        case 'deleteContentForward':
          run('Suppression', (state) => deleteForward(state));
          return;

        case 'deleteWordBackward':
          run('Suppression', (state) => deleteBackward(state, 'word'));
          return;

        case 'deleteWordForward':
          run('Suppression', (state) => deleteForward(state, 'word'));
          return;

        case 'historyUndo':
          setSession((current) => undo(current));
          return;

        case 'historyRedo':
          setSession((current) => redo(current));
          return;

        default:
          // Type inconnu : on a déjà empêché l'effet par défaut, donc rien ne
          // se produit — ce qui vaut mieux qu'une modification silencieuse de
          // la zone tampon que le modèle ignorerait.
          return;
      }
    },
    [run],
  );

  useEffect(() => {
    const node = inputRef.current;
    if (!node) return;
    node.addEventListener('beforeinput', handleBeforeInput);
    return () => node.removeEventListener('beforeinput', handleBeforeInput);
  }, [handleBeforeInput]);

  const onCompositionStart = useCallback(() => {
    composing.current = true;
  }, []);

  const onCompositionEnd = useCallback(
    (event: React.CompositionEvent<HTMLTextAreaElement>) => {
      composing.current = false;
      const data = event.data;
      // La zone tampon est vidée : elle ne sert qu'à recueillir la composition,
      // le texte vit désormais dans le modèle.
      if (inputRef.current) inputRef.current.value = '';
      if (!data) return;
      run('Saisie', (state) => insertText(state, data));
    },
    [run],
  );

  /* --------------------------------------------------------- presse-papiers */

  const onCopy = useCallback(
    (event: React.ClipboardEvent) => {
      const text = selectionText(session.state);
      if (!text) return;
      event.preventDefault();
      event.clipboardData.setData('text/plain', text);
      lastCopied = { text, fragment: extractFragment(session.state) };
    },
    [session.state],
  );

  const onCut = useCallback(
    (event: React.ClipboardEvent) => {
      const text = selectionText(session.state);
      if (!text) return;
      event.preventDefault();
      event.clipboardData.setData('text/plain', text);
      lastCopied = { text, fragment: extractFragment(session.state) };
      run('Couper', (state) => deleteBackward(state));
    },
    [session.state, run],
  );

  const onPaste = useCallback(
    (event: React.ClipboardEvent) => {
      event.preventDefault();
      const text = event.clipboardData.getData('text/plain');
      if (!text) return;

      if (lastCopied && lastCopied.text === text) {
        const fragment = lastCopied.fragment;
        run('Coller', (state) => insertFragment(state, fragment));
        return;
      }
      // Collage venu d'ailleurs : on respecte au moins les fins de ligne, en
      // les transformant en vrais paragraphes.
      const paragraphs = text.replace(/\r\n?/g, '\n').split('\n');
      run('Coller', (state) =>
        insertFragment(state, {
          paragraphs: paragraphs.map((line) => ({
            runs: [{ text: line }],
            attributes: { type: 'paragraph' as const },
          })),
        }),
      );
    },
    [run],
  );

  /* ---------------------------------------------------------------- souris */

  /** Coordonnées du pointeur dans la zone de contenu d'une page. */
  const pointToContent = useCallback(
    (event: React.PointerEvent<HTMLDivElement>): { x: number; y: number } => {
      const rect = event.currentTarget.getBoundingClientRect();
      // Le rectangle est déjà mis à l'échelle par le zoom : on divise pour
      // revenir aux coordonnées du modèle, qui ignore le zoom.
      const x = (event.clientX - rect.left) / zoom - layout.geometry.contentLeftPx;
      const y = (event.clientY - rect.top) / zoom - layout.geometry.contentTopPx;
      return { x, y };
    },
    [zoom, layout.geometry],
  );

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>, pageIndex: number) => {
      if (event.button !== 0) return;
      const { x, y } = pointToContent(event);
      const position = positionFromPoint(layout, pageIndex, x, y, measurer);
      if (!position) return;

      event.preventDefault();
      focus();

      const paragraph = paragraphIndex(session.state.doc).byId.get(position.blockId)?.paragraph;

      if (event.detail >= 3 && paragraph) {
        // Triple clic : le paragraphe entier.
        const length = paragraphText(paragraph).length;
        move((state) =>
          setSelection(
            state,
            makeSelection(
              { blockId: position.blockId, offset: 0 },
              { blockId: position.blockId, offset: length },
            ),
          ),
        );
        return;
      }

      if (event.detail === 2 && paragraph) {
        const mathRun = paragraph.runs.find((r) => r.mathLatex);
        if (mathRun?.mathLatex) {
          hooksRef.current.onEditMath?.(
            position.blockId,
            mathRun.mathLatex,
            Boolean(mathRun.mathDisplay),
          );
          return;
        }

        const { start, end } = wordRangeAt(paragraphText(paragraph), position.offset);
        move((state) =>
          setSelection(
            state,
            makeSelection(
              { blockId: position.blockId, offset: start },
              { blockId: position.blockId, offset: end },
            ),
          ),
        );
        return;
      }

      dragging.current = true;
      event.currentTarget.setPointerCapture(event.pointerId);
      move((state) =>
        setSelection(
          state,
          event.shiftKey
            ? makeSelection(state.selection.anchor, position)
            : collapsedSelection(position),
        ),
      );
    },
    [layout, measurer, pointToContent, focus, move, session.state.doc],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>, pageIndex: number) => {
      if (!dragging.current) return;
      const { x, y } = pointToContent(event);
      const position = positionFromPoint(layout, pageIndex, x, y, measurer);
      if (!position) return;
      move((state) => setSelection(state, makeSelection(state.selection.anchor, position)));
    },
    [layout, measurer, pointToContent, move],
  );

  const onPointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>, _pageIndex: number) => {
      if (!dragging.current) return;
      dragging.current = false;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    },
    [],
  );

  const setZoom = useCallback((next: number) => {
    setZoomState(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next)));
  }, []);

  return {
    session,
    layout,
    measurer,
    activeFormat,
    currentParagraph,
    caret,
    rects,
    placementsByPage,
    isFocused,
    canUndo: canUndo(session),
    canRedo: canRedo(session),
    zoom,
    setZoom,
    inputRef,
    focus,
    run,
    commands,
    handlers: {
      onKeyDown,
      onCompositionStart,
      onCompositionEnd,
      onFocus: () => setFocused(true),
      onBlur: () => setFocused(false),
      onCopy,
      onCut,
      onPaste,
      onPointerDown,
      onPointerMove,
      onPointerUp,
    },
  };
}

/* ------------------------------------------------------------------ outils */

/** Paragraphe où se trouve la tête du curseur. */
function currentNode(state: EditorState): ParagraphNode | null {
  return paragraphIndex(state.doc).byId.get(state.selection.focus.blockId)?.paragraph ?? null;
}

/** Caractère qu'un effacement va retirer, pour le regroupement d'annulation. */
function removedCharacter(state: EditorState, direction: -1 | 1): string | null {
  if (!state.selection.isCollapsed) return null;
  const position = state.selection.focus;
  const paragraph = paragraphIndex(state.doc).byId.get(position.blockId)?.paragraph;
  if (!paragraph) return null;

  const text = paragraphText(paragraph);
  const other = moveHorizontal(state.doc, position, direction, 'character');
  if (other.blockId !== position.blockId) return null;

  const from = Math.min(position.offset, other.offset);
  const to = Math.max(position.offset, other.offset);
  return to > from ? text.slice(from, to) : null;
}

/** Première ou dernière position du document (`Ctrl+Origine` / `Ctrl+Fin`). */
function documentEdgeOffset(
  doc: WriterDocumentState,
  edge: 'start' | 'end',
): { blockId: string; offset: number } | null {
  const { order, byId } = paragraphIndex(doc);
  const id = edge === 'start' ? order[0] : order[order.length - 1];
  if (!id) return null;
  const paragraph = byId.get(id)?.paragraph;
  if (!paragraph) return null;
  return { blockId: id, offset: edge === 'start' ? 0 : paragraphText(paragraph).length };
}
