// Eventi in tempo reale (lampo rosso, notifiche, popup del campanello con microfono)
// e finestra di consultazione: ricerca intelligente, dettaglio, persone riconosciute.
import { t, fmtDate, getLang } from './i18n.js';
import { state, $, $$, api, el, toast, camById, pref, errorText, isAdmin } from './state.js';
import './player.js';
import { svgIcon, subjectIconName } from './icons.js';

let app = null;

// ---------- collegamento agli eventi del server ----------
function connect() {
  const es = new EventSource('/api/events/stream');
  es.addEventListener('detect', (e) => onDetect(JSON.parse(e.data)));
  es.addEventListener('visitor', (e) => onVisitor(JSON.parse(e.data)));
  es.addEventListener('status', (e) => document.dispatchEvent(new CustomEvent('camstatus', { detail: JSON.parse(e.data) })));
  es.addEventListener('privacy', (e) => document.dispatchEvent(new CustomEvent('campriv', { detail: JSON.parse(e.data) })));
  es.addEventListener('event', (e) => { const ev = JSON.parse(e.data); onStored(ev); popupEvent(ev); refreshBadges(); });
  es.addEventListener('event-update', () => { onStored(null); refreshBadges(); });
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
/** Gruppo (scheda) di una persona riconosciuta: persone, animali o veicoli. */
/** Chiave di unione: persone, veicoli (tutti insieme) o animali della stessa specie. */
const compat = (p) => (!p.species ? 'p' : VEHICLE_SPECIES.has(p.species) ? 'v' : p.species);
const groupOf = (p) => (!p.species ? 'people' : VEHICLE_SPECIES.has(p.species) ? 'vehicles' : 'pets');
let results = [];
let tab = 'events';
let personFilter = null;
let tags = []; // tag di filtro scelti: { g: 'kind'|'vtype'|'color'|'subject', v, label }
let focusCam = null;
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
const subjectLabel = (s) => s.name || `${t('people.unknown')} #${s.id}`;
/** Tag di un soggetto riconosciuto, con l'icona monocromatica del suo tipo (persona, veicolo, animale). */
function subjBadge(s) {
  const b = badge('');
  b.innerHTML = `${svgIcon(subjectIconName(s.species), 13)} `;
  b.append(subjectLabel(s));
  return b;
}
const whoBadge = (e) => (e.subjects || []).map(subjBadge);

/**
 * Tag del tipo di evento. L'amministratore lo può togliere (l'evento resta come semplice movimento); per incendio e
 * allagamento il pulsante dice "Falso allarme" e Argo impara a non ripetere l'errore su quella telecamera.
 */
function kindTag(e) {
  const tag = badge(t(`kind.${e.kind}`), `k-${e.kind}`);
  if (!isAdmin() || e.kind === 'motion') return tag;
  const hazard = e.kind === 'fire' || e.kind === 'flood';
  const btn = el('button', {
    type: 'button', class: 'mini danger', title: t(hazard ? 'ev.falseAlarm' : 'ev.removeTag'),
    onclick: async () => {
      const k = t(`kind.${e.kind}`);
      if (!confirm(t(hazard ? 'ev.falseAlarmConfirm' : 'ev.removeTagConfirm', { k }))) return;
      try {
        const upd = await api('POST', `/api/events/${e.id}/kind`, { kind: 'motion', falseAlarm: hazard });
        const i = results.findIndex((x) => x.id === e.id);
        if (i >= 0) results[i] = upd;
        renderResults();
        showDetail(upd);
        if (hazard) toast(t('ev.falseAlarmDone'));
      } catch (err) { toast(errorText(err), { kind: 'err' }); }
    },
  }, hazard ? `✕ ${t('ev.falseAlarm')}` : '✕');
  return el('span', { class: 'kind-tag' }, tag, btn);
}

/** Da dove viene l'evento: interno (registrato da Argo), archivio di rete, hub Reolink, cloud Eufy. */
function sourceTags(e) {
  const tags = [];
  const mk = (icon, key) => { const b = badge(''); b.classList.add('src'); b.innerHTML = `${svgIcon(icon, 12)} `; b.append(t(key)); return b; };
  const src = e.meta?.source;
  if (src === 'reolink-hub') tags.push(mk('server-network', 'src.hub'));
  else if (src === 'eufy-push') tags.push(mk('cloud', 'src.eufy'));
  else tags.push(mk(e.archived ? 'archive' : 'harddisk', e.archived ? 'src.archive' : 'src.local'));
  if (e.meta?.hubLinked) tags.push(mk('server-network', 'src.hubCopy'));
  return tags;
}

/** Segnaposto senza immagine: icona monocromatica neutra del tipo di soggetto, con la scritta "nessuna immagine". */
function noThumb(p) {
  const d = el('div', { class: 'noimg nothumb', title: t('people.noImage') });
  d.innerHTML = `${svgIcon(subjectIconName(p.species), 38)}<small></small>`;
  d.querySelector('small').textContent = t('people.noImage');
  return d;
}

/** Nome per un nuovo soggetto creato dall'evento (vuoto = senza nome); null se si annulla. */
const askName = () => { const n = prompt(t('ev.whoNamePrompt')); return n === null ? null : n.trim().slice(0, 60); };

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
      sel.onchange = () => {
        if (!sel.value) return;
        if (sel.value !== 'new') return send({ action: 'change', from: s.id, to: Number(sel.value) });
        const nm = askName();
        if (nm === null) { sel.value = ''; return; }
        send({ action: 'change', from: s.id, to: 'new', name: nm });
      };
      change.replaceWith(sel);
      sel.focus();
    };
    const remove = el('button', {
      type: 'button', class: 'mini danger', title: t('people.sampleRemove'),
      onclick: () => { if (confirm(t('ev.whoNoneConfirm'))) send({ action: 'remove', from: s.id }); },
    }, '✕');
    box.append(el('span', { class: 'subj-row' }, subjBadge(s), change, remove));
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
        if (id !== 'new') return send({ action: 'add', group, to: Number(id) });
        const nm = askName();
        if (nm === null) { sel.value = ''; return; }
        send({ action: 'add', group, to: 'new', name: nm });
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
    whoBadge(e), ...sourceTags(e),
    isAdmin() && e.meta?.objects && badge('🔍', 'analysed'));
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
    el('div', { class: 'tags' }, kindTag(e),
      e.vehicleType && badge(t(`vtype.${e.vehicleType}`)), e.vehicleColor && badge(t(`color.${e.vehicleColor}`), `c-${e.vehicleColor}`),
      e.plate && badge(`${t('ev.plate')} ${e.plate}`), isAdmin() ? null : whoBadge(e)),
    isAdmin() ? subjectsEditor(e) : null,
    isAdmin() && e.snapshot ? el('div', { class: 'row analysis' },
      badge(`🔍 ${t(e.meta?.objects ? 'ev.analysed' : 'ev.notAnalysed')}${e.meta?.analysedAt ? ` · ${fmtDate(e.meta.analysedAt, { dateStyle: 'short', timeStyle: 'short' })}` : ''}`, 'analysed'),
      el('button', {
        type: 'button', class: 'mini',
        onclick: async (ev) => {
          if (!confirm(t('ev.reanalyzeConfirm'))) return;
          ev.target.disabled = true;
          try { await api('POST', `/api/events/${e.id}/reanalyze`); toast(t('ev.reanalyzeStarted')); } catch (err) { toast(errorText(err), { kind: 'err' }); }
          ev.target.disabled = false;
        },
      }, `↻ ${t('ev.reanalyze')}`)) : null,
    e.clip && e.snapshot ? el('a', { href: `/media/${e.snapshot}`, target: '_blank' }, '🖼') : null,
    e.clip ? el('a', { class: 'dl', href: `/media/${e.clip}`, download: e.clip.split('/').pop() }, `⬇ ${t('ev.downloadOrig')}`) : null,
    e.meta?.hubName ? el('a', { class: 'dl', href: `/api/events/${e.id}/hub-original` }, `⬇ ${t('ev.hubOriginal')}`) : null,
    el('div', { class: 'tags' }, ...sourceTags(e)),
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
  // Tag scelti: i tipi di evento, di veicolo e i colori valgono "uno qualsiasi"; i soggetti devono comparire tutti.
  const of = (g) => tags.filter((x) => x.g === g).map((x) => x.v).join(',');
  for (const [g, key] of [['kind', 'kinds'], ['vtype', 'vtypes'], ['color', 'colors'], ['subject', 'subjects']]) if (of(g)) q.set(key, of(g));
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
  const input = el('input', { id: 'ev-q', type: 'search', placeholder: t('ev.search'), autocomplete: 'off' });
  const go = (e) => { e?.preventDefault(); personFilter = null; runSearch().catch((err) => toast(errorText(err), { kind: 'err' })); };
  // Tag di filtro: se ne possono aggiungere quanti si vuole, e si tolgono con ✕.
  const tagBox = el('div', { id: 'ev-tags', class: 'chips' });
  const paintTags = () => tagBox.replaceChildren(...tags.map((x, i) => el('span', { class: 'chip tagchip' }, x.label,
    el('button', { type: 'button', class: 'x', title: t('ev.removeTag'), onclick: () => { tags.splice(i, 1); paintTags(); go(); } }, '✕'))));
  const add = el('select', { id: 'ev-tag', title: t('ev.addTag') }, new Option(`＋ ${t('ev.addTag')}`, ''));
  const group = (label, items) => { const og = el('optgroup', { label }); for (const [v, l] of items) og.append(new Option(l, v)); add.append(og); return og; };
  group(t('ev.tagKind'), KIND_ORDER.map((k) => [`kind:${k}`, t(`kind.${k}`)]));
  group(t('ev.tagVehicle'), ['car', 'truck', 'bus', 'motorcycle', 'bicycle'].map((k) => [`vtype:${k}`, t(`vtype.${k}`)]));
  group(t('ev.tagColor'), ['white', 'black', 'grey', 'silver', 'red', 'blue', 'green', 'yellow', 'orange', 'brown'].map((k) => [`color:${k}`, t(`color.${k}`)]));
  if (isAdmin()) {
    api('GET', '/api/persons').then((all) => {
      const named = all.filter((p) => p.name);
      if (named.length) group(t('ev.tagSubject'), named.map((p) => [`subject:${p.id}`, p.name]));
    }).catch(() => {});
  }
  add.onchange = () => {
    if (!add.value) return;
    const [g, v] = add.value.split(':');
    if (!tags.some((x) => x.g === g && x.v === v)) tags.push({ g, v, label: add.options[add.selectedIndex].text });
    add.value = '';
    paintTags();
    go();
  };
  const form = el('form', { class: 'ev-form', onsubmit: go }, input, cam, add, el('button', { class: 'primary', type: 'submit' }, t('ev.go')));
  cam.onchange = go;
  return el('section', { id: 'ev-tab-events' }, form, tagBox, el('div', { id: 'ev-chips', class: 'chips' }), el('div', { id: 'ev-bulk', class: 'ev-bulk' }),
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
  const others = (p) => people.filter((o) => o.id !== p.id && compat(o) === compat(p));
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
      p.crop ? el('img', { src: `/media/${p.crop}`, alt: '' }) : noThumb(p),
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
  // Persone, animali e veicoli sono tre schede separate, ciascuna divisa in due: chi ha già un nome e chi è
  // ancora da identificare (con un suggerimento da confermare va in cima). Le due parti stanno una sotto l'altra
  // oppure affiancate (registrati a sinistra, da identificare a destra, ognuna con il proprio scorrimento).
  const group = people.filter((p) => groupOf(p) === kind);
  const named = group.filter((p) => p.name);
  const unknown = group.filter((p) => !p.name).sort((a, b) => !!b.suggestId - !!a.suggestId);
  for (const k of Object.keys(unknownBy)) unknownBy[k] = people.filter((p) => groupOf(p) === k && !p.name).length;
  paintBadges();
  const byId = new Map(group.map((p) => [p.id, p]));
  for (const id of [...picked]) if (!byId.has(id)) picked.delete(id); // chi non c'è più (unito, eliminato) esce dalla selezione
  const split = pref.get('peopleSplit') === '1' && !isPhone();
  box.classList.toggle('split', split);

  /** Unisce uno o più soggetti a uno già registrato (pulsante "Unisci con…" o trascinamento). */
  const mergeInto = async (list, target) => {
    let ok = 0, bad = 0;
    for (const id of list) {
      if (id === target) continue;
      try { await api('POST', `/api/persons/${id}/merge`, { into: target }); ok++; } catch { bad++; }
    }
    toast(t('people.pickDone', { n: ok }) + (bad ? ` ${t('people.pickFailed', { n: bad })}` : ''), bad ? { kind: 'err' } : undefined);
    picked.clear();
    loadPeople(kind);
  };

  const pickBar = el('div', { class: 'pick-bar', hidden: true });
  const renderPickBar = () => {
    for (const c of $$('.person[data-id]', box)) {
      const on = picked.has(Number(c.dataset.id));
      c.classList.toggle('picked', on);
      const ck = $('input.pick', c);
      if (ck) ck.checked = on;
    }
    pickBar.hidden = !picked.size;
    if (!picked.size) return;
    const chosen = group.filter((p) => picked.has(p.id));
    const parts = [
      el('b', {}, t('people.pickCount', { n: picked.size })),
      el('button', { type: 'button', onclick: () => { picked.clear(); renderPickBar(); } }, t('people.pickNone'))];
    // Unire ha senso solo per soggetti ancora senza nome, e verso uno dello stesso tipo (stessa specie).
    if (chosen.every((p) => !p.name)) {
      const species = new Set(chosen.map(compat));
      const targets = named.filter((o) => species.size === 1 && compat(o) === [...species][0]);
      const into = el('select', {}, new Option(t('people.merge'), ''), ...targets.map((o) => new Option(o.name, o.id)), new Option(t('people.pickNew'), 'new'));
      into.onchange = async () => {
        if (!into.value) return;
        const ids = [...picked];
        if (into.value !== 'new') return mergeInto(ids, Number(into.value));
        const nm = (prompt(t('people.pickNewPrompt')) || '').trim().slice(0, 60);
        if (!nm) { into.value = ''; return; }
        const same = named.find((o) => o.name.toLowerCase() === nm.toLowerCase() && compat(o) === [...species][0]);
        if (same) return mergeInto(ids, same.id);
        try { await api('PUT', `/api/persons/${ids[0]}`, { name: nm }); } catch (err) { toast(errorText(err), { kind: 'err' }); return; }
        mergeInto(ids.slice(1), ids[0]);
      };
      parts.push(into);
    }
    parts.push(el('button', {
      type: 'button', class: 'danger',
      onclick: async () => {
        const ids = [...picked];
        if (!confirm(t('people.delManyConfirm', { n: ids.length }))) return;
        let ok = 0;
        for (const id of ids) { try { await api('DELETE', `/api/persons/${id}`); ok++; } catch { /* già eliminato */ } }
        toast(t('people.delDone', { n: ok }));
        picked.clear();
        loadPeople(kind);
      },
    }, `✕ ${t('people.delMany')}`));
    pickBar.replaceChildren(...parts);
  };

  // Scheda con la casella di selezione sotto l'immagine. Da identificare: l'immagine si trascina; registrati: ci si rilascia sopra.
  const decorate = (p) => {
    const unk = !p.name;
    const node = card(p);
    node.dataset.id = p.id;
    node.classList.add(unk ? 'unk' : 'reg');
    const thumb = node.firstElementChild;
    const ck = el('input', {
      type: 'checkbox', class: 'pick', checked: picked.has(p.id),
      onchange: (ev) => { if (ev.target.checked) picked.add(p.id); else picked.delete(p.id); renderPickBar(); },
    });
    node.prepend(el('div', { class: 'pthumb' }, thumb, el('label', { class: 'pickrow' }, ck, t('people.pickSel'))));
    if (unk) {
      thumb.draggable = true;
      thumb.title = t('people.dragTitle');
      thumb.classList.add('drag');
      thumb.addEventListener('dragstart', (ev) => {
        dragIds = picked.has(p.id) ? [...picked].filter((i) => byId.get(i) && !byId.get(i).name) : [p.id];
        ev.dataTransfer.setData('text/plain', dragIds.join(','));
        ev.dataTransfer.effectAllowed = 'move';
        ev.dataTransfer.setDragImage(node, 20, 20);
      });
      thumb.addEventListener('dragend', () => { dragIds = null; for (const c of $$('.person.drop', box)) c.classList.remove('drop'); });
    } else {
      node.addEventListener('dragover', (ev) => { if (!dragIds) return; ev.preventDefault(); node.classList.add('drop'); });
      node.addEventListener('dragleave', (ev) => { if (!node.contains(ev.relatedTarget)) node.classList.remove('drop'); });
      node.addEventListener('drop', (ev) => {
        ev.preventDefault();
        node.classList.remove('drop');
        const list = dragIds;
        dragIds = null;
        if (list?.length) mergeInto(list, p.id);
      });
    }
    return node;
  };

  const emptyKey = { people: 'people.emptyPeople', pets: 'people.emptyPets', vehicles: 'people.emptyVehicles' }[kind];
  const head = (key, n, extra) => el('h4', { class: 'grp' }, `${t(key)} `, el('span', { class: 'cnt' }, String(n)), extra || null);
  const tools = el('div', { class: 'people-tools' },
    isPhone() ? null : el('button', { type: 'button', class: 'mini', onclick: () => { pref.set('peopleSplit', split ? '0' : '1'); loadPeople(kind); } }, t(split ? 'people.stack' : 'people.split')),
    named.length && unknown.length ? el('span', { class: 'note' }, t('people.dragHint')) : null);
  box.append(
    tools,
    pickBar,
    el('div', { class: 'people-cols' },
      el('div', { class: 'people-sec sec-named' }, head('people.secNamed', named.length),
        el('div', { class: 'sec-grid' }, ...(named.length ? named.map(decorate) : [el('p', { class: 'note' }, t(group.length ? 'people.noneNamed' : emptyKey))]))),
      el('div', { class: 'people-sec sec-unk' },
        head('people.secUnknown', unknown.length, unknown.length ? el('button', { type: 'button', class: 'mini', onclick: () => { for (const p of unknown) picked.add(p.id); renderPickBar(); } }, t('people.pickAll')) : null),
        el('div', { class: 'sec-grid' }, ...(unknown.length ? unknown.map(decorate) : [el('p', { class: 'note' }, t('people.noneUnknown'))])))));
  renderPickBar();

  // Analisi degli eventi già salvati, con barra di avanzamento (anche se l'analisi era già in corso).
  const bar = el('progress', { max: 1, value: 0 });
  const barLabel = el('span', { class: 'note' });
  const barBox = el('div', { class: 'arc-progress', hidden: true }, barLabel, bar);
  const watch = () => {
    clearInterval(reprocessTimer);
    const tick = async () => {
      if (!document.body.contains(barBox)) { clearInterval(reprocessTimer); reprocessTimer = null; return; }
      let pr;
      try { pr = await api('GET', '/api/recognition/progress'); } catch { return; }
      if (pr.pending > 0) {
        barBox.hidden = false;
        bar.max = pr.total; bar.value = pr.total - pr.pending;
        barLabel.textContent = t('people.running', { done: pr.total - pr.pending, total: pr.total });
        return;
      }
      clearInterval(reprocessTimer); reprocessTimer = null;
      toast(t('people.analysed'));
      refreshBadges(); // nel frattempo sono nati nuovi soggetti da identificare
      if (tab === kind) loadPeople(kind);
    };
    reprocessTimer = setInterval(tick, 1000);
  };
  const done = (key) => { barBox.hidden = false; bar.max = 1; bar.value = 1; barLabel.textContent = t(key); };
  const run = el('button', {
    type: 'button',
    onclick: async () => {
      run.disabled = true;
      try {
        // Gli eventi già analizzati si rifanno solo se l'utente lo conferma; altrimenti si analizzano quelli mai analizzati.
        const info = await api('GET', '/api/recognition/reprocess');
        const again = info.analysed > 0 && confirm(t('people.reprocessAsk', info));
        if (!again && !info.fresh) return done('people.nothingToDo');
        const r = await api('POST', '/api/recognition/reprocess', { again });
        if (!r.queued) return done('people.nothingToDo');
        barBox.hidden = false; bar.removeAttribute('value'); barLabel.textContent = t('people.preparing');
        watch();
      } catch (err) { toast(errorText(err), { kind: 'err' }); } finally { run.disabled = false; }
    },
  }, t('people.reprocess'));
  box.append(run, barBox);
  api('GET', '/api/recognition/progress').then((pr) => { if (pr.pending > 0) { barBox.hidden = false; watch(); } }).catch(() => {});
}
let dragIds = null; // soggetti in trascinamento
let reprocessTimer = null;
const picked = new Set(); // soggetti da identificare scelti per essere uniti insieme
const unknownBy = { people: 0, pets: 0, vehicles: 0 };
let unseen = 0;

