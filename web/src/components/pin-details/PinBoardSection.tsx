"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, Loader2, Plus, Search } from "lucide-react";
import type { PinterestBoard } from "@/lib/pinterestClient";
import { useLocale } from "@/lib/i18n/LocaleProvider";

// Mirrors the CSS tokens in DraftDetailsDrawer so the extracted section looks identical.
const UI = {
  surface3: "var(--app-surface-3, #0F1524)",
  fieldBorder: "var(--app-border-hi, rgba(255,255,255,0.18))",
  text: "var(--app-text, #E2E8F0)",
  textMuted: "var(--app-text-muted, #5B6577)",
  purple: "#A78BFA",
  error: "#EF4444",
};

const field: React.CSSProperties = {
  width: "100%", boxSizing: "border-box", padding: "11px 13px", borderRadius: 10,
  border: `1px solid ${UI.fieldBorder}`, fontSize: 13.5, color: UI.text, background: UI.surface3,
  outline: "none", lineHeight: 1.5,
};
const helper: React.CSSProperties = { margin: "6px 0 0", fontSize: 11, color: UI.textMuted, lineHeight: 1.5 };

export type BoardsStatus = "checking" | "preparing" | "loading" | "ready" | "not_connected" | "error";

export type PinBoardSectionProps = {
  /** Real Pinterest boardId. Empty string means no board selected. Never populated from boardSuggestion. */
  boardId: string;
  boards: PinterestBoard[];
  boardsStatus: BoardsStatus;
  boardError: boolean;
  disabled: boolean;
  /** Forwarded to the combobox input so the parent can call focus() on validation. */
  selectRef: React.RefObject<HTMLInputElement | null>;
  onChange: (boardId: string) => void;
  onClearBoardError: () => void;
  /** Retry loading boards (called by "refresh" / "Retry" buttons). */
  onRetryLoad: () => void;
  /** Called when user clicks the board field while Pinterest is not connected. */
  onNeedsConnect: () => void;
  /** Sandbox demo mode — enables the "create a demo board" empty-state affordance. */
  sandboxMode?: boolean;
  /** True while the demo board is being created (disables the button). */
  creatingDemoBoard?: boolean;
  /** Sandbox-only: create a demo board so the selector isn't empty. */
  onCreateDemoBoard?: () => void;
};

