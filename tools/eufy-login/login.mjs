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
import path from 'node:path';

// cipherID letti in locale dalle telecamere: seriale -> numero. Si passano con la variabile d'ambiente
// EUFY_CIPHERS, per esempio:  EUFY_CIPHERS="T84A1XXXXXXXXXXX=138,T8170XXXXXXXXXXX=90"
// (il cipherID si ricava dalla ricerca locale, vedi tools/eufy-discover.js). Le SoloCam a batteria vanno lette da sveglie.
const CIPHERS = Object.fromEntries(
  String(process.env.EUFY_CIPHERS || '').split(',').map((p) => p.trim().split('=')).filter((p) => p[0] && Number(p[1])).map(([k, v]) => [k, Number(v)]),
);
// Stessa cartella dati dell'app (DATA_DIR oppure ../../data rispetto a questo file).
const OUT = path.join(
  path.resolve(process.env.DATA_DIR || path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..', 'data')),
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
    const file = path.join(process.cwd(), 'captcha.png');
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
fs.writeFileSync(OUT, JSON.stringify(result, null, 2));

console.log('\nFatto. Salvato in:', OUT);
console.log('Riepilogo (senza segreti):');
console.log('  accountId:', accountId ? `${accountId.length} caratteri` : 'mancante');
for (const [sn, c] of Object.entries(result.cameras)) {
  console.log(`  ${sn}: cipherID=${c.cipherId ?? '—'} chiave=${c.privateKey ? 'trovata' : 'no'}`);
}
console.log('\nOperazione completata: ora puoi usare l\'app.');
process.exit(0);
