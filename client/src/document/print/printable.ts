/**
 * Document d'impression isolé.
 *
 * Masquer le chrome au moyen de règles `@media print` est un jeu perdu d'avance :
 * il suffit qu'un élément d'interface n'ait pas la classe attendue — la règle du
 * document, stylée en ligne, s'imprimait ainsi en haut de la feuille. On procède
 * donc à l'inverse : on **ne met dans le document imprimé que la feuille**, dans
 * un cadre isolé. Rien d'autre ne peut y entrer, aujourd'hui ni demain.
 *
 * Les en-têtes et pieds de page ajoutés par le navigateur (date, titre, URL)
 * occupent la marge de page : `@page { margin: 0 }` la supprime, et les marges du
 * document sont appliquées à l'intérieur de la feuille.
 */

/**
 * Un bloc libre d'en-tête ou de pied, jetons déjà substitués.
 *
 * L'appelant fournit du texte prêt à imprimer : ce module ne connaît ni le
 * document ni sa pagination.
 */
export interface PrintableBlock {
  band: 'header' | 'footer';
  kind: 'text' | 'image';
  x: number;
  y: number;
  text: string;
  src: string;
  alt: string;
  widthMm: number;
  heightMm: number;
  fontSizePt: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  color: string;
}

export interface PrintableFurniture {
  header: string;
  footer: string;
  /** Distances aux bords et corps du texte, en millimètres / points. */
  headerMm?: number;
  footerMm?: number;
  headerAlign?: 'left' | 'center' | 'right';
  footerAlign?: 'left' | 'center' | 'right';
  fontSizePt?: number;
  /** Éléments libres posés dans l'une ou l'autre bande. */
  blocks?: PrintableBlock[];
  /** Hauteur du contenu de chaque bande, en millimètres. */
  headerContentMm?: number;
  footerContentMm?: number;
}

export interface PrintableOptions {
  titre: string;
  /** Marges du corps, en millimètres ; par défaut celles d'`PAGE_A4`. */
  marges?: { hautMm: number; basMm: number; gaucheMm: number; droiteMm: number };
  /** En-tête et pied, répétés sur chaque page imprimée. */
  furniture?: PrintableFurniture;
  /** HTML du corps du document (contenu de l'éditeur, nettoyé). */
  contenuHtml: string;
  /** Feuilles de style à reprendre pour que le rendu soit celui de l'écran. */
  stylesCss: string;
  /** Géométrie de la page, en millimètres. */
  page?: { largeurMm: number; hauteurMm: number; margeMm: number };
}

export const PAGE_A4 = { largeurMm: 210, hauteurMm: 297, margeMm: 25 } as const;

