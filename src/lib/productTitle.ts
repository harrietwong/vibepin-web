// Clean noisy product titles coming from scraped marketplace listings.
//
// Real-world titles are often attribute dumps or URL slugs, e.g.
//   "Category:Shoulder Bag;Embellishment:Rivet,Zipper;Material:PU"
//   "low-rise-flare-jeans-women"
//   "Chrome Almond Press On Nails | Etsy"
// We want short, human, Title-Case product names:
//   "Rivet Shoulder Bag", "Low Rise Flare Jeans", "Chrome Almond Press On Nails".

const STOP_VALUES = new Set([
  "yes", "no", "none", "other", "others", "na", "n/a", "default",
  "women", "womens", "woman", "men", "mens", "man", "unisex", "adult", "kids",
  "fashion", "casual", "daily", "all", "all season", "all-season",
  "spring", "summer", "fall", "autumn", "winter",
  "regular", "standard", "normal",
]);

const HEAD_KEYS  = /(category|type|item|product|name|style\s*name|title)/i;
const ADJ_KEYS   = /(material|fabric|colou?r|embellishment|detail|pattern|style|fit|sleeve|neckline|length|silhouette|design|feature)/i;

const STORE_TAIL = /\s*[|–—:-]\s*(etsy|amazon|aliexpress|shein|temu|ebay|walmart|target|shopify|wayfair|pinterest|[a-z0-9-]+\.(?:com|net|shop|store|co|io|us))\b.*$/i;

function titleCase(s: string): string {
  return s.replace(/\w[\w']*/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

function dedupeWords(s: string, maxWords: number): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w of s.split(/\s+/)) {
    const k = w.toLowerCase();
    if (!w || seen.has(k)) continue;
    seen.add(k);
    out.push(w);
    if (out.length >= maxWords) break;
  }
  return out.join(" ");
}

function looksLikeAttributeDump(t: string): boolean {
  // 2+ "key:value" pairs, usually separated by ; or |
  const segs = t.split(/[;|]+/).map(s => s.trim()).filter(Boolean);
  return segs.filter(s => /[:：]/.test(s)).length >= 2;
}

function fromAttributeDump(t: string): string | null {
  const segs = t.split(/[;|]+/).map(s => s.trim()).filter(Boolean);
  let head = "";
  const adjs: string[] = [];

  for (const seg of segs) {
    const idx = seg.search(/[:：]/);
    if (idx < 0) continue;
    const key = seg.slice(0, idx).trim().toLowerCase();
    let val = seg.slice(idx + 1).trim();
    val = (val.split(/[,，/]/)[0] ?? "").trim();           // first of multi-values
    if (!val) continue;
    if (STOP_VALUES.has(val.toLowerCase())) continue;
    if (val.length > 28) continue;                          // skip long descriptive blobs

    if (HEAD_KEYS.test(key) && !head) head = val;
    else if (ADJ_KEYS.test(key)) adjs.push(val);
  }

  if (!head) return null;
  const phrase = [...adjs.slice(0, 2), head].join(" ");
  return titleCase(dedupeWords(phrase, 6));
}

/**
 * Normalize a raw product title into a short, human, Title-Case name.
 * Safe to call on already-clean titles (they pass through largely unchanged).
 */
export function cleanProductTitle(raw: string | null | undefined): string {
  if (!raw || !raw.trim()) return "Product";
  let t = raw.trim();

  // 1. Attribute dumps → reconstruct a readable noun phrase.
  if (looksLikeAttributeDump(t)) {
    const fromAttrs = fromAttributeDump(t);
    if (fromAttrs) return fromAttrs;
  }

  // 2. Strip trailing store / domain fragments ("… | Etsy", "… - shop.com").
  t = t.replace(STORE_TAIL, "");

  // 3. Remove raw URLs.
  t = t.replace(/https?:\/\/\S+/gi, " ").replace(/www\.\S+/gi, " ");

  // 4. URL slug (no spaces, several hyphens/underscores) → spaced + Title Case.
  const wasSlug = !/\s/.test(t) && ((t.match(/[-_]/g)?.length ?? 0) >= 2);
  if (wasSlug) t = t.replace(/[-_]+/g, " ");

  // 5. Collapse leftover separators / excessive punctuation / whitespace.
  t = t
    .replace(/[_]+/g, " ")
    .replace(/\s*[;:|]+\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s,;:|.\-–—]+|[\s,;:|.\-–—]+$/g, "")
    .trim();

  // 6. Normalize casing for ALL-CAPS or slug-derived titles.
  if (t && (wasSlug || (t === t.toUpperCase() && /[A-Z]/.test(t)))) t = titleCase(t);

  // 7. Cap to a reasonable length.
  t = dedupeWords(t, 9);
  if (t.length > 70) t = t.slice(0, 70).replace(/\s+\S*$/, "").trim() + "…";

  return t || "Product";
}
