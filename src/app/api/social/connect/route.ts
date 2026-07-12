/**
 * POST /api/social/connect
 *
 * Begins connecting a social platform. Vendor-neutral: it delegates to the
 * active provider abstraction (mock by default) except for Pinterest, which has
 * a dedicated, already-live OAuth flow that must not be disturbed.
 *
 * Body: { provider: "pinterest" | "instagram" | "facebook" | "tiktok", next?: string }
 *
 * Response:
 *   {
 *     provider,
 *     status: "oauth_url" | "pending" | "coming_soon",
 *     url:    string | null,   // redirect here when status === "oauth_url"
 *     message?: string         // shown to the user when there is no live path yet
 *   }
 *
 * This never publishes anything and never auto-connects — it only returns the
 * next step for a connection the merchant explicitly initiated.
 */

import { getUserIdFromBearer } from "@/lib/server/authUser";
import { getSocialProvider } from "@/lib/social/providers";
import { isProviderConfigError, PROVIDER_NOT_CONFIGURED_MESSAGE } from "@/lib/social/providers/errors";
import { isSocialProvider } from "@/lib/social/platforms";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const uid = await getUserIdFromBearer(req);
  if (!uid) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const provider = body.provider;
  if (!isSocialProvider(provider)) {
    return Response.json({ error: "Unknown or missing provider" }, { status: 400 });
  }

  const next = typeof body.next === "string" && body.next ? body.next : "/app/settings/social";

  // Pinterest keeps its dedicated, tested OAuth route. Point the client at it
  // rather than routing Pinterest through the generic provider abstraction.
  if (provider === "pinterest") {
    return Response.json({
      provider,
      status: "oauth_url",
      url: `/api/auth/pinterest/connect?next=${encodeURIComponent(next)}`,
      message: null,
    });
  }

  try {
    const result = await getSocialProvider().getConnectUrl({ provider, userId: uid, returnTo: next });
    return Response.json({ provider, ...result });
  } catch (err) {
    if (isProviderConfigError(err)) {
      // Safe, generic message — never names the missing key or leaks config.
      return Response.json({ error: PROVIDER_NOT_CONFIGURED_MESSAGE }, { status: 503 });
    }
    console.error("[social/connect POST]", (err as Error).message);
    return Response.json({ error: "Could not start connection" }, { status: 500 });
  }
}
