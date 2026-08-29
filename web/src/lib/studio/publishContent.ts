/**
 * publishContent — THE client-side publish. One function, every surface.
 *
 * Before this, four surfaces published four different ways: the Create Pins card ran
 * an inline loop, BatchEditDrawer called `publishPin` directly (Pinterest only) and
 * StudioBoard then FABRICATED a Pinterest-shaped success row for it, and the Plan
 * drawer had its own Pinterest call plus two `publishToSocial` calls. So the same Pin
 * published from two places produced different records, and the batch path wrote a
 * "published" row for a destination nothing had checked. Convergence is the point:
 * every immediate publish now produces the same per-destination records the cron
 * worker produces for a scheduled one.
 *
 * The contract:
 *   - INTENT comes from `contentDestinations()` → `scheduledDestinations[]`, the same
 *     record the due-time worker reads. It fails CLOSED: no resolvable destination
 *     means nothing is sent, not "default to Pinterest".
 *   - Each destination is media-checked on its own (PRD §29). A set Pinterest refuses
 *     (6 images) but Instagram accepts must still publish to Instagram — a per-platform
 *     rule may not become a whole-Content block.
 *   - Every destination gets a durable row (`destinationResults[]`), and the legacy
 *     fields are derived from those rows in ONE place, so Plan/admin/the error banner
 *     can never disagree with what the card shows.
 *   - `onlyPending` skips destinations already `published` — Retry re-sends only what
 *     failed, so retrying a partial success cannot double-post (PRD §29).
 */

import * as pinDraftStore from "../pinDraftStore";
import type { PinDraft } from "../pinDraftStore";
import {
  contentDestinations,
  contentDestinationResults,
  contentMedia,
  destinationKey,
  findDestinationResult,
  legacyFieldsFromResults,
  supersededResults,
  type ContentDraftLike,
  type DestinationPublishResult,
  type PublishDestination,
} from "../contentDraftModel";
import {
  checkPinterestMedia,
  checkInstagramMedia,
  checkFacebookMedia,
  type MediaCheckFailureCode,
  type MediaCheckResult,
  type PublishMediaItem,
} from "../publish/mediaRules";
import { publishPin, type AttachedProduct, type PinterestClientError } from "../pinterestClient";
import { publishToSocial, SocialApiError } from "../social/socialClient";
import { beginPublish, endPublish, mapPublishErrorToCategory } from "./pinLifecycle";

export type PublishContentOptions = {
  /**
   * Skip destinations whose stored result is already `published` — Retry semantics.
   *
   * With NO pending destination left, this returns `nothingToRetry` without calling a
   * single platform API. It used to fall back to re-attempting every destination, which
   * turned "Retry" on a fully published Content into a silent duplicate post — exactly
   * what onlyPending exists to prevent (PRD §26/§29). A caller that means "send this
   * again" says so explicitly with `onlyPending: false`.
   */
  onlyPending?: boolean;
  /**
   * Publish to THESE destinations instead of the ones the draft's stored intent names.
   *
   * "Publish now" from the Plan drawer has no stored intent to read: the drawer only
   * freezes `scheduledDestinations` for a Content that has a DATE ("Publish now needs
   * no stored intent"), so an undated Content would resolve to nothing and — because
   * this function fails closed — publish nowhere. The drawer's live checkbox state IS
   * the intent for that click, so it passes it in. Empty/omitted keeps the stored
   * intent, which is what every scheduled path wants.
   */
  destinations?: readonly PublishDestination[];
  /**
   * Fields carried by ONE surface's publish that are not part of the Content itself.
   * Threaded straight through to the underlying call, unchanged.
   */
  extras?: {
    /**
     * Products to attach to the Pin (Pinterest only). Not read from the draft: the
     * drawer sends the products as they are on screen, which may be ahead of what the
     * debounced autosave has flushed.
     */
    attachedProducts?: AttachedProduct[];
    primaryProductUrl?: string;
    productAttachmentMode?: "vibepin_metadata_v1";
  };
  /** Injected in tests. Production callers never pass these. */
  deps?: Partial<PublishContentDeps>;
};

export type PublishContentDeps = {
  publishPin: typeof publishPin;
  publishToSocial: typeof publishToSocial;
  now: () => string;
};

