-- v55: Usage ledger primitives (Phase 2). Additive; apply via run_migration.py.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- THIS MIGRATION IS DELIBERATELY DORMANT.
-- ═══════════════════════════════════════════════════════════════════════════════
-- Nothing in the application calls any function defined here. No API route, no
-- Python worker, no webhook, no publishing path, no Billing UI, no cron. The ONLY
-- caller is web/scripts/test-usage-ledger-db.ts.
--
-- That is the point. Metering is the one subsystem where a half-wired rollout is
-- worse than none at all: a reservation primitive that some routes call and others
-- bypass produces a ledger that disagrees with reality, and a ledger nobody trusts
-- is a ledger nobody can bill from. So the primitives land first, get proven against
-- real Postgres under real concurrency, and only then (Phase 3) get wired to callers
-- — all at once, behind the entitlement config.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- WHAT PROBLEM THESE PRIMITIVES SOLVE
-- ═══════════════════════════════════════════════════════════════════════════════
-- Image generation is slow (tens of seconds), asynchronous (a VPS worker), and
-- partially fallible (4 requested images can end 2 succeeded / 2 failed). A naive
-- "decrement on success" meter lets a user start unlimited concurrent jobs before
-- any of them lands — the classic double-spend. A naive "decrement on request" meter
-- charges for images the provider never delivered.
--
-- So spend is two-phase:
--   RESERVE   capacity is moved from "available" to "reserved" ATOMICALLY, before
--             any provider call. This is what bounds concurrency.
--   SETTLE    each slot independently converts reserved→used (success) or releases
--             it back (terminal failure). Per-slot, because partial success is the
--             normal case, not an edge case.
-- Plus RELEASE (cancellation / synchronous failure) and EXPIRE (crashed worker).
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- HOW ATOMICITY IS ACHIEVED — no SERIALIZABLE required
-- ═══════════════════════════════════════════════════════════════════════════════
-- Every mutating function below begins by taking a ROW-LEVEL WRITE LOCK on the one
-- usage_accounts row it will touch:
--
--     select … from usage_accounts where id = … for update;
--
-- Under Postgres's default READ COMMITTED isolation, a second transaction executing
-- the same statement BLOCKS until the first commits, and then re-reads the freshly
-- committed row (READ COMMITTED re-evaluates the qualifying row after a lock wait).
-- So capacity checks and counter writes for a single account are strictly serialized
-- by that lock — concurrent racers queue rather than interleave. This is why the
-- classic "two readers both see room for the last slot" anomaly cannot occur here,
-- and why SERIALIZABLE (with its retry-on-40001 burden for every caller) is not
-- needed. The account row is the concurrency domain, and it is exactly the row every
-- writer must lock.
--
-- Three further layers make the result trustworthy even if a lock were somehow
-- bypassed — defence in depth, because a metering bug is silent and expensive:
--   1. UNIQUE CONSTRAINTS carry idempotency. (account_id, request_key) on
--      reservations, (user_id, idempotency_key) on events, (reservation_id, slot_key)
--      on items. A duplicate is a 23505, not a second effect.
--   2. GUARDED STATE TRANSITIONS. Settlement/release/expiry only ever act on rows
--      still in 'pending', and say so in the WHERE clause. A replayed settle matches
--      zero rows and is a no-op by construction, not by an if-statement someone has
--      to remember to write.
--   3. CHECK CONSTRAINTS reject every negative counter and every impossible
--      reserved/used combination. If arithmetic ever went wrong, the transaction
--      ABORTS rather than persisting a corrupt balance. The ledger fails closed.
--
-- Because all of a function's writes happen inside ONE implicit transaction (a
-- Postgres function invoked via RPC runs in the caller's transaction, and PostgREST
-- wraps each call in its own), any error at any point rolls back EVERY statement —
-- including the generation_jobs insert in usage_reserve_generation_job. That
-- all-or-nothing property is what closes the reserve-then-crash-before-enqueue gap,
-- and the DB suite proves it by injecting a failure and observing zero rows in all
-- four tables.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- WHAT IS DELIBERATELY *NOT* HERE
-- ═══════════════════════════════════════════════════════════════════════════════
-- NO PLAN NUMBERS. Not one allowance figure appears in this file. usage_accounts
-- stores SNAPSHOT limits that Phase 3 populates from the entitlement config in the
-- application. Encoding "Starter gets 100 images" in SQL would fork the source of
-- truth: pricing changes would need a migration, and the migration and the config
-- would drift. The database enforces the ARITHMETIC of a limit; the application owns
-- its VALUE. NULL means unlimited.
--
-- NO CRON. usage_expire_reservations exists and is race-tested, but nothing
-- schedules it. Phase 3 decides its cadence.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- CONVENTIONS (follow v51/v53)
-- ═══════════════════════════════════════════════════════════════════════════════
-- Additive + idempotent: create table if not exists / create index if not exists /
-- alter … add column if not exists / create or replace function. Safe to re-run.
--
-- RLS ENABLED with ZERO permissive policies on every new table — only the
-- service-role key (which bypasses RLS) may touch them. A client that could write
-- usage_accounts could grant itself unlimited spend.
--
-- Every function is SECURITY DEFINER with a FIXED search_path (an unqualified
-- search_path in a definer function is a privilege-escalation vector: a caller who
-- can create objects could shadow a table name). Default PUBLIC EXECUTE is REVOKED
-- and granted only to service_role.
--
-- APPLY (test):  py backend/scripts/run_migration.py --apply \
--                  --sql db/migrate_v55_usage_primitives.sql \
--                  --project-ref snulmwprsahzqvdbyenc
-- APPLY (prod):  py backend/scripts/run_migration.py --apply \
--                  --sql db/migrate_v55_usage_primitives.sql

-- ════════════════════════════════════════════════════════════════════════════════
-- TABLES
-- ════════════════════════════════════════════════════════════════════════════════

-- ── usage_accounts — one row per user; the balance of record ────────────────────
-- This row IS the concurrency domain. Every mutating function locks it FOR UPDATE
-- before reading a counter, so all arithmetic on a given user's balances is
-- serialized regardless of how many requests arrive at once.
--
-- WHY *_used AND *_reserved ARE SEPARATE COUNTERS (per allowance type):
--   used     = spend that actually happened and is final.
--   reserved = spend that is in flight — committed against capacity, not yet
--              confirmed. It must be visible to capacity checks (or concurrent
--              requests double-spend) but must NOT be billable (or a failed
--              provider call charges the user).
-- Available capacity is therefore  limit - (used + reserved), and a failed slot
-- decrements `reserved` WITHOUT touching `used`. Collapsing these into one counter
-- makes partial failure unrepresentable.
--
-- WHY LIMITS ARE SNAPSHOTS: the plan's allowance is copied here when the period is
-- established. A mid-period price change must not retroactively alter what an
-- already-charged user was promised, and a capacity check must not have to join a
-- config table that lives in application code. NULL = unlimited (checks skip
-- rejection but still record events, so usage remains observable).
--
-- WHY A BONUS POOL IS SEPARATE FROM THE RECURRING POOL: recurring allowance resets
-- each period; bonus (purchased top-ups / grants) does not. Spending order matters
-- economically — recurring first, so bonus survives to the next period — and refunds
-- must return to the pool they came from. That is only possible if a reservation
-- remembers its per-slot split, which usage_reservation_items records.
create table if not exists usage_accounts (
  id                          uuid        primary key default gen_random_uuid(),
  -- Immutable identity. UNIQUE, so a race to create two accounts for one user
  -- resolves as 23505 rather than a split balance. A trigger below rejects UPDATEs.
  user_id                     uuid        not null unique,
  plan_key                    text        not null,

  -- Billing period this snapshot describes. period_anchor is the stable day-of-cycle
  -- used to roll the period forward without drift.
  period_start                timestamptz not null,
  period_end                  timestamptz not null,
  period_anchor               timestamptz not null,

  -- Set when an account needs human attention (e.g. a webhook arrived out of order
  -- and the derived state is ambiguous). Phase 3 decides the behaviour; the column
  -- exists now so the flag has somewhere to live.
  review_required             boolean     not null default false,

  -- SNAPSHOT LIMITS — NULL MEANS UNLIMITED. Populated from the entitlement config
  -- by the application, never by this migration.
  ai_images_limit             integer,
  ai_text_generations_limit   integer,
  scheduled_posts_limit       integer,

  -- Independent counters per allowance type.
  ai_images_used                  integer not null default 0,
  ai_images_reserved              integer not null default 0,
  ai_text_generations_used        integer not null default 0,
  ai_text_generations_reserved    integer not null default 0,
  scheduled_posts_used            integer not null default 0,
  scheduled_posts_reserved        integer not null default 0,

  -- Bonus image pool: non-expiring balance, spent only after recurring is exhausted.
  bonus_images_balance        integer not null default 0,
  bonus_images_reserved       integer not null default 0,
  bonus_images_used           integer not null default 0,

  -- Optimistic-concurrency counter, bumped on every mutation. Not load-bearing for
  -- correctness (the FOR UPDATE lock is), but it makes "did this row change under
  -- me" answerable to future readers and to the test suite.
  version                     bigint      not null default 0,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);

