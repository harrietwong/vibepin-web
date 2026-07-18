/**
 * Server-side plan entitlements (Shopify Phase 1, 裁决 h).
 *
 * Plan limits live in config constants — NEVER in DB constraints (决策 3).
 * `maxSyncedProducts` can be overridden per plan via env
 * (SHOPIFY_PRODUCT_LIMIT_FREE / _STARTER / _PRO / _BUSINESS); `maxStores`
 * is a fixed constant per plan.
 *
 * Plan resolution truth order (security P0 — user_metadata is NEVER trusted;
 * Supabase users can edit their own user_metadata, so trusting it there let
 * anyone self-grant a paid plan):
 *   1. a live `creem_subscriptions` row for the user whose status grants access
 *      (active/trialing) — the newest by last_event_at wins; its `plan` is used
 *      when it is a valid PlanKey. This is the billing source of truth.
 *   2. `app_metadata.plan` (service-role-writable only — a trusted cache the
 *      Creem webhook refreshes) when it names a valid plan.
 *   3. otherwise "free".
 * The PRO_EMAIL_WHITELIST then floors the result at "pro" (a higher real plan
 * always wins).
 */

import { createServerClient } from "../supabase";

export type PlanKey = "free" | "starter" | "pro" | "business";

export type Entitlements = {
  /** How many store connections the plan may hold (0 = cannot connect). */
  maxStores: number;
  /** Product sync cap per user (limit_reached above this — never silent truncation). */
  maxSyncedProducts: number;
};

/** Default limits per plan (决策 3: Free 0/0, Starter 1/100, Pro 2/500, Business 3/1000). */
export const DEFAULT_PLAN_ENTITLEMENTS: Record<PlanKey, Entitlements> = {
  free: { maxStores: 0, maxSyncedProducts: 0 },
  starter: { maxStores: 1, maxSyncedProducts: 100 },
  pro: { maxStores: 2, maxSyncedProducts: 500 },
  business: { maxStores: 3, maxSyncedProducts: 1000 },
};

/** Env override names for maxSyncedProducts (maxStores has no override). */
const PRODUCT_LIMIT_ENV: Record<PlanKey, string> = {
  free: "SHOPIFY_PRODUCT_LIMIT_FREE",
  starter: "SHOPIFY_PRODUCT_LIMIT_STARTER",
  pro: "SHOPIFY_PRODUCT_LIMIT_PRO",
  business: "SHOPIFY_PRODUCT_LIMIT_BUSINESS",
};

// Keep in sync with PRO_EMAILS in web/src/lib/useUserTier.ts (client hook; the
// array is not exported there and the file is "use client", so it is mirrored
// here). Whitelisted emails resolve to at least "pro".
const PRO_EMAIL_WHITELIST: string[] = [
  "zhihuihuang321@gmail.com",
];

const PLAN_RANK: Record<PlanKey, number> = { free: 0, starter: 1, pro: 2, business: 3 };

/** Parse an unknown value into a PlanKey, or null when unrecognized. */
export function normalizePlanKey(value: unknown): PlanKey | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  if (v === "free" || v === "starter" || v === "pro" || v === "business") return v;
  return null;
}

function resolveProductLimit(plan: PlanKey): number {
  const raw = process.env[PRODUCT_LIMIT_ENV[plan]];
  if (typeof raw !== "string" || raw.trim() === "") {
    return DEFAULT_PLAN_ENTITLEMENTS[plan].maxSyncedProducts;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_PLAN_ENTITLEMENTS[plan].maxSyncedProducts;
  }
  return parsed;
}

/**
 * Pure lookup: plan → effective entitlements. Reads the env override for
 * maxSyncedProducts on every call (cheap; keeps tests/config hot-swappable).
 */
export function getEntitlements(plan: PlanKey): Entitlements {
  return {
    maxStores: DEFAULT_PLAN_ENTITLEMENTS[plan].maxStores,
    maxSyncedProducts: resolveProductLimit(plan),
  };
}

// ── Plan resolution ──────────────────────────────────────────────────────────

