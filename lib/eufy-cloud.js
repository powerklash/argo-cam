// Sveglia delle telecamere Eufy a batteria assistita dal cloud.
//
// Le SoloCam addormentate non rispondono in rete locale: l'app Eufy le sveglia facendo passare una richiesta dai
// server P2P di Eufy (che hanno un collegamento a basso consumo con la telecamera). Qui si manda la stessa richiesta
// (LOOKUP_WITH_KEY / LOOKUP_WITH_KEY2, UDP 32100); poi la telecamera risponde anche in rete locale e il normale
// collegamento locale (lib/eufy.js) parte da solo. Il VIDEO resta sempre locale: dal cloud passa solo la sveglia.
//
// Servono due file in DATA, creati da tools/eufy-login/login.mjs:
//  - eufy-cloud.json: per ogni stazione DID, server P2P e chiave temporanea (dsk, dura ~30 minuti)
//  - eufy-session.json: token di accesso (NON la password) per rinnovare la chiave con tools/eufy-login/dsk.mjs
import dgram from 'node:dgram';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DATA, ROOT } from './paths.js';

const CLOUD_FILE = path.join(DATA, 'eufy-cloud.json');
const SESSION_FILE = path.join(DATA, 'eufy-session.json');
const TOOL_DIR = path.join(ROOT, 'tools', 'eufy-login');
const RENEW_MARGIN_MS = 4 * 60 * 1000; // si rinnova quando mancano meno di 4 minuti alla scadenza
const CLOUD_PORT = 32100;

let cache = { mtime: 0, data: null };
function load() {
  try {
    const mtime = fs.statSync(CLOUD_FILE).mtimeMs;
    if (mtime !== cache.mtime) cache = { mtime, data: JSON.parse(fs.readFileSync(CLOUD_FILE, 'utf8')) };
  } catch {
    cache = { mtime: 0, data: null };
  }
  return cache.data;
}
const entryOf = (serial) => load()?.stations?.[serial] || null;
const keyLeftMs = (e) => (e?.dsk && e.dskExpires ? e.dskExpires - Date.now() : -1);

/** Vero se per questa stazione ci sono i dati della sveglia dal cloud (server e DID). */
export const hasCloudData = (serial) => !!entryOf(serial)?.servers?.length && !!entryOf(serial)?.did;

/** Stato per le impostazioni/diagnostica: nessun segreto. */
export function status() {
  const stations = load()?.stations || {};
  let tokenExpires = null;
  try { tokenExpires = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')).tokenExpiration || null; } catch { /* nessuna sessione */ }
  const session = fs.existsSync(SESSION_FILE) && fs.existsSync(path.join(TOOL_DIR, 'node_modules')) && (!tokenExpires || tokenExpires > Date.now());
  return {
    data: Object.keys(stations).length > 0,
    session,
    tokenExpires: session ? tokenExpires : null,
    stations: Object.fromEntries(Object.entries(stations).map(([sn, e]) => [sn, { keyMinutesLeft: Math.round(keyLeftMs(e) / 60000) }])),
  };
}

/** Toglie l'accesso al cloud (token e chiavi di sveglia); eufy-account.json resta: il video locale non ne dipende. */
export function disconnect() {
  for (const f of [SESSION_FILE, CLOUD_FILE]) fs.rmSync(f, { force: true });
  cache = { mtime: 0, data: null };
}

let refreshing = null;
/** Rinnova le chiavi con la sessione salvata (un solo processo alla volta). Risolve { ok, needLogin, message }. */
function refreshKeys() {
  if (refreshing) return refreshing;
  refreshing = new Promise((resolve) => {
    if (!fs.existsSync(SESSION_FILE) || !fs.existsSync(path.join(TOOL_DIR, 'node_modules'))) {
      return resolve({ ok: false, needLogin: true, message: 'sessione Eufy non configurata (esegui tools/eufy-login/login.mjs)' });
    }
    let out = '';
    const child = spawn(process.execPath, ['dsk.mjs'], { cwd: TOOL_DIR, env: { ...process.env, DATA_DIR: DATA }, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => child.kill(), 40000);
    child.stdout.on('data', (b) => { out += b; });
    child.stderr.on('data', (b) => { out += b; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, needLogin: false, message: e.message }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, needLogin: code === 2, message: out.trim().split('\n').pop() || `codice ${code}` });
    });
  }).finally(() => { refreshing = null; });
  return refreshing;
}

