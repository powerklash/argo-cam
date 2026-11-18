// Ricerca intelligente degli eventi: trasforma una frase ("le macchine bianche passate il 15/01/2025")
// in un filtro per il database. Tutto in locale, senza modelli di linguaggio: vocabolari in
// italiano, inglese, francese, tedesco e spagnolo + riconoscimento di date, orari, telecamere e persone.
import * as db from './db.js';

const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss');

// Ogni voce è un elenco di radici: una parola corrisponde se INIZIA con una di esse.
// Una radice che finisce con "$" deve coincidere con la parola intera (per le parole brevi ambigue).
const VEHICLE_TYPES = {
  car: ['auto$', 'autos$', 'macchin', 'automobil', 'vettur', 'car$', 'cars$', 'voiture', 'wagen', 'pkw$', 'coche', 'carro$', 'turism'],
  truck: ['camion', 'furgon', 'truck', 'lorry', 'lkw$', 'van$', 'vans$', 'autocarr', 'furgoneta', 'camioneta'],
  bus: ['autobus', 'bus$', 'pullman', 'corriera', 'autocar$'],
  motorcycle: ['moto', 'scooter', 'motorbike', 'motorcycle', 'motorrad', 'motocicl'],
  bicycle: ['bici', 'bicycle', 'bike$', 'bikes$', 'velo$', 'velos$', 'fahrrad', 'bicicleta'],
};
const VEHICLE_GENERIC = ['veicol', 'mezz', 'vehicle', 'vehicul', 'fahrzeug', 'traffic', 'traffico'];
const KINDS = {
  person: ['person', 'gente$', 'uomo$', 'uomini$', 'donna$', 'donne$', 'people$', 'man$', 'men$', 'woman$', 'women$', 'homme', 'femme', 'mensch', 'leute$', 'hombre', 'mujer', 'qualcuno$', 'someone$', 'quelqu', 'jemand$', 'alguien$', 'ragazz', 'bambin', 'child', 'kid$', 'kids$'],
  pet: ['anima', 'cane$', 'cani$', 'gatto$', 'gatti$', 'dog$', 'dogs$', 'cat$', 'cats$', 'pet$', 'pets$', 'chien', 'chat$', 'chats$', 'hund', 'katze', 'tier$', 'tiere$', 'perro', 'gato$', 'gatos$', 'mascota'],
  package: ['pacc', 'package', 'parcel', 'colis$', 'paket', 'paquete', 'consegn', 'deliver', 'livraison', 'lieferung', 'entrega'],
  visitor: ['campanell', 'doorbell', 'sonnette', 'klingel', 'timbre$', 'suonat', 'ring$', 'rang$', 'visitat', 'visitor', 'visiteur', 'besucher', 'visitante'],
  motion: ['movimento', 'motion$', 'mouvement', 'bewegung', 'movimiento'],
  fire: ['incendi', 'fuoco', 'fiamm', 'fire$', 'fires$', 'flame', 'feu$', 'flamme', 'feuer', 'brand$', 'fuego', 'llama'],
  flood: ['allag', 'alluvion', 'acqua', 'perdita', 'flood', 'water', 'leak', 'inondation', 'eau$', 'fuite', 'ueberschwemm', 'überschwemm', 'wasser', 'inundaci', 'agua$', 'fuga'],
  face: ['volto$', 'volti$', 'face$', 'faces$', 'visage', 'gesicht', 'rostro', 'cara$', 'caras$'],
};
const COLORS = {
  white: ['bianc', 'white', 'blanc', 'weiss', 'weis$', 'weisse'],
  black: ['ner$', 'nera$', 'neri$', 'nere$', 'nero$', 'black', 'noir', 'schwarz', 'negr'],
  grey: ['grigi', 'grey', 'gray', 'gris$', 'grise', 'grau'],
  silver: ['argent', 'silver', 'silber', 'plata$', 'plateado'],
  red: ['ross', 'red$', 'rouge', 'rot$', 'rote', 'rojo', 'roja'],
  blue: ['blu$', 'blue$', 'blue', 'bleu', 'blau', 'azul', 'celest', 'azzurr'],
  green: ['verd', 'green', 'vert$', 'verte', 'grun', 'gruen'],
  yellow: ['giall', 'yellow', 'jaune', 'gelb', 'amarill'],
  orange: ['arancion', 'orange', 'naranj'],
  brown: ['marron', 'brown', 'braun', 'brun$', 'brune', 'bronz'],
};
// Nomi (e abbreviazioni) esatti dei mesi in it / en / fr / de / es, senza accenti.
const MONTHS = [
  ['gennaio', 'gen', 'january', 'jan', 'janvier', 'janv', 'januar', 'enero', 'ene'],
  ['febbraio', 'feb', 'february', 'fevrier', 'fevr', 'februar', 'febrero'],
  ['marzo', 'mar', 'march', 'mars', 'marz', 'maerz'],
  ['aprile', 'apr', 'april', 'avril', 'avr', 'abril', 'abr'],
  ['maggio', 'mag', 'may', 'mai', 'mayo'],
  ['giugno', 'giu', 'june', 'jun', 'juin', 'juni', 'junio'],
  ['luglio', 'lug', 'july', 'jul', 'juillet', 'juil', 'juli', 'julio'],
  ['agosto', 'ago', 'august', 'aug', 'aout', 'agos'],
  ['settembre', 'set', 'sett', 'september', 'sep', 'sept', 'septembre', 'septiembre'],
  ['ottobre', 'ott', 'october', 'oct', 'octobre', 'oktober', 'okt', 'octubre'],
  ['novembre', 'nov', 'november', 'noviembre'],
  ['dicembre', 'dic', 'december', 'dec', 'decembre', 'dezember', 'dez', 'diciembre'],
];
const TODAY = ['oggi', 'today', 'aujourd', 'heute', 'hoy'];
const YESTERDAY = ['ieri', 'yesterday', 'hier', 'gestern', 'ayer'];
const WEEK = ['settiman', 'week', 'semaine', 'woche', 'semana'];
const MONTH = ['mese', 'month', 'mois', 'monat'];
const DAYS = ['giorn', 'day', 'jour', 'tag', 'dia'];
const HOURS = ['ore$', 'ora$', 'hour', 'heure', 'stunde', 'hora'];
const PERIODS = [
  ['night', ['nott', 'night', 'nuit', 'nacht', 'noche'], [22, 6]],
  ['morning', ['mattin', 'morning', 'matin', 'morgen', 'manana'], [6, 12]],
  ['afternoon', ['pomerigg', 'afternoon', 'apres', 'nachmittag', 'tarde'], [12, 18]],
  ['evening', ['sera', 'evening', 'soir', 'abend', 'anochecer'], [18, 22]],
];
const STOP = new Set(['il', 'lo', 'la', 'le', 'gli', 'i', 'un', 'una', 'di', 'del', 'della', 'dei', 'delle', 'the', 'a', 'an', 'of', 'in', 'on', 'at', 'les', 'des', 'du', 'der', 'die', 'das', 'den', 'el', 'los', 'las', 'de', 'del', 'e', 'and', 'et', 'und', 'y', 'o', 'or', 'voglio', 'vedere', 'show', 'see', 'me', 'mostra', 'cerca', 'find', 'passate', 'passato', 'passata', 'passati', 'visti', 'vista', 'visto', 'sono', 'che', 'con', 'per', 'tutte', 'tutti', 'tutto', 'all', 'toutes', 'alle', 'todos', 'todas', 'dalla', 'dal', 'nel', 'nella', 'sul', 'ho', 'ha']);

