/**
 * publishDueLogic.ts — pure, DB-free helpers for the due-time publisher
 * (/api/cron/publish-due). Kept separate from the route so the claim window, the
 * payload→publish-input mapping, and the success/failure payload transforms unit-test
 * in isolation (scripts/test-publish-due-claim.ts) with no Supabase or HTTP.
 *
 * The atomic claim itself lives in the route (a single conditional UPDATE … RETURNING
 * via PostgREST), but the *predicate* it encodes — "claimable = unclaimed OR the claim
 * is older than the stale window" — is expressed here so it can be asserted directly.
 */

import { mapPublishErrorToCategory } from "@/lib/studio/pinLifecycle";
// Pure URL resolution — no browser globals, safe on the server.
import { toProxyUrl } from "@/lib/imageProxy";
// Intent resolution. Both modules are pure and import-safe (no Supabase client built at
// module load), which is what keeps this file runnable under bare `tsx`.
import { resolveScheduledDestinations } from "@/lib/social/scheduledDestinations";
import {
  pendingDestinations,
  publishedForSchedule,
  type AttemptedResult,
  type DestinationOutcome,
  type PendingOptions,
} from "@/lib/social/publishRules";
// The card path's history rule, reused verbatim so a scheduled republish and a manual
// one keep the same "Earlier publishes" record. Pure + dependency-free (it only reads
// mediaRules/scheduledDestinations, both import-safe), so it runs under bare `tsx`.
import { supersededResults, type DestinationPublishResult } from "@/lib/contentDraftModel";
import { isSocialProvider, platformName, type SocialProvider } from "@/lib/social/platforms";
import type { ScheduledDestination } from "@/lib/pinDraftStore";

/** A claim is reclaimable if it was never taken, or the worker that took it is
 *  presumed dead (claim older than this window). Matches the SQL the route runs. */
export const CLAIM_STALE_MS = 10 * 60 * 1000; // 10 minutes

/**
 * How long ONE run may keep CLAIMING rows (wall clock, from the top of the handler).
 *
 * The platform kills the invocation at `maxDuration` (300s). A row whose publish
 * succeeded but whose result was never persisted keeps its schedule and its claim, so
 * ten minutes later it is re-claimed and PUBLISHED AGAIN — a double post. The batch
 * (20) is not a time bound: one Instagram publish alone polls its container for up to
 * ~45s, so a slow batch could run past the ceiling mid-row.
 *
 * So the run stops TAKING work well before the ceiling, leaving ~100s of headroom for
 * the row it is already publishing. Rows it never claimed were never touched: they stay
 * due, unclaimed, and the next tick (~5 min) takes them. Deferring is free; being killed
 * mid-publish is not.
 */
export const CLAIM_BUDGET_MS = 200_000;

/**
 * The run's HARD deadline and the room reserved for one destination.
 *
 * Defined in publishRules (the fan-out enforces them destination by destination) and
 * re-exported here so every bound this route runs under is readable in one place:
 * CLAIM_BUDGET_MS stops it taking new ROWS, RUN_DEADLINE_MS stops it starting new
 * DESTINATIONS. The batch limit bounds neither — it counts rows, not seconds.
 */
export { RUN_DEADLINE_MS, DESTINATION_RESERVE_MS } from "@/lib/social/publishRules";

/** ISO timestamp of the stale-claim cutoff: claims at/after this are still "live". */
export function staleClaimCutoffIso(nowMs: number): string {
  return new Date(nowMs - CLAIM_STALE_MS).toISOString();
}

/**
 * The claim predicate, in JS, mirroring the route's
 *   (publish_claimed_at IS NULL OR publish_claimed_at < now() - interval '10 minutes')
 * Used by the test to prove the boundary; the route relies on the DB to evaluate it
 * atomically across concurrent workers.
 */
export function isClaimable(publishClaimedAt: string | null | undefined, nowMs: number): boolean {
  if (!publishClaimedAt) return true;
  const claimedMs = Date.parse(publishClaimedAt);
  if (Number.isNaN(claimedMs)) return true; // unparseable lock ⇒ treat as stale/claimable
  return claimedMs < nowMs - CLAIM_STALE_MS;
}

/** First non-empty trimmed string among the candidates, else "". */
function firstString(...vals: unknown[]): string {
  for (const v of vals) if (typeof v === "string" && v.trim()) return v.trim();
  return "";
}

