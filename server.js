// Argo — server.
//  - serve l'interfaccia web (public/) dietro accesso con utente e password
//  - gestisce telecamere (cameras.json), impostazioni, utenti e permessi
//  - avvia go2rtc con la configurazione generata e ne fa da proxy SOLO per i flussi consentiti all'utente
//  - rileva gli eventi delle telecamere e li salva in un database locale
//
// Ambiente: vedi lib/paths.js (DATA_DIR, HOST, PORT, TLS_CERT/TLS_KEY, TRUST_PROXY, WEBRTC_CANDIDATES).
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import crypto, { randomBytes, createHash } from 'node:crypto';
import * as reolink from './lib/reolink.js';
import * as eufy from './lib/eufy.js';
import * as eufySettings from './lib/eufy-settings.js';
import * as eufyCloud from './lib/eufy-cloud.js';
import * as eufyLogin from './lib/eufy-login.js';
import * as events from './lib/events.js';
import * as db from './lib/db.js';
import * as search from './lib/search.js';
import * as recognition from './lib/recognition.js';
import * as eufyPush from './lib/eufy-push.js';
import * as hazardLearn from './lib/hazard-learn.js';
import * as privacy from './lib/privacy.js';
import * as auth from './lib/auth.js';
import { getSettings, updateSettings, EVENT_KINDS } from './lib/settings.js';
import * as haLib from './lib/homeassistant.js';
import * as netinfo from './lib/netinfo.js';
import * as archive from './lib/archive.js';
import * as battery from './lib/battery.js';
import * as hazard from './lib/hazard.js';
import * as secrets from './lib/secrets.js';
import * as mdi from './lib/mdi.js';
import * as discovery from './lib/discovery.js';
import os from 'node:os';
import { AsyncLocalStorage } from 'node:async_hooks';
import { localize, langOf } from './lib/errors-i18n.js';
import { BRANDS, buildSources, normalizeParams, publicBrands, publicCamera } from './lib/brands.js';
import { ROOT, DATA, GO2RTC_BIN, IS_WINDOWS } from './lib/paths.js';

const PUBLIC = path.join(ROOT, 'public');
const CAMERAS_FILE = path.join(DATA, 'cameras.json');
// La configurazione di go2rtc contiene le credenziali delle telecamere in chiaro: sta in una cartella privata di lavoro
// (RuntimeDirectory di systemd, in memoria) e si cancella appena go2rtc l'ha letta, quindi non resta mai nei dati.
const CFG_DIR = (process.env.RUNTIME_DIRECTORY || '').split(':')[0] || fs.mkdtempSync(path.join(os.tmpdir(), 'argo-'));
const GO2RTC_CFG = path.join(CFG_DIR, 'go2rtc.yaml');
fs.rmSync(path.join(DATA, 'go2rtc.yaml'), { force: true }); // versioni precedenti la lasciavano nei dati, con le credenziali

const PORT = Number(process.env.PORT) || 8780;
// Solo questo PC per impostazione predefinita; sul server (CT) l'installazione imposta HOST=0.0.0.0.
const HOST = process.env.HOST || '127.0.0.1';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
// Porta solo-loopback (sempre HTTP) da cui ffmpeg legge il video delle Eufy: non è mai raggiungibile dalla rete.
const INTERNAL_PORT = Number(process.env.INTERNAL_PORT) || PORT + 1;
const GO2RTC_API = { host: '127.0.0.1', port: 1984 };
const WEBRTC_CANDIDATES = (process.env.WEBRTC_CANDIDATES || '').split(',').map((s) => s.trim()).filter(Boolean);

fs.mkdirSync(DATA, { recursive: true });
process.on('unhandledRejection', (err) => console.error('[errore non gestito]', err));

// ---------- telecamere ----------
// Le credenziali (params) stanno cifrate nel file (lib/secrets.js); in memoria sono in chiaro.
const saveCameras = () => {
  const tmp = `${CAMERAS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(secrets.sealCameras(cameras), null, 2), { mode: 0o600 });
  fs.renameSync(tmp, CAMERAS_FILE);
};
let cameras = [];
try {
  const opened = secrets.openCameras(JSON.parse(fs.readFileSync(CAMERAS_FILE, 'utf8')));
  cameras = opened.cameras;
  if (opened.plain && secrets.enabled()) { saveCameras(); console.log('[segreti] credenziali delle telecamere ora cifrate nel file'); }
} catch (err) {
  if (err instanceof secrets.SecretError) {
    // Senza la chiave giusta non si parte: con l'elenco vuoto il primo salvataggio cancellerebbe le telecamere.
    console.error(`[segreti] ${err.message}`);
    process.exit(1);
  }
  if (err.code !== 'ENOENT') { // file illeggibile: lo si conserva a parte invece di sovrascriverlo
    try { fs.renameSync(CAMERAS_FILE, `${CAMERAS_FILE}.bad-${Date.now()}`); console.error(`[telecamere] cameras.json non valido, conservato a parte: ${err.message}`); } catch { /* ignora */ }
  }
  cameras = [];
}
const byId = (id) => cameras.find((c) => c.id === id);

/** Telecamera come la vede `user`: l'amministratore ha tutto, gli altri solo il necessario (niente indirizzi né credenziali). */
function pubFor(user, cam) {
  const level = auth.levelFor(user, cam.id);
  const live = { caps: events.getCaps(cam.id), status: events.getStatus(cam.id), privacy: privacy.get(cam.id), level, batteryLevel: cam.battery ? battery.get(cam.id) : null };
  if (user.role === 'admin') {
    const pub = publicCamera(cam);
    return { ...pub, ha: pub.ha.map((h) => ({ ...h, path: mdi.pathOf(h.icon), control: haLib.canControl(h.entity), kind: haLib.controlKind(h.entity) })), ...live };
  }
  return {
    id: cam.id, name: cam.name, brand: cam.brand, battery: cam.battery === true, wakeLimit: cam.wakeLimit ?? null,
    alerts: cam.alerts !== false, params: {}, ...live,
    // Icone Home Assistant: senza il nome dell'entità, solo ciò che serve a disegnarle.
    ha: (cam.ha || []).map((h, i) => ({ i, label: h.label, icon: h.icon, path: mdi.pathOf(h.icon), control: haLib.canControl(h.entity), kind: haLib.controlKind(h.entity) })),
  };
}

// ---------- go2rtc ----------
let go2rtc = null;
let restarting = Promise.resolve();
let shuttingDown = false;

function writeGo2rtcConfig() {
  const streams = {};
  // Flussi leggeri tenuti sempre collegati: la griglia parte subito invece di
  // rinegoziare RTSP con ogni telecamera a ogni apertura. Mai per le telecamere a batteria.
  const preload = {};
  for (const cam of cameras) {
    if (!BRANDS[cam.brand]) continue;
    // Eufy locale: il video arriva dal protocollo P2P tramite questo server; ffmpeg lo
    // ripubblica su go2rtc. Un solo comando per flusso principale e secondario: entrambi
    // leggono lo stesso percorso interno, che condivide un'unica sessione con la telecamera.
    if (cam.brand === 'eufyp2p') {
      const exec =
        `exec:ffmpeg -hide_banner -loglevel error -avioflags direct -fflags nobuffer -flags low_delay ` +
        `-use_wallclock_as_timestamps 1 -f ${eufy.rawFormatOf(cam.params.serial)} -i http://127.0.0.1:${INTERNAL_PORT}/internal/eufy/${cam.id} ` +
        `-c:v copy -rtsp_transport tcp -f rtsp {output}`;
      streams[`${cam.id}_main`] = exec;
      streams[`${cam.id}_sub`] = exec;
      continue;
    }
    const src = buildSources(cam);
    streams[`${cam.id}_main`] = src.main;
    streams[`${cam.id}_sub`] = src.sub;
    if (cam.brand !== 'demo') {
      // Varianti "_a": stesso video, audio convertito in Opus (il WebRTC non legge l'AAC delle telecamere).
      // Il browser le usa solo per la telecamera selezionata, quindi ffmpeg parte solo per quella.
      streams[`${cam.id}_main_a`] = `ffmpeg:${cam.id}_main#video=copy#audio=opus`;
      streams[`${cam.id}_sub_a`] = `ffmpeg:${cam.id}_sub#video=copy#audio=opus`;
      // Flusso per parlare (campanello): come il principale ma con l'audio bidirezionale attivo.
      streams[`${cam.id}_talk`] = [...src.main.map((u) => u.replace('#backchannel=0', '')), `ffmpeg:${cam.id}_talk#audio=opus`];
    }
    if (cam.preload !== false && !cam.battery) preload[`${cam.id}_sub`] = 'video&audio';
  }
  const webrtc = { listen: ':8555', ice_servers: [] }; // nessun server STUN esterno: tutto resta in rete locale
  if (WEBRTC_CANDIDATES.length) webrtc.candidates = WEBRTC_CANDIDATES;
  const cfg = {
    api: { listen: `${GO2RTC_API.host}:${GO2RTC_API.port}` },
    rtsp: { listen: '127.0.0.1:8554' },
    // (Legare la porta WebRTC a 127.0.0.1 impedisce la connessione ICE del browser: resta su tutte le interfacce.)
    webrtc,
    log: { level: 'info' },
    streams,
    preload,
  };
  // JSON è YAML valido: evita problemi di quoting con password e URL. Contiene le credenziali delle telecamere.
  fs.writeFileSync(GO2RTC_CFG, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

/** Chiude un processo e i suoi figli (gli ffmpeg avviati da go2rtc). */
function killTree(child) {
  if (!child?.pid) return;
  if (IS_WINDOWS) {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL'); // gruppo di processi (il figlio è stato avviato "detached")
  } catch {
    try { child.kill('SIGKILL'); } catch { /* già terminato */ }
  }
}

function killGo2rtc() {
  const child = go2rtc;
  go2rtc = null;
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once('exit', resolve);
    killTree(child);
    setTimeout(resolve, 3000);
  });
}

