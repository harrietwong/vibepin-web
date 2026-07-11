import type { CandidateReason, RawCandidate } from "./types";

const ICON_PATTERNS = /(?:icon|logo|avatar|sprite|pixel|tracking|badge|spinner|loader|placeholder|1x1|favicon)/i;
const MIN_DIMENSION = 400;

export function resolveUrl(raw: string, base: string): string | null {
  try {
    return new URL(raw, base).toString();
  } catch {
    return null;
  }
}

function parseDimension(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return parseInt(value, 10);
  return undefined;
}

function extractMeta(html: string, key: string, attr: "property" | "name"): string | null {
  const re1 = new RegExp(`<meta[^>]+${attr}=["']${key}["'][^>]+content=["']([^"']+)["']`, "i");
  const re2 = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+${attr}=["']${key}["']`, "i");
  return html.match(re1)?.[1] ?? html.match(re2)?.[1] ?? null;
}

function collectJsonLdProducts(html: string): { name?: string; description?: string; images: string[] }[] {
  const products: { name?: string; description?: string; images: string[] }[] = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;

  while ((match = re.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim()) as unknown;
      walkJsonLd(parsed, products);
    } catch {
      /* skip malformed JSON-LD */
    }
  }
  return products;
}

function walkJsonLd(node: unknown, out: { name?: string; description?: string; images: string[] }[]): void {
  if (!node) return;
  if (Array.isArray(node)) {
    node.forEach(item => walkJsonLd(item, out));
    return;
  }
  if (typeof node !== "object") return;

  const obj = node as Record<string, unknown>;
  if (obj["@graph"]) walkJsonLd(obj["@graph"], out);

  const typeVal = obj["@type"];
  const types = Array.isArray(typeVal) ? typeVal : typeVal ? [typeVal] : [];
  const isProduct = types.some(t => String(t).toLowerCase() === "product");

  if (isProduct) {
    const images = extractImageValues(obj.image);
    if (images.length) {
      out.push({
        name:        typeof obj.name === "string" ? obj.name : undefined,
        description: typeof obj.description === "string" ? obj.description : undefined,
        images,
      });
    }
  }

  for (const value of Object.values(obj)) {
    if (value && typeof value === "object") walkJsonLd(value, out);
  }
}

function extractImageValues(imageField: unknown): string[] {
  if (!imageField) return [];
  if (typeof imageField === "string") return [imageField];
  if (Array.isArray(imageField)) {
    return imageField.flatMap(item => extractImageValues(item));
  }
  if (typeof imageField === "object") {
    const obj = imageField as Record<string, unknown>;
    if (typeof obj.url === "string") return [obj.url];
    if (typeof obj.contentUrl === "string") return [obj.contentUrl];
  }
  return [];
}

