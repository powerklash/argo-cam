// Rinnova la chiave di sveglia (dsk, dura ~30 minuti) delle telecamere a batteria usando la sessione salvata
// da login.mjs (<DATA_DIR>/eufy-session.json: token, niente password). Lo avvia l'app quando serve.
//   node dsk.mjs [SERIALE ...]      (senza argomenti: tutte le stazioni di eufy-cloud.json)
// Uscita: 0 = chiavi rinnovate, 2 = serve rifare login.mjs, 1 = altro errore. Non stampa segreti.
import { HTTPApi } from 'eufy-security-client';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA = path.resolve(process.env.DATA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data'));
const SESSION = path.join(DATA, 'eufy-session.json');
const CLOUD = path.join(DATA, 'eufy-cloud.json');
const fail = (code, msg) => { console.log(msg); process.exit(code); };

let session, cloud;
try { session = JSON.parse(fs.readFileSync(SESSION, 'utf8')); } catch { fail(2, 'Sessione Eufy mancante: esegui login.mjs'); }
try { cloud = JSON.parse(fs.readFileSync(CLOUD, 'utf8')); } catch { fail(2, 'eufy-cloud.json mancante: esegui login.mjs'); }
if (!session.token) fail(2, 'Sessione Eufy senza token: esegui login.mjs');
if (session.tokenExpiration && Date.now() >= session.tokenExpiration) fail(2, 'Sessione Eufy scaduta: esegui login.mjs');

const wanted = process.argv.slice(2).filter((s) => cloud.stations?.[s]);
const serials = wanted.length ? wanted : Object.keys(cloud.stations || {});
if (!serials.length) fail(1, 'Nessuna stazione in eufy-cloud.json');

// L'API riceve una password finta: con il token ancora valido non viene mai usata per accedere.
const api = await HTTPApi.initialize(session.country || 'IT', 'sessione', 'non-usata', session.persistentData);
api.setToken(session.token);
if (session.tokenExpiration) api.setTokenExpiration(new Date(session.tokenExpiration));
api.on('captcha request', () => fail(2, 'Eufy chiede un captcha: esegui login.mjs'));
api.on('tfa request', () => fail(2, 'Eufy chiede un codice di verifica: esegui login.mjs'));

let ok = 0;
for (const sn of serials) {
  try {
    const r = await api.request({ method: 'post', endpoint: 'v1/app/equipment/get_dsk_keys', data: { invalid_dsks: { [sn]: '' }, station_sns: [sn], transaction: `${Date.now()}` } });
    const code = r.data?.code;
    if (code === 26006 || code === 26052 || r.status === 401) fail(2, `Sessione Eufy rifiutata (codice ${code}): esegui login.mjs`);
    const k = r.data?.data?.dsk_keys?.find((x) => x.station_sn === sn);
    if (k?.dsk_key) { cloud.stations[sn].dsk = k.dsk_key; cloud.stations[sn].dskExpires = Number(k.expiration) * 1000; ok++; }
    else console.log(`${sn}: chiave non ricevuta (codice ${code} ${r.data?.msg || ''})`);
  } catch (e) {
    console.log(`${sn}: ${e.message}`);
  }
}
if (!ok) fail(2, 'Nessuna chiave rinnovata: la sessione non è più valida? esegui login.mjs');
cloud.fetchedAt = Date.now();
fs.writeFileSync(CLOUD, JSON.stringify(cloud, null, 2), { mode: 0o600 });
console.log(`Rinnovate ${ok} chiavi di sveglia`);
process.exit(0);
