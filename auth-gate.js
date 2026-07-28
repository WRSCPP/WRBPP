// ----------------------------- Sign-in wall -----------------------------
// Shown when there is no session. Nothing else loads: main.js returns before it
// creates the backend, so no query is ever sent and no data reaches the page.
//
// This is deliberately self-contained — inline styles, no dependency on
// styles.css — so it renders correctly even if the stylesheet is slow or the
// app bundle would have failed to load.

import { signIn } from './store-cloud.js';

export function showAuthGate({ heading = 'Production Planner', note = '' } = {}) {
  // Remove anything the page already rendered. A viewer should not see even a
  // skeleton of the app before authenticating.
  document.body.innerHTML = '';
  document.body.style.margin = '0';

  const wrap = document.createElement('div');
  wrap.setAttribute('data-auth-gate', '');
  wrap.style.cssText = [
    'position:fixed', 'inset:0', 'z-index:99999',
    'display:flex', 'align-items:center', 'justify-content:center',
    'padding:24px', 'background:#F5F1E8', 'color:#1F2A33',
    'font-family:Inter,system-ui,-apple-system,sans-serif',
  ].join(';');

  wrap.innerHTML = `
    <div style="width:100%;max-width:360px">
      <div style="text-align:center;margin-bottom:22px">
        <div style="font-size:25px;font-weight:800;letter-spacing:-.01em">${heading}</div>
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#6b7280;margin-top:5px">Wind River Built</div>
      </div>
      <div style="background:#fff;border:1px solid #e2ddd0;border-radius:10px;padding:22px">
        <div style="font-size:13.5px;color:#4b5563;line-height:1.55;margin-bottom:16px">
          This planner contains confidential project information. Please sign in to continue.
        </div>
        <label style="display:block;margin-bottom:12px">
          <span style="display:block;font-size:11.5px;font-weight:600;margin-bottom:5px">Email</span>
          <input id="gateEmail" type="email" autocomplete="username"
            style="width:100%;box-sizing:border-box;padding:9px 11px;font-size:14px;font-family:inherit;border:1px solid #d5cfc0;border-radius:6px;background:#fff;color:inherit">
        </label>
        <label style="display:block;margin-bottom:16px">
          <span style="display:block;font-size:11.5px;font-weight:600;margin-bottom:5px">Password</span>
          <input id="gatePass" type="password" autocomplete="current-password"
            style="width:100%;box-sizing:border-box;padding:9px 11px;font-size:14px;font-family:inherit;border:1px solid #d5cfc0;border-radius:6px;background:#fff;color:inherit">
        </label>
        <div id="gateErr" hidden
          style="font-size:12.5px;font-weight:600;color:#C44F3A;background:#fdf1ef;border:1px solid #C44F3A;border-radius:6px;padding:8px 10px;margin-bottom:14px"></div>
        <button id="gateGo" type="button"
          style="width:100%;padding:10px;font-size:14px;font-weight:700;font-family:inherit;color:#fff;background:#1F2A33;border:0;border-radius:6px;cursor:pointer">Sign in</button>
        <div style="font-size:12px;color:#6b7280;line-height:1.5;margin-top:14px">
          Accounts are created by your administrator. If you don't have one, or your
          password isn't working, contact them directly.
        </div>
        ${note ? `<div style="font-size:12px;color:#6b7280;margin-top:10px">${note}</div>` : ''}
      </div>
    </div>`;

  document.body.appendChild(wrap);

  const emailEl = wrap.querySelector('#gateEmail');
  const passEl = wrap.querySelector('#gatePass');
  const errEl = wrap.querySelector('#gateErr');
  const goEl = wrap.querySelector('#gateGo');

  let busy = false;
  const submit = async () => {
    if (busy) return;
    const email = emailEl.value.trim();
    const password = passEl.value;
    if (!email || !password) {
      errEl.textContent = 'Enter both your email and password.';
      errEl.hidden = false;
      return;
    }
    busy = true;
    goEl.disabled = true;
    goEl.textContent = 'Signing in…';
    errEl.hidden = true;
    try {
      await signIn(email, password);
      // Reload rather than booting in place: the whole app — backend, read-only
      // state, editor check — is decided during startup, so a clean pass is the
      // only reliable way to enter the authenticated state.
      location.reload();
    } catch (ex) {
      const raw = String((ex && ex.message) || ex);
      // Supabase returns the same message for a bad password and an unknown
      // address, which is correct (it avoids confirming who has an account).
      errEl.textContent = /invalid login/i.test(raw)
        ? 'That email and password combination was not recognised.'
        : raw || 'Sign in failed.';
      errEl.hidden = false;
      busy = false;
      goEl.disabled = false;
      goEl.textContent = 'Sign in';
      passEl.select();
    }
  };

  goEl.addEventListener('click', submit);
  wrap.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  emailEl.focus();
}
