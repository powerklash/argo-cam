// Icone Home Assistant sui riquadri: stato di sensori e interruttori, con comando per quelli comandabili.
// Il browser parla solo con questo server; indirizzo e token di Home Assistant restano sul server.
import { t } from './i18n.js';
import { state, $, $$, api, el, toast, errorText } from './state.js';
import { loadMdi, mdiLoaded, mdiPath, searchMdi, SUGGESTED } from './mdi-search.js';

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
    }, el('span', { class: 'ico' }, item.path ? mdiSvg(item.path, 18) : item.icon), el('span', { class: 'val' }));
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
// Icone: quelle monocromatiche di Home Assistant ("mdi:nome", con ricerca) oltre a un piccolo elenco di emoji.
export const ICONS = [
  '🚧', '🚪', '🏠', '🏡', '🔒', '🔓', '🔑', '🚨', '🔔', '🛡️',
  '🌡️', '💦', '🌬️', '💨', '🌧️', '⛈️', '❄️', '🔥', '♨️', '☀️', '🌙', '🧊',
  '💡', '🔦', '🔌', '⚡', '🔋', '📡', '📶', '🌀', '🪟', '🧯', '💧', '🚿',
  '🚗', '🅿️', '🛵', '🚶', '🐾', '📦', '🎥', '👁️', '🔊', '📺', '🌱', '🪴', '🏊', '🧹', '🛏️', '⚙️',
];
const MAX = 6;
let entitiesLoaded = false;
const entityInfo = new Map(); // id entità -> { deviceClass, control }

/** Icona SVG monocromatica (colore del testo) dal tracciato di un'icona mdi. */
export function mdiSvg(d, size = 20) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('mdi');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', d);
  p.setAttribute('fill', 'currentColor');
  svg.append(p);
  return svg;
}

// Icona suggerita in base al tipo di entità (classe del dispositivo, poi dominio): nomi delle icone mdi.
const BY_CLASS = {
  temperature: 'thermometer', humidity: 'water-percent', wind_speed: 'weather-windy', wind_gust_speed: 'weather-windy', precipitation: 'weather-rainy',
  precipitation_intensity: 'weather-rainy', illuminance: 'white-balance-sunny', motion: 'run', occupancy: 'motion-sensor', presence: 'account',
  door: 'door', opening: 'door-open', garage_door: 'garage', gate: 'gate', window: 'window-open', smoke: 'smoke-detector', gas: 'gas-cylinder',
  moisture: 'water-alert', water: 'water', battery: 'battery', power: 'flash', energy: 'flash', current: 'flash', voltage: 'flash', lock: 'lock',
  safety: 'alarm-light', tamper: 'alarm-light', vibration: 'vibrate', signal_strength: 'wifi', pressure: 'gauge', connectivity: 'lan-connect', carbon_dioxide: 'molecule-co2',
};
const BY_DOMAIN = {
  cover: 'window-shutter', lock: 'lock', light: 'lightbulb', switch: 'toggle-switch', fan: 'fan', climate: 'thermostat', weather: 'weather-partly-cloudy',
  button: 'gesture-tap-button', script: 'script-text', scene: 'palette', input_boolean: 'toggle-switch', binary_sensor: 'checkbox-marked-circle', sensor: 'gauge',
};
function suggestIcon(entity) {
  const info = entityInfo.get(entity);
  const domain = entity.split('.')[0];
  if (/cancell|gate|portone|garage|basculante/.test(entity)) return 'gate';
  return BY_CLASS[info?.deviceClass] || BY_DOMAIN[domain] || '';
}

/** Selettore dell'icona di una riga: pulsante con l'icona attuale e, sotto, ricerca + elenco (come in Home Assistant). */
function iconPicker(n, initial, initialPath, touched) {
  const field = el('input', { type: 'hidden', name: `ha_icon_${n}` });
  const button = el('button', { type: 'button', class: 'icon-btn', title: t('ha.iconPick'), 'aria-label': t('ha.iconPick') });
  const pop = el('div', { class: 'icon-pop', hidden: true });
  const q = el('input', { type: 'search', class: 'icon-q', placeholder: t('ha.iconSearch'), autocomplete: 'off', autocapitalize: 'none', spellcheck: false });
  const grid = el('div', { class: 'icon-grid' });
  const note = el('p', { class: 'note' });
  pop.append(q, grid, note);

  const set = (value, d) => {
    field.value = value;
    button.replaceChildren(d ? mdiSvg(d, 22) : document.createTextNode(value));
    if (!pop.hidden) show();
  };
  const choose = (value, d) => { field.dataset.touched = '1'; set(value, d); pop.hidden = true; };
  const cell = (value, d, title) => el('button', { type: 'button', class: `icon-opt${value === field.value ? ' on' : ''}`, title, onclick: () => choose(value, d) }, d ? mdiSvg(d, 24) : value);
  function show() {
    const text = q.value.trim();
    if (!text) { // niente ricerca: icone adatte alla casa, poi le emoji
      const suggested = mdiLoaded() ? SUGGESTED.filter((name) => mdiPath(name)).map((name) => cell(`mdi:${name}`, mdiPath(name), name)) : [];
      grid.replaceChildren(...suggested, ...ICONS.map((e) => cell(e, null, e)));
      note.textContent = mdiLoaded() ? '' : t('ha.iconLoading');
    } else {
      const found = searchMdi(text);
      grid.replaceChildren(...found.map((i) => cell(`mdi:${i.name}`, i.d, i.name)));
      note.textContent = !found.length ? t('ha.iconNone') : found.length >= 96 ? t('ha.iconMore', { n: 96 }) : '';
    }
  }
  let timer2;
  q.addEventListener('input', () => { clearTimeout(timer2); timer2 = setTimeout(show, 120); });
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); grid.querySelector('.icon-opt')?.click(); } });
  button.addEventListener('click', async () => {
    pop.hidden = !pop.hidden;
    if (pop.hidden) return;
    show();
    q.focus();
    try { await loadMdi(); } catch { note.textContent = t('ha.iconFail'); return; }
    show();
  });
  set(initial, initialPath);
  if (touched) field.dataset.touched = '1';
  return { cell: el('div', { class: 'icon-cell' }, button, field), pop, field, set };
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
    const known = ICONS.includes(it.icon) || (/^mdi:/.test(it.icon || '') && it.path);
    const picker = iconPicker(n, known ? it.icon : ICONS[n % ICONS.length], known && /^mdi:/.test(it.icon) ? it.path : null, !!it.icon);
    // Se non l'hai scelta tu, l'icona si adatta al tipo di entità (cancello, temperatura, umidità, vento…).
    entity.addEventListener('change', () => {
      const s = suggestIcon(entity.value.trim().toLowerCase());
      if (!s || picker.field.dataset.touched) return;
      loadMdi().then(() => { if (mdiPath(s) && !picker.field.dataset.touched) picker.set(`mdi:${s}`, mdiPath(s)); }).catch(() => {});
    });
    rows.append(el('div', { class: 'ha-row' }, picker.cell, entity, label, picker.pop));
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
