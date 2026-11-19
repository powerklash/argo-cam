// Controllo telecamere Reolink tramite la loro API HTTP locale (cgi-bin/api.cgi).
//
// Le opzioni non sono codificate per modello: ogni comando "Get…" viene chiesto con
// action=1, e la telecamera risponde con il valore attuale più l'intervallo ammesso
// (range). Da lì si costruiscono i controlli; i comandi che la telecamera non
// supporta rispondono con errore e il gruppo semplicemente non compare.
import https from 'node:https';
import http from 'node:http';
import { createHash } from 'node:crypto';

// Gruppi di impostazioni. `only: 'bool'` limita ai soli interruttori (i gruppi
// push/e-mail/FTP contengono anche indirizzi e credenziali che non devono uscire).
const GROUPS = [
  { id: 'image', label: 'Immagine', get: 'GetImage', set: 'SetImage' },
  { id: 'isp', label: 'Esposizione e giorno/notte', get: 'GetIsp', set: 'SetIsp' },
  { id: 'enc', label: 'Codifica video', get: 'GetEnc', set: 'SetEnc', full: true },
  { id: 'ir', label: 'Luci infrarosse', get: 'GetIrLights', set: 'SetIrLights', need: ['ledControl'] },
  {
    id: 'white', label: 'Faretto', get: 'GetWhiteLed', set: 'SetWhiteLed', need: ['floodLight'], loose: true,
    bools: /^state$|^(people|vehicle|dog_cat|face)$/, enums: { mode: [0, 1, 2, 3] },
  },
  { id: 'led', label: 'LED di stato', get: 'GetPowerLed', set: 'SetPowerLed', need: ['indicatorLight', 'supportDoorbellLight'] },
  { id: 'audio', label: 'Audio e volume', get: 'GetAudioCfg', set: 'SetAudioCfg', bools: /^visitorLoudspeaker$/ },
  { id: 'osd', label: 'Scritte a video (OSD)', get: 'GetOsd', set: 'SetOsd', text: true },
  { id: 'guard', label: 'Posizione di guardia', get: 'GetPtzGuard', set: 'SetPtzGuard', need: ['ptzType'], loose: true },
  { id: 'af', label: 'Messa a fuoco automatica', get: 'GetAutoFocus', set: 'SetAutoFocus', need: ['ptzType'] },
  { id: 'ai', label: 'Tracciamento e rilevamento AI', get: 'GetAiCfg', set: 'SetAiCfg' },
  { id: 'md', label: 'Rilevamento movimento', get: 'GetMdAlarm', set: 'SetMdAlarm', need: ['supportMd'] },
  { id: 'pir', label: 'Sensore PIR', get: 'GetPirInfo', set: 'SetPirInfo', need: ['mdWithPir'] },
  { id: 'aiPeople', label: 'AI: persone', get: 'GetAiAlarm', set: 'SetAiAlarm', extra: { ai_type: 'people' } },
  {
    id: 'aiVehicle', label: 'AI: veicoli', get: 'GetAiAlarm', set: 'SetAiAlarm',
    extra: { ai_type: 'vehicle' }, need: ['supportAiVehicle'],
  },
  {
    id: 'aiPet', label: 'AI: animali', get: 'GetAiAlarm', set: 'SetAiAlarm',
    extra: { ai_type: 'dog_cat' }, need: ['supportAiDogCat', 'supportAiAnimal'],
  },
  { id: 'autoReply', label: 'Risposta rapida (campanello)', get: 'GetAutoReply', set: 'SetAutoReply', need: ['supportAutoReply'] },
  {
    id: 'sirenEvt', label: 'Sirena su evento', get: 'GetAudioAlarmV20', set: 'SetAudioAlarmV20',
    only: /enable/i, need: ['supportAudioAlarm'],
  },
  // `only: 'master'`: l'interruttore vero di registrazione/push/e-mail/FTP è "scheduleEnable" (come nell'app ufficiale e in
  // Home Assistant); "enable" resta a 1 anche con la funzione spenta. Senza "scheduleEnable" si usa "enable".
  { id: 'rec', label: 'Registrazione', get: 'GetRecV20', set: 'SetRecV20', only: 'master' },
  { id: 'push', label: 'Notifiche push', get: 'GetPushV20', set: 'SetPushV20', only: 'master' },
  { id: 'email', label: 'E-mail su evento', get: 'GetEmailV20', set: 'SetEmailV20', only: 'master' },
  { id: 'ftp', label: 'Caricamento FTP', get: 'GetFtpV20', set: 'SetFtpV20', only: 'master' },
  // Sola lettura.
  { id: 'battery', label: 'Batteria', get: 'GetBatteryInfo', need: ['battery'] },
  { id: 'zoom', label: 'Zoom e fuoco', get: 'GetZoomFocus', need: ['ptzType'] },
  { id: 'presets', label: 'Preset', get: 'GetPtzPreset', need: ['ptzPreset'] },
];

