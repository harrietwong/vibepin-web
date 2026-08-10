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

type StatusInput = {
  postedAt?: string | null;
  publishError?: string | null;
  failureType?: string | null;
  generationStatus?: string | null;
};

/**
 * Resolve a draft to exactly one status.
 *
 * Order matters: published wins over a stale error (a Pin that failed, was retried and
 * then succeeded is Published, not Failed), and failure is only claimed on an explicit
 * signal — never inferred from "not published yet", which is the normal scheduled state.
 */
export function planCardStatus(draft: StatusInput | null | undefined): PlanCardStatus {
  if (!draft) return "scheduled";
  if (draft.postedAt) return "published";
  const failed =
    !!draft.publishError
    || draft.failureType === "publish"
    || draft.failureType === "generation"
    || /fail/i.test(draft.generationStatus ?? "");
  return failed ? "failed" : "scheduled";
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
