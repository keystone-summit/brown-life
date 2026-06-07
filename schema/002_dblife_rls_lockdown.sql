-- =====================================================================
-- dblife / Brown Life — RLS lockdown (migration 002)
--
-- Goal: defense-in-depth. The Brown Life API talks to Supabase ONLY with
-- the service-role secret key (server-side, in Vercel functions). That key
-- bypasses RLS, so enabling RLS here does NOT break the app — it simply
-- ensures that the `anon` and `authenticated` roles (i.e. anyone who ever
-- got hold of the public anon key + URL) have ZERO access to dblife_* data.
--
-- Scope: ONLY the public.dblife_* tables. This is a SHARED Supabase project
-- (Member Hub lives here too) — we touch nothing else, and we never touch
-- the service_role/postgres roles. This deliberately AVOIDS the broad
-- lockout pattern that bit migration 072.
--
-- Idempotent: safe to re-run.
-- =====================================================================

do $$
declare
  t text;
  tables text[] := array[
    'dblife_events',
    'dblife_tasks',
    'dblife_goals',
    'dblife_goal_subtasks',
    'dblife_supplements',
    'dblife_supplement_log',
    'dblife_chat_messages'
  ];
begin
  foreach t in array tables loop
    if exists (
      select 1 from information_schema.tables
      where table_schema = 'public' and table_name = t
    ) then
      -- 1) Enable RLS. With no policies, anon/authenticated get nothing;
      --    service_role (BYPASSRLS) is unaffected so the API keeps working.
      --    We intentionally do NOT FORCE RLS — that only affects the table
      --    owner and risks the kind of lockout migration 072 caused.
      execute format('alter table public.%I enable row level security;', t);
      -- 2) Belt-and-suspenders: remove any default grants to the public
      --    PostgREST roles so it's a hard permission denial, not just an
      --    empty result set. service_role is NOT revoked.
      execute format('revoke all on public.%I from anon;', t);
      execute format('revoke all on public.%I from authenticated;', t);
      raise notice 'locked down: %', t;
    else
      raise notice 'skip (missing): %', t;
    end if;
  end loop;

  -- Also lock down sequences so anon can't poke at them.
  begin
    execute 'revoke all on all sequences in schema public from anon';
    execute 'revoke all on all sequences in schema public from authenticated';
  exception when others then
    raise notice 'sequence revoke skipped: %', sqlerrm;
  end;
end $$;

-- Verification helper (printed by the apply script):
--   select relname, relrowsecurity, relforcerowsecurity
--   from pg_class where relname like 'dblife_%' and relkind='r';
