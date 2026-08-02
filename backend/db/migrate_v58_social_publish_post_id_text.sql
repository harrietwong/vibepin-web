-- Migration v58: social_publish_jobs.post_id → text
--
-- WHY
-- v32 declared post_id as uuid, but the id it actually receives is a client draft
-- id (e.g. "pin_1780125033_1"), not a uuid. Every insert therefore failed with
-- 22P02 (invalid input syntax for type uuid) — silently, because the publish route
-- logs persistence errors without failing the publish. The post really was
-- published to the platform; only the record of it was lost, so "View on Facebook"
-- vanished on reload and the destinations table stayed empty.
--
-- Widening uuid → text is lossless: every uuid is a valid text value, and the
-- column is nullable with no FK, no index, and (verified) no rows. Nothing else
-- references it.
--
-- Idempotent: the ALTER is guarded on the column still being uuid, so re-running
-- is a no-op.

do $$
begin
  if exists (
    select 1
      from information_schema.columns
     where table_schema = 'public'
       and table_name   = 'social_publish_jobs'
       and column_name  = 'post_id'
       and data_type    = 'uuid'
  ) then
    alter table social_publish_jobs
      alter column post_id type text using post_id::text;
  end if;
end $$;

comment on column social_publish_jobs.post_id is
  'Originating post/draft id. TEXT, not uuid: client draft ids ("pin_…") are not uuids.';