export type PublishContentOutcome = {
  published: DestinationPublishResult[];
  failed: DestinationPublishResult[];
  /** All rows for this Content after the attempt (untouched rows included). */
  results: DestinationPublishResult[];
  /**
   * Why nothing was attempted, when nothing was. `locked` = another surface is already
   * publishing this Content (the shared in-flight lock); `no_destinations` = the
   * Content names no resolvable destination; `not_found` = no such draft.
   */
  blocked?: "locked" | "no_destinations" | "not_found";
  /**
   * A Retry (`onlyPending: true`) found every destination already published, so nothing
   * was sent. NOT a `blocked` value: every caller treats a non-locked `blocked` as a
   * publish error, and "it is already published everywhere" is a neutral outcome, not a
   * failure. Nothing was written — the stored rows in `results` are the prior ones.
   */
  nothingToRetry?: boolean;
  /**
   * The Pinterest connection this Content actually published through, when it had
   * none and the server resolved one (adopt-once, PRD §14). The caller writes it to
   * its own account state; the draft has already been patched here.
   */
  adoptedConnectionId?: string;
  /**
   * Pinterest refused because the app is still on Trial/Standard-access review.
   *
   * NOT a publish failure: the Content is publishable, just not until Pinterest grants
   * access, and the product promise is "save it and publish once approved". So it keeps
   * its schedule and is never marked failed — see the catch below, which suppresses the
   * failed row for this code alone. Surfaced here so the caller can show its notice.
   */
  trialAccess?: boolean;
  /**
   * The raw errors the platforms threw, in attempt order. The stored rows keep only a
   * user-facing code/message; a caller that must DECIDE something from a failure (does
   * this mean "reconnect Pinterest"? `needsReconnect` is not a message) needs the
   * original. Never rendered — the durable rows are what the merchant sees.
   */
  errors?: Array<{ provider: string; error: unknown }>;
};

const defaultDeps: PublishContentDeps = {
  publishPin,
  publishToSocial,
  now: () => new Date().toISOString(),
};

/** The platform rule for one provider. Unknown providers are not blocked here. */
export function checkMediaForProvider(
  provider: string,
  media: readonly PublishMediaItem[],
): MediaCheckResult {
  if (provider === "pinterest") return checkPinterestMedia(media);
  if (provider === "instagram") return checkInstagramMedia(media);
  if (provider === "facebook") return checkFacebookMedia(media);
  return { ok: true };
}

/**
 * WHICH board a Pinterest destination publishes to.
 *
 * Its own board wins. The draft-level `boardId` is a fallback ONLY for the entry that
 * IS the draft's legacy Pinterest target (or for a legacy destination naming no account
 * at all) — with several Pinterest accounts it describes the FIRST one, so falling back
 * to it for a second account would publish that account's Pin into a board id that
 * belongs to another account: either a hard "board not owned" failure or, worse, a Pin
 * silently landing on the wrong board.
 */
export function boardForDestination(
  destination: Pick<PublishDestination, "socialConnectionId" | "boardId">,
  draft: Pick<ContentDraftLike, "boardId" | "targetConnectionId">,
): string | undefined {
  const own = destination.boardId?.trim();
  if (own) return own;
  const target = draft.targetConnectionId?.trim();
  const id = destination.socialConnectionId?.trim();
  if (!id || (target && id === target)) return draft.boardId;
  return undefined;
}

/**
 * Why a destination will be refused before any network call is made.
 *
 * `code` is the contract; `message` is only the English fallback for a surface with no
 * translation for that code. A bulk confirm sheet has to tell the merchant WHY each
 * item cannot publish BEFORE anything is sent — deriving that by trial-publishing
 * would post the ones that are fine and only then report on the ones that are not.
 */
export type PublishBlockerCode =
  | "no_destinations"
  | "missing_board"
  | "no_account"
  | MediaCheckFailureCode;

export type PublishBlocker = {
  code: PublishBlockerCode;
  /** Absent only for `no_destinations`, which is a whole-Content condition. */
  provider?: PublishDestination["provider"];
  destinationId?: string;
  accountLabel?: string;
  message: string;
};

