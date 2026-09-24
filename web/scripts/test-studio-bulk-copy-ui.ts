/**
 * T4b — Studio bulk bar "Generate copy" entry point + start panel wiring
 * (design §4.1/§4.2, StudioBoard.tsx, BulkActionSheets.tsx).
 *
 * The logic (preflight grouping, quota math, concurrency, touched protection, 402/429
 * handling) already lives in and is covered by lib/studio/bulkGenerateCopy.ts and
 * lib/studio/bulkCopyDrafts.ts (scripts/test-bulk-generate-copy.ts,
 * scripts/test-amazon-entry-points.ts). This file only proves:
 *
 *  1. the button exists in the bulk bar, gated the same way as the other bulk actions
 *     (selectedIds.size >= 2), disabled while the sheet is open
 *  2. the panel host calls the SHARED orchestration (runBulkGenerateCopy) — no second,
 *     hand-rolled loop that calls generatePinterestPinCopy directly
 *  3. the Studio entry reads the STORED draft (no destinationUrlIsCurrent — that flag
 *     is for Plan drawer / Batch Edit's own unsaved URL, per generatePinCopy.ts's own
 *     comment)
 *  4. Stop wires to the runner's cancel hook; "Retry failed" reruns only failedIds()
 *  5. the replace-touched checkbox does not itself flip the flag — only the explicit
 *     confirm handler does (0918 §2.5 rule 5: replacing edited text needs a second
 *     confirmation)
 *  6. closing returns focus to the trigger button (0918 PRD NFR)
 *  7. the usage-response → TextUsage mapper treats an unmetered account as "unknown",
 *     never as a measured zero (mirrors SettingsModal's UsageRow honesty rule)
 *
 * Run: npx tsx scripts/test-studio-bulk-copy-ui.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { quotaPreflight } from "../src/lib/studio/bulkGenerateCopy";
import { textUsageFromBillingResponse } from "../src/lib/studio/bulkCopyDrafts";

let passed = 0, failed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  OK ${name}`); }
  catch (error) { failed++; console.error(`  FAIL ${name}\n    ${(error as Error).stack}`); }
}

const board = readFileSync("src/components/studio/StudioBoard.tsx", "utf8");
const sheets = readFileSync("src/components/studio/BulkActionSheets.tsx", "utf8");

// Slice StudioBoard to the T4b block only, so regexes cannot false-match
// BatchEditDrawer's near-identical calls (bulkCardFor / runBulkGenerateCopy / etc.
// appear there too, on purpose — they share the library, not the component).
const t4bStart = board.indexOf("// ── Bulk Generate copy (T4b)");
assert.ok(t4bStart >= 0, "T4b marker comment must exist in StudioBoard.tsx");
const t4bEnd = board.indexOf("\n  const deleteImpact = useMemo(() => {", t4bStart);
assert.ok(t4bEnd > t4bStart, "T4b block must end before the pre-existing deleteImpact block");
const t4b = board.slice(t4bStart, t4bEnd);

console.log("\n[bulk bar entry point]");
test("Generate copy button lives inside the >=2-selected bulk bar, gated like the others", () => {
  const barStart = board.indexOf("data-testid=\"bulk-bar\"");
  const barEnd = board.indexOf("data-testid=\"bulk-delete\"", barStart);
  assert.ok(barStart >= 0 && barEnd > barStart, "bulk-bar block must be discoverable");
  const bar = board.slice(barStart, barEnd);
  assert.match(bar, /data-testid="bulk-generate-copy"/);
  assert.match(bar, /onClick=\{openBulkCopy\}/);
});
test("button is disabled while its own sheet is open (no double-open)", () => {
  assert.match(board, /data-testid="bulk-generate-copy"[\s\S]{0,200}disabled=\{bulkCopyOpen\}/);
});
test("selection is frozen at open time into bulkCopyTargetIds (not read live from selectedIds while running)", () => {
  assert.match(t4b, /const openBulkCopy = useCallback\(\(\) => \{\s*const ids = Array\.from\(selectedIds\);\s*setBulkCopyTargetIds\(ids\);/);
});

console.log("\n[uses the shared orchestration, not a second loop]");
test("panel calls the shared runBulkGenerateCopy / preflightBulkCopy / mergeGeneratedCopy", () => {
  assert.match(t4b, /runBulkGenerateCopy\(\{/);
  assert.match(t4b, /preflightBulkCopy\(/);
  assert.match(t4b, /mergeGeneratedCopy\(/);
});
test("no hand-rolled sequential loop calling generatePinterestPinCopy directly in the T4b block", () => {
  // The only calls to generatePinterestPinCopy in this slice must be inside the
  // runner's `generate` callback (one call per card, orchestrated by the shared
  // runner) — never inside a bare for/while loop written in this component.
  assert.doesNotMatch(t4b, /for\s*\([^)]*\)\s*\{[\s\S]{0,400}generatePinterestPinCopy/);
  assert.doesNotMatch(t4b, /while\s*\([^)]*\)\s*\{[\s\S]{0,400}generatePinterestPinCopy/);
  assert.match(t4b, /generate: async card => \{/, "generate must be the runner's injected callback");
});
test("busy guard + product-name gate error map onto the runner's classifyError, matching BatchEditDrawer", () => {
  assert.match(t4b, /if \(!out\) throw new BulkCopyBusyError\(\);/);
  assert.match(t4b, /classifyError: classifyBulkCopyError,/);
});

console.log("\n[Studio-card semantics: stored draft, not an unsaved URL]");
test("bulkCopyCardFor does NOT pass destinationUrlIsCurrent (that flag is Plan/Batch Edit's unsaved-URL path)", () => {
  const call = t4b.match(/resolveAmazonCopyContext\([^)]*\)/)?.[0];
  assert.ok(call, "resolveAmazonCopyContext call must be present");
  assert.doesNotMatch(call!, /destinationUrlIsCurrent/, "the CALL itself (comments may mention the flag by name to explain why it's absent)");
  assert.equal(call, 'resolveAmazonCopyContext({ destinationUrl: draft.destinationUrl }, draft)');
});
test("apply writes through handlePersist (the same write path as every other Studio card edit)", () => {
  assert.match(t4b, /handlePersist\(id, \{ \.\.\.merged\.patch, metadataDraft: generated\.metadataDraft \}\)/);
});
test("apply never writes schedule/publish fields — only the merge patch + metadataDraft", () => {
  const applyStart = t4b.indexOf("apply: (id, generated) => {");
  const applyEnd = t4b.indexOf("},", applyStart);
  const applyBody = t4b.slice(applyStart, applyEnd);
  assert.doesNotMatch(applyBody, /scheduledDate|scheduledTime|plannedAt|postedAt|publishError/);
});

console.log("\n[stop / retry]");
test("Stop sets the runner's isCancelled ref (checked every worker iteration, not a hard abort)", () => {
  assert.match(t4b, /const stopBulkCopy = useCallback\(\(\) => \{ bulkCopyCancelRef\.current = true; \}, \[\]\);/);
  assert.match(t4b, /isCancelled: \(\) => bulkCopyCancelRef\.current,/);
});
test("Retry failed reruns exactly failedIds(summary), not the whole batch", () => {
  assert.match(t4b, /const ids = failedIds\(bulkCopySummary\);/);
  assert.match(t4b, /runBulkCopyOn\(ids\.map\(bulkCopyCardFor\)\)/);
});

console.log("\n[replace-touched needs a second confirmation]");
test("checking the box only requests confirmation; only the confirm action flips replaceTouched", () => {
  assert.match(sheets, /onChange=\{e => \{ if \(e\.target\.checked\) onRequestReplace\(\); else onCancelReplace\(\); \}\}/);
  assert.doesNotMatch(sheets.slice(sheets.indexOf("bulk-copy-replace-toggle"), sheets.indexOf("bulk-copy-replace-toggle") + 300), /setBulkCopyReplaceTouched|replaceTouched: true/);
});
test("StudioBoard: onRequestReplace only sets pending; onConfirmReplace sets replaceTouched", () => {
  assert.match(board, /onRequestReplace=\{\(\) => setBulkCopyReplacePending\(true\)\}/);
  assert.match(board, /onConfirmReplace=\{\(\) => \{ setBulkCopyReplaceTouched\(true\); setBulkCopyReplacePending\(false\); \}\}/);
});
test("Start is disabled while a replace confirmation is pending (can't start mid-decision)", () => {
  assert.match(sheets, /data-testid="bulk-copy-start" onClick=\{onStart\} disabled=\{preflight\.ready\.length === 0 \|\| replacePending\}/);
});

console.log("\n[focus returns to the trigger on close — 0918 PRD NFR]");
test("StudioBoard passes a triggerRef bound to the bulk-generate-copy button", () => {
  assert.match(board, /ref=\{bulkCopyTriggerRef\}\s*data-testid="bulk-generate-copy"/);
  assert.match(board, /triggerRef=\{bulkCopyTriggerRef\}/);
});
test("the sheet calls triggerRef.current?.focus() on close, not just onClose()", () => {
  assert.match(sheets, /triggerRef\?\.current\)\s*requestAnimationFrame\(\(\) => triggerRef\.current\?\.focus\(\)\)/);
});
test("close is blocked while running (X button and cancel path both gate on `running`)", () => {
  assert.match(sheets, /const handleClose = \(\) => \{\s*if \(running\) return;/);
  assert.match(sheets, /if \(e\.key === "Escape" && !running\) handleClose\(\);/);
});

console.log("\n[touch targets / readable text — 0918 NFR]");
test("sheet's action buttons declare minHeight: 44 (44px touch target)", () => {
  for (const testid of ["bulk-copy-start", "bulk-copy-stop", "bulk-copy-cancel", "bulk-copy-done", "bulk-copy-retry-failed"]) {
    const idx = sheets.indexOf(`data-testid="${testid}"`);
    assert.ok(idx >= 0, `${testid} must exist`);
    assert.match(sheets.slice(idx, idx + 400), /minHeight: 44/, `${testid} must declare a 44px touch target`);
  }
});
test("replace-toggle checkbox label reserves a 44px touch target", () => {
  const idx = sheets.indexOf('data-testid="bulk-copy-replace-toggle"');
  assert.ok(idx >= 0);
  assert.match(sheets.slice(Math.max(0, idx - 300), idx), /minHeight: 44/);
});
test("per-card status / group text renders at >=12px (no 10px status micro-copy in the new panel)", () => {
  const rowsBlock = sheets.slice(sheets.indexOf("data-testid=\"bulk-copy-rows\""), sheets.indexOf("data-testid=\"bulk-copy-summary\""));
  assert.doesNotMatch(rowsBlock, /fontSize:\s*(?:[1-9]|1[01])[,}\s]/, "no sub-12px fontSize in the row status text");
});

console.log("\n[usage → quota preflight honesty]");
test("unmetered account (no usage row yet) maps to null, never a measured zero", () => {
  assert.equal(textUsageFromBillingResponse({ metered: false, aiTextGenerations: { used: 0, limit: 10 } }), null);
  assert.equal(textUsageFromBillingResponse(null), null);
  assert.equal(textUsageFromBillingResponse({ metered: true }), null);
});
test("metered account passes used/limit through", () => {
  assert.deepEqual(textUsageFromBillingResponse({ metered: true, aiTextGenerations: { used: 3, limit: 10 } }), { used: 3, limit: 10 });
});
test("quotaPreflight on the mapped value: unmetered → unknown, never 'enough'", () => {
  const usage = textUsageFromBillingResponse({ metered: false, aiTextGenerations: { used: 0, limit: 10 } });
  assert.deepEqual(quotaPreflight(usage, 5), { kind: "unknown", needed: 5 });
});
test("metered + short remaining → 'short', not silently clamped to 'enough'", () => {
  const usage = textUsageFromBillingResponse({ metered: true, aiTextGenerations: { used: 8, limit: 10 } });
  assert.deepEqual(quotaPreflight(usage, 5), { kind: "short", needed: 5, remaining: 2 });
});

console.log(`\nStudio bulk copy UI: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
