/** Grounded single-result generation with one optional repair. */
import { chatJson, providerConfig, CopyError, PROVIDER_MESSAGE, languageInstructions, type ChatCostContext } from "@/lib/ai-copy/visionServer";
import { containsTokenPhrase, DEFAULT_DESCRIPTION_MAX, validateCopy } from "./validateCopy";
import { summarizeFacts } from "./factCard";
import type { ClaimDetectionResult, CopyResultV2, DetectedClaim, DetectedClaimType, FactCardV1, KeywordEvidence, ValidationReport } from "./types";
import {
  AFFILIATE_DESCRIPTION_MAX,
  affiliateDescriptionBudget,
  appendAffiliateDisclosure,
  type AffiliateDisclosureKind,
} from "@/lib/ai-copy/affiliateDisclosure";

export { AI_COPY_V2_PROMPT_VERSION } from "@/lib/ai-copy/promptVersions";
export function getAI_COPY_V2ModelVersion(): string {
  const cfg = providerConfig();
  return `${cfg.provider}:${cfg.textModel}`;
}

export interface ProviderCopyOutput {
  title: string;
  description: string;
  altText: string;
}

export interface GenerateCopyRequest {
  generationId: string;
  sessionId: string;
  draftId: string;
  factCard: FactCardV1;
  keywordEvidence: KeywordEvidence;
  angleId?: string;
  angleRequest?: string;
  lengthPreference?: "short" | "standard" | "seo-rich";
  costContext?: ChatCostContext;
  /**
   * Affiliate (Amazon) copy: the server appends this disclosure marker to the
   * description BEFORE validation, and the description cap becomes 500 including it
   * (design §3.4). Absent → no disclosure is appended; the description cap is the shared
   * default (500, P1 0925) and prompt / repair / detector wording is the same as for
   * affiliate copy apart from the Amazon line and the disclosure budget.
   */
  affiliateDisclosure?: AffiliateDisclosureKind;
}

export interface CopyGenerationProvider {
  generate(prompt: string, systemPrompt?: string, costContext?: ChatCostContext): Promise<ProviderCopyOutput>;
  detectClaims(output: ProviderCopyOutput, grounding: FactCardV1, costContext?: ChatCostContext): Promise<unknown>;
  repair?(original: ProviderCopyOutput, report: ValidationReport, prompt: string, costContext?: ChatCostContext): Promise<ProviderCopyOutput>;
}

const CLAIM_TYPES = new Set<DetectedClaimType>([
  "material", "brand", "price", "availability", "efficacy", "numeric_commercial",
  "video_motion", "video_audio", "video_temporal",
]);

function parseProviderOutput(raw: unknown): ProviderCopyOutput {
  if (!raw || typeof raw !== "object") throw new CopyError("provider_invalid_schema", 502, PROVIDER_MESSAGE);
  const value = raw as Record<string, unknown>;
  if (typeof value.title !== "string" || typeof value.description !== "string" || typeof value.altText !== "string") {
    throw new CopyError("provider_invalid_schema", 502, PROVIDER_MESSAGE);
  }
  return { title: value.title.trim(), description: value.description.trim(), altText: value.altText.trim() };
}

function parseClaimDetection(raw: unknown): ClaimDetectionResult {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as Record<string, unknown>).claims)) {
    return { status: "incomplete", claims: [] };
  }
  const claims: DetectedClaim[] = [];
  for (const item of (raw as { claims: unknown[] }).claims) {
    if (!item || typeof item !== "object") return { status: "incomplete", claims: [] };
    const claim = item as Record<string, unknown>;
    if (!CLAIM_TYPES.has(claim.type as DetectedClaimType) || typeof claim.value !== "string" || !claim.value.trim()) {
      return { status: "incomplete", claims: [] };
    }
    if (claim.field != null && !["title", "description", "altText"].includes(String(claim.field))) {
      return { status: "incomplete", claims: [] };
    }
    claims.push({
      type: claim.type as DetectedClaimType,
      value: claim.value.trim(),
      ...(claim.field ? { field: claim.field as DetectedClaim["field"] } : {}),
    });
  }
  return { status: "completed", claims };
}

