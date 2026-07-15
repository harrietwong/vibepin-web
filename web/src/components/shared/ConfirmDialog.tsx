"use client";

/**
 * ConfirmDialog — small, generic confirm/cancel modal.
 *
 * Same visual language as ConfirmPublishDialog / the in-drawer discard-changes
 * dialog (dark surface, centered, no visual redesign) but content-agnostic: the
 * caller supplies title, body, and both button labels. Use this instead of
 * window.confirm() for any in-app confirmation that needs to match the product's
 * own UI (window.confirm renders a native browser dialog that breaks the visual
 * language and cannot be styled or tested via data-testid).
 */

type UI = {
  card: string;
  border: string;
  text: string;
  textSec: string;
};

const DEFAULT_UI: UI = {
  card: "var(--app-surface, #0b1220)",
  border: "var(--app-border, rgba(148,163,184,0.25))",
  text: "var(--app-text, #E2E8F0)",
  textSec: "var(--app-text-sec, #94A3B8)",
};

export interface ConfirmDialogProps {
  /** When false, nothing renders. */
  open: boolean;
  title: string;
  body: string;
  /** Defaults to "Cancel". */
  cancelLabel?: string;
  /** Defaults to "Confirm". */
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
  ui?: Partial<UI>;
  /** Distinguishes dialogs in tests (e.g. "use-product-link"). */
  testId?: string;
}

export function ConfirmDialog({
  open,
  title,
  body,
  cancelLabel = "Cancel",
  confirmLabel = "Confirm",
  onConfirm,
  onCancel,
  busy = false,
  ui,
  testId = "confirm-dialog",
}: ConfirmDialogProps) {
  if (!open) return null;
  const c = { ...DEFAULT_UI, ...ui };

  return (
    <div
      data-testid={`${testId}-backdrop`}
      onClick={onCancel}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 200,
        background: "rgba(0,0,0,0.6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
      }}
    >
      <div
        data-testid={testId}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(380px, 92%)",
          background: c.card,
          border: `1px solid ${c.border}`,
          borderRadius: 14,
          padding: 18,
          boxShadow: "0 24px 70px rgba(0,0,0,0.5)",
        }}
      >
        <p style={{ margin: "0 0 6px", fontSize: 14, fontWeight: 800, color: c.text }}>
          {title}
        </p>
        <p style={{ margin: "0 0 14px", fontSize: 12, color: c.textSec, lineHeight: 1.55 }}>
          {body}
        </p>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button
            type="button"
            data-testid={`${testId}-cancel`}
            onClick={onCancel}
            style={{
              padding: "8px 14px",
              borderRadius: 8,
              border: `1px solid ${c.border}`,
              background: "transparent",
              color: c.text,
              fontSize: 11.5,
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            data-testid={`${testId}-confirm`}
            onClick={onConfirm}
            disabled={busy}
            style={{
              padding: "8px 14px",
              borderRadius: 8,
              border: "none",
              background: "#7C3AED",
              color: "#fff",
              fontSize: 11.5,
              fontWeight: 800,
              cursor: busy ? "not-allowed" : "pointer",
              opacity: busy ? 0.6 : 1,
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
