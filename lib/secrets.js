// Segreti cifrati a riposo (credenziali delle telecamere, token di Home Assistant e di Eufy, password dell'archivio).
//
// I file con segreti non contengono più testo in chiaro: sono cifrati con AES-256-GCM. La chiave NON sta nella cartella
// dei dati (così una copia o un backup dei dati da sola non basta per leggerli):
//   1. variabile CAMAPP_SECRET_KEY (l'installazione per Proxmox la scrive in /etc/cam-app.env, che systemd passa al servizio);
//   2. altrimenti la riga CAMAPP_SECRET_KEY= di /etc/cam-app.env (per i comandi lanciati a mano sul server);
//   3. altrimenti il file indicato da CAMAPP_KEY_FILE;
//   4. altrimenti, per le prove su un PC senza servizio, un file `secret.key` accanto ai dati (creato al primo uso).
// Chi perde la chiave perde i segreti cifrati: le telecamere vanno reinserite. CAMAPP_SECRETS=off lascia i file in chiaro.
//
// Formato: il valore cifrato è la stringa "enc:v1:<iv>.<tag>.<testo>" (base64). Un file JSON cifrato per intero è
// { "$enc": "enc:v1:…" }; il file delle telecamere cifra solo `params` di ognuna (nomi e marche restano leggibili).
// I file vecchi in chiaro si leggono ancora e vengono riscritti cifrati alla prima occasione.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA } from './paths.js';

export class SecretError extends Error {
  constructor(message) { super(message); this.name = 'SecretError'; }
}

const PREFIX = 'enc:v1:';
let key = null;

const hashKey = (text) => crypto.createHash('sha256').update(String(text).trim()).digest();

function getKey() {
  if (key) return key;
  if (process.env.CAMAPP_SECRET_KEY) return (key = hashKey(process.env.CAMAPP_SECRET_KEY));
  // Un comando lanciato a mano sul server (es. tools/eufy-login) non riceve l'ambiente del servizio: la chiave si legge
  // dallo stesso file di configurazione, così i due non si ritrovano con chiavi diverse.
  try {
    const m = /^CAMAPP_SECRET_KEY=(.+)$/m.exec(fs.readFileSync(process.env.CAMAPP_ENV_FILE || '/etc/cam-app.env', 'utf8'));
    if (m) return (key = hashKey(m[1].trim().replace(/^["']|["']$/g, '')));
  } catch { /* file assente o non leggibile */ }
  const file = process.env.CAMAPP_KEY_FILE || path.join(DATA, 'secret.key');
  try {
    return (key = hashKey(fs.readFileSync(file, 'utf8')));
  } catch (err) {
    if (err.code !== 'ENOENT') throw new SecretError(`Impossibile leggere la chiave dei segreti (${file}): ${err.message}`);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(file, `${crypto.randomBytes(32).toString('hex')}\n`, { mode: 0o600, flag: 'wx' });
    console.warn(`[segreti] chiave creata in ${file}: per tenerla fuori dalla cartella dei dati imposta CAMAPP_SECRET_KEY (vedi SECURITY.md)`);
  } catch (err) {
    if (err.code !== 'EEXIST') throw err; // un altro processo l'ha creata un attimo prima
  }
  return (key = hashKey(fs.readFileSync(file, 'utf8')));
}

export const enabled = () => String(process.env.CAMAPP_SECRETS || '').toLowerCase() !== 'off';
export const isSealed = (v) => typeof v === 'string' && v.startsWith(PREFIX);

/** Cifra un valore JSON (oggetto, array, stringa…) in una stringa "enc:v1:…". */
export function seal(value) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const ct = Buffer.concat([c.update(JSON.stringify(value), 'utf8'), c.final()]);
  return `${PREFIX}${iv.toString('base64')}.${c.getAuthTag().toString('base64')}.${ct.toString('base64')}`;
}

/** Decifra una stringa prodotta da seal(); lancia SecretError se la chiave non è quella giusta. */
export function open(text) {
  if (!isSealed(text)) throw new SecretError('Valore non cifrato');
  const [iv, tag, ct] = text.slice(PREFIX.length).split('.').map((p) => Buffer.from(p, 'base64'));
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', getKey(), iv);
    d.setAuthTag(tag);
    return JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString('utf8'));
  } catch {
    throw new SecretError('Impossibile decifrare i dati: la chiave dei segreti non è quella con cui sono stati salvati');
  }
}

// ---------- file JSON cifrati per intero ----------
/**
 * Legge un file JSON anche se cifrato. Restituisce { data, plain } (plain = il file era in chiaro: conviene riscriverlo),
 * oppure null se il file non esiste o non è JSON valido. Lancia SecretError se la chiave non è quella giusta.
 */
export function readSecretFile(file) {
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  if (parsed && typeof parsed === 'object' && typeof parsed.$enc === 'string') return { data: open(parsed.$enc), plain: false };
  return { data: parsed, plain: true };
}

/** Scrive (in modo atomico) un JSON cifrato per intero; con CAMAPP_SECRETS=off lo scrive in chiaro. */
export function writeSecretFile(file, data, { pretty = false } = {}) {
  const text = enabled() ? JSON.stringify({ $enc: seal(data) }) : JSON.stringify(data, null, pretty ? 2 : 0);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// ---------- file delle telecamere: si cifra solo `params` ----------
/** Telecamere pronte da salvare: `params` di ognuna diventa una stringa cifrata. */
export function sealCameras(cameras) {
  if (!enabled()) return cameras;
  return cameras.map((c) => ({ ...c, params: seal(c.params || {}) }));
}

/** Telecamere dal file: decifra `params`. Restituisce { cameras, plain } (plain = c'erano parametri in chiaro da cifrare). */
export function openCameras(list) {
  let plain = false;
  const cameras = (Array.isArray(list) ? list : []).map((c) => {
    if (isSealed(c.params)) return { ...c, params: open(c.params) };
    plain = true;
    return c;
  });
  return { cameras, plain: plain && cameras.length > 0 };
}
