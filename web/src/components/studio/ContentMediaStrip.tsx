"use client";

import { useRef, useState } from "react";
import { Check, GripVertical, ImagePlus, Loader2, Trash2 } from "lucide-react";
import type { PinDraft } from "@/lib/pinDraftStore";
import { addMedia, copyMedia, removeMedia, reorderMedia, setCoverMedia } from "@/lib/pinDraftStore";
import { contentMedia, coverMedia } from "@/lib/contentDraftModel";
import { uploadPinImage } from "@/lib/studio/uploadPinImage";
import { measureImageFile } from "@/lib/studio/measureImageFile";
import { BUI } from "@/components/studio/boardUI";
import { PinFallbackArtwork } from "@/components/studio/PinFallbackArtwork";

const MEDIA_DRAG_TYPE = "application/x-vibepin-content-media";

type DragPayload = { sourceDraftId: string; mediaId: string };

function MediaThumbnail({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = useState(false);
  if (failed || !src.trim()) return <PinFallbackArtwork compact />;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt={alt} onError={() => setFailed(true)}
      style={{ width: "100%", height: "100%", display: "block", objectFit: "cover", borderRadius: 6 }} />
  );
}

function readPayload(event: React.DragEvent): DragPayload | null {
  try {
    const value = JSON.parse(event.dataTransfer.getData(MEDIA_DRAG_TYPE)) as DragPayload;
    return value?.sourceDraftId && value?.mediaId ? value : null;
  } catch {
    return null;
  }
}

export function ContentMediaStrip({ draft, disabled }: { draft: PinDraft; disabled?: boolean }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const media = contentMedia(draft);
  const cover = coverMedia(draft);

  const dropBefore = (event: React.DragEvent, targetId: string) => {
    event.preventDefault();
    event.stopPropagation();
    setDropTargetId(null);
    const payload = readPayload(event);
    if (!payload) return;
    const targetIndex = media.findIndex(item => item.id === targetId);
    if (payload.sourceDraftId !== draft.id) {
      copyMedia(payload.sourceDraftId, payload.mediaId, draft.id, Math.max(0, targetIndex));
      return;
    }
    const next = media.map(item => item.id).filter(id => id !== payload.mediaId);
    next.splice(Math.max(0, targetIndex), 0, payload.mediaId);
    reorderMedia(draft.id, next);
  };

  const addFiles = async (files: FileList | null) => {
    const selected = Array.from(files ?? []).filter(file => file.type.startsWith("image/"));
    if (!selected.length) return;
    setUploading(true);
    try {
      const uploaded = [];
      for (const file of selected) {
        const { publicUrl } = await uploadPinImage(file);
        // Measured from the File, not the hosted URL: dimensions are what let the
        // carousel ratio check say "2 images need adjustment" instead of shrugging.
        const { width, height } = await measureImageFile(file);
        uploaded.push({ kind: "image" as const, url: publicUrl, altText: file.name.replace(/\.[^.]+$/, ""), source: "upload" as const, width, height });
      }
      addMedia(draft.id, uploaded);
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  if (!media.length) return null;

  return (
    <div data-testid="content-media-strip" style={{ padding: "9px 10px", borderBottom: `1px solid ${BUI.border}`, background: BUI.surface2 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 7 }}>
        <span style={{ fontSize: 10.5, fontWeight: 800, color: BUI.textSec }}>Media · {media.length}</span>
        <span style={{ fontSize: 9.5, color: BUI.textMuted }}>Drag to reorder or copy</span>
      </div>
      <div style={{ display: "flex", gap: 7, overflowX: "auto", paddingBottom: 2 }}>
        {media.map((item, index) => {
          const selected = item.id === cover?.id;
          return (
            <div key={item.id} draggable={!disabled}
              onDragStart={event => {
                event.dataTransfer.effectAllowed = "copyMove";
                event.dataTransfer.setData(MEDIA_DRAG_TYPE, JSON.stringify({ sourceDraftId: draft.id, mediaId: item.id }));
              }}
              onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; setDropTargetId(item.id); }}
              onDragLeave={() => setDropTargetId(id => id === item.id ? null : id)}
              onDrop={event => dropBefore(event, item.id)}
              style={{ position: "relative", flex: "0 0 54px", height: 66, borderRadius: 9, padding: 2,
                border: `2px solid ${dropTargetId === item.id ? BUI.purple : selected ? BUI.purple : "transparent"}`,
                background: BUI.surface, cursor: disabled ? "default" : "grab" }}>
              <button type="button" aria-label={`Use media ${index + 1} as cover`} disabled={disabled}
                onClick={() => !disabled && setCoverMedia(draft.id, item.id)}
                style={{ width: "100%", height: "100%", padding: 0, border: 0, borderRadius: 6, overflow: "hidden", background: BUI.surface3, cursor: disabled ? "default" : "pointer" }}>
                <MediaThumbnail src={item.url} alt={item.altText || `Media ${index + 1}`} />
              </button>
              <span style={{ position: "absolute", top: 4, left: 4, width: 16, height: 16, display: "grid", placeItems: "center", borderRadius: 5, background: "rgba(15,23,42,.65)", color: "#fff" }}>
                {selected ? <Check style={{ width: 10, height: 10 }} /> : <GripVertical style={{ width: 10, height: 10 }} />}
              </span>
              {media.length > 1 && (
                <button type="button" aria-label="Remove image" disabled={disabled} onClick={() => removeMedia(draft.id, item.id)}
                  style={{ position: "absolute", right: 4, bottom: 4, width: 18, height: 18, padding: 0, display: "grid", placeItems: "center", border: 0, borderRadius: 5, background: "rgba(15,23,42,.7)", color: "#fff", cursor: "pointer" }}>
                  <Trash2 style={{ width: 10, height: 10 }} />
                </button>
              )}
            </div>
          );
        })}
        <button type="button" data-testid="content-add-media" disabled={disabled || uploading} onClick={() => inputRef.current?.click()}
          style={{ flex: "0 0 54px", height: 66, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 4, borderRadius: 9,
            border: `1px dashed ${BUI.borderHi}`, background: BUI.surface, color: BUI.textSec, fontSize: 9.5, fontWeight: 700, cursor: "pointer" }}>
          {uploading ? <Loader2 className="animate-spin" style={{ width: 15, height: 15 }} /> : <ImagePlus style={{ width: 16, height: 16 }} />}
          Add
        </button>
        <input ref={inputRef} type="file" accept="image/*" multiple hidden onChange={event => void addFiles(event.target.files)} />
      </div>
    </div>
  );
}