// ---------- pallini rossi con il numero: eventi nuovi e soggetti ancora da identificare ----------
function setBadge(node, n) {
  if (!node) return;
  let b = node.querySelector(':scope > .nbadge');
  if (!n) { b?.remove(); return; }
  if (!b) { b = el('span', { class: 'nbadge' }); node.append(b); }
  b.textContent = n > 99 ? '99+' : String(n);
}
function paintBadges() {
  const admin = isAdmin();
  const todo = admin ? unknownBy.people + unknownBy.pets + unknownBy.vehicles : 0;
  setBadge($('#btn-events'), unseen + todo);
  for (const b of $$('.tabs button', $('#events'))) {
    const k = b.dataset.tab;
    b.textContent = t({ events: 'ev.tabEvents', people: 'ev.tabPeople', pets: 'ev.tabPets', vehicles: 'ev.tabVehicles' }[k]);
    setBadge(b, k === 'events' ? unseen : admin ? unknownBy[k] : 0);
  }
}
/** Chi entra nell'elenco degli eventi li ha visti: il numero si azzera (si ricorda l'ora del server). */
async function markSeen() {
  unseen = 0;
  paintBadges();
  try { pref.set('evSeen', String((await api('GET', '/api/events/unseen?since=9007199254740991')).now)); } catch { /* offline */ }
}
let badgeTimer = null;
async function refreshBadges() {
  clearTimeout(badgeTimer);
  badgeTimer = setTimeout(async () => {
    try {
      if ($('#events').open && tab === 'events') await markSeen();
      else {
        let since = Number(pref.get('evSeen')) || 0;
        if (!since) { since = (await api('GET', '/api/events/unseen?since=9007199254740991')).now; pref.set('evSeen', String(since)); }
        unseen = (await api('GET', `/api/events/unseen?since=${since}`)).n;
      }
    } catch { /* non ancora collegato */ }
    if (isAdmin()) {
      try {
        const all = await api('GET', '/api/persons');
        for (const k of Object.keys(unknownBy)) unknownBy[k] = all.filter((p) => groupOf(p) === k && !p.name).length;
      } catch { /* riconoscimento non attivo */ }
    }
    paintBadges();
  }, 600);
}

