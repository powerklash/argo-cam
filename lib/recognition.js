// Riconoscimento di volti e mezzi sulle istantanee degli eventi. Tutto in locale.
//
//  - YOLOX-S (OpenCV Zoo): trova persone, veicoli e animali nell'immagine;
//  - tipo e colore del mezzo: dalla classe rilevata e dai pixel della carrozzeria;
//  - YuNet + SFace (OpenCV Zoo): trova il volto, lo allinea e ne calcola l'impronta (128 numeri);
//    l'impronta si confronta con quelle già nel database e l'evento prende il nome della persona,
//    oppure nasce una nuova persona ancora senza nome da identificare nell'interfaccia.
//
// Runtime: onnxruntime-web (WebAssembly, nessuno script di installazione). I modelli stanno in
// data/models (si scaricano con tools/get-models.mjs). Le immagini si leggono con ffmpeg.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as db from './db.js';
import { bus } from './events.js';
import { getSettings } from './settings.js';
import { DATA } from './paths.js';

export const MODELS_DIR = path.join(DATA, 'models');
const FILES = {
  yolox: 'object_detection_yolox_2022nov.onnx',
  yunet: 'face_detection_yunet_2023mar.onnx',
  sface: 'face_recognition_sface_2021dec.onnx',
  mobilenet: 'image_classification_mobilenetv2_2022apr.onnx', // facoltativo: impronta dei singoli animali
};
const REQUIRED = ['yolox', 'yunet', 'sface'];
const modelPath = (k) => path.join(MODELS_DIR, FILES[k]);

// ---------- stato ----------
let ort = null;
const sessions = {};
let loadError = null;

async function runtime() {
  if (ort) return ort;
  try {
    ort = await import('onnxruntime-web');
    ort.env.wasm.numThreads = Math.max(1, Math.min(4, (await import('node:os')).cpus().length - 1));
    ort.env.logLevel = 'error';
  } catch (err) {
    loadError = `onnxruntime-web non installato (${err.code || err.message})`;
    throw new Error(loadError);
  }
  return ort;
}

async function session(key) {
  if (sessions[key]) return sessions[key];
  const lib = await runtime();
  if (!fs.existsSync(modelPath(key))) throw new Error(`modello mancante: ${FILES[key]}`);
  sessions[key] = await lib.InferenceSession.create(fs.readFileSync(modelPath(key)), { executionProviders: ['wasm'], graphOptimizationLevel: 'all', logSeverityLevel: 4 });
  return sessions[key];
}

export async function status() {
  const models = Object.fromEntries(Object.keys(FILES).map((k) => [k, fs.existsSync(modelPath(k))]));
  let runtimeOk = !!ort;
  if (!ort) { try { await runtime(); runtimeOk = true; } catch { runtimeOk = false; } }
  return {
    ready: runtimeOk && REQUIRED.every((k) => models[k]),
    pets: runtimeOk && models.mobilenet && models.yolox, // riconoscimento dei singoli animali disponibile
    runtime: runtimeOk, models, error: runtimeOk ? null : loadError,
  };
}

// ---------- immagini (ffmpeg → pixel RGB) ----------
function ffmpegRaw(args) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-v', 'error', ...args, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-frames:v', '1', '-'], { windowsHide: true });
    const chunks = [];
    let err = '';
    p.stdout.on('data', (c) => chunks.push(c));
    p.stderr.on('data', (c) => (err += c));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`ffmpeg: ${err.slice(0, 200)}`))));
  });
}

function jpegSize(buf) {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const m = buf[i + 1];
    if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    i += 2 + buf.readUInt16BE(i + 2);
  }
  throw new Error('JPEG non valido');
}

/** Regione (x, y, w, h in pixel dell'originale) → RGB inserita in un quadrato `size` (bordi grigi). */
async function letterbox(file, region, size) {
  const r = region;
  const crop = r ? `crop=${Math.round(r.w)}:${Math.round(r.h)}:${Math.round(r.x)}:${Math.round(r.y)},` : '';
  const rgb = await ffmpegRaw(['-i', file, '-vf', `${crop}scale=${size}:${size}:force_original_aspect_ratio=decrease,pad=${size}:${size}:(ow-iw)/2:(oh-ih)/2:color=0x727272`]);
  const rw = r ? r.w : null;
  return { rgb, size, region: r, rw };
}