/**
 * The pre-dispatch refusals `publishContent` would produce for this Content, without
 * publishing anything.
 *
 * It MUST mirror the checks inside publishContent (media rule → missing board →
 * missing account), because a sheet that predicts a different set than the publish
 * actually enforces is worse than no sheet: it promises a publish that then fails, or
 * warns about one that would have worked. Both branches read the same helpers.
 *
 * A destination NOT listed here is dispatchable. Per PRD §29 a Content with one bad
 * destination and one good one still publishes the good one — so callers must treat
 * "some blockers" as partial, not as a whole-Content block.
 */
export function explainPublishBlockers(draft: ContentDraftLike): PublishBlocker[] {
  const destinations = contentDestinations(draft);
  if (!destinations.length) {
    return [{
      code: "no_destinations",
      message: "Choose where to publish before publishing.",
    }];
  }
  const media = contentMedia(draft).map(item => ({ url: item.url, width: item.width, height: item.height }));
  const blockers: PublishBlocker[] = [];
  for (const destination of destinations) {
    const check = checkMediaForProvider(destination.provider, media);
    if (!check.ok) {
      blockers.push({
        code: check.code,
        provider: destination.provider,
        destinationId: destination.id,
        accountLabel: destination.accountLabel,
        message: check.message,
      });
      continue;
    }
    if (destination.provider === "pinterest") {
      // Same fallback publishContent uses: the destination's own board, and the
      // draft-level board ONLY for the entry that is the draft's legacy target.
      if (!boardForDestination(destination, draft)?.trim()) {
        blockers.push({
          code: "missing_board",
          provider: "pinterest",
          destinationId: destination.id,
          accountLabel: destination.accountLabel,
          message: "Choose a Pinterest board before publishing.",
        });
      }
      continue;
    }
    if (!destination.socialConnectionId) {
      blockers.push({
        code: "no_account",
        provider: destination.provider,
        destinationId: destination.id,
        message: `Choose which ${destination.provider} account to publish as.`,
      });
    }
  }
  return blockers;
}

/** A row describing a destination that was refused before any network call. */
function refusedRow(
  destination: PublishDestination,
  code: string,
  message: string,
  submittedAt: string,
): DestinationPublishResult {
  return {
    destinationId: destination.id,
    provider: destination.provider,
    socialConnectionId: destination.socialConnectionId,
    accountLabel: destination.accountLabel,
    boardId: destination.boardId,
    boardName: destination.boardName,
    status: "failed",
    submittedAt,
    errorCode: code,
    errorMessage: message,
  };
}

function baseRow(
  destination: PublishDestination,
  status: DestinationPublishResult["status"],
  submittedAt: string,
): DestinationPublishResult {
  return {
    destinationId: destination.id,
    provider: destination.provider,
    socialConnectionId: destination.socialConnectionId,
    accountLabel: destination.accountLabel,
    boardId: destination.boardId,
    boardName: destination.boardName,
    status,
    submittedAt,
  };
}

/** Merge a fresh attempt's rows over the prior set, keyed by destination. */
function mergeResults(
  prior: readonly DestinationPublishResult[],
  fresh: readonly DestinationPublishResult[],
): DestinationPublishResult[] {
  const byKey = new Map(fresh.map(r => [r.destinationId, r]));
  const kept = prior.filter(r => !byKey.has(r.destinationId));
  return [...kept, ...fresh];
}

/**
 * Publish one Content to every destination its intent names.
 *
 * Never throws for a publish failure: a platform that refuses is a `failed` row, not
 * an exception — one dead destination must not abandon the others, and the merchant
 * needs the reason recorded, not thrown away.
 */
