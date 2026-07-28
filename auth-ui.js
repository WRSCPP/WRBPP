// ----------------------------- Auth UI (cloud mode) -----------------------------
// Viewers use Traveler signed out and read-only. Editors sign in, which removes
// the read-only class and re-enables the editing controls.

import { signIn, signOut, onAuthChange } from './store-cloud.js';

// Module-level, so repeat calls to mountAuthUI are safe. ES modules are cached,
// so every `import('./auth-ui.js')` shares this state. Without this guard, a
// second mount adds a second click listener to the same #authBox node, and one
// click on "Sign in to edit" opens two stacked dialogs with duplicate element
// IDs — which looks exactly like a broken sign-in.
let mounted = false;
let rerender = null;

export function mountAuthUI(session) {
  if (mounted) { rerender?.(session); return; }

  // Use the permanent container that lives in index.html. It always exists, so
  // the button can't fail to appear due to render timing.
  let wrap = document.getElementById('authBox') || document.querySelector('.auth-box');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.className = 'auth-box';
    wrap.id = 'authBox';
    (document.querySelector('.header-actions') || document.body).appendChild(wrap);
  }

  const render = (s) => {
    wrap.innerHTML = s
      ? `<span class="auth-who" title="${s.user.email}">${s.user.email.split('@')[0]}</span>
         <button class="btn sm" data-auth="out">Sign out</button>`
      : `<button class="btn sm primary" data-auth="in">Sign in to edit</button>`;
  };
  render(session);
  rerender = render;
  mounted = true;

  wrap.addEventListener('click', async (e) => {
    if (e.target.closest('[data-auth="out"]')) {
      await signOut();
      location.reload();
      return;
    }
    if (e.target.closest('[data-auth="in"]')) openDialog();
  });

  onAuthChange((s) => {
    render(s);
    document.body.classList.toggle('readonly', !s);
  });

  function openDialog() {
    const ov = document.createElement('div');
    ov.className = 'overlay auth-overlay';
    ov.innerHTML = `<div class="modal auth-modal">
      <div class="modal-head"><h2>Sign in</h2><button class="icon-btn" data-auth-close>✕</button></div>
      <div class="modal-body">
        <label class="field"><span>Email</span><input type="email" id="authEmail" autocomplete="username"></label>
        <label class="field"><span>Password</span><input type="password" id="authPass" autocomplete="current-password"></label>
        <div class="auth-err" id="authErr" hidden></div>
      </div>
      <div class="modal-foot">
        <button class="btn" data-auth-close>Cancel</button>
        <button class="btn primary" id="authGo">Sign in</button>
      </div>
    </div>`;
    document.body.appendChild(ov);
    const close = () => ov.remove();
    ov.addEventListener('click', (e) => {
      if (e.target === ov || e.target.closest('[data-auth-close]')) close();
    });
    const submit = async () => {
      const err = ov.querySelector('#authErr');
      err.hidden = true;
      try {
        await signIn(ov.querySelector('#authEmail').value.trim(), ov.querySelector('#authPass').value);
        location.reload();
      } catch (ex) {
        err.textContent = ex.message || 'Sign in failed.';
        err.hidden = false;
      }
    };
    ov.querySelector('#authGo').addEventListener('click', submit);
    ov.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    ov.querySelector('#authEmail').focus();
  }
}
