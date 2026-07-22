-- v53: Durable per-user rate-limit windows for the paid AI provider routes
-- (Phase 1B PR2). Additive; apply via run_migration.py.
--
-- Conventions (follow v51): additive + idempotent (CREATE TABLE IF NOT EXISTS /
-- CREATE INDEX IF NOT EXISTS / ALTER … ADD COLUMN IF NOT EXISTS), RLS ENABLED with
-- NO permissive policies (service-role only — the Next server routes use the
-- Supabase service-role key via createServerClient).
--
-- NUMBER NOTE: master's highest migration number is v52 (migrate_v52_publish_events_index.sql),
-- so this takes v53. Duplicate numbers already exist on master at v26/v29/v45 —
-- uniqueness here is a convention, not an enforced constraint. This file is additive
-- and touches one new table, so a future number collision would be a label clash only.
--
-- APPLY: backend/scripts/run_migration.py --apply --sql db/migrate_v53_ai_rate_limit_windows.sql
-- (Management API over HTTPS). Additive; safe to re-run.

-- ── ai_rate_limit_windows — durable fixed-window counters ───────────────────────
-- WHY THIS EXISTS: PR1 put authentication on /api/ai-copy, /api/ai-copy/analyze and
-- /api/quality-judge. That turned unlimited ANONYMOUS provider spend into unlimited
-- PER-ACCOUNT provider spend — a disposable or compromised account can still run up
-- unbounded cost. This table is the cost ceiling.
--
-- WHY IT IS IN POSTGRES AND NOT IN MEMORY: the app runs on Vercel Lambdas. Any
-- in-process Map (see api/contact/route.ts) or os.tmpdir() lock (see the TTL lock in
-- api/generate/route.ts) is PER-INSTANCE EPHEMERAL — two concurrent requests landing
-- on two instances both pass. Only shared durable state can bound total spend. There
-- is no Redis/KV dependency in this project, so Postgres is the store.
--
-- SHAPE: one row per (user, route, window_start). `hits` is incremented with a
-- compare-and-swap UPDATE guarded on the previously-read value (the same idiom as
-- pinterest_connections.token_version), so two simultaneous requests can never both
-- take the last remaining slot. The first request in a window creates the row with a
-- plain INSERT; a lost creation race surfaces as Postgres 23505 on the primary key
-- (the same idiom as creem_webhook_events) and falls back to the CAS path.
--
--   vibepin_user_id  the authenticated caller (already resolved by the route's auth check)
--   route            logical route key ('ai_copy' | 'ai_copy_analyze' | 'quality_judge').
--                    Limits are PER ROUTE: exhausting copy generation must not disable
--                    the background quality judge, and vice versa.
--   window_start     floor(now / window_seconds) as a timestamptz — the fixed-window bucket
--   hits             requests admitted in this window
--   created_at       row creation time; the sole input to pruning
create table if not exists ai_rate_limit_windows (
  vibepin_user_id uuid        not null,
  route           text        not null,
  window_start    timestamptz not null,
  hits            integer     not null default 0,
  created_at      timestamptz not null default now(),
  primary key (vibepin_user_id, route, window_start)
);

-- Re-run safety: add any column an older partial apply may have missed.
alter table ai_rate_limit_windows add column if not exists hits       integer;
alter table ai_rate_limit_windows add column if not exists created_at timestamptz;

-- ── Cleanup ────────────────────────────────────────────────────────────────────
-- STRATEGY: opportunistic delete-on-write, index-supported. When a request opens a
-- NEW window for a (user, route) it also fires a best-effort background delete of
-- that pair's rows older than the retention horizon (see RATE_LIMIT_ROW_TTL_MS in
-- web/src/lib/server/rateLimit.ts). Because every new window is preceded by exactly
-- one such sweep, a user's row count stays O(1) — rows only accumulate for accounts
-- that stop calling entirely, and those rows are bounded by that account's own
-- historical window count.
--
-- This index is what makes that sweep cheap, and also serves a global janitorial
-- sweep should one ever be needed:
--   delete from ai_rate_limit_windows where created_at < now() - interval '1 day';
create index if not exists ai_rate_limit_windows_created_at
  on ai_rate_limit_windows (created_at);

-- ── RLS: service-role only (zero policies) ──────────────────────────────────────
-- Enabling RLS with no permissive policy blocks the anon/authenticated roles
-- entirely; only the service-role key (which bypasses RLS) can read/write. The Next
-- server routes use that key via createServerClient, so no policy is required. A
-- client that could write this table could raise its own limit.
alter table ai_rate_limit_windows enable row level security;