export async function publishContent(
  draftId: string,
  options: PublishContentOptions = {},
): Promise<PublishContentOutcome> {
  const deps: PublishContentDeps = { ...defaultDeps, ...options.deps };
  const draft = pinDraftStore.getDraft(draftId);
  if (!draft) return { published: [], failed: [], results: [], blocked: "not_found" };

  // An explicit destination list is this click's intent; otherwise read the Content's.
  const destinations = options.destinations?.length
    ? [...options.destinations]
    : contentDestinations(draft);
  const priorResults = contentDestinationResults(draft);
  if (!destinations.length) {
    return { published: [], failed: [], results: priorResults, blocked: "no_destinations" };
  }

  // Retry targets what has not published yet — and ONLY that.
  //
  // The removed fallback ("nothing pending ⇒ re-attempt everything") made Retry on a
  // fully published Content re-post to every destination, which is the duplicate-post
  // defect onlyPending exists to prevent. A surface that means "send this again" now
  // has to say `onlyPending: false`; a Retry with nothing pending does nothing at all,
  // before the lock and before any store write, and reports it neutrally.
  const targets = options.onlyPending
    ? destinations.filter(d => findDestinationResult(priorResults, d)?.status !== "published")
    : destinations;
  if (!targets.length) {
    return { published: [], failed: [], results: priorResults, nothingToRetry: true };
  }

  // The shared in-flight lock lives HERE, not in the callers: with each surface taking
  // it before calling in, the second acquire would fail and every publish would report
  // "already publishing" against itself.
  if (!beginPublish(draftId)) {
    return { published: [], failed: [], results: priorResults, blocked: "locked" };
  }

  try {
    const submittedAt = deps.now();
    const media = contentMedia(draft).map(item => ({ url: item.url, width: item.width, height: item.height }));

    // Per-destination pre-check. A destination refused by its platform's rule is
    // recorded failed and dropped from the dispatch; the others proceed.
    const refused: DestinationPublishResult[] = [];
    const dispatch: PublishDestination[] = [];
    for (const destination of targets) {
      const check = checkMediaForProvider(destination.provider, media);
      if (check.ok) dispatch.push(destination);
      else refused.push(refusedRow(destination, check.code, check.message, submittedAt));
    }

    // Mark what we are about to attempt as publishing, with its submitted time, before
    // any network call — a crash mid-publish then reads as an interrupted attempt
    // rather than as a Content that was never submitted.
    pinDraftStore.updateDraft(draftId, {
      publishError: undefined,
      destinationResults: mergeResults(priorResults, [
        ...refused,
        ...dispatch.map(d => baseRow(d, "publishing", submittedAt)),
      ]),
    });

    const outcomes: DestinationPublishResult[] = [...refused];
    let adoptedConnectionId: string | undefined;
    let trialAccess = false;
    const errors: Array<{ provider: string; error: unknown }> = [];
    // Server-minted immediate-publish bucket (meterScheduledPost.ts), relayed from
    // whichever pinterest call answers first — success or typed failure both carry it.
    // Relayed on to the social call below so the two requests for this SAME Content
    // bucket identically even if they straddle a UTC midnight. Stays undefined for a
    // social-only publish (no pinterest destination ever ran), which is fine: the
    // social route just derives its own bucket, exactly as before this relay existed.
    let meteringBucket: string | undefined;
    let meteringBucketSig: string | undefined;
    let meteringBucketMintedAt: number | undefined;

    const pinterestTargets = dispatch.filter(d => d.provider === "pinterest");
    const socialTargets = dispatch.filter(d => d.provider !== "pinterest");

    for (const destination of pinterestTargets) {
      const boardId = boardForDestination(destination, draft);
      if (!boardId?.trim()) {
        outcomes.push(refusedRow(destination, "missing_board", "Choose a Pinterest board before publishing.", submittedAt));
        continue;
      }
      try {
        const res = await deps.publishPin({
          boardId,
          // The single-image contract stays satisfied (cover first) while imageUrls
          // carries the whole carousel in the merchant's display order.
          imageUrl: media[0]?.url ?? draft.imageUrl,
          imageUrls: media.map(m => m.url),
          title: draft.title || undefined,
          description: draft.description || undefined,
          link: draft.destinationUrl || undefined,
          altText: draft.altText || undefined,
          sourcePinId: draftId,
          draftId,
          source: "immediate",
          // Publish AS the account this destination names. Null only for a legacy
          // draft; the server then resolves the default and reports it back below.
          connectionId: destination.socialConnectionId ?? undefined,
          // Surface-specific extras (product attachment), passed through untouched.
          ...(options.extras?.attachedProducts?.length
            ? { attachedProducts: options.extras.attachedProducts }
            : {}),
          ...(options.extras?.primaryProductUrl ? { primaryProductUrl: options.extras.primaryProductUrl } : {}),
          ...(options.extras?.productAttachmentMode ? { productAttachmentMode: options.extras.productAttachmentMode } : {}),
        });
        // Adopt-once (PRD §14): an untargeted draft keeps the connection it really
        // published through, so every later retry/action stays on that account.
        if (!destination.socialConnectionId && res.connectionId) adoptedConnectionId = res.connectionId;
        // First pinterest call to answer wins the bucket — later calls (a second
        // pinterest destination, rare) never overwrite it.
        if (!meteringBucket && res.meteringBucket) meteringBucket = res.meteringBucket;
        if (!meteringBucketSig && res.meteringBucketSig) meteringBucketSig = res.meteringBucketSig;
        if (!meteringBucketMintedAt && res.meteringBucketMintedAt) meteringBucketMintedAt = res.meteringBucketMintedAt;
        outcomes.push({
          ...baseRow(destination, "published", submittedAt),
          // A legacy destination's row now names the account that actually received it.
          socialConnectionId: destination.socialConnectionId ?? res.connectionId ?? null,
          destinationId: destination.socialConnectionId
            ? destination.id
            : destinationKey("pinterest", res.connectionId ?? null),
          remoteId: res.pin.id,
          postUrl: res.pin.url,
          publishedAt: deps.now(),
        });
      } catch (error) {
        const err = error as PinterestClientError;
        errors.push({ provider: destination.provider, error });
        // A typed pinterest failure still relays the bucket it metered under (see
        // /api/pinterest/pins) — this Content may still proceed to its social
        // destinations below, and that call must bucket identically.
        // Residual: a lost Pinterest response that also straddles UTC midnight can bucket
        // differently; accepted until the publish-action identity (PRD v3.2 §21 5A / design
        // doc §A) replaces the date bucket. A transport failure (no HTTP response reached
        // this client at all — err.meteringBucket stays undefined) falls through exactly
        // that way: this Content proceeds to social below with no bucket to relay, and the
        // social route derives its own date, same as a social-only publish always has.
        if (!meteringBucket && err?.meteringBucket) meteringBucket = err.meteringBucket;
        if (!meteringBucketSig && err?.meteringBucketSig) meteringBucketSig = err.meteringBucketSig;
        if (!meteringBucketMintedAt && err?.meteringBucketMintedAt) meteringBucketMintedAt = err.meteringBucketMintedAt;
        // Trial/Standard-access is a "not yet", not a failure. Recording a failed row
        // would flow through legacyFieldsFromResults into failureType "publish" and
        // RELEASE the Content's schedule — the Pin would silently leave its slot for a
        // block that resolves on Pinterest's side without the merchant doing anything.
        // The destination is left as it was, and the caller shows the access notice.
        if (err?.code === "pinterest_trial_access") {
          trialAccess = true;
          outcomes.push({
            ...baseRow(destination, "pending", submittedAt),
            submittedAt: undefined,
          });
          continue;
        }
        outcomes.push({
          ...baseRow(destination, "failed", submittedAt),
          errorCode: err?.code,
          errorMessage: err?.message || "Publishing failed.",
        });
      }
    }

    if (socialTargets.length) {
      try {
        const social = await deps.publishToSocial({
          postId: draftId,
          post: {
            imageUrls: media.map(m => m.url),
            title: draft.title || undefined,
            caption: draft.description || undefined,
            destinationUrl: draft.destinationUrl || undefined,
            altText: draft.altText || undefined,
          },
          // Never send a destination without an account: the server would have to guess
          // which connection the merchant meant, which is the wrong-account defect.
          destinations: socialTargets
            .filter(d => !!d.socialConnectionId)
            .map(d => ({ provider: d.provider, socialConnectionId: d.socialConnectionId as string })),
          // Relay the bucket a pinterest call in THIS SAME publish already metered
          // under, so this request buckets identically instead of computing its own
          // (see meterScheduledPost.ts's module header). Omitted entirely for a
          // social-only publish — no pinterest call ran, so there is nothing to relay.
          ...(meteringBucket ? { meteringBucket } : {}),
          ...(meteringBucketSig ? { meteringBucketSig } : {}),
          ...(meteringBucketMintedAt ? { meteringBucketMintedAt } : {}),
        });
        // The response is provider-ordered; match each result back to the destination it
        // came from so two accounts on one platform stay distinguishable.
        const queues = new Map<string, PublishDestination[]>();
        for (const d of socialTargets) {
          if (!d.socialConnectionId) {
            outcomes.push(refusedRow(d, "no_account", `Choose which ${d.provider} account to publish as.`, submittedAt));
            continue;
          }
          queues.set(d.provider, [...(queues.get(d.provider) ?? []), d]);
        }
        for (const result of social.destinations) {
          const destination = queues.get(result.provider)?.shift();
          if (!destination) continue;
          if (result.status === "skipped") {
            // Skipped is not attempted: leave the destination as it was rather than
            // recording an outcome that never happened.
            outcomes.push({ ...baseRow(destination, "pending", submittedAt), submittedAt: undefined });
            continue;
          }
          outcomes.push({
            ...baseRow(destination, result.status === "published" ? "published" : "failed", submittedAt),
            accountLabel: result.accountName ?? destination.accountLabel,
            remoteId: result.externalPostId ?? undefined,
            postUrl: result.externalPostUrl ?? undefined,
            publishedAt: result.status === "published" ? deps.now() : undefined,
            errorMessage: result.status === "published" ? undefined : (result.error ?? "Publishing failed."),
          });
        }
        // A destination the response never mentioned did not publish — recording it as
        // anything else would be the "UI says published, platform never got it" defect.
        for (const leftovers of queues.values()) {
          for (const destination of leftovers) {
            outcomes.push({
              ...baseRow(destination, "failed", submittedAt),
              errorMessage: "The platform returned no result for this account.",
            });
          }
        }
      } catch (error) {
        const message = (error as Error)?.message || "Publishing failed.";
        // A SocialApiError (e.g. a 402 scheduled_post_limit_reached refusal) carries the
        // server's machine-readable code; anything else (network failure, generic 5xx)
        // has none, and this stays undefined exactly as it did before — the message is
        // still shown, StudioBoard's limit UI just does not fire for it.
        const errorCode = error instanceof SocialApiError ? error.code : undefined;
        errors.push({ provider: "social", error });
        for (const destination of socialTargets) {
          outcomes.push({ ...baseRow(destination, "failed", submittedAt), errorCode, errorMessage: message });
        }
      }
    }

    const results = mergeResults(priorResults, outcomes);
    // A row that WAS published and is being replaced by this attempt describes a post
    // that is still live on the platform. Keep it (with its permalink) as history — the
    // Posted card shows it under "Earlier publishes" instead of losing it silently.
    const previousResults = supersededResults(priorResults, outcomes, draft.previousResults ?? []);
    const published = results.filter(r => r.status === "published");
    const failed = results.filter(r => r.status === "failed");
    const legacy = legacyFieldsFromResults(results, draft);
    const firstFailure = outcomes.find(r => r.status === "failed");
    // A publish that delivered nothing releases its schedule (WP-B §11.5) and keeps the
    // time it HAD, so a reschedule can offer it back. A partial success stays posted.
    const localPlanned = draft.plannedAt || draft.scheduledDate;
    const prevScheduled = localPlanned
      ? new Date(`${localPlanned.slice(0, 10)}T${(draft.scheduledTime?.trim() || localPlanned.slice(11, 16) || "09:00")}:00`).toISOString()
      : undefined;
    const totalFailure = !!firstFailure && published.length === 0;

    pinDraftStore.updateDraft(draftId, {
      destinationResults: results,
      ...(previousResults.length ? { previousResults } : {}),
      socialPosts: legacy.socialPosts,
      postedAt: legacy.postedAt,
      remotePinId: legacy.remotePinId,
      remotePinUrl: legacy.remotePinUrl,
      publishError: legacy.publishError,
      failureType: legacy.publishError ? "publish" : undefined,
      errorCategory: legacy.publishError ? mapPublishErrorToCategory(legacy.publishErrorCode, legacy.publishError) : undefined,
      publishErrorCode: legacy.publishErrorCode,
      previousScheduledTime: totalFailure ? prevScheduled : draft.previousScheduledTime,
      scheduledDate: totalFailure ? "" : draft.scheduledDate,
      scheduledTime: totalFailure ? "" : draft.scheduledTime,
      ...(adoptedConnectionId ? { targetConnectionId: adoptedConnectionId } : {}),
    } as Partial<PinDraft>);

    return {
      published,
      failed,
      results,
      ...(adoptedConnectionId ? { adoptedConnectionId } : {}),
      ...(trialAccess ? { trialAccess: true } : {}),
      ...(errors.length ? { errors } : {}),
    };
  } finally {
    endPublish(draftId);
  }
}
