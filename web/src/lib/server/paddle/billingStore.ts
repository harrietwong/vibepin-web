/**
 * Service-role Supabase access for the Paddle billing mirror tables
 * (billing_customers + billing_subscriptions, migrate_v44).
 *
 * These two tables are the SOURCE OF TRUTH for billing state; the webhook
 * refreshes `user_metadata.plan` from them. Server-only (uses the service-role
 * client via createServerClient) — never import from client code.
 *
 * Out-of-order guard: Paddle delivers notifications AT-LEAST-ONCE and OUT OF
 * ORDER. Every upsert is read-compare-write against the row's `last_event_at`:
 * we only apply an incoming event whose occurredAt >= the stored last_event_at.
 * NOTE: there is a small read-compare-write race window (two events for the same
 * id landing concurrently could both read the same prior last_event_at and race
 * on the write). This is acceptable — Paddle retries deliveries and the mirror
 * converges to the newest event; the guard's job is to reject clearly-stale
 * replays, not to be a strict serializer.
 */

import { createServerClient } from "../../supabase";
import { PRICING_TIERS, type PlanKey } from "@/lib/pricingPlans";

// ── Row types ──────────────────────────────────────────────────────────────────

export type BillingCustomerRow = {
  customer_id: string;
  email: string | null;
  user_id: string | null;
  last_event_at: string | null;
  created_at: string;
  updated_at: string;
};

export type BillingSubscriptionRow = {
  subscription_id: string;
  customer_id: string;
  user_id: string | null;
  status: string;
  price_id: string;
  product_id: string;
  plan_key: string | null;
  scheduled_change_action: string | null;
  scheduled_change_at: string | null;
  current_period_end: string | null;
  last_event_at: string | null;
  created_at: string;
  updated_at: string;
};

// ── Upsert inputs ───────────────────────────────────────────────────────────────

export type UpsertBillingCustomerInput = {
  customerId: string;
  email?: string | null;
  userId?: string | null;
  occurredAt: string;
};

export type UpsertBillingSubscriptionInput = {
  subscriptionId: string;
  customerId: string;
  userId?: string | null;
  status: string;
  priceId: string;
  productId: string;
  planKey: PlanKey | null;
  scheduledChangeAction?: string | null;
  scheduledChangeAt?: string | null;
  currentPeriodEnd?: string | null;
  occurredAt: string;
};

/** True when the incoming event is at least as recent as the stored one. */
function isNotStale(storedLastEventAt: string | null, occurredAt: string): boolean {
  if (!storedLastEventAt) return true;
  // ISO 8601 strings from Paddle are lexicographically comparable, but parse to
  // be robust against timezone/precision variations.
  return new Date(occurredAt).getTime() >= new Date(storedLastEventAt).getTime();
}

// ── billing_customers ───────────────────────────────────────────────────────────

/**
 * Insert-or-update a billing_customers row, applying the out-of-order guard.
 * Merge semantics: a NEWER event never null-out an existing email/user_id with
 * an absent (undefined/null) incoming value — we only overwrite those fields
 * when a concrete value is supplied (e.g. customer.created carries the email;
 * a transaction.completed placeholder does not).
 */
export async function upsertBillingCustomer(input: UpsertBillingCustomerInput): Promise<void> {
  const db = createServerClient();
  const { customerId, occurredAt } = input;

  const { data: existing, error: readErr } = await db
    .from("billing_customers")
    .select("customer_id,email,user_id,last_event_at")
    .eq("customer_id", customerId)
    .maybeSingle();
  if (readErr) throw new Error(`billing_customers read failed: ${readErr.message}`);

  const stale = existing && !isNotStale(existing.last_event_at, occurredAt);

  // Merge: prefer the incoming concrete value; otherwise keep the existing one.
  const email =
    input.email != null ? input.email : (existing?.email ?? null);
  const userId =
    input.userId != null ? input.userId : (existing?.user_id ?? null);

  if (stale) {
    // Older event: never move last_event_at backward and never clobber newer
    // fields. Only backfill fields the newer state still lacks (e.g. a late
    // customer.created supplying an email an earlier placeholder never had).
    const patch: Record<string, unknown> = {};
    if (existing?.email == null && input.email != null) patch.email = input.email;
    if (existing?.user_id == null && input.userId != null) patch.user_id = input.userId;
    if (Object.keys(patch).length === 0) return;
    const { error } = await db
      .from("billing_customers")
      .update(patch)
      .eq("customer_id", customerId);
    if (error) throw new Error(`billing_customers backfill failed: ${error.message}`);
    return;
  }

  const { error } = await db.from("billing_customers").upsert(
    {
      customer_id: customerId,
      email,
      user_id: userId,
      last_event_at: occurredAt,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "customer_id" },
  );
  if (error) throw new Error(`billing_customers upsert failed: ${error.message}`);
}

