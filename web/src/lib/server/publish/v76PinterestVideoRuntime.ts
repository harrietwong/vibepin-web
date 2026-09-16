import { stablePublishString } from "@/lib/studio/publishConfirmation";
import type {
  DurableVideoPublishDependencies,
  DurableVideoPublishInput,
  DurableVideoPublishState,
  MaterializedVideoSource,
} from "./v76PinterestVideoPublish";
import { createV76RpcVideoPublishDependencies } from "./v76PinterestVideoPublish";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { PinterestVideoPublishResult } from "@/lib/server/pinterest/videoPinAdapter";

const PRIVATE_BUCKET = "generated-private" as const;
const VIDEO_TYPES = new Set(["video/mp4", "video/x-m4v", "video/quicktime"]);

export type PrivateVideoProvenance = {
  ownerUserId: string;
  bucketId: string;
  objectPath: string;
  mediaKind: string;
  contentType: string;
  byteSize: number;
  checksumSha256: string;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  lifecycleState: string;
};

export type PrivateVideoMaterializationBoundary = {
  loadDraft(uid: string, draftId: string): Promise<{
    updatedAt: string;
    payload: Record<string, unknown>;
  } | null>;
  findProvenance(uid: string, bucket: string, objectPath: string): Promise<PrivateVideoProvenance | null>;
  download(bucket: string, objectPath: string): Promise<Blob>;
  storePublishCopy(input: {
    uid: string;
    intentId: string;
    sourcePath: string;
    targetPath: string;
    contentType: MaterializedVideoSource["contentType"];
    byteSize: number;
    checksumSha256: string;
    width: number | null;
    height: number | null;
    durationMs: number | null;
    file: Blob;
  }): Promise<void>;
};

function videoPath(value: string): string | null {
  try {
    const parsed = new URL(value, "https://vibepin.invalid");
    if (parsed.origin !== "https://vibepin.invalid"
        || parsed.pathname !== "/api/storage-media"
        || parsed.hash
        || parsed.searchParams.getAll("path").length !== 1
        || [...parsed.searchParams.keys()].some(key => key !== "path")) return null;
    const path = parsed.searchParams.get("path")?.trim() ?? "";
    if (!path || path.startsWith("/") || path.includes("..") || path.includes("//") || path.includes("\\")) return null;
    return path;
  } catch {
    return null;
  }
}

async function sha256(value: ArrayBuffer | string): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function exactMediaIdentity(media: unknown): string {
  if (!Array.isArray(media)) return "[]";
  return stablePublishString(media.map(value => {
    const row = value && typeof value === "object" ? value as Record<string, unknown> : {};
    return {
      id: typeof row.id === "string" ? row.id : "",
      kind: row.kind === "video" ? "video" : row.kind === "image" ? "image" : "",
      url: typeof row.url === "string" ? row.url : "",
      durationMs: typeof row.durationMs === "number" ? row.durationMs : null,
      width: typeof row.width === "number" ? row.width : null,
      height: typeof row.height === "number" ? row.height : null,
      source: typeof row.source === "string" ? row.source : null,
      posterUrl: typeof row.posterUrl === "string" ? row.posterUrl.trim() || null : null,
      altText: typeof row.altText === "string" ? row.altText.trim() || null : null,
    };
  }));
}

function exactSourceIdentity(
  payload: Record<string, unknown>,
  receipt: DurableVideoPublishInput["receipt"],
): boolean {
  const content = (value: unknown): string => typeof value === "string" ? value : "";
  return stablePublishString({
    title: content(payload.title),
    description: content(payload.description),
    altText: content(payload.altText),
    destinationUrl: content(payload.destinationUrl),
    media: exactMediaIdentity(payload.media),
  }) === stablePublishString({
    title: receipt.title,
    description: receipt.description,
    altText: receipt.altText,
    destinationUrl: receipt.destinationUrl,
    media: exactMediaIdentity(receipt.media),
  });
}

function extension(contentType: string): string {
  return contentType === "video/quicktime" ? "mov" : contentType === "video/x-m4v" ? "m4v" : "mp4";
}

