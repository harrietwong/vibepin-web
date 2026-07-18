"use client";

import {
  useState,
  useRef,
  useEffect,
  useCallback,
  useLayoutEffect,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type { PinDraft } from "@/lib/pinDraftStore";
import { displayTitle, sanitizeHandoffField } from "@/lib/weeklyPlanHandoff";
import { toThumbUrl } from "@/lib/imageProxy";
import { preloadImage } from "@/lib/imagePreload";
import { PinThumbnail } from "@/components/plan/PinThumbnail";

const OPEN_DELAY_MS = 200;
const CLOSE_DELAY_MS = 150;
const CARD_WIDTH = 392;
const VIEWPORT_MARGIN = 10;
const GAP = 10;
const Z_INDEX = 85;

// 鈹€鈹€ Modal-suspend signal 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
// Every PinHoverTarget on the page manages its OWN open/close state locally (there
// is no shared "hoveredPin" state to clear) and renders its card into a portal at
// Z_INDEX 85 鈥?ABOVE the Edit-Pin modal's dialog (z81)/backdrop (z80). Clicking
// "Edit details" *inside* an already-open hover card opens that modal, but the click
// doesn't move the pointer, so no mouseleave ever fires to close the card 鈥?it stays
// open, now stuck floating on top of the modal that just opened.
//
// Rather than thread an "isModalOpen" prop through every intermediate component
// between the Plan page and each PinHoverTarget (WeekCalendar / MonthCalendar /
// AddedNeedsDateSection / UnscheduledDraftsSection / UnscheduledRail all sit in
// between), every PinHoverTarget instance subscribes to this single shared signal.
// The Plan page calls setPinPreviewSuspended(true/false) whenever the Edit-Pin modal
// opens/closes; every hover card force-closes (and refuses to reopen) while suspended.
let previewSuspended = false;
const previewSuspendListeners = new Set<(suspended: boolean) => void>();

/** Call with `true` when a Pin edit modal opens, `false` when it closes. */
export function setPinPreviewSuspended(suspended: boolean): void {
  if (previewSuspended === suspended) return;
  previewSuspended = suspended;
  previewSuspendListeners.forEach(listener => listener(suspended));
}

function usePinPreviewSuspended(): boolean {
  const [suspended, setSuspended] = useState(previewSuspended);
  useEffect(() => {
    previewSuspendListeners.add(setSuspended);
    return () => { previewSuspendListeners.delete(setSuspended); };
  }, []);
  return suspended;
}

export type PinHoverPreviewVariant = "scheduled" | "unscheduled";

export type PinHoverPreviewActions = {
  variant: PinHoverPreviewVariant;
  onEditDetails: (draft: PinDraft) => void;
  onAddToPlan?: (id: string) => void;
  onReschedule?: (draft: PinDraft) => void;
  onViewDetails?: (draft: PinDraft) => void;
  onAssignDate?: (id: string) => void;
  onRemove?: (id: string) => void;
  /** Toggle whether a planned Pin keeps its time during a Smart Schedule rebalance. */
  onToggleLock?: (draft: PinDraft, locked: boolean) => void;
  /** Publish now — distinct from scheduling; respects publish readiness. */
  onPublishNow?: (draft: PinDraft) => void;
};

function formatSlotTime(time?: string): string {
  if (!time) return "";
  const [hRaw, mRaw] = time.split(":");
  const h = Number(hRaw);
  if (Number.isNaN(h)) return time;
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(Number(mRaw ?? 0)).padStart(2, "0")} ${ampm}`;
}

function shortDomain(url: string): string {
  const u = sanitizeHandoffField(url);
  if (!u) return "";
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return u.length > 36 ? `${u.slice(0, 36)}...` : u;
  }
}

function truncate(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}...`;
}

