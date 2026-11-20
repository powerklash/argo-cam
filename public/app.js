// Argo — interfaccia principale: griglia di riquadri, selezione, telecamere a batteria, modulo telecamera.
import './i18n-panel.js';
import { t, applyI18n, getLang, LANGS, setLang, fmtDate } from './i18n.js';
import { state, $, $$, api, el, camById, toast, errorText, isAdmin } from './state.js';
import './player.js';
import { svgIcon } from './icons.js';
import { openPanel, closePanel, panelCam } from './panel.js';
import { initSettings } from './settings.js';
import { initEvents, openEventsFor } from './events.js';
import { mountHa, fillHaRows, readHaRows } from './ha.js';

// Icone occhio: aperto = privacy spenta, barrato = privacy attiva.
const SVG = (inner) => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
const EYE = SVG('<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/>');
const EYE_OFF = SVG('<path d="M17.94 17.94A10.9 10.9 0 0 1 12 19C5 19 1 12 1 12a18.5 18.5 0 0 1 5.06-5.94M9.9 4.24A9.1 9.1 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19M14.12 14.12a3 3 0 1 1-4.24-4.24"/><path d="M1 1l22 22"/>');

const grid = $('#grid');
const dlg = $('#dlg');
const form = $('#form');
let editing = null;
let dragId = null;

const tileOf = (id) => $$('.tile', grid).find((x) => x.dataset.id === id);
const indexOf = (id) => state.cameras.findIndex((c) => c.id === id);

// ---------- qualità e montaggio dei flussi ----------
// Alta risoluzione solo per la telecamera ingrandita o per la principale della vista.
function wantedQuality(tile) {
  const hasPrimary = grid.dataset.layout !== 'grid';
  if (state.focusedId) return tile.dataset.id === state.focusedId ? 'main' : tile.dataset.quality || 'sub';
  return hasPrimary && tile === grid.firstElementChild ? 'main' : 'sub';
}

function mountStream(tile, quality) {
  tile.querySelector('cam-stream')?.remove();
  tile.classList.remove('live');
  tile.querySelector('.mode').textContent = '';
  tile.dataset.quality = quality;
  if (tile.dataset.paused || tile.dataset.private) return;
  const cam = camById(tile.dataset.id);
  // Solo la telecamera selezionata riceve l'audio: i flussi "_a" lo portano già convertito in Opus.
  const withAudio = tile.dataset.id === state.selectedId && !['eufyp2p', 'demo'].includes(cam?.brand);
  const node = document.createElement('cam-stream');
  node.media = tile.dataset.id === state.selectedId ? 'video,audio' : 'video';
  tile.prepend(node);
  node.src = `/go2rtc/api/ws?src=${encodeURIComponent(`${tile.dataset.id}_${quality}${withAudio ? '_a' : ''}`)}`;
}

function syncQuality() {
  for (const tile of grid.children) {
    const wanted = wantedQuality(tile);
    if (tile.dataset.quality !== wanted) mountStream(tile, wanted);
  }
}

function setFocus(id) {
  state.focusedId = id;
  grid.classList.toggle('has-focus', !!id);
  for (const tile of grid.children) tile.classList.toggle('focused', tile.dataset.id === id);
  syncQuality();
}

// ---------- selezione (riquadro celeste + audio) ----------
function setSelected(id) {
  if (state.selectedId === id) return;
  const prev = state.selectedId;
  state.selectedId = id;
  try { localStorage.setItem('selectedCam', id || ''); } catch { /* memoria del browser non disponibile */ }
  for (const tile of grid.children) tile.classList.toggle('selected', tile.dataset.id === id);
  // Il flusso si riapre con o senza audio.
  for (const tid of [prev, id]) {
    const tile = tid && tileOf(tid);
    if (tile && !tile.dataset.paused && tile.dataset.quality) mountStream(tile, tile.dataset.quality);
  }
}

// ---------- telecamere a batteria ----------
const wakeLimitOf = (cam) => cam.wakeLimit ?? state.settings?.wakeLimit ?? 60;

function renderCover(tile, message) {
  const cam = camById(tile.dataset.id);
  const cover = $('.cover', tile);
  if (!cam?.battery && !tile.dataset.stopped) { cover.hidden = true; return; }
  const waking = !!tile.dataset.waking;
  cover.hidden = !tile.dataset.paused;
  const btn = $('.wake-btn', cover);
  btn.disabled = waking;
  btn.textContent = tile.dataset.stopped ? '▶ ' + t('bat.play') : waking ? t('bat.waking') : `${state.sleeping.get(cam.id) === false ? '▶' : '⏻'} ${state.sleeping.get(cam.id) === false ? t('bat.play') : t('bat.wake')}`;
  // Eufy a riposo: durante l'attesa si può svegliare la telecamera dall'app Eufy.
  $('.cover-note', cover).textContent = message || (waking && cam.brand === 'eufyp2p' ? t('bat.wakingEufy') : '');
}

// ---------- livello batteria (ultimo noto, anche con la telecamera offline o scarica) ----------
function batteryIcon(b) {
  const pct = Math.max(0, Math.min(100, Math.round(b.percent)));
  const color = b.online === false ? '#8b94a3' : pct <= 15 ? '#ff5a5a' : pct <= 30 ? '#ffb84d' : '#3fbf6b';
  const w = Math.round(16 * pct / 100);
  return `<svg viewBox="0 0 26 12" width="26" height="12" aria-hidden="true"><rect x="0.5" y="0.5" width="21" height="11" rx="2.5" fill="none" stroke="${color}"/><rect x="22" y="3.5" width="2.5" height="5" rx="1" fill="${color}"/><rect x="3" y="3" width="${w}" height="6" rx="1" fill="${color}"/></svg>`;
}

function renderBattery(tile) {
  const cam = camById(tile.dataset.id);
  const box = $('.batt', tile);
  const b = cam?.battery && cam.batteryLevel;
  if (!b || !Number.isFinite(b.percent)) { box.hidden = true; return; }
  box.hidden = false;
  box.classList.toggle('low', b.percent <= 15);
  box.classList.toggle('off', b.online === false);
  const when = b.ts ? fmtDate(b.ts) : '';
  box.innerHTML = `${batteryIcon(b)}<span>${Math.round(b.percent)}%${b.charging ? ' ⚡' : ''}${b.online === false ? ' ⌀' : ''}</span>`;
  box.title = `${t('batt.level', { n: Math.round(b.percent) })}${b.charging ? ` · ${t('batt.charging')}` : ''}${b.online === false ? ` · ${t('batt.offline')}` : ''}${when ? ` · ${t('batt.updated', { d: when })}` : ''}`;
}

