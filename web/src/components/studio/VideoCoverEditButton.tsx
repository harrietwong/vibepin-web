"use client";

import { useState } from "react";
import { Image as ImageIcon } from "lucide-react";
import type { ContentVideoMedia } from "@/lib/contentDraftModel";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import { VideoCoverFrameDialog } from "./VideoCoverFrameDialog";

/**
 * "Edit cover image" inside the bottom of a single-video card's preview (Pinterest's
 * own pattern). Hidden until the preview is hovered or focused — the parent media box
 * carries the `group` class — and always shown on touch devices. It sits just above
 * the native playback bar, which appears on hover in the same place.
 */
export function VideoCoverEditButton({ draftId, media, disabled }: {
  draftId: string; media: ContentVideoMedia; disabled?: boolean;
}) {
  const { t: tr } = useLocale();
  const [open, setOpen] = useState(false);
  if (disabled) return null;
  return (
    <>
      <button type="button" data-testid="video-edit-cover"
        onClick={event => { event.stopPropagation(); setOpen(true); }}
        className="opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
        style={{ position: "absolute", left: 10, right: 10, bottom: 48, zIndex: 3, display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
          padding: "8px 10px", borderRadius: 10, border: 0, background: "rgba(255,255,255,.94)", color: "#1F2937",
          fontSize: 12, fontWeight: 750, cursor: "pointer", boxShadow: "0 2px 10px rgba(0,0,0,.25)", fontFamily: "inherit" }}>
        <ImageIcon style={{ width: 13, height: 13 }} /> {tr("studioBoard.videoCover.edit")}
      </button>
      {open && <VideoCoverFrameDialog draftId={draftId} media={media} onClose={() => setOpen(false)} />}
    </>
  );
}
