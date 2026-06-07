-- =====================================================================
-- dblife / Brown Life — user PIN store (migration 005)
--
-- Moves the per-user login PIN out of Vercel env vars and into the DB so
-- users (D / K) can change their own PIN from inside the app. One row per
-- user, keyed by the same opaque id used everywhere else ('john' / 'lisa').
--
--   pin_hash : scrypt$<saltHex>$<hashHex>  (never plaintext)
--
-- The API (service-role) is the only writer. RLS stays enabled + anon-
-- revoked, same lockdown posture as migrations 002/003.
--
-- Bootstrap: rows are seeded lazily from the env-var hashes on each user's
-- first successful login after deploy (insert-if-missing, never overwrites
-- a user-chosen PIN). Until a row exists the API falls back to the env hash,
-- so if this table is unreachable the original PINs keep working.
-- Idempotent.
-- =====================================================================

create table if not exists dblife_auth_users (
  id          text primary key,        -- 'john' / 'lisa'
  name        text,                    -- display name at seed time (D / K)
  pin_hash    text not null,           -- scrypt$<saltHex>$<hashHex>
  updated_at  timestamptz default now()
);

-- Lock it down (same posture as migration 002/003).
alter table public.dblife_auth_users enable row level security;
revoke all on public.dblife_auth_users from anon;
revoke all on public.dblife_auth_users from authenticated;
