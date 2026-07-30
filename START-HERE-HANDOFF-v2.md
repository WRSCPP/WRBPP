# Traveler / Production Planner — START HERE (v2)
*Last updated: 2026-07-30. Supersedes the original START-HERE-HANDOFF.md.*

**Why this file exists:** the conversation where the security layer below was
built was on a different Claude account and has since been deleted. This
document reconstructs the current state from the actual code and a live
Supabase diagnostic, so no future session has to start blind. Read this
first, before touching anything.

---

## 1. What this project is

A production-planning tool ("Traveler," now branded **Production Planner —
Wind River Built**) for a home-manufacturing company. One codebase, three
modes selected in `config.js`:

| Mode | What it is | Who it's for |
|---|---|---|
| `local` | Original browser-storage version | Aaron's desktop copy |
| `static` | Read-only published snapshot, no login | View-only sharing |
| `cloud` | Full shared app — Supabase backend, live updates, real accounts | The whole team (~25 viewers, 2–5 editors, 1+ admin) |

**Current live mode: `cloud`.** This is the version in active use.

## 2. Current architecture (as of this handoff)

**Three access tiers**, enforced at both the UI and the database:

- **Viewer** — has an account, can sign in, can see everything, cannot save.
- **Editor** — everything a viewer can do, plus create/edit/delete builds,
  lines, stages, settings.
- **Admin** — everything an editor can do, plus the People & Access panel:
  view the roster, change roles, create/delete accounts, reset passwords.

**Startup flow (`main.js`):** no session → sign-in wall (`auth-gate.js`)
renders and *nothing else loads* — no backend created, no query sent, no
skeleton of the app visible. Session present → app checks `is_editor()` and
`is_admin()`, sets `readonly` accordingly, mounts the app, then mounts the
sign-in menu (`auth-ui.js`) and, for admins only, the admin panel.

**Key files:**
- `main.js` — bootstrap, mode selection, the auth gate/session logic above
- `auth-gate.js` — full-screen sign-in wall shown when there's no session
- `auth-ui.js` — the small "signed in as…" menu shown once authenticated
- `store-cloud.js` — Supabase client, `getSession`, `signIn`, `isEditor`, `isAdmin`, `signedUrls`
- `admin-ui.js` / `admin-users.js` — People & Access panel (admin-only)
- `signed-urls.js` — mints short-lived signed URLs for private-bucket files
- `readonly.js` — locks the UI when the signed-in user isn't an editor
- `supabase/schema.sql` — **just corrected** to match live reality (see §4)

## 3. What changed since the original handoff

The original bug — "Sign in to edit" button not appearing on the live
site — is **resolved**. Root cause was never actually the DOM/mount logic;
the fix that landed was a module-level `mounted` guard in `auth-ui.js`
preventing a double-mount (which was itself causing duplicate stacked
dialogs that looked like a broken sign-in), plus moving the `readonly`
decision to startup-time `is_editor()` rather than session-presence — the
earlier version was unlocking the UI for any signed-in user, editor or not,
while `readonly.js` kept their controls disabled: buttons that looked live
but did nothing.

On top of that fix, a full security/account layer was added that wasn't
present in the original handoff:
- Real email/password accounts for every user (not just editors)
- A sign-in wall that blocks all data loading until authenticated
- Three-tier roles (viewer/editor/admin) backed by an `editors.role` column
- An admin panel for managing accounts and roles
- Private file storage with signed URLs instead of public bucket links

## 4. Security audit performed this session — RESOLVED

When this session started, `supabase/schema.sql` in the repo was byte-identical
to the pre-security-layer version — meaning the checked-in file no longer
described the live database. A live diagnostic (via SQL queries run in the
Supabase dashboard) found:

| Component | Status found | Verdict |
|---|---|---|
| RLS on 5 data tables (builds/lines/stages/settings/editors) | `read all` scoped to `authenticated` | ✅ Correct |
| `editors.role` column | Present | ✅ Correct |
| `is_editor()`, `is_admin()`, `list_people()` functions | All exist | ✅ Correct |
| `traveler-files` bucket | `public: false` | ✅ Correct |
| **Storage policies on `traveler-files`** | **Scoped to `public` role, no auth check** | ❌ **Gap — fixed this session** |

**The one real gap:** the storage bucket was marked private (blocking direct
public URLs), but the RLS policies gating the Storage *API* itself had no
role restriction — `public` in Postgres covers both `anon` and
`authenticated`. In practice this meant anyone holding the published anon
key (which every browser running the app has, by design) could read, and
attempt to write/delete, files in the bucket via the API — completely
bypassing the sign-in wall. **This has been fixed** — storage policies now
require `authenticated` for reads and `is_editor()` for writes/deletes,
matching the data tables.

**`supabase/schema.sql` has been rewritten** (this handoff includes the
corrected version) so the checked-in file now reproduces the actual live
state — role column, all three functions, corrected storage policies. If a
fresh Supabase project is ever stood up for this app, this is the file to run.

## 5. Items resolved after initial audit

- **`admin-users` Edge Function — confirmed deployed and reviewed.**
  `index.ts` in the repo root IS this function's source (Deno). It's the
  only place the `service_role` key exists, and it's well-built:
  - Every request re-verifies the caller's JWT, then independently checks
    `role = 'admin'` in `editors` **using the service role**, not the
    caller's own RLS-filtered view — so the admin gate can't be defeated
    by any client-side RLS assumption.
  - Handles three actions: `create` (new account, optional role grant),
    `password` (reset), `delete` (with a guard against self-deletion so an
    admin can't strand the panel).
  - Account creation correctly skips the `editors` insert for `role:
    'viewer'` — consistent with the schema, since viewers don't need an
    `editors` row to read (that's gated by `authenticated` alone).
  - Minor housekeeping note (not a bug): `index.ts` sits in the repo root
    alongside the client-side JS. If organizing the repo later, the
    conventional Supabase layout is `supabase/functions/admin-users/index.ts`.
- **This document should be treated as the new source of truth** over any
  earlier handoff file or deleted conversation. If future work contradicts
  something here, trust the live code/database over memory.

## 6. Lessons reinforced this session

- **Inspect before editing, extended to infrastructure.** The same
  discipline that applies to DOM/CSS now applies to the database: don't
  patch code against an assumed schema — pull the live RLS policies,
  functions, and table structure first. Two of the "fixes" that would have
  been made from schema.sql alone (assuming public bucket, assuming no role
  column) would have been wrong or redundant, because the live database had
  already moved past the checked-in file.
- **A stale schema.sql is itself a risk**, independent of whether the live
  database is currently correct — it's a landmine for the next fresh deploy
  or the next person who trusts the repo over the dashboard.
- **Chat history is not the source of truth; files and the live system
  are.** Losing a conversation (even one with real, unrecorded reasoning in
  it) is recoverable by diffing code and inspecting the live system directly
  — slower, but not fatal, as long as the actual artifacts are preserved.

---

## For the next session (human or Claude)

1. Read this file first.
2. Treat `supabase/schema.sql` in this handoff package as canonical going
   forward — replace the copy in the repo with it.
3. Keep this file (and the current code zip) in this Claude **Project's
   knowledge**, not only inside a single chat, so it survives regardless of
   which conversation or account is used next.
4. Optional housekeeping: consider relocating `index.ts` to the conventional
   `supabase/functions/admin-users/index.ts` path for repo clarity (§5).
