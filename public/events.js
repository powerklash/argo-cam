// Eventi in tempo reale (lampo rosso, notifiche, popup del campanello con microfono)
// e finestra di consultazione: ricerca intelligente, dettaglio, persone riconosciute.
import { t, fmtDate, getLang } from './i18n.js';
import { state, $, $$, api, el, toast, camById, pref, errorText, isAdmin } from './state.js';
import './player.js';

let app = null;

// ---------- collegamento agli eventi del server ----------
function connect() {
  const es = new EventSource('/api/events/stream');
  es.addEventListener('detect', (e) => onDetect(JSON.parse(e.data)));
  es.addEventListener('visitor', (e) => onVisitor(JSON.parse(e.data)));
  es.addEventListener('status', (e) => document.dispatchEvent(new CustomEvent('camstatus', { detail: JSON.parse(e.data) })));
  es.addEventListener('privacy', (e) => document.dispatchEvent(new CustomEvent('campriv', { detail: JSON.parse(e.data) })));
  es.addEventListener('event', (e) => { const ev = JSON.parse(e.data); onStored(ev); popupEvent(ev); });
  es.addEventListener('event-update', () => onStored(null));
}

// ---------- lampo rosso (2 secondi in totale, con dissolvenza) ----------
function flashTile(camId) {
  const tile = app.tileOf(camId);
  const layer = tile && $('.flash', tile);
  if (!layer) return;
  layer.classList.remove('go');
  void layer.offsetWidth; // riavvia l'animazione se ne è già in corso una
  layer.classList.add('go');
}

// ---------- allarme incendio / allagamento: banner rosso fisso, sirena e notifica finché non si chiude ----------
let sirenTimer = null;
function siren() {
  try {
    const ctx = new AudioContext();
    const speaker = pref.get('speaker');
    if (speaker && ctx.setSinkId) ctx.setSinkId(speaker).catch(() => {});
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    gain.gain.value = 0.12;
    for (let i = 0; i < 4; i++) { osc.frequency.setValueAtTime(i % 2 ? 660 : 960, ctx.currentTime + i * 0.35); }
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 1.4);
    setTimeout(() => ctx.close(), 1800);
  } catch { /* audio non disponibile */ }
}

function showAlarm(d) {
  const key = `${d.camId}-${d.kind}`;
  let bar = $('#alarms');
  if (!bar) { bar = el('div', { id: 'alarms' }); document.body.append(bar); }
  const old = bar.querySelector(`[data-key="${key}"]`);
  if (old) old.remove();
  const stop = () => { node.remove(); if (!bar.children.length) { clearInterval(sirenTimer); sirenTimer = null; } };
  const node = el('div', { class: `alarm ${d.kind}`, dataset: { key } },
    el('b', {}, `${d.kind === 'fire' ? '🔥' : '💧'} ${t(`alarm.${d.kind}`)}`),
    el('span', {}, `${d.camName} · ${fmtDate(d.ts, { timeStyle: 'medium' })}${d.test ? ` · ${t('alarm.test')}` : ''}`),
    el('button', { type: 'button', class: 'primary', onclick: () => { stop(); openEvents(); } }, t('alarm.open')),
    el('button', { type: 'button', onclick: stop }, t('alarm.dismiss')));
  bar.append(node);
  siren();
  if (!sirenTimer) sirenTimer = setInterval(siren, 4000);
  setTimeout(() => { if (sirenTimer) { clearInterval(sirenTimer); sirenTimer = null; } }, 60000); // la sirena tace dopo un minuto, il banner resta
  if ('Notification' in window && Notification.permission === 'granted') {
    const n = new Notification(`${t(`alarm.${d.kind}`)} — ${d.camName}`, { body: t('alarm.body'), tag: key, requireInteraction: true });
    n.onclick = () => window.focus();
  }
}

function onDetect(d) {
  if (d.kind === 'fire' || d.kind === 'flood') showAlarm(d);
  if (d.flash) flashTile(d.camId);
  // Evento su una telecamera a batteria: si sveglia e parte il video (altrimenti resterebbe in pausa con "Sveglia/Play").
  if (!d.test && pref.get('wakeOnEvent') !== '0') {
    const cam = camById(d.camId);
    const tile = app.tileOf(d.camId);
    if (cam?.battery && tile?.dataset.paused && !tile.dataset.waking) app.startBattery(tile);
  }
}

// ---------- popup di un evento: nome della telecamera e immagine ----------
const POPUP_MS = 9000;