const startsWithAny = (word, stems) => stems.some((s) => (s.endsWith('$') ? word === s.slice(0, -1) : word.startsWith(s)));
const dayStart = (y, m, d) => new Date(y, m - 1, d).getTime();

function parseDates(text, out, summary) {
  let rest = text;
  const now = new Date();
  const setDay = (y, m, d) => {
    if (y < 100) y += 2000;
    const from = dayStart(y, m, d);
    if (Number.isNaN(from) || m < 1 || m > 12 || d < 1 || d > 31) return false;
    out.from = from;
    out.to = from + 86400_000;
    summary.push({ k: 'date', v: `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` });
    return true;
  };
  // 2025-01-15
  rest = rest.replace(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/, (all, y, m, d) => (setDay(+y, +m, +d) ? ' ' : all));
  // 15/01/2025, 15-01-25, 01/15/2025 (se il secondo numero supera 12)
  rest = rest.replace(/\b(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})\b/, (all, a, b, y) => {
    let [d, m] = [+a, +b];
    if (d <= 12 && m > 12) [d, m] = [m, d];
    return setDay(+y, m, d) ? ' ' : all;
  });
  // 15/01 (senza anno: l'ultimo passato)
  if (out.from == null) {
    rest = rest.replace(/\b(\d{1,2})[/](\d{1,2})\b/, (all, a, b) => {
      let y = now.getFullYear();
      if (dayStart(y, +b, +a) > now.getTime()) y -= 1;
      return setDay(y, +b, +a) ? ' ' : all;
    });
  }
  // 15 gennaio 2025 / January 15 2025 / 15 de enero de 2025
  if (out.from == null) {
    const words = rest.split(/\s+/);
    for (let i = 0; i < words.length && out.from == null; i++) {
      const clean = words[i].replace(/[.,]/g, '');
      const mi = MONTHS.findIndex((names) => names.includes(clean));
      if (mi < 0) continue;
      const near = [words[i - 1], words[i - 2], words[i + 1], words[i + 2]].map((w) => (w || '').replace(/[.,]/g, ''));
      const nums = near.filter((w) => /^\d{1,4}$/.test(w));
      const day = nums.find((w) => +w >= 1 && +w <= 31 && w.length <= 2);
      if (!day) continue;
      const year = nums.find((w) => w.length === 4);
      let y = year ? +year : now.getFullYear();
      if (!year && dayStart(y, mi + 1, +day) > now.getTime()) y -= 1;
      if (setDay(y, mi + 1, +day)) { words[i] = ' '; for (const n of [day, year]) { const j = words.findIndex((w) => w.replace(/[.,]/g, '') === n); if (j >= 0) words[j] = ' '; } }
    }
    rest = words.join(' ');
  }
  // oggi / ieri / ultimi N giorni / ultima settimana / ultimo mese / ultime N ore
  const tokens = rest.split(/\s+/);
  tokens.forEach((w, i) => {
    if (out.from != null) return;
    if (startsWithAny(w, TODAY)) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      out.from = d.getTime();
      summary.push({ k: 'rel', v: 'today' });
    } else if (startsWithAny(w, YESTERDAY)) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
      out.from = d.getTime();
      out.to = d.getTime() + 86400_000;
      summary.push({ k: 'rel', v: 'yesterday' });
    }
  });
  if (out.from == null) {
    const n = (i) => (/^\d{1,3}$/.test(tokens[i] || '') ? +tokens[i] : null);
    for (let i = 0; i < tokens.length && out.from == null; i++) {
      const w = tokens[i];
      const count = n(i + 1) ?? n(i - 1);
      if (startsWithAny(w, ['ultim', 'last', 'dernier', 'letzt', 'pasad', 'scors', 'past'])) {
        const unit = tokens.slice(i - 1, i + 4).find((t) => startsWithAny(t, [...DAYS, ...WEEK, ...MONTH, ...HOURS]) && t.length > 1);
        if (!unit) continue;
        const mult = startsWithAny(unit, WEEK) ? 7 : startsWithAny(unit, MONTH) ? 30 : startsWithAny(unit, DAYS) ? 1 : 1 / 24;
        const days = (count ?? 1) * mult;
        out.from = now.getTime() - days * 86400_000;
        summary.push({ k: 'last', v: Math.round(days * 24) });
      }
    }
  }
  return rest;
}

