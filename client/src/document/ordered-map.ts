/**
 * Ré-export typé d'`orderedmap`, dépendance transitive de `prosemirror-model`.
 * Isolé ici pour qu'un seul fichier porte le `import` non typé du paquet.
 */
import OrderedMapImpl from 'orderedmap';

export const OrderedMap = OrderedMapImpl;
export type { default as OrderedMapType } from 'orderedmap';
