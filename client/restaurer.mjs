import * as Y from 'yjs';
import { readFileSync, writeFileSync } from 'node:fs';

const [, , chemin, sortie, limiteArg] = process.argv;
const limite = Number(limiteArg);
const data = readFileSync(chemin);
const doc = new Y.Doc();

let pos = 0, n = 0;
while (pos + 4 <= data.length && n < limite) {
  const len = data.readUInt32LE(pos);
  pos += 4;
  Y.applyUpdate(doc, data.subarray(pos, pos + len));
  pos += len;
  n += 1;
}

const body = doc.getXmlFragment('write:body');
const etat = Y.encodeStateAsUpdate(doc);
writeFileSync(sortie, etat);

console.log(JSON.stringify({
  updatesRejouees: n,
  blocs: body.length,
  titre: doc.getMap('write:meta').get('title'),
  extrait: body.toString().replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 160),
  octetsEcrits: etat.length,
}, null, 2));