function parseHours(text, out, summary) {
  let rest = text;
  const between = /\b(?:tra|between|entre|zwischen)\s+(?:le\s+|les\s+|las\s+)?(\d{1,2})(?:[:h]\d{2})?\s+(?:e|and|et|und|y)\s+(?:le\s+|les\s+|las\s+)?(\d{1,2})/.exec(rest);
  const after = /\b(?:dopo|after|apres|nach|despues)\s+(?:le\s+|les\s+|las\s+|um\s+)?(\d{1,2})/.exec(rest);
  const before = /\b(?:prima|before|avant|vor|antes)\s+(?:delle\s+|de\s+|las\s+|um\s+)?(\d{1,2})/.exec(rest);
  if (between) { out.hours = [+between[1], +between[2]]; rest = rest.replace(between[0], ' '); }
  else if (after) { out.hours = [+after[1], 24]; rest = rest.replace(after[0], ' '); }
  else if (before) { out.hours = [0, +before[1]]; rest = rest.replace(before[0], ' '); }
  if (!out.hours) {
    for (const [name, stems, range] of PERIODS) {
      if (rest.split(/\s+/).some((w) => startsWithAny(w, stems))) {
        out.hours = range;
        summary.push({ k: 'period', v: name });
        return rest;
      }
    }
  } else {
    summary.push({ k: 'hours', v: out.hours });
  }
  return rest;
}

