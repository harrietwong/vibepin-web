/**
 * "May this user connect one MORE Pinterest account?" — the plan's
 * `accountsPerPlatform` entitlement, actually enforced (PRD §9.2 / §18).
 *
 * Two entitlement modules, one direction of import (deliberate — do not merge them):
 *   - `server/entitlements.ts` owns plan RESOLUTION (security-critical: it never reads
 *     user_metadata) and the Shopify store caps.
 *   - `planEntitlements.ts` owns the per-plan NUMBERS, shared with the pricing page so
 *     display and enforcement cannot drift.
 * This module resolves via the former and reads numbers from the latter. The numbers
 * are never copied.
 *
 * Counting rule (fixed, not negotiable per call site):
 *   used  = listActiveConnections(uid).length — non-disconnected, token-bearing rows.
 *           A DISCONNECTED row does NOT count. If it did, the cap would become a
 *           one-way ratchet: a user who disconnects to swap accounts could never
 *           connect again.
 *   limit = PLAN_ENTITLEMENTS[plan].accountsPerPlatform; `null` means uncapped.
 *
 * Concurrency: two OAuth flows that both pass the check before either writes can
 * exceed the cap by one. Accepted for MVP. The fix is NOT a DB unique/CHECK
 * constraint — plan limits live in config, never in DB constraints
 * (server/entitlements.ts 决策 3).
 */

import { PLAN_ENTITLEMENTS } from "@/lib/planEntitlements";
import { resolvePlan, type PlanKey } from "@/lib/server/entitlements";
import { listActiveConnections } from "./connectionStore";

export type AccountQuota = {
  /** Active connections the user already holds. */
  used: number;
  /** Max allowed on their plan; null = uncapped. */
  limit: number | null;
  /** The plan the limit came from — for the upgrade CTA / logs. */
  plan: PlanKey;
  /** False when adding one more account would exceed the cap. */
  canAddAccount: boolean;
};

/**
 * Pure decision: given a limit and the current active count, may one more be added?
 * A null limit is uncapped. Kept free of IO so the rule is testable without a DB.
 */
export function canAddAccount(limit: number | null, activeCount: number): boolean {
  if (limit === null) return true;
  return activeCount < limit;
}

/**
 * Same decision from an already-known plan + count — used by the OAuth callback,
 * which has both in hand and must not pay for a second round trip.
 */
export function evaluateAccountQuota(plan: PlanKey, activeCount: number): AccountQuota {
  const limit = PLAN_ENTITLEMENTS[plan].accountsPerPlatform;
  return { used: activeCount, limit, plan, canAddAccount: canAddAccount(limit, activeCount) };
}

/**
 * Resolve the user's plan and count their active Pinterest connections.
 *
 * The two reads are independent, so they run together: the connect POST handler is an
 * instrumented hot path (click → redirect latency), and this must cost max(a, b)
 * rather than a + b.
 */
export async function getPinterestAccountQuota(uid: string): Promise<AccountQuota> {
  const [plan, active] = await Promise.all([
    resolvePlan(uid),
    listActiveConnections(uid),
  ]);
  return evaluateAccountQuota(plan, active.length);
}
