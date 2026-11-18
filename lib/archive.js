// Archivio degli eventi più vecchi su un percorso di rete (o altro), senza montare nulla nel CT.
//
// I filmati più vecchi di N giorni vengono copiati dal server stesso sull'archivio e cancellati dal CT; il database
// degli eventi resta nel CT, quindi ricerca intelligente ed elenco funzionano come prima. Quando si guarda un filmato
// archiviato il server lo riprende dall'archivio (e lo tiene un po' in una cache locale limitata).
//
// Destinazioni:
//   smb     condivisione di rete Windows/NAS (//server/condivisione): usa il programma `smbclient`
//   webdav  server WebDAV (NAS, Nextcloud…): HTTP/HTTPS, senza programmi esterni
//   folder  cartella già raggiungibile dal CT (per esempio una condivisione montata dal Proxmox)
// Utente e password restano solo sul server (DATA/archive.json, permessi 600) e non tornano mai al browser.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { spawn, spawnSync } from 'node:child_process';
import * as db from './db.js';
import { DATA } from './paths.js';

const FILE = path.join(DATA, 'archive.json');
const CACHE_DIR = path.join(DATA, 'archive-cache');
const CACHE_MAX = 1024 ** 3; // 1 GB di filmati archiviati tenuti in cache dopo la visione
const MARKER = '.cam-app-archive';
export const CLIP_RE = /^\d{4}-\d{2}-\d{2}\/cam_[0-9a-f]{8}_[0-9A-Za-z_]+\.mp4$/;

const DEFAULTS = { driver: '', target: '', user: '', password: '', dir: 'cam-app', insecureTls: false, enabled: false, afterDays: 7, keepDays: 0 };
let cfg = { ...DEFAULTS };
try { cfg = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch { /* non configurato */ }

export const isConfigured = () => !!cfg.driver && !!cfg.target;
export const isEnabled = () => cfg.enabled && isConfigured();
export const keepDays = () => cfg.keepDays;
export const publicConfig = () => { const { password, ...rest } = cfg; return { ...rest, hasPassword: !!password }; };

const int = (v, min, max, def) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : def; };

