// Accesso al cloud Eufy dalla finestra Impostazioni (al posto del terminale).
//
// Avvia tools/eufy-login/cloud-login.mjs, che parla a righe JSON: le credenziali digitate dall'utente passano solo da
// stdin a quel processo (e da lì a Eufy), non si scrivono su disco né nel log. Il risultato sono gli stessi file di
// login.mjs: eufy-account.json, eufy-cloud.json e, se richiesto, eufy-session.json (token, non la password).
// Un solo accesso alla volta; se l'utente non completa captcha/codice entro 5 minuti il processo viene chiuso.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DATA, ROOT } from './paths.js';

const TOOL_DIR = path.join(ROOT, 'tools', 'eufy-login');
const SCRIPT = path.join(TOOL_DIR, 'cloud-login.mjs');
const IDLE_MS = 5 * 60 * 1000;
const STEP_TIMEOUT_MS = 120 * 1000;

/** Vero se lo strumento è installato (cartella tools/eufy-login con le sue librerie). */
export const available = () => fs.existsSync(SCRIPT) && fs.existsSync(path.join(TOOL_DIR, 'node_modules'));

let job = null; // { child, queue, waiter, idle, closed }

function kill() {
  if (!job) return;
  clearTimeout(job.idle);
  try { job.child.kill(); } catch { /* già chiuso */ }
  job = null;
}

function spawnJob() {
  const child = spawn(process.execPath, [SCRIPT], { cwd: TOOL_DIR, env: { ...process.env, DATA_DIR: DATA }, stdio: ['pipe', 'pipe', 'ignore'] });
  const j = { child, queue: [], waiter: null, idle: null, closed: false, buf: '' };
  const push = (ev) => { if (j.waiter) { const w = j.waiter; j.waiter = null; w(ev); } else j.queue.push(ev); };
  child.stdout.on('data', (b) => {
    j.buf += b;
    let i;
    while ((i = j.buf.indexOf('\n')) >= 0) {
      const line = j.buf.slice(0, i).trim();
      j.buf = j.buf.slice(i + 1);
      if (!line.startsWith('@@EV ')) continue; // altro testo della libreria: ignorato
      try { push(JSON.parse(line.slice(5))); } catch { /* riga non valida */ }
    }
  });
  child.stdin.on('error', () => {});
  child.on('error', () => { j.closed = true; push({ event: 'error', code: 'spawn' }); });
  child.on('close', () => { j.closed = true; push({ event: 'error', code: 'closed' }); });
  j.idle = setTimeout(() => { if (job === j) kill(); }, IDLE_MS);
  return j;
}

function nextEvent(j) {
  if (j.queue.length) return Promise.resolve(j.queue.shift());
  return new Promise((resolve) => {
    const timer = setTimeout(() => { j.waiter = null; resolve({ event: 'error', code: 'timeout' }); }, STEP_TIMEOUT_MS);
    j.waiter = (ev) => { clearTimeout(timer); resolve(ev); };
  });
}

const clean = (v, max) => String(v ?? '').slice(0, max);

/**
 * Un passo dell'accesso. `body`: { action: 'login', country, email, password, keepSession }
 * | { action: 'captcha', code } | { action: 'verify', code } | { action: 'cancel' }.
 * Risponde { status: 'captcha', image } | { status: 'verify' } | { status: 'done', stations, tokenExpires } | { status: 'error', code }.
 */
export async function step(body) {
  const action = body?.action;
  if (action === 'cancel') { kill(); return { status: 'cancelled' }; }
  if (!available()) return { status: 'error', code: 'unavailable' };
  if (action === 'login') {
    const email = clean(body.email, 254).trim();
    const password = clean(body.password, 256);
    if (!email || !password) return { status: 'error', code: 'credentials' };
    kill();
    job = spawnJob();
    const msg = { cmd: 'login', country: clean(body.country, 2).toUpperCase() || 'IT', email, password, keepSession: body.keepSession !== false };
    job.child.stdin.write(`${JSON.stringify(msg)}\n`);
  } else if (action === 'captcha' || action === 'verify') {
    if (!job || job.closed) return { status: 'error', code: 'expired' };
    job.child.stdin.write(`${JSON.stringify({ cmd: action, code: clean(body.code, 32).trim() })}\n`);
  } else {
    return { status: 'error', code: 'protocol' };
  }
  const j = job;
  const ev = await nextEvent(j);
  if (ev.event === 'captcha') return { status: 'captcha', image: ev.image };
  if (ev.event === 'verify') return { status: 'verify' };
  if (job === j) kill(); // fine (riuscita o no): il processo non serve più
  if (ev.event === 'done') return { status: 'done', stations: ev.stations || [], tokenExpires: ev.tokenExpires || null };
  return { status: 'error', code: ev.code || 'failed' };
}