/**
 * The Content's media URLs in display order, read from the stored draft payload.
 *
 * `payload.media` is the multi-image Content's media list — `{ id, url, … }` entries
 * whose ARRAY ORDER is the merchant's display order (index 0 is the cover). Read
 * defensively: the payload is whatever the client last synced, so a missing field, a
 * non-array, or an entry without a usable url must degrade to the single-image path
 * rather than throw inside a cron batch.
 *
 * Returns [] when there is no usable media list — the caller then falls back to
 * `payload.imageUrl`, i.e. the behaviour every pre-multi-image draft has always had.
 */
function readMediaUrls(payload: Record<string, unknown>): string[] {
  const media = payload.media;
  if (!Array.isArray(media)) return [];
  const urls: string[] = [];
  for (const entry of media) {
    if (!entry || typeof entry !== "object") continue;
    const url = (entry as { url?: unknown }).url;
    if (typeof url === "string" && url.trim()) urls.push(url.trim());
  }
  return urls;
}

export interface DuePublishInput {
  uid: string;
  /**
   * The Pinterest board this Content publishes into — ABSENT when no Pinterest
   * destination is owed. A Content scheduled only to Instagram/Facebook has no board
   * and never needed one; requiring it here is what made such a schedule fail with
   * "Missing image or board" without a single platform it named being attempted.
   * `destinationPublishInput` re-resolves the board per Pinterest entry and refuses an
   * entry that has none, so nothing ever reaches Pinterest boardless.
   */
  boardId?: string;
  /** The cover image — `imageUrls[0]`, kept for callers on the single-image contract. */
  imageUrl: string;
  /**
   * The Content's whole media set in display order (cover first), every entry already
   * resolved to an absolute public URL. Always at least one entry. Pinterest and the
   * social fan-out both publish ALL of them — a scheduled multi-image Content must go
   * out as the carousel the merchant built, not as its first image.
   */
  imageUrls: string[];
  title?: string;
  description?: string;
  link?: string;
  altText?: string;
  /** The Pin's pinned publish target, when it has one (PRD §14). */
  connectionId?: string;
}

/**
 * Map a stored PinDraft `payload` to the publishPinForUser() input. Field names mirror
 * the studio store (imageUrl / boardId / title / description / destinationUrl / altText).
 * Returns null when a hard requirement (image or board) is missing — the caller records a
 * content failure rather than calling Pinterest with an unpublishable payload.
 *
 * `targetConnectionId` rides through verbatim: cron publishes a scheduled Pin to the
 * account that Pin was pinned to, whatever the user's default account has since become.
 * Absent (every pre-Phase-C draft) ⇒ publishPinForUser resolves the default connection,
 * exactly the pre-v59 behaviour, and the adoption is written back by payloadAfterSuccess /
 * payloadAfterFailure.
 */
export function owedDestinations(
  payload: Record<string, unknown>,
  options?: PendingOptions,
): ScheduledDestination[] {
  const intent = resolveScheduledDestinations(payload as Parameters<typeof resolveScheduledDestinations>[0]);
  // What already happened, so a row re-claimed after a stale lock does not re-publish an
  // account that already succeeded. `pendingDestinations` keys that by ACCOUNT, so two
  // accounts on one platform retry independently — and by SCHEDULE, so a Posted Content
  // the merchant re-scheduled publishes again instead of quietly losing its new slot.
  const prior = Array.isArray(payload.destinationResults)
    ? (payload.destinationResults as AttemptedResult[])
    : [];
  if (intent.length) return pendingDestinations(intent, prior, options);

  // ── The draft that names no account at all ────────────────────────────────────
  // `resolveScheduledDestinations` can only derive intent from a PINNED target, so a
  // draft with a board but no `targetConnectionId` — every Pin scheduled before
  // adopt-once wrote one back — resolves to nothing. Once destinations drove the
  // publish, "nothing owed" made such a row leave the due scan as completed after
  // being metered, publishing absolutely nothing. It used to publish through
  // `publishPinForUser` on the DEFAULT connection and adopt it, so that is what is
  // owed: one Pinterest destination naming no account.
  //
  // The empty `socialConnectionId` is the point, not an oversight — it is what makes
  // `destinationPublishInput` leave `connectionId` unset, so the publish resolves the
  // default account and the route's adopt-once branch pins it. It is also why the
  // stored result row keys as `pinterest:legacy`, exactly as it always did.
  const boardId = firstString(payload.boardId);
  if (!boardId) return []; // nothing to publish INTO — payloadToPublishInput refuses it
  // A stale re-claim must not double-post the Pin this row already published — but a
  // Pin published for an EARLIER schedule must not block the one the merchant just
  // set, or a legacy Content could never be re-scheduled at all. Same rule as above.
  if (prior.some(r => r.provider === "pinterest" && publishedForSchedule(r, options?.scheduledAt))) return [];
  const legacy: ScheduledDestination = {
    provider: "pinterest",
    socialConnectionId: "",
    boardId,
    capturedAt: new Date().toISOString(),
  };
  const boardName = firstString(payload.boardName);
  if (boardName) legacy.boardName = boardName;
  return [legacy];
}

