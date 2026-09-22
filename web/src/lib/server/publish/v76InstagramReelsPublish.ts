import {
  dispatchV76PinterestVideo,
  type DurableAttemptSettlement,
  type DurableVideoPublishDependencies,
  type DurableVideoPublishInput,
  type DurableVideoPublishResult,
  type MaterializedVideoSource,
} from "./v76PinterestVideoPublish";

export type InstagramReelPublishEvidence = {
  stage: string;
  classification: string;
  providerStatus?: number;
  remoteId?: string;
  remoteUrl?: string;
};

export type InstagramReelPublishResult = {
  outcome: "succeeded" | "failed" | "unknown";
  evidence: InstagramReelPublishEvidence;
};

export type InstagramReelPublishDependencies = Omit<DurableVideoPublishDependencies, "publishVideo" | "settleAttempt"> & {
  publishReel(input: DurableVideoPublishInput, source: MaterializedVideoSource): Promise<InstagramReelPublishResult>;
  settleAttempt(
    input: DurableVideoPublishInput,
    status: DurableAttemptSettlement,
    attempt: { attemptId: string; claimToken: string },
    provider?: InstagramReelPublishResult,
  ): Promise<void>;
};

function is2xx(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 200 && value < 300;
}

function is4xx(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 400 && value < 500;
}

function isSynthesizedPinterestFallback(remoteId: string | undefined, remoteUrl: string | undefined): boolean {
  return !!remoteId
    && remoteUrl === `https://www.pinterest.com/pin/${remoteId}/`;
}

/**
 * Converts the existing durable video state machine into an Instagram Reel
 * boundary. The Instagram provider is called only after the intent-bound copy
 * has been materialized, settled, claimed, and given a durable attempt.
 */
export async function dispatchV76InstagramReel(
  input: DurableVideoPublishInput,
  deps: InstagramReelPublishDependencies,
): Promise<DurableVideoPublishResult> {
  const published = new WeakMap<object, InstagramReelPublishResult>();
  let materializationFailed = false;
  const result = await dispatchV76PinterestVideo(input, {
    ...deps,
    async materializeSources(current, lease) {
      try {
        return await deps.materializeSources(current, lease);
      } catch {
        // Pinterest recovery consumers rely on provenance conflicts escaping the
        // shared state machine. A Reel route instead owns this pre-provider
        // boundary and may safely return a retryable failure/refund it upstream.
        materializationFailed = true;
        return [];
      }
    },
    async publishVideo(current, source) {
      const provider = await deps.publishReel(current, source);
      const evidence = provider.evidence;
      // A claimed success without both a real provider status and remote media id
      // is ambiguous. Never let it create a retryable terminal state.
      const effectiveOutcome = provider.outcome === "succeeded" && (!is2xx(evidence.providerStatus) || !evidence.remoteId)
        ? "unknown" as const
        // Only an explicit provider 4xx that created no resource is retryable.
        : provider.outcome === "failed" && (!is4xx(evidence.providerStatus) || evidence.remoteId)
          ? "unknown" as const
          : provider.outcome;
      const mapped = {
        outcome: effectiveOutcome,
        evidence: {
          stage: "created" as const,
          classification: effectiveOutcome === "succeeded" ? "succeeded" as const : effectiveOutcome === "failed" ? "definite_rejection" as const : "unknown" as const,
          providerStatus: evidence.providerStatus,
          pinId: evidence.remoteId,
          pinUrl: evidence.remoteUrl,
        },
      };
      published.set(mapped, effectiveOutcome === provider.outcome ? provider : { outcome: "unknown", evidence: { ...evidence, classification: "unknown" } });
      return mapped;
    },
    async settleAttempt(current, status, attempt, provider) {
      const original = provider && published.get(provider as object);
      await deps.settleAttempt(current, status, attempt, original);
    },
  });
  if (materializationFailed && result.outcome === "failed") {
    return { ...result, evidence: { reason: "materialization_failed" } };
  }
  // A fresh call still passes through the shared state machine, which can synthesize
  // this exact Pinterest URL for a numeric id. Strip only that synthetic fallback:
  // v78 replay evidence deliberately omits `pinUrl`, while `remote_url` stores a
  // safe Instagram permalink and must remain available to the social UI projection.
  if (result.outcome === "published" && isSynthesizedPinterestFallback(result.remoteId, result.remoteUrl)) {
    const { remoteUrl: _pinterestFallback, ...withoutPinterestFallback } = result;
    return withoutPinterestFallback;
  }
  return result;
}