// The auth user carries the email (for the whitelist floor) and the trusted
// `app_metadata.plan` cache. `user_metadata` is deliberately NOT part of this
// shape — it is never read for authorization.
type ResolvedUser = { email: string | null; appPlan: unknown };

/**
 * A single active/trialing Creem subscription grant. `lastEventAt` orders
 * competing rows (newest wins); `plan` is the raw mirrored plan string.
 */
export type ActiveSubscriptionGrant = { plan: unknown; lastEventAt: string | null };

export type ResolvePlanDeps = {
  /** Fetch the auth user (email + app_metadata.plan), or null when unknown. */
  getUserById(userId: string): Promise<ResolvedUser | null>;
  /**
   * Fetch the user's access-granting Creem subscription rows (status in the
   * grant set). Order is irrelevant — resolvePlan picks the newest by
   * lastEventAt. Return [] when none / on error.
   */
  getActiveSubscriptions(userId: string): Promise<ActiveSubscriptionGrant[]>;
};

async function defaultGetUserById(userId: string): Promise<ResolvedUser | null> {
  const { data, error } = await createServerClient().auth.admin.getUserById(userId);
  if (error || !data?.user) return null;
  const appMeta = (data.user.app_metadata ?? null) as Record<string, unknown> | null;
  return { email: data.user.email ?? null, appPlan: appMeta?.plan };
}

/**
 * Live billing lookup: the user's Creem subscriptions whose status grants
 * access (active/trialing). Returns [] on any error so resolvePlan degrades to
 * the app_metadata cache rather than throwing.
 */
async function defaultGetActiveSubscriptions(
  userId: string,
): Promise<ActiveSubscriptionGrant[]> {
  try {
    const db = createServerClient();
    const { data, error } = await db
      .from("creem_subscriptions")
      .select("plan,status,last_event_at")
      .eq("user_id", userId)
      .in("status", ["active", "trialing"]);
    if (error || !data) return [];
    return (data as Array<{ plan: unknown; last_event_at: string | null }>).map(
      (r) => ({ plan: r.plan, lastEventAt: r.last_event_at }),
    );
  } catch {
    return [];
  }
}

/** Newest grant by last_event_at (nulls sort oldest), or null when empty. */
function newestGrant(
  grants: ActiveSubscriptionGrant[],
): ActiveSubscriptionGrant | null {
  let best: ActiveSubscriptionGrant | null = null;
  let bestTs = -Infinity;
  for (const g of grants) {
    const ts = g.lastEventAt ? new Date(g.lastEventAt).getTime() : -Infinity;
    if (best === null || ts >= bestTs) {
      best = g;
      bestTs = ts;
    }
  }
  return best;
}

/**
 * Resolve a user's plan server-side. See the module header for the full truth
 * order. Never reads user_metadata. Whitelist emails are floored at "pro" (a
 * higher real plan always wins); any failure path (missing user, lookup error,
 * unknown plan strings) resolves to "free" before the floor.
 */
export async function resolvePlan(userId: string, deps?: ResolvePlanDeps): Promise<PlanKey> {
  const getUserById = deps?.getUserById ?? defaultGetUserById;
  const getActiveSubscriptions =
    deps?.getActiveSubscriptions ?? defaultGetActiveSubscriptions;

  let user: ResolvedUser | null = null;
  try {
    user = await getUserById(userId);
  } catch {
    user = null;
  }

  // (a) Billing source of truth: a live active/trialing subscription.
  let plan: PlanKey = "free";
  try {
    const grants = await getActiveSubscriptions(userId);
    const fromSub = normalizePlanKey(newestGrant(grants)?.plan);
    if (fromSub) plan = fromSub;
  } catch {
    // fall through to the app_metadata cache
  }

  // (b) Trusted cache fallback: app_metadata.plan (service-role-writable only).
  if (plan === "free" && user) {
    const fromApp = normalizePlanKey(user.appPlan);
    if (fromApp) plan = fromApp;
  }

  // Whitelist floor at "pro" — needs the email, which requires the user lookup.
  const email = (user?.email ?? "").trim().toLowerCase();
  if (email && PRO_EMAIL_WHITELIST.includes(email) && PLAN_RANK[plan] < PLAN_RANK.pro) {
    plan = "pro";
  }
  return plan;
}