async function refreshBatteries() {
  if (document.hidden || !state.cameras.some((c) => c.battery)) return;
  try {
    const map = await api('GET', '/api/battery');
    for (const c of state.cameras) if (c.battery && map[c.id]) c.batteryLevel = map[c.id];
    for (const tile of grid.children) renderBattery(tile);
  } catch { /* si riprova al giro successivo */ }
}
setInterval(refreshBatteries, 60_000);

/** Ferma il video in diretta di una telecamera (qualsiasi tipo): non scarica nulla finché non si preme Avvia. */
function stopTile(tile) {
  tile.dataset.paused = '1';
  tile.dataset.stopped = '1';
  tile.querySelector('cam-stream')?.remove();
  tile.classList.remove('live');
  renderCover(tile);
  syncStopAll();
}

function resumeTile(tile) {
  delete tile.dataset.stopped;
  const cam = camById(tile.dataset.id);
  if (cam?.battery) { startBattery(tile); syncStopAll(); return; }
  delete tile.dataset.paused;
  renderCover(tile);
  mountStream(tile, wantedQuality(tile));
  syncStopAll();
}

function syncStopAll() {
  const btn = $('#btn-stopall');
  if (!btn) return;
  const live = [...grid.children].some((x) => !x.dataset.paused && !x.dataset.private);
  btn.dataset.state = live ? 'stop' : 'start';
  btn.textContent = live ? '⏹ ' + t('tile.stopAll') : '▶ ' + t('tile.startAll');
}

function pauseTile(tile) {
  tile.dataset.paused = '1';
  delete tile.dataset.deadline;
  tile.querySelector('cam-stream')?.remove();
  tile.classList.remove('live');
  $('.bat-note', tile).textContent = '';
  renderCover(tile);
}

async function startBattery(tile) {
  const cam = camById(tile.dataset.id);
  if (!cam || tile.dataset.waking) return;
  tile.dataset.waking = '1';
  renderCover(tile);
  try {
    await api('POST', `/api/cameras/${cam.id}/wake`);
  } catch (err) {
    delete tile.dataset.waking;
    renderCover(tile, err.message === 'ASLEEP' ? t('bat.asleep') : `${t('bat.failed')} ${errorText(err)}`);
    return;
  }
  delete tile.dataset.waking;
  delete tile.dataset.paused;
  const limit = wakeLimitOf(cam);
  if (limit > 0) tile.dataset.deadline = String(Date.now() + limit * 1000);
  else delete tile.dataset.deadline;
  renderCover(tile);
  mountStream(tile, wantedQuality(tile));
}

// Conto alla rovescia: allo scadere del tempo di sveglia la telecamera torna in pausa.
setInterval(() => {
  for (const tile of grid.children) {
    const note = $('.bat-note', tile);
    if (!tile.dataset.deadline) { if (note.textContent) note.textContent = ''; continue; }
    const left = Math.ceil((Number(tile.dataset.deadline) - Date.now()) / 1000);
    if (left <= 0) pauseTile(tile);
    else note.textContent = t('bat.countdown', { s: left });
  }
}, 1000);

document.addEventListener('camstatus', (e) => {
  const { camId, sleeping } = e.detail;
  state.sleeping.set(camId, sleeping);
  const tile = tileOf(camId);
  if (tile?.dataset.paused) renderCover(tile);
});

// ---------- ultima immagine e riquadro "offline" ----------
// Il browser che guarda una telecamera in diretta ne manda al server un fotogramma circa al minuto. Quando la
// telecamera è offline, spenta o a riposo si mostra quell'ultima immagine dipinta di verde (con la scritta in basso a destra).
const OFFLINE_AFTER_MS = 10_000;

function captureFrame(tile) {
  const v = tile.querySelector('cam-stream video');
  if (!v || !v.videoWidth || v.readyState < 2) return;
  const w = Math.min(640, v.videoWidth), h = Math.round((w * v.videoHeight) / v.videoWidth);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  try { c.getContext('2d').drawImage(v, 0, 0, w, h); } catch { return; }
  c.toBlob((b) => {
    if (b) fetch(`/api/cameras/${tile.dataset.id}/lastframe`, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: b }).catch(() => {});
  }, 'image/jpeg', 0.7);
}

async function setOffline(tile, off, asleep) {
  let box = $('.offline', tile);
  if (!off) {
    if (box) { box.remove(); tile.classList.remove('is-offline'); delete tile.dataset.offFrame; }
    return;
  }
  if (!box) {
    box = el('div', { class: 'offline' }, el('img', { alt: '', hidden: true }), el('div', { class: 'off-tag' }, el('b'), el('span')));
    tile.prepend(box);
    tile.classList.add('is-offline');
  }
  $('b', box).textContent = t(tile.dataset.stopped ? 'tile.stopped' : asleep ? 'tile.asleep' : 'tile.offline');
  if (tile.dataset.offFrame) return; // l'immagine si carica una volta per episodio
  tile.dataset.offFrame = '1';
  try {
    const r = await fetch(`/api/cameras/${tile.dataset.id}/lastframe`, { cache: 'no-cache' });
    if (!r.ok) throw new Error('nessuna immagine');
    const img = $('img', box);
    img.src = URL.createObjectURL(await r.blob());
    img.hidden = false;
    const taken = Number(r.headers.get('X-Taken'));
    $('span', box).textContent = taken ? t('tile.lastImage', { d: fmtDate(taken, { dateStyle: 'short', timeStyle: 'short' }) }) : '';
  } catch {
    $('span', box).textContent = t('tile.noImage');
  }
}

setInterval(() => {
  if (document.hidden) return; // in secondo piano i flussi sono fermi di proposito: nessun riquadro offline
  const now = Date.now();
  for (const tile of grid.children) {
    const live = tile.classList.contains('live');
    if (live) {
      tile._offSince = null;
      if (!tile._lastUp || now - tile._lastUp > 60_000) { tile._lastUp = now; captureFrame(tile); }
    } else if (!tile._offSince) tile._offSince = now;
    const paused = !!tile.dataset.paused;
    const off = !live && !tile.dataset.private && !tile.dataset.authFailed && (paused || now - tile._offSince > OFFLINE_AFTER_MS);
    setOffline(tile, off, paused);
  }
}, 3000);

