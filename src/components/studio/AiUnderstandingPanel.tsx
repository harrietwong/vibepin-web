"use client";

import { Brain, Package, ImageIcon, Sparkles } from "lucide-react";
import type { ProductSetAnalysis } from "@/lib/studio/productAnalysis";
import { referenceTypeLabel, type ReferenceContext } from "@/lib/studio/referenceAnalysis";
import type { CreativeIntent } from "@/lib/studio/creativeIntent";

const UI = {
  text: "var(--app-text, #E2E8F0)",
  muted: "var(--app-text-sec, #8892A4)",
  subtle: "var(--app-text-sec, #64748B)",
  card: "var(--app-surface, #161D2E)",
  elev: "var(--app-surface-3, #1A2236)",
  border: "var(--app-border, rgba(255,255,255,0.09))",
  purple: "#8B5CF6",
  purpleBg: "rgba(139,92,246,0.16)",
} as const;

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 7px", borderRadius: 999, background: UI.purpleBg, color: "#C4B5FD", textTransform: "capitalize" }}>
      {children}
    </span>
  );
}

export function AiUnderstandingPanel({
  productSet,
  references,
  intent,
}: {
  productSet: ProductSetAnalysis;
  references: ReferenceContext;
  intent: CreativeIntent;
}) {
  const hasAny = productSet.hasProducts || references.hasReferences;
  if (!hasAny) return null;

  const dom = references.dominant;

  return (
    <section
      data-testid="ai-understanding-panel"
      style={{ padding: "10px 12px", borderBottom: `1px solid ${UI.border}`, background: UI.card }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
        <Brain style={{ width: 14, height: 14, color: UI.purple }} />
        <p style={{ margin: 0, fontSize: 12, fontWeight: 800, color: UI.text }}>AI Understanding</p>
      </div>

      <div style={{ display: "grid", gap: 7 }}>
        {/* Products detected */}
        <div data-testid="ai-understanding-products" style={{ display: "flex", alignItems: "flex-start", gap: 7 }}>
          <Package style={{ width: 12, height: 12, color: UI.subtle, marginTop: 2, flexShrink: 0 }} />
          <div style={{ minWidth: 0 }}>
            <p style={{ margin: 0, fontSize: 10, color: UI.muted }}>
              {productSet.hasProducts ? `Products detected — ${productSet.setSummary}` : "No products selected"}
            </p>
            {productSet.hasProducts && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 4 }}>
                {productSet.products.slice(0, 5).map((p, i) => (
                  <Chip key={i}>{p.role.replace(/_/g, " ")}</Chip>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Reference detected */}
        <div data-testid="ai-understanding-reference" style={{ display: "flex", alignItems: "flex-start", gap: 7 }}>
          <ImageIcon style={{ width: 12, height: 12, color: UI.subtle, marginTop: 2, flexShrink: 0 }} />
          <div style={{ minWidth: 0 }}>
            <p style={{ margin: 0, fontSize: 10, color: UI.muted }}>
              {dom
                ? `Reference detected — ${referenceTypeLabel(dom.referenceType)}`
                : references.hasReferences ? "Reference detected" : "No reference selected"}
            </p>
            {dom && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 4 }}>
                {dom.mood !== "unknown" && <Chip>{dom.mood}</Chip>}
                {dom.sceneType !== "unknown" && <Chip>{dom.sceneType}</Chip>}
                {dom.containsPerson && <Chip>person</Chip>}
              </div>
            )}
          </div>
        </div>

        {/* We think you want */}
        <div
          data-testid="ai-understanding-intent"
          style={{ display: "flex", alignItems: "flex-start", gap: 7, padding: "7px 9px", borderRadius: 9, background: UI.elev, border: `1px solid ${UI.border}` }}
        >
          <Sparkles style={{ width: 12, height: 12, color: UI.purple, marginTop: 1, flexShrink: 0 }} />
          <div>
            <p style={{ margin: 0, fontSize: 9, color: UI.subtle, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.05em" }}>We think you want</p>
            <p style={{ margin: "2px 0 0", fontSize: 11, lineHeight: 1.5, color: UI.text }}>{intent.userVisibleSummary}</p>
          </div>
        </div>
      </div>
    </section>
  );
}
