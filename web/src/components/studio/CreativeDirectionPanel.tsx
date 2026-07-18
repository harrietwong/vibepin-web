"use client";

import { ChevronDown, Sparkles, X } from "lucide-react";
import type {
  CreativeDirectionRecommendation,
  CreativeOpportunityContext,
  GuidedControls,
} from "@/lib/studio/creativeDirections";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import type { MessageKey } from "@/lib/i18n/messages/en";

const UI = {
  text: "var(--app-text, #E2E8F0)",
  muted: "var(--app-text-sec, #8892A4)",
  subtle: "var(--app-text-sec, #64748B)",
  card: "var(--app-surface, #161D2E)",
  elev: "var(--app-surface-3, #1A2236)",
  border: "var(--app-border, rgba(255,255,255,0.09))",
  purple: "#8B5CF6",
  purpleBg: "rgba(139,92,246,0.16)",
  warning: "#F59E0B",
} as const;

type Props = {
  recommendations: CreativeDirectionRecommendation[];
  selectedDirectionId: string | null;
  subjectOptions?: string[];
  guidedControls: GuidedControls;
  customInstructions: string;
  manualBrief: string;
  manualBriefEdited: boolean;
  briefStale: boolean;
  opportunityContext: CreativeOpportunityContext;
  onSelectDirection: (id: string) => void;
  onGuidedControlsChange: (patch: Partial<GuidedControls>) => void;
  onCustomInstructionsChange: (value: string) => void;
  onManualBriefChange: (value: string) => void;
  onUpdateDirection: () => void;
  onKeepEdits: () => void;
  onRemoveOpportunityContext: () => void;
};

// Guided-control option values are stored/sent as English strings (used to build
// the AI prompt downstream), so only the displayed <option> label is translated —
// the underlying `value` sent via onChange stays the original English string.
// Options without a mapped key (e.g. dynamic subjectOptions from the parent)
// fall back to rendering the raw value untranslated.
function FieldSelect({
  labelKey, value, options, optionLabelKeys, onChange,
}: {
  labelKey: MessageKey;
  value?: string;
  options: string[];
  optionLabelKeys?: Record<string, MessageKey>;
  onChange: (value: string) => void;
}) {
  const { t: tr } = useLocale();
  return (
    <label style={{ display: "grid", gap: 4 }}>
      <span style={{ fontSize: 9, color: UI.subtle, fontWeight: 800, textTransform: "uppercase" }}>{tr(labelKey)}</span>
      <select
        value={value ?? ""}
        onChange={e => onChange(e.target.value)}
        style={{
          width: "100%",
          border: `1px solid ${UI.border}`,
          borderRadius: 8,
          background: UI.card,
          color: UI.text,
          fontSize: 11,
          fontWeight: 700,
          padding: "7px 8px",
          outline: "none",
        }}
      >
        <option value="">{tr("studioCreative.direction.field.auto")}</option>
        {options.map(option => (
          <option key={option} value={option}>
            {optionLabelKeys?.[option] ? tr(optionLabelKeys[option]) : option}
          </option>
        ))}
      </select>
    </label>
  );
}

const GOAL_OPTIONS = ["Saves", "Clicks", "Product showcase", "Engagement", "Traffic"];
const GOAL_LABEL_KEYS: Record<string, MessageKey> = {
  "Saves": "studioCreative.direction.goal.saves",
  "Clicks": "studioCreative.direction.goal.clicks",
  "Product showcase": "studioCreative.direction.goal.productShowcase",
  "Engagement": "studioCreative.direction.goal.engagement",
  "Traffic": "studioCreative.direction.goal.traffic",
};

const SUBJECT_OPTIONS_DEFAULT = ["On-model", "Product only", "Flat lay", "Lifestyle scene"];
const SUBJECT_LABEL_KEYS: Record<string, MessageKey> = {
  "On-model": "studioCreative.direction.subject.onModel",
  "Product only": "studioCreative.direction.subject.productOnly",
  "Flat lay": "studioCreative.direction.subject.flatLay",
  "Lifestyle scene": "studioCreative.direction.subject.lifestyleScene",
};

const STRENGTH_OPTIONS = ["Subtle", "Balanced", "Strong"];
const STRENGTH_LABEL_KEYS: Record<string, MessageKey> = {
  "Subtle": "studioCreative.direction.strength.subtle",
  "Balanced": "studioCreative.direction.strength.balanced",
  "Strong": "studioCreative.direction.strength.strong",
};

const EMPHASIS_OPTIONS = ["Balanced", "Product first", "Aesthetic first"];
const EMPHASIS_LABEL_KEYS: Record<string, MessageKey> = {
  "Balanced": "studioCreative.direction.emphasis.balanced",
  "Product first": "studioCreative.direction.emphasis.productFirst",
  "Aesthetic first": "studioCreative.direction.emphasis.aestheticFirst",
};

