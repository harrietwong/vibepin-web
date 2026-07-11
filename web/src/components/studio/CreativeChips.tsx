"use client";

/**
 * Create Pins creative controls, simplified for normal users.
 *
 * Primary control = "Creative direction": a concise, human-readable summary that
 * is auto-generated from the selected products + reference. It never looks
 * required — users can generate without touching it. "Edit direction" reveals the
 * editable brief; "Regenerate direction" rebuilds it from the detected tags.
 *
 * The Style / Scene / Composition / Mood tag chips still exist and still drive the
 * prompt manifest, but they are tucked inside a collapsed "Advanced controls"
 * section labelled "Automatically detected" so users don't feel they must
 * hand-pick every chip. No internal reasoning, confidence, or hidden prompts here.
 */

import { useState } from "react";
import { Info, ChevronDown, Pencil, RotateCw } from "lucide-react";
import { TAG_GROUP_LABEL, type CreativeTag, type TagGroup } from "@/lib/studio/creativeControls";

const UI = {
  text: "var(--app-text, #E2E8F0)",
  subtle: "var(--app-text-sec, #64748B)",
  muted: "var(--app-text-sec, #8892A4)",
  elev: "var(--app-surface-3, #1A2236)",
  card: "var(--app-surface, #161D2E)",
  border: "var(--app-border, rgba(255,255,255,0.09))",
  purple: "#8B5CF6",
  purpleBg: "rgba(139,92,246,0.18)",
};

const TOOLTIP_TEXT =
  "Product images define the items to include. References guide the style and composition. " +
  "All outputs use the same creative direction, while the results setting controls how different each output should be.";