function popupEvent(ev) {
  if (pref.get('eventPopup') === '0' || ev.kind === 'visitor' || ev.meta?.test) return; // il campanello ha il suo popup
  const cam = camById(ev.camId);
  if (!cam || cam.alerts === false) return;
  let box = $('#popups');
  if (!box) { box = el('div', { id: 'popups' }); document.body.append(box); }
  while (box.children.length >= 3) box.firstChild.remove();
  const card = el('button', { type: 'button', class: 'popup' },
    ev.snapshot ? el('img', { src: `/media/${ev.snapshot}`, alt: '' }) : el('div', { class: 'noimg' }, '📷'),
    el('div', { class: 'ptxt' }, el('b', {}, ev.camName || cam.name), el('span', {}, t(`kind.${ev.kind}`)), el('small', {}, fmtDate(ev.ts, { timeStyle: 'medium' }))));
  const close = () => card.remove();
  card.addEventListener('click', () => { close(); focusEventId = ev.id; openEvents(); });
  box.append(card);
  setTimeout(close, POPUP_MS);
}

// ---------- campanello ----------
function chime() {
  try {
    const ctx = new AudioContext();
    const speaker = pref.get('speaker');
    if (speaker && ctx.setSinkId) ctx.setSinkId(speaker).catch(() => {});
    [[880, 0], [660, 0.28]].forEach(([freq, at]) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + at);
      gain.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + at + 0.25);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + at);
      osc.stop(ctx.currentTime + at + 0.3);
    });
    setTimeout(() => ctx.close(), 1000);
  } catch { /* audio non disponibile */ }
}

function onVisitor(d) {
  const s = state.settings.doorbell;
  if (!d.notify) return;
  if (s.chime) chime();
  if (s.notify) {
    const text = t('toast.visitor', { cam: d.camName });
    toast(`🔔 ${text}`, { kind: 'bell', ms: 12000 });
    if ('Notification' in window && Notification.permission === 'granted') {
      const n = new Notification('Argo', { body: text, tag: `bell-${d.camId}`, silent: true });
      n.onclick = () => window.focus();
    }
  }
  if (s.popup) openBell(d.camId);
}

async function micOptions(select) {
  select.replaceChildren(new Option(t('set.defaultDevice'), ''));
  try {
    const list = (await navigator.mediaDevices.enumerateDevices()).filter((x) => x.kind === 'audioinput');
    list.forEach((x, i) => select.add(new Option(x.label || `🎤 ${i + 1}`, x.deviceId)));
  } catch { /* nessun elenco */ }
  select.value = [...select.options].some((o) => o.value === pref.get('mic')) ? pref.get('mic') : '';
}

let bellTimer = null;
function openBell(camId) {
  const dlg = $('#bell');
  const cam = camById(camId);
  if (!cam || dlg.open) return;
  $('#bell-title').textContent = t('bell.title', { cam: cam.name });
  const note = $('#bell-note');
  note.textContent = '';
  const talkBtn = $('#bell-talk');
  const hands = $('#bell-hands');
  const mic = $('#bell-mic');
  hands.checked = false;
  talkBtn.textContent = t('bell.talk');
  talkBtn.classList.remove('on');
  // Parlare richiede il controllo della telecamera (e HTTPS per il microfono); altrimenti si guarda e si ascolta soltanto.
  const canTalk = cam.level >= 2;
  talkBtn.hidden = !canTalk;
  hands.closest('label').hidden = !canTalk;
  mic.closest('label').hidden = !canTalk;
  if (!canTalk) note.textContent = t('bell.viewOnly');
  else if (!window.isSecureContext) note.textContent = t('bell.insecure');

  let stream = null;
  let talking = false;

  const resetClose = () => {
    clearTimeout(bellTimer);
    const secs = state.settings.doorbell.autoCloseSeconds;
    if (secs > 0 && !talking && !hands.checked) bellTimer = setTimeout(() => dlg.close(), secs * 1000);
  };
  const setTalking = (on) => {
    talking = on;
    stream?.setTalking?.(on);
    talkBtn.classList.toggle('on', on);
    talkBtn.textContent = on ? t('bell.talking') : t('bell.talk');
    resetClose();
  };

  // Apre (o riapre, dopo un cambio di microfono) il flusso con video, audio e microfono.
  const mount = () => {
    stream?.remove();
    stream = document.createElement(canTalk ? 'talk-stream' : 'cam-stream');
    if (!canTalk) stream.media = 'video,audio';
    stream.addEventListener('micerror', () => { note.textContent = t('bell.micError'); });
    // L'audio del visitatore parte con un clic se il browser lo blocca.
    stream.addEventListener('click', () => { stream.video.muted = false; stream.video.play().catch(() => {}); if (canTalk) note.textContent = ''; });
    $('#bell-video').replaceChildren(stream);
    stream.src = `/go2rtc/api/ws?src=${encodeURIComponent(`${camId}_${canTalk ? 'talk' : 'main_a'}`)}`;
    if (hands.checked) setTimeout(() => stream?.setTalking?.(true), 1500);
  };
  mount();
  setTimeout(() => { if (dlg.open && stream?.video && !stream.video.paused && stream.video.muted) note.textContent = t('bell.unmute'); }, 3000);

  // Parla: tenendo premuto, oppure a mani libere.
  talkBtn.onpointerdown = (e) => { talkBtn.setPointerCapture(e.pointerId); if (!hands.checked) setTalking(true); };
  const release = () => { if (!hands.checked && talking) setTalking(false); };
  talkBtn.onpointerup = release;
  talkBtn.onpointercancel = release;
  talkBtn.onlostpointercapture = release;
  hands.onchange = () => setTalking(hands.checked);

  micOptions(mic);
  mic.onchange = () => { pref.set('mic', mic.value); mount(); };

  resetClose();
  dlg.addEventListener('close', () => {
    clearTimeout(bellTimer);
    stream?.remove(); // chiude il flusso e spegne il microfono
    $('#bell-video').replaceChildren();
  }, { once: true });
  dlg.showModal();
}

