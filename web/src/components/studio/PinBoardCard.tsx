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

import { memo, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import type { MessageKey } from "@/lib/i18n/messages/en";
import { ChevronDown, ChevronUp, ExternalLink, Loader2, MoreVertical, Layers, Check, Pencil, CalendarClock, X, Star, AlertTriangle } from "lucide-react";
import type { PinDraft } from "@/lib/pinDraftStore";
import { getSourceBadge, getStatusBadge, mapPublishErrorToCategory, type PinLifecycle } from "@/lib/studio/pinLifecycle";
import { PinCardMedia, resolveInitialFailureMediaUrl } from "@/components/studio/PinCardMedia";
import type { PinterestBoard } from "@/lib/pinterestClient";
import { PinFieldsForm, type PinFieldsValue } from "@/components/pins/PinFieldsForm";
import { PinAICopyPanel, type PinAICopyPanelHandle, type PinAICopyResult } from "@/components/pins/PinAICopyPanel";
import { BUI, toneColor, fieldStyle, labelStyle } from "@/components/studio/boardUI";
import { track } from "@/lib/analytics";

const PERSIST_DEBOUNCE = 400;
// Hover → auto-expand delay (ms). Long enough that a mouse merely passing over the
// card while scrolling/scanning the board never triggers an expand; short enough
// that a deliberate pause reads as intent. Mirrors common hover-intent UX timings.
const HOVER_EXPAND_DELAY = 400;

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
// Deep link into /app/plan that reopens the Edit-details drawer for a specific Pin
// (same "?modal=publish&pinId=…" contract the post-OAuth restore flow in
// app/plan/page.tsx already parses — no new mechanism).
function planDeepLink(draftId: string): string {
  return `/app/plan?modal=publish&pinId=${encodeURIComponent(draftId)}`;
}
// "Was scheduled: <time>" — reads the ISO snapshot WP-B captures right before a
// failed publish clears the live schedule fields. Format per PRD "失败情况优化" §5:
// "Was scheduled: Jul 10, 09:38" (24h HH:mm, not 12h AM/PM).
// i18n backfill pending — copy hardcoded per WP-G's explicit i18n exemption (a
// parallel session owns web/src/lib/i18n/messages/ during this work package).
function formatPreviousScheduled(iso: string | undefined): string {
  const v = (iso ?? "").trim();
  if (!v) return "";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "";
  const day = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
  return `Was scheduled: ${day}, ${time}`;
}
// Human-readable recommended-fix copy per failure bucket (PRD "失败情况优化" §5).
// Matches the action-matrix split below: transient gets its own message; content AND
// "no category" (legacy drafts / undetermined) share the content message.
// i18n backfill pending — copy hardcoded per WP-G's explicit i18n exemption (the
// existing studioBoard.card.fix.* i18n keys carry the OLDER copy; a parallel session
// owns web/src/lib/i18n/messages/ during this work package so those keys are left
// untouched — this function intentionally no longer reads them).
function recommendedFix(tr: (key: MessageKey) => string, category: "transient" | "content" | "auth" | undefined): string {
  void tr; // kept in the signature so call sites don't need to change
  if (category === "auth") return "Reconnect Pinterest, then retry.";
  if (category === "transient") return "Usually temporary — try publishing again.";
  return "Fix the Pin details, then retry.";
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
  onGenerateAiImage: (draft: PinDraft) => void;
  onPublish: (id: string) => void;
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
  const [copyContextOpen, setCopyContextOpen] = useState(false);
  // Keyword-chip interaction state (compact card): which chip shows its remove ×, and
  // which chip is briefly flashing "Copied". Card is keyed by draft.id upstream, so this
  // never leaks across drafts.
  const [hoveredKw, setHoveredKw] = useState<string | null>(null);
  const [copiedKw, setCopiedKw] = useState<string | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selfEdit = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<PinFieldsValue>(fields);
  // Hover-to-expand (compact card only): a deliberate pause over the card auto-opens
  // the Quick Edit state, same as clicking Edit. Mouse-out never auto-collapses (the
  // user may be mid-edit) — collapsing stays on the explicit collapse control / picking
  // another card. Cleared on unmount and on every re-trigger to avoid a stray expand
  // firing after the card is gone or already active.
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (hoverTimer.current) clearTimeout(hoverTimer.current); }, []);

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
    });
  }, [props, draft.id, boardName]);

  const flush = useCallback(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; persistNow(pendingRef.current); }
  }, [persistNow]);

  useEffect(() => () => { if (timer.current) { clearTimeout(timer.current); persistNow(pendingRef.current); } }, [persistNow]);

  const handleChange = useCallback((patch: Partial<PinFieldsValue>) => {
    selfEdit.current = true;
    const next = { ...pendingRef.current, ...patch };
    pendingRef.current = next;
    setFields(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { timer.current = null; persistNow(next); }, PERSIST_DEBOUNCE);
  }, [persistNow]);

  // Actions flush pending edits first.
  const doSchedule = useCallback(() => { flush(); props.onSchedule(draft.id); }, [flush, props, draft.id]);
  const doGenerateAiImage = useCallback(() => { flush(); props.onGenerateAiImage(draft); }, [flush, props, draft]);
  const doPublish = useCallback(() => { flush(); props.onPublish(draft.id); }, [flush, props, draft.id]);
  const expand = useCallback(() => props.onSetActive(draft.id), [props, draft.id]);
  const collapse = useCallback(() => { flush(); props.onSetActive(null); }, [flush, props]);

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
  const isPublishFailure = !!draft.publishError?.trim();
  const failureCategory = draft.errorCategory ?? (isPublishFailure ? mapPublishErrorToCategory(draft.publishErrorCode, draft.publishError) : undefined);

  const status = getStatusBadge(draft);
  // Badge copy override for the failed lifecycle only (PRD "失败情况优化" §5): the
  // shared getStatusBadge() in pinLifecycle.ts still returns the generic "Failed" —
  // overridden here rather than in the shared helper since PinBoardCard is its only
  // caller and already computes isPublishFailure for the action matrix below.
  // i18n backfill pending (WP-G exemption — parallel session owns the i18n catalogs).
  const statusLabel = status.lifecycle === "failed" ? (isPublishFailure ? "Publish failed" : "Generation failed") : status.label;
  const source = getSourceBadge(draft);
  const publishing = props.publishing;
  const posted = lifecycle === "posted";
  const failed = lifecycle === "failed";
  const scheduled = lifecycle === "scheduled";
  const generating = lifecycle === "generating";
  // Prefers the real Pinterest URL captured at publish time; reconstructs from
  // remotePinId only for legacy drafts published before remotePinUrl existed.
  const pinUrl = draft.remotePinUrl || (draft.remotePinId ? `https://www.pinterest.com/pin/${draft.remotePinId}/` : "");
  const boardSummary = draft.boardName?.trim() || tr("studioBoard.card.noBoardYet");
  const schedLabel = scheduledSummary(draft);
  // Recommended high-search Pinterest keywords (only real, ready results — no empty
  // shell, no loading state, capped at 8). NEVER labeled "Trending" (data honesty).
  const keywordChips = draft.keywordStatus === "ready" ? (draft.recommendedKeywords ?? []).slice(0, 8) : [];

  // Hover intent (compact card only): schedule an expand after HOVER_EXPAND_DELAY; a
  // quick pass-over (mouse leaves before the timer fires) cancels it via
  // onCardMouseLeave, so scanning/scrolling across many cards never triggers one.
  // Guarded on `active` (nothing to do — already expanded) and `generating` (no
  // editable content yet).
  const onCardMouseEnter = useCallback(() => {
    if (active || generating) return;
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => { hoverTimer.current = null; expand(); }, HOVER_EXPAND_DELAY);
  }, [active, generating, expand]);
  const onCardMouseLeave = useCallback(() => {
    if (hoverTimer.current) { clearTimeout(hoverTimer.current); hoverTimer.current = null; }
  }, []);

  const badges = (
    <div style={{ position: "absolute", top: 8, left: 8, display: "flex", flexDirection: "column", gap: 5, alignItems: "flex-start" }}>
      {source && (
        <span data-testid="card-source-badge" style={{ fontSize: 10, fontWeight: 800, color: "#fff", background: "rgba(15,23,42,0.72)", borderRadius: 999, padding: "3px 9px", backdropFilter: "blur(4px)" }}>{source.label}</span>
      )}
      <span data-testid="card-status-badge" style={{ fontSize: 10, fontWeight: 800, color: "#fff", background: toneColor[status.tone] ?? BUI.textSec, borderRadius: 999, padding: "3px 9px", display: "inline-flex", alignItems: "center", gap: 4 }}>
        {publishing && <Loader2 style={{ width: 10, height: 10 }} className="animate-spin" />}{statusLabel}
      </span>
    </div>
  );

  // PRD card action matrix — More menu items per lifecycle. Generating renders NO
  // More menu at all. Every item stops at the menu (fixed backdrop) so a click never
  // opens/edits the card.
  const menuItems: Array<{ id: string; label: string; onClick: () => void; danger?: boolean }> =
    lifecycle === "failed" ? (isPublishFailure ? [
      { id: "move-to-unscheduled", label: tr("studioBoard.menu.moveToUnscheduled"), onClick: () => props.onMoveToUnscheduled(draft.id) },
      { id: "delete", label: tr("studioBoard.menu.delete"), onClick: () => props.onDelete(draft), danger: true },
    ] : [
      { id: "regenerate", label: tr("studioBoard.menu.regenerate"), onClick: () => props.onTryAgain(draft) },
      { id: "delete", label: tr("studioBoard.menu.delete"), onClick: () => props.onDelete(draft), danger: true },
    ]) : lifecycle === "scheduled" ? [
      { id: "duplicate", label: tr("studioBoard.menu.duplicate"), onClick: () => props.onDuplicate(draft.id) },
      { id: "download", label: tr("studioBoard.menu.download"), onClick: () => props.onDownload(draft) },
      { id: "unschedule", label: tr("studioBoard.menu.unschedule"), onClick: () => props.onUnschedule(draft.id) },
    ] : lifecycle === "posted" ? [
      { id: "download", label: tr("studioBoard.menu.download"), onClick: () => props.onDownload(draft) },
      { id: "save-reference", label: tr("studioBoard.menu.saveAsReference"), onClick: () => props.onSaveAsReference(draft) },
      { id: "archive", label: tr("studioBoard.menu.archive"), onClick: () => props.onArchive(draft) },
    ] : [ // unscheduled
      { id: "publish", label: tr("studioBoard.menu.publishNow"), onClick: doPublish },
      { id: "duplicate", label: tr("studioBoard.menu.duplicate"), onClick: () => props.onDuplicate(draft.id) },
      { id: "download", label: tr("studioBoard.menu.download"), onClick: () => props.onDownload(draft) },
      { id: "delete", label: tr("studioBoard.menu.delete"), onClick: () => props.onDelete(draft), danger: true },
    ];

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
                onClick={() => { setMenuOpen(false); item.onClick(); }}
                style={menuItemStyle(i > 0, !!item.danger)}>
                {item.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );

  // ── Compact (default) ─────────────────────────────────────────────────────────
  if (!active) {
    return (
      <div data-testid="pin-board-card" data-active="false" data-source={draft.source} data-lifecycle={lifecycle}
        onMouseEnter={onCardMouseEnter} onMouseLeave={onCardMouseLeave}
        style={{ display: "flex", flexDirection: "column", background: BUI.surface, border: `1px solid ${BUI.border}`, borderRadius: 14, overflow: "hidden", boxShadow: "0 1px 2px rgba(15,23,42,0.04)" }}>
        <div style={{ position: "relative", width: "100%", aspectRatio: "4 / 5", background: BUI.surface3 }}>
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
            // Scratch-mode Generating placeholder — no candidate anywhere in the chain yet.
            <div data-testid="card-generating-placeholder" style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <Loader2 style={{ width: 26, height: 26, color: BUI.textMuted }} className="animate-spin" />
            </div>
          )}
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
          {props.topPick && !hiddenByQuality && !generating && (
            <span data-testid="card-top-pick" style={{ position: "absolute", bottom: 8, left: 8, display: "inline-flex", alignItems: "center", gap: 4, fontSize: 10, fontWeight: 800, color: "#fff", background: "rgba(124,58,237,0.92)", borderRadius: 999, padding: "3px 9px", backdropFilter: "blur(4px)" }}>
              <Star style={{ width: 10, height: 10, fill: "#fff" }} /> {tr("studioBoard.card.topPick")}
            </span>
          )}
        </div>
        <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
          <p style={{ margin: 0, fontSize: 13.5, fontWeight: 800, color: BUI.text, overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>
            {draft.title?.trim() || tr("studioBoard.card.untitledPin")}
          </p>
          <p data-testid="card-board-summary" style={{ margin: 0, fontSize: 11, color: BUI.textMuted, display: "inline-flex", alignItems: "center", gap: 5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {scheduled && schedLabel
              ? <><CalendarClock style={{ width: 12, height: 12 }} /> {schedLabel}</>
              : <>📌 {boardSummary}</>}
          </p>
          {/* PRD 13 — Failed card info: error text, a recommended fix per bucket, and
              the schedule slot that was lost (if any). Kept compact; full detail also
              shows in the expanded card. */}
          {failed && (
            <div data-testid="card-failed-info" style={{ display: "flex", flexDirection: "column", gap: 3, padding: "8px 10px", borderRadius: 8, background: "rgba(239,68,68,0.08)", border: `1px solid ${BUI.error}33` }}>
              {draft.publishError?.trim() && (
                <p data-testid="card-failed-reason" style={{ margin: 0, fontSize: 11, fontWeight: 700, color: BUI.error, display: "flex", alignItems: "flex-start", gap: 5, lineHeight: 1.35 }}>
                  <AlertTriangle style={{ width: 12, height: 12, flexShrink: 0, marginTop: 1 }} /> {draft.publishError}
                </p>
              )}
              {isPublishFailure && (
                <p data-testid="card-failed-fix" style={{ margin: 0, fontSize: 10.5, color: BUI.textSec, lineHeight: 1.4 }}>{recommendedFix(tr, failureCategory)}</p>
              )}
              {formatPreviousScheduled(draft.previousScheduledTime) && (
                <p data-testid="card-failed-previous-time" style={{ margin: 0, fontSize: 10.5, color: BUI.textMuted }}>
                  {formatPreviousScheduled(draft.previousScheduledTime)}
                </p>
              )}
            </div>
          )}
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
          {/* PRD action matrix: max 1 primary + 1 secondary + More (More lives on the image). */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 2 }}>
            {generating ? (
              <button type="button" data-testid="card-generating" disabled
                style={{ ...primaryBtn, opacity: 0.6, cursor: "default" }}>
                <Loader2 style={{ width: 13, height: 13 }} className="animate-spin" /> {tr("studioBoard.action.generating")}
              </button>
            ) : failed ? (
              // PRD 13 action matrix: transient failures lead with Retry (the fix is to
              // just try again); content/unknown failures lead with Edit (retrying the
              // same payload won't help until something changes). Generation failures
              // (not a publish attempt) keep the original Try again / Edit order.
              (isPublishFailure && failureCategory === "content") ? (
                <>
                  <button type="button" data-testid="card-edit" onClick={expand} style={primaryBtn}>
                    <Pencil style={{ width: 12, height: 12 }} /> {tr("studioBoard.action.edit")}
                  </button>
                  <button type="button" data-testid="card-try-again" onClick={() => props.onTryAgain(draft)} disabled={publishing} style={secondaryBtn}>
                    {publishing ? <Loader2 style={{ width: 13, height: 13 }} className="animate-spin" /> : null} {tr("studioBoard.action.retryPublish")}
                  </button>
                </>
              ) : (
                <>
                  <button type="button" data-testid="card-try-again" onClick={() => props.onTryAgain(draft)} disabled={publishing} style={primaryBtn}>
                    {publishing ? <Loader2 style={{ width: 13, height: 13 }} className="animate-spin" /> : null} {isPublishFailure ? tr("studioBoard.action.retryPublish") : tr("studioBoard.action.tryAgain")}
                  </button>
                  <button type="button" data-testid="card-edit" onClick={expand} style={secondaryBtn}>
                    <Pencil style={{ width: 12, height: 12 }} /> {tr("studioBoard.action.edit")}
                  </button>
                </>
              )
            ) : scheduled ? (
              <>
                <button type="button" data-testid="card-edit" onClick={expand} style={primaryBtn}>
                  <Pencil style={{ width: 12, height: 12 }} /> {tr("studioBoard.action.edit")}
                </button>
                <Link data-testid="card-view-plan" href={planDeepLink(draft.id)} style={{ ...secondaryBtn, textDecoration: "none" }}>
                  {tr("studioBoard.action.viewPlan")}
                </Link>
              </>
            ) : posted ? (
              <>
                {pinUrl ? (
                  <a data-testid="card-view-pin" href={pinUrl} target="_blank" rel="noopener noreferrer" style={{ ...primaryBtn, textDecoration: "none" }}>
                    {tr("studioBoard.action.viewPin")} <ExternalLink style={{ width: 12, height: 12 }} />
                  </a>
                ) : (
                  <button type="button" data-testid="card-details" onClick={expand} style={primaryBtn}>{tr("studioBoard.action.details")}</button>
                )}
                {pinUrl && (
                  <button type="button" data-testid="card-details" onClick={expand} style={secondaryBtn}>{tr("studioBoard.action.details")}</button>
                )}
              </>
            ) : (
              <>
                <button type="button" data-testid="card-schedule" onClick={doSchedule} disabled={publishing} style={primaryBtn}>
                  <CalendarClock style={{ width: 13, height: 13 }} /> {tr("studioBoard.action.schedule")}
                </button>
                <button type="button" data-testid="card-edit" onClick={expand} style={secondaryBtn}>
                  <Pencil style={{ width: 12, height: 12 }} /> {tr("studioBoard.action.edit")}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ── Expanded (active) quick edit ────────────────────────────────────────────────
  return (
    <div data-testid="pin-board-card" data-active="true" data-source={draft.source} data-lifecycle={lifecycle}
      style={{ display: "flex", flexDirection: "column", background: BUI.surface, border: `1px solid ${BUI.purple}`, borderRadius: 14, overflow: "hidden", boxShadow: "0 8px 28px rgba(124,58,237,0.16)", gridColumn: "span 2", maxWidth: 760 }}>
      <div style={{ padding: 14, display: "grid", gridTemplateColumns: "96px minmax(0,1fr)", gap: 14, alignItems: "start", borderBottom: `1px solid ${BUI.border}` }}>
        <div style={{ width: 96, aspectRatio: "2 / 3", borderRadius: 12, overflow: "hidden", border: `1px solid ${BUI.border}`, background: BUI.surface3 }}>
          {failed && !isPublishFailure ? (
            <PinCardMedia draft={draft} alt={draft.altText || draft.title || tr("studioBoard.card.pinImageAlt")}
              placeholderVariant="generationFailed" />
          ) : resolveInitialFailureMediaUrl(draft) ? (
            <PinCardMedia draft={draft} alt={draft.altText || draft.title || tr("studioBoard.card.pinImageAlt")}
              placeholderVariant="noImage" />
          ) : (
            <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: BUI.textMuted, fontSize: 10, fontWeight: 700 }}>{tr("studioBoard.card.noImage")}</div>
          )}
        </div>
        <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
            <div style={{ minWidth: 0 }}>
              <p style={{ margin: 0, fontSize: 14, fontWeight: 850, color: BUI.text }}>{tr("pinDetails.editTitle")}</p>
              <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginTop: 6 }}>
                {source && (
                  <span data-testid="card-source-badge" style={{ fontSize: 10, fontWeight: 800, color: "#fff", background: "rgba(15,23,42,0.72)", borderRadius: 999, padding: "3px 9px" }}>{source.label}</span>
                )}
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
          <PinAICopyPanel
            ref={aiRef}
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
            style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6, padding: "9px 12px", borderRadius: 9, border: `1px solid ${BUI.purple}`, background: "rgba(124,58,237,0.06)", color: BUI.purple, fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }}>
            <Layers style={{ width: 13, height: 13 }} /> {tr("studioBoard.expanded.generateAiImage")}
          </button>
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
                <div style={{ ...fieldStyle, display: "flex", alignItems: "center", justifyContent: "space-between", color: BUI.textMuted }}>
                  <span>{tr("studioBoard.expanded.noLinkedProduct")}</span>
                </div>
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
            {draft.publishError?.trim() && (
              <p style={{ margin: 0, fontSize: 12, fontWeight: 700, color: BUI.error, display: "flex", alignItems: "flex-start", gap: 6, lineHeight: 1.4 }}>
                <AlertTriangle style={{ width: 13, height: 13, flexShrink: 0, marginTop: 1 }} /> {draft.publishError}
              </p>
            )}
            {isPublishFailure && (
              <p style={{ margin: 0, fontSize: 11, color: BUI.textSec, lineHeight: 1.45 }}>{recommendedFix(tr, failureCategory)}</p>
            )}
            {formatPreviousScheduled(draft.previousScheduledTime) && (
              <p style={{ margin: 0, fontSize: 11, color: BUI.textMuted }}>
                {formatPreviousScheduled(draft.previousScheduledTime)}
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
            // to redesign the Posted footer further).
            pinUrl ? (
              <a data-testid="card-view-pin" href={pinUrl} target="_blank" rel="noopener noreferrer"
                style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "9px 18px", borderRadius: 9, border: "none", background: BUI.gradient, color: "#fff", fontSize: 12.5, fontWeight: 800, textDecoration: "none" }}>
                {tr("studioBoard.action.viewPin")} <ExternalLink style={{ width: 12, height: 12 }} />
              </a>
            ) : (
              <span style={{ fontSize: 12, fontWeight: 700, color: BUI.textSec }}>{tr("studioBoard.expanded.posted")}</span>
            )
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
