"use client";

/**
 * Pinterest advanced settings — rendered below the connection card when an
 * account is connected (or in Limited Access). Sections:
 *   1. Board defaults  (default board + rotation, reusing smartScheduleStore)
 *   2. Publishing access guidance
 *   3. Website & domain setup (optional external guidance)
 *   4. Pinterest catalog (optional secondary external link)
 *   5. Multi-account (honest "not available yet" note)
 *
 * All board data uses real Pinterest boardId values from fetchPinterestBoards.
 * Board rotation shares the same store as Smart Schedule — no duplicate config.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import NextLink from "next/link";
import { AlertTriangle, Check, ChevronDown, ChevronRight, ExternalLink, Globe, Layers, Loader2, RefreshCw, ShoppingBag, X as XIcon } from "lucide-react";
import { toast } from "sonner";
import { fetchPinterestBoards, type PinterestBoard } from "@/lib/pinterestClient";
import { formatSyncedAt } from "@/lib/pinterest/pinterestSettingsState";
import {
  getSmartScheduleConfig,
  saveSmartScheduleConfig,
  type SmartScheduleConfig,
} from "@/lib/smartScheduleStore";

const UI = {
  surface: "var(--app-surface, #161D2E)",
  surface2: "var(--app-surface-2, #1A2235)",
  surface3: "#0F1524",
  border: "var(--app-border, rgba(255,255,255,0.10))",
  text: "var(--app-text, #E2E8F0)",
  textSec: "var(--app-text-sec, #8892A4)",
  textMuted: "#5B6577",
  success: "#10B981",
  warning: "#F59E0B",
  blue: "#93C5FD",
  blueBg: "rgba(59,130,246,0.14)",
  blueBorder: "rgba(59,130,246,0.32)",
  gradient: "linear-gradient(135deg,#FF4D8D 0%,#D946EF 52%,#7C3AED 100%)",
};

// Real Pinterest external destinations (open in a new tab).
const PINTEREST_CLAIM_SETTINGS = "https://www.pinterest.com/settings/claimed-accounts/";
const PINTEREST_CLAIM_HELP = "https://help.pinterest.com/en/business/article/claim-your-website";
const PINTEREST_CATALOG_SETUP = "https://www.pinterest.com/business/catalogs/";
const PINTEREST_ACCESS_HELP = "https://developers.pinterest.com/docs/getting-started/set-up-app/";

type BoardsState = "loading" | "loaded" | "empty" | "error";

function Card({ title, icon: Icon, children, accent }: { title: string; icon: React.ComponentType<{ size?: number; style?: React.CSSProperties }>; children: React.ReactNode; accent?: string }) {
  return (
    <section style={{ background: UI.surface, border: `1px solid ${accent ?? UI.border}`, borderRadius: 16, padding: "18px 18px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 4 }}>
        <Icon size={16} style={{ color: UI.textSec }} />
        <h3 style={{ margin: 0, fontSize: 14.5, fontWeight: 800, color: UI.text }}>{title}</h3>
      </div>
      {children}
    </section>
  );
}

function secondaryLink(href: string, label: string) {
  return (
    <NextLink href={href} target="_blank" rel="noopener noreferrer"
      style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 13px", borderRadius: 9, border: `1px solid ${UI.blueBorder}`, background: UI.blueBg, color: UI.blue, fontSize: 12, fontWeight: 700, textDecoration: "none" }}>
      {label} <ExternalLink size={12} />
    </NextLink>
  );
}

export function PinterestAdvancedSettings({
  limited, needsReconnect,
}: {
  limited: boolean;
  needsReconnect: boolean;
}) {
  const [config, setConfig] = useState<SmartScheduleConfig>(() => getSmartScheduleConfig());
  const [boards, setBoards] = useState<PinterestBoard[]>([]);
  const [boardsState, setBoardsState] = useState<BoardsState>("loading");
  const [lastSynced, setLastSynced] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const loadBoards = useCallback(async (announce?: boolean) => {
    if (announce) setSyncing(true); else setBoardsState("loading");
    try {
      const { items } = await fetchPinterestBoards();
      setBoards(items);
      setBoardsState(items.length ? "loaded" : "empty");
      const now = new Date().toISOString();
      setLastSynced(now);
      if (announce) toast.success(items.length ? `Synced ${items.length} board${items.length === 1 ? "" : "s"}` : "No boards found on Pinterest");
    } catch (e) {
      setBoardsState("error");
      if (announce) toast.error((e as Error).message || "Could not sync boards");
    } finally {
      if (announce) setSyncing(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setConfig(getSmartScheduleConfig());
    void loadBoards();
    // Fail gracefully if boards never arrive (e.g. unauthenticated or network issue)
    const timeout = setTimeout(() => {
      setBoardsState(prev => prev === "loading" ? "error" : prev);
    }, 8000);
    return () => clearTimeout(timeout);
  }, [loadBoards]);

  // Boards saved in config that are no longer present on the account.
  const unavailableRotation = useMemo(
    () => config.boards.filter(cb => boardsState === "loaded" && !boards.some(b => b.id === cb.boardId)),
    [config.boards, boards, boardsState],
  );
  const defaultUnavailable = !!config.defaultBoardId && boardsState === "loaded" && !boards.some(b => b.id === config.defaultBoardId);

  function setDefaultBoard(boardId: string) {
    setConfig(prev => ({ ...prev, defaultBoardId: boardId || undefined }));
  }

  function toggleRotation(board: PinterestBoard) {
    setConfig(prev => {
      const exists = prev.boards.some(b => b.boardId === board.id);
      if (exists) return { ...prev, boards: prev.boards.filter(b => b.boardId !== board.id) };
      if (prev.boards.length >= 2) {
        toast.message("VibePin can rotate scheduled Pins across up to 2 boards.");
        return prev;
      }
      return { ...prev, boards: [...prev.boards, { boardId: board.id, boardName: board.name }] };
    });
  }

  function removeFromRotation(boardId: string) {
    setConfig(prev => ({ ...prev, boards: prev.boards.filter(b => b.boardId !== boardId) }));
  }

  function saveDefaults() {
    setSaving(true);
    try {
      saveSmartScheduleConfig(config);
      toast.success("Board defaults saved");
    } catch {
      toast.error("Could not save board defaults");
    } finally {
      setSaving(false);
    }
  }

  const field: React.CSSProperties = {
    width: "100%", boxSizing: "border-box", padding: "9px 11px", borderRadius: 9,
    border: `1px solid ${UI.border}`, fontSize: 12.5, color: UI.text, background: UI.surface2, outline: "none",
  };
  const label: React.CSSProperties = { fontSize: 10, fontWeight: 800, color: UI.textSec, display: "block", marginBottom: 5, textTransform: "uppercase", letterSpacing: "0.04em" };

  // Publishing access mapping.
  const access: { tone: "success" | "warning" | "muted"; title: string; body: string } = limited
    ? { tone: "warning", title: "Limited Access", body: "Publishing may be limited until Pinterest approves Standard Access." }
    : needsReconnect
      ? { tone: "warning", title: "Reconnect required", body: "Your connection needs re-authorization before publishing will work." }
      : { tone: "success", title: "Standard publishing access", body: "Your account can publish Pins from VibePin." };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, marginTop: 16 }}>
      {/* ── Board defaults ── */}
      <Card title="Board defaults" icon={Layers}>
        <p style={{ margin: "0 0 14px", fontSize: 12, color: UI.textSec, lineHeight: 1.55 }}>
          Choose where VibePin schedules and publishes Pins by default.
        </p>

        {boardsState === "loading" && (
          <p data-testid="board-defaults-loading" style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12, color: UI.textSec, margin: 0 }}>
            <Loader2 size={14} className="animate-spin" /> Loading boards…
          </p>
        )}

        {boardsState === "error" && (
          <div data-testid="board-defaults-error" style={{ display: "flex", flexDirection: "column", gap: 10, alignItems: "flex-start" }}>
            <p style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12, color: "#FCA5A5", margin: 0 }}>
              <AlertTriangle size={14} /> Could not sync boards.
            </p>
            <button type="button" data-testid="board-defaults-retry" onClick={() => void loadBoards()} style={{ padding: "7px 12px", borderRadius: 8, border: `1px solid ${UI.border}`, background: "transparent", color: UI.text, fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
              Try again
            </button>
          </div>
        )}

        {boardsState === "empty" && (
          <div data-testid="board-defaults-empty" style={{ display: "flex", flexDirection: "column", gap: 10, alignItems: "flex-start" }}>
            <p style={{ margin: 0, fontSize: 12, color: UI.textSec }}>Sync boards first to choose your default and rotation boards.</p>
            <button type="button" data-testid="board-defaults-sync" onClick={() => void loadBoards(true)} disabled={syncing}
              style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 13px", borderRadius: 9, border: `1px solid ${UI.blueBorder}`, background: UI.blueBg, color: UI.blue, fontSize: 12, fontWeight: 700, cursor: syncing ? "default" : "pointer" }}>
              {syncing ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} Sync boards
            </button>
          </div>
        )}

        {boardsState === "loaded" && (
          <div data-testid="board-defaults-loaded">
            {/* Default board */}
            <div style={{ marginBottom: 16 }}>
              <label style={label}>Default board</label>
              <select data-testid="default-board-select" value={config.defaultBoardId ?? ""} onChange={e => setDefaultBoard(e.target.value)} style={{ ...field, cursor: "pointer" }}>
                <option value="">No default board</option>
                {defaultUnavailable && config.defaultBoardId && (
                  <option value={config.defaultBoardId}>Board unavailable ({config.defaultBoardId})</option>
                )}
                {boards.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
              {defaultUnavailable && (
                <p data-testid="default-board-unavailable" style={{ margin: "6px 0 0", fontSize: 11, color: UI.warning, display: "flex", alignItems: "center", gap: 5 }}>
                  <AlertTriangle size={12} /> Board unavailable — pick another default board.
                </p>
              )}
            </div>

            {/* Board rotation */}
            <div data-testid="board-rotation-section">
              <label style={label}>Board rotation</label>
              <p style={{ margin: "0 0 10px", fontSize: 11.5, color: UI.textSec, lineHeight: 1.5 }}>
                VibePin rotates scheduled Pins across selected boards. Each Pin is still published to a single board.
              </p>

              {/* Selected rotation boards (max 2) */}
              <div data-testid="board-rotation-selected" style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
                {config.boards.length === 0 && (
                  <p style={{ margin: 0, fontSize: 12, color: UI.textMuted }}>No boards selected for rotation.</p>
                )}
                {config.boards.map(b => (
                  <div
                    key={b.boardId}
                    style={{
                      display: "inline-flex", alignItems: "center", gap: 6,
                      padding: "5px 8px 5px 12px", borderRadius: 8,
                      fontSize: 12, fontWeight: 700,
                      border: "1px solid rgba(16,185,129,0.45)",
                      background: "rgba(16,185,129,0.12)", color: UI.success,
                    }}
                  >
                    <Check size={12} />
                    {b.boardName}
                    <button
                      type="button"
                      data-testid={`rotation-remove-${b.boardId}`}
                      onClick={() => removeFromRotation(b.boardId)}
                      style={{
                        background: "none", border: "none", cursor: "pointer",
                        padding: 0, color: "rgba(16,185,129,0.7)",
                        display: "flex", alignItems: "center",
                      }}
                      aria-label={`Remove ${b.boardName} from rotation`}
                    >
                      <XIcon size={13} />
                    </button>
                  </div>
                ))}
              </div>

              {/* Add board dropdown — only shown when fewer than 2 selected */}
              {config.boards.length < 2 && (
                <select
                  data-testid="board-rotation-add"
                  onChange={e => {
                    const board = boards.find(b => b.id === e.target.value);
                    if (board) toggleRotation(board);
                    e.currentTarget.value = "";
                  }}
                  defaultValue=""
                  style={{ ...field, cursor: "pointer" }}
                >
                  <option value="" disabled>Add a board to rotation…</option>
                  {boards
                    .filter(b => !config.boards.some(x => x.boardId === b.id))
                    .map(b => <option key={b.id} value={b.id}>{b.name}</option>)
                  }
                </select>
              )}

              {unavailableRotation.length > 0 && (
                <p data-testid="rotation-board-unavailable" style={{ margin: "8px 0 0", fontSize: 11, color: UI.warning, display: "flex", alignItems: "center", gap: 5 }}>
                  <AlertTriangle size={12} /> {unavailableRotation.map(b => b.boardName).join(", ")} no longer available — re-pick rotation boards.
                </p>
              )}
            </div>

            {/* Actions */}
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginTop: 16 }}>
              <button type="button" data-testid="board-defaults-save" onClick={saveDefaults} disabled={saving}
                style={{ padding: "9px 16px", borderRadius: 9, border: "none", background: UI.gradient, color: "#fff", fontSize: 12, fontWeight: 800, cursor: saving ? "default" : "pointer", opacity: saving ? 0.75 : 1 }}>
                {saving ? "Saving…" : "Save board defaults"}
              </button>
              <button type="button" data-testid="board-defaults-resync" onClick={() => void loadBoards(true)} disabled={syncing}
                style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "9px 14px", borderRadius: 9, border: `1px solid ${UI.border}`, background: "transparent", color: UI.text, fontSize: 12, fontWeight: 700, cursor: syncing ? "default" : "pointer" }}>
                {syncing ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} Sync boards
              </button>
              {lastSynced && (
                <span style={{ fontSize: 11, color: UI.textMuted }}>Last synced {formatSyncedAt(lastSynced)}</span>
              )}
            </div>
          </div>
        )}
      </Card>

      {/* ── Publishing access — compact status row, no duplicate Reconnect ── */}
      <div data-testid="publishing-access" style={{
        display: "flex", alignItems: "center", gap: 10,
        padding: "10px 14px", borderRadius: 10,
        background: UI.surface2, border: `1px solid ${access.tone === "warning" ? "rgba(245,158,11,0.25)" : UI.border}`,
      }}>
        <span style={{
          width: 8, height: 8, borderRadius: "50%", flexShrink: 0,
          background: access.tone === "success" ? UI.success : UI.warning,
        }} />
        <span style={{ fontSize: 12, fontWeight: 700, color: access.tone === "warning" ? "#FCD34D" : UI.text, flex: 1 }}>
          {access.title}
        </span>
        {access.tone === "warning" && (
          <NextLink href={PINTEREST_ACCESS_HELP} target="_blank" rel="noopener noreferrer"
            style={{ fontSize: 11, color: UI.blue, textDecoration: "none", fontWeight: 600, flexShrink: 0 }}>
            Learn more ↗
          </NextLink>
        )}
      </div>

      {/* ── Advanced setup (collapsed) ── */}
      <section style={{ background: UI.surface, border: `1px solid ${UI.border}`, borderRadius: 16, overflow: "hidden" }}>
        <button
          type="button"
          onClick={() => setAdvancedOpen(v => !v)}
          style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            width: "100%", padding: "14px 18px", border: "none",
            background: "transparent", cursor: "pointer", textAlign: "left",
          }}
        >
          <div>
            <p style={{ margin: 0, fontSize: 13.5, fontWeight: 700, color: UI.text }}>Advanced setup</p>
            <p style={{ margin: "2px 0 0", fontSize: 11.5, color: UI.textSec }}>Optional website, domain, and catalog setup.</p>
          </div>
          <ChevronDown size={16} style={{ color: UI.textSec, flexShrink: 0, transform: advancedOpen ? "rotate(180deg)" : "none", transition: "transform 0.15s" }} />
        </button>

        {advancedOpen && (
          <div style={{ padding: "0 18px 18px", display: "flex", flexDirection: "column", gap: 14, borderTop: `1px solid ${UI.border}`, paddingTop: 16 }}>
            {/* Website & domain */}
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <Globe size={14} style={{ color: UI.textSec }} />
                <p style={{ margin: 0, fontSize: 13, fontWeight: 700, color: UI.text }}>Website and domain</p>
              </div>
              <p style={{ margin: "0 0 10px", fontSize: 12, color: UI.textSec, lineHeight: 1.5 }}>
                Optional. Claiming your website isn&apos;t required to publish from VibePin.
              </p>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {secondaryLink(PINTEREST_CLAIM_SETTINGS, "Open Pinterest settings")}
                <NextLink href={PINTEREST_CLAIM_HELP} target="_blank" rel="noopener noreferrer"
                  style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "8px 13px", fontSize: 12, fontWeight: 700, color: UI.textSec, textDecoration: "none" }}>
                  Learn more <ChevronRight size={13} />
                </NextLink>
              </div>
            </div>

            {/* Pinterest catalog */}
            <div style={{ paddingTop: 12, borderTop: `1px solid ${UI.border}` }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <ShoppingBag size={14} style={{ color: UI.textSec }} />
                <p style={{ margin: 0, fontSize: 13, fontWeight: 700, color: UI.text }}>Product catalog</p>
              </div>
              <p style={{ margin: "0 0 10px", fontSize: 12, color: UI.textSec, lineHeight: 1.5 }}>
                Optional. Set up a product catalog on Pinterest if you sell products. VibePin doesn&apos;t require a catalog.
              </p>
              <NextLink href={PINTEREST_CATALOG_SETUP} target="_blank" rel="noopener noreferrer" data-testid="catalog-link"
                style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12, fontWeight: 700, color: UI.blue, textDecoration: "none" }}>
                Set up Pinterest catalog <ExternalLink size={12} />
              </NextLink>
            </div>

            {/* Multi-account note */}
            <div data-testid="pinterest-multiaccount-note" style={{ paddingTop: 12, borderTop: `1px solid ${UI.border}` }}>
              <p style={{ margin: 0, fontSize: 11.5, color: UI.textMuted }}>
                Multiple Pinterest accounts are not supported yet. VibePin supports one connected account per workspace.
              </p>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