export function setConfig(input) {
  const i = input || {};
  const driver = String(i.driver || '');
  if (!['', 'smb', 'webdav', 'folder'].includes(driver)) throw new Error('Tipo di archivio non valido');
  let target = String(i.target || '').trim();
  if (driver === 'smb') {
    target = target.replaceAll('\\', '/');
    if (!/^\/\/[A-Za-z0-9._-]+\/[^/\\:*?"<>|]+$/.test(target)) throw new Error('Percorso SMB non valido: usa \\\\server\\condivisione (senza cartelle: la cartella si indica a parte)');
  } else if (driver === 'webdav') {
    let u;
    try { u = new URL(target); } catch { throw new Error('Indirizzo WebDAV non valido (es. https://nas.local/webdav)'); }
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw new Error('Indirizzo WebDAV non valido (es. https://nas.local/webdav)');
    target = u.origin + u.pathname.replace(/\/+$/, '');
  } else if (driver === 'folder') {
    if (!target || target.includes('\0') || !path.isAbsolute(target)) throw new Error('Indica un percorso assoluto (es. /mnt/archivio)');
    if (path.resolve(target) === path.resolve(DATA) || path.resolve(target).startsWith(path.resolve(DATA) + path.sep)) throw new Error('L\'archivio non può stare dentro i dati dell\'app');
  } else target = '';
  const dir = String(i.dir ?? 'cam-app').trim().replace(/^\/+|\/+$/g, '');
  if (dir && !/^[A-Za-z0-9._ -]+(\/[A-Za-z0-9._ -]+)*$/.test(dir)) throw new Error('Cartella non valida: solo lettere, numeri, spazi, punto, trattino e /');
  if (driver && !dir) throw new Error('Indica una cartella di destinazione (es. cam-app)');
  const next = {
    driver, target, dir,
    user: String(i.user || '').trim().slice(0, 100),
    password: typeof i.password === 'string' && i.password !== '' ? i.password.slice(0, 200) : (driver === cfg.driver ? cfg.password : ''),
    insecureTls: !!i.insecureTls,
    enabled: !!i.enabled && !!driver,
    afterDays: int(i.afterDays, 1, 3650, 7),
    keepDays: int(i.keepDays, 0, 36500, 0),
  };
  cfg = next;
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(cfg), { mode: 0o600 });
  return publicConfig();
}

const remotePath = (rel) => `${cfg.dir}/${rel}`;
const checkRel = (rel) => { if (!CLIP_RE.test(rel)) throw new Error('File non valido'); };

// ---------- destinazione: cartella ----------
const folder = {
  base: () => path.join(cfg.target, cfg.dir),
  async ready() {
    // Senza il file-marcatore, la cartella potrebbe essere un punto di montaggio vuoto (condivisione non collegata):
    // scrivere lì riempirebbe il disco del CT.
    if (!fs.existsSync(path.join(cfg.target, MARKER))) throw new Error('Percorso non verificato o condivisione non collegata (usa "Verifica collegamento")');
  },
  async put(abs, rel) {
    const dest = path.join(this.base(), rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(abs, `${dest}.part`);
    if (fs.statSync(`${dest}.part`).size !== fs.statSync(abs).size) { fs.rmSync(`${dest}.part`, { force: true }); throw new Error('Copia incompleta'); }
    fs.renameSync(`${dest}.part`, dest);
  },
  async get(rel, dest) { fs.copyFileSync(path.join(this.base(), rel), dest); },
  async del(rel) { fs.rmSync(path.join(this.base(), rel), { force: true }); },
  async probe() {
    if (!fs.existsSync(cfg.target) || !fs.statSync(cfg.target).isDirectory()) throw new Error('La cartella non esiste (o non è collegata)');
    fs.writeFileSync(path.join(cfg.target, MARKER), 'cam-app archivio\n'); // crea il marcatore: da ora la cartella è "verificata"
    const t = path.join(this.base(), 'prova.txt');
    fs.mkdirSync(this.base(), { recursive: true });
    fs.writeFileSync(t, 'prova');
    if (fs.readFileSync(t, 'utf8') !== 'prova') throw new Error('Lettura non coerente');
    fs.rmSync(t, { force: true });
  },
};

// ---------- destinazione: SMB (smbclient) ----------
function smb(commands, timeout = 120000) {
  return new Promise((resolve, reject) => {
    const args = [cfg.target, '-c', commands];
    if (cfg.user) args.push('-U', cfg.user); else args.push('-N');
    // La password passa dall'ambiente (non dalla riga di comando, dove la vedrebbero gli altri processi).
    const p = spawn('smbclient', args, { env: { ...process.env, PASSWD: cfg.password || '', LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const kill = setTimeout(() => p.kill(), timeout);
    p.stdout.on('data', (c) => (out += c));
    p.stderr.on('data', (c) => (out += c));
    p.on('error', (err) => { clearTimeout(kill); reject(new Error(err.code === 'ENOENT' ? 'smbclient non installato nel CT (apt install smbclient)' : err.message)); });
    p.on('close', (code) => { clearTimeout(kill); resolve({ code, out }); });
  });
}
const smbErr = (out) => /NT_STATUS_[A-Z_]+|session setup failed|Connection to .* failed|protocol negotiation failed/.exec(out)?.[0];
const smbDirs = (relFile) => {
  const parts = remotePath(relFile).split('/'); parts.pop();
  let acc = '';
  return parts.map((p) => `mkdir "${(acc += (acc ? '/' : '') + p)}"`).join('; ');
};
const smb_ = {
  async ready() { /* il collegamento si verifica a ogni operazione */ },
  async put(abs, rel) {
    await smb(smbDirs(rel)); // le cartelle già esistenti danno un avviso: si ignora
    const r = await smb(`put "${abs}" "${remotePath(rel)}"; ls "${remotePath(rel)}"`);
    const bad = smbErr(r.out.replace(/NT_STATUS_OBJECT_NAME_COLLISION/g, ''));
    if (!/putting file/.test(r.out) || bad) throw new Error(`SMB: ${bad || 'copia non riuscita'}`);
    const size = /\s(\d+)\s+(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s/.exec(r.out.split('putting file')[1] || '')?.[1];
    if (size && Number(size) !== fs.statSync(abs).size) throw new Error('SMB: dimensione diversa dopo la copia');
  },
  async get(rel, dest) {
    const r = await smb(`get "${remotePath(rel)}" "${dest}"`);
    if (!/getting file/.test(r.out) || smbErr(r.out)) throw new Error(`SMB: ${smbErr(r.out) || 'lettura non riuscita'}`);
  },
  async del(rel) { await smb(`del "${remotePath(rel)}"`); },
  async probe() {
    const r = await smb('ls');
    const bad = smbErr(r.out);
    if (bad) throw new Error(bad === 'NT_STATUS_LOGON_FAILURE' ? 'Utente o password non accettati' : `SMB: ${bad}`);
    const tmp = path.join(DATA, 'archive-test.txt');
    fs.writeFileSync(tmp, 'prova');
    try {
      const rel = '0000-00-00/prova.txt';
      await smb(smbDirs(rel));
      const w = await smb(`put "${tmp}" "${remotePath(rel)}"; del "${remotePath(rel)}"`);
      if (!/putting file/.test(w.out) || smbErr(w.out)) throw new Error(`SMB: scrittura non riuscita (${smbErr(w.out) || 'errore'})`);
    } finally { fs.rmSync(tmp, { force: true }); }
  },
};

// ---------- destinazione: WebDAV ----------
function dav(method, rel, { headers = {}, upload = null, sink = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(`${cfg.target}/${rel.split('/').map(encodeURIComponent).join('/')}`);
    const h = { ...headers };
    if (cfg.user) h.Authorization = `Basic ${Buffer.from(`${cfg.user}:${cfg.password}`).toString('base64')}`;
    if (upload) h['Content-Length'] = fs.statSync(upload).size;
    const req = (u.protocol === 'https:' ? https : http).request(u, { method, headers: h, rejectUnauthorized: !cfg.insecureTls, timeout: 120000 }, (res) => {
      if (sink && res.statusCode === 200) {
        const w = fs.createWriteStream(sink);
        res.pipe(w);
        w.on('finish', () => resolve({ status: res.statusCode }));
        w.on('error', reject);
        res.on('error', reject);
      } else {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode }));
      }
    });
    req.on('timeout', () => req.destroy(new Error('tempo scaduto')));
    req.on('error', reject);
    if (upload) fs.createReadStream(upload).pipe(req); else req.end();
  });
}
const davDirs = async (relFile) => {
  const parts = remotePath(relFile).split('/'); parts.pop();
  let acc = '';
  for (const p of parts) {
    acc += (acc ? '/' : '') + p;
    const r = await dav('MKCOL', acc);
    if (![200, 201, 301, 405].includes(r.status)) {
      if (r.status === 401 || r.status === 403) throw new Error('WebDAV: utente o password non accettati');
      throw new Error(`WebDAV: cartella non creata (HTTP ${r.status})`);
    }
  }
};
const webdav = {
  async ready() { /* verificato a ogni operazione */ },
  async put(abs, rel) {
    await davDirs(rel);
    const r = await dav('PUT', remotePath(rel), { upload: abs });
    if (![200, 201, 204].includes(r.status)) throw new Error(`WebDAV: copia non riuscita (HTTP ${r.status})`);
    const head = await dav('HEAD', remotePath(rel));
    if (head.status !== 200) throw new Error('WebDAV: file non trovato dopo la copia');
  },
  async get(rel, dest) {
    const r = await dav('GET', remotePath(rel), { sink: dest });
    if (r.status !== 200) throw new Error(`WebDAV: lettura non riuscita (HTTP ${r.status})`);
  },
  async del(rel) { await dav('DELETE', remotePath(rel)); },
  async probe() {
    const r = await dav('PROPFIND', '', { headers: { Depth: '0' } });
    if (r.status === 401 || r.status === 403) throw new Error('Utente o password non accettati');
    if (![200, 207, 301].includes(r.status)) throw new Error(`Il server non risponde come WebDAV (HTTP ${r.status})`);
    const tmp = path.join(DATA, 'archive-test.txt');
    fs.writeFileSync(tmp, 'prova');
    try {
      const rel = '0000-00-00/prova.txt';
      await davDirs(rel);
      const w = await dav('PUT', remotePath(rel), { upload: tmp });
      if (![200, 201, 204].includes(w.status)) throw new Error(`Scrittura non riuscita (HTTP ${w.status})`);
      await dav('DELETE', remotePath(rel));
    } finally { fs.rmSync(tmp, { force: true }); }
  },
};

const driver = () => ({ folder, smb: smb_, webdav })[cfg.driver];
export const __test = { driver }; // solo per i collaudi

// ---------- trasferimento ----------
const state = { running: false, done: 0, total: 0, last: null };
export const status = () => ({ running: state.running, done: state.done, total: state.total, last: state.last });

/** Prova il collegamento con la configurazione salvata: lancia un errore leggibile se qualcosa non va. */
export async function test() {
  if (!isConfigured()) throw new Error('Archivio non configurato');
  const d = driver();
  await d.probe();
  return { ok: true };
}

/** Sposta nell'archivio i filmati più vecchi di `afterDays`. */
export async function run({ manual = false } = {}) {
  if (state.running || !isConfigured() || (!manual && !isEnabled())) return state.last;
  state.running = true;
  state.done = 0;
  const res = { at: Date.now(), moved: 0, failed: 0, bytes: 0, error: '' };
  try {
    const d = driver();
    await d.ready();
    const list = db.archivable(Date.now() - cfg.afterDays * 86400_000, manual ? 500 : 60);
    state.total = list.length;
    let consecutive = 0;
    for (const ev of list) {
      const abs = path.join(db.EVENTS_DIR, ev.clip);
      let size = 0;
      try { size = fs.statSync(abs).size; } catch { size = -1; }
      if (size < 0 || !CLIP_RE.test(ev.clip)) { state.done++; continue; } // già assente dal CT: non c'è nulla da spostare
      try {
        await d.put(abs, ev.clip);
        db.markArchived(ev.id);
        fs.rmSync(abs, { force: true });
        res.moved++;
        res.bytes += size;
        consecutive = 0;
      } catch (err) {
        res.failed++;
        res.error = err.message;
        if (++consecutive >= 3) break; // archivio non raggiungibile: si riprova più tardi
      }
      state.done++;
    }
  } catch (err) {
    res.error = err.message;
  } finally {
    state.running = false;
    state.last = res;
  }
  return res;
}

/** Elimina un filmato dall'archivio (cancellazione o scadenza dell'evento). */
export async function remove(rel) {
  if (!isConfigured() || !CLIP_RE.test(rel)) return;
  fs.rmSync(path.join(CACHE_DIR, rel), { force: true });
  await driver().del(rel);
}

// ---------- lettura di un filmato archiviato ----------
const fetching = new Map();

function evictCache() {
  const files = [];
  const walk = (p) => { for (const e of fs.readdirSync(p, { withFileTypes: true })) { const f = path.join(p, e.name); if (e.isDirectory()) walk(f); else { const s = fs.statSync(f); files.push({ f, size: s.size, t: s.mtimeMs }); } } };
  try { walk(CACHE_DIR); } catch { return; }
  let total = files.reduce((a, b) => a + b.size, 0);
  for (const x of files.sort((a, b) => a.t - b.t)) {
    if (total <= CACHE_MAX * 0.8) break;
    fs.rmSync(x.f, { force: true });
    total -= x.size;
  }
}

/** Percorso locale (in cache) del filmato archiviato `rel`: lo riprende dall'archivio se serve. */
export async function cachedFile(rel) {
  checkRel(rel);
  if (!isConfigured()) throw new Error('Archivio non configurato');
  const dest = path.join(CACHE_DIR, rel);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) { const now = new Date(); fs.utimesSync(dest, now, now); return dest; }
  if (!fetching.has(rel)) {
    fetching.set(rel, (async () => {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const tmp = `${dest}.${process.pid}.part`;
      try {
        await driver().get(rel, tmp);
        if (!fs.existsSync(tmp) || fs.statSync(tmp).size === 0) throw new Error('Filmato non trovato nell\'archivio');
        fs.renameSync(tmp, dest);
      } finally { fs.rmSync(tmp, { force: true }); }
      evictCache();
      return dest;
    })().finally(() => fetching.delete(rel)));
  }
  return fetching.get(rel);
}

let smbclientOk = null;
/** Programmi necessari alle varie destinazioni (smbclient per SMB). */
export function tools() {
  if (smbclientOk === null) smbclientOk = spawnSync('smbclient', ['--version'], { stdio: 'ignore' }).status === 0;
  return { smbclient: smbclientOk };
}

// ---------- spazio e crescita ----------
export function usage() {
  const s = db.eventStats();
  let disk = null;
  try { const f = fs.statfsSync(DATA); disk = { total: f.blocks * f.bsize, free: f.bavail * f.bsize }; } catch { /* non disponibile */ }
  // Crescita media: eventi completi degli ultimi giorni (il giorno in corso, parziale, si conta in proporzione alle ore).
  const days = s.days.filter((d) => d.bytes > 0);
  const total = days.reduce((a, b) => a + b.bytes, 0);
  const span = Math.min(7, Math.max(1, (Date.now() - Math.max(s.first || Date.now(), Date.now() - 7 * 86400_000)) / 86400_000));
  const perDay = total / span;
  return {
    events: s.n, archived: s.archived, localBytes: s.localBytes, archivedBytes: s.archivedBytes, perDay, days: s.days,
    disk, daysLeft: disk && perDay > 0 ? Math.floor(disk.free / perDay) : null,
  };
}

/** All'avvio: calcola lo spazio degli eventi salvati prima che si tenesse il conto, e pianifica l'archiviazione. */
export function start() {
  try {
    for (const r of db.eventsWithoutBytes(2000)) {
      let b = 0;
      for (const rel of [r.snapshot, r.clip]) { try { if (rel) b += fs.statSync(path.join(db.EVENTS_DIR, rel)).size; } catch { /* assente */ } }
      db.updateEvent(r.id, { bytes: b });
    }
  } catch { /* si ricalcola al prossimo avvio */ }
  setTimeout(() => run().catch(() => {}), 2 * 60_000).unref();
  setInterval(() => run().catch(() => {}), 10 * 60_000).unref();
}
