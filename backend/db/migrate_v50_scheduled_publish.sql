-- v50: Auto due-time publishing (PRD WP-A). Additive; apply via run_migration.py.
-- Renamed from v42_scheduled_publish — v42 was taken by v42_support_translations on master.
-- Conventions (follow v38/v41): additive + idempotent (ADD COLUMN IF NOT EXISTS /
-- CREATE INDEX IF NOT EXISTS), RLS already enabled on pin_drafts with NO permissive
-- policies (service-role only, via web/src/lib/supabase.ts createServerClient). The web
-- code degrades gracefully while this is unapplied: /api/pin-drafts PUT strips the two
-- new promoted columns on a missing-column error (isMissingColumnError), and the cron
-- endpoint /api/cron/publish-due returns a benign empty result until the columns exist.
--
-- APPLY: backend/scripts/run_migration.py --apply (Management API). Renamed from v42
-- (which collided with v42_support_translations on master). Additive; safe to re-run.

-- ── Promoted scheduling columns on the v38 pin_drafts table ─────────────────────────
-- pin_drafts keeps the FULL PinDraft object in `payload` (authority). These two
-- timestamptz columns are promoted, query-friendly copies used by the server-side
-- scheduler (payload has plannedAt as a client-local wall-clock string that the server
-- cannot index or compare directly).
--
--   scheduled_at       — the Pin's due instant, computed from payload.plannedAt (or
--                        scheduledDate + scheduledTime) by /api/pin-drafts promote.ts.
--                        NULL when the Pin is unscheduled OR already posted.
--   publish_claimed_at — the cron worker's claim lock. Set to now() by an atomic
--                        conditional UPDATE in /api/cron/publish-due so concurrent /
--                        repeated triggers never double-publish the same row. A stale
--                        claim (> 10 min old, e.g. a crashed worker) is reclaimable.
--                        NEVER written by the client PUT path (promote.ts omits it, and
--                        the partial-column upsert leaves any existing value intact).
alter table pin_drafts
  add column if not exists scheduled_at       timestamptz;  -- due instant (null = unscheduled/posted)
alter table pin_drafts
  add column if not exists publish_claimed_at timestamptz;  -- cron claim lock (null = unclaimed)

-- ── Partial index for the "what's due now" scan ─────────────────────────────────────
-- The cron endpoint scans `scheduled_at <= now()` for live (non-deleted) rows only;
-- a partial index keeps it tiny (only scheduled, undeleted rows are indexed).
create index if not exists pin_drafts_scheduled_at_due
  on pin_drafts (scheduled_at)
  where scheduled_at is not null and deleted_at is null;
