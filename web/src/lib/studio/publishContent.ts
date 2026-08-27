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
  type DestinationPublishResult,
  type PublishDestination,
} from "../contentDraftModel";
import {
  checkPinterestMedia,
  checkInstagramMedia,
  checkFacebookMedia,
  type MediaCheckResult,
  type PublishMediaItem,
} from "../publish/mediaRules";
import { publishPin } from "../pinterestClient";
import { publishToSocial } from "../social/socialClient";
import { beginPublish, endPublish, mapPublishErrorToCategory } from "./pinLifecycle";

export type PublishContentOptions = {
  /**
   * Skip destinations whose stored result is already `published` — Retry semantics.
   * With no pending destination left, every destination is re-attempted (an explicit
   * "publish again" on a fully published Content).
   */
  onlyPending?: boolean;
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

  const destinations = contentDestinations(draft);
  const priorResults = contentDestinationResults(draft);
  if (!destinations.length) {
    return { published: [], failed: [], results: priorResults, blocked: "no_destinations" };
  }

  // Retry targets what has not published yet. When everything already published, an
  // explicit publish re-attempts the whole set rather than silently doing nothing.
  const pending = options.onlyPending
    ? destinations.filter(d => findDestinationResult(priorResults, d)?.status !== "published")
    : destinations;
  const targets = pending.length ? pending : destinations;

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

    const pinterestTargets = dispatch.filter(d => d.provider === "pinterest");
    const socialTargets = dispatch.filter(d => d.provider !== "pinterest");

    for (const destination of pinterestTargets) {
      const boardId = destination.boardId || draft.boardId;
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
        });
        // Adopt-once (PRD §14): an untargeted draft keeps the connection it really
        // published through, so every later retry/action stays on that account.
        if (!destination.socialConnectionId && res.connectionId) adoptedConnectionId = res.connectionId;
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
        const err = error as { code?: string; message?: string };
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
        for (const destination of socialTargets) {
          outcomes.push({ ...baseRow(destination, "failed", submittedAt), errorMessage: message });
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

    return { published, failed, results };
  } finally {
    endPublish(draftId);
  }
}