/** Searchable board combobox — type to filter; the selected board stays changeable. */
function BoardCombobox({ boardId, boards, disabled, boardError, inputRef, onChange }: {
  boardId: string;
  boards: PinterestBoard[];
  disabled: boolean;
  boardError: boolean;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onChange: (boardId: string) => void;
}) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const wrapRef = useRef<HTMLDivElement>(null);
  const selectedName = boards.find(b => b.id === boardId)?.name ?? "";

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) { if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) { setOpen(false); setQuery(""); } }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const q = query.trim().toLowerCase();
  const filtered = q ? boards.filter(b => b.name.toLowerCase().includes(q)) : boards;
  // When closed, show the selected board name; when open, show the live query.
  const inputValue = open ? query : selectedName;

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <Search size={14} style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", color: UI.textMuted, pointerEvents: "none" }} />
      <input
        ref={inputRef}
        data-testid="draft-board-combobox"
        role="combobox"
        aria-expanded={open}
        disabled={disabled}
        value={inputValue}
        placeholder={t("pinDetails.board.searchPlaceholder")}
        onFocus={() => setOpen(true)}
        onChange={e => { setQuery(e.target.value); setOpen(true); }}
        style={{ ...field, paddingLeft: 34, paddingRight: 34, cursor: "text", ...(boardError ? { borderColor: UI.error } : {}) }}
      />
      <ChevronDown size={16} onClick={() => !disabled && setOpen(o => !o)}
        style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", color: UI.textMuted, cursor: "pointer" }} />
      {open && (
        <div data-testid="draft-board-options" style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, zIndex: 20, maxHeight: 220, overflowY: "auto", background: "var(--app-surface-2, #111827)", border: `1px solid ${UI.fieldBorder}`, borderRadius: 10, boxShadow: "0 12px 32px rgba(0,0,0,0.5)" }}>
          {filtered.length === 0 ? (
            <p style={{ margin: 0, padding: "10px 12px", fontSize: 12, color: UI.textMuted }}>{t("pinDetails.board.noMatchPrefix")}{query}{t("pinDetails.board.noMatchSuffix")}</p>
          ) : filtered.map(b => (
            <button key={b.id} type="button" data-testid="draft-board-option"
              onClick={() => { onChange(b.id); setOpen(false); setQuery(""); }}
              style={{ display: "block", width: "100%", textAlign: "left", padding: "9px 12px", border: "none", background: b.id === boardId ? "rgba(139,92,246,0.14)" : "none", color: UI.text, fontSize: 12.5, fontWeight: b.id === boardId ? 800 : 600, cursor: "pointer" }}>
              {b.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Controlled board selector for PinDetailsModal.
 * Presentational only — no API calls, no store writes.
 * boardSuggestion is never accepted as input and never emitted as boardId.
 */
export function PinBoardSection({
  boardId, boards, boardsStatus, boardError, disabled,
  selectRef, onChange, onClearBoardError, onRetryLoad, onNeedsConnect,
  sandboxMode = false, creatingDemoBoard = false, onCreateDemoBoard,
}: PinBoardSectionProps) {
  const { t } = useLocale();
  if (boardsStatus === "ready") {
    return (
      <>
        <BoardCombobox
          boardId={boardId}
          boards={boards}
          disabled={disabled}
          boardError={boardError}
          inputRef={selectRef}
          onChange={id => { onChange(id); if (id) onClearBoardError(); }}
        />
        {boards.length === 0 && sandboxMode && (
          <div data-testid="draft-sandbox-no-boards" style={{ marginTop: 8 }}>
            <p style={{ ...helper, margin: 0 }}>{t("pinDetails.board.sandboxNoBoards")}</p>
            <button
              type="button"
              data-testid="draft-create-demo-board"
              onClick={onCreateDemoBoard}
              disabled={creatingDemoBoard || !onCreateDemoBoard}
              style={{ display: "inline-flex", alignItems: "center", gap: 6, marginTop: 8, padding: "8px 12px", borderRadius: 9, border: `1px solid ${UI.fieldBorder}`, background: UI.surface3, color: UI.text, fontSize: 12, fontWeight: 700, cursor: creatingDemoBoard ? "default" : "pointer", opacity: creatingDemoBoard ? 0.7 : 1 }}
            >
              {creatingDemoBoard
                ? <><Loader2 size={13} className="animate-spin" /> {t("pinDetails.board.creatingDemo")}</>
                : <><Plus size={13} /> {t("pinDetails.board.createDemo")}</>}
            </button>
          </div>
        )}
        {boards.length === 0 && !sandboxMode && (
          <p data-testid="draft-no-boards-help" style={helper}>
            {t("pinDetails.board.noBoardsHelpPrefix")}
            <button type="button" onClick={onRetryLoad} style={{ background: "none", border: "none", padding: "0 0 0 4px", color: UI.purple, fontWeight: 700, cursor: "pointer", fontSize: 11 }}>{t("pinDetails.board.refresh")}</button>{t("pinDetails.board.noBoardsHelpSuffix")}
          </p>
        )}
        {boardError ? (
          <p data-testid="draft-board-error" style={{ ...helper, color: UI.error, fontWeight: 600 }}>{t("pinDetails.board.chooseBoardToPublish")}</p>
        ) : boards.length > 0 ? (
          <p style={helper}>{t("pinDetails.board.selectBoardToPublish")}</p>
        ) : null}
      </>
    );
  }

  // checking / loading / not_connected / error — show a muted dropdown-shaped placeholder.
  function handleFieldClick() {
    if (boardsStatus === "not_connected") { onNeedsConnect(); return; }
    if (boardsStatus === "error") { onRetryLoad(); return; }
    // checking / loading: still resolving — no-op.
  }

  return (
    <>
      <button
        type="button"
        data-testid="draft-board-field"
        onClick={handleFieldClick}
        disabled={disabled}
        style={{ ...field, display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer", color: UI.textMuted }}
      >
        <span style={{ display: "flex", alignItems: "center", gap: 7 }}>
          {(boardsStatus === "loading" || boardsStatus === "checking" || boardsStatus === "preparing") &&
            <Loader2 size={13} className="animate-spin" style={{ color: UI.textMuted }} />}
          {boardsStatus === "preparing" ? t("pinDetails.board.preparing")
            : boardsStatus === "loading" ? t("pinDetails.board.loading")
            : boardsStatus === "checking" ? t("pinDetails.board.checking")
            : t("pinDetails.board.selectPinterestBoard")}
        </span>
        <ChevronDown size={15} style={{ color: UI.textMuted }} />
      </button>
      <p data-testid="draft-board-helper" style={helper}>
        {boardsStatus === "error" ? (
          <>{t("pinDetails.board.loadFailed")}<button type="button" onClick={onRetryLoad} style={{ background: "none", border: "none", padding: 0, color: UI.purple, fontWeight: 700, cursor: "pointer", fontSize: 11 }}>{t("pinDetails.board.retry")}</button></>
        ) : boardsStatus === "preparing" ? (
          t("pinDetails.board.preparingHelper")
        ) : boardsStatus === "checking" ? (
          t("pinDetails.board.checkingHelper")
        ) : boardsStatus === "loading" ? (
          t("pinDetails.board.loadingHelper")
        ) : (
          // not_connected — the only state where Pinterest genuinely isn't connected yet.
          t("pinDetails.board.availableAfterConnect")
        )}
      </p>
    </>
  );
}
