"use client";

/**
 * CustomTimeModal — month/day calendar + hour/minute/AM-PM picker used by the
 * "Select a custom time" affordance in DraftDetailsDrawer's schedule footer.
 *
 * Presentational + self-contained date math only. It does NOT write to
 * pinDraftStore — the parent (DraftDetailsDrawer) owns persistence through the
 * EXISTING scheduledDate/scheduledTime fields, exactly like the default Schedule
 * path. This modal's only job is to produce a validated Date and hand it back via
 * onSave(date).
 *
 * Time entry is 12-hour + AM/PM (matches the "Jul 16, 12:21 PM" example format in
 * the spec) — the app has no per-locale 24h/12h switch elsewhere (existing time
 * <input type="time">s are browser-native 24h fields), so this keeps a single,
 * predictable convention rather than guessing locale hour-cycle.
 */

import { useEffect, useMemo, useState } from "react";
import { Clock, X, ChevronLeft, ChevronRight } from "lucide-react";
import { useLocale } from "@/lib/i18n/LocaleProvider";

const UI = {
  card: "var(--app-surface, #161D2E)",
  surface2: "var(--app-surface-2, #1A2236)",
  surface3: "var(--app-surface-3, #0F1524)",
  border: "var(--app-border, rgba(255,255,255,0.10))",
  fieldBorder: "var(--app-border-hi, rgba(255,255,255,0.18))",
  text: "var(--app-text, #E2E8F0)",
  textSec: "var(--app-text-sec, #8892A4)",
  textMuted: "var(--app-text-muted, #5B6577)",
  purple: "#A78BFA",
  purpleBg: "rgba(139,92,246,0.16)",
  error: "#EF4444",
};