// ---------- consultazione eventi ----------
const KIND_ORDER = ['person', 'vehicle', 'pet', 'face', 'package', 'motion', 'visitor', 'fire', 'flood'];
const ANIMAL_SPECIES = new Set(['cat', 'dog', 'bird', 'horse', 'sheep', 'cow']);
const VEHICLE_SPECIES = new Set(['car', 'truck', 'bus', 'motorcycle', 'bicycle']);
const VEHICLE_ICON = { car: '🚗', truck: '🚚', bus: '🚌', motorcycle: '🏍️', bicycle: '🚲' };
/** Gruppo (scheda) di una persona riconosciuta: persone, animali o veicoli. */
const groupOf = (p) => (!p.species ? 'people' : VEHICLE_SPECIES.has(p.species) ? 'vehicles' : 'pets');
let results = [];
let tab = 'events';
let personFilter = null;
let live = null; // aggiornamento della lista all'arrivo di un nuovo evento

function chipText(c) {
  switch (c.k) {
    case 'date': return new Date(`${c.v}T00:00:00`).toLocaleDateString(getLang(), { dateStyle: 'long' });
    case 'rel': return t(`rel.${c.v}`);
    case 'last': return c.v >= 24 && c.v % 24 === 0 ? t('last.days', { n: c.v / 24 }) : t('last.hours', { n: c.v });
    case 'period': return t(`period.${c.v}`);
    case 'hours': return t('hours.range', { a: c.v[0], b: c.v[1] });
    case 'plate': return `${t('chip.plate')} ${c.v}`;
    case 'kind': return t(`kind.${c.v}`);
    case 'vtype': return t(`vtype.${c.v}`);
    case 'color': return t(`color.${c.v}`);
    default: return String(c.v); // cam, person
  }
}

const badge = (text, cls = '') => el('span', { class: `badge ${cls}` }, text);
const SPECIES_ICON = { cat: '🐈', dog: '🐕', bird: '🐦', horse: '🐴', sheep: '🐑', cow: '🐄' };
/** Chi è stato riconosciuto nell'evento: tutte le persone (👤), gli animali (🐾) e i veicoli (🚗) che compaiono. */
const subjectIcon = (s) => (!s.species ? '👤' : VEHICLE_SPECIES.has(s.species) ? (VEHICLE_ICON[s.species] || '🚗') : (SPECIES_ICON[s.species] || '🐾'));
const subjectLabel = (s) => s.name || `${t('people.unknown')} #${s.id}`;
const whoBadge = (e) => (e.subjects || []).map((s) => badge(`${subjectIcon(s)} ${subjectLabel(s)}`));

const SUBJECT_KINDS = new Set(['person', 'face', 'vehicle', 'pet']);

/**
 * Correzione di chi/cosa è stato riconosciuto nell'evento (solo amministratore). Un video può mostrare più persone,
 * animali o veicoli: ognuno si può cambiare (✎) o togliere (✕), e se ne può aggiungere un altro (＋).
 */
