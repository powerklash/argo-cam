// Backend amministratore: utenti, password e telecamere abilitate per ciascun utente.
import { t, applyI18n, fmtDate } from './i18n.js';
import { state, $, api, el, toast, errorText } from './state.js';

state.me = (await api('GET', '/api/auth/me')).user;
if (state.me.role !== 'admin') location.replace('/');
applyI18n();

let data = { users: [], cameras: [] };
const table = $('#users');

async function load() {
  data = await api('GET', '/api/admin/users');
  render();
}

const fail = (err) => toast(errorText(err), { kind: 'err' });

// ---------- finestre ----------
/** Finestra modale generica: restituisce il <dialog> già aperto. */
function modal(title, body, actions) {
  const dlg = el('dialog', { class: 'wide-sm' },
    el('h2', {}, title), body, el('div', { class: 'actions' }, el('div', { class: 'spacer' }), ...actions));
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
  return dlg;
}
const closeBtn = (dlg) => el('button', { type: 'button', onclick: () => dlg.close() }, t('btn.close'));
const field = (label, input) => el('label', {}, el('span', {}, label), input);
const check = (label, checked) => {
  const input = el('input', { type: 'checkbox', checked });
  return { input, node: el('label', { class: 'check' }, input, el('span', {}, label)) };
};

async function generate() {
  return (await api('POST', '/api/admin/generate-password')).password;
}

/** Campo password con "Genera" e "Mostra". */
function passwordField(initial = '') {
  const input = el('input', { type: 'password', autocomplete: 'new-password', minLength: 8, value: initial });
  const gen = el('button', { type: 'button', onclick: async () => { input.value = await generate(); input.type = 'text'; } }, t('adm.generate'));
  const show = el('button', { type: 'button', onclick: () => { input.type = input.type === 'password' ? 'text' : 'password'; } }, t('adm.show'));
  return { input, node: el('div', { class: 'pw-row' }, input, gen, show) };
}

function userDialog(user) {
  const username = el('input', { value: user?.username || '', required: true, maxLength: 32, autocomplete: 'off', autocapitalize: 'none' });
  const name = el('input', { value: user?.displayName || '', maxLength: 60 });
  const role = el('select', {}, new Option(t('user.roleUser'), 'user'), new Option(t('user.roleAdmin'), 'admin'));
  role.value = user?.role || 'user';
  const pw = passwordField();
  const must = check(t('adm.mustChange'), true);
  const err = el('p', { class: 'error', hidden: true });
  const body = el('div', {}, field(t('adm.username'), username), field(t('adm.displayName'), name), field(t('adm.role'), role),
    user ? null : field(t('adm.initialPassword'), pw.node), user ? null : must.node, err);
  const save = el('button', {
    type: 'button', class: 'primary',
    onclick: async () => {
      try {
        if (user) {
          await api('PUT', `/api/admin/users/${user.id}`, { username: username.value, displayName: name.value, role: role.value });
        } else {
          await api('POST', '/api/admin/users', { username: username.value, displayName: name.value, role: role.value, password: pw.input.value, mustChange: must.input.checked });
        }
        dlg.close();
        toast(t(user ? 'adm.saved' : 'adm.created'));
        await load();
        // Un nuovo utente non vede ancora nessuna telecamera: si apre subito la scelta.
        if (!user) {
          const created = data.users.find((u) => u.username.toLowerCase() === username.value.trim().toLowerCase());
          if (created && created.role !== 'admin') camerasDialog(created);
        }
      } catch (e) { err.textContent = errorText(e); err.hidden = false; }
    },
  }, t(user ? 'btn.save' : 'adm.create'));
  const dlg = modal(t(user ? 'adm.edit' : 'adm.newUser'), body, [closeBtn({ close: () => dlg.close() }), save]);
  username.focus();
}

function passwordDialog(user) {
  const pw = passwordField();
  const must = check(t('adm.mustChange'), true);
  const err = el('p', { class: 'error', hidden: true });
  const body = el('div', {}, pw.node, must.node, el('p', { class: 'note' }, t('adm.shareHint')), err);
  const save = el('button', {
    type: 'button', class: 'primary',
    onclick: async () => {
      try {
        await api('POST', `/api/admin/users/${user.id}/password`, { password: pw.input.value, mustChange: must.input.checked });
        const shown = pw.input.value;
        dlg.close();
        showSecret(user, shown);
        await load();
      } catch (e) { err.textContent = errorText(e); err.hidden = false; }
    },
  }, t('btn.save'));
  const dlg = modal(t('adm.newPasswordFor', { name: user.displayName || user.username }), body, [el('button', { type: 'button', onclick: () => dlg.close() }, t('btn.cancel')), save]);
}

