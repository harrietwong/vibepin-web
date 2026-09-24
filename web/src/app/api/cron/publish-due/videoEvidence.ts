/**
 * videoEvidence.ts — read a durable video dispatch's evidence back out safely.
 *
 * ── THE FORENSIC BREAK THIS CLOSES ─────────────────────────────────────────────
 * `dispatchSupabaseV76PinterestVideo` returns the adapter's real evidence — stage,
 * providerStatus, providerCode, requestId, mediaId, providerMessage — for every
 * failure it observes. The cron route used to throw all of it away and write a fixed
 * string, "Pinterest rejected the video publish.", plus a HARDCODED
 * `classifyDelivery({ providerStatus: 400 })`. Fourteen genuine Pinterest HTTP 400s
 * (2026-09-21 onwards) were therefore indistinguishable from each other and from a
 * dispatch-layer failure that never reached Pinterest at all: the response body was
 * never persisted anywhere, so the root cause could not be located from the data we
 * had. See `docs/coordination/0923-Pinterest视频发布故障-定位与修复方案-v1.0.md` 故障 B.
 *
 * ── WHY THIS RE-VALIDATES ALREADY-SANITIZED VALUES ─────────────────────────────
 * The adapter sanitizes at the provider boundary, and on the live-dispatch path that
 * is the object we get. But `DurableVideoPublishResult.evidence` is typed
 * `Record<string, unknown>` and on the REPLAY paths it is whatever `inspect` read out
 * of `publish_provider_attempts` — a database row, written by an earlier process,
 * possibly an earlier deployment. That is a separate trust boundary, so every field
 * is put back through the adapter's own predicates (imported, not re-implemented:
 * two copies of a redaction rule is one copy that will drift) before it can reach a
 * merchant-visible string.
 *
 * ── WHAT IS DELIBERATELY *NOT* HERE ────────────────────────────────────────────
 *  · `providerMessage` never enters `AttemptEvidence`. That type is five keys on
 *    purpose (see attemptLedger.ts) so there is exactly one evidence shape in the
 *    codebase; the message is a display concern and goes only into the result row's
 *    error text.
 *  · Nothing here flows to the v81 settle RPC, whose evidence keys are whitelisted.
 *    This module reads a dispatch RESULT; it never builds settle input.
 */

import {
  safeEvidenceId,
  safeProviderCode,
  safeProviderMessage,
} from "@/lib/server/pinterest/videoPinAdapter";
import type { AttemptEvidence } from "./attemptLedger";

/** Longest merchant-visible failure string this module will produce. */
const MAX_ERROR_LENGTH = 400;
/**
 * Request ids are for correlation, not reading: enough characters to grep a provider
 * log with, and not so many that a 128-character id crowds out the provider's own
 * message. Ids at or below this length are shown whole — truncating a short one adds
 * an ellipsis and no safety.
 */
const REQUEST_ID_DISPLAY_LENGTH = 16;

export type DurableVideoEvidence = {
  stage?: string;
  providerStatus?: number;
  providerCode?: string;
  requestId?: string;
  mediaId?: string;
  providerMessage?: string;
  /** The orchestration layer's own reason, when the failure never reached the adapter. */
  reason?: string;
};

function safeStage(value: unknown): string | undefined {
  // The adapter's five stage names and nothing else. An unrecognized stage is a
  // sign the row was not written by code we know; it is dropped rather than shown.
  return value === "validated" || value === "registered" || value === "uploaded"
    || value === "polled" || value === "created"
    ? value
    : undefined;
}

function safeStatus(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599
    ? value
    : undefined;
}

/**
 * Re-validate one dispatch result's evidence. Every field is independently optional:
 * a dispatch-layer failure (`materialization_incomplete`) carries only `reason`, a
 * replayed `failed` attempt carries nothing at all, and a real provider rejection
 * carries most of them. Absent is always represented as absent — never as a
 * placeholder — so a caller can tell "Pinterest said 400" from "we never asked".
 */
