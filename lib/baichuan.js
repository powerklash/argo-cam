// Client minimo del protocollo "Baichuan" di Reolink (TCP, porta 9000).
//
// Serve per le funzioni che l'API HTTP non offre, qui la modalità privacy (comandi 574 lettura e
// 575 scrittura), come fa l'integrazione Home Assistant. Formato ricavato da reolink_aio:
//  - intestazione: magic f0debc0a, id comando, lunghezza, canale + id messaggio, classe (20 o 24 byte);
//  - accesso: richiesta del "nonce" (cifratura BC), poi utente/password come MD5 + nonce;
//  - dopo l'accesso i messaggi sono cifrati AES-128-CFB con chiave = MD5("nonce-password")[0:16].
import net from 'node:net';
import crypto from 'node:crypto';

const MAGIC = Buffer.from('f0debc0a', 'hex');
const MAGIC_REV = Buffer.from('0abcdef0', 'hex');
const XML_KEY = [0x1f, 0x2d, 0x3c, 0x4b, 0x5a, 0x69, 0x78, 0xff];
const AES_IV = Buffer.from('0123456789abcdef');
const HOST_CH = 250;
const PORT = 9000;
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" ?>\n';

const md5 = (s) => crypto.createHash('md5').update(s, 'utf8').digest('hex').toUpperCase().slice(0, 31);
const bc = (buf, offset) => Buffer.from(buf.map((b, i) => b ^ XML_KEY[(offset + i) % 8] ^ (offset & 255)));

const extXml = (channel) => `${XML_HEAD}<Extension version="1.1">\n<channelId>${channel}</channelId>\n</Extension>\n`;
const LOGIN_XML = (user, pass) =>
  `${XML_HEAD}<body>\n<LoginUser version="1.1">\n<userName>${user}</userName>\n<password>${pass}</password>\n<userVer>1</userVer>\n</LoginUser>\n` +
  '<LoginNet version="1.1">\n<type>LAN</type>\n<udpPort>0</udpPort>\n</LoginNet>\n</body>\n';
const PRIVACY_XML = (enable) =>
  `${XML_HEAD}<body>\n<sleepState version="1.1">\n<operate>2</operate>\n<sleep>${enable}</sleep>\n</sleepState>\n</body>\n`;

class Connection {
  constructor(host, user, password, log = () => {}) {
    this.host = host;
    this.user = user;
    this.password = password;
    this.log = log;
    this.mid = 0;
    this.buf = Buffer.alloc(0);
    this.waiting = new Map(); // `${cmd}:${mid}` -> resolve
    this.aesKey = null;
  }

  connect(timeout = 6000) {
    return new Promise((resolve, reject) => {
      this.sock = net.connect({ host: this.host, port: PORT, timeout });
      this.sock.once('connect', () => { this.sock.setTimeout(0); resolve(); });
      this.sock.once('timeout', () => { this.sock.destroy(); reject(new Error('Baichuan: porta 9000 non raggiungibile')); });
      this.sock.on('error', (err) => { this.closed = true; reject(err); });
      this.sock.on('close', () => { this.closed = true; for (const w of this.waiting.values()) w(null); this.waiting.clear(); });
      this.sock.on('data', (d) => this.#onData(d));
    });
  }

  #onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (this.buf.length < 20) return;
      const magic = this.buf.subarray(0, 4);
      if (!magic.equals(MAGIC) && !magic.equals(MAGIC_REV)) { this.sock.destroy(); return; }
      const cls = this.buf.readUInt16LE(18);
      // Intestazione di 20 byte solo per le classi legacy; tutte le altre (anche i messaggi spontanei dell'hub) di 24.
      const hlen = cls === 0x6514 || cls === 0x6614 ? 20 : 24;
      if (this.buf.length < hlen) return;
      const len = this.buf.readUInt32LE(8);
      if (this.buf.length < hlen + len) return;
      const msg = {
        cmd: this.buf.readUInt32LE(4),
        chByte: this.buf[12],
        mid: this.buf.readUIntLE(13, 3),
        code: this.buf.readUInt16LE(16),
        offset: hlen === 24 ? this.buf.readUInt32LE(20) : 0,
        payload: Buffer.from(this.buf.subarray(hlen, hlen + len)),
      };
      this.buf = this.buf.subarray(hlen + len);
      const key = `${msg.cmd}:${msg.mid}`;
      const w = this.waiting.get(key);
      if (w) { this.waiting.delete(key); w(msg); }
    }
  }

  #aes(buf, decrypt) {
    const c = (decrypt ? crypto.createDecipheriv : crypto.createCipheriv)('aes-128-cfb', this.aesKey, AES_IV);
    return Buffer.concat([c.update(buf), c.final()]);
  }

  /** Invia un comando e attende la risposta con lo stesso id. Restituisce { code, text } (testo = estensione + corpo in chiaro). */
  request({ cmd, chId, cls = '1464', ext = '', body = '', enc, timeout = 6000 }) {
    const mid = (this.mid = (this.mid + 1) % 0xffffff);
    const extB = Buffer.from(ext);
    const bodyB = Buffer.from(body);
    const useAes = enc === 'aes';
    const payload = useAes
      ? Buffer.concat([extB.length ? this.#aes(extB) : extB, bodyB.length ? this.#aes(bodyB) : bodyB])
      : Buffer.concat([bc(extB, chId), bc(bodyB, chId)]);
    const legacy = cls === '1465';
    const head = Buffer.alloc(legacy ? 20 : 24);
    MAGIC.copy(head, 0);
    head.writeUInt32LE(cmd, 4);
    head.writeUInt32LE(payload.length, 8);
    head[12] = chId;
    head.writeUIntLE(mid, 13, 3);
    if (legacy) head.set([0x12, 0xdc, 0x14, 0x65], 16);
    else { head.set([0x00, 0x00, 0x14, 0x64], 16); head.writeUInt32LE(extB.length, 20); }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiting.delete(`${cmd}:${mid}`); reject(new Error('Baichuan: nessuna risposta')); }, timeout);
      this.waiting.set(`${cmd}:${mid}`, (msg) => {
        clearTimeout(timer);
        if (!msg) return reject(new Error('Baichuan: connessione chiusa'));
        let text = '';
        try {
          const dec = (b, aes) => (b.length ? (aes ? this.#aes(b, true) : bc(b, msg.chByte)).toString('utf8') : '');
          const aesResp = useAes && this.aesKey;
          text = dec(msg.payload.subarray(0, msg.offset), aesResp) + dec(msg.payload.subarray(msg.offset), aesResp);
        } catch { /* corpo illeggibile: resta il codice */ }
        resolve({ code: msg.code, text });
      });
      this.sock.write(Buffer.concat([head, payload]));
    });
  }

  async login() {
    const nonceResp = await this.request({ cmd: 1, chId: HOST_CH, cls: '1465', enc: 'bc' });
    const nonce = /<nonce>([^<]+)<\/nonce>/.exec(nonceResp.text)?.[1];
    if (!nonce) throw new Error('Baichuan: nonce non ricevuto');
    const r = await this.request({
      cmd: 1, chId: HOST_CH, enc: 'bc',
      body: LOGIN_XML(md5(`${this.user}${nonce}`), md5(`${this.password}${nonce}`)),
    });
    if (r.code !== 200) throw new Error(`Accesso Baichuan rifiutato (${r.code})`);
    this.aesKey = Buffer.from(md5(`${nonce}-${this.password}`).slice(0, 16), 'utf8');
  }

  close() {
    this.sock?.destroy();
  }
}

