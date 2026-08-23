import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ICON_NAMES, Icon, type IconName } from '../src/design/icons/Icon';

/** Noms d'icônes attendus par le ruban : une icône manquante casserait un bouton. */
const REQUIRED: IconName[] = [
  'undo',
  'redo',
  'print',
  'clear-format',
  'bold',
  'italic',
  'underline',
  'strikethrough',
  'text-color',
  'highlight',
  'link',
  'image',
  'align-left',
  'align-center',
  'align-right',
  'align-justify',
  'line-height',
  'list-check',
  'list-bullet',
  'list-ordered',
  'indent-decrease',
  'indent-increase',
  'font-smaller',
  'font-larger',
  'share',
];

describe('système d’icônes', () => {
  it('expose toutes les icônes utilisées par le ruban', () => {
    for (const name of REQUIRED) {
      expect(ICON_NAMES).toContain(name);
    }
  });

  it('rend une icône décorative : jamais annoncée, jamais focusable', () => {
    // Le nom accessible vient de l'`aria-label` du bouton ; une icône annoncée
    // produirait une double lecture au lecteur d'écran (directive UX §6).
    for (const name of ICON_NAMES) {
      const markup = renderToStaticMarkup(<Icon name={name} />);
      expect(markup).toContain('aria-hidden="true"');
      expect(markup).toContain('focusable="false"');
    }
  });

  it('dessine sur la grille 24 × 24 et hérite de la couleur du bouton', () => {
    for (const name of ICON_NAMES) {
      const markup = renderToStaticMarkup(<Icon name={name} />);
      expect(markup).toContain('viewBox="0 0 24 24"');
      expect(markup).toContain('stroke="currentColor"');
      // Aucune couleur en dur : l'icône suit l'état (survol, actif, désactivé)
      // et le thème clair/sombre sans règle supplémentaire.
      expect(markup).not.toMatch(/#[0-9a-f]{3,6}/i);
    }
  });

  it('respecte la taille demandée', () => {
    const markup = renderToStaticMarkup(<Icon name="bold" size={16} />);
    expect(markup).toContain('width="16"');
    expect(markup).toContain('height="16"');
  });

  it('appuie le contour de l’icône « gras » : elle doit paraître grasse', () => {
    const bold = renderToStaticMarkup(<Icon name="bold" />);
    const italic = renderToStaticMarkup(<Icon name="italic" />);
    const weight = (markup: string): number =>
      Number(/stroke-width="([\d.]+)"/.exec(markup)?.[1] ?? 0);

    expect(weight(bold)).toBeGreaterThan(weight(italic));
  });
});
