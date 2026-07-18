/**
 * Service-role Supabase access for the Creem billing mirror tables
 * (creem_customers + creem_subscriptions + creem_webhook_events, migrate_v45).
 *
 * These tables are the SOURCE OF TRUTH for billing state after the move from
 * Paddle to Creem; the webhook refreshes `user_metadata.plan` from them.
 * Server-only (uses the service-role client via createServerClient) — never
 * import from client code.
 *
 * Out-of-order guard: Creem delivers webhooks AT-LEAST-ONCE and OUT OF ORDER.
 * We only apply an incoming subscription event whose occurredAt >= the stored
 * `last_event_at`. For subscriptions this guard is now ATOMIC (a compare-and-set
 * done inside the database), so a replayed old `canceled` can never demote a
 * member between our read and our write: upsertCreemSubscription first tries an
 * insert that does-nothing on conflict, and otherwise runs a SINGLE conditional
 * UPDATE whose WHERE clause carries the staleness test
 * (last_event_at IS NULL OR last_event_at <= occurredAt). Zero affected rows =
 * stale (skip provisioning); ≥1 = applied. It returns "applied" | "stale" so the
 * route only touches the plan for applied events. (creem_customers keeps its
 * read-compare-write merge — it never drives entitlement changes, only linkage.)
 * Event-level exactly-once is handled separately by markWebhookEventSeen.
 */

import { createServerClient } from "../../supabase";
import type { PlanKey } from "@/lib/pricingPlans";

/**
 * The subset of the Supabase client this module uses. Injectable so webhook
 * ordering tests can drive the store with an in-memory fake (no live DB).
 */
export type CreemDbClient = ReturnType<typeof createServerClient>;

// ── Row types ──────────────────────────────────────────────────────────────────

export type CreemCustomerRow = {
  creem_customer_id: string;
  email: string | null;
  user_id: string | null;
  last_event_at: string | null;
  created_at: string;
  updated_at: string;
};

export type CreemSubscriptionRow = {
  creem_subscription_id: string;
  provider: string;
  creem_customer_id: string;
  user_id: string | null;
  status: string;
  creem_product_id: string;
  plan: string | null;
  billing_interval: string | null;
  current_period_end: string | null;
  scheduled_cancel: boolean;
  last_event_at: string | null;
  created_at: string;
  updated_at: string;
};

// ── Upsert inputs ───────────────────────────────────────────────────────────────

export type UpsertCreemCustomerInput = {
  customerId: string;
  email?: string | null;
  userId?: string | null;
  occurredAt: string;
};

export type UpsertCreemSubscriptionInput = {
  subscriptionId: string;
  customerId: string;
  userId?: string | null;
  status: string;
  productId: string;
  plan: PlanKey | null;
  billingInterval: "month" | "year" | null;
  currentPeriodEnd?: string | null;
  scheduledCancel: boolean;
  occurredAt: string;
};

/** True when the incoming event is at least as recent as the stored one. */
function isNotStale(storedLastEventAt: string | null, occurredAt: string): boolean {
  if (!storedLastEventAt) return true;
  // ISO 8601 strings are lexicographically comparable, but parse to be robust
  // against timezone/precision variations.
  return new Date(occurredAt).getTime() >= new Date(storedLastEventAt).getTime();
}

// ── creem_customers ─────────────────────────────────────────────────────────────

/**
 * Insert-or-update a creem_customers row, applying the out-of-order guard.
 * Merge semantics: a NEWER event never null-out an existing email/user_id with an
 * absent (undefined/null) incoming value — we only overwrite those fields when a
 * concrete value is supplied (e.g. a checkout carries the customer email; a
 * refund/dispute placeholder does not).
 */
export async function upsertCreemCustomer(
  input: UpsertCreemCustomerInput,
): Promise<void> {
  const db = createServerClient();
  const { customerId, occurredAt } = input;

  const { data: existing, error: readErr } = await db
    .from("creem_customers")
    .select("creem_customer_id,email,user_id,last_event_at")
    .eq("creem_customer_id", customerId)
    .maybeSingle();
  if (readErr) throw new Error(`creem_customers read failed: ${readErr.message}`);

  const stale = existing && !isNotStale(existing.last_event_at, occurredAt);

  // Merge: prefer the incoming concrete value; otherwise keep the existing one.
  const email = input.email != null ? input.email : (existing?.email ?? null);
  const userId = input.userId != null ? input.userId : (existing?.user_id ?? null);

  if (stale) {
    // Older event: never move last_event_at backward and never clobber newer
    // fields. Only backfill fields the newer state still lacks.
    const patch: Record<string, unknown> = {};
    if (existing?.email == null && input.email != null) patch.email = input.email;
    if (existing?.user_id == null && input.userId != null) patch.user_id = input.userId;
    if (Object.keys(patch).length === 0) return;
    const { error } = await db
      .from("creem_customers")
      .update(patch)
      .eq("creem_customer_id", customerId);
    if (error) throw new Error(`creem_customers backfill failed: ${error.message}`);
    return;
  }

  const { error } = await db.from("creem_customers").upsert(
    {
      creem_customer_id: customerId,
      email,
      user_id: userId,
      last_event_at: occurredAt,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "creem_customer_id" },
  );
  if (error) throw new Error(`creem_customers upsert failed: ${error.message}`);
}

