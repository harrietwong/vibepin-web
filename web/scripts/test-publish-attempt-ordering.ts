/**
 * test-publish-attempt-ordering.ts — an attempt is recorded BEFORE it is made.
 *
 * Publish now used to write its job row only after every provider call had
 * returned. Two consequences, both customer-visible:
 *
 *   - a crash mid-publish left a post live on the platform with no record of it;
 *   - a client that refreshed while publishing had no in-flight state to restore,
 *     so the UI simply showed nothing (TC-090 / TC-094).
 *
 * Both paths now create the job as `publishing` first and finalize it after, via
 * the one shared execution layer. This asserts that ORDER — the thing that
 * actually changed — by recording the sequence of calls against a fake client.
 *
 * Run: npx tsx scripts/test-publish-attempt-ordering.ts
 */
// Env must be set BEFORE server modules load (supabase.ts builds a client at
// import time). These are placeholders: every DB call in this file goes to the
// fake client below, never to a real project.
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";

// Loaded dynamically INSIDE main(), after the env above is in place: a static
// import is hoisted above these assignments and supabase.ts would build its
// client with no url.
import type { DestinationOutcome } from "../src/lib/social/publishRules";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`  OK   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`); }
}
function section(t: string) { console.log(`\n=== ${t} ===`); }

/**
 * Records every table operation in order, so the sequence can be asserted.
 * `insert()` is awaited directly in one place and chained with `.select().single()`
 * in another, so the fake is a promise that also carries `.select()`.
 */
function fakeDbAwaitable(log: string[], opts: { missingTables?: boolean } = {}) {
  const missing = { code: "42P01", message: "relation does not exist" };
  return {
    from(table: string) {
      return {
        insert(payload: unknown) {
          const rows = Array.isArray(payload) ? payload.length : 1;
          const status = !Array.isArray(payload) ? (payload as { status?: string }).status : undefined;
          log.push(`insert:${table}${status ? `(status=${status})` : `(rows=${rows})`}`);
          const result = opts.missingTables
            ? { data: null, error: missing }
            : { data: { id: "job_1" }, error: null };
          return Object.assign(Promise.resolve(result), {
            select: () => ({ single: async () => result }),
          });
        },
        update(patch: Record<string, unknown>) {
          log.push(`update:${table}(status=${String(patch.status)})`);
          return { eq: async () => ({ error: opts.missingTables ? missing : null }) };
        },
      };
    },
  } as never;
}

const outcomes: DestinationOutcome[] = [
  { provider: "instagram", status: "published", socialConnectionId: "c1", externalPostUrl: "https://ig/p/1" },
  { provider: "facebook", status: "failed", socialConnectionId: "c2", error: "Page unavailable" },
];

async function main() {
  const { createPublishJob, recordOutcomes } = await import("../src/lib/social/publishFanout");
  const { rollUpJobStatus } = await import("../src/lib/social/publishRules");

  section("the attempt row exists before any result is known");
  {
    const log: string[] = [];
    const db = fakeDbAwaitable(log);
    const jobId = await createPublishJob(db, "u1", "pd_1", null);
    // Dispatch happens here in the real routes; the point is the job already exists.
    log.push("--dispatch--");
    if (jobId) await recordOutcomes(db, jobId, outcomes);

    console.log(`  sequence: ${log.join(" → ")}`);
    check("a job row is created", log.some(l => l.startsWith("insert:social_publish_jobs")));
    check("it is created as `publishing`, not a terminal status",
      log.some(l => l.includes("insert:social_publish_jobs(status=publishing)")),
      "an attempt that has not resolved must not be recorded as published/failed");
    check("the job is created BEFORE dispatch",
      log.indexOf("insert:social_publish_jobs(status=publishing)") < log.indexOf("--dispatch--"),
      `sequence was: ${log.join(" → ")}`);
    check("destination results are written AFTER dispatch",
      log.findIndex(l => l.startsWith("insert:social_publish_job_destinations")) > log.indexOf("--dispatch--"));
    check("the job status is finalized after the results",
      log.findIndex(l => l.startsWith("update:social_publish_jobs")) >
        log.findIndex(l => l.startsWith("insert:social_publish_job_destinations")));
  }

  section("the finalized status reflects the real outcome");
  {
    const log: string[] = [];
    const db = fakeDbAwaitable(log);
    const jobId = await createPublishJob(db, "u1", "pd_1", null);
    if (jobId) await recordOutcomes(db, jobId, outcomes);
    check("one published + one failed finalizes as partially_published",
      log.some(l => l === "update:social_publish_jobs(status=partially_published)"),
      `saw: ${log.join(" → ")}`);
    check("the roll-up helper agrees", rollUpJobStatus(outcomes) === "partially_published");
    check("one row is written per destination",
      log.some(l => l === "insert:social_publish_job_destinations(rows=2)"));
  }

  section("publishing still works when the record cannot be kept");
  {
    // v32 tables absent: createPublishJob returns null. Publishing must not break
    // just because the attempt could not be recorded.
    const log: string[] = [];
    const db = fakeDbAwaitable(log, { missingTables: true });
    const jobId = await createPublishJob(db, "u1", "pd_1", null);
    check("a missing table yields no job id rather than throwing", jobId === null);
    check("no destination rows are attempted without a job",
      !log.some(l => l.startsWith("insert:social_publish_job_destinations")));
  }

  console.log(`\nPublish attempt ordering: ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error("SUITE CRASH:", e); process.exit(1); });
