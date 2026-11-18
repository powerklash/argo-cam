// Database locale (SQLite integrato in Node): eventi, persone e volti, mezzi.
// File: data/cam-app.db. Le immagini e i filmati stanno in data/events/.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { DATA } from './paths.js';

export const EVENTS_DIR = path.join(DATA, 'events');
fs.mkdirSync(EVENTS_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA, 'cam-app.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,            -- millisecondi
    cam_id TEXT NOT NULL,
    cam_name TEXT NOT NULL,
    kind TEXT NOT NULL,             -- person | vehicle | pet | face | package | motion | visitor
    snapshot TEXT,                  -- percorso relativo a data/events
    clip TEXT,
    vehicle_type TEXT,              -- car | truck | bus | motorcycle | bicycle
    vehicle_color TEXT,             -- white | black | grey | silver | red | blue | green | yellow | orange | brown
    plate TEXT,
    person_id INTEGER,              -- persona riconosciuta (se c'è)
    meta TEXT
  );
  CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
  CREATE INDEX IF NOT EXISTS events_cam ON events(cam_id, ts);
  CREATE TABLE IF NOT EXISTS persons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,                      -- NULL = non ancora identificata
    created INTEGER NOT NULL,
    note TEXT
  );
  CREATE TABLE IF NOT EXISTS faces (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    person_id INTEGER REFERENCES persons(id) ON DELETE CASCADE,
    event_id INTEGER,
    embedding BLOB NOT NULL,        -- vettore Float32 normalizzato
    crop TEXT,                      -- miniatura del volto
    ts INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS faces_person ON faces(person_id);

  -- Accesso: utenti, sessioni e telecamere abilitate per ciascun utente.
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT,
    role TEXT NOT NULL DEFAULT 'user',      -- admin | user
    pw_hash TEXT NOT NULL,                  -- scrypt$N$r$p$sale$hash
    must_change INTEGER NOT NULL DEFAULT 0, -- obbliga a cambiare la password al prossimo accesso
    disabled INTEGER NOT NULL DEFAULT 0,
    created INTEGER NOT NULL,
    last_login INTEGER
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,            -- SHA-256 del cookie: il cookie in chiaro non si salva
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    expires INTEGER NOT NULL,
    ip TEXT,
    ua TEXT
  );
  CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
  CREATE TABLE IF NOT EXISTS user_cameras (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    camera_id TEXT NOT NULL,
    level INTEGER NOT NULL DEFAULT 1,       -- 1 = vede, 2 = vede e controlla
    PRIMARY KEY (user_id, camera_id)
  );
  -- Recupero password dell'amministratore: 3 domande scelte da lui; le risposte restano solo come hash scrypt.
  CREATE TABLE IF NOT EXISTS recovery (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    questions TEXT NOT NULL,                -- JSON: 3 domande
    answers TEXT NOT NULL,                  -- JSON: 3 hash scrypt delle risposte normalizzate
    updated INTEGER NOT NULL
  );
