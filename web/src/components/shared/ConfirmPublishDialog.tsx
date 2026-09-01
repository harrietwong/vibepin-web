"use client";

import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import { platformName } from "@/lib/social/platforms";
import { confirmPublishSnapshot, type ConfirmedPublishReceipt, type PublishConfirmationSnapshot } from "@/lib/studio/publishConfirmation";

type UI = { card: string; border: string; text: string; textSec: string };
const DEFAULT_UI: UI = { card: "var(--app-surface, #0b1220)", border: "var(--app-border, rgba(148,163,184,.25))", text: "var(--app-text, #E2E8F0)", textSec: "var(--app-text-sec, #94A3B8)" };

export interface ConfirmPublishDialogProps {
  open: boolean;
  snapshot: PublishConfirmationSnapshot | null;
  onConfirm: (receipt: ConfirmedPublishReceipt) => void;
  onCancel: () => void;
  busy?: boolean;
  ui?: Partial<UI>;
}

export function ConfirmPublishDialog({ open, snapshot, onConfirm, onCancel, busy = false, ui }: ConfirmPublishDialogProps) {
  const { t } = useLocale();
  const titleRef = useRef<HTMLHeadingElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!open) return;
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    titleRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onCancel(); return; }
      if (event.key !== "Tab") return;
      const items = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]),[href],[tabindex]:not([tabindex="-1"])') ?? []);
      if (!items.length) return;
      const first = items[0]; const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => { document.removeEventListener("keydown", onKeyDown); restoreFocusRef.current?.focus(); };
  }, [open, onCancel]);
  if (!open || !snapshot) return null;

  const c = { ...DEFAULT_UI, ...ui };
  const disabled = busy || !snapshot.publishableDestinations.length;
  const mode = snapshot.mode.kind === "now" ? t("publishConfirm.modeNow") : t("publishConfirm.modeSchedule").replace("{time}", snapshot.mode.scheduledAt).replace("{timezone}", snapshot.mode.timezone);
  const confirmLabel = t(snapshot.mode.kind === "now" ? "publishConfirm.confirmNow" : "publishConfirm.confirmSchedule").replace("{n}", String(snapshot.publishableDestinations.length));

  return <div data-testid="confirm-publish-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onCancel(); }}
    style={{ position: "fixed", inset: 0, zIndex: 300, background: "rgba(0,0,0,.64)", display: "grid", placeItems: "center", padding: 16, overflowX: "hidden" }}>
    <div ref={dialogRef} data-testid="confirm-publish-dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-publish-title" aria-describedby="confirm-publish-summary"
      style={{ width: "min(560px, 100%)", maxHeight: "min(760px, calc(100dvh - 32px))", overflowY: "auto", overflowX: "hidden", boxSizing: "border-box", background: c.card, border: `1px solid ${c.border}`, borderRadius: 14, padding: "clamp(14px, 4vw, 20px)", boxShadow: "0 24px 70px rgba(0,0,0,.5)" }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
        <h2 ref={titleRef} tabIndex={-1} id="confirm-publish-title" style={{ flex: 1, minWidth: 0, margin: 0, fontSize: 16, color: c.text }}>{t("publishConfirm.title")}</h2>
        <button type="button" data-testid="confirm-publish-close" aria-label={t("publishConfirm.close")} onClick={onCancel}
          style={{ border: 0, padding: 4, background: "transparent", color: c.textSec, cursor: "pointer", flex: "0 0 auto" }}><X size={18} /></button>
      </div>
      <div id="confirm-publish-summary" style={{ marginTop: 14, display: "grid", gap: 12, minWidth: 0 }}>
        <div style={{ display: "flex", gap: 12, alignItems: "center", minWidth: 0 }}>
          {snapshot.media[0]?.url ? <img src={snapshot.media[0].url} alt="" style={{ width: 64, height: 64, objectFit: "cover", borderRadius: 9, flex: "0 0 auto" }} /> : null}
          <div style={{ minWidth: 0 }}><div style={{ color: c.text, fontWeight: 800, overflowWrap: "anywhere" }}>{snapshot.title}</div><div style={{ marginTop: 4, color: c.textSec, fontSize: 12 }}>{t("publishConfirm.mediaCount").replace("{n}", String(snapshot.media.length))}</div></div>
        </div>
        {snapshot.description && <div data-testid="confirm-publish-caption" style={{ color: c.textSec, fontSize: 12, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}><strong style={{ color: c.text }}>{t("publishConfirm.caption")}</strong> {snapshot.description}</div>}
        <div data-testid="confirm-publish-mode" style={{ color: c.textSec, fontSize: 12 }}><strong style={{ color: c.text }}>{t("publishConfirm.modeLabel")}</strong> {mode}</div>
        <div><div style={{ marginBottom: 6, color: c.text, fontWeight: 800, fontSize: 12 }}>{t("publishConfirm.destinations")}</div><div style={{ display: "grid", gap: 7 }}>
          {snapshot.destinations.map(destination => <div key={destination.id} data-testid="confirm-publish-destination"
            style={{ minWidth: 0, padding: 9, border: `1px solid ${c.border}`, borderRadius: 9, color: c.textSec, fontSize: 12, overflowWrap: "anywhere" }}>
            <strong style={{ color: c.text }}>{platformName(destination.provider)}</strong>{` · ${destination.accountLabel || destination.socialConnectionId}`}{destination.provider === "pinterest" ? ` · ${destination.boardName || destination.boardId || t("publishConfirm.missingBoard")}` : ""}
          </div>)}
          {!snapshot.destinations.length && <div data-testid="confirm-publish-no-destination" style={{ color: "#FCA5A5", fontSize: 12 }}>{t("publishConfirm.noDestinations")}</div>}
        </div></div>
        {!!snapshot.blockers.length && <div role="alert" aria-live="assertive" style={{ color: "#FCA5A5", fontSize: 12, display: "grid", gap: 4 }}>
          {snapshot.blockers.map((item, index) => <div key={`${item.code}:${item.destinationId ?? index}`}>{item.message}</div>)}<div>{t("publishConfirm.editDestinations")}</div>
        </div>}
      </div>
      <div aria-live="polite" style={{ marginTop: 16, display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
        <button type="button" data-testid="confirm-publish-cancel" onClick={onCancel} style={{ padding: "9px 14px", borderRadius: 8, border: `1px solid ${c.border}`, background: "transparent", color: c.text, cursor: "pointer" }}>{t("publishConfirm.cancel")}</button>
        <button type="button" data-testid="confirm-publish-confirm" onClick={() => onConfirm(confirmPublishSnapshot(snapshot))} disabled={disabled} aria-disabled={disabled}
          style={{ padding: "9px 14px", borderRadius: 8, border: 0, background: "#7C3AED", color: "#fff", fontWeight: 800, cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? .5 : 1 }}>{confirmLabel}</button>
      </div>
    </div>
  </div>;
}
