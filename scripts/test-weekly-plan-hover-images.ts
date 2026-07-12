/**
 * Regression guard: Weekly/Monthly Plan must keep BOTH the hover preview AND multi-select
 * working together, and use the shared image component. Locks the fixes for:
 *  - hover preview silently disabled on touch-capable laptops (pointer:fine bug)
 *  - hover preview gated by selection state
 *  - checkbox clicks opening details / dragging
 *  - slow/blank thumbnails + image reloads on selection toggle
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const hover = readFileSync(join(root, "src/components/plan/PinHoverPreview.tsx"), "utf8");
const thumb = readFileSync(join(root, "src/components/plan/PinThumbnail.tsx"), "utf8");
const plan  = readFileSync(join(root, "src/app/app/plan/page.tsx"), "utf8");

let passed = 0, failed = 0;
function test(name: string, fn: () => void) {
  try { fn(); console.log(`  OK ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}`); console.error(`       ${(e as Error).message}`); failed++; }
}
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }

console.log("Weekly Plan hover preview + multi-select + images");

// ── Root cause: hover must open on REAL pointer events, not a media query ───────
test("Hover preview opens on real pointer/mouse events, NOT gated by the media query", () => {
  // The trigger wires real events.
  assert(/onPointerEnter=\{handlePointerEnter\}/.test(hover), "trigger must use onPointerEnter");
  assert(/onMouseEnter=\{handleMouseEnter\}/.test(hover), "trigger must keep an onMouseEnter fallback");
  // The OPEN path must NOT early-return on !finePointer (the previous bug).
  assert(!/if \(disabled \|\| !finePointer\) return;/.test(hover), "open is still hard-gated by !finePointer");
  // handlePointerEnter opens for non-touch via scheduleOpen.
  const i = hover.indexOf("const handlePointerEnter");
  assert(i >= 0, "handlePointerEnter missing");
  const body = hover.slice(i, i + 320);
  assert(/e\.pointerType === "touch"\) return/.test(body), "must exclude touch from hover-open");
  assert(/scheduleOpen\(\)/.test(body), "pointer-enter must scheduleOpen for mouse/pen");
});

test("Mouse-enter fallback opens preview even if finePointer is false", () => {
  const i = hover.indexOf("const handleMouseEnter");
  assert(i >= 0, "handleMouseEnter missing");
  const body = hover.slice(i, i + 220);
  assert(!/finePointer/.test(body), "mouse-enter fallback must NOT consult finePointer");
  assert(/scheduleOpen\(\)/.test(body), "mouse-enter fallback must scheduleOpen");
});

test("Click behavior uses real pointer type (touch taps toggle), not finePointer", () => {
  const i = hover.indexOf("const handleTriggerClick");
  const body = hover.slice(i, i + 600);
  assert(/pointerTypeRef\.current === "touch"/.test(body), "click must branch on real pointer type");
  assert(!/!finePointer/.test(body), "click must not branch on finePointer");
});

test("useFinePointer remains a hint (any-pointer/any-hover) but is not the open gate", () => {
  assert(/any-hover:\s*hover/.test(hover) && /any-pointer:\s*fine/.test(hover), "fine-pointer hint query changed");
});

// ── Hover preview is not selection-gated on any tile ───────────────────────────
test("Week/Month/Unscheduled tiles enable hover preview regardless of selection", () => {
  // disabled is tied to hoverActions only — never to a `selecting`/`selected` flag.
  assert(plan.includes("disabled={!hoverActions}"), "tile hover preview not enabled via hoverActions");
  assert(!/disabled=\{selecting/.test(plan), "hover preview still gated by selection (`selecting`)");
  assert(!/disabled=\{selected/.test(plan), "hover preview still gated by selected state");
});

// ── Checkbox is a separate, contained interaction ──────────────────────────────
test("SelectCheckbox toggles only — stopPropagation, no details/drag, not full-tile", () => {
  const i = plan.indexOf("function SelectCheckbox");
  assert(i >= 0, "SelectCheckbox missing");
  const body = plan.slice(i, i + 900);
  assert(/onClick=\{e => \{ e\.stopPropagation\(\); e\.preventDefault\(\); onToggle\(\); \}\}/.test(body), "checkbox onClick must stopPropagation + toggle only");
  assert(/onMouseDown=\{e => \{ e\.stopPropagation\(\); \}\}/.test(body), "checkbox must stop mousedown (no drag)");
  assert(/width: 18, height: 18/.test(body), "checkbox must be a small box, not cover the tile");
});

// ── Shared image component ─────────────────────────────────────────────────────
test("PinThumbnail: skeleton, error fallback, lazy/eager, async decode", () => {
  assert(thumb.includes('data-testid="pin-thumbnail-skeleton"'), "skeleton missing");
  assert(thumb.includes('data-testid="pin-thumbnail-fallback"'), "error fallback missing");
  assert(/loading=\{loading\}/.test(thumb) && /decoding="async"/.test(thumb), "loading/decoding attrs missing");
  assert(/objectFit/.test(thumb), "objectFit not configurable");
});

test("PinThumbnail load state is keyed on src → no reload on selection/hover re-render", () => {
  assert(/useEffect\(\(\) => \{\s*setStatus\("loading"\);\s*\}, \[src\]\)/.test(thumb), "status must reset only when src changes");
  assert(/draggable=\{false\}/.test(thumb), "thumbnail img should not be draggable");
});

test("Shimmer skeleton style is defined in globals", () => {
  const css = readFileSync(join(root, "src/app/globals.css"), "utf8");
  assert(css.includes(".pin-thumb-skeleton"), "pin-thumb-skeleton CSS missing");
});

test("All Weekly Plan surfaces render the shared PinThumbnail", () => {
  const uses = (plan.match(/<PinThumbnail/g) ?? []).length;
  assert(uses >= 6, `expected PinThumbnail across Week/Month/Day-detail/Unscheduled surfaces, found ${uses}`);
  // First-screen Week tile eager, off-screen lazy.
  assert(/<PinThumbnail[^>]*loading="eager"/.test(plan), "week tile should eager-load");
  assert(/<PinThumbnail[^>]*loading="lazy"/.test(plan), "off-screen thumbnails should lazy-load");
});

test("Hover preview portal is click-through (pointer-events: none) so it never blocks the grid", () => {
  assert(/pointerEvents: "none"/.test(hover), "preview portal must be pointer-events:none");
});

console.log(`\nWeekly Plan hover + images: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
