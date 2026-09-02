-- v73: atomic, lineage-bound retries for durable publish intents.
-- Additive on v72. No existing publish evidence is rewritten or deleted.

begin;

alter table publish_intents add column if not exists prior_intent_id uuid;
alter table publish_intent_destinations add column if not exists retry_of_destination_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'publish_intents_prior_intent_fk'
       and conrelid = 'public.publish_intents'::regclass
       and contype = 'f'
  ) then
    alter table publish_intents add constraint publish_intents_prior_intent_fk
      foreign key (prior_intent_id) references publish_intents(id) on delete restrict;
  end if;
  if not exists (
    select 1 from pg_constraint
     where conname = 'publish_intent_destinations_retry_source_fk'
       and conrelid = 'public.publish_intent_destinations'::regclass
       and contype = 'f'
  ) then
    alter table publish_intent_destinations add constraint publish_intent_destinations_retry_source_fk
      foreign key (retry_of_destination_id) references publish_intent_destinations(id) on delete restrict;
  end if;
end $$;

create index if not exists publish_intents_prior_intent_idx
  on publish_intents(prior_intent_id) where prior_intent_id is not null;
create unique index if not exists publish_intent_destinations_retry_source_unique
  on publish_intent_destinations(retry_of_destination_id)
  where retry_of_destination_id is not null;

