/**
 * Injectable, provider-boundary adapter for Pinterest video Pins.
 *
 * This module deliberately knows nothing about routes, durable attempts, storage,
 * or retries. Its caller supplies one already-authorized account/token pair and a
 * private video Blob. Network uncertainty becomes an explicit `unknown` result so
 * a durable orchestration layer can reconcile before it considers another dispatch.
 */

import { isValidCoverFrameTime, videoCoverFrameSeconds } from "@/lib/videoCoverFrame";

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type PinterestVideoAdapterDependencies = {
  fetch: FetchLike;
  sleep: (milliseconds: number) => Promise<void>;
  now: () => number;
  apiBase: string;
  pollIntervalMs?: number;
  pollDeadlineMs?: number;
};

export type PinterestVideoPublishInput = {
  /** One account's token. The adapter uses this exact value for register, poll, and create. */
  accessToken: string;
  /** Identity already pinned by the caller; validated here but never sent to Pinterest. */
  accountId: string;
  boardId: string;
  title?: string;
  description?: string;
  link?: string;
  altText?: string;
  /** Provider bytes; never returned, logged, or put in evidence. */
  file: Blob;
  fileName?: string;
  coverFrameTimeMs?: number;
  durationMs?: number;
};

export type PinterestVideoEvidence = {
  stage: "validated" | "registered" | "uploaded" | "polled" | "created";
  classification: "succeeded" | "definite_validation" | "definite_rejection" | "unknown";
  mediaId?: string;
  pinId?: string;
  pinUrl?: string;
  requestId?: string;
};

export type PinterestVideoPublishResult =
  | { outcome: "succeeded"; evidence: PinterestVideoEvidence }
  | { outcome: "failed"; evidence: PinterestVideoEvidence }
  | { outcome: "unknown"; evidence: PinterestVideoEvidence };

type RegisteredMedia = {
  mediaId: string;
  uploadUrl: string;
  uploadParameters: Array<readonly [string, string]>;
  sensitiveValues: ReadonlySet<string>;
};

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_POLL_DEADLINE_MS = 120_000;
const NO_SENSITIVE_VALUES: ReadonlySet<string> = new Set();

class PollDeadlineExceeded extends Error {}

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function safeId(value: unknown): string | undefined {
  const id = cleanText(value);
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id) ? id : undefined;
}

function containsSensitiveValue(value: string, sensitiveValues: ReadonlySet<string>): boolean {
  // A provider form can validly contain low-entropy values such as "a" or "p".
  // Exact matching protects those values without suppressing every unrelated ID
  // containing one of their characters; substantial opaque values must never be
  // allowed as a substring of an echoed identifier or URL path.
  return [...sensitiveValues].some(secret =>
    secret.length > 0 && (value === secret || (secret.length >= 8 && value.includes(secret))),
  );
}

function safeEvidenceId(value: unknown, sensitiveValues: ReadonlySet<string>): string | undefined {
  const id = safeId(value);
  return id && !containsSensitiveValue(id, sensitiveValues) ? id : undefined;
}

function safeRequestId(response: Response, sensitiveValues: ReadonlySet<string>): string | undefined {
  return safeEvidenceId(
    response.headers.get("x-pinterest-rid")
    ?? response.headers.get("x-request-id")
    ?? response.headers.get("x-amzn-requestid"),
    sensitiveValues,
  );
}

function safePinUrl(value: unknown, pinId: string | undefined, sensitiveValues: ReadonlySet<string>): string | undefined {
  const raw = cleanText(value);
  if (!raw || raw.length > 2_048 || !pinId || containsSensitiveValue(raw, sensitiveValues)) return undefined;
  const canonical = `https://www.pinterest.com/pin/${encodeURIComponent(pinId)}/`;
  return raw === canonical ? canonical : undefined;
}

