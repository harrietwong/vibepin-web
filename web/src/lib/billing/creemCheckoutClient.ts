"use client";

/**
 * Start a Creem checkout from the browser — the ONE client-side entry point.
 *
 * It lived inside pricing-client.tsx until the Settings limit banner also needed
 * to open a checkout (for extra account slots). Two copies of "POST the body,
 * read { url }, map 503 to a coming-soon state" is exactly how two surfaces end up
 * disagreeing about what billing_disabled means, so it moved here whole.
 *
 * The route resolves the product id server-side from CREEM_PRODUCT_* env; nothing
 * here names a product or a price.
 */

import { createBrowserClient } from "@supabase/ssr";
import type { PlanKey } from "@/lib/pricingPlans";

const supabase = createBrowserClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
);

export type PaidPlan = Exclude<PlanKey, "free">;
export type BillingInterval = "month" | "year";

/** Thrown when checkout is deliberately turned off (CREEM_MODE=disabled → 503). */
export class BillingDisabledError extends Error {
  constructor() {
    super("billing_disabled");
    this.name = "BillingDisabledError";
  }
}

/**
 * Thrown when the server refused for a reason the BUYER can act on and wrote a
 * message for them (today: buying extra account slots without a paid plan). The
 * message is server-authored so the customer-facing wording lives next to the rule
 * that produced it, instead of being guessed at by each caller.
 */
export class BillingRefusedError extends Error {
  readonly userMessage: string;
  constructor(userMessage: string) {
    super(userMessage);
    this.name = "BillingRefusedError";
    this.userMessage = userMessage;
  }
}

type CheckoutBody =
  | { kind: "plan"; plan: PaidPlan; interval: BillingInterval }
  | { kind: "extra_account"; interval: BillingInterval; units: number };

async function postCheckout(body: CheckoutBody): Promise<string> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  const res = await fetch("/api/billing/creem/checkout", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string; userMessage?: string };
    if (res.status === 503 && err.error === "billing_disabled") {
      throw new BillingDisabledError();
    }
    if (err.userMessage) throw new BillingRefusedError(err.userMessage);
    throw new Error(`checkout endpoint returned ${res.status}`);
  }
  const json = (await res.json()) as { url?: string };
  if (!json.url) throw new Error("checkout endpoint returned no url");
  return json.url;
}

/**
 * Start an authenticated Creem checkout for a PLAN. Resolves to the hosted
 * checkout URL. Throws BillingDisabledError when checkout is turned off (503
 * billing_disabled → the CTA shows a "coming soon" state), or a plain Error on any
 * other failure so the caller can surface the retryable banner.
 */
export async function startCreemCheckout(
  plan: PaidPlan,
  interval: BillingInterval,
): Promise<string> {
  return postCheckout({ kind: "plan", plan, interval });
}

/**
 * Start a checkout for N extra account slots (1 slot = 1 extra connectable social
 * account on any platform). Paid plans only — a Free user gets a
 * BillingRefusedError carrying the message to show them.
 */
export async function startExtraAccountCheckout(
  units: number = 1,
  interval: BillingInterval = "month",
): Promise<string> {
  return postCheckout({ kind: "extra_account", interval, units });
}
