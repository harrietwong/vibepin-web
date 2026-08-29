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

import {
  checkFacebookMedia,
  checkInstagramMedia,
  toMediaItems,
} from "@/lib/publish/mediaRules";
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
   *   - no publishable Page  → ok:false, status:"failed", preNetwork:true,
   *                             "Connect a Facebook Page first."
   *   - Graph rejected it    → ok:false, status:"failed", classified FacebookApiError
   *                             message + Graph's own providerStatus (never preNetwork)
   *
   * `preNetwork` marks every failure decided in this file WITHOUT reaching the
   * platform (credentials, account selection, our own media rules). It exists because
   * those failures carry no providerStatus, and "no status" is also what a timeout
   * looks like — which the product CHARGES for. Unflagged, a merchant paid a
   * scheduled-post unit for "Connect a Facebook Page first." See ../types.ts.
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
      // Decided here, with no Graph call made: `preNetwork` so the usage classifier
      // reads this as `not_sent` (refundable) instead of `delivery_unknown`. Every
      // credential/validation refusal in this file carries the same flag — see the
      // field's doc comment in ../types.ts for why absence of a providerStatus is not
      // enough to tell "we never sent it" apart from "it timed out".
      return { ok: false, status: "failed", error: "Connect a Facebook Page first.", preNetwork: true };
    }

    // Every image the Content carries, in display order — never just the cover.
    const imageUrls = (input.post.imageUrls ?? []).filter(u => typeof u === "string" && u.trim());
    // A Facebook Page post may legitimately be text-only, so the media rules only
    // gate a post that HAS images; `no_media` is not a failure here.
    if (imageUrls.length) {
      const media = checkFacebookMedia(toMediaItems(imageUrls));
      if (!media.ok) {
        // Our OWN media rules refused the set — nothing was sent to Graph.
        return { ok: false, status: "failed", error: media.message, preNetwork: true };
      }
    }

    const { getSelectedPageToken } = await import("@/lib/server/facebook/connectionStore");
    // Name the account to publish as. With several Facebook accounts connected,
    // the store refuses to guess — the destination the merchant selected carries
    // the connection id, and that is the target.
    const selected = await getSelectedPageToken(userId, input.connection?.id);
    // null covers every not-publishable state (no row, disconnected, reconnect
    // required, no Page selected, undecryptable token) — one clean message.
    if (!selected) {
      return { ok: false, status: "failed", error: "Connect a Facebook Page first.", preNetwork: true };
    }

    const { publishToPage, FacebookApiError } = await import("@/lib/server/facebook/service");
    try {
      const result = await publishToPage(selected.pageAccessToken, selected.pageId, {
        // Facebook has no separate title field — title and caption are one body.
        message: [input.post.title?.trim(), input.post.caption?.trim()].filter(Boolean).join("\n\n"),
        // Cover first, then the rest — publishToPage sends ALL of them (one photo
        // post for a single image, a multi-photo feed post for several).
        imageUrl: imageUrls[0] ?? null,
        imageUrls,
        link: input.post.destinationUrl ?? null,
      });
      return {
        ok: true,
        status: "published",
        externalPostId: result.externalPostId,
        externalPostUrl: result.permalink,
        accountName: selected.pageName ?? null,
      };
    } catch (err) {
      // FacebookApiError messages are Meta's own text (already token-free — the
      // service never embeds the token or the request URL). Anything else gets a
      // generic message so no internal detail reaches the merchant.
      const message = err instanceof FacebookApiError
        ? err.message
        : "Could not publish to Facebook. Please try again.";
      // Graph's OWN status, only when Graph really answered. Anything else (a
      // socket error, a timeout, a bug in our code) leaves it null, which the
      // refund classifier reads as `delivery_unknown` and keeps the charge —
      // deliberately, since we cannot prove the post was not created. See
      // lib/server/usage/deliveryOutcome.ts.
      const providerStatus = err instanceof FacebookApiError ? err.status : null;
      return { ok: false, status: "failed", error: message, providerStatus, providerResourceId: null };
    }
  },

  async disconnect(input: DisconnectInput): Promise<void> {
    if (input.provider === "facebook") {
      const { disconnectFacebookConnection } = await import("@/lib/server/facebook/connectionStore");
      // Name the row: with several accounts connected, disconnecting one must
      // leave the others signed in.
      await disconnectFacebookConnection(input.userId, input.connectionId);
      return;
    }
    if (input.provider === "instagram") {
      const { disconnectInstagramConnection } = await import("@/lib/server/instagram/connectionStore");
      await disconnectInstagramConnection(input.userId, input.connectionId);
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
    // Same contract as the Facebook branch: refused before any Instagram call, so
    // `preNetwork` (→ `not_sent`, refundable) rather than an unexplained failure the
    // usage classifier would have to charge as `delivery_unknown`.
    return { ok: false, status: "failed", error: "Connect an Instagram account first.", preNetwork: true };
  }

  const { getInstagramAccessToken } = await import("@/lib/server/instagram/connectionStore");
  // Name the account to publish as — same contract as Facebook: with several
  // connected the store refuses to guess, and the selected destination carries
  // the connection id that identifies the target.
  const connection = await getInstagramAccessToken(userId, input.connection?.id);
  if (!connection?.userId) {
    return { ok: false, status: "failed", error: "Connect an Instagram account first.", preNetwork: true };
  }

  // Every image the Content carries, in display order — never just the cover.
  const imageUrls = (input.post.imageUrls ?? []).filter(u => typeof u === "string" && u.trim());
  if (!imageUrls.length) {
    return { ok: false, status: "failed", error: "Instagram posts need an image.", preNetwork: true };
  }
  // Count limits decided before any API call, so an over-long set gets an
  // actionable message instead of publishing a silently truncated carousel.
  const media = checkInstagramMedia(toMediaItems(imageUrls));
  if (!media.ok) {
    return { ok: false, status: "failed", error: media.message, preNetwork: true };
  }

  const { publishToInstagram, InstagramApiError } = await import("@/lib/server/instagram/service");
  try {
    const result = await publishToInstagram({
      accessToken: connection.accessToken,
      igUserId: connection.userId,
      imageUrl: imageUrls[0],
      imageUrls,
      // Instagram has no separate title field — title and caption are one body.
      caption: [input.post.title?.trim(), input.post.caption?.trim()].filter(Boolean).join("\n\n"),
      destinationUrl: input.post.destinationUrl ?? undefined,
    });
    return {
      ok: true,
      status: "published",
      externalPostId: result.mediaId,
      externalPostUrl: result.permalink,
      accountName: connection.username ?? null,
    };
  } catch (err) {
    const message = err instanceof InstagramApiError
      ? err.message
      : "Could not publish to Instagram. Please try again.";
    // Same contract as the Facebook branch: a real Instagram status or nothing.
    const providerStatus = err instanceof InstagramApiError ? err.status : null;
    return { ok: false, status: "failed", error: message, providerStatus, providerResourceId: null };
  }
}
