import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canViewGenerationDebug } from "../src/lib/generationDebugAccess";
import { getPinReadiness } from "../src/lib/pinDetailsModel";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  console.log(`  OK ${name}`);
  passed++;
}
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

const studio = readFileSync(join(process.cwd(), "src/app/app/studio/page.tsx"), "utf8");
const plan = readFileSync(join(process.cwd(), "src/app/app/plan/page.tsx"), "utf8");
const history = readFileSync(join(process.cwd(), "src/app/app/history/page.tsx"), "utf8");
const modal = readFileSync(join(process.cwd(), "src/components/plan/DraftDetailsDrawer.tsx"), "utf8");
const drawer = readFileSync(join(process.cwd(), "src/components/studio/PinDetailsDrawer.tsx"), "utf8");
// Phase 2: product controls extracted into PinProductLinksSection
const productSection = readFileSync(join(process.cwd(), "src/components/pin-details/PinProductLinksSection.tsx"), "utf8");

test("Create Pins renders shared PinDetailsModal", () => {
  assert(studio.includes("<PinDetailsModal"), "Create Pins shared modal missing");
  assert(studio.includes('source="create_pins"'), "Create Pins source mode missing");
});

test("Weekly Plan uses the shared implementation through compatibility wrapper", () => {
  assert(plan.includes("<DraftDetailsDrawer"), "Weekly Plan details entry missing");
  assert(modal.includes("return <PinDetailsModal"), "Weekly Plan wrapper does not use shared modal");
});

test("History renders shared PinDetailsModal", () => {
  assert(history.includes("<PinDetailsModal"), "History shared modal missing");
  assert(history.includes('source="my_pins"'), "History source mode missing");
});

test("Generation drawer has no visible Plan tab", () => {
  assert(!drawer.includes('{ id: "plan",  label: "Plan"'), "Plan tab still visible in generation drawer");
});

test("Debug requires env flag and internal role", () => {
  assert(!canViewGenerationDebug(null, true), "anonymous user can see debug");
  assert(!canViewGenerationDebug({ user_metadata: { role: "user" } }, true), "normal user can see debug");
  assert(!canViewGenerationDebug({ user_metadata: { role: "developer" } }, false), "role bypasses disabled env flag");
  assert(canViewGenerationDebug({ app_metadata: { role: "admin" } }, true), "admin cannot see enabled debug");
  assert(canViewGenerationDebug({ user_metadata: { role: "internal_tester" } }, true), "internal tester cannot see enabled debug");
});

test("Publish readiness (WP1): only image + board block; copy/alt/URL are optional", () => {
  const missing = getPinReadiness({ imageUrl: "https://cdn.example.com/pin.jpg", title: "Title", description: "Description", altText: "Alt", destinationUrl: "", boardId: "" });
  assert(!missing.canPublish, "a Pin with no board must not be publishable");
  // WP1 contract: the missing set is now exactly image | boardId. destinationUrl is
  // optional by TYPE (it can no longer even appear in the set) — assert via string[]
  // so the intent stays visible in the test.
  assert(!(missing.missing as string[]).includes("destinationUrl"), "destination URL must never be required");
  assert(missing.missing.includes("boardId"), "a missing board must block publishing");
  // Copy and alt text are recommendations — a Pin with only image + board is ready.
  const noCopy = getPinReadiness({ imageUrl: "https://cdn.example.com/pin.jpg", title: "", description: "", altText: "", destinationUrl: "", boardId: "board_123" });
  assert(noCopy.canPublish && noCopy.detailsStatus === "ready", "image + board with no copy/alt must be ready");
  // A complete Pin WITHOUT a destination URL is publish-ready.
  const ready = getPinReadiness({ imageUrl: "https://cdn.example.com/pin.jpg", title: "Title", description: "Description", altText: "Alt", destinationUrl: "", boardId: "board_123" });
  assert(ready.canPublish && ready.detailsStatus === "ready", "complete Pin without URL is not ready");
});

test("Product URL and Destination URL are distinct in shared modal", () => {
  // Labels are localized — assert the i18n keys rather than raw English strings.
  assert(modal.includes('t("pinDetails.fromPrimaryProduct")'), "primary product destination source missing");
  assert(modal.includes('t("pinDetails.customUrl")'), "custom destination source missing");
  // "Make primary" moved to PinProductLinksSection (Phase 2 extraction — still rendered by modal)
  assert(productSection.includes("Make primary"), "primary product control missing from PinProductLinksSection");
});

console.log(`\nShared Pin Details: ${passed} passed, 0 failed`);