export function payloadToPublishInput(
  uid: string,
  payload: Record<string, unknown>,
  options?: PendingOptions,
): DuePublishInput | null {
  // A multi-image Content stores its whole media set in `payload.media`, in display
  // order, with the cover first. Older/single-image drafts have no `media` at all —
  // they fall back to `imageUrl`, which is exactly what this function always read.
  const mediaUrls = readMediaUrls(payload);
  const storedImage = mediaUrls[0] || firstString(payload.imageUrl, payload.sourceImageUrl);
  const boardId = firstString(payload.boardId);
  // A board may live on a Pinterest ENTRY rather than on the draft: a Content whose only
  // Pinterest destination carries its own board has no legacy `payload.boardId` at all,
  // and refusing it here would fail a publish that is perfectly well specified.
  // `destinationPublishInput` re-checks per entry, so an entry that genuinely has no
  // board is still refused — just individually.
  const anyEntryBoard = Array.isArray(payload.scheduledDestinations)
    && (payload.scheduledDestinations as Array<Record<string, unknown>>)
      .some(d => d && typeof d === "object" && d.provider === "pinterest" && firstString(d.boardId));
  // WHETHER a board is required at all: only when nothing but Pinterest is still owed.
  //
  //   - nothing owed (a legacy draft carrying no intent at all) ⇒ every() is true ⇒
  //     required, i.e. byte-for-byte the behaviour this function always had.
  //   - Pinterest-only intent (explicit, or derived from the legacy pinned target) ⇒
  //     required, unchanged.
  //   - the Content names Instagram/Facebook and NO Pinterest ⇒ NOT required. This is
  //     the fix: such a Content has no board, never needed one, and used to die here
  //     with "Missing image or board" without a single named platform being attempted.
  //   - mixed (Pinterest + Instagram) with no board anywhere ⇒ not required at the
  //     CONTENT level: the boardless Pinterest entry is refused individually by
  //     `destinationPublishInput` and gets its own failure row, while Instagram — which
  //     needs no board — still goes out. Failing the whole Content would punish a
  //     destination that is perfectly well specified for a defect on a different one.
  // The SAME owed set the route publishes from — `options` included, or a Content
  // re-scheduled to Instagram alone could be refused for a board it does not need.
  const boardRequired = owedDestinations(payload, options).every(d => d.provider === "pinterest");
  if (!storedImage) return null;
  if (boardRequired && !boardId && !anyEntryBoard) return null;
  // Resolve to the absolute public URL, exactly as the Publish-now path does
  // (DraftDetailsDrawer passes the image through toProxyUrl before publishing).
  //
  // Some drafts store the relative proxy path `/api/storage-image?path=studio/…`
  // — written when NEXT_PUBLIC_SUPABASE_URL was unset at generation time, so
  // publicStorageUrl fell back to it. Pinterest fetches the image itself and
  // cannot resolve a relative path: server validation rejects it up front with
  // "imageUrl is not a valid URL". Publish now never hit this because it already
  // resolved; only the scheduled path passed the raw value through, which is why
  // the same draft could publish by hand and fail on a schedule.
  //
  // EVERY image is resolved, not just the cover: a carousel whose 2nd image kept the
  // relative proxy path would fail the same way — publishable by hand, broken on a
  // schedule — which is precisely the divergence this resolution exists to close.
  const imageUrls = (mediaUrls.length ? mediaUrls : [storedImage]).map(toProxyUrl);
  return {
    uid,
    // Omitted rather than "" when there is none, so the type tells the truth: a
    // Pinterest publish is only ever built through `destinationPublishInput`.
    boardId: boardId || undefined,
    imageUrl: imageUrls[0],
    imageUrls,
    title: firstString(payload.title) || undefined,
    description: firstString(payload.description) || undefined,
    // destination link is optional/recommended (never blocks publish).
    link: firstString(payload.destinationUrl) || undefined,
    altText: firstString(payload.altText) || undefined,
    connectionId: firstString(payload.targetConnectionId) || undefined,
  };
}

/**
 * A Pinterest-ready publish input: the Content's fields with a board RESOLVED. Only
 * `destinationPublishInput` mints one, which is why nothing can reach Pinterest without
 * a board even though `DuePublishInput.boardId` is optional.
 */
