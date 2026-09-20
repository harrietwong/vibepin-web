import type { PublishDestination } from "@/lib/contentDraftModel";
import {
  sha256Hex,
  stablePublishString,
  type ConfirmedPublishReceipt,
} from "@/lib/studio/publishConfirmation";
import type {
  PinterestVideoPublishResult,
} from "@/lib/server/pinterest/videoPinAdapter";

export type DurableVideoPublishState =
  | { kind: "missing" }
  | { kind: "prepared" }
  | { kind: "ready" }
  | { kind: "claimed"; claimToken: string; attempt: number }
  | { kind: "attempt_started"; attemptId: string; claimToken: string; stale: boolean }
  | { kind: "published"; remoteId: string; remoteUrl?: string; evidence: Record<string, unknown> }
  | { kind: "failed"; evidence: Record<string, unknown> }
  | { kind: "delivery_unknown"; evidence: Record<string, unknown> };

export type MaterializedVideoSource = {
  mediaId: string;
  ordinal: number;
  bucketId: "generated-private";
  /** Original owner-authorized upload locator; null only when replaying an already-ready copy. */
  sourceObjectPath: string | null;
  objectPath: string;
  contentType: "video/mp4" | "video/x-m4v" | "video/quicktime";
  byteSize: number;
  checksumSha256: string;
  fileName: string;
  file: Blob;
};

export type DurableVideoPublishInput = {
  uid: string;
  receipt: ConfirmedPublishReceipt;
  destination: PublishDestination;
  /** Present for due execution. A future value is rejected before any durable write. */
  scheduleAt?: string;
  /** Cron deadline: no destination starts after this instant. */
  latestStartMs?: number;
  nowMs?: number;
};

export type DurableVideoPublishResult = {
  outcome: "published" | "failed" | "delivery_unknown" | "in_progress" | "not_due";
  replayed?: boolean;
  retryAllowed: boolean;
  reconcileRequired?: boolean;
  remoteId?: string;
  remoteUrl?: string;
  evidence?: Record<string, unknown>;
};

export type DurableAttemptSettlement = "succeeded" | "failed" | "unknown";

export type DurableVideoPublishDependencies = {
  inspect(input: DurableVideoPublishInput): Promise<DurableVideoPublishState>;
  confirmPrepare(input: DurableVideoPublishInput): Promise<void>;
  leaseMaterialization(input: DurableVideoPublishInput): Promise<{ leaseToken: string; deliveryId: string }>;
  materializeSources(
    input: DurableVideoPublishInput,
    lease: { leaseToken: string; deliveryId: string },
  ): Promise<MaterializedVideoSource[]>;
  loadReadySources(input: DurableVideoPublishInput): Promise<MaterializedVideoSource[]>;
  settleItem(
    input: DurableVideoPublishInput,
    lease: { leaseToken: string; deliveryId: string },
    source: MaterializedVideoSource,
  ): Promise<{ deliveryReady: boolean }>;
  claimReady(
    input: DurableVideoPublishInput,
    lease: { leaseToken: string; deliveryId: string },
  ): Promise<{ claimToken: string; attempt: number }>;
  startAttempt(
    input: DurableVideoPublishInput,
    claim: { claimToken: string; attempt: number },
  ): Promise<{ attemptId: string; status: DurableAttemptSettlement | "started"; replayed: boolean }>;
  publishVideo(
    input: DurableVideoPublishInput,
    source: MaterializedVideoSource,
  ): Promise<PinterestVideoPublishResult>;
  settleAttempt(
    input: DurableVideoPublishInput,
    status: DurableAttemptSettlement,
    attempt: { attemptId: string; claimToken: string },
    provider?: PinterestVideoPublishResult,
  ): Promise<void>;
};

type V76Rpc = (name: string, args: Record<string, unknown>) => Promise<unknown>;

export type V76RpcVideoPublishBoundary = {
  rpc: V76Rpc;
  inspect: DurableVideoPublishDependencies["inspect"];
  materializeSources: DurableVideoPublishDependencies["materializeSources"];
  loadReadySources: DurableVideoPublishDependencies["loadReadySources"];
  publishVideo: DurableVideoPublishDependencies["publishVideo"];
};

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("v76_rpc_invalid_result");
  return value as Record<string, unknown>;
}

