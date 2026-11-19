// Eventi delle telecamere Eufy dalle notifiche push del cloud Eufy (le stesse dell'app Eufy sul telefono).
//
// Le Eufy non mandano gli eventi in rete locale, e senza abbonamento il cloud non li conserva: arrivano però come
// notifiche ("Someone has been spotted", con tipo di evento e un'anteprima). Un processo a parte
// (tools/eufy-login/push.mjs, che usa la sessione Eufy già salvata) le riceve e le passa qui una per riga.
// Ogni notifica diventa un evento di Argo con l'immagine di anteprima; il filmato (che sta sulla telecamera) non passa da qui.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DATA, ROOT } from './paths.js';

const TOOL_DIR = path.join(ROOT, 'tools', 'eufy-login');
const SCRIPT = path.join(TOOL_DIR, 'push.mjs');
const SESSION = path.join(DATA, 'eufy-session.json');
const RETRY_MS = [10_000, 30_000, 60_000, 300_000];
const PIC_WAIT_MS = 7000; // la prima notifica non ha l'immagine: la seconda (circa un secondo dopo) sì

let child = null;
let timer = null;
let stopped = true;
let fails = 0;
let ctx = null; // { getCameras, onEvent }
const pending = new Map(); // id notifica -> { timer }
const seen = new Map(); // id notifica -> istante (per non contare due volte la stessa)
const state = { running: false, connected: false, registered: false, lastMessageAt: 0, lastError: '' };

export const available = () => fs.existsSync(SCRIPT) && fs.existsSync(path.join(TOOL_DIR, 'node_modules')) && fs.existsSync(SESSION);
export const status = () => ({ ...state });
/** Vero se le notifiche arrivano davvero: in tal caso non serve indovinare il movimento dal video. */
export const isActive = () => state.running && state.connected && state.registered;

// Tipo di evento Eufy (event_type) -> tipo di evento di Argo.
const KIND = { 3101: 'motion', 3102: 'person', 3103: 'visitor', 3106: 'pet', 3107: 'vehicle', 3108: 'pet' };
export const kindOf = (eventType) => KIND[Number(eventType)] || null;

const camOf = (m) => ctx.getCameras().find((c) => c.brand === 'eufyp2p' && [m.deviceSn, m.stationSn].includes(c.params?.serial));

async function deliver(m) {
  const cam = camOf(m);
  const kind = kindOf(m.eventType);
  if (!cam || !kind) return;
  const jpg = m.pic ? Buffer.from(m.pic, 'base64') : null;
  if (m.hasPic && !jpg) console.error(`[eufy-push] anteprima di «${m.name}» non disponibile (${m.picErr || "motivo sconosciuto"})`);
  ctx.onEvent(cam, kind, { jpg, meta: { source: 'eufy-push', eufy: { type: m.eventType, title: m.title } } });
}

function onMessage(m) {
  state.lastMessageAt = Date.now();
  if (!m.hasPic) console.log(`[eufy-push] «${m.name}»: ${m.content || m.title} (evento ${m.eventType}${camOf(m) ? '' : ', telecamera non in elenco'}${kindOf(m.eventType) ? '' : ', tipo ignorato'})`);
  if (!m.id || !kindOf(m.eventType)) return;
  const now = Date.now();
  for (const [k, at] of seen) if (now - at > 120_000) seen.delete(k);
  const entry = pending.get(m.id);
  if (m.hasPic) { // arriva l'immagine: si consegna una sola volta
    if (entry) { clearTimeout(entry.timer); pending.delete(m.id); }
    if (seen.has(m.id)) return;
    seen.set(m.id, now);
    deliver(m);
    return;
  }
  if (entry || seen.has(m.id)) return;
  // Prima notifica senza immagine: si aspetta la seconda; se non arriva si consegna senza.
  pending.set(m.id, {
    timer: setTimeout(() => {
      pending.delete(m.id);
      if (seen.has(m.id)) return;
      seen.set(m.id, Date.now());
      deliver(m);
    }, PIC_WAIT_MS),
  });
}

function launch() {
  if (stopped || child) return;
  if (!available() || !ctx.getCameras().some((c) => c.brand === 'eufyp2p')) { timer = setTimeout(launch, 5 * 60_000); timer.unref?.(); return; }
  const p = spawn(process.execPath, [SCRIPT], { cwd: TOOL_DIR, env: { ...process.env, DATA_DIR: DATA }, stdio: ['pipe', 'pipe', 'ignore'] });
  child = p;
  state.running = true;
  const started = Date.now();
  let buf = '';
  let code = null;
  p.stdout.on('data', (b) => {
    buf += b;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('@@PUSH ')) continue;
      let ev;
      try { ev = JSON.parse(line.slice(7)); } catch { continue; }
      if (ev.t === 'msg') onMessage(ev);
      else if (ev.t === 'state') {
        state.connected = !!ev.connected;
        state.registered = ev.registered ?? state.registered;
        if (ev.connected) console.log(`[eufy-push] collegato alle notifiche Eufy${ev.registered ? '' : ' (registrazione non riuscita)'}`);
        ctx.onState?.();
      } else if (ev.t === 'exit') { code = ev.code; state.lastError = ev.msg || ''; }
    }
  });
  p.stdin.on('error', () => {});
  p.on('error', () => {});
  p.on('close', (c) => {
    child = null;
    state.running = false;
    state.connected = false;
    state.registered = false;
    ctx.onState?.();
    if (stopped) return;
    const exitCode = code ?? c;
    if (exitCode === 2) {
      console.error(`[eufy-push] ${state.lastError || 'serve rifare l’accesso Eufy'}: nuovo tentativo tra 10 minuti`);
      timer = setTimeout(launch, 10 * 60_000);
    } else {
      fails = Date.now() - started > 120_000 ? 0 : Math.min(fails + 1, RETRY_MS.length);
      timer = setTimeout(launch, RETRY_MS[Math.max(0, fails - 1)]);
    }
    timer.unref?.();
  });
}

/** `context`: { getCameras(), onEvent(cam, kind, { jpg, meta }), onState() }. */
export function start(context) {
  ctx = context;
  stopped = false;
  launch();
}

/** Riavvia subito (dopo un nuovo accesso Eufy). */
export function restart() {
  if (!ctx) return;
  clearTimeout(timer);
  fails = 0;
  if (child) { try { child.kill(); } catch { /* già chiuso */ } } else launch();
}

export function stop() {
  stopped = true;
  clearTimeout(timer);
  for (const e of pending.values()) clearTimeout(e.timer);
  pending.clear();
  try { child?.kill(); } catch { /* già chiuso */ }
}
