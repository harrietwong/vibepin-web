/**
 * singleVideoPayload.ts — the ONE definition of "this Content is a single video".
 *
 * Two callers must agree on this byte-for-byte:
 *   - `/api/cron/publish-due` decides whether a due row takes the v76 durable video
 *     path (and whether the Instagram side of a mixed draft is refused);
 *   - `splitMixedVideoDraft` decides whether a mixed Pinterest+Instagram draft must
 *     be split before it may be scheduled, and `/api/pin-drafts` refuses an
 *     unsplit one with `mixed_video_requires_split`.
 * If the two ever disagree, a draft the splitter leaves alone could be one the cron
 * refuses at due time (or vice versa) — so both import this module instead of each
 * keeping a private copy (the T1 copy had already drifted: it did not drop
 * non-object media entries before counting, the cron did).
 *
 * The cron's semantics are the reference ("zero behaviour change" for the executor):
 * non-object entries are dropped BEFORE counting, then exactly one entry whose
 * `kind` is "video" qualifies.
 *
 * Client-safe: no Node APIs, no server imports.
 */

/** The object entries of `payload.media`, in order; anything else is ignored. */
export function payloadMediaObjects(payload: unknown): Array<Record<string, unknown>> {
  if (!payload || typeof payload !== "object") return [];
  const media = (payload as { media?: unknown }).media;
  return Array.isArray(media)
    ? media.filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
    : [];
}

/** Exactly one media object, and it is a video. */
export function isSingleVideoPayload(payload: unknown): boolean {
  const media = payloadMediaObjects(payload);
  return media.length === 1 && media[0].kind === "video";
}
