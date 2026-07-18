/**
 * POST /api/composer-drafts
 *
 * Called by source pages (Workspace / Trends / Discover / Products) immediately
 * before navigating to Studio.  Persists the full Studio prefill context in the
 * `composer_drafts` table so Studio can always recover it — even after a page
 * refresh, a tab switch, or a slow network.
 *
 * Replaces the sessionStorage-only pattern where the prefill was lost on reload.
 *
 * POST body (ComposerDraftInput):
 *   {
 *     source_page             : string               // 'workspace'|'trends'|'discover'|'products'|'plan'
 *     source_context?         : object               // raw WorkspaceFeedItem / TrendOpportunity / etc.
 *     opportunity_id?         : string               // uuid of opportunities row (may be null for product-only flows)
 *     selected_reference_ids? : string[]             // pin_samples uuids
 *     selected_product_ids?   : string[]             // pin_products uuids
 *     draft_snapshot?         : object               // full Studio state (optional at creation time)
 *   }
 *
 * Response:
 *   { draft_id: string }
 *
 * The caller navigates to:
 *   /app/studio?draft_id=<draft_id>
 *
 * GET /api/composer-drafts
 *   List the most recent active drafts for the authenticated user.
 *   Query params: ?limit=10 (default 10, max 50)
 */

import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// Service-role client for server-side writes (bypasses RLS on insert).
// Lazy: a clean `next build` collects page data without Supabase env vars.
let _adminDb: ReturnType<typeof createServerClient> | null = null;
const adminDb = () => (_adminDb ??= createServerClient());

// ── Auth helper ───────────────────────────────────────────────────────────────

async function getUserId(req: Request): Promise<string | null> {
  const auth  = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : null;
  if (!token) return null;

  const anonClient = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
  const { data: { user }, error } = await anonClient.auth.getUser(token);
  if (error || !user) return null;
  return user.id;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type ComposerDraftStatus = "active" | "consumed" | "abandoned";

export type ComposerDraft = {
  id:                     string;
  user_id:                string;
  source_page:            string | null;
  source_context:         Record<string, unknown> | null;
  opportunity_id:         string | null;
  selected_reference_ids: string[] | null;
  selected_product_ids:   string[] | null;
  draft_snapshot:         Record<string, unknown> | null;
  status:                 ComposerDraftStatus;
  created_at:             string;
  updated_at:             string;
};

// ── POST — create a draft ────────────────────────────────────────────────────

export async function POST(req: Request) {
  const userId = await getUserId(req);
  if (!userId) {
    return Response.json(
      { error: "Unauthorized — include Authorization: Bearer <token>" },
      { status: 401 },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const sourcePage = typeof body.source_page === "string" ? body.source_page.trim() : null;
  if (!sourcePage) {
    return Response.json({ error: "source_page is required" }, { status: 400 });
  }

  const sourceContext = body.source_context && typeof body.source_context === "object"
    ? body.source_context as Record<string, unknown>
    : null;

  const opportunityId = typeof body.opportunity_id === "string" && body.opportunity_id.trim()
    ? body.opportunity_id.trim()
    : null;

  const selectedReferenceIds = Array.isArray(body.selected_reference_ids)
    ? (body.selected_reference_ids as unknown[]).filter((x): x is string => typeof x === "string")
    : null;

  const selectedProductIds = Array.isArray(body.selected_product_ids)
    ? (body.selected_product_ids as unknown[]).filter((x): x is string => typeof x === "string")
    : null;

  const draftSnapshot = body.draft_snapshot && typeof body.draft_snapshot === "object"
    ? body.draft_snapshot as Record<string, unknown>
    : null;

  const { data, error } = await adminDb()
    .from("composer_drafts")
    .insert({
      user_id:                userId,
      source_page:            sourcePage,
      source_context:         sourceContext,
      opportunity_id:         opportunityId,
      selected_reference_ids: selectedReferenceIds,
      selected_product_ids:   selectedProductIds,
      draft_snapshot:         draftSnapshot,
      status:                 "active" satisfies ComposerDraftStatus,
    })
    .select("id")
    .single();

  if (error) {
    console.error("[composer-drafts POST] insert error:", error.message);
    return Response.json({ error: "Failed to create draft" }, { status: 500 });
  }

  return Response.json({ draft_id: data.id }, { status: 201 });
}

// ── GET — list recent active drafts ─────────────────────────────────────────

export async function GET(req: Request) {
  const userId = await getUserId(req);
  if (!userId) {
    return Response.json(
      { error: "Unauthorized — include Authorization: Bearer <token>" },
      { status: 401 },
    );
  }

  const url   = new URL(req.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "10", 10), 50);

  const { data, error } = await adminDb()
    .from("composer_drafts")
    .select("id,source_page,opportunity_id,status,created_at,updated_at")
    .eq("user_id", userId)
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    console.error("[composer-drafts GET] select error:", error.message);
    return Response.json({ error: "Failed to list drafts" }, { status: 500 });
  }

  return Response.json({ data: data ?? [] });
}
