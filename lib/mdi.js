// Icone monocromatiche di Home Assistant (Material Design Icons, "mdi:nome"): tracciati SVG da public/mdi.json,
// generato da tools/make-mdi.mjs. Il file è grande (~2,6 MB): si legge solo quando serve.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './paths.js';

let paths = null;
function load() {
  if (paths) return paths;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'mdi.json'), 'utf8'));
    paths = new Map(j.icons.map((i) => [i[0], i[1]]));
  } catch {
    paths = new Map(); // elenco assente: restano le icone emoji
  }
  return paths;
}

export const isMdi = (icon) => typeof icon === 'string' && /^mdi:[a-z0-9-]+$/.test(icon);
/** Vero se `icon` è un'icona "mdi:nome" che esiste nell'elenco. */
export const exists = (icon) => isMdi(icon) && load().has(icon.slice(4));
/** Tracciato SVG (viewBox 24×24) di "mdi:nome", oppure null (emoji o nome sconosciuto). */
export const pathOf = (icon) => (isMdi(icon) ? load().get(icon.slice(4)) || null : null);
