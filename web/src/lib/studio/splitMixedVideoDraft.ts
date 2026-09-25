/**
 * splitMixedVideoDraft.ts — shared pure-function layer for the mixed
 * Pinterest+Instagram single-video draft auto-split (T1 of the 2026-09-24
 * design, see docs/coordination/0924-混合视频草稿自动拆分-技术设计-v0.1.md).
 *
 * This module is deliberately import-safe on both client and server (no
 * localStorage, no Node APIs, no network) so the UI schedule-save path, the
 * `/api/pin-drafts` server gate, and the winninghunter operator script can
 * all call the SAME logic (design §2, option (c)). It never touches
 * `pinDraftStore`'s persisted store — callers own reading/writing drafts;
 * this module only computes the two draft shapes.
 *
 * ── Why the IG caption is a parameter, not read off the draft ───────────────
 * There is no per-platform copy field on `PinDraft` today (design §1) — the
 * only description available is the Pinterest one. Threading it in as
 * `opts.instagramCaption` keeps this module from having to grow `PinDraft`
 * (a hot, multi-session conflict file) as part of T1. T2 decides where the
 * caption text actually comes from (UI input box / operator script queue
 * field) and passes it in.
 *
 * ── Determinism / idempotency ────────────────────────────────────────────────
 * The child id is always `${parentId}__ig` (design §2). Splitting is a pure
 * projection: calling this again on a draft that no longer carries an
 * Instagram destination (because a caller already stripped it) returns the
 * draft unchanged, and calling it on a child (`copyProfile === "instagram_caption"`,
 * or an id that already carries the `__ig` suffix) also returns it unchanged
 * — so `a__ig__ig` can never be produced by resplitting a child.
 */

import { resolveScheduledDestinations } from "../social/scheduledDestinations";
import { isSingleVideoPayload } from "../publish/singleVideoPayload";
import type { ContentMedia } from "../contentDraftModel";
import type { PinDraft, DraftStatus, ScheduledDestination } from "../pinDraftStore";
import { EMPTY_TOUCHED, type MetadataTouchedFlags } from "../pinMetadata";
import { sanitizeHandoffField } from "../weeklyPlanHandoff";

/** Suffix that names an Instagram child produced by this module. Exported so
 *  T2's server/script callers can recognize the shape without re-deriving it. */
export const IG_CHILD_ID_SUFFIX = "__ig";

/** The marker fields a split-off Instagram child carries. Kept as an
 *  intersection type rather than new `PinDraft` fields so this module does
 *  not have to touch `pinDraftStore.ts` (T2 lifts these onto the interface
 *  when it wires the Reel publish path to skip the title). */
export type SplitChildMarkers = {
  /** How the Reel publish path should treat this draft's copy (design §3):
   *  present ⇒ do not prepend/attach a separate title, the description IS
   *  the full caption already. */
  copyProfile: "instagram_caption";
  /** The draft this child was split off from. Distinct from `parentDraftId`,
   *  which already means "AI image's source upload" elsewhere in the model. */
  splitFromDraftId: string;
};

/**
 * `copyProfile` is optional here (not on `PinDraft` itself — see
 * `SplitChildMarkers`) purely so this function accepts EITHER a plain
 * `PinDraft` or a draft this module previously produced as a child, and can
 * recognize the latter to stay idempotent (§ idempotency above).
 */
export type SplitMixedVideoDraftInput = PinDraft & { copyProfile?: "instagram_caption" };

export type SplitChildDraft = PinDraft & SplitChildMarkers;

export type SplitMixedVideoDraftResult =
  | { split: false; parent: PinDraft }
  | { split: true; parent: PinDraft; child: SplitChildDraft };

export type SplitMixedVideoDraftOptions = {
  /** The Instagram caption text for the split-off child's `description`.
   *  Validate with `instagramCaptionIssues()` before calling if the caller
   *  needs to block on an empty/linked caption — this function does not
   *  validate or throw, so a bad caption still produces a syntactically
   *  valid (but unpublishable) child. */
  instagramCaption: string;
  /** Injected clock so callers get deterministic, testable output. Also used
   *  as the single instant for the new `capturedAt`/`createdAt`/`updatedAt`
   *  stamps, so repeated calls with the same `now` are byte-for-byte equal. */
  now?: Date;
};

