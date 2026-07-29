// ----------------------------- Admin: People & Access -----------------------------
// Settings shows a compact summary card with one button. The full list, the role
// controls and the add-account form live in a modal, so a 22-person roster doesn't
// bury the rest of Settings.
//
// On passwords: none are displayed anywhere, because none can be. Supabase stores
// bcrypt hashes; the plaintext ceases to exist the moment it's set, and no key —
// including the service key — can retrieve it. What's shown instead is credential
// *status* (confirmed, never signed in, last sign-in), which answers the question
// an admin actually has: who still needs onboarding.

import {
  listPeople, setRole, createAccount, setPassword, deleteAccount, serviceAvailable,
} from './admin-users.js';

const ROLES = [
  ['viewer', 'Viewer'],
  ['editor', 'Editor'],
  ['admin', 'Admin'],
];

let people = [];
let hasService = null;   // null = not yet probed
let busy = false;
let myEmail = '';
let filter = '';
let loadError = '';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const cardRoot = () => document.getElementById('adminPeopleRoot');
const overlay = () => document.getElementById('peopleOverlay');

function when(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** The one line that tells an admin whether this person is actually set up. */
function status(p) {
  if (!p.confirmed) return { text: 'Cannot sign in \u2014 not confirmed', tone: 'bad' };
  if (!p.lastSignInAt) return { text: 'Never signed in', tone: 'warn' };
  return { text: `Last signed in ${when(p.lastSignInAt)}`, tone: 'ok' };
}

function counts() {
  return ROLES.reduce((acc, [id]) => {
    acc[id] = people.filter((p) => p.role === id).length;
    return acc;
  }, {});
}

function summaryLine() {
  const c = counts();
  const parts = [];
  if (c.admin) parts.push(`${c.admin} admin${c.admin === 1 ? '' : 's'}`);
  if (c.editor) parts.push(`${c.editor} editor${c.editor === 1 ? '' : 's'}`);
  if (c.viewer) parts.push(`${c.viewer} viewer${c.viewer === 1 ? '' : 's'}`);
  return parts.join(' \u00b7 ') || 'No accounts';
}

async function loadPeople() {
  try {
    people = await listPeople();
    loadError = '';
  } catch (err) {
    loadError = err.message || String(err);
  }
}

// ----------------------------- Settings card -----------------------------

export async function renderAdminPanel() {
  const el = cardRoot();
  if (!el) return;

  if (hasService === null) {
    el.innerHTML = `<div class="card admin-card"><h3>People &amp; Access</h3>
      <p class="card-hint">Loading\u2026</p></div>`;
    hasService = await serviceAvailable();
  }
  await loadPeople();

  const pending = people.filter((p) => !p.confirmed || !p.lastSignInAt).length;

  el.innerHTML = `<div class="card admin-card settings-card tile-clickable" data-tile="1"
      id="openPeople" role="button" tabindex="0"
      aria-label="Open People and Access">
    <div class="tile-head">
      <h3>People &amp; Access</h3>
      <span class="tile-chevron">\u203a</span>
    </div>
    ${loadError
      ? `<div class="tile-sub admin-err">Could not load accounts: ${esc(loadError)}</div>`
      : `<div class="tile-sub">${esc(summaryLine())}</div>
         <div class="tile-note">
           ${pending
             ? `${pending} ${pending === 1 ? 'account has' : 'accounts have'} not signed in yet`
             : 'Everyone has signed in at least once'}
         </div>`}
  </div>`;

  // The whole card is the control, matching the other Settings tiles.
  const tile = el.querySelector('#openPeople');
  if (tile && !loadError) {
    tile.addEventListener('click', openPeople);
    tile.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPeople(); }
    });
  }
}

// ----------------------------- Modal -----------------------------

function openPeople() {
  let ov = overlay();
  if (!ov) {
    ov = document.createElement('div');
    ov.className = 'overlay';
    ov.id = 'peopleOverlay';
    ov.innerHTML = '<div class="modal" id="peopleModal"></div>';
    document.body.appendChild(ov);
    ov.addEventListener('click', (e) => { if (e.target === ov) closePeople(); });
    wireModal(ov);
  }
  ov.classList.add('open');
  filter = '';
  renderPeopleModal();
}

function closePeople() {
  overlay()?.classList.remove('open');
  // The card shows counts and the "not signed in" tally, so refresh it in case
  // something changed while the modal was open.
  renderAdminPanel();
}

