/**
 * Authenticated Creem checkout session (POST /api/billing/creem/checkout).
 *
 * Turns a signed-in buyer's plan choice into a hosted Creem checkout URL. The
 * product id comes ONLY from the server-side CREEM_PRODUCT_* map (a client can
 * never name an arbitrary product), the customer email is fetched server-side,
 * and metadata.userId links the resulting Creem customer to this VibePin user so
 * the webhook can provision entitlements reliably.
 *
 * Status contract:
 *   - 503 { error: "billing_disabled" } when CREEM_MODE=disabled (default) — the
 *     paid CTA renders a "coming soon" state instead of the retry banner.
 *   - 500 { error: "billing_misconfigured" } when the billing mode is unusable in
 *     this runtime (e.g. a test key / CREEM_MODE=test on production, or an
 *     incomplete live config) — detail logged server-side only.
 *   - 401 when unauthenticated.
 *   - 400 on a bad/missing plan or interval (plan ∈ starter|pro|business;
 *     interval ∈ month|year — "free" is rejected).
 *   - 500 { error: "plan_not_configured" } when the plan/interval has no
 *     CREEM_PRODUCT_* env mapping (config error — logged).
 *   - 502 { error: "checkout_failed" } on any Creem upstream failure (detail
 *     logged server-side only).
 *   - 200 { url } with the hosted checkout URL on success.
 */

import { NextResponse, type NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { getUserIdFromBearerOrCookies } from "@/lib/server/authUser";
import { createServerClient } from "@/lib/supabase";
import { creemProductIdFor } from "@/lib/server/creem/creemProducts";
import { createCheckoutSession } from "@/lib/server/creem/creemClient";
import { assertBillingModeUsable, getBillingMode } from "@/lib/server/creem/billingMode";
import type { PlanKey } from "@/lib/pricingPlans";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PaidPlan = Exclude<PlanKey, "free">;
const PAID_PLANS: readonly PaidPlan[] = ["starter", "pro", "business"];
const INTERVALS = ["month", "year"] as const;
type Interval = (typeof INTERVALS)[number];

// success_url origin allowlist — an attacker-supplied Origin/Referer can never
// redirect the buyer off to an evil host after payment.
const ALLOWED_HOSTS = new Set([
  "vibepin.co",
  "www.vibepin.co",
  "localhost",
  "127.0.0.1",
]);
const DEFAULT_ORIGIN = "https://vibepin.co";

/** The request's own origin when its host is allowlisted, else the default. */
function safeSuccessOrigin(req: NextRequest): string {
  const origin = req.headers.get("origin");
  if (origin) {
    try {
      const host = new URL(origin).hostname;
      if (ALLOWED_HOSTS.has(host)) return origin;
    } catch {
      /* malformed origin → default */
    }
  }
  return DEFAULT_ORIGIN;
}

export async function POST(req: NextRequest): Promise<Response> {
  // Production release guard: an explicit billing mode gates checkout so a test
  // key can never open real checkout on production.
  //  - disabled (default) → 503 billing_disabled (paid CTA shows "coming soon").
  //  - misconfigured (test key on prod, incomplete live config) → 500, no detail.
  if (getBillingMode() === "disabled") {
    return NextResponse.json({ error: "billing_disabled" }, { status: 503 });
  }
  try {
    assertBillingModeUsable();
  } catch (err) {
    console.error(
      "[billing/creem/checkout] billing misconfigured:",
      (err as Error).message,
    );
    return NextResponse.json({ error: "billing_misconfigured" }, { status: 500 });
  }

  const uid = await getUserIdFromBearerOrCookies(req);
  if (!uid) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Strictly whitelist the body.
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const plan = (body as { plan?: unknown }).plan;
  const interval = (body as { interval?: unknown }).interval;
  if (typeof plan !== "string" || !PAID_PLANS.includes(plan as PaidPlan)) {
    return NextResponse.json({ error: "invalid_plan" }, { status: 400 });
  }
  if (typeof interval !== "string" || !INTERVALS.includes(interval as Interval)) {
    return NextResponse.json({ error: "invalid_interval" }, { status: 400 });
  }

  // product_id ONLY from the server-side env map.
  const productId = creemProductIdFor(plan as PaidPlan, interval as Interval);
  if (!productId) {
    console.error(
      `[billing/creem/checkout] no CREEM_PRODUCT mapping for plan=${plan} interval=${interval}.`,
    );
    return NextResponse.json({ error: "plan_not_configured" }, { status: 500 });
  }

  // Fetch the buyer's email server-side (admin) — never trust a client value.
  let email: string;
  try {
    const admin = createServerClient();
    const { data, error } = await admin.auth.admin.getUserById(uid);
    if (error || !data?.user?.email) {
      console.error(
        `[billing/creem/checkout] getUserById(${uid}) failed: ${error?.message ?? "no email"}.`,
      );
      return NextResponse.json({ error: "checkout_failed" }, { status: 502 });
    }
    email = data.user.email;
  } catch (err) {
    console.error("[billing/creem/checkout] user lookup threw:", (err as Error).message);
    return NextResponse.json({ error: "checkout_failed" }, { status: 502 });
  }

  const successUrl = `${safeSuccessOrigin(req)}/welcome`;

  try {
    const { checkoutUrl } = await createCheckoutSession({
      requestId: randomUUID(),
      productId,
      customerEmail: email,
      successUrl,
      metadata: { userId: uid },
    });
    return NextResponse.json({ url: checkoutUrl });
  } catch (err) {
    console.error("[billing/creem/checkout] Creem checkout failed:", (err as Error).message);
    return NextResponse.json({ error: "checkout_failed" }, { status: 502 });
  }
}

export async function OPTIONS(): Promise<Response> {
  return new NextResponse(null, { status: 204 });
}
