/**
 * visionServer.ts — shared server-only helpers for AI Copy.
 *
 * Used by:
 *  - POST /api/ai-copy/analyze  → upload-time image analysis + keyword prep
 *  - POST /api/ai-copy          → copy generation (fast text path when analysis is
 *                                 cached; vision one-call fallback otherwise)
 *
 * The persistent image-analysis cache lives on the Pin draft (client localStorage),
 * NOT in a module-level Map here — so nothing production-critical depends on process
 * memory that resets between requests / instances.
 */

// ── Errors + user-safe messages ───────────────────────────────────────────────

/**
 * Carries an HTTP status and a user-safe message. 422 → we couldn't produce good
 * copy (bad image, quality gate) — not the provider's fault. 502 → the upstream
 * provider genuinely failed. 500 → server misconfiguration.
 */
export class CopyError extends Error {
  status: number;
  code: string;
  userMessage: string;
  constructor(code: string, status: number, userMessage: string) {
    super(code);
    this.code = code;
    this.status = status;
    this.userMessage = userMessage;
  }
}

// Version stamp for the copy prompts defined below (buildFastPathPrompt /
// buildVisionPrompt). The constant itself lives in promptVersions.ts so CLIENT code
// (generatePinCopy.ts analytics) can import it without pulling in this server module;
// re-exported here for server-side convenience.
export { COPY_PROMPT_VERSION } from "./promptVersions";

export const GENERIC_COPY_MESSAGE = "We couldn't generate good copy for this image. Please try again.";
export const IMAGE_MESSAGE = "We couldn't read this image. Re-upload it and try again.";
export const PROVIDER_MESSAGE = "The AI service is temporarily unavailable. Please try again in a moment.";

export const isDev = process.env.NODE_ENV !== "production";
export function devLog(event: string, data: unknown) {
  if (isDev) console.info(`[ai-copy] ${event}`, typeof data === "string" ? data : JSON.stringify(data));
}
export function elapsed(start: number): number {
  return Math.round(performance.now() - start);
}

// ── Types ─────────────────────────────────────────────────────────────────────

/** Structured analysis produced at upload time and cached on the draft. */
export type StructuredImageAnalysis = {
  imageSummary: string;
  visibleObjects: string[];
  colors: string[];
  style: string;
  ocrText: string;
  category: string;
};

/** The subset used to ground copy (superset-compatible with StructuredImageAnalysis). */
export type GroundingAnalysis = {
  imageSummary: string;
  visibleObjects: string[];
  colors: string[];
  style: string;
  ocrText?: string;
  category?: string;
};

/** Full structured analysis + copy from the vision one-call (fallback path). */
export type VisionResult = {
  imageSummary: string;
  visibleObjects: string[];
  colors: string[];
  style: string;
  title: string;
  description: string;
  altText: string;
  keywords: string[];
};

/** Legacy image-context shape kept for backward compatibility with the client. */
export type ImageContext = {
  primarySubjects: string[];
  scene: string;
  attributes: string[];
  colors: string[];
  style: string[];
  visibleText: string[];
};

export type CopyOutput = {
  title: string;
  description: string;
  tags: string[];
  altText: string;
};

export type PreviousCopy = { title?: string; description?: string };

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const GENERIC_TITLE_RE = /\b(home decor product inspiration|product inspiration|home decor product|pin idea|pin ideas|beautiful ideas|pinterest look|pinterest inspiration|inspiration \d+|content inspiration)\b/i;
const GENERIC_DESC_RE = /\b(use .* as inspiration for a pinterest look|use .* product as inspiration|pinterest-ready idea|relevant ideas|discover beautiful ideas|save this pin|for your space)\b/i;

// ── URL validation ─────────────────────────────────────────────────────────────

/** A real, server-fetchable public image URL (rejects blob:/data:/localhost/relative). */
export function safeImageUrl(raw: string | undefined): URL | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith("blob:") || trimmed.startsWith("data:")) return null;
  try {
    const url = new URL(trimmed);
    if (!/^https?:$/.test(url.protocol)) return null;
    if (["localhost", "127.0.0.1", "::1", "0.0.0.0"].includes(url.hostname)) return null;
    return url;
  } catch {
    return null;
  }
}

