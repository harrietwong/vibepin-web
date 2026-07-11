"use client";

/**
 * Shared Smart Schedule configuration form. Rendered by BOTH the Weekly Plan
 * Smart Schedule modal and the Settings → Smart Schedule page, reading/writing the
 * ONE canonical smartScheduleConfig (same config source, save logic, preview
 * generation and rebalance flow on both surfaces).
 *
 * Rules in → live preview out: changing any input auto-regenerates the "Generated
 * weekly slots" preview (debounced). There is no required Generate step. Save always
 * persists FRESH slots that match the current form (never stale), then — if eligible
 * future planned Pins exist — asks only whether to rebalance them.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import {
  DAY_NAMES,
  DEFAULT_TIME_WINDOWS,
  generateWeeklySlotsFromConfig,
  getSmartScheduleConfig,
  hasConfiguredSlots,
  hasSmartScheduleInputsChanged,
  localTimeZone,
  saveSmartScheduleConfig,
  subscribeToSmartScheduleConfigChanges,
  clampPinsPerDay,
  type DayName,
  type RhythmMode,
  type SmartScheduleConfig,
  type WeekdayIndex,
} from "@/lib/smartScheduleStore";
import { countEligibleRebalancePins, rebalancePlannedPins, undoRebalance } from "@/lib/smartScheduleRebalance";
import { toast } from "sonner";

const C = {
  text: "var(--app-text)", sec: "var(--app-text-sec)", muted: "var(--app-text-muted)",
  border: "var(--app-border)", surface: "var(--app-surface)", surface2: "var(--app-surface-2)",
  pink: "#C026D3", purple: "#7C3AED", blue: "#3B82F6",
};

const REGEN_DEBOUNCE_MS = 220;

const TZ_QUICK: Array<{ label: string; value: string }> = [
  { label: "US Eastern (America/New_York)",   value: "America/New_York" },
  { label: "US Central (America/Chicago)",    value: "America/Chicago" },
  { label: "US Mountain (America/Denver)",    value: "America/Denver" },
  { label: "US Pacific (America/Los_Angeles)",value: "America/Los_Angeles" },
  { label: "UK (Europe/London)",              value: "Europe/London" },
];

type Props = {
  saveRef?: MutableRefObject<(() => void) | null>;
  onSaved?: () => void;
  /** Retained for back-compat; board rotation is no longer part of the P0 Smart Schedule UI. */
  showBoards?: boolean;
};