/**
 * Resolve owner-authorized source bytes and create one intent-scoped private copy.
 * No signed URL or public locator is produced or stored.
 */
export async function materializePrivateVideoSources(
  input: DurableVideoPublishInput,
  _lease: { leaseToken: string; deliveryId: string },
  boundary: PrivateVideoMaterializationBoundary,
): Promise<MaterializedVideoSource[]> {
  const draft = await boundary.loadDraft(input.uid, input.receipt.draftId);
  if (!draft) throw new Error("video_source_not_found");
  // pin_drafts.updated_at is also advanced by publish lifecycle bookkeeping.
  // Source authority is therefore the frozen content/media identity below, not
  // this operational timestamp. A real media/content mutation still fails closed.
  if (!exactSourceIdentity(draft.payload, input.receipt)) {
    throw new Error("publish_source_media_conflict");
  }

  const output: MaterializedVideoSource[] = [];
  for (const [ordinal, media] of input.receipt.media.entries()) {
    if (media.kind !== "video") throw new Error("materialization_required");
    const sourcePath = videoPath(media.url);
    if (!sourcePath) throw new Error("video_source_locator_invalid");
    if (sourcePath.split("/", 1)[0] !== input.uid) throw new Error("video_source_owner_mismatch");

    const provenance = await boundary.findProvenance(input.uid, PRIVATE_BUCKET, sourcePath);
    if (!provenance
        || provenance.ownerUserId !== input.uid
        || provenance.bucketId !== PRIVATE_BUCKET
        || provenance.objectPath !== sourcePath
        || provenance.mediaKind !== "video"
        || !VIDEO_TYPES.has(provenance.contentType)
        || !Number.isSafeInteger(provenance.byteSize)
        || provenance.byteSize <= 0
        || !/^[0-9a-f]{64}$/.test(provenance.checksumSha256)
        || (media.width !== undefined && provenance.width !== media.width)
        || (media.height !== undefined && provenance.height !== media.height)
        || (media.durationMs !== undefined && provenance.durationMs !== media.durationMs)
        || !["draft", "publish_pending", "published", "retained"].includes(provenance.lifecycleState)) {
      throw new Error("video_source_provenance_invalid");
    }

    const file = await boundary.download(PRIVATE_BUCKET, sourcePath);
    if (file.size !== provenance.byteSize
        || (file.type && file.type !== provenance.contentType)
        || await sha256(await file.arrayBuffer()) !== provenance.checksumSha256) {
      throw new Error("video_source_bytes_conflict");
    }
    const key = (await sha256(`${input.receipt.intentId}:${media.id}:${ordinal}`)).slice(0, 32);
    const targetPath = `${input.uid}/publish/${input.receipt.fingerprint}/${ordinal}-${key}.${extension(provenance.contentType)}`;
    await boundary.storePublishCopy({
      uid: input.uid,
      intentId: input.receipt.intentId,
      sourcePath,
      targetPath,
      contentType: provenance.contentType as MaterializedVideoSource["contentType"],
      byteSize: provenance.byteSize,
      checksumSha256: provenance.checksumSha256,
      width: provenance.width,
      height: provenance.height,
      durationMs: provenance.durationMs,
      file,
    });
    output.push({
      mediaId: media.id,
      ordinal,
      bucketId: PRIVATE_BUCKET,
      objectPath: targetPath,
      contentType: provenance.contentType as MaterializedVideoSource["contentType"],
      byteSize: provenance.byteSize,
      checksumSha256: provenance.checksumSha256,
      fileName: targetPath.slice(targetPath.lastIndexOf("/") + 1),
      file,
    });
  }
  return output;
}

function dbError(error: { code?: string; message?: string } | null, fallback: string): Error {
  return new Error(error?.message || error?.code || fallback);
}

