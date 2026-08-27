/**
 * ONE rule for "may this user connect another social account?" — the plan's
 * included accounts per platform PLUS a shared pool of purchased extra slots.
 *
 * Until now the same question had two implementations with two entitlement key
 * names (`connectionLimit.ts` for Facebook/Instagram, `pinterest/accountQuota.ts`
 * for Pinterest). Both now delegate here, so a change to the rule cannot land on
 * one platform and miss the other.
 *
 * ── THE RULE (design doc §1) ──────────────────────────────────────────────────
 *   allowed(P) ⇔ active(P) < included(plan)
 *                OR  Σ_Q max(0, active(Q) − included(plan)) < purchasedSlots
 *
 * Read it as: every platform first spends the accounts its plan includes; anything
 * ABOVE the included number on ANY platform draws from one shared pool of purchased
 * slots. 1 slot = 1 extra connectable account on any platform. There is no cap on
 * how many slots may be bought.
 *
 * ── WHAT COUNTS AS "ACTIVE" ───────────────────────────────────────────────────
 * Exactly Pinterest's `listActiveConnections` predicate: `disconnected_at IS NULL
 * AND access_token_encrypted IS NOT NULL`. All three disconnect paths (Pinterest,
 * Facebook, Instagram) null the token columns, so a token-less row is a disconnect
 * leftover on every provider — even the two that never write `disconnected_at`.
 *
 * This is the bug fix the pool rides in on: `connectionLimit.countConnections` used
 * to count EVERY row for the provider, so a user at their limit who disconnected A
 * and tried to connect B was refused forever (the dead row still held the slot).
 * A disconnected row does not consume anything.
 *
 * Deliberately NOT filtered on `connection_status`: Facebook's "authorized, Page
 * not chosen yet" states map to the DB-legal status `not_connected` while still
 * holding a token. Those rows are real, live authorizations a user can see and
 * remove, so they count — excluding them would let one user open unlimited parallel
 * pending Facebook flows.
 *
 * ── PURCHASED SLOTS ───────────────────────────────────────────────────────────
 * Truth = access-granting `creem_subscriptions` rows whose product is the add-on
 * product (`isExtraAccountProduct`), summed over `units`. Same grant filter
 * (`filterAccessGrantingSubscriptions`) the plan resolution uses, so a canceled
 * add-on stops granting at exactly the same moment a canceled plan would. No new
 * table, no metadata cache.
 *
 * ── FAILURE SEMANTICS ─────────────────────────────────────────────────────────
 * Unchanged from the two modules this replaces: an infrastructure problem must not
 * become a second availability dependency on OAuth.
 *   - plan unresolvable / counts unavailable / anything throws → ALLOW (fail open).
 *   - slots unavailable (no add-on configured, query error, `units` column not yet
 *     migrated) → 0 slots, NOT fail-open: degrading to "the plan's own ceiling" is
 *     the safe direction, whereas failing open there would silently disable the
 *     ceiling for everyone.
 * Reconnect never reaches here: only the branch that would ADD a row asks.
 */

import { createServerClient } from "@/lib/supabase";
import {
  resolvePlan,
  filterAccessGrantingSubscriptions,
  type PlanKey,
  type SubscriptionRowForGrant,
} from "@/lib/server/entitlements";
import { getPlanEntitlements } from "@/lib/server/planEntitlements";
import {
  isExtraAccountProduct,
  isExtraAccountConfigured,
} from "@/lib/server/creem/creemProducts";

const CONNECTIONS_TABLE = "social_connections";
const SUBSCRIPTIONS_TABLE = "creem_subscriptions";

/** provider → number of ACTIVE connections the user holds on it. */
export type ActiveCountsByProvider = Readonly<Record<string, number>>;

/** Everything the rule needs, with no IO left in it. */
export type AllowanceSnapshot = {
  plan: PlanKey;
  /** Accounts per platform the PLAN includes; null = uncapped. */
  included: number | null;
  activeByProvider: ActiveCountsByProvider;
  /** Extra slots bought as an add-on (shared across every platform). */
  purchasedSlots: number;
};

/**
 * The verdict for one provider. Every field is reported so callers can log or
 * render the reason without recomputing anything.
 */
export type AccountAllowance = {
  allowed: boolean;
  /**
   * `included`   — still inside the plan's own per-platform allowance
   * `extra_slot` — over the included number, covered by a purchased slot
   * `uncapped`   — the plan has no ceiling (null)
   * `limit_reached` — the refusal
   * `unavailable`   — could not decide (fail open); nothing was measured
   */
  reason: "included" | "extra_slot" | "uncapped" | "limit_reached" | "unavailable";
  provider: string;
  plan: PlanKey;
  included: number | null;
  /** Active connections on THIS provider. */
  active: number;
  purchasedSlots: number;
  /** Sum over all providers of the accounts held above the included number. */
  slotsInUse: number;
  /** purchasedSlots − slotsInUse, floored at 0. */
  slotsAvailable: number;
};

