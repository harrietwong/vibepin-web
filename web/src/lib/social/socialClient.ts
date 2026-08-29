/**
 * Client-side helper for the internal /api/social/* and /api/publish/* routes.
 *
 * Mirrors pinterestClient.ts: reads the live Supabase session each call and
 * attaches `Authorization: Bearer <access token>`. Tokens are never stored here.
 */

import type {
  ConnectionStatus,
  PlatformConnectionSummary,
  SocialConnection,
  SocialPostPayload,
  SocialProvider,
} from "./types";
import { freshAccessToken } from "@/lib/supabaseBrowser";
import { parseLimitReached, type LimitReached } from "@/lib/usage/limitReached";

async function authHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  // Shared single-flight refresh (lib/supabaseBrowser) — this is deliberately the SAME
  // client + refresh coordination pinterestClient uses, so status/boards/connections
  // firing together on modal open can never race independent token refreshes into 401s.
  const token = await freshAccessToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const body = await res.json() as { error?: string };
    return body.error || fallback;
  } catch {
    return fallback;
  }
}

/**
 * A publish-route refusal that carries a machine-readable `code` (and, for the three
 * usage-limit codes, the parsed `limit`) instead of only prose. publishContent.ts maps
 * this onto a DestinationPublishResult's `errorCode` so StudioBoard's limit UI (the
 * "Generate/schedule more" dialog wiring keyed off `errorCode`) fires for a social-only
 * refusal exactly as it already does for a Pinterest one — see limitMessageKeyForCode's
 * callers in StudioBoard.tsx.
 *
 * Deliberately NOT `LimitReachedError` (lib/usage/limitReached.ts): that type's `.limit`
 * only carries `kind` ("scheduled_post"), not the raw server code string StudioBoard
 * indexes by. This carries both — `code` for the UI, `limit` for callers that want the
 * parsed recurring/bonus counts too.
 */
export class SocialApiError extends Error {
  readonly status: number;
  /** The server's machine-readable code, e.g. "scheduled_post_limit_reached". Undefined
   *  when the failed response carried no recognizable code (a generic 4xx/5xx). */
  readonly code?: string;
  /** Populated only when `code` is one of the three usage-limit refusals. */
  readonly limit?: LimitReached;
  constructor(message: string, status: number, code?: string, limit?: LimitReached) {
    super(message);
    this.name = "SocialApiError";
    this.status = status;
    this.code = code;
    this.limit = limit;
  }
}

/**
 * Read a failed response's body ONCE and build the richest error it supports: a
 * usage-limit refusal keeps its `code` and parsed `limit`; any other body with a `code`
 * field keeps just the code; anything else falls back to the existing prose-only Error
 * shape (never throws on a body that is not JSON).
 */
async function readSocialApiError(res: Response, fallback: string): Promise<SocialApiError> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return new SocialApiError(fallback, res.status);
  }
  const record = (body && typeof body === "object" && !Array.isArray(body))
    ? body as Record<string, unknown>
    : undefined;
  const limit = parseLimitReached(res.status, body) ?? undefined;
  const code = limit
    ? (typeof record?.code === "string" ? record.code : typeof record?.error_type === "string" ? record.error_type : undefined)
    : (typeof record?.code === "string" ? record.code : undefined);
  const message = (record && typeof record.error === "string" && record.error.trim())
    ? record.error
    : fallback;
  return new SocialApiError(message, res.status, code, limit);
}

async function fetchSocialApi(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch {
    throw new Error("Could not reach social connections. Please try again.");
  }
}

// ── Connections ───────────────────────────────────────────────────────────────

export type ConnectionsResponse = {
  platforms: PlatformConnectionSummary[];
  connections: SocialConnection[];
};

export async function fetchSocialConnections(signal?: AbortSignal): Promise<ConnectionsResponse> {
  const res = await fetchSocialApi("/api/social/connections", {
    headers: await authHeaders(),
    cache: "no-store",
    signal,
  });
  if (!res.ok) throw new Error(await readError(res, "Could not load social connections"));
  return res.json();
}

export type SocialConnectResult = {
  provider: SocialProvider;
  status: "oauth_url" | "pending" | "coming_soon";
  url: string | null;
  message?: string | null;
};

