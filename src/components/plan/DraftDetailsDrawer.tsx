"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import type { PinDraft } from "@/lib/pinDraftStore";
import * as pinDraftStore from "@/lib/pinDraftStore";
import { sanitizeHandoffField } from "@/lib/weeklyPlanHandoff";

const UI = {
  card: "var(--app-surface)",
  border: "var(--app-border)",
  text: "var(--app-text)",
  textSec: "var(--app-text-sec)",
  textMuted: "var(--app-text-muted)",
  purple: "#7C3AED",
  warning: "#D97706",
  gradient: "linear-gradient(135deg,#FF4D8D 0%,#D946EF 52%,#7C3AED 100%)",
};

export function DraftDetailsDrawer({
  draft, open, onClose, onSaved,
}: {
  draft: PinDraft | null;
  open: boolean;
  onClose: () => void;
  onSaved?: (updated: PinDraft) => void;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [altText, setAltText] = useState("");
  const [destinationUrl, setDestinationUrl] = useState("");
  const [plannedDate, setPlannedDate] = useState("");

  useEffect(() => {
    if (!open || !draft) return;
    setTitle(draft.title);
    setDescription(draft.description);
    setAltText(draft.altText);
    setDestinationUrl(draft.destinationUrl);
    setPlannedDate(draft.scheduledDate);
  }, [open, draft?.id, draft?.title, draft?.description, draft?.altText, draft?.destinationUrl, draft?.scheduledDate]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open || !draft) return null;
  const activeDraft = draft;

  const destMissing = !sanitizeHandoffField(destinationUrl);
  const fieldStyle: React.CSSProperties = {
    width: "100%", boxSizing: "border-box", padding: "8px 10px", borderRadius: 8,
    border: `1px solid ${UI.border}`, fontSize: 12, color: UI.text, background: "var(--app-surface-2)", outline: "none",
  };

  function handleSave() {
    const updated = pinDraftStore.updateDraft(activeDraft.id, {
      title: title.trim(),
      description: description.trim(),
      altText: altText.trim(),
      destinationUrl: destinationUrl.trim(),
      scheduledDate: plannedDate.trim(),
    });
    if (updated) onSaved?.(updated);
    onClose();
  }

  return (
    <>
      <div data-testid="draft-details-backdrop" onClick={onClose}
        style={{ position: "fixed", inset: 0, zIndex: 80, background: "rgba(0,0,0,0.38)" }} />
      <aside
        data-testid="draft-details-drawer"
        style={{
          position: "fixed", right: 0, top: 0, bottom: 0, zIndex: 81,
          width: "min(440px, 92vw)", background: UI.card,
          borderLeft: `1px solid ${UI.border}`, boxShadow: "-12px 0 40px rgba(0,0,0,0.2)",
          display: "flex", flexDirection: "column",
        }}
      >
        <header style={{ padding: "16px 18px", borderBottom: `1px solid ${UI.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2 style={{ margin: 0, fontSize: 15, fontWeight: 800, color: UI.text }}>Edit Pin Details</h2>
          <button type="button" data-testid="draft-details-close" onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: UI.textSec }}>
            <X size={18} />
          </button>
        </header>
        <div style={{ flex: 1, overflowY: "auto", padding: "14px 18px", display: "flex", flexDirection: "column", gap: 10 }}>
          <div>
            <label style={{ fontSize: 10, fontWeight: 700, color: UI.textSec }}>Title</label>
            <input data-testid="draft-edit-title" value={title} onChange={e => setTitle(e.target.value)} maxLength={100} style={fieldStyle} />
          </div>
          <div>
            <label style={{ fontSize: 10, fontWeight: 700, color: UI.textSec }}>Description</label>
            <textarea data-testid="draft-edit-description" value={description} onChange={e => setDescription(e.target.value)} rows={4} maxLength={800} style={{ ...fieldStyle, resize: "vertical" }} />
          </div>
          <div>
            <label style={{ fontSize: 10, fontWeight: 700, color: UI.textSec }}>Alt text</label>
            <input data-testid="draft-edit-alt-text" value={altText} onChange={e => setAltText(e.target.value)} maxLength={500} style={fieldStyle} />
          </div>
          <div>
            <label style={{ fontSize: 10, fontWeight: 700, color: UI.textSec }}>Destination URL</label>
            <input data-testid="draft-edit-destination-url" value={destinationUrl} onChange={e => setDestinationUrl(e.target.value)} style={fieldStyle} />
            {destMissing && (
              <p data-testid="draft-destination-warning" style={{ margin: "4px 0 0", fontSize: 10, color: UI.warning }}>
                Destination URL missing. You can still publish this pin.
              </p>
            )}
          </div>
          <div>
            <label style={{ fontSize: 10, fontWeight: 700, color: UI.textSec }}>Planned date</label>
            <input data-testid="draft-edit-planned-date" type="date" value={plannedDate} onChange={e => setPlannedDate(e.target.value)} style={fieldStyle} />
          </div>
        </div>
        <footer style={{ padding: "12px 18px", borderTop: `1px solid ${UI.border}` }}>
          <button type="button" data-testid="draft-edit-save" onClick={handleSave}
            style={{ width: "100%", padding: "10px", borderRadius: 8, border: "none", background: UI.gradient, color: "#fff", fontSize: 12, fontWeight: 800, cursor: "pointer" }}>
            Save changes
          </button>
        </footer>
      </aside>
    </>
  );
}
