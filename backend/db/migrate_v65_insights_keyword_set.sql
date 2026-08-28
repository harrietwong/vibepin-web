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
-- RLS is enabled on every table below, with NO policies — the same posture v64 uses,
-- and for the same reason. The service role bypasses RLS, so the cron generators and
-- the server-side readers are unaffected; anon and authenticated get nothing, even
-- going straight at PostgREST with a valid user JWT and skipping /api/insights/**.
--
-- For `insight_report` this is not housekeeping. The row carries `evidence_snapshot`,
-- the findings and the recommendations — the entire paid deliverable. Without the
-- deny, the plan gate enforced in the read endpoint is a suggestion: anyone can read
-- any connection's report from the client. A comment saying "server-only" does not
-- stop a select; RLS with zero policies does.

-- ── v64 amendment: the registry remembers the Pin's image ───────────────────
-- The dashboard needs a thumbnail. It used to fetch one per Pin from Pinterest at
-- page time, which is exactly the outbound call the collection layer exists to
-- remove — and it is a call nobody budgets for, because the page has no ledger.
-- The collector already sees `media.images` on every Pin it lists, so the URL is
-- free there and costs one column here. When it is NULL the UI shows a placeholder;
-- a missing thumbnail is a cosmetic loss, an unbudgeted API call is not.
ALTER TABLE content_registry ADD COLUMN IF NOT EXISTS image_url text;

COMMENT ON COLUMN content_registry.image_url IS
  'Best available Pin image URL, captured by the collector. NULL renders a placeholder — the page never fetches one.';

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

-- RLS on, no policies: service role bypasses; anon/authenticated get nothing.
ALTER TABLE account_keyword_set ENABLE ROW LEVEL SECURITY;

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
-- 2am; the trigger holds then too. Note precisely what it does NOT block: `status`,
-- so superseding an already-read report keeps working. `viewed_at` and `sent_at` are
-- bookkeeping but not free: each is a one-way latch (NULL → timestamp, once), because
-- they are what closes the content columns and a clearable latch is no latch.

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

-- RLS on, no policies. This row is the paid deliverable; see the header.
ALTER TABLE insight_report ENABLE ROW LEVEL SECURITY;

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
  -- ── Monotonic timestamps, checked before anything else ────────────────────
  -- viewed_at and sent_at are one-way latches: NULL → timestamp, once. They are the
  -- switch that closes the content columns below, so if they could be changed or
  -- cleared the freeze would be trivially defeatable — set viewed_at back to NULL,
  -- rewrite the findings, set it again. Nothing legitimate ever needs to move them:
  -- the read endpoint marks a first view, the sender marks a send, and neither event
  -- happens twice for the same row.
  IF OLD.viewed_at IS NOT NULL AND NEW.viewed_at IS DISTINCT FROM OLD.viewed_at THEN
    RAISE EXCEPTION
      'insight_report % already has viewed_at; it may only go NULL → timestamp, never change or clear', OLD.id
      USING ERRCODE = '23514';
  END IF;
  IF OLD.sent_at IS NOT NULL AND NEW.sent_at IS DISTINCT FROM OLD.sent_at THEN
    RAISE EXCEPTION
      'insight_report % already has sent_at; it may only go NULL → timestamp, never change or clear', OLD.id
      USING ERRCODE = '23514';
  END IF;

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

-- ── Regeneration, in one transaction ────────────────────────────────────────
-- The versioning contract cannot be honoured by a client doing supersede-then-insert.
-- The partial unique index allows one `current` row per identity, so the old row must
-- be retired before the new one lands — and between those two statements the identity
-- has NO current row. A crash, a timeout or a transient insert failure in that window
-- leaves it permanently broken: the next run reads no current row, picks version 1,
-- and collides with the original v1 in the full unique index. Forever.
--
-- So the decision and both writes happen here, inside one transaction, behind a row
-- lock. `for update` on the current row serialises concurrent generators instead of
-- letting them race the index; the hash is re-read under that lock, so an identical
-- regeneration is a no-op decided on fresh data rather than on a value read earlier.
--
-- The version comes from max(version) over ALL statuses, not from the current row.
-- That is what heals an identity a previous crash left with only superseded rows:
-- there is no current row to read a version from, but the history still knows how far
-- the numbering got, so the repair inserts max+1 and the identity becomes usable again
-- rather than colliding on version 1 every time it is retried.
--
-- SECURITY DEFINER with execute revoked from anon/authenticated: the function writes
-- rows those roles cannot even read (RLS above), so it must not be callable by them.
CREATE OR REPLACE FUNCTION insight_report_regenerate(p jsonb)
RETURNS insight_report
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_connection_id uuid := (p->>'connection_id')::uuid;
  v_user_id       uuid := (p->>'vibepin_user_id')::uuid;
  v_kind          text := p->>'kind';
  v_subject       text := p->>'subject_content_id';   -- NULL for weekly
  v_period_key    text := p->>'period_key';
  v_hash          text := p->>'evidence_hash';
  v_current       insight_report;
  v_has_current   boolean := false;
  v_next_version  int;
  v_result        insight_report;
BEGIN
  IF v_connection_id IS NULL OR v_user_id IS NULL OR v_kind IS NULL
     OR v_period_key IS NULL OR v_hash IS NULL THEN
    RAISE EXCEPTION 'insight_report_regenerate: connection_id, vibepin_user_id, kind, period_key and evidence_hash are required'
      USING ERRCODE = '22023';
  END IF;

  -- Lock the identity's current row, if it has one. FOR UPDATE is what makes the
  -- read-decide-write below atomic against a second generator.
  SELECT * INTO v_current
  FROM insight_report
  WHERE connection_id = v_connection_id
    AND kind = v_kind
    AND coalesce(subject_content_id, '') = coalesce(v_subject, '')
    AND period_key = v_period_key
    AND status = 'current'
  FOR UPDATE;
  -- FOUND is clobbered by the next query, so the fact is captured now.
  v_has_current := FOUND;

  -- Same evidence, same report. A re-run is not an event.
  IF v_has_current AND v_current.evidence_hash = v_hash THEN
    RETURN v_current;
  END IF;

  -- max over EVERY status, so an identity left with only superseded rows continues
  -- its numbering instead of retrying version 1 against the unique index.
  SELECT coalesce(max(version), 0) + 1 INTO v_next_version
  FROM insight_report
  WHERE connection_id = v_connection_id
    AND kind = v_kind
    AND coalesce(subject_content_id, '') = coalesce(v_subject, '')
    AND period_key = v_period_key;

  IF v_has_current THEN
    UPDATE insight_report SET status = 'superseded' WHERE id = v_current.id;
  END IF;

  INSERT INTO insight_report (
    vibepin_user_id, connection_id, kind, subject_content_id, subject_draft_id,
    period_key, version, evidence_snapshot, evidence_hash, evidence_version,
    rule_version, keyword_set_version, narrative_status, status
  ) VALUES (
    v_user_id, v_connection_id, v_kind, v_subject, p->>'subject_draft_id',
    v_period_key, v_next_version,
    coalesce(p->'evidence_snapshot', '{}'::jsonb), v_hash, p->>'evidence_version',
    p->>'rule_version',
    CASE WHEN p->>'keyword_set_version' IS NULL THEN NULL
         ELSE (p->>'keyword_set_version')::int END,
    coalesce(p->>'narrative_status', 'template'), 'current'
  )
  RETURNING * INTO v_result;

  RETURN v_result;
END;
$fn$;

REVOKE ALL ON FUNCTION insight_report_regenerate(jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION insight_report_regenerate(jsonb) FROM anon, authenticated;

COMMENT ON FUNCTION insight_report_regenerate(jsonb) IS
  'Atomic report regeneration: locks the identity''s current row, no-ops on an equal evidence_hash, otherwise supersedes it and inserts version max+1. Service role only.';

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

ALTER TABLE insight_report_feedback ENABLE ROW LEVEL SECURITY;

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

ALTER TABLE insight_email_send ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE insight_email_send IS
  'Send ledger for Insights emails. id is the provider idempotency key; the row is claimed before the send so a crash cannot produce a second email.';

CREATE INDEX IF NOT EXISTS idx_insight_email_send_status
  ON insight_email_send (status, claimed_at DESC);
