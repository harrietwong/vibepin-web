"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2 } from "lucide-react";
import type { ContentVideoMedia } from "@/lib/contentDraftModel";
import { confirmVideoCoverFrame } from "@/lib/studio/videoBrowserMedia";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import { BUI } from "./boardUI";

/** Frames shown in the filmstrip under the preview. */
const FILMSTRIP_FRAMES = 8;
const FILMSTRIP_HEIGHT = 72;

/**
 * Decode evenly spaced frames from a separate, hidden video element so the main
 * preview never jumps while the strip is being built. Returns data URLs; a frame
 * that fails to decode is left null and renders as a blank tile. Stops on abort.
 */
async function buildFilmstrip(src: string, durationMs: number, signal: AbortSignal): Promise<Array<string | null>> {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.crossOrigin = "anonymous";
  video.src = src;
  const once = (event: string) => new Promise<void>((resolve, reject) => {
    const ok = () => { cleanup(); resolve(); };
    const fail = () => { cleanup(); reject(new Error("video_decode_failed")); };
    const cleanup = () => { video.removeEventListener(event, ok); video.removeEventListener("error", fail); };
    video.addEventListener(event, ok, { once: true });
    video.addEventListener("error", fail, { once: true });
  });
  try {
    await once("loadeddata");
    const canvas = document.createElement("canvas");
    const ratio = video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 9 / 16;
    canvas.height = FILMSTRIP_HEIGHT * 2;
    canvas.width = Math.max(1, Math.round(canvas.height * ratio));
    const ctx = canvas.getContext("2d");
    const frames: Array<string | null> = [];
    for (let i = 0; i < FILMSTRIP_FRAMES; i++) {
      if (signal.aborted) break;
      video.currentTime = ((i + 0.5) / FILMSTRIP_FRAMES) * (durationMs / 1000);
      try {
        await once("seeked");
        ctx?.drawImage(video, 0, 0, canvas.width, canvas.height);
        frames.push(canvas.toDataURL("image/jpeg", 0.6));
      } catch {
        frames.push(null);
      }
    }
    return frames;
  } finally {
    video.removeAttribute("src");
    video.load();
  }
}