/**
 * Interpreta la frase. Restituisce { filter, summary } dove summary è l'elenco di criteri
 * riconosciuti [{ k, v }] (l'interfaccia li mostra come etichette traducibili).
 */
export function parse(input, { cameras = [], usePersons = true } = {}) {
  const filter = {};
  const summary = [];
  let text = ` ${norm(String(input || ''))} `.replace(/[,;!?"“”]/g, ' ');
  if (!text.trim()) return { filter, summary };

  // Targa
  const plate = /\b(?:targa|plate|plaque|kennzeichen|matricula)\s+([a-z0-9]{4,9})\b/.exec(text) || /\b([a-z]{2}\d{3}[a-z]{2})\b/.exec(text);
  if (plate) {
    filter.plate = plate[1].toUpperCase();
    summary.push({ k: 'plate', v: filter.plate });
    text = text.replace(plate[0], ' ');
  }

  text = parseDates(text, filter, summary);
  text = parseHours(text, filter, summary);

  // Telecamere citate per nome
  const cams = [];
  for (const cam of cameras) {
    const name = norm(cam.name).trim();
    const words = name.split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !STOP.has(w));
    const hit = text.includes(` ${name} `) || words.some((w) => text.includes(` ${w} `) || text.includes(` ${w}`));
    if (hit && name) { cams.push(cam.id); summary.push({ k: 'cam', v: cam.name }); }
  }
  if (cams.length) filter.camIds = cams;

  // Persone (dal database dei volti)
  const people = usePersons ? db.allPersonNames().filter((p) => p.name && text.includes(` ${norm(p.name)}`)) : [];
  if (people.length) {
    filter.personIds = people.map((p) => p.id);
    for (const p of people) summary.push({ k: 'person', v: p.name });
  }

  const words = text.split(/\s+/).filter(Boolean);
  const kinds = new Set();
  const vtypes = new Set();
  const colors = new Set();
  for (const w of words) {
    if (STOP.has(w)) continue;
    for (const [type, stems] of Object.entries(VEHICLE_TYPES)) if (startsWithAny(w, stems)) vtypes.add(type);
    if (startsWithAny(w, VEHICLE_GENERIC)) kinds.add('vehicle');
    for (const [kind, stems] of Object.entries(KINDS)) if (startsWithAny(w, stems)) kinds.add(kind);
    for (const [color, stems] of Object.entries(COLORS)) if (startsWithAny(w, stems) && w.length >= 3) colors.add(color);
  }
  // "persona" con un nome di persona noto: non serve il tipo
  if (vtypes.size) { kinds.add('vehicle'); filter.vehicleTypes = [...vtypes]; for (const t of vtypes) summary.push({ k: 'vtype', v: t }); }
  if (colors.size) {
    filter.colors = [...colors];
    // "silver" e "grey" si somigliano: la ricerca li considera insieme.
    if (colors.has('grey')) filter.colors.push('silver');
    if (colors.has('silver')) filter.colors.push('grey');
    filter.colors = [...new Set(filter.colors)];
    for (const c of colors) summary.push({ k: 'color', v: c });
    if (!kinds.size) kinds.add('vehicle'); // un colore da solo si riferisce ai mezzi
  }
  if (kinds.has('person') && !people.length) kinds.add('face');
  if (kinds.size) {
    for (const k of kinds) if (!(k === 'face' && kinds.has('person')) && !(k === 'vehicle' && vtypes.size)) summary.push({ k: 'kind', v: k });
    // I mezzi si cercano anche tra gli eventi in cui l'analisi ha riconosciuto un veicolo.
    if (kinds.delete('vehicle')) filter.vehicleAny = true;
    if (kinds.size) filter.kinds = [...kinds];
  }
  return { filter, summary };
}
