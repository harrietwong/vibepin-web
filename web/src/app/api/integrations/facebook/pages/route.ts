/**
 * GET /api/integrations/facebook/pages
 *
 * Returns the sanitized candidate Facebook Pages for the authenticated user's
 * Facebook connection, so the client can render a Page picker after
 * ?facebook=select_page. Each entry is display-safe:
 *   { pageId, pageName, canPublish, selected }
 *
 * Tokens (encrypted or not) are NEVER returned. No connection or no candidates →
 * an empty list. Requires a logged-in session (same-origin cookie, matching
 * /api/social/connections).
 */

import { getUserIdFromBearerOrCookies } from "@/lib/server/authUser";
import { createServerClient } from "@/lib/supabase";
import type { FacebookConnectionMetadata } from "@/lib/server/facebook/connectionStore";

export const dynamic = "force-dynamic";

const TABLE = "social_connections";
const PROVIDER = "facebook";

function isMissingTable(code: string | undefined): boolean {
  return code === "42P01" || code === "PGRST205";
}

export async function GET(req: Request) {
  const uid = await getUserIdFromBearerOrCookies(req).catch(() => null);
  if (!uid) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await createServerClient()
    .from(TABLE)
    .select("metadata")
    .eq("user_id", uid)
    .eq("provider", PROVIDER)
    .maybeSingle();

  if (error) {
    if (isMissingTable(error.code)) return Response.json({ pages: [] });
    console.error("[facebook/pages GET]", error.message);
    return Response.json({ error: "Could not load Facebook Pages" }, { status: 500 });
  }

  const metadata = (data as { metadata?: Record<string, unknown> | null } | null)?.metadata ?? null;
  const fb = (metadata as { facebook?: FacebookConnectionMetadata } | null)?.facebook;
  if (!fb) return Response.json({ pages: [] });

  const selectedPageId = fb.selectedPageId ?? null;
  const candidates = Array.isArray(fb.candidatePages) ? fb.candidatePages : [];
  const pages = candidates.map(p => ({
    pageId: p.pageId,
    pageName: p.pageName ?? null,
    canPublish: !!p.canPublish,
    selected: selectedPageId != null && p.pageId === selectedPageId,
  }));

  return Response.json({ pages });
}
