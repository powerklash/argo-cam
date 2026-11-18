// Client P2P locale per telecamere Eufy (protocollo "PPPP" su UDP), senza cloud.
//
// Sequenza: ricerca in LAN (F1 30) -> la telecamera risponde con il suo DID (F1 41)
// -> CHECK_CAM (F1 41 + DID) -> CAM_ID (F1 42) = sessione aperta. I comandi viaggiano
// in messaggi DATA (F1 D0) numerati e confermati (F1 D1). Il video arriva sul canale
// dati "VIDEO" in blocchi con intestazione "XZYH"; i primi 128 byte di ogni fotogramma
// sono cifrati AES con una chiave che la telecamera consegna cifrata con la chiave RSA
// pubblica che le mandiamo nel comando di avvio.
//
// Formati ricavati dal progetto open source eufy-security-client (bropat).
import dgram from 'node:dgram';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

const T = {
  LOOKUP: 0x30, LOOKUP_RESP: 0x41, CHECK_CAM: 0x41, CAM_ID: 0x42,
  PING: 0xe0, PONG: 0xe1, DATA: 0xd0, ACK: 0xd1, END: 0xf0,
};
export const CMD = {
  GATEWAYINFO: 1100, PING: 1139, DOORBELL_SET_PAYLOAD: 1700, SET_PAYLOAD: 1350,
  START_REALTIME_MEDIA: 1003, STOP_REALTIME_MEDIA: 1004, VIDEO_FRAME: 1300, AUDIO_FRAME: 1301,
  CAMERA_INFO: 1103,
};
const MAGIC = Buffer.from('XZYH');
const frame = (type, payload = Buffer.alloc(0)) => {
  const head = Buffer.from([0xf1, type, 0, 0]);
  head.writeUInt16BE(payload.length, 2);
  return Buffer.concat([head, payload]);
};
const pad16 = (buf) => (buf.length % 16 === 0 && buf.length ? buf : Buffer.concat([buf, Buffer.alloc(16 - (buf.length % 16))]));
const aesEcb = (decrypt, key, data) => {
  const c = (decrypt ? crypto.createDecipheriv : crypto.createCipheriv)(`aes-${key.length * 8}-ecb`, key, null);
  c.setAutoPadding(false);
  return Buffer.concat([c.update(data), c.final()]);
};

function parseDid(buf) {
  const text = (b) => b.toString('latin1').replace(/\0+$/, '');
  return `${text(buf.subarray(0, 8))}-${String(buf.readUInt32BE(8)).padStart(6, '0')}-${text(buf.subarray(12, 20))}`;
}

export class EufySession extends EventEmitter {
  /** @param {{host: string, serial: string, log?: (msg: string) => void}} opts */
  constructor({ host, serial, accountId, log }) {
    super();
    this.host = host;
    this.serial = serial;
    this.accountId = accountId || '';
    this.p2pKey = null;   // chiave comandi "livello 2" (dal cifrario cloud); altrimenti si usa commandKey
    this.encType = 1;     // 1 = livello 1 (seriale+DID), 2 = livello 2 (chiave cifrario)
    this.log = log || (() => {});
    this.seq = 0;
    this.pending = new Map(); // seq -> { message, timer, cmd }
    this.streams = new Map(); // tipo dati -> { expected, queue, buf }
    this.closed = false;
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
    this.rsa = privateKey;
    this.rsaModulus = Buffer.from(publicKey.export({ format: 'jwk' }).n, 'base64url').toString('hex');
  }

  /** Chiave dei comandi (livello 1): ultimi 7 caratteri del seriale + 9 del DID dal primo trattino. */
  get commandKey() {
    const i = this.did.indexOf('-');
    return Buffer.from(this.serial.slice(-7) + this.did.slice(i, i + 9), 'latin1');
  }

  /** Chiave attiva per cifrare comandi e decifrare risposte. */
  get key() {
    return this.p2pKey || this.commandKey;
  }