export function videoPublishSourceIdentityFingerprint(receipt: ConfirmedPublishReceipt): string {
  return sha256Hex(stablePublishString({
    draftId: receipt.draftId,
    contentId: receipt.contentId,
    title: receipt.title,
    description: receipt.description,
    altText: receipt.altText,
    destinationUrl: receipt.destinationUrl,
    media: receipt.media.map(item => ({
      id: item.id,
      kind: item.kind,
      url: item.url,
      source: item.source ?? null,
      width: item.width ?? null,
      height: item.height ?? null,
      durationMs: item.kind === "video" ? item.durationMs ?? null : null,
      posterUrl: item.kind === "video" ? item.posterUrl?.trim() || null : null,
      ...(item.kind === "video" && item.coverFrameTimeMs !== undefined ? { coverFrameTimeMs: item.coverFrameTimeMs } : {}),
      altText: item.kind === "video" ? item.altText?.trim() || null : null,
    })),
    destinations: receipt.publishableDestinations.map(item => ({
      id: item.id,
      provider: item.provider,
      socialConnectionId: item.socialConnectionId,
      boardId: item.boardId ?? null,
    })).sort((left, right) => left.id.localeCompare(right.id)),
    dispatchDestinationIds: [...receipt.dispatchDestinationIds].sort(),
  }));
}

function requiredText(value: unknown, code: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(code);
  return text;
}

function canonicalPinterestUrl(pinId: string | undefined, pinUrl?: string): string | undefined {
  if (pinUrl) return pinUrl;
  return pinId && /^[0-9]+$/.test(pinId)
    ? `https://www.pinterest.com/pin/${pinId}/`
    : undefined;
}

/** Bind the orchestrator to the existing v76 service-role RPC surface. */
export function createV76RpcVideoPublishDependencies(
  boundary: V76RpcVideoPublishBoundary,
): DurableVideoPublishDependencies {
  return {
    inspect: boundary.inspect,
    async confirmPrepare(input) {
      await boundary.rpc("publish_intent_confirm_prepare_v78", {
        p_user_id: input.uid,
        p_receipt: input.receipt,
        p_source_identity_fingerprint: videoPublishSourceIdentityFingerprint(input.receipt),
      });
    },
    async leaseMaterialization(input) {
      const value = record(await boundary.rpc("publish_asset_lease_materialization", {
        p_user_id: input.uid,
        p_intent_id: input.receipt.intentId,
        p_destination_id: input.destination.id,
        p_lease_token: globalThis.crypto.randomUUID(),
        p_lease_seconds: 300,
      }));
      return {
        leaseToken: requiredText(value.leaseToken, "materialization_lease_missing"),
        deliveryId: requiredText(value.deliveryId, "materialization_delivery_missing"),
      };
    },
    materializeSources: boundary.materializeSources,
    loadReadySources: boundary.loadReadySources,
    async settleItem(input, lease, source) {
      const sourceObjectPath = requiredText(source.sourceObjectPath, "video_source_locator_missing");
      const value = record(await boundary.rpc("publish_asset_settle_video_item_v79", {
        p_user_id: input.uid,
        p_intent_id: input.receipt.intentId,
        p_destination_id: input.destination.id,
        p_lease_token: lease.leaseToken,
        p_source_media_key: source.mediaId,
        p_media_ordinal: source.ordinal,
        p_source_bucket_id: source.bucketId,
        p_source_object_path: sourceObjectPath,
        p_target_bucket_id: source.bucketId,
        p_target_object_path: source.objectPath,
        p_server_checksum_sha256: source.checksumSha256,
      }));
      return { deliveryReady: value.deliveryReady === true };
    },
    async claimReady(input) {
      const claimToken = globalThis.crypto.randomUUID();
      const value = record(await boundary.rpc("publish_asset_claim_ready_v78", {
        p_user_id: input.uid,
        p_intent_id: input.receipt.intentId,
        p_destination_id: input.destination.id,
        p_claim_token: claimToken,
      }));
      // v76 originally omitted attempt from this result; attempt one remains
      // compatible while retry children return their inherited ordinal.
      const attempt = Number(value.attempt ?? 1);
      if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error("publish_attempt_missing");
      return { claimToken: requiredText(value.claimToken, "publish_claim_missing"), attempt };
    },
    async startAttempt(input, claim) {
      const value = record(await boundary.rpc("publish_provider_attempt_start", {
        p_user_id: input.uid,
        p_intent_id: input.receipt.intentId,
        p_destination_id: input.destination.id,
        p_claim_token: claim.claimToken,
        p_attempt: claim.attempt,
      }));
      const status = requiredText(value.status, "provider_attempt_status_missing");
      if (status !== "started" && status !== "succeeded" && status !== "failed" && status !== "unknown") {
        throw new Error("provider_attempt_status_invalid");
      }
      return {
        attemptId: requiredText(value.attemptId, "provider_attempt_id_missing"),
        status,
        replayed: value.replayed === true,
      };
    },
    publishVideo: boundary.publishVideo,
    async settleAttempt(input, status, attempt, provider) {
      const succeeded = status === "succeeded" ? provider?.evidence : undefined;
      const remoteUrl = canonicalPinterestUrl(succeeded?.pinId, succeeded?.pinUrl);
      const providerEvidence = provider?.evidence;
      await boundary.rpc("publish_provider_attempt_settle_v78", {
        p_user_id: input.uid,
        p_attempt_id: attempt.attemptId,
        p_claim_token: attempt.claimToken,
        p_status: status,
        p_provider_status: providerEvidence?.providerStatus ?? (status === "succeeded" ? 201 : null),
        p_remote_id: succeeded?.pinId ?? null,
        p_remote_url: remoteUrl ?? null,
        // Keep the adapter's already-sanitized receipt intact. The old wrapper
        // reduced every rejection to provider/reason, losing stage, status,
        // provider code and request id needed for diagnosis and reconciliation.
        p_evidence: {
          ...(providerEvidence ?? {}),
          provider: "pinterest",
          reason: status === "succeeded"
            ? "non_retryable"
            : status === "failed"
              ? "provider_rejected"
              : "unknown_outcome",
        },
      });
    },
  };
}

