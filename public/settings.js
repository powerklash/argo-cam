// Finestra delle impostazioni: lingua, audio (microfono e altoparlante), allarmi, eventi/database,
// rilevamento delle Eufy in rete e riconoscimento.
import { t, LANGS, getLang, setLang } from './i18n.js';
import { state, $, api, el, toast, pref, errorText, isAdmin } from './state.js';

const FLASH_KINDS = ['person', 'vehicle', 'pet', 'face', 'package', 'motion'];
let app = null;

const row = (labelText, input) => el('label', { class: 'srow' }, el('span', {}, labelText), input);
const check = (labelText, checked) => {
  const input = el('input', { type: 'checkbox', checked });
  return { input, node: el('label', { class: 'check' }, input, el('span', {}, labelText)) };
};
const number = (value, min, max) => el('input', { type: 'number', min, max, value });
const section = (title, ...nodes) => el('fieldset', {}, el('legend', {}, title), ...nodes);

// ---------- audio ----------
async function deviceOptions(kind) {
  const list = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === kind);
  return list.map((d, i) => ({ id: d.deviceId, label: d.label || `${kind === 'audioinput' ? '🎤' : '🔈'} ${i + 1}` }));
}

function deviceSelect(options, current) {
  const sel = el('select');
  sel.add(new Option(t('set.defaultDevice'), ''));
  for (const o of options) sel.add(new Option(o.label, o.id));
  sel.value = options.some((o) => o.id === current) ? current : '';
  return sel;
}

async function audioSection() {
  const box = el('div');
  const build = async () => {
    box.replaceChildren();
    let mics = [];
    let speakers = [];
    try {
      mics = await deviceOptions('audioinput');
      speakers = await deviceOptions('audiooutput');
    } catch { /* senza permessi l'elenco resta vuoto */ }
    const mic = deviceSelect(mics, pref.get('mic'));
    mic.addEventListener('change', () => pref.set('mic', mic.value));
    box.append(row(t('set.mic'), mic));
    if ('setSinkId' in HTMLMediaElement.prototype) {
      const spk = deviceSelect(speakers, pref.get('speaker'));
      spk.addEventListener('change', () => {
        pref.set('speaker', spk.value);
        for (const v of document.querySelectorAll('video')) if (spk.value) v.setSinkId?.(spk.value).catch(() => {});
      });
      box.append(row(t('set.speaker'), spk));
    } else {
      box.append(el('p', { class: 'note' }, t('set.speakerUnsupported')));
    }
    // Senza il permesso del microfono il browser non mostra i nomi dei dispositivi.
    if (!mics.some((m) => !/^🎤 \d+$/.test(m.label))) {
      box.append(el('button', {
        type: 'button',
        onclick: async () => {
          try {
            (await navigator.mediaDevices.getUserMedia({ audio: true })).getTracks().forEach((x) => x.stop());
          } catch { /* rifiutato dall'utente */ }
          build();
        },
      }, t('set.allowAudio')));
    }
  };
  await build();
  return section(t('set.audio'), box);
}

// ---------- Eufy ----------
const EUFY_ERRORS = ['login_failed', 'network', 'credentials'];
const eufyErrorText = (code) => (code === 'unavailable' ? t('set.eufyUnavailable') : EUFY_ERRORS.includes(code) ? t('set.eufyErr.' + code) : t('set.eufyErr'));
const guessCountry = () => {
  const region = (navigator.languages || [navigator.language]).map((l) => /-([A-Za-z]{2})$/.exec(l || '')?.[1]).find(Boolean);
  return (region || { it: 'IT', fr: 'FR', de: 'DE', es: 'ES', en: 'GB' }[getLang()] || 'IT').toUpperCase();
};

