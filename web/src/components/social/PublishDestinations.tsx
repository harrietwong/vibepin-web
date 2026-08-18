"use client";

/**
 * Compact publishing account selector.
 *
 * The rows paint immediately from cache/fallback, then hydrate from the shared
 * /api/social/connections source. Pinterest can also be overridden by the host's
 * live /api/pinterest/status signal so account connection state is not coupled to
 * board loading.
 */

import { Fragment, useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Check, Link as LinkIcon, Loader2 } from "lucide-react";
import { PlatformIcon } from "@/components/social/PlatformIcon";
import { PLATFORMS, SOCIAL_PROVIDERS, type SocialProvider } from "@/lib/social/platforms";
import type { PlatformConnectionSummary } from "@/lib/social/types";
import { fetchSocialConnections } from "@/lib/social/socialClient";
import { getCachedConnections, setCachedConnections, SOCIAL_CONNECTIONS_CHANGED_EVENT } from "@/lib/social/connectionsCache";
import { fetchPinterestStatusCached, PINTEREST_DISCONNECTED_EVENT } from "@/lib/pinterestClient";
import { isRealPinterestConnection } from "@/lib/pinterest/connection";
import { useLocale } from "@/lib/i18n/LocaleProvider";

const CONNECTIONS_TIMEOUT_MS = 3000;
const PINTEREST_STATUS_TIMEOUT_MS = 2500;

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
}: {
  summary: PlatformConnectionSummary;
  selected: boolean;
  onToggle: () => void;
  /** Start this platform's connect flow from the row itself. */
  onConnect?: () => void;
  connecting?: boolean;
  checkingConnection?: boolean;
}) {
  const { t } = useLocale();
  const meta = PLATFORMS[summary.provider];
  // Belt-and-braces: only platforms with a REAL live publish path are ever
  // actionable. The provider layer already can't connect non-Pinterest platforms
  // (mock returns coming_soon / not_implemented), but even a stray "connected" DB
  // row must not make an unimplemented platform selectable for publishing.
  const publishable = summary.connected && meta.liveConnect;
  // Any live platform can be connected from right here. Previously only Pinterest
  // offered this, so an unconnected Facebook Page was a dead row: the merchant
  // was told "Not connected" with no way forward, and had to find Settings on
  // their own and then navigate back to the Pin they were publishing.
  const canConnectHere = !publishable && meta.liveConnect && !!onConnect && !checkingConnection;
  const statusText = !meta.liveConnect
    ? t("publishDestinations.comingSoon")
    : publishable
      ? t("publishDestinations.connected")
      : checkingConnection
        ? t("publishDestinations.checkingConnection")
        : t("publishDestinations.notConnected");

  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (!publishable) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onToggle();
    }
  }

  return (
    <div
      role={publishable ? "checkbox" : "group"}
      aria-checked={publishable ? selected : undefined}
      aria-disabled={!publishable}
      tabIndex={publishable ? 0 : -1}
      data-testid={`publish-dest-${summary.provider}`}
      onClick={publishable ? onToggle : undefined}
      onKeyDown={handleKeyDown}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        minHeight: 44,
        padding: "8px 10px",
        borderTop: `1px solid ${UI.border}`,
        background: selected ? "rgba(59,130,246,0.08)" : "transparent",
        cursor: publishable ? "pointer" : "default",
        opacity: publishable || canConnectHere ? 1 : 0.62,
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
              {connecting ? t("publishDestinations.redirecting") : "Connect"}
            </button>
          )}
        </div>
      </div>
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
  selectedAccountIds?: Array<{ provider: string; id: string }>;
  onSelectedAccountIdsChange?: (next: Array<{ provider: string; id: string }>) => void;
  onConnectPinterest?: () => void;
  connectingPinterest?: boolean;
  pinterestConnected?: boolean;
  pinterestAccountName?: string | null;
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
  const [pinterestOverride, setPinterestOverride] = useState<{
    loaded: boolean;
    connected: boolean;
    accountName: string | null;
  }>({ loaded: false, connected: false, accountName: null });
  const didInitSelection = useRef(false);
  const loadSeqRef = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeqRef.current;
    const isCurrent = () => seq === loadSeqRef.current;
    const timeoutAfter = async <T,>(promise: Promise<T>): Promise<T> => {
      let timeout: ReturnType<typeof setTimeout> | null = null;
      try {
        return await Promise.race([
          promise,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error("social_connections_timeout")), CONNECTIONS_TIMEOUT_MS);
          }),
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    };

    try {
      const { platforms } = await timeoutAfter(fetchSocialConnections());
      if (!isCurrent()) return;
      setSummaries(platforms);
      setCachedConnections(platforms);
      setHasLoaded(true);
      setError(false);
      if (!didInitSelection.current) {
        didInitSelection.current = true;
        const pinterest = platforms.find(p => p.provider === "pinterest");
        if (pinterest?.connected) onSelectedChange(["pinterest"]);
      }
    } catch {
      if (!isCurrent()) return;
      setError(true);
      setHasLoaded(true);
    }
  }, [onSelectedChange]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    // Apply the REAL status whenever it settles — a slow answer is still the truth.
    // The old code raced the fetch against a 2.5s timeout and, when the timeout won
    // (routine through a proxy: the status round trip alone is often >2.5s), flipped
    // the row to a PERMANENT "Not connected" and discarded the late result — which is
    // exactly the "connected on the server but the drawer says Not connected" bug
    // right after an OAuth return. A slow fetch now just leaves the row in its
    // "Checking connection…" / host-hint state until the answer lands; only a real
    // failure (network error / non-OK) reports not-connected. The fetch is never
    // aborted (an unawaited AbortError pops Next's dev overlay).
    let cancelled = false;
    const t0 = process.env.NODE_ENV !== "production" ? performance.now() : 0;
    const slowWarn = process.env.NODE_ENV !== "production"
      ? setTimeout(() => console.warn(`[Pinterest account status] still pending after ${PINTEREST_STATUS_TIMEOUT_MS}ms — waiting for the real answer`), PINTEREST_STATUS_TIMEOUT_MS)
      : null;
    fetchPinterestStatusCached()
      .then(status => {
        if (cancelled) return;
        if (process.env.NODE_ENV !== "production") console.log(`[Pinterest account status] resolved in ${(performance.now() - t0).toFixed(0)}ms`);
        setPinterestOverride({
          loaded: true,
          connected: isRealPinterestConnection(status),
          accountName: status.account?.username ?? null,
        });
      })
      .catch(() => {
        if (!cancelled) setPinterestOverride({ loaded: true, connected: false, accountName: null });
      })
      .finally(() => {
        if (slowWarn) clearTimeout(slowWarn);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Disconnecting Pinterest in Settings while this drawer sits open behind it (e.g.
  // Settings opened as an overlay) doesn't unmount this component, so nothing would
  // otherwise trigger a re-check — the checkbox would keep showing "Connected"
  // indefinitely. React to the broadcast event immediately: drop the local override
  // AND force a fresh connections load (also clears the now-stale selection).
  useEffect(() => {
    function onDisconnected() {
      setPinterestOverride({ loaded: true, connected: false, accountName: null });
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
  const didDefaultPinterest = useRef(false);
  useEffect(() => {
    if (didDefaultPinterest.current) return;
    const connected = pinterestOverride.loaded ? pinterestOverride.connected : !!pinterestConnected;
    if (!connected || selected.includes("pinterest")) return;
    didDefaultPinterest.current = true;
    onSelectedChange(["pinterest", ...selected.filter(p => p !== "pinterest")]);
  }, [onSelectedChange, pinterestConnected, pinterestOverride.connected, selected]);

  // Strip any non-live provider from the selection (e.g. stale persisted state).
  // Unimplemented platforms must never be scheduled/published against.
  useEffect(() => {
    const live = selected.filter(p => PLATFORMS[p].liveConnect);
    if (live.length !== selected.length) onSelectedChange(live);
  }, [selected, onSelectedChange]);

  // An account counts as selected when it is explicitly listed, OR when nothing
  // has been narrowed yet — connecting a second account should not silently stop
  // publishing to the first. Explicit selection only starts once the merchant
  // unticks something.
  function accountChecked(id: string): boolean {
    return !selectedAccountIds?.length || selectedAccountIds.some(a => a.id === id);
  }

  function toggleAccount(provider: SocialProvider, id: string) {
    if (!onSelectedAccountIdsChange) return;
    const current = selectedAccountIds?.length
      ? selectedAccountIds
      // First untick materialises the implicit "all" into a concrete list, so
      // removing one account does not read as "select only this one".
      : summaries.flatMap(s =>
          s.accounts
            .filter(a => a.connectionStatus === "connected")
            .map(a => ({ provider: s.provider as string, id: a.id })));
    const next = current.some(a => a.id === id)
      ? current.filter(a => a.id !== id)
      : [...current, { provider: provider as string, id }];
    onSelectedAccountIdsChange(next);
  }

  function toggle(provider: SocialProvider) {
    if (!PLATFORMS[provider].liveConnect) return;
    const next = selected.includes(provider)
      ? selected.filter(p => p !== provider)
      : [...selected, provider];
    onSelectedChange(next);
  }

  const effectivePinterestConnected = pinterestOverride.loaded ? pinterestOverride.connected : !!pinterestConnected;
  const effectivePinterestAccountName = pinterestOverride.loaded ? pinterestOverride.accountName : pinterestAccountName;

  const effectiveSummaries = summaries.map(summary => {
    if (summary.provider !== "pinterest") return summary;
    if (effectivePinterestConnected) {
      return {
        ...summary,
        status: "connected" as const,
        connected: true,
        accountCount: Math.max(summary.accountCount, 1),
        accountName: effectivePinterestAccountName ?? summary.accountName,
      };
    }
    if (pinterestOverride.loaded) {
      return {
        ...summary,
        status: "not_connected" as const,
        connected: false,
        accountCount: 0,
        accountName: null,
        accounts: [],
      };
    }
    return summary;
  });

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
        {SOCIAL_PROVIDERS.map(provider => {
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
              checkingConnection={provider === "pinterest" && !effectivePinterestConnected && !pinterestOverride.loaded}
            />
            {showAccounts && multi.map(acct => {
              const checked = accountChecked(acct.id);
              return (
                <button
                  key={acct.id}
                  type="button"
                  role="checkbox"
                  aria-checked={checked}
                  data-testid={`publish-dest-${provider}-account-${acct.id}`}
                  onClick={() => toggleAccount(provider, acct.id)}
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
              );
            })}
            </Fragment>
          );
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
