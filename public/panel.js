// Pannello opzioni della telecamera: Reolink (tutte le impostazioni che la telecamera dichiara)
// ed Eufy (impostazioni lette e scritte in locale tramite P2P).
import { t, has } from './i18n.js';
import { $, api, el, errorText, isAdmin } from './state.js';

let current = null;
export const panelCam = () => current;

const body = () => $('#panel-body');
function status(text, isError = false) {
  const node = $('#panel-status');
  node.textContent = text;
  node.classList.toggle('err', isError);
}

// ---------- etichette ----------
const humanize = (k) => k.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
const labelOf = (k) => (has(`f.${k}`) ? t(`f.${k}`) : humanize(k));
const prefixOf = (k) => (has(`pre.${k}`) ? t(`pre.${k}`) : labelOf(k));
const HIDDEN_PREFIX = new Set(['schedule', 'aiTrack', 'newSens']);

const MASTER_GROUPS = new Set(['rec', 'push', 'email', 'ftp']);

function fieldLabel(path, group) {
  // In registrazione, push, e-mail e FTP l'interruttore "scheduleEnable" è quello vero: prende il nome della funzione.
  if (path === 'scheduleEnable' && group && MASTER_GROUPS.has(group.id)) return t('f.masterOn');
  const parts = path.split('.');
  const last = parts.pop();
  const pre = parts.filter((p) => !HIDDEN_PREFIX.has(p)).map(prefixOf).join(' · ');
  // Un interruttore "enable" prende il nome del suo contenitore (es. "Data e ora").
  const own = last === 'enable' && pre ? '' : labelOf(last);
  return [pre, own].filter(Boolean).join(' · ') || last;
}
const optionLabel = (o) => (has(`o.${o}`) ? t(`o.${o}`) : String(o));

// ---------- campi Reolink ----------
const camPost = (what, data) => api('POST', `/api/cameras/${current.id}/reolink/${what}`, data);

function renderField(group, f, box) {
  const name = el('span', { title: f.path }, fieldLabel(f.path, group));
  let input;
  let read = () => input.value;
  if (f.type === 'info') {
    input = el('span', { class: 'info' }, typeof f.value === 'boolean' ? t(f.value ? 'yes' : 'no') : String(f.value));
  } else if (f.type === 'bool') {
    input = el('input', { type: 'checkbox', checked: f.value });
    read = () => input.checked;
  } else if (f.type === 'select') {
    input = el('select');
    for (const o of f.options) input.add(new Option(optionLabel(o), String(o)));
    input.value = String(f.value);
  } else if (f.type === 'range') {
    const slider = el('input', { type: 'range', min: f.min, max: f.max, value: f.value });
    const out = el('output', {}, String(f.value));
    slider.addEventListener('input', () => (out.textContent = slider.value));
    input = el('span', { class: 'slider' }, slider, out);
    read = () => Number(slider.value); // l'evento 'change' del cursore sale fino al contenitore
  } else {
    input = el('input', { type: f.type === 'number' ? 'number' : 'text', value: f.value });
    if (f.type === 'text') input.maxLength = 32;
  }
  if (f.type !== 'info' && !group.readOnly) {
    // Ogni modifica viene inviata subito; la telecamera risponde con i valori effettivi.
    input.addEventListener('change', async () => {
      const label = fieldLabel(f.path, group);
      status(t('panel.saving', { n: label }));
      try {
        const fresh = await camPost('set', { group: group.id, changes: { [f.path]: read() } });
        group.fields = fresh.fields;
        status(t('panel.saved', { n: label }));
      } catch (err) {
        status(errorText(err), true);
      }
      renderGroupFields(group, box);
    });
  }
  box.append(el('label', { class: 'field' }, name, input));
}

function renderGroupFields(group, box) {
  box.replaceChildren();
  for (const f of group.fields) renderField(group, f, box);
}

// Pulsante "a pressione": il movimento dura finché si tiene premuto.
function holdButton(text, title, op) {
  const b = el('button', { title }, text);
  let active = false;
  const stop = () => {
    if (!active) return;
    active = false;
    camPost('ptz', { op: 'Stop' }).catch((err) => status(errorText(err), true));
  };
  b.addEventListener('pointerdown', (e) => {
    b.setPointerCapture(e.pointerId);
    active = true;
    camPost('ptz', { op, speed: Number($('#ptz-speed')?.value || 32) }).catch((err) => status(errorText(err), true));
  });
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) b.addEventListener(ev, stop);
  return b;
}