function subjectsEditor(e) {
  const box = el('div', { class: 'subj-edit' });
  const send = async (body) => {
    try {
      const upd = await api('POST', `/api/events/${e.id}/subject`, body);
      const i = results.findIndex((x) => x.id === e.id);
      if (i >= 0) results[i] = upd;
      renderResults();
      showDetail(upd);
    } catch (err) { toast(errorText(err), { kind: 'err' }); }
  };
  const persons = async () => { try { return await api('GET', '/api/persons'); } catch (err) { toast(errorText(err), { kind: 'err' }); return null; } };
  const inEvent = new Set((e.subjects || []).map((s) => s.id));
  for (const s of e.subjects || []) {
    const change = el('button', { type: 'button', class: 'mini', title: t('ev.who') }, '✎');
    change.onclick = async () => {
      change.disabled = true;
      const all = await persons();
      if (!all) { change.disabled = false; return; }
      const sel = el('select', { class: 'mini' }, new Option(t('ev.whoPick'), ''));
      for (const p of all.filter((x) => groupOf(x) === groupOf(s) && !inEvent.has(x.id))) sel.add(new Option(subjectLabel(p), p.id));
      sel.add(new Option(t('ev.whoNew'), 'new'));
      sel.onchange = () => { if (sel.value) send({ action: 'change', from: s.id, to: sel.value === 'new' ? 'new' : Number(sel.value) }); };
      change.replaceWith(sel);
      sel.focus();
    };
    const remove = el('button', {
      type: 'button', class: 'mini danger', title: t('people.sampleRemove'),
      onclick: () => { if (confirm(t('ev.whoNoneConfirm'))) send({ action: 'remove', from: s.id }); },
    }, '✕');
    box.append(el('span', { class: 'subj-row' }, el('span', { class: 'badge' }, `${subjectIcon(s)} ${subjectLabel(s)}`), change, remove));
  }
  if (SUBJECT_KINDS.has(e.kind) || (e.subjects || []).length) {
    const add = el('button', { type: 'button', class: 'mini' }, `＋ ${t('ev.whoAdd')}`);
    add.onclick = async () => {
      add.disabled = true;
      const all = await persons();
      if (!all) { add.disabled = false; return; }
      const sel = el('select', { class: 'mini' }, new Option(t('ev.whoPick'), ''));
      for (const [g, label] of [['people', 'ev.tabPeople'], ['pets', 'ev.tabPets'], ['vehicles', 'ev.tabVehicles']]) {
        const group = el('optgroup', { label: t(label) });
        for (const p of all.filter((x) => groupOf(x) === g && !inEvent.has(x.id))) group.append(new Option(subjectLabel(p), `${g}:${p.id}`));
        group.append(new Option({ people: t('ev.whoNewPerson'), pets: t('ev.whoNewPet'), vehicles: t('ev.whoNewVehicle') }[g], `${g}:new`));
        sel.append(group);
      }
      sel.onchange = () => {
        if (!sel.value) return;
        const [group, id] = sel.value.split(':');
        send({ action: 'add', group, to: id === 'new' ? 'new' : Number(id) });
      };
      add.replaceWith(sel);
      sel.focus();
    };
    box.append(add);
  }
  return box;
}

function card(e) {
  const thumb = e.snapshot
    ? el('img', { src: `/media/${e.snapshot}`, loading: 'lazy', alt: '' })
    : el('div', { class: 'noimg' }, t('ev.noImage'));
  const tags = el('div', { class: 'tags' },
    badge(t(`kind.${e.kind}`), `k-${e.kind}`),
    e.vehicleType && badge(t(`vtype.${e.vehicleType}`)),
    e.vehicleColor && badge(t(`color.${e.vehicleColor}`), `c-${e.vehicleColor}`),
    e.plate && badge(e.plate, 'plate'),
    whoBadge(e), e.archived && badge(`🗄️ ${t('ev.archived')}`));
  const check = el('span', { class: 'ev-check' }, selected.has(e.id) ? '☑' : '☐');
  const node = el('button', {
    class: 'ev-card', type: 'button', dataset: { id: e.id },
    onclick: () => {
      if (!selectMode) return showDetail(e);
      // Selezione multipla: il tocco aggiunge o toglie l'evento dalla selezione.
      if (selected.has(e.id)) selected.delete(e.id); else selected.add(e.id);
      node.classList.toggle('checked', selected.has(e.id));
      check.textContent = selected.has(e.id) ? '☑' : '☐';
      renderBulk();
    },
  }, ...(selectMode ? [check] : []), thumb, el('div', { class: 'cap' }, el('b', {}, e.camName), el('span', {}, fmtDate(e.ts)), tags));
  if (e.clip) node.classList.add('has-clip');
  if (e.id === selectedId && !selectMode) node.classList.add('sel');
  if (selectMode && selected.has(e.id)) node.classList.add('checked');
  return node;
}

// ---------- selezione multipla ed eliminazione (solo amministratore) ----------
let selectMode = false;
const selected = new Set();

