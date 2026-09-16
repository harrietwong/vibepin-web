/**
 * Injectable, provider-boundary adapter for Pinterest video Pins.
 *
 * This module deliberately knows nothing about routes, durable attempts, storage,
 * or retries. Its caller supplies one already-authorized account/token pair and a
 * private video Blob. Network uncertainty becomes an explicit `unknown` result so
 * a durable orchestration layer can reconcile before it considers another dispatch.
 */

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
  uploadParameters: Record<string, string>;
};

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_POLL_DEADLINE_MS = 120_000;

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function safeId(value: unknown): string | undefined {
  const id = cleanText(value);
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id) ? id : undefined;
}

function safeRequestId(response: Response): string | undefined {
  return safeId(
    response.headers.get("x-pinterest-rid")
    ?? response.headers.get("x-request-id")
    ?? response.headers.get("x-amzn-requestid"),
  );
}

function safePinUrl(value: unknown): string | undefined {
  const raw = cleanText(value);
  if (!raw || raw.length > 2_048) return undefined;
  try {
    const url = new URL(raw);
    const pinterestHost = url.hostname === "pinterest.com" || url.hostname.endsWith(".pinterest.com");
    return url.protocol === "https:" && pinterestHost && !url.username && !url.password && !url.search && !url.hash
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function evidence(
  stage: PinterestVideoEvidence["stage"],
  classification: PinterestVideoEvidence["classification"],
  values: Omit<PinterestVideoEvidence, "stage" | "classification"> = {},
): PinterestVideoEvidence {
  return { stage, classification, ...values };
}

function validationResult(): PinterestVideoPublishResult {
  return { outcome: "failed", evidence: evidence("validated", "definite_validation") };
}

function responseResult(
  response: Response,
  stage: PinterestVideoEvidence["stage"],
  mediaId?: string,
): PinterestVideoPublishResult {
  const classification = response.status >= 400 && response.status < 500 ? "definite_rejection" : "unknown";
  return {
    outcome: classification === "definite_rejection" ? "failed" : "unknown",
    evidence: evidence(stage, classification, { ...(mediaId ? { mediaId } : {}), ...(safeRequestId(response) ? { requestId: safeRequestId(response) } : {}) }),
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

function validUploadParameters(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!key || typeof item !== "string") return null;
    result[key] = item;
  }
  return result;
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

  const token = cleanText(input.accessToken);
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const pollDeadlineMs = deps.pollDeadlineMs ?? DEFAULT_POLL_DEADLINE_MS;

  let registered: RegisteredMedia;
  try {
    const registerResponse = await deps.fetch(apiUrl(deps.apiBase, "/media"), {
      method: "POST",
      headers: authenticatedHeaders(token, true),
      body: JSON.stringify({ media_type: "video" }),
    });
    if (!registerResponse.ok) return responseResult(registerResponse, "registered");
    const body = await safeJson(registerResponse);
    const mediaId = safeId(body?.media_id);
    const uploadUrl = cleanText(body?.upload_url);
    const uploadParameters = validUploadParameters(body?.upload_parameters);
    if (!mediaId || !uploadUrl || !uploadParameters) {
      return { outcome: "unknown", evidence: evidence("registered", "unknown", { ...(safeRequestId(registerResponse) ? { requestId: safeRequestId(registerResponse) } : {}) }) };
    }
    registered = { mediaId, uploadUrl, uploadParameters };
  } catch {
    return { outcome: "unknown", evidence: evidence("registered", "unknown") };
  }

  try {
    const form = new FormData();
    // Object.entries preserves the property insertion order Pinterest supplied.
    for (const [key, value] of Object.entries(registered.uploadParameters)) form.append(key, value);
    form.append("file", input.file, cleanText(input.fileName) || "video.mp4");
    const uploadResponse = await deps.fetch(registered.uploadUrl, { method: "POST", body: form });
    if (uploadResponse.status !== 204) return responseResult(uploadResponse, "uploaded", registered.mediaId);
  } catch {
    return { outcome: "unknown", evidence: evidence("uploaded", "unknown", { mediaId: registered.mediaId }) };
  }

  const deadline = deps.now() + pollDeadlineMs;
  while (deps.now() <= deadline) {
    let pollResponse: Response;
    try {
      pollResponse = await deps.fetch(apiUrl(deps.apiBase, `/media/${encodeURIComponent(registered.mediaId)}`), {
        method: "GET",
        headers: authenticatedHeaders(token),
      });
    } catch {
      return { outcome: "unknown", evidence: evidence("polled", "unknown", { mediaId: registered.mediaId }) };
    }
    if (!pollResponse.ok) return responseResult(pollResponse, "polled", registered.mediaId);
    const status = cleanText((await safeJson(pollResponse))?.status).toLowerCase();
    if (status === "succeeded") break;
    if (["failed", "failure", "cancelled", "canceled", "rejected", "error"].includes(status)) {
      return {
        outcome: "failed",
        evidence: evidence("polled", "definite_rejection", {
          mediaId: registered.mediaId,
          ...(safeRequestId(pollResponse) ? { requestId: safeRequestId(pollResponse) } : {}),
        }),
      };
    }
    if (status !== "registered" && status !== "processing") {
      return { outcome: "unknown", evidence: evidence("polled", "unknown", { mediaId: registered.mediaId }) };
    }
    await deps.sleep(pollIntervalMs);
  }
  if (deps.now() > deadline) {
    return { outcome: "unknown", evidence: evidence("polled", "unknown", { mediaId: registered.mediaId }) };
  }

  try {
    const createBody: Record<string, unknown> = {
      board_id: cleanText(input.boardId),
      media_source: {
        source_type: "video_id",
        media_id: registered.mediaId,
        cover_image_key_frame_time: 1,
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
    if (createResponse.status !== 201) return responseResult(createResponse, "created", registered.mediaId);
    const body = await safeJson(createResponse);
    const pinId = safeId(body?.id);
    if (!pinId) return { outcome: "unknown", evidence: evidence("created", "unknown", { mediaId: registered.mediaId, ...(safeRequestId(createResponse) ? { requestId: safeRequestId(createResponse) } : {}) }) };
    return {
      outcome: "succeeded",
      evidence: evidence("created", "succeeded", {
        mediaId: registered.mediaId,
        pinId,
        ...(safePinUrl(body?.url) ? { pinUrl: safePinUrl(body?.url) } : {}),
        ...(safeRequestId(createResponse) ? { requestId: safeRequestId(createResponse) } : {}),
      }),
    };
  } catch {
    return { outcome: "unknown", evidence: evidence("created", "unknown", { mediaId: registered.mediaId }) };
  }
}
