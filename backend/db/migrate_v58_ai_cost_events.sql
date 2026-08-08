-- v58: ai_cost_events — INTERNAL provider-cost audit ledger.
-- Apply with backend/scripts/run_migration.py --apply (Management API).
-- NOT APPLIED YET: authored only; the owner applies this deliberately.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- WHAT THIS IS — AND WHAT IT IS EMPHATICALLY NOT
-- ═══════════════════════════════════════════════════════════════════════════════
-- This table records what VibePin PAYS an AI provider per call. It is a
-- business-internal cost-analytics ledger:
--   * it has NO user-visible UI and no i18n strings;
--   * it drives NO enforcement — nothing reads it to allow or deny an action;
--   * it is NEVER the source of any number shown to a customer.
--
-- It is deliberately and completely SEPARATE from the user-facing QUOTA ledger.
-- Quota lives in usage_accounts / usage_reservations / usage_events (v55 + v56):
-- a reserve→settle design where a metered action reserves capacity up front and
-- settles the true amount afterwards. That ledger answers "how much of the
-- customer's monthly allowance is left". THIS table answers a different question
-- for a different audience: "what did that call cost us in USD". The two must not
-- be conflated — a call can be free to the customer and expensive to us (retries,
-- moderation, vision pre-passes), or metered to the customer and ~free to us.
--
-- Because of that separation there is NO foreign key from ai_cost_events to any
-- usage_* table, and no code path lets a write here affect a quota decision. Cost
-- logging is best-effort and fail-open by contract (see web/src/lib/server/
-- aiCostLog.ts: recordAiCost never throws; callers fire-and-forget). Losing a row
-- here is acceptable; breaking a customer's generation because cost logging failed
-- is not. That is precisely why this ledger is standalone.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- COLUMN NOTES
-- ═══════════════════════════════════════════════════════════════════════════════
-- Nearly every column is NULLABLE on purpose. Different providers and operations
-- report wildly different facts: a text call returns token counts and no images;
-- an image call returns image counts and no tokens; a moderation call returns
-- neither. Forcing NOT NULL would push callers to invent zeros, and a fabricated 0
-- is indistinguishable from a measured 0 once it is in the table. NULL honestly
-- means "this dimension does not apply / was not reported".
--
--   user_id                 Whose call it was. NULL for anonymous/system calls;
--                           intentionally NOT a foreign key so that deleting a
--                           user never destroys historical cost accounting.
--   provider / model        e.g. 'linapi' / 'gemini-2.5-flash'. 'n/a' provider is
--                           used for calls rejected before dispatch (0 real cost).
--   operation_type          'image_generation' | 'copy_generation' |
--                           'vision_analysis' | 'quality_judge' | 'moderation' |
--                           'support_reply' | 'support_translate' | …
--                           Free text (no CHECK) so a new call site can start
--                           logging without a migration.
--   input_tokens /
--   output_tokens           Provider-reported token usage, when reported.
--   requested_image_count /
--   successful_image_count  Image ops: what we asked for vs. what came back. Both
--                           are recorded so partial failures are visible (we are
--                           usually billed for attempts, not successes).
--   resolution              Image size/aspect string when known.
--   estimated_cost          USD, and NULL whenever the model's rate is unverified.
--                           web/src/lib/server/aiCostRates.ts ships with every
--                           rate null, so this column stays NULL until real,
--                           verified provider prices are filled in. A guessed
--                           price would silently corrupt every cost report built
--                           on this table, so NULL is the correct, honest default;
--                           raw token/image counts are recorded regardless and can
--                           be re-priced retroactively once rates land.
--   request_status          'success' | 'partial' | 'failed' | 'timeout' |
--                           'moderation_rejected'. Failed calls are logged too —
--                           providers bill for many of them.
--   plan                    The caller's plan at call time, for margin analysis.
--   reference_id            Correlation id (e.g. generation_request_id, draft id).
--   metadata                Anything else worth keeping (e.g. moderation units).
--
-- Additive + idempotent (create … if not exists), safe to re-run.

create table if not exists ai_cost_events (
  id                      uuid        primary key default gen_random_uuid(),
  user_id                 uuid,
  provider                text,
  model                   text,
  operation_type          text,
  input_tokens            integer,
  output_tokens           integer,
  requested_image_count   integer,
  successful_image_count  integer,
  resolution              text,
  estimated_cost          numeric,
  currency                text        default 'USD',
  request_status          text,
  plan                    text,
  reference_id            text,
  metadata                jsonb,
  created_at              timestamptz default now()
);

-- Time-series reporting (spend per day/week) and per-user drilldown.
create index if not exists ai_cost_events_created_at
  on ai_cost_events (created_at);
create index if not exists ai_cost_events_user_created_at
  on ai_cost_events (user_id, created_at);

-- RLS ON with NO permissive policies: service-role only, exactly like
-- migrate_v45_creem_billing.sql and the v55 usage tables. This is internal cost
-- data — no end user, and no anon/authenticated client, may read or write it.
alter table ai_cost_events enable row level security;

-- @verify
SELECT
  ( (SELECT count(*) FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'ai_cost_events') = 1
    AND (SELECT relrowsecurity FROM pg_class
       WHERE oid = 'public.ai_cost_events'::regclass) = true
    -- Service-role only: RLS enabled and zero policies attached.
    AND (SELECT count(*) FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'ai_cost_events') = 0
    AND (SELECT count(*) FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = 'ai_cost_events'
         AND indexname IN ('ai_cost_events_created_at', 'ai_cost_events_user_created_at')) = 2
  ) AS migration_verified;
