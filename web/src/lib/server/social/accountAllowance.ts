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
 *   allowed(P) ⇔ held(P) < included(plan)
 *                OR  Σ_Q max(0, held(Q) − included(plan)) < purchasedSlots
 *
 * Read it as: every platform first spends the accounts its plan includes; anything
 * ABOVE the included number on ANY platform draws from one shared pool of purchased
 * slots. 1 slot = 1 extra connectable account on any platform. There is no cap on
 * how many slots may be bought.
 *
 * ── WHAT OCCUPIES A SLOT (owner decision, 2026-08-27) ─────────────────────────
 * EVERY row the user holds for the provider, whatever its connection status. No
 * filter on `disconnected_at`, on the token column, or on `connection_status`.
 *
 * This follows the product rule, not the other way round (PRD 0805 §11): Disconnect
 * keeps the account — the row stays, listed in Settings as "Disconnected" with a
 * Reconnect — and it goes on occupying its slot; REMOVE is a hard delete and the
 * only action that frees one. So "how many rows exist" IS "how many slots are spent".
 *
 * The ratchet this module was born to fix stays fixed, by the other half of the same
 * decision: the way out is Remove, which deletes the row, and after it the count
 * drops. Counting rows without offering a delete would be the old bug; the two
 * halves ship together and neither is safe alone.
 *
 * Two consequences worth stating, because they are load-bearing elsewhere:
 *   - Reviving a disconnected row (Reconnect) adds NOTHING — that row already held
 *     its slot. The Pinterest callback therefore gates only `create`; gating a
 *     revive would strand an at-limit user with a slot they occupy but may not
 *     repair.
 *   - Facebook's "authorized, Page not chosen yet" row (status `not_connected`,
 *     token held) counted before and still counts. It always was a real row a user
 *     can see and remove.
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
 * Reconnect never reaches here: only the branch that would ADD a row asks — and
 * under the row-counting rule a reconnect (of a live OR a disconnected row) adds
 * nothing, because the row is already counted.
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
import { normalizeUnits } from "@/lib/server/creem/creemStore";

const CONNECTIONS_TABLE = "social_connections";
const SUBSCRIPTIONS_TABLE = "creem_subscriptions";

/** provider → number of connection ROWS the user holds on it (any status). */
export type ConnectionCountsByProvider = Readonly<Record<string, number>>;

/** Everything the rule needs, with no IO left in it. */
export type AllowanceSnapshot = {
  plan: PlanKey;
  /** Accounts per platform the PLAN includes; null = uncapped. */
  included: number | null;
  connectionsByProvider: ConnectionCountsByProvider;
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
  /** Accounts HELD on this provider — disconnected rows included. */
  held: number;
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
  /** Row counts for every provider. `null` = unavailable → fail open. */
  countConnections?: (uid: string) => Promise<ConnectionCountsByProvider | null>;
  /**
   * An authoritative count for ONE provider, supplied by a caller that just read
   * the rows itself (the Pinterest callback). It overrides whatever the grouped
   * query returned for that provider, and stands in for the whole map when the
   * grouped query is unavailable.
   */
  countOverride?: { provider: string; count: number };
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
  const { plan, included, connectionsByProvider, purchasedSlots } = snapshot;
  const held = connectionsByProvider[provider] ?? 0;

  if (included === null) {
    return {
      allowed: true,
      reason: "uncapped",
      provider,
      plan,
      included,
      held,
      purchasedSlots,
      slotsInUse: 0,
      slotsAvailable: purchasedSlots,
    };
  }

  // Only accounts ABOVE the plan's included number draw from the pool — and they
  // draw from it on every platform at once, which is what makes the pool shared.
  const slotsInUse = Object.values(connectionsByProvider).reduce(
    (sum, count) => sum + Math.max(0, count - included),
    0,
  );
  const slotsAvailable = Math.max(0, purchasedSlots - slotsInUse);

  const base = {
    provider,
    plan,
    included,
    held,
    purchasedSlots,
    slotsInUse,
    slotsAvailable,
  };

  if (held < included) return { allowed: true, reason: "included" as const, ...base };
  if (slotsAvailable > 0) return { allowed: true, reason: "extra_slot" as const, ...base };
  return { allowed: false, reason: "limit_reached" as const, ...base };
}

// ── IO ────────────────────────────────────────────────────────────────────────

/**
 * Connection ROWS per provider, in ONE query. Returns null when the count is
 * unavailable (missing table / DB error) so callers can fail open rather than guess.
 *
 * Deliberately UNFILTERED. A disconnected row is still an account the merchant holds
 * — it is listed in Settings, it can be reconnected, and it occupies its slot until
 * they Remove it (PRD 0805 §11). Re-adding a not-disconnected / has-a-token filter
 * here would hand out a slot the row is still holding, so the ceiling could be
 * exceeded by disconnecting instead of removing. test-account-allowance.ts asserts
 * those two predicates are absent from this file, so this comment may not name them
 * verbatim either.
 *
 * Never selects the token ciphertext — the column is not read at all now.
 */
export async function countConnectionsByProvider(
  uid: string,
): Promise<ConnectionCountsByProvider | null> {
  const { data, error } = await createServerClient()
    .from(CONNECTIONS_TABLE)
    .select("provider")
    .eq("user_id", uid);

  if (error) {
    if (!isMissingTable(error.code)) {
      console.error("[social] count connections:", error.message);
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
    total += normalizeUnits(row.units);
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

    return sumExtraAccountUnits((data as ExtraSlotRow[] | null) ?? []);
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
    (deps?.countConnections ?? countConnectionsByProvider)(uid),
    (deps?.purchasedSlots ?? getPurchasedExtraSlots)(uid),
  ]);

  const override = deps?.countOverride;
  // No counts at all: a caller that counted one provider itself still has enough
  // to enforce that provider's own ceiling — strictly better than failing open.
  if (counts === null) {
    if (!override) return null;
    return {
      plan,
      included: getPlanEntitlements(plan).connectedAccountsPerPlatform,
      connectionsByProvider: { [override.provider]: override.count },
      purchasedSlots,
    };
  }

  const connectionsByProvider = override
    ? { ...counts, [override.provider]: override.count }
    : counts;

  return {
    plan,
    included: getPlanEntitlements(plan).connectedAccountsPerPlatform,
    connectionsByProvider,
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
    held: 0,
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
