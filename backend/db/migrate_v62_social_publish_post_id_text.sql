-- Migration v62: social_publish_jobs.post_id → text
--
-- RENUMBERED from v58 (2026-08-18). v58 was double-booked: migrate_v58_ai_cost_events
-- (committed 2026-07-31) got the number first, so this file — committed 2026-08-02 —
-- yields. v59 is likewise double-booked (social_pinterest_unify /
-- truncate_opportunity_relations), and v60/v61 are held by in-flight drafts in another
-- worktree, so v62 is the first genuinely free number. Never applied under the old
-- number, so renumbering is safe.
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
--
-- STATUS 2026-08-18: ALREADY APPLIED IN PRODUCTION (ref jaxteelkecvlozdrdoog).
-- Read-only preflight found 20 social_publish_jobs rows whose post_id holds client
-- draft ids ("pd_1780383217819_uq5c1r") — values a uuid column could not store.
-- Confirmed independently by filtering post_id with a non-uuid literal: PostgREST
-- accepted it instead of raising 22P02. The guard above makes re-running harmless,
-- but there is nothing left to do: the column is already text and the two tables
-- hold real published results (27 destination rows, 0 orphans).
--
-- This corrects the file's own "verified no rows" note, which was true when it was
-- written (2026-08-02) and is no longer true.

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
