/**
 * FR-06 stage 1 — Shopify store / collection batch import.
 *
 * Route tests inject fakes into `handlePost` (same pattern as
 * test-product-url-import-auth.ts): no Supabase, no network. The transport seam is a
 * SINGLE-HOP fake (`fetchRaw`), so redirects, per-hop validation, the same-store rule,
 * size caps, paging and the cache are all exercised in the real code above it.
 *
 * Run: npx tsx scripts/test-store-products-import.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { StoreFetchRaw, StoreRawResponse } from "../src/lib/productUrlImport/storeProductsImport";
import type { StoreBatchProduct, StoreProductsImportResponse } from "../src/lib/productUrlImport/storeBatchShared";

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

function eq<T>(actual: T, expected: T, label: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const allow = async () => ({ allowed: true as const, reason: "under_limit" as const, remaining: 59 });

function post(body: unknown, raw?: string) {
  return new Request("https://app.test/api/import/store-products", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: raw ?? JSON.stringify(body),
  });
}

function hdrs(h: Record<string, string> = {}) {
  const lower = Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (name: string) => lower[name.toLowerCase()] ?? null };
}

function jsonResp(data: unknown, headers: Record<string, string> = {}): StoreRawResponse {
  return { status: 200, headers: hdrs({ "content-type": "application/json", ...headers }), body: new TextEncoder().encode(JSON.stringify(data)) };
}
function textResp(text: string, status = 200): StoreRawResponse {
  return { status, headers: hdrs({ "content-type": "text/html" }), body: new TextEncoder().encode(text) };
}
function statusResp(status: number, headers: Record<string, string> = {}): StoreRawResponse {
  return { status, headers: hdrs(headers), body: new Uint8Array(0) };
}

function product(i: number, over: Record<string, unknown> = {}) {
  return {
    id: 1000 + i,
    title: `Product ${i}`,
    handle: `p-${i}`,
    body_html: "<p>Soft <b>merino</b> knit.</p>",
    vendor: "Acme",
    product_type: "Sweater",
    tags: ["knit"],
    variants: [{ price: "19.00", compare_at_price: "0.00", available: true }],
    images: [{ src: `https://cdn.shopify.com/s/files/p${i}.jpg` }],
    ...over,
  };
}
const productsRange = (from: number, count: number) => Array.from({ length: count }, (_, k) => product(from + k));

type Log = { calls: string[]; events: string[] };

/**
 * A fake Shopify store. `pages[n]` is page n's product list; meta.json answers with
 * `meta` (or `metaResponse`). Every call is logged in order, and sleeps are logged
 * into the same timeline so ordering can be asserted.
 */
function fakeStore(opts: {
  pages?: Record<number, unknown[]>;
  meta?: unknown;
  metaResponse?: StoreRawResponse;
  override?: (url: URL) => StoreRawResponse | undefined;
}): { fetchRaw: StoreFetchRaw; sleep: (ms: number) => Promise<void>; log: Log; sleeps: number[] } {
  const log: Log = { calls: [], events: [] };
  const sleeps: number[] = [];
  const fetchRaw: StoreFetchRaw = async (raw) => {
    log.calls.push(raw);
    log.events.push(`fetch ${raw}`);
    const url = new URL(raw);
    const o = opts.override?.(url);
    if (o) return o;
    if (url.pathname === "/meta.json") return opts.metaResponse ?? jsonResp(opts.meta ?? { name: "Shop", currency: "USD" });
    if (url.pathname.endsWith("/products.json")) {
      const page = Number(url.searchParams.get("page") ?? "1");
      return jsonResp({ products: opts.pages?.[page] ?? [] });
    }
    return statusResp(404);
  };
  const sleep = async (ms: number) => { sleeps.push(ms); log.events.push(`sleep ${ms}`); };
  return { fetchRaw, sleep, log, sleeps };
}