const MAX_TITLE_LENGTH = 100; // same cap AI Copy v2 enforces (validateCopy.ts:349)

/**
 * The SAME test the cron uses to gate the video path — imported from the shared
 * module (lib/publish/singleVideoPayload.ts), never re-implemented, so "the
 * splitter thinks it must split" and "the cron thinks it is a single video" can
 * never disagree.
 */
function isSingleVideoDraft(draft: Pick<PinDraft, "media">): boolean {
  return isSingleVideoPayload(draft);
}

/**
 * THE "this needs splitting" predicate: exactly one video (shared cron test) AND
 * the explicit stored destinations (the cron's read rule) name BOTH Pinterest and
 * Instagram. Used by `splitMixedVideoDraft` below and by the `/api/pin-drafts`
 * server gate, so "the splitter would split this" and "the server refuses this
 * unsplit" are one decision. Deliberately NOT gated on "is a child": a child that
 * somehow carries both platforms is exactly as unpublishable as an unsplit parent.
 */
export function isMixedSingleVideo(
  draft: Parameters<typeof resolveScheduledDestinations>[0] & { media?: unknown },
): boolean {
  if (!isSingleVideoDraft(draft as Pick<PinDraft, "media">)) return false;
  const destinations = resolveScheduledDestinations(draft);
  return destinations.some(d => d.provider === "pinterest")
    && destinations.some(d => d.provider === "instagram");
}

/** True when `id` or the marker says this draft is a split-off Instagram child —
 *  the server uses it only to TIGHTEN (run the caption check), never to grant. */
export function isInstagramCaptionChild(draftId: string, payload: { copyProfile?: unknown }): boolean {
  return payload.copyProfile === "instagram_caption" || parentIdOf(draftId) !== null;
}

export type MixedVideoScheduleIssueCode = "mixed_video_requires_split" | InstagramCaptionIssueCode;

const SYNC_ISSUE_KEY: Record<MixedVideoScheduleIssueCode, string> = {
  mixed_video_requires_split: "studioBoard.card.syncIssue.mixedVideoRequiresSplit",
  instagram_caption_required: "studioBoard.card.syncIssue.instagramCaptionRequired",
  instagram_caption_contains_link: "studioBoard.card.syncIssue.instagramCaptionContainsLink",
};

/**
 * The `/api/pin-drafts` gate for a SCHEDULED draft (design §2 (b′) + §3, Fable
 * ruling 4). Callers only invoke it for a draft that carries a schedule — an
 * unscheduled draft is still being edited and is never refused here.
 *   - unsplit mixed single video            → `mixed_video_requires_split`
 *   - Instagram child with a bad caption    → first `instagramCaptionIssues` code
 * Null when the draft may be scheduled.
 */
export function mixedVideoScheduleIssue(
  draftId: string,
  payload: Record<string, unknown>,
): { code: MixedVideoScheduleIssueCode; userMessageKey: string } | null {
  const draft = payload as Parameters<typeof isMixedSingleVideo>[0];
  if (isMixedSingleVideo(draft)) {
    return { code: "mixed_video_requires_split", userMessageKey: SYNC_ISSUE_KEY.mixed_video_requires_split };
  }
  if (isInstagramCaptionChild(draftId, payload)) {
    const description = typeof payload.description === "string" ? payload.description : "";
    const [issue] = instagramCaptionIssues(description);
    if (issue) return { code: issue, userMessageKey: SYNC_ISSUE_KEY[issue] };
  }
  return null;
}

/** True for a draft this module has already produced as a child — either by
 *  its marker or (defensively, for a marker that got stripped somewhere) by
 *  its id shape. Prevents re-splitting a child into `id__ig__ig`. */
function isAlreadyChild(draft: Pick<PinDraft, "id"> & { copyProfile?: string }): boolean {
  if (draft.copyProfile === "instagram_caption") return true;
  return parentIdOf(draft.id) !== null;
}

/**
 * Strict inverse of the child-id rule: only a real `${x}__ig` where `x` is
 * non-empty and does not itself end in `__ig` (which would mean `id` was
 * already a child id with a second suffix appended — never a legitimate
 * parent). Case-sensitive, no trimming — a stray space or wrong case is not
 * a match, it is a different (and invalid) id.
 */