const SYSTEM = "You write grounded Pinterest copy. Return one JSON object only with title, description, and altText. Never invent facts.";
/**
 * Claim detector prompt. Still grounding-blind (it never sees the facts); the
 * deterministic validator decides support. P1 0925: the type definitions are aligned
 * with what validateCopy.ts actually checks — without them the detector labelled
 * colours / shapes / scene objects as "material", ordinary product capabilities as
 * "efficacy", and the affiliate prompt's own "Find it on Amazon" as "availability",
 * all unrepairable 422s that no rule in the validator defines.
 */
export const DETECTOR_SYSTEM = [
  "Independently extract every commercial claim and every video-cover-unsupported inference from the supplied copy.",
  "Return JSON {\"claims\": [...]} only. Each claim has type, value, and field (title, description, or altText). value must be copied exactly as written in the copy (a verbatim substring, not a summary or rewording).",
  "Types:",
  "material: the substance the product itself is made of (for example leather, silk, stainless steel, ceramic, wool). Colors, finishes seen in a photo, shapes, sizes, parts or features, and objects in the scene or background are not material claims.",
  "brand: a brand, trademark, or product-line name.",
  "price: a price, discount, sale, deal, or free-shipping claim.",
  "availability: stock, inventory, shipping, or delivery status (for example in stock, ships today, limited stock). A where-to-buy phrase such as \"Find it on Amazon\" is not an availability claim, and the store named in it is not a brand claim.",
  "efficacy: a health, therapeutic, medical, or guaranteed-result claim (for example relieves pain, clinically proven, improves sleep, guaranteed results). Ordinary product features, capabilities, and uses (plays music, controls smart home devices, keeps drinks cold) are not efficacy claims.",
  "numeric_commercial: a quantity, pack count, size, capacity, measurement, coverage, or numbered warranty or guarantee.",
  "video_motion: actions or motion; video_audio: audio, singing, speech, or music; video_temporal: duration, sequence, or before/after claims.",
  "Use [] only when none exists. Do not trust or use any claims self-reported by the copy generator.",
].join("\n");

export class DefaultCopyGenerationProvider implements CopyGenerationProvider {
  async generate(prompt: string, systemPrompt = SYSTEM, costContext?: ChatCostContext): Promise<ProviderCopyOutput> {
    const cfg = providerConfig();
    if (!cfg.key) throw new CopyError("provider_not_configured", 502, PROVIDER_MESSAGE);
    try {
      return parseProviderOutput(await chatJson({
        key: cfg.key, baseUrl: cfg.baseUrl, model: cfg.textModel, provider: cfg.provider,
        costContext,
        messages: [{ role: "system", content: systemPrompt }, { role: "user", content: prompt }],
        timeoutMs: 15_000, temperature: 0.5,
      }));
    } catch (error) {
      if (error instanceof CopyError) throw error;
      throw new CopyError("provider_failed", 502, PROVIDER_MESSAGE);
    }
  }

  async detectClaims(output: ProviderCopyOutput, _grounding: FactCardV1, costContext?: ChatCostContext): Promise<unknown> {
    const cfg = providerConfig();
    if (!cfg.key) throw new CopyError("provider_not_configured", 502, PROVIDER_MESSAGE);
    return chatJson({
      key: cfg.key, baseUrl: cfg.baseUrl, model: cfg.textModel, provider: cfg.provider,
      costContext,
      messages: [
        { role: "system", content: DETECTOR_SYSTEM },
        // Claim extraction is intentionally blind to grounding. Its only job is
        // to enumerate claims; the deterministic validator decides support.
        { role: "user", content: JSON.stringify({ copy: output }) },
      ],
      timeoutMs: 15_000, temperature: 0,
    });
  }

