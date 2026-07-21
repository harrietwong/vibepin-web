/**
 * POST /api/generate
 *
 * Bridges the Next.js Studio UI to backend/generator.py.
 * Pipes a full JSON payload via stdin so generator.py receives:
 *   - prompt (assembled by frontend, includes product/ref context)
 *   - image_inputs[] (normalized product/reference image inputs, products first)
 *   - style_ref (compat metadata for the selected reference pin)
 *   - product_images[] (compat list of user-selected product images)
 *   - keyword, style, count
 *
 * Response:
 *   { ok: boolean, urls?: string[], errors?: string[], keyword: string }
 */

import { NextRequest, NextResponse } from "next/server";
import { spawn }                     from "child_process";
import path                          from "path";
import os                            from "os";
import crypto                        from "crypto";
import { promises as fs }            from "fs";
import { getUserIdFromBearer, getUserIdFromCookies } from "@/lib/server/authUser";
import { createServerClient }        from "@/lib/supabase";
import { moderatePrompt, type ModerationResult } from "@/lib/server/creem/moderatePrompt";

export const runtime     = "nodejs";
// TEMP 2026-07-10: capped at 300 (Vercel Hobby plan's serverless function limit)
// so this deploy could go out for Pinterest-flow testing — the current Vercel
// team is on Hobby. Revert to 600 once the team is on Pro (which allows up to
// 800s) — a long AI generation run can otherwise be killed by the platform
// before GENERATOR_TIMEOUT_MS (420s below) ever gets a chance to fire.
export const maxDuration = 300;

const FASTAPI_URL  = process.env.FASTAPI_URL  ?? "http://localhost:8000";
const PYTHON_BIN   = process.env.PYTHON_BIN   ?? (process.platform === "win32" ? "py" : "python3");
const GENERATOR_TIMEOUT_MS = Number(process.env.GENERATOR_TIMEOUT_MS ?? 420_000);
const BACKEND_DIR  = process.env.BACKEND_DIR
  ? path.resolve(process.env.BACKEND_DIR)
  : path.resolve(process.cwd(), "..", "backend");
const GENERATOR_SCRIPT = path.join(BACKEND_DIR, "generator.py");
const LOCK_ROOT = process.env.VIBEPIN_GENERATION_LOCK_DIR
  ? path.resolve(process.env.VIBEPIN_GENERATION_LOCK_DIR)
  : path.join(os.tmpdir(), "vibepin-generation-locks");
const MAX_IMAGES_PER_REQUEST = Math.max(1, Math.min(
  process.env.ALLOW_MAX_IMAGES_PER_REQUEST_OVER_4 === "true" ? 99 : 4,
  Number(process.env.MAX_IMAGES_PER_REQUEST ?? 2) || 2,
));
const USER_GENERATION_LOCK_TTL_MS = Number(process.env.USER_GENERATION_LOCK_TTL_MS ?? GENERATOR_TIMEOUT_MS + 60_000);

// ── WP3-P1: DB-as-queue enqueue mode ────────────────────────────────────────────
// See docs/设计/WP3-生图后端迁移设计.md. GENERATION_MODE=worker enqueues a
// generation_jobs row and returns {jobId, slots} immediately; a VPS worker (not this
// process) claims + fulfills it. Unset / "inline" keeps the existing spawn-generator.py
// behavior below completely unchanged (grey-out fallback — this switch does not remove
// the spawn path; that removal is WP3-P3).
const GENERATION_MODE = process.env.GENERATION_MODE ?? "inline";
// A worker is considered dead if its heartbeat row is missing or older than this —
// enqueuing onto a dead worker would create a job nobody will ever claim (a zombie),
// so POST fails honestly with 503 instead.
const WORKER_HEARTBEAT_STALE_MS = Number(process.env.GENERATION_WORKER_HEARTBEAT_STALE_MS ?? 90_000);
const WORKER_STATUS_NAME = process.env.GENERATION_WORKER_STATUS_NAME ?? "generator";

type ResponseMeta = {
  requested_image_count?: number;
  actual_image_count?: number;
  count_clamped?: boolean;
  generation_request_id?: string;
};

// ── FastAPI path (optional — only if server is running) ───────────────────────
async function tryFastAPI(keyword: string, style: string, productUrl?: string) {
  try {
    const health = await fetch(`${FASTAPI_URL}/health`, { signal: AbortSignal.timeout(2000) });
    if (!health.ok) return null;
  } catch {
    return null;
  }
  const url  = productUrl ?? `https://vibepin.app/trend/${encodeURIComponent(keyword)}`;
  const resp = await fetch(`${FASTAPI_URL}/api/tasks`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ product_url: url, style_preset: style }),
    signal:  AbortSignal.timeout(30_000),
  });
  if (!resp.ok) return null;
  const task = await resp.json() as { id: string };
  return { ok: true, task_id: task.id, source: "fastapi" as const };
}

// ── Subprocess path: pipe full payload to generator.py via stdin ──────────────
interface GeneratorPayload {
  keyword:            string;
  style:              string;
  count:              number;
  prompt:             string;
  style_ref:          string | null;
  product_images:     string[];
  image_inputs:       Array<{
    role: "product" | "reference";
    order: number;
    sourceUrl: string;
    label?: string;
  }>;
  category:           string;
  // Prompt-enhancer fields (optional — enhancer falls back gracefully when absent)
  text_overlay:       boolean;
  reference_strength: string;
  output_type:        string;
  format:             string;
  product_metadata:   Array<{ title?: string; productUrl?: string }> | null;
  model_key:          string;
  content_language?:  string;
  prompt_mode?:       "legacy" | "creative_direction_v2";
  prompt_version?:    number;
  creative_direction_meta?: Record<string, unknown> | null;
  selectedTags?: Array<{ id: string; label: string; group: string }>;
  primaryFormatTag?: string;
  directionBrief?: string;
  briefManuallyEdited?: boolean;
  inferredCategory?: string;
  selectedOpportunity?: Record<string, unknown> | null;
  productImageCountRequested?: number;
  referenceImageCountRequested?: number;
  outputCount?: number;
  variationMode?: "distinct" | "similar";
  outputVariants?: Array<Record<string, unknown>>;
  requestedImageCount?: number;
  actualImageCount?: number;
  countClamped?: boolean;
  generationRequestId?: string;
  generationOwnerId?: string;
  studioClientId?: string;
  providerMode?: "real" | "mock";
  mockProviderBehavior?: string;
  mockProviderDelayMs?: number;
  mode?: "retry_single_output";
  retryOfOutputId?: unknown;
  retryOutputIndex?: unknown;
}