-- Re-run safety: add any column an older partial apply may have missed.
alter table usage_accounts add column if not exists plan_key                     text;
alter table usage_accounts add column if not exists period_start                 timestamptz;
alter table usage_accounts add column if not exists period_end                   timestamptz;
alter table usage_accounts add column if not exists period_anchor                timestamptz;
alter table usage_accounts add column if not exists review_required              boolean;
alter table usage_accounts add column if not exists ai_images_limit              integer;
alter table usage_accounts add column if not exists ai_text_generations_limit    integer;
alter table usage_accounts add column if not exists scheduled_posts_limit        integer;
alter table usage_accounts add column if not exists ai_images_used               integer;
alter table usage_accounts add column if not exists ai_images_reserved           integer;
alter table usage_accounts add column if not exists ai_text_generations_used     integer;
alter table usage_accounts add column if not exists ai_text_generations_reserved integer;
alter table usage_accounts add column if not exists scheduled_posts_used         integer;
alter table usage_accounts add column if not exists scheduled_posts_reserved     integer;
alter table usage_accounts add column if not exists bonus_images_balance         integer;
alter table usage_accounts add column if not exists bonus_images_reserved        integer;
alter table usage_accounts add column if not exists bonus_images_used            integer;
alter table usage_accounts add column if not exists version                      bigint;
alter table usage_accounts add column if not exists created_at                   timestamptz;
alter table usage_accounts add column if not exists updated_at                   timestamptz;

-- ── Balance sanity, enforced by the database ────────────────────────────────────
-- These are not documentation; they are the last line of defence. If any function
-- below ever computed a negative or impossible balance, the transaction ABORTS and
-- the corrupt state is never persisted. A metering system must fail closed: a
-- refused request is recoverable, a silently wrong balance is not.
--
-- `if not exists` on constraints requires a catalog check (Postgres has no
-- ADD CONSTRAINT IF NOT EXISTS), so each is added defensively in a DO block.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'usage_accounts_counters_non_negative') then
    alter table usage_accounts add constraint usage_accounts_counters_non_negative check (
      ai_images_used               >= 0 and
      ai_images_reserved           >= 0 and
      ai_text_generations_used     >= 0 and
      ai_text_generations_reserved >= 0 and
      scheduled_posts_used         >= 0 and
      scheduled_posts_reserved     >= 0 and
      bonus_images_balance         >= 0 and
      bonus_images_reserved        >= 0 and
      bonus_images_used            >= 0
    );
  end if;

  -- Limits, when present, cannot be negative. NULL (unlimited) is always allowed.
  if not exists (select 1 from pg_constraint where conname = 'usage_accounts_limits_non_negative') then
    alter table usage_accounts add constraint usage_accounts_limits_non_negative check (
      (ai_images_limit           is null or ai_images_limit           >= 0) and
      (ai_text_generations_limit is null or ai_text_generations_limit >= 0) and
      (scheduled_posts_limit     is null or scheduled_posts_limit     >= 0)
    );
  end if;

  -- Bonus reserved can never exceed the bonus balance it is held against: you
  -- cannot have more in-flight bonus spend than bonus you own.
  if not exists (select 1 from pg_constraint where conname = 'usage_accounts_bonus_reserved_within_balance') then
    alter table usage_accounts add constraint usage_accounts_bonus_reserved_within_balance check (
      bonus_images_reserved <= bonus_images_balance
    );
  end if;

  if not exists (select 1 from pg_constraint where conname = 'usage_accounts_period_ordered') then
    alter table usage_accounts add constraint usage_accounts_period_ordered check (period_end > period_start);
  end if;
end $$;

create index if not exists usage_accounts_user_id on usage_accounts (user_id);
create index if not exists usage_accounts_period_end on usage_accounts (period_end);

alter table usage_accounts enable row level security;

-- ── usage_reservations — one in-flight spend intent ─────────────────────────────
-- Covers ai_image and ai_text_generation. Scheduled posts do NOT reserve: publishing
-- is synchronous and either happens or does not, so it uses direct idempotent
-- consumption (usage_consume_scheduled_post) instead. Adding a reservation phase
-- there would create a state that can leak without buying any safety.
--
--   request_key   SERVER-DERIVED idempotency key. Never a client-supplied opaque
--                 string on its own: a client that picks its own key can replay a
--                 cheap key to mask an expensive request. Phase 3 derives it from
--                 (user, operation, normalized request payload).
--   generation_job_id  UNIQUE when present — one reservation per job, so a retried
--                 enqueue cannot attach a second reservation to the same job.
--   *_quantity    requested / consumed / released. requested = consumed + released
--                 once every slot is settled; while pending, the remainder is still
--                 in flight.
--   recurring_reserved_quantity / bonus_reserved_quantity
--                 the reservation-level split, mirrored per slot in
--                 usage_reservation_items. Needed so a refund returns to the pool it
--                 came from.
--   state         pending → settled | released | expired
--   expires_at    after this instant the reservation may be swept. Settlement AFTER
--                 expiry FAILS CLOSED (see usage_settle_reservation_item) — a
--                 restarted worker must never be able to bank output whose capacity
--                 was already returned to the user.
create table if not exists usage_reservations (
  id                          uuid        primary key default gen_random_uuid(),
  account_id                  uuid        not null references usage_accounts (id) on delete cascade,
  user_id                     uuid        not null,
  usage_type                  text        not null,
  operation                   text,
  request_key                 text        not null,
  generation_job_id           uuid        unique,
  requested_quantity          integer     not null,
  consumed_quantity           integer     not null default 0,
  released_quantity           integer     not null default 0,
  recurring_reserved_quantity integer     not null default 0,
  bonus_reserved_quantity     integer     not null default 0,
  state                       text        not null default 'pending',
  reference_id                text,
  metadata                    jsonb       not null default '{}'::jsonb,
  expires_at                  timestamptz not null,
  settled_at                  timestamptz,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  -- THE idempotency anchor: a replayed reserve with the same key is a 23505, which
  -- usage_reserve catches and answers with the ORIGINAL reservation.
  constraint usage_reservations_account_request_key unique (account_id, request_key)
);

alter table usage_reservations add column if not exists operation                   text;
alter table usage_reservations add column if not exists generation_job_id           uuid;
alter table usage_reservations add column if not exists consumed_quantity           integer;
alter table usage_reservations add column if not exists released_quantity           integer;
alter table usage_reservations add column if not exists recurring_reserved_quantity integer;
alter table usage_reservations add column if not exists bonus_reserved_quantity     integer;
alter table usage_reservations add column if not exists reference_id                text;
alter table usage_reservations add column if not exists metadata                    jsonb;
alter table usage_reservations add column if not exists settled_at                  timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'usage_reservations_state_valid') then
    alter table usage_reservations add constraint usage_reservations_state_valid
      check (state in ('pending', 'settled', 'released', 'expired'));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'usage_reservations_type_valid') then
    alter table usage_reservations add constraint usage_reservations_type_valid
      check (usage_type in ('ai_image', 'ai_text_generation'));
  end if;

  -- Quantities are non-negative and can never over-settle: what was consumed plus
  -- what was released can never exceed what was requested.
  if not exists (select 1 from pg_constraint where conname = 'usage_reservations_quantities_sane') then
    alter table usage_reservations add constraint usage_reservations_quantities_sane check (
      requested_quantity          >  0 and
      consumed_quantity           >= 0 and
      released_quantity           >= 0 and
      recurring_reserved_quantity >= 0 and
      bonus_reserved_quantity     >= 0 and
      consumed_quantity + released_quantity <= requested_quantity and
      recurring_reserved_quantity + bonus_reserved_quantity = requested_quantity
    );
  end if;
