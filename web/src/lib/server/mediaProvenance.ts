import { createServerClient } from "@/lib/supabase";

export type MediaProvenance = {
  owner_user_id: string;
  bucket_id?: string;
  object_path: string;
  source_type: string;
  intent_id: string | null;
  lifecycle_state: string;
  /** v77 fields are optional so existing image rows retain their serialization. */
  media_kind?: "image" | "video" | string;
  content_type?: string | null;
  byte_size?: number | null;
  checksum_sha256?: string | null;
  width?: number | null;
  height?: number | null;
  duration_ms?: number | null;
};

export type MediaProvenanceStore = {
  findExact(ownerUserId: string, bucketId: string, objectPath: string): Promise<MediaProvenance | null>;
  findExactMany(ownerUserId: string, bucketId: string, objectPaths: string[]): Promise<MediaProvenance[]>;
  register(input: Omit<MediaProvenance, "lifecycle_state" | "bucket_id"> & { bucket_id: string; lifecycle_state?: string }): Promise<boolean>;
  recordCleanup(input: { owner_user_id: string; bucket_id: string; object_path: string; reason: string }): Promise<void>;
};

export function createMediaProvenanceStore(db = createServerClient()): MediaProvenanceStore {
  return {
    async findExact(ownerUserId, bucketId, objectPath) {
      const { data, error } = await db
        .from("media_asset_provenance")
        .select("owner_user_id,bucket_id,object_path,source_type,intent_id,lifecycle_state,media_kind,content_type,byte_size,checksum_sha256,width,height,duration_ms")
        .eq("owner_user_id", ownerUserId)
        .eq("bucket_id", bucketId)
        .eq("object_path", objectPath)
        .maybeSingle();
      if (error || !data) return null;
      return data as MediaProvenance;
    },
    async findExactMany(ownerUserId, bucketId, objectPaths) {
      if (!objectPaths.length) return [];
      const { data, error } = await db
        .from("media_asset_provenance")
        .select("owner_user_id,bucket_id,object_path,source_type,intent_id,lifecycle_state,media_kind,content_type,byte_size,checksum_sha256,width,height,duration_ms")
        .eq("owner_user_id", ownerUserId)
        .eq("bucket_id", bucketId)
        .in("object_path", [...new Set(objectPaths)]);
      return error ? [] : (data ?? []) as MediaProvenance[];
    },
    async register(input) {
      const { error } = await db.from("media_asset_provenance").upsert({
        ...input,
        lifecycle_state: input.lifecycle_state ?? "draft",
        updated_at: new Date().toISOString(),
      }, { onConflict: "bucket_id,object_path" });
      return !error;
    },
    async recordCleanup(input) {
      const { error } = await db.from("media_cleanup_outbox").insert({
        owner_user_id: input.owner_user_id,
        bucket_id: input.bucket_id,
        object_path: input.object_path,
        reason: input.reason,
      });
      if (error) throw error;
    },
  };
}