function clampImageCount(raw: unknown): { requested: number; actual: number; clamped: boolean } {
  const requested = Math.max(1, Math.floor(Number(raw ?? 4) || 4));
  const actual = Math.min(MAX_IMAGES_PER_REQUEST, requested);
  return { requested, actual, clamped: actual !== requested };
}

function safeLockName(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

async function removeDirSafe(dir: string) {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

async function acquireTtlLock(kind: string, owner: string, ttlMs: number): Promise<{ acquired: boolean; release: () => Promise<void>; path: string }> {
  const dir = path.join(LOCK_ROOT, kind, safeLockName(owner));
  const now = Date.now();
  await fs.mkdir(path.dirname(dir), { recursive: true });
  try {
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, "owner.json"), JSON.stringify({ kind, owner, acquiredAt: now, expiresAt: now + ttlMs }, null, 2), "utf8");
    return { acquired: true, path: dir, release: () => removeDirSafe(dir) };
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EEXIST") throw err;
    try {
      const raw = await fs.readFile(path.join(dir, "owner.json"), "utf8");
      const meta = JSON.parse(raw) as { expiresAt?: number };
      const expiresAt = Number(meta.expiresAt ?? 0);
      if (expiresAt && expiresAt < now) {
        await removeDirSafe(dir);
        return acquireTtlLock(kind, owner, ttlMs);
      }
    } catch {
      const stat = await fs.stat(dir).catch(() => null);
      if (!stat || now - stat.mtimeMs > ttlMs) {
        await removeDirSafe(dir);
        return acquireTtlLock(kind, owner, ttlMs);
      }
    }
    return { acquired: false, path: dir, release: async () => {} };
  }
}

function requestFallbackIdentity(req: NextRequest, body: Record<string, unknown>): string {
  const clientId = String(body.studioClientId ?? "").trim();
  if (clientId) return `session:${clientId}`;
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "";
  const ua = req.headers.get("user-agent") ?? "";
  return `anon:${safeLockName(`${forwarded}|${ua}`).slice(0, 24)}`;
}

/**
 * Resolve the authenticated user ONCE per request. Called at the very top of the
 * handler so authentication precedes any outbound moderation call; the result is
 * threaded through both the worker enqueue path and the inline lock owner, so
 * auth is never parsed twice (and a request never pays for two token
 * verifications).
 *
 * Honours the same `ALLOW_GENERATION_AUTH_TEST_HEADER` seam the lock owner used,
 * so tests can present a deterministic user without a live Supabase session. The
 * seam is gated on an env flag that production never sets.
 */
async function resolveAuthenticatedUserId(req: NextRequest): Promise<string | null> {
  if (process.env.ALLOW_GENERATION_AUTH_TEST_HEADER === "true") {
    const testUserId = req.headers.get("x-vibepin-test-user-id")?.trim();
    if (testUserId) return testUserId;
  }
  const bearerUser = await getUserIdFromBearer(req).catch(() => null);
  if (bearerUser) return bearerUser;
  return getUserIdFromCookies().catch(() => null);
}

/**
 * Lock owner for the inline path. Takes the ALREADY-RESOLVED user id (see
 * resolveAuthenticatedUserId) rather than re-parsing auth. Anonymous callers keep
 * their historical `session:`/`anon:` fallback identity — the inline path has
 * always allowed them, and the lock is what bounds their concurrency.
 */
function resolveGenerationOwner(req: NextRequest, body: Record<string, unknown>, userId: string | null): string {
  return userId ? `user:${userId}` : requestFallbackIdentity(req, body);
}

function buildImageInputs(productImages: string[], styleRef: string | null): GeneratorPayload["image_inputs"] {
  return [
    ...productImages.map((sourceUrl, index) => ({
      role: "product" as const,
      order: index + 1,
      sourceUrl,
      label: `Product image ${index + 1}`,
    })),
    ...(styleRef ? [{
      role: "reference" as const,
      order: productImages.length + 1,
      sourceUrl: styleRef,
      label: "Reference image 1",
    }] : []),
  ];
}

// ── Prompt moderation gate (Creem AI-compliance) ──────────────────────────────
// The moderated text is the concatenation of the USER-CONTROLLED fields on the
// request. The Python enhancer only rewrites this text into a technical prompt —
// it introduces NO new user intent — so moderating the originals at the route
// entry is correct and sufficient. This is the ONE HTTP chokepoint every
// generation path flows through (single, batch, retry, AiVersions, and the
// Python chat fallback all sit behind this route), so a single gate here covers
// all of them.
export type ModeratedFields = {
  keyword: string;
  prompt: string;
  directionBrief: string;
  category: string;
  selectedTags: Array<{ label?: string }>;
  productMetadata?: Array<{ title?: string }> | null;
};

export function buildModeratedText(fields: ModeratedFields): string {
  return [
    fields.keyword,
    fields.prompt,
    fields.directionBrief,
    fields.category,
    ...fields.selectedTags.map(t => t?.label ?? ""),
    ...(fields.productMetadata ?? []).map(p => p?.title ?? ""),
  ]
    .filter(Boolean)
    .join("\n");
}