export function safeUrl(raw: string | undefined): URL | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (!/^https?:$/.test(url.protocol)) return null;
    if (["localhost", "127.0.0.1", "::1"].includes(url.hostname)) return null;
    return url;
  } catch {
    return null;
  }
}

// ── Provider config ─────────────────────────────────────────────────────────────

export function providerConfig() {
  const linapiKey = process.env.LINAPI_KEY || "";
  const openaiKey = process.env.OPENAI_API_KEY || "";
  const useLinapi = !!linapiKey;
  return {
    provider: useLinapi ? "linapi" : openaiKey ? "openai" : "none",
    key: linapiKey || openaiKey,
    baseUrl: (useLinapi ? process.env.LINAPI_BASE_URL : "https://api.openai.com/v1")?.replace(/\/$/, "") || "https://api.openai.com/v1",
    // Vision-capable model used for image analysis and the vision fallback.
    visionModel: process.env.AI_COPY_VISION_MODEL || process.env.LINAPI_ANALYSIS_MODEL || process.env.OPENAI_AI_COPY_VISION_MODEL || (useLinapi ? "gemini-2.5-flash" : "gpt-4o-mini"),
    // Fast text-only model used when a cached analysis exists (no image tokens).
    textModel: process.env.AI_COPY_TEXT_MODEL || (useLinapi ? "gemini-2.5-flash" : "gpt-4o-mini"),
  };
}

export type ProviderConfig = ReturnType<typeof providerConfig>;

// ── Chat / JSON ─────────────────────────────────────────────────────────────────

/** Tolerant JSON parse — strips markdown fences and extracts the JSON object. */
export function parseJsonLoose(content: string): unknown {
  const trimmed = content.trim();
  try { return JSON.parse(trimmed); } catch { /* fall through */ }
  const unfenced = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  try { return JSON.parse(unfenced); } catch { /* fall through */ }
  const first = unfenced.indexOf("{");
  const last = unfenced.lastIndexOf("}");
  if (first >= 0 && last > first) return JSON.parse(unfenced.slice(first, last + 1));
  throw new CopyError("provider_unparseable_response", 502, PROVIDER_MESSAGE);
}

/** Model-family checks used to decide which provider-specific params are safe to send. */
export function isGeminiModel(model: string): boolean {
  return /gemini/i.test(model);
}
export function isClaudeModel(model: string): boolean {
  return /claude/i.test(model);
}

/**
 * Extra request-body fields that ask Gemini (via the LinAPI OpenAI-compatible proxy)
 * to skip/minimize its "thinking" pass, which otherwise dominates latency for small
 * outputs. These are GEMINI-ONLY (reasoning_effort / thinking_budget / thinking) — we
 * must never send them to Claude or other models, which can reject or misread them.
 * Gated to linapi + Gemini models. Disable with AI_COPY_DISABLE_THINKING=false.
 */
export function thinkingExtras(provider: string, model: string): Record<string, unknown> {
  if (provider !== "linapi" || !isGeminiModel(model) || process.env.AI_COPY_DISABLE_THINKING === "false") return {};
  return { reasoning_effort: "none", thinking_budget: 0, thinking: { type: "disabled" } };
}

/** Call chat/completions. Throws CopyError(502) for genuine upstream failures. */
export async function chatJson(opts: {
  key: string;
  baseUrl: string;
  model: string;
  messages: unknown[];
  temperature?: number;
  timeoutMs: number;
  maxTokens?: number;
  extraBody?: Record<string, unknown>;
}): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${opts.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${opts.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: opts.model,
        messages: opts.messages,
        temperature: opts.temperature ?? 0.4,
        response_format: { type: "json_object" },
        ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
        ...(opts.extraBody ?? {}),
      }),
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
  } catch (err) {
    throw new CopyError(`provider_network_error:${(err as Error)?.message?.slice(0, 120) || "unknown"}`, 502, PROVIDER_MESSAGE);
  }
  const text = await res.text();
  if (!res.ok) throw new CopyError(`provider_http_${res.status}:${text.slice(0, 180)}`, 502, PROVIDER_MESSAGE);
  let parsed: { choices?: Array<{ message?: { content?: string } }> };
  try { parsed = JSON.parse(text); } catch { throw new CopyError("provider_envelope_unparseable", 502, PROVIDER_MESSAGE); }
  const content = parsed.choices?.[0]?.message?.content;
  if (!content) throw new CopyError("provider_empty_response", 502, PROVIDER_MESSAGE);
  return parseJsonLoose(content);
}

