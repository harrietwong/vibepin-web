/**
 * test-media-rules.ts
 *
 * Guards the per-platform media rules for multi-image publishing: counts, aspect
 * ratio tolerance, and — the one that matters most — that unknown dimensions never
 * fail a publish. A set the rules reject must NEVER be truncated to the cover
 * image, so these checks are the only thing standing between "publish 5 of 8" and
 * an honest, actionable refusal.
 *
 * Run: npx tsx scripts/test-media-rules.ts (from web/)
 */

import assert from "node:assert/strict";
import {
  ASPECT_RATIO_TOLERANCE,
  FACEBOOK_PHOTO_MAX,
  INSTAGRAM_CAROUSEL_MAX,
  PINTEREST_CAROUSEL_MAX,
  PINTEREST_CAROUSEL_MIN,
  checkFacebookMedia,
  checkInstagramMedia,
  checkPinterestMedia,
  toMediaItems,
  type PublishMediaItem,
} from "../src/lib/publish/mediaRules";

let passed = 0, failed = 0;
function test(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  OK   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n     ${(e as Error).stack ?? (e as Error).message}`); }
}

/** N square images with known dimensions (so the ratio rule really evaluates). */
function square(n: number): PublishMediaItem[] {
  return Array.from({ length: n }, (_, i) => ({ url: `https://cdn.test/${i}.jpg`, width: 1000, height: 1000 }));
}
/** N url-only images — what every live server path actually passes today. */
function urlsOnly(n: number): PublishMediaItem[] {
  return toMediaItems(Array.from({ length: n }, (_, i) => `https://cdn.test/${i}.jpg`));
}

// ── Counts ───────────────────────────────────────────────────────────────────

test("exported limits match the platform contracts", () => {
  assert.equal(PINTEREST_CAROUSEL_MIN, 2);
  assert.equal(PINTEREST_CAROUSEL_MAX, 5);
  assert.equal(INSTAGRAM_CAROUSEL_MAX, 10);
  assert.equal(FACEBOOK_PHOTO_MAX, 10);
});

test("empty / blank-url sets are no_media on every platform", () => {
  for (const check of [checkPinterestMedia, checkInstagramMedia, checkFacebookMedia]) {
    for (const input of [[], null, undefined, [{ url: "   " }]]) {
      const r = check(input as PublishMediaItem[]);
      assert.equal(r.ok, false);
      assert.equal(r.ok === false && r.code, "no_media");
    }
  }
});

test("a single image is valid everywhere (never 'too few')", () => {
  assert.equal(checkPinterestMedia(square(1)).ok, true);
  assert.equal(checkInstagramMedia(square(1)).ok, true);
  assert.equal(checkFacebookMedia(square(1)).ok, true);
});

test("Pinterest accepts 2–5 and rejects 6 with a countable, actionable message", () => {
  for (const n of [2, 3, 4, 5]) assert.equal(checkPinterestMedia(square(n)).ok, true, `n=${n}`);
  const r = checkPinterestMedia(square(6));
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.code, "too_many");
  assert.match(r.ok === false ? r.message : "", /up to 5 images/);
  assert.match(r.ok === false ? r.message : "", /Remove 1\b/);
});

test("Instagram accepts up to 10 and rejects 11", () => {
  assert.equal(checkInstagramMedia(square(10)).ok, true);
  const r = checkInstagramMedia(square(11));
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.code, "too_many");
  assert.match(r.ok === false ? r.message : "", /Remove 1\b/);
});

test("Facebook accepts up to 10 and rejects 12 (Remove 2)", () => {
  assert.equal(checkFacebookMedia(square(10)).ok, true);
  const r = checkFacebookMedia(square(12));
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.code, "too_many");
  assert.match(r.ok === false ? r.message : "", /Remove 2\b/);
});

// ── Aspect ratio ─────────────────────────────────────────────────────────────

test("Pinterest: identical ratios at different pixel sizes pass", () => {
  const items: PublishMediaItem[] = [
    { url: "a", width: 1000, height: 1500 },
    { url: "b", width: 800, height: 1200 },
    { url: "c", width: 600, height: 900 },
  ];
  const r = checkPinterestMedia(items);
  assert.equal(r.ok, true);
  assert.equal(r.ok === true && r.unverifiedRatio, undefined);
});

test("Pinterest: a ratio just inside the 2% tolerance passes", () => {
  // 1000/1500 = 0.6667; 1013/1500 = 0.6753 → +1.3% relative. Inside tolerance.
  const inside: PublishMediaItem[] = [
    { url: "a", width: 1000, height: 1500 },
    { url: "b", width: 1013, height: 1500 },
  ];
  assert.equal(checkPinterestMedia(inside).ok, true);
  assert.ok(ASPECT_RATIO_TOLERANCE === 0.02);
});

test("Pinterest: a ratio just outside the tolerance fails as aspect_mismatch", () => {
  // 1030/1500 vs 1000/1500 → +3% relative. Outside tolerance.
  const outside: PublishMediaItem[] = [
    { url: "a", width: 1000, height: 1500 },
    { url: "b", width: 1030, height: 1500 },
  ];
  const r = checkPinterestMedia(outside);
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.code, "aspect_mismatch");
  assert.match(r.ok === false ? r.message : "", /same aspect ratio/);
  assert.match(r.ok === false ? r.message : "", /1 image needs adjustment/);
});

