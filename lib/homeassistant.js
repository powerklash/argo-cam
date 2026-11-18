// Home Assistant: stato e comando delle entità mostrate come icone sui riquadri delle telecamere.
//
// L'amministratore indica l'indirizzo di Home Assistant e un "token di accesso a lungo termine" (Impostazioni).
// Il token resta solo sul server (DATA/homeassistant.json, permessi 600) e non viene mai restituito al browser.
// Il server legge gli stati a intervalli e li tiene in memoria: il browser chiede solo a questo server.
// Si possono comandare solo interruttori semplici (switch, light, input_boolean, fan); sensori e sensori
// binari sono in sola lettura.
import fs from 'node:fs';
import path from 'node:path';
import { DATA } from './paths.js';

const FILE = path.join(DATA, 'homeassistant.json');
export const MAX_ICONS = 6;
const ENTITY_RE = /^[a-z_]+\.[a-z0-9_]+$/;
const POWER_DOMAINS = ['switch', 'light', 'input_boolean', 'fan'];   // acceso/spento
const PRESS_DOMAINS = ['button', 'input_button', 'script', 'scene']; // un solo comando (es. apri cancello da script)
const READ_DOMAINS = ['sensor', 'binary_sensor', 'cover', 'lock', 'climate', 'weather', ...POWER_DOMAINS, ...PRESS_DOMAINS];
const CONTROL_DOMAINS = [...POWER_DOMAINS, ...PRESS_DOMAINS, 'cover', 'lock'];
const POLL_MS = 3000;
const TIMEOUT_MS = 6000;

let config = { url: '', token: '' };
try {
  config = { ...config, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
} catch { /* non ancora configurato */ }

export const domainOf = (entity) => String(entity).split('.')[0];
export const canControl = (entity) => CONTROL_DOMAINS.includes(domainOf(entity));
/** Tipo di comando: power (acceso/spento), cover (apri/chiudi), lock (chiudi/apri serratura), press (un solo comando). */
export const controlKind = (entity) => {
  const d = domainOf(entity);
  return POWER_DOMAINS.includes(d) ? 'power' : PRESS_DOMAINS.includes(d) ? 'press' : d === 'cover' ? 'cover' : d === 'lock' ? 'lock' : '';
};
export const isConfigured = () => !!(config.url && config.token);
export const publicConfig = () => ({ url: config.url, hasToken: !!config.token });

function cleanUrl(value) {
  let u;
  try { u = new URL(String(value || '').trim()); } catch { throw new Error('Indirizzo di Home Assistant non valido (es. http://192.168.1.10:8123)'); }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw new Error('Indirizzo di Home Assistant non valido (es. http://192.168.1.10:8123)');
  return u.origin;
}

export function setConfig({ url, token }) {
  const next = { url: cleanUrl(url), token: typeof token === 'string' && token.trim() ? token.trim() : config.token };
  if (!next.token) throw new Error('Inserisci il token di accesso a lungo termine');
  if (next.token.length > 4000 || /\s/.test(next.token)) throw new Error('Token non valido');
  config = next;
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(config), { mode: 0o600 });
  cache.clear();
  poll();
  return publicConfig();
}

export function clearConfig() {
  config = { url: '', token: '' };
  try { fs.rmSync(FILE, { force: true }); } catch { /* già assente */ }
  cache.clear();
  return publicConfig();
}

async function ha(method, apiPath, body) {
  if (!isConfigured()) throw new Error('Home Assistant non configurato');
  const res = await fetch(config.url + apiPath, {
    method,
    headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
    redirect: 'error',
  });
  if (res.status === 401 || res.status === 403) throw new Error('Home Assistant ha rifiutato il token');
  if (!res.ok) throw new Error(`Home Assistant: errore ${res.status}`);
  return res;
}

/** Prova la connessione: restituisce il nome dell'installazione e il numero di entità. */
export async function test() {
  const info = await (await ha('GET', '/api/config')).json();
  const states = await (await ha('GET', '/api/states')).json();
  return { name: info.location_name || '', version: info.version || '', entities: Array.isArray(states) ? states.length : 0 };
}

