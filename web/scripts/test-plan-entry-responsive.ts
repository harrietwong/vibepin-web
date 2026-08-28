/**
 * test-plan-entry-responsive.ts — the responsive Plan entry inside Create Pins
 * (PRD 0809 §IX).
 *
 * Run: npx tsx scripts/test-plan-entry-responsive.ts
 *
 * Two layers:
 *  1. RUNTIME — the viewport hook's pure part (`readViewportBucket`) against a stubbed
 *     `matchMedia`, so the three buckets and their thresholds are actually executed,
 *     not merely grepped.
 *  2. SOURCE CONTRACT — the sidebar/board wiring that a runtime test cannot reach
 *     without a DOM renderer: which form each bucket gets, that the trigger is never
 *     hover-only, that both overlays are real dialogs with a close control, Escape,
 *     scroll lock and focus return, and that the board's grid reflow is desktop-only.
 *
 * The desktop form is deliberately asserted as UNCHANGED: the docked panel is the one
 * shape that shipped, and this feature must not have redesigned it.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  readViewportBucket,
  MOBILE_MAX_WIDTH,
  DESKTOP_MIN_WIDTH,
  type ViewportBucket,
} from "../src/hooks/useViewportBucket";

let passed = 0, failed = 0;
function test(name: string, fn: () => void) {
  try { fn(); console.log(`  OK  ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}`); console.error(`       ${(e as Error).message}`); failed++; }
}
function assert(condition: boolean, message: string) { if (!condition) throw new Error(message); }

const hookSrc = readFileSync(join(process.cwd(), "src/hooks/useViewportBucket.ts"), "utf8");
const sidebarSrc = readFileSync(join(process.cwd(), "src/components/studio/StudioPlanSidebar.tsx"), "utf8");
const boardSrc = readFileSync(join(process.cwd(), "src/components/studio/StudioBoard.tsx"), "utf8");
const enSrc = readFileSync(join(process.cwd(), "src/lib/i18n/messages/en/studioBoard.ts"), "utf8");
const zhCnSrc = readFileSync(join(process.cwd(), "src/lib/i18n/messages/zh-CN.ts"), "utf8");
const zhTwSrc = readFileSync(join(process.cwd(), "src/lib/i18n/messages/zh-TW.ts"), "utf8");

/** Runs `fn` with a `window.matchMedia` that answers for a viewport `width` px wide. */
function atViewportWidth<T>(width: number, fn: () => T): T {
  const globalScope = globalThis as unknown as Record<string, unknown>;
  const hadWindow = "window" in globalScope;
  const previous = globalScope.window;
  globalScope.window = {
    matchMedia: (query: string) => {
      const max = /\(max-width:\s*(\d+)px\)/.exec(query);
      const min = /\(min-width:\s*(\d+)px\)/.exec(query);
      const matches = max ? width <= Number(max[1]) : min ? width >= Number(min[1]) : false;
      return { matches, addEventListener() {}, removeEventListener() {} };
    },
  };
  try { return fn(); } finally {
    if (hadWindow) globalScope.window = previous; else delete globalScope.window;
  }
}

console.log("\n=== Viewport hook (runtime) ===");

test("thresholds are 768 / 1280 (mobile < 768 <= tablet <= 1279 < desktop)", () => {
  assert(MOBILE_MAX_WIDTH === 767, `MOBILE_MAX_WIDTH is ${MOBILE_MAX_WIDTH}, expected 767`);
  assert(DESKTOP_MIN_WIDTH === 1280, `DESKTOP_MIN_WIDTH is ${DESKTOP_MIN_WIDTH}, expected 1280`);
});

test("no window (SSR / node) resolves to desktop, keeping the server markup unchanged", () => {
  const bucket: ViewportBucket = readViewportBucket();
  assert(bucket === "desktop", `expected desktop without a window, got ${bucket}`);
});