// ── billing_subscriptions ───────────────────────────────────────────────────────

/**
 * Insert-or-update a billing_subscriptions row, applying the out-of-order guard.
 * A subscription event is a full snapshot, so the fresh path overwrites the
 * whole row; user_id is preserved from the existing row when the incoming event
 * has none (it is never null-ed by a later event that lacks custom_data.userId).
 */
export async function upsertBillingSubscription(
  input: UpsertBillingSubscriptionInput,
): Promise<void> {
  const db = createServerClient();
  const { subscriptionId, occurredAt } = input;

  const { data: existing, error: readErr } = await db
    .from("billing_subscriptions")
    .select("subscription_id,user_id,last_event_at")
    .eq("subscription_id", subscriptionId)
    .maybeSingle();
  if (readErr) throw new Error(`billing_subscriptions read failed: ${readErr.message}`);

  if (existing && !isNotStale(existing.last_event_at, occurredAt)) {
    // Stale replay: keep the newer snapshot. Only backfill user_id if still null.
    if (existing.user_id == null && input.userId != null) {
      const { error } = await db
        .from("billing_subscriptions")
        .update({ user_id: input.userId })
        .eq("subscription_id", subscriptionId);
      if (error) throw new Error(`billing_subscriptions backfill failed: ${error.message}`);
    }
    return;
  }

  const userId =
    input.userId != null ? input.userId : (existing?.user_id ?? null);

  const { error } = await db.from("billing_subscriptions").upsert(
    {
      subscription_id: subscriptionId,
      customer_id: input.customerId,
      user_id: userId,
      status: input.status,
      price_id: input.priceId,
      product_id: input.productId,
      plan_key: input.planKey,
      scheduled_change_action: input.scheduledChangeAction ?? null,
      scheduled_change_at: input.scheduledChangeAt ?? null,
      current_period_end: input.currentPeriodEnd ?? null,
      last_event_at: occurredAt,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "subscription_id" },
  );
  if (error) throw new Error(`billing_subscriptions upsert failed: ${error.message}`);
}

// ── Reads ───────────────────────────────────────────────────────────────────────

/** The billing customer linked to a VibePin user, or null. */
export async function getBillingCustomerByUserId(
  userId: string,
): Promise<BillingCustomerRow | null> {
  const db = createServerClient();
  const { data, error } = await db
    .from("billing_customers")
    .select("*")
    .eq("user_id", userId)
    // A user could (rarely) map to more than one Paddle customer over time;
    // prefer the most recently touched row.
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`getBillingCustomerByUserId failed: ${error.message}`);
  return (data as BillingCustomerRow | null) ?? null;
}

/** All subscriptions mirrored for a Paddle customer. */
export async function getSubscriptionsForCustomer(
  customerId: string,
): Promise<BillingSubscriptionRow[]> {
  const db = createServerClient();
  const { data, error } = await db
    .from("billing_subscriptions")
    .select("*")
    .eq("customer_id", customerId);
  if (error) throw new Error(`getSubscriptionsForCustomer failed: ${error.message}`);
  return (data as BillingSubscriptionRow[] | null) ?? [];
}

// ── Derivations ─────────────────────────────────────────────────────────────────

/**
 * Whether a subscription status grants product access. TRUE only for "active"
 * and "trialing".
 *
 * A pending scheduled_change (cancel/pause set to take effect at period end)
 * does NOT revoke access — the subscription is still "active" until Paddle
 * actually transitions the status. Only a real status of "canceled" / "paused"
 * / "past_due" revokes access.
 */
export function subscriptionGrantsAccess(status: string): boolean {
  return status === "active" || status === "trialing";
}

/**
 * Reverse-lookup a Paddle price id → VibePin plan key over PRICING_TIERS
 * (paddlePriceIds.month/year). Returns null for the Free tier / unknown ids.
 */
export function planKeyForPriceId(priceId: string): PlanKey | null {
  for (const tier of PRICING_TIERS) {
    const ids = tier.paddlePriceIds;
    if (ids && (ids.month === priceId || ids.year === priceId)) {
      return tier.id;
    }
  }
  return null;
}
