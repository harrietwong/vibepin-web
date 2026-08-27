/**
 * Per-platform media rules for a multi-image publish — the ONE place that decides
 * whether a Content's media set can go out as a carousel / multi-photo post.
 *
 * Pure and dependency-free ON PURPOSE: the client uses it to warn before the
 * merchant schedules, and every server publish path re-checks it before calling a
 * platform API. A rule that lived only on the client would be silently bypassed by
 * the cron worker; one that lived only on the server would tell the merchant far
 * too late. No server-only imports may ever be added here.
 *
 * What each platform accepts (verified against the official specs, 2026-08-27):
 *
 *   Pinterest  1 image (media_source image_url) OR 2–5 (multiple_image_urls).
 *              Every carousel image must share ONE aspect ratio — Pinterest
 *              rejects a mixed-ratio carousel outright.
 *   Instagram  1 image OR a 2–10 item carousel. Instagram crops every item to the
 *              FIRST item's ratio rather than rejecting, so a mismatch is a
 *              quality problem, not an API error — see checkInstagramMedia.
 *   Facebook   1–10 photos (a multi-photo feed post with attached_media).
 */

/** One image in a publish, in the Content's display order. Dimensions optional. */
export type PublishMediaItem = {
  url: string;
  width?: number;
  height?: number;
};

/**
 * `too_few` is part of the vocabulary but is never produced by the checks below:
 * every platform here accepts a SINGLE image, so "fewer than a carousel" is a
 * valid single-image post, not a failure. It exists for a caller that has already
 * committed to a carousel (a UI affordance that only makes sense with ≥2 items)
 * and needs to say so in the same vocabulary. `no_media` is the real empty case.
 */
export type MediaCheckFailureCode =
  | "no_media"
  | "too_few"
  | "too_many"
  | "aspect_mismatch";

export type MediaCheckResult =
  | {
      ok: true;
      /**
       * True when the ratio rule could NOT be evaluated because at least one item
       * has unknown dimensions. The set is allowed through (we never block a
       * publish on a measurement we do not have), but the caller knows the
       * platform's own ratio rejection is still the real enforcement.
       */
      unverifiedRatio?: boolean;
    }
  | { ok: false; code: MediaCheckFailureCode; message: string };

export const PINTEREST_CAROUSEL_MIN = 2;
export const PINTEREST_CAROUSEL_MAX = 5;
export const INSTAGRAM_CAROUSEL_MIN = 2;
export const INSTAGRAM_CAROUSEL_MAX = 10;
export const FACEBOOK_PHOTO_MAX = 10;

/** Aspect ratios within 2% of each other count as the same ratio. */
export const ASPECT_RATIO_TOLERANCE = 0.02;

/** Items with a usable url, in the given order. Blank/whitespace entries are dropped. */
function usableItems(items: readonly PublishMediaItem[] | null | undefined): PublishMediaItem[] {
  if (!Array.isArray(items)) return [];
  return items.filter(item => typeof item?.url === "string" && item.url.trim().length > 0);
}

function ratioOf(item: PublishMediaItem): number | null {
  const { width, height } = item;
  if (typeof width !== "number" || typeof height !== "number") return null;
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (width <= 0 || height <= 0) return null;
  return width / height;
}

/**
 * How many items differ from the FIRST item's aspect ratio by more than the
 * tolerance. Returns null when any item's dimensions are unknown — the answer is
 * then "we cannot tell", which is deliberately different from "they all match".
 */
function countRatioOutliers(items: readonly PublishMediaItem[]): number | null {
  const ratios: number[] = [];
  for (const item of items) {
    const ratio = ratioOf(item);
    if (ratio === null) return null;
    ratios.push(ratio);
  }
  const reference = ratios[0];
  let outliers = 0;
  for (let i = 1; i < ratios.length; i++) {
    // Relative difference against the reference: a 2% tolerance on 1:1 must not
    // become a 2%-of-1000px tolerance on a tall image.
    if (Math.abs(ratios[i] - reference) / reference > ASPECT_RATIO_TOLERANCE) outliers++;
  }
  return outliers;
}

function noMedia(platform: string): MediaCheckResult {
  return { ok: false, code: "no_media", message: `Add an image before publishing to ${platform}.` };
}

/**
 * Pinterest: 1 image, or a 2–5 image carousel whose images share one aspect ratio.
 *
 * The ratio rule is only ENFORCED when every item's dimensions are known. With
 * URL-only items we return ok with `unverifiedRatio` so nothing is blocked on a
 * measurement we never took; Pinterest still rejects a genuinely mixed carousel,
 * and that rejection surfaces as a normal publish failure.
 */
export function checkPinterestMedia(items: readonly PublishMediaItem[] | null | undefined): MediaCheckResult {
  const media = usableItems(items);
  if (media.length === 0) return noMedia("Pinterest");
  if (media.length === 1) return { ok: true };
  if (media.length > PINTEREST_CAROUSEL_MAX) {
    return {
      ok: false,
      code: "too_many",
      message: `Pinterest carousels hold up to ${PINTEREST_CAROUSEL_MAX} images. Remove ${media.length - PINTEREST_CAROUSEL_MAX} to publish here.`,
    };
  }

  const outliers = countRatioOutliers(media);
  if (outliers === null) return { ok: true, unverifiedRatio: true };
  if (outliers > 0) {
    return {
      ok: false,
      code: "aspect_mismatch",
      message: `Pinterest carousels need all images in the same aspect ratio. ${outliers} ${outliers === 1 ? "image needs" : "images need"} adjustment.`,
    };
  }
  return { ok: true };
}

/**
 * Instagram: 1 image, or a 2–10 item carousel.
 *
 * NO ratio failure: Instagram crops every item to the first item's ratio instead
 * of refusing the post, so blocking here would reject content Instagram would
 * happily accept. Mismatched dimensions are reported through `unverifiedRatio`
 * being absent — the caller may still warn, but the publish proceeds.
 */
export function checkInstagramMedia(items: readonly PublishMediaItem[] | null | undefined): MediaCheckResult {
  const media = usableItems(items);
  if (media.length === 0) return noMedia("Instagram");
  if (media.length === 1) return { ok: true };
  if (media.length > INSTAGRAM_CAROUSEL_MAX) {
    return {
      ok: false,
      code: "too_many",
      message: `Instagram carousels hold up to ${INSTAGRAM_CAROUSEL_MAX} images. Remove ${media.length - INSTAGRAM_CAROUSEL_MAX} to publish here.`,
    };
  }
  return countRatioOutliers(media) === null ? { ok: true, unverifiedRatio: true } : { ok: true };
}

/** Facebook: 1–10 photos in one post. Facebook imposes no shared-ratio rule. */
export function checkFacebookMedia(items: readonly PublishMediaItem[] | null | undefined): MediaCheckResult {
  const media = usableItems(items);
  if (media.length === 0) return noMedia("Facebook");
  if (media.length > FACEBOOK_PHOTO_MAX) {
    return {
      ok: false,
      code: "too_many",
      message: `Facebook posts hold up to ${FACEBOOK_PHOTO_MAX} images. Remove ${media.length - FACEBOOK_PHOTO_MAX} to publish here.`,
    };
  }
  return media.length === 1 || countRatioOutliers(media) !== null
    ? { ok: true }
    : { ok: true, unverifiedRatio: true };
}

/** Convenience: URLs → items, for the server paths that only carry URLs. */
export function toMediaItems(urls: readonly string[] | null | undefined): PublishMediaItem[] {
  if (!Array.isArray(urls)) return [];
  return urls.filter((u): u is string => typeof u === "string" && u.trim().length > 0).map(url => ({ url }));
}
