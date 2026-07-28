// ----------------------------- Admin panel: People & Access -----------------------------
// Renders into #adminPeopleRoot, which renderSettings() puts on the page. Only
// mounted for admins (main.js decides), and every action is independently
// enforced by the database — the UI is convenience, not the security boundary.

import {
  listPeople, setRole, createAccount, setPassword, deleteAccount, serviceAvailable,
} from './admin-users.js';

const ROLES = [
  ['viewer', 'Viewer', 'Reads everything, saves nothing'],
  ['editor', 'Editor', 'Full read/write on builds'],
  ['admin', 'Admin', 'Editor, plus manages people'],
];

let people = [];
let hasService = null;   // null = not yet checked
let busy = false;
let myEmail = '';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function root() { return document.getElementById('adminPeopleRoot'); }

function when(iso) {
  if (!iso) return 'never';
  const d = new Date(iso);
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function notify(msg, tone = 'info') {
  const el = root()?.querySelector('[data-admin-msg]');
  if (!el) return;
  el.textContent = msg;
  el.className = `admin-msg ${tone}`;
  el.hidden = !msg;
}

export async function renderAdminPanel() {
  const el = root();
  if (!el) return;

  if (hasService === null) {
    el.innerHTML = `<div class="card admin-card"><h3>People &amp; Access</h3>
      <p class="card-hint">Loading…</p></div>`;
    hasService = await serviceAvailable();
  }

  try {
    people = await listPeople();
  } catch (err) {
    el.innerHTML = `<div class="card admin-card"><h3>People &amp; Access</h3>
      <p class="card-hint admin-err">Could not load the account list: ${esc(err.message)}</p></div>`;
    return;
  }

  const counts = ROLES.reduce((acc, [id]) => {
    acc[id] = people.filter((p) => p.role === id).length;
    return acc;
  }, {});

  const rows = people.map((p) => {
    const isMe = p.email && p.email.toLowerCase() === myEmail.toLowerCase();
    const options = ROLES.map(([id, label]) =>
      `<option value="${id}"${p.role === id ? ' selected' : ''}>${label}</option>`).join('');
    return `<div class="admin-row${isMe ? ' is-me' : ''}">
      <div class="admin-who">
        <span class="admin-email">${esc(p.email)}${isMe ? ' <span class="admin-you">you</span>' : ''}</span>
        <span class="admin-meta">
          ${p.confirmed ? '' : '<span class="admin-warn">unconfirmed — cannot sign in</span> · '}
          last signed in ${when(p.lastSignInAt)}
        </span>
      </div>
      <select class="admin-role" data-admin-role="${esc(p.userId)}" data-admin-email="${esc(p.email)}"
        ${busy ? 'disabled' : ''} title="Permission level">${options}</select>
      <div class="admin-acts">
        ${hasService ? `
          <button type="button" class="btn sm" data-admin-pw="${esc(p.userId)}" data-admin-label="${esc(p.email)}"
            ${busy ? 'disabled' : ''}>Set password</button>
          <button type="button" class="btn sm danger" data-admin-del="${esc(p.userId)}" data-admin-label="${esc(p.email)}"
            ${busy || isMe ? 'disabled' : ''} title="${isMe ? 'You cannot delete your own account' : 'Delete this account'}">Delete</button>
        ` : ''}
      </div>
    </div>`;
  }).join('');

  el.innerHTML = `<div class="card admin-card">
    <h3>People &amp; Access</h3>
    <p class="card-hint">
      ${counts.admin} admin · ${counts.editor} editor · ${counts.viewer} viewer.
      Permission changes take effect the next time that person reloads.
    </p>

    <div class="admin-msg" data-admin-msg hidden></div>

    ${hasService ? '' : `<div class="admin-note">
      Account creation and deletion need the <code>admin-users</code> function, which
      isn't deployed yet. You can still change permission levels here; create accounts
      in the Supabase dashboard for now.
    </div>`}

    <div class="admin-list">${rows || '<div class="td-sub">No accounts found.</div>'}</div>

    ${hasService ? `
      <div class="admin-add">
        <div class="admin-add-title">Add an account</div>
        <div class="admin-add-fields">
          <input type="email" id="adminNewEmail" placeholder="name@windriverbuilt.com" autocomplete="off">
          <input type="text" id="adminNewPass" placeholder="Temporary password (8+ chars)" autocomplete="off">
          <select id="adminNewRole">
            ${ROLES.map(([id, label]) => `<option value="${id}"${id === 'viewer' ? ' selected' : ''}>${label}</option>`).join('')}
          </select>
          <button type="button" class="btn primary" id="adminCreate" ${busy ? 'disabled' : ''}>Create</button>
        </div>
        <div class="admin-add-hint">
          The account is confirmed immediately, so it works right away. No email is sent —
          pass the password to the person yourself, and note it down before you click Create.
        </div>
      </div>` : ''}
  </div>`;

  wire();
}

function wire() {
  const el = root();
  if (!el || el.dataset.wired) return;
  el.dataset.wired = '1';

  el.addEventListener('change', async (e) => {
    const sel = e.target.closest('[data-admin-role]');
    if (!sel || busy) return;
    const userId = sel.dataset.adminRole;
    const email = sel.dataset.adminEmail;
    const role = sel.value;
    const previous = people.find((p) => p.userId === userId)?.role;
    if (role === previous) return;

    if (previous === 'admin' && role !== 'admin') {
      const admins = people.filter((p) => p.role === 'admin').length;
      if (admins <= 1 && !confirm('This is the only admin. Removing that leaves nobody able to manage people — you would need SQL to recover. Continue?')) {
        sel.value = previous;
        return;
      }
    }

    busy = true;
    notify(`Updating ${email}…`);
    try {
      await setRole(userId, email, role);
      busy = false;
      await renderAdminPanel();
      notify(`${email} is now ${role === 'viewer' ? 'a viewer' : 'an ' + role}.`, 'ok');
    } catch (err) {
      busy = false;
      sel.value = previous;
      notify(err.message, 'err');
    }
  });

  el.addEventListener('click', async (e) => {
    if (busy) return;

    const create = e.target.closest('#adminCreate');
    if (create) {
      const email = el.querySelector('#adminNewEmail').value.trim();
      const password = el.querySelector('#adminNewPass').value;
      const role = el.querySelector('#adminNewRole').value;
      if (!email || !password) return notify('Enter both an email and a password.', 'err');
      if (password.length < 8) return notify('Password must be at least 8 characters.', 'err');

      busy = true;
      notify(`Creating ${email}…`);
      try {
        const res = await createAccount({ email, password, role });
        busy = false;
        await renderAdminPanel();
        notify(res.warning || `Created ${email}. Give them the password you just set.`,
          res.warning ? 'err' : 'ok');
      } catch (err) {
        busy = false;
        notify(err.message, 'err');
      }
      return;
    }

    const pw = e.target.closest('[data-admin-pw]');
    if (pw) {
      const label = pw.dataset.adminLabel;
      const next = prompt(`New password for ${label} (8+ characters):`);
      if (next === null) return;
      if (next.length < 8) return notify('Password must be at least 8 characters.', 'err');
      busy = true;
      notify(`Updating password for ${label}…`);
      try {
        await setPassword(pw.dataset.adminPw, next);
        busy = false;
        await renderAdminPanel();
        notify(`Password updated for ${label}. Their existing sessions stay signed in until they sign out.`, 'ok');
      } catch (err) {
        busy = false;
        notify(err.message, 'err');
      }
      return;
    }

    const del = e.target.closest('[data-admin-del]');
    if (del) {
      const label = del.dataset.adminLabel;
      if (!confirm(`Delete the account for ${label}?\n\nThey lose access immediately. This cannot be undone. Planning data is not affected.`)) return;
      busy = true;
      notify(`Deleting ${label}…`);
      try {
        await deleteAccount(del.dataset.adminDel);
        busy = false;
        await renderAdminPanel();
        notify(`Deleted ${label}.`, 'ok');
      } catch (err) {
        busy = false;
        notify(err.message, 'err');
      }
    }
  });
}

export function initAdminPanel(email) {
  myEmail = email || '';
  // renderSettings() rebuilds #adminPeopleRoot each time the tab renders, so it
  // calls this hook afterwards rather than us trying to survive the re-render.
  globalThis.__TRAVELER_RENDER_ADMIN__ = () => {
    const el = root();
    if (el) { delete el.dataset.wired; renderAdminPanel(); }
  };
  globalThis.__TRAVELER_RENDER_ADMIN__();
}
