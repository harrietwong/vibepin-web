/**
 * "May this user connect one MORE Pinterest account?" — a thin adapter over the ONE
 * allowance rule in `server/social/accountAllowance.ts` (PRD §9.2 / §18).
 *
 * The rule itself (plan-included accounts per platform + a shared pool of purchased
 * extra slots), the counting predicate, and the fail-open semantics all live there,
 * shared with Facebook/Instagram. This module keeps only the `AccountQuota` shape
 * the connect route and the OAuth callback already speak.
 *
 * Entitlement modules, one direction of import (deliberate — do not merge them):
 *   - `server/entitlements.ts` owns plan RESOLUTION (security-critical: it never reads
 *     user_metadata) and the Shopify store caps.
 *   - `server/planEntitlements.ts` owns the per-plan NUMBERS, shared with the pricing
 *     page so display and enforcement cannot drift. `connectedAccountsPerPlatform` is
 *     the ONE key for accounts per platform (the old duplicate `accountsPerPlatform`
 *     in `lib/planEntitlements.ts` is gone).
 * accountAllowance.ts resolves via the former and reads numbers from the latter. The
 * numbers are never copied.
 *
 * Counting rule (fixed, not negotiable per call site):
 *   used  = every Pinterest row the user holds, whatever its status. A DISCONNECTED
 *           row DOES count: Disconnect keeps the account (it stays in Settings with a
 *           Reconnect) and keeps its slot; only Remove — a hard delete — frees one
 *           (PRD 0805 §11). Reconnecting a disconnected row adds nothing, because
 *           that row was already counted. The one row that does NOT count is the
 *           never-connected placeholder (`isPlaceholderConnectionRow`): Settings does
 *           not list it, so no Remove exists for it, and counting a seat nobody can
 *           free would refuse a legacy merchant their first account for good.
 *   limit = PLAN_ENTITLEMENTS[plan].connectedAccountsPerPlatform; `null` = uncapped.
 *           Purchased extra slots do NOT change this number — they are counted in
 *           `canAddAccount`, so the limit shown/logged stays the plan's own figure.
 *
 * Concurrency: two OAuth flows that both pass the check before either writes can
 * exceed the cap by one. Accepted for MVP. The fix is NOT a DB unique/CHECK
 * constraint — plan limits live in config, never in DB constraints
 * (server/entitlements.ts 决策 3).
 */

import { type PlanKey } from "@/lib/server/entitlements";
import {
  evaluateAccountAllowance,
  type AccountAllowance,
  type AllowanceDeps,
} from "@/lib/server/social/accountAllowance";

const PROVIDER = "pinterest";

export type AccountQuota = {
  /** Account rows the user already holds, disconnected ones included. */
  used: number;
  /** Max allowed on their plan; null = uncapped. Excludes purchased extra slots. */
  limit: number | null;
  /** The plan the limit came from — for the upgrade CTA / logs. */
  plan: PlanKey;
  /** False when adding one more account would exceed plan allowance + purchased slots. */
  canAddAccount: boolean;
};

/**
 * Pure decision for the PLAN-INCLUDED allowance alone: given a limit and the current
 * active count, may one more be added? A null limit is uncapped. Kept free of IO so
 * the rule is testable without a DB. The full decision (which also spends purchased
 * slots) is `evaluateAllowance` in accountAllowance.ts.
 */
export function canAddAccount(limit: number | null, heldCount: number): boolean {
  if (limit === null) return true;
  return heldCount < limit;
}

/** Project an allowance verdict onto the quota shape this module's callers speak. */
function toQuota(allowance: AccountAllowance, heldCount: number): AccountQuota {
  return {
    used: heldCount,
    limit: allowance.included,
    plan: allowance.plan,
    canAddAccount: allowance.allowed,
  };
}

/**
 * Same decision from an already-known plan + row count — used by the OAuth callback,
 * which counted the user's Pinterest rows itself while it was reading them for the
 * connect decision.
 *
 * It is async now: the shared-pool rule needs the OTHER platforms' counts and the
 * purchased-slot total, which the callback does not hold. That is one extra query on
 * a path that has already spent a token exchange and an identity call. The caller's
 * own count still wins for Pinterest — we never re-count what it already knows.
 */
export async function evaluateAccountQuota(
  uid: string,
  plan: PlanKey,
  heldCount: number,
  deps?: AllowanceDeps,
): Promise<AccountQuota> {
  const allowance = await evaluateAccountAllowance(uid, PROVIDER, {
    ...deps,
    plan,
    countOverride: { provider: PROVIDER, count: heldCount },
  });
  return toQuota(allowance, heldCount);
}

/**
 * Resolve the user's plan and count the Pinterest rows they hold.
 *
 * The reads are independent, so they run together inside the allowance module: the
 * connect POST handler is an instrumented hot path (click → redirect latency), and
 * this must cost max(a, b, c) rather than a + b + c.
 */
export async function getPinterestAccountQuota(
  uid: string,
  deps?: AllowanceDeps,
): Promise<AccountQuota> {
  const allowance = await evaluateAccountAllowance(uid, PROVIDER, deps);
  return toQuota(allowance, allowance.held);
}
