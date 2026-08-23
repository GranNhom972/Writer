/**
 * Banc d'essai de la pagination (`/pagination-test.html` en développement).
 *
 * Il construit un document éprouvant — paragraphes, titres, longue liste, long
 * tableau, saut manuel — puis **mesure** chaque élément de texte contre les
 * bandes d'en-tête et de pied de page. Les fautifs sont soulignés en rouge et
 * comptés : le verdict se lit d'un coup d'œil, sans avoir à faire défiler.
 *
 * Il existe parce qu'une capture d'écran ne prouve rien : elle montre un endroit
 * du document à un instant donné, là où la pagination doit tenir partout.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { writeSchema } from './document/schema';
import { paginationPlugin, remesurerPagination } from './editor/pagination-plugin';
import { DEFAULT_FURNITURE, PAGE_GAP_MM, resolveGeometry } from './document/pageFurniture';
import { A4 } from './design/tokens';
import './design/tokens.css';
import './ui/app.css';
import './editor/editor.css';
import 'prosemirror-view/style/prosemirror.css';

const mm = (valeur: number): number => valeur * (96 / 25.4);

interface Verdict {
  total: number;
  surEntete: string[];
  surPied: string[];
  pages: number;
  debutsDePage: { page: number; haut: number; attendu: number; texte: string }[];
}

function documentEprouvant() {
  const p = (texte: string) => writeSchema.node('paragraph', null, texte ? [writeSchema.text(texte)] : []);
  const h = (niveau: number, texte: string) =>
    writeSchema.node('heading', { level: niveau }, [writeSchema.text(texte)]);

  const blocs = [h(1, 'Banc d’essai de pagination'), p('Premier paragraphe du document.')];

  for (let i = 0; i < 26; i += 1) blocs.push(p(`Paragraphe ${i + 1} — texte de remplissage destiné à franchir la limite de page.`));

  blocs.push(h(2, 'Liste à cheval sur deux pages'));
  blocs.push(
    writeSchema.node(
      'bullet_list',
      null,
      Array.from({ length: 18 }, (_, i) =>
        writeSchema.node('list_item', null, [p(`Point ${i + 1} de la liste de contrôle`)]),
      ),
    ),
  );

  blocs.push(h(2, 'Tableau plus long qu’une page'));
  const ligne = (cellules: string[], entete = false) =>
    writeSchema.node(
      'table_row',
      null,
      cellules.map((texte) =>
        writeSchema.node(entete ? 'table_header' : 'table_cell', null, [p(texte)]),
      ),
    );
  blocs.push(
    writeSchema.node('table', null, [
      ligne(['Poste', 'Montant'], true),
      ...Array.from({ length: 24 }, (_, i) => ligne([`Ligne ${i + 1}`, `${(i + 1) * 120} €`])),
    ]),
  );

  blocs.push(p('Après le tableau.'));
  blocs.push(writeSchema.node('page_break'));
  blocs.push(h(2, 'Après un saut manuel'));
  blocs.push(p('Ce titre doit commencer une nouvelle page.'));

  return writeSchema.node('doc', null, blocs);
}

function Banc() {
  const hote = useRef<HTMLDivElement | null>(null);
  const vue = useRef<EditorView | null>(null);
  const reglages = useRef<Parameters<typeof paginationPlugin>[0] | null>(null);
  const [pages, setPages] = useState(1);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const geometrie = useMemo(() => resolveGeometry(DEFAULT_FURNITURE), []);

  useEffect(() => {
    const conteneur = hote.current;
    if (!conteneur) return;

    const options = {
      readGeometry: () => ({
        pageHeight: mm(A4.heightMm),
        marginTop: mm(geometrie.marginTopMm),
        marginBottom: mm(geometrie.marginBottomMm),
        gap: mm(PAGE_GAP_MM),
      }),
      onPageCount: setPages,
    };
    reglages.current = options;

    const state = EditorState.create({
      schema: writeSchema,
      doc: documentEprouvant(),
      plugins: [paginationPlugin(options)],
    });

    const view = new EditorView(conteneur, { state });
    vue.current = view;
    return () => {
      vue.current = null;
      view.destroy();
    };
  }, [geometrie]);

  const mesurer = (): void => {
    const editable = hote.current?.querySelector<HTMLElement>('.ProseMirror');
    if (!editable) return;

    // On relance d'abord la pagination : dans un navigateur qui ne compose pas
    // (panneau masqué, onglet en arrière-plan), ni `ResizeObserver` ni
    // `requestAnimationFrame` ne se déclenchent.
    if (vue.current && reglages.current) remesurerPagination(vue.current, reglages.current);

    const rect = editable.getBoundingClientRect();
    const page = mm(A4.heightMm);
    const margeHaute = mm(geometrie.marginTopMm);
    const margeBasse = mm(geometrie.marginBottomMm);

    const elements = Array.from(editable.querySelectorAll<HTMLElement>('p, li, h1, h2, h3, td, th')).filter(
      (element) => element.textContent?.trim(),
    );

    const surEntete: string[] = [];
    const surPied: string[] = [];
    const debuts = new Map<number, { haut: number; texte: string }>();

    for (const element of elements) {
      element.classList.remove('essai-faute');
      const boite = element.getBoundingClientRect();
      const rembourrage = Number.parseFloat(window.getComputedStyle(element).paddingTop) || 0;
      const haut = boite.top - rect.top + rembourrage;
      const bas = boite.bottom - rect.top;
      const index = Math.floor(haut / page);
      const libelle = `« ${element.textContent?.slice(0, 24)} » (page ${index + 1})`;

      if (haut < index * page + margeHaute - 2) {
        surEntete.push(libelle);
        element.classList.add('essai-faute');
      }
      if (bas > index * page + page - margeBasse + 2) {
        surPied.push(libelle);
        element.classList.add('essai-faute');
      }
      if (!debuts.has(index)) debuts.set(index, { haut: Math.round(haut), texte: element.textContent?.slice(0, 22) ?? '' });
    }

    setVerdict({
      total: elements.length,
      surEntete,
      surPied,
      pages,
      debutsDePage: [...debuts.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([index, valeur]) => ({
          page: index + 1,
          haut: valeur.haut,
          attendu: Math.round(index * page + margeHaute),
          texte: valeur.texte,
        })),
    });
  };

  const echec = verdict !== null && (verdict.surEntete.length > 0 || verdict.surPied.length > 0);

  return (
    <div className="essai">
      <header className="essai__barre">
        <h1 className="essai__titre">Banc d’essai de pagination</h1>
        <button type="button" className="btn btn--primary" onClick={mesurer}>
          Mesurer
        </button>
        {verdict && (
          <span className={`essai__verdict essai__verdict--${echec ? 'echec' : 'ok'}`}>
            {echec
              ? `${verdict.surEntete.length + verdict.surPied.length} élément(s) sur une marge`
              : `Aucun texte sur l’en-tête ni le pied — ${verdict.total} éléments contrôlés`}
          </span>
        )}
      </header>

      {verdict && (
        <section className="essai__rapport">
          <p>
            {verdict.pages} page(s). Début de chaque page (mesuré / attendu) :{' '}
            {verdict.debutsDePage
              .map((d) => `p${d.page} ${d.haut}/${d.attendu}px`)
              .join(' · ')}
          </p>
          {verdict.surEntete.length > 0 && <p>Sur l’en-tête : {verdict.surEntete.join(', ')}</p>}
          {verdict.surPied.length > 0 && <p>Sur le pied : {verdict.surPied.join(', ')}</p>}
        </section>
      )}

      <div className="page-stack essai__page" ref={hote} data-page-count={pages}>
        <div className="page-guides" aria-hidden="true">
          {Array.from({ length: pages }, (_, index) => (
            <div key={index} className="page-guide" style={{ height: `${A4.heightMm}mm` }}>
              <span className="page-guide__header">En-tête de page</span>
              <span className="page-guide__footer">Pied de page — {index + 1}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const racine = document.getElementById('root');
if (racine) createRoot(racine).render(<Banc />);
