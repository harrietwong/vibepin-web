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
import { isSocialProvider } from "@/lib/social/platforms";
import { resolveDestinationCapability, type PublishMode } from "@/lib/social/destinationCapability";
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
    const item = raw as {
      provider?: unknown;
      socialConnectionId?: unknown;
      boardId?: unknown;
      publishMode?: unknown;
      mediaCount?: unknown;
    };
    const provider = item.provider;
    if (!isSocialProvider(provider)) {
      return {
        provider: String(provider),
        publishable: false,
        status: "not_connected" as const,
        socialConnectionId: null,
        reasonCode: "unsupported_provider" as const,
        reason: "This publishing provider is not supported.",
      };
    }
    const summary = byProvider.get(provider);
    const connectionId = typeof item.socialConnectionId === "string" ? item.socialConnectionId.trim() : "";
    const connection = summary?.accounts.find(account => account.id === connectionId) ?? null;
    const capability = resolveDestinationCapability({
      provider,
      connection,
      connectionId,
      subdestinationId: typeof item.boardId === "string" ? item.boardId : null,
      mode: item.publishMode === "scheduled" ? "scheduled" : "now" as PublishMode,
      mediaCount: typeof item.mediaCount === "number" ? item.mediaCount : 1,
    });
    return {
      provider,
      publishable: capability.selectable,
      status: connection?.connectionStatus ?? summary?.status ?? ("not_connected" as const),
      socialConnectionId: capability.connectionId,
      providerAccountId: capability.providerAccountId,
      displayIdentity: capability.displayIdentity,
      capability: {
        selectable: capability.selectable,
        publishNow: capability.publishNow,
        schedule: capability.schedule,
        requiresMedia: capability.requiresMedia,
        requiresSubdestination: capability.requiresSubdestination,
      },
      ...(capability.unavailableReason ? {
        reasonCode: capability.unavailableReason,
        reason: capability.unavailableReason,
      } : {}),
    };
  });

  return Response.json({ ok: results.every(r => r.publishable), results });
}
