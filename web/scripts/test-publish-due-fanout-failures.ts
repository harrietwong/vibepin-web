/**
 * test-publish-due-fanout-failures.ts — a fan-out that dies must not die quietly.
 *
 * The defect: in /api/cron/publish-due the social fan-out ran inside a try whose catch
 * only console.error'd. One thrown error (a DB hiccup resolving the second account, a
 * provider client blowing up outside its own handler) and EVERY owed Instagram/Facebook
 * destination lost its result row — while the Pinterest publish that already succeeded
 * still marked the Content posted. The merchant saw a posted Content with no Instagram
 * row at all: indistinguishable from a Content they never selected Instagram for. The
 * same hole exists, quieter, when the fan-out returns fewer rows than it was given.
 *
 * `failedRowsForUnattempted` is the pure half of the fix; the second section asserts the
 * route is actually wired to it (the block itself needs Supabase, so it cannot run here).
 *
 * Run: npx tsx scripts/test-publish-due-fanout-failures.ts
 */

import { readFileSync } from "node:fs";
import {
  failedRowsForUnattempted,
  didNotCompleteMessage,
  payloadAfterOutcomes,
} from "../src/app/api/cron/publish-due/publishDueLogic";
import type { DestinationOutcome } from "../src/lib/social/publishRules";
import type { ScheduledDestination } from "../src/lib/pinDraftStore";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`  OK   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`); }
}
function section(t: string) { console.log(`\n=== ${t} ===`); }

const AT = "2026-08-27T00:00:00.000Z";
const IG_A: ScheduledDestination = { provider: "instagram", socialConnectionId: "ig_A", accountLabel: "@shop_a", capturedAt: AT };
const IG_B: ScheduledDestination = { provider: "instagram", socialConnectionId: "ig_B", capturedAt: AT };
const FB_A: ScheduledDestination = { provider: "facebook", socialConnectionId: "fb_A", capturedAt: AT };
const PIN_A: ScheduledDestination = { provider: "pinterest", socialConnectionId: "pin_A", boardId: "b-A", capturedAt: AT };

// ── the fan-out threw: nothing reported at all ───────────────────────────────
section("a thrown fan-out leaves every owed destination a visible failure");

const thrown = failedRowsForUnattempted([IG_A, FB_A], "Instagram API request failed");
check("every owed destination gets a row",
  thrown.length === 2 && thrown.every(r => r.status === "failed"),
  JSON.stringify(thrown));
check("each row names its own account",
  thrown.map(r => `${r.provider}:${r.socialConnectionId}`).join(",") === "instagram:ig_A,facebook:fb_A");
check("the reason the merchant sees is the reason it failed",
  thrown.every(r => r.error === "Instagram API request failed"));
check("the account label rides along so a two-account platform says WHICH one",
  thrown[0].accountName === "@shop_a" && thrown[1].accountName === undefined);
check("a failed row never carries a fake permalink",
  thrown.every(r => !r.externalPostId && !r.externalPostUrl));

// Pinterest has its own dispatch loop, which always records a row. Adding one here
// would either duplicate it or overwrite a real publish with a fabricated failure.
check("a Pinterest entry is never given a fan-out failure row",
  failedRowsForUnattempted([PIN_A, IG_A], "boom").map(r => r.provider).join(",") === "instagram");

check("no owed destinations ⇒ no rows (a Pinterest-only Content is untouched)",
  failedRowsForUnattempted([], "boom").length === 0);

check("an empty message still says something actionable",
  failedRowsForUnattempted([IG_A], "")[0].error === "Publishing to Instagram did not complete.");

// ── the fan-out returned, but not for everything ─────────────────────────────
section("a short result set is completed, not trusted");

