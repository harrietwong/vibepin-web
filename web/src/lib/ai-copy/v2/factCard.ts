/**
 * factCard.ts — Fact card construction, summary, and invariant enforcement.
 *
 * Rules:
 *  - Material, price, availability, efficacy, brand, and numeric commercial claims
 *    are copyable only when trust is verified or asserted.
 *  - Image-observed visual descriptions may be descriptive only.
 *  - AI-inferred facts cannot be asserted as product facts (blocked).
 */

import type {
  FactCardV1,
  FactItem,
  FactSource,
  FactTrustLevel,
  FactClaimPolicy,
  FactClaimPolarity,
  FactCategory,
  FactSummaryItem,
} from "./types";

export interface CreateFactInput {
  id: string;
  key: string;
  value: string;
  source: FactSource;
  trustLevel: FactTrustLevel;
  category?: FactCategory;
  claimPolicy?: FactClaimPolicy;
  canonicalClaim?: string;
  claimPolarity?: FactClaimPolarity;
}

const COMMERCIAL_CATEGORIES = new Set<FactCategory>([
  "material",
  "brand",
  "price",
  "availability",
  "efficacy",
  "numeric_commercial",
]);

/**
 * Derives the strict claim policy enforcing platform invariants:
 * - AI-inferred commercial/product facts cannot be copy_allowed (must be blocked).
 * - Observed facts cannot be commercial copy_allowed (default to descriptive_only).
 * - Verified/asserted facts allow commercial copying by default.
 */
export function deriveClaimPolicy(
  source: FactSource,
  trustLevel: FactTrustLevel,
  category?: FactCategory,
  requestedPolicy?: FactClaimPolicy,
  canonicalClaim?: string,
  claimPolarity?: FactClaimPolarity,
): FactClaimPolicy {
  const isCommercial = Boolean(category && COMMERCIAL_CATEGORIES.has(category));

  if (trustLevel === "inferred" || source === "ai_inferred") {
    if (isCommercial || requestedPolicy === "copy_allowed") {
      return "blocked";
    }
    return requestedPolicy ?? "blocked";
  }

  if (trustLevel === "observed" || source === "image_observed") {
    if (requestedPolicy === "blocked") {
      return "blocked";
    }
    return "descriptive_only";
  }

  // A trusted free-text value is not enough to prove a positive commercial
  // assertion. For example, "faux leather" contains "leather", and a
  // multilingual negative sentence may contain the prohibited material name.
  // Only an explicitly normalized, affirmed claim can be copied.
  if (isCommercial && (!canonicalClaim?.trim() || claimPolarity !== "affirmed")) {
    return "blocked";
  }

  return requestedPolicy ?? "copy_allowed";
}

export function createFact(input: CreateFactInput): FactItem {
  const claimPolicy = deriveClaimPolicy(
    input.source,
    input.trustLevel,
    input.category,
    input.claimPolicy,
    input.canonicalClaim,
    input.claimPolarity,
  );

  return {
    id: input.id,
    key: input.key,
    value: input.value,
    source: input.source,
    trustLevel: input.trustLevel,
    claimPolicy,
    ...(input.category ? { category: input.category } : {}),
    ...(input.canonicalClaim?.trim() ? { canonicalClaim: input.canonicalClaim.trim() } : {}),
    ...(input.claimPolarity ? { claimPolarity: input.claimPolarity } : {}),
  };
}

export function createFactCardV1(input: {
  sessionId: string;
  draftId: string;
  locale: string;
  facts: FactItem[];
  mediaEvidence?: FactCardV1["mediaEvidence"];
}): FactCardV1 {
  return {
    version: input.mediaEvidence ? "fact-card-v2" : "fact-card-v1",
    sessionId: input.sessionId,
    draftId: input.draftId,
    locale: input.locale,
    facts: input.facts.map(fact => createFact({ ...fact, claimPolicy: fact.claimPolicy })),
    ...(input.mediaEvidence ? { mediaEvidence: input.mediaEvidence } : {}),
  };
}

export function summarizeFacts(cardOrFacts: FactCardV1 | FactItem[]): FactSummaryItem[] {
  const facts = Array.isArray(cardOrFacts) ? cardOrFacts : cardOrFacts.facts;
  return facts.map(f => ({
    factId: f.id,
    key: f.key,
    value: f.value,
    trustLevel: f.trustLevel,
    source: f.source,
    ...(f.canonicalClaim ? { canonicalClaim: f.canonicalClaim } : {}),
    ...(f.claimPolarity ? { claimPolarity: f.claimPolarity } : {}),
  }));
}
