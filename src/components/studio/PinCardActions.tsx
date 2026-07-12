"use client";

import { useEffect, useState } from "react";
import { MoreVertical } from "lucide-react";

// Normalized Create Pins card status. This is the ONLY thing that decides which
// buttons (and labels) a card shows — there is no "ready" / "needs details" /
// "not planned" state. A generated-but-unscheduled Pin is "unscheduled". Missing
// fields (URL / board / product / details) are resolved inside the shared
// edit/schedule modal, never as a separate card status.
export type PinCardStatus = "generating" | "failed" | "unscheduled" | "scheduled" | "posted";

export type PinCardActionsProps = {
  status: PinCardStatus;
  /** Opens the shared single-pin edit/schedule modal (Schedule / Edit / Details). */
  onOpenModal:     (e: React.MouseEvent) => void;
  /** Navigates to the Weekly Plan (Scheduled secondary). */
  onViewPlan:      (e: React.MouseEvent) => void;
  /** Opens the published Pin (Posted primary). */
  onViewPin:       (e: React.MouseEvent) => void;
  /** Retries a failed generation (Failed primary). */
  onTryAgain:      (e: React.MouseEvent) => void;
  /** Edits the generation prompt/inputs (Failed secondary). */
  onEditPrompt:    (e: React.MouseEvent) => void;
  /** Regenerates the Pin (More menu). */
  onRegenerate:    (e: React.MouseEvent) => void;
  /** Saves the image as a reusable reference (More menu). */
  onSaveReference: (e: React.MouseEvent) => void;
  downloadHref:    string;
  downloadName:    string;
};

const C = {
  text:     "var(--app-text, #E2E8F0)",
  textSec:  "var(--app-text-sec, #8892A4)",
  cardElev: "var(--app-surface-3, #1A2236)",
  border:   "var(--app-border, rgba(255,255,255,0.07))",
  borderStr:"var(--app-border-hi, rgba(255,255,255,0.12))",
} as const;

// Consistent ~36px controls. Primary on the left, secondary next, More far right.
const ACTION_H = 36;
const actionBase: React.CSSProperties = {
  height: ACTION_H, padding: "0 14px", borderRadius: 8, fontSize: "11.5px", fontWeight: 800,
  cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 5,
  whiteSpace: "nowrap", backdropFilter: "blur(8px)", fontFamily: "inherit",
};
const primaryBtn: React.CSSProperties = {
  ...actionBase,
  border: "1px solid rgba(124,58,237,0.6)", background: "rgba(124,58,237,0.94)", color: "#fff",
};
const secondaryBtn: React.CSSProperties = {
  ...actionBase, fontWeight: 700,
  border: "1px solid rgba(255,255,255,0.18)", background: "rgba(8,13,25,0.82)", color: "#E2E8F0",
};
// ≥36×36 hit area so the three-dot menu is reliably clickable.
const moreBtn: React.CSSProperties = {
  ...secondaryBtn, width: ACTION_H, height: ACTION_H, padding: 0, justifyContent: "center", flexShrink: 0,
};
const menuItem: React.CSSProperties = {
  display: "block", width: "100%", padding: "9px 12px", border: "none", background: "none",
  textAlign: "left", fontSize: "11.5px", fontWeight: 600, color: C.textSec, cursor: "pointer",
  textDecoration: "none", fontFamily: "inherit",
};

type ActionKey = "openModal" | "viewPlan" | "viewPin" | "tryAgain" | "editPrompt";
type MoreKey = "regenerate" | "download" | "saveReference";

type Btn = { label: string; key: ActionKey; testId: string };
type Matrix = { primary: Btn | { label: string; disabled: true; testId: string }; secondary?: Btn; more: MoreKey[] };

