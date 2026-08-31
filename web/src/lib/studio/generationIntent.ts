/** Stable, non-secret client operation identity for one reference group. */
export function generationRequestIdForGroup(batchRequestId: string, groupIndex: number): string {
  const index = Math.max(0, Math.floor(groupIndex) || 0);
  return `${batchRequestId}_g${index}`;
}

/**
 * The server may already have committed the durable job even though both client
 * responses were lost. This is deliberately distinct from a definitive HTTP
 * refusal: callers must preserve the exact intent for reconciliation instead of
 * turning the placeholders into retryable failures.
 */
export class AmbiguousGenerationOutcomeError extends Error {
  readonly code = "generation_outcome_unknown";

  constructor() {
    super("Generation outcome is unknown; reconciliation is required");
    this.name = "AmbiguousGenerationOutcomeError";
  }
}

export function isAmbiguousGenerationOutcomeError(error: unknown): error is AmbiguousGenerationOutcomeError {
  return error instanceof AmbiguousGenerationOutcomeError
    || (!!error && typeof error === "object"
      && (error as { code?: unknown }).code === "generation_outcome_unknown");
}
