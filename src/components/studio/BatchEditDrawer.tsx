"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { toProxyUrl } from "@/lib/imageProxy";
import type { PinMetadataDraft } from "@/lib/pinMetadata";

const UI = {
  card: "#161D2E",
  cardElev: "#1A2236",
  border: "rgba(255,255,255,0.09)",
  borderStr: "rgba(255,255,255,0.12)",
  text: "#E2E8F0",
  textSec: "#8892A4",
  textMuted: "#64748B",
  purple: "#7C3AED",
  gradient: "linear-gradient(135deg,#FF4D8D 0%,#D946EF 52%,#7C3AED 100%)",
};

export type BatchPinRow = {
  pinId: string;
  sessionId: string;
  groupIdx: number;
  pinIdx: number;
  imageUrl: string;
  title: string;
  description: string;
  destinationUrl: string;
  plannedDate: string;
  planningStatus: string;
  metadataDraft?: PinMetadataDraft;
};

export type BatchEditDrawerProps = {
  open: boolean;
  pins: BatchPinRow[];
  onClose: () => void;
  onApply: (opts: {
    sharedDestinationUrl: string;
    sharedPlannedDate: string;
    titlePattern: string;
    descriptionStyle: string;
    applyDestinationToAll: boolean;
    autoAssignDates: boolean;
    uniqueTitles: boolean;
    uniqueDescriptions: boolean;
    uniqueAltText: boolean;
    overwriteEdited: boolean;
  }) => void;
  onGenerateMetadata: (overwriteEdited: boolean) => void;
};

