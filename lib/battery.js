// Ultimo livello di batteria noto delle telecamere a batteria, conservato anche a riavvio e con la telecamera offline,
// così si vede subito se è scarica. Reolink: lo legge l'hub (GetBatteryInfo, senza svegliare la telecamera).
// Eufy: si aggiorna quando la telecamera apre una sessione (parametro 1101).
import fs from 'node:fs';
import path from 'node:path';
import * as reolink from './reolink.js';
import { DATA } from './paths.js';

const FILE = path.join(DATA, 'battery.json');
let data = {};
try { data = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { /* ancora nessun dato */ }

let saveTimer = null;
const save = () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { try { fs.writeFileSync(FILE, JSON.stringify(data)); } catch { /* facoltativo */ } }, 1000);
};

export const get = (id) => data[id] || null;
export const all = () => data;

export function set(id, rec) {
  data[id] = { ...(data[id] || {}), ...rec, ts: Date.now() };
  save();
}

/** Da CMD_CAMERA_INFO di una Eufy (parametro 1101 = percentuale). */
export function fromEufyInfo(cam, info) {
  const p = (info?.params || []).find((x) => Number(x.param_type) === 1101);
  const percent = Number(p?.param_value);
  if (Number.isFinite(percent) && percent >= 0 && percent <= 100) set(cam.id, { percent, online: true });
}

async function pollReolink(cams) {
  const seen = new Map();
  for (const cam of cams) {
    try {
      const ch = (cam.params.channel || 1) - 1;
      const [b] = await reolink.call(cam, [{ cmd: 'GetBatteryInfo', action: 0, param: { channel: ch } }]);
      const v = b?.value?.Battery;
      if (!v || !Number.isFinite(v.batteryPercent)) continue;
      const key = reolink.sessionKey(cam);
      if (!seen.has(key)) {
        // Stato dei canali dell'hub: una telecamera scarica o fuori portata risulta offline.
        const [st] = await reolink.call(cam, [{ cmd: 'GetChannelstatus', action: 0, param: {} }]).catch(() => []);
        seen.set(key, st?.value?.status || []);
      }
      const ch2 = seen.get(key).find((s) => s.channel === ch);
      set(cam.id, { percent: v.batteryPercent, charging: v.chargeStatus === 1, online: ch2 ? ch2.online === 1 : undefined });
    } catch { /* hub non raggiungibile: resta l'ultimo valore noto */ }
  }
}

export function start(getCameras) {
  const run = () => pollReolink(getCameras().filter((c) => c.brand === 'reolink' && c.battery)).catch(() => {});
  setTimeout(run, 20_000).unref();
  setInterval(run, 5 * 60_000).unref();
}
