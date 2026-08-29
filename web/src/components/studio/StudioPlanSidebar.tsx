"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CalendarDays, Check, ChevronLeft, ChevronRight, PanelRightClose, PanelRightOpen, TriangleAlert, X } from "lucide-react";
import type { PinDraft } from "@/lib/pinDraftStore";
import type { PublishProvider } from "@/lib/contentDraftModel";
import { BUI } from "@/components/studio/boardUI";
import { toProxyUrl } from "@/lib/imageProxy";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import type { MessageKey } from "@/lib/i18n/messages/en";
import { useViewportBucket } from "@/hooks/useViewportBucket";
import {
  buildWeek,
  countWeekScheduled,
  formatBadge,
  isDateInWeek,
  nextBadgeCount,
  startOfWeek,
  weekStartForDate,
  type PlanItemState,
  type PlanSidebarDay,
  type PlanSidebarItem,
} from "@/lib/studio/planSidebarModel";

// Enough room for a readable 7-day strip, but narrow enough that the Create Pins
// workspace keeps two card columns at normal desktop widths.
const PANEL_WIDTH = 344;

/** How long the just-scheduled item keeps its purple ring (PRD §24). */
const HIGHLIGHT_MS = 2000;

/**
 * What StudioBoard reports after a schedule succeeds.
 *
 * `ids` is a list, not a single id, because a batch schedule of N items has to move
 * the badge by N — a single-id prop would have forced the board to fire N times and
 * the sidebar to de-duplicate them by timestamp. `at` is a monotonic stamp (Date.now())
 * used purely to tell a NEW event from a re-render carrying the same object.
 */
export type PlanScheduleSignal = { ids: string[]; at: number };

function planDeepLink(draftId: string): string {
  return `/app/studio?view=plan&modal=publish&pinId=${encodeURIComponent(draftId)}`;
}

/** Pinterest has no lucide glyph, so the three providers share one tiny inline set.
 *  These are decorative next to a text label, hence aria-hidden. */
function ProviderIcon({ provider, title }: { provider: PublishProvider; title: string }) {
  const common = { width: 9, height: 9, viewBox: "0 0 24 24", "aria-hidden": true as const, focusable: "false" as const };
  if (provider === "pinterest") {
    return (
      <svg {...common} fill="#E60023"><title>{title}</title>
        <path d="M12 0C5.373 0 0 5.372 0 12c0 5.084 3.163 9.426 7.627 11.174-.105-.949-.2-2.405.042-3.441.218-.937 1.407-5.965 1.407-5.965s-.359-.719-.359-1.782c0-1.668.967-2.914 2.171-2.914 1.023 0 1.518.769 1.518 1.69 0 1.029-.655 2.568-.994 3.995-.283 1.194.599 2.169 1.777 2.169 2.133 0 3.772-2.249 3.772-5.495 0-2.873-2.064-4.882-5.012-4.882-3.414 0-5.418 2.561-5.418 5.207 0 1.031.397 2.138.893 2.738a.36.36 0 0 1 .083.345c-.091.379-.293 1.194-.333 1.361-.052.22-.174.267-.402.161-1.499-.698-2.436-2.889-2.436-4.649 0-3.785 2.75-7.262 7.929-7.262 4.163 0 7.398 2.967 7.398 6.931 0 4.136-2.607 7.464-6.227 7.464-1.216 0-2.359-.632-2.75-1.378l-.748 2.853c-.271 1.043-1.002 2.35-1.492 3.146A12 12 0 0 0 12 24c6.627 0 12-5.373 12-12S18.627 0 12 0z" />
      </svg>
    );
  }
  if (provider === "instagram") {
    return (
      <svg {...common} fill="none" stroke="#C13584" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round"><title>{title}</title>
        <rect x="2" y="2" width="20" height="20" rx="5" /><circle cx="12" cy="12" r="4" /><circle cx="17.5" cy="6.5" r="1.2" fill="#C13584" stroke="none" />
      </svg>
    );
  }
  return (
    <svg {...common} fill="#1877F2"><title>{title}</title>
      <path d="M24 12.073C24 5.405 18.627 0 12 0S0 5.405 0 12.073C0 18.1 4.388 23.094 10.125 24v-8.437H7.078v-3.49h3.047V9.412c0-3.025 1.792-4.697 4.533-4.697 1.313 0 2.686.236 2.686.236v2.971H15.83c-1.491 0-1.956.93-1.956 1.886v2.265h3.328l-.532 3.49h-2.796V24C19.612 23.094 24 18.1 24 12.073z" />
    </svg>
  );
}