// Fattore di scala e scostamento del letterbox, per riportare i riquadri nell'immagine originale.
function lbGeometry(srcW, srcH, size) {
  const scale = Math.min(size / srcW, size / srcH);
  return { scale, padX: (size - srcW * scale) / 2, padY: (size - srcH * scale) / 2 };
}

// ---------- utilità di rilevamento ----------
function iou(a, b) {
  const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return inter / (a.w * a.h + b.w * b.h - inter + 1e-9);
}
function nms(items, thr) {
  const out = [];
  for (const it of [...items].sort((a, b) => b.score - a.score)) {
    if (out.every((o) => o.cls !== it.cls || iou(o, it) < thr)) out.push(it);
  }
  return out;
}

// ---------- YOLOX: persone, veicoli, animali ----------
const COCO = { 0: 'person', 1: 'bicycle', 2: 'car', 3: 'motorcycle', 5: 'bus', 7: 'truck', 15: 'cat', 16: 'dog' };
const VEHICLE_CLASSES = new Set(['bicycle', 'car', 'motorcycle', 'bus', 'truck']);

async function detectObjects(file, size, minScore = 0.35) {
  const { rgb } = await letterbox(file, null, 640);
  return inferObjects(rgb, size, minScore);
}

/** YOLOX su un'immagine già ridotta a 640×640 (letterbox) proveniente da un'immagine `size` (w, h). */
async function inferObjects(rgb, size, minScore = 0.35) {
  const s = await session('yolox');
  const N = 640;
  const plane = N * N;
  const input = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) { // RGB -> BGR, piano per piano, 0..255
    input[i] = rgb[i * 3 + 2];
    input[plane + i] = rgb[i * 3 + 1];
    input[2 * plane + i] = rgb[i * 3];
  }
  const out = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, N, N]) });
  const d = out[s.outputNames[0]].data; // [8400, 85]: cx, cy, w, h, obj, 80 classi (già con sigmoide)
  const { scale, padX, padY } = lbGeometry(size.w, size.h, N);
  const found = [];
  let o = 0;
  for (const stride of [8, 16, 32]) {
    const n = N / stride;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++, o += 85) {
        const obj = d[o + 4];
        if (obj < 0.2) continue;
        for (const [id, name] of Object.entries(COCO)) {
          const score = obj * d[o + 5 + Number(id)];
          if (score < minScore) continue;
          const cx = (d[o] + x) * stride, cy = (d[o + 1] + y) * stride;
          const w = Math.exp(d[o + 2]) * stride, h = Math.exp(d[o + 3]) * stride;
          found.push({ cls: name, score, x: (cx - w / 2 - padX) / scale, y: (cy - h / 2 - padY) / scale, w: w / scale, h: h / scale });
        }
      }
    }
  }
  return nms(found, 0.45).map((b) => ({
    ...b,
    x: Math.max(0, b.x), y: Math.max(0, b.y),
    w: Math.min(size.w - Math.max(0, b.x), b.w), h: Math.min(size.h - Math.max(0, b.y), b.h),
  }));
}

// ---------- colore del mezzo ----------
function classifyPixel(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const v = max / 255, sat = max === 0 ? 0 : (max - min) / max;
  if (v < 0.2) return 'black';
  if (sat < 0.2) return v > 0.75 ? 'white' : v > 0.5 ? 'silver' : v > 0.3 ? 'grey' : 'black';
  let h;
  const dlt = max - min;
  if (max === r) h = ((g - b) / dlt) % 6;
  else if (max === g) h = (b - r) / dlt + 2;
  else h = (r - g) / dlt + 4;
  h = (h * 60 + 360) % 360;
  if (h < 15 || h >= 345) return 'red';
  if (h < 40) return v < 0.55 ? 'brown' : 'orange';
  if (h < 70) return v < 0.45 ? 'brown' : 'yellow';
  if (h < 170) return 'green';
  if (h < 260) return 'blue';
  return h < 300 ? 'blue' : 'red';
}

async function vehicleColor(file, box) {
  // Zona della carrozzeria: centro del riquadro, senza tetto e vetri in alto né asfalto in basso.
  const region = { x: box.x + box.w * 0.15, y: box.y + box.h * 0.35, w: box.w * 0.7, h: box.h * 0.5 };
  if (region.w < 8 || region.h < 8) return null;
  const W = 48, H = 32;
  const rgb = await ffmpegRaw(['-i', file, '-vf', `crop=${Math.round(region.w)}:${Math.round(region.h)}:${Math.round(region.x)}:${Math.round(region.y)},scale=${W}:${H}`]);
  const votes = {};
  for (let i = 0; i + 2 < rgb.length; i += 3) {
    const c = classifyPixel(rgb[i], rgb[i + 1], rgb[i + 2]);
    votes[c] = (votes[c] || 0) + 1;
  }
  return Object.entries(votes).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
}