// ── creem_subscriptions ─────────────────────────────────────────────────────────

/** Outcome of a guarded subscription write. */
export type UpsertOutcome = "applied" | "stale";

/**
 * Insert-or-update a creem_subscriptions row with an ATOMIC out-of-order guard.
 * A subscription event is a full snapshot; user_id is preserved from the existing
 * row when the incoming event has none (never null-ed by a later event lacking
 * metadata.userId).
 *
 * Returns:
 *   "applied" — the row now reflects THIS event; the caller may touch the plan.
 *   "stale"   — an equal-or-newer event already won; the caller must NOT change
 *               the plan (this is what stops a replayed old `canceled` from
 *               demoting an active member).
 *
 * Atomicity: the staleness decision lives in a single conditional UPDATE's WHERE
 * clause (`last_event_at IS NULL OR last_event_at <= occurredAt`), not in a
 * read-then-write. The prior row is read ONLY to compute the merged user_id —
 * never to decide staleness — so there is no read-compare-write race.
 *
 * `db` is injectable so tests can supply an in-memory fake; production passes none.
 */
export async function upsertCreemSubscription(
  input: UpsertCreemSubscriptionInput,
  db: CreemDbClient = createServerClient(),
): Promise<UpsertOutcome> {
  const { subscriptionId, occurredAt } = input;

  // Read the current row ONLY to compute merged fields (user_id preservation).
  // This read does NOT gate staleness — the WHERE clause below does.
  const { data: existing, error: readErr } = await db
    .from("creem_subscriptions")
    .select("creem_subscription_id,user_id")
    .eq("creem_subscription_id", subscriptionId)
    .maybeSingle();
  if (readErr) throw new Error(`creem_subscriptions read failed: ${readErr.message}`);

  const userId = input.userId != null ? input.userId : (existing?.user_id ?? null);
  const row = {
    creem_subscription_id: subscriptionId,
    provider: "creem",
    creem_customer_id: input.customerId,
    user_id: userId,
    status: input.status,
    creem_product_id: input.productId,
    plan: input.plan,
    billing_interval: input.billingInterval,
    current_period_end: input.currentPeriodEnd ?? null,
    scheduled_cancel: input.scheduledCancel,
    last_event_at: occurredAt,
    updated_at: new Date().toISOString(),
  };

  if (!existing) {
    // First sighting: insert, doing nothing on a concurrent conflict. The
    // returned rows tell us whether WE inserted (applied) or lost the race.
    const { data: inserted, error: insErr } = await db
      .from("creem_subscriptions")
      .upsert(row, { onConflict: "creem_subscription_id", ignoreDuplicates: true })
      .select("creem_subscription_id");
    if (insErr) throw new Error(`creem_subscriptions insert failed: ${insErr.message}`);
    if (inserted && inserted.length > 0) return "applied";
    // Lost the insert race — fall through to the conditional update below.
  }

  // Atomic compare-and-set: update ONLY when this event is at least as recent as
  // the stored one. Zero affected rows ⇒ a newer event already won ⇒ stale.
  const { data: updated, error: updErr } = await db
    .from("creem_subscriptions")
    .update(row)
    .eq("creem_subscription_id", subscriptionId)
    .or(`last_event_at.is.null,last_event_at.lte.${occurredAt}`)
    .select("creem_subscription_id");
  if (updErr) throw new Error(`creem_subscriptions update failed: ${updErr.message}`);

  if (updated && updated.length > 0) return "applied";

  // Stale: the row exists with a newer last_event_at. Still backfill a missing
  // user_id (monotonic null→value linkage), but do NOT touch entitlement fields.
  if (input.userId != null) {
    const { error: bfErr } = await db
      .from("creem_subscriptions")
      .update({ user_id: input.userId })
      .eq("creem_subscription_id", subscriptionId)
      .is("user_id", null);
    if (bfErr) throw new Error(`creem_subscriptions backfill failed: ${bfErr.message}`);
  }
  return "stale";
}

