-- v67: scheduled-post RELEASE (refund) + consume key re-arming.
-- Apply with backend/scripts/run_migration.py --apply (Management API).
-- NOT APPLIED YET to production: authored only; the owner applies this deliberately.
--
-- ADDITIVE AND IDEMPOTENT. This migration touches NO table, NO column, NO CHECK
-- constraint and NO index. It contains exactly two `create or replace function`
-- statements plus the privilege block the new function needs. Re-applying it is a
-- no-op by construction — `or replace` writes the same body over itself — so there
-- is no "already applied" hazard and no `if not exists` guard to write.
-- `usage_events.operation`'s CHECK already permits 'release' (v55), which is why
-- no DDL is required to record a refund.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- WHY A REFUND PATH EXISTS AT ALL (PRD v3.2 §5.3/§5.4, decisions #4 and #8)
-- ═══════════════════════════════════════════════════════════════════════════════
-- v55's usage_consume_scheduled_post charges BEFORE the provider call, on purpose:
-- a crash mid-publish must still record the action the user took. The cost of that
-- ordering is that a publish which never reached the provider — or which the
-- provider rejected outright without creating anything — was charged anyway. The
-- product rule (fixed, not a technical choice):
--
--   not_sent          the request never left us (validation, board not owned, not
--                     connected, needs reconnect, locally blocked)      → REFUND
--   rejected          provider answered 4xx and created NOTHING (no
--                     resource id in the response)                      → REFUND
--   sent              provider returned a resource (201 / a pin id)     → CHARGE
--                     (even if OUR persist afterwards failed)
--   delivery_unknown  timeout, 5xx, connection reset, crash before the
--                     response was read                                → CHARGE,
--                     never refunded and never re-charged. Deliberately errs
--                     against the customer: "my request timed out" must not become
--                     a free-publish bypass, because it is trivially reproducible.
--
--   published again after a refund                                     → CHARGE AGAIN
--
-- That last line is what forces the second half of this migration.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- THE CONFLICT THIS SOLVES: IDEMPOTENCY vs. RE-CHARGE
-- ═══════════════════════════════════════════════════════════════════════════════
-- The caller's idempotency key K is derived from (user, draft, scheduled_at | UTC
-- day bucket) — deliberately NOT from the attempt, because the cron publisher is
-- at-least-once: a process death between "Pinterest created the pin" and "we
-- persisted the success" re-claims the SAME row and must NOT charge twice. That
-- collapsing is load-bearing and stays (decision 5.3).
--
-- But it directly contradicts "refunded, then published successfully → charge
-- again": the second publish arrives under the SAME K, sees the original consume
-- event still sitting in usage_events, and reports a replay — no charge.
--
-- The fix is a KEY FAMILY, resolved INSIDE the RPC so no caller changes:
--
--     n  := how many releases the family K already has
--     K_eff := K              when n = 0     (identical to today's behaviour)
--            := K || ':r' || n when n > 0
--
-- so the ledger of one draft that was charged, refunded, charged, refunded, and
-- finally charged looks like:
--
--     K            consume   (attempt 1)
--     K:release:1  release   (attempt 1 refunded)
--     K:r1         consume   (attempt 2 — a NEW charge, not a replay of K)
--     K:release:2  release   (attempt 2 refunded)
--     K:r2         consume   (attempt 3 — charged, stands)
--
-- Within any single attempt, replays still collapse exactly as before: a cron
-- re-claim during attempt 2 recomputes n = 1, lands on K:r1 again, finds the
-- existing event, and returns replayed.
--
-- WHY THE RPC OWNS THE ATTEMPT NUMBER AND NOT THE CALLER: no caller has a reliable
-- one. The cron re-claim MUST reuse the previous attempt's key (that is the whole
-- point), and a client retry has no counter at all. Deriving n from the ledger
-- itself — under the same row lock as the charge — is the only place the answer is
-- both available and race-free.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- CONCURRENCY
-- ═══════════════════════════════════════════════════════════════════════════════
-- Both functions take `usage_accounts ... for update` FIRST, before counting the
-- family, in the SAME lock order v55's consume already uses. Two simultaneous
-- calls therefore serialize on the account row and can never compute the same n:
-- the loser sees the winner's event. The unique_violation handlers below are the
-- second line of defence for the case where a concurrent transaction commits an
-- event between the count and the insert.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- @verify (run after apply)
-- ═══════════════════════════════════════════════════════════════════════════════
--   -- both functions exist:
--   select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public'
--      and p.proname in ('usage_consume_scheduled_post', 'usage_release_scheduled_post');
--   -- expected: 2
--
--   -- consume really carries the re-arming (the ':r' suffix) and release the
--   -- ':release:' key namespace:
--   select pg_get_functiondef('usage_consume_scheduled_post(uuid, text, integer, text, jsonb)'::regprocedure)
--          like '%'':r''%' as consume_rearmed;
--   -- expected: true
--   select pg_get_functiondef('usage_release_scheduled_post(uuid, text, text, text, jsonb)'::regprocedure)
--          like '%:release:%' as release_namespaced;
--   -- expected: true
--
--   -- and the new function is NOT callable by anon/authenticated (it is SECURITY
--   -- DEFINER — a public grant would be a self-serve refund hole):
--   select has_function_privilege('anon', 'usage_release_scheduled_post(uuid, text, text, text, jsonb)', 'execute');
--   -- expected: false

