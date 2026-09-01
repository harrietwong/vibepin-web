export type GenerationAttemptState =
  | "persisting"
  | "accepted"
  | "generating"
  | "completed"
  | "partial"
  | "failed"
  | "unknown"
  | "cancelled";

export type GenerationAttemptSummary = {
  attemptId: string;
  state: GenerationAttemptState;
  okCount: number;
  failCount: number;
  expectedCount?: number;
};

export type GenerationToastCommand = {
  id: string;
  kind: "loading" | "info" | "warning" | "success" | "error" | "dismiss";
};

export type GenerationDraftState = {
  generationStatus?: string;
  generationRecoveryPending?: boolean;
};

const BLOCKING_STATES = new Set<GenerationAttemptState>([
  "persisting",
  "accepted",
  "generating",
  "unknown",
]);

export function isBlockingGenerationState(state: GenerationAttemptState): boolean {
  return BLOCKING_STATES.has(state);
}

export function createGenerationAttemptId(
  now = Date.now(),
  random = Math.random().toString(36).slice(2, 8),
): string {
  return `board_${Math.max(0, Math.floor(now))}_${random.replace(/[^a-z0-9_-]/gi, "").slice(0, 24) || "attempt"}`;
}

/** A Sonner id is visible in the DOM, so it contains only the bounded attempt id. */
export function generationToastId(attemptId: string): string {
  return `generation:${attemptId.replace(/[^a-z0-9_-]/gi, "").slice(0, 96)}`;
}

export function generationToastCommand(summary: GenerationAttemptSummary): GenerationToastCommand {
  const id = generationToastId(summary.attemptId);
  if (summary.state === "persisting" || summary.state === "accepted" || summary.state === "generating") {
    return { id, kind: "loading" };
  }
  if (summary.state === "unknown") return { id, kind: "info" };
  if (summary.state === "partial") return { id, kind: "warning" };
  if (summary.state === "completed") return { id, kind: "success" };
  if (summary.state === "failed") return { id, kind: "error" };
  return { id, kind: "dismiss" };
}

/** Group request ids are `${batchAttemptId}_g${index}`. */
export function attemptIdFromGroupIntent(intentId: string): string {
  return intentId.replace(/_g\d+$/, "");
}

export function deriveGenerationAttemptState(input: {
  okCount: number;
  failCount: number;
  unknown?: boolean;
  cancelled?: boolean;
}): GenerationAttemptState {
  if (input.cancelled) return "cancelled";
  if (input.unknown) return "unknown";
  if (input.okCount > 0 && input.failCount > 0) return "partial";
  if (input.okCount > 0) return "completed";
  return "failed";
}

/**
 * Rebuild one attempt's visible state from durable placeholders after reload.
 * Unknown outranks generating because it requires exact replay before another action.
 */
export function summarizeGenerationDrafts(
  attemptId: string,
  drafts: readonly GenerationDraftState[],
): GenerationAttemptSummary {
  let okCount = 0;
  let failCount = 0;
  let generatingCount = 0;
  let unknownCount = 0;

  for (const draft of drafts) {
    const status = (draft.generationStatus ?? "").toLowerCase();
    if (draft.generationRecoveryPending) unknownCount++;
    if (status === "completed" || status === "done") okCount++;
    else if (status === "failed") failCount++;
    else if (["generating", "running", "pending", "queued"].includes(status)) generatingCount++;
  }

  const state: GenerationAttemptState = unknownCount > 0
    ? "unknown"
    : generatingCount > 0
      ? "generating"
      : deriveGenerationAttemptState({ okCount, failCount });

  return { attemptId, state, okCount, failCount, expectedCount: drafts.length };
}
