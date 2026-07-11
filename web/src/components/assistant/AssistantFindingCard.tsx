"use client";
/**
 * AssistantFindingCard — one finding with its actions.
 *
 * Action semantics:
 *  - apply   → opens AssistantPreview; runs only after the user confirms.
 *  - review  → runs its handler (e.g. scroll/focus) and/or shows its explanation.
 *  - explain → toggles an inline plain-language explanation.
 *  - ignore  → dismisses the finding (also always available as a ghost button).
 */
import { useState } from "react";
import type { AssistantAction, AssistantFinding } from "@/lib/assistant/types";
import { AUI, severityColor } from "./theme";
import { AssistantPreview } from "./AssistantPreview";

export function AssistantFindingCard({
  finding,
  onDismiss,
  onClosePanel,
}: {
  finding: AssistantFinding;
  onDismiss: (id: string) => void;
  onClosePanel: () => void;
}) {
  const [explanation, setExplanation] = useState<string | null>(null);
  const [pending, setPending] = useState<AssistantAction | null>(null);

  const dot = severityColor(finding.severity);
  const hasIgnore = finding.actions.some((a) => a.kind === "ignore");

  async function handle(action: AssistantAction) {
    switch (action.kind) {
      case "apply":
        if (action.preview) { setPending(action); return; }
        await action.run?.();
        break;
      case "review":
        if (action.run) { await action.run(); onClosePanel(); }
        else if (action.explanation) setExplanation((v) => (v ? null : action.explanation!));
        break;
      case "explain":
        setExplanation((v) => (v ? null : action.explanation ?? finding.detail ?? finding.title));
        break;
      case "ignore":
        onDismiss(finding.id);
        break;
    }
  }

  return (
    <div style={{ background: AUI.bg2, border: `1px solid ${AUI.border}`, borderRadius: 12, padding: "11px 12px" }}>
      <div style={{ display: "flex", gap: 9 }}>
        <span style={{ width: 8, height: 8, borderRadius: "50%", background: dot, marginTop: 5, flexShrink: 0 }} aria-hidden />
        <div style={{ minWidth: 0, flex: 1 }}>
          <p style={{ margin: 0, fontSize: 13, fontWeight: 700, color: AUI.text, lineHeight: 1.35 }}>{finding.title}</p>
          {finding.detail && (
            <p style={{ margin: "3px 0 0", fontSize: 12, color: AUI.textSec, lineHeight: 1.4 }}>{finding.detail}</p>
          )}
        </div>
      </div>

      {explanation && (
        <p style={{ margin: "9px 0 0", padding: "8px 10px", fontSize: 12, color: AUI.text, background: AUI.cardElev, border: `1px solid ${AUI.border}`, borderRadius: 9, lineHeight: 1.45 }}>
          {explanation}
        </p>
      )}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10 }}>
        {finding.actions.map((a, i) => {
          const primary = a.kind === "apply";
          return (
            <button
              key={i}
              type="button"
              onClick={() => handle(a)}
              style={{
                padding: "5px 11px", borderRadius: 8, fontSize: 12, fontWeight: 650, cursor: "pointer",
                border: primary ? "none" : `1px solid ${AUI.border}`,
                background: primary ? AUI.gradient : "transparent",
                color: primary ? "#fff" : AUI.text,
              }}
            >
              {a.label}
            </button>
          );
        })}
        {/* Ignore only exists on real findings, not on revealed capability cards. */}
        {!hasIgnore && finding.proactive === true && (
          <button
            type="button"
            onClick={() => onDismiss(finding.id)}
            style={{ padding: "5px 11px", borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: "pointer", border: "none", background: "transparent", color: AUI.textMuted }}
          >
            Ignore
          </button>
        )}
      </div>

      {pending?.preview && (
        <AssistantPreview
          preview={pending.preview}
          onCancel={() => setPending(null)}
          onConfirm={async () => {
            const run = pending.run;
            setPending(null);
            await run?.();
          }}
        />
      )}
    </div>
  );
}
