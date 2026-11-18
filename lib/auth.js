// Accesso: utenti, password, sessioni e permessi per telecamera.
//
//  - password con scrypt (sale casuale), mai in chiaro; confronto a tempo costante;
//  - sessione = cookie casuale di 256 bit (HttpOnly, SameSite=Strict, Secure in HTTPS);
//    nel database resta solo la sua impronta SHA-256;
//  - dopo 5 accessi falliti dallo stesso indirizzo per lo stesso utente (o 25 dallo stesso indirizzo)
//    l'accesso si blocca per 15 minuti;
//  - due ruoli: "admin" (vede e gestisce tutto) e "user" (solo le telecamere abilitate:
//    livello 1 = vede, livello 2 = vede e controlla).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import * as db from './db.js';
import { DATA } from './paths.js';

const scrypt = promisify(crypto.scrypt);
export const COOKIE_NAME = 'camapp_sid';
const IDLE_MS = 7 * 86_400_000; // sessione inattiva da 7 giorni: scade
const ABSOLUTE_MS = 30 * 86_400_000; // durata massima di una sessione
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export const FIRST_RUN_FILE = path.join(DATA, 'first-run-admin.txt');

/** Errore con un codice che l'interfaccia traduce nella lingua dell'utente. */
export class AuthError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    Object.assign(this, extra);
  }
}

export const USERNAME_RE = /^[A-Za-z0-9._-]{3,32}$/;

export function checkPassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) throw new AuthError('PW_SHORT', 'La password deve avere almeno 8 caratteri');
  if (pw.length > 200) throw new AuthError('PW_LONG', 'Password troppo lunga');
}

// ---------- password ----------
export async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(pw, stored) {
  const [alg, N, r, p, saltB, keyB] = String(stored).split('$');
  if (alg !== 'scrypt' || !keyB) return false;
  const key = Buffer.from(keyB, 'base64');
  const got = await scrypt(String(pw), Buffer.from(saltB, 'base64'), key.length, { N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem });
  return got.length === key.length && crypto.timingSafeEqual(got, key);
}

let dummyHash = null; // per impiegare lo stesso tempo anche con utenti inesistenti (niente enumerazione)
const getDummy = async () => (dummyHash ??= await hashPassword(crypto.randomBytes(8).toString('hex')));

const ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const randomPassword = (len = 14) => Array.from({ length: len }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join('');

// ---------- blocco dopo tentativi falliti ----------
const WINDOW_MS = 15 * 60_000;
const LOCK_MS = 15 * 60_000;
const fails = new Map(); // chiave -> { n, first, until }

const keysFor = (ip, username, recovery = false) => {
  const n = String(username).toLowerCase();
  // Il recupero ha anche un limite globale per utente (10 errori), indipendente dall'indirizzo di provenienza.
  return recovery
    ? [[`${ip}|recover:${n}`, 5], [`ip:recover:${ip}`, 25], [`recover:${n}`, 10]]
    : [[`${ip}|${n}`, 5], [`ip:${ip}`, 25]];
};

function lockRemaining(ip, username, recovery = false) {
  const now = Date.now();
  let max = 0;
  for (const [key] of keysFor(ip, username, recovery)) {
    const e = fails.get(key);
    if (e?.until > now) max = Math.max(max, e.until - now);
  }
  return Math.ceil(max / 1000);
}

function noteFail(ip, username, recovery = false) {
  const now = Date.now();
  for (const [key, limit] of keysFor(ip, username, recovery)) {
    let e = fails.get(key);
    if (!e || now - e.first > WINDOW_MS) e = { n: 0, first: now, until: 0 };
    e.n += 1;
    if (e.n >= limit) e.until = now + LOCK_MS;
    fails.set(key, e);
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [k, e] of fails) if (now - e.first > WINDOW_MS && e.until < now) fails.delete(k);
  db.purgeSessions(now);
}, 3_600_000).unref();