// ---------- volti: YuNet + SFace ----------
const TEMPLATE = [[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366], [41.5493, 92.3655], [70.7299, 92.2041]];

async function detectFaces(file, region, size) {
  const s = await session('yunet');
  const N = 640;
  const srcW = region ? region.w : size.w, srcH = region ? region.h : size.h;
  const { rgb } = await letterbox(file, region, N);
  const plane = N * N;
  const input = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    input[i] = rgb[i * 3 + 2];
    input[plane + i] = rgb[i * 3 + 1];
    input[2 * plane + i] = rgb[i * 3];
  }
  const out = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, N, N]) });
  const get = (prefix, stride) => out[s.outputNames.find((n) => n === `${prefix}_${stride}`)].data;
  const { scale, padX, padY } = lbGeometry(srcW, srcH, N);
  const faces = [];
  for (const stride of [8, 16, 32]) {
    const cls = get('cls', stride), obj = get('obj', stride), bbox = get('bbox', stride), kps = get('kps', stride);
    const cols = N / stride;
    for (let idx = 0; idx < cls.length; idx++) {
      const score = Math.sqrt(Math.min(Math.max(cls[idx], 0), 1) * Math.min(Math.max(obj[idx], 0), 1));
      if (score < 0.6) continue;
      const r = Math.floor(idx / cols), c = idx % cols;
      const cx = (c + bbox[idx * 4]) * stride, cy = (r + bbox[idx * 4 + 1]) * stride;
      const w = Math.exp(bbox[idx * 4 + 2]) * stride, h = Math.exp(bbox[idx * 4 + 3]) * stride;
      const pts = [];
      for (let n = 0; n < 5; n++) {
        pts.push([((kps[idx * 10 + 2 * n] + c) * stride - padX) / scale, ((kps[idx * 10 + 2 * n + 1] + r) * stride - padY) / scale]);
      }
      faces.push({ cls: 'face', score, x: (cx - w / 2 - padX) / scale, y: (cy - h / 2 - padY) / scale, w: w / scale, h: h / scale, pts });
    }
  }
  return nms(faces, 0.3);
}

/** Trasformazione di similarità (scala + rotazione + traslazione) dai 5 punti del volto al modello 112×112. */
function similarity(src, dst) {
  const n = src.length;
  const mx = src.reduce((s, p) => s + p[0], 0) / n, my = src.reduce((s, p) => s + p[1], 0) / n;
  const nx = dst.reduce((s, p) => s + p[0], 0) / n, ny = dst.reduce((s, p) => s + p[1], 0) / n;
  let num1 = 0, num2 = 0, den = 0;
  for (let i = 0; i < n; i++) {
    const sx = src[i][0] - mx, sy = src[i][1] - my, dx = dst[i][0] - nx, dy = dst[i][1] - ny;
    num1 += sx * dx + sy * dy;
    num2 += sx * dy - sy * dx;
    den += sx * sx + sy * sy;
  }
  const a = num1 / den, b = num2 / den;
  return { a, b, tx: nx - (a * mx - b * my), ty: ny - (b * mx + a * my) };
}

/** Volto allineato 112×112 (RGB) dai pixel `img` (w×h), con campionamento bilineare. */
function alignFace(img, w, h, pts) {
  const { a, b, tx, ty } = similarity(pts, TEMPLATE);
  const det = a * a + b * b;
  const out = new Float32Array(3 * 112 * 112);
  const plane = 112 * 112;
  for (let v = 0; v < 112; v++) {
    for (let u = 0; u < 112; u++) {
      const x = (a * (u - tx) + b * (v - ty)) / det;
      const y = (-b * (u - tx) + a * (v - ty)) / det;
      const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
      for (let ch = 0; ch < 3; ch++) {
        const px = (xx, yy) => (xx < 0 || yy < 0 || xx >= w || yy >= h ? 0 : img[(yy * w + xx) * 3 + ch]);
        out[ch * plane + v * 112 + u] = (px(x0, y0) * (1 - fx) + px(x0 + 1, y0) * fx) * (1 - fy) + (px(x0, y0 + 1) * (1 - fx) + px(x0 + 1, y0 + 1) * fx) * fy;
      }
    }
  }
  return out;
}

