/**
 * GET /api/history-storage
 *
 * Lists generated image files from Supabase Storage using the service-role
 * key (server-side only — never exposed to the client).
 * Groups files into sessions by timestamp proximity and returns HistoryEntry[].
 */

import { NextResponse } from "next/server";

export const runtime     = "nodejs";
export const maxDuration = 15;

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SVC_KEY      = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const BUCKET       = "generated";
const PREFIX       = "studio/";
const SESSION_GAP  = 120; // seconds — files within this window = same session

export async function GET() {
  if (!SUPABASE_URL || !SVC_KEY) {
    return NextResponse.json({ entries: [] });
  }

  try {
    const resp = await fetch(`${SUPABASE_URL}/storage/v1/object/list/${BUCKET}`, {
      method: "POST",
      headers: {
        "apikey":        SVC_KEY,
        "Authorization": `Bearer ${SVC_KEY}`,
        "Content-Type":  "application/json",
      },
      body: JSON.stringify({
        prefix:  PREFIX,
        limit:   300,
        sortBy:  { column: "name", order: "desc" },
      }),
      signal: AbortSignal.timeout(8000),
    });

    if (!resp.ok) return NextResponse.json({ entries: [] });
    const files = (await resp.json()) as Array<{ name: string }>;

    // Parse timestamp from filename: [unix_seconds]_[idx]_[uuid].png
    // Use the /api/storage-image proxy so images load even if the bucket isn't set
    // to "Public" in Supabase — the proxy authenticates server-side with the SVC key.
    const parsed = files
      .filter(f => f.name.endsWith(".png"))
      .map(f => {
        const ts = parseInt(f.name.split("_")[0], 10);
        return {
          ts,
          url: `/api/storage-image?path=${PREFIX}${f.name}`,
        };
      })
      .filter(f => !isNaN(f.ts) && f.ts > 0)
      .sort((a, b) => b.ts - a.ts);

    // Group into sessions
    const sessions: Array<{ ts: number; urls: string[] }> = [];
    for (const f of parsed) {
      const hit = sessions.find(s => Math.abs(s.ts - f.ts) < SESSION_GAP);
      if (hit) { hit.urls.push(f.url); }
      else      { sessions.push({ ts: f.ts, urls: [f.url] }); }
    }

    const entries = sessions.map(s => ({
      id:           `storage_${s.ts}`,
      savedAt:      new Date(s.ts * 1000).toISOString(),
      keyword:      "",
      category:     "",
      source:       "storage",
      groups:       [{ refUrl: null, images: s.urls }],
      refCount:     1,
      productCount: 0,
      totalPins:    s.urls.length,
    }));

    return NextResponse.json({ entries });
  } catch {
    return NextResponse.json({ entries: [] });
  }
}
