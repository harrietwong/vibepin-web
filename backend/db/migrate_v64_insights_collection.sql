-- v64: Insights collection layer — run ledger, raw observations, content registry, point tasks.
--
-- Additive and idempotent (IF NOT EXISTS / CREATE OR REPLACE) — safe to re-run.
-- Apply with
--   backend/scripts/run_migration.py --apply --sql db/migrate_v64_insights_collection.sql
-- (Management API over HTTPS; direct 5432/pooler access is not reachable from here.)
--
-- To apply against the isolated test project instead of production, pass
--   --project-ref snulmwprsahzqvdbyenc
-- The default target is derived from backend/.env and is PRODUCTION, so the override
-- is mandatory for any test-database run.
--
-- ── Why ──────────────────────────────────────────────────────────────────────
-- Insights today reads Pinterest live on every page load: the dashboard calls the
-- analytics API per Pin while the user waits. That is wrong in three ways at once.
-- It is slow (one HTTP round trip per Pin, bounded only by a hard-coded cap), it
-- burns the 60-calls-per-minute allowance on page views rather than on data we
-- keep, and — the part that cannot be fixed by caching — it can only ever show
-- what Pinterest returns TODAY. Pinterest's organic analytics are a moving window:
-- a Pin's day-7 numbers are simply not retrievable once day 7 has passed. A metric
-- nobody recorded at the time is gone.
--
-- So collection has to be decoupled from rendering and has to be a ledger. These
-- five tables are that ledger:
--
--   collection_run     every attempt to talk to Pinterest, with what it spent and
--                      why it stopped. Without it, "the number is missing" and "we
--                      never asked" are indistinguishable — the single most common
--                      way an analytics feature lies to its owner.
--   metric_observation append-only raw observations. Never updated, never deleted:
--                      Pinterest revises figures for ~72h, and overwriting would
--                      destroy the evidence that a figure changed. The two views
--                      pick the latest observation per key instead.
--   content_registry   which Pins a connection owns, and how we learned about it.
--                      Also the ONLY durable proof of which account published a
--                      given Pin once a draft's payload no longer says.
--   registry_cursor    the resumable position of the full /pins scan, so a scan that
--                      spans days survives restarts without rescanning from zero.
--   pin_task           the fixed t1/t7/t30 measurement points for VibePin-published
--                      Pins, with a bounded window so a backlog can never grow
--                      without limit.
--
-- ── Status, not silence ──────────────────────────────────────────────────────
-- `metric_observation.status` is the reason this schema exists in this shape. A
-- missing row and a zero are different facts, and so are "Pinterest returned no
-- value", "our token lacks the scope", and "we never spent a call on it". Each gets
-- its own status so the UI can say which one happened. `check ((status='ok') =
-- (metric_value is not null))` makes the pairing structural: a non-ok row can never
-- smuggle in a number, and an ok row can never be empty.
--
-- ── Sentinels in the unique index ────────────────────────────────────────────
-- The run-scoped unique index coalesces two nullable columns to sentinels ('' and
-- 1900-01-01) because NULLs do not deduplicate in a unique index. That is only safe
-- because the check constraints make both sentinels impossible as real values:
-- platform_content_id is either NULL or non-empty, and period_date is either NULL or
-- strictly after 1900-01-01. Removing either check silently turns the sentinel into
-- a collidable value — do not relax them.
--
-- ── Ownership and access ─────────────────────────────────────────────────────
-- Every table is keyed by connection_id → social_connections(id) ON DELETE CASCADE,
-- not by user: one user may hold several Pinterest accounts, and a Pin belongs to
-- the account it was published through. Disconnecting an account removes its
-- collected data with it. vibepin_user_id is carried alongside for user-scoped reads
-- and cascades from auth.users.
--
-- RLS is deliberately NOT enabled: these tables are written and read only by the
-- server through the service-role key (collector cron + server-side dashboard), the
-- same posture as the other collection-side tables in this schema. No anon or
-- authenticated client ever selects from them directly. If that ever changes, RLS
-- must be added in the same change that exposes them — not afterwards.