/** Elenco delle entità utilizzabili, per il suggerimento mentre si scrive. */
export async function entities() {
  const states = await (await ha('GET', '/api/states')).json();
  return states
    .filter((s) => READ_DOMAINS.includes(domainOf(s.entity_id)))
    .map((s) => ({ id: s.entity_id, name: s.attributes?.friendly_name || '', state: s.state, control: canControl(s.entity_id), deviceClass: s.attributes?.device_class || '' }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

// ---------- stati tenuti in memoria ----------
const cache = new Map(); // entità -> { state, unit, deviceClass, name }
let wanted = () => [];
let lastOk = 0;
let lastError = '';
let polling = false;

async function poll() {
  if (polling || !isConfigured()) return;
  const ids = [...new Set(wanted())].filter((e) => ENTITY_RE.test(e));
  if (!ids.length) return;
  polling = true;
  try {
    // Un'unica richiesta: il template restituisce lo stato di tutte le entità volute.
    const template =
      `{% set out = namespace(l=[]) %}{% for e in ${JSON.stringify(ids)} %}` +
      `{% set out.l = out.l + [{'id': e, 'state': states(e), 'unit': state_attr(e, 'unit_of_measurement'), 'dc': state_attr(e, 'device_class'), 'name': state_attr(e, 'friendly_name')}] %}` +
      `{% endfor %}{{ out.l | tojson }}`;
    const rows = JSON.parse(await (await ha('POST', '/api/template', { template })).text());
    for (const r of rows) cache.set(r.id, { state: String(r.state), unit: r.unit || '', deviceClass: r.dc || '', name: r.name || '' });
    lastOk = Date.now();
    lastError = '';
  } catch (err) {
    lastError = err.message;
  } finally {
    polling = false;
  }
}

/** Avvia la lettura periodica; `getEntities` restituisce le entità attualmente configurate sulle telecamere. */
export function startPolling(getEntities) {
  wanted = getEntities;
  setInterval(poll, POLL_MS).unref();
  poll();
}

/** Stato di un'entità: sempre un oggetto, con `available` falso se Home Assistant non risponde. */
export function stateOf(entity) {
  const s = cache.get(entity);
  const fresh = s && Date.now() - lastOk < POLL_MS * 4;
  if (!s || !fresh) return { state: 'unavailable', unit: '', deviceClass: '', name: s?.name || '', available: false };
  return { ...s, available: s.state !== 'unavailable' && s.state !== 'unknown' };
}

export const status = () => ({ configured: isConfigured(), ok: Date.now() - lastOk < POLL_MS * 4, error: lastError });

const SERVICES = {
  power: (d, on) => [d, on ? 'turn_on' : 'turn_off'],
  cover: (d, on) => [d, on ? 'open_cover' : 'close_cover'],
  lock: (d, on) => [d, on ? 'unlock' : 'lock'],
  press: (d) => [d, d === 'script' || d === 'scene' ? 'turn_on' : 'press'],
};

/** Esegue il comando dell'entità (accendi/spegni, apri/chiudi, premi) e rilegge subito lo stato. */
export async function setPower(entity, on) {
  if (!ENTITY_RE.test(entity) || !canControl(entity)) throw new Error('Questa entità non si può comandare');
  const [domain, service] = SERVICES[controlKind(entity)](domainOf(entity), on);
  await ha('POST', `/api/services/${domain}/${service}`, { entity_id: entity });
  await new Promise((r) => setTimeout(r, 400));
  await poll();
  return stateOf(entity);
}

// ---------- icone configurate su una telecamera ----------
const ICONS = [
  '🚧', '🚪', '🏠', '🏡', '🔒', '🔓', '🔑', '🚨', '🔔', '🛡️',
  '🌡️', '💦', '🌬️', '💨', '🌧️', '⛈️', '❄️', '🔥', '♨️', '☀️', '🌙', '🧊',
  '💡', '🔦', '🔌', '⚡', '🔋', '📡', '📶', '🌀', '🪟', '🧯', '💧', '🚿',
  '🚗', '🅿️', '🛵', '🚶', '🐾', '📦', '🎥', '👁️', '🔊', '📺', '🌱', '🪴', '🏊', '🧹', '🛏️', '⚙️',
];
export const ICON_CHOICES = ICONS;

/** Valida l'elenco di icone ricevuto dal browser. */
export function cleanItems(input) {
  if (input == null || input === '') return [];
  if (!Array.isArray(input) || input.length > MAX_ICONS) throw new Error(`Al massimo ${MAX_ICONS} icone per telecamera`);
  const seen = new Set();
  return input.filter((it) => String(it?.entity || '').trim()).map((it) => {
    const entity = String(it.entity).trim().toLowerCase();
    if (!ENTITY_RE.test(entity) || !READ_DOMAINS.includes(domainOf(entity))) throw new Error(`Entità non valida: ${entity.slice(0, 60)}`);
    if (seen.has(entity)) throw new Error(`Entità ripetuta: ${entity}`);
    seen.add(entity);
    return { entity, label: String(it.label || '').trim().slice(0, 40), icon: ICONS.includes(it.icon) ? it.icon : ICONS[0] };
  });
}