const TEXT_OVERLAY_OPTIONS = ["None", "Light", "Headline", "Information-rich"];
const TEXT_OVERLAY_LABEL_KEYS: Record<string, MessageKey> = {
  "None": "studioCreative.direction.textOverlay.none",
  "Light": "studioCreative.direction.textOverlay.light",
  "Headline": "studioCreative.direction.textOverlay.headline",
  "Information-rich": "studioCreative.direction.textOverlay.informationRich",
};

export function CreativeDirectionPanel({
  recommendations,
  selectedDirectionId,
  subjectOptions,
  guidedControls,
  customInstructions,
  manualBrief,
  manualBriefEdited,
  briefStale,
  opportunityContext,
  onSelectDirection,
  onGuidedControlsChange,
  onCustomInstructionsChange,
  onManualBriefChange,
  onUpdateDirection,
  onKeepEdits,
  onRemoveOpportunityContext,
}: Props) {
  const { t: tr } = useLocale();
  const selected = recommendations.find(r => r.id === selectedDirectionId) ?? recommendations[0] ?? null;

  return (
    <section data-testid="creative-direction-panel" style={{ padding: "8px 12px", borderBottom: `1px solid ${UI.border}` }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <div>
          <p style={{ margin: 0, fontSize: 12, fontWeight: 800, color: UI.text }}>{tr("studioCreative.direction.title")}</p>
          <p style={{ margin: "2px 0 0", fontSize: 10, color: UI.muted }}>{tr("studioCreative.direction.subtitle")}</p>
        </div>
        <Sparkles style={{ width: 15, height: 15, color: UI.purple }} />
      </div>

      <div style={{ display: "grid", gap: 6 }}>
        {recommendations.slice(0, 3).map(rec => {
          const active = rec.id === selected?.id;
          return (
            <button
              key={rec.id}
              type="button"
              data-testid={`creative-direction-${rec.id}`}
              onClick={() => onSelectDirection(rec.id)}
              style={{
                border: `1px solid ${active ? UI.purple : UI.border}`,
                background: active ? UI.purpleBg : UI.elev,
                borderRadius: 9,
                padding: "7px 9px",
                textAlign: "left",
                cursor: "pointer",
                color: UI.text,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ flex: 1, fontSize: 11, fontWeight: 800 }}>{rec.title}</span>
                {rec.confidence && (
                  <span
                    data-testid={`creative-direction-confidence-${rec.id}`}
                    title={tr("studioCreative.direction.confidenceTitle")}
                    style={{
                      fontSize: 8, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.04em",
                      padding: "1px 5px", borderRadius: 999,
                      color: rec.confidence === "high" ? "#34D399" : rec.confidence === "medium" ? "#FCD34D" : UI.subtle,
                      background: rec.confidence === "high" ? "rgba(52,211,153,0.14)" : rec.confidence === "medium" ? "rgba(252,211,53,0.12)" : "rgba(148,163,184,0.12)",
                    }}
                  >
                    {rec.confidence}
                  </span>
                )}
              </div>
              {active && (
                <span style={{ display: "block", marginTop: 3, fontSize: 10, lineHeight: 1.45, color: UI.muted }}>
                  {rec.shortDescription ?? rec.summary}
                </span>
              )}
              {active && rec.whyThisDirection && (
                <span style={{ display: "block", marginTop: 4, fontSize: 9.5, lineHeight: 1.45, color: UI.subtle }}>
                  <b style={{ color: UI.muted }}>{tr("studioCreative.direction.whyLabel")}</b>{rec.whyThisDirection}
                </span>
              )}
              {active && rec.influencedBy && rec.influencedBy.length > 0 && (
                <span style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 5 }}>
                  <span style={{ fontSize: 8, color: UI.subtle, alignSelf: "center" }}>{tr("studioCreative.direction.influencedByLabel")}</span>
                  {rec.influencedBy.map(tag => (
                    <span key={tag} style={{
                      fontSize: 8, fontWeight: 700, padding: "1px 5px", borderRadius: 999,
                      color: "#C4B5FD", background: UI.purpleBg, textTransform: "capitalize",
                    }}>
                      {tag}
                    </span>
                  ))}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {opportunityContext.enabled && (opportunityContext.keyword || opportunityContext.title) && (
        <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 6, padding: "6px 8px", borderRadius: 9, background: UI.elev, border: `1px solid ${UI.border}` }}>
          <span style={{ flex: 1, minWidth: 0, fontSize: 10, color: UI.muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {tr("studioCreative.direction.contextLabel")}<b style={{ color: UI.text }}>{opportunityContext.keyword ?? opportunityContext.title}</b>
          </span>
          <button type="button" onClick={onRemoveOpportunityContext} aria-label={tr("studioCreative.direction.removeContextAria")}
            style={{ border: "none", background: "none", color: UI.subtle, cursor: "pointer", display: "flex", padding: 1 }}>
            <X style={{ width: 12, height: 12 }} />
          </button>
        </div>
      )}

      <details style={{ marginTop: 8 }}>
        <summary style={{ display: "flex", alignItems: "center", gap: 5, cursor: "pointer", color: UI.muted, fontSize: 10, fontWeight: 800 }}>
          <ChevronDown style={{ width: 12, height: 12 }} /> {tr("studioCreative.direction.fineTune")}
        </summary>
        <div style={{ marginTop: 8, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 7 }}>
          <FieldSelect labelKey="studioCreative.direction.field.goal" value={guidedControls.goal} options={GOAL_OPTIONS} optionLabelKeys={GOAL_LABEL_KEYS} onChange={v => onGuidedControlsChange({ goal: v })} />
          <FieldSelect labelKey="studioCreative.direction.field.subject" value={guidedControls.subject} options={subjectOptions ?? SUBJECT_OPTIONS_DEFAULT} optionLabelKeys={SUBJECT_LABEL_KEYS} onChange={v => onGuidedControlsChange({ subject: v })} />
          <FieldSelect labelKey="studioCreative.direction.field.referenceStrength" value={guidedControls.referenceStrength} options={STRENGTH_OPTIONS} optionLabelKeys={STRENGTH_LABEL_KEYS} onChange={v => onGuidedControlsChange({ referenceStrength: v })} />
          <FieldSelect labelKey="studioCreative.direction.field.productEmphasis" value={guidedControls.productEmphasis} options={EMPHASIS_OPTIONS} optionLabelKeys={EMPHASIS_LABEL_KEYS} onChange={v => onGuidedControlsChange({ productEmphasis: v })} />
          <FieldSelect labelKey="studioCreative.direction.field.textOverlay" value={guidedControls.textOverlay} options={TEXT_OVERLAY_OPTIONS} optionLabelKeys={TEXT_OVERLAY_LABEL_KEYS} onChange={v => onGuidedControlsChange({ textOverlay: v })} />
        </div>
      </details>

      <div style={{ marginTop: 10 }}>
        <p style={{ margin: "0 0 3px", fontSize: 10, fontWeight: 800, color: UI.text }}>{tr("studioCreative.direction.optionalRefinement")}</p>
        <p style={{ margin: "0 0 6px", fontSize: 9, color: UI.subtle, lineHeight: 1.4 }}>
          {tr("studioCreative.direction.optionalRefinementDesc")}
        </p>
      </div>

      <textarea
        data-testid="creative-custom-instructions"
        value={customInstructions}
        onChange={e => onCustomInstructionsChange(e.target.value.slice(0, 600))}
        placeholder={tr("studioCreative.direction.customInstructionsPlaceholder")}
        rows={2}
        style={{
          marginTop: 8,
          width: "100%",
          boxSizing: "border-box",
          border: `1px solid ${UI.border}`,
          borderRadius: 9,
          resize: "vertical",
          minHeight: 56,
          maxHeight: 120,
          padding: "8px 9px",
          background: UI.elev,
          color: UI.text,
          fontFamily: "inherit",
          fontSize: 11,
          lineHeight: 1.5,
          outline: "none",
        }}
      />

      <textarea
        data-testid="prompt-textarea"
        value={manualBrief}
        onChange={e => onManualBriefChange(e.target.value.slice(0, 1200))}
        placeholder={tr("studioCreative.direction.briefPlaceholder")}
        rows={3}
        style={{
          marginTop: 8,
          width: "100%",
          boxSizing: "border-box",
          border: `1px solid ${briefStale ? UI.warning : UI.border}`,
          borderRadius: 9,
          resize: "vertical",
          minHeight: 76,
          maxHeight: 180,
          padding: "8px 9px",
          background: UI.card,
          color: UI.text,
          fontFamily: "inherit",
          fontSize: 11,
          lineHeight: 1.55,
          outline: "none",
        }}
      />

      <div style={{ marginTop: 5, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        {briefStale ? (
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontSize: 10, color: UI.warning }}>{tr("studioCreative.direction.inputsChanged")}</span>
            <button type="button" onClick={onUpdateDirection} style={{ border: "none", background: "none", color: "#C4B5FD", fontSize: 10, fontWeight: 800, cursor: "pointer", padding: 0 }}>{tr("studioCreative.direction.updateDirection")}</button>
            <button type="button" onClick={onKeepEdits} style={{ border: "none", background: "none", color: UI.muted, fontSize: 10, fontWeight: 800, cursor: "pointer", padding: 0 }}>{tr("studioCreative.direction.keepMyEdits")}</button>
          </div>
        ) : (
          <span style={{ fontSize: 10, color: UI.subtle }}>{manualBriefEdited ? tr("studioCreative.direction.manualBrief") : tr("studioCreative.direction.generatedFromDirection")}</span>
        )}
        <span style={{ fontSize: 10, color: UI.subtle }}>{manualBrief.length} / 1200</span>
      </div>
    </section>
  );
}
