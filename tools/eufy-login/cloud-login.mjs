// Accesso al cloud Eufy NON interattivo, per la finestra Impostazioni dell'app (lo avvia lib/eufy-login.js).
// Parla con l'app a righe JSON: l'app scrive su stdin, questo script risponde su stdout con righe "@@EV {json}".
//   stdin : {"cmd":"login","country":"IT","email":"...","password":"...","keepSession":true}
//           {"cmd":"captcha","code":"..."}   {"cmd":"verify","code":"..."}
//   stdout: {"event":"captcha","image":"data:..."} | {"event":"verify"} | {"event":"done",...} | {"event":"error","code":"..."}
// Le credenziali arrivano solo da stdin, non si scrivono su disco né nel log. Il risultato è quello di login.mjs
// (eufy-account.json, eufy-cloud.json e, se richiesta, eufy-session.json) in <DATA_DIR>.
import { HTTPApi } from 'eufy-security-client';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const DATA = path.resolve(process.env.DATA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data'));
const emit = (o) => process.stdout.write(`@@EV ${JSON.stringify(o)}\n`);
const finish = (o, code) => new Promise(() => process.stdout.write(`@@EV ${JSON.stringify(o)}\n`, () => process.exit(code))); // non ritorna mai: il codice sotto non prosegue

const queue = [];
let waiter = null;
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (waiter) { const w = waiter; waiter = null; w(m); } else queue.push(m);
});
rl.on('close', () => process.exit(1));
const next = () => new Promise((resolve) => (queue.length ? resolve(queue.shift()) : (waiter = resolve)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const decodeCloudIps = (data) => { // stesso schema di eufy-security-client (decodeP2PCloudIPs)
  const table = Buffer.from('4959433db5bf6da347534f6165e371e9677f02030badb3892b2f35c16b8b959711e5a70deff1050783fb9d3bc5c713171d1f2529d3df', 'hex');
  const encoded = data.split(':')[0];
  const out = Buffer.alloc(encoded.length / 2);
  for (let i = 0; i < out.length; i++) {
    let z = 0x39;
    for (let j = 0; j < i; j++) z ^= out[j];
    out[i] = z ^ table[i % table.length] ^ ((data.charCodeAt(i * 2 + 1) - 65) + (data.charCodeAt(i * 2) - 65) * 16);
  }
  return out.toString('utf8').split(',').filter(Boolean);
};
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const writeJson = (file, obj) => fs.writeFileSync(file, JSON.stringify(obj, null, 2), { mode: 0o600 });

const first = await next();
if (first?.cmd !== 'login') await finish({ event: 'error', code: 'protocol' }, 1);
const country = String(first.country || 'IT').toUpperCase().slice(0, 2);
const email = String(first.email || '');
const password = String(first.password || '');
if (!email || !password) await finish({ event: 'error', code: 'credentials' }, 1);

let api;
try { api = await HTTPApi.initialize(country, email, password); } catch { await finish({ event: 'error', code: 'network' }, 1); }

let captchaId, captchaItem, tfaRequested;
api.on('captcha request', (id, item) => { captchaId = id; captchaItem = item; });
api.on('tfa request', () => { tfaRequested = true; });
const persistent = () => (api.getPersistentData ? api.getPersistentData() : api.persistentData) || {};

let captcha, verifyCode;
for (let attempt = 0; attempt < 6 && !persistent().user_id; attempt++) {
  captchaItem = undefined; tfaRequested = false;
  try { await api.login({ captcha, verifyCode }); } catch { /* si valuta sotto */ }
  captcha = undefined; verifyCode = undefined;
  await sleep(400); // lascia scattare gli eventi
  if (persistent().user_id) break;
  if (captchaItem) {
    const b64 = captchaItem.includes(',') ? captchaItem.split(',')[1] : captchaItem;
    emit({ event: 'captcha', image: `data:image/png;base64,${b64}` });
    const m = await next();
    if (m?.cmd !== 'captcha') await finish({ event: 'error', code: 'protocol' }, 1);
    captcha = { captchaId, captchaCode: String(m.code || '').trim() };
  } else if (tfaRequested) {
    emit({ event: 'verify' });
    const m = await next();
    if (m?.cmd !== 'verify') await finish({ event: 'error', code: 'protocol' }, 1);
    verifyCode = String(m.code || '').trim();
  } else {
    break;
  }
}
const accountId = persistent().user_id;
if (!accountId) await finish({ event: 'error', code: 'login_failed' }, 1);

let stations;
try { stations = await api.getStationList(); } catch { await finish({ event: 'error', code: 'network' }, 1); }

// eufy-cloud.json: server P2P e chiave di sveglia di ogni stazione
const cloud = { fetchedAt: Date.now(), stations: {} };
for (const st of stations) {
  const sn = st.station_sn;
  const entry = { did: st.p2p_did, servers: [], dsk: null, dskExpires: null };
  try { entry.servers = decodeCloudIps(String(st.app_conn || '')); } catch { /* resta vuoto */ }
  try {
    const r = await api.request({ method: 'post', endpoint: 'v1/app/equipment/get_dsk_keys', data: { invalid_dsks: { [sn]: '' }, station_sns: [sn], transaction: `${Date.now()}` } });
    const k = r.data?.data?.dsk_keys?.find((x) => x.station_sn === sn);
    if (k?.dsk_key) { entry.dsk = k.dsk_key; entry.dskExpires = Number(k.expiration) * 1000; }
  } catch { /* la sveglia dal cloud non sarà disponibile per questa stazione */ }
  cloud.stations[sn] = entry;
}

// eufy-account.json: si aggiorna senza perdere cipherID e chiavi già lette (login.mjs con EUFY_CIPHERS)
fs.mkdirSync(DATA, { recursive: true });
const account = readJson(path.join(DATA, 'eufy-account.json')) || { cameras: {} };
account.accountId = accountId;
account.cameras = account.cameras || {};
for (const st of stations) {
  const old = account.cameras[st.station_sn] || {};
  account.cameras[st.station_sn] = { did: st.p2p_did, cipherId: old.cipherId ?? null, privateKey: old.privateKey ?? null, name: st.station_name || old.name || null };
}
writeJson(path.join(DATA, 'eufy-account.json'), account);
writeJson(path.join(DATA, 'eufy-cloud.json'), cloud);

// Sessione di rinnovo (token, non la password): serve a rinnovare da soli la chiave di sveglia (dura ~30 minuti)
const exp = api.getTokenExpiration ? api.getTokenExpiration() : null;
if (first.keepSession !== false) {
  writeJson(path.join(DATA, 'eufy-session.json'), { country, token: api.getToken ? api.getToken() : api.token, tokenExpiration: exp ? exp.getTime() : null, persistentData: persistent() });
}
await finish({
  event: 'done',
  stations: stations.map((st) => ({ serial: st.station_sn, name: st.station_name || null, wake: !!cloud.stations[st.station_sn].dsk })),
  tokenExpires: first.keepSession !== false && exp ? exp.getTime() : null,
}, 0);
