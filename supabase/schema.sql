-- ============================================================================
-- Traveler / Production Planner — Supabase schema
-- Run this once in Supabase → SQL Editor → New query → Run.
--
-- v2 — updated to match the live database as of 2026-07-30, after the
-- three-tier (viewer / editor / admin) security model was built. This file
-- was previously stale: it described a public-read, no-admin version of the
-- database that no longer matched what was actually deployed. If you ever
-- need to stand up a fresh Supabase project for this app, THIS file — not
-- any earlier copy — is the one that reproduces the current, correct state.
--
-- Design: each store is one table with a text primary key and a JSONB `doc`
-- column holding the record exactly as the app already shapes it. That keeps
-- the app code identical to the local version while giving us a real
-- database, live updates, and per-user permissions.
-- ============================================================================

create table if not exists builds   (id text primary key, doc jsonb not null, updated_at timestamptz default now());
create table if not exists lines    (id text primary key, doc jsonb not null, updated_at timestamptz default now());
create table if not exists stages   (id text primary key, doc jsonb not null, updated_at timestamptz default now());
create table if not exists settings (id text primary key, doc jsonb not null, updated_at timestamptz default now());
create table if not exists audit    (id text primary key, doc jsonb not null, updated_at timestamptz default now());

-- Who is allowed to edit, and at what tier. Add a row here for each editor
-- after creating their user in Supabase → Authentication → Users.
--   role = 'editor' -> can write to the data tables (builds/lines/stages/settings)
--   role = 'admin'  -> everything an editor can do, PLUS manage accounts and
--                      permissions via the People & Access panel (admin-ui.js)
create table if not exists editors (
  user_id  uuid primary key references auth.users(id) on delete cascade,
  email    text,
  role     text not null default 'editor' check (role in ('editor','admin')),
  added_at timestamptz default now()
);

create or replace function is_editor() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from editors where user_id = auth.uid());
$$;

create or replace function is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from editors where user_id = auth.uid() and role = 'admin');
$$;

-- Returns the roster for the People & Access panel. security definer so an
-- admin can see everyone, not just rows RLS would otherwise let them read.
create or replace function list_people() returns table (
  user_id uuid, email text, role text, added_at timestamptz
)
language sql stable security definer set search_path = public as $$
  select user_id, email, role, added_at from editors
  where (select is_admin());
$$;

-- ---------------------------------------------------------------------------
-- Row Level Security: any AUTHENTICATED user may READ (that's the ~25
-- viewers, all of whom now have accounts), only listed editors may WRITE.
-- Unauthenticated (anon) requests are rejected outright — this is what the
-- sign-in wall in auth-gate.js is actually enforcing at the database level.
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['builds','lines','stages','settings','audit'] loop
    execute format('alter table %I enable row level security', t);

    execute format('drop policy if exists "read all" on %I', t);
    execute format('create policy "read all" on %I for select to authenticated using (true)', t);

    execute format('drop policy if exists "editors insert" on %I', t);
    execute format('create policy "editors insert" on %I for insert with check (is_editor())', t);

    execute format('drop policy if exists "editors update" on %I', t);
    execute format('create policy "editors update" on %I for update using (is_editor()) with check (is_editor())', t);

    execute format('drop policy if exists "editors delete" on %I', t);
    execute format('create policy "editors delete" on %I for delete using (is_editor())', t);
  end loop;
end $$;

alter table editors enable row level security;
drop policy if exists "read editors" on editors;
create policy "read editors" on editors for select to authenticated using (true);

-- ---------------------------------------------------------------------------
-- Live updates: publish these tables to the realtime stream so every open
-- browser sees changes as they happen.
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['builds','lines','stages','settings','audit'] loop
    begin
      execute format('alter publication supabase_realtime add table %I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- File storage for attachments and inspection photos.
--
-- The bucket is PRIVATE (public: false). Files are never reached by direct
-- URL — every access goes through signed-urls.js, which mints a short-lived
-- signed link on demand. The policies below are what actually gate that:
-- only a signed-in (authenticated) user can read, and only editors can
-- upload or delete. This corrects an earlier version of this file where
-- these policies had no role restriction at all.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('traveler-files', 'traveler-files', false)
on conflict (id) do update set public = false;

drop policy if exists "files readable" on storage.objects;
create policy "files readable" on storage.objects
  for select to authenticated using (bucket_id = 'traveler-files');

drop policy if exists "editors upload files" on storage.objects;
create policy "editors upload files" on storage.objects
  for insert with check (bucket_id = 'traveler-files' and is_editor());

drop policy if exists "editors delete files" on storage.objects;
create policy "editors delete files" on storage.objects
  for delete using (bucket_id = 'traveler-files' and is_editor());

-- ---------------------------------------------------------------------------
-- AFTER RUNNING THIS ON A FRESH PROJECT:
--   1. Authentication → Users → Add user, for each person who needs an
--      account (viewers included — reads now require authentication).
--   2. Copy each new user's UUID and run, once per person:
--        insert into editors (user_id, email, role)
--        values ('<uuid>', '<email>', 'editor');   -- or 'admin'
--      Note: EVERY signed-in user can read the data tables regardless of
--      whether they have an `editors` row. The `editors` table controls
--      WRITE access and admin-panel access only, not read access.
--   3. Settings → API → copy the Project URL and the anon public key into
--      config.js, and set MODE to 'cloud'.
--   4. Deploy the admin-users Edge Function if account creation/reset from
--      the People & Access panel is needed (see admin-users.js header).
-- ---------------------------------------------------------------------------
