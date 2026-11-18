// Allerta incendio e allagamento: si guarda il video delle telecamere scelte e si cercano due situazioni anomale.
//
// Non esiste un modello "fiamme/acqua" già pronto che giri in locale su questo server: i controlli sono quindi
// EURISTICI, calcolati sui pixel di un'immagine molto piccola (160×90, 2 fotogrammi al secondo) letta dal flusso
// secondario. Servono come segnale di attenzione, non come rivelatore certificato (non sostituiscono un sensore di
// fumo o di allagamento).
//
//  - FUOCO: punti di colore fiamma (giallo-arancio saturo e luminoso) che occupano una parte sufficiente
//    dell'immagine, SCINTILLANO da un fotogramma all'altro e restano nello stesso posto per qualche secondo.
//    I punti fiamma fissi da tempo (lampioni, tramonto, oggetti arancioni) vengono ignorati; se la zona coincide con
//    una persona o un veicolo (es. giacca arancione) il controllo viene scartato con il rilevatore di oggetti.
//  - ALLAGAMENTO: la metà bassa dell'immagine cambia in modo esteso e COERENTE rispetto alla sua "normalità" (media
//    lenta di circa un'ora) senza che cambi anche la parte alta (che indicherebbe luce) e a lungo (minuti). La zona
//    cambiata non deve essere spiegata da persone o veicoli. Pensato per locali tecnici, cantine, garage; all'aperto
//    la pioggia forte può bastare a farlo scattare.
import { spawn } from 'node:child_process';
import { getSettings } from './settings.js';
import { takeSnapshot } from './events.js';
import * as recognition from './recognition.js';

export const W = 160;
export const H = 90;
export const FPS = 2;

// Soglie per sensibilità 1 (bassa) … 3 (alta).
const FIRE = {
  1: { minRatio: 0.008, flicker: 0.25, need: 7 },
  2: { minRatio: 0.004, flicker: 0.18, need: 6 },
  3: { minRatio: 0.002, flicker: 0.12, need: 5 },
};
const FLOOD = {
  1: { changed: 0.45, holdSec: 240 },
  2: { changed: 0.35, holdSec: 150 },
  3: { changed: 0.25, holdSec: 90 },
};
const FIRE_WINDOW = 10;
const MAX_RATIO = 0.4; // oltre è un cambio di scena, non una fiamma
const CELL = 10;       // lato in pixel delle celle di controllo dell'acqua
const GX = W / CELL;
const GY = H / CELL;
const LOW_FROM = 4;    // celle dalla riga 4 in giù = "pavimento"

const isFlame = (r, g, b) => r >= 165 && r > g + 15 && g > b + 10 && r - b >= 95 && g >= 70 && (r - b) / r >= 0.45;

/**
 * Analizzatore di una telecamera. `feed(rgb, now)` (rgb = W*H*3 byte, `now` in secondi) restituisce
 * `null` oppure un candidato `{ kind: 'fire'|'flood', bbox, cells }` da verificare e poi confermare con `confirm(kind, ok)`.
 */
export function makeAnalyzer(cfg) {
  const a = {
    cfg, // { fire, flood, sensitivity }
    ema: new Float32Array(W * H),
    prevMask: null,
    hist: [],
    lastBox: null,
    fireUntil: 0,
    base: null,         // luminosità media di riferimento per cella
    baseFrames: 0,
    acc: null,
    floodSince: 0,
    floodUntil: 0,
    floodTick: 0,
  };

  a.feed = (rgb, now) => {
    const sens = a.cfg.sensitivity || 2;
    let out = null;
    if (a.cfg.fire && now >= a.fireUntil) out = fireStep(a, rgb, FIRE[sens]);
    if (!out && a.cfg.flood && now >= a.floodUntil) out = floodStep(a, rgb, now, FLOOD[sens]);
    return out;
  };

  /** Esito della verifica di un candidato: se confermato, nuova segnalazione solo dopo `quietSec`. */
  a.confirm = (kind, ok, now, quietSec = 600) => {
    if (kind === 'fire') {
      a.hist = [];
      if (ok) a.fireUntil = now + quietSec; else a.fireUntil = now + 20;
    } else {
      a.floodSince = 0;
      if (ok) a.floodUntil = now + quietSec;
      else { a.base = null; a.baseFrames = 0; a.floodUntil = now + 60; } // spiegato da persone/veicoli: la nuova scena è la normalità
    }
  };
  return a;
}