/**
 * Backfill the customer→user linkage from an event that carries it (checkout /
 * subscription metadata), regardless of event ordering.
 *
 * Why this is NOT subject to the out-of-order guard: `user_id` is monotonic — it
 * goes null → value exactly once and never changes back. Some events (e.g. a
 * refund placeholder) carry no metadata.userId, so if one lands LAST (newest
 * last_event_at) the guarded upsert would leave user_id null forever and lookups
 * would 404 for a paying user. Linking on any event that knows the user is always
 * correct; we only ever fill a null, never overwrite an existing linkage.
 */
export async function linkCustomerToUser(
  customerId: string,
  userId: string,
): Promise<void> {
  const db = createServerClient();
  const { error } = await db
    .from("creem_customers")
    .update({ user_id: userId, updated_at: new Date().toISOString() })
    .eq("creem_customer_id", customerId)
    .is("user_id", null);
  if (error) throw new Error(`linkCustomerToUser failed: ${error.message}`);
}

// ── Reads ───────────────────────────────────────────────────────────────────────

/** The Creem customer linked to a VibePin user, or null. */
export async function getCreemCustomerByUserId(
  userId: string,
): Promise<CreemCustomerRow | null> {
  const db = createServerClient();
  const { data, error } = await db
    .from("creem_customers")
    .select("*")
    .eq("user_id", userId)
    // A user could (rarely) map to more than one Creem customer over time; prefer
    // the most recently touched row.
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`getCreemCustomerByUserId failed: ${error.message}`);
  return (data as CreemCustomerRow | null) ?? null;
}

/** All subscriptions mirrored for a Creem customer. */
export async function getCreemSubscriptionsForCustomer(
  customerId: string,
): Promise<CreemSubscriptionRow[]> {
  const db = createServerClient();
  const { data, error } = await db
    .from("creem_subscriptions")
    .select("*")
    .eq("creem_customer_id", customerId);
  if (error) throw new Error(`getCreemSubscriptionsForCustomer failed: ${error.message}`);
  return (data as CreemSubscriptionRow[] | null) ?? [];
}

// ── Derivations ─────────────────────────────────────────────────────────────────

/**
 * Whether a Creem subscription status grants product access. TRUE only for
 * "active" and "trialing".
 *
 * Upstream "paid" is normalized to "active" by the route before it reaches here.
 * "scheduled_cancel" is intentionally NOT in this set — a scheduled cancel keeps
 * the subscription entitled until period end and the mirror stores that via the
 * scheduled_cancel flag while the status field stays "active" (so this returns
 * true through the flag path). The revoking statuses — canceled / expired /
 * past_due / paused / unpaid — are all false.
 */
export function creemStatusGrantsAccess(status: string): boolean {
  return status === "active" || status === "trialing";
}

// ── Event-level idempotency ──────────────────────────────────────────────────────

/**
 * Record a webhook event_id in creem_webhook_events. Returns true when the row was
 * newly inserted (first time we've seen this event → proceed to process it), false
 * when it already existed (duplicate delivery → caller should 200 and skip).
 *
 * Relies on the PK unique constraint: a duplicate insert raises Postgres error
 * 23505 (unique_violation), surfaced by supabase-js as error.code === "23505".
 */
export async function markWebhookEventSeen(
  eventId: string,
  eventType: string,
): Promise<boolean> {
  const db = createServerClient();
  const { error } = await db
    .from("creem_webhook_events")
    .insert({ event_id: eventId, event_type: eventType });
  if (!error) return true;
  if (error.code === "23505") return false; // already processed
  throw new Error(`markWebhookEventSeen failed: ${error.message}`);
}

/**
 * Roll back a webhook event_id from the ledger. Called ONLY when processing of a
 * freshly-inserted event THREW: without this, the recorded id would dedup-block
 * Creem's retry (a transient failure would lose the event permanently). Deleting
 * the ledger row re-arms the retry — the mirror upserts are idempotent, so
 * reprocessing the same event is safe. Best-effort: a failure to un-mark is
 * logged but does not mask the original processing error.
 */
export async function unmarkWebhookEvent(eventId: string): Promise<void> {
  const db = createServerClient();
  const { error } = await db
    .from("creem_webhook_events")
    .delete()
    .eq("event_id", eventId);
  if (error) {
    console.error(
      `[creemStore] unmarkWebhookEvent(${eventId}) failed (retry may be dedup-blocked): ${error.message}`,
    );
  }
}
