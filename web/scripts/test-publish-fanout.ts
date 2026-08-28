/**
 * test-publish-fanout.ts — the execution layer (P0 option A, layers B + C).
 *
 * Asserts the rules that decide what a merchant actually sees after a scheduled
 * multi-platform publish: how a job's status is rolled up, what a retry is allowed
 * to re-send, and — the second half of this file — that `fanOutDestinations` really
 * ISOLATES its destinations from one another.
 *
 * The dispatch layer builds a Supabase client at module load, so that half runs the
 * real `fanOutDestinations` with `./server/socialConnectionStore` and `./providers`
 * faked through Module._load (the same idiom as test-ai-provider-auth-boundary.ts).
 * No network, no DB, no credentials.
 *
 * Run: npx tsx scripts/test-publish-fanout.ts
 */
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";

import {
  rollUpJobStatus,
  pendingDestinations,
  pinterestOutcomeRow,
  hasTimeForDestination,
  DESTINATION_RESERVE_MS,
  DEFERRED_OUT_OF_TIME,
  type DestinationOutcome,
} from "../src/lib/social/publishRules";
import type { ScheduledDestination } from "../src/lib/pinDraftStore";
import { Module } from "node:module";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`  OK   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`); }
}
function section(t: string) { console.log(`\n=== ${t} ===`); }

const out = (provider: string, status: DestinationOutcome["status"]): DestinationOutcome =>
  ({ provider: provider as DestinationOutcome["provider"], status, socialConnectionId: `conn-${provider}` });

const dest = (provider: string): ScheduledDestination =>
  ({ provider, socialConnectionId: `conn-${provider}`, capturedAt: "2026-08-18T00:00:00.000Z" });

// ── job status roll-up ───────────────────────────────────────────────────────
section("a job's status reflects every destination, not just the first");

check("all published ⇒ published",
  rollUpJobStatus([out("pinterest", "published"), out("instagram", "published")]) === "published");
check("some published ⇒ partially_published (TC-093)",
  rollUpJobStatus([out("pinterest", "published"), out("facebook", "failed")]) === "partially_published");
check("none published ⇒ failed",
  rollUpJobStatus([out("instagram", "failed"), out("facebook", "failed")]) === "failed");
check("no destinations at all ⇒ failed (never a silent success)",
  rollUpJobStatus([]) === "failed");

// A deliberately skipped platform must not drag a clean publish down to "partial".
check("a skipped destination does not make a full success look partial",
  rollUpJobStatus([out("pinterest", "published"), out("tiktok", "skipped")]) === "published");
check("only-skipped ⇒ failed (nothing was actually delivered)",
  rollUpJobStatus([out("tiktok", "skipped")]) === "failed");

// The single most important one: a 3-platform publish where 2 worked must NOT
// read as success. That is the "UI says success, provider says otherwise" P0.
check("2 of 3 published is NOT reported as success",
  rollUpJobStatus([out("pinterest", "published"), out("instagram", "published"), out("facebook", "failed")])
    !== "published");

// ── retry: never re-send what already published ──────────────────────────────
section("retry targets destinations, not the whole Pin (TC-164)");

const intent = [dest("pinterest"), dest("instagram"), dest("facebook")];

check("a fresh Pin has every destination pending",
  pendingDestinations(intent, []).length === 3);

const afterPartial = [
  { provider: "pinterest", status: "published" },
  { provider: "instagram", status: "published" },
  { provider: "facebook", status: "failed" },
];
const retry = pendingDestinations(intent, afterPartial);
check("retry re-sends ONLY the failed destination",
  retry.length === 1 && retry[0].provider === "facebook",
  `would re-send: ${JSON.stringify(retry.map(d => d.provider))}`);
check("an already-published destination is never re-sent (no double post)",
  !retry.some(d => d.provider === "instagram" || d.provider === "pinterest"));

