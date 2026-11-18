// Gestore degli streaming Eufy P2P locali.
//
// Per ogni telecamera tiene UNA sola sessione P2P e ne distribuisce il flusso H.264
// (Annex-B) a tutti i lettori collegati (i processi ffmpeg avviati da go2rtc per il
// flusso principale e secondario). La sessione parte quando arriva il primo lettore e
// si ferma poco dopo l'ultimo: così le telecamere a batteria trasmettono solo mentre
// le guardi. L'accountId e gli abbinamenti seriale→DID arrivano da data/eufy-account.json
// (scritto una volta sola dall'accesso al cloud).
import fs from 'node:fs';
import path from 'node:path';
import dgram from 'node:dgram';
import os from 'node:os';
import { EufySession } from './eufy-p2p.js';
import { bus } from './events.js';
import { DATA } from './paths.js';
import * as battery from './battery.js';
import * as cloud from './eufy-cloud.js';

const ACCOUNT_FILE = path.join(DATA, 'eufy-account.json');
const IDLE_STOP_MS = 8000;
const SETTINGS_KEEP_MS = 20000; // dopo le impostazioni la sessione resta aperta per le modifiche successive
const WAKE_KEEP_MS = 30000; // dopo una sveglia la sessione resta aperta in attesa del lettore

let accountCache = { mtime: 0, data: null };
function account() {
  try {
    const mtime = fs.statSync(ACCOUNT_FILE).mtimeMs;
    if (mtime !== accountCache.mtime) accountCache = { mtime, data: JSON.parse(fs.readFileSync(ACCOUNT_FILE, 'utf8')) };
  } catch {
    accountCache = { mtime: 0, data: null };
  }
  return accountCache.data;
}

/** Vero se l'accesso al cloud è stato completato (file presente con accountId). */
export function isConfigured() {
  return !!account()?.accountId;
}

/** Telecamere Eufy note all'account: [{ serial, did }]. */
export function accountDevices() {
  return Object.entries(account()?.cameras || {}).map(([serial, c]) => ({ serial, did: c.did || null, name: c.name || null }));
}

/** Formato del flusso grezzo che ffmpeg deve aspettarsi: la SoloCam S340 (T8170) trasmette in H.265, le altre in H.264. */
export const rawFormatOf = (serial) => (/^T8170/.test(String(serial)) ? 'hevc' : 'h264');

// ---------- ricerca in rete ----------
const hostCache = new Map(); // seriale -> ultimo IP noto

const didFromReply = (m) => {
  const t = (b) => b.toString('latin1').replace(/\0+$/, '');
  return `${t(m.subarray(4, 12))}-${String(m.readUInt32BE(12)).padStart(6, '0')}-${t(m.subarray(16, 24))}`;
};

/**
 * Cerca le Eufy in rete (UDP 32108). Le telecamere a batteria che dormono non rispondono.
 * `hosts` aggiunge richieste mirate a IP già noti (alcune ignorano il broadcast).
 */
export async function discover({ ms = 3500, hosts = [] } = {}) {
  const byDid = new Map(accountDevices().map((d) => [d.did, d.serial]));
  const found = new Map();
  const sock = dgram.createSocket('udp4');
  sock.on('message', (m, r) => {
    if (m.length >= 24 && m[0] === 0xf1 && m[1] === 0x41) found.set(r.address, didFromReply(m));
  });
  sock.on('error', () => {});
  await new Promise((resolve) => sock.bind(0, resolve));
  sock.setBroadcast(true);
  const subnets = new Set(['255.255.255.255']);
  for (const h of hosts) if (h) subnets.add(h.replace(/\d+$/, '255'));
  const targets = [...subnets, ...hosts.filter(Boolean)];
  const end = Date.now() + ms;
  while (Date.now() < end) {
    for (const t of targets) sock.send(Buffer.from('f1300000', 'hex'), 32108, t, () => {});
    await new Promise((r) => setTimeout(r, 450));
  }
  sock.close();
  return [...found].map(([ip, did]) => {
    const serial = byDid.get(did) || null;
    if (serial) rememberHost(serial, ip);
    return { ip, did, serial };
  });
}

