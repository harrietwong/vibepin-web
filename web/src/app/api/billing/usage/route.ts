/**
 * GET /api/billing/usage — current-period usage snapshot for the signed-in user.
 *
 * Auth: cookie session (same-origin browser fetch) → bearer fallback. 401 when
 * unauthenticated.
 *
 * Response contract (the Settings usage UI depends on this shape — do NOT change
 * the keys):
 *   {
 *     plan: "free" | "starter" | "pro" | "business",
 *     periodStart: ISO, periodEnd: ISO,
 *     aiImages:            { used, limit|null },
 *     aiTextGenerations:   { used, limit: null },
 *     scheduledPosts:      { used, limit|null }
 *   }
 *
 * On any server error → 500 (the UI shows a sync error rather than silently
 * pretending the user is on Free). A FREE user (no Creem subscription) resolves to
 * the "free" plan and returns its real quotas — free is a valid answer, never an
 * error.
 */

import { NextResponse } from "next/server";
import { getUserIdFromSameOriginSession } from "@/lib/server/authUser";
import { resolvePlan } from "@/lib/server/entitlements";
import { getUsageSummary, periodStart, periodEnd } from "@/lib/server/usage";
import { limitForUsageType } from "@/lib/planEntitlements";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const userId = await getUserIdFromSameOriginSession(req).catch(() => null);
  if (!userId) {
    return NextResponse.json(
      { error: "unauthorized", message: "Sign in to view usage." },
      { status: 401 },
    );
  }

  try {
    const now = new Date();
    // resolvePlan never throws (it degrades to "free"); a hard failure below is
    // treated as a real error (500) rather than a silent Free downgrade.
    const [plan, summary] = await Promise.all([
      resolvePlan(userId),
      getUsageSummary(userId, now),
    ]);

    return NextResponse.json({
      plan,
      periodStart: periodStart(now).toISOString(),
      periodEnd: periodEnd(now).toISOString(),
      aiImages: {
        used: summary.ai_image,
        limit: limitForUsageType(plan, "ai_image"),
      },
      aiTextGenerations: {
        used: summary.ai_text_generation,
        limit: limitForUsageType(plan, "ai_text_generation"),
      },
      scheduledPosts: {
        used: summary.scheduled_post,
        limit: limitForUsageType(plan, "scheduled_post"),
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
