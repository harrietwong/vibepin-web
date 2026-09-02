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

/**
 * The exact replay body could not be durably attached to every local placeholder.
 * No network request is allowed after this error: without the recovery body an
 * ambiguous response could create a charged server job that the client cannot
 * reconcile after reload.
 */
export class GenerationIntentPersistenceError extends Error {
  readonly code = "generation_intent_persist_failed";

  constructor() {
    super("Generation intent could not be persisted");
    this.name = "GenerationIntentPersistenceError";
  }
}

export function isGenerationIntentPersistenceError(error: unknown): error is GenerationIntentPersistenceError {
  return error instanceof GenerationIntentPersistenceError
    || (!!error && typeof error === "object"
      && (error as { code?: unknown }).code === "generation_intent_persist_failed");
}

/** The authenticated owner changed while an operation was in flight. */
export class GenerationOwnerChangedError extends Error {
  readonly code = "generation_owner_changed";

  constructor() {
    super("Generation owner changed");
    this.name = "GenerationOwnerChangedError";
  }
}

export function isGenerationOwnerChangedError(error: unknown): error is GenerationOwnerChangedError {
  return error instanceof GenerationOwnerChangedError
    || (!!error && typeof error === "object"
      && (error as { code?: unknown }).code === "generation_owner_changed");
}
