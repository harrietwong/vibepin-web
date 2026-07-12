/**
 * Single Pin detector — pure, lightweight.
 *
 * Reuses the canonical `getPinReadiness` from `pinReadiness` so the single-pin view
 * agrees with Weekly Plan and Batch Edit on what "ready" means. Findings are intentionally
 * calm: a readiness confirmation plus at most a couple of gentle nudges. No mutation
 * handlers here — the edit modal is where the user makes the change.
 */
import { getPinReadiness, REQUIRED_FIELD_LABELS, type ReadinessInput } from "@/lib/pinReadiness";
import type { AssistantFinding } from "../types";

export type SinglePinInput = ReadinessInput & {
  /**
   * Whether a Pinterest board is chosen on THIS surface. Studio pins get their board
   * later in Weekly Plan, so the studio single-pin view passes false and "board" is
   * dropped from the required set — never flag a field the surface doesn't manage.
   */
  boardManaged?: boolean;
  /** True when a destination URL was set by the user (won't be overwritten by generation). */
  destinationIsCustom?: boolean;
  /** True when the linked product is an Amazon/affiliate product with a valid tag. */
  affiliateReady?: boolean;
  /** True when a product is linked at all. */
  hasProduct?: boolean;
  /** True when a schedule time is required but missing. */
  scheduleTimeMissing?: boolean;
};

function clean(v: string | null | undefined): string {
  const s = (v ?? "").trim();
  return s === "undefined" || s === "null" ? "" : s;
}

export function detectSinglePin(pin: SinglePinInput): AssistantFinding[] {
  const out: AssistantFinding[] = [];
  const readiness = getPinReadiness(pin);
  // Drop fields this surface doesn't manage so we never flag them as missing.
  const missingFields = pin.boardManaged === false
    ? readiness.missingFields.filter((f) => f !== "board")
    : readiness.missingFields;
  const detailsStatus = missingFields.length === 0 ? "ready" : "need_details";

  if (detailsStatus === "ready") {
    out.push({
      id: "single:ready",
      severity: "ready",
      title: "This Pin is ready to schedule",
      detail: "Title, description, board, and destination are all set.",
      actions: [{ kind: "explain", label: "Explain", explanation: "All required publishing fields are present, so you can schedule this Pin now." }],
    });
  } else {
    const labels = missingFields.map((f) => REQUIRED_FIELD_LABELS[f]);
    out.push({
      id: "single:missing",
      severity: "issue",
      title: `Missing before scheduling: ${labels.join(", ")}`,
      detail: "Fill these fields to make the Pin ready.",
      actions: [{ kind: "explain", label: "Explain", explanation: `A Pin needs ${labels.join(", ").toLowerCase()} before it can publish.` }],
    });
  }

  if (pin.scheduleTimeMissing) {
    out.push({
      id: "single:schedule-time",
      severity: "issue",
      title: "Schedule time is missing",
      detail: "Pick a date and time so this Pin can be queued.",
      actions: [{ kind: "explain", label: "Explain", explanation: "The Pin is added to the plan but has no scheduled time yet." }],
    });
  }

  if (pin.hasProduct) {
    out.push(
      pin.affiliateReady
        ? {
            id: "single:affiliate",
            severity: "ready",
            title: "Product affiliate link is ready",
            detail: "The linked product carries a valid affiliate tag.",
            actions: [{ kind: "explain", label: "Explain", explanation: "Your Amazon Associates tag is attached to this Pin's destination." }],
          }
        : {
            id: "single:affiliate",
            severity: "suggestion",
            title: "Product link needs a check",
            detail: "Confirm the product link (and affiliate tag, if applicable) is valid.",
            actions: [{ kind: "explain", label: "Explain", explanation: "A linked product should have a working destination and, for Amazon, your associate tag." }],
          },
    );
  }

  if (pin.destinationIsCustom && clean(pin.destinationUrl)) {
    out.push({
      id: "single:custom-url",
      severity: "ready",
      title: "Destination URL is custom and will not be overwritten",
      detail: "Your manual URL is preserved through regeneration.",
      actions: [{ kind: "explain", label: "Explain", explanation: "Because you set this URL yourself, generation won't replace it." }],
    });
  }

  // Single-pin readiness cards are all real, data-driven → shown proactively.
  return out.map((f) => ({ proactive: true, ...f }));
}
