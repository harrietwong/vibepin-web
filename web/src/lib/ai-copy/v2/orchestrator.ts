/** Grounded single-result generation with one optional repair. */
import { chatJson, providerConfig, CopyError, PROVIDER_MESSAGE, languageInstructions, type ChatCostContext } from "@/lib/ai-copy/visionServer";
import { containsTokenPhrase, validateCopy } from "./validateCopy";
import { summarizeFacts } from "./factCard";
import type { ClaimDetectionResult, CopyResultV2, DetectedClaim, DetectedClaimType, FactCardV1, KeywordEvidence, ValidationReport } from "./types";

export const AI_COPY_V2_PROMPT_VERSION = "ai_copy_v2_grounded_v3_independent_claims";
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
const DETECTOR_SYSTEM = "Independently extract every commercial claim and every video-cover-unsupported inference from the supplied copy. Return JSON with claims only. Each claim has type (material, brand, price, availability, efficacy, numeric_commercial, video_motion, video_audio, or video_temporal), value, and field (title, description, or altText). video_motion includes actions or motion; video_audio includes audio, singing, speech, or music; video_temporal includes duration, sequence, or before/after claims. Use [] only when none exists. Do not trust or use any claims self-reported by the copy generator.";

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
    const issues = report.issues.map(issue => `${issue.field}:${issue.code}`).join(", ");
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

export function buildPromptForSession(req: GenerateCopyRequest): string {
  const length = req.lengthPreference ?? "standard";
  const guide = length === "short" ? "title 40-60, description 150-250" : length === "seo-rich" ? "title 70-95, description 400-700" : "title 50-80, description 250-450";
  const facts = req.factCard.facts.filter(f => f.claimPolicy !== "blocked").map(f => `- ${f.key}: ${f.value} (${f.claimPolicy})`);
  const keywords = selectedPhrases(req.keywordEvidence);
  return [
    ...languageInstructions(req.factCard.locale),
    req.factCard.mediaEvidence?.mode === "video_cover"
      ? "Visual grounding is one frozen video cover frame only. Describe only the supplied static taxonomy facts; never add motion, actions, sequence, time, audio, speech, music, performance, efficacy, brand, material, price, stock, inventory, quantity, or numeric commercial claims from that frame."
      : "",
    `Length preference: ${length}; ${guide}; hard limits title 100, description 800.`,
    `Grounding facts:\n${facts.length ? facts.join("\n") : "No product claims are authorized."}`,
    req.angleRequest?.trim() ? `Requested angle: ${req.angleRequest.trim()}` : "",
    keywords.length && req.keywordEvidence.degradedMode === "none" ? `Optional demand-backed keywords (use naturally, never force):\n${keywords.map(k => `- ${k}`).join("\n")}` : "No reliable keyword demand data. Use grounded semantics only.",
  ].filter(Boolean).join("\n\n");
}

export class ValidationErrorV2 extends Error {
  status = 422;
  constructor(public validationReport: ValidationReport) { super("Generated copy failed validation"); }
}

async function detectClaims(provider: CopyGenerationProvider, output: ProviderCopyOutput, factCard: FactCardV1, costContext?: ChatCostContext): Promise<ClaimDetectionResult> {
  try { return parseClaimDetection(await provider.detectClaims(output, factCard, costContext)); }
  catch { return { status: "incomplete", claims: [] }; }
}

function validate(output: ProviderCopyOutput, req: GenerateCopyRequest, claimDetection: ClaimDetectionResult): ValidationReport {
  return validateCopy({
    title: output.title, description: output.description, altText: output.altText,
    factCard: req.factCard, keywords: selectedPhrases(req.keywordEvidence),
    claimDetection,
  });
}

export async function orchestrateCopyGeneration(req: GenerateCopyRequest): Promise<CopyResultV2> {
  const provider = getCopyProvider();
  const prompt = buildPromptForSession(req);
  let output = await provider.generate(prompt, undefined, req.costContext);
  let report = validate(output, req, await detectClaims(provider, output, req.factCard, req.costContext));
  if (!report.valid) {
    if (!isRepairableWithoutInventingFacts(report) || !provider.repair) throw new ValidationErrorV2(report);
    output = await provider.repair(output, report, prompt, req.costContext);
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
