// Pagina per scaricare il certificato (telefoni): raggiungibile senza accesso, protetta da una password.
import { t, applyI18n, LANGS, getLang, setLang } from './i18n.js';

const langSel = document.getElementById('lang');
const form = document.getElementById('cert');
const errorBox = document.getElementById('error');
const off = document.getElementById('off');

for (const [code, name] of LANGS) langSel.add(new Option(name, code));
langSel.value = getLang();
langSel.addEventListener('change', () => { setLang(langSel.value); showError(); });
applyI18n();

const ERRORS = { bad: 'cert.errBad', locked: 'cert.errLocked', origin: 'cert.errBad', off: 'cert.off' };
function showError() {
  const e = new URLSearchParams(location.search).get('e');
  errorBox.hidden = !e || !ERRORS[e];
  if (e && ERRORS[e]) errorBox.textContent = t(ERRORS[e]);
}
showError();

// Se l'amministratore non ha attivato il download (HTTPS o password mancanti) il modulo non serve.
fetch('/api/cert/info').then((r) => r.json()).then((d) => {
  form.hidden = !d.available;
  off.hidden = !!d.available;
}).catch(() => {});

document.addEventListener('langchange', showError);