async function embed(aligned) {
  const s = await session('sface');
  const out = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', aligned, [1, 3, 112, 112]) });
  const v = Float32Array.from(out[s.outputNames[0]].data);
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}

const cosine = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

let faceCache = null;
export const invalidateFaces = () => { faceCache = null; };
const knownFaces = () => (faceCache ??= db.allFaces());

// Veicolo: impronta = 1000 uscite di MobileNetV2 (forma) + 11 valori del colore (frazione di pixel per colore).
const COLOR_LIST = ['white', 'black', 'grey', 'silver', 'red', 'orange', 'yellow', 'green', 'blue', 'brown', 'other'];
const VEH_SHAPE = 1000;
const isVehicleSpecies = (s) => VEHICLE_CLASSES.has(s);

/** Somiglianza: coseno per volti e animali; per i veicoli 70% forma + 30% colore. */
function similarity2(a, b, species) {
  if (!isVehicleSpecies(species)) return cosine(a, b);
  let sh = 0, ca = 0, cb = 0, cc = 0;
  for (let i = 0; i < VEH_SHAPE; i++) sh += a[i] * b[i];
  for (let i = VEH_SHAPE; i < a.length; i++) { ca += a[i] * a[i]; cb += b[i] * b[i]; cc += a[i] * b[i]; }
  const col = ca && cb ? cc / Math.sqrt(ca * cb) : 0;
  return 0.7 * sh + 0.3 * col;
}

function bestMatch(vec, species = null) {
  let best = { sim: -1, personId: null };
  for (const f of knownFaces()) {
    if ((f.species ?? null) !== species || f.embedding.length !== vec.length) continue; // volti con volti, animali/veicoli della stessa specie
    const sim = similarity2(vec, f.embedding, species);
    if (sim > best.sim) best = { sim, personId: f.personId };
  }
  return best;
}

/** Nuovo soggetto non riconosciuto: se somiglia a uno già presente (ma sotto la soglia) lo si segnala come suggerimento. */
const SUGGEST_MARGIN = 0.14;
function suggestSimilar(newId, match, threshold) {
  if (!getSettings().recognition.suggest) return;
  if (match.personId != null && match.sim >= threshold - SUGGEST_MARGIN && match.sim < threshold) db.setSuggestion(newId, match.personId, +match.sim.toFixed(3));
}

async function saveCrop(file, box, ts, tag) {
  const m = 0.35;
  const x = Math.max(0, box.x - box.w * m), y = Math.max(0, box.y - box.h * m);
  const rel = `faces/${ts}_${tag}.jpg`;
  fs.mkdirSync(path.join(db.EVENTS_DIR, 'faces'), { recursive: true });
  await new Promise((resolve) => {
    const p = spawn('ffmpeg', ['-v', 'error', '-y', '-i', file, '-vf', `crop=${Math.round(box.w * (1 + 2 * m))}:${Math.round(box.h * (1 + 2 * m))}:${Math.round(x)}:${Math.round(y)},scale=128:128`, '-frames:v', '1', path.join(db.EVENTS_DIR, rel)], { windowsHide: true });
    p.on('close', resolve);
    p.on('error', resolve);
  });
  return fs.existsSync(path.join(db.EVENTS_DIR, rel)) ? rel : null;
}

/** Cerca il volto di una persona (riquadro `person`) e restituisce { personId, sim } oppure null. */
async function recogniseFace(file, size, person, event, threshold) {
  // Prima testa e spalle (il volto è più grande e a risoluzione piena), poi la persona intera
  // (ritratti ravvicinati), infine l'intera immagine.
  const pad = 0.1;
  const fit = (x, y, w, h) => {
    const r = { x: Math.max(0, x), y: Math.max(0, y) };
    r.w = Math.min(w, size.w - r.x);
    r.h = Math.min(h, size.h - r.y);
    return r;
  };
  const regions = [
    fit(person.x - person.w * pad, person.y - person.h * 0.05, person.w * (1 + 2 * pad), person.h * 0.55),
    fit(person.x - person.w * pad, person.y - person.h * pad, person.w * (1 + 2 * pad), person.h * (1 + 2 * pad)),
    fit(0, 0, size.w, size.h),
  ].filter((r) => r.w >= 40 && r.h >= 40);
  let region = null;
  let face = null;
  for (const r of regions) {
    const found = (await detectFaces(file, r, size)).filter((f) => f.w > 18).sort((a, b) => b.score * b.w - a.score * a.w)[0];
    if (found) { region = r; face = found; break; }
  }
  if (!face) return null;
  // Pixel della regione a risoluzione piena (limitata a 1024 px per lato) per l'allineamento.
  const maxSide = Math.max(region.w, region.h);
  const k = Math.min(1, 1024 / maxSide);
  const W = Math.round(region.w * k), H = Math.round(region.h * k);
  const rgb = await ffmpegRaw(['-i', file, '-vf', `crop=${Math.round(region.w)}:${Math.round(region.h)}:${Math.round(region.x)}:${Math.round(region.y)},scale=${W}:${H}`]);
  const pts = face.pts.map(([x, y]) => [x * k, y * k]);
  const vec = await embed(alignFace(rgb, W, H, pts));
  const match = bestMatch(vec);
  let personId = match.sim >= threshold ? match.personId : null;
  if (personId == null) { personId = db.createPerson(null); suggestSimilar(personId, match, threshold); } // persona nuova, ancora senza nome
  const abs = { x: region.x + face.x, y: region.y + face.y, w: face.w, h: face.h };
  const crop = await saveCrop(file, abs, event.ts, event.id);
  db.insertFace({ personId, eventId: event.id, embedding: vec, crop, ts: event.ts });
  invalidateFaces();
  return { personId, sim: match.sim };
}

