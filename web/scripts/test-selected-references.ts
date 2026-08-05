/**
 * Unit tests for the unified Style Reference selection state + batch arithmetic.
 * Run: npx tsx scripts/test-selected-references.ts
 *
 * Covers Section E (one selection state, two-way sync, provenance, cap of 3) and
 * Section G (totalPins = max(refs,1) × pinsPerReference, per-group request count)
 * of `docs/prd/create pin流程变更0721-prd.txt`.
 */

import assert from "node:assert";
import {
  MAX_SELECTED_REFERENCES,
  PINS_PER_REFERENCE_OPTIONS,
  groupCount,
  isAtCapacity,
  isSelected,
  mergePickerSelection,
  planReferenceGroups,
  referenceImageUrls,
  referenceKey,
  removeReference,
  selectedPatternTags,
  toggleReference,
  totalPins,
  type SelectedReference,
} from "../src/lib/studio/selectedReferences";

let passed = 0, failed = 0;
function test(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  OK ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n     ${(e as Error).message}`); }
}

function pin(id: string, extra: Partial<SelectedReference> = {}): SelectedReference {
  return {
    id,
    imageUrl: `https://pin.example/${id}.jpg`,
    source: "recommended_pin",
    sourceUrl: `https://pinterest.com/pin/${id}`,
    title: `Pin ${id}`,
    reason: "Summer lifestyle",
    patternTags: { visualFormat: "flat_lay" },
    role: "style_reference",
    ...extra,
  };
}

function upload(id: string): SelectedReference {
  return { id, imageUrl: `https://cdn.example/${id}.png`, source: "upload", role: "style_reference" };
}

// ── Section E: one selection state ──────────────────────────────────────────

test("toggle adds a recommended Pin to the shared selection", () => {
  const next = toggleReference([], pin("a"));
  assert.equal(next.length, 1);
  assert.ok(isSelected(next, pin("a")));
});

test("toggle is its own inverse — deselecting from either surface removes it", () => {
  const added = toggleReference([], pin("a"));
  const removed = toggleReference(added, pin("a"));
  assert.deepEqual(removed, []);
});

test("removing from the top tray by key deselects the recommendation card", () => {
  const list = [pin("a"), upload("b")];
  const next = removeReference(list, referenceKey(pin("a")));
  assert.equal(next.length, 1);
  assert.ok(!isSelected(next, pin("a")), "recommended Pin must be gone");
  assert.ok(isSelected(next, upload("b")), "unrelated upload must survive");
});

test("same image from different surfaces is one selection, not two", () => {
  const viaRec = pin("a");
  const viaPicker = { ...pin("a"), source: "saved" as const };
  const next = toggleReference([viaRec], viaPicker);
  assert.deepEqual(next, [], "same key must toggle off, not duplicate");
});

test("provenance is preserved per item while sharing one collection", () => {
  const list = [pin("a"), upload("b")];
  assert.equal(list[0].source, "recommended_pin");
  assert.equal(list[0].sourceUrl, "https://pinterest.com/pin/a", "linkback required by §4.1.11");
  assert.equal(list[1].source, "upload");
  assert.equal(selectedPatternTags(list).length, 1, "only the Pin carries patternTags");
});

// ── Section E: cap of 3, never automatic ────────────────────────────────────

test("selection is capped at 3 and the 4th is a no-op", () => {
  let list: SelectedReference[] = [];
  for (const id of ["a", "b", "c"]) list = toggleReference(list, pin(id));
  assert.equal(list.length, MAX_SELECTED_REFERENCES);
  assert.ok(isAtCapacity(list));
  const overflowed = toggleReference(list, pin("d"));
  assert.equal(overflowed.length, 3, "must not exceed the cap");
  assert.ok(!isSelected(overflowed, pin("d")));
  assert.deepEqual(overflowed, list, "no silent eviction of an earlier pick");
});

test("at capacity, deselecting an existing pick still works", () => {
  const list = [pin("a"), pin("b"), pin("c")];
  const next = toggleReference(list, pin("b"));
  assert.equal(next.length, 2);
  assert.ok(!isSelected(next, pin("b")));
});

// ── Section E: picker merge must not drop recommended Pins ──────────────────

test("picker confirmation keeps recommended Pins chosen in the drawer", () => {
  const current = [pin("rec1"), upload("old")];
  const merged = mergePickerSelection(current, [upload("new")], ["upload", "saved", "url"]);
  assert.ok(isSelected(merged, pin("rec1")), "recommended Pin must survive a picker confirm");
  assert.ok(isSelected(merged, upload("new")));
  assert.ok(!isSelected(merged, upload("old")), "picker owns upload-sourced entries");
});

test("picker merge respects the cap", () => {
  const current = [pin("r1"), pin("r2")];
  const merged = mergePickerSelection(current, [upload("u1"), upload("u2")], ["upload"]);
  assert.equal(merged.length, MAX_SELECTED_REFERENCES);
});

test("referenceImageUrls preserves selection order for group assignment", () => {
  const list = [pin("a"), upload("b"), pin("c")];
  assert.deepEqual(referenceImageUrls(list), [
    "https://pin.example/a.jpg",
    "https://cdn.example/b.png",
    "https://pin.example/c.jpg",
  ]);
});

// ── Section G: batch arithmetic ─────────────────────────────────────────────

test("pinsPerReference offers only 1, 2, 3", () => {
  assert.deepEqual([...PINS_PER_REFERENCE_OPTIONS], [1, 2, 3]);
});

test("totalPins = max(refs,1) × pinsPerReference — the PRD's four examples", () => {
  assert.equal(totalPins(0, 3), 3, "0 refs, qty 3 -> 3");
  assert.equal(totalPins(1, 3), 3, "1 ref,  qty 3 -> 3");
  assert.equal(totalPins(2, 3), 6, "2 refs, qty 3 -> 6");
  assert.equal(totalPins(3, 3), 9, "3 refs, qty 3 -> 9");
});

test("batch never exceeds 9 Pins", () => {
  const max = Math.max(...PINS_PER_REFERENCE_OPTIONS.map(q => totalPins(MAX_SELECTED_REFERENCES, q)));
  assert.equal(max, 9);
});

test("groupCount is 1 when no references are selected", () => {
  assert.equal(groupCount(0), 1);
  assert.equal(groupCount(3), 3);
});

test("each group requests pinsPerReference, NOT totalPins", () => {
  const list = [pin("a"), pin("b"), pin("c")];
  const plan = planReferenceGroups(list, 3);
  assert.equal(plan.length, 3, "one group per reference");
  for (const g of plan) {
    assert.equal(g.requestCount, 3, "per-group count is pinsPerReference");
  }
  const summed = plan.reduce((n, g) => n + g.requestCount, 0);
  assert.equal(summed, totalPins(list.length, 3), "groups sum to totalPins");
  assert.equal(summed, 9);
});

test("no references still produces exactly one group", () => {
  const plan = planReferenceGroups([], 2);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].reference, null);
  assert.equal(plan[0].requestCount, 2);
  assert.equal(plan[0].requestCount, totalPins(0, 2));
});

test("each group carries its own reference for result association (G2)", () => {
  const list = [pin("a"), pin("b")];
  const plan = planReferenceGroups(list, 2);
  assert.equal(plan[0].reference?.id, "a");
  assert.equal(plan[1].reference?.id, "b");
  assert.equal(plan[0].reference?.imageUrl, "https://pin.example/a.jpg");
  assert.equal(plan[0].reference?.source, "recommended_pin");
  assert.notEqual(plan[0].reference?.id, plan[1].reference?.id, "groups must be distinguishable");
});

console.log(`\nSelected references: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
