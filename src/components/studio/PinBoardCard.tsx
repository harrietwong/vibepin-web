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
import { ChevronDown, ChevronUp, ExternalLink, Loader2, MoreVertical, Layers, Check, Pencil, CalendarClock } from "lucide-react";
import { toProxyUrl } from "@/lib/imageProxy";
import type { PinDraft } from "@/lib/pinDraftStore";
import { getSourceBadge, getStatusBadge, type PinLifecycle } from "@/lib/studio/pinLifecycle";
import type { PinterestBoard } from "@/lib/pinterestClient";
import { PinFieldsForm, type PinFieldsValue } from "@/components/pins/PinFieldsForm";
import { PinAICopyPanel, type PinAICopyPanelHandle, type PinAICopyResult } from "@/components/pins/PinAICopyPanel";
import { BUI, toneColor, fieldStyle, labelStyle } from "@/components/studio/boardUI";

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

export type PinBoardCardProps = {
  draft: PinDraft;
  lifecycle: PinLifecycle;
  publishing: boolean;
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
  onPersist: (id: string, patch: Partial<PinDraft>) => void;
  onSchedule: (id: string) => void;
  onGenerateAiImage: (draft: PinDraft) => void;
  onPublish: (id: string) => void;
  onDelete: (draft: PinDraft) => void;
  onArchive: (draft: PinDraft) => void;
  onDuplicate: (id: string) => void;
  /** Remove schedule/plan fields → lifecycle back to Unscheduled. */
  onUnschedule: (id: string) => void;
  /** Download the Pin image via the safe proxy. */
  onDownload: (draft: PinDraft) => void;
  /** Save the image into My References (style_reference asset). */
  onSaveAsReference: (draft: PinDraft) => void;
  /** Failed card primary: retry publish (publish-failed) or reopen AI drawer (generation-failed). */
  onTryAgain: (draft: PinDraft) => void;
  onConnect?: () => void;
};

