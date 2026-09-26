"use client";

import { useState } from "react";
import { Check, CheckCircle2, Link2, Loader2, RotateCcw, Sparkles, X } from "lucide-react";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import { BUI } from "./boardUI";

/**
 * idle      — nothing generated for this link yet: "Generate copy"
 * busy      — a run is in flight
 * generated — copy was generated for exactly this link: green "Generated"
 * stale     — copy exists but the link changed since (or its link is unknown): "Regenerate"
 */
export type LinkCopyState = "idle" | "busy" | "generated" | "stale";

const looksLikeUrl = (value: string) => /^https?:\/\/[^\s/]+\.[^\s]+/i.test(value.trim());

/**
 * The card's Website URL field with the AI-copy action built into its right edge
 * (link first, like Pinterest's own composer). The action still runs the card's
 * shared AI Copy panel — this component only renders the input and the button.
 */
export function LinkCopyField({ id, value, disabled, actionDisabled, state, busyLabel, onChange, onBlur, onClear, onGenerate }: {
  id: string;
  value: string;
  disabled?: boolean;
  /** Blocks only the AI action (e.g. an Amazon card still missing its product name). */
  actionDisabled?: boolean;
  state: LinkCopyState;
  busyLabel?: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  onClear: () => void;
  onGenerate: () => void;
}) {
  const { t: tr } = useLocale();
  const [focused, setFocused] = useState(false);
  const valid = looksLikeUrl(value);
  const borderColor = focused ? BUI.purple : state === "generated" ? "rgba(16,185,129,.55)" : BUI.border;
  const actionOff = disabled || actionDisabled || state === "busy";

  const action = state === "busy" ? (
    <><Loader2 className="animate-spin" style={{ width: 12, height: 12 }} /> {busyLabel || tr("studioBoard.card.linkCopy.generating")}</>
  ) : state === "generated" ? (
    <><CheckCircle2 style={{ width: 12, height: 12 }} /> {tr("studioBoard.card.linkCopy.generated")}</>
  ) : state === "stale" ? (
    <><RotateCcw style={{ width: 12, height: 12 }} /> {tr("studioBoard.card.linkCopy.regenerate")}</>
  ) : (
    <><Sparkles style={{ width: 12, height: 12 }} /> {tr("pinForm.generateCopy")}</>
  );
  const actionColors = state === "generated"
    ? { background: "rgba(16,185,129,.14)", color: "#10B981" }
    : { background: "rgba(124,58,237,.14)", color: BUI.purple };

  return (
    <div data-testid="card-link-copy-field" data-state={state}
      style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, padding: "4px 4px 4px 9px", borderRadius: 9,
        border: `1px solid ${borderColor}`, background: BUI.surface, boxShadow: focused ? "0 0 0 3px rgba(124,58,237,.18)" : "none",
        opacity: disabled ? 0.6 : 1, transition: "border-color .15s, box-shadow .15s" }}>
      {valid
        ? <Check aria-hidden="true" style={{ width: 14, height: 14, flexShrink: 0, color: "#fff", background: "#10B981", borderRadius: 999, padding: 2 }} />
        : <Link2 aria-hidden="true" style={{ width: 14, height: 14, flexShrink: 0, color: BUI.purple }} />}
      <input id={id} data-testid="board-card-url" value={value} disabled={disabled}
        onChange={event => onChange(event.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => { setFocused(false); onBlur?.(); }}
        placeholder={tr("studioBoard.card.linkCopy.placeholder")}
        style={{ flex: 1, minWidth: 0, border: 0, outline: "none", background: "transparent", color: BUI.text, fontSize: 11.5, padding: "5px 0", fontFamily: "inherit" }} />
      {value && !disabled && (
        <button type="button" data-testid="card-link-clear" aria-label={tr("studioBoard.card.linkCopy.clear")} onClick={onClear}
          style={{ width: 22, height: 22, flexShrink: 0, display: "grid", placeItems: "center", padding: 0, border: 0, borderRadius: 6, background: "transparent", color: BUI.textMuted, cursor: "pointer" }}>
          <X style={{ width: 13, height: 13 }} />
        </button>
      )}
      <button type="button" data-testid="ai-copy-link-action" disabled={actionOff} onClick={onGenerate}
        title={state === "generated" ? tr("studioBoard.card.linkCopy.regenerate") : undefined}
        style={{ flexShrink: 0, display: "inline-flex", alignItems: "center", gap: 4, padding: "5px 9px", borderRadius: 7, border: 0,
          ...actionColors, fontSize: 11, fontWeight: 750, whiteSpace: "nowrap", cursor: actionOff ? "default" : "pointer",
          opacity: (disabled || actionDisabled) && state !== "busy" ? 0.55 : 1, fontFamily: "inherit" }}>
        {action}
      </button>
    </div>
  );
}
