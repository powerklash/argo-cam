// Genera public/mdi.json: le icone monocromatiche di Home Assistant (Material Design Icons, Pictogrammers, licenza
// Apache-2.0) con nome, parole chiave e tracciato SVG. Home Assistant usa lo stesso insieme ("mdi:nome").
//   cd <cartella-temporanea> && npm install @mdi/svg
//   node tools/make-mdi.mjs <cartella-temporanea>/node_modules/@mdi/svg
// Formato: { v: 1, mdi: "7.4.47", icons: [[nome, tracciato, "parole chiave"], ...] } con i nomi in ordine alfabetico.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const src = process.argv[2];
if (!src) { console.error('Uso: node tools/make-mdi.mjs <cartella di @mdi/svg>'); process.exit(1); }
const meta = JSON.parse(fs.readFileSync(path.join(src, 'meta.json'), 'utf8'));
const version = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8')).version;
const icons = [];
for (const m of meta) {
  if (m.deprecated) continue;
  const file = path.join(src, 'svg', `${m.name}.svg`);
  if (!fs.existsSync(file)) continue;
  const d = /<path d="([^"]+)"/.exec(fs.readFileSync(file, 'utf8'))?.[1];
  if (!d) continue;
  // parole chiave: sinonimi e categorie ("Home Automation", "Weather"…), in minuscolo e senza ripetizioni
  const words = [...new Set([...(m.aliases || []), ...(m.tags || [])].flatMap((x) => String(x).toLowerCase().split(/[\s/,-]+/)).filter((w) => w && w.length > 1))];
  icons.push([m.name, d.replace(/\s+/g, ' ').trim(), words.join(' ')]);
}
icons.sort((a, b) => (a[0] < b[0] ? -1 : 1));
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'mdi.json');
fs.writeFileSync(out, JSON.stringify({ v: 1, mdi: version, icons }));
console.log(`${icons.length} icone, ${(fs.statSync(out).size / 1024 / 1024).toFixed(2)} MB -> ${out}`);
