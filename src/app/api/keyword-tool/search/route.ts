// GET /api/keyword-tool/search?keyword=cozy+bedroom+decor&region=US
// Thin wrapper — delegates to /api/keyword-trends for real cloud data.

import { NextRequest, NextResponse } from "next/server";

export const revalidate = 300;

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const keyword = searchParams.get("keyword")?.trim();
  const region  = searchParams.get("region") ?? "US";

  if (!keyword) {
    return NextResponse.json({ error: "keyword is required" }, { status: 400 });
  }

  const p = new URLSearchParams({ q: keyword, region, limit: "1" });
  const origin = new URL(req.url).origin;
  const res = await fetch(`${origin}/api/keyword-trends?${p}`, { next: { revalidate: 300 } });
  const data = await res.json();

  if (!res.ok) {
    return NextResponse.json({ error: data.error ?? "Search failed" }, { status: res.status });
  }

  const summary = data.summary ?? null;
  return NextResponse.json({
    summary,
    matchedKeyword: summary?.matchedKeyword ?? summary?.keyword,
    isExactMatch:   summary?.isExactMatch,
    message:        data.message,
  });
}
