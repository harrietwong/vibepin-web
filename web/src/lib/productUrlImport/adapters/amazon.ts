/**
 * Amazon product page → text fields (design §2.2). Pure: no network, no images.
 *
 * Field positions calibrated on real pages saved as fixtures in
 * scripts/fixtures/amazon/ (captured 2026-09-24):
 *   - title   `<span id="productTitle">`  → `<meta name="title">` → `<title>`
 *   - bullets `#feature-bullets` first `<ul>` → `span.a-list-item` (≤6, ≤200 chars)
 *   - brand   `<a id="bylineInfo">` only when it reads "Visit the X Store" or
 *             "Brand: X". Book bylines ("by <author> (Author)") are NOT a brand.
 * Never extracted: price, availability, rating, review counts, images (design §3.2).
 *
 * Bot check runs first: Amazon answers automated traffic with HTTP 200 and a
 * "Continue shopping" / validateCaptcha page, so 200 is not success.
 */

export const AMAZON_BOT_PAGE_MAX_BYTES = 20 * 1024;
export const AMAZON_MAX_BULLETS = 6;
export const AMAZON_MAX_BULLET_CHARS = 200;
export const AMAZON_MAX_TITLE_CHARS = 300;

export type AmazonBotCheckVerdict = { blocked: boolean; signals: string[] };

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", ndash: "–", mdash: "—",
  rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", hellip: "…", reg: "®", trade: "™", copy: "©",
};

export function decodeHtmlText(raw: string): string {
  return raw
    .replace(/<[^>]*>/g, " ")
    .replace(/&#(\d+);/g, (_, n: string) => safeCodePoint(Number(n)))
    .replace(/&#x([\da-f]+);/gi, (_, n: string) => safeCodePoint(Number.parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? m)
    .replace(/[\s ]+/g, " ")
    .trim();
}

function safeCodePoint(n: number): string {
  return Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
}

function pageTitle(html: string): string | null {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decodeHtmlText(m[1]) : null;
}

/**
 * Blocked when ANY TWO signals are present (design §2.2.1):
 * validateCaptcha form, bare "Amazon.com" title, no #productTitle, body < 20 KB.
 */
export function detectAmazonBotCheck(html: string): AmazonBotCheckVerdict {
  const signals: string[] = [];
  if (/\/errors\/validateCaptcha|validateCaptcha/i.test(html)) signals.push("captcha_form");
  const title = pageTitle(html);
  if (title !== null && /^amazon\.[a-z.]+$/i.test(title)) signals.push("bare_title");
  if (!/id=["']productTitle["']/i.test(html)) signals.push("no_product_title");
  if (Buffer.byteLength(html, "utf8") < AMAZON_BOT_PAGE_MAX_BYTES) signals.push("small_body");
  return { blocked: signals.length >= 2, signals };
}

/** Strip Amazon's own framing from a meta/`<title>` value. */
export function cleanAmazonTitle(raw: string): string {
  let t = raw.trim();
  t = t.replace(/^amazon\.[a-z.]+\s*:\s*/i, "");               // "Amazon.com: X"
  t = t.replace(/\s*:\s*amazon\.[a-z.]+\s*:\s*[^:]+$/i, "");     // "X: Amazon.com: Books"
  t = t.replace(/\s+:\s+[^:]{1,60}$/, "");                       // "X : Electronics"
  return t.trim();
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

export function extractAmazonTitle(html: string): string | null {
  const span = html.match(/<span[^>]*id=["']productTitle["'][^>]*>([\s\S]*?)<\/span>/i);
  const fromSpan = span ? decodeHtmlText(span[1]) : "";
  if (fromSpan) return clip(fromSpan, AMAZON_MAX_TITLE_CHARS);

  const meta = html.match(/<meta[^>]+name=["']title["'][^>]*content=["']([^"']*)["']/i);
  const fromMeta = meta ? cleanAmazonTitle(decodeHtmlText(meta[1])) : "";
  if (fromMeta) return clip(fromMeta, AMAZON_MAX_TITLE_CHARS);

  const fromTitle = cleanAmazonTitle(pageTitle(html) ?? "");
  if (fromTitle && !/^amazon\.[a-z.]+$/i.test(fromTitle)) return clip(fromTitle, AMAZON_MAX_TITLE_CHARS);
  return null;
}

export function extractAmazonBullets(html: string): string[] {
  const start = html.search(/id=["']feature-bullets["']/i);
  if (start < 0) return [];
  const end = html.indexOf("</ul>", start);
  if (end < 0) return [];
  const block = html.slice(start, end);
  const out: string[] = [];
  const re = /<span[^>]*class=["'][^"']*\ba-list-item\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/gi;
  for (const m of block.matchAll(re)) {
    const text = decodeHtmlText(m[1]);
    if (!text) continue;
    out.push(clip(text, AMAZON_MAX_BULLET_CHARS));
    if (out.length >= AMAZON_MAX_BULLETS) break;
  }
  return out;
}

/** Only the two unambiguous product-brand byline forms; anything else → null. */
export function extractAmazonBrand(html: string): string | null {
  const m = html.match(/<a[^>]*id=["']bylineInfo["'][^>]*>([\s\S]*?)<\/a>/i);
  if (!m) return null;
  const text = decodeHtmlText(m[1]);
  const visit = text.match(/^Visit the (.+?) Store$/i);
  if (visit) return visit[1].trim() || null;
  const brand = text.match(/^Brand:\s*(.+)$/i);
  if (brand) return brand[1].trim() || null;
  return null;
}

export type AmazonAdapterResult =
  | { status: "blocked"; reason: "bot_check"; signals: string[] }
  | { status: "failed"; reason: "no_product_fields" }
  | { status: "success" | "partial"; title?: string; bullets: string[]; brand?: string };

/** success = has a title; partial = bullets but no title (design §2.2.3). */
export function amazonAdapter(html: string): AmazonAdapterResult {
  const bot = detectAmazonBotCheck(html);
  if (bot.blocked) return { status: "blocked", reason: "bot_check", signals: bot.signals };

  const title = extractAmazonTitle(html) ?? undefined;
  const bullets = extractAmazonBullets(html);
  const brand = extractAmazonBrand(html) ?? undefined;
  if (!title && bullets.length === 0) return { status: "failed", reason: "no_product_fields" };
  return { status: title ? "success" : "partial", title, bullets, brand };
}
