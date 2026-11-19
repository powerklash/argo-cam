// Eventi delle telecamere: movimento, persone, veicoli, animali, pacchi e campanello.
//
//  - interroga ogni hub/telecamera Reolink (GetEvents) e riconosce il momento in cui uno
//    stato passa da 0 a 1;
//  - invia subito l'evento ai browser aperti (lampo rosso, notifica, popup del campanello);
//  - salva nel database l'evento con istantanea e, se richiesto, un breve filmato;
//  - le telecamere a batteria che dormono NON vengono interrogate: lo farebbe svegliare.
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import * as reolink from './reolink.js';
import * as eufyMotion from './eufy-motion.js';
import * as eufyPush from './eufy-push.js';
import * as archive from './archive.js';
import * as db from './db.js';
import { getSettings } from './settings.js';

export const bus = new EventEmitter();
const POLL_MS = 1500;
const MOTION_DELAY_MS = 3500; // attesa per capire se il movimento è una persona/un veicolo

let ctx = { getCameras: () => [], patchCamera: () => {} };
const state = new Map(); // camId -> stato di rilevamento
const caps = new Map(); // camId -> { battery, doorbell, support }
const blocked = new Map(); // chiave sessione -> timestamp di ripresa
let timer = null;
let clipsRunning = 0;

const st = (id) => {
  if (!state.has(id)) state.set(id, { last: {}, firstPoll: true, sleeping: false, online: true, lastEventAt: {}, aiAt: 0, motionTimer: null });
  return state.get(id);
};

export const getCaps = (id) => caps.get(id) || null;
export const getStatus = (id) => {
  const s = state.get(id);
  return s ? { sleeping: s.sleeping, online: s.online } : null;
};

// ---------- salvataggio ----------
const pad = (n) => String(n).padStart(2, '0');
function eventFile(cam, ts, kind, ext) {
  const d = new Date(ts);
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const name = `${cam.id}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}_${kind}.${ext}`;
  fs.mkdirSync(path.join(db.EVENTS_DIR, day), { recursive: true });
  return { rel: `${day}/${name}`, abs: path.join(db.EVENTS_DIR, day, name) };
}

function fetchFrame(cam) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: '127.0.0.1', port: 1984, path: `/api/frame.jpeg?src=${encodeURIComponent(`${cam.id}_main`)}`, timeout: 15000 },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => (res.statusCode === 200 ? resolve(Buffer.concat(chunks)) : reject(new Error(`HTTP ${res.statusCode}`))));
      },
    );
    req.on('timeout', () => req.destroy(new Error('tempo scaduto')));
    req.on('error', reject);
  });
}

export async function takeSnapshot(cam) {
  if (cam.brand === 'reolink') {
    try { return await reolink.snapshot(cam); } catch { /* ripiego sul flusso video */ }
  }
  return fetchFrame(cam);
}

function recordClip(cam, seconds, abs) {
  return new Promise((resolve) => {
    const args = [
      '-hide_banner', '-loglevel', 'error', '-y', '-rtsp_transport', 'tcp', '-i', `rtsp://127.0.0.1:8554/${cam.id}_main`,
      '-t', String(seconds), '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'copy', '-c:a', 'aac', '-movflags', '+faststart', abs,
    ];
    const p = spawn('ffmpeg', args, { windowsHide: true });
    const kill = setTimeout(() => p.kill(), (seconds + 25) * 1000);
    p.on('close', (code) => {
      clearTimeout(kill);
      resolve(code === 0 && fs.existsSync(abs) && fs.statSync(abs).size > 2000);
    });
    p.on('error', () => resolve(false));
  });
}

// Anteprima leggera di ogni filmato (H.264, larghezza massima 854, bitrate basso): serve alla riproduzione nell'elenco
// eventi (e rende guardabili anche i filmati HEVC). L'originale resta alla massima qualità per il download.
const previewQueue = [];
let previewRunning = false;
function makePreview(event, clipRel) {
  previewQueue.push({ event, clipRel });
  pumpPreviews();
}
function pumpPreviews() {
  if (previewRunning) return;
  const job = previewQueue.shift();
  if (!job) return;
  previewRunning = true;
  const src = path.join(db.EVENTS_DIR, job.clipRel);
  const rel = job.clipRel.replace(/\.mp4$/, '_p.mp4');
  const dst = path.join(db.EVENTS_DIR, rel);
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-map', '0:v:0', '-map', '0:a:0?', '-vf', "scale='min(854,iw)':-2",
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '31', '-pix_fmt', 'yuv420p', '-threads', '1', '-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart', dst];
  const p = process.platform === 'win32' ? spawn('ffmpeg', args, { windowsHide: true }) : spawn('nice', ['-n', '10', 'ffmpeg', ...args]);
  const kill = setTimeout(() => p.kill(), 180000);
  const done = (ok) => {
    clearTimeout(kill);
    if (ok) {
      db.updateEvent(job.event.id, { preview: rel });
      bus.emit('event-update', { id: job.event.id, camId: job.event.camId, preview: rel });
      bus.emit('preview-ready', { id: job.event.id });
    } else fs.rmSync(dst, { force: true });
    previewRunning = false;
    pumpPreviews();
  };
  p.on('close', (code) => done(code === 0 && fs.existsSync(dst) && fs.statSync(dst).size > 1000));
  p.on('error', () => done(false));
}