/** Collegamento dell'account Eufy (cloud): serve per aggiungere le telecamere e per svegliare quelle a batteria. */
function eufyAccountBox(onChange) {
  const box = el('div', { class: 'eufy-account' });
  let last = {}; // paese ed email dell'ultimo tentativo (per non riscriverli dopo un errore)
  const render = async () => {
    let st;
    try { st = await api('GET', '/api/eufy/cloud'); } catch (err) { box.replaceChildren(el('p', { class: 'note err' }, errorText(err))); return; }
    const connected = st.data && (st.session || Object.values(st.stations).some((s) => s.keyMinutesLeft > 0));
    const mins = Math.max(0, ...Object.values(st.stations).map((s) => s.keyMinutesLeft));
    const info = !st.available
      ? el('p', { class: 'note err' }, t('set.eufyUnavailable'))
      : connected
        ? el('p', { class: 'note ok' }, st.session
          ? t('set.eufyOn', { date: st.tokenExpires ? new Date(st.tokenExpires).toLocaleDateString(getLang()) : '—' })
          : t('set.eufyOnKey', { min: mins }))
        : el('p', { class: 'note' }, t('set.eufyOff'));
    box.replaceChildren(info);
    if (!st.available) return;
    const show = el('button', { type: 'button', class: connected ? '' : 'primary', onclick: () => form() }, connected ? t('set.eufyReconnect') : t('set.eufyConnect'));
    const actions = el('div', { class: 'srow-inline' }, show);
    if (st.data) {
      actions.append(el('button', {
        type: 'button',
        class: 'danger',
        onclick: async () => {
          if (!confirm(t('set.eufyDisconnectAsk'))) return;
          try { await api('DELETE', '/api/eufy/cloud'); } catch (err) { toast(errorText(err), { kind: 'err' }); }
          render();
          onChange();
        },
      }, t('set.eufyDisconnect')));
    }
    box.append(actions);
  };

  // Passi dell'accesso: credenziali -> (captcha | codice) -> fine. Le credenziali non si conservano nella pagina.
  function form(errorCode) {
    const country = el('input', { maxlength: 2, value: last.country || guessCountry(), autocomplete: 'off', style: 'text-transform:uppercase' });
    const email = el('input', { type: 'email', value: last.email || '', autocomplete: 'off', autocapitalize: 'none', spellcheck: false });
    const password = el('input', { type: 'password', autocomplete: 'new-password' });
    const keep = check(t('set.eufyKeep'), true);
    const msg = el('p', { class: errorCode ? 'note err' : 'note' }, errorCode ? eufyErrorText(errorCode) : t('set.eufyPrivacy'));
    const go = el('button', { type: 'submit', class: 'primary' }, t('set.eufyConnect'));
    const cancel = el('button', { type: 'button', onclick: () => { api('POST', '/api/eufy/login', { action: 'cancel' }).catch(() => {}); render(); } }, t('btn.cancel'));
    const f = el('form', { class: 'eufy-form', autocomplete: 'off' },
      row(t('set.eufyCountry'), country), row(t('set.eufyEmail'), email), row(t('set.eufyPassword'), password), keep.node, msg,
      el('div', { class: 'srow-inline' }, go, cancel));
    box.replaceChildren(f);

    const busy = (on) => { for (const x of f.querySelectorAll('input, button[type=submit]')) x.disabled = on; if (on) msg.textContent = t('set.eufyBusy'); };
    const handle = (r) => {
      busy(false);
      if (r.status === 'done') {
        toast(t('set.eufyDone', { n: r.stations.length }));
        render();
        onChange();
      } else if (r.status === 'captcha' || r.status === 'verify') {
        const code = el('input', { autocomplete: 'off', autocapitalize: 'none', spellcheck: false, maxlength: 16 });
        const send = el('button', { type: 'submit', class: 'primary' }, t('set.eufySend'));
        const step = el('form', { class: 'eufy-form' },
          el('p', { class: 'note' }, r.status === 'captcha' ? t('set.eufyCaptcha') : t('set.eufyVerify')),
          r.status === 'captcha' ? el('img', { class: 'eufy-captcha', src: r.image, alt: '' }) : null,
          code, el('div', { class: 'srow-inline' }, send, cancel));
        step.addEventListener('submit', async (e) => {
          e.preventDefault();
          send.disabled = true;
          try { handle(await api('POST', '/api/eufy/login', { action: r.status, code: code.value })); } catch (err) { fail(err); }
        });
        box.replaceChildren(step);
        code.focus();
      } else if (f.isConnected) {
        msg.className = 'note err';
        msg.textContent = eufyErrorText(r.code);
      } else {
        form(r.code); // l'errore è arrivato dopo captcha/codice: si torna al modulo con il messaggio
      }
    };
    const fail = (err) => { busy(false); msg.className = 'note err'; msg.textContent = errorText(err); };
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      last = { country: country.value, email: email.value }; // la password non si conserva mai
      busy(true);
      try {
        handle(await api('POST', '/api/eufy/login', { action: 'login', country: country.value, email: email.value, password: password.value, keepSession: keep.input.checked }));
      } catch (err) { fail(err); }
    });
    email.focus();
  }
  render();
  return box;
}