const PTZ_OPS = new Set([
  'Left', 'Right', 'Up', 'Down', 'LeftUp', 'LeftDown', 'RightUp', 'RightDown',
  'Stop', 'ZoomInc', 'ZoomDec', 'FocusInc', 'FocusDec', 'ToPos',
]);

// ---------- sessione ----------
const sessions = new Map();
// La sessione dipende anche dalla password: una voce con password errata non deve bloccare
// (per 5 minuti) le altre telecamere dello stesso hub che hanno la password giusta.
export const sessionKey = (cam) =>
  `${cam.params.host}|${cam.params.username || 'admin'}|${createHash('sha1').update(cam.params.password || '').digest('hex').slice(0, 8)}`;
const sessionOf = (cam) => {
  const key = sessionKey(cam);
  if (!sessions.has(key)) sessions.set(key, { queue: Promise.resolve(), cache: new Map() });
  return sessions.get(key);
};

function post(scheme, host, query, body, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = (scheme === 'https' ? https : http).request(
      {
        host,
        port: scheme === 'https' ? 443 : 80,
        path: `/cgi-bin/api.cgi?${query}`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
        // Le telecamere usano un certificato autofirmato: è un dispositivo della rete locale
        // indicato dall'utente, quindi la verifica della catena non è applicabile.
        rejectUnauthorized: false,
        timeout,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch {
            reject(new Error(`Risposta non valida (HTTP ${res.statusCode})`));
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('tempo scaduto')));
    req.on('error', reject);
    req.end(data);
  });
}

async function login(s, cam) {
  if (s.blockedUntil > Date.now()) {
    const wait = Math.ceil((s.blockedUntil - Date.now()) / 1000);
    throw new Error(`Accesso rifiutato dalla telecamera (${s.error}). Nuovo tentativo possibile tra ${wait} s.`);
  }
  const p = cam.params;
  const body = [{ cmd: 'Login', param: { User: { Version: '0', userName: p.username || 'admin', password: p.password || '' } } }];
  let lastErr;
  for (const scheme of s.scheme ? [s.scheme] : ['https', 'http']) {
    let res;
    try {
      res = await post(scheme, p.host, 'cmd=Login', body);
    } catch (err) {
      lastErr = err;
      continue;
    }
    s.scheme = scheme;
    const r = res?.[0];
    if (r?.code === 0 && r.value?.Token?.name) {
      s.token = r.value.Token.name;
      s.expires = Date.now() + (Math.max(r.value.Token.leaseTime || 3600, 120) - 60) * 1000;
      return;
    }
    // Un solo tentativo, poi pausa: accessi falliti ripetuti bloccano l'account.
    s.error = r?.error?.detail || 'login fallito';
    s.blockedUntil = Date.now() + 5 * 60_000;
    throw new Error(`Accesso rifiutato dalla telecamera (${s.error}).`);
  }
  throw new Error(`API Reolink non raggiungibile su ${p.host}: ${lastErr?.message}`);
}