export function VideoCoverFrameDialog({ draftId, media, onClose }: {
  draftId: string; media: ContentVideoMedia; onClose: () => void;
}) {
  const { t: tr } = useLocale();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const titleId = useId();
  const sliderId = useId();
  const durationMs = media.durationMs ?? 0;
  const [timeMs, setTimeMs] = useState(Math.min(media.coverFrameTimeMs ?? 1000, durationMs));
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [frames, setFrames] = useState<Array<string | null>>([]);
  const [sliderFocused, setSliderFocused] = useState(false);
  const savingRef = useRef(false);
  const lifetimeRef = useRef<AbortController | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const lifetime = new AbortController();
    lifetimeRef.current = lifetime;
    const previous = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    dialog?.showModal();
    if (durationMs > 0) {
      // A filmstrip that fails to build leaves the plain track; the slider still works.
      buildFilmstrip(media.url, durationMs, lifetime.signal)
        .then(result => { if (!lifetime.signal.aborted) setFrames(result); })
        .catch(() => {});
    }
    return () => { lifetime.abort(); dialog?.close(); if (previous?.isConnected) previous.focus(); };
  }, [media.url, durationMs]);

  const seek = (chosen: number) => {
    setTimeMs(chosen);
    if (videoRef.current) { videoRef.current.pause(); videoRef.current.currentTime = chosen / 1000; }
  };

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
      if (!signal.aborted) setError(tr("studioBoard.videoCover.saveFailed"));
    } finally {
      if (!signal.aborted) { savingRef.current = false; setSaving(false); }
    }
  };

  const handlePct = durationMs > 0 ? (timeMs / durationMs) * 100 : 0;

  return createPortal(<dialog ref={dialogRef} aria-labelledby={titleId}
    onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}
    onCancel={event => { event.preventDefault(); if (!savingRef.current) onClose(); }}
    style={{ width: "min(640px, calc(100vw - 32px))", maxHeight: "92vh", overflowY: "auto", padding: 22, borderRadius: 16, border: `1px solid ${BUI.border}`, background: BUI.surface, color: BUI.text, boxShadow: "0 20px 80px #0006" }}>
    <h2 id={titleId} style={{ fontSize: 18, fontWeight: 750, margin: 0 }}>{tr("studioBoard.videoCover.title")}</h2>
    <p style={{ margin: "6px 0 16px", fontSize: 13, color: BUI.textSec }}>{tr("studioBoard.videoCover.subtitle")}</p>

    <div style={{ display: "flex", justifyContent: "center", background: "#0B0D12", borderRadius: 12, padding: 8 }}>
      <video ref={videoRef} src={media.url} poster={media.posterUrl} muted playsInline preload="auto" tabIndex={-1}
        aria-label={tr("studioBoard.videoCover.previewAria")}
        style={{ display: "block", maxWidth: "100%", maxHeight: "52vh", borderRadius: 8, background: "#111" }}
        onLoadedData={() => {
          setReady(durationMs > 0);
          if (videoRef.current) videoRef.current.currentTime = timeMs / 1000;
        }}
        onError={() => { setReady(false); setError(tr("studioBoard.videoCover.loadFailed")); }} />
    </div>

    {/* Filmstrip + draggable handle. The real control is the (visually hidden but
        focusable) range input stretched over the strip, so mouse, touch and keyboard
        all work; the handle and focus ring just mirror its value. */}
    <div data-testid="video-cover-filmstrip"
      style={{ position: "relative", marginTop: 16, height: FILMSTRIP_HEIGHT, borderRadius: 10, overflow: "hidden", background: BUI.surface3,
        outline: sliderFocused ? `2px solid ${BUI.purple}` : "none", outlineOffset: 2 }}>
      <div style={{ display: "flex", height: "100%" }}>
        {Array.from({ length: FILMSTRIP_FRAMES }, (_, i) => (
          <div key={i} style={{ flex: 1, minWidth: 0, height: "100%", background: BUI.surface3, borderRight: i < FILMSTRIP_FRAMES - 1 ? "1px solid rgba(0,0,0,.35)" : "none" }}>
            {frames[i] && <img src={frames[i]!} alt="" draggable={false} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />}
          </div>
        ))}
      </div>
      {frames.length === 0 && ready && (
        <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", pointerEvents: "none" }}>
          <Loader2 className="animate-spin" style={{ width: 16, height: 16, color: BUI.textSec }} />
        </div>
      )}
      <div aria-hidden="true" style={{ position: "absolute", top: 0, bottom: 0, left: `${handlePct}%`, transform: "translateX(-50%)", width: 4, borderRadius: 2,
        background: BUI.purple, boxShadow: "0 0 0 2px rgba(255,255,255,.85)", pointerEvents: "none" }} />
      <input id={sliderId} type="range" min={0} max={durationMs} step={1} value={timeMs} disabled={!ready || saving}
        aria-label={tr("studioBoard.videoCover.frameTime")}
        aria-valuetext={`${(timeMs / 1000).toFixed(1)} s`}
        onFocus={() => setSliderFocused(true)} onBlur={() => setSliderFocused(false)}
        onChange={event => seek(Number(event.target.value))}
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", margin: 0, opacity: 0, cursor: ready && !saving ? "ew-resize" : "default" }} />
    </div>
    <output htmlFor={sliderId} aria-live="polite" style={{ display: "block", marginTop: 6, fontSize: 11.5, color: BUI.textMuted, textAlign: "right" }}>
      {(timeMs / 1000).toFixed(1)} s / {(durationMs / 1000).toFixed(1)} s
    </output>

    {error && <p role="alert" style={{ color: BUI.error, marginTop: 12 }}>{error}</p>}
    <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 18 }}>
      <button type="button" disabled={saving} onClick={onClose}
        style={{ padding: "9px 16px", borderRadius: 8, background: BUI.surface2, color: BUI.text, border: `1px solid ${BUI.border}`, cursor: "pointer", fontFamily: "inherit" }}>
        {tr("studioBoard.videoCover.cancel")}
      </button>
      <button type="button" data-testid="video-cover-confirm" disabled={!ready || saving} onClick={() => void confirm()}
        style={{ padding: "9px 16px", borderRadius: 8, background: BUI.purple, color: "white", border: 0, cursor: ready && !saving ? "pointer" : "default", fontFamily: "inherit" }}>
        {saving ? tr("studioBoard.videoCover.saving") : tr("studioBoard.videoCover.done")}
      </button>
    </div>
  </dialog>, document.body);
}
