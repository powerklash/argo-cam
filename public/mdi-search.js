// Ricerca intelligente delle icone di Home Assistant (Material Design Icons, "mdi:nome"), come nel selettore di
// Home Assistant: si scrive una parola e compaiono le icone il cui nome o le cui parole chiave la contengono.
// Funziona anche in italiano, francese, tedesco e spagnolo (dizionario dei termini della casa qui sotto) e tollera
// piccoli errori di battitura. L'elenco (public/mdi.json, ~2,6 MB compresso a ~0,7 MB) si scarica una sola volta.
let loading = null;
let index = null; // [{ name, d, words, hay }]
let byName = null;

/** Scarica (una volta) l'elenco delle icone: restituisce una mappa nome -> tracciato SVG (viewBox 24×24). */
export function loadMdi() {
  if (!loading) {
    loading = fetch('/mdi.json').then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }).then((j) => {
      index = j.icons.map(([name, d, kw]) => ({ name, d, kw, hay: ` ${name.replace(/-/g, ' ')} ` }));
      byName = new Map(index.map((i) => [i.name, i]));
      return byName;
    }).catch((err) => { loading = null; throw err; });
  }
  return loading;
}

export const mdiLoaded = () => !!byName;
export const mdiPath = (name) => byName?.get(name)?.d || null;

const strip = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

