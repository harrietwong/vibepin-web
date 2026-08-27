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

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import type { MessageKey } from "@/lib/i18n/messages/en";
import { ChevronDown, ChevronUp, ExternalLink, Loader2, MoreVertical, Layers, Check, CalendarClock, X, Star, AlertTriangle, Sparkles, Pencil } from "lucide-react";
import type { PinDraft } from "@/lib/pinDraftStore";
import { hasPersistFailure, retryPersist, subscribe as subscribeDrafts } from "@/lib/pinDraftStore";
import { getStatusBadge, isActionablePublishFailure, mapPublishErrorToCategory, type PinLifecycle } from "@/lib/studio/pinLifecycle";
import { getPublishErrorDisplayKey } from "@/lib/studio/publishErrorDisplay";
import { buildCardViewModel, relativePublishedParts, type CardResultRow } from "@/lib/studio/cardView";
import { coverMedia } from "@/lib/contentDraftModel";
import { PinCardMedia, resolveInitialFailureMediaUrl } from "@/components/studio/PinCardMedia";
import { ContentMediaStrip } from "@/components/studio/ContentMediaStrip";
import { PinFallbackArtwork } from "@/components/studio/PinFallbackArtwork";
import { contentDestinationResults, contentDestinations, destinationKey, destinationNeedsAttention, findDestinationResult, hasFailedDestination, type PublishProvider } from "@/lib/contentDraftModel";
import type { PinterestBoard } from "@/lib/pinterestClient";
import { PinFieldsForm, type PinFieldsValue } from "@/components/pins/PinFieldsForm";
import { PinAICopyPanel, type PinAICopyPanelHandle, type PinAICopyResult } from "@/components/pins/PinAICopyPanel";
import { PublishDestinations } from "@/components/social/PublishDestinations";
import { platformName, type SocialProvider } from "@/lib/social/platforms";
import {
  AmbiguousScheduleAccountError,
  buildScheduledDestinations,
  resolveScheduledAccount,
} from "@/lib/social/scheduledDestinations";
import type { PlatformConnectionSummary } from "@/lib/social/types";
import { BUI, toneColor, fieldStyle, labelStyle } from "@/components/studio/boardUI";
import { track } from "@/lib/analytics";

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
/** The scheduled day / clock time, split for the "publishes now instead of {date} {time}"
 *  confirm. Locale-formatted; empty when the Content has no slot. */
