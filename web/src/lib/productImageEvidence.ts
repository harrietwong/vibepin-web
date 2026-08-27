/**
 * Product Opportunity images must be absolute merchant-hosted HTTP(S) assets.
 * Pinterest-hosted Pin media is evidence for the Pin, never a product image.
 */
export function isNonPinterestMerchantImageUrl(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    return Boolean(host)
      && host !== "pinimg.com"
      && !host.endsWith(".pinimg.com")
      && host !== "pinterest.com"
      && !host.endsWith(".pinterest.com");
  } catch {
    return false;
  }
}
