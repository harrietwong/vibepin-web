/**
 * /api/import/product-urls auth + rate limit, and the generic-channel SSRF literal fix.
 *
 * Route tests inject fakes into `handlePost` (same pattern as fetch-og tests 18/24), so
 * no Supabase or network is touched. The SSRF block covers the IPv4-mapped IPv6 bypass:
 * `new URL("http://[::ffff:127.0.0.1]/").hostname` is `[::ffff:7f00:1]`, which the old
 * string-prefix check let through.
 *
 * Run: npx tsx scripts/test-product-url-import-auth.ts
 */
import type { ProductUrlImportResult } from "../src/lib/productUrlImport";
import { readFileSync } from "node:fs";
import { join } from "node:path";

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  OK ${name}`);
    passed++;
  } catch (error) {
    console.error(`  FAIL ${name}`);
    console.error(`       ${(error as Error).message}`);
    failed++;
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const allow = async () => ({ allowed: true as const, reason: "under_limit" as const, remaining: 59 });

function post(body: unknown, raw?: string) {
  return new Request("https://app.test/api/import/product-urls", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: raw ?? JSON.stringify(body),
  });
}

async function run() {
  // Placeholder env so the Supabase-backed modules can be imported (never contacted:
  // every dependency that would touch the network is injected below).
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= "https://test-placeholder.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= "test-placeholder-anon-key";
  const { handlePost } = await import("../src/app/api/import/product-urls/handler");
  const { isPrivateOrLocalHost, validateImportUrl } = await import("../src/lib/productUrlImport/urlSecurity");
  const { RATE_LIMITS } = await import("../src/lib/server/rateLimit");

  console.log("\n-- route: auth + rate limit --");

  await test("unauthenticated request → 401 and no import/limiter work", async () => {
    let imports = 0;
    let limiterCalls = 0;
    const res = await handlePost(post({ urls: ["https://example.com/p"] }), {
      getUserId: async () => null,
      consumeRateLimit: async () => { limiterCalls++; return allow(); },
      importProductUrls: async () => { imports++; return []; },
    });
    assert(res.status === 401, `expected 401, got ${res.status}`);
    assert(imports === 0, "import ran for anonymous caller");
    assert(limiterCalls === 0, "limiter consumed for anonymous caller");
  });

  await test("auth lookup that throws is treated as unauthenticated (401)", async () => {
    const res = await handlePost(post({ urls: ["https://example.com/p"] }), {
      getUserId: async () => { throw new Error("supabase down"); },
      consumeRateLimit: allow,
      importProductUrls: async () => { throw new Error("must not run"); },
    });
    assert(res.status === 401, `expected 401, got ${res.status}`);
  });

  await test("auth is checked before the body is parsed (malformed body still 401)", async () => {
    const res = await handlePost(post(null, "{not json"), { getUserId: async () => null, consumeRateLimit: allow });
    assert(res.status === 401, `expected 401, got ${res.status}`);
  });

  await test("over the limit → 429 with Retry-After, no outbound import", async () => {
    let imports = 0;
    const res = await handlePost(post({ urls: ["https://example.com/p"] }), {
      getUserId: async () => "user-1",
      consumeRateLimit: async userId => {
        assert(userId === "user-1", "limiter subject must be the authenticated user");
        return { allowed: false, reason: "limit_exceeded", retryAfterSeconds: 42, limit: 60, windowSeconds: 300 };
      },
      importProductUrls: async () => { imports++; return []; },
    });
    assert(res.status === 429, `expected 429, got ${res.status}`);
    assert(res.headers.get("retry-after") === "42", "missing Retry-After");
    assert(imports === 0, "import ran after rate-limit refusal");
  });

  await test("limiter infrastructure refusal (fail-closed shape) → 503", async () => {
    const res = await handlePost(post({ urls: ["https://example.com/p"] }), {
      getUserId: async () => "user-1",
      consumeRateLimit: async () => ({ allowed: false, reason: "limiter_unavailable", retryAfterSeconds: 5 } as never),
      importProductUrls: async () => { throw new Error("must not run"); },
    });
    assert(res.status === 503, `expected 503, got ${res.status}`);
  });

  await test("authenticated generic import behaves as before (results passthrough)", async () => {
    const seen: string[][] = [];
    const fake: ProductUrlImportResult = {
      sourceUrl: "https://example.com/p", sourceDomain: "example.com", status: "success", candidates: [],
    } as ProductUrlImportResult;
    const res = await handlePost(post({ urls: ["https://example.com/p", 42] }), {
      getUserId: async () => "user-1",
      consumeRateLimit: allow,
      importProductUrls: async urls => { seen.push(urls); return [fake]; },
    });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    const body = await res.json() as { results: ProductUrlImportResult[] };
    assert(body.results.length === 1 && body.results[0].sourceUrl === "https://example.com/p", "results not passed through");
    assert(seen.length === 1 && seen[0].length === 1 && seen[0][0] === "https://example.com/p", "non-string urls should be filtered");
  });

  await test("authenticated: body validation unchanged (400 empty, 400 >20, all-invalid → failed rows)", async () => {
    const deps = { getUserId: async () => "u", consumeRateLimit: allow, importProductUrls: async () => { throw new Error("must not run"); } };
    assert((await handlePost(post({ urls: [] }), deps)).status === 400, "empty urls should 400");
    assert((await handlePost(post(null, "{bad"), deps)).status === 400, "bad json should 400");
    const many = Array.from({ length: 21 }, (_, i) => `https://example.com/${i}`);
    assert((await handlePost(post({ urls: many }), deps)).status === 400, ">20 urls should 400");
    const res = await handlePost(post({ urls: ["http://localhost/x"] }), deps);
    const body = await res.json() as { results: Array<{ status: string }> };
    assert(res.status === 200 && body.results[0].status === "failed", "all-invalid should return failed rows");
  });

  await test("route uses its own url_import bucket (60 / 300s)", () => {
    assert(RATE_LIMITS.url_import.limit === 60 && RATE_LIMITS.url_import.windowSeconds === 300, "url_import rule changed");
    const handlerSrc = readFileSync(join(process.cwd(), "src/app/api/import/product-urls/handler.ts"), "utf8");
    assert(handlerSrc.includes(`consumeRateLimit(id, "url_import")`), "handler must consume the url_import bucket");
    const routeSrc = readFileSync(join(process.cwd(), "src/app/api/import/product-urls/route.ts"), "utf8");
    assert(routeSrc.includes("handlePost(request)"), "route must delegate to handlePost");
  });

  await test("client sends a Bearer token when a session exists", () => {
    const src = readFileSync(join(process.cwd(), "src/lib/productUrlImportClient.ts"), "utf8");
    assert(/Authorization = `Bearer \$\{identity\.accessToken\}`/.test(src), "client no longer attaches Bearer");
  });

  console.log("\n-- generic channel SSRF literals --");

  const mustReject = [
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:10.0.0.1]/",
    "http://[::ffff:192.168.1.1]/",
    "http://[::ffff:7f00:1]/",
    "http://[::]/",
    "http://[::1]/",
    "http://[fe80::1]/",
    "http://[fc00::1]/",
    "http://[fd12:3456::1]/",
    "http://[64:ff9b::7f00:1]/",
    "http://100.64.0.1/",
    "http://198.18.0.1/",
    "http://127.0.0.1/",
    "http://2130706433/",       // decimal 127.0.0.1 → URL parser normalises to 127.0.0.1
    "http://0x7f.1/",           // hex/short form → 127.0.0.1
    "http://169.254.169.254/latest/meta-data/",
    "http://localhost./",
    "http://foo.localhost/",
  ];
  for (const raw of mustReject) {
    await test(`validateImportUrl rejects ${raw}`, () => {
      const v = validateImportUrl(raw);
      assert(!v.ok, `${raw} was accepted (hostname=${(() => { try { return new URL(raw).hostname; } catch { return "?"; } })()})`);
    });
  }

  await test("public literals and normal hosts still pass", () => {
    for (const raw of ["https://93.184.216.34/", "https://[2606:4700::1111]/", "https://example.com/p", "https://shop.example.co.uk/products/x"]) {
      assert(validateImportUrl(raw).ok, `${raw} should be accepted`);
    }
  });

  await test("isPrivateOrLocalHost works on the parsed (rewritten) hostname", () => {
    assert(new URL("http://[::ffff:127.0.0.1]/").hostname === "[::ffff:7f00:1]", "URL parser behaviour changed — revisit fix");
    assert(isPrivateOrLocalHost("[::ffff:7f00:1]"), "mapped loopback not detected");
    assert(!isPrivateOrLocalHost("example.com"), "plain host misclassified");
  });

  console.log(`\nProduct URL import auth/SSRF: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run();
