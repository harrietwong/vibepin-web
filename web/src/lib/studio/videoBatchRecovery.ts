"use client";

/**
 * Small, owner-scoped recovery ledger for video objects that crossed a server
 * durability boundary but have not yet been durably written to the board store.
 * It deliberately excludes Files, signed URLs/tokens and provider error bodies.
 */
export type VideoRecoveryScope = { ownerUserId: string; workspaceId: string };
export type VideoRecoveryRecord = {
  version: 1;
  logicalId: string;
  draftIdempotencyKey: string;
  owner: VideoRecoveryScope;
  filename: string;
  title: string;
  inspection: { width: number; height: number; durationMs: number; posterUrl?: string };
  attempt?: { id: string; batchId: string; ordinal: number; phase: "prepared" | "finalize_pending" };
  finalized?: { proxyUrl: string; requestId: string };
  /** Storage path is only kept for a private poster cleanup request, never rendered. */
  posterPath?: string;
  createdAt: string;
};

const KEY = "vibepin:video-batch-recovery:v1";
const MAX_RECORDS = 50;
function usableStorage(): Storage | null {
  try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; }
}
function key(scope: VideoRecoveryScope) { return `${scope.ownerUserId}:${scope.workspaceId}`; }
function read(storage: Storage): Record<string, VideoRecoveryRecord[]> {
  try {
    const value = JSON.parse(storage.getItem(KEY) ?? "{}") as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, VideoRecoveryRecord[]> : {};
  } catch { return {}; }
}
function write(storage: Storage, value: Record<string, VideoRecoveryRecord[]>): boolean {
  try { storage.setItem(KEY, JSON.stringify(value)); return true; } catch { return false; }
}
export function videoRecoveryScopeEquals(a: VideoRecoveryScope | null | undefined, b: VideoRecoveryScope | null | undefined): boolean {
  return Boolean(a && b && a.ownerUserId === b.ownerUserId && a.workspaceId === b.workspaceId);
}
function validScope(value: unknown): value is VideoRecoveryScope {
  return !!value && typeof value === "object" && typeof (value as VideoRecoveryScope).ownerUserId === "string"
    && /^[0-9a-f-]{8,64}$/i.test((value as VideoRecoveryScope).ownerUserId)
    && typeof (value as VideoRecoveryScope).workspaceId === "string" && !!(value as VideoRecoveryScope).workspaceId;
}
function validRecord(value: unknown, scope: VideoRecoveryScope): value is VideoRecoveryRecord {
  if (!value || typeof value !== "object") return false;
  const r = value as Partial<VideoRecoveryRecord>;
  if (r.version !== 1 || !videoRecoveryScopeEquals(r.owner, scope) || typeof r.logicalId !== "string" || !r.logicalId
    || typeof r.draftIdempotencyKey !== "string" || !r.draftIdempotencyKey || typeof r.filename !== "string" || typeof r.title !== "string"
    || !r.inspection || !Number.isSafeInteger(r.inspection.width) || !Number.isSafeInteger(r.inspection.height)
    || !Number.isSafeInteger(r.inspection.durationMs) || r.inspection.width < 1 || r.inspection.height < 1 || r.inspection.durationMs < 1
    || typeof r.createdAt !== "string") return false;
  if (r.finalized) {
    if (typeof r.finalized.proxyUrl !== "string" || !r.finalized.proxyUrl.startsWith("/api/storage-media?path=")
      || typeof r.finalized.requestId !== "string") return false;
    try { if (!decodeURIComponent(r.finalized.proxyUrl).includes(`${scope.ownerUserId}/`)) return false; } catch { return false; }
  }
  if (r.attempt && (typeof r.attempt.batchId !== "string" || typeof r.attempt.id !== "string" || !Number.isSafeInteger(r.attempt.ordinal)
    || (r.attempt.phase !== "prepared" && r.attempt.phase !== "finalize_pending"))) return false;
  return Boolean(r.finalized || r.attempt);
}
export function saveVideoRecovery(record: VideoRecoveryRecord): boolean {
  const storage = usableStorage(); if (!storage) return false;
  if (!validScope(record.owner) || !validRecord(record, record.owner)) return false;
  const all = read(storage); const scopeKey = key(record.owner);
  const current = all[scopeKey] ?? [];
  const replacing = current.some(item => item.logicalId === record.logicalId);
  // Never evict a live receipt: capacity is an explicit fail-closed outcome.
  if (!replacing && current.length >= MAX_RECORDS) return false;
  all[scopeKey] = [...current.filter(item => item.logicalId !== record.logicalId), record];
  return write(storage, all);
}
export function listVideoRecovery(scope: VideoRecoveryScope): VideoRecoveryRecord[] {
  const storage = usableStorage(); if (!storage) return [];
  if (!validScope(scope)) return [];
  const values = read(storage)[key(scope)];
  return Array.isArray(values) ? values.filter(value => validRecord(value, scope)) : [];
}
export function removeVideoRecovery(scope: VideoRecoveryScope, logicalId: string): boolean {
  const storage = usableStorage(); if (!storage) return false;
  const all = read(storage); const scopeKey = key(scope);
  all[scopeKey] = (all[scopeKey] ?? []).filter(item => item.logicalId !== logicalId);
  return write(storage, all);
}