// Single source of truth for labels + which action each button runs, keyed only by
// the normalized status. Individual cards never hardcode labels.
const MATRIX: Record<PinCardStatus, Matrix> = {
  unscheduled: {
    primary:   { label: "Schedule", key: "openModal", testId: "pin-card-add-to-plan" },
    secondary: { label: "Details",  key: "openModal", testId: "pin-card-view-btn" },
    more: ["regenerate", "download", "saveReference"],
  },
  scheduled: {
    primary:   { label: "Edit",      key: "openModal", testId: "pin-card-view-btn" },
    secondary: { label: "View Plan", key: "viewPlan",  testId: "pin-card-view-in-plan" },
    more: ["regenerate", "download", "saveReference"],
  },
  failed: {
    primary:   { label: "Try again",   key: "tryAgain",   testId: "retry-failed-output" },
    secondary: { label: "Edit prompt", key: "editPrompt", testId: "edit-failed-inputs" },
    more: ["regenerate"],
  },
  posted: {
    primary:   { label: "View Pin", key: "viewPin",   testId: "pin-card-view-pin" },
    secondary: { label: "Details",  key: "openModal", testId: "pin-card-view-btn" },
    more: ["download", "saveReference"],
  },
  generating: {
    primary: { label: "Generating…", disabled: true, testId: "pin-card-generating" },
    more: [],
  },
};

export function PinCardActions(props: PinCardActionsProps) {
  const { status } = props;
  const [moreOpen, setMoreOpen] = useState(false);

  useEffect(() => {
    if (!moreOpen) return;
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") { e.stopPropagation(); setMoreOpen(false); } }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [moreOpen]);

  const m = MATRIX[status];

  function run(key: ActionKey, e: React.MouseEvent) {
    e.stopPropagation();
    switch (key) {
      case "openModal":  return props.onOpenModal(e);
      case "viewPlan":   return props.onViewPlan(e);
      case "viewPin":    return props.onViewPin(e);
      case "tryAgain":   return props.onTryAgain(e);
      case "editPrompt": return props.onEditPrompt(e);
    }
  }

  const primaryDisabled = "disabled" in m.primary && m.primary.disabled;

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      {primaryDisabled ? (
        <button type="button" data-testid={m.primary.testId} disabled
          style={{ ...primaryBtn, opacity: 0.65, cursor: "default" }}
          onClick={e => e.stopPropagation()}>
          {m.primary.label}
        </button>
      ) : (
        <button type="button" data-testid={m.primary.testId} style={primaryBtn}
          onClick={e => run((m.primary as Btn).key, e)}>
          {m.primary.label}
        </button>
      )}

      {m.secondary && (
        <button type="button" data-testid={m.secondary.testId} style={secondaryBtn}
          onClick={e => run(m.secondary!.key, e)}>
          {m.secondary.label}
        </button>
      )}

      {m.more.length > 0 && (
        // Pinned far right, above the gradient overlay. Click never bubbles to the card.
        <div style={{ position: "relative", marginLeft: "auto", zIndex: 5 }}>
          <button type="button" title="More" aria-label="More actions" data-testid="pin-card-more"
            onClick={e => { e.stopPropagation(); setMoreOpen(v => !v); }} style={moreBtn}>
            <MoreVertical style={{ width: 16, height: 16 }} />
          </button>
          {moreOpen && (
            <>
              <div style={{ position: "fixed", inset: 0, zIndex: 30 }} onClick={e => { e.stopPropagation(); setMoreOpen(false); }} />
              <div onClick={e => e.stopPropagation()} style={{
                position: "absolute", right: 0, bottom: "calc(100% + 4px)", zIndex: 31,
                minWidth: 172, background: C.cardElev, border: `1px solid ${C.borderStr}`,
                borderRadius: 8, boxShadow: "0 8px 24px rgba(0,0,0,0.35)", overflow: "hidden",
              }}>
                <p style={{ margin: 0, padding: "7px 12px 4px", fontSize: "9px", fontWeight: 600, color: C.textSec, borderBottom: `1px solid ${C.border}` }}>
                  More actions
                </p>
                {m.more.includes("regenerate") && (
                  <button type="button" data-testid="pin-card-regenerate-btn" style={menuItem}
                    onClick={e => { e.stopPropagation(); setMoreOpen(false); props.onRegenerate(e); }}>
                    Regenerate
                  </button>
                )}
                {m.more.includes("download") && (
                  <a href={props.downloadHref} download={props.downloadName} data-testid="pin-card-download" style={menuItem}
                    onClick={e => { e.stopPropagation(); setMoreOpen(false); }}>
                    Download
                  </a>
                )}
                {m.more.includes("saveReference") && (
                  <button type="button" data-testid="pin-card-save-reference" style={menuItem}
                    onClick={e => { e.stopPropagation(); setMoreOpen(false); props.onSaveReference(e); }}>
                    Save as Reference
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
