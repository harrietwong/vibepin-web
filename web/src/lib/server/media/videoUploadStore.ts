import type { VideoUploadStore } from "./videoUploadHandler";

type Db = {
  rpc(name: string, args: Record<string, unknown>): any;
  from(table: string): any;
};

function rpcData(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
const STABLE_STORE_CODES = new Set([
  "video_upload_item_claimed", "video_upload_claim_lost", "video_upload_provenance_incomplete",
  "video_upload_batch_expired", "video_upload_item_not_finalizable", "video_upload_batch_not_finalizable",
]);
function storeFailure(value: unknown) {
  const message = value && typeof value === "object" && "message" in value ? String((value as { message: unknown }).message) : "";
  const stable = [...STABLE_STORE_CODES].find(code => message === code || message.includes(code));
  return new Error(stable ?? "video_upload_store_error");
}
function must<T>(result: { data: unknown; error: unknown }, map: (data: Record<string, unknown>) => T): T {
  const value = rpcData(result.data); if (result.error || !value) throw storeFailure(result.error); return map(value);
}

/** Service-only v77 boundary. Every direct query includes the verified owner. */
export function createVideoUploadStore(db: Db): VideoUploadStore {
  return {
    async prepareBatch(input) {
      const result = await db.rpc("video_upload_batch_prepare", { p_owner_user_id: input.ownerUserId, p_idempotency_key: input.idempotencyKey, p_expires_at: input.expiresAt });
      return must(result, data => ({ batchId: String(data.batchId ?? "") }));
    },
    async prepareItem(input) {
      const result = await db.rpc("video_upload_item_prepare", {
        p_owner_user_id: input.ownerUserId, p_batch_id: input.batchId, p_ordinal: input.ordinal, p_idempotency_key: input.idempotencyKey,
        p_private_path: input.privatePath, p_declared_content_type: input.contentType, p_declared_byte_size: input.byteSize,
        p_declared_checksum_sha256: input.checksumSha256, p_declared_width: input.width, p_declared_height: input.height, p_declared_duration_ms: input.durationMs,
      });
      return must(result, data => ({ status: String(data.status ?? "") }));
    },
    async findItem(ownerUserId, batchId, ordinal) {
      const { data, error } = await db.from("video_upload_items")
        .select("batch_id,ordinal,status,private_path,declared_content_type,declared_byte_size,declared_checksum_sha256,declared_width,declared_height,declared_duration_ms,expires_at")
        .eq("owner_user_id", ownerUserId).eq("batch_id", batchId).eq("ordinal", ordinal).maybeSingle();
      if (error) throw storeFailure(error);
      if (!data) return null;
      return {
        batchId: data.batch_id, ordinal: data.ordinal, status: data.status, privatePath: data.private_path,
        declaredContentType: data.declared_content_type, declaredByteSize: Number(data.declared_byte_size), declaredChecksumSha256: data.declared_checksum_sha256,
        declaredWidth: Number(data.declared_width), declaredHeight: Number(data.declared_height), declaredDurationMs: Number(data.declared_duration_ms), expiresAt: data.expires_at,
      };
    },
    async finalizeItem(input) {
      const result = await db.rpc("video_upload_item_finalize", {
        p_owner_user_id: input.ownerUserId, p_batch_id: input.batchId, p_ordinal: input.ordinal,
        p_claim_token: input.claimToken, p_bucket_id: input.bucketId, p_verified_content_type: input.contentType,
        p_verified_byte_size: input.byteSize, p_verified_checksum_sha256: input.checksumSha256,
      });
      return must(result, data => ({ status: String(data.status ?? ""), provenanceReady: data.provenanceReady === true }));
    },
    async claimItem(input) {
      const result = await db.rpc("video_upload_item_claim", {
        p_owner_user_id: input.ownerUserId, p_batch_id: input.batchId, p_ordinal: input.ordinal,
        p_claim_token: input.claimToken, p_claim_expires_at: input.claimExpiresAt,
      });
      return must(result, data => ({ status: String(data.status ?? ""),
        claimToken: data.claimToken == null ? null : String(data.claimToken), provenanceReady: data.provenanceReady === true }));
    },
    async failItem(input) {
      const result = await db.rpc("video_upload_item_fail", {
        p_owner_user_id: input.ownerUserId, p_batch_id: input.batchId, p_ordinal: input.ordinal,
        p_claim_token: input.claimToken, p_error_code: input.code,
      });
      return must(result, data => ({ status: String(data.status ?? ""), cleanupAllowed: data.cleanupAllowed === true }));
    },
  };
}
