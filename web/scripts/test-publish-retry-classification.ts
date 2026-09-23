/**
 * Pure-function unit tests for the retry_class classification layer (发布可靠性
 * P0 技术设计 v0.1 §4.2/§4.3/§8.3 tasks 2). No network, no database — these are
 * the P1–P10 and P17 scenarios from the design's mock-provider scenario list,
 * exercised at the classification-function level only (the durable-attempt /
 * scheduling wiring those scenarios fully describe is task 3, not built here).
 *
 * Run: npx tsx scripts/test-publish-retry-classification.ts
 */

import { randomBytes } from "node:crypto";
import type { RetryClass } from "../src/lib/server/publish/retryClassification";
import type { PinterestApiError as PinterestApiErrorType } from "../src/lib/server/pinterest/service";
import type { PinterestVideoEvidence } from "../src/lib/server/pinterest/videoPinAdapter";
import type { DurableVideoPublishResult } from "../src/lib/server/publish/v76PinterestVideoPublish";

// Env must be set BEFORE the server modules load — service.ts pulls in
// connectionStore.ts, which creates a Supabase client at import time.
process.env.PINTEREST_TOKEN_ENC_KEY = randomBytes(32).toString("base64");
process.env.PINTEREST_APP_ID = "test-app-id";
process.env.PINTEREST_APP_SECRET = "test-app-secret";
process.env.PINTEREST_REDIRECT_URI = "http://localhost:3000/api/auth/pinterest/callback";
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`  OK   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`); }
}
function section(t: string) { console.log(`\n=== ${t} ===`); }

function videoEvidence(overrides: Partial<PinterestVideoEvidence> & Pick<PinterestVideoEvidence, "stage" | "classification">): PinterestVideoEvidence {
  return { ...overrides };
}

function classOf(result: { retryClass: RetryClass; retryAfterSeconds?: number }): RetryClass {
  return result.retryClass;
}

/**
 * Everything that touches the Pinterest server modules runs inside `main()`,
 * loaded via dynamic `await import(...)` AFTER the env assignments above —
 * this codebase's convention (see test-pinterest-oauth.ts) for any module
 * that transitively pulls in connectionStore.ts's eager Supabase client
 * construction. A static top-level import is hoisted ahead of those
 * assignments under ESM/tsx semantics, which is exactly the failure this
 * structure avoids; a bare top-level `await import(...)` in turn forces an
 * ESM compile target that this package (CJS by default, no
 * `"type": "module"`) does not support standalone via `npx tsx`.
 */