  async connect(timeout = 12000) {
    this.sock = dgram.createSocket('udp4');
    this.sock.on('message', (msg, r) => this.#onMessage(msg, r));
    this.sock.on('error', (err) => this.emit('error', err));
    await new Promise((resolve) => this.sock.bind(0, resolve));
    this.sock.setBroadcast(true);
    try { this.sock.setRecvBufferSize(1 << 20); } catch { /* facoltativo */ }

    const subnet = this.host.replace(/\d+$/, '255');
    const started = Date.now();
    while (!this.connected) {
      if (this.closed) throw new Error('Sessione chiusa');
      if (Date.now() - started > timeout) {
        this.close();
        throw new Error(this.did ? 'La telecamera non ha aperto la sessione' : 'La telecamera non risponde alla ricerca locale');
      }
      if (!this.did) {
        // Le telecamere rispondono solo alla ricerca in broadcast: si filtra per indirizzo.
        for (const to of [this.host, subnet, '255.255.255.255']) this.#send(frame(T.LOOKUP), 32108, to);
      } else {
        this.#send(frame(T.CHECK_CAM, Buffer.concat([this.didRaw, Buffer.alloc(3)])));
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    this.keepalive = setInterval(() => this.#send(frame(T.PING)), 2000);
  }

  #send(buf, port = this.peer?.port, host = this.peer?.address) {
    if (this.closed || !port) return;
    this.sock.send(buf, port, host, () => {});
  }

  #onMessage(msg, r) {
    if (msg.length < 4 || msg[0] !== 0xf1 || r.address !== this.host) return;
    const type = msg[1];
    if (type === T.LOOKUP_RESP && !this.did && msg.length >= 24) {
      this.didRaw = Buffer.from(msg.subarray(4, 24));
      this.did = parseDid(this.didRaw);
      this.peer = { address: r.address, port: r.port };
    } else if (type === T.CAM_ID && !this.connected) {
      this.peer = { address: r.address, port: r.port };
      this.connected = true;
    } else if (type === T.PING) {
      this.#send(frame(T.PONG));
    } else if (type === T.END) {
      this.log('la telecamera ha chiuso la sessione');
      this.close();
      this.emit('close');
    } else if (type === T.ACK && msg.length >= 10) {
      const n = msg.readUInt16BE(6);
      for (let i = 0; i < n && 10 + i * 2 <= msg.length; i++) {
        const p = this.pending.get(msg.readUInt16BE(8 + i * 2));
        if (p && msg[5] === 0) { clearInterval(p.timer); p.acked = true; }
      }
    } else if (type === T.DATA && msg.length >= 8) {
      const kind = msg[5];
      const seq = msg.readUInt16BE(6);
      this.#send(frame(T.ACK, Buffer.from([0xd1, kind, 0, 1, seq >> 8, seq & 255])));
      this.#ordered(kind, seq, msg.subarray(8));
    }
  }

  // I pacchetti di ciascun tipo vanno rimessi in ordine di sequenza prima di ricomporre i blocchi.
  #ordered(kind, seq, payload) {
    let s = this.streams.get(kind);
    if (!s) this.streams.set(kind, (s = { expected: 0, queue: new Map(), buf: Buffer.alloc(0) }));
    const behind = (s.expected - seq + 65536) % 65536;
    if (behind > 0 && behind < 20000) return; // già elaborato
    s.queue.set(seq, Buffer.from(payload));
    while (s.queue.has(s.expected)) {
      s.buf = s.buf.length ? Buffer.concat([s.buf, s.queue.get(s.expected)]) : s.queue.get(s.expected);
      s.queue.delete(s.expected);
      s.expected = (s.expected + 1) % 65536;
    }
    // Un buco mai colmato bloccherebbe tutto: oltre una certa attesa si riparte dal più vecchio in coda.
    if (s.queue.size > 400) {
      s.expected = [...s.queue.keys()].sort((a, b) => ((a - s.expected + 65536) % 65536) - ((b - s.expected + 65536) % 65536))[0];
      s.buf = Buffer.alloc(0);
      this.emit('gap', kind);
      return this.#ordered(kind, s.expected, s.queue.get(s.expected));
    }
    this.#blocks(kind, s);
  }

  #blocks(kind, s) {
    for (;;) {
      const at = s.buf.indexOf(MAGIC);
      if (at < 0) { s.buf = s.buf.subarray(Math.max(0, s.buf.length - 3)); return; }
      if (at > 0) s.buf = s.buf.subarray(at);
      if (s.buf.length < 16) return;
      const size = s.buf.readUInt32LE(6);
      if (size > 4 << 20) { s.buf = s.buf.subarray(4); continue; }
      if (s.buf.length < 16 + size) return;
      const block = {
        kind, cmd: s.buf.readUInt16LE(4), channel: s.buf[12], sign: s.buf[13], type: s.buf[14],
        data: s.buf.subarray(16, 16 + size),
      };
      s.buf = s.buf.subarray(16 + size);
      try { this.#handle(block); } catch (err) { this.log(`blocco ${block.cmd} non interpretato: ${err.message}`); }
    }
  }

  #handle(b) {
    if (b.kind === 1 || b.kind === 3) {
      if (b.cmd === CMD.VIDEO_FRAME) return this.#video(b);
      if (b.cmd === CMD.AUDIO_FRAME) return this.emit('audio', b.data);
      return this.emit('other', b);
    }
    let data = b.data;
    if (b.kind === 0 && b.type === 1) {
      if (b.sign > 0 && data.length && data.length % 16 === 0) data = aesEcb(true, this.key, data);
      const code = data.length >= 4 ? data.readInt32LE(0) : 0;
      return this.emit('result', { cmd: b.cmd, code, data: data.subarray(4), sign: b.sign });
    }
    if (b.kind === 2 && b.sign > 0 && data.length && data.length % 16 === 0) {
      try { data = aesEcb(true, this.key, data); } catch { /* resta cifrato */ }
    }
    if (b.kind === 2) this.emit('control', { cmd: b.cmd, data });
    this.emit('other', { ...b, data });
  }