  async repair(original: ProviderCopyOutput, report: ValidationReport, prompt: string, costContext?: ChatCostContext): Promise<ProviderCopyOutput> {
    const issues = report.issues.map(issue => issue.code === "DESCRIPTION_TOO_LONG" ? `${issue.field}:${issue.code} (${issue.message})` : `${issue.field}:${issue.code}`).join(", ");
    return this.generate(`${prompt}\n\nRepair these validation issues: ${issues}.\nPrevious JSON: ${JSON.stringify(original)}\nReturn the complete JSON schema again.`, SYSTEM, costContext);
  }
}

let override: CopyGenerationProvider | null = null;
export function __setCopyProviderForTests(provider: CopyGenerationProvider | null): void { override = provider; }
export function getCopyProvider(): CopyGenerationProvider { return override ?? new DefaultCopyGenerationProvider(); }

export function isRepairableWithoutInventingFacts(report: ValidationReport): boolean {
  const unrepairable = new Set([
    "UNSUPPORTED_MATERIAL_CLAIM", "UNSUPPORTED_EFFICACY_CLAIM", "UNSUPPORTED_PRICE_CLAIM",
    "UNSUPPORTED_AVAILABILITY_CLAIM", "UNSUPPORTED_BRAND_CLAIM", "UNSUPPORTED_NUMERIC_CLAIM",
    "BLOCKED_FACT_USED", "CLAIM_DETECTION_INCOMPLETE", "UNSUPPORTED_VIDEO_COVER_INFERENCE",
  ]);
  return !report.valid && !report.issues.some(issue => unrepairable.has(issue.code));
}

function selectedPhrases(evidence: KeywordEvidence): string[] {
  const accepted = new Map(evidence.candidates.filter(c => c.status === "accepted").map(c => [c.id, c.phrase]));
  return evidence.selectedKeywordIds.slice(0, 5).map(id => accepted.get(id)).filter((v): v is string => Boolean(v));
}

export const AFFILIATE_PROMPT_LINE = "This Pin links to a product on Amazon. Prefer 'Find it on Amazon' style phrasing; never use 'Buy now', 'Add to cart', price, deal, discount, stock or rating claims. Do not add any disclosure hashtag yourself.";

/**
 * Grounding rule stated to the model (P1 0925). The validator grounds a brand /
 * material / number / capability claim only when it appears VERBATIM in one sentence
 * of the seller's text, so a paraphrase ("dedicated mic-off button" for "a mic off
 * button") is an unrepairable 422. Tell the model the rule it is judged by.
 */
export const GROUNDED_WORDING_LINE = "Mention a brand, product line, material, size, number, compatibility, or product capability only if it appears in the grounding facts, and then reuse the exact wording from the facts: do not paraphrase, merge, or embellish it. Leave out anything the facts do not state.";

/** The description cap the model writes to (affiliate: 500 minus the appended marker). */
export function descriptionBudgetFor(req: Pick<GenerateCopyRequest, "affiliateDisclosure">): number {
  return req.affiliateDisclosure ? affiliateDescriptionBudget(req.affiliateDisclosure) : DEFAULT_DESCRIPTION_MAX;
}

/**
 * Target ranges in CHARACTERS, derived from the cap. The model overshoots a target
 * that sits at the cap (Preview: 611-796 characters against "250-450 ... 496" with no
 * unit), so the upper end of every target stays well under the hard limit.
 */
export function lengthGuide(length: NonNullable<GenerateCopyRequest["lengthPreference"]>, cap: number): string {
  if (length === "short") return `title 40-60 characters, description 120-${Math.min(220, Math.floor(cap * 0.45))} characters`;
  if (length === "seo-rich") {
    const upper = Math.floor(cap * 0.85);
    return `title 70-95 characters, description ${Math.min(350, upper - 100)}-${upper} characters`;
  }
  return `title 50-80 characters, description 200-${Math.min(380, Math.floor(cap * 0.75))} characters`;
}