// ---------- animali ----------
// Come per i volti: dell'animale ritagliato si calcola un'impronta (qui da MobileNetV2: le 1000 uscite, centrate e
// normalizzate) e si confronta con quelle già note della stessa specie; se nessuna somiglia abbastanza nasce un nuovo
// animale, ancora senza nome, a cui dare il nome dalla scheda Persone. Distingue bene animali diversi per aspetto
// (colore, taglia, pelo); due animali quasi identici possono essere confusi: la soglia è regolabile nelle impostazioni.
const ANIMAL_CLASSES = new Set(['cat', 'dog', 'bird', 'horse', 'sheep', 'cow']);
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

function mainAnimal(objects) {
  return objects
    .filter((o) => ANIMAL_CLASSES.has(o.cls) && o.score >= 0.4 && o.w * o.h > 40 * 40)
    .sort((a, b) => b.w * b.h * b.score - a.w * a.h * a.score)[0];
}

async function petEmbed(file, size, box) {
  const m = 0.1;
  const x = Math.max(0, Math.round(box.x - box.w * m)), y = Math.max(0, Math.round(box.y - box.h * m));
  const w = Math.max(16, Math.min(size.w - x, Math.round(box.w * (1 + 2 * m))));
  const h = Math.max(16, Math.min(size.h - y, Math.round(box.h * (1 + 2 * m))));
  // Ritaglio → lato corto a 256 → quadrato centrale 224 (come l'addestramento del modello).
  const rgb = await ffmpegRaw(['-i', file, '-vf', `crop=${w}:${h}:${x}:${y},scale=256:256:force_original_aspect_ratio=increase,crop=224:224`]);
  const plane = 224 * 224;
  const input = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) for (let c = 0; c < 3; c++) input[c * plane + i] = (rgb[i * 3 + c] / 255 - MEAN[c]) / STD[c];
  const s = await session('mobilenet');
  const out = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, 224, 224]) });
  const v = Float32Array.from(out[s.outputNames[0]].data);
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  for (let i = 0; i < v.length; i++) v[i] -= mean;
  const norm = Math.hypot(...v) || 1;
  return v.map((e) => e / norm);
}

/** Riconosce (o crea) l'animale del riquadro `animal`; restituisce { petId, species, sim } oppure null. */
async function recognisePet(file, size, animal, event, threshold) {
  const vec = await petEmbed(file, size, animal);
  const species = animal.cls;
  const match = bestMatch(vec, species);
  let petId = match.sim >= threshold ? match.personId : null;
  if (petId == null) { petId = db.createPerson(null, species); suggestSimilar(petId, match, threshold); }
  const crop = await saveCrop(file, animal, event.ts, `${event.id}p`);
  db.insertFace({ personId: petId, eventId: event.id, embedding: vec, crop, ts: event.ts });
  invalidateFaces();
  return { petId, species, sim: match.sim };
}

