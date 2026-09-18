/** Explicit frame positions require a known duration; legacy absence remains one second. */
export function isValidCoverFrameTime(value: unknown, durationMs: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    && typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs > 0
    && value <= durationMs;
}

export function videoCoverFrameSeconds(coverFrameTimeMs?: number, durationMs?: number): number {
  if (coverFrameTimeMs === undefined) return 1;
  if (!isValidCoverFrameTime(coverFrameTimeMs, durationMs)) throw new Error("invalid_cover_frame_time");
  return coverFrameTimeMs / 1000;
}
