/**
 * GET /api/billing/usage — current-period usage snapshot for the signed-in user.
 *
 * Auth: bearer token or cookie session (getUserIdFromBearerOrCookies). 401 when
 * unauthenticated.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * DATA SOURCE: usage_accounts (v55 primitives + v56 lifecycle)
 * ═══════════════════════════════════════════════════════════════════════════════
 * This route READS the reserve/settle ledger's account row — the same row the
 * metering helpers in lib/server/usage/ mutate. It reads the SETTLED counters
 * (`*_used`) and deliberately IGNORES the `*_reserved` columns: a reservation is
 * in-flight, unconfirmed work that may still be released (a failed generation
 * releases its slots). Showing reserved capacity as "used" would make a user's
 * number jump up and then back down mid-request. Settled usage only.
 *
 * The account row's `*_limit` columns are PERIOD SNAPSHOTS taken when the account
 * was initialized or rolled — they are authoritative for a user who has one,
 * because that is the allowance actually being enforced against them this period,
 * even if the plan config has since changed.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * THE NO-ROW CASE — HONESTY OVER FABRICATION
 * ═══════════════════════════════════════════════════════════════════════════════
 * Metering is in SHADOW mode, and accounts are created LAZILY on a user's first
 * metered action. So most users have NO usage_accounts row at all. Two rules:
 *
 *  1. We do NOT call ensureUsageAccount here. A GET is a read; a read endpoint
 *     must never create billing state as a side effect of someone opening a
 *     settings tab. Account creation belongs to the metered action (and to the
 *     Creem webhook), where it can be attributed to a real event.
 *
 *  2. We do NOT fabricate zeros. `used: 0` asserts "we measured, and it was
 *     zero" — which is false when nothing was ever measured. Instead the
 *     response carries `metered: false` with `used: null`, and the client shows
 *     the plan's included allowances rather than a fake 0/10 progress bar.
 *
 * `included` (from the canonical PLAN_ENTITLEMENTS config) is therefore always
 * present and always means "what this plan includes". `limit` inside each bucket
 * means "the cap being enforced on this account right now" and exists only when
 * an account row does. When metered=false the two are the same numbers, but only
 * `included` is a claim we can actually stand behind.
 *
 * Response contract (the Settings usage UI depends on this shape):
 *   {
 *     plan: "free" | "starter" | "pro" | "business",
 *     metered: boolean,              // false => no usage_accounts row yet
 *     periodStart: ISO | null,       // null when unmetered (no real period yet)
 *     periodEnd:   ISO | null,
 *     bonusImages: number | null,    // v55/v56 bonus grant balance; null unmetered
 *     aiImages:          { used: number|null, limit: number|null, included: number|null },
 *     aiTextGenerations: { used: number|null, limit: number|null, included: number|null },
 *     scheduledPosts:    { used: number|null, limit: number|null, included: number|null }
 *   }
 *
 * A `limit` / `included` of null means UNLIMITED (the PLAN_ENTITLEMENTS
 * convention, e.g. Business scheduled posts) — distinguish it from `used: null`,
 * which means "not measured".
 *
 * On any server error → 500, so the UI can show an explicit sync error instead of
 * silently pretending the user is on Free with no usage. A FREE user is a valid
 * answer, never an error.
 */

import { NextResponse } from "next/server";
import { getUserIdFromBearerOrCookies } from "@/lib/server/authUser";
import { resolvePlan } from "@/lib/server/entitlements";
import { createServerClient } from "@/lib/supabase";
import { PLAN_ENTITLEMENTS, type PlanKey } from "@/lib/server/planEntitlements";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The usage_accounts columns this read needs. Reserved counters are excluded on purpose. */
type UsageAccountRow = {
  period_start: string | null;
  period_end: string | null;
  ai_images_used: number | null;
  ai_images_limit: number | null;
  ai_text_generations_used: number | null;
  ai_text_generations_limit: number | null;
  scheduled_posts_used: number | null;
  scheduled_posts_limit: number | null;
  bonus_images_balance: number | null;
};

const ACCOUNT_COLUMNS =
  "period_start, period_end, " +
  "ai_images_used, ai_images_limit, " +
  "ai_text_generations_used, ai_text_generations_limit, " +
  "scheduled_posts_used, scheduled_posts_limit, " +
  "bonus_images_balance";

/**
 * Fetch the user's usage account, or null when they have none yet.
 * `maybeSingle` returns null data (no error) for zero rows, which is the normal
 * shadow-mode case — NOT an error. A genuine query error is thrown so the route
 * answers 500 rather than misreporting an unmetered user.
 */
async function fetchUsageAccount(userId: string): Promise<UsageAccountRow | null> {
  const { data, error } = await createServerClient()
    .from("usage_accounts")
    .select(ACCOUNT_COLUMNS)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(`usage_accounts read failed: ${error.message}`);
  return (data as UsageAccountRow | null) ?? null;
}

/** A counter that exists but is null in the DB is treated as 0 (the column defaults to 0). */
function settled(value: number | null): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export async function GET(req: Request) {
  const userId = await getUserIdFromBearerOrCookies(req).catch(() => null);
  if (!userId) {
    return NextResponse.json(
      { error: "unauthorized", message: "Sign in to view usage." },
      { status: 401 },
    );
  }

  try {
    // resolvePlan never throws (it degrades to "free"); a hard failure below is
    // treated as a real error (500) rather than a silent Free downgrade.
    const [plan, account] = await Promise.all([
      resolvePlan(userId) as Promise<PlanKey>,
      fetchUsageAccount(userId),
    ]);

    const entitlements = PLAN_ENTITLEMENTS[plan] ?? PLAN_ENTITLEMENTS.free;
    const includedImages = entitlements.monthlyAiImages;
    const includedText = entitlements.monthlyAiTextGenerations;
    const includedPosts = entitlements.monthlyScheduledPosts;

    if (!account) {
      // No account row: metering has never touched this user. Report the plan's
      // included allowances and say so — never fabricate measured zeros.
      return NextResponse.json({
        plan,
        metered: false,
        periodStart: null,
        periodEnd: null,
        bonusImages: null,
        aiImages: { used: null, limit: null, included: includedImages },
        aiTextGenerations: { used: null, limit: null, included: includedText },
        scheduledPosts: { used: null, limit: null, included: includedPosts },
      });
    }

    return NextResponse.json({
      plan,
      metered: true,
      periodStart: account.period_start,
      periodEnd: account.period_end,
      bonusImages: settled(account.bonus_images_balance),
      aiImages: {
        used: settled(account.ai_images_used),
        limit: account.ai_images_limit,
        included: includedImages,
      },
      aiTextGenerations: {
        used: settled(account.ai_text_generations_used),
        limit: account.ai_text_generations_limit,
        included: includedText,
      },
      scheduledPosts: {
        used: settled(account.scheduled_posts_used),
        limit: account.scheduled_posts_limit,
        included: includedPosts,
      },
    });
  } catch (err) {
    console.error(
      "[/api/billing/usage] error:",
      (err as Error)?.message ?? String(err),
    );
    return NextResponse.json(
      { error: "usage_unavailable", message: "Could not load usage." },
      { status: 500 },
    );
  }
}
