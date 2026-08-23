/**
 * Éditeur Write (couche 3 — rendu).
 *
 * Rendu **DOM** et non canvas (ADR-003) : le texte reste sélectionnable et lisible
 * par les technologies d'assistance. Le document CRDT est la source de vérité :
 * ProseMirror n'est qu'une projection éditable de `Y.XmlFragment`.
 */

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { ySyncPlugin, yCursorPlugin, yUndoPlugin } from 'y-prosemirror';
import type { CollabSession } from '../collab/session';
import { writeSchema } from '../document/schema';
import { writeKeymap, type HostCommands } from './keymap';
import { searchHighlightPlugin } from './searchHighlight';
import { paginationPlugin } from './pagination-plugin';
import { TaskItemView } from './TaskItemView';
import { MathView } from './MathView';
import { A4 } from '../design/tokens';
import {
  bandIsEmpty,
  DEFAULT_FURNITURE,
  PAGE_GAP_MM,
  resolveGeometry,
  showsOn,
  type FurnitureBand,
  type PageFurniture,
} from '../document/pageFurniture';
import { FurnitureBandView } from '../ui/FurnitureBand';

interface WriteEditorProps {
  session: CollabSession;
  editable: boolean;
  /** Actions déclenchées depuis l'éditeur mais rendues hors de lui (dialogues). */
  host: HostCommands;
  /** Ouvre l'éditeur de formule pour la formule située à `pos`. */
  onEditMath: (pos: number) => void;
  /** Nombre de pages occupées, pour la barre d'état. */
  onPageCountChange?: (pages: number) => void;
  /** En-tête et pied, répétés à l'identique sur chaque page. */
  furniture?: PageFurniture;
  /** Titre du document, pour le jeton {titre}. */
  documentTitle?: string;
  /** Ouvre le dialogue sur la bande cliquée. */
  onEditFurniture?: (band: FurnitureBand) => void;
  /** Facteur de zoom du ruban (1 = 100 %). */
  zoom: number;
  onStateChange: (state: EditorState) => void;
  onViewReady: (view: EditorView | null) => void;
}