check("when everything published, a retry sends nothing",
  pendingDestinations(intent, intent.map(d => ({ provider: d.provider, status: "published" }))).length === 0);

// A destination that is still in flight is not "done" — it must remain pending
// so a crashed attempt can be completed rather than abandoned.
check("a destination left 'publishing' is still pending",
  pendingDestinations(intent, [{ provider: "instagram", status: "publishing" }]).length === 3);
check("a 'failed' destination is pending",
  pendingDestinations(intent, [{ provider: "facebook", status: "failed" }]).length === 3);

// ── two accounts on ONE platform are two destinations, not one ──────────────
// Keying "already done" by provider alone skipped the second Facebook Page for
// good: the platform read as published, so the Page that never got the post was
// never retried. The key is provider + account.
const twoPages: ScheduledDestination[] = [
  { provider: "facebook", socialConnectionId: "conn-fb-a", capturedAt: "2026-08-18T00:00:00.000Z" },
  { provider: "facebook", socialConnectionId: "conn-fb-b", capturedAt: "2026-08-18T00:00:00.000Z" },
];
const secondPage = pendingDestinations(twoPages, [
  { provider: "facebook", status: "published", socialConnectionId: "conn-fb-a" },
  { provider: "facebook", status: "failed", socialConnectionId: "conn-fb-b" },
]);
check("the second account on a platform is still retried after the first published",
  secondPage.length === 1 && secondPage[0].socialConnectionId === "conn-fb-b",
  `pending: ${JSON.stringify(secondPage.map(d => d.socialConnectionId))}`);
check("the account that published is not re-sent (no double post on that Page)",
  !secondPage.some(d => d.socialConnectionId === "conn-fb-a"));
check("both accounts published ⇒ nothing pending",
  pendingDestinations(twoPages, twoPages.map(d =>
    ({ provider: d.provider, status: "published", socialConnectionId: d.socialConnectionId }))).length === 0);
// A row from before per-account results existed cannot say which account it was.
// It keeps the provider-wide meaning — guessing "some other account" would be the
// double post this rule exists to prevent.
check("a legacy attempted row with no account still blocks the whole platform",
  pendingDestinations(twoPages, [{ provider: "facebook", status: "published" }]).length === 0);

// Retry reads the ACCOUNT off the frozen intent, so it cannot drift to whatever
// the default happens to be now.
check("the retried destination keeps its original account id",
  retry[0].socialConnectionId === "conn-facebook",
  "retry must reuse the account the schedule named, not the current default");

// ── Pinterest folds into the same result set ─────────────────────────────────
section("Pinterest's result is recorded alongside the others");

const okRow = pinterestOutcomeRow(dest("pinterest"),
  { ok: true, connectionId: "conn-real", pinId: "999", pinUrl: "https://pin/999" });
check("a successful Pinterest publish is recorded as published",
  okRow.status === "published" && okRow.externalPostId === "999");
check("it records the account that ACTUALLY published (adopt-once)",
  okRow.socialConnectionId === "conn-real",
  "must prefer the connection the publish really used over the intent's");

const badRow = pinterestOutcomeRow(dest("pinterest"), { ok: false, error: "Board unavailable" });
check("a failed Pinterest publish is recorded as failed, with its reason",
  badRow.status === "failed" && badRow.error === "Board unavailable");
check("a failed publish never carries a fake permalink (TC-102)",
  !badRow.externalPostUrl);

// With Pinterest folded in, a Pinterest-only failure is visible in the roll-up
// rather than hidden because the fan-out platforms all worked.
check("a Pinterest failure still shows up in the job status",
  rollUpJobStatus([badRow, out("instagram", "published")]) === "partially_published");

// ── the fan-out isolates its destinations ────────────────────────────────────
// Running the REAL fanOutDestinations, with only the two modules that touch the
// outside world replaced. What is asserted here is not a helper's return value but
// the function's contract under failure: it never rejects, and every destination it
// is handed leaves exactly one outcome behind.

