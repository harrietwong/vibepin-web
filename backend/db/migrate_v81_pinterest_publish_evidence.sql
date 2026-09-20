-- v81: keep the provider-attempt replay contract from v78 while persisting the
-- bounded Pinterest evidence needed to diagnose video-publish failures.
begin;

do $v81_preflight$
declare v_marker text;
begin
  if to_regprocedure('public.publish_provider_attempt_settle_v78(uuid,uuid,uuid,text,integer,text,text,jsonb)') is null then
    raise exception using errcode='P0001', message='v81_requires_v78';
  end if;
  if to_regprocedure('public.publish_provider_attempt_settle_v81(uuid,uuid,uuid,text,integer,text,text,jsonb)') is not null then
    select obj_description(
      'public.publish_provider_attempt_settle_v81(uuid,uuid,uuid,text,integer,text,text,jsonb)'::regprocedure,
      'pg_proc'
    ) into v_marker;
    if v_marker is distinct from 'vibepin:v81:pinterest-publish-evidence' then
      raise exception using errcode='P0001', message='v81_function_collision';
    end if;
  end if;
  if to_regclass('public.pinterest_publish_evidence') is not null then
    select obj_description(to_regclass('public.pinterest_publish_evidence'), 'pg_class') into v_marker;
    if v_marker is distinct from 'vibepin:v81:pinterest-publish-evidence' then
      raise exception using errcode='P0001', message='v81_table_collision';
    end if;
  end if;
end $v81_preflight$;

create table if not exists public.pinterest_publish_evidence (
  attempt_id uuid primary key references public.provider_publish_attempts(id) on delete restrict,
  owner_user_id uuid not null,
  publish_intent_id uuid not null,
  destination_id text not null,
  evidence jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pinterest_publish_evidence_intent_destination_fkey
    foreign key (publish_intent_id, destination_id)
    references public.publish_intent_destinations(publish_intent_id, destination_id) on delete restrict
);
comment on table public.pinterest_publish_evidence is 'vibepin:v81:pinterest-publish-evidence';
create index if not exists pinterest_publish_evidence_lookup_idx
  on public.pinterest_publish_evidence(owner_user_id,publish_intent_id,destination_id,updated_at desc);
alter table public.pinterest_publish_evidence enable row level security;
alter table public.pinterest_publish_evidence force row level security;
revoke all on public.pinterest_publish_evidence from public,anon,authenticated,service_role;
grant select,insert,update on public.pinterest_publish_evidence to service_role;

create or replace function public.publish_provider_attempt_settle_v81(
  p_user_id uuid,
  p_attempt_id uuid,
  p_claim_token uuid,
  p_status text,
  p_provider_status integer default null,
  p_remote_id text default null,
  p_remote_url text default null,
  p_evidence jsonb default '{}'::jsonb
) returns jsonb
language plpgsql security definer set search_path=public,pg_temp
as $v81_settle$
declare
  v_summary jsonb;
  v_result jsonb;
  v_intent_id uuid;
  v_destination_id text;
  v_message text;
