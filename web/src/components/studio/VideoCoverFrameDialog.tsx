"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ContentVideoMedia } from "@/lib/contentDraftModel";
import { confirmVideoCoverFrame } from "@/lib/studio/videoBrowserMedia";
import { BUI } from "./boardUI";

export function VideoCoverFrameDialog({ draftId, media, onClose }: {
  draftId: string; media: ContentVideoMedia; onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const titleId = useId();
  const sliderId = useId();
  const durationMs = media.durationMs ?? 0;
  const [timeMs, setTimeMs] = useState(Math.min(media.coverFrameTimeMs ?? 1000, durationMs));
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const lifetimeRef = useRef<AbortController | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const lifetime = new AbortController();
    lifetimeRef.current = lifetime;
    const previous = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => { lifetime.abort(); dialog?.close(); if (previous?.isConnected) previous.focus(); };
  }, []);

  const confirm = async () => {
    const signal = lifetimeRef.current?.signal;
    if (!videoRef.current || savingRef.current || !ready || !signal || signal.aborted) return;
    savingRef.current = true;
    setSaving(true);
    setError("");
    try {
      await confirmVideoCoverFrame(draftId, media, videoRef.current, timeMs, undefined, signal);
      if (!signal.aborted) onClose();
    } catch {
      if (!signal.aborted) setError("Could not save this cover. Your previous cover is unchanged. Please retry.");
    } finally {
      if (!signal.aborted) { savingRef.current = false; setSaving(false); }
    }
  };

  return createPortal(<dialog ref={dialogRef} aria-labelledby={titleId}
    onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}
    onCancel={event => { event.preventDefault(); if (!savingRef.current) onClose(); }}
    style={{ width: "min(560px, calc(100vw - 32px))", maxHeight: "90vh", overflowY: "auto", padding: 20, borderRadius: 16, border: `1px solid ${BUI.border}`, background: BUI.surface, color: BUI.text, boxShadow: "0 20px 80px #0006" }}>
    <h2 id={titleId} style={{ fontSize: 18, fontWeight: 750, margin: "0 0 14px" }}>Choose cover frame</h2>
    <video ref={videoRef} src={media.url} poster={media.posterUrl} muted playsInline preload="auto" tabIndex={-1}
      aria-label="Video cover preview" style={{ width: "100%", maxHeight: "48vh", background: "#111", borderRadius: 8 }}
      onLoadedData={() => {
        setReady(durationMs > 0);
        if (videoRef.current) videoRef.current.currentTime = timeMs / 1000;
      }}
      onError={() => { setReady(false); setError("Could not load the video. Close and reopen to retry."); }} />
    <label htmlFor={sliderId} style={{ display: "block", marginTop: 16, fontWeight: 650 }}>Cover frame time</label>
    <input id={sliderId} type="range" min={0} max={durationMs} step={1} value={timeMs} disabled={!ready || saving}
      aria-valuetext={`${(timeMs / 1000).toFixed(3)} seconds`}
      onChange={event => {
        const chosen = Number(event.target.value);
        setTimeMs(chosen);
        if (videoRef.current) { videoRef.current.pause(); videoRef.current.currentTime = chosen / 1000; }
      }} style={{ width: "100%", marginTop: 8 }} />
    <output htmlFor={sliderId} aria-live="polite">{(timeMs / 1000).toFixed(3)} s / {(durationMs / 1000).toFixed(3)} s</output>
    {error && <p role="alert" style={{ color: BUI.error, marginTop: 12 }}>{error}</p>}
    <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 20 }}>
      <button type="button" disabled={saving} onClick={onClose} style={{ padding: "9px 16px", borderRadius: 8, background: BUI.surface2, color: BUI.text, border: `1px solid ${BUI.border}` }}>Cancel</button>
      <button type="button" disabled={!ready || saving} onClick={() => void confirm()} style={{ padding: "9px 16px", borderRadius: 8, background: BUI.purple, color: "white", border: 0 }}>
        {saving ? "Saving cover…" : "Confirm"}
      </button>
    </div>
  </dialog>, document.body);
}
