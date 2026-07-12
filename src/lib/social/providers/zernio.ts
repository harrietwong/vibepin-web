/**
 * Zernio provider adapter (server-only).
 *
 * Implements the SocialPublishingProvider contract against the documented Zernio
 * REST API (https://docs.zernio.com, base https://zernio.com/api/v1). Only
 * documented endpoints are used:
 *
 *   GET    /connect/{platform}?profileId=   → OAuth connect URL   ({ authUrl })
 *   GET    /accounts[?profileId=]           → list connected accounts
 *   DELETE /accounts/{id}                   → disconnect an account
 *   POST   /posts                           → create/publish a post
 *
 * Auth: `Authorization: Bearer <ZERNIO_API_KEY>`. The key is read from the
 * server environment only, never logged, and never sent to the client. All
 * Zernio-specific payload shapes are confined to this file — callers only ever
 * see our neutral DTOs.
 *
 * Compliance: publishPost sends `publishNow: true` only because the merchant
 * explicitly clicked Publish after reviewing and selecting destinations. This
 * adapter never schedules or posts on its own.
 *
 * Server-only: reached exclusively through the provider registry, which is
 * imported only by API route handlers — never by a client component.
 */

import {
  PLATFORMS,
  isSocialProvider,
  platformName,
  type SocialProvider,
} from "../platforms";
import type {
  DisconnectInput,
  GetConnectUrlInput,
  GetConnectUrlResult,
  GetConnectionsInput,
  PublishPostInput,
  PublishResult,
  SocialConnection,
  SocialPublishingProvider,
} from "../types";
import { ProviderConfigError } from "./errors";

const DEFAULT_BASE_URL = "https://zernio.com/api/v1";

// ── Configuration (server env only) ───────────────────────────────────────────

export function zernioConfig() {
  const apiKey = (process.env.ZERNIO_API_KEY ?? "").trim();
  const baseUrl = (process.env.ZERNIO_BASE_URL ?? "").trim() || DEFAULT_BASE_URL;
  const profileId = (process.env.ZERNIO_PROFILE_ID ?? "").trim() || null;
  return { apiKey, baseUrl, profileId };
}

export function isZernioConfigured(): boolean {
  return !!zernioConfig().apiKey;
}

/** Names (not values) of required env vars that are missing. */
export function zernioMissingEnv(): string[] {
  const missing: string[] = [];
  if (!zernioConfig().apiKey) missing.push("ZERNIO_API_KEY");
  return missing;
}

function requireConfig() {
  const cfg = zernioConfig();
  if (!cfg.apiKey) throw new ProviderConfigError();
  return cfg;
}

// ── Platform mapping (our providers ⇆ Zernio platform strings) ────────────────
// Zernio's platform identifiers match ours 1:1 for the four we support.

const SUPPORTED = new Set<SocialProvider>(["pinterest", "instagram", "facebook", "tiktok"]);

function toZernioPlatform(provider: SocialProvider): string {
  return provider;
}

function fromZernioPlatform(platform: unknown): SocialProvider | null {
  return typeof platform === "string" && isSocialProvider(platform) && SUPPORTED.has(platform)
    ? platform
    : null;
}

// ── HTTP helper ───────────────────────────────────────────────────────────────

type ZernioError = { error?: { message?: string; code?: string; details?: unknown } };

/**
 * Perform an authenticated Zernio request. Never logs the API key. Parses the
 * documented error envelope `{ error: { message, code } }` and throws a plain
 * Error carrying only the safe message.
 */
async function zernioFetch<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const { apiKey, baseUrl } = requireConfig();
  const url = `${baseUrl}${path}`;
  const res = await fetch(url, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    cache: "no-store",
  });

  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    /* some responses (e.g. DELETE) may have no body */
  }

  if (!res.ok) {
    const msg = (json as ZernioError)?.error?.message;
    // Do not leak the key or full URL. Message is Zernio's own error text or a
    // generic status fallback.
    throw new Error(msg || `Zernio request failed (${res.status})`);
  }
  return json as T;
}

// ── Response shapes (documented, parsed defensively) ─────────────────────────

type ZernioAccount = {
  _id?: string;
  id?: string;
  platform?: string;
  name?: string;
  username?: string;
  displayName?: string;
  handle?: string;
  avatarUrl?: string;
  profileImageUrl?: string;
  profileId?: string;
  status?: string;
};

function accountId(a: ZernioAccount): string | null {
  return a._id ?? a.id ?? null;
}

