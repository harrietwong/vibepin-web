import type { CreativeRequestError } from "@/lib/studio/recommendationRequest";

export type ImageUploadMode = "together" | "separate";

export type ImageUploadFailure = {
  batchId: string;
  fileName: string;
  detail: CreativeRequestError;
};

export type ImageUploadRetry = {
  batchId: string;
  files: File[];
  mode: ImageUploadMode;
};

export type ImageUploadBatchState = {
  activeBatchIds: string[];
  failures: ImageUploadFailure[];
  retries: ImageUploadRetry[];
};

export function createImageUploadBatchState(): ImageUploadBatchState {
  return { activeBatchIds: [], failures: [], retries: [] };
}

/** Starts a new image batch without allowing an overlapping batch to erase its evidence. */
export function beginImageUploadBatch(
  state: ImageUploadBatchState,
  input: { batchId: string; retryBatchId?: string },
): ImageUploadBatchState {
  const retrying = input.retryBatchId;
  return {
    activeBatchIds: state.activeBatchIds.includes(input.batchId)
      ? state.activeBatchIds
      : [...state.activeBatchIds, input.batchId],
    failures: retrying ? state.failures.filter(failure => failure.batchId !== retrying) : state.failures,
    retries: retrying ? state.retries.filter(retry => retry.batchId !== retrying) : state.retries,
  };
}

/** Completes only its own batch, retaining unrelated failed batches and their retry payloads. */
export function completeImageUploadBatch(
  state: ImageUploadBatchState,
  input: {
    batchId: string;
    failures: Array<Omit<ImageUploadFailure, "batchId">>;
    retry?: Omit<ImageUploadRetry, "batchId">;
  },
): ImageUploadBatchState {
  return {
    activeBatchIds: state.activeBatchIds.filter(batchId => batchId !== input.batchId),
    failures: input.failures.length
      ? [...state.failures, ...input.failures.map(failure => ({ ...failure, batchId: input.batchId }))]
      : state.failures,
    retries: input.retry
      ? [...state.retries.filter(retry => retry.batchId !== input.batchId), { ...input.retry, batchId: input.batchId }]
      : state.retries,
  };
}
