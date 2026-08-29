/**
 * Shared DTOs and the provider abstraction contract for multi-platform social
 * publishing. These types are the boundary the UI and API routes speak — they
 * intentionally omit token ciphertext so nothing token-shaped can leak to the
 * client.
 */

import type {
  AuthProvider,
  ConnectionStatus,
  SocialProvider,
} from "./platforms";

export type { AuthProvider, ConnectionStatus, SocialProvider };

/**
 * Client-safe projection of a social_connections row (or a mapped Pinterest
 * connection). NEVER contains access/refresh tokens.
 */
export interface SocialConnection {
  id: string;
  provider: SocialProvider;
  workspaceId: string | null;
  providerAccountId: string | null;
  providerAccountName: string | null;
  providerAccountUsername: string | null;
  providerAccountAvatarUrl: string | null;
  connectionStatus: ConnectionStatus;
  authProvider: AuthProvider | null;
  externalConnectionId: string | null;
  scopes: string[];
  tokenExpiresAt: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string | null;
  updatedAt: string | null;
}

/**
 * One platform's connection summary for the Settings tab. Aggregates the
 * (possibly several) connected accounts for a provider into a single card.
 */
export interface PlatformConnectionSummary {
  provider: SocialProvider;
  status: ConnectionStatus;
  /** Whether at least one account is usable for publishing right now. */
  connected: boolean;
  /**
   * Number of account rows the merchant holds on this provider. In the Settings
   * listing that includes DISCONNECTED rows — they still hold a plan slot until
   * they are removed. `connected` above, not this, answers "can we publish?".
   */
  accountCount: number;
  /** Primary connected account name/handle to display, if any. */
  accountName: string | null;
  /** Whether a real connect path exists yet (false → "setup pending"). */
  liveConnect: boolean;
  /** Individual connected accounts (empty when not connected). */
  accounts: SocialConnection[];
}

// ── Provider abstraction ──────────────────────────────────────────────────────

export interface GetConnectUrlInput {
  provider: SocialProvider;
  userId: string;
  workspaceId?: string | null;
  /** Where to return the user after OAuth completes. */
  returnTo?: string;
}

export type ConnectUrlStatus = "oauth_url" | "pending" | "coming_soon";

export interface GetConnectUrlResult {
  /** OAuth URL to redirect to, or null when no live path exists yet. */
  url: string | null;
  status: ConnectUrlStatus;
  /** User-facing explanation when url is null. */
  message?: string;
}

export interface GetConnectionsInput {
  userId: string;
  workspaceId?: string | null;
  provider?: SocialProvider;
}

/** Media + copy for a single approved post. Kept generic across platforms. */
export interface SocialPostPayload {
  imageUrls: string[];
  title?: string;
  caption?: string;
  destinationUrl?: string;
  altText?: string;
  /** Pinterest-specific board target, ignored by other providers. */
  boardId?: string;
}

export interface PublishPostInput {
  provider: SocialProvider;
  connection: SocialConnection;
  post: SocialPostPayload;
  /**
   * Owner of the connection. Required by providers that read server-only,
   * per-user credentials keyed on the user (Facebook's encrypted PAGE token lives
   * in social_connections.metadata and is deliberately absent from the
   * client-safe SocialConnection projection). Mirrors DisconnectInput.userId.
   * Aggregator providers (Zernio/OneUp/mock) ignore it.
   */
  userId?: string;
}

export type PublishStatus = "published" | "failed" | "not_implemented";

export interface PublishResult {
  ok: boolean;
  status: PublishStatus;
  externalPostId?: string | null;
  externalPostUrl?: string | null;
  /**
   * Handle the post went out as (Facebook Page name, Instagram username), so the
   * published view can say WHICH account received it — a permalink alone does
   * not, and a merchant may have several accounts connected.
   */
  accountName?: string | null;
  error?: string | null;
}

export interface DisconnectInput {
  userId: string;
  /** Our internal SocialConnection id. */
  connectionId: string;
  /** The provider/vendor account id (e.g. Zernio account _id), when known. */
  externalConnectionId?: string | null;
  provider: SocialProvider;
}

/**
 * The vendor-neutral contract every publishing back-end implements. Swapping
 * Zernio for OneUp/Publer/Ayrshare/official APIs is a matter of registering a
 * different implementation in providers/index.ts — no UI or route changes.
 */
export interface SocialPublishingProvider {
  readonly id: AuthProvider;
  getConnectUrl(input: GetConnectUrlInput): Promise<GetConnectUrlResult>;
  getConnections(input: GetConnectionsInput): Promise<SocialConnection[]>;
  publishPost(input: PublishPostInput): Promise<PublishResult>;
  disconnect(input: DisconnectInput): Promise<void>;
}
