-- migrate_v70_ai_copy_v2_sessions.sql
--
-- Persistent sessions and generation ledger for AI Copy v2 (Task 3).
--
-- Requirements:
--   - ai_copy_v2_sessions: stores user/workspace ownership, draft ID,
--     analyze idempotency key, fact card, keyword evidence, last output,
--     validation report, model/prompt versions, last generation idempotency key,
--     generation count, status, expiry, and timestamps.
--   - Add unique analyze idempotency within the owning user. A repeated analyze
--     request returns the original stored result.
--   - A generation ledger supporting A -> B -> retry A and concurrency-safe
--     unique idempotency within the owning session / user.
--   - Enable RLS and add NO permissive client policies. Only the server/service
--     role accesses these tables.
--   - Expiry default 24 hours.
--
-- Conventions: additive + idempotent (CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS).
-- Apply via run_migration.py.

create extension if not exists "uuid-ossp";

-- %% 1. ai_copy_v2_sessions %%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%
create table if not exists ai_copy_v2_sessions (
  id                               uuid        primary key default uuid_generate_v4(),
  vibepin_user_id                  text        not null,
  workspace_id                     text,
  draft_id                         text        not null,
  analyze_idempotency_key          text        not null,
  status                           text        not null default 'active'
    check (status in ('active', 'completed', 'expired')),
  fact_card                        jsonb       not null,
  keyword_evidence                 jsonb       not null,
  last_output                      jsonb,
  validation_report                jsonb,
  model_version                    text        not null,
  prompt_version                   text        not null,
  last_generation_idempotency_key  text,
  generation_count                 integer     not null default 0,
  expires_at                       timestamptz not null default (now() + interval '24 hours'),
  created_at                       timestamptz not null default now(),
  updated_at                       timestamptz not null default now()
);

-- Unique analyze idempotency within the owning user
create unique index if not exists ai_copy_v2_sessions_user_analyze_idempotency
  on ai_copy_v2_sessions (vibepin_user_id, analyze_idempotency_key);

-- Lookup by user and session
create index if not exists ai_copy_v2_sessions_user_session
  on ai_copy_v2_sessions (vibepin_user_id, id);

-- Index for cleanup / expiry sweeping
create index if not exists ai_copy_v2_sessions_expires_at
  on ai_copy_v2_sessions (expires_at);

-- RLS: enabled with zero permissive policies (service-role only)
alter table ai_copy_v2_sessions enable row level security;


-- %% 2. ai_copy_v2_generations (Generation Ledger) %%%%%%%%%%%%%%%%%%%%%%%%%%%%%
-- Stores individual generation executions for a session.
-- Enables:
--   - A -> B -> retry A replay without clobbering history
--   - Concurrency-safe unique idempotency (session_id, idempotency_key)
create table if not exists ai_copy_v2_generations (
  id                 uuid        primary key default uuid_generate_v4(),
  session_id         uuid        not null references ai_copy_v2_sessions(id) on delete cascade,
  vibepin_user_id    text        not null,
  idempotency_key    text        not null,
  angle_id           text,
  output             jsonb       not null,
  validation_report  jsonb       not null,
  created_at         timestamptz not null default now()
);

-- Unique idempotency per session
create unique index if not exists ai_copy_v2_generations_session_idempotency
  on ai_copy_v2_generations (session_id, idempotency_key);

create index if not exists ai_copy_v2_generations_session_created
  on ai_copy_v2_generations (session_id, created_at desc);

-- RLS: enabled with zero permissive policies (service-role only)
alter table ai_copy_v2_generations enable row level security;