// ── Per-field checks (context-dilution fix) ───────────────────────────────────
// Moderating ONLY the joined text is exploitable: measured against the live
// Creem endpoint, a violent prompt that is denied on its own is ALLOWED once
// benign context (a keyword, a category, tag labels) is prepended — the added
// context dilutes the signal. Creem's guidance is to moderate raw user input,
// so every free-text field is now screened INDIVIDUALLY with its raw value —
// no prefixes, no labels, no sibling field's text — and the composite check is
// kept ON TOP to still catch intent split across fields. Both layers must pass.
//
// `category` and `selectedTags[].label` are chosen from a hard-coded UI
// catalogue (creativeDirections.ts CategoryPlaybookId / creativeControls.ts
// CATEGORY_TAGS), but this route does NOT whitelist them server-side — both are
// taken straight off the body (`String(body.category)`, a blind cast for
// selectedTags), so a caller hitting the HTTP API directly can put arbitrary
// text in either. They are therefore screened individually too: the
// fixed-option exemption only holds where the server actually enforces it.
// `product_metadata[].title` is likewise DB-derived in the UI but unchecked on
// the wire, so it is screened as well.
//
// The `externalId` suffix is content-free (`:keyword`, `:prompt`, `:direction`,
// `:category`, `:tag1`, `:product1`, `:composite`) so logs stay text-free while
// remaining attributable to a check.
// ── Input bounds (request amplification fix) ──────────────────────────────────
// Every free-text field becomes its own OUTBOUND Creem moderation call, so an
// unbounded array on the wire is an amplification primitive: 10,000 tags = 10,000
// paid third-party calls from one request. The route previously blind-cast
// `selectedTags` and `product_metadata` with no length or structure validation.
//
// Each cap below is DERIVED from an existing UI/product constraint, with modest
// headroom so a legitimate maximum request never trips it:
//
//   KEYWORD 200          — `keyword` is a Pinterest search phrase sourced from
//                          trend_keywords.keyword (schema.sql:12, unbounded
//                          `text`); real values are a few words. 200 is far above
//                          any observed value and far below an abuse payload.
//   PROMPT 4000          — `prompt` is the machine-assembled hidden prompt
//                          (studio/hiddenPromptBuilder.ts): ~10 fixed sections
//                          plus directionBrief (≤1200) + customInstructions
//                          (≤600) + product titles. 4000 covers the largest
//                          assembly with room to spare.
//   CATEGORY 64          — CategoryPlaybookId is an 8-value closed catalogue
//                          (studio/creativeDirections.ts:87-95); the longest is
//                          "digital-products" (16 chars). 64 = 4x headroom for
//                          the raw DB category that can also arrive here.
//   DIRECTION_BRIEF 1200 — the UI's own hard cap
//                          (CreativeDirectionPanel.tsx:281 slice(0,1200), counter
//                          at :313). Sibling brief inputs cap lower (600, 800).
//   TAG_LABEL 64         — CATEGORY_TAGS (studio/creativeControls.ts:101-183)
//                          longest label is "Street-style outfit" (19 chars).
//                          64 = 3x headroom.
//   TAGS 24              — the largest category set is `fashion` with 16 tags
//                          (creativeControls.ts:102-119) and the format group is
//                          single-select (toggleTagSelection, :229-239), so at
//                          most 13 can be selected at once. 24 is ~2x that.
//   PRODUCT_TITLE 300    — product title columns are unbounded `text`
//                          (migrate_v22.sql:152, schema.sql:100); the nearest UI
//                          title cap in the repo is 100 (StudioBoard.tsx:196,
//                          maxLength={100} pin-title inputs). 300 = 3x that.
//   PRODUCTS 24          — no selection cap exists; the evidenced ceilings are 4
//                          (basket prefill, studio/page.tsx:2267) and 20 per bulk
//                          URL paste (InlineCreateAssetPicker.tsx:790). 24 lets a
//                          full 20-URL paste through with headroom.
//
// Over a limit → 400 invalid_request. We deliberately do NOT truncate and
// proceed: silently dropping fields would moderate less text than the user
// actually submitted, which is exactly the dilution failure the per-field gate
// exists to prevent.
export const INPUT_LIMITS = {
  KEYWORD: 200,
  PROMPT: 4000,
  CATEGORY: 64,
  DIRECTION_BRIEF: 1200,
  TAG_LABEL: 64,
  TAG_ID: 128,
  TAG_GROUP: 64,
  TAGS: 24,
  PRODUCT_TITLE: 300,
  PRODUCT_URL: 2048,
  PRODUCTS: 24,
} as const;

// Absolute ceiling on outbound moderation calls for ONE request. Derived from
// the caps above — the maximum legitimate check list is:
//   keyword + prompt + direction + category   =  4
//   selectedTags                              = 24  (INPUT_LIMITS.TAGS)
//   product_metadata                          = 24  (INPUT_LIMITS.PRODUCTS)
//   composite                                 =  1
//                                             = 53
// 56 leaves a small margin without meaningfully widening the blast radius. This
// is a HARD backstop, checked after the list is built and before ANY call is
// issued: over the ceiling → 400 with ZERO outbound requests. It is never used to
// truncate the list, and a partial batch is never fired — a bounded-but-wrong
// request must fail loudly rather than be silently screened in part.
export const MAX_MODERATION_CHECKS = 56;

function invalidRequestResponse(generationRequestId: string, detail: string): NextResponse {
  return NextResponse.json(
    {
      ok: false,
      error_type: "invalid_request",
      code: "invalid_request",
      error: `This request could not be processed: ${detail}. Please reduce the size of your request and try again.`,
      urls: [],
      generation_request_id: generationRequestId,
    },
    { status: 400 },
  );
}

/** A plain object — not null, not an array, not a boxed primitive. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type InputValidation =
  | { ok: true; selectedTags: Array<{ id: string; label: string; group: string }>; productMetadata: Array<{ title?: string; productUrl?: string }> | null }
  | { ok: false; detail: string };

/**
 * Validate and bound every user-controlled field that feeds the moderation gate,
 * BEFORE the check list is built. Replaces the previous blind `as` casts on
 * `selectedTags` / `product_metadata` with real structural validation: each entry
 * must be a plain object (arrays / null / primitives rejected) whose text fields
 * are strings within their caps.
 *
 * Exported so the bound can be unit-tested without driving the whole handler.
 */
