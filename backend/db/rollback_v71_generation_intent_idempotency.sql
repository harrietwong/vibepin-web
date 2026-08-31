-- Roll back v71 generation intent idempotency on an explicitly authorized
-- non-production project. Removes only the additive v71 schema surface.
begin;
drop function if exists usage_reserve_generation_job_v2(
  uuid, text[], text, text, text, jsonb, text, text, timestamptz, jsonb, boolean
);
drop function if exists generation_enqueue_job_idempotent(uuid, text, text, text[], jsonb, boolean);
drop function if exists generation_lookup_job_by_intent(uuid, text, text);
drop trigger if exists generation_jobs_intent_immutable_trigger on generation_jobs;
drop function if exists generation_jobs_intent_immutable();
drop index if exists generation_jobs_intent_lookup;
drop index if exists generation_jobs_user_intent_unique;
alter table generation_jobs drop constraint if exists generation_jobs_intent_pair_valid;
alter table generation_jobs drop column if exists generation_intent_fingerprint;
alter table generation_jobs drop column if exists generation_intent_key;
notify pgrst, 'reload schema';
commit;
