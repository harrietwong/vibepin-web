-- v80 rollback removes only the additive poster association capability.
begin;
do $v80_rollback_preflight$
begin
  if to_regclass('public.video_poster_operations') is not null
     and obj_description('public.video_poster_operations'::regclass, 'pg_class') is distinct from 'vibepin:v80:video-poster-operations' then
    raise exception using errcode='P0001', message='v80_rollback_collision';
  end if;
end $v80_rollback_preflight$;
revoke all on function public.video_poster_operation_associate(uuid,uuid,integer,text,text) from public, anon, authenticated, service_role;
revoke all on function public.video_poster_operation_retain(uuid,uuid,integer,text,text) from public, anon, authenticated, service_role;
revoke all on function public.video_poster_cleanup_authorize(uuid,text,text) from public, anon, authenticated, service_role;
drop function if exists public.video_poster_operation_associate(uuid,uuid,integer,text,text);
drop function if exists public.video_poster_operation_retain(uuid,uuid,integer,text,text);
drop function if exists public.video_poster_cleanup_authorize(uuid,text,text);
drop table if exists public.video_poster_operations;
notify pgrst,'reload schema';
commit;