function renderBulk() {
  const box = $('#ev-bulk');
  if (!box) return;
  if (!isAdmin()) { box.replaceChildren(); return; }
  if (!selectMode) {
    box.replaceChildren(el('button', { type: 'button', onclick: () => { selectMode = true; selected.clear(); renderResults(); renderBulk(); } }, `☑ ${t('ev.select')}`));
    return;
  }
  box.replaceChildren(
    el('button', { type: 'button', onclick: () => { for (const e of results) selected.add(e.id); renderResults(); renderBulk(); } }, t('ev.selectAll')),
    el('button', { type: 'button', onclick: () => { selected.clear(); renderResults(); renderBulk(); } }, t('ev.selectNone')),
    el('button', {
      type: 'button', class: 'danger', disabled: selected.size === 0,
      onclick: async () => {
        if (!selected.size || !confirm(t('ev.bulkConfirm', { n: selected.size }))) return;
        try {
          const r = await api('POST', '/api/events/delete-many', { ids: [...selected] });
          results = results.filter((e) => !selected.has(e.id));
          selected.clear();
          toast(t('ev.deleted', { n: r.deleted }));
          renderResults();
          renderBulk();
        } catch (err) { toast(errorText(err), { kind: 'err' }); }
      },
    }, `🗑 ${t('ev.deleteSel', { n: selected.size })}`),
    el('button', { type: 'button', onclick: () => { selectMode = false; selected.clear(); renderResults(); renderBulk(); } }, t('ev.done')),
  );
}

let selectedId = null;
const isPhone = () => matchMedia('(max-width: 700px), (pointer: coarse) and (max-height: 520px)').matches;

/** Lettore a destra (su telefono: schermata sopra la lista) con l'evento scelto nella lista a sinistra. */
function showDetail(e) {
  const box = $('#ev-detail');
  selectedId = e.id;
  for (const c of $$('.ev-card', $('#ev-results'))) c.classList.toggle('sel', Number(c.dataset.id) === e.id);
  box.classList.add('open');
  // Si guarda l'anteprima leggera (se già pronta); il filmato originale, alla massima qualità, si scarica.
  const video = e.clip ? el('video', { src: `/media/${e.preview || e.clip}`, controls: true, autoplay: true, playsInline: true, poster: e.snapshot ? `/media/${e.snapshot}` : undefined }) : null;
  const boxBtn = el('button', { type: 'button', hidden: true }, '');
  const media = video
    ? el('div', { class: 'vwrap' }, video)
    : e.snapshot ? el('img', { src: `/media/${e.snapshot}`, alt: '' }) : el('div', { class: 'noimg' }, t('ev.noClip'));
  const close = () => { box.classList.remove('open'); box.replaceChildren(el('p', { class: 'note empty' }, t('ev.pick'))); selectedId = null; for (const c of $$('.ev-card.sel')) c.classList.remove('sel'); };
  const info = el('div', { class: 'info' },
    el('h3', {}, e.camName), el('p', {}, fmtDate(e.ts, { dateStyle: 'full', timeStyle: 'medium' })),
    el('div', { class: 'tags' }, badge(t(`kind.${e.kind}`), `k-${e.kind}`),
      e.vehicleType && badge(t(`vtype.${e.vehicleType}`)), e.vehicleColor && badge(t(`color.${e.vehicleColor}`), `c-${e.vehicleColor}`),
      e.plate && badge(`${t('ev.plate')} ${e.plate}`), isAdmin() ? null : whoBadge(e)),
    isAdmin() ? subjectsEditor(e) : null,
    e.clip && e.snapshot ? el('a', { href: `/media/${e.snapshot}`, target: '_blank' }, '🖼') : null,
    e.clip ? el('a', { class: 'dl', href: `/media/${e.clip}`, download: e.clip.split('/').pop() }, `⬇ ${t('ev.downloadOrig')}`) : null,
    el('div', { class: 'row' },
      boxBtn,
      isAdmin() && el('button', {
        type: 'button', class: 'danger',
        onclick: async () => {
          if (!confirm(t('ev.deleteConfirm'))) return;
          await api('DELETE', `/api/events/${e.id}`);
          results = results.filter((x) => x.id !== e.id);
          close();
          renderResults();
        },
      }, t('ev.delete')),
      el('button', { type: 'button', class: 'ev-back', onclick: close }, isPhone() ? t('ev.back') : t('btn.close'))));
  box.replaceChildren(el('div', { class: 'media' }, media), info);
  if (video && e.tracks) attachTracks(video, media, e.tracks, boxBtn);
}

