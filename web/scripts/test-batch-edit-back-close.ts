/**
 * Regression: "Create Pins → Batch Edit → Back returned to Weekly Plan".
 *
 * Root cause: Batch Edit is a full-screen in-page overlay that pushed no history
 * entry, so the browser Back button skipped it and navigated to the previously
 * visited page (commonly Weekly Plan). Fix: useBackButtonClose pushes a same-URL
 * history marker while the overlay is open and intercepts popstate to close the
 * overlay (layer by layer) WITHOUT navigating — so the user stays on the entry
 * page, whatever it was.
 *
 * These tests drive the framework-agnostic createOverlayHistory controller with a
 * fake window (no React renderer needed), plus static wiring assertions.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createOverlayHistory,
  OVERLAY_HISTORY_MARKER,
  type WindowLike,
} from "../src/lib/useBackButtonClose";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  OK ${name}`);
}

type Entry = { url: string; marker: boolean };
function makeWin(entryUrl = "/app/studio") {
  const stack: Entry[] = [{ url: entryUrl, marker: false }];
  const listeners: Array<() => void> = [];
  const win: WindowLike = {
    history: {
      pushState(data: unknown, _unused: string, url?: string | null) {
        const marker = !!(data && (data as Record<string, unknown>)[OVERLAY_HISTORY_MARKER]);
        stack.push({ url: url ?? stack[stack.length - 1].url, marker });
      },
      back() {
        if (stack.length > 1) stack.pop();
        // A real browser fires popstate when Back pops an entry.
        for (const l of listeners.slice()) l();
      },
    },
    location: { get href() { return stack[stack.length - 1].url; } },
    addEventListener(_t, l) { listeners.push(l); },
    removeEventListener(_t, l) { const i = listeners.indexOf(l); if (i >= 0) listeners.splice(i, 1); },
  };
  return { win, stack, listeners };
}

const top = (stack: Entry[]) => stack[stack.length - 1];

// ── Behavioural: the actual controller code ──────────────────────────────────

test("arm() pushes a same-URL marker entry and listens for popstate", () => {
  const { win, stack, listeners } = makeWin();
  const ctrl = createOverlayHistory(win, () => true);
  ctrl.arm();
  assert.equal(stack.length, 2, "one history entry pushed");
  assert.equal(top(stack).marker, true, "entry is our overlay marker");
  assert.equal(top(stack).url, "/app/studio", "URL is unchanged (no route change)");
  assert.equal(listeners.length, 1, "popstate listener registered");
});

test("Back closes the overlay and returns to the SAME entry page (not the prior page)", () => {
  const { win, stack } = makeWin("/app/studio");
  let closed = false;
  const ctrl = createOverlayHistory(win, () => { closed = true; return true; });
  ctrl.arm();
  win.history.back(); // user presses browser/hardware Back
  assert.equal(closed, true, "overlay was closed via popstate");
  assert.equal(stack.length, 1, "history returned to the entry page");
  assert.equal(top(stack).url, "/app/studio", "stayed on Create Pins, did NOT go to a prior page");
  ctrl.disarm(); // subsequent React teardown must not double-pop
  assert.equal(stack.length, 1, "no extra history.back() after a Back-close");
});

test("X / Escape (programmatic close) unwinds the marker so history stays clean", () => {
  const { win, stack } = makeWin("/app/plan");
  const ctrl = createOverlayHistory(win, () => true);
  ctrl.arm();
  assert.equal(stack.length, 2);
  ctrl.disarm(); // open -> false via X button
  assert.equal(stack.length, 1, "marker removed");
  assert.equal(top(stack).url, "/app/plan", "stayed on Weekly Plan");
});

test("Back peels one layer at a time: Pin Details closes first, then the workspace", () => {
  // Mirrors Batch Edit → open Pin Details → Back → back to Batch Edit (not exit).
  const { win, stack } = makeWin("/app/studio");
  let layer = 2; // 2 = nested Pin-details drawer open on top of the workspace
  const ctrl = createOverlayHistory(win, () => {
    if (layer > 1) { layer -= 1; return false; } // closed inner layer, stay open
    layer = 0; return true;                       // closed the workspace
  });
  ctrl.arm();
  win.history.back(); // Back #1
  assert.equal(layer, 1, "inner Pin-details layer closed first");
  assert.equal(stack.length, 2, "Back re-armed: workspace still catchable");
  win.history.back(); // Back #2
  assert.equal(layer, 0, "workspace closed on the second Back");
  assert.equal(stack.length, 1, "returned to the entry page");
});

test("Route-change unmount does NOT fight the navigation (no history.back())", () => {
  const { win, stack } = makeWin("/app/studio");
  const ctrl = createOverlayHistory(win, () => true);
  ctrl.arm();
  win.history.pushState({}, "", "/app/trends"); // user navigated away via a link
  ctrl.disarm({ unmounting: true });
  assert.equal(stack.length, 3, "the outgoing navigation is preserved");
  assert.equal(top(stack).url, "/app/trends", "did not bounce the user back");
});

test("arm()/disarm() are idempotent", () => {
  const { win, stack, listeners } = makeWin();
  const ctrl = createOverlayHistory(win, () => true);
  ctrl.arm();
  ctrl.arm(); // no-op
  assert.equal(stack.length, 2);
  assert.equal(listeners.length, 1);
  ctrl.disarm();
  ctrl.disarm(); // no-op
  assert.equal(stack.length, 1);
});

// ── Static wiring: the hook and its use-site ─────────────────────────────────

const hookSrc  = readFileSync("src/lib/useBackButtonClose.ts", "utf8");
const batchSrc = readFileSync("src/components/studio/BatchEditDrawer.tsx", "utf8");

test("hook pushes a SAME-URL entry so Next's router treats it as no route change", () => {
  assert.match(hookSrc, /pushState\(\s*\{\s*\[OVERLAY_HISTORY_MARKER\]:\s*true\s*\}\s*,\s*""\s*,\s*win\.location\.href\s*\)/);
});

test("hook is SSR-safe (guards typeof window)", () => {
  assert.match(hookSrc, /typeof window === "undefined"/);
});

test("hook skips history.back() on route-change unmount", () => {
  assert.match(hookSrc, /if \(!closedByBack && !opts\?\.unmounting\)/);
});

test("BatchEditDrawer wires Back-close to the overlay open state", () => {
  assert.match(batchSrc, /import \{ useBackButtonClose \} from "@\/lib\/useBackButtonClose"/);
  assert.match(batchSrc, /useBackButtonClose\(open,\s*\(\)\s*=>\s*dismissRef\.current\(\)\)/);
});

test("Escape and Back share ONE layered dismiss (no hardcoded return route)", () => {
  // The dismiss closes each inner layer before the whole workspace, returning
  // true only when onClose() runs.
  assert.match(batchSrc, /dismissRef\.current = \(\) => \{[\s\S]*?if \(confirm\)[\s\S]*?if \(drawerPinId\)[\s\S]*?onClose\(\);\s*\n\s*return true;/);
  assert.match(batchSrc, /if \(e\.key !== "Escape"\) return;\s*\n\s*dismissRef\.current\(\);/);
  // No `/weekly-plan` (or app/plan) hardcoded as a Batch Edit close/back target.
  assert.doesNotMatch(batchSrc, /onClose[\s\S]{0,40}(\/weekly-plan|\/app\/plan)/);
});

console.log(`\nBatch Edit back/close return navigation: ${passed} passed, 0 failed`);