// ---------- singoli veicoli ----------
/** Frazione di pixel della carrozzeria per colore (vettore di 11 valori, in ordine di COLOR_LIST). */
async function colorVector(file, box) {
  const region = { x: box.x + box.w * 0.15, y: box.y + box.h * 0.35, w: box.w * 0.7, h: box.h * 0.5 };
  const v = new Float32Array(COLOR_LIST.length);
  if (region.w < 8 || region.h < 8) { v[COLOR_LIST.length - 1] = 1; return v; }
  const rgb = await ffmpegRaw(['-i', file, '-vf', `crop=${Math.round(region.w)}:${Math.round(region.h)}:${Math.round(region.x)}:${Math.round(region.y)},scale=48:32`]);
  let n = 0;
  for (let i = 0; i + 2 < rgb.length; i += 3) {
    const idx = COLOR_LIST.indexOf(classifyPixel(rgb[i], rgb[i + 1], rgb[i + 2]));
    v[idx < 0 ? COLOR_LIST.length - 1 : idx]++;
    n++;
  }
  for (let i = 0; i < v.length; i++) v[i] /= n || 1;
  return v;
}

/** Riconosce (o crea) il veicolo del riquadro `vehicle`; restituisce { vehicleId, sim } oppure null. */
async function recogniseVehicle(file, size, vehicle, event, threshold) {
  const shape = await petEmbed(file, size, vehicle); // lunghezza 1000
  const color = await colorVector(file, vehicle);
  const vec = new Float32Array(VEH_SHAPE + color.length);
  vec.set(shape, 0);
  vec.set(color, VEH_SHAPE);
  const species = vehicle.cls;
  const match = bestMatch(vec, species);
  let id = match.sim >= threshold ? match.personId : null;
  if (id == null) { id = db.createPerson(null, species); suggestSimilar(id, match, threshold); }
  const crop = await saveCrop(file, vehicle, event.ts, `${event.id}v`);
  db.insertFace({ personId: id, eventId: event.id, embedding: vec, crop, ts: event.ts });
  invalidateFaces();
  return { vehicleId: id, species, sim: match.sim };
}

// ---------- analisi di un evento ----------
/** Veicolo principale: prima i motorizzati (auto, camion, bus, moto) sicuri, poi il più grande; la bici solo se non c'è altro. */
function mainVehicle(objects) {
  const motor = new Set(['car', 'truck', 'bus', 'motorcycle']);
  const rank = (o) => (motor.has(o.cls) ? 1 : 0);
  return objects
    .filter((o) => VEHICLE_CLASSES.has(o.cls) && o.score >= 0.45 && o.w * o.h > 40 * 40)
    .sort((a, b) => rank(b) - rank(a) || b.w * b.h * b.score - a.w * a.h * a.score)[0];
}

export async function analyze(event, { faces = true, ids = false } = {}) {
  const cfg = getSettings().recognition;
  if (!event.snapshot || (!cfg.faces && !cfg.vehicles && !cfg.pets && !cfg.vehicleIds)) return null;
  const file = path.join(db.EVENTS_DIR, event.snapshot);
  const size = jpegSize(fs.readFileSync(file));
  const objects = await detectObjects(file, size);
  const patch = { meta: { ...(event.meta || {}), objects: objects.map((o) => ({ cls: o.cls, score: +o.score.toFixed(2) })) } };

  if (cfg.vehicles) {
    const vehicle = mainVehicle(objects);
    if (vehicle) {
      patch.vehicleType = vehicle.cls;
      patch.vehicleColor = await vehicleColor(file, vehicle);
    }
  }
  // Un semplice "movimento" (telecamere senza rilevamento AI, es. Eufy) diventa persona o veicolo se l'immagine li mostra.
  if (event.kind === 'motion') {
    if (objects.some((o) => o.cls === 'person' && o.score >= 0.5 && o.h > 60)) patch.kind = 'person';
    else if (objects.some((o) => ANIMAL_CLASSES.has(o.cls) && o.score >= 0.5 && o.w * o.h > 40 * 40)) patch.kind = 'pet';
    else if (patch.vehicleType && objects.some((o) => o.cls === patch.vehicleType && o.score >= 0.5)) patch.kind = 'vehicle';
  }
  if (cfg.faces && faces) {
    const people = objects.filter((o) => o.cls === 'person' && o.h > 60).sort((a, b) => b.w * b.h - a.w * a.h).slice(0, 3);
    for (const person of people) {
      const r = await recogniseFace(file, size, person, event, cfg.faceThreshold).catch((err) => { console.error(`[volti] ${err.message}`); return null; });
      if (r) { patch.personId = r.personId; break; } // l'evento prende la persona più in evidenza
    }
  }
  if (cfg.vehicleIds && (faces || ids) && !event.meta?.vehicle && fs.existsSync(modelPath('mobilenet'))) {
    const vehicle = mainVehicle(objects);
    if (vehicle) {
      const r = await recogniseVehicle(file, size, vehicle, event, cfg.vehicleThreshold).catch((err) => { console.error(`[veicoli] ${err.message}`); return null; });
      if (r) {
        patch.vehicleId = r.vehicleId;
        patch.meta.vehicle = { id: r.vehicleId, species: r.species, sim: +r.sim.toFixed(2) };
      }
    }
  }
  if (cfg.pets && faces && fs.existsSync(modelPath('mobilenet'))) {
    const animal = mainAnimal(objects);
    if (animal) {
      const r = await recognisePet(file, size, animal, event, cfg.petThreshold).catch((err) => { console.error(`[animali] ${err.message}`); return null; });
      if (r) {
        patch.meta.pet = { id: r.petId, species: r.species, sim: +r.sim.toFixed(2) };
        if (patch.personId == null) patch.personId = r.petId; // senza persona riconosciuta, l'evento prende l'animale
      }
    }
  }
  db.updateEvent(event.id, patch);
  bus.emit('event-update', { id: event.id, camId: event.camId, ...patch });
  return patch;
}

