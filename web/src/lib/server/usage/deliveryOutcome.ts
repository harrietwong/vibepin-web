/**
 * deliveryOutcome.ts — the ONE place that decides whether a publish attempt gets
 * refunded (design 用量计量-退额四态 §A.4; PRD v3.2 §5.3/§5.4, decisions #4 and #8).
 *
 * Three routes publish (/api/pinterest/pins, /api/cron/publish-due,
 * /api/publish/social) and all three charge before dispatching. Each therefore has
 * to answer the same question afterwards — "did anything actually get created?" —
 * and if each answered it in its own inline `if` chain the three would drift within
 * a release or two. The product rule is one rule, so it is one function.
 *
 * ── THE FOUR STATES ────────────────────────────────────────────────────────────
 *
 *   not_sent          The request never left us: our own validation refused it, the
 *                     board is not on the connected account, the account is not
 *                     connected or needs re-auth, no destination was reachable.
 *                     → REFUND. Nothing was consumed on the provider's side, and
 *                       the user did not get a publish.
 *
 *   rejected          The provider answered, with a 4xx, and created NOTHING (no
 *                     resource id anywhere in the response). A missing-scope 403, a
 *                     404 for a board that does not exist, a 422 for a payload it
 *                     will not take.
 *                     → REFUND.
 *
 *   sent              The provider returned a resource id. The post exists.
 *                     → CHARGE, even if OUR persist afterwards failed. The user got
 *                       what they paid for; our bookkeeping problem is not theirs to
 *                       fund, and the post cannot be un-published.
 *
 *   delivery_unknown  Timeout, 5xx, connection reset, an error carrying no provider
 *                     status at all, or a crash before the response was read. We do
 *                     not know whether the post exists.
 *                     → CHARGE, and never refund it later.
 *
 * WHY delivery_unknown IS CHARGED, given it is the state most likely to be a
 * non-delivery: because it is the only state a client can produce on demand. A
 * refunded timeout is a documented free-publish bypass (open the connection, drop
 * it, repeat). The product accepts occasionally over-charging a real outage over
 * shipping a bypass. This is a PRODUCT decision, recorded here so nobody "fixes" it.
 *
 * ── THE TWO-FIELD RULE (non-negotiable) ────────────────────────────────────────
 * The provider half of the classification reads EXACTLY two fields —
 * `providerStatus` (the HTTP status the provider really returned) and
 * `providerResourceId` (the id it really returned) — and NEVER message text.
 * Message-sniffing is how a refund path silently inverts: provider copy changes,
 * a locale flips, a wrapper prefixes something, and suddenly every timeout reads as
 * a rejection and refunds itself. If we cannot see a status code, the answer is
 * `delivery_unknown` and the charge stands. An error class that carries no status is
 * not a rejection we can prove.
 *
 * The one thing that is decided by TYPE rather than by status is our OWN pre-network
 * failures: a `NotConnectedError` carries `.status = 409` and a `NeedsReconnectError`
 * carries `.status = 401`, but those numbers are HTTP-mapping conveniences we chose
 * for OUR response — no provider ever sent them. Blanket-copying `.status` into
 * `providerStatus` would make them masquerade as provider rejections. They are
 * classified as `not_sent` by class, before any status is looked at, which is also
 * the correct answer: the request never left us.
 */

/** The four delivery states. Only the first two are refundable. */
export type DeliveryOutcome = "not_sent" | "rejected" | "sent" | "delivery_unknown";

/** True for the two states the product refunds. */
export function isRefundable(outcome: DeliveryOutcome): outcome is "not_sent" | "rejected" {
  return outcome === "not_sent" || outcome === "rejected";
}

/**
 * Everything a thrown/returned failure can tell us about what the PROVIDER did.
 * Deliberately tiny: anything richer invites message inspection back in.
 */
export type ProviderSignal = {
  /** The HTTP status the provider itself returned, when one was really observed. */
  providerStatus?: number | null;
  /** A resource id the provider returned (pin id, post id, media id), if any. */
  providerResourceId?: string | null;
};

/**
 * Read the two provider fields off an unknown thrown value without trusting its
 * shape. Anything that is not a plain number/non-empty string is absent, which
 * lands the caller in `delivery_unknown` — the safe side of this decision.
 */
export function readProviderSignal(err: unknown): ProviderSignal {
  const e = err as { providerStatus?: unknown; providerResourceId?: unknown } | null | undefined;
  const status =
    typeof e?.providerStatus === "number" && Number.isFinite(e.providerStatus)
      ? e.providerStatus
      : null;
  const resourceId =
    typeof e?.providerResourceId === "string" && e.providerResourceId.trim()
      ? e.providerResourceId.trim()
      : null;
  return { providerStatus: status, providerResourceId: resourceId };
}

/**
 * Classify ONE attempt against a provider.
 *
 *  - `preNetwork: true` short-circuits to `not_sent`: the caller already knows the
 *    request never left us (typed validation failure, unreachable destination, our
 *    own connection-state error class). No status is consulted, because none of
 *    those statuses came from a provider.
 *  - a resource id present at all → `sent`, whatever the status says. A provider
 *    that both created the resource and returned an error status has still created
 *    the resource, and the charge stands.
 *  - status 2xx → `sent`.
 *  - status 4xx with no resource id → `rejected`.
 *  - anything else (5xx, no status, a nonsense status) → `delivery_unknown`.
 */
export function classifyDelivery(input: {
  ok?: boolean;
  preNetwork?: boolean;
  providerStatus?: number | null;
  providerResourceId?: string | null;
}): DeliveryOutcome {
  if (input.preNetwork) return "not_sent";
  if (input.ok) return "sent";
  if (input.providerResourceId && String(input.providerResourceId).trim()) return "sent";

  const status = input.providerStatus;
  if (typeof status !== "number" || !Number.isFinite(status)) return "delivery_unknown";
  if (status >= 200 && status < 300) return "sent";
  if (status >= 400 && status < 500) return "rejected";
  return "delivery_unknown";
}

/**
 * Roll several destination outcomes into the ONE answer for the Content.
 *
 * One Content = one charged unit no matter how many platforms it fans out to
 * (PRD v3.1 decisions 3 & 4), so the refund decision is also singular:
 *
 *   any `sent`              → `sent`. A Content that reached ANY platform was
 *                             delivered; refunding because a second platform failed
 *                             would hand out free publishes to anyone who adds a
 *                             deliberately broken destination.
 *   else any unknown        → `delivery_unknown`. We cannot prove nothing exists.
 *   else (all not_sent /
 *         rejected, ≥1)     → the refundable state, `rejected` preferred when both
 *                             appear (it is the more specific "the provider said no").
 *   nothing attempted at all → `delivery_unknown`, which keeps the charge. An empty
 *                             list is not evidence of non-delivery: the cron path
 *                             reaches it when every destination had ALREADY published
 *                             on an earlier attempt, and refunding there would give
 *                             back a unit for a Content that is live.
 */
export function aggregateDelivery(outcomes: readonly DeliveryOutcome[]): DeliveryOutcome {
  if (!outcomes.length) return "delivery_unknown";
  if (outcomes.includes("sent")) return "sent";
  if (outcomes.includes("delivery_unknown")) return "delivery_unknown";
  if (outcomes.includes("rejected")) return "rejected";
  return "not_sent";
}
