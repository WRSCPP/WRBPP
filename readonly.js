// ----------------------------- Read-only enforcement -----------------------------
// The CSS hides editing affordances; this belt-and-braces pass also disables any
// input the app re-renders, so a viewer can't type into a field that will never
// save. Controls that are purely about *looking* at data stay enabled.

// Things a viewer is still allowed to touch. The auth box is critical: a viewer
// must be able to click "Sign in to edit" even though everything else is locked.
const ALLOWED = [
  '#searchInput', '#lineFilter',
  '.hours-filters input', '.hours-filters select',
  '[data-print-size]', '[data-print]',
  '.tab', '.modal-tab',
  '#exportBuildHours', '#exportBtn',
  '.auth-box', '[data-auth]', '.auth-overlay', '.auth-modal',
].join(',');

// Input types where readOnly does nothing and disabled is the only option.
const NEEDS_DISABLE = new Set([
  'range', 'checkbox', 'radio', 'color', 'file', 'button', 'submit', 'reset', 'image',
]);

function lockField(el) {
  // The sign-in button and its dialog must NEVER be locked — it's the only way a
  // viewer becomes an editor. Skip anything inside the auth UI, always.
  if (el.closest('.auth-box, .auth-overlay, .auth-modal') || el.matches('[data-auth]')) return;
  if (el.matches(ALLOWED) || el.closest(ALLOWED)) return;
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
    // The readOnly property is only honoured on text-like inputs. Range,
    // checkbox, radio, colour and file IGNORE it completely — a read-only range
    // stays fully draggable. Those have to be disabled instead. Without this, a
    // viewer can drag the stage-progress slider, the save is rejected by RLS,
    // and the value silently snaps back on the next render.
    if (NEEDS_DISABLE.has(el.type)) { el.disabled = true; el.tabIndex = -1; }
    else { el.readOnly = true; el.tabIndex = -1; }
  } else if (el.tagName === 'SELECT' || el.tagName === 'BUTTON') {
    el.disabled = true;
  }
  el.setAttribute('data-locked', '');
}

function sweep(root = document) {
  root.querySelectorAll('input,textarea,select,button').forEach(lockField);
  // Nothing is draggable in read-only mode.
  root.querySelectorAll('[draggable="true"]').forEach((el) => el.setAttribute('draggable', 'false'));
  // Belt and braces: the sign-in button and its modal must always be usable, even
  // if an earlier pass locked them before they were recognised as auth controls.
  document.querySelectorAll('.auth-box button, .auth-box input, [data-auth], .auth-overlay button, .auth-overlay input')
    .forEach((el) => { el.disabled = false; el.readOnly = false; el.removeAttribute('data-locked'); el.tabIndex = 0; });
}

// The stylesheet hides the Settings tab for read-only sessions, but an access
// decision must not depend on a stylesheet loading. A stale or blocked
// styles.css would leave it visible, so remove it from the layout directly.
function hideEditorOnlyChrome() {
  document.querySelectorAll('.tab[data-tab="settings"]').forEach((tab) => {
    tab.style.setProperty('display', 'none', 'important');
    tab.setAttribute('aria-hidden', 'true');
    // If a viewer is already sitting on Settings, move them to the Dashboard
    // rather than leaving them on a view they shouldn't have reached.
    if (tab.classList.contains('active')) {
      document.querySelector('.tab[data-tab="dashboard"]')?.click();
    }
  });
}

export function enableReadOnly() {
  const run = () => { sweep(document); hideEditorOnlyChrome(); };
  run();
  // The app re-renders constantly; re-apply after every DOM change.
  const mo = new MutationObserver((records) => {
    for (const r of records) {
      for (const node of r.addedNodes) {
        if (node.nodeType === 1) sweep(node.parentNode || document);
      }
    }
  });
  mo.observe(document.body, { childList: true, subtree: true });

  // Block edit-intent clicks that slip past (e.g. handlers bound to containers).
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (t.closest(ALLOWED)) return;
    if (t.closest('[data-del-line],[data-del-stage],[data-del-opt],[data-del-crew],[data-crew-remove],[data-insp],[data-attach-remove],[data-insp-photo-remove],#newBuildBtn,.add-row,.rm')) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);
}
