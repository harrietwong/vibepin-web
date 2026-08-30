/**
 * test-publish-content.ts — the ONE client publish function.
 *
 * What this pins down is convergence: before publishContent, four surfaces published
 * four different ways, and one of them wrote a Pinterest "published" row for a
 * destination nothing had checked. These assert the properties that make one shared
 * path safe to route every surface through:
 *
 *   - one durable row per destination, and the legacy fields derived from those rows
 *   - a partial failure keeps what published AND records why the rest did not
 *   - `onlyPending` never re-sends a destination that already published (no double-post)
 *   - a destination its platform's media rule refuses does not block the others
 *   - a carousel reaches every platform with ALL media, in order
 *   - a destination with no account is never sent (the wrong-account defect)
 *
 * The network is injected (`options.deps`), not monkey-patched: publishContent takes
 * publishPin/publishToSocial as dependencies precisely so this can run with no fetch,
 * no DOM beyond a localStorage stand-in, and no Pinterest credentials.
 *
 * Run: npx tsx scripts/test-publish-content.ts (from web/)
 */

import assert from "node:assert";

// ── localStorage stand-in, installed BEFORE pinDraftStore is imported ────────────
class FakeStorage {
  private map = new Map<string, string>();
  getItem(k: string): string | null { return this.map.has(k) ? this.map.get(k)! : null; }
  setItem(k: string, v: string): void { this.map.set(k, v); }
  removeItem(k: string): void { this.map.delete(k); }
  clear(): void { this.map.clear(); }
  key(i: number): string | null { return Array.from(this.map.keys())[i] ?? null; }
  get length(): number { return this.map.size; }
}
const storage = new FakeStorage();
(globalThis as { localStorage?: unknown }).localStorage = storage;
(globalThis as { window?: unknown }).window = {
  localStorage: storage,
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() { return true; },
};

// The stubs above must be in place BEFORE pinDraftStore initializes, so these are
// required here rather than statically imported (static imports hoist above them).
/* eslint-disable @typescript-eslint/no-require-imports */
const { publishContent } = require("../src/lib/studio/publishContent") as typeof import("../src/lib/studio/publishContent");
const pinDraftStore = require("../src/lib/pinDraftStore") as typeof import("../src/lib/pinDraftStore");
const { contentDestinationResults } = require("../src/lib/contentDraftModel") as typeof import("../src/lib/contentDraftModel");
/* eslint-enable @typescript-eslint/no-require-imports */
import type { PinDraft } from "../src/lib/pinDraftStore";
import type { PublishContentDeps } from "../src/lib/studio/publishContent";
import { SocialApiError } from "../src/lib/social/socialClient";

let pass = 0;
let fail = 0;
function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => { pass++; console.log(`  OK   ${name}`); })
    .catch((e: Error) => { fail++; console.log(`  FAIL ${name}\n       ${e.message}`); });
}

const PIN_CONN = "conn-pinterest";
const IG_CONN = "conn-instagram";
const NOW = "2026-08-27T10:00:00.000Z";

/** A draft with N media and the given destinations, written straight into the store. */
function seedDraft(opts: {
  id: string;
  mediaCount?: number;
  destinations?: Array<{ provider: string; socialConnectionId: string; boardId?: string; boardName?: string }>;
  destinationResults?: PinDraft["destinationResults"];
}): PinDraft {
  storage.clear();
  const mediaCount = opts.mediaCount ?? 1;
  const created = pinDraftStore.createBoardDraft({
    imageUrl: "https://cdn.test/img-0.jpg",
    source: "uploaded_image",
    title: "A title",
    description: "A description",
  });
  const media = Array.from({ length: mediaCount }, (_, i) => ({
    id: `${created.id}:media:${i}`,
    kind: "image" as const,
    url: `https://cdn.test/img-${i}.jpg`,
    // Same 2:3 ratio throughout, so Pinterest's shared-ratio rule is satisfied and a
    // "too many images" refusal is unambiguously about the COUNT.
    width: 1000,
    height: 1500,
  }));
  // imageUrl is immutable on a draft (createBoardDraft already set it to img-0), so the
  // cover is expressed through media[0] — which is what contentMedia() reads anyway.
  return pinDraftStore.updateDraft(created.id, {
    media,
    coverMediaId: media[0].id,
    boardId: "board-1",
    boardName: "Home decor",
    targetConnectionId: PIN_CONN,
    scheduledDestinations: (opts.destinations ?? [{ provider: "pinterest", socialConnectionId: PIN_CONN }])
      .map(d => ({ ...d, capturedAt: NOW })),
    destinationResults: opts.destinationResults,
  })!;
}

