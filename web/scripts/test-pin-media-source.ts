/**
 * test-pin-media-source.ts
 *
 * Guards the exact `media_source` Pinterest receives for a Pin — the request shape
 * is the whole feature: get it wrong and a merchant's 3-image Content either
 * publishes as one image (silent truncation) or is rejected outright.
 *
 * Covers the builder (1 image → image_url, 2–5 → multiple_image_urls with per-item
 * copy/link) AND the count gate in front of it, so an over-long set is proven to be
 * REFUSED rather than trimmed to fit.
 *
 * Run: npx tsx scripts/test-pin-media-source.ts (from web/)
 */

import assert from "node:assert/strict";
import { buildPinMediaSource } from "../src/lib/server/pinterest/pinMediaSource";
import { checkPinterestMedia, toMediaItems } from "../src/lib/publish/mediaRules";

let passed = 0, failed = 0;
function test(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  OK   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n     ${(e as Error).stack ?? (e as Error).message}`); }
}

const URLS = [
  "https://cdn.test/one.jpg",
  "https://cdn.test/two.jpg",
  "https://cdn.test/three.jpg",
];

test("1 image → the unchanged single-image shape", () => {
  const media = buildPinMediaSource({
    imageUrls: [URLS[0]],
    title: "Cozy chair",
    description: "A chair",
    link: "https://shop.test/chair",
  });
  // Exactly the two keys Pinterest expects for a single image — no items array,
  // no per-item copy, nothing new leaking into the legacy request.
  assert.deepEqual(media, { source_type: "image_url", url: URLS[0] });
});

test("3 images → multiple_image_urls carrying every image in the given order", () => {
  const media = buildPinMediaSource({
    imageUrls: URLS,
    title: "Cozy chair",
    description: "A chair",
    link: "https://shop.test/chair",
  });
  assert.equal(media.source_type, "multiple_image_urls");
  assert.equal(media.source_type === "multiple_image_urls" && media.items.length, 3);
  assert.deepEqual(
    media.source_type === "multiple_image_urls" ? media.items.map(i => i.url) : [],
    URLS,
    "order must be the Content's display order — no server-side reordering",
  );
});

test("3 images → each item carries the Pin's title, description and link", () => {
  const media = buildPinMediaSource({
    imageUrls: URLS,
    title: "Cozy chair",
    description: "A chair",
    link: "https://shop.test/chair",
  });
  assert.equal(media.source_type, "multiple_image_urls");
  if (media.source_type !== "multiple_image_urls") return;
  for (const item of media.items) {
    assert.equal(item.title, "Cozy chair");
    assert.equal(item.description, "A chair");
    assert.equal(item.link, "https://shop.test/chair");
  }
});

test("undefined/blank per-item fields are OMITTED, never sent as empty or null", () => {
  const media = buildPinMediaSource({ imageUrls: URLS, title: "   ", description: undefined });
  assert.equal(media.source_type, "multiple_image_urls");
  if (media.source_type !== "multiple_image_urls") return;
  for (const item of media.items) {
    assert.deepEqual(Object.keys(item), ["url"], `unexpected keys: ${Object.keys(item).join(",")}`);
    assert.ok(!("title" in item));
    assert.ok(!("description" in item));
    assert.ok(!("link" in item));
  }
});

test("2 and 5 images (the carousel bounds) both build a carousel", () => {
  for (const n of [2, 5]) {
    const media = buildPinMediaSource({ imageUrls: URLS.slice(0, 1).concat(Array.from({ length: n - 1 }, (_, i) => `https://cdn.test/x${i}.jpg`)) });
    assert.equal(media.source_type, "multiple_image_urls", `n=${n}`);
    assert.equal(media.source_type === "multiple_image_urls" && media.items.length, n, `n=${n}`);
  }
});

test("blank entries are dropped, and the URLs are trimmed", () => {
  const media = buildPinMediaSource({ imageUrls: ["  https://cdn.test/a.jpg  ", "", "   ", "https://cdn.test/b.jpg"] });
  assert.equal(media.source_type, "multiple_image_urls");
  assert.deepEqual(
    media.source_type === "multiple_image_urls" ? media.items.map(i => i.url) : [],
    ["https://cdn.test/a.jpg", "https://cdn.test/b.jpg"],
  );
});

test("no images at all throws — a Pin is never invented from nothing", () => {
  assert.throws(() => buildPinMediaSource({ imageUrls: [] }), /at least one image/);
  assert.throws(() => buildPinMediaSource({ imageUrls: ["   "] }), /at least one image/);
});

test("6 images are REFUSED before a request is built — never truncated to 5", () => {
  const six = Array.from({ length: 6 }, (_, i) => `https://cdn.test/${i}.jpg`);
  const check = checkPinterestMedia(toMediaItems(six));
  assert.equal(check.ok, false, "6 images must not pass the Pinterest media gate");
  assert.equal(check.ok === false && check.code, "too_many");

  // The builder itself does NOT truncate: if it were ever reached with 6 it would
  // send all 6 and let Pinterest reject. Truncation must never be a silent success.
  const media = buildPinMediaSource({ imageUrls: six });
  assert.equal(media.source_type === "multiple_image_urls" && media.items.length, 6);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
