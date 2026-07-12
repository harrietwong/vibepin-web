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

async function resolveGenerationOwner(req: NextRequest, body: Record<string, unknown>): Promise<string> {
  if (process.env.ALLOW_GENERATION_AUTH_TEST_HEADER === "true") {
    const testUserId = req.headers.get("x-vibepin-test-user-id")?.trim();
    if (testUserId) return `user:${testUserId}`;
  }
  const bearerUser = await getUserIdFromBearer(req).catch(() => null);
  const cookieUser = bearerUser ? null : await getUserIdFromCookies().catch(() => null);
  const userId = bearerUser ?? cookieUser;
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
  const productMetadata    = Array.isArray(body.product_metadata)
    ? (body.product_metadata as Array<{ title?: string; productUrl?: string }>)
    : null;
  const modelKey           = String(body.model_key ?? "gemini_image");
  const contentLanguage    = String(body.content_language ?? "en").trim() || "en";
  const promptMode         = body.prompt_mode === "creative_direction_v2" ? "creative_direction_v2" : "legacy";
  const promptVersion      = Number(body.prompt_version ?? (promptMode === "creative_direction_v2" ? 2 : 1));
  const creativeDirectionMeta = body.creative_direction_meta && typeof body.creative_direction_meta === "object"
    ? body.creative_direction_meta as Record<string, unknown>
    : null;
  const selectedTags = Array.isArray(body.selectedTags)
    ? body.selectedTags as Array<{ id: string; label: string; group: string }>
    : [];
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
  const generationOwnerId = await resolveGenerationOwner(req, body);
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