`);
db.exec('PRAGMA foreign_keys = ON');
// Animali riconosciuti: stesse tabelle delle persone, con la specie (cat, dog, bird…); NULL = persona.
if (!db.prepare('PRAGMA table_info(persons)').all().some((c) => c.name === 'species')) db.exec('ALTER TABLE persons ADD COLUMN species TEXT');
// Archivio: `archived` = 1 se il filmato dell'evento è stato spostato nell'archivio di rete; `bytes` = spazio di immagine + filmato.
const eventCols = db.prepare('PRAGMA table_info(events)').all().map((c) => c.name);
if (!eventCols.includes('archived')) db.exec('ALTER TABLE events ADD COLUMN archived INTEGER NOT NULL DEFAULT 0');
if (!eventCols.includes('bytes')) db.exec('ALTER TABLE events ADD COLUMN bytes INTEGER');
// Anteprima leggera del filmato (H.264, bassa risoluzione) per la riproduzione; l'originale resta alla massima qualità per il download.
if (!eventCols.includes('preview')) db.exec('ALTER TABLE events ADD COLUMN preview TEXT');
// Veicolo riconosciuto (scheda Veicoli) e percorso dei riquadri che seguono la figura nel filmato.
if (!eventCols.includes('vehicle_id')) db.exec('ALTER TABLE events ADD COLUMN vehicle_id INTEGER');
if (!eventCols.includes('tracks')) db.exec('ALTER TABLE events ADD COLUMN tracks TEXT');
// Suggerimento: una persona/animale/veicolo nuovo che somiglia a uno già presente (da unire, se è lo stesso).
const personCols = db.prepare('PRAGMA table_info(persons)').all().map((c) => c.name);
if (!personCols.includes('suggest_id')) db.exec('ALTER TABLE persons ADD COLUMN suggest_id INTEGER');
if (!personCols.includes('suggest_sim')) db.exec('ALTER TABLE persons ADD COLUMN suggest_sim REAL');

// Un evento può mostrare più persone, animali o veicoli: ogni soggetto riconosciuto è un legame (evento, soggetto).
// Le colonne person_id / vehicle_id dell'evento restano come "principale" (la persona o l'animale, e il veicolo, più
// in evidenza) e si ricavano dai legami (syncMains); la ricerca e i badge usano i legami.
db.exec(`
  CREATE TABLE IF NOT EXISTS event_subjects (
    event_id INTEGER NOT NULL,
    person_id INTEGER NOT NULL,
    PRIMARY KEY (event_id, person_id)
  );
  CREATE INDEX IF NOT EXISTS event_subjects_person ON event_subjects(person_id);
`);
// Prima volta: i legami si ricavano dagli eventi e dalle immagini già salvate.
if (!db.prepare('SELECT 1 FROM event_subjects LIMIT 1').get()) {
  db.exec(`
    INSERT OR IGNORE INTO event_subjects SELECT id, person_id FROM events WHERE person_id IS NOT NULL;
    INSERT OR IGNORE INTO event_subjects SELECT id, vehicle_id FROM events WHERE vehicle_id IS NOT NULL;
    INSERT OR IGNORE INTO event_subjects SELECT DISTINCT event_id, person_id FROM faces WHERE event_id IS NOT NULL AND event_id IN (SELECT id FROM events);
  `);
}

const q = (sql) => db.prepare(sql);

export function insertEvent(e) {
  const r = q(
    `INSERT INTO events (ts, cam_id, cam_name, kind, snapshot, clip, vehicle_type, vehicle_color, plate, person_id, meta, bytes, vehicle_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    e.ts, e.camId, e.camName, e.kind, e.snapshot ?? null, e.clip ?? null, e.vehicleType ?? null,
    e.vehicleColor ?? null, e.plate ?? null, e.personId ?? null, e.meta ? JSON.stringify(e.meta) : null, e.bytes ?? null, e.vehicleId ?? null,
  );
  return Number(r.lastInsertRowid);
}