function sourceLabel(draft: PinDraft): string {
  const raw = sanitizeHandoffField(draft.source);
  if (!raw) return "Generated";
  const lower = raw.toLowerCase();
  if (lower === "history") return "History";
  if (lower === "storage") return "Storage";
  if (lower === "product") return "Product";
  if (lower === "generated") return "Generated";
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

/** One plain lifecycle line for the hover preview. */
function lifecycleLine(draft: PinDraft): { text: string; color: string } {
  if (sanitizeHandoffField(draft.postedAt)) return { text: "Published", color: "#C4B5FD" };
  if (sanitizeHandoffField(draft.scheduledDate)) return { text: "Scheduled", color: "#34D399" };
  return { text: "Unscheduled", color: "#CBD5E1" };
}

function formatScheduledHeader(draft: PinDraft): string {
  const date = sanitizeHandoffField(draft.scheduledDate);
  if (!date) return "Needs date";
  const d = new Date(`${date}T00:00:00`);
  const datePart = d.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const time = formatSlotTime(draft.scheduledTime);
  if (!time) return datePart;
  const tzParts = new Date().toLocaleTimeString("en-US", { timeZoneName: "short" }).split(" ");
  const tz = tzParts.length > 1 ? tzParts[tzParts.length - 1] : "";
  return `${datePart} 路 ${time}${tz ? ` ${tz}` : ""}`;
}

function boardLabel(draft: PinDraft): string {
  const name =
    sanitizeHandoffField(draft.boardName) ||
    sanitizeHandoffField(draft.metadataDraft?.boardName);
  if (name) return name;
  if (!sanitizeHandoffField(draft.boardId) && !sanitizeHandoffField(draft.metadataDraft?.boardId)) {
    return "No Pinterest board selected";
  }
  return "No Pinterest board selected";
}

function useFinePointer(): boolean {
  const [fine, setFine] = useState(true);
  useEffect(() => {
    // Use the `any-*` variants, not `(hover: hover) and (pointer: fine)`.
    // The non-`any` queries test only the PRIMARY pointer, so a touch-capable
    // Windows laptop reports `false` even with a mouse/trackpad attached 鈥?
    // which silently disabled hover and forced click-to-open. `any-hover` /
    // `any-pointer` are true when ANY attached device can hover with a fine
    // pointer, which is exactly when we want the hover preview.
    const mq = window.matchMedia("(any-hover: hover) and (any-pointer: fine)");
    const update = () => setFine(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return fine;
}

function PinHoverPreviewCard({
  draft,
  actions,
  onMouseEnter,
  onMouseLeave,
  onFocus,
  cardRef,
}: {
  draft: PinDraft;
  actions: PinHoverPreviewActions;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onFocus: () => void;
  cardRef: React.RefObject<HTMLDivElement | null>;
}) {
  const { variant } = actions;
  const title = displayTitle(draft.title, draft.keyword) || "Untitled Pin";
  const description = sanitizeHandoffField(draft.description) || "No description yet";
  const altText = sanitizeHandoffField(draft.altText);
  const url = sanitizeHandoffField(draft.destinationUrl);
  const domain = url ? shortDomain(url) : "";
  const hasBoard = !!(sanitizeHandoffField(draft.boardId) || sanitizeHandoffField(draft.metadataDraft?.boardId));
  const lifecycle = lifecycleLine(draft);

  const scheduled = variant === "scheduled" && !!sanitizeHandoffField(draft.scheduledDate);

  return (
    <div
      ref={cardRef}
      role="dialog"
      aria-label={`Pin preview: ${title}`}
      data-testid="pin-hover-preview"
      data-testid2="weekly-plan-pin-hover-card"
      tabIndex={-1}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onFocus={onFocus}
      style={{
        width: CARD_WIDTH,
        maxWidth: "min(92vw, 420px)",
        background: "linear-gradient(180deg, #0f172a 0%, #111827 100%)",
        border: "1px solid rgba(148,163,184,0.22)",
        borderRadius: 14,
        boxShadow: "0 20px 60px rgba(0,0,0,0.55), 0 0 0 1px rgba(124,58,237,0.08)",
        overflow: "hidden",
        pointerEvents: "auto",
      }}
    >
      <div style={{ display: "flex", gap: 12, padding: 14 }}>
        <div
          style={{
            position: "relative",
            flexShrink: 0,
            width: 132,
            height: 176,
            borderRadius: 10,
            overflow: "hidden",
            background: "#020617",
            border: "1px solid rgba(148,163,184,0.15)",
          }}
        >
          <PinThumbnail src={toThumbUrl(draft.imageUrl)} alt={altText || title} loading="eager" dark />
        </div>

        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 6 }}>
          {scheduled ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10.5, fontWeight: 600, color: "#A78BFA" }}>
                <span aria-hidden="true">馃搮</span>
                <span style={{ lineHeight: 1.35, flex: 1 }}>{formatScheduledHeader(draft)}</span>
                {actions.onToggleLock && (
                  <button
                    type="button"
                    data-testid="hover-lock-toggle"
                    title="Keep this time when rebalancing"
                    aria-pressed={!!draft.scheduleLocked}
                    onMouseDown={e => e.stopPropagation()}
                    onClick={e => { e.stopPropagation(); actions.onToggleLock?.(draft, !draft.scheduleLocked); }}
                    style={{
                      background: "none", border: "none", cursor: "pointer", padding: 0, lineHeight: 1,
                      fontSize: 12, color: draft.scheduleLocked ? "#A78BFA" : "#64748B",
                    }}
                  >
                    {draft.scheduleLocked ? "馃敀" : "馃敁"}
                  </button>
                )}
              </div>
              {draft.autoScheduled && (
                <span style={{ fontSize: 9.5, fontWeight: 700, color: "#6366F1", letterSpacing: "0.02em" }}>
                  Auto scheduled
                </span>
              )}
            </div>
          ) : (
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10.5, fontWeight: 600, color: "var(--app-text-muted)" }}>
              <span>{sourceLabel(draft)}</span>
            </div>
          )}

          <p
            style={{
              margin: 0,
              fontSize: 13.5,
              fontWeight: 800,
              color: "#F8FAFC",
              overflow: "hidden",
              textOverflow: "ellipsis",
              display: "-webkit-box",
              WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical",
              lineHeight: 1.3,
            }}
          >
            {title}
          </p>

          <p
            style={{
              margin: 0,
              fontSize: 11,
              color: "#94A3B8",
              lineHeight: 1.45,
              overflow: "hidden",
              textOverflow: "ellipsis",
              display: "-webkit-box",
              WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical",
            }}
          >
            {truncate(description, 140)}
          </p>

          {url && (
            <p
              style={{
                margin: 0,
                fontSize: 10.5,
                color: "#60A5FA",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              title={url}
            >
              馃敆 {domain}
            </p>
          )}

          {hasBoard && (
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10.5, color: "#CBD5E1" }}>
              <span aria-hidden="true">馃搶</span>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {boardLabel(draft)}
              </span>
            </div>
          )}

          <p
            data-testid="pin-hover-readiness"
            style={{
              margin: "2px 0 0",
              fontSize: 10.5,
              fontWeight: 600,
              color: lifecycle.color,
              overflow: "hidden",
              textOverflow: "ellipsis",
              display: "-webkit-box",
              WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical",
              lineHeight: 1.35,
            }}
          >
            {lifecycle.text}
          </p>
        </div>
      </div>

      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 7,
          padding: "0 14px 14px",
          borderTop: "1px solid rgba(148,163,184,0.12)",
          paddingTop: 12,
        }}
      >
        {variant === "unscheduled" ? (
          <>
            <button
              type="button"
              data-testid="hover-add-to-plan"
              data-testid2="weekly-plan-hover-schedule"
              onClick={() => actions.onAddToPlan?.(draft.id)}
              style={{
                flex: "1 1 auto",
                padding: "7px 12px",
                borderRadius: 9,
                border: "none",
                background: "linear-gradient(135deg,#FF4D8D,#7C3AED)",
                color: "#fff",
                fontSize: 11,
                fontWeight: 700,
                cursor: "pointer",
              }}
            >
              Schedule
            </button>
            <button
              type="button"
              data-testid="hover-edit-details"
              data-testid2="weekly-plan-hover-edit-details"
              onClick={() => actions.onEditDetails(draft)}
              style={{
                flex: "1 1 auto",
                padding: "7px 12px",
                borderRadius: 9,
                border: "1px solid rgba(148,163,184,0.25)",
                background: "rgba(15,23,42,0.6)",
                color: "#E2E8F0",
                fontSize: 11,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Edit details
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              data-testid="hover-edit-details"
              data-testid2="weekly-plan-hover-edit-details"
              onClick={() => actions.onEditDetails(draft)}
              style={{
                flex: "1 1 auto",
                padding: "7px 12px",
                borderRadius: 9,
                border: "none",
                background: "linear-gradient(135deg,#FF4D8D,#7C3AED)",
                color: "#fff",
                fontSize: 11,
                fontWeight: 700,
                cursor: "pointer",
              }}
            >
              Edit details
            </button>
            {actions.onReschedule && (
              <button
                type="button"
                data-testid="hover-reschedule"
                data-testid2="weekly-plan-hover-reschedule"
                onClick={() => actions.onReschedule?.(draft)}
                style={{
                  flex: "1 1 auto",
                  padding: "7px 12px",
                  borderRadius: 9,
                  border: "1px solid rgba(148,163,184,0.25)",
                  background: "rgba(15,23,42,0.6)",
                  color: "#E2E8F0",
                  fontSize: 11,
                  fontWeight: 600,
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                }}
              >
                Reschedule
              </button>
            )}
            {actions.onPublishNow && (
              <button
                type="button"
                data-testid="hover-publish-now"
                data-testid2="weekly-plan-hover-publish-now"
                onClick={() => actions.onPublishNow?.(draft)}
                style={{
                  flex: "1 1 auto",
                  padding: "7px 12px",
                  borderRadius: 9,
                  border: "1px solid rgba(52,211,153,0.45)",
                  background: "rgba(16,185,129,0.16)",
                  color: "#34D399",
                  fontSize: 11,
                  fontWeight: 700,
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                }}
              >
                Publish now
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export type PinHoverTargetProps = {
  draft: PinDraft;
  actions: PinHoverPreviewActions;
  disabled?: boolean;
  children: ReactNode;
} & Omit<HTMLAttributes<HTMLDivElement>, "children">;

export function PinHoverTarget({
  draft,
  actions,
  disabled = false,
  children,
  style,
  onClick,
  onKeyDown,
  ...rest
}: PinHoverTargetProps) {
  const finePointer = useFinePointer();
  const previewSuspended = usePinPreviewSuspended();
  const triggerRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const hoveringCard = useRef(false);
  const hoveringTrigger = useRef(false);
  // Last real pointer type that touched this trigger ("mouse" | "pen" | "touch").
  // Drives open/click behavior off ACTUAL events, not a media query.
  const pointerTypeRef = useRef<string>("mouse");

  useEffect(() => setMounted(true), []);

  const clearTimers = useCallback(() => {
    if (openTimer.current) clearTimeout(openTimer.current);
    if (closeTimer.current) clearTimeout(closeTimer.current);
    openTimer.current = null;
    closeTimer.current = null;
  }, []);

  // A Pin edit modal just opened (very likely via THIS card's own "Edit details" /
  // "Reschedule" / "Publish now" button 鈥?a click that never moves the pointer, so no
  // mouseleave would otherwise fire): force-close immediately rather than leaving a
  // stale preview floating above the modal.
  useEffect(() => {
    if (!previewSuspended) return;
    clearTimers();
    hoveringTrigger.current = false;
    hoveringCard.current = false;
    // Synchronizing local open state to the external modal-open signal 鈥?the
    // deliberate, established pattern used elsewhere in this codebase for exactly
    // this kind of external-state reconciliation.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOpen(false);
  }, [previewSuspended, clearTimers]);

  const scheduleOpen = useCallback(() => {
    if (disabled || previewSuspended) return;
    clearTimers();
    openTimer.current = setTimeout(() => setOpen(true), OPEN_DELAY_MS);
  }, [clearTimers, disabled, previewSuspended]);

  const scheduleClose = useCallback(() => {
    clearTimers();
    closeTimer.current = setTimeout(() => {
      if (!hoveringTrigger.current && !hoveringCard.current) setOpen(false);
    }, CLOSE_DELAY_MS);
  }, [clearTimers]);

  const updatePosition = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const cardH = cardRef.current?.offsetHeight ?? 260;
    const cardW = cardRef.current?.offsetWidth ?? CARD_WIDTH;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let left = rect.right + GAP;
    let top = rect.top;

    if (left + cardW > vw - VIEWPORT_MARGIN) {
      left = rect.left - cardW - GAP;
    }
    if (left < VIEWPORT_MARGIN) {
      left = Math.max(VIEWPORT_MARGIN, Math.min(rect.left, vw - cardW - VIEWPORT_MARGIN));
    }

    if (top + cardH > vh - VIEWPORT_MARGIN) {
      top = rect.bottom - cardH;
    }
    if (top < VIEWPORT_MARGIN) {
      top = VIEWPORT_MARGIN;
    }

    setPos({ top, left });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    const onScrollOrResize = () => updatePosition();
    updatePosition();
    const raf = requestAnimationFrame(updatePosition);
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
    };
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  // Close when clicking/tapping outside the trigger or the preview card. Harmless for
  // mouse (which also closes on leave); essential for touch-opened previews.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t) || cardRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  useEffect(() => () => clearTimers(), [clearTimers]);

  // Open on a REAL mouse/pen hover. We deliberately do NOT gate this on a media query:
  // touch-capable laptops / hybrids / remote desktops / dev-tools emulation report
  // (pointer/hover) capabilities inconsistently, which previously hard-disabled hover
  // (preview only opened on click). A genuine hover event is sufficient. Touch is
  // excluded so a tap doesn't pop the preview (touch users tap to open details).
  // Warm the cache for the large preview image the instant the pointer enters the tile,
  // so by the time the card opens (~200ms later) the image is decoded 鈥?no white flash.
  const warmPreview = useCallback(() => {
    if (disabled) return;
    preloadImage(toThumbUrl(draft.imageUrl));
  }, [disabled, draft.imageUrl]);

  const handlePointerEnter = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType) pointerTypeRef.current = e.pointerType;
    if (disabled || e.pointerType === "touch") return;
    hoveringTrigger.current = true;
    warmPreview();
    scheduleOpen();
  };

  // Fallback for environments that don't deliver typed pointer events to React.
  const handleMouseEnter = () => {
    if (disabled || pointerTypeRef.current === "touch") return;
    hoveringTrigger.current = true;
    warmPreview();
    scheduleOpen();
  };

  const handleTriggerLeave = () => {
    hoveringTrigger.current = false;
    scheduleClose();
  };

  const handleCardEnter = () => {
    hoveringCard.current = true;
    clearTimers();
  };

  const handleCardLeave = () => {
    hoveringCard.current = false;
    scheduleClose();
  };

  const handleTriggerClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (disabled) {
      onClick?.(e);
      return;
    }
    // Touch: tap toggles the preview (no hover available). Mouse/pen: click runs the
    // normal tile action (open details). Based on the real pointer type, not a media query.
    if (pointerTypeRef.current === "touch") {
      e.stopPropagation();
      if (previewSuspended) return;
      warmPreview();
      setOpen(o => !o);
      return;
    }
    onClick?.(e);
  };

  const handleFocus = () => {
    if (disabled || previewSuspended) return;
    setOpen(true);
  };

  const handleBlur = (e: React.FocusEvent<HTMLDivElement>) => {
    const next = e.relatedTarget as Node | null;
    if (next && (triggerRef.current?.contains(next) || cardRef.current?.contains(next))) return;
    scheduleClose();
  };

  return (
    <>
      <div
        ref={triggerRef}
        tabIndex={disabled ? -1 : 0}
        aria-describedby={open ? "pin-hover-preview" : undefined}
        style={style}
        onPointerEnter={handlePointerEnter}
        onPointerDown={e => { if (e.pointerType) pointerTypeRef.current = e.pointerType; }}
        onPointerLeave={handleTriggerLeave}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleTriggerLeave}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onClick={handleTriggerClick}
        {...(process.env.NODE_ENV !== "production"
          ? { "data-fine-pointer": String(finePointer), "data-pointer-type": pointerTypeRef.current, "data-preview-open": String(open) }
          : {})}
        onKeyDown={e => {
          if (e.key === "Enter" || e.key === " ") {
            if (!disabled && !finePointer) {
              e.preventDefault();
              setOpen(true);
            }
          }
          onKeyDown?.(e);
        }}
        {...rest}
      >
        {children}
      </div>

      {mounted && open && !disabled && !previewSuspended &&
        createPortal(
          <div
            style={{
              position: "fixed",
              top: pos.top,
              left: pos.left,
              zIndex: Z_INDEX,
              pointerEvents: "none",
            }}
          >
            <PinHoverPreviewCard
              draft={draft}
              actions={actions}
              cardRef={cardRef}
              onMouseEnter={handleCardEnter}
              onMouseLeave={handleCardLeave}
              onFocus={handleCardEnter}
            />
          </div>,
          document.body,
        )}
    </>
  );
}
