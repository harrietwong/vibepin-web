-- v65: Insights keyword set — the phrase list an account's Pin text is checked against.
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
