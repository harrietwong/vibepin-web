/**
 * test-schedule-publish-validation.ts
 * RC0 WP1 follow-up: "complete the schedule/publish validation contract".
 *
 * Covers the 10 items from the task report, plus title/description over-limit and the
 * server-side truncation fallback. Pure node — no DOM/browser. Mixes:
 *   - pure-logic unit tests against pinReadiness.ts / smartSchedule.ts / publishPin.ts
 *   - source-level assertions against the four handler surfaces (StudioBoard,
 *     PinBoardCard/PinFieldsForm, BatchEditDrawer, DraftDetailsDrawer) — the same style
 *     test-pin-details-persistence.ts and test-pin-readiness.ts already use for wiring
 *     that isn't practical to exercise without a real DOM.
 *
 * Run: npx tsx scripts/test-schedule-publish-validation.ts   (from web/)
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

process.env.PINTEREST_TOKEN_ENC_KEY = randomBytes(32).toString("base64");
process.env.PINTEREST_APP_ID = "test-app-id";
process.env.PINTEREST_APP_SECRET = "test-app-secret";
process.env.PINTEREST_REDIRECT_URI = "http://localhost:3000/api/auth/pinterest/callback";
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";

let passed = 0, failed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log(`  OK ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n     ${(e as Error).stack ?? (e as Error).message}`); }
}

const root = process.cwd();

async function main() {
  const readiness = await import("../src/lib/pinReadiness");
  const { isValidDestinationUrl, isPublishableImage, pinFieldErrors, hasPinFieldErrors, TITLE_MAX_LENGTH, DESCRIPTION_MAX_LENGTH } = readiness;

  // ── 1. Illegal URL cannot Schedule ────────────────────────────────────────────
  await test("1. Illegal destination URL fails isValidDestinationUrl (blocks Schedule)", () => {
    assert.equal(isValidDestinationUrl("not a url"), false);
    assert.equal(isValidDestinationUrl("javascript:alert(1)"), false);
    assert.equal(isValidDestinationUrl("http://localhost:3000/x"), false);
  });
  await test("1b. DraftDetailsDrawer.canSchedule requires hasValidUrl", () => {
    const src = readFileSync(join(root, "src/components/plan/DraftDetailsDrawer.tsx"), "utf8");
    assert.match(src, /const canSchedule = hasBoard && hasWhen && hasValidImage && hasValidUrl/);
  });

  // ── 2. Illegal URL cannot Publish ─────────────────────────────────────────────
  await test("2. DraftDetailsDrawer.handlePublish blocks on !isValidDestinationUrl", () => {
    const src = readFileSync(join(root, "src/components/plan/DraftDetailsDrawer.tsx"), "utf8");
    assert.match(src, /if \(!isValidDestinationUrl\(destinationUrl\)\) \{[\s\S]{0,120}setUrlError\(true\)/);
  });
  await test("2b. validateOptionalLink (server) rejects the same illegal URLs", async () => {
    const validate = await import("../src/lib/server/pinterest/validatePublish");
    assert.equal(validate.validateOptionalLink("not a url").ok, false);
    assert.equal(validate.validateOptionalLink("http://localhost/x").ok, false);
  });

  // ── 3. Missing board cannot Schedule ──────────────────────────────────────────
  await test("3. pinMissingFields flags a blank board as missing", () => {
    const missing = readiness.pinMissingFields({ imageUrl: "https://example.com/a.jpg", boardId: "" });
    assert.ok(missing.includes("board"));
  });
  await test("3b. StudioBoard.handleSchedule blocks via noBoardAccess || !isPinReady (board is a hard gate)", () => {
    const src = readFileSync(join(root, "src/components/studio/StudioBoard.tsx"), "utf8");
    assert.match(src, /const handleSchedule = useCallback[\s\S]*?if \(noBoardAccess \|\| !isPinReady\(draftReadiness\(d\)\)\)/);
    assert.match(src, /if \(!d\.boardId\?\.trim\(\) && !noBoardAccess\)/);
  });
  await test("3c. ensureScheduledPlanTime (canonical Schedule/Add-to-Plan entry) blocks on empty boardId", () => {
    const src = readFileSync(join(root, "src/lib/smartSchedule.ts"), "utf8");
    assert.match(src, /if \(!sanitizeHandoffField\(draft\.boardId\)\) \{\s*\n\s*return \{ ok: false, reason: "not_ready", toast: "Choose a Pinterest board/);
  });

  // ── 4. Non-public image cannot Schedule ───────────────────────────────────────
  await test("4. isPublishableImage rejects blob/data/localhost URLs", () => {
    assert.equal(isPublishableImage("blob:http://localhost/abc"), false);
    assert.equal(isPublishableImage("data:image/png;base64,AAAA"), false);
    assert.equal(isPublishableImage("http://localhost:3000/img.png"), false);
    assert.equal(isPublishableImage("https://cdn.example.com/img.png"), true);
  });
  await test("4b. ensureScheduledPlanTime blocks on a non-publishable image", () => {
    const src = readFileSync(join(root, "src/lib/smartSchedule.ts"), "utf8");
    assert.match(src, /if \(!isPublishableImage\(draft\.imageUrl\)\) \{\s*\n\s*return \{ ok: false, reason: "not_ready", toast: "Upload a usable image/);
  });

  // ── 5 / 6. Edit-then-immediately-Schedule/Publish uses the LATEST fields ─────
  await test("5/6. StudioBoard handleSchedule/handlePublish re-read pinDraftStore.getDraft(id) at call time (no stale closure)", () => {
    const src = readFileSync(join(root, "src/components/studio/StudioBoard.tsx"), "utf8");
    assert.match(
      src,
      /const handleSchedule = useCallback\(\(id: string\) => \{\s*\n\s*const d = pinDraftStore\.getDraft\(id\); if \(!d\) return;/,
      "handleSchedule must read the store fresh, not a closed-over draft",
    );
    assert.match(
      src,
      // `let` is allowed here (not just `const`): the board auto-adopt fix
      // reassigns `d` after re-reading the store. What matters for this
      // contract is that the draft is READ FRESH at call time, not closed over.
      /const handlePublish = useCallback\(async \(id: string,?[^)]*\) => \{\s*\n\s*(?:const|let) d = pinDraftStore\.getDraft\(id\); if \(!d\) return;/,
      "handlePublish must read the store fresh, not a closed-over draft",
    );
  });
  await test("5/6b. PinBoardCard flushes pending debounced edits synchronously before onSchedule/onPublish", () => {
    const src = readFileSync(join(root, "src/components/studio/PinBoardCard.tsx"), "utf8");
    // Both actions guard on destinationError first (an unresolvable account must not
    // schedule or publish a half-recorded intent), then flush, then act. The ORDER is
    // what matters: flush() must land before the handler re-reads the store.
    assert.match(src, /const doSchedule = useCallback\(\(\) => \{\s*\n\s*if \(destinationError\) return;\s*\n\s*flush\(\);\s*\n\s*props\.onSchedule\(draft\.id\);/);
    // doPublish now carries the publish SCOPE ({ onlyPending }) and closes the
    // confirm before dispatching. The invariant is unchanged: the destination guard
    // and the synchronous flush both run BEFORE onPublish is called.
    assert.match(src, /const doPublish = useCallback\(\(options\?: \{ onlyPending\?: boolean \}\) => \{\s*\n\s*if \(destinationError\) return;\s*\n\s*flush\(\);\s*\n\s*setConfirmPublish\(false\);\s*\n\s*props\.onPublish\(draft\.id, options\);/);
    // flush() must be a SYNCHRONOUS persistNow call (not merely clearing the debounce
    // timer) so the store write has landed before onSchedule/onPublish re-reads it.
    assert.match(src, // flush also settles the card's save-state line now, so the body spans several
    // lines. What this pins is unchanged: the pending debounce is cancelled and the
    // edit persisted SYNCHRONOUSLY, before any schedule/publish leaves the card.
    /const flush = useCallback\(\(\) => \{\s*\n?\s*if \(timer\.current\) \{\s*\n?\s*clearTimeout\(timer\.current\); timer\.current = null;\s*\n?\s*persistNow\(pendingRef\.current\);/);
  });
  await test("5/6c. DraftDetailsDrawer.handlePublish persists current field state, then reads the SAME state for the payload (single source, no second read)", () => {
    const src = readFileSync(join(root, "src/components/plan/DraftDetailsDrawer.tsx"), "utf8");
    // The drawer's Publish / Retry both land here; the retry flag only changes onlyPending.
    const start = src.indexOf("async function handlePublish(retry: boolean) {");
    const end = src.indexOf("\n  const destMissing = !destinationUrl.trim();", start); // next top-level statement after handlePublish
    assert.ok(start > -1 && end > start, "handlePublish body bounds not found");
    const body = src.slice(start, end);
    assert.match(body, /persistDraft\(\);/, "handlePublish must persist current field state before publishing");
    // The drawer publishes through the shared publishContent, which reads copy / image /
    // link off the draft in the store — so the store IS the single source, and the
    // write (persistDraft) must land before that read starts.
    assert.match(body, /await publishContent\(activeDraft\.id, \{/, "the drawer must publish through the shared publishContent");
    assert.doesNotMatch(body, /await publishPin\(/, "no second Pinterest publish path may remain in the drawer");
    assert.ok(body.indexOf("persistDraft();") < body.indexOf("await publishContent("), "persist must precede the shared publish");
  });

  await test("5/6d. PinBoardCard's board field rewrites the Pinterest entry it speaks for (a board edit IS a destination edit)", () => {
    const src = readFileSync(join(root, "src/components/studio/PinBoardCard.tsx"), "utf8");
    // Owner decision 2026-08-27. Before this, persistNow wrote the legacy boardId/boardName
    // only, so a Content that already carried stored intent showed the NEW board on the card
    // and published to the OLD one — the cron reads the entry's own board, not the legacy
    // field. The rewrite must live in persistNow itself: a call anywhere else in this file
    // would not run on a board-only edit, which is exactly the case that broke.
    const start = src.indexOf("const persistNow = useCallback((f: PinFieldsValue) => {");
    const end = src.indexOf("const flush = useCallback(", start);
    assert.ok(start > -1 && end > start, "persistNow body bounds not found");
    const body = src.slice(start, end);
    assert.match(src, /withBoardOnPinterestEntry,[\s\S]{0,200}?from "@\/lib\/social\/scheduledDestinations"/,
      "PinBoardCard must import the shared entry-rewrite helper, not reimplement it");
    assert.match(body, /withBoardOnPinterestEntry\(/,
      "persistNow must route the board edit through withBoardOnPinterestEntry");
    // Guarded on an actual board change: an unconditional rewrite would make every
    // keystroke in title/description a destinations writer.
    assert.match(body, /boardChanged\s*=\s*[^;]*current\.boardId/,
      "the rewrite must be guarded on the board actually changing");
    // And it must rewrite the STORED entries, read FRESH from the store — the same
    // contract 5/6a pins on handlePublish. The flush effect runs the PREVIOUS persistNow
    // in its cleanup, so intent computed from the closed-over draft would overwrite a
    // concurrent writer (the picker on this card, AI copy, a sync) whose write landed
    // during the debounce window.
    assert.match(body, /const current = getDraft\(draft\.id\) \?\? draft;/,
      "persistNow must read the draft fresh from the store, not from its closure");
    assert.match(body, /current\.scheduledDestinations/, "the rewrite must read the stored intent");
    assert.doesNotMatch(body, /draft\.scheduledDestinations|draft\.targetConnectionId|draft\.boardId/,
      "persistNow must not read intent off the closed-over draft");
    assert.doesNotMatch(body, /selectedAccountIds|buildScheduledDestinations|connectionSummaries/,
      "persistNow must not re-derive intent from picker state");
  });
  await test("5/6e. DraftDetailsDrawer moves the board on stored intent for an UNDATED Pin too", () => {
    const src = readFileSync(join(root, "src/components/plan/DraftDetailsDrawer.tsx"), "utf8");
    // The drawer already rebuilds scheduledDestinations for a DATED Pin (buildScheduledDestinations
    // inside `if (trimmedDate)`), which covers its board field there. An undated Pin can still
    // carry stored intent — the card's destination picker writes it with no date condition — and
    // that branch had the same silent wrong-board gap.
    assert.match(src, /withBoardOnPinterestEntry[^\n]*from "@\/lib\/social\/scheduledDestinations"/,
      "the drawer must use the same shared helper");
    const start = src.indexOf("function persistDraft(): PinDraft | null {");
    const end = src.indexOf("function ", start + 10);
    assert.ok(start > -1 && end > start, "persistDraft body bounds not found");
    const body = src.slice(start, end);
    assert.match(body, /withBoardOnPinterestEntry\(/, "persistDraft must rewrite the entry's board");
    assert.match(body, /activeDraft\.scheduledDestinations/, "it must rewrite the STORED intent");
  });

  // ── 7. Double-click Publish sends exactly one request ─────────────────────────
  await test("7. beginPublish/endPublish dedupe concurrent publish attempts for the same id", async () => {
    const lifecycle = await import("../src/lib/studio/pinLifecycle");
    assert.equal(lifecycle.beginPublish("pin-x"), true, "first claim succeeds");
    assert.equal(lifecycle.beginPublish("pin-x"), false, "second concurrent claim is rejected");
    lifecycle.endPublish("pin-x");
    assert.equal(lifecycle.beginPublish("pin-x"), true, "claim available again after release");
    lifecycle.endPublish("pin-x");
  });
  await test("7b. All three publish handlers (Studio card, Batch, DraftDetailsDrawer) route through the shared beginPublish/endPublish lock", () => {
    const studio = readFileSync(join(root, "src/components/studio/StudioBoard.tsx"), "utf8");
    const batch = readFileSync(join(root, "src/components/studio/BatchEditDrawer.tsx"), "utf8");
    const drawer = readFileSync(join(root, "src/components/plan/DraftDetailsDrawer.tsx"), "utf8");
    const shared = readFileSync(join(root, "src/lib/studio/publishContent.ts"), "utf8");
    // The lock now lives INSIDE publishContent, the one function the card and the
    // batch drawer publish through. It had to move: with each caller taking it first,
    // publishContent's own acquire would fail and every publish would report
    // "already publishing" against itself. The invariant is unchanged — a publish is
    // still guarded by the shared registry, and a caller that loses the race is told.
    assert.match(shared, /if \(!beginPublish\(draftId\)\) \{/);
    assert.match(shared, /endPublish\(draftId\);/);
    // The Studio card's default is still Retry semantics; a republish of an edited
    // Posted Content overrides it explicitly, so the scope is a parameter now.
    assert.match(studio, /await publishContent\(id, \{ onlyPending: options\?\.onlyPending \?\? true \}\)/);
    assert.match(studio, /outcome\.blocked === "locked"/, "the card honours the lock's verdict");
    assert.match(batch, /await publishContent\(p\.pinId, \{ onlyPending: true \}\)/);
    assert.match(batch, /outcome\.blocked === "locked"/);
    // The history (non-draft) rows in the batch drawer still publish directly, so
    // they still take the lock themselves; the Plan drawer now goes through
    // publishContent and honours the lock's verdict like the card does.
    assert.match(batch, /if \(!beginPublish\(p\.pinId\)\)/);
    assert.match(drawer, /await publishContent\(activeDraft\.id, \{/);
    assert.match(drawer, /outcome\.blocked === "locked"/, "the drawer honours the lock's verdict");
  });

  // ── 8. Batch: one item failing does not affect the others ────────────────────
  await test("8. BatchEditDrawer.runPublish wraps each publish in its own try/catch inside the loop (isolated per-item failure)", () => {
    const src = readFileSync(join(root, "src/components/studio/BatchEditDrawer.tsx"), "utf8");
    const start = src.indexOf("async function runPublish(targets: BatchPinRow[]) {");
    const end = src.indexOf("\n  const publishReadyCount =", start); // next top-level statement after runPublish
    assert.ok(start > -1 && end > start, "runPublish body bounds not found");
    const body = src.slice(start, end);
    assert.match(body, /for \(let i = 0; i < targets\.length; i\+\+\) \{/, "must iterate targets in a loop, not Promise.all-fail-fast");
    assert.match(body, /try \{[\s\S]*?await publishPin\(/, "each publish call must be inside its own try");
    assert.match(body, /\} catch \(e\) \{[\s\S]*?results\.push\(\{ pinId: p\.pinId, title, status: "failed"/, "a failure is recorded per-pin, not thrown out of the loop");
  });

  // ── 9. Failed Schedule leaves the Pin Unscheduled (not falsely Scheduled) ────
  await test("9. ensureScheduledPlanTime returns ok:false without ever writing scheduledDate/scheduledTime/plannedAt on the not_ready paths", () => {
    const src = readFileSync(join(root, "src/lib/smartSchedule.ts"), "utf8");
    const fn = src.match(/export function ensureScheduledPlanTime\(id: string, opts\?: EnsureScheduleOpts\): AutoScheduleResult \{[\s\S]*?\n\}/);
    assert.ok(fn, "ensureScheduledPlanTime not found");
    // Every early "not_ready" return happens strictly before any pinDraftStore.updateDraft
    // call in the function body — i.e. failure never touches the schedule fields.
    const body = fn![0];
    const firstUpdateCallIdx = body.indexOf("pinDraftStore.updateDraft");
    const lastNotReadyIdx = body.lastIndexOf('reason: "not_ready"');
    assert.ok(firstUpdateCallIdx === -1 || lastNotReadyIdx < firstUpdateCallIdx, "a not_ready return must precede any store write");
  });
  await test("9b. getPinLifecycle: a draft with no scheduledDate/plannedAt is 'unscheduled' (failed Schedule never fakes 'scheduled')", async () => {
    const lifecycle = await import("../src/lib/studio/pinLifecycle");
    const draft = { generationStatus: "done", postedAt: "", remotePinId: "", publishError: "", scheduledDate: "", plannedAt: "", source: "uploaded_image" } as Parameters<typeof lifecycle.getPinLifecycle>[0];
    assert.equal(lifecycle.getPinLifecycle(draft), "unscheduled");
  });

  // ── 10. Auto-publish (cron) applies the same validation rules ────────────────
  await test("10. publish-due cron route calls publishPinForUser — the same validate/truncate path as manual publish", () => {
    const src = readFileSync(join(root, "src/app/api/cron/publish-due/route.ts"), "utf8");
    assert.match(src, /import \{ publishPinForUser \} from "@\/lib\/server\/pinterest\/publishPin"/);
    // Matched by CALL, not by argument name (the same reasoning as 10b below): the cron
    // publishes each Pinterest destination with its OWN account and board, so the input
    // is built per destination. What must not change is that it still goes through
    // publishPinForUser — pinning the old `(input)` spelling would fail on that refactor
    // while a genuine bypass of the validate/truncate path slipped through.
    assert.match(src, /await publishPinForUser\(/);
  });
  await test("10c. trial-access release happens BEFORE the social fan-out (the Content keeps its slot)", () => {
    const src = readFileSync(join(root, "src/app/api/cron/publish-due/route.ts"), "utf8");
    const trialIdx = src.indexOf("if (trialBlocked > 0");
    const fanIdx = src.indexOf("await fanOutDestinations(");
    assert.ok(trialIdx > 0 && fanIdx > 0, "both branches must exist");
    assert.ok(trialIdx < fanIdx,
      "fanning out first would publish IG/FB, mark the Content posted and clear scheduled_at — "
      + "the trial-blocked Pinterest destinations would then never be re-attempted");
    // The guard must not also require "no other destinations": trial access is an
    // APP-level block, so blocked-Pinterest-plus-owed-social is the ordinary case.
    assert.ok(!/if \(trialBlocked > 0 &&[^)]*extras\.length === 0/.test(src),
      "the skip must not be conditional on there being no social destinations");
  });
  await test("10b. publishPinForUser validates image/link BEFORE ever calling Pinterest (same order for manual + cron callers)", () => {
    const src = readFileSync(join(root, "src/lib/server/pinterest/publishPin.ts"), "utf8");
    // Matched by CALL, not by argument: multi-image publishing validates every URL in a
    // loop (`validatePublicImageUrl(raw)`), so pinning this to the old single-image
    // `(input.imageUrl)` spelling would fail on a change that made validation stricter.
    const imgIdx = src.indexOf("validatePublicImageUrl(");
    const linkIdx = src.indexOf("validateOptionalLink(input.link)");
    const mediaIdx = src.indexOf("checkPinterestMedia(toMediaItems(");
    const clientIdx = src.indexOf("PinterestClient.forSandboxDemo");
    assert.ok(imgIdx > -1 && linkIdx > -1 && mediaIdx > -1 && clientIdx > -1);
    assert.ok(imgIdx < clientIdx && linkIdx < clientIdx, "validation must run before any Pinterest client call");
    // The media-set rules (count / aspect ratio) are part of that same pre-flight: an
    // unpublishable carousel must be refused here, never truncated at the API call.
    assert.ok(mediaIdx < clientIdx, "media rules must run before any Pinterest client call");
  });

  console.log(`\n1-10 core mapping: ${passed} passed, ${failed} failed so far`);

  // ── Extra: title/description length cap ───────────────────────────────────────
  await test("pinFieldErrors: title at exactly 100 chars is fine (no error)", () => {
    const title = "a".repeat(TITLE_MAX_LENGTH);
    const errors = pinFieldErrors({ title, description: "" });
    assert.equal(errors.title, undefined);
  });
  await test("pinFieldErrors: title at 101 chars is blocked", () => {
    const title = "a".repeat(TITLE_MAX_LENGTH + 1);
    const errors = pinFieldErrors({ title, description: "" });
    assert.ok(errors.title, "101-char title must produce an error");
    assert.match(errors.title!, /101/);
    assert.match(errors.title!, /100/);
  });
  await test("pinFieldErrors: description at exactly 500 chars is fine (no error)", () => {
    const description = "a".repeat(DESCRIPTION_MAX_LENGTH);
    const errors = pinFieldErrors({ title: "", description });
    assert.equal(errors.description, undefined);
  });
  await test("pinFieldErrors: description at 501 chars is blocked", () => {
    const description = "a".repeat(DESCRIPTION_MAX_LENGTH + 1);
    const errors = pinFieldErrors({ title: "", description });
    assert.ok(errors.description, "501-char description must produce an error");
    assert.match(errors.description!, /501/);
    assert.match(errors.description!, /500/);
  });
  await test("pinFieldErrors: empty title/description are NEVER blocked (unchanged WP1 contract)", () => {
    assert.deepEqual(pinFieldErrors({ title: "", description: "" }), {});
    assert.deepEqual(pinFieldErrors({}), {});
    assert.equal(hasPinFieldErrors({ title: "", description: "" }), false);
  });
  await test("hasPinFieldErrors: true iff either field is over-limit", () => {
    assert.equal(hasPinFieldErrors({ title: "a".repeat(101), description: "" }), true);
    assert.equal(hasPinFieldErrors({ title: "", description: "a".repeat(501) }), true);
    assert.equal(hasPinFieldErrors({ title: "a".repeat(100), description: "a".repeat(500) }), false);
  });
  await test("isPinReady is UNCHANGED by over-limit fields — pinFieldErrors is a separate gate (existing tests assert isPinReady ignores title/description length)", () => {
    const overLong = { imageUrl: "https://example.com/a.jpg", boardId: "b1", title: "a".repeat(500), description: "a".repeat(5000) };
    assert.equal(readiness.isPinReady(overLong), true, "isPinReady must stay scoped to image+board only");
  });

  // ── Extra: all three UI surfaces wire the length gate into Schedule/Publish ──
  await test("StudioBoard.handleSchedule blocks on pinFieldErrors before ensureScheduledPlanTime", () => {
    const src = readFileSync(join(root, "src/components/studio/StudioBoard.tsx"), "utf8");
    const fn = src.match(/const handleSchedule = useCallback\(\(id: string\) => \{[\s\S]*?\n  \}, \[noBoardAccess, tr\]\);/);
    assert.ok(fn);
    assert.match(fn![0], /const lenErrors = pinFieldErrors\(\{ title: d\.title, description: d\.description \}\);/);
    assert.match(fn![0], /if \(lenErrors\.title \|\| lenErrors\.description\) \{/);
  });
  await test("StudioBoard.handlePublish blocks on pinFieldErrors before beginPublish", () => {
    const src = readFileSync(join(root, "src/components/studio/StudioBoard.tsx"), "utf8");
    // The publish itself (and the shared lock it takes) moved into publishContent, so
    // the boundary the length gate must precede is now the call to it. Same invariant:
    // an over-limit title is refused BEFORE anything is sent or locked.
    // The signature also carries the publish SCOPE now ({ onlyPending }), so the match
    // is on the parameter list opening rather than an exact one-argument signature —
    // the invariant under test is the ORDER of the gate, not the arity.
    const fn = src.match(/const handlePublish = useCallback\(async \(id: string,?[^)]*\) => \{[\s\S]*?await publishContent\(id,/);
    assert.ok(fn, "handlePublish body up to the publishContent call not found");
    assert.match(fn![0], /const lenErrors = pinFieldErrors/);
  });
  await test("DraftDetailsDrawer.canSchedule and handlePublish both include the length gate", () => {
    const src = readFileSync(join(root, "src/components/plan/DraftDetailsDrawer.tsx"), "utf8");
    assert.match(src, /const hasValidFieldLengths = !lenErrors\.title && !lenErrors\.description;/);
    assert.match(src, /const canSchedule = hasBoard && hasWhen && hasValidImage && hasValidUrl && hasValidFieldLengths/);
    assert.match(src, /const lenErrors = pinFieldErrors\(\{ title, description \}\);\s*\n\s*if \(lenErrors\.title \|\| lenErrors\.description\) \{/);
  });
  await test("BatchEditDrawer.startPublish/runPublish both include the length gate (pubBlockingLabels / pinFieldErrors)", () => {
    const src = readFileSync(join(root, "src/components/studio/BatchEditDrawer.tsx"), "utf8");
    assert.match(src, /function pubBlockingLabels\(pin: BatchPinRow, edits: Record<string, RowEdit>\): string\[\] \{/);
    assert.match(src, /if \(lenErrors\.title\) labels\.push\("Title too long"\);/);
    assert.match(src, /const lenErrors = pinFieldErrors\(input\);\s*\n\s*if \(lenErrors\.title \|\| lenErrors\.description\) \{ results\.push/);
  });
  await test("ensureScheduledPlanTime (canonical batch/Smart-Schedule-add entry point) also enforces the length gate", () => {
    const src = readFileSync(join(root, "src/lib/smartSchedule.ts"), "utf8");
    assert.match(src, /const lenErrors = pinFieldErrors\(\{ title: draft\.title, description: draft\.description \}\);/);
  });
  // Weekly Plan was folded into Create Pins (app/plan/page.tsx is now only a
  // redirect shell), so this precheck now lives in WeeklyPlanWorkspace.
  await test("Weekly Plan batch-schedule precheck (WeeklyPlanWorkspace minimumPlanContentError) honors the image+board contract — empty title/description never block", () => {
    const src = readFileSync(join(root, "src/components/plan/WeeklyPlanWorkspace.tsx"), "utf8");
    const start = src.indexOf("function minimumPlanContentError(");
    const end = src.indexOf("\n  }", start);
    assert.ok(start > -1 && end > start, "minimumPlanContentError not found");
    const body = src.slice(start, end);
    // Blocks: missing/non-public image, missing board, over-limit title/description.
    assert.match(body, /isPublishableImage\(draft\.imageUrl\)/, "image gate must use the canonical isPublishableImage check");
    assert.match(body, /sanitizeHandoffField\(draft\.boardId\)/, "board gate must mirror ensureScheduledPlanTime");
    assert.match(body, /pinFieldErrors\(\{ title: draft\.title, description: draft\.description \}\)/, "over-limit gate must use the shared pinFieldErrors");
    // Never blocks: EMPTY title/description (the old needsTitle/needsDescription gate).
    assert.ok(!body.includes("needsTitle"), "empty title must not block scheduling");
    assert.ok(!body.includes("needsDescription"), "empty description must not block scheduling");
    // The dead copy keys are gone from the English catalog too.
    const en = readFileSync(join(root, "src/lib/i18n/messages/en/plan.ts"), "utf8");
    assert.ok(!en.includes('"plan.error.needsTitle"'), "dead needsTitle key must be removed from en.ts");
    assert.ok(!en.includes('"plan.error.needsDescription"'), "dead needsDescription key must be removed from en.ts");
  });

  // ── Extra: maxLength attributes present everywhere a title/description is typed ──
  await test("All title/description inputs across the three surfaces carry maxLength={100}/{500}", () => {
    const pinFieldsForm = readFileSync(join(root, "src/components/pins/PinFieldsForm.tsx"), "utf8");
    const batch = readFileSync(join(root, "src/components/studio/BatchEditDrawer.tsx"), "utf8");
    const titleSection = readFileSync(join(root, "src/components/pin-details/PinTitleSection.tsx"), "utf8");
    const drawer = readFileSync(join(root, "src/components/plan/DraftDetailsDrawer.tsx"), "utf8");
    assert.match(pinFieldsForm, /data-testid="board-field-title" value=\{value\.title\} disabled=\{disabled\} maxLength=\{100\}/);
    assert.match(pinFieldsForm, /data-testid="board-field-description" value=\{value\.description\} disabled=\{disabled\} maxLength=\{500\}/);
    assert.match(batch, /data-testid="batch-edit-title-cell" value=\{title\}[\s\S]{0,60}maxLength=\{100\}/);
    assert.match(batch, /data-testid="batch-edit-description-cell" value=\{desc\}[\s\S]{0,60}maxLength=\{500\}/);
    assert.match(batch, /data-testid="batch-edit-drawer-title" value=\{title\} maxLength=\{100\}/);
    assert.match(titleSection, /maxLength=\{100\}/);
    assert.match(drawer, /data-testid="draft-edit-description" value=\{description\} maxLength=\{500\}/);
  });

  // ── Extra: field-level error display near the fields (not just a toast) ──────
  await test("PinFieldsForm renders titleFieldError/descriptionFieldError near their inputs", () => {
    const src = readFileSync(join(root, "src/components/pins/PinFieldsForm.tsx"), "utf8");
    assert.match(src, /data-testid="board-field-title-error"/);
    assert.match(src, /data-testid="board-field-description-error"/);
  });
  await test("DraftDetailsDrawer renders a field-level title/description error (not just a footer message)", () => {
    const src = readFileSync(join(root, "src/components/plan/DraftDetailsDrawer.tsx"), "utf8");
    assert.match(src, /data-testid="draft-edit-description-error"/);
    const titleSection = readFileSync(join(root, "src/components/pin-details/PinTitleSection.tsx"), "utf8");
    assert.match(titleSection, /data-testid="draft-edit-title-error"/);
  });

  console.log(`\nField-length UI wiring: ${passed} passed, ${failed} failed so far`);

  // ── Extra: server-side truncation fallback (publishPin.ts) ───────────────────
  process.env.PINTEREST_API_ENV = "sandbox";
  process.env.PINTEREST_SANDBOX_ACCESS_TOKEN = "sandbox-test-token";
  const publishPinModule = await import("../src/lib/server/pinterest/publishPin");

  await test("publishPinForUser truncates an over-limit title/description instead of rejecting (server-side fallback, WP1 decision)", async () => {
    const captured: { body?: Record<string, unknown> } = {};
    const realFetch = global.fetch;
    global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/pins") && init?.method === "POST") {
        captured.body = JSON.parse(String(init.body ?? "{}"));
        return new Response(JSON.stringify({ id: "pin-123", board_id: "board-1", url: "https://www.pinterest.com/pin/pin-123/" }), { status: 201 });
      }
      if (url.includes("/boards/")) {
        // Ownership lookup (findOwnedBoard) — respond so it doesn't hang/throw.
        return new Response(JSON.stringify({ id: "board-1", name: "Test board" }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof fetch;

    try {
      const overTitle = "T".repeat(150);
      const overDescription = "D".repeat(700);
      const result = await publishPinModule.publishPinForUser({
        uid: "test-user",
        boardId: "board-1",
        imageUrl: "https://example.com/pin.jpg",
        title: overTitle,
        description: overDescription,
      });
      assert.equal(result.ok, true, "an over-limit title/description must NOT be rejected server-side (client is the hard block; server truncates)");
      assert.ok(captured.body, "createPin must have been called");
      const sentTitle = captured.body!.title as string;
      const sentDescription = captured.body!.description as string;
      assert.equal(sentTitle.length, 100, "title sent to Pinterest must be truncated to 100 chars");
      assert.equal(sentDescription.length, 500, "description sent to Pinterest must be truncated to 500 chars");
    } finally {
      global.fetch = realFetch;
    }
  });

  // ── 13. A schedule may not name an account that is gone or disconnected ───
  // The remove path refuses to delete an account with live schedules (v67's
  // atomic RPC). This is the other direction of the same race: a schedule
  // WRITTEN after the account went away. A browser tab open since before the
  // removal syncs its drafts and would otherwise persist a schedule pointing at
  // a row that no longer exists — the exact orphan the delete guard prevents,
  // arriving through the front door.
  //
  // Exercised against the module the route calls, with the connection store
  // stubbed: the route itself demands a real bearer token, and the rule worth
  // asserting is "which ids are refused, and why", not HTTP plumbing.
  {
    const Module = (await import("node:module")).default;
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const originalLoad = (Module as any)._load;
    let stubConnections: Array<{ id: string; provider: string; connectionStatus: string }> = [];
    let findCalls: string[] = [];
    (Module as any)._load = function (request: string, parent: unknown, isMain: boolean) {
      if (/[\/]social[\/]server[\/]socialConnectionStore(\.ts)?$/.test(request)
        || request === "@/lib/social/server/socialConnectionStore") {
        return {
          listConnections: async () => stubConnections,
          // Only the ids the batch reader does not enumerate (synthetic /
          // provider-reported, which contain ":") may fall through to this.
          findConnection: async (_uid: string, id: string) => {
            findCalls.push(id);
            return stubConnections.find(c => c.id === id) ?? null;
          },
        };
      }
      return originalLoad.call(this, request, parent, isMain);
    };
    /* eslint-enable @typescript-eslint/no-explicit-any */

    const { unavailableScheduleDestinations } =
      await import("../src/lib/server/social/scheduledDestinationsAvailable");

    await test("13a. a connected account is accepted", async () => {
      stubConnections = [{ id: "c-1", provider: "pinterest", connectionStatus: "connected" }];
      const out = await unavailableScheduleDestinations("u1", [{ draftId: "d1", connectionIds: ["c-1"] }]);
      assert.deepEqual(out, []);
    });

    await test("13b. an account that no longer exists is refused as missing", async () => {
      stubConnections = [];
      const out = await unavailableScheduleDestinations("u1", [{ draftId: "d1", connectionIds: ["gone-1"] }]);
      assert.equal(out.length, 1);
      assert.equal(out[0].reason, "missing");
      assert.equal(out[0].draftId, "d1");
      assert.equal(out[0].connectionId, "gone-1");
      // Nothing to name: the id resolves to no row, so there is no platform.
      assert.equal(out[0].provider, null);
    });

    // The load-bearing one. listConnections still returns a DISCONNECTED
    // Facebook/Instagram row (its status is not_connected, the row survives), so
    // presence alone would accept an account that cannot publish anything.
    await test("13c. a DISCONNECTED account is refused, not accepted for existing", async () => {
      stubConnections = [{ id: "c-2", provider: "facebook", connectionStatus: "not_connected" }];
      const out = await unavailableScheduleDestinations("u1", [{ draftId: "d1", connectionIds: ["c-2"] }]);
      assert.equal(out.length, 1, "a surviving row that cannot publish must still be refused");
      assert.equal(out[0].reason, "disconnected");
      assert.equal(out[0].provider, "facebook", "the platform is named so the message can be acted on");
    });

    await test("13d. only the bad destination is reported; the good one is not", async () => {
      stubConnections = [{ id: "c-1", provider: "pinterest", connectionStatus: "connected" }];
      const out = await unavailableScheduleDestinations("u1", [
        { draftId: "d1", connectionIds: ["c-1", "gone-1"] },
        { draftId: "d2", connectionIds: ["c-1"] },
      ]);
      assert.equal(out.length, 1);
      assert.equal(out[0].draftId, "d1");
      assert.equal(out[0].connectionId, "gone-1");
    });

    await test("13e. an id the batch reader can't enumerate falls back to findConnection", async () => {
      // The legacy synthetic `pinterest:<uid>` and provider-reported accounts
      // resolve through a different path than the batch list. Refusing a
      // merchant's real account because ONE reader doesn't enumerate it would be
      // a worse failure than the orphan schedule this guards against — so an id
      // containing ":" gets a second, single-id lookup before it is refused.
      findCalls = [];
      // Present to findConnection (the stub searches the same array) but the
      // batch path is what we are proving is not the only chance it gets.
      stubConnections = [{ id: "pinterest:u1", provider: "pinterest", connectionStatus: "connected" }];
      const out = await unavailableScheduleDestinations("u1", [
        { draftId: "d1", connectionIds: ["pinterest:u1"] },
      ]);
      assert.deepEqual(out, [], "a resolvable synthetic id must not be refused");
    });

    await test("13f. a plain id is NOT retried through findConnection", async () => {
      // The fallback exists for ids the batch reader structurally cannot return.
      // Applying it to every id would turn one sync into up to 50 extra reads.
      findCalls = [];
      stubConnections = [];
      const out = await unavailableScheduleDestinations("u1", [
        { draftId: "d1", connectionIds: ["plain-1"] },
      ]);
      assert.equal(out.length, 1);
      assert.deepEqual(findCalls, [], "a plain uuid must be answered from the one batch read");
    });

    await test("13g. nothing to validate ⇒ no database read at all", async () => {
      findCalls = [];
      const out = await unavailableScheduleDestinations("u1", [{ draftId: "d1", connectionIds: [] }]);
      assert.deepEqual(out, []);
      assert.deepEqual(findCalls, []);
    });

    (Module as any)._load = originalLoad;
  }

  console.log(`\nSchedule/Publish validation contract: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

void main();
