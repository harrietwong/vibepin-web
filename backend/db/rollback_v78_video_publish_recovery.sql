-- v78 rollback policy: remove only the versioned RPC surface. The additive
-- identity column and its historical evidence are deliberately retained.
begin;
do $v78_rollback_preflight$
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
  ) then raise exception using errcode='P0001',message='v78_rollback_definition_tamper'; end if;

  for v_expected in select * from (values
    ('public.publish_intent_confirm_prepare_v78(uuid,jsonb,text)','vibepin:v78:publish-intent-confirm-prepare','9e62b0e4da76c6b23962538587858093'),
    ('public.publish_asset_claim_ready_v78(uuid,text,text,uuid)','vibepin:v78:publish-asset-claim-ready','ee50c7392dd17d7ed8b597312223f65c'),
    ('public.publish_asset_ready_sources_v78(uuid,text,text)','vibepin:v78:publish-asset-ready-sources','8df858a2e93b6e11952759332a738706'),
    ('public.publish_provider_attempt_settle_v78(uuid,uuid,uuid,text,integer,text,text,jsonb)','vibepin:v78:publish-provider-attempt-settle','b4bc74adeb3e3d320e261c7129472e41')
  ) expected(signature,marker,body_hash) loop
    v_oid:=to_regprocedure(v_expected.signature);
    if v_function_count=4 then
      if v_oid is null then raise exception using errcode='P0001',message='v78_rollback_definition_tamper'; end if;
      select * into v_proc from pg_proc where oid=v_oid;
      if obj_description(v_oid,'pg_proc') is distinct from v_expected.marker
         or not v_proc.prosecdef or v_proc.prokind<>'f' or v_proc.prorettype<>to_regtype('jsonb')
         or v_proc.proretset or v_proc.provariadic<>0
         or v_proc.prolang<>(select oid from pg_language where lanname='plpgsql')
         or v_proc.proconfig is distinct from array['search_path=public, pg_temp']::text[]
         or md5(replace(replace(v_proc.prosrc,chr(13)||chr(10),chr(10)),chr(13),chr(10)))<>v_expected.body_hash then
        raise exception using errcode='P0001',message='v78_rollback_definition_tamper';
      end if;
      foreach v_grantee in array array['anon','authenticated','service_role'] loop
        v_actual := has_function_privilege(v_grantee,v_oid,'EXECUTE');
        if v_actual is distinct from (v_grantee='service_role')
           or has_function_privilege(v_grantee,v_oid,'EXECUTE WITH GRANT OPTION') then
          raise exception using errcode='P0001',message='v78_rollback_definition_tamper';
        end if;
      end loop;
      if exists (select 1 from aclexplode(coalesce(v_proc.proacl,acldefault('f',v_proc.proowner))) acl
        where acl.privilege_type<>'EXECUTE'
           or acl.grantee not in (v_proc.proowner,(select oid from pg_roles where rolname='service_role'))
           or (acl.grantee=(select oid from pg_roles where rolname='service_role') and acl.is_grantable)) then
        raise exception using errcode='P0001',message='v78_rollback_definition_tamper';
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
      raise exception using errcode='P0001',message='v78_rollback_definition_tamper';
    end if;
    foreach v_grantee in array array['anon','authenticated','service_role'] loop
      foreach v_privilege in array array['SELECT','INSERT','UPDATE','REFERENCES'] loop
        v_actual := has_column_privilege(v_grantee,'public.publish_intents','source_identity_fingerprint',v_privilege);
        if v_actual is distinct from (v_grantee='service_role' and v_privilege='SELECT')
           or has_column_privilege(v_grantee,'public.publish_intents','source_identity_fingerprint',v_privilege||' WITH GRANT OPTION') then
          raise exception using errcode='P0001',message='v78_rollback_definition_tamper';
        end if;
      end loop;
    end loop;
  elsif v_function_count<>0 then
    raise exception using errcode='P0001',message='v78_rollback_definition_tamper';
  end if;
end $v78_rollback_preflight$;
drop function if exists public.publish_provider_attempt_settle_v78(uuid,uuid,uuid,text,integer,text,text,jsonb);
drop function if exists public.publish_asset_ready_sources_v78(uuid,text,text);
drop function if exists public.publish_asset_claim_ready_v78(uuid,text,text,uuid);
drop function if exists public.publish_intent_confirm_prepare_v78(uuid,jsonb,text);
do $v78_rollback_postflight$
begin
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in (
      'publish_intent_confirm_prepare_v78','publish_asset_claim_ready_v78',
      'publish_asset_ready_sources_v78','publish_provider_attempt_settle_v78')) then
    raise exception using errcode='P0001',message='v78_rollback_definition_tamper';
  end if;
end $v78_rollback_postflight$;
notify pgrst,'reload schema';
commit;