// ---------- modalità privacy (occhio barrato) ----------
function renderPrivacy(tile) {
  const cam = camById(tile.dataset.id);
  const p = cam?.privacy;
  const btn = $('.priv-btn', tile);
  const canControl = (cam?.level ?? 0) >= 2;
  btn.hidden = !p?.supported;
  btn.innerHTML = p?.on ? EYE_OFF : EYE;
  btn.title = t(p?.on ? 'priv.turnOff' : 'priv.turnOn');
  btn.classList.toggle('on', !!p?.on);
  btn.classList.toggle('readonly', !canControl); // chi può solo guardare vede lo stato ma non lo cambia
  const cover = $('.priv-cover', tile);
  cover.hidden = !p?.on;
  $('.priv-text', cover).textContent = t('priv.cover');
  $('.priv-off', cover).textContent = t('priv.disable');
  $('.priv-off', cover).hidden = !canControl;
  tile.classList.toggle('private', !!p?.on);
  if (p?.on) {
    // Con la privacy attiva la telecamera non trasmette: si chiude il flusso invece di farlo ritentare.
    tile.dataset.private = '1';
    tile.querySelector('cam-stream')?.remove();
    tile.classList.remove('live');
  } else if (tile.dataset.private) {
    delete tile.dataset.private;
    delete tile.dataset.authFailed;
    if (!tile.dataset.paused) setTimeout(() => !tile.dataset.private && tile.isConnected && mountStream(tile, wantedQuality(tile)), 2000);
  }
}

async function setPrivacy(tile) {
  const cam = camById(tile.dataset.id);
  if (!cam?.privacy?.supported || cam.level < 2 || tile.dataset.busy) return;
  tile.dataset.busy = '1';
  const btn = $('.priv-btn', tile);
  btn.disabled = true;
  try {
    cam.privacy = await api('POST', `/api/cameras/${cam.id}/privacy`, { enable: !cam.privacy.on });
    renderPrivacy(tile);
  } catch (err) {
    toast(`${cam.name}: ${errorText(err)}`, { kind: 'err' });
  } finally {
    delete tile.dataset.busy;
    btn.disabled = false;
  }
}

// Cambio di stato dalla telecamera stessa, dall'app Reolink o da Home Assistant.
document.addEventListener('campriv', (e) => {
  const { camId, supported, on } = e.detail;
  const cam = camById(camId);
  if (!cam) return;
  cam.privacy = { supported, on };
  const tile = tileOf(camId);
  if (tile) renderPrivacy(tile);
});

// ---------- riordino ----------
async function moveCamera(id, toIndex) {
  const from = indexOf(id);
  toIndex = Math.max(0, Math.min(state.cameras.length - 1, toIndex));
  if (from < 0 || toIndex === from) return;
  const tile = grid.children[from];
  const ref = grid.children[toIndex + (toIndex > from ? 1 : 0)] || null;
  state.cameras.splice(toIndex, 0, state.cameras.splice(from, 1)[0]);
  // moveBefore sposta il riquadro senza interrompere il video (dove supportato).
  if (grid.moveBefore) grid.moveBefore(tile, ref);
  else grid.insertBefore(tile, ref);
  syncQuality();
  const ids = state.cameras.map((c) => c.id);
  // L'amministratore decide l'ordine di tutti; per gli altri utenti l'ordine è solo il loro, salvato su questo dispositivo.
  if (isAdmin()) await api('PUT', '/api/cameras/order', { ids });
  else { try { localStorage.setItem(`order:${state.me.id}`, JSON.stringify(ids)); } catch { /* facoltativo */ } }
}

function applyLocalOrder() {
  let saved = [];
  try { saved = JSON.parse(localStorage.getItem(`order:${state.me.id}`) || '[]'); } catch { /* ordine non valido */ }
  const rank = (c) => (saved.indexOf(c.id) < 0 ? Infinity : saved.indexOf(c.id));
  state.cameras.sort((a, b) => rank(a) - rank(b));
}

