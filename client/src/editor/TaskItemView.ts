/**
 * NodeView d'un élément de liste à cocher.
 *
 * La case est un vrai `<input type="checkbox">` : focusable au clavier, annoncé
 * par les lecteurs d'écran, et coché par `Espace` — ce qu'un pseudo-élément
 * stylé ne permettrait pas (directive UX §6).
 */

import type { Node as PMNode } from 'prosemirror-model';
import type { EditorView, NodeView } from 'prosemirror-view';

export class TaskItemView implements NodeView {
  dom: HTMLLIElement;
  contentDOM: HTMLDivElement;
  private readonly checkbox: HTMLInputElement;

  constructor(
    private node: PMNode,
    private readonly view: EditorView,
    private readonly getPos: () => number | undefined,
  ) {
    this.dom = document.createElement('li');
    this.dom.className = 'pm-task-item';
    this.dom.dataset['taskItem'] = 'true';

    const control = document.createElement('span');
    control.className = 'pm-task-item__control';
    control.contentEditable = 'false';

    this.checkbox = document.createElement('input');
    this.checkbox.type = 'checkbox';
    this.checkbox.checked = Boolean(node.attrs['checked']);
    this.checkbox.setAttribute('aria-label', 'Tâche effectuée');
    this.checkbox.addEventListener('change', this.onToggle);

    control.appendChild(this.checkbox);

    this.contentDOM = document.createElement('div');
    this.contentDOM.className = 'pm-task-item__content';

    this.dom.append(control, this.contentDOM);
    this.syncChecked(Boolean(node.attrs['checked']));
  }

  private onToggle = (): void => {
    const pos = this.getPos();
    if (pos === undefined) return;
    const { state, dispatch } = this.view;
    const node = state.doc.nodeAt(pos);
    if (!node) return;
    dispatch(
      state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked: this.checkbox.checked }),
    );
  };

  private syncChecked(checked: boolean): void {
    this.dom.dataset['checked'] = String(checked);
    this.checkbox.checked = checked;
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.syncChecked(Boolean(node.attrs['checked']));
    return true;
  }

  /** La case n'appartient pas au document éditable : PM doit l'ignorer. */
  stopEvent(event: Event): boolean {
    return event.target === this.checkbox;
  }

  ignoreMutation(): boolean {
    return true;
  }

  destroy(): void {
    this.checkbox.removeEventListener('change', this.onToggle);
  }
}
