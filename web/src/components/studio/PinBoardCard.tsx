"use client";

/**
 * PinBoardCard — compact-by-default board card with a single inline Quick Edit state
 * (studioBoardV2). Heavy edit controls (textareas, searchable board, AI actions) are
 * mounted ONLY when the card is the active/expanded one — so a board of dozens/hundreds
 * of cards stays scannable and cheap. Heavy AI *visual* generation opens a separate
 * drawer (Create AI Version), never inline.
 *
 * Compact: image · source badge · lifecycle badge · title · board summary · Schedule
 *          (primary) · Edit (secondary) · More menu.
 * Expanded: AI actions (Generate copy primary, Create AI Version secondary) → title /
 *           description / website URL / searchable board → More details (product / alt /
 *           tags) → autosave + Schedule. No manual publish-time fields.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import type { MessageKey } from "@/lib/i18n/messages/en";
import { ChevronDown, ChevronUp, ExternalLink, Loader2, MoreVertical, Layers, Check, CalendarClock, X, Star, AlertTriangle, Sparkles } from "lucide-react";
import type { PinDraft } from "@/lib/pinDraftStore";
import { getDraft, hasPersistFailure, retryPersist, subscribe as subscribeDrafts, splitContentMedia, copyMedia } from "@/lib/pinDraftStore";
import { toast } from "sonner";
import { getStatusBadge, isActionablePublishFailure, mapPublishErrorToCategory, type PinLifecycle } from "@/lib/studio/pinLifecycle";
import { getPublishErrorDisplayKey } from "@/lib/studio/publishErrorDisplay";
import { buildCardViewModel, relativePublishedParts, type CardResultRow } from "@/lib/studio/cardView";
import { contentMedia, coverMedia } from "@/lib/contentDraftModel";
import { PinCardMedia, resolveInitialFailureMediaUrl } from "@/components/studio/PinCardMedia";
import { ContentMediaStrip, MEDIA_DRAG_TYPE, currentDragSourceDraftId } from "@/components/studio/ContentMediaStrip";
import { VideoCoverEditButton } from "@/components/studio/VideoCoverEditButton";
import { LinkCopyField, type LinkCopyState } from "@/components/studio/LinkCopyField";
import { mediaNotices, offendingMediaIds as collectOffendingMediaIds, type MediaNotice } from "@/lib/studio/mediaNotice";
import { PinFallbackArtwork } from "@/components/studio/PinFallbackArtwork";
import { contentDestinationResults, destinationNeedsAttention, findDestinationResult, type PublishProvider } from "@/lib/contentDraftModel";
import type { PinterestBoard } from "@/lib/pinterestClient";
import { PinFieldsForm, type PinFieldsValue } from "@/components/pins/PinFieldsForm";
import { PinAICopyPanel, type PinAICopyPanelHandle, type PinAICopyResult } from "@/components/pins/PinAICopyPanel";
import { PublishDestinations } from "@/components/social/PublishDestinations";
import { platformName, type SocialProvider } from "@/lib/social/platforms";
import {
  AmbiguousScheduleAccountError,
  buildScheduledDestinations,
  legacyPinterestMirror,
  resolveScheduledAccount,
  withBoardOnPinterestEntry,
  type DestinationPick,
} from "@/lib/social/scheduledDestinations";
import type { SelectedAccount } from "@/components/social/PublishDestinations";
import type { PlatformConnectionSummary } from "@/lib/social/types";
import { BUI, STUDIO_UI, toneColor, fieldStyle, labelStyle } from "@/components/studio/boardUI";
import { track } from "@/lib/analytics";
import { getPinDraftSyncIssue, getPinDraftSyncStatus, subscribePinDraftSyncStatus } from "@/lib/pinDraftSync";
import { explicitPublishDestinations } from "@/lib/studio/publishConfirmation";
import { canEnterCardEdit, mediaAspectResetKey, resolveMediaAspectRatio, shouldShowStudioMetadataField, studioCardPresentation } from "@/lib/studio/studioCardPresentation";
import {
  instagramCaptionIssues,
  shouldShowFieldOnInstagramChild,
  shouldShowInstagramCaptionInput,
} from "@/lib/studio/splitMixedVideoDraft";
import { igFbHidden } from "@/lib/social/visibleProviders";
import { AmazonCardSection } from "@/components/studio/AmazonCardSection";
import {
  amazonClaimHints,
  canGenerateAmazonCopy,
  cardSourceForUrl,
  classifyCardMarketplace,
  isAmazonLink,
  isCardMarketplaceLink,
  isMarketplaceCardDraft,
  type AmazonCardManual,
  type AmazonCardSource,
  type AmazonClaimHint,
} from "@/lib/studio/amazonCardSource";
import { manualCopyTouched } from "@/lib/studio/bulkCopyDrafts";
import { copyInputTitle } from "@/lib/studio/uploadPlaceholderTitle";
import { EMPTY_TOUCHED } from "@/lib/pinMetadata";
import { runAmazonCardImport } from "@/lib/studio/amazonCardImport";
import { fetchProductUrlImport } from "@/lib/productUrlImportClient";
import { appendAffiliateDisclosure, hasAffiliateDisclosure } from "@/lib/ai-copy/affiliateDisclosure";

const PERSIST_DEBOUNCE = 400;

function draftToFields(d: PinDraft): PinFieldsValue {
  return {
    title: d.title ?? "",
    description: d.description ?? "",
    websiteUrl: d.destinationUrl ?? "",
    boardId: d.boardId ?? "",
    altText: d.altText ?? "",
    tags: (d.tags ?? []).join(" "),
  };
}
function parseTags(raw: string): string[] {
  return Array.from(new Set(raw.split(/[\s,]+/).map(t => t.trim()).filter(Boolean))).slice(0, 20);
}
function scheduledSummary(d: PinDraft): string {
  const date = (d.scheduledDate ?? "").trim();
  if (!date) return "";
  const day = new Date(`${date}T00:00:00`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  const t = (d.scheduledTime ?? "").trim();
  if (!t) return day;
  const [h, m] = t.split(":");
  const hh = Number(h); const ampm = hh >= 12 ? "PM" : "AM"; const h12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${day} · ${h12}:${String(Number(m ?? 0)).padStart(2, "0")} ${ampm}`;
}

/** Keep known media at its real aspect ratio instead of forcing landscape media
 * into the legacy Pinterest portrait frame. */
function mediaAspectRatio(draft: PinDraft): string {
  const media = coverMedia(draft);
  return resolveMediaAspectRatio(media?.width, media?.height);
}
/** The scheduled day / clock time, split for the "publishes now instead of {date} {time}"
 *  confirm. Locale-formatted; empty when the Content has no slot. */
// "Was scheduled: <time>" — reads the ISO snapshot WP-B captures right before a
// failed publish clears the live schedule fields. The timestamp is formatted with the
// merchant's locale; only the sentence around it is translated.
function formatPreviousScheduled(tr: (key: MessageKey) => string, iso: string | undefined): string {
  const v = (iso ?? "").trim();
  if (!v) return "";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "";
  const day = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  return tr("studioBoard.card.wasScheduled").replace("{time}", `${day}, ${time}`);
}
// Recommended-fix copy per failure bucket (PRD "失败情况优化" §5). Transient gets its
// own message; content AND "no category" (legacy drafts / undetermined) share the
// content message, because in both cases something on the Pin has to change first.
function recommendedFix(tr: (key: MessageKey) => string, category: "transient" | "content" | "auth" | undefined): string {
  if (category === "auth") return tr("studioBoard.card.fix.reconnect");
  if (category === "transient") return tr("studioBoard.card.fix.temporary");
  return tr("studioBoard.card.fix.editDetails");
}
/**
 * The one actionable next step for a failure (PRD §4) — a category, not a message.
 * The merchant is never shown a raw error and then left to guess what to do with it.
 */
/**
 * "Pinterest needs review · 2 images need adjustment" — the whole notice, localized.
 *
 * The reason comes from the notice's CODE, not from the rule's English `message`.
 * mediaRules is a pure module shared with the server and carries English fallbacks
 * only; rendering those verbatim would put untranslated text on a localized card.
 */
function mediaNoticeText(tr: (key: MessageKey) => string, notice: MediaNotice): string {
  const platform = platformName(notice.provider);
  const count = notice.offendingMediaIds.length;
  const reason =
    notice.code === "aspect_mismatch"
      ? tr(count === 1 ? "studioBoard.card.mediaNotice.aspectMismatch" : "studioBoard.card.mediaNotice.aspectMismatchPlural")
          .replace("{n}", String(count))
      : notice.code === "too_many"
        ? tr("studioBoard.card.mediaNotice.tooMany").replace("{platform}", platform).replace("{max}", String(notice.limit.max))
        : notice.code === "too_few"
          ? tr("studioBoard.card.mediaNotice.tooFew").replace("{platform}", platform).replace("{min}", String(notice.limit.min)).replace("{max}", String(notice.limit.max))
          : tr("studioBoard.card.mediaNotice.noMedia").replace("{platform}", platform);
  return `${tr("studioBoard.card.mediaNotice.headline").replace("{platform}", platform)} · ${reason}`;
}

function nextStepFor(category: "transient" | "content" | "auth" | undefined, errorCode?: string):
  { key: MessageKey; action: "reconnect" | "board" | "edit" } | null {
  if (category === "auth") return { key: "studioBoard.card.nextStep.reconnect", action: "reconnect" };
  if ((errorCode ?? "").toLowerCase() === "board_not_owned") {
    return { key: "studioBoard.card.nextStep.chooseBoard", action: "board" };
  }
  if (category === "content") return { key: "studioBoard.card.nextStep.edit", action: "edit" };
  return null; // transient / unknown: Retry alone is the whole remedy.
}
function menuItemStyle(withTopBorder: boolean, danger: boolean): React.CSSProperties {
  return {
    display: "block", width: "100%", textAlign: "left", padding: "9px 12px", border: "none",
    borderTop: withTopBorder ? `1px solid ${BUI.border}` : "none", background: "none",
    fontSize: 12, fontWeight: 600, color: danger ? BUI.error : BUI.text, cursor: "pointer", fontFamily: "inherit",
  };
}

const primaryBtn: React.CSSProperties = {
  flex: "1 1 auto", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6,
  padding: "9px 12px", borderRadius: 9, border: "none", background: BUI.gradient, color: "#fff",
  fontSize: 12, fontWeight: 800, cursor: "pointer", fontFamily: "inherit",
};
const secondaryBtn: React.CSSProperties = {
  flex: "0 0 auto", display: "inline-flex", alignItems: "center", gap: 5, padding: "9px 14px",
  borderRadius: 9, border: `1px solid ${BUI.border}`, background: BUI.surface2, color: BUI.text,
  fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit",
};
// Recommended-keyword chip — subtle, matches the existing dark card density.
const keywordChipStyle: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 3, padding: "1px 7px", borderRadius: 999,
  border: `1px solid ${BUI.border}`, background: BUI.surface2, color: BUI.textSec,
  fontSize: 10, fontWeight: 650, maxWidth: "100%", overflow: "hidden",
  textOverflow: "ellipsis", whiteSpace: "nowrap", cursor: "pointer",
};
// Momentary "Copied" confirmation state for a keyword chip.
const keywordChipCopiedStyle: React.CSSProperties = {
  ...keywordChipStyle, border: `1px solid ${BUI.purple}`, color: BUI.purple,
  background: "rgba(124,58,237,0.10)",
};
const keywordChipXStyle: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", justifyContent: "center",
  width: 12, height: 12, marginRight: -2, padding: 0, border: "none",
  borderRadius: 999, background: "none", color: BUI.textMuted, cursor: "pointer",
};

export type PublishEntryIssue = "image_unavailable" | "field_too_long";

export type PinBoardCardProps = {
  draft: PinDraft;
  lifecycle: PinLifecycle;
  publishing: boolean;
  /** Derived by the board: the qualitative "Top pick" of this generation batch. */
  topPick?: boolean;
  selected?: boolean;
  onSelectedChange?: (id: string, selected: boolean) => void;
  active: boolean;
  onSetActive: (id: string | null) => void;
  onAiCopyBusyChange: (id: string, busy: boolean) => void;
  boards: PinterestBoard[];
  boardsLoading?: boolean;
  disconnected?: boolean;
  needsReconnect?: boolean;
  boardsError?: string;
  onRetryBoards?: () => void;
  /** In-place board validation error (set when Schedule fails on a missing board). */
  boardFieldError?: string;
  /** In-place title/description validation error (set when Schedule/Publish fails on an over-limit field). */
  titleFieldError?: string;
  descriptionFieldError?: string;
  /** Persistent reason a Publish-entry click stopped before the confirmation dialog. */
  publishEntryIssue?: PublishEntryIssue;
  onPersist: (id: string, patch: Partial<PinDraft>) => void;
  /**
   * `instagramCaption` is passed ONLY for a mixed Pinterest+Instagram single-video
   * draft (design doc 0924-混合视频草稿自动拆分-技术设计-v0.1.md T3) — the board
   * validates it with `instagramCaptionIssues` and blocks Schedule itself before
   * calling this, so a caller-side split always receives an acceptable caption.
   */
  onSchedule: (id: string, options?: { instagramCaption?: string }) => void;
  onCustomSchedule: (id: string, date: string, time: string, options?: { instagramCaption?: string }) => void;
  onSelectProduct?: (draft: PinDraft) => void;
  /**
   * Regenerate ONE image, never the whole set. `mediaId` names the item the result
   * replaces — the cover unless the merchant selected another thumbnail — and the
   * board threads it into `completeGeneratedDraft(..., { replaceMediaId })`.
   */
  onGenerateAiImage: (draft: PinDraft, mediaId?: string) => void;
  /**
   * Publish this Content. `onlyPending` (the board's default) re-sends only what has
   * not published — Retry semantics. A republish of an edited Posted Content passes
   * `false`, so every destination gets the new content.
   */
  onPublish: (id: string, options?: { onlyPending?: boolean }) => void;
  onDelete: (draft: PinDraft) => void;
  onArchive: (draft: PinDraft) => void;
  onDuplicate: (id: string) => void;
  /** Remove schedule/plan fields → lifecycle back to Unscheduled. */
  onUnschedule: (id: string) => void;
  /** Failed card only (PRD 13.4): clear the schedule slot + active failure fields,
   *  returning the Pin to Unscheduled. previousScheduledTime is preserved as history. */
  onMoveToUnscheduled: (id: string) => void;
  /** Download the Pin image via the safe proxy. */
  onDownload: (draft: PinDraft) => void;
  /** Save the image into My References (style_reference asset). */
  onSaveAsReference: (draft: PinDraft) => void;
  /** Failed card primary: retry publish (publish-failed) or reopen AI drawer (generation-failed). */
  onTryAgain: (draft: PinDraft) => void;
  onConnect?: () => void;
};