function unknownResult(
  evidence: Record<string, unknown> = {},
  reconcileRequired = false,
): DurableVideoPublishResult {
  return {
    outcome: "delivery_unknown",
    retryAllowed: false,
    reconcileRequired,
    evidence,
  };
}

function isLeaseCompetition(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("already_leased")
    || message.includes("already_claimed")
    || message.includes("not_ready_or_already_claimed")
    || message.includes("claim_lost");
}

/**
 * The single ordering boundary for immediate and due Pinterest video delivery.
 * Provider dispatch is reachable only after a ready claim and a durable attempt.
 */
export async function dispatchV76PinterestVideo(
  input: DurableVideoPublishInput,
  deps: DurableVideoPublishDependencies,
): Promise<DurableVideoPublishResult> {
  const nowMs = input.nowMs ?? Date.now();
  const scheduleMs = input.scheduleAt ? Date.parse(input.scheduleAt) : Number.NaN;
  if ((Number.isFinite(scheduleMs) && scheduleMs > nowMs)
      || (typeof input.latestStartMs === "number" && nowMs > input.latestStartMs)) {
    return { outcome: "not_due", retryAllowed: false };
  }

  const prior = await deps.inspect(input);
  if (prior.kind === "published") {
    return {
      outcome: "published",
      replayed: true,
      retryAllowed: false,
      remoteId: prior.remoteId,
      remoteUrl: prior.remoteUrl,
      evidence: prior.evidence,
    };
  }
  if (prior.kind === "delivery_unknown") return unknownResult(prior.evidence);
  if (prior.kind === "failed") {
    return {
      outcome: "failed",
      replayed: true,
      retryAllowed: true,
      evidence: prior.evidence,
    };
  }
  if (prior.kind === "attempt_started") {
    if (!prior.stale) return { outcome: "in_progress", retryAllowed: false };
    try {
      await deps.settleAttempt(
        input,
        "unknown",
        { attemptId: prior.attemptId, claimToken: prior.claimToken },
      );
    } catch {
      // The durable row is still started. Either state forbids another dispatch.
    }
    return unknownResult({ reason: "process_loss_after_provider_attempt" }, true);
  }

  if (prior.kind === "missing") await deps.confirmPrepare(input);

  let lease: Awaited<ReturnType<DurableVideoPublishDependencies["leaseMaterialization"]>> = {
    leaseToken: "durable-ready-replay",
    deliveryId: "durable-ready-replay",
  };
  if (prior.kind !== "ready" && prior.kind !== "claimed") {
    try {
      lease = await deps.leaseMaterialization(input);
    } catch (error) {
      if (isLeaseCompetition(error)) return { outcome: "in_progress", retryAllowed: false };
      throw error;
    }
  }

  const sources = prior.kind === "ready" || prior.kind === "claimed"
    ? await deps.loadReadySources(input)
    : await deps.materializeSources(input, lease);
  if (!sources.length || sources.length !== input.receipt.media.length) {
    return { outcome: "failed", retryAllowed: true, evidence: { reason: "materialization_incomplete" } };
  }
  let deliveryReady = prior.kind === "ready" || prior.kind === "claimed";
  if (!deliveryReady) {
    for (const source of [...sources].sort((left, right) => left.ordinal - right.ordinal)) {
      const settled = await deps.settleItem(input, lease, source);
      deliveryReady = settled.deliveryReady;
    }
  }
  if (!deliveryReady) return { outcome: "in_progress", retryAllowed: false };

  let claim: { claimToken: string; attempt: number };
  if (prior.kind === "claimed") {
    claim = { claimToken: prior.claimToken, attempt: prior.attempt };
  } else {
    try {
      claim = await deps.claimReady(input, lease);
    } catch (error) {
      if (isLeaseCompetition(error)) return { outcome: "in_progress", retryAllowed: false };
      throw error;
    }
  }
  const started = await deps.startAttempt(input, claim);
  if (started.status === "started" && started.replayed) {
    return { outcome: "in_progress", retryAllowed: false };
  }
  if (started.status !== "started") {
    return started.status === "succeeded"
      ? { outcome: "published", replayed: true, retryAllowed: false }
      : started.status === "failed"
        ? { outcome: "failed", replayed: true, retryAllowed: true }
        : unknownResult({ reason: "provider_attempt_replayed_unknown" });
  }

  let provider: PinterestVideoPublishResult;
  try {
    provider = await deps.publishVideo(input, sources[0]);
  } catch {
    // The durable attempt is already started. Even a local exception at the provider
    // boundary is indistinguishable from a request that left the process before its
    // response was observed, so it is never allowed to escape into a retryable path.
    try {
      await deps.settleAttempt(
        input,
        "unknown",
        { attemptId: started.attemptId, claimToken: claim.claimToken },
      );
    } catch {
      // A still-started attempt is equally non-retryable and is reconciled on replay.
    }
    return unknownResult({ reason: "provider_boundary_exception" }, true);
  }
  const settlement: DurableAttemptSettlement = provider.outcome === "succeeded"
    ? "succeeded"
    : provider.outcome === "failed"
      ? "failed"
      : "unknown";
  try {
    await deps.settleAttempt(
      input,
      settlement,
      { attemptId: started.attemptId, claimToken: claim.claimToken },
      provider,
    );
  } catch {
    // Once the adapter could have created a Pin, a persistence outage is ambiguous.
    // Never turn it into an ordinary retryable failure.
    return unknownResult({ ...provider.evidence, reason: "provider_settlement_unavailable" }, true);
  }

  if (provider.outcome === "succeeded") {
    return {
      outcome: "published",
      retryAllowed: false,
      remoteId: provider.evidence.pinId,
      remoteUrl: canonicalPinterestUrl(provider.evidence.pinId, provider.evidence.pinUrl),
      evidence: provider.evidence,
    };
  }
  if (provider.outcome === "failed") {
    return { outcome: "failed", retryAllowed: true, evidence: provider.evidence };
  }
  return unknownResult(provider.evidence);
}
