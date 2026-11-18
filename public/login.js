// Pagina di accesso: nessun altro script dell'app viene caricato prima dell'accesso.
import { t, applyI18n, LANGS, getLang, setLang } from './i18n.js';

const form = document.getElementById('login');
const errorBox = document.getElementById('error');
const submit = document.getElementById('submit');
const langSel = document.getElementById('lang');

// Dopo l'accesso si torna alla pagina richiesta, ma solo se è un percorso interno al sito.
const wanted = new URLSearchParams(location.search).get('next') || '/';
const next = wanted.startsWith('/') && !wanted.startsWith('//') && !wanted.includes('\\') && !wanted.startsWith('/login.html') ? wanted : '/';

for (const [code, name] of LANGS) langSel.add(new Option(name, code));
langSel.value = getLang();
langSel.addEventListener('change', () => setLang(langSel.value));
applyI18n();

// Già collegato: si va direttamente all'app.
fetch('/api/auth/me').then((r) => { if (r.ok) location.replace(next); }).catch(() => {});

const show = (text) => { errorBox.classList.remove('ok'); errorBox.textContent = text; errorBox.hidden = !text; };

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  show('');
  submit.disabled = true;
  const label = submit.textContent;
  submit.textContent = t('login.wait');
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: form.elements.username.value, password: form.elements.password.value }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) { location.replace(next); return; }
    if (data.code === 'LOCKED') show(t('login.locked', { min: Math.max(1, Math.ceil((data.retryAfter || 900) / 60)) }));
    else show(t(`err.${data.code}`, null, data.error || `HTTP ${res.status}`));
    form.elements.password.value = '';
    form.elements.password.focus();
  } catch {
    show(t('login.network'));
  } finally {
    submit.disabled = false;
    submit.textContent = label;
  }
});

document.addEventListener('langchange', () => { submit.textContent = t('login.submit'); });

// Il collegamento al certificato compare solo se l'amministratore ha attivato il download.
fetch('/api/cert/info').then((r) => r.json()).then((d) => { document.getElementById('cert-link').hidden = !d.available; }).catch(() => {});

// ---------- password dimenticata (solo amministratori, con le 3 domande) ----------
const rec = document.getElementById('recover');
const recErr = document.getElementById('rec-error');
const recOk = document.getElementById('rec-ok');
const step1 = document.getElementById('rec-step1');
const step2 = document.getElementById('rec-step2');
const qBox = document.getElementById('rec-questions');
let recUser = '';

const recShow = (text, ok = false) => {
  recErr.hidden = ok || !text;
  recOk.hidden = !ok || !text;
  (ok ? recOk : recErr).textContent = text || '';
};
const recMessage = (data, status) => (data.code === 'LOCKED'
  ? t('login.locked', { min: Math.max(1, Math.ceil((data.retryAfter || 900) / 60)) })
  : t(`err.${data.code}`, null, data.error || `HTTP ${status}`));

async function post(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

function showRecovery(on) {
  form.hidden = on;
  rec.hidden = !on;
  recShow('');
  if (on) {
    step1.hidden = false;
    step2.hidden = true;
    qBox.replaceChildren();
    rec.elements.username.value = form.elements.username.value;
    rec.elements.username.focus();
  } else {
    form.elements.username.focus();
  }
}
document.getElementById('forgot').addEventListener('click', () => showRecovery(true));
document.getElementById('rec-back').addEventListener('click', () => showRecovery(false));

document.getElementById('rec-next').addEventListener('click', async () => {
  recShow('');
  recUser = rec.elements.username.value.trim();
  if (!recUser) return;
  try {
    const r = await post('/api/auth/recovery/questions', { username: recUser });
    if (!r.ok) { recShow(recMessage(r.data, r.status)); return; }
    qBox.replaceChildren(...r.data.questions.map((q, i) => {
      const label = document.createElement('label');
      const span = document.createElement('span');
      span.textContent = q; // testo scelto dall'amministratore: sempre come testo, mai come HTML
      const input = document.createElement('input');
      input.name = `a${i}`;
      input.autocomplete = 'off';
      input.maxLength = 100;
      label.append(span, input);
      return label;
    }));
    step1.hidden = true;
    step2.hidden = false;
    qBox.querySelector('input')?.focus();
  } catch { recShow(t('login.network')); }
});

rec.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (step2.hidden) { document.getElementById('rec-next').click(); return; }
  recShow('');
  const f = rec.elements;
  if (f.pw1.value !== f.pw2.value) { recShow(t('pw.mismatch')); return; }
  const btn = document.getElementById('rec-submit');
  btn.disabled = true;
  try {
    const r = await post('/api/auth/recovery/reset', { username: recUser, answers: [f.a0.value, f.a1.value, f.a2.value], password: f.pw1.value });
    if (!r.ok) { recShow(recMessage(r.data, r.status)); return; }
    form.elements.username.value = recUser;
    form.elements.password.value = '';
    showRecovery(false);
    show('');
    // Messaggio di conferma sopra il modulo di accesso.
    errorBox.hidden = false;
    errorBox.classList.add('ok');
    errorBox.textContent = t('rec.done');
    form.elements.password.focus();
  } catch { recShow(t('login.network')); } finally {
    btn.disabled = false;
    f.pw1.value = '';
    f.pw2.value = '';
  }
});
