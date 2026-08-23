/**
 * Pagination visuelle : le texte respecte les limites des pages.
 *
 * Démarche empruntée à Writer (`sw/source/core/layout/`) : un contenu qui ne
 * tient plus dans la page est **reporté** sur la suivante (`SwFlowFrm::MoveFwd`),
 * et un tableau ne se déplace pas d'un bloc — il se coupe **entre deux lignes**,
 * comme le fait `SwTabFrm::Split` en parcourant ses `SwRowFrm`.
 *
 * Faute de vrais cadres de page dans un éditeur web, le report se matérialise par
 * une décoration : un `padding-top` posé sur le bloc concerné, qui l'amène en
 * haut de la page suivante. Le document n'est pas modifié — la décoration
 * n'existe ni à l'export, ni pour les autres participants.
 *
 * Deux règles ont coûté cher et méritent d'être rappelées ici :
 *  - **la mesure part toujours du document nu** (les reports en place sont
 *    retirés avant de mesurer) : déduire les positions naturelles en soustrayant
 *    ce qui était déjà appliqué demandait une comptabilité par position qui
 *    vieillissait mal, et le contenu gagnait une page à chaque passe ;
 *  - **les positions se mesurent par rectangles**, jamais par `offsetTop` : selon
 *    la spécification CSSOM, le parent de décalage d'un `<tr>` est le tableau,
 *    si bien que les lignes se mesuraient depuis le mauvais repère.
 */

import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';

export interface PageGeometry {
  /** Hauteur totale d'une feuille, en pixels. */
  pageHeight: number;
  /** Marge haute du corps, en pixels. */
  marginTop: number;
  /** Marge basse du corps, en pixels. */
  marginBottom: number;
  /**
   * Gouttière entre deux feuilles, en pixels (`GAPBETWEENPAGES` chez Writer).
   *
   * Elle fait partie du calcul, pas du décor : d'une feuille à la suivante on
   * avance de `pageHeight + gap`. Une gouttière dessinée mais non comptée ferait
   * dériver le texte d'une gouttière par page.
   */
  gap?: number;
}

export interface BlockBox {
  /** Position du bloc dans le document. */
  pos: number;
  /** Haut du bloc, relatif à la boîte de l'éditeur. */
  top: number;
  height: number;
  /** `true` pour un saut de page manuel : il force la page suivante. */
  forcedBreak: boolean;
  /**
   * Marge haute du bloc. Un bloc reporté la perd (le report la remplace) : sans
   * en tenir compte, il atterrit une marge trop bas.
   */
  marginTop?: number;
}

export interface Spacer {
  pos: number;
  height: number;
}

export interface Layout {
  reports: Spacer[];
  /**
   * Bas du dernier bloc une fois les reports appliqués.
   *
   * C'est la seule mesure honnête de l'étendue du document : la hauteur du DOM,
   * elle, est plancherisée par le `min-height` que la pile de feuilles impose —
   * s'y fier ferait qu'un document ne perdrait jamais une page à la suppression.
   */
  contentBottom: number;
}

/**
 * Calcule les reports à appliquer. Fonction **pure** : c'est le cœur de la
 * pagination, éprouvable sans navigateur.
 */
export function computeLayout(blocks: readonly BlockBox[], geometry: PageGeometry): Layout {
  const { pageHeight, marginTop, marginBottom } = geometry;
  const gap = geometry.gap ?? 0;
  if (pageHeight <= marginTop + marginBottom) return { reports: [], contentBottom: 0 };

  /** Pas d'une feuille à la suivante : la gouttière en fait partie. */
  const pas = pageHeight + gap;

  const reports: Spacer[] = [];
  /** Décalage cumulé introduit par les reports déjà décidés. */
  let decalage = 0;
  let page = 0;
  /** Un saut manuel vient d'être rencontré : le bloc SUIVANT change de page. */
  let sautEnAttente = false;
  let contentBottom = 0;

  for (const block of blocks) {
    const margeHaute = block.marginTop ?? 0;
    let haut = block.top + decalage;
    const hautDePage = page * pas + marginTop;
    const basDePage = page * pas + pageHeight - marginBottom;

    // Le saut manuel reporte ce qui le suit ; le trait, lui, reste en fin de page
    // précédente — c'est là qu'il fait sens.
    const deborde = haut + block.height > basDePage && haut > hautDePage + 0.5;

    if (sautEnAttente || deborde) {
      page += 1;
      const cible = page * pas + marginTop;
      const hauteur = Math.round(cible - (haut - margeHaute));

      if (hauteur > 0) {
        reports.push({ pos: block.pos, height: hauteur });
        decalage += hauteur - margeHaute;
        haut = block.top + decalage;
      }
    }

    contentBottom = Math.max(contentBottom, haut + block.height);
    sautEnAttente = block.forcedBreak;
  }

  return { reports, contentBottom };
}

