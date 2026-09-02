/**
 * test-admin-alerts.ts — acceptance gate for the proactive-alerts send layer
 * (`src/lib/server/adminAlerts.ts`).
 * Run: npx tsx scripts/test-admin-alerts.ts   (from web/)
 *
 * PRD: docs/prd/后台异常提醒与功能评价体系-PRD-v0.1-20260902.md §2, §2.6.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * WHAT THIS SUITE IS DEFENDING AGAINST
 * ═══════════════════════════════════════════════════════════════════════════════
 * The PRD's own risk section (§5) names the failure mode this feature dies from:
 * "告警疲劳" — the moment a false or duplicate alert erodes trust, every future
 * real alert gets ignored too. So this suite is built around two independent
 * mutation checks (below), not just "does it send an email":
 *
 *  1. DEDUPE MUST BE STATE-TRANSITION, NOT DAILY RE-SEND. A blocker that is still
 *     open on run 2 must NOT produce a second email. Deleting the dedupe check
 *     must turn a specific test red (verified below, then reverted).
 *
 *  2. ONLY EXACT PUBLISH FAILURES ARE PUSHED. Treating "inferred" the same as
 *     "exact" must turn a specific test red (verified below, then reverted).
 *
 * INDEPENDENT ORACLE: this file constructs its own BlockerItem fixtures and its
 * own in-memory admin_audit_events double; it never asks the module under test
 * what it expects.
 */

import assert from "node:assert";

let passed = 0, failed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log(`  OK ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n     ${(e as Error).stack ?? (e as Error).message}`); }
}

// ── fixtures ────────────────────────────────────────────────────────────────

type BlockerItemFixture = {
  userId: string;
  email: string | null;
  accountKind: "customer" | "test" | "internal";
  blockerType:
    | "publish_failure"
    | "pinterest_disconnected"
    | "generation_failures"
    | "signup_not_connected"
    | "connected_not_creating";
  firstSeenAt: string | null;
  dataQuality: "exact" | "inferred";
  evidence: Record<string, unknown>;
};

function blocker(overrides: Partial<BlockerItemFixture> = {}): BlockerItemFixture {
  return {
    userId: "user-1",
    email: "user1@example.com",
    accountKind: "customer",
    blockerType: "publish_failure",
    firstSeenAt: "2026-09-01T00:00:00.000Z",
    dataQuality: "exact",
    evidence: { failedPublishCount: 1, publishErrorMessage: "board not found" },
    ...overrides,
  };
}

function actionCenter(items: BlockerItemFixture[], available = true) {
  return {
    available,
    generatedAt: "2026-09-02T00:00:00.000Z",
    windowHours: 24,
    warnings: [] as string[],
    items: items as unknown as import("../src/lib/server/adminActionCenter").BlockerItem[],
    excluded: { customer: 0, test: 0, internal: 0 },
  };
}

// ── in-memory admin_audit_events double ──────────────────────────────────────

type AuditRow = {
  action: string;
  target_type: string;
  target_id: string | null;
  created_at: string;
  metadata?: Record<string, unknown> | null;
};

/**
 * Minimal fake matching the subset of the supabase query builder adminAlerts.ts
 * actually calls: .select().eq().in().order().limit() for reads, .insert() for
 * writes. Reads always return every row of the requested actions (the "unscoped
 * scan bounded by a limit" shape production uses); .eq/.in are recorded but not
 * used to narrow — good enough since adminAlerts only ever queries this one
 * shape.
 */
function makeFakeAuditDb(seedRows: AuditRow[] = []) {
  const rows: AuditRow[] = [...seedRows];
  let seq = 0;
  const db = {
    from(table: string) {
      assert.equal(table, "admin_audit_events");
      return {
        select() {
          const builder = {
            eq() { return builder; },
            in() { return builder; },
            order() { return builder; },
            limit() { return builder; },
            then(resolve: (v: { data: AuditRow[]; error: null }) => void) {
              resolve({ data: [...rows].sort((a, b) => a.created_at.localeCompare(b.created_at)), error: null });
            },
          };
          return builder;
        },
        async insert(row: Record<string, unknown>) {
          seq += 1;
          rows.push({
            action: row.action as string,
            target_type: row.target_type as string,
            target_id: (row.target_id as string) ?? null,
            created_at: `2026-09-02T00:00:${String(seq).padStart(2, "0")}.000Z`,
            metadata: (row.metadata as Record<string, unknown>) ?? null,
          });
          return { error: null };
        },
      };
    },
  };
  return { db, rows };
}

