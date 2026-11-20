// Registrazioni salvate sull'hub (o sulla scheda) Reolink: entrano nell'elenco degli eventi di Argo.
//
// Ogni telecamera Reolink viene interrogata ogni 10 minuti (Search): per ogni registrazione nuova si scarica la versione
// leggera (flusso secondario, pochi MB) nel CT e nasce un evento "da hub Reolink", con immagine, riconoscimento e
// anteprima come gli altri. Se Argo ha già un evento della stessa telecamera nello stesso momento, non se ne crea un
// secondo: si annota solo che l'hub ne ha una copia (e il filmato originale resta scaricabile dall'hub).
import * as reolink from './reolink.js';
import * as db from './db.js';

const EVERY_MS = 10 * 60_000;
const FIRST_MS = 90_000;
const BACKFILL_MS = 24 * 3600_000; // la prima volta si guarda un giorno indietro
const MAX_PER_CYCLE = 12;
const MIN_MS = 4000;       // registrazioni più brevi sono ignorate
const SLACK_MS = 25_000;   // tolleranza per riconoscere lo stesso momento di un evento di Argo
let ctx = null;
let timer = null;
let running = false;
const since = new Map(); // camId -> fine dell'ultima registrazione vista
export const state = { lastRun: 0, imported: 0, linked: 0, lastError: '' };

const wanted = (c) => c.brand === 'reolink' && c.params?.host && c.saveEvents !== false;

async function cycle() {
  if (running) return;
  running = true;
  let budget = MAX_PER_CYCLE;
  try {
    for (const cam of ctx.getCameras().filter(wanted)) {
      if (budget <= 0) break;
      try {
        const now = new Date();
        const from = new Date(Math.max(now.getTime() - BACKFILL_MS, (since.get(cam.id) || 0) - 15 * 60_000));
        const subs = await reolink.searchFiles(cam, from, now, 'sub');
        if (!subs.length) continue;
        const mains = await reolink.searchFiles(cam, from, now, 'main').catch(() => []);
        const mainOf = (s) => mains.find((m) => Math.abs(m.start - s.start) <= 3000)?.name || null;
        since.set(cam.id, Math.max(...subs.map((s) => s.end)));
        for (const s of subs.reverse()) { // dalla più vecchia
          if (budget <= 0) break;
          if (s.end - s.start < MIN_MS || db.hubSeen(s.name)) continue;
          const hub = { hubName: s.name, hubMain: mainOf(s), hubEnd: s.end, hubSize: s.size };
          const same = db.eventsBetween(cam.id, s.start - SLACK_MS, s.end + SLACK_MS);
          if (same.length) { // già c'è un evento di Argo di quel momento: si collega e basta
            const e = same[0];
            db.updateEvent(e.id, { meta: { ...(e.meta || {}), ...hub, hubLinked: true } });
            state.linked++;
            continue;
          }
          budget--;
          await ctx.importClip(cam, {
            ts: s.start,
            meta: { source: 'reolink-hub', ...hub },
            download: (dest) => reolink.downloadFile(cam, s.name, dest, 120_000_000),
          });
          state.imported++;
        }
      } catch (err) {
        state.lastError = `${cam.name}: ${err.message}`;
        if (/Accesso rifiutato/.test(err.message)) continue;
      }
    }
  } finally {
    state.lastRun = Date.now();
    running = false;
  }
}

/** `context`: { getCameras(), importClip(cam, { ts, meta, download }) }. */
export function start(context) {
  ctx = context;
  clearTimeout(timer);
  const tick = () => { cycle().catch((err) => console.error(`[hub] ${err.message}`)).finally(() => { timer = setTimeout(tick, EVERY_MS); timer.unref?.(); }); };
  timer = setTimeout(tick, FIRST_MS);
  timer.unref?.();
}

export const stop = () => clearTimeout(timer);