export function validateGenerationInput(raw: {
  keyword: string;
  prompt: string;
  directionBrief: string;
  category: string;
  selectedTags: unknown;
  productMetadata: unknown;
}): InputValidation {
  const tooLong = (name: string, value: string, max: number) =>
    value.length > max ? `${name} exceeds the maximum length of ${max} characters` : null;

  const scalarError =
    tooLong("keyword", raw.keyword, INPUT_LIMITS.KEYWORD) ??
    tooLong("prompt", raw.prompt, INPUT_LIMITS.PROMPT) ??
    tooLong("directionBrief", raw.directionBrief, INPUT_LIMITS.DIRECTION_BRIEF) ??
    tooLong("category", raw.category, INPUT_LIMITS.CATEGORY);
  if (scalarError) return { ok: false, detail: scalarError };

  // selectedTags: absent → []. Present but not an array → reject (a blind cast
  // previously turned `{}` or a string into an empty list silently).
  let selectedTags: Array<{ id: string; label: string; group: string }> = [];
  if (raw.selectedTags !== undefined && raw.selectedTags !== null) {
    if (!Array.isArray(raw.selectedTags)) return { ok: false, detail: "selectedTags must be an array" };
    if (raw.selectedTags.length > INPUT_LIMITS.TAGS) {
      return { ok: false, detail: `selectedTags exceeds the maximum of ${INPUT_LIMITS.TAGS} tags` };
    }
    const validated: Array<{ id: string; label: string; group: string }> = [];
    for (let i = 0; i < raw.selectedTags.length; i++) {
      const entry = raw.selectedTags[i] as unknown;
      if (!isPlainObject(entry)) return { ok: false, detail: `selectedTags[${i}] must be an object` };
      const { id, label, group } = entry;
      if (id !== undefined && typeof id !== "string") return { ok: false, detail: `selectedTags[${i}].id must be a string` };
      if (label !== undefined && typeof label !== "string") return { ok: false, detail: `selectedTags[${i}].label must be a string` };
      if (group !== undefined && typeof group !== "string") return { ok: false, detail: `selectedTags[${i}].group must be a string` };
      const idStr = (id as string | undefined) ?? "";
      const labelStr = (label as string | undefined) ?? "";
      const groupStr = (group as string | undefined) ?? "";
      if (idStr.length > INPUT_LIMITS.TAG_ID) return { ok: false, detail: `selectedTags[${i}].id exceeds the maximum length of ${INPUT_LIMITS.TAG_ID} characters` };
      if (labelStr.length > INPUT_LIMITS.TAG_LABEL) return { ok: false, detail: `selectedTags[${i}].label exceeds the maximum length of ${INPUT_LIMITS.TAG_LABEL} characters` };
      if (groupStr.length > INPUT_LIMITS.TAG_GROUP) return { ok: false, detail: `selectedTags[${i}].group exceeds the maximum length of ${INPUT_LIMITS.TAG_GROUP} characters` };
      validated.push({ id: idStr, label: labelStr, group: groupStr });
    }
    selectedTags = validated;
  }

  // product_metadata: absent / non-array → null (matches the previous shape so
  // the generator payload is unchanged), but a PRESENT array is fully validated.
  let productMetadata: Array<{ title?: string; productUrl?: string }> | null = null;
  if (Array.isArray(raw.productMetadata)) {
    if (raw.productMetadata.length > INPUT_LIMITS.PRODUCTS) {
      return { ok: false, detail: `product_metadata exceeds the maximum of ${INPUT_LIMITS.PRODUCTS} products` };
    }
    const validated: Array<{ title?: string; productUrl?: string }> = [];
    for (let i = 0; i < raw.productMetadata.length; i++) {
      const entry = raw.productMetadata[i] as unknown;
      if (!isPlainObject(entry)) return { ok: false, detail: `product_metadata[${i}] must be an object` };
      const { title, productUrl } = entry;
      if (title !== undefined && typeof title !== "string") return { ok: false, detail: `product_metadata[${i}].title must be a string` };
      if (productUrl !== undefined && typeof productUrl !== "string") return { ok: false, detail: `product_metadata[${i}].productUrl must be a string` };
      if (typeof title === "string" && title.length > INPUT_LIMITS.PRODUCT_TITLE) {
        return { ok: false, detail: `product_metadata[${i}].title exceeds the maximum length of ${INPUT_LIMITS.PRODUCT_TITLE} characters` };
      }
      if (typeof productUrl === "string" && productUrl.length > INPUT_LIMITS.PRODUCT_URL) {
        return { ok: false, detail: `product_metadata[${i}].productUrl exceeds the maximum length of ${INPUT_LIMITS.PRODUCT_URL} characters` };
      }
      validated.push({
        ...(title !== undefined ? { title: title as string } : {}),
        ...(productUrl !== undefined ? { productUrl: productUrl as string } : {}),
      });
    }
    productMetadata = validated;
  }

  return { ok: true, selectedTags, productMetadata };
}

export function buildModerationChecks(fields: ModeratedFields): Array<{ suffix: string; text: string }> {
  const checks: Array<{ suffix: string; text: string }> = [];
  const push = (suffix: string, raw: string) => {
    if (raw.trim()) checks.push({ suffix, text: raw });
  };

  push("keyword", fields.keyword);
  push("prompt", fields.prompt);
  push("direction", fields.directionBrief);
  push("category", fields.category);
  fields.selectedTags.forEach((t, i) => push(`tag${i + 1}`, t?.label ?? ""));
  (fields.productMetadata ?? []).forEach((p, i) => push(`product${i + 1}`, p?.title ?? ""));

  // Composite last: catches intent that is only harmful once the fields combine.
  push("composite", buildModeratedText(fields));
  return checks;
}