// ---------- riquadro ----------
function makeTile(cam) {
  const tile = el('div', { class: 'tile', dataset: { id: cam.id } });
  tile.innerHTML = `
    <div class="wait">${t('tile.connecting')}</div>
    <div class="cover" hidden><button class="wake-btn"></button><div class="cover-note"></div></div>
    <div class="priv-cover" hidden>${EYE_OFF}<div class="priv-text"></div><button class="priv-off"></button></div>
    <div class="flash"></div>
    <div class="ha-icons" hidden></div>
    <button class="ev-btn" data-act="events" data-i18n-title="tile.events"></button>
    <div class="bar">
      <span class="dot"></span><button class="priv-btn" hidden></button><span class="name"></span><span class="batt" hidden></span><span class="mode"></span><span class="bat-note"></span>
      <div class="tools">
        <button data-act="prev" data-i18n-title="tile.prev">◀</button>
        <button data-act="next" data-i18n-title="tile.next">▶</button>
        <button data-act="primary" data-i18n-title="tile.primary">★</button>
        <button data-act="mute" data-i18n-title="tile.audio">🔇</button>
        <button data-act="focus" data-i18n-title="tile.focus">⤢</button>
        <button data-act="stop" data-i18n-title="tile.stop">⏹</button>
        ${document.pictureInPictureEnabled ? '<button data-act="pip" data-i18n-title="tile.pip">⧉</button>' : ''}
        ${cam.battery ? '<button data-act="pause" data-i18n-title="tile.pause">⏸</button>' : ''}
        ${['reolink', 'eufyp2p'].includes(cam.brand) && cam.level >= 2 ? '<button data-act="options" data-i18n-title="tile.options">⚙</button>' : ''}
        ${isAdmin() ? '<button data-act="edit" data-i18n-title="tile.edit">✎</button>' : ''}
      </div>
    </div>`;
  $('.ev-btn', tile).innerHTML = svgIcon('history', 18);
  $('.ev-btn', tile).addEventListener('click', (e) => { e.stopPropagation(); openEventsFor(cam.id); });
  $('.ev-btn', tile).addEventListener('dblclick', (e) => e.stopPropagation());
  $('.name', tile).textContent = cam.name;
  applyI18n(tile);
  if (cam.battery) { tile.dataset.paused = '1'; tile.classList.add('battery'); }
  renderCover(tile);
  renderPrivacy(tile);
  renderBattery(tile);
  mountHa(tile, cam);
  const togglePrivacy = (e) => { e.stopPropagation(); setPrivacy(tile); };
  $('.priv-btn', tile).addEventListener('click', togglePrivacy);
  $('.priv-off', tile).addEventListener('click', togglePrivacy);
  $('.priv-btn', tile).addEventListener('dblclick', (e) => e.stopPropagation());
  $('.priv-cover', tile).addEventListener('dblclick', (e) => e.stopPropagation());
  $('.wake-btn', tile).addEventListener('click', (e) => { e.stopPropagation(); if (tile.dataset.stopped) resumeTile(tile); else startBattery(tile); });
  $('.cover', tile).addEventListener('dblclick', (e) => e.stopPropagation());

  tile.addEventListener('click', () => setSelected(cam.id));
  tile.addEventListener('dblclick', () => setFocus(state.focusedId === cam.id ? null : cam.id));
  $('.tools', tile).addEventListener('dblclick', (e) => e.stopPropagation());
  $('.tools', tile).addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    e.stopPropagation(); // i pulsanti non cambiano la selezione
    const act = btn.dataset.act;
    const cur = camById(cam.id);
    if (act === 'focus') setFocus(state.focusedId === cam.id ? null : cam.id);
    if (act === 'edit') openDialog(cur);
    if (act === 'options') openPanel(cur);
    if (act === 'pause') pauseTile(tile);
    if (act === 'pip') pipTile(tile);
    if (act === 'stop') { if (tile.dataset.stopped) resumeTile(tile); else stopTile(tile); }
    if (act === 'events') openEventsFor(cam.id);
    if (act === 'prev') moveCamera(cam.id, indexOf(cam.id) - 1);
    if (act === 'next') moveCamera(cam.id, indexOf(cam.id) + 1);
    if (act === 'primary') moveCamera(cam.id, 0);
    if (act === 'mute') {
      tile.dataset.muted = tile.dataset.muted === '1' ? '' : '1';
      const video = tile.querySelector('video');
      if (video && cam.id === state.selectedId) video.muted = tile.dataset.muted === '1';
      btn.textContent = tile.dataset.muted === '1' ? '🔇' : '🔊';
    }
  });
  // Trascinamento per riordinare.
  tile.draggable = true;
  tile.addEventListener('dragstart', (e) => {
    dragId = cam.id;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', cam.id);
    tile.classList.add('dragging');
  });
  tile.addEventListener('dragend', () => {
    dragId = null;
    for (const x of grid.children) x.classList.remove('dragging', 'drop');
  });
  tile.addEventListener('dragover', (e) => {
    if (!dragId || dragId === cam.id) return;
    e.preventDefault();
    tile.classList.add('drop');
  });
  tile.addEventListener('dragleave', () => tile.classList.remove('drop'));
  tile.addEventListener('drop', (e) => {
    e.preventDefault();
    tile.classList.remove('drop');
    if (dragId) moveCamera(dragId, indexOf(cam.id));
  });
  return tile;
}

// ---------- vista ----------
const LAYOUTS = [
  ['view.grid', [['auto', 'view.auto'], ['1', 'view.col1'], ['2', 2], ['3', 3], ['4', 4], ['5', 5]]],
  ['view.primary', [['1+5', 'view.1+5'], ['1+7', 'view.1+7'], ['center', 'view.center'], ['side', 'view.side'], ['bottom', 'view.bottom']]],
];

function buildLayoutSelect() {
  const sel = $('#layout');
  const value = sel.value || localStorage.getItem('layout') || 'auto';
  sel.replaceChildren();
  for (const [label, items] of LAYOUTS) {
    const group = el('optgroup', { label: t(label) });
    for (const [v, text] of items) group.append(new Option(typeof text === 'number' ? t('view.cols', { n: text }) : t(text), v));
    sel.append(group);
  }
  sel.value = value;
}

// Telefono (anche girato in orizzontale): nessuna scelta di disposizione; le telecamere stanno in fila, una dopo
// l'altra, in verticale se il telefono è in piedi e in orizzontale (a scorrimento laterale) se è girato.
const phone = matchMedia('(max-width: 700px), (pointer: coarse) and (max-height: 520px)');
const landscape = matchMedia('(orientation: landscape)');

function applyLayout() {
  if (phone.matches) {
    grid.dataset.layout = 'grid';
    grid.style.setProperty('--cols', 1);
    grid.style.setProperty('--rows', 1);
    grid.classList.add('scroll');
    grid.classList.toggle('hscroll', landscape.matches);
    grid.style.setProperty('--gh', `${Math.max(120, grid.clientHeight - 8)}px`); // altezza utile: ogni riquadro 16:9 a tutta altezza
    syncQuality();
    return;
  }
  grid.classList.remove('hscroll');
  const choice = $('#layout').value;
  const n = Math.max(state.cameras.length, 1);
  const others = Math.max(n - 1, 1);
  const fixed = {
    '1+5': { cols: 3, rows: 3 },
    '1+7': { cols: 4, rows: 4 },
    center: { cols: 4, rows: 4 },
    side: { cols: 2, rows: Math.max(others, 4) },
    bottom: { cols: Math.max(others, 4), rows: 2 },
  }[choice];
  const cols = fixed ? fixed.cols : choice === 'auto' ? Math.ceil(Math.sqrt(n)) : Number(choice);
  grid.dataset.layout = fixed ? choice : 'grid';
  grid.style.setProperty('--cols', cols);
  grid.style.setProperty('--rows', fixed ? fixed.rows : 1);
  // Con poche colonne e tante telecamere si scorre invece di schiacciare i riquadri.
  grid.classList.toggle('scroll', !fixed && choice !== 'auto' && Math.ceil(n / cols) > cols + 1);
  syncQuality();
}

function updateCount() {
  const n = state.cameras.length;
  $('#count').textContent = n === 0 ? '' : n === 1 ? t('count.1') : t('count', { n });
}