function PinBoardCardImpl(props: PinBoardCardProps) {
  const { t: tr } = useLocale();
  const { draft, lifecycle, active, boards, boardsLoading, disconnected, needsReconnect, boardsError, onRetryBoards } = props;
  const [fields, setFields] = useState<PinFieldsValue>(() => draftToFields(draft));
  const [menuOpen, setMenuOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  /**
   * Card-local edit state (PRD §4–§5): a Scheduled/Posted card opens its editable
   * form ONLY from the explicit Edit button. Never hover-triggered, and never lifted
   * to the board — a hover or a shared "active card" would make the merchant's cards
   * shift under the pointer while they scan a board of dozens.
   */
  const [editing, setEditing] = useState(false);
  /** "View results" expansion on a Posted card. */
  const [resultsOpen, setResultsOpen] = useState(false);
  /** The destination picker, anchored to the chips instead of expanding the card. */
  const [destinationsOpen, setDestinationsOpen] = useState(false);
  const [customTimeOpen, setCustomTimeOpen] = useState(false);
  const [customDate, setCustomDate] = useState(() => draft.scheduledDate ?? "");
  const [customTime, setCustomTime] = useState(() => draft.scheduledTime ?? "");
  const initialAspectRatio = mediaAspectRatio(draft);
  const [intrinsicAspectRatio, setIntrinsicAspectRatio] = useState(initialAspectRatio);
  const aspectMedia = coverMedia(draft);
  const aspectResetKey = mediaAspectResetKey(aspectMedia?.id, aspectMedia?.url, aspectMedia?.width, aspectMedia?.height);
  useEffect(() => { setIntrinsicAspectRatio(initialAspectRatio); }, [aspectResetKey, initialAspectRatio]);
  const onIntrinsicSize = useCallback((width: number, height: number) => {
    setIntrinsicAspectRatio(resolveMediaAspectRatio(width, height));
  }, []);
  const [selectedProviders, setSelectedProviders] = useState<PublishProvider[]>(() => {
    const providers = explicitPublishDestinations(draft).map(item => item.provider);
    return Array.from(new Set(providers));
  });
  /**
   * The ACCOUNTS this Content publishes to, seeded from its stored intent — one entry
   * per destination, so two accounts on one platform both stay ticked (and each keeps
   * its own Pinterest board) across a remount.
   */
  const [selectedAccountIds, setSelectedAccountIds] = useState<SelectedAccount[]>(() =>
    explicitPublishDestinations(draft)
      .filter(item => item.socialConnectionId)
      .map(item => ({
        provider: item.provider,
        id: item.socialConnectionId as string,
        ...(item.boardId ? { boardId: item.boardId } : {}),
        ...(item.boardName ? { boardName: item.boardName } : {}),
      })),
  );
  /** The connected accounts the picker loaded — needed to resolve one account per platform. */
  const [connectionSummaries, setConnectionSummaries] = useState<PlatformConnectionSummary[]>([]);
  /**
   * Set when a ticked platform has no destination we may record (several accounts and
   * no choice, or none connected). Publish/Schedule are blocked while it is set: a
   * destination without a connection id cannot be published and must never be stored.
   */
  const [destinationError, setDestinationError] = useState("");
  /**
   * Instagram caption for a mixed Pinterest+Instagram single-video draft (design
   * doc 0924-混合视频草稿自动拆分-技术设计-v0.1.md T3). Card-local state, NOT a
   * PinDraft field — T1's header is explicit that the caption is a caller-supplied
   * parameter to `splitMixedVideoDraft`, never read off the draft, so this box is a
   * staging area that only becomes durable once Schedule succeeds and the split
   * writes it into the child's `description`. Reloading before scheduling loses a
   * typed-but-unscheduled caption (the box goes back to empty and Schedule blocks
   * again on `instagram_caption_required`) — the same non-durability every other
   * uncommitted keystroke on this card has before the debounced autosave fires,
   * except here there is no autosave target until the split happens.
   */
  const [instagramCaption, setInstagramCaption] = useState("");
  const [instagramCaptionTouched, setInstagramCaptionTouched] = useState(false);
  // Keyword-chip interaction state (compact card): which chip shows its remove ×, and
  // which chip is briefly flashing "Copied". Card is keyed by draft.id upstream, so this
  // never leaks across drafts.
  const [hoveredKw, setHoveredKw] = useState<string | null>(null);
  const [copiedKw, setCopiedKw] = useState<string | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const aiRef = useRef<PinAICopyPanelHandle>(null);
  // Link-field AI action state: a run in flight, and the link the last applied copy
  // was generated for (session only — a reload with prior copy shows "Regenerate").
  const [copyBusy, setCopyBusy] = useState(false);
  const [copyGeneratedForUrl, setCopyGeneratedForUrl] = useState<string | null>(null);
  const selfEdit = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<PinFieldsValue>(fields);
  useEffect(() => {
    if (selfEdit.current) { selfEdit.current = false; return; }
    const seeded = draftToFields(draft);
    pendingRef.current = seeded;
    setFields(seeded);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.updatedAt]);

  const boardName = useCallback((id: string) => boards.find(b => b.id === id)?.name ?? "", [boards]);

  /**
   * The card's REAL save state (PRD §3), not a decorative tick.
   *
   * "Saving…" is the debounce window — the merchant's keystrokes are in memory and
   * not yet written. "Saved" is the settled state. "Couldn't save" reads the store's
   * own `hasPersistFailure()`, which is set when the localStorage write throws
   * (quota/private mode): edits survive in memory, so the honest line is a retry
   * offer, not a lie either way. The old card rendered a hardcoded green "Saved"
   * unconditionally, which said "Saved" loudest exactly when nothing was.
   */
  const [pendingSave, setPendingSave] = useState(false);
  const [persistFailed, setPersistFailed] = useState(false);
  useEffect(() => {
    const sync = () => setPersistFailed(hasPersistFailure());
    sync();
    return subscribeDrafts(sync);
  }, []);
  const retrySave = useCallback(() => { retryPersist(); setPersistFailed(hasPersistFailure()); }, []);
  const saveState: "saved" | "saving" | "failed" = persistFailed ? "failed" : pendingSave ? "saving" : "saved";
  const draftSyncStatus = useSyncExternalStore(
    subscribePinDraftSyncStatus,
    getPinDraftSyncStatus,
    getPinDraftSyncStatus,
  );
  const syncIssue = useMemo(
    () => getPinDraftSyncIssue(draft.id),
    [draft.id, draft.updatedAt, draftSyncStatus],
  );
  const syncIssueNotice = syncIssue ? (
    <div data-testid="card-sync-action-required" role="alert" data-code={syncIssue.code}
      style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8, padding: "8px 10px", borderBottom: `1px solid ${BUI.border}`, background: "#fffbeb", color: "#92400e" }}>
      <span style={{ display: "inline-flex", alignItems: "flex-start", gap: 5, fontSize: 10.5, fontWeight: 700, lineHeight: 1.4 }}>
        <AlertTriangle style={{ width: 12, height: 12, flexShrink: 0, marginTop: 1 }} />
        {tr(syncIssue.userMessageKey as MessageKey)}
      </span>
      <button type="button" data-testid="card-sync-review" onClick={() => {
        props.onSetActive(draft.id);
        if (syncIssue.code.startsWith("destination_")) setDestinationsOpen(true);
      }} style={{ flexShrink: 0, border: 0, background: "none", color: BUI.purple, padding: 0, fontSize: 10.5, fontWeight: 800, cursor: "pointer", fontFamily: "inherit" }}>
        {tr("studioBoard.card.syncIssue.review")}
      </button>
    </div>
  ) : null;

  const persistNow = useCallback((f: PinFieldsValue) => {
    // Read the stored record FRESH (same contract as handlePublish): `persistNow` is
    // rebuilt on every render and the flush effect below runs the PREVIOUS one in its
    // cleanup, closed over the PREVIOUS draft. Computing intent from that closure would
    // let a board edit sitting in the debounce window overwrite whatever a concurrent
    // writer — the destination picker on this very card, AI copy, a sync — had just
    // stored. The prop is only a fallback for a draft the store no longer has.
    const current = getDraft(draft.id) ?? draft;
    const nextBoardId = f.boardId.trim();
    const storedDestinations = current.scheduledDestinations ?? [];
    // The board is the one field on this form that is ALSO a publish destination:
    // changing it here changes where this Content goes (owner decision, 2026-08-27).
    // Writing only the legacy board left the stored Pinterest entry — what the due-time
    // worker publishes to — on the old board, so the merchant read the new board off the
    // card while the Pin went somewhere else.
    //
    // The rest of the intent is still one fact with one writer: nothing here is
    // re-derived from picker state. `withBoardOnPinterestEntry` is a pure rewrite of the
    // STORED entries, and it runs ONLY when the board actually changed — a title
    // keystroke can never reach destinations.
    const boardChanged = nextBoardId !== (current.boardId ?? "").trim();
    // This path is only ever the user typing (AI copy is applied via applyCopy), so a
    // changed title / description / alt text is theirs: bulk Generate copy keeps it (T4).
    const copyTouched = manualCopyTouched(current, { title: f.title, description: f.description, altText: f.altText });
    props.onPersist(draft.id, {
      ...(copyTouched ? { metadataTouched: { ...EMPTY_TOUCHED, ...copyTouched } } : {}),
      title: f.title,
      description: f.description,
      destinationUrl: f.websiteUrl.trim(),
      boardId: f.boardId,
      boardName: boardName(f.boardId),
      altText: f.altText,
      tags: parseTags(f.tags),
      ...(boardChanged && storedDestinations.length
        ? {
            scheduledDestinations: withBoardOnPinterestEntry(
              storedDestinations,
              current.targetConnectionId,
              { boardId: nextBoardId, boardName: boardName(nextBoardId) },
            ),
          }
        : {}),
    });
  }, [props, draft.id, boardName]);

  const flush = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current); timer.current = null;
      persistNow(pendingRef.current);
      setPendingSave(false);
      setPersistFailed(hasPersistFailure());
    }
  }, [persistNow]);

  useEffect(() => () => { if (timer.current) { clearTimeout(timer.current); persistNow(pendingRef.current); } }, [persistNow]);

  const handleChange = useCallback((patch: Partial<PinFieldsValue>) => {
    selfEdit.current = true;
    const next = { ...pendingRef.current, ...patch };
    pendingRef.current = next;
    setFields(next);
    setPendingSave(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      persistNow(next);
      setPendingSave(false);
      setPersistFailed(hasPersistFailure());
    }, PERSIST_DEBOUNCE);
  }, [persistNow]);


  // ── Amazon link (T3) ──────────────────────────────────────────────────────
  // Only `amazonSource` is ever persisted from here; title / description / Website
  // URL stay the user's. Pending field edits are flushed first so the store write
  // (and the re-seed it triggers) can never drop a keystroke.
  const [amazonFetching, setAmazonFetching] = useState(false);
  const [amazonLastFetchAt, setAmazonLastFetchAt] = useState<number | null>(null);
  const [amazonHints, setAmazonHints] = useState<AmazonClaimHint[]>([]);
  const persistAmazonSource = useCallback((next: AmazonCardSource) => {
    props.onPersist(draft.id, { amazonSource: next });
  }, [props, draft.id]);
  const startAmazonFetch = useCallback(() => {
    setAmazonFetching(true);
    setAmazonLastFetchAt(Date.now());
    void runAmazonCardImport({
      getSource: () => getDraft(draft.id)?.amazonSource,
      persist: persistAmazonSource,
      importFn: fetchProductUrlImport,
    }).finally(() => setAmazonFetching(false));
  }, [draft.id, persistAmazonSource]);
  /** Recognise an Amazon link OR a manual-entry marketplace link (FR-04) in the saved
   *  URL; fetch once per newly pasted Amazon product. Marketplace links never fetch
   *  (fetch.status starts at "manual_only", not "not_attempted"), so this guard —
   *  unchanged — already excludes them; it only ever fires for real Amazon links. */
  const syncAmazonLink = useCallback((url: string, autoFetch: boolean) => {
    const current = getDraft(draft.id) ?? draft;
    const next = cardSourceForUrl(url, current.amazonSource);
    if (!next) return;
    if (next !== current.amazonSource) persistAmazonSource(next);
    if (autoFetch && next.fetch.status === "not_attempted" && next.linkStatus !== "no_asin") startAmazonFetch();
  }, [draft, persistAmazonSource, startAmazonFetch]);
  const handleUrlBlur = useCallback(() => {
    flush();
    syncAmazonLink(pendingRef.current.websiteUrl, true);
  }, [flush, syncAmazonLink]);
  // A saved Amazon or manual-marketplace URL without context (older draft, other
  // entry point) gets its context on mount — no automatic fetch either way; the
  // section offers the button (Amazon) or is already in manual mode (marketplace).
  useEffect(() => {
    if (draft.amazonSource || !isCardMarketplaceLink(draft.destinationUrl)) return;
    const seeded = cardSourceForUrl(draft.destinationUrl, undefined);
    if (seeded) persistAmazonSource(seeded);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.id]);
  const onAmazonManualChange = useCallback((patch: Partial<AmazonCardManual>) => {
    const current = (getDraft(draft.id) ?? draft).amazonSource;
    if (!current) return;
    flush();
    setAmazonHints([]);
    persistAmazonSource({ ...current, manual: { ...current.manual, ...patch } });
  }, [draft, flush, persistAmazonSource]);
  /** Clean-link chip (ruling 6): the Website URL changes only on this explicit click. */
  const acceptAmazonLink = useCallback((url: string) => {
    handleChange({ websiteUrl: url });
    flush();
    syncAmazonLink(url, true);
  }, [handleChange, flush, syncAmazonLink]);

  // ── Mixed Pinterest+Instagram single-video split (design T3) ────────────────
  // `draft` (not local `selectedProviders` state) is the read source: changeProviders/
  // changeAccounts persist to the store synchronously (persistDestinationSelection
  // above calls props.onPersist immediately, no debounce), so this reacts the instant
  // both platforms are ticked — same source `isMixedSingleVideo` reads server-side.
  // Declared here (ahead of doSchedule/doCustomSchedule below) rather than beside the
  // rest of the render-derived values further down, purely so those two callbacks can
  // close over it without a forward reference.
  const showInstagramCaptionInput = shouldShowInstagramCaptionInput(draft, { igFbHidden: igFbHidden() });
  const instagramCaptionErrors = showInstagramCaptionInput ? instagramCaptionIssues(instagramCaption) : [];

  // Actions flush pending edits first. An unresolvable destination blocks both:
  // scheduling or publishing with a half-recorded intent is how a three-platform
  // choice silently executed as Pinterest-only.
  const doSchedule = useCallback(() => {
    if (destinationError) return;
    if (showInstagramCaptionInput && instagramCaptionErrors.length) {
      setInstagramCaptionTouched(true);
      return;
    }
    flush();
    props.onSchedule(draft.id, showInstagramCaptionInput ? { instagramCaption } : undefined);
  }, [flush, props, draft.id, destinationError, showInstagramCaptionInput, instagramCaptionErrors, instagramCaption]);
  const doCustomSchedule = useCallback(() => {
    if (!customDate || !customTime) return;
    if (showInstagramCaptionInput && instagramCaptionErrors.length) {
      setInstagramCaptionTouched(true);
      return;
    }
    flush();
    setCustomTimeOpen(false);
    props.onCustomSchedule(draft.id, customDate, customTime, showInstagramCaptionInput ? { instagramCaption } : undefined);
  }, [customDate, customTime, draft.id, flush, props, showInstagramCaptionInput, instagramCaptionErrors, instagramCaption]);
  /**
   * Regenerate ONE image (PRD §7).
   *
   * The target is the SELECTED thumbnail, and selection is the cover — `setCoverMedia`
   * moves the picked item to media[0], so ContentMediaStrip's existing selection UI and
   * the cover invariant are the same fact. Building a second "selected media" state
   * here would let the highlighted thumbnail and the regenerated one drift apart, which
   * is the whole-set overwrite this replaces, one step removed.
   */
  const doGenerateAiImage = useCallback(() => {
    flush();
    props.onGenerateAiImage(draft, coverMedia(draft)?.id);
  }, [flush, props, draft]);

  /**
   * Media compatibility (PRD §9/§13). Recomputed from the `draft` prop, which the board
   * re-hands on every store write — so add/drop/remove/replace AND a destination change
   * all refresh this with no subscription of its own, and no chance of the notice
   * describing a media set the card is no longer showing.
   */
  const notices = useMemo(() => mediaNotices(draft), [draft]);
  const offendingIds = useMemo(() => collectOffendingMediaIds(notices), [notices]);
  /**
   * "Publish separately" — §13's alternative to Review & crop (the crop tool is
   * deferred). Splits the OFFENDING items into their own Contents, leaving this one
   * with a set its platforms accept. Never removes an image without creating the post
   * that carries it, and never unticks a platform.
   */
  const doSplitSeparate = useCallback(() => {
    flush();
    const ids = Array.from(offendingIds);
    const created = splitContentMedia(draft.id, ids.length ? ids : undefined);
    if (created.length) toast.success(tr("studioBoard.toast.splitCreated").replace("{n}", String(created.length)));
  }, [flush, draft.id, offendingIds, tr]);

  /**
   * Card-level drop target for a media drag from ANOTHER card (PRD §9).
   *
   * Before this, the only drop targets were the strip's own thumbnails, with a 2px
   * border as the only hint — a target the merchant had to find. The whole card now
   * accepts the payload and appends the copy at the end; dropping on a thumbnail still
   * inserts before it (the strip stops propagation), so the precise gesture survives.
   *
   * `dragDepth` is a COUNTER, not a boolean: dragenter/dragleave fire for every child
   * element crossed, so a boolean flickers the hint on and off as the pointer moves
   * across the card's own contents.
   */
  const [dragDepth, setDragDepth] = useState(0);
  const foreignDrag = useCallback((event: React.DragEvent) => {
    if (lifecycle === "posted") return false;
    // getData() is empty until the drop, so the source card is identified through the
    // module-level drag ref rather than the payload. Both must agree: our media type,
    // and a source that is not this card.
    if (!event.dataTransfer.types.includes(MEDIA_DRAG_TYPE)) return false;
    const source = currentDragSourceDraftId();
    return !!source && source !== draft.id;
  }, [draft.id, lifecycle]);
  const onCardDragEnter = useCallback((event: React.DragEvent) => {
    if (!foreignDrag(event)) return;
    event.preventDefault();
    setDragDepth(depth => depth + 1);
  }, [foreignDrag]);
  const onCardDragOver = useCallback((event: React.DragEvent) => {
    if (!foreignDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }, [foreignDrag]);
  const onCardDragLeave = useCallback(() => setDragDepth(depth => Math.max(0, depth - 1)), []);
  const onCardDrop = useCallback((event: React.DragEvent) => {
    if (lifecycle === "posted") return;
    setDragDepth(0);
    let payload: { sourceDraftId?: string; mediaId?: string } | null = null;
    try { payload = JSON.parse(event.dataTransfer.getData(MEDIA_DRAG_TYPE) || "null"); } catch { payload = null; }
    if (!payload?.sourceDraftId || !payload.mediaId || payload.sourceDraftId === draft.id) return;
    event.preventDefault();
    // No index: appended at the end. Copy, never move — the source card keeps its item,
    // which is what makes dragging a good image onto three Contents safe.
    copyMedia(payload.sourceDraftId, payload.mediaId, draft.id);
  }, [draft.id, lifecycle]);
  const showDropHint = dragDepth > 0;
  /**
   * Publish. `onlyPending` is the board default (Retry semantics); an explicit
   * republish of an edited Posted Content sends everything, because the point of that
   * action is to push the NEW content to every destination it names.
   */
  const doPublish = useCallback((options?: { onlyPending?: boolean }) => {
    if (destinationError) return;
    flush();
    props.onPublish(draft.id, options);
  }, [flush, props, draft.id, destinationError]);
  const collapse = useCallback(() => {
    if (aiRef.current?.isBusy()) return;
    flush();
    setEditing(false);
    props.onSetActive(null);
  }, [flush, props]);
  /** Enter/leave the card-local edit form. Leaving always flushes pending edits. */
  const startEditing = useCallback(() => {
    if (!canEnterCardEdit(lifecycle)) return;
    if (aiRef.current?.isBusy()) return;
    setEditing(true);
    props.onSetActive(draft.id);
  }, [props, draft.id, lifecycle]);
  const stopEditing = useCallback(() => {
    if (aiRef.current?.isBusy()) return;
    flush();
    setEditing(false);
    props.onSetActive(null);
  }, [flush, props]);
  const publishEntryNotice = props.publishEntryIssue ? (
    <div data-testid="card-publish-entry-issue" role="alert" data-code={props.publishEntryIssue}
      style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8, padding: "8px 10px", borderBottom: `1px solid ${BUI.border}`, background: "#fffbeb", color: "#92400e" }}>
      <span style={{ display: "inline-flex", alignItems: "flex-start", gap: 5, fontSize: 10.5, fontWeight: 700, lineHeight: 1.4 }}>
        <AlertTriangle style={{ width: 12, height: 12, flexShrink: 0, marginTop: 1 }} />
        {tr(props.publishEntryIssue === "image_unavailable"
          ? "studioBoard.card.publishBlocked.imageUnavailable"
          : "studioBoard.card.publishBlocked.fieldTooLong")}
      </span>
      <button type="button" data-testid="card-publish-entry-review" onClick={startEditing}
        style={{ flexShrink: 0, border: 0, background: "none", color: BUI.purple, padding: 0, fontSize: 10.5, fontWeight: 800, cursor: "pointer", fontFamily: "inherit" }}>
        {tr("studioBoard.card.publishBlocked.review")}
      </button>
    </div>
  ) : null;
  /**
   * THE destination writer: the merchant's platform/account choice, frozen into
   * `scheduledDestinations` — the same record the due-time worker reads.
   *
   * A platform with several connected accounts and no explicit pick is NOT written.
   * `resolveScheduledAccount` throws for exactly that case, and `buildScheduledDestinations`
   * would otherwise drop the provider silently: the merchant would tick Instagram, see
   * it ticked, and get nothing. It surfaces as a field error instead, and Publish /
   * Schedule stay blocked for this Content until an account is chosen. The other
   * unresolvable case — no connected account, or an explicit pick that has since been
   * disconnected — returns null and is reported the same way, never silently dropped.
   */
  const persistDestinationSelection = useCallback((providers: PublishProvider[], accounts: SelectedAccount[]) => {
    let error = "";
    const picks: DestinationPick[] = [];
    for (const provider of providers) {
      const platform = connectionSummaries.find(summary => summary.provider === provider);
      const platformAccounts = platform?.accounts ?? [];
      const chosen = accounts.filter(item => item.provider === provider);
      if (chosen.length) {
        // Every account ticked on this platform is its own destination.
        for (const item of chosen) {
          picks.push({
            provider,
            socialConnectionId: item.id,
            ...(provider === "pinterest"
              ? { boardId: item.boardId ?? "", boardName: item.boardName ?? "" }
              : {}),
          });
        }
        continue;
      }
      // No account narrowed: only legitimate when exactly one is connected. With
      // several, resolveScheduledAccount throws and we refuse the selection rather
      // than picking one — the merchant would see the platform ticked and get a
      // publish to whichever account happened to be first.
      try {
        const resolved = resolveScheduledAccount(provider, platformAccounts, null);
        if (!resolved) {
          if (!error) error = tr("studioBoard.toast.ambiguousAccount").replace("{platform}", platformName(provider));
          continue;
        }
        picks.push({
          provider,
          socialConnectionId: resolved.id,
          // The card's own board field IS the first Pinterest entry's board.
          ...(provider === "pinterest" ? { boardId: fields.boardId, boardName: boardName(fields.boardId) } : {}),
        });
      } catch (err) {
        if (err instanceof AmbiguousScheduleAccountError && !error) {
          error = tr("studioBoard.toast.ambiguousAccount").replace("{platform}", platformName(provider));
        }
      }
    }
    const destinations = buildScheduledDestinations(
      picks,
      { ...draft, boardId: fields.boardId, boardName: boardName(fields.boardId) },
      provider => connectionSummaries.find(summary => summary.provider === provider)?.accounts ?? [],
    );
    setDestinationError(error);
    // The legacy Pinterest mirror follows the FIRST Pinterest entry, in the same write:
    // an un-migrated reader (plan drawer, admin, older cron) can never see a target the
    // intent record does not name.
    props.onPersist(draft.id, { scheduledDestinations: destinations, ...legacyPinterestMirror(destinations) });
  }, [props, draft, fields.boardId, boardName, connectionSummaries, tr]);
  const changeProviders = useCallback((next: SocialProvider[]) => {
    const supported = next.filter((provider): provider is PublishProvider => provider === "pinterest" || provider === "instagram" || provider === "facebook");
    setSelectedProviders(supported);
    // Unticking a platform drops its account picks too, so a re-tick cannot resurrect
    // an account the merchant removed (§18: unchecking clears that entry).
    const kept = selectedAccountIds.filter(a => supported.some(p => p === a.provider));
    if (kept.length !== selectedAccountIds.length) setSelectedAccountIds(kept);
    persistDestinationSelection(supported, kept);
  }, [persistDestinationSelection, selectedAccountIds]);
  const changeAccounts = useCallback((next: SelectedAccount[]) => {
    setSelectedAccountIds(next);
    persistDestinationSelection(selectedProviders, next);
  }, [persistDestinationSelection, selectedProviders]);

  // Quality Judge (Phase C): ONLY an `invalid` verdict changes the card — it renders the
  // image collapsed/dimmed until the user clicks "Show anyway". ok/borderline/pending/failed
  // look identical to an unjudged card. Reveal is remembered on the draft (userOverride).
  const judge = draft.qualityJudge;
  const hiddenByQuality = judge?.status === "ready" && judge.verdict === "invalid" && !judge.userOverride;
  const showAnyway = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    const j = draft.qualityJudge;
    if (!j) return;
    props.onPersist(draft.id, { qualityJudge: { ...j, userOverride: true } });
    track("generation_kept", { draftId: draft.id });
  }, [props, draft.id, draft.qualityJudge]);

  // ── Recommended-keyword chips (compact card) ────────────────────────────────
  // Remove a chip: drop it from recommendedKeywords + remember the removal in
  // creativeSelections.removedKeywords (deduped) so it never re-surfaces. Never opens
  // the card (stopPropagation).
  const removeKeyword = useCallback((e: React.MouseEvent, kw: string) => {
    e.stopPropagation();
    const nextKeywords = (draft.recommendedKeywords ?? []).filter(k => k !== kw);
    const prevSel = draft.creativeSelections ?? {};
    const removed = Array.from(new Set([...(prevSel.removedKeywords ?? []), kw]));
    props.onPersist(draft.id, {
      recommendedKeywords: nextKeywords,
      creativeSelections: { ...prevSel, removedKeywords: removed },
    });
    track("keyword_removed", { draftId: draft.id, keyword: kw });
  }, [props, draft.id, draft.recommendedKeywords, draft.creativeSelections]);

  // Copy the keyword text; flash "Copied" on that chip for 1.2s (no toast dependency).
  const copyKeyword = useCallback((e: React.MouseEvent, kw: string) => {
    e.stopPropagation();
    try { void navigator.clipboard?.writeText(kw); } catch { /* clipboard blocked — non-fatal */ }
    setCopiedKw(kw);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => { copyTimer.current = null; setCopiedKw(null); }, 1200);
  }, []);
  useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current); }, []);

  // Shared AI Copy panel: apply generated copy back to the draft (same fields the old
  // inline handler wrote). fields re-seed from draft.updatedAt after this persists.
  // PRD 7.3 fill-in-the-blank: only overwrite title/description that were empty
  // before this run, unless the user explicitly confirmed a full replace (panel
  // only sets confirmedReplace when it asked and the user chose "Replace with AI
  // copy"). altText only ever fills when empty — never confirmed-replaced, since
  // the confirm copy talks about title/description only. Compares against `fields`
  // (the on-screen values the panel itself was seeded with), not the possibly-stale
  // `draft`, so this agrees with what the panel used for its own fill-state check.
  const applyCopy = useCallback((r: PinAICopyResult) => {
    setAmazonHints([]);
    // A title that is still the upload file name counts as empty (same as bulk).
    const prevTitle = copyInputTitle(draft, fields.title);
    const prevDescription = fields.description;
    const prevAltText = fields.altText;
    const nextTitle = r.confirmedReplace || !prevTitle.trim() ? r.title : prevTitle;
    const nextDescription = r.confirmedReplace || !prevDescription.trim() ? r.description : prevDescription;
    const nextAltText = prevAltText.trim() ? prevAltText : r.altText;
    props.onPersist(draft.id, {
      title: nextTitle,
      description: nextDescription,
      altText: nextAltText,
      destinationUrl: draft.destinationUrl || r.destinationUrl,
      tags: r.tags.length ? r.tags : draft.tags,
      metadataDraft: r.metadataDraft,
    });
    setCopyGeneratedForUrl((fields.websiteUrl || draft.destinationUrl || r.destinationUrl || "").trim());
  }, [props, draft, fields.title, fields.description, fields.altText, fields.websiteUrl]);
  // A "failed" card is either a PUBLISH failure (had a real schedule attempt) or a
  // GENERATION failure (AI Pin never finished) — same lifecycle value, different
  // recovery paths (mirrors handleTryAgain's own branch upstream). Computed before
  // `status` so the badge override below can use it.
  const firstDestinationFailure = destinationNeedsAttention(draft)[0];
  const isPublishFailure = isActionablePublishFailure(draft);
  const failureCategory = draft.errorCategory ?? (isPublishFailure ? mapPublishErrorToCategory(
    draft.publishErrorCode || firstDestinationFailure?.errorCode,
    draft.publishError || firstDestinationFailure?.errorMessage,
  ) : undefined);
  // SAFE reason line. `draft.publishError` holds the RAW upstream message (cron/batch
  // paths store err.message straight from the Pinterest API) — it must never reach the
  // DOM. We render a fixed, translated sentence instead; the raw string stays on the
  // draft for internal diagnostics (support context / logs).
  //   publish failure  → category-chosen sentence (publishErrorDisplay, never raw)
  //   generation failure → its own fixed sentence (no upstream text to leak)
  // Never empty, so a failed card can never render a reason box with no reason in it.
  const failureReasonText = isPublishFailure || draft.publishError?.trim() || firstDestinationFailure
    ? tr(getPublishErrorDisplayKey({
        publishError: draft.publishError || firstDestinationFailure?.errorMessage,
        errorCategory: draft.errorCategory,
        publishErrorCode: draft.publishErrorCode || firstDestinationFailure?.errorCode,
      }))
    : tr("studioBoard.card.generationError.generic");

  // THE derivation of what this card shows. Every variant/action/result decision
  // below reads this one object rather than re-deriving lifecycle facts per branch.
  const view = useMemo(() => buildCardViewModel(draft, lifecycle, { editing }), [draft, lifecycle, editing]);

  // "AI generated" is a property of the IMAGE on screen, so it reads the cover's own
  // source (upload/ai/product) and only falls back to the draft-level source for the
  // legacy single-image drafts that have no media[].
  const cover = coverMedia(draft);
  const singleVideo = cover?.kind === "video" && contentMedia(draft).length === 1 ? cover : null;
  const isAiSourced = cover?.source === "ai" || (!cover?.source && draft.source === "ai_generated_from_upload");

  const nextStep = nextStepFor(
    draft.errorCategory ?? (isPublishFailure ? mapPublishErrorToCategory(
      draft.publishErrorCode || firstDestinationFailure?.errorCode,
      draft.publishError || firstDestinationFailure?.errorMessage) : undefined),
    draft.publishErrorCode || firstDestinationFailure?.errorCode,
  );

  // Draft cards edit in place; scheduled/posted/failed stay compact until Edit.
  const cardPresentation = studioCardPresentation(lifecycle);
  const compactFields = cardPresentation.fieldsVisible;
  const cardFieldsEditable = cardPresentation.fieldsEditable;

  const status = getStatusBadge(draft);
  // Badge copy override for the failed lifecycle only (PRD "失败情况优化" §5): the
  // shared getStatusBadge() in pinLifecycle.ts still returns the generic "Failed" —
  // overridden here rather than in the shared helper since PinBoardCard is its only
  // caller and already computes isPublishFailure for the action matrix below.
  const statusLabel = status.lifecycle === "failed"
    ? tr(isPublishFailure ? "studioBoard.card.publishFailedBadge" : "studioBoard.card.generationFailedBadge")
    : status.lifecycle === "needs_attention"
      ? tr("studioBoard.card.needsAttention")
      : status.label;
  const publishing = props.publishing;
  // Amazon OR manual-entry marketplace card (FR-04) without a product name:
  // generation is gated (design §2.3, extended to marketplace cards by the same
  // rule — no name, no grounded copy). The section explains why and hosts the field
  // that unlocks it.
  const amazonNeedsName = isMarketplaceCardDraft(draft) && !canGenerateAmazonCopy(draft.amazonSource);
  const amazonSectionSource = draft.amazonSource && draft.amazonSource.pastedUrl === fields.websiteUrl.trim() && isCardMarketplaceLink(fields.websiteUrl)
    ? draft.amazonSource : null;
  const cardMarketplace = classifyCardMarketplace(fields.websiteUrl);
  // #ad affiliate disclosure is an AMAZON-specific compliance requirement (Amazon
  // Associates policy) — it does not apply to the manual-entry marketplaces, so this
  // stays gated on isAmazonLink specifically, not the broader marketplace predicate.
  const amazonDisclosureMissing = !!amazonSectionSource && isAmazonLink(fields.websiteUrl) && !!fields.description.trim() && !hasAffiliateDisclosure(fields.description);
  const copyState: LinkCopyState = copyBusy ? "busy"
    : copyGeneratedForUrl !== null && copyGeneratedForUrl === fields.websiteUrl.trim() ? "generated"
    : copyGeneratedForUrl !== null || !!draft.metadataDraft?.copyGenerationMeta ? "stale"
    : "idle";
  // hideTrigger: the compact card triggers copy from its link field; the expanded
  // editor keeps the panel's own button.
  const aiCopyPanel = (hideTrigger = false) => (
    <PinAICopyPanel
      ref={aiRef}
      compact
      hideTrigger={hideTrigger}
      draftId={draft.id} imageUrl={draft.imageUrl}
      title={copyInputTitle(draft, fields.title)} description={fields.description} altText={fields.altText}
      boardId={draft.boardId} boardName={draft.boardName}
      category={draft.category} keyword={draft.keyword} destinationUrl={draft.destinationUrl}
      setupSnapshot={draft.setupSnapshot} promptSnapshot={draft.promptSnapshot} opportunity={draft.opportunity}
      imageSummary={draft.imageSummary} recommendedKeywords={draft.recommendedKeywords}
      boards={boards}
      analysisStatus={draft.imageAnalysisStatus} keywordStatus={draft.keywordStatus}
      hasGeneratedBefore={!!draft.metadataDraft?.copyGenerationMeta}
      disabled={publishing || !cardFieldsEditable || amazonNeedsName}
      onBeforeGenerate={flush}
      onBusyChange={(busy) => { setCopyBusy(busy); props.onAiCopyBusyChange(draft.id, busy); }}
      onApplyCopy={applyCopy}
      onGenerateError={(error) => setAmazonHints(amazonClaimHints((error as { validationReport?: Parameters<typeof amazonClaimHints>[0] })?.validationReport))}
    />
  );
  const posted = lifecycle === "posted";
  const failed = lifecycle === "failed";
  const needsAttention = lifecycle === "needs_attention" || failed;
  const destinationResults = contentDestinationResults(draft);
  // Chips represent only an explicit, saved publishing decision. The broader
  // contentDestinations() projection intentionally keeps legacy Board-only rows alive
  // for historical results, but presenting that projection here made "Home Decor"
  // look like an account-backed destination while confirmation correctly saw zero.
  const destinations = explicitPublishDestinations(draft);
  // A retry without a Pinterest board cannot be confirmed. Keep recovery in the
  // inline editor, where the destination picker and Board field are visible.
  const destinationNeedsSetup = !destinations.length || destinations.some(destination =>
    destination.provider === "pinterest" && !destination.boardId?.trim(),
  );
  const scheduled = lifecycle === "scheduled";
  const generating = lifecycle === "generating";
  const editAriaLabel = `${tr("studioBoard.actions.edit")}: ${draft.title?.trim() || tr("studioBoard.card.untitledPin")}`;
  // showInstagramCaptionInput/instagramCaptionErrors are declared earlier (ahead of
  // doSchedule/doCustomSchedule) — reused here for the field-level error text and the
  // child-field gating below.
  const instagramCaptionError = instagramCaptionTouched && instagramCaptionErrors.length
    ? (instagramCaptionErrors.includes("instagram_caption_contains_link")
        ? tr("studioBoard.card.instagramCaption.errorLink")
        : tr("studioBoard.card.instagramCaption.errorRequired"))
    : "";
  const isInstagramCaptionChild = draft.copyProfile === "instagram_caption";
  // Prefers the real Pinterest URL captured at publish time; reconstructs from
  // remotePinId only for legacy drafts published before remotePinUrl existed.
  const pinUrl = draft.remotePinUrl || (draft.remotePinId ? `https://www.pinterest.com/pin/${draft.remotePinId}/` : "");
  // Non-Pinterest platforms this Pin also went live on (Facebook Page today).
  // Written by the publish fan-out (/api/publish/social → draft.socialPosts), so
  // the links survive a reload. Entries without a real permalink are dropped —
  // a missing URL renders no button rather than a dead link.
  const socialPostRefs = (draft.socialPosts ?? []).filter(p => p.postUrl?.trim());
  // "View on Facebook" etc. Reuses the existing "View on Pinterest" catalog string
  // with the platform name swapped in, so no English-only key is added to the 18
  // locale catalogs. Falls back to appending the platform if the string changes.
  const viewOnLabel = (provider: string): string => {
    const base = tr("pinDetails.viewOnPinterest");
    const target = platformName(provider as SocialProvider);
    const pinterest = platformName("pinterest");
    return base.includes(pinterest) ? base.replace(pinterest, target) : `${base} — ${target}`;
  };
  const linkedProduct = (draft.linkedProducts ?? []).find(product => product.productId === draft.primaryProductId)
    ?? draft.linkedProducts?.[0]
    ?? null;
  const schedLabel = scheduledSummary(draft);
  // Recommended high-search Pinterest keywords (only real, ready results — no empty
  // shell, no loading state, capped at 8). NEVER labeled "Trending" (data honesty).
  const keywordChips = draft.keywordStatus === "ready" ? (draft.recommendedKeywords ?? []).slice(0, 8) : [];

  const badges = (
    <div style={{ position: "absolute", top: props.onSelectedChange ? 43 : 8, left: 8, display: "flex", flexDirection: "column", gap: 5, alignItems: "flex-start" }}>
      {lifecycle !== "unscheduled" && (
        <span data-testid="card-status-badge" style={{ fontSize: 10, fontWeight: 800, color: "#fff", background: toneColor[status.tone] ?? BUI.textSec, borderRadius: 999, padding: "3px 9px", display: "inline-flex", alignItems: "center", gap: 4 }}>
          {publishing && <Loader2 style={{ width: 10, height: 10 }} className="animate-spin" />}{statusLabel}
        </span>
      )}
    </div>
  );

  const selectionControl = props.onSelectedChange ? (
    <button type="button" data-testid="card-select" aria-label={props.selected ? "Deselect content" : "Select content"}
      aria-pressed={!!props.selected}
      onClick={event => { event.stopPropagation(); props.onSelectedChange?.(draft.id, !props.selected); }}
      style={{ position: "absolute", zIndex: 5, top: 8, left: 8, width: 27, height: 27, padding: 0, display: "grid", placeItems: "center",
        borderRadius: 8, border: props.selected ? `1px solid ${BUI.purple}` : "1px solid rgba(255,255,255,.7)",
        background: props.selected ? BUI.purple : "rgba(15,23,42,.62)", color: "#fff", cursor: "pointer", boxShadow: "0 3px 10px rgba(15,23,42,.16)" }}>
      {props.selected ? <Check style={{ width: 15, height: 15 }} /> : <span style={{ width: 12, height: 12, border: "1.5px solid rgba(255,255,255,.9)", borderRadius: 3 }} />}
    </button>
  ) : null;

  // PRD card action matrix — More menu items per lifecycle. Generating renders NO
  // More menu at all. Every item stops at the menu (fixed backdrop) so a click never
  // opens/edits the card.
  const menuItems: Array<{ id: string; label: string; danger?: boolean }> =
    (lifecycle === "failed" || lifecycle === "needs_attention") ? (isPublishFailure ? [
      { id: "move-to-unscheduled", label: tr("studioBoard.menu.moveToUnscheduled") },
      { id: "delete", label: tr("studioBoard.menu.delete"), danger: true },
    ] : [
      { id: "regenerate", label: tr("studioBoard.menu.regenerate") },
      { id: "delete", label: tr("studioBoard.menu.delete"), danger: true },
    ]) : lifecycle === "scheduled" ? [
      { id: "duplicate", label: tr("studioBoard.menu.duplicate") },
      { id: "download", label: tr("studioBoard.menu.download") },
      { id: "unschedule", label: tr("studioBoard.menu.unschedule") },
    ] : lifecycle === "posted" ? [
      { id: "download", label: tr("studioBoard.menu.download") },
      { id: "save-reference", label: tr("studioBoard.menu.saveAsReference") },
      { id: "archive", label: tr("studioBoard.menu.archive") },
    ] : [ // unscheduled
      { id: "publish", label: tr("studioBoard.menu.publishNow") },
      { id: "duplicate", label: tr("studioBoard.menu.duplicate") },
      { id: "download", label: tr("studioBoard.menu.download") },
      { id: "delete", label: tr("studioBoard.menu.delete"), danger: true },
    ];

  const runMenuAction = useCallback((id: string) => {
    switch (id) {
      case "move-to-unscheduled": props.onMoveToUnscheduled(draft.id); break;
      case "delete": props.onDelete(draft); break;
      case "regenerate": props.onTryAgain(draft); break;
      case "duplicate": props.onDuplicate(draft.id); break;
      case "download": props.onDownload(draft); break;
      case "unschedule": props.onUnschedule(draft.id); break;
      case "save-reference": props.onSaveAsReference(draft); break;
      case "archive": props.onArchive(draft); break;
      case "publish": doPublish(); break;
    }
  }, [doPublish, draft, props]);

  const moreMenu = lifecycle === "generating" ? null : (
    <div style={{ position: "absolute", top: 8, right: 8 }}>
      <button type="button" data-testid="card-more" aria-label={tr("studioBoard.card.moreActionsAria")} onClick={() => setMenuOpen(o => !o)}
        style={{ width: 30, height: 30, borderRadius: 8, border: "none", background: "rgba(15,23,42,0.72)", color: "#fff", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <MoreVertical style={{ width: 15, height: 15 }} />
      </button>
      {menuOpen && (
        <>
          <div style={{ position: "fixed", inset: 0, zIndex: 20 }} onClick={() => setMenuOpen(false)} />
          <div style={{ position: "absolute", right: 0, top: "calc(100% + 4px)", zIndex: 21, minWidth: 172, background: BUI.surface, border: `1px solid ${BUI.borderHi}`, borderRadius: 10, boxShadow: "0 12px 32px rgba(15,23,42,0.18)", overflow: "hidden" }}>
            {menuItems.map((item, i) => (
              <button key={item.id} type="button" data-testid={`card-menu-${item.id}`}
                onClick={() => { setMenuOpen(false); runMenuAction(item.id); }}
                style={menuItemStyle(i > 0, !!item.danger)}>
                {item.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );

  /**
   * One destination line. The reason on a failed row is ALWAYS the customer-safe
   * sentence from publishErrorDisplay — `errorMessage` holds the raw upstream text
   * (Pinterest API internals, ids) and must never reach the DOM. A link is offered
   * only for a published row that really has a permalink.
   */
  const renderResultRow = (row: CardResultRow, index: number) => (
    <li key={`${row.destinationId}:${index}`} data-testid="card-result-row" data-status={row.status}
      style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", padding: "5px 0", fontSize: 11, color: BUI.textSec, listStyle: "none",
        opacity: row.superseded ? 0.72 : 1 }}>
      <span style={{ fontWeight: 750, color: BUI.text }}>{platformName(row.provider as SocialProvider)}</span>
      {row.accountLabel && <span style={{ color: BUI.textMuted }}>{row.accountLabel}</span>}
      <span style={{ color: BUI.textMuted }}>—</span>
      <span style={{ fontWeight: 700, color: row.status === "published" ? BUI.success : row.status === "failed" || row.status === "delivery_unknown" ? BUI.warning : BUI.textMuted }}>
        {tr(row.status === "published" ? "studioBoard.card.resultPublished"
          : row.status === "failed" ? "studioBoard.card.resultFailed"
          : row.status === "delivery_unknown" ? "publishResults.deliveryUnknown"
          : "studioBoard.card.resultPending")}
      </span>
      {row.status === "failed" && (
        <span data-testid="card-result-reason" style={{ color: BUI.textSec }}>
          · {tr(getPublishErrorDisplayKey({ publishError: row.errorMessage, publishErrorCode: row.errorCode }))}
        </span>
      )}
      {row.status === "delivery_unknown" && <span data-testid="card-result-recovery" style={{ color: BUI.textSec }}>· {tr("publishResults.recoveryHint")}</span>}
      {row.postUrl && (
        <a data-testid="card-result-link" href={row.postUrl} target="_blank" rel="noopener noreferrer"
          style={{ display: "inline-flex", alignItems: "center", gap: 3, color: BUI.purple, fontWeight: 700, textDecoration: "none" }}>
          {tr("studioBoard.card.viewOn").replace("{platform}", platformName(row.provider as SocialProvider))}
          <ExternalLink style={{ width: 10, height: 10 }} />
        </a>
      )}
    </li>
  );

  /** "Published 3h ago" — from the newest publishedAt across all destinations. */
  const relative = relativePublishedParts(view.latestPublishedAt);
  const publishedRelativeLabel = relative
    ? tr("studioBoard.card.publishedRelative").replace("{when}", relative.unit === "now"
        ? tr("studioBoard.card.relative.now")
        : tr(relative.unit === "minute" ? "studioBoard.card.relative.minutes"
            : relative.unit === "hour" ? "studioBoard.card.relative.hours"
            : "studioBoard.card.relative.days").replace("{n}", String(relative.value)))
    : "";

  /** Light save-state text at the BOTTOM of the card (PRD §1) — the real status. */
  const saveStateLine = (
    <div data-testid="card-save-state" data-state={saveState}
      style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 10, fontWeight: 600, color: saveState === "failed" ? BUI.warning : BUI.textMuted }}>
      {saveState === "failed" ? (
        <>
          {tr("studioBoard.card.saveState.failed")} ·{" "}
          <button type="button" data-testid="card-save-retry" onClick={retrySave}
            style={{ border: 0, background: "none", padding: 0, color: BUI.purple, fontSize: 10, fontWeight: 750, cursor: "pointer", fontFamily: "inherit" }}>
            {tr("studioBoard.card.saveState.retry")}
          </button>
        </>
      ) : tr(saveState === "saving" ? "studioBoard.card.saveState.saving" : "studioBoard.card.saveState.saved")}
    </div>
  );


  /** Posted card: the per-platform summary + the expandable result list (PRD §3). */
  const resultsBlock = (view.resultRows.length > 0 || view.earlierResultRows.length > 0) ? (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <button type="button" data-testid="card-view-results" aria-expanded={resultsOpen}
        onClick={() => setResultsOpen(open => !open)}
        style={{ alignSelf: "flex-start", border: 0, background: "none", padding: 0, color: BUI.purple, fontSize: 11, fontWeight: 750, cursor: "pointer", fontFamily: "inherit" }}>
        {tr(resultsOpen ? "studioBoard.actions.hideResults" : "studioBoard.actions.viewResults")}
      </button>
      {resultsOpen && (
        <ul data-testid="card-results-list" style={{ margin: 0, padding: 0, display: "flex", flexDirection: "column" }}>
          {view.resultRows.map(renderResultRow)}
          {view.earlierResultRows.length > 0 && (
            <li style={{ listStyle: "none", marginTop: 6 }}>
              <span data-testid="card-earlier-publishes" style={{ ...labelStyle, display: "block" }}>{tr("studioBoard.card.earlierPublishes")}</span>
              <ul style={{ margin: 0, padding: 0 }}>{view.earlierResultRows.map(renderResultRow)}</ul>
            </li>
          )}
        </ul>
      )}
    </div>
  ) : null;

  // ── Compact (default) ─────────────────────────────────────────────────────────
  if (!active) {
    return (
      <div data-testid="pin-board-card" data-active="false" data-source={draft.source} data-lifecycle={lifecycle}
        onDragEnter={onCardDragEnter} onDragOver={onCardDragOver} onDragLeave={onCardDragLeave} onDrop={onCardDrop}
        style={{ position: "relative", display: "flex", flexDirection: "column", background: BUI.surface, border: `1px solid ${showDropHint ? BUI.purple : props.selected ? BUI.purple : BUI.border}`, borderRadius: STUDIO_UI.cardRadius, overflow: "hidden", boxShadow: props.selected ? "0 0 0 2px rgba(124,58,237,.12)" : "0 1px 2px rgba(15,23,42,0.04)" }}>
        {/* The whole card is a drop target for media dragged from ANOTHER card, not
            just the strip's thumbnails. Shown only for a foreign payload — the source
            card must never invite a drop of the item it already holds. */}
        {showDropHint && (
          <div data-testid="card-drop-hint" style={{ position: "absolute", inset: 0, zIndex: 30, display: "grid", placeItems: "center",
            background: "rgba(124,58,237,0.12)", border: `2px dashed ${BUI.purple}`, borderRadius: STUDIO_UI.cardRadius, pointerEvents: "none", backdropFilter: "blur(1px)" }}>
            <span style={{ padding: "6px 12px", borderRadius: 999, background: BUI.purple, color: "#fff", fontSize: 11, fontWeight: 800 }}>
              {tr("studioBoard.card.dropHint")}
            </span>
          </div>
        )}
        <div data-testid="card-media" className="group" style={{ position: "relative", width: "100%", minHeight: 180, aspectRatio: intrinsicAspectRatio, background: BUI.surface3 }}>
          {failed && !isPublishFailure ? (
            // Generation-failure card: walk the original-image fallback chain
            // (generated → source → parent) instead of the raw draft.imageUrl, which
            // may be empty (scratch mode) or a dead snapshot. Never blank/broken.
            <PinCardMedia draft={draft} alt={draft.altText || draft.title || tr("studioBoard.card.pinImageAlt")}
              placeholderVariant="generationFailed" generating={generating} hiddenByQuality={hiddenByQuality} onIntrinsicSize={onIntrinsicSize} />
          ) : (coverMedia(draft)?.kind === "video" || resolveInitialFailureMediaUrl(draft)) ? (
            // Publish-failed / healthy cards: same chain, starting at draft.imageUrl
            // (so a genuinely valid final image is always preferred) but falling
            // through source/product/reference/parent — and ultimately the neutral
            // "No image" placeholder — instead of a broken image or a solid-color
            // junk block when imageUrl is dead or degenerate.
            <PinCardMedia draft={draft} alt={draft.altText || draft.title || tr("studioBoard.card.pinImageAlt")}
              placeholderVariant="noImage" generating={generating} hiddenByQuality={hiddenByQuality} onIntrinsicSize={onIntrinsicSize} />
          ) : (
            <div data-testid={generating ? "card-generating-placeholder" : "card-fallback-placeholder"} style={{ width: "100%", height: "100%" }}>
              <PinFallbackArtwork busy={generating} />
            </div>
          )}
          {selectionControl}
          {hiddenByQuality && (
            <div data-testid="card-quality-hidden" style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column",
              alignItems: "center", justifyContent: "center", gap: 8, padding: 12, textAlign: "center",
              background: "rgba(15,23,42,0.42)", backdropFilter: "blur(2px)" }}>
              <span style={{ fontSize: 11.5, fontWeight: 800, color: "#fff", textShadow: "0 1px 3px rgba(0,0,0,0.5)" }}>
                {tr("studioBoard.card.qualityHiddenTitle")}
              </span>
              <span style={{ fontSize: 10, fontWeight: 600, lineHeight: 1.35, color: "rgba(255,255,255,0.88)", maxWidth: 220, textShadow: "0 1px 3px rgba(0,0,0,0.5)" }}>
                {tr("studioBoard.card.qualityHiddenBody")}
              </span>
              <button type="button" data-testid="card-show-anyway" onClick={showAnyway}
                style={{ padding: "6px 14px", borderRadius: 8, border: "1px solid rgba(255,255,255,0.55)",
                  background: "rgba(255,255,255,0.16)", color: "#fff", fontSize: 11.5, fontWeight: 700,
                  cursor: "pointer", fontFamily: "inherit", backdropFilter: "blur(4px)" }}>
                {tr("studioBoard.card.showAnyway")}
              </button>
            </div>
          )}
          {badges}
          {moreMenu}
          {/* "1 / N" — the cover IS media[0], so the current index is always 1. */}
          {view.counter && !generating && (
            <span data-testid="card-media-counter" style={{ position: "absolute", bottom: 8, right: 8, fontSize: 10, fontWeight: 800,
              color: "#fff", background: "rgba(15,23,42,0.72)", borderRadius: 999, padding: "3px 8px", backdropFilter: "blur(4px)" }}>
              {view.counter}
            </span>
          )}
          {/* The ONLY marker allowed on top of the image besides status (PRD §1: no
              badge pile) — and only when the image really came from generation. */}
          {isAiSourced && !hiddenByQuality && !generating && (
            <span data-testid="card-ai-marker" style={{ position: "absolute", bottom: 8, left: 8, display: "inline-flex", alignItems: "center", gap: 3,
              fontSize: 9.5, fontWeight: 700, color: "rgba(255,255,255,0.92)", background: "rgba(15,23,42,0.45)", borderRadius: 999, padding: "2px 7px", backdropFilter: "blur(3px)" }}>
              <Sparkles style={{ width: 9, height: 9 }} /> {tr("studioBoard.card.aiGenerated")}
            </span>
          )}
          {props.topPick && !hiddenByQuality && !generating && (
            <span data-testid="card-top-pick" style={{ position: "absolute", bottom: 8, left: 8, display: "inline-flex", alignItems: "center", gap: 4, fontSize: 10, fontWeight: 800, color: "#fff", background: "rgba(124,58,237,0.92)", borderRadius: 999, padding: "3px 9px", backdropFilter: "blur(4px)" }}>
              <Star style={{ width: 10, height: 10, fill: "#fff" }} /> {tr("studioBoard.card.topPick")}
            </span>
          )}
          {/* A lone video: "Edit cover image" appears inside the preview on hover. */}
          {!generating && singleVideo && (
            <VideoCoverEditButton draftId={draft.id} media={singleVideo} disabled={publishing || !cardFieldsEditable} />
          )}
        </div>
        {/* A lone video has nothing to reorder or add, so it gets no media strip. */}
        {!generating && !singleVideo && <ContentMediaStrip draft={draft} disabled={publishing || !cardFieldsEditable} offendingMediaIds={offendingIds} />}
        {/* Media compatibility (PRD §9/§13): ONE compact amber line per platform that
            refuses this set, directly under the images it is about. It reports and
            offers a way out — it never removes an image and never unticks a platform,
            because both throw away a choice the merchant made deliberately. */}
        {!generating && notices.length > 0 && (
          <div data-testid="card-media-notice" style={{ display: "flex", flexDirection: "column", gap: 4, padding: "8px 10px", borderBottom: `1px solid ${BUI.border}`, background: "#fffbeb" }}>
            {notices.map(notice => (
              <p key={notice.provider} data-testid="card-media-notice-line" data-provider={notice.provider} data-code={notice.code}
                style={{ margin: 0, display: "flex", alignItems: "flex-start", gap: 5, fontSize: 10.5, fontWeight: 750, lineHeight: 1.4, color: "#b45309" }}>
                <AlertTriangle style={{ width: 11, height: 11, flexShrink: 0, marginTop: 1.5 }} />
                {mediaNoticeText(tr, notice)}
              </p>
            ))}
            <button type="button" data-testid="card-split-separate" onClick={doSplitSeparate} disabled={publishing || !cardFieldsEditable}
              style={{ alignSelf: "flex-start", padding: "2px 4px", border: "none", background: "transparent", color: "#b45309", fontSize: 10.5, fontWeight: 800, textDecoration: "underline", cursor: publishing ? "default" : "pointer", fontFamily: "inherit" }}>
              {tr("studioBoard.card.mediaNotice.splitSeparate")}
            </button>
          </div>
        )}
        {/* Regenerate stays NEXT TO the media (PRD §7) and targets the selected
            thumbnail — which is the cover, since setCoverMedia moves it to media[0].
            Never regenerates the whole set. */}
        {!generating && !posted && (
          <div data-testid="card-ai-tools" style={{ padding: "6px 12px 0", display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
            {/* With inline fields the trigger sits in the link field; a collapsed
                (scheduled) card has no fields, so it keeps the panel's own button. */}
            {!compactFields && aiCopyPanel()}
            <button type="button" data-testid="card-regenerate-image" onClick={doGenerateAiImage} disabled={publishing}
              style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 5px", borderRadius: 6, border: "none", background: "transparent", color: BUI.purple, fontSize: 10.5, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
              <Layers style={{ width: 12, height: 12 }} /> {tr("studioBoard.card.regenerateImage")}
            </button>
          </div>
        )}
        {syncIssueNotice}
        {publishEntryNotice}
        <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 7 }}>
          {/* Posted header line: when it went live + a single "Needs attention" chip
              on a partial success. One notice, never a stack (PRD §5). */}
          {posted && (
            <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
              {publishedRelativeLabel && (
                <span data-testid="card-published-relative" style={{ fontSize: 11.5, fontWeight: 750, color: BUI.textSec }}>
                  {publishedRelativeLabel}
                </span>
              )}
              {view.needsAttention && (
                <span data-testid="card-needs-attention" style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 10, fontWeight: 800,
                  color: "#b45309", background: "#fffbeb", border: "1px solid #f59e0b55", borderRadius: 999, padding: "2px 8px" }}>
                  <AlertTriangle style={{ width: 10, height: 10 }} /> {tr("studioBoard.card.needsAttention")}
                </span>
              )}
            </div>
          )}
          {/* Scheduled card is compact by default: its date+time reads here. */}
          {scheduled && schedLabel && (
            <span data-testid="card-scheduled-time" style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11.5, fontWeight: 750, color: BUI.textSec }}>
              <CalendarClock style={{ width: 13, height: 13 }} /> {tr("studioBoard.card.scheduledFor").replace("{time}", schedLabel)}
            </span>
          )}
          {/* Draft cards edit inline (PRD §1). Scheduled/Posted stay compact until the
              merchant presses Edit, which opens the SAME form via the expanded card. */}
          {compactFields && (
          <>
          {/* Link first (Pinterest's order); the AI copy action lives in the link field. */}
          {shouldShowFieldOnInstagramChild(draft, "websiteUrl") ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <label htmlFor={`board-card-url-${draft.id}`} style={{ ...labelStyle, margin: 0 }}>{tr("studioBoard.card.fields.websiteUrl")}</label>
              <LinkCopyField id={`board-card-url-${draft.id}`} value={fields.websiteUrl}
                disabled={!cardFieldsEditable || publishing || generating} actionDisabled={amazonNeedsName} state={copyState}
                onChange={value => handleChange({ websiteUrl: value })} onBlur={handleUrlBlur}
                onClear={() => handleChange({ websiteUrl: "" })} onGenerate={() => aiRef.current?.generate()} />
              {aiCopyPanel(true)}
            </div>
          ) : aiCopyPanel()}
          {amazonSectionSource && (
            <AmazonCardSection
              draftId={draft.id}
              source={amazonSectionSource}
              disabled={!cardFieldsEditable || publishing || generating}
              fetching={amazonFetching}
              lastFetchAt={amazonLastFetchAt}
              claimHints={amazonHints}
              onFetch={startAmazonFetch}
              onManualChange={onAmazonManualChange}
              onUseLink={acceptAmazonLink}
              marketplace={cardMarketplace ?? undefined}
            />
          )}
          {shouldShowFieldOnInstagramChild(draft, "title") && (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
              <label htmlFor={`board-card-title-${draft.id}`} style={{ ...labelStyle, margin: 0 }}>{tr("studioBoard.card.fields.title")}</label>
            </div>
            <input id={`board-card-title-${draft.id}`} data-testid="board-card-title" value={fields.title} disabled={!cardFieldsEditable || publishing || generating}
              onChange={event => handleChange({ title: event.target.value })} placeholder={tr("studioBoard.card.untitledPin")}
              style={{ ...fieldStyle, fontSize: 12.5, fontWeight: 700 }} />
          </div>
          )}
          <label style={{ ...labelStyle, display: "flex", flexDirection: "column", gap: 4 }}>
            {/* IG child: this description field IS the caption Instagram sends (design §3),
                so the label reads "Instagram caption" instead of the generic Pinterest one. */}
            {isInstagramCaptionChild ? tr("studioBoard.card.instagramCaption.label") : tr("studioBoard.card.fields.description")}
            <textarea data-testid="board-card-description" value={fields.description} disabled={!cardFieldsEditable || publishing || generating}
              onChange={event => handleChange({ description: event.target.value })} rows={3} placeholder={tr("studioBoard.card.fields.descriptionPlaceholder")}
              style={{ ...fieldStyle, fontSize: 11.5, lineHeight: 1.45, resize: "vertical", minHeight: 60 }} />
          </label>
          {/* Instagram caption input (design T3): only while a single video still carries
              BOTH Pinterest and Instagram as explicit destinations — Schedule reads this
              via card-local state (not a PinDraft field, see the state declaration) and
              splits the draft on a successful schedule. Hidden once split (the parent no
              longer has an Instagram destination) and hidden whenever NEXT_PUBLIC_HIDE_IG_FB
              hides Instagram entirely. */}
          {showInstagramCaptionInput && (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <label htmlFor={`board-card-ig-caption-${draft.id}`} style={{ ...labelStyle, margin: 0 }}>
                {tr("studioBoard.card.instagramCaption.label")}
              </label>
              <p style={{ margin: 0, fontSize: 11, lineHeight: 1.45, color: BUI.textSec }}>
                {tr("studioBoard.card.instagramCaption.help")}
              </p>
              <textarea id={`board-card-ig-caption-${draft.id}`} data-testid="board-card-instagram-caption"
                value={instagramCaption} disabled={!cardFieldsEditable || publishing || generating}
                onChange={event => { setInstagramCaption(event.target.value); setInstagramCaptionTouched(true); }}
                onBlur={() => setInstagramCaptionTouched(true)}
                rows={3} placeholder={tr("studioBoard.card.instagramCaption.placeholder")}
                aria-invalid={!!instagramCaptionError} aria-describedby={instagramCaptionError ? `board-card-ig-caption-error-${draft.id}` : undefined}
                style={{ ...fieldStyle, fontSize: 11.5, lineHeight: 1.45, resize: "vertical", minHeight: 60, ...(instagramCaptionError ? { borderColor: BUI.error } : {}) }} />
              {instagramCaptionError && (
                <p id={`board-card-ig-caption-error-${draft.id}`} data-testid="board-card-instagram-caption-error" role="alert"
                  style={{ margin: 0, fontSize: 11, fontWeight: 600, color: BUI.error }}>
                  {instagramCaptionError}
                </p>
              )}
            </div>
          )}
          {/* Ruling 3: removing the disclosure is warned about, never blocked. */}
          {amazonDisclosureMissing && (
            <div data-testid="card-amazon-disclosure-missing" role="status" style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8, fontSize: 10.5, lineHeight: 1.4, color: BUI.warning }}>
              <span style={{ display: "inline-flex", gap: 5, alignItems: "flex-start" }}>
                <AlertTriangle style={{ width: 11, height: 11, flexShrink: 0, marginTop: 1 }} /> {tr("studioBoard.amazon.disclosureMissing")}
              </span>
              <button type="button" data-testid="card-amazon-add-disclosure" disabled={!cardFieldsEditable || publishing || generating}
                onClick={() => handleChange({ description: appendAffiliateDisclosure(fields.description) })}
                style={{ flexShrink: 0, border: "none", background: "none", padding: 0, color: BUI.purple, fontSize: 10.5, fontWeight: 800, cursor: "pointer", fontFamily: "inherit" }}>
                {tr("studioBoard.amazon.addDisclosure")}
              </button>
            </div>
          )}
          {shouldShowFieldOnInstagramChild(draft, "boardId") && (
          <label style={{ ...labelStyle, display: "flex", flexDirection: "column", gap: 4 }}>
            {tr("studioBoard.card.fields.board")}
          <select data-testid="board-card-board" value={fields.boardId} disabled={!cardFieldsEditable || publishing || generating}
              onChange={event => {
                const board = boards.find(item => item.id === event.target.value);
                handleChange({ boardId: board?.id ?? event.target.value });
              }} style={{ ...fieldStyle, fontSize: 11.5 }}>
              <option value="">{tr("studioBoard.card.fields.boardPlaceholder")}</option>
              {boards.map(board => <option key={board.id} value={board.id}>{board.name}</option>)}
            </select>
          </label>
          )}
          {shouldShowStudioMetadataField(lifecycle, "altText") && <label style={{ ...labelStyle, display: "flex", flexDirection: "column", gap: 4 }}>
            {tr("studioBoard.expanded.altTextOptional")}
            <textarea data-testid="board-card-alt" value={fields.altText} disabled={!cardFieldsEditable || publishing || generating}
              onChange={event => handleChange({ altText: event.target.value })} rows={2}
              placeholder={tr("studioBoard.expanded.altTextPlaceholder")} style={{ ...fieldStyle, fontSize: 11.5, lineHeight: 1.45, resize: "vertical", minHeight: 48 }} />
          </label>}
          </>
          )}
          <div data-testid="card-publish-to" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <span style={labelStyle}>{tr("studioBoard.card.publishTo")}</span>
              <button type="button" data-testid="card-destination-dropdown" aria-label={tr("studioBoard.card.editDestinations")}
                disabled={!cardFieldsEditable || publishing}
                aria-expanded={destinationsOpen} onClick={() => setDestinationsOpen(open => !open)}
                style={{ width: 26, height: 26, display: "grid", placeItems: "center", border: `1px solid ${BUI.border}`, borderRadius: 7, background: BUI.surface2, padding: 0, color: BUI.textSec, cursor: "pointer" }}>
                <ChevronDown style={{ width: 14, height: 14 }} />
              </button>
            </div>
            <div style={{ position: "relative", display: "flex", flexWrap: "wrap", gap: 5 }}>
              {destinations.map(destination => {
                // Tolerates result ids written by earlier shapes, so an un-migrated
                // draft keeps showing its real state instead of reverting to pending.
                const result = findDestinationResult(destinationResults, destination);
                const isFailed = result?.status === "failed";
                const ready = !!destination.socialConnectionId
                  && (destination.provider !== "pinterest" || !!destination.boardId);
                return (
                  <span key={destination.id} style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "5px 8px", borderRadius: 8,
                    border: `1px solid ${isFailed || !ready ? "#f59e0b66" : BUI.border}`, background: isFailed || !ready ? "#fffbeb" : BUI.surface2,
                    color: isFailed || !ready ? "#92400e" : BUI.textSec, fontSize: 10.5, fontWeight: 750 }}>
                    <span style={{ width: 6, height: 6, borderRadius: 999, background: isFailed || !ready ? "#f59e0b" : result?.status === "published" ? "#22c55e" : BUI.textMuted }} />
                    {destination.provider === "pinterest"
                      ? (destination.boardName || destination.boardId || platformName("pinterest"))
                      : platformName(destination.provider as SocialProvider)}
                    {/* The account is what disambiguates two chips on one platform. */}
                    {(destination.accountLabel || result?.accountLabel) && (
                      <span style={{ color: BUI.textMuted, fontWeight: 650 }}>{destination.accountLabel || result?.accountLabel}</span>
                    )}
                    {!ready && <span style={{ color: "#b45309", fontWeight: 750 }}>{tr("studioBoard.card.destinationNeedsSetup")}</span>}
                  </span>
                );
              })}
              {!destinations.length && (
                <button type="button" data-testid="card-no-saved-destination" onClick={() => setDestinationsOpen(true)}
                  style={{ display: "inline-flex", alignItems: "center", gap: 5, minHeight: 30, padding: "5px 9px", borderRadius: 8,
                    border: `1px dashed ${BUI.borderHi}`, background: BUI.surface2, color: BUI.textSec, fontSize: 10.5, fontWeight: 750,
                    cursor: "pointer", fontFamily: "inherit", textAlign: "left" }}>
                  <Layers aria-hidden="true" style={{ width: 12, height: 12, color: BUI.textMuted }} />
                  {tr("studioBoard.card.noSavedDestination")}
                </button>
              )}
              {/* PRD §6: the picker opens ANCHORED TO THE CHIPS. Editing where a
                  Content publishes must not require expanding the whole card — that
                  cost the merchant their place on the board for a two-click change.
                  Mounted per-open so PublishDestinations loads the account summaries
                  that resolveScheduledAccount needs. */}
              {destinationsOpen && (
                <>
                  <div style={{ position: "fixed", inset: 0, zIndex: 20 }} onClick={() => setDestinationsOpen(false)} />
                  <div data-testid="card-destination-popover" style={{ position: "absolute", zIndex: 21, top: "calc(100% + 6px)", left: 0, right: 0, minWidth: 220,
                    padding: 10, borderRadius: 10, border: `1px solid ${BUI.borderHi}`, background: BUI.surface, boxShadow: "0 12px 32px rgba(15,23,42,0.18)" }}>
                    <PublishDestinations
                      selected={selectedProviders}
                      onSelectedChange={changeProviders}
                      selectedAccountIds={selectedAccountIds}
                      onSelectedAccountIdsChange={changeAccounts}
                      onSummariesChange={setConnectionSummaries}
                      onConnectPinterest={props.onConnect}
                      pinterestConnected={!disconnected && !needsReconnect}
                    />
                    {destinationError && (
                      <p data-testid="card-destination-error" role="alert" style={{ margin: "8px 0 0", fontSize: 11, fontWeight: 700, color: "#b45309" }}>
                        {destinationError}
                      </p>
                    )}
                  </div>
                </>
              )}
            </div>
            {needsAttention && (
              <div data-testid="card-failed-info" style={{ display: "flex", flexDirection: "column", gap: 5, padding: "8px 9px", borderRadius: 8, background: "#fffbeb", border: "1px solid #f59e0b55" }}>
                <p data-testid="card-failed-reason" style={{ margin: 0, fontSize: 10.5, fontWeight: 750, color: "#b45309", display: "flex", alignItems: "flex-start", gap: 5, lineHeight: 1.4 }}>
                  <AlertTriangle style={{ width: 12, height: 12, flexShrink: 0, marginTop: 1 }} />
                  {failureReasonText}
                </p>
                {formatPreviousScheduled(tr, draft.previousScheduledTime) && (
                  <span style={{ fontSize: 10, color: BUI.textMuted }}>{formatPreviousScheduled(tr, draft.previousScheduledTime)}</span>
                )}
              </div>
            )}
          </div>
          {!scheduled && !posted && !generating && (
            <div data-testid="card-custom-time" style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
              <button type="button" data-testid="card-custom-time-toggle" onClick={() => setCustomTimeOpen(open => !open)}
                aria-expanded={customTimeOpen} title={tr("studioBoard.card.customTimeHint")}
                style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 4px", border: 0, background: "transparent", color: BUI.textMuted, fontSize: 9.5, fontWeight: 650, cursor: "pointer", fontFamily: "inherit" }}>
                <CalendarClock style={{ width: 11, height: 11 }} /> {tr("studioBoard.card.customTime")}
              </button>
              {customTimeOpen && (
                <div data-testid="card-custom-time-fields" style={{ width: "100%", display: "grid", gridTemplateColumns: "minmax(0,1fr) 88px auto", gap: 6, padding: 8, borderRadius: 9, border: `1px solid ${BUI.border}`, background: BUI.surface2 }}>
                  <input aria-label={tr("studioBoard.card.customDate")} type="date" value={customDate} disabled={publishing}
                    onChange={event => setCustomDate(event.target.value)}
                    style={{ ...fieldStyle, fontSize: 10, minHeight: 30, padding: "5px 6px" }} />
                  <input aria-label={tr("studioBoard.card.customTime")} type="time" value={customTime} disabled={publishing}
                    onChange={event => setCustomTime(event.target.value)}
                    style={{ ...fieldStyle, fontSize: 10, minHeight: 30, padding: "5px 6px" }} />
                  <button type="button" data-testid="card-custom-time-apply" onClick={doCustomSchedule}
                    disabled={!customDate || !customTime || publishing}
                    style={{ border: 0, borderRadius: 7, padding: "5px 8px", background: BUI.purple, color: "#fff", fontSize: 10, fontWeight: 750, cursor: "pointer" }}>
                    {tr("studioBoard.card.apply")}
                  </button>
                </div>
              )}
            </div>
          )}
          {/* PRD 13 — Failed card info: error text, a recommended fix per bucket, and
              the schedule slot that was lost (if any). Kept compact; full detail also
              shows in the expanded card. */}
          {keywordChips.length > 0 && (
            <div data-testid="card-keyword-chips" style={{ display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center" }}
              title={tr("studioBoard.card.keywordChipsTitle")}>
              <span style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: "0.03em", textTransform: "uppercase", color: BUI.textMuted }}>
                {tr("studioBoard.card.keywords")}
              </span>
              {keywordChips.map(k => {
                const copied = copiedKw === k;
                return (
                  <span key={k} data-testid="card-keyword-chip"
                    onClick={e => copyKeyword(e, k)}
                    onMouseEnter={() => setHoveredKw(k)}
                    onMouseLeave={() => setHoveredKw(h => (h === k ? null : h))}
                    title={tr("studioBoard.card.copyKeywordTitle").replace("{keyword}", k)}
                    style={copied ? keywordChipCopiedStyle : keywordChipStyle}>
                    {copied ? tr("studioBoard.card.copied") : k}
                    {!copied && hoveredKw === k && (
                      <button type="button" data-testid="card-keyword-remove" aria-label={tr("studioBoard.card.removeKeywordAria").replace("{keyword}", k)}
                        onClick={e => removeKeyword(e, k)} style={keywordChipXStyle}>
                        <X style={{ width: 9, height: 9 }} />
                      </button>
                    )}
                  </span>
                );
              })}
            </div>
          )}
          {/* PRD §3–§6 action matrix. Every real publish action reads exactly
              "Publish" (§20); the failed card's primary is "Retry", which differs in
              SCOPE (only what failed), not in what the word means. */}
          {resultsBlock}
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 2, flexWrap: "wrap" }}>
            {generating ? (
              <button type="button" data-testid="card-generating" disabled
                style={{ ...primaryBtn, opacity: 0.6, cursor: "default" }}>
                <Loader2 style={{ width: 13, height: 13 }} className="animate-spin" /> {tr("studioBoard.action.generating")}
              </button>
            ) : view.needsAttention && isPublishFailure ? (
              // Retry re-sends ONLY the failed destinations (onlyPending), so retrying a
              // partial success can never double-post the one that already published.
              <>
                <button type="button" data-testid="card-try-again" onClick={() => {
                  if (destinationNeedsSetup) {
                    setDestinationError(tr("studioBoard.blocker.no_destinations"));
                    setDestinationsOpen(true);
                    return;
                  }
                  props.onTryAgain(draft);
                }} disabled={publishing} style={primaryBtn}>
                  {publishing ? <Loader2 style={{ width: 13, height: 13 }} className="animate-spin" /> : null} {tr("studioBoard.actions.retry")}
                </button>
                {/* The one actionable next step for this failure category — never a raw message. */}
                {nextStep && nextStep.action !== "edit" && (
                  <button type="button" data-testid="card-next-step"
                    onClick={() => { if (nextStep.action === "reconnect") props.onConnect?.(); else startEditing(); }}
                    style={secondaryBtn}>
                    {tr(nextStep.key)}
                  </button>
                )}
                <button type="button" data-testid="card-edit" aria-label={editAriaLabel} onClick={startEditing} style={secondaryBtn}>
                  {tr("studioBoard.actions.edit")}
                </button>
              </>
            ) : lifecycle === "needs_attention" ? (
              // An unknown provider receipt is deliberately not retried blindly. The
              // merchant can inspect or repair the saved destination, while the card
              // continues to show Needs attention rather than a false Posted badge.
              <button type="button" data-testid="card-edit" aria-label={editAriaLabel} onClick={startEditing} style={secondaryBtn}>
                {tr("studioBoard.actions.edit")}
              </button>
            ) : view.needsAttention ? (
              // Generation failure: not a publish attempt, so its own recovery stands.
              <>
                <button type="button" data-testid="card-try-again" onClick={() => props.onTryAgain(draft)} disabled={publishing} style={primaryBtn}>
                  {publishing ? <Loader2 style={{ width: 13, height: 13 }} className="animate-spin" /> : null} {tr("studioBoard.action.tryAgain")}
                </button>
              <button type="button" data-testid="card-edit" aria-label={editAriaLabel} onClick={startEditing} style={secondaryBtn}>
                  {tr("studioBoard.actions.edit")}
                </button>
              </>
            ) : scheduled ? (
              <>
                <button type="button" data-testid="card-edit" aria-label={editAriaLabel} onClick={startEditing} style={primaryBtn}>
                  {tr("studioBoard.actions.edit")}
                </button>
                {/* Publishing now overrides the merchant's own plan, so it confirms first. */}
                <button type="button" data-testid="card-publish" onClick={() => doPublish()} disabled={publishing} style={secondaryBtn}>
                  {publishing ? <Loader2 style={{ width: 13, height: 13 }} className="animate-spin" /> : null} {tr("studioBoard.actions.publish")}
                </button>
                <button type="button" data-testid="card-unschedule" onClick={() => props.onUnschedule(draft.id)} style={secondaryBtn}>
                  {tr("studioBoard.actions.unschedule")}
                </button>
              </>
            ) : posted ? (
              <button type="button" data-testid="card-view-details" aria-label={tr("studioBoard.actions.viewDetails")} onClick={() => props.onSetActive(draft.id)} style={primaryBtn}>
                {tr("studioBoard.actions.viewDetails")}
              </button>
            ) : (
              <>
                <button type="button" data-testid="card-schedule" className="studio-schedule-button" onClick={doSchedule} disabled={publishing} style={primaryBtn}>
                  <CalendarClock style={{ width: 13, height: 13 }} /> {tr("studioBoard.action.schedule")}
                </button>
                <button type="button" data-testid="card-publish" onClick={() => doPublish()} disabled={publishing} style={secondaryBtn}>
                  {publishing ? <Loader2 style={{ width: 13, height: 13 }} className="animate-spin" /> : null} {tr("studioBoard.actions.publish")}
                </button>
              </>
            )}
          </div>
          {/* Saved / Saving… / Couldn't save · Retry — the card BOTTOM (PRD §1). */}
          {!generating && saveStateLine}
        </div>
      </div>
    );
  }

  // ── Expanded (active) quick edit ────────────────────────────────────────────────
  return (
    <div data-testid="pin-board-card" data-active="true" data-source={draft.source} data-lifecycle={lifecycle}
      style={{ display: "flex", flexDirection: "column", background: BUI.surface, border: `1px solid ${BUI.purple}`, borderRadius: STUDIO_UI.cardRadius, overflow: "hidden", boxShadow: "0 8px 28px rgba(124,58,237,0.16)" }}>
      <div style={{ padding: 14, display: "grid", gridTemplateColumns: "96px minmax(0,1fr)", gap: 14, alignItems: "start", borderBottom: `1px solid ${BUI.border}` }}>
        <div style={{ position: "relative", width: 96, minHeight: 144, aspectRatio: intrinsicAspectRatio, borderRadius: 12, overflow: "hidden", border: `1px solid ${BUI.border}`, background: BUI.surface3 }}>
          {failed && !isPublishFailure ? (
            <PinCardMedia draft={draft} alt={draft.altText || draft.title || tr("studioBoard.card.pinImageAlt")}
              placeholderVariant="generationFailed" onIntrinsicSize={onIntrinsicSize} />
          ) : (coverMedia(draft)?.kind === "video" || resolveInitialFailureMediaUrl(draft)) ? (
            <PinCardMedia draft={draft} alt={draft.altText || draft.title || tr("studioBoard.card.pinImageAlt")}
              placeholderVariant="noImage" onIntrinsicSize={onIntrinsicSize} />
          ) : (
            <PinFallbackArtwork busy={generating} />
          )}
          {selectionControl}
        </div>
        <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
            <div style={{ minWidth: 0 }}>
              <p style={{ margin: 0, fontSize: 14, fontWeight: 850, color: BUI.text }}>{posted ? tr("studioBoard.actions.viewDetails") : tr("pinDetails.editTitle")}</p>
              <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginTop: 6 }}>
                <span data-testid="card-status-badge" style={{ fontSize: 10, fontWeight: 800, color: "#fff", background: toneColor[status.tone] ?? BUI.textSec, borderRadius: 999, padding: "3px 9px", display: "inline-flex", alignItems: "center", gap: 4 }}>
                  {publishing && <Loader2 style={{ width: 10, height: 10 }} className="animate-spin" />}{statusLabel}
                </span>
              </div>
            </div>
            <button type="button" data-testid="card-collapse" aria-label={tr("studioBoard.expanded.collapseAria")} onClick={collapse}
              style={{ flexShrink: 0, width: 30, height: 30, borderRadius: 8, border: `1px solid ${BUI.border}`, background: BUI.surface2, color: BUI.textSec, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <ChevronUp style={{ width: 16, height: 16 }} />
            </button>
          </div>
          <div data-testid="card-ai-tools" style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
            {aiCopyPanel()}
            <button type="button" data-testid="card-generate-ai-image" onClick={doGenerateAiImage} disabled={!cardFieldsEditable}
              style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 4, padding: "3px 5px", borderRadius: 6, border: "none", background: "transparent", color: BUI.purple, fontSize: 10.5, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }}>
              <Layers style={{ width: 12, height: 12 }} /> {tr("studioBoard.card.regenerateImage")}
            </button>
          </div>
        </div>
      </div>

      {syncIssueNotice}
      {publishEntryNotice}
      <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 12 }}>
        {/* AI actions — Generate copy primary, Create AI Version secondary */}
        <PinFieldsForm value={fields} boards={boards} boardsLoading={boardsLoading} disconnected={disconnected}
          needsReconnect={needsReconnect} boardsError={boardsError} onRetryBoards={onRetryBoards}
          boardFieldError={props.boardFieldError}
          titleFieldError={props.titleFieldError} descriptionFieldError={props.descriptionFieldError}
          disabled={publishing || !cardFieldsEditable} onChange={handleChange}
          onGenerateCopy={() => aiRef.current?.generate()}
          aiBusyKey={draft.id}
          onRegenerateField={() => aiRef.current?.generate()} onConnect={props.onConnect}
          hiddenFields={isInstagramCaptionChild ? ["title", "websiteUrl", "board"] : undefined}
          descriptionLabel={isInstagramCaptionChild ? tr("studioBoard.card.instagramCaption.label") : undefined} />

        {/* Instagram caption input (design T3) — same gate/behavior as the compact card;
            see that block's comment for why this is card-local state, not a draft field. */}
        {showInstagramCaptionInput && (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <label htmlFor={`board-field-ig-caption-${draft.id}`} style={labelStyle}>
              {tr("studioBoard.card.instagramCaption.label")}
            </label>
            <p style={{ margin: 0, fontSize: 11, lineHeight: 1.45, color: BUI.textSec }}>
              {tr("studioBoard.card.instagramCaption.help")}
            </p>
            <textarea id={`board-field-ig-caption-${draft.id}`} data-testid="board-field-instagram-caption"
              value={instagramCaption} disabled={publishing || !cardFieldsEditable}
              onChange={event => { setInstagramCaption(event.target.value); setInstagramCaptionTouched(true); }}
              onBlur={() => setInstagramCaptionTouched(true)}
              rows={3} placeholder={tr("studioBoard.card.instagramCaption.placeholder")}
              aria-invalid={!!instagramCaptionError} aria-describedby={instagramCaptionError ? `board-field-ig-caption-error-${draft.id}` : undefined}
              style={{ ...fieldStyle, resize: "vertical", minHeight: 64, ...(instagramCaptionError ? { borderColor: BUI.error } : {}) }} />
            {instagramCaptionError && (
              <p id={`board-field-ig-caption-error-${draft.id}`} data-testid="board-field-instagram-caption-error" role="alert"
                style={{ margin: 0, fontSize: 11, fontWeight: 600, color: BUI.error }}>
                {instagramCaptionError}
              </p>
            )}
            {/* The server already rejected this draft's schedule (mixed_video_requires_split,
                syncIssueNotice above) — the footer below shows Publish/Done here because the
                CLIENT'S OWN optimistic scheduledDate/plannedAt still reads as "scheduled"
                lifecycle (getPinLifecycle only checks local fields), so there is no Schedule
                button to re-press. This is the one action that performs the split with the
                caption just entered. */}
            {syncIssue?.code === "mixed_video_requires_split" && (
              <button type="button" data-testid="card-split-and-schedule" onClick={doSchedule} disabled={publishing || !!instagramCaptionErrors.length}
                style={{ alignSelf: "flex-start", display: "inline-flex", alignItems: "center", gap: 6, padding: "9px 14px", borderRadius: 9, border: "none", background: BUI.gradient, color: "#fff", fontSize: 12, fontWeight: 800, cursor: instagramCaptionErrors.length ? "default" : "pointer", fontFamily: "inherit", opacity: instagramCaptionErrors.length ? 0.6 : 1 }}>
                <CalendarClock style={{ width: 13, height: 13 }} /> {tr("studioBoard.card.instagramCaption.splitAction")}
              </button>
            )}
          </div>
        )}

        {cardFieldsEditable && <PublishDestinations
          selected={selectedProviders}
          onSelectedChange={changeProviders}
          selectedAccountIds={selectedAccountIds}
          onSelectedAccountIdsChange={changeAccounts}
          onSummariesChange={setConnectionSummaries}
          onConnectPinterest={props.onConnect}
          pinterestConnected={!disconnected && !needsReconnect}
        />}
        {destinationError && (
          <p data-testid="card-destination-error" role="alert"
            style={{ margin: 0, fontSize: 11, fontWeight: 700, color: "#b45309" }}>
            {destinationError}
          </p>
        )}

        {/* More details */}
        <div>
          <button type="button" data-testid="card-more-details-toggle" onClick={() => setMoreOpen(o => !o)}
            style={{ display: "inline-flex", alignItems: "center", gap: 5, background: "none", border: "none", padding: 0, fontSize: 11.5, fontWeight: 800, color: BUI.textSec, cursor: "pointer", fontFamily: "inherit" }}>
            {tr("studioBoard.expanded.moreDetails")} {moreOpen ? <ChevronUp style={{ width: 13, height: 13 }} /> : <ChevronDown style={{ width: 13, height: 13 }} />}
          </button>
          {moreOpen && (
            <div data-testid="card-more-details" style={{ display: "flex", flexDirection: "column", gap: 11, marginTop: 10 }}>
              <div>
                <span style={labelStyle}>{tr("studioBoard.expanded.productOptional")}</span>
                <button type="button" data-testid="card-select-product" disabled={!cardFieldsEditable || publishing || !props.onSelectProduct}
                  onClick={() => { flush(); props.onSelectProduct?.(draft); }}
                  style={{ ...fieldStyle, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, color: linkedProduct ? BUI.text : BUI.purple, cursor: publishing ? "default" : "pointer", textAlign: "left", fontFamily: "inherit" }}>
                  <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: linkedProduct ? 700 : 650 }}>
                    {linkedProduct?.title || tr("studioBoard.expanded.selectProduct")}
                  </span>
                  <span style={{ flexShrink: 0, color: BUI.purple, fontSize: 10.5, fontWeight: 750 }}>
                    {linkedProduct ? tr("studioBoard.expanded.changeProduct") : tr("studioBoard.expanded.chooseProduct")}
                  </span>
                </button>
                {linkedProduct?.productUrl && (
                  <p style={{ margin: "5px 0 0", fontSize: 10, color: BUI.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {linkedProduct.productUrl}
                  </p>
                )}
              </div>
              <div>
                <span style={labelStyle}>{tr("studioBoard.expanded.altTextOptional")}</span>
                <textarea data-testid="board-field-alt" value={fields.altText} disabled={publishing || !cardFieldsEditable}
                  onChange={e => handleChange({ altText: e.target.value })} rows={2}
                  placeholder={tr("studioBoard.expanded.altTextPlaceholder")} style={{ ...fieldStyle, resize: "vertical", minHeight: 48 }} />
              </div>
              <div>
                <span style={labelStyle}>{tr("studioBoard.expanded.tagsOptional")}</span>
                <input data-testid="board-field-tags" value={fields.tags} disabled={publishing || !cardFieldsEditable}
                  onChange={e => handleChange({ tags: e.target.value })} placeholder={tr("studioBoard.expanded.tagsPlaceholder")} style={fieldStyle} />
              </div>
            </div>
          )}
        </div>

        {/* Failed-card info (expanded): same error/fix/previous-time detail as the
            compact card, shown here too since a failed card can also be expanded
            via Edit. PRD 13. */}
        {needsAttention && (
          <div data-testid="card-failed-info-expanded" style={{ display: "flex", flexDirection: "column", gap: 4, padding: "10px 12px", borderRadius: 9, background: "rgba(239,68,68,0.08)", border: `1px solid ${BUI.error}33` }}>
            <p data-testid="card-failed-reason-expanded" style={{ margin: 0, fontSize: 12, fontWeight: 700, color: BUI.error, display: "flex", alignItems: "flex-start", gap: 6, lineHeight: 1.4 }}>
              <AlertTriangle style={{ width: 13, height: 13, flexShrink: 0, marginTop: 1 }} /> {failureReasonText}
            </p>
            {isPublishFailure && (
              <p style={{ margin: 0, fontSize: 11, color: BUI.textSec, lineHeight: 1.45 }}>{recommendedFix(tr, failureCategory)}</p>
            )}
            {formatPreviousScheduled(tr, draft.previousScheduledTime) && (
              <p style={{ margin: 0, fontSize: 11, color: BUI.textMuted }}>
                {formatPreviousScheduled(tr, draft.previousScheduledTime)}
              </p>
            )}
          </div>
        )}

        {/* Footer: autosave + a single lifecycle-appropriate primary action.
            SCHEDULED never shows a Schedule button here — that was the bug (the
            footer used to render Schedule unconditionally). FAILED gets Retry
            publish / Move to Unscheduled instead of Schedule (retrying does not
            reuse the old slot). Everything else keeps the original Schedule CTA. */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, borderTop: `1px solid ${BUI.border}`, paddingTop: 12 }}>
          <span data-testid="card-autosave">{saveStateLine}</span>
          <div style={{ flex: 1 }} />
          {/* While editing a Scheduled/Posted Content the primary action is Publish —
              a fresh publish of what is on screen (onlyPending:false), so an edit that
              was made specifically to fix a live Pin actually reaches every platform. */}
          {scheduled ? (
            <>
              <button type="button" data-testid="card-done" onClick={stopEditing} style={secondaryBtn}>
                {tr("studioBoard.actions.done")}
              </button>
              <button type="button" data-testid="card-publish" onClick={() => doPublish({ onlyPending: false })} disabled={publishing}
                style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "9px 18px", borderRadius: 9, border: "none", background: BUI.gradient, color: "#fff", fontSize: 12.5, fontWeight: 800, cursor: "pointer", fontFamily: "inherit" }}>
                {publishing ? <Loader2 style={{ width: 14, height: 14 }} className="animate-spin" /> : null} {tr("studioBoard.actions.publish")}
              </button>
            </>
          ) : posted ? (
            <button type="button" data-testid="card-done" onClick={stopEditing} style={secondaryBtn}>
              {tr("studioBoard.actions.done")}
            </button>
          ) : (failed || lifecycle === "needs_attention") ? (
            isPublishFailure ? (
              <>
                <button type="button" data-testid="card-move-to-unscheduled" onClick={() => props.onMoveToUnscheduled(draft.id)}
                  style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "9px 14px", borderRadius: 9, border: `1px solid ${BUI.border}`, background: BUI.surface2, color: BUI.text, fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
                  {tr("studioBoard.expanded.moveToUnscheduled")}
                </button>
                <button type="button" data-testid="card-try-again" onClick={() => {
                  if (destinationNeedsSetup) {
                    setDestinationError(tr("studioBoard.blocker.no_destinations"));
                    return;
                  }
                  props.onTryAgain(draft);
                }} disabled={publishing}
                  style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "9px 18px", borderRadius: 9, border: "none", background: BUI.gradient, color: "#fff", fontSize: 12.5, fontWeight: 800, cursor: "pointer", fontFamily: "inherit" }}>
                  {publishing ? <Loader2 style={{ width: 14, height: 14 }} className="animate-spin" /> : null} {tr("studioBoard.actions.retry")}
                </button>
              </>
            ) : lifecycle === "needs_attention" ? (
              <button type="button" data-testid="card-done" onClick={stopEditing} style={secondaryBtn}>
                {tr("studioBoard.actions.done")}
              </button>
            ) : (
              <button type="button" data-testid="card-try-again" onClick={() => props.onTryAgain(draft)} disabled={publishing}
                style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "9px 18px", borderRadius: 9, border: "none", background: BUI.gradient, color: "#fff", fontSize: 12.5, fontWeight: 800, cursor: "pointer", fontFamily: "inherit" }}>
                {publishing ? <Loader2 style={{ width: 14, height: 14 }} className="animate-spin" /> : null} {tr("studioBoard.expanded.tryAgain")}
              </button>
            )
          ) : posted ? (
            // Already published — re-scheduling makes no sense here. Same "View Pin"
            // affordance as the compact card, kept minimal (out of this task's scope
            // to redesign the Posted footer further), plus one link per non-Pinterest
            // platform this Pin also went live on.
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
              {pinUrl ? (
                <a data-testid="card-view-pin" href={pinUrl} target="_blank" rel="noopener noreferrer"
                  style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "9px 18px", borderRadius: 9, border: "none", background: BUI.gradient, color: "#fff", fontSize: 12.5, fontWeight: 800, textDecoration: "none" }}>
                  {tr("studioBoard.action.viewPin")} <ExternalLink style={{ width: 12, height: 12 }} />
                </a>
              ) : (
                <span style={{ fontSize: 12, fontWeight: 700, color: BUI.textSec }}>{tr("studioBoard.expanded.posted")}</span>
              )}
              {socialPostRefs.map(ref => (
                <a key={ref.provider} data-testid={`card-view-on-${ref.provider}`}
                  href={ref.postUrl} target="_blank" rel="noopener noreferrer"
                  // The handle rides the tooltip rather than the label: the button
                  // row is tight, and the account matters when verifying a post,
                  // not when scanning the card.
                  title={ref.accountName ? `${viewOnLabel(ref.provider)} — ${ref.accountName}` : undefined}
                  style={{ ...secondaryBtn, textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 5 }}>
                  {viewOnLabel(ref.provider)} <ExternalLink style={{ width: 11, height: 11 }} />
                </a>
              ))}
            </div>
          ) : (
            <button type="button" data-testid="card-schedule" onClick={doSchedule} disabled={publishing}
              style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "9px 18px", borderRadius: 9, border: "none", background: BUI.gradient, color: "#fff", fontSize: 12.5, fontWeight: 800, cursor: "pointer", fontFamily: "inherit" }}>
              <CalendarClock style={{ width: 14, height: 14 }} /> {tr("studioBoard.expanded.schedule")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export const PinBoardCard = memo(PinBoardCardImpl);