const lookups: string[] = [];
const publishes: string[] = [];
/** Connection ids whose LOOKUP must throw — the defect's exact shape. */
const lookupThrows = new Set<string>();
/** Connection ids whose PUBLISH must throw. */
const publishThrows = new Set<string>();

const loader = Module as unknown as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
};
const originalLoad = loader._load;
loader._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request.endsWith("server/socialConnectionStore")) {
    return {
      findConnection: async (_uid: string, id: string) => {
        lookups.push(id);
        if (lookupThrows.has(id)) throw new Error(`lookup exploded for ${id}`);
        if (id === "conn-gone") return null;
        return { id, authProvider: "mock", connectionStatus: "connected" };
      },
    };
  }
  if (request.endsWith("./providers")) {
    return {
      getSocialProviderById: () => ({
        publishPost: async ({ connection }: { connection: { id: string } }) => {
          publishes.push(connection.id);
          if (publishThrows.has(connection.id)) throw new Error(`publish exploded for ${connection.id}`);
          return { ok: true, externalPostId: `post-${connection.id}`, externalPostUrl: `https://x/${connection.id}` };
        },
      }),
    };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

async function main(): Promise<void> {
  const { fanOutDestinations } = await import("../src/lib/social/publishFanout");

  const social = (provider: string, id: string): ScheduledDestination =>
    ({ provider, socialConnectionId: id, capturedAt: "2026-08-27T00:00:00.000Z" });
  const POST = { imageUrls: ["https://cdn/x.jpg"], caption: "hi" };

  section("one destination's failure never costs another its outcome");

  {
    // THE defect: the connection lookup used to live outside dispatchDestination's try,
    // so a throw on #2 rejected the whole fan-out — and #1's already-published outcome
    // died with it. The cron then wrote `failed` for #1 and re-posted it next run.
    lookupThrows.clear(); publishThrows.clear(); lookups.length = 0; publishes.length = 0;
    lookupThrows.add("conn-b");
    const dests = [social("instagram", "conn-a"), social("facebook", "conn-b"), social("instagram", "conn-c")];
    let threw: unknown = null;
    let outcomes: DestinationOutcome[] = [];
    try { outcomes = await fanOutDestinations("u1", dests, POST); }
    catch (e) { threw = e; }

    check("fanOutDestinations resolves — a lookup throw never rejects the batch",
      threw === null, String(threw));
    check("every destination still gets exactly one outcome, in order",
      outcomes.length === 3
      && outcomes.map(o => o.socialConnectionId).join(",") === "conn-a,conn-b,conn-c",
      JSON.stringify(outcomes.map(o => o.socialConnectionId)));
    check("the destination BEFORE the throw keeps its published outcome",
      outcomes[0].status === "published" && outcomes[0].externalPostId === "post-conn-a",
      JSON.stringify(outcomes[0]));
    check("the throwing destination is failed, carrying the reason",
      outcomes[1].status === "failed" && outcomes[1].error === "lookup exploded for conn-b",
      JSON.stringify(outcomes[1]));
    check("the destination AFTER the throw is still attempted",
      outcomes[2].status === "published" && publishes.includes("conn-c"),
      JSON.stringify(publishes));
    check("the failed destination never carries a permalink",
      !outcomes[1].externalPostId && !outcomes[1].externalPostUrl);
  }

  {
    // Same isolation for a provider client that blows up rather than returning !ok.
    lookupThrows.clear(); publishThrows.clear(); lookups.length = 0; publishes.length = 0;
    publishThrows.add("conn-b");
    const outcomes = await fanOutDestinations("u1",
      [social("instagram", "conn-a"), social("facebook", "conn-b")], POST);
    check("a provider that throws fails only its own destination",
      outcomes.length === 2 && outcomes[0].status === "published" && outcomes[1].status === "failed",
      JSON.stringify(outcomes.map(o => o.status)));
    check("and the reason the merchant sees is the provider's",
      outcomes[1].error === "publish exploded for conn-b");
  }

  {
    // A disconnected account is a failure with an actionable message — never a silent
    // drop, and never a reason to abandon the accounts beside it.
    lookupThrows.clear(); publishThrows.clear();
    const outcomes = await fanOutDestinations("u1",
      [social("instagram", "conn-gone"), social("instagram", "conn-a")], POST);
    check("a disconnected account fails with a reconnect message, alone",
      outcomes.length === 2
      && outcomes[0].status === "failed"
      && /Reconnect your/.test(outcomes[0].error ?? "")
      && outcomes[1].status === "published",
      JSON.stringify(outcomes));
  }

  section("the run's deadline defers a destination instead of half-publishing it");

  {
    // The whole point: NOT ONE provider call once the deadline is in reach. A post
    // made with no time left to persist it is the double-post window — the process
    // dies before the write, the claim goes stale, and the run ten minutes later
    // sends it again.
    lookupThrows.clear(); publishThrows.clear(); lookups.length = 0; publishes.length = 0;
    const outcomes = await fanOutDestinations("u1",
      [social("instagram", "conn-a"), social("facebook", "conn-b")], POST,
      { deadlineMs: Date.now() + 1_000 });
    check("no provider was called once the deadline was in reach",
      publishes.length === 0 && lookups.length === 0,
      `publishes=${JSON.stringify(publishes)} lookups=${JSON.stringify(lookups)}`);
    check("every deferred destination still gets exactly one outcome",
      outcomes.length === 2
      && outcomes.map(o => o.socialConnectionId).join(",") === "conn-a,conn-b");
    check("a deferred destination is pending — not failed, not skipped",
      outcomes.every(o => o.status === "pending"),
      JSON.stringify(outcomes.map(o => o.status)));
    check("and it says why, for the log",
      outcomes.every(o => o.error === DEFERRED_OUT_OF_TIME));
    check("a deferred destination is still owed, so a retry re-sends it",
      pendingDestinations([social("instagram", "conn-a")],
        outcomes.map(o => ({ provider: o.provider, status: o.status, socialConnectionId: o.socialConnectionId }))
      ).length === 1,
      "pendingDestinations excludes only `published` — a pending row must stay owed");
  }

  {
    // A deadline far away changes nothing at all.
    lookupThrows.clear(); publishThrows.clear(); publishes.length = 0;
    const outcomes = await fanOutDestinations("u1", [social("instagram", "conn-a")], POST,
      { deadlineMs: Date.now() + 10 * 60 * 1000 });
    check("with time to spare the destination publishes exactly as before",
      outcomes[0].status === "published" && publishes.join(",") === "conn-a");
  }

  {
    // The boundary is DESTINATION_RESERVE_MS: a destination may only start if it can
    // finish AND be persisted before the ceiling.
    const now = 1_000_000;
    check("exactly one reserve of headroom is still enough to start",
      hasTimeForDestination(now, now + DESTINATION_RESERVE_MS) === true);
    check("one millisecond less is not",
      hasTimeForDestination(now, now + DESTINATION_RESERVE_MS - 1) === false);
    check("no deadline at all ⇒ unbounded, exactly the old behaviour",
      hasTimeForDestination(now, undefined) === true);
  }

  {
    // Pinterest keeps its dedicated path: the fan-out must not produce a row for it,
    // or the Content would carry two rows for one publish.
    const outcomes = await fanOutDestinations("u1",
      [{ provider: "pinterest", socialConnectionId: "pin_A", capturedAt: "2026-08-27T00:00:00.000Z" },
       social("instagram", "conn-a")], POST);
    check("a Pinterest entry is skipped by the fan-out, not dispatched twice",
      outcomes.length === 1 && outcomes[0].provider === "instagram");
  }
}

main().then(() => {
  console.log(`\nPublish fanout: ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}).catch(err => {
  console.error(err);
  process.exit(1);
});