function fireStep(a, rgb, p) {
  const n = W * H;
  const mask = new Uint8Array(n);
  let count = 0, sx = 0, sy = 0, x0 = W, y0 = H, x1 = 0, y1 = 0;
  for (let i = 0, o = 0; i < n; i++, o += 3) {
    const raw = isFlame(rgb[o], rgb[o + 1], rgb[o + 2]) ? 1 : 0;
    a.ema[i] = a.ema[i] * 0.98 + raw * 0.02;
    if (raw && a.ema[i] < 0.8) { // i punti arancioni "da sempre" non contano
      mask[i] = 1;
      count++;
      const x = i % W, y = (i / W) | 0;
      sx += x; sy += y;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  let hit = false;
  const ratio = count / n;
  const prev = a.prevMask;
  a.prevMask = mask;
  if (prev && ratio >= p.minRatio && ratio <= MAX_RATIO) {
    let xor = 0, union = 0;
    for (let i = 0; i < n; i++) { if (mask[i] !== prev[i]) xor++; if (mask[i] || prev[i]) union++; }
    const flicker = union ? xor / union : 0;
    const cx = sx / count, cy = sy / count;
    const still = !a.lastBox || (Math.abs(cx - a.lastBox.cx) < W * 0.08 && Math.abs(cy - a.lastBox.cy) < H * 0.08);
    a.lastBox = { cx, cy };
    hit = flicker >= p.flicker && still;
  } else if (ratio < p.minRatio) {
    a.lastBox = null;
  }
  a.hist.push(hit);
  if (a.hist.length > FIRE_WINDOW) a.hist.shift();
  if (a.hist.filter(Boolean).length >= p.need) {
    return { kind: 'fire', bbox: { x: x0 / W, y: y0 / H, w: (x1 - x0 + 1) / W, h: (y1 - y0 + 1) / H } };
  }
  return null;
}

// Luminosità media per cella (16×9). Ogni 4 fotogrammi (2 secondi) si confronta con la normalità.
function cellLuma(rgb) {
  const cells = new Float32Array(GX * GY);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 3;
      cells[((y / CELL) | 0) * GX + ((x / CELL) | 0)] += 0.299 * rgb[o] + 0.587 * rgb[o + 1] + 0.114 * rgb[o + 2];
    }
  }
  for (let i = 0; i < cells.length; i++) cells[i] /= CELL * CELL;
  return cells;
}

function floodStep(a, rgb, now, p) {
  if (++a.floodTick % 4 !== 0) return null;
  const cur = cellLuma(rgb);
  if (!a.base) {
    // Prima normalità: media di 15 letture (30 secondi).
    a.acc = a.acc || new Float32Array(cur.length);
    for (let i = 0; i < cur.length; i++) a.acc[i] += cur[i];
    if (++a.baseFrames >= 15) { a.base = a.acc.map((v) => v / a.baseFrames); a.acc = null; a.baseFrames = 0; }
    return null;
  }
  const changedAt = new Uint8Array(cur.length);
  let low = 0, lowN = 0, up = 0, upN = 0;
  for (let i = 0; i < cur.length; i++) {
    const row = (i / GX) | 0;
    const ch = Math.abs(cur[i] - a.base[i]) > 22 ? 1 : 0;
    if (row >= LOW_FROM) { lowN++; if (ch) { low++; changedAt[i] = 1; } } else { upN++; up += ch; }
  }
  const fLow = low / lowN, fUp = up / upN;
  const globalLight = fUp > 0.5 * fLow && fUp > 0.15; // cambia anche in alto: è luce (giorno/notte, lampada)
  if (globalLight || fLow < p.changed * 0.6) {
    // Normale o cambio di luce: la normalità segue la scena lentamente (subito se è luce).
    const alpha = globalLight ? 0.2 : 0.01;
    for (let i = 0; i < cur.length; i++) a.base[i] += (cur[i] - a.base[i]) * alpha;
    a.floodSince = 0;
    return null;
  }
  if (fLow < p.changed) return null; // zona grigia: nessun aggiornamento, nessun conteggio
  if (!a.floodSince) a.floodSince = now;
  if (now - a.floodSince < p.holdSec) return null;
  // Coerenza: la zona cambiata deve essere in prevalenza un'unica macchia.
  const comp = largestComponent(changedAt);
  if (comp.size < low * 0.7) return null;
  return { kind: 'flood', changed: changedAt, bbox: { x: comp.x0 / GX, y: comp.y0 / GY, w: (comp.x1 - comp.x0 + 1) / GX, h: (comp.y1 - comp.y0 + 1) / GY } };
}

function largestComponent(cells) {
  const seen = new Uint8Array(cells.length);
  let best = { size: 0, x0: 0, y0: 0, x1: 0, y1: 0 };
  for (let s = 0; s < cells.length; s++) {
    if (!cells[s] || seen[s]) continue;
    const stack = [s];
    seen[s] = 1;
    const c = { size: 0, x0: GX, y0: GY, x1: 0, y1: 0 };
    while (stack.length) {
      const i = stack.pop();
      const x = i % GX, y = (i / GX) | 0;
      c.size++;
      if (x < c.x0) c.x0 = x; if (x > c.x1) c.x1 = x; if (y < c.y0) c.y0 = y; if (y > c.y1) c.y1 = y;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= GX || ny >= GY) continue;
        const j = ny * GX + nx;
        if (cells[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
      }
    }
    if (c.size > best.size) best = c;
  }
  return best;
}

// ---------- controllo del video ----------
const monitors = new Map(); // camId -> { cam, analyzer, proc, timer, stopped, fails, started, busy }
const RETRY_MS = [10_000, 30_000, 60_000];
let raiseFn = () => {};

