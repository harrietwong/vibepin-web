import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { NextResponse } from "next/server";
import { getUserIdFromBearerOrCookies } from "@/lib/server/authUser";
import { guardedDnsLookup, safeOutboundUrl, UnsafeOutboundUrlError } from "./safeOutboundUrl";

const MAX_REDIRECTS = 3;
const MAX_RESPONSE_BYTES = 256 * 1024;

export const runtime = "nodejs";

function getHeader(headers: IncomingHttpHeaders, name: string): string | null {
  const value = headers[name];
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

async function requestUrl(url: URL): Promise<IncomingMessage> {
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const outgoingRequest = request(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; VibePin/1.0)" },
      lookup: guardedDnsLookup,
      signal: AbortSignal.timeout(8000),
    }, resolve);
    outgoingRequest.on("error", reject);
  });
}

async function fetchWithSafeRedirects(initialUrl: string) {
  let currentUrl = await safeOutboundUrl(initialUrl);

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const response = await requestUrl(currentUrl);
    const status = response.statusCode ?? 502;

    if (![301, 302, 303, 307, 308].includes(status)) return response;

    const location = getHeader(response.headers, "location");
    if (!location || redirectCount === MAX_REDIRECTS) {
      response.destroy();
      throw new Error("Redirect limit reached");
    }

    response.destroy();
    currentUrl = await safeOutboundUrl(new URL(location, currentUrl).toString());
  }

  throw new Error("Redirect limit reached");
}

async function readLimitedText(
  response: IncomingMessage,
): Promise<string> {
  const contentLength = getHeader(response.headers, "content-length");
  if (contentLength && Number(contentLength) > MAX_RESPONSE_BYTES) {
    response.destroy();
    throw new Error("Response body too large");
  }

  const decoder = new TextDecoder();
  let bytesRead = 0;
  let result = "";

  for await (const chunk of response) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    bytesRead += bytes.byteLength;
    if (bytesRead > MAX_RESPONSE_BYTES) {
      response.destroy();
      throw new Error("Response body too large");
    }
    result += decoder.decode(bytes, { stream: true });
  }

  return result + decoder.decode();
}

export async function GET(request: Request) {
  const userId = await getUserIdFromBearerOrCookies(request).catch(() => null);
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const url = searchParams.get("url");
  if (!url) return NextResponse.json({ error: "url required" }, { status: 400 });

  try {
    const resp = await fetchWithSafeRedirects(url);
    const status = resp.statusCode ?? 502;
    if (status < 200 || status >= 300) {
      resp.destroy();
      throw new Error("Upstream request failed");
    }
    const html = await readLimitedText(resp);

    // Extract og:image or twitter:image
    const ogMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
      ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
    const twMatch = html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i)
      ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i);

    const image = ogMatch?.[1] ?? twMatch?.[1] ?? null;
    return NextResponse.json({ image });
  } catch (error) {
    if (error instanceof UnsafeOutboundUrlError) {
      return NextResponse.json({ error: "URL is not allowed" }, { status: 400 });
    }
    return NextResponse.json({ error: "Unable to fetch URL" }, { status: 502 });
  }
}
