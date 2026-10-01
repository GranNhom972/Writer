// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors

/**
 * Opening a document that comes from CloudServ.
 *
 * CloudServ opens the editor on `#doc=<uuid>&token=<ticket>`. Two properties matter here, and one is a security one:
 *
 *  - the ticket is read from the **fragment**, never from the query string: a fragment is not sent to the server, so it appears neither in the access logs nor in the `Referer`;
 *  - what the ticket announces only serves to **display**. The permission that counts is the one the server applies: lying in your ticket gives no right, it only shows buttons with no effect.
 *
 * @vitest-environment jsdom
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { readCloudServLink, readTicketClaims } from '../src/domain/collab/session';

/** Builds an unsigned ticket: it is the payload that is read, not the signature. */
function billet(claims: Record<string, unknown>): string {
  const b64 = (valeur: string): string => {
    // `btoa` takes bytes, not characters: we encode in UTF-8 first, as CloudServ does. Passing it "É" directly would produce a byte that is not the one in the real token.
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
  // `readCloudServLink` remembers the ticket in `sessionStorage` to survive an F5: without a reset, the ticket of a previous test completed the "incomplete" link of the next one, and the result depended on the order.
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
    // A Writer sharing link is not a CloudServ link: the two ways of opening must not trigger each other.
    expect(readCloudServLink('#session=abc&email=a@b.fr')).toBeNull();
  });

  it('retrouve le billet après un rechargement de la page (F5)', () => {
    expect(readCloudServLink('#token=t1', '/doc/d1')).toEqual({ docId: 'd1', token: 't1' });
    // The fragment has gone from the address, the ticket comes from the tab...
    expect(readCloudServLink('', '/doc/d1')).toEqual({ docId: 'd1', token: 't1' });
    // ... but only for THIS document.
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
    // Caution goes in the most restrictive direction: showing an active toolbar on a document where the server will refuse to write would only produce incomprehensible refusals.
    expect(readTicketClaims(billet({ sub: 'bob', scope: 'administrateur' }))?.permission).toBe(
      'read',
    );
    expect(readTicketClaims(billet({ sub: 'bob' }))?.permission).toBe('read');
  });

  it('se rabat sur l’identifiant quand le nom manque', () => {
    expect(readTicketClaims(billet({ sub: 'carol', scope: 'read' }))?.displayName).toBe('carol');
  });

  it('lit un nom accentué', () => {
    // `atob` returns bytes, not characters: a non-ASCII name decoded without going back through UTF-8 would come out as mojibake.
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