async function store(cam, kind, ts, meta = null, given = null) {
  const s = getSettings().events;
  if (!s.enabled) return null;
  const event = { ts, camId: cam.id, camName: cam.name, kind, meta };
  const fromPush = meta?.source === 'eufy-push';
  // Telecamera a batteria che ha segnalato l'evento via cloud: non la si sveglia per un'istantanea né per il filmato.
  if (s.snapshot && !(fromPush && cam.battery && !given)) {
    try {
      const f = eventFile(cam, ts, kind, 'jpg');
      const jpg = given || await takeSnapshot(cam);
      fs.writeFileSync(f.abs, jpg);
      event.snapshot = f.rel;
      event.bytes = jpg.length;
    } catch (err) {
      console.error(`[eventi] istantanea di «${cam.name}» non riuscita: ${err.message}`);
    }
  }
  event.id = db.insertEvent(event);
  bus.emit('event', event);
  bus.emit('stored', event); // il riconoscimento (volti, mezzi) si aggancia qui
  if (s.clipSeconds > 0 && clipsRunning < 2 && !(fromPush && cam.battery)) {
    clipsRunning++;
    const f = eventFile(cam, ts, kind, 'mp4');
    recordClip(cam, s.clipSeconds, f.abs)
      .then((ok) => {
        if (!ok) return;
        let clipBytes = 0;
        try { clipBytes = fs.statSync(f.abs).size; } catch { /* dimensione non disponibile */ }
        db.updateEvent(event.id, { clip: f.rel, bytes: (event.bytes || 0) + clipBytes });
        makePreview(event, f.rel);
        bus.emit('event-update', { id: event.id, camId: cam.id, clip: f.rel });
      })
      .finally(() => clipsRunning--);
  }
  return event;
}

// ---------- rilevamento ----------
function shouldFlash(cam, kind) {
  if (kind === 'fire' || kind === 'flood') return true; // gli allarmi lampeggiano sempre
  if (cam.alerts === false || kind === 'visitor') return false;
  const f = getSettings().flash;
  if (f.kinds.includes(kind)) return true;
  // Telecamera senza rilevamento persone: vale il semplice movimento.
  const sup = caps.get(cam.id)?.support;
  return kind === 'motion' && f.motionFallback && !f.kinds.includes('motion') && !(sup?.person || sup?.vehicle || sup?.pet);
}

/**
 * Registra un evento rilevato. `test` = prova da interfaccia (lampo/popup senza salvare);
 * `persist` = prova che salva davvero l'evento (marcato come test) per verificare il database.
 */
export function raise(cam, kind, { test = false, persist = false, meta = null, jpg = null } = {}) {
  const s = st(cam.id);
  const now = Date.now();
  if (kind !== 'motion' && kind !== 'visitor') s.aiAt = now;
  bus.emit('detect', { camId: cam.id, camName: cam.name, kind, ts: now, flash: shouldFlash(cam, kind), test });
  if (kind === 'visitor') bus.emit('visitor', { camId: cam.id, camName: cam.name, ts: now, test, notify: cam.alerts !== false });
  if (test && !persist) return;
  if (cam.saveEvents === false && kind !== 'fire' && kind !== 'flood') return; // l'utente ha escluso questa telecamera dal database
  const cooldown = getSettings().events.cooldown * 1000;
  if (!persist && kind !== 'visitor' && now - (s.lastEventAt[kind] || 0) < cooldown) return;
  s.lastEventAt[kind] = now;
  store(cam, kind, now, test ? { ...(meta || {}), test: true } : meta, jpg).catch((err) => console.error(`[eventi] salvataggio non riuscito: ${err.message}`));
}