// Termini della casa nelle lingue dell'interfaccia -> parole usate dai nomi/parole chiave delle icone.
const SYN = {
  // italiano
  cancello: 'gate', cancelli: 'gate', porta: 'door', porte: 'door', portone: 'gate garage', finestra: 'window', finestre: 'window',
  luce: 'light lightbulb', luci: 'light lightbulb', lampada: 'lamp', lampadina: 'lightbulb', serratura: 'lock', lucchetto: 'lock', chiave: 'key',
  allarme: 'alarm', sirena: 'alarm+light siren', campanello: 'bell', telecamera: 'cctv video', videocamera: 'cctv video', sorveglianza: 'cctv',
  temperatura: 'thermometer', termometro: 'thermometer', umidita: 'water+percent humidity', vento: 'weather+windy wind', pioggia: 'weather+rainy rain',
  neve: 'snowflake snow', sole: 'weather+sunny sun', soleggiato: 'weather+sunny', luna: 'moon', notte: 'moon night', nuvola: 'cloud', nuvoloso: 'weather+cloudy',
  fuoco: 'fire', incendio: 'fire', fumo: 'smoke', acqua: 'water', allagamento: 'water+alert flood', perdita: 'water+alert', tubo: 'pipe', rubinetto: 'faucet',
  doccia: 'shower', piscina: 'pool', giardino: 'flower garden', fiore: 'flower', irrigazione: 'sprinkler', garage: 'garage', auto: 'car', macchina: 'car',
  moto: 'motorbike motorcycle', bici: 'bicycle bike', bicicletta: 'bicycle', parcheggio: 'parking', riscaldamento: 'radiator heat', caldaia: 'water+boiler boiler',
  condizionatore: 'air+conditioner', climatizzatore: 'air+conditioner', ventilatore: 'fan', tapparella: 'window+shutter blinds', tapparelle: 'window+shutter blinds',
  tenda: 'curtains', persiana: 'blinds', presa: 'power+socket plug', spina: 'power+plug', interruttore: 'light+switch toggle+switch', batteria: 'battery',
  energia: 'flash lightning', corrente: 'flash lightning', elettricita: 'flash lightning', fotovoltaico: 'solar+panel', solare: 'solar+panel', segnale: 'signal wifi',
  sensore: 'sensor', movimento: 'motion+sensor run', presenza: 'account home presence', casa: 'home house', ingresso: 'door+open', cucina: 'stove fridge',
  bagno: 'shower toilet', letto: 'bed', divano: 'sofa', televisione: 'television', musica: 'music', altoparlante: 'speaker', microfono: 'microphone',
  pacco: 'package', posta: 'mail mailbox', cane: 'dog', gatto: 'cat', animale: 'paw', orologio: 'clock', calendario: 'calendar', impostazioni: 'cog settings',
  scudo: 'shield', sicurezza: 'security shield', aperto: 'open', chiuso: 'closed', telecomando: 'remote', aspirapolvere: 'robot+vacuum', lavatrice: 'washing+machine',
  lavastoviglie: 'dishwasher', forno: 'stove oven', frigorifero: 'fridge', caffe: 'coffee', ventola: 'fan', riscaldare: 'heat', raffreddare: 'snowflake',
  // français
  portail: 'gate', fenetre: 'window', lumiere: 'light lightbulb', lampe: 'lamp', serrure: 'lock', cle: 'key', sonnette: 'bell', camera: 'cctv video', chaleur: 'heat',
  humidite: 'water+percent humidity', pluie: 'weather+rainy rain', soleil: 'weather+sunny sun', lune: 'moon', nuage: 'cloud', feu: 'fire', fumee: 'smoke', eau: 'water',
  voiture: 'car', velo: 'bicycle', chauffage: 'radiator heat', chaudiere: 'water+boiler boiler', climatisation: 'air+conditioner', volet: 'window+shutter blinds', rideau: 'curtains',
  prise: 'power+socket plug', interrupteur: 'light+switch toggle+switch', maison: 'home house', jardin: 'flower garden', arrosage: 'sprinkler', piscine: 'pool', chien: 'dog',
  chat: 'cat', colis: 'package', courrier: 'mail mailbox', horloge: 'clock', ordinateur: 'laptop', ouvert: 'open', ferme: 'closed',
  // deutsch
  tor: 'gate', tur: 'door', fenster: 'window', licht: 'light lightbulb', lampe_: 'lamp', schloss: 'lock', schlussel: 'key', klingel: 'bell', luftfeuchtigkeit: 'water+percent humidity',
  regen: 'weather+rainy rain', sonne: 'weather+sunny sun', mond: 'moon', wolke: 'cloud', feuer: 'fire', rauch: 'smoke', wasser: 'water', auto_: 'car', fahrrad: 'bicycle',
  heizung: 'radiator heat', klimaanlage: 'air+conditioner', rollladen: 'window+shutter blinds', vorhang: 'curtains', steckdose: 'power+socket plug', schalter: 'light+switch toggle+switch',
  haus: 'home house', garten: 'flower garden', bewasserung: 'sprinkler', schwimmbad: 'pool', hund: 'dog', katze: 'cat', paket: 'package', uhr: 'clock', offen: 'open', geschlossen: 'closed',
  temperatur: 'thermometer', wind: 'weather+windy wind', schnee: 'snowflake snow', batterie: 'battery', strom: 'flash lightning', bewegung: 'motion+sensor run',
  // español
  puerta: 'door', ventana: 'window', luz: 'light lightbulb', lampara: 'lamp', cerradura: 'lock', llave: 'key', timbre: 'bell', camara: 'cctv video', temperatura_: 'thermometer',
  humedad: 'water+percent humidity', lluvia: 'weather+rainy rain', viento: 'weather+windy wind', nieve: 'snowflake snow', luna_: 'moon', nube: 'cloud', fuego: 'fire',
  humo: 'smoke', agua: 'water', coche: 'car', carro: 'car', bicicleta: 'bicycle', calefaccion: 'radiator heat', caldera: 'water+boiler boiler', aire: 'air+conditioner',
  persiana_: 'blinds', cortina: 'curtains', enchufe: 'power+socket plug', interruptor: 'light switch toggle', casa_: 'home house', jardin_: 'flower garden', riego: 'sprinkler',
  piscina_: 'pool', perro: 'dog', gato: 'cat', paquete: 'package', reloj: 'clock', abierto: 'open', cerrado: 'closed', bateria: 'battery', energia_: 'flash lightning', movimiento: 'motion sensor run',
};
const synOf = (w) => SYN[w] || SYN[`${w}_`] || '';