export function WriteEditor({
  session,
  editable,
  host,
  zoom,
  onEditMath,
  onPageCountChange,
  furniture = DEFAULT_FURNITURE,
  documentTitle = '',
  onEditFurniture,
  onStateChange,
  onViewReady,
}: WriteEditorProps) {
  const hostRef2 = useRef(host);
  hostRef2.current = host;
  const editMathRef = useRef(onEditMath);
  editMathRef.current = onEditMath;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [pages, setPages] = useState(1);
  // Lue par le greffon de pagination, qui vit hors du cycle de rendu React.
  const furnitureRef = useRef(furniture);
  furnitureRef.current = furniture;
  const geometrie = resolveGeometry(furniture);
  const bandes = [
    {
      band: 'header' as const,
      libelle: 'En-tête de page',
      hauteurMm: geometrie.headerContentMm,
      invite: 'Ajouter un en-tête',
      modifier: 'Modifier l’en-tête',
    },
    {
      band: 'footer' as const,
      libelle: 'Pied de page',
      hauteurMm: geometrie.footerContentMm,
      invite: 'Ajouter un pied de page',
      modifier: 'Modifier le pied de page',
    },
  ];
  const signalerPages = useRef(onPageCountChange);
  signalerPages.current = onPageCountChange;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const state = EditorState.create({
      schema: writeSchema,
      plugins: [
        ySyncPlugin(session.fragment),
        yCursorPlugin(session.awareness),
        yUndoPlugin(),
        searchHighlightPlugin(),
        // Pagination visuelle : les cales tiennent le texte dans ses pages.
        paginationPlugin({
          // La géométrie est relue à chaque mesure : changer une marge dans le
          // dialogue doit repaginer, pas seulement redessiner les cadres.
          readGeometry: () => {
            const mm = (valeur: number): number => valeur * (96 / 25.4);
            const geo = resolveGeometry(furnitureRef.current);
            // Marges haute et basse distinctes : les confondre par leur maximum
            // rognait la page du côté de la plus petite des deux.
            return {
              pageHeight: mm(A4.heightMm),
              marginTop: mm(geo.marginTopMm),
              marginBottom: mm(geo.marginBottomMm),
              gap: mm(PAGE_GAP_MM),
            };
          },
          onPageCount: (nombre) => {
            setPages(nombre);
            signalerPages.current?.(nombre);
          },
        }),
        // Indirection par ref : les dialogues changent d'identité à chaque rendu,
        // l'éditeur, lui, ne DOIT pas être reconstruit pour autant.
        ...writeKeymap({
          openLinkDialog: () => hostRef2.current.openLinkDialog(),
          openMathDialog: () => hostRef2.current.openMathDialog(),
          print: () => hostRef2.current.print(),
        }),
      ],
    });

    // La vue est d'abord créée SANS `dispatchTransaction` : `ySyncPlugin` dispatche
    // la transaction de synchronisation initiale pendant la construction, et le
    // comportement par défaut (appliquer la transaction) est exactement le bon.
    // Le branchement React se fait juste après, une fois la vue référençable.
    const view: EditorView = new EditorView(host, {
      state,
      editable: () => editable,
      attributes: {
        // Le corps du document est une région nommée, atteignable par F6.
        role: 'textbox',
        'aria-multiline': 'true',
        'aria-label': 'Corps du document',
        lang: document.documentElement.lang || 'fr',
      },
      nodeViews: {
        task_item: (node, nodeView, getPos) => new TaskItemView(node, nodeView, getPos),
        math_inline: (node, _nodeView, getPos) =>
          new MathView(node, getPos, (pos) => editMathRef.current(pos)),
        math_block: (node, _nodeView, getPos) =>
          new MathView(node, getPos, (pos) => editMathRef.current(pos)),
      },
    });

    viewRef.current = view;
    view.setProps({
      dispatchTransaction(transaction) {
        const next = view.state.apply(transaction);
        view.updateState(next);
        onStateChange(next);
      },
    });
    onViewReady(view);
    onStateChange(view.state);

    return () => {
      onViewReady(null);
      viewRef.current = null;
      view.destroy();
    };
    // La session est le cycle de vie de l'éditeur : la recréer sur changement de
    // document, jamais sur un simple changement de props d'affichage.
  }, [session]); // eslint-disable-line react-hooks/exhaustive-deps

  // `editable` change sans recréer la vue (passage lecture seule ↔ écriture).
  useEffect(() => {
    viewRef.current?.setProps({ editable: () => editable });
  }, [editable]);

  return (
    <div
      className="page-stack"
      ref={hostRef}
      data-page-count={pages}
      style={
        {
          '--zoom': zoom,
          // Les marges pilotent à la fois le corps de texte et les cadres :
          // une seule source, donc aucune dérive possible entre les deux.
          '--marge-haut': `${geometrie.marginTopMm}mm`,
          '--marge-bas': `${geometrie.marginBottomMm}mm`,
          '--marge-gauche': `${geometrie.marginLeftMm}mm`,
          '--marge-droite': `${geometrie.marginRightMm}mm`,
          '--entete-haut': `${furniture.headerMm}mm`,
          '--pied-bas': `${furniture.footerMm}mm`,
          '--furniture-taille': `${furniture.fontSizePt}pt`,
          // Le corps de texte fait exactement la hauteur de la pile de feuilles :
          // sans cela le conteneur des cadres est plus court que leur somme, et
          // la disposition flexible les COMPRIME (13,9 px par feuille) — les
          // cadres, l'en-tête et le pied finissaient plusieurs millimètres au-dessus
          // du texte qu'ils sont censés encadrer.
          '--page-count': pages,
          '--page-gap': `${PAGE_GAP_MM}mm`,
        } as CSSProperties
      }
    >
      {/* Repères de page : le document défile en continu, les limites A4 restent
          visibles. Le rendu page par page complet relève du jalon J1. */}
      <div className="page-guides">
        {Array.from({ length: pages }, (_, index) => {
          const page = index + 1;
          const contexte = { page, pages, titre: documentTitle };
          const visible = showsOn(furniture, page);
          // Les bandes se répètent à l'identique : une seule est annoncée aux
          // technologies d'assistance, les autres sont le même contenu redit.
          const premiere = page === 1;

          return (
            <div
              key={index}
              className="page-guide"
              style={{ height: `${A4.heightMm}mm` }}
              aria-hidden={premiere ? undefined : true}
            >
              {/* En-tête et pied vivent dans le cadre de page, pas dans le flux :
                  c'est ce qui les rend identiques d'une page à l'autre. */}
              {bandes.map(({ band, libelle, hauteurMm, invite, modifier }) => {
                if (!visible) return null;
                const vide = bandIsEmpty(furniture, band);
                const ouvrable = editable && onEditFurniture !== undefined;

                return (
                  <div
                    key={band}
                    className={`page-guide__band page-guide__band--${band}${vide ? ' page-guide__band--vide' : ''}`}
                    style={{ width: `${A4.widthMm}mm`, minHeight: `${Math.max(hauteurMm, 6)}mm` }}
                    // Double-clic, comme dans les traitements de texte de bureau.
                    // Au simple clic, la bande volait tous les clics du haut de
                    // page : elle couvre 20 mm de marge sur CHAQUE feuille, et
                    // viser le début du texte ouvrait un dialogue.
                    onDoubleClick={ouvrable ? () => onEditFurniture?.(band) : undefined}
                    title={ouvrable ? `${libelle} — double-cliquer pour modifier` : undefined}
                  >
                    {!vide && (
                      <FurnitureBandView
                        furniture={furniture}
                        band={band}
                        contexte={contexte}
                        usableMm={A4.widthMm}
                        heightMm={hauteurMm}
                      />
                    )}

                    {/* Pastille d'accès. Le double-clic seul serait invisible :
                        cette pastille le rend découvrable, atteignable au clavier
                        et nommable pour un lecteur d'écran. */}
                    {ouvrable && (
                      <button
                        type="button"
                        className="page-guide__acces"
                        // Un élément focalisable sous `aria-hidden` serait un piège
                        // au clavier : seules les bandes de la première page sont
                        // dans l'ordre de tabulation, les autres restent cliquables.
                        tabIndex={premiere ? 0 : -1}
                        onClick={() => onEditFurniture?.(band)}
                      >
                        {vide ? invite : modifier}
                      </button>
                    )}
                  </div>
                );
              })}
              {bandIsEmpty(furniture, 'footer') && <span className="page-guide__number">{page}</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
