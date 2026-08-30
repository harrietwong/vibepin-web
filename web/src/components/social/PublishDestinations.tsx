"use client";

/**
 * Compact publishing account selector.
 *
 * The rows paint immediately from cache/fallback, then hydrate from
 * /api/social/connections — the single connection truth for every provider (PRD §7).
 * Pinterest is not special-cased here: its dedicated API still owns boards, capability
 * and metadata, but connection status comes from the same place Settings reads.
 */

import { Fragment, useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Check, Link as LinkIcon, Loader2 } from "lucide-react";
import { PlatformIcon } from "@/components/social/PlatformIcon";
import { PLATFORMS, SOCIAL_PROVIDERS, VISIBLE_SOCIAL_PROVIDERS, type SocialProvider } from "@/lib/social/platforms";
import type { PlatformConnectionSummary } from "@/lib/social/types";
import { fetchSocialConnections } from "@/lib/social/socialClient";
import { getCachedConnections, setCachedConnections, SOCIAL_CONNECTIONS_CHANGED_EVENT } from "@/lib/social/connectionsCache";
import {
  PINTEREST_DISCONNECTED_EVENT,
  fetchPinterestBoards,
  fetchPinterestDefaultBoard,
  savePinterestDefaultBoard,
} from "@/lib/pinterestClient";
import { useLocale } from "@/lib/i18n/LocaleProvider";

const CONNECTIONS_TIMEOUT_MS = 3000;

/**
 * One ticked ACCOUNT. Several entries may share a provider — that is the whole point:
 * two Pinterest accounts are two destinations, each with its own board.
 */
export type SelectedAccount = {
  provider: string;
  id: string;
  /** Pinterest only: the board THIS account publishes to. Cleared when it is unticked. */
  boardId?: string;
  boardName?: string;
};

function defaultSummaries(): PlatformConnectionSummary[] {
  return SOCIAL_PROVIDERS.map((provider): PlatformConnectionSummary => ({
    provider,
    status: "not_connected",
    connected: false,
    accountCount: 0,
    accountName: null,
    liveConnect: PLATFORMS[provider].liveConnect,
    accounts: [],
  }));
}

const UI = {
  surface2: "var(--app-surface-2, #1A2235)",
  border: "var(--app-border, rgba(255,255,255,0.10))",
  text: "var(--app-text, #E2E8F0)",
  textSec: "var(--app-text-sec, #8892A4)",
  textMuted: "#5B6577",
  success: "#10B981",
  blue: "#93C5FD",
};

