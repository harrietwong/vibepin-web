-- v81 rollback removes only the additive rich-evidence settlement wrapper.
begin;
do $v81_rollback_preflight$
declare
  v_table regclass;
  v_marker text;
begin
  if to_regprocedure('public.publish_provider_attempt_settle_v81(uuid,uuid,uuid,text,integer,text,text,jsonb)') is not null
     and obj_description(
       'public.publish_provider_attempt_settle_v81(uuid,uuid,uuid,text,integer,text,text,jsonb)'::regprocedure,
       'pg_proc'
     ) is distinct from 'vibepin:v81:pinterest-publish-evidence' then
    raise exception using errcode='P0001', message='v81_rollback_collision';
  end if;
  v_table := to_regclass('public.pinterest_publish_evidence');
  if v_table is not null then
    select obj_description(v_table, 'pg_class') into v_marker;
    if v_marker is distinct from 'vibepin:v81:pinterest-publish-evidence' then
      raise exception using errcode='P0001', message='v81_rollback_collision';
    end if;
  end if;
end $v81_rollback_preflight$;
revoke all on function public.publish_provider_attempt_settle_v81(uuid,uuid,uuid,text,integer,text,text,jsonb)
  from public,anon,authenticated,service_role;
drop function if exists public.publish_provider_attempt_settle_v81(uuid,uuid,uuid,text,integer,text,text,jsonb);
drop table if exists public.pinterest_publish_evidence;
notify pgrst,'reload schema';
commit;
