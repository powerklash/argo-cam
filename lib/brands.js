// Driver per marca: ogni marca dichiara i campi del modulo e come costruire
// le sorgenti go2rtc (flusso principale ad alta risoluzione + flusso secondario
// leggero per la griglia). Per aggiungere una marca basta aggiungere una voce qui.

const enc = encodeURIComponent;
const auth = (p) =>
  p.username ? `${enc(p.username)}${p.password ? ':' + enc(p.password) : ''}@` : '';
const pad2 = (n) => String(n).padStart(2, '0');

const F = {
  host: { key: 'host', label: 'Indirizzo IP / host', type: 'text', required: true, placeholder: '192.168.1.50' },
  username: { key: 'username', label: 'Utente', type: 'text', default: 'admin' },
  password: { key: 'password', label: 'Password', type: 'password' },
  channel: { key: 'channel', label: 'Canale (NVR / Hub)', type: 'number', default: 1, min: 1, max: 64 },
  port: (placeholder) => ({ key: 'port', label: 'Porta (opzionale)', type: 'number', placeholder, min: 1, max: 65535 }),
};

const rtsp = (p, path, defPort = 554) => `rtsp://${auth(p)}${p.host}:${p.port || defPort}${path}`;

export const BRANDS = {
  reolink: {
    label: 'Reolink',
    note:
      'Abilita RTSP nella telecamera (Impostazioni → Rete → Avanzate → Impostazioni porta). ' +
      'Le telecamere a batteria non espongono flussi diretti: aggiungile tramite Home Hub / NVR ' +
      "usando l'IP dell'hub e il numero di canale.",
    fields: [
      F.host,
      F.username,
      F.password,
      {
        key: 'protocol', label: 'Protocollo', type: 'select', default: 'rtsp',
        options: [
          { value: 'rtsp', label: 'RTSP (porta 554)' },
          { value: 'flv', label: 'HTTP-FLV (porta 80)' },
        ],
      },
      F.channel,
      F.port('554 RTSP / 80 HTTP'),
    ],
    build(p) {
      const ch = p.channel || 1;
      if (p.protocol === 'flv') {
        const flv = (s) =>
          `http://${p.host}:${p.port || 80}/flv?port=1935&app=bcs&stream=channel${ch - 1}_${s}.bcs` +
          `&user=${enc(p.username || '')}&password=${enc(p.password || '')}`;
        return { main: [flv('main')], sub: [flv('ext')] };
      }
      const n = pad2(ch);
      // backchannel=0: niente audio bidirezionale, che su Reolink rallenta la negoziazione RTSP.
      const url = (path) => rtsp(p, path) + '#backchannel=0';
      return {
        main: [url(`/h264Preview_${n}_main`), url(`/h265Preview_${n}_main`)],
        sub: [url(`/h264Preview_${n}_sub`)],
      };
    },
  },

  eufy: {
    label: 'Eufy',
    note:
      "Nell'app Eufy abilita «Archiviazione → NAS (RTSP)» sulla telecamera e imposta utente e password RTSP. " +
      "Per le telecamere collegate a una HomeBase usa l'IP della HomeBase: ogni telecamera ha un numero di flusso " +
      '(live0, live1, …). I modelli a batteria trasmettono in RTSP solo durante gli eventi; ' +
      'i modelli senza RTSP richiedono il cloud Eufy e non sono supportati.',
    fields: [
      F.host,
      { ...F.username, default: '' },
      F.password,
      { key: 'stream', label: 'Numero flusso (live0, live1, …)', type: 'number', default: 0, min: 0, max: 31 },
      F.port('554'),
    ],
    build(p) {
      const url = rtsp(p, `/live${p.stream || 0}`);
      return { main: [url], sub: [url] };
    },
  },

  eufyp2p: {
    label: 'Eufy (locale, senza cloud)',
    note:
      'Per le telecamere Eufy che NON espongono RTSP (la maggior parte). Il video passa dal ' +
      'protocollo locale Eufy, senza cloud. Richiede un accesso una-tantum al cloud Eufy per leggere ' +
      "l'identificativo dell'account: esegui tools/eufy-login (node login.mjs). Usa l'IP della telecamera " +
      '(o della HomeBase) e il suo numero di serie. I modelli a batteria trasmettono solo da svegli.',
    fields: [
      // L'IP è facoltativo: se vuoto (o cambiato) la telecamera si cerca in rete tramite il suo identificativo.
      { ...F.host, required: false, placeholder: 'vuoto = ricerca automatica' },
      { key: 'serial', label: 'Numero di serie (16 caratteri)', type: 'text', required: true, placeholder: 'T8xxxxxxxxxxxxxx' },
    ],
    // Le sorgenti go2rtc sono generate dal server (serve l'id della telecamera e la porta locale).
    build() {
      return { main: [], sub: [] };
    },
  },

  hikvision: {
    label: 'Hikvision',
    fields: [F.host, F.username, F.password, F.channel, F.port('554')],
    build(p) {
      const ch = p.channel || 1;
      return {
        main: [rtsp(p, `/Streaming/Channels/${ch}01`)],
        sub: [rtsp(p, `/Streaming/Channels/${ch}02`)],
      };
    },
  },

  dahua: {
    label: 'Dahua / Amcrest / Imou',
    fields: [F.host, F.username, F.password, F.channel, F.port('554')],
    build(p) {
      const ch = p.channel || 1;
      return {
        main: [rtsp(p, `/cam/realmonitor?channel=${ch}&subtype=0`)],
        sub: [rtsp(p, `/cam/realmonitor?channel=${ch}&subtype=1`)],
      };
    },
  },

  tapo: {
    label: 'TP-Link Tapo',
    note: "Crea un «account telecamera» nell'app Tapo (Impostazioni avanzate) e usa quelle credenziali.",
    fields: [F.host, { ...F.username, default: '' }, F.password, F.port('554')],
    build(p) {
      return { main: [rtsp(p, '/stream1')], sub: [rtsp(p, '/stream2')] };
    },
  },

  onvif: {
    label: 'ONVIF (generico)',
    note: 'Funziona con la maggior parte delle telecamere IP che supportano ONVIF.',
    fields: [F.host, F.username, F.password, F.port('80')],
    build(p) {
      const base = `onvif://${auth(p)}${p.host}:${p.port || 80}`;
      return { main: [`${base}?subtype=0`], sub: [`${base}?subtype=1`, `${base}?subtype=0`] };
    },
  },

  custom: {
    label: 'URL personalizzato (RTSP / HTTP)',
    note: 'Inserisci direttamente gli URL dei flussi. Il flusso secondario è opzionale.',
    fields: [
      { key: 'mainUrl', label: 'URL flusso principale', type: 'text', required: true, placeholder: 'rtsp://utente:password@192.168.1.50:554/stream1' },
      { key: 'subUrl', label: 'URL flusso secondario', type: 'text', placeholder: 'rtsp://…/stream2' },
    ],
    build(p) {
      return { main: [p.mainUrl], sub: [p.subUrl || p.mainUrl] };
    },
  },

  demo: {
    label: 'Demo (immagine di prova)',
    note: 'Flusso di prova generato con ffmpeg, utile per provare la griglia senza telecamere.',
    fields: [],
    build() {
      const gen = (src) =>
        `exec:ffmpeg -hide_banner -loglevel error -re -f lavfi -i ${src} -c:v libx264 -preset ultrafast ` +
        `-tune zerolatency -g 30 -pix_fmt yuv420p -rtsp_transport tcp -f rtsp {output}`;
      return {
        main: [gen('testsrc2=size=1280x720:rate=15')],
        sub: [gen('testsrc=size=640x360:rate=15')],
      };
    },
  },
};