function collectImgTags(html: string): { url: string; width?: number; height?: number }[] {
  const found: { url: string; width?: number; height?: number }[] = [];
  const imgRe = /<img[^>]+>/gi;
  let match: RegExpExecArray | null;

  while ((match = imgRe.exec(html)) !== null) {
    const tag = match[0];
    const src = tag.match(/\ssrc=["']([^"']+)["']/i)?.[1];
    const srcset = tag.match(/\ssrcset=["']([^"']+)["']/i)?.[1];
    const width = parseDimension(tag.match(/\swidth=["']?(\d+)["']?/i)?.[1]);
    const height = parseDimension(tag.match(/\sheight=["']?(\d+)["']?/i)?.[1]);

    if (src && !src.startsWith("data:")) {
      found.push({ url: src, width, height });
    }

    if (srcset) {
      for (const part of srcset.split(",")) {
        const piece = part.trim().split(/\s+/)[0];
        if (piece && !piece.startsWith("data:")) found.push({ url: piece, width, height });
      }
    }
  }
  return found;
}

function collectShopifyImages(html: string): string[] {
  const urls: string[] = [];
  const cdnRe = /https?:\/\/cdn\.shopify\.com\/[^\s"'<>]+?\.(?:jpe?g|png|webp)(?:\?[^\s"'<>]*)?/gi;
  let m: RegExpExecArray | null;
  while ((m = cdnRe.exec(html)) !== null) urls.push(m[0]);
  return urls;
}

function isUsableImage(url: string, width?: number, height?: number): boolean {
  if (ICON_PATTERNS.test(url)) return false;
  if (width != null && width > 0 && width < MIN_DIMENSION && height != null && height > 0 && height < MIN_DIMENSION) {
    return false;
  }
  if (width != null && width > 0 && width < 80 && (!height || height < 80)) return false;
  return /\.(jpe?g|png|webp)(\?|$)/i.test(url) || url.includes("cdn.shopify.com") || url.includes("etsystatic.com");
}

function aspectScore(width?: number, height?: number): number {
  if (!width || !height) return 0.05;
  const ratio = width / height;
  if (ratio >= 0.85 && ratio <= 1.15) return 0.12;
  if (height >= width) return 0.1;
  return 0.03;
}

function resolutionScore(width?: number, height?: number): number {
  const max = Math.max(width ?? 0, height ?? 0);
  if (max >= 1200) return 0.15;
  if (max >= 800) return 0.1;
  if (max >= MIN_DIMENSION) return 0.05;
  return 0;
}

export function finalizeCandidates(raw: RawCandidate[], pageUrl: string, max = 8): RawCandidate[] {
  const seen = new Set<string>();
  const resolved: RawCandidate[] = [];

  for (const item of raw) {
    const abs = resolveUrl(item.imageUrl, pageUrl);
    if (!abs || seen.has(abs)) continue;
    if (!isUsableImage(abs, item.width, item.height)) continue;
    seen.add(abs);
    resolved.push({
      ...item,
      imageUrl: abs,
      score: item.score + aspectScore(item.width, item.height) + resolutionScore(item.width, item.height),
    });
  }

  return resolved
    .sort((a, b) => b.score - a.score)
    .slice(0, max);
}

export function extractCandidatesFromHtml(html: string, pageUrl: string, hints?: { shopify?: boolean; etsy?: boolean }): {
  title?: string;
  description?: string;
  candidates: RawCandidate[];
} {
  const raw: RawCandidate[] = [];
  let title: string | undefined;
  let description: string | undefined;

  const jsonProducts = collectJsonLdProducts(html);
  for (const product of jsonProducts) {
    if (!title && product.name) title = product.name;
    if (!description && product.description) description = product.description;
    for (const img of product.images) {
      raw.push({ imageUrl: img, score: 0.92, reason: "jsonld_product_image" });
    }
  }

  const ogImage = extractMeta(html, "og:image", "property");
  const ogTitle = extractMeta(html, "og:title", "property");
  if (ogTitle && !title) title = ogTitle;
  if (ogImage) raw.push({ imageUrl: ogImage, score: 0.85, reason: "og_image" });

  const twImage = extractMeta(html, "twitter:image", "name");
  const twTitle = extractMeta(html, "twitter:title", "name");
  if (twTitle && !title) title = twTitle;
  if (twImage) raw.push({ imageUrl: twImage, score: 0.8, reason: "twitter_image" });

  const shopify = hints?.shopify ?? /cdn\.shopify\.com|\/products\//i.test(pageUrl);
  if (shopify) {
    for (const url of collectShopifyImages(html)) {
      raw.push({ imageUrl: url, score: 0.75, reason: "shopify_html_fallback" });
    }
  }

  const etsy = hints?.etsy ?? /etsy\.com/i.test(pageUrl);
  if (etsy) {
    for (const img of collectImgTags(html)) {
      if (/etsystatic\.com/i.test(img.url)) {
        raw.push({ imageUrl: img.url, width: img.width, height: img.height, score: 0.7, reason: "etsy_metadata_fallback" });
      }
    }
  }

  for (const img of collectImgTags(html)) {
    raw.push({ imageUrl: img.url, width: img.width, height: img.height, score: 0.5, reason: "html_img_fallback" });
  }

  return {
    title,
    description,
    candidates: finalizeCandidates(raw, pageUrl),
  };
}

export function candidateId(imageUrl: string, reason: CandidateReason, index: number): string {
  const slug = imageUrl.replace(/[^a-zA-Z0-9]+/g, "").slice(-24);
  return `${reason}-${index}-${slug || index}`;
}

export function toProductCandidates(raw: RawCandidate[]): import("./types").ProductImageCandidate[] {
  return raw.map((c, i) => ({
    id:       candidateId(c.imageUrl, c.reason, i),
    imageUrl: c.imageUrl,
    width:    c.width,
    height:   c.height,
    score:    c.score,
    reason:   c.reason,
  }));
}
