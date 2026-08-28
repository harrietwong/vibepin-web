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

/**
 * A refusal the CALLER has to act on differently, not just show.
 *
 * A plain `Error(message)` was enough while every failure meant the same thing
 * ("tell the merchant"). The remove route now refuses for reasons that carry a
 * next step - `schedules_exist` opens the keep/cancel dialog with the server's
 * count; `schedule_check_failed` keeps the row and asks for a retry - and neither
 * is reachable if the body is flattened to a string on the way out.
 */
export type SocialClientError = Error & {
  /** The route's machine-readable `code`, when it sent one. */
  code?: string;
  /** Present on `schedules_exist`: the count taken server-side at delete time. */
  scheduledCount?: number;
  httpStatus?: number;
};

/**
 * Build the typed error from a failed response, keeping `code`/`scheduledCount`
 * alongside the human message.
 */
async function toSocialClientError(res: Response, fallback: string): Promise<SocialClientError> {
  let body: Record<string, unknown> | null = null;
  try {
    body = await res.json() as Record<string, unknown> | null;
  } catch {
    body = null;
  }
  const message = typeof body?.error === "string" && body.error
    ? body.error
    : typeof body?.userMessage === "string" && body.userMessage
      ? body.userMessage
      : fallback;
  const err = new Error(message) as SocialClientError;
  if (typeof body?.code === "string") err.code = body.code;
  if (typeof body?.scheduledCount === "number") err.scheduledCount = body.scheduledCount;
  err.httpStatus = res.status;
  return err;
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
  /**
   * The user's resolved plan, so the UI can offer the action that actually exists
   * (a paid user can buy an extra account slot; a Free user can only upgrade).
   * Optional on the type because an older cached response may not carry it —
   * callers must treat "missing" as "free".
   */
  plan?: "free" | "starter" | "pro" | "business";
  /**
   * How that plan is billed. Extra account slots follow it (决策 A), so the CTA
   * prices itself off this value. Missing/null → show the monthly price, which is
   * also what the checkout route falls back to charging.
   */
  planInterval?: "month" | "year" | null;
  /**
   * Extra-slot pool summary, for the moment after a slot purchase returns to
   * Settings: `slotsAvailable > 0` means the limit banner is no longer true.
   * Missing/null = the server could not measure it — change nothing.
   */
  allowance?: { purchasedSlots: number; slotsAvailable: number } | null;
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
  /**
   * Repairing THIS connection rather than adding one. Carried through to the
   * provider's OAuth start so an at-limit user can still fix a broken connection
   * (the plan gate refuses new accounts, never re-auth of an existing one).
   */
  reconnectConnectionId?: string | null,
): Promise<SocialConnectResult> {
  const res = await fetch("/api/social/connect", {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({ provider, next, reconnect: reconnectConnectionId ?? undefined }),
  });
  if (!res.ok) throw new Error(await readError(res, "Could not start connection"));
  return res.json();
}

/**
 * "disconnect" invalidates the credentials and KEEPS the account row (reversible
 * by reconnecting); "remove" deletes it. The two are separate words on purpose —
 * a single "Disconnect" that also deleted the row is what made the old
 * platform-level button impossible to reason about.
 */
export type SocialDisconnectMode = "disconnect" | "remove";

export type SocialDisconnectResult = {
  ok: boolean;
  usePinterestFlow?: boolean;
  mode?: SocialDisconnectMode;
  cancelledScheduled?: number;
};

export async function disconnectSocial(
  connectionId: string,
  opts?: {
    /** Defaults to the soft, reversible action server-side. */
    mode?: SocialDisconnectMode;
    /** Only meaningful with mode "remove" — a soft disconnect never touches schedules. */
    cancelScheduled?: boolean;
  },
): Promise<SocialDisconnectResult> {
  const mode = opts?.mode ?? "disconnect";
  const res = await fetch("/api/social/disconnect", {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({
      connectionId,
      mode,
      // Never send it on a soft disconnect: clearing a merchant's schedules is a
      // consequence of removing an account, never of switching one off.
      ...(mode === "remove" && opts?.cancelScheduled ? { cancelScheduled: true } : {}),
    }),
  });
  // Typed, not flattened: `schedules_exist` and `schedule_check_failed` each have a
  // different next step in the panel, and both need the body to survive the throw.
  if (!res.ok) throw await toSocialClientError(res, "Could not disconnect account");
  return res.json();
}

/**
 * How many scheduled Contents still publish through this account — asked before a
 * per-account Remove so the merchant is never silently stripped of planned work.
 *
 * Read-only and best-effort: a failure answers 0 rather than blocking the Remove.
 * A wrong 0 costs a prompt, not a post — the publish path still refuses a
 * destination whose account is gone.
 */
export async function fetchSocialScheduledCount(connectionId: string): Promise<number> {
  if (!connectionId) return 0;
  try {
    const res = await fetch(
      `/api/social/disconnect?connectionId=${encodeURIComponent(connectionId)}`,
      { headers: await authHeaders(), cache: "no-store" },
    );
    if (!res.ok) return 0;
    const body = await res.json() as { scheduledCount?: number };
    return typeof body.scheduledCount === "number" ? body.scheduledCount : 0;
  } catch {
    return 0;
  }
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