function evidence(
  stage: PinterestVideoEvidence["stage"],
  classification: PinterestVideoEvidence["classification"],
  values: Omit<PinterestVideoEvidence, "stage" | "classification"> = {},
  sensitiveValues: ReadonlySet<string> = NO_SENSITIVE_VALUES,
): PinterestVideoEvidence {
  const mediaId = safeEvidenceId(values.mediaId, sensitiveValues);
  const pinId = safeEvidenceId(values.pinId, sensitiveValues);
  const requestId = safeEvidenceId(values.requestId, sensitiveValues);
  const pinUrl = safePinUrl(values.pinUrl, pinId, sensitiveValues);
  return {
    stage,
    classification,
    ...(mediaId ? { mediaId } : {}),
    ...(pinId ? { pinId } : {}),
    ...(pinUrl ? { pinUrl } : {}),
    ...(requestId ? { requestId } : {}),
  };
}

function validationResult(): PinterestVideoPublishResult {
  return { outcome: "failed", evidence: evidence("validated", "definite_validation") };
}

function responseResult(
  response: Response,
  stage: PinterestVideoEvidence["stage"],
  mediaId?: string,
  sensitiveValues: ReadonlySet<string> = NO_SENSITIVE_VALUES,
): PinterestVideoPublishResult {
  const classification = response.status >= 400 && response.status < 500 ? "definite_rejection" : "unknown";
  return {
    outcome: classification === "definite_rejection" ? "failed" : "unknown",
    evidence: evidence(stage, classification, {
      ...(mediaId ? { mediaId } : {}),
      ...(safeRequestId(response, sensitiveValues) ? { requestId: safeRequestId(response, sensitiveValues) } : {}),
    }, sensitiveValues),
  };
}

async function safeJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const json = await response.json();
    return json && typeof json === "object" && !Array.isArray(json) ? json as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function validUploadParameters(value: unknown): Array<readonly [string, string]> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result: Array<readonly [string, string]> = [];
  for (const [key, item] of Object.entries(value)) {
    if (!key || typeof item !== "string") return null;
    // Preserve each own provider field verbatim, including keys such as __proto__.
    result.push([key, item]);
  }
  return result;
}

function sensitiveRegistrationValues(token: string, uploadUrl: string, rawUploadParameters: unknown): ReadonlySet<string> {
  const values = [token, uploadUrl];
  if (rawUploadParameters && typeof rawUploadParameters === "object" && !Array.isArray(rawUploadParameters)) {
    for (const value of Object.values(rawUploadParameters)) {
      if (typeof value === "string") values.push(value);
    }
  }
  return new Set(values);
}

