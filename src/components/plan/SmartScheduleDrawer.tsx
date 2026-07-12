"use client";

/**
 * Smart Schedule — centered modal dialog (NOT a right-side drawer). Smart Schedule is
 * a configuration task, so it opens as a focused centered modal that renders the shared
 * SmartScheduleConfigForm (same canonical config as Settings → Smart Schedule).
 */

import { useRef } from "react";
import { SmartScheduleConfigForm } from "./SmartScheduleConfigForm";

const C = {
  text: "var(--app-text)", sec: "var(--app-text-sec)", muted: "var(--app-text-muted)",
  border: "var(--app-border)", surface: "var(--app-surface)", surface2: "var(--app-surface-2)",
};

type Props = { open: boolean; onClose: () => void };

export function SmartScheduleModal({ open, onClose }: Props) {
  const saveRef = useRef<(() => void) | null>(null);
  if (!open) return null;
  return (
    <div
      data-testid="smart-schedule-modal"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(15,23,42,0.55)", backdropFilter: "blur(2px)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Smart Schedule"
        data-testid="smart-schedule-drawer"
        style={{ width: "min(800px, calc(100vw - 40px))", maxHeight: "85vh", display: "flex", flexDirection: "column", background: C.surface, border: `1px solid ${C.border}`, borderRadius: 18, boxShadow: "0 24px 64px rgba(0,0,0,0.5)", overflow: "hidden" }}
      >
        {/* Header */}
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, padding: "18px 22px 14px", borderBottom: `1px solid ${C.border}`, flexShrink: 0 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 16, fontWeight: 800, color: C.text }}>Smart Schedule</h2>
            <p style={{ margin: "4px 0 0", fontSize: 12, color: C.sec }}>
              Choose how often VibePin should publish, then preview reusable weekly time slots.
            </p>
          </div>
          <button type="button" data-testid="smart-schedule-close" onClick={onClose} aria-label="Close"
            style={{ background: "none", border: "none", color: C.muted, fontSize: 22, lineHeight: 1, cursor: "pointer", padding: 0 }}>✕</button>
        </div>

        {/* Body (scrolls). Extra bottom padding so the sticky footer never crowds the
            last section (Preferred time windows / generated slots). */}
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "18px 22px 32px" }}>
          <SmartScheduleConfigForm saveRef={saveRef} onSaved={onClose} />
        </div>

        {/* Footer */}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "14px 22px", borderTop: `1px solid ${C.border}`, flexShrink: 0 }}>
          <button type="button" onClick={onClose}
            style={{ padding: "9px 16px", borderRadius: 9, border: `1px solid ${C.border}`, background: C.surface2, color: C.sec, fontSize: 12.5, fontWeight: 600, cursor: "pointer" }}>
            Cancel
          </button>
          <button type="button" data-testid="smart-schedule-save" onClick={() => saveRef.current?.()}
            style={{ padding: "9px 18px", borderRadius: 9, border: "none", background: "linear-gradient(135deg,#FF4D8D,#7C3AED)", color: "#fff", fontSize: 12.5, fontWeight: 700, cursor: "pointer" }}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

/** Back-compat alias — Weekly Plan imports `SmartScheduleDrawer`; it is now a modal. */
export const SmartScheduleDrawer = SmartScheduleModal;