function handleStates(cam, res) {
  const s = st(cam.id);
  if (res.sleeping !== s.sleeping || res.online !== s.online) {
    s.sleeping = res.sleeping;
    s.online = res.online;
    bus.emit('status', { camId: cam.id, sleeping: s.sleeping, online: s.online });
  }
  if (res.support) {
    const c = caps.get(cam.id) || {};
    caps.set(cam.id, { ...c, support: res.support, doorbell: c.doorbell || res.support.visitor });
  }
  if (!res.ev) return;
  const first = s.firstPoll;
  s.firstPoll = false;
  for (const kind of Object.keys(res.ev)) {
    const on = res.ev[kind];
    const was = s.last[kind];
    s.last[kind] = on;
    if (first || !on || was) continue; // solo i fronti di salita (0 -> 1), non lo stato iniziale
    if (kind === 'md') {
      const sup = caps.get(cam.id)?.support;
      if (!(sup?.person || sup?.vehicle || sup?.pet)) { raise(cam, 'motion'); continue; }
      // Con il rilevamento AI il movimento puro si salva solo se nessuna persona/veicolo/animale segue.
      const at = Date.now();
      clearTimeout(s.motionTimer);
      s.motionTimer = setTimeout(() => { if (s.aiAt < at - 1000) raise(cam, 'motion'); }, MOTION_DELAY_MS);
    } else {
      raise(cam, kind);
    }
  }
}

async function pollGroup(key, group) {
  if ((blocked.get(key) || 0) > Date.now()) return;
  try {
    const res = await reolink.pollEvents(group[0], group.map((c) => c.params.channel || 1));
    for (const cam of group) handleStates(cam, res[cam.params.channel || 1]);
  } catch (err) {
    if (/Accesso rifiutato/.test(err.message)) blocked.set(key, Date.now() + 5 * 60_000);
  }
}

async function loop() {
  try {
    const groups = new Map();
    for (const cam of ctx.getCameras()) {
      if (cam.brand !== 'reolink' || !cam.params?.host) continue;
      const key = reolink.sessionKey(cam);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(cam);
    }
    await Promise.all([...groups].map(([k, g]) => pollGroup(k, g)));
  } finally {
    timer = setTimeout(loop, POLL_MS);
  }
}

/** Legge batteria/campanello delle telecamere Reolink (una volta, in sottofondo). */
async function detectCapabilities() {
  for (const cam of ctx.getCameras()) {
    if (cam.brand !== 'reolink' || caps.get(cam.id)?.fixed) continue;
    try {
      const c = await reolink.capabilities(cam);
      caps.set(cam.id, { ...(caps.get(cam.id) || {}), ...c, fixed: true });
      if (cam.battery === undefined && c.battery) ctx.patchCamera(cam.id, { battery: true });
    } catch { /* hub non raggiungibile: si riprova al prossimo cambio telecamere */ }
  }
}

// ---------- pulizia ----------
function purge() {
  // Con l'archivio attivo la durata complessiva è quella dell'archivio (0 = per sempre) e vale anche per i filmati
  // archiviati; senza archivio vale la durata degli eventi, e i filmati già in archivio non si toccano mai.
  const arch = archive.isEnabled();
  const days = arch ? archive.keepDays() : getSettings().events.retentionDays;
  const gone = db.purgeEvents(days, { includeArchived: arch });
  for (const rel of gone.local) fs.rm(path.join(db.EVENTS_DIR, rel), { force: true }, () => {});
  for (const rel of gone.remote) archive.remove(rel).catch(() => {});
}

const reconcileEufy = () => eufyMotion.reconcile(ctx.getCameras(), raise, eufyPush.isActive());

export function start(context) {
  ctx = context;
  // Le notifiche push del cloud Eufy diventano eventi; finché arrivano, il movimento non si indovina più dal video.
  eufyPush.start({
    getCameras: () => ctx.getCameras(),
    onEvent: (cam, kind, opts) => raise(cam, kind, opts),
    onState: () => reconcileEufy(),
  });
  loop();
  detectCapabilities();
  reconcileEufy();
  setTimeout(() => { for (const r of db.eventsWithoutPreview(150)) makePreview({ id: r.id }, r.clip); }, 30_000).unref(); // anteprime dei filmati già salvati
  purge();
  setInterval(purge, 6 * 3600_000).unref();
}

export const refresh = () => { reconcileEufy(); return detectCapabilities(); };

export function stop() {
  clearTimeout(timer);
  eufyPush.stop();
  eufyMotion.stopAll();
}

// ---------- canale SSE verso i browser ----------
const clients = new Set(); // { res, canSee }
const send = (type, data) => {
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) {
    // Ogni browser riceve solo gli eventi delle telecamere che può vedere.
    if (data?.camId && !c.canSee(data.camId)) continue;
    c.res.write(msg);
  }
};
for (const type of ['detect', 'visitor', 'status', 'event', 'event-update', 'privacy']) bus.on(type, (d) => send(type, d));

/** canSee(idTelecamera) → true se l'utente collegato può vedere quella telecamera. */
export function sseHandler(req, res, canSee = () => true) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 3000\n\n');
  for (const cam of ctx.getCameras()) {
    const s = getStatus(cam.id);
    if (s && canSee(cam.id)) res.write(`event: status\ndata: ${JSON.stringify({ camId: cam.id, ...s })}\n\n`);
  }
  const client = { res, canSee };
  clients.add(client);
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => { clearInterval(ping); clients.delete(client); });
}
