/**
 * Published-Pin state experience in "Edit scheduled Pin".
 *
 * Only pin status === published changes; Draft / Scheduled / Needs-details are untouched.
 *
 * The published view is now per-destination (PRD 0809 §6): one row per platform the Pin
 * actually reached, each naming its own account and offering its own view action. It
 * replaced a Pinterest-primary summary with a single "View on Pinterest", which was wrong
 * as soon as a Pin could also go to Instagram and a Facebook Page.
 *
 * Data still comes from EXISTING PinDraft fields — no new storage:
 *   - postedAt / remotePinId / remotePinUrl / boardName   (Pinterest)
 *   - targetAccountLabel   (the account that RECEIVED it — not the live connection)
 *   - socialPosts[]        (every other platform, with its own permalink and handle)
 */

import { readFileSync } from "node:fs";
import { publishResultRows, canViewExternally } from "../src/lib/studio/publishResults";
import { join } from "node:path";

const root = process.cwd();
const drawer = readFileSync(join(root, "src/components/plan/DraftDetailsDrawer.tsx"), "utf8");
const studioCard = readFileSync(join(root, "src/components/studio/PinBoardCard.tsx"), "utf8");
const pinDraftStore = readFileSync(join(root, "src/lib/pinDraftStore.ts"), "utf8");

let passed = 0, failed = 0;
function test(name: string, fn: () => void) {
  try { fn(); console.log(`  OK ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}`); console.error(`       ${(e as Error).message}`); failed++; }
}
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }

console.log("Published-Pin state experience");

test("remotePinId already exists on PinDraft (no duplicate storage introduced)", () => {
  assert(/remotePinId\??:\s*string/.test(pinDraftStore), "remotePinId field missing from PinDraft");
});

test("remotePinUrl exists on PinDraft alongside remotePinId", () => {
  assert(/remotePinUrl\??:\s*string/.test(pinDraftStore), "remotePinUrl field missing from PinDraft");
});

