/** Service-only v80 boundary. Browser input never chooses an operation lifecycle. */
type Db = { rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }> };
type RpcValue = Record<string, unknown>;
function dataOf(value: unknown): RpcValue | null { return value && typeof value === "object" && !Array.isArray(value) ? value as RpcValue : null; }
function errorCode(error: unknown, fallback: string): Error {
  const message = error && typeof error === "object" && "message" in error ? String((error as { message: unknown }).message) : "";
  const code = ["v80_poster_operation_invalid", "v80_poster_operation_not_associable", "v80_poster_provenance_missing", "v80_poster_operation_conflict", "v80_poster_operation_not_retainable"].find(value => message.includes(value)) ?? fallback;
  return Object.assign(new Error(code), { code });
}
async function rpc(db: Db, name: string, args: Record<string, unknown>): Promise<RpcValue> {
  const result = await db.rpc(name, args);
  const data = dataOf(result.data);
  if (result.error || !data) throw errorCode(result.error, "video_poster_operation_unavailable");
  return data;
}
export type VideoPosterOperationStore = {
  associate(input: { ownerUserId: string; batchId: string; ordinal: number; bucketId: string; objectPath: string }): Promise<void>;
  retain(input: { ownerUserId: string; batchId: string; ordinal: number; bucketId: string; objectPath: string }): Promise<void>;
  canCleanup(input: { ownerUserId: string; bucketId: string; objectPath: string }): Promise<boolean>;
};
export function createVideoPosterOperationStore(db: Db): VideoPosterOperationStore {
  const args = (input: { ownerUserId: string; batchId: string; ordinal: number; bucketId: string; objectPath: string }) => ({
    p_owner_user_id: input.ownerUserId, p_batch_id: input.batchId, p_ordinal: input.ordinal, p_bucket_id: input.bucketId, p_object_path: input.objectPath,
  });
  return {
    async associate(input) { await rpc(db, "video_poster_operation_associate", args(input)); },
    async retain(input) { await rpc(db, "video_poster_operation_retain", args(input)); },
    async canCleanup(input) {
      const data = await rpc(db, "video_poster_cleanup_authorize", { p_owner_user_id: input.ownerUserId, p_bucket_id: input.bucketId, p_object_path: input.objectPath });
      return data.allowed === true;
    },
  };
}