export type PinterestPublishInput = DuePublishInput & { boardId: string };

/** One destination's outcome, in the shape the fan-out layer already produces. */
export type DestinationOutcomeLike = {
  provider: string;
  status: string;
  socialConnectionId?: string | null;
  externalPostId?: string | null;
  externalPostUrl?: string | null;
  accountName?: string | null;
  error?: string | null;
};

/**
 * Fold this attempt's outcomes into the payload's `destinationResults[]`.
 *
 * The point of writing these from cron at all: a scheduled publish must leave the SAME
 * per-destination record an immediate one leaves. Without it, a Pin published by the
 * worker showed only the legacy single-Pinterest fields, so the card that had shown
 * three destination rows before the schedule fired showed one afterwards — the merchant
 * could not tell whether Instagram had gone out.
 *
 * Keyed `${provider}:${socialConnectionId ?? "legacy"}`, the same key the client uses,
 * so a retry updates the row it belongs to instead of appending a duplicate.
 */
function priorDestinationResults(payload: Record<string, unknown>): Array<Record<string, unknown>> {
  return Array.isArray(payload.destinationResults)
    ? (payload.destinationResults as Array<Record<string, unknown>>)
    : [];
}

/** This attempt's rows, in the stored shape — the input to BOTH merges below. */
function outcomeRows(
  outcomes: readonly DestinationOutcomeLike[],
  nowIso: string,
): Array<Record<string, unknown>> {
  return outcomes
    // `skipped` is "not attempted" — recording an outcome for it would claim
    // something happened that did not. `pending` is "not attempted YET" (the run ran
    // out of time before it): the mapping below has only two landing places, so a
    // pending outcome would be written as FAILED — telling the merchant a platform
    // rejected a post that was never sent, and inviting them to "retry" a publish
    // the next run is going to make anyway. It also must not reach
    // `supersededDestinationResults`, which would archive the live post this
    // destination still has and drop it from the card.
    .filter(o => o.status !== "skipped" && o.status !== "pending")
    .map(o => {
      const connectionId = typeof o.socialConnectionId === "string" && o.socialConnectionId.trim()
        ? o.socialConnectionId.trim()
        : null;
      const published = o.status === "published";
      const row: Record<string, unknown> = {
        destinationId: `${o.provider}:${connectionId ?? "legacy"}`,
        provider: o.provider,
        socialConnectionId: connectionId,
        status: published ? "published" : "failed",
        submittedAt: nowIso,
      };
      if (o.accountName) row.accountLabel = o.accountName;
      if (published) {
        row.publishedAt = nowIso;
        if (o.externalPostId) row.remoteId = o.externalPostId;
        if (o.externalPostUrl) row.postUrl = o.externalPostUrl;
      } else {
        row.errorMessage = o.error || "Publishing failed.";
      }
      return row;
    });
}

export function mergeDestinationResults(
  payload: Record<string, unknown>,
  outcomes: readonly DestinationOutcomeLike[],
  nowIso: string,
): Array<Record<string, unknown>> {
  const prior = priorDestinationResults(payload);
  const rows = outcomeRows(outcomes, nowIso);
  const fresh = new Set(rows.map(r => r.destinationId));
  return [...prior.filter(r => !fresh.has(r?.destinationId)), ...rows];
}

/**
 * The `published` rows this attempt REPLACES, appended to the Content's history.
 *
 * A Content that was Posted, then edited and re-scheduled, publishes again into the
 * same destination — and `mergeDestinationResults` drops the row describing the post
 * that is still live on the platform, taking its permalink with it. The card path has
 * always kept it (`supersededResults` → `previousResults[]`, rendered as "Earlier
 * publishes"); the cron did not, so the SAME Content lost history only when the
 * scheduler published it. Same helper, same cap, same rule: only `published` rows are
 * worth keeping, and a row replaced by a FAILED re-attempt is kept too — the earlier
 * post is still live regardless of how the retry went.
 */
/** Do two result rows describe the SAME post on the platform? */
function samePost(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const field = (r: Record<string, unknown>, k: string) => (typeof r?.[k] === "string" ? r[k] : "");
  return field(a, "remoteId") === field(b, "remoteId") && field(a, "postUrl") === field(b, "postUrl");
}

