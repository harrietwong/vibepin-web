// GET /api/keyword-tool/related?keyword=cozy+bedroom+decor&region=US&limit=20
// Thin wrapper — delegates to /api/keyword-trends for real cloud data.

import { NextRequest, NextResponse } from "next/server";

export const revalidate = 300;

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const keyword = searchParams.get("keyword")?.trim() ?? "";
  const region  = searchParams.get("region") ?? "US";
  const limit   = searchParams.get("limit") ?? "20";
  const category = searchParams.get("category");

  const p = new URLSearchParams({ region, limit });
  if (keyword) p.set("q", keyword);
  if (category) p.set("category", category);

  const origin = new URL(req.url).origin;
  const res = await fetch(`${origin}/api/keyword-trends?${p}`, { next: { revalidate: 300 } });
  const data = await res.json();

  if (!res.ok) {
    return NextResponse.json({ error: data.error ?? "Related fetch failed" }, { status: res.status });
  }

  return NextResponse.json({ rows: data.rows ?? [], region, meta: data.meta });
}