// ---------- sveglia a richiesta delle telecamere a batteria ----------
// Una SoloCam "addormentata" tiene la rete Wi-Fi in risparmio energia e si accorge dei pacchetti solo a intervalli;
// ne basta uno di ricerca (UDP 32108) che arrivi nel momento giusto perché risponda e si tenga sveglia per qualche
// secondo. Quindi: pacchetti di ricerca ravvicinati e continui (broadcast + IP noto) finché risponde, e collegamento
// IMMEDIATO alla risposta (dopo pochi secondi può già dormire di nuovo). Gli IP si ricordano su disco: gli indirizzi
// dati dal DHCP non sono scritti nella configurazione delle telecamere.
const HOSTS_FILE = path.join(DATA, 'eufy-hosts.json');
const persistedHosts = (() => { try { return JSON.parse(fs.readFileSync(HOSTS_FILE, 'utf8')); } catch { return {}; } })();
const rememberHost = (serial, ip) => {
  if (!serial || !ip || hostCache.get(serial) === ip && persistedHosts[serial] === ip) return;
  hostCache.set(serial, ip);
  persistedHosts[serial] = ip;
  try { fs.writeFileSync(HOSTS_FILE, JSON.stringify(persistedHosts)); } catch { /* non fatale */ }
};
const knownHost = (cam) => cam.params.host || hostCache.get(cam.params.serial) || persistedHosts[cam.params.serial] || null;

/** Indirizzi di broadcast delle reti locali di questo server (es. 192.168.1.255). */
function localBroadcasts() {
  const out = new Set();
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal || !a.netmask) continue;
      const ip = a.address.split('.').map(Number);
      const mask = a.netmask.split('.').map(Number);
      out.add(ip.map((o, i) => (o & mask[i]) | (~mask[i] & 255)).join('.'));
    }
  }
  return [...out];
}

/**
 * Manda pacchetti di ricerca finché la telecamera (riconosciuta dal DID) risponde; restituisce il suo IP oppure null
 * allo scadere di `ms` o se `cancelled()` diventa vero.
 */
async function pokeUntilAwake(cam, ms, cancelled = () => false) {
  const serial = cam.params.serial;
  const did = account()?.cameras?.[serial]?.did;
  const host = knownHost(cam);
  const sock = dgram.createSocket('udp4');
  let found = null;
  sock.on('message', (m, r) => {
    if (m.length < 24 || m[0] !== 0xf1 || m[1] !== 0x41) return;
    if (did && didFromReply(m) !== did) return;
    if (!did && host && r.address !== host) return;
    found = r.address;
  });
  sock.on('error', () => {});
  await new Promise((resolve) => sock.bind(0, resolve));
  sock.setBroadcast(true);
  const targets = ['255.255.255.255', ...localBroadcasts(), ...(host ? [host] : [])];
  const end = Date.now() + ms;
  while (!found && Date.now() < end && !cancelled()) {
    for (const t of targets) for (const port of [32108, 32100]) sock.send(Buffer.from('f1300000', 'hex'), port, t, () => {});
    await new Promise((r) => setTimeout(r, 250));
  }
  sock.close();
  if (found) rememberHost(serial, found);
  return found;
}

// ---------- sessioni ----------
const active = new Map(); // cam.id -> { session, readers, idleTimer, closing, ready, connected }

const setSleeping = (cam, sleeping) => {
  if (cam.battery) bus.emit('status', { camId: cam.id, sleeping, online: true });
};

