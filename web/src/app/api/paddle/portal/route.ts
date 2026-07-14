/**
 * Paddle customer portal session (POST /api/paddle/portal).
 *
 * Mints a Paddle-hosted customer portal URL for the signed-in user to manage
 * their subscription (update payment method, cancel, view invoices). The Paddle
 * customer id is resolved SERVER-SIDE from the billing mirror — never read from
 * the request — so a user can only ever open their own portal.
 *
 * Status contract:
 *   - 401 when unauthenticated.
 *   - 404 { error: "no_billing_customer" } when the user has no Paddle customer
 *     yet (never bought anything / webhook hasn't linked them).
 *   - 500 on an upstream/SDK failure.
 *   - 200 { url } with the general portal overview URL on success.
 */

import { NextResponse, type NextRequest } from "next/server";
import { getUserIdFromBearerOrCookies } from "@/lib/server/authUser";
import { getPaddleServer } from "@/lib/server/paddle/paddleServer";
import {
  getBillingCustomerByUserId,
  getSubscriptionsForCustomer,
} from "@/lib/server/paddle/billingStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<Response> {
  const uid = await getUserIdFromBearerOrCookies(req);
  if (!uid) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let customerId: string;
  let subscriptionIds: string[];
  try {
    const customer = await getBillingCustomerByUserId(uid);
    if (!customer) {
      return NextResponse.json({ error: "no_billing_customer" }, { status: 404 });
    }
    customerId = customer.customer_id;
    const subs = await getSubscriptionsForCustomer(customerId);
    subscriptionIds = subs.map(s => s.subscription_id);
  } catch (err) {
    console.error("[paddle/portal] mirror lookup failed:", (err as Error).message);
    return NextResponse.json({ error: "portal_lookup_failed" }, { status: 500 });
  }

  try {
    // Empty subscriptionIds is allowed → Paddle returns a general portal session.
    const session = await getPaddleServer().customerPortalSessions.create(
      customerId,
      subscriptionIds,
    );
    const url = session.urls?.general?.overview;
    if (!url) {
      console.error("[paddle/portal] session had no general overview URL.");
      return NextResponse.json({ error: "portal_unavailable" }, { status: 500 });
    }
    return NextResponse.json({ url });
  } catch (err) {
    console.error("[paddle/portal] session create failed:", (err as Error).message);
    return NextResponse.json({ error: "portal_unavailable" }, { status: 500 });
  }
}

export async function OPTIONS(): Promise<Response> {
  return new NextResponse(null, { status: 204 });
}