export async function inspectV76VideoPublishState(
  db: SupabaseClient,
  input: DurableVideoPublishInput,
): Promise<DurableVideoPublishState> {
  const intentResult = await db
    .from("publish_intents")
    .select("id,source_revision")
    .eq("user_id", input.uid)
    .eq("intent_id", input.receipt.intentId)
    .maybeSingle();
  if (intentResult.error) throw dbError(intentResult.error, "publish_intent_inspection_failed");
  if (!intentResult.data) return { kind: "missing" };
  const storedRevision = (intentResult.data as { source_revision?: string | null }).source_revision ?? "";
  const intentDbId = String((intentResult.data as { id: unknown }).id);
  const destinationResult = await db
    .from("publish_intent_destinations")
    .select("status,materialization_status,claim_token,attempt,remote_id,remote_url,evidence")
    .eq("publish_intent_id", intentDbId)
    .eq("destination_id", input.destination.id)
    .maybeSingle();
  if (destinationResult.error) throw dbError(destinationResult.error, "publish_destination_inspection_failed");
  const destination = destinationResult.data as Record<string, unknown> | null;
  if (destination?.status === "published") {
    const remoteId = typeof destination.remote_id === "string" ? destination.remote_id : "";
    const storedUrl = typeof destination.remote_url === "string" ? destination.remote_url : "";
    const remoteUrl = storedUrl || (/^[0-9]+$/.test(remoteId) ? `https://www.pinterest.com/pin/${remoteId}/` : "");
    if (!remoteId) throw new Error("provider_success_evidence_missing");
    return {
      kind: "published",
      remoteId,
      ...(remoteUrl ? { remoteUrl } : {}),
      evidence: destination.evidence && typeof destination.evidence === "object"
        ? destination.evidence as Record<string, unknown>
        : {},
    };
  }
  if (destination?.status === "delivery_unknown") {
    return {
      kind: "delivery_unknown",
      evidence: destination.evidence && typeof destination.evidence === "object"
        ? destination.evidence as Record<string, unknown>
        : {},
    };
  }
  const attemptResult = await db
    .from("provider_publish_attempts")
    .select("id,status,claim_token_identity,evidence,started_at")
    .eq("publish_intent_id", intentDbId)
    .eq("destination_id", input.destination.id)
    .order("attempt", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (attemptResult.error) throw dbError(attemptResult.error, "provider_attempt_inspection_failed");
  const attempt = attemptResult.data as Record<string, unknown> | null;
  if (attempt?.status === "started") {
    return {
      kind: "attempt_started",
      attemptId: String(attempt.id),
      claimToken: String(attempt.claim_token_identity),
      stale: Number.isFinite(Date.parse(String(attempt.started_at)))
        && Date.parse(String(attempt.started_at)) <= Date.now() - 10 * 60_000,
    };
  }
  if (attempt?.status === "unknown") {
    return {
      kind: "delivery_unknown",
      evidence: attempt.evidence && typeof attempt.evidence === "object"
        ? attempt.evidence as Record<string, unknown>
        : {},
    };
  }
  if (!Number.isFinite(Date.parse(storedRevision))
      || Date.parse(storedRevision) !== Date.parse(input.receipt.sourceUpdatedAt)) {
    throw new Error("publish_source_revision_conflict");
  }
  if (destination?.status === "claimed") {
    const claimToken = typeof destination.claim_token === "string" ? destination.claim_token : "";
    const attempt = Number(destination.attempt);
    if (!claimToken || !Number.isSafeInteger(attempt) || attempt < 1) {
      throw new Error("publish_claim_state_invalid");
    }
    return { kind: "claimed", claimToken, attempt };
  }
  if (destination?.status === "prepared" && destination.materialization_status === "materialized") {
    return { kind: "ready" };
  }
  return destination?.status === "failed"
    ? {
      kind: "failed",
      evidence: destination.evidence && typeof destination.evidence === "object"
        ? destination.evidence as Record<string, unknown>
        : {},
    }
    : { kind: "prepared" };
}

export function createSupabasePrivateVideoMaterializationBoundary(
  db: SupabaseClient,
): PrivateVideoMaterializationBoundary {
  return {
    async loadDraft(uid, draftId) {
      const { data, error } = await db
        .from("pin_drafts")
        .select("updated_at,payload,deleted_at")
        .eq("vibepin_user_id", uid)
        .eq("draft_id", draftId)
        .maybeSingle();
      if (error) throw dbError(error, "video_source_draft_unavailable");
      if (!data || (data as { deleted_at?: unknown }).deleted_at) return null;
      const row = data as { updated_at: string; payload: Record<string, unknown> };
      return { updatedAt: row.updated_at, payload: row.payload };
    },
    async findProvenance(uid, bucket, objectPath) {
      const { data, error } = await db
        .from("media_asset_provenance")
        .select("owner_user_id,bucket_id,object_path,media_kind,content_type,byte_size,checksum_sha256,width,height,duration_ms,lifecycle_state")
        .eq("owner_user_id", uid)
        .eq("bucket_id", bucket)
        .eq("object_path", objectPath)
        .maybeSingle();
      if (error) throw dbError(error, "video_source_provenance_unavailable");
      if (!data) return null;
      const row = data as Record<string, unknown>;
      return {
        ownerUserId: String(row.owner_user_id),
        bucketId: String(row.bucket_id),
        objectPath: String(row.object_path),
        mediaKind: String(row.media_kind),
        contentType: String(row.content_type),
        byteSize: Number(row.byte_size),
        checksumSha256: String(row.checksum_sha256),
        width: typeof row.width === "number" ? row.width : null,
        height: typeof row.height === "number" ? row.height : null,
        durationMs: typeof row.duration_ms === "number" ? row.duration_ms : null,
        lifecycleState: String(row.lifecycle_state),
      };
    },
    async download(bucket, objectPath) {
      const { data, error } = await db.storage.from(bucket).download(objectPath);
      if (error || !data) throw dbError(error, "video_source_download_failed");
      return data;
    },
    async storePublishCopy(copy) {
      const bucket = db.storage.from(PRIVATE_BUCKET);
      const uploaded = await bucket.upload(copy.targetPath, copy.file, {
        contentType: copy.contentType,
        upsert: false,
      });
      if (uploaded.error) {
        // A lost upload response or replay may find the deterministic private copy
        // already present. Accept it only when the exact bytes match.
        const existing = await bucket.download(copy.targetPath);
        if (existing.error || !existing.data
            || existing.data.size !== copy.byteSize
            || await sha256(await existing.data.arrayBuffer()) !== copy.checksumSha256) {
          throw dbError(uploaded.error, "video_publish_copy_failed");
        }
      }
      const { error } = await db.from("media_asset_provenance").upsert({
        owner_user_id: copy.uid,
        bucket_id: PRIVATE_BUCKET,
        object_path: copy.targetPath,
        source_type: "publish_copy",
        intent_id: copy.intentId,
        lifecycle_state: "publish_pending",
        media_kind: "video",
        content_type: copy.contentType,
        byte_size: copy.byteSize,
        checksum_sha256: copy.checksumSha256,
        width: copy.width,
        height: copy.height,
        duration_ms: copy.durationMs,
        updated_at: new Date().toISOString(),
      }, { onConflict: "bucket_id,object_path" });
      if (error) throw dbError(error, "video_publish_copy_provenance_failed");
    },
  };
}

export function createSupabaseV76VideoPublishDependencies(input: {
  db: SupabaseClient;
  publishVideo: DurableVideoPublishDependencies["publishVideo"];
}): DurableVideoPublishDependencies {
  const materialization = createSupabasePrivateVideoMaterializationBoundary(input.db);
  return createV76RpcVideoPublishDependencies({
    inspect: current => inspectV76VideoPublishState(input.db, current),
    materializeSources: (current, lease) => materializePrivateVideoSources(current, lease, materialization),
    publishVideo: input.publishVideo,
    async rpc(name, args) {
      const { data, error } = await input.db.rpc(name, args);
      if (error) throw dbError(error, `${name}_failed`);
      return data;
    },
  });
}

export type PinterestVideoPublisher = (
  input: DurableVideoPublishInput,
  source: MaterializedVideoSource,
) => Promise<PinterestVideoPublishResult>;
