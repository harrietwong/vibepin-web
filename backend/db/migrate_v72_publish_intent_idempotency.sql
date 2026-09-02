-- v72: Durable publish confirmation + per-destination idempotency/recovery.
-- Additive. The API fails closed when these relations/RPCs are unavailable.

begin;

alter table social_publish_jobs add column if not exists publish_intent_id text;
alter table social_publish_jobs add column if not exists publish_intent_fingerprint text;
create unique index if not exists social_publish_jobs_user_publish_intent_unique
  on social_publish_jobs(user_id, publish_intent_id)
  where publish_intent_id is not null;

create table if not exists publish_intents (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null,
  intent_id text not null,
  fingerprint text not null,
  draft_id text not null,
  content_id text not null,
  confirmed_at timestamptz not null,
  mode jsonb not null,
  receipt jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint publish_intents_intent_valid check (intent_id ~ '^publish:.{1,240}$'),
  constraint publish_intents_fingerprint_valid check (fingerprint ~ '^[0-9a-f]{64}$'),
  constraint publish_intents_user_intent_unique unique (user_id, intent_id)
);

create table if not exists publish_intent_destinations (
  id uuid primary key default uuid_generate_v4(),
  publish_intent_id uuid not null references publish_intents(id) on delete cascade,
  destination_id text not null,
  provider text not null,
  social_connection_id text not null,
  subdestination_id text,
  status text not null default 'claimed',
  claim_token uuid,
  attempt integer not null default 1,
  retry_allowed boolean not null default false,
  provider_job_id text,
  remote_id text,
  remote_url text,
  provider_status integer,
  evidence jsonb not null default '{}'::jsonb,
  claimed_at timestamptz not null default now(),
  finished_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint publish_intent_destinations_provider_valid
    check (provider in ('pinterest','instagram','facebook')),
  constraint publish_intent_destinations_status_valid
    check (status in ('claimed','published','failed','delivery_unknown')),
  constraint publish_intent_destinations_exact_unique
    unique (publish_intent_id, destination_id)
);

create index if not exists publish_intents_user_created
  on publish_intents(user_id, created_at desc);
create index if not exists publish_intent_destinations_recovery
  on publish_intent_destinations(publish_intent_id, status, updated_at desc);

-- v32 allowed duplicate destination rows when a retry reused its (user,intent)
-- job.  Refuse the additive migration if historical duplicates exist; silently
-- deleting them would destroy delivery evidence.  Null connection ids (skipped
-- or provider-refused rows) get their own per-job/provider uniqueness rule.
do $$
begin
  if exists (
    select 1 from social_publish_job_destinations
    where social_connection_id is not null
    group by publish_job_id, provider, social_connection_id
    having count(*) > 1
  ) then
    raise exception 'Refusing v72 destination uniqueness: historical non-null duplicates exist';
  end if;
  if exists (
    select 1 from social_publish_job_destinations
    where social_connection_id is null
    group by publish_job_id, provider
    having count(*) > 1
  ) then
    raise exception 'Refusing v72 destination uniqueness: historical null-connection duplicates exist';
  end if;
end $$;
create unique index if not exists social_publish_job_destinations_exact_unique
  on social_publish_job_destinations (publish_job_id, provider, social_connection_id)
  where social_connection_id is not null;
create unique index if not exists social_publish_job_destinations_null_connection_unique
  on social_publish_job_destinations (publish_job_id, provider)
  where social_connection_id is null;

alter table publish_intents enable row level security;
alter table publish_intent_destinations enable row level security;

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
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $fn$
declare
  v_intent publish_intents%rowtype;
  v_destination publish_intent_destinations%rowtype;
  v_claim_token uuid := uuid_generate_v4();
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
     -- An intent is bound to the complete confirmation, not merely its content
     -- fingerprint.  timestamptz comparison is by instant, so equivalent
     -- serializations such as .000Z and +00:00 remain idempotent.
     or v_intent.confirmed_at is distinct from p_confirmed_at
     or v_intent.mode is distinct from p_mode
     -- The timestamp is compared as timestamptz above; remove its textual
     -- representation from JSONB so .000Z and +00:00 are the same receipt.
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

    -- A typed, known failure that never delivered may be retried under the SAME
    -- merchant intent. Published, in-flight and unknown delivery never dispatch again.
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
$fn$;