export function BatchEditDrawer({ open, pins, onClose, onApply, onGenerateMetadata }: BatchEditDrawerProps) {
  const [sharedDestinationUrl, setSharedDestinationUrl] = useState("");
  const [sharedPlannedDate, setSharedPlannedDate] = useState("");
  const [titlePattern, setTitlePattern] = useState("unique");
  const [descriptionStyle, setDescriptionStyle] = useState("unique");
  const [applyDestinationToAll, setApplyDestinationToAll] = useState(true);
  const [autoAssignDates, setAutoAssignDates] = useState(true);
  const [uniqueTitles, setUniqueTitles] = useState(true);
  const [uniqueDescriptions, setUniqueDescriptions] = useState(true);
  const [uniqueAltText, setUniqueAltText] = useState(true);
  const [overwriteEdited, setOverwriteEdited] = useState(false);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const fieldStyle: React.CSSProperties = {
    width: "100%", boxSizing: "border-box", padding: "8px 10px", borderRadius: 8,
    border: `1px solid ${UI.border}`, fontSize: 11, color: UI.text, background: UI.cardElev, outline: "none",
  };

  return (
    <>
      <div data-testid="batch-edit-backdrop" onClick={onClose} style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.38)", zIndex: 47 }} />
      <aside
        data-testid="batch-edit-drawer"
        style={{
          position: "absolute", right: 0, top: 0, bottom: 0, zIndex: 48,
          width: "min(520px, 94%)", maxWidth: 520, minWidth: 420,
          background: UI.card, borderLeft: `1px solid ${UI.borderStr}`,
          boxShadow: "-12px 0 40px rgba(0,0,0,0.45)",
          display: "flex", flexDirection: "column", overflow: "hidden",
        }}
      >
        <header style={{ padding: "14px 16px", borderBottom: `1px solid ${UI.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 15, fontWeight: 800, color: UI.text }}>Batch Edit Details</h2>
            <p style={{ margin: "4px 0 0", fontSize: 11, color: UI.textSec }}>{pins.length} pins selected</p>
          </div>
          <button type="button" data-testid="batch-edit-close" onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: UI.textSec }}>
            <X style={{ width: 18, height: 18 }} />
          </button>
        </header>

        <div className="studio-scroll" style={{ flex: 1, overflowY: "auto", padding: "12px 16px 16px" }}>
          <p style={{ margin: "0 0 10px", fontSize: 10, fontWeight: 800, color: UI.textSec, textTransform: "uppercase" }}>Shared fields</p>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 14 }}>
            <label style={{ fontSize: 10, color: UI.textMuted }}>Destination URL</label>
            <input data-testid="batch-destination-url" value={sharedDestinationUrl} onChange={e => setSharedDestinationUrl(e.target.value)} placeholder="https://…" style={fieldStyle} />
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10, color: UI.textSec }}>
              <input type="checkbox" checked={applyDestinationToAll} onChange={e => setApplyDestinationToAll(e.target.checked)} />
              Apply same destination URL to all
            </label>
            <label style={{ fontSize: 10, color: UI.textMuted }}>Planned date</label>
            <input data-testid="batch-planned-date" type="date" value={sharedPlannedDate} onChange={e => setSharedPlannedDate(e.target.value)} style={fieldStyle} />
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10, color: UI.textSec }}>
              <input type="checkbox" checked={autoAssignDates} onChange={e => setAutoAssignDates(e.target.checked)} />
              Auto-assign planned dates
            </label>
            <label style={{ fontSize: 10, color: UI.textMuted }}>Title pattern</label>
            <select value={titlePattern} onChange={e => setTitlePattern(e.target.value)} style={fieldStyle}>
              <option value="unique">Generate unique titles for each</option>
              <option value="shared">Use shared pattern</option>
            </select>
            <label style={{ fontSize: 10, color: UI.textMuted }}>Description style</label>
            <select value={descriptionStyle} onChange={e => setDescriptionStyle(e.target.value)} style={fieldStyle}>
              <option value="unique">Generate unique descriptions for each</option>
              <option value="shared">Use shared style</option>
            </select>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10, color: UI.textSec }}>
              <input type="checkbox" checked={uniqueTitles} onChange={e => setUniqueTitles(e.target.checked)} />
              Generate unique titles for each
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10, color: UI.textSec }}>
              <input type="checkbox" checked={uniqueDescriptions} onChange={e => setUniqueDescriptions(e.target.checked)} />
              Generate unique descriptions for each
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10, color: UI.textSec }}>
              <input type="checkbox" checked={uniqueAltText} onChange={e => setUniqueAltText(e.target.checked)} />
              Generate unique alt text for each
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10, color: UI.textSec }}>
              <input type="checkbox" data-testid="batch-overwrite-edited" checked={overwriteEdited} onChange={e => setOverwriteEdited(e.target.checked)} />
              Overwrite edited fields
            </label>
          </div>

          <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
            <button type="button" data-testid="batch-generate-metadata" onClick={() => onGenerateMetadata(overwriteEdited)}
              style={{ padding: "8px 12px", borderRadius: 8, border: "none", background: UI.gradient, color: "#fff", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
              Generate Pin Details
            </button>
            <button type="button" data-testid="batch-apply" onClick={() => onApply({
              sharedDestinationUrl, sharedPlannedDate, titlePattern, descriptionStyle,
              applyDestinationToAll, autoAssignDates, uniqueTitles, uniqueDescriptions, uniqueAltText, overwriteEdited,
            })}
              style={{ padding: "8px 12px", borderRadius: 8, border: `1px solid ${UI.borderStr}`, background: UI.cardElev, color: UI.text, fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
              Apply to selected
            </button>
          </div>

          <p style={{ margin: "0 0 8px", fontSize: 10, fontWeight: 800, color: UI.textSec, textTransform: "uppercase" }}>Per-pin preview</p>
          <div data-testid="batch-pin-table" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {pins.map(p => (
              <div key={p.pinId} style={{ display: "flex", gap: 8, padding: 8, borderRadius: 8, border: `1px solid ${UI.border}`, background: UI.cardElev }}>
                <div style={{ width: 36, height: 54, borderRadius: 6, overflow: "hidden", flexShrink: 0 }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={toProxyUrl(p.imageUrl)} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{ margin: "0 0 2px", fontSize: 10, fontWeight: 700, color: UI.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.title || "—"}</p>
                  <p style={{ margin: "0 0 2px", fontSize: 9, color: UI.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.description || "—"}</p>
                  <p style={{ margin: 0, fontSize: 9, color: UI.textSec }}>{p.plannedDate || "No date"} · {p.planningStatus}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </aside>
    </>
  );
}
