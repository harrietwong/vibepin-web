/**
 * Single-output retry scope helpers.
 *
 * "Try again" on a failed output must retry ONLY that output — never the batch.
 * These pure reducers encode the scope invariants so they can be unit-tested:
 *   - a retrying output never flips a successful sibling to "generating"
 *   - successful sibling items keep their exact object identity (image, metadata,
 *     plan state) while another output retries
 *   - a single-output retry always generates exactly one image (outputCount = 1)
 *
 * The Studio feed is grouped by reference; multiple outputs can live in one group.
 * Retry state is therefore tracked PER SLOT (`retryingSlots`), not per group, so
 * setting one slot to "retrying" can't visually regenerate its completed sibling.
 */

export type RetryStatus = "generating" | "done" | "partial" | "failed";

export interface RetryGroupLike<TItem> {
  items: TItem[];
  expectedCount: number;
  status: RetryStatus;
  retryingSlots?: number[];
}

// A single-output retry ALWAYS asks the provider for exactly one image. The batch's
// original output count is never reused for a retry.
export const SINGLE_OUTPUT_RETRY_COUNT = 1;

// Status is driven by how many outputs COMPLETED — a retry-in-progress slot never
// flips the group to "generating" (that is what made the completed sibling look like
// it was regenerating). Per-slot retry is surfaced via `retryingSlots` instead.
export function recomputeGroupStatus(itemCount: number, expectedCount: number): RetryStatus {
  if (itemCount >= expectedCount) return "done";
  if (itemCount > 0) return "partial";
  return "failed";
}

/** Mark one slot as retrying. items + status are returned UNCHANGED (same references). */
export function markOutputRetrying<T, G extends RetryGroupLike<T>>(group: G, outputIndex: number): G {
  const slots = new Set(group.retryingSlots ?? []);
  slots.add(outputIndex);
  return { ...group, retryingSlots: [...slots] };
}

/** Append the single retried output; never replaces or mutates existing items. */
export function applyRetrySuccess<T, G extends RetryGroupLike<T>>(group: G, outputIndex: number, appended: T[]): G {
  const items = [...group.items, ...appended];
  const retryingSlots = (group.retryingSlots ?? []).filter(s => s !== outputIndex);
  return { ...group, items, retryingSlots, status: recomputeGroupStatus(items.length, group.expectedCount) };
}

/** Clear the retry flag for the slot; existing items remain untouched, status reverts. */
export function applyRetryFailure<T, G extends RetryGroupLike<T>>(group: G, outputIndex: number): G {
  const retryingSlots = (group.retryingSlots ?? []).filter(s => s !== outputIndex);
  return { ...group, retryingSlots, status: recomputeGroupStatus(group.items.length, group.expectedCount) };
}

export type BatchStatus = "partially_generating" | "completed" | "partially_completed" | "failed";

/** Batch status is DERIVED from individual output statuses, never the other way round. */
export function getBatchStatus(outputs: { status: string }[]): BatchStatus {
  if (outputs.some(o => o.status === "generating" || o.status === "retrying")) return "partially_generating";
  if (outputs.length > 0 && outputs.every(o => o.status === "completed")) return "completed";
  if (outputs.some(o => o.status === "completed")) return "partially_completed";
  return "failed";
}

export interface SingleOutputRetryPlan {
  mode: "retry_single_output";
  outputCount: 1;
  targetOutputIndex: number;
  /** The per-output variant re-indexed to 1 because the request generates a single image. */
  variantIndex: 1;
}

export function planSingleOutputRetry(outputIndex: number): SingleOutputRetryPlan {
  return { mode: "retry_single_output", outputCount: SINGLE_OUTPUT_RETRY_COUNT, targetOutputIndex: outputIndex, variantIndex: 1 };
}

/** Stable per-output retry identity: scopes the duplicate-click guard + idempotency key. */
export function outputSlotId(batchId: string, groupIdx: number, outputIndex: number): string {
  return `${batchId}:g${groupIdx}:o${outputIndex}`;
}

export function retryIdempotencyKey(slotId: string, attemptNumber: number): string {
  return `retry:${slotId}:${attemptNumber}`;
}
