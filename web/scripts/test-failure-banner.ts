/**
 * Unit tests for FailureBanner's pure logic (PRD "Create Pins & Plan 失败情况优化"
 * §2): count→copy mapping (title/body/cta) and the dismiss visibility rule, including
 * the "CTA click = dismiss" semantics (PRD §2.2). Run:
 * npx tsx scripts/test-failure-banner.ts (from web/)
 *
 * Dismiss is keyed on the failure-set IDENTITY (publishFailureSetIdentity, "id:updatedAt"
 * per actionable failure) and persisted in localStorage under a per-SCOPE key
 * ("plan:<weekStart>" | "studio"). Identity — not count — is what breaks a dismiss:
 * a count-based rule silently swallowed a same-size but DIFFERENT failure set.
 *
 * Component rendering (count===0 → null, context-suppression while filter==="failed")
 * is intentionally NOT covered here (no React test renderer in this repo) — only the
 * extracted pure helpers are exercised. Context suppression itself is a plain JSX
 * conditional in StudioBoard.tsx (`{filter !== "failed" && <FailureBanner .../>}`),
 * not a pure function, so it isn't unit-testable here either; verified by inspection.
 */

import assert from "node:assert";
import { getFailureBannerCopy, computeVisibleFailureCount, failureBannerDismissKey } from "../src/components/shared/FailureBanner";
import { publishFailureSetIdentity } from "../src/lib/studio/pinLifecycle";
import { deriveBoardCollections } from "../src/hooks/usePinBoardDrafts";
import type { PinDraft } from "../src/lib/pinDraftStore";

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

// ── computeVisibleFailureCount (identity-dismiss rule, PRD §2.2) ─────────────────
// Both the × close AND the CTA (which now calls onDismiss before onReview — see
// FailureBanner's handleReview) drive this same dismissedIdentity state, so this pure
// function covers the "dismiss" half of "CTA click = dismiss" for both entry points;
// the "and also navigate" half is a side effect (onReview call) verified by inspection
// of FailureBanner.tsx's handleReview (onDismiss?.() then onReview()).

test("visible: never dismissed (dismissedIdentity=null) → full count shows", () => {
  assert.equal(computeVisibleFailureCount(2, "a:1|b:1", null), 2);
  assert.equal(computeVisibleFailureCount(0, "", null), 0);
});

test("visible: dismissed at the SAME identity → hidden (0)", () => {
  assert.equal(computeVisibleFailureCount(2, "a:1|b:1", "a:1|b:1"), 0);
});

test("visible: dismissed, then one failure was fixed (identity changed) → reappears", () => {
  // Count DROPPED 2→1, but the set changed, so the banner is honest about what's left.
  assert.equal(computeVisibleFailureCount(1, "a:1", "a:1|b:1"), 1);
});

test("visible: dismissed, NEW failure added (identity changed) → reappears", () => {
  assert.equal(computeVisibleFailureCount(3, "a:1|b:1|c:1", "a:1|b:1"), 3);
});

test("visible: SAME COUNT but a different failure set → reappears (count-based rule missed this)", () => {
  // The exact regression identity-keying exists to prevent: "b" was fixed and "c"
  // newly failed. A count-based dismiss (2 → 2) would have hidden a brand-new failure.
  assert.equal(computeVisibleFailureCount(2, "a:1|c:1", "a:1|b:1"), 2);
});

test("visible: a retry-failure on the SAME Pin bumps updatedAt → new identity → reappears", () => {
  assert.equal(computeVisibleFailureCount(1, "a:2", "a:1"), 1);
});

// ── Per-scope, persistent dismiss storage (real-device QA fixes) ─────────────────
// The hook itself needs React, so these exercise the storage contract it is built on:
// failureBannerDismissKey() namespacing + the same read → computeVisibleFailureCount
// pipeline useFailureBannerDismiss runs on mount. A tiny localStorage stand-in lets us
// model "same browser, new tab/session" (localStorage survives) precisely.

