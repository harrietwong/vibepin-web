-- v78: additive recovery/lineage upgrade for the installed v76/v77 ledger.
-- The v76 entry points remain byte-identical; application code opts into these
-- versioned RPCs so an already-applied v76 never needs rollback or replacement.
begin;

do $v78_preflight$
declare
  v_expected record;
  v_oid oid;
  v_proc pg_proc%rowtype;
  v_attnum smallint;
  v_function_count integer;
  v_type text;
  v_not_null boolean;
  v_default text;
  v_has_column_acl boolean;
  v_grantee text;
  v_privilege text;
  v_actual boolean;
begin
  for v_expected in select * from (values
    ('public.publish_intent_confirm_prepare(uuid,jsonb)','vibepin:v76:publish-intent-confirm-prepare','cec4333de13036aa19bff218b3f5f32f'),
    ('public.publish_asset_claim_ready(uuid,text,text,uuid)','vibepin:v76:publish-asset-claim-ready','35acedfaf1a8ee6c1d2658b423614987'),
    ('public.publish_provider_attempt_settle(uuid,uuid,uuid,text,integer,text,text,jsonb)','vibepin:v76:publish-provider-attempt-settle','1338440656fe5dd29a797adab9a1631d')
  ) expected(signature,marker,body_hash) loop
    v_oid := to_regprocedure(v_expected.signature);
    if v_oid is null or obj_description(v_oid,'pg_proc') is distinct from v_expected.marker then
      raise exception using errcode='P0001',message='v78_v76_dependency_tamper';
    end if;
    select * into v_proc from pg_proc where oid=v_oid;
    if not v_proc.prosecdef or v_proc.prokind<>'f' or v_proc.prorettype<>to_regtype('jsonb')
       or v_proc.proretset or v_proc.provariadic<>0
       or v_proc.prolang<>(select oid from pg_language where lanname='plpgsql')
       or v_proc.proconfig is distinct from array['search_path=public, pg_temp']::text[]
       or md5(replace(replace(v_proc.prosrc,chr(13)||chr(10),chr(10)),chr(13),chr(10)))<>v_expected.body_hash then
      raise exception using errcode='P0001',message='v78_v76_dependency_tamper';
    end if;
  end loop;

  select count(*) into v_function_count from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname in (
     'publish_intent_confirm_prepare_v78','publish_asset_claim_ready_v78',
     'publish_asset_ready_sources_v78','publish_provider_attempt_settle_v78');
  if v_function_count not in (0,4) or exists (
    select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public' and p.proname in (
       'publish_intent_confirm_prepare_v78','publish_asset_claim_ready_v78',
       'publish_asset_ready_sources_v78','publish_provider_attempt_settle_v78')
       and p.oid is distinct from case p.proname
         when 'publish_intent_confirm_prepare_v78' then to_regprocedure('public.publish_intent_confirm_prepare_v78(uuid,jsonb,text)')
         when 'publish_asset_claim_ready_v78' then to_regprocedure('public.publish_asset_claim_ready_v78(uuid,text,text,uuid)')
         when 'publish_asset_ready_sources_v78' then to_regprocedure('public.publish_asset_ready_sources_v78(uuid,text,text)')
         when 'publish_provider_attempt_settle_v78' then to_regprocedure('public.publish_provider_attempt_settle_v78(uuid,uuid,uuid,text,integer,text,text,jsonb)')
       end
  ) then raise exception using errcode='P0001',message='v78_definition_tamper'; end if;

  for v_expected in select * from (values
    ('public.publish_intent_confirm_prepare_v78(uuid,jsonb,text)','vibepin:v78:publish-intent-confirm-prepare','9e62b0e4da76c6b23962538587858093'),
    ('public.publish_asset_claim_ready_v78(uuid,text,text,uuid)','vibepin:v78:publish-asset-claim-ready','ee50c7392dd17d7ed8b597312223f65c'),
    ('public.publish_asset_ready_sources_v78(uuid,text,text)','vibepin:v78:publish-asset-ready-sources','8df858a2e93b6e11952759332a738706'),
    ('public.publish_provider_attempt_settle_v78(uuid,uuid,uuid,text,integer,text,text,jsonb)','vibepin:v78:publish-provider-attempt-settle','b4bc74adeb3e3d320e261c7129472e41')
  ) expected(signature,marker,body_hash) loop
    v_oid := to_regprocedure(v_expected.signature);
    if v_function_count=4 then
      if v_oid is null then raise exception using errcode='P0001',message='v78_definition_tamper'; end if;
      select * into v_proc from pg_proc where oid=v_oid;
      if obj_description(v_oid,'pg_proc') is distinct from v_expected.marker
         or not v_proc.prosecdef or v_proc.prokind<>'f' or v_proc.prorettype<>to_regtype('jsonb')
         or v_proc.proretset or v_proc.provariadic<>0
         or v_proc.prolang<>(select oid from pg_language where lanname='plpgsql')
         or v_proc.proconfig is distinct from array['search_path=public, pg_temp']::text[]
         or md5(replace(replace(v_proc.prosrc,chr(13)||chr(10),chr(10)),chr(13),chr(10)))<>v_expected.body_hash then
        raise exception using errcode='P0001',message='v78_definition_tamper';
      end if;
      foreach v_grantee in array array['anon','authenticated','service_role'] loop
        v_actual := has_function_privilege(v_grantee,v_oid,'EXECUTE');
        if v_actual is distinct from (v_grantee='service_role')
           or has_function_privilege(v_grantee,v_oid,'EXECUTE WITH GRANT OPTION') then
          raise exception using errcode='P0001',message='v78_definition_tamper';
        end if;
      end loop;
      if exists (select 1 from aclexplode(coalesce(v_proc.proacl,acldefault('f',v_proc.proowner))) acl
        where acl.privilege_type<>'EXECUTE'
           or acl.grantee not in (v_proc.proowner,(select oid from pg_roles where rolname='service_role'))
           or (acl.grantee=(select oid from pg_roles where rolname='service_role') and acl.is_grantable)) then
        raise exception using errcode='P0001',message='v78_definition_tamper';
      end if;
    end if;
  end loop;

  select format_type(a.atttypid,a.atttypmod),a.attnotnull,pg_get_expr(d.adbin,d.adrelid),
         a.attacl is not null,a.attnum
    into v_type,v_not_null,v_default,v_has_column_acl,v_attnum
    from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
   where a.attrelid='public.publish_intents'::regclass
     and a.attname='source_identity_fingerprint' and a.attnum>0 and not a.attisdropped;
  if found then
    if v_type is distinct from 'text' or v_not_null or v_default is not null or v_has_column_acl
       or col_description('public.publish_intents'::regclass,v_attnum)
          is distinct from 'vibepin:v78:source-identity-fingerprint' then
      raise exception using errcode='P0001',message='v78_definition_tamper';
    end if;
    foreach v_grantee in array array['anon','authenticated','service_role'] loop
      foreach v_privilege in array array['SELECT','INSERT','UPDATE','REFERENCES'] loop
        v_actual := has_column_privilege(v_grantee,'public.publish_intents','source_identity_fingerprint',v_privilege);
        if v_actual is distinct from (v_grantee='service_role' and v_privilege='SELECT')
           or has_column_privilege(v_grantee,'public.publish_intents','source_identity_fingerprint',v_privilege||' WITH GRANT OPTION') then
          raise exception using errcode='P0001',message='v78_definition_tamper';
        end if;
      end loop;
    end loop;
  elsif v_function_count<>0 then
    raise exception using errcode='P0001',message='v78_definition_tamper';
  end if;
