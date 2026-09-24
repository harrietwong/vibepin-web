"use client";

/**
 * PinConfirmList — the per-Pin confirmation list (Fable ruling 4; T4).
 *
 * Shown before bulk schedule / bulk publish (removable rows) and inside the single-Pin
 * publish dialog (a list of one). Each row: thumbnail, title, destination link, and
 * where it goes (account / Board). AI copy the user never edited gets a hint badge —
 * never a blocker. The host disables its confirm button until `onReachedEnd` fired
 * (the user scrolled through) and at least one Pin is left.
 *
 * Presentation only: removal state lives in the host so the SAME set drives what is
 * shown and what is submitted (lib/studio/pinConfirmList.remainingIds).
 */

import { useCallback, useEffect, useRef } from "react";
import { Sparkles, X, Undo2 } from "lucide-react";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import { hasReachedListEnd, type ConfirmListItem } from "@/lib/studio/pinConfirmList";

type UI = { text: string; textSec: string; border: string; rowBg: string; badgeBg: string; badgeText: string };
const DEFAULT_UI: UI = {
  text: "var(--app-text, #0F172A)",
  textSec: "var(--app-text-sec, #475569)",
  border: "var(--app-border, #E2E8F0)",
  rowBg: "transparent",
  badgeBg: "rgba(245,158,11,0.14)",
  badgeText: "#b45309",
};

export type PinConfirmListProps = {
  items: ConfirmListItem[];
  /** Ids the user removed. */
  excluded?: ReadonlySet<string>;
  /** Present → rows are removable. Absent (single-Pin dialog) → no remove button. */
  onToggleExclude?: (id: string) => void;
  /** Fired once the end of the list is visible (immediately when it does not overflow). */
  onReachedEnd?: () => void;
  maxHeight?: number;
  ui?: Partial<UI>;
};

export function PinConfirmList({ items, excluded, onToggleExclude, onReachedEnd, maxHeight = 320, ui }: PinConfirmListProps) {
  const { t } = useLocale();
  const c = { ...DEFAULT_UI, ...ui };
  const ref = useRef<HTMLDivElement>(null);
  const reported = useRef(false);

  const check = useCallback(() => {
    const el = ref.current;
    if (!el || reported.current) return;
    if (hasReachedListEnd({ scrollTop: el.scrollTop, clientHeight: el.clientHeight, scrollHeight: el.scrollHeight })) {
      reported.current = true;
      onReachedEnd?.();
    }
  }, [onReachedEnd]);
  useEffect(() => { check(); }, [check, items.length]);

  return (
    <div ref={ref} data-testid="pin-confirm-list" onScroll={check}
      style={{ display: "grid", gap: 6, maxHeight, overflowY: "auto", overflowX: "hidden", minWidth: 0 }}>
      {items.map(item => {
        const removed = !!excluded?.has(item.id);
        return (
          <div key={item.id} data-testid="pin-confirm-row" data-id={item.id} data-excluded={removed ? "true" : "false"}
            style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: 8, border: `1px solid ${c.border}`, borderRadius: 9, background: c.rowBg, opacity: removed ? 0.45 : 1, minWidth: 0 }}>
            {item.thumbnailUrl
              ? <img src={item.thumbnailUrl} alt="" style={{ width: 44, height: 44, objectFit: "cover", borderRadius: 7, flex: "0 0 auto" }} />
              : <div style={{ width: 44, height: 44, borderRadius: 7, border: `1px solid ${c.border}`, flex: "0 0 auto" }} />}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", minWidth: 0 }}>
                <strong style={{ color: c.text, fontSize: 12, fontWeight: 750, overflowWrap: "anywhere", textDecoration: removed ? "line-through" : "none" }}>{item.title}</strong>
                {item.aiUnedited && (
                  <span data-testid="pin-confirm-ai-unedited" title={t("publishConfirm.list.aiUneditedHint")}
                    style={{ display: "inline-flex", alignItems: "center", gap: 3, padding: "1px 6px", borderRadius: 999, background: c.badgeBg, color: c.badgeText, fontSize: 10, fontWeight: 750, whiteSpace: "nowrap" }}>
                    <Sparkles style={{ width: 10, height: 10 }} /> {t("publishConfirm.list.aiUnedited")}
                  </span>
                )}
              </div>
              <div data-testid="pin-confirm-link" style={{ marginTop: 2, color: c.textSec, fontSize: 11, overflowWrap: "anywhere" }}>
                {item.destinationUrl || t("publishConfirm.list.noLink")}
              </div>
              {item.targets.map(target => (
                <div key={target} data-testid="pin-confirm-target" style={{ marginTop: 1, color: c.textSec, fontSize: 11, overflowWrap: "anywhere" }}>{target}</div>
              ))}
            </div>
            {onToggleExclude && (
              <button type="button" data-testid="pin-confirm-remove" onClick={() => onToggleExclude(item.id)}
                aria-label={removed ? t("publishConfirm.list.undo") : t("publishConfirm.list.remove")}
                style={{ flex: "0 0 auto", display: "inline-flex", alignItems: "center", gap: 3, padding: "3px 7px", borderRadius: 7, border: `1px solid ${c.border}`, background: "transparent", color: c.textSec, fontSize: 10.5, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
                {removed ? <Undo2 style={{ width: 11, height: 11 }} /> : <X style={{ width: 11, height: 11 }} />}
                {removed ? t("publishConfirm.list.undo") : t("publishConfirm.list.remove")}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