export function buildPromptForSession(req: GenerateCopyRequest): string {
  const length = req.lengthPreference ?? "standard";
  // Affiliate copy: the model's own description budget excludes the disclosure the
  // server appends afterwards, so the final text fits Studio's 500 cap (design §3.4).
  const descriptionBudget = descriptionBudgetFor(req);
  const facts = req.factCard.facts.filter(f => f.claimPolicy !== "blocked").map(f => `- ${f.key}: ${f.value} (${f.claimPolicy})`);
  const keywords = selectedPhrases(req.keywordEvidence);
  return [
    ...languageInstructions(req.factCard.locale),
    req.factCard.mediaEvidence?.mode === "video_cover"
      ? "Visual grounding is one frozen video cover frame only. Describe only the supplied static taxonomy facts; never add motion, actions, sequence, time, audio, speech, music, performance, efficacy, brand, material, price, stock, inventory, quantity, or numeric commercial claims from that frame."
      : "",
    req.affiliateDisclosure ? AFFILIATE_PROMPT_LINE : "",
    GROUNDED_WORDING_LINE,
    `Length preference: ${length}; target ${lengthGuide(length, descriptionBudget)}. Hard limits, counted in characters (not words) including spaces and punctuation: title 100, description ${descriptionBudget}. Two or three short sentences are enough; never exceed the description limit.`,
    `Grounding facts:\n${facts.length ? facts.join("\n") : "No product claims are authorized."}`,
    req.angleRequest?.trim() ? `Requested angle: ${req.angleRequest.trim()}` : "",
    keywords.length && req.keywordEvidence.degradedMode === "none" ? `Optional demand-backed keywords (use naturally, never force):\n${keywords.map(k => `- ${k}`).join("\n")}` : "No reliable keyword demand data. Use grounded semantics only.",
  ].filter(Boolean).join("\n\n");
}

export class ValidationErrorV2 extends Error {
  status = 422;
  constructor(public validationReport: ValidationReport) { super("Generated copy failed validation"); }
}

async function detectClaimsOnce(provider: CopyGenerationProvider, output: ProviderCopyOutput, factCard: FactCardV1, costContext?: ChatCostContext): Promise<ClaimDetectionResult> {
  try { return parseClaimDetection(await provider.detectClaims(output, factCard, costContext)); }
  catch { return { status: "incomplete", claims: [] }; }
}

/**
 * One retry when detection is incomplete (malformed JSON / transient provider error).
 * Still fail-closed: a second incomplete result is CLAIM_DETECTION_INCOMPLETE.
 */
async function detectClaims(provider: CopyGenerationProvider, output: ProviderCopyOutput, factCard: FactCardV1, costContext?: ChatCostContext): Promise<ClaimDetectionResult> {
  const first = await detectClaimsOnce(provider, output, factCard, costContext);
  return first.status === "completed" ? first : detectClaimsOnce(provider, output, factCard, costContext);
}

function validate(output: ProviderCopyOutput, req: GenerateCopyRequest, claimDetection: ClaimDetectionResult): ValidationReport {
  return validateCopy({
    title: output.title, description: output.description, altText: output.altText,
    factCard: req.factCard, keywords: selectedPhrases(req.keywordEvidence),
    claimDetection,
    ...(req.affiliateDisclosure ? { descriptionMax: AFFILIATE_DESCRIPTION_MAX } : {}),
  });
}

/**
 * Server-side disclosure (design §3.4): appended to the provider's raw output BEFORE
 * claim detection and validation, so what is validated is exactly what ships. Never
 * truncates — an over-length result is DESCRIPTION_TOO_LONG, which is repairable.
 */
function withDisclosure(raw: ProviderCopyOutput, req: GenerateCopyRequest): ProviderCopyOutput {
  if (!req.affiliateDisclosure) return raw;
  return { ...raw, description: appendAffiliateDisclosure(raw.description, req.affiliateDisclosure) };
}