export type ModerationGateOutcome =
  | { proceed: true }
  | { proceed: false; response: NextResponse };

function rejectedResponse(generationRequestId: string): NextResponse {
  return NextResponse.json(
    {
      ok: false,
      error_type: "prompt_rejected",
      code: "prompt_rejected",
      error:
        "This request cannot be processed because it may violate our content policy. Please revise the prompt and try again.",
      urls: [],
      generation_request_id: generationRequestId,
    },
    { status: 400 },
  );
}

function unavailableResponse(generationRequestId: string): NextResponse {
  return NextResponse.json(
    {
      ok: false,
      error_type: "moderation_unavailable",
      code: "moderation_unavailable",
      error:
        "Prompt screening is temporarily unavailable. No generation was started. Please try again later.",
      urls: [],
      generation_request_id: generationRequestId,
    },
    { status: 503 },
  );
}

/**
 * Pure decision helper — maps a ModerationResult to whether the request may
 * proceed and, if not, the exact HTTP response. Exported so the gate can be
 * unit-tested without a live Creem call. On {ok:true} the caller continues to
 * the dispatch branches; anything else STOPS before lock acquisition/dispatch.
 */
export function evaluateModerationForRequest(
  result: ModerationResult,
  generationRequestId: string,
): ModerationGateOutcome {
  if (result.ok) return { proceed: true };
  if (result.reason === "rejected") {
    return { proceed: false, response: rejectedResponse(generationRequestId) };
  }
  return { proceed: false, response: unavailableResponse(generationRequestId) };
}

/**
 * Combine the per-field + composite results under the SAME fail-closed contract
 * as the single-check gate: the request proceeds only when EVERY check allows.
 * `rejected` wins over `unavailable` so a genuinely policy-violating field still
 * reports 400 prompt_rejected even if a sibling check happened to be unreachable.
 * Exported for unit tests.
 */
export function evaluateModerationResults(
  results: ModerationResult[],
  generationRequestId: string,
): ModerationGateOutcome {
  if (results.some(r => !r.ok && r.reason === "rejected")) {
    return { proceed: false, response: rejectedResponse(generationRequestId) };
  }
  if (results.some(r => !r.ok)) {
    return { proceed: false, response: unavailableResponse(generationRequestId) };
  }
  return { proceed: true };
}

function runGenerator(payload: GeneratorPayload, responseMeta: ResponseMeta = {}): Promise<NextResponse> {
  return new Promise((resolve) => {
    const child = spawn(
      PYTHON_BIN,
      [GENERATOR_SCRIPT, "--from-stdin"],
      {
        cwd: BACKEND_DIR,
        env: {
          ...process.env,
          // Force UTF-8 so Python doesn't use the Windows cp936 console encoding
          PYTHONIOENCODING:         "utf-8",
          PYTHONUTF8:               "1",
          // Ensure backend secrets are forwarded even if not in web/.env.local
          LINAPI_KEY:                    process.env.LINAPI_KEY                    ?? "",
          LINAPI_BASE_URL:               process.env.LINAPI_BASE_URL               ?? "https://api.linapi.net/v1",
          LINAPI_IMAGE_MODEL:            process.env.LINAPI_IMAGE_MODEL            ?? "gemini-3.1-flash-image-preview",
          OPENAI_PROMPT_ENHANCER_MODEL:  process.env.OPENAI_PROMPT_ENHANCER_MODEL  ?? "",
          SUPABASE_URL:                  process.env.NEXT_PUBLIC_SUPABASE_URL      ?? "",
          SUPABASE_SERVICE_ROLE_KEY:     process.env.SUPABASE_SERVICE_ROLE_KEY     ?? "",
        },
      }
    );

    // Write JSON payload to stdin and close the pipe (no BOM — plain UTF-8)
    const stdinPayload = JSON.stringify(payload);
    child.stdin?.write(stdinPayload, "utf8");
    child.stdin?.end();

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString("utf8"); });
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString("utf8"); });

    // Catch spawn errors (ENOENT if Python not found, EPERM, etc.)
    child.on("error", (err: Error) => {
      clearTimeout(timeout);
      console.error("[generate] spawn error:", err.message);
      resolve(NextResponse.json(
        { ok: false, error: `Could not start generator.py: ${err.message}`, urls: [] },
        { status: 500 },
      ));
    });

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      resolve(NextResponse.json(
        {
          ok: false,
          error: `Generator timed out after ${Math.round(GENERATOR_TIMEOUT_MS / 1000)} seconds`,
          error_type: "api_server_error",
          urls: [],
        },
        { status: 504 },
      ));
    }, GENERATOR_TIMEOUT_MS);

    child.on("close", (code: number | null) => {
      clearTimeout(timeout);

      // Always flush stderr — this is where generator.py logs API errors, image load failures, etc.
      if (stderr.trim()) {
        const lines = stderr.trim().split("\n");
        lines.forEach(l => console.log("[generator.py stderr]", l));
      }

      if (code !== 0) {
        console.error(`[generate] generator.py exited with code ${code}`);
        resolve(NextResponse.json(
          { ok: false, error: `generator.py exited with code ${code}`, stderr: stderr.slice(0, 1000), urls: [] },
          { status: 500 },
        ));
        return;
      }

      if (!stdout.trim()) {
        console.error("[generate] generator.py produced no stdout");
        resolve(NextResponse.json(
          { ok: false, error: "generator.py produced no output — check terminal for stderr details", urls: [] },
          { status: 500 },
        ));
        return;
      }

      // generator.py writes one JSON line to stdout
      const lastLine = stdout.trim().split("\n").pop() ?? "";
      try {
        const result = JSON.parse(lastLine) as {
          ok: boolean; urls: string[]; errors?: string[] | null; keyword: string; style: string;
          prompt_snapshot?: Record<string, unknown>;
        };
        // Surface generator-level errors as a top-level `error` field so the
        // frontend toast handler (which checks result.error, not result.errors) fires.
        const topError = !result.ok && result.errors?.length
          ? result.errors[0]
          : undefined;
        console.log("[generate]", result.keyword, "→", result.urls?.length ?? 0, "urls", topError ? `| error: ${topError}` : "");
        resolve(NextResponse.json({ ...result, ...responseMeta, error: topError, source: "generator_py" }));
      } catch (parseErr) {
        console.error("[generate] JSON parse failed:", parseErr, "raw stdout:", stdout.slice(0, 500));
        resolve(NextResponse.json(
          { ok: false, error: "Invalid JSON from generator.py — see server terminal for details", raw: stdout.slice(0, 300), urls: [] },
          { status: 500 },
        ));
      }
    });
  });
}

