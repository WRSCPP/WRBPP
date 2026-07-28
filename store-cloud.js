// ----------------------------- Supabase (cloud) backend -----------------------------
// Implements the same six-method backend contract as IndexedDB, but against a
// shared Postgres database. Adds two things the local backend can't do:
//   * sign-in (editors) vs anonymous read-only (viewers)
//   * live updates pushed to every open browser
//
// Table shape (see supabase/schema.sql): every store is one table with a text
// primary key `id` and a `doc` JSONB column holding the record. Keeping the
// record shape identical to the local version means zero changes to the app.

import { CONFIG } from './config.js';

const STORES = ['builds', 'lines', 'stages', 'settings', 'audit'];
// The Supabase client library is loaded at runtime from a CDN. We try a couple
// of CDNs so a single outage doesn't take the app down, and report a clear error
// if none can be reached.
const CDNS = [
  'https://esm.sh/@supabase/supabase-js@2',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm',
];

async function loadLib() {
  let lastErr;
  for (const url of CDNS) {
    try {
      const mod = await import(url);
      if (mod && mod.createClient) return mod;
    } catch (e) { lastErr = e; }
  }
  throw new Error('Could not load the Supabase library from any CDN. ' +
    'Check the internet connection or that the CDN is reachable. ' + (lastErr ? lastErr.message : ''));
}

let clientPromise = null;

// Validate config before handing it to the library. createClient() throws
// "Invalid supabaseUrl: Must be a valid HTTP or HTTPS URL" for anything
// malformed, which doesn't say which value is wrong or what it should look like.
function checkConfig(url, key) {
  const example = "Expected: URL: 'https://yourproject.supabase.co'  —  from Supabase → Project Settings → API.";
  if (!url || /^PASTE_/.test(url)) {
    throw new Error(`config.js still has the placeholder Project URL. ${example}`);
  }
  if (!key || /^PASTE_/.test(key)) {
    throw new Error('config.js still has the placeholder anon key. Copy the "anon public" key from Supabase → Project Settings → API.');
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`The Project URL in config.js isn't a valid URL: "${url}". ${example}`);
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    throw new Error(`The Project URL in config.js is missing "https://". ${example}`);
  }
  if (/supabase\.com/.test(parsed.hostname)) {
    throw new Error(`config.js has the dashboard address, not the API endpoint: "${url}". ` +
      'You want the *.supabase.co Project URL from Project Settings → API, not the supabase.com/dashboard link.');
  }
  if (key.split('.').length !== 3) {
    throw new Error('The anon key in config.js doesn\'t look like a key. It should be a long string starting "eyJ" with two dots in it.');
  }
}

export function getClient() {
  if (clientPromise) return clientPromise;
  const { URL: url, ANON_KEY: key } = CONFIG.SUPABASE;
  try {
    checkConfig(url, key);
  } catch (err) {
    return Promise.reject(err);
  }
  clientPromise = loadLib().then(({ createClient }) =>
    createClient(url, key, { auth: { persistSession: true, autoRefreshToken: true } }));
  return clientPromise;
}