export async function startSocialConnect(
  provider: SocialProvider,
  next?: string,
): Promise<SocialConnectResult> {
  const res = await fetch("/api/social/connect", {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({ provider, next }),
  });
  if (!res.ok) throw new Error(await readError(res, "Could not start connection"));
  return res.json();
}

export type SocialDisconnectResult = { ok: boolean; usePinterestFlow?: boolean };

export async function disconnectSocial(connectionId: string): Promise<SocialDisconnectResult> {
  const res = await fetch("/api/social/disconnect", {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({ connectionId }),
  });
  if (!res.ok) throw new Error(await readError(res, "Could not disconnect account"));
  return res.json();
}

// ── Publish destinations ────────────────────────────────────────────────────

export type DestinationInput = { provider: SocialProvider; socialConnectionId?: string | null };

export type ValidateResult = {
  ok: boolean;
  results: Array<{
    provider: SocialProvider;
    publishable: boolean;
    status: ConnectionStatus;
    socialConnectionId: string | null;
    reason?: string;
  }>;
};

export async function validateDestinations(
  destinations: DestinationInput[],
): Promise<ValidateResult> {
  const res = await fetch("/api/publish/destinations/validate", {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({ destinations }),
  });
  if (!res.ok) throw new Error(await readError(res, "Could not validate destinations"));
  return res.json();
}

export type SocialPublishResult = {
  ok: boolean;
  jobId: string | null;
  status: "draft" | "publishing" | "published" | "partially_published" | "failed";
  destinations: Array<{
    provider: SocialProvider;
    status: "pending" | "skipped" | "publishing" | "published" | "failed";
    /** Remote post id on the platform (e.g. a Facebook `{page-id}_{post-id}`). */
    externalPostId: string | null;
    /** Direct link to the live post — powers "View on <platform>". */
    externalPostUrl: string | null;
    /**
     * Handle the post went out as (Page name / IG username) — so the published
     * view can name the destination account, not just the platform.
     */
    accountName: string | null;
    error: string | null;
  }>;
};

export async function publishToSocial(input: {
  postId?: string;
  productId?: string;
  post: SocialPostPayload;
  destinations: DestinationInput[];
  /** Server-minted immediate-publish UTC date bucket relayed from a pinterest call
   *  for this SAME Content (meterScheduledPost.ts). The server independently
   *  validates it (isAcceptableImmediateBucket + verifyImmediateBucket) before
   *  trusting it — this client never asserts it is honored. */
  meteringBucket?: string;
  /** HMAC over (uid, postId, meteringBucket, meteringBucketMintedAt), relayed
   *  alongside them so the server can authenticate the bucket instead of merely
   *  accepting its date shape. */
  meteringBucketSig?: string;
  /** The server instant meteringBucket+meteringBucketSig were minted at (Fix 5
   *  relay-age binding) — the server's verification is bound to THIS value, not its
   *  own "now". Always sent together with meteringBucketSig. */
  meteringBucketMintedAt?: number;
}): Promise<SocialPublishResult> {
  const res = await fetch("/api/publish/social", {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await readSocialApiError(res, "Could not publish");
  return res.json();
}

/** An attempt that started but has not finished — see /api/publish/in-flight. */
export type InFlightPublish = {
  inFlight: boolean;
  jobId?: string;
  startedAt?: string;
  destinations?: Array<{ provider: SocialProvider; status: string }>;
};

/**
 * Is a publish for this Pin still running? Used to restore the publishing state
 * after a refresh: the drawer holds it in memory, so without this a reload
 * mid-publish showed nothing at all.
 *
 * Never throws. A recovery probe that fails must leave the UI as it found it,
 * not surface an error for a publish the merchant may not even have started.
 */
export async function fetchInFlightPublish(postId: string): Promise<InFlightPublish> {
  if (!postId) return { inFlight: false };
  try {
    const res = await fetch(`/api/publish/in-flight?postId=${encodeURIComponent(postId)}`, {
      headers: await authHeaders(),
    });
    if (!res.ok) return { inFlight: false };
    return await res.json() as InFlightPublish;
  } catch {
    return { inFlight: false };
  }
}
