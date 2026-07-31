/**
 * Unit tests for FailureBanner's pure logic (PRD "Create Pins & Plan 失败情况优化"
 * §2): count→copy mapping (title/body/cta) and the session-dismiss visibility rule,
 * including the "CTA click = dismiss" semantics (PRD §2.2). Run:
 * npx tsx scripts/test-failure-banner.ts (from web/)
 *
 * Component rendering (count===0 → null, context-suppression while filter==="failed")
 * is intentionally NOT covered here (no React test renderer in this repo) — only the
 * extracted pure helpers are exercised. Context suppression itself is a plain JSX
 * conditional in StudioBoard.tsx (`{filter !== "failed" && <FailureBanner .../>}`),
 * not a pure function, so it isn't unit-testable here either; verified by inspection.
 */

import assert from "node:assert";
import { getFailureBannerCopy, computeVisibleFailureCount, failureBannerDismissKey } from "../src/components/shared/FailureBanner";

let passed = 0, failed = 0;
function test(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  OK ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n     ${(e as Error).stack ?? (e as Error).message}`); }
}

// ── getFailureBannerCopy (PRD §2.1 wording) ──────────────────────────────────────

test("copy: singular for count === 1", () => {
  const { title, body, cta } = getFailureBannerCopy(1);
  assert.equal(title, "1 Pin failed to publish");
  assert.equal(body, "Review the error and choose how to continue.");
  assert.equal(cta, "Review failed Pin");
});

test("copy: plural for count > 1", () => {
  const { title, body, cta } = getFailureBannerCopy(3);
  assert.equal(title, "3 Pins failed to publish");
  assert.equal(body, "Review the errors and choose how to continue.");
  assert.equal(cta, "Review failed Pins");
});

test("copy: plural wording used for count === 0 too (caller gates rendering, not this fn)", () => {
  const { title } = getFailureBannerCopy(0);
  assert.equal(title, "0 Pins failed to publish");
});

// ── computeVisibleFailureCount (session-dismiss rule, PRD §2.2) ──────────────────
// Both the × close AND the CTA (which now calls onDismiss before onReview — see
// FailureBanner's handleReview) drive this same dismissedAt state, so this pure
// function covers the "dismiss" half of "CTA click = dismiss" for both entry points;
// the "and also navigate" half is a side effect (onReview call) verified by inspection
// of FailureBanner.tsx's handleReview (onDismiss?.() then onReview()).

test("visible: never dismissed (dismissedAt=null) → full count shows", () => {
  assert.equal(computeVisibleFailureCount(2, null), 2);
  assert.equal(computeVisibleFailureCount(0, null), 0);
});

test("visible: dismissed at same count → hidden (0)", () => {
  assert.equal(computeVisibleFailureCount(2, 2), 0);
});

test("visible: dismissed, count later dropped (Retry fixed one) → still hidden", () => {
  assert.equal(computeVisibleFailureCount(1, 2), 0);
});

test("visible: dismissed, NEW failure pushes count above dismissedAt → reappears", () => {
  assert.equal(computeVisibleFailureCount(3, 2), 3);
});

test("visible: dismissed at 0 is a no-op state — any positive count shows", () => {
  assert.equal(computeVisibleFailureCount(1, 0), 1);
});

// ── Per-surface, persistent dismiss storage (real-device QA fixes) ───────────────
// The hook itself needs React, so these exercise the storage contract it is built on:
// failureBannerDismissKey() namespacing + the same read → computeVisibleFailureCount
// pipeline useFailureBannerDismiss runs on mount. A tiny localStorage stand-in lets us
// model "same browser, new tab/session" (localStorage survives) precisely.

type Surface = "plan" | "studio";
class FakeStorage {
  private map = new Map<string, string>();
  getItem(k: string): string | null { return this.map.has(k) ? this.map.get(k)! : null; }
  setItem(k: string, v: string): void { this.map.set(k, v); }
  removeItem(k: string): void { this.map.delete(k); }
  get size(): number { return this.map.size; }
}
/** Mirrors the hook's write path. */
function dismissAt(store: FakeStorage, surface: Surface, count: number): void {
  store.setItem(failureBannerDismissKey(surface), String(count));
}
/** Mirrors the hook's mount path: hydrate dismissedAt from storage, then compute. */
function visibleOnMount(store: FakeStorage, surface: Surface, count: number): number {
  const raw = store.getItem(failureBannerDismissKey(surface));
  const n = raw === null ? null : Number(raw);
  const dismissedAt = n !== null && Number.isFinite(n) ? n : null;
  return computeVisibleFailureCount(count, dismissedAt);
}

test("key: plan and studio get distinct, surface-namespaced storage keys", () => {
  assert.equal(failureBannerDismissKey("plan"), "vp:failure_banner:dismissed_at_count:plan");
  assert.equal(failureBannerDismissKey("studio"), "vp:failure_banner:dismissed_at_count:studio");
  assert.notEqual(failureBannerDismissKey("plan"), failureBannerDismissKey("studio"));
});

test("surfaces are independent: Plan dismissed at 28 does NOT suppress Create Pins' 3→4", () => {
  // The exact QA repro: Plan counts the whole population (28), Create Pins counts only
  // board-scoped failures (3). With one shared key, 28 swallowed the studio banner
  // forever — computeVisibleFailureCount(4, 28) === 0 — hiding a brand-new failure.
  const store = new FakeStorage();
  dismissAt(store, "plan", 28);
  assert.equal(visibleOnMount(store, "plan", 28), 0);   // Plan stays dismissed
  assert.equal(visibleOnMount(store, "studio", 3), 3);  // studio never dismissed → shows
  assert.equal(visibleOnMount(store, "studio", 4), 4);  // NEW studio failure → still shows
  // And the reverse direction is equally isolated.
  dismissAt(store, "studio", 4);
  assert.equal(visibleOnMount(store, "studio", 4), 0);
  assert.equal(visibleOnMount(store, "plan", 29), 29);  // new Plan failure breaks through
});

test("persistence: a dismiss survives a fresh session/tab (localStorage), until count rises", () => {
  // localStorage (not sessionStorage): a new tab / browser restart re-reads the SAME
  // store, so a banner the user already reviewed must NOT come back.
  const store = new FakeStorage();
  dismissAt(store, "studio", 3);
  // "New session": fresh mount, in-memory state gone, storage retained.
  assert.equal(visibleOnMount(store, "studio", 3), 0);
  assert.equal(visibleOnMount(store, "studio", 2), 0);  // count dropped → still hidden
  assert.equal(visibleOnMount(store, "studio", 5), 5);  // NEW failures → reappears
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
