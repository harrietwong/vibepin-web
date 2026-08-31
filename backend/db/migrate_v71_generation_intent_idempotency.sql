-- v71: Stable generation intent idempotency across client/API/queue/worker.
-- Additive and legacy-safe. Apply only through an exact-ref, exact-SHA guarded
-- migration runner against an explicitly authorized non-production project.
-- Lookup fields contain digests only; raw request material never enters keys/logs.

begin;

alter table generation_jobs add column if not exists generation_intent_key text;
alter table generation_jobs add column if not exists generation_intent_fingerprint text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'generation_jobs_intent_pair_valid'
       and conrelid = 'public.generation_jobs'::regclass
  ) then
    alter table generation_jobs add constraint generation_jobs_intent_pair_valid check (
      (generation_intent_key is null and generation_intent_fingerprint is null)
      or (generation_intent_key ~ '^[0-9a-f]{48}$'
          and generation_intent_fingerprint ~ '^[0-9a-f]{64}$')
    );
  end if;
end $$;

-- IF NOT EXISTS must never bless a same-named but weaker pre-existing index.
-- Validate the exact catalog shape before the CREATE statements below.
do $$
declare
  v_columns text[];
  v_predicate text;
  v_unique boolean;
begin
  if to_regclass('public.generation_jobs_user_intent_unique') is not null then
    select array_agg(a.attname order by k.ord),
           lower(regexp_replace(pg_get_expr(i.indpred, i.indrelid), '\s+', ' ', 'g')),
           i.indisunique
      into v_columns, v_predicate, v_unique
      from pg_index i
      cross join lateral unnest(i.indkey) with ordinality as k(attnum, ord)
      join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
     where i.indexrelid = 'public.generation_jobs_user_intent_unique'::regclass
       and k.ord <= i.indnkeyatts
     group by i.indpred, i.indrelid, i.indisunique;
    if v_columns is distinct from array['vibepin_user_id','generation_intent_key']::text[]
       or v_predicate is distinct from '(generation_intent_key is not null)'
       or v_unique is not true then
      raise exception 'generation_jobs_user_intent_unique has an incompatible definition'
        using errcode = '55000';
    end if;
  end if;
  if to_regclass('public.generation_jobs_intent_lookup') is not null then
    select array_agg(a.attname order by k.ord),
           lower(regexp_replace(pg_get_expr(i.indpred, i.indrelid), '\s+', ' ', 'g')),
           i.indisunique
      into v_columns, v_predicate, v_unique
      from pg_index i
      cross join lateral unnest(i.indkey) with ordinality as k(attnum, ord)
      join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
     where i.indexrelid = 'public.generation_jobs_intent_lookup'::regclass
       and k.ord <= i.indnkeyatts
     group by i.indpred, i.indrelid, i.indisunique;
    if v_columns is distinct from array['vibepin_user_id','generation_intent_key','status']::text[]
       or v_predicate is distinct from '(generation_intent_key is not null)'
       or v_unique is not false then
      raise exception 'generation_jobs_intent_lookup has an incompatible definition'
        using errcode = '55000';
    end if;
  end if;
end $$;

create unique index if not exists generation_jobs_user_intent_unique
  on generation_jobs (vibepin_user_id, generation_intent_key)
  where generation_intent_key is not null;
create index if not exists generation_jobs_intent_lookup
  on generation_jobs (vibepin_user_id, generation_intent_key, status)
  where generation_intent_key is not null;

create or replace function generation_jobs_intent_immutable()
returns trigger language plpgsql set search_path = public, pg_temp as $fn$
begin
  if old.vibepin_user_id is distinct from new.vibepin_user_id
     or old.generation_intent_key is distinct from new.generation_intent_key
     or old.generation_intent_fingerprint is distinct from new.generation_intent_fingerprint then
    raise exception 'generation job intent is immutable' using errcode = '23514';
  end if;
  return new;
end;
$fn$;
drop trigger if exists generation_jobs_intent_immutable_trigger on generation_jobs;
create trigger generation_jobs_intent_immutable_trigger before update on generation_jobs
for each row execute function generation_jobs_intent_immutable();