function echapper(valeur: string): string {
  return valeur.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Valeur d'attribut : les guillemets s'échappent aussi.
 *
 * `echapper` suffit pour du texte entre balises ; dans un attribut, un guillemet
 * non échappé referme la valeur et ouvre la porte à un `onerror=`.
 */
function echapperAttribut(valeur: string): string {
  return echapper(valeur).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Adresse d'image imprimable.
 *
 * Deuxième barrière, après celle du modèle : ce module fabrique du HTML brut à
 * partir de chaînes, et c'est le dernier endroit où une adresse hostile pourrait
 * encore entrer.
 */
function adresseSure(valeur: string): boolean {
  if (valeur.startsWith('/api/v1/documents/')) return true;
  return /^https?:\/\//i.test(valeur);
}

/** Couleur reprise telle quelle : uniquement si elle est bien un `#rrggbb`. */
function couleurSure(valeur: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(valeur) ? valeur : '#444444';
}

/** Un bloc libre, positionné en absolu dans sa bande. */
function blocImprime(bloc: PrintableBlock): string {
  const position = `position:absolute;left:${bloc.x * 100}%;top:${bloc.y}mm;`;

  if (bloc.kind === 'image') {
    if (!adresseSure(bloc.src)) return '';
    return (
      `<img style="${position}width:${bloc.widthMm}mm;height:${bloc.heightMm}mm;object-fit:contain"` +
      ` src="${echapperAttribut(bloc.src)}" alt="${echapperAttribut(bloc.alt)}">`
    );
  }

  const style =
    `${position}font-size:${bloc.fontSizePt}pt;` +
    `font-weight:${bloc.bold ? 700 : 400};` +
    `font-style:${bloc.italic ? 'italic' : 'normal'};` +
    `text-decoration:${bloc.underline ? 'underline' : 'none'};` +
    `color:${couleurSure(bloc.color)};white-space:nowrap`;

  return `<span style="${style}">${echapper(bloc.text)}</span>`;
}

/** Les blocs d'une bande, dans leur conteneur. */
function blocsDeBande(furniture: PrintableFurniture | undefined, band: 'header' | 'footer'): string {
  return (furniture?.blocks ?? [])
    .filter((bloc) => bloc.band === band)
    .map(blocImprime)
    .join('');
}

/** Une bande complète : sa ligne de base et ses blocs, ou rien du tout. */
function bandeImprimee(
  furniture: PrintableFurniture | undefined,
  band: 'header' | 'footer',
): string {
  const ligne = band === 'header' ? (furniture?.header ?? '') : (furniture?.footer ?? '');
  const blocs = blocsDeBande(furniture, band);
  if (ligne === '' && blocs === '') return '';

  const classe = band === 'header' ? 'entete-page' : 'pied-page';
  const texte = ligne === '' ? '' : `<span class="bande-ligne">${echapper(ligne)}</span>`;
  return `<div class="${classe}">${texte}${blocs}</div>`;
}

/** Construit le document HTML complet envoyé à l'impression. */
export function buildPrintHtml(options: PrintableOptions): string {
  const page = options.page ?? PAGE_A4;
  const marges = options.marges ?? {
    hautMm: page.margeMm,
    basMm: page.margeMm,
    gaucheMm: page.margeMm,
    droiteMm: page.margeMm,
  };

  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<title>${echapper(options.titre)}</title>
<style>${options.stylesCss}</style>
<style>
  /* Marge de page nulle : c'est elle qui héberge les en-têtes du navigateur.
     Les marges du document sont appliquées dans la feuille elle-même. */
  @page {
    size: ${page.largeurMm}mm ${page.hauteurMm}mm;
    margin: 0;
  }

  html, body {
    margin: 0;
    padding: 0;
    background: #fff;
  }

  .feuille {
    box-sizing: border-box;
    width: ${page.largeurMm}mm;
    min-height: ${page.hauteurMm}mm;
    /* Mêmes marges qu'à l'écran : la feuille imprimée doit être la même feuille. */
    padding: ${marges.hautMm}mm ${marges.droiteMm}mm ${marges.basMm}mm ${marges.gaucheMm}mm;
    margin: 0 auto;
    background: #fff;
  }

  /* Un élément fixé se répète sur chaque page à l'impression : c'est ainsi que
     l'en-tête et le pied restent identiques d'une feuille à l'autre. */
  .entete-page,
  .pied-page {
    position: fixed;
    left: ${marges.gaucheMm}mm;
    right: ${marges.droiteMm}mm;
    font-size: ${options.furniture?.fontSizePt ?? 9}pt;
    color: #444;
  }

  /* Le rognage vaut pour la ligne de base seule : appliqué au conteneur, il
     couperait les blocs libres posés en dessous. */
  .bande-ligne {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .entete-page {
    top: ${options.furniture?.headerMm ?? 12}mm;
    height: ${options.furniture?.headerContentMm ?? 5}mm;
    border-bottom: 1px solid #ccc;
    text-align: ${options.furniture?.headerAlign ?? 'left'};
  }

  .pied-page {
    bottom: ${options.furniture?.footerMm ?? 12}mm;
    height: ${options.furniture?.footerContentMm ?? 5}mm;
    border-top: 1px solid #ccc;
    text-align: ${options.furniture?.footerAlign ?? 'right'};
  }

  /* La ligne de base se cale sur le bord de son filet ; les blocs libres se
     placent où on les a posés. */
  .bande-ligne { position: absolute; left: 0; right: 0; }
  .entete-page .bande-ligne { top: 0; }
  .pied-page .bande-ligne { bottom: 0; }

  /* Le contenu reprend le rendu de l'écran, sans les artefacts d'édition. */
  .feuille .ProseMirror {
    width: auto;
    min-height: 0;
    padding: 0;
    box-shadow: none;
    outline: none;
  }

  .ProseMirror-yjs-cursor,
  .ProseMirror-yjs-selection,
  .table-overlay,
  .pm-math--empty::after {
    display: none !important;
  }

  .search-hit,
  .search-hit--current {
    background: transparent !important;
    box-shadow: none !important;
  }

  /* Mise en page : les règles typographiques d'un document imprimé. */
  h1, h2, h3, h4, h5, h6 { break-after: avoid; break-inside: avoid; }
  p, li { orphans: 3; widows: 3; }
  table, .pm-task-item, .pm-image, .pm-math--block { break-inside: avoid; }
  .pm-page-break { break-after: page; height: 0; margin: 0; border: 0; }
  a { color: inherit; }
</style>
</head>
<body>
  ${bandeImprimee(options.furniture, 'header')}
  ${bandeImprimee(options.furniture, 'footer')}
  <div class="feuille">${options.contenuHtml}</div>
</body>
</html>`;
}

/**
 * Copie les feuilles de style de la page.
 * Celles d'une autre origine sont illisibles par script : on les référence alors
 * par `<link>` plutôt que de perdre leur rendu.
 */
export function collectStyles(documentSource: Document = document): string {
  const morceaux: string[] = [];

  for (const feuille of Array.from(documentSource.styleSheets)) {
    try {
      const regles = feuille.cssRules;
      morceaux.push(Array.from(regles).map((regle) => regle.cssText).join('\n'));
    } catch {
      const href = (feuille as CSSStyleSheet).href;
      if (href) morceaux.push(`@import url("${href}");`);
    }
  }

  return morceaux.join('\n');
}

/** Retire du clone ce qui n'appartient pas au document imprimé. */
export function nettoyerContenu(racine: HTMLElement): HTMLElement {
  const clone = racine.cloneNode(true) as HTMLElement;

  clone
    .querySelectorAll(
      '.ProseMirror-yjs-cursor, .table-overlay, .ProseMirror-widget, .ProseMirror-gapcursor, .ProseMirror-trailingBreak',
    )
    .forEach((element) => element.remove());

  // Attributs d'édition : un document imprimé n'est ni modifiable ni corrigé.
  // La racine est traitée comme ses descendants — `querySelectorAll` l'ignore,
  // et c'est elle qui porte ces attributs dans l'éditeur.
  for (const element of [clone, ...Array.from(clone.querySelectorAll('*'))]) {
    element.removeAttribute('contenteditable');
    element.removeAttribute('spellcheck');
    element.removeAttribute('translate');
    element.removeAttribute('autocorrect');
  }

  return clone;
}

/**
 * Ouvre la boîte d'impression sur le document seul.
 *
 * Le rendu a lieu dans un cadre isolé, hors de l'application : ni règle, ni
 * ruban, ni panneau ne peut s'y glisser. Le cadre est retiré ensuite, que
 * l'impression ait été confirmée ou annulée.
 */
export async function imprimerDocument(
  source: HTMLElement,
  titre: string,
  furniture?: PrintableFurniture,
  marges?: PrintableOptions['marges'],
): Promise<void> {
  const html = buildPrintHtml({
    titre,
    contenuHtml: nettoyerContenu(source).outerHTML,
    stylesCss: collectStyles(),
    ...(furniture ? { furniture } : {}),
    ...(marges ? { marges } : {}),
  });

  const cadre = document.createElement('iframe');
  // Hors écran plutôt que `display: none` : un cadre masqué ne met pas son
  // contenu en page, et l'impression sortirait vide.
  cadre.setAttribute('aria-hidden', 'true');
  cadre.style.cssText = 'position:fixed; right:0; bottom:0; width:1px; height:1px; opacity:0; border:0;';
  document.body.appendChild(cadre);

  const fenetre = cadre.contentWindow;
  const documentCadre = cadre.contentDocument;
  if (!fenetre || !documentCadre) {
    cadre.remove();
    throw new Error("Impossible de préparer l'aperçu d'impression.");
  }

  documentCadre.open();
  documentCadre.write(html);
  documentCadre.close();

  // Attendre les polices : imprimer avant leur chargement décalerait tout le texte.
  await new Promise<void>((resolve) => {
    const pret = (): void => {
      const polices = (documentCadre as Document & { fonts?: FontFaceSet }).fonts;
      if (polices?.ready) {
        void polices.ready.then(() => resolve());
      } else {
        resolve();
      }
    };
    if (documentCadre.readyState === 'complete') pret();
    else cadre.addEventListener('load', pret, { once: true });
  });

  try {
    fenetre.focus();
    fenetre.print();
  } finally {
    // Le retrait est différé : Safari imprime de façon asynchrone.
    window.setTimeout(() => cadre.remove(), 1000);
  }
}