function startGo2rtc() {
  if (!fs.existsSync(GO2RTC_BIN)) {
    console.error(`go2rtc non trovato in ${GO2RTC_BIN}`);
    return;
  }
  writeGo2rtcConfig();
  const child = spawn(GO2RTC_BIN, ['-c', GO2RTC_CFG], { cwd: DATA, windowsHide: true, detached: !IS_WINDOWS });
  go2rtc = child;
  waitForGo2rtc().then((up) => { if (up) fs.rm(GO2RTC_CFG, { force: true }, () => {}); }); // già letta: non resta su disco
  const log = (d) => process.stdout.write(`[go2rtc] ${d}`);
  child.stdout.on('data', log);
  child.stderr.on('data', log);
  child.on('exit', (code) => {
    if (go2rtc !== child || shuttingDown) return;
    console.error(`go2rtc terminato (codice ${code}), riavvio tra 3 s`);
    go2rtc = null;
    setTimeout(() => !go2rtc && !shuttingDown && startGo2rtc(), 3000);
  });
}

// Attende che l'API di go2rtc accetti connessioni (max 5 s), così la pagina
// ricaricata subito dopo un salvataggio non trova il motore video spento.
function waitForGo2rtc() {
  const deadline = Date.now() + 5000;
  return new Promise((resolve) => {
    const attempt = () => {
      const s = net.connect(GO2RTC_API.port, GO2RTC_API.host);
      s.once('connect', () => (s.destroy(), resolve(true)));
      s.once('error', () => {
        s.destroy();
        if (Date.now() > deadline) resolve(false);
        else setTimeout(attempt, 100);
      });
    };
    attempt();
  });
}

// Più modifiche ravvicinate condividono un solo riavvio: ogni riavvio è un nuovo
// accesso a tutte le telecamere, e troppi accessi di fila possono farle bloccare.
let queuedRestart = null;
function restartGo2rtc() {
  if (!queuedRestart) {
    queuedRestart = restarting
      .then(() => new Promise((r) => setTimeout(r, 300)))
      .then(() => {
        queuedRestart = null;
        return killGo2rtc();
      })
      .then(startGo2rtc)
      .then(waitForGo2rtc);
    restarting = queuedRestart.catch(() => {});
  }
  return queuedRestart;
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  killTree(go2rtc);
  try { eufy.closeAll(); } catch { /* si chiude comunque */ }
  setTimeout(() => process.exit(0), 400); // il tempo di spedire i pacchetti di chiusura alle telecamere Eufy
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGHUP', shutdown);

// ---------- richiesta: utilità ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.mp4': 'video/mp4',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// Lingua della richiesta in corso (X-Lang dell'interfaccia, altrimenti Accept-Language): i messaggi d'errore, scritti
// in italiano nel codice, escono tradotti (lib/errors-i18n.js).
const langStore = new AsyncLocalStorage();
const tr = (message) => localize(message, langStore.getStore() || 'it');
function localizeBody(body) {
  const lang = langStore.getStore();
  if (!lang || lang === 'it' || !body || typeof body !== 'object') return body;
  if (typeof body.error === 'string') body = { ...body, error: localize(body.error, lang) };
  const last = body.status?.last;
  if (last?.error) body = { ...body, status: { ...body.status, last: { ...last, error: localize(last.error, lang) } } };
  return body;
}

const json = (res, status, body, headers = {}) => {
  body = localizeBody(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
};

const LASTFRAME_DIR = path.join(DATA, 'lastframe');

function readRaw(req, max) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > max) { reject(new HttpError(413, 'Richiesta troppo grande')); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 100_000) {
        reject(new Error('Richiesta troppo grande'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new Error('JSON non valido'));
      }
    });
    req.on('error', reject);
  });
}

const clientIp = (req) => {
  const fwd = TRUST_PROXY ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '';
  return (fwd || req.socket.remoteAddress || '').replace(/^::ffff:/, '');
};
const isSecure = (req) => serverIsTls || (TRUST_PROXY && req.headers['x-forwarded-proto'] === 'https');
const publicHost = (req) => (TRUST_PROXY && req.headers['x-forwarded-host']) || req.headers.host;

// Blocca le richieste provenienti da altri siti aperti nel browser (CSRF / WebSocket hijacking).
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === publicHost(req);
  } catch {
    return false;
  }
}

function securityHeaders(res, req) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), geolocation=(), microphone=(self)');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; " +
      "connect-src 'self' ws: wss:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
  );
}

const userOf = (req) => auth.userFromToken(auth.parseCookies(req.headers.cookie)[auth.COOKIE_NAME]);

const clampSeconds = (v) => Math.max(0, Math.min(3600, Math.round(Number(v)) || 0));

function cameraFromInput(body, previous) {
  const name = String(body.name || '').trim().slice(0, 60);
  if (!name) throw new Error('Inserisci un nome');
  const brand = previous ? previous.brand : String(body.brand || '');
  const params = normalizeParams(brand, body.params, previous?.params);
  const preload = body.preload !== false;
  // Telecamere a batteria: indicato dall'utente, altrimenti dedotto (SoloCam Eufy T81…; Reolink dal rilevamento).
  let battery = 'battery' in body ? !!body.battery : previous?.battery;
  if (battery === undefined && brand === 'eufyp2p' && /^T81/.test(params.serial || '')) battery = true;
  const wakeLimit = 'wakeLimit' in body
    ? (body.wakeLimit === '' || body.wakeLimit === null ? null : clampSeconds(body.wakeLimit))
    : previous?.wakeLimit ?? null;
  const alerts = 'alerts' in body ? body.alerts !== false : previous?.alerts !== false;
  const saveEvents = 'saveEvents' in body ? body.saveEvents !== false : previous?.saveEvents !== false;
  const cam = { id: previous?.id || `cam_${randomBytes(4).toString('hex')}`, name, brand, params, preload, wakeLimit, alerts, saveEvents };
  if (battery !== undefined) cam.battery = battery;
  if (previous?.ha?.length) cam.ha = previous.ha; // le icone Home Assistant si modificano da un comando a parte
  return cam;
}

// ---------- media degli eventi ----------
const MEDIA_CAM = /^\d{4}-\d{2}-\d{2}\/(cam_[0-9a-f]{8})_/;

function serveMedia(req, res, rel, user) {
  const file = path.join(db.EVENTS_DIR, path.normalize(rel));
  if (!file.startsWith(db.EVENTS_DIR + path.sep)) return res.writeHead(403).end();
  // Le immagini e i filmati portano nel nome la telecamera; i volti sono riservati all'amministratore.
  if (user.role !== 'admin') {
    const m = MEDIA_CAM.exec(rel.replaceAll('\\', '/'));
    if (!m || auth.levelFor(user, m[1]) < 1) return res.writeHead(403).end();
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      // Filmato spostato nell'archivio di rete: lo si riprende (poi resta un po' in cache) e si serve da lì.
      const relPosix = rel.replaceAll('\\', '/');
      if (archive.isConfigured() && archive.CLIP_RE.test(relPosix)) {
        archive.cachedFile(relPosix).then((cached) => sendFile(req, res, cached)).catch((e) => {
          console.error(`[archivio] ${relPosix}: ${e.message}`);
          if (!res.headersSent) res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Archivio non raggiungibile');
        });
        return;
      }
      return res.writeHead(404).end();
    }
    sendFile(req, res, file, st);
  });
}

