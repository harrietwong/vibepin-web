/**
 * test-split-mixed-video-ops.ts — T2 block 6: the operator-script entry point
 * (scripts/lib/splitMixedVideoOps.ts) against an in-memory PostgREST stand-in
 * that honours `on_conflict` + `resolution=merge-duplicates|ignore-duplicates`.
 *
 * Run: npx tsx scripts/test-split-mixed-video-ops.ts
 */
import assert from "node:assert/strict";
import {
  MixedVideoCaptionRejected,
  planMixedVideoDraftWrite,
  writeMixedVideoDraft,
  type PostgrestRest,
} from "./lib/splitMixedVideoOps";
import type { PinDraft } from "../src/lib/pinDraftStore";

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed++; console.log(`  OK ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n     ${(e as Error).stack ?? (e as Error).message}`); }
}

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const CAPTION = "Cozy corner refresh\n\nComment RUG and we'll DM you the link";
const SCHEDULED_AT = "2026-10-10T13:00:00.000Z";

type Row = { vibepin_user_id: string; draft_id: string; payload: Record<string, unknown>; [k: string]: unknown };
let table: Row[] = [];
let writes = 0;

const rest: PostgrestRest = async (path, init) => {
  const url = new URL(`http://pg${path}`);
  if ((init?.method ?? "GET") === "POST") {
    writes++;
    const row = JSON.parse(String(init!.body)) as Row;
    const prefer = String((init!.headers as Record<string, string>).Prefer ?? "");
    const existing = table.find(r => r.vibepin_user_id === row.vibepin_user_id && r.draft_id === row.draft_id);
    if (existing) {
      if (prefer.includes("ignore-duplicates")) return new Response("[]", { status: 201 });
      Object.assign(existing, row);
      return new Response(prefer.includes("return=representation") ? JSON.stringify([row]) : null, { status: 201 });
    }
    table.push(row);
    return new Response(prefer.includes("return=representation") ? JSON.stringify([row]) : null, { status: 201 });
  }
  const owner = decodeURIComponent(url.searchParams.get("vibepin_user_id") ?? "").replace(/^eq\./, "");
  const ids = (url.searchParams.get("draft_id") ?? "").replace(/^in\.\(/, "").replace(/\)$/, "").split(",").map(s => s.replace(/^"|"$/g, ""));
  const rows = table.filter(r => r.vibepin_user_id === owner && ids.includes(r.draft_id)).map(r => ({ draft_id: r.draft_id, payload: r.payload }));
  return new Response(JSON.stringify(rows), { status: 200 });
};

function mixedDraft(over: Partial<PinDraft> = {}): PinDraft {
  return {
    id: "cheerish_abc", contentId: "cheerish_abc", imageUrl: "",
    media: [{ id: "video_1", kind: "video", url: "/api/storage-media?path=u%2Fv.mp4", source: "upload", width: 1080, height: 1920, durationMs: 9000 }],
    coverMediaId: "video_1", keyword: "rug", category: "Home",
    title: "Cozy rug", description: "Pinterest description https://shop.example/rug", altText: "Cozy rug",
    destinationUrl: "https://shop.example/rug", boardId: "b1", boardName: "Home",
    weeklyPlanItemId: "", generationSessionId: "",
    scheduledDate: "2026-10-10", scheduledTime: "09:00", plannedAt: "2026-10-10T09:00", scheduleTimezone: "America/New_York",
    status: "ready", createdAt: "2026-09-24T00:00:00.000Z", updatedAt: "2026-09-24T00:00:00.000Z",
    scheduledDestinations: [
      { provider: "pinterest", socialConnectionId: "pin-1", boardId: "b1", capturedAt: "2026-09-24T00:00:00.000Z" },
      { provider: "instagram", socialConnectionId: "ig-1", accountLabel: "@cheerish", capturedAt: "2026-09-24T00:00:00.000Z" },
    ],
    ...over,
  } as PinDraft;
}

function reset() { table = []; writes = 0; }

