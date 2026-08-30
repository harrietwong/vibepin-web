/**
 * Generation production-log privacy sentinels.
 * Run: npx tsx scripts/test-generation-log-privacy.ts
 *
 * Runtime sentinels are the primary contract: known secret-shaped values travel
 * through the real route, generator, enhancer and worker sanitizer, then captured
 * logs/results are checked for the exact raw values. Hashes, counts, status, model,
 * latency and classified/generic errors remain free implementation choices.
 * Narrow call-local source checks remain only as defence in depth.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
process.env.ALLOW_GENERATION_MOCK_PROVIDER = "true";
process.env.MODERATION_MOCK_DECISION = "allow";
process.env.FASTAPI_URL = "http://127.0.0.1:1";

export {};

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { Module } from "node:module";

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed++;
    console.log(`  ✗ ${name}\n      ${(error as Error).message}`);
  }
}

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
}

function assertNoRawValues(output: string, values: readonly string[], context: string) {
  for (const value of values) {
    if (output.includes(value)) {
      throw new Error(`${context} contains raw sentinel ${JSON.stringify(value)}`);
    }
  }
}

function read(relativePath: string): string {
  return fs.readFileSync(path.resolve(__dirname, relativePath), "utf8");
}

const SENTINELS = {
  keyword: "VP_SECRET_KEYWORD_7F41",
  prompt: "VP_SECRET_PROMPT_2D93",
  category: "VP_SECRET_CATEGORY_4C18",
  directionBrief: "VP_SECRET_DIRECTION_8A26",
  selectedTag: "VP_SECRET_TAG_B157",
  selectedOpportunity: "VP_SECRET_OPPORTUNITY_C204",
  outputVariant: "VP_SECRET_VARIANT_91E3",
  productUrl: "http://127.0.0.1:1/VP_SECRET_PRODUCT_URL?token=prod_6e0f",
  referenceUrl: "http://127.0.0.1:1/VP_SECRET_REFERENCE_URL?token=ref_1ac9",
  userId: "11111111-1111-4111-8111-111111111111",
  providerBody: "VP_SECRET_PROVIDER_BODY_5B72",
} as const;

const ROUTE_RAW_VALUES = Object.values(SENTINELS);
const GENERATOR_RAW_VALUES = [
  SENTINELS.keyword,
  SENTINELS.prompt,
  SENTINELS.category,
  SENTINELS.directionBrief,
  SENTINELS.selectedTag,
  SENTINELS.outputVariant,
  SENTINELS.productUrl,
  SENTINELS.referenceUrl,
] as const;

function fakeServerClient() {
  return {
    from() {
      return {
        insert() {
          return {
            select() {
              return {
                single: async () => ({
                  data: { id: "job_privacy", vibepin_user_id: SENTINELS.userId, status: "pending" },
                  error: null,
                }),
              };
            },
          };
        },
        select() {
          return {
            eq() {
              return {
                maybeSingle: async () => ({ data: { name: "generation-worker", last_seen: new Date().toISOString() }, error: null }),
                single: async () => ({ data: { name: "generation-worker", last_seen: new Date().toISOString() }, error: null }),
              };
            },
          };
        },
      };
    },
  };
}

function fakeSpawn() {
  const child = new EventEmitter() as EventEmitter & {
    stdin: { write: () => void; end: () => void };
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: () => void;
  };
  child.stdin = { write: () => {}, end: () => {} };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  setImmediate(() => {
    child.stderr.emit("data", Buffer.from(`${SENTINELS.providerBody}\n`));
    child.stdout.emit("data", Buffer.from(`${JSON.stringify({
      ok: false,
      keyword: SENTINELS.keyword,
      urls: [],
      errors: [SENTINELS.providerBody],
    })}\n`));
    child.emit("close", 0);
  });
  return child;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const originalLoad = (Module as any)._load;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(Module as any)._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === "child_process") {
    const real = originalLoad.call(this, request, parent, isMain);
    return { ...real, spawn: fakeSpawn };
  }
  if (request === "@/lib/supabase" || /[\\/]lib[\\/]supabase(\.ts)?$/.test(request)) {
    return { createServerClient: fakeServerClient };
  }
  if (request === "@/lib/server/authUser" || /[\\/]server[\\/]authUser(\.ts)?$/.test(request)) {
    const verified = async () => SENTINELS.userId;
    return {
      getUserIdFromBearer: async () => null,
      getUserIdFromCookies: verified,
      getUserIdFromBearerOrCookies: verified,
      getUserIdFromCookieSession: async () => null,
      getUserIdFromSameOriginSession: async () => null,
    };
  }
  if (request === "@/lib/server/creem/moderatePrompt" || /[\\/]creem[\\/]moderatePrompt(\.ts)?$/.test(request)) {
    return { moderatePrompt: async () => ({ ok: true }) };
  }
  if (request === "@/lib/server/rateLimit" || /[\\/]server[\\/]rateLimit(\.ts)?$/.test(request)) {
    return {
      consumeRateLimit: async () => ({ allowed: true, reason: "under_limit", remaining: 39 }),
      RATE_LIMITED_ERROR: "rate_limited",
      RATE_LIMITED_MESSAGE: "Too many requests",
    };
  }
  if (request === "@/lib/server/entitlements" || /[\\/]server[\\/]entitlements(\.ts)?$/.test(request)) {
    return { resolvePlan: async () => "pro" };
  }
  if (request === "@/lib/server/usage" || /[\\/]server[\\/]usage(?:[\\/]index)?(\.ts)?$/.test(request)) {
    return {
      checkAllowance: async () => ({ allowed: true, plan: "pro", limit: 100, used: 0, remaining: 100 }),
      recordUsage: async () => undefined,
    };
  }
  if (request === "@/lib/server/aiCostLog" || /[\\/]server[\\/]aiCostLog(\.ts)?$/.test(request)) {
    return { recordAiCost: async () => ({ recorded: true }), estimateCost: () => null };
  }
  if (request === "@/lib/server/usage/meterGeneration" || /[\\/]usage[\\/]meterGeneration(\.ts)?$/.test(request)) {
    return {
      usageMeteringMode: () => "off",
      reserveGenerationJobViaLedger: async () => ({ kind: "off" }),
      reserveInline: async () => ({ kind: "off" }),
      settleInline: async () => undefined,
      releaseInline: async () => undefined,
      aiImageLimitResponseBody: () => ({ error: "limit_reached" }),
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

type ConsoleMethod = "log" | "warn" | "error" | "info" | "debug";
const CONSOLE_METHODS: readonly ConsoleMethod[] = ["log", "warn", "error", "info", "debug"];

function printable(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

async function captureConsole(fn: () => Promise<void>): Promise<string> {
  const originals = new Map<ConsoleMethod, (...args: unknown[]) => void>();
  const lines: string[] = [];
  for (const method of CONSOLE_METHODS) {
    originals.set(method, console[method]);
    console[method] = (...args: unknown[]) => { lines.push(args.map(printable).join(" ")); };
  }
  try {
    await fn();
  } finally {
    for (const method of CONSOLE_METHODS) console[method] = originals.get(method)!;
  }
  return lines.join("\n");
}

function routeBody(): Record<string, unknown> {
  return {
    keyword: SENTINELS.keyword,
    prompt: SENTINELS.prompt,
    category: SENTINELS.category,
    directionBrief: SENTINELS.directionBrief,
    selectedTags: [{ id: "privacy-tag", label: SENTINELS.selectedTag, group: "mood" }],
    selectedOpportunity: { label: SENTINELS.selectedOpportunity },
    outputVariants: [{ role: SENTINELS.outputVariant }],
    product_images: [SENTINELS.productUrl],
    style_ref: SENTINELS.referenceUrl,
    prompt_mode: "creative_direction_v2",
    provider_mode: "mock",
    model_key: "gemini_image",
    count: 1,
    generationRequestId: "gen_privacy_sentinel",
  };
}

async function runRoute(mode: "inline" | "worker"): Promise<void> {
  const mutableEnv = process.env as unknown as Record<string, string | undefined>;
  const previousNodeEnv = mutableEnv.NODE_ENV;
  const previousMode = mutableEnv.GENERATION_MODE;
  const previousTestHeader = mutableEnv.ALLOW_GENERATION_AUTH_TEST_HEADER;
  mutableEnv.NODE_ENV = "production";
  mutableEnv.GENERATION_MODE = mode;
  delete mutableEnv.ALLOW_GENERATION_AUTH_TEST_HEADER;
  try {
    const routePath = require.resolve("../src/app/api/generate/route");
    delete require.cache[routePath];
    const route = await import(`../src/app/api/generate/route?privacy=${mode}_${Math.random()}`);
    await route.POST(new Request("https://vibepin.co/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(routeBody()),
    }) as never);
  } finally {
    if (previousNodeEnv === undefined) delete mutableEnv.NODE_ENV;
    else mutableEnv.NODE_ENV = previousNodeEnv;
    if (previousMode === undefined) delete mutableEnv.GENERATION_MODE;
    else mutableEnv.GENERATION_MODE = previousMode;
    if (previousTestHeader === undefined) delete mutableEnv.ALLOW_GENERATION_AUTH_TEST_HEADER;
    else mutableEnv.ALLOW_GENERATION_AUTH_TEST_HEADER = previousTestHeader;
  }
}

function pythonResult(args: string[], input?: string, extraEnv: Record<string, string> = {}) {
  const python = process.env.PYTHON_BIN || (process.platform === "win32" ? "python" : "python3");
  const result = spawnSync(python, args, {
    cwd: path.resolve(__dirname, "../.."),
    input,
    encoding: "utf8",
    env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1", ...extraEnv },
    timeout: 30_000,
  });
  if (result.error) throw result.error;
  assert(result.status === 0, `python harness exited ${result.status}: ${String(result.stderr).slice(0, 400)}`);
  return { stdout: String(result.stdout), stderr: String(result.stderr) };
}

function extractConsoleCalls(source: string): string[] {
  const calls: string[] = [];
  const startPattern = /console\.(?:log|warn|error|info|debug)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = startPattern.exec(source))) {
    let depth = 1;
    let index = startPattern.lastIndex;
    let quote: "'" | "\"" | "`" | null = null;
    let escaped = false;
    for (; index < source.length && depth > 0; index++) {
      const char = source[index];
      if (quote) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === quote) quote = null;
        continue;
      }
      if (char === "'" || char === "\"" || char === "`") quote = char;
      else if (char === "(") depth++;
      else if (char === ")") depth--;
    }
    calls.push(source.slice(match.index, index));
    startPattern.lastIndex = index;
  }
  return calls;
}

function assertNoLinePattern(source: string, pattern: RegExp, message: string) {
  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    pattern.lastIndex = 0;
    if (pattern.test(lines[index])) throw new Error(`${message} (line ${index + 1})`);
  }
}

const routeSource = read("../src/app/api/generate/route.ts");
const generatorSource = read("../../backend/generator.py");
const workerSource = read("../../api/app/worker.py");

async function main() {
  console.log("\nGeneration production-log privacy sentinels\n");

  await test("route runtime logs contain no raw prompt, URL, uid or provider sentinels", async () => {
    const output = await captureConsole(async () => {
      await runRoute("inline");
      await runRoute("worker");
    });
    assertNoRawValues(output, ROUTE_RAW_VALUES, "route logs");
  });

  await test("generator runtime stderr contains no raw request sentinels", () => {
    const generatorPath = path.resolve(__dirname, "../../backend/generator.py");
    const payload = {
      keyword: SENTINELS.keyword,
      prompt: SENTINELS.prompt,
      category: SENTINELS.category,
      directionBrief: SENTINELS.directionBrief,
      selectedTags: [{ label: SENTINELS.selectedTag }],
      outputVariants: [{ role: SENTINELS.outputVariant }],
      product_images: [SENTINELS.productUrl],
      style_ref: SENTINELS.referenceUrl,
      model_key: "gemini_image",
      providerMode: "mock",
      mockProviderBehavior: "success",
      mockProviderDelayMs: 1,
      count: 1,
    };
    const result = pythonResult([generatorPath, "--from-stdin"], JSON.stringify(payload), {
      LINAPI_KEY: "",
      LINAPI_GEMINI_IMAGE_MODEL: "gemini-3.1-flash-image-preview",
      OPENAI_PROMPT_ENHANCER_MODEL: "",
    });
    assertNoRawValues(result.stderr, GENERATOR_RAW_VALUES, "generator stderr");
  });

  await test("prompt enhancer classifies provider errors without raw exception text", () => {
    const backendPath = path.resolve(__dirname, "../../backend");
    const script = [
      "import asyncio, contextlib, io, json, os, sys",
      `sys.path.insert(0, ${JSON.stringify(backendPath)})`,
      "import prompt_enhancer as enhancer",
      "enhancer.ENHANCER_MODEL = 'privacy-test-model'",
      "enhancer.LINAPI_KEY = 'privacy-test-key'",
      "enhancer._load_cache = lambda _key: None",
      "enhancer._save_cache = lambda *_args, **_kwargs: None",
      "async def fail_provider(*_args, **_kwargs):",
      "    raise RuntimeError(os.environ['VP_PROVIDER_SENTINEL'])",
      "enhancer._call_vlm = fail_provider",
      "buffer = io.StringIO()",
      "with contextlib.redirect_stderr(buffer):",
      "    result = asyncio.run(enhancer.enhance(['data:image/png;base64,AA=='], [], user_raw_text='safe'))",
      "print(json.dumps({'stderr': buffer.getvalue(), 'result': result}))",
    ].join("\n");
    const result = pythonResult(["-c", script], undefined, { VP_PROVIDER_SENTINEL: SENTINELS.providerBody });
    assertNoRawValues(result.stdout, [SENTINELS.providerBody], "enhancer log/result");
  });

  await test("worker sanitizer returns a bounded category without raw provider text", () => {
    const apiPath = path.resolve(__dirname, "../../api");
    const script = [
      "import json, os, sys",
      `sys.path.insert(0, ${JSON.stringify(apiPath)})`,
      "from app import worker",
      "value = worker.sanitize_error(RuntimeError('api_server_error::' + os.environ['VP_PROVIDER_SENTINEL']))",
      "print(json.dumps({'value': value}))",
    ].join("\n");
    const result = pythonResult(["-c", script], undefined, { VP_PROVIDER_SENTINEL: SENTINELS.providerBody });
    const parsed = JSON.parse(result.stdout) as { value?: unknown };
    const value = String(parsed.value ?? "");
    assertNoRawValues(value, [SENTINELS.providerBody], "worker sanitizer");
    assert(value.length > 0 && value.length <= 160, "worker sanitizer returns a short classified/generic value");
    assert(/^[a-z][a-z0-9_]*(?:::[a-z0-9_ .-]+)?$/i.test(value), "worker sanitizer returns a structured category/generic message");
  });

  await test("route source guard checks only individual console calls", () => {
    for (const call of extractConsoleCalls(routeSource)) {
      assert(!/result\.keyword|stdout\.slice\s*\(|stderr\.(?:trim|slice)|directionBrief\.slice\s*\(|sourceUrl\.slice\s*\(/.test(call),
        `console call contains an obvious raw-value expression: ${call.replace(/\s+/g, " ").slice(0, 160)}`);
    }
  });

  await test("Python source guard forbids raw traceback/logger exception emission", () => {
    const forbidden = /traceback\.(?:print_exc|format_exc)\s*\(|\b(?:logger|logging)\.exception\s*\(|exc_info\s*=\s*True/;
    assertNoLinePattern(workerSource, forbidden, "worker must not emit raw tracebacks or logger.exception output");
    assertNoLinePattern(generatorSource, forbidden, "generator must not emit raw tracebacks or logger.exception output");
    assertNoLinePattern(generatorSource, /(?:print|logger\.[a-z_]+)\([^\n]*\br\.text\b/, "generator must not log raw provider response text");
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (Module as any)._load = originalLoad;
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (Module as any)._load = originalLoad;
  console.error(error);
  process.exit(1);
});
