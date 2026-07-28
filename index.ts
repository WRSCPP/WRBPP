// ============================================================================
// Traveler — admin-users Edge Function
//
// The ONLY place the service_role key is ever used. That key bypasses RLS
// entirely, so it lives here as a function secret and never reaches a browser.
//
// Every request is verified twice:
//   1. The caller's JWT must resolve to a real user.
//   2. That user must have role = 'admin' in the editors table.
//
// Deploy:
//   supabase functions deploy admin-users
//
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically.
// Optionally set ALLOWED_ORIGIN to your site to restrict CORS:
//   supabase secrets set ALLOWED_ORIGIN=https://yourname.github.io
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const ALLOWED_ORIGIN = Deno.env.get('ALLOWED_ORIGIN') || '*';

// Projects on the newer key format (sb_publishable_ / sb_secret_) may not have
// SUPABASE_SERVICE_ROLE_KEY populated. Supabase reserves the SUPABASE_ prefix and
// refuses secrets that use it, so the key has to be supplied under another name:
//
//   supabase secrets set SERVICE_KEY=sb_secret_...
//
// SERVICE_KEY is checked first; the auto-injected legacy variable is the fallback
// so this keeps working on older projects with no extra configuration.
const SERVICE_ROLE =
  Deno.env.get('SERVICE_KEY') ||
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ||
  '';

const MIN_PASSWORD = 8;

const corsHeaders = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function validEmail(v: unknown): v is string {
  return typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim());
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return json(405, { error: 'Use POST.' });
  }

  // Without a service key every admin call fails, and the symptom is a confusing
  // 401 about the caller's session rather than a message about configuration.
  // Say what's actually wrong.
  if (!SERVICE_ROLE) {
    return json(500, {
      error: 'This function has no service key. Set one and redeploy:  ' +
             'supabase secrets set SERVICE_KEY=<your secret key from ' +
             'Project Settings → API → Secret keys>  then  ' +
             'supabase functions deploy admin-users',
    });
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // --- 1. Identify the caller -----------------------------------------------
  const header = req.headers.get('Authorization') || '';
  const jwt = header.replace(/^Bearer\s+/i, '').trim();
  if (!jwt) return json(401, { error: 'Not signed in.' });

  const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
  const caller = userData?.user;
  if (userErr || !caller) return json(401, { error: 'Your session is not valid. Sign in again.' });

  // --- 2. Confirm the caller is an admin ------------------------------------
  // Read with the service role so this check can't be defeated by RLS changes.
  const { data: callerRow, error: roleErr } = await admin
    .from('editors')
    .select('role')
    .eq('user_id', caller.id)
    .maybeSingle();

  if (roleErr) return json(500, { error: `Could not verify permissions: ${roleErr.message}` });
  if (callerRow?.role !== 'admin') {
    return json(403, { error: 'Admin access is required for this action.' });
  }

  // --- 3. Perform the action ------------------------------------------------
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: 'Malformed request body.' });
  }

  const action = String(body.action || '');

  try {
    if (action === 'create') {
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      const role = String(body.role || 'viewer');

      if (!validEmail(email)) return json(400, { error: 'That email address is not valid.' });
      if (password.length < MIN_PASSWORD) {
        return json(400, { error: `Password must be at least ${MIN_PASSWORD} characters.` });
      }
      if (!['viewer', 'editor', 'admin'].includes(role)) {
        return json(400, { error: 'Unknown role.' });
      }

      // email_confirm: true is the equivalent of the dashboard's "Auto Confirm
      // User" checkbox. Without it the account exists but cannot sign in.
      const { data: created, error: createErr } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      });
      if (createErr) return json(400, { error: createErr.message });

      if (role !== 'viewer' && created.user) {
        const { error: grantErr } = await admin
          .from('editors')
          .insert({ user_id: created.user.id, email: created.user.email, role });
        if (grantErr) {
          // The account exists but the permission row failed. Say so plainly
          // rather than reporting success — the tier can be fixed in the panel.
          return json(207, {
            warning: `Account created, but the ${role} permission could not be set: ${grantErr.message}`,
            user: { id: created.user.id, email: created.user.email, role: 'viewer' },
          });
        }
      }

      return json(200, {
        user: { id: created.user?.id, email: created.user?.email, role },
      });
    }

    if (action === 'password') {
      const userId = String(body.userId || '');
      const password = String(body.password || '');
      if (!userId) return json(400, { error: 'Missing user.' });
      if (password.length < MIN_PASSWORD) {
        return json(400, { error: `Password must be at least ${MIN_PASSWORD} characters.` });
      }

      const { error } = await admin.auth.admin.updateUserById(userId, { password });
      if (error) return json(400, { error: error.message });
      return json(200, { ok: true });
    }

    if (action === 'delete') {
      const userId = String(body.userId || '');
      if (!userId) return json(400, { error: 'Missing user.' });

      // Deleting yourself would strand the panel and could remove the last
      // admin. Refuse; another admin can do it if it's genuinely intended.
      if (userId === caller.id) {
        return json(400, { error: 'You cannot delete your own account from here.' });
      }

      // The editors row goes automatically via the ON DELETE CASCADE foreign
      // key from the migration, so there is nothing to clean up first.
      const { error } = await admin.auth.admin.deleteUser(userId);
      if (error) return json(400, { error: error.message });
      return json(200, { ok: true });
    }

    return json(400, { error: `Unknown action: ${action}` });
  } catch (err) {
    return json(500, { error: String((err as Error)?.message || err) });
  }
});
