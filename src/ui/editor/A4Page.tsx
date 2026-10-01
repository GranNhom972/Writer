// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Les contributeurs de Writer

/**
 * Une feuille physique A4/Letter. Transposition visuelle de `SwPageFrm`.
 *
 * Supporte :
 *  - En-têtes (`SwHeaderFrm`) et pieds de page (`SwFooterFrm`) physiques avec rendu véridique ;
 *  - Double-clic direct pour ouvrir l'atelier ergonomique de mise en page ;
 *  - Affichage précis des marges, tableaux et sélections multi-lignes.
 */

import { memo, type JSX } from 'react';
import type { PageGeometry } from '../../domain/document/pageSetup';
import type { ParagraphLayout } from '../../domain/engine/lineBreak';
import type { LaidOutFly, LaidOutPage, PlacedParagraph, PlacedTable } from '../../domain/engine/paginate';
import { cellFrameHeightPx } from '../../domain/engine/paginate';
import type { SelectionRect } from '../../domain/engine/cursor';
import type { PageFurniture, FurnitureBand } from '../../domain/document/pageFurniture';
import { showsOn, resolveGeometry, bandIsEmpty } from '../../domain/document/pageFurniture';
import { FurnitureBandView } from '../components/FurnitureBand';
import { ParagraphView, type ImageContext } from './ParagraphView';
import { ImageFrame } from './ImageFrame';
import { imageKey } from '../../domain/document/images';
import { mmToPx, ptToPx, pxToMm } from '../../domain/document/units';

/** Repli de hauteur de bande quand le document n'a pas de mobilier de page. */
const DEFAULT_BAND_PX = 40;
import { TableHandles, TableTint, type TableFocus } from './TableOverlay';

/** Une occurrence de recherche posée sur la page. */
export interface SearchRect {
  rect: SelectionRect;
  current: boolean;
}

/**
 * Tableaux vides partagés, gelés.
 *
 * `A4Page` est mémoïsé, donc comparé prop à prop par identité. Un `?? []`
 * écrit sur le site d'appel rendrait un tableau neuf à chaque rendu et
 * suffirait à faire échouer la comparaison — la mémoïsation ne servirait plus
 * à rien pour toute page sans sélection ni occurrence, c'est-à-dire presque
 * toutes. Ces constantes sont la valeur de repli à utiliser à leur place.
 */
export const AUCUN_RECT: readonly SelectionRect[] = Object.freeze([]);
export const AUCUNE_OCCURRENCE: readonly SearchRect[] = Object.freeze([]);
export const AUCUN_PLACEMENT: readonly { blockId: string; placed: PlacedParagraph }[] =
  Object.freeze([]);

export interface A4PageProps {
  page: LaidOutPage;
  totalPages: number;
  documentTitle: string;
  furniture?: PageFurniture;
  geometry: PageGeometry;
  paragraphLayouts: ReadonlyMap<string, ParagraphLayout>;
  placements: readonly { blockId: string; placed: PlacedParagraph }[];
  selectionRects: readonly SelectionRect[];
  /** Occurrences de la recherche à peindre sur cette page. */
  searchRects: readonly SearchRect[];
  caret: { pageIndex: number; xPx: number; topPx: number; heightPx: number } | null;
  caretIdle: boolean;
  showMargins: boolean;
  /** Zoom courant — les poignées de tableau convertissent les gestes avec. */
  zoom: number;
  /** Tableau et cellule sous le curseur, pour peindre les poignées. */
  activeTable: ({ tableId: string } & TableFocus) | null;
  onResizeColumn: (tableId: string, boundaryIndex: number, deltaPercent: number) => void;
  onSelectRow: (tableId: string, rowIndex: number) => void;
  onSelectColumn: (tableId: string, columnIndex: number) => void;
  onSelectTable: (tableId: string) => void;
  /** Document non modifiable : les poignées de largeur ne s'affichent pas. */
  readOnly?: boolean;
  /** Contexte des cadres image : légendes, sélection, poignées. */
  images?: ImageContext | undefined;
  onToggleTask: (blockId: string) => void;
  onOpenFurniture?: (band: FurnitureBand) => void;
  onEditMath?: (blockId: string, latex: string, display: boolean) => void;
  onEditImage?: (blockId: string, offset: number) => void;
  onPointerDown: (event: React.PointerEvent<HTMLDivElement>, pageIndex: number) => void;
  onPointerMove: (event: React.PointerEvent<HTMLDivElement>, pageIndex: number) => void;
  onPointerUp: (event: React.PointerEvent<HTMLDivElement>, pageIndex: number) => void;
  onContextMenu: (event: React.MouseEvent<HTMLDivElement>, pageIndex: number) => void;
}