// ---------- pacchetti ----------
const padded = (s, n) => { const b = Buffer.from(s); const r = Buffer.alloc(b.length < n ? n : Math.ceil(b.length / n) * n); b.copy(r); return r; };
function didBuffer(did) {
  const [a, b, c] = did.split('-');
  const num = Buffer.allocUnsafe(4);
  num.writeUInt32BE(Number.parseInt(b, 10), 0);
  return Buffer.concat([padded(a, 8), num, padded(c, 8)], 20);
}
const frame = (type, payload) => {
  const len = Buffer.allocUnsafe(2);
  len.writeUInt16BE(payload.length, 0);
  return Buffer.concat([Buffer.from([0xf1, type]), len, payload]);
};
const localIp = () => {
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) if (a.family === 'IPv4' && !a.internal) return a.address;
  return '0.0.0.0';
};
function lookupPackets(entry, port) {
  const did = didBuffer(entry.did);
  const key = Buffer.from(entry.dsk);
  const p = Buffer.allocUnsafe(2);
  p.writeUInt16LE(port, 0);
  const ip = Buffer.from(localIp().split('.').reverse().map(Number));
  const one = Buffer.concat([did, Buffer.from([0, 2]), p, ip, Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 2, 4, 0, 0]), key, Buffer.alloc(4)]);
  const two = Buffer.concat([did, key, Buffer.alloc(4)]);
  return [frame(0x26, one), frame(0x6a, two)];
}

/**
 * Avvia la sveglia dal cloud per `serial`: rinnova la chiave se serve e manda la richiesta ai server Eufy una volta al
 * secondo, finché non si chiama stop(). Non lancia mai errori: `log(msg)` riceve i problemi (una volta sola).
 * Restituisce null se per questa telecamera non ci sono dati del cloud.
 */
export function startWake(serial, log = () => {}) {
  if (!hasCloudData(serial)) return null;
  let stopped = false;
  let timer = null;
  let sock = null;
  const warned = new Set();
  const warnOnce = (m) => { if (!warned.has(m)) { warned.add(m); log(m); } };
  const stop = () => { stopped = true; clearInterval(timer); try { sock?.close(); } catch { /* già chiuso */ } };

  (async () => {
    if (keyLeftMs(entryOf(serial)) < RENEW_MARGIN_MS) {
      const r = await refreshKeys();
      if (!r.ok) warnOnce(`chiave di sveglia non rinnovata: ${r.message}${r.needLogin ? ' → serve rifare l\'accesso (tools/eufy-login/login.mjs)' : ''}`);
    }
    if (stopped) return;
    if (keyLeftMs(entryOf(serial)) <= 0) return warnOnce('chiave di sveglia scaduta: la sveglia dal cloud non è possibile');
    sock = dgram.createSocket('udp4');
    sock.on('error', () => {});
    sock.on('message', () => {}); // le risposte dei server non servono: la telecamera risponderà in rete locale
    await new Promise((r) => sock.bind(0, r));
    const send = () => {
      const e = entryOf(serial);
      if (stopped || !e || keyLeftMs(e) <= 0) return;
      const packets = lookupPackets(e, sock.address().port);
      for (const host of e.servers) for (const pkt of packets) sock.send(pkt, CLOUD_PORT, host, () => {});
    };
    send();
    timer = setInterval(send, 1000);
  })().catch((e) => warnOnce(`sveglia dal cloud: ${e.message}`));

  return { stop };
}
