// Icone Home Assistant sui riquadri: stato di sensori e interruttori, con comando per quelli comandabili.
// Il browser parla solo con questo server; indirizzo e token di Home Assistant restano sul server.
import { t } from './i18n.js';
import { state, $, $$, api, el, toast, errorText } from './state.js';

const ON_STATES = new Set(['on', 'open', 'opening', 'home', 'detected', 'unlocked', 'unlocking', 'playing', 'heat', 'cool', 'true']);
let timer = null;

/** Crea (o ricrea) le icone di una telecamera dentro il riquadro. */
export function mountHa(tile, cam) {
  const box = $('.ha-icons', tile);
  if (!box) return;
  box.replaceChildren();
  box.hidden = !cam.ha?.length;
  for (const item of cam.ha || []) {
    const canTap = item.control && cam.level >= 2;
    const btn = el('button', {
      type: 'button', class: `ha-btn unknown${canTap ? ' tap' : ''}`, dataset: { i: item.i, control: canTap ? '1' : '' },
      title: item.label || '',
      'aria-label': item.label || item.icon,
    }, el('span', { class: 'ico' }, item.icon), el('span', { class: 'val' }));
    // Il clic sull'icona non cambia la selezione del riquadro e il doppio clic non lo ingrandisce.
    btn.addEventListener('dblclick', (e) => e.stopPropagation());
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!canTap || btn.disabled) return;
      // Serrature: si chiede conferma prima di aprire (da chiusa a aperta).
      if (item.kind === 'lock' && !btn.classList.contains('on') && !confirm(t('ha.confirmUnlock', { name: item.label || '' }))) return;
      btn.disabled = true;
      try {
        const r = await api('POST', `/api/cameras/${cam.id}/ha/${item.i}/power`, { on: item.kind === 'press' ? true : !btn.classList.contains('on') });
        paint(btn, item, r);
      } catch (err) {
        toast(errorText(err), { kind: 'err' });
      } finally {
        btn.disabled = false;
      }
    });
    box.append(btn);
  }
  schedule();
}

function format(s) {
  const n = Number(s.state);
  if (!Number.isFinite(n)) return '';
  const v = Math.abs(n) >= 100 ? Math.round(n) : Math.round(n * 10) / 10;
  return `${v}${s.unit || ''}`;
}

function paint(btn, item, s) {
  const known = s && s.available;
  const isSensor = !btn.dataset.control && !['on', 'off'].includes(s?.state);
  const numeric = known && isSensor ? format(s) : '';
  btn.classList.toggle('unknown', !known);
  btn.classList.toggle('on', !!known && ON_STATES.has(String(s.state).toLowerCase()));
  btn.querySelector('.val').textContent = numeric;
  btn.title = `${item.label || ''}${item.label ? ': ' : ''}${known ? s.state + (s.unit ? ` ${s.unit}` : '') : t('ha.unavailable')}`;
}

async function refresh() {
  const tiles = $$('.tile');
  if (document.hidden || !tiles.some((x) => $('.ha-icons button', x))) return;
  try {
    const { cameras } = await api('GET', '/api/ha/states');
    for (const tile of tiles) {
      const cam = state.cameras.find((c) => c.id === tile.dataset.id);
      const list = cameras[tile.dataset.id] || [];
      for (const btn of $$('.ha-btn', tile)) {
        const item = cam?.ha?.find((h) => String(h.i) === btn.dataset.i);
        const s = list.find((x) => String(x.i) === btn.dataset.i);
        if (item) paint(btn, item, s);
      }
    }
  } catch { /* si riprova al giro successivo */ }
}

function schedule() {
  if (timer) return;
  refresh();
  timer = setInterval(refresh, 4000);
}

// ---------- modulo telecamera (solo amministratore): fino a 6 entità ----------
// Icone "di casa": cancelli e porte, serrature, allarmi, temperature, umidità, vento, pioggia, luci, energia, auto…
export const ICONS = [
  '🚧', '🚪', '🏠', '🏡', '🔒', '🔓', '🔑', '🚨', '🔔', '🛡️',
  '🌡️', '💦', '🌬️', '💨', '🌧️', '⛈️', '❄️', '🔥', '♨️', '☀️', '🌙', '🧊',
  '💡', '🔦', '🔌', '⚡', '🔋', '📡', '📶', '🌀', '🪟', '🧯', '💧', '🚿',
  '🚗', '🅿️', '🛵', '🚶', '🐾', '📦', '🎥', '👁️', '🔊', '📺', '🌱', '🪴', '🏊', '🧹', '🛏️', '⚙️',
];
const MAX = 6;
let entitiesLoaded = false;
const entityInfo = new Map(); // id entità -> { deviceClass, control }

