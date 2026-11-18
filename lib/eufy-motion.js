// Rilevamento del movimento per le telecamere Eufy locali (sempre accese).
//
// Le Eufy non mandano gli eventi in rete locale (arrivano solo dal cloud), quindi si guarda il video: ffmpeg legge il
// flusso secondario da go2rtc, lo riduce a un'immagine in grigio molto piccola e ne conta le differenze tra un
// fotogramma e l'altro. Se cambia una parte sufficiente dell'immagine per qualche fotogramma, scatta un "movimento"
// (poi il riconoscimento lo trasforma in persona/veicolo se li vede). Un cambio quasi totale (passaggio giorno/notte)
// non conta come movimento.
import { spawn } from 'node:child_process';

const W = 96;
const H = 54;
const FPS = 2;
const PIXEL_DIFF = 28;        // differenza di luminosità (0-255) per considerare cambiato un punto
const MOTION_RATIO = 0.012;   // parte dell'immagine che deve cambiare
const GLOBAL_RATIO = 0.45;    // oltre questa parte è un cambio di luce globale, non movimento
const NEED_FRAMES = 2;        // fotogrammi consecutivi con movimento
const RETRY_MS = [10_000, 30_000, 60_000];

const monitors = new Map(); // camId -> { proc, timer, stopped, fails }

const wanted = (cam) => cam.brand === 'eufyp2p' && !cam.battery && (cam.alerts !== false || cam.saveEvents !== false);

function watch(cam, raise) {
  const m = { cam, proc: null, timer: null, stopped: false, fails: 0, prev: null, run: 0, quietUntil: 0, started: 0 };
  monitors.set(cam.id, m);

  const launch = () => {
    if (m.stopped) return;
    m.started = Date.now();
    m.prev = null;
    m.run = 0;
    const args = [
      '-hide_banner', '-loglevel', 'error', '-rtsp_transport', 'tcp', '-i', `rtsp://127.0.0.1:8554/${cam.id}_sub`,
      '-an', '-vf', `fps=${FPS},scale=${W}:${H},format=gray`, '-f', 'rawvideo', '-',
    ];
    const p = spawn('ffmpeg', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    m.proc = p;
    let buf = Buffer.alloc(0);
    p.stdout.on('data', (chunk) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      while (buf.length >= W * H) {
        const frame = buf.subarray(0, W * H);
        buf = buf.subarray(W * H);
        analyse(m.cam, m, frame, raise);
      }
    });
    p.on('close', () => {
      m.proc = null;
      if (m.stopped) return;
      // Se ha funzionato a lungo si riparte presto; se fallisce di continuo si aspetta sempre di più.
      m.fails = Date.now() - m.started > 60_000 ? 0 : Math.min(m.fails + 1, RETRY_MS.length);
      m.timer = setTimeout(launch, RETRY_MS[Math.max(0, m.fails - 1)]);
    });
    p.on('error', () => { m.proc = null; });
  };
  launch();
}

function analyse(cam, m, frame, raise) {
  const cur = Buffer.from(frame); // copia: il buffer originale viene riusato
  const prev = m.prev;
  m.prev = cur;
  if (!prev || Date.now() < m.quietUntil) return;
  let changed = 0;
  for (let i = 0; i < cur.length; i++) if (Math.abs(cur[i] - prev[i]) > PIXEL_DIFF) changed++;
  const ratio = changed / cur.length;
  if (ratio > GLOBAL_RATIO) { m.run = 0; m.quietUntil = Date.now() + 8000; return; }
  if (ratio >= MOTION_RATIO) {
    if (++m.run >= NEED_FRAMES) {
      m.run = 0;
      raise(cam, 'motion'); // il tempo minimo tra due eventi lo decide l'impostazione "pausa tra eventi"
    }
  } else {
    m.run = 0;
  }
}

export const __test = { analyse, W, H };

/** Avvia o ferma i controlli in base alle telecamere attuali (da chiamare a ogni modifica). */
export function reconcile(cameras, raise) {
  const ids = new Set();
  for (const cam of cameras) {
    if (!wanted(cam)) continue;
    ids.add(cam.id);
    if (monitors.has(cam.id)) monitors.get(cam.id).cam = cam; // nome e impostazioni aggiornati
    else watch(cam, raise);
  }
  for (const [id, m] of monitors) {
    if (ids.has(id)) continue;
    m.stopped = true;
    clearTimeout(m.timer);
    try { m.proc?.kill(); } catch { /* già chiuso */ }
    monitors.delete(id);
  }
}

export function stopAll() {
  for (const m of monitors.values()) {
    m.stopped = true;
    clearTimeout(m.timer);
    try { m.proc?.kill(); } catch { /* già chiuso */ }
  }
  monitors.clear();
}
