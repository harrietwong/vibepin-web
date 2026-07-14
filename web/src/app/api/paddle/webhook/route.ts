/**
 * Paddle Billing webhook (POST /api/paddle/webhook).
 *
 * Notification destination ntfset_… → https://vibepin.co/api/paddle/webhook,
 * events: subscription.created/updated/canceled, customer.created/updated,
 * transaction.completed.
 *
 * Flow: read the RAW body (never JSON.parse before verification) → verify the
 * Paddle signature via the SDK → mirror the event into billing_customers /
 * billing_subscriptions (source of truth) → refresh user_metadata.plan (derived
 * cache read by resolvePlan/useUserTier).
 *
 * Status contract:
 *   - 400 on missing signature header or a verification failure — Paddle must
 *     retry/flag; never 2xx an unverified body.
 *   - 500 on missing signing secret (config error) or a DB/provisioning failure —
 *     Paddle retries; deliveries are at-least-once and converge.
 *   - 200 {ok:true} on success and on verified-but-ignored event types.
 *
 * Handlers are idempotent (PK upserts + occurred_at guard) — safe under Paddle's
 * at-least-once, out-of-order delivery.
 */

import { NextResponse } from "next/server";
import { EventName } from "@paddle/paddle-node-sdk";
import { getPaddleServer } from "@/lib/server/paddle/paddleServer";
import {
  planKeyForPriceId,
  subscriptionGrantsAccess,
  upsertBillingCustomer,
  upsertBillingSubscription,
} from "@/lib/server/paddle/billingStore";
import { createServerClient } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Extract a valid userId from a Paddle custom_data blob, or null. */
function userIdFromCustomData(customData: unknown): string | null {
  if (!customData || typeof customData !== "object") return null;
  const raw = (customData as Record<string, unknown>).userId;
  if (typeof raw === "string" && UUID_RE.test(raw.trim())) return raw.trim();
  return null;
}

/**
 * Refresh a user's cached `user_metadata.plan` without wiping other metadata
 * keys. GoTrue shallow-merges top-level user_metadata keys, but we read-merge
 * defensively so unrelated keys are provably preserved.
 */
async function setUserPlan(userId: string, plan: string): Promise<void> {
  const admin = createServerClient();
  const { data, error: readErr } = await admin.auth.admin.getUserById(userId);
  if (readErr || !data?.user) {
    throw new Error(`getUserById(${userId}) failed: ${readErr?.message ?? "no user"}`);
  }
  const existingMeta =
    (data.user.user_metadata as Record<string, unknown> | null) ?? {};
  if (existingMeta.plan === plan) return; // no-op: cache already correct
  const { error } = await admin.auth.admin.updateUserById(userId, {
    user_metadata: { ...existingMeta, plan },
  });
  if (error) throw new Error(`updateUserById(${userId}) failed: ${error.message}`);
}

