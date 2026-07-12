"use client";

import { useLocale } from "@/lib/i18n/LocaleProvider";

// CSS tokens match DraftDetailsDrawer so the extracted section looks identical.
const UI = {
  surface3: "var(--app-surface-3, #0F1524)",
  fieldBorder: "var(--app-border-hi, rgba(255,255,255,0.18))",
  text: "var(--app-text, #E2E8F0)",
  textMuted: "var(--app-text-muted, #5B6577)",
};

const field: React.CSSProperties = {
  width: "100%", boxSizing: "border-box", padding: "11px 13px", borderRadius: 10,
  border: `1px solid ${UI.fieldBorder}`, fontSize: 13.5, color: UI.text, background: UI.surface3,
  outline: "none", lineHeight: 1.5,
};
const lbl: React.CSSProperties = { fontSize: 12.5, fontWeight: 800, color: UI.text };
const num: React.CSSProperties = { color: UI.textMuted, fontWeight: 800, marginRight: 2 };

export type PinTitleSectionProps = {
  /** Current title value. Parent owns this state. */
  value: string;
  /** Called with the new value on every keystroke. Parent updates state and marks dirty. */
  onChange: (value: string) => void;
};

/**
 * Controlled title field for PinDetailsModal.
 * Presentational only — no API calls, no store writes.
 */
export function PinTitleSection({ value, onChange }: PinTitleSectionProps) {
  const { t } = useLocale();
  return (
    <>
      <div style={{ marginBottom: 7 }}>
        <span style={lbl}><span style={num}>1.</span>{t("pinDetails.title.label")}</span>
      </div>
      <input
        data-testid="draft-edit-title"
        value={value}
        maxLength={100}
        onChange={e => onChange(e.target.value)}
        style={field}
        placeholder={t("pinDetails.title.placeholder")}
      />
      <div style={{ textAlign: "right", fontSize: 10, color: UI.textMuted, marginTop: 4 }}>
        {value.length}/100
      </div>
    </>
  );
}