function eufySection() {
  const list = el('div', { class: 'eufy-list' });
  const showList = async (scan) => {
    list.replaceChildren(el('p', { class: 'note' }, scan ? t('set.eufyScanning') : ''));
    try {
      const r = await api('GET', `/api/eufy/discover${scan ? '' : '?scan=0'}`);
      list.replaceChildren();
      if (!r.configured) list.append(el('p', { class: 'note err' }, t('set.eufyNotConfigured')));
      else if (r.devices.length) list.append(el('p', { class: 'note' }, t('set.eufyList')));
      for (const d of r.devices) {
        const info = d.camId
          ? el('span', { class: 'note' }, t('set.eufyAdded', { name: d.camName }))
          : el('button', {
            type: 'button',
            onclick: () => {
              $('#settings').close();
              app.openDialog(null, { brand: 'eufyp2p', name: d.name || d.serial.slice(0, 5), battery: /^T81/.test(d.serial), params: { serial: d.serial, host: d.ip || '' } });
            },
          }, t('set.eufyAdd'));
        list.append(el('div', { class: 'eufy-row' },
          el('span', {}, el('code', {}, d.serial), d.name ? el('span', { class: 'note' }, ` ${d.name}`) : null),
          el('span', { class: d.online ? 'ok' : 'note' }, scan ? (d.online ? `${d.ip} · ${t('set.eufyOnline')}` : t('set.eufyAsleep')) : ''),
          info));
      }
      if (r.unknown.length) list.append(el('p', { class: 'note' }, t('set.eufyUnknown', { ips: r.unknown.map((u) => u.ip).join(', ') })));
    } catch (err) {
      list.replaceChildren(el('p', { class: 'note err' }, errorText(err)));
    }
  };
  const btn = el('button', {
    type: 'button',
    onclick: async () => { btn.disabled = true; await showList(true); btn.disabled = false; },
  }, t('set.eufyScan'));
  showList(false);
  return section(t('set.eufy'), el('h4', { class: 'eufy-title' }, t('set.eufyAccount')), eufyAccountBox(() => showList(false)), btn, list);
}

// ---------- Home Assistant ----------
function haSection() {
  const url = el('input', { type: 'url', placeholder: 'http://192.168.1.10:8123', autocomplete: 'off', autocapitalize: 'none', spellcheck: false });
  const token = el('input', { type: 'password', autocomplete: 'off', placeholder: t('set.haTokenPh') });
  const out = el('p', { class: 'note' });
  const say = (text, bad = false) => { out.textContent = text; out.className = bad ? 'note err' : 'note ok'; };
  const load = async () => {
    try {
      const c = await api('GET', '/api/ha/config');
      url.value = c.url || '';
      token.placeholder = c.hasToken ? t('set.haTokenSaved') : t('set.haTokenPh');
      if (c.hasToken) say(c.ok ? t('set.haOk') : (c.error ? t('set.haFail', { msg: c.error }) : t('set.haWaiting')), !c.ok && !!c.error);
    } catch { /* non configurato */ }
  };
  const run = (fn) => async () => { try { await fn(); } catch (err) { say(errorText(err), true); } };
  const save = el('button', {
    type: 'button',
    onclick: run(async () => {
      await api('PUT', '/api/ha/config', { url: url.value, token: token.value });
      token.value = '';
      await load();
      const r = await api('POST', '/api/ha/test');
      say(t('set.haConnected', { name: r.name || 'Home Assistant', n: r.entities }));
    }),
  }, t('set.haSave'));
  const test = el('button', {
    type: 'button',
    onclick: run(async () => {
      const r = await api('POST', '/api/ha/test');
      say(t('set.haConnected', { name: r.name || 'Home Assistant', n: r.entities }));
    }),
  }, t('set.haTest'));
  const remove = el('button', {
    type: 'button',
    class: 'danger',
    onclick: run(async () => { await api('DELETE', '/api/ha/config'); url.value = ''; token.placeholder = t('set.haTokenPh'); say(t('set.haRemoved')); }),
  }, t('set.haRemove'));
  load();
  return section(t('set.ha'), el('p', { class: 'note' }, t('set.haHint')), row(t('set.haUrl'), url), row(t('set.haToken'), token),
    el('div', { class: 'srow-inline' }, save, test, remove), out);
}