/** Esegue comandi sulla telecamera (in coda per host, a blocchi di 6). */
export function call(cam, cmds) {
  const s = sessionOf(cam);
  const run = async () => {
    const out = [];
    for (let i = 0; i < cmds.length; i += 6) {
      const chunk = cmds.slice(i, i + 6);
      for (let attempt = 0; ; attempt++) {
        if (!s.token || Date.now() > s.expires) await login(s, cam);
        const res = await post(s.scheme, cam.params.host, `token=${s.token}`, chunk);
        const list = Array.isArray(res) ? res : [res];
        // -6 = "please login first": token scaduto lato telecamera.
        if (attempt === 0 && list.some((r) => r?.error?.rspCode === -6)) {
          s.token = null;
          continue;
        }
        out.push(...chunk.map((c, j) => list[j] || { cmd: c.cmd, code: 1, error: { detail: 'nessuna risposta' } }));
        break;
      }
    }
    return out;
  };
  const result = s.queue.then(run, run);
  s.queue = result.catch(() => {});
  return result;
}

export function forgetSession(cam) {
  sessions.delete(sessionKey(cam));
}

// ---------- valori → campi ----------
const channelOf = (cam) => (cam.params.channel || 1) - 1;
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const BOOL_KEY = /enable|disable|^b[A-Z]|switch|^audio$|mirroring|rotation|^hdr$|reduce/i;

// La risposta è { Chiave: {...} } per quasi tutti i comandi, oppure piatta (GetAiCfg).
function unwrap(value) {
  const keys = Object.keys(value || {});
  if (keys.length === 1 && isObj(value[keys[0]])) return { key: keys[0], data: value[keys[0]] };
  return { key: null, data: value || {} };
}

function fieldsOf(group, data, range) {
  const fields = [];
  const only = group.only === 'master'
    ? (data.scheduleEnable !== undefined ? /^scheduleEnable$|preRec/i : /enable|preRec/i)
    : group.only;
  const walk = (val, rng, path) => {
    for (const [k, v] of Object.entries(val)) {
      if (k === 'channel' || k === 'ai_type' || k === 'table' || Array.isArray(v)) continue;
      const r = rng?.[k];
      const p = [...path, k];
      if (isObj(v)) {
        walk(v, isObj(r) ? r : undefined, p);
        continue;
      }
      let f = null;
      const isList = Array.isArray(r) && r.length && r.every((o) => typeof o !== 'object');
      const isSpan = isObj(r) && typeof r.min === 'number' && typeof r.max === 'number';
      const flag01 = typeof v === 'number' && (v === 0 || v === 1) && !isList && !isSpan;
      if (r === 'boolean' || typeof v === 'boolean' || (flag01 && (BOOL_KEY.test(k) || group.bools?.test(k)))) {
        f = { type: 'bool', value: !!v };
      } else if (isList || group.enums?.[k]) {
        f = { type: 'select', options: isList ? r : group.enums[k], value: v };
      } else if (isSpan) {
        f = { type: 'range', min: r.min, max: r.max, value: v };
      } else if (typeof v === 'number' && (r === undefined || group.loose)) {
        f = { type: 'number', value: v };
      } else if (typeof v === 'string' && group.text && v.length <= 32 && k === 'name') {
        f = { type: 'text', value: v };
      } else if (typeof v !== 'string' || v.length <= 48) {
        f = { type: 'info', value: v };
      }
      if (!f) continue;
      if (!group.set && f.type !== 'info') f = { type: 'info', value: f.value };
      if (only && !(f.type === 'bool' && only.test(k))) continue;
      fields.push({ path: p.join('.'), ...f });
    }
  };
  walk(data, range, []);
  return fields;
}

// Per SetEnc l'intervallo è un elenco di combinazioni: si usa quella della risoluzione attuale.
function encRange(data, range) {
  if (!Array.isArray(range)) return range;
  return range.find((e) => e?.mainStream?.size === data?.mainStream?.size) || range[0];
}

