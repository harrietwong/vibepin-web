"use client";

/**
 * ConfirmPublishDialog — shared confirmation before an immediate single-Pin publish.
 *
 * "Publish now" is irreversible (it posts to Pinterest immediately) and, when the Pin
 * is scheduled, it also drops the scheduled slot — so it must be confirmed. This is the
 * single-Pin equivalent of the Batch Edit drawer's own publish-confirm step (Batch keeps
 * its own dialog; do not route it through this one).
 *
 * Visual language matches the existing in-drawer confirm modals (e.g. the discard-changes
 * dialog in DraftDetailsDrawer) — dark surface, no visual redesign. Rendered as an overlay
 * positioned within the nearest positioned ancestor (the drawer), so it must sit inside a
 * `position: relative`/`absolute` container OR be given a fixed overlay by the parent.
 * Here it renders a full-viewport fixed overlay so it works from any surface.
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

export interface ConfirmPublishDialogProps {
  /** When false, nothing renders. */
  open: boolean;
  /** True when the Pin currently holds a scheduled time (adds the "time will be removed" line). */
  hasSchedule: boolean;
  /** Confirm handler — runs the real publish. */
  onConfirm: () => void;
  /** Cancel / dismiss. */
  onCancel: () => void;
  /** Disable the confirm button while a publish is already in flight. */
  busy?: boolean;
  /** Optional theme overrides so the dialog matches the host surface's tokens. */
  ui?: Partial<UI>;
}

export function ConfirmPublishDialog({
  open,
  hasSchedule,
  onConfirm,
  onCancel,
  busy = false,
  ui,
}: ConfirmPublishDialogProps) {
  if (!open) return null;
  const c = { ...DEFAULT_UI, ...ui };

  return (
    <div
      data-testid="confirm-publish-backdrop"
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
        data-testid="confirm-publish-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Publish this Pin now?"
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
          Publish this Pin now?
        </p>
        <p style={{ margin: "0 0 14px", fontSize: 12, color: c.textSec, lineHeight: 1.55 }}>
          This will publish the Pin to Pinterest immediately instead of at its scheduled time.
          {hasSchedule ? " The scheduled time will be removed." : ""}
        </p>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button
            type="button"
            data-testid="confirm-publish-cancel"
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
            Cancel
          </button>
          <button
            type="button"
            data-testid="confirm-publish-confirm"
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
            Publish now
          </button>
        </div>
      </div>
    </div>
  );
}