// ---------- certificato per i telefoni ----------
function certSection() {
  const pw = el('input', { type: 'password', autocomplete: 'new-password', minLength: 8, placeholder: t('set.certPwPh') });
  const out = el('p', { class: 'note' });
  const link = `${location.origin}/cert.html`;
  const show = (set, tls) => {
    out.className = set && tls ? 'note ok' : 'note err';
    out.textContent = !tls ? t('set.certNoTls') : set ? t('set.certOn', { link }) : t('set.certOff');
  };
  const refresh = () => api('GET', '/api/admin/cert-password').then((r) => show(r.set, r.tls)).catch(() => {});
  const run = (fn) => async () => { try { await fn(); } catch (err) { out.className = 'note err'; out.textContent = errorText(err); } };
  const save = el('button', {
    type: 'button',
    onclick: run(async () => {
      const r = await api('PUT', '/api/admin/cert-password', { password: pw.value });
      pw.value = '';
      show(r.set, r.tls);
      toast(t('set.certSaved'));
    }),
  }, t('set.certSave'));
  const remove = el('button', {
    type: 'button',
    class: 'danger',
    onclick: run(async () => { const r = await api('DELETE', '/api/admin/cert-password'); show(r.set, r.tls); }),
  }, t('set.certRemove'));
  refresh();
  return section(t('set.cert'), el('p', { class: 'note' }, t('set.certHint')), row(t('set.certPw'), pw), el('div', { class: 'srow-inline' }, save, remove), out);
}