// ---------- sessioni condivise (una per hub/telecamera) ----------
const sessions = new Map();
const keyOf = (cam) => `${cam.params.host}|${cam.params.username || 'admin'}|${crypto.createHash('sha1').update(cam.params.password || '').digest('hex').slice(0, 8)}`;

async function session(cam) {
  const key = keyOf(cam);
  let s = sessions.get(key);
  if (s?.blockedUntil > Date.now()) throw new Error(`Accesso Baichuan sospeso (${s.error})`);
  if (s?.conn && !s.conn.closed && s.conn.aesKey) { clearTimeout(s.idle); return arm(s, key); }
  s = sessions.get(key) || { queue: Promise.resolve() };
  sessions.set(key, s);
  const conn = new Connection(cam.params.host, cam.params.username || 'admin', cam.params.password || '');
  try {
    await conn.connect();
    await conn.login();
  } catch (err) {
    conn.close();
    // Un accesso rifiutato non si ripete subito: troppi tentativi bloccano l'account.
    if (/rifiutato/.test(err.message)) { s.blockedUntil = Date.now() + 5 * 60_000; s.error = err.message; }
    throw err;
  }
  s.conn = conn;
  return arm(s, key);
}

// La connessione si chiude da sola dopo 60 s di inattività.
function arm(s, key) {
  clearTimeout(s.idle);
  s.idle = setTimeout(() => { s.conn?.close(); sessions.delete(key); }, 60_000);
  s.idle.unref?.();
  return s;
}

/** Esegue `fn(connessione)` in coda per questo hub/telecamera. */
function run(cam, fn) {
  const key = keyOf(cam);
  const prev = sessions.get(key)?.queue || Promise.resolve();
  const job = prev.catch(() => {}).then(async () => fn((await session(cam)).conn));
  const s = sessions.get(key) || { queue: Promise.resolve() };
  s.queue = job.catch(() => {});
  sessions.set(key, s);
  return job;
}

const channelOf = (cam) => (cam.params.channel || 1) - 1;

/** Stato della modalità privacy: true/false, oppure null se la telecamera non la supporta. */
export function getPrivacy(cam) {
  return run(cam, async (c) => {
    const ch = channelOf(cam);
    const r = await c.request({ cmd: 574, chId: ch + 1, enc: 'aes', ext: extXml(ch) });
    const m = /<sleep>\s*([01])\s*<\/sleep>/.exec(r.text);
    if (r.code === 200 && m) return m[1] === '1';
    return null;
  });
}

/** Attiva o disattiva la modalità privacy e restituisce lo stato riletto dalla telecamera. */
export function setPrivacy(cam, enable) {
  return run(cam, async (c) => {
    const ch = channelOf(cam);
    const r = await c.request({ cmd: 575, chId: ch + 1, enc: 'aes', ext: extXml(ch), body: PRIVACY_XML(enable ? 1 : 0) });
    if (r.code !== 200) throw new Error(`La telecamera ha rifiutato il comando (${r.code})`);
    await new Promise((res) => setTimeout(res, 600));
    const g = await c.request({ cmd: 574, chId: ch + 1, enc: 'aes', ext: extXml(ch) });
    const m = /<sleep>\s*([01])\s*<\/sleep>/.exec(g.text);
    return m ? m[1] === '1' : !!enable;
  });
}

/** Solo per diagnostica: risposta grezza (codice e testo) alla lettura della privacy. */
export function debugPrivacy(cam, timeout = 6000) {
  return run(cam, async (c) => {
    const ch = channelOf(cam);
    return c.request({ cmd: 574, chId: ch + 1, enc: 'aes', ext: extXml(ch), timeout });
  });
}

export function closeAll() {
  for (const s of sessions.values()) s.conn?.close();
  sessions.clear();
}
