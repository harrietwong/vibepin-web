-- v72 rollback is intentionally data-safe: remove the durable ledger only before use.
begin;
do $$
declare v_job_receipts boolean := false;
begin
  if to_regclass('public.publish_intents') is not null
     and exists (select 1 from publish_intents limit 1) then
    raise exception 'Refusing v72 rollback: durable publish intent receipts exist';
  end if;
  if to_regclass('public.social_publish_jobs') is not null
     and exists (
       select 1 from information_schema.columns
       where table_schema = 'public'
         and table_name = 'social_publish_jobs'
         and column_name in ('publish_intent_id','publish_intent_fingerprint')
       group by table_schema, table_name
       having count(*) = 2
     ) then
    execute 'select exists (select 1 from public.social_publish_jobs where publish_intent_id is not null or publish_intent_fingerprint is not null)'
      into v_job_receipts;
    if v_job_receipts then
      raise exception 'Refusing v72 rollback: social publish job intent evidence exists';
    end if;
  end if;
end $$;
drop function if exists publish_intent_settle_destination(uuid,text,text,uuid,text,boolean,text,text,text,integer,jsonb);
drop function if exists publish_intent_claim_destinations(uuid,text,text,text,text,timestamptz,jsonb,jsonb,jsonb);
drop function if exists publish_intent_claim_destination(uuid,text,text,text,text,timestamptz,jsonb,jsonb,text,text,text,text);
drop table if exists publish_intent_destinations;
drop table if exists publish_intents;
drop index if exists social_publish_job_destinations_exact_unique;
drop index if exists social_publish_job_destinations_null_connection_unique;
drop index if exists social_publish_jobs_user_publish_intent_unique;
alter table if exists social_publish_jobs drop column if exists publish_intent_fingerprint;
alter table if exists social_publish_jobs drop column if exists publish_intent_id;
notify pgrst, 'reload schema';
commit;
