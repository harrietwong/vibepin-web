"use client";

import { MAX_VIDEO_DURATION_MS, MIN_VIDEO_DURATION_MS } from "@/lib/videoUploadLimits";
import { normalizedVideoContentType, type VideoInspection } from "./videoBatchUpload";

export class VideoBrowserMediaError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; }
}

export type BrowserVideoProbe = Omit<VideoInspection, "checksumSha256"> & { posterFile?: File };

function waitFor(video: HTMLVideoElement, event: "loadedmetadata" | "seeked"): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => done(new VideoBrowserMediaError("video_decode_failed")), 15_000);
    const done = (error?: Error) => {
      window.clearTimeout(timer);
      video.removeEventListener(event, success);
      video.removeEventListener("error", failed);
      if (error) reject(error);
      else resolve();
    };
    const success = () => done();
    const failed = () => done(new VideoBrowserMediaError("video_decode_failed"));
    video.addEventListener(event, success, { once: true });
    video.addEventListener("error", failed, { once: true });
  });
}

async function capturePoster(video: HTMLVideoElement, file: File): Promise<File | undefined> {
  try {
    const target = Math.max(0, Math.min(1, video.duration - 0.05));
    if (Number.isFinite(target) && target > 0 && Math.abs(video.currentTime - target) > 0.01) {
      video.currentTime = target;
      await waitFor(video, "seeked");
    }
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext("2d");
    if (!context || !canvas.width || !canvas.height) return undefined;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/jpeg", 0.88));
    if (!blob || !blob.size) return undefined;
    return new File([blob], `${file.name.replace(/\.[^.]+$/, "") || "video"}-cover.jpg`, { type: "image/jpeg" });
  } catch {
    // The cover is optional. AI Copy v2 explicitly represents this as
    // video_cover_unavailable rather than blocking a valid video Pin.
    return undefined;
  }
}

/** A metadata event is not evidence that the browser can decode an actual frame. */
async function verifyPlayableFrame(video: HTMLVideoElement): Promise<void> {
  const target = Math.max(0, Math.min(1, video.duration - 0.05));
  if (!Number.isFinite(target) || target <= 0) throw new VideoBrowserMediaError("video_decode_failed");
  if (Math.abs(video.currentTime - target) <= 0.01) return;
  video.currentTime = target;
  await waitFor(video, "seeked");
}

/** Browser-only decode boundary. Server finalize still verifies the stored container and bytes. */
export async function probeVideoFile(file: File): Promise<BrowserVideoProbe> {
  const contentType = normalizedVideoContentType(file);
  if (!contentType) throw new VideoBrowserMediaError("invalid_video_type");
  const objectUrl = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.preload = "metadata";
  video.muted = true;
  video.playsInline = true;
  try {
    video.src = objectUrl;
    if (video.readyState < HTMLMediaElement.HAVE_METADATA) await waitFor(video, "loadedmetadata");
    const durationMs = Math.round(video.duration * 1000);
    if (!Number.isFinite(durationMs) || durationMs < MIN_VIDEO_DURATION_MS || durationMs > MAX_VIDEO_DURATION_MS
      || !Number.isFinite(video.videoWidth) || !Number.isFinite(video.videoHeight)
      || video.videoWidth < 1 || video.videoHeight < 1) {
      throw new VideoBrowserMediaError("invalid_video_metadata");
    }
    // Seeking successfully is a required decode check. The subsequent canvas/JPEG
    // conversion is merely a convenience cover and may legitimately be unavailable.
    await verifyPlayableFrame(video);
    const posterFile = await capturePoster(video, file);
    return { contentType, width: video.videoWidth, height: video.videoHeight, durationMs, posterFile };
  } finally {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(objectUrl);
  }
}
