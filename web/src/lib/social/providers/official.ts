/**
 * "official" auth-provider entry — dispatches to each platform's own dedicated
 * OAuth integration (currently only Facebook) rather than a third-party
 * aggregator (Zernio/OneUp/...).
 *
 * connectionStore.ts writes `auth_provider: "official"` for connections created
 * by our own OAuth routes (Pinterest's metadata rows, Facebook's connection
 * row). Pinterest's disconnect never reaches this provider — it's intercepted
 * earlier in /api/social/disconnect (`usePinterestFlow`). Facebook's client-
 * initiated disconnect DOES reach here via
 * `getSocialProviderById(connection.authProvider).disconnect(...)`, so without
 * this registration it would silently fall back to whatever
 * SOCIAL_PUBLISHING_PROVIDER resolves to (mock no-op, or worse, a live
 * aggregator call with a connectionId it doesn't recognize).
 *
 * getConnectUrl/getConnections are not used for "official" — both Pinterest and
 * Facebook are read via their own dedicated code paths in
 * socialConnectionStore.ts (readPinterestConnection / readStoredConnections),
 * never via getSocialProvider().getConnections(). They're implemented here only
 * to satisfy the SocialPublishingProvider contract.
 */

import type {
  DisconnectInput,
  GetConnectionsInput,
  GetConnectUrlInput,
  GetConnectUrlResult,
  PublishPostInput,
  PublishResult,
  SocialConnection,
  SocialPublishingProvider,
} from "../types";

export const officialProvider: SocialPublishingProvider = {
  id: "official",

  async getConnectUrl(_input: GetConnectUrlInput): Promise<GetConnectUrlResult> {
    // Never actually called: /api/social/connect intercepts "pinterest" and
    // "facebook" before reaching getSocialProvider().
    return { url: null, status: "coming_soon", message: "Use the dedicated connect route for this platform." };
  },

  async getConnections(_input: GetConnectionsInput): Promise<SocialConnection[]> {
    // Never actually called: socialConnectionStore.ts reads official-auth rows
    // directly from social_connections / pinterest_connections.
    return [];
  },

  async publishPost(_input: PublishPostInput): Promise<PublishResult> {
    return { ok: false, status: "not_implemented", error: "Publishing not yet wired for this platform." };
  },

  async disconnect(input: DisconnectInput): Promise<void> {
    if (input.provider === "facebook") {
      const { disconnectFacebookConnection } = await import("@/lib/server/facebook/connectionStore");
      await disconnectFacebookConnection(input.userId);
      return;
    }
    // Pinterest never reaches here (see module comment). Any other future
    // "official" platform without a disconnect implementation yet is a no-op —
    // the API route still deletes the social_connections row afterward.
  },
};
