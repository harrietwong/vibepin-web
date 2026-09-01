"use client";

/**
 * The status badge on a Plan card (PRD 0809 §8).
 *
 * Icon + label + accent, always all three. The image is never tinted — a large colour
 * wash over the artwork would fight the Pin itself and still say nothing to anyone who
 * cannot separate the hues.
 */

import { Check, Clock, AlertTriangle } from "lucide-react";
import { planCardStatusStyle } from "@/lib/plan/cardStatus";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import type { CSSProperties } from "react";

const ICONS = { clock: Clock, check: Check, alert: AlertTriangle } as const;

export function PlanCardStatusBadge({
  draft,
  style,
  compact,
}: {
  draft: { postedAt?: string | null; publishError?: string | null; failureType?: string | null; generationStatus?: string | null } | null | undefined;
  style?: CSSProperties;
  /** Icon only, for the smallest tiles — the label still rides `title`/aria-label. */
  compact?: boolean;
}) {
  const { t } = useLocale();
  const s = planCardStatusStyle(draft);
  const Icon = ICONS[s.icon];
  const label = t(s.labelKey);

  return (
    <span
      data-testid={`plan-card-status-${s.status}`}
      data-status={s.status}
      title={label}
      aria-label={label}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: compact ? 0 : 4,
        padding: compact ? "2px" : "1px 6px 1px 4px",
        borderRadius: 5,
        background: s.accent,
        color: s.onAccent,
        fontSize: 9,
        fontWeight: 800,
        letterSpacing: "0.02em",
        lineHeight: 1.5,
        whiteSpace: "nowrap",
        ...style,
      }}
    >
      <Icon size={compact ? 10 : 9} strokeWidth={3} aria-hidden />
      {!compact && label}
    </span>
  );
}
