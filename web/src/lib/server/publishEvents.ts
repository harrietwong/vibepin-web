/**
 * publishEvents.ts — server-side Pinterest publish instrumentation.
 *
 * Emits three events (`pinterest_publish_attempted` / `_succeeded` / `_failed`) into
 * the `analytics_events` table (migration v41) so the admin Action Center / activation
 * funnel can read EXACT, event-based publish outcomes instead of INFERRING them from a
 * draft's postedAt. All three events of one publish share a `publishAttemptId` (uuid),
 * and every event carries `draftId` so a consumer can join back to the draft.
 *
 * HARD BOUNDARY — analytics is strictly best-effort and MUST NOT change publish behavior:
 *   - A write failure can never turn a successful publish into a failure, never mask or
 *     replace the original Pinterest error, and never add meaningful latency.
 *   - Every write is wrapped in try/catch; the worst outcome is a console.warn.
 *   - NEVER persist tokens, Authorization headers, cookies, or raw third-party responses.
 *     Failed events store only a sanitized error code + message (see sanitizeErrorMessage).
 *
 * The DB write itself is small: one insert into analytics_events, fired without awaiting
 * on the hot path where the caller does not need to block (see recordPublishEvent).
 */

import type { createServerClient } from "@/lib/supabase";

/** Where the publish was initiated. 'unknown' is the never-block fallback. */
export type PublishEventSource = "immediate" | "scheduled-cron" | "unknown";

/** The three event names, kept together so consumers import one source of truth. */
export const PUBLISH_EVENT_ATTEMPTED = "pinterest_publish_attempted";
export const PUBLISH_EVENT_SUCCEEDED = "pinterest_publish_succeeded";
export const PUBLISH_EVENT_FAILED = "pinterest_publish_failed";

export type PublishEventName =
  | typeof PUBLISH_EVENT_ATTEMPTED
  | typeof PUBLISH_EVENT_SUCCEEDED
  | typeof PUBLISH_EVENT_FAILED;

/** Fields shared by all three events, carried through the whole publish attempt. */
export interface PublishEventBase {
  /** uuid tying attempted → succeeded/failed for ONE publish. */
  publishAttemptId: string;
  userId: string;
  /** pinDraftStore id when known (nullable — immediate path may omit it). */
  draftId: string | null;
  boardId: string;
  source: PublishEventSource;
}

/** `pinterest_publish_attempted` props — the base, nothing else. */
export type PublishAttemptedProps = PublishEventBase;

/** `pinterest_publish_succeeded` props — base + timing + the remote Pin. */
export interface PublishSucceededProps extends PublishEventBase {
  durationMs: number;
  remotePinId: string;
  remotePinUrl: string;
}

/** `pinterest_publish_failed` props — base + timing + a SANITIZED error. */
export interface PublishFailedProps extends PublishEventBase {
  durationMs: number;
  /** Stable, non-sensitive code (e.g. "needs_reconnect", "board_not_owned"). */
  errorCode: string;
  /** Sanitized, length-capped message (see sanitizeErrorMessage). */
  errorMessage: string;
}

/** The payload jsonb we store, minus the columns broken out (user_id/draft_id/event_name). */
type StoredPayload = Record<string, string | number | boolean | null>;

/** Cap for the stored error message (chars). Downstream display only. */
export const MAX_ERROR_MESSAGE_LENGTH = 300;

/**
 * Strip credential-shaped substrings and hard-cap the length of an error message so it
 * is safe to store. Pure and unit-tested.
 *
 * Redacts:
 *   - `Bearer <token>` / `token=<...>` / `access_token=<...>` style pairs,
 *   - `Authorization: <...>` header echoes,
 *   - long base64/hex-ish runs (≥ 24 chars) that look like keys/tokens even when not
 *     labelled (Pinterest/JWT/opaque credentials).
 * Then trims and truncates to MAX_ERROR_MESSAGE_LENGTH (adding an ellipsis marker).
 *
 * It is deliberately conservative about false positives on long hex/base64 runs — a
 * redacted diagnostic is always preferable to a leaked secret.
 */
export function sanitizeErrorMessage(input: unknown): string {
  let msg = typeof input === "string" ? input : String(input ?? "");

  // `Bearer <token>` (Authorization values) → keep the scheme, drop the credential.
  // Runs BEFORE the key=value rule so an `Authorization: Bearer …` header keeps the scheme
  // rather than having `Bearer` swallowed as the header value.
  msg = msg.replace(/\bBearer\s+[A-Za-z0-9._~+/-]{6,}=*/gi, "Bearer [REDACTED]");

  // key=value credential pairs: token / access_token / refresh_token / api_key / apikey /
  // secret / password. Value may be quoted. Authorization is intentionally NOT here — its
  // Bearer form is handled above and its non-Bearer form by the header rule below (so we
  // never turn "Authorization: Bearer [REDACTED]" into "Authorization: [REDACTED]").
  msg = msg.replace(
    /\b(access_token|refresh_token|token|api[_-]?key|apikey|client_secret|secret|password)\b(\s*[:=]\s*)["']?[^\s"'&,;]+["']?/gi,
    "$1$2[REDACTED]",
  );

  // `Authorization: <non-Bearer token>` header echo → keep the header name only. Skips
  // values that begin with a scheme word (Bearer/Basic) since those are already handled.
  msg = msg.replace(
    /\b(authorization)(\s*:\s*)(?!Bearer\b|Basic\b|\[REDACTED\])["']?[^\s"'&,;]+["']?/gi,
    "$1$2[REDACTED]",
  );

  // Bare long token-ish runs (base64url / hex): 24+ chars of [A-Za-z0-9._-] with at least
  // one digit AND one letter (so plain words / sentences are not eaten). Redact wholesale.
  msg = msg.replace(/\b(?=[A-Za-z0-9._-]*[0-9])(?=[A-Za-z0-9._-]*[A-Za-z])[A-Za-z0-9._-]{24,}=*\b/g, "[REDACTED]");

  msg = msg.trim();
  if (msg.length > MAX_ERROR_MESSAGE_LENGTH) {
    msg = msg.slice(0, MAX_ERROR_MESSAGE_LENGTH - 1).trimEnd() + "…";
  }
  return msg;
}