async function openSession(cam, cancelled = () => false) {
  const acc = account();
  const serial = cam.params.serial;
  const did = acc?.cameras?.[serial]?.did;
  const attempt = async (host, t) => {
    const s = new EufySession({ host, serial, accountId: acc.accountId });
    await s.connect(t);
    return s;
  };
  if (cam.battery) {
    // Batteria: sveglia a richiesta (pacchetti continui) e collegamento appena risponde, per circa 70 secondi.
    const deadline = Date.now() + 70000;
    let lastError;
    // Se l'utente ha fatto l'accesso al cloud (tools/eufy-login), la sveglia passa anche dai server Eufy come fa l'app
    // ufficiale: da sole le richieste in rete locale non bastano per molte SoloCam (es. S340).
    const wake = cloud.startWake(serial, (m) => console.warn(`[eufy ${cam.name}] ${m}`));
    try {
      while (Date.now() < deadline && !cancelled()) {
        const ip = await pokeUntilAwake(cam, Math.min(30000, deadline - Date.now()), cancelled);
        if (!ip) continue; // nessuna risposta in questo giro: si insiste fino allo scadere dei 70 secondi
        try {
          return await attempt(ip, 12000);
        } catch (err) {
          lastError = err; // è tornata a dormire prima che il collegamento riuscisse: si riprova
        }
      }
    } finally {
      wake?.stop();
    }
    throw lastError || new Error('Telecamera non trovata in rete (a riposo?)');
  }
  const timeout = 10000;
  const host = cam.params.host || hostCache.get(serial) || persistedHosts[serial];
  let error;
  if (host) {
    // Una telecamera sempre accesa a volte non risponde subito (sessione precedente non ancora scaduta, pacchetti
    // persi sul Wi-Fi): si riprova con un nuovo socket invece di rinunciare e lasciare il video a metà.
    const tries = cam.battery ? 1 : 3;
    for (let i = 0; i < tries; i++) {
      try {
        return await attempt(host, cam.battery ? timeout : 8000);
      } catch (err) {
        error = err;
        if (i < tries - 1) await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }
  // IP non indicato o cambiato (DHCP): si cerca la telecamera per DID.
  if (did) {
    const hit = (await discover({ ms: 5000, hosts: [host] })).find((d) => d.did === did);
    if (hit && hit.ip !== host) return attempt(hit.ip, timeout);
  }
  throw error || new Error('Telecamera non trovata in rete (a riposo?)');
}

function startCamera(cam, { stream = true } = {}) {
  const entry = { session: null, readers: new Set(), idleTimer: null, keepTimer: null, closing: false, streaming: stream, started: false };
  entry.connected = new Promise((resolve, reject) => { entry.onConnected = resolve; entry.onFail = reject; });
  entry.ready = new Promise((resolve, reject) => { entry.onReady = resolve; entry.onNotReady = reject; });
  entry.connected.catch(() => {});
  entry.ready.catch(() => {});
  active.set(cam.id, entry);

  const stop = (reason) => {
    if (entry.closing) return;
    entry.closing = true;
    clearTimeout(entry.idleTimer);
    clearTimeout(entry.keepTimer);
    if (active.get(cam.id) === entry) active.delete(cam.id);
    try { if (entry.started) entry.session?.stopLivestream(); } catch { /* ignora */ }
    try { entry.session?.close(); } catch { /* ignora */ }
    for (const r of entry.readers) r.end();
    entry.readers.clear();
    const err = new Error(reason || 'sessione chiusa');
    entry.onFail(err);
    entry.onNotReady(err);
    setSleeping(cam, true);
  };
  entry.stop = stop;

  // Avvio del video sulla sessione aperta (anche più tardi, se la sessione era nata solo per le impostazioni).
  entry.beginStream = async () => {
    const s = entry.session;
    if (!s || entry.started || entry.closing) return;
    entry.started = true;
    s.gatewayInfo();
    await new Promise((r) => setTimeout(r, 1200));
    if (entry.closing) return;
    // Ogni modello vuole una forma diversa del comando di avvio: si prova prima quella nota,
    // e se entro 5 s non arriva video si prova l'altra.
    const first = /^T8170/.test(cam.params.serial) ? 'doorbell' : 'payload';
    s.startLivestream({ codec: 'h264', mode: first });
    setTimeout(() => {
      if (!entry.closing && entry.onReady) s.startLivestream({ codec: 'h264', mode: first === 'doorbell' ? 'payload' : 'doorbell' });
    }, 5000);
  };

  (async () => {
    try {
      const s = await openSession(cam, () => entry.closing);
      if (entry.closing) { s.close(); return; }
      entry.session = s;
      s.on('video', (v, m) => {
        if (entry.onReady) { entry.onReady(); entry.onReady = null; setSleeping(cam, false); }
        for (const r of entry.readers) {
          // Un nuovo lettore deve partire da un keyframe (porta SPS/PPS + immagine completa).
          if (r.waitKey) { if (!m.key) continue; r.waitKey = false; }
          r.write(v);
        }
      });
      s.on('close', () => stop('la telecamera ha chiuso la sessione'));
      s.on('error', () => stop('errore di rete'));
      entry.onConnected(s);
      // Telecamera a batteria sveglia: se ne ricorda il livello (resta visibile anche quando poi dorme o si scarica).
      if (cam.battery) setTimeout(() => s.cameraInfo().then((info) => battery.fromEufyInfo(cam, info)).catch(() => {}), 2500);
      // Sessione aperta (anche solo per svegliare o leggere le impostazioni): resta in attesa del lettore.
      if (entry.readers.size === 0) {
        entry.idleTimer = setTimeout(() => entry.readers.size === 0 && stop('nessun lettore'), WAKE_KEEP_MS);
      }
      if (entry.streaming) await entry.beginStream();
    } catch (err) {
      stop(err.message); // spenta/a riposo/irraggiungibile: i lettori si chiudono e il player riprova
    }
  })();

  return entry;
}

/** Collega una risposta HTTP (il lettore ffmpeg) al flusso della telecamera. */
export function streamTo(cam, res) {
  if (!isConfigured()) { res.statusCode = 503; res.end(); return; }
  let entry = active.get(cam.id);
  if (!entry || (!entry.session && entry.closing)) entry = startCamera(cam);
  clearTimeout(entry.idleTimer);
  clearTimeout(entry.keepTimer);
  entry.idleTimer = null;
  if (!entry.streaming) { entry.streaming = true; entry.beginStream(); } // sessione nata per le impostazioni: ora serve il video
  res.waitKey = true;
  entry.readers.add(res);
  res.on('close', () => {
    entry.readers.delete(res);
    if (entry.readers.size === 0 && !entry.closing) {
      entry.idleTimer = setTimeout(() => entry.readers.size === 0 && entry.stop('nessun lettore'), IDLE_STOP_MS);
    }
  });
}

/** Sveglia la telecamera: apre la sessione e attende il primo fotogramma. */
export async function wake(cam, timeoutMs = 75000) {
  if (!isConfigured()) throw new Error('Accesso Eufy non configurato (tools/eufy-login)');
  const entry = active.get(cam.id) || startCamera(cam);
  if (!entry.streaming) { entry.streaming = true; clearTimeout(entry.keepTimer); entry.beginStream(); }
  let timer;
  const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('La telecamera non si è svegliata')), timeoutMs); });
  try {
    await Promise.race([entry.ready, limit]);
  } catch (err) {
    // "ASLEEP" è un codice: l'interfaccia lo traduce nella lingua dell'utente.
    if (cam.battery && /ricerca locale|non trovata|non si è svegliata|non ha aperto/i.test(err.message)) throw new Error('ASLEEP');
    throw err;
  } finally {
    clearTimeout(timer);
  }
  return { ok: true };
}

