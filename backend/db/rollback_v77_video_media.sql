-- Safe v77 rollback: retain private upload evidence and schema, revoke writes,
-- and restore v76's original image-only MIME guard for a clean v76 reapply.
begin;
do $v77_rollback_preflight$
declare v_name text; v_type text; v_not_null boolean; v_actual boolean; v_definition text; v_proc pg_proc%rowtype;
begin
  foreach v_name in array array['video_upload_batches','video_upload_items'] loop
    if to_regclass('public.' || v_name) is not null
       and obj_description(to_regclass('public.' || v_name), 'pg_class') is distinct from 'vibepin:v77:' || replace(v_name, '_', '-') then
      raise exception using errcode='P0001',message='v77_rollback_collision';
    end if;
  end loop;
  if to_regclass('public.video_upload_items') is not null then
    foreach v_name in array array['capability_expires_at','late_upload_recheck_after'] loop
      select format_type(a.atttypid,a.atttypmod),a.attnotnull into v_type,v_not_null
        from pg_attribute a where a.attrelid='public.video_upload_items'::regclass
          and a.attname=v_name and a.attnum>0 and not a.attisdropped;
      if not found or v_type is distinct from 'timestamp with time zone' or not v_not_null then
        raise exception using errcode='P0001',message='v77_rollback_collision';
      end if;
    end loop;
    select pg_get_constraintdef(oid) into v_definition from pg_constraint
      where conrelid='public.video_upload_items'::regclass and conname='video_upload_items_late_recheck_check';
    if not found or v_definition is distinct from 'CHECK ((late_upload_recheck_after = (capability_expires_at + ''00:20:00''::interval)))' then
      raise exception using errcode='P0001',message='v77_rollback_collision';
    end if;
  end if;
  select pg_get_constraintdef(oid) into v_definition from pg_constraint
    where conrelid=to_regclass('public.media_asset_provenance') and conname='media_asset_provenance_video_fact_sources_check';
  if not found or v_definition is distinct from 'CHECK ((((media_kind <> ''video''::text) OR ((content_type_source = ''storage_head_verified''::text) AND (byte_size_source = ''storage_head_verified''::text) AND (checksum_source = ANY (ARRAY[''storage_digest_verified''::text, ''unavailable''::text])) AND (dimensions_source = ''browser_declared''::text) AND (duration_source = ''browser_declared''::text) AND (((checksum_source = ''unavailable''::text) AND (checksum_sha256 IS NULL)) OR ((checksum_source = ''storage_digest_verified''::text) AND (checksum_sha256 ~ ''^[0-9a-f]{64}$''::text))) AND (width > 0) AND (height > 0) AND ((duration_ms >= 4000) AND (duration_ms <= 300000)))) IS TRUE))' then
    raise exception using errcode='P0001',message='v77_rollback_collision';
  end if;
  if to_regprocedure('public.v77_video_cleanup_guard()') is not null then
    select * into v_proc from pg_proc where oid=to_regprocedure('public.v77_video_cleanup_guard()');
    if obj_description(v_proc.oid,'pg_proc') is distinct from 'vibepin:v77:video-cleanup-guard'
       or not v_proc.prosecdef or v_proc.prorettype<>to_regtype('trigger')
       or md5(replace(replace(v_proc.prosrc,chr(13)||chr(10),chr(10)),chr(13),chr(10)))<>'4024c51379966b96cc60a0d093575e19' then
      raise exception using errcode='P0001',message='v77_rollback_collision';
    end if;
  end if;
  select count(*)=1 into v_actual from pg_trigger t where t.tgrelid=to_regclass('public.media_cleanup_outbox')
    and t.tgname='v77_video_cleanup_guard' and not t.tgisinternal
    and t.tgfoid=to_regprocedure('public.v77_video_cleanup_guard()') and t.tgenabled='O' and t.tgtype=19;
  if (to_regprocedure('public.v77_video_cleanup_guard()') is null) is distinct from (not v_actual) then
    raise exception using errcode='P0001',message='v77_rollback_collision';
  end if;
end $v77_rollback_preflight$;
do $v77_restore_v76_mime$
declare v_signature text; v_definition text; v_marker text; v_hash text; v_proc pg_proc%rowtype; v_old text := '(''image/png'',''image/jpeg'',''image/webp'',''video/mp4'',''video/x-m4v'',''video/quicktime'')'; v_new text := '(''image/png'',''image/jpeg'',''image/webp'')';
begin
  for v_signature,v_marker,v_hash in select * from (values
    ('public.publish_asset_settle_materialization(uuid,text,text,uuid,text,text,text,text,bigint,text,text)','vibepin:v76:publish-asset-settle-materialization','05aeaf68837a95a5cdc6177383ee6092'),
    ('public.publish_asset_settle_item(uuid,text,text,uuid,text,integer,text,text,text,bigint,text)','vibepin:v76:publish-asset-settle-item','a05aef6619c3ec795b6ceee080e04843')
  ) expected(signature,marker,body_hash) loop
    if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname=split_part(replace(v_signature,'public.',''),'(',1)
        and p.oid is distinct from to_regprocedure(v_signature)) then raise exception using errcode='P0001',message='v77_rollback_collision'; end if;
    select * into v_proc from pg_proc where oid=to_regprocedure(v_signature);
    select pg_get_functiondef(to_regprocedure(v_signature)) into v_definition;
    if v_definition is null or obj_description(to_regprocedure(v_signature),'pg_proc') is distinct from v_marker
       or not v_proc.prosecdef or v_proc.prokind<>'f' or v_proc.prorettype<>to_regtype('jsonb')
       or v_proc.proretset or v_proc.provariadic<>0 or v_proc.prolang<>(select oid from pg_language where lanname='plpgsql')
       or v_proc.proconfig is distinct from array['search_path=public, pg_temp']::text[]
       or md5(replace(replace(replace(v_proc.prosrc,v_old,v_new),chr(13)||chr(10),chr(10)),chr(13),chr(10)))<>v_hash then
      raise exception using errcode='P0001',message='v77_rollback_collision';
    end if;
    if position(v_old in v_definition)>0 then execute replace(v_definition,v_old,v_new);
    elsif position(v_new in v_definition)=0 then raise exception using errcode='P0001',message='v77_rollback_collision'; end if;
  end loop;
end $v77_restore_v76_mime$;
drop trigger if exists v77_video_cleanup_guard on public.media_cleanup_outbox;
drop function if exists public.v77_video_cleanup_guard();
revoke all on public.video_upload_batches,public.video_upload_items from public,anon,authenticated,service_role;
grant select on public.video_upload_batches,public.video_upload_items to service_role;
revoke all on function public.video_upload_batch_prepare(uuid,text,timestamptz) from public,anon,authenticated,service_role;
revoke all on function public.video_upload_item_prepare(uuid,uuid,integer,text,text,text,bigint,text,integer,integer,bigint) from public,anon,authenticated,service_role;
revoke all on function public.video_upload_capability_confirm(uuid,uuid,integer,timestamptz) from public,anon,authenticated,service_role;
revoke all on function public.video_upload_item_claim(uuid,uuid,integer,uuid,timestamptz) from public,anon,authenticated,service_role;
revoke all on function public.video_upload_item_finalize(uuid,uuid,integer,uuid,text,text,bigint,text) from public,anon,authenticated,service_role;
revoke all on function public.video_upload_item_fail(uuid,uuid,integer,uuid,text) from public,anon,authenticated,service_role;
notify pgrst,'reload schema';
commit;