async function run() {
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= "https://test-placeholder.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= "test-placeholder-anon-key";
  const { handlePost, __resetStoreImportCacheForTests } = await import("../src/app/api/import/store-products/handler");
  const mod = await import("../src/lib/productUrlImport/storeProductsImport");
  const shared = await import("../src/lib/productUrlImport/storeBatchShared");
  const client = await import("../src/lib/studio/storeBatchImport");

  let userSeq = 0;
  const freshUser = () => `user-${++userSeq}`;

  async function call(url: string, store: ReturnType<typeof fakeStore>, extra: Record<string, unknown> = {}) {
    const res = await handlePost(post({ url }), {
      getUserId: async () => (extra.userId as string) ?? freshUser(),
      consumeRateLimit: allow,
      fetchRaw: store.fetchRaw,
      sleep: store.sleep,
      ...extra,
    });
    return { res, body: (await res.json()) as StoreProductsImportResponse & { error?: string; code?: string } };
  }

  console.log("\n-- route: auth, rate limit, validation (zero outbound) --");

  await test("unauthenticated → 401; no limiter slot, no fetch", async () => {
    const store = fakeStore({ pages: { 1: productsRange(0, 3) } });
    let limiterCalls = 0;
    const res = await handlePost(post({ url: "https://shop.example.com/" }), {
      getUserId: async () => null,
      consumeRateLimit: async () => { limiterCalls++; return allow(); },
      fetchRaw: store.fetchRaw, sleep: store.sleep,
    });
    assert(res.status === 401, `expected 401, got ${res.status}`);
    assert(store.log.calls.length === 0, "fetch ran for anonymous caller");
    assert(limiterCalls === 0, "limiter consumed for anonymous caller");
  });

  await test("auth lookup that throws → 401; malformed body still 401 (auth before body)", async () => {
    const store = fakeStore({});
    const a = await handlePost(post({ url: "https://shop.example.com/" }), { getUserId: async () => { throw new Error("down"); }, consumeRateLimit: allow, fetchRaw: store.fetchRaw });
    const b = await handlePost(post(null, "{not json"), { getUserId: async () => null, consumeRateLimit: allow, fetchRaw: store.fetchRaw });
    assert(a.status === 401 && b.status === 401, `expected 401/401, got ${a.status}/${b.status}`);
    assert(store.log.calls.length === 0, "fetch ran");
  });

  await test("over the url_import limit → 429 + Retry-After; no fetch", async () => {
    const store = fakeStore({ pages: { 1: productsRange(0, 3) } });
    const res = await handlePost(post({ url: "https://shop.example.com/" }), {
      getUserId: async () => "user-429",
      consumeRateLimit: async userId => {
        assert(userId === "user-429", "limiter subject must be the authenticated user");
        return { allowed: false, reason: "limit_exceeded", retryAfterSeconds: 42, limit: 60, windowSeconds: 300 };
      },
      fetchRaw: store.fetchRaw,
    });
    assert(res.status === 429, `expected 429, got ${res.status}`);
    assert(res.headers.get("Retry-After") === "42", "Retry-After missing");
    assert(store.log.calls.length === 0, "fetch ran while rate limited");
  });

  await test("default limiter bucket is url_import (source check)", () => {
    const src = readFileSync(join(process.cwd(), "src/app/api/import/store-products/handler.ts"), "utf8");
    assert(src.includes('consumeRateLimit(id, "url_import")'), "store import must share the url_import bucket");
    const route = readFileSync(join(process.cwd(), "src/app/api/import/store-products/route.ts"), "utf8");
    // Next.js segment config (`maxDuration`) is allowed; any other named export is not.
    assert(/export async function POST/.test(route) && !/export (const|function) (?!POST|maxDuration)/.test(route), "route.ts must only export POST (plus maxDuration segment config)");
  });

  await test("one batch (4 pages + meta) consumes exactly ONE limiter slot", async () => {
    const store = fakeStore({ pages: { 1: productsRange(0, 25), 2: productsRange(25, 25), 3: productsRange(50, 25), 4: productsRange(75, 25) } });
    let limiterCalls = 0;
    const { body } = await call("https://shop.example.com/", store, { consumeRateLimit: async () => { limiterCalls++; return allow(); } });
    assert(body.status === "success", `status ${body.status}`);
    assert(limiterCalls === 1, `expected 1 limiter call, got ${limiterCalls}`);
  });

  await test("missing / non-string url and invalid JSON body → 400, no fetch", async () => {
    const store = fakeStore({});
    for (const b of [{}, { url: 42 }, { url: "   " }]) {
      const r =await handlePost(post(b), { getUserId: async () => freshUser(), consumeRateLimit: allow, fetchRaw: store.fetchRaw });
      assert(r.status === 400, `expected 400 for ${JSON.stringify(b)}, got ${r.status}`);
    }
    const bad = await handlePost(post(null, "{nope"), { getUserId: async () => freshUser(), consumeRateLimit: allow, fetchRaw: store.fetchRaw });
    assert(bad.status === 400, "invalid JSON must be 400");
    assert(store.log.calls.length === 0, `fetch ran ${store.log.calls.length}x`);
  });

  await test("private / local / non-http / marketplace / credentials / custom port → 400, zero fetch", async () => {
    const store = fakeStore({ pages: { 1: productsRange(0, 3) } });
    const bad = [
      "http://localhost/collections/x",
      "http://127.0.0.1/",
      "http://10.0.0.5/products.json",
      "http://192.168.1.1/",
      "http://169.254.169.254/latest/meta-data",
      "http://[::1]/",
      "http://[::ffff:127.0.0.1]/",
      "ftp://shop.example.com/",
      "javascript:alert(1)",
      "not a url",
      "https://www.temu.com/collections/x",
      "https://www.amazon.com/",
      "https://user:pw@shop.example.com/",
      "https://shop.example.com:8443/",
    ];
    for (const url of bad) {
      const r = await handlePost(post({ url }), { getUserId: async () => freshUser(), consumeRateLimit: allow, fetchRaw: store.fetchRaw });
      assert(r.status === 400, `expected 400 for ${url}, got ${r.status}`);
    }
    assert(store.log.calls.length === 0, `fetch ran ${store.log.calls.length}x for rejected URLs`);
  });

  await test("single product links → 400 'use link import', zero fetch", async () => {
    const store = fakeStore({});
    for (const url of [
      "https://shop.example.com/products/blue-mug",
      "https://shop.example.com/collections/mugs/products/blue-mug",
      "https://shop.example.com/en-gb/products/blue-mug?variant=1",
      "https://store-x.myshopify.com/products/blue-mug",
    ]) {
      const r = await handlePost(post({ url }), { getUserId: async () => freshUser(), consumeRateLimit: allow, fetchRaw: store.fetchRaw });
      const b = await r.json() as { error?: string; code?: string };
      assert(r.status === 400, `expected 400 for ${url}, got ${r.status}`);
      assert(b.code === "product_page", `code for ${url}: ${b.code}`);
      assert(b.error === shared.STORE_PRODUCT_PAGE_MESSAGE, "product-page message mismatch");
    }
    assert(store.log.calls.length === 0, "fetch ran for product links");
  });

  console.log("\n-- endpoint derivation (server builds every address) --");

  await test("store root: path/query from the client are ignored; http upgraded to https", async () => {
    const store = fakeStore({ pages: { 1: productsRange(0, 2) } });
    const { body } = await call("http://Shop.Example.com/pages/about?page=9&limit=250", store);
    eq(store.log.calls[0], "https://shop.example.com/products.json?limit=25&page=1", "first request");
    assert(body.status === "success", `status ${body.status}`);
    assert(body.store.domain === "shop.example.com", `domain ${body.store.domain}`);
    assert(!("collectionHandle" in body.store), "store root must not carry a collection handle");
  });

  await test("a pasted products.json?page=… address is not trusted for paging", async () => {
    const store = fakeStore({ pages: { 1: productsRange(0, 2) } });
    await call("https://shop.example.com/products.json?limit=250&page=7", store);
    eq(store.log.calls[0], "https://shop.example.com/products.json?limit=25&page=1", "first request");
  });

  await test("collection path → /collections/{handle}/products.json (incl. locale prefix)", async () => {
    const a = fakeStore({ pages: { 1: productsRange(0, 2) } });
    const ra = await call("https://shop.example.com/collections/Summer-Sale?sort_by=price", a);
    eq(a.log.calls[0], "https://shop.example.com/collections/summer-sale/products.json?limit=25&page=1", "collection request");
    assert(ra.body.store.collectionHandle === "summer-sale", `handle ${ra.body.store.collectionHandle}`);
    const b = fakeStore({ pages: { 1: productsRange(0, 2) } });
    await call("https://shop.example.com/en-gb/collections/mugs", b);
    eq(b.log.calls[0], "https://shop.example.com/collections/mugs/products.json?limit=25&page=1", "locale-prefixed collection");
    const c = fakeStore({ pages: { 1: productsRange(0, 2) } });
    await call("https://shop.example.com/collections/mugs/products.json", c);
    eq(c.log.calls[0], "https://shop.example.com/collections/mugs/products.json?limit=25&page=1", "collection endpoint pasted");
  });

  await test("classifyStorePath: product page checked before collection", () => {
    eq(shared.classifyStorePath("/collections/a/products/b").kind, "product_page", "nested product");
    eq(shared.classifyStorePath("/collections/a"), { kind: "collection", handle: "a" }, "collection");
    eq(shared.classifyStorePath("/").kind, "store", "root");
    eq(shared.classifyStorePath("/collections/a%2F..%2Fb").kind, "invalid_collection", "encoded slash handle");
  });

  console.log("\n-- not a readable Shopify list → unsupported after ONE request --");

  for (const [label, resp] of [
    ["HTML page (non-JSON)", textResp("<html><body>Welcome</body></html>")],
    ["JSON of the wrong shape", jsonResp({ product: { title: "x" } })],
    ["products not an array", jsonResp({ products: "nope" })],
    ["403 bot protection", statusResp(403)],
    ["500 upstream error", statusResp(500)],
  ] as Array<[string, StoreRawResponse]>) {
    await test(`${label} → unsupported, exactly 1 request, no retry, no meta.json`, async () => {
      const store = fakeStore({ override: () => resp });
      const { res, body } = await call("https://shop.example.com/", store);
      assert(res.status === 200, `http ${res.status}`);
      assert(body.status === "unsupported", `status ${body.status}`);
      assert(store.log.calls.length === 1, `expected 1 request, got ${store.log.calls.length}`);
      assert(body.message === shared.STORE_UNSUPPORTED_MESSAGE, `message: ${body.message}`);
      assert(body.products.length === 0 && body.truncated === false, "unsupported must carry no products");
      const text = JSON.stringify(body);
      assert(!/\b(403|500)\b/.test(text) && !text.includes("products.json"), `upstream detail leaked: ${text}`);
    });
  }

  await test("transport error on page 1 → failed with fixed message, no stack/upstream text", async () => {
    const store = fakeStore({});
    const fetchRaw: StoreFetchRaw = async (u) => { store.log.calls.push(u); throw new Error("connect ECONNREFUSED 10.1.2.3:443 secret-internal"); };
    const { body } = await call("https://shop.example.com/", store, { fetchRaw });
    assert(body.status === "failed", `status ${body.status}`);
    assert(body.message === shared.STORE_FAILED_MESSAGE, `message ${body.message}`);
    assert(!JSON.stringify(body).includes("ECONNREFUSED"), "error text leaked");
    assert(store.log.calls.length === 1, "no retry after a transport failure");
  });

  console.log("\n-- paging, caps, pacing --");

  await test("4 full pages × 25 → 100 products, truncated=true, never asks for page 5", async () => {
    const store = fakeStore({ pages: { 1: productsRange(0, 25), 2: productsRange(25, 25), 3: productsRange(50, 25), 4: productsRange(75, 25), 5: productsRange(100, 25) } });
    const { body } = await call("https://shop.example.com/", store);
    assert(body.status === "success", `status ${body.status}`);
    assert(body.products.length === 100, `expected 100, got ${body.products.length}`);
    assert(body.truncated === true, "4 full pages must report truncated");
    assert(!store.log.calls.some(c => c.includes("page=5")), "page 5 must never be requested");
    eq(store.log.calls.length, 5, "4 pages + meta.json");
  });

  await test("last page with < 25 products stops paging; truncated=false", async () => {
    const store = fakeStore({ pages: { 1: productsRange(0, 25), 2: productsRange(25, 10) } });
    const { body } = await call("https://shop.example.com/", store);
    assert(body.products.length === 35, `expected 35, got ${body.products.length}`);
    assert(body.truncated === false, "short last page must not be truncated");
    assert(!store.log.calls.some(c => c.includes("page=3")), "page 3 requested after a short page");
  });

  await test("empty first page → success with 0 products; only page 1 + meta.json", async () => {
    const store = fakeStore({ pages: { 1: [] } });
    const { body } = await call("https://shop.example.com/", store);
    assert(body.status === "success" && body.products.length === 0 && !body.truncated, JSON.stringify(body));
    eq(store.log.calls.length, 2, "request count");
  });

  await test("sleep(≥500 ms) before every page after the first, never before page 1 or meta", async () => {
    const store = fakeStore({ pages: { 1: productsRange(0, 25), 2: productsRange(25, 25), 3: productsRange(50, 5) } });
    await call("https://shop.example.com/", store);
    eq(store.sleeps.length, 2, "sleep count");
    assert(store.sleeps.every(ms => ms >= 500), `sleep durations ${store.sleeps}`);
    const ev = store.log.events;
    assert(ev[0].startsWith("fetch") && ev[0].includes("page=1"), `first event ${ev[0]}`);
    assert(ev[1].includes("/meta.json"), `second event ${ev[1]}`);
    const p2 = ev.findIndex(e => e.includes("page=2"));
    const p3 = ev.findIndex(e => e.includes("page=3"));
    assert(ev[p2 - 1].startsWith("sleep") && ev[p3 - 1].startsWith("sleep"), `pacing order ${ev.join(" | ")}`);
  });

  await test("a failing page ≥ 2 keeps what was collected and reports truncated=true", async () => {
    const store = fakeStore({
      pages: { 1: productsRange(0, 25) },
      override: u => (u.searchParams.get("page") === "2" ? statusResp(503) : undefined),
    });
    const { body } = await call("https://shop.example.com/", store);
    assert(body.status === "success" && body.products.length === 25 && body.truncated === true, JSON.stringify({ s: body.status, n: body.products.length, t: body.truncated }));
    assert(!store.log.calls.some(c => c.includes("page=3")), "no page 3 after a failing page 2");
  });

  await test("duplicate handles across pages are deduped; product without handle skipped", async () => {
    const page1 = [...productsRange(0, 24), product(99, { handle: "" })];
    const store = fakeStore({ pages: { 1: page1, 2: [product(0), product(30)] } });
    const { body } = await call("https://shop.example.com/", store);
    const handles = body.products.map(p => p.handle);
    assert(new Set(handles).size === handles.length, "duplicate handle kept");
    assert(handles.includes("p-30") && !handles.includes(""), `handles ${handles.slice(-3)}`);
    eq(body.products.length, 25, "24 + 1 new");
  });

  console.log("\n-- size cap (1 MB) --");

  await test("declared Content-Length > 1 MB → failed, no further requests", async () => {
    const store = fakeStore({ override: () => jsonResp({ products: [] }, { "content-length": String(2 * 1024 * 1024) }) });
    const { body } = await call("https://shop.example.com/", store);
    assert(body.status === "failed", `status ${body.status}`);
    eq(store.log.calls.length, 1, "request count");
  });

  await test("real body > 1 MB without Content-Length → failed", async () => {
    const big = new Uint8Array(mod.STORE_MAX_RESPONSE_BYTES + 1).fill(0x20);
    const store = fakeStore({ override: () => ({ status: 200, headers: hdrs({}), body: big }) });
    const { body } = await call("https://shop.example.com/", store);
    assert(body.status === "failed", `status ${body.status}`);
  });

  await test("transport flag overLimit → failed", async () => {
    const store = fakeStore({ override: () => ({ status: 200, headers: hdrs({}), body: new Uint8Array(0), overLimit: true }) });
    const { body } = await call("https://shop.example.com/", store);
    assert(body.status === "failed", `status ${body.status}`);
  });

  await test("readBodyWithLimit stops consuming the stream once the cap is crossed", async () => {
    let yielded = 0;
    let aborted = 0;
    async function* chunks() {
      for (let i = 0; i < 100; i++) { yielded++; yield new Uint8Array(300 * 1024); }
    }
    const r = await mod.readBodyWithLimit(chunks(), mod.STORE_MAX_RESPONSE_BYTES, () => { aborted++; });
    assert(r.overLimit === true, "must report overLimit");
    assert(yielded === 4, `expected to stop after 4 chunks (1.2 MB), consumed ${yielded}`);
    assert(aborted === 1, "abort callback must fire once");
    const ok = await mod.readBodyWithLimit((async function* () { yield new TextEncoder().encode("{\"a\":"); yield "1}"; })(), 100);
    eq(new TextDecoder().decode(ok.body), "{\"a\":1}", "small body assembled");
  });

  console.log("\n-- redirects (≤ 3 hops, each re-validated, same store only) --");

  await test("redirect to another origin → rejected (unsupported), target never fetched", async () => {
    const store = fakeStore({ override: u => (u.hostname === "shop.example.com" ? statusResp(301, { location: "https://evil.example.net/products.json?limit=25&page=1" }) : undefined) });
    const { body } = await call("https://shop.example.com/", store);
    assert(body.status === "unsupported", `status ${body.status}`);
    assert(!store.log.calls.some(c => c.includes("evil.example.net")), "cross-origin target was fetched");
    eq(store.log.calls.length, 1, "request count");
  });

  await test("redirect to a private address or http downgrade → rejected, never fetched", async () => {
    for (const location of ["http://127.0.0.1/products.json", "http://shop.example.com/products.json", "https://shop.example.com:8443/products.json", "https://169.254.169.254/"]) {
      const store = fakeStore({ override: u => (u.toString().startsWith("https://shop.example.com/products.json") ? statusResp(302, { location }) : undefined) });
      const { body } = await call("https://shop.example.com/", store);
      assert(body.status === "unsupported", `${location}: status ${body.status}`);
      eq(store.log.calls.length, 1, `${location}: request count`);
    }
  });

  await test("bare → www redirect is the same store: followed, later pages + meta use www origin", async () => {
    const store = fakeStore({
      pages: { 1: productsRange(0, 25), 2: productsRange(25, 3) },
      override: u => (u.hostname === "shop.example.com" ? statusResp(301, { location: `https://www.shop.example.com${u.pathname}${u.search}` }) : undefined),
    });
    const { body } = await call("https://shop.example.com/", store);
    assert(body.status === "success", `status ${body.status}`);
    eq(body.products.length, 28, "product count");
    eq(store.log.calls.slice(1), [
      "https://www.shop.example.com/products.json?limit=25&page=1",
      "https://www.shop.example.com/meta.json",
      "https://www.shop.example.com/products.json?limit=25&page=2",
    ], "follow-up requests");
    assert(body.products[0].productUrl === "https://www.shop.example.com/products/p-0", `productUrl ${body.products[0].productUrl}`);
  });

  await test("more than 3 redirects → rejected after 4 hops", async () => {
    let n = 0;
    const store = fakeStore({ override: () => statusResp(302, { location: `https://shop.example.com/products.json?hop=${++n}` }) });
    const { body } = await call("https://shop.example.com/", store);
    assert(body.status === "unsupported", `status ${body.status}`);
    eq(store.log.calls.length, 4, "1 request + 3 redirects");
  });

  await test("isSameStoreOrigin rules", () => {
    const base = new URL("https://shop.example.com");
    assert(mod.isSameStoreOrigin(new URL("https://www.shop.example.com/x"), base), "www variant");
    assert(mod.isSameStoreOrigin(new URL("https://shop.example.com/x"), new URL("https://www.shop.example.com")), "www → bare");
    assert(!mod.isSameStoreOrigin(new URL("https://shop.example.com.evil.net/"), base), "suffix trick");
    assert(!mod.isSameStoreOrigin(new URL("https://other.example.com/"), base), "sibling subdomain");
    assert(!mod.isSameStoreOrigin(new URL("http://shop.example.com/"), base), "downgrade");
  });

  console.log("\n-- currency via meta.json --");

  await test("meta.json currency is injected into every product's price", async () => {
    const store = fakeStore({ pages: { 1: productsRange(0, 2) }, meta: { name: "Shop", currency: "EUR", domain: "shop.example.com" } });
    const { body } = await call("https://shop.example.com/", store);
    eq(body.store.currency, "EUR", "store currency");
    assert(body.products.every(p => p.facts.price?.currency === "EUR"), "product currency not injected");
  });

  for (const [label, metaResponse] of [
    ["404", statusResp(404)],
    ["non-JSON", textResp("<html/>")],
    ["no currency field", jsonResp({ name: "Shop" })],
    ["non-ISO currency", jsonResp({ currency: "$$" })],
  ] as Array<[string, StoreRawResponse]>) {
    await test(`meta.json ${label} → currency "unknown", batch still succeeds`, async () => {
      const store = fakeStore({ pages: { 1: productsRange(0, 3) }, metaResponse });
      const { body } = await call("https://shop.example.com/", store);
      assert(body.status === "success" && body.products.length === 3, `status ${body.status}`);
      eq(body.store.currency, "unknown", "store currency");
      assert(body.products.every(p => p.facts.price?.currency === "unknown"), "product currency must be unknown");
    });
  }

  console.log("\n-- per-store cache (10 min) --");

  await test("same user + store within 10 min → second call makes zero requests", async () => {
    __resetStoreImportCacheForTests();
    let t = 1_000_000;
    const store = fakeStore({ pages: { 1: productsRange(0, 3) } });
    const opts = { userId: "cache-user", now: () => t };
    const first = await call("https://shop.example.com/collections/mugs", store, opts);
    const n = store.log.calls.length;
    t += 9 * 60 * 1000;
    const second = await call("https://shop.example.com/collections/mugs?page=2", store, opts);
    eq(store.log.calls.length, n, "requests on cache hit");
    eq(second.body.products.length, first.body.products.length, "cached payload");
    t += 2 * 60 * 1000; // now 11 min after the first call
    await call("https://shop.example.com/collections/mugs", store, opts);
    assert(store.log.calls.length > n, "expired entry must refetch");
  });

  await test("cache is keyed by user and by collection", async () => {
    __resetStoreImportCacheForTests();
    const store = fakeStore({ pages: { 1: productsRange(0, 3) } });
    await call("https://shop.example.com/collections/mugs", store, { userId: "u-a" });
    const n1 = store.log.calls.length;
    await call("https://shop.example.com/collections/mugs", store, { userId: "u-b" });
    const n2 = store.log.calls.length;
    await call("https://shop.example.com/collections/cups", store, { userId: "u-a" });
    assert(n2 > n1, "another user must not share the cache");
    assert(store.log.calls.length > n2, "another collection must not share the cache");
  });

  await test("unsupported / failed results are NOT cached", async () => {
    __resetStoreImportCacheForTests();
    const store = fakeStore({ override: () => statusResp(403) });
    await call("https://shop.example.com/", store, { userId: "u-403" });
    await call("https://shop.example.com/", store, { userId: "u-403" });
    eq(store.log.calls.length, 2, "each unsupported attempt re-asks once");
  });

  console.log("\n-- facts mapping (FR-02 parser, no html) --");

  await test("brand=vendor, price, compareAt '0.00' treated as none, availability, description stripped", async () => {
    const store = fakeStore({
      pages: { 1: [
        product(1),
        product(2, { variants: [{ price: "20.00", compare_at_price: "25.00", available: false }] }),
        product(3, { variants: [{ price: "20.00", compare_at_price: "20.00", available: true }] }),
        product(4, { variants: [{ price: "20.00", compare_at_price: null, available: true }] }),
      ] },
      meta: { currency: "USD" },
    });
    const { body } = await call("https://shop.example.com/", store);
    const [a, b, c, d] = body.products;
    eq(a.facts.brand, "Acme", "brand");
    eq(a.facts.price, { amount: "19.00", currency: "USD" }, "price without compareAt");
    eq(a.facts.availability, "in_stock", "availability");
    eq(a.facts.source, "shopify_json", "source");
    eq(a.facts.completeness, "full", "completeness");
    eq(a.facts.description, "Soft merino knit.", "description");
    eq(a.facts.sourceUrl, "https://shop.example.com/products/p-1", "sourceUrl");
    eq(b.facts.price, { amount: "20.00", currency: "USD", compareAt: "25.00" }, "real compareAt kept");
    eq(b.facts.availability, "out_of_stock", "sold out");
    assert(!("compareAt" in (c.facts.price ?? {})), "compareAt equal to price must be dropped");
    assert(!("compareAt" in (d.facts.price ?? {})), "null compareAt must be dropped");
    eq(a.productUrl, "https://shop.example.com/products/p-1", "productUrl");
  });

  await test("images: protocol-relative normalised, first = imageUrl, capped at 8; image-less product kept without imageUrl", async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ src: `//cdn.shopify.com/i${i}.jpg` }));
    const store = fakeStore({ pages: { 1: [product(1, { images: many }), product(2, { images: [] }), product(3, { images: [{ src: "javascript:alert(1)" }, null] })] } });
    const { body } = await call("https://shop.example.com/", store);
    const [a, b, c] = body.products;
    eq(a.imageUrl, "https://cdn.shopify.com/i0.jpg", "first image");
    eq(a.images.length, 8, "image cap");
    eq(a.facts.images?.length, 8, "facts images");
    assert(b && !b.imageUrl && b.images.length === 0 && b.facts.title === "Product 2", "image-less product must stay with facts");
    assert(c && !c.imageUrl, "non-http image must be dropped");
  });

  await test("a malformed product does not sink the batch", async () => {
    const store = fakeStore({ pages: { 1: [product(1), null, "x", { handle: "bad", body_html: 42, variants: "nope" }, product(2)] } });
    const { body } = await call("https://shop.example.com/", store);
    assert(body.status === "success", `status ${body.status}`);
    assert(body.products.some(p => p.handle === "p-1") && body.products.some(p => p.handle === "p-2"), "good products lost");
  });

  console.log("\n-- client helpers (link routing, selection, save items) --");

  await test("isStoreImportUrl: myshopify or /collections/, never a product page", () => {
    const yes = [
      "https://acme.myshopify.com",
      "https://acme.myshopify.com/collections/all",
      "https://shop.example.com/collections/new-arrivals",
      "https://shop.example.com/en-gb/collections/mugs?sort=price",
    ];
    const no = [
      "https://shop.example.com/",
      "https://shop.example.com/products/blue-mug",
      "https://acme.myshopify.com/products/blue-mug",
      "https://shop.example.com/collections/mugs/products/blue-mug",
      "https://shop.example.com/collections/a\nhttps://shop.example.com/collections/b",
      "ftp://acme.myshopify.com/",
      "https://notmyshopify.com/",
      "",
    ];
    for (const u of yes) assert(client.isStoreImportUrl(u), `should route to store import: ${u}`);
    for (const u of no) assert(!client.isStoreImportUrl(u), `should NOT route to store import: ${JSON.stringify(u)}`);
  });

  const sample = (): StoreBatchProduct[] => [
    { handle: "a", title: "A", productUrl: "https://s.example.com/products/a", imageUrl: "https://cdn.example.com/a.jpg", images: ["https://cdn.example.com/a.jpg", "https://cdn.example.com/a2.jpg"], facts: { title: "A", brand: "Acme", price: { amount: "10.00", currency: "USD" }, sourceUrl: "https://s.example.com/products/a", fetchedAt: "2026-09-25T00:00:00.000Z", source: "shopify_json", completeness: "full" } },
    { handle: "b", title: "B", productUrl: "https://s.example.com/products/b", images: [], facts: { title: "B", sourceUrl: "https://s.example.com/products/b", fetchedAt: "2026-09-25T00:00:00.000Z", source: "shopify_json", completeness: "partial" } },
    { handle: "c", title: "C", productUrl: "https://s.example.com/products/c", imageUrl: "https://cdn.example.com/c.jpg", images: ["https://cdn.example.com/c.jpg"], facts: { title: "C", price: { amount: "5", currency: "unknown" }, sourceUrl: "https://s.example.com/products/c", fetchedAt: "2026-09-25T00:00:00.000Z", source: "shopify_json", completeness: "partial" } },
  ];

  await test("selection: default = all with image; image-less never selectable; all / none", () => {
    const ps = sample();
    const init = client.initialStoreSelection(ps);
    eq([...init].sort(), ["a", "c"], "initial");
    eq(client.selectedStoreProductCount(init, ps), 2, "count");
    const toggledB = client.toggleStoreSelection(init, "b", ps);
    assert(toggledB === init && !toggledB.has("b"), "image-less toggle must be a no-op");
    const offA = client.toggleStoreSelection(init, "a", ps);
    eq([...offA], ["c"], "toggle off");
    assert(init.has("a"), "toggle must not mutate the previous set");
    eq(client.selectedStoreProductCount(client.selectNoStoreProducts(), ps), 0, "none");
    eq([...client.selectAllStoreProducts(ps)].sort(), ["a", "c"], "all");
  });

  await test("toStoreAssetSaveItems: skips image-less even if selected; carries store, collection, facts, price", () => {
    const ps = sample();
    const items = client.toStoreAssetSaveItems(
      { store: { domain: "s.example.com", collectionHandle: "mugs", currency: "USD" }, products: ps },
      new Set(["a", "b", "c"]),
    );
    eq(items.map(i => i.productUrl), ["https://s.example.com/products/a", "https://s.example.com/products/c"], "saved products");
    const a = items[0];
    eq([a.store, a.collectionHandle, a.sourceDomain, a.price, a.currency], ["s.example.com", "mugs", "s.example.com", "10.00", "USD"], "a fields");
    eq(a.facts?.brand, "Acme", "facts carried");
    eq(a.allImages.length, 2, "all images carried");
    assert(items[1].price === "5" && items[1].currency === undefined, "unknown currency must not be stored");
    const noColl = client.toStoreAssetSaveItems({ store: { domain: "s.example.com", currency: "USD" }, products: ps }, new Set(["a"]));
    assert(!("collectionHandle" in noColl[0]), "store root must not invent a collection");
  });

  await test("storeProductPriceLabel hides an unknown currency", () => {
    const ps = sample();
    eq(client.storeProductPriceLabel(ps[0]), "10.00 USD", "known");
    eq(client.storeProductPriceLabel(ps[1]), null, "no price");
    eq(client.storeProductPriceLabel(ps[2]), "5", "unknown currency");
  });

  await test("picker saves store batches to My Products only (source check: store_batch, no selection/draft/schedule)", () => {
    // Normalise line endings first: a CRLF checkout must not turn the "end of
    // function" search into "rest of file" (which then matches unrelated words).
    const picker = readFileSync(join(process.cwd(), "src/components/studio/InlineCreateAssetPicker.tsx"), "utf8").replace(/\r\n/g, "\n");
    const start = picker.indexOf("function saveStoreBatchProducts");
    assert(start >= 0, "saveStoreBatchProducts missing");
    const end = picker.indexOf("\n  }\n", start);
    assert(end > start, "saveStoreBatchProducts end not found");
    const body = picker.slice(start, end);
    assert(body.includes('source:           "store_batch"'), "source must be store_batch");
    assert(body.includes("collectionHandle") && body.includes("store:"), "store / collection not recorded");
    assert(!/addToSelection|draft|schedule|generate/i.test(body.replace(/\/\*[\s\S]*?\*\//g, "")), "batch save must not select, draft, schedule or generate");
    assert(picker.includes("onSaveStoreProducts={saveStoreBatchProducts}"), "panel not wired");
    const panel = readFileSync(join(process.cwd(), "src/components/studio/ProductUrlImportPanel.tsx"), "utf8");
    assert(panel.includes("isStoreImportUrl") && panel.includes("url-import-open-store"), "panel routing / button missing");
  });

  console.log(`\nStore products import: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run();
