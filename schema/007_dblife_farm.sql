-- =====================================================================
-- dblife / Brown Life — The Farm (migration 007)
--
-- One row per user; only 'john' is ever served (api/farm.js).
--   content  the plan text/numbers the page renders. Seeded OUT OF BAND,
--            never committed — this repo is PUBLIC.
--   state    his live edits: doc link, listings watch list, 90-day checks.
--   watch    the Monday land-watch feed ({weekOf, parcels}).
--
-- Same posture as 002/003: RLS on with no policies, anon/authenticated
-- revoked, service role (the API) unaffected. No FORCE RLS (cf. 072).
-- Shared Supabase project — touches only this table. Idempotent.
-- =====================================================================

create table if not exists public.dblife_farm (
  user_id           text primary key,
  content           jsonb not null default '{}'::jsonb,
  state             jsonb not null default '{"doc":"","listings":[],"checks":{}}'::jsonb,
  watch             jsonb not null default '{"weekOf":"","parcels":[]}'::jsonb,
  watch_updated_at  timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

alter table public.dblife_farm enable row level security;
revoke all on public.dblife_farm from anon;
revoke all on public.dblife_farm from authenticated;
