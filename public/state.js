// Stato condiviso e utilità comuni a tutti i moduli dell'interfaccia.
import { t, has } from './i18n.js';

export const state = {
  me: null, // utente collegato: { id, username, displayName, role, mustChange }
  brands: [],
  cameras: [],
  settings: null,
  selectedId: null, // telecamera selezionata (riquadro celeste, unica con l'audio)
  focusedId: null, // telecamera ingrandita
  sleeping: new Map(), // id telecamera a batteria -> true se dorme
};

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Errore di una chiamata API: `code` è il codice del server, traducibile nella lingua dell'utente. */
export class ApiError extends Error {
  constructor(message, code, status, extra = {}) {
    super(message);
    this.code = code;
    this.status = status;
    Object.assign(this, extra);
  }
}

/** Messaggio d'errore leggibile: tradotto se il server ha mandato un codice noto. */
export function errorText(err) {
  if (err?.code === 'LOCKED' && err.retryAfter) return t('login.locked', { min: Math.max(1, Math.ceil(err.retryAfter / 60)) });
  if (err?.code && has(`err.${err.code}`)) return t(`err.${err.code}`);
  return err?.message || String(err);
}

export async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && data.code === 'UNAUTHENTICATED' && !location.pathname.endsWith('/login.html')) {
    // Sessione scaduta o chiusa: si torna alla pagina di accesso e poi qui.
    location.href = `/login.html?next=${encodeURIComponent(location.pathname + location.search)}`;
  }
  if (!res.ok) throw new ApiError(data.error || `HTTP ${res.status}`, data.code, res.status, { retryAfter: data.retryAfter });
  return data;
}

export const isAdmin = () => state.me?.role === 'admin';

export const camById = (id) => state.cameras.find((c) => c.id === id);

/** Elemento DOM da una descrizione breve: el('div', {class:'x'}, 'testo', figlio…). */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node[k] = v;
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) node.append(c);
  return node;
}

const toasts = () => $('#toasts');
/** Messaggio temporaneo in basso a sinistra. */
export function toast(text, { kind = 'info', ms = 5000 } = {}) {
  const node = el('div', { class: `toast ${kind}` }, text);
  toasts().append(node);
  setTimeout(() => node.remove(), ms);
  node.addEventListener('click', () => node.remove());
  return node;
}

// Preferenze del singolo browser (dispositivi audio).
export const pref = {
  get: (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } },
  set: (k, v) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch { /* facoltativo */ } },
};
