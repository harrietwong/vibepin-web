/**
 * The paid gate for the Insights DIAGNOSIS, as a shape — not as a flag the client is
 * asked to respect.
 *
 * The product decision (2026-08-28): the diagnosis — headline, findings,
 * Keep/Change/Test, the evidence behind them, the weekly report and the scorecards —
 * is a paid capability (Starter and above). The user's own METRICS are not: they are
 * the user's numbers, and putting a number the user already owns behind a paywall is
 * a different and worse product.
 *
 * Three properties this module exists to hold.
 *
 * **A free payload contains no diagnosis, not a hidden one.** `locked: true` replaces
 * the object; there is no headline in a field the page is trusted not to render, and
 * no evidence in a debug key. Anything shipped to the browser is public — a paywall
 * enforced in a component is a paywall enforced by nobody, and the DevTools network
 * tab is the exploit.
 *
 * **The per-row lines go too.** "Seen less often than the middle Pin of its group"
 * is the diagnosis, spread over fifty table rows. Blanking them here rather than in
 * the table component keeps that judgement in one place; the four data-state lines
 * (not collected yet / no permission / waiting on the platform) survive, because
 * those explain why a cell is empty and are not a reading of anything.
 *
 * **Collection is never gated.** Nothing in this file touches the collector. A free
 * account keeps accumulating history every night, so upgrading produces a diagnosis
 * with 30 days behind it instead of an empty page and a month of waiting.
 */

import { PLAN_ENTITLEMENTS } from "../planEntitlements";
import type { PlanKey } from "../pricingPlans";
import type { InsightsContent, InsightsDashboard, InsightsDiagnosisPayload } from "./types";

/** The whole payload a free user gets in place of a diagnosis. */
export const INSIGHTS_DIAGNOSIS_LOCKED = { locked: true } as const;

/**
 * Row lines that describe the DATA STATE rather than the Pin. These survive the
 * gate: they are the answer to "why is this cell empty", which every user is owed.
 */
const DATA_STATE_ROW_KEYS = new Set<string>([
  "insights.diagnosis.noPermission",
  "insights.diagnosis.notCollected",
  "insights.diagnosis.awaitingPlatform",
  "insights.diagnosis.awaitingMetrics",
]);

/** Is this plan entitled to the diagnosis? The single read of the entitlement. */
export function insightsDiagnosisAllowed(plan: PlanKey): boolean {
  return PLAN_ENTITLEMENTS[plan].insightsDiagnosis;
}

/** Narrow a dashboard's `diagnosis` to the locked placeholder. */
export function isDiagnosisLocked(
  value: InsightsDiagnosisPayload,
): value is typeof INSIGHTS_DIAGNOSIS_LOCKED {
  return value !== null && typeof value === "object" && "locked" in value;
}

/**
 * Strip every diagnosis-derived field from one content row.
 *
 * Deliberately an allowlist, not a denylist of known engine keys: a rule added next
 * month emits a key this file has never heard of, and the failure mode of a denylist
 * is to ship it to a free user. The failure mode of an allowlist is an empty line.
 */
function lockContentRow(row: InsightsContent): InsightsContent {
  if (DATA_STATE_ROW_KEYS.has(row.diagnosis)) return row;
  return { ...row, diagnosis: "" };
}

/**
 * The free-plan shape of a dashboard: same metrics, same rows, no reading.
 *
 * Returns a new object; the input is never mutated, because the caller may be
 * handing out a cached dashboard shared with a paid request on the same instance.
 */
export function lockDashboardDiagnosis(dashboard: InsightsDashboard): InsightsDashboard {
  return {
    ...dashboard,
    diagnosis: INSIGHTS_DIAGNOSIS_LOCKED,
    content: dashboard.content.map(lockContentRow),
  };
}

/** `lockDashboardDiagnosis` when the plan is not entitled, the dashboard as-is when it is. */
export function shapeDashboardForPlan(
  dashboard: InsightsDashboard,
  plan: PlanKey,
): InsightsDashboard {
  return insightsDiagnosisAllowed(plan) ? dashboard : lockDashboardDiagnosis(dashboard);
}