// ── Image fetch ───────────────────────────────────────────────────────────────

/**
 * Server-side fetch the image → base64 data URL (grounds the model on real bytes).
 * Throws CopyError(422) when the image is missing, non-public, non-image, or unreachable.
 */
export async function fetchImageAsDataUrl(imageUrl: string | undefined): Promise<{
  dataUrl: string;
  contentType: string;
  bytes: number;
  latencyMs: number;
}> {
  const url = safeImageUrl(imageUrl);
  if (!url) throw new CopyError(imageUrl ? "invalid_image_url" : "missing_image_url", 422, IMAGE_MESSAGE);
  const start = performance.now();
  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; VibePin/1.0)",
        "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      },
      signal: AbortSignal.timeout(8000),
    });
  } catch (err) {
    throw new CopyError(`image_fetch_failed:${(err as Error)?.message?.slice(0, 100) || "unknown"}`, 422, IMAGE_MESSAGE);
  }
  if (!res.ok) throw new CopyError(`image_http_${res.status}`, 422, IMAGE_MESSAGE);
  const contentType = res.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
  if (!contentType.startsWith("image/")) throw new CopyError(`image_non_image_content_type:${contentType || "unknown"}`, 422, IMAGE_MESSAGE);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength <= 0) throw new CopyError("image_empty", 422, IMAGE_MESSAGE);
  if (buf.byteLength > MAX_IMAGE_BYTES) throw new CopyError("image_too_large", 422, IMAGE_MESSAGE);
  return {
    dataUrl: `data:${contentType};base64,${buf.toString("base64")}`,
    contentType,
    bytes: buf.byteLength,
    latencyMs: elapsed(start),
  };
}

// ── Normalization ───────────────────────────────────────────────────────────────

export function asStringArray(v: unknown, max: number): string[] {
  if (!Array.isArray(v)) return [];
  return v.map(x => (typeof x === "string" ? x : String(x ?? ""))).map(s => s.trim()).filter(Boolean).slice(0, max);
}

export function normalizeVision(raw: Partial<VisionResult>): VisionResult {
  return {
    imageSummary: typeof raw.imageSummary === "string" ? raw.imageSummary.trim() : "",
    visibleObjects: asStringArray(raw.visibleObjects, 10),
    colors: asStringArray(raw.colors, 8),
    style: typeof raw.style === "string" ? raw.style.trim() : Array.isArray(raw.style) ? asStringArray(raw.style, 3).join(", ") : "",
    title: typeof raw.title === "string" ? raw.title.trim() : "",
    description: typeof raw.description === "string" ? raw.description.trim() : "",
    altText: typeof raw.altText === "string" ? raw.altText.trim() : "",
    keywords: asStringArray(raw.keywords, 12),
  };
}