end $$;

create index if not exists usage_reservations_account_state on usage_reservations (account_id, state);
create index if not exists usage_reservations_expiry_sweep on usage_reservations (expires_at)
  where state = 'pending';
create index if not exists usage_reservations_user on usage_reservations (user_id);

alter table usage_reservations enable row level security;

-- ── usage_reservation_items — per-slot settlement, per-slot pool allocation ─────
-- WHY PER-SLOT AND NOT PER-RESERVATION: a 4-image job routinely ends 2 succeeded /
-- 2 failed. Settling a reservation as a whole would force a choice between charging
-- for failures and refunding successes. Each slot settles independently.
--
-- WHY EACH SLOT CARRIES ITS OWN POOL ALLOCATION: a job can straddle both pools —
-- e.g. 4 images where 3 come from recurring allowance and 1 from the bonus balance.
-- When exactly 2 succeed, the refund must go back to the pool the FAILED slots were
-- drawn from, not to whichever pool is convenient. Storing the split on the
-- reservation alone loses which specific slots were bonus-funded, so a partial
-- settlement could credit the wrong pool — silently, and in the user's disfavour or
-- the business's. These two columns make the allocation a fact rather than a
-- recomputation.
create table if not exists usage_reservation_items (
  id                   uuid        primary key default gen_random_uuid(),
  reservation_id       uuid        not null references usage_reservations (id) on delete cascade,
  slot_key             text        not null,
  state                text        not null default 'pending',
  recurring_quantity   integer     not null default 0,
  bonus_quantity       integer     not null default 0,
  settled_at           timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  -- Idempotency for settlement: a replayed settle for the same slot cannot create a
  -- second item, and the guarded UPDATE below cannot re-settle the existing one.
  constraint usage_reservation_items_slot_unique unique (reservation_id, slot_key)
);

alter table usage_reservation_items add column if not exists recurring_quantity integer;
alter table usage_reservation_items add column if not exists bonus_quantity     integer;
alter table usage_reservation_items add column if not exists settled_at         timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'usage_reservation_items_state_valid') then
    alter table usage_reservation_items add constraint usage_reservation_items_state_valid
      check (state in ('pending', 'succeeded', 'terminal_failed', 'released', 'expired'));
  end if;

  -- Each slot draws from exactly one pool, and draws exactly one unit. Allowing a
  -- slot to span pools would reintroduce the split-refund ambiguity this table
  -- exists to remove.
  if not exists (select 1 from pg_constraint where conname = 'usage_reservation_items_allocation_sane') then
    alter table usage_reservation_items add constraint usage_reservation_items_allocation_sane check (
      recurring_quantity >= 0 and
      bonus_quantity     >= 0 and
      recurring_quantity + bonus_quantity = 1
    );
  end if;
end $$;

create index if not exists usage_reservation_items_reservation on usage_reservation_items (reservation_id);
create index if not exists usage_reservation_items_pending on usage_reservation_items (reservation_id)
  where state = 'pending';

alter table usage_reservation_items enable row level security;

-- ── usage_events — the immutable audit trail ────────────────────────────────────
-- Every balance movement writes exactly one row: reserve, settle, release, expire,
-- consume. balance_before / balance_after make the ledger self-checking — the test
-- suite reconciles event totals against account counters, which is the property that
-- would catch an arithmetic bug no individual assertion thought to look for.
--
-- IMMUTABILITY IS DATABASE-ENFORCED, not a convention (see the trigger below). An
-- audit trail that the application could rewrite is not evidence of anything; the
-- whole value of this table in a billing dispute is that not even a buggy — or
-- malicious — service-role caller can alter history. Corrections are new rows.
create table if not exists usage_events (
  id                uuid        primary key default gen_random_uuid(),
  account_id        uuid        not null references usage_accounts (id) on delete cascade,
  user_id           uuid        not null,
  usage_type        text        not null,
  operation         text        not null,
  quantity          integer     not null,
  source            text        not null default 'system',
  reference_id      text,
  reservation_id    uuid,
  idempotency_key   text        not null,
  balance_before    integer,
  balance_after     integer,
  -- Deliberately "safe" metadata: identifiers and counts only. Never prompts, never
  -- image bytes, never anything that would turn an audit log into a data-retention
  -- liability.
  metadata          jsonb       not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  -- Replay protection that survives concurrency: two simultaneous identical calls
  -- both attempt this insert, one gets 23505, and the caller resolves to the
  -- original effect.
  constraint usage_events_user_idempotency unique (user_id, idempotency_key)
);

alter table usage_events add column if not exists reservation_id uuid;
alter table usage_events add column if not exists balance_before integer;
alter table usage_events add column if not exists balance_after  integer;
alter table usage_events add column if not exists metadata       jsonb;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'usage_events_operation_valid') then
    alter table usage_events add constraint usage_events_operation_valid
      check (operation in ('reserve', 'settle_success', 'settle_failure', 'release', 'expire', 'consume'));
  end if;
end $$;

create index if not exists usage_events_account_created on usage_events (account_id, created_at desc);
create index if not exists usage_events_user_created on usage_events (user_id, created_at desc);
create index if not exists usage_events_reservation on usage_events (reservation_id);

alter table usage_events enable row level security;

-- ── generation_jobs.usage_reservation_id — the job↔reservation link ─────────────
-- Nullable (every job that exists today has no reservation, and Phase 3 may still
-- enqueue unmetered internal jobs) but UNIQUE: one reservation can back at most one
-- job. This is what lets usage_expire_reservations find and terminate the job whose
-- capacity it is about to reclaim.
alter table generation_jobs add column if not exists usage_reservation_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'generation_jobs_usage_reservation_unique'
  ) then
    alter table generation_jobs add constraint generation_jobs_usage_reservation_unique
      unique (usage_reservation_id);
  end if;
end $$;

-- ════════════════════════════════════════════════════════════════════════════════
-- IMMUTABILITY ENFORCEMENT
-- ════════════════════════════════════════════════════════════════════════════════

-- usage_events: append-only, enforced in the database.
-- A BEFORE trigger that raises is used rather than a RULE because it reports a clean
-- error to the client and cannot be bypassed by row-level tricks. Note this binds
-- even the SERVICE ROLE — which is the entire point. Nothing in the system has a
-- legitimate reason to rewrite a billing event, so the ability simply should not
-- exist; corrections are new, compensating rows.
--
-- UPDATE is refused unconditionally. History is never edited.
--
-- DELETE is refused for TARGETED deletes but ALLOWED when the parent usage_accounts
-- row is itself being deleted (an ON DELETE CASCADE erasure of the whole account).
-- That exception is deliberate and is NOT a loophole in the audit trail:
--   * Without it the account row becomes UNDELETABLE — the cascade hits this trigger
--     and aborts — which would make account deletion and GDPR/erasure requests
--     impossible to satisfy. (This was found the hard way: the DB suite's own
--     cleanup could not remove its accounts.)
--   * It cannot be used to doctor a live ledger, because it only permits removing an
--     event whose account is disappearing in the same statement. You cannot delete
--     one inconvenient event and keep the account; the only way through this door is
--     to destroy the entire account and every event it owns.
-- The check is `not exists (select 1 from usage_accounts where id = old.account_id)`:
-- during a cascade the parent is already gone by the time the child trigger fires,
-- so its absence is exactly the signal that this is an erasure and not an edit.
create or replace function usage_events_reject_mutation()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    -- Parent already gone → this is a cascade from an account erasure. Permit.
    if not exists (select 1 from usage_accounts where id = old.account_id) then
      return old;
    end if;
    raise exception
      'usage_events is append-only: DELETE of an event whose account still exists is not permitted. '
      'Record a compensating event instead, or delete the whole usage_accounts row.'
      using errcode = 'restrict_violation';
  end if;

  raise exception
    'usage_events is append-only: % is not permitted. Record a compensating event instead.',
    tg_op
    using errcode = 'restrict_violation';