test("each width lands in its bucket, boundaries included", () => {
  const cases: Array<[number, ViewportBucket]> = [
    [320, "mobile"], [375, "mobile"], [767, "mobile"],
    [768, "tablet"], [1024, "tablet"], [1279, "tablet"],
    [1280, "desktop"], [1440, "desktop"], [2560, "desktop"],
  ];
  for (const [width, expected] of cases) {
    const actual = atViewportWidth(width, readViewportBucket);
    assert(actual === expected, `${width}px resolved to ${actual}, expected ${expected}`);
  }
});

test("the hook itself defaults to desktop before hydration and subscribes to both queries", () => {
  assert(/useState<ViewportBucket>\("desktop"\)/.test(hookSrc), "hook does not default to desktop");
  assert(hookSrc.includes('(max-width: ${MOBILE_MAX_WIDTH}px)'), "mobile query is not built from MOBILE_MAX_WIDTH");
  assert(hookSrc.includes('(min-width: ${DESKTOP_MIN_WIDTH}px)'), "desktop query is not built from DESKTOP_MIN_WIDTH");
  assert(hookSrc.includes('mobile.addEventListener("change", sync)') && hookSrc.includes('desktop.addEventListener("change", sync)'),
    "hook does not react to viewport changes");
  assert(hookSrc.includes('mobile.removeEventListener("change", sync)') && hookSrc.includes('desktop.removeEventListener("change", sync)'),
    "hook leaks its matchMedia listeners");
  assert(/export type ViewportBucket = "mobile" \| "tablet" \| "desktop"/.test(hookSrc), "the three buckets are not the exported union");
});

console.log("\n=== Sidebar picks its form from the bucket ===");

test("the sidebar reads the shared hook and derives one 'docked' flag", () => {
  assert(sidebarSrc.includes('import { useViewportBucket } from "@/hooks/useViewportBucket"'), "sidebar does not use the shared viewport hook");
  assert(sidebarSrc.includes("const bucket = useViewportBucket();"), "sidebar does not resolve a bucket");
  assert(sidebarSrc.includes('const docked = bucket === "desktop";'), "sidebar does not derive docked from the bucket");
});

test("desktop keeps the docked panel (and only desktop renders it)", () => {
  assert(sidebarSrc.includes("{docked && open && ("), "the docked panel is not gated on the desktop bucket");
  assert(sidebarSrc.includes('data-testid="studio-plan-sidebar"'), "the docked panel testid disappeared");
  // Unchanged desktop behaviour: hover/focus peek, pin toggles, the panel takes layout
  // width so the board can reflow around it.
  assert(sidebarSrc.includes("const PANEL_WIDTH = 344;"), "desktop panel width changed");
  assert(sidebarSrc.includes('position: pinned ? "relative" : "absolute"'), "docked panel no longer participates in layout when pinned");
  assert(sidebarSrc.includes("onMouseEnter={reveal} onMouseLeave={scheduleClose}"), "desktop hover preview was removed");
});

