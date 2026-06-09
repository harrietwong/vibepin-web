import { NextResponse } from "next/server";
import { importProductUrls, validateImportUrl } from "@/lib/productUrlImport";

const HARD_MAX_URLS = 20;

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const urls = (body as { urls?: unknown }).urls;
  if (!Array.isArray(urls) || urls.length === 0) {
    return NextResponse.json({ error: "urls array is required" }, { status: 400 });
  }

  if (urls.length > HARD_MAX_URLS) {
    return NextResponse.json({ error: `Maximum ${HARD_MAX_URLS} URLs per request` }, { status: 400 });
  }

  const stringUrls = urls.filter((u): u is string => typeof u === "string");
  const invalid = stringUrls.filter(u => !validateImportUrl(u).ok);
  if (invalid.length === stringUrls.length && stringUrls.length > 0) {
    const results = stringUrls.map(sourceUrl => {
      const v = validateImportUrl(sourceUrl);
      return {
        sourceUrl:    sourceUrl.trim(),
        sourceDomain: "",
        status:       "failed" as const,
        error:        v.ok ? "Invalid URL" : v.error,
      };
    });
    return NextResponse.json({ results });
  }

  const results = await importProductUrls(stringUrls);
  return NextResponse.json({ results });
}
