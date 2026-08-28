-- v65: Insights — the phrase list an account is measured against, and the reports
--      that measurement is frozen into. The LAST Insights migration: everything the
--      feature needs through the email step is created here, so no later step has to
--      wait on a second DDL landing.
--
-- Tables, in dependency order (each section carries its own reasoning):
--   1. account_keyword_set     — versioned phrase list per connection (evidence step)
--   2. insight_report          — weekly + T+7/T+30 scorecards, versioned, immutable
--                                after send/view (trigger insight_report_guard)
--   3. insight_report_feedback — one thumb per user per report
--   4. insight_email_send      — send ledger / idempotency keys (used in step 6)
--
-- Additive and idempotent (IF NOT EXISTS) — safe to re-run.
-- Apply with
--   backend/scripts/run_migration.py --apply --sql db/migrate_v65_insights_keyword_set.sql
-- (Management API over HTTPS; direct 5432/pooler access is not reachable from here.)
--
-- To apply against the isolated test project instead of production, pass
--   --project-ref snulmwprsahzqvdbyenc
-- The default target is derived from backend/.env and is PRODUCTION, so the override
-- is mandatory for any test-database run.
--
-- NOT APPLIED ANYWHERE YET. This file ships ahead of its apply on purpose: the code
-- that reads it degrades to an in-memory build when the relation is absent (same
-- posture as v64's readers), so deploying the feature never depends on a database
-- change landing first.
--
-- ── Why ──────────────────────────────────────────────────────────────────────
-- One Insights observation (A1) says: this share of your recent Pins carries none of
-- the phrases people actually search in your category. For that sentence to mean
-- anything, the phrase list has to come from somewhere OUTSIDE the account. A list
-- derived from the account's own titles would match those titles by construction and
-- the observation could never be true — it would be a mirror with a percentage sign.
-- So the phrases come from `trend_keywords` (Pinterest search terms we collect) and
-- `keyword_expansions` (that search box's own suggestions), and nothing in this table
-- is ever built from Pin text.
--
-- The reason to STORE the result rather than recompute it per request is evidence,
-- not speed. `trend_keywords` moves: rows are added, priority scores are rescored,
-- seasonal terms rise and fall. A diagnosis produced last week was produced against
-- last week's phrase list, and if that list is gone the number in the weekly report
-- can no longer be explained, reproduced, or defended. `version` + `source_snapshot_at`
-- + the stored `phrases` array make an old diagnosis re-derivable; the rule and
-- threshold versions the engine records complete the provenance.
--
-- ── Rebuild policy (enforced in code, recorded here) ─────────────────────────
-- A new version row is written when the account's category changes, or when the
-- newest row is older than 30 days. Rows are never updated in place and never
-- deleted: overwriting a set destroys the only record of what an earlier diagnosis
-- was measured against. `unique (connection_id, version)` makes a concurrent
-- rebuild collide rather than silently produce two "version 4"s.
--
-- ── Where the category lives ─────────────────────────────────────────────────
-- The account's category is NOT a column here — it is a copy. The authority is
-- `social_connections.metadata.insights_category` (jsonb, no DDL needed), set either
-- by the user through PATCH /api/insights/category or by one-time inference from
-- board names and Pin titles, in which case `insights_category_inferred` is true so a
-- guess is never mistaken for a choice. The copy in this table records which category
-- THIS set was built for, which is what makes a stale set detectable.
--
-- ── Ownership and access ─────────────────────────────────────────────────────
-- Keyed by connection_id → social_connections(id) ON DELETE CASCADE, like every v64
-- table: one user may hold several Pinterest accounts and each has its own market.
-- Disconnecting an account takes its keyword sets with it.
--
-- RLS is deliberately NOT enabled: this table is written and read only by the server
-- through the service-role key, the same posture as the v64 collection tables. No
-- anon or authenticated client selects from it directly. If that ever changes, RLS
-- must be added in the same change that exposes it — not afterwards.

CREATE TABLE IF NOT EXISTS account_keyword_set (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES social_connections(id) ON DELETE CASCADE,
  -- Monotonic per connection, assigned by the writer as max(version)+1.
  version int NOT NULL CHECK (version > 0),
  -- The trend_keywords category this set was built from. NULL means the category was
  -- unknown at build time (no user choice, inference found no hits) — a real state,
  -- and one the engine reports as "no category yet" rather than guessing.
  category text,
  -- When the source rows were read. NOT the row's creation time: a set rebuilt from a
  -- cached read would otherwise claim freshness it does not have.
  source_snapshot_at timestamptz NOT NULL DEFAULT now(),
  -- A JSON array of normalized phrases (lower-cased, punctuation stripped, ≥2 tokens).
  -- Stored as the built artifact, not as ids into trend_keywords: those rows change
  -- and are deleted, and a set that cannot be read back without them is not a record.
  phrases jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, version)
);

COMMENT ON TABLE account_keyword_set IS
  'Versioned phrase list per Pinterest connection, built from trend_keywords + keyword_expansions. Never built from the account''s own Pin text (see migration header).';
COMMENT ON COLUMN account_keyword_set.source_snapshot_at IS
  'When the trend_keywords/keyword_expansions rows behind this set were read.';
COMMENT ON COLUMN account_keyword_set.phrases IS
  'JSON array of normalized phrases; the artifact an old diagnosis can be re-derived from.';

-- The only access pattern: newest set for one connection.
CREATE INDEX IF NOT EXISTS idx_account_keyword_set_connection_version
  ON account_keyword_set (connection_id, version DESC);


-- ═══════════════════════════════════════════════════════════════════════════
-- Reports (step 5): the weekly read and the per-Pin scorecards
-- ═══════════════════════════════════════════════════════════════════════════
--
-- ── Why a report is a ROW and not a render ──────────────────────────────────
-- Everything below could be recomputed on demand from the collection ledger, and
-- for a dashboard that is the right answer — a dashboard is a window on now. A
-- report is not. A report is a thing that was SENT: it went into an email, the user
-- read it, changed one variable because of it, and comes back three weeks later to
-- ask what it actually said. If the sentence is recomputed at that moment it will
-- have quietly changed — the ledger moved, the cohort refilled, the keyword set was
-- rebuilt — and the user is now arguing with a number nobody can reproduce. So the
-- evidence the report was built from is frozen INTO the row (evidence_snapshot)
-- together with the versions of the rules, thresholds and phrase list that shaped it.
--
-- ── Why versions instead of updates ─────────────────────────────────────────
-- Regenerating the same period must not overwrite: evidence_hash decides. Identical
-- hash → nothing happens (a re-run is not an event). Different hash → the old row is
-- marked superseded and a new row is inserted at version + 1. The partial unique
-- index makes "exactly one current row per (connection, kind, subject, period)" a
-- database fact rather than a convention the writer promises to keep, and the full
-- unique index makes a concurrent regeneration collide instead of producing two v2s.
--
-- ── Why a trigger and not a code rule ───────────────────────────────────────
-- Once a report has been sent or viewed, its content columns are closed. A code-level
-- rule would hold until the day someone writes a "backfill the narrative" script at
-- 2am; the trigger holds then too. Note precisely what it does NOT block: status,
-- viewed_at and sent_at are bookkeeping, not content, and both marking a report read
-- and superseding an already-read report must keep working.

CREATE TABLE IF NOT EXISTS insight_report (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vibepin_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES social_connections(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('weekly', 'scorecard_t7', 'scorecard_t30')),
  -- The Pinterest Pin id a scorecard is about. NULL exactly when the report is the
  -- account-level weekly one — the CHECK below makes the two facts one fact, so a
  -- weekly report can never acquire a subject and a scorecard can never lose one.
  subject_content_id text,
  -- The VibePin draft that produced the Pin, when provenance knows it. Nullable and
  -- deliberately not a foreign key: deleting a draft does not unpublish its Pin, and
  -- a scorecard about a live Pin must not disappear with the local row.
  subject_draft_id text,
  -- 'YYYY-Www' (ISO week-year) for weekly; 'T7' / 'T30' for scorecards.
  period_key text NOT NULL,
  version int NOT NULL DEFAULT 1 CHECK (version > 0),
  -- The frozen evidence this report was written from: findings, recommendations and
  -- the sample statement, all as i18n keys + params, never as rendered sentences —
  -- a report re-read in another language must say the same thing, not English.
  evidence_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- sha256 of a stable serialization of evidence_snapshot. The regeneration decision
  -- in one column: same hash, same report, no new version.
  evidence_hash text NOT NULL,
  -- Threshold version the evidence was cut at (engine THRESHOLD_VERSION).
  evidence_version text,
  -- Rule version that produced the findings (engine RULE_VERSION).
  rule_version text,
  -- account_keyword_set.version the phrase-based observations were measured against.
  keyword_set_version int,
  -- Reserved for the LLM narrative (step 6). NULL here on purpose: this step ships
  -- template narratives only, and narrative_status says so rather than leaving the
  -- reader to guess whether a NULL means "not generated" or "generation failed".
  narrative jsonb,
  narrative_model text,
  narrative_status text NOT NULL DEFAULT 'template'
    CHECK (narrative_status IN ('template', 'llm', 'llm_failed_fallback')),
  status text NOT NULL DEFAULT 'current' CHECK (status IN ('current', 'superseded')),
  generated_at timestamptz NOT NULL DEFAULT now(),
  -- First time the content was actually served to the user, and the moment the row
  -- becomes immutable. Set once, by the read endpoint, never by the generator.
  viewed_at timestamptz,
  sent_at timestamptz,
  CONSTRAINT insight_report_weekly_has_no_subject
    CHECK ((kind = 'weekly') = (subject_content_id IS NULL))
);

COMMENT ON TABLE insight_report IS
  'Frozen weekly / T+7 / T+30 reports per Pinterest connection. Versioned, and immutable after send or view (see insight_report_guard).';
COMMENT ON COLUMN insight_report.evidence_snapshot IS
  'The evidence the report was written from, as i18n keys + params — the record that makes an old sentence re-derivable.';
COMMENT ON COLUMN insight_report.evidence_hash IS
  'sha256 of the stable serialization of evidence_snapshot; an equal hash means the same report, so regeneration is a no-op.';

-- One row per (connection, kind, subject, period, version) — a concurrent
-- regeneration collides here instead of writing a second "version 2".
CREATE UNIQUE INDEX IF NOT EXISTS uq_insight_report_identity
  ON insight_report (connection_id, kind, coalesce(subject_content_id, ''), period_key, version);

-- And exactly one of them may be current. Enforced by the database because every
-- read ("the latest weekly report") depends on it being true.
CREATE UNIQUE INDEX IF NOT EXISTS uq_insight_report_current
  ON insight_report (connection_id, kind, coalesce(subject_content_id, ''), period_key)
  WHERE status = 'current';

-- The list endpoint's access pattern: this connection's current reports, newest first.
CREATE INDEX IF NOT EXISTS idx_insight_report_connection_current
  ON insight_report (connection_id, generated_at DESC)
  WHERE status = 'current';

CREATE OR REPLACE FUNCTION insight_report_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  -- Not sent and not viewed: still a private artefact, the generator may rewrite it.
  IF OLD.sent_at IS NULL AND OLD.viewed_at IS NULL THEN
    RETURN NEW;
  END IF;

  -- Sent or viewed: bookkeeping columns stay open (status / viewed_at / sent_at),
  -- content columns are closed. The comparison is per column and not a blanket
  -- rejection so that superseding an already-read report keeps working.
  IF NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.subject_content_id IS DISTINCT FROM OLD.subject_content_id
     OR NEW.subject_draft_id IS DISTINCT FROM OLD.subject_draft_id
     OR NEW.period_key IS DISTINCT FROM OLD.period_key
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.evidence_snapshot IS DISTINCT FROM OLD.evidence_snapshot
     OR NEW.evidence_hash IS DISTINCT FROM OLD.evidence_hash
     OR NEW.evidence_version IS DISTINCT FROM OLD.evidence_version
     OR NEW.rule_version IS DISTINCT FROM OLD.rule_version
     OR NEW.keyword_set_version IS DISTINCT FROM OLD.keyword_set_version
     OR NEW.narrative IS DISTINCT FROM OLD.narrative
     OR NEW.narrative_model IS DISTINCT FROM OLD.narrative_model
     OR NEW.narrative_status IS DISTINCT FROM OLD.narrative_status
     OR NEW.generated_at IS DISTINCT FROM OLD.generated_at
  THEN
    RAISE EXCEPTION
      'insight_report % was already sent or viewed; its content is immutable (write a new version instead)', OLD.id
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS insight_report_guard ON insight_report;
CREATE TRIGGER insight_report_guard
  BEFORE UPDATE ON insight_report
  FOR EACH ROW EXECUTE FUNCTION insight_report_guard();

-- ── Feedback ────────────────────────────────────────────────────────────────
-- One thumb per user per report, and the primary key says so: a second click is an
-- UPDATE of an opinion, not a second vote. This is the only signal that can tell a
-- report which is true and useless from one that changed what somebody did.

CREATE TABLE IF NOT EXISTS insight_report_feedback (
  report_id uuid NOT NULL REFERENCES insight_report(id) ON DELETE CASCADE,
  vibepin_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  helpful boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (report_id, vibepin_user_id)
);

COMMENT ON TABLE insight_report_feedback IS
  'Thumbs up/down per report per user. Primary key (report_id, vibepin_user_id): a changed mind is an update, not a second vote.';

-- ── Email ledger (used in step 6; created now so v65 is the last Insights DDL) ──
-- The id doubles as the provider idempotency key, which is the whole point of
-- claiming a row BEFORE the send: a crash between "provider accepted" and "row
-- updated" must not produce a second email, and only a key generated before the
-- call can promise that. batch_key is what makes the claim unique — one weekly
-- email per connection per ISO week, one digest per scorecard batch.

CREATE TABLE IF NOT EXISTS insight_email_send (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vibepin_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES social_connections(id) ON DELETE CASCADE,
  email_kind text NOT NULL CHECK (email_kind IN ('weekly', 'scorecard_digest')),
  batch_key text NOT NULL,
  report_ids uuid[] NOT NULL DEFAULT '{}',
  status text NOT NULL CHECK (status IN ('claimed', 'sent', 'failed', 'skipped')),
  attempts int NOT NULL DEFAULT 0,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  last_attempt_at timestamptz,
  sent_at timestamptz,
  provider_message_id text,
  error text,
  UNIQUE (connection_id, email_kind, batch_key)
);

COMMENT ON TABLE insight_email_send IS
  'Send ledger for Insights emails. id is the provider idempotency key; the row is claimed before the send so a crash cannot produce a second email.';

CREATE INDEX IF NOT EXISTS idx_insight_email_send_status
  ON insight_email_send (status, claimed_at DESC);