export function parentIdOf(childId: unknown): string | null {
  if (typeof childId !== "string") return null;
  if (!childId.endsWith(IG_CHILD_ID_SUFFIX)) return null;
  const prefix = childId.slice(0, -IG_CHILD_ID_SUFFIX.length);
  if (!prefix) return null;
  if (prefix.endsWith(IG_CHILD_ID_SUFFIX)) return null;
  return prefix;
}

/** First non-blank line of `caption`, trimmed, capped at 100 chars — Fable
 *  ruling 2 (2026-09-24): the child's `title` is derived from the caption so
 *  `recomputeDraftStatus` sees a non-empty title and the Reel receipt never
 *  falls back to "Untitled content" (publishConfirmation.ts:309). A literal
 *  first line (not "first NON-BLANK line") would make a caption that opens
 *  with a blank line yield an empty title again, defeating the ruling. */
export function titleFromCaption(caption: string): string {
  const lines = caption.split(/\r?\n/);
  const firstNonBlank = lines.find(line => line.trim().length > 0) ?? "";
  const trimmed = firstNonBlank.trim();
  return trimmed.length > MAX_TITLE_LENGTH ? trimmed.slice(0, MAX_TITLE_LENGTH) : trimmed;
}

/** Same three-check rule `recomputeDraftStatus` (pinDraftStore.ts:669) uses
 *  for title/description/date — duplicated here (not imported) to keep this
 *  module free of any pinDraftStore runtime dependency; it only needs the
 *  type. Sanitization matches `sanitizeHandoffField` exactly. */
function computeStatus(draft: Pick<PinDraft, "title" | "description" | "scheduledDate">): DraftStatus {
  const hasTitle = !!sanitizeHandoffField(draft.title);
  const hasDesc = !!sanitizeHandoffField(draft.description);
  const hasDate = !!sanitizeHandoffField(draft.scheduledDate);
  return hasTitle && hasDesc && hasDate ? "ready" : "needs_review";
}

function cloneMedia(media: ContentMedia[]): ContentMedia[] {
  // Same filter the shared single-video test applies before counting: a stray
  // non-object entry does not make the draft "not a single video", so it must not
  // be copied onto the child either.
  return media
    .filter((item): item is ContentMedia => !!item && typeof item === "object")
    .map(item => ({ ...item }));
}

const TOUCHED_FOR_OPERATOR_COPY: MetadataTouchedFlags = {
  ...EMPTY_TOUCHED,
  // The caption is merchant/operator-authored, never AI-generated (design §5
  // "touched"): both fields must read as touched so the confirmation list's
  // "AI unedited" hint never fires on a child (pinConfirmList.ts:43-51 also
  // independently requires `metadataDraft.copyGenerationMeta` to be set,
  // which the child never has — this is belt-and-suspenders).
  titleTouched: true,
  descriptionTouched: true,
};

/**
 * Split a draft that mixes a single video across Pinterest + Instagram into
 * a Pinterest-only parent and an Instagram-only child, or return it
 * unchanged when no split applies.
 *
 * No-op (returns `{ split: false, parent: draft }` with `parent === draft`,
 * same reference) when:
 *   - the draft is already a split child (marker or `__ig`-shaped id);
 *   - the media is not exactly one video (§3 trigger, cron-equivalent check);
 *   - the resolved destinations do not include BOTH pinterest and instagram.
 *
 * Field inheritance follows design §3 exactly: media/poster/schedule/IG
 * destinations are copied; board, destination link, target connection, and
 * every publish-result/intent field are left off the child entirely (never
 * spread from the parent) so a stale result cannot leak onto the new Content.
 */
