// Apprendimento dai falsi allarmi di incendio e allagamento, per telecamera.
//
// Quando l'amministratore segna un evento come "falso allarme", si ricorda la zona dell'immagine che aveva scatenato
// l'allerta e di quante volte è successo:
//  - la zona (riquadro relativo 0..1, con un margine) non conta più nei controlli di quella telecamera: una lampada,
//    un riflesso o una macchia ricorrente non fanno più scattare l'allerta;
//  - ogni falso allarme rende un po' più severa la soglia della telecamera (livello da 0 a MAX_LEVEL): servono più
//    punti "fiamma" e più a lungo, oppure una variazione più ampia e più lunga per l'acqua.
// I dati stanno in <DATA>/hazard-learn.json (nessun segreto).
import fs from 'node:fs';
import path from 'node:path';
import { DATA } from './paths.js';

const FILE = path.join(DATA, 'hazard-learn.json');
export const MAX_LEVEL = 6;
const MAX_REGIONS = 20;
const MARGIN = 0.1;

let data = null;
export let version = 0; // sale a ogni modifica: chi usa i dati sa quando rileggerli

function load() {
  if (data) return data;
  try { data = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { data = {}; }
  return data;
}
function save() {
  version++;
  try { fs.writeFileSync(FILE, JSON.stringify(data, null, 1)); } catch (err) { console.error(`[allerta] apprendimento non salvato: ${err.message}`); }
}

const grow = (b) => {
  const x = Math.max(0, b.x - b.w * MARGIN), y = Math.max(0, b.y - b.h * MARGIN);
  return { x, y, w: Math.min(1 - x, b.w * (1 + 2 * MARGIN)), h: Math.min(1 - y, b.h * (1 + 2 * MARGIN)) };
};
const overlapArea = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
const union = (a, b) => {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};

/** Registra un falso allarme di tipo `kind` ('fire' | 'flood') su `camId`; `bbox` = zona relativa che lo ha scatenato. */
export function report(camId, kind, bbox) {
  if (kind !== 'fire' && kind !== 'flood') return;
  const d = load();
  const c = (d[camId] ||= { fire: { level: 0, regions: [] }, flood: { level: 0, regions: [] } });
  const k = c[kind];
  k.level = Math.min(MAX_LEVEL, (k.level || 0) + 1);
  if (bbox && [bbox.x, bbox.y, bbox.w, bbox.h].every(Number.isFinite)) {
    const g = grow(bbox);
    const same = k.regions.find((r) => overlapArea(r, g) >= 0.5 * Math.min(r.w * r.h, g.w * g.h));
    if (same) Object.assign(same, union(same, g), { n: (same.n || 1) + 1 });
    else { k.regions.push({ ...g, n: 1 }); if (k.regions.length > MAX_REGIONS) k.regions.shift(); }
  }
  save();
}

/** { fire: { level, regions }, flood: { level, regions } } oppure null se la telecamera non ha falsi allarmi. */
export const get = (camId) => load()[camId] || null;

/** Dimentica quanto appreso su una telecamera (o su tutte). */
export function reset(camId = null) {
  const d = load();
  if (camId) delete d[camId]; else for (const k of Object.keys(d)) delete d[k];
  save();
}
