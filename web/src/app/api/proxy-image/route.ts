/**
 * GET /api/proxy-image?url=<encoded>
 *
 * Fetches a remote image (Pinterest CDN, etc.) server-side with browser-like headers
 * and returns it as a base64 data URL string.
 *
 * Used by the Studio to pre-fetch selected reference pin images as base64 so they
 * can be passed directly to the generation endpoint — bypassing the unreliable
 * server-side download in generator.py (Pinterest CDN often rejects bare httpx requests).
 *
 * Response: { dataUrl: "data:image/jpeg;base64,..." }
 */

import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

// Allowlist: only proxy images from known CDN hostnames
const ALLOWED_HOSTS = new Set([
  "i.pinimg.com",
  "i2.pinimg.com",
  "s.pinimg.com",
  "images.unsplash.com",
  "cdn.shopify.com",
  "storage.googleapis.com",
]);

export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get("url");
  if (!raw) {
    return NextResponse.json({ error: "Missing url param" }, { status: 400 });
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return NextResponse.json({ error: "Invalid url" }, { status: 400 });
  }

  if (!ALLOWED_HOSTS.has(parsed.hostname)) {
    return NextResponse.json({ error: `Host not allowed: ${parsed.hostname}` }, { status: 403 });
  }

  try {
    const resp = await fetch(raw, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Referer":  "https://www.pinterest.com/",
        "Accept":   "image/webp,image/apng,image/*,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (!resp.ok) {
      return NextResponse.json({ error: `Upstream ${resp.status}` }, { status: 502 });
    }

    const buf      = await resp.arrayBuffer();
    const mimeType = (resp.headers.get("content-type") ?? "image/jpeg").split(";")[0].trim();
    const b64      = Buffer.from(buf).toString("base64");

    return NextResponse.json({ dataUrl: `data:${mimeType};base64,${b64}` });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 });
  }
}