test("Pinterest: the mismatch message counts EVERY offending image", () => {
  const items: PublishMediaItem[] = [
    { url: "a", width: 1000, height: 1500 },  // reference
    { url: "b", width: 1000, height: 1000 },  // off
    { url: "c", width: 1600, height: 900 },   // off
    { url: "d", width: 800, height: 1200 },   // matches the reference
  ];
  const r = checkPinterestMedia(items);
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.message : "", /2 images need adjustment/);
});

test("Pinterest: the FIRST image is the reference ratio, not the majority", () => {
  // Three 1:1 and one 2:3 cover. The cover defines the ratio, so 3 are outliers.
  const items: PublishMediaItem[] = [
    { url: "cover", width: 1000, height: 1500 },
    { url: "b", width: 1000, height: 1000 },
    { url: "c", width: 1000, height: 1000 },
    { url: "d", width: 1000, height: 1000 },
  ];
  const r = checkPinterestMedia(items);
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.message : "", /3 images need adjustment/);
});

test("Instagram never fails on ratio — it crops to the first item instead", () => {
  const mixed: PublishMediaItem[] = [
    { url: "a", width: 1000, height: 1500 },
    { url: "b", width: 1600, height: 900 },
  ];
  assert.equal(checkInstagramMedia(mixed).ok, true);
});

test("Facebook never fails on ratio", () => {
  const mixed: PublishMediaItem[] = [
    { url: "a", width: 1000, height: 1500 },
    { url: "b", width: 1600, height: 900 },
  ];
  assert.equal(checkFacebookMedia(mixed).ok, true);
});

// ── Unknown dimensions ───────────────────────────────────────────────────────

test("url-only items pass everywhere and are flagged unverifiedRatio", () => {
  const p = checkPinterestMedia(urlsOnly(4));
  assert.equal(p.ok, true);
  assert.equal(p.ok === true && p.unverifiedRatio, true);
  const i = checkInstagramMedia(urlsOnly(4));
  assert.equal(i.ok === true && i.unverifiedRatio, true);
  const f = checkFacebookMedia(urlsOnly(4));
  assert.equal(f.ok === true && f.unverifiedRatio, true);
});

test("ONE unknown dimension makes the whole set unverified — never a mismatch", () => {
  const items: PublishMediaItem[] = [
    { url: "a", width: 1000, height: 1500 },
    { url: "b" }, // dimensions unknown
    { url: "c", width: 1600, height: 900 }, // would be an outlier if measurable
  ];
  const r = checkPinterestMedia(items);
  assert.equal(r.ok, true, "an unmeasurable set must never be blocked on ratio");
  assert.equal(r.ok === true && r.unverifiedRatio, true);
});

test("zero / negative / non-finite dimensions count as unknown, not as a ratio", () => {
  for (const bad of [{ width: 0, height: 100 }, { width: 100, height: 0 }, { width: -10, height: 100 }, { width: Number.NaN, height: 100 }]) {
    const r = checkPinterestMedia([{ url: "a", width: 1000, height: 1000 }, { url: "b", ...bad }]);
    assert.equal(r.ok, true, JSON.stringify(bad));
    assert.equal(r.ok === true && r.unverifiedRatio, true, JSON.stringify(bad));
  }
});

test("count limits are enforced even when dimensions are unknown", () => {
  // The over-count refusal must not be skipped just because the ratio is unverifiable.
  assert.equal(checkPinterestMedia(urlsOnly(6)).ok, false);
  assert.equal(checkInstagramMedia(urlsOnly(11)).ok, false);
  assert.equal(checkFacebookMedia(urlsOnly(11)).ok, false);
});

test("a single url-only image is plainly ok (no unverified noise for one image)", () => {
  const r = checkPinterestMedia(urlsOnly(1));
  assert.equal(r.ok, true);
  assert.equal(r.ok === true && r.unverifiedRatio, undefined);
});

// ── Message hygiene ──────────────────────────────────────────────────────────

test("no failure message leaks an HTTP status, an id, or an internal code", () => {
  const messages: string[] = [];
  for (const r of [
    checkPinterestMedia(square(9)),
    checkPinterestMedia([{ url: "a", width: 1, height: 2 }, { url: "b", width: 2, height: 1 }]),
    checkInstagramMedia(square(20)),
    checkFacebookMedia(square(20)),
    checkPinterestMedia([]),
  ]) {
    if (r.ok === false) messages.push(r.message);
  }
  assert.equal(messages.length, 5);
  for (const m of messages) {
    assert.doesNotMatch(m, /\b(4\d\d|5\d\d)\b/, `HTTP-looking status in: ${m}`);
    assert.doesNotMatch(m, /_/, `internal code in: ${m}`);
    assert.ok(/[.!]$/.test(m.trim()), `not a sentence: ${m}`);
  }
});

test("toMediaItems drops blanks and preserves order", () => {
  const items = toMediaItems(["  https://a  ", "", "   ", "https://b"]);
  assert.deepEqual(items, [{ url: "  https://a  " }, { url: "https://b" }]);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
