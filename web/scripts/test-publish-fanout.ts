/**
 * test-publish-fanout.ts — the execution layer (P0 option A, layers B + C).
 *
 * Asserts the rules that decide what a merchant actually sees after a scheduled
 * multi-platform publish: how a job's status is rolled up, and what a retry is
 * allowed to re-send.
 *
 * Run: npx tsx scripts/test-publish-fanout.ts
 */
import {
  rollUpJobStatus,
  pendingDestinations,
  pinterestOutcomeRow,
  type DestinationOutcome,
} from "../src/lib/social/publishRules";
import type { ScheduledDestination } from "../src/lib/pinDraftStore";

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

console.log(`\nPublish fanout: ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