function readGroup(group, res) {
  if (!res || res.code !== 0 || !res.value) return null;
  const { key, data } = unwrap(res.value);
  let range = key ? res.range?.[key] : res.range;
  if (group.id === 'enc') range = encRange(data, range);
  return { key, data, fields: fieldsOf(group, data, range) };
}

const getCmd = (group, ch) => ({ cmd: group.get, action: 1, param: { channel: ch, ...group.extra } });

/** Legge tutte le impostazioni e le azioni disponibili per la telecamera. */
export async function getSettings(cam) {
  const ch = channelOf(cam);
  const s = sessionOf(cam);
  const cmds = [
    { cmd: 'GetAbility', action: 0, param: { User: { userName: cam.params.username || 'admin' } } },
    { cmd: 'GetChnTypeInfo', action: 0, param: { channel: ch } },
    ...GROUPS.map((g) => getCmd(g, ch)),
  ];
  const res = await call(cam, cmds);
  const ability = res[0]?.value?.Ability?.abilityChn?.[ch] || {};
  const ver = (name) => ability[name]?.ver || 0;
  const type = res[1]?.value?.typeInfo ?? res[1]?.value;

  const groups = [];
  const raw = {};
  GROUPS.forEach((g, i) => {
    // L'hub risponde a ogni comando anche per funzioni che la telecamera non ha:
    // fanno fede le capacità dichiarate per il canale.
    if (g.need && !g.need.some(ver)) return;
    const parsed = readGroup(g, res[i + 2]);
    if (!parsed) return;
    // La telecamera risponde "ok" anche a opzioni che non ha (es. rilevamento pacchi sul campanello) e le ignora:
    // si mostrano solo i tipi di rilevamento dichiarati dalle sue capacità.
    if (g.id === 'ai') {
      const need = { package: 'supportAiPackage', face: 'supportAiFace', dog_cat: 'supportAiDogCat', vehicle: 'supportAiVehicle', people: 'supportAiPeople' };
      parsed.fields = parsed.fields.filter((f) => {
        const kind = /(?:AiDetectType|trackType)\.(\w+)$/.exec(f.path)?.[1];
        return !(kind && need[kind] && !ver(need[kind]));
      });
    }
    raw[g.id] = parsed;
    s.cache.set(`${cam.id}:${g.id}`, parsed);
    if (g.id === 'zoom' || g.id === 'presets') return;
    if (parsed.fields.length) groups.push({ id: g.id, label: g.label, readOnly: !g.set, fields: parsed.fields });
  });

  const resOf = (id) => res[GROUPS.findIndex((g) => g.id === id) + 2];
  const presetList = resOf('presets')?.value?.PtzPreset;
  const presets = ver('ptzPreset') && Array.isArray(presetList) ? presetList : [];
  const zoomRes = resOf('zoom');
  const zf = ver('ptzType') && zoomRes?.code === 0 ? zoomRes.value?.ZoomFocus : null;
  const zr = zoomRes?.range?.ZoomFocus;

  return {
    model: typeof type === 'string' ? type : type?.typeInfo || '',
    actions: {
      ptz: ver('ptzType') >= 2 && ver('ptzCtrl') > 0,
      zoom: zf ? { zoom: zf.zoom?.pos, focus: zf.focus?.pos, zoomRange: zr?.zoom?.pos, focusRange: zr?.focus?.pos } : null,
      presets: presets.filter((p) => p.enable).map((p) => ({ id: p.id, name: p.name })),
      siren: ver('supportAudioAlarm') > 0,
      guard: !!raw.guard,
      calibrate: ver('supportPtzCalibration') > 0,
    },
    groups,
  };
}

function setPath(obj, path, value) {
  const keys = path.split('.');
  let o = obj;
  for (const k of keys.slice(0, -1)) o = o[k] = isObj(o[k]) ? o[k] : {};
  o[keys.at(-1)] = value;
}
const getPath = (obj, path) => path.split('.').reduce((o, k) => o?.[k], obj);