end;
$$;

drop trigger if exists usage_events_immutable on usage_events;
create trigger usage_events_immutable
  before update or delete on usage_events
  for each row execute function usage_events_reject_mutation();

-- usage_accounts.user_id is immutable: the account identity may never be re-pointed
-- at a different user, or one user's ledger becomes another's.
create or replace function usage_accounts_reject_user_change()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.user_id is distinct from old.user_id then
    raise exception 'usage_accounts.user_id is immutable (attempted % → %)', old.user_id, new.user_id
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists usage_accounts_user_id_immutable on usage_accounts;
create trigger usage_accounts_user_id_immutable
  before update on usage_accounts
  for each row execute function usage_accounts_reject_user_change();

-- ════════════════════════════════════════════════════════════════════════════════
-- RPC SURFACE
-- ════════════════════════════════════════════════════════════════════════════════
-- Every function below is SECURITY DEFINER with a pinned search_path, and every one
-- of them is granted to service_role ONLY (see the REVOKE/GRANT block at the end).
--
-- SHARED SHAPE: each returns a jsonb object with at least {"ok": bool, ...}. jsonb
-- rather than a composite type because PostgREST surfaces it directly as JSON and
-- because the shape can grow in Phase 3 without an ALTER TYPE that would need a
-- coordinated deploy.
--
-- ERROR DISCIPLINE: "you cannot do this" answers (insufficient capacity, expired
-- reservation) return ok=false with a machine-readable `reason`, because callers must
-- branch on them. "You are asking something incoherent" answers (idempotency
-- conflict, unknown account) RAISE, because they indicate a caller bug that must not
-- be silently absorbed — and raising also rolls back any partial work.

-- ── helper: how many of N slots the recurring pool can cover ────────────────────
-- Spend recurring allowance first, then bonus. Recurring resets each period and is
-- therefore "use it or lose it"; bonus persists, so burning bonus while recurring
-- allowance is still available would destroy value the user paid for.
create or replace function usage_recurring_share(
  p_requested integer,
  p_limit     integer,
  p_used      integer,
  p_reserved  integer
)
returns integer
language sql
immutable
set search_path = public, pg_temp
as $fn$
  select case
    -- NULL limit = unlimited: recurring covers everything, bonus is never touched.
    when p_limit is null then p_requested
    else greatest(0, least(p_requested, p_limit - p_used - p_reserved))
  end;
$fn$;

