// Riceve le notifiche push di Eufy (le stesse che l'app Eufy mostra sul telefono: "Someone has been spotted", ecc.)
// e le passa ad Argo, una per riga JSON su stdout, con il prefisso "@@PUSH ".
//   node push.mjs            (lo avvia l'app; usa la sessione salvata da login.mjs / dall'accesso in Impostazioni)
// Uscita: 0 = chiuso, 2 = serve rifare l'accesso Eufy (sessione assente o scaduta), 1 = altro errore.
// Non stampa segreti. Le credenziali push (token Google/Firebase della "installazione") stanno cifrate in eufy-push.json.
import { HTTPApi } from 'eufy-security-client';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as secrets from '../../lib/secrets.js';

const DATA = path.resolve(process.env.DATA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data'));
const SESSION = path.join(DATA, 'eufy-session.json');
const STORE = path.join(DATA, 'eufy-push.json');
const out = (obj) => process.stdout.write(`@@PUSH ${JSON.stringify(obj)}\n`);
const fail = (code, msg) => { out({ t: 'exit', code, msg }); setTimeout(() => process.exit(code), 100); };

let session;
try { session = secrets.readSecretFile(SESSION)?.data; } catch (e) { fail(1, e.message); }
if (!session?.token) fail(2, 'Sessione Eufy mancante: esegui l’accesso Eufy');
else if (session.tokenExpiration && Date.now() >= session.tokenExpiration) fail(2, 'Sessione Eufy scaduta');
else await run();

async function run() {
  const api = await HTTPApi.initialize(session.country || 'IT', 'sessione', 'non-usata', session.persistentData);
  api.setToken(session.token);
  if (session.tokenExpiration) api.setTokenExpiration(new Date(session.tokenExpiration));
  api.on('captcha request', () => fail(2, 'Eufy chiede un captcha'));
  api.on('tfa request', () => fail(2, 'Eufy chiede un codice di verifica'));

  // Il servizio push sta nella libreria ma non è esportato dall'indice: si carica dal suo file.
  const base = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.resolve('eufy-security-client'))), 'push', 'service.js')).href;
  const { PushNotificationService } = await import(base);
  const push = await PushNotificationService.initialize();

  let store = {};
  try { store = secrets.readSecretFile(STORE)?.data || {}; } catch { store = {}; }
  if (store.credentials) { push.setCredentials(store.credentials); push.setPersistentIds(store.persistentIds || []); }
  let saveTimer = null;
  const save = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { secrets.writeSecretFile(STORE, { credentials: push.getCredentials(), persistentIds: push.getPersistentIds().slice(-200) }); } catch { /* disco non scrivibile */ }
    }, 2000);
  };

  push.on('credential', save);
  push.on('connect', async (token) => {
    try {
      const r = await api.request({ method: 'post', endpoint: 'v1/apppush/register_push_token', data: { is_notification_enable: true, token, transaction: String(Date.now()) } });
      const code = r.data?.code;
      if (code === 26006 || code === 26052 || r.status === 401) return fail(2, `Sessione Eufy rifiutata (codice ${code})`);
      out({ t: 'state', connected: true, registered: code === 0 });
    } catch (e) {
      if (/401|403/.test(String(e.response?.statusCode || e.response?.status || ''))) return fail(2, 'Sessione Eufy rifiutata');
      out({ t: 'state', connected: true, registered: false, msg: e.message });
    }
  });
  push.on('close', () => out({ t: 'state', connected: false }));
  // L'anteprima si scarica con il token dell'account e arriva cifrata (i primi 256 byte): si decifra con l'identificativo
  // P2P della stazione, come fa l'app Eufy. A Argo arriva già pronta (base64).
  const libDir = path.dirname(fileURLToPath(import.meta.resolve('eufy-security-client')));
  const { decodeImage } = await import(pathToFileURL(path.join(libDir, 'http', 'utils.js')).href);
  let cloud = null;
  try { cloud = secrets.readSecretFile(path.join(DATA, 'eufy-cloud.json'))?.data; } catch { cloud = null; }
  const fetchPic = async (m) => {
    const did = cloud?.stations?.[m.station_sn]?.did || cloud?.stations?.[m.device_sn]?.did;
    if (!did || !m.pic_url) throw new Error(did ? 'senza immagine' : 'identificativo P2P non trovato per ' + (m.station_sn || m.device_sn));
    const r = await api.request({ method: 'GET', endpoint: m.pic_url, responseType: 'buffer' }, true);
    if (r.status !== 200) throw new Error('HTTP ' + r.status);
    const img = decodeImage(did, Buffer.from(r.data));
    if (!(img.length > 500 && img[0] === 0xff && img[1] === 0xd8)) throw new Error('formato inatteso (' + img.length + ' byte, inizio ' + img.subarray(0, 4).toString('hex') + ')');
    return img.toString('base64');
  };

  push.on('message', async (m) => {
    save();
    let pic = null, picErr = '';
    if (m.pic_url) { try { pic = await fetchPic(m); } catch (e) { picErr = e.message; } }
    out({
      t: 'msg', name: m.name, title: m.title, content: m.content, type: m.type, eventType: m.event_type, msgType: m.msg_type,
      deviceSn: m.device_sn, stationSn: m.station_sn, eventTime: m.event_time, hasPic: !!m.pic_url, pic, picErr, pushCount: m.push_count, id: m.unique_id,
      session: m.event_session, filePath: m.file_path,
    });
  });
  await push.open();
  process.on('SIGTERM', () => { push.close(); process.exit(0); });
  process.stdin.resume(); // resta attivo finché l'app non lo chiude
  process.stdin.on('end', () => { push.close(); process.exit(0); });
}