// ---------- riquadri che seguono la figura nel filmato ----------
// Per ogni filmato si cercano persone/veicoli/animali a pochi fotogrammi al secondo; i riquadri (coordinate relative
// 0..1) restano in un file a parte e l'interfaccia li disegna in sovraimpressione: nel video non c'è nulla di inciso.
function probeVideo(file) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration', '-of', 'json', file], { windowsHide: true });
    let out = '';
    p.stdout.on('data', (c) => (out += c));
    p.on('error', reject);
    p.on('close', () => {
      try {
        const j = JSON.parse(out);
        resolve({ w: j.streams[0].width, h: j.streams[0].height, duration: Number(j.format.duration) || 0 });
      } catch { reject(new Error('ffprobe: video non leggibile')); }
    });
  });
}

function videoFrames(file, fps) {
  return new Promise((resolve, reject) => {
    const vf = `fps=${fps},scale=640:640:force_original_aspect_ratio=decrease,pad=640:640:(ow-iw)/2:(oh-ih)/2:color=0x727272,format=rgb24`;
    const args = ['-v', 'error', '-i', file, '-an', '-vf', vf, '-f', 'rawvideo', '-'];
    const p = process.platform === 'win32' ? spawn('ffmpeg', args, { windowsHide: true }) : spawn('nice', ['-n', '10', 'ffmpeg', ...args]);
    const chunks = [];
    p.stdout.on('data', (c) => chunks.push(c));
    p.on('error', reject);
    p.on('close', () => {
      const all = Buffer.concat(chunks);
      const n = Math.floor(all.length / (640 * 640 * 3));
      resolve(Array.from({ length: n }, (_, i) => all.subarray(i * 640 * 640 * 3, (i + 1) * 640 * 640 * 3)));
    });
  });
}

const TRACK_LETTER = { person: 'p', bicycle: 'v', car: 'v', motorcycle: 'v', bus: 'v', truck: 'v', cat: 'a', dog: 'a', bird: 'a', horse: 'a', sheep: 'a', cow: 'a' };

export async function trackEvent(eventId) {
  if (!getSettings().recognition.boxes) return null;
  const e = db.getEvent(eventId);
  const rel = e && (e.preview || (!e.archived && e.clip));
  if (!rel || e.tracks) return null;
  const file = path.join(db.EVENTS_DIR, rel);
  if (!fs.existsSync(file)) return null;
  const info = await probeVideo(file);
  // Costo: ~2 s di CPU per fotogramma. Massimo 24 fotogrammi per filmato (≈ 1-3 al secondo); fra l'uno e l'altro il riquadro si interpola.
  const fps = Math.max(0.8, Math.min(3, 24 / Math.max(1, info.duration)));
  const want = e.kind === 'person' || e.kind === 'face' ? ['p'] : e.kind === 'vehicle' ? ['v'] : e.kind === 'pet' ? ['a'] : ['p', 'v', 'a'];
  const frames = await videoFrames(file, fps);
  const boxes = [];
  const r3 = (v) => Math.round(v * 1000) / 1000;
  for (let i = 0; i < frames.length; i++) {
    const found = (await inferObjects(frames[i], info, 0.3))
      .filter((o) => want.includes(TRACK_LETTER[o.cls]) && o.w * o.h > 24 * 24)
      .map((o) => [TRACK_LETTER[o.cls], r3(o.x / info.w), r3(o.y / info.h), r3(o.w / info.w), r3(o.h / info.h)]);
    boxes.push([r3(i / fps), found]);
  }
  const out = rel.replace(/(_p)?\.mp4$/, '_t.json');
  fs.writeFileSync(path.join(db.EVENTS_DIR, out), JSON.stringify({ v: 1, fps, boxes }));
  db.updateEvent(eventId, { tracks: out });
  bus.emit('event-update', { id: eventId, camId: e.camId, tracks: out });
  return out;
}

