// Modalità privacy delle telecamere Reolink (protocollo Baichuan, vedi baichuan.js).
// Lo stato si rilegge ogni 15 s (anche quando cambia dall'app Reolink o da Home Assistant) e ogni
// variazione arriva subito all'interfaccia. Le telecamere senza privacy si ricontrollano di rado.
import * as bc from './baichuan.js';
import { bus } from './events.js';

const POLL_MS = 15_000;
const RECHECK_UNSUPPORTED_MS = 10 * 60_000;
const state = new Map(); // camId -> { supported, on, checked }

export const get = (id) => {
  const s = state.get(id);
  return s ? { supported: s.supported, on: s.on } : null;
};

function update(cam, supported, on) {
  const prev = state.get(cam.id);
  state.set(cam.id, { supported, on, checked: Date.now() });
  if (!prev || prev.supported !== supported || prev.on !== on) bus.emit('privacy', { camId: cam.id, supported, on });
}

async function read(cam) {
  try {
    return await bc.getPrivacy(cam);
  } catch (err) {
    if (/sospeso|rifiutato/.test(err.message)) throw err;
    return bc.getPrivacy(cam); // un solo nuovo tentativo: l'hub a volte salta una risposta
  }
}

async function poll(getCameras) {
  for (const cam of getCameras()) {
    if (cam.brand !== 'reolink' || !cam.params?.host) continue;
    const prev = state.get(cam.id);
    if (prev && !prev.supported && Date.now() - prev.checked < RECHECK_UNSUPPORTED_MS) continue;
    try {
      const v = await read(cam);
      update(cam, v !== null, v === true);
    } catch (err) {
      if (/sospeso|rifiutato/.test(err.message)) break; // accesso rifiutato: si salta questo giro
    }
  }
}

export function start(getCameras) {
  const loop = async () => {
    try { await poll(getCameras); } finally { setTimeout(loop, POLL_MS).unref?.(); }
  };
  setTimeout(loop, 4000).unref?.();
}

/** Attiva/disattiva la privacy e restituisce lo stato riletto dalla telecamera. */
export async function set(cam, enable) {
  const on = await bc.setPrivacy(cam, !!enable);
  update(cam, true, on);
  return { supported: true, on };
}

export const forget = (id) => state.delete(id);
