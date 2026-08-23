/**
 * Vue d'une formule dans le document.
 *
 * Le nœud est un atome : son contenu n'est pas éditable directement. On clique
 * dessus pour rouvrir l'éditeur de formule — la source LaTeX reste la seule
 * représentation modifiable, ce qui évite un document dans un état illisible.
 *
 * Accessibilité : KaTeX produit du MathML lu par les technologies d'assistance ;
 * on ajoute `role="math"` et un libellé de repli avec la source, pour les
 * lecteurs qui n'interprètent pas MathML.
 */

import type { Node as PMNode } from 'prosemirror-model';
import type { NodeView } from 'prosemirror-view';
import { renderMath } from '../document/math/render';

export class MathView implements NodeView {
  dom: HTMLElement;
  private readonly display: boolean;
  private latex: string;
  /** Une formule modifiée pendant un rendu asynchrone ne DOIT pas être écrasée. */
  private renderToken = 0;

  constructor(
    node: PMNode,
    private readonly getPos: () => number | undefined,
    private readonly onEdit: (pos: number) => void,
  ) {
    this.display = node.type.name === 'math_block';
    this.latex = String(node.attrs['latex'] ?? '');

    this.dom = document.createElement(this.display ? 'div' : 'span');
    this.dom.className = `pm-math pm-math--${this.display ? 'block' : 'inline'}`;
    this.dom.setAttribute('role', 'math');
    this.dom.contentEditable = 'false';
    // Atteignable au clavier : `Tab` amène sur la formule, `Entrée` l'ouvre.
    this.dom.tabIndex = 0;

    this.dom.addEventListener('click', this.open);
    this.dom.addEventListener('keydown', this.onKeyDown);

    void this.paint();
  }

  private open = (event?: Event): void => {
    event?.preventDefault();
    const pos = this.getPos();
    if (pos !== undefined) this.onEdit(pos);
  };

  private onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      this.open();
    }
  };

  private async paint(): Promise<void> {
    const token = (this.renderToken += 1);
    const source = this.latex;

    this.dom.setAttribute('aria-label', source ? `Formule : ${source}` : 'Formule vide');
    this.dom.title = source;

    if (!source.trim()) {
      this.dom.classList.add('pm-math--empty');
      this.dom.textContent = 'Formule vide';
      return;
    }

    const result = await renderMath(source, this.display);
    if (token !== this.renderToken) return; // rendu obsolète : une frappe l'a devancé

    this.dom.classList.remove('pm-math--empty');
    if (result.ok) {
      this.dom.classList.remove('pm-math--error');
      this.dom.innerHTML = result.html;
    } else {
      // Une formule invalide reste visible et corrigeable : on n'efface jamais
      // la saisie de l'usager au profit d'un message d'erreur.
      this.dom.classList.add('pm-math--error');
      this.dom.textContent = source;
      this.dom.setAttribute('aria-label', `Formule invalide : ${result.message}`);
      this.dom.title = result.message;
    }
  }

  update(node: PMNode): boolean {
    if (node.type.name !== (this.display ? 'math_block' : 'math_inline')) return false;
    const next = String(node.attrs['latex'] ?? '');
    if (next !== this.latex) {
      this.latex = next;
      void this.paint();
    }
    return true;
  }

  selectNode(): void {
    this.dom.classList.add('pm-math--selected');
  }

  deselectNode(): void {
    this.dom.classList.remove('pm-math--selected');
  }

  stopEvent(): boolean {
    return true;
  }

  ignoreMutation(): boolean {
    return true;
  }

  destroy(): void {
    this.dom.removeEventListener('click', this.open);
    this.dom.removeEventListener('keydown', this.onKeyDown);
  }
}