function switchTab(name) {
  if (name !== 'events' && !isAdmin()) name = 'events'; // persone, animali e veicoli riconosciuti: solo amministratore
  tab = name;
  picked.clear();
  if (name === 'events') markSeen();
  for (const b of $$('.tabs button', $('#events'))) b.classList.toggle('on', b.dataset.tab === name);
  $('#ev-tab-events').hidden = name !== 'events';
  $('#ev-people').hidden = name === 'events';
  if (name !== 'events') loadPeople(name);
}

async function openEvents() {
  tags = [];
  const body = $('#events-body');
  body.replaceChildren(buildEventsTab(), el('div', { id: 'ev-people', class: 'people', hidden: true }));
  $('#events-title').textContent = t('ev.title');
  paintBadges();
  refreshBadges();
  personFilter = null;
  selectedId = null;
  selectMode = false;
  selected.clear();
  renderBulk();
  switchTab('events');
  $('#events').showModal();
  if (focusCam) { $('#ev-cam').value = focusCam; focusCam = null; }
  try {
    await runSearch();
    if (focusEventId) { const e = results.find((x) => x.id === focusEventId); if (e) showDetail(e); }
    else if (results[0] && !isPhone() && !selectMode) showDetail(results[0]); // su schermo grande si parte già dall'evento più recente
  } catch (err) { toast(errorText(err), { kind: 'err' }); }
  focusEventId = null;
}
let focusEventId = null;
/** Apre gli eventi già filtrati su una telecamera (bottone sul riquadro). */
export function openEventsFor(camId) { focusCam = camId; openEvents(); }

// Un nuovo evento aggiorna la lista aperta (senza ricerca attiva).
function onStored() {
  if (!$('#events').open || tab !== 'events' || $('#ev-q')?.value) return;
  clearTimeout(live);
  live = setTimeout(() => runSearch().catch(() => {}), 800);
}

export function initEvents(appApi) {
  app = appApi;
  connect();
  setTimeout(refreshBadges, 1500);
  setInterval(refreshBadges, 60_000);
  $('#btn-events').addEventListener('click', openEvents);
  $('#events-close').addEventListener('click', () => $('#events').close());
  for (const b of $$('.tabs button', $('#events'))) b.addEventListener('click', () => switchTab(b.dataset.tab));
  $('#bell-close').addEventListener('click', () => $('#bell').close());
}
