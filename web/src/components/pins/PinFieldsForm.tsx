"use client";

/**
 * PinFieldsForm — shared, presentational CORE Pin field editor (studioBoardV2).
 *
 * Renders the four core fields only: Pin title → Description → Website URL →
 * searchable Pinterest board. Alt text / Tags / Product live in the card's
 * "More details" section (they share the same value object). Controlled: the
 * parent owns state, debounced persistence, and flush.
 */

import { useEffect, useRef, useState } from "react";
import { RefreshCw, Search, ChevronDown } from "lucide-react";
import type { PinterestBoard } from "@/lib/pinterestClient";
import { BUI, fieldStyle, labelStyle } from "@/components/studio/boardUI";
import { useLocale } from "@/lib/i18n/LocaleProvider";

export type PinFieldsValue = {
  title: string;
  description: string;
  websiteUrl: string;
  boardId: string;
  /** Held here so the card's More-details section shares one value object. */
  altText: string;
  /** Space/comma separated while editing; parent converts to string[] on persist. */
  tags: string;
};

export type PinFieldsFormProps = {
  value: PinFieldsValue;
  boards: PinterestBoard[];
  boardsLoading?: boolean;
  /** No Pinterest connection at all — show the Connect prompt. */
  disconnected?: boolean;
  /** Connected but token expired / scopes revoked — show a Reconnect prompt. */
  needsReconnect?: boolean;
  /** Boards API failed (connection is fine) — show an error/retry, never "Connect". */
  boardsError?: string;
  onRetryBoards?: () => void;
  /** Field-level validation error (e.g. Schedule pressed without a board). */
  boardFieldError?: string;
  disabled?: boolean;
  onChange: (patch: Partial<PinFieldsValue>) => void;
  onRegenerateField?: (field: "title" | "description") => void;
  onConnect?: () => void;
};

function RegenBtn({ title, onClick, disabled }: { title: string; onClick?: () => void; disabled?: boolean }) {
  if (!onClick) return null;
  return (
    <button type="button" title={title} aria-label={title} onClick={onClick} disabled={disabled}
      style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 24, height: 24, borderRadius: 7, border: `1px solid ${BUI.border}`, background: BUI.surface2, color: BUI.textSec, cursor: disabled ? "default" : "pointer", flexShrink: 0, opacity: disabled ? 0.5 : 1 }}>
      <RefreshCw style={{ width: 12, height: 12 }} />
    </button>
  );
}

function FieldLabel({ text, hint, onRegen }: { text: string; hint?: string; onRegen?: () => void }) {
  const { t: tr } = useLocale();
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
      <span style={{ ...labelStyle, margin: 0 }}>{text}{hint && <span style={{ color: BUI.textMuted, fontWeight: 600 }}> · {hint}</span>}</span>
      <RegenBtn title={`${tr("pinForm.regenerateLabelPrefix")}${text.toLowerCase()}`} onClick={onRegen} />
    </div>
  );
}

