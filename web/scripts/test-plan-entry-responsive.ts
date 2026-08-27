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
