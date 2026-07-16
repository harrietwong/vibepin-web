/**
 * Unit tests for deriveTopPickIds (Creative Intelligence — WP1 "Top pick" badge).
 * Run: npx tsx scripts/test-top-pick.ts   (from web/)
 */

import assert from "node:assert/strict";
import { deriveTopPickIds } from "../src/lib/studio/topPick";
import type { PinDraft, QualityJudge } from "../src/lib/pinDraftStore";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  OK ${name}`);
}

function judge(overall: number | undefined, verdict: QualityJudge["verdict"] = "ok", status: QualityJudge["status"] = "ready"): QualityJudge {
  return { status, verdict, overall, judgeVersion: "test", updatedAt: "2026-07-11T00:00:00.000Z" };
}

let seq = 0;
function draft(over: Partial<PinDraft> & { id: string }): PinDraft {
  seq++;
  return {
    source: "ai_generated_from_upload",
    generationSessionId: "s1",
    createdAt: over.createdAt ?? `2026-07-11T00:00:0${seq}.000Z`,
    updatedAt: "2026-07-11T00:00:00.000Z",
    ...over,
  } as PinDraft;
}

// ── Happy path: highest overall in a ≥2 qualified batch wins ──────────────────
test("picks the highest overall in a batch", () => {
  const top = deriveTopPickIds([
    draft({ id: "a", qualityJudge: judge(70) }),
    draft({ id: "b", qualityJudge: judge(88) }),
    draft({ id: "c", qualityJudge: judge(81) }),
  ]);
  assert.deepEqual([...top], ["b"]);
});

// ── Lone qualifying card → no top pick (needs ≥2) ─────────────────────────────
test("no top pick when only one card qualifies", () => {
  const top = deriveTopPickIds([
    draft({ id: "a", qualityJudge: judge(90) }),
    draft({ id: "b", qualityJudge: judge(60, "invalid") }), // excluded → group size 1
  ]);
  assert.equal(top.size, 0);
});

// ── Ties break toward the earliest-created card ───────────────────────────────
test("tie on overall → earliest createdAt wins", () => {
  const top = deriveTopPickIds([
    draft({ id: "late", createdAt: "2026-07-11T00:00:05.000Z", qualityJudge: judge(85) }),
    draft({ id: "early", createdAt: "2026-07-11T00:00:01.000Z", qualityJudge: judge(85) }),
  ]);
  assert.deepEqual([...top], ["early"]);
});

// ── Non-qualifying cards are ignored ──────────────────────────────────────────
test("excludes invalid verdict, non-ready status, missing overall, and uploads", () => {
  const top = deriveTopPickIds([
    draft({ id: "invalid", qualityJudge: judge(99, "invalid") }),
    draft({ id: "pending", qualityJudge: judge(99, "ok", "pending") }),
    draft({ id: "nooverall", qualityJudge: judge(undefined) }),
    draft({ id: "upload", source: "uploaded_image", qualityJudge: judge(99) }),
    draft({ id: "good1", qualityJudge: judge(75) }),
    draft({ id: "good2", qualityJudge: judge(80) }),
  ]);
  assert.deepEqual([...top], ["good2"]);
});

// ── Multiple batches each get their own top pick ──────────────────────────────
test("one top pick per generationSessionId batch", () => {
  const top = deriveTopPickIds([
    draft({ id: "a1", generationSessionId: "s1", qualityJudge: judge(70) }),
    draft({ id: "a2", generationSessionId: "s1", qualityJudge: judge(90) }),
    draft({ id: "b1", generationSessionId: "s2", qualityJudge: judge(65) }),
    draft({ id: "b2", generationSessionId: "s2", qualityJudge: judge(88) }),
  ]);
  assert.deepEqual([...top].sort(), ["a2", "b2"]);
});

// ── Empty / no batch id ───────────────────────────────────────────────────────
test("no session id → never a top pick", () => {
  const top = deriveTopPickIds([
    draft({ id: "a", generationSessionId: "", qualityJudge: judge(90) }),
    draft({ id: "b", generationSessionId: "", qualityJudge: judge(80) }),
  ]);
  assert.equal(top.size, 0);
});

console.log(`\n${passed} tests passed.`);
