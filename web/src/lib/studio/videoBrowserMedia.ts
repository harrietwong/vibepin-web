"use client";

import { MAX_VIDEO_DURATION_MS, MIN_VIDEO_DURATION_MS } from "@/lib/videoUploadLimits";
import { normalizedVideoContentType, type VideoInspection } from "./videoBatchUpload";
import type { ContentVideoMedia } from "@/lib/contentDraftModel";
import { getDraft, getPinDraftOwnerScope, replaceVideoPoster } from "@/lib/pinDraftStore";
import { isValidCoverFrameTime } from "@/lib/videoCoverFrame";
import { uploadPinImage } from "./uploadPinImage";

export class VideoBrowserMediaError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; }
}

export type BrowserVideoProbe = Omit<VideoInspection, "checksumSha256"> & { posterFile?: File };

function waitFor(video: HTMLVideoElement, event: "loadedmetadata" | "loadeddata" | "seeked", signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = window.setTimeout(() => done(new VideoBrowserMediaError("video_decode_failed")), 15_000);
    const done = (error?: Error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      video.removeEventListener(event, success);
      video.removeEventListener("error", failed);
      signal?.removeEventListener("abort", aborted);
      if (error) reject(error);
      else resolve();
    };
    const success = () => done();
    const failed = () => done(new VideoBrowserMediaError("video_decode_failed"));
    const aborted = () => done(new VideoBrowserMediaError("video_upload_aborted"));
    if (signal?.aborted) { aborted(); return; }
    video.addEventListener(event, success, { once: true });
    video.addEventListener("error", failed, { once: true });
    signal?.addEventListener("abort", aborted, { once: true });
  });
}