/** Mostra una sola volta la password impostata, con "Copia". */
function showSecret(user, password) {
  const out = el('input', { value: password, readOnly: true, class: 'secret' });
  const copy = el('button', {
    type: 'button',
    onclick: async () => {
      try { await navigator.clipboard.writeText(password); } catch { out.select(); document.execCommand('copy'); }
      toast(t('adm.copied'));
    },
  }, t('adm.copy'));
  const dlg = modal(t('adm.newPasswordFor', { name: user.displayName || user.username }),
    el('div', {}, el('div', { class: 'pw-row' }, out, copy), el('p', { class: 'note' }, t('adm.shareHint'))), [el('button', { type: 'button', class: 'primary', onclick: () => dlg.close() }, t('btn.close'))]);
  out.select();
}

function camerasDialog(user) {
  const levels = { ...user.cameras };
  const rows = data.cameras.map((c) => {
    const name = `cam-${user.id}-${c.id}`;
    const radio = (value, label) => {
      const input = el('input', { type: 'radio', name, value: String(value), checked: (levels[c.id] || 0) === value });
      input.addEventListener('change', () => { levels[c.id] = value; });
      return el('label', { class: 'radio' }, input, el('span', {}, label));
    };
    return el('div', { class: 'cam-row' }, el('b', {}, c.name), el('div', { class: 'radios' }, radio(0, t('adm.none')), radio(1, t('adm.view')), radio(2, t('adm.control'))));
  });
  const setAll = (v) => () => {
    for (const c of data.cameras) levels[c.id] = v;
    for (const input of dlg.querySelectorAll('input[type=radio]')) input.checked = input.value === String(v);
  };
  const body = el('div', {},
    user.role === 'admin' ? el('p', { class: 'note' }, t('adm.adminNote')) : null,
    data.cameras.length ? el('div', { class: 'row' }, el('button', { type: 'button', onclick: setAll(1) }, t('adm.setAllView')), el('button', { type: 'button', onclick: setAll(0) }, t('adm.setAllNone'))) : el('p', { class: 'note' }, t('adm.noCameras')),
    el('div', { class: 'cam-list' }, rows), el('p', { class: 'note' }, t('adm.controlHint')));
  const save = el('button', {
    type: 'button', class: 'primary',
    onclick: async () => {
      try {
        await api('PUT', `/api/admin/users/${user.id}/cameras`, { levels });
        dlg.close();
        toast(t('adm.saved'));
        await load();
      } catch (e) { fail(e); }
    },
  }, t('btn.save'));
  const dlg = modal(t('adm.camerasOf', { name: user.displayName || user.username }), body, [el('button', { type: 'button', onclick: () => dlg.close() }, t('btn.cancel')), save]);
}

// ---------- elenco ----------
function render() {
  const head = el('thead', {}, el('tr', {}, ...['adm.username', 'adm.role', 'adm.status', 'adm.lastLogin', 'adm.sessions', 'adm.cameras', ''].map((k) => el('th', {}, k ? t(k) : ''))));
  const rows = data.users.map((u) => {
    const mine = u.id === state.me.id;
    const act = (label, fn, cls = '') => el('button', { type: 'button', class: cls, onclick: () => fn().catch(fail) }, label);
    const camText = u.role === 'admin' ? t('adm.allCameras') : t('adm.camCount', { n: Object.keys(u.cameras).length, m: data.cameras.length });
    return el('tr', { class: u.disabled ? 'off' : '' },
      el('td', { 'data-label': t('adm.username') }, el('b', {}, u.username), mine ? ` ${t('adm.you')}` : '', el('div', { class: 'note' }, u.displayName)),
      el('td', { 'data-label': t('adm.role') }, el('span', { class: `badge ${u.role === 'admin' ? 'k-person' : ''}` }, t(u.role === 'admin' ? 'user.roleAdmin' : 'user.roleUser'))),
      el('td', { 'data-label': t('adm.status') }, u.disabled ? t('adm.disabled') : t('adm.active')),
      el('td', { 'data-label': t('adm.lastLogin') }, u.lastLogin ? fmtDate(u.lastLogin) : t('adm.never')),
      el('td', { 'data-label': t('adm.sessions') }, String(u.sessions)),
      el('td', { 'data-label': t('adm.cameras') }, camText),
      el('td', { class: 'acts-cell' },
        act(t('adm.camerasBtn'), async () => camerasDialog(u)),
        act(t('adm.edit'), async () => userDialog(u)),
        act(t('adm.password'), async () => passwordDialog(u)),
        u.sessions ? act(t('adm.revoke'), async () => { await api('POST', `/api/admin/users/${u.id}/revoke`); toast(t('adm.revoked')); await load(); }) : null,
        mine ? null : act(t(u.disabled ? 'adm.enable' : 'adm.disable'), async () => { await api('PUT', `/api/admin/users/${u.id}`, { disabled: !u.disabled }); await load(); }),
        mine ? null : act(t('adm.delete'), async () => {
          if (!confirm(t('adm.deleteConfirm', { name: u.username }))) return;
          await api('DELETE', `/api/admin/users/${u.id}`);
          await load();
        }, 'danger')));
  });
  table.replaceChildren(head, el('tbody', {}, ...rows));
}