export function normalizeTag(raw: string): string {
  return raw
    .replace(/^#+/, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .slice(0, 40);
}

// PRD product caps: title ≤100, description ≤500, alt ≤500. Enforced on every
// AI output (not just prompts) and again on the publish path.
export const TITLE_MAX_CHARS = 100;
export const DESC_MAX_CHARS = 500;
export const ALT_MAX_CHARS = 500;

export function toCopyOutput(v: VisionResult): CopyOutput {
  return {
    title: v.title.slice(0, TITLE_MAX_CHARS),
    description: v.description.slice(0, DESC_MAX_CHARS),
    tags: v.keywords.map(normalizeTag).filter(Boolean).slice(0, 12),
    altText: (v.altText || v.imageSummary).slice(0, ALT_MAX_CHARS),
  };
}

export function toImageContext(a: GroundingAnalysis | null): ImageContext | null {
  if (!a) return null;
  return {
    primarySubjects: a.visibleObjects.slice(0, 6),
    scene: a.imageSummary,
    attributes: [],
    colors: a.colors,
    style: a.style ? [a.style] : [],
    visibleText: a.ocrText ? [a.ocrText] : [],
  };
}

// ── Quality gate ─────────────────────────────────────────────────────────────────

/** Rejects copy that is generic, empty, or not grounded in the image. */
export function qualityIssues(v: VisionResult, previous?: PreviousCopy): string[] {
  const issues: string[] = [];
  const title = v.title.trim();
  const desc = v.description.trim();

  if (!v.imageSummary.trim()) issues.push("empty_image_summary");
  if (!title || title.length < 8 || GENERIC_TITLE_RE.test(title)) issues.push("generic_title");
  if (!desc || desc.length < 30 || GENERIC_DESC_RE.test(desc)) issues.push("generic_description");
  if (previous?.title && title && title.toLowerCase() === previous.title.trim().toLowerCase()) issues.push("repeated_previous_title");
  if (previous?.description && desc && desc.toLowerCase() === previous.description.trim().toLowerCase()) issues.push("repeated_previous_description");

  const concreteTokens = [...v.visibleObjects, ...v.colors, v.style, ...v.imageSummary.split(/\s+/)]
    .flatMap(s => s.toLowerCase().split(/\s+/))
    .map(w => w.replace(/[^a-z0-9]/g, ""))
    .filter(w => w.length > 3);
  if (concreteTokens.length) {
    const combined = `${title} ${desc} ${v.altText}`.toLowerCase();
    if (!concreteTokens.some(tok => combined.includes(tok))) issues.push("ungrounded_copy");
  }
  return issues;
}

/** Detect keyword stuffing: too many recommended phrases jammed in, or word spam. */
export function stuffingIssues(text: string, keywords: string[]): string[] {
  const t = text.toLowerCase();
  const hits = keywords.filter(k => k && t.includes(k.toLowerCase())).length;
  const issues: string[] = [];
  if (hits > 4) issues.push("keyword_stuffed");
  const freq = new Map<string, number>();
  for (const w of t.split(/\s+/)) if (w.length > 4) freq.set(w, (freq.get(w) ?? 0) + 1);
  if ([...freq.values()].some(c => c >= 4)) issues.push("word_repetition");
  return issues;
}

// ── Image analysis (upload time) ─────────────────────────────────────────────────

/**
 * Analyze an image into structured JSON (no copy). Used at upload time so the
 * result can be cached on the draft. Throws CopyError(502) on provider failure.
 */
export async function analyzeImageStructured(args: {
  cfg: ProviderConfig;
  dataUrl: string;
}): Promise<StructuredImageAnalysis> {
  const schema = `{
  "imageSummary": "1-2 sentence description of exactly what is visible",
  "visibleObjects": ["concrete visible objects, e.g. console table, pendant lamp, area rug"],
  "colors": ["dominant colors, e.g. warm wood, cream, sage green"],
  "style": "visual style/mood, e.g. mid-century modern, cozy minimalist",
  "ocrText": "any text visible in the image, or empty string if none",
  "category": "one broad content category, e.g. home-decor, fashion, food, wedding, beauty, travel"
}`;
  const raw = await chatJson({
    key: args.cfg.key,
    baseUrl: args.cfg.baseUrl,
    model: args.cfg.visionModel,
    timeoutMs: 26_000,
    temperature: 0.1,
    extraBody: thinkingExtras(args.cfg.provider, args.cfg.visionModel),
    messages: [
      {
        role: "system",
        content: "You are a precise visual analyst. Describe ONLY what is visible. Do not infer brands, materials, seasons, or demographics unless visibly obvious. Output JSON only.",
      },
      {
        role: "user",
        content: [
          { type: "text", text: `Analyze this image and return STRICT JSON ONLY matching this schema:\n${schema}` },
          { type: "image_url", image_url: { url: args.dataUrl } },
        ],
      },
    ],
  }) as Partial<StructuredImageAnalysis>;

  return {
    imageSummary: typeof raw.imageSummary === "string" ? raw.imageSummary.trim() : "",
    visibleObjects: asStringArray(raw.visibleObjects, 10),
    colors: asStringArray(raw.colors, 8),
    style: typeof raw.style === "string" ? raw.style.trim() : Array.isArray(raw.style) ? asStringArray(raw.style, 3).join(", ") : "",
    ocrText: typeof raw.ocrText === "string" ? raw.ocrText.trim() : "",
    category: typeof raw.category === "string" ? raw.category.trim().toLowerCase() : "",
  };
}

// ── Copy generation ──────────────────────────────────────────────────────────────

/**
 * Shared language + grounding-context guardrail lines, prepended to every copy-writing
 * prompt (fast path, vision fallback, and the keyword-refine pass). category/board/
 * keyword context is sourced from English data (opportunity titles, the Pinterest
 * keyword DB, page/board names) regardless of the user's chosen AI content language —
 * without this instruction the model tends to quote those English phrases verbatim
 * into non-English copy instead of translating the underlying concept. Brand/product/
 * platform names are the deliberate exception (they should never be translated).
 */
export function languageInstructions(language: string | undefined): string[] {
  const lang = language || "en";
  return [
    `Target output language: ${lang}. Write the title, description, altText, and keywords entirely in this language.`,
    "Category, board, and keyword-context values supplied below (including any field named reference_keyword_context) are grounding context ONLY, not text to quote. Translate or naturally paraphrase those concepts into the target language — never copy a raw source-language phrase verbatim into the output. Exception: brand names, product names, platform names, and other proper nouns may stay exactly as originally written.",
  ];
}

/**
 * Grounding-context block for the vision-fallback prompt. Product NAME may stay in its
 * original language (proper noun); category/board/keyword values are English-sourced
 * reference context the model must translate/paraphrase — never quote verbatim (see
 * languageInstructions). Lives here (not in the route) because route files may only
 * export route handlers.
 */
export function buildContextBlock(input: {
  productContext: { title?: string; category?: string };
  pageContext: { title?: string; domain?: string };
  boardContext: { name?: string };
  keywords: string[];
  category?: string;
  /** Picked creative direction — tone/framing guidance only (never quoted verbatim). */
  directionHint?: string;
}): string {
  const lines: string[] = [];
  if (input.productContext.title || input.productContext.category) lines.push(`Product (name may stay as originally written; translate the category concept): ${[input.productContext.title, input.productContext.category].filter(Boolean).join(" — ")}`);
  if (input.directionHint) lines.push(`Creative direction to reflect in tone/framing (guidance only — do not quote): ${input.directionHint}`);
  if (input.boardContext.name) lines.push(`Pinterest board (context only — translate/paraphrase unless it is a proper noun): ${input.boardContext.name}`);
  if (input.pageContext.title || input.pageContext.domain) lines.push(`Destination page (context only): ${[input.pageContext.title, input.pageContext.domain].filter(Boolean).join(" — ")}`);
  if (input.category) lines.push(`Reference keyword context (do not quote verbatim — translate/paraphrase into the target language): ${input.category}`);
  if (input.keywords.length) lines.push(`Related keyword context (do not quote verbatim — translate/paraphrase into the target language): ${input.keywords.slice(0, 8).join(", ")}`);
  return lines.length ? lines.join("\n") : "No extra context provided — rely on the image.";
}

export type CopyLength = "short" | "standard" | "seo-rich";

/** PRD 6.3 length presets. Enforced numerically after generation, not just in prompts. */
export const LENGTH_LIMITS: Record<CopyLength, { title: number; desc: number }> = {
  short:      { title: 50,  desc: 180 },
  standard:   { title: 80,  desc: 300 },
  "seo-rich": { title: 100, desc: 500 },
};

/** Accepts the legacy wire value "detailed" (→ seo-rich) and anything unknown (→ standard). */
export function normalizeCopyLength(raw: string | undefined): CopyLength {
  if (raw === "short" || raw === "seo-rich") return raw;
  if (raw === "detailed") return "seo-rich";
  return "standard";
}

export function lengthInstruction(length: CopyLength | undefined): string {
  const l = length ?? "standard";
  const lim = LENGTH_LIMITS[l];
  if (l === "short") return `Length: concise — title <=${lim.title} chars, description 1 short sentence (<=${lim.desc} chars).`;
  if (l === "seo-rich") return `Length: SEO-rich — title <=${lim.title} chars, description 3-4 sentences (<=${lim.desc} chars) weaving keywords naturally, never stuffed.`;
  return `Length: title <=${lim.title} chars, description 1-3 sentences (<=${lim.desc} chars).`;
}

export type FastPathPromptArgs = {
  analysis: GroundingAnalysis;
  recommendedKeywords: string[];
  /** Picked creative direction — tone/framing guidance only (never quoted verbatim). */
  directionHint?: string;
  boardName?: string;
  category?: string;
  language: string;
  length?: CopyLength;
  mode: "initial" | "regenerate";
  previousCopy?: PreviousCopy;
};

/**
 * Pure prompt builder for the fast (cached-analysis) path — unit-testable without a
 * network call. Kept SHORT — the model call is the latency bottleneck. Only the
 * essentials: compact analysis, up to 8 keywords, and terse rules.
 */
export function buildFastPathPrompt(args: FastPathPromptArgs): string {
  const kws = args.recommendedKeywords.slice(0, 8);
  const compact = {
    summary: args.analysis.imageSummary,
    objects: args.analysis.visibleObjects.slice(0, 8),
    colors: args.analysis.colors.slice(0, 6),
    style: args.analysis.style,
    ...(args.analysis.ocrText ? { text: args.analysis.ocrText } : {}),
    // Renamed from `category` so the model reads it as reference context, not a field
    // to copy — it's often an English opportunity/keyword phrase (see languageInstructions).
    reference_keyword_context: args.analysis.category || args.category || undefined,
  };
  // Ask for ONLY the 3 fields the model must write — fewer output tokens = faster.
  // Tags/keywords are derived downstream from the (already known) recommended
  // keywords + visible objects, so the model never spends tokens generating them.
  return [
    ...languageInstructions(args.language),
    lengthInstruction(args.length),
    `Write Pinterest Pin copy from this image analysis. STRICT JSON only: {"title":"","description":"","altText":""}`,
    `Analysis: ${JSON.stringify(compact)}`,
    args.directionHint ? `Creative direction to reflect in tone/framing (guidance only — do not quote): ${args.directionHint}` : "",
    args.boardName ? `Board (context only — translate/paraphrase unless it is a proper noun): ${args.boardName}` : "",
    kws.length ? `Weave in 2-4 of these keyword CONCEPTS naturally, translated/paraphrased into the target language (they are English-language SEO reference terms, not text to quote verbatim unless the target language is English; skip any that don't fit): ${kws.join(", ")}` : "",
    "Rules: title Pinterest-style <=90 chars (not a keyword list); description 1-3 sentences naming visible details, no keyword-stuffing. Ground everything in the analysis. No generic filler, no invented brands/materials/seasons.",
    args.mode === "regenerate" && args.previousCopy && (args.previousCopy.title || args.previousCopy.description)
      ? `Make it meaningfully different from: ${JSON.stringify(args.previousCopy)}`
      : "",
  ].filter(Boolean).join("\n");
}

/**
 * FAST PATH: write Pinterest copy from a CACHED analysis using a text-only model
 * (no image tokens → much faster than the vision call). Weaves in 2-4 recommended
 * high-search keywords naturally. Throws CopyError(502) on provider failure.
 */
export async function generateCopyFromAnalysis(args: {
  cfg: ProviderConfig;
  analysis: GroundingAnalysis;
  recommendedKeywords: string[];
  directionHint?: string;
  boardName?: string;
  category?: string;
  language: string;
  length?: CopyLength;
  mode: "initial" | "regenerate";
  previousCopy?: PreviousCopy;
}): Promise<VisionResult> {
  const parts = buildFastPathPrompt(args);

  const raw = await chatJson({
    key: args.cfg.key,
    baseUrl: args.cfg.baseUrl,
    model: args.cfg.textModel,
    timeoutMs: 14_000,
    temperature: args.mode === "regenerate" ? 0.85 : 0.5,
    // NOTE: on LinAPI, gemini-2.5-flash "thinking" tokens appear to count against
    // max_tokens, so a tight cap starves the answer (empty output). Keep generous
    // headroom — the cap does not reduce latency here (thinking dominates), it only
    // guards against truncation. See AI_COPY_TEXT_MODEL to swap in a faster model.
    maxTokens: 512,
    extraBody: thinkingExtras(args.cfg.provider, args.cfg.textModel),
    messages: [
      { role: "system", content: "You are an expert Pinterest copywriter. Image-grounded, readable, never keyword-stuff. Output JSON only." },
      { role: "user", content: parts },
    ],
  }) as Partial<VisionResult>;

  const v = normalizeVision(raw);
  // Merge the analysis fields back so the quality gate can check grounding.
  return {
    ...v,
    imageSummary: args.analysis.imageSummary,
    visibleObjects: args.analysis.visibleObjects,
    colors: args.analysis.colors,
    style: args.analysis.style,
  };
}

export type VisionPromptArgs = {
  contextBlock: string;
  language: string;
  mode: "initial" | "regenerate";
  previousCopy?: PreviousCopy;
};

/**
 * Pure prompt builder for the vision-fallback path — unit-testable without a network
 * call (excludes the image data URL, which is appended as a separate content part).
 */
export function buildVisionPrompt(args: VisionPromptArgs): string {
  const schema = `{
  "imageSummary": "1-2 sentence description of exactly what is visible in the image",
  "visibleObjects": ["concrete objects actually visible, e.g. console table, pendant lamp, area rug"],
  "colors": ["dominant colors, e.g. warm wood, cream, sage green"],
  "style": "the visual style/mood, e.g. mid-century modern, cozy minimalist",
  "title": "Pinterest Pin title (max ~90 chars) grounded in the visible scene",
  "description": "Pinterest Pin description (1-3 sentences) that names visible details",
  "altText": "accessible alt text describing the image",
  "keywords": ["natural lowercase Pinterest search phrases, no hashtags"]
}`;
  const rules = [
    "Look at the image carefully. Every field MUST be grounded in what is actually visible.",
    "The title and description MUST reference concrete visible elements (objects, room/scene, colors, or style) — never generic filler.",
    "NEVER output generic phrases like: Home Decor Product Inspiration, Product Inspiration, Use ... as inspiration for a Pinterest look, beautiful ideas for your space, Pinterest-ready idea, Relevant ideas, Save this Pin, or Inspiration 1/2/3.",
    "Do NOT invent brands, materials, prices, seasons, or demographics that are not visibly obvious.",
    "keywords must be lowercase natural search phrases (not hashtags, not camelCase, not dashboard labels).",
  ];
  if (args.mode === "regenerate") {
    rules.push("REGENERATE MODE: produce a meaningfully different title and description from the previous ones below — do not reorder the same words. Keep it grounded in the same image.");
  }
  const promptParts = [
    "Analyze this Pinterest Pin image and write image-grounded copy. Return STRICT JSON ONLY matching this schema:",
    schema,
    "Rules:\n- " + rules.join("\n- "),
    ...languageInstructions(args.language),
    `Additional context:\n${args.contextBlock}`,
  ];
  if (args.mode === "regenerate" && args.previousCopy && (args.previousCopy.title || args.previousCopy.description)) {
    promptParts.push(`Previous copy to AVOID repeating (write something clearly different):\n${JSON.stringify(args.previousCopy, null, 2)}`);
  }
  return promptParts.join("\n\n");
}

/**
 * FALLBACK PATH: single vision call that analyzes the image AND writes copy. Used
 * when no cached analysis is available. Throws CopyError(502) on provider failure.
 */
export async function analyzeAndWriteCopy(args: {
  cfg: ProviderConfig;
  dataUrl: string;
  contextBlock: string;
  language: string;
  mode: "initial" | "regenerate";
  cachedAnalysis?: GroundingAnalysis | null;
  previousCopy?: PreviousCopy;
}): Promise<VisionResult> {
  const promptText = buildVisionPrompt(args);

  const raw = await chatJson({
    key: args.cfg.key,
    baseUrl: args.cfg.baseUrl,
    model: args.cfg.visionModel,
    timeoutMs: 26_000,
    temperature: args.mode === "regenerate" ? 0.85 : 0.4,
    extraBody: thinkingExtras(args.cfg.provider, args.cfg.visionModel),
    messages: [
      { role: "system", content: "You are a precise visual analyst and expert Pinterest copywriter. You describe only what you can see and you write accurate, specific, image-grounded copy. Output JSON only." },
      {
        role: "user",
        content: [
          { type: "text", text: promptText },
          { type: "image_url", image_url: { url: args.dataUrl } },
        ],
      },
    ],
  }) as Partial<VisionResult>;

  return normalizeVision(raw);
}