const reported: DestinationOutcome[] = [
  { provider: "instagram", status: "published", socialConnectionId: "ig_A", externalPostId: "ig-1" },
];
const missing = failedRowsForUnattempted([IG_A, IG_B, FB_A], didNotCompleteMessage, reported);
check("only the destinations with no row of their own are filled in",
  missing.map(r => `${r.provider}:${r.socialConnectionId}`).join(",") === "instagram:ig_B,facebook:fb_A",
  JSON.stringify(missing.map(r => r.socialConnectionId)));
check("the account that DID publish is never overwritten with a failure",
  !missing.some(r => r.socialConnectionId === "ig_A"),
  "keying by platform alone would mark a delivered post failed");
// The platform's own display name (PLATFORMS[provider].name — "Facebook Page", not
// "facebook"), the same wording every other publish message uses.
check("the default reason names the platform",
  missing[0].error === "Publishing to Instagram did not complete."
  && missing[1].error === "Publishing to Facebook Page did not complete.",
  JSON.stringify(missing.map(r => r.error)));
check("a destination reported as FAILED is not given a second row",
  failedRowsForUnattempted([IG_A], didNotCompleteMessage,
    [{ provider: "instagram", status: "failed", socialConnectionId: "ig_A", error: "Token expired" }]).length === 0);
check("a duplicated entry produces one row, not two",
  failedRowsForUnattempted([IG_A, IG_A], "boom").length === 1);

// ── what the merchant ends up seeing ─────────────────────────────────────────
section("the Content's stored result rows tell the whole story");

const after = payloadAfterOutcomes({ scheduledDate: "2026-08-27" }, [
  { provider: "pinterest", status: "published", socialConnectionId: "pin_A", externalPostId: "p1", externalPostUrl: "https://pin/1" },
  ...failedRowsForUnattempted([IG_A], "Instagram API request failed"),
], "2026-08-27T10:00:00.000Z");
const rows = after.destinationResults as Array<Record<string, unknown>>;
check("the Pinterest publish still counts — a fan-out failure never un-publishes it",
  after.postedAt === "2026-08-27T10:00:00.000Z" && after.remotePinId === "p1");
check("and the Instagram destination is there, failed, with its reason",
  rows.length === 2
  && rows[1].destinationId === "instagram:ig_A"
  && rows[1].status === "failed"
  && rows[1].errorMessage === "Instagram API request failed",
  JSON.stringify(rows));
check("the failed row names the account",
  rows[1].accountLabel === "@shop_a");

// ── the route is wired to it ─────────────────────────────────────────────────
// The fan-out block itself needs Supabase, so the wiring is asserted on the source:
// this is the exact code path that was silent, and a refactor that drops it must fail
// something.
section("/api/cron/publish-due actually uses it");

const route = readFileSync("src/app/api/cron/publish-due/route.ts", "utf8");
const catchAt = route.indexOf("catch (fanErr)");
check("the fan-out catch records failure rows instead of only logging",
  catchAt > 0 && /catch \(fanErr\)[\s\S]{0,900}failedRowsForUnattempted\(extras, described\.message\)/.test(route),
  "a thrown fan-out must leave the merchant a result row per owed destination");
check("the successful path also fills in destinations the fan-out did not report",
  /failedRowsForUnattempted\(extras, didNotCompleteMessage, fanned\)/.test(route));
check("the job id is declared outside the try, so a throw can still finalize the attempt",
  /let jobId: string \| null = null;[\s\S]{0,120}try \{/.test(route),
  "otherwise the job row stays 'publishing' forever and the failure rows are never recorded");
check("the outcomes are recorded AFTER the catch, so the failure rows are included",
  catchAt > 0 && route.indexOf("if (jobId) await recordOutcomes(db, jobId, outcomes);") > catchAt);
check("recording the attempt cannot itself fail the row",
  /try \{\s*\r?\n\s*if \(jobId\) await recordOutcomes\(db, jobId, outcomes\);\s*\r?\n\s*\} catch/.test(route),
  "a recordOutcomes throw would otherwise reach the row catch and mark a delivered publish failed");

console.log(`\nPublish-due fan-out failures: ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