-- ════════════════════════════════════════════════════════════════════════════════
-- usage_release_scheduled_post — refund ONE scheduled-post unit, idempotently
-- ════════════════════════════════════════════════════════════════════════════════
-- Returns (never raises for ordinary "nothing to do" outcomes):
--   {ok:false, reason:'nothing_to_release'}   no un-released consume under family K
--   {ok:true,  replayed:true,  ...}           this attempt was already refunded
--   {ok:true,  replayed:false, scheduled_posts_used:<n>}   refunded now
--
-- RAISES only on a caller bug: an unknown p_reason. A refund reason that is not
-- one of the two the product defines means the mapping table in the route drifted,
-- and silently accepting it would quietly refund things the product says to charge
-- for. Fail loudly instead — the TS wrapper is fail-open, so a raise here costs a
-- log line, never a publish.
create or replace function usage_release_scheduled_post(
  p_user_id         uuid,
  p_idempotency_key text,
  p_reason          text,
  p_reference_id    text  default null,
  p_metadata        jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_account      usage_accounts%rowtype;
  v_consume      usage_events%rowtype;
  v_existing     usage_events%rowtype;
  v_releases     integer;
  v_consume_key  text;
  v_release_key  text;
  v_quantity     integer;
  v_used         integer;
begin
  -- The two reasons the product recognises. Anything else is a wiring mistake.
  if p_reason is null or p_reason not in ('not_sent', 'rejected') then
    raise exception 'usage_release_scheduled_post: unsupported reason %, expected not_sent or rejected', p_reason
      using errcode = 'invalid_parameter_value';
  end if;

  if p_idempotency_key is null or length(trim(p_idempotency_key)) = 0 then
    raise exception 'usage_release_scheduled_post: idempotency key is required'
      using errcode = 'invalid_parameter_value';
  end if;

  -- SAME LOCK ORDER AS CONSUME: the account row first, then read the family. Doing
  -- it the other way round would let a concurrent consume slip a new event in
  -- between the count and the decrement.
  select * into v_account from usage_accounts where user_id = p_user_id for update;
  if not found then
    -- No ledger account at all: there is demonstrably nothing to give back. Not an
    -- error — a shadow-mode user whose account row was never provisioned would
    -- otherwise turn every failed publish into a logged exception.
    return jsonb_build_object('ok', false, 'reason', 'nothing_to_release');
  end if;

  -- How many refunds this family has already had. K is a 48-char hex digest (see
  -- deriveScheduledPostKey), so it carries no LIKE metacharacters and needs no
  -- escaping; the ':release:' infix cannot collide with a consume key.
  select count(*) into v_releases
    from usage_events
   where user_id = p_user_id
     and idempotency_key like p_idempotency_key || ':release:%';

  -- The attempt currently standing: attempt 1 is keyed K, attempt n+1 is K:r<n>.
  v_consume_key := case when v_releases = 0 then p_idempotency_key
                        else p_idempotency_key || ':r' || v_releases::text end;
  v_release_key := p_idempotency_key || ':release:' || (v_releases + 1)::text;

  select * into v_consume
    from usage_events
   where user_id = p_user_id
     and idempotency_key = v_consume_key
     and operation = 'consume';

  if not found then
    -- Two distinct situations, told apart by whether this family was ever refunded:
    --   v_releases > 0 → every charge so far has already been given back. A repeated
    --                    release call (the fail-open TS wrapper retrying, or a cron
    --                    re-claim re-reporting the same failure) must be a no-op, NOT
    --                    a second decrement.
    --   v_releases = 0 → nothing was ever charged under K. Common and harmless: the
    --                    publish failed while metering was off, or before the consume
    --                    ran at all (e.g. an enforce-mode refusal).
    if v_releases > 0 then
      return jsonb_build_object(
        'ok', true, 'replayed', true,
        'reason', 'already_released',
        'releases', v_releases,
        'scheduled_posts_used', v_account.scheduled_posts_used
      );
    end if;
    return jsonb_build_object('ok', false, 'reason', 'nothing_to_release');
  end if;

  -- Defence in depth: if the release event for THIS attempt somehow already exists
  -- (a partially-visible concurrent transaction), report the replay rather than
  -- decrementing twice.
  select * into v_existing
    from usage_events
   where user_id = p_user_id and idempotency_key = v_release_key;
  if found then
    return jsonb_build_object(
      'ok', true, 'replayed', true,
      'event_id', v_existing.id,
      'scheduled_posts_used', v_account.scheduled_posts_used
    );
  end if;

  v_quantity := greatest(1, coalesce(v_consume.quantity, 1));
  v_used     := v_account.scheduled_posts_used;

  -- greatest(0, …): the counter is also reset by the period roll (v56), so a refund
  -- of a charge made in a previous period must never drive it negative.
  update usage_accounts
     set scheduled_posts_used = greatest(0, scheduled_posts_used - v_quantity),
         version              = version + 1,
         updated_at           = now()
   where id = v_account.id;

  insert into usage_events (
    account_id, user_id, usage_type, operation, quantity, source,
    reference_id, reservation_id, idempotency_key, balance_before, balance_after, metadata
  ) values (
    v_account.id, p_user_id, 'scheduled_post', 'release', v_quantity, 'system',
    coalesce(p_reference_id, v_consume.reference_id), null, v_release_key,
    v_used, greatest(0, v_used - v_quantity),
    coalesce(p_metadata, '{}'::jsonb) || jsonb_build_object(
      'reason', p_reason,
      'released_consume_key', v_consume_key,
      'attempt', v_releases + 1
    )
  );

  return jsonb_build_object(
    'ok', true, 'replayed', false,
    'reason', p_reason,
    'quantity', v_quantity,
    'released_consume_key', v_consume_key,
    'attempt', v_releases + 1,
    'scheduled_posts_used', greatest(0, v_used - v_quantity)
  );
exception
  when unique_violation then
    -- A simultaneous duplicate committed the same release key first. Its effect
    -- stands (including its decrement); report the replay rather than refunding a
    -- second time. Mirrors v55's consume handler.
    select * into v_existing
      from usage_events
     where user_id = p_user_id and idempotency_key = v_release_key;
    if found then
      return jsonb_build_object('ok', true, 'replayed', true, 'event_id', v_existing.id);
    end if;
    raise;
end;
$fn$;

-- ════════════════════════════════════════════════════════════════════════════════
-- usage_consume_scheduled_post — v55's function, with key-family re-arming
-- ════════════════════════════════════════════════════════════════════════════════
-- SIGNATURE AND SEMANTICS ARE UNCHANGED from v55. The only difference is that the
-- key the ledger actually stores is `v_key_eff` (K, or K:r<n> once the family has
-- been refunded n times) instead of `p_idempotency_key` verbatim. Everything else —
-- the lock, the replay check, the quantity-conflict raise, the unlimited branch,
-- the insufficient_capacity refusal, the unique_violation handler — is byte-for-byte
-- the v55 behaviour, deliberately: this function is covered by an existing real-
-- Postgres suite that pins even its known defect (a quantity-mismatch raise being
-- swallowed by its own unique_violation handler), and quietly "improving" that here
-- would make an unrelated regression look like this migration's intent.
--
-- Callers pass the SAME K they always did. n is derived here, under the account
-- lock, so cron re-claims and client retries within one attempt still collapse.
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
  v_releases  integer;
  v_key_eff   text;
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

  -- v67 RE-ARMING: which attempt of this key family are we on? Counted under the
  -- account lock taken above, so a concurrent release cannot change the answer
  -- mid-flight. n = 0 → the historical single-key behaviour, unchanged.
  select count(*) into v_releases
    from usage_events
   where user_id = p_user_id
     and idempotency_key like p_idempotency_key || ':release:%';
  v_key_eff := case when v_releases = 0 then p_idempotency_key
                    else p_idempotency_key || ':r' || v_releases::text end;

  -- Replay check inside the lock, so two simultaneous duplicates cannot both miss it.
  select * into v_existing
    from usage_events
   where user_id = p_user_id and idempotency_key = v_key_eff;

  if found then
    -- A different quantity under the same key is a caller bug, not a retry.
    if v_existing.quantity is distinct from p_quantity then
      raise exception
        'usage_consume_scheduled_post: idempotency conflict for key % — recorded quantity %, requested %',
        v_key_eff, v_existing.quantity, p_quantity
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
    p_reference_id, null, v_key_eff,
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
     where user_id = p_user_id and idempotency_key = v_key_eff;
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
-- PRIVILEGES — service_role only (same reasoning as v55's grants block)
-- ════════════════════════════════════════════════════════════════════════════════
-- Postgres grants EXECUTE on a NEW function to PUBLIC by default, which would make
-- usage_release_scheduled_post callable by `anon` through PostgREST. It is SECURITY
-- DEFINER, so that default would hand any unauthenticated visitor a self-serve
-- quota refund. REVOKE first, then grant narrowly.
--
-- usage_consume_scheduled_post keeps the ACL v55 gave it (`create or replace`
-- preserves privileges), but it is re-stated here so a fresh database built from
-- these files in any order still ends up with both functions locked down.
do $grants$
declare
  fn text;
begin
  foreach fn in array array[
    'usage_release_scheduled_post(uuid, text, text, text, jsonb)',
    'usage_consume_scheduled_post(uuid, text, integer, text, jsonb)'
  ] loop
    execute format('revoke all on function %s from public', fn);
    execute format('revoke all on function %s from anon', fn);
    execute format('revoke all on function %s from authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end
$grants$;
