/**
 * T4 — per-Pin confirmation list before schedule / publish (Fable ruling 4).
 *
 *  - removed Pins are NOT submitted; only the remaining ones are (bulk publish in
 *    Studio, Batch Edit publish, Batch Edit schedule)
 *  - with nothing removed the submitted set is exactly the selection (same as before)
 *  - confirm is disabled until the list was scrolled through and something is left
 *  - rows show thumbnail, title, destination link, account / Board
 *  - "AI copy not edited" badge is a hint only — it never disables confirm
 *  - the single-Pin publish dialog renders the SAME component (a list of one)
 *
 * Run: npx tsx scripts/test-pin-confirm-list.ts
 */
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "anon";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

let passed = 0, failed = 0;
async function test(name: string, fn: () => unknown | Promise<unknown>) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (error) { failed++; console.error(`  ✗ ${name}\n    ${(error as Error).stack}`); }
}

async function main() {
  const lib = await import("../src/lib/studio/pinConfirmList");
  const { LocaleProvider } = await import("../src/lib/i18n/LocaleProvider");
  const { PinConfirmList } = await import("../src/components/studio/PinConfirmList");
  const { BulkPublishSheet } = await import("../src/components/studio/BulkActionSheets");
  const { ConfirmPublishDialog } = await import("../src/components/shared/ConfirmPublishDialog");
  const en = (await import("../src/lib/i18n/messages/en")).default as Record<string, string>;
  const render = (el: React.ReactElement) => renderToStaticMarkup(React.createElement(LocaleProvider, null, el));
  const tr = ((key: string) => en[key] ?? key) as never;
  const platformName = (p: string) => p[0].toUpperCase() + p.slice(1);

  const ai = { selectedTitle: "AI title", selectedDescription: "AI description", copyGenerationMeta: { generatedAt: "x" } } as never;
  const pinterest = { id: "pinterest:c1", provider: "pinterest" as const, socialConnectionId: "c1", accountLabel: "@quiet", boardId: "b1", boardName: "Kitchen" };
  const snapshot = (id: string, extra: Record<string, unknown> = {}) => ({
    draftId: id, intentId: `i-${id}`, title: `Pin ${id}`, description: "desc", destinationUrl: `https://www.amazon.com/dp/B0BSHF7WH${id.slice(-1)}?tag=me-20`,
    media: [{ id: "m", kind: "image", url: `https://img/${id}.jpg` }], publishableDestinations: [pinterest], destinations: [pinterest],
    blockers: [], mode: { kind: "now" }, ...extra,
  });

  console.log("\n[submit filter: removed Pins are never submitted]");
  await test("remove 2 of 5 → exactly the other 3 are submitted, in order", () => {
    const targets = ["a", "b", "c", "d", "e"].map(id => ({ id }));
    const submitted: string[] = [];
    const submit = (list: Array<{ id: string }>) => { for (const t of list) submitted.push(t.id); };
    submit(lib.selectConfirmedTargets(targets, new Set(["b", "d"]), t => t.id));
    assert.deepEqual(submitted, ["a", "c", "e"]);
  });
  await test("nothing removed → the submitted set is exactly the selection (pre-T4 behaviour)", () => {
    const ids = ["p1", "p2", "p3"];
    assert.deepEqual(lib.selectConfirmedTargets(ids, new Set(), id => id), ids);
  });
  await test("toggleExcluded removes and adds back", () => {
    let ex: ReadonlySet<string> = new Set();
    ex = lib.toggleExcluded(ex, "a"); assert.ok(ex.has("a"));
    ex = lib.toggleExcluded(ex, "a"); assert.ok(!ex.has("a"));
  });
  await test("confirm needs the list scrolled through AND at least one Pin left", () => {
    assert.equal(lib.canSubmitConfirmList(["a", "b"], new Set(), false), false, "not scrolled through");
    assert.equal(lib.canSubmitConfirmList(["a", "b"], new Set(), true), true);
    assert.equal(lib.canSubmitConfirmList(["a", "b"], new Set(["a", "b"]), true), false, "everything removed");
    assert.equal(lib.hasReachedListEnd({ scrollTop: 0, clientHeight: 300, scrollHeight: 300 }), true, "no overflow → read");
    assert.equal(lib.hasReachedListEnd({ scrollTop: 0, clientHeight: 300, scrollHeight: 900 }), false);
    assert.equal(lib.hasReachedListEnd({ scrollTop: 600, clientHeight: 300, scrollHeight: 900 }), true);
  });

  console.log("\n[AI-unedited badge: hint, never a blocker]");
  await test("badge only for AI copy still unchanged and untouched", () => {
    assert.equal(lib.isAiCopyUnedited({ title: "AI title", description: "mine", metadataDraft: ai }), true);
    assert.equal(lib.isAiCopyUnedited({ title: "AI title", description: "AI description", metadataDraft: ai, metadataTouched: { titleTouched: true, descriptionTouched: true } }), false);
    assert.equal(lib.isAiCopyUnedited({ title: "Edited", description: "Edited too", metadataDraft: ai }), false);
    assert.equal(lib.isAiCopyUnedited({ title: "AI title", description: "AI description" }), false, "never generated → no badge");
  });
  await test("the badge does not affect whether confirm is enabled", () => {
    // canSubmitConfirmList takes no badge input at all: the badge cannot gate.
    assert.equal(lib.canSubmitConfirmList.length, 3);
    const html = render(React.createElement(PinConfirmList, { items: [{ id: "a", thumbnailUrl: null, title: "A", destinationUrl: "", targets: [], aiUnedited: true }] }));
    assert.match(html, /data-testid="pin-confirm-ai-unedited"/);
    assert.doesNotMatch(html, / disabled=""/);
  });

  console.log("\n[rows]");
  await test("row shows thumbnail, title, link, account / Board; removed rows are marked", () => {
    const item = lib.confirmItemFromSnapshot(snapshot("d1") as never, { title: "Pin d1", description: "desc", metadataDraft: ai }, platformName as never);
    assert.equal(item.thumbnailUrl, "https://img/d1.jpg");
    assert.deepEqual(item.targets, ["Pinterest · @quiet · Kitchen"]);
    const html = render(React.createElement(PinConfirmList, { items: [item, { ...item, id: "d2", title: "Pin d2" }], excluded: new Set(["d2"]), onToggleExclude: () => {} }));
    assert.match(html, /<img src="https:\/\/img\/d1.jpg"/);
    assert.match(html, /Pin d1/);
    assert.match(html, /https:\/\/www.amazon.com\/dp\/B0BSHF7WH1\?tag=me-20/);
    assert.match(html, /Pinterest · @quiet · Kitchen/);
    assert.match(html, /data-id="d2" data-excluded="true"/);
    assert.match(html, /data-id="d1" data-excluded="false"/);
    assert.equal((html.match(/data-testid="pin-confirm-remove"/g) ?? []).length, 2);
    assert.match(html, new RegExp(en["publishConfirm.list.undo"]));
    assert.doesNotMatch(html, /publishConfirm\.list\./, "no raw keys");
  });

  console.log("\n[bulk publish sheet]");
  await test("Studio bulk sheet lists every ready Pin; confirm starts disabled and counts only the remaining ones", () => {
    const partition = { ready: [{ id: "d1", title: "Pin d1" }, { id: "d2", title: "Pin d2" }, { id: "d3", title: "Pin d3" }], blocked: [], alreadyPublished: [], generating: [], scheduledNowCount: 0 } as never;
    const confirmItems = ["d1", "d2", "d3"].map(id => lib.confirmItemFromSnapshot(snapshot(id) as never, null, platformName as never));
    const html = render(React.createElement(BulkPublishSheet, {
      tr, partition, confirmations: {}, progress: null, summary: null, onConfirm: () => {}, onClose: () => {},
      confirmItems, excluded: new Set(["d2"]), onToggleExclude: () => {},
    }));
    assert.equal((html.match(/data-testid="pin-confirm-row"/g) ?? []).length, 3);
    assert.match(html, /data-testid="bulk-publish-confirm"[^>]* disabled=""/,"not scrolled through yet (SSR) → disabled");
    assert.match(html, /Publish 2/, "label counts the remaining Pins");
  });

  console.log("\n[single Pin: same component, a list of one]");
  await test("ConfirmPublishDialog renders PinConfirmList with one non-removable row, link and badge", () => {
    const html = render(React.createElement(ConfirmPublishDialog, { open: true, snapshot: snapshot("d9") as never, onConfirm: () => {}, onCancel: () => {}, aiUnedited: true }));
    assert.equal((html.match(/data-testid="pin-confirm-row"/g) ?? []).length, 1);
    assert.doesNotMatch(html, /data-testid="pin-confirm-remove"/);
    assert.match(html, /https:\/\/www.amazon.com\/dp\/B0BSHF7WH9\?tag=me-20/);
    assert.match(html, /data-testid="pin-confirm-ai-unedited"/);
    assert.doesNotMatch(html, /data-testid="confirm-publish-confirm"[^>]* disabled=""/,"the badge never disables publish");
  });

  console.log("\n[wiring: every submit goes through the filter]");
  const board = readFileSync("src/components/studio/StudioBoard.tsx", "utf8");
  const batch = readFileSync("src/components/studio/BatchEditDrawer.tsx", "utf8");
  await test("Studio bulk publish submits ready minus removed", () => {
    assert.match(board, /const targets = selectConfirmedTargets\(bulkPublishPartition\.ready, bulkExcluded, target => target\.id\);/);
    assert.match(board, /confirmItems=\{bulkConfirmItems\}\s*excluded=\{bulkExcluded\}/);
    assert.match(board, /setBulkExcluded\(new Set\(\)\)/, "reset every time the sheet opens");
  });
  await test("Batch Edit publish submits confirmed minus removed; 'publish ready' goes through the list first", () => {
    assert.match(batch, /runPublish\(selectConfirmedTargets\(checkedPins\.filter\(p => !!publishConfirmations\[p\.pinId\]\), publishExcluded, p => p\.pinId\)\)/);
    assert.match(batch, /data-testid="batch-edit-publish-ready" onClick=\{\(\) => \{ setPublishReachedEnd\(false\); setPublishPhase\("confirm"\); \}\}/);
    assert.doesNotMatch(batch, /runPublish\(checkedPins\)/, "no path submits the raw selection");
  });
  await test("Batch Edit schedule submits checked minus removed", () => {
    assert.match(batch, /selectConfirmedTargets\(\[\.\.\.checkedRows\], scheduleExcluded, id => id\)/);
    assert.match(batch, /data-testid="batch-edit-schedule-confirm" disabled=\{!canGo\} onClick=\{submitScheduleSelected\}/);
  });
  await test("single-Pin dialogs pass the badge from the draft (Studio and Plan)", () => {
    assert.match(board, /aiUnedited=\{\(\) => \{|aiUnedited=\{\(\(\) =>/);
    const plan = readFileSync("src/components/plan/DraftDetailsDrawer.tsx", "utf8");
    assert.match(plan, /aiUnedited=\{!!draft && isAiCopyUnedited\(\{ \.\.\.draft, title, description \}\)\}/);
  });

  console.log(`\nPin confirm list: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch(error => { console.error(error); process.exit(1); });