function sendFile(req, res, file, knownStat) {
  const go = (st) => {
    const type = MIME[path.extname(file)] || 'application/octet-stream';
    const base = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=3600' };
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (range) {
      const start = range[1] ? Number(range[1]) : Math.max(0, st.size - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
      res.writeHead(206, { ...base, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
      fs.createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res);
    } else {
      res.writeHead(200, { ...base, 'Content-Length': st.size });
      fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
    }
  };
  if (knownStat) return go(knownStat);
  fs.stat(file, (err, st) => (err || !st.isFile() ? res.writeHead(404).end() : go(st)));
}

// ---------- API ----------
const PUBLIC_ONLY_FIELDS = (e) => ({ ...e, personId: null, personName: null, vehicleId: null, vehicleName: null, subjects: [] }); // volti e nomi solo per l'amministratore

async function handleAuthApi(req, res, parts, user) {
  const secure = isSecure(req);
  if (parts[2] === 'login' && req.method === 'POST') {
    const body = await readBody(req);
    const { user: u, token } = await auth.login(body.username, body.password, { ip: clientIp(req), ua: req.headers['user-agent'] });
    return json(res, 200, { user: u }, { 'Set-Cookie': auth.sessionCookie(token, secure) });
  }
  if (parts[2] === 'recovery' && req.method === 'POST') {
    // Recupero password dell'amministratore dalla pagina di accesso (nessuna sessione richiesta).
    const body = await readBody(req);
    const ctx = { ip: clientIp(req) };
    if (parts[3] === 'questions') return json(res, 200, { questions: auth.recoveryQuestions(body.username, ctx) });
    if (parts[3] === 'reset') {
      await auth.recoverPassword(body.username, body.answers, String(body.password || ''), ctx);
      return json(res, 200, { ok: true });
    }
  }
  if (parts[2] === 'logout' && req.method === 'POST') {
    auth.logout(auth.parseCookies(req.headers.cookie)[auth.COOKIE_NAME]);
    return json(res, 200, { ok: true }, { 'Set-Cookie': auth.clearCookie(secure) });
  }
  if (parts[2] === 'me' && req.method === 'GET') {
    if (!user) throw new HttpError(401, 'Accesso richiesto', 'UNAUTHENTICATED');
    const { sessionHash, ...rest } = user;
    return json(res, 200, { user: rest });
  }
  if (parts[2] === 'password' && req.method === 'POST') {
    if (!user) throw new HttpError(401, 'Accesso richiesto', 'UNAUTHENTICATED');
    const body = await readBody(req);
    await auth.changeOwnPassword(user, String(body.current || ''), String(body.next || ''));
    return json(res, 200, { ok: true });
  }
  throw new HttpError(404, 'Non trovato');
}

async function handleAdminApi(req, res, parts) {
  // /api/admin/users[/:id[/password|cameras|revoke]]
  if (parts[2] === 'generate-password' && req.method === 'POST') return json(res, 200, { password: auth.randomPassword() });
  if (parts[2] === 'archive') { // archivio di rete degli eventi più vecchi
    const full = () => ({ config: archive.publicConfig(), status: archive.status(), usage: archive.usage(), tools: archive.tools() });
    if (parts[3] === undefined && req.method === 'GET') return json(res, 200, full());
    if (parts[3] === undefined && req.method === 'PUT') { archive.setConfig(await readBody(req)); return json(res, 200, full()); }
    if (parts[3] === 'test' && req.method === 'POST') { await archive.test(); return json(res, 200, { ok: true }); }
    if (parts[3] === 'run' && req.method === 'POST') { archive.run({ manual: true }).catch(() => {}); return json(res, 200, { status: archive.status() }); }
    throw new HttpError(404, 'Non trovato');
  }
  if (parts[2] === 'system') { // riavvio del sistema (contenitore)
    const available = process.env.REBOOT_HELPER === '1';
    if (parts[3] === undefined && req.method === 'GET') return json(res, 200, { rebootAvailable: available, uptime: Math.round(os.uptime()) });
    if (parts[3] === 'reboot' && req.method === 'POST') {
      if (!available) throw new HttpError(400, 'Il riavvio dall\'app non è attivo su questo sistema', 'NOT_SUPPORTED');
      if ((await readBody(req)).confirm !== true) throw new HttpError(400, 'Conferma mancante');
      console.log(`[sistema] riavvio richiesto da "${req.user.username}"`);
      fs.writeFileSync(path.join(DATA, 'reboot-request'), String(Date.now()), { mode: 0o600 }); // lo raccoglie l'unità di sistema (root)
      return json(res, 200, { ok: true });
    }
    throw new HttpError(404, 'Non trovato');
  }
  if (parts[2] === 'cert-password') { // password per scaricare il certificato dai telefoni
    if (req.method === 'GET') return json(res, 200, { set: auth.certPasswordSet(), tls: certFileOk() });
    if (req.method === 'PUT') {
      await auth.setCertPassword(String((await readBody(req)).password || ''));
      return json(res, 200, { set: true, tls: certFileOk() });
    }
    if (req.method === 'DELETE') { auth.clearCertPassword(); return json(res, 200, { set: false, tls: certFileOk() }); }
    throw new HttpError(404, 'Non trovato');
  }
  if (parts[2] === 'recovery') { // domande di recupero dell'amministratore che sta operando
    if (req.method === 'GET') return json(res, 200, auth.recoveryStatus(req.user));
    if (req.method === 'PUT') {
      const body = await readBody(req);
      await auth.setRecovery(req.user, body.current, body.items);
      return json(res, 200, auth.recoveryStatus(req.user));
    }
    if (req.method === 'DELETE') {
      await auth.clearRecovery(req.user, (await readBody(req)).current);
      return json(res, 200, auth.recoveryStatus(req.user));
    }
    throw new HttpError(404, 'Non trovato');
  }
  if (parts[2] !== 'users') throw new HttpError(404, 'Non trovato');
  const id = Number(parts[3]);
  const acting = req.user;
  if (!parts[3]) {
    if (req.method === 'GET') {
      return json(res, 200, { users: auth.listUsers(), cameras: cameras.map((c) => ({ id: c.id, name: c.name, brand: c.brand })) });
    }
    if (req.method === 'POST') return json(res, 201, await auth.createUser(await readBody(req)));
  } else {
    if (!db.getUserById(id)) throw new HttpError(404, 'Utente non trovato', 'NOT_FOUND');
    if (!parts[4]) {
      if (req.method === 'PUT') return json(res, 200, auth.updateUser(id, await readBody(req), acting));
      if (req.method === 'DELETE') { auth.deleteUser(id, acting); return json(res, 200, { ok: true }); }
    }
    if (parts[4] === 'password' && req.method === 'POST') {
      const body = await readBody(req);
      await auth.resetPassword(id, String(body.password || ''), { mustChange: body.mustChange !== false });
      return json(res, 200, { ok: true });
    }
    if (parts[4] === 'cameras' && req.method === 'PUT') {
      auth.setCameraAccess(id, (await readBody(req)).levels, cameras.map((c) => c.id));
      return json(res, 200, { ok: true });
    }
    if (parts[4] === 'revoke' && req.method === 'POST') { auth.revokeSessions(id); return json(res, 200, { ok: true }); }
  }
  throw new HttpError(404, 'Non trovato');
}

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const user = req.user;
  if (req.method !== 'GET' && !sameOrigin(req)) throw new HttpError(403, 'Origine non consentita');

  if (parts[1] === 'auth') return handleAuthApi(req, res, parts, user);
  if (parts[1] === 'cert' && parts[2] === 'info' && req.method === 'GET') return json(res, 200, { available: certDownloadAvailable() });
  if (!user) throw new HttpError(401, 'Accesso richiesto', 'UNAUTHENTICATED');
  if (user.mustChange) throw new HttpError(403, 'Devi cambiare la password prima di continuare', 'MUST_CHANGE_PASSWORD');

  const isAdmin = user.role === 'admin';
  const needAdmin = () => { if (!isAdmin) throw new HttpError(403, 'Riservato agli amministratori', 'FORBIDDEN'); };
  const level = (id) => auth.levelFor(user, id);
  /** Telecamera `id` con almeno il livello richiesto (1 = vede, 2 = controlla). Senza accesso risulta inesistente. */
  const camFor = (id, min = 1) => {
    const cam = byId(id);
    if (!cam || level(id) < 1) throw new HttpError(404, 'Telecamera non trovata');
    if (level(id) < min) throw new HttpError(403, 'Non hai il permesso di controllare questa telecamera', 'FORBIDDEN');
    return cam;
  };

  if (parts[1] === 'admin') { needAdmin(); req.user = user; return handleAdminApi(req, res, parts); }
  if (parts[1] === 'brands' && req.method === 'GET') { needAdmin(); return json(res, 200, publicBrands()); }

  // ----- impostazioni -----
  if (parts[1] === 'settings') {
    if (req.method === 'GET') {
      const s = getSettings();
      return json(res, 200, isAdmin ? s : { wakeLimit: s.wakeLimit, flash: s.flash, doorbell: s.doorbell });
    }
    if (req.method === 'PUT') { needAdmin(); return json(res, 200, updateSettings(await readBody(req))); }
  }

  if (parts[1] === 'battery' && req.method === 'GET') { // ultimo livello noto delle telecamere a batteria visibili
    const out = {};
    for (const c of cameras) if (c.battery && level(c.id) > 0) out[c.id] = battery.get(c.id);
    return json(res, 200, out);
  }

  // ----- Home Assistant -----
  if (parts[1] === 'ha') {
    if (parts[2] === 'states' && req.method === 'GET') {
      // Stati delle icone, solo per le telecamere che l'utente può vedere.
      const out = {};
      for (const c of cameras) {
        if (level(c.id) < 1 || !c.ha?.length) continue;
        out[c.id] = c.ha.map((h, i) => ({ i, ...haLib.stateOf(h.entity) }));
        for (const s of out[c.id]) delete s.name; // il nome dell'entità non serve (c'è l'etichetta)
      }
      return json(res, 200, { ok: haLib.status().ok, cameras: out });
    }
    needAdmin();
    if (parts[2] === 'config' && req.method === 'GET') return json(res, 200, { ...haLib.publicConfig(), ...haLib.status() });
    if (parts[2] === 'config' && req.method === 'PUT') {
      const body = await readBody(req);
      return json(res, 200, haLib.setConfig({ url: body.url, token: body.token }));
    }
    if (parts[2] === 'config' && req.method === 'DELETE') return json(res, 200, haLib.clearConfig());
    if (parts[2] === 'test' && req.method === 'POST') return json(res, 200, await haLib.test());
    if (parts[2] === 'entities' && req.method === 'GET') return json(res, 200, { entities: await haLib.entities() });
    throw new HttpError(404, 'Non trovato');
  }

  // ----- Eufy: rilevamento in rete -----
  if (parts[1] === 'eufy' && parts[2] === 'discover' && req.method === 'GET') {
    needAdmin();
    const known = cameras.filter((c) => c.brand === 'eufyp2p');
    const found = url.searchParams.get('scan') === '0' ? [] : await eufy.discover({ ms: 4000, hosts: known.map((c) => c.params.host) });
    const devices = eufy.accountDevices().map((d) => {
      const hit = found.find((f) => f.serial === d.serial);
      const cam = known.find((c) => c.params.serial === d.serial);
      return { serial: d.serial, name: d.name, ip: hit?.ip || null, online: !!hit, camId: cam?.id || null, camName: cam?.name || null };
    });
    const unknown = found.filter((f) => !f.serial).map((f) => ({ ip: f.ip }));
    return json(res, 200, { configured: eufy.isConfigured(), devices, unknown });
  }
  // ----- elenco dei canali di un hub/NVR Reolink, per scegliere il canale nel modulo della telecamera -----
  if (parts[1] === 'reolink' && parts[2] === 'channels' && req.method === 'POST') {
    needAdmin();
    const body = await readBody(req);
    const host = String(body.host || '').trim();
    if (!/^[A-Za-z0-9._-]+$/.test(host)) throw new HttpError(400, 'Indirizzo non valido (solo IP o nome host)');
    const onHost = cameras.filter((c) => c.brand === 'reolink' && c.params.host === host);
    // Credenziali scritte nel modulo, altrimenti quelle di una telecamera già aggiunta sullo stesso hub (restano sul server)
    let cam = null;
    if (body.password) cam = { id: null, params: { host, username: String(body.username || 'admin'), password: String(body.password) } };
    else if (onHost.length) cam = onHost[0];
    if (!cam) throw new HttpError(400, 'Indica utente e password dell\'hub per elencare i canali');
    const list = await reolink.allChannels(cam);
    const usedBy = (n) => onHost.find((c) => (Number(c.params.channel) || 1) === n && c.id !== body.excludeId)?.name || null;
    return json(res, 200, { host, channels: list.map((c) => ({ ...c, usedBy: usedBy(c.channel) })) });
  }  // ----- ricerca automatica di telecamere nella rete (finestra "Nuova telecamera") -----
  if (parts[1] === 'discovery') {
    needAdmin();
    if (!parts[2] && req.method === 'POST') {
      const body = await readBody(req).catch(() => ({}));
      // Telecamere Reolink collegate a un hub/NVR: si chiede all'hub l'elenco dei canali con le credenziali di una
      // telecamera già aggiunta sullo stesso hub, oppure con quelle scritte nel modulo (hub non ancora aggiunto).
      const reolinkCams = cameras.filter((c) => c.brand === 'reolink' && c.params.host);
      const hubs = [];
      const seenHosts = new Set();
      for (const c of reolinkCams) if (!seenHosts.has(c.params.host)) { seenHosts.add(c.params.host); hubs.push({ cam: c, id: c.id }); }
      const typed = body?.reolink;
      if (typed && /^[A-Za-z0-9._-]+$/.test(String(typed.host || '')) && typed.password && !seenHosts.has(typed.host)) {
        hubs.push({ cam: { id: null, params: { host: String(typed.host), username: String(typed.username || 'admin'), password: String(typed.password) } }, id: null });
      }
      const id = discovery.start({
        known: discovery.knownHosts(cameras, eufy.hostOf),
        accountSerials: new Map(eufy.accountDevices().filter((d) => d.did).map((d) => [d.did, d.serial])),
        knownSerials: new Set(cameras.filter((c) => c.brand === 'eufyp2p').map((c) => c.params.serial)),
        hubs,
        knownChannels: new Set(reolinkCams.map((c) => `${c.params.host}|${Number(c.params.channel) || 1}`)),
        listChannels: reolink.pairedChannels,
      });
      return json(res, 200, { id });
    }
    const st = parts[2] ? discovery.status(parts[2]) : null;
    if (!st) throw new HttpError(404, 'Non trovato');
    if (req.method === 'GET') return json(res, 200, st);
    if (req.method === 'DELETE') { discovery.cancel(parts[2]); return json(res, 200, { ok: true }); }
  }
  // ----- Eufy: accesso al cloud dalle impostazioni (account, sveglia delle batterie) -----
  if (parts[1] === 'eufy' && parts[2] === 'cloud') {
    needAdmin();
    if (req.method === 'GET') return json(res, 200, { available: eufyLogin.available(), configured: eufy.isConfigured(), push: eufyPush.status(), ...eufyCloud.status() });
    if (req.method === 'DELETE') { eufyCloud.disconnect(); return json(res, 200, { ok: true }); }
  }
  if (parts[1] === 'eufy' && parts[2] === 'login' && req.method === 'POST') {
    needAdmin();
    const stepResult = await eufyLogin.step(await readBody(req));
    if (stepResult?.status === 'done') eufyPush.restart(); // nuova sessione Eufy: si riaprono le notifiche
    return json(res, 200, stepResult);
  }

  // ----- riconoscimento (volti e mezzi) e persone: solo amministratore -----
  if (parts[1] === 'recognition') {
    needAdmin();
    if (parts[2] === 'status' && req.method === 'GET') return json(res, 200, { ...(await recognition.status()), ...recognition.progress() });
    if (parts[2] === 'progress' && req.method === 'GET') return json(res, 200, recognition.progress());
    if (parts[2] === 'reprocess' && req.method === 'GET') return json(res, 200, recognition.reprocessInfo());
    if (parts[2] === 'reprocess' && req.method === 'POST') return json(res, 200, await recognition.reprocess({ again: (await readBody(req)).again === true }));
  }
  if (parts[1] === 'persons') {
    needAdmin();
    const id = Number(parts[2]);
    if (!parts[2] && req.method === 'GET') return json(res, 200, db.listPersons());
    if (parts[3] === 'merge' && req.method === 'POST') {
      const into = Number((await readBody(req)).into);
      if (!into || into === id) throw new Error('Persona di destinazione non valida');
      if (db.personSpecies(id) !== db.personSpecies(into)) throw new Error('Si possono unire solo persone con persone e animali della stessa specie');
      db.mergePersons(id, into);
      recognition.invalidateFaces();
      return json(res, 200, { ok: true });
    }
    if (parts[3] === 'suggestion' && req.method === 'POST') { // conferma (unisce) o scarta il suggerimento di somiglianza
      const p = db.listPersons().find((x) => x.id === id);
      if (!p) throw new HttpError(404, 'Non trovato');
      if ((await readBody(req)).accept === true && p.suggestId) {
        db.mergePersons(id, p.suggestId);
        recognition.invalidateFaces();
      } else db.clearSuggestion(id);
      return json(res, 200, { ok: true });
    }
    if (parts[3] === 'faces') { // immagini imparate di un soggetto: elenco, rimozione o spostamento di una sbagliata
      if (!parts[4] && req.method === 'GET') return json(res, 200, db.facesOfPerson(id));
      const faceId = Number(parts[4]);
      if (!db.facesOfPerson(id).some((f) => f.id === faceId)) throw new HttpError(404, 'Immagine non trovata');
      if (!parts[5] && req.method === 'DELETE') {
        for (const rel of db.removeFace(faceId) || []) fs.rm(path.join(db.EVENTS_DIR, rel), { force: true }, () => {});
        recognition.invalidateFaces();
        return json(res, 200, { ok: true });
      }
      if (parts[5] === 'move' && req.method === 'POST') {
        const raw = (await readBody(req)).into;
        const into = raw === 'new' ? db.createPerson(null, db.personSpecies(id)) : Number(raw);
        if (!into || into === id || db.personSpecies(into) !== db.personSpecies(id)) throw new HttpError(400, 'Soggetto di destinazione non valido');
        db.moveFace(faceId, into);
        recognition.invalidateFaces();
        return json(res, 200, { ok: true, into });
      }
    }
    if (req.method === 'PUT') {
      const name = String((await readBody(req)).name || '').trim().slice(0, 60) || null;
      const same = name && db.personByName(name);
      // Dare a una persona il nome di un'altra già nota significa che sono la stessa: si uniscono.
      if (same && same.id !== id && db.personSpecies(same.id) === db.personSpecies(id)) db.mergePersons(id, same.id);
      else db.renamePerson(id, name);
      recognition.invalidateFaces();
      return json(res, 200, { ok: true });
    }
    if (req.method === 'DELETE') {
      for (const rel of db.deletePerson(id)) fs.rm(path.join(db.EVENTS_DIR, rel), { force: true }, () => {});
      recognition.invalidateFaces();
      return json(res, 200, { ok: true });
    }
  }

  // ----- eventi -----
  if (parts[1] === 'events') {
    if (parts[2] === 'stream' && req.method === 'GET') return events.sseHandler(req, res, (camId) => auth.levelFor(user, camId) > 0);
    if (parts[2] === 'test' && req.method === 'POST') {
      needAdmin();
      const body = await readBody(req);
      const cam = byId(String(body.camId));
      if (!cam) throw new HttpError(404, 'Telecamera non trovata');
      const kind = EVENT_KINDS.includes(body.kind) ? body.kind : 'person';
      events.raise(cam, kind, { test: true, persist: body.persist === true });
      return json(res, 200, { ok: true });
    }
    if (parts[2] === 'delete-many' && req.method === 'POST') { // eliminazione di più eventi (solo amministratore)
      needAdmin();
      const ids = (await readBody(req)).ids;
      if (!Array.isArray(ids) || !ids.length || ids.length > 500) throw new HttpError(400, 'Elenco di eventi non valido');
      let n = 0;
      for (const raw of ids) {
        const e = db.deleteEvent(Number(raw));
        if (!e) continue;
        n++;
        for (const rel of [e.snapshot, e.clip, e.preview, e.tracks]) if (rel) fs.rm(path.join(db.EVENTS_DIR, rel), { force: true }, () => {});
        if (e.archived && e.clip) archive.remove(e.clip).catch(() => {});
      }
      return json(res, 200, { deleted: n });
    }
    if (parts[2] === 'unseen' && req.method === 'GET') { // eventi arrivati dopo l'ultima volta che l'utente ha guardato l'elenco
      const since = Number(url.searchParams.get('since')) || 0;
      const allowed = cameras.filter((c) => level(c.id) > 0).map((c) => c.id);
      return json(res, 200, { n: db.countEventsSince(since, allowed), now: Date.now() });
    }
    if (!parts[2] && req.method === 'GET') {
      const q = Object.fromEntries(url.searchParams);
      const visible = cameras.filter((c) => level(c.id) > 0);
      const parsed = search.parse(q.q || '', { cameras: visible, usePersons: isAdmin });
      const filter = { ...parsed.filter };
      if (q.cam) filter.camIds = [q.cam];
      if (q.person && isAdmin) filter.personIds = [Number(q.person)];
      if (q.kind) filter.kinds = [q.kind];
      if (q.from) filter.from = Number(q.from);
      if (q.to) filter.to = Number(q.to);
      filter.limit = Math.min(200, Number(q.limit) || 60);
      filter.offset = Number(q.offset) || 0;
      if (!isAdmin) {
        // Solo le telecamere abilitate (anche nelle ricerche per nome): senza telecamere non si restituisce nulla.
        const allowed = visible.map((c) => c.id);
        filter.camIds = (filter.camIds || allowed).filter((id) => allowed.includes(id));
        if (!filter.camIds.length) return json(res, 200, { interpreted: parsed.summary, events: [], counts: { events: 0 } });
      }
      const list = db.queryEvents(filter);
      return json(res, 200, {
        interpreted: parsed.summary,
        events: isAdmin ? list : list.map(PUBLIC_ONLY_FIELDS),
        counts: isAdmin ? db.counts() : { events: 0 },
      });
    }
    if (parts[2] && req.method === 'GET') {
      const e = db.getEvent(Number(parts[2]));
      if (!e || (!isAdmin && level(e.camId) < 1)) throw new HttpError(404, 'Evento non trovato');
      return json(res, 200, isAdmin ? e : PUBLIC_ONLY_FIELDS(e));
    }
    if (parts[2] && parts[3] === 'hub-original' && req.method === 'GET') { // filmato originale (qualità piena) dalla scheda dell'hub Reolink
      const e = db.getEvent(Number(parts[2]));
      if (!e || level(e.camId) < 1) throw new HttpError(404, 'Evento non trovato');
      const cam = byId(e.camId);
      const name = e.meta?.hubMain || e.meta?.hubName;
      if (!cam || !name) throw new HttpError(404, 'Nessuna registrazione dell’hub per questo evento');
      const src = await reolink.openDownload(cam, name);
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Disposition': `attachment; filename="${cam.name.replace(/[^\w.-]+/g, '_')}_${name.slice(0, 40)}.mp4"`, ...(src.headers['content-length'] ? { 'Content-Length': src.headers['content-length'] } : {}) });
      src.pipe(res);
      res.on('close', () => src.destroy());
      return;
    }
    if (parts[2] && parts[3] === 'kind' && req.method === 'POST') { // toglie o cambia il tag (tipo) di un evento; un falso allarme fa imparare
      needAdmin();
      const eventId = Number(parts[2]);
      const e = db.getEvent(eventId);
      if (!e) throw new HttpError(404, 'Evento non trovato');
      const body = await readBody(req);
      const kind = EVENT_KINDS.includes(body.kind) ? body.kind : 'motion';
      const meta = { ...(e.meta || {}) };
      if (body.falseAlarm === true && ['fire', 'flood'].includes(e.kind)) {
        meta.falseAlarm = { kind: e.kind, at: Date.now() };
        hazardLearn.report(e.camId, e.kind, meta.bbox);
      }
      db.updateEvent(eventId, { kind, meta });
      const fresh = db.getEvent(eventId);
      events.bus.emit('event-update', { id: eventId, camId: e.camId, kind });
      return json(res, 200, fresh);
    }
    if (parts[2] && parts[3] === 'reanalyze' && req.method === 'POST') { // rifà da zero il riconoscimento di un solo evento
      needAdmin();
      const r = await recognition.reanalyze(Number(parts[2]));
      for (const rel of r.crops) fs.rm(path.join(db.EVENTS_DIR, rel), { force: true }, () => {});
      return json(res, 200, { ok: true });
    }
    if (parts[2] && parts[3] === 'subject' && req.method === 'POST') { // corregge chi/cosa e' stato riconosciuto nell'evento
      needAdmin();
      // Un evento puo' avere piu' soggetti (persone, animali, veicoli): si agisce su uno alla volta.
      //  { action: 'change', from, to: id|'new' }  sostituisce un soggetto
      //  { action: 'remove', from }               toglie un soggetto (e la sua immagine imparata)
      //  { action: 'add', to: id|'new', group }    aggiunge un altro soggetto presente nel video
      const eventId = Number(parts[2]);
      const e = db.getEvent(eventId);
      if (!e) throw new HttpError(404, 'Evento non trovato');
      const body = await readBody(req);
      const action = body.action;
      const from = body.from == null ? null : Number(body.from);
      if (action !== 'add' && !e.subjects.some((s) => s.id === from)) throw new HttpError(400, 'Soggetto non presente nell\'evento');
      let to = null;
      if (action === 'change' || action === 'add') {
        const group = action === 'change' ? db.subjectGroupOfSpecies(db.personSpecies(from)) : ['people', 'pets', 'vehicles'].includes(body.group) ? body.group : db.subjectGroupOfKind(e.kind);
        if (body.to === 'new') {
          const species = action === 'change' ? db.personSpecies(from) : group === 'vehicles' ? (e.vehicleType || 'car') : group === 'pets' ? 'dog' : null;
          to = db.createPerson(null, species);
        } else {
          to = Number(body.to);
          if (!to || !db.personExists(to) || db.subjectGroupOfSpecies(db.personSpecies(to)) !== group) throw new HttpError(400, 'Soggetto non valido');
        }
      } else if (action !== 'remove') throw new HttpError(400, 'Azione non valida');
      for (const rel of db.replaceSubject(eventId, action === 'add' ? null : from, action === 'remove' ? null : to) || []) fs.rm(path.join(db.EVENTS_DIR, rel), { force: true }, () => {});
      recognition.invalidateFaces();
      return json(res, 200, db.getEvent(eventId));
    }
    if (parts[2] && req.method === 'DELETE') {
      needAdmin();
      const e = db.deleteEvent(Number(parts[2]));
      for (const rel of [e?.snapshot, e?.clip, e?.preview, e?.tracks]) if (rel) fs.rm(path.join(db.EVENTS_DIR, rel), { force: true }, () => {});
      if (e?.archived && e.clip) archive.remove(e.clip).catch(() => {}); // anche dall'archivio di rete
      return json(res, 200, { ok: true });
    }
  }

  // ----- telecamere -----
  if (parts[1] === 'cameras') {
    const id = parts[2];
    if (!id && req.method === 'GET') return json(res, 200, cameras.filter((c) => level(c.id) > 0).map((c) => pubFor(user, c)));
    if (id === 'order' && req.method === 'PUT') {
      needAdmin();
      const ids = (await readBody(req)).ids;
      if (!Array.isArray(ids)) throw new Error('Ordine non valido');
      const rank = (c) => (ids.indexOf(c.id) < 0 ? Infinity : ids.indexOf(c.id));
      cameras.sort((a, b) => rank(a) - rank(b));
      saveCameras();
      return json(res, 200, { ok: true });
    }
    if (!id && req.method === 'POST') {
      needAdmin();
      const input = await readBody(req);
      // Canale di un hub Reolink trovato dalla ricerca: utente e password sono quelli di una telecamera già aggiunta
      // sullo stesso hub (non passano dal browser).
      const src = input.copyCredentialsFrom ? byId(String(input.copyCredentialsFrom)) : null;
      if (src && src.brand === 'reolink' && input.brand === 'reolink' && src.params.host === input.params?.host) {
        input.params = { ...input.params, username: input.params.username || src.params.username, password: input.params.password || src.params.password };
      }
      const cam = cameraFromInput(input);
      cameras.push(cam);
      saveCameras();
      await restartGo2rtc();
      events.refresh();
      return json(res, 201, pubFor(user, cam));
    }
    if (!id) throw new HttpError(404, 'Non trovato');
    const index = cameras.findIndex((c) => c.id === id);
    if (index < 0 || level(id) < 1) throw new HttpError(404, 'Telecamera non trovata');
    const cam = cameras[index];

    // Ultima immagine in diretta di una telecamera: la manda il browser che la sta guardando (circa una al minuto) e si
    // mostra, dipinta di verde, quando la telecamera è offline o spenta.
    if (parts[3] === 'lastframe') {
      const file = path.join(LASTFRAME_DIR, `${cam.id}.jpg`);
      if (req.method === 'GET') {
        let st;
        try { st = fs.statSync(file); } catch { throw new HttpError(404, 'Non trovato'); }
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': st.size, 'Cache-Control': 'no-cache', 'X-Taken': String(Math.round(st.mtimeMs)) });
        return fs.createReadStream(file).pipe(res);
      }
      if (req.method === 'PUT') {
        if (cam.privacy?.on) return json(res, 200, { skipped: true }); // con la privacy attiva non si conserva nulla
        const buf = await readRaw(req, 400_000);
        if (buf.length < 500 || buf[0] !== 0xff || buf[1] !== 0xd8) throw new HttpError(400, 'Immagine non valida');
        try { if (Date.now() - fs.statSync(file).mtimeMs < 45_000) return json(res, 200, { skipped: true }); } catch { /* prima immagine */ }
        fs.mkdirSync(LASTFRAME_DIR, { recursive: true });
        fs.writeFileSync(file, buf);
        return json(res, 200, { ok: true });
      }
    }

    if (parts[3] === 'wake' && req.method === 'POST') {
      // Eufy: la telecamera va svegliata dal server (può richiedere decine di secondi).
      // Reolink: è l'hub a svegliarla quando si apre il flusso, non serve altro.
      if (cam.brand === 'eufyp2p') await eufy.wake(cam);
      else if (cam.brand === 'reolink' && cam.battery && (await reolink.channelOnline(cam).catch(() => null)) === false) {
        throw new HttpError(409, "La telecamera risulta offline per l'hub (batteria scarica o fuori portata)", 'CAM_OFFLINE');
      }
      return json(res, 200, { ok: true });
    }

    if (parts[3] === 'network' && req.method === 'GET') { // indirizzo, rete e segnale (solo amministratore)
      needAdmin();
      return json(res, 200, await netinfo.getInfo(cam));
    }
    if (parts[3] === 'reboot' && req.method === 'POST') { // riavvio della telecamera, dove possibile
      needAdmin();
      try {
        return json(res, 200, await netinfo.reboot(cam));
      } catch (err) {
        if (err.message === 'NOT_SUPPORTED') throw new HttpError(400, 'Questa telecamera non si può riavviare da qui', 'NOT_SUPPORTED');
        throw err;
      }
    }

    if (parts[3] === 'ha') {
      if (parts[4] === undefined && req.method === 'PUT') { // elenco delle icone (solo amministratore)
        needAdmin();
        const items = haLib.cleanItems((await readBody(req)).items);
        if (items.length) cam.ha = items; else delete cam.ha;
        saveCameras();
        return json(res, 200, pubFor(user, cam));
      }
      if (parts[5] === 'power' && req.method === 'POST') { // accende/spegne: serve il controllo della telecamera
        camFor(id, 2);
        const item = cam.ha?.[Number(parts[4])];
        if (!item) throw new HttpError(404, 'Icona non trovata');
        const { on } = await readBody(req);
        const st = await haLib.setPower(item.entity, on === true);
        return json(res, 200, { i: Number(parts[4]), state: st.state, available: st.available });
      }
      throw new HttpError(404, 'Non trovato');
    }

    if (parts[3] === 'privacy' && req.method === 'POST') {
      camFor(id, 2);
      if (cam.brand !== 'reolink') throw new HttpError(400, 'Modalità privacy disponibile solo per telecamere Reolink');
      const body = await readBody(req);
      return json(res, 200, await privacy.set(cam, body.enable === true));
    }

    if (parts[3] === 'eufy') {
      camFor(id, 2);
      if (cam.brand !== 'eufyp2p') throw new HttpError(400, 'Disponibile solo per telecamere Eufy');
      if (parts[4] === 'settings' && req.method === 'GET') return json(res, 200, await eufySettings.getSettings(cam));
      if (parts[4] === 'set' && req.method === 'POST') {
        const body = await readBody(req);
        return json(res, 200, await eufySettings.setSetting(cam, String(body.key), body.value));
      }
      throw new HttpError(404, 'Non trovato');
    }

    if (parts[3] === 'reolink') {
      camFor(id, 2);
      if (cam.brand !== 'reolink') throw new HttpError(400, 'Disponibile solo per telecamere Reolink');
      const what = parts[4];
      if (what === 'settings' && req.method === 'GET') return json(res, 200, await reolink.getSettings(cam));
      if (what === 'channels' && req.method === 'GET') { needAdmin(); return json(res, 200, await reolink.channels(cam)); }
      if (req.method === 'POST') {
        const body = await readBody(req);
        if (what === 'set') return json(res, 200, await reolink.setGroup(cam, String(body.group), body.changes));
        if (what === 'ptz') return json(res, 200, await reolink.ptz(cam, body));
        if (what === 'action') return json(res, 200, await reolink.action(cam, body));
      }
      throw new HttpError(404, 'Non trovato');
    }
    if (req.method === 'PUT') {
      needAdmin();
      reolink.forgetSession(cam);
      eufy.stopCamera(id);
      cameras[index] = cameraFromInput(await readBody(req), cam);
      saveCameras();
      await restartGo2rtc();
      events.refresh();
      return json(res, 200, pubFor(user, cameras[index]));
    }
    if (req.method === 'DELETE') {
      needAdmin();
      eufy.stopCamera(id);
      cameras.splice(index, 1);
      saveCameras();
      auth.removeCamera(id);
      await restartGo2rtc();
      return json(res, 200, { ok: true });
    }
  }
  throw new HttpError(404, 'Non trovato');
}

function apiError(res, err) {
  if (err instanceof HttpError) return json(res, err.status, { error: err.message, code: err.code });
  if (err instanceof auth.AuthError) {
    const status = err.code === 'INVALID' ? 401 : err.code === 'LOCKED' ? 429 : err.code === 'NOT_FOUND' ? 404 : 400;
    return json(res, status, { error: err.message, code: err.code, retryAfter: err.retryAfter }, err.retryAfter ? { 'Retry-After': String(err.retryAfter) } : {});
  }
  return json(res, 400, { error: err.message });
}

// ---------- proxy verso go2rtc ----------
// Dal browser passano solo il player e i flussi delle telecamere consentite: mai gli altri percorsi di go2rtc
// (configurazione, elenco dei flussi) né sorgenti arbitrarie (src=rtsp://…), che permetterebbero di far aprire
// indirizzi qualsiasi al server.
const STREAM_RE = /^(cam_[0-9a-f]{8})_(main|sub|main_a|sub_a|talk)$/;
const GO2RTC_PATHS = new Set(['/api/ws', '/api/webrtc', '/api/frame.jpeg']);

function go2rtcAllowed(user, method, url) {
  const p = url.pathname.slice('/go2rtc'.length);
  if (p === '/video-rtc.js') return method === 'GET'; // solo codice del player: serve anche prima del cambio password
  if (user.mustChange) return false;
  if (!GO2RTC_PATHS.has(p)) return false;
  if (method !== 'GET' && !(method === 'POST' && p === '/api/webrtc')) return false;
  const srcs = url.searchParams.getAll('src');
  if (srcs.length !== 1) return false;
  const m = STREAM_RE.exec(srcs[0]);
  if (!m || !byId(m[1])) return false;
  return auth.levelFor(user, m[1]) >= (m[2] === 'talk' ? 2 : 1); // parlare richiede il controllo della telecamera
}

function proxyHttp(req, res, url) {
  const headers = { ...req.headers, host: `${GO2RTC_API.host}:${GO2RTC_API.port}` };
  delete headers.cookie; // il cookie di sessione non deve mai arrivare a go2rtc
  delete headers.authorization;
  const upstream = http.request(
    { ...GO2RTC_API, method: req.method, path: url.pathname.slice('/go2rtc'.length) + url.search, headers },
    (up) => {
      res.writeHead(up.statusCode, up.headers);
      up.pipe(res);
    },
  );
  upstream.on('error', () => {
    if (!res.headersSent) json(res, 502, { error: 'Motore video non raggiungibile' });
    else res.destroy();
  });
  req.pipe(upstream);
}

// ---------- certificato per i telefoni ----------
// Si scarica il certificato dell'autorità locale (CERT_DOWNLOAD) se c'è, altrimenti quello del server.
const certPath = () => process.env.CERT_DOWNLOAD || process.env.TLS_CERT;
const certFileOk = () => { try { return !!certPath() && fs.statSync(certPath()).isFile(); } catch { return false; } };
const certDownloadAvailable = () => certFileOk() && auth.certPasswordSet();

function readForm(req, limit = 4000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('Richiesta troppo grande')); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => resolve(new URLSearchParams(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', reject);
  });
}

