/**
 * POST /api/generate
 *
 * Bridges the Next.js Studio UI to backend/generator.py.
 * Pipes a full JSON payload via stdin so generator.py receives:
 *   - prompt (assembled by frontend, includes product/ref context)
 *   - style_ref (URL or base64 data URL of the selected reference pin)
 *   - product_images[] (base64 data URLs of user-uploaded product images)
 *   - keyword, style, count
 *
 * Response:
 *   { ok: boolean, urls?: string[], errors?: string[], keyword: string }
 */

import { NextRequest, NextResponse } from "next/server";
import { spawn }                     from "child_process";
import path                          from "path";

export const runtime     = "nodejs";
export const maxDuration = 300;

const FASTAPI_URL  = process.env.FASTAPI_URL  ?? "http://localhost:8000";
const PYTHON_BIN   = process.env.PYTHON_BIN   ?? (process.platform === "win32" ? "py" : "python3");
const BACKEND_DIR  = process.env.BACKEND_DIR
  ? path.resolve(process.env.BACKEND_DIR)
  : path.resolve(process.cwd(), "..", "backend");
const GENERATOR_SCRIPT = path.join(BACKEND_DIR, "generator.py");

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
  keyword:        string;
  style:          string;
  count:          number;
  prompt:         string;
  style_ref:      string | null;
  product_images: string[];
  category:       string;
}

function runGenerator(payload: GeneratorPayload): Promise<NextResponse> {
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
          LINAPI_KEY:               process.env.LINAPI_KEY               ?? "",
          LINAPI_BASE_URL:          process.env.LINAPI_BASE_URL          ?? "https://api.linapi.net/v1",
          LINAPI_IMAGE_MODEL:       process.env.LINAPI_IMAGE_MODEL       ?? "gemini-3.1-flash-image-preview",
          SUPABASE_URL:             process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
          SUPABASE_SERVICE_ROLE_KEY:process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
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
        { ok: false, error: "Generator timed out after 240 seconds", urls: [] },
        { status: 504 },
      ));
    }, 240_000);

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
        };
        // Surface generator-level errors as a top-level `error` field so the
        // frontend toast handler (which checks result.error, not result.errors) fires.
        const topError = !result.ok && result.errors?.length
          ? result.errors[0]
          : undefined;
        console.log("[generate]", result.keyword, "→", result.urls?.length ?? 0, "urls", topError ? `| error: ${topError}` : "");
        resolve(NextResponse.json({ ...result, error: topError, source: "generator_py" }));
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

  const keyword       = String(body.keyword       ?? "").trim();
  const style         = String(body.style         ?? "lifestyle");
  const count         = Math.min(8, Math.max(1, Number(body.count ?? 4)));
  const prompt        = String(body.prompt        ?? "").trim();
  const category      = String(body.category      ?? "").trim();
  const styleRef      = body.style_ref ? String(body.style_ref) : null;
  const productImages = Array.isArray(body.product_images)
    ? (body.product_images as unknown[]).map(String).filter(Boolean)
    : [];

  if (!keyword) {
    return NextResponse.json({ error: "keyword is required" }, { status: 400 });
  }

  console.log(`[/api/generate] keyword="${keyword}" count=${count} style_ref=${styleRef ? "yes" : "no"} product_images=${productImages.length} prompt_len=${prompt.length}`);

  // Path 1: FastAPI (async task queue — only when server is running)
  const fastapiResult = await tryFastAPI(keyword, style, undefined);
  if (fastapiResult) {
    console.log("[/api/generate] using FastAPI path");
    return NextResponse.json(fastapiResult);
  }

  // Path 2: generator.py via stdin (full payload including images)
  console.log(`[/api/generate] spawning generator.py — PYTHON_BIN=${PYTHON_BIN} LINAPI_KEY=${process.env.LINAPI_KEY ? "set" : "MISSING"} MODEL=${process.env.LINAPI_IMAGE_MODEL ?? "default"}`);
  return runGenerator({ keyword, style, count, prompt, style_ref: styleRef, product_images: productImages, category });
}
