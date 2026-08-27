/**
 * Authenticated Creem checkout session (POST /api/billing/creem/checkout).
 *
 * Two things can be bought here:
 *   { kind: "plan", plan, interval }                — a subscription plan
 *   { kind: "extra_account", interval, units }      — N extra connectable social
 *     accounts (a shared any-platform pool), available only ON a paid plan.
 * `kind` may be omitted; it defaults to "plan" so the pricing page's existing body
 * keeps working unchanged.
 *
 * Turns a signed-in buyer's choice into a hosted Creem checkout URL. The
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
 *     interval ∈ month|year — "free" is rejected), a bad kind, or units out of range.
 *   - 403 { error: "paid_plan_required", userMessage } when a Free user tries to buy
 *     extra account slots — the add-on tops up a plan, it does not replace one.
 *   - 500 { error: "plan_not_configured" } when the plan/interval has no
 *     CREEM_PRODUCT_* env mapping (config error — logged).
 *   - 500 { error: "addon_not_configured" } when the extra-account product id is
 *     not set for the requested interval.
 *   - 502 { error: "checkout_failed" } on any Creem upstream failure (detail
 *     logged server-side only).
 *   - 200 { url } with the hosted checkout URL on success.
 */

import { NextResponse, type NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { getUserIdFromBearerOrCookies } from "@/lib/server/authUser";
import { createServerClient } from "@/lib/supabase";
import { creemProductIdFor, extraAccountProductIdFor } from "@/lib/server/creem/creemProducts";
import { createCheckoutSession } from "@/lib/server/creem/creemClient";
import { assertBillingModeUsable, getBillingMode } from "@/lib/server/creem/billingMode";
import { resolvePlan } from "@/lib/server/entitlements";
import type { PlanKey } from "@/lib/pricingPlans";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PaidPlan = Exclude<PlanKey, "free">;
const PAID_PLANS: readonly PaidPlan[] = ["starter", "pro", "business"];
const INTERVALS = ["month", "year"] as const;
type Interval = (typeof INTERVALS)[number];

const KINDS = ["plan", "extra_account"] as const;
type CheckoutKind = (typeof KINDS)[number];

/**
 * Upper bound on units per checkout. The product itself is uncapped (a user may
 * buy more slots later, or raise the quantity in the Creem portal); this only stops
 * a malformed or hostile body from opening a checkout for an absurd amount.
 */
const MAX_UNITS = 50;

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
  const rawKind = (body as { kind?: unknown }).kind ?? "plan";
  if (typeof rawKind !== "string" || !KINDS.includes(rawKind as CheckoutKind)) {
    return NextResponse.json({ error: "invalid_kind" }, { status: 400 });
  }
  const kind = rawKind as CheckoutKind;
  const interval = (body as { interval?: unknown }).interval;
  if (typeof interval !== "string" || !INTERVALS.includes(interval as Interval)) {
    return NextResponse.json({ error: "invalid_interval" }, { status: 400 });
  }

  let productId: string | null;
  let units = 1;

  if (kind === "extra_account") {
    const rawUnits = (body as { units?: unknown }).units ?? 1;
    if (
      typeof rawUnits !== "number" ||
      !Number.isInteger(rawUnits) ||
      rawUnits < 1 ||
      rawUnits > MAX_UNITS
    ) {
      return NextResponse.json({ error: "invalid_units" }, { status: 400 });
    }
    units = rawUnits;

    // Paid plans only. Extra slots top a plan up; sold on their own they would be a
    // second, cheaper plan. Resolved SERVER-SIDE (never from the body) with the same
    // resolver the connect gate uses, so what the buyer is told matches what they get.
    const currentPlan = await resolvePlan(uid);
    if (currentPlan === "free") {
      return NextResponse.json(
        {
          error: "paid_plan_required",
          userMessage:
            "Extra account slots are available on Starter, Pro and Business. " +
            "Choose a plan first, then add as many accounts as you need.",
        },
        { status: 403 },
      );
    }

    productId = extraAccountProductIdFor(interval as Interval);
    if (!productId) {
      console.error(
        `[billing/creem/checkout] no CREEM_PRODUCT_EXTRA_ACCOUNT mapping for interval=${interval}.`,
      );
      return NextResponse.json({ error: "addon_not_configured" }, { status: 500 });
    }
  } else {
    const plan = (body as { plan?: unknown }).plan;
    if (typeof plan !== "string" || !PAID_PLANS.includes(plan as PaidPlan)) {
      return NextResponse.json({ error: "invalid_plan" }, { status: 400 });
    }

    // product_id ONLY from the server-side env map.
    productId = creemProductIdFor(plan as PaidPlan, interval as Interval);
    if (!productId) {
      console.error(
        `[billing/creem/checkout] no CREEM_PRODUCT mapping for plan=${plan} interval=${interval}.`,
      );
      return NextResponse.json({ error: "plan_not_configured" }, { status: 500 });
    }
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
      // `kind` rides along so the webhook (and any later audit) can tell an add-on
      // purchase from a plan purchase without re-deriving it from the product id.
      metadata: { userId: uid, kind },
      units,
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
