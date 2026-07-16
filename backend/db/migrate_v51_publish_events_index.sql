-- v51: composite index for publish-event queries on analytics_events. Additive + idempotent.
-- Conventions (follow v41/v50): CREATE INDEX IF NOT EXISTS only; analytics_events already
-- has RLS enabled with NO permissive policies (service-role only, via
-- web/src/lib/supabase.ts createServerClient / lib/server/publishEvents.ts). Nothing here
-- changes table shape, so the publish-event writer degrades to nothing if this is unapplied
-- (the writes still land; only the by-user-and-name query is slower without the index).
--
-- APPLY: backend/scripts/run_migration.py --apply (Management API). NOT applied by this
-- change — authored only. Safe to re-run.
--
-- WHY: the admin Action Center / activation funnel (built next) reads publish events two
-- ways. v41 already provides:
--   analytics_events_name_created (event_name, created_at desc)  -- covers (event_name, created_at)
--   analytics_events_user_created (user_id,   created_at desc)   -- user timeline, ALL events
-- The second is insufficient for the funnel's "this user's pinterest_publish_* events over
-- time" query: it leads with user_id but must then filter event_name with no index support,
-- scanning every event the user ever emitted. The composite below makes
-- (user_id, event_name, created_at) an index-only range scan.

create index if not exists analytics_events_user_name_created
  on analytics_events (user_id, event_name, created_at desc);
