/**
 * Weekly Plan / Monthly Plan tile interaction + image-loading regression guard.
 *
 * Verifies that hover preview and multi-select are SEPARATE interactions:
 *  - hover preview is triggered by hovering the tile body, never gated by
 *    selection state;
 *  - the checkbox is isolated (stopPropagation, only covers itself) and never
 *    opens details or blocks hover;
 *  - both Week and Month support hover preview + multi-select;
 *  - the shared <PinThumbnail> gives stable dimensions, a skeleton placeholder,
 *    lazy/eager loading, async decode and a clean error fallback, and is not
 *    remounted on selection toggles.
 *
 * Source-assertion style, consistent with the rest of scripts/.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const plan  = readFileSync(join(root, "src/app/app/plan/page.tsx"), "utf8");
const hover = readFileSync(join(root, "src/components/plan/PinHoverPreview.tsx"), "utf8");
const thumb = readFileSync(join(root, "src/components/plan/PinThumbnail.tsx"), "utf8");
const css   = readFileSync(join(root, "src/app/globals.css"), "utf8");

let passed = 0, failed = 0;
function test(name: string, fn: () => void) {
  try { fn(); console.log(`  OK ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}`); console.error(`       ${(e as Error).message}`); failed++; }
}
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }

console.log("Weekly/Monthly Plan tile interactions + image loading");

// 1. Week View tile hover shows preview when NOT selected.
test("Week tile renders PinHoverTarget, enabled purely by hoverActions (not selection)", () => {
  const idx = plan.indexOf("function DraggablePinCard");
  assert(idx >= 0, "DraggablePinCard missing");
  const body = plan.slice(idx, idx + 1600);
  assert(body.includes("<PinHoverTarget"), "Week tile does not use PinHoverTarget");
  assert(/disabled=\{!hoverActions\}/.test(body), "Week hover disabled gate not tied solely to hoverActions");
  assert(!/disabled=\{[^}]*selected/.test(body), "Week hover must NOT depend on selected state");
});

// 2. Week View tile hover shows preview when selected (selection never disables hover).
test("Hover open is not gated by selection anywhere in the tile", () => {
  // The only `disabled` inputs to PinHoverTarget are hoverActions / isEditing —
  // never `selected`.
  assert(!/PinHoverTarget[\s\S]{0,200}disabled=\{[^}]*selected/.test(plan),
    "a PinHoverTarget is disabled based on selection");
});

// 3. Checkbox appears on hover (and stays while selected), not mode-only.
test("Checkbox is hover-revealed (hovered || select.active)", () => {
  assert(/const checkVisible = hovered \|\| !!select\?\.active/.test(plan), "Week checkbox not hover-revealed");
  assert(/const checkVisible = hoveredId === ev\.draftId \|\| selecting/.test(plan), "Month checkbox not hover-revealed");
});

// 4. Checkbox click selects and does NOT open details.
test("SelectCheckbox stops propagation + preventDefault and only toggles", () => {
  const idx = plan.indexOf("function SelectCheckbox");
  assert(idx >= 0, "SelectCheckbox missing");
  const body = plan.slice(idx, idx + 900);
  assert(/onMouseDown=\{e => \{ e\.stopPropagation\(\); \}\}/.test(body), "checkbox missing mousedown stopPropagation");
  assert(/onClick=\{e => \{ e\.stopPropagation\(\); e\.preventDefault\(\); onToggle\(\); \}\}/.test(body),
    "checkbox click must stopPropagation+preventDefault+onToggle only");
});

// 5. Hover preview opens on REAL pointer/mouse events (not gated by a media query),
//    so it works on hybrid/touch-capable laptops where (pointer:fine) can be false.
test("Hover trigger opens on real pointer/mouse events, not on a media-query gate", () => {
  assert(hover.includes("onPointerEnter={handlePointerEnter}"), "trigger must open on pointerenter");
  assert(hover.includes("onMouseEnter={handleMouseEnter}"), "trigger must keep a mouseenter fallback");
  assert(!/if \(disabled \|\| !finePointer\) return;/.test(hover), "open must not be hard-gated by !finePointer");
});

// 6. Selection toolbar does not block hover preview (card is portaled with a high z-index).
test("Hover card is portaled to document.body above the grid/toolbar", () => {
  assert(hover.includes("createPortal"), "hover card not portaled");
  assert(hover.includes("document.body"), "hover card not attached to document.body");
  assert(/const Z_INDEX = \d+/.test(hover), "hover card z-index missing");
});

// 7. Month View pin hover shows preview.
test("Month cell thumbnail is wrapped in PinHoverTarget with the same hoverActions", () => {
  const idx = plan.indexOf("function MonthDayCell");
  assert(idx >= 0, "MonthDayCell missing");
  const body = plan.slice(idx, idx + 5000);
  assert(body.includes("<PinHoverTarget"), "Month cell missing hover preview");
  assert(/actions=\{hoverActions \?\? /.test(body), "Month cell not passing hoverActions");
});

// 8. Month View checkbox selects without opening details (shared isolated SelectCheckbox).
test("Month checkbox uses the shared isolated SelectCheckbox", () => {
  assert(plan.includes('testId="month-select-box"'), "Month checkbox missing");
  assert(plan.includes("onToggle={() => select.toggle(ev.draftId)}"), "Month checkbox not wired to shared select");
});

// 9. Unscheduled card button clicks do not trigger parent card click.
test("Unscheduled rail Schedule/Edit buttons stopPropagation", () => {
  assert(/data-testid="rail-add-to-plan"[\s\S]{0,120}e\.stopPropagation\(\); onAddToPlan\(draft\.id\)/.test(plan),
    "rail Schedule button missing stopPropagation");
  assert(/data-testid="rail-edit-details"[\s\S]{0,120}e\.stopPropagation\(\); onEdit\(draft\)/.test(plan),
    "rail Edit button missing stopPropagation");
});

// 10. Image component renders a placeholder before load.
test("PinThumbnail shows a skeleton placeholder until the image loads", () => {
  assert(/useState<"loading" \| "loaded" \| "error">\("loading"\)/.test(thumb), "initial status not 'loading'");
  assert(/status !== "loaded" &&/.test(thumb), "skeleton not shown until loaded");
  assert(/className=\{status === "loading" \? \(dark \? "pin-thumb-skeleton pin-thumb-skeleton--dark" : "pin-thumb-skeleton"\) : undefined\}/.test(thumb),
    "skeleton shimmer class not applied while loading");
  assert(/\.pin-thumb-skeleton\s*\{/.test(css), "pin-thumb-skeleton CSS missing");
  assert(/--app-surface-2/.test(css) && /pin-thumb-skeleton/.test(css), "skeleton not theme-aware");
});

// 11. Image component renders a fallback on error (no collapse).
test("PinThumbnail renders a clean fallback on error and never collapses", () => {
  assert(thumb.includes('onError={() => setStatus("error")}'), "onError not handled");
  assert(thumb.includes('data-testid="pin-thumbnail-fallback"'), "fallback tile missing");
  assert(/position: "absolute",\s*inset: 0/.test(thumb), "fill wrapper missing (would collapse on error)");
});

// 12. Selection toggle does not remount the image component (load state keyed on src only).
test("PinThumbnail resets load state only on src change (not selection/hover)", () => {
  assert(/useEffect\(\(\) => \{\s*setStatus\("loading"\);\s*\}, \[src\]\)/.test(thumb),
    "load state must reset on [src] only");
});

// Image optimizations present.
test("PinThumbnail uses async decode + configurable lazy/eager loading", () => {
  assert(thumb.includes('decoding="async"'), "decoding async missing");
  assert(/loading = "lazy"/.test(thumb), "default lazy loading missing");
  assert(thumb.includes("loading={loading}"), "loading prop not forwarded");
});

// Shared component actually used across the required surfaces.
test("PinThumbnail is used in Week / Month / Unscheduled / Day-detail / hover card", () => {
  const weekIdx = plan.indexOf("function DraggablePinCard");
  assert(plan.slice(weekIdx, weekIdx + 2600).includes("<PinThumbnail"), "Week tile not using PinThumbnail");
  const monthIdx = plan.indexOf("function MonthDayCell");
  assert(plan.slice(monthIdx, monthIdx + 5000).includes("<PinThumbnail"), "Month cell not using PinThumbnail");
  assert(plan.includes('testId="rail-select-box"') &&
    /<PinThumbnail[\s\S]{0,200}testId="rail-select-box"/.test(plan), "Unscheduled rail not using PinThumbnail");
  assert(/<PinThumbnail[\s\S]{0,160}day-detail-select-box/.test(plan), "Day detail not using PinThumbnail");
  assert(hover.includes("<PinThumbnail"), "Hover card not using PinThumbnail");
});

// Week tile uses eager (first-screen); below-the-fold thumbnails lazy.
test("First-screen Week tile loads eager; Month/Unscheduled lazy", () => {
  const weekIdx = plan.indexOf("function DraggablePinCard");
  assert(/<PinThumbnail[^>]*loading="eager"/.test(plan.slice(weekIdx, weekIdx + 2600)), "Week tile should be eager");
  const monthIdx = plan.indexOf("function MonthDayCell");
  assert(/<PinThumbnail[^>]*loading="lazy"/.test(plan.slice(monthIdx, monthIdx + 5000)), "Month thumbnail should be lazy");
});

// 13. Week/Month Batch Edit selection still works (regression guard).
test("Multi-select still routes to the shared Batch Edit workspace", () => {
  assert(plan.includes("openBatchEditFor([...selectedIds])"), "batch edit selection routing regressed");
  assert(plan.includes('testId="month-select-box"') && plan.includes('testId="scheduled-select-box"'),
    "Week/Month selection checkboxes regressed");
});

// Pinterest originals are swapped for a display-sized variant (faster thumbnails).
test("Pinterest originals are resized to a display variant for speed", () => {
  assert(/i\\\.pinimg\\\.com\\\/\)originals\\\//.test(plan) || /i\.pinimg\.com\/\)originals\//.test(plan),
    "planner toProxyUrl does not resize pinimg originals");
});

console.log(`\nPlan tile interactions: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