function notify(msg, tone = 'info') {
  const el = overlay()?.querySelector('[data-people-msg]');
  if (!el) return;
  el.textContent = msg || '';
  el.className = `admin-msg ${tone}`;
  el.hidden = !msg;
}

function renderPeopleModal(keepMsg = false) {
  const ov = overlay();
  if (!ov) return;
  const prev = keepMsg ? ov.querySelector('[data-people-msg]')?.cloneNode(true) : null;

  const q = filter.trim().toLowerCase();
  const shown = q ? people.filter((p) => p.email.toLowerCase().includes(q)) : people;

  const rows = shown.map((p) => {
    const isMe = p.email && p.email.toLowerCase() === myEmail.toLowerCase();
    const st = status(p);
    const options = ROLES.map(([id, label]) =>
      `<option value="${id}"${p.role === id ? ' selected' : ''}>${label}</option>`).join('');
    return `<div class="admin-row${isMe ? ' is-me' : ''}">
      <div class="admin-who">
        <span class="admin-email">${esc(p.email)}${isMe ? ' <span class="admin-you">you</span>' : ''}</span>
        <span class="admin-meta admin-st-${st.tone}">${esc(st.text)}</span>
      </div>
      <select class="admin-role" data-people-role="${esc(p.userId)}" data-people-email="${esc(p.email)}"
        ${busy ? 'disabled' : ''} title="Permission level">${options}</select>
      <div class="admin-acts">
        ${hasService ? `
          <button type="button" class="btn sm" data-people-pw="${esc(p.userId)}" data-people-label="${esc(p.email)}"
            ${busy ? 'disabled' : ''} title="Set a new password for this person">Set password</button>
          <button type="button" class="btn sm danger" data-people-del="${esc(p.userId)}" data-people-label="${esc(p.email)}"
            ${busy || isMe ? 'disabled' : ''} title="${isMe ? 'You cannot delete your own account' : 'Delete this account'}">Delete</button>
        ` : ''}
      </div>
    </div>`;
  }).join('');

  ov.querySelector('#peopleModal').innerHTML = `
    <div class="modal-head">
      <div>
        <h2>People &amp; Access</h2>
        <div class="mono-sub">${esc(summaryLine())}</div>
      </div>
      <button type="button" class="ghost" data-people-close title="Close">\u2715</button>
    </div>

    <div class="modal-body">
      <div class="admin-msg" data-people-msg hidden></div>

      ${hasService ? '' : `<div class="admin-note">
        Creating and deleting accounts needs the <code>admin-users</code> function, which
        isn't reachable. Permission levels still work here; create accounts in the
        Supabase dashboard for now.
      </div>`}

      <div class="admin-toolbar">
        <input type="search" id="peopleFilter" class="search" placeholder="Filter by email\u2026"
          value="${esc(filter)}" autocomplete="off">
        <span class="admin-showing">${shown.length} of ${people.length}</span>
      </div>

      <div class="admin-list">${rows || '<div class="td-sub">No accounts match that filter.</div>'}</div>

      ${hasService ? `
        <div class="admin-add">
          <div class="admin-add-title">Add an account</div>
          <div class="admin-add-fields">
            <input type="email" id="peopleNewEmail" placeholder="name@windriverbuilt.com" autocomplete="off">
            <input type="text" id="peopleNewPass" placeholder="Temporary password (8+ chars)" autocomplete="off">
            <select id="peopleNewRole">
              ${ROLES.map(([id, label]) => `<option value="${id}"${id === 'viewer' ? ' selected' : ''}>${label}</option>`).join('')}
            </select>
            <button type="button" class="btn primary" id="peopleCreate" ${busy ? 'disabled' : ''}>Create</button>
          </div>
          <div class="admin-add-hint">
            <b>Write the password down before clicking Create.</b> Nothing is emailed, and
            passwords can't be displayed afterwards \u2014 only replaced. The account is
            confirmed immediately, so it works straight away.
          </div>
        </div>` : ''}
    </div>

    <div class="modal-foot">
      <span class="admin-foot-note">Permission changes apply the next time that person reloads.</span>
      <button type="button" class="btn" data-people-close>Done</button>
    </div>`;

  if (prev && !prev.hidden) ov.querySelector('[data-people-msg]').replaceWith(prev);
}

