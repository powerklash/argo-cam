// Accesso UNA VOLTA al cloud Eufy per leggere i dati che servono all'uso locale:
//  - accountId (il tuo ID utente Eufy)
//  - per ogni telecamera, la chiave cifrario (private_key) legata al suo cipherID
//
// Le credenziali le digiti qui, nel tuo terminale: non vengono salvate e non escono
// da questo computer se non verso i server Eufy per l'accesso. Il risultato viene
// scritto in <DATA_DIR>/eufy-account.json (cartella data/ dell'app) e poi l'app lo usa in locale.
import { HTTPApi } from 'eufy-security-client';
import readline from 'node:readline';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as secrets from '../../lib/secrets.js'; // i file con segreti si salvano cifrati

// cipherID letti in locale dalle telecamere: seriale -> numero. Si passano con la variabile d'ambiente
// EUFY_CIPHERS, per esempio:  EUFY_CIPHERS="T84A1XXXXXXXXXXX=138,T8170XXXXXXXXXXX=90"
// (il cipherID si ricava dalla ricerca locale, vedi tools/eufy-discover.js). Le SoloCam a batteria vanno lette da sveglie.
const CIPHERS = Object.fromEntries(
  String(process.env.EUFY_CIPHERS || '').split(',').map((p) => p.trim().split('=')).filter((p) => p[0] && Number(p[1])).map(([k, v]) => [k, Number(v)]),
);
// Stessa cartella dati dell'app (DATA_DIR oppure ../../data rispetto a questo file).
const OUT = path.join(
  path.resolve(process.env.DATA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data')),
  'eufy-account.json',
);

function ask(query, hidden = false) {
  if (!hidden) {
    return new Promise((resolve) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question(query, (ans) => { rl.close(); resolve(ans.trim()); });
    });
  }
  // Password: mostra un asterisco per ogni carattere, così si vede che viene digitata.
  return new Promise((resolve) => {
    const input = process.stdin;
    const out = process.stdout;
    out.write(query);
    if (input.setRawMode) input.setRawMode(true);
    input.resume();
    let value = '';
    const onData = (buf) => {
      const ch = buf.toString('utf8');
      if (ch === '\r' || ch === '\n') {
        if (input.setRawMode) input.setRawMode(false);
        input.removeListener('data', onData);
        input.pause();
        out.write('\n');
        resolve(value.trim());
      } else if (ch === '\u0003') { // Ctrl+C
        out.write('\n');
        process.exit(1);
      } else if (ch === '\u007f' || ch === '\b') { // Backspace
        if (value.length) { value = value.slice(0, -1); out.write('\b \b'); }
      } else {
        for (const c of ch) { if (c >= ' ') { value += c; out.write('*'); } }
      }
    };
    input.on('data', onData);
  });
}

const country = ((await ask('Paese (2 lettere, invio = IT): ')) || 'IT').toUpperCase();
const email = await ask('Email Eufy: ');
const password = await ask('Password Eufy: ', true);

console.log('\nAccesso in corso…');
const api = await HTTPApi.initialize(country, email, password);

let captchaId, captchaItem, tfaRequested;
api.on('captcha request', (id, item) => { captchaId = id; captchaItem = item; });
api.on('tfa request', () => { tfaRequested = true; });

const persistent = () => (api.getPersistentData ? api.getPersistentData() : api.persistentData) || {};

let captcha, verifyCode, loggedIn = false;
for (let attempt = 0; attempt < 5 && !loggedIn; attempt++) {
  captchaItem = undefined; tfaRequested = false;
  try {
    await api.login({ captcha, verifyCode });
  } catch (e) {
    console.log('Errore di accesso:', e.message);
  }
  verifyCode = undefined; captcha = undefined;
  await new Promise((r) => setTimeout(r, 400)); // lascia scattare gli eventi

  if (persistent().user_id) { loggedIn = true; break; }
  if (captchaItem) {
    const b64 = captchaItem.includes(',') ? captchaItem.split(',')[1] : captchaItem;
    // Nella cartella temporanea e con nome nuovo ogni volta: così non si scontra con un'immagine rimasta aperta.
    const file = path.join(os.tmpdir(), `eufy-captcha-${Date.now()}.png`);
    fs.writeFileSync(file, Buffer.from(b64, 'base64'));
    console.log(`\nServe un captcha: apri l'immagine ${file} e leggi i caratteri.`);
    captcha = { captchaId, captchaCode: await ask('Captcha: ') };
  } else if (tfaRequested) {
    console.log('\nEufy ha inviato un codice di verifica (email/SMS).');
    verifyCode = await ask('Codice di verifica: ');
  } else {
    break;
  }
}

if (!loggedIn) {
  console.log('\nAccesso non riuscito. Controlla credenziali, paese ed eventuale codice.');
  process.exit(1);
}

