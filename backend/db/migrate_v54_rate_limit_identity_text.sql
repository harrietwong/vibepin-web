-- migrate_v54_ai_rate_limit_identity_text.sql
--
-- Widen ai_rate_limit_windows.vibepin_user_id from uuid to text.
--
-- ── WHY ────────────────────────────────────────────────────────────────────────
-- v53 typed the identity column as `uuid`, on the assumption that every rate-limit
-- subject is an authenticated Supabase user. That holds for the three ai-copy
-- routes (they 401 before the limiter runs, so the identity is always a real uuid),
-- but it is WRONG for /api/generate.
--
-- /api/generate deliberately serves anonymous callers on its inline and FastAPI
-- paths (a documented product decision; only GENERATION_MODE=worker is strictly
-- authenticated). Its owner identity therefore comes from resolveGenerationOwner()
-- and is one of:
--     "user:<uuid>"          authenticated
--     "session:<clientId>"   anonymous but browser-stable
--     "anon:<hash(ip|ua)>"   last resort
-- None of those is a bare uuid. Postgres rejected them with 22P02
-- (invalid input syntax for type uuid), the limiter correctly classified that as a
-- store failure, and because the image_generation bucket is failClosed:true the
-- route returned 503 rate_limiter_unavailable for EVERY generation request.
--
-- Caught in candidate QA before promote; production was never exposed.
--
-- Widening to text is the right fix rather than coercing the identity to a uuid:
-- the limiter's subject is "whoever this caller is", which is genuinely a broader
-- domain than "a registered user". Storing a synthetic uuid would lose the
-- identity-kind prefix that makes these rows debuggable, and hashing an anonymous
-- id into uuid shape would invent a false equivalence with real user ids.
--
-- ── SAFETY ─────────────────────────────────────────────────────────────────────
-- Additive and idempotent. uuid → text is an implicit, lossless widening cast, so
-- existing rows survive unchanged (a uuid renders as its canonical 36-char text).
-- The primary key is preserved: altering a column type rebuilds the PK index in
-- place, it does not drop the constraint.
--
-- Rate-limit rows are ephemeral by design (opportunistic delete-on-write, ~1h
-- horizon), so even total loss of this table's contents would only reset counters
-- for the current window — there is no durable state at risk here.
--
-- Apply with:
--   py backend/scripts/run_migration.py --apply --sql db/migrate_v54_rate_limit_identity_text.sql

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_name  = 'ai_rate_limit_windows'
      and column_name = 'vibepin_user_id'
      and data_type   = 'uuid'
  ) then
    alter table ai_rate_limit_windows
      alter column vibepin_user_id type text using vibepin_user_id::text;
  end if;
end $$;

-- RLS was enabled with zero permissive policies in v53 and is unaffected by a
-- column type change; re-asserted here so a fresh apply of this file alone still
-- lands service-role-only.
alter table ai_rate_limit_windows enable row level security;
