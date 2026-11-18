// Elenca i messaggi d'errore del codice (server.js e lib/*.js) che non hanno ancora una traduzione in lib/errors-i18n.js.
//   node tools/check-errors.mjs        (esce con codice 1 se ne mancano)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { isKnown } = await import(pathToFileURL(path.join(root, 'lib', 'errors-i18n.js')).href);
const files = ['server.js', ...fs.readdirSync(path.join(root, 'lib')).filter((f) => f.endsWith('.js')).map((f) => `lib/${f}`)];
const re = /(?:HttpError\(\d+,\s*|new Error\(|new AuthError\([^,]+,\s*)(['`"])((?:(?!\1)[^\\]|\\.)*)\1/g;
// Messaggi tecnici che non arrivano mai all'utente o sono codici (la lingua li gestisce l'interfaccia).
const IGNORE = new Set(['ASLEEP', 'NOT_SUPPORTED', 'illeggibile', 'no_network']);
const IGNORE_RE = [/^HTTP \$\{/, /^ffmpeg: /];
let missing = 0;
for (const f of files) {
  fs.readFileSync(path.join(root, f), 'utf8').split('\n').forEach((line, i) => {
    for (const m of line.matchAll(re)) {
      let msg = m[2].replace(/\\'/g, "'").replace(/\\\\/g, '\\');
      let n = 0;
      msg = msg.replace(/\$\{[^}]*\}/g, () => `{${++n}}`);
      if (IGNORE.has(msg) || IGNORE_RE.some((r) => r.test(m[2])) || isKnown(msg)) continue;
      console.log(`${f}:${i + 1}: ${msg}`);
      missing++;
    }
  });
}
console.log(missing ? `\n${missing} messaggi senza traduzione` : 'Tutti i messaggi hanno una traduzione.');
process.exit(missing ? 1 : 0);