/** Una persona/un veicolo che copre la zona segnalata spiega il cambiamento: non è un incendio né un allagamento. */
async function explainedByObjects(cam, cand) {
  try {
    const jpg = await takeSnapshot(cam);
    const objects = await recognition.objectsInJpeg(jpg);
    const dims = jpegDims(jpg);
    const boxes = objects.filter((o) => ['person', 'car', 'truck', 'bus', 'motorcycle', 'bicycle'].includes(o.cls))
      .map((o) => ({ x: o.x / dims.w, y: o.y / dims.h, w: o.w / dims.w, h: o.h / dims.h }));
    if (!boxes.length) return false;
    if (cand.kind === 'fire') {
      const f = cand.bbox;
      const area = f.w * f.h;
      return boxes.some((b) => overlap(f, b) / area >= 0.6);
    }
    // Allagamento: celle cambiate meno quelle coperte da persone/veicoli.
    let left = 0, total = 0;
    for (let i = 0; i < cand.changed.length; i++) {
      if (!cand.changed[i]) continue;
      total++;
      const cx = ((i % GX) + 0.5) / GX, cy = (((i / GX) | 0) + 0.5) / GY;
      if (!boxes.some((b) => cx >= b.x && cx <= b.x + b.w && cy >= b.y && cy <= b.y + b.h)) left++;
    }
    const p = FLOOD[getSettings().hazard.sensitivity || 2];
    return left / (GX * (GY - LOW_FROM)) < p.changed * 0.8 || left < total * 0.5;
  } catch {
    return false; // se la verifica non riesce si dà comunque l'allerta
  }
}

function jpegDims(buf) {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const m = buf[i + 1];
    if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return { w: 1, h: 1 };
}
const overlap = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

async function onCandidate(m, cand) {
  if (m.busy) return;
  m.busy = true;
  try {
    const now = Date.now() / 1000;
    const explained = await explainedByObjects(m.cam, cand);
    m.analyzer.confirm(cand.kind, !explained, now);
    if (!explained) {
      console.log(`[allerta] ${cand.kind === 'fire' ? 'Possibile incendio' : 'Possibile allagamento'} su «${m.cam.name}»`);
      raiseFn(m.cam, cand.kind, { meta: { hazard: true, bbox: cand.bbox } });
    }
  } finally {
    m.busy = false;
  }
}

function launch(m) {
  if (m.stopped) return;
  m.started = Date.now();
  const args = [
    '-hide_banner', '-loglevel', 'error', '-rtsp_transport', 'tcp', '-i', `rtsp://127.0.0.1:8554/${m.cam.id}_sub`,
    '-an', '-vf', `fps=${FPS},scale=${W}:${H},format=rgb24`, '-f', 'rawvideo', '-',
  ];
  const p = process.platform === 'win32'
    ? spawn('ffmpeg', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    : spawn('nice', ['-n', '10', 'ffmpeg', ...args], { stdio: ['ignore', 'pipe', 'ignore'] });
  m.proc = p;
  let buf = Buffer.alloc(0);
  const size = W * H * 3;
  p.stdout.on('data', (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= size) {
      const frame = buf.subarray(0, size);
      buf = buf.subarray(size);
      const cand = m.analyzer.feed(frame, Date.now() / 1000);
      if (cand) onCandidate(m, cand).catch((err) => console.error(`[allerta] ${err.message}`));
    }
  });
  p.on('close', () => {
    m.proc = null;
    if (m.stopped) return;
    m.fails = Date.now() - m.started > 60_000 ? 0 : Math.min(m.fails + 1, RETRY_MS.length);
    m.timer = setTimeout(() => launch(m), RETRY_MS[Math.max(0, m.fails - 1)]);
  });
  p.on('error', () => { m.proc = null; });
}

function stopMonitor(m) {
  m.stopped = true;
  clearTimeout(m.timer);
  try { m.proc?.kill(); } catch { /* già chiuso */ }
}

function reconcile(getCameras) {
  const h = getSettings().hazard;
  const wanted = new Map();
  for (const cam of getCameras()) {
    const c = h.cams[cam.id];
    if (c && !cam.battery) wanted.set(cam.id, { cam, cfg: { fire: !!c.fire, flood: !!c.flood, sensitivity: h.sensitivity } });
  }
  for (const [id, m] of monitors) {
    if (wanted.has(id)) continue;
    stopMonitor(m);
    monitors.delete(id);
  }
  for (const [id, w] of wanted) {
    const m = monitors.get(id);
    if (m) { m.cam = w.cam; Object.assign(m.analyzer.cfg, w.cfg); continue; }
    const nm = { cam: w.cam, analyzer: makeAnalyzer(w.cfg), proc: null, timer: null, stopped: false, fails: 0, started: 0, busy: false };
    monitors.set(id, nm);
    launch(nm);
  }
}

export function start(getCameras, raise) {
  raiseFn = raise;
  reconcile(getCameras);
  setInterval(() => reconcile(getCameras), 20_000).unref();
}

export const stopAll = () => { for (const m of monitors.values()) stopMonitor(m); monitors.clear(); };
export const status = () => [...monitors].map(([id, m]) => ({ camId: id, running: !!m.proc, fire: m.analyzer.cfg.fire, flood: m.analyzer.cfg.flood }));
