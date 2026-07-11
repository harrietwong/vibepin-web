/**
 * POST /api/publish/destinations/validate
 *
 * Given a set of chosen destinations, tells the client which are publishable
 * (the platform is connected and usable) and which are blocked (not connected /
 * expired). Used to gate the Publish button and render per-destination hints.
 *
 * Body: { destinations: Array<{ provider: SocialProvider, socialConnectionId?: string }> }
 *
 * Response:
 *   {
 *     ok: boolean,               // true when every requested destination is publishable
 *     results: Array<{
 *       provider,
 *       publishable: boolean,
 *       status: ConnectionStatus,
 *       socialConnectionId: string | null,
 *       reason?: string
 *     }>
 *   }
 */

import { getUserIdFromBearer } from "@/lib/server/authUser";
import { isSocialProvider, platformName } from "@/lib/social/platforms";
import { summarizeConnections } from "@/lib/social/server/socialConnectionStore";

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

  const requested = Array.isArray(body.destinations) ? body.destinations : [];
  if (!requested.length) {
    return Response.json({ error: "destinations must be a non-empty array" }, { status: 400 });
  }

  const summaries = await summarizeConnections(uid);
  const byProvider = new Map(summaries.map(s => [s.provider, s]));

  const results = requested.map((raw) => {
    const provider = (raw as { provider?: unknown }).provider;
    if (!isSocialProvider(provider)) {
      return {
        provider: String(provider),
        publishable: false,
        status: "not_connected" as const,
        socialConnectionId: null,
        reason: "Unknown platform",
      };
    }
    const summary = byProvider.get(provider);
    const usable = summary?.accounts.find(a => a.connectionStatus === "connected") ?? null;
    if (!summary?.connected || !usable) {
      return {
        provider,
        publishable: false,
        status: summary?.status ?? ("not_connected" as const),
        socialConnectionId: null,
        reason: `Connect your ${platformName(provider)} account in Settings to publish here.`,
      };
    }
    return {
      provider,
      publishable: true,
      status: "connected" as const,
      socialConnectionId: usable.id,
    };
  });

  return Response.json({ ok: results.every(r => r.publishable), results });
}
