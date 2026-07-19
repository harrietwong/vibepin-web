/**
 * Creem Billing webhook (POST /api/webhooks/creem).
 *
 * Creem is the merchant of record after Paddle was rejected. This route mirrors
 * Creem webhook events into creem_customers / creem_subscriptions (source of
 * truth) and refreshes app_metadata.plan (the derived, service-role-only cache
 * read by resolvePlan). It mirrors the proven Paddle webhook structure but
 * hand-rolls the HMAC verification (Creem's contract) — no Creem SDK.
 *
 * Flow: read the RAW body (never JSON.parse before verification) → verify the
 * `creem-signature` HMAC-SHA256 over the raw text → dedup on event id
 * (creem_webhook_events) → route by eventType → mirror → provision.
 *
 * Status contract:
 *   - 500 on missing signing secret (config error) or a DB/provisioning failure —
 *     Creem retries; deliveries are at-least-once and converge. NEVER 2xx a
 *     config error (it would silently drop real events).
 *   - 400 on missing signature header or a verification failure — never 2xx an
 *     unverified body.
 *   - 200 {ok:true} on success, on a deduped replay, and on verified-but-ignored
 *     event types.
 *
 * Idempotency (two layers): (a) PK upserts keyed on Creem ids make reprocessing a
 * no-op; (b) creem_webhook_events records each processed event_id — a duplicate
 * delivery short-circuits to 200 before any mirroring.
 */

import { NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";
import { createServerClient } from "@/lib/supabase";
import { resolveCreemProduct } from "@/lib/server/creem/creemProducts";
import {
  creemStatusGrantsAccess,
  getCreemSubscriptionsForCustomer,
  linkCustomerToUser,
  markWebhookEventSeen,
  unmarkWebhookEvent,
  upsertCreemCustomer,
  upsertCreemSubscription,
} from "@/lib/server/creem/creemStore";
import type { PlanKey } from "@/lib/pricingPlans";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Narrow local types for the untyped webhook JSON ─────────────────────────────
// The payload is untyped JSON; we read snake_case (WE parse raw, the SDK would
// camelCase). Fields may be an expanded object OR a bare string id — handle both.

type IdOrObject = string | { id?: unknown; [k: string]: unknown } | null | undefined;

interface CreemMetadata {
  userId?: unknown;
  request_id?: unknown;
  [k: string]: unknown;
}

interface CreemSubscriptionObject {
  id?: unknown;
  status?: unknown;
  customer?: IdOrObject;
  product?: IdOrObject;
  items?: Array<{ product_id?: unknown; price_id?: unknown }> | undefined;
  current_period_end_date?: unknown;
  current_period_start_date?: unknown;
  metadata?: CreemMetadata;
}

interface CreemCheckoutObject {
  id?: unknown;
  customer?: IdOrObject;
  product?: IdOrObject;
  subscription?: IdOrObject;
  metadata?: CreemMetadata;
}

interface CreemRefundDisputeObject {
  id?: unknown;
  customer?: IdOrObject;
  subscription?: IdOrObject;
  metadata?: CreemMetadata;
}

interface CreemEventEnvelope {
  id?: unknown;
  eventType?: unknown;
  created_at?: unknown;
  object?: Record<string, unknown>;
}

// ── Small runtime helpers ───────────────────────────────────────────────────────

/** Pull an id from a field that may be an expanded object or a bare string. */
function idOf(x: IdOrObject): string | null {
  if (typeof x === "string") return x.trim() || null;
  if (x && typeof x === "object" && typeof x.id === "string") return x.id.trim() || null;
  return null;
}

/** Pull the customer email when the customer field is an expanded object. */
function emailOf(x: IdOrObject): string | null {
  if (x && typeof x === "object") {
    const e = (x as { email?: unknown }).email;
    if (typeof e === "string" && e.trim()) return e.trim();
  }
  return null;
}

function asString(x: unknown): string | null {
  return typeof x === "string" && x.trim() ? x.trim() : null;
}

/**
 * Resolve the VibePin userId carried on an event: metadata.userId (uuid) first,
 * else metadata.request_id (if it's a uuid), else null. The stored customer
 * linkage is consulted separately at the call site.
 */
function userIdFromMetadata(metadata: CreemMetadata | undefined): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const uid = metadata.userId;
  if (typeof uid === "string" && UUID_RE.test(uid.trim())) return uid.trim();
  const req = metadata.request_id;
  if (typeof req === "string" && UUID_RE.test(req.trim())) return req.trim();
  return null;
}