export function CreativeChips({
  tags,
  selectedTagIds,
  briefValue,
  briefStale,
  onToggleTag,
  onBriefChange,
  onUpdateBriefFromTags,
}: {
  tags: CreativeTag[];
  selectedTagIds: string[];
  briefValue: string;
  briefStale?: boolean;
  onToggleTag: (id: string) => void;
  onBriefChange: (value: string) => void;
  onUpdateBriefFromTags?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [tipOpen, setTipOpen] = useState(false);

  if (tags.length === 0) return null;

  const selected = new Set(selectedTagIds);
  const groupOrder: TagGroup[] = ["format", "scene", "composition", "mood"];
  const byGroup = groupOrder
    .map(group => ({ group, tags: tags.filter(tag => tag.group === group) }))
    .filter(item => item.tags.length > 0);

  const summary = briefValue.trim();

  return (
    <section data-testid="creative-chips" style={{ padding: "12px 12px", borderBottom: `1px solid ${UI.border}`, display: "flex", flexDirection: "column", gap: 14 }}>
      {/* ── Creative direction (primary) ─────────────────────────────────────── */}
      <div data-testid="creative-direction-section">
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
          <span style={{ fontSize: 12, fontWeight: 800, color: UI.text }}>Creative direction</span>
          <div style={{ position: "relative", display: "flex" }}>
            <button
              type="button"
              data-testid="creative-direction-info"
              aria-label="How images are used"
              onMouseEnter={() => setTipOpen(true)}
              onMouseLeave={() => setTipOpen(false)}
              onFocus={() => setTipOpen(true)}
              onBlur={() => setTipOpen(false)}
              onClick={() => setTipOpen(v => !v)}
              style={{ display: "flex", border: "none", background: "none", padding: 0, cursor: "pointer", color: UI.muted }}
            >
              <Info style={{ width: 13, height: 13 }} />
            </button>
            {tipOpen && (
              <div
                role="tooltip"
                style={{
                  position: "absolute", top: "calc(100% + 6px)", left: -8, zIndex: 50, width: 248,
                  padding: "8px 10px", borderRadius: 8, background: UI.card,
                  border: `1px solid ${UI.border}`, boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
                  fontSize: 11, lineHeight: 1.5, color: UI.muted, fontWeight: 500,
                }}
              >
                {TOOLTIP_TEXT}
              </div>
            )}
          </div>
        </div>

        {editing ? (
          <textarea
            id="direction-brief"
            data-testid="direction-brief-input"
            value={briefValue}
            onChange={e => onBriefChange(e.target.value.slice(0, 800))}
            placeholder="e.g. outdoor street-style outfit, natural movement, no studio background"
            rows={3}
            autoFocus
            style={{
              width: "100%", boxSizing: "border-box", border: `1px solid ${UI.border}`,
              borderRadius: 9, resize: "vertical", minHeight: 70, maxHeight: 180,
              padding: "8px 9px", background: UI.elev, color: UI.text,
              fontFamily: "inherit", fontSize: 12, lineHeight: 1.5, outline: "none",
            }}
          />
        ) : (
          <p data-testid="creative-direction-summary" style={{ margin: 0, fontSize: 12.5, lineHeight: 1.55, color: UI.text, fontWeight: 500 }}>
            {summary || "A creative direction will be generated from your products and reference."}
          </p>
        )}

        <p style={{ margin: "6px 0 0", fontSize: 10.5, color: UI.subtle }}>
          {briefStale
            ? "Your tags changed — regenerate to refresh this direction."
            : "Automatically created from your products and reference."}
        </p>

        <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
          <button
            type="button"
            data-testid="edit-direction-btn"
            onClick={() => setEditing(v => !v)}
            style={{
              display: "flex", alignItems: "center", gap: 4, padding: "4px 10px", borderRadius: 999,
              border: `1px solid ${editing ? UI.purple : UI.border}`, background: editing ? UI.purpleBg : UI.elev,
              color: editing ? "#DDD6FE" : UI.text, fontSize: 10.5, fontWeight: 700, cursor: "pointer",
            }}
          >
            <Pencil style={{ width: 11, height: 11 }} /> {editing ? "Done" : "Edit direction"}
          </button>
          {onUpdateBriefFromTags && (
            <button
              type="button"
              data-testid="regenerate-direction-btn"
              onClick={() => { onUpdateBriefFromTags(); setEditing(false); }}
              style={{
                display: "flex", alignItems: "center", gap: 4, padding: "4px 10px", borderRadius: 999,
                border: `1px solid ${briefStale ? UI.purple : UI.border}`,
                background: briefStale ? UI.purpleBg : UI.elev,
                color: briefStale ? "#DDD6FE" : UI.text, fontSize: 10.5, fontWeight: 700, cursor: "pointer",
              }}
            >
              <RotateCw style={{ width: 11, height: 11 }} /> Regenerate direction
            </button>
          )}
        </div>
      </div>

      {/* ── Advanced controls (collapsed by default) ─────────────────────────── */}
      <div data-testid="advanced-controls">
        <button
          type="button"
          data-testid="advanced-controls-toggle"
          aria-expanded={advancedOpen}
          onClick={() => setAdvancedOpen(v => !v)}
          style={{
            display: "flex", alignItems: "center", gap: 6, width: "100%", textAlign: "left",
            border: "none", background: "none", padding: 0, cursor: "pointer",
          }}
        >
          <ChevronDown
            style={{ width: 13, height: 13, color: UI.muted, transform: advancedOpen ? "rotate(0deg)" : "rotate(-90deg)", transition: "transform 0.12s" }}
          />
          <span style={{ fontSize: 12, fontWeight: 800, color: UI.text }}>Advanced controls</span>
        </button>
        <p style={{ margin: "3px 0 0 19px", fontSize: 10.5, color: UI.subtle }}>
          Fine-tune style, scene, composition, and mood.
        </p>

        {advancedOpen && (
          <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: UI.muted, letterSpacing: "0.03em", textTransform: "uppercase" }}>
              Automatically detected
            </div>
            {byGroup.map(({ group, tags: groupTags }) => (
              <div key={group} data-testid={`creative-chip-group-${group}`}>
                <div style={{ marginBottom: 5, fontSize: 10, fontWeight: 800, color: UI.muted, letterSpacing: "0.03em", textTransform: "uppercase" }}>
                  {TAG_GROUP_LABEL[group]}
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {groupTags.map(tag => {
                    const active = selected.has(tag.id);
                    return (
                      <button
                        key={tag.id}
                        type="button"
                        data-testid={`creative-chip-${tag.id}`}
                        data-active={active}
                        data-group={tag.group}
                        onClick={() => onToggleTag(tag.id)}
                        style={{
                          padding: "6px 10px", borderRadius: 999,
                          border: `1px solid ${active ? UI.purple : UI.border}`,
                          background: active ? UI.purpleBg : UI.elev,
                          color: active ? "#DDD6FE" : UI.text,
                          fontSize: 11, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap",
                        }}
                      >
                        {tag.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