async function refreshModal(msg, tone) {
  await loadPeople();
  renderPeopleModal();
  if (msg) notify(msg, tone);
}

function wireModal(ov) {
  ov.addEventListener('click', async (e) => {
    if (e.target.closest('[data-people-close]')) { closePeople(); return; }
    if (busy) return;

    const create = e.target.closest('#peopleCreate');
    if (create) {
      const email = ov.querySelector('#peopleNewEmail').value.trim();
      const password = ov.querySelector('#peopleNewPass').value;
      const role = ov.querySelector('#peopleNewRole').value;
      if (!email || !password) return notify('Enter both an email and a password.', 'err');
      if (password.length < 8) return notify('Password must be at least 8 characters.', 'err');

      busy = true; notify(`Creating ${email}\u2026`);
      try {
        const res = await createAccount({ email, password, role });
        busy = false;
        await refreshModal(res.warning || `Created ${email}. Give them the password you just set \u2014 it can't be shown again.`,
          res.warning ? 'err' : 'ok');
      } catch (err) {
        busy = false; renderPeopleModal(); notify(err.message, 'err');
      }
      return;
    }

    const pw = e.target.closest('[data-people-pw]');
    if (pw) {
      const label = pw.dataset.peopleLabel;
      const next = prompt(`New password for ${label} (8+ characters).\n\nWrite it down \u2014 it cannot be displayed later.`);
      if (next === null) return;
      if (next.length < 8) return notify('Password must be at least 8 characters.', 'err');
      busy = true; notify(`Updating password for ${label}\u2026`);
      try {
        await setPassword(pw.dataset.peoplePw, next);
        busy = false;
        await refreshModal(`Password updated for ${label}. They stay signed in on existing devices until they sign out.`, 'ok');
      } catch (err) {
        busy = false; renderPeopleModal(); notify(err.message, 'err');
      }
      return;
    }

    const del = e.target.closest('[data-people-del]');
    if (del) {
      const label = del.dataset.peopleLabel;
      if (!confirm(`Delete the account for ${label}?\n\nThey lose access immediately. This cannot be undone. Planning data is not affected.`)) return;
      busy = true; notify(`Deleting ${label}\u2026`);
      try {
        await deleteAccount(del.dataset.peopleDel);
        busy = false;
        await refreshModal(`Deleted ${label}.`, 'ok');
      } catch (err) {
        busy = false; renderPeopleModal(); notify(err.message, 'err');
      }
    }
  });

  ov.addEventListener('change', async (e) => {
    const sel = e.target.closest('[data-people-role]');
    if (!sel || busy) return;
    const userId = sel.dataset.peopleRole;
    const email = sel.dataset.peopleEmail;
    const role = sel.value;
    const previous = people.find((p) => p.userId === userId)?.role;
    if (role === previous) return;

    if (previous === 'admin' && role !== 'admin' && counts().admin <= 1) {
      if (!confirm('This is the only admin. Removing that leaves nobody able to manage people \u2014 recovering would need direct database access. Continue?')) {
        sel.value = previous;
        return;
      }
    }

    busy = true; notify(`Updating ${email}\u2026`);
    try {
      await setRole(userId, email, role);
      busy = false;
      await refreshModal(`${email} is now ${role === 'viewer' ? 'a viewer' : 'an ' + role}.`, 'ok');
    } catch (err) {
      busy = false; sel.value = previous; renderPeopleModal(); notify(err.message, 'err');
    }
  });

  ov.addEventListener('input', (e) => {
    if (!e.target.closest('#peopleFilter')) return;
    filter = e.target.value;
    const pos = e.target.selectionStart;
    renderPeopleModal(true);
    const next = ov.querySelector('#peopleFilter');
    if (next) { next.focus(); try { next.setSelectionRange(pos, pos); } catch { /* ignore */ } }
  });

  ov.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePeople(); });
}

export function initAdminPanel(email) {
  myEmail = email || '';
  // renderSettings() rebuilds #adminPeopleRoot on every render of that tab, so it
  // calls this hook afterwards rather than us trying to survive the re-render.
  globalThis.__TRAVELER_RENDER_ADMIN__ = () => { if (cardRoot()) renderAdminPanel(); };
  globalThis.__TRAVELER_RENDER_ADMIN__();
}