/** Lightweight searchable board combobox (only mounted for the active card). */
function BoardCombobox({ value, boards, boardsLoading, disabled, onChange }: {
  value: string; boards: PinterestBoard[]; boardsLoading?: boolean; disabled?: boolean;
  onChange: (id: string) => void;
}) {
  const { t: tr } = useLocale();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const wrapRef = useRef<HTMLDivElement>(null);
  const selectedName = boards.find(b => b.id === value)?.name ?? "";

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) { if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) { setOpen(false); setQuery(""); } }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const q = query.trim().toLowerCase();
  const filtered = q ? boards.filter(b => b.name.toLowerCase().includes(q)) : boards;

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <button type="button" data-testid="board-field-board" disabled={disabled || boardsLoading}
        onClick={() => setOpen(o => !o)}
        style={{ ...fieldStyle, display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer", color: selectedName ? BUI.text : BUI.textMuted }}>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {boardsLoading ? tr("pinForm.loadingBoards") : selectedName || tr("pinForm.searchOrSelectBoard")}
        </span>
        <ChevronDown style={{ width: 15, height: 15, color: BUI.textMuted, flexShrink: 0 }} />
      </button>
      {open && (
        <div style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, zIndex: 30, background: BUI.surface, border: `1px solid ${BUI.borderHi}`, borderRadius: 10, boxShadow: "0 12px 32px rgba(15,23,42,0.18)", overflow: "hidden" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 10px", borderBottom: `1px solid ${BUI.border}` }}>
            <Search style={{ width: 13, height: 13, color: BUI.textMuted }} />
            <input autoFocus data-testid="board-field-search" value={query} onChange={e => setQuery(e.target.value)} placeholder={tr("pinForm.searchBoards")}
              style={{ flex: 1, border: "none", outline: "none", background: "none", fontSize: 12.5, color: BUI.text, fontFamily: "inherit" }} />
          </div>
          <div style={{ maxHeight: 200, overflowY: "auto" }}>
            {filtered.length === 0 ? (
              <p style={{ margin: 0, padding: "10px 12px", fontSize: 12, color: BUI.textMuted }}>{tr("pinForm.noBoardsMatch")}</p>
            ) : filtered.map(b => (
              <button key={b.id} type="button" onClick={() => { onChange(b.id); setOpen(false); setQuery(""); }}
                style={{ display: "block", width: "100%", textAlign: "left", padding: "9px 12px", border: "none", background: b.id === value ? "rgba(124,58,237,0.10)" : "none", color: BUI.text, fontSize: 12.5, fontWeight: b.id === value ? 800 : 600, cursor: "pointer", fontFamily: "inherit" }}>
                {b.name}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function PinFieldsForm({
  value, boards, boardsLoading, disconnected, needsReconnect, boardsError, onRetryBoards, boardFieldError, disabled,
  onChange, onRegenerateField, onConnect,
}: PinFieldsFormProps) {
  const { t: tr } = useLocale();
  const regen = (f: "title" | "description") =>
    onRegenerateField ? () => onRegenerateField(f) : undefined;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
      <div>
        <FieldLabel text={tr("pinForm.pinTitle")} onRegen={regen("title")} />
        <input data-testid="board-field-title" value={value.title} disabled={disabled} maxLength={100}
          onChange={e => onChange({ title: e.target.value })} placeholder={tr("pinForm.pinTitlePlaceholder")} style={fieldStyle} />
      </div>

      <div>
        <FieldLabel text={tr("pinForm.description")} onRegen={regen("description")} />
        <textarea data-testid="board-field-description" value={value.description} disabled={disabled} maxLength={500}
          onChange={e => onChange({ description: e.target.value })} placeholder={tr("pinForm.descriptionPlaceholder")}
          rows={3} style={{ ...fieldStyle, resize: "vertical", minHeight: 64 }} />
      </div>

      <div>
        <FieldLabel text={tr("pinForm.websiteUrl")} hint={tr("pinForm.optional")} />
        <input data-testid="board-field-url" value={value.websiteUrl} disabled={disabled}
          onChange={e => onChange({ websiteUrl: e.target.value })} placeholder={tr("pinForm.websiteUrlPlaceholder")} style={fieldStyle} />
      </div>

      <div>
        <span style={labelStyle}>{tr("pinForm.pinterestBoard")}</span>
        {disconnected ? (
          // No connection at all → prompt to connect.
          <div data-testid="board-field-disconnected" style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 11px", borderRadius: 9, border: `1px solid ${BUI.border}`, background: BUI.surface2 }}>
            <span style={{ fontSize: 12, color: BUI.textSec, flex: 1 }}>{tr("pinForm.connectAccountBeforeScheduling")}</span>
            {onConnect && (
              <button type="button" onClick={onConnect}
                style={{ fontSize: 11, fontWeight: 700, color: "#fff", background: BUI.gradient, border: "none", borderRadius: 8, padding: "6px 12px", cursor: "pointer" }}>
                {tr("pinForm.connect")}
              </button>
            )}
          </div>
        ) : needsReconnect ? (
          // Connected but the token needs re-authorization → reconnect (NOT "connect").
          <div data-testid="board-field-reconnect" style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 11px", borderRadius: 9, border: `1px solid ${BUI.border}`, background: BUI.surface2 }}>
            <span style={{ fontSize: 12, color: BUI.textSec, flex: 1 }}>{tr("pinForm.connectionExpired")}</span>
            {onConnect && (
              <button type="button" onClick={onConnect}
                style={{ fontSize: 11, fontWeight: 700, color: "#fff", background: BUI.gradient, border: "none", borderRadius: 8, padding: "6px 12px", cursor: "pointer" }}>
                {tr("pinForm.reconnect")}
              </button>
            )}
          </div>
        ) : boardsError ? (
          // Connection is fine but boards failed to load → show the error + retry.
          <div data-testid="board-field-error" style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 11px", borderRadius: 9, border: `1px solid ${BUI.error}55`, background: `${BUI.error}0d` }}>
            <span style={{ fontSize: 12, color: BUI.error, flex: 1 }}>{boardsError}</span>
            {onRetryBoards && (
              <button type="button" onClick={onRetryBoards}
                style={{ fontSize: 11, fontWeight: 700, color: BUI.text, background: BUI.surface2, border: `1px solid ${BUI.border}`, borderRadius: 8, padding: "6px 12px", cursor: "pointer" }}>
                {tr("pinForm.retry")}
              </button>
            )}
          </div>
        ) : (
          <BoardCombobox value={value.boardId} boards={boards} boardsLoading={boardsLoading} disabled={disabled}
            onChange={id => onChange({ boardId: id })} />
        )}
        {boardFieldError && !disconnected && !needsReconnect && (
          <p data-testid="board-field-validation-error" style={{ margin: "5px 0 0", fontSize: 11, fontWeight: 600, color: BUI.error }}>
            {boardFieldError}
          </p>
        )}
      </div>
    </div>
  );
}