begin
  if jsonb_typeof(coalesce(p_evidence, '{}'::jsonb)) <> 'object'
     or exists (
       select 1 from jsonb_object_keys(coalesce(p_evidence, '{}'::jsonb)) key
       where key not in (
         'provider','reason','stage','classification','mediaId','pinId','pinUrl',
         'requestId','providerStatus','providerCode','providerMessage'
       )
     ) then
    raise exception using errcode='22023', message='provider_evidence_invalid';
  end if;

  if p_evidence->>'provider' is distinct from 'pinterest'
     or p_evidence->>'reason' not in (
       'retryable','missing_success_evidence','timeout','network_error','rate_limited',
       'provider_rejected','unknown_outcome','non_retryable'
     )
     or (p_evidence ? 'stage' and (
       jsonb_typeof(p_evidence->'stage') <> 'string'
       or p_evidence->>'stage' not in ('validated','registered','uploaded','polled','created')
     ))
     or (p_evidence ? 'classification' and (
       jsonb_typeof(p_evidence->'classification') <> 'string'
       or p_evidence->>'classification' not in ('succeeded','definite_validation','definite_rejection','unknown')
     )) then
    raise exception using errcode='22023', message='provider_evidence_invalid';
  end if;

  if exists (
    select 1 from jsonb_each(p_evidence) item(key,value)
    where key in ('mediaId','requestId','providerCode')
      and (jsonb_typeof(value) <> 'string'
        or length(value #>> '{}') not between 1 and 128
        or value #>> '{}' !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')
  )
  or (p_evidence ? 'pinId' and (
    jsonb_typeof(p_evidence->'pinId') <> 'string'
    or p_evidence->>'pinId' !~ '^[0-9]{1,128}$'
  ))
  or (p_evidence ? 'providerStatus' and (
    jsonb_typeof(p_evidence->'providerStatus') <> 'number'
    or (p_evidence->>'providerStatus') !~ '^[0-9]{3}$'
    or (p_evidence->>'providerStatus')::integer not between 100 and 599
  ))
  or (p_evidence ? 'pinUrl' and (
    jsonb_typeof(p_evidence->'pinUrl') <> 'string'
    or p_evidence->>'pinUrl' !~ '^https://www\.pinterest\.com/pin/[0-9]{1,128}/$'
  )) then
    raise exception using errcode='22023', message='provider_evidence_invalid';
  end if;

  if p_evidence ? 'providerMessage' then
    if jsonb_typeof(p_evidence->'providerMessage') <> 'string' then
      raise exception using errcode='22023', message='provider_evidence_invalid';
    end if;
    v_message := p_evidence->>'providerMessage';
    if length(v_message) not between 1 and 240
       or v_message ~* 'https?://'
       or v_message ~ '[{}\[\]]'
       or v_message ~ '[[:cntrl:]]'
       or v_message ~* '\mbearer\M[[:space:]:=]+[^[:space:]]+'
       or v_message ~ '\meyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}'
       or v_message ~* '\m(authorization|token|access[_ -]?token|api[_ -]?key|secret|signature)\M[[:space:]]*[:=][[:space:]]*[^[:space:]]+' then
      raise exception using errcode='22023', message='provider_evidence_invalid';
    end if;
  end if;

  if (p_evidence ? 'providerStatus'
      and (p_evidence->>'providerStatus')::integer is distinct from p_provider_status)
     or (p_evidence ? 'pinId' and p_evidence->>'pinId' is distinct from nullif(btrim(p_remote_id), ''))
     or (p_evidence ? 'pinUrl' and p_evidence->>'pinUrl' is distinct from nullif(btrim(p_remote_url), ''))
     or (p_status = 'succeeded' and (
       p_evidence->>'classification' is distinct from 'succeeded'
       or p_evidence->>'pinId' is distinct from nullif(btrim(p_remote_id), '')
       or p_evidence->>'pinUrl' is distinct from nullif(btrim(p_remote_url), '')
     )) then
    raise exception using errcode='22023', message='provider_evidence_mismatch';
  end if;

  -- v78 remains the authority for claims, terminal transitions, replay checks,
  -- remote identifiers and provider status. Its intentionally small evidence
  -- object stays byte-stable so a terminal replay remains idempotent.
  v_summary := jsonb_build_object(
    'provider', p_evidence->>'provider',
    'reason', p_evidence->>'reason'
  );
  v_result := public.publish_provider_attempt_settle_v78(
    p_user_id,
    p_attempt_id,
    p_claim_token,
    p_status,
    p_provider_status,
    p_remote_id,
    p_remote_url,
    v_summary
  );

  select publish_intent_id, destination_id
    into v_intent_id, v_destination_id
    from public.provider_publish_attempts
   where id=p_attempt_id and owner_user_id=p_user_id;
  if not found then
    raise exception using errcode='P0002', message='provider_attempt_not_found';
  end if;

  insert into public.pinterest_publish_evidence(
    attempt_id,owner_user_id,publish_intent_id,destination_id,evidence
  ) values (
    p_attempt_id,p_user_id,v_intent_id,v_destination_id,p_evidence
  ) on conflict(attempt_id) do update set
    evidence=excluded.evidence,
    updated_at=now()
  where pinterest_publish_evidence.owner_user_id=excluded.owner_user_id
    and pinterest_publish_evidence.publish_intent_id=excluded.publish_intent_id
    and pinterest_publish_evidence.destination_id=excluded.destination_id
    and pinterest_publish_evidence.evidence=excluded.evidence;
  if not found then
    raise exception using errcode='23505', message='provider_evidence_conflict';
  end if;
  return v_result;
exception when others then
  raise exception using errcode=sqlstate, message=case sqlerrm
    when 'provider_evidence_invalid' then 'provider_evidence_invalid'
    when 'provider_evidence_mismatch' then 'provider_evidence_mismatch'
    when 'provider_attempt_not_found' then 'provider_attempt_not_found'
    when 'provider_evidence_conflict' then 'provider_evidence_conflict'
    else 'v81_rpc_error' end;
end $v81_settle$;

comment on function public.publish_provider_attempt_settle_v81(uuid,uuid,uuid,text,integer,text,text,jsonb)
  is 'vibepin:v81:pinterest-publish-evidence';
revoke all on function public.publish_provider_attempt_settle_v81(uuid,uuid,uuid,text,integer,text,text,jsonb)
  from public,anon,authenticated;
grant execute on function public.publish_provider_attempt_settle_v81(uuid,uuid,uuid,text,integer,text,text,jsonb)
  to service_role;

notify pgrst,'reload schema';
commit;