export type CustomTimeModalProps = {
  open: boolean;
  /** Seed date (YYYY-MM-DD, local). Falls back to tomorrow when empty/invalid. */
  initialDate?: string;
  /** Seed time (HH:mm, 24h local). Falls back to 09:00 when empty/invalid. */
  initialTime?: string;
  /** IANA timezone name shown in the footer note (browser timezone — no workspace
   *  timezone concept exists in this app). */
  timeZoneName: string;
  onClose: () => void;
  /** Called with the confirmed local date (YYYY-MM-DD) + time (HH:mm 24h). */
  onSave: (date: string, time: string) => void;
};

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function todayLocalStart(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function parseSeedDate(value?: string): Date {
  if (value && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split("-").map(Number);
    const parsed = new Date(y, m - 1, d);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  const fallback = todayLocalStart();
  fallback.setDate(fallback.getDate() + 1);
  return fallback;
}

function parseSeedTime(value?: string): { hour24: number; minute: number } {
  if (value && /^\d{2}:\d{2}$/.test(value)) {
    const [h, m] = value.split(":").map(Number);
    if (h >= 0 && h <= 23 && m >= 0 && m <= 59) return { hour24: h, minute: m };
  }
  return { hour24: 9, minute: 0 };
}

function to12Hour(hour24: number): { hour12: number; isPM: boolean } {
  const isPM = hour24 >= 12;
  let hour12 = hour24 % 12;
  if (hour12 === 0) hour12 = 12;
  return { hour12, isPM };
}

function to24Hour(hour12: number, isPM: boolean): number {
  const h = hour12 % 12;
  return isPM ? h + 12 : h;
}

function localDateISO(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** Mon-first 6-row calendar grid for the given month anchor, with leading/trailing
 *  days from adjacent months filled in (nulled out visually, never selectable). */
function buildCalendarGrid(monthAnchor: Date): Array<{ date: Date; inMonth: boolean }> {
  const year = monthAnchor.getFullYear();
  const month = monthAnchor.getMonth();
  const firstOfMonth = new Date(year, month, 1);
  // Mon=0..Sun=6
  const firstWeekday = (firstOfMonth.getDay() + 6) % 7;
  const gridStart = new Date(year, month, 1 - firstWeekday);
  const days: Array<{ date: Date; inMonth: boolean }> = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(gridStart);
    d.setDate(gridStart.getDate() + i);
    days.push({ date: d, inMonth: d.getMonth() === month });
  }
  return days;
}

export function CustomTimeModal({ open, initialDate, initialTime, timeZoneName, onClose, onSave }: CustomTimeModalProps) {
  const { t } = useLocale();
  const seedDate = useMemo(() => parseSeedDate(initialDate), [initialDate]);
  const seedTime = useMemo(() => parseSeedTime(initialTime), [initialTime]);

  const [monthAnchor, setMonthAnchor] = useState(() => new Date(seedDate.getFullYear(), seedDate.getMonth(), 1));
  const [selectedDate, setSelectedDate] = useState(seedDate);
  const [hour12, setHour12] = useState(() => to12Hour(seedTime.hour24).hour12);
  const [isPM, setIsPM] = useState(() => to12Hour(seedTime.hour24).isPM);
  const [minute, setMinute] = useState(seedTime.minute);
  const [error, setError] = useState<string | null>(null);

  // Re-seed whenever the modal is (re)opened, so a prior in-progress edit never
  // leaks into a later open with different initial values.
  useEffect(() => {
    if (!open) return;
    const d = parseSeedDate(initialDate);
    const tm = parseSeedTime(initialTime);
    setMonthAnchor(new Date(d.getFullYear(), d.getMonth(), 1));
    setSelectedDate(d);
    const { hour12: h12, isPM: pm } = to12Hour(tm.hour24);
    setHour12(h12);
    setIsPM(pm);
    setMinute(tm.minute);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const today = todayLocalStart();
  const grid = buildCalendarGrid(monthAnchor);
  const monthLabel = monthAnchor.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  const weekdayLabels = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

  function goPrevMonth() {
    setMonthAnchor(prev => new Date(prev.getFullYear(), prev.getMonth() - 1, 1));
  }
  function goNextMonth() {
    setMonthAnchor(prev => new Date(prev.getFullYear(), prev.getMonth() + 1, 1));
  }

  function pickDay(d: Date) {
    if (d < today) return; // past days unselectable
    setSelectedDate(d);
    setError(null);
  }

  function handleSave() {
    // Full-datetime validation (not just the day) — a past day is blocked at
    // selection time, but "today" + a past hour/minute must also be rejected.
    const resolvedHour24 = to24Hour(hour12, isPM);
    const candidate = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), selectedDate.getDate(), resolvedHour24, minute, 0, 0);
    if (candidate.getTime() <= Date.now()) {
      setError(t("pinDetails.customTime.pastTimeError"));
      return;
    }
    onSave(localDateISO(selectedDate), `${pad2(resolvedHour24)}:${pad2(minute)}`);
  }

  return (
    <>
      <div
        data-testid="custom-time-backdrop"
        onClick={onClose}
        style={{ position: "fixed", inset: 0, zIndex: 120, background: "rgba(0,0,0,0.6)" }}
      />
      <div
        data-testid="custom-time-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t("pinDetails.customTime.modalTitle")}
        style={{
          position: "fixed", left: "50%", top: "50%", transform: "translate(-50%,-50%)", zIndex: 121,
          width: 340, maxWidth: "calc(100vw - 32px)", maxHeight: "calc(100vh - 32px)", overflow: "auto",
          background: UI.card, border: `1px solid ${UI.border}`, borderRadius: 16,
          boxShadow: "0 24px 70px rgba(0,0,0,0.5)", display: "flex", flexDirection: "column",
        }}
      >
        <header style={{ padding: "14px 16px", borderBottom: `1px solid ${UI.border}`, display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: 0 }}>
          <h2 style={{ margin: 0, fontSize: 14, fontWeight: 800, color: UI.text }}>{t("pinDetails.customTime.modalTitle")}</h2>
          <button
            type="button"
            data-testid="custom-time-close"
            onClick={onClose}
            aria-label={t("pinDetails.customTime.close")}
            style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 26, height: 26, borderRadius: 8, border: "none", background: "transparent", color: UI.textSec, cursor: "pointer" }}
          >
            <X size={16} />
          </button>
        </header>

        <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 14 }}>
          {/* Month/year header + prev/next nav */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <button
              type="button"
              data-testid="custom-time-prev-month"
              onClick={goPrevMonth}
              aria-label={t("pinDetails.customTime.prevMonth")}
              style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 28, height: 28, borderRadius: 8, border: `1px solid ${UI.fieldBorder}`, background: UI.surface3, color: UI.text, cursor: "pointer" }}
            >
              <ChevronLeft size={15} />
            </button>
            <span data-testid="custom-time-month-label" style={{ fontSize: 13, fontWeight: 800, color: UI.text }}>{monthLabel}</span>
            <button
              type="button"
              data-testid="custom-time-next-month"
              onClick={goNextMonth}
              aria-label={t("pinDetails.customTime.nextMonth")}
              style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 28, height: 28, borderRadius: 8, border: `1px solid ${UI.fieldBorder}`, background: UI.surface3, color: UI.text, cursor: "pointer" }}
            >
              <ChevronRight size={15} />
            </button>
          </div>

          {/* Day grid */}
          <div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2, marginBottom: 4 }}>
              {weekdayLabels.map(w => (
                <span key={w} style={{ textAlign: "center", fontSize: 10, fontWeight: 700, color: UI.textMuted }}>{w}</span>
              ))}
            </div>
            <div data-testid="custom-time-day-grid" style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2 }}>
              {grid.map(({ date, inMonth }, i) => {
                const isPast = date < today;
                const isSelected = isSameDay(date, selectedDate);
                return (
                  <button
                    key={i}
                    type="button"
                    data-testid="custom-time-day"
                    data-date={localDateISO(date)}
                    data-disabled={isPast ? "true" : "false"}
                    disabled={isPast}
                    onClick={() => pickDay(date)}
                    style={{
                      aspectRatio: "1", display: "flex", alignItems: "center", justifyContent: "center",
                      borderRadius: 8, border: "none", fontSize: 12, fontWeight: isSelected ? 800 : 600,
                      cursor: isPast ? "not-allowed" : "pointer",
                      background: isSelected ? UI.purple : "transparent",
                      color: isPast ? UI.textMuted : isSelected ? "#fff" : inMonth ? UI.text : UI.textMuted,
                      opacity: isPast ? 0.35 : inMonth ? 1 : 0.5,
                    }}
                  >
                    {date.getDate()}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Hour / minute / AM-PM */}
          <div>
            <div style={{ fontSize: 11.5, fontWeight: 800, color: UI.text, marginBottom: 6 }}>{t("pinDetails.customTime.modalTitle")}</div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <label style={{ display: "flex", flexDirection: "column", gap: 3, flex: 1 }}>
                <span style={{ fontSize: 9.5, color: UI.textMuted }}>{t("pinDetails.customTime.hour")}</span>
                <input
                  data-testid="custom-time-hour-input"
                  type="number"
                  min={1}
                  max={12}
                  value={hour12}
                  onChange={e => {
                    const raw = Number(e.target.value);
                    if (Number.isNaN(raw)) return;
                    const clamped = Math.min(12, Math.max(1, Math.round(raw)));
                    setHour12(clamped);
                    setError(null);
                  }}
                  style={{ width: "100%", boxSizing: "border-box", padding: "9px 10px", borderRadius: 9, border: `1px solid ${UI.fieldBorder}`, fontSize: 14, fontWeight: 700, color: UI.text, background: UI.surface3, outline: "none", textAlign: "center" }}
                />
              </label>
              <span style={{ fontSize: 16, fontWeight: 800, color: UI.textMuted, marginTop: 14 }}>:</span>
              <label style={{ display: "flex", flexDirection: "column", gap: 3, flex: 1 }}>
                <span style={{ fontSize: 9.5, color: UI.textMuted }}>{t("pinDetails.customTime.minute")}</span>
                <input
                  data-testid="custom-time-minute-input"
                  type="number"
                  min={0}
                  max={59}
                  value={pad2(minute)}
                  onChange={e => {
                    const raw = Number(e.target.value);
                    if (Number.isNaN(raw)) return;
                    const clamped = Math.min(59, Math.max(0, Math.round(raw)));
                    // Minutes only ever change from an explicit user edit here — never
                    // auto-adjusted elsewhere (no rounding/snapping on hour change, no
                    // effect resets this).
                    setMinute(clamped);
                    setError(null);
                  }}
                  style={{ width: "100%", boxSizing: "border-box", padding: "9px 10px", borderRadius: 9, border: `1px solid ${UI.fieldBorder}`, fontSize: 14, fontWeight: 700, color: UI.text, background: UI.surface3, outline: "none", textAlign: "center" }}
                />
              </label>
              <div style={{ display: "flex", flexDirection: "column", gap: 3, marginTop: 14 }}>
                <div style={{ display: "flex", borderRadius: 9, border: `1px solid ${UI.fieldBorder}`, overflow: "hidden" }}>
                  <button
                    type="button"
                    data-testid="custom-time-am"
                    onClick={() => { setIsPM(false); setError(null); }}
                    aria-pressed={!isPM}
                    style={{ padding: "9px 10px", border: "none", fontSize: 11.5, fontWeight: 800, cursor: "pointer", background: !isPM ? UI.purpleBg : "transparent", color: !isPM ? UI.purple : UI.textSec }}
                  >
                    {t("pinDetails.customTime.am")}
                  </button>
                  <button
                    type="button"
                    data-testid="custom-time-pm"
                    onClick={() => { setIsPM(true); setError(null); }}
                    aria-pressed={isPM}
                    style={{ padding: "9px 10px", border: "none", fontSize: 11.5, fontWeight: 800, cursor: "pointer", background: isPM ? UI.purpleBg : "transparent", color: isPM ? UI.purple : UI.textSec }}
                  >
                    {t("pinDetails.customTime.pm")}
                  </button>
                </div>
              </div>
            </div>
          </div>

          {error && (
            <p data-testid="custom-time-error" style={{ margin: 0, fontSize: 11.5, fontWeight: 700, color: UI.error }}>{error}</p>
          )}

          <p data-testid="custom-time-tz-note" style={{ margin: 0, fontSize: 10.5, color: UI.textMuted, display: "flex", alignItems: "center", gap: 5 }}>
            <Clock size={11} />
            {t("pinDetails.customTime.timezoneNote").replace("{timezone}", timeZoneName)}
          </p>
        </div>

        <div style={{ padding: "12px 16px", borderTop: `1px solid ${UI.border}`, display: "flex", justifyContent: "flex-end", flexShrink: 0 }}>
          <button
            type="button"
            data-testid="custom-time-save"
            onClick={handleSave}
            style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "9px 16px", borderRadius: 9, border: "none", background: "#7C3AED", color: "#fff", fontSize: 12.5, fontWeight: 800, cursor: "pointer" }}
          >
            {t("pinDetails.customTime.saveButton")}
          </button>
        </div>
      </div>
    </>
  );
}