// ── WP3-P1: enqueue path (GENERATION_MODE=worker) ───────────────────────────────
// Contract shared byte-for-byte with the VPS worker (package A): table
// generation_jobs(id, vibepin_user_id, status, params, results, claimed_at,
// worker_heartbeat_at, created_at, updated_at, finished_at) and
// generation_worker_status(name PK, last_seen). See design doc §4-5.
type GenerationJobResult = { slot: number; status: "pending" | "done" | "failed"; imageUrl: string | null; error: string | null };

async function isWorkerHealthy(): Promise<boolean> {
  const db = createServerClient();
  const { data, error } = await db
    .from("generation_worker_status")
    .select("last_seen")
    .eq("name", WORKER_STATUS_NAME)
    .maybeSingle();
  if (error || !data?.last_seen) return false;
  const lastSeenMs = Date.parse(data.last_seen as string);
  if (Number.isNaN(lastSeenMs)) return false;
  return Date.now() - lastSeenMs <= WORKER_HEARTBEAT_STALE_MS;
}

/**
 * Enqueue a generation_jobs row and return immediately (<1s). Honest-failure gate:
 * if the worker's heartbeat is missing/stale we return null WITHOUT inserting a row —
 * inserting anyway would create a job nobody will ever claim (a zombie task).
 */
async function enqueueGenerationJob(
  slotCount: number,
  params: Record<string, unknown>,
  userId: string,
): Promise<{ jobId: string; slots: number } | null> {
  const healthy = await isWorkerHealthy();
  if (!healthy) return null;

  const results: GenerationJobResult[] = Array.from({ length: slotCount }, (_, i) => ({
    slot: i, status: "pending", imageUrl: null, error: null,
  }));

  const db = createServerClient();
  const { data, error } = await db
    .from("generation_jobs")
    .insert({
      vibepin_user_id: userId,
      status: "queued",
      params,
      results,
    })
    .select("id")
    .single();

  if (error || !data?.id) {
    console.error("[generate] enqueue insert failed:", error?.message);
    return null;
  }
  return { jobId: data.id as string, slots: slotCount };
}

