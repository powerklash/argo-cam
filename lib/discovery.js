// Ricerca automatica di telecamere nella rete locale (finestra "Nuova telecamera").
//
// Tre fasi, con avanzamento in percentuale:
//  1. messaggi di ricerca: ONVIF WS-Discovery (multicast) e ricerca locale delle Eufy (UDP 32108);
//  2. scansione delle porte tipiche delle telecamere (RTSP, HTTP, ONVIF, Baichuan…) su ogni indirizzo della rete;
//  3. riconoscimento di marca e modello dei dispositivi trovati (ONVIF, firme di Reolink/Hikvision/Dahua, RTSP).
// Si riportano solo i dispositivi che sembrano telecamere e che NON sono già nell'elenco delle telecamere dell'app.
import dgram from 'node:dgram';
import net from 'node:net';
import http from 'node:http';
import os from 'node:os';
import crypto from 'node:crypto';

const PORTS = [554, 8554, 80, 8000, 8080, 8899, 2020, 9000, 443];
const CONNECT_TIMEOUT_MS = 700;
const POOL = 200;           // connessioni di prova contemporanee
const MAX_HOSTS = 1022;     // al massimo una /22 per rete
const KEEP_MS = 10 * 60 * 1000;

const jobs = new Map();
let currentId = null;

/** Reti IPv4 locali di questo server: [{ ip, base, hosts[] }] (private, al massimo MAX_HOSTS indirizzi ciascuna). */
export function localNetworks() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal || !a.netmask) continue;
      const ip = a.address.split('.').map(Number);
      if (!(ip[0] === 10 || (ip[0] === 172 && ip[1] >= 16 && ip[1] <= 31) || (ip[0] === 192 && ip[1] === 168))) continue;
      const mask = a.netmask.split('.').map(Number);
      const toInt = (o) => ((o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]) >>> 0;
      let m = toInt(mask);
      const host = toInt(ip);
      // Reti più grandi di una /22: si scansiona solo la /22 che contiene l'interfaccia.
      const minMask = 0xfffffc00;
      if ((m & minMask) >>> 0 !== minMask) m = minMask;
      const net0 = (host & m) >>> 0;
      const size = (~m >>> 0) + 1;
      const hosts = [];
      for (let i = 1; i < size - 1 && hosts.length < MAX_HOSTS; i++) {
        const v = (net0 + i) >>> 0;
        if (v === host) continue;
        hosts.push([(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255].join('.'));
      }
      const bc = (net0 | (~m >>> 0)) >>> 0;
      out.push({ ip: a.address, hosts, broadcast: [(bc >>> 24) & 255, (bc >>> 16) & 255, (bc >>> 8) & 255, bc & 255].join('.') });
    }
  }
  return out;
}

/** Indirizzi già usati dalle telecamere dell'app (campo host, host degli URL, IP ricordati delle Eufy). */
export function knownHosts(cameras, eufyHostOf = () => null) {
  const set = new Set();
  const addUrl = (u) => { try { set.add(new URL(u).hostname); } catch { /* non è un URL */ } };
  for (const c of cameras) {
    const p = c.params || {};
    if (p.host) set.add(String(p.host));
    for (const k of ['mainUrl', 'subUrl']) if (p[k]) addUrl(p[k]);
    if (c.brand === 'eufyp2p') { const h = eufyHostOf(c); if (h) set.add(h); }
  }
  return set;
}

// ---------- fase 1: messaggi di ricerca ----------
const PROBE = (id) => `<?xml version="1.0" encoding="UTF-8"?><e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope" xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" xmlns:dn="http://www.onvif.org/ver10/network/wsdl"><e:Header><w:MessageID>uuid:${id}</w:MessageID><w:To e:mustUnderstand="true">urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To><w:Action e:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action></e:Header><e:Body><d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types></d:Probe></e:Body></e:Envelope>`;

