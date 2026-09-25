/**
 * v76InstagramReelsDue.ts — the due-time (cron) binding for one private Instagram Reel.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────
 * `/api/cron/publish-due` used to hand every non-Pinterest destination to the image
 * fan-out with `imageUrls: input.imageUrls`. For a single-video Content that list IS
 * the private mp4, so Instagram received a video as an image and was refused before
 * the network ("Image URL must be publicly reachable for Instagram to fetch it"):
 * scheduled Reels could not be published from the server at all.
 *
 * This is the scheduled twin of `/api/publish/social`'s private-Reel branch. Both go
 * through `dispatchSupabaseV76InstagramReel`, i.e. the SAME durable state machine,
 * materializer and provenance checks as Pinterest video — the provider receives only
 * a short-lived signed URL for the intent-bound private copy, never the draft source.
 *
 * ── WHAT IT ADDS OVER THE DISPATCHER: THE PROVIDER'S OWN WORDS ─────────────────
 * The Reels settle path (v78) stores only `{provider, reason}`; the Instagram error
 * text is gone by the time a `DurableVideoPublishResult` comes back. The cron route
 * must not write a fixed sentence for every rejection (that was 故障 B for Pinterest,
 * see videoEvidence.ts), so the provider result is captured here, in the closure,
 * and returned beside the durable result. It is display-only: it never changes the
 * durable outcome and never travels to a settle RPC.
 *
 * The message is sanitized with the Pinterest adapter's own `safeProviderMessage`
 * (imported, not re-implemented), with the signed URL registered as a sensitive
 * value — a Meta error that echoes the media URL must not put a signed storage URL
 * into a merchant-visible row.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { PublishDestination } from "@/lib/contentDraftModel";
import type { ConfirmedPublishReceipt } from "@/lib/studio/publishConfirmation";
import type { PublishResult, SocialConnection } from "@/lib/social/types";
import { safeProviderMessage } from "@/lib/server/pinterest/videoPinAdapter";
import { dispatchSupabaseV76InstagramReel } from "./v76InstagramReelsServer";
import type { DurableVideoPublishResult } from "./v76PinterestVideoPublish";
import { reelPostTitle } from "@/lib/publish/reelCopy";

/** What the Instagram provider actually answered on THIS dispatch, when it was asked. */
export type DueReelProviderObservation = {
  /** Sanitized provider/connection message, or undefined when unsafe/absent. */
  message?: string;
  /** Instagram's HTTP status — only when one was really observed on the network. */
  providerStatus?: number;
  /** Decided before any Instagram call (no connection, local media refusal). */
  preNetwork: boolean;
};

export type DueReelDispatchResult = {
  result: DurableVideoPublishResult;
  /** Null when the provider was never asked this round (replay, orchestration failure). */
  observed: DueReelProviderObservation | null;
};

/** The two lookups the provider callback needs. Injectable for tests only. */
export type DueReelSocialDeps = {
  findConnection(uid: string, connectionId: string): Promise<SocialConnection | null>;
  getSocialProviderById: typeof import("@/lib/social/providers").getSocialProviderById;
};

async function loadSocialDeps(): Promise<DueReelSocialDeps> {
  const [store, providers] = await Promise.all([
    import("@/lib/social/server/socialConnectionStore"),
    import("@/lib/social/providers"),
  ]);
  return { findConnection: store.findConnection, getSocialProviderById: providers.getSocialProviderById };
}

export async function dispatchDueInstagramReel(
  db: SupabaseClient,
  input: {
    uid: string;
    receipt: ConfirmedPublishReceipt;
    destination: PublishDestination;
    scheduleAt?: string;
    latestStartMs?: number;
    /** The stored draft's `copyProfile` (read by the caller from the owner's
     *  row). "instagram_caption" ⇒ no title is sent (reelCopy.ts). Never put into
     *  the receipt: it is not part of the confirmation fingerprint. */
    copyProfile?: unknown;
  },
  socialDeps?: DueReelSocialDeps,
): Promise<DueReelDispatchResult> {
  let observed: DueReelProviderObservation | null = null;
  const connectionId = input.destination.socialConnectionId?.trim() ?? "";
  const result = await dispatchSupabaseV76InstagramReel({
    db,
    publishInput: {
      uid: input.uid,
      receipt: input.receipt,
      destination: input.destination,
      ...(input.scheduleAt ? { scheduleAt: input.scheduleAt } : {}),
      ...(typeof input.latestStartMs === "number" ? { latestStartMs: input.latestStartMs } : {}),
    },
    // Reached only after v76 has materialized, settled, claimed and started a durable
    // attempt — exactly as in the immediate route.
    publishReel: async (current, signedFrozenCopyUrl) => {
      const sensitive = new Set([signedFrozenCopyUrl]);
      const remember = (res: PublishResult): PublishResult => {
        const preNetwork = res.preNetwork === true;
        observed = {
          message: safeProviderMessage(res.error ?? undefined, sensitive),
          ...(!preNetwork && typeof res.providerStatus === "number" ? { providerStatus: res.providerStatus } : {}),
          preNetwork,
        };
        return res;
      };
      // Loaded here, not at module scope: the cron route imports this module for
      // every run, and the connection store / provider registry (and the Supabase
      // client they construct) are only needed once a durable attempt has started.
      // Same lazy pattern as the Instagram provider's own service import. A load
      // failure is decided before any Instagram call, hence preNetwork.
      let connection: SocialConnection | null;
      let deps: DueReelSocialDeps;
      try {
        deps = socialDeps ?? await loadSocialDeps();
        connection = await deps.findConnection(current.uid, connectionId);
      } catch {
        return remember({ ok: false, status: "failed", error: "Could not prepare the Instagram connection.", preNetwork: true });
      }
      if (!connection || connection.connectionStatus !== "connected") {
        return remember({ ok: false, status: "failed", error: "Reconnect your Instagram account to publish this Reel.", preNetwork: true });
      }
      // Do not catch this provider-boundary call: it may have reached Meta. The
      // durable dispatcher records a thrown delivery as unknown and forbids a blind
      // retry.
      return remember(await deps.getSocialProviderById(connection.authProvider).publishPost({
        provider: "instagram",
        connection,
        // The FROZEN copy the schedule authorized, not the live draft: the same
        // source of truth the Pinterest video path reads (`current.receipt`).
        post: {
          // A split-off IG child's description IS the caption — no title (Fable
          // ruling 2); every other Reel keeps the frozen title as before.
          title: reelPostTitle(input.copyProfile, current.receipt.title),
          caption: current.receipt.description || undefined,
          destinationUrl: current.receipt.destinationUrl || undefined,
          altText: current.receipt.altText || undefined,
          imageUrls: [],
          videoUrls: [signedFrozenCopyUrl],
        },
        userId: current.uid,
      }));
    },
  });
  return { result, observed };
}
