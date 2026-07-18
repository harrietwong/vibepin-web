/**
 * POST /api/publish — Write to publishing_queue table
 * GET  /api/publish — Read upcoming queue items
 *
 * The backend/publisher.py worker reads this table and auto-posts to Pinterest.
 *
 * Request body (POST):
 *   {
 *     image_urls: string[],      // generated image URLs from /api/generate
 *     product_url: string,       // merchant store / product link
 *     board_name?: string,       // Pinterest board name (matched to board_id by publisher.py)
 *     caption?: string,          // pin description / Instagram caption
 *     keyword?: string,          // originating trend keyword (for analytics)
 *     scheduled_at?: string,     // ISO timestamp; defaults to now
 *   }
 *
 * Response (POST):
 *   { ok: boolean, queued: number, items: QueueItem[] }
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

// Use service role key server-side to bypass RLS on publishing_queue.
// Lazy: a clean `next build` collects page data without Supabase env vars.
const mkClient = () =>
  createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
let _supabase: ReturnType<typeof mkClient> | null = null;
const supabase = () => (_supabase ??= mkClient());

// ── POST — enqueue images for Pinterest publishing ────────────────────────────
export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const imageUrls  = Array.isArray(body.image_urls) ? (body.image_urls as string[]) : [];
  const productUrl = String(body.product_url ?? "").trim();
  const boardName  = String(body.board_name  ?? "VibePin Auto-Queue");
  const caption    = String(body.caption     ?? "");
  const keyword    = body.keyword ? String(body.keyword) : null;
  const scheduledAt = body.scheduled_at
    ? new Date(String(body.scheduled_at)).toISOString()
    : new Date().toISOString();

  if (!imageUrls.length) {
    return NextResponse.json({ error: "image_urls must be a non-empty array" }, { status: 400 });
  }
  if (!productUrl) {
    return NextResponse.json({ error: "product_url is required" }, { status: 400 });
  }

  // One row per image URL — publisher.py processes them as individual Pinterest pins
  const rows = imageUrls.map((url: string, i: number) => ({
    image_url:    url,
    product_url:  productUrl,
    board_name:   boardName,
    caption:      caption,
    keyword:      keyword,
    // Stagger by 15 min if multiple images
    scheduled_at: new Date(
      new Date(scheduledAt).getTime() + i * 15 * 60 * 1000
    ).toISOString(),
    status:       "pending",
    created_at:   new Date().toISOString(),
    retry_count:  0,
  }));

  const { data, error } = await supabase()
    .from("publishing_queue")
    .insert(rows)
    .select("id, image_url, board_name, scheduled_at, status");

  if (error) {
    // If table doesn't exist yet, return helpful message
    if (error.code === "42P01") {
      return NextResponse.json(
        {
          error: "publishing_queue table not found. Run the schema SQL from the docs.",
          sql_hint: CREATE_TABLE_SQL,
        },
        { status: 500 }
      );
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, queued: data?.length ?? 0, items: data });
}

// ── GET — fetch upcoming queue ────────────────────────────────────────────────
export async function GET() {
  const { data, error } = await supabase()
    .from("publishing_queue")
    .select("id, image_url, product_url, board_name, caption, keyword, scheduled_at, status, error_message")
    .order("scheduled_at", { ascending: true })
    .limit(50);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ items: data ?? [] });
}

// ── PATCH — manually mark an item as published ────────────────────────────────
export async function PATCH(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const id = typeof body.id === "string" ? body.id.trim() : null;
  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  const { error } = await supabase()
    .from("publishing_queue")
    .update({ status: "done", published_at: new Date().toISOString() })
    .eq("id", id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}

// ── Schema hint (shown if table missing) ─────────────────────────────────────
const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS publishing_queue (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  image_url      TEXT NOT NULL,
  product_url    TEXT NOT NULL,
  board_name     TEXT NOT NULL DEFAULT 'VibePin Auto-Queue',
  caption        TEXT DEFAULT '',
  keyword        TEXT,
  scheduled_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status         TEXT NOT NULL DEFAULT 'pending',  -- pending | processing | done | failed
  error_message  TEXT,
  pin_id         TEXT,          -- filled by publisher.py after success
  retry_count    INT DEFAULT 0,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  published_at   TIMESTAMPTZ
);

-- Allow anon reads for the Studio queue display
ALTER TABLE publishing_queue ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_read_queue" ON publishing_queue FOR SELECT TO anon, authenticated USING (true);
-- Only service role can write (Next.js API uses service key)
`.trim();
