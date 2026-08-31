/**
 * GET /api/social/connections
 *
 * Returns the authenticated merchant's connected social accounts, plus a
 * per-platform summary for all four supported platforms (Pinterest, Instagram,
 * Facebook Page, TikTok). Token ciphertext is never included.
 *
 * Response:
 *   {
 *     platforms:    PlatformConnectionSummary[] // one per platform, in catalog order
 *     connections:  SocialConnection[]          // flat list of the accounts held
 *     plan:         "free" | "starter" | "pro" | "business"
 *     planInterval: "month" | "year" | null     // how that plan is billed
 *     allowance:    { purchasedSlots, slotsAvailable } | null
 *   }
 *
 * DISCONNECTED accounts are included (PRD 0805 §11). Disconnect keeps the row on
 * every platform and it goes on holding the merchant’s plan slot, so Settings has to
 * show it — as "Disconnected", with Reconnect and Remove. Remove is the hard delete
 * and the only action that frees the slot.
 *
 * This is the ONE listing that includes them. Publish-side readers (publish/social,
 * publish/destinations/validate) call the plain `listConnections`, which is still
 * active-only. Clients that read THIS endpoint for a publish decision filter on
 * `connectionStatus === "connected"` themselves — PublishDestinations, StudioBoard,
 * SettingsModal and usePinterestConnections all do.
 *
 * `plan` is here so the Settings panel can offer the right action when a connect is
 * refused: a paid user can buy an extra account slot, a Free user can only upgrade.
 * It is resolved with the SAME resolver the connect gate uses (never user_metadata,
 * never a client value), so the offer and the enforcement cannot disagree. It
 * degrades to "free" if resolution fails — the Upgrade CTA is always safe to show.
 *
 * `planInterval` (决策 A) is what the add-on CTA prices itself off: slots follow the
 * main plan's billing interval, so a yearly subscriber must be shown the yearly
 * price. Null = unknown → the panel shows the monthly price, which is exactly what
 * the checkout route falls back to charging.
 *
 * `allowance` (决策 B) is the two numbers the panel needs after a slot purchase
 * lands: how many slots are owned and how many are still free. It reuses the SAME
 * snapshot the connect gate evaluates, so "the banner went away" and "the connect
 * will now be allowed" are the same fact.
 *
 * Both new fields are ADDITIVE and fail-open: any failure leaves them null and the
 * response is still 200 with the original shape. Nothing here may become a new
 * reason for the Settings page to fail to load.
 */

import { getUserIdFromBearerOrCookies } from "@/lib/server/authUser";
import { listConnectionsForSettings, summarizeConnectionList } from "@/lib/social/server/socialConnectionStore";
import { getActivePlanInterval, resolvePlan } from "@/lib/server/entitlements";
import {
  evaluateAllowance,
  getAllowanceSnapshot,
} from "@/lib/server/social/accountAllowance";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const uid = await getUserIdFromBearerOrCookies(req).catch(() => null);
  if (!uid) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const [connections, plan] = await Promise.all([
      listConnectionsForSettings(uid),
      resolvePlan(uid).catch(() => "free" as const),
    ]);

    // Read-only extras. The plan is passed into the snapshot so it is NOT resolved a
    // second time. Both are individually wrapped: a slow or broken billing read must
    // degrade the CTA's precision, never the page.
    const [planInterval, allowance] = await Promise.all([
      getActivePlanInterval(uid).catch(() => null),
      getAllowanceSnapshot(uid, { plan })
        .then((snapshot) => {
          if (!snapshot) return null;
          // The provider argument is irrelevant to the two fields taken here:
          // `slotsInUse` is summed over EVERY provider, so purchasedSlots and
          // slotsAvailable are the same whichever one is passed.
          const verdict = evaluateAllowance(snapshot, "pinterest");
          return {
            purchasedSlots: verdict.purchasedSlots,
            slotsAvailable: verdict.slotsAvailable,
          };
        })
        .catch(() => null),
    ]);

    const platforms = summarizeConnectionList(connections);
    return Response.json({ platforms, connections, plan, planInterval, allowance });
  } catch (err) {
    console.error("[social/connections GET]", (err as Error).message);
    return Response.json({ error: "Could not load social connections" }, { status: 500 });
  }
}
