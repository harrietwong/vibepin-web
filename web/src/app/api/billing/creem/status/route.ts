/**
 * Creem subscription status (GET /api/billing/creem/status).
 *
 * Read-only billing summary for the signed-in user, sourced SERVER-SIDE from the
 * creem_customers / creem_subscriptions mirror. Never leaks Creem ids
 * (customer/subscription/product) — only the derived, display-safe fields the
 * Settings billing area needs.
 *
 * Effective vs historical: `effectivePlan` is the plan the user CURRENTLY has
 * access to (the highest access-granting subscription — active/trialing, or a
 * scheduled_cancel still within period), computed with the SAME logic as
 * resolvePlan. `previousPlan` is the plan of the most recent historical row when
 * the user is NOT currently granted access — so a canceled Pro user is shown
 * "Free" (effective) with a muted "Previous: Pro", never a green "Pro / active".
 *
 * Status contract:
 *   - 401 when unauthenticated.
 *   - 200 { hasBillingAccount:false, effectivePlan:"free", accessGranted:false,
 *     previousPlan:null, status:null, … } when the user has no Creem customer yet.
 *   - 200 { hasBillingAccount:true, effectivePlan, previousPlan|null,
 *     accessGranted, status, interval, currentPeriodEnd, scheduledCancel }.
 *   - 500 on a mirror lookup failure.
 */

import { NextResponse, type NextRequest } from "next/server";
import { getUserIdFromBearerOrCookies } from "@/lib/server/authUser";
import {
  getCreemCustomerByUserId,
  getCreemSubscriptionsForCustomer,
  type CreemSubscriptionRow,
} from "@/lib/server/creem/creemStore";
import {
  filterAccessGrantingSubscriptions,
  highestPlanFromGrants,
  normalizePlanKey,
} from "@/lib/server/entitlements";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The most recently touched subscription row (newest last_event_at). Drives the
 * displayed raw `status`, `interval`, `currentPeriodEnd`, `scheduledCancel`, and
 * the `previousPlan` when the user is no longer granted access.
 */
function newestRow(subs: CreemSubscriptionRow[]): CreemSubscriptionRow | null {
  if (subs.length === 0) return null;
  return [...subs].sort(
    (a, b) =>
      new Date(b.last_event_at ?? 0).getTime() - new Date(a.last_event_at ?? 0).getTime(),
  )[0];
}

export async function GET(req: NextRequest): Promise<Response> {
  const uid = await getUserIdFromBearerOrCookies(req);
  if (!uid) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const customer = await getCreemCustomerByUserId(uid);
    if (!customer) {
      return NextResponse.json({
        hasBillingAccount: false,
        effectivePlan: "free",
        previousPlan: null,
        accessGranted: false,
        status: null,
        interval: null,
        currentPeriodEnd: null,
        scheduledCancel: false,
      });
    }
    const subs = await getCreemSubscriptionsForCustomer(customer.creem_customer_id);
    const newest = newestRow(subs);
    if (!newest) {
      // A customer row exists but no subscription mirrored yet.
      return NextResponse.json({
        hasBillingAccount: true,
        effectivePlan: "free",
        previousPlan: null,
        accessGranted: false,
        status: null,
        interval: null,
        currentPeriodEnd: null,
        scheduledCancel: false,
      });
    }

    // Effective access: the highest plan among the CURRENTLY access-granting subs
    // (active / trialing / scheduled_cancel-not-expired) — same rule as resolvePlan.
    const grants = filterAccessGrantingSubscriptions(
      subs.map((s) => ({
        plan: s.plan,
        status: s.status,
        last_event_at: s.last_event_at,
        current_period_end: s.current_period_end,
      })),
    );
    const effectivePlan = highestPlanFromGrants(grants);
    const accessGranted = effectivePlan !== "free";

    // previousPlan: the newest historical row's plan when NOT currently granted —
    // e.g. a canceled Pro user shows effectivePlan "free" + previousPlan "pro".
    const newestPlan = normalizePlanKey(newest.plan);
    const previousPlan = accessGranted ? null : newestPlan;

    return NextResponse.json({
      hasBillingAccount: true,
      effectivePlan,
      previousPlan,
      accessGranted,
      // Raw status of the newest row (display only — badge colour is derived
      // client-side from accessGranted + status, never trusted to be green).
      status: newest.status,
      interval: newest.billing_interval,
      currentPeriodEnd: newest.current_period_end,
      scheduledCancel: newest.scheduled_cancel,
    });
  } catch (err) {
    console.error("[billing/creem/status] mirror lookup failed:", (err as Error).message);
    return NextResponse.json({ error: "status_lookup_failed" }, { status: 500 });
  }
}