-- Upgrade the v72 first-attempt function in the same additive migration. Some
-- Supabase projects install uuid-ossp only in `extensions`, outside the
-- SECURITY DEFINER search_path. Re-applying v72 is not a deployment guarantee,
-- so v73 must own the compatible definition used by normal first publishes.
create or replace function publish_intent_claim_destination(
  p_user_id uuid,
  p_intent_id text,
  p_fingerprint text,
  p_draft_id text,
  p_content_id text,
  p_confirmed_at timestamptz,
  p_mode jsonb,
  p_receipt jsonb,
  p_destination_id text,
  p_provider text,
  p_connection_id text,
  p_subdestination_id text default null
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $v72_compat$
declare
  v_intent publish_intents%rowtype;
  v_destination publish_intent_destinations%rowtype;
  v_claim_token uuid := gen_random_uuid();
  v_inserted boolean := false;
begin
  if p_intent_id !~ '^publish:.{1,240}$'
     or p_fingerprint !~ '^[0-9a-f]{64}$'
     or nullif(btrim(p_draft_id), '') is null
     or nullif(btrim(p_content_id), '') is null
     or nullif(btrim(p_destination_id), '') is null
     or p_provider not in ('pinterest','instagram','facebook')
     or nullif(btrim(p_connection_id), '') is null
     or p_mode ->> 'kind' <> 'now' then
    raise exception 'invalid publish intent claim input' using errcode = '22023';
  end if;

  insert into publish_intents(
    user_id, intent_id, fingerprint, draft_id, content_id,
    confirmed_at, mode, receipt
  ) values (
    p_user_id, p_intent_id, p_fingerprint, p_draft_id, p_content_id,
    p_confirmed_at, p_mode, p_receipt
  ) on conflict (user_id, intent_id) do nothing;

  select * into v_intent from publish_intents
   where user_id = p_user_id and intent_id = p_intent_id for update;
  if not found then raise exception 'publish intent winner missing' using errcode = 'P0002'; end if;
  if v_intent.fingerprint is distinct from p_fingerprint
     or v_intent.draft_id is distinct from p_draft_id
     or v_intent.content_id is distinct from p_content_id
     or v_intent.confirmed_at is distinct from p_confirmed_at
     or v_intent.mode is distinct from p_mode
     or (v_intent.receipt - 'confirmedAt') is distinct from (p_receipt - 'confirmedAt') then
    raise exception 'publish intent conflict' using errcode = '23505';
  end if;

  insert into publish_intent_destinations(
    publish_intent_id, destination_id, provider, social_connection_id,
    subdestination_id, status, claim_token
  ) values (
    v_intent.id, p_destination_id, p_provider, p_connection_id,
    nullif(btrim(p_subdestination_id), ''), 'claimed', v_claim_token
  ) on conflict (publish_intent_id, destination_id) do nothing
    returning * into v_destination;
  v_inserted := found;

  if not v_inserted then
    select * into v_destination from publish_intent_destinations
     where publish_intent_id = v_intent.id and destination_id = p_destination_id
     for update;
    if v_destination.provider is distinct from p_provider
       or v_destination.social_connection_id is distinct from p_connection_id
       or v_destination.subdestination_id is distinct from nullif(btrim(p_subdestination_id), '') then
      raise exception 'publish destination intent conflict' using errcode = '23505';
    end if;
    if v_destination.status = 'failed' and v_destination.retry_allowed then
      update publish_intent_destinations set
        status = 'claimed', claim_token = v_claim_token,
        attempt = attempt + 1, retry_allowed = false,
        provider_job_id = null, remote_id = null, remote_url = null,
        provider_status = null, evidence = '{}'::jsonb,
        claimed_at = now(), finished_at = null, updated_at = now()
       where id = v_destination.id returning * into v_destination;
      v_inserted := true;
    end if;
  end if;

  return jsonb_build_object(
    'claimed', v_inserted,
    'replayed', not v_inserted,
    'intentJobId', v_intent.id,
    'destinationJobId', v_destination.id,
    'claimToken', case when v_inserted then v_destination.claim_token else null end,
    'status', v_destination.status,
    'attempt', v_destination.attempt,
    'retryAllowed', v_destination.retry_allowed,
    'providerJobId', v_destination.provider_job_id,
    'remoteId', v_destination.remote_id,
    'remoteUrl', v_destination.remote_url,
    'providerStatus', v_destination.provider_status,
    'evidence', v_destination.evidence
  );
end;
$v72_compat$;

-- v72 allowed a known failure to move back to `claimed` under the same intent.
-- Once lineage exists that path would bypass the atomic parent-consumption rule,
-- especially during a rolling Preview deployment where an older route can still
-- be serving. Fail that legacy transition closed; v73 retries INSERT a child row.
create or replace function publish_intent_reject_legacy_retry()
returns trigger language plpgsql set search_path = public, pg_temp as $guard$
begin
  if tg_op = 'UPDATE' and old.status = 'failed' and new.status = 'claimed' then
    raise exception using errcode = 'P0001', message = 'retry_not_allowed';
  end if;
  if tg_op = 'INSERT'
     and new.retry_of_destination_id is null
     and exists (
       select 1
         from publish_intents current_intent
         join publish_intents prior_intent
           on prior_intent.user_id = current_intent.user_id
          and prior_intent.draft_id = current_intent.draft_id
          and prior_intent.content_id = current_intent.content_id
          and prior_intent.id <> current_intent.id
         join publish_intent_destinations prior_destination
           on prior_destination.publish_intent_id = prior_intent.id
          and prior_destination.destination_id = new.destination_id
        where current_intent.id = new.publish_intent_id
          and coalesce((current_intent.receipt ->> 'onlyPending')::boolean, false)
          and prior_destination.status = 'failed'
          and prior_destination.retry_allowed
     ) then
    raise exception using errcode = 'P0001', message = 'retry_not_allowed';
  end if;
  return new;
end;
$guard$;

drop trigger if exists publish_intent_reject_legacy_retry_trigger on publish_intent_destinations;
create trigger publish_intent_reject_legacy_retry_trigger
before insert or update on publish_intent_destinations
for each row execute function publish_intent_reject_legacy_retry();

create or replace function publish_intent_reserve_retry_destinations(
  p_user_id uuid,
  p_prior_intent_id text,
  p_intent_id text,
  p_fingerprint text,
  p_draft_id text,
  p_content_id text,
  p_confirmed_at timestamptz,
  p_mode jsonb,
  p_receipt jsonb,
  p_destinations jsonb
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $fn$
declare
  v_parent publish_intents%rowtype;
  v_child publish_intents%rowtype;
  v_parent_destination publish_intent_destinations%rowtype;
  v_child_destination publish_intent_destinations%rowtype;
  v_item jsonb;
  v_items jsonb[] := array[]::jsonb[];
  v_parent_destination_ids uuid[] := array[]::uuid[];
  v_parent_attempts integer[] := array[]::integer[];
  v_parent_was_unactivated boolean[] := array[]::boolean[];
  v_existing boolean[] := array[]::boolean[];
  v_seen text[] := array[]::text[];
  v_destination_id text;
  v_provider text;
  v_connection_id text;
  v_board_id text;
  v_index integer;
  v_inserted boolean;
  v_unactivated boolean;
  v_any_existing boolean := false;
  v_any_missing boolean := false;
  v_result jsonb := '[]'::jsonb;
begin
  if p_intent_id !~ '^publish:.{1,240}$'
     or p_prior_intent_id !~ '^publish:.{1,240}$'
     or p_intent_id = p_prior_intent_id
     or p_fingerprint !~ '^[0-9a-f]{64}$'
     or nullif(btrim(p_draft_id), '') is null
     or nullif(btrim(p_content_id), '') is null
     or p_mode ->> 'kind' <> 'now'
     or p_receipt ->> 'intentId' is distinct from p_intent_id
     or p_receipt ->> 'priorIntentId' is distinct from p_prior_intent_id
     or p_receipt ->> 'fingerprint' is distinct from p_fingerprint
     or jsonb_typeof(p_receipt -> 'dispatchDestinationIds') <> 'array'
     or jsonb_typeof(p_destinations) <> 'array'
     or jsonb_array_length(p_destinations) = 0 then
    raise exception using errcode = 'P0001', message = 'retry_not_allowed';
  end if;

  select * into v_parent
    from publish_intents
   where user_id = p_user_id and intent_id = p_prior_intent_id
   for update;
  if not found
     or v_parent.draft_id is distinct from p_draft_id
     or v_parent.content_id is distinct from p_content_id then
    raise exception using errcode = 'P0001', message = 'retry_not_allowed';
  end if;

  insert into publish_intents(
    user_id, intent_id, fingerprint, draft_id, content_id,
    confirmed_at, mode, receipt, prior_intent_id
  ) values (
    p_user_id, p_intent_id, p_fingerprint, p_draft_id, p_content_id,
    p_confirmed_at, p_mode, p_receipt, v_parent.id
  ) on conflict (user_id, intent_id) do nothing;

  select * into v_child
    from publish_intents
   where user_id = p_user_id and intent_id = p_intent_id
   for update;
  if not found
     or v_child.prior_intent_id is distinct from v_parent.id
     or v_child.fingerprint is distinct from p_fingerprint
     or v_child.draft_id is distinct from p_draft_id
     or v_child.content_id is distinct from p_content_id
     or v_child.confirmed_at is distinct from p_confirmed_at
     or v_child.mode is distinct from p_mode
     or (v_child.receipt - 'confirmedAt') is distinct from (p_receipt - 'confirmedAt') then
    raise exception using errcode = 'P0001', message = 'retry_not_allowed';
  end if;

  -- Validate and lock the whole source set before consuming any row. Stable
  -- ordering prevents two overlapping retry batches from deadlocking.
  for v_item in
    select value from jsonb_array_elements(p_destinations)
    order by value ->> 'id'
  loop
    v_destination_id := btrim(coalesce(v_item ->> 'id', ''));
    v_provider := btrim(coalesce(v_item ->> 'provider', ''));
    v_connection_id := btrim(coalesce(v_item ->> 'socialConnectionId', ''));
    v_board_id := nullif(btrim(coalesce(v_item ->> 'boardId', '')), '');
    if v_destination_id = ''
       or v_destination_id = any(v_seen)
       or v_provider not in ('pinterest','instagram','facebook')
       or v_connection_id = ''
       or not (p_receipt -> 'dispatchDestinationIds' @> jsonb_build_array(v_destination_id)) then
      raise exception using errcode = 'P0001', message = 'retry_not_allowed';
    end if;
    v_seen := array_append(v_seen, v_destination_id);

    select * into v_parent_destination
      from publish_intent_destinations
     where publish_intent_id = v_parent.id and destination_id = v_destination_id
     for update;
    if not found
       or v_parent_destination.provider is distinct from v_provider
       or v_parent_destination.social_connection_id is distinct from v_connection_id
       or v_parent_destination.subdestination_id is distinct from v_board_id then
      raise exception using errcode = 'P0001', message = 'retry_not_allowed';
    end if;

    select * into v_child_destination
      from publish_intent_destinations
     where publish_intent_id = v_child.id and destination_id = v_destination_id
     for update;
    v_unactivated := v_parent_destination.status = 'claimed'
      and v_parent_destination.claim_token is null
      and v_parent_destination.retry_of_destination_id is not null;
    if found then
      if v_child_destination.retry_of_destination_id is distinct from v_parent_destination.id
         or v_child_destination.provider is distinct from v_provider
         or v_child_destination.social_connection_id is distinct from v_connection_id
         or v_child_destination.subdestination_id is distinct from v_board_id then
        raise exception using errcode = 'P0001', message = 'retry_not_allowed';
      end if;
      v_existing := array_append(v_existing, true);
      v_any_existing := true;
    else
      if not (
        (v_parent_destination.status = 'failed' and v_parent_destination.retry_allowed)
        or v_unactivated
      ) then
        raise exception using errcode = 'P0001', message = 'retry_not_allowed';
      end if;
      v_existing := array_append(v_existing, false);
      v_any_missing := true;
    end if;
    v_items := array_append(v_items, v_item);
    v_parent_destination_ids := array_append(v_parent_destination_ids, v_parent_destination.id);
    v_parent_attempts := array_append(v_parent_attempts, v_parent_destination.attempt);
    v_parent_was_unactivated := array_append(v_parent_was_unactivated, v_unactivated);
  end loop;

  -- The database, not only the TypeScript helper, enforces that reservation
  -- covers the complete signed action. Activation below may take a platform
  -- subset, but parent retry entitlement is always consumed all-or-none.
  if jsonb_array_length(p_receipt -> 'dispatchDestinationIds') <> coalesce(array_length(v_seen, 1), 0)
     or exists (
       select 1
         from jsonb_array_elements_text(p_receipt -> 'dispatchDestinationIds') as dispatch_id(value)
        group by value
       having count(*) > 1
     )
     or exists (
       select 1
         from jsonb_array_elements_text(p_receipt -> 'dispatchDestinationIds') as dispatch_id(value)
        where not (value = any(v_seen))
     ) then
    raise exception using errcode = 'P0001', message = 'retry_not_allowed';
  end if;

  -- A committed reservation is all-or-none. A mixed replay means the durable
  -- action was corrupted or written outside this RPC; never fill in its gaps.
  if v_any_existing and v_any_missing then
    raise exception using errcode = 'P0001', message = 'retry_not_allowed';
  end if;

  if array_length(v_items, 1) is not null then
    for v_index in 1..array_length(v_items, 1)
    loop
    v_item := v_items[v_index];
    v_destination_id := btrim(v_item ->> 'id');
    if v_existing[v_index] then
      select * into v_child_destination
        from publish_intent_destinations
       where publish_intent_id = v_child.id and destination_id = v_destination_id;
      v_inserted := false;
    else
      insert into publish_intent_destinations(
        publish_intent_id, destination_id, provider, social_connection_id,
        subdestination_id, status, claim_token, attempt, retry_allowed,
        retry_of_destination_id
      ) values (
        v_child.id, v_destination_id, v_item ->> 'provider',
        v_item ->> 'socialConnectionId',
        nullif(btrim(coalesce(v_item ->> 'boardId', '')), ''),
        'claimed', null, v_parent_attempts[v_index] + 1, false,
        v_parent_destination_ids[v_index]
      ) returning * into v_child_destination;
      update publish_intent_destinations
         set status = case when v_parent_was_unactivated[v_index] then 'failed' else status end,
             retry_allowed = false,
             finished_at = case when v_parent_was_unactivated[v_index] then now() else finished_at end,
             evidence = case when v_parent_was_unactivated[v_index]
               then coalesce(evidence, '{}'::jsonb) || '{"reason":"reserved_not_activated"}'::jsonb
               else evidence end,
             updated_at = now()
       where id = v_parent_destination_ids[v_index]
         and (
           (status = 'failed' and retry_allowed)
           or (status = 'claimed' and claim_token is null and retry_of_destination_id is not null)
         );
      if not found then
        raise exception using errcode = 'P0001', message = 'retry_not_allowed';
      end if;
      v_inserted := true;
    end if;

    v_result := v_result || jsonb_build_array(jsonb_build_object(
      'claimed', v_inserted,
      'replayed', not v_inserted,
      'intentJobId', v_child.id,
      'destinationJobId', v_child_destination.id,
      'claimToken', null,
      'status', v_child_destination.status,
      'attempt', v_child_destination.attempt,
      'retryAllowed', v_child_destination.retry_allowed,
      'providerJobId', v_child_destination.provider_job_id,
      'remoteId', v_child_destination.remote_id,
      'remoteUrl', v_child_destination.remote_url,
      'providerStatus', v_child_destination.provider_status,
      'evidence', v_child_destination.evidence
    ));
    end loop;
  end if;
  return v_result;
end;
$fn$;

create or replace function publish_intent_activate_retry_destinations(
  p_user_id uuid,
  p_intent_id text,
  p_fingerprint text,
  p_destinations jsonb
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $activate$
declare
  v_intent publish_intents%rowtype;
  v_destination publish_intent_destinations%rowtype;
  v_item jsonb;
  v_seen text[] := array[]::text[];
  v_destination_id text;
  v_provider text;
  v_connection_id text;
  v_board_id text;
  v_claim_token uuid;
  v_activated boolean;
  v_result jsonb := '[]'::jsonb;
begin
  if p_intent_id !~ '^publish:.{1,240}$'
     or p_fingerprint !~ '^[0-9a-f]{64}$'
     or jsonb_typeof(p_destinations) <> 'array'
     or jsonb_array_length(p_destinations) = 0 then
    raise exception using errcode = 'P0001', message = 'retry_not_allowed';
  end if;

  select * into v_intent
    from publish_intents
   where user_id = p_user_id and intent_id = p_intent_id
   for update;
  if not found
     or v_intent.prior_intent_id is null
     or v_intent.fingerprint is distinct from p_fingerprint then
    raise exception using errcode = 'P0001', message = 'retry_not_allowed';
  end if;

  for v_item in
    select value from jsonb_array_elements(p_destinations)
    order by value ->> 'id'
  loop
    v_destination_id := btrim(coalesce(v_item ->> 'id', ''));
    v_provider := btrim(coalesce(v_item ->> 'provider', ''));
    v_connection_id := btrim(coalesce(v_item ->> 'socialConnectionId', ''));
    v_board_id := nullif(btrim(coalesce(v_item ->> 'boardId', '')), '');
    if v_destination_id = ''
       or v_destination_id = any(v_seen)
       or v_provider not in ('pinterest','instagram','facebook')
       or v_connection_id = ''
       or not (v_intent.receipt -> 'dispatchDestinationIds' @> jsonb_build_array(v_destination_id)) then
      raise exception using errcode = 'P0001', message = 'retry_not_allowed';
    end if;
    v_seen := array_append(v_seen, v_destination_id);

    select * into v_destination
      from publish_intent_destinations
     where publish_intent_id = v_intent.id and destination_id = v_destination_id
     for update;
    if not found
       or v_destination.retry_of_destination_id is null
       or v_destination.provider is distinct from v_provider
       or v_destination.social_connection_id is distinct from v_connection_id
       or v_destination.subdestination_id is distinct from v_board_id then
      raise exception using errcode = 'P0001', message = 'retry_not_allowed';
    end if;

    v_activated := false;
    if v_destination.status = 'claimed' and v_destination.claim_token is null then
      -- Supabase installs uuid-ossp in `extensions`, which is intentionally not
      -- on this SECURITY DEFINER function's restricted search_path. Use the
      -- PostgreSQL built-in so activation works without widening that path.
      v_claim_token := gen_random_uuid();
      update publish_intent_destinations set
        claim_token = v_claim_token,
        claimed_at = now(),
        updated_at = now()
       where id = v_destination.id
         and status = 'claimed'
         and claim_token is null
       returning * into v_destination;
      v_activated := found;
    end if;

    v_result := v_result || jsonb_build_array(jsonb_build_object(
      'claimed', v_activated,
      'replayed', not v_activated,
      'intentJobId', v_intent.id,
      'destinationJobId', v_destination.id,
      'claimToken', case when v_activated then v_destination.claim_token else null end,
      'status', v_destination.status,
      'attempt', v_destination.attempt,
      'retryAllowed', v_destination.retry_allowed,
      'providerJobId', v_destination.provider_job_id,
      'remoteId', v_destination.remote_id,
      'remoteUrl', v_destination.remote_url,
      'providerStatus', v_destination.provider_status,
      'evidence', v_destination.evidence
    ));
  end loop;
  return v_result;
end;
$activate$;

revoke all on function publish_intent_reserve_retry_destinations(uuid,text,text,text,text,text,timestamptz,jsonb,jsonb,jsonb)
  from public, anon, authenticated;
grant execute on function publish_intent_reserve_retry_destinations(uuid,text,text,text,text,text,timestamptz,jsonb,jsonb,jsonb)
  to service_role;
revoke all on function publish_intent_activate_retry_destinations(uuid,text,text,jsonb)
  from public, anon, authenticated;
grant execute on function publish_intent_activate_retry_destinations(uuid,text,text,jsonb)
  to service_role;

notify pgrst, 'reload schema';
commit;
