/**
 * Amazon channel end-to-end through importUrl / the import route, with an injected
 * network (Response objects built from the real-page fixtures). Covers every failure
 * reason, the bot page returned with HTTP 200, short-link expansion, the whitelist on
 * every hop, the 4 MB read cap, and the card contract (no images, no price, failures
 * never carry title/description, no quota touched).
 *
 * Run: npx tsx scripts/test-amazon-import.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProductUrlImportResult } from "../src/lib/productUrlImport";

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

const fixture = (name: string) => readFileSync(join(process.cwd(), "scripts/fixtures/amazon", name), "utf8");
const BOT = fixture("bot-check-200.html");
const MACBOOK = fixture("product-macbook-B0BSHF7WHW.html");
const BOOK = fixture("book-catcher-0316769487.html");

type Step = Response | Error | ((url: string) => Response);
function net(steps: Step[]) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const amazonFetch = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const step = steps.shift();
    if (!step) throw new Error(`unexpected fetch ${url}`);
    if (step instanceof Error) throw step;
    return typeof step === "function" ? step(url) : step;
  };
  return { calls, amazonFetch };
}
const html200 = (body: string) => new Response(body, { status: 200, headers: { "content-type": "text/html" } });
const redirect = (location: string, status = 301) => new Response(null, { status, headers: { location } });
const noGenericFetch = async () => { throw new Error("generic page fetcher must never run for Amazon"); };

function assertFailureContract(r: ProductUrlImportResult, reason: string) {
  assert(r.provider === "amazon", `provider ${r.provider}`);
  assert(r.amazon?.fetch.reason === reason, `reason ${r.amazon?.fetch.reason} ≠ ${reason}`);
  assert(!("title" in r) && !("description" in r), "failure must not carry title/description (would blank user fields)");
  assert(Array.isArray(r.candidates) && r.candidates.length === 0, "failure must have no candidates");
  assert(r.fallbackActions?.includes("manual_entry"), "failure must offer manual entry");
  assert(typeof r.message === "string" && r.message.length > 0, "failure needs a message");
}

async function run() {
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= "https://test-placeholder.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= "test-placeholder-anon-key";
  const { importUrl, importProductUrls } = await import("../src/lib/productUrlImport");
  const { fetchAmazonPage, AMAZON_MAX_RESPONSE_BYTES } = await import("../src/lib/productUrlImport/amazonFetcher");
  const { DEFAULT_HEADERS } = await import("../src/lib/productUrlImport/fetchHeaders");
  const { handlePost } = await import("../src/app/api/import/product-urls/handler");

  const PASTED = "https://www.amazon.com/Apple-MacBook/dp/B0BSHF7WHW/ref=sr_1_1?qid=1&tag=me-20&linkCode=ll1";

  console.log("\n-- success --");

  await test("retail success: text fields, no images, pasted URL preserved, tag-free fetch", async () => {
    const { calls, amazonFetch } = net([html200(MACBOOK.replace("</head>", `<meta property="og:image" content="https://m.media-amazon.com/images/I/x.jpg"></head>`))]);
    const r = await importUrl(PASTED, noGenericFetch, { amazonFetch });
    assert(r.status === "success" && r.provider === "amazon", JSON.stringify(r).slice(0, 200));
    assert(r.sourceUrl === PASTED && r.originalUrl === PASTED, "pasted link must be returned untouched");
    assert(r.normalizedUrl === "https://www.amazon.com/dp/B0BSHF7WHW?tag=me-20&linkCode=ll1", `normalized ${r.normalizedUrl}`);
    assert(r.title?.startsWith("Apple 2023 MacBook Pro"), `title ${r.title}`);
    assert(r.amazon?.extracted?.bullets?.length === 6 && r.amazon.extracted.brand === "Apple", JSON.stringify(r.amazon?.extracted).slice(0, 120));
    assert(r.amazon?.fetch.status === "ok" && r.amazon.linkStatus === "ok" && r.amazon.asin === "B0BSHF7WHW", JSON.stringify(r.amazon?.fetch));
    assert(r.candidates?.length === 0, "Amazon results never carry image candidates (og:image present on page)");
    assert(calls.length === 1 && calls[0].url === "https://www.amazon.com/dp/B0BSHF7WHW", `fetched ${calls[0]?.url} — must be tag-free canonical`);
    assert(calls[0].init.redirect === "manual", "redirects must be manual");
    const ua = (calls[0].init.headers as Record<string, string>)["User-Agent"];
    assert(ua === DEFAULT_HEADERS["User-Agent"] && !/Chrome|Safari/.test(ua), `UA ${ua}`);
  });

  await test("book link (ISBN ASIN) → success, title only, no brand", async () => {
    const { calls, amazonFetch } = net([html200(BOOK)]);
    const r = await importUrl("https://www.amazon.com/dp/0316769487", noGenericFetch, { amazonFetch });
    assert(r.status === "success" && r.title === "The Catcher in the Rye" && !r.amazon?.extracted?.brand, JSON.stringify(r).slice(0, 300));
    assert(calls[0].url === "https://www.amazon.com/dp/0316769487", calls[0].url);
  });

  await test("redirect between Amazon hosts is followed (each hop re-validated)", async () => {
    const { calls, amazonFetch } = net([redirect("https://www.amazon.com/Apple/dp/B0BSHF7WHW?th=1"), html200(MACBOOK)]);
    const r = await importUrl("https://amazon.com/dp/B0BSHF7WHW", noGenericFetch, { amazonFetch });
    assert(r.status === "success" && calls.length === 2, `${r.status} / ${calls.length}`);
  });

  await test("short link amzn.to → retail → page: success, expandedFrom kept", async () => {
    const { calls, amazonFetch } = net([redirect("https://www.amazon.com/dp/B0BSHF7WHW?tag=me-20"), html200(MACBOOK)]);
    const r = await importUrl("https://amzn.to/3xYz", noGenericFetch, { amazonFetch });
    assert(r.status === "success" && r.amazon?.expandedFrom === "https://amzn.to/3xYz", JSON.stringify(r.amazon));
    assert(r.sourceUrl === "https://amzn.to/3xYz", "pasted short link must stay as sourceUrl");
    assert(r.normalizedUrl === "https://www.amazon.com/dp/B0BSHF7WHW?tag=me-20", `normalized ${r.normalizedUrl}`);
    assert(calls.length === 2 && calls[1].url === "https://www.amazon.com/dp/B0BSHF7WHW", calls.map(c => c.url).join(" | "));
  });

  await test("page larger than 4 MB is read up to the cap, not rejected", async () => {
    const big = MACBOOK.replace("</body>", `${"<!-- pad -->".repeat(500_000)}</body>`);
    assert(Buffer.byteLength(big) > AMAZON_MAX_RESPONSE_BYTES, "fixture not large enough");
    const { amazonFetch } = net([html200(big)]);
    const page = await fetchAmazonPage("https://www.amazon.com/dp/B0BSHF7WHW", amazonFetch);
    assert(page.ok && page.truncated && Buffer.byteLength(page.html) <= AMAZON_MAX_RESPONSE_BYTES, page.ok ? `len ${page.html.length}` : page.reason);
    const { amazonFetch: f2 } = net([html200(big)]);
    const r = await importUrl("https://www.amazon.com/dp/B0BSHF7WHW", noGenericFetch, { amazonFetch: f2 });
    assert(r.status === "success", `status ${r.status}`);
  });

  console.log("\n-- every failure reason --");

  await test("HTTP 200 bot page → blocked / bot_check", async () => {
    const r = await importUrl(PASTED, noGenericFetch, net([html200(BOT)]));
    assert(r.status === "blocked" && r.amazon?.fetch.status === "blocked", r.status);
    assertFailureContract(r, "bot_check");
  });

  await test("404 → failed / http_error with status", async () => {
    const r = await importUrl(PASTED, noGenericFetch, net([new Response("gone", { status: 404 })]));
    assert(r.status === "failed" && r.amazon?.fetch.httpStatus === 404, JSON.stringify(r.amazon?.fetch));
    assertFailureContract(r, "http_error");
  });

  await test("503 → failed / http_error", async () => {
    const r = await importUrl(PASTED, noGenericFetch, net([new Response("", { status: 503 })]));
    assertFailureContract(r, "http_error");
  });

  await test("timeout → timeout; connection error → network_error", async () => {
    const t = Object.assign(new Error("aborted"), { name: "TimeoutError" });
    assertFailureContract(await importUrl(PASTED, noGenericFetch, net([t])), "timeout");
    assertFailureContract(await importUrl(PASTED, noGenericFetch, net([new Error("ECONNRESET")])), "network_error");
  });

  await test("redirect off the whitelist → off_allowlist, never requested", async () => {
    const n = net([redirect("https://evil.io/dp/B0BSHF7WHW")]);
    assertFailureContract(await importUrl(PASTED, noGenericFetch, n), "off_allowlist");
    assert(n.calls.length === 1, `followed off-allowlist redirect (${n.calls.length} calls)`);
    const m = net([redirect("http://[::ffff:127.0.0.1]/")]);
    assertFailureContract(await importUrl(PASTED, noGenericFetch, m), "off_allowlist");
    assert(m.calls.length === 1, "followed redirect to loopback");
  });

  await test("more than 3 redirects → too_many_redirects", async () => {
    const hop = () => redirect("https://www.amazon.com/dp/B0BSHF7WHW?x=1", 302);
    const n = net([hop(), hop(), hop(), hop()]);
    assertFailureContract(await importUrl(PASTED, noGenericFetch, n), "too_many_redirects");
    assert(n.calls.length === 4, `calls ${n.calls.length}`);
  });

  await test("page without title or bullets → no_product_fields", async () => {
    const r = await importUrl(PASTED, noGenericFetch, net([html200(`<html><head></head><body>${"x".repeat(30_000)}</body></html>`)]));
    assertFailureContract(r, "no_product_fields");
  });

  await test("short link that does not redirect → short_link_unexpanded, retail page not fetched", async () => {
    const n = net([html200(BOT)]);
    const r = await importUrl("https://a.co/d/abc123", noGenericFetch, n);
    assertFailureContract(r, "short_link_unexpanded");
    assert(r.amazon?.linkStatus === "short_unexpanded" && r.sourceUrl === "https://a.co/d/abc123", JSON.stringify(r.amazon));
    assert(n.calls.length === 1, `calls ${n.calls.length}`);
  });

  await test("amzn.eu (recognised, not fetchable) → short_link_unexpanded, zero requests", async () => {
    const n = net([]);
    assertFailureContract(await importUrl("https://amzn.eu/d/abc", noGenericFetch, n), "short_link_unexpanded");
    assert(n.calls.length === 0, "must not fetch");
  });

  await test("amazon.nl → unsupported_marketplace, zero requests", async () => {
    const n = net([]);
    const r = await importUrl("https://www.amazon.nl/dp/B0BSHF7WHW", noGenericFetch, n);
    assertFailureContract(r, "unsupported_marketplace");
    assert(n.calls.length === 0, "must not fetch");
  });

  await test("search page (no ASIN) → not_product_page, zero requests, link kept", async () => {
    const n = net([]);
    const r = await importUrl("https://www.amazon.com/s?k=lamp&tag=me-20", noGenericFetch, n);
    assertFailureContract(r, "not_product_page");
    assert(r.amazon?.linkStatus === "no_asin" && r.normalizedUrl === "https://www.amazon.com/s?k=lamp&tag=me-20", JSON.stringify(r));
    assert(n.calls.length === 0, "must not fetch");
  });

  console.log("\n-- channel separation + route --");

  await test("non-Amazon URLs still use the generic fetcher, untouched", async () => {
    let genericCalls = 0;
    const r = await importUrl("https://shop.example.com/p/lamp", async () => {
      genericCalls++;
      return { html: `<html><head><meta property="og:image" content="https://cdn.example.com/lamp.jpg"></head></html>`, finalUrl: "https://shop.example.com/p/lamp" };
    }, net([]));
    assert(genericCalls === 1 && r.status === "success" && (r.candidates?.length ?? 0) > 0 && r.provider !== "amazon", JSON.stringify(r).slice(0, 200));
  });

  await test("route: Amazon-only batch is not short-circuited as invalid; bot page → blocked row", async () => {
    const n = net([html200(BOT)]);
    const res = await handlePost(new Request("https://app.test/api/import/product-urls", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ urls: [PASTED] }),
    }), {
      getUserId: async () => "user-1",
      consumeRateLimit: async () => ({ allowed: true, reason: "under_limit", remaining: 59 }),
      importProductUrls: urls => importProductUrls(urls, noGenericFetch, n),
    });
    const body = await res.json() as { results: ProductUrlImportResult[] };
    assert(res.status === 200 && body.results.length === 1, `status ${res.status}`);
    assertFailureContract(body.results[0], "bot_check");
  });

  await test("route still 401s anonymous Amazon requests before any fetch", async () => {
    const n = net([]);
    const res = await handlePost(new Request("https://app.test/api/import/product-urls", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ urls: [PASTED] }),
    }), { getUserId: async () => null, importProductUrls: urls => importProductUrls(urls, noGenericFetch, n) });
    assert(res.status === 401 && n.calls.length === 0, `status ${res.status}, calls ${n.calls.length}`);
  });

  await test("no quota: import route and Amazon channel never touch metering", () => {
    const files = [
      "src/app/api/import/product-urls/handler.ts",
      "src/lib/productUrlImport/amazonImport.ts",
      "src/lib/productUrlImport/amazonFetcher.ts",
      "src/lib/productUrlImport/adapters/amazon.ts",
    ];
    for (const f of files) {
      const src = readFileSync(join(process.cwd(), f), "utf8");
      assert(!/reserveTextGeneration|settle|usage_events|billing|credits?\b/i.test(src.replace(/^\s*(\*|\/\/).*$/gm, "")), `${f} references metering`);
    }
  });

  await test("honest UA only: no browser impersonation in Amazon channel sources", () => {
    for (const f of ["fetchHeaders.ts", "amazonFetcher.ts", "amazonShortLink.ts", "amazonImport.ts", "adapters/amazon.ts"]) {
      const src = readFileSync(join(process.cwd(), "src/lib/productUrlImport", f), "utf8");
      assert(!/Chrome|Safari|Firefox|AppleWebKit|Gecko/.test(src), `${f} contains a browser UA token`);
    }
  });

  await test("no price / availability / rating keys anywhere in a success result", async () => {
    const withPrice = MACBOOK.replace("</body>", `<span class="a-price"><span class="a-offscreen">$1,999.00</span></span><div id="availability">In Stock</div></body>`);
    const r = await importUrl(PASTED, noGenericFetch, net([html200(withPrice)]));
    const json = JSON.stringify(r);
    assert(r.status === "success" && !/1,999|In Stock|"price"|"availability"|"rating"/.test(json), json.slice(0, 200));
  });

  console.log(`\nAmazon import: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run();
