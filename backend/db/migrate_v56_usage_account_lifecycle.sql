-- v56: Usage account lifecycle — initialization, period rollover, plan change.
-- Additive; apply via run_migration.py. Depends on v55 (usage_accounts + usage_events).
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- WHAT PROBLEM THIS SOLVES
-- ═══════════════════════════════════════════════════════════════════════════════
-- v55 landed the usage ledger's SPEND primitives (reserve/settle/release/expire/
-- consume) but deliberately shipped NOTHING that creates or resets an account. Every
-- v55 mutator opens with `select … from usage_accounts where user_id = … for update;
-- if not found raise no_data_found` — so until an account EXISTS with a current
-- period and fresh counters, none of them can run. This migration is that missing
-- lifecycle: the one function that seeds an account, rolls its period when the clock
-- crosses period_end, and lands a plan change — all idempotently, all under the same
-- row lock v55 uses, all proven exactly-once by a period-scoped idempotency key on
-- usage_events.
--
-- ONE FUNCTION, THREE TRANSITIONS. usage_ensure_account is the single entry point.
-- It is called lazily before a metered action AND by the Creem webhook on a
-- subscription cycle. Both callers pass the SAME shape (plan, the three limits, the
-- period, the anchor); the function decides which of three things is true:
--   (1) no account yet          → INSERT + one 'account_init' event
--   (2) account, now >= end      → ROLL the period + one 'period_rollover' event
--   (3) account, still in period → land a plan/limit change + one 'plan_change' event
-- Being one function keeps the "which state am I in" decision inside the FOR UPDATE
-- lock, so two racing first-actions cannot both decide "no account" and both insert.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- EXACTLY-ONCE — THE CRUX
-- ═══════════════════════════════════════════════════════════════════════════════
-- A webhook retries. A lazy-init fires from two concurrent requests. A renewal event
-- is replayed. NONE of these may allocate or reset twice. The guarantee is NOT the
-- webhook's event_id dedup (that is rolled back on failure, and different event_ids
-- fire for one period). It is a PERIOD-SCOPED idempotency key written to usage_events,
-- whose UNIQUE (user_id, idempotency_key) collapses every replay to a single effect:
--
--     alloc:<user_id>:<period_start ISO-8601>
--
-- On INSERT and on ROLLOVER the function writes exactly one usage_events row with this
-- key for the period it just established. If a second call tries to establish the SAME
-- period, the event insert raises 23505 and the whole transaction rolls back — so the
-- account mutation that would have accompanied it is undone too. The key is derived
-- from period_start, which is stable within a period and distinct across periods, so:
--   * re-running ensure inside one period → no new event, no reset (state (3) path
--     only writes on a real change);
--   * rolling into a new period → a NEW key, so the rollover is allowed exactly once;
--   * replaying the rollover → same new key → 23505 → no second reset.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- DRIFT-FREE ROLLOVER MATH
-- ═══════════════════════════════════════════════════════════════════════════════
-- The period advances by WHOLE MONTHS FROM period_anchor — never "now + 1 month",
-- which would let the boundary creep every cycle. We find the smallest whole number
-- of months N such that  anchor + N months  is strictly after now, and set:
--     new period_start = anchor + (N-1) months
--     new period_end   = anchor + N       months
-- (with new_start <= now < new_end). Because every boundary is computed from the
-- ORIGINAL anchor, not from the previous period_start, there is no accumulation error.
--
-- MONTH-LENGTH EDGE CASE (anchor on the 29th/30th/31st): Postgres clamps
-- `timestamptz + interval 'k months'` to the last valid day of the target month
-- (2024-01-31 + 1 month = 2024-02-29). Because we ALWAYS add k months to the fixed
-- anchor, the clamp is not permanent: an anchor on the 31st yields Jan-31, Feb-29,
-- Mar-31, Apr-30, May-31 … the day-of-month is restored the moment the target month is
-- long enough. A "now + 1 month" scheme would instead ratchet the anchor earlier each
-- short month and never recover it — the drift this design exists to prevent.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- WHAT IS PRESERVED VS RESET
-- ═══════════════════════════════════════════════════════════════════════════════
-- ON ROLLOVER: the three recurring pools (ai_images / ai_text_generations /
-- scheduled_posts) reset their *_used AND *_reserved to 0 (a period is a fresh
-- allowance). The BONUS pool (bonus_images_*) is NOT touched — bonus is a purchased,
-- non-expiring stock that must survive period resets by design (v55 header, "bonus
-- persists"). Limits + plan_key are re-snapshotted to the passed values.
--
-- ON A MID-PERIOD PLAN CHANGE (state 3): limits + plan_key are updated but the *_used
-- counters are PRESERVED — an upgrade raises the ceiling, it does not refund consumed
-- usage (frozen contract). Nothing resets. A change writes one 'plan_change' event;
-- an ensure that changes nothing writes no event and is a pure no-op.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- CONVENTIONS (follow v55)
-- ═══════════════════════════════════════════════════════════════════════════════
-- Additive + idempotent (create or replace / alter … if not exists / guarded DO).
-- SECURITY DEFINER with a pinned search_path. Default PUBLIC/anon/authenticated
-- EXECUTE revoked; granted to service_role ONLY. RLS on usage_accounts/usage_events
-- is unchanged (v55 enabled it with zero policies; this migration adds no policy).
--
-- APPLY (test):  py backend/scripts/run_migration.py --apply \
--                  --sql db/migrate_v56_usage_account_lifecycle.sql \
--                  --project-ref snulmwprsahzqvdbyenc
-- APPLY (prod):  py backend/scripts/run_migration.py --apply \
--                  --sql db/migrate_v56_usage_account_lifecycle.sql
--   (prod apply is the OWNER's call — not part of this change.)

-- ════════════════════════════════════════════════════════════════════════════════
-- EXTEND THE usage_events OPERATION VOCABULARY
-- ════════════════════════════════════════════════════════════════════════════════
-- v55's usage_events_operation_valid CHECK allows only the SPEND operations
-- (reserve/settle_success/settle_failure/release/expire/consume). The lifecycle
-- events written below need three new verbs. Postgres has no ADD CONSTRAINT IF NOT
-- EXISTS, and re-running must be safe, so drop-if-exists then add the superset. The
-- superset still allows every v55 value, so existing rows always satisfy it.
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'usage_events_operation_valid') then
    alter table usage_events drop constraint usage_events_operation_valid;
  end if;
  alter table usage_events add constraint usage_events_operation_valid
    check (operation in (
      -- v55 spend operations
      'reserve', 'settle_success', 'settle_failure', 'release', 'expire', 'consume',
      -- v56 lifecycle operations
      'account_init', 'period_rollover', 'plan_change'
    ));
end $$;

-- ════════════════════════════════════════════════════════════════════════════════
-- usage_ensure_account — seed / roll / plan-change, idempotently
-- ════════════════════════════════════════════════════════════════════════════════
-- p_period_start / p_period_end describe the period the CALLER believes is current
-- (for a paid plan: the Creem subscription's current_period_start/end; for free: a
-- monthly window anchored on signup). They are used ONLY on INSERT — once an account
-- exists, the period is owned by the anchor + rollover math here, not by whatever the
-- caller passes, so a slightly stale caller period cannot corrupt an existing account.
--
-- p_period_anchor is the stable day-of-cycle the rollover advances from. On INSERT it
-- is stored as-is; it is treated as IMMUTABLE thereafter (an account never re-anchors,
-- or its whole period history would shift).
--
-- Returns jsonb {ok, action: 'created'|'rolled'|'plan_changed'|'noop', account_id,
-- plan_key, period_start, period_end, version, rolled_periods}.
create or replace function usage_ensure_account(
  p_user_id              uuid,
  p_plan_key             text,
  p_ai_images_limit      integer,
  p_ai_text_limit        integer,
  p_scheduled_posts_limit integer,
  p_period_start         timestamptz,
  p_period_end           timestamptz,
  p_period_anchor        timestamptz,
  p_review_required      boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_account       usage_accounts%rowtype;
  v_now           timestamptz := now();
  v_anchor        timestamptz;
  v_months        integer;
  v_new_start     timestamptz;
  v_new_end       timestamptz;
  v_rolled        integer := 0;
  v_old_months    integer;
  v_key           text;
  v_changed       boolean;
begin
  if p_plan_key is null or btrim(p_plan_key) = '' then
    raise exception 'usage_ensure_account: p_plan_key is required'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_period_end <= p_period_start then
    raise exception 'usage_ensure_account: p_period_end (%) must be after p_period_start (%)',
      p_period_end, p_period_start
      using errcode = 'invalid_parameter_value';
  end if;

  -- ── Take the row lock (or discover there is no row yet) ─────────────────────────
  -- Serializes against every v55 mutator and against a concurrent ensure. Two racing
  -- first-actions queue here; the loser re-reads the winner's committed row below.
  select * into v_account from usage_accounts where user_id = p_user_id for update;

  -- ══════════════════════════════════════════════════════════════════════════════
  -- STATE 1 — NO ACCOUNT: insert it, write one account_init event.
  -- ══════════════════════════════════════════════════════════════════════════════
  if not found then
    begin
      insert into usage_accounts (
        user_id, plan_key, period_start, period_end, period_anchor, review_required,
        ai_images_limit, ai_text_generations_limit, scheduled_posts_limit
      ) values (
        p_user_id, p_plan_key, p_period_start, p_period_end, p_period_anchor,
        coalesce(p_review_required, false),
        p_ai_images_limit, p_ai_text_limit, p_scheduled_posts_limit
      )
      returning * into v_account;
    exception
      when unique_violation then
        -- A concurrent ensure created the row between our SELECT and this INSERT (the
        -- user_id UNIQUE fired). Re-read it under the lock and fall through to the
        -- present-account paths so the two racers converge on ONE account.
        select * into v_account from usage_accounts where user_id = p_user_id for update;
        -- fall through (no RETURN) into the STATE 2/3 evaluation below.
    end;

    -- Only when WE actually inserted (v_account.version = 0 and the row was created by
    -- this statement) do we emit the init event. The idempotency key makes even that
    -- safe under the race: if the concurrent winner already wrote it, our insert 23505s
    -- and the whole transaction rolls back — including our account INSERT — leaving the
    -- winner's single account + single event.
    if not exists (
      select 1 from usage_events
       where user_id = p_user_id
         and idempotency_key = 'alloc:' || p_user_id::text || ':' ||
             to_char(v_account.period_start at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
    ) then
      insert into usage_events (
        account_id, user_id, usage_type, operation, quantity, source,
        idempotency_key, metadata
      ) values (
        v_account.id, p_user_id, 'account', 'account_init', 0, 'system',
        'alloc:' || p_user_id::text || ':' ||
          to_char(v_account.period_start at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        jsonb_build_object(
          'plan_key', v_account.plan_key,
          'period_start', v_account.period_start,
          'period_end', v_account.period_end,
          'ai_images_limit', v_account.ai_images_limit,
          'ai_text_generations_limit', v_account.ai_text_generations_limit,
          'scheduled_posts_limit', v_account.scheduled_posts_limit
        )
      );

      return jsonb_build_object(
        'ok', true, 'action', 'created', 'account_id', v_account.id,
        'plan_key', v_account.plan_key,
        'period_start', v_account.period_start, 'period_end', v_account.period_end,
        'version', v_account.version, 'rolled_periods', 0
      );
    end if;
    -- If the init event already existed, WE were the racer — fall through and treat
    -- the row as an existing account (states 2/3).
  end if;

  -- ══════════════════════════════════════════════════════════════════════════════
  -- STATE 2 — ACCOUNT PAST period_end: roll forward to the current period.
  -- ══════════════════════════════════════════════════════════════════════════════
  if v_now >= v_account.period_end then
    v_anchor := v_account.period_anchor;

    -- Smallest whole month count N with anchor + N months > now. Guard the loop so a
    -- pathological anchor far in the future cannot spin (start from at least 1 so we
    -- always advance at least one boundary past the stale period).
    v_months := 1;
    while v_anchor + make_interval(months => v_months) <= v_now loop
      v_months := v_months + 1;
      -- Safety valve: 1200 months = 100 years. If the anchor is so stale this trips,
      -- something is badly wrong upstream; fail closed rather than loop forever.
      if v_months > 1200 then
        raise exception 'usage_ensure_account: rollover exceeded 1200 months for user % (anchor %, now %)',
          p_user_id, v_anchor, v_now
          using errcode = 'raise_exception';
      end if;
    end loop;

    v_new_start := v_anchor + make_interval(months => v_months - 1);
    v_new_end   := v_anchor + make_interval(months => v_months);

    -- rolled_periods (observability only): how many whole period boundaries we crossed
    -- from the stale period_start to the new one. Both are anchor + k months, so the
    -- difference in k values is exact — no fractional-age fragility. Find the old
    -- period's month index by walking the same anchor (bounded; a dormant account may
    -- have crossed several boundaries). 1 = the normal single-cycle rollover.
    v_old_months := 0;
    while v_anchor + make_interval(months => v_old_months) < v_account.period_start loop
      v_old_months := v_old_months + 1;
      exit when v_old_months > 1200;
    end loop;
    v_rolled := (v_months - 1) - v_old_months;  -- >= 0

    v_key := 'alloc:' || p_user_id::text || ':' ||
             to_char(v_new_start at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');

    -- The rollover event is written FIRST. Its UNIQUE (user_id, idempotency_key) is the
    -- exactly-once gate: a replayed rollover for this same new period raises 23505 here,
    -- which rolls back the counter reset below with it. So the reset happens at most
    -- once per period, no matter how many callers race or retry.
    insert into usage_events (
      account_id, user_id, usage_type, operation, quantity, source,
      idempotency_key, metadata
    ) values (
      v_account.id, p_user_id, 'account', 'period_rollover', 0, 'system',
      v_key,
      jsonb_build_object(
        'plan_key', p_plan_key,
        'previous_period_start', v_account.period_start,
        'previous_period_end', v_account.period_end,
        'period_start', v_new_start,
        'period_end', v_new_end,
        'skipped_periods', greatest(0, v_rolled)
      )
    );
    -- (v_rolled is derived from anchor-relative month indices above; clamp defensively.)

    -- Reset recurring pools; re-snapshot limits + plan_key; advance the period; bump
    -- version. BONUS POOL IS UNTOUCHED (bonus survives period resets).
    update usage_accounts
       set plan_key                     = p_plan_key,
           period_start                 = v_new_start,
           period_end                   = v_new_end,
           review_required              = coalesce(p_review_required, review_required),
           ai_images_limit              = p_ai_images_limit,
           ai_text_generations_limit    = p_ai_text_limit,
           scheduled_posts_limit        = p_scheduled_posts_limit,
           ai_images_used               = 0,
           ai_images_reserved           = 0,
           ai_text_generations_used     = 0,
           ai_text_generations_reserved = 0,
           scheduled_posts_used         = 0,
           scheduled_posts_reserved     = 0,
           version                      = version + 1,
           updated_at                   = now()
     where id = v_account.id
     returning * into v_account;

    return jsonb_build_object(
      'ok', true, 'action', 'rolled', 'account_id', v_account.id,
      'plan_key', v_account.plan_key,
      'period_start', v_account.period_start, 'period_end', v_account.period_end,
      'version', v_account.version, 'rolled_periods', greatest(0, v_rolled) + 1
    );
    -- rolled_periods = skipped_periods + 1 (the +1 is the boundary we just landed on).
  end if;

  -- ══════════════════════════════════════════════════════════════════════════════
  -- STATE 3 — ACCOUNT WITHIN period: land a plan/limit change, preserving *_used.
  -- ══════════════════════════════════════════════════════════════════════════════
  v_changed :=
       v_account.plan_key                  is distinct from p_plan_key
    or v_account.ai_images_limit           is distinct from p_ai_images_limit
    or v_account.ai_text_generations_limit is distinct from p_ai_text_limit
    or v_account.scheduled_posts_limit     is distinct from p_scheduled_posts_limit;

  if not v_changed then
    -- Pure no-op: same plan, same limits, still in period. No event, no version bump.
    return jsonb_build_object(
      'ok', true, 'action', 'noop', 'account_id', v_account.id,
      'plan_key', v_account.plan_key,
      'period_start', v_account.period_start, 'period_end', v_account.period_end,
      'version', v_account.version, 'rolled_periods', 0
    );
  end if;

  -- A change lands. *_used and *_reserved are PRESERVED (frozen contract: a mid-cycle
  -- upgrade keeps consumed usage, only the ceiling moves). The idempotency key folds in
  -- the target limits so re-applying the SAME change is a no-op (23505 → caught below),
  -- while a genuinely different later change (new key) still lands.
  v_key := 'plan_change:' || p_user_id::text || ':' ||
           to_char(v_account.period_start at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') || ':' ||
           p_plan_key || ':' ||
           coalesce(p_ai_images_limit::text, 'null') || '/' ||
           coalesce(p_ai_text_limit::text, 'null') || '/' ||
           coalesce(p_scheduled_posts_limit::text, 'null');

  -- Idempotent replay guard: if this exact change was already recorded this period,
  -- do nothing (a retried webhook for the same upgrade).
  if exists (
    select 1 from usage_events where user_id = p_user_id and idempotency_key = v_key
  ) then
    return jsonb_build_object(
      'ok', true, 'action', 'noop', 'account_id', v_account.id,
      'plan_key', v_account.plan_key,
      'period_start', v_account.period_start, 'period_end', v_account.period_end,
      'version', v_account.version, 'rolled_periods', 0
    );
  end if;

  insert into usage_events (
    account_id, user_id, usage_type, operation, quantity, source,
    idempotency_key, metadata
  ) values (
    v_account.id, p_user_id, 'account', 'plan_change', 0, 'system',
    v_key,
    jsonb_build_object(
      'previous_plan_key', v_account.plan_key,
      'plan_key', p_plan_key,
      'previous_ai_images_limit', v_account.ai_images_limit,
      'ai_images_limit', p_ai_images_limit,
      'previous_ai_text_generations_limit', v_account.ai_text_generations_limit,
      'ai_text_generations_limit', p_ai_text_limit,
      'previous_scheduled_posts_limit', v_account.scheduled_posts_limit,
      'scheduled_posts_limit', p_scheduled_posts_limit
    )
  );

  update usage_accounts
     set plan_key                  = p_plan_key,
         ai_images_limit           = p_ai_images_limit,
         ai_text_generations_limit = p_ai_text_limit,
         scheduled_posts_limit     = p_scheduled_posts_limit,
         review_required           = coalesce(p_review_required, review_required),
         version                   = version + 1,
         updated_at                = now()
   where id = v_account.id
   returning * into v_account;

  return jsonb_build_object(
    'ok', true, 'action', 'plan_changed', 'account_id', v_account.id,
    'plan_key', v_account.plan_key,
    'period_start', v_account.period_start, 'period_end', v_account.period_end,
    'version', v_account.version, 'rolled_periods', 0
  );
end;
$fn$;

-- ════════════════════════════════════════════════════════════════════════════════
-- PRIVILEGES — service_role only (same discipline as v55)
-- ════════════════════════════════════════════════════════════════════════════════
do $grants$
declare
  fn text := 'usage_ensure_account(uuid, text, integer, integer, integer, timestamptz, timestamptz, timestamptz, boolean)';
begin
  execute format('revoke all on function %s from public', fn);
  execute format('revoke all on function %s from anon', fn);
  execute format('revoke all on function %s from authenticated', fn);
  execute format('grant execute on function %s to service_role', fn);
end
$grants$;
