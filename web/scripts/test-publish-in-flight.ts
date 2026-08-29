/**
 * test-publish-in-flight.ts — recovering a publish that a refresh interrupted.
 *
 * `publishing` lived in component state, so reloading mid-publish left the drawer
 * looking idle while the request was still running: the merchant could not tell
 * whether anything had been sent, and pressing Publish again was the obvious next
 * move (TC-094).
 *
 * GET /api/publish/in-flight answers "is a publish for this Pin running right
 * now?" from the attempt row, which is written before dispatch.
 *
 * What is asserted here is the judgement in that route — the staleness rule — plus
 * the client helper's contract that a failed probe never invents a publish. The
 * route's auth/404 branches are thin wrappers over shared helpers and are covered
 * by the auth-boundary suite; asserting them here would require monkey-patching
 * ES module exports, which is not possible and would prove little.
 *
 * Run: npx tsx scripts/test-publish-in-flight.ts
 */
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";

// Marks this file as a module. Without a top-level import/export these scripts
// share one global scope under the repo tsconfig, and `main` collides with the
// `main` in every sibling test. The real imports stay dynamic, below, so they
// still load after the env above is set.
export {};

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`  OK   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`); }
}
function section(t: string) { console.log(`\n=== ${t} ===`); }

const MIN = 60 * 1000;

async function main() {
  const { isAttemptLive, STALE_AFTER_MS } =
    await import("../src/app/api/publish/in-flight/route");

  const now = Date.parse("2026-08-18T12:00:00.000Z");
  const ago = (ms: number) => new Date(now - ms).toISOString();

  section("a publish that is genuinely running is reported as live");
  check("a publish started seconds ago is live", isAttemptLive(ago(30_000), now));
  check("one started 5 minutes ago is still live", isAttemptLive(ago(5 * MIN), now));
  check("one started 9 minutes ago is still live", isAttemptLive(ago(9 * MIN), now));

  section("an abandoned attempt must not become a spinner that never resolves");
  // A worker that dies mid-publish leaves a row claiming to be publishing forever.
  // Without a cutoff the drawer would wait on it indefinitely.
  check("11 minutes old is NOT live", !isAttemptLive(ago(11 * MIN), now));
  check("an hour old is NOT live", !isAttemptLive(ago(60 * MIN), now));

  section("the cutoff itself");
  check("exactly at the cutoff still counts as live",
    isAttemptLive(ago(STALE_AFTER_MS), now),
    "the boundary must be inclusive — a publish is not abandoned the instant it hits 10m");
  check("one millisecond past the cutoff does not",
    !isAttemptLive(ago(STALE_AFTER_MS + 1), now));
  check("the cutoff matches the cron's stale-claim window (10 minutes)",
    STALE_AFTER_MS === 10 * MIN, `got ${STALE_AFTER_MS}ms`);

  section("a malformed timestamp errs toward showing the publish");
  // The row exists and says it is publishing. Discarding a real attempt over a
  // formatting problem is the worse failure: the merchant would be invited to
  // publish again while the first one is still running.
  check("an unparseable created_at is treated as live", isAttemptLive("not-a-date", now));
  check("an empty created_at is treated as live", isAttemptLive("", now));

  section("a future timestamp (clock skew) is live, not stale");
  check("a job stamped 1 minute in the future is live",
    isAttemptLive(new Date(now + MIN).toISOString(), now));

  section("the client helper never invents a publish");
  const { fetchInFlightPublish } = await import("../src/lib/social/socialClient");
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => { throw new Error("network down"); }) as typeof fetch;
    const onThrow = await fetchInFlightPublish("pd_1");
    check("a network failure resolves to inFlight:false", onThrow.inFlight === false,
      JSON.stringify(onThrow));

    globalThis.fetch = (async () =>
      new Response("nope", { status: 500 })) as typeof fetch;
    const on500 = await fetchInFlightPublish("pd_1");
    check("a 500 resolves to inFlight:false", on500.inFlight === false);

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ inFlight: true, jobId: "job_1" }), {
        status: 200, headers: { "content-type": "application/json" },
      })) as typeof fetch;
    const ok = await fetchInFlightPublish("pd_1");
    check("a real in-flight answer is passed through", ok.inFlight === true && ok.jobId === "job_1");

    let called = false;
    globalThis.fetch = (async () => { called = true; return new Response("{}"); }) as typeof fetch;
    const blank = await fetchInFlightPublish("");
    check("an empty postId short-circuits without a request",
      blank.inFlight === false && !called);
  } finally {
    globalThis.fetch = realFetch;
  }

  console.log(`\nPublish in-flight: ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error("SUITE CRASH:", e); process.exit(1); });