async function withinPollDeadline<T>(
  deadline: number,
  deps: PinterestVideoAdapterDependencies,
  operation: (signal: AbortSignal | undefined) => Promise<T>,
  remainingMs = deadline - deps.now(),
  existingController?: AbortController,
): Promise<T> {
  if (remainingMs <= 0) throw new PollDeadlineExceeded();
  const controller = existingController ?? (typeof AbortController === "undefined" ? undefined : new AbortController());
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller?.abort();
      reject(new PollDeadlineExceeded());
    }, remainingMs);
  });
  try {
    return await Promise.race([operation(controller?.signal), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function validInput(input: PinterestVideoPublishInput, deps: PinterestVideoAdapterDependencies): boolean {
  return !!(
    cleanText(input.accessToken)
    && cleanText(input.accountId)
    && cleanText(input.boardId)
    && input.file instanceof Blob
    && input.file.size > 0
    && cleanText(deps.apiBase)
    && Number.isFinite(deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS)
    && (deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS) >= 0
    && Number.isFinite(deps.pollDeadlineMs ?? DEFAULT_POLL_DEADLINE_MS)
    && (deps.pollDeadlineMs ?? DEFAULT_POLL_DEADLINE_MS) >= 0
  );
}

function apiUrl(apiBase: string, pathname: string): string {
  return `${apiBase.replace(/\/+$/, "")}${pathname}`;
}

function authenticatedHeaders(accessToken: string, json = false): HeadersInit {
  return {
    Authorization: `Bearer ${accessToken}`,
    ...(json ? { "Content-Type": "application/json" } : {}),
  };
}

/**
 * Register, upload, wait for processing, and create one video Pin.
 *
 * The result is intentionally a compact receipt, not a provider error wrapper:
 * no token, multipart values, presigned URL, response body, or file data can cross
 * this boundary. A 4xx/explicit provider failure is definite; network/5xx/deadline
 * states are unknown because the caller cannot safely infer whether Pinterest acted.
 */
export async function publishPinterestVideo(
  input: PinterestVideoPublishInput,
  deps: PinterestVideoAdapterDependencies,
): Promise<PinterestVideoPublishResult> {
  if (!validInput(input, deps)) return validationResult();
  if (input.coverFrameTimeMs !== undefined && !isValidCoverFrameTime(input.coverFrameTimeMs, input.durationMs)) return validationResult();

  const token = cleanText(input.accessToken);
  const tokenSensitiveValues = new Set([token]);
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const pollDeadlineMs = deps.pollDeadlineMs ?? DEFAULT_POLL_DEADLINE_MS;

  let registered: RegisteredMedia;
  try {
    const registerResponse = await deps.fetch(apiUrl(deps.apiBase, "/media"), {
      method: "POST",
      headers: authenticatedHeaders(token, true),
      body: JSON.stringify({ media_type: "video" }),
    });
    if (!registerResponse.ok) return responseResult(registerResponse, "registered", undefined, tokenSensitiveValues);
    const body = await safeJson(registerResponse);
    const mediaId = safeId(body?.media_id);
    const uploadUrl = cleanText(body?.upload_url);
    const uploadParameters = validUploadParameters(body?.upload_parameters);
    // Gather all recognizable response values before validating the response shape:
    // a malformed registration is still untrusted provider input and may echo secrets
    // in its request id.
    const sensitiveValues = sensitiveRegistrationValues(token, uploadUrl, body?.upload_parameters);
    if (!mediaId || !uploadUrl || !uploadParameters) {
      return {
        outcome: "unknown",
        evidence: evidence("registered", "unknown", {
          ...(safeRequestId(registerResponse, sensitiveValues) ? { requestId: safeRequestId(registerResponse, sensitiveValues) } : {}),
        }, sensitiveValues),
      };
    }
    if (containsSensitiveValue(mediaId, sensitiveValues)) {
      return { outcome: "unknown", evidence: evidence("registered", "unknown", {}, sensitiveValues) };
    }
    registered = { mediaId, uploadUrl, uploadParameters, sensitiveValues };
  } catch {
    return { outcome: "unknown", evidence: evidence("registered", "unknown") };
  }

  try {
    const form = new FormData();
    // Object.entries preserves the property insertion order Pinterest supplied.
    for (const [key, value] of registered.uploadParameters) form.append(key, value);
    form.append("file", input.file, cleanText(input.fileName) || "video.mp4");
    const uploadResponse = await deps.fetch(registered.uploadUrl, { method: "POST", body: form });
    if (uploadResponse.status !== 204) return responseResult(uploadResponse, "uploaded", registered.mediaId, registered.sensitiveValues);
  } catch {
    return { outcome: "unknown", evidence: evidence("uploaded", "unknown", { mediaId: registered.mediaId }, registered.sensitiveValues) };
  }

  const deadline = deps.now() + pollDeadlineMs;
  while (true) {
    if (deadline - deps.now() <= 0) {
      return { outcome: "unknown", evidence: evidence("polled", "unknown", { mediaId: registered.mediaId }, registered.sensitiveValues) };
    }
    let pollResponse: Response;
    const pollController = typeof AbortController === "undefined" ? undefined : new AbortController();
    try {
      pollResponse = await withinPollDeadline(deadline, deps, (signal) => deps.fetch(
        apiUrl(deps.apiBase, `/media/${encodeURIComponent(registered.mediaId)}`),
        { method: "GET", headers: authenticatedHeaders(token), ...(signal ? { signal } : {}) },
      ), undefined, pollController);
    } catch {
      return { outcome: "unknown", evidence: evidence("polled", "unknown", { mediaId: registered.mediaId }, registered.sensitiveValues) };
    }
    if (!pollResponse.ok) return responseResult(pollResponse, "polled", registered.mediaId, registered.sensitiveValues);
    let pollBody: Record<string, unknown> | null;
    try {
      // Keep the fetch's controller alive through body consumption: a body timeout
      // aborts the original request/stream rather than a detached no-op controller.
      pollBody = await withinPollDeadline(deadline, deps, () => safeJson(pollResponse), undefined, pollController);
    } catch {
      return { outcome: "unknown", evidence: evidence("polled", "unknown", { mediaId: registered.mediaId }, registered.sensitiveValues) };
    }
    const status = cleanText(pollBody?.status).toLowerCase();
    if (status === "succeeded") {
      if (deadline - deps.now() <= 0) {
        return { outcome: "unknown", evidence: evidence("polled", "unknown", { mediaId: registered.mediaId }, registered.sensitiveValues) };
      }
      break;
    }
    if (["failed", "failure", "cancelled", "canceled", "rejected", "error"].includes(status)) {
      return {
        outcome: "failed",
        evidence: evidence("polled", "definite_rejection", {
          mediaId: registered.mediaId,
          ...(safeRequestId(pollResponse, registered.sensitiveValues) ? { requestId: safeRequestId(pollResponse, registered.sensitiveValues) } : {}),
        }, registered.sensitiveValues),
      };
    }
    if (status !== "registered" && status !== "processing") {
      return { outcome: "unknown", evidence: evidence("polled", "unknown", { mediaId: registered.mediaId }, registered.sensitiveValues) };
    }
    const remainingMs = deadline - deps.now();
    try {
      await withinPollDeadline(deadline, deps, () => deps.sleep(Math.min(pollIntervalMs, remainingMs)), remainingMs);
    } catch {
      return { outcome: "unknown", evidence: evidence("polled", "unknown", { mediaId: registered.mediaId }, registered.sensitiveValues) };
    }
  }

  try {
    const createBody: Record<string, unknown> = {
      board_id: cleanText(input.boardId),
      media_source: {
        source_type: "video_id",
        media_id: registered.mediaId,
        cover_image_key_frame_time: videoCoverFrameSeconds(input.coverFrameTimeMs, input.durationMs),
      },
    };
    const optional = [
      ["title", input.title],
      ["description", input.description],
      ["link", input.link],
      ["alt_text", input.altText],
    ] as const;
    for (const [key, value] of optional) {
      const cleaned = cleanText(value);
      if (cleaned) createBody[key] = cleaned;
    }
    const createResponse = await deps.fetch(apiUrl(deps.apiBase, "/pins"), {
      method: "POST",
      headers: authenticatedHeaders(token, true),
      body: JSON.stringify(createBody),
    });
    if (createResponse.status !== 201) return responseResult(createResponse, "created", registered.mediaId, registered.sensitiveValues);
    const body = await safeJson(createResponse);
    const pinId = safeId(body?.id);
    if (!pinId) return {
      outcome: "unknown",
      evidence: evidence("created", "unknown", {
        mediaId: registered.mediaId,
        ...(safeRequestId(createResponse, registered.sensitiveValues) ? { requestId: safeRequestId(createResponse, registered.sensitiveValues) } : {}),
      }, registered.sensitiveValues),
    };
    return {
      outcome: "succeeded",
      evidence: evidence("created", "succeeded", {
        mediaId: registered.mediaId,
        pinId,
        ...(safePinUrl(body?.url, pinId, registered.sensitiveValues) ? { pinUrl: safePinUrl(body?.url, pinId, registered.sensitiveValues) } : {}),
        ...(safeRequestId(createResponse, registered.sensitiveValues) ? { requestId: safeRequestId(createResponse, registered.sensitiveValues) } : {}),
      }, registered.sensitiveValues),
    };
  } catch {
    return { outcome: "unknown", evidence: evidence("created", "unknown", { mediaId: registered.mediaId }, registered.sensitiveValues) };
  }
}
