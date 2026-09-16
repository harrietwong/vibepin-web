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
export function saveVideoRecovery(record: VideoRecoveryRecord): boolean {
  const storage = usableStorage(); if (!storage) return false;
  const all = read(storage); const scopeKey = key(record.owner);
  const current = all[scopeKey] ?? [];
  all[scopeKey] = [...current.filter(item => item.logicalId !== record.logicalId), record].slice(-50);
  return write(storage, all);
}
export function listVideoRecovery(scope: VideoRecoveryScope): VideoRecoveryRecord[] {
  const storage = usableStorage(); if (!storage) return [];
  return read(storage)[key(scope)] ?? [];
}
export function removeVideoRecovery(scope: VideoRecoveryScope, logicalId: string): boolean {
  const storage = usableStorage(); if (!storage) return false;
  const all = read(storage); const scopeKey = key(scope);
  all[scopeKey] = (all[scopeKey] ?? []).filter(item => item.logicalId !== logicalId);
  return write(storage, all);
}
