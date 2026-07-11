/**
 * Server-side plan entitlements (Shopify Phase 1, 裁决 h).
 *
 * Plan limits live in config constants — NEVER in DB constraints (决策 3).
 * `maxSyncedProducts` can be overridden per plan via env
 * (SHOPIFY_PRODUCT_LIMIT_FREE / _STARTER / _PRO / _BUSINESS); `maxStores`
 * is a fixed constant per plan.
 *
 * Plan resolution mirrors the client hook web/src/lib/useUserTier.ts:
 * `user_metadata.plan` is authoritative when it names a known plan, and the
 * email whitelist grants at least "pro". Default is "free".
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

type ResolvedUser = { email: string | null; plan: unknown };

export type ResolvePlanDeps = {
  /** Fetch the auth user (email + user_metadata.plan), or null when unknown. */
  getUserById(userId: string): Promise<ResolvedUser | null>;
};

async function defaultGetUserById(userId: string): Promise<ResolvedUser | null> {
  const { data, error } = await createServerClient().auth.admin.getUserById(userId);
  if (error || !data?.user) return null;
  const meta = (data.user.user_metadata ?? null) as Record<string, unknown> | null;
  return { email: data.user.email ?? null, plan: meta?.plan };
}

/**
 * Resolve a user's plan server-side:
 *   1. `user_metadata.plan` when it names a known plan;
 *   2. whitelist emails are floored at "pro" (a higher metadata plan wins);
 *   3. anything else (missing user, lookup error, unknown plan) → "free".
 */
export async function resolvePlan(userId: string, deps?: ResolvePlanDeps): Promise<PlanKey> {
  let user: ResolvedUser | null = null;
  try {
    user = await (deps?.getUserById ?? defaultGetUserById)(userId);
  } catch {
    user = null;
  }
  if (!user) return "free";

  let plan: PlanKey = normalizePlanKey(user.plan) ?? "free";
  const email = (user.email ?? "").trim().toLowerCase();
  if (email && PRO_EMAIL_WHITELIST.includes(email) && PLAN_RANK[plan] < PLAN_RANK.pro) {
    plan = "pro";
  }
  return plan;
}
