-- Safe v77 rollback: retain private upload evidence and schema, revoke writes,
-- and restore v76's original image-only MIME guard for a clean v76 reapply.
begin;
do $v77_rollback_preflight$
declare v_name text;
begin
  foreach v_name in array array['video_upload_batches','video_upload_items'] loop
    if to_regclass('public.' || v_name) is not null
       and obj_description(to_regclass('public.' || v_name), 'pg_class') is distinct from 'vibepin:v77:' || replace(v_name, '_', '-') then
      raise exception using errcode='P0001',message='v77_rollback_collision';
    end if;
  end loop;
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
revoke all on public.video_upload_batches,public.video_upload_items from public,anon,authenticated,service_role;
grant select on public.video_upload_batches,public.video_upload_items to service_role;
revoke all on function public.video_upload_batch_prepare(uuid,text,timestamptz) from public,anon,authenticated,service_role;
revoke all on function public.video_upload_item_prepare(uuid,uuid,integer,text,text,text,bigint,text,integer,integer,bigint) from public,anon,authenticated,service_role;
revoke all on function public.video_upload_item_claim(uuid,uuid,integer,uuid,timestamptz) from public,anon,authenticated,service_role;
revoke all on function public.video_upload_item_finalize(uuid,uuid,integer,uuid,text,text,bigint,text) from public,anon,authenticated,service_role;
revoke all on function public.video_upload_item_fail(uuid,uuid,integer,uuid,text) from public,anon,authenticated,service_role;
notify pgrst,'reload schema';
commit;
