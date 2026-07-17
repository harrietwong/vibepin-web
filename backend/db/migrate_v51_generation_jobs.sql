-- v51: Durable AI generation job queue (WP3-P1). Additive; apply via run_migration.py.
-- Conventions (follow v50): additive + idempotent (CREATE TABLE IF NOT EXISTS /
-- CREATE INDEX IF NOT EXISTS / ALTER … ADD COLUMN IF NOT EXISTS), RLS ENABLED with
-- NO permissive policies (service-role only — the VPS worker and the Next server
-- both use the Supabase service-role key via createServerClient / get_supabase()).
--
-- NUMBER NOTE: v51 is also used by migrate_v51_publish_events_index.sql on the
-- unmerged feat/admin-cockpit branch. Both are additive/idempotent and touch
-- disjoint tables (generation_jobs / pinterest publish-event index), so applying
-- both is safe; the shared number is a label collision only, resolvable at merge
-- by renaming one file. This file's CONTRACT (columns/statuses/results shape) is
-- shared verbatim with the WP3 package-B Next.js side.
--
-- APPLY: backend/scripts/run_migration.py --apply --sql db/migrate_v51_generation_jobs.sql
-- (Management API over HTTPS). Additive; safe to re-run.

-- ── generation_jobs — the DB-as-queue table ─────────────────────────────────────
-- POST /api/generate inserts one row (status='queued'); the VPS worker claims it
-- with an atomic CAS UPDATE, generates each slot, and writes results incrementally.
-- The Studio UI polls GET /api/generation-jobs/[id] for the row's status + results.
--
--   status    queued  → freshly enqueued, unclaimed
--             running → a worker holds it (claimed_at set; heartbeat kept fresh)
--             done    → every slot succeeded
--             partial → at least one slot succeeded, at least one failed
--             failed  → every slot failed
--   params    full multimodal request body (same shape as /api/generate → generator.py):
--             keyword/style/count/prompt/product_images/style_ref/model_key/format/…
--   results   per-slot state array, one entry per requested output image:
--             [{ "slot": int, "status": "pending"|"done"|"failed",
--                "imageUrl": string|null, "error": string|null }]
--             The worker is idempotent per slot: on re-claim it skips slots whose
--             status is already 'done' and only (re)runs 'pending'/'failed' ones.
--   claimed_at          when the current/last worker claimed the row (CAS timestamp)
--   worker_heartbeat_at kept fresh (≈30s) while a worker processes the job; a
--                       'running' row whose heartbeat is older than 5 min is
--                       treated as an orphan (crashed worker) and reclaimable.
--   finished_at         set when the row reaches a terminal state (done/partial/failed)
create table if not exists generation_jobs (
  id                  uuid primary key default gen_random_uuid(),
  vibepin_user_id     uuid        not null,
  status              text        not null default 'queued',
  params              jsonb       not null,
  results             jsonb       not null default '[]'::jsonb,
  claimed_at          timestamptz,
  worker_heartbeat_at timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  finished_at         timestamptz
);

-- Re-run safety: add any column that an older partial apply may have missed.
alter table generation_jobs add column if not exists vibepin_user_id     uuid;
alter table generation_jobs add column if not exists status              text;
alter table generation_jobs add column if not exists params              jsonb;
alter table generation_jobs add column if not exists results             jsonb;
alter table generation_jobs add column if not exists claimed_at          timestamptz;
alter table generation_jobs add column if not exists worker_heartbeat_at timestamptz;
alter table generation_jobs add column if not exists created_at          timestamptz;
alter table generation_jobs add column if not exists updated_at          timestamptz;
alter table generation_jobs add column if not exists finished_at         timestamptz;

-- ── Partial index for the worker's claim scan ───────────────────────────────────
-- The worker only ever scans active work (queued for fresh claims, running for
-- orphan reclaim). A partial index on (status, created_at) keeps the "oldest
-- claimable job first" query tiny — terminal rows (done/partial/failed) are not
-- indexed, so the index does not grow with completed history.
create index if not exists generation_jobs_active_created_at
  on generation_jobs (status, created_at)
  where status in ('queued', 'running');

-- ── RLS: service-role only (zero policies) ──────────────────────────────────────
-- Enabling RLS with no permissive policy blocks the anon/authenticated roles
-- entirely; only the service-role key (which bypasses RLS) can read/write. Both
-- the VPS worker (get_supabase / service key) and the Next server routes
-- (createServerClient / service key) use that key, so no policy is required.
alter table generation_jobs enable row level security;

-- ── generation_worker_status — worker liveness for the enqueue health gate ──────
-- The worker upserts its row every ≈30s (name = a stable worker identity, e.g.
-- 'generation-worker'). POST /api/generate reads last_seen freshness BEFORE
-- enqueuing: if no worker has checked in recently it fails honestly with 503
-- instead of creating a zombie job no one will ever claim.
create table if not exists generation_worker_status (
  name      text        primary key,
  last_seen timestamptz not null
);

alter table generation_worker_status add column if not exists last_seen timestamptz;

alter table generation_worker_status enable row level security;