/**
 * Normalize the envelope created_at (a number, epoch seconds OR ms) to an ISO
 * string used as the out-of-order guard's occurredAt. Heuristic: values below
 * 1e12 are seconds (any ms timestamp after 2001 is ≥ 1e12); scale those ×1000.
 * Falls back to now() when created_at is absent/non-numeric.
 */
function createdAtToIso(createdAt: unknown): string {
  if (typeof createdAt === "number" && Number.isFinite(createdAt)) {
    const ms = createdAt < 1e12 ? createdAt * 1000 : createdAt;
    const d = new Date(ms);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return new Date().toISOString();
}

/**
 * Refresh a user's cached plan in `app_metadata` without wiping other keys.
 *
 * SECURITY: the plan cache lives in app_metadata — which is service-role-writable
 * ONLY — never user_metadata, which a user can edit for themselves and thereby
 * self-grant a paid plan. resolvePlan reads the live creem_subscriptions row as
 * the source of truth and falls back to THIS app_metadata cache. GoTrue
 * shallow-merges top-level app_metadata, but we read-merge defensively so
 * unrelated keys are provably preserved.
 */
async function setUserPlan(userId: string, plan: string): Promise<void> {
  const admin = createServerClient();
  const { data, error: readErr } = await admin.auth.admin.getUserById(userId);
  if (readErr || !data?.user) {
    throw new Error(
      `getUserById(${userId}) failed: ${readErr?.message ?? "no user"}`,
    );
  }
  const existingMeta =
    (data.user.app_metadata as Record<string, unknown> | null) ?? {};
  if (existingMeta.plan === plan) return; // no-op: cache already correct
  const { error } = await admin.auth.admin.updateUserById(userId, {
    app_metadata: { ...existingMeta, plan },
  });
  if (error) throw new Error(`updateUserById(${userId}) failed: ${error.message}`);
}

/**
 * Resolve a VibePin userId for a Creem customer from the stored linkage: the
 * authoritative creem_customers.user_id first, then any mirrored subscription that
 * already knows the user (a subscription event can carry metadata.userId before a
 * customer row is linked). Returns null when nothing resolves — provisioning is
 * then deferred until a later event supplies the linkage.
 */
async function resolveUserIdForCustomer(customerId: string): Promise<string | null> {
  const db = createServerClient();
  const { data, error } = await db
    .from("creem_customers")
    .select("user_id")
    .eq("creem_customer_id", customerId)
    .maybeSingle();
  if (error) throw new Error(`resolveUserIdForCustomer failed: ${error.message}`);
  const fromCustomer = (data as { user_id: string | null } | null)?.user_id ?? null;
  if (fromCustomer) return fromCustomer;
  const subs = await getCreemSubscriptionsForCustomer(customerId);
  return subs.find((s) => s.user_id)?.user_id ?? null;
}

// ── Route ────────────────────────────────────────────────────────────────────────

export async function POST(request: Request): Promise<Response> {
  // 1. Raw body FIRST — never parse before verification.
  const rawBody = await request.text();

  // 2. Config + header preconditions.
  const secret = (process.env.CREEM_WEBHOOK_SECRET ?? "").trim();
  if (!secret) {
    // Config error — must NOT be 2xx (would silently drop real events).
    console.error("[creem/webhook] CREEM_WEBHOOK_SECRET is not set.");
    return NextResponse.json({ error: "webhook_not_configured" }, { status: 500 });
  }
  const signature = request.headers.get("creem-signature");
  if (!signature) {
    return NextResponse.json({ error: "missing_signature" }, { status: 400 });
  }

  // 3. Verify the HMAC over the RAW text before parsing. timingSafeEqual requires
  //    equal-length buffers — a length mismatch is itself an invalid signature.
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const sigBuf = Buffer.from(signature, "utf8");
  const expBuf = Buffer.from(expected, "utf8");
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    console.error("[creem/webhook] signature verification failed.");
    return NextResponse.json({ error: "invalid_signature" }, { status: 400 });
  }

  // 4. Parse now (verified). A malformed verified body is a 400 (won't get better
  //    on retry, and the signature already proved provenance).
  let event: CreemEventEnvelope;
  try {
    event = JSON.parse(rawBody) as CreemEventEnvelope;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const eventId = asString(event.id);
  const eventType = asString(event.eventType);
  if (!eventId || !eventType) {
    return NextResponse.json({ error: "invalid_envelope" }, { status: 400 });
  }
  const occurredAt = createdAtToIso(event.created_at);
  const object = (event.object ?? {}) as Record<string, unknown>;

  // 5. Event-level idempotency: record the id AFTER verification. A duplicate
  //    delivery (already-seen id) short-circuits to 200 without reprocessing.
  try {
    const fresh = await markWebhookEventSeen(eventId, eventType);
    if (!fresh) {
      return NextResponse.json({ ok: true, deduped: true });
    }
  } catch (err) {
    console.error(
      "[creem/webhook] dedup insert failed:",
      err instanceof Error ? err.message : String(err),
    );
    return NextResponse.json({ error: "processing_failed" }, { status: 500 });
  }

  // 6. Route by verified event type. DB/provisioning failures → 500 (retry-safe).
  try {
    switch (eventType) {
      case "checkout.completed": {
        const o = object as CreemCheckoutObject;
        const customerId = idOf(o.customer);
        const metaUserId = userIdFromMetadata(o.metadata);
        if (customerId) {
          await upsertCreemCustomer({
            customerId,
            email: emailOf(o.customer),
            userId: metaUserId,
            occurredAt,
          });
          if (metaUserId) await linkCustomerToUser(customerId, metaUserId);
        }
        console.log(
          `[creem/webhook] checkout.completed ${asString(o.id) ?? "?"} (customer ${customerId ?? "none"}).`,
        );
        break;
      }

      case "subscription.active":
      case "subscription.paid": {
        await handleSubscriptionActive(object as CreemSubscriptionObject, occurredAt);
        break;
      }

      case "subscription.trialing": {
        // A trial grants access (creemStatusGrantsAccess includes "trialing").
        // Same grant path as active, but the mirrored status stays "trialing".
        await handleSubscriptionActive(
          object as CreemSubscriptionObject,
          occurredAt,
          "trialing",
        );
        break;
      }

      case "subscription.scheduled_cancel": {
        await handleScheduledCancel(object as CreemSubscriptionObject, occurredAt);
        break;
      }

      case "subscription.update": {
        // Re-evaluate from the event's own status field: an active/trialing
        // update grants (plan may have changed on an upgrade), a terminal status
        // revokes. Never assume — read the reported status.
        await handleSubscriptionUpdate(object as CreemSubscriptionObject, occurredAt);
        break;
      }

      case "subscription.past_due":
      case "subscription.paused":
      case "subscription.unpaid":
      case "subscription.expired":
      case "subscription.canceled": {
        await handleRevoke(object as CreemSubscriptionObject, occurredAt);
        break;
      }

      case "refund.created":
      case "dispute.created": {
        const o = object as CreemRefundDisputeObject;
        const customerId = idOf(o.customer);
        const metaUserId = userIdFromMetadata(o.metadata);
        if (customerId) {
          // Mirror-light: ensure the customer row exists; never change plan here
          // (a subscription.canceled follows if the sub actually ends).
          await upsertCreemCustomer({
            customerId,
            email: emailOf(o.customer),
            userId: metaUserId,
            occurredAt,
          });
          if (metaUserId) await linkCustomerToUser(customerId, metaUserId);
        }
        console.log(
          `[creem/webhook] ${eventType} ${asString(o.id) ?? "?"} (customer ${customerId ?? "none"}) recorded.`,
        );
        break;
      }

      default:
        // Verified but not one we act on — acknowledge so Creem stops retrying.
        break;
    }
  } catch (err) {
    console.error(
      "[creem/webhook] processing failed:",
      err instanceof Error ? err.message : String(err),
    );
    // Roll back the dedup ledger entry so Creem's retry is NOT short-circuited to
    // a deduped 200 — otherwise a transient failure would lose the event forever.
    // Reprocessing is safe: the mirror upserts are idempotent (PK-keyed).
    await unmarkWebhookEvent(eventId);
    return NextResponse.json({ error: "processing_failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}

// ── Handlers ──────────────────────────────────────────────────────────────────────

/**
 * subscription.active / subscription.paid / subscription.trialing: mirror the
 * subscription and, when a user is resolvable and the status grants access,
 * provision the plan. "paid" is stored as "active" (it is the paid/renewed signal
 * for an active sub); "trialing" keeps its own status (also access-granting).
 *
 * `mirrorStatus` is the status persisted + used for the grant check ("active" for
 * active/paid, "trialing" for a trial). Both pass creemStatusGrantsAccess.
 */
async function handleSubscriptionActive(
  o: CreemSubscriptionObject,
  occurredAt: string,
  mirrorStatus: "active" | "trialing" = "active",
): Promise<void> {
  const subId = asString(o.id);
  const customerId = idOf(o.customer);
  if (!subId || !customerId) {
    console.warn(
      `[creem/webhook] subscription.${mirrorStatus} missing sub/customer id — skipping mirror.`,
    );
    return;
  }
  const productId =
    idOf(o.product) ?? asString(o.items?.[0]?.product_id) ?? null;
  const mapping = productId ? resolveCreemProduct(productId) : null;
  if (productId && !mapping) {
    console.warn(
      `[creem/webhook] subscription ${subId}: product ${productId} not in CREEM_PRODUCT_* map — mirroring with null plan.`,
    );
  }
  const plan: PlanKey | null = mapping?.plan ?? null;
  const interval = mapping?.interval ?? null;
  const currentPeriodEnd = asString(o.current_period_end_date);
  const metaUserId = userIdFromMetadata(o.metadata);

  const outcome = await upsertCreemSubscription({
    subscriptionId: subId,
    customerId,
    userId: metaUserId,
    status: mirrorStatus, // active + paid normalize to "active"; trialing kept
    productId: productId ?? "",
    plan,
    billingInterval: interval,
    currentPeriodEnd,
    scheduledCancel: false,
    occurredAt,
  });

  // If this event knows the user, make sure the customer row exists + is linked
  // (order-independent) so portal/lookups resolve for a paying user. Linkage is
  // monotonic and safe to run even for a stale event.
  if (metaUserId) {
    await upsertCreemCustomer({
      customerId,
      email: emailOf(o.customer),
      userId: metaUserId,
      occurredAt,
    });
    await linkCustomerToUser(customerId, metaUserId);
  }

  // ONLY an applied (non-stale) event may change the plan — a replayed old event
  // must never re-grant/override a newer state.
  if (outcome === "stale") {
    console.log(
      `[creem/webhook] subscription ${subId}: stale ${mirrorStatus} event skipped for provisioning.`,
    );
    return;
  }

  const userId = metaUserId ?? (await resolveUserIdForCustomer(customerId));
  if (!userId) {
    console.warn(
      `[creem/webhook] subscription ${subId}: no VibePin user resolvable (customer ${customerId}); mirror stored, provisioning deferred.`,
    );
    return;
  }
  if (plan && creemStatusGrantsAccess(mirrorStatus)) {
    await setUserPlan(userId, plan);
  }
}

/**
 * subscription.scheduled_cancel: mirror the scheduled state (scheduled_cancel=true)
 * but DO NOT revoke — the user stays entitled until current_period_end. Provision
 * the plan as normal when the (still-active) status grants access.
 */
async function handleScheduledCancel(
  o: CreemSubscriptionObject,
  occurredAt: string,
): Promise<void> {
  const subId = asString(o.id);
  const customerId = idOf(o.customer);
  if (!subId || !customerId) {
    console.warn(
      `[creem/webhook] scheduled_cancel missing sub/customer id — skipping mirror.`,
    );
    return;
  }
  const productId =
    idOf(o.product) ?? asString(o.items?.[0]?.product_id) ?? null;
  const mapping = productId ? resolveCreemProduct(productId) : null;
  const plan: PlanKey | null = mapping?.plan ?? null;
  const interval = mapping?.interval ?? null;
  // Keep whatever status Creem reports (likely still "active", or "scheduled_cancel").
  const status = asString(o.status) ?? "active";
  const currentPeriodEnd = asString(o.current_period_end_date);
  const metaUserId = userIdFromMetadata(o.metadata);

  const outcome = await upsertCreemSubscription({
    subscriptionId: subId,
    customerId,
    userId: metaUserId,
    status,
    productId: productId ?? "",
    plan,
    billingInterval: interval,
    currentPeriodEnd,
    scheduledCancel: true, // still entitled until period end
    occurredAt,
  });

  if (metaUserId) {
    await upsertCreemCustomer({
      customerId,
      email: emailOf(o.customer),
      userId: metaUserId,
      occurredAt,
    });
    await linkCustomerToUser(customerId, metaUserId);
  }

  if (outcome === "stale") {
    console.log(
      `[creem/webhook] subscription ${subId}: stale scheduled_cancel event skipped for provisioning.`,
    );
    return;
  }

  const userId = metaUserId ?? (await resolveUserIdForCustomer(customerId));
  if (userId && plan && creemStatusGrantsAccess(status)) {
    await setUserPlan(userId, plan);
  }
}

/**
 * subscription.past_due / paused / unpaid / expired / canceled: mirror the
 * terminal/lapsed status and revoke the plan (set "free") for the resolvable
 * user — but ONLY when the event is applied (not a stale replay). Mirror
 * regardless of whether a user is resolvable.
 */
async function handleRevoke(
  o: CreemSubscriptionObject,
  occurredAt: string,
): Promise<void> {
  const subId = asString(o.id);
  const customerId = idOf(o.customer);
  if (!subId || !customerId) {
    console.warn(
      `[creem/webhook] revoke event missing sub/customer id — skipping mirror.`,
    );
    return;
  }
  const productId =
    idOf(o.product) ?? asString(o.items?.[0]?.product_id) ?? null;
  const mapping = productId ? resolveCreemProduct(productId) : null;
  const status = asString(o.status) ?? "canceled";
  const currentPeriodEnd = asString(o.current_period_end_date);
  const metaUserId = userIdFromMetadata(o.metadata);

  const outcome = await upsertCreemSubscription({
    subscriptionId: subId,
    customerId,
    userId: metaUserId,
    status,
    productId: productId ?? "",
    plan: mapping?.plan ?? null,
    billingInterval: mapping?.interval ?? null,
    currentPeriodEnd,
    scheduledCancel: false,
    occurredAt,
  });

  // ONLY revoke on an applied event. This is the guard that stops a replayed old
  // `canceled` from demoting a member whose subscription is currently active.
  if (outcome === "stale") {
    console.log(
      `[creem/webhook] subscription ${subId}: stale revoke event skipped (member keeps current plan).`,
    );
    return;
  }

  const userId = metaUserId ?? (await resolveUserIdForCustomer(customerId));
  if (userId) {
    await setUserPlan(userId, "free"); // revoke
  }
}

/**
 * subscription.update: a catch-all change event. Re-evaluate entitlement from the
 * event's OWN status — grant (active/trialing) or revoke (any terminal status).
 * The plan may have changed (e.g. an upgrade), so we always source it from the
 * event's product mapping. Only an applied (non-stale) event touches the plan.
 */
async function handleSubscriptionUpdate(
  o: CreemSubscriptionObject,
  occurredAt: string,
): Promise<void> {
  const subId = asString(o.id);
  const customerId = idOf(o.customer);
  if (!subId || !customerId) {
    console.warn(
      `[creem/webhook] subscription.update missing sub/customer id — skipping mirror.`,
    );
    return;
  }
  const productId =
    idOf(o.product) ?? asString(o.items?.[0]?.product_id) ?? null;
  const mapping = productId ? resolveCreemProduct(productId) : null;
  if (productId && !mapping) {
    console.warn(
      `[creem/webhook] subscription ${subId}: product ${productId} not in CREEM_PRODUCT_* map — mirroring with null plan.`,
    );
  }
  const plan: PlanKey | null = mapping?.plan ?? null;
  const status = asString(o.status) ?? "active";
  const grants = creemStatusGrantsAccess(status);
  const currentPeriodEnd = asString(o.current_period_end_date);
  const metaUserId = userIdFromMetadata(o.metadata);

  const outcome = await upsertCreemSubscription({
    subscriptionId: subId,
    customerId,
    userId: metaUserId,
    status,
    productId: productId ?? "",
    plan,
    billingInterval: mapping?.interval ?? null,
    currentPeriodEnd,
    scheduledCancel: false,
    occurredAt,
  });

  if (metaUserId) {
    await upsertCreemCustomer({
      customerId,
      email: emailOf(o.customer),
      userId: metaUserId,
      occurredAt,
    });
    await linkCustomerToUser(customerId, metaUserId);
  }

  if (outcome === "stale") {
    console.log(
      `[creem/webhook] subscription ${subId}: stale update event skipped for provisioning.`,
    );
    return;
  }

  const userId = metaUserId ?? (await resolveUserIdForCustomer(customerId));
  if (!userId) return;
  if (grants && plan) {
    await setUserPlan(userId, plan); // grant / re-grant (possibly changed plan)
  } else if (!grants) {
    await setUserPlan(userId, "free"); // terminal status → revoke
  }
  // grants && !plan (unknown product) → never grant; leave plan unchanged.
}