/** Applica modifiche { 'percorso.campo': valore } a un gruppo e restituisce i campi aggiornati. */
export async function setGroup(cam, groupId, changes) {
  const group = GROUPS.find((g) => g.id === groupId);
  if (!group?.set) throw new Error('Gruppo non modificabile');
  const ch = channelOf(cam);
  const s = sessionOf(cam);
  let cached = s.cache.get(`${cam.id}:${groupId}`);
  if (!cached) {
    cached = readGroup(group, (await call(cam, [getCmd(group, ch)]))[0]);
    if (!cached) throw new Error('Impostazione non supportata da questa telecamera');
  }
  const allowed = new Map(cached.fields.map((f) => [f.path, f]));
  const full = structuredClone(cached.data);
  const minimal = { channel: ch, ...group.extra };
  for (const [path, input] of Object.entries(changes || {})) {
    const f = allowed.get(path);
    if (!f || f.type === 'info') throw new Error(`Campo non modificabile: ${path}`);
    const old = getPath(cached.data, path);
    let v = input;
    if (f.type === 'bool') v = typeof old === 'boolean' ? !!input : input ? 1 : 0;
    else if (f.type === 'range' || f.type === 'number') {
      v = Number(input);
      if (!Number.isFinite(v) || (f.type === 'range' && (v < f.min || v > f.max))) throw new Error(`Valore non valido: ${path}`);
    } else if (f.type === 'select') {
      v = f.options.find((o) => String(o) === String(input));
      if (v === undefined) throw new Error(`Valore non valido: ${path}`);
    } else v = String(input).slice(0, 32);
    setPath(full, path, v);
    setPath(minimal, path, v);
    // Gli oggetti annidati con un proprio "channel" (es. schedule) lo richiedono anche in scrittura.
    const parent = path.split('.').slice(0, -1).join('.');
    if (parent && getPath(cached.data, parent)?.channel !== undefined) setPath(minimal, `${parent}.channel`, ch);
  }
  full.channel = ch;
  const wrap = (payload) => ({ cmd: group.set, action: 0, param: cached.key ? { [cached.key]: payload } : payload });
  // Prima solo i campi cambiati; se la telecamera pretende l'oggetto completo, lo si rimanda intero.
  let last;
  for (const payload of group.full ? [full] : [minimal, full]) {
    last = (await call(cam, [wrap(payload)]))[0];
    if (last?.code === 0) break;
  }
  if (last?.code !== 0) throw new Error(`La telecamera ha rifiutato la modifica (${last?.error?.detail || 'errore'})`);
  const fresh = readGroup(group, (await call(cam, [getCmd(group, ch)]))[0]);
  if (fresh) s.cache.set(`${cam.id}:${groupId}`, fresh);
  return { id: group.id, label: group.label, fields: (fresh || cached).fields };
}

const ok = (r) => {
  if (r?.code !== 0) throw new Error(`Comando rifiutato (${r?.error?.detail || 'errore'})`);
  return { ok: true };
};

export async function ptz(cam, { op, speed = 32, id }) {
  if (!PTZ_OPS.has(op)) throw new Error('Operazione PTZ non valida');
  const param = { channel: channelOf(cam), op };
  if (op !== 'Stop') param.speed = Math.max(1, Math.min(64, Number(speed) || 32));
  if (op === 'ToPos') param.id = Number(id);
  return ok((await call(cam, [{ cmd: 'PtzCtrl', action: 0, param }]))[0]);
}

