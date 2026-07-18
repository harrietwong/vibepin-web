/**
 * Creem subscription status (GET /api/billing/creem/status).
 *
 * Read-only billing summary for the signed-in user, sourced SERVER-SIDE from the
 * creem_customers / creem_subscriptions mirror. Never leaks Creem ids
 * (customer/subscription/product) — only the derived, display-safe fields the
 * Settings billing area needs.
 *
 * Status contract:
 *   - 401 when unauthenticated.
 *   - 200 { hasBillingAccount:false, plan:"free" } when the user has no Creem
 *     customer yet (never bought anything / webhook hasn't linked them).
 *   - 200 { plan, interval, status, currentPeriodEnd, scheduledCancel,
 *     hasBillingAccount:true } otherwise.
 *   - 500 on a mirror lookup failure.
 */

import { NextResponse, type NextRequest } from "next/server";
import { getUserIdFromBearerOrCookies } from "@/lib/server/authUser";
import {
  creemStatusGrantsAccess,
  getCreemCustomerByUserId,
  getCreemSubscriptionsForCustomer,
  type CreemSubscriptionRow,
} from "@/lib/server/creem/creemStore";
import { normalizePlanKey } from "@/lib/server/entitlements";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Pick the subscription that represents the user's current entitlement: prefer a
 * still-entitled row (active/trialing, or scheduled_cancel keeping access), then
 * fall back to the most recently touched row so a lapsed user still sees their
 * last known status. Newest last_event_at breaks ties.
 */
function pickCurrent(subs: CreemSubscriptionRow[]): CreemSubscriptionRow | null {
  if (subs.length === 0) return null;
  const byRecency = [...subs].sort(
    (a, b) =>
      new Date(b.last_event_at ?? 0).getTime() - new Date(a.last_event_at ?? 0).getTime(),
  );
  const entitled = byRecency.find(
    (s) => creemStatusGrantsAccess(s.status) || s.scheduled_cancel,
  );
  return entitled ?? byRecency[0];
}

export async function GET(req: NextRequest): Promise<Response> {
  const uid = await getUserIdFromBearerOrCookies(req);
  if (!uid) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const customer = await getCreemCustomerByUserId(uid);
    if (!customer) {
      return NextResponse.json({ hasBillingAccount: false, plan: "free" });
    }
    const subs = await getCreemSubscriptionsForCustomer(customer.creem_customer_id);
    const current = pickCurrent(subs);
    if (!current) {
      // A customer row exists but no subscription mirrored yet.
      return NextResponse.json({
        hasBillingAccount: true,
        plan: "free",
        interval: null,
        status: null,
        currentPeriodEnd: null,
        scheduledCancel: false,
      });
    }

    const plan = normalizePlanKey(current.plan) ?? "free";
    return NextResponse.json({
      hasBillingAccount: true,
      plan,
      interval: current.billing_interval,
      status: current.status,
      currentPeriodEnd: current.current_period_end,
      scheduledCancel: current.scheduled_cancel,
    });
  } catch (err) {
    console.error("[billing/creem/status] mirror lookup failed:", (err as Error).message);
    return NextResponse.json({ error: "status_lookup_failed" }, { status: 500 });
  }
}