/** A read-error double: dedupe state becomes "unavailable" without throwing. */
function makeErrorAuditDb() {
  return {
    from(table: string) {
      assert.equal(table, "admin_audit_events");
      return {
        select() {
          const builder = {
            eq() { return builder; },
            in() { return builder; },
            order() { return builder; },
            limit() { return builder; },
            then(resolve: (v: { data: null; error: { message: string } }) => void) {
              resolve({ data: null, error: { message: "relation admin_audit_events does not exist" } });
            },
          };
          return builder;
        },
        async insert() { return { error: null }; },
      };
    },
  };
}

// ── fake sendEmail (module mocked via a swappable holder) ───────────────────

type SendEmailCall = { to: string; subject: string; text: string; html: string };
let sendEmailImpl: (input: SendEmailCall) => Promise<{ ok: boolean; skipped?: boolean; errorSummary?: string }>;
const sendEmailCalls: SendEmailCall[] = [];

// Mock @/lib/support/email before adminAlerts.ts is imported, so its static
// `import { sendEmail }` binds to this fake instead of the real Resend client.
import { Module } from "node:module";
type LoaderReq = (id: string, ...rest: unknown[]) => unknown;
const realResolve = (Module as unknown as { _resolveFilename: LoaderReq })._resolveFilename;
const originalLoad = (Module as unknown as { _load: LoaderReq })._load;
(Module as unknown as { _load: LoaderReq })._load = function patchedLoad(this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "@/lib/support/email" || /[\\/]lib[\\/]support[\\/]email(\.ts)?$/.test(request)) {
    return {
      sendEmail: async (input: SendEmailCall) => {
        sendEmailCalls.push(input);
        return sendEmailImpl(input);
      },
      escapeHtml: (v: string) => v.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string)),
    };
  }
  return originalLoad.apply(this, [request, parent, isMain] as never);
} as LoaderReq;
void realResolve;