/** ONVIF WS-Discovery: restituisce { ip -> { xaddr, name, hardware } } dei dispositivi che rispondono. */
function wsDiscovery(nets, ms, cancelled) {
  return new Promise((resolve) => {
    const found = new Map();
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    sock.on('error', () => {});
    sock.on('message', (msg, rinfo) => {
      const text = msg.toString('utf8');
      const x = /<[^>]*XAddrs[^>]*>([^<]+)</i.exec(text)?.[1]?.split(/\s+/).find((u) => /^https?:\/\//.test(u));
      const scopes = /<[^>]*Scopes[^>]*>([^<]+)</i.exec(text)?.[1] || '';
      const pick = (k) => { const m = new RegExp(`onvif://www\\.onvif\\.org/${k}/([^\\s]+)`, 'i').exec(scopes); return m ? decodeURIComponent(m[1].replace(/_/g, ' ')) : null; };
      let ip = rinfo.address;
      try { if (x) ip = new URL(x).hostname; } catch { /* resta l'indirizzo del mittente */ }
      if (!found.has(ip)) found.set(ip, { xaddr: x || null, name: pick('name'), hardware: pick('hardware') });
    });
    sock.bind(0, () => {
      const data = Buffer.from(PROBE(crypto.randomUUID()));
      const send = () => {
        for (const n of nets) {
          try { sock.setMulticastInterface(n.ip); sock.send(data, 3702, '239.255.255.250', () => {}); } catch { /* interfaccia senza multicast */ }
        }
      };
      send();
      const t = setInterval(() => (cancelled() ? done() : send()), 1000);
      const end = setTimeout(done, ms);
      function done() { clearInterval(t); clearTimeout(end); try { sock.close(); } catch { /* chiuso */ } resolve(found); }
    });
  });
}

/**
 * Ricerca locale delle Eufy (UDP 32108): risponde con il proprio identificativo (DID). Il socket resta aperto per tutta
 * la scansione: oltre al broadcast si manda una richiesta mirata a ogni indirizzo, perché alcune rispondono solo a quella.
 */
function eufyProbe(broadcasts = []) {
  const found = new Map(); // ip -> did
  const sock = dgram.createSocket('udp4');
  const packet = Buffer.from('f1300000', 'hex');
  sock.on('error', () => {});
  sock.on('message', (m, r) => {
    if (m.length >= 24 && m[0] === 0xf1 && m[1] === 0x41) {
      const t = (b) => b.toString('latin1').replace(/\0+$/, '');
      found.set(r.address, `${t(m.subarray(4, 12))}-${String(m.readUInt32BE(12)).padStart(6, '0')}-${t(m.subarray(16, 24))}`);
    }
  });
  const ready = new Promise((resolve) => sock.bind(0, () => { sock.setBroadcast(true); resolve(); }));
  return {
    found,
    ready,
    // Alcune telecamere rispondono solo al broadcast della propria sottorete o solo sulla porta 32100.
    broadcast: () => { for (const h of ['255.255.255.255', ...broadcasts]) for (const p of [32108, 32100]) sock.send(packet, p, h, () => {}); },
    unicast: (host) => { for (const p of [32108, 32100]) sock.send(packet, p, host, () => {}); },
    close: () => { try { sock.close(); } catch { /* chiuso */ } },
  };
}
// ---------- fase 2: porte ----------
function tcpOpen(host, port) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const finish = (ok) => { s.destroy(); resolve(ok); };
    s.setTimeout(CONNECT_TIMEOUT_MS, () => finish(false));
    s.once('connect', () => finish(true));
    s.once('error', () => finish(false));
  });
}

