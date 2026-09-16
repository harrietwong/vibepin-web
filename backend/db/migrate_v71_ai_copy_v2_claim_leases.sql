-- Additive upgrade for databases where the earlier v70 shape already exists.
create extension if not exists "uuid-ossp";

alter table ai_copy_v2_sessions add column if not exists claim_token uuid;
alter table ai_copy_v2_sessions add column if not exists claim_expires_at timestamptz;
update ai_copy_v2_sessions set claim_token = uuid_generate_v4() where claim_token is null;
update ai_copy_v2_sessions set claim_expires_at = now() where claim_expires_at is null;
alter table ai_copy_v2_sessions alter column claim_token set default uuid_generate_v4();
alter table ai_copy_v2_sessions alter column claim_token set not null;
alter table ai_copy_v2_sessions alter column claim_expires_at set default (now() + interval '2 minutes');
alter table ai_copy_v2_sessions alter column claim_expires_at set not null;
alter table ai_copy_v2_sessions alter column fact_card drop not null;
alter table ai_copy_v2_sessions alter column keyword_evidence drop not null;
update ai_copy_v2_sessions set status = 'completed' where status = 'active';
alter table ai_copy_v2_sessions alter column status set default 'pending';
alter table ai_copy_v2_sessions drop constraint if exists ai_copy_v2_sessions_status_check;
alter table ai_copy_v2_sessions add constraint ai_copy_v2_sessions_status_check
  check (status in ('pending', 'completed', 'expired')) not valid;
alter table ai_copy_v2_sessions validate constraint ai_copy_v2_sessions_status_check;

alter table ai_copy_v2_generations add column if not exists status text;
alter table ai_copy_v2_generations add column if not exists claim_token uuid;
alter table ai_copy_v2_generations add column if not exists claim_expires_at timestamptz;
alter table ai_copy_v2_generations add column if not exists updated_at timestamptz;
update ai_copy_v2_generations set status = case when output is null then 'pending' else 'completed' end where status is null;
update ai_copy_v2_generations set claim_token = uuid_generate_v4() where claim_token is null;
update ai_copy_v2_generations set claim_expires_at = now() where claim_expires_at is null;
update ai_copy_v2_generations set updated_at = created_at where updated_at is null;
alter table ai_copy_v2_generations alter column status set default 'pending';
alter table ai_copy_v2_generations alter column status set not null;
alter table ai_copy_v2_generations alter column claim_token set default uuid_generate_v4();
alter table ai_copy_v2_generations alter column claim_token set not null;
alter table ai_copy_v2_generations alter column claim_expires_at set default (now() + interval '2 minutes');
alter table ai_copy_v2_generations alter column claim_expires_at set not null;
alter table ai_copy_v2_generations alter column updated_at set default now();
alter table ai_copy_v2_generations alter column updated_at set not null;
alter table ai_copy_v2_generations alter column output drop not null;
alter table ai_copy_v2_generations alter column validation_report drop not null;
alter table ai_copy_v2_generations drop constraint if exists ai_copy_v2_generations_status_check;
alter table ai_copy_v2_generations add constraint ai_copy_v2_generations_status_check
  check (status in ('pending', 'completed')) not valid;
alter table ai_copy_v2_generations validate constraint ai_copy_v2_generations_status_check;
create unique index if not exists ai_copy_v2_generations_owner_idempotency
  on ai_copy_v2_generations (session_id, vibepin_user_id, idempotency_key);

drop function if exists complete_ai_copy_v2_generation(uuid, uuid, text, jsonb, jsonb);
drop function if exists complete_ai_copy_v2_generation(uuid, uuid, text, uuid, jsonb, jsonb);
create function complete_ai_copy_v2_generation(
  p_generation_id uuid,
  p_session_id uuid,
  p_user_id text,
  p_claim_token uuid,
  p_output jsonb,
  p_validation_report jsonb
)
returns setof ai_copy_v2_generations
language plpgsql
security definer
set search_path = public
as $$
declare v_generation ai_copy_v2_generations;
begin
  select * into v_generation from ai_copy_v2_generations
  where id = p_generation_id and session_id = p_session_id
    and vibepin_user_id = p_user_id and claim_token = p_claim_token
  for update;
  if not found or v_generation.status <> 'pending' then return; end if;

  perform 1 from ai_copy_v2_sessions
  where id = p_session_id and vibepin_user_id = p_user_id
    and status = 'completed' and expires_at > now()
  for update;
  if not found then return; end if;

  update ai_copy_v2_generations
  set status = 'completed', output = p_output,
      validation_report = p_validation_report, updated_at = now()
  where id = p_generation_id and claim_token = p_claim_token
  returning * into v_generation;

  update ai_copy_v2_sessions
  set last_output = p_output, validation_report = p_validation_report,
      last_generation_idempotency_key = v_generation.idempotency_key,
      generation_count = generation_count + 1, updated_at = now()
  where id = p_session_id and vibepin_user_id = p_user_id;
  return next v_generation;
end;
$$;

alter table ai_copy_v2_sessions enable row level security;
alter table ai_copy_v2_generations enable row level security;
revoke all on function complete_ai_copy_v2_generation(uuid, uuid, text, uuid, jsonb, jsonb) from public;
revoke all on function complete_ai_copy_v2_generation(uuid, uuid, text, uuid, jsonb, jsonb) from anon;
revoke all on function complete_ai_copy_v2_generation(uuid, uuid, text, uuid, jsonb, jsonb) from authenticated;
grant execute on function complete_ai_copy_v2_generation(uuid, uuid, text, uuid, jsonb, jsonb) to service_role;
