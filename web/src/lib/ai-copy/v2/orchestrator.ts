/**
 * orchestrator.ts   AI Copy v2 Server Orchestration & Provider Interface.
 *
 * Rules:
 *  - Real server provider behind injectable interface (no client mock mode).
 *  - Keep model/prompt versions.
 *  - Validate output with existing validator (100 char title, 800 char desc).
 *  - At most ONE repair provider call for repairable non-fact issues.
 *  - Never repair fact conflicts by inventing facts.
 *  - Second invalid -> error with validation details; never returns invalid copy.
 *  - Provider failure -> 502.
 *  - Exactly one CopyResultV2, no clusterId.
 *  - Degraded mode (no_keyword_demand_data) generates from grounded semantics only.
 *  - Selected keywords: at most 5, never mandatory.
 */

import { chatJson, providerConfig, CopyError, PROVIDER_MESSAGE } from "@/lib/ai-copy/visionServer";
import { validateCopy } from "./validateCopy";
import { summarizeFacts } from "./factCard";
import type {
  CopyResultV2,
  FactCardV1,
  KeywordEvidence,
  ValidationReport,
  DetectedClaim,
} from "./types";

export const AI_COPY_V2_MODEL_VERSION = "ai-copy-v2-gpt4o-mini-2026-09";
export const AI_COPY_V2_PROMPT_VERSION = "ai_copy_v2_grounded_v1";

export interface GenerateCopyRequest {
  sessionId: string;
  draftId: string;
  factCard: FactCardV1;
  keywordEvidence: KeywordEvidence;
  angleId?: string;
  lengthPreference?: "short" | "standard" | "seo-rich";
  detectedClaims?: DetectedClaim[];
}

export interface CopyGenerationProvider {
  generate(prompt: string, systemPrompt?: string): Promise<{ title: string; description: string; altText: string }>;
  repair?(
    originalOutput: { title: string; description: string; altText: string },
    validationReport: ValidationReport,
    prompt: string,
  ): Promise<{ title: string; description: string; altText: string }>;
}

/**
 * Production provider backed by real chatJson.
 */
export class DefaultCopyGenerationProvider implements CopyGenerationProvider {
  async generate(prompt: string, systemPrompt?: string): Promise<{ title: string; description: string; altText: string }> {
    const cfg = providerConfig();
    const messages = [
      {
        role: "system",
        content:
          systemPrompt ||
          "You are an expert Pinterest copywriter. Output JSON only with keys: 'title', 'description', 'altText'. Keep title under 100 characters and description under 800 characters. Ground strictly in facts.",
      },
      { role: "user", content: prompt },
    ];

    try {
      const raw = await chatJson({
        key: cfg.apiKey,
        baseUrl: cfg.baseUrl,
        model: cfg.textModel,
        messages,
        timeoutMs: 15_000,
        temperature: 0.5,
        provider: cfg.provider,
      });

      const parsed = raw as Record<string, unknown>;
      return {
        title: typeof parsed?.title === "string" ? parsed.title.trim() : "",
        description: typeof parsed?.description === "string" ? parsed.description.trim() : "",
        altText: typeof parsed?.altText === "string" ? parsed.altText.trim() : "",
      };
    } catch (err) {
      if (err instanceof CopyError) throw err;
      throw new CopyError(`provider_error: ${(err as Error)?.message || "unknown"}`, 502, PROVIDER_MESSAGE);
    }
  }

  async repair(
    originalOutput: { title: string; description: string; altText: string },
    validationReport: ValidationReport,
    prompt: string,
  ): Promise<{ title: string; description: string; altText: string }> {
    const cfg = providerConfig();
    const issuesSummary = validationReport.issues
      .map((i) => `[${i.field}] ${i.code}: ${i.message}`)
      .join("\n");

    const repairPrompt = `The previous copy failed validation with these issues:
${issuesSummary}

Previous output:
Title: ${originalOutput.title}
Description: ${originalOutput.description}
Alt Text: ${originalOutput.altText}

Original requirements:
${prompt}

Please rewrite the copy to strictly fix the validation issues without introducing ungrounded claims or truncating thoughts. Output JSON only with keys: 'title', 'description', 'altText'.`;

    const messages = [
      {
        role: "system",
        content:
          "You are an expert Pinterest copy editor. Fix the copy formatting, length, or repetition issues while adhering strictly to facts. Output JSON only.",
      },
      { role: "user", content: repairPrompt },
    ];

    try {
      const raw = await chatJson({
        key: cfg.apiKey,
        baseUrl: cfg.baseUrl,
        model: cfg.textModel,
        messages,
        timeoutMs: 15_000,
        temperature: 0.3,
        provider: cfg.provider,
      });

      const parsed = raw as Record<string, unknown>;
      return {
        title: typeof parsed?.title === "string" ? parsed.title.trim() : "",
        description: typeof parsed?.description === "string" ? parsed.description.trim() : "",
        altText: typeof parsed?.altText === "string" ? parsed.altText.trim() : "",
      };
    } catch (err) {
      if (err instanceof CopyError) throw err;
      throw new CopyError(`repair_provider_error: ${(err as Error)?.message || "unknown"}`, 502, PROVIDER_MESSAGE);
    }
  }
}

let providerOverride: CopyGenerationProvider | null = null;

export function __setCopyProviderForTests(provider: CopyGenerationProvider | null): void {
  providerOverride = provider;
}

export function getCopyProvider(): CopyGenerationProvider {
  return providerOverride ?? new DefaultCopyGenerationProvider();
}