export function supersededDestinationResults(
  payload: Record<string, unknown>,
  outcomes: readonly DestinationOutcomeLike[],
  nowIso: string,
): Array<Record<string, unknown>> {
  const history = Array.isArray(payload.previousResults)
    ? (payload.previousResults as Array<Record<string, unknown>>)
    : [];
  const rows = outcomeRows(outcomes, nowIso);
  // A destination's outcome is now written TWICE: once incrementally, the moment the
  // provider answers, and again by the final persist (which re-reads, so it sees its
  // own incremental row as the "prior" one). Without this filter the second write
  // would archive the post it had just recorded — the live Pin would appear in BOTH
  // destinationResults and previousResults, and "Earlier publishes" would list a post
  // that was never superseded by anything. A prior row is only superseded when the
  // fresh row describes a DIFFERENT post.
  const freshByDestination = new Map(rows.map(r => [r.destinationId, r]));
  const prior = priorDestinationResults(payload).filter(r => {
    const fresh = freshByDestination.get(r?.destinationId);
    return !fresh || !samePost(r, fresh);
  });
  // Cast at the boundary only: these are the stored result rows, typed loosely here
  // because a cron payload is whatever the client last synced.
  return supersededResults(
    prior as unknown as DestinationPublishResult[],
    rows as unknown as DestinationPublishResult[],
    history as unknown as DestinationPublishResult[],
  ) as unknown as Array<Record<string, unknown>>;
}

/**
 * Write BOTH halves of the result record: what happened now, and the live posts this
 * attempt superseded. Every payloadAfter* transform goes through here so no path can
 * record one without the other.
 *
 * Exported because the incremental writer (persistRow.ts) applies a single outcome to
 * a freshly re-read payload and must use the SAME merge — a second, simpler one would
 * be a second answer to "what does this Content's result set look like now".
 */
export function applyDestinationResults(
  next: Record<string, unknown>,
  payload: Record<string, unknown>,
  outcomes: readonly DestinationOutcomeLike[],
  nowIso: string,
): void {
  next.destinationResults = mergeDestinationResults(payload, outcomes, nowIso);
  const previous = supersededDestinationResults(payload, outcomes, nowIso);
  if (previous.length) next.previousResults = previous;
}

/** The reason a destination that was owed produced no result of its own. */
export function didNotCompleteMessage(provider: SocialProvider): string {
  return `Publishing to ${platformName(provider)} did not complete.`;
}

/**
 * Failed result rows for owed destinations that the fan-out never reported on.
 *
 * Two ways a destination can end up with no row: `fanOutDestinations` THREW (one
 * unhandled error and every remaining platform is lost at once), or it returned fewer
 * rows than it was given. Both used to be silent — the Content was marked posted from
 * the Pinterest result and the merchant was never told Instagram had not gone out. A
 * missing row does not mean "nothing happened", it means "nobody knows", and the only
 * honest rendering of that is a failure the merchant can see and retry.
 *
 * `attempted` is whatever DID report (the fan-out's return value), keyed the same way
 * the rest of the pipeline keys destinations — provider + account — so a partial
 * result set only gets rows for the accounts genuinely missing from it. Pinterest
 * entries are never included: they are dispatched by their own loop, which always
 * records a row.
 */
export function failedRowsForUnattempted(
  extras: readonly ScheduledDestination[],
  message: string | ((provider: SocialProvider) => string),
  attempted: readonly DestinationOutcomeLike[] = [],
): DestinationOutcome[] {
  const key = (provider: string, id: unknown) =>
    `${provider}:${typeof id === "string" && id.trim() ? id.trim() : ""}`;
  const seen = new Set(attempted.map(o => key(o.provider, o.socialConnectionId)));
  const rows: DestinationOutcome[] = [];
  for (const d of extras) {
    // Pinterest is dispatched by the per-destination loop, which always leaves a row.
    if (!isSocialProvider(d.provider) || d.provider === "pinterest") continue;
    const k = key(d.provider, d.socialConnectionId);
    if (seen.has(k)) continue;
    seen.add(k); // a duplicated entry must not produce two identical failure rows
    const row: DestinationOutcome = {
      provider: d.provider,
      status: "failed",
      socialConnectionId: typeof d.socialConnectionId === "string" && d.socialConnectionId.trim()
        ? d.socialConnectionId.trim()
        : null,
      error: (typeof message === "function" ? message(d.provider) : message)
        || didNotCompleteMessage(d.provider),
    };
    // Name the account the merchant chose, so a two-account platform says WHICH one.
    if (d.accountLabel) row.accountName = d.accountLabel;
    rows.push(row);
  }
  return rows;
}

/**
 * Pin an adopted target onto a payload — the adopt-once write-back (PRD §14).
 *
 * Only ever writes when the payload has no target yet: a payload that already names an
 * account is pinned, and nothing (least of all a publish attempt that resolved a default)
 * may re-point it. Returns the SAME object when there's nothing to adopt, so callers can
 * treat it as a no-op.
 */