-- ── 1. Collection ledger (referenced by metric_observation — created first) ──
CREATE TABLE IF NOT EXISTS collection_run (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES social_connections(id) ON DELETE CASCADE,
  vibepin_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('account_daily','registry','pin_task','on_demand')),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  -- What the run actually spent, versus what it was allowed to spend. Both are
  -- recorded so a short run is readable as "budget exhausted" or "nothing to do".
  calls_made int NOT NULL DEFAULT 0,
  calls_budget int NOT NULL,
  -- Why the run stopped early (e.g. 'rate_limited', 'budget_exhausted', 'no_work').
  skipped_reason text,
  error text
);

CREATE INDEX IF NOT EXISTS collection_run_conn
  ON collection_run (connection_id, started_at DESC);

-- ── 2. Raw observations (append-only) ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS metric_observation (
  id bigserial PRIMARY KEY,
  connection_id uuid NOT NULL REFERENCES social_connections(id) ON DELETE CASCADE,
  vibepin_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  scope text NOT NULL CHECK (scope IN ('account','content')),
  -- NULL for account scope; never the empty string (see the sentinel note above).
  platform_content_id text CHECK (platform_content_id IS NULL OR platform_content_id <> ''),
  metric_name text NOT NULL,
  period text NOT NULL CHECK (period IN ('day','lifetime')),
  -- NULL for lifetime; never 1900-01-01 or earlier (see the sentinel note above).
  period_date date CHECK (period_date IS NULL OR period_date > DATE '1900-01-01'),
  metric_value numeric,
  status text NOT NULL CHECK (status IN ('ok','not_returned','no_permission','not_collected')),
  observed_at timestamptz NOT NULL DEFAULT now(),
  collection_run_id uuid NOT NULL REFERENCES collection_run(id) ON DELETE CASCADE,
  api_version text NOT NULL,
  organic boolean NOT NULL DEFAULT true,
  -- Structural pairings: each keeps a row from claiming something it cannot back up.
  CHECK ((scope = 'content') = (platform_content_id IS NOT NULL)),
  CHECK ((period = 'day') = (period_date IS NOT NULL)),
  CHECK ((status = 'ok') = (metric_value IS NOT NULL))
);

-- One observation per metric per run: makes the collector's inserts safely
-- retryable (ON CONFLICT DO NOTHING) without inventing duplicate history.
-- The coalesce sentinels are collision-proof only because of the checks above.
CREATE UNIQUE INDEX IF NOT EXISTS metric_observation_run_key ON metric_observation
  (collection_run_id, scope, COALESCE(platform_content_id, ''), metric_name, period,
   COALESCE(period_date, DATE '1900-01-01'));

-- Read path: latest-per-key lookups. The trailing (observed_at DESC, id DESC)
-- mirrors the views' ordering so DISTINCT ON walks the index in order.
CREATE INDEX IF NOT EXISTS metric_observation_lookup ON metric_observation
  (connection_id, scope, platform_content_id, metric_name, period, period_date,
   observed_at DESC, id DESC);

-- Latest observation per key REGARDLESS of status — this is what tells the UI
-- "we asked and Pinterest returned nothing" instead of showing a stale number.
CREATE OR REPLACE VIEW metric_latest_status AS
  SELECT DISTINCT ON (connection_id, scope, platform_content_id, metric_name, period, period_date) *
  FROM metric_observation
  ORDER BY connection_id, scope, platform_content_id, metric_name, period, period_date,
           observed_at DESC, id DESC;

-- Latest observation per key that actually carries a value. Kept separate from
-- metric_latest_status on purpose: joining them lets a caller distinguish "no value
-- ever" from "had a value, latest attempt failed". id DESC breaks ties within the
-- same observed_at deterministically, so two rows written in one transaction cannot
-- swap places between reads.
CREATE OR REPLACE VIEW metric_latest_value AS
  SELECT DISTINCT ON (connection_id, scope, platform_content_id, metric_name, period, period_date) *
  FROM metric_observation
  WHERE status = 'ok'
  ORDER BY connection_id, scope, platform_content_id, metric_name, period, period_date,
           observed_at DESC, id DESC;