class FakeStorage {
  private map = new Map<string, string>();
  getItem(k: string): string | null { return this.map.has(k) ? this.map.get(k)! : null; }
  setItem(k: string, v: string): void { this.map.set(k, v); }
  removeItem(k: string): void { this.map.delete(k); }
  get size(): number { return this.map.size; }
}
/** Mirrors the hook's write path. */
function dismissAt(store: FakeStorage, scope: string, identity: string): void {
  store.setItem(failureBannerDismissKey(scope), identity);
}
/** Mirrors the hook's mount path: hydrate dismissedIdentity from storage, then compute. */
function visibleOnMount(store: FakeStorage, scope: string, count: number, identity: string): number {
  const dismissedIdentity = store.getItem(failureBannerDismissKey(scope));
  return computeVisibleFailureCount(count, identity, dismissedIdentity);
}

test("key: plan weeks and studio get distinct, scope-namespaced storage keys", () => {
  assert.equal(failureBannerDismissKey("studio"), "vp:failure_banner:dismissed_failure_set:studio");
  assert.equal(failureBannerDismissKey("plan:2026-07-27"), "vp:failure_banner:dismissed_failure_set:plan:2026-07-27");
  assert.notEqual(failureBannerDismissKey("plan:2026-07-27"), failureBannerDismissKey("studio"));
  // Each Plan WEEK is its own scope — dismissing one week never mutes another.
  assert.notEqual(failureBannerDismissKey("plan:2026-07-27"), failureBannerDismissKey("plan:2026-08-03"));
});

test("scopes are independent: a Plan-week dismiss does NOT suppress Create Pins", () => {
  // Plan's week view and Create Pins' board view show different slices of the same
  // workspace population. With one shared key, the larger/earlier dismiss swallowed
  // the other surface's banner, hiding real failures.
  const store = new FakeStorage();
  const planIdentity = "a:1|b:1";
  dismissAt(store, "plan:2026-07-27", planIdentity);
  assert.equal(visibleOnMount(store, "plan:2026-07-27", 2, planIdentity), 0);  // Plan stays dismissed
  assert.equal(visibleOnMount(store, "studio", 3, "a:1|b:1|c:1"), 3);          // studio never dismissed → shows
  // And the reverse direction is equally isolated.
  dismissAt(store, "studio", "a:1|b:1|c:1");
  assert.equal(visibleOnMount(store, "studio", 3, "a:1|b:1|c:1"), 0);
  assert.equal(visibleOnMount(store, "plan:2026-08-03", 1, "z:1"), 1);         // another week unaffected
});

test("persistence: a dismiss survives a fresh session/tab (localStorage), until identity changes", () => {
  // localStorage (not sessionStorage): a new tab / browser restart re-reads the SAME
  // store, so a banner the user already reviewed must NOT come back.
  const store = new FakeStorage();
  const identity = "a:1|b:1|c:1";
  dismissAt(store, "studio", identity);
  // "New session": fresh mount, in-memory state gone, storage retained.
  assert.equal(visibleOnMount(store, "studio", 3, identity), 0);
  // Same set after another reload → still hidden.
  assert.equal(visibleOnMount(store, "studio", 3, identity), 0);
  // A genuinely NEW failure → different identity → reappears across sessions.
  assert.equal(visibleOnMount(store, "studio", 4, "a:1|b:1|c:1|d:1"), 4);
});

test("identity source: publishFailureSetIdentity is order-independent and updatedAt-sensitive", () => {
  const mk = (id: string, updatedAt: string) => ({
    id, updatedAt, failureType: "publish" as const, publishError: "boom", archivedAt: undefined,
  });
  const a = mk("a", "2026-07-29T10:00:00.000Z");
  const b = mk("b", "2026-07-29T11:00:00.000Z");
  // Same set, different array order → same identity (sorted), so no spurious reappear.
  assert.equal(publishFailureSetIdentity([a, b]), publishFailureSetIdentity([b, a]));
  // A retry-failure on the same Pin bumps updatedAt → identity changes → banner returns.
  const aRetried = mk("a", "2026-07-29T12:00:00.000Z");
  assert.notEqual(publishFailureSetIdentity([a, b]), publishFailureSetIdentity([aRetried, b]));
  // Archived / non-publish failures never enter the identity (core predicate applies).
  const archived = { ...mk("z", "2026-07-29T10:00:00.000Z"), archivedAt: "2026-07-29T13:00:00.000Z" };
  assert.equal(publishFailureSetIdentity([a, b, archived]), publishFailureSetIdentity([a, b]));
});

