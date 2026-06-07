-- =====================================================================
-- dblife / Brown Life — login rate-limit store (migration 003)
--
-- Backs the PIN brute-force lockout. A DB table (not in-memory) so the
-- limit holds across serverless cold starts and multiple Vercel instances.
-- Written only by the service-role API; RLS-locked against anon like every
-- other dblife_* table.
-- =====================================================================

create table if not exists dblife_auth_attempts (
  ip            text primary key,
  fails         int not null default 0,
  window_start  timestamptz not null default now(),
  locked_until  timestamptz,
  updated_at    timestamptz default now()
);

-- Lock it down (same posture as migration 002).
alter table public.dblife_auth_attempts enable row level security;
revoke all on public.dblife_auth_attempts from anon;
revoke all on public.dblife_auth_attempts from authenticated;