function render() {
  closePanel();
  state.focusedId = null;
  if (!state.selectedId) { try { state.selectedId = localStorage.getItem('selectedCam') || null; } catch { /* nessuna memoria */ } } // la principale scelta si ricorda anche dopo che l'app è stata ricaricata
  if (state.selectedId && !camById(state.selectedId)) state.selectedId = null;
  grid.classList.remove('has-focus');
  grid.replaceChildren(...state.cameras.map(makeTile));
  for (const tile of grid.children) tile.classList.toggle('selected', tile.dataset.id === state.selectedId);
  $('#empty').hidden = state.cameras.length > 0;
  updateCount();
  applyLayout();
}

async function reload() {
  state.cameras = await api('GET', '/api/cameras');
  if (!isAdmin()) applyLocalOrder();
  for (const c of state.cameras) if (c.status && c.battery) state.sleeping.set(c.id, c.status.sleeping);
  render();
}

// Riconnessione automatica: se un riquadro visibile non avanza per due controlli
// consecutivi (telecamera spenta, rete caduta, errore iniziale) il player viene ricreato.
setInterval(() => {
  if (document.hidden) return;
  for (const tile of grid.children) {
    if (!tile.offsetParent || tile.dataset.authFailed || tile.dataset.paused || tile.dataset.private) continue;
    const video = tile.querySelector('video');
    const t0 = video?.currentTime ?? 0;
    const fails = Number(tile.dataset.fails || 0);
    if (t0 !== Number(tile.dataset.lastTime)) {
      tile.dataset.lastTime = t0;
      tile.dataset.stuck = 0;
      tile.dataset.fails = 0;
    } else if (++tile.dataset.stuck >= 2 * 2 ** Math.min(fails, 4)) {
      // Attesa crescente (12 s … 3 min): troppi accessi falliti di fila fanno
      // scattare il blocco temporaneo dell'account su Reolink e altre marche.
      tile.dataset.stuck = 0;
      tile.dataset.fails = fails + 1;
      mountStream(tile, tile.dataset.quality);
    }
  }
}, 6000);

// ---------- modulo telecamera ----------
let eufyDevices = []; // ultimo rilevamento Eufy: [{ serial, ip, online, camName }]

function brandNote(brand) {
  return t(`note.${brand.id}`, null, brand.note);
}

function renderFields(brandId, params = {}) {
  const brand = state.brands.find((b) => b.id === brandId);
  $('#note').textContent = brandNote(brand);
  const box = $('#fields');
  box.replaceChildren();
  for (const f of brand.fields) {
    const label = document.createElement('label');
    label.textContent = t(`field.${f.key}`, null, f.label);
    let input;
    if (f.type === 'select') {
      input = document.createElement('select');
      for (const o of f.options) input.add(new Option(o.label, o.value));
    } else {
      input = document.createElement('input');
      input.type = f.type;
      if (f.placeholder) input.placeholder = f.key === 'host' && brandId === 'eufyp2p' ? t('ph.hostAuto') : f.placeholder;
      if (f.min !== undefined) input.min = f.min;
      if (f.max !== undefined) input.max = f.max;
      if (f.type === 'password') {
        input.autocomplete = 'new-password';
        if (editing?.hasPassword) input.placeholder = t('dlg.passwordSame');
      }
    }
    input.name = `p_${f.key}`;
    input.required = !!f.required;
    const value = params[f.key] ?? (editing ? '' : f.default) ?? '';
    if (value !== '') input.value = value;
    label.append(input);
    box.append(label);
  }
  channelLoader = null;
  if (brandId === 'eufyp2p') eufyHelpers(box);
  if (brandId === 'reolink') reolinkChannelHelpers(params);
}

// Reolink: elenco a tendina dei canali dell'hub/NVR, con il nome della telecamera accanto ai canali già in uso o che
// l'hub conosce ma non sono ancora nell'app. Si legge dall'hub con utente e password del modulo oppure, se l'hub è già
// usato da altre telecamere, con le loro credenziali (restano sul server).
let channelLoader = null; // (canale da selezionare) => Promise: attivo solo con la marca Reolink
function reolinkChannelHelpers(params = {}) {
  const first = form.elements.p_channel;
  if (!first) return;
  let hubChannels = [];
  const status = el('p', { class: 'note' });
  const btn = el('button', { type: 'button', class: 'mini' }, t('ch.list'));
  first.closest('label').after(el('div', { class: 'ch-tools' }, btn, status));

  const knownHost = (host) => state.cameras.some((c) => c.brand === 'reolink' && c.params?.host === host);
  const toInput = () => { // torna al campo numerico (l'indirizzo è cambiato o l'elenco non è più valido)
    const cur = form.elements.p_channel;
    if (cur.tagName !== 'SELECT') return;
    const input = el('input', { type: 'number', name: 'p_channel', min: 1, max: 64, value: cur.value || 1 });
    cur.replaceWith(input);
    hubChannels = [];
  };
  const showList = (list, wanted) => {
    hubChannels = list;
    const cur = form.elements.p_channel;
    const value = String(wanted ?? cur.value ?? 1);
    const sel = el('select', { name: 'p_channel' });
    for (const c of list) {
      const text = c.usedBy ? `${c.channel} · ${c.usedBy} — ${t('ch.inUse')}`
        : c.name || c.uid ? `${c.channel} · ${c.name || '?'} — ${t('ch.notAdded')}${c.online ? '' : ` (${t('scan.offline')})`}`
          : `${c.channel} · ${t('ch.free')}`;
      const o = new Option(text, String(c.channel));
      o.disabled = !!c.usedBy && String(c.channel) !== value; // un canale ha una sola telecamera
      sel.add(o);
    }
    if (!list.some((c) => String(c.channel) === value)) sel.add(new Option(`${value} · ${t('ch.notOnHub')}`, value));
    sel.value = value;
    sel.addEventListener('change', () => { // una telecamera nota all'hub ma non ancora aggiunta dà il suo nome al modulo
      const c = hubChannels.find((x) => String(x.channel) === sel.value);
      if (c && !c.usedBy && c.name && !form.elements.name.value) form.elements.name.value = c.name;
    });
    cur.replaceWith(sel);
  };
  const load = async (wanted) => {
    const host = form.elements.p_host?.value.trim();
    if (!host) { status.className = 'note'; status.textContent = t('ch.needHost'); return; }
    btn.disabled = true;
    status.className = 'note';
    status.textContent = t('ch.loading');
    try {
      const r = await api('POST', '/api/reolink/channels', { host, username: form.elements.p_username?.value, password: form.elements.p_password?.value, excludeId: editing?.id });
      showList(r.channels, wanted);
      status.textContent = '';
    } catch (err) {
      status.className = 'note err';
      status.textContent = errorText(err);
    }
    btn.disabled = false;
  };
  channelLoader = load;
  btn.addEventListener('click', () => load());
  form.elements.p_host?.addEventListener('change', () => {
    toInput();
    if (knownHost(form.elements.p_host.value.trim())) load();
  });
  // Modifica di una telecamera, o hub già usato: l'elenco compare subito
  const host = form.elements.p_host?.value.trim() || params.host;
  if (host && (editing || knownHost(host))) load(params.channel);
}
// Eufy: ricerca in rete; l'IP si ricava dal numero di serie scelto.
function eufyHelpers(box) {
  const serial = form.elements.p_serial;
  const host = form.elements.p_host;
  serial.setAttribute('list', 'eufy-serials');
  const list = el('datalist', { id: 'eufy-serials' });
  const fill = () => {
    list.replaceChildren(...eufyDevices.map((d) => el('option', { value: d.serial }, d.ip || '')));
  };
  fill();
  const status = el('div', { class: 'note' });
  const btn = el('button', {
    type: 'button',
    onclick: async () => {
      btn.disabled = true;
      status.textContent = t('dlg.detecting');
      try {
        const r = await api('GET', '/api/eufy/discover');
        eufyDevices = r.devices;
        fill();
        applyDetected();
        status.textContent = r.devices.some((d) => d.online) ? '' : t('dlg.detectNone');
      } catch (err) {
        status.textContent = errorText(err);
      }
      btn.disabled = false;
    },
  }, t('dlg.detect'));
  const applyDetected = () => {
    const d = eufyDevices.find((x) => x.serial === serial.value.trim());
    if (d?.ip && !host.value) host.value = d.ip;
    // Le SoloCam (T81…) sono a batteria: parte solo con Sveglia / Play.
    if (/^T81/.test(serial.value.trim()) && !editing) form.elements.battery.checked = true;
  };
  serial.addEventListener('change', applyDetected);
  box.append(list, btn, status);
  if (!eufyDevices.length) api('GET', '/api/eufy/discover?scan=0').then((r) => { eufyDevices = r.devices; fill(); }).catch(() => {});
}