const accountId = persistent().user_id;
console.log('\nAccesso riuscito. accountId letto.');

const stations = await api.getStationList();

// ---- Sveglia assistita dal cloud (telecamere a batteria) ----
// L'app Eufy sveglia le batterie facendo passare una richiesta dai server P2P Eufy. Per rifarlo l'app ha bisogno,
// per ogni stazione, dell'elenco dei server P2P e di una chiave temporanea (dsk) con la sua scadenza.
// Si salva in <DATA_DIR>/eufy-cloud.json: niente password né token di accesso.
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
const cloud = { fetchedAt: Date.now(), stations: {} };
for (const st of stations) {
  const sn = st.station_sn;
  const entry = { did: st.p2p_did, servers: [], dsk: null, dskExpires: null };
  try { entry.servers = decodeCloudIps(String(st.app_conn || '')); } catch (e) { console.log(`server P2P ${sn}: ${e.message}`); }
  try {
    const r = await api.request({ method: 'post', endpoint: 'v1/app/equipment/get_dsk_keys', data: { invalid_dsks: { [sn]: '' }, station_sns: [sn], transaction: `${Date.now()}` } });
    const k = r.data?.data?.dsk_keys?.find((x) => x.station_sn === sn);
    if (k?.dsk_key) { entry.dsk = k.dsk_key; entry.dskExpires = Number(k.expiration) * 1000; }
    else console.log(`chiave sveglia ${sn}: non ricevuta (codice ${r.data?.code} ${r.data?.msg || ''})`);
  } catch (e) {
    console.log(`chiave sveglia ${sn}: ${e.message}`);
  }
  cloud.stations[sn] = entry;
}
const CLOUD_OUT = path.join(path.dirname(OUT), 'eufy-cloud.json');
fs.mkdirSync(path.dirname(CLOUD_OUT), { recursive: true });
secrets.writeSecretFile(CLOUD_OUT, cloud, { pretty: true });
console.log('\nDati per la sveglia delle batterie salvati in:', CLOUD_OUT);
for (const [sn, c] of Object.entries(cloud.stations)) {
  const left = c.dskExpires ? Math.round((c.dskExpires - Date.now()) / 3600000) : null;
  console.log(`  ${sn}: server=${c.servers.length} chiave=${c.dsk ? 'ok' : 'no'}${left != null ? ` scade tra ${left} ore (${new Date(c.dskExpires).toLocaleString()})` : ''}`);
}
// Sessione per rinnovare da soli la chiave di sveglia (dura ~30 minuti): il token di accesso, NON la password.
// Resta in <DATA_DIR>/eufy-session.json (permessi 0600). Chi non la vuole: --no-session (la sveglia dal cloud
// funzionerà solo finché la chiave è valida). Si cancella il file per togliere l'accesso.
if (!process.argv.includes('--no-session')) {
  const SESSION_OUT = path.join(path.dirname(OUT), 'eufy-session.json');
  const exp = api.getTokenExpiration ? api.getTokenExpiration() : null;
  secrets.writeSecretFile(SESSION_OUT, { country, token: api.token || null, tokenExpiration: exp ? exp.getTime() : null, persistentData: persistent() }, { pretty: true });
  console.log(`Sessione di rinnovo salvata in: ${SESSION_OUT}${exp ? ` (valida fino al ${exp.toLocaleDateString()})` : ''}`);
}
if (process.argv.includes('--wake-only')) { // non tocca eufy-account.json (che ha già le chiavi dei cifrari)
  console.log('\nOperazione completata (solo dati di sveglia).');
  process.exit(0);
}

const result = { accountId, cameras: {} };
for (const st of stations) {
  const adminId = st.member?.admin_user_id || accountId;
  const cipherId = CIPHERS[st.station_sn];
  const entry = { did: st.p2p_did, cipherId: cipherId ?? null, privateKey: null };
  if (cipherId != null) {
    try {
      const cipher = await api.getCipher(cipherId, adminId);
      entry.privateKey = cipher?.private_key || null;
    } catch (e) {
      console.log(`cipher ${st.station_sn}: ${e.message}`);
    }
  }
  result.cameras[st.station_sn] = entry;
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
secrets.writeSecretFile(OUT, result, { pretty: true });

console.log('\nFatto. Salvato in:', OUT);
console.log('Riepilogo (senza segreti):');
console.log('  accountId:', accountId ? `${accountId.length} caratteri` : 'mancante');
for (const [sn, c] of Object.entries(result.cameras)) {
  console.log(`  ${sn}: cipherID=${c.cipherId ?? '—'} chiave=${c.privateKey ? 'trovata' : 'no'}`);
}
console.log('\nOperazione completata: ora puoi usare l\'app.');
process.exit(0);