/** Esegue `fn` su ogni elemento con al massimo `limit` operazioni contemporanee. */
async function pool(items, limit, fn) {
  let i = 0;
  const worker = async () => { while (i < items.length) { const item = items[i++]; await fn(item); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

// ---------- fase 3: riconoscimento ----------
function request(host, port, { method = 'GET', path = '/', headers = {}, body = null, timeout = 1500 } = {}) {
  return new Promise((resolve) => {
    const req = http.request({ host, port, method, path, headers, timeout }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { if (data.length < 8192) data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      res.on('error', () => resolve(null));
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    if (body) req.write(body);
    req.end();
  });
}

const DEVINFO = '<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body><GetDeviceInformation xmlns="http://www.onvif.org/ver10/device/wsdl"/></s:Body></s:Envelope>';

/** ONVIF GetDeviceInformation (molte telecamere lo concedono senza password): { manufacturer, model } o null. */
async function onvifInfo(host, port, path = '/onvif/device_service') {
  const r = await request(host, port, { method: 'POST', path, headers: { 'Content-Type': 'application/soap+xml; charset=utf-8', 'Content-Length': Buffer.byteLength(DEVINFO) }, body: DEVINFO });
  if (!r) return null;
  const pick = (k) => new RegExp(`<[^>]*${k}[^>]*>([^<]*)<`, 'i').exec(r.body)?.[1]?.trim() || '';
  const manufacturer = pick('Manufacturer');
  const model = pick('Model');
  if (manufacturer || model) return { manufacturer, model };
  // Risponde ma vuole le credenziali: è comunque un dispositivo ONVIF.
  if (/onvif|soap/i.test(r.body) || r.status === 400 || r.status === 401) return { manufacturer: '', model: '', auth: true };
  return null;
}

function rtspOptions(host, port) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    let data = '';
    const finish = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(1500, () => finish(null));
    s.once('error', () => finish(null));
    s.once('connect', () => s.write(`OPTIONS rtsp://${host}:${port}/ RTSP/1.0\r\nCSeq: 1\r\nUser-Agent: Argo\r\n\r\n`));
    s.on('data', (c) => { data += c; if (data.includes('\r\n\r\n') || data.length > 2000) finish(/^RTSP\/1\.0 /.test(data) ? { server: /^Server:\s*(.+)$/im.exec(data)?.[1]?.trim() || '' } : null); });
  });
}

const brandOf = (manufacturer, model) => {
  const s = `${manufacturer} ${model}`.toLowerCase();
  if (/reolink/.test(s)) return 'reolink';
  if (/hikvision|hik|ezviz|ds-/.test(s)) return 'hikvision';
  if (/dahua|amcrest|imou|dh-|ipc-h/.test(s)) return 'dahua';
  if (/tp-?link|tapo/.test(s)) return 'tapo';
  return 'onvif';
};

/** Riconosce cosa c'è all'indirizzo `host` con le porte aperte `open`; restituisce una voce o null se non sembra una telecamera. */
async function identify(host, open, ws, eufyDid, accountSerials) {
  const has = (p) => open.includes(p);
  const base = { host, ports: open };
  if (eufyDid) return { ...base, brand: 'eufyp2p', name: accountSerials.get(eufyDid)?.slice(0, 5) || 'Eufy', detail: 'Eufy', serial: accountSerials.get(eufyDid) || '', battery: /^T81/.test(accountSerials.get(eufyDid) || '') };
  // ONVIF: porta indicata dal messaggio di ricerca, altrimenti le porte HTTP tipiche
  let info = null;
  const candidates = [];
  if (ws?.xaddr) { try { const u = new URL(ws.xaddr); candidates.push([Number(u.port) || 80, u.pathname || '/onvif/device_service']); } catch { /* indirizzo non valido */ } }
  for (const p of [80, 8000, 2020, 8899, 8080]) if (has(p) && !candidates.some((c) => c[0] === p)) candidates.push([p, '/onvif/device_service']);
  for (const [p, path] of candidates) { info = await onvifInfo(host, p, path); if (info) break; }
  if (info && (info.manufacturer || info.model)) {
    const brand = brandOf(info.manufacturer, info.model);
    return { ...base, brand, name: info.model || ws?.name || '', detail: [info.manufacturer, info.model].filter(Boolean).join(' ') || 'ONVIF' };
  }
  // Reolink: l'API risponde in JSON anche senza accesso ("please login first"); la porta 9000 è quella Baichuan
  if (has(80) || has(9000)) {
    const r = has(80) ? await request(host, 80, { path: '/api.cgi?cmd=GetDevInfo' }) : null;
    const signature = !!r && /"cmd"\s*:\s*"GetDevInfo"|rspCode/.test(r.body);
    if (signature || (has(9000) && has(554))) return { ...base, brand: 'reolink', name: 'Reolink', detail: 'Reolink' };
  }
  if (has(80)) {
    const r = await request(host, 80, { path: '/cgi-bin/magicBox.cgi?action=getSystemInfo' });
    if (r && /realm="Login to /i.test(String(r.headers['www-authenticate'] || ''))) return { ...base, brand: 'dahua', name: 'Dahua', detail: 'Dahua / Amcrest' };
    const h = await request(host, 80, { path: '/' });
    if (h && /App-webs|DNVRS-Webs|Hikvision/i.test(`${h.headers.server || ''} ${h.body}`)) return { ...base, brand: 'hikvision', name: 'Hikvision', detail: 'Hikvision' };
  }
  if (ws) return { ...base, brand: 'onvif', name: ws.name || ws.hardware || '', detail: [ws.name, ws.hardware].filter(Boolean).join(' ') || 'ONVIF' };
  for (const p of [554, 8554]) {
    if (!has(p)) continue;
    const r = await rtspOptions(host, p);
    if (r) return { ...base, brand: 'custom', name: '', detail: r.server ? `RTSP · ${r.server}` : 'RTSP', rtspPort: p };
  }
  return null;
}

// ---------- ricerca completa ----------
/**
 * Avvia una ricerca. `known`: indirizzi già usati; `accountSerials`: Map did -> numero di serie (Eufy dell'account);
 * `knownSerials`: numeri di serie Eufy già aggiunti. Restituisce l'id da usare con status()/cancel().
 */
export function start({ known = new Set(), accountSerials = new Map(), knownSerials = new Set() } = {}) {
  if (currentId && jobs.get(currentId) && !jobs.get(currentId).done) cancel(currentId);
  const id = crypto.randomUUID();
  const job = { id, phase: 'broadcast', progress: 0, found: [], done: false, error: null, cancelled: false, total: 0, scanned: 0, started: Date.now() };
  jobs.set(id, job);
  currentId = id;
  run(job, { known, accountSerials, knownSerials }).catch((err) => { job.error = err.message; }).finally(() => { job.done = true; job.progress = 100; setTimeout(() => jobs.delete(id), KEEP_MS).unref(); });
  return id;
}

async function run(job, { known, accountSerials, knownSerials }) {
  const cancelled = () => job.cancelled;
  const nets = localNetworks();
  if (!nets.length) throw new Error('no_network'); // l'interfaccia lo traduce

  // Fase 1 (0-15 %): messaggi di ricerca
  job.phase = 'broadcast';
  const tick = setInterval(() => { job.progress = Math.min(14, job.progress + 2); }, 450);
  const probe = eufyProbe(nets.map((n) => n.broadcast));
  await probe.ready;
  const bcast = setInterval(() => probe.broadcast(), 450);
  probe.broadcast();
  const ws = await wsDiscovery(nets, 3500, cancelled);
  clearInterval(bcast);
  clearInterval(tick);
  job.progress = 15;
  if (cancelled()) return;

  // Fase 2 (15-75 %): porte aperte di ogni indirizzo
  job.phase = 'ports';
  const hosts = [...new Set(nets.flatMap((n) => n.hosts))].filter((h) => !known.has(h));
  job.total = hosts.length;
  const openBy = new Map();
  await pool(hosts, POOL, async (host) => {
    if (cancelled()) return;
    probe.unicast(host);
    const open = [];
    await Promise.all(PORTS.map(async (p) => { if (await tcpOpen(host, p)) open.push(p); }));
    if (open.length) openBy.set(host, open.sort((a, b) => a - b));
    job.scanned++;
    job.progress = 15 + Math.round((job.scanned / Math.max(1, job.total)) * 60);
  });
  await new Promise((r) => setTimeout(r, 600)); // il tempo di arrivo delle ultime risposte Eufy
  probe.close();
  const eufy = probe.found;
  if (cancelled()) return;

  // Fase 3 (75-100 %): riconoscimento
  job.phase = 'identify';
  const candidates = new Set([...openBy.keys(), ...ws.keys(), ...eufy.keys()]);
  const list = [...candidates].filter((h) => !known.has(h));
  let done = 0;
  await pool(list, 16, async (host) => {
    if (cancelled()) return;
    try {
      const did = eufy.get(host) || null;
      const entry = await identify(host, openBy.get(host) || [], ws.get(host), did, accountSerials);
      if (entry && !(entry.serial && knownSerials.has(entry.serial))) job.found.push(entry);
    } catch { /* un dispositivo che non risponde non ferma la ricerca */ }
    done++;
    job.progress = 75 + Math.round((done / Math.max(1, list.length)) * 25);
  });
  job.found.sort((a, b) => a.host.split('.').reduce((s, o) => s * 256 + Number(o), 0) - b.host.split('.').reduce((s, o) => s * 256 + Number(o), 0));
}

export const status = (id) => {
  const j = jobs.get(id);
  return j ? { id: j.id, phase: j.phase, progress: j.progress, found: j.found, done: j.done, error: j.error, cancelled: j.cancelled, scanned: j.scanned, total: j.total } : null;
};

export function cancel(id) {
  const j = jobs.get(id);
  if (j) j.cancelled = true;
}
