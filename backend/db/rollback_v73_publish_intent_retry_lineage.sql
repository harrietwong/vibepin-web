-- v73 rollback is safe only before any retry lineage has been recorded.
begin;

do $$
begin
  if exists (select 1 from publish_intents where prior_intent_id is not null)
     or exists (select 1 from publish_intent_destinations where retry_of_destination_id is not null) then
    raise exception 'Refusing v73 rollback: retry lineage exists';
  end if;
end $$;

drop function if exists publish_intent_activate_retry_destinations(uuid,text,text,jsonb);
drop function if exists publish_intent_reserve_retry_destinations(uuid,text,text,text,text,text,timestamptz,jsonb,jsonb,jsonb);
drop trigger if exists publish_intent_reject_legacy_retry_trigger on publish_intent_destinations;
drop function if exists publish_intent_reject_legacy_retry();
drop index if exists publish_intent_destinations_retry_source_unique;
drop index if exists publish_intents_prior_intent_idx;
alter table publish_intent_destinations drop column if exists retry_of_destination_id;
alter table publish_intents drop column if exists prior_intent_id;

notify pgrst, 'reload schema';
commit;