export function SmartScheduleConfigForm({ saveRef, onSaved }: Props) {
  const [config, setConfig] = useState<SmartScheduleConfig>(() => getSmartScheduleConfig());
  const [dayTab, setDayTab] = useState<WeekdayIndex>(0);
  const [customTime, setCustomTime] = useState("09:00");
  const [customDay, setCustomDay] = useState<WeekdayIndex>(0);
  const [tzCustom, setTzCustom] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  // Rebalance confirmation: number of eligible future planned Pins (null = closed).
  const [rebalanceCount, setRebalanceCount] = useState<number | null>(null);
  const savedRef = useRef<SmartScheduleConfig>(config);
  const firstRun = useRef(true);

  // Refresh from canonical config on mount + when any other surface saves. This is what
  // makes the modal reflect the SAVED rhythmMode (e.g. "same_every_day") on reopen rather
  // than resetting to Recommended.
  useEffect(() => {
    const sync = () => { const c = getSmartScheduleConfig(); setConfig(c); savedRef.current = c; firstRun.current = true; };
    sync();
    return subscribeToSmartScheduleConfigChanges(sync);
  }, []);

  const patch = useCallback((p: Partial<SmartScheduleConfig>) => setConfig(prev => ({ ...prev, ...p })), []);

  // ── Reactive preview ─────────────────────────────────────────────────────────
  // Any rule change auto-regenerates the Generated weekly slots preview (debounced,
  // deterministic). No Generate click required. Skipped on the first run after a
  // (re)load so merely opening the form doesn't flag unsaved changes.
  const inputsKey = useMemo(() => JSON.stringify({
    rhythmMode: config.rhythmMode,
    pinsPerDay: config.pinsPerDay,
    activeDays: [...config.activeDays].sort(),
    preferredTimeWindows: config.preferredTimeWindows,
    customSlots: config.customSlots,
  }), [config.rhythmMode, config.pinsPerDay, config.activeDays, config.preferredTimeWindows, config.customSlots]);

  useEffect(() => {
    if (firstRun.current) { firstRun.current = false; return; }
    const t = setTimeout(() => {
      setConfig(prev => ({ ...prev, weeklySlots: generateWeeklySlotsFromConfig(prev) }));
    }, REGEN_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [inputsKey]);

  const dirty = useMemo(() => {
    const saved = savedRef.current;
    return saved.timezone !== config.timezone
      || hasSmartScheduleInputsChanged(saved, config)
      || JSON.stringify(saved.weeklySlots) !== JSON.stringify(config.weeklySlots);
  }, [config]);

  // ── Save (+ rebalance flow) ────────────────────────────────────────────────────
  const save = useCallback(() => {
    // Lightweight pre-save validation (matches the inline hints).
    if (!config.timezone.trim()) { toast.error("Choose a publishing timezone."); return; }
    if (config.activeDays.length === 0) { toast.error("Select at least one active day."); return; }
    if (config.preferredTimeWindows.some(w => w.start >= w.end)) { toast.error("End time must be later than start time."); return; }
    // Always persist FRESH slots that match the current rules — never stale.
    const fresh: SmartScheduleConfig = { ...config, weeklySlots: generateWeeklySlotsFromConfig(config) };
    if (!hasConfiguredSlots(fresh)) { toast.error("No publishing slots generated. Check your active days and time windows."); return; }
    saveSmartScheduleConfig(fresh);
    const persisted = getSmartScheduleConfig();
    savedRef.current = persisted;
    firstRun.current = true;
    setConfig(persisted);
    const eligible = countEligibleRebalancePins();
    if (eligible > 0) {
      setRebalanceCount(eligible); // ask only about existing planned Pins
    } else {
      toast.success("Smart Schedule saved.");
      onSaved?.();
    }
  }, [config, onSaved]);

  useEffect(() => { if (saveRef) saveRef.current = save; }, [saveRef, save]);

  function keepCurrentTimes() {
    setRebalanceCount(null);
    toast.success("Smart Schedule saved. Existing planned Pins were unchanged.");
    onSaved?.();
  }

  function rebalanceNow() {
    const res = rebalancePlannedPins();
    setRebalanceCount(null);
    if (res.changed > 0) {
      toast.success(`Rebalanced ${res.changed} planned Pin${res.changed === 1 ? "" : "s"}.`, {
        action: {
          label: "Undo",
          onClick: () => { undoRebalance(res.snapshot); toast.success("Rebalance undone."); },
        },
      });
    } else {
      toast.success("Smart Schedule saved.");
    }
    onSaved?.();
  }

  const localTz = useMemo(() => localTimeZone(), []);
  const tzKnown = config.timezone === localTz || TZ_QUICK.some(t => t.value === config.timezone);

  function onTimezonePick(value: string) {
    if (value === "__custom__") { setTzCustom(true); return; }
    setTzCustom(false);
    patch({ timezone: value });
  }

  function setRhythmMode(mode: RhythmMode) {
    setConfig(prev => (prev.rhythmMode === mode ? prev : { ...prev, rhythmMode: mode }));
  }

  function toggleDay(d: DayName) {
    setConfig(prev => {
      const has = prev.activeDays.includes(d);
      const next = has ? prev.activeDays.filter(x => x !== d) : [...prev.activeDays, d];
      // Allow zero active days so the "Select at least one active day" hint can show.
      return { ...prev, activeDays: next };
    });
  }

  /** Reset to recommended: recommended mode, restore default active days + windows,
   *  regenerate the recommended preview. Does not mutate planned Pins until Save. */
  function resetToRecommended() {
    setConfig(prev => {
      const next: SmartScheduleConfig = {
        ...prev,
        rhythmMode: "recommended",
        activeDays: prev.activeDays.length ? prev.activeDays : [...DAY_NAMES],
        preferredTimeWindows: prev.preferredTimeWindows.length
          ? prev.preferredTimeWindows
          : DEFAULT_TIME_WINDOWS.map(w => ({ ...w })),
      };
      return { ...next, weeklySlots: generateWeeklySlotsFromConfig(next) };
    });
  }

  function updateWindow(i: number, key: "start" | "end", value: string) {
    setConfig(prev => {
      const wins = prev.preferredTimeWindows.map((w, idx) => idx === i ? { ...w, [key]: value } : w);
      return { ...prev, preferredTimeWindows: wins };
    });
  }

  /** Optional manual regenerate (Advanced) — not required; Save regenerates anyway. */
  function regeneratePreview() {
    setConfig(prev => ({ ...prev, weeklySlots: generateWeeklySlotsFromConfig(prev) }));
  }

  function removeCustomSlot(day: WeekdayIndex, time: string) {
    setConfig(prev => {
      const cur = (prev.customSlots[day] ?? []).filter(t => t !== time);
      const customSlots = { ...prev.customSlots };
      if (cur.length) customSlots[day] = cur; else delete customSlots[day];
      return { ...prev, customSlots };
    });
  }

  function addCustomSlot() {
    const m = /^(\d{1,2}):(\d{2})$/.exec(customTime.trim());
    if (!m) { toast.error("Enter a valid time (HH:mm)."); return; }
    const t = `${String(Math.min(23, +m[1])).padStart(2, "0")}:${String(Math.min(59, +m[2])).padStart(2, "0")}`;
    setConfig(prev => {
      const cur = prev.customSlots[customDay] ?? [];
      if (cur.includes(t)) return prev;
      return { ...prev, customSlots: { ...prev.customSlots, [customDay]: [...cur, t].sort() } };
    });
  }

  const daySlots = config.weeklySlots[dayTab] ?? [];
  const dayCustom = config.customSlots[dayTab] ?? [];
  const volumeSummary = config.rhythmMode === "same_every_day"
    ? `Same every day · ${config.pinsPerDay} pins/day`
    : "Recommended rhythm";

  // ── Lightweight inline validation (no error wall) ──────────────────────────────
  const noActiveDays = config.activeDays.length === 0;
  const badWindow = config.preferredTimeWindows.some(w => w.start >= w.end);
  const noSlots = !hasConfiguredSlots(config);
  const noTimezone = !config.timezone.trim();
  const validationError =
    noTimezone ? "Choose a publishing timezone."
    : noActiveDays ? "Select at least one active day."
    : badWindow ? "End time must be later than start time."
    : noSlots ? "No publishing slots generated. Check your active days and time windows."
    : null;

  return (
    <div data-testid="smart-schedule-form" style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* 1. Publishing timezone */}
      <Section title="Publishing timezone">
        <select
          data-testid="smart-schedule-timezone-select"
          value={tzCustom ? "__custom__" : config.timezone}
          onChange={e => onTimezonePick(e.target.value)}
          style={selectCss}
        >
          <option value={localTz}>Local timezone ({localTz})</option>
          {TZ_QUICK.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
          {!tzKnown && <option value={config.timezone}>{config.timezone}</option>}
          <option value="__custom__">Custom…</option>
        </select>
        {tzCustom && (
          <input
            data-testid="smart-schedule-timezone-custom"
            placeholder="e.g. America/New_York"
            defaultValue={config.timezone}
            onBlur={e => { const v = e.target.value.trim(); if (v && v !== config.timezone) patch({ timezone: v }); }}
            style={{ ...inputCss, marginTop: 8 }}
          />
        )}
        <p style={helpCss}>Your schedule uses this timezone for future Pins.</p>
      </Section>

      {/* 2. Posting rhythm — Recommended (system) vs. Same every day (numeric) */}
      <Section title="Posting rhythm">
        <div data-testid="smart-schedule-rhythm-mode" style={{ display: "flex", gap: 6, marginBottom: 12 }}>
          <button type="button" data-testid="smart-schedule-mode-recommended" onClick={() => setRhythmMode("recommended")} style={modeBtn(config.rhythmMode === "recommended")}>Recommended</button>
          <button type="button" data-testid="smart-schedule-mode-same" onClick={() => setRhythmMode("same_every_day")} style={modeBtn(config.rhythmMode === "same_every_day")}>Same every day</button>
        </div>
        {config.rhythmMode === "recommended" ? (
          <p data-testid="smart-schedule-recommended-help" style={{ ...helpCss, marginTop: 0 }}>
            VibePin will generate a balanced weekly posting rhythm based on your active days and preferred time windows.
          </p>
        ) : (
          <div>
            <p style={{ margin: "0 0 6px", fontSize: 11.5, fontWeight: 600, color: C.sec }}>Pins per active day</p>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <button type="button" data-testid="smart-schedule-pins-dec" onClick={() => patch({ pinsPerDay: clampPinsPerDay(config.pinsPerDay - 1) })} style={stepperBtn}>–</button>
              <span data-testid="smart-schedule-pins-value" style={{ minWidth: 30, textAlign: "center", fontSize: 15, fontWeight: 800, color: C.text }}>{config.pinsPerDay}</span>
              <button type="button" data-testid="smart-schedule-pins-inc" onClick={() => patch({ pinsPerDay: clampPinsPerDay(config.pinsPerDay + 1) })} style={stepperBtn}>+</button>
            </div>
            <p style={helpCss}>Every active day will generate exactly {config.pinsPerDay} publishing slot{config.pinsPerDay === 1 ? "" : "s"}.</p>
          </div>
        )}
      </Section>

      {/* 3. Active days */}
      <Section title="Active days">
        <div data-testid="smart-schedule-active-days" style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {DAY_NAMES.map(d => {
            const on = config.activeDays.includes(d);
            return (
              <button key={d} type="button" onClick={() => toggleDay(d)}
                style={{ padding: "5px 11px", borderRadius: 8, fontSize: 11, fontWeight: 700, cursor: "pointer",
                  border: `1px solid ${on ? C.pink : C.border}`, background: on ? "rgba(192,38,211,0.10)" : "transparent", color: on ? C.pink : C.sec }}>
                {d}
              </button>
            );
          })}
        </div>
        {noActiveDays && <p data-testid="smart-schedule-validation-days" style={errCss}>Select at least one active day.</p>}
      </Section>

      {/* 4. Preferred time windows */}
      <Section title="Preferred time windows">
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {config.preferredTimeWindows.map((w, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ width: 78, fontSize: 12, fontWeight: 600, color: C.sec }}>{w.label}</span>
              <input type="time" value={w.start} onChange={e => updateWindow(i, "start", e.target.value)} style={{ ...inputCss, width: 110 }} />
              <span style={{ color: C.muted }}>–</span>
              <input type="time" value={w.end} onChange={e => updateWindow(i, "end", e.target.value)} style={{ ...inputCss, width: 110 }} />
            </div>
          ))}
        </div>
        {badWindow && <p data-testid="smart-schedule-validation-window" style={errCss}>End time must be later than start time.</p>}
      </Section>

      {/* 5. Generated weekly slots — LIVE preview (auto-updates, no Generate needed) */}
      <Section title="Generated weekly slots">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 8 }}>
          <p data-testid="smart-schedule-volume-summary" style={{ margin: 0, fontSize: 11, fontWeight: 600, color: C.sec }}>{volumeSummary}</p>
          {dirty
            ? <span data-testid="smart-schedule-unsaved" style={{ fontSize: 10, fontWeight: 800, color: C.pink, background: "rgba(192,38,211,0.10)", borderRadius: 20, padding: "2px 8px" }}>Unsaved changes</span>
            : <span style={{ fontSize: 10, fontWeight: 700, color: C.muted }}>Live preview</span>}
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 10 }}>
          {DAY_NAMES.map((d, i) => {
            const active = config.activeDays.includes(d);
            const n = config.weeklySlots[i as WeekdayIndex]?.length ?? 0;
            return (
              <button key={d} type="button" data-testid={`smart-schedule-day-${d}`} title={`${d}${n ? ` · ${n} slots` : ""}`} onClick={() => setDayTab(i as WeekdayIndex)}
                style={{ padding: "5px 9px", borderRadius: 8, fontSize: 10.5, fontWeight: 700, cursor: "pointer",
                  border: `1px solid ${dayTab === i ? C.pink : C.border}`,
                  background: dayTab === i ? "rgba(192,38,211,0.10)" : "transparent",
                  color: dayTab === i ? C.pink : active ? C.sec : C.muted, opacity: active ? 1 : 0.6 }}>
                {d}
              </button>
            );
          })}
        </div>
        {/* Selected-day header — weekday name + slot count, never a bare "Tue 4". */}
        <p data-testid="smart-schedule-day-header" style={{ margin: "0 0 6px", fontSize: 11.5, fontWeight: 800, color: C.text }}>
          {DAY_NAMES[dayTab]} · {daySlots.length} slot{daySlots.length === 1 ? "" : "s"}
        </p>
        <div data-testid="smart-schedule-day-slots" style={{ display: "flex", flexWrap: "wrap", gap: 6, minHeight: 30 }}>
          {daySlots.length === 0 ? (
            <span style={{ fontSize: 11.5, color: C.muted }}>No slots for this day.</span>
          ) : daySlots.map(t => {
            const isCustom = dayCustom.includes(t);
            return (
              <span key={t} data-testid="smart-schedule-slot-chip" style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 9px", borderRadius: 8, background: C.surface2, border: `1px solid ${isCustom ? C.pink : C.border}`, fontSize: 11.5, fontWeight: 700, color: C.text, fontVariantNumeric: "tabular-nums" }}>
                {t}
                {isCustom && <button type="button" onClick={() => removeCustomSlot(dayTab, t)} aria-label={`Remove ${t}`} style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 12, lineHeight: 1, padding: 0 }}>✕</button>}
              </span>
            );
          })}
        </div>
        {noSlots && !noActiveDays && <p data-testid="smart-schedule-validation-slots" style={errCss}>No publishing slots generated. Check your active days and time windows.</p>}
        {/* Secondary, optional actions — never required for Save (preview auto-updates). */}
        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <button type="button" data-testid="smart-schedule-regenerate" onClick={regeneratePreview}
            style={{ padding: "7px 12px", borderRadius: 8, border: `1px solid ${C.border}`, background: C.surface2, color: C.sec, fontSize: 11.5, fontWeight: 700, cursor: "pointer" }}>
            Regenerate times
          </button>
          <button type="button" data-testid="smart-schedule-reset-recommended" onClick={resetToRecommended}
            style={{ padding: "7px 12px", borderRadius: 8, border: `1px solid ${C.border}`, background: "transparent", color: C.sec, fontSize: 11.5, fontWeight: 700, cursor: "pointer" }}>
            Reset to recommended
          </button>
        </div>
      </Section>

      {/* 6. Advanced */}
      <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 12 }}>
        <button type="button" data-testid="smart-schedule-advanced-toggle" onClick={() => setAdvancedOpen(o => !o)}
          style={{ background: "none", border: "none", color: C.sec, fontSize: 12, fontWeight: 700, cursor: "pointer", padding: 0 }}>
          {advancedOpen ? "▾" : "▸"} Advanced
        </button>
        {advancedOpen && (
          <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 18 }}>
            {/* Advanced: add custom slot */}
            <Section title="Add custom slot">
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <select value={customDay} onChange={e => setCustomDay(Number(e.target.value) as WeekdayIndex)} style={{ ...selectCss, width: 90 }}>
                  {DAY_NAMES.map((d, i) => <option key={d} value={i}>{d}</option>)}
                </select>
                <input type="time" value={customTime} onChange={e => setCustomTime(e.target.value)} style={{ ...inputCss, width: 120 }} />
                <button type="button" data-testid="smart-schedule-add-slot" onClick={addCustomSlot}
                  style={{ padding: "8px 14px", borderRadius: 8, border: `1px solid ${C.border}`, background: C.surface2, color: C.sec, fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
                  Add custom slot
                </button>
              </div>
              <p style={helpCss}>Custom slots are kept when the preview regenerates.</p>
            </Section>
            {/* Board assignment is intentionally NOT here in P0 — it lives in Pin Details /
                Batch Edit / publish readiness. */}
          </div>
        )}
      </div>

      {/* Rebalance confirmation — only existing planned Pins; future always uses new config */}
      {rebalanceCount !== null && (
        <div onClick={keepCurrentTimes} style={{ position: "fixed", inset: 0, zIndex: 1100, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
          <div data-testid="smart-schedule-rebalance-confirm" onClick={e => e.stopPropagation()} style={{ width: 400, maxWidth: "92vw", background: C.surface, border: `1px solid ${C.border}`, borderRadius: 14, padding: 20 }}>
            <h3 style={{ margin: 0, fontSize: 15, fontWeight: 800, color: C.text }}>Smart Schedule updated</h3>
            <p style={{ margin: "10px 0 0", fontSize: 12.5, color: C.sec, lineHeight: 1.5 }}>
              Your new Smart Schedule will be used for all future scheduled Pins.
            </p>
            <p style={{ margin: "8px 0 0", fontSize: 12.5, color: C.sec, lineHeight: 1.5 }}>
              You already have <strong>{rebalanceCount}</strong> planned Pin{rebalanceCount === 1 ? "" : "s"}. Do you want to update their publish dates and times to match the new schedule?
            </p>
            <ul style={{ margin: "10px 0 16px", paddingLeft: 16, fontSize: 11, color: C.muted, lineHeight: 1.6 }}>
              <li>Only unlocked planned Pins will be updated.</li>
              <li>Locked, posted, past, and manually scheduled Pins will not be changed.</li>
              <li>Dates and times may change.</li>
              <li>You can undo this after rebalancing.</li>
            </ul>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <button type="button" data-testid="smart-schedule-rebalance-confirm-btn" onClick={rebalanceNow}
                style={{ padding: "10px 12px", borderRadius: 9, border: "none", background: `linear-gradient(135deg,#FF4D8D,${C.purple})`, color: "#fff", fontSize: 12.5, fontWeight: 700, cursor: "pointer" }}>
                Rebalance planned Pins
              </button>
              <button type="button" data-testid="smart-schedule-rebalance-keep-btn" onClick={keepCurrentTimes}
                style={{ padding: "10px 12px", borderRadius: 9, border: `1px solid ${C.border}`, background: C.surface2, color: C.sec, fontSize: 12.5, fontWeight: 600, cursor: "pointer" }}>
                Keep current times
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p style={{ margin: "0 0 8px", fontSize: 12, fontWeight: 800, color: C.text }}>{title}</p>
      {children}
    </div>
  );
}

const selectCss: React.CSSProperties = { width: "100%", padding: "9px 11px", borderRadius: 9, border: `1px solid ${C.border}`, background: C.surface2, color: C.text, fontSize: 12.5, cursor: "pointer", outline: "none" };
const inputCss: React.CSSProperties = { padding: "8px 10px", borderRadius: 8, border: `1px solid ${C.border}`, background: C.surface2, color: C.text, fontSize: 12, outline: "none", colorScheme: "dark" };
const stepperBtn: React.CSSProperties = { width: 30, height: 30, borderRadius: 8, border: `1px solid ${C.border}`, background: C.surface2, color: C.text, fontSize: 16, fontWeight: 800, cursor: "pointer", lineHeight: 1 };
function modeBtn(active: boolean): React.CSSProperties {
  return { flex: 1, padding: "8px 12px", borderRadius: 9, fontSize: 12, fontWeight: 700, cursor: "pointer",
    border: `1px solid ${active ? C.pink : C.border}`, background: active ? "rgba(192,38,211,0.10)" : "transparent", color: active ? C.pink : C.sec };
}
const helpCss: React.CSSProperties = { margin: "6px 0 0", fontSize: 11, color: "var(--app-text-muted)", lineHeight: 1.5 };
const errCss: React.CSSProperties = { margin: "8px 0 0", fontSize: 11, fontWeight: 600, color: "#F59E0B", lineHeight: 1.5 };