  #video(b) {
    const d = b.data;
    const length = d.readUInt32LE(0);
    const meta = {
      key: d[4] === 1, streamType: d[5], seq: d.readUInt16LE(6), fps: d.readUInt16LE(8),
      width: d.readUInt16LE(10), height: d.readUInt16LE(12),
    };
    // La chiave AES è portata (e usata) solo dal fotogramma che la contiene — i keyframe.
    // Gli altri fotogrammi arrivano in chiaro: decifrarli li corromperebbe.
    let start = 22;
    let aesKey = null;
    if (b.sign > 0 && length >= 128) {
      // Chiave AES cifrata RSA (PKCS#1 v1.5): si toglie il riempimento a mano.
      const raw = crypto.privateDecrypt({ key: this.rsa, padding: crypto.constants.RSA_NO_PADDING }, d.subarray(22, 150));
      const zero = raw.indexOf(0, 2);
      if (raw[0] === 0 && raw[1] === 2 && zero > 0) aesKey = raw.subarray(zero + 1);
      start = 151;
    }
    let video = d.subarray(start, start + length);
    if (aesKey && [16, 24, 32].includes(aesKey.length) && video.length >= 16) {
      const n = Math.min(128, video.length - (video.length % 16));
      video = Buffer.concat([aesEcb(true, aesKey, video.subarray(0, n)), video.subarray(n)]);
    }
    this.emit('video', video, meta);
  }

  /** Invia un comando e attende la conferma di ricezione (non il risultato). */
  command(cmd, payload) {
    const seq = this.seq;
    this.seq = (this.seq + 1) % 65536;
    const head = Buffer.alloc(10);
    head.writeUInt16BE(0xd100, 0);
    head.writeUInt16BE(seq, 2);
    MAGIC.copy(head, 4);
    head.writeUInt16LE(cmd, 8);
    const message = frame(T.DATA, Buffer.concat([head, payload]));
    const p = { cmd, tries: 0 };
    p.timer = setInterval(() => {
      if (++p.tries > 40) return clearInterval(p.timer);
      this.#send(message);
    }, 250);
    this.pending.set(seq, p);
    this.#send(message);
    return seq;
  }

  static payload(data, channel, encType = 0) {
    const head = Buffer.alloc(10);
    head.writeUInt16LE(data.length, 0);
    head.writeUInt16LE(1, 4);
    head[6] = channel;
    head[7] = encType;
    return Buffer.concat([head, data]);
  }

  gatewayInfo() {
    return this.command(CMD.GATEWAYINFO, EufySession.payload(Buffer.alloc(0), 255));
  }

  /**
   * Avvia lo streaming live. Per le telecamere T84A1 il comando è SetPayload IN CHIARO con
   * cmd=StartRealtimeMedia; `key` è il nostro modulo RSA pubblico, con cui la telecamera cifra
   * la chiave AES di ogni fotogramma (che decifriamo con la nostra chiave privata).
   */
  startLivestream({ codec = 'h264', channel = 0, mode = 'payload' } = {}) {
    // "doorbell": comando cifrato usato da altri modelli (es. SoloCam S340 T8170); "payload": comando in chiaro (T84A1, S40).
    if (mode === 'doorbell') {
      return this.json(CMD.DOORBELL_SET_PAYLOAD, {
        commandType: 1000,
        data: { accountId: this.accountId, encryptkey: this.rsaModulus, streamtype: codec === 'h265' ? 1 : 0 },
      }, { channel });
    }
    return this.json(CMD.SET_PAYLOAD, {
      account_id: this.accountId,
      cmd: CMD.START_REALTIME_MEDIA,
      mChannel: channel,
      mValue3: CMD.START_REALTIME_MEDIA,
      payload: { ClientOS: 'Android', camera_type: 0, entrytype: 0, key: this.rsaModulus, streamtype: codec === 'h265' ? 2 : 1 },
    }, { encrypted: false, channel });
  }

  /** Parametri della telecamera letti in locale: [{ param_type, param_value }, …] (JSON della telecamera). */
  cameraInfo(timeout = 8000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.off('control', on); reject(new Error('La telecamera non ha risposto')); }, timeout);
      const on = (c) => {
        if (c.cmd !== CMD.CAMERA_INFO) return;
        clearTimeout(timer);
        this.off('control', on);
        const end = c.data.indexOf(0);
        try { resolve(JSON.parse(c.data.subarray(0, end < 0 ? c.data.length : end).toString('utf8'))); } catch (err) { reject(err); }
      };
      this.on('control', on);
      const value = Buffer.alloc(4);
      value.writeUInt32LE(255);
      this.command(CMD.CAMERA_INFO, EufySession.payload(value, 255));
    });
  }

  /** Imposta un parametro con il comando "doorbell payload" (cifrato): { commandType, data }. */
  setParam(commandType, data, channel = 0) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.off('result', on); resolve({ code: null }); }, 6000);
      const on = (r) => {
        if (r.cmd !== CMD.DOORBELL_SET_PAYLOAD) return;
        clearTimeout(timer);
        this.off('result', on);
        resolve({ code: r.code });
      };
      this.on('result', on);
      this.json(CMD.DOORBELL_SET_PAYLOAD, { commandType, data }, { channel });
    });
  }

  stopLivestream(channel = 0) {
    return this.command(CMD.STOP_REALTIME_MEDIA, EufySession.payload(Buffer.alloc(0), channel));
  }

  /** Comando con testo JSON; `encrypted` usa la chiave di livello 1 derivata da seriale e DID. */
  json(cmd, value, { channel = 0, encrypted = true } = {}) {
    let data = Buffer.from(JSON.stringify(value));
    if (encrypted) data = aesEcb(false, this.key, pad16(data));
    return this.command(cmd, EufySession.payload(data, channel, encrypted ? this.encType : 0));
  }

  close() {
    if (this.closed) return;
    this.#send(frame(T.END));
    this.closed = true;
    clearInterval(this.keepalive);
    for (const p of this.pending.values()) clearInterval(p.timer);
    setTimeout(() => { try { this.sock.close(); } catch { /* già chiuso */ } }, 100);
  }
}