/**
 * Pull a stable error code off a thrown value or a typed validation result. Prefers an
 * explicit string `.code` (Pinterest error classes + validation results carry one); falls
 * back to the constructor name (snake-cased) or "unknown". Pure and unit-tested. Never
 * reads message contents (those go through sanitizeErrorMessage separately).
 */
export function extractErrorCode(err: unknown): string {
  if (err && typeof err === "object") {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" && code.trim()) return code.trim();
    const name = (err as { name?: unknown }).name;
    if (typeof name === "string" && name.trim() && name !== "Error") {
      return name
        .replace(/Error$/, "")
        .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
        .toLowerCase() || "unknown";
    }
  }
  return "unknown";
}

/** Generate a fresh publishAttemptId. Isolated so tests / callers share one source. */
export function newPublishAttemptId(): string {
  return crypto.randomUUID();
}

/** Flatten a base + extras into the analytics payload (drafts/user/board join keys). */
function buildPayload(name: PublishEventName, props: PublishEventBase & Record<string, unknown>): StoredPayload {
  const payload: StoredPayload = {
    publishAttemptId: props.publishAttemptId,
    boardId: props.boardId,
    source: props.source,
  };
  // Copy only the primitive extras (durationMs / remotePin* / error*); never spread an
  // arbitrary object so a caller can't accidentally park a token in the payload.
  for (const key of ["durationMs", "remotePinId", "remotePinUrl", "errorCode", "errorMessage"] as const) {
    const v = (props as Record<string, unknown>)[key];
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") payload[key] = v;
  }
  return payload;
}

type ServerClient = ReturnType<typeof createServerClient>;

/**
 * Insert one publish event into analytics_events. BEST-EFFORT: any failure is swallowed
 * with a console.warn — it never throws, so a caller can `await` it without risking that
 * an analytics problem surfaces as a publish problem. Callers on a latency-sensitive path
 * SHOULD NOT await (fire-and-forget); the promise is still safe if they do.
 *
 * `db` is the service-role client (createServerClient) — analytics_events is service-role
 * only (RLS with no permissive policies).
 */
export async function recordPublishEvent(
  db: ServerClient | null,
  name: PublishEventName,
  props: PublishAttemptedProps | PublishSucceededProps | PublishFailedProps,
): Promise<void> {
  try {
    // Null client = the caller could not construct one (missing service-role env).
    // Analytics silently degrades; publish must proceed untouched.
    if (!db) {
      console.warn(`[publishEvents] no service client — dropped ${name}`);
      return;
    }
    const payload = buildPayload(name, props as PublishEventBase & Record<string, unknown>);
    const { error } = await db.from("analytics_events").insert({
      workspace_id: props.userId, // effective workspace = vibepin user today (matches v41 note)
      user_id: props.userId,
      draft_id: props.draftId,
      event_name: name,
      payload,
    });
    if (error) console.warn(`[publishEvents] insert ${name} failed:`, error.message);
  } catch (err) {
    // Never let an analytics write escape as a publish failure.
    console.warn(`[publishEvents] insert ${name} threw:`, err instanceof Error ? err.message : String(err));
  }
}

/**
 * Convenience wrapper: build the failed-event props AND record them, with the props
 * construction ALSO inside the try/catch. buildFailedProps is provably total (only string
 * ops on coerced values), but recording failures happens on the publish error path where a
 * masked error would be worst — so this belt-and-suspenders keeps even a hypothetical throw
 * in props-building from ever escaping onto the publish path. Best-effort; never throws.
 */
export async function recordFailedPublishEvent(
  db: ServerClient | null,
  base: PublishEventBase,
  durationMs: number,
  err: unknown,
): Promise<void> {
  try {
    await recordPublishEvent(db, PUBLISH_EVENT_FAILED, buildFailedProps(base, durationMs, err));
  } catch (e) {
    console.warn("[publishEvents] recordFailedPublishEvent threw:", e instanceof Error ? e.message : String(e));
  }
}

/**
 * Build the `pinterest_publish_failed` props from a thrown error or typed validation
 * failure, applying extractErrorCode + sanitizeErrorMessage. Pure (no DB) so tests can
 * assert the sanitized shape directly.
 */
export function buildFailedProps(
  base: PublishEventBase,
  durationMs: number,
  err: unknown,
): PublishFailedProps {
  const rawMessage =
    err && typeof err === "object" && typeof (err as { message?: unknown }).message === "string"
      ? (err as { message: string }).message
      : typeof err === "string"
        ? err
        : "Publish failed";
  return {
    ...base,
    durationMs,
    errorCode: extractErrorCode(err),
    errorMessage: sanitizeErrorMessage(rawMessage),
  };
}
