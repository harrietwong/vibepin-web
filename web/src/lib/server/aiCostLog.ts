/**
 * aiCostLog.ts — internal AI provider-cost audit ledger (migrate_v58_ai_cost_events).
 *
 * PRD "定价方案 credit 方案 0723" §9: a SEPARATE, internal-only cost ledger, entirely
 * distinct from the user-facing QUOTA ledger. Quota lives in usage_accounts /
 * usage_reservations (v55 + v56), driven by the reserve→settle helpers in
 * web/src/lib/server/usage/ (meterGeneration.ts, meterTextGeneration.ts). That
 * ledger answers "how much of the customer's monthly allowance is left". THIS
 * module answers a different question for a different audience: "what did that
 * call cost US in USD". Nothing here reads or writes usage_accounts, and no cost
 * write can influence a quota decision. This table has NO user-visible UI, no
 * i18n, and drives no enforcement.
 *
 * DESIGN INVARIANT (same posture as the metering helpers / moderatePrompt.ts): cost logging is
 * BEST-EFFORT and must NEVER break a business request. recordAiCost never throws —
 * every failure is caught and logged via console.error only. Callers should invoke
 * it fire-and-forget (`void recordAiCost(...)`) after the real work has already
 * succeeded or failed; a lost cost-log row is acceptable, a broken generation or
 * copy call is not.
 *
 * estimateCost() looks up per-model $ rates from aiCostRates.ts. Those rates
 * default to null (unverified) — estimateCost returns null whenever the relevant
 * rate is missing, so ai_cost_events.estimated_cost is null rather than a
 * fabricated number. Token / image counts are always recorded regardless of
 * whether a $ estimate can be computed.
 */

// supabase.ts creates a client at module load and THROWS without env — so it is
// imported lazily inside recordAiCost only. This keeps aiCostLog (and everything
// that statically imports it: moderatePrompt, support responders, visionServer
// consumers) safe to import from env-less contexts like pure-function test scripts.
import type { createServerClient } from "../supabase";
import { rateForModel } from "./aiCostRates";

/** The subset of the Supabase client this module uses. Injectable for tests. */
export type AiCostDbClient = ReturnType<typeof createServerClient>;

export type AiCostRequestStatus =
  | "success"
  | "partial"
  | "failed"
  | "timeout"
  | "moderation_rejected";

export type RecordAiCostInput = {
  userId?: string | null;
  provider: string;
  model?: string | null;
  operationType: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
  requestedImageCount?: number | null;
  successfulImageCount?: number | null;
  resolution?: string | null;
  estimatedCost?: number | null;
  currency?: string | null;
  requestStatus?: AiCostRequestStatus | string | null;
  plan?: string | null;
  referenceId?: string | null;
  metadata?: Record<string, unknown> | null;
};

/** migrate_v58_ai_cost_events.sql. Service-role only (RLS on, zero policies). */
const TABLE = "ai_cost_events";

/**
 * True only when SUPABASE_SERVICE_ROLE_KEY looks like a real credential rather
 * than the placeholder the hermetic test gate injects. A JWT has three
 * dot-separated segments; the test value ("test-service-key") has none.
 */
function isRealServiceCredential(): boolean {
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
  return key.split(".").length === 3;
}

/**
 * Best-effort write to the ai_cost_events audit ledger. NEVER throws — any
 * failure (network, schema, RLS, etc.) is caught and logged with console.error
 * only, so a broken cost-logging path can never fail the calling business
 * request. Fire-and-forget from call sites (`void recordAiCost(...)`).
 */
export async function recordAiCost(
  input: RecordAiCostInput,
  db?: AiCostDbClient,
): Promise<{ recorded: boolean }> {
  // A caller-supplied client is always honoured (that is the test seam). Without
  // one, only attempt the write when a real service-role credential is present:
  // the hermetic `npm test` gate sets placeholder Supabase env vars, and firing a
  // doomed network insert there is both pointless and slow — it made the parallel
  // runner flap on unrelated suites. No credential ⇒ silently not recorded.
  if (!db && !isRealServiceCredential()) return { recorded: false };
  try {
    const client = db ?? (await import("../supabase")).createServerClient();
    const { error } = await client.from(TABLE).insert([
      {
        user_id: input.userId ?? null,
        provider: input.provider,
        model: input.model ?? null,
        operation_type: input.operationType,
        input_tokens: input.inputTokens ?? null,
        output_tokens: input.outputTokens ?? null,
        requested_image_count: input.requestedImageCount ?? null,
        successful_image_count: input.successfulImageCount ?? null,
        resolution: input.resolution ?? null,
        estimated_cost: input.estimatedCost ?? null,
        currency: input.currency ?? "USD",
        request_status: input.requestStatus ?? null,
        plan: input.plan ?? null,
        reference_id: input.referenceId ?? null,
        metadata: input.metadata ?? null,
      },
    ]);
    if (error) {
      console.error("[aiCostLog.recordAiCost] insert error:", error.message);
      return { recorded: false };
    }
    return { recorded: true };
  } catch (err) {
    console.error(
      "[aiCostLog.recordAiCost] unexpected error:",
      (err as Error)?.message ?? String(err),
    );
    return { recorded: false };
  }
}

export type EstimateCostInput = {
  model?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  imageCount?: number | null;
};

/**
 * Estimate USD cost from token / image counts using the verified rates in
 * aiCostRates.ts. Returns null whenever the model has no verified rate for the
 * dimension being priced — NEVER fabricates a price. A model with a partial
 * rate (e.g. text rates known but no image rate) still returns a partial
 * dollar total for the dimensions that ARE priced; a model with NO rates at
 * all (the default) always returns null.
 */
export function estimateCost(input: EstimateCostInput): number | null {
  const rate = rateForModel(input.model);
  let total = 0;
  let hasAnyRate = false;

  const inputTokens = input.inputTokens ?? 0;
  if (inputTokens > 0 && rate.textPerMillionInputTokens != null) {
    total += (inputTokens / 1_000_000) * rate.textPerMillionInputTokens;
    hasAnyRate = true;
  }

  const outputTokens = input.outputTokens ?? 0;
  if (outputTokens > 0 && rate.textPerMillionOutputTokens != null) {
    total += (outputTokens / 1_000_000) * rate.textPerMillionOutputTokens;
    hasAnyRate = true;
  }

  const imageCount = input.imageCount ?? 0;
  if (imageCount > 0 && rate.perImage != null) {
    total += imageCount * rate.perImage;
    hasAnyRate = true;
  }

  return hasAnyRate ? total : null;
}