function openDialog(cam = null, preset = null) {
  editing = cam;
  form.reset();
  $('#error').hidden = true;
  $('#dlg-title').textContent = t(cam ? 'dlg.edit' : 'dlg.new');
  $('#btn-delete').hidden = !cam;
  form.elements.brand.disabled = !!cam;
  const brand = cam ? cam.brand : preset?.brand || state.brands[0].id;
  form.elements.brand.value = brand;
  form.elements.name.value = cam ? cam.name : preset?.name || '';
  form.elements.preload.checked = cam ? cam.preload : brand !== 'eufyp2p';
  form.elements.battery.checked = cam ? cam.battery : !!preset?.battery;
  form.elements.wakeLimit.value = cam?.wakeLimit ?? '';
  form.elements.wakeLimit.placeholder = String(state.settings?.wakeLimit ?? 60);
  form.elements.alerts.checked = cam ? cam.alerts : true;
  form.elements.saveEvents.checked = cam ? cam.saveEvents : true;
  renderFields(brand, cam?.params || preset?.params);
  fillHaRows(cam?.ha || []);
  $('#scan-box').hidden = !!cam; // la ricerca serve per aggiungere telecamere nuove, non per modificarne una
  resetScan();
  dlg.showModal();
}

// ---------- ricerca automatica di telecamere nella rete ----------
// L'avviso sugli hub serve solo per le Reolink.
const updateScanHint = () => { const h = document.querySelector('.scan-hint'); if (h) h.hidden = form.elements.brand.value !== 'reolink'; };
let scanId = null;
let scanTimer = null;
function stopScan() {
  clearInterval(scanTimer);
  scanTimer = null;
  if (scanId) api('DELETE', `/api/discovery/${scanId}`).catch(() => {});
  scanId = null;
}
function resetScan() {
  stopScan();
  delete form.dataset.copyFrom;
  $('#scan-progress').hidden = true;
  $('#scan-status').hidden = true;
  $('#scan-results').replaceChildren();
  $('#btn-scan').disabled = false;
}

/** Compila il modulo con una telecamera trovata (marca, indirizzo, nome; per le Eufy anche il numero di serie). */
let scanFilling = false;
function useFound(d) {
  delete form.dataset.copyFrom; // la copia delle credenziali vale solo per il canale scelto adesso
  scanFilling = true; // il cambio di marca fatto da qui non deve scartare la copia delle credenziali
  const brand = state.brands.some((b) => b.id === d.brand) ? d.brand : 'custom';
  form.elements.brand.value = brand;
  form.elements.brand.dispatchEvent(new Event('change'));
  scanFilling = false;
  if (!form.elements.name.value) form.elements.name.value = d.name || d.detail || d.host;
  const set = (key, value) => { const input = form.elements[`p_${key}`]; if (input && value) input.value = value; };
  if (brand === 'custom') set('mainUrl', `rtsp://${d.host}:${d.rtspPort || 554}/`);
  else set('host', d.host);
  if (brand === 'eufyp2p') { set('serial', d.serial); form.elements.battery.checked = !!d.battery; }
  if (d.hub) { // canale di un hub Reolink: stesso utente e password delle telecamere già aggiunte sull'hub (restano sul server)
    set('channel', d.channel);
    set('username', d.username);
    channelLoader?.(d.channel); // la tendina dei canali dell'hub, con questo già selezionato
    const pass = form.elements.p_password;
    if (d.copyFrom && pass) { form.dataset.copyFrom = d.copyFrom; pass.placeholder = t('scan.samePassword'); }
  }
  const next = [...form.querySelectorAll('#fields input')].find((i) => i.required && !i.value) || form.querySelector('#fields input');
  next?.focus();
}

function showFound(list) {
  const box = $('#scan-results');
  box.replaceChildren(...list.map((d) => el('div', { class: 'scan-row' },
    el('div', {},
      el('b', {}, d.hub ? t('scan.hubRow', { host: d.host, n: d.channel }) : d.host),
      el('span', { class: 'note' }, ` ${d.hub && d.name ? `${d.name} · ` : ''}${t(`brand.${d.brand}`, null, d.brand)}${d.detail ? ` · ${d.detail}` : ''}${d.hub && !d.online ? ` · ${t('scan.offline')}` : ''}`)),
    el('button', { type: 'button', class: 'primary', onclick: () => useFound(d) }, t('scan.use')))));
}