export function withAdoptedTarget(
  payload: Record<string, unknown>,
  connectionId: string | null | undefined,
): Record<string, unknown> {
  const id = typeof connectionId === "string" ? connectionId.trim() : "";
  if (!id) return payload;
  if (firstString(payload.targetConnectionId)) return payload; // already pinned — never re-point
  return { ...payload, targetConnectionId: id };
}

/**
 * The payload patch to persist after a SUCCESSFUL publish. The draft's whole object
 * lives in `payload`, so we merge onto it: mark posted, capture the remote Pin, and
 * clear the scheduling fields so it is neither re-scanned nor shown as scheduled.
 */
export function payloadAfterSuccess(
  payload: Record<string, unknown>,
  pin: { id: string; url: string },
  nowIso: string,
  /** The connection this publish ran through — pinned onto untargeted drafts (adopt-once). */
  connectionId?: string | null,
  /**
   * What the non-Pinterest fan-out achieved, so a scheduled publish records the SAME
   * per-destination rows an immediate one does. Omitted ⇒ Pinterest-only, which is
   * exactly what a legacy (intent-less) Pin resolves to.
   */
  fanned?: readonly DestinationOutcomeLike[],
): Record<string, unknown> {
  const next = { ...withAdoptedTarget(payload, connectionId) };
  applyDestinationResults(next, payload, [
    {
      provider: "pinterest",
      status: "published",
      socialConnectionId: firstString(payload.targetConnectionId) || connectionId || null,
      externalPostId: pin.id,
      externalPostUrl: pin.url,
    },
    ...(fanned ?? []),
  ], nowIso);
  // Bump payload.updatedAt: the client's mergeServerDrafts LWW compares this field
  // (pinDraftStore.ts:815, local wins on tie) — without it the client never sees the
  // cron's result and a later local edit can push the stale scheduled payload back,
  // reviving scheduled_at and re-publishing the same Pin.
  next.updatedAt = nowIso;
  next.postedAt = nowIso;
  next.remotePinId = pin.id;
  next.remotePinUrl = pin.url;
  next.generationStatus = "completed";
  // Clear scheduling so lifecycle derives "posted" and the row is no longer due.
  next.scheduledDate = "";
  next.scheduledTime = "";
  next.plannedAt = "";
  // Clear any prior failure framing.
  delete next.publishError;
  delete next.failureType;
  delete next.errorCategory;
  delete next.publishErrorCode;
  return next;
}

export interface PublishFailureInfo {
  /** User-facing / diagnostic message. */
  message: string;
  /** Stable error code when available (drives categorization + internal display). */
  code?: string;
}

/**
 * The payload patch to persist after a FAILED publish (validation failure OR a thrown
 * connection/API error). Writes the WP-B failure semantics (§11.5): failureType,
 * errorCategory (via mapPublishErrorToCategory), the raw code, and preserves the time
 * the Pin *was* scheduled for so a future "reschedule" affordance can restore it. Clears
 * the scheduling fields so the row drops out of the due scan (no retry storm).
 */
export function payloadAfterFailure(
  payload: Record<string, unknown>,
  fail: PublishFailureInfo,
  nowIso: string,
  /**
   * The connection this attempt ran through, when it got far enough to know. A failed
   * publish still fixes the target: the retry must go to the same account the attempt
   * chose, not to whatever the default has drifted to in the meantime. Omitted when the
   * attempt never resolved a connection (not_connected / bad payload) — then the draft
   * stays untargeted and adopts on the next try.
   */
  connectionId?: string | null,
  options?: OutcomePersistOptions,
): Record<string, unknown> {
  const clearSchedule = options?.clearSchedule !== false;
  const next = { ...withAdoptedTarget(payload, connectionId) };
  // Bump payload.updatedAt (same reason as payloadAfterSuccess — see comment there):
  // the client's LWW merge compares this field, so it must match the row's updated_at.
  next.updatedAt = nowIso;
  // The failed Pinterest destination gets a row of its own, carrying the reason, so the
  // card shows WHICH destination failed and why — not just a Content-level error.
  applyDestinationResults(next, payload, [{
    provider: "pinterest",
    status: "failed",
    socialConnectionId: firstString(payload.targetConnectionId) || connectionId || null,
    error: fail.message,
  }], nowIso);

  // previousScheduledTime is stored as ISO (matches DraftDetailsDrawer.tsx:955 and
  // promote.ts's deriveLocalPlanned + "append :00.000Z" UTC convention) rather than the
  // raw local wall-clock string, so downstream consumers get a consistent format.
  const localPlanned = firstString(payload.plannedAt, payload.scheduledDate);
  let previousScheduled: string | undefined;
  if (localPlanned) {
    const m = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}))?/.exec(localPlanned);
    if (m) {
      const iso = `${m[1]}T${m[2] ?? "00:00"}:00.000Z`;
      const ms = Date.parse(iso);
      if (!Number.isNaN(ms)) previousScheduled = new Date(ms).toISOString();
    }
  }

  next.publishError = fail.message;
  next.failureType = "publish";
  next.errorCategory = mapPublishErrorToCategory(fail.code, fail.message);
  if (fail.code) next.publishErrorCode = fail.code;
  if (clearSchedule && previousScheduled) next.previousScheduledTime = previousScheduled;

  // Drop it out of the due scan; the "failed" lifecycle comes from publishError.
  // Unless the merchant rescheduled while this attempt was running — then the slot
  // they just chose is theirs, and the failure is recorded without cancelling it.
  if (clearSchedule) clearScheduleFields(next);
  return next;
}

