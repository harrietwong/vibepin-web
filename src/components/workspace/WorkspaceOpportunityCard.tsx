"use client";

import { useState } from "react";
import {
  getPrimaryBadge,
  getTrendStateChip,
  PRIMARY_BADGE_META,
  TREND_CHIP_META,
  getScoreBreakdown,
  getWhyNow,
} from "@/lib/workspaceStatics";
import type { WorkspaceFeedItem, ShopSignal } from "@/app/api/workspace/feed/route";

// ── Formatters ────────────────────────────────────────────────────────────────

function fmtSaves(n: number): string {
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

// ── Simplified metric helpers ─────────────────────────────────────────────────

function searchInterestMeta(level: string | null): { text: string; color: string } {
  if (level === "very_high") return { text: "Very High", color: "#16A34A" };
  if (level === "high")      return { text: "High",      color: "#16A34A" };
  if (level === "medium")    return { text: "Medium",    color: "#D97706" };
  return                            { text: "Low",       color: "var(--app-text-muted)" };
}

function competitionMeta(pinCount: number): { text: string; color: string } {
  if (pinCount <= 20)  return { text: "Low",    color: "#16A34A" };
  if (pinCount <= 100) return { text: "Medium", color: "#D97706" };
  return                      { text: "High",   color: "#EF4444" };
}

function shopSignalMeta(signals: ShopSignal[], productCount: number): { text: string; color: string } {
  const count = signals.length || productCount;
  if (count === 0) return { text: "Exploring", color: "var(--app-text-muted)" };

  const domains = [...new Set(signals.slice(0, 3).map(s => s.domain).filter(Boolean))];
  const domainStr = domains.length ? ` · ${domains.join(", ")}` : "";
  const label = `${count} product${count > 1 ? "s" : ""}${domainStr}`;
  return count >= 5
    ? { text: label, color: "#16A34A" }
    : { text: label, color: "#D97706" };
}

// ── Sub-components ────────────────────────────────────────────────────────────

function EvidenceStrip({ pins }: { pins: WorkspaceFeedItem["pin_samples"] }) {
  if (!pins.length) return null;
  return (
    <div>
      <p style={{
        margin: "0 0 6px", fontSize: "9px", fontWeight: 700,
        color: "var(--app-text-muted)", textTransform: "uppercase", letterSpacing: "0.07em",
      }}>
        Viral Pins
      </p>
      <div style={{ display: "flex", gap: "5px" }}>
        {pins.slice(0, 3).map(p => (
          <div key={p.id} style={{ flex: 1, display: "flex", flexDirection: "column", gap: "3px" }}>
            <div style={{
              aspectRatio: "2/3", maxHeight: "68px", borderRadius: "4px",
              overflow: "hidden", background: "var(--app-surface-3)",
            }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={p.image_url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} loading="lazy" />
            </div>
            <span style={{
              fontSize: "9px", color: "var(--app-text-muted)",
              textAlign: "center", fontVariantNumeric: "tabular-nums",
            }}>
              {fmtSaves(p.save_count)} ♥
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ShopSignalsStrip({ signals }: { signals: ShopSignal[] }) {
  if (!signals.length) return null;
  return (
    <div>
      <p style={{
        margin: "0 0 6px", fontSize: "9px", fontWeight: 700,
        color: "var(--app-text-muted)", textTransform: "uppercase", letterSpacing: "0.07em",
      }}>
        Shop Signals
      </p>
      <div style={{ display: "flex", gap: "5px" }}>
        {signals.slice(0, 3).map(s => (
          <div key={s.id} style={{ flex: 1, display: "flex", flexDirection: "column", gap: "3px" }}>
            <div style={{
              aspectRatio: "1/1", maxHeight: "52px", borderRadius: "4px",
              overflow: "hidden", background: "var(--app-surface-3)",
              display: "flex", alignItems: "center", justifyContent: "center",
            }}>
              {s.image_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={s.image_url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} loading="lazy" />
              ) : (
                <span style={{ fontSize: "16px" }}>🛍</span>
              )}
            </div>
            <span style={{
              fontSize: "9px", color: "var(--app-text-muted)",
              textAlign: "center", overflow: "hidden",
              textOverflow: "ellipsis", whiteSpace: "nowrap",
            }}>
              {s.domain}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ScoreBar({ label, value, color, note }: {
  label: string; value: number; color: string; note?: string;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "7px" }}>
      <span style={{ width: "88px", fontSize: "10px", color: "var(--app-text-sec)", flexShrink: 0 }}>{label}</span>
      <div style={{ flex: 1, height: "3px", borderRadius: "2px", background: "var(--app-surface-3)" }}>
        <div style={{ width: `${value}%`, height: "100%", borderRadius: "2px", background: color }} />
      </div>
      <span style={{
        width: "24px", fontSize: "10px", color: "var(--app-text-muted)",
        textAlign: "right", fontVariantNumeric: "tabular-nums",
      }}>
        {value}
      </span>
      {note && (
        <span style={{ fontSize: "9px", color: "var(--app-text-muted)", flexShrink: 0 }}>{note}</span>
      )}
    </div>
  );
}

// ── Main card ─────────────────────────────────────────────────────────────────

type Props = {
  item:          WorkspaceFeedItem;
  isSelected:    boolean;
  canAdd:        boolean;
  isPro:         boolean;
  onAdd:         () => void;
  onRemove:      () => void;
  onCreatePins:  () => void;
};

export function WorkspaceOpportunityCard({
  item, isSelected, canAdd, isPro, onAdd, onRemove, onCreatePins,
}: Props) {
  const [showFactors, setShowFactors] = useState(false);

  const badge  = getPrimaryBadge(item);
  const chip   = getTrendStateChip(item);
  const bMeta  = PRIMARY_BADGE_META[badge];
  const cMeta  = TREND_CHIP_META[chip];
  const scores = getScoreBreakdown(item);
  const whyNow = getWhyNow(item);

  const siMeta   = searchInterestMeta(item.search_volume_level);
  const compMeta = competitionMeta(item.linked_pins_count);
  const shopMeta = shopSignalMeta(item.shop_signals, item.linked_products_count);

  return (
    <div style={{
      display: "flex", flexDirection: "column",
      borderRadius: "10px",
      border: `1px solid ${isSelected ? bMeta.color + "55" : "var(--app-border)"}`,
      background: isSelected ? bMeta.bg : "var(--app-surface)",
      overflow: "hidden",
    }}>
      {/* Top accent */}
      <div style={{ height: "2px", background: bMeta.color, flexShrink: 0 }} />

      <div style={{ padding: "12px 14px 14px", display: "flex", flexDirection: "column", gap: "11px" }}>

        {/* ── 1. Header: Primary badge + Trend chip + Keyword ───────────────── */}
        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "5px" }}>
            {/* Primary badge */}
            <span style={{
              padding: "2px 8px", borderRadius: "4px",
              fontSize: "9px", fontWeight: 700, letterSpacing: "0.06em",
              background: bMeta.bg, color: bMeta.color,
              border: `1px solid ${bMeta.color}33`, whiteSpace: "nowrap",
            }}>
              {bMeta.label}
            </span>
            {/* Trend state chip */}
            <span style={{
              padding: "2px 8px", borderRadius: "20px",
              fontSize: "9px", fontWeight: 600, letterSpacing: "0.04em",
              background: `${cMeta.color}12`, color: cMeta.color,
              border: `1px solid ${cMeta.color}2E`, whiteSpace: "nowrap",
            }}>
              {chip === "rising" ? "↑ " : chip === "seasonal" ? "◎ " : "∞ "}{cMeta.label}
            </span>
          </div>

          <h3 style={{
            margin: 0, fontSize: "14px", fontWeight: 800, color: "var(--app-text)",
            lineHeight: 1.25, textTransform: "capitalize",
          }}>
            {item.keyword}
          </h3>
        </div>

        {/* ── 2. Why Now ────────────────────────────────────────────────────── */}
        <div style={{
          padding: "7px 9px", borderRadius: "6px",
          background: `${bMeta.color}0D`, border: `1px solid ${bMeta.color}22`,
        }}>
          <p style={{ margin: 0, fontSize: "11px", color: "var(--app-text-sec)", lineHeight: 1.5 }}>
            {whyNow}
          </p>
        </div>

        {/* ── 3. Evidence Strip ─────────────────────────────────────────────── */}
        <EvidenceStrip pins={item.pin_samples} />

        {/* ── 3b. Shop Signals strip ────────────────────────────────────────── */}
        <ShopSignalsStrip signals={item.shop_signals} />

        {/* ── 4. Simplified metrics (3 text rows) ───────────────────────────── */}
        <div style={{
          padding: "8px 10px", borderRadius: "7px",
          background: "var(--app-surface-2)", border: "1px solid var(--app-border)",
          display: "flex", flexDirection: "column", gap: "5px",
        }}>
          {[
            { label: "Search Interest", ...siMeta },
            { label: "Competition",     ...compMeta },
            { label: "Shop Signals",    ...shopMeta },
          ].map(({ label, text, color }) => (
            <div key={label} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: "10px", color: "var(--app-text-muted)" }}>{label}</span>
              <span style={{ fontSize: "10px", fontWeight: 700, color }}>{text}</span>
            </div>
          ))}
        </div>

        {/* ── 5. Score factors (collapsed) ──────────────────────────────────── */}
        <div>
          <button
            type="button"
            onClick={() => setShowFactors(f => !f)}
            style={{
              display: "flex", alignItems: "center", gap: "4px",
              background: "none", border: "none", padding: 0,
              cursor: "pointer", width: "100%", textAlign: "left",
            }}
          >
            <span style={{
              fontSize: "9px", fontWeight: 700, color: "var(--app-text-muted)",
              textTransform: "uppercase", letterSpacing: "0.07em",
              transition: "color 0.15s",
            }}>
              {showFactors ? "▾" : "▸"} Score factors
            </span>
            {!isPro && (
              <span style={{ marginLeft: "auto", fontSize: "8px", color: "#F59E0B", fontWeight: 700 }}>
                ★ PRO
              </span>
            )}
          </button>

          {showFactors && (
            <div style={!isPro
              ? { marginTop: "8px", filter: "blur(3px)", pointerEvents: "none", userSelect: "none" }
              : { marginTop: "8px" }
            }>
              <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                <ScoreBar label="Search Interest" value={scores.demand}       color="#0891B2" />
                <ScoreBar label="Trend State"     value={scores.momentum}     color="#059669" />
                <ScoreBar label="Competition"     value={scores.saturation}   color="#EF4444" note="↑ high=crowded" />
                <ScoreBar label="Shop Signals"    value={scores.monetization} color="#F59E0B" />
              </div>
              {!isPro && (
                <p style={{ margin: "6px 0 0", fontSize: "9px", color: "var(--app-text-muted)", textAlign: "center" }}>
                  Upgrade to Pro to unlock score details
                </p>
              )}
            </div>
          )}
        </div>

        {/* ── CTA ──────────────────────────────────────────────────────────── */}
        <div style={{ display: "flex", flexDirection: "column", gap: "5px" }}>
          {/* Primary: Create Pins */}
          <button
            onClick={onCreatePins}
            style={{
              width: "100%", padding: "7px 0", fontSize: "11px", fontWeight: 700,
              borderRadius: "6px", border: "none",
              background: "linear-gradient(135deg, #FF4D8D 0%, #D946EF 52%, #7C3AED 100%)",
              color: "#fff", cursor: "pointer",
            }}
          >
            ✦ Create Pins
          </button>
          {/* Secondary: Add to Plan / Added */}
          {isSelected ? (
            <button
              onClick={onRemove}
              style={{
                width: "100%", padding: "6px 0", fontSize: "10px", fontWeight: 700,
                borderRadius: "6px", border: `1px solid ${bMeta.color}44`,
                background: bMeta.bg, color: bMeta.color, cursor: "pointer",
              }}
            >
              ✓ Added to Plan — Remove
            </button>
          ) : (
            <button
              onClick={onAdd}
              disabled={!canAdd}
              style={{
                width: "100%", padding: "6px 0", fontSize: "10px", fontWeight: 700,
                borderRadius: "6px", border: "1px solid var(--app-border)",
                background: "transparent",
                color: canAdd ? "var(--app-text-sec)" : "#CBD5E1",
                cursor: canAdd ? "pointer" : "not-allowed",
              }}
            >
              + Add to Plan
            </button>
          )}
        </div>

      </div>
    </div>
  );
}