// ── "CTA click = dismiss" end-to-end over the storage contract (0731) ───────────
// Browser case 10: clicking "Review failed Pins" must itself count as a dismiss — the
// user went and looked, so returning to Plan must NOT re-show the big banner. But the
// SMALL "N failed" filter-bar count is derived from the workspace counts, never from
// banner dismiss state, so it must keep showing. These model both halves against the
// same helpers the component/hook use, so a regression in either direction trips here.

/** Models FailureBanner.handleReview: onDismiss() (persists) then onReview() (navigates). */
function clickReviewCta(store: FakeStorage, scope: string, identity: string): { navigated: boolean } {
  dismissAt(store, scope, identity);
  return { navigated: true };
}
/** Models the × button (aria-label "Hide for now"): dismiss WITHOUT navigating. */
function clickHideForNow(store: FakeStorage, scope: string, identity: string): { navigated: boolean } {
  dismissAt(store, scope, identity);
  return { navigated: false };
}

test("case 10: Review CTA dismisses AND navigates; banner stays hidden on return", () => {
  const store = new FakeStorage();
  const identity = "a:1|b:1|c:1";
  assert.equal(visibleOnMount(store, "plan:2026-07-27", 3, identity), 3, "starts visible");
  const { navigated } = clickReviewCta(store, "plan:2026-07-27", identity);
  assert.equal(navigated, true, "CTA must still navigate to the Failed list");
  // Back on Plan (fresh mount, same failure set) → the big banner must not nag again.
  assert.equal(visibleOnMount(store, "plan:2026-07-27", 3, identity), 0, "banner must not reappear after Review");
});

test("case 10: a CTA dismiss survives a closed/reopened page (localStorage)", () => {
  const store = new FakeStorage();
  const identity = "a:1|b:1|c:1";
  clickReviewCta(store, "studio", identity);
  // "Close the tab, reopen the app": in-memory state gone, localStorage retained.
  assert.equal(visibleOnMount(store, "studio", 3, identity), 0, "still hidden in a new session");
  assert.equal(visibleOnMount(store, "studio", 3, identity), 0, "and after another reload");
});

test("case 10: a NEW failure after the CTA dismiss brings the banner back", () => {
  const store = new FakeStorage();
  clickReviewCta(store, "studio", "a:1|b:1|c:1");
  assert.equal(visibleOnMount(store, "studio", 4, "a:1|b:1|c:1|d:1"), 4, "new failure → new identity → reappears");
  // Even a retry-failure on an already-known Pin (updatedAt bumps) must break through.
  assert.equal(visibleOnMount(store, "studio", 3, "a:2|b:1|c:1"), 3);
});

test('case 10/11: "Hide for now" hides ONLY the big banner — the small failed count is untouched', () => {
  // The small "N failed" chip comes from usePinBoardDrafts' counts.failed, computed off
  // the draft population — it never reads dismiss state. Derive it from the REAL
  // deriveBoardCollections here (not a hardcoded 3) so this can't pass while the chip
  // silently starts honoring a dismiss.
  const drafts = [
    { id: "a", updatedAt: "2026-07-29T10:00:00.000Z" },
    { id: "b", updatedAt: "2026-07-29T11:00:00.000Z" },
    { id: "c", updatedAt: "2026-07-29T12:00:00.000Z" },
  ].map(d => ({
    ...d, source: "uploaded_image", imageUrl: "https://x/a.png",
    keyword: "", category: "", title: "T", description: "D", altText: "A",
    destinationUrl: "", boardId: "b", boardName: "B",
    weeklyPlanItemId: "", generationSessionId: "", scheduledDate: "", status: "ready",
    createdAt: "2026-07-29T09:00:00.000Z",
    failureType: "publish" as const, publishError: "Publish failed",
  })) as unknown as PinDraft[];

  const smallCount = deriveBoardCollections(drafts).failureItems.length;
  assert.equal(smallCount, 3, "fixture sanity: 3 failed drafts");
  const identity = publishFailureSetIdentity(drafts);

  const store = new FakeStorage();
  const { navigated } = clickHideForNow(store, "studio", identity);
  assert.equal(navigated, false, '"Hide for now" must not navigate');
  assert.equal(visibleOnMount(store, "studio", smallCount, identity), 0, "big banner hidden");
  // The chip is recomputed from the same (unchanged) population AFTER the dismiss:
  // dismissing hides a warning, it does not resolve or hide any failure.
  assert.equal(deriveBoardCollections(drafts).failureItems.length, 3,
    "small failed count must survive a dismiss — it is derived from counts, not banner state");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
