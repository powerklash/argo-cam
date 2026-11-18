// Ricerca locale di dispositivi Eufy (telecamere e HomeBase) senza cloud.
//
// I dispositivi Eufy parlano il protocollo P2P "PPPP" (CS2 Network) su UDP 32108.
// Un pacchetto LAN_SEARCH (F1 30 00 00) in broadcast li fa rispondere con
// PUNCH_PKT (F1 41) che contiene il loro identificativo P2P (DID): PREFISSO-NUMERO-CODICE.
//
// Uso:  node tools/eufy-discover.js [ip-o-broadcast ...]
//       senza argomenti usa il broadcast di ogni interfaccia di rete.
import dgram from 'node:dgram';
import os from 'node:os';

const PORT = 32108;
const LAN_SEARCH = Buffer.from([0xf1, 0x30, 0x00, 0x00]);

function broadcastAddresses() {
  const out = new Set(['255.255.255.255']);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const ip = a.address.split('.').map(Number);
      const mask = a.netmask.split('.').map(Number);
      out.add(ip.map((b, i) => (b | (~mask[i] & 255))).join('.'));
    }
  }
  return [...out];
}

function parseDid(msg) {
  // F1 41 <len:2> <prefisso:8 ASCII> <numero:4 BE> <codice:8 ASCII>
  if (msg.length < 24 || msg[0] !== 0xf1 || msg[1] !== 0x41) return null;
  const text = (buf) => buf.toString('latin1').replace(/\0+$/, '');
  const prefix = text(msg.subarray(4, 12));
  const serial = String(msg.readUInt32BE(12)).padStart(6, '0');
  const check = text(msg.subarray(16, 24));
  return /^[A-Z0-9]+$/.test(prefix) ? `${prefix}-${serial}-${check}` : null;
}

const targets = process.argv.slice(2).length ? process.argv.slice(2) : broadcastAddresses();
const found = new Map();
const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });

sock.on('message', (msg, from) => {
  const did = parseDid(msg);
  const key = from.address;
  if (found.has(key)) return;
  found.set(key, did);
  console.log(`${from.address.padEnd(16)} ${did || `risposta non riconosciuta: ${msg.subarray(0, 32).toString('hex')}`}`);
});

sock.bind(() => {
  sock.setBroadcast(true);
  console.log(`Ricerca su UDP ${PORT} verso: ${targets.join(', ')}`);
  let rounds = 0;
  const send = () => {
    for (const t of targets) sock.send(LAN_SEARCH, PORT, t, () => {});
    if (++rounds < 4) setTimeout(send, 500);
  };
  send();
  setTimeout(() => {
    console.log(found.size ? `\n${found.size} dispositivo/i trovato/i.` : '\nNessuna risposta.');
    sock.close();
  }, 4000);
});
