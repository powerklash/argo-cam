// Impostazioni dell'app (data/settings.json). La lingua e i dispositivi audio sono
// preferenze del singolo browser e stanno in localStorage, non qui.
import fs from 'node:fs';
import path from 'node:path';
import { DATA } from './paths.js';

const FILE = path.join(DATA, 'settings.json');

export const EVENT_KINDS = ['person', 'vehicle', 'pet', 'face', 'package', 'motion', 'visitor', 'fire', 'flood'];
export const HAZARD_KINDS = ['fire', 'flood'];
const FLASH_KINDS = ['person', 'vehicle', 'pet', 'face', 'package', 'motion'];

const DEFAULTS = {
  wakeLimit: 60, // secondi di sveglia per le telecamere a batteria (0 = nessun limite)
  flash: { kinds: ['person'], motionFallback: true },
  events: { enabled: true, snapshot: true, clipSeconds: 10, retentionDays: 30, cooldown: 20 },
  doorbell: { popup: true, notify: true, chime: true, autoCloseSeconds: 90 },
  recognition: { faces: false, vehicles: false, pets: false, vehicleIds: false, suggest: true, boxes: true, faceThreshold: 0.363, petThreshold: 0.82, vehicleThreshold: 0.85 },
  // Allerta incendio / allagamento: per telecamera (cams[idTelecamera] = { fire, flood }); sensibilità 1 (bassa) - 3 (alta).
  hazard: { cams: {}, sensitivity: 2 },
};

const num = (v, min, max, def) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : def;
};
const bool = (v, def) => (typeof v === 'boolean' ? v : def);

function sanitizeHazardCams(input, base) {
  if (!input || typeof input !== 'object') return base;
  const out = {};
  for (const [id, v] of Object.entries(input)) {
    if (!/^[\w-]{1,64}$/.test(id) || !v || typeof v !== 'object') continue;
    const e = { fire: v.fire === true, flood: v.flood === true };
    if (e.fire || e.flood) out[id] = e;
  }
  return out;
}

/** Valida un oggetto di impostazioni (anche parziale) e lo completa con i valori correnti. */
function sanitize(input, base) {
  const i = input || {};
  const b = base;
  return {
    wakeLimit: num(i.wakeLimit, 0, 3600, b.wakeLimit),
    flash: {
      kinds: Array.isArray(i.flash?.kinds) ? i.flash.kinds.filter((k) => FLASH_KINDS.includes(k)) : b.flash.kinds,
      motionFallback: bool(i.flash?.motionFallback, b.flash.motionFallback),
    },
    events: {
      enabled: bool(i.events?.enabled, b.events.enabled),
      snapshot: bool(i.events?.snapshot, b.events.snapshot),
      clipSeconds: num(i.events?.clipSeconds, 0, 120, b.events.clipSeconds),
      retentionDays: num(i.events?.retentionDays, 0, 3650, b.events.retentionDays),
      cooldown: num(i.events?.cooldown, 0, 600, b.events.cooldown),
    },
    doorbell: {
      popup: bool(i.doorbell?.popup, b.doorbell.popup),
      notify: bool(i.doorbell?.notify, b.doorbell.notify),
      chime: bool(i.doorbell?.chime, b.doorbell.chime),
      autoCloseSeconds: num(i.doorbell?.autoCloseSeconds, 0, 3600, b.doorbell.autoCloseSeconds),
    },
    recognition: {
      faces: bool(i.recognition?.faces, b.recognition.faces),
      vehicles: bool(i.recognition?.vehicles, b.recognition.vehicles),
      pets: bool(i.recognition?.pets, b.recognition.pets),
      faceThreshold: Math.max(0.1, Math.min(0.9, Number(i.recognition?.faceThreshold) || b.recognition.faceThreshold)),
      petThreshold: Math.max(0.5, Math.min(0.97, Number(i.recognition?.petThreshold) || b.recognition.petThreshold)),
      vehicleIds: bool(i.recognition?.vehicleIds, b.recognition.vehicleIds),
      suggest: bool(i.recognition?.suggest, b.recognition.suggest),
      boxes: bool(i.recognition?.boxes, b.recognition.boxes),
      vehicleThreshold: Math.max(0.5, Math.min(0.99, Number(i.recognition?.vehicleThreshold) || b.recognition.vehicleThreshold)),
    },
    hazard: {
      cams: sanitizeHazardCams(i.hazard?.cams, b.hazard.cams),
      sensitivity: num(i.hazard?.sensitivity, 1, 3, b.hazard.sensitivity),
    },
  };
}

let current = structuredClone(DEFAULTS);
try {
  current = sanitize(JSON.parse(fs.readFileSync(FILE, 'utf8')), DEFAULTS);
} catch {
  /* primo avvio: valori predefiniti */
}

const listeners = new Set();
export const getSettings = () => current;
export const onSettings = (fn) => listeners.add(fn);

export function updateSettings(patch) {
  current = sanitize(patch, current);
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(current, null, 2));
  for (const fn of listeners) fn(current);
  return current;
}