-- ── usage_reserve — move capacity from available to reserved, atomically ────────
--
-- p_slot_keys: one key per unit of the reservation. For images these are the slot
-- identifiers the worker settles individually; text callers pass a single element.
-- The array length IS the requested quantity — deriving quantity from the slots
-- rather than taking both as independent parameters removes a whole class of caller
-- bug where the two disagree.
--
-- IDEMPOTENCY CONTRACT (the subtle half):
--   same request_key + IDENTICAL immutable request  → returns the ORIGINAL result,
--     ok=true, replayed=true. No second reservation, no second event, no second
--     capacity draw. This is what makes a client retry after a network timeout safe.
--   same request_key + DIFFERENT type/quantity/slots/reference → RAISES an
--     idempotency conflict. Deliberate, and not mere fastidiousness: silently
--     returning the first result for a genuinely different request would let a
--     caller's key-derivation bug charge a 1-image reservation for a 10-image job,
--     and nothing downstream would ever notice. A conflict must surface loudly.
create or replace function usage_reserve(
  p_user_id      uuid,
  p_usage_type   text,
  p_slot_keys    text[],
  p_request_key  text,
  p_operation    text        default null,
  p_reference_id text        default null,
  p_expires_at   timestamptz default null,
  p_metadata     jsonb       default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_account        usage_accounts%rowtype;
  v_existing       usage_reservations%rowtype;
  v_quantity       integer;
  v_recurring      integer;
  v_bonus          integer;
  v_available      integer;
  v_limit          integer;
  v_used           integer;
  v_reserved       integer;
  v_reservation_id uuid;
  v_expires        timestamptz;
  v_slot           text;
  v_index          integer := 0;
  v_balance_before integer;
  v_balance_after  integer;
begin
  if p_usage_type not in ('ai_image', 'ai_text_generation') then
    raise exception 'usage_reserve: unsupported usage_type %', p_usage_type
      using errcode = 'invalid_parameter_value';
  end if;

  v_quantity := coalesce(array_length(p_slot_keys, 1), 0);
  if v_quantity <= 0 then
    raise exception 'usage_reserve: p_slot_keys must contain at least one slot'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Duplicate slot keys would make per-slot settlement ambiguous (which of the two
  -- identical slots did the worker just settle?), and the unique constraint would
  -- reject them mid-insert anyway. Fail early with a message that names the cause.
  if v_quantity <> (select count(distinct k) from unnest(p_slot_keys) as k) then
    raise exception 'usage_reserve: p_slot_keys contains duplicates'
      using errcode = 'invalid_parameter_value';
  end if;

  -- ── THE LOCK ────────────────────────────────────────────────────────────────
  -- Everything after this point is serialized per account. A concurrent caller
  -- BLOCKS here and, under READ COMMITTED, then re-reads the row this transaction
  -- commits — so it sees our reservation and cannot re-spend the same capacity.
  select * into v_account from usage_accounts where user_id = p_user_id for update;
  if not found then
    raise exception 'usage_reserve: no usage_accounts row for user %', p_user_id
      using errcode = 'no_data_found';
  end if;

  -- ── Idempotent replay check, INSIDE the lock ────────────────────────────────
  -- Inside, so two simultaneous first-time calls cannot both miss it and both insert.
  select * into v_existing
    from usage_reservations
   where account_id = v_account.id and request_key = p_request_key;

  if found then
    -- Same key: the request must be identical in every immutable respect. The slot
    -- comparison is a FULL OUTER JOIN so that both "caller sent a slot we do not
    -- have" and "we have a slot the caller did not send" are conflicts.
    if v_existing.usage_type is distinct from p_usage_type
       or v_existing.requested_quantity is distinct from v_quantity
       or v_existing.reference_id is distinct from p_reference_id
       or exists (
            select 1
              from (select unnest(p_slot_keys) as k) incoming
              full outer join (
                select slot_key as k from usage_reservation_items
                 where reservation_id = v_existing.id
              ) stored on stored.k = incoming.k
             where incoming.k is null or stored.k is null
          )
    then
      raise exception
        'usage_reserve: idempotency conflict for request_key % — a reservation with this key exists with different inputs',
        p_request_key
        using errcode = 'unique_violation';
    end if;

    return jsonb_build_object(
      'ok', true,
      'replayed', true,
      'reservation_id', v_existing.id,
      'usage_type', v_existing.usage_type,
      'requested_quantity', v_existing.requested_quantity,
      'recurring_quantity', v_existing.recurring_reserved_quantity,
      'bonus_quantity', v_existing.bonus_reserved_quantity,
      'state', v_existing.state
    );
  end if;

  -- ── Capacity check ──────────────────────────────────────────────────────────
  if p_usage_type = 'ai_image' then
    v_limit    := v_account.ai_images_limit;
    v_used     := v_account.ai_images_used;
    v_reserved := v_account.ai_images_reserved;

    v_recurring := usage_recurring_share(v_quantity, v_limit, v_used, v_reserved);
    v_bonus     := v_quantity - v_recurring;

    -- Only images may draw on the bonus pool, and only what is unreserved.
    if v_bonus > (v_account.bonus_images_balance - v_account.bonus_images_reserved) then
      return jsonb_build_object(
        'ok', false,
        'reason', 'insufficient_capacity',
        'usage_type', p_usage_type,
        'requested_quantity', v_quantity,
        'available_recurring',
          case when v_limit is null then null else greatest(0, v_limit - v_used - v_reserved) end,
        'available_bonus', v_account.bonus_images_balance - v_account.bonus_images_reserved
      );
    end if;
    v_balance_before := v_used + v_reserved;
  else
    v_limit    := v_account.ai_text_generations_limit;
    v_used     := v_account.ai_text_generations_used;
    v_reserved := v_account.ai_text_generations_reserved;

    -- Text generation has no bonus pool: it fits in the recurring allowance or it is
    -- refused.
    v_available := case when v_limit is null then v_quantity
                        else greatest(0, v_limit - v_used - v_reserved) end;
    if v_available < v_quantity then
      return jsonb_build_object(
        'ok', false,
        'reason', 'insufficient_capacity',
        'usage_type', p_usage_type,
        'requested_quantity', v_quantity,
        'available_recurring', v_available,
        'available_bonus', 0
      );
    end if;
    v_recurring      := v_quantity;
    v_bonus          := 0;
    v_balance_before := v_used + v_reserved;
  end if;

  v_expires := coalesce(p_expires_at, now() + interval '30 minutes');

  insert into usage_reservations (
    account_id, user_id, usage_type, operation, request_key,
    requested_quantity, recurring_reserved_quantity, bonus_reserved_quantity,
    state, reference_id, metadata, expires_at
  ) values (
    v_account.id, p_user_id, p_usage_type, p_operation, p_request_key,
    v_quantity, v_recurring, v_bonus,
    'pending', p_reference_id, coalesce(p_metadata, '{}'::jsonb), v_expires
  )
  returning id into v_reservation_id;

  -- ── Per-slot pool allocation ────────────────────────────────────────────────
  -- The first v_recurring slots are recurring-funded; the remainder are bonus-funded.
  -- Recording this PER SLOT is precisely what lets a partial settlement later credit
  -- the pool the failed slots actually came from.
  foreach v_slot in array p_slot_keys loop
    v_index := v_index + 1;
    insert into usage_reservation_items (
      reservation_id, slot_key, state, recurring_quantity, bonus_quantity
    ) values (
      v_reservation_id, v_slot, 'pending',
      case when v_index <= v_recurring then 1 else 0 end,
      case when v_index <= v_recurring then 0 else 1 end
    );
  end loop;

  -- ── Move capacity: available → reserved ─────────────────────────────────────
  if p_usage_type = 'ai_image' then
    update usage_accounts
       set ai_images_reserved    = ai_images_reserved + v_recurring,
           bonus_images_reserved = bonus_images_reserved + v_bonus,
           version               = version + 1,
           updated_at            = now()
     where id = v_account.id;
    v_balance_after := v_balance_before + v_recurring;
  else
    update usage_accounts
       set ai_text_generations_reserved = ai_text_generations_reserved + v_quantity,
           version                      = version + 1,
           updated_at                   = now()
     where id = v_account.id;
    v_balance_after := v_balance_before + v_quantity;
  end if;

  insert into usage_events (
    account_id, user_id, usage_type, operation, quantity, source,
    reference_id, reservation_id, idempotency_key, balance_before, balance_after, metadata
  ) values (
    v_account.id, p_user_id, p_usage_type, 'reserve', v_quantity, 'system',
    p_reference_id, v_reservation_id, 'reserve:' || p_request_key,
    v_balance_before, v_balance_after,
    jsonb_build_object('recurring', v_recurring, 'bonus', v_bonus)
  );

  return jsonb_build_object(
    'ok', true,
    'replayed', false,
    'reservation_id', v_reservation_id,
    'usage_type', p_usage_type,
    'requested_quantity', v_quantity,
    'recurring_quantity', v_recurring,
    'bonus_quantity', v_bonus,
    'state', 'pending'
  );
end;
$fn$;

-- ── usage_reserve_generation_job — reserve AND enqueue in ONE transaction ───────
-- WHY THIS EXISTS AS A SEPARATE FUNCTION rather than two calls from the route:
-- reserving and enqueuing from the application means there is an instant between
-- them where the process can die. Crash after reserve → capacity is held for a job
-- that will never run (the user is silently charged for nothing until expiry).
-- Crash between enqueue and reserve (the other order) → an unmetered job runs free.
-- Both statements must be one atomic unit, and only the database can offer that.
--
-- Everything here runs in the caller's single transaction, so if the generation_jobs
-- insert fails for any reason, the reservation, its items and its events are all
-- rolled back with it — there is no partial state to reconcile. p_force_error exists
-- purely so the DB test suite can prove that claim by injecting a failure at the last
-- possible moment and observing that all four tables are empty afterwards.
create or replace function usage_reserve_generation_job(
  p_user_id      uuid,
  p_slot_keys    text[],
  p_request_key  text,
  p_params       jsonb,
  p_operation    text        default 'image_generation',
  p_reference_id text        default null,
  p_expires_at   timestamptz default null,
  p_metadata     jsonb       default '{}'::jsonb,
  p_force_error  boolean     default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_reserve  jsonb;
  v_res_id   uuid;
  v_job_id   uuid;
  v_existing uuid;
begin
  v_reserve := usage_reserve(
    p_user_id      => p_user_id,
    p_usage_type   => 'ai_image',
    p_slot_keys    => p_slot_keys,
    p_request_key  => p_request_key,
    p_operation    => p_operation,
    p_reference_id => p_reference_id,
    p_expires_at   => p_expires_at,
    p_metadata     => p_metadata
  );

  -- Capacity refusal: nothing was reserved, so nothing should be enqueued.
  if not (v_reserve ->> 'ok')::boolean then
    return v_reserve || jsonb_build_object('job_id', null);
  end if;

  v_res_id := (v_reserve ->> 'reservation_id')::uuid;

  -- Replay: the reservation already existed, so the job does too. Return the
  -- original pair rather than enqueuing a second job for the same reservation (the
  -- UNIQUE constraint on generation_jobs.usage_reservation_id would reject it, but
  -- answering with the original is the useful behaviour for a retrying client).
  if (v_reserve ->> 'replayed')::boolean then
    select id into v_existing from generation_jobs where usage_reservation_id = v_res_id;
    return v_reserve || jsonb_build_object('job_id', v_existing);
  end if;

  insert into generation_jobs (vibepin_user_id, status, params, results, usage_reservation_id)
  values (
    p_user_id, 'queued', coalesce(p_params, '{}'::jsonb),
    (
      -- One results entry per requested slot, mirroring the worker's contract.
      select coalesce(jsonb_agg(jsonb_build_object(
               'slot', ordinality - 1, 'status', 'pending', 'imageUrl', null, 'error', null
             ) order by ordinality), '[]'::jsonb)
        from unnest(p_slot_keys) with ordinality
    ),
    v_res_id
  )
  returning id into v_job_id;

  update usage_reservations
     set generation_job_id = v_job_id, updated_at = now()
   where id = v_res_id;

  -- ── Injected failure point (TEST ONLY) ──────────────────────────────────────
  -- Raised AFTER every write above, so a rollback here must undo the reservation,
  -- its items, its events AND the generation_jobs row. If any of those survived,
  -- the atomicity claim in this file's header would be false.
  if p_force_error then
    raise exception 'usage_reserve_generation_job: injected failure after enqueue (test)'
      using errcode = 'raise_exception';
  end if;

  return v_reserve || jsonb_build_object('job_id', v_job_id);
end;
$fn$;

-- ── usage_settle_reservation_item — per-slot outcome ────────────────────────────
-- pending → succeeded  : reserved becomes used (the spend is now final and billable)
-- pending → terminal_failed : reserved is released back to the pool the slot was
--                             drawn from (recurring or bonus, per the item's own
--                             allocation — never "whichever pool is convenient")
--
-- IDEMPOTENT BY GUARD, NOT BY BRANCH: the UPDATE carries `and state = 'pending'`.
-- A replay matches zero rows, so the counter arithmetic below simply never executes.
-- There is no "have I already done this?" check that a future edit could forget.
--
-- LATE SETTLEMENT FAILS CLOSED: if the reservation is no longer 'pending' (expired
-- or released), settlement is REFUSED rather than applied. A worker that was frozen
-- for an hour, or restarted after its lease was swept, must not be able to bank
-- output whose capacity has already been returned to the user — otherwise the same
-- capacity is spent twice and the balance goes negative (which the CHECK constraints
-- would then abort on, turning a metering bug into an outage).
create or replace function usage_settle_reservation_item(
  p_reservation_id uuid,
  p_slot_key       text,
  p_outcome        text,
  p_reference_id   text default null,
  p_metadata       jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_reservation usage_reservations%rowtype;
  v_account     usage_accounts%rowtype;
  v_item        usage_reservation_items%rowtype;
  v_new_state   text;
  v_recurring   integer;
  v_bonus       integer;
  v_remaining   integer;
begin
  if p_outcome not in ('succeeded', 'terminal_failed') then
    raise exception 'usage_settle_reservation_item: outcome must be succeeded or terminal_failed, got %', p_outcome
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_reservation from usage_reservations where id = p_reservation_id;
  if not found then
    raise exception 'usage_settle_reservation_item: unknown reservation %', p_reservation_id
      using errcode = 'no_data_found';
  end if;

  -- Lock the ACCOUNT (not just the item): the counters we are about to move live on
  -- that row, and every other mutator locks it too, so this is what serializes us
  -- against a concurrent reserve/release/expire for the same user.
  select * into v_account from usage_accounts where id = v_reservation.account_id for update;

  -- Re-read the reservation AFTER acquiring the lock. Its state may have changed
  -- while we waited — this is exactly the settle-vs-expire race, and re-reading is
  -- what makes the loser observe the winner's committed outcome rather than a stale
  -- snapshot taken before the queue.
  select * into v_reservation from usage_reservations where id = p_reservation_id;

  select * into v_item
    from usage_reservation_items
   where reservation_id = p_reservation_id and slot_key = p_slot_key;
  if not found then
    raise exception 'usage_settle_reservation_item: unknown slot % on reservation %', p_slot_key, p_reservation_id
      using errcode = 'no_data_found';
  end if;

  -- ORDER MATTERS HERE, and it is the opposite of the obvious one.
  --
  -- The reservation-level refusal is checked BEFORE the slot-level replay report.
  -- When the sweeper expires a reservation it also marks every pending slot
  -- 'expired', so a late settle arrives to find BOTH "reservation is expired" and
  -- "slot is already terminal" true at once. If the slot check came first, the call
  -- would answer ok=true/replayed=true — and a caller branching on `ok` would
  -- conclude its output had been banked when in fact the capacity was handed back to
  -- the user and the image was never billed. The honest answer to a worker that
  -- resumes after its lease was swept is a refusal, not a cheerful replay.
  --
  -- (Nothing is billed either way — the guarded UPDATE below cannot match a
  -- non-pending row — so this is about telling the caller the truth, which is what
  -- lets Phase 3 route late output to a retry rather than silently dropping it.)
  if v_reservation.state <> 'pending' then
    return jsonb_build_object(
      'ok', false,
      'reason', 'reservation_not_pending',
      'reservation_id', p_reservation_id,
      'slot_key', p_slot_key,
      'state', v_reservation.state,
      'slot_state', v_item.state
    );
  end if;

  -- Replay: the reservation is still open but THIS slot already reached a terminal
  -- state (a genuine duplicate settle). Report what happened; change nothing.
  if v_item.state <> 'pending' then
    return jsonb_build_object(
      'ok', true, 'replayed', true,
      'reservation_id', p_reservation_id, 'slot_key', p_slot_key,
      'state', v_item.state
    );
  end if;

  -- Expiry is a deadline, not a suggestion: past expires_at the slot is refused even
  -- if the sweeper has not run yet. Otherwise the outcome would depend on cron timing.
  if v_reservation.expires_at <= now() then
    return jsonb_build_object(
      'ok', false,
      'reason', 'reservation_expired',
      'reservation_id', p_reservation_id,
      'slot_key', p_slot_key,
      'expires_at', v_reservation.expires_at
    );
  end if;

  v_new_state := p_outcome;
  v_recurring := v_item.recurring_quantity;
  v_bonus     := v_item.bonus_quantity;

  -- ── The guarded transition ──────────────────────────────────────────────────
  update usage_reservation_items
     set state = v_new_state, settled_at = now(), updated_at = now()
   where id = v_item.id and state = 'pending';

  if not found then
    -- Someone else settled this slot between our read and our write. Their effect
    -- stands; ours must not be applied on top.
    return jsonb_build_object(
      'ok', true, 'replayed', true,
      'reservation_id', p_reservation_id, 'slot_key', p_slot_key, 'state', 'raced'
    );
  end if;

  if p_outcome = 'succeeded' then
    -- reserved → used, in the SAME pool the slot was drawn from.
    update usage_accounts
       set ai_images_reserved           = ai_images_reserved
                                          - (case when v_reservation.usage_type = 'ai_image' then v_recurring else 0 end),
           ai_images_used               = ai_images_used
                                          + (case when v_reservation.usage_type = 'ai_image' then v_recurring else 0 end),
           bonus_images_reserved        = bonus_images_reserved
                                          - (case when v_reservation.usage_type = 'ai_image' then v_bonus else 0 end),
           bonus_images_used            = bonus_images_used
                                          + (case when v_reservation.usage_type = 'ai_image' then v_bonus else 0 end),
           -- A consumed bonus image leaves the balance for good: bonus is a stock,
           -- not a per-period allowance.
           bonus_images_balance         = bonus_images_balance
                                          - (case when v_reservation.usage_type = 'ai_image' then v_bonus else 0 end),
           ai_text_generations_reserved = ai_text_generations_reserved
                                          - (case when v_reservation.usage_type = 'ai_text_generation' then 1 else 0 end),
           ai_text_generations_used     = ai_text_generations_used
                                          + (case when v_reservation.usage_type = 'ai_text_generation' then 1 else 0 end),
           version                      = version + 1,
           updated_at                   = now()
     where id = v_account.id;

    update usage_reservations
       set consumed_quantity = consumed_quantity + 1, updated_at = now()
     where id = p_reservation_id;
  else
    -- terminal failure: reserved → available, back to the ORIGINATING pool.
    update usage_accounts
       set ai_images_reserved           = ai_images_reserved
                                          - (case when v_reservation.usage_type = 'ai_image' then v_recurring else 0 end),
           bonus_images_reserved        = bonus_images_reserved
                                          - (case when v_reservation.usage_type = 'ai_image' then v_bonus else 0 end),
           ai_text_generations_reserved = ai_text_generations_reserved
                                          - (case when v_reservation.usage_type = 'ai_text_generation' then 1 else 0 end),
           version                      = version + 1,
           updated_at                   = now()
     where id = v_account.id;

    update usage_reservations
       set released_quantity = released_quantity + 1, updated_at = now()
     where id = p_reservation_id;
  end if;

  insert into usage_events (
    account_id, user_id, usage_type, operation, quantity, source,
    reference_id, reservation_id, idempotency_key, balance_before, balance_after, metadata
  ) values (
    v_account.id, v_reservation.user_id, v_reservation.usage_type,
    case when p_outcome = 'succeeded' then 'settle_success' else 'settle_failure' end,
    1, 'system',
    coalesce(p_reference_id, v_reservation.reference_id), p_reservation_id,
    'settle:' || p_reservation_id::text || ':' || p_slot_key,
    null, null,
    coalesce(p_metadata, '{}'::jsonb) || jsonb_build_object('recurring', v_recurring, 'bonus', v_bonus)
  );

  -- When no pending slot remains, the reservation itself is done.
  select count(*) into v_remaining
    from usage_reservation_items
   where reservation_id = p_reservation_id and state = 'pending';

  if v_remaining = 0 then
    update usage_reservations
       set state = 'settled', settled_at = now(), updated_at = now()
     where id = p_reservation_id and state = 'pending';
  end if;

  return jsonb_build_object(
    'ok', true, 'replayed', false,
    'reservation_id', p_reservation_id, 'slot_key', p_slot_key,
    'state', v_new_state,
    'recurring', v_recurring, 'bonus', v_bonus,
    'remaining_pending', v_remaining
  );
end;
$fn$;

-- ── usage_release_reservation — give back everything still pending ──────────────
-- For cancellation, request validation failure, provider rejection, or a synchronous
-- route failure before any slot ran. Slots that already settled are LEFT ALONE: a
-- release must never claw back capacity that was legitimately consumed, nor re-credit
-- a slot that already failed (which would refund the same unit twice).
--
-- Idempotent for the same reason settlement is: the UPDATE is guarded on
-- state = 'pending', so a replay moves nothing and credits nothing.
create or replace function usage_release_reservation(
  p_reservation_id uuid,
  p_reason         text default 'released',
  p_metadata       jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_reservation usage_reservations%rowtype;
  v_account     usage_accounts%rowtype;
  v_recurring   integer := 0;
  v_bonus       integer := 0;
  v_count       integer := 0;
begin
  select * into v_reservation from usage_reservations where id = p_reservation_id;
  if not found then
    raise exception 'usage_release_reservation: unknown reservation %', p_reservation_id
      using errcode = 'no_data_found';
  end if;

  select * into v_account from usage_accounts where id = v_reservation.account_id for update;

  -- Re-read under the lock (see the same note in settle).
  select * into v_reservation from usage_reservations where id = p_reservation_id;

  if v_reservation.state <> 'pending' then
    return jsonb_build_object(
      'ok', true, 'replayed', true,
      'reservation_id', p_reservation_id, 'state', v_reservation.state, 'released_quantity', 0
    );
  end if;

  -- Release every still-pending slot and total what each pool is owed back.
  with released as (
    update usage_reservation_items
       set state = 'released', settled_at = now(), updated_at = now()
     where reservation_id = p_reservation_id and state = 'pending'
    returning recurring_quantity, bonus_quantity
  )
  select coalesce(sum(recurring_quantity), 0), coalesce(sum(bonus_quantity), 0), count(*)
    into v_recurring, v_bonus, v_count
    from released;

  if v_count = 0 then
    update usage_reservations
       set state = 'released', settled_at = now(), updated_at = now()
     where id = p_reservation_id and state = 'pending';
    return jsonb_build_object(
      'ok', true, 'replayed', true,
      'reservation_id', p_reservation_id, 'state', 'released', 'released_quantity', 0
    );
  end if;

  update usage_accounts
     set ai_images_reserved           = ai_images_reserved
                                        - (case when v_reservation.usage_type = 'ai_image' then v_recurring else 0 end),
         bonus_images_reserved        = bonus_images_reserved
                                        - (case when v_reservation.usage_type = 'ai_image' then v_bonus else 0 end),
         ai_text_generations_reserved = ai_text_generations_reserved
                                        - (case when v_reservation.usage_type = 'ai_text_generation' then v_recurring + v_bonus else 0 end),
         version                      = version + 1,
         updated_at                   = now()
   where id = v_account.id;

  update usage_reservations
     set released_quantity = released_quantity + v_count,
         state             = 'released',
         settled_at        = now(),
         updated_at        = now()
   where id = p_reservation_id and state = 'pending';

  insert into usage_events (
    account_id, user_id, usage_type, operation, quantity, source,
    reference_id, reservation_id, idempotency_key, balance_before, balance_after, metadata
  ) values (
    v_account.id, v_reservation.user_id, v_reservation.usage_type, 'release', v_count, 'system',
    v_reservation.reference_id, p_reservation_id,
    'release:' || p_reservation_id::text,
    null, null,
    coalesce(p_metadata, '{}'::jsonb)
      || jsonb_build_object('reason', p_reason, 'recurring', v_recurring, 'bonus', v_bonus)
  );

  return jsonb_build_object(
    'ok', true, 'replayed', false,
    'reservation_id', p_reservation_id, 'state', 'released',
    'released_quantity', v_count, 'recurring', v_recurring, 'bonus', v_bonus
  );
end;
$fn$;

-- ── usage_expire_reservations — sweep abandoned in-flight capacity ──────────────
-- A worker can die mid-job. Without a sweeper the reservation stays 'pending'
-- forever and the user permanently loses that capacity — a silent, unrecoverable
-- overcharge.
--
-- THE LEASE CHECK IS THE WHOLE DIFFICULTY. Reclaiming capacity from a job that is
-- still genuinely running would let the same allowance be spent twice (once by the
-- live worker when it settles, once by whoever reserves next). So a reservation is
-- only swept when no ACTIVE job lease exists: a linked generation_jobs row that is
-- 'running' with a heartbeat inside p_lease_seconds is proof of life and is skipped,
-- however old the reservation looks.
--
-- Swept reservations mark their linked job terminal ('failed'), so a worker that
-- resumes after a long freeze finds a terminal row and cannot publish late output
-- against capacity that has already been given back.
--
-- NOTHING SCHEDULES THIS. It is proven and dormant; Phase 3 chooses the cadence.
create or replace function usage_expire_reservations(
  p_limit         integer default 100,
  p_lease_seconds integer default 300,
  p_now           timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_now       timestamptz := coalesce(p_now, now());
  v_row       record;
  v_recurring integer;
  v_bonus     integer;
  v_count     integer;
  v_expired   integer := 0;
  v_skipped   integer := 0;
  v_ids       uuid[]  := array[]::uuid[];
begin
  for v_row in
    select r.id, r.account_id, r.user_id, r.usage_type, r.reference_id, r.generation_job_id
      from usage_reservations r
     where r.state = 'pending'
       and r.expires_at <= v_now
     order by r.expires_at
     limit greatest(1, coalesce(p_limit, 100))
  loop
    -- Serialize against reserve/settle/release for this account. A settle that is
    -- already in flight holds this lock; we wait, then re-read below and find the
    -- slot no longer pending — so exactly one of the two takes effect.
    perform 1 from usage_accounts where id = v_row.account_id for update;

    -- ACTIVE LEASE = PROOF OF LIFE. Skip; the worker still owns this work.
    if exists (
      select 1 from generation_jobs j
       where j.usage_reservation_id = v_row.id
         and j.status = 'running'
         and j.worker_heartbeat_at is not null
         and j.worker_heartbeat_at > v_now - make_interval(secs => greatest(1, coalesce(p_lease_seconds, 300)))
    ) then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    -- Re-check state under the lock: a concurrent settle/release may have finished
    -- while we queued.
    if not exists (select 1 from usage_reservations where id = v_row.id and state = 'pending') then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    with expired as (
      update usage_reservation_items
         set state = 'expired', settled_at = v_now, updated_at = now()
       where reservation_id = v_row.id and state = 'pending'
      returning recurring_quantity, bonus_quantity
    )
    select coalesce(sum(recurring_quantity), 0), coalesce(sum(bonus_quantity), 0), count(*)
      into v_recurring, v_bonus, v_count
      from expired;

    if v_count = 0 then
      update usage_reservations
         set state = 'expired', settled_at = v_now, updated_at = now()
       where id = v_row.id and state = 'pending';
      v_skipped := v_skipped + 1;
      continue;
    end if;

    update usage_accounts
       set ai_images_reserved           = ai_images_reserved
                                          - (case when v_row.usage_type = 'ai_image' then v_recurring else 0 end),
           bonus_images_reserved        = bonus_images_reserved
                                          - (case when v_row.usage_type = 'ai_image' then v_bonus else 0 end),
           ai_text_generations_reserved = ai_text_generations_reserved
                                          - (case when v_row.usage_type = 'ai_text_generation' then v_recurring + v_bonus else 0 end),
           version                      = version + 1,
           updated_at                   = now()
     where id = v_row.account_id;

    update usage_reservations
       set released_quantity = released_quantity + v_count,
           state             = 'expired',
           settled_at        = v_now,
           updated_at        = now()
     where id = v_row.id and state = 'pending';

    -- Terminate the linked job so a resumed worker cannot publish late output.
    if v_row.generation_job_id is not null then
      update generation_jobs
         set status      = 'failed',
             finished_at = coalesce(finished_at, v_now),
             updated_at  = now()
       where id = v_row.generation_job_id
         and status in ('queued', 'running');
    end if;

    insert into usage_events (
      account_id, user_id, usage_type, operation, quantity, source,
      reference_id, reservation_id, idempotency_key, balance_before, balance_after, metadata
    ) values (
      v_row.account_id, v_row.user_id, v_row.usage_type, 'expire', v_count, 'system',
      v_row.reference_id, v_row.id,
      'expire:' || v_row.id::text,
      null, null,
      jsonb_build_object('recurring', v_recurring, 'bonus', v_bonus)
    );

    v_expired := v_expired + 1;
    v_ids     := v_ids || v_row.id;
  end loop;

  return jsonb_build_object(
    'ok', true, 'expired_count', v_expired, 'skipped_count', v_skipped, 'reservation_ids', to_jsonb(v_ids)
  );
end;
$fn$;

-- ── usage_consume_scheduled_post — direct atomic check-and-consume ──────────────
-- WHY NO RESERVATION PHASE: scheduling a post is synchronous and near-instant. There
-- is no long window during which capacity must be held, so a reserve/settle pair
-- would add a state that can leak (and need sweeping) without buying any safety.
--
-- IDEMPOTENCY IS THE ENTIRE POINT HERE. The publish path retries, and a retry must
-- not charge twice. p_idempotency_key is a server-derived publish-ACTION key; the
-- UNIQUE (user_id, idempotency_key) on usage_events is what enforces one-charge-per-
-- action even under simultaneous duplicate calls — the loser catches 23505 and
-- reports the original effect rather than double-charging.
--
-- UNLIMITED (scheduled_posts_limit IS NULL) SKIPS REJECTION BUT STILL RECORDS EXACTLY
-- ONE EVENT. Usage must stay observable on unlimited plans: that data is how the next
-- pricing decision gets made, and how abuse gets noticed. "Unlimited" is a billing
-- statement, not an instruction to stop counting.
create or replace function usage_consume_scheduled_post(
  p_user_id         uuid,
  p_idempotency_key text,
  p_quantity        integer default 1,
  p_reference_id    text    default null,
  p_metadata        jsonb   default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_account   usage_accounts%rowtype;
  v_existing  usage_events%rowtype;
  v_limit     integer;
  v_used      integer;
  v_reserved  integer;
  v_available integer;
begin
  if coalesce(p_quantity, 0) <= 0 then
    raise exception 'usage_consume_scheduled_post: quantity must be positive, got %', p_quantity
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_account from usage_accounts where user_id = p_user_id for update;
  if not found then
    raise exception 'usage_consume_scheduled_post: no usage_accounts row for user %', p_user_id
      using errcode = 'no_data_found';
  end if;

  -- Replay check inside the lock, so two simultaneous duplicates cannot both miss it.
  select * into v_existing
    from usage_events
   where user_id = p_user_id and idempotency_key = p_idempotency_key;

  if found then
    -- A different quantity under the same key is a caller bug, not a retry.
    if v_existing.quantity is distinct from p_quantity then
      raise exception
        'usage_consume_scheduled_post: idempotency conflict for key % — recorded quantity %, requested %',
        p_idempotency_key, v_existing.quantity, p_quantity
        using errcode = 'unique_violation';
    end if;
    return jsonb_build_object(
      'ok', true, 'replayed', true,
      'event_id', v_existing.id, 'quantity', v_existing.quantity,
      'scheduled_posts_used', v_account.scheduled_posts_used
    );
  end if;

  v_limit    := v_account.scheduled_posts_limit;
  v_used     := v_account.scheduled_posts_used;
  v_reserved := v_account.scheduled_posts_reserved;

  -- NULL limit = unlimited: no rejection, but the event below is still written.
  if v_limit is not null then
    v_available := greatest(0, v_limit - v_used - v_reserved);
    if v_available < p_quantity then
      return jsonb_build_object(
        'ok', false,
        'reason', 'insufficient_capacity',
        'usage_type', 'scheduled_post',
        'requested_quantity', p_quantity,
        'available', v_available
      );
    end if;
  end if;

  update usage_accounts
     set scheduled_posts_used = scheduled_posts_used + p_quantity,
         version              = version + 1,
         updated_at           = now()
   where id = v_account.id;

  insert into usage_events (
    account_id, user_id, usage_type, operation, quantity, source,
    reference_id, reservation_id, idempotency_key, balance_before, balance_after, metadata
  ) values (
    v_account.id, p_user_id, 'scheduled_post', 'consume', p_quantity, 'system',
    p_reference_id, null, p_idempotency_key,
    v_used, v_used + p_quantity,
    coalesce(p_metadata, '{}'::jsonb) || jsonb_build_object('unlimited', v_limit is null)
  );

  return jsonb_build_object(
    'ok', true, 'replayed', false,
    'quantity', p_quantity,
    'unlimited', v_limit is null,
    'scheduled_posts_used', v_used + p_quantity
  );
exception
  when unique_violation then
    -- Lost the race to a simultaneous duplicate that committed first. Its effect
    -- stands; report it rather than charging a second time.
    select * into v_existing
      from usage_events
     where user_id = p_user_id and idempotency_key = p_idempotency_key;
    if found then
      return jsonb_build_object(
        'ok', true, 'replayed', true,
        'event_id', v_existing.id, 'quantity', v_existing.quantity
      );
    end if;
    raise;
end;
$fn$;

-- ════════════════════════════════════════════════════════════════════════════════
-- PRIVILEGES — service_role only
-- ════════════════════════════════════════════════════════════════════════════════
-- Postgres grants EXECUTE on new functions to PUBLIC by default, which would make
-- every RPC above callable by `anon` through PostgREST. Since these are SECURITY
-- DEFINER (they run with the owner's rights and bypass the RLS that protects the
-- tables), a default grant would hand any unauthenticated visitor the ability to
-- mint themselves capacity. REVOKE FIRST, then grant narrowly.
do $grants$
declare
  fn text;
begin
  foreach fn in array array[
    'usage_recurring_share(integer, integer, integer, integer)',
    'usage_reserve(uuid, text, text[], text, text, text, timestamptz, jsonb)',
    'usage_reserve_generation_job(uuid, text[], text, jsonb, text, text, timestamptz, jsonb, boolean)',
    'usage_settle_reservation_item(uuid, text, text, text, jsonb)',
    'usage_release_reservation(uuid, text, jsonb)',
    'usage_expire_reservations(integer, integer, timestamptz)',
    'usage_consume_scheduled_post(uuid, text, integer, text, jsonb)'
  ] loop
    execute format('revoke all on function %s from public', fn);
    execute format('revoke all on function %s from anon', fn);
    execute format('revoke all on function %s from authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end
$grants$;

-- The trigger functions are never called directly by a client; nothing but the
-- trigger machinery needs EXECUTE on them. (They return `trigger`, so PostgREST
-- cannot expose them as RPCs regardless — this is tidiness, not the load-bearing
-- control. Note anon/authenticated must be revoked EXPLICITLY: Supabase grants those
-- roles directly, so revoking from PUBLIC alone leaves the role grant standing.)
revoke all on function usage_events_reject_mutation() from public, anon, authenticated;
revoke all on function usage_accounts_reject_user_change() from public, anon, authenticated;

-- Belt-and-braces: even though RLS with zero policies already blocks anon and
-- authenticated, revoke the table privileges too. RLS and GRANTs are independent
-- gates, and a future migration that adds a permissive policy "just for reads"
-- should not silently open writes as well.
revoke all on table usage_accounts           from anon, authenticated;
revoke all on table usage_reservations       from anon, authenticated;
revoke all on table usage_reservation_items  from anon, authenticated;
revoke all on table usage_events             from anon, authenticated;