-- Claim the complete social fan-out in one transaction. A per-destination loop in
-- application code can strand the first claim when a later destination conflicts or
-- the schema cache changes mid-request; this wrapper rolls the entire set back.
create or replace function publish_intent_claim_destinations(
  p_user_id uuid,
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
  v_destination jsonb;
  v_result jsonb := '[]'::jsonb;
  v_seen text[] := array[]::text[];
  v_destination_id text;
begin
  if jsonb_typeof(p_destinations) <> 'array' or jsonb_array_length(p_destinations) = 0 then
    raise exception 'publish intent destinations required' using errcode = '22023';
  end if;
  for v_destination in select value from jsonb_array_elements(p_destinations)
  loop
    v_destination_id := btrim(coalesce(v_destination ->> 'id', ''));
    if v_destination_id = '' or v_destination_id = any(v_seen) then
      raise exception 'duplicate or invalid publish destination' using errcode = '22023';
    end if;
    v_seen := array_append(v_seen, v_destination_id);
    v_result := v_result || jsonb_build_array(publish_intent_claim_destination(
      p_user_id,
      p_intent_id,
      p_fingerprint,
      p_draft_id,
      p_content_id,
      p_confirmed_at,
      p_mode,
      p_receipt,
      v_destination_id,
      v_destination ->> 'provider',
      v_destination ->> 'socialConnectionId',
      nullif(btrim(coalesce(v_destination ->> 'boardId', '')), '')
    ));
  end loop;
  return v_result;
end;
$fn$;

create or replace function publish_intent_settle_destination(
  p_user_id uuid,
  p_intent_id text,
  p_destination_id text,
  p_claim_token uuid,
  p_status text,
  p_retry_allowed boolean,
  p_provider_job_id text default null,
  p_remote_id text default null,
  p_remote_url text default null,
  p_provider_status integer default null,
  p_evidence jsonb default '{}'::jsonb
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $fn$
declare v_destination publish_intent_destinations%rowtype;
begin
  if p_status not in ('published','failed','delivery_unknown') then
    raise exception 'invalid publish intent settlement' using errcode = '22023';
  end if;
  update publish_intent_destinations d set
    status = p_status,
    retry_allowed = case when p_status = 'delivery_unknown' then false else coalesce(p_retry_allowed, false) end,
    provider_job_id = nullif(btrim(p_provider_job_id), ''),
    remote_id = nullif(btrim(p_remote_id), ''),
    remote_url = nullif(btrim(p_remote_url), ''),
    provider_status = p_provider_status,
    evidence = coalesce(p_evidence, '{}'::jsonb),
    claim_token = null,
    finished_at = now(),
    updated_at = now()
  from publish_intents i
  where d.publish_intent_id = i.id
    and i.user_id = p_user_id
    and i.intent_id = p_intent_id
    and d.destination_id = p_destination_id
    and d.status = 'claimed'
    and d.claim_token = p_claim_token
  returning d.* into v_destination;
  if not found then raise exception 'publish intent claim lost' using errcode = '40001'; end if;
  return jsonb_build_object(
    'ok', true, 'destinationJobId', v_destination.id,
    'status', v_destination.status, 'attempt', v_destination.attempt,
    'retryAllowed', v_destination.retry_allowed,
    'providerJobId', v_destination.provider_job_id,
    'remoteId', v_destination.remote_id,
    'remoteUrl', v_destination.remote_url,
    'providerStatus', v_destination.provider_status,
    'evidence', v_destination.evidence
  );
end;
$fn$;

revoke all on table publish_intents, publish_intent_destinations from public, anon, authenticated;
revoke all on function publish_intent_claim_destination(uuid,text,text,text,text,timestamptz,jsonb,jsonb,text,text,text,text) from public, anon, authenticated;
revoke all on function publish_intent_claim_destinations(uuid,text,text,text,text,timestamptz,jsonb,jsonb,jsonb) from public, anon, authenticated;
revoke all on function publish_intent_settle_destination(uuid,text,text,uuid,text,boolean,text,text,text,integer,jsonb) from public, anon, authenticated;
grant all on table publish_intents, publish_intent_destinations to service_role;
grant execute on function publish_intent_claim_destination(uuid,text,text,text,text,timestamptz,jsonb,jsonb,text,text,text,text) to service_role;
grant execute on function publish_intent_claim_destinations(uuid,text,text,text,text,timestamptz,jsonb,jsonb,jsonb) to service_role;
grant execute on function publish_intent_settle_destination(uuid,text,text,uuid,text,boolean,text,text,text,integer,jsonb) to service_role;

notify pgrst, 'reload schema';
commit;
