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
  await test("3b. StudioBoard.handleSchedule blocks on missingBoard (noBoardAccess || !boardId)", () => {
    const src = readFileSync(join(root, "src/components/studio/StudioBoard.tsx"), "utf8");
    assert.match(src, /const missingBoard = noBoardAccess \|\| !d\.boardId\?\.trim\(\)/);
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
      /const handlePublish = useCallback\(async \(id: string\) => \{\s*\n\s*const d = pinDraftStore\.getDraft\(id\); if \(!d\) return;/,
      "handlePublish must read the store fresh, not a closed-over draft",
    );
  });
  await test("5/6b. PinBoardCard flushes pending debounced edits synchronously before onSchedule/onPublish", () => {
    const src = readFileSync(join(root, "src/components/studio/PinBoardCard.tsx"), "utf8");
    assert.match(src, /const doSchedule = useCallback\(\(\) => \{ flush\(\); props\.onSchedule\(draft\.id\); \}/);
    assert.match(src, /const doPublish = useCallback\(\(\) => \{ flush\(\); props\.onPublish\(draft\.id\); \}/);
    // flush() must be a SYNCHRONOUS persistNow call (not merely clearing the debounce
    // timer) so the store write has landed before onSchedule/onPublish re-reads it.
    assert.match(src, /const flush = useCallback\(\(\) => \{\s*\n?\s*if \(timer\.current\) \{ clearTimeout\(timer\.current\); timer\.current = null; persistNow\(pendingRef\.current\); \}/);
  });
  await test("5/6c. DraftDetailsDrawer.handlePublish persists current field state, then reads the SAME state for the payload (single source, no second read)", () => {
    const src = readFileSync(join(root, "src/components/plan/DraftDetailsDrawer.tsx"), "utf8");
    const start = src.indexOf("async function handlePublish() {");
    const end = src.indexOf("\n  const destMissing = !destinationUrl.trim();", start); // next top-level statement after handlePublish
    assert.ok(start > -1 && end > start, "handlePublish body bounds not found");
    const body = src.slice(start, end);
    assert.match(body, /persistDraft\(\);/, "handlePublish must persist current field state before publishing");
    // The publish payload is built from the same title/description/destinationUrl/boardId
    // local state persistDraft() just wrote — not re-derived from a separate stale source.
    assert.match(body, /title: title\.trim\(\) \|\| undefined/);
    assert.match(body, /description: description\.trim\(\) \|\| undefined/);
    // persistDraft() (the write) must happen textually before the publishPin() call (the
    // read) so the store and the outgoing payload never disagree.
    assert.ok(body.indexOf("persistDraft();") < body.indexOf("await publishPin("), "persist must precede the publish payload build");
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
    assert.match(studio, /if \(!beginPublish\(id\)\) return;/);
    assert.match(batch, /if \(!beginPublish\(p\.pinId\)\)/);
    assert.match(drawer, /if \(!beginPublish\(activeDraft\.id\)\) return;/);
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
    assert.match(src, /await publishPinForUser\(input\)/);
  });
  await test("10b. publishPinForUser validates image/link BEFORE ever calling Pinterest (same order for manual + cron callers)", () => {
    const src = readFileSync(join(root, "src/lib/server/pinterest/publishPin.ts"), "utf8");
    const imgIdx = src.indexOf("validatePublicImageUrl(input.imageUrl)");
    const linkIdx = src.indexOf("validateOptionalLink(input.link)");
    const clientIdx = src.indexOf("PinterestClient.forSandboxDemo");
    assert.ok(imgIdx > -1 && linkIdx > -1 && clientIdx > -1);
    assert.ok(imgIdx < clientIdx && linkIdx < clientIdx, "validation must run before any Pinterest client call");
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
    const fn = src.match(/const handlePublish = useCallback\(async \(id: string\) => \{[\s\S]*?if \(!beginPublish\(id\)\) return;/);
    assert.ok(fn, "handlePublish body up to beginPublish not found");
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

  console.log(`\nSchedule/Publish validation contract: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

void main();