/** Oggetti (persone, veicoli, animali) in un'immagine JPEG: serve a chi deve escluderli (es. controllo allagamenti). */
export function objectsInJpeg(buf) {
  const run = queue.then(async () => { // in coda: il modello non può girare due volte insieme
    const tmp = path.join(DATA, `tmp-objects-${process.pid}-${Date.now()}.jpg`);
    fs.writeFileSync(tmp, buf);
    try {
      return await detectObjects(tmp, jpegSize(buf), 0.3);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });
  queue = run.catch(() => {});
  return run;
}

// ---------- coda di lavoro ----------
let queue = Promise.resolve();
let pending = 0;
function enqueue(event, opts) {
  pending++;
  queue = queue.then(() => analyze(event, opts)).catch((err) => console.error(`[riconoscimento] ${err.message}`)).finally(() => { pending--; });
}
let pendingTracks = 0;
function enqueueTrack(id) {
  if (pendingTracks >= 12) return; // coda lunga (molti eventi di fila): i riquadri si recuperano più tardi, il riconoscimento ha la precedenza
  pendingTracks++;
  trackChain = trackChain.then(() => runTrackProcess(id)).catch(() => {}).finally(() => { pendingTracks--; });
}
let trackChain = Promise.resolve();
/** Un processo figlio per evento (a bassa priorità su Linux): il server resta reattivo mentre il modello lavora. */
function runTrackProcess(id) {
  return new Promise((resolve) => {
    const script = fileURLToPath(new URL('./track-cli.js', import.meta.url));
    const p = process.platform === 'win32' ? spawn(process.execPath, [script, String(id)], { windowsHide: true }) : spawn('nice', ['-n', '15', process.execPath, script, String(id)]);
    const kill = setTimeout(() => p.kill(), 10 * 60_000);
    p.stderr.on('data', (c) => console.error(String(c).trim()));
    p.on('error', () => { clearTimeout(kill); resolve(); });
    p.on('close', () => {
      clearTimeout(kill);
      const e = db.getEvent(id);
      if (e?.tracks) bus.emit('event-update', { id, camId: e.camId, tracks: e.tracks });
      resolve();
    });
  });
}

export function start() {
  bus.on('stored', (event) => {
    const cfg = getSettings().recognition;
    if ((cfg.faces || cfg.vehicles || cfg.pets || cfg.vehicleIds) && event.snapshot) enqueue(event);
  });
  // Quando l'anteprima di un filmato è pronta si calcolano i riquadri; all'avvio si recuperano quelli mancanti.
  bus.on('preview-ready', ({ id }) => { if (getSettings().recognition.boxes) enqueueTrack(id); });
  setTimeout(() => {
    status().then((st) => { if (st.ready && getSettings().recognition.boxes) for (const r of db.eventsWithoutTracks(60)) enqueueTrack(r.id); }).catch(() => {});
  }, 90_000).unref();
}

/**
 * Analizza gli eventi già salvati (ultimi 200 con immagine). Quelli mai analizzati lo sono per intero;
 * con `again` anche gli altri vengono ricalcolati, ma solo per i veicoli (i volti non si duplicano).
 */
export async function reprocess({ again = false } = {}) {
  const st = await status();
  if (!st.ready) throw new Error('Modelli o runtime non installati');
  const list = db.eventsWithoutRecognition(200);
  let queued = 0;
  for (const e of list) {
    if (!e.meta?.objects) { enqueue(e); queued++; } else if (again) { enqueue(e, { faces: false, ids: true }); queued++; }
  }
  return { queued };
}

export const queueLength = () => pending;

// Funzioni interne esposte solo per i collaudi (tools e prove manuali).
const rawFull = (file, size) => ffmpegRaw(['-i', file, '-vf', `scale=${size.w}:${size.h}`]);
export const __test = { petEmbed, recognisePet, mainAnimal, jpegSize, detectObjects, detectFaces, vehicleColor, alignFace, embed, cosine, rawFull };