// This used to grep the DRAWER for a hand-written `postedAt: new Date()...` /
// `remotePinId: res.pin.id` block. That block is gone, and its absence is the fix,
// not a regression: the drawer no longer calls publishPin itself — it publishes
// through publishContent, the one publish function every surface shares, which
// writes those same fields from the per-destination result rows
// (legacyFieldsFromResults). Asserting on the drawer's own store write would be
// asserting that the duplication we just removed is still there. So the assertion
// moved to where the fields are actually written now.
test("the publish result still persists postedAt / remotePinId / remotePinUrl — now via the shared publish", () => {
  assert(/publishContent\(\s*activeDraft\.id/.test(drawer),
    "the drawer must publish through the shared publishContent, not its own publishPin call");
  assert(!/await publishPin\(/.test(drawer),
    "no second Pinterest publish path may remain in the drawer");

  const publishContentSrc = readFileSync(join(root, "src/lib/studio/publishContent.ts"), "utf8");
  const m = /pinDraftStore\.updateDraft\(draftId, \{\s*\n\s*destinationResults: results,/.exec(publishContentSrc);
  assert(m, "publishContent must write the result back to the draft");
  const body = publishContentSrc.slice(m!.index, m!.index + 500);
  assert(/postedAt: legacy\.postedAt/.test(body), "postedAt must still be set on publish");
  assert(/remotePinId: legacy\.remotePinId/.test(body), "remotePinId must be captured from the publish result");
  assert(/remotePinUrl: legacy\.remotePinUrl/.test(body), "remotePinUrl must be captured from the publish result");
  // The board is carried per destination on the result row, which is what the
  // published summary reads — fresher than a draft field written alongside it.
  assert(/boardName/.test(publishContentSrc), "the board must be recorded at publish time");
});

test("published Pin URL prefers remotePinUrl; reconstructs from remotePinId only as a legacy fallback (single source, kept in sync with Studio's board card)", () => {
  assert(drawer.includes("activeDraft.remotePinUrl || (activeDraft.remotePinId ? `https://www.pinterest.com/pin/${activeDraft.remotePinId}/` : \"\")"),
    "drawer must prefer remotePinUrl and fall back to reconstructing from remotePinId");
  assert(studioCard.includes("draft.remotePinUrl || (draft.remotePinId ? `https://www.pinterest.com/pin/${draft.remotePinId}/` : \"\")"),
    "sibling PinBoardCard convention changed unexpectedly — URL construction must stay in sync");
});

test("compact publish summary only renders when isPosted (draft/scheduled/needs-details untouched)", () => {
  const i = drawer.indexOf('data-testid="draft-planned-summary"');
  // Window sized to the whole three-branch ternary, not to how long it happened to be
  // when this test was written: the published branch now also renders the target
  // account badge (multi-account work), which pushed the scheduled/draft branches past
  // the old 2200-char slice and failed the assertion while the markup was correct.
  const block = drawer.slice(i, i + 3600);
  assert(/isPosted \? \(/.test(block), "isPosted branch missing from draft-planned-summary");
  assert(block.includes('data-testid="draft-published-summary"'), "compact published summary block missing");
  // The non-posted branches must still exist unmodified in the same ternary.
  assert(/isScheduled \? \(/.test(block), "scheduled branch must remain");
  assert(block.includes('data-testid="draft-not-scheduled"'), "not-scheduled (draft) branch must remain");
});

// The Posted detail moved from a Pinterest-primary summary (platform line + board row +
// account row + one primary "View on Pinterest") to the same per-destination rows the
// publish result uses (PRD 0809 §6). These assert the GUARANTEES those tests protected,
// against the shape that now provides them, rather than the markup that used to.
test("the Posted detail renders per-destination rows, not a Pinterest-primary summary", () => {
  const i = drawer.indexOf('data-testid="draft-published-summary"');
  assert(i >= 0, "published summary block missing");
  const block = drawer.slice(i, i + 1200);
  assert(block.includes("PublishResults"), "must render the shared per-destination view");
  assert(/formatEnglishDateTime\(activeDraft\.postedAt\)/.test(block), "published time must use the shared formatter");
});

test("each destination carries its own platform, account and board", () => {
  const rows = publishResultRows({
    postedAt: "2026-08-10T02:00:00Z", remotePinId: "9", remotePinUrl: "https://www.pinterest.com/pin/9/",
    boardName: "家居", targetAccountLabel: "harrietstudio",
    socialPosts: [{ provider: "facebook", postId: "f1", postUrl: "https://www.facebook.com/f1", accountName: "vibepin.co" }],
  });
  assert(rows.map(r => r.provider).join(",") === "pinterest,facebook", "one row per destination, Pinterest first");
  assert(rows[0].boardName === "家居", "board must ride the Pinterest row");
  assert(rows[0].accountName === "harrietstudio", "Pinterest account must be the stored target");
  assert(rows[1].accountName === "vibepin.co", "each platform names its own account");
  assert(!!rows[0].publishedAt, "published time must be carried");
});

test("the account is the one that RECEIVED the post, never the currently connected one", () => {
  // The old block read pinterestAccount?.username — whichever account happens to be
  // connected now, which is wrong the moment a merchant switches or adds accounts.
  const i = drawer.indexOf('data-testid="draft-published-summary"');
  const block = drawer.slice(i, i + 1200);
  assert(!/pinterestAccount\?\.username/.test(block), "must not read the live connection for a historical result");
  assert(/targetAccountLabel/.test(block), "must use the target stored on the draft");
});

test("account and board are omitted when unknown — never invented", () => {
  const rows = publishResultRows({ postedAt: "2026-08-10T02:00:00Z", remotePinId: "9" });
  assert(rows[0].accountName === null, "unknown account must stay empty, not a placeholder");
  assert(rows[0].boardName === null, "unknown board must stay empty, not a placeholder");
});

test("a view action requires a real permalink, and opens safely", () => {
  assert(canViewExternally({ status: "published", postUrl: "https://www.pinterest.com/pin/9/" }) === true, "a real permalink earns a view action");
  assert(canViewExternally({ status: "published", postUrl: "" }) === false, "no URL ⇒ no button, never a broken link");
  assert(canViewExternally({ status: "published", postUrl: "javascript:alert(1)" }) === false, "non-http scheme must never be linked");
  const results = readFileSync("src/components/social/PublishResults.tsx", "utf8");
  assert(results.includes('target="_blank"'), "must open in a new tab");
  assert(results.includes('rel="noopener noreferrer"'), "must set rel=noopener noreferrer");
});

test("no platform is the primary action any more", () => {
  const i = drawer.indexOf('data-testid="draft-published-summary"');
  const block = drawer.slice(i, i + 2000);
  assert(!block.includes("draft-view-on-pinterest"), "the single primary Pinterest action must be gone");
});

test("no broken-link / error state exists for a published Pin without a URL", () => {
  assert(!/No.*Pinterest.*URL|published.*link.*error|broken.*link/i.test(drawer.slice(drawer.indexOf('data-testid="draft-published-summary"'), drawer.indexOf('data-testid="draft-published-summary"') + 1200)),
    "must not render any broken-link/error copy in the published summary block");
});

// ── Read-only published view (published Pins must not look editable) ──────────

test("published header: 'Published Pin' title, no overflow menu (X remains the only control)", () => {
  assert(/isPosted \? t\("pinDetails\.publishedTitle"\)/.test(drawer), "header must switch to the Published Pin title when posted");
  const i = drawer.indexOf('data-testid="draft-overflow-btn"');
  const before = drawer.slice(Math.max(0, i - 400), i);
  assert(/\{!isPosted && \(/.test(before), "overflow menu (Pin now / Unschedule) must stay hidden for published Pins");
  assert(drawer.includes('data-testid="draft-details-close"'), "header X close must remain");
});

test("published: entire editable form is hidden (AI copy, inputs, boards, products, alt text)", () => {
  const gate = drawer.indexOf("{!isPosted && (<>");
  assert(gate >= 0, "editable form must be gated on !isPosted");
  const block = drawer.slice(gate, drawer.indexOf("</>)}", gate));
  for (const marker of ["PinAICopyPanel", 'data-testid="draft-edit-description"', 'data-testid="draft-edit-destination-url"', "PinProductLinksSection", "PinAltTextSection"]) {
    assert(block.includes(marker), `${marker} must live inside the !isPosted editable-form gate`);
  }
  // The board moved into the Publish destinations block (PRD 0809 §3 — a Board list only
  // means something inside the account it belongs to). What matters for THIS test is the
  // guarantee, not the location: it must still be hidden once the Pin is published. Its
  // new home is gated on `!isPosted && !result`, which is stricter than the gate above,
  // so assert that rather than a position the layout is allowed to change.
  const destGate = drawer.indexOf("{!isPosted && !result && (");
  assert(destGate >= 0, "publish destinations must stay gated on !isPosted && !result");
  const boardAt = drawer.indexOf("PinBoardSection", drawer.indexOf('data-testid="pinterest-destination-details"'));
  assert(boardAt > destGate, "PinBoardSection must sit inside the !isPosted && !result destinations block");
});

test("published: read-only content preview uses plain text, never inputs", () => {
  const i = drawer.indexOf('data-testid="draft-published-readonly"');
  assert(i >= 0, "read-only published preview missing");
  const block = drawer.slice(i, drawer.indexOf("{/* Editable form", i));
  assert(!/(<input|<textarea|<select)/.test(block), "read-only preview must not contain form controls");
});

test("published: footer (bottom Close / Publish now / Update schedule) is hidden", () => {
  const i = drawer.indexOf("State-based footer");
  const gate = drawer.slice(i, i + 400);
  assert(/\{!isPosted && \(/.test(gate), "footer must be gated on !isPosted");
  assert(!drawer.includes('data-testid="draft-publish-close"'), "bottom Close button must be gone (header X closes)");
});

test("publish destinations picker is hidden once published", () => {
  assert(drawer.includes("{!isPosted && !result && ("), "PublishDestinations must be gated on !isPosted");
});

console.log(`\nPublished-Pin summary: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
