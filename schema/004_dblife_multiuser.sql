-- =====================================================================
-- dblife / Brown Life — per-user data isolation (migration 004)
--
-- Adds user_id to every personal table so User 1 (john) and User 2 (lisa)
-- have fully separate tasks/goals/supplements/events/chat. Existing rows
-- backfill to 'john' (the original single user keeps all current data).
--
-- The API (service-role) filters every read/write by the signed-in user's id.
-- RLS stays enabled + anon-revoked from migrations 002/003; this only adds a
-- column, so the lockdown posture is unchanged.
-- Idempotent.
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
    if exists (select 1 from information_schema.tables
               where table_schema='public' and table_name=t) then
      execute format(
        'alter table public.%I add column if not exists user_id text not null default ''john'';', t);
      execute format(
        'create index if not exists %I on public.%I (user_id);', t || '_user_idx', t);
      raise notice 'user_id added: %', t;
    else
      raise notice 'skip (missing): %', t;
    end if;
  end loop;
end $$;