// ---------- riquadro rosso che segue la figura (sovraimpressione: nel video non viene inciso nulla) ----------
function attachTracks(video, wrap, rel, btn) {
  fetch(`/media/${rel}`).then((r) => r.json()).then((data) => {
    if (!data.boxes?.some(([, b]) => b.length)) return;
    const layer = el('div', { class: 'trk' });
    wrap.append(layer);
    const frames = data.boxes;
    const gap = 1.6 / (data.fps || 2); // oltre questo intervallo un riquadro non viene più disegnato
    const iou = (a, b) => {
      const x = Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
      const y = Math.max(0, Math.min(a[2] + a[4], b[2] + b[4]) - Math.max(a[2], b[2]));
      return (x * y) / (a[3] * a[4] + b[3] * b[4] - x * y + 1e-9);
    };
    const boxesAt = (ct) => {
      let i = frames.findIndex(([ts]) => ts > ct) - 1;
      if (i === -2) i = frames.length - 1; // dopo l'ultimo fotogramma
      if (i < 0) return [];
      const [t0, A] = frames[i];
      const next = frames[i + 1];
      if (ct - t0 > gap) return [];
      return A.map((a) => {
        if (!next || next[0] - t0 > gap) return a;
        let best = null, score = 0.05;
        for (const b of next[1]) { const s = b[0] === a[0] ? iou(a, b) : 0; if (s > score) { score = s; best = b; } }
        if (!best) return a;
        const f = (ct - t0) / (next[0] - t0);
        return [a[0], ...[1, 2, 3, 4].map((k) => a[k] + (best[k] - a[k]) * f)];
      });
    };
    const pool = [];
    const draw = () => {
      if (!layer.isConnected) return;
      requestAnimationFrame(draw);
      const vw = video.videoWidth, vh = video.videoHeight;
      if (!vw || layer.hidden) return;
      const bw = video.clientWidth, bh = video.clientHeight;
      const s = Math.min(bw / vw, bh / vh);
      const dw = vw * s, dh = vh * s;
      const ox = video.offsetLeft + (bw - dw) / 2, oy = video.offsetTop + (bh - dh) / 2;
      const list = boxesAt(video.currentTime);
      while (pool.length < list.length) { const d = el('div', {}); pool.push(d); layer.append(d); }
      pool.forEach((d, i) => {
        const b = list[i];
        d.style.display = b ? 'block' : 'none';
        if (!b) return;
        Object.assign(d.style, { left: `${ox + b[1] * dw}px`, top: `${oy + b[2] * dh}px`, width: `${b[3] * dw}px`, height: `${b[4] * dh}px` });
      });
    };
    requestAnimationFrame(draw);
    const apply = () => {
      const on = pref.get('trackBox') !== '0';
      layer.hidden = !on;
      btn.textContent = `${on ? '▣' : '▢'} ${t('ev.trackBox')}`;
    };
    btn.hidden = false;
    btn.onclick = () => { pref.set('trackBox', pref.get('trackBox') === '0' ? '1' : '0'); apply(); };
    apply();
  }).catch(() => {});
}

function renderResults() {
  const grid = $('#ev-results');
  grid.replaceChildren(...results.map(card));
  $('#ev-empty').hidden = results.length > 0;
}

async function runSearch(reset = true) {
  const q = new URLSearchParams();
  const text = $('#ev-q').value.trim();
  if (text) q.set('q', text);
  if ($('#ev-cam').value) q.set('cam', $('#ev-cam').value);
  if ($('#ev-kind').value) q.set('kind', $('#ev-kind').value);
  if (personFilter) q.set('person', personFilter);
  q.set('limit', '48');
  q.set('offset', reset ? '0' : String(results.length));
  const r = await api('GET', `/api/events?${q}`);
  results = reset ? r.events : [...results, ...r.events];
  $('#ev-chips').replaceChildren(...(r.interpreted.length
    ? [el('span', { class: 'note' }, t('ev.understood')), ...r.interpreted.map((c) => el('span', { class: 'chip' }, chipText(c)))]
    : []));
  $('#ev-more').hidden = r.events.length < 48;
  renderResults();
}

