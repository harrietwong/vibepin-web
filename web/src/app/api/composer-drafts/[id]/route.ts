/**
 * GET  /api/composer-drafts/[id]   — Fetch a draft by ID (Studio hydration)
 * PATCH /api/composer-drafts/[id]  — Update draft_snapshot or status
 */

import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// Lazy: a clean `next build` collects page data without Supabase env vars.
let _adminDb: ReturnType<typeof createServerClient> | null = null;
const adminDb = () => (_adminDb ??= createServerClient());

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

async function resolveReferences(referenceIds: string[] | null) {
  if (!referenceIds || referenceIds.length === 0) return [];
  const { data } = await adminDb()
    .from("pin_samples")
    .select("id,image_url,save_count,seed_keyword,category,visual_format")
    .in("id", referenceIds)
    .limit(20);
  return data ?? [];
}

async function resolveProducts(productIds: string[] | null) {
  if (!productIds || productIds.length === 0) return [];
  const { data } = await adminDb()
    .from("pin_products")
    .select("id,product_name,domain,image_url,source_url,product_type")
    .in("id", productIds)
    .limit(20);
  return data ?? [];
}

async function resolveOpportunity(opportunityId: string | null) {
  if (!opportunityId) return null;
  const { data } = await adminDb()
    .from("opportunities")
    .select("id,title,canonical_keyword,category,primary_label,trend_state,evidence_sentence,score")
    .eq("id", opportunityId)
    .single();
  return data ?? null;
}

// ── GET ───────────────────────────────────────────────────────────────────────

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = await getUserId(req);
  if (!userId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: draftId } = await params;

  const { data: draft, error } = await adminDb()
    .from("composer_drafts")
    .select("*")
    .eq("id", draftId)
    .eq("user_id", userId)
    .single();

  if (error || !draft) {
    return Response.json({ error: "Draft not found" }, { status: 404 });
  }

  const [opportunity, references, products] = await Promise.all([
    resolveOpportunity(draft.opportunity_id as string | null),
    resolveReferences(draft.selected_reference_ids as string[] | null),
    resolveProducts(draft.selected_product_ids as string[] | null),
  ]);

  return Response.json({
    draft: {
      ...draft,
      resolved_opportunity: opportunity,
      resolved_references:  references,
      resolved_products:    products,
    },
  });
}

// ── PATCH ─────────────────────────────────────────────────────────────────────

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = await getUserId(req);
  if (!userId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  let body: Record<string, unknown>;
  try { body = await req.json(); }
  catch { return Response.json({ error: "Invalid JSON body" }, { status: 400 }); }

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.draft_snapshot && typeof body.draft_snapshot === "object") updates.draft_snapshot = body.draft_snapshot;
  if (typeof body.status === "string" && ["active","consumed","abandoned"].includes(body.status)) updates.status = body.status;

  if (Object.keys(updates).length === 1) {
    return Response.json({ error: "No valid fields to update" }, { status: 400 });
  }

  const { data: existing } = await adminDb()
    .from("composer_drafts")
    .select("id")
    .eq("id", id)
    .eq("user_id", userId)
    .single();

  if (!existing) return Response.json({ error: "Draft not found" }, { status: 404 });

  const { data, error } = await adminDb()
    .from("composer_drafts")
    .update(updates)
    .eq("id", id)
    .select("id,status,updated_at")
    .single();

  if (error) {
    console.error("[composer-drafts PATCH]", error.message);
    return Response.json({ error: "Failed to update draft" }, { status: 500 });
  }
  return Response.json({ draft: data });
}