function mapAccount(a: ZernioAccount): SocialConnection | null {
  const provider = fromZernioPlatform(a.platform);
  const id = accountId(a);
  if (!provider || !id) return null;
  const username = a.username ?? a.handle ?? null;
  const name = a.name ?? a.displayName ?? (username ? `@${username}` : platformName(provider));
  return {
    id: `zernio:${id}`,
    provider,
    workspaceId: null,
    providerAccountId: id,
    providerAccountName: name,
    providerAccountUsername: username,
    providerAccountAvatarUrl: a.avatarUrl ?? a.profileImageUrl ?? null,
    connectionStatus: a.status === "error" || a.status === "expired" ? (a.status as SocialConnection["connectionStatus"]) : "connected",
    authProvider: "zernio",
    externalConnectionId: id,
    scopes: [],
    tokenExpiresAt: null,
    metadata: a.profileId ? { profileId: a.profileId } : null,
    createdAt: null,
    updatedAt: null,
  };
}

// ── Adapter ───────────────────────────────────────────────────────────────────

export const zernioProvider: SocialPublishingProvider = {
  id: "zernio",

  async getConnectUrl(input: GetConnectUrlInput): Promise<GetConnectUrlResult> {
    if (!isZernioConfigured()) throw new ProviderConfigError();
    if (!PLATFORMS[input.provider]) {
      return { url: null, status: "coming_soon", message: `${input.provider} is not supported.` };
    }
    const cfg = zernioConfig();
    const qs = cfg.profileId ? `?profileId=${encodeURIComponent(cfg.profileId)}` : "";
    const data = await zernioFetch<{ authUrl?: string; url?: string }>(
      `/connect/${toZernioPlatform(input.provider)}${qs}`,
    );
    const url = data.authUrl ?? data.url ?? null;
    if (!url) {
      return {
        url: null,
        status: "pending",
        message: `Could not start ${platformName(input.provider)} connection. Please try again.`,
      };
    }
    return { url, status: "oauth_url" };
  },

  async getConnections(input: GetConnectionsInput): Promise<SocialConnection[]> {
    if (!isZernioConfigured()) return [];
    const cfg = zernioConfig();
    const qs = cfg.profileId ? `?profileId=${encodeURIComponent(cfg.profileId)}` : "";
    const data = await zernioFetch<{ accounts?: ZernioAccount[] }>(`/accounts${qs}`);
    const accounts = Array.isArray(data.accounts) ? data.accounts : [];
    const mapped = accounts.map(mapAccount).filter((c): c is SocialConnection => c !== null);
    return input.provider ? mapped.filter(c => c.provider === input.provider) : mapped;
  },

  async publishPost(input: PublishPostInput): Promise<PublishResult> {
    if (!isZernioConfigured()) throw new ProviderConfigError();
    const { provider, connection, post } = input;
    const accountId = connection.externalConnectionId ?? connection.providerAccountId;
    if (!accountId) {
      return { ok: false, status: "failed", error: `${platformName(provider)} account is not linked.` };
    }

    const platformEntry: Record<string, unknown> = {
      platform: toZernioPlatform(provider),
      accountId,
      mediaUrls: post.imageUrls,
    };
    // Pinterest-specific documented options.
    if (provider === "pinterest") {
      if (post.boardId) platformEntry.board = post.boardId;
      if (post.title) platformEntry.title = post.title;
      if (post.destinationUrl) platformEntry.destinationUrl = post.destinationUrl;
    }

    const body = {
      content: post.caption ?? post.title ?? "",
      publishNow: true,
      platforms: [platformEntry],
    };

    type ZernioPost = {
      post?: {
        _id?: string;
        id?: string;
        status?: string;
        platforms?: Array<{ platform?: string; url?: string; postUrl?: string; permalink?: string }>;
      };
    };
    const data = await zernioFetch<ZernioPost>("/posts", { method: "POST", body });
    const created = data.post ?? {};
    const externalPostId = created._id ?? created.id ?? null;
    const platformResult = (created.platforms ?? []).find(
      p => fromZernioPlatform(p.platform) === provider,
    );
    const externalPostUrl =
      platformResult?.url ?? platformResult?.postUrl ?? platformResult?.permalink ?? null;

    // Documented status values: draft | scheduled | published | failed | partial.
    // Only an explicit "failed" is a failure; publishNow otherwise means accepted.
    const failed = created.status === "failed";
    return {
      ok: !failed,
      status: failed ? "failed" : "published",
      externalPostId,
      externalPostUrl,
      error: failed ? `Publishing to ${platformName(provider)} failed.` : null,
    };
  },

  async disconnect(input: DisconnectInput): Promise<void> {
    if (!isZernioConfigured()) throw new ProviderConfigError();
    const id =
      input.externalConnectionId ??
      (input.connectionId.startsWith("zernio:") ? input.connectionId.slice("zernio:".length) : null);
    if (!id) return; // nothing to revoke at Zernio
    await zernioFetch<unknown>(`/accounts/${encodeURIComponent(id)}`, { method: "DELETE" });
  },
};