/** Cadres des cellules d'un tableau posé sur cette page. */
function TableFrames({ table }: { table: PlacedTable }): JSX.Element {
  // Jeton « papier » : la grille est imprimée, elle ne suit pas le thème.
  const color = table.table.borderColor ?? 'var(--paper-border)';
  const widthPx = table.table.borderWidthPt ? `${ptToPx(table.table.borderWidthPt)}px` : '1px';

  return (
    <>
      {table.rows.flatMap((row, rowPos) =>
        row.cells.map((cell) =>
          /*
           * Une cellule recouverte par une fusion ne se peint pas.
           *
           * Le moteur lui donne une largeur nulle, ce qui n'annule pas son
           * cadre : `border-box` réduit le contenu à zéro mais garde les deux
           * bordures d'un pixel, et il restait un trait de 2 px au milieu de
           * chaque cellule fusionnée, exactement là où la frontière effacée
           * passait. C'est la maîtresse qui porte le cadre de la zone entière.
           */
          cell.covered ? null : (
          <div
            key={`${row.rowId}-${cell.cellId}`}
            className="writer-table-cell"
            style={{
              left: `${cell.leftPx}px`,
              top: `${table.topPx + row.topPx}px`,
              width: `${cell.widthPx}px`,
              height: `${cellFrameHeightPx(table.rows, rowPos, cell)}px`,
              borderColor: color,
              borderWidth: widthPx,
              background: row.isHeader ? 'var(--paper-sunken)' : undefined,
            }}
            aria-hidden="true"
          />
          ),
        ),
      )}
    </>
  );
}

