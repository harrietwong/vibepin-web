/**
 * "official" auth-provider entry — dispatches to each platform's own dedicated
 * OAuth integration (Facebook, Instagram) rather than a third-party aggregator
 * (Zernio/OneUp/...).
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

  /**
   * Publish to a platform that owns its own OAuth integration.
   *
   * FACEBOOK — posts to the user's SELECTED Page with that Page's page-scoped
   * token (decrypted server-side by connectionStore; the plaintext token never
   * leaves this function and is never logged or returned).
   *
   * Failure shapes (PublishResult has no per-reason status beyond
   * published/failed/not_implemented, so the distinction rides `error`):
   *   - no publishable Page  → ok:false, status:"failed", "Connect a Facebook Page first."
   *   - Graph rejected it    → ok:false, status:"failed", classified FacebookApiError message
   * INSTAGRAM — publishes an image post to the connected professional account
   * (see publishToInstagramAccount below for its two-step container flow).
   *
   * Everything else stays "not_implemented". Pinterest never reaches this
   * provider — see the module comment.
   */
  async publishPost(input: PublishPostInput): Promise<PublishResult> {
    if (input.provider === "instagram") {
      return publishToInstagramAccount(input);
    }
    if (input.provider !== "facebook") {
      return { ok: false, status: "not_implemented", error: "Publishing not yet wired for this platform." };
    }

    // The encrypted PAGE token is keyed on the user, not on the client-safe
    // SocialConnection projection — without a userId we cannot read it, and we
    // must NOT silently fall back to any other credential.
    const userId = input.userId?.trim();
    if (!userId) {
      return { ok: false, status: "failed", error: "Connect a Facebook Page first." };
    }

    const { getSelectedPageToken } = await import("@/lib/server/facebook/connectionStore");
    const selected = await getSelectedPageToken(userId);
    // null covers every not-publishable state (no row, disconnected, reconnect
    // required, no Page selected, undecryptable token) — one clean message.
    if (!selected) {
      return { ok: false, status: "failed", error: "Connect a Facebook Page first." };
    }

    const { publishToPage, FacebookApiError } = await import("@/lib/server/facebook/service");
    try {
      const result = await publishToPage(selected.pageAccessToken, selected.pageId, {
        // Facebook has no separate title field — title and caption are one body.
        message: [input.post.title?.trim(), input.post.caption?.trim()].filter(Boolean).join("\n\n"),
        imageUrl: input.post.imageUrls?.[0] ?? null,
        link: input.post.destinationUrl ?? null,
      });
      return {
        ok: true,
        status: "published",
        externalPostId: result.externalPostId,
        externalPostUrl: result.permalink,
      };
    } catch (err) {
      // FacebookApiError messages are Meta's own text (already token-free — the
      // service never embeds the token or the request URL). Anything else gets a
      // generic message so no internal detail reaches the merchant.
      const message = err instanceof FacebookApiError
        ? err.message
        : "Could not publish to Facebook. Please try again.";
      return { ok: false, status: "failed", error: message };
    }
  },

  async disconnect(input: DisconnectInput): Promise<void> {
    if (input.provider === "facebook") {
      const { disconnectFacebookConnection } = await import("@/lib/server/facebook/connectionStore");
      await disconnectFacebookConnection(input.userId);
      return;
    }
    if (input.provider === "instagram") {
      const { disconnectInstagramConnection } = await import("@/lib/server/instagram/connectionStore");
      await disconnectInstagramConnection(input.userId);
      return;
    }
    // Pinterest never reaches here (see module comment). Any other future
    // "official" platform without a disconnect implementation yet is a no-op —
    // the API route still deletes the social_connections row afterward.
  },
};

/**
 * Publish one image post to the connected Instagram professional account.
 *
 * Mirrors the Facebook branch's contract: a null credential covers every
 * not-publishable state (no row, disconnected, expired, undecryptable token)
 * with one clean message, and Instagram's own error text — which never carries
 * a token — is surfaced as-is so the merchant learns what Instagram objected to.
 *
 * Instagram requires an image: unlike a Facebook Page it has no text-only post,
 * so a Pin without one is rejected before any API call.
 */
async function publishToInstagramAccount(input: PublishPostInput): Promise<PublishResult> {
  const userId = input.userId?.trim();
  if (!userId) {
    return { ok: false, status: "failed", error: "Connect an Instagram account first." };
  }

  const { getInstagramAccessToken } = await import("@/lib/server/instagram/connectionStore");
  const connection = await getInstagramAccessToken(userId);
  if (!connection?.userId) {
    return { ok: false, status: "failed", error: "Connect an Instagram account first." };
  }

  const imageUrl = input.post.imageUrls?.[0];
  if (!imageUrl) {
    return { ok: false, status: "failed", error: "Instagram posts need an image." };
  }

  const { publishToInstagram, InstagramApiError } = await import("@/lib/server/instagram/service");
  try {
    const result = await publishToInstagram({
      accessToken: connection.accessToken,
      igUserId: connection.userId,
      imageUrl,
      // Instagram has no separate title field — title and caption are one body.
      caption: [input.post.title?.trim(), input.post.caption?.trim()].filter(Boolean).join("\n\n"),
      destinationUrl: input.post.destinationUrl ?? undefined,
    });
    return {
      ok: true,
      status: "published",
      externalPostId: result.mediaId,
      externalPostUrl: result.permalink,
    };
  } catch (err) {
    const message = err instanceof InstagramApiError
      ? err.message
      : "Could not publish to Instagram. Please try again.";
    return { ok: false, status: "failed", error: message };
  }
}