// ---------- archivio di rete degli eventi ----------
const fmtBytes = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.max(0, Math.round(b / 1e6))} MB`);

function archiveSection() {
  const info = el('div', { class: 'archive-info' });
  const out = el('p', { class: 'note' });
  const driver = el('select', {});
  for (const [v, k] of [['', 'arc.off'], ['smb', 'arc.smb'], ['webdav', 'arc.webdav'], ['folder', 'arc.folder']]) driver.add(new Option(t(k), v));
  const target = el('input', { type: 'text', autocomplete: 'off', autocapitalize: 'none', spellcheck: false });
  const dir = el('input', { type: 'text', autocomplete: 'off', value: 'cam-app' });
  const user = el('input', { type: 'text', autocomplete: 'off', autocapitalize: 'none' });
  const pass = el('input', { type: 'password', autocomplete: 'new-password' });
  const tls = check(t('arc.insecureTls'), false);
  const after = number(7, 1, 3650);
  const keep = number(0, 0, 36500);
  const enabled = check(t('arc.enabled'), false);
  const fields = el('div', {});
  const rows = {
    target: row(t('arc.target'), target), dir: row(t('arc.dir'), dir), user: row(t('arc.user'), user), pass: row(t('arc.pass'), pass), tls: tls.node,
  };
  const place = { smb: '\\\\nas\\condivisione', webdav: 'https://nas.local/webdav', folder: '/mnt/archivio' };
  const refreshFields = () => {
    const d = driver.value;
    target.placeholder = place[d] || '';
    fields.replaceChildren(...(d ? [rows.target, rows.dir, ...(d === 'folder' ? [] : [rows.user, rows.pass]), ...(d === 'webdav' ? [rows.tls] : [])] : []));
    if (d === 'folder') fields.append(el('p', { class: 'note' }, t('arc.folderHint')));
    if (d === 'smb') fields.append(el('p', { class: 'note' }, t('arc.smbHint')));
  };
  driver.addEventListener('change', refreshFields);

  const say = (text, bad = false) => { out.className = bad ? 'note err' : 'note ok'; out.textContent = text; };
  let timer = null;
  const bar = el('progress', { max: 1, value: 0 });
  const barLabel = el('span', { class: 'note' });
  const barBox = el('div', { class: 'arc-progress', hidden: true }, barLabel, bar);
  const showStatus = (d) => {
    const u = d.usage;
    const lines = [
      t('arc.usageEvents', { n: u.events, a: u.archived }),
      t('arc.usageSpace', { local: fmtBytes(u.localBytes), arch: fmtBytes(u.archivedBytes) }),
      u.perDay > 0 ? t('arc.usageGrowth', { perDay: fmtBytes(u.perDay), month: fmtBytes(u.perDay * 30) }) : t('arc.usageGrowthNone'),
      u.disk ? t('arc.usageDisk', { free: fmtBytes(u.disk.free), total: fmtBytes(u.disk.total), days: u.daysLeft ?? '—' }) : '',
    ];
    info.replaceChildren(...lines.filter(Boolean).map((x) => el('div', {}, x)));
    const s = d.status;
    // Avanzamento dell'archiviazione (anche se l'ha avviata il timer): barra con filmati fatti / da fare.
    barBox.hidden = !s.running;
    if (s.running) {
      if (s.total > 0) { bar.max = s.total; bar.value = s.done; barLabel.textContent = t('arc.running', { done: s.done, total: s.total }); }
      else { bar.removeAttribute('value'); barLabel.textContent = t('arc.preparing'); }
      out.textContent = '';
      if (!timer) watch();
    } else if (s.last) {
      const l = s.last;
      say(t('arc.last', { moved: l.moved, size: fmtBytes(l.bytes), failed: l.failed }) + (l.error ? ` ${t('arc.lastError', { msg: l.error })}` : ''), !!l.error && !l.moved);
    }
    if (d.config.driver === 'smb' && !d.tools.smbclient) say(t('arc.noSmbclient'), true);
  };
  const apply = (d) => {
    const c = d.config;
    driver.value = c.driver || '';
    target.value = c.driver === 'smb' ? c.target.replaceAll('/', '\\') : c.target || '';
    dir.value = c.dir || 'cam-app';
    user.value = c.user || '';
    pass.value = '';
    pass.placeholder = c.hasPassword ? t('arc.passSaved') : '';
    tls.input.checked = !!c.insecureTls;
    after.value = c.afterDays;
    keep.value = c.keepDays;
    enabled.input.checked = !!c.enabled;
    refreshFields();
    showStatus(d);
  };
  const load = async () => { const d = await api('GET', '/api/admin/archive'); apply(d); return d; };
  const body = () => ({ driver: driver.value, target: target.value, dir: dir.value, user: user.value, password: pass.value, insecureTls: tls.input.checked, enabled: enabled.input.checked, afterDays: Number(after.value), keepDays: Number(keep.value) });
  const guard = (fn) => async () => { try { await fn(); } catch (err) { say(errorText(err), true); } };
  const save = el('button', { type: 'button', class: 'primary', onclick: guard(async () => { apply(await api('PUT', '/api/admin/archive', body())); toast(t('arc.saved')); }) }, t('arc.save'));
  const test = el('button', {
    type: 'button',
    onclick: guard(async () => {
      apply(await api('PUT', '/api/admin/archive', body()));
      say(t('arc.testing'));
      await api('POST', '/api/admin/archive/test');
      say(t('arc.testOk'));
    }),
  }, t('arc.test'));
  // Controlla lo stato ogni secondo finché l'archiviazione è in corso (la barra segue "fatti / da fare").
  function watch() {
    clearInterval(timer);
    timer = setInterval(async () => {
      if (!document.body.contains(info)) { clearInterval(timer); timer = null; return; }
      try {
        const d = await api('GET', '/api/admin/archive');
        if (!d.status.running) { clearInterval(timer); timer = null; }
        showStatus(d);
      } catch { /* si riprova */ }
    }, 1000);
  }
  const runNow = el('button', {
    type: 'button',
    onclick: guard(async () => {
      await api('POST', '/api/admin/archive/run');
      barBox.hidden = false; // subito, prima del primo aggiornamento: la barra parte indeterminata
      bar.removeAttribute('value');
      barLabel.textContent = t('arc.preparing');
      watch();
    }),
  }, t('arc.runNow'));
  load().catch(() => {});
  return section(t('arc.title'), el('p', { class: 'note' }, t('arc.hint')), info, barBox, row(t('arc.type'), driver), fields,
    row(t('arc.after'), after), row(t('arc.keep'), keep), el('p', { class: 'note' }, t('arc.keepHint')), enabled.node,
    el('div', { class: 'srow-inline' }, save, test, runNow), out);
}

// ---------- sistema ----------
function systemSection() {
  const box = el('div');
  const out = el('p', { class: 'note' });
  const days = (s) => (s >= 86400 ? `${Math.floor(s / 86400)} d ${Math.floor((s % 86400) / 3600)} h` : s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min` : `${Math.max(1, Math.floor(s / 60))} min`);
  api('GET', '/api/admin/system').then((r) => {
    if (!r.rebootAvailable) { out.textContent = t('set.sysNoReboot'); return; }
    out.textContent = t('set.sysUptime', { t: days(r.uptime) });
    box.append(el('button', {
      type: 'button',
      class: 'danger',
      onclick: async (e) => {
        if (!confirm(t('set.sysConfirm'))) return;
        e.target.disabled = true;
        try {
          await api('POST', '/api/admin/system/reboot', { confirm: true });
        } catch (err) { out.className = 'note err'; out.textContent = errorText(err); e.target.disabled = false; return; }
        out.className = 'note ok';
        out.textContent = t('set.sysRebooting');
        // Il sistema si spegne e riparte: si aspetta che torni a rispondere, poi si ricarica la pagina.
        let down = false;
        const wait = setInterval(async () => {
          try {
            const res = await fetch('/healthz', { cache: 'no-store' });
            if (res.ok && down) { clearInterval(wait); location.reload(); }
          } catch { down = true; }
        }, 3000);
      },
    }, t('set.sysReboot')));
  }).catch(() => {});
  return section(t('set.system'), el('p', { class: 'note' }, t('set.sysHint')), box, out);
}