export function createCloudBackend({ onRemoteChange } = {}) {
  // Records are cached in memory so reads stay synchronous-fast and the UI keeps
  // its existing render cadence; the cache is refreshed from realtime events.
  const cache = Object.fromEntries(STORES.map((s) => [s, new Map()]));
  let primed = null;

  async function prime() {
    if (primed) return primed;
    primed = (async () => {
      const sb = await getClient();
      await Promise.all(STORES.map(async (store) => {
        const { data, error } = await sb.from(store).select('id, doc');
        if (error) throw error;
        cache[store] = new Map((data || []).map((r) => [r.id, r.doc]));
      }));
      subscribe(sb);
    })();
    return primed;
  }

  function subscribe(sb) {
    // One channel for every table; each event patches the cache and asks the app
    // to re-render, which is how a change on one laptop reaches all the others.
    const channel = sb.channel('traveler-changes');
    for (const store of STORES) {
      channel.on('postgres_changes', { event: '*', schema: 'public', table: store }, (payload) => {
        const row = payload.new || payload.old;
        if (!row) return;
        if (payload.eventType === 'DELETE') cache[store].delete(row.id);
        else cache[store].set(row.id, row.doc);
        onRemoteChange?.(store, payload.eventType, row.id);
      });
    }
    channel.subscribe();
  }

  async function write(store, value) {
    const sb = await getClient();
    const { error } = await sb.from(store).upsert({ id: value.id, doc: value, updated_at: new Date().toISOString() });
    if (error) throw error;
    cache[store].set(value.id, value);
    return value;
  }

  return {
    async get(store, key) { await prime(); return cache[store].get(key) ?? null; },
    async getAll(store) { await prime(); return [...cache[store].values()]; },
    async put(store, value) {
      await prime();
      // Settings is a single record that several people may edit at once. Re-read
      // it and apply only the keys that actually changed, so one person editing
      // crew doesn't wipe another's stage change moments earlier.
      if (store === 'settings') {
        const sb = await getClient();
        const { data: fresh } = await sb.from('settings').select('doc').eq('id', value.id).maybeSingle();
        const remote = fresh?.doc;
        const base = cache.settings.get(value.id);
        if (remote && base) {
          const merged = { ...remote };
          for (const k of Object.keys(value)) {
            const changed = JSON.stringify(value[k]) !== JSON.stringify(base[k]);
            if (changed) merged[k] = value[k];
          }
          return write(store, merged);
        }
      }
      return write(store, value);
    },
    async delete(store, key) {
      await prime();
      const sb = await getClient();
      const { error } = await sb.from(store).delete().eq('id', key);
      if (error) throw error;
      cache[store].delete(key);
    },
    async clear(store) {
      await prime();
      const sb = await getClient();
      const { error } = await sb.from(store).delete().neq('id', '__none__');
      if (error) throw error;
      cache[store].clear();
    },
    async bulkPut(store, values) {
      await prime();
      const sb = await getClient();
      const rows = values.map((v) => ({ id: v.id, doc: v, updated_at: new Date().toISOString() }));
      // Chunked so a large import doesn't exceed request limits.
      for (let i = 0; i < rows.length; i += 500) {
        const { error } = await sb.from(store).upsert(rows.slice(i, i + 500));
        if (error) throw error;
      }
      for (const v of values) cache[store].set(v.id, v);
    },
    isMemory: false,
    isReadOnly: false,
    whenLoaded: () => prime(),
  };
}

// ----------------------------- Auth helpers -----------------------------

export async function getSession() {
  const sb = await getClient();
  const { data } = await sb.auth.getSession();
  return data.session || null;
}

export async function signIn(email, password) {
  const sb = await getClient();
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data.session;
}

export async function signOut() {
  const sb = await getClient();
  await sb.auth.signOut();
}

// Ask the database whether the signed-in user may write. This calls the same
// is_editor() function the RLS policies use, so the UI and the database can
// never disagree about who is an editor. It's SECURITY DEFINER, so it works
// regardless of how restrictive the `editors` table's own read policy is.
export async function isEditor() {
  const sb = await getClient();
  const { data, error } = await sb.rpc('is_editor');
  if (error) throw error;
  return data === true;
}

// Admins are also editors, so this is a strictly narrower check: may this person
// manage accounts and permissions? Same SECURITY DEFINER pattern as is_editor().
export async function isAdmin() {
  const sb = await getClient();
  const { data, error } = await sb.rpc('is_admin');
  if (error) throw error;
  return data === true;
}

export async function onAuthChange(fn) {
  const sb = await getClient();
  sb.auth.onAuthStateChange((_event, session) => fn(session));
}

// ----------------------------- File storage -----------------------------
// Attachments and inspection photos are uploaded to Supabase Storage instead of
// being embedded as base64 inside records, which would bloat the database.

export async function uploadFile(file, pathPrefix = 'attachments') {
  const sb = await getClient();
  const safe = file.name.replace(/[^a-zA-Z0-9._-]+/g, '_');
  const path = `${pathPrefix}/${Date.now()}-${safe}`;
  const { error } = await sb.storage.from('traveler-files').upload(path, file, { upsert: false });
  if (error) throw error;
  const { data } = sb.storage.from('traveler-files').getPublicUrl(path);
  return { name: file.name, size: file.size, type: file.type, path, url: data.publicUrl };
}