/**
 * T3 deviation 3 (fixed in T4): the repair model only ever sees the RAW text, so the
 * length it is held to must be the RAW budget (500 − marker − space), not the shipped
 * cap. Otherwise a 499-char draft is "too long" against a 500 cap the model believes it
 * already meets, the repair comes back at ~499 again, and the card gets a 422.
 * Affiliate requests only; the flag-off repair input is untouched.
 */
function reportForRepair(report: ValidationReport, raw: ProviderCopyOutput, req: GenerateCopyRequest): ValidationReport {
  if (!req.affiliateDisclosure) return report;
  const budget = affiliateDescriptionBudget(req.affiliateDisclosure);
  return {
    ...report,
    issues: report.issues.map(issue => issue.code === "DESCRIPTION_TOO_LONG"
      ? { ...issue, message: `Description length (${raw.description.length}) exceeds maximum of ${budget} characters` }
      : issue),
  };
}

/**
 * Repair prompt. A length-only repair must SHORTEN, never rewrite: it states the raw
 * budget in characters and forbids new claims, so the second validation cannot fail on
 * a fact the first draft did not contain. Affiliate copy also states that the server
 * appends the disclosure (see reportForRepair).
 */
function promptForRepair(prompt: string, req: GenerateCopyRequest, report: ValidationReport, raw: ProviderCopyOutput): string {
  const lines: string[] = [];
  if (report.issues.some(issue => issue.code === "DESCRIPTION_TOO_LONG")) {
    const budget = descriptionBudgetFor(req);
    lines.push(`The previous description was ${raw.description.length} characters. Shorten it to at most ${Math.floor(budget * 0.85)} characters (hard limit ${budget}) by deleting whole sentences or clauses. Keep the remaining wording as it is; do not add any new brand, material, number, feature, or claim.`);
  }
  if (req.affiliateDisclosure) {
    const budget = affiliateDescriptionBudget(req.affiliateDisclosure);
    lines.push(`The description you return must be at most ${budget} characters; the server appends the disclosure afterwards.`);
  }
  return lines.length ? `${prompt}\n${lines.join("\n")}` : prompt;
}

export async function orchestrateCopyGeneration(req: GenerateCopyRequest): Promise<CopyResultV2> {
  const provider = getCopyProvider();
  const prompt = buildPromptForSession(req);
  // `raw` is the model's own text; `output` is what ships (raw + disclosure). Repair
  // always sees the RAW text: showing it our #ad while the prompt says "do not add a
  // disclosure yourself" would be contradictory.
  let raw = await provider.generate(prompt, undefined, req.costContext);
  let output = withDisclosure(raw, req);
  let report = validate(output, req, await detectClaims(provider, output, req.factCard, req.costContext));
  if (!report.valid) {
    if (!isRepairableWithoutInventingFacts(report) || !provider.repair) throw new ValidationErrorV2(report);
    raw = await provider.repair(raw, reportForRepair(report, raw, req), promptForRepair(prompt, req, report, raw), req.costContext);
    output = withDisclosure(raw, req);
    report = validate(output, req, await detectClaims(provider, output, req.factCard, req.costContext));
    if (!report.valid) throw new ValidationErrorV2(report);
  }
  const usedKeywordIds = req.keywordEvidence.selectedKeywordIds.slice(0, 5).filter(id => {
    const candidate = req.keywordEvidence.candidates.find(c => c.id === id && c.status === "accepted");
    if (!candidate) return false;
    return containsTokenPhrase(`${output.title} ${output.description}`, candidate.phrase);
  });
  return {
    generationId: req.generationId, sessionId: req.sessionId, draftId: req.draftId,
    angleId: req.angleId ?? "default", keywordSetId: req.keywordEvidence.keywordSetId,
    title: output.title, description: output.description, altText: output.altText,
    usedKeywordIds, factSummary: summarizeFacts(req.factCard),
    degradedMode: req.factCard.mediaEvidence?.degradedMode === "video_cover_unavailable"
      ? "video_cover_unavailable"
      : req.keywordEvidence.degradedMode,
    validationReport: report,
  };
}
