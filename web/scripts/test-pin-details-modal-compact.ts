/**
 * Pin edit modal = one shared, small (≈480px) single-column quick-edit card.
 * Verifies the compact layout, the schedule summary + state-based action rows
 * (Schedule/Reschedule + Pin now never removed; Publish is never the only action),
 * and that every single-pin edit entry point uses the one shared component.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const modal   = readFileSync(join(root, "src/components/plan/DraftDetailsDrawer.tsx"), "utf8");
const shared  = readFileSync(join(root, "src/components/pin-details/PinDetailsModal.tsx"), "utf8");
const product = readFileSync(join(root, "src/components/pin-details/PinProductLinksSection.tsx"), "utf8");
const plan    = readFileSync(join(root, "src/app/app/plan/page.tsx"), "utf8");
const studio  = readFileSync(join(root, "src/app/app/studio/page.tsx"), "utf8");
const history = readFileSync(join(root, "src/app/app/history/page.tsx"), "utf8");

let passed = 0, failed = 0;
function test(name: string, fn: () => void) {
  try { fn(); console.log(`  OK ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}`); console.error(`       ${(e as Error).message}`); failed++; }
}
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }

console.log("Pin edit modal — compact 480px single-column quick-edit card");

// 1. ~480px, not a large/full-screen modal.
test("1. modal width ~480px (maxWidth/height calc; never 780/900/1100)", () => {
  assert(/width: 480,/.test(modal), "modal width is not 480px");
  assert(/maxWidth: "calc\(100vw - 32px\)"/.test(modal), "maxWidth not calc(100vw - 32px)");
  assert(/maxHeight: "calc\(100vh - 32px\)"/.test(modal), "maxHeight not calc(100vh - 32px)");
  assert(/borderRadius: 16/.test(modal), "border radius not 16px");
  assert(!/min\(780px|min\(900px|1100px|min\(1100px/.test(modal), "old large width still present");
});

// 2. Single-column (no two-column left rail).
test("2. single-column layout (no two-column left rail)", () => {
  assert(!/flex: "0 0 248px"/.test(modal) && !/flex: "0 0 360px"/.test(modal), "old two-column left rail still present");
});

// 3. Small thumbnail (~72×96), not a large preview.
test("3. small ~72×96 thumbnail (no large preview)", () => {
  const idx = modal.indexOf('data-testid="draft-preview"');
  assert(idx >= 0, "preview missing");
  const body = modal.slice(idx, idx + 220);
  assert(/width: 72, height: 96/.test(body), "thumbnail is not ~72×96");
  assert(!/width: 220/.test(modal) && !/maxHeight: "50vh"/.test(modal), "large preview still present");
});

// 4. No numbered sections.
test("4. no numbered form sections", () => {
  assert(!/style=\{num\}/.test(modal), "numbered markers still in modal");
  assert(!/style=\{num\}/.test(product), "numbered markers still in product section");
});

// 5. Quiet header (Edit Pin / Edit scheduled Pin), no heavy header.
test("5. quiet header, no Changes-saved banner / subtitle", () => {
  assert(/Edit scheduled Pin/.test(modal) && /"Edit Pin"/.test(modal), "header titles missing");
  assert(!/Edit publishing details/.test(modal), "heavy subtitle still present");
});

// 6. No status metadata table under the image.
test("6. no status/format/created metadata table", () => {
  assert(!/function SummaryRow/.test(modal), "SummaryRow table still present");
  assert(!/value="Needs details"|Needs details" \/>/.test(modal), "needs-details metadata card still present");
});

// 7. Inline date/time editor is reachable (Add/Edit date & time).
test("7. Schedule editor reachable via date/time action", () => {
  assert(modal.includes("draft-action-schedule"), "Add date & time action missing");
  assert(modal.includes("draft-action-reschedule"), "Edit date & time action missing");
  assert(modal.includes('data-testid="draft-schedule-editor"'), "inline schedule editor missing");
});

// 8. Auto-save: no Save changes button; Pin now lives in the overflow, not a competing CTA.
test("8. No Save changes button; Pin now in overflow", () => {
  assert(!modal.includes('data-testid="draft-edit-save"'), "Save changes button should be removed (auto-save)");
  assert(!/Save changes/.test(modal), "'Save changes' label should be gone");
  assert(modal.includes('data-testid="draft-overflow-pin-now"') && /Pin now/.test(modal), "Pin now should live in the overflow menu");
  assert(!/Publish to Pinterest/.test(modal), "old 'Publish to Pinterest' CTA still present");
});

// 9. Footer has ONE primary CTA + a non-clickable save indicator; no Cancel/Add to Plan.
test("9. single primary CTA footer with auto-save indicator", () => {
  assert(modal.includes('data-testid="draft-cta-schedule"'), "single Schedule/Update CTA missing");
  assert(/Update schedule/.test(modal) && /"Schedule"/.test(modal), "Schedule / Update schedule labels missing");
  assert(modal.includes('data-testid="draft-save-state"'), "auto-save indicator missing");
  assert(!modal.includes('data-testid="draft-details-cancel"'), "Cancel must be removed (X closes)");
  assert(!modal.includes('data-testid="pin-details-add-to-plan"'), "Add to Plan must be removed from the modal");
  assert(/Saving…/.test(modal) && /Failed to save/.test(modal), "Saving/Failed save states missing");
});

// schedule summary: Not scheduled vs date/time + GMT.
test("schedule summary shows Not scheduled or date + time(GMT)", () => {
  assert(modal.includes('data-testid="draft-not-scheduled"') && /Not scheduled/.test(modal), "Not scheduled state missing");
  assert(/formatSchedDate\(plannedDate\)/.test(modal) && /gmtLabel\(\)/.test(modal), "scheduled date/time(GMT) summary missing");
});

// Website URL placeholder + lightweight product row + no Catalog CTA.
test("compact fields: Website URL placeholder, lightweight product, no Catalog CTA", () => {
  assert(/Where should this Pin link\?/.test(modal), "Website URL placeholder missing");
  assert(/>Website URL</.test(modal), "Website URL label missing");
  assert(/No linked product/.test(product) && /> Add\b/.test(product), "lightweight product row missing");
  assert(!/Set up Pinterest catalog/i.test(product), "Pinterest Catalog CTA must be removed");
});

// 10. ONE shared component used everywhere.
test("10. Create Pins / Weekly Plan / Monthly Plan / My Pins use the one shared modal", () => {
  assert(/from "@\/components\/plan\/DraftDetailsDrawer"/.test(shared), "PinDetailsModal not re-exporting shared impl");
  assert(modal.includes("export function PinDetailsModal"), "shared impl not exported as PinDetailsModal");
  assert(studio.includes("<PinDetailsModal"), "Create Pins not using shared modal");
  assert(history.includes("<PinDetailsModal"), "My Pins not using shared modal");
  assert(plan.includes("<DraftDetailsDrawer"), "Weekly/Monthly Plan not using shared modal");
});

console.log(`\nPin edit modal compact: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
