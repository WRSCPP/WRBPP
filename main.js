// ----------------------------- Bootstrap -----------------------------
// Chooses the data backend from config.js, installs it for store.js to pick up,
// then loads the app. Keeping this separate means app.js and store.js stay the
// same files across all three deployments.

import { CONFIG, IS_READONLY } from './config.js';

function fatal(message, detail) {
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;padding:32px;background:#F5F1E8;color:#1F2A33;font-family:system-ui,sans-serif;z-index:9999;text-align:center';
  el.innerHTML = `<div style="max-width:520px">
    <h2 style="margin:0 0 10px;font-size:19px">Traveler couldn't start</h2>
    <p style="margin:0 0 8px;line-height:1.5">${message}</p>
    ${detail ? `<div style="margin:0;font-size:12.5px;color:#4b5563;line-height:1.6;text-align:left;background:#fff;border:1px solid #e5e7eb;border-radius:6px;padding:12px 14px">${detail}</div>` : ''}
  </div>`;
  document.body.appendChild(el);
}

function addBanner(text, tone = 'info') {
  const bar = document.createElement('div');
  bar.className = `mode-banner ${tone}`;
  bar.textContent = text;
  document.body.insertBefore(bar, document.body.firstChild);
}

async function boot() {
  try {
    if (CONFIG.MODE === 'static') {
      const { createStaticBackend } = await import('./store-static.js');
      const backend = createStaticBackend(CONFIG.DATA_URL);
      globalThis.__TRAVELER_BACKEND__ = backend;
      document.body.classList.add('readonly');
      try {
        await backend.whenLoaded();
      } catch (err) {
        const tried = (err && err.tried) || [];
        fatal('The schedule data file is missing.',
          `Traveler looked for <code>data/traveler-data.json</code> next to index.html and couldn't find it.
           <br><br><b>Most likely:</b> the <code>data</code> folder didn't get uploaded with the other files.
           <br>In your repository, check that a folder named <code>data</code> exists containing
           <code>traveler-data.json</code>. Folder and file names are case-sensitive.
           ${tried.length ? `<br><br><span style="font-size:11px;opacity:.75">Tried: ${tried.map((t) => String(t).replace(/</g, '&lt;')).join(' · ')}</span>` : ''}`);
        return;
      }
      addBanner(CONFIG.READONLY_NOTE || 'Read-only view');
    } else if (CONFIG.MODE === 'cloud') {
      const cloud = await import('./store-cloud.js');
      const session = await cloud.getSession().catch(() => null);

      // No session: show the wall and stop. Nothing below runs, so no backend is
      // created and not a single row is requested. This is the whole point —
      // reads are gated in the database too, but the app shouldn't try.
      if (!session) {
        const { showAuthGate } = await import('./auth-gate.js');
        showAuthGate();
        return;
      }

      // Signed in. Now the separate question: may this person write? Everyone in
      // the company has an account, but only those in the editors table can save.
      // Read-only must key off THIS, not off having a session — otherwise the ~20
      // viewers get a fully live interface whose every save is silently rejected.
      let canWrite = false;
      try {
        canWrite = await cloud.isEditor();
      } catch (err) {
        // Can't determine editor status — assume viewer. Failing closed means a
        // viewer sees a correct read-only app; failing open would mean an
        // editable UI that discards every change.
        console.warn('Traveler: could not confirm editor status, treating as viewer.', err);
      }
      globalThis.__TRAVELER_CAN_WRITE__ = canWrite;
      globalThis.__TRAVELER_ACTOR__ = session.user?.email || 'unknown';

      // Admin is a narrower tier than editor: it additionally allows managing
      // accounts and permissions. Only asked when the person can already write,
      // since an admin is by definition an editor.
      let isAdmin = false;
      if (canWrite) {
        try {
          isAdmin = await cloud.isAdmin();
        } catch (err) {
          console.warn('Traveler: could not confirm admin status.', err);
        }
      }
      globalThis.__TRAVELER_IS_ADMIN__ = isAdmin;

      const backend = cloud.createCloudBackend({
        onRemoteChange: () => {
          // Let the app know something changed elsewhere; app.js listens for this.
          window.dispatchEvent(new CustomEvent('traveler:remote-change'));
        },
      });
      globalThis.__TRAVELER_BACKEND__ = backend;
      globalThis.__TRAVELER_CLOUD__ = cloud;
      if (!canWrite) document.body.classList.add('readonly');
      try {
        await backend.whenLoaded();
      } catch (err) {
        const msg = String(err && err.message || err);
        // A stored session that can no longer be refreshed looks like a database
        // failure but isn't. Clear it and send them back to the wall.
        if (/jwt|token|refresh|401|not authenticated|unauthorized/i.test(msg)) {
          await cloud.signOut().catch(() => {});
          const { showAuthGate } = await import('./auth-gate.js');
          showAuthGate({ note: 'Your session expired. Please sign in again.' });
          return;
        }
        fatal('Could not connect to the Traveler database.',
          `<b>What the browser reported:</b><br><code>${msg.replace(/</g, '&lt;')}</code>
           <br><br><b>Most common causes:</b>
           <br>• The database tables haven't been created yet — run <code>supabase/schema.sql</code> in the Supabase SQL Editor.
           <br>• The Project URL or key in <code>config.js</code> has a typo.
           <br>• The Supabase project is paused (free projects pause after ~1 week idle) — open your Supabase dashboard to wake it.`);
        return;
      }
      globalThis.__TRAVELER_MOUNT_AUTH__ = async () => {
        const { mountAuthUI } = await import('./auth-ui.js');
        mountAuthUI(session);
      };

      // The People & Access panel is loaded only for admins, so the module never
      // reaches the ~20 viewers' browsers at all.
      if (isAdmin) {
        globalThis.__TRAVELER_MOUNT_ADMIN__ = async () => {
          const { initAdminPanel } = await import('./admin-ui.js');
          initAdminPanel(session.user?.email || '');
        };
      }
    }
    // 'local' needs no setup — store.js falls through to IndexedDB.

    await import('./app.js?v=' + Date.now());

    // Lock the UI down once the app has rendered its first pass.
    if (document.body.classList.contains('readonly')) {
      const { enableReadOnly } = await import('./readonly.js');
      setTimeout(enableReadOnly, 300);
    }

    // Mount sign-in. The container lives in index.html so it always exists, and
    // app.js only ever renders into #headerStats — it never touches #authBox —
    // so one mount is enough. readonly.js re-enables auth controls on every
    // sweep, so the read-only pass can't lock the button out either.
    // Both of these are supplementary UI. A failure in either must not take the
    // whole application down — a broken admin panel should cost you the admin
    // panel, not the schedule. Report it loudly in the console instead.
    if (globalThis.__TRAVELER_MOUNT_AUTH__) {
      try {
        await globalThis.__TRAVELER_MOUNT_AUTH__();
      } catch (err) {
        console.error('Production Planner: the sign-in menu failed to load.', err);
      }
    }

    if (globalThis.__TRAVELER_MOUNT_ADMIN__) {
      try {
        await globalThis.__TRAVELER_MOUNT_ADMIN__();
      } catch (err) {
        console.error('Production Planner: the People & Access panel failed to load. ' +
          'The rest of the app is unaffected — check that admin-ui.js and admin-users.js ' +
          'are both deployed and complete.', err);
      }
    }
  } catch (err) {
    fatal('Something went wrong while starting up.', String(err && err.message || err));
    console.error(err);
  }
}

if (IS_READONLY) document.documentElement.classList.add('readonly-boot');
boot();