function actionButton(text, run, confirmText) {
  const b = el('button', {}, text);
  b.addEventListener('click', async () => {
    if (confirmText && !confirm(confirmText)) return;
    b.disabled = true;
    try {
      await run();
      status(t('panel.done', { n: text }));
    } catch (err) {
      status(errorText(err), true);
    }
    b.disabled = false;
  });
  return b;
}

const row = (title, ...nodes) => el('div', { class: 'row' }, title ? el('span', {}, title) : null, ...nodes);

function renderActions(a, cam) {
  const box = el('div', { class: 'acts' });
  if (a.ptz) {
    const dirs = [['↖', 'LeftUp'], ['▲', 'Up'], ['↗', 'RightUp'], ['◀', 'Left'], null, ['▶', 'Right'], ['↙', 'LeftDown'], ['▼', 'Down'], ['↘', 'RightDown']];
    const pad = el('div', { class: 'pad' }, dirs.map((d) => (d ? holdButton(d[0], t('act.hold'), d[1]) : el('span'))));
    box.append(pad, row(t('act.speed'), el('input', { type: 'range', id: 'ptz-speed', min: 1, max: 64, value: 32 })));
  }
  if (a.zoom) {
    box.append(row(t('act.zoomFocus'),
      holdButton(t('act.zoomOut'), t('act.hold'), 'ZoomDec'), holdButton(t('act.zoomIn'), t('act.hold'), 'ZoomInc'),
      holdButton(t('act.focusNear'), t('act.hold'), 'FocusDec'), holdButton(t('act.focusFar'), t('act.hold'), 'FocusInc')));
  }
  if (a.presets.length) {
    box.append(row(t('act.presets'), ...a.presets.map((p) =>
      actionButton(p.name || t('act.preset', { n: p.id }), () => camPost('ptz', { op: 'ToPos', id: p.id })))));
  }
  if (a.guard || a.calibrate) {
    const items = [];
    if (a.guard) {
      items.push(actionButton(t('act.guardGo'), () => camPost('action', { name: 'guardGoto' })));
      items.push(actionButton(t('act.guardSet'), () => camPost('action', { name: 'guardSet' }), t('act.guardSetConfirm')));
    }
    if (a.calibrate) items.push(actionButton(t('act.calibrate'), () => camPost('action', { name: 'calibrate' }), t('act.calibrateConfirm')));
    box.append(row(t('act.position'), ...items));
  }
  if (a.siren) {
    box.append(row(t('act.siren'),
      actionButton(t('act.sirenOn'), () => camPost('action', { name: 'sirenOn' }), t('act.sirenOnConfirm')),
      actionButton(t('act.sirenOff'), () => camPost('action', { name: 'sirenOff' }))));
  }
  box.append(row('', el('a', { href: `/go2rtc/api/frame.jpeg?src=${encodeURIComponent(`${cam.id}_main`)}`, target: '_blank' }, t('act.snapshot'))));
  return box;
}

async function openReolink(cam) {
  const s = await api('GET', `/api/cameras/${cam.id}/reolink/settings`);
  if (current !== cam) return;
  $('#panel-sub').textContent = s.model;
  body().append(renderActions(s.actions, cam));
  for (const g of s.groups) {
    const label = t(`grp.${g.id}`, null, g.label);
    const box = el('div');
    body().append(el('details', {}, el('summary', {}, g.readOnly ? t('panel.readOnly', { label }) : label), box));
    renderGroupFields(g, box);
  }
  status(t('panel.counts', { n: s.groups.reduce((n, g) => n + g.fields.length, 0), g: s.groups.length }));
}

// ---------- Eufy ----------
function renderEufy(cam, s, box) {
  box.replaceChildren();
  for (const f of s.fields) {
    const label = t(`ef.${f.key}`, null, f.key);
    let input;
    if (f.type === 'bool') input = el('input', { type: 'checkbox', checked: f.value });
    else {
      input = el('select');
      for (const o of f.options) input.add(new Option(t(`eo.${f.key}.${o}`, null, String(o)), String(o)));
      input.value = String(f.value);
    }
    input.addEventListener('change', async () => {
      status(t('panel.saving', { n: label }));
      input.disabled = true;
      try {
        const fresh = await api('POST', `/api/cameras/${cam.id}/eufy/set`, { key: f.key, value: f.type === 'bool' ? input.checked : Number(input.value) });
        status(t('panel.saved', { n: label }));
        renderEufy(cam, fresh, box);
      } catch (err) {
        status(errorText(err), true);
        input.disabled = false;
      }
    });
    box.append(el('label', { class: 'field' }, el('span', {}, label), input));
  }
}