/** Injection points. Every one of them is optional; production passes none. */
export type AllowanceDeps = {
  /** Pre-resolved plan — for callers that already have it (the OAuth callback). */
  plan?: PlanKey;
  resolvePlanFn?: (uid: string) => Promise<PlanKey>;
  /** Active counts for every provider. `null` = unavailable → fail open. */
  countActive?: (uid: string) => Promise<ActiveCountsByProvider | null>;
  /**
   * An authoritative count for ONE provider, supplied by a caller that just read
   * the rows itself (the Pinterest callback). It overrides whatever the grouped
   * query returned for that provider, and stands in for the whole map when the
   * grouped query is unavailable.
   */
  activeOverride?: { provider: string; count: number };
  purchasedSlots?: (uid: string) => Promise<number>;
};

/** A missing table must never block a connect attempt. */
function isMissingTable(code?: string): boolean {
  return code === "PGRST205" || code === "42P01";
}

// ── The rule (pure) ───────────────────────────────────────────────────────────

/**
 * Apply the §1 formula to a snapshot. No IO, so the rule itself is testable
 * without a database — every scenario in the design doc's acceptance list is a
 * call to this function.
 */
export function evaluateAllowance(
  snapshot: AllowanceSnapshot,
  provider: string,
): AccountAllowance {
  const { plan, included, activeByProvider, purchasedSlots } = snapshot;
  const active = activeByProvider[provider] ?? 0;

  if (included === null) {
    return {
      allowed: true,
      reason: "uncapped",
      provider,
      plan,
      included,
      active,
      purchasedSlots,
      slotsInUse: 0,
      slotsAvailable: purchasedSlots,
    };
  }

  // Only accounts ABOVE the plan's included number draw from the pool — and they
  // draw from it on every platform at once, which is what makes the pool shared.
  const slotsInUse = Object.values(activeByProvider).reduce(
    (sum, count) => sum + Math.max(0, count - included),
    0,
  );
  const slotsAvailable = Math.max(0, purchasedSlots - slotsInUse);

  const base = {
    provider,
    plan,
    included,
    active,
    purchasedSlots,
    slotsInUse,
    slotsAvailable,
  };

  if (active < included) return { allowed: true, reason: "included" as const, ...base };
  if (slotsAvailable > 0) return { allowed: true, reason: "extra_slot" as const, ...base };
  return { allowed: false, reason: "limit_reached" as const, ...base };
}

// ── IO ────────────────────────────────────────────────────────────────────────

/**
 * ACTIVE connections per provider, in ONE query. Returns null when the count is
 * unavailable (missing table / DB error) so callers can fail open rather than
 * guess. Never selects the token ciphertext — only tests it for NULL server-side.
 */
export async function countActiveConnectionsByProvider(
  uid: string,
): Promise<ActiveCountsByProvider | null> {
  const { data, error } = await createServerClient()
    .from(CONNECTIONS_TABLE)
    .select("provider")
    .eq("user_id", uid)
    .is("disconnected_at", null)
    .not("access_token_encrypted", "is", null);

  if (error) {
    if (!isMissingTable(error.code)) {
      console.error("[social] count active connections:", error.message);
    }
    return null;
  }

  const counts: Record<string, number> = {};
  for (const row of (data as Array<{ provider?: string | null }> | null) ?? []) {
    const provider = (row.provider ?? "").trim();
    if (!provider) continue;
    counts[provider] = (counts[provider] ?? 0) + 1;
  }
  return counts;
}

/** `units` as a positive integer; anything unusable is 1 (one subscription = one slot). */
export function normalizeSlotUnits(value: unknown): number {
  const n = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n)) return 1;
  const floored = Math.floor(n);
  return floored >= 1 ? floored : 1;
}

/** A mirrored subscription row as read for the slot total. */
export type ExtraSlotRow = SubscriptionRowForGrant & {
  creem_product_id?: string | null;
  units?: unknown;
};

/**
 * The slot total from already-fetched rows: keep only add-on products whose status
 * currently grants access, then sum their units. Pure, so the "which rows count"
 * rule is testable without a database. `nowMs` is injectable for the
 * scheduled-cancel period-end check.
 */
