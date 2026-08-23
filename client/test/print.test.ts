import { describe, expect, it } from 'vitest';
import { PAGE_A4, buildPrintHtml, nettoyerContenu } from '../src/document/print/printable';

function contenuAvecArtefacts(): HTMLElement {
  const racine = document.createElement('div');
  racine.className = 'ProseMirror';
  racine.setAttribute('contenteditable', 'true');
  racine.setAttribute('spellcheck', 'true');
  racine.innerHTML = `
    <h1>Notes de réunion</h1>
    <p>Texte du document<span class="ProseMirror-yjs-cursor"><div>alice</div></span></p>
    <p>Suite<br class="ProseMirror-trailingBreak"></p>
    <div class="table-overlay"><button>poignée</button></div>
  `;
  return racine;
}

describe('nettoyage du contenu imprimé', () => {
  it('retire les artefacts d’édition', () => {
    const propre = nettoyerContenu(contenuAvecArtefacts());

    expect(propre.querySelector('.ProseMirror-yjs-cursor')).toBeNull();
    expect(propre.querySelector('.table-overlay')).toBeNull();
    expect(propre.querySelector('.ProseMirror-trailingBreak')).toBeNull();
  });

  it('rend le clone non modifiable', () => {
    const propre = nettoyerContenu(contenuAvecArtefacts());
    expect(propre.getAttribute('contenteditable')).toBeNull();
    expect(propre.getAttribute('spellcheck')).toBeNull();
  });

  it('conserve le contenu du document', () => {
    const propre = nettoyerContenu(contenuAvecArtefacts());
    expect(propre.textContent).toContain('Notes de réunion');
    expect(propre.textContent).toContain('Texte du document');
  });

  it('ne modifie pas l’original', () => {
    const original = contenuAvecArtefacts();
    nettoyerContenu(original);
    expect(original.querySelector('.ProseMirror-yjs-cursor')).not.toBeNull();
    expect(original.getAttribute('contenteditable')).toBe('true');
  });
});

describe('document d’impression', () => {
  const html = buildPrintHtml({
    titre: 'Notes de réunion',
    contenuHtml: '<h1>Titre</h1><p>Corps</p>',
    stylesCss: '.ProseMirror { font-family: serif; }',
  });

  it('supprime la marge de page, où logent les en-têtes du navigateur', () => {
    // Date, titre et URL ajoutés par le navigateur occupent cette marge :
    // à zéro, ils n'ont plus de place.
    expect(html).toContain('margin: 0;');
    expect(html).toContain(`size: ${PAGE_A4.largeurMm}mm ${PAGE_A4.hauteurMm}mm`);
  });

  it('applique les marges du document à l’intérieur de la feuille', () => {
    expect(html).toContain(`padding: ${PAGE_A4.margeMm}mm`);
    expect(html).toContain(`width: ${PAGE_A4.largeurMm}mm`);
  });

  it('ne contient que la feuille : aucun élément d’interface', () => {
    for (const chrome of ['ribbon', 'menubar', 'statusbar', 'titlebar', 'findbar']) {
      expect(html).not.toContain(`class="${chrome}"`);
    }
    expect(html).toContain('<div class="feuille">');
  });

  it('reprend les styles de l’écran pour un rendu identique', () => {
    expect(html).toContain('.ProseMirror { font-family: serif; }');
  });

  it('porte le titre du document', () => {
    expect(html).toContain('<title>Notes de réunion</title>');
  });

  it('échappe le titre plutôt que de laisser injecter du balisage', () => {
    const injecte = buildPrintHtml({
      titre: '<script>alert(1)</script>',
      contenuHtml: '<p>x</p>',
      stylesCss: '',
    });
    expect(injecte).not.toContain('<script>alert(1)</script>');
    expect(injecte).toContain('&lt;script&gt;');
  });

  it('impose les règles typographiques de la page imprimée', () => {
    expect(html).toContain('orphans: 3');
    expect(html).toContain('break-after: avoid');
    expect(html).toContain('break-after: page');
  });

  it('accepte une autre géométrie de page', () => {
    const paysage = buildPrintHtml({
      titre: 'Paysage',
      contenuHtml: '',
      stylesCss: '',
      page: { largeurMm: 297, hauteurMm: 210, margeMm: 15 },
    });
    expect(paysage).toContain('size: 297mm 210mm');
    expect(paysage).toContain('padding: 15mm');
  });
});

describe('mise en page transmise à l’impression', () => {
  it('reprend les marges du document', () => {
    const html = buildPrintHtml({
      titre: 'Rapport',
      contenuHtml: '<p>x</p>',
      stylesCss: '',
      marges: { hautMm: 30, basMm: 20, gaucheMm: 35, droiteMm: 15 },
    });
    expect(html).toContain('padding: 30mm 15mm 20mm 35mm');
  });

  it('place l’en-tête et le pied aux distances réglées', () => {
    const html = buildPrintHtml({
      titre: 'Rapport',
      contenuHtml: '',
      stylesCss: '',
      furniture: {
        header: 'Société',
        footer: 'Confidentiel',
        headerMm: 20,
        footerMm: 18,
        headerAlign: 'center',
        footerAlign: 'left',
        fontSizePt: 12,
      },
    });

    expect(html).toContain('top: 20mm');
    expect(html).toContain('bottom: 18mm');
    expect(html).toContain('text-align: center');
    expect(html).toContain('font-size: 12pt');
  });

  it('retombe sur des valeurs sûres quand rien n’est réglé', () => {
    const html = buildPrintHtml({ titre: 'x', contenuHtml: '', stylesCss: '' });
    expect(html).toContain(`padding: ${PAGE_A4.margeMm}mm`);
  });
});
