import type { SupportCategory, SupportPriority } from "./types";

/**
 * Automatic priority rules. Callers may pass `scheduleFailed: true` to bump a
 * Scheduling issue from Normal to High (per product spec — a schedule that
 * silently didn't fire is more urgent than a "how does scheduling work" question).
 */
export function computeAutoPriority(
  category: SupportCategory,
  opts?: { scheduleFailed?: boolean },
): SupportPriority {
  switch (category) {
    case "credits_issue":
    case "ai_generation_issue":
    case "billing_or_subscription":
    case "publishing_issue":
    case "pinterest_connection_issue":
      return "High";
    case "scheduling_issue":
      return opts?.scheduleFailed ? "High" : "Normal";
    case "bug_report":
      return "Normal";
    case "feature_request":
      return "Low";
    case "other":
    default:
      return "Normal";
  }
}
