import { getPinLifecycle } from "@/lib/studio/pinLifecycle";
import type { PinDraft } from "@/lib/pinDraftStore";

/**
 * One lifecycle status per Plan card (PRD 0809 §8).
 *
 * Scheduled and Published looked nearly identical on the calendar — both were an image
 * with a time in the corner — so a merchant could not tell at a glance what had already
 * gone out.
 *
 * Colour is an ACCENT, never the message. Every status also carries an icon and a text
 * label, so the distinction survives greyscale, low contrast, and the ~8% of men with a
 * red/green colour vision deficiency, for whom the published/failed pair is exactly the
 * hard case. Nothing here returns a colour on its own.
 */

export type PlanCardStatus = "scheduled" | "published" | "failed";

export type PlanCardStatusStyle = {
  status: PlanCardStatus;
  /** Accent for the border/badge — supporting signal only. */
  accent: string;
  /** Readable on the accent. */
  onAccent: string;
  /** i18n key for the label. Text always accompanies the colour. */
  labelKey: "plan.cardStatus.scheduled" | "plan.cardStatus.published" | "plan.cardStatus.failed";
  /** Which icon to draw — the component maps this to a lucide glyph. */
  icon: "clock" | "check" | "alert";
};

type StatusInput = Partial<PinDraft>;

/**
 * Resolve a draft to exactly one status.
 *
 * Delegated to `getPinLifecycle`, the same source used by Studio cards, the Plan
 * sidebar, and the batch/list actions. This prevents a partial provider outcome from
 * being shown as Published in the calendar while Create Pins asks for attention.
 */
export function planCardStatus(draft: StatusInput | null | undefined): PlanCardStatus {
  if (!draft) return "scheduled";
  // Archived Content is intentionally absent from active Plan/Studio surfaces. A
  // stale receipt must not make a narrow calendar caller resurrect it as attention.
  if (draft.archivedAt) return "scheduled";
  // Calendar callers intentionally pass a narrow display shape. Supply only the
  // compatibility identity required by the destination-result reader; all outcome
  // fields still come from this draft, never from a parallel Plan derivation.
  const lifecycle = getPinLifecycle({ id: "plan-card", imageUrl: "", ...draft } as PinDraft);
  if (lifecycle === "posted") return "published";
  if (lifecycle === "failed" || lifecycle === "needs_attention") return "failed";
  return "scheduled";
}

const STYLES: Record<PlanCardStatus, Omit<PlanCardStatusStyle, "status">> = {
  // Purple — the product's own accent, and distinct from the success/failure pair.
  scheduled: { accent: "#7C3AED", onAccent: "#FFFFFF", labelKey: "plan.cardStatus.scheduled", icon: "clock" },
  published: { accent: "#059669", onAccent: "#FFFFFF", labelKey: "plan.cardStatus.published", icon: "check" },
  // Amber rather than pure red: this is an outcome to act on, not a destructive warning,
  // and it stays distinguishable from the green next to it.
  failed: { accent: "#D97706", onAccent: "#FFFFFF", labelKey: "plan.cardStatus.failed", icon: "alert" },
};

export function planCardStatusStyle(draft: StatusInput | null | undefined): PlanCardStatusStyle {
  const status = planCardStatus(draft);
  return { status, ...STYLES[status] };
}
