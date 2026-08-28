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
   *  validates it (isAcceptableImmediateBucket) before trusting it — this client
   *  never asserts it is honored. */
  meteringBucket?: string;
}): Promise<SocialPublishResult> {
  const res = await fetch("/api/publish/social", {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await readError(res, "Could not publish"));
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
