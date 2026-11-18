// Informazioni di connessione delle telecamere (indirizzo, rete, segnale) e riavvio, dove la telecamera lo permette.
//
//  - Reolink: LocalLink / WifiSignal / Wifi / DevInfo / Channelstatus. Una telecamera su hub o NVR non ha un proprio
//    segnale Wi-Fi leggibile: si mostra l'hub a cui è collegata. Il riavvio c'è solo per telecamere dirette
//    (su un hub riavvierebbe tutto l'hub e le telecamere collegate).
//  - Eufy: parametri della telecamera letti in locale (SSID, segnale in dBm). Quelle a batteria che dormono non
//    rispondono: si indica "a riposo" senza svegliarle.
// Le password (Wi-Fi, accesso) non vengono mai restituite.
import * as reolink from './reolink.js';
import * as eufy from './eufy.js';

const channelOf = (cam) => (cam.params.channel || 1) - 1;
const isHub = (dev) => (dev?.channelNum || 1) > 1 || /HUB|NVR/i.test(dev?.exactType || '');

async function reolinkInfo(cam) {
  const ch = channelOf(cam);
  const ask = (cmd) => ({ cmd, action: 0, param: { channel: ch } });
  const [link, sig, wifi, dev, chans] = await reolink.call(cam, ['GetLocalLink', 'GetWifiSignal', 'GetWifi', 'GetDevInfo', 'GetChannelstatus'].map(ask));
  const d = dev?.code === 0 ? dev.value?.DevInfo : null;
  const l = link?.code === 0 ? link.value?.LocalLink : null;
  const hub = isHub(d);
  const type = (l?.activeLink || '').toLowerCase().startsWith('wi') ? 'wifi' : l ? 'lan' : '';
  const info = {
    brand: 'reolink',
    ip: cam.params.host,
    mac: l?.mac || '',
    link: type,
    model: d?.model || '',
    firmware: d?.firmVer || '',
    canReboot: !hub && dev?.code === 0,
  };
  if (hub) {
    const st = chans?.code === 0 ? chans.value?.status?.find((s) => s.channel === ch) : null;
    info.hub = { name: d?.name || d?.model || 'Hub', online: st ? st.online === 1 : null, sleeping: st ? st.sleep === 1 : null };
  } else {
    if (type === 'wifi' && wifi?.code === 0) info.ssid = wifi.value?.Wifi?.ssid || '';
    if (type === 'wifi' && sig?.code === 0 && Number.isFinite(sig.value?.wifiSignal)) info.signal = { value: sig.value.wifiSignal, unit: '%' };
  }
  return info;
}

const param = (params, n) => (params || []).find((p) => Number(p.param_type) === n)?.param_value;

async function eufyInfo(cam) {
  const base = { brand: 'eufyp2p', ip: cam.params.host || '', serial: cam.params.serial, link: 'wifi', canReboot: false };
  if (cam.battery && !eufy.isActive(cam.id)) return { ...base, sleeping: true };
  const { host, info } = await eufy.withSession(cam, async (session) => ({ host: session.host, info: await session.cameraInfo() }));
  const rssi = Number(param(info.params, 1142));
  return {
    ...base,
    ip: host || base.ip,
    ssid: String(param(info.params, 6200) || ''),
    firmware: info.main_sw_version || '',
    ...(Number.isFinite(rssi) && rssi < 0 ? { signal: { value: rssi, unit: 'dBm' } } : {}),
  };
}

export function getInfo(cam) {
  if (cam.brand === 'reolink') return reolinkInfo(cam);
  if (cam.brand === 'eufyp2p') return eufyInfo(cam);
  return Promise.resolve({ brand: cam.brand, ip: cam.params?.host || '', link: '', canReboot: false });
}

/** Riavvia la telecamera (solo Reolink diretta). */
export async function reboot(cam) {
  if (cam.brand !== 'reolink') throw new Error('NOT_SUPPORTED');
  const info = await reolinkInfo(cam);
  if (!info.canReboot) throw new Error('NOT_SUPPORTED');
  const [r] = await reolink.call(cam, [{ cmd: 'Reboot', action: 0, param: {} }]);
  if (r?.code !== 0) throw new Error(`La telecamera ha rifiutato il riavvio (${r?.error?.detail || 'errore'})`);
  reolink.forgetSession(cam);
  return { ok: true };
}