/**
 * Nombre de feuilles occupées par un contenu de hauteur donnée.
 *
 * On divise par le pas de feuille — gouttière comprise — et non par la seule
 * hauteur de page : c'est le pas qui sépare deux hauts de feuille.
 *
 * Tolérance d'un pixel : une page A4 mesure 1122,52 px et le navigateur arrondit
 * à 1123 — sans marge, un document d'une page en annonçait deux.
 */
export function countPages(contentHeight: number, geometry: PageGeometry): number {
  const pas = geometry.pageHeight + (geometry.gap ?? 0);
  if (pas <= 0) return 1;
  return Math.max(1, Math.ceil((contentHeight - 1) / pas));
}

export interface PaginationState {
  decorations: DecorationSet;
  /** Reports appliqués, par position de bloc, en pixels. */
  poussees: Map<number, number>;
}

export const paginationKey = new PluginKey<PaginationState>('write:pagination');

const ETAT_VIDE: PaginationState = { decorations: DecorationSet.empty, poussees: new Map() };

/**
 * Nombre maximal de passes.
 *
 * Poser un `padding-top` change la position du bloc au moment même où on la
 * corrige (le repli des marges cesse). Une seconde passe suffit à converger ; la
 * borne protège d'une oscillation.
 */
const PASSES_MAX = 3;

interface PaginationOptions {
  /** Géométrie lue à chaud : elle dépend du zoom et des marges du document. */
  readGeometry: () => PageGeometry;
  /** Notifie le nombre de pages (barre d'état). */
  onPageCount?: (pages: number) => void;
}

/**
 * Relance une mesure. Utile quand la mise en page change sans que le document
 * bouge : réglage de marge, zoom, ou banc d'essai.
 */
export function remesurerPagination(view: EditorView, options: PaginationOptions): void {
  for (let passe = 0; passe < PASSES_MAX; passe += 1) {
    if (!mesurerEtAppliquer(view, options)) return;
  }
}

export function paginationPlugin(options: PaginationOptions): Plugin<PaginationState> {
  return new Plugin<PaginationState>({
    key: paginationKey,

    state: {
      init: () => ETAT_VIDE,
      apply(tr, value) {
        const suivant = tr.getMeta(paginationKey) as PaginationState | undefined;
        if (suivant) return suivant;
        if (!tr.docChanged) return value;
        return { decorations: value.decorations.map(tr.mapping, tr.doc), poussees: value.poussees };
      },
    },

    props: {
      decorations(state) {
        return (paginationKey.getState(state) ?? ETAT_VIDE).decorations;
      },
    },

    view(view) {
      const relayout = (): void => remesurerPagination(view, options);

      // Plusieurs mesures initiales, à dessein : la première a lieu avant le
      // chargement des polices, et les hauteurs de ligne changent alors sous nos
      // pieds. Une pagination fausse jusqu'à la première frappe serait un défaut
      // visible à l'ouverture de chaque document.
      const minuteries = [0, 150, 500].map((delai) => window.setTimeout(relayout, delai));
      const polices = (document as Document & { fonts?: FontFaceSet }).fonts;
      void polices?.ready?.then(relayout);

      const observateur = new ResizeObserver(relayout);
      observateur.observe(view.dom);

      return {
        update: (vue, precedent) => {
          if (vue.state.doc !== precedent.doc) relayout();
        },
        destroy: () => {
          minuteries.forEach((minuterie) => window.clearTimeout(minuterie));
          observateur.disconnect();
        },
      };
    },
  });
}

/** Renvoie `true` si la mise en page a changé — donc s'il faut remesurer. */
function mesurerEtAppliquer(view: EditorView, options: PaginationOptions): boolean {
  if (view.isDestroyed) return false;

  const avant = (paginationKey.getState(view.state) ?? ETAT_VIDE).poussees;

  // 1. Repartir du document nu : le seul état qui ne ment pas.
  if (avant.size > 0) {
    view.dispatch(view.state.tr.setMeta(paginationKey, ETAT_VIDE));
  }

  const geometry = options.readGeometry();
  const unites = collecterUnites(view);
  if (unites.length === 0) return false;

  // 2. Décider.
  const { reports, contentBottom } = computeLayout(unites, geometry);
  const poussees = new Map(reports.map((report) => [report.pos, report.height]));
  tracer(unites, reports, geometry);

  // 3. Appliquer.
  const decorations =
    reports.length === 0
      ? DecorationSet.empty
      : DecorationSet.create(
          view.state.doc,
          reports.map((report) => {
            const noeud = view.state.doc.nodeAt(report.pos);
            const fin = report.pos + (noeud?.nodeSize ?? 1);
            return Decoration.node(report.pos, fin, {
              style: `padding-top: ${report.height}px`,
              class: 'pm-page-poussee',
            });
          }),
        );

  if (reports.length > 0) {
    view.dispatch(view.state.tr.setMeta(paginationKey, { decorations, poussees }));
  }

  // La pile de feuilles impose un `min-height` d'un nombre entier de pages : la
  // hauteur du DOM ne redescendrait donc jamais. On compte à partir du bas du
  // dernier bloc, marge basse comprise.
  options.onPageCount?.(countPages(contentBottom + geometry.marginBottom, geometry));

  return !memesPoussees(avant, poussees);
}