function PinBoardCardImpl(props: PinBoardCardProps) {
  const { draft, lifecycle, active, boards, boardsLoading, disconnected, needsReconnect, boardsError, onRetryBoards } = props;
  const [fields, setFields] = useState<PinFieldsValue>(() => draftToFields(draft));
  const [menuOpen, setMenuOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [copyContextOpen, setCopyContextOpen] = useState(false);
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

  // Shared AI Copy panel: apply generated copy back to the draft (same fields the old
  // inline handler wrote). fields re-seed from draft.updatedAt after this persists.
  const aiRef = useRef<PinAICopyPanelHandle>(null);
  const applyCopy = useCallback((r: PinAICopyResult) => {
    props.onPersist(draft.id, {
      title: r.title,
      description: r.description,
      altText: r.altText,
      destinationUrl: draft.destinationUrl || r.destinationUrl,
      tags: r.tags.length ? r.tags : draft.tags,
      metadataDraft: r.metadataDraft,
    });
  }, [props, draft.id, draft.destinationUrl, draft.tags]);

  const status = getStatusBadge(draft);
  const source = getSourceBadge(draft);
  const publishing = props.publishing;
  const posted = lifecycle === "posted";
  const failed = lifecycle === "failed";
  const scheduled = lifecycle === "scheduled";
  const generating = lifecycle === "generating";
  // Prefers the real Pinterest URL captured at publish time; reconstructs from
  // remotePinId only for legacy drafts published before remotePinUrl existed.
  const pinUrl = draft.remotePinUrl || (draft.remotePinId ? `https://www.pinterest.com/pin/${draft.remotePinId}/` : "");
  const boardSummary = draft.boardName?.trim() || "No board yet";
  const schedLabel = scheduledSummary(draft);

  const badges = (
    <div style={{ position: "absolute", top: 8, left: 8, display: "flex", flexDirection: "column", gap: 5, alignItems: "flex-start" }}>
      {source && (
        <span data-testid="card-source-badge" style={{ fontSize: 10, fontWeight: 800, color: "#fff", background: "rgba(15,23,42,0.72)", borderRadius: 999, padding: "3px 9px", backdropFilter: "blur(4px)" }}>{source.label}</span>
      )}
      <span data-testid="card-status-badge" style={{ fontSize: 10, fontWeight: 800, color: "#fff", background: toneColor[status.tone] ?? BUI.textSec, borderRadius: 999, padding: "3px 9px", display: "inline-flex", alignItems: "center", gap: 4 }}>
        {publishing && <Loader2 style={{ width: 10, height: 10 }} className="animate-spin" />}{status.label}
      </span>
    </div>
  );

  // PRD card action matrix — More menu items per lifecycle. Generating renders NO
  // More menu at all. Every item stops at the menu (fixed backdrop) so a click never
  // opens/edits the card.
  const menuItems: Array<{ id: string; label: string; onClick: () => void; danger?: boolean }> =
    lifecycle === "failed" ? [
      { id: "regenerate", label: "Regenerate", onClick: () => props.onTryAgain(draft) },
      { id: "delete", label: "Delete", onClick: () => props.onDelete(draft), danger: true },
    ] : lifecycle === "scheduled" ? [
      { id: "duplicate", label: "Duplicate", onClick: () => props.onDuplicate(draft.id) },
      { id: "download", label: "Download", onClick: () => props.onDownload(draft) },
      { id: "unschedule", label: "Unschedule", onClick: () => props.onUnschedule(draft.id) },
    ] : lifecycle === "posted" ? [
      { id: "download", label: "Download", onClick: () => props.onDownload(draft) },
      { id: "save-reference", label: "Save as reference", onClick: () => props.onSaveAsReference(draft) },
      { id: "archive", label: "Archive", onClick: () => props.onArchive(draft) },
    ] : [ // unscheduled
      { id: "publish", label: "Publish now", onClick: doPublish },
      { id: "duplicate", label: "Duplicate", onClick: () => props.onDuplicate(draft.id) },
      { id: "download", label: "Download", onClick: () => props.onDownload(draft) },
      { id: "delete", label: "Delete", onClick: () => props.onDelete(draft), danger: true },
    ];

  const moreMenu = lifecycle === "generating" ? null : (
    <div style={{ position: "absolute", top: 8, right: 8 }}>
      <button type="button" data-testid="card-more" aria-label="More actions" onClick={() => setMenuOpen(o => !o)}
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
        style={{ display: "flex", flexDirection: "column", background: BUI.surface, border: `1px solid ${BUI.border}`, borderRadius: 14, overflow: "hidden", boxShadow: "0 1px 2px rgba(15,23,42,0.04)" }}>
        <div style={{ position: "relative", width: "100%", aspectRatio: "4 / 5", background: BUI.surface3 }}>
          {draft.imageUrl ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img src={toProxyUrl(draft.imageUrl)} alt={draft.altText || draft.title || "Pin image"} loading="lazy"
              style={{ width: "100%", height: "100%", objectFit: "cover", display: "block", opacity: generating ? 0.55 : 1 }} />
          ) : (
            // Scratch-mode Generating placeholder — no source image yet.
            <div data-testid="card-generating-placeholder" style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <Loader2 style={{ width: 26, height: 26, color: BUI.textMuted }} className="animate-spin" />
            </div>
          )}
          {badges}
          {moreMenu}
        </div>
        <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
          <p style={{ margin: 0, fontSize: 13.5, fontWeight: 800, color: BUI.text, overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>
            {draft.title?.trim() || "Untitled Pin"}
          </p>
          <p data-testid="card-board-summary" style={{ margin: 0, fontSize: 11, color: BUI.textMuted, display: "inline-flex", alignItems: "center", gap: 5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {scheduled && schedLabel
              ? <><CalendarClock style={{ width: 12, height: 12 }} /> {schedLabel}</>
              : <>📌 {boardSummary}</>}
          </p>
          {/* PRD action matrix: max 1 primary + 1 secondary + More (More lives on the image). */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 2 }}>
            {generating ? (
              <button type="button" data-testid="card-generating" disabled
                style={{ ...primaryBtn, opacity: 0.6, cursor: "default" }}>
                <Loader2 style={{ width: 13, height: 13 }} className="animate-spin" /> Generating…
              </button>
            ) : failed ? (
              <>
                <button type="button" data-testid="card-try-again" onClick={() => props.onTryAgain(draft)} disabled={publishing} style={primaryBtn}>
                  {publishing ? <Loader2 style={{ width: 13, height: 13 }} className="animate-spin" /> : null} Try again
                </button>
                <button type="button" data-testid="card-edit" onClick={expand} style={secondaryBtn}>
                  <Pencil style={{ width: 12, height: 12 }} /> Edit
                </button>
              </>
            ) : scheduled ? (
              <>
                <button type="button" data-testid="card-edit" onClick={expand} style={primaryBtn}>
                  <Pencil style={{ width: 12, height: 12 }} /> Edit
                </button>
                <Link data-testid="card-view-plan" href="/app/plan" style={{ ...secondaryBtn, textDecoration: "none" }}>
                  View Plan
                </Link>
              </>
            ) : posted ? (
              <>
                {pinUrl ? (
                  <a data-testid="card-view-pin" href={pinUrl} target="_blank" rel="noopener noreferrer" style={{ ...primaryBtn, textDecoration: "none" }}>
                    View Pin <ExternalLink style={{ width: 12, height: 12 }} />
                  </a>
                ) : (
                  <button type="button" data-testid="card-details" onClick={expand} style={primaryBtn}>Details</button>
                )}
                {pinUrl && (
                  <button type="button" data-testid="card-details" onClick={expand} style={secondaryBtn}>Details</button>
                )}
              </>
            ) : (
              <>
                <button type="button" data-testid="card-schedule" onClick={doSchedule} disabled={publishing} style={primaryBtn}>
                  <CalendarClock style={{ width: 13, height: 13 }} /> Schedule
                </button>
                <button type="button" data-testid="card-edit" onClick={expand} style={secondaryBtn}>
                  <Pencil style={{ width: 12, height: 12 }} /> Edit
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
          {draft.imageUrl ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img src={toProxyUrl(draft.imageUrl)} alt={draft.altText || draft.title || "Pin image"} loading="lazy"
              style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
          ) : (
            <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: BUI.textMuted, fontSize: 10, fontWeight: 700 }}>No image</div>
          )}
        </div>
        <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
            <div style={{ minWidth: 0 }}>
              <p style={{ margin: 0, fontSize: 14, fontWeight: 850, color: BUI.text }}>Edit Pin</p>
              <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginTop: 6 }}>
                {source && (
                  <span data-testid="card-source-badge" style={{ fontSize: 10, fontWeight: 800, color: "#fff", background: "rgba(15,23,42,0.72)", borderRadius: 999, padding: "3px 9px" }}>{source.label}</span>
                )}
                <span data-testid="card-status-badge" style={{ fontSize: 10, fontWeight: 800, color: "#fff", background: toneColor[status.tone] ?? BUI.textSec, borderRadius: 999, padding: "3px 9px", display: "inline-flex", alignItems: "center", gap: 4 }}>
                  {publishing && <Loader2 style={{ width: 10, height: 10 }} className="animate-spin" />}{status.label}
                </span>
              </div>
            </div>
            <button type="button" data-testid="card-collapse" aria-label="Collapse" onClick={collapse}
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
            <Layers style={{ width: 13, height: 13 }} /> Generate AI Image
          </button>
        </div>
      </div>

      <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 12 }}>
        {/* AI actions — Generate copy primary, Create AI Version secondary */}
        <PinFieldsForm value={fields} boards={boards} boardsLoading={boardsLoading} disconnected={disconnected}
          needsReconnect={needsReconnect} boardsError={boardsError} onRetryBoards={onRetryBoards}
          boardFieldError={props.boardFieldError}
          disabled={publishing} onChange={handleChange}
          onRegenerateField={() => aiRef.current?.generate()} onConnect={props.onConnect} />

        {/* More details */}
        <div>
          <button type="button" data-testid="card-more-details-toggle" onClick={() => setMoreOpen(o => !o)}
            style={{ display: "inline-flex", alignItems: "center", gap: 5, background: "none", border: "none", padding: 0, fontSize: 11.5, fontWeight: 800, color: BUI.textSec, cursor: "pointer", fontFamily: "inherit" }}>
            More details {moreOpen ? <ChevronUp style={{ width: 13, height: 13 }} /> : <ChevronDown style={{ width: 13, height: 13 }} />}
          </button>
          {moreOpen && (
            <div data-testid="card-more-details" style={{ display: "flex", flexDirection: "column", gap: 11, marginTop: 10 }}>
              <div>
                <span style={labelStyle}>Product · Optional</span>
                <div style={{ ...fieldStyle, display: "flex", alignItems: "center", justifyContent: "space-between", color: BUI.textMuted }}>
                  <span>No linked product</span>
                </div>
              </div>
              <div>
                <span style={labelStyle}>Alt text · Optional</span>
                <textarea data-testid="board-field-alt" value={fields.altText} disabled={publishing}
                  onChange={e => handleChange({ altText: e.target.value })} rows={2}
                  placeholder="Describe the image for accessibility" style={{ ...fieldStyle, resize: "vertical", minHeight: 48 }} />
              </div>
              <div>
                <span style={labelStyle}>Tags · Optional</span>
                <input data-testid="board-field-tags" value={fields.tags} disabled={publishing}
                  onChange={e => handleChange({ tags: e.target.value })} placeholder="#handmade #diy #giftideas" style={fieldStyle} />
              </div>
            </div>
          )}
        </div>

        {/* Footer: autosave + Schedule (no publish-time fields) */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, borderTop: `1px solid ${BUI.border}`, paddingTop: 12 }}>
          <span data-testid="card-autosave" style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, fontWeight: 600, color: BUI.textSec }}>
            <Check style={{ width: 12, height: 12, color: BUI.success }} /> Saved
          </span>
          <div style={{ flex: 1 }} />
          <button type="button" data-testid="card-schedule" onClick={doSchedule} disabled={publishing}
            style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "9px 18px", borderRadius: 9, border: "none", background: BUI.gradient, color: "#fff", fontSize: 12.5, fontWeight: 800, cursor: "pointer", fontFamily: "inherit" }}>
            <CalendarClock style={{ width: 14, height: 14 }} /> Schedule
          </button>
        </div>
      </div>
    </div>
  );
}

export const PinBoardCard = memo(PinBoardCardImpl);