function DestinationRow({
  summary,
  selected,
  onToggle,
  onConnect,
  connecting,
  checkingConnection,
  scheduleMode,
}: {
  summary: PlatformConnectionSummary;
  selected: boolean;
  onToggle: () => void;
  /** Start this platform's connect flow from the row itself. */
  onConnect?: () => void;
  connecting?: boolean;
  checkingConnection?: boolean;
  /** True when the caller is choosing destinations for a FUTURE-DATED publish. */
  scheduleMode?: boolean;
}) {
  const { t } = useLocale();
  const meta = PLATFORMS[summary.provider];
  // Belt-and-braces: only platforms with a REAL live publish path are ever
  // actionable. The provider layer already can't connect non-Pinterest platforms
  // (mock returns coming_soon / not_implemented), but even a stray "connected" DB
  // row must not make an unimplemented platform selectable for publishing.
  const publishable = summary.connected && meta.liveConnect;
  // In schedule mode a platform we cannot replay at due time is not selectable —
  // but it stays visible and keeps its account identity, because the account IS
  // connected. Hiding the row, or showing "Not connected", would both be lies.
  const blockedForSchedule = !!scheduleMode && publishable && !meta.liveSchedule;
  const actionable = publishable && !blockedForSchedule;
  // Any live platform can be connected from right here. Previously only Pinterest
  // offered this, so an unconnected Facebook Page was a dead row: the merchant
  // was told "Not connected" with no way forward, and had to find Settings on
  // their own and then navigate back to the Pin they were publishing.
  const canConnectHere = !publishable && meta.liveConnect && !!onConnect && !checkingConnection;
  const statusText = blockedForSchedule
    ? t("publishDestinations.schedulingUnavailable")
    : !meta.liveConnect
    ? t("publishDestinations.comingSoon")
    : publishable
      ? t("publishDestinations.connected")
      : checkingConnection
        ? t("publishDestinations.checkingConnection")
        : t("publishDestinations.notConnected");

  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (!actionable) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onToggle();
    }
  }

  return (
    <div
      role={actionable ? "checkbox" : "group"}
      aria-checked={actionable ? selected : undefined}
      aria-disabled={!actionable}
      data-schedule-blocked={blockedForSchedule ? "true" : undefined}
      tabIndex={actionable ? 0 : -1}
      data-testid={`publish-dest-${summary.provider}`}
      onClick={actionable ? onToggle : undefined}
      onKeyDown={handleKeyDown}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        minHeight: 44,
        padding: "8px 10px",
        borderTop: `1px solid ${UI.border}`,
        background: selected ? "rgba(59,130,246,0.08)" : "transparent",
        cursor: actionable ? "pointer" : "default",
        opacity: actionable || canConnectHere ? 1 : 0.62,
      }}
    >
      <span
        aria-hidden
        style={{
          width: 18,
          height: 18,
          borderRadius: 99,
          flexShrink: 0,
          border: `1.5px solid ${selected ? "#3B82F6" : UI.border}`,
          background: selected ? "#3B82F6" : "transparent",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {selected && <Check size={12} style={{ color: "#fff" }} strokeWidth={3} />}
      </span>

      <PlatformIcon provider={summary.provider} size={24} />

      <div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <div style={{ minWidth: 0 }}>
          <p style={{ margin: 0, fontSize: 13, fontWeight: 750, color: UI.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {meta.name}
          </p>
          {publishable && summary.accountName && (
            <p style={{ margin: "1px 0 0", fontSize: 10.5, color: UI.textMuted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {summary.accountName}
            </p>
          )}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
          <span
            data-testid={`publish-dest-${summary.provider}-status`}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              fontSize: 11.5,
              fontWeight: 700,
              color: publishable ? UI.success : checkingConnection ? UI.textSec : UI.textMuted,
              whiteSpace: "nowrap",
            }}
          >
            {publishable && <Check size={12} strokeWidth={3} />}
            {statusText}
          </span>

          {canConnectHere && (
            <button
              type="button"
              data-testid={`publish-dest-${summary.provider}-connect`}
              onClick={(e) => { e.stopPropagation(); onConnect?.(); }}
              disabled={connecting}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                padding: "4px 8px",
                borderRadius: 7,
                border: "1px solid rgba(59,130,246,0.35)",
                background: "rgba(59,130,246,0.10)",
                color: UI.blue,
                fontSize: 11,
                fontWeight: 800,
                cursor: connecting ? "wait" : "pointer",
              }}
            >
              {connecting ? <Loader2 size={12} className="animate-spin" /> : <LinkIcon size={12} />}
              {connecting ? t("publishDestinations.redirecting") : t("socialPanel.action.connect")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The board ONE ticked Pinterest account publishes to.
 *
 * Boards are per-account, so the list is fetched with this account's connection id —
 * listing "the" boards would show whichever account the server defaults to. The last
 * board chosen for THIS account seeds the field (`fetchPinterestDefaultBoard(id)`) and
 * a new choice is remembered against it (`savePinterestDefaultBoard(board, id)`), so a
 * merchant publishing to two accounts does not re-pick both boards every time.
 *
 * It never auto-picks: an account with no remembered board shows "Choose a board" and
 * the destination is refused at publish time rather than landing somewhere unintended.
 */
function AccountBoardSelect({
  connectionId,
  value,
  onChange,
}: {
  connectionId: string;
  value: string;
  onChange: (board: { boardId: string; boardName: string } | null) => void;
}) {
  const { t } = useLocale();
  const [boards, setBoards] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const seededRef = useRef(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetchPinterestBoards(undefined, undefined, connectionId)
      .then(result => {
        if (!alive) return;
        setBoards(result.items.map(b => ({ id: b.id, name: b.name })));
      })
      .catch(() => { if (alive) setBoards([]); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [connectionId]);

  // Seed from THIS account's remembered board, once, and only while the field is
  // still empty — never overwrite a board the merchant just chose.
  useEffect(() => {
    if (seededRef.current || value) return;
    seededRef.current = true;
    let alive = true;
    void fetchPinterestDefaultBoard(undefined, connectionId)
      .then(board => {
        if (!alive || !board?.boardId) return;
        onChangeRef.current({ boardId: board.boardId, boardName: board.boardName ?? "" });
      })
      .catch(() => { /* no remembered board — the merchant picks one */ });
    return () => { alive = false; };
  }, [connectionId, value]);

  return (
    <div style={{ padding: "0 10px 8px 60px" }}>
      <select
        data-testid={`publish-dest-board-${connectionId}`}
        aria-label={t("publishDestinations.boardLabel")}
        value={value}
        onChange={e => {
          const boardId = e.target.value;
          if (!boardId) { onChange(null); return; }
          const board = boards.find(b => b.id === boardId);
          onChange({ boardId, boardName: board?.name ?? "" });
          // Remembered against THIS connection, so the other account's board is untouched.
          void savePinterestDefaultBoard({ boardId, boardName: board?.name ?? "" }, connectionId).catch(() => {});
        }}
        style={{
          width: "100%", padding: "5px 7px", borderRadius: 7,
          border: `1px solid ${UI.border}`, background: UI.surface2,
          color: UI.text, fontSize: 11, fontFamily: "inherit",
        }}
      >
        <option value="">{loading ? t("publishDestinations.boardLoading") : t("publishDestinations.boardPlaceholder")}</option>
        {boards.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
      </select>
    </div>
  );
}

export function PublishDestinations({
  selected,
  onSelectedChange,
  onConnectPinterest,
  connectingPinterest,
  pinterestConnected,
  pinterestAccountName,
  scheduleMode,
  onSummariesChange,
  renderDetails,
  selectedAccountIds,
  onSelectedAccountIdsChange,
}: {
  selected: SocialProvider[];
  onSelectedChange: (next: SocialProvider[]) => void;
  /**
   * Which specific accounts are selected, for platforms where the merchant has
   * connected more than one. Platform-level `selected` still decides whether a
   * platform participates at all; this narrows it to particular accounts, so a
   * caller that does not care about accounts keeps working unchanged.
   */
  selectedAccountIds?: SelectedAccount[];
  onSelectedAccountIdsChange?: (next: SelectedAccount[]) => void;
  onConnectPinterest?: () => void;
  connectingPinterest?: boolean;
  pinterestConnected?: boolean;
  pinterestAccountName?: string | null;
  /**
   * True when the chosen destinations are for a FUTURE-DATED publish. Platforms
   * whose scheduled intent we cannot yet persist and replay are shown, keep their
   * account identity, but cannot be ticked. Publish now leaves this false and is
   * completely unaffected.
   */
  scheduleMode?: boolean;
  /**
   * Reports the loaded per-platform connection summaries upward. The parent needs
   * them to record WHICH account a scheduled destination refers to — the drawer
   * itself only tracks Pinterest connections, while Instagram/Facebook accounts
   * are known here.
   */
  onSummariesChange?: (summaries: PlatformConnectionSummary[]) => void;
  /**
   * Extra controls that belong to ONE destination (PRD 0809 §3) — Pinterest's account
   * and board. Rendered directly under that platform's row so a Board list is never
   * separated from the account it belongs to, and only while the row is selected.
   */
  renderDetails?: (provider: SocialProvider, selected: boolean) => React.ReactNode;
}) {
  // Non-Pinterest platforms start their own OAuth from the row. returnTo carries
  // the CURRENT url (path + query), so the callback lands the merchant back on
  // the exact Pin they were publishing instead of a bare Settings page.
  const [connectingProvider, setConnectingProvider] = useState<SocialProvider | null>(null);
  const connectProvider = useCallback((provider: SocialProvider) => {
    if (provider === "pinterest") return; // Pinterest keeps its dedicated handler
    setConnectingProvider(provider);
    const returnTo = `${window.location.pathname}${window.location.search}`;
    window.location.assign(
      `/api/auth/${provider}/connect?next=${encodeURIComponent(returnTo)}`,
    );
  }, []);
  const { t } = useLocale();
  const cached = getCachedConnections();
  const [summaries, setSummaries] = useState<PlatformConnectionSummary[]>(
    () => cached?.platforms ?? defaultSummaries(),
  );
  const [hasLoaded, setHasLoaded] = useState(() => !!cached);
  const [error, setError] = useState(false);
  const loadSeqRef = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeqRef.current;
    const isCurrent = () => seq === loadSeqRef.current;

    // A slow answer is still the truth — the same rule the Pinterest status signal below
    // already follows. This used to race the fetch against CONNECTIONS_TIMEOUT_MS and
    // treat the timeout as failure, which set error state and painted every row (Instagram
    // and Facebook included) as "Not connected" while the accounts were connected on the
    // server. That is routine, not exotic: this endpoint reads several providers and
    // measured 4.1s on a cold call against the 3s ceiling, and publishing adds load right
    // when the drawer re-reads — which is exactly why the rows "went Not connected after
    // publishing". Only a real failure (network error / non-OK response) may report
    // not-connected; a slow fetch just leaves the rows on cache/placeholder until it lands.
    const slowWarn = process.env.NODE_ENV !== "production"
      ? setTimeout(() => console.warn(`[social connections] still pending after ${CONNECTIONS_TIMEOUT_MS}ms — waiting for the real answer`), CONNECTIONS_TIMEOUT_MS)
      : null;

    try {
      const { platforms } = await fetchSocialConnections();
      if (slowWarn) clearTimeout(slowWarn);
      if (!isCurrent()) return;
      setSummaries(platforms);
      setCachedConnections(platforms);
      setHasLoaded(true);
      setError(false);
      // NOTHING about the SELECTION is decided here. This block used to reset the
      // selection to ["pinterest"] on the first load of every mount, ignoring the
      // parent's current value — and this component is mounted fresh each time the
      // Plan drawer opens. A Content scheduled to Pinterest + Instagram, reopened,
      // therefore had its intent silently rewritten to Pinterest-only, and "Update
      // schedule" persisted that. The one remaining default lives in the effect below,
      // which only ever fills an EMPTY selection.
    } catch {
      // A genuine failure (network error / non-OK) — not merely a slow response.
      if (slowWarn) clearTimeout(slowWarn);
      if (!isCurrent()) return;
      setError(true);
      setHasLoaded(true);
    }
  }, [onSelectedChange]);

  useEffect(() => {
    void load();
  }, [load]);

  // Hand the loaded accounts to the parent so a scheduled destination can be
  // recorded against a real connection id rather than a platform name.
  useEffect(() => {
    if (onSummariesChange) onSummariesChange(summaries);
  }, [summaries, onSummariesChange]);


  // Disconnecting Pinterest in Settings while this drawer sits open behind it (e.g.
  // Settings opened as an overlay) doesn't unmount this component, so nothing would
  // otherwise trigger a re-check — the checkbox would keep showing "Connected"
  // indefinitely. React to the broadcast event immediately: drop the local override
  // AND force a fresh connections load (also clears the now-stale selection).
  useEffect(() => {
    function onDisconnected() {
      if (selected.includes("pinterest")) onSelectedChange(selected.filter(p => p !== "pinterest"));
      void load();
    }
    // Any provider's connection change (connect / disconnect / Page re-select)
    // refetches, so these rows can never disagree with the Settings panel.
    function onConnectionsChanged() {
      void load();
    }
    window.addEventListener(SOCIAL_CONNECTIONS_CHANGED_EVENT, onConnectionsChanged);
    window.addEventListener(PINTEREST_DISCONNECTED_EVENT, onDisconnected);
    return () => {
      window.removeEventListener(SOCIAL_CONNECTIONS_CHANGED_EVENT, onConnectionsChanged);
      window.removeEventListener(PINTEREST_DISCONNECTED_EVENT, onDisconnected);
    };
  }, [load, selected, onSelectedChange]);

  // Default Pinterest ON once when it resolves as connected — but never fight the
  // merchant. The previous version re-added Pinterest on EVERY render where it was
  // connected-but-unselected, which made the checkbox impossible to uncheck (it
  // sprang back instantly) and forced every publish through the Pinterest leg.
  // Social-only publishes (e.g. Facebook Page only) are legitimate.
  //
  // THE RULE: a non-empty `selected` is the parent's stored intent and is NEVER
  // overwritten or added to. Only an EMPTY selection may be defaulted, and only once.
  // Adding Pinterest to a selection that already named other platforms was intent
  // corruption in both parents: the card persists every selection change
  // (persistDestinationSelection), so reopening an Instagram-only Content wrote a
  // Pinterest destination the merchant never chose into its stored intent.
  const didDefaultPinterest = useRef(false);
  useEffect(() => {
    if (didDefaultPinterest.current) return;
    if (selected.length) {
      // The parent has a selection of its own. Stand down permanently — including
      // later, if the merchant unticks everything (that is a choice, not a gap).
      didDefaultPinterest.current = true;
      return;
    }
    const connected = summaries.find(s2 => s2.provider === "pinterest")?.connected ?? !!pinterestConnected;
    // Not connected, or not known yet: decide nothing — the answer may still arrive.
    if (!connected) return;
    didDefaultPinterest.current = true;
    onSelectedChange(["pinterest"]);
  }, [onSelectedChange, pinterestConnected, summaries, selected]);

  // Strip any non-live provider from the selection (e.g. stale persisted state).
  // Unimplemented platforms must never be scheduled/published against.
  useEffect(() => {
    const live = selected.filter(p => PLATFORMS[p].liveConnect);
    if (live.length !== selected.length) onSelectedChange(live);
  }, [selected, onSelectedChange]);

  /**
   * An account is selected only when it is EXPLICITLY listed.
   *
   * It used to read "listed, or nothing narrowed yet ⇒ all". Once several accounts on
   * one platform can each be their own destination, that default silently publishes to
   * every connected account the moment a second one is connected — the merchant ticks
   * Instagram and two Pages receive the post. Fail closed instead: with several accounts
   * and none ticked, nothing is written and the caller's ambiguity error blocks publish.
   * The single-account case never reaches here (the account rows are not rendered).
   */
  function accountChecked(id: string): boolean {
    return !!selectedAccountIds?.some(a => a.id === id);
  }

  function toggleAccount(provider: SocialProvider, id: string, label?: string) {
    if (!onSelectedAccountIdsChange) return;
    const current = selectedAccountIds ?? [];
    const next = current.some(a => a.id === id)
      // Unticking drops the account's board with it (§18): a board id belongs to one
      // account, and keeping it would silently re-apply on a re-tick.
      ? current.filter(a => a.id !== id)
      : [...current, { provider: provider as string, id, ...(label ? { accountLabel: label } : {}) }];
    onSelectedAccountIdsChange(next);
  }

  /** Set (or clear) the board of ONE ticked Pinterest account. */
  function setAccountBoard(id: string, board: { boardId: string; boardName: string } | null) {
    if (!onSelectedAccountIdsChange) return;
    onSelectedAccountIdsChange((selectedAccountIds ?? []).map(a =>
      a.id === id
        ? { provider: a.provider, id: a.id, ...(board ? { boardId: board.boardId, boardName: board.boardName } : {}) }
        : a));
  }

  function toggle(provider: SocialProvider) {
    if (!PLATFORMS[provider].liveConnect) return;
    const next = selected.includes(provider)
      ? selected.filter(p => p !== provider)
      : [...selected, provider];
    onSelectedChange(next);
  }

  // ONE connection truth (PRD §7). /api/social/connections is canonical for every
  // provider, Pinterest included: it already reports status, account count, display name
  // and the per-account rows. The Pinterest-specific status signal used to override it
  // here, which meant Settings and this drawer could compute different answers for the
  // same account — and the override's not-connected branch could overrule a canonical
  // "connected", the dual-truth this section exists to remove. The Pinterest API keeps
  // its jobs (boards, capability, metadata); it no longer decides connection status.
  const effectiveSummaries = summaries;
  const pinterestSummary = summaries.find(s => s.provider === "pinterest");
  const effectivePinterestConnected = !!pinterestSummary?.connected;

  return (
    <div
      data-testid="publish-destinations"
      style={{
        border: `1px solid ${UI.border}`,
        borderRadius: 10,
        padding: "12px 12px 8px",
        background: UI.surface2,
      }}
    >
      <div style={{ padding: "0 2px 8px" }}>
        <p style={{ margin: 0, fontSize: 13, fontWeight: 800, color: UI.text }}>{t("publishDestinations.title")}</p>
        <p style={{ margin: "2px 0 0", fontSize: 11.5, color: UI.textSec, lineHeight: 1.45 }}>
          {t("publishDestinations.subtitle")}
        </p>
      </div>

      <div style={{ display: "flex", flexDirection: "column" }}>
        {VISIBLE_SOCIAL_PROVIDERS.map(provider => {
          const summary = effectiveSummaries.find(s => s.provider === provider);
          if (!summary) return null;
          const multi = summary.accounts.filter(a => a.connectionStatus === "connected");
          const showAccounts = multi.length > 1 && selected.includes(provider);
          return (
            <Fragment key={provider}>
            <DestinationRow
              summary={summary}
              selected={selected.includes(provider)}
              onToggle={() => toggle(provider)}
              scheduleMode={scheduleMode}
              onConnect={
                provider === "pinterest"
                  ? onConnectPinterest
                  : () => connectProvider(provider)
              }
              connecting={
                provider === "pinterest"
                  ? connectingPinterest
                  : connectingProvider === provider
              }
              checkingConnection={!hasLoaded && !summary.connected}
            />
            {showAccounts && multi.map(acct => {
              const checked = accountChecked(acct.id);
              const label = acct.providerAccountUsername ?? acct.providerAccountName ?? acct.id.slice(0, 8);
              return (
                <Fragment key={acct.id}>
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={checked}
                  data-testid={`publish-dest-${provider}-account-${acct.id}`}
                  onClick={() => toggleAccount(provider, acct.id, label ?? undefined)}
                  style={{
                    display: "flex", alignItems: "center", gap: 8,
                    padding: "6px 10px 6px 42px", border: "none",
                    borderTop: `1px solid ${UI.border}`, width: "100%",
                    background: checked ? "rgba(59,130,246,0.06)" : "transparent",
                    cursor: "pointer", textAlign: "left", fontFamily: "inherit",
                  }}
                >
                  <span aria-hidden style={{
                    width: 14, height: 14, borderRadius: 4, flexShrink: 0,
                    border: `1.5px solid ${checked ? "#3B82F6" : UI.border}`,
                    background: checked ? "#3B82F6" : "transparent",
                    display: "flex", alignItems: "center", justifyContent: "center",
                  }}>
                    {checked && <Check size={10} style={{ color: "#fff" }} strokeWidth={3} />}
                  </span>
                  <span style={{
                    fontSize: 11.5, color: checked ? UI.text : UI.textSec,
                    whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                  }}>
                    {acct.providerAccountName ?? acct.providerAccountUsername ?? acct.id.slice(0, 8)}
                  </span>
                </button>
                {/* Each ticked Pinterest account picks its OWN board — boards belong to
                    one account, so a shared board field would publish the second
                    account's Pin into the first account's board. */}
                {checked && provider === "pinterest" && (
                  <AccountBoardSelect
                    connectionId={acct.id}
                    value={selectedAccountIds?.find(a => a.id === acct.id)?.boardId ?? ""}
                    onChange={board => setAccountBoard(acct.id, board)}
                  />
                )}
                </Fragment>
              );
            })}
            </Fragment>
          );
        }).map((node, i) => {
          const provider = VISIBLE_SOCIAL_PROVIDERS[i];
          const summary = effectiveSummaries.find(s2 => s2.provider === provider);
          const isSelected = selected.includes(provider);
          const details = node && summary?.connected && isSelected ? renderDetails?.(provider, isSelected) : null;
          return details ? (
            <div key={`${provider}-group`}>
              {node}
              <div style={{ padding: "0 10px 10px 46px", borderTop: "none" }}>{details}</div>
            </div>
          ) : node;
        })}
        {/* Per-account rows appear only where the merchant connected more than
            one account on a platform. With a single account the platform row is
            already unambiguous, and an extra row naming the same thing twice
            would be noise. */}
      </div>

      {error && !effectivePinterestConnected && (
        <div style={{ marginTop: 8, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
          <p style={{ margin: 0, fontSize: 10.5, color: UI.textMuted, lineHeight: 1.5 }}>
            {t("publishDestinations.loadError")}
          </p>
          <button
            type="button"
            data-testid="publish-dest-retry"
            onClick={() => void load()}
            style={{ flexShrink: 0, background: "none", border: "none", padding: 0, color: UI.blue, fontSize: 10.5, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" }}
          >
            {t("publishDestinations.tryAgain")}
          </button>
        </div>
      )}
    </div>
  );
}