(async () => {
  await test("mixed draft → two rows: Pinterest-only parent + IG-only child with the caption", async () => {
    reset();
    const out = await writeMixedVideoDraft({ rest, userId: USER, draft: mixedDraft(), instagramCaption: CAPTION, scheduledAt: SCHEDULED_AT });
    assert.deepEqual(out, { split: true, draftIds: ["cheerish_abc", "cheerish_abc__ig"], childInserted: true });
    assert.equal(table.length, 2);
    const parent = table.find(r => r.draft_id === "cheerish_abc")!;
    const child = table.find(r => r.draft_id === "cheerish_abc__ig")!;
    assert.deepEqual((parent.payload.scheduledDestinations as Array<{ provider: string }>).map(d => d.provider), ["pinterest"]);
    assert.equal(parent.payload.description, "Pinterest description https://shop.example/rug", "the Pinterest copy is untouched");
    assert.deepEqual((child.payload.scheduledDestinations as Array<{ provider: string }>).map(d => d.provider), ["instagram"]);
    assert.equal(child.payload.description, CAPTION);
    assert.equal(child.payload.copyProfile, "instagram_caption");
    assert.equal(child.payload.destinationUrl, "");
    assert.equal(parent.scheduled_at, SCHEDULED_AT);
    assert.equal(child.scheduled_at, SCHEDULED_AT);
  });

  await test("replaying the same input 3x still leaves exactly two rows", async () => {
    reset();
    for (let i = 0; i < 3; i++) {
      await writeMixedVideoDraft({ rest, userId: USER, draft: mixedDraft(), instagramCaption: CAPTION, scheduledAt: SCHEDULED_AT });
    }
    assert.deepEqual(table.map(r => r.draft_id).sort(), ["cheerish_abc", "cheerish_abc__ig"]);
  });

  await test("an existing (merchant-edited) child is never overwritten by a replay", async () => {
    reset();
    await writeMixedVideoDraft({ rest, userId: USER, draft: mixedDraft(), instagramCaption: CAPTION, scheduledAt: SCHEDULED_AT });
    const child = table.find(r => r.draft_id === "cheerish_abc__ig")!;
    child.payload = { ...child.payload, description: "Merchant edited caption" };
    const out = await writeMixedVideoDraft({ rest, userId: USER, draft: mixedDraft(), instagramCaption: CAPTION, scheduledAt: SCHEDULED_AT });
    assert.equal(out.split && out.childInserted, false);
    assert.equal(table.find(r => r.draft_id === "cheerish_abc__ig")!.payload.description, "Merchant edited caption");
  });

  await test("empty caption → MixedVideoCaptionRejected and NOTHING is written", async () => {
    reset();
    await assert.rejects(
      writeMixedVideoDraft({ rest, userId: USER, draft: mixedDraft(), instagramCaption: "  ", scheduledAt: SCHEDULED_AT }),
      (err: unknown) => err instanceof MixedVideoCaptionRejected && err.issues.includes("instagram_caption_required"),
    );
    assert.equal(writes, 0);
  });

  await test("caption with a link → rejected before any write", async () => {
    reset();
    await assert.rejects(
      writeMixedVideoDraft({ rest, userId: USER, draft: mixedDraft(), instagramCaption: "Shop at cheerish.co", scheduledAt: SCHEDULED_AT }),
      (err: unknown) => err instanceof MixedVideoCaptionRejected && err.issues.includes("instagram_caption_contains_link"),
    );
    assert.equal(writes, 0);
  });

  await test("a Pinterest-only video draft is written as one row; no caption needed", async () => {
    reset();
    const draft = mixedDraft({ scheduledDestinations: [mixedDraft().scheduledDestinations![0]] });
    const out = await writeMixedVideoDraft({ rest, userId: USER, draft, scheduledAt: SCHEDULED_AT });
    assert.deepEqual(out, { split: false, draftIds: ["cheerish_abc"] });
    assert.equal(table.length, 1);
  });

  await test("readback is owner-scoped: another owner's rows do not satisfy it", async () => {
    reset();
    table.push({ vibepin_user_id: OTHER, draft_id: "cheerish_abc__ig", payload: {} });
    const out = await writeMixedVideoDraft({ rest, userId: USER, draft: mixedDraft(), instagramCaption: CAPTION, scheduledAt: SCHEDULED_AT });
    assert.equal(out.split, true);
    assert.equal(table.filter(r => r.vibepin_user_id === USER).length, 2);
  });

  await test("planMixedVideoDraftWrite is pure (dry-run preview) and validates only when splitting", () => {
    const plan = planMixedVideoDraftWrite(mixedDraft(), CAPTION, new Date("2026-09-24T01:00:00.000Z"));
    assert.equal(plan.split, true);
    const single = planMixedVideoDraftWrite(mixedDraft({ media: [{ id: "i", kind: "image", url: "https://x/i.png" }] as PinDraft["media"] }), null);
    assert.equal(single.split, false, "mixed IMAGE drafts are out of scope");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