export async function POST(request: Request): Promise<Response> {
  // 1. Raw body FIRST — never parse before verification.
  const rawBody = await request.text();

  // 2. Config + header preconditions.
  const secret = (process.env.PADDLE_WEBHOOK_SECRET ?? "").trim();
  if (!secret) {
    // Config error — must NOT be 2xx (would silently drop real events).
    console.error("[paddle/webhook] PADDLE_WEBHOOK_SECRET is not set.");
    return NextResponse.json({ error: "webhook_not_configured" }, { status: 500 });
  }
  const signature = request.headers.get("paddle-signature");
  if (!signature) {
    return NextResponse.json({ error: "missing_signature" }, { status: 400 });
  }

  // 3. Verify FIRST. unmarshal is async and THROWS on signature mismatch or a
  //    malformed body; a failure here is never 2xx so Paddle retries/flags.
  let event;
  try {
    event = await getPaddleServer().webhooks.unmarshal(rawBody, secret, signature);
  } catch (err) {
    console.error(
      "[paddle/webhook] signature verification failed:",
      err instanceof Error ? err.message : String(err),
    );
    return NextResponse.json({ error: "invalid_signature" }, { status: 400 });
  }
  if (!event) {
    return NextResponse.json({ error: "invalid_signature" }, { status: 400 });
  }

  // 4. Route by verified event type. DB/provisioning failures → 500 (retry).
  try {
    switch (event.eventType) {
      case EventName.CustomerCreated:
      case EventName.CustomerUpdated: {
        const c = event.data;
        await upsertBillingCustomer({
          customerId: c.id,
          email: c.email ?? null,
          userId: userIdFromCustomData(c.customData),
          occurredAt: event.occurredAt,
        });
        break;
      }

      case EventName.SubscriptionCreated:
      case EventName.SubscriptionUpdated:
      case EventName.SubscriptionCanceled: {
        const s = event.data;
        const firstItem = s.items[0] ?? null;
        const priceId = firstItem?.price?.id ?? null;
        const productId = firstItem?.price?.productId ?? firstItem?.product?.id ?? null;
        if (!priceId || !productId) {
          // A subscription with no price/product item is unexpected; store nothing
          // rather than write a half-row, but do not fail the delivery.
          console.warn(
            `[paddle/webhook] subscription ${s.id} missing price/product item — skipping mirror.`,
          );
          break;
        }
        const planKey = planKeyForPriceId(priceId);
        const eventUserId = userIdFromCustomData(s.customData);

        await upsertBillingSubscription({
          subscriptionId: s.id,
          customerId: s.customerId,
          userId: eventUserId,
          status: s.status,
          priceId,
          productId,
          planKey,
          scheduledChangeAction: s.scheduledChange?.action ?? null,
          scheduledChangeAt: s.scheduledChange?.effectiveAt ?? null,
          currentPeriodEnd: s.currentBillingPeriod?.endsAt ?? null,
          occurredAt: event.occurredAt,
        });

        // Provisioning: resolve the VibePin user (event custom_data first, then
        // the stored customer linkage). If none is resolvable, the mirror is
        // still persisted — provisioning catches up when the linkage arrives.
        let userId = eventUserId;
        if (!userId) {
          // Fall back to the stored customer→user linkage.
          userId = await resolveUserIdForCustomer(s.customerId);
        }
        if (!userId) {
          console.warn(
            `[paddle/webhook] subscription ${s.id}: no VibePin user resolvable (customer ${s.customerId}); mirror stored, provisioning deferred.`,
          );
          break;
        }
        const grants = subscriptionGrantsAccess(s.status);
        const plan = grants && planKey ? planKey : "free";
        await setUserPlan(userId, plan);
        break;
      }

      case EventName.TransactionCompleted: {
        const t = event.data;
        if (t.customerId) {
          // Ensure a customer row exists so a later subscription event has a
          // linkage to hang off. Placeholder: null email until customer.created.
          await upsertBillingCustomer({
            customerId: t.customerId,
            email: null,
            userId: userIdFromCustomData(t.customData),
            occurredAt: event.occurredAt,
          });
        }
        console.log(
          `[paddle/webhook] transaction.completed ${t.id} (customer ${t.customerId ?? "none"}).`,
        );
        break;
      }

      default:
        // Verified but not one we act on — acknowledge so Paddle stops retrying.
        break;
    }
  } catch (err) {
    console.error(
      "[paddle/webhook] processing failed:",
      err instanceof Error ? err.message : String(err),
    );
    // 500 so Paddle retries; the guard + PK upserts make reprocessing safe.
    return NextResponse.json({ error: "processing_failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}

/**
 * Resolve a VibePin user id from the stored billing_customers linkage for a
 * Paddle customer id. Returns null when no row / no linked user.
 *
 * TODO(v2): no email-scan fallback here — if a subscription event arrives with
 * no custom_data.userId and the customer row has no user_id yet, provisioning is
 * deferred until the customer.created (with custom_data) lands. A future version
 * could match customer.email → auth user email as a last resort.
 */
async function resolveUserIdForCustomer(customerId: string): Promise<string | null> {
  const db = createServerClient();
  const { data, error } = await db
    .from("billing_customers")
    .select("user_id")
    .eq("customer_id", customerId)
    .maybeSingle();
  if (error) throw new Error(`resolveUserIdForCustomer failed: ${error.message}`);
  const uid = (data as { user_id: string | null } | null)?.user_id ?? null;
  return uid;
}