export function sumExtraAccountUnits(rows: ExtraSlotRow[], nowMs: number = Date.now()): number {
  let total = 0;
  for (const row of rows) {
    if (!isExtraAccountProduct(row.creem_product_id)) continue;
    // Same grant rule as resolvePlan — a lapsed scheduled_cancel grants nothing.
    if (filterAccessGrantingSubscriptions([row], nowMs).length === 0) continue;
    total += normalizeSlotUnits(row.units);
  }
  return total;
}

/**
 * How many extra account slots the user currently has: the sum of `units` over the
 * access-granting add-on subscriptions.
 *
 * Returns 0 — never throws — on every degraded path:
 *   - no CREEM_PRODUCT_EXTRA_ACCOUNT_* configured → nothing exists to have bought,
 *     and we skip the query entirely;
 *   - query error, including `units` not yet migrated (42703) → the plan's own
 *     ceiling still applies, which is the safe direction.
 */
export async function getPurchasedExtraSlots(uid: string): Promise<number> {
  if (!isExtraAccountConfigured()) return 0;
  try {
    const { data, error } = await createServerClient()
      .from(SUBSCRIPTIONS_TABLE)
      .select("creem_product_id,units,plan,status,last_event_at,current_period_end")
      .eq("user_id", uid)
      .in("status", ["active", "trialing", "scheduled_cancel"]);
    if (error) {
      console.error("[social] extra account slots lookup failed:", error.message);
      return 0;
    }

    type Row = SubscriptionRowForGrant & {
      creem_product_id?: string | null;
      units?: unknown;
    };
    let total = 0;
    for (const row of (data as Row[] | null) ?? []) {
      if (!isExtraAccountProduct(row.creem_product_id)) continue;
      // Same grant rule as resolvePlan — a lapsed scheduled_cancel grants nothing.
      const granting = filterAccessGrantingSubscriptions([row]).length > 0;
      if (!granting) continue;
      total += normalizeSlotUnits(row.units);
    }
    return total;
  } catch (err) {
    console.error(
      "[social] extra account slots lookup threw:",
      err instanceof Error ? err.message : String(err),
    );
    return 0;
  }
}

/**
 * Assemble the snapshot. Plan, counts and slots are independent reads, so they run
 * together — this sits on the connect click→redirect path.
 *
 * Returns null when the decision cannot be made at all (counts unavailable and no
 * caller-supplied count) — the fail-open signal.
 */
export async function getAllowanceSnapshot(
  uid: string,
  deps?: AllowanceDeps,
): Promise<AllowanceSnapshot | null> {
  const [plan, counts, purchasedSlots] = await Promise.all([
    deps?.plan !== undefined
      ? Promise.resolve(deps.plan)
      : (deps?.resolvePlanFn ?? resolvePlan)(uid),
    (deps?.countActive ?? countActiveConnectionsByProvider)(uid),
    (deps?.purchasedSlots ?? getPurchasedExtraSlots)(uid),
  ]);

  const override = deps?.activeOverride;
  // No counts at all: a caller that counted one provider itself still has enough
  // to enforce that provider's own ceiling — strictly better than failing open.
  if (counts === null) {
    if (!override) return null;
    return {
      plan,
      included: getPlanEntitlements(plan).connectedAccountsPerPlatform,
      activeByProvider: { [override.provider]: override.count },
      purchasedSlots,
    };
  }

  const activeByProvider = override
    ? { ...counts, [override.provider]: override.count }
    : counts;

  return {
    plan,
    included: getPlanEntitlements(plan).connectedAccountsPerPlatform,
    activeByProvider,
    purchasedSlots,
  };
}

/** Fail-open verdict — nothing was measured, so nothing may be refused. */
function unavailable(provider: string, plan: PlanKey): AccountAllowance {
  return {
    allowed: true,
    reason: "unavailable",
    provider,
    plan,
    included: null,
    active: 0,
    purchasedSlots: 0,
    slotsInUse: 0,
    slotsAvailable: 0,
  };
}

/**
 * THE entry point: may `uid` add one more connection on `provider`?
 *
 * Fails OPEN on any infrastructure problem (see the module header).
 */
export async function evaluateAccountAllowance(
  uid: string,
  provider: string,
  deps?: AllowanceDeps,
): Promise<AccountAllowance> {
  try {
    const snapshot = await getAllowanceSnapshot(uid, deps);
    if (!snapshot) return unavailable(provider, deps?.plan ?? "free");
    return evaluateAllowance(snapshot, provider);
  } catch (err) {
    console.warn(
      "[social] account allowance check unavailable, allowing:",
      err instanceof Error ? err.message : String(err),
    );
    return unavailable(provider, deps?.plan ?? "free");
  }
}