/** Profilo di configurazione Apple che installa il certificato come autorità attendibile (UUID fissi: reinstallare lo sostituisce). */
function iosProfile(pem) {
  const cert = new crypto.X509Certificate(pem);
  const hex = createHash('sha256').update(cert.raw).digest('hex');
  const uuid = (o) => `${hex.slice(o, o + 8)}-${hex.slice(o + 8, o + 12)}-${hex.slice(o + 12, o + 16)}-${hex.slice(o + 16, o + 20)}-${hex.slice(o + 20, o + 32)}`.toUpperCase();
  const der = cert.raw.toString('base64').replace(/(.{64})/g, '$1\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadCertificateFileName</key><string>cam-app.crt</string>
      <key>PayloadContent</key>
      <data>${der}</data>
      <key>PayloadDescription</key><string>Certificato del server Argo</string>
      <key>PayloadDisplayName</key><string>Argo</string>
      <key>PayloadIdentifier</key><string>app.camapp.certificate.${hex.slice(0, 12)}</string>
      <key>PayloadType</key><string>com.apple.security.root</string>
      <key>PayloadUUID</key><string>${uuid(0)}</string>
      <key>PayloadVersion</key><integer>1</integer>
    </dict>
  </array>
  <key>PayloadDescription</key><string>Fa riconoscere come attendibile il server Argo su questo dispositivo.</string>
  <key>PayloadDisplayName</key><string>Argo</string>
  <key>PayloadIdentifier</key><string>app.camapp.profile.${hex.slice(0, 12)}</string>
  <key>PayloadRemovalDisallowed</key><false/>
  <key>PayloadType</key><string>Configuration</string>
  <key>PayloadUUID</key><string>${uuid(32)}</string>
  <key>PayloadVersion</key><integer>1</integer>
</dict>
</plist>
`;
}

/** POST /cert/download: con la password giusta scarica il certificato pubblico (mai la chiave). */
async function certDownload(req, res) {
  const back = (code) => res.writeHead(303, { Location: `/cert.html?e=${code}`, 'Cache-Control': 'no-store' }).end();
  if (!sameOrigin(req)) return back('origin');
  if (!certDownloadAvailable()) return back('off');
  let form;
  try { form = await readForm(req); } catch { return back('bad'); }
  try {
    await auth.verifyCertPassword(form.get('password'), { ip: clientIp(req) });
  } catch (err) {
    return back(err.code === 'LOCKED' ? 'locked' : 'bad');
  }
  // iPhone/iPad: un profilo di configurazione (.mobileconfig) si installa con un tocco, senza passare dalle impostazioni
  // per cercare il file. Resta solo da attivare la fiducia in Impostazioni (iOS non permette di farlo da un profilo).
  const format = form.get('format') === 'ios' || (form.get('format') !== 'crt' && /iPhone|iPad|iPod/.test(req.headers['user-agent'] || '')) ? 'ios' : 'crt';
  try { certPayload(format); } catch { return back('bad'); }
  // Il file non si manda come risposta al modulo: Safari su iOS, dopo "Consenti", richiede di nuovo lo stesso indirizzo
  // (con GET) e avrebbe trovato "non trovato". Si risponde con un rinvio a un indirizzo temporaneo, scaricabile
  // più volte per 10 minuti.
  const token = randomBytes(16).toString('hex');
  certTokens.set(token, { format, exp: Date.now() + 10 * 60_000 });
  for (const [k, v] of certTokens) if (v.exp < Date.now()) certTokens.delete(k);
  res.writeHead(303, { Location: `/cert/get/${token}`, 'Cache-Control': 'no-store' }).end();
}

const certTokens = new Map(); // token -> { format, exp }

function certPayload(format) {
  const pem = fs.readFileSync(certPath());
  if (format === 'ios') {
    const profile = iosProfile(pem);
    return { body: Buffer.from(profile), type: 'application/x-apple-aspen-config', name: 'cam-app.mobileconfig' };
  }
  return { body: pem, type: 'application/x-x509-ca-cert', name: 'cam-app.crt' };
}

/** GET /cert/get/<token>: scarica il certificato o il profilo preparato dopo la password giusta. */
function certGet(req, res, token) {
  const t = certTokens.get(token);
  if (!t || t.exp < Date.now() || !certDownloadAvailable()) return res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Link scaduto: torna alla pagina del certificato e inserisci di nuovo la password.');
  let f;
  try { f = certPayload(t.format); } catch { return res.writeHead(500).end(); }
  res.writeHead(200, {
    'Content-Type': f.type,
    'Content-Disposition': `attachment; filename="${f.name}"`,
    'Content-Length': f.body.length,
    'Cache-Control': 'no-store',
  });
  res.end(f.body);
}

// ---------- file statici ----------
// Senza accesso si vede solo la pagina di ingresso (e ciò che serve a mostrarla).
const PUBLIC_FILES = new Set([
  '/cert.html', '/cert.js', '/login.html', '/login.js', '/style.css', '/i18n.js', '/manifest.webmanifest', '/icon.svg', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png',
]);
const ADMIN_FILES = new Set(['/admin.html', '/admin.js']);

function serveStatic(res, pathname, req) {
  const rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
  const file = path.join(PUBLIC, path.normalize(rel));
  if (!file.startsWith(PUBLIC + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Non trovato');
      return;
    }
    const headers = { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' };
    // Il grande elenco delle icone (mdi.json, ~2,6 MB) si comprime e si rivalida con ETag: si scarica una volta sola.
    if (req && file.endsWith('mdi.json')) {
      const etag = `"${createHash('sha1').update(data).digest('hex').slice(0, 16)}"`;
      headers.ETag = etag;
      if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers).end(); return; }
      if (/\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) {
        headers['Content-Encoding'] = 'gzip';
        headers.Vary = 'Accept-Encoding';
        data = zlib.gzipSync(data, { level: 6 });
      }
    }
    res.writeHead(200, headers);
    res.end(data);
  });
}

const redirectToLogin = (res, url) => {
  const next = url.pathname === '/' ? '' : `?next=${encodeURIComponent(url.pathname + url.search)}`;
  res.writeHead(302, { Location: `/login.html${next}`, 'Cache-Control': 'no-store' }).end();
};

// ---------- server ----------
function onRequest(req, res) {
  langStore.run(langOf(req), () => handleRequest(req, res));
}

function handleRequest(req, res) {
  securityHeaders(res, req);
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    if (p === '/healthz') return json(res, 200, { ok: true });
    if (p === '/cert/download' && req.method === 'GET') return res.writeHead(303, { Location: '/cert.html' }).end(); // aperto per errore con GET
    if (p.startsWith('/cert/get/') && req.method === 'GET' && /^[0-9a-f]{32}$/.test(p.slice(10))) return certGet(req, res, p.slice(10));
    if (p === '/cert/download' && req.method === 'POST') { certDownload(req, res).catch(() => res.headersSent || res.writeHead(500).end()); return; }

    const user = userOf(req);
    req.user = user;

    if (p.startsWith('/api/')) {
      handleApi(req, res, url).catch((err) => apiError(res, err));
      return;
    }
    if (p.startsWith('/media/') || p.startsWith('/go2rtc/')) {
      if (!user) return json(res, 401, { error: 'Accesso richiesto', code: 'UNAUTHENTICATED' });
      if (p.startsWith('/media/')) {
        if (user.mustChange) return res.writeHead(403).end();
        return serveMedia(req, res, decodeURIComponent(p.slice('/media/'.length)), user);
      }
      if (!sameOrigin(req)) return json(res, 403, { error: 'Origine non consentita' });
      if (!go2rtcAllowed(user, req.method, url)) return json(res, 403, { error: 'Flusso non consentito' });
      return proxyHttp(req, res, url);
    }
    if (PUBLIC_FILES.has(p)) return serveStatic(res, p, req);
    if (!user) return redirectToLogin(res, url);
    if (ADMIN_FILES.has(p) && user.role !== 'admin') return res.writeHead(403, { 'Content-Type': 'text/plain' }).end(tr('Riservato agli amministratori'));
    return serveStatic(res, p, req);
  } catch (err) {
    console.error('[richiesta]', err);
    if (!res.headersSent) res.writeHead(500).end();
  }
}

// HTTPS se sono indicati certificato e chiave (il microfono e le notifiche dei browser lo richiedono fuori da localhost).
let serverIsTls = false;
let server;
try {
  const { TLS_CERT, TLS_KEY } = process.env;
  if (TLS_CERT && TLS_KEY) {
    server = https.createServer({ cert: fs.readFileSync(TLS_CERT), key: fs.readFileSync(TLS_KEY) }, onRequest);
    serverIsTls = true;
  }
} catch (err) {
  console.error(`Certificato HTTPS non utilizzabile (${err.message}): si parte in HTTP`);
}
server ??= http.createServer(onRequest);

// WebSocket verso go2rtc (segnalazione WebRTC + flusso MSE), con le stesse regole del proxy HTTP.
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  const user = userOf(req);
  if (!user || !url.pathname.startsWith('/go2rtc/') || !sameOrigin(req) || !go2rtcAllowed(user, 'GET', url)) {
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    return;
  }
  const upstream = net.connect(GO2RTC_API.port, GO2RTC_API.host, () => {
    const headers = { ...req.headers, host: `${GO2RTC_API.host}:${GO2RTC_API.port}` };
    delete headers.origin; // già verificata qui sopra
    delete headers.cookie;
    const lines = [`GET ${url.pathname.slice('/go2rtc'.length)}${url.search} HTTP/1.1`];
    for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
    upstream.write(lines.join('\r\n') + '\r\n\r\n');
    if (head?.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  const close = () => {
    socket.destroy();
    upstream.destroy();
  };
  upstream.on('error', close);
  socket.on('error', close);
});

// Server interno (solo 127.0.0.1): il flusso grezzo delle Eufy per il solo ffmpeg avviato da go2rtc.
http
  .createServer((req, res) => {
    const p = new URL(req.url, 'http://localhost').pathname;
    const cam = p.startsWith('/internal/eufy/') && cameras.find((c) => c.id === decodeURIComponent(p.slice('/internal/eufy/'.length)) && c.brand === 'eufyp2p');
    if (!cam) return res.writeHead(404).end();
    res.writeHead(200, { 'Content-Type': 'video/h264', 'Cache-Control': 'no-store', Connection: 'close' });
    return eufy.streamTo(cam, res);
  })
  .listen(INTERNAL_PORT, '127.0.0.1');

// Con HTTPS, chi apre http:// su questa porta (o la porta 80, se attiva) viene mandato all'indirizzo https invece di
// ricevere una connessione chiusa ("la connessione di rete è stata persa" su Safari).
const redirectToHttps = (req, res) => {
  const host = String(req.headers.host || '').replace(/:\d+$/, '');
  if (!/^[A-Za-z0-9.\-[\]:]+$/.test(host)) return res.writeHead(400).end();
  res.writeHead(301, { Location: `https://${host}:${PORT}${req.url || '/'}`, 'Cache-Control': 'no-store' }).end();
};

let front = server;
if (serverIsTls) {
  const plain = http.createServer(redirectToHttps);
  front = net.createServer({ pauseOnConnect: true }, (sock) => {
    sock.on('error', () => {});
    sock.setTimeout(15000, () => sock.destroy());
    sock.once('data', (buf) => {
      sock.pause();
      sock.setTimeout(0);
      sock.unshift(buf);
      // Un messaggio TLS inizia con 0x16; altrimenti è HTTP in chiaro.
      (buf[0] === 0x16 ? server : plain).emit('connection', sock);
      process.nextTick(() => sock.resume());
    });
    sock.resume(); // la connessione parte in pausa (pauseOnConnect): serve per leggere il primo byte
  });
  const extra = Number(process.env.HTTP_REDIRECT_PORT || 0);
  if (extra) {
    http.createServer(redirectToHttps).on('error', (err) => console.error(`Reindirizzamento sulla porta ${extra} non attivo: ${err.message}`)).listen(extra, HOST);
  }
}

let patchTimer = null;
await auth.ensureAdmin();
front.listen(PORT, HOST, () => {
  console.log(`Argo pronta: ${serverIsTls ? 'https' : 'http'}://${HOST === '0.0.0.0' ? '<indirizzo-del-server>' : 'localhost'}:${PORT}`);
  startGo2rtc();
  eufy.startWatcher(() => cameras);
  privacy.start(() => cameras);
  haLib.startPolling(() => cameras.flatMap((c) => (c.ha || []).map((h) => h.entity)));
  recognition.start();
  archive.start();
  battery.start(() => cameras);
  hazard.start(() => cameras, events.raise);
  events.start({
    getCameras: () => cameras,
    patchCamera: (id, patch) => {
      const cam = byId(id);
      if (!cam) return;
      Object.assign(cam, patch);
      saveCameras();
      // La telecamera a batteria non va più tenuta connessa in anticipo: un solo riavvio per tutte le modifiche.
      clearTimeout(patchTimer);
      patchTimer = setTimeout(restartGo2rtc, 2000);
    },
  });
});