interface Unite extends BlockBox {
  /** Vrai pour une ligne de tableau (découpe et diagnostic). */
  estLigne?: boolean;
}

interface Repere {
  rect: DOMRect;
  /** Facteur de zoom appliqué par le ruban, à neutraliser. */
  facteur: number;
}

/**
 * Unités de report : blocs de premier niveau, éléments de liste, lignes de
 * tableau. On ne descend pas plus bas — couper à l'intérieur d'un paragraphe
 * demanderait de vrais cadres de page (`SwTxtFrm` et ses suites chez Writer).
 */
function collecterUnites(view: EditorView): Unite[] {
  const unites: Unite[] = [];
  const listes = new Set(['bullet_list', 'ordered_list', 'task_list']);

  const editable = view.dom as HTMLElement;
  const rectEditable = editable.getBoundingClientRect();
  const facteur = editable.offsetHeight > 0 ? rectEditable.height / editable.offsetHeight : 1;
  const repere: Repere = { rect: rectEditable, facteur: facteur > 0 ? facteur : 1 };

  view.state.doc.forEach((noeud, offset) => {
    const dom = view.nodeDOM(offset);
    if (!(dom instanceof HTMLElement)) return;

    if (noeud.type.name === 'table') {
      const tableau = mesurer(dom, offset, false, repere);
      let interne = offset + 1;
      let premiere = true;

      noeud.forEach((ligne) => {
        const ligneDom = view.nodeDOM(interne);
        if (ligneDom instanceof HTMLElement) {
          const mesureLigne = mesurer(ligneDom, interne, false, repere);

          if (premiere) {
            // Reporter la première ligne revient à déplacer le tableau entier :
            // l'unité porte donc la position et le haut du tableau.
            unites.push({ ...mesureLigne, pos: offset, top: tableau.top, marginTop: tableau.marginTop ?? 0 });
            premiere = false;
          } else {
            unites.push({ ...mesureLigne, estLigne: true });
          }
        }
        interne += ligne.nodeSize;
      });
      return;
    }

    if (listes.has(noeud.type.name)) {
      let interne = offset + 1;
      noeud.forEach((item) => {
        const itemDom = view.nodeDOM(interne);
        if (itemDom instanceof HTMLElement) unites.push(mesurer(itemDom, interne, false, repere));
        interne += item.nodeSize;
      });
      return;
    }

    unites.push(mesurer(dom, offset, noeud.type.name === 'page_break', repere));
  });

  return unites;
}

function mesurer(dom: HTMLElement, pos: number, forcedBreak: boolean, repere: Repere): Unite {
  const style = window.getComputedStyle(dom);
  const rect = dom.getBoundingClientRect();
  const haut = (rect.top - repere.rect.top) / repere.facteur;
  const hauteur = rect.height / repere.facteur;

  // Une ligne de tableau n'a pas de marge ; ses cellules portent le report.
  if (dom.tagName === 'TR') {
    return { pos, top: haut, height: hauteur, forcedBreak, marginTop: 0 };
  }

  return {
    pos,
    top: haut,
    height: hauteur + (Number.parseFloat(style.marginBottom) || 0),
    forcedBreak,
    marginTop: Number.parseFloat(style.marginTop) || 0,
  };
}

function memesPoussees(a: ReadonlyMap<number, number>, b: ReadonlyMap<number, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [pos, hauteur] of a) {
    // Tolérance d'un pixel : les hauteurs mesurées varient au sous-pixel près.
    if (Math.abs((b.get(pos) ?? Number.NaN) - hauteur) > 1) return false;
  }
  return true;
}

/** Diagnostic activable depuis la console : `window.__paginationDebug = true`. */
function tracer(unites: readonly Unite[], reports: readonly Spacer[], geometry: PageGeometry): void {
  const fenetre = window as unknown as Record<string, unknown>;
  if (!fenetre['__paginationDebug']) return;

  fenetre['__paginationTrace'] = {
    unites: unites.length,
    lignesTableau: unites.filter((unite) => unite.estLigne).length,
    reports: reports.length,
    geometrie: geometry,
    apercu: unites.slice(0, 30).map((unite) => ({
      pos: unite.pos,
      ligne: unite.estLigne === true,
      top: Math.round(unite.top),
      h: Math.round(unite.height),
    })),
  };
}