// ---------- recupero password (domande di questo amministratore) ----------
let recovery = { configured: false, questions: [], updated: null };
const recBox = $('#recovery');

function renderRecovery() {
  const status = recovery.configured
    ? el('p', {}, t('rec.admOn', { date: fmtDate(recovery.updated) }))
    : el('p', { class: 'err' }, t('rec.admOff'));
  const list = recovery.configured ? el('ol', { class: 'note' }, ...recovery.questions.map((q) => el('li', {}, q))) : null;
  const edit = el('button', { type: 'button', class: 'primary', onclick: recoveryDialog }, t(recovery.configured ? 'rec.admChange' : 'rec.admSet'));
  const remove = recovery.configured ? el('button', { type: 'button', class: 'danger', onclick: removeRecovery }, t('rec.admRemove')) : null;
  recBox.replaceChildren(status, el('p', { class: 'note' }, t('rec.admHint')), list, el('div', { class: 'actions' }, edit, remove));
}

function recoveryDialog() {
  const rows = [0, 1, 2].map((i) => ({
    q: el('input', { maxLength: 120, autocomplete: 'off', value: recovery.questions[i] || '', placeholder: t('rec.questionN', { n: i + 1 }) }),
    a: el('input', { maxLength: 100, autocomplete: 'off', placeholder: t('rec.answerN', { n: i + 1 }) }),
  }));
  const current = el('input', { type: 'password', autocomplete: 'current-password' });
  const err = el('p', { class: 'error', hidden: true });
  const body = el('div', {},
    el('p', { class: 'note' }, t('rec.admRules')),
    ...rows.map((r, i) => el('div', {}, field(t('rec.questionN', { n: i + 1 }), r.q), field(t('rec.answerN', { n: i + 1 }), r.a))),
    field(t('rec.confirmWith'), current), err);
  const save = el('button', {
    type: 'button', class: 'primary',
    onclick: async () => {
      try {
        recovery = await api('PUT', '/api/admin/recovery', { current: current.value, items: rows.map((r) => ({ question: r.q.value, answer: r.a.value })) });
        dlg.close();
        toast(t('rec.admSaved'));
        renderRecovery();
      } catch (e) { err.textContent = errorText(e); err.hidden = false; }
    },
  }, t('btn.save'));
  const dlg = modal(t('rec.admDialog'), body, [el('button', { type: 'button', onclick: () => dlg.close() }, t('btn.cancel')), save]);
  rows[0].q.focus();
}

function removeRecovery() {
  const current = el('input', { type: 'password', autocomplete: 'current-password' });
  const err = el('p', { class: 'error', hidden: true });
  const ok = el('button', {
    type: 'button', class: 'danger',
    onclick: async () => {
      try {
        recovery = await api('DELETE', '/api/admin/recovery', { current: current.value });
        dlg.close();
        renderRecovery();
      } catch (e) { err.textContent = errorText(e); err.hidden = false; }
    },
  }, t('rec.admRemove'));
  const dlg = modal(t('rec.admRemove'), el('div', {}, el('p', { class: 'note' }, t('rec.admRemoveHint')), field(t('rec.confirmWith'), current), err),
    [el('button', { type: 'button', onclick: () => dlg.close() }, t('btn.cancel')), ok]);
  current.focus();
}

$('#btn-new').addEventListener('click', () => userDialog(null));
document.addEventListener('langchange', () => { render(); renderRecovery(); });
await load();
recovery = await api('GET', '/api/admin/recovery');
renderRecovery();