const STATE_COLOR: Record<PlanItemState, string> = {
  scheduled: BUI.textSec,
  posted: BUI.textSec,
  failed: "#D97706",
};

/**
 * The Plan entry inside Create Pins (PRD 0809 §IX). One component, three forms — the
 * form is chosen by viewport bucket, never by hover capability:
 *
 *   desktop (>= 1280) — the docked, collapsible right panel. Unchanged: hover/focus
 *                       peeks it, the trigger pins it, pinning reflows the board grid.
 *   tablet  (768–1279) — the trigger opens a right-side DRAWER over the board. No grid
 *                       reflow (the panel takes no layout space), scrim, Escape closes.
 *   mobile  (< 768)   — the trigger opens a FULL-SCREEN overlay with the same content.
 *
 * Hover is never the only way in: in every form the trigger is a real <button> with an
 * accessible label and an onClick, and the two overlay forms attach no hover handlers
 * at all (a tablet with a mouse must not get hover-driven state changes).
 */
export function StudioPlanSidebar({ drafts, pinned, onPinnedChange, lastScheduled }: {
  drafts: PinDraft[];
  pinned: boolean;
  onPinnedChange: (pinned: boolean) => void;
  /** Fired by StudioBoard whenever one or more drafts were just scheduled (PRD §24). */
  lastScheduled?: PlanScheduleSignal;
}) {
  const { t: tr } = useLocale();
  const bucket = useViewportBucket();
  // "docked" is the only place the bucket turns into behaviour: it decides whether the
  // panel participates in layout (desktop) or floats over it (tablet/mobile).
  const docked = bucket === "desktop";
  const [hoverOpen, setHoverOpen] = useState(false);
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const [badge, setBadge] = useState(0);
  const [highlight, setHighlight] = useState<{ id: string; at: number } | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  const overlayPanelRef = useRef<HTMLElement | null>(null);
  // Only restore focus to the trigger if WE moved it into the dialog — otherwise the
  // first render would steal focus from wherever the user actually was.
  const restoreFocus = useRef(false);
  // Which §24 signal we already reacted to. State, not a ref, because it is written
  // during render (a ref written during render is not safe under concurrent React).
  const [seenAt, setSeenAt] = useState(() => lastScheduled?.at ?? 0);
  // The one "is the Plan content visible" flag, whatever the form. Everything below
  // (badge clearing, §24 highlighting, Escape) reads this and stays form-agnostic.
  const open = docked ? (pinned || hoverOpen) : overlayOpen;

  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current); }, []);

  // A form change (rotating a tablet, dragging a desktop window narrow) must not leave
  // the other form's "open" flag armed, or the panel reappears unasked on the way back.
  // Adjusted during render like the two rules below — an effect here would paint one
  // frame of the new form still carrying the old form's open state.
  const [lastDocked, setLastDocked] = useState(docked);
  if (lastDocked !== docked) {
    setLastDocked(docked);
    if (docked) setOverlayOpen(false);
    else setHoverOpen(false);
  }

  // ── State adjusted during render, not in effects ───────────────────────────
  // Both of the rules below are "derive state from props/state", which React wants
  // computed during render rather than in an effect: an effect would render once with
  // the stale value and then again with the right one, and — for the badge — would
  // miss the case where `pinned` arrives true from localStorage after mount, since
  // that open transition passes through no event handler of ours.

  // The badge counts what happened while the panel was AWAY. Opening it, by any route
  // (hover, focus, click, or a restored pin), means the user has now seen it.
  if (open && badge !== 0) setBadge(0);

  // §24: a schedule just succeeded.
  if (lastScheduled && lastScheduled.at > seenAt) {
    setSeenAt(lastScheduled.at);
    const ids = lastScheduled.ids.filter(Boolean);
    if (ids.length) {
      if (!open) {
        // Closed and unpinned: never steal attention by opening. Only count.
        // Value form, not the updater form: under StrictMode's double render an
        // updater queued during render can apply twice, whereas a value computed
        // from this render's `badge` is idempotent (the at > seenAt guard already
        // limits us to one application per signal).
        setBadge(nextBadgeCount(badge, ids.length));
      } else {
        // Open: show where the Pin landed — jump the week only if it is off-screen,
        // then ring it briefly.
        const target = ids[0];
        const draft = drafts.find(d => d.id === target);
        const dateStr = (draft?.plannedAt || draft?.scheduledDate || "").slice(0, 10);
        if (dateStr && !isDateInWeek(dateStr, weekStart)) {
          const jump = weekStartForDate(dateStr);
          if (jump) setWeekStart(jump);
        }
        // Keyed by `at` as well as id, so scheduling the same draft twice re-arms
        // the ring instead of leaving the first timeout to end it early.
        setHighlight({ id: target, at: lastScheduled.at });
      }
    }
  }

  // The ring is a timed visual, so its expiry genuinely is a subscription to an
  // external system (the clock) — the one thing effects are for.
  useEffect(() => {
    if (!highlight) return;
    const timer = setTimeout(() => setHighlight(null), HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [highlight]);

  const days = useMemo(() => buildWeek(drafts, weekStart), [drafts, weekStart]);
  const scheduledCount = useMemo(() => countWeekScheduled(days), [days]);

  const reveal = useCallback(() => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    setHoverOpen(true);
  }, []);

  const scheduleClose = useCallback(() => {
    if (pinned) return;
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setHoverOpen(false), 240);
  }, [pinned]);

  const closeOverlay = useCallback(() => setOverlayOpen(false), []);

  // Escape closes an unpinned desktop panel (a pinned one is a layout choice, not a
  // popup — Escape must not silently undo something the user deliberately pinned), and
  // ALWAYS closes the drawer/sheet, which are modal popups by construction.
  const escapeCloses = docked ? (hoverOpen && !pinned) : overlayOpen;
  useEffect(() => {
    if (!escapeCloses) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      if (closeTimer.current) clearTimeout(closeTimer.current);
      setHoverOpen(false);
      setOverlayOpen(false);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [escapeCloses]);

  // The overlay forms cover the page, so the page behind them must not scroll away
  // under the user's finger. Save/restore rather than blanket-clear: another modal may
  // have set it first.
  useEffect(() => {
    if (docked || !overlayOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previous; };
  }, [docked, overlayOpen]);

  // Dialog focus contract: into the panel on open, back to the trigger on close
  // (Escape, scrim, or the close button — they all funnel through overlayOpen).
  useEffect(() => {
    if (!docked && overlayOpen) {
      overlayPanelRef.current?.focus();
      restoreFocus.current = true;
      return;
    }
    if (restoreFocus.current) {
      restoreFocus.current = false;
      if (!docked) toggleRef.current?.focus();
    }
  }, [docked, overlayOpen]);

  function moveWeek(delta: number) {
    setWeekStart(current => {
      const next = new Date(current);
      next.setDate(next.getDate() + delta * 7);
      return next;
    });
  }

  const goPrevWeek = () => moveWeek(-1);
  const goNextWeek = () => moveWeek(1);
  const goToday = () => setWeekStart(startOfWeek(new Date()));

  const end = days[6].date;
  const range = `${weekStart.toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${end.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;
  const countLabel = scheduledCount === 0
    ? tr("studioBoard.plan.nothingScheduledThisWeek")
    : scheduledCount === 1
      ? tr("studioBoard.plan.oneScheduledThisWeek")
      : tr("studioBoard.plan.scheduledThisWeek").replace("{n}", String(scheduledCount));
  const toggleLabel = pinned ? tr("studioBoard.plan.close") : tr("studioBoard.plan.open");
  // The overlay forms pin nothing, so "Keep Plan open" would be a lie there — they say
  // "Open Plan" / "Close Plan" instead.
  const triggerLabel = docked
    ? toggleLabel
    : overlayOpen ? tr("studioBoard.plan.close") : tr("studioBoard.plan.openPanel");
  const badgeLabel = formatBadge(badge);
  // The trigger only changes shape for the docked panel it is attached to; in the
  // overlay forms it stays put (a dialog's opener must not move out from under the
  // pointer, and it is the element focus returns to on close).
  const railOpen = docked && open;

  return (
    <>
      <button type="button" data-testid="studio-plan-toggle" ref={toggleRef}
        aria-label={triggerLabel} aria-pressed={docked ? pinned : undefined} aria-expanded={open}
        title={badge > 0 ? tr("studioBoard.plan.newSinceLastOpen").replace("{n}", String(badge)) : triggerLabel}
        onMouseEnter={docked ? reveal : undefined} onMouseLeave={docked ? scheduleClose : undefined}
        onFocus={docked ? reveal : undefined} onBlur={docked ? scheduleClose : undefined}
        onClick={() => {
          if (!docked) {
            // Tablet / mobile: one explicit, keyboard-reachable toggle for the overlay.
            setOverlayOpen(value => !value);
            return;
          }
          if (pinned) {
            setHoverOpen(false);
            onPinnedChange(false);
          } else {
            setHoverOpen(true);
            onPinnedChange(true);
          }
        }}
        style={{
          position: "absolute", zIndex: 45, top: railOpen ? 13 : "38%", right: railOpen ? 12 : 0,
          width: railOpen ? 30 : 28, height: railOpen ? 30 : 44,
          border: `1px solid ${BUI.border}`, borderRight: railOpen ? `1px solid ${BUI.border}` : "none",
          borderRadius: railOpen ? 8 : "9px 0 0 9px",
          background: pinned && docked ? "rgba(124,58,237,0.12)" : BUI.surface,
          color: pinned && docked ? BUI.purple : BUI.textSec, cursor: "pointer",
          boxShadow: railOpen ? "none" : "-4px 0 14px rgba(15,23,42,0.08)",
          display: "grid", placeItems: "center", padding: 0,
        }}>
        {pinned && docked ? <PanelRightClose style={{ width: 16, height: 16 }} /> : <PanelRightOpen style={{ width: 16, height: 16 }} />}
        {badgeLabel && (
          <span data-testid="studio-plan-badge"
            style={{
              position: "absolute", top: -6, left: -8, minWidth: 17, height: 17, padding: "0 4px",
              borderRadius: 9, background: BUI.purple, color: "#fff",
              fontSize: 9.5, fontWeight: 800, lineHeight: "17px", textAlign: "center",
              boxShadow: "0 2px 6px rgba(124,58,237,0.4)", pointerEvents: "none",
            }}>{badgeLabel}</span>
        )}
      </button>

      {docked && open && (
        <aside data-testid="studio-plan-sidebar" data-pinned={pinned ? "true" : "false"}
          aria-label={tr("studioBoard.plan.title")}
          onMouseEnter={reveal} onMouseLeave={scheduleClose}
          style={{
            width: PANEL_WIDTH, minWidth: PANEL_WIDTH, minHeight: 0, display: "flex", flexDirection: "column",
            background: BUI.surface, borderLeft: `1px solid ${BUI.border}`,
            position: pinned ? "relative" : "absolute", inset: pinned ? undefined : "0 0 0 auto",
            zIndex: 43, boxShadow: pinned ? "none" : "-14px 0 36px rgba(15,23,42,0.14)",
          }}>
          <PlanPanelHeader tr={tr} range={range} countLabel={countLabel}
            onPrevWeek={goPrevWeek} onNextWeek={goNextWeek} onToday={goToday}
            padding="14px 50px 10px 14px" />
          <PlanPanelBody days={days} highlightId={highlight?.id} tr={tr} />
          <PlanPanelFooter tr={tr} />
        </aside>
      )}

      {!docked && overlayOpen && (
        <div data-testid="studio-plan-overlay"
          onClick={event => { if (event.target === event.currentTarget) closeOverlay(); }}
          style={{
            position: "fixed", inset: 0, zIndex: 340, background: "rgba(15,23,42,0.46)",
            display: "flex", justifyContent: "flex-end",
          }}>
          <section
            ref={overlayPanelRef} tabIndex={-1}
            role="dialog" aria-modal="true" aria-label={tr("studioBoard.plan.title")}
            data-testid={bucket === "mobile" ? "studio-plan-sheet" : "studio-plan-drawer"}
            data-plan-form={bucket}
            style={bucket === "mobile"
              ? {
                  width: "100%", height: "100%", minHeight: 0, display: "flex", flexDirection: "column",
                  background: BUI.surface, outline: "none",
                }
              : {
                  width: PANEL_WIDTH, maxWidth: "92vw", height: "100%", minHeight: 0,
                  display: "flex", flexDirection: "column",
                  background: BUI.surface, borderLeft: `1px solid ${BUI.border}`, outline: "none",
                  boxShadow: "-14px 0 36px rgba(15,23,42,0.24)",
                }}>
            <PlanPanelHeader tr={tr} range={range} countLabel={countLabel}
              onPrevWeek={goPrevWeek} onNextWeek={goNextWeek} onToday={goToday}
              onClose={closeOverlay} padding="14px 12px 10px 14px" />
            <PlanPanelBody days={days} highlightId={highlight?.id} tr={tr} />
            <PlanPanelFooter tr={tr} />
          </section>
        </div>
      )}
    </>
  );
}

/** Title + week navigation + the "n scheduled this week" line.
 *  Shared by all three forms so they can never drift apart. The only differences are
 *  the header padding (the docked panel leaves room for its floating trigger) and the
 *  close control, which exists only in the overlay forms. */
function PlanPanelHeader({ tr, range, countLabel, onPrevWeek, onNextWeek, onToday, onClose, padding }: {
  tr: (key: MessageKey) => string;
  range: string;
  countLabel: string;
  onPrevWeek: () => void;
  onNextWeek: () => void;
  onToday: () => void;
  onClose?: () => void;
  padding: string;
}) {
  return (
    <header style={{ padding, borderBottom: `1px solid ${BUI.border}`, flexShrink: 0 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
          <CalendarDays style={{ width: 16, height: 16, color: BUI.purple }} />
          <strong style={{ fontSize: 14, color: BUI.text }}>{tr("studioBoard.plan.title")}</strong>
        </div>
        {onClose && (
          <button type="button" data-testid="studio-plan-close"
            aria-label={tr("studioBoard.plan.close")} onClick={onClose}
            style={{ border: "none", background: "transparent", color: BUI.textSec, cursor: "pointer", padding: 4, display: "inline-flex" }}>
            <X style={{ width: 17, height: 17 }} />
          </button>
        )}
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6, marginTop: 12 }}>
        <button type="button" aria-label={tr("studioBoard.plan.previousWeek")} onClick={onPrevWeek} style={navButton}><ChevronLeft style={{ width: 14, height: 14 }} /></button>
        <span style={{ fontSize: 11.5, fontWeight: 750, color: BUI.text }}>{range}</span>
        <button type="button" aria-label={tr("studioBoard.plan.nextWeek")} onClick={onNextWeek} style={navButton}><ChevronRight style={{ width: 14, height: 14 }} /></button>
        <button type="button" onClick={onToday}
          style={{ ...navButton, width: "auto", padding: "5px 9px", fontSize: 10.5, fontWeight: 700 }}>{tr("studioBoard.plan.today")}</button>
      </div>
      <div data-testid="studio-plan-count" style={{ marginTop: 8, fontSize: 10.5, fontWeight: 700, color: BUI.textSec }}>{countLabel}</div>
    </header>
  );
}

/** The seven-day strip. Identical in all three forms — "same content" is the point. */
function PlanPanelBody({ days, highlightId, tr }: {
  days: PlanSidebarDay[];
  highlightId?: string;
  tr: (key: MessageKey) => string;
}) {
  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 10 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(0, 1fr))", gap: 5, minHeight: "100%" }}>
        {days.map(day => (
          <div key={day.key} style={{ minWidth: 0, borderRadius: 8, background: day.isToday ? "rgba(124,58,237,0.055)" : BUI.bg, border: `1px solid ${day.isToday ? "rgba(124,58,237,0.20)" : BUI.border}` }}>
            <div style={{ padding: "7px 2px", textAlign: "center", borderBottom: `1px solid ${BUI.border}` }}>
              <div style={{ fontSize: 8.5, color: BUI.textSec, textTransform: "uppercase" }}>{day.date.toLocaleDateString(undefined, { weekday: "short" }).slice(0, 2)}</div>
              <div style={{ marginTop: 2, fontSize: 10.5, fontWeight: day.isToday ? 800 : 650, color: day.isToday ? BUI.purple : BUI.text }}>{day.date.getDate()}</div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 5, padding: 4 }}>
              {day.items.map(item => (
                <PlanItem key={item.id} item={item} highlighted={item.id === highlightId} tr={tr} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function PlanPanelFooter({ tr }: { tr: (key: MessageKey) => string }) {
  return (
    <footer style={{ padding: 10, borderTop: `1px solid ${BUI.border}`, display: "flex", gap: 8 }}>
      <Link href="/app/studio?view=plan" style={{ flex: 1, textAlign: "center", padding: "8px 10px", borderRadius: 8, border: `1px solid ${BUI.border}`, color: BUI.text, textDecoration: "none", fontSize: 11.5, fontWeight: 700 }}>{tr("studioBoard.plan.openFullPlanner")}</Link>
    </footer>
  );
}

function PlanItem({ item, highlighted, tr }: {
  item: PlanSidebarItem;
  highlighted: boolean;
  tr: (key: MessageKey) => string;
}) {
  const title = item.title || tr("studioBoard.plan.untitled");
  const label = tr("studioBoard.plan.itemLabel").replace("{time}", item.time).replace("{title}", title);
  const stateLabel = item.state === "posted"
    ? tr("studioBoard.plan.statusPosted")
    : item.state === "failed"
      ? tr("studioBoard.plan.statusFailed")
      : tr("studioBoard.plan.statusScheduled");
  // Posted history stays legible but recedes, so a week of completed work never
  // competes visually with the two Pins that still have to go out.
  const muted = item.state === "posted";

  return (
    <Link href={planDeepLink(item.id)} data-testid={`studio-plan-item-${item.id}`}
      data-state={item.state} data-highlighted={highlighted ? "true" : "false"}
      aria-label={label} title={`${label} — ${stateLabel}`}
      style={{
        display: "block", textDecoration: "none", color: "inherit",
        opacity: muted ? 0.62 : 1,
        borderRadius: 6, padding: 1,
        boxShadow: highlighted ? "0 0 0 2px rgba(124,58,237,0.85), 0 0 10px 2px rgba(124,58,237,0.45)" : "none",
        transition: "box-shadow 260ms ease, opacity 160ms ease",
      }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 2, marginBottom: 2 }}>
        <span style={{ fontSize: 7.5, fontWeight: 750, color: STATE_COLOR[item.state] }}>{item.time}</span>
        {item.state === "posted" && <Check aria-hidden style={{ width: 7, height: 7, color: "#16A34A", flexShrink: 0 }} />}
        {item.state === "failed" && <TriangleAlert aria-hidden style={{ width: 7, height: 7, color: "#D97706", flexShrink: 0 }} />}
      </div>
      <div style={{
        position: "relative", width: "100%", aspectRatio: "2/3", borderRadius: 5, overflow: "hidden",
        background: BUI.surface,
        border: `1px solid ${item.state === "failed" ? "rgba(217,119,6,0.45)" : BUI.border}`,
        filter: muted ? "grayscale(0.35)" : "none",
      }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {item.cover ? <img src={toProxyUrl(item.cover)} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : null}
        {item.providers.length > 0 && (
          <span style={{
            position: "absolute", left: 1, bottom: 1, display: "flex", gap: 1,
            padding: "1px 2px", borderRadius: 4, background: "rgba(255,255,255,0.9)",
          }}>
            {item.providers.map(provider => <ProviderIcon key={provider} provider={provider} title={provider} />)}
          </span>
        )}
      </div>
    </Link>
  );
}

const navButton: React.CSSProperties = {
  width: 28, height: 28, padding: 0, borderRadius: 7, border: `1px solid ${BUI.border}`,
  background: BUI.surface, color: BUI.textSec, display: "inline-flex", alignItems: "center", justifyContent: "center", cursor: "pointer",
};
