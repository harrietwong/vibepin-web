import type { SupabaseClient } from "@supabase/supabase-js";
import type { PublishResult } from "@/lib/social/types";
import {
  createSupabaseV76VideoPublishDependencies,
} from "./v76PinterestVideoRuntime";
import type {
  DurableVideoPublishInput,
  DurableVideoPublishResult,
  MaterializedVideoSource,
} from "./v76PinterestVideoPublish";
import {
  dispatchV76InstagramReel,
  type InstagramReelPublishDependencies,
  type InstagramReelPublishResult,
} from "./v76InstagramReelsPublish";

/** v78 delegates to v76, whose JSONB evidence contract permits only these two
 * string fields. Transport/result facts are carried by the typed RPC args. */
export function instagramReelV78SettlementEvidence(status: DurableAttemptSettlement): {
  provider: "instagram";
  reason: "non_retryable" | "provider_rejected" | "unknown_outcome";
} {
  return {
    provider: "instagram",
    reason: status === "succeeded"
      ? "non_retryable"
      : status === "failed"
        ? "provider_rejected"
        : "unknown_outcome",
  };
}

function dbError(error: { code?: string; message?: string } | null, fallback: string): Error {
  return Object.assign(new Error(error?.message || error?.code || fallback), { code: error?.code });
}

function safeInstagramPermalink(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    if (parsed.protocol !== "https:" || (host !== "instagram.com" && host !== "www.instagram.com")
        || parsed.search || parsed.hash) return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

export function instagramReelProviderResult(result: PublishResult): InstagramReelPublishResult {
  const remoteId = result.externalPostId ?? result.providerResourceId ?? undefined;
  const remoteUrl = safeInstagramPermalink(result.externalPostUrl);
  if (result.ok) {
    return { outcome: "succeeded", evidence: { stage: "provider", classification: "succeeded", providerStatus: result.providerStatus ?? undefined, remoteId, remoteUrl } };
  }
  if (result.preNetwork === true) {
    return { outcome: "failed", evidence: { stage: "pre_network", classification: "definite_rejection", providerStatus: 400 } };
  }
  if (typeof result.providerStatus === "number" && result.providerStatus >= 400 && result.providerStatus < 500 && !remoteId) {
    return { outcome: "failed", evidence: { stage: "provider", classification: "definite_rejection", providerStatus: result.providerStatus } };
  }
  return { outcome: "unknown", evidence: { stage: "provider", classification: "unknown", ...(typeof result.providerStatus === "number" ? { providerStatus: result.providerStatus } : {}) } };
}

/** The only signing seam for Instagram Reels. A provider can receive a URL only
 * for the materialized intent copy, never the draft's owner-authorized source. */
export async function publishFrozenInstagramReel(input: {
  db: SupabaseClient;
  input: DurableVideoPublishInput;
  source: MaterializedVideoSource;
  publishReel(input: DurableVideoPublishInput, signedFrozenCopyUrl: string): Promise<PublishResult>;
}): Promise<InstagramReelPublishResult> {
  if (!input.source.objectPath.startsWith(`${input.input.uid}/publish/`)
      || (input.source.sourceObjectPath !== null && input.source.objectPath === input.source.sourceObjectPath)) {
    return { outcome: "failed", evidence: { stage: "pre_network", classification: "definite_rejection", providerStatus: 400 } };
  }
  const signed = await input.db.storage.from(input.source.bucketId).createSignedUrl(input.source.objectPath, 300);
  if (signed.error || !signed.data?.signedUrl) {
    return { outcome: "failed", evidence: { stage: "pre_network", classification: "definite_rejection", providerStatus: 400 } };
  }
  return instagramReelProviderResult(await input.publishReel(input.input, signed.data.signedUrl));
}

/** Server binding for one private Instagram Reel. It signs only the frozen,
 * intent-bound publish copy and only after the durable attempt starts. */
export async function dispatchSupabaseV76InstagramReel(input: {
  db: SupabaseClient;
  publishInput: DurableVideoPublishInput;
  publishReel(input: DurableVideoPublishInput, signedFrozenCopyUrl: string): Promise<PublishResult>;
}): Promise<DurableVideoPublishResult> {
  const base = createSupabaseV76VideoPublishDependencies({
    db: input.db,
    loadPinterestEvidence: false,
    synthesizePinterestUrl: false,
    publishVideo: async () => ({ outcome: "unknown", evidence: { stage: "validated", classification: "unknown" } }),
  });
  const deps: InstagramReelPublishDependencies = {
    ...base,
    async publishReel(current, source) {
      return publishFrozenInstagramReel({ db: input.db, input: current, source, publishReel: input.publishReel });
    },
    async settleAttempt(current, status, attempt, provider) {
      const evidence = provider?.evidence;
      const { error } = await input.db.rpc("publish_provider_attempt_settle_v78", {
        p_user_id: current.uid,
        p_attempt_id: attempt.attemptId,
        p_claim_token: attempt.claimToken,
        p_status: status,
        p_provider_status: evidence?.providerStatus ?? null,
        p_remote_id: status === "succeeded" ? evidence?.remoteId ?? null : null,
        p_remote_url: status === "succeeded" ? evidence?.remoteUrl ?? null : null,
        p_evidence: instagramReelV78SettlementEvidence(status),
      });
      if (error) throw dbError(error, "publish_provider_attempt_settle_v78_failed");
    },
  };
  return dispatchV76InstagramReel(input.publishInput, deps);
}
