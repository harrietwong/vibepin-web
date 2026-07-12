/**
 * Hover preview image instantness — no white flash.
 * Verifies: shared PinThumbnail (not raw <img>) with an always-dark placeholder +
 * eager load inside the dark hover card, pointer-enter preloads the preview image,
 * preloadImage de-duplicates, and selection toggles don't remount the image.
 * Maps to the spec's "Tests required" 1–8.
 */

// ── Browser shim (with a controllable Image) ────────────────────────────────────
const g = globalThis as unknown as Record<string, unknown>;
let imageInstances = 0;
const created: Array<{ _src: string; onload: (() => void) | null; onerror: (() => void) | null; fireLoad: () => void }> = [];
class FakeImage {
  decoding = "";
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  _src = "";
  constructor() { imageInstances++; }
  set src(v: string) { this._src = v; created.push(this); }
  get src() { return this._src; }
  fireLoad() { this.onload?.(); }
}
g.window = g.window ?? {};
g.Image = FakeImage as unknown as typeof Image;

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { preloadImage, isImagePreloaded } from "../src/lib/imagePreload";

let passed = 0, failed = 0;
function test(name: string, fn: () => void) {
  try { fn(); console.log(`  OK ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}`); console.error(`       ${(e as Error).message}`); failed++; }
}
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }

const hover = readFileSync(join(process.cwd(), "src/components/plan/PinHoverPreview.tsx"), "utf8");
const thumb = readFileSync(join(process.cwd(), "src/components/plan/PinThumbnail.tsx"), "utf8");
const css   = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");
const plan  = readFileSync(join(process.cwd(), "src/app/app/plan/page.tsx"), "utf8");

console.log("Hover preview image — no white flash");

// 1. Hover preview uses the shared PinThumbnail (not a raw <img> with white default).
test("1. hover card renders the shared PinThumbnail, not a raw <img>", () => {
  assert(hover.includes("<PinThumbnail"), "hover card not using PinThumbnail");
  // No raw <img ... src={toThumbUrl in the card body (the thumbnail owns the <img>).
  assert(!/<img[^>]*toThumbUrl/.test(hover), "hover card still renders a raw <img> for the preview");
});

// 2. Dark placeholder/skeleton before load (never white inside the dark card).
test("2. hover card placeholder is always-dark (not theme near-white)", () => {
  assert(/<PinThumbnail[^>]*\bdark\b/.test(hover), "hover PinThumbnail missing dark placeholder flag");
  assert(thumb.includes("pin-thumb-skeleton--dark"), "PinThumbnail has no dark skeleton variant");
  assert(/\.pin-thumb-skeleton--dark\s*\{/.test(css), "dark skeleton CSS missing");
  assert(/background-color:\s*#0f172a/i.test(css), "dark skeleton is not a dark color");
  // Wrapper itself paints dark immediately (first-frame guarantee, no white).
  assert(/background: dark \? "#0f172a" : undefined/.test(thumb), "PinThumbnail wrapper has no dark base color");
});

// 3. Eager load inside the hover card (immediately visible after open).
test("3. hover preview image loads eager", () => {
  assert(/<PinThumbnail[^>]*loading="eager"/.test(hover), "hover preview image not eager");
});

// 4. Pointer enter preloads the preview image (same URL the card renders).
test("4. tile pointer-enter preloads the preview image URL", () => {
  assert(hover.includes("preloadImage(toThumbUrl(draft.imageUrl))"), "warmPreview does not preload the card image URL");
  assert(/onPointerEnter=\{handlePointerEnter\}/.test(hover) && /warmPreview\(\)/.test(hover), "pointer enter does not warm the preview");
});

// 5. preloadImage de-duplicates repeated calls.
test("5. preloadImage de-duplicates (one Image per URL; cached resolves instantly)", () => {
  imageInstances = 0;
  const url = "https://i.pinimg.com/736x/a/b/c/abc.jpg";
  const p1 = preloadImage(url);
  const p2 = preloadImage(url); // in-flight → same promise, no new Image
  assert(imageInstances === 1, `expected 1 Image while loading, got ${imageInstances}`);
  assert(p1 === p2, "concurrent calls should share one promise");
  // resolve the load
  created[created.length - 1].fireLoad();
  assert(isImagePreloaded(url), "URL not marked preloaded after load");
  preloadImage(url); // already loaded → no new Image
  assert(imageInstances === 1, `cached URL must not create a new Image, got ${imageInstances}`);
});

// 6. Selection toggle does not change image component keys (no remount/reload).
test("6. PinThumbnail load state is keyed by src only (selection never remounts it)", () => {
  assert(/useEffect\(\(\) => \{\s*setStatus\("loading"\);\s*\}, \[src\]\)/.test(thumb), "load state not keyed on [src]");
  // tiles are keyed by stable draft id, never by selected/hover state.
  assert(!/key=\{[^}]*selected/.test(plan) && !/key=\{[^}]*hovered/.test(plan), "image list keyed by selection/hover state");
});

// 7. Month View uses the same hover image behavior (same shared component).
test("7. Month + Week share the same hover preview component", () => {
  const monthIdx = plan.indexOf("function MonthDayCell");
  const weekIdx = plan.indexOf("function DraggablePinCard");
  assert(plan.slice(monthIdx, monthIdx + 5000).includes("<PinHoverTarget"), "Month cell missing shared hover target");
  assert(plan.slice(weekIdx, weekIdx + 2600).includes("<PinHoverTarget"), "Week tile missing shared hover target");
});

// 8. Image error shows a dark fallback, not a blank white rectangle.
test("8. error fallback is dark inside the hover card (no white block)", () => {
  assert(thumb.includes('onError={() => setStatus("error")}'), "no error handling");
  assert(/status === "error" \? \(dark \? "#0f172a"/.test(thumb), "error placeholder not dark when dark flag set");
  assert(thumb.includes('data-testid="pin-thumbnail-fallback"'), "no fallback element");
});

console.log(`\nHover preview image: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