export function splitMixedVideoDraft(
  draft: SplitMixedVideoDraftInput,
  opts: SplitMixedVideoDraftOptions,
): SplitMixedVideoDraftResult {
  if (isAlreadyChild(draft)) return { split: false, parent: draft };
  if (!isMixedSingleVideo(draft)) return { split: false, parent: draft };

  const destinations = resolveScheduledDestinations(draft);
  const igDestinations = destinations.filter(d => d.provider === "instagram");
  const nonIgDestinations = destinations.filter(d => d.provider !== "instagram");

  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const capturedDestinations: ScheduledDestination[] = igDestinations.map(d => ({ ...d, capturedAt: nowIso }));

  const parent: PinDraft = {
    ...draft,
    scheduledDestinations: nonIgDestinations,
  };
  parent.status = computeStatus(parent);
  parent.planningStatus = parent.status === "ready" ? "ready" : "needs_review";
  parent.updatedAt = nowIso;

  const media = cloneMedia(Array.isArray(draft.media) ? draft.media : []);
  const childId = `${draft.id}${IG_CHILD_ID_SUFFIX}`;
  const title = titleFromCaption(opts.instagramCaption);
  const description = opts.instagramCaption;

  const child: SplitChildDraft = {
    id: childId,
    contentId: childId,
    imageUrl: draft.imageUrl,
    media,
    coverMediaId: draft.coverMediaId,
    keyword: draft.keyword,
    category: draft.category,
    title,
    description,
    altText: draft.altText,
    destinationUrl: "",
    boardId: "",
    boardName: "",
    weeklyPlanItemId: "",
    generationSessionId: "",
    scheduledDate: draft.scheduledDate,
    scheduledTime: draft.scheduledTime,
    plannedAt: draft.plannedAt,
    scheduleTimezone: draft.scheduleTimezone,
    scheduleSource: draft.scheduleSource,
    scheduleLocked: draft.scheduleLocked,
    autoScheduled: draft.autoScheduled,
    source: draft.source,
    status: "needs_review",
    createdAt: nowIso,
    updatedAt: nowIso,
    scheduledDestinations: capturedDestinations,
    metadataTouched: TOUCHED_FOR_OPERATOR_COPY,
    copyProfile: "instagram_caption",
    splitFromDraftId: draft.id,
  };
  child.status = computeStatus(child);
  child.planningStatus = child.status === "ready" ? "ready" : "needs_review";

  return { split: true, parent, child };
}

// ── IG caption validation ────────────────────────────────────────────────────

export type InstagramCaptionIssueCode =
  | "instagram_caption_required"
  | "instagram_caption_contains_link";

/**
 * Common top-level domains recognized by the bare-domain check below. Not
 * exhaustive by design (design §3 flags the 2200-char cap as unverified and
 * out of scope here too) — this is a deterministic trap for the realistic
 * cases (design says today's descriptions carry real merchant links), not a
 * full public-suffix-list implementation. Extend if a real caption slips
 * through with an unlisted TLD.
 */
const BARE_DOMAIN_TLDS = [
  "com", "co", "net", "org", "io", "app", "shop", "store", "me", "us", "uk",
  "de", "ca", "au", "info", "biz", "xyz", "co\\.uk", "com\\.au",
];

const BARE_DOMAIN_RE = new RegExp(
  `\\b(?:[a-z0-9-]+\\.)+(?:${BARE_DOMAIN_TLDS.join("|")})\\b`,
  "i",
);

const PROTOCOL_LINK_RE = /https?:\/\//i;
const WWW_LINK_RE = /\bwww\./i;

/**
 * Validate an Instagram caption per design §3: empty is rejected outright
 * (v0.1 does not auto-generate one), and any link — protocol URL, `www.`
 * prefix, or bare domain like `cheerish.co` — is rejected because design §1
 * confirms a merchant's link written into the Pinterest description today
 * flows straight into the IG caption unchanged; this function is the shared
 * gate the UI, the `/api/pin-drafts` server guard, and the operator script
 * all call so a link cannot slip through any one of the three paths.
 *
 * Returns every matching issue (not just the first) so a caller can render
 * every complaint at once; empty array means the caption is acceptable.
 */
export function instagramCaptionIssues(caption: string | null | undefined): InstagramCaptionIssueCode[] {
  const value = (caption ?? "").trim();
  if (!value) return ["instagram_caption_required"];

  const issues: InstagramCaptionIssueCode[] = [];
  if (PROTOCOL_LINK_RE.test(value) || WWW_LINK_RE.test(value) || BARE_DOMAIN_RE.test(value)) {
    issues.push("instagram_caption_contains_link");
  }
  return issues;
}