/** Parole della ricerca con le loro alternative: la parola stessa e i sinonimi (una frase "a+b" vale se compaiono tutte). */
function parseQuery(q) {
  return strip(q).split(/[^a-z0-9]+/).filter(Boolean).map((w) => [w, ...synOf(w).split(' ').filter(Boolean)]);
}

/** Sottosequenza: "thrmomtr" trova "thermometer" (tolleranza ai refusi, solo per parole di almeno 4 lettere). */
function subsequence(needle, hay) {
  let i = 0;
  for (const ch of hay) if (ch === needle[i] && ++i === needle.length) return true;
  return false;
}

/** Quanto una singola parola corrisponde all'icona (0 = per niente). */
function scoreOne(word, icon, nameWords, typed) {
  if (nameWords.includes(word)) return 10;
  if (nameWords.some((x) => x.startsWith(word))) return 7;
  if (icon.hay.includes(word)) return 5;
  if (icon.kw.includes(` ${word}`) || icon.kw.startsWith(word)) return 4;
  if (icon.kw.includes(word)) return 2;
  if (typed && word.length >= 4 && subsequence(word, icon.name.replace(/-/g, ''))) return 1;
  return 0;
}

/** Punteggio di un termine della ricerca: la migliore tra le sue alternative (le frasi "a+b" sommano le parole). */
function scoreTerm(alts, icon, nameWords) {
  let best = 0;
  alts.forEach((alt, n) => {
    const parts = alt.split('+');
    let s = 0;
    for (const w of parts) {
      const x = scoreOne(w, icon, nameWords, n === 0 && parts.length === 1);
      if (!x) { s = 0; break; }
      s += x;
    }
    best = Math.max(best, s);
  });
  return best;
}

/** Icone che corrispondono a `query`, dalla più pertinente: [{ name, d }] (al massimo `limit`). */
export function searchMdi(query, limit = 96) {
  if (!index) return [];
  const terms = parseQuery(query);
  if (!terms.length) return [];
  const joined = strip(query).trim().replace(/[^a-z0-9]+/g, '-');
  const translated = terms.some((alts) => alts.length > 1);
  const out = [];
  for (const icon of index) {
    const nameWords = icon.name.split('-');
    let total = 0;
    let matched = 0;
    for (const alts of terms) {
      const s = scoreTerm(alts, icon, nameWords);
      if (s) { total += s; matched++; }
    }
    if (!matched) continue;
    if (matched === terms.length) total += 15; // tutte le parole presenti: prima delle corrispondenze parziali
    if (icon.name === joined) total += 30;
    else if (!translated && icon.name.startsWith(joined)) total += 8; // con i sinonimi (es. "auto" = car) non si premia chi inizia come la parola
    out.push({ name: icon.name, d: icon.d, score: total - icon.name.length * 0.05 });
  }
  out.sort((a, b) => b.score - a.score || (a.name < b.name ? -1 : 1));
  return out.slice(0, limit);
}
/** Icone adatte alla casa mostrate quando il campo di ricerca è vuoto. */
export const SUGGESTED = [
  'gate', 'garage', 'garage-open', 'door', 'door-open', 'lock', 'lock-open-variant', 'key', 'bell', 'shield-home', 'alarm-light', 'cctv',
  'thermometer', 'water-percent', 'weather-windy', 'weather-rainy', 'weather-sunny', 'weather-night', 'snowflake', 'fire', 'smoke-detector', 'water',
  'lightbulb', 'lamp', 'power-plug', 'flash', 'battery', 'solar-power', 'fan', 'radiator', 'air-conditioner', 'window-open', 'blinds', 'curtains',
  'home', 'car', 'run', 'eye', 'speaker', 'television', 'flower', 'sprinkler', 'pool', 'washing-machine', 'package-variant', 'paw', 'wifi', 'cog',
];