async function main() {
  const {
    selectPushableBlockers,
    buildAlertEmail,
    resolveAlertRecipient,
    runAdminAlerts,
    blockerKey,
  } = await import("../src/lib/server/adminAlerts");

  // ══════════════════════════════════════════════════════════════════════════
  // 1. SELECTION (PRD §2.1) — pure function, independent oracle
  // ══════════════════════════════════════════════════════════════════════════
  console.log("\n=== 1. selectPushableBlockers: only the 3 allowed types ===");

  await test("signup_not_connected is never pushed", () => {
    const center = actionCenter([blocker({ blockerType: "signup_not_connected", dataQuality: "inferred" })]);
    assert.equal(selectPushableBlockers(center).length, 0);
  });

  await test("connected_not_creating is never pushed", () => {
    const center = actionCenter([blocker({ blockerType: "connected_not_creating", dataQuality: "inferred" })]);
    assert.equal(selectPushableBlockers(center).length, 0);
  });

  await test("pinterest_disconnected (customer, any data quality) is pushed", () => {
    const center = actionCenter([blocker({ blockerType: "pinterest_disconnected", dataQuality: "inferred" })]);
    assert.equal(selectPushableBlockers(center).length, 1);
  });

  await test("generation_failures (customer, any data quality) is pushed", () => {
    const center = actionCenter([blocker({ blockerType: "generation_failures", dataQuality: "inferred" })]);
    assert.equal(selectPushableBlockers(center).length, 1);
  });

  await test("publish_failure with dataQuality=inferred is NOT pushed", () => {
    const center = actionCenter([blocker({ blockerType: "publish_failure", dataQuality: "inferred" })]);
    assert.equal(selectPushableBlockers(center).length, 0);
  });

  await test("publish_failure with dataQuality=exact IS pushed", () => {
    const center = actionCenter([blocker({ blockerType: "publish_failure", dataQuality: "exact" })]);
    assert.equal(selectPushableBlockers(center).length, 1);
  });

  await test("non-customer accountKind is never pushed (test account)", () => {
    const center = actionCenter([blocker({ accountKind: "test" })]);
    assert.equal(selectPushableBlockers(center).length, 0);
  });

  await test("non-customer accountKind is never pushed (internal account)", () => {
    const center = actionCenter([blocker({ accountKind: "internal" })]);
    assert.equal(selectPushableBlockers(center).length, 0);
  });

  await test("available:false pushes NOTHING even if items[] is non-empty", () => {
    const center = actionCenter([blocker(), blocker({ userId: "u2", blockerType: "pinterest_disconnected" })], false);
    assert.equal(selectPushableBlockers(center).length, 0);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 2. EMAIL ASSEMBLY (pure) — one summary, escaping
  // ══════════════════════════════════════════════════════════════════════════
  console.log("\n=== 2. buildAlertEmail: summary + escaping ===");

  await test("subject and body contain the count and mention every item", () => {
    const items = [
      blocker({ userId: "u1", email: "u1@example.com" }),
      blocker({ userId: "u2", email: "u2@example.com", blockerType: "pinterest_disconnected" }),
      blocker({ userId: "u3", email: "u3@example.com", blockerType: "generation_failures" }),
    ] as unknown as import("../src/lib/server/adminActionCenter").BlockerItem[];
    const { subject, text, html } = buildAlertEmail(items);
    assert.match(subject, /3/);
    for (const email of ["u1@example.com", "u2@example.com", "u3@example.com"]) {
      assert.ok(text.includes(email), `text missing ${email}`);
      assert.ok(html.includes(email), `html missing ${email}`);
    }
    for (const userId of ["u1", "u2", "u3"]) {
      assert.ok(html.includes(`/admin/users/${userId}`), `html missing deep link for ${userId}`);
    }
  });

  await test("HTML output escapes untrusted content (email + error message)", () => {
    const items = [
      blocker({
        email: '<script>alert(1)</script>@evil.com',
        evidence: { failedPublishCount: 1, publishErrorMessage: '<img src=x onerror=alert(2)>' },
      }),
    ] as unknown as import("../src/lib/server/adminActionCenter").BlockerItem[];
    const { html } = buildAlertEmail(items);
    assert.ok(!html.includes("<script>"), "raw <script> must not appear in html");
    assert.ok(!html.includes("<img src=x"), "raw <img onerror> must not appear in html");
    assert.ok(html.includes("&lt;script&gt;"), "email must be escaped");
    assert.ok(html.includes("&lt;img"), "error message must be escaped");
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 3. RECIPIENT RESOLUTION
  // ══════════════════════════════════════════════════════════════════════════
  console.log("\n=== 3. resolveAlertRecipient ===");

  await test("ALERT_EMAIL_TO wins when both are set", () => {
    const r = resolveAlertRecipient({ ALERT_EMAIL_TO: "alerts@vibepin.co", SUPER_ADMIN_EMAILS: "founder@vibepin.co" } as unknown as NodeJS.ProcessEnv);
    assert.equal(r.to, "alerts@vibepin.co");
  });

  await test("falls back to first SUPER_ADMIN_EMAILS entry", () => {
    const r = resolveAlertRecipient({ SUPER_ADMIN_EMAILS: "founder@vibepin.co, other@vibepin.co" } as unknown as NodeJS.ProcessEnv);
    assert.equal(r.to, "founder@vibepin.co");
  });

  await test("both missing → to:null with a reason, not a throw", () => {
    const r = resolveAlertRecipient({} as NodeJS.ProcessEnv);
    assert.equal(r.to, null);
    assert.ok(r.reason);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 4. ORCHESTRATION (runAdminAlerts) — dedupe, one-summary-email, best-effort send
  // ══════════════════════════════════════════════════════════════════════════
  console.log("\n=== 4. runAdminAlerts: dedupe + single summary + best-effort send ===");
  const ENV = { ALERT_EMAIL_TO: "alerts@vibepin.co" } as unknown as NodeJS.ProcessEnv;

  await test("first run: new blocker → 1 email sent, 1 blocker_notified row written", async () => {
    sendEmailCalls.length = 0;
    sendEmailImpl = async () => ({ ok: true });
    const { db, rows } = makeFakeAuditDb();
    const center = actionCenter([blocker({ userId: "u1" })]);
    const result = await runAdminAlerts({ center: center as never, db: db as never, env: ENV });
    assert.equal(result.available, true);
    assert.equal(result.newlyNotified, 1);
    assert.equal(result.cleared, 0);
    assert.equal(sendEmailCalls.length, 1);
    assert.equal(result.email.sent, true);
    const notifiedRows = rows.filter(r => r.action === "alert.blocker_notified" && r.target_id === blockerKey("u1", "publish_failure"));
    assert.equal(notifiedRows.length, 1);
  });

  await test("second run: same blocker still open → NO second email (state-transition dedupe)", async () => {
    sendEmailCalls.length = 0;
    sendEmailImpl = async () => ({ ok: true });
    const { db } = makeFakeAuditDb([
      { action: "alert.blocker_notified", target_type: "user_blocker", target_id: blockerKey("u1", "publish_failure"), created_at: "2026-09-01T00:00:00.000Z" },
    ]);
    const center = actionCenter([blocker({ userId: "u1" })]);
    const result = await runAdminAlerts({ center: center as never, db: db as never, env: ENV });
    assert.equal(result.newlyNotified, 0);
    assert.equal(result.stillOpen, 1);
    assert.equal(sendEmailCalls.length, 0, "must not re-send while still open");
    assert.equal(result.email.sent, false);
    assert.equal(result.email.reason, "no_new_blockers");
  });

  await test("recovery: notified → cleared → reappears → pushed again", async () => {
    // Step A: notified.
    const { db, rows } = makeFakeAuditDb();
    sendEmailImpl = async () => ({ ok: true });
    await runAdminAlerts({ center: actionCenter([blocker({ userId: "u1" })]) as never, db: db as never, env: ENV });
    assert.equal(rows.filter(r => r.action === "alert.blocker_notified").length, 1);

    // Step B: blocker disappears → cleared row written, no email.
    sendEmailCalls.length = 0;
    const clearRun = await runAdminAlerts({ center: actionCenter([]) as never, db: db as never, env: ENV });
    assert.equal(clearRun.cleared, 1);
    assert.equal(sendEmailCalls.length, 0);
    assert.ok(rows.some(r => r.action === "alert.blocker_cleared" && r.target_id === blockerKey("u1", "publish_failure")));

    // Step C: blocker reappears → treated as NEW (cleared superseded notified) → pushed again.
    sendEmailCalls.length = 0;
    const reRun = await runAdminAlerts({ center: actionCenter([blocker({ userId: "u1" })]) as never, db: db as never, env: ENV });
    assert.equal(reRun.newlyNotified, 1, "must re-notify after a clear+reappear cycle");
    assert.equal(sendEmailCalls.length, 1);
  });

  await test("3 new blockers in one run → exactly 1 email, body contains all 3", async () => {
    sendEmailCalls.length = 0;
    sendEmailImpl = async () => ({ ok: true });
    const { db } = makeFakeAuditDb();
    const center = actionCenter([
      blocker({ userId: "u1", email: "u1@example.com" }),
      blocker({ userId: "u2", email: "u2@example.com", blockerType: "pinterest_disconnected" }),
      blocker({ userId: "u3", email: "u3@example.com", blockerType: "generation_failures" }),
    ]);
    const result = await runAdminAlerts({ center: center as never, db: db as never, env: ENV });
    assert.equal(result.newlyNotified, 3);
    assert.equal(sendEmailCalls.length, 1, "must be exactly one summary email, not one per blocker");
    const body = sendEmailCalls[0].text + sendEmailCalls[0].html;
    for (const email of ["u1@example.com", "u2@example.com", "u3@example.com"]) {
      assert.ok(body.includes(email));
    }
  });

  await test("no new blockers → sendEmail is never called", async () => {
    sendEmailCalls.length = 0;
    sendEmailImpl = async () => ({ ok: true });
    const { db } = makeFakeAuditDb([
      { action: "alert.blocker_notified", target_type: "user_blocker", target_id: blockerKey("u1", "publish_failure"), created_at: "2026-09-01T00:00:00.000Z" },
    ]);
    const center = actionCenter([blocker({ userId: "u1" })]);
    const result = await runAdminAlerts({ center: center as never, db: db as never, env: ENV });
    assert.equal(result.newlyNotified, 0);
    assert.equal(sendEmailCalls.length, 0);
    assert.equal(result.email.skipped, true);
  });

  await test("sendEmail returns ok:false → run still reports success, errorSummary captured", async () => {
    sendEmailCalls.length = 0;
    sendEmailImpl = async () => ({ ok: false, errorSummary: "HTTP 500: provider down" });
    const { db } = makeFakeAuditDb();
    const center = actionCenter([blocker({ userId: "u1" })]);
    const result = await runAdminAlerts({ center: center as never, db: db as never, env: ENV });
    assert.equal(result.available, true, "overall run must still succeed");
    assert.equal(result.newlyNotified, 1, "blocker_notified row must still be written on email failure");
    assert.equal(result.email.failed, true);
    assert.equal(result.email.errorSummary, "HTTP 500: provider down");
  });

  await test("sendEmail throws → run still reports success, does not propagate", async () => {
    sendEmailCalls.length = 0;
    sendEmailImpl = async () => { throw new Error("socket hang up"); };
    const { db } = makeFakeAuditDb();
    const center = actionCenter([blocker({ userId: "u1" })]);
    let threw = false;
    let result: Awaited<ReturnType<typeof runAdminAlerts>> | null = null;
    try {
      result = await runAdminAlerts({ center: center as never, db: db as never, env: ENV });
    } catch {
      threw = true;
    }
    assert.equal(threw, false, "a thrown sendEmail must not propagate out of runAdminAlerts");
    assert.equal(result?.available, true);
    assert.equal(result?.newlyNotified, 1);
    assert.equal(result?.email.failed, true);
    assert.ok(result?.email.errorSummary?.includes("socket hang up"));
  });

  await test("no recipient configured (both env vars empty) → skipped with a reason, no throw", async () => {
    sendEmailCalls.length = 0;
    sendEmailImpl = async () => ({ ok: true });
    const { db } = makeFakeAuditDb();
    const center = actionCenter([blocker({ userId: "u1" })]);
    const result = await runAdminAlerts({ center: center as never, db: db as never, env: {} as NodeJS.ProcessEnv });
    assert.equal(sendEmailCalls.length, 0);
    assert.equal(result.email.skipped, true);
    assert.ok(result.email.reason?.includes("no_recipient_configured"));
    // blocker_notified must still be written — dedupe must not depend on send success.
    assert.equal(result.newlyNotified, 1);
  });

  await test("action center unavailable → run reports available:false, no email, no writes", async () => {
    sendEmailCalls.length = 0;
    sendEmailImpl = async () => ({ ok: true });
    const { db, rows } = makeFakeAuditDb();
    const center = actionCenter([blocker({ userId: "u1" })], false);
    const result = await runAdminAlerts({ center: center as never, db: db as never, env: ENV });
    assert.equal(result.available, false);
    assert.equal(sendEmailCalls.length, 0);
    assert.equal(rows.length, 0, "no audit rows should be written when the action center is unavailable");
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 5. MUTATION VERIFICATION (PRD §2.6 last bullet) — done by hand, recorded here
  // ══════════════════════════════════════════════════════════════════════════
  // See the task report for the actual red/green transcript of:
  //   (a) commenting out the dedupe `if (notifiedKeys.has(key))` branch in
  //       runAdminAlerts — "second run: same blocker still open → NO second
  //       email" must turn red.
  //   (b) removing the `dataQuality === "exact"` guard in
  //       selectPushableBlockers — "publish_failure with dataQuality=inferred
  //       is NOT pushed" must turn red.
  // Both were reverted after confirming red, then re-confirmed green.

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