// Icona suggerita in base al tipo di entità (classe del dispositivo, poi dominio).
const BY_CLASS = {
  temperature: '🌡️', humidity: '💦', wind_speed: '🌬️', wind_gust_speed: '🌬️', precipitation: '🌧️', precipitation_intensity: '🌧️',
  illuminance: '☀️', motion: '🚶', occupancy: '🚶', presence: '🚶', door: '🚪', opening: '🚪', garage_door: '🚧', gate: '🚧', window: '🪟',
  smoke: '🧯', gas: '🔥', moisture: '💧', water: '💧', battery: '🔋', power: '⚡', energy: '⚡', current: '⚡', voltage: '⚡',
  lock: '🔒', safety: '🚨', tamper: '🚨', vibration: '🚨', signal_strength: '📶', pressure: '🌀', connectivity: '📡', carbon_dioxide: '💨',
};
const BY_DOMAIN = { cover: '🚧', lock: '🔒', light: '💡', switch: '🔌', fan: '🌀', climate: '🌡️', weather: '⛈️', button: '🔔', script: '⚙️', scene: '🏠', input_boolean: '🔌', binary_sensor: '🚪', sensor: '🌡️' };
function suggestIcon(entity) {
  const info = entityInfo.get(entity);
  const domain = entity.split('.')[0];
  const name = entity.toLowerCase();
  if (/cancell|gate|portone|garage|basculante/.test(name)) return '🚧';
  return BY_CLASS[info?.deviceClass] || BY_DOMAIN[domain] || '';
}

/** Disegna le 6 righe del modulo con le icone già impostate. */
export function fillHaRows(items = []) {
  const rows = $('#ha-rows');
  rows.replaceChildren();
  for (let n = 0; n < MAX; n++) {
    const it = items[n] || {};
    const entity = el('input', { name: `ha_entity_${n}`, value: it.entity || '', placeholder: t('ha.entity'), maxLength: 80, autocomplete: 'off', autocapitalize: 'none', spellcheck: false });
    entity.setAttribute('list', 'ha-entities');
    const label = el('input', { name: `ha_label_${n}`, value: it.label || '', placeholder: t('ha.label'), maxLength: 40 });
    const icon = el('select', { name: `ha_icon_${n}` });
    for (const i of ICONS) icon.add(new Option(i, i));
    icon.value = ICONS.includes(it.icon) ? it.icon : ICONS[n % ICONS.length];
    // Se non l'hai scelta tu, l'icona si adatta al tipo di entità (cancello, temperatura, umidità, vento…).
    icon.addEventListener('change', () => { icon.dataset.touched = '1'; });
    if (it.icon) icon.dataset.touched = '1';
    entity.addEventListener('change', () => {
      const s = suggestIcon(entity.value.trim().toLowerCase());
      if (s && !icon.dataset.touched && ICONS.includes(s)) icon.value = s;
    });
    rows.append(el('div', { class: 'ha-row' }, icon, entity, label));
  }
  loadEntities();
}

/** Suggerimenti per il campo entità, letti da Home Assistant (se configurato). */
async function loadEntities() {
  if (entitiesLoaded) return;
  entitiesLoaded = true;
  try {
    const { entities } = await api('GET', '/api/ha/entities');
    $('#ha-entities').replaceChildren(...entities.map((e) => {
      entityInfo.set(e.id, { deviceClass: e.deviceClass, control: e.control });
      const o = el('option', { value: e.id });
      o.label = `${e.name} ${e.control ? '⏻' : ''}`.trim();
      return o;
    }));
  } catch { entitiesLoaded = false; /* Home Assistant non configurato: si scrive a mano */ }
}

/** Legge le righe compilate: [{ entity, label, icon }]. */
export function readHaRows() {
  const out = [];
  for (let n = 0; n < MAX; n++) {
    const entity = $(`[name="ha_entity_${n}"]`).value.trim();
    if (entity) out.push({ entity, label: $(`[name="ha_label_${n}"]`).value.trim(), icon: $(`[name="ha_icon_${n}"]`).value });
  }
  return out;
}

document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