export function readDurableVideoEvidence(raw: unknown): DurableVideoEvidence {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const value = raw as Record<string, unknown>;
  const stage = safeStage(value.stage);
  const providerStatus = safeStatus(value.providerStatus);
  const providerCode = safeProviderCode(value.providerCode);
  const requestId = safeEvidenceId(value.requestId);
  const mediaId = safeEvidenceId(value.mediaId);
  const providerMessage = safeProviderMessage(value.providerMessage);
  const reason = safeProviderCode(value.reason);
  return {
    ...(stage ? { stage } : {}),
    ...(providerStatus !== undefined ? { providerStatus } : {}),
    ...(providerCode ? { providerCode } : {}),
    ...(requestId ? { requestId } : {}),
    ...(mediaId ? { mediaId } : {}),
    ...(providerMessage ? { providerMessage } : {}),
    ...(reason ? { reason } : {}),
  };
}

/**
 * The five diagnostic fields the v82 attempt ledger stores, drawn from a real
 * dispatch instead of from constants.
 *
 * `fallback` supplies what the evidence itself cannot: a stage for a failure that
 * never entered the adapter, and a `providerCode` for a dispatch-layer reason
 * (`materialization_incomplete`, `provider_boundary_exception`, …). The fallback is
 * only consulted when the real value is absent, so a genuine provider code always
 * wins — which is the entire point of the change.
 */
export function attemptEvidenceFrom(
  evidence: DurableVideoEvidence,
  fallback: { stage?: string; providerCode?: string } = {},
): AttemptEvidence | undefined {
  const providerCode = evidence.providerCode ?? evidence.reason ?? fallback.providerCode;
  const stage = evidence.stage ?? fallback.stage;
  const result: AttemptEvidence = {
    ...(stage ? { stage } : {}),
    ...(evidence.providerStatus !== undefined ? { providerStatus: evidence.providerStatus } : {}),
    ...(providerCode ? { providerCode } : {}),
    ...(evidence.requestId ? { requestId: evidence.requestId } : {}),
    ...(evidence.mediaId ? { mediaId: evidence.mediaId } : {}),
  };
  // `undefined` rather than `{}`: `recordAttempt` stores `{}` for "no evidence", and
  // an empty object written explicitly says the same thing. Returning undefined keeps
  // the two spellings from both appearing in the table.
  return Object.keys(result).length ? result : undefined;
}

/**
 * One merchant-visible failure line that a support engineer can act on.
 *
 * The lead sentence is the caller's (it names what happened — a rejection, an
 * unresolved delivery); everything appended here is observed fact. When nothing was
 * observed the line is exactly the lead sentence, i.e. the string this route has
 * always written — a dispatch-layer failure does not grow a fake HTTP status.
 */
export function describeVideoEvidence(lead: string, evidence: DurableVideoEvidence): string {
  const parts: string[] = [];
  if (evidence.providerStatus !== undefined) parts.push(`HTTP ${evidence.providerStatus}`);
  if (evidence.providerCode) parts.push(`code ${evidence.providerCode}`);
  else if (evidence.reason) parts.push(`reason ${evidence.reason}`);
  if (evidence.stage) parts.push(`stage ${evidence.stage}`);
  if (evidence.requestId) {
    const shown = evidence.requestId.length > REQUEST_ID_DISPLAY_LENGTH
      ? `${evidence.requestId.slice(0, REQUEST_ID_DISPLAY_LENGTH)}…`
      : evidence.requestId;
    parts.push(`request ${shown}`);
  }
  const head = parts.length ? `${lead.replace(/\.$/, "")} (${parts.join(", ")})` : lead;
  const full = evidence.providerMessage
    ? `${head.replace(/\.$/, "")}: ${evidence.providerMessage}`
    : head;
  return full.length > MAX_ERROR_LENGTH ? `${full.slice(0, MAX_ERROR_LENGTH - 1)}…` : full;
}
