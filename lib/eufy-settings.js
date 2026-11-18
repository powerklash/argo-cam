// Impostazioni delle telecamere Eufy tramite il protocollo P2P locale (nessun cloud).
//
// Lettura: CMD_CAMERA_INFO restituisce tutti i parametri della telecamera come
// [{ param_type, param_value }]. Scrittura: comando "doorbell payload" (1700, cifrato)
// con { commandType, data }. Le forme dei comandi sono quelle di eufy-security-client.
//
// Ogni modello ha comandi propri: finora è verificato solo il profilo Wall Light Cam (T84A1).
import * as eufy from './eufy.js';

const bool = (v) => v === '1' || v === 1 || v === true;
const flag = (v) => (v ? 1 : 0);

const WALL_LIGHT = {
  model: 'Wall Light Cam S100',
  fields: [
    { key: 'light', param: 1400, type: 'bool', read: bool, data: (v) => ({ value: flag(v) }) },
    { key: 'led', param: 1045, type: 'bool', read: bool, data: flag },
    { key: 'motion', param: 6040, type: 'bool', read: bool, data: flag },
    { key: 'human', param: 6330, type: 'bool', read: bool, data: flag },
    { key: 'otherMotion', param: 6332, type: 'bool', read: bool, data: flag },
    { key: 'audio', param: 1288, type: 'bool', read: bool, data: flag },
    { key: 'watermark', param: 1214, type: 'bool', read: bool, data: flag },
    { key: 'speaker', param: 6342, type: 'select', options: [1, 2, 3], read: Number, data: Number },
    { key: 'streamQuality', param: 1205, type: 'select', options: [0, 1, 2, 3], read: Number, data: Number },
    { key: 'recordQuality', param: 1286, type: 'select', options: [2, 3], read: Number, data: Number },
  ],
};

const PROFILES = [['T84A1', WALL_LIGHT]];
const profileOf = (serial) => PROFILES.find(([prefix]) => String(serial).startsWith(prefix))?.[1] || null;

function toFields(profile, params) {
  const byType = new Map(params.map((p) => [Number(p.param_type), p.param_value]));
  return profile.fields
    .filter((f) => byType.has(f.param))
    .map((f) => ({ key: f.key, type: f.type, options: f.options, value: f.read(byType.get(f.param)) }));
}

async function readInfo(session) {
  const info = await session.cameraInfo();
  return { params: info.params || [], firmware: info.main_sw_version || '' };
}

/** Impostazioni attuali (lette dalla telecamera) e relativi controlli. */
export async function getSettings(cam) {
  const profile = profileOf(cam.params.serial);
  if (!profile) return { supported: false, model: '', fields: [] };
  const { params, firmware } = await eufy.withSession(cam, readInfo);
  return { supported: true, model: profile.model, firmware, fields: toFields(profile, params) };
}

/** Applica un'impostazione e restituisce i valori riletti dalla telecamera. */
export async function setSetting(cam, key, value) {
  const profile = profileOf(cam.params.serial);
  const field = profile?.fields.find((f) => f.key === key);
  if (!field) throw new Error('Impostazione non supportata da questo modello');
  if (field.type === 'select' && !field.options.includes(Number(value))) throw new Error('Valore non valido');
  const v = field.type === 'bool' ? !!value : Number(value);
  return eufy.withSession(cam, async (session) => {
    const { code } = await session.setParam(field.param, field.data(v));
    if (code !== 0) throw new Error(`La telecamera ha rifiutato la modifica (codice ${code ?? 'nessuna risposta'})`);
    await new Promise((r) => setTimeout(r, 700)); // la telecamera aggiorna i parametri un attimo dopo
    const { params, firmware } = await readInfo(session);
    return { supported: true, model: profile.model, firmware, fields: toFields(profile, params) };
  });
}
