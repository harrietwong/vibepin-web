"use client";

import { useRef } from "react";
import { Upload, Loader2, Check } from "lucide-react";
import { BUI } from "@/components/studio/boardUI";

const ACCEPT = "image/png,image/jpeg,image/webp,image/gif";

export type SaveState = "idle" | "saving" | "saved";

/**
 * Default board toolbar: Upload Pins + a passive local save indicator.
 * (Bulk actions bar is Phase 3; not shown here to avoid dead disabled controls.)
 */
export function StudioBoardToolbar({ uploading, saveState, onFiles }: {
  uploading: boolean;
  saveState: SaveState;
  onFiles: (files: FileList) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <button type="button" data-testid="board-upload-pins" onClick={() => inputRef.current?.click()} disabled={uploading}
        style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "9px 16px", borderRadius: 10, border: "none", background: BUI.gradient, color: "#fff", fontSize: 12.5, fontWeight: 800, cursor: uploading ? "default" : "pointer", opacity: uploading ? 0.7 : 1, fontFamily: "inherit" }}>
        {uploading ? <Loader2 style={{ width: 14, height: 14 }} className="animate-spin" /> : <Upload style={{ width: 14, height: 14 }} />}
        {uploading ? "Uploading…" : "Upload Pins"}
      </button>
      <input ref={inputRef} type="file" accept={ACCEPT} multiple data-testid="board-upload-input"
        style={{ display: "none" }}
        onChange={e => { if (e.target.files?.length) onFiles(e.target.files); e.target.value = ""; }} />

      <div style={{ flex: 1 }} />

      <span data-testid="board-save-state" style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, fontWeight: 600, color: saveState === "saving" ? BUI.textMuted : BUI.textSec }}>
        {saveState === "saving"
          ? <><Loader2 style={{ width: 11, height: 11 }} className="animate-spin" /> Saving…</>
          : <><Check style={{ width: 11, height: 11, color: BUI.success }} /> Saved on this device</>}
      </span>
    </div>
  );
}
