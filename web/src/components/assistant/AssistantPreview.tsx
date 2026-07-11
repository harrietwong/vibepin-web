"use client";
/**
 * AssistantPreview — before→after confirmation shown before ANY apply mutates state.
 * Batch actions list every affected row. Nothing is applied until "Apply changes" is
 * pressed; "Cancel" discards. This is the single gate that enforces "no auto-apply".
 */
import { X, ArrowRight } from "lucide-react";
import type { AssistantPreview as PreviewData } from "@/lib/assistant/types";
import { AUI, Z } from "./theme";

export function AssistantPreview({
  preview,
  onConfirm,
  onCancel,
}: {
  preview: PreviewData;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={preview.title}
      onClick={onCancel}
      style={{
        position: "fixed", inset: 0, zIndex: Z.preview,
        display: "flex", alignItems: "center", justifyContent: "center",
        background: "rgba(0,0,0,0.6)", padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(480px, 100%)", maxHeight: "80vh", display: "flex", flexDirection: "column",
          background: AUI.card, border: `1px solid ${AUI.borderHi}`, borderRadius: 16,
          boxShadow: "0 24px 64px rgba(0,0,0,0.5)", overflow: "hidden",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 16px", borderBottom: `1px solid ${AUI.border}` }}>
          <div>
            <p style={{ margin: 0, fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: AUI.textMuted }}>Preview changes</p>
            <p style={{ margin: "2px 0 0", fontSize: 14, fontWeight: 700, color: AUI.text }}>{preview.title}</p>
          </div>
          <button type="button" onClick={onCancel} aria-label="Cancel" style={{ background: "none", border: "none", cursor: "pointer", color: AUI.textSec, padding: 4 }}>
            <X style={{ width: 18, height: 18 }} />
          </button>
        </div>

        <div style={{ overflowY: "auto", padding: "8px 16px", flex: 1 }}>
          {preview.changes.length === 0 && (
            <p style={{ fontSize: 13, color: AUI.textSec, padding: "12px 0" }}>No changes to apply.</p>
          )}
          {preview.changes.map((c, i) => (
            <div key={i} style={{ padding: "10px 0", borderBottom: i < preview.changes.length - 1 ? `1px solid ${AUI.border}` : "none" }}>
              <p style={{ margin: "0 0 6px", fontSize: 11, fontWeight: 700, color: AUI.textMuted }}>{c.label}</p>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ flex: 1, fontSize: 12, color: AUI.textSec, textDecoration: c.before ? "line-through" : "none", wordBreak: "break-word" }}>
                  {c.before || <em style={{ color: AUI.textMuted }}>empty</em>}
                </span>
                <ArrowRight style={{ width: 14, height: 14, color: AUI.textMuted, flexShrink: 0 }} />
                <span style={{ flex: 1, fontSize: 12, fontWeight: 600, color: AUI.text, wordBreak: "break-word" }}>
                  {c.after || <em style={{ color: AUI.textMuted }}>empty</em>}
                </span>
              </div>
            </div>
          ))}
          {preview.note && (
            <p style={{ margin: "12px 0 4px", fontSize: 12, color: AUI.textSec }}>{preview.note}</p>
          )}
        </div>

        <div style={{ display: "flex", gap: 8, padding: "12px 16px", borderTop: `1px solid ${AUI.border}` }}>
          <button
            type="button"
            onClick={onCancel}
            style={{ flex: 1, padding: "10px 12px", borderRadius: 10, border: `1px solid ${AUI.border}`, background: "transparent", color: AUI.text, fontSize: 13, fontWeight: 600, cursor: "pointer" }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={preview.changes.length === 0}
            style={{ flex: 1, padding: "10px 12px", borderRadius: 10, border: "none", background: AUI.gradient, color: "#fff", fontSize: 13, fontWeight: 700, cursor: preview.changes.length === 0 ? "not-allowed" : "pointer", opacity: preview.changes.length === 0 ? 0.5 : 1 }}
          >
            Apply changes
          </button>
        </div>
      </div>
    </div>
  );
}
