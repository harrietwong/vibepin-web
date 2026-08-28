/**
 * Shared helpers for the internal /api/pinterest/* JSON routes.
 * Maps Pinterest/connection errors to safe HTTP responses (no credentials leaked).
 */

import {
  PinterestApiError,
  NeedsReconnectError,
  NotConnectedError,
} from "./service";
import { ConfigurationError, DatabaseError } from "./errors";

export type ErrorBody = {
  error: string;
  code: string;
  needsReconnect?: boolean;
  pinterestCode?: string;
  /** Caller-supplied extras merged in by `pinterestErrorResponse`'s `extra` param
   *  (e.g. the immediate-publish `meteringBucket`/`meteringBucketSig`). */
  [key: string]: unknown;
};

const SAFE_MESSAGES: Record<string, string> = {
  database_error: "Pinterest connection could not be loaded. Please try again or open Integrations to check your connection.",
  configuration_error: "Pinterest is not configured on the server. Contact support if this persists.",
  internal_error: "Pinterest connection could not be loaded. Please try again or open Integrations to check your connection.",
};

/**
 * Translate a thrown error into a safe JSON Response.
 *
 * `extra` is merged onto every branch's JSON body without changing status, code, or
 * any other field — it exists so a caller with additional context to relay (e.g.
 * /api/pinterest/pins's server-minted `meteringBucket`/`meteringBucketSig`, which
 * must reach the client even when publish fails with an unexpected error) does not
 * have to re-implement this function's branching just to add one field.
 */
export function pinterestErrorResponse(err: unknown, extra?: Record<string, unknown>): Response {
  if (err instanceof NotConnectedError) {
    return Response.json(
      { error: err.message, code: err.code, ...extra } satisfies ErrorBody,
      { status: 409 },
    );
  }
  if (err instanceof NeedsReconnectError) {
    return Response.json(
      { error: err.message, code: err.code, needsReconnect: true, ...extra } satisfies ErrorBody,
      { status: 401 },
    );
  }
  if (err instanceof DatabaseError) {
    console.error("[pinterest] database error:", err.message);
    return Response.json(
      { error: SAFE_MESSAGES.database_error, code: err.code, ...extra } satisfies ErrorBody,
      { status: 503 },
    );
  }
  if (err instanceof ConfigurationError) {
    console.error("[pinterest] configuration error:", err.message);
    return Response.json(
      { error: SAFE_MESSAGES.configuration_error, code: err.code, ...extra } satisfies ErrorBody,
      { status: 500 },
    );
  }
  if (err instanceof PinterestApiError) {
    const status = err.status >= 400 && err.status < 600 ? err.status : 502;
    const body: ErrorBody = { error: err.message, code: err.code || "pinterest_api_error", ...extra };
    if (err.pinterestApiCode !== undefined) body.pinterestCode = err.pinterestApiCode;
    return Response.json(body, { status });
  }
  console.error("[pinterest] unexpected error:", (err as Error)?.message);
  return Response.json(
    { error: SAFE_MESSAGES.internal_error, code: "internal_error", ...extra } satisfies ErrorBody,
    { status: 500 },
  );
}

export function unauthorized(): Response {
  return Response.json(
    { error: "Unauthorized — include Authorization: Bearer <token>", code: "unauthorized" },
    { status: 401 },
  );
}