-- ── 3. Content registry and full-scan cursor ─────────────────────────────────
CREATE TABLE IF NOT EXISTS content_registry (
  connection_id uuid NOT NULL REFERENCES social_connections(id) ON DELETE CASCADE,
  platform_content_id text NOT NULL,
  -- Set only for Pins VibePin itself published; the durable attribution of a Pin to
  -- the account that published it, independent of the draft payload.
  vibepin_draft_id text,
  published_at timestamptz,
  format text,
  title text,
  description text,
  link_url text,
  board_id text,
  board_name text,
  -- How this row was learned. 'vibepin_publish' outranks the discovery endpoints and
  -- must never be downgraded by a later list pass (it is the only one carrying
  -- vibepin_draft_id).
  source_endpoint text NOT NULL CHECK (source_endpoint IN ('pins_list','top_pins','vibepin_publish')),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  last_metadata_refresh_at timestamptz,
  PRIMARY KEY (connection_id, platform_content_id)
);

CREATE TABLE IF NOT EXISTS registry_cursor (
  connection_id uuid PRIMARY KEY REFERENCES social_connections(id) ON DELETE CASCADE,
  -- NULL = no full scan in progress. A non-null bookmark is where the next page resumes.
  bookmark text,
  full_started_at timestamptz,
  full_completed_at timestamptz,
  pages_fetched int NOT NULL DEFAULT 0,
  -- Set when a full scan reaches the end (bookmark → null). Pins created DURING a
  -- multi-day scan can be missed by it, so the next day makes one first-page pass to
  -- reconcile before the scan counts as complete.
  reconciliation_pending boolean NOT NULL DEFAULT false
);

-- ── 4. Fixed measurement points ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pin_task (
  id bigserial PRIMARY KEY,
  connection_id uuid NOT NULL REFERENCES social_connections(id) ON DELETE CASCADE,
  platform_content_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('t1','t7','t30')),
  due_at timestamptz NOT NULL,
  -- Hard expiry. A task not executed inside its window is cancelled, never carried
  -- forward: that is what bounds the backlog, and a t7 measured on day 20 would be
  -- mislabelled data anyway.
  window_until timestamptz NOT NULL,
  -- t7 = 1, t30 = 2, t1 = 3. Under budget pressure the mid-life points survive,
  -- because they are the ones the diagnosis actually compares against.
  priority smallint NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','cancelled')),
  attempts int NOT NULL DEFAULT 0,
  last_attempt_at timestamptz,
  done_at timestamptz,
  cancel_reason text,
  UNIQUE (connection_id, platform_content_id, kind),
  CHECK (window_until > due_at)
);

-- Partial index on exactly the claim query: pending tasks of one connection in
-- execution order. Excluding done/cancelled keeps it small as history accumulates.
CREATE INDEX IF NOT EXISTS pin_task_pick
  ON pin_task (connection_id, priority, due_at) WHERE status = 'pending';

-- ── 5. Ownership documentation ───────────────────────────────────────────────
COMMENT ON TABLE collection_run IS
  'Insights collection ledger (v64). One row per attempt to collect from a platform '
  'for one connection. Service-role only; no RLS.';
COMMENT ON TABLE metric_observation IS
  'Insights raw observations (v64). APPEND-ONLY — never UPDATE or DELETE; read through '
  'metric_latest_status / metric_latest_value. Service-role only; no RLS.';
COMMENT ON TABLE content_registry IS
  'Insights content registry (v64). Durable proof of which connection owns a Pin. '
  'source_endpoint=''vibepin_publish'' must never be downgraded. Service-role only; no RLS.';
COMMENT ON TABLE registry_cursor IS
  'Insights full-scan cursor (v64). Resumable position of the /pins scan. Service-role only; no RLS.';
COMMENT ON TABLE pin_task IS
  'Insights fixed measurement points t1/t7/t30 (v64). Windowed: expired pending tasks are '
  'cancelled, never carried forward. Service-role only; no RLS.';