async function main() {
const {
  classifyVideoEvidence,
  classifyDurableVideoResult,
  classifyPinterestApiError,
  computeNextAttemptAt,
  parseRetryAfterSeconds,
} = await import("../src/lib/server/publish/retryClassification");
const {
  PinterestApiError,
  PinterestTrialAccessError,
  NotConnectedError,
  NeedsReconnectError,
  MissingPinterestScopesError,
} = await import("../src/lib/server/pinterest/service");

function apiError(status: number, opts: { providerResourceId?: string; retryAfterSeconds?: number } = {}): PinterestApiErrorType {
  const err = new PinterestApiError("boom", status, "pinterest_api_error");
  err.providerStatus = status;
  if (opts.providerResourceId !== undefined) err.providerResourceId = opts.providerResourceId;
  if (opts.retryAfterSeconds !== undefined) err.retryAfterSeconds = opts.retryAfterSeconds;
  return err;
}

// ── P1 / P2 — 429 is retryable, not blocked_user (regression on §4.3 defect 1) ──
section("P1/P2 — 429 rate limit is retryable, never blocked_user");

{
  // Video: adapter classifies any 4xx as definite_rejection; 429 must be corrected here.
  const ev = videoEvidence({ stage: "registered", classification: "definite_rejection", providerStatus: 429 });
  const result = classifyVideoEvidence(ev, 120);
  check("P1 video: 429 + Retry-After becomes retryable", result.retryClass === "retryable", JSON.stringify(result));
  check("P1 video: retryAfterSeconds carried through", result.retryAfterSeconds === 120);
  check("P1 video: not blocked_user (the regression this guards)", result.retryClass !== "blocked_user");
}
{
  const ev = videoEvidence({ stage: "polled", classification: "definite_rejection", providerStatus: 429 });
  const result = classifyVideoEvidence(ev); // no Retry-After
  check("P2 video: 429 without Retry-After is still retryable", result.retryClass === "retryable");
  check("P2 video: retryAfterSeconds is absent, not a fabricated value", result.retryAfterSeconds === undefined);
}
{
  const result = classifyPinterestApiError(apiError(429, { retryAfterSeconds: 120 }));
  check("P1 image: 429 + Retry-After is retryable", result.kind === "classified" && classOf(result.result) === "retryable");
  check("P1 image: retryAfterSeconds carried through", result.kind === "classified" && result.result.retryAfterSeconds === 120);
}
{
  const result = classifyPinterestApiError(apiError(429));
  check("P2 image: 429 without Retry-After is retryable, backoff table applies", result.kind === "classified" && classOf(result.result) === "retryable");
}

// ── P3 — 401 is blocked_user, never advances attempt (attempt-advancement is task 3) ──
section("P3 — 401 is blocked_user");

{
  const ev = videoEvidence({ stage: "registered", classification: "definite_rejection", providerStatus: 401 });
  check("P3 video: 401 is blocked_user", classifyVideoEvidence(ev).retryClass === "blocked_user");
}
{
  // Image path: our own NeedsReconnectError models the 401/scope case by class, not status.
  const result = classifyPinterestApiError(new NeedsReconnectError());
  check("P3 image: NeedsReconnectError is blocked_user", result.kind === "classified" && classOf(result.result) === "blocked_user");
  const missingScopes = classifyPinterestApiError(new MissingPinterestScopesError(["boards:write"]));
  check("P3 image: MissingPinterestScopesError (extends NeedsReconnectError) is blocked_user",
    missingScopes.kind === "classified" && classOf(missingScopes.result) === "blocked_user");
}

// ── P4 — 403 / 404 board is blocked_user ─────────────────────────────────────
section("P4 — 403 / 404 board is blocked_user");

{
  const ev403 = videoEvidence({ stage: "registered", classification: "definite_rejection", providerStatus: 403 });
  const ev404 = videoEvidence({ stage: "registered", classification: "definite_rejection", providerStatus: 404 });
  check("P4 video: 403 is blocked_user", classifyVideoEvidence(ev403).retryClass === "blocked_user");
  check("P4 video: 404 (board) is blocked_user", classifyVideoEvidence(ev404).retryClass === "blocked_user");
}
{
  const result403 = classifyPinterestApiError(apiError(403));
  const result404 = classifyPinterestApiError(apiError(404));
  check("P4 image: 403 is blocked_user", result403.kind === "classified" && classOf(result403.result) === "blocked_user");
  check("P4 image: 404 (board) is blocked_user", result404.kind === "classified" && classOf(result404.result) === "blocked_user");
  check("P4 image: NotConnectedError is blocked_user",
    classifyPinterestApiError(new NotConnectedError()).kind === "classified"
    && classOf((classifyPinterestApiError(new NotConnectedError()) as { kind: "classified"; result: { retryClass: RetryClass } }).result) === "blocked_user");
}

// ── P5 — 400 field validation is blocked_user ────────────────────────────────
section("P5 — 400 invalid field is blocked_user");

{
  const ev = videoEvidence({ stage: "registered", classification: "definite_rejection", providerStatus: 400 });
  check("P5 video: 400 is blocked_user", classifyVideoEvidence(ev).retryClass === "blocked_user");
}
{
  const result = classifyPinterestApiError(apiError(400));
  check("P5 image: 400 is blocked_user", result.kind === "classified" && classOf(result.result) === "blocked_user");
}

// ── P6 — 500 at /media registration stage is retryable ───────────────────────
section("P6 — 500 during video registration is retryable (unsent)");

{
  const ev = videoEvidence({ stage: "registered", classification: "unknown", providerStatus: 500 });
  const result = classifyVideoEvidence(ev);
  check("P6: stage=registered + unknown is retryable", result.retryClass === "retryable", JSON.stringify(result));
}
{
  // uploaded / polled stages are the same "confirmed not yet at create-Pin" bucket.
  const uploaded = videoEvidence({ stage: "uploaded", classification: "unknown", providerStatus: 500 });
  const polled = videoEvidence({ stage: "polled", classification: "unknown" });
  check("P6b: stage=uploaded + unknown is retryable", classifyVideoEvidence(uploaded).retryClass === "retryable");
  check("P6c: stage=polled + unknown is retryable (idempotent GET)", classifyVideoEvidence(polled).retryClass === "retryable");
}

// ── P7 — 500 at POST /pins is reconciliation_required ────────────────────────
section("P7 — 500 at POST /pins (stage=created) is reconciliation_required");

{
  const ev = videoEvidence({ stage: "created", classification: "unknown", providerStatus: 500 });
  const result = classifyVideoEvidence(ev);
  check("P7 video: stage=created + unknown is reconciliation_required", result.retryClass === "reconciliation_required", JSON.stringify(result));
}
{
  // Image-path equivalent: 5xx with NO providerResourceId is retryable per §4.2
  // (image asymmetry vs. video is approved design, not a bug — see module header).
  const result = classifyPinterestApiError(apiError(500));
  check("P7 image: 5xx with no resourceId is retryable (approved image/video asymmetry)",
    result.kind === "classified" && classOf(result.result) === "retryable");
  // But a 5xx that DOES carry a resource id must still reconcile — resourceId wins unconditionally.
  const withResource = classifyPinterestApiError(apiError(500, { providerResourceId: "pin-123" }));
  check("P7b image: 5xx WITH providerResourceId is reconciliation_required (resourceId wins over status)",
    withResource.kind === "classified" && classOf(withResource.result) === "reconciliation_required");
}

// ── P8 — POST /pins connection drop (fetch throw) is reconciliation_required ──
section("P8 — connection dropped mid POST /pins is reconciliation_required");

{
  // videoPinAdapter.ts:416 — the create() catch block returns stage="created",
  // classification="unknown", no providerStatus at all.
  const ev = videoEvidence({ stage: "created", classification: "unknown" });
  const result = classifyVideoEvidence(ev);
  check("P8 video: fetch-throw during create (no providerStatus) is reconciliation_required", result.retryClass === "reconciliation_required");
}
{
  // Image-path equivalent: a generic Error with no providerStatus/providerResourceId at all.
  const result = classifyPinterestApiError(new Error("ECONNRESET"));
  check("P8 image: bare thrown error (no provider signal) is reconciliation_required", result.kind === "classified" && classOf(result.result) === "reconciliation_required");
}

// ── P9 — 201 with no `id` in body is reconciliation_required ─────────────────
section("P9 — 201 but no Pin id returned is reconciliation_required");

{
  // videoPinAdapter.ts:397-404 — 201 body missing `id` also yields stage="created", classification="unknown".
  const ev = videoEvidence({ stage: "created", classification: "unknown", providerStatus: undefined });
  const result = classifyVideoEvidence(ev);
  check("P9: created + unknown (malformed success body) is reconciliation_required", result.retryClass === "reconciliation_required");
}

// ── P10 — provider succeeded but settle RPC threw ─────────────────────────────
section("P10 — provider succeeded, settle RPC failed ⇒ delivery_unknown / reconcileRequired");

{
  const dispatchResult: DurableVideoPublishResult = {
    outcome: "delivery_unknown",
    retryAllowed: false,
    reconcileRequired: true,
    evidence: { reason: "provider_settlement_unavailable" },
  };
  const result = classifyDurableVideoResult(dispatchResult);
  check("P10: provider_settlement_unavailable is reconciliation_required", result.retryClass === "reconciliation_required", JSON.stringify(result));
}
{
  // The other two dispatch-layer "provider may have acted" reasons, same bucket.
  const boundary: DurableVideoPublishResult = { outcome: "delivery_unknown", retryAllowed: false, evidence: { reason: "provider_boundary_exception" } };
  const staleAttempt: DurableVideoPublishResult = { outcome: "delivery_unknown", retryAllowed: false, evidence: { reason: "process_loss_after_provider_attempt" } };
  check("P10b: provider_boundary_exception is reconciliation_required", classifyDurableVideoResult(boundary).retryClass === "reconciliation_required");
  check("P10c: process_loss_after_provider_attempt is reconciliation_required", classifyDurableVideoResult(staleAttempt).retryClass === "reconciliation_required");
  // materialization_incomplete never reached the provider — plain retry, not reconciliation.
  const notReached: DurableVideoPublishResult = { outcome: "failed", retryAllowed: true, evidence: { reason: "materialization_incomplete" } };
  check("P10d: materialization_incomplete (never reached provider) is retryable, not reconciliation_required",
    classifyDurableVideoResult(notReached).retryClass === "retryable");
}

// ── P17 — blocked_user repeated 3x never looks retryable/succeeded ───────────
section("P17 — blocked_user classification is stable across repeats (attempt-count non-advancement is task 3's RPC contract, not re-tested here)");

{
  const ev = videoEvidence({ stage: "registered", classification: "definite_rejection", providerStatus: 401 });
  const results = [classifyVideoEvidence(ev), classifyVideoEvidence(ev), classifyVideoEvidence(ev)];
  check("P17: three independent classifications of the same 401 evidence all agree: blocked_user",
    results.every(r => r.retryClass === "blocked_user"));
}
{
  const err = apiError(403);
  const results = [classifyPinterestApiError(err), classifyPinterestApiError(err), classifyPinterestApiError(err)];
  check("P17 image: three independent classifications of the same 403 all agree: blocked_user",
    results.every(r => r.kind === "classified" && r.result.retryClass === "blocked_user"));
}

// ── PinterestTrialAccessError — explicitly excluded from retry_class ──────────
section("PinterestTrialAccessError is not_applicable, not a RetryClass value");

{
  const result = classifyPinterestApiError(new PinterestTrialAccessError());
  check("trial access returns kind:'trial_access', not a classified RetryClass", result.kind === "trial_access");
}

// ── succeeded ──────────────────────────────────────────────────────────────
section("succeeded classification");

{
  const ev = videoEvidence({ stage: "created", classification: "succeeded", pinId: "p1" });
  check("succeeded video evidence classifies as succeeded", classifyVideoEvidence(ev).retryClass === "succeeded");
  const dispatchResult: DurableVideoPublishResult = { outcome: "published", retryAllowed: false };
  check("published dispatch result classifies as succeeded", classifyDurableVideoResult(dispatchResult).retryClass === "succeeded");
}

// ── validation failure (local, never reached provider) ────────────────────────
section("definite_validation is blocked_user (local, material/parameter problem)");

{
  const ev = videoEvidence({ stage: "validated", classification: "definite_validation" });
  check("definite_validation is blocked_user", classifyVideoEvidence(ev).retryClass === "blocked_user");
}

// ── Retry-After header parsing ────────────────────────────────────────────────
section("parseRetryAfterSeconds — delta-seconds and HTTP-date forms");

{
  check("delta-seconds parses to an integer", parseRetryAfterSeconds("120", () => 0) === 120);
  check("delta-seconds ignores leading/trailing whitespace", parseRetryAfterSeconds("  45  ", () => 0) === 45);
  check("zero delta-seconds is not a valid retry hint (must be positive)", parseRetryAfterSeconds("0", () => 0) === undefined);
  const nowMs = Date.UTC(2026, 8, 23, 0, 0, 0);
  // "-5" is not delta-seconds (the /^\d+$/ regex rejects the leading '-'), so it
  // falls to the Date.parse branch. V8's Date.parse is RFC-9110-non-compliant
  // permissive and accepts "-5" as a partial-ISO year (2001-05-01, per V8's own
  // extended year parsing) rather than rejecting it outright — but relative to
  // a realistic `now` in 2026, that resolves to a large NEGATIVE delta, so the
  // function's "delta must be positive" guard still correctly returns
  // undefined. This asserts the guard, not the (implementation-specific)
  // Date.parse behavior itself.
  check("negative-looking string never yields a positive retry delay", parseRetryAfterSeconds("-5", () => nowMs) === undefined);
  check("absent header is undefined", parseRetryAfterSeconds(null, () => nowMs) === undefined);
  check("empty header is undefined", parseRetryAfterSeconds("", () => nowMs) === undefined);
  check("garbage string is undefined", parseRetryAfterSeconds("not-a-date-or-number", () => nowMs) === undefined);

  const futureDate = new Date(nowMs + 90_000).toUTCString();
  check("HTTP-date 90s in the future resolves to ~90 seconds", parseRetryAfterSeconds(futureDate, () => nowMs) === 90);
  const pastDate = new Date(nowMs - 90_000).toUTCString();
  check("HTTP-date in the PAST is ignored (not a meaningful retry hint)", parseRetryAfterSeconds(pastDate, () => nowMs) === undefined);

  let nowCalls = 0;
  const countingNow = () => { nowCalls++; return nowMs; };
  parseRetryAfterSeconds("120", countingNow);
  check("delta-seconds form never invokes the now() thunk (lazy clock)", nowCalls === 0);
  parseRetryAfterSeconds(null, countingNow);
  check("absent header never invokes the now() thunk", nowCalls === 0);
}

// ── computeNextAttemptAt — backoff table, jitter bounds, Retry-After floor ────
section("computeNextAttemptAt — §4.1 backoff formula");

{
  const now = Date.UTC(2026, 8, 23, 0, 0, 0);
  // random()=0 ⇒ jitterFactor=0.8 (lower bound); random()=1 ⇒ 1.2 (upper bound, exclusive in practice).
  const attempt1Low = computeNextAttemptAt(1, undefined, now, () => 0);
  const attempt1High = computeNextAttemptAt(1, undefined, now, () => 0.999999);
  check("attempt 1→2 backoff lower bound is base*0.8 = 48s", attempt1Low?.getTime() === now + 48_000, String(attempt1Low));
  check("attempt 1→2 backoff upper bound approaches base*1.2 = 72s", Math.abs((attempt1High?.getTime() ?? 0) - (now + 72_000)) < 100);

  const attempt2 = computeNextAttemptAt(2, undefined, now, () => 0.5); // jitterFactor = 1.0
  check("attempt 2→3 backoff at jitterFactor=1.0 is exactly base=5min", attempt2?.getTime() === now + 5 * 60_000);

  const attempt3 = computeNextAttemptAt(3, undefined, now, () => 0.5);
  check("attempt 3→4 backoff at jitterFactor=1.0 is exactly base=15min", attempt3?.getTime() === now + 15 * 60_000);

  const attempt4 = computeNextAttemptAt(4, undefined, now, () => 0.5);
  check("attempt 4→5 backoff at jitterFactor=1.0 is exactly base=60min", attempt4?.getTime() === now + 60 * 60_000);

  check("attempt 5 (already at cap) has no next attempt to schedule", computeNextAttemptAt(5, undefined, now) === null);
  check("attempt 0 is invalid", computeNextAttemptAt(0, undefined, now) === null);
  check("attempt 6 is invalid (beyond the 5-attempt cap)", computeNextAttemptAt(6, undefined, now) === null);
  check("non-integer attempt is invalid", computeNextAttemptAt(1.5, undefined, now) === null);
}
{
  // P1's Retry-After-floor case: 120s Retry-After vs. attempt-1 backoff (max 72s
  // jittered) — the floor must win because it exceeds every possible jittered value.
  const now = Date.UTC(2026, 8, 23, 0, 0, 0);
  const withFloor = computeNextAttemptAt(1, 120, now, () => 0.999999); // even the jitter upper bound (~72s) < 120s
  check("Retry-After floor (120s) exceeds attempt-1's max jittered backoff (~72s) and wins",
    withFloor?.getTime() === now + 120_000, String(withFloor));

  // Retry-After only ever pushes LATER, never earlier: a short Retry-After
  // must not shrink a longer base backoff.
  const shortRetryAfter = computeNextAttemptAt(4, 30, now, () => 0.5); // base=60min far exceeds a 30s floor
  check("a short Retry-After never shrinks a longer base backoff (only ever pushes later)",
    shortRetryAfter?.getTime() === now + 60 * 60_000, String(shortRetryAfter));

  check("retryAfterSeconds=0 is not a valid floor (non-positive, ignored)",
    computeNextAttemptAt(1, 0, now, () => 0.5)?.getTime() === now + 1 * 60_000 * 1.0);
  check("negative retryAfterSeconds is ignored",
    computeNextAttemptAt(1, -10, now, () => 0.5)?.getTime() === now + 1 * 60_000 * 1.0);
}

console.log(`\nPublish retry classification: ${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