async function startScan() {
  resetScan();
  const btn = $('#btn-scan');
  const bar = $('#scan-bar');
  const pct = $('#scan-pct');
  const status = $('#scan-status');
  btn.disabled = true;
  $('#scan-progress').hidden = false;
  bar.value = 0;
  pct.textContent = t('scan.phase.broadcast');
  const finish = (text, bad = false) => {
    stopScan();
    $('#scan-progress').hidden = true;
    btn.disabled = false;
    status.hidden = false;
    status.className = bad ? 'note err' : 'note';
    status.textContent = text;
  };
  try {
    // Hub Reolink non ancora aggiunto: se nel modulo ci sono indirizzo e password, la ricerca elenca anche i suoi canali.
    const typed = form.elements.brand.value === 'reolink' && form.elements.p_host?.value && form.elements.p_password?.value
      ? { reolink: { host: form.elements.p_host.value.trim(), username: form.elements.p_username?.value || 'admin', password: form.elements.p_password.value } } : {};
    scanId = (await api('POST', '/api/discovery', typed)).id;
  } catch (err) { finish(errorText(err), true); return; }
  const id = scanId;
  scanTimer = setInterval(async () => {
    try {
      const s = await api('GET', `/api/discovery/${id}`);
      if (id !== scanId) return;
      bar.value = s.progress;
      pct.textContent = `${t(`scan.phase.${s.phase}`)} · ${s.progress} %`;
      showFound(s.found);
      if (s.done) {
        scanId = null; // già terminata: niente annullamento
        if (s.error) finish(s.error === 'no_network' ? t('scan.noNetwork') : s.error, true);
        else finish(s.found.length ? t('scan.found', { n: s.found.length }) : t('scan.none'));
      }
    } catch (err) { finish(errorText(err), true); }
  }, 500);
}
$('#btn-scan').addEventListener('click', startScan);
$('#btn-scan-stop').addEventListener('click', () => { const n = $('#scan-results').children.length; stopScan(); $('#scan-progress').hidden = true; $('#btn-scan').disabled = false; const s = $('#scan-status'); s.hidden = false; s.className = 'note'; s.textContent = t('scan.stopped', { n }); });
dlg.addEventListener('close', stopScan);

form.elements.brand.addEventListener('change', () => {
  const brand = form.elements.brand.value;
  updateScanHint();
  if (!scanFilling) delete form.dataset.copyFrom;
  renderFields(brand);
  // Le Eufy locali sono spesso a batteria: niente connessione permanente in automatico.
  form.elements.preload.checked = brand !== 'eufyp2p';
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const params = {};
  for (const input of form.elements) if (input.name?.startsWith('p_')) params[input.name.slice(2)] = input.value;
  const body = {
    name: form.elements.name.value,
    brand: form.elements.brand.value,
    preload: form.elements.preload.checked,
    battery: form.elements.battery.checked,
    wakeLimit: form.elements.wakeLimit.value,
    alerts: form.elements.alerts.checked,
    saveEvents: form.elements.saveEvents.checked,
    params,
  };
  if (!editing && form.dataset.copyFrom && !params.password) body.copyCredentialsFrom = form.dataset.copyFrom;
  $('#btn-save').disabled = true;
  try {
    const saved = editing ? await api('PUT', `/api/cameras/${editing.id}`, body) : await api('POST', '/api/cameras', body);
    // Le icone Home Assistant si salvano a parte, solo se sono cambiate (non serve riavviare i flussi).
    const items = readHaRows();
    const before = (editing?.ha || []).map(({ entity, label, icon }) => ({ entity, label, icon }));
    if (JSON.stringify(items) !== JSON.stringify(before)) await api('PUT', `/api/cameras/${saved.id}/ha`, { items });
    dlg.close();
    await reload();
  } catch (err) {
    $('#error').textContent = errorText(err);
    $('#error').hidden = false;
  } finally {
    $('#btn-save').disabled = false;
  }
});

$('#btn-delete').addEventListener('click', async () => {
  if (!editing || !confirm(t('dlg.deleteConfirm', { name: editing.name }))) return;
  await api('DELETE', `/api/cameras/${editing.id}`);
  dlg.close();
  await reload();
});
$('#btn-cancel').addEventListener('click', () => dlg.close());
$('#btn-add').addEventListener('click', () => openDialog());
$('#btn-stopall').addEventListener('click', () => {
  const stop = $('#btn-stopall').dataset.state !== 'start';
  for (const tile of grid.children) {
    if (tile.dataset.private) continue;
    if (stop && !tile.dataset.stopped && !tile.dataset.paused) stopTile(tile);
    else if (!stop && tile.dataset.stopped) resumeTile(tile);
  }
  syncStopAll();
});
setInterval(syncStopAll, 2000);
$('#btn-add-empty').addEventListener('click', () => openDialog());

function fillBrandSelect() {
  const keep = form.elements.brand.value;
  form.elements.brand.replaceChildren(...state.brands.map((b) => new Option(t(`brand.${b.id}`, null, b.label), b.id)));
  if (keep) form.elements.brand.value = keep;
}

// ---------- barra ----------
$('#layout').addEventListener('change', () => {
  localStorage.setItem('layout', $('#layout').value);
  applyLayout();
});
if (document.documentElement.requestFullscreen) $('#btn-full').addEventListener('click', () => document.documentElement.requestFullscreen());
else $('#btn-full').hidden = true; // iPhone: il browser non offre lo schermo intero
phone.addEventListener('change', applyLayout);
landscape.addEventListener('change', applyLayout);
window.addEventListener('resize', () => { if (phone.matches && landscape.matches) applyLayout(); });
window.addEventListener('orientationchange', () => setTimeout(applyLayout, 300));
document.addEventListener('fullscreenchange', () => document.body.classList.toggle('kiosk', !!document.fullscreenElement));
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || document.querySelector('dialog[open]')) return;
  if (panelCam()) closePanel();
  else if (state.focusedId) setFocus(null);
  else setSelected(null);
});

// Cambio lingua: aggiorna i testi senza riaprire i flussi video.
document.addEventListener('langchange', () => {
  buildLayoutSelect();
  fillBrandSelect();
  updateCount();
  $$('.tile', grid).forEach((tile) => { renderCover(tile); renderPrivacy(tile); $('.wait', tile).textContent = t('tile.connecting'); });
});

