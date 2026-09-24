/**
 * Amazon page adapter — fixture-driven (real pages captured 2026-09-24, see
 * scripts/fixtures/amazon/). Bot-check detection, title / bullets / brand
 * extraction, and the "never price / never images" rule.
 *
 * Run: npx tsx scripts/test-amazon-adapter.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AMAZON_MAX_BULLETS,
  amazonAdapter,
  cleanAmazonTitle,
  detectAmazonBotCheck,
  extractAmazonBrand,
} from "../src/lib/productUrlImport/adapters/amazon";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
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
const ECHO = fixture("product-echo-dot-B07FZ8S74R.html");
const BOOK = fixture("book-catcher-0316769487.html");

console.log("\n-- bot check (HTTP 200 is not success) --");

test("real 200 bot page → blocked with all four signals", () => {
  const v = detectAmazonBotCheck(BOT);
  assert(v.blocked, "bot page not blocked");
  for (const s of ["captcha_form", "bare_title", "no_product_title", "small_body"]) assert(v.signals.includes(s), `missing ${s}`);
  const r = amazonAdapter(BOT);
  assert(r.status === "blocked" && r.reason === "bot_check", JSON.stringify(r));
});

test("real product fixtures are NOT blocked (small excerpt alone is one signal)", () => {
  for (const [name, html] of [["macbook", MACBOOK], ["echo", ECHO], ["book", BOOK]] as const) {
    const v = detectAmazonBotCheck(html);
    assert(!v.blocked, `${name} blocked: ${v.signals.join(",")}`);
  }
});

test("any two signals block: captcha form + small body, even with a product-like title", () => {
  const html = `<html><head><title>Some product</title></head><body><span id="productTitle">x</span><form action="/errors/validateCaptcha"></form></body></html>`;
  assert(detectAmazonBotCheck(html).blocked, "captcha + small body should block");
});

test("single signal does not block: large page without #productTitle", () => {
  const html = `<html><head><title>Amazon.com: Great Lamp : Home</title></head><body>${"x".repeat(25_000)}</body></html>`;
  const v = detectAmazonBotCheck(html);
  assert(!v.blocked && v.signals.length === 1, JSON.stringify(v));
});

test("bare-title + no productTitle on a large page blocks (e.g. interstitial)", () => {
  const html = `<html><head><title>Amazon.co.uk</title></head><body>${"y".repeat(30_000)}</body></html>`;
  assert(detectAmazonBotCheck(html).blocked, "should block");
});

console.log("\n-- extraction (calibrated on real pages) --");

test("MacBook: productTitle, 6 of 7 bullets, brand from 'Visit the Apple Store'", () => {
  const r = amazonAdapter(MACBOOK);
  assert(r.status === "success", JSON.stringify(r).slice(0, 200));
  assert(r.title?.startsWith("Apple 2023 MacBook Pro Laptop with Apple M2 Pro chip"), `title: ${r.title}`);
  assert(!/Amazon\.com/.test(r.title ?? ""), "title keeps Amazon framing");
  assert(r.bullets.length === AMAZON_MAX_BULLETS, `bullets: ${r.bullets.length}`);
  assert(r.bullets[0].startsWith("SUPERCHARGED BY M2 PRO OR M2 MAX"), r.bullets[0]);
  assert(r.bullets.every(b => b.length <= 200), "bullet over 200 chars");
  assert(r.bullets.some(b => b.endsWith("…")), "long bullet should be clipped with an ellipsis");
  assert(r.brand === "Apple", `brand: ${r.brand}`);
});

test("Echo Dot: title, bullets, brand from 'Brand: Amazon'", () => {
  const r = amazonAdapter(ECHO);
  assert(r.status === "success" && r.title === "Echo Dot (3rd Gen, 2018 release) - Smart speaker with Alexa - Charcoal", `title: ${r.status === "success" ? r.title : r.status}`);
  assert(r.bullets[0] === "MEET ECHO DOT - Our most compact smart speaker that fits perfectly into small spaces.", r.bullets[0]);
  assert(r.brand === "Amazon", `brand: ${r.brand}`);
});

test("Book: title only; author byline is NOT a brand", () => {
  const r = amazonAdapter(BOOK);
  assert(r.status === "success" && r.title === "The Catcher in the Rye", JSON.stringify(r));
  assert(r.bullets.length === 0, "book has no feature bullets");
  assert(r.brand === undefined, `brand leaked: ${r.brand}`);
  assert(extractAmazonBrand(BOOK) === null, "author treated as brand");
});

test("title fallback: meta title with 'Amazon.com: … : Category' framing stripped", () => {
  const html = `<html><head><meta name="title" content="Amazon.com: Linen Throw Pillow Cover 18x18 : Home &amp; Kitchen"/></head><body>${"z".repeat(25_000)}</body></html>`;
  const r = amazonAdapter(html);
  assert(r.status === "success" && r.title === "Linen Throw Pillow Cover 18x18", JSON.stringify(r).slice(0, 200));
});

test("cleanAmazonTitle handles the book-style suffix", () => {
  assert(cleanAmazonTitle("The Catcher in the Rye: Salinger, J. D.: 9780316769488: Amazon.com: Books") === "The Catcher in the Rye: Salinger, J. D.: 9780316769488", "book suffix");
  assert(cleanAmazonTitle("Amazon.com: Desk Lamp : Tools & Home Improvement") === "Desk Lamp", "prefix+category");
});

test("bullets only → partial", () => {
  const html = `<html><head></head><body>${"q".repeat(25_000)}<div id="feature-bullets"><ul><li><span class="a-list-item"> Soft &amp; warm </span></li></ul></div></body></html>`;
  const r = amazonAdapter(html);
  assert(r.status === "partial" && r.bullets[0] === "Soft & warm" && !r.title, JSON.stringify(r));
});

test("nothing extractable → failed / no_product_fields", () => {
  const r = amazonAdapter(`<html><head></head><body>${"w".repeat(25_000)}</body></html>`);
  assert(r.status === "failed" && r.reason === "no_product_fields", JSON.stringify(r));
});

console.log("\n-- honesty rules: never price / availability / rating / images --");

test("price, availability, rating and images on the page never appear in the result", () => {
  // Synthetic markup in Amazon's real class names (the captured pages had no live offer).
  const html = MACBOOK.replace("</body>", `
    <span class="a-price"><span class="a-offscreen">$1,999.00</span></span>
    <div id="availability"><span>In Stock</span></div>
    <span id="acrPopover" title="4.7 out of 5 stars"></span>
    <img id="landingImage" src="https://m.media-amazon.com/images/I/61fd2oCrvyL._AC_SL1500_.jpg" width="1500" height="1500">
    </body>`);
  const r = amazonAdapter(html);
  const json = JSON.stringify(r);
  for (const leak of ["1,999", "In Stock", "4.7 out of 5", "media-amazon", "price", "availability", "rating"]) {
    assert(!json.includes(leak), `result leaked "${leak}"`);
  }
  assert(!("candidates" in r), "adapter must not produce image candidates");
});

test("adapter source never calls the generic image extractor", () => {
  const src = readFileSync(join(process.cwd(), "src/lib/productUrlImport/adapters/amazon.ts"), "utf8");
  assert(!/extractCandidatesFromHtml|genericProductAdapter|<img/.test(src.replace(/^\s*\*.*$/gm, "")), "adapter references image extraction");
});

console.log(`\nAmazon adapter: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
