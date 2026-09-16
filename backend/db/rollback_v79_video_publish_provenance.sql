-- v79 rollback removes only its versioned service-role RPC. Frozen provenance
-- rows remain durable historical evidence and v76-v78 are left untouched.
begin;
do $v79_rollback_preflight$
declare v_oid oid; v_proc pg_proc%rowtype; v_function_count integer; v_grantee text; v_actual boolean;
begin
  select count(*) into v_function_count from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='publish_asset_settle_video_item_v79';
  if v_function_count not in (0,1) or exists (
    select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public' and p.proname='publish_asset_settle_video_item_v79'
       and p.oid is distinct from to_regprocedure('public.publish_asset_settle_video_item_v79(uuid,text,text,uuid,text,integer,text,text,text,text,text)')
  ) then raise exception using errcode='P0001',message='v79_rollback_definition_tamper'; end if;
  if v_function_count=1 then
    v_oid:=to_regprocedure('public.publish_asset_settle_video_item_v79(uuid,text,text,uuid,text,integer,text,text,text,text,text)');
    select * into v_proc from pg_proc where oid=v_oid;
    if obj_description(v_oid,'pg_proc') is distinct from 'vibepin:v79:publish-asset-settle-video-item'
       or not v_proc.prosecdef or v_proc.prokind<>'f' or v_proc.prorettype<>to_regtype('jsonb')
       or v_proc.proretset or v_proc.provariadic<>0
       or v_proc.prolang<>(select oid from pg_language where lanname='plpgsql')
       or v_proc.proconfig is distinct from array['search_path=public, pg_temp']::text[]
       or md5(replace(replace(v_proc.prosrc,chr(13)||chr(10),chr(10)),chr(13),chr(10)))<>'87d828fa136c11c7d2c25417ed1b6378' then
      raise exception using errcode='P0001',message='v79_rollback_definition_tamper';
    end if;
    foreach v_grantee in array array['anon','authenticated','service_role'] loop
      v_actual:=has_function_privilege(v_grantee,v_oid,'EXECUTE');
      if v_actual is distinct from (v_grantee='service_role')
         or has_function_privilege(v_grantee,v_oid,'EXECUTE WITH GRANT OPTION') then
        raise exception using errcode='P0001',message='v79_rollback_definition_tamper';
      end if;
    end loop;
    if exists (select 1 from aclexplode(coalesce(v_proc.proacl,acldefault('f',v_proc.proowner))) acl
      where acl.privilege_type<>'EXECUTE'
         or acl.grantee not in (v_proc.proowner,(select oid from pg_roles where rolname='service_role'))
         or (acl.grantee=(select oid from pg_roles where rolname='service_role') and acl.is_grantable)) then
      raise exception using errcode='P0001',message='v79_rollback_definition_tamper';
    end if;
  end if;
end $v79_rollback_preflight$;
drop function if exists public.publish_asset_settle_video_item_v79(uuid,text,text,uuid,text,integer,text,text,text,text,text);
do $v79_rollback_postflight$
begin
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='publish_asset_settle_video_item_v79') then
    raise exception using errcode='P0001',message='v79_rollback_definition_tamper';
  end if;
end $v79_rollback_postflight$;
notify pgrst,'reload schema';
commit;