// Servizi per gli altri moduli.
export const app = { reload, openDialog, setFocus, setSelected, mountStream, tileOf, startBattery };

// ---------- utente: menu, cambio password, uscita ----------
const pwdlg = $('#pwdlg');
const pwform = $('#pwform');

/** Apre la finestra di cambio password. Con `forced` non si può annullare. Risolve a true se la password è cambiata. */
function openPasswordDialog({ forced = false } = {}) {
  return new Promise((resolve) => {
    const errorBox = $('#pw-error');
    pwform.reset();
    errorBox.hidden = true;
    $('#pw-must').hidden = !forced;
    $('#pw-cancel').hidden = forced;
    const block = (e) => { if (forced) e.preventDefault(); };
    pwdlg.addEventListener('cancel', block);
    pwform.onsubmit = async (e) => {
      e.preventDefault();
      const f = pwform.elements;
      if (f.next.value !== f.again.value) { errorBox.textContent = t('pw.mismatch'); errorBox.hidden = false; return; }
      try {
        await api('POST', '/api/auth/password', { current: f.current.value, next: f.next.value });
        state.me.mustChange = false;
        pwdlg.removeEventListener('cancel', block);
        pwdlg.close();
        toast(t('pw.done'));
        resolve(true);
      } catch (err) {
        errorBox.textContent = errorText(err);
        errorBox.hidden = false;
      }
    };
    $('#pw-cancel').onclick = () => { pwdlg.removeEventListener('cancel', block); pwdlg.close(); resolve(false); };
    pwdlg.showModal();
  });
}

function renderUser() {
  const name = state.me.displayName || state.me.username;
  $('#user-name').textContent = name;
  $('#um-name').textContent = name;
  $('#um-role').textContent = t(isAdmin() ? 'user.roleAdmin' : 'user.roleUser');
}

function setupUserMenu() {
  const menu = $('#user-menu');
  const btn = $('#btn-user');
  const close = () => { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
  btn.addEventListener('click', (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; btn.setAttribute('aria-expanded', String(!menu.hidden)); });
  document.addEventListener('click', (e) => { if (!menu.contains(e.target)) close(); });
  $('#um-password').addEventListener('click', () => { close(); openPasswordDialog(); });
  $('#um-logout').addEventListener('click', async () => {
    try { await api('POST', '/api/auth/logout'); } catch { /* si esce comunque */ }
    location.href = '/login.html';
  });
  renderUser();
  document.addEventListener('langchange', renderUser);
}

function updateEmptyText() {
  const text = $('#empty-text');
  if (isAdmin()) return;
  text.removeAttribute('data-i18n'); // per gli utenti il testo è diverso: si aggiorna a mano
  const set = () => { text.textContent = t('empty.user'); };
  set();
  document.addEventListener('langchange', set);
}

// ---------- avvio ----------
applyI18n();
state.me = (await api('GET', '/api/auth/me')).user;
document.body.dataset.role = state.me.role;
setupUserMenu();
if (state.me.mustChange) await openPasswordDialog({ forced: true });
state.settings = await api('GET', '/api/settings');
if (isAdmin()) state.brands = await api('GET', '/api/brands');
buildLayoutSelect();
fillBrandSelect();
updateEmptyText();
await reload();
initSettings(app);
initEvents(app);

// ---------- ritorno dall'app messa in secondo piano: i flussi riprendono e l'audio della telecamera scelta torna attivo ----------
function restoreAudio() {
  const tile = state.selectedId && tileOf(state.selectedId);
  const v = tile?.querySelector('cam-stream video');
  if (!v || tile.dataset.muted === '1') return;
  v.muted = false;
  const p = v.play();
  // Il browser può rifiutare l'audio finché non c'è un tocco: al primo tocco si riattiva.
  p?.catch(() => { v.muted = true; v.play().catch(() => {}); document.addEventListener('pointerdown', () => { v.muted = false; v.play().catch(() => {}); }, { once: true }); });
}
function resumeAll() {
  for (const tile of grid.children) {
    if (!tile.classList.contains('live') && !tile.dataset.paused && !tile.dataset.private && !tile.dataset.authFailed) mountStream(tile, tile.dataset.quality || wantedQuality(tile));
  }
  setTimeout(restoreAudio, 1500);
  setTimeout(restoreAudio, 5000);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) resumeAll(); });
window.addEventListener('pageshow', () => setTimeout(restoreAudio, 2000));
document.addEventListener('pointerdown', () => setTimeout(restoreAudio, 300), { once: true });

// ---------- finestra fluttuante (Picture-in-Picture): la telecamera scelta resta visibile e con audio anche con l'app ridotta a icona ----------
function videoOf(tile) { return tile?.querySelector('cam-stream video') || null; }

async function pipTile(tile) {
  const v = videoOf(tile);
  if (!v) return;
  try {
    if (document.pictureInPictureElement === v) await document.exitPictureInPicture();
    else { v.disablePictureInPicture = false; await v.requestPictureInPicture(); }
  } catch (err) { toast(errorText(err), { kind: 'err' }); }
}

// Chrome apre da solo la finestra fluttuante quando si lascia la scheda, se la pagina lo dichiara tra le azioni multimediali.
if ('mediaSession' in navigator) {
  try {
    navigator.mediaSession.setActionHandler('enterpictureinpicture', async () => {
      const v = videoOf(state.selectedId && tileOf(state.selectedId));
      if (v && document.pictureInPictureElement !== v) await v.requestPictureInPicture();
    });
  } catch { /* azione non supportata da questo browser */ }
}
function updateMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const cam = camById(state.selectedId);
  navigator.mediaSession.metadata = cam ? new MediaMetadata({ title: cam.name, artist: 'Argo' }) : null;
  navigator.mediaSession.playbackState = cam ? 'playing' : 'none';
}
setInterval(updateMediaSession, 5000);

// In secondo piano si tiene solo la telecamera scelta (e quella in finestra fluttuante): le altre non scaricano video.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) return;
  for (const tile of grid.children) {
    if (tile.dataset.id === state.selectedId || videoOf(tile) === document.pictureInPictureElement) continue;
    tile.querySelector('cam-stream')?.remove();
    tile.classList.remove('live');
  }
});