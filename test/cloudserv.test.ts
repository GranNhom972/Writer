/**
 * Ouverture d'un document venu de CloudServ.
 *
 * CloudServ ouvre l'éditeur sur `#doc=<uuid>&token=<billet>`. Deux propriétés
 * comptent ici, et l'une est de sécurité :
 *
 *  - le billet est lu dans le **fragment**, jamais dans la query string : un
 *    fragment n'est pas envoyé au serveur, donc n'apparaît ni dans les journaux
 *    d'accès ni dans le `Referer` ;
 *  - ce que le billet annonce ne sert qu'à **afficher**. La permission qui
 *    compte est celle que le serveur applique — mentir dans son billet ne donne
 *    aucun droit, cela ne fait qu'afficher des boutons sans effet.
 *
 * @vitest-environment jsdom
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { readCloudServLink, readTicketClaims } from '../src/domain/collab/session';

/** Fabrique un billet non signé — c'est la charge utile qui est lue, pas la signature. */
function billet(claims: Record<string, unknown>): string {
  const b64 = (valeur: string): string => {
    // `btoa` prend des octets, pas des caractères : encoder en UTF-8 d'abord,
    // comme le fait CloudServ. Lui passer « É » directement produirait un octet
    // qui n'est pas celui du jeton réel.
    const octets = new TextEncoder().encode(valeur);
    let binaire = '';
    octets.forEach((octet) => {
      binaire += String.fromCharCode(octet);
    });
    return btoa(binaire).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  return [
    b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' })),
    b64(JSON.stringify(claims)),
    'signature-non-verifiee-ici',
  ].join('.');
}

describe('lien d’ouverture CloudServ', () => {
  // `readCloudServLink` mémorise le billet dans `sessionStorage` pour survivre
  // à un F5 : sans remise à zéro, le billet d'un test précédent complétait le
  // lien « incomplet » du suivant, et le résultat dépendait de l'ordre.
  beforeEach(() => sessionStorage.clear());

  it('lit le document et le billet du fragment', () => {
    const lien = readCloudServLink('#doc=01a03d4d-0000-7000-8000-000000000001&token=abc.def.ghi');
    expect(lien).toEqual({
      docId: '01a03d4d-0000-7000-8000-000000000001',
      token: 'abc.def.ghi',
    });
  });

  it('accepte un fragment sans dièse', () => {
    expect(readCloudServLink('doc=d1&token=t1')).toEqual({ docId: 'd1', token: 't1' });
  });

  it('refuse un lien incomplet', () => {
    expect(readCloudServLink('#doc=d1')).toBeNull();
    expect(readCloudServLink('#token=t1')).toBeNull();
    expect(readCloudServLink('')).toBeNull();
    // Un lien de partage Writer n'est pas un lien CloudServ : les deux
    // ouvertures ne doivent pas se déclencher l'une sur l'autre.
    expect(readCloudServLink('#session=abc&email=a@b.fr')).toBeNull();
  });

  it('retrouve le billet après un rechargement de la page (F5)', () => {
    expect(readCloudServLink('#token=t1', '/doc/d1')).toEqual({ docId: 'd1', token: 't1' });
    // Le fragment a disparu de l'adresse, le billet vient de l'onglet…
    expect(readCloudServLink('', '/doc/d1')).toEqual({ docId: 'd1', token: 't1' });
    // … mais seulement pour CE document.
    expect(readCloudServLink('', '/doc/d2')).toBeNull();
  });
});

describe('lecture du billet', () => {
  it('rend l’identité et la permission inscrites', () => {
    const claims = readTicketClaims(
      billet({ sub: 'alice-1a2b3c4d5e', name: 'alice', scope: 'write', exp: 1 }),
    );
    expect(claims).toEqual({
      userId: 'alice-1a2b3c4d5e',
      displayName: 'alice',
      permission: 'write',
    });
  });

  it('retombe en lecture seule sur une portée inconnue', () => {
    // La prudence va dans le sens le plus restreint : afficher une barre
    // d'outils active sur un document où le serveur refusera d'écrire ne
    // produirait que des refus incompréhensibles.
    expect(readTicketClaims(billet({ sub: 'bob', scope: 'administrateur' }))?.permission).toBe(
      'read',
    );
    expect(readTicketClaims(billet({ sub: 'bob' }))?.permission).toBe('read');
  });

  it('se rabat sur l’identifiant quand le nom manque', () => {
    expect(readTicketClaims(billet({ sub: 'carol', scope: 'read' }))?.displayName).toBe('carol');
  });

  it('lit un nom accentué', () => {
    // `atob` rend des octets, pas des caractères : un nom non-ASCII décodé sans
    // repasser par UTF-8 sortirait en mojibake.
    expect(readTicketClaims(billet({ sub: 'elodie', name: 'Élodie Bréa' }))?.displayName).toBe(
      'Élodie Bréa',
    );
  });

  it('refuse un billet illisible plutôt que de deviner', () => {
    expect(readTicketClaims('pas-un-jeton')).toBeNull();
    expect(readTicketClaims('a.@@@.c')).toBeNull();
    expect(readTicketClaims(billet({ name: 'sans sujet' }))).toBeNull();
    expect(readTicketClaims('')).toBeNull();
  });
});