const COLS = { vehicleId: 'vehicle_id', tracks: 'tracks', preview: 'preview', bytes: 'bytes', kind: 'kind', snapshot: 'snapshot', clip: 'clip', vehicleType: 'vehicle_type', vehicleColor: 'vehicle_color', plate: 'plate', personId: 'person_id' };
export function updateEvent(id, patch) {
  const sets = [];
  const vals = [];
  for (const [k, col] of Object.entries(COLS)) {
    if (patch[k] !== undefined) { sets.push(`${col} = ?`); vals.push(patch[k]); }
  }
  if (patch.meta !== undefined) { sets.push('meta = ?'); vals.push(JSON.stringify(patch.meta)); }
  if (sets.length) q(`UPDATE events SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
}

const rowToEvent = (r) => r && {
  id: r.id, ts: r.ts, camId: r.cam_id, camName: r.cam_name, kind: r.kind, snapshot: r.snapshot, clip: r.clip,
  vehicleType: r.vehicle_type, vehicleColor: r.vehicle_color, plate: r.plate, personId: r.person_id,
  personName: r.person_name ?? null, personSpecies: r.person_species ?? null, vehicleId: r.vehicle_id ?? null,
  vehicleName: r.vehicle_name ?? null, vehicleSpecies: r.vehicle_species ?? null, tracks: r.tracks ?? null,
  archived: !!r.archived, preview: r.preview ?? null, meta: r.meta ? JSON.parse(r.meta) : null,
};

const EV_SELECT = `SELECT e.*, p.name AS person_name, p.species AS person_species, v.name AS vehicle_name, v.species AS vehicle_species
  FROM events e LEFT JOIN persons p ON p.id = e.person_id LEFT JOIN persons v ON v.id = e.vehicle_id`;

/** Aggiunge a ogni evento `subjects`: tutte le persone, gli animali e i veicoli riconosciuti ({ id, name, species }). */
function attachSubjects(list) {
  const ids = list.filter(Boolean).map((e) => e.id);
  const by = new Map();
  for (let i = 0; i < ids.length; i += 200) {
    const part = ids.slice(i, i + 200);
    const rows = q(
      `SELECT s.event_id AS eventId, p.id, p.name, p.species FROM event_subjects s JOIN persons p ON p.id = s.person_id
       WHERE s.event_id IN (${part.map(() => '?').join(',')}) ORDER BY (p.species IS NOT NULL), s.rowid`,
    ).all(...part);
    for (const r of rows) { if (!by.has(r.eventId)) by.set(r.eventId, []); by.get(r.eventId).push({ id: r.id, name: r.name, species: r.species }); }
  }
  for (const e of list) if (e) e.subjects = by.get(e.id) || [];
  return list;
}

export const getEvent = (id) => attachSubjects([rowToEvent(q(`${EV_SELECT} WHERE e.id = ?`).get(id))])[0];

/**
 * Ricerca eventi. filter: { camIds, kinds, from, to, hours:[da,a], vehicleTypes, colors, personIds,
 * onlyKnown, plate, limit, offset }
 */
export function queryEvents(f = {}) {
  const where = [];
  const args = [];
  const inList = (col, list) => {
    if (list?.length) { where.push(`${col} IN (${list.map(() => '?').join(',')})`); args.push(...list); }
  };
  inList('e.cam_id', f.camIds);
  // Tipo di evento: quelli indicati, oppure (con vehicleAny) anche ogni evento in cui è stato riconosciuto un mezzo.
  const kindParts = [];
  if (f.kinds?.length) { kindParts.push(`e.kind IN (${f.kinds.map(() => '?').join(',')})`); args.push(...f.kinds); }
  if (f.vehicleAny) kindParts.push("(e.kind = 'vehicle' OR e.vehicle_type IS NOT NULL)");
  if (kindParts.length) where.push(`(${kindParts.join(' OR ')})`);
  inList('e.vehicle_type', f.vehicleTypes);
  inList('e.vehicle_color', f.colors);
  if (f.personIds?.length) { // persona, animale o veicolo: anche uno solo tra quelli riconosciuti nell'evento
    const ph = f.personIds.map(() => '?').join(',');
    where.push(`(e.person_id IN (${ph}) OR e.vehicle_id IN (${ph}) OR EXISTS (SELECT 1 FROM event_subjects s WHERE s.event_id = e.id AND s.person_id IN (${ph})))`);
    args.push(...f.personIds, ...f.personIds, ...f.personIds);
  }
  if (f.from != null) { where.push('e.ts >= ?'); args.push(f.from); }
  if (f.to != null) { where.push('e.ts < ?'); args.push(f.to); }
  if (f.plate) { where.push('e.plate LIKE ?'); args.push(`%${f.plate}%`); }
  if (f.onlyKnown) where.push('(e.person_id IS NOT NULL OR e.vehicle_id IS NOT NULL OR EXISTS (SELECT 1 FROM event_subjects s WHERE s.event_id = e.id))');
  const sql = `${EV_SELECT}
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY e.ts DESC LIMIT ? OFFSET ?`;
  let rows = q(sql).all(...args, f.limit ?? 60, f.offset ?? 0).map(rowToEvent);
  // Fascia oraria (es. "di sera"): filtro in memoria sull'ora locale, anche a cavallo della mezzanotte.
  if (f.hours) {
    const [a, b] = f.hours;
    rows = rows.filter((r) => {
      const h = new Date(r.ts).getHours();
      return a <= b ? h >= a && h < b : h >= a || h < b;
    });
  }
  return attachSubjects(rows);
}

export function deleteEvent(id) {
  const e = getEvent(id);
  q('DELETE FROM events WHERE id = ?').run(id);
  q('DELETE FROM event_subjects WHERE event_id = ?').run(id);
  return e;
}

/**
 * Elimina gli eventi più vecchi di `days` giorni. Restituisce i file da cancellare: `local` nel CT, `remote` (filmati)
 * nell'archivio. Gli eventi con il filmato in archivio si eliminano solo con `includeArchived`.
 */
export function purgeEvents(days, { includeArchived = false } = {}) {
  if (!days) return { local: [], remote: [] };
  const cutoff = Date.now() - days * 86400_000;
  const rows = q(`SELECT id, snapshot, clip, archived, preview, tracks FROM events WHERE ts < ? ${includeArchived ? '' : 'AND archived = 0'}`).all(cutoff);
  q(`DELETE FROM events WHERE ts < ? ${includeArchived ? '' : 'AND archived = 0'}`).run(cutoff);
  q('DELETE FROM event_subjects WHERE event_id NOT IN (SELECT id FROM events)').run();
  const local = [];
  const remote = [];
  for (const r of rows) {
    if (r.snapshot) local.push(r.snapshot);
    if (r.preview) local.push(r.preview);
    if (r.tracks) local.push(r.tracks);
    if (r.clip) (r.archived ? remote : local).push(r.clip);
  }
  return { local, remote };
}

// ---------- archivio di rete ----------
/** Eventi con filmato ancora nel CT, più vecchi di `before` (millisecondi), dal più vecchio. */
export const archivable = (before, limit) => q(
  'SELECT id, ts, clip FROM events WHERE ts < ? AND clip IS NOT NULL AND archived = 0 ORDER BY ts LIMIT ?',
).all(before, limit);
export const markArchived = (id) => q('UPDATE events SET archived = 1 WHERE id = ?').run(id);
export const eventsWithoutPreview = (limit = 100) => q("SELECT id, clip FROM events WHERE clip IS NOT NULL AND archived = 0 AND preview IS NULL ORDER BY ts DESC LIMIT ?").all(limit);
export const eventsWithoutTracks = (limit = 60) => q("SELECT id FROM events WHERE preview IS NOT NULL AND tracks IS NULL ORDER BY ts DESC LIMIT ?").all(limit);
export const eventsWithoutBytes = (limit = 500) => q('SELECT id, snapshot, clip FROM events WHERE bytes IS NULL LIMIT ?').all(limit);

/** Conteggi e spazio per l'analisi della crescita (ultimi 7 giorni per giorno locale). */
export function eventStats() {
  const tot = q(`SELECT COUNT(*) AS n, COALESCE(SUM(archived), 0) AS archived,
      COALESCE(SUM(CASE WHEN archived = 0 THEN bytes END), 0) AS localBytes,
      COALESCE(SUM(CASE WHEN archived = 1 THEN bytes END), 0) AS archivedBytes, MIN(ts) AS first FROM events`).get();
  const days = q(`SELECT date(ts / 1000, 'unixepoch', 'localtime') AS day, COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS bytes
      FROM events WHERE ts > ? GROUP BY day ORDER BY day`).all(Date.now() - 7 * 86400_000);
  return { ...tot, days };
}

// ---------- persone e volti ----------
export const listPersons = () => q(
  `SELECT p.id, p.name, p.species, p.created, p.note, p.suggest_id AS suggestId, p.suggest_sim AS suggestSim,
          (SELECT name FROM persons WHERE id = p.suggest_id) AS suggestName,
          (SELECT crop FROM faces WHERE person_id = p.suggest_id ORDER BY ts DESC LIMIT 1) AS suggestCrop, COUNT(f.id) AS faces,
          (SELECT crop FROM faces WHERE person_id = p.id ORDER BY ts DESC LIMIT 1) AS crop,
          (SELECT COUNT(*) FROM event_subjects WHERE person_id = p.id) AS events
   FROM persons p LEFT JOIN faces f ON f.person_id = p.id GROUP BY p.id ORDER BY (p.name IS NULL), p.name, p.id`,
).all();

export const createPerson = (name, species = null) => Number(q('INSERT INTO persons (name, species, created) VALUES (?, ?, ?)').run(name || null, species, Date.now()).lastInsertRowid);
export const personExists = (id) => !!q('SELECT 1 FROM persons WHERE id = ?').get(id);
export const personSpecies = (id) => q('SELECT species FROM persons WHERE id = ?').get(id)?.species ?? null;
export const renamePerson = (id, name) => q('UPDATE persons SET name = ? WHERE id = ?').run(name || null, id);
export const personByName = (name) => q('SELECT * FROM persons WHERE lower(name) = lower(?)').get(name);
export const allPersonNames = () => q('SELECT id, name FROM persons WHERE name IS NOT NULL').all();

/** Segna che la persona/animale/veicolo `id` somiglia a `similarTo` (suggerimento da confermare nell'interfaccia). */
export const setSuggestion = (id, similarTo, sim) => q('UPDATE persons SET suggest_id = ?, suggest_sim = ? WHERE id = ?').run(similarTo, sim, id);
export const clearSuggestion = (id) => setSuggestion(id, null, null);

const VEHICLE_SPECIES = ['car', 'truck', 'bus', 'motorcycle', 'bicycle'];
/** Gruppo di un evento secondo il tipo (veicoli, animali o persone): i soggetti si scelgono dello stesso gruppo. */
export const subjectGroupOfKind = (kind) => (kind === 'vehicle' ? 'vehicles' : kind === 'pet' ? 'pets' : 'people');
export const subjectGroupOfSpecies = (species) => (!species ? 'people' : VEHICLE_SPECIES.includes(species) ? 'vehicles' : 'pets');

/** Segna che l'evento mostra il soggetto `personId` (persona, animale o veicolo). */
export const linkSubject = (eventId, personId) => { if (eventId && personId) q('INSERT OR IGNORE INTO event_subjects (event_id, person_id) VALUES (?, ?)').run(eventId, personId); };

/** Ricava le colonne "principali" dell'evento dai suoi soggetti: persona (prima) o animale, e veicolo. */
export function syncMains(eventId) {
  const subs = q(
    'SELECT s.person_id AS id, p.species FROM event_subjects s JOIN persons p ON p.id = s.person_id WHERE s.event_id = ? ORDER BY (p.species IS NOT NULL), s.rowid',
  ).all(eventId);
  const main = subs.find((s) => !s.species || !VEHICLE_SPECIES.includes(s.species));
  const vehicle = subs.find((s) => s.species && VEHICLE_SPECIES.includes(s.species));
  q('UPDATE events SET person_id = ?, vehicle_id = ? WHERE id = ?').run(main?.id ?? null, vehicle?.id ?? null, eventId);
}
const syncAll = (ids) => { for (const id of new Set(ids)) syncMains(id); };

export function deletePerson(id) {
  const crops = q('SELECT crop FROM faces WHERE person_id = ?').all(id).map((r) => r.crop).filter(Boolean);
  const evs = [
    ...q('SELECT event_id AS id FROM event_subjects WHERE person_id = ?').all(id).map((r) => r.id),
    ...q('SELECT id FROM events WHERE person_id = ? OR vehicle_id = ?').all(id, id).map((r) => r.id),
  ];
  q('DELETE FROM event_subjects WHERE person_id = ?').run(id);
  q('UPDATE persons SET suggest_id = NULL, suggest_sim = NULL WHERE suggest_id = ?').run(id);
  q('DELETE FROM faces WHERE person_id = ?').run(id);
  q('DELETE FROM persons WHERE id = ?').run(id);
  syncAll(evs); // gli eventi con altri soggetti ne prendono un altro come principale
  return crops;
}

export function mergePersons(fromId, intoId) {
  const evs = q('SELECT event_id AS id FROM event_subjects WHERE person_id = ?').all(fromId).map((r) => r.id);
  q('UPDATE faces SET person_id = ? WHERE person_id = ?').run(intoId, fromId);
  q('INSERT OR IGNORE INTO event_subjects (event_id, person_id) SELECT event_id, ? FROM event_subjects WHERE person_id = ?').run(intoId, fromId);
  q('DELETE FROM event_subjects WHERE person_id = ?').run(fromId);
  q('UPDATE events SET person_id = ? WHERE person_id = ?').run(intoId, fromId);
  q('UPDATE events SET vehicle_id = ? WHERE vehicle_id = ?').run(intoId, fromId);
  q('UPDATE persons SET suggest_id = NULL, suggest_sim = NULL WHERE suggest_id = ? OR id = ?').run(fromId, intoId);
  q('DELETE FROM persons WHERE id = ?').run(fromId);
  syncAll(evs);
}

// ---- correzione delle assegnazioni sbagliate ----
/** Un soggetto senza nome, senza immagini e senza eventi non serve piu. */
function pruneIfEmpty(id) {
  if (!id) return;
  const p = q('SELECT name FROM persons WHERE id = ?').get(id);
  if (!p || p.name) return;
  const n = q('SELECT (SELECT COUNT(*) FROM faces WHERE person_id = ?) + (SELECT COUNT(*) FROM event_subjects WHERE person_id = ?) AS n').get(id, id).n;
  if (!n) deletePerson(id);
}

/**
 * Cambia (`toId`) o toglie (toId = null) un soggetto di un evento, insieme alle immagini imparate da quell'evento per
 * quel soggetto. Con `fromId` null aggiunge semplicemente `toId` all'evento (un altro soggetto che compare nel video).
 * Restituisce i file di miniature da cancellare, oppure null se l'evento non esiste.
 */
export function replaceSubject(eventId, fromId, toId) {
  if (!q('SELECT 1 FROM events WHERE id = ?').get(eventId)) return null;
  const crops = [];
  if (fromId != null) {
    if (toId == null) {
      for (const f of q('SELECT id, crop FROM faces WHERE event_id = ? AND person_id = ?').all(eventId, fromId)) { if (f.crop) crops.push(f.crop); q('DELETE FROM faces WHERE id = ?').run(f.id); }
    } else {
      q('UPDATE faces SET person_id = ? WHERE event_id = ? AND person_id = ?').run(toId, eventId, fromId);
    }
    q('DELETE FROM event_subjects WHERE event_id = ? AND person_id = ?').run(eventId, fromId);
    // Eventi vecchi con la sola colonna principale, senza legame: la colonna si azzera/si riassegna qui sotto.
    q('UPDATE events SET person_id = NULL WHERE id = ? AND person_id = ?').run(eventId, fromId);
    q('UPDATE events SET vehicle_id = NULL WHERE id = ? AND vehicle_id = ?').run(eventId, fromId);
  }
  if (toId != null) linkSubject(eventId, toId);
  syncMains(eventId);
  if (fromId != null && fromId !== toId) pruneIfEmpty(fromId);
  return crops;
}

/** Toglie una singola immagine imparata; se era l'ultima di quel soggetto nell'evento, anche il soggetto dall'evento. */
export function removeFace(faceId) {
  const f = q('SELECT person_id, event_id, crop FROM faces WHERE id = ?').get(faceId);
  if (!f) return null;
  q('DELETE FROM faces WHERE id = ?').run(faceId);
  if (f.event_id && !q('SELECT 1 FROM faces WHERE event_id = ? AND person_id = ?').get(f.event_id, f.person_id)) {
    q('DELETE FROM event_subjects WHERE event_id = ? AND person_id = ?').run(f.event_id, f.person_id);
    q('UPDATE events SET person_id = NULL WHERE id = ? AND person_id = ?').run(f.event_id, f.person_id);
    q('UPDATE events SET vehicle_id = NULL WHERE id = ? AND vehicle_id = ?').run(f.event_id, f.person_id);
    syncMains(f.event_id);
  }
  pruneIfEmpty(f.person_id);
  return f.crop ? [f.crop] : [];
}

/** Sposta una singola immagine (e il soggetto dell'evento da cui viene) su un altro soggetto. */
export function moveFace(faceId, intoId) {
  const f = q('SELECT person_id, event_id FROM faces WHERE id = ?').get(faceId);
  if (!f) return false;
  q('UPDATE faces SET person_id = ? WHERE id = ?').run(intoId, faceId);
  if (f.event_id) {
    linkSubject(f.event_id, intoId);
    if (!q('SELECT 1 FROM faces WHERE event_id = ? AND person_id = ?').get(f.event_id, f.person_id)) {
      q('DELETE FROM event_subjects WHERE event_id = ? AND person_id = ?').run(f.event_id, f.person_id);
      q('UPDATE events SET person_id = NULL WHERE id = ? AND person_id = ?').run(f.event_id, f.person_id);
      q('UPDATE events SET vehicle_id = NULL WHERE id = ? AND vehicle_id = ?').run(f.event_id, f.person_id);
    }
    syncMains(f.event_id);
  }
  pruneIfEmpty(f.person_id);
  return true;
}

export const insertFace = (f) => Number(q(
  'INSERT INTO faces (person_id, event_id, embedding, crop, ts) VALUES (?, ?, ?, ?, ?)',
).run(f.personId, f.eventId ?? null, Buffer.from(f.embedding.buffer, f.embedding.byteOffset, f.embedding.byteLength), f.crop ?? null, f.ts).lastInsertRowid);

export const allFaces = () => q('SELECT f.id, f.person_id, f.embedding, p.species FROM faces f JOIN persons p ON p.id = f.person_id').all().map((r) => ({
  id: r.id,
  personId: r.person_id,
  species: r.species ?? null,
  embedding: new Float32Array(r.embedding.buffer.slice(r.embedding.byteOffset, r.embedding.byteOffset + r.embedding.byteLength)),
}));

export const facesOfPerson = (id) => q(
  'SELECT f.id, f.crop, f.ts, f.event_id AS eventId, e.cam_name AS camName FROM faces f LEFT JOIN events e ON e.id = f.event_id WHERE f.person_id = ? ORDER BY f.ts DESC LIMIT 60',
).all(id);
export const eventsWithoutRecognition = (limit = 200) => q(
  "SELECT * FROM events WHERE snapshot IS NOT NULL AND kind IN ('person','face','vehicle','pet') ORDER BY ts DESC LIMIT ?",
).all(limit).map(rowToEvent);

// ---------- utenti, sessioni, permessi ----------
const rowToUser = (r) => r && {
  id: r.id, username: r.username, displayName: r.display_name || '', role: r.role, pwHash: r.pw_hash,
  mustChange: !!r.must_change, disabled: !!r.disabled, created: r.created, lastLogin: r.last_login,
};
export const userCount = () => q('SELECT COUNT(*) AS n FROM users').get().n;
export const adminCount = () => q("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0").get().n;
export const getUserById = (id) => rowToUser(q('SELECT * FROM users WHERE id = ?').get(id));
export const getUserByName = (name) => rowToUser(q('SELECT * FROM users WHERE username = ?').get(name));
export const listUsers = () => q('SELECT * FROM users ORDER BY (role = \'admin\') DESC, username').all().map(rowToUser);
export const insertUser = (u) => Number(q(
  'INSERT INTO users (username, display_name, role, pw_hash, must_change, created) VALUES (?, ?, ?, ?, ?, ?)',
).run(u.username, u.displayName || null, u.role, u.pwHash, u.mustChange ? 1 : 0, Date.now()).lastInsertRowid);
export const updateUser = (id, p) => {
  const sets = [];
  const vals = [];
  const map = { username: 'username', displayName: 'display_name', role: 'role', pwHash: 'pw_hash' };
  for (const [k, col] of Object.entries(map)) if (p[k] !== undefined) { sets.push(`${col} = ?`); vals.push(p[k]); }
  if (p.mustChange !== undefined) { sets.push('must_change = ?'); vals.push(p.mustChange ? 1 : 0); }
  if (p.disabled !== undefined) { sets.push('disabled = ?'); vals.push(p.disabled ? 1 : 0); }
  if (sets.length) q(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
};
export const touchLogin = (id) => q('UPDATE users SET last_login = ? WHERE id = ?').run(Date.now(), id);
export const deleteUser = (id) => q('DELETE FROM users WHERE id = ?').run(id);

export const insertSession = (s) => q(
  'INSERT INTO sessions (token_hash, user_id, created, last_seen, expires, ip, ua) VALUES (?, ?, ?, ?, ?, ?, ?)',
).run(s.tokenHash, s.userId, s.created, s.created, s.expires, s.ip || null, (s.ua || '').slice(0, 200));
export const getSession = (hash) => q('SELECT * FROM sessions WHERE token_hash = ?').get(hash);
export const touchSession = (hash, now) => q('UPDATE sessions SET last_seen = ? WHERE token_hash = ?').run(now, hash);
export const deleteSession = (hash) => q('DELETE FROM sessions WHERE token_hash = ?').run(hash);
export const getRecovery = (userId) => {
  const r = q('SELECT * FROM recovery WHERE user_id = ?').get(userId);
  return r ? { questions: JSON.parse(r.questions), answers: JSON.parse(r.answers), updated: r.updated } : null;
};
export const setRecovery = (userId, questions, answers) => q(
  'INSERT INTO recovery (user_id, questions, answers, updated) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET questions = excluded.questions, answers = excluded.answers, updated = excluded.updated',
).run(userId, JSON.stringify(questions), JSON.stringify(answers), Date.now());
export const deleteRecovery = (userId) => q('DELETE FROM recovery WHERE user_id = ?').run(userId);
export const deleteUserSessions =(userId, exceptHash = null) => q('DELETE FROM sessions WHERE user_id = ? AND token_hash IS NOT ?').run(userId, exceptHash);
export const purgeSessions = (now) => q('DELETE FROM sessions WHERE expires < ?').run(now);
export const sessionCount = (userId) => q('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(userId).n;

export const getUserCameras = (userId) => new Map(q('SELECT camera_id, level FROM user_cameras WHERE user_id = ?').all(userId).map((r) => [r.camera_id, r.level]));
export function setUserCameras(userId, entries) {
  q('DELETE FROM user_cameras WHERE user_id = ?').run(userId);
  const ins = q('INSERT INTO user_cameras (user_id, camera_id, level) VALUES (?, ?, ?)');
  for (const [camId, level] of entries) if (level > 0) ins.run(userId, camId, level);
}
export const removeCameraFromAll = (camId) => q('DELETE FROM user_cameras WHERE camera_id = ?').run(camId);

export const counts = () => ({
  events: q('SELECT COUNT(*) AS n FROM events').get().n,
  persons: q('SELECT COUNT(*) AS n FROM persons').get().n,
  faces: q('SELECT COUNT(*) AS n FROM faces').get().n,
});
