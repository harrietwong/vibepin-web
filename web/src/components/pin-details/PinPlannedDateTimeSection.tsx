"use client";

import { Calendar, Clock } from "lucide-react";
import { useLocale } from "@/lib/i18n/LocaleProvider";

// CSS tokens match DraftDetailsDrawer so the extracted section looks identical.
const UI = {
  surface3: "var(--app-surface-3, #0F1524)",
  fieldBorder: "var(--app-border-hi, rgba(255,255,255,0.18))",
  text: "var(--app-text, #E2E8F0)",
  textSec: "var(--app-text-sec, #8892A4)",
  textMuted: "var(--app-text-muted, #5B6577)",
  purple: "#A78BFA",
};

const field: React.CSSProperties = {
  width: "100%", boxSizing: "border-box", padding: "11px 13px", borderRadius: 10,
  border: `1px solid ${UI.fieldBorder}`, fontSize: 13.5, color: UI.text, background: UI.surface3,
  outline: "none", lineHeight: 1.5,
};
const lbl: React.CSSProperties = { fontSize: 12.5, fontWeight: 800, color: UI.text };
const num: React.CSSProperties = { color: UI.textMuted, fontWeight: 800, marginRight: 2 };

export type PinPlannedDateTimeSectionProps = {
  /**
   * ISO date "YYYY-MM-DD". Empty string = not scheduled.
   * Never injected with a midnight default by this component.
   */
  plannedDate: string;
  /**
   * 24-hour time "HH:mm". Empty string = no specific time.
   * Kept strictly separate from plannedDate — never merged here.
   */
  plannedTime: string;
  /**
   * Called when the "Schedule for later" toggle is clicked.
   * The parent decides the new state: clear date+time if currently scheduled,
   * or set to the next plannable date if not. No state lives in this component.
   */
  onToggle: () => void;
  /** Called with the new ISO date string when the date input changes. */
  onDateChange: (date: string) => void;
  /** Called with the new time string when the time input changes. */
  onTimeChange: (time: string) => void;
};

/**
 * Controlled planned date / time section for PinDetailsModal.
 * Presentational only — no API calls, no store writes.
 *
 * Safety guarantees:
 * - plannedDate and plannedTime are always separate props; never combined here.
 * - No midnight default is ever injected by this component.
 * - The toggle fires onToggle(); the parent owns the state transition.
 */
export function PinPlannedDateTimeSection({
  plannedDate,
  plannedTime,
  onToggle,
  onDateChange,
  onTimeChange,
}: PinPlannedDateTimeSectionProps) {
  const { t } = useLocale();
  const isScheduled = !!plannedDate.trim();

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 7 }}>
        <span style={lbl}><span style={num}>6.</span>{t("pinDetails.schedule.plannedDate")}</span>
        <button
          type="button"
          role="switch"
          aria-checked={isScheduled}
          data-testid="draft-schedule-toggle"
          onClick={onToggle}
          style={{ display: "inline-flex", alignItems: "center", gap: 7, background: "none", border: "none", cursor: "pointer", fontSize: 11.5, fontWeight: 600, color: UI.textSec }}
        >
          <span style={{
            width: 32, height: 18, borderRadius: 20,
            background: isScheduled ? UI.purple : UI.surface3,
            border: `1px solid ${isScheduled ? UI.purple : UI.fieldBorder}`,
            position: "relative", transition: "background .15s",
          }}>
            <span style={{
              position: "absolute", top: 1, left: isScheduled ? 15 : 1,
              width: 14, height: 14, borderRadius: "50%", background: "#fff", transition: "left .15s",
            }} />
          </span>
          {t("pinDetails.schedule.scheduleForLater")}
        </button>
      </div>
      {isScheduled ? (
        <div style={{ display: "flex", gap: 8 }}>
          <div style={{ position: "relative", flex: 1 }}>
            <Calendar size={14} style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", color: UI.textMuted, pointerEvents: "none" }} />
            <input
              data-testid="draft-edit-planned-date"
              type="date"
              value={plannedDate}
              onChange={e => onDateChange(e.target.value)}
              style={{ ...field, paddingLeft: 34, colorScheme: "dark" }}
            />
          </div>
          <div style={{ position: "relative", flex: 1 }}>
            <Clock size={14} style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", color: UI.textMuted, pointerEvents: "none" }} />
            <input
              data-testid="draft-edit-planned-time"
              type="time"
              value={plannedTime}
              onChange={e => onTimeChange(e.target.value)}
              style={{ ...field, paddingLeft: 34, colorScheme: "dark" }}
            />
          </div>
        </div>
      ) : (
        <p data-testid="draft-not-scheduled" style={{ margin: 0, fontSize: 12.5, color: UI.textMuted }}>{t("pinDetails.schedule.notScheduled")}</p>
      )}
    </>
  );
}
