/**
 * mediaNotice — what the card says when a platform will not take this media set.
 *
 * PRD §9/§13. The merchant drags a sixth image onto a Content that publishes to
 * Pinterest and Instagram. Instagram is fine with six; Pinterest caps carousels at
 * five. The product's answer is NOT to silently drop the image, and NOT to untick
 * Pinterest — both destroy work the merchant did on purpose. It is to say, once,
 * quietly, which platform needs review and why, point at the images at fault, and
 * offer the split as the way out.
 *
 * Pure and string-free for the same reason cardView is: the component translates,
 * this decides. Everything here is a key, a count or a media id.
 *
 * Two things this deliberately does NOT do:
 *
 *   - It never nags about unknown dimensions. `contentMediaIssues` reports
 *     `unverifiedRatio` when an item has no width/height, and mediaRules already
 *     returns `ok: true` in that case — an unmeasured image is not a defect, and a
 *     warning we cannot substantiate is noise. The platform's own rejection, if it
 *     comes, surfaces as a normal publish failure with a real reason.
 *   - It never dedupes across PLATFORMS, only across accounts. Two Instagram
 *     accounts on one Content produce one Instagram notice (the rule is a property
 *     of the platform, not of the account), but Pinterest and Instagram failing for
 *     different reasons produce two lines, because they need two different fixes.
 */

import {
  contentDestinations,
  contentMedia,
  contentMediaIssues,
  type ContentDraftLike,
  type PublishProvider,
} from "@/lib/contentDraftModel";
import {
  FACEBOOK_PHOTO_MAX,
  INSTAGRAM_CAROUSEL_MAX,
  INSTAGRAM_CAROUSEL_MIN,
  PINTEREST_CAROUSEL_MAX,
  PINTEREST_CAROUSEL_MIN,
  type MediaCheckFailureCode,
} from "@/lib/publish/mediaRules";

/** The carousel window each platform accepts, for the notice's own wording. */
export const PROVIDER_MEDIA_LIMITS: Record<PublishProvider, { min: number; max: number }> = {
  pinterest: { min: PINTEREST_CAROUSEL_MIN, max: PINTEREST_CAROUSEL_MAX },
  instagram: { min: INSTAGRAM_CAROUSEL_MIN, max: INSTAGRAM_CAROUSEL_MAX },
  facebook: { min: 1, max: FACEBOOK_PHOTO_MAX },
};

export type MediaNotice = {
  provider: PublishProvider;
  /** The platform rule that refused, straight from mediaRules. */
  code: MediaCheckFailureCode;
  /**
   * Which images the merchant has to act on. For `aspect_mismatch` these are the
   * ratio outliers; for `too_many` they are the items PAST the platform's limit,
   * which `contentMediaIssues` cannot know (it attributes ratio only) but the card
   * must be able to ring — "2 images need adjustment" with nothing highlighted is
   * a riddle, not a notice. Empty for `no_media`, which is about absence.
   */
  offendingMediaIds: string[];
  /** The platform's cap, so the notice can name it without hardcoding a number. */
  limit: { min: number; max: number };
};

/**
 * One notice per failing platform this Content publishes to, in destination order.
 *
 * An empty array means "every platform this Content names accepts this media set",
 * which is the normal case and the one that must stay silent.
 */
export function mediaNotices(draft: ContentDraftLike): MediaNotice[] {
  const media = contentMedia(draft);
  const seen = new Set<PublishProvider>();
  const notices: MediaNotice[] = [];

  for (const destination of contentDestinations(draft)) {
    // Per PLATFORM, not per destination: two accounts on Instagram share Instagram's
    // rule, and repeating the same line twice would read as two different problems.
    if (seen.has(destination.provider)) continue;
    seen.add(destination.provider);

    const issues = contentMediaIssues(draft, destination.provider);
    if (issues.result.ok) continue;

    const limit = PROVIDER_MEDIA_LIMITS[destination.provider];
    notices.push({
      provider: destination.provider,
      code: issues.result.code,
      offendingMediaIds:
        issues.result.code === "too_many"
          // Everything past the cap. The FIRST `max` items are the ones that fit, so
          // the overflow is what the merchant removes or splits off.
          ? media.slice(limit.max).map(item => item.id)
          : issues.offendingMediaIds,
      limit,
    });
  }

  return notices;
}

/**
 * Every media id any notice points at, deduped — what the strip rings in amber.
 *
 * A single set rather than per-notice highlighting: an image that breaks two
 * platforms' rules is still one image, and two overlapping rings would suggest it is
 * twice as wrong.
 */
export function offendingMediaIds(notices: readonly MediaNotice[]): Set<string> {
  const ids = new Set<string>();
  for (const notice of notices) for (const id of notice.offendingMediaIds) ids.add(id);
  return ids;
}