// ---------- finestra ----------
async function build() {
  const s = state.settings;
  const body = $('#settings-body');
  body.replaceChildren();

  // Generale
  const lang = el('select');
  for (const [code, name] of LANGS) lang.add(new Option(name, code));
  lang.value = getLang();
  lang.addEventListener('change', () => {
    setLang(lang.value);
    build(); // ridisegna la finestra nella nuova lingua
  });
  const wake = number(s.wakeLimit ?? 60, 0, 3600);
  const admin = isAdmin();
  $('#settings-save').hidden = !admin;
  // Popup con immagine all'arrivo di un evento: preferenza di questo dispositivo.
  const evPopup = check(t('set.eventPopup'), pref.get('eventPopup') !== '0');
  evPopup.input.addEventListener('change', () => pref.set('eventPopup', evPopup.input.checked ? '1' : '0'));
  const wakeEv = check(t('set.wakeOnEvent'), pref.get('wakeOnEvent') !== '0');
  wakeEv.input.addEventListener('change', () => pref.set('wakeOnEvent', wakeEv.input.checked ? '1' : '0'));
  body.append(section(t('set.general'), row(t('set.language'), lang), evPopup.node, wakeEv.node,
    ...(admin ? [row(t('set.wakeLimit'), wake), el('p', { class: 'note' }, t('set.wakeHint'))] : [])));

  // Audio
  body.append(await audioSection());

  // Utenti non amministratori: solo lingua e audio di questo dispositivo, più le notifiche del sistema.
  if (!admin) {
    const note = el('span', { class: 'note' });
    if ('Notification' in window && Notification.permission === 'granted') note.textContent = t('set.notifyGranted');
    body.append(section(t('set.alerts'), 'Notification' in window ? el('div', { class: 'srow-inline' },
      el('button', { type: 'button', onclick: async () => { const r = await Notification.requestPermission(); note.textContent = t(r === 'granted' ? 'set.notifyGranted' : 'set.notifyDenied'); } }, t('set.notifyPerm')), note) : null));
    return;
  }

  // Allarmi
  const flash = Object.fromEntries(FLASH_KINDS.map((k) => [k, check(t(`kind.${k}`), s.flash.kinds.includes(k))]));
  const fallback = check(t('set.flashFallback'), s.flash.motionFallback);
  const popup = check(t('set.bellPopup'), s.doorbell.popup);
  const notify = check(t('set.bellNotify'), s.doorbell.notify);
  const chime = check(t('set.bellChime'), s.doorbell.chime);
  const autoClose = number(s.doorbell.autoCloseSeconds, 0, 3600);
  const permNote = el('span', { class: 'note' });
  const perm = 'Notification' in window ? el('button', {
    type: 'button',
    onclick: async () => {
      const r = await Notification.requestPermission();
      permNote.textContent = t(r === 'granted' ? 'set.notifyGranted' : 'set.notifyDenied');
    },
  }, t('set.notifyPerm')) : null;
  if (perm && Notification.permission === 'granted') permNote.textContent = t('set.notifyGranted');
  const testCam = el('select');
  for (const c of state.cameras) testCam.add(new Option(c.name, c.id));
  const test = (kind) => () => testCam.value && api('POST', '/api/events/test', { camId: testCam.value, kind }).catch((e) => toast(errorText(e), { kind: 'err' }));
  body.append(section(t('set.alerts'),
    el('p', { class: 'note' }, t('set.flashKinds')),
    el('div', { class: 'checks' }, Object.values(flash).map((f) => f.node)),
    fallback.node,
    el('h4', {}, t('set.bell')),
    popup.node, notify.node, chime.node,
    row(t('set.bellClose'), autoClose),
    el('div', { class: 'srow-inline' }, perm, permNote),
    el('div', { class: 'srow-inline' }, el('span', {}, t('set.test')), testCam,
      el('button', { type: 'button', onclick: test('person') }, t('set.testFlash')),
      el('button', { type: 'button', onclick: test('visitor') }, t('set.testBell')))));

  // Eventi e database
  const ev = {
    enabled: check(t('set.evEnabled'), s.events.enabled),
    snapshot: check(t('set.evSnapshot'), s.events.snapshot),
    clip: number(s.events.clipSeconds, 0, 120),
    keep: number(s.events.retentionDays, 0, 3650),
    cooldown: number(s.events.cooldown, 0, 600),
  };
  const stats = el('p', { class: 'note' });
  api('GET', '/api/events?limit=1').then((r) => { stats.textContent = t('set.evStats', { events: r.counts.events, persons: r.counts.persons, faces: r.counts.faces }); }).catch(() => {});
  body.append(section(t('set.events'), ev.enabled.node, ev.snapshot.node,
    row(t('set.evClip'), ev.clip), row(t('set.evRetention'), ev.keep), row(t('set.evCooldown'), ev.cooldown), stats));

  // Eufy
  body.append(eufySection());

  // Home Assistant
  body.append(haSection());

  // Certificato per i telefoni
  body.append(certSection());

  // Archivio di rete degli eventi
  body.append(archiveSection());

  // Sistema (riavvio del CT)
  body.append(systemSection());

  // Riconoscimento
  const rec = {
    faces: check(t('set.recFaces'), s.recognition.faces), vehicles: check(t('set.recVehicles'), s.recognition.vehicles), pets: check(t('set.recPets'), s.recognition.pets),
    vehicleIds: check(t('set.recVehicleIds'), s.recognition.vehicleIds), suggest: check(t('set.recSuggest'), s.recognition.suggest !== false), boxes: check(t('set.recBoxes'), s.recognition.boxes !== false),
  };
  const vehThr = el('input', { type: 'range', min: 0.5, max: 0.99, step: 0.01, value: s.recognition.vehicleThreshold ?? 0.85 });
  const thr =el('input', { type: 'range', min: 0.2, max: 0.7, step: 0.01, value: s.recognition.faceThreshold });
  const petThr = el('input', { type: 'range', min: 0.5, max: 0.97, step: 0.01, value: s.recognition.petThreshold ?? 0.82 });
  const models = el('p', { class: 'note' });
  const petNote = el('p', { class: 'note' }, t('set.recPetsHint'));
  api('GET', '/api/recognition/status').then((r) => {
    models.textContent = t('set.recModels', { state: r.ready ? t('set.recReady') : t('set.recMissing') });
    petNote.textContent = t('set.recPetsHint') + ' ' + (r.pets ? t('set.recPetsReady') : t('set.recPetsMissing'));
  }).catch(() => { models.textContent = t('set.recModels', { state: t('set.recMissing') }); });
  body.append(section(t('set.recognition'), rec.faces.node, rec.vehicles.node, row(t('set.recThreshold'), thr), rec.pets.node, row(t('set.recPetThreshold'), petThr), rec.vehicleIds.node, row(t('set.recVehicleThreshold'), vehThr), rec.suggest.node, rec.boxes.node, petNote, models, el('p', { class: 'note' }, t('set.recPrivacy'))));

  // Allerta incendio e allagamento (controllo sul video, per telecamera)
  const hz = s.hazard || { cams: {}, sensitivity: 2 };
  const hzSens = el('select', {}, ...[1, 2, 3].map((n) => new Option(t(`set.hzSens${n}`), n)));
  hzSens.value = String(hz.sensitivity || 2);
  const hzRows = state.cameras.filter((c) => !c.battery).map((c) => {
    const fire = check(`🔥 ${t('set.hzFire')}`, !!hz.cams?.[c.id]?.fire);
    const flood = check(`💧 ${t('set.hzFlood')}`, !!hz.cams?.[c.id]?.flood);
    return { id: c.id, fire, flood, node: el('div', { class: 'hzcam' }, el('b', {}, c.name), fire.node, flood.node) };
  });
  body.append(section(t('set.hazard'), el('p', { class: 'note' }, t('set.hazardHint')), row(t('set.hzSens'), hzSens), ...hzRows.map((r) => r.node)));

  // Salvataggio
  $('#settings-save').onclick = async () => {
    const next = {
      wakeLimit: Number(wake.value),
      flash: { kinds: FLASH_KINDS.filter((k) => flash[k].input.checked), motionFallback: fallback.input.checked },
      events: { enabled: ev.enabled.input.checked, snapshot: ev.snapshot.input.checked, clipSeconds: Number(ev.clip.value), retentionDays: Number(ev.keep.value), cooldown: Number(ev.cooldown.value) },
      doorbell: { popup: popup.input.checked, notify: notify.input.checked, chime: chime.input.checked, autoCloseSeconds: Number(autoClose.value) },
      recognition: {
        faces: rec.faces.input.checked, vehicles: rec.vehicles.input.checked, pets: rec.pets.input.checked, faceThreshold: Number(thr.value), petThreshold: Number(petThr.value),
        vehicleIds: rec.vehicleIds.input.checked, vehicleThreshold: Number(vehThr.value), suggest: rec.suggest.input.checked, boxes: rec.boxes.input.checked,
      },
      hazard: {
        sensitivity: Number(hzSens.value),
        cams: Object.fromEntries(hzRows.filter((r) => r.fire.input.checked || r.flood.input.checked).map((r) => [r.id, { fire: r.fire.input.checked, flood: r.flood.input.checked }])),
      },
    };
    try {
      state.settings = await api('PUT', '/api/settings', next);
      toast(t('set.saved'));
      $('#settings').close();
    } catch (err) {
      toast(errorText(err), { kind: 'err' });
    }
  };
}

export function initSettings(appApi) {
  app = appApi;
  $('#btn-settings').addEventListener('click', async () => {
    await build();
    $('#settings').showModal();
  });
  $('#settings-close').addEventListener('click', () => $('#settings').close());
}
