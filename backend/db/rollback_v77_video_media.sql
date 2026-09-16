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
declare v_signature text; v_definition text; v_old text := '(''image/png'',''image/jpeg'',''image/webp'',''video/mp4'',''video/x-m4v'',''video/quicktime'')'; v_new text := '(''image/png'',''image/jpeg'',''image/webp'')';
begin
  foreach v_signature in array array[
    'public.publish_asset_settle_materialization(uuid,text,text,uuid,text,text,text,text,bigint,text,text)',
    'public.publish_asset_settle_item(uuid,text,text,uuid,text,integer,text,text,text,bigint,text)'
  ] loop
    select pg_get_functiondef(to_regprocedure(v_signature)) into v_definition;
    if v_definition is null or obj_description(to_regprocedure(v_signature),'pg_proc') !~ '^vibepin:v76:' then raise exception using errcode='P0001',message='v77_rollback_collision'; end if;
    if position(v_old in v_definition)>0 then execute replace(v_definition,v_old,v_new);
    elsif position(v_new in v_definition)=0 then raise exception using errcode='P0001',message='v77_rollback_collision'; end if;
  end loop;
end $v77_restore_v76_mime$;
revoke all on public.video_upload_batches,public.video_upload_items from public,anon,authenticated,service_role;
grant select on public.video_upload_batches,public.video_upload_items to service_role;
revoke all on function public.video_upload_batch_prepare(uuid,text,timestamptz) from public,anon,authenticated,service_role;
revoke all on function public.video_upload_item_prepare(uuid,uuid,integer,text,text,text,bigint,text,integer,integer,bigint) from public,anon,authenticated,service_role;
revoke all on function public.video_upload_item_finalize(uuid,uuid,integer,text,bigint,text,integer,integer,bigint) from public,anon,authenticated,service_role;
notify pgrst,'reload schema';
commit;