export async function action(cam, { name, value }) {
  const channel = channelOf(cam);
  const cmds = {
    sirenOn: { cmd: 'AudioAlarmPlay', param: { channel, alarm_mode: 'times', times: 1, manual_switch: 0 } },
    sirenOff: { cmd: 'AudioAlarmPlay', param: { channel, alarm_mode: 'manul', manual_switch: 0 } },
    guardGoto: { cmd: 'SetPtzGuard', param: { PtzGuard: { channel, cmdStr: 'toPos' } } },
    guardSet: { cmd: 'SetPtzGuard', param: { PtzGuard: { channel, cmdStr: 'setPos', bSaveCurrentPos: 1 } } },
    calibrate: { cmd: 'PtzCheck', param: { channel } },
    zoomPos: { cmd: 'StartZoomFocus', param: { ZoomFocus: { channel, op: 'ZoomPos', pos: Number(value) } } },
    focusPos: { cmd: 'StartZoomFocus', param: { ZoomFocus: { channel, op: 'FocusPos', pos: Number(value) } } },
  };
  if (!cmds[name]) throw new Error('Azione non valida');
  return ok((await call(cam, [{ action: 0, ...cmds[name] }]))[0]);
}

/** Elenco dei canali di un NVR / Home Hub (per importarli). */
export async function channels(cam) {
  const res = await call(cam, [{ cmd: 'GetChannelstatus', action: 0, param: {} }]);
  const list = res[0]?.value?.status || [];
  return list.map((c) => ({ channel: c.channel + 1, name: c.name, online: !!c.online, model: c.typeInfo || '', sleep: !!c.sleep }));
}

/** Canali di un NVR / Home Hub che hanno una telecamera associata (nome o uid), anche se ora è offline o a riposo. */
export async function pairedChannels(cam) {
  const [r] = await call(cam, [{ cmd: 'GetChannelstatus', action: 0, param: {} }]);
  if (r?.error) throw new Error(r.error.detail || 'errore');
  return (r?.value?.status || [])
    .filter((c) => c.name || c.uid)
    .map((c) => ({ channel: c.channel + 1, name: c.name || '', online: !!c.online, model: c.typeInfo || '', uid: c.uid || '' }));
}

/** Tutti i canali di un NVR / Home Hub, anche quelli vuoti (per scegliere il canale di una telecamera). */
export async function allChannels(cam) {
  const [r] = await call(cam, [{ cmd: 'GetChannelstatus', action: 0, param: {} }]);
  if (r?.error) throw new Error(r.error.detail || 'errore');
  return (r?.value?.status || []).map((c) => ({ channel: c.channel + 1, name: c.name || '', online: !!c.online, uid: c.uid || '' }));
}

// ---------- istantanee, eventi, capacità ----------
function getBuffer(scheme, host, query, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const req = (scheme === 'https' ? https : http).request(
      { host, port: scheme === 'https' ? 443 : 80, path: `/cgi-bin/api.cgi?${query}`, method: 'GET', rejectUnauthorized: false, timeout },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      },
    );
    req.on('timeout', () => req.destroy(new Error('tempo scaduto')));
    req.on('error', reject);
    req.end();
  });
}

/** Istantanea JPEG a piena risoluzione dalla telecamera (senza passare da RTSP). */
export function snapshot(cam) {
  const s = sessionOf(cam);
  const run = async () => {
    for (let attempt = 0; ; attempt++) {
      if (!s.token || Date.now() > s.expires) await login(s, cam);
      const rs = Math.random().toString(36).slice(2, 10);
      const buf = await getBuffer(s.scheme, cam.params.host, `cmd=Snap&channel=${channelOf(cam)}&rs=${rs}&token=${s.token}`);
      if (buf[0] === 0xff && buf[1] === 0xd8) return buf;
      if (attempt === 0) { s.token = null; continue; } // token scaduto lato telecamera
      throw new Error('Istantanea non valida');
    }
  };
  const result = s.queue.then(run, run);
  s.queue = result.catch(() => {});
  return result;
}

/**
 * Stato di più canali dello stesso hub in due richieste: prima chi dorme/è offline, poi gli eventi
 * dei soli canali svegli (interrogare una batteria che dorme la sveglierebbe e ne consumerebbe la carica).
 * channels: numeri 1-based. Restituisce { [canale]: { online, sleeping, ev } }, ev = { md, people, ... } o null.
 */