function buildEventsTab() {
  const cam = el('select', { id: 'ev-cam' }, new Option(t('ev.allCams'), ''));
  for (const c of state.cameras) cam.add(new Option(c.name, c.id));
  const kind = el('select', { id: 'ev-kind' }, new Option(t('ev.allKinds'), ''));
  for (const k of KIND_ORDER) kind.add(new Option(t(`kind.${k}`), k));
  const input = el('input', { id: 'ev-q', type: 'search', placeholder: t('ev.search'), autocomplete: 'off' });
  const go = (e) => { e?.preventDefault(); personFilter = null; runSearch().catch((err) => toast(errorText(err), { kind: 'err' })); };
  const form = el('form', { class: 'ev-form', onsubmit: go }, input, cam, kind, el('button', { class: 'primary', type: 'submit' }, t('ev.go')));
  cam.onchange = kind.onchange = go;
  return el('section', { id: 'ev-tab-events' }, form, el('div', { id: 'ev-chips', class: 'chips' }), el('div', { id: 'ev-bulk', class: 'ev-bulk' }),
    el('div', { class: 'ev-split' },
      el('div', { id: 'ev-listwrap', class: 'ev-listwrap' },
        el('div', { id: 'ev-results', class: 'ev-grid' }), el('p', { id: 'ev-empty', class: 'note', hidden: true }, t('ev.none')),
        el('button', { id: 'ev-more', type: 'button', hidden: true, onclick: () => runSearch(false) }, t('ev.more'))),
      el('div', { id: 'ev-detail', class: 'ev-detail' }, el('p', { class: 'note empty' }, t('ev.pick')))));
}

// ---------- persone ----------
async function loadPeople(kind = 'people') {
  const box = $('#ev-people');
  box.replaceChildren();
  let people = [];
  try { people = await api('GET', '/api/persons'); } catch { /* riconoscimento non attivo */ }
  // Si può unire solo dentro lo stesso gruppo/specie.
  const others = (p) => people.filter((o) => o.id !== p.id && (o.species || null) === (p.species || null));
  const card = (p) => {
    const name = el('input', { type: 'text', value: p.name || '', placeholder: t('people.unknown'), maxLength: 60 });
    const merge = el('select', {}, new Option(t('people.merge'), ''), ...others(p).map((o) => new Option(o.name || `${t('people.unknown')} #${o.id}`, o.id)));
    merge.onchange = async () => {
      if (!merge.value) return;
      await api('POST', `/api/persons/${p.id}/merge`, { into: Number(merge.value) });
      loadPeople(kind);
    };
    // Somiglianza con uno già presente: in percentuale rispetto alla soglia di "stesso soggetto".
    const rc = state.settings?.recognition || {};
    const thrOf = { people: rc.faceThreshold || 0.363, pets: rc.petThreshold || 0.82, vehicles: rc.vehicleThreshold || 0.85 }[groupOf(p)];
    const similar = p.suggestId && el('div', { class: 'suggest' },
      p.suggestCrop && el('img', { src: `/media/${p.suggestCrop}`, alt: '' }),
      el('span', {}, t('people.similar', { name: p.suggestName || `${t('people.unknown')} #${p.suggestId}`, n: Math.min(99, Math.round(((p.suggestSim || 0) / thrOf) * 100)) })),
      el('button', { type: 'button', class: 'primary', onclick: async () => { await api('POST', `/api/persons/${p.id}/suggestion`, { accept: true }); loadPeople(kind); } }, t('people.sameYes')),
      el('button', { type: 'button', onclick: async () => { await api('POST', `/api/persons/${p.id}/suggestion`, { accept: false }); loadPeople(kind); } }, t('people.sameNo')));
    // Immagini imparate da questo soggetto: da qui si tolgono o si spostano quelle assegnate per errore.
    const samples = el('div', { class: 'samples', hidden: true });
    const loadSamples = async () => {
      samples.replaceChildren(el('p', { class: 'note' }, '…'));
      let list = [];
      try { list = await api('GET', `/api/persons/${p.id}/faces`); } catch (err) { samples.replaceChildren(el('p', { class: 'note err' }, errorText(err))); return; }
      const sample = (f) => {
        const move = el('select', { class: 'mini' }, new Option(t('people.sampleMove'), ''), ...others(p).map((o) => new Option(o.name || `${t('people.unknown')} #${o.id}`, o.id)), new Option(t('people.sampleNew'), 'new'));
        move.onchange = async () => {
          if (!move.value) return;
          try { await api('POST', `/api/persons/${p.id}/faces/${f.id}/move`, { into: move.value === 'new' ? 'new' : Number(move.value) }); loadPeople(kind); } catch (err) { toast(errorText(err), { kind: 'err' }); }
        };
        return el('div', { class: 'sample' },
          f.crop ? el('img', { src: `/media/${f.crop}`, alt: '', loading: 'lazy' }) : el('div', { class: 'noimg' }, '·'),
          el('span', { class: 'note' }, [f.camName, fmtDate(f.ts, { dateStyle: 'short', timeStyle: 'short' })].filter(Boolean).join(' · ')),
          move,
          el('button', {
            type: 'button', class: 'danger mini', title: t('people.sampleRemove'),
            onclick: async () => {
              if (!confirm(t('people.sampleConfirm'))) return;
              try { await api('DELETE', `/api/persons/${p.id}/faces/${f.id}`); loadPeople(kind); } catch (err) { toast(errorText(err), { kind: 'err' }); }
            },
          }, '✕ ' + t('people.sampleRemove')));
      };
      samples.replaceChildren(...(list.length ? list.map(sample) : [el('p', { class: 'note' }, t('people.noSamples'))]));
    };
    return el('div', { class: 'person' },
      p.crop ? el('img', { src: `/media/${p.crop}`, alt: '' }) : el('div', { class: 'noimg' }, p.species ? (VEHICLE_SPECIES.has(p.species) ? '🚗' : '🐾') : '👤'),
      el('div', { class: 'pinfo' }, name, similar,
        el('span', { class: 'note' }, `${t(kind === 'people' ? 'people.faces' : 'people.images', { n: p.faces })} · ${t('people.events', { n: p.events })}`),
        el('div', { class: 'row' },
          el('button', { type: 'button', onclick: async () => { await api('PUT', `/api/persons/${p.id}`, { name: name.value }); loadPeople(kind); } }, t('people.rename')),
          el('button', { type: 'button', onclick: () => { personFilter = p.id; switchTab('events'); runSearch(); } }, t('ev.tabEvents')),
          el('button', { type: 'button', onclick: () => { samples.hidden = !samples.hidden; if (!samples.hidden) loadSamples(); } }, t('people.samples', { n: p.faces })),
          merge,
          el('button', {
            type: 'button', class: 'danger',
            onclick: async () => { if (confirm(t('people.deleteConfirm'))) { await api('DELETE', `/api/persons/${p.id}`); loadPeople(kind); } },
          }, '✕')),
        samples));
  };
  // Persone, animali e veicoli sono tre schede separate; chi ha un suggerimento da confermare va in cima.
  const shown = people.filter((p) => groupOf(p) === kind).sort((a, b) => !!b.suggestId - !!a.suggestId);
  const emptyKey = { people: 'people.emptyPeople', pets: 'people.emptyPets', vehicles: 'people.emptyVehicles' }[kind];
  box.append(...(shown.length ? shown.map(card) : [el('p', { class: 'note' }, t(emptyKey))]));
  box.append(el('button', { type: 'button', onclick: async () => { const r = await api('POST', '/api/recognition/reprocess', { again: true }); toast(`${r.queued}`); } }, t('people.reprocess')));
}

