-- =====================================================================
-- dblife — Phase 1 schema
-- Personal dashboard for John (separate from OS / Griffin).
-- All tables prefixed dblife_ so this can coexist in any Supabase project.
-- Apply via Supabase SQL editor OR apply_migration.py.
-- =====================================================================

create table if not exists dblife_events (
  id            bigserial primary key,
  title         text not null,
  description   text,
  start_at      timestamptz not null,
  end_at        timestamptz,
  all_day       boolean default false,
  color         text default '#d4a44c',
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

create index if not exists dblife_events_start_idx on dblife_events (start_at);

create table if not exists dblife_tasks (
  id            bigserial primary key,
  title         text not null,
  notes         text,
  status        text not null default 'todo',   -- todo / doing / done
  priority      text default 'medium',          -- low / medium / high
  due_date      date,
  tags          text[] default '{}',
  position      int default 0,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now(),
  completed_at  timestamptz
);

create index if not exists dblife_tasks_status_idx on dblife_tasks (status);

create table if not exists dblife_goals (
  id            bigserial primary key,
  title         text not null,
  description   text,
  progress      int default 0,                  -- 0..100
  target_date   date,
  archived      boolean default false,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

create table if not exists dblife_goal_subtasks (
  id            bigserial primary key,
  goal_id       bigint not null references dblife_goals(id) on delete cascade,
  title         text not null,
  done          boolean default false,
  position      int default 0,
  created_at    timestamptz default now()
);

create index if not exists dblife_goal_subtasks_goal_idx on dblife_goal_subtasks (goal_id);

create table if not exists dblife_supplements (
  id              bigserial primary key,
  name            text not null,
  dose            text,
  frequency       text,                          -- "every morning", "twice daily", etc.
  brand           text,
  refill_date     date,
  notes           text,
  active          boolean default true,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

create table if not exists dblife_supplement_log (
  id              bigserial primary key,
  supplement_id   bigint not null references dblife_supplements(id) on delete cascade,
  taken_at        timestamptz not null default now(),
  created_at      timestamptz default now()
);

create index if not exists dblife_supp_log_sid_idx on dblife_supplement_log (supplement_id, taken_at);

create table if not exists dblife_chat_messages (
  id              bigserial primary key,
  session_id      text not null,
  role            text not null,                 -- user / assistant
  content         text not null,
  created_at      timestamptz default now()
);

create index if not exists dblife_chat_session_idx on dblife_chat_messages (session_id, created_at);