async function capturePoster(video: HTMLVideoElement, file: File, signal?: AbortSignal): Promise<File | undefined> {
  try {
    if (signal?.aborted) throw new VideoBrowserMediaError("video_upload_aborted");
    const target = Math.max(0, Math.min(1, video.duration - 0.05));
    if (Number.isFinite(target) && target > 0 && Math.abs(video.currentTime - target) > 0.01) {
      video.currentTime = target;
      await waitFor(video, "seeked", signal);
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
  } catch (error) {
    if (signal?.aborted || error instanceof VideoBrowserMediaError && error.code === "video_upload_aborted") throw error;
    // The cover is optional. AI Copy v2 explicitly represents this as
    // video_cover_unavailable rather than blocking a valid video Pin.
    return undefined;
  }
}

/** A metadata event is not evidence that the browser can decode an actual frame. */
async function verifyPlayableFrame(video: HTMLVideoElement, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new VideoBrowserMediaError("video_upload_aborted");
  const target = Math.max(0, Math.min(1, video.duration - 0.05));
  if (!Number.isFinite(target) || target <= 0) throw new VideoBrowserMediaError("video_decode_failed");
  if (Math.abs(video.currentTime - target) <= 0.01) return;
  video.currentTime = target;
  await waitFor(video, "seeked", signal);
}

/** Browser-only decode boundary. Server finalize still verifies the stored container and bytes. */
export async function probeVideoFile(file: File, signal?: AbortSignal): Promise<BrowserVideoProbe> {
  if (signal?.aborted) throw new VideoBrowserMediaError("video_upload_aborted");
  const contentType = normalizedVideoContentType(file);
  if (!contentType) throw new VideoBrowserMediaError("invalid_video_type");
  const objectUrl = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.preload = "metadata";
  video.muted = true;
  video.playsInline = true;
  try {
    video.src = objectUrl;
    if (video.readyState < HTMLMediaElement.HAVE_METADATA) await waitFor(video, "loadedmetadata", signal);
    const durationMs = Math.round(video.duration * 1000);
    if (!Number.isFinite(durationMs) || durationMs < MIN_VIDEO_DURATION_MS || durationMs > MAX_VIDEO_DURATION_MS
      || !Number.isFinite(video.videoWidth) || !Number.isFinite(video.videoHeight)
      || video.videoWidth < 1 || video.videoHeight < 1) {
      throw new VideoBrowserMediaError("invalid_video_metadata");
    }
    // Seeking successfully is a required decode check. The subsequent canvas/JPEG
    // conversion is merely a convenience cover and may legitimately be unavailable.
    await verifyPlayableFrame(video, signal);
    const posterFile = await capturePoster(video, file, signal);
    return { contentType, width: video.videoWidth, height: video.videoHeight, durationMs, posterFile };
  } finally {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(objectUrl);
  }
}

/** Unlike the optional initial poster, an explicit cover selection must fail visibly. */
export async function captureVideoCoverFrame(video: HTMLVideoElement, timeMs: number, durationMs: number, signal?: AbortSignal): Promise<File> {
  if (signal?.aborted) throw new VideoBrowserMediaError("video_cover_cancelled");
  if (!isValidCoverFrameTime(timeMs, durationMs) || !Number.isFinite(video.duration)
      || timeMs > video.duration * 1000 + 1) throw new VideoBrowserMediaError("invalid_cover_frame_time");
  video.pause();
  if (video.seeking || Math.abs(video.currentTime - timeMs / 1000) > 0.000001) {
    const sought = waitFor(video, "seeked", signal);
    video.currentTime = Math.min(timeMs / 1000, video.duration);
    await sought;
  }
  if (video.readyState < 2) await waitFor(video, "loadeddata", signal);
  if (signal?.aborted) throw new VideoBrowserMediaError("video_cover_cancelled");
  const canvas = document.createElement("canvas");
  const scale = Math.min(1, 2048 / Math.max(video.videoWidth, video.videoHeight));
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  const context = canvas.getContext("2d");
  if (!context || !canvas.width || !canvas.height) throw new VideoBrowserMediaError("video_cover_capture_failed");
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/jpeg", 0.88));
  if (signal?.aborted) throw new VideoBrowserMediaError("video_cover_cancelled");
  if (!blob?.size || blob.type !== "image/jpeg") throw new VideoBrowserMediaError("video_cover_capture_failed");
  return new File([blob], "video-cover.jpg", { type: "image/jpeg" });
}

type CoverSelectionDependencies = {
  capture: typeof captureVideoCoverFrame;
  upload: (file: File) => Promise<{ proxyUrl: string }>;
};

export async function confirmVideoCoverFrame(
  draftId: string, media: ContentVideoMedia, video: HTMLVideoElement, timeMs: number,
  deps: CoverSelectionDependencies = { capture: captureVideoCoverFrame, upload: uploadPinImage },
  signal?: AbortSignal,
): Promise<void> {
  if (!isValidCoverFrameTime(timeMs, media.durationMs)) throw new Error("invalid_cover_frame_time");
  const owner = JSON.stringify(getPinDraftOwnerScope());
  const unchanged = () => {
    const current = getDraft(draftId)?.media?.find(item => item.id === media.id);
    return !signal?.aborted && owner === JSON.stringify(getPinDraftOwnerScope()) && current?.kind === "video"
      && current.url === media.url && current.posterUrl === media.posterUrl
      && current.coverFrameTimeMs === media.coverFrameTimeMs && current.durationMs === media.durationMs;
  };
  if (!unchanged()) throw new Error("The video cover changed. Reopen the selector and retry.");
  const file = await deps.capture(video, timeMs, media.durationMs!, signal);
  if (!unchanged()) throw new Error("The video cover changed. Reopen the selector and retry.");
  // Generic owner-bound upload: v80 association is finalized and must never be reused.
  const poster = await deps.upload(file);
  if (!unchanged()) throw new Error("The video cover changed. Reopen the selector and retry.");
  // The old poster (and a racing unattached upload) is retained in P0: there is no
  // replacement-delete capability on the one-time v80 operation.
  if (!replaceVideoPoster(draftId, media.id, { posterUrl: poster.proxyUrl, coverFrameTimeMs: timeMs })) {
    throw new Error("The video cover changed. Reopen the selector and retry.");
  }
}