end $v78_preflight$;

alter table public.publish_intents
  add column if not exists source_identity_fingerprint text;
comment on column public.publish_intents.source_identity_fingerprint is 'vibepin:v78:source-identity-fingerprint';

create or replace function public.publish_intent_confirm_prepare_v78(
  p_user_id uuid,p_receipt jsonb,p_source_identity_fingerprint text
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $fn$
-- vibepin:v78:publish-intent-confirm-prepare
declare
  v_result jsonb;
  v_prior_intent_id text := nullif(btrim(coalesce(p_receipt->>'priorIntentId','')), '');
  v_intent_id text := btrim(coalesce(p_receipt->>'intentId',''));
  v_parent public.publish_intents%rowtype;
  v_child public.publish_intents%rowtype;
  v_parent_destination public.publish_intent_destinations%rowtype;
  v_child_destination public.publish_intent_destinations%rowtype;
  v_requested jsonb;
  v_destination jsonb;
  v_destination_id text;
begin
  if p_source_identity_fingerprint is null
     or p_source_identity_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception using errcode='22023',message='invalid_source_identity_fingerprint';
  end if;

  if v_prior_intent_id is null then
    v_result := public.publish_intent_confirm_prepare(p_user_id,p_receipt);
    select * into v_child from public.publish_intents
     where user_id=p_user_id and intent_id=v_intent_id for update;
    if not found then raise exception using errcode='P0002',message='publish_intent_not_found'; end if;
    if v_child.source_identity_fingerprint is not null
       and v_child.source_identity_fingerprint<>p_source_identity_fingerprint then
      raise exception using errcode='23505',message='publish_source_identity_conflict';
    end if;
    update public.publish_intents set
      source_identity_fingerprint=p_source_identity_fingerprint,updated_at=now()
     where id=v_child.id;
    return v_result;
  end if;

  if p_receipt->'mode' is distinct from '{"kind":"now"}'::jsonb
     or p_receipt->'onlyPending' is distinct from 'true'::jsonb
     or jsonb_typeof(p_receipt->'publishableDestinations')<>'array'
     or jsonb_typeof(p_receipt->'dispatchDestinationIds')<>'array'
     or jsonb_array_length(p_receipt->'dispatchDestinationIds')=0
     or exists (select 1 from jsonb_array_elements_text(p_receipt->'dispatchDestinationIds') ids(value)
       group by value having nullif(btrim(value),'') is null or count(*)<>1) then
    raise exception using errcode='P0001',message='retry_not_allowed';
  end if;

  select * into v_parent from public.publish_intents
   where user_id=p_user_id and intent_id=v_prior_intent_id for update;
  if not found
     or v_parent.draft_id is distinct from p_receipt->>'draftId'
     or v_parent.content_id is distinct from p_receipt->>'contentId' then
    raise exception using errcode='P0001',message='retry_not_allowed';
  end if;

  select coalesce(jsonb_agg(destination.value order by destination.value->>'id'),'[]'::jsonb)
    into v_requested
    from jsonb_array_elements(p_receipt->'publishableDestinations') destination(value)
   where p_receipt->'dispatchDestinationIds' @> jsonb_build_array(destination.value->>'id');
  if jsonb_array_length(v_requested)<>jsonb_array_length(p_receipt->'dispatchDestinationIds')
     or exists (
       select 1 from jsonb_array_elements(v_requested) requested(value)
        left join public.publish_intent_destinations parent_destination
          on parent_destination.publish_intent_id=v_parent.id
         and parent_destination.destination_id=requested.value->>'id'
       where parent_destination.id is null
          or parent_destination.provider is distinct from requested.value->>'provider'
          or parent_destination.social_connection_id is distinct from requested.value->>'socialConnectionId'
          or parent_destination.subdestination_id is distinct from nullif(btrim(coalesce(requested.value->>'boardId','')),'')
          or parent_destination.status<>'failed' or not parent_destination.retry_allowed
          or exists (select 1 from public.publish_intent_destinations consumed
            where consumed.retry_of_destination_id=parent_destination.id)
     ) then
    raise exception using errcode='P0001',message='retry_not_allowed';
  end if;

  -- v76 validates/creates the complete materialization graph for the authorized
  -- retry subset. The outer v78 transaction then binds that graph to its parent.
  v_result := public.publish_intent_confirm_prepare(
    p_user_id,
    jsonb_set(p_receipt,'{publishableDestinations}',v_requested,false)
  );
  select * into v_child from public.publish_intents
   where user_id=p_user_id and intent_id=v_intent_id for update;
  if not found or (v_child.prior_intent_id is not null and v_child.prior_intent_id<>v_parent.id)
     or (v_child.source_identity_fingerprint is not null
       and v_child.source_identity_fingerprint<>p_source_identity_fingerprint) then
    raise exception using errcode='P0001',message='retry_not_allowed';
  end if;
  update public.publish_intents set prior_intent_id=v_parent.id,
    source_identity_fingerprint=p_source_identity_fingerprint,updated_at=now()
   where id=v_child.id;

  for v_destination in select value from jsonb_array_elements(v_requested) loop
    v_destination_id := v_destination->>'id';
    select * into v_parent_destination from public.publish_intent_destinations
     where publish_intent_id=v_parent.id and destination_id=v_destination_id for update;
    select * into v_child_destination from public.publish_intent_destinations
     where publish_intent_id=v_child.id and destination_id=v_destination_id for update;
    if not found or v_parent_destination.status<>'failed' or not v_parent_destination.retry_allowed
       or (v_child_destination.retry_of_destination_id is not null
         and v_child_destination.retry_of_destination_id<>v_parent_destination.id)
       or exists (select 1 from public.publish_intent_destinations consumed
         where consumed.retry_of_destination_id=v_parent_destination.id
           and consumed.id<>v_child_destination.id) then
      raise exception using errcode='P0001',message='retry_not_allowed';
    end if;
    update public.publish_intent_destinations set
      retry_of_destination_id=v_parent_destination.id,
      attempt=v_parent_destination.attempt+1,updated_at=now()
     where id=v_child_destination.id;
  end loop;
  return v_result;
exception when others then
  raise exception using errcode=sqlstate,message=case sqlerrm
    when 'invalid_source_identity_fingerprint' then 'invalid_source_identity_fingerprint'
    when 'publish_intent_not_found' then 'publish_intent_not_found'
    when 'publish_source_identity_conflict' then 'publish_source_identity_conflict'
    when 'retry_not_allowed' then 'retry_not_allowed'
    when 'invalid_publish_receipt' then 'invalid_publish_receipt'
    when 'receipt_destination_set_invalid' then 'receipt_destination_set_invalid'
    when 'receipt_destination_alias' then 'receipt_destination_alias'
    when 'receipt_destination_not_connected' then 'receipt_destination_not_connected'
    when 'receipt_media_set_invalid' then 'receipt_media_set_invalid'
    when 'receipt_media_key_invalid' then 'receipt_media_key_invalid'
    when 'receipt_media_metadata_invalid' then 'receipt_media_metadata_invalid'
    when 'publish_intent_conflict' then 'publish_intent_conflict'
    when 'publish_intent_graph_conflict' then 'publish_intent_graph_conflict'
    else 'v78_rpc_error' end;
end $fn$;

create or replace function public.publish_asset_claim_ready_v78(
  p_user_id uuid,p_intent_id text,p_destination_id text,p_claim_token uuid
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $fn$
-- vibepin:v78:publish-asset-claim-ready
declare v_d public.publish_intent_destinations%rowtype; v_i public.publish_intents%rowtype;
begin
  if p_claim_token is null then raise exception using errcode='22023',message='claim_token_required'; end if;
  select * into v_i from public.publish_intents
   where user_id=p_user_id and intent_id=p_intent_id for update;
  if not found then raise exception using errcode='P0002',message='publish_intent_not_found'; end if;
  if v_i.lifecycle_status='canceled' or (v_i.schedule_at is not null and v_i.schedule_at>now()) then
    raise exception using errcode='55000',message='publish_intent_not_due';
  end if;
  update public.publish_intent_destinations d set
    status='claimed',claim_token=p_claim_token,claimed_at=now(),updated_at=now()
   where d.publish_intent_id=v_i.id and d.destination_id=p_destination_id
     and d.materialization_status='materialized' and d.status='prepared'
     and exists (select 1 from public.publish_asset_deliveries delivery
       where delivery.publish_intent_id=d.publish_intent_id
         and delivery.destination_id=d.destination_id and delivery.status='ready')
     and exists (select 1 from public.social_connections connection
       where connection.id::text=d.social_connection_id and connection.user_id=p_user_id
         and connection.provider=d.provider and connection.connection_status='connected'
         and connection.disconnected_at is null)
   returning d.* into v_d;
  if not found then raise exception using errcode='40001',message='publish_destination_is_not_ready_or_already_claimed'; end if;
  return jsonb_build_object('claimed',true,'destinationId',v_d.destination_id,
    'claimToken',v_d.claim_token,'attempt',v_d.attempt);
exception when others then
  raise exception using errcode=sqlstate,message=case sqlerrm
    when 'claim_token_required' then 'claim_token_required'
    when 'publish_intent_not_found' then 'publish_intent_not_found'
    when 'publish_intent_not_due' then 'publish_intent_not_due'
    when 'publish_destination_is_not_ready_or_already_claimed' then 'publish_destination_is_not_ready_or_already_claimed'
    else 'v78_rpc_error' end;
end $fn$;

create or replace function public.publish_asset_ready_sources_v78(
  p_user_id uuid,p_intent_id text,p_destination_id text
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $fn$
-- vibepin:v78:publish-asset-ready-sources
declare v_i public.publish_intents%rowtype; v_d public.publish_intent_destinations%rowtype; v_result jsonb;
begin
  select * into v_i from public.publish_intents
   where user_id=p_user_id and intent_id=p_intent_id for share;
  if not found then raise exception using errcode='P0002',message='publish_intent_not_found'; end if;
  select * into v_d from public.publish_intent_destinations
   where publish_intent_id=v_i.id and destination_id=p_destination_id for share;
  if not found or v_d.materialization_status<>'materialized' or v_d.status not in ('prepared','claimed') then
    raise exception using errcode='55000',message='publish_destination_not_ready';
  end if;
  if not exists (select 1 from public.publish_asset_deliveries delivery
    where delivery.publish_intent_id=v_i.id and delivery.destination_id=v_d.destination_id
      and delivery.status='ready') then
    raise exception using errcode='55000',message='publish_destination_not_ready';
  end if;
  select jsonb_agg(jsonb_build_object(
      'mediaId',asset.source_media_key,'ordinal',asset.media_ordinal,
      'bucketId',asset.bucket_id,'objectPath',asset.object_path,
      'contentType',asset.content_type,'byteSize',asset.byte_size,
      'checksumSha256',asset.checksum_sha256) order by asset.media_ordinal)
    into v_result
    from public.publish_asset_deliveries delivery
    join public.publish_asset_delivery_items item on item.delivery_id=delivery.id
    join public.publish_assets asset on asset.id=item.asset_id
   where delivery.publish_intent_id=v_i.id and delivery.destination_id=v_d.destination_id
     and delivery.status='ready' and item.item_status='ready'
     and item.owner_user_id=p_user_id and asset.owner_user_id=p_user_id
     and asset.publish_intent_id=v_i.id and asset.status='ready'
     and asset.bucket_id='generated-private'
     and asset.object_path like p_user_id::text||'/publish/%'
     and asset.content_type in ('video/mp4','video/x-m4v','video/quicktime')
     and asset.byte_size>0 and asset.checksum_sha256~'^[0-9a-f]{64}$';
  if v_result is null or jsonb_array_length(v_result)<>(select count(*) from public.publish_assets where publish_intent_id=v_i.id) then
    raise exception using errcode='55000',message='publish_ready_asset_graph_invalid';
  end if;
  return v_result;
exception when others then
  raise exception using errcode=sqlstate,message=case sqlerrm
    when 'publish_intent_not_found' then 'publish_intent_not_found'
    when 'publish_destination_not_ready' then 'publish_destination_not_ready'
    when 'publish_ready_asset_graph_invalid' then 'publish_ready_asset_graph_invalid'
    else 'v78_rpc_error' end;
end $fn$;

create or replace function public.publish_provider_attempt_settle_v78(
  p_user_id uuid,p_attempt_id uuid,p_claim_token uuid,p_status text,
  p_provider_status integer default null,p_remote_id text default null,
  p_remote_url text default null,p_evidence jsonb default '{}'::jsonb
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $fn$
-- vibepin:v78:publish-provider-attempt-settle
declare v_result jsonb; v_intent_id uuid;
begin
  v_result := public.publish_provider_attempt_settle(
    p_user_id,p_attempt_id,p_claim_token,p_status,p_provider_status,
    p_remote_id,p_remote_url,p_evidence);
  select publish_intent_id into v_intent_id from public.provider_publish_attempts
   where id=p_attempt_id and owner_user_id=p_user_id;
  if not found then raise exception using errcode='P0002',message='provider_attempt_not_found'; end if;
  if exists (select 1 from public.publish_intent_destinations
    where publish_intent_id=v_intent_id
      and status not in ('published','failed','delivery_unknown','canceled')) then
    update public.publish_intents set lifecycle_status='partially_ready',settled_at=null,updated_at=now()
     where id=v_intent_id;
  elsif exists (select 1 from public.publish_intent_destinations
    where publish_intent_id=v_intent_id and status='delivery_unknown') then
    update public.publish_intents set lifecycle_status='delivery_unknown',settled_at=now(),updated_at=now()
     where id=v_intent_id;
  elsif not exists (select 1 from public.publish_intent_destinations
    where publish_intent_id=v_intent_id and status<>'published') then
    update public.publish_intents set lifecycle_status='settled',settled_at=now(),updated_at=now()
     where id=v_intent_id;
  else
    update public.publish_intents set lifecycle_status='partially_ready',settled_at=null,updated_at=now()
     where id=v_intent_id;
  end if;
  return v_result;
end $fn$;

comment on function public.publish_intent_confirm_prepare_v78(uuid,jsonb,text) is 'vibepin:v78:publish-intent-confirm-prepare';
comment on function public.publish_asset_claim_ready_v78(uuid,text,text,uuid) is 'vibepin:v78:publish-asset-claim-ready';
comment on function public.publish_asset_ready_sources_v78(uuid,text,text) is 'vibepin:v78:publish-asset-ready-sources';
comment on function public.publish_provider_attempt_settle_v78(uuid,uuid,uuid,text,integer,text,text,jsonb) is 'vibepin:v78:publish-provider-attempt-settle';

revoke all on function public.publish_intent_confirm_prepare_v78(uuid,jsonb,text) from public,anon,authenticated;
revoke all on function public.publish_asset_claim_ready_v78(uuid,text,text,uuid) from public,anon,authenticated;
revoke all on function public.publish_asset_ready_sources_v78(uuid,text,text) from public,anon,authenticated;
revoke all on function public.publish_provider_attempt_settle_v78(uuid,uuid,uuid,text,integer,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.publish_intent_confirm_prepare_v78(uuid,jsonb,text) to service_role;
grant execute on function public.publish_asset_claim_ready_v78(uuid,text,text,uuid) to service_role;
grant execute on function public.publish_asset_ready_sources_v78(uuid,text,text) to service_role;
grant execute on function public.publish_provider_attempt_settle_v78(uuid,uuid,uuid,text,integer,text,text,jsonb) to service_role;

do $v78_postflight$
declare
  v_expected record;
  v_proc pg_proc%rowtype;
  v_oid oid;
  v_attnum smallint;
  v_type text;
  v_not_null boolean;
  v_default text;
  v_has_column_acl boolean;
  v_grantee text;
  v_privilege text;
  v_actual boolean;
begin
  if (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and p.proname in (
         'publish_intent_confirm_prepare_v78','publish_asset_claim_ready_v78',
         'publish_asset_ready_sources_v78','publish_provider_attempt_settle_v78'))<>4 then
    raise exception using errcode='P0001',message='v78_definition_tamper';
  end if;
  for v_expected in select * from (values
    ('public.publish_intent_confirm_prepare_v78(uuid,jsonb,text)','vibepin:v78:publish-intent-confirm-prepare','9e62b0e4da76c6b23962538587858093'),
    ('public.publish_asset_claim_ready_v78(uuid,text,text,uuid)','vibepin:v78:publish-asset-claim-ready','ee50c7392dd17d7ed8b597312223f65c'),
    ('public.publish_asset_ready_sources_v78(uuid,text,text)','vibepin:v78:publish-asset-ready-sources','8df858a2e93b6e11952759332a738706'),
    ('public.publish_provider_attempt_settle_v78(uuid,uuid,uuid,text,integer,text,text,jsonb)','vibepin:v78:publish-provider-attempt-settle','b4bc74adeb3e3d320e261c7129472e41')
  ) expected(signature,marker,body_hash) loop
    v_oid:=to_regprocedure(v_expected.signature);
    if v_oid is null then raise exception using errcode='P0001',message='v78_definition_tamper'; end if;
    select * into v_proc from pg_proc where oid=v_oid;
    if obj_description(v_oid,'pg_proc') is distinct from v_expected.marker
       or not v_proc.prosecdef or v_proc.prokind<>'f' or v_proc.prorettype<>to_regtype('jsonb')
       or v_proc.proretset or v_proc.provariadic<>0
       or v_proc.prolang<>(select oid from pg_language where lanname='plpgsql')
       or v_proc.proconfig is distinct from array['search_path=public, pg_temp']::text[]
       or md5(replace(replace(v_proc.prosrc,chr(13)||chr(10),chr(10)),chr(13),chr(10)))<>v_expected.body_hash then
      raise exception using errcode='P0001',message='v78_definition_tamper';
    end if;
    foreach v_grantee in array array['anon','authenticated','service_role'] loop
      v_actual:=has_function_privilege(v_grantee,v_oid,'EXECUTE');
      if v_actual is distinct from (v_grantee='service_role')
         or has_function_privilege(v_grantee,v_oid,'EXECUTE WITH GRANT OPTION') then
        raise exception using errcode='P0001',message='v78_definition_tamper';
      end if;
    end loop;
    if exists (select 1 from aclexplode(coalesce(v_proc.proacl,acldefault('f',v_proc.proowner))) acl
      where acl.privilege_type<>'EXECUTE'
         or acl.grantee not in (v_proc.proowner,(select oid from pg_roles where rolname='service_role'))
         or (acl.grantee=(select oid from pg_roles where rolname='service_role') and acl.is_grantable)) then
      raise exception using errcode='P0001',message='v78_definition_tamper';
    end if;
  end loop;

  select format_type(a.atttypid,a.atttypmod),a.attnotnull,pg_get_expr(d.adbin,d.adrelid),
         a.attacl is not null,a.attnum
    into v_type,v_not_null,v_default,v_has_column_acl,v_attnum
    from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
   where a.attrelid='public.publish_intents'::regclass
     and a.attname='source_identity_fingerprint' and a.attnum>0 and not a.attisdropped;
  if not found or v_type is distinct from 'text' or v_not_null or v_default is not null or v_has_column_acl
     or col_description('public.publish_intents'::regclass,v_attnum)
        is distinct from 'vibepin:v78:source-identity-fingerprint' then
    raise exception using errcode='P0001',message='v78_definition_tamper';
  end if;
  foreach v_grantee in array array['anon','authenticated','service_role'] loop
    foreach v_privilege in array array['SELECT','INSERT','UPDATE','REFERENCES'] loop
      v_actual:=has_column_privilege(v_grantee,'public.publish_intents','source_identity_fingerprint',v_privilege);
      if v_actual is distinct from (v_grantee='service_role' and v_privilege='SELECT')
         or has_column_privilege(v_grantee,'public.publish_intents','source_identity_fingerprint',v_privilege||' WITH GRANT OPTION') then
        raise exception using errcode='P0001',message='v78_definition_tamper';
      end if;
    end loop;
  end loop;
end $v78_postflight$;

notify pgrst,'reload schema';
commit;