// ---------- sessioni ----------
const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');

export function publicUser(u) {
  return { id: u.id, username: u.username, displayName: u.displayName || '', role: u.role, mustChange: !!u.mustChange };
}

function createSession(user, { ip, ua }) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  db.insertSession({ tokenHash: hashToken(token), userId: user.id, created: now, expires: now + ABSOLUTE_MS, ip, ua });
  return token;
}

/** Utente della sessione indicata dal cookie, oppure null. */
export function userFromToken(token) {
  if (!token || token.length > 100) return null;
  const hash = hashToken(token);
  const s = db.getSession(hash);
  if (!s) return null;
  const now = Date.now();
  if (s.expires < now || now - s.last_seen > IDLE_MS) { db.deleteSession(hash); return null; }
  const user = db.getUserById(s.user_id);
  if (!user || user.disabled) return null;
  if (now - s.last_seen > 60_000) db.touchSession(hash, now);
  return { ...publicUser(user), sessionHash: hash };
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export const sessionCookie = (token, secure) =>
  `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(ABSOLUTE_MS / 1000)}${secure ? '; Secure' : ''}`;
export const clearCookie = (secure) => `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`;

export async function login(username, password, { ip, ua }) {
  const name = String(username || '').trim();
  const wait = lockRemaining(ip, name);
  if (wait > 0) throw new AuthError('LOCKED', `Troppi tentativi: riprova tra ${Math.ceil(wait / 60)} minuti`, { retryAfter: wait });
  const user = name ? db.getUserByName(name) : null;
  const ok = user ? await verifyPassword(password, user.pwHash) : (await verifyPassword(password, await getDummy()), false);
  if (!ok || user.disabled) {
    noteFail(ip, name);
    throw new AuthError('INVALID', 'Utente o password non corretti');
  }
  fails.delete(`${ip}|${name.toLowerCase()}`);
  db.touchLogin(user.id);
  return { user: publicUser(user), token: createSession(user, { ip, ua }) };
}

export function logout(token) {
  if (token) db.deleteSession(hashToken(token));
}

// ---------- permessi sulle telecamere ----------
const access = new Map();
const accessMap = (userId) => {
  let m = access.get(userId);
  if (!m) access.set(userId, (m = db.getUserCameras(userId)));
  return m;
};
export const invalidateAccess = (userId) => (userId == null ? access.clear() : access.delete(userId));

/** 0 = nessun accesso, 1 = vede, 2 = vede e controlla. Gli amministratori hanno sempre 2. */
export const levelFor = (user, camId) => (user.role === 'admin' ? 2 : accessMap(user.id).get(camId) || 0);

export function removeCamera(camId) {
  db.removeCameraFromAll(camId);
  invalidateAccess();
}

// ---------- gestione utenti (amministratore) ----------
function cleanName(username) {
  const name = String(username || '').trim();
  if (!USERNAME_RE.test(name)) throw new AuthError('USERNAME_BAD', 'Nome utente: da 3 a 32 caratteri tra lettere, numeri, punto, trattino e trattino basso');
  return name;
}

export async function createUser({ username, displayName, role = 'user', password, mustChange = true }) {
  const name = cleanName(username);
  if (!['admin', 'user'].includes(role)) throw new AuthError('ROLE_BAD', 'Ruolo non valido');
  checkPassword(password);
  if (db.getUserByName(name)) throw new AuthError('EXISTS', 'Esiste già un utente con questo nome');
  const id = db.insertUser({ username: name, displayName: String(displayName || '').trim().slice(0, 60), role, pwHash: await hashPassword(password), mustChange });
  return publicUser(db.getUserById(id));
}

const isLastAdmin = (u) => u.role === 'admin' && !u.disabled && db.adminCount() <= 1;

export function updateUser(id, patch, acting) {
  const u = db.getUserById(id);
  if (!u) throw new AuthError('NOT_FOUND', 'Utente non trovato');
  const p = {};
  if (patch.username !== undefined) {
    p.username = cleanName(patch.username);
    const other = db.getUserByName(p.username);
    if (other && other.id !== id) throw new AuthError('EXISTS', 'Esiste già un utente con questo nome');
  }
  if (patch.displayName !== undefined) p.displayName = String(patch.displayName).trim().slice(0, 60);
  if (patch.role !== undefined) {
    if (!['admin', 'user'].includes(patch.role)) throw new AuthError('ROLE_BAD', 'Ruolo non valido');
    if (patch.role !== 'admin' && isLastAdmin(u)) throw new AuthError('LAST_ADMIN', 'Deve restare almeno un amministratore attivo');
    p.role = patch.role;
  }
  if (patch.disabled !== undefined) {
    if (patch.disabled && id === acting.id) throw new AuthError('SELF', 'Non puoi disabilitare il tuo stesso utente');
    if (patch.disabled && isLastAdmin(u)) throw new AuthError('LAST_ADMIN', 'Deve restare almeno un amministratore attivo');
    p.disabled = !!patch.disabled;
  }
  if (patch.mustChange !== undefined) p.mustChange = !!patch.mustChange;
  db.updateUser(id, p);
  if (p.disabled || p.role) db.deleteUserSessions(id); // il cambio di ruolo o la disabilitazione chiudono le sessioni aperte
  invalidateAccess(id);
  return publicUser(db.getUserById(id));
}

export async function resetPassword(id, password, { mustChange = true } = {}) {
  if (!db.getUserById(id)) throw new AuthError('NOT_FOUND', 'Utente non trovato');
  checkPassword(password);
  db.updateUser(id, { pwHash: await hashPassword(password), mustChange });
  db.deleteUserSessions(id);
}

export async function changeOwnPassword(user, current, next) {
  const u = db.getUserById(user.id);
  if (!u || !(await verifyPassword(current, u.pwHash))) throw new AuthError('PW_WRONG', 'La password attuale non è corretta');
  checkPassword(next);
  if (next === current) throw new AuthError('PW_SAME', 'La nuova password deve essere diversa da quella attuale');
  db.updateUser(u.id, { pwHash: await hashPassword(next), mustChange: false });
  db.deleteUserSessions(u.id, user.sessionHash); // le altre sessioni si chiudono, questa resta
  try { fs.rmSync(FIRST_RUN_FILE, { force: true }); } catch { /* facoltativo */ }
}

export function deleteUser(id, acting) {
  const u = db.getUserById(id);
  if (!u) throw new AuthError('NOT_FOUND', 'Utente non trovato');
  if (id === acting.id) throw new AuthError('SELF', 'Non puoi eliminare il tuo stesso utente');
  if (isLastAdmin(u)) throw new AuthError('LAST_ADMIN', 'Deve restare almeno un amministratore attivo');
  db.deleteUser(id);
  invalidateAccess(id);
}

export function setCameraAccess(userId, levels, validCameraIds) {
  if (!db.getUserById(userId)) throw new AuthError('NOT_FOUND', 'Utente non trovato');
  const entries = [];
  for (const [camId, level] of Object.entries(levels || {})) {
    const n = Number(level);
    if (validCameraIds.includes(camId) && (n === 1 || n === 2)) entries.push([camId, n]);
  }
  db.setUserCameras(userId, entries);
  invalidateAccess(userId);
}

/** Elenco per l'amministratore: utenti con telecamere abilitate e sessioni aperte. */
export function listUsers() {
  return db.listUsers().map((u) => ({
    ...publicUser(u),
    disabled: u.disabled,
    created: u.created,
    lastLogin: u.lastLogin,
    sessions: db.sessionCount(u.id),
    cameras: Object.fromEntries(db.getUserCameras(u.id)),
  }));
}

export const revokeSessions = (id) => db.deleteUserSessions(id);

// ---------- recupero password (solo amministratori, con 3 domande) ----------
// L'amministratore sceglie 3 domande e 3 risposte (pagina Amministrazione). Dalla pagina di accesso, chi ha
// dimenticato la password risponde a tutte e tre e ne imposta una nuova. Le risposte si confrontano senza
// maiuscole, accenti e spazi doppi; nel database ci sono solo hash scrypt.
const DECOYS = [
  'Come si chiamava il tuo primo animale domestico?',
  'In quale città sei nato?',
  'Qual è il nome da nubile di tua madre?',
  'Come si chiamava la tua scuola elementare?',
  'Qual è stato il tuo primo lavoro?',
  'Qual è il tuo film preferito?',
  'Come si chiamava il tuo migliore amico d’infanzia?',
  'In che via abitavi da bambino?',
];
const decoySecret = crypto.randomBytes(16);

export const normalizeAnswer = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

const recoverableUser = (name) => {
  const u = name ? db.getUserByName(name) : null;
  return u && u.role === 'admin' && !u.disabled && db.getRecovery(u.id) ? u : null;
};

export function recoveryStatus(user) {
  const r = db.getRecovery(user.id);
  return { configured: !!r, questions: r?.questions || [], updated: r?.updated || null };
}

async function checkCurrent(user, current) {
  const u = db.getUserById(user.id);
  if (!u || !(await verifyPassword(String(current || ''), u.pwHash))) throw new AuthError('PW_WRONG', 'La password attuale non è corretta');
}

export async function setRecovery(user, current, items) {
  if (user.role !== 'admin') throw new AuthError('FORBIDDEN', 'Riservato agli amministratori');
  await checkCurrent(user, current);
  if (!Array.isArray(items) || items.length !== 3) throw new AuthError('RECOVERY_FIELDS', 'Servono 3 domande con le relative risposte');
  const questions = [];
  const norms = [];
  for (const it of items) {
    const question = String(it?.question ?? '').trim();
    const answer = normalizeAnswer(it?.answer);
    if (question.length < 5 || question.length > 120 || answer.length < 3 || answer.length > 100) {
      throw new AuthError('RECOVERY_FIELDS', 'Ogni domanda: da 5 a 120 caratteri; ogni risposta: da 3 a 100');
    }
    questions.push(question);
    norms.push(answer);
  }
  if (new Set(questions.map((s) => s.toLowerCase())).size < 3 || new Set(norms).size < 3) {
    throw new AuthError('RECOVERY_DUPLICATE', 'Le tre domande e le tre risposte devono essere diverse');
  }
  db.setRecovery(user.id, questions, await Promise.all(norms.map(hashPassword)));
}

export async function clearRecovery(user, current) {
  await checkCurrent(user, current);
  db.deleteRecovery(user.id);
}

/** Domande da mostrare nella pagina di accesso. Per utenti senza recupero ne escono di finte, sempre le stesse per quel nome. */
export function recoveryQuestions(username, { ip }) {
  const name = String(username || '').trim();
  const wait = lockRemaining(ip, name, true);
  if (wait > 0) throw new AuthError('LOCKED', `Troppi tentativi: riprova tra ${Math.ceil(wait / 60)} minuti`, { retryAfter: wait });
  const u = recoverableUser(name);
  if (u) return db.getRecovery(u.id).questions;
  const h = crypto.createHmac('sha256', decoySecret).update(name.toLowerCase()).digest();
  const start = h[0] % DECOYS.length;
  return [0, 1, 2].map((i) => DECOYS[(start + i * 3) % DECOYS.length]);
}

export async function recoverPassword(username, answers, password, { ip }) {
  const name = String(username || '').trim();
  const wait = lockRemaining(ip, name, true);
  if (wait > 0) throw new AuthError('LOCKED', `Troppi tentativi: riprova tra ${Math.ceil(wait / 60)} minuti`, { retryAfter: wait });
  checkPassword(password);
  const u = recoverableUser(name);
  const stored = u ? db.getRecovery(u.id).answers : [await getDummy(), await getDummy(), await getDummy()];
  const given = Array.isArray(answers) ? answers : [];
  let ok = !!u;
  for (let i = 0; i < 3; i++) {
    const good = await verifyPassword(normalizeAnswer(given[i]), stored[i]); // sempre tutte e tre: stesso tempo in ogni caso
    ok = ok && good;
  }
  if (!ok) {
    noteFail(ip, name, true);
    throw new AuthError('RECOVERY_INVALID', 'Risposte non corrette o recupero non disponibile');
  }
  db.updateUser(u.id, { pwHash: await hashPassword(password), mustChange: false });
  db.deleteUserSessions(u.id);
  for (const [key] of keysFor(ip, name, true)) fails.delete(key);
  fails.delete(`${ip}|${name.toLowerCase()}`);
  try { fs.rmSync(FIRST_RUN_FILE, { force: true }); } catch { /* facoltativo */ }
  console.log(`[accesso] password dell'amministratore "${u.username}" reimpostata con le domande di recupero (ip ${ip})`);
}

// ---------- password per scaricare il certificato (telefoni) ----------
// Il certificato HTTPS (solo la parte pubblica) si scarica da una pagina raggiungibile senza accesso, ma solo
// con questa password, scelta dall'amministratore. Nel file resta solo l'hash scrypt.
const CERT_FILE = path.join(DATA, 'cert-access.json');
let certHash = null;
try { certHash = JSON.parse(fs.readFileSync(CERT_FILE, 'utf8')).hash || null; } catch { /* non impostata */ }

export const certPasswordSet = () => !!certHash;

export async function setCertPassword(password) {
  checkPassword(password);
  certHash = await hashPassword(password);
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(CERT_FILE, JSON.stringify({ hash: certHash }), { mode: 0o600 });
}

export function clearCertPassword() {
  certHash = null;
  try { fs.rmSync(CERT_FILE, { force: true }); } catch { /* già assente */ }
}

/** Verifica la password del certificato, con lo stesso blocco dopo i tentativi falliti del recupero. */
export async function verifyCertPassword(password, { ip }) {
  const wait = lockRemaining(ip, 'cert', true);
  if (wait > 0) throw new AuthError('LOCKED', `Troppi tentativi: riprova tra ${Math.ceil(wait / 60)} minuti`, { retryAfter: wait });
  const ok = certHash ? await verifyPassword(String(password || ''), certHash) : (await verifyPassword(String(password || ''), await getDummy()), false);
  if (!ok) {
    noteFail(ip, 'cert', true);
    throw new AuthError('CERT_PW_WRONG', 'Password non corretta');
  }
  for (const [key] of keysFor(ip, 'cert', true)) fails.delete(key);
}

// ---------- primo avvio ----------
/** Se non esiste alcun utente crea "admin" con una password casuale (da cambiare al primo accesso). */
export async function ensureAdmin() {
  if (db.userCount() > 0) return null;
  const username = cleanName(process.env.ADMIN_USERNAME || 'admin');
  const fromEnv = !!process.env.ADMIN_PASSWORD;
  const password = process.env.ADMIN_PASSWORD || randomPassword();
  checkPassword(password);
  await createUser({ username, displayName: 'Amministratore', role: 'admin', password, mustChange: !fromEnv });
  if (!fromEnv) {
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(FIRST_RUN_FILE, `Utente:   ${username}\nPassword: ${password}\n\nCambia la password al primo accesso: questo file viene eliminato dopo il cambio.\n`, { mode: 0o600 });
  }
  const line = '='.repeat(60);
  console.log(`\n${line}\n PRIMO AVVIO: creato l'amministratore\n   utente:   ${username}\n   password: ${fromEnv ? '(da ADMIN_PASSWORD)' : password}\n${fromEnv ? '' : ` (salvata anche in ${FIRST_RUN_FILE})\n`}${line}\n`);
  return { username };
}