test("tablet gets a drawer, mobile gets a sheet — keyed on the bucket, not on hover", () => {
  assert(sidebarSrc.includes("{!docked && overlayOpen && ("), "the overlay form is not gated on the non-desktop buckets");
  assert(sidebarSrc.includes('data-testid={bucket === "mobile" ? "studio-plan-sheet" : "studio-plan-drawer"}'),
    "drawer/sheet variant is not keyed on the viewport bucket");
  assert(sidebarSrc.includes('data-plan-form={bucket}'), "the rendered form is not observable from the DOM");
  // Mobile is full-screen; tablet is a right-side drawer over the board.
  assert(/bucket === "mobile"\s*\?\s*\{[\s\S]*?width: "100%", height: "100%"/.test(sidebarSrc), "mobile form is not full-screen");
  assert(/width: PANEL_WIDTH, maxWidth: "92vw", height: "100%"/.test(sidebarSrc), "tablet drawer is not a right-side panel");
  assert(sidebarSrc.includes('justifyContent: "flex-end"'), "the overlay does not anchor its panel to the right edge");
});

test("all three forms render the same Plan content", () => {
  for (const piece of ["<PlanPanelHeader", "<PlanPanelBody", "<PlanPanelFooter"]) {
    const count = sidebarSrc.split(piece).length - 1;
    assert(count === 2, `${piece} is rendered ${count} times, expected once per form family (docked + overlay)`);
  }
  assert(sidebarSrc.includes('href="/app/studio?view=plan"'), "the full-planner deep link is gone from the shared footer");
});

test("open-state is bucket-aware, so the badge and the §24 highlight still work on overlays", () => {
  assert(sidebarSrc.includes("const open = docked ? (pinned || hoverOpen) : overlayOpen;"),
    "open is not derived per form — the badge would never clear on tablet/mobile");
  assert(sidebarSrc.includes("if (open && badge !== 0) setBadge(0);"), "the badge no longer clears when the panel opens");
});

console.log("\n=== The entry is a button, never hover-only ===");

test("the trigger keeps its testid, has an onClick and an accessible label in every form", () => {
  assert(sidebarSrc.includes('data-testid="studio-plan-toggle"'), "the Plan trigger testid changed");
  assert(sidebarSrc.includes("aria-label={triggerLabel}"), "the trigger has no accessible label");
  assert(sidebarSrc.includes("aria-expanded={open}"), "the trigger does not expose its expanded state");
  assert(/onClick=\{\(\) => \{\s*\n\s*if \(!docked\) \{/.test(sidebarSrc), "the trigger has no click path for the overlay forms");
  assert(sidebarSrc.includes("setOverlayOpen(value => !value);"), "clicking the trigger does not toggle the overlay");
  assert(/triggerLabel = docked[\s\S]{0,160}studioBoard\.plan\.openPanel/.test(sidebarSrc),
    "overlay forms do not use the 'Open Plan' label");
});

test("hover handlers are attached on desktop only", () => {
  assert(sidebarSrc.includes("onMouseEnter={docked ? reveal : undefined} onMouseLeave={docked ? scheduleClose : undefined}"),
    "the trigger attaches hover handlers on tablet/mobile");
  assert(sidebarSrc.includes("onFocus={docked ? reveal : undefined} onBlur={docked ? scheduleClose : undefined}"),
    "focus/blur peek is not gated to the docked form (it would fight the dialog's focus management)");
});

console.log("\n=== Overlay forms are real dialogs ===");

test("scrim + role=dialog + aria-modal + labelled panel", () => {
  assert(sidebarSrc.includes('data-testid="studio-plan-overlay"'), "no scrim element");
  assert(/position: "fixed", inset: 0, zIndex: 340, background: "rgba\(15,23,42,0\.46\)"/.test(sidebarSrc), "scrim does not cover the viewport");
  assert(sidebarSrc.includes('role="dialog" aria-modal="true" aria-label={tr("studioBoard.plan.title")}'),
    "the overlay panel is not an accessible modal dialog");
  assert(sidebarSrc.includes("if (event.target === event.currentTarget) closeOverlay();"), "clicking the scrim does not close the overlay");
});

test("an explicit close control, labelled and clickable", () => {
  assert(sidebarSrc.includes('data-testid="studio-plan-close"'), "the close control testid is missing");
  assert(/data-testid="studio-plan-close"[\s\S]{0,140}aria-label=\{tr\("studioBoard\.plan\.close"\)\} onClick=\{onClose\}/.test(sidebarSrc),
    "the close control has no label or no click handler");
  // Only the overlay forms get it: the docked panel has its own pin/unpin trigger.
  assert(sidebarSrc.includes("{onClose && ("), "the close control is not exclusive to the overlay forms");
  assert(sidebarSrc.includes("onClose={closeOverlay}"), "the overlay does not wire its close control");
});

test("Escape closes the overlays and still spares a pinned desktop panel", () => {
  assert(sidebarSrc.includes("const escapeCloses = docked ? (hoverOpen && !pinned) : overlayOpen;"),
    "Escape handling is not form-aware");
  assert(sidebarSrc.includes('if (event.key !== "Escape") return;'), "no Escape key handler");
  assert(sidebarSrc.includes('document.addEventListener("keydown", onKeyDown)') && sidebarSrc.includes('document.removeEventListener("keydown", onKeyDown)'),
    "the Escape listener is not registered/cleaned up");
  assert(/if \(!escapeCloses\) return;/.test(sidebarSrc), "the Escape effect is not gated");
});

test("body scroll is locked while an overlay is open, and restored afterwards", () => {
  assert(sidebarSrc.includes('const previous = document.body.style.overflow;'), "the previous overflow is not saved");
  assert(sidebarSrc.includes('document.body.style.overflow = "hidden";'), "body scroll is not locked");
  assert(sidebarSrc.includes('return () => { document.body.style.overflow = previous; };'), "body scroll is not restored on close");
  assert(sidebarSrc.includes("if (docked || !overlayOpen) return;"), "the lock is not limited to an open overlay");
});

test("focus moves into the panel on open and back to the trigger on close", () => {
  assert(sidebarSrc.includes("ref={overlayPanelRef} tabIndex={-1}"), "the dialog panel cannot receive focus");
  assert(sidebarSrc.includes("overlayPanelRef.current?.focus();"), "focus does not move into the panel");
  assert(sidebarSrc.includes("toggleRef.current?.focus();"), "focus does not return to the trigger");
  assert(sidebarSrc.includes('data-testid="studio-plan-toggle" ref={toggleRef}'), "the trigger is not the focus-return target");
  assert(sidebarSrc.includes("restoreFocus.current"), "focus is restored unconditionally (it would steal focus on first render)");
});

console.log("\n=== Board reflow + wiring ===");

test("the board reflows its grid only for the DOCKED panel", () => {
  assert(boardSrc.includes('import { useViewportBucket } from "@/hooks/useViewportBucket";'), "the board does not read the viewport bucket");
  assert(boardSrc.includes('const planDocked = planPinned && viewportBucket === "desktop";'),
    "the board does not gate the pinned preference on the desktop bucket");
  assert(boardSrc.includes('data-testid="studio-board-grid" style={{ display: "grid", gridTemplateColumns: planDocked'),
    "the grid still reflows on planPinned alone — a tablet overlay would narrow the columns");
});

test("Create Pins still mounts the Plan entry unconditionally", () => {
  // The responsive work happens INSIDE the component (it always renders its trigger);
  // the board must not start hiding the entry on any viewport.
  assert(boardSrc.includes("<StudioPlanSidebar drafts={"), "the Plan entry is no longer mounted by the board");
  assert(!/\{[^\n]*\?\s*<StudioPlanSidebar/.test(boardSrc), "the Plan entry became conditional — some viewport would lose its entry");
});

test("the overlay trigger label exists in English, Simplified and Traditional Chinese", () => {
  assert(enSrc.includes('"studioBoard.plan.openPanel": "Open Plan"'), "English label missing");
  assert(/"studioBoard\.plan\.openPanel":\s*"[^"]+"/.test(zhCnSrc), "zh-CN label missing");
  assert(/"studioBoard\.plan\.openPanel":\s*"[^"]+"/.test(zhTwSrc), "zh-TW label missing");
  for (const [name, src] of [["zh-CN", zhCnSrc], ["zh-TW", zhTwSrc]] as const) {
    const value = /"studioBoard\.plan\.openPanel":\s*"([^"]+)"/.exec(src)?.[1] ?? "";
    assert(!/^[\x00-\x7F]*$/.test(value), `${name} label "${value}" is not translated`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
