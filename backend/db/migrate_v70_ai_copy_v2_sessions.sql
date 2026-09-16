-- AI Copy v2 durable idempotency state.
-- Pending rows are claimed before any billable work. Generation completion and
-- the owning session summary are updated in one database transaction.

create extension if not exists "uuid-ossp";

create table if not exists ai_copy_v2_sessions (
  id uuid primary key default uuid_generate_v4(),
  vibepin_user_id text not null,
  workspace_id text not null,
  draft_id text not null,
  analyze_idempotency_key text not null,
  status text not null default 'pending'
    check (status in ('pending', 'completed', 'expired')),
  fact_card jsonb,
  keyword_evidence jsonb,
  last_output jsonb,
  validation_report jsonb,
  model_version text not null,
  prompt_version text not null,
  last_generation_idempotency_key text,
  generation_count integer not null default 0,
  expires_at timestamptz not null default (now() + interval '24 hours'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (vibepin_user_id, analyze_idempotency_key)
);

create index if not exists ai_copy_v2_sessions_owner_lookup
  on ai_copy_v2_sessions (id, vibepin_user_id, status, expires_at);
create index if not exists ai_copy_v2_sessions_expires_at
  on ai_copy_v2_sessions (expires_at);
alter table ai_copy_v2_sessions enable row level security;

create table if not exists ai_copy_v2_generations (
  id uuid primary key default uuid_generate_v4(),
  session_id uuid not null references ai_copy_v2_sessions(id) on delete cascade,
  vibepin_user_id text not null,
  idempotency_key text not null,
  status text not null default 'pending'
    check (status in ('pending', 'completed')),
  angle_id text,
  output jsonb,
  validation_report jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (session_id, vibepin_user_id, idempotency_key)
);

create index if not exists ai_copy_v2_generations_owner_lookup
  on ai_copy_v2_generations (session_id, vibepin_user_id, idempotency_key, status);
alter table ai_copy_v2_generations enable row level security;

create or replace function complete_ai_copy_v2_generation(
  p_generation_id uuid,
  p_session_id uuid,
  p_user_id text,
  p_output jsonb,
  p_validation_report jsonb
)
returns setof ai_copy_v2_generations
language plpgsql
security definer
set search_path = public
as $$
declare
  v_generation ai_copy_v2_generations;
begin
  select * into v_generation
  from ai_copy_v2_generations
  where id = p_generation_id
    and session_id = p_session_id
    and vibepin_user_id = p_user_id
  for update;

  if not found or v_generation.status <> 'pending' then
    return;
  end if;

  perform 1 from ai_copy_v2_sessions
  where id = p_session_id
    and vibepin_user_id = p_user_id
    and status = 'completed'
    and expires_at > now()
  for update;

  if not found then
    return;
  end if;

  update ai_copy_v2_generations
  set status = 'completed', output = p_output,
      validation_report = p_validation_report, updated_at = now()
  where id = p_generation_id
  returning * into v_generation;

  update ai_copy_v2_sessions
  set last_output = p_output,
      validation_report = p_validation_report,
      last_generation_idempotency_key = v_generation.idempotency_key,
      generation_count = generation_count + 1,
      updated_at = now()
  where id = p_session_id and vibepin_user_id = p_user_id;

  return next v_generation;
end;
$$;

revoke all on function complete_ai_copy_v2_generation(uuid, uuid, text, jsonb, jsonb) from public;
grant execute on function complete_ai_copy_v2_generation(uuid, uuid, text, jsonb, jsonb) to service_role;
