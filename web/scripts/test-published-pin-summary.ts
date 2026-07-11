/**
 * Published-Pin state experience in "Edit scheduled Pin".
 *
 * Only pin status === published changes. The simple "Published" label is replaced
 * with a compact publish summary (platform, published time, board, account when
 * available) plus a "View on Pinterest" link — shown ONLY when a real published
 * Pin URL exists. Draft / Scheduled / Needs-details states are untouched.
 *
 * Data comes from EXISTING PinDraft fields — no new storage:
 *   - postedAt      (existing; already gated isPosted)
 *   - remotePinId   (existing field, already used by Studio's PinBoardCard.tsx to
 *                    build the same "https://www.pinterest.com/pin/<id>/" URL) —
 *                    this drawer's own publish handler just wasn't writing it yet.
 *   - boardName     (existing field, already persisted by the board-selection autosave)
 *   - pinterestAccount.username (existing component state from fetchPinterestStatus)
 */

import { readFileSync } from "node:fs";
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

test("publish handler now persists remotePinId (the actual data gap) alongside postedAt", () => {
  const i = drawer.indexOf("pinDraftStore.updateDraft(activeDraft.id, {");
  assert(i >= 0, "publish handler must call updateDraft with the publish result");
  const body = drawer.slice(i, i + 300);
  assert(/postedAt: new Date\(\)\.toISOString\(\)/.test(body), "postedAt must still be set on publish");
  assert(/remotePinId: res\.pin\.id/.test(body), "remotePinId must be captured from the publish result");
  assert(/remotePinUrl: res\.pin\.url/.test(body), "remotePinUrl must be captured from the publish result");
  assert(/boardName/.test(body), "boardName must be captured fresh at publish time");
});

test("published Pin URL prefers remotePinUrl; reconstructs from remotePinId only as a legacy fallback (single source, kept in sync with Studio's board card)", () => {
  assert(drawer.includes("activeDraft.remotePinUrl || (activeDraft.remotePinId ? `https://www.pinterest.com/pin/${activeDraft.remotePinId}/` : \"\")"),
    "drawer must prefer remotePinUrl and fall back to reconstructing from remotePinId");
  assert(studioCard.includes("draft.remotePinUrl || (draft.remotePinId ? `https://www.pinterest.com/pin/${draft.remotePinId}/` : \"\")"),
    "sibling PinBoardCard convention changed unexpectedly — URL construction must stay in sync");
});

test("compact publish summary only renders when isPosted (draft/scheduled/needs-details untouched)", () => {
  const i = drawer.indexOf('data-testid="draft-planned-summary"');
  const block = drawer.slice(i, i + 2200);
  assert(/isPosted \? \(/.test(block), "isPosted branch missing from draft-planned-summary");
  assert(block.includes('data-testid="draft-published-summary"'), "compact published summary block missing");
  // The non-posted branches must still exist unmodified in the same ternary.
  assert(/isScheduled \? \(/.test(block), "scheduled branch must remain");
  assert(block.includes('data-testid="draft-not-scheduled"'), "not-scheduled (draft) branch must remain");
});

test("summary shows platform, published time (existing date/time util), and board", () => {
  const i = drawer.indexOf('data-testid="draft-published-summary"');
  const block = drawer.slice(i, i + 900);
  assert(/platformName\(\"pinterest\"\)/.test(block), "platform name missing");
  assert(/formatEnglishDateTime\(activeDraft\.postedAt\)/.test(block), "published time must use the existing shared date/time formatter");
  assert(block.includes('data-testid="draft-published-board"'), "board row missing");
  assert(/activeDraft\.boardName\?\.trim\(\)/.test(block), "board row must be conditional on a real board name");
});

test("account row is conditional — never invented when no live Pinterest account is known", () => {
  const i = drawer.indexOf('data-testid="draft-published-summary"');
  const block = drawer.slice(i, i + 1200);
  assert(/pinterestAccount\?\.username &&/.test(block), "account row must be gated on pinterestAccount.username");
  assert(block.includes('data-testid="draft-published-account"'), "account row testid missing");
});

test("'View on Pinterest' only renders with a real URL — no button, no broken link otherwise", () => {
  const i = drawer.indexOf('data-testid="draft-view-on-pinterest"');
  assert(i >= 0, "View on Pinterest control missing");
  const before = drawer.slice(Math.max(0, i - 250), i);
  assert(/isPosted && publishedPinUrl &&/.test(before), "View on Pinterest must be gated on isPosted && publishedPinUrl");
});

test("'View on Pinterest' opens safely in a new tab (target=_blank, rel=noopener noreferrer)", () => {
  const i = drawer.indexOf('data-testid="draft-view-on-pinterest"');
  const tag = drawer.slice(i, i + 260);
  assert(tag.includes('target="_blank"'), "must open in a new tab");
  assert(tag.includes('rel="noopener noreferrer"'), "must set rel=noopener noreferrer");
  assert(tag.includes("href={publishedPinUrl}"), "href must be the derived published Pin URL");
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

test("published: View on Pinterest is the single primary action; muted fallback when URL missing", () => {
  const i = drawer.indexOf('data-testid="draft-view-on-pinterest"');
  const tag = drawer.slice(i, i + 300);
  assert(tag.includes("...primaryBtn"), "View on Pinterest must be primary-styled in the published view");
  const j = drawer.indexOf('data-testid="draft-pin-url-unavailable"');
  assert(j >= 0, "muted URL-unavailable text missing");
  const before = drawer.slice(Math.max(0, j - 200), j);
  assert(/isPosted && !publishedPinUrl &&/.test(before), "URL-unavailable text must only render for a published Pin with no URL");
});

test("published: entire editable form is hidden (AI copy, inputs, boards, products, alt text)", () => {
  const gate = drawer.indexOf("{!isPosted && (<>");
  assert(gate >= 0, "editable form must be gated on !isPosted");
  const block = drawer.slice(gate, drawer.indexOf("</>)}", gate));
  for (const marker of ["PinAICopyPanel", 'data-testid="draft-edit-description"', 'data-testid="draft-edit-destination-url"', "PinBoardSection", "PinProductLinksSection", "PinAltTextSection"]) {
    assert(block.includes(marker), `${marker} must live inside the !isPosted editable-form gate`);
  }
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