export async function pollEvents(cam, channels) {
  const out = {};
  let status = [];
  try {
    const r = (await call(cam, [{ cmd: 'GetChannelstatus', action: 0, param: {} }]))[0];
    if (r?.code === 0) status = r.value?.status || [];
  } catch (err) {
    if (/Accesso rifiutato/.test(err.message)) throw err;
  }
  const awake = [];
  for (const ch of channels) {
    const info = status.find((c) => c.channel === ch - 1);
    out[ch] = { online: info ? !!info.online : true, sleeping: info ? !!info.sleep : false, ev: null };
    if (out[ch].online && !out[ch].sleeping) awake.push(ch);
  }
  if (awake.length) {
    const res = await call(cam, awake.map((ch) => ({ cmd: 'GetEvents', action: 0, param: { channel: ch - 1 } })));
    const on = (o) => o?.alarm_state === 1;
    const sup = (o) => o?.support === 1;
    const retry = [];
    awake.forEach((ch, i) => {
      const v = res[i]?.code === 0 ? res[i].value : null;
      if (!v) { retry.push(ch); return; }
      out[ch].ev = {
        md: on(v.md), person: on(v.ai?.people), vehicle: on(v.ai?.vehicle), pet: on(v.ai?.dog_cat),
        face: on(v.ai?.face), package: on(v.ai?.package), visitor: on(v.visitor),
      };
      out[ch].support = {
        md: sup(v.md), person: sup(v.ai?.people), vehicle: sup(v.ai?.vehicle), pet: sup(v.ai?.dog_cat),
        face: sup(v.ai?.face), package: sup(v.ai?.package), visitor: sup(v.visitor),
      };
    });
    // Telecamere più datate (senza GetEvents): movimento e AI con i comandi singoli.
    if (retry.length) {
      const r2 = await call(cam, retry.flatMap((ch) => [
        { cmd: 'GetMdState', action: 0, param: { channel: ch - 1 } },
        { cmd: 'GetAiState', action: 0, param: { channel: ch - 1 } },
      ]));
      retry.forEach((ch, i) => {
        const md = r2[i * 2];
        const ai = r2[i * 2 + 1];
        const mdOk = md?.code === 0;
        const ai0 = ai?.code === 0 ? ai.value : null;
        if (!mdOk && !ai0) return;
        out[ch].ev = {
          md: mdOk && md.value?.state === 1, person: on(ai0?.people), vehicle: on(ai0?.vehicle), pet: on(ai0?.dog_cat),
          face: on(ai0?.face), package: on(ai0?.package), visitor: false,
        };
        out[ch].support = { md: mdOk, person: sup(ai0?.people), vehicle: sup(ai0?.vehicle), pet: sup(ai0?.dog_cat), face: sup(ai0?.face), package: sup(ai0?.package), visitor: false };
      });
    }
  }
  return out;
}

/** Capacità fisse del canale: batteria e campanello (da GetAbility). */
export async function capabilities(cam) {
  const r = (await call(cam, [{ cmd: 'GetAbility', action: 0, param: { User: { userName: cam.params.username || 'admin' } } }]))[0];
  const ab = r?.value?.Ability?.abilityChn?.[channelOf(cam)] || {};
  const ver = (n) => ab[n]?.ver || 0;
  return { battery: ver('battery') > 0, doorbell: ver('supportDingDongCtrl') > 0 || ver('supportVisitorLoudspeaker') > 0 };
}

/** Il canale risulta collegato all'hub? (false = offline: batteria scarica o fuori portata; null = non si sa). */
export async function channelOnline(cam) {
  const [r] = await call(cam, [{ cmd: 'GetChannelstatus', action: 0, param: {} }]);
  const s = r?.value?.status?.find((x) => x.channel === channelOf(cam));
  return s ? s.online === 1 : false;
}