function switchTab(name) {
  if (name !== 'events' && !isAdmin()) name = 'events'; // persone, animali e veicoli riconosciuti: solo amministratore
  tab = name;
  for (const b of $$('.tabs button', $('#events'))) b.classList.toggle('on', b.dataset.tab === name);
  $('#ev-tab-events').hidden = name !== 'events';
  $('#ev-people').hidden = name === 'events';
  if (name !== 'events') loadPeople(name);
}

async function openEvents() {
  const body = $('#events-body');
  body.replaceChildren(buildEventsTab(), el('div', { id: 'ev-people', class: 'people', hidden: true }));
  $('#events-title').textContent = t('ev.title');
  for (const b of $$('.tabs button', $('#events'))) b.textContent = t({ events: 'ev.tabEvents', people: 'ev.tabPeople', pets: 'ev.tabPets', vehicles: 'ev.tabVehicles' }[b.dataset.tab]);
  personFilter = null;
  selectedId = null;
  selectMode = false;
  selected.clear();
  renderBulk();
  switchTab('events');
  $('#events').showModal();
  try {
    await runSearch();
    if (focusEventId) { const e = results.find((x) => x.id === focusEventId); if (e) showDetail(e); }
    else if (results[0] && !isPhone() && !selectMode) showDetail(results[0]); // su schermo grande si parte già dall'evento più recente
  } catch (err) { toast(errorText(err), { kind: 'err' }); }
  focusEventId = null;
}
let focusEventId = null;

// Un nuovo evento aggiorna la lista aperta (senza ricerca attiva).
function onStored() {
  if (!$('#events').open || tab !== 'events' || $('#ev-q')?.value) return;
  clearTimeout(live);
  live = setTimeout(() => runSearch().catch(() => {}), 800);
}

export function initEvents(appApi) {
  app = appApi;
  connect();
  $('#btn-events').addEventListener('click', openEvents);
  $('#events-close').addEventListener('click', () => $('#events').close());
  for (const b of $$('.tabs button', $('#events'))) b.addEventListener('click', () => switchTab(b.dataset.tab));
  $('#bell-close').addEventListener('click', () => $('#bell').close());
}
