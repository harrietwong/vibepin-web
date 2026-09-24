/**
 * affiliateDisclosure.ts — the affiliate disclosure marker for AI Copy v2 (design §3.4).
 *
 * Pure and dependency-free so BOTH the server (orchestrator appends the marker before
 * validation) and the client (card warns when the user removed it, "Add #ad" button)
 * use one definition of "has a disclosure".
 *
 * Rulings (2026-09-24): the marker goes at the END of the description by default
 * (ruling 3); every content language gets the same short `#ad` marker (ruling 7);
 * removing it is warned about, never blocked (ruling 3).
 */

export type AffiliateDisclosureKind = "ad_hashtag" | "paid_link";

export const AFFILIATE_DISCLOSURE_TEXT: Readonly<Record<AffiliateDisclosureKind, string>> = {
  ad_hashtag: "#ad",
  paid_link: "(paid link)",
};

/** Studio's schedule/publish cap for descriptions; the disclosure counts toward it (design D7). */
export const AFFILIATE_DESCRIPTION_MAX = 500;

export function isAffiliateDisclosureKind(value: unknown): value is AffiliateDisclosureKind {
  return value === "ad_hashtag" || value === "paid_link";
}

// `#ad` / `#affiliate` as whole hashtags (not `#adorable`), or "(paid link)". Case-insensitive.
const DISCLOSURE_RE = /(?:^|[^\p{L}\p{N}_#])#(?:ad|affiliate)(?![\p{L}\p{N}_])|\(paid link\)/iu;

/** True when the text already carries an affiliate disclosure marker. */
export function hasAffiliateDisclosure(text: string | null | undefined): boolean {
  return DISCLOSURE_RE.test(text ?? "");
}

/**
 * Append the marker at the end (separated by one space). Idempotent: text that already
 * discloses is returned unchanged. Never truncates — over-length is the validator's
 * job (DESCRIPTION_TOO_LONG → repair), not a silent cut.
 */
export function appendAffiliateDisclosure(text: string, kind: AffiliateDisclosureKind = "ad_hashtag"): string {
  if (hasAffiliateDisclosure(text)) return text;
  const marker = AFFILIATE_DISCLOSURE_TEXT[kind];
  const body = text.trimEnd();
  return body ? `${body} ${marker}` : marker;
}

/** Characters left for the model's own description once the marker (and its space) is added. */
export function affiliateDescriptionBudget(kind: AffiliateDisclosureKind): number {
  return AFFILIATE_DESCRIPTION_MAX - (AFFILIATE_DISCLOSURE_TEXT[kind].length + 1);
}