function scheduledDateLabel(d: PinDraft): string {
  const date = (d.scheduledDate ?? "").trim();
  if (!date) return "";
  return new Date(`${date}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
function scheduledTimeLabel(d: PinDraft): string {
  const t = (d.scheduledTime ?? "").trim();
  if (!t) return "";
  const [h, m] = t.split(":");
  const hh = Number(h); const ampm = hh >= 12 ? "PM" : "AM"; const h12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${h12}:${String(Number(m ?? 0)).padStart(2, "0")} ${ampm}`;
}
// Deep link into the Plan view inside the canonical Create Pins workspace.
// (same "?modal=publish&pinId=…" contract the post-OAuth restore flow already parses —
// no new mechanism; /app/plan is now only a param-preserving redirect to this URL.)
function planDeepLink(draftId: string): string {
  return `/app/studio?view=plan&modal=publish&pinId=${encodeURIComponent(draftId)}`;
}
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
function nextStepFor(category: "transient" | "content" | "auth" | undefined, errorCode?: string):
  { key: MessageKey; action: "reconnect" | "board" | "edit" } | null {
  if (category === "auth") return { key: "studioBoard.card.nextStep.reconnect", action: "reconnect" };
  if ((errorCode ?? "").toLowerCase() === "board_not_owned") {
    return { key: "studioBoard.card.nextStep.chooseBoard", action: "board" };
  }
  if (category === "content") return { key: "studioBoard.card.nextStep.edit", action: "edit" };
  return null; // transient / unknown: Retry alone is the whole remedy.
}
function customerFacingBoardName(...names: Array<string | null | undefined>): string {
  const name = names.map(item => item?.trim()).find(item => item
    && !/^(qa board|vibepin sandbox demo board|sandbox demo board)$/i.test(item));
  return name || "Pinterest";
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

export type PinBoardCardProps = {
  draft: PinDraft;
  lifecycle: PinLifecycle;
  publishing: boolean;
  /** Derived by the board: the qualitative "Top pick" of this generation batch. */
  topPick?: boolean;
  /** Last customer-selected Board name, used only as a compact display fallback. */
  fallbackBoardName?: string;
  selected?: boolean;
  onSelectedChange?: (id: string, selected: boolean) => void;
  active: boolean;
  onSetActive: (id: string | null) => void;
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
  onPersist: (id: string, patch: Partial<PinDraft>) => void;
  onSchedule: (id: string) => void;
  onCustomSchedule: (id: string, date: string, time: string) => void;
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
  /** Publishing a Scheduled card early is confirmed first — it overrides their plan. */
  const [confirmPublish, setConfirmPublish] = useState(false);
  /** The destination picker, anchored to the chips instead of expanding the card. */
  const [destinationsOpen, setDestinationsOpen] = useState(false);
  const [customTimeOpen, setCustomTimeOpen] = useState(false);
  const [customDate, setCustomDate] = useState(() => draft.scheduledDate ?? "");
  const [customTime, setCustomTime] = useState(() => draft.scheduledTime ?? "");
  const [selectedProviders, setSelectedProviders] = useState<PublishProvider[]>(() => {
    const providers = contentDestinations(draft).map(item => item.provider);
    return providers.length ? Array.from(new Set(providers)) : ["pinterest"];
  });
  const [selectedAccountIds, setSelectedAccountIds] = useState<Array<{ provider: string; id: string }>>(() =>
    contentDestinations(draft).filter(item => item.socialConnectionId).map(item => ({ provider: item.provider, id: item.socialConnectionId as string })),
  );
  /** The connected accounts the picker loaded — needed to resolve one account per platform. */
  const [connectionSummaries, setConnectionSummaries] = useState<PlatformConnectionSummary[]>([]);
  /**
   * Set when a ticked platform has no destination we may record (several accounts and
   * no choice, or none connected). Publish/Schedule are blocked while it is set: a
   * destination without a connection id cannot be published and must never be stored.
   */
  const [destinationError, setDestinationError] = useState("");
  // Keyword-chip interaction state (compact card): which chip shows its remove ×, and
  // which chip is briefly flashing "Copied". Card is keyed by draft.id upstream, so this
  // never leaks across drafts.
  const [hoveredKw, setHoveredKw] = useState<string | null>(null);
  const [copiedKw, setCopiedKw] = useState<string | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
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

  const persistNow = useCallback((f: PinFieldsValue) => {
    props.onPersist(draft.id, {
      title: f.title,
      description: f.description,
      destinationUrl: f.websiteUrl.trim(),
      boardId: f.boardId,
      boardName: boardName(f.boardId),
      altText: f.altText,
      tags: parseTags(f.tags),
      // Destinations are NOT written here. They are one fact with one writer
      // (`persistDestinationSelection` below → `scheduledDestinations`), so a field
      // edit can never quietly re-derive them from stale component state.
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

  // Actions flush pending edits first. An unresolvable destination blocks both:
  // scheduling or publishing with a half-recorded intent is how a three-platform
  // choice silently executed as Pinterest-only.
  const doSchedule = useCallback(() => {
    if (destinationError) return;
    flush();
    props.onSchedule(draft.id);
  }, [flush, props, draft.id, destinationError]);
  const doCustomSchedule = useCallback(() => {
    if (!customDate || !customTime) return;
    flush();
    setCustomTimeOpen(false);
    props.onCustomSchedule(draft.id, customDate, customTime);
  }, [customDate, customTime, draft.id, flush, props]);
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
   * Publish. `onlyPending` is the board default (Retry semantics); an explicit
   * republish of an edited Posted Content sends everything, because the point of that
   * action is to push the NEW content to every destination it names.
   */
  const doPublish = useCallback((options?: { onlyPending?: boolean }) => {
    if (destinationError) return;
    flush();
    setConfirmPublish(false);
    props.onPublish(draft.id, options);
  }, [flush, props, draft.id, destinationError]);
  const expand = useCallback(() => props.onSetActive(draft.id), [props, draft.id]);
  const collapse = useCallback(() => { flush(); props.onSetActive(null); }, [flush, props]);
  /** Enter/leave the card-local edit form. Leaving always flushes pending edits. */
  const startEditing = useCallback(() => { setEditing(true); props.onSetActive(draft.id); }, [props, draft.id]);
  const stopEditing = useCallback(() => { flush(); setEditing(false); props.onSetActive(null); }, [flush, props]);
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
  const persistDestinationSelection = useCallback((providers: PublishProvider[], accounts: Array<{ provider: string; id: string }>) => {
    let error = "";
    const destinations = buildScheduledDestinations(
      providers,
      { ...draft, boardId: fields.boardId, boardName: boardName(fields.boardId) },
      provider => {
        const platform = connectionSummaries.find(summary => summary.provider === provider);
        const platformAccounts = platform?.accounts ?? [];
        const explicit = accounts.find(item => item.provider === provider)?.id ?? null;
        try {
          const resolved = resolveScheduledAccount(provider, platformAccounts, explicit);
          if (!resolved && !error) {
            error = tr("studioBoard.toast.ambiguousAccount").replace("{platform}", platformName(provider));
          }
          return resolved;
        } catch (err) {
          if (err instanceof AmbiguousScheduleAccountError && !error) {
            error = tr("studioBoard.toast.ambiguousAccount").replace("{platform}", platformName(provider));
          }
          return null;
        }
      },
    );
    setDestinationError(error);
    // Pinterest is written from the draft's pinned target, so a Content with no
    // Pinterest connection yet still records the platforms that DID resolve.
    props.onPersist(draft.id, { scheduledDestinations: destinations });
  }, [props, draft, fields.boardId, boardName, connectionSummaries, tr]);
  const changeProviders = useCallback((next: SocialProvider[]) => {
    const supported = next.filter((provider): provider is PublishProvider => provider === "pinterest" || provider === "instagram" || provider === "facebook");
    setSelectedProviders(supported);
    persistDestinationSelection(supported, selectedAccountIds);
  }, [persistDestinationSelection, selectedAccountIds]);
  const changeAccounts = useCallback((next: Array<{ provider: string; id: string }>) => {
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
  const aiRef = useRef<PinAICopyPanelHandle>(null);
  const applyCopy = useCallback((r: PinAICopyResult) => {
    const prevTitle = fields.title;
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
  }, [props, draft.id, draft.destinationUrl, draft.tags, fields.title, fields.description, fields.altText]);

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
  const isAiSourced = cover?.source === "ai" || (!cover?.source && draft.source === "ai_generated_from_upload");

  const nextStep = nextStepFor(
    draft.errorCategory ?? (isPublishFailure ? mapPublishErrorToCategory(
      draft.publishErrorCode || firstDestinationFailure?.errorCode,
      draft.publishError || firstDestinationFailure?.errorMessage) : undefined),
    draft.publishErrorCode || firstDestinationFailure?.errorCode,
  );

  // Draft cards edit in place; scheduled/posted/failed stay compact until Edit.
  const compactFields = lifecycle === "unscheduled" || lifecycle === "generating";

  const status = getStatusBadge(draft);
  // Badge copy override for the failed lifecycle only (PRD "失败情况优化" §5): the
  // shared getStatusBadge() in pinLifecycle.ts still returns the generic "Failed" —
  // overridden here rather than in the shared helper since PinBoardCard is its only
  // caller and already computes isPublishFailure for the action matrix below.
  const statusLabel = status.lifecycle === "failed"
    ? tr(isPublishFailure ? "studioBoard.card.publishFailedBadge" : "studioBoard.card.generationFailedBadge")
    : status.label;
  const publishing = props.publishing;
  const posted = lifecycle === "posted";
  const failed = lifecycle === "failed";
  const needsAttention = failed || hasFailedDestination(draft);
  const destinationResults = contentDestinationResults(draft);
  const destinations = contentDestinations(draft);
  const scheduled = lifecycle === "scheduled";
  const generating = lifecycle === "generating";
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
  const boardSummary = customerFacingBoardName(draft.boardName, props.fallbackBoardName);
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
    lifecycle === "failed" ? (isPublishFailure ? [
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
      <span style={{ fontWeight: 700, color: row.status === "published" ? BUI.success : row.status === "failed" ? BUI.warning : BUI.textMuted }}>
        {tr(row.status === "published" ? "studioBoard.card.resultPublished"
          : row.status === "failed" ? "studioBoard.card.resultFailed"
          : "studioBoard.card.resultPending")}
      </span>
      {row.status === "failed" && (
        <span data-testid="card-result-reason" style={{ color: BUI.textSec }}>
          · {tr(getPublishErrorDisplayKey({ publishError: row.errorMessage, publishErrorCode: row.errorCode }))}
        </span>
      )}
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

  /** The Scheduled-card publish confirm (PRD §20) — publishing early overrides a plan. */
  const publishConfirm = confirmPublish ? (
    <div data-testid="card-publish-confirm" role="dialog"
      style={{ display: "flex", flexDirection: "column", gap: 7, padding: "9px 10px", borderRadius: 9, border: `1px solid ${BUI.borderHi}`, background: BUI.surface2 }}>
      <p style={{ margin: 0, fontSize: 11.5, fontWeight: 800, color: BUI.text }}>{tr("studioBoard.card.publishConfirmTitle")}</p>
      <p style={{ margin: 0, fontSize: 11, color: BUI.textSec, lineHeight: 1.4 }}>
        {tr("studioBoard.card.publishConfirmBody")
          .replace("{date}", scheduledDateLabel(draft))
          .replace("{time}", scheduledTimeLabel(draft))}
      </p>
      <div style={{ display: "flex", gap: 6 }}>
        <button type="button" data-testid="card-publish-confirm-yes" onClick={() => doPublish()} disabled={publishing}
          style={{ ...primaryBtn, padding: "7px 10px", fontSize: 11.5 }}>
          {tr("studioBoard.actions.publish")}
        </button>
        <button type="button" data-testid="card-publish-confirm-cancel" onClick={() => setConfirmPublish(false)}
          style={{ ...secondaryBtn, padding: "7px 12px", fontSize: 11.5 }}>
          {tr("studioBoard.actions.cancel")}
        </button>
      </div>
    </div>
  ) : null;

  /** Posted card: the per-platform summary + the expandable result list (PRD §3). */
  const resultsBlock = (view.hasPublished || view.needsAttention) ? (
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
        style={{ display: "flex", flexDirection: "column", background: BUI.surface, border: `1px solid ${props.selected ? BUI.purple : BUI.border}`, borderRadius: 14, overflow: "hidden", boxShadow: props.selected ? "0 0 0 2px rgba(124,58,237,.12)" : "0 1px 2px rgba(15,23,42,0.04)" }}>
        <div data-testid="card-media" style={{ position: "relative", width: "100%", aspectRatio: "2 / 3", background: BUI.surface3 }}>
          {failed && !isPublishFailure ? (
            // Generation-failure card: walk the original-image fallback chain
            // (generated → source → parent) instead of the raw draft.imageUrl, which
            // may be empty (scratch mode) or a dead snapshot. Never blank/broken.
            <PinCardMedia draft={draft} alt={draft.altText || draft.title || tr("studioBoard.card.pinImageAlt")}
              placeholderVariant="generationFailed" generating={generating} hiddenByQuality={hiddenByQuality} />
          ) : resolveInitialFailureMediaUrl(draft) ? (
            // Publish-failed / healthy cards: same chain, starting at draft.imageUrl
            // (so a genuinely valid final image is always preferred) but falling
            // through source/product/reference/parent — and ultimately the neutral
            // "No image" placeholder — instead of a broken image or a solid-color
            // junk block when imageUrl is dead or degenerate.
            <PinCardMedia draft={draft} alt={draft.altText || draft.title || tr("studioBoard.card.pinImageAlt")}
              placeholderVariant="noImage" generating={generating} hiddenByQuality={hiddenByQuality} />
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
        </div>
        {!generating && <ContentMediaStrip draft={draft} disabled={publishing} />}
        {/* Regenerate stays NEXT TO the media (PRD §7) and targets the selected
            thumbnail — which is the cover, since setCoverMedia moves it to media[0].
            Never regenerates the whole set. */}
        {!generating && !posted && (
          <div style={{ padding: "6px 12px 0", display: "flex" }}>
            <button type="button" data-testid="card-regenerate-image" onClick={doGenerateAiImage} disabled={publishing}
              style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 5px", borderRadius: 6, border: "none", background: "transparent", color: BUI.purple, fontSize: 10.5, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
              <Layers style={{ width: 12, height: 12 }} /> {tr("studioBoard.card.regenerateImage")}
            </button>
          </div>
        )}
        <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
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
          <label style={{ ...labelStyle, display: "flex", flexDirection: "column", gap: 5 }}>
            {tr("studioBoard.card.fields.title")}
            <input data-testid="board-card-title" value={fields.title} disabled={publishing || generating}
              onChange={event => handleChange({ title: event.target.value })} placeholder={tr("studioBoard.card.untitledPin")}
              style={{ ...fieldStyle, fontSize: 12.5, fontWeight: 700, minHeight: 34, padding: "7px 9px" }} />
          </label>
          <label style={{ ...labelStyle, display: "flex", flexDirection: "column", gap: 5 }}>
            {tr("studioBoard.card.fields.description")}
            <textarea data-testid="board-card-description" value={fields.description} disabled={publishing || generating}
              onChange={event => handleChange({ description: event.target.value })} rows={3} placeholder={tr("studioBoard.card.fields.descriptionPlaceholder")}
              style={{ ...fieldStyle, fontSize: 11.5, lineHeight: 1.45, padding: "8px 9px", resize: "vertical", minHeight: 66 }} />
          </label>
          <label style={{ ...labelStyle, display: "flex", flexDirection: "column", gap: 5 }}>
            {tr("studioBoard.card.fields.websiteUrl")}
            <input data-testid="board-card-url" value={fields.websiteUrl} disabled={publishing || generating}
              onChange={event => handleChange({ websiteUrl: event.target.value })} placeholder="https://"
              style={{ ...fieldStyle, fontSize: 11.5, minHeight: 34, padding: "7px 9px" }} />
          </label>
          )}
          <div data-testid="card-publish-to" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <span style={labelStyle}>{tr("studioBoard.card.publishTo")}</span>
              <button type="button" data-testid="card-destination-dropdown" aria-label={tr("studioBoard.card.editDestinations")}
                aria-expanded={destinationsOpen} onClick={() => setDestinationsOpen(open => !open)}
                style={{ width: 26, height: 26, display: "grid", placeItems: "center", border: `1px solid ${BUI.border}`, borderRadius: 7, background: BUI.surface2, padding: 0, color: BUI.textSec, cursor: "pointer" }}>
                <ChevronDown style={{ width: 14, height: 14 }} />
              </button>
            </div>
            <div style={{ position: "relative", display: "flex", flexWrap: "wrap", gap: 5 }}>
              {(destinations.length ? destinations : [{ id: destinationKey("pinterest", null), provider: "pinterest" as const, socialConnectionId: null }]).map(destination => {
                // Tolerates result ids written by earlier shapes, so an un-migrated
                // draft keeps showing its real state instead of reverting to pending.
                const result = findDestinationResult(destinationResults, destination);
                const isFailed = result?.status === "failed";
                return (
                  <span key={destination.id} style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "5px 8px", borderRadius: 8,
                    border: `1px solid ${isFailed ? "#f59e0b66" : BUI.border}`, background: isFailed ? "#fffbeb" : BUI.surface2,
                    color: isFailed ? "#b45309" : BUI.textSec, fontSize: 10.5, fontWeight: 750 }}>
                    <span style={{ width: 6, height: 6, borderRadius: 999, background: isFailed ? "#f59e0b" : result?.status === "published" ? "#22c55e" : BUI.textMuted }} />
                    {destination.provider === "pinterest" ? customerFacingBoardName(destination.boardName, boardSummary) : platformName(destination.provider as SocialProvider)}
                    {/* The account is what disambiguates two chips on one platform. */}
                    {(destination.accountLabel || result?.accountLabel) && (
                      <span style={{ color: BUI.textMuted, fontWeight: 650 }}>{destination.accountLabel || result?.accountLabel}</span>
                    )}
                  </span>
                );
              })}
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
          {publishConfirm}
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
                <button type="button" data-testid="card-try-again" onClick={() => props.onTryAgain(draft)} disabled={publishing} style={primaryBtn}>
                  {publishing ? <Loader2 style={{ width: 13, height: 13 }} className="animate-spin" /> : null} {tr("studioBoard.actions.retry")}
                </button>
                {/* The one actionable next step for this failure category — never a raw message. */}
                {nextStep && (
                  <button type="button" data-testid="card-next-step"
                    onClick={() => { if (nextStep.action === "reconnect") props.onConnect?.(); else startEditing(); }}
                    style={secondaryBtn}>
                    {tr(nextStep.key)}
                  </button>
                )}
                <button type="button" data-testid="card-edit" onClick={startEditing} style={secondaryBtn}>
                  {tr("studioBoard.actions.edit")}
                </button>
              </>
            ) : view.needsAttention ? (
              // Generation failure: not a publish attempt, so its own recovery stands.
              <>
                <button type="button" data-testid="card-try-again" onClick={() => props.onTryAgain(draft)} disabled={publishing} style={primaryBtn}>
                  {publishing ? <Loader2 style={{ width: 13, height: 13 }} className="animate-spin" /> : null} {tr("studioBoard.action.tryAgain")}
                </button>
                <button type="button" data-testid="card-edit" onClick={startEditing} style={secondaryBtn}>
                  {tr("studioBoard.actions.edit")}
                </button>
              </>
            ) : scheduled ? (
              <>
                <button type="button" data-testid="card-edit" onClick={startEditing} style={primaryBtn}>
                  {tr("studioBoard.actions.edit")}
                </button>
                {/* Publishing now overrides the merchant's own plan, so it confirms first. */}
                <button type="button" data-testid="card-publish" onClick={() => setConfirmPublish(true)} disabled={publishing} style={secondaryBtn}>
                  {publishing ? <Loader2 style={{ width: 13, height: 13 }} className="animate-spin" /> : null} {tr("studioBoard.actions.publish")}
                </button>
                <button type="button" data-testid="card-unschedule" onClick={() => props.onUnschedule(draft.id)} style={secondaryBtn}>
                  {tr("studioBoard.actions.unschedule")}
                </button>
              </>
            ) : posted ? (
              <button type="button" data-testid="card-edit" onClick={startEditing} style={primaryBtn}>
                {tr("studioBoard.actions.edit")}
              </button>
            ) : (
              <>
                <button type="button" data-testid="card-schedule" onClick={doSchedule} disabled={publishing} style={primaryBtn}>
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
      style={{ display: "flex", flexDirection: "column", background: BUI.surface, border: `1px solid ${BUI.purple}`, borderRadius: 14, overflow: "hidden", boxShadow: "0 8px 28px rgba(124,58,237,0.16)" }}>
      <div style={{ padding: 14, display: "grid", gridTemplateColumns: "96px minmax(0,1fr)", gap: 14, alignItems: "start", borderBottom: `1px solid ${BUI.border}` }}>
        <div style={{ position: "relative", width: 96, aspectRatio: "2 / 3", borderRadius: 12, overflow: "hidden", border: `1px solid ${BUI.border}`, background: BUI.surface3 }}>
          {failed && !isPublishFailure ? (
            <PinCardMedia draft={draft} alt={draft.altText || draft.title || tr("studioBoard.card.pinImageAlt")}
              placeholderVariant="generationFailed" />
          ) : resolveInitialFailureMediaUrl(draft) ? (
            <PinCardMedia draft={draft} alt={draft.altText || draft.title || tr("studioBoard.card.pinImageAlt")}
              placeholderVariant="noImage" />
          ) : (
            <PinFallbackArtwork busy={generating} />
          )}
          {selectionControl}
        </div>
        <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
            <div style={{ minWidth: 0 }}>
              <p style={{ margin: 0, fontSize: 14, fontWeight: 850, color: BUI.text }}>{tr("pinDetails.editTitle")}</p>
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
            <PinAICopyPanel
              ref={aiRef}
              compact
              draftId={draft.id} imageUrl={draft.imageUrl}
              title={fields.title} description={fields.description} altText={fields.altText}
              boardId={draft.boardId} boardName={draft.boardName}
              category={draft.category} keyword={draft.keyword} destinationUrl={draft.destinationUrl}
              setupSnapshot={draft.setupSnapshot} promptSnapshot={draft.promptSnapshot} opportunity={draft.opportunity}
              imageSummary={draft.imageSummary} recommendedKeywords={draft.recommendedKeywords}
              boards={boards}
              analysisStatus={draft.imageAnalysisStatus} keywordStatus={draft.keywordStatus}
              hasGeneratedBefore={!!draft.metadataDraft?.copyGenerationMeta}
              disabled={publishing}
              onBeforeGenerate={flush}
              onApplyCopy={applyCopy}
            />
            <button type="button" data-testid="card-generate-ai-image" onClick={doGenerateAiImage}
              style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 4, padding: "3px 5px", borderRadius: 6, border: "none", background: "transparent", color: BUI.purple, fontSize: 10.5, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }}>
              <Layers style={{ width: 12, height: 12 }} /> {tr("studioBoard.expanded.generateAiImage")}
            </button>
          </div>
        </div>
      </div>

      <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 12 }}>
        {/* AI actions — Generate copy primary, Create AI Version secondary */}
        <PinFieldsForm value={fields} boards={boards} boardsLoading={boardsLoading} disconnected={disconnected}
          needsReconnect={needsReconnect} boardsError={boardsError} onRetryBoards={onRetryBoards}
          boardFieldError={props.boardFieldError}
          titleFieldError={props.titleFieldError} descriptionFieldError={props.descriptionFieldError}
          disabled={publishing} onChange={handleChange}
          onRegenerateField={() => aiRef.current?.generate()} onConnect={props.onConnect} />

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
                <button type="button" data-testid="card-select-product" disabled={publishing || !props.onSelectProduct}
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
                <textarea data-testid="board-field-alt" value={fields.altText} disabled={publishing}
                  onChange={e => handleChange({ altText: e.target.value })} rows={2}
                  placeholder={tr("studioBoard.expanded.altTextPlaceholder")} style={{ ...fieldStyle, resize: "vertical", minHeight: 48 }} />
              </div>
              <div>
                <span style={labelStyle}>{tr("studioBoard.expanded.tagsOptional")}</span>
                <input data-testid="board-field-tags" value={fields.tags} disabled={publishing}
                  onChange={e => handleChange({ tags: e.target.value })} placeholder={tr("studioBoard.expanded.tagsPlaceholder")} style={fieldStyle} />
              </div>
            </div>
          )}
        </div>

        {/* Failed-card info (expanded): same error/fix/previous-time detail as the
            compact card, shown here too since a failed card can also be expanded
            via Edit. PRD 13. */}
        {failed && (
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
          <span data-testid="card-autosave" style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, fontWeight: 600, color: BUI.textSec }}>
            <Check style={{ width: 12, height: 12, color: BUI.success }} /> {tr("studioBoard.expanded.saved")}
          </span>
          <div style={{ flex: 1 }} />
          {scheduled ? (
            <>
              <span data-testid="card-scheduled-label" style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12, fontWeight: 700, color: BUI.textSec }}>
                <CalendarClock style={{ width: 14, height: 14 }} /> {schedLabel ? tr("studioBoard.expanded.scheduledForPrefix").replace("{time}", schedLabel) : tr("studioBoard.expanded.scheduled")}
              </span>
              <Link data-testid="card-open-in-plan" href={planDeepLink(draft.id)}
                style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "9px 18px", borderRadius: 9, border: "none", background: BUI.gradient, color: "#fff", fontSize: 12.5, fontWeight: 800, textDecoration: "none" }}>
                {tr("studioBoard.expanded.openInPlan")}
              </Link>
            </>
          ) : failed ? (
            isPublishFailure ? (
              <>
                <button type="button" data-testid="card-move-to-unscheduled" onClick={() => props.onMoveToUnscheduled(draft.id)}
                  style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "9px 14px", borderRadius: 9, border: `1px solid ${BUI.border}`, background: BUI.surface2, color: BUI.text, fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
                  {tr("studioBoard.expanded.moveToUnscheduled")}
                </button>
                <button type="button" data-testid="card-try-again" onClick={() => props.onTryAgain(draft)} disabled={publishing}
                  style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "9px 18px", borderRadius: 9, border: "none", background: BUI.gradient, color: "#fff", fontSize: 12.5, fontWeight: 800, cursor: "pointer", fontFamily: "inherit" }}>
                  {publishing ? <Loader2 style={{ width: 14, height: 14 }} className="animate-spin" /> : null} {tr("studioBoard.expanded.retryPublish")}
                </button>
              </>
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