async function openEufy(cam) {
  const s = await api('GET', `/api/cameras/${cam.id}/eufy/settings`);
  if (current !== cam) return;
  if (!s.supported) {
    body().append(el('p', { class: 'note' }, t('eufy.notSupported')));
    status('');
    return;
  }
  $('#panel-sub').textContent = [s.model, s.firmware && t('eufy.firmware', { v: s.firmware })].filter(Boolean).join(' · ');
  const box = el('div');
  body().append(el('h3', {}, t('eufy.group')), box, el('p', { class: 'note' }, t('eufy.qualityTip')));
  renderEufy(cam, s, box);
  status(t('panel.counts', { n: s.fields.length, g: 1 }));
}

// ---------- connessione (solo amministratore) ----------
function qualityOf(sig) {
  if (!sig) return '';
  const v = sig.value;
  const level = sig.unit === 'dBm' ? (v >= -60 ? 3 : v >= -70 ? 2 : v >= -80 ? 1 : 0) : (v >= 70 ? 3 : v >= 45 ? 2 : v >= 20 ? 1 : 0);
  return t(`net.q${level}`);
}

async function connectionBlock(cam) {
  const box = el('div', { class: 'netinfo' });
  const det = el('details', { open: true }, el('summary', {}, t('net.title')), box);
  body().prepend(det);
  box.append(el('p', { class: 'note' }, t('net.reading')));
  try {
    const n = await api('GET', `/api/cameras/${cam.id}/network`);
    if (current !== cam) return;
    const rows = [];
    const add = (label, value) => { if (value) rows.push(el('label', { class: 'field' }, el('span', {}, label), el('span', { class: 'info' }, value))); };
    if (n.sleeping) add(t('net.state'), t('net.sleeping'));
    add(t('net.ip'), n.ip);
    if (n.hub) {
      add(t('net.hub'), n.hub.name);
      add(t('net.state'), n.hub.online === false ? t('net.offline') : n.hub.sleeping ? t('net.sleeping') : n.hub.online ? t('net.online') : '');
    }
    add(t('net.link'), n.link === 'wifi' ? 'Wi‑Fi' : n.link === 'lan' ? t('net.lan') : '');
    add(t('net.ssid'), n.ssid);
    if (n.signal) add(t('net.signal'), `${n.signal.value} ${n.signal.unit} · ${qualityOf(n.signal)}`);
    else if (n.hub) add(t('net.signal'), t('net.noSignalHub'));
    add(t('net.mac'), n.mac);
    add(t('net.firmware'), n.firmware);
    add(t('net.model'), n.model);
    box.replaceChildren(...rows);
    if (n.canReboot) {
      const b = el('button', { class: 'danger' }, t('net.reboot'));
      b.addEventListener('click', async () => {
        if (!confirm(t('net.rebootConfirm', { name: cam.name }))) return;
        b.disabled = true;
        try {
          await api('POST', `/api/cameras/${cam.id}/reboot`);
          status(t('net.rebooting'));
        } catch (err) {
          status(errorText(err), true);
          b.disabled = false;
        }
      });
      box.append(el('div', { class: 'row' }, b));
    } else if (n.hub) {
      box.append(el('p', { class: 'note' }, t('net.noRebootHub')));
    }
  } catch (err) {
    box.replaceChildren(el('p', { class: 'note err' }, errorText(err)));
  }
}

// ---------- apertura / chiusura ----------
export async function openPanel(cam) {
  current = cam;
  $('#panel').hidden = false;
  document.body.classList.add('panel-open');
  $('#panel-title').textContent = cam.name;
  $('#panel-sub').textContent = '';
  body().replaceChildren();
  status(t('panel.reading'));
  if (isAdmin()) connectionBlock(cam); // in parallelo: non rallenta le opzioni
  try {
    if (cam.brand === 'eufyp2p') await openEufy(cam);
    else await openReolink(cam);
  } catch (err) {
    if (current === cam) status(errorText(err), true);
  }
}

export function closePanel() {
  current = null;
  $('#panel').hidden = true;
  document.body.classList.remove('panel-open');
}
$('#panel-close').addEventListener('click', closePanel);
