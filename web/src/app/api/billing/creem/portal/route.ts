/**
 * Creem customer portal session (POST /api/billing/creem/portal).
 *
 * Mints a Creem-hosted customer portal link for the signed-in user to manage
 * their subscription. The Creem customer id is resolved SERVER-SIDE from the
 * billing mirror by user_id — never read from the request — so a user can only
 * ever open their OWN portal.
 *
 * Status contract:
 *   - 401 when unauthenticated.
 *   - 404 { error: "no_billing_account" } when the user has no Creem customer yet.
 *   - 502 { error: "portal_failed" } on a Creem upstream failure.
 *   - 500 { error: "portal_lookup_failed" } on a mirror lookup failure.
 *   - 200 { url } with the portal link on success.
 */

import { NextResponse, type NextRequest } from "next/server";
import { getUserIdFromBearerOrCookies } from "@/lib/server/authUser";
import { getCreemCustomerByUserId } from "@/lib/server/creem/creemStore";
import { createCustomerPortal } from "@/lib/server/creem/creemClient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<Response> {
  const uid = await getUserIdFromBearerOrCookies(req);
  if (!uid) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Resolve the customer id SERVER-SIDE only. The request body is never read —
  // there is no client-supplied customer id to trust.
  let customerId: string;
  try {
    const customer = await getCreemCustomerByUserId(uid);
    if (!customer) {
      return NextResponse.json({ error: "no_billing_account" }, { status: 404 });
    }
    customerId = customer.creem_customer_id;
  } catch (err) {
    console.error("[billing/creem/portal] mirror lookup failed:", (err as Error).message);
    return NextResponse.json({ error: "portal_lookup_failed" }, { status: 500 });
  }

  try {
    const { portalUrl } = await createCustomerPortal(customerId);
    return NextResponse.json({ url: portalUrl });
  } catch (err) {
    console.error("[billing/creem/portal] Creem portal failed:", (err as Error).message);
    return NextResponse.json({ error: "portal_failed" }, { status: 502 });
  }
}

export async function OPTIONS(): Promise<Response> {
  return new NextResponse(null, { status: 204 });
}