create or replace function generation_lookup_job_by_intent(
  p_user_id uuid, p_intent_key text, p_intent_fingerprint text
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $fn$
declare v_job generation_jobs%rowtype;
begin
  if p_intent_key !~ '^[0-9a-f]{48}$' or p_intent_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid generation intent digest' using errcode = '22023';
  end if;
  select * into v_job from generation_jobs
   where vibepin_user_id = p_user_id and generation_intent_key = p_intent_key;
  if not found then return jsonb_build_object('found', false); end if;
  if v_job.generation_intent_fingerprint is distinct from p_intent_fingerprint then
    raise exception 'generation intent conflict' using errcode = '23505';
  end if;
  return jsonb_build_object(
    'found', true, 'replayed', true, 'job_id', v_job.id,
    'job_status', v_job.status, 'job_results', v_job.results,
    'reservation_id', v_job.usage_reservation_id
  );
end;
$fn$;

create or replace function generation_enqueue_job_idempotent(
  p_user_id uuid, p_intent_key text, p_intent_fingerprint text,
  p_slot_keys text[], p_params jsonb, p_force_error boolean default false
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $fn$
declare v_job generation_jobs%rowtype; v_job_id uuid; v_results jsonb;
begin
  if p_intent_key !~ '^[0-9a-f]{48}$'
     or p_intent_fingerprint !~ '^[0-9a-f]{64}$'
     or coalesce(array_length(p_slot_keys, 1), 0) = 0 then
    raise exception 'invalid generation intent enqueue input' using errcode = '22023';
  end if;
  v_results := (select coalesce(jsonb_agg(jsonb_build_object(
    'slot', ordinality - 1, 'status', 'pending', 'imageUrl', null, 'error', null
  ) order by ordinality), '[]'::jsonb) from unnest(p_slot_keys) with ordinality);
  insert into generation_jobs (
    vibepin_user_id, generation_intent_key, generation_intent_fingerprint,
    status, params, results
  ) values (p_user_id, p_intent_key, p_intent_fingerprint,
    'queued', coalesce(p_params, '{}'::jsonb), v_results)
  on conflict (vibepin_user_id, generation_intent_key)
    where generation_intent_key is not null do nothing returning id into v_job_id;
  if p_force_error and v_job_id is not null then
    raise exception 'generation_enqueue_job_idempotent: injected precommit failure' using errcode = 'P0001';
  end if;
  select * into v_job from generation_jobs
   where vibepin_user_id = p_user_id and generation_intent_key = p_intent_key;
  if not found then raise exception 'generation intent winner missing' using errcode = 'P0002'; end if;
  if v_job.generation_intent_fingerprint is distinct from p_intent_fingerprint then
    raise exception 'generation intent conflict' using errcode = '23505';
  end if;
  return jsonb_build_object(
    'ok', true, 'replayed', v_job_id is null, 'job_id', v_job.id,
    'job_status', v_job.status, 'job_results', v_job.results,
    'reservation_id', v_job.usage_reservation_id
  );
end;
$fn$;

create or replace function usage_reserve_generation_job_v2(
  p_user_id uuid, p_slot_keys text[], p_request_key text,
  p_intent_key text, p_intent_fingerprint text, p_params jsonb,
  p_operation text default 'image_generation', p_reference_id text default null,
  p_expires_at timestamptz default null, p_metadata jsonb default '{}'::jsonb,
  p_force_error boolean default false
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $fn$
declare
  v_reserve jsonb; v_res_id uuid; v_job_id uuid;
  v_job generation_jobs%rowtype; v_results jsonb;
begin
  if p_request_key is distinct from p_intent_key
     or p_intent_key !~ '^[0-9a-f]{48}$'
     or p_intent_fingerprint !~ '^[0-9a-f]{64}$'
     or coalesce(array_length(p_slot_keys, 1), 0) = 0 then
    raise exception 'invalid generation intent reserve input' using errcode = '22023';
  end if;
  select * into v_job from generation_jobs
   where vibepin_user_id = p_user_id and generation_intent_key = p_intent_key;
  if found then
    if v_job.generation_intent_fingerprint is distinct from p_intent_fingerprint then
      raise exception 'generation intent conflict' using errcode = '23505';
    end if;
    return jsonb_build_object(
      'ok', true, 'replayed', true, 'reservation_id', v_job.usage_reservation_id,
      'job_id', v_job.id, 'job_status', v_job.status, 'job_results', v_job.results,
      'requested_quantity', jsonb_array_length(v_job.results)
    );
  end if;
  begin
    v_reserve := usage_reserve(
      p_user_id => p_user_id, p_usage_type => 'ai_image', p_slot_keys => p_slot_keys,
      p_request_key => p_request_key, p_operation => p_operation,
      p_reference_id => p_reference_id, p_expires_at => p_expires_at,
      p_metadata => p_metadata || jsonb_build_object('generationIntentFingerprint', p_intent_fingerprint)
    );
    if not (v_reserve ->> 'ok')::boolean then
      return v_reserve || jsonb_build_object('job_id', null);
    end if;
    v_res_id := (v_reserve ->> 'reservation_id')::uuid;
    if coalesce((v_reserve ->> 'replayed')::boolean, false) then
      select * into v_job from generation_jobs where usage_reservation_id = v_res_id;
      if not found or v_job.generation_intent_key is distinct from p_intent_key
         or v_job.generation_intent_fingerprint is distinct from p_intent_fingerprint then
        raise exception 'reservation replay does not match immutable generation intent' using errcode = '23505';
      end if;
      return v_reserve || jsonb_build_object(
        'job_id', v_job.id, 'job_status', v_job.status,
        'job_results', v_job.results, 'replayed', true
      );
    end if;
    v_results := (select coalesce(jsonb_agg(jsonb_build_object(
      'slot', ordinality - 1, 'status', 'pending', 'imageUrl', null, 'error', null
    ) order by ordinality), '[]'::jsonb) from unnest(p_slot_keys) with ordinality);
    insert into generation_jobs (
      vibepin_user_id, generation_intent_key, generation_intent_fingerprint,
      status, params, results, usage_reservation_id
    ) values (p_user_id, p_intent_key, p_intent_fingerprint,
      'queued', coalesce(p_params, '{}'::jsonb), v_results, v_res_id)
    returning id into v_job_id;
    update usage_reservations set generation_job_id = v_job_id, updated_at = now()
     where id = v_res_id;
    if p_force_error then
      raise exception 'usage_reserve_generation_job_v2: injected precommit failure' using errcode = 'P0001';
    end if;
    return v_reserve || jsonb_build_object(
      'job_id', v_job_id, 'job_status', 'queued',
      'job_results', v_results, 'replayed', false
    );
  exception when unique_violation then
    select * into v_job from generation_jobs
     where vibepin_user_id = p_user_id and generation_intent_key = p_intent_key;
    if not found or v_job.generation_intent_fingerprint is distinct from p_intent_fingerprint then raise; end if;
    return jsonb_build_object(
      'ok', true, 'replayed', true, 'reservation_id', v_job.usage_reservation_id,
      'job_id', v_job.id, 'job_status', v_job.status, 'job_results', v_job.results,
      'requested_quantity', jsonb_array_length(v_job.results)
    );
  end;
end;
$fn$;

revoke all on function generation_lookup_job_by_intent(uuid, text, text) from public, anon, authenticated;
revoke all on function generation_enqueue_job_idempotent(uuid, text, text, text[], jsonb, boolean) from public, anon, authenticated;
revoke all on function usage_reserve_generation_job_v2(uuid, text[], text, text, text, jsonb, text, text, timestamptz, jsonb, boolean) from public, anon, authenticated;
grant execute on function generation_lookup_job_by_intent(uuid, text, text) to service_role;
grant execute on function generation_enqueue_job_idempotent(uuid, text, text, text[], jsonb, boolean) to service_role;
grant execute on function usage_reserve_generation_job_v2(uuid, text[], text, text, text, jsonb, text, text, timestamptz, jsonb, boolean) to service_role;

notify pgrst, 'reload schema';

commit;
