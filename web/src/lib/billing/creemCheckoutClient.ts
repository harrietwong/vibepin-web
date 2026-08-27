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
  | { kind: "extra_account"; units: number };

/** What a checkout call resolves to: the hosted URL, plus what was charged. */
export type CheckoutStarted = {
  url: string;
  /**
   * The interval the server actually charged. Only the add-on reports it (the
   * server derives it from the plan), so it is undefined for a plan checkout.
   */
  interval?: BillingInterval;
};

async function postCheckout(body: CheckoutBody): Promise<CheckoutStarted> {
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
  const json = (await res.json()) as { url?: string; interval?: BillingInterval };
  if (!json.url) throw new Error("checkout endpoint returned no url");
  return { url: json.url, interval: json.interval };
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
  return (await postCheckout({ kind: "plan", plan, interval })).url;
}

/**
 * Start a checkout for N extra account slots (1 slot = 1 extra connectable social
 * account on any platform). Paid plans only — a Free user gets a
 * BillingRefusedError carrying the message to show them.
 *
 * There is deliberately NO interval parameter (决策 A): the add-on is billed on the
 * same interval as the buyer's main plan, derived server-side. A client that could
 * name the interval could also name the wrong one — and the price shown next to this
 * button would then be a guess rather than a promise. The resolved interval comes
 * back on the result for display.
 */
export async function startExtraAccountCheckout(
  units: number = 1,
): Promise<CheckoutStarted> {
  return postCheckout({ kind: "extra_account", units });
}
