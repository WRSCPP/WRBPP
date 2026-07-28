// ----------------------------- Admin user management (client) -----------------------------
// Two different transports, deliberately:
//
//   Role changes  -> written straight to the editors table. RLS enforces that
//                    only admins can do it, so no server code is involved and
//                    this keeps working even if the Edge Function isn't deployed.
//
//   Accounts      -> the admin-users Edge Function. Creating, deleting, and
//                    resetting passwords need the service_role key, which must
//                    never exist in a browser.
//
// The panel degrades gracefully: if the function isn't deployed, viewing people
// and changing tiers still work, and only account actions are unavailable.

import { getClient } from './store-cloud.js';
import { CONFIG } from './config.js';

const FN_URL = () => `${String(CONFIG.SUPABASE.URL).replace(/\/+$/, '')}/functions/v1/admin-users`;

async function callFunction(action, payload = {}) {
  const sb = await getClient();
  const { data } = await sb.auth.getSession();
  const token = data?.session?.access_token;
  if (!token) throw new Error('Your session has expired. Sign in again.');

  let res;
  try {
    res = await fetch(FN_URL(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action, ...payload }),
    });
  } catch {
    // Network-level failure: almost always "not deployed" or a CORS rejection.
    const err = new Error('Could not reach the user-management service. It may not be deployed yet.');
    err.notDeployed = true;
    throw err;
  }

  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { error: text }; }

  if (res.status === 404) {
    const err = new Error('The user-management service is not deployed. See the deploy notes.');
    err.notDeployed = true;
    throw err;
  }
  if (!res.ok && res.status !== 207) {
    throw new Error(body.error || `Request failed (${res.status}).`);
  }
  return body;
}

/** True when the Edge Function answers. Used to decide what the panel offers. */
export async function serviceAvailable() {
  try {
    // 'ping' is an unknown action, so a reachable function replies 400 — which
    // still proves it's deployed and that we passed the admin check.
    await callFunction('ping');
    return true;
  } catch (err) {
    return !err.notDeployed;
  }
}

/** Everyone with an account, plus their tier. Admin-only, enforced in SQL. */
export async function listPeople() {
  const sb = await getClient();
  const { data, error } = await sb.rpc('list_people');
  if (error) throw error;
  return (data || []).map((r) => ({
    userId: r.user_id,
    email: r.email,
    role: r.role,
    confirmed: r.confirmed,
    lastSignInAt: r.last_sign_in_at,
    createdAt: r.created_at,
  }));
}

/**
 * Set someone's tier. 'viewer' means no editors row at all, so this deletes it;
 * the other two insert or update. Not an upsert, because that would require a
 * unique constraint on user_id that the original schema may not have declared.
 */
export async function setRole(userId, email, role) {
  const sb = await getClient();
  if (!['viewer', 'editor', 'admin'].includes(role)) throw new Error('Unknown role.');

  if (role === 'viewer') {
    const { error } = await sb.from('editors').delete().eq('user_id', userId);
    if (error) throw new Error(friendly(error));
    return;
  }

  const { data: existing, error: readErr } = await sb
    .from('editors').select('user_id').eq('user_id', userId).maybeSingle();
  if (readErr) throw new Error(friendly(readErr));

  const { error } = existing
    ? await sb.from('editors').update({ role, email }).eq('user_id', userId)
    : await sb.from('editors').insert({ user_id: userId, email, role });
  if (error) throw new Error(friendly(error));
}

// The database raises a readable message from the last-admin trigger; surface it
// rather than a generic Postgres error string.
function friendly(error) {
  const msg = error.message || String(error);
  if (/At least one admin must remain/i.test(msg)) {
    return 'At least one admin must remain. Promote someone else first.';
  }
  if (/row-level security|permission denied/i.test(msg)) {
    return 'You do not have permission to change roles.';
  }
  return msg;
}

export async function createAccount({ email, password, role = 'viewer' }) {
  return callFunction('create', { email, password, role });
}

export async function setPassword(userId, password) {
  return callFunction('password', { userId, password });
}

export async function deleteAccount(userId) {
  return callFunction('delete', { userId });
}