export const A4Page = memo(function A4Page({
  page,
  totalPages,
  documentTitle,
  furniture,
  geometry,
  paragraphLayouts,
  placements,
  selectionRects,
  searchRects,
  caret,
  caretIdle,
  showMargins,
  zoom,
  activeTable,
  onResizeColumn,
  onSelectRow,
  onSelectColumn,
  onSelectTable,
  readOnly,
  images,
  onToggleTask,
  onOpenFurniture,
  onEditMath,
  onEditImage,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onContextMenu,
}: A4PageProps): JSX.Element {
  const pageNumber = page.index + 1;

  /**
   * Un cadre flottant, peint à sa place sur la feuille.
   *
   * Le même rendu sert aux **deux calques** : `SwRootFrm::Paint` peint `hell`
   * avant le texte et `heaven` après, mais c'est le même cadre — seul l'ordre
   * de passage change, et avec lui ce qui recouvre quoi.
   */
  const peindreCadre = (laid: LaidOutFly, index: number): JSX.Element => (
    <div
      key={`fly-${laid.fly.anchorBlockId}-${index}`}
      className="writer-fly"
      style={{
        position: 'absolute',
        left: `${laid.leftPx}px`,
        top: `${laid.topPx}px`,
        width: `${laid.widthPx}px`,
        height: `${laid.heightPx}px`,
        /*
         * Le cadre reste saisissable, y compris en `through`.
         *
         * Le laisser traverser les clics rendait le texte du dessous plus
         * commode à sélectionner, mais fermait la porte : une image posée
         * « derrière le texte » n'était plus jamais atteignable, donc plus
         * jamais réglable ni supprimable. Le texte, lui, se sélectionne
         * toujours — il suffit de commencer le geste hors du cadre.
         */
        pointerEvents: 'auto',
      }}
    >
      {/*
        Même cadre que dans le fil : c'est ici, et ici seulement, qu'une
        image flottante est peinte. Elle gagne du même coup la légende et
        les poignées de redimensionnement, au lieu d'être une simple
        vignette inerte.
      */}
      {images ? (
        <ImageFrame
          formatting={laid.fly.run}
          blockId={laid.fly.anchorBlockId}
          offset={laid.fly.anchorOffset}
          widthPx={laid.widthPx}
          // La hauteur posée par `flyLayout` comprend la légende : c'est
          // celle du cadre entier. L'image en occupe le reste.
          imageHeightPx={laid.heightPx - (laid.fly.captionHeightPx ?? 0)}
          captionHeightPx={laid.fly.captionHeightPx ?? 0}
          figureNumber={
            images.figureNumbers.get(
              imageKey(laid.fly.anchorBlockId, laid.fly.anchorOffset),
            ) ?? null
          }
          bodyFontSizePt={images.bodyFontSizePt}
          selected={
            images.selected?.blockId === laid.fly.anchorBlockId &&
            images.selected.offset === laid.fly.anchorOffset
          }
          zoom={images.zoom}
          readOnly={images.readOnly}
          onSelect={images.onSelect}
          onOpenDialog={(b, o) => {
            images.onOpenDialog(b, o);
            onEditImage?.(b, o);
          }}
          onResize={images.onResize}
          onWrapChange={images.onWrapChange}
          onMove={images.onMove}
          onDrop={images.onDrop}
        />
      ) : (
        <img
          src={laid.fly.run.imageSrc ?? ''}
          alt={laid.fly.run.imageAlt ?? ''}
          draggable={false}
          style={{ width: '100%', height: '100%', objectFit: 'fill', display: 'block' }}
        />
      )}
    </div>
  );

  const showFurniture = furniture ? showsOn(furniture, pageNumber) : false;
  const geom = furniture ? resolveGeometry(furniture, pageNumber) : null;
  const pageWidthMm = pxToMm(geometry.pageWidthPx);

  /*
   * Hauteurs des bandes d'en-tête et de pied.
   *
   * Bornées à la zone **hors texte**, et c'est tout l'enjeu : la bande est
   * posée en `zIndex: 4` au-dessus de `.writer-page__content`, qui n'a pas de
   * `z-index` propre, et elle arrête la propagation de `pointerdown` pour que
   * le clic ouvre l'atelier plutôt que de poser le curseur. Une bande plus
   * haute que la marge recouvre donc les premières lignes du texte et y rend
   * le curseur impossible à placer — le clic ouvre l'en-tête à la place.
   *
   * Le cas n'était pas théorique : `resolveGeometry` plancher le contenu d'une
   * bande à 16 mm, bande vide comprise, alors que la marge, elle, suit le
   * réglage de l'utilisateur. Sous 16 mm de marge haute la bande débordait —
   * 22,7 px de texte inaccessibles à 10 mm de marge. Le gabarit A4 par défaut
   * (20 mm) masquait le défaut.
   *
   * `geom` ne sert donc plus qu'à réclamer **moins** que la marge, jamais plus.
   */
  const headerBandPx = Math.min(
    geometry.contentTopPx,
    geom ? mmToPx(geom.headerContentMm) : DEFAULT_BAND_PX,
  );
  const footerZonePx = geometry.pageHeightPx - (geometry.contentTopPx + geometry.contentHeightPx);
  const footerBandPx = Math.min(
    footerZonePx,
    geom ? mmToPx(geom.footerContentMm) : DEFAULT_BAND_PX,
  );
  const contexte = { page: pageNumber, pages: totalPages, titre: documentTitle };
  const headerVide = !furniture || bandIsEmpty(furniture, 'header', pageNumber);
  const footerVide = !furniture || bandIsEmpty(furniture, 'footer', pageNumber);

  return (
    <div
      className="writer-page"
      // Index de la feuille, lu au dépôt d'une image : le glissement écoute la
      // fenêtre et n'a donc pas le `pageIndex` que reçoivent les gestionnaires
      // de pointage de ce composant.
      data-page-index={page.index}
      style={{ width: `${geometry.pageWidthPx}px`, height: `${geometry.pageHeightPx}px` }}
      onPointerDown={(event) => onPointerDown(event, page.index)}
      onPointerMove={(event) => onPointerMove(event, page.index)}
      onPointerUp={(event) => onPointerUp(event, page.index)}
      onContextMenu={(event) => onContextMenu(event, page.index)}
    >
      {/* En-tête de page physique interactif */}
      <div
        className="writer-page__furniture-header"
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: `${geometry.pageWidthPx}px`,
          height: `${headerBandPx}px`,
          overflow: 'hidden',
          zIndex: 4,
          cursor: 'pointer',
        }}
        onPointerDown={(e) => {
          e.stopPropagation();
        }}
        onClick={(e) => {
          e.stopPropagation();
          onOpenFurniture?.('header');
        }}
        onDoubleClick={(e) => {
          e.stopPropagation();
          onOpenFurniture?.('header');
        }}
        title="Cliquer ou double-cliquer pour modifier l'en-tête"
      >
        {showFurniture && furniture && geom && (
          <FurnitureBandView
            furniture={furniture}
            band="header"
            contexte={contexte}
            usableMm={pageWidthMm}
            heightMm={pxToMm(headerBandPx)}
          />
        )}
        <button
          type="button"
          className="page-guide__acces page-guide__acces--header"
          onClick={(e) => {
            e.stopPropagation();
            onOpenFurniture?.('header');
          }}
          title={headerVide ? "Ajouter un en-tête" : "Modifier l'en-tête"}
        >
          {headerVide ? '+ Ajouter un en-tête' : '✏️ Modifier l’en-tête'}
        </button>
      </div>

      {/* Guide des marges */}
      {showMargins ? (
        <div
          className="writer-page__margins"
          style={{
            left: `${geometry.contentLeftPx}px`,
            top: `${geometry.contentTopPx}px`,
            width: `${geometry.contentWidthPx}px`,
            height: `${geometry.contentHeightPx}px`,
          }}
        />
      ) : null}

      {/* Contenu textuel et tableaux */}
      <div
        className="writer-page__content"
        style={{
          left: `${geometry.contentLeftPx}px`,
          top: `${geometry.contentTopPx}px`,
          width: `${geometry.contentWidthPx}px`,
          height: `${geometry.contentHeightPx}px`,
        }}
      >
        {/*
          Cadres flottants du calque `hell` (`SwFlyFreeFrm`). Peints **avant**
          le texte, donc dessous : c'est l'ordre de `SwRootFrm::Paint`, et il
          n'a de conséquence visible que pour l'habillage `through`, où le
          texte doit passer par-dessus l'image.
        */}
        {page.fliesHell.map(peindreCadre)}

        {page.tables.map((table) => (
          <TableFrames key={`${table.blockId}-${table.topPx}`} table={table} />
        ))}

        {/* Teinte de sélection — sous le texte, pour ne pas le délaver. */}
        {page.tables.map((table) => (
          <TableTint
            key={`tint-${table.blockId}-${table.topPx}`}
            table={table}
            focus={activeTable?.tableId === table.table.id ? activeTable : null}
          />
        ))}

        {placements.map(({ blockId, placed }) => {
          const layout = paragraphLayouts.get(blockId);
          if (!layout) return null;
          return (
            <div
              key={`${blockId}-${placed.fromLine}`}
              style={{ position: 'absolute', left: `${placed.leftPx}px`, top: 0 }}
            >
              <ParagraphView
                placed={placed}
                layout={layout}
                onToggleTask={onToggleTask}
                onEditMath={onEditMath}
                onEditImage={onEditImage}
                images={images}
              />
            </div>
          );
        })}

        {/*
          Teinte de sélection et occurrences de recherche.

          Peintes **par-dessus** le contenu, et c'est ce qui les rend fiables :
          sous le contenu, tout aplat opaque posé plus haut dans la pile les
          effaçait. Le défaut se voyait à `Ctrl+A` — la ligne d'en-tête d'un
          tableau (`--paper-sunken`), un caractère à fond coloré
          (`RES_CHRATR_BACKGROUND`) ou une image ancrée comme caractère
          restaient blancs au milieu d'un document entièrement surligné, alors
          que le moteur avait bien produit leurs rectangles.

          C'est l'ordre du C++ : la sélection n'est pas un calque du document
          mais un **habillage de vue**, peint après lui — `SwRootFrm::Paint`
          dessine le contenu, puis le gestionnaire d'habillages
          (`sdr::overlay::OverlaySelection`) pose la teinte translucide sur ce
          qu'il a produit, cadres et graphiques compris.

          La fusion `multiply` protège la lisibilité : elle ne peut
          qu'assombrir. Sur le blanc du papier — le cas de presque toute la
          page — multiplier par la teinte revient exactement au rendu
          précédent ; sur un glyphe noir, le noir l'emporte et le texte garde
          son contraste ; sur un aplat gris ou une image, la teinte se voit
          enfin. Les rectangles se composent d'abord entre eux (`isolation`),
          pour que le chevauchement d'une occurrence et de la sélection ne
          double pas l'assombrissement.

          Restent au-dessus, et donc intacts : les poignées de tableau, le
          curseur, les notes de bas de page — que `Ctrl+A` ne sélectionne pas,
          pas plus que dans Writer — et le calque `heaven`.
        */}
        {searchRects.length > 0 || selectionRects.length > 0 ? (
          <div className="writer-selection-layer" aria-hidden="true">
            {/*
              Les occurrences trouvées se peignent **sous** la sélection : les
              deux se superposent sur l'occurrence courante, qui est aussi
              sélectionnée, et c'est la sélection qui doit rester lisible.
            */}
            {searchRects.map(({ rect, current }, index) => (
              <div
                key={`recherche-${index}`}
                className={current ? 'writer-search writer-search--current' : 'writer-search'}
                style={{
                  left: `${rect.leftPx}px`,
                  top: `${rect.topPx}px`,
                  width: `${rect.widthPx}px`,
                  height: `${rect.heightPx}px`,
                }}
              />
            ))}

            {selectionRects.map((rect, index) => (
              <div
                key={index}
                className="writer-selection"
                style={{
                  left: `${rect.leftPx}px`,
                  top: `${rect.topPx}px`,
                  width: `${rect.widthPx}px`,
                  height: `${rect.heightPx}px`,
                }}
              />
            ))}
          </div>
        ) : null}

        {/*
          Poignées de tableau — après le texte, donc au-dessus : une poignée
          qu'un mot recouvrirait ne serait pas saisissable.
        */}
        {page.tables.map((table) => (
          <TableHandles
            key={`poignees-${table.blockId}-${table.topPx}`}
            table={table}
            contentWidthPx={geometry.contentWidthPx}
            zoom={zoom}
            focus={activeTable?.tableId === table.table.id ? activeTable : null}
            readOnly={readOnly ?? false}
            onResizeColumn={onResizeColumn}
            onSelectRow={onSelectRow}
            onSelectColumn={onSelectColumn}
            onSelectTable={onSelectTable}
          />
        ))}

        {caret ? (
          <div
            className={caretIdle ? 'writer-caret writer-caret--idle' : 'writer-caret'}
            style={{
              left: `${caret.xPx}px`,
              top: `${caret.topPx}px`,
              height: `${caret.heightPx}px`,
            }}
          />
        ) : null}

        {/*
          Zone des notes de bas de page (`SwFtnContFrm`).

          Sa hauteur est **réservée par la pagination** (`PageBuilder`) : le
          corps du texte s'arrête au-dessus, et le bandeau ne recouvre donc plus
          rien. `height` reprend cette hauteur exacte plutôt que de laisser la
          boîte se dimensionner sur son contenu — les deux doivent coïncider,
          sinon la réserve et le rendu divergeraient.
        */}
        {page.footnotes && page.footnotes.length > 0 && (
          <div
            className="writer-page__footnotes"
            style={{
              position: 'absolute',
              height: page.footnoteAreaHeightPx ? `${page.footnoteAreaHeightPx}px` : undefined,
              bottom: 0,
              left: 0,
              right: 0,
              borderTop: '1px solid var(--paper-border)',
              paddingTop: '8px',
              fontSize: '11px',
              lineHeight: '1.4',
              // `--text-muted` n'existe dans aucune feuille : la règle tombait
              // systématiquement sur sa valeur de repli.
              color: 'var(--paper-secondary)',
              pointerEvents: 'auto',
            }}
          >
            {page.footnotes.map((fn) => (
              <div key={fn.id} className="writer-footnote-entry" style={{ marginBottom: '2px' }}>
                <sup style={{ fontWeight: 600, marginRight: '4px', color: 'var(--text-color, #111)' }}>{fn.index}</sup>
                <span>{fn.text}</span>
              </div>
            ))}
          </div>
        )}

        {/*
          Calque `heaven` : les cadres « devant le texte » (`RES_OPAQUE`).

          Peints en **dernier**, après les poignées, le curseur et les notes :
          c'est la fin de `SwRootFrm::Paint`, et c'est ce qui donne son sens à
          « devant le texte ». Un cadre opaque recouvre donc tout ce que la page
          porte, sans exception.

          Ils étaient jusqu'ici insérés entre les poignées et le curseur, ce qui
          les faisait passer *sous* le curseur et sous le bandeau de notes —
          l'ordre des calques s'inversait sur ces deux éléments, et une image
          posée devant le texte n'en cachait pourtant pas le curseur.

          Conséquence assumée : un cadre opaque posé sur la zone de saisie
          masque le curseur. C'est le comportement demandé d'un objet
          « devant le texte » ; le geste de retour est de le renvoyer derrière.
        */}
        {page.fliesHeaven.map(peindreCadre)}
      </div>

      {/* Pied de page physique interactif */}
      <div
        className="writer-page__furniture-footer"
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          width: `${geometry.pageWidthPx}px`,
          height: `${footerBandPx}px`,
          overflow: 'hidden',
          zIndex: 4,
          cursor: 'pointer',
        }}
        onPointerDown={(e) => {
          e.stopPropagation();
        }}
        onClick={(e) => {
          e.stopPropagation();
          onOpenFurniture?.('footer');
        }}
        onDoubleClick={(e) => {
          e.stopPropagation();
          onOpenFurniture?.('footer');
        }}
        title="Cliquer ou double-cliquer pour modifier le pied de page"
      >
        {showFurniture && furniture && geom && (
          <FurnitureBandView
            furniture={furniture}
            band="footer"
            contexte={contexte}
            usableMm={pageWidthMm}
            heightMm={pxToMm(footerBandPx)}
          />
        )}
        <button
          type="button"
          className="page-guide__acces page-guide__acces--footer"
          onClick={(e) => {
            e.stopPropagation();
            onOpenFurniture?.('footer');
          }}
          title={footerVide ? "Ajouter un pied de page" : "Modifier le pied de page"}
        >
          {footerVide ? '+ Ajouter un pied de page' : '✏️ Modifier le pied de page'}
        </button>
      </div>
    </div>
  );
});
