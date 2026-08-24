/**
 * L'éditeur complet assemblé : Barre de menus, Ruban avec icônes vectorielles,
 * Règle graduée, Plan du document (DocumentOutline), Recherche/Remplacement,
 * Palette de commandes (Ctrl+K), Éditeur de formules mathématiques (MathDialog),
 * En-têtes et pieds de page ergonomiques (PageFurnitureDialog),
 * Dialogues de styles/marges et feuilles A4 physiques.
 *
 * Moteur 100 % natif OpenOffice Writer (sw) sans aucune bibliothèque de rich-text externe.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import type { PageSetup, DocumentDefaults, WriterDocumentState } from '../../domain/document/types';
import { paragraphIndex, paragraphText } from '../../domain/document/document';
import { locateOffset } from '../../domain/document/runs';
import { DEFAULT_FURNITURE, type FurnitureBand } from '../../domain/document/pageFurniture';
import { A4Page } from './A4Page';
import { useWriterInput } from './useWriterInput';
import { Ribbon } from '../components/Ribbon';
import { MenuBar, type MenuDefinition } from '../components/MenuBar';
import { DocumentTitle } from '../components/DocumentTitle';
import { Ruler } from '../components/Ruler';
import { DocumentOutline } from '../components/DocumentOutline';
import { FindReplacePanel, type FindReplaceState } from '../dialogs/FindReplacePanel';
import { CommandPalette, type PaletteCommand } from '../dialogs/CommandPalette';
import { StylesAndMarginsDialog } from '../dialogs/StylesAndMarginsDialog';
import { FootnoteDialog } from '../dialogs/FootnoteDialog';
import { MathDialog, type MathDraft } from '../dialogs/MathDialog';
import { PageFurnitureDialog } from '../dialogs/PageFurnitureDialog';
import { HelpDialog } from '../dialogs/HelpDialog';
import { PrintPreviewDialog } from '../dialogs/PrintPreviewDialog';
import {
  findMatches,
  matchNearest,
  matchRange,
  replaceAll,
  replaceMatch,
  selectMatch,
} from '../../domain/engine/search';
import { normalizeSelection, rangeRects } from '../../domain/engine/cursor';
import { downloadPdf } from '../../domain/pdf';
import { shortcutLabel } from '../shortcuts';
import './editor.css';

const PAGE_GAP_PX = 16;

export interface WriterEditorProps {
  initialDocument: WriterDocumentState;
  showMargins?: boolean;
  onSave?: (doc?: WriterDocumentState) => void;
  onOpen?: () => void;
  onPrint?: () => void;
  onExportPdf?: () => void;
  onTitleChange?: (title: string) => void;
}

export function WriterEditor({
  initialDocument,
  showMargins = true,
  onSave,
  onOpen,
  onPrint,
  onExportPdf,
  onTitleChange,
}: WriterEditorProps): JSX.Element {
  const openMathDialogRef = useRef<() => void>(() => {});
  const editMathRef = useRef<(blockId: string, latex: string, display: boolean) => void>(() => {});
  const printRef = useRef<() => void>(() => {});
  const findReplaceRef = useRef<() => void>(() => {});

  const controller = useWriterInput(initialDocument, {
    onPrint: () => printRef.current(),
    onOpenFindReplace: () => findReplaceRef.current(),
    onOpenLink: () => linkButtonRef.current?.click(),
    onOpenMath: () => openMathDialogRef.current(),
    onEditMath: (blockId, latex, display) => editMathRef.current(blockId, latex, display),
  });
  const {
    layout,
    caret,
    rects,
    placementsByPage,
    session,
    zoom,
    setZoom,
    inputRef,
    handlers,
    focus,
    run,
    measurer,
    commands,
    canUndo,
    canRedo,
  } = controller;

  const doc = session.state.doc;
  const geometry = layout.geometry;

  // États des panneaux et dialogues UI
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [findReplaceOpen, setFindReplaceOpen] = useState(false);
  const [showRuler, setShowRuler] = useState(true);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [stylesMarginsOpen, setStylesMarginsOpen] = useState(false);
  const [footnoteDialogOpen, setFootnoteDialogOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  /**
   * Bouton « lien » du ruban.
   *
   * Le menu et `Ctrl+K` déclenchent **ce** bouton plutôt que d'ouvrir un second
   * dialogue : un seul composant à tenir, et le panneau s'ancre là où l'usager
   * s'attend à le voir apparaître.
   */
  const linkButtonRef = useRef<HTMLButtonElement | null>(null);
  const [printPreviewOpen, setPrintPreviewOpen] = useState(false);
  const [mathDraft, setMathDraft] = useState<MathDraft | null>(null);
  const [furnitureBandToEdit, setFurnitureBandToEdit] = useState<FurnitureBand | null>(null);

  const [findReplaceState, setFindReplaceState] = useState<FindReplaceState>({
    query: '',
    replacement: '',
    options: { matchCase: false, wholeWord: false },
    showReplace: false,
  });

  const handleTitleCommit = useCallback(
    (newTitle: string) => {
      commands.replaceDocument({
        ...doc,
        meta: {
          ...doc.meta,
          title: newTitle,
          updatedAt: new Date().toISOString(),
        },
      });
      onTitleChange?.(newTitle);
    },
    [commands, doc, onTitleChange],
  );

  const openMathDialog = useCallback(() => {
    const focusPos = session.state.selection.focus;
    const node = paragraphIndex(session.state.doc).byId.get(focusPos.blockId);
    if (node) {
      const { runIndex } = locateOffset(node.paragraph.runs, focusPos.offset);
      const run = node.paragraph.runs[runIndex] ?? node.paragraph.runs[0];
      if (run?.mathLatex) {
        setMathDraft({
          blockId: node.paragraph.id,
          latex: run.mathLatex,
          display: Boolean(run.mathDisplay),
        });
        return;
      }
      const mathRun = node.paragraph.runs.find((r) => r.mathLatex);
      if (mathRun?.mathLatex) {
        setMathDraft({
          blockId: node.paragraph.id,
          latex: mathRun.mathLatex,
          display: Boolean(mathRun.mathDisplay),
        });
        return;
      }
    }
    setMathDraft({ latex: '', display: false });
  }, [session.state]);

  const handleEditMath = useCallback((blockId: string, latex: string, display: boolean) => {
    setMathDraft({ blockId, latex, display });
  }, []);

  const handleExportPdf = useCallback(() => {
    if (onExportPdf) {
      onExportPdf();
    } else {
      downloadPdf(doc, layout);
    }
  }, [onExportPdf, doc, layout]);

  const handlePrint = useCallback(() => {
    if (onPrint) {
      onPrint();
    } else {
      window.print();
    }
  }, [onPrint]);

  const handleOpenPrintPreview = useCallback(() => {
    setPrintPreviewOpen(true);
  }, []);

  openMathDialogRef.current = openMathDialog;
  editMathRef.current = handleEditMath;
  printRef.current = handlePrint;
  findReplaceRef.current = () => setFindReplaceOpen(true);

  // Focus initial
  useEffect(() => {
    focus();
  }, [focus]);

  /**
   * Raccourcis qui doivent fonctionner même quand le focus a quitté le document
   * — dans un dialogue, la règle ou le plan.
   *
   * `Ctrl+K` et `Ctrl+F` en sont **absents** volontairement : le contrôleur les
   * traite déjà. Les gérer ici aussi les déclencherait deux fois, `preventDefault`
   * n'arrêtant pas la propagation — `Ctrl+K` ouvrait le lien *et* la palette.
   */
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      const meta = e.ctrlKey || e.metaKey;
      if (meta && e.shiftKey && e.key.toLowerCase() === 'p') {
        // Convention des palettes de commandes, partagée avec les éditeurs de
        // code : `Ctrl+K` reste au lien hypertexte, comme dans Writer et Word.
        e.preventDefault();
        setCommandPaletteOpen((open) => !open);
      } else if (meta && e.shiftKey && e.key.toLowerCase() === 'e') {
        e.preventDefault();
        openMathDialog();
      } else if (meta && e.shiftKey && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        handleOpenPrintPreview();
      } else if (meta && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        handlePrint();
      }
    };

    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, [handlePrint, handleOpenPrintPreview, openMathDialog]);

  // Statistiques en temps réel
  const statistics = useMemo(() => computeStatistics(doc), [doc]);

  // Recherche & Remplacement
  const matches = useMemo(
    () => (findReplaceOpen && findReplaceState.query ? findMatches(doc, findReplaceState.query, findReplaceState.options) : []),
    [doc, findReplaceOpen, findReplaceState.query, findReplaceState.options],
  );

  /**
   * Rang de l'occurrence courante.
   *
   * On repère depuis le **début** de la sélection, pas depuis sa tête : une
   * occurrence sélectionnée a sa tête à sa propre fin, si bien que partir de la
   * tête désignerait déjà l'occurrence suivante — et `Entrée` en sauterait une
   * sur deux.
   */
  const currentMatchIndex = useMemo(() => {
    if (matches.length === 0) return -1;
    const { start } = normalizeSelection(doc, session.state.selection);
    return matchNearest(doc, matches, start);
  }, [doc, matches, session.state.selection]);

  /**
   * Rectangles de toutes les occurrences.
   *
   * Surligner **toutes** les occurrences, et pas seulement la courante, permet
   * de juger d'un coup d'œil si le mot cherché est le bon : un compteur seul
   * oblige à parcourir le document pour s'en assurer.
   *
   * La géométrie vient du moteur (`rangeRects`), la même que celle de la
   * sélection — deux calculs distincts finiraient par diverger.
   */
  const searchRects = useMemo(() => {
    if (matches.length === 0) return [];
    return matches.flatMap((match, index) => {
      const { start, end } = matchRange(match);
      return rangeRects(doc, layout, start, end, measurer).map((rect) => ({
        rect,
        current: index === currentMatchIndex,
      }));
    });
  }, [matches, currentMatchIndex, doc, layout, measurer]);

  const handleSearchNavigate = useCallback(
    (direction: 1 | -1) => {
      if (matches.length === 0) return;
      const nextIndex = (currentMatchIndex + direction + matches.length) % matches.length;
      const targetMatch = matches[nextIndex];
      if (targetMatch) {
        run('Sélectionner occurrence', (state) => selectMatch(state, targetMatch));
      }
    },
    [matches, currentMatchIndex, run],
  );

  const handleSearchReplace = useCallback(() => {
    if (matches.length === 0 || currentMatchIndex < 0) return;
    const targetMatch = matches[currentMatchIndex];
    if (targetMatch) {
      run('Remplacer', (state) =>
        replaceMatch(state, targetMatch, findReplaceState.replacement),
      );
    }
  }, [matches, currentMatchIndex, findReplaceState.replacement, run]);

  const handleSearchReplaceAll = useCallback(() => {
    if (!findReplaceState.query) return;
    run('Tout remplacer', (state) =>
      replaceAll(state, findReplaceState.query, findReplaceState.options, findReplaceState.replacement).state,
    );
  }, [findReplaceState, run]);

  // Sélection d'un titre depuis le plan du document
  const handleSelectHeading = useCallback(
    (blockId: string) => {
      commands.goToBlock(blockId);
      focus();
    },
    [commands, focus],
  );

  // Mise à jour des marges et styles par défaut
  const handleSavePageSetupAndDefaults = useCallback(
    (nextPageSetup: PageSetup, nextDefaults: DocumentDefaults) => {
      commands.replaceDocument({
        ...doc,
        pageSetup: nextPageSetup,
        defaults: nextDefaults,
      });
      focus();
    },
    [commands, doc, focus],
  );

  // Modification des marges depuis la règle
  const handleRulerMarginChange = useCallback(
    (margins: { leftMm?: number; rightMm?: number }) => {
      commands.replaceDocument({
        ...doc,
        pageSetup: {
          ...doc.pageSetup,
          ...(margins.leftMm !== undefined ? { marginLeftMm: margins.leftMm } : {}),
          ...(margins.rightMm !== undefined ? { marginRightMm: margins.rightMm } : {}),
        },
      });
    },
    [commands, doc],
  );

  // Positionnement de la zone de saisie invisible
  const inputStyle = caret
    ? {
        left: `${geometry.contentLeftPx + caret.xPx}px`,
        top: `${
          caret.pageIndex * (geometry.pageHeightPx + PAGE_GAP_PX) +
          geometry.contentTopPx +
          caret.topPx
        }px`,
        height: `${caret.heightPx}px`,
      }
    : { left: '-9999px', top: '0px' };

  // Définition des menus de la MenuBar
  const menus = useMemo<MenuDefinition[]>(
    () => [
      {
        label: 'Fichier',
        entries: [
          ...(onOpen ? [{ label: 'Ouvrir un document (.odt)…', shortcut: shortcutLabel('Mod-o'), run: onOpen }] : []),
          ...(onSave ? [{ label: 'Enregistrer (.odt)', shortcut: shortcutLabel('Mod-s'), run: () => onSave(doc) }] : []),
          {
            label: 'Exporter au format PDF…',
            run: handleExportPdf,
            separatorBefore: true,
          },
          {
            label: 'Aperçu avant impression…',
            shortcut: shortcutLabel('Mod-Shift-o'),
            run: handleOpenPrintPreview,
          },
          {
            label: 'Imprimer…',
            shortcut: shortcutLabel('Mod-p'),
            run: handlePrint,
          },
          {
            label: 'Mise en page et marges…',
            run: () => setStylesMarginsOpen(true),
            separatorBefore: true,
          },
        ],
      },
      {
        label: 'Édition',
        entries: [
          { label: 'Annuler', shortcut: shortcutLabel('Mod-z'), run: commands.undo, disabled: !canUndo },
          { label: 'Rétablir', shortcut: shortcutLabel('Mod-y'), run: commands.redo, disabled: !canRedo },
          { label: 'Tout sélectionner', shortcut: shortcutLabel('Mod-a'), run: commands.selectAll, separatorBefore: true },
          { label: 'Effacer la mise en forme', shortcut: shortcutLabel('Mod-\\'), run: commands.clearFormatting },
          { label: 'Rechercher et remplacer…', shortcut: shortcutLabel('Mod-f'), run: () => setFindReplaceOpen(true), separatorBefore: true },
          { label: 'Palette de commandes…', shortcut: shortcutLabel('Mod-Shift-p'), run: () => setCommandPaletteOpen(true) },
        ],
      },
      {
        label: 'Affichage',
        entries: [
          {
            label: 'Aperçu avant impression',
            shortcut: shortcutLabel('Mod-Shift-o'),
            run: handleOpenPrintPreview,
          },
          {
            label: 'Plan du document',
            checked: outlineOpen,
            run: () => setOutlineOpen((open) => !open),
            separatorBefore: true,
          },
          {
            label: 'Règle graduée',
            checked: showRuler,
            run: () => setShowRuler((ruler) => !ruler),
          },
          {
            label: 'Zoom avant',
            shortcut: '+',
            run: () => setZoom(zoom + 0.1),
            separatorBefore: true,
          },
          {
            label: 'Zoom arrière',
            shortcut: '−',
            run: () => setZoom(zoom - 0.1),
          },
          {
            label: 'Zoom 100 %',
            run: () => setZoom(1),
          },
        ],
      },
      {
        label: 'Insertion',
        entries: [
          { label: 'En-tête…', run: () => setFurnitureBandToEdit('header') },
          { label: 'Pied de page…', run: () => setFurnitureBandToEdit('footer') },
          { label: 'Numéro de page…', run: () => setFurnitureBandToEdit('footer') },
          { label: 'Formule mathématique…', shortcut: shortcutLabel('Mod-Shift-e'), run: openMathDialog, separatorBefore: true },
          { label: 'Tableau (3×3)', run: () => commands.insertTable(3, 3) },
          { label: 'Saut de page', shortcut: shortcutLabel('Mod-Entrée'), run: commands.insertPageBreak, separatorBefore: true },
          { label: 'Note de bas de page…', run: () => setFootnoteDialogOpen(true) },
          {
            label: 'Lien hypertexte…',
            shortcut: shortcutLabel('Mod-k'),
            run: () => linkButtonRef.current?.click(),
          },
        ],
      },
      {
        label: 'Format',
        entries: [
          { label: 'Gras', shortcut: shortcutLabel('Mod-b'), run: commands.toggleBold },
          { label: 'Italique', shortcut: shortcutLabel('Mod-i'), run: commands.toggleItalic },
          { label: 'Souligné', shortcut: shortcutLabel('Mod-u'), run: commands.toggleUnderline },
          { label: 'Barré', shortcut: shortcutLabel('Mod-Shift-x'), run: commands.toggleStrike },
          { label: 'Aligner à gauche', shortcut: shortcutLabel('Mod-l'), run: () => commands.setAlignment('left'), separatorBefore: true },
          { label: 'Centrer', shortcut: shortcutLabel('Mod-e'), run: () => commands.setAlignment('center') },
          { label: 'Aligner à droite', shortcut: shortcutLabel('Mod-r'), run: () => commands.setAlignment('right') },
          { label: 'Justifier', shortcut: shortcutLabel('Mod-j'), run: () => commands.setAlignment('justify') },
          { label: 'En-tête et pied de page…', run: () => setFurnitureBandToEdit('header'), separatorBefore: true },
          { label: 'Paramètres des marges et styles…', run: () => setStylesMarginsOpen(true) },
        ],
      },
      {
        label: 'Aide',
        entries: [
          { label: 'Raccourcis clavier…', run: () => setHelpOpen(true) },
          {
            label: 'Statistiques du document',
            run: () =>
              alert(
                `Statistiques du document :\n\n• Pages : ${layout.pages.length}\n• Mots : ${statistics.words}\n• Caractères : ${statistics.characters}`,
              ),
          },
          {
            label: 'Guide de référence CloudAntille Writer…',
            run: () => setHelpOpen(true),
            separatorBefore: true,
          },
          {
            label: 'À propos de CloudAntille Writer',
            run: () => setHelpOpen(true),
          },
        ],
      },
    ],
    [
      onOpen,
      onSave,
      doc,
      handleExportPdf,
      handleOpenPrintPreview,
      handlePrint,
      commands,
      canUndo,
      canRedo,
      outlineOpen,
      showRuler,
      zoom,
      setZoom,
      layout.pages.length,
      statistics,
      openMathDialog,
    ],
  );

  // Commandes pour la palette Ctrl+K
  const paletteCommands = useMemo<PaletteCommand[]>(
    () => [
      { id: 'furniture-header', title: 'En-tête de page…', category: 'Insertion', perform: () => setFurnitureBandToEdit('header') },
      { id: 'furniture-footer', title: 'Pied de page…', category: 'Insertion', perform: () => setFurnitureBandToEdit('footer') },
      { id: 'furniture-page-number', title: 'Numéro de page…', category: 'Insertion', perform: () => setFurnitureBandToEdit('footer') },
      { id: 'furniture', title: 'En-tête et pied de page…', category: 'Format', perform: () => setFurnitureBandToEdit('header') },
      { id: 'math', title: 'Insérer une formule mathématique', category: 'Insertion', shortcut: shortcutLabel('Mod-Shift-e'), perform: openMathDialog },
      { id: 'bold', title: 'Gras', category: 'Format', shortcut: shortcutLabel('Mod-b'), perform: commands.toggleBold },
      { id: 'italic', title: 'Italique', category: 'Format', shortcut: shortcutLabel('Mod-i'), perform: commands.toggleItalic },
      { id: 'underline', title: 'Souligné', category: 'Format', shortcut: shortcutLabel('Mod-u'), perform: commands.toggleUnderline },
      { id: 'strike', title: 'Barré', category: 'Format', shortcut: shortcutLabel('Mod-Shift-x'), perform: commands.toggleStrike },
      { id: 'clear_format', title: 'Effacer la mise en forme', category: 'Format', shortcut: shortcutLabel('Mod-\\'), perform: commands.clearFormatting },
      { id: 'h1', title: 'Titre 1', category: 'Styles', perform: () => commands.setHeadingLevel(1) },
      { id: 'h2', title: 'Titre 2', category: 'Styles', perform: () => commands.setHeadingLevel(2) },
      { id: 'h3', title: 'Titre 3', category: 'Styles', perform: () => commands.setHeadingLevel(3) },
      { id: 'p', title: 'Texte normal (paragraphe)', category: 'Styles', perform: () => commands.setHeadingLevel(0) },
      { id: 'align_left', title: 'Aligner à gauche', category: 'Paragraphe', shortcut: shortcutLabel('Mod-l'), perform: () => commands.setAlignment('left') },
      { id: 'align_center', title: 'Centrer', category: 'Paragraphe', shortcut: shortcutLabel('Mod-e'), perform: () => commands.setAlignment('center') },
      { id: 'align_right', title: 'Aligner à droite', category: 'Paragraphe', shortcut: shortcutLabel('Mod-r'), perform: () => commands.setAlignment('right') },
      { id: 'align_justify', title: 'Justifier', category: 'Paragraphe', shortcut: shortcutLabel('Mod-j'), perform: () => commands.setAlignment('justify') },
      { id: 'bullet_list', title: 'Liste à puces', category: 'Listes', shortcut: shortcutLabel('Mod-Shift-8'), perform: () => commands.toggleList('bullet') },
      { id: 'ordered_list', title: 'Liste numérotée', category: 'Listes', shortcut: shortcutLabel('Mod-Shift-7'), perform: () => commands.toggleList('ordered') },
      { id: 'task_list', title: 'Liste à cocher', category: 'Listes', shortcut: shortcutLabel('Mod-Shift-9'), perform: () => commands.toggleList('task') },
      { id: 'page_break', title: 'Insérer un saut de page', category: 'Insertion', shortcut: shortcutLabel('Mod-Entrée'), perform: commands.insertPageBreak },
      { id: 'table', title: 'Insérer un tableau (3×3)', category: 'Insertion', perform: () => commands.insertTable(3, 3) },
      { id: 'find', title: 'Rechercher et remplacer', category: 'Édition', shortcut: shortcutLabel('Mod-f'), perform: () => setFindReplaceOpen(true) },
      { id: 'outline', title: 'Afficher / Masquer le plan', category: 'Affichage', perform: () => setOutlineOpen((o) => !o) },
      { id: 'ruler', title: 'Afficher / Masquer la règle', category: 'Affichage', perform: () => setShowRuler((r) => !r) },
      { id: 'margins', title: 'Paramètres des marges et styles', category: 'Format', perform: () => setStylesMarginsOpen(true) },
      { id: 'export_pdf', title: 'Exporter au format PDF (.pdf)', category: 'Fichier', perform: handleExportPdf },
      { id: 'preview', title: 'Aperçu avant impression', category: 'Fichier', shortcut: shortcutLabel('Mod-Shift-o'), perform: handleOpenPrintPreview },
      { id: 'print', title: 'Imprimer le document', category: 'Fichier', shortcut: shortcutLabel('Mod-p'), perform: handlePrint },
      ...(onSave ? [{ id: 'save', title: 'Enregistrer au format .odt', category: 'Fichier', shortcut: shortcutLabel('Mod-s'), perform: () => onSave(doc) }] : []),
    ],
    [commands, onSave, doc, handleExportPdf, handleOpenPrintPreview, handlePrint, openMathDialog],
  );

  return (
    <div className="writer">
      {/* Barre de titre principale avec le titre et le menu empilés à gauche, et les actions à droite */}
      <header className="titlebar">
        <div className="titlebar__identity">
          <DocumentTitle
            title={doc.meta.title || 'Guide de Référence CloudAntille Writer'}
            disabled={false}
            onCommit={handleTitleCommit}
          />
          <MenuBar menus={menus} />
        </div>
        <span className="titlebar__spacer" />
        <div className="titlebar__actions">
          {onOpen && (
            <button type="button" className="btn" onClick={onOpen}>
              Ouvrir .odt…
            </button>
          )}
          {onSave && (
            <button type="button" className="btn" onClick={() => onSave(doc)}>
              Enregistrer .odt
            </button>
          )}
          <button type="button" className="btn" onClick={handleExportPdf}>
            Exporter PDF
          </button>
          <button type="button" className="btn btn--primary" onClick={handlePrint}>
            Imprimer
          </button>
        </div>
      </header>

      {/* Ruban complet avec les icônes vectorielles du système */}
      <Ribbon
        controller={controller}
        onPrint={handlePrint}
        onExportPdf={handleExportPdf}
        onOpenPrintPreview={handleOpenPrintPreview}
        onOpenFindReplace={() => setFindReplaceOpen(true)}
        onToggleOutline={() => setOutlineOpen((open) => !open)}
        outlineOpen={outlineOpen}
        onOpenPageSetup={() => setStylesMarginsOpen(true)}
        onOpenMath={openMathDialog}
        onOpenFurniture={(band) => setFurnitureBandToEdit(band ?? 'header')}
        linkButtonRef={linkButtonRef}
      />

      {/* Panneau de recherche ancré */}
      {findReplaceOpen && (
        <FindReplacePanel
          state={findReplaceState}
          onChange={setFindReplaceState}
          total={matches.length}
          current={currentMatchIndex >= 0 ? currentMatchIndex + 1 : 0}
          onNavigate={handleSearchNavigate}
          onReplace={handleSearchReplace}
          onReplaceAll={handleSearchReplaceAll}
          onClose={() => setFindReplaceOpen(false)}
          readOnly={false}
        />
      )}

      {/* Règle graduée interactive */}
      {showRuler && (
        <Ruler
          zoom={zoom}
          pageWidthCm={doc.pageSetup.widthMm / 10}
          leftMarginCm={doc.pageSetup.marginLeftMm / 10}
          rightMarginCm={doc.pageSetup.marginRightMm / 10}
          onMarginChange={handleRulerMarginChange}
          onOpenMarginsDialog={() => setStylesMarginsOpen(true)}
        />
      )}

      {/* Espace de travail principal avec plan latéral et surface A4 */}
      <div style={{ display: 'flex', flex: 1, minHeight: 0, position: 'relative', overflow: 'hidden' }}>
        {/* Plan du document (DocumentOutline) */}
        <DocumentOutline
          documentState={doc}
          open={outlineOpen}
          onClose={() => setOutlineOpen(false)}
          onSelectHeading={handleSelectHeading}
        />

        {/* Surface des pages physiques */}
        <div className="writer-surface" style={{ flex: 1 }}>
          <div
            className="writer-pages"
            style={{
              transform: `scale(${zoom})`,
              width: `${geometry.pageWidthPx}px`,
              gap: `${PAGE_GAP_PX}px`,
            }}
          >
            {layout.pages.map((page) => (
              <A4Page
                key={page.index}
                page={page}
                totalPages={layout.pages.length}
                documentTitle={doc.meta.title || 'Sans titre'}
                furniture={doc.furniture ?? DEFAULT_FURNITURE}
                geometry={geometry}
                paragraphLayouts={layout.paragraphLayouts}
                placements={placementsByPage[page.index] ?? []}
                selectionRects={rects.filter((rect) => rect.pageIndex === page.index)}
                searchRects={searchRects.filter((entry) => entry.rect.pageIndex === page.index)}
                caret={caret?.pageIndex === page.index ? caret : null}
                caretIdle={!controller.isFocused}
                showMargins={showMargins}
                onToggleTask={controller.commands.toggleTask}
                onOpenFurniture={(band) => setFurnitureBandToEdit(band)}
                onEditMath={handleEditMath}
                onPointerDown={handlers.onPointerDown}
                onPointerMove={handlers.onPointerMove}
                onPointerUp={handlers.onPointerUp}
              />
            ))}

            {/* Zone de frappe invisible mais contrôlée */}
            <textarea
              ref={inputRef}
              className="writer-input"
              style={inputStyle}
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              aria-label="Document Writer"
              aria-multiline="true"
              role="textbox"
              onKeyDown={handlers.onKeyDown}
              onCompositionStart={handlers.onCompositionStart}
              onCompositionEnd={handlers.onCompositionEnd}
              onFocus={handlers.onFocus}
              onBlur={handlers.onBlur}
              onCopy={handlers.onCopy}
              onCut={handlers.onCut}
              onPaste={handlers.onPaste}
            />
          </div>
        </div>
      </div>

      {/* Barre d'état en bas */}
      <div className="writer-status">
        <span>{`${layout.pages.length} page${layout.pages.length > 1 ? 's' : ''}`}</span>
        <span>{`${statistics.words} mot${statistics.words > 1 ? 's' : ''}`}</span>
        <span>{`${statistics.characters} caractères`}</span>
        <span className="writer-status__spacer" />
        <span>
          {caret ? `Page ${caret.pageIndex + 1}, ligne ${caret.lineIndex + 1}` : 'Curseur'}
        </span>
        <span>{`${Math.round(zoom * 100)} %`}</span>
      </div>

      {/* Dialogues et modales */}
      <CommandPalette
        open={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
        commands={paletteCommands}
      />

      <StylesAndMarginsDialog
        open={stylesMarginsOpen}
        pageSetup={doc.pageSetup}
        defaults={doc.defaults}
        onSave={handleSavePageSetupAndDefaults}
        onClose={() => setStylesMarginsOpen(false)}
      />

      <FootnoteDialog
        open={footnoteDialogOpen}
        onClose={() => setFootnoteDialogOpen(false)}
        onInsert={(_text) => {
          commands.setHeadingLevel(0);
        }}
      />

      {mathDraft && (
        <MathDialog
          draft={mathDraft}
          onCancel={() => setMathDraft(null)}
          onSubmit={(latex, display) => {
            if (mathDraft.blockId) {
              commands.updateMath(mathDraft.blockId, latex, display);
            } else {
              commands.insertMath(latex, display);
            }
            setMathDraft(null);
          }}
          onDelete={
            mathDraft.blockId
              ? () => {
                  commands.deleteMath(mathDraft.blockId!);
                  setMathDraft(null);
                }
              : undefined
          }
        />
      )}

      {furnitureBandToEdit !== null && (
        <PageFurnitureDialog
          valeur={doc.furniture ?? DEFAULT_FURNITURE}
          titreDocument={doc.meta.title || 'Sans titre'}
          pages={layout.pages.length}
          bandeInitiale={furnitureBandToEdit}
          onChange={(updatedFurniture) => {
            commands.replaceDocument({
              ...doc,
              furniture: updatedFurniture,
            });
          }}
          onClose={() => setFurnitureBandToEdit(null)}
        />
      )}

      <HelpDialog open={helpOpen} onClose={() => setHelpOpen(false)} />

      <PrintPreviewDialog
        open={printPreviewOpen}
        doc={doc}
        layout={layout}
        onPrint={handlePrint}
        onExportPdf={handleExportPdf}
        onClose={() => setPrintPreviewOpen(false)}
      />
    </div>
  );
}

/** Statistiques du document */
function computeStatistics(doc: WriterDocumentState): { words: number; characters: number } {
  let words = 0;
  let characters = 0;

  const { order, byId } = paragraphIndex(doc);
  for (const id of order) {
    const paragraph = byId.get(id)?.paragraph;
    if (!paragraph) continue;
    const text = paragraphText(paragraph);
    characters += text.length;
    const matches = text.match(/\S+/g);
    if (matches) words += matches.length;
  }

  return { words, characters };
}
