/**
 * Server-side usage metering (migrate_v57 usage_events).
 *
 * Three INDEPENDENT monthly quotas (AI images, AI text generations, scheduled
 * posts) — NOT a shared credit balance. Each usage_type is summed on its own over
 * the current UTC calendar month and compared to the plan limit from
 * planEntitlements.ts. See the migration header for the ledger model.
 *
 * Server-only (service-role client via createServerClient) — never import from
 * client code.
 *
 * DESIGN INVARIANT: metering must NEVER break a business request. recordUsage
 * catches every failure and logs it (console.error) — a lost metering row is
 * acceptable; a failed generation because the ledger was down is not. The plan
 * for `checkAllowance` is resolved by the caller (resolvePlan) so this module has
 * no auth dependency.
 */

import { createServerClient } from "../supabase";
import { resolvePlan, type PlanKey } from "./entitlements";
import { limitForUsageType, type MeteredUsageType } from "../planEntitlements";

/**
 * The subset of the Supabase client this module uses. Injectable so unit tests can
 * drive metering with an in-memory fake (no live DB) — mirrors creemStore's
 * CreemDbClient pattern.
 */
export type UsageDbClient = ReturnType<typeof createServerClient>;

export type UsageOperation =
  | "consume"
  | "release"
  | "reverse"
  | "reset"
  | "manual_adjustment";

export type RecordUsageInput = {
  ownerId: string;
  usageType: MeteredUsageType;
  operation: UsageOperation;
  quantity: number;
  referenceType: string;
  referenceId: string;
  idempotencyKey: string;
  ownerType?: "user" | "workspace";
  metadata?: Record<string, unknown> | null;
};

const TABLE = "usage_events";

/** Operations that ADD to the period balance. */
const ADDS: ReadonlySet<UsageOperation> = new Set(["consume"]);
/** Operations that SUBTRACT from the period balance. */
const SUBTRACTS: ReadonlySet<UsageOperation> = new Set(["release", "reverse"]);

/**
 * Record a single usage event. Idempotent on idempotency_key
 * (ON CONFLICT DO NOTHING → a retried request with the same key is not counted
 * twice). NEVER throws: on any failure it logs and returns { recorded: false } so
 * the calling business request proceeds unaffected.
 */
export async function recordUsage(
  input: RecordUsageInput,
  db: UsageDbClient = createServerClient(),
): Promise<{ recorded: boolean }> {
  try {
    if (!Number.isFinite(input.quantity) || input.quantity <= 0) {
      // quantity must be a positive integer (DB check mirrors this) — a
      // zero-quantity "success" (e.g. 0 images produced) simply records nothing.
      return { recorded: false };
    }
    const { error } = await db
      .from(TABLE)
      .upsert(
        [
          {
            owner_type: input.ownerType ?? "user",
            owner_id: input.ownerId,
            usage_type: input.usageType,
            operation: input.operation,
            quantity: Math.floor(input.quantity),
            reference_type: input.referenceType,
            reference_id: input.referenceId,
            idempotency_key: input.idempotencyKey,
            metadata: input.metadata ?? null,
          },
        ],
        { onConflict: "idempotency_key", ignoreDuplicates: true },
      );
    if (error) {
      console.error("[usage.recordUsage] insert error:", error.message);
      return { recorded: false };
    }
    return { recorded: true };
  } catch (err) {
    console.error(
      "[usage.recordUsage] unexpected error:",
      (err as Error)?.message ?? String(err),
    );
    return { recorded: false };
  }
}

// ── Period window (UTC calendar month) ────────────────────────────────────────

/** First instant of the current UTC calendar month. */
export function periodStart(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
}

/** First instant of the NEXT UTC calendar month (exclusive period end). */
export function periodEnd(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0));
}

export type UsageSummary = {
  ai_image: number;
  ai_text_generation: number;
  scheduled_post: number;
};

/**
 * Net used-this-period per usage_type: sum(consume) - sum(release + reverse),
 * floored at 0. Reads all this-period rows for the owner in one query and folds
 * them client-side (small volume per user per month). On error returns all-zeros
 * so a read failure never blocks (checkAllowance treats it as "nothing used").
 */
export async function getUsageSummary(
  ownerId: string,
  now: Date = new Date(),
  db: UsageDbClient = createServerClient(),
): Promise<UsageSummary> {
  const summary: UsageSummary = {
    ai_image: 0,
    ai_text_generation: 0,
    scheduled_post: 0,
  };
  try {
    const { data, error } = await db
      .from(TABLE)
      .select("usage_type, operation, quantity")
      .eq("owner_id", ownerId)
      .gte("created_at", periodStart(now).toISOString())
      .lt("created_at", periodEnd(now).toISOString());
    if (error || !data) {
      if (error) console.error("[usage.getUsageSummary] select error:", error.message);
      return summary;
    }
    for (const row of data as Array<{
      usage_type: string;
      operation: string;
      quantity: number;
    }>) {
      if (!(row.usage_type in summary)) continue;
      const key = row.usage_type as MeteredUsageType;
      const qty = Number(row.quantity) || 0;
      if (ADDS.has(row.operation as UsageOperation)) summary[key] += qty;
      else if (SUBTRACTS.has(row.operation as UsageOperation)) summary[key] -= qty;
      // reset / manual_adjustment are intentionally NOT auto-summed here; they are
      // audit rows applied out-of-band. (No consumer this round.)
    }
  } catch (err) {
    console.error(
      "[usage.getUsageSummary] unexpected error:",
      (err as Error)?.message ?? String(err),
    );
  }
  // Floor at 0 — a release without a matching consume must not go negative.
  summary.ai_image = Math.max(0, summary.ai_image);
  summary.ai_text_generation = Math.max(0, summary.ai_text_generation);
  summary.scheduled_post = Math.max(0, summary.scheduled_post);
  return summary;
}

// ── Allowance check ───────────────────────────────────────────────────────────

export type AllowanceResult = {
  allowed: boolean;
  used: number;
  limit: number | null;
};

/**
 * Emergency kill switch: when USAGE_ENFORCEMENT=0, checkAllowance always allows
 * (metering still records — only enforcement is disabled).
 */
function enforcementDisabled(): boolean {
  return process.env.USAGE_ENFORCEMENT === "0";
}

/**
 * Would `requestedQty` more of `usageType` fit within the plan's monthly limit?
 *
 * - limit === null → always allowed (uncapped / unlimited plan).
 * - USAGE_ENFORCEMENT=0 → always allowed (kill switch).
 * - otherwise allowed when (used + requestedQty) <= limit.
 *
 * `plan` is optional — when omitted it is resolved from resolvePlan(ownerId).
 * Never throws: a read failure resolves to used=0 (fail-open) so a metering
 * outage cannot lock users out of the product.
 */
export async function checkAllowance(
  ownerId: string,
  usageType: MeteredUsageType,
  requestedQty: number,
  plan?: PlanKey,
  now: Date = new Date(),
  db: UsageDbClient = createServerClient(),
): Promise<AllowanceResult> {
  let resolved: PlanKey = plan ?? "free";
  if (!plan) {
    try {
      resolved = await resolvePlan(ownerId);
    } catch {
      resolved = "free";
    }
  }
  const limit = limitForUsageType(resolved, usageType);
  const summary = await getUsageSummary(ownerId, now, db);
  const used = summary[usageType];

  if (enforcementDisabled() || limit === null) {
    return { allowed: true, used, limit };
  }
  const qty = Math.max(0, Math.floor(requestedQty) || 0);
  return { allowed: used + qty <= limit, used, limit };
}
