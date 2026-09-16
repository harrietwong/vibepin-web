-- v79: bridge v77's verified video provenance contract into the v76/v78
-- materialization ledger without replacing any reviewed v76-v78 entry point.
begin;

do $v79_preflight$
declare
  v_oid oid;
  v_proc pg_proc%rowtype;
  v_function_count integer;
  v_expected record;
  v_type text;
  v_not_null boolean;
  v_default text;
  v_column_acl boolean;
  v_definition text;
  v_grantee text;
  v_privilege text;
  v_actual boolean;
begin
  v_oid:=to_regprocedure('public.publish_asset_settle_item(uuid,text,text,uuid,text,integer,text,text,text,bigint,text)');
  if v_oid is null or obj_description(v_oid,'pg_proc') is distinct from 'vibepin:v76:publish-asset-settle-item' then
    raise exception using errcode='P0001',message='v79_v76_dependency_tamper';
  end if;
  select * into v_proc from pg_proc where oid=v_oid;
  if not v_proc.prosecdef or v_proc.prokind<>'f' or v_proc.prorettype<>to_regtype('jsonb')
     or v_proc.proretset or v_proc.provariadic<>0
     or v_proc.prolang<>(select oid from pg_language where lanname='plpgsql')
     or v_proc.proconfig is distinct from array['search_path=public, pg_temp']::text[]
     or md5(replace(replace(v_proc.prosrc,chr(13)||chr(10),chr(10)),chr(13),chr(10)))<>'40eaf43cd16a15f2af82238ec35d32d8' then
    raise exception using errcode='P0001',message='v79_v76_dependency_tamper';
  end if;

  if to_regclass('public.media_asset_provenance') is null
     or not (select relrowsecurity from pg_class where oid='public.media_asset_provenance'::regclass) then
    raise exception using errcode='P0001',message='v79_v77_dependency_tamper';
  end if;
  for v_expected in select * from (values
    ('owner_user_id','uuid',true,null::text),('bucket_id','text',true,null::text),
    ('object_path','text',true,null::text),('source_type','text',true,null::text),
    ('intent_id','text',false,null::text),('lifecycle_state','text',true,'''draft''::text'),
    ('media_kind','text',true,'''image''::text'),('content_type','text',false,null::text),
    ('byte_size','bigint',false,null::text),('checksum_sha256','text',false,null::text),
    ('width','integer',false,null::text),('height','integer',false,null::text),
    ('duration_ms','bigint',false,null::text),('content_type_source','text',false,null::text),
    ('byte_size_source','text',false,null::text),('checksum_source','text',false,null::text),
    ('dimensions_source','text',false,null::text),('duration_source','text',false,null::text)
  ) expected(name,type_name,not_null,default_value) loop
    select format_type(a.atttypid,a.atttypmod),a.attnotnull,pg_get_expr(d.adbin,d.adrelid),a.attacl is not null
      into v_type,v_not_null,v_default,v_column_acl
      from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
     where a.attrelid='public.media_asset_provenance'::regclass and a.attname=v_expected.name
       and a.attnum>0 and not a.attisdropped;
    if not found or v_type is distinct from v_expected.type_name or v_not_null is distinct from v_expected.not_null
       or v_default is distinct from v_expected.default_value or v_column_acl then
      raise exception using errcode='P0001',message='v79_v77_dependency_tamper';
    end if;
  end loop;
  for v_expected in select * from (values
    ('media_asset_provenance_media_kind_check','CHECK ((media_kind = ANY (ARRAY[''image''::text, ''video''::text])))'),
    ('media_asset_provenance_video_fact_sources_check','CHECK ((((media_kind <> ''video''::text) OR ((content_type_source = ''storage_head_verified''::text) AND (byte_size_source = ''storage_head_verified''::text) AND (checksum_source = ANY (ARRAY[''storage_digest_verified''::text, ''unavailable''::text])) AND (dimensions_source = ''browser_declared''::text) AND (duration_source = ''browser_declared''::text) AND (((checksum_source = ''unavailable''::text) AND (checksum_sha256 IS NULL)) OR ((checksum_source = ''storage_digest_verified''::text) AND (checksum_sha256 ~ ''^[0-9a-f]{64}$''::text))) AND (width > 0) AND (height > 0) AND ((duration_ms >= 4000) AND (duration_ms <= 300000)))) IS TRUE))')
  ) expected(name,definition) loop
    select pg_get_constraintdef(oid) into v_definition from pg_constraint
     where conrelid='public.media_asset_provenance'::regclass and conname=v_expected.name;
    if not found or v_definition is distinct from v_expected.definition then
      raise exception using errcode='P0001',message='v79_v77_dependency_tamper';
    end if;
  end loop;
  foreach v_grantee in array array['anon','authenticated','service_role'] loop
    foreach v_privilege in array array['SELECT','INSERT','UPDATE','DELETE'] loop
      v_actual:=has_table_privilege(v_grantee,'public.media_asset_provenance',v_privilege);
      if v_actual is distinct from (v_grantee='service_role' or (v_grantee='authenticated' and v_privilege='SELECT'))
         or has_table_privilege(v_grantee,'public.media_asset_provenance',v_privilege||' WITH GRANT OPTION') then
        raise exception using errcode='P0001',message='v79_v77_dependency_tamper';
      end if;
    end loop;
  end loop;

  select count(*) into v_function_count from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='publish_asset_settle_video_item_v79';
  if v_function_count not in (0,1) or exists (
    select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public' and p.proname='publish_asset_settle_video_item_v79'
       and p.oid is distinct from to_regprocedure('public.publish_asset_settle_video_item_v79(uuid,text,text,uuid,text,integer,text,text,text,text,text)')
  ) then raise exception using errcode='P0001',message='v79_definition_tamper'; end if;
  if v_function_count=1 then
    v_oid:=to_regprocedure('public.publish_asset_settle_video_item_v79(uuid,text,text,uuid,text,integer,text,text,text,text,text)');
    select * into v_proc from pg_proc where oid=v_oid;
    if obj_description(v_oid,'pg_proc') is distinct from 'vibepin:v79:publish-asset-settle-video-item'
       or not v_proc.prosecdef or v_proc.prokind<>'f' or v_proc.prorettype<>to_regtype('jsonb')
       or v_proc.proretset or v_proc.provariadic<>0
       or v_proc.prolang<>(select oid from pg_language where lanname='plpgsql')
       or v_proc.proconfig is distinct from array['search_path=public, pg_temp']::text[]
       or md5(replace(replace(v_proc.prosrc,chr(13)||chr(10),chr(10)),chr(13),chr(10)))<>'87d828fa136c11c7d2c25417ed1b6378' then
      raise exception using errcode='P0001',message='v79_definition_tamper';
    end if;
    foreach v_grantee in array array['anon','authenticated','service_role'] loop
      v_actual:=has_function_privilege(v_grantee,v_oid,'EXECUTE');
      if v_actual is distinct from (v_grantee='service_role')
         or has_function_privilege(v_grantee,v_oid,'EXECUTE WITH GRANT OPTION') then
        raise exception using errcode='P0001',message='v79_definition_tamper';
      end if;
    end loop;
    if exists (select 1 from aclexplode(coalesce(v_proc.proacl,acldefault('f',v_proc.proowner))) acl
      where acl.privilege_type<>'EXECUTE'
         or acl.grantee not in (v_proc.proowner,(select oid from pg_roles where rolname='service_role'))
         or (acl.grantee=(select oid from pg_roles where rolname='service_role') and acl.is_grantable)) then
      raise exception using errcode='P0001',message='v79_definition_tamper';
    end if;
  end if;
end $v79_preflight$;

create or replace function public.publish_asset_settle_video_item_v79(
  p_user_id uuid,p_intent_id text,p_destination_id text,p_lease_token uuid,
  p_source_media_key text,p_media_ordinal integer,
  p_source_bucket_id text,p_source_object_path text,
  p_target_bucket_id text,p_target_object_path text,p_server_checksum_sha256 text
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $fn$
-- vibepin:v79:publish-asset-settle-video-item
declare
  v_source public.media_asset_provenance%rowtype;
  v_target public.media_asset_provenance%rowtype;
  v_result jsonb;
begin
  if p_user_id is null or p_lease_token is null or p_media_ordinal is null or p_media_ordinal<0
     or nullif(btrim(coalesce(p_intent_id,'')),'') is null
     or nullif(btrim(coalesce(p_destination_id,'')),'') is null
     or nullif(btrim(coalesce(p_source_media_key,'')),'') is null then
    raise exception using errcode='22023',message='invalid_video_materialization_identity';
  end if;
  if p_source_bucket_id is distinct from 'generated-private'
     or p_target_bucket_id is distinct from 'generated-private' then
    raise exception using errcode='22023',message='invalid_bucket_id';
  end if;
  -- This RPC is service-role-only. The runtime computes this digest from the
  -- authenticated private download; browsers cannot submit it to this boundary.
  if coalesce(p_server_checksum_sha256,'') !~ '^[0-9a-f]{64}$' then
    raise exception using errcode='22023',message='invalid_server_checksum';
  end if;
  if coalesce(p_source_object_path,'') !~ '^[A-Za-z0-9_-]+(/[A-Za-z0-9_-][A-Za-z0-9:._-]*)+$'
     or length(p_source_object_path)>1024 or p_source_object_path like '%..%'
     or split_part(p_source_object_path,'/',1) is distinct from p_user_id::text
     or regexp_replace(lower(p_source_object_path),'[^a-z0-9]','','g') ~ '(token|signature|credential|cookie|auth|bearer|secret|apikey|accesskey|privatekey|password|passwd|session)'
     or p_source_object_path ~* '(^|[^a-z0-9])sig([^a-z0-9]|$)' then
    raise exception using errcode='22023',message='invalid_source_object_path';
  end if;
  if coalesce(p_target_object_path,'') !~ '^[A-Za-z0-9_-]+/publish(/[A-Za-z0-9_-][A-Za-z0-9:._-]*)+$'
     or length(p_target_object_path)>1024 or p_target_object_path like '%..%'
     or split_part(p_target_object_path,'/',1) is distinct from p_user_id::text
     or regexp_replace(lower(p_target_object_path),'[^a-z0-9]','','g') ~ '(token|signature|credential|cookie|auth|bearer|secret|apikey|accesskey|privatekey|password|passwd|session)'
     or p_target_object_path ~* '(^|[^a-z0-9])sig([^a-z0-9]|$)' then
    raise exception using errcode='22023',message='invalid_target_object_path';
  end if;

  perform 1 from storage.buckets where id=p_source_bucket_id and public=false for share;
  if not found then
    raise exception using errcode='22023',message='invalid_bucket_id';
  end if;
  select * into v_source from public.media_asset_provenance provenance
   where provenance.owner_user_id=p_user_id
     and provenance.bucket_id=p_source_bucket_id and provenance.object_path=p_source_object_path
     and provenance.source_type='upload'
     and provenance.lifecycle_state in ('draft','publish_pending','published','retained')
     and provenance.media_kind='video'
     and provenance.content_type in ('video/mp4','video/x-m4v','video/quicktime')
     and provenance.byte_size between 1 and 104857600
     -- A provider-verified source digest must match. If v77 recorded
     -- "unavailable", the private download digest becomes the frozen copy's
     -- verified digest without rewriting the historical source row.
     and ((provenance.checksum_source='storage_digest_verified'
           and provenance.checksum_sha256=p_server_checksum_sha256)
       or (provenance.checksum_source='unavailable' and provenance.checksum_sha256 is null))
     and provenance.width>0 and provenance.height>0
     and provenance.duration_ms between 4000 and 300000
     and provenance.content_type_source='storage_head_verified'
     and provenance.byte_size_source='storage_head_verified'
     and provenance.dimensions_source='browser_declared'
     and provenance.duration_source='browser_declared'
   for share;
  if not found then
    raise exception using errcode='22023',message='video_source_provenance_required';
  end if;

  insert into public.media_asset_provenance(
    owner_user_id,bucket_id,object_path,source_type,intent_id,lifecycle_state,media_kind,
    content_type,byte_size,checksum_sha256,width,height,duration_ms,
    content_type_source,byte_size_source,checksum_source,dimensions_source,duration_source,updated_at
  ) values (
    p_user_id,p_target_bucket_id,p_target_object_path,'publish_copy',p_intent_id,'publish_pending','video',
    v_source.content_type,v_source.byte_size,p_server_checksum_sha256,v_source.width,v_source.height,v_source.duration_ms,
    v_source.content_type_source,v_source.byte_size_source,'storage_digest_verified',
    v_source.dimensions_source,v_source.duration_source,now()
  ) on conflict(bucket_id,object_path) do nothing;

  select * into v_target from public.media_asset_provenance provenance
   where provenance.bucket_id=p_target_bucket_id and provenance.object_path=p_target_object_path
   for share;
  if not found or v_target.owner_user_id is distinct from p_user_id
     or v_target.source_type is distinct from 'publish_copy'
     or v_target.intent_id is distinct from p_intent_id
     or v_target.lifecycle_state is distinct from 'publish_pending'
     or v_target.media_kind is distinct from 'video'
     or v_target.content_type is distinct from v_source.content_type
     or v_target.byte_size is distinct from v_source.byte_size
     or v_target.checksum_sha256 is distinct from p_server_checksum_sha256
     or v_target.width is distinct from v_source.width or v_target.height is distinct from v_source.height
     or v_target.duration_ms is distinct from v_source.duration_ms
     or v_target.content_type_source is distinct from v_source.content_type_source
     or v_target.byte_size_source is distinct from v_source.byte_size_source
     or v_target.checksum_source is distinct from 'storage_digest_verified'
     or v_target.dimensions_source is distinct from v_source.dimensions_source
     or v_target.duration_source is distinct from v_source.duration_source then
    raise exception using errcode='23505',message='materialized_asset_conflict';
  end if;

  v_result:=public.publish_asset_settle_item(
    p_user_id,p_intent_id,p_destination_id,p_lease_token,p_source_media_key,p_media_ordinal,
    p_target_bucket_id,p_target_object_path,v_source.content_type,v_source.byte_size,p_server_checksum_sha256
  );
  return v_result;
exception when others then
  raise exception using errcode=sqlstate,message=case sqlerrm
    when 'invalid_video_materialization_identity' then 'invalid_video_materialization_identity'
    when 'invalid_bucket_id' then 'invalid_bucket_id'
    when 'invalid_server_checksum' then 'invalid_server_checksum'
    when 'invalid_source_object_path' then 'invalid_source_object_path'
    when 'invalid_target_object_path' then 'invalid_target_object_path'
    when 'video_source_provenance_required' then 'video_source_provenance_required'
    when 'materialized_asset_conflict' then 'materialized_asset_conflict'
    when 'invalid_source_media_key' then 'invalid_source_media_key'
    when 'invalid_content_type' then 'invalid_content_type'
    when 'materialization_provenance_required' then 'materialization_provenance_required'
    when 'invalid_object_path' then 'invalid_object_path'
    when 'invalid_materialization_item' then 'invalid_materialization_item'
    when 'publish_intent_not_found' then 'publish_intent_not_found'
    when 'materialization_lease_lost' then 'materialization_lease_lost'
    when 'materialization_item_not_found' then 'materialization_item_not_found'
    when 'materialization_required' then 'materialization_required'
    else 'v79_rpc_error' end;
end $fn$;

comment on function public.publish_asset_settle_video_item_v79(uuid,text,text,uuid,text,integer,text,text,text,text,text)
  is 'vibepin:v79:publish-asset-settle-video-item';
revoke all on function public.publish_asset_settle_video_item_v79(uuid,text,text,uuid,text,integer,text,text,text,text,text)
  from public,anon,authenticated,service_role;
grant execute on function public.publish_asset_settle_video_item_v79(uuid,text,text,uuid,text,integer,text,text,text,text,text)
  to service_role;

do $v79_postflight$
declare v_oid oid; v_proc pg_proc%rowtype; v_grantee text; v_actual boolean;
begin
  if (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and p.proname='publish_asset_settle_video_item_v79')<>1 then
    raise exception using errcode='P0001',message='v79_definition_tamper';
  end if;
  v_oid:=to_regprocedure('public.publish_asset_settle_video_item_v79(uuid,text,text,uuid,text,integer,text,text,text,text,text)');
  select * into v_proc from pg_proc where oid=v_oid;
  if v_oid is null or obj_description(v_oid,'pg_proc') is distinct from 'vibepin:v79:publish-asset-settle-video-item'
     or not v_proc.prosecdef or v_proc.prokind<>'f' or v_proc.prorettype<>to_regtype('jsonb')
     or v_proc.proretset or v_proc.provariadic<>0
     or v_proc.prolang<>(select oid from pg_language where lanname='plpgsql')
     or v_proc.proconfig is distinct from array['search_path=public, pg_temp']::text[]
     or md5(replace(replace(v_proc.prosrc,chr(13)||chr(10),chr(10)),chr(13),chr(10)))<>'87d828fa136c11c7d2c25417ed1b6378' then
    raise exception using errcode='P0001',message='v79_definition_tamper';
  end if;
  foreach v_grantee in array array['anon','authenticated','service_role'] loop
    v_actual:=has_function_privilege(v_grantee,v_oid,'EXECUTE');
    if v_actual is distinct from (v_grantee='service_role')
       or has_function_privilege(v_grantee,v_oid,'EXECUTE WITH GRANT OPTION') then
      raise exception using errcode='P0001',message='v79_definition_tamper';
    end if;
  end loop;
  if exists (select 1 from aclexplode(coalesce(v_proc.proacl,acldefault('f',v_proc.proowner))) acl
    where acl.privilege_type<>'EXECUTE'
       or acl.grantee not in (v_proc.proowner,(select oid from pg_roles where rolname='service_role'))
       or (acl.grantee=(select oid from pg_roles where rolname='service_role') and acl.is_grantable)) then
    raise exception using errcode='P0001',message='v79_definition_tamper';
  end if;
end $v79_postflight$;

notify pgrst,'reload schema';
commit;