/**
 * Drop the payload's scheduling fields, so lifecycle stops deriving "scheduled".
 *
 * One helper rather than four copies: a clearing site that is added but not gated by
 * `clearSchedule` is exactly the bug this option exists to prevent.
 */
function clearScheduleFields(next: Record<string, unknown>): void {
  next.scheduledDate = "";
  next.scheduledTime = "";
  next.plannedAt = "";
}

/** How a persist should treat the Content's schedule. */
export interface OutcomePersistOptions {
  /**
   * At least one destination was DEFERRED (the run's deadline arrived first).
   *
   * Record what happened, leave the Content scheduled: it is neither posted nor
   * failed while a destination it named has not been attempted.
   */
  deferred?: boolean;
  /**
   * May this persist clear the scheduling fields? Default true.
   *
   * False when the merchant RESCHEDULED while the Content was publishing: the row's
   * `scheduled_at` is no longer the one this run claimed, so clearing it would silently
   * cancel a slot they had just chosen. Their schedule stands; the results are recorded
   * beside it.
   */
  clearSchedule?: boolean;
}

/**
 * The payload patch to persist after an attempt that had N destinations.
 *
 * The single-target `payloadAfterSuccess`/`payloadAfterFailure` pair cannot express
 * what a multi-account publish produces: two Pinterest accounts can now be two
 * destinations, and "one succeeded, one failed" is neither a success payload nor a
 * failure payload. This folds every outcome into the SAME per-destination rows the
 * client writes, then derives the legacy fields from them — the identical rule
 * `publishContent` uses on the client, so a Content published on a schedule and one
 * published by hand can never disagree about what happened.
 *
 * The split that matters:
 *   - at least one destination published ⇒ POSTED. Its schedule is consumed (a partial
 *     success must not re-fire and double-post the account that worked), and the legacy
 *     remotePin fields name the first published Pinterest destination.
 *   - nothing published ⇒ FAILURE. WP-B §11.5 semantics, and the time it WAS scheduled
 *     for is preserved so a reschedule can offer it back.
 */