/** Esegue `fn(sessione)` su una sessione P2P (riusa quella del video se già attiva). */
export async function withSession(cam, fn) {
  if (!isConfigured()) throw new Error('Accesso Eufy non configurato (tools/eufy-login)');
  let entry = active.get(cam.id);
  if (!entry) entry = startCamera(cam, { stream: false });
  const session = await entry.connected;
  try {
    return await fn(session);
  } finally {
    if (!entry.streaming) {
      // Una sessione aperta solo per le impostazioni resta aperta qualche secondo: le modifiche si susseguono e
      // riaprirla subito dopo averla chiusa fa spesso fallire la richiesta successiva (la telecamera è ancora occupata).
      clearTimeout(entry.idleTimer);
      clearTimeout(entry.keepTimer);
      entry.keepTimer = setTimeout(() => entry.readers.size === 0 && !entry.streaming && entry.stop('fine impostazioni'), SETTINGS_KEEP_MS);
    }
  }
}

// ---------- controllo delle telecamere a batteria ----------
// Una SoloCam che dorme non risponde in rete locale: si sveglia con il movimento (o dall'app Eufy).
// Un pacchetto di ricerca ogni 10 s basta a vedere quando risponde, così il pulsante passa da Sveglia a Play.
const lastAwake = new Map();
export function startWatcher(getCameras) {
  const loop = async () => {
    try {
      const cams = getCameras().filter((c) => c.brand === 'eufyp2p' && c.battery);
      if (cams.length && isConfigured()) {
        const found = await discover({ ms: 1500, hosts: cams.map((c) => c.params.host) });
        for (const cam of cams) {
          const awake = isActive(cam.id) || found.some((f) => f.serial === cam.params.serial);
          if (lastAwake.get(cam.id) !== awake) {
            lastAwake.set(cam.id, awake);
            bus.emit('status', { camId: cam.id, sleeping: !awake, online: true });
          }
        }
      }
    } catch { /* si riprova al giro successivo */ }
    setTimeout(loop, 10000).unref();
  };
  loop();
}

/** Chiude con garbo tutte le sessioni (alla chiusura dell'app): una sessione lasciata appesa blocca la telecamera per un po'. */
export function closeAll() {
  for (const entry of [...active.values()]) entry.stop?.('app in chiusura');
}

/** Ferma la sessione di una telecamera (es. quando viene modificata o eliminata). */
export function stopCamera(id) {
  active.get(id)?.stop?.('arrestata');
}

export const isActive = (id) => !!active.get(id)?.session;