type PinCall = Parameters<PublishContentDeps["publishPin"]>[0];
type SocialCall = Parameters<PublishContentDeps["publishToSocial"]>[0];

/** Recording stubs. `pinFails` / `socialStatus` shape the outcome. */
function makeDeps(opts: {
  pinFails?: { code?: string; message: string };
  socialStatus?: "published" | "failed";
  /** publishToSocial REJECTS (a whole-request refusal, e.g. a 402 before any
   *  destination was attempted) instead of resolving with a per-destination body. */
  socialThrows?: Error;
} = {}) {
  const pinCalls: PinCall[] = [];
  const socialCalls: SocialCall[] = [];
  const deps: Partial<PublishContentDeps> = {
    now: () => NOW,
    publishPin: (async (input: PinCall) => {
      pinCalls.push(input);
      if (opts.pinFails) throw Object.assign(new Error(opts.pinFails.message), { code: opts.pinFails.code });
      return {
        pin: { id: "pin-1", url: "https://www.pinterest.com/pin/pin-1/" },
        board: { id: "board-1", name: "Home decor" },
        connectionId: PIN_CONN,
      };
    }) as unknown as PublishContentDeps["publishPin"],
    publishToSocial: (async (input: SocialCall) => {
      socialCalls.push(input);
      if (opts.socialThrows) throw opts.socialThrows;
      const status = opts.socialStatus ?? "published";
      return {
        ok: status === "published",
        jobId: "job-1",
        status,
        destinations: input.destinations.map(d => ({
          provider: d.provider,
          status,
          externalPostId: status === "published" ? "ig-1" : null,
          externalPostUrl: status === "published" ? "https://instagram.com/p/ig-1" : null,
          accountName: "@shop",
          error: status === "published" ? null : "Instagram rejected the post.",
        })),
      };
    }) as unknown as PublishContentDeps["publishToSocial"],
  };
  return { deps, pinCalls, socialCalls };
}