const URL_OK = /^(rtsps?|https?|rtmp|onvif):\/\/\S+$/i;
const HOST_OK = /^[A-Za-z0-9._-]+$/;

/** Valida e normalizza i parametri ricevuti dal modulo. Lancia Error con messaggio leggibile. */
export function normalizeParams(brandId, input, previous = {}) {
  const brand = BRANDS[brandId];
  if (!brand) throw new Error('Marca non supportata');
  const out = {};
  for (const f of brand.fields) {
    let v = input?.[f.key];
    if (typeof v === 'string') v = v.trim();
    // Password vuota in modifica = mantieni quella salvata.
    if (f.type === 'password' && (v === undefined || v === '') && previous[f.key]) v = previous[f.key];
    if (v === undefined || v === null || v === '') {
      if (f.required) throw new Error(`Campo obbligatorio: ${f.label}`);
      if (f.default !== undefined && f.type !== 'password') out[f.key] = f.default;
      continue;
    }
    if (f.type === 'number') {
      v = Number(v);
      if (!Number.isInteger(v) || v < (f.min ?? 0) || v > (f.max ?? Infinity))
        throw new Error(`Valore non valido: ${f.label}`);
    } else if (f.type === 'select') {
      if (!f.options.some((o) => o.value === v)) throw new Error(`Valore non valido: ${f.label}`);
    } else {
      v = String(v);
      if (f.key === 'host' && !HOST_OK.test(v)) throw new Error('Indirizzo non valido (solo IP o nome host)');
      if (f.key.endsWith('Url') && !URL_OK.test(v))
        throw new Error(`${f.label}: deve iniziare con rtsp://, http://, rtmp:// o onvif://`);
    }
    out[f.key] = v;
  }
  return out;
}

export function buildSources(camera) {
  return BRANDS[camera.brand].build(camera.params || {});
}

/** Descrizione delle marche per il frontend (senza funzioni). */
export function publicBrands() {
  return Object.entries(BRANDS).map(([id, b]) => ({ id, label: b.label, note: b.note || '', fields: b.fields }));
}

/** Telecamera senza segreti, per il frontend. */
export function publicCamera(camera) {
  const brand = BRANDS[camera.brand];
  const params = { ...camera.params };
  for (const f of brand?.fields || []) if (f.type === 'password') delete params[f.key];
  return {
    id: camera.id,
    name: camera.name,
    brand: camera.brand,
    params,
    preload: camera.preload !== false,
    battery: camera.battery === true,
    wakeLimit: camera.wakeLimit ?? null,
    alerts: camera.alerts !== false,
    saveEvents: camera.saveEvents !== false,
    ha: (camera.ha || []).map((h, i) => ({ i, ...h })),
    hasPassword: !!camera.params?.password,
  };
}