export function payloadAfterOutcomes(
  payload: Record<string, unknown>,
  outcomes: readonly DestinationOutcomeLike[],
  nowIso: string,
  /** Adopt-once: the connection an untargeted draft actually published through. */
  adoptedConnectionId?: string | null,
  /**
   * The stable error CODE of the first failure, when the platform gave one.
   *
   * It cannot be recovered from the outcome rows — those carry only a user-facing
   * message — and the message alone is not a reliable categorization input: a
   * `needs_reconnect` worded differently would land in "transient" and the retry
   * affordance would offer the wrong fix. Everything downstream that reads
   * `publishErrorCode` degrades with it, so the caller passes it in.
   */
  failureCode?: string,
  options?: OutcomePersistOptions,
): Record<string, unknown> {
  const next = { ...withAdoptedTarget(payload, adoptedConnectionId) };
  applyDestinationResults(next, payload, outcomes, nowIso);
  // The client's mergeServerDrafts LWW compares this field — see payloadAfterSuccess.
  next.updatedAt = nowIso;

  // `pending` joins `skipped` here: neither was attempted, and counting a deferred
  // destination as an attempt would resolve the Content — posted or failed — on the
  // strength of a publish that has not happened.
  const clearSchedule = options?.clearSchedule !== false;
  const attempted = outcomes.filter(o => o.status !== "skipped" && o.status !== "pending");
  const publishedPinterest = attempted.find(o => o.provider === "pinterest" && o.status === "published");
  const anyPublished = attempted.some(o => o.status === "published");

  // ── At least one destination was deferred ──────────────────────────────────
  // The run ran out of time before it. Whatever DID happen is recorded — a Pin that
  // published is a fact, and losing it is what makes the next run publish it twice —
  // but the Content is neither posted nor failed: it is still scheduled, for the
  // destinations that have not gone out. So the schedule stays, the claim is released
  // by the caller, and the next run owes exactly the destinations still missing.
  //
  // `remotePinId`/`remotePinUrl` are captured here and not left to the completing run:
  // by then this Pinterest destination has already published and is no longer owed, so
  // its outcome is not in that run's set and the permalink would reach the legacy
  // fields never. `postedAt` is NOT set — that is the completing run's to write.
  if (options?.deferred) {
    if (publishedPinterest?.externalPostId) next.remotePinId = publishedPinterest.externalPostId;
    if (publishedPinterest?.externalPostUrl) next.remotePinUrl = publishedPinterest.externalPostUrl;
    return next;
  }

  // Nothing was ATTEMPTED because nothing was still owed — every destination had
  // already published on an earlier attempt (a stale-claim re-run). That is a
  // completed Content, not a failure: it just needs to leave the due scan.
  if (!attempted.length) {
    if (clearSchedule) clearScheduleFields(next);
    return next;
  }

  if (anyPublished) {
    next.postedAt = nowIso;
    if (publishedPinterest?.externalPostId) next.remotePinId = publishedPinterest.externalPostId;
    if (publishedPinterest?.externalPostUrl) next.remotePinUrl = publishedPinterest.externalPostUrl;
    next.generationStatus = "completed";
    // Clear scheduling so lifecycle derives "posted" and the row is no longer due.
    if (clearSchedule) clearScheduleFields(next);
    delete next.publishError;
    delete next.failureType;
    delete next.errorCategory;
    delete next.publishErrorCode;
    return next;
  }

  // Nothing was delivered. The first failure is what the Content-level banner reports;
  // every destination keeps its own reason in its own row.
  const firstFailure = attempted.find(o => o.status === "failed");
  const message = firstFailure?.error || "Publish failed";
  const previousScheduled = previousScheduledIso(payload);
  next.publishError = message;
  next.failureType = "publish";
  next.errorCategory = mapPublishErrorToCategory(failureCode, message);
  if (failureCode) next.publishErrorCode = failureCode;
  if (clearSchedule && previousScheduled) next.previousScheduledTime = previousScheduled;
  if (clearSchedule) clearScheduleFields(next);
  return next;
}

/**
 * The instant a payload WAS scheduled for, as ISO — preserved across a failure so a
 * reschedule can offer the lost slot back. Stored as ISO (matching DraftDetailsDrawer
 * and promote.ts) rather than the raw local wall-clock string.
 */
function previousScheduledIso(payload: Record<string, unknown>): string | undefined {
  const localPlanned = firstString(payload.plannedAt, payload.scheduledDate);
  if (!localPlanned) return undefined;
  const m = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}))?/.exec(localPlanned);
  if (!m) return undefined;
  const ms = Date.parse(`${m[1]}T${m[2] ?? "00:00"}:00.000Z`);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/**
 * The publish input for ONE destination: the shared Content fields, this entry's own
 * board, and this entry's own account.
 *
 * `payloadToPublishInput` answers "can this Content publish at all" from the draft's
 * single legacy board; with N Pinterest entries the board is a property of the ENTRY,
 * so a second account with no board of its own is refused on its own rather than
 * publishing into the first account's board.
 */
export function destinationPublishInput(
  base: DuePublishInput,
  destination: { socialConnectionId?: string | null; boardId?: string | null },
  /** The draft's legacy target — the only entry the draft-level board belongs to. */
  legacyTargetConnectionId: string,
): PinterestPublishInput | null {
  const own = typeof destination.boardId === "string" ? destination.boardId.trim() : "";
  const id = typeof destination.socialConnectionId === "string" ? destination.socialConnectionId.trim() : "";
  const boardId = own || (!id || id === legacyTargetConnectionId ? base.boardId ?? "" : "");
  if (!boardId) return null;
  return { ...base, boardId, connectionId: id || base.connectionId };
}

/** Extract { message, code } from a thrown error for categorization. Connection/API
 *  errors from publishPin.ts carry a `.code` (needs_reconnect / not_connected / …). */
export function describeThrown(err: unknown): PublishFailureInfo {
  const e = err as { message?: unknown; code?: unknown } | null;
  const message = typeof e?.message === "string" && e.message ? e.message : "Publish failed";
  const code = typeof e?.code === "string" && e.code ? e.code : undefined;
  return { message, code };
}