async function main(): Promise<void> {
  console.log("\n=== every destination gets its own durable record ===");

  await test("a two-destination success writes one result per destination + the legacy fields", async () => {
  const draft = seedDraft({
    id: "a",
    destinations: [
      { provider: "pinterest", socialConnectionId: PIN_CONN },
      { provider: "instagram", socialConnectionId: IG_CONN },
    ],
  });
  const { deps } = makeDeps();
  const out = await publishContent(draft.id, { deps });

  assert.equal(out.blocked, undefined, "nothing should have blocked");
  assert.equal(out.published.length, 2, `expected 2 published, got ${out.published.length}`);
  assert.equal(out.failed.length, 0);

  const stored = pinDraftStore.getDraft(draft.id)!;
  const results = stored.destinationResults!;
  assert.equal(results.length, 2, "one row per destination");
  const pinterest = results.find(r => r.provider === "pinterest")!;
  const instagram = results.find(r => r.provider === "instagram")!;
  assert.equal(pinterest.destinationId, `pinterest:${PIN_CONN}`);
  assert.equal(instagram.destinationId, `instagram:${IG_CONN}`);
  assert.equal(pinterest.socialConnectionId, PIN_CONN, "the row names the account that received it");
  assert.equal(instagram.socialConnectionId, IG_CONN);
  assert.equal(pinterest.submittedAt, NOW, "submitted time is recorded");
  assert.equal(pinterest.publishedAt, NOW, "success time is recorded");
  assert.equal(pinterest.remoteId, "pin-1");
  assert.equal(instagram.postUrl, "https://instagram.com/p/ig-1");

  // Legacy fields are DERIVED, so Plan/admin cannot disagree with the rows above.
  assert.equal(stored.remotePinId, "pin-1", "legacy remotePinId derived from the Pinterest row");
  assert.equal(stored.postedAt, NOW, "legacy postedAt derived");
  assert.equal(stored.socialPosts?.length, 1, "legacy socialPosts derived for the non-Pinterest row");
  assert.equal(stored.socialPosts?.[0].postId, "ig-1");
  assert.equal(stored.publishError, undefined, "a clean publish clears the error field");
});

  await test("a partial failure keeps what published and records why the rest did not", async () => {
  const draft = seedDraft({
    id: "b",
    destinations: [
      { provider: "pinterest", socialConnectionId: PIN_CONN },
      { provider: "instagram", socialConnectionId: IG_CONN },
    ],
  });
  const { deps } = makeDeps({ socialStatus: "failed" });
  const out = await publishContent(draft.id, { deps });

  assert.equal(out.published.length, 1, "Pinterest still published");
  assert.equal(out.failed.length, 1, "Instagram is recorded failed, not dropped");

  const stored = pinDraftStore.getDraft(draft.id)!;
  const instagram = stored.destinationResults!.find(r => r.provider === "instagram")!;
  assert.equal(instagram.status, "failed");
  assert.equal(instagram.errorMessage, "Instagram rejected the post.", "the user-facing reason is kept");
  assert.equal(instagram.publishedAt, undefined, "a failed row never carries a success time");

  // A partial success is still posted: the schedule must NOT be released, or the Pin
  // would re-publish to Pinterest on the next due run.
  assert.equal(stored.postedAt, NOW, "Posted survives a partial failure");
  assert.equal(stored.publishError, "Instagram rejected the post.");
});

  console.log("\n=== retry re-sends only what has not published (PRD 29) ===");

  await test("onlyPending skips a destination that already published", async () => {
  const draft = seedDraft({
    id: "c",
    destinations: [
      { provider: "pinterest", socialConnectionId: PIN_CONN },
      { provider: "instagram", socialConnectionId: IG_CONN },
    ],
    destinationResults: [{
      destinationId: `pinterest:${PIN_CONN}`,
      provider: "pinterest",
      socialConnectionId: PIN_CONN,
      status: "published",
      remoteId: "pin-earlier",
      publishedAt: "2026-08-26T09:00:00.000Z",
    }],
  });
  const { deps, pinCalls, socialCalls } = makeDeps();
  const out = await publishContent(draft.id, { onlyPending: true, deps });

  assert.equal(pinCalls.length, 0, "the already-published Pinterest destination is NOT re-sent");
  assert.equal(socialCalls.length, 1, "only the pending Instagram destination is dispatched");
  assert.equal(out.published.length, 2, "the retained success still counts as published");

  const stored = pinDraftStore.getDraft(draft.id)!;
  const pinterest = stored.destinationResults!.find(r => r.provider === "pinterest")!;
  assert.equal(pinterest.remoteId, "pin-earlier", "the earlier success is preserved, not overwritten");
});

  await test("without onlyPending every destination is attempted again", async () => {
  const draft = seedDraft({
    id: "d",
    destinationResults: [{
      destinationId: `pinterest:${PIN_CONN}`, provider: "pinterest", socialConnectionId: PIN_CONN,
      status: "published", remoteId: "pin-earlier",
    }],
  });
  const { deps, pinCalls } = makeDeps();
  await publishContent(draft.id, { deps });
  assert.equal(pinCalls.length, 1, "an explicit publish re-sends");
});

  console.log("\n=== a platform's media rule refuses that platform only (PRD 29) ===");

  await test("6 images: Pinterest is refused with the rule's message, Instagram still publishes", async () => {
  const draft = seedDraft({
    id: "e",
    mediaCount: 6, // Pinterest max is 5; Instagram allows up to 10.
    destinations: [
      { provider: "pinterest", socialConnectionId: PIN_CONN },
      { provider: "instagram", socialConnectionId: IG_CONN },
    ],
  });
  const { deps, pinCalls, socialCalls } = makeDeps();
  const out = await publishContent(draft.id, { deps });

  assert.equal(pinCalls.length, 0, "Pinterest is never called with a set its rule refuses");
  assert.equal(socialCalls.length, 1, "Instagram is unaffected by Pinterest's rule");

  const stored = pinDraftStore.getDraft(draft.id)!;
  const pinterest = stored.destinationResults!.find(r => r.provider === "pinterest")!;
  assert.equal(pinterest.status, "failed");
  assert.equal(pinterest.errorCode, "too_many");
  assert.ok(/up to 5 images/.test(pinterest.errorMessage ?? ""), `expected the rule's own message, got: ${pinterest.errorMessage}`);
  assert.equal(out.published.length, 1, "Instagram published");
  assert.equal(out.failed.length, 1);
});

  await test("a carousel sends ALL media urls, in order, to both platforms", async () => {
  const draft = seedDraft({
    id: "f",
    mediaCount: 3,
    destinations: [
      { provider: "pinterest", socialConnectionId: PIN_CONN },
      { provider: "instagram", socialConnectionId: IG_CONN },
    ],
  });
  const { deps, pinCalls, socialCalls } = makeDeps();
  await publishContent(draft.id, { deps });

  const expected = ["https://cdn.test/img-0.jpg", "https://cdn.test/img-1.jpg", "https://cdn.test/img-2.jpg"];
  assert.deepEqual(pinCalls[0].imageUrls, expected, "Pinterest gets the whole carousel in display order");
  assert.equal(pinCalls[0].imageUrl, expected[0], "the single-image contract still names the cover");
  assert.deepEqual(socialCalls[0].post.imageUrls, expected, "the social fan-out gets the same set, same order");
});

  console.log("\n=== fail closed: never publish to an account nobody chose ===");

  await test("a Content with no resolvable destination publishes nothing", async () => {
  storage.clear();
  const created = pinDraftStore.createBoardDraft({ imageUrl: "https://cdn.test/x.jpg", source: "uploaded_image" });
  // No board, no target, no intent — contentDestinations() must find nothing rather
  // than defaulting to Pinterest.
  const { deps, pinCalls, socialCalls } = makeDeps();
  const out = await publishContent(created.id, { deps });

  assert.equal(out.blocked, "no_destinations");
  assert.equal(pinCalls.length, 0, "no Pinterest call");
  assert.equal(socialCalls.length, 0, "no social call");
});

  await test("an ambiguous account is never stored, so nothing is published for it", async () => {
  // The card refuses to WRITE a destination without a socialConnectionId (that is
  // resolveScheduledAccount's job). This asserts the other half of the contract: a
  // half-record that reached storage anyway is not dispatched.
  const draft = seedDraft({
    id: "g",
    destinations: [{ provider: "pinterest", socialConnectionId: PIN_CONN }],
  });
  pinDraftStore.updateDraft(draft.id, {
    scheduledDestinations: [
      { provider: "pinterest", socialConnectionId: PIN_CONN, capturedAt: NOW },
      // No account: exactly what an unresolved ambiguity would look like.
      { provider: "instagram", socialConnectionId: "", capturedAt: NOW },
    ],
  });
  const { deps, socialCalls } = makeDeps();
  const out = await publishContent(draft.id, { deps });

  assert.equal(socialCalls.length, 0, "an account-less destination is never sent");
  assert.ok(!out.published.some(r => r.provider === "instagram"), "and is never reported published");
});

  await test("a draft that does not exist blocks rather than throwing", async () => {
  const out = await publishContent("no-such-draft", { deps: makeDeps().deps });
  assert.equal(out.blocked, "not_found");
});

  console.log("\n=== retry semantics: a Retry with nothing pending sends nothing ===");

  // The bug this pins: `targets = pending.length ? pending : destinations` turned a
  // Retry on a fully published Content into a republish of EVERY destination — a
  // duplicate post from the one option whose entire purpose is preventing them.
  await test("onlyPending with every destination already published calls no platform and changes no row", async () => {
  const draft = seedDraft({
    id: "retry-none",
    destinations: [
      { provider: "pinterest", socialConnectionId: PIN_CONN },
      { provider: "instagram", socialConnectionId: IG_CONN },
    ],
    destinationResults: [
      { destinationId: `pinterest:${PIN_CONN}`, provider: "pinterest", socialConnectionId: PIN_CONN, status: "published", submittedAt: NOW, publishedAt: NOW, remoteId: "pin-old", postUrl: "https://www.pinterest.com/pin/pin-old/" },
      { destinationId: `instagram:${IG_CONN}`, provider: "instagram", socialConnectionId: IG_CONN, status: "published", submittedAt: NOW, publishedAt: NOW, remoteId: "ig-old", postUrl: "https://instagram.com/p/ig-old" },
    ],
  });
  const before = JSON.stringify(pinDraftStore.getDraft(draft.id)!.destinationResults);
  const { deps, pinCalls, socialCalls } = makeDeps();
  const out = await publishContent(draft.id, { onlyPending: true, deps });

  assert.equal(out.nothingToRetry, true, "the outcome says so explicitly");
  assert.equal(out.blocked, undefined, "nothingToRetry is NOT a blocked reason — callers toast blocked as an error");
  assert.equal(pinCalls.length, 0, "Pinterest must not be called again");
  assert.equal(socialCalls.length, 0, "the social dispatcher must not be called again");
  assert.equal(out.published.length, 0, "nothing was published by THIS attempt");
  assert.equal(out.failed.length, 0);
  assert.equal(out.results.length, 2, "the prior rows are still reported");
  assert.equal(
    JSON.stringify(pinDraftStore.getDraft(draft.id)!.destinationResults), before,
    "no stored row may change — not even a submittedAt bump",
  );
});

  await test("onlyPending:false on the same fully published Content re-sends every destination", async () => {
  const draft = seedDraft({
    id: "republish",
    destinations: [
      { provider: "pinterest", socialConnectionId: PIN_CONN },
      { provider: "instagram", socialConnectionId: IG_CONN },
    ],
    destinationResults: [
      { destinationId: `pinterest:${PIN_CONN}`, provider: "pinterest", socialConnectionId: PIN_CONN, status: "published", submittedAt: NOW, publishedAt: NOW, remoteId: "pin-old", postUrl: "https://www.pinterest.com/pin/pin-old/" },
      { destinationId: `instagram:${IG_CONN}`, provider: "instagram", socialConnectionId: IG_CONN, status: "published", submittedAt: NOW, publishedAt: NOW, remoteId: "ig-old", postUrl: "https://instagram.com/p/ig-old" },
    ],
  });
  const { deps, pinCalls, socialCalls } = makeDeps();
  const out = await publishContent(draft.id, { onlyPending: false, deps });

  assert.equal(out.nothingToRetry, undefined, "an explicit republish is never 'nothing to retry'");
  assert.equal(pinCalls.length, 1, "Pinterest gets the new content");
  assert.equal(socialCalls.length, 1, "the social dispatcher gets the new content");
  assert.equal(out.published.length, 2, "both destinations published again");
  // The superseded rows describe posts still live on the platform, so they are kept.
  const stored = pinDraftStore.getDraft(draft.id)!;
  assert.equal(stored.previousResults?.length, 2, "the replaced published rows are kept as history");
});

  await test("onlyPending with ONE destination pending sends only that one", async () => {
  const draft = seedDraft({
    id: "retry-partial",
    destinations: [
      { provider: "pinterest", socialConnectionId: PIN_CONN },
      { provider: "instagram", socialConnectionId: IG_CONN },
    ],
    destinationResults: [
      { destinationId: `pinterest:${PIN_CONN}`, provider: "pinterest", socialConnectionId: PIN_CONN, status: "published", submittedAt: NOW, publishedAt: NOW, remoteId: "pin-old", postUrl: "https://www.pinterest.com/pin/pin-old/" },
      { destinationId: `instagram:${IG_CONN}`, provider: "instagram", socialConnectionId: IG_CONN, status: "failed", submittedAt: NOW, errorMessage: "Instagram rejected the post." },
    ],
  });
  const { deps, pinCalls, socialCalls } = makeDeps();
  const out = await publishContent(draft.id, { onlyPending: true, deps });

  assert.equal(out.nothingToRetry, undefined, "there WAS something to retry");
  assert.equal(pinCalls.length, 0, "the published destination is not re-sent");
  assert.equal(socialCalls.length, 1, "only the failed destination is retried");
});

  console.log("\n=== the reader sees stored rows, and legacy drafts still read ===");

  await test("a legacy draft with only the old fields still yields per-destination results", () => {
  const results = contentDestinationResults({
    id: "legacy-1",
    imageUrl: "https://cdn.test/l.jpg",
    boardId: "board-9",
    boardName: "Legacy board",
    postedAt: "2026-08-01T00:00:00.000Z",
    remotePinId: "pin-legacy",
    targetAccountLabel: "@legacy",
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].status, "published");
  assert.equal(results[0].accountLabel, "@legacy", "the account that received it is not lost");
  assert.equal(results[0].postUrl, "https://www.pinterest.com/pin/pin-legacy/", "permalink reconstructed from the id");
});


  console.log("\n=== several accounts on one platform (WS-B3) ===");

  await test("two Pinterest accounts each get their own publishPin call, with their own board", async () => {
  const draft = seedDraft({
    id: "multi-pin",
    destinations: [
      { provider: "pinterest", socialConnectionId: PIN_CONN, boardId: "board-1", boardName: "Home decor" },
      { provider: "pinterest", socialConnectionId: "conn-pin-2", boardId: "board-2", boardName: "Kitchen" },
    ],
  });
  const { deps, pinCalls } = makeDeps();
  const out = await publishContent(draft.id, { deps });

  assert.equal(pinCalls.length, 2, "one publish per account, not one for the platform");
  assert.deepEqual(pinCalls.map(c => c.connectionId), [PIN_CONN, "conn-pin-2"]);
  assert.deepEqual(pinCalls.map(c => c.boardId), ["board-1", "board-2"],
    "each account publishes to ITS board - a shared board id belongs to the other account");
  assert.equal(out.published.filter(r => r.provider === "pinterest").length, 2);
  const ids = out.results.map(r => r.destinationId);
  assert.ok(ids.includes("pinterest:" + PIN_CONN) && ids.includes("pinterest:conn-pin-2"),
    "two accounts stay distinguishable in the durable rows: " + JSON.stringify(ids));
});

  await test("a second Pinterest account with no board of its own is refused, not sent to the first account's board", async () => {
  const draft = seedDraft({
    id: "multi-pin-noboard",
    destinations: [
      { provider: "pinterest", socialConnectionId: PIN_CONN, boardId: "board-1" },
      { provider: "pinterest", socialConnectionId: "conn-pin-2" },
    ],
  });
  const { deps, pinCalls } = makeDeps();
  const out = await publishContent(draft.id, { deps });

  assert.equal(pinCalls.length, 1, "only the account that HAS a board is dispatched");
  assert.equal(pinCalls[0].boardId, "board-1");
  const refused = out.results.find(r => r.destinationId === "pinterest:conn-pin-2");
  assert.equal(refused?.status, "failed");
  assert.equal(refused?.errorCode, "missing_board");
  assert.equal(out.published.length, 1, "the account that could publish still did");
});

  await test("two Instagram accounts are BOTH dispatched, each named by its own connection", async () => {
  const draft = seedDraft({
    id: "multi-ig",
    destinations: [
      { provider: "instagram", socialConnectionId: IG_CONN },
      { provider: "instagram", socialConnectionId: "conn-ig-2" },
    ],
  });
  const { deps, socialCalls } = makeDeps();
  const out = await publishContent(draft.id, { deps });

  assert.equal(socialCalls.length, 1, "one fan-out call carries both accounts");
  assert.deepEqual(socialCalls[0].destinations.map(d => d.socialConnectionId), [IG_CONN, "conn-ig-2"],
    "the server needs each account explicitly - guessing is the wrong-account defect");
  assert.equal(out.published.filter(r => r.provider === "instagram").length, 2);
  const ids = out.results.map(r => r.destinationId);
  assert.ok(ids.includes("instagram:" + IG_CONN) && ids.includes("instagram:conn-ig-2"), JSON.stringify(ids));
});

  console.log("\n=== social-only refusals carry their code onto the outcome ===");

  await test("social-only publish refused with 402 scheduled_post_limit_reached -> outcome has that errorCode", async () => {
    const draft = seedDraft({
      id: "social-limit",
      destinations: [{ provider: "instagram", socialConnectionId: IG_CONN }],
    });
    const { deps, socialCalls } = makeDeps({
      socialThrows: new SocialApiError(
        "You have reached your scheduled post limit for this billing period.",
        402,
        "scheduled_post_limit_reached",
      ),
    });
    const out = await publishContent(draft.id, { deps });

    assert.equal(socialCalls.length, 1, "the call was attempted");
    assert.equal(out.published.length, 0);
    assert.equal(out.failed.length, 1);
    const ig = out.results.find(r => r.provider === "instagram")!;
    assert.equal(ig.status, "failed");
    assert.equal(ig.errorCode, "scheduled_post_limit_reached");
    assert.match(ig.errorMessage ?? "", /scheduled post limit/);
  });

  await test("a generic 500 social failure -> no errorCode, message preserved", async () => {
    const draft = seedDraft({
      id: "social-500",
      destinations: [{ provider: "instagram", socialConnectionId: IG_CONN }],
    });
    const { deps } = makeDeps({
      socialThrows: new SocialApiError("Internal server error.", 500),
    });
    const out = await publishContent(draft.id, { deps });

    const ig = out.results.find(r => r.provider === "instagram")!;
    assert.equal(ig.status, "failed");
    assert.equal(ig.errorCode, undefined, "a code-less refusal must not fabricate one");
    assert.equal(ig.errorMessage, "Internal server error.");
  });

  await test("a non-SocialApiError social failure (e.g. a network throw) -> no errorCode either", async () => {
    const draft = seedDraft({
      id: "social-network",
      destinations: [{ provider: "instagram", socialConnectionId: IG_CONN }],
    });
    const { deps } = makeDeps({ socialThrows: new Error("Could not reach social connections.") });
    const out = await publishContent(draft.id, { deps });

    const ig = out.results.find(r => r.provider === "instagram")!;
    assert.equal(ig.status, "failed");
    assert.equal(ig.errorCode, undefined);
    assert.equal(ig.errorMessage, "Could not reach social connections.");
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

void main();