// ── Handler ───────────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const keyword            = String(body.keyword       ?? "").trim();
  const style              = String(body.style         ?? "lifestyle");
  // A single-output retry ALWAYS generates exactly one image — never the original
  // batch count — even if the client somehow sent a larger count.
  const isRetrySingleOutput = body.mode === "retry_single_output";
  const imageCountClamp    = clampImageCount(isRetrySingleOutput ? 1 : body.count);
  const count              = isRetrySingleOutput ? 1 : imageCountClamp.actual;
  const prompt             = String(body.prompt        ?? "").trim();
  const category           = String(body.category      ?? "").trim();
  const styleRef           = body.style_ref ? String(body.style_ref) : null;
  const productImages      = Array.isArray(body.product_images)
    ? (body.product_images as unknown[]).map(String).filter(Boolean)
    : [];
  // Prompt-enhancer fields (optional — fall back gracefully in generator.py)
  const textOverlay        = Boolean(body.text_overlay ?? false);
  const referenceStrength  = String(body.reference_strength ?? "moderate");
  const outputType         = String(body.output_type ?? "");
  const pinFormat          = String(body.format ?? "vertical 2:3");
  const modelKey           = String(body.model_key ?? "gemini_image");
  const contentLanguage    = String(body.content_language ?? "en").trim() || "en";
  const promptMode         = body.prompt_mode === "creative_direction_v2" ? "creative_direction_v2" : "legacy";
  const promptVersion      = Number(body.prompt_version ?? (promptMode === "creative_direction_v2" ? 2 : 1));
  const creativeDirectionMeta = body.creative_direction_meta && typeof body.creative_direction_meta === "object"
    ? body.creative_direction_meta as Record<string, unknown>
    : null;
  const primaryFormatTag = String(body.primaryFormatTag ?? "");
  const directionBrief = String(body.directionBrief ?? "");
  const briefManuallyEdited = Boolean(body.briefManuallyEdited ?? false);
  const inferredCategory = String(body.inferredCategory ?? "");
  const selectedOpportunity = body.selectedOpportunity && typeof body.selectedOpportunity === "object"
    ? body.selectedOpportunity as Record<string, unknown>
    : null;
  const productImageCountRequested = Number(body.productImageCountRequested ?? productImages.length);
  const referenceImageCountRequested = Number(body.referenceImageCountRequested ?? (styleRef ? 1 : 0));
  const outputCountRaw = Number(body.outputCount ?? imageCountClamp.requested);
  const outputCount = Math.min(count, Math.max(1, outputCountRaw || count));
  const variationMode = body.variationMode === "similar" ? "similar" : "distinct";
  const outputVariants = Array.isArray(body.outputVariants)
    ? body.outputVariants as Array<Record<string, unknown>>
    : [];
  const generationRequestId = String(body.generationRequestId ?? `gen_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`).trim();
  const studioClientId = String(body.studioClientId ?? "").trim();
  const providerMode = process.env.ALLOW_GENERATION_MOCK_PROVIDER === "true" && body.provider_mode === "mock" ? "mock" : "real";
  const mockProviderBehavior = String(body.mock_provider_behavior ?? "success");
  const mockProviderDelayMs = Math.max(0, Math.min(60_000, Number(body.mock_provider_delay_ms ?? 1500) || 1500));
  const imageInputs = buildImageInputs(productImages, styleRef);

  if (!keyword) {
    return NextResponse.json({ error: "keyword is required" }, { status: 400 });
  }

  // ── Step 1: AUTHENTICATE — before any outbound moderation call ────────────────
  // Moderation is a PAID third-party API. Resolving the user AFTER the moderation
  // batch (as this route previously did, 60 lines later in the worker branch) let
  // an unauthenticated request burn up to N outbound Creem calls before being
  // rejected 401 — request amplification and unauthorized consumption of a paid
  // API in one. The user is resolved ONCE here and the same `userId` is reused by
  // the worker enqueue path below; auth is never re-parsed.
  //
  // NON-WORKER PATHS (inline generator.py / FastAPI): these have always tolerated
  // an anonymous caller — resolveGenerationOwner() falls back to a
  // `session:<studioClientId>` or `anon:<ip+ua hash>` lock owner (see
  // requestFallbackIdentity), which only exists because anonymous requests can
  // reach the inline generator. That is the local-dev / self-hosted shape, so we
  // do NOT break it: an anonymous request still proceeds on those paths, and the
  // `anon:` lock still bounds it to one concurrent generation per browser/IP.
  // GENERATION_MODE=worker is the PRODUCTION setting, and it is now strictly
  // authenticated: 401 before a single moderation call. The bound/validation work
  // below applies to every path, so the anonymous inline path is amplification-
  // capped even though it is not authenticated.
  const authUserId = await resolveAuthenticatedUserId(req);
  if (GENERATION_MODE === "worker" && !authUserId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // ── Step 2: VALIDATE AND BOUND the moderated inputs — still before any call ───
  // Structural + length validation replacing the old blind `as` casts. An
  // over-limit or malformed request is rejected with 400 invalid_request having
  // issued ZERO outbound moderation requests. Never truncates.
  const validated = validateGenerationInput({
    keyword,
    prompt,
    directionBrief,
    category,
    selectedTags: body.selectedTags,
    productMetadata: body.product_metadata,
  });
  if (!validated.ok) {
    return invalidRequestResponse(generationRequestId, validated.detail);
  }
  const selectedTags = validated.selectedTags;
  const productMetadata = validated.productMetadata;

  // ── Step 3: Moderation gate (Creem AI-compliance) — BEFORE both dispatch
  // branches and BEFORE lock acquisition, so a rejected/unscreenable prompt never
  // spawns the generator, never hits FastAPI, and never acquires the per-user
  // lock. Runs for real AND mock-provider requests (mock is about the image
  // provider, not compliance). The moderated text is the user's actual intent;
  // the Python enhancer only rewrites it.
  // Every free-text field is screened on its OWN raw value, plus one composite
  // check over the joined text — see buildModerationChecks. Run in parallel so
  // the added layers cost ~one moderation round-trip, not N.
  const moderationChecks = buildModerationChecks({
    keyword, prompt, directionBrief, category, selectedTags, productMetadata,
  });
  // Hard, unbypassable backstop. Step 2's per-field caps should already make this
  // unreachable; it stands as a second, independent line of defence so that ANY
  // future field added to buildModerationChecks without a matching cap fails
  // closed instead of silently multiplying outbound calls. Zero requests are
  // issued when it trips — the list is never truncated and no partial batch fires.
  if (moderationChecks.length > MAX_MODERATION_CHECKS) {
    console.warn(JSON.stringify({
      event: "moderation_check_limit_exceeded",
      generationRequestId,
      checkCount: moderationChecks.length,
      maxChecks: MAX_MODERATION_CHECKS,
    }));
    return invalidRequestResponse(
      generationRequestId,
      `it requires ${moderationChecks.length} content checks, above the maximum of ${MAX_MODERATION_CHECKS}`,
    );
  }
  const moderationResults = await Promise.all(
    moderationChecks.map(check =>
      moderatePrompt({ prompt: check.text, externalId: `${generationRequestId}:${check.suffix}` }),
    ),
  );
  const gate = evaluateModerationResults(moderationResults, generationRequestId);
  if (!gate.proceed) {
    return gate.response;
  }

  console.log(
    `[/api/generate] keyword="${keyword}" count=${count}/${imageCountClamp.requested} style_ref=${styleRef ? "yes" : "no"} ` +
    `product_images=${productImages.length} enhancer_model=${process.env.OPENAI_PROMPT_ENHANCER_MODEL ? "set" : "not set"}`
  );
  console.log(JSON.stringify({
    event: "api_generate_payload_debug",
    productImageCount: productImages.length,
    referenceImageCount: styleRef ? 1 : 0,
    imageOrdering: "image_inputs[] is the provider source of truth: products first, references last",
    imageInputs: imageInputs.map(({ order, role, sourceUrl }) => ({
      order,
      role,
      sourceUrl: sourceUrl.length > 120 ? `${sourceUrl.slice(0, 120)}…` : sourceUrl,
    })),
    productImages: productImages.map((u, i) => ({ index: i + 1, url: u.length > 120 ? `${u.slice(0, 120)}…` : u })),
    references: styleRef ? [{ index: 1, url: styleRef.length > 120 ? `${styleRef.slice(0, 120)}…` : styleRef }] : [],
    promptMode,
    promptVersion,
    category,
    outputType,
    aspectRatio: pinFormat,
    modelKey,
    referenceStrength,
    selectedTags,
    primaryFormatTag,
    directionBrief: directionBrief.slice(0, 500),
    briefManuallyEdited,
    inferredCategory,
    selectedOpportunity,
    productImageCountRequested,
    referenceImageCountRequested,
    requestedImageCount: imageCountClamp.requested,
    actualImageCount: count,
    countClamped: imageCountClamp.clamped,
    outputCount,
    variationMode,
    outputVariants,
    generationRequestId,
    studioClientId: studioClientId ? "set" : "missing",
    maxImagesPerRequest: MAX_IMAGES_PER_REQUEST,
    providerMode,
    mockProviderBehavior: providerMode === "mock" ? mockProviderBehavior : undefined,
    mockProviderDelayMs: providerMode === "mock" ? mockProviderDelayMs : undefined,
  }));

  // Path 0: WP3-P1 worker enqueue (GENERATION_MODE=worker). Short-circuits everything
  // below — the VPS worker fulfills the job, this process never spawns generator.py.
  if (GENERATION_MODE === "worker") {
    // Auth already resolved (and enforced) in Step 1 above — reused, never
    // re-parsed. The `!authUserId` case returned 401 before any moderation call,
    // so this narrowing can only fail if that guard is ever removed.
    const userId = authUserId;
    if (!userId) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const promptWithLangForQueue = contentLanguage !== "en"
      ? `${prompt}\n\n[Important: Generate any on-image text and descriptive copy in ${contentLanguage}. Keep Pinterest-native tone.]`
      : prompt;
    const jobParams: GeneratorPayload = {
      keyword, style, count, prompt: promptWithLangForQueue, style_ref: styleRef, product_images: productImages, image_inputs: imageInputs, category,
      text_overlay: textOverlay, reference_strength: referenceStrength,
      output_type: outputType, format: pinFormat, product_metadata: productMetadata,
      model_key: modelKey, content_language: contentLanguage,
      prompt_mode: promptMode, prompt_version: promptVersion,
      creative_direction_meta: creativeDirectionMeta,
      selectedTags,
      primaryFormatTag,
      directionBrief,
      briefManuallyEdited,
      inferredCategory,
      selectedOpportunity,
      productImageCountRequested,
      referenceImageCountRequested,
      outputCount,
      variationMode,
      outputVariants,
      requestedImageCount: imageCountClamp.requested,
      actualImageCount: count,
      countClamped: imageCountClamp.clamped,
      generationRequestId,
      generationOwnerId: `user:${userId}`,
      studioClientId,
      providerMode,
      mockProviderBehavior,
      mockProviderDelayMs,
      mode: isRetrySingleOutput ? "retry_single_output" : undefined,
      retryOfOutputId: body.retryOfOutputId,
      retryOutputIndex: body.retryOutputIndex,
    };

    const enqueued = await enqueueGenerationJob(count, jobParams as unknown as Record<string, unknown>, userId);
    if (!enqueued) {
      return NextResponse.json({ error: "generation_unavailable" }, { status: 503 });
    }
    console.log(`[/api/generate] enqueued job=${enqueued.jobId} slots=${enqueued.slots} user=${userId}`);
    return NextResponse.json({ jobId: enqueued.jobId, slots: enqueued.slots });
  }

  // Path 1: FastAPI (async task queue — only when server is running)
  const requiresFullPayload = promptMode === "creative_direction_v2" || productImages.length > 0 || !!styleRef;
  if (!requiresFullPayload) {
    const fastapiResult = await tryFastAPI(keyword, style, undefined);
    if (fastapiResult) {
      console.log("[/api/generate] using FastAPI path");
      return NextResponse.json(fastapiResult);
    }
  } else {
    console.log("[/api/generate] skipping FastAPI path — full multimodal payload required");
  }

  // Path 2: generator.py via stdin (full payload including images)
  console.log(`[/api/generate] spawning generator.py — PYTHON_BIN=${PYTHON_BIN} LINAPI_KEY=${process.env.LINAPI_KEY ? "set" : "MISSING"} MODEL=${process.env.LINAPI_IMAGE_MODEL ?? "default"} content_language=${contentLanguage}`);
  const promptWithLang = contentLanguage !== "en"
    ? `${prompt}\n\n[Important: Generate any on-image text and descriptive copy in ${contentLanguage}. Keep Pinterest-native tone.]`
    : prompt;
  const generationOwnerId = resolveGenerationOwner(req, body, authUserId);
  const userLock = await acquireTtlLock("active-generation", generationOwnerId, USER_GENERATION_LOCK_TTL_MS);
  if (!userLock.acquired) {
    console.warn(JSON.stringify({
      event: "user_generation_limit",
      generationOwnerId,
      generationRequestId,
      lockPath: userLock.path,
    }));
    return NextResponse.json({
      ok: false,
      error: "A generation is already running for this account or browser session. Wait for it to finish, then try again.",
      error_type: "user_generation_limit",
      urls: [],
      requested_image_count: imageCountClamp.requested,
      actual_image_count: count,
      count_clamped: imageCountClamp.clamped,
      generation_request_id: generationRequestId,
    }, { status: 429 });
  }

  try {
    return await runGenerator({
      keyword, style, count, prompt: promptWithLang, style_ref: styleRef, product_images: productImages, image_inputs: imageInputs, category,
      text_overlay: textOverlay, reference_strength: referenceStrength,
      output_type: outputType, format: pinFormat, product_metadata: productMetadata,
      model_key: modelKey, content_language: contentLanguage,
      prompt_mode: promptMode, prompt_version: promptVersion,
      creative_direction_meta: creativeDirectionMeta,
      selectedTags,
      primaryFormatTag,
      directionBrief,
      briefManuallyEdited,
      inferredCategory,
      selectedOpportunity,
      productImageCountRequested,
      referenceImageCountRequested,
      outputCount,
      variationMode,
      outputVariants,
      requestedImageCount: imageCountClamp.requested,
      actualImageCount: count,
      countClamped: imageCountClamp.clamped,
      generationRequestId,
      generationOwnerId,
      studioClientId,
      providerMode,
      mockProviderBehavior,
      mockProviderDelayMs,
      mode: isRetrySingleOutput ? "retry_single_output" : undefined,
      retryOfOutputId: body.retryOfOutputId,
      retryOutputIndex: body.retryOutputIndex,
    }, {
      requested_image_count: imageCountClamp.requested,
      actual_image_count: count,
      count_clamped: imageCountClamp.clamped,
      generation_request_id: generationRequestId,
    });
  } finally {
    await userLock.release();
  }
}