/** Check if issues are non-fact repairable (length, stuffing, keyword frequency). */
export function isRepairableWithoutInventingFacts(report: ValidationReport): boolean {
  if (report.valid) return false;
  // If there are unsupported claim violations or blocked fact violations, repairing
  // cannot invent facts to resolve them.
  const unrepairableCodes = new Set([
    "UNSUPPORTED_MATERIAL_CLAIM",
    "UNSUPPORTED_EFFICACY_CLAIM",
    "UNSUPPORTED_PRICE_CLAIM",
    "UNSUPPORTED_AVAILABILITY_CLAIM",
    "UNSUPPORTED_BRAND_CLAIM",
    "UNSUPPORTED_NUMERIC_CLAIM",
    "BLOCKED_FACT_USED",
  ]);

  for (const issue of report.issues) {
    if (unrepairableCodes.has(issue.code)) {
      return false;
    }
  }
  return true;
}

export function buildPromptForSession(req: GenerateCopyRequest): string {
  const { factCard, keywordEvidence, lengthPreference = "standard" } = req;
  const isDegraded = keywordEvidence.degradedMode === "no_keyword_demand_data";

  // Selected keywords: at most 5, never mandatory
  const candidateMap = new Map(keywordEvidence.candidates.map((c) => [c.id, c.phrase]));
  const selectedPhrases = (keywordEvidence.selectedKeywordIds || [])
    .slice(0, 5)
    .map((id) => candidateMap.get(id))
    .filter((p): p is string => Boolean(p));

  const factLines = factCard.facts
    .filter((f) => f.claimPolicy !== "blocked")
    .map((f) => `- [${f.key}] ${f.value} (policy: ${f.claimPolicy})`);

  const lengthGuide =
    lengthPreference === "short"
      ? "Title: ~40-60 chars (max 100). Description: ~150-250 chars (max 800)."
      : lengthPreference === "seo-rich"
      ? "Title: ~70-95 chars (max 100). Description: ~400-700 chars (max 800)."
      : "Title: ~50-80 chars (max 100). Description: ~250-450 chars (max 800).";

  const promptParts: string[] = [
    `Language / Locale: ${factCard.locale}`,
    `Target Length Style: ${lengthPreference} (${lengthGuide})`,
    `Grounding Facts:\n${factLines.length ? factLines.join("\n") : "No specific product claims provided."}`,
  ];

  if (!isDegraded && selectedPhrases.length > 0) {
    promptParts.push(
      `Relevant Keywords (Optional inspirations; include naturally ONLY if they fit, do NOT force or repeat them):\n${selectedPhrases
        .map((p) => `- ${p}`)
        .join("\n")}`,
    );
  } else if (isDegraded) {
    promptParts.push(
      "Notice: No keyword demand data available. Focus purely on engaging, grounded product/image semantics without keyword stuffing.",
    );
  }

  return promptParts.join("\n\n");
}

export class ValidationErrorV2 extends Error {
  public status = 422;
  public validationReport: ValidationReport;
  constructor(report: ValidationReport, msg = "Generated copy failed validation") {
    super(msg);
    this.name = "ValidationErrorV2";
    this.validationReport = report;
  }
}

/**
 * Orchestrates copy generation with trusted session facts, at most 1 repair, and validation.
 */
export async function orchestrateCopyGeneration(req: GenerateCopyRequest): Promise<CopyResultV2> {
  const provider = getCopyProvider();
  const prompt = buildPromptForSession(req);

  // 1. Initial generation call
  const initial = await provider.generate(prompt);

  // 2. Validate initial output
  const keywordPhrases = req.keywordEvidence.candidates.map((c) => c.phrase);
  const claimDetection = {
    status: "completed" as const,
    claims: req.detectedClaims ?? [],
  };

  let validation = validateCopy({
    title: initial.title,
    description: initial.description,
    altText: initial.altText,
    factCard: req.factCard,
    keywords: keywordPhrases,
    claimDetection,
  });

  let finalOutput = initial;

  // 3. At most ONE repair call if invalid AND repairable
  if (!validation.valid) {
    if (isRepairableWithoutInventingFacts(validation) && typeof provider.repair === "function") {
      const repaired = await provider.repair(initial, validation, prompt);
      const repairedValidation = validateCopy({
        title: repaired.title,
        description: repaired.description,
        altText: repaired.altText,
        factCard: req.factCard,
        keywords: keywordPhrases,
        claimDetection,
      });

      if (repairedValidation.valid) {
        finalOutput = repaired;
        validation = repairedValidation;
      } else {
        // Second invalid -> throw 422 with validation issues, NEVER return bad copy
        throw new ValidationErrorV2(repairedValidation, "Copy remained invalid after repair");
      }
    } else {
      // Unrepairable fact conflict or repair not supported -> 422 immediately
      throw new ValidationErrorV2(validation, "Copy validation failed with unrepairable issues");
    }
  }

  // Build CopyResultV2
  const candidateMap = new Map(req.keywordEvidence.candidates.map((c) => [c.phrase.toLowerCase(), c.id]));
  const usedKeywordIds: string[] = [];
  for (const [phrase, id] of candidateMap.entries()) {
    if (
      finalOutput.title.toLowerCase().includes(phrase) ||
      finalOutput.description.toLowerCase().includes(phrase)
    ) {
      usedKeywordIds.push(id);
    }
  }

  const factSummary = summarizeFacts(req.factCard);

  return {
    generationId: `gen_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    sessionId: req.sessionId,
    draftId: req.draftId,
    angleId: req.angleId || "default",
    keywordSetId: req.keywordEvidence.keywordSetId,
    title: finalOutput.title,
    description: finalOutput.description,
    altText: finalOutput.altText,
    usedKeywordIds,
    factSummary,
    degradedMode: req.keywordEvidence.degradedMode,
    validationReport: validation,
  };
}
