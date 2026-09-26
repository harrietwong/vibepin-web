"use client";

import { useState } from "react";
import { Image as ImageIcon } from "lucide-react";
import type { ContentVideoMedia } from "@/lib/contentDraftModel";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import { BUI } from "./boardUI";
import { VideoCoverFrameDialog } from "./VideoCoverFrameDialog";

/**
 * Full-width "Edit cover image" bar directly under a single-video card's preview
 * (Pinterest's own pattern). It sits below the video rather than over it so it
 * never covers the native playback controls.
 */
export function VideoCoverEditButton({ draftId, media, disabled }: {
  draftId: string; media: ContentVideoMedia; disabled?: boolean;
}) {
  const { t: tr } = useLocale();
  const [open, setOpen] = useState(false);
  return (
    <div style={{ padding: "8px 10px", borderBottom: `1px solid ${BUI.border}`, background: BUI.surface2 }}>
      <button type="button" data-testid="video-edit-cover" disabled={disabled}
        onClick={event => { event.stopPropagation(); if (!disabled) setOpen(true); }}
        style={{ width: "100%", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6, padding: "7px 10px",
          borderRadius: 8, border: `1px solid ${BUI.border}`, background: BUI.surface, color: BUI.text,
          fontSize: 12, fontWeight: 700, cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.55 : 1, fontFamily: "inherit" }}>
        <ImageIcon style={{ width: 13, height: 13 }} /> {tr("studioBoard.videoCover.edit")}
      </button>
      {open && <VideoCoverFrameDialog draftId={draftId} media={media} onClose={() => setOpen(false)} />}
    </div>
  );
}
