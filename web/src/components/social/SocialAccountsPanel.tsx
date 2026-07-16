"use client";

/**
 * Settings → Social accounts.
 *
 * A unified connected-accounts surface for every platform VibePin can publish
 * approved content to (Pinterest, Instagram, Facebook Page, TikTok). One card
 * per platform, consistent with the existing Settings design system.
 *
 * States handled per card: not connected · connected · expired (reconnect) ·
 * error · setup pending (no live connect path yet).
 *
 * Pinterest keeps its dedicated, tested OAuth + disconnect flow; the other
 * platforms are structurally ready and show a clear "setup pending" state.
 */

import { useCallback, useEffect, useState } from "react";
import { Check, Link as LinkIcon, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { PlatformIcon } from "@/components/social/PlatformIcon";
import { PLATFORMS, SOCIAL_PROVIDERS, type SocialProvider } from "@/lib/social/platforms";
import type { PlatformConnectionSummary } from "@/lib/social/types";

/** All-not-connected fallback so a failed fetch still shows the platform grid. */
function notConnectedSummaries(): PlatformConnectionSummary[] {
  return SOCIAL_PROVIDERS.map(provider => ({
    provider,
    status: "not_connected",
    connected: false,
    accountCount: 0,
    accountName: null,
    liveConnect: PLATFORMS[provider].liveConnect,
    accounts: [],
  }));
}
import {
  disconnectSocial,
  fetchSocialConnections,
  startSocialConnect,
} from "@/lib/social/socialClient";
import { startPinterestConnect, disconnectPinterest } from "@/lib/pinterestClient";
import { isMultiSocialAccountsEnabled } from "@/lib/socialFeatureFlags";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import type { MessageKey } from "@/lib/i18n/messages/en";

const UI = {
  surface: "var(--app-surface, #161D2E)",
  surface2: "var(--app-surface-2, #1A2235)",
  border: "var(--app-border, rgba(255,255,255,0.10))",
  text: "var(--app-text, #E2E8F0)",
  textSec: "var(--app-text-sec, #8892A4)",
  textMuted: "#5B6577",
  success: "#10B981",
  warning: "#F59E0B",
  error: "#EF4444",
  blue: "#93C5FD",
  gradient: "linear-gradient(135deg,#FF4D8D 0%,#D946EF 52%,#7C3AED 100%)",
};

type StatusChip = { label: string; color: string; bg: string; border: string };

function statusChip(summary: PlatformConnectionSummary, tr: (key: MessageKey) => string): StatusChip {
  switch (summary.status) {
    case "connected":
      return {
        label: tr("publishDestinations.connected"),
        color: UI.success,
        bg: "rgba(16,185,129,0.12)",
        border: "rgba(16,185,129,0.3)",
      };
    case "expired":
      return {
        label: tr("socialPanel.status.reconnectNeeded"),
        color: UI.warning,
        bg: "rgba(245,158,11,0.12)",
        border: "rgba(245,158,11,0.35)",
      };
    case "revoked":
      return {
        label: tr("socialPanel.status.disconnected"),
        color: UI.warning,
        bg: "rgba(245,158,11,0.12)",
        border: "rgba(245,158,11,0.35)",
      };
    case "error":
      return {
        label: tr("socialPanel.status.connectionError"),
        color: UI.error,
        bg: "rgba(239,68,68,0.12)",
        border: "rgba(239,68,68,0.3)",
      };
    default:
      return {
        label: summary.liveConnect ? tr("publishDestinations.notConnected") : tr("socialPanel.status.setupPending"),
        color: UI.textSec,
        bg: "rgba(255,255,255,0.05)",
        border: UI.border,
      };
  }
}

function Chip({ chip }: { chip: StatusChip }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "4px 10px",
        borderRadius: 20,
        fontSize: 11,
        fontWeight: 700,
        color: chip.color,
        background: chip.bg,
        border: `1px solid ${chip.border}`,
        whiteSpace: "nowrap",
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: chip.color }} />
      {chip.label}
    </span>
  );
}

function PlatformCard({
  summary,
  busy,
  connecting,
  multiAccount,
  onConnect,
  onDisconnect,
}: {
  summary: PlatformConnectionSummary;
  busy: boolean;
  connecting: boolean;
  /** Whether the "Add another account" entry is enabled (advanced feature flag). */
  multiAccount: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  const { t: tr } = useLocale();
  const meta = PLATFORMS[summary.provider];
  const chip = statusChip(summary, tr);
  const connected = summary.connected;
  // A degraded connection (token invalid) is the ONLY case that shows Reconnect.
  const degraded = summary.status === "expired" || summary.status === "revoked" || summary.status === "error";
  // Healthy = a usable connection with no token problem → Disconnect only.
  const healthy = connected && summary.status === "connected";

  return (
    <section
      data-testid={`social-card-${summary.provider}`}
      style={{
        background: UI.surface,
        border: `1px solid ${connected ? "rgba(16,185,129,0.22)" : UI.border}`,
        borderRadius: 14,
        padding: "16px 16px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <PlatformIcon provider={summary.provider} size={38} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: UI.text }}>{meta.name}</p>
            <Chip chip={chip} />
          </div>
          <p style={{ margin: "3px 0 0", fontSize: 12, color: UI.textSec }}>
            {connected
              ? summary.accountName
                ? `${summary.accountName}${summary.accountCount > 1 ? ` · ${summary.accountCount}${tr("socialPanel.card.accountsCountSuffix")}` : ""}`
                : tr("socialPanel.card.accountConnected")
              : meta.liveConnect
                ? tr("socialPanel.card.connectToPublish")
                : tr("socialPanel.card.setupPendingComingSoon")}
          </p>
        </div>
      </div>

      {/* Capabilities (only when not connected, mirrors the Pinterest empty state) */}
      {!connected && (
        <ul
          style={{
            margin: "14px 0 0",
            padding: 0,
            listStyle: "none",
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 6,
          }}
        >
          {meta.capabilities.map(cap => (
            <li
              key={cap}
              style={{ fontSize: 11.5, color: UI.textSec, display: "flex", alignItems: "center", gap: 6 }}
            >
              <Check size={11} style={{ color: UI.textMuted, flexShrink: 0 }} />
              {cap}
            </li>
          ))}
        </ul>
      )}

      <div style={{ marginTop: 16, display: "flex", flexWrap: "wrap", gap: 8 }}>
        {healthy ? (
          // Connected & healthy → Disconnect only (+ optional Add-another behind flag).
          <>
            <DisconnectButton provider={summary.provider} busy={busy} onClick={onDisconnect} />
            {multiAccount && meta.liveConnect && (
              <button
                type="button"
                data-testid={`social-add-account-${summary.provider}`}
                onClick={onConnect}
                disabled={busy || connecting}
                style={{
                  display: "inline-flex", alignItems: "center", gap: 6,
                  padding: "8px 14px", borderRadius: 10,
                  border: `1px solid ${UI.border}`, background: "transparent", color: UI.textSec,
                  fontSize: 12, fontWeight: 700,
                  cursor: (busy || connecting) ? "not-allowed" : "pointer", opacity: (busy || connecting) ? 0.6 : 1,
                }}
              >
                <Plus size={13} /> {tr("socialPanel.action.addAnotherAccountPrefix")}{meta.name}{tr("socialPanel.action.addAnotherAccountSuffix")}
              </button>
            )}
          </>
        ) : degraded ? (
          // Token invalid (expired / revoked / error) → Reconnect + Disconnect.
          <>
            <button
              type="button"
              data-testid={`social-reconnect-${summary.provider}`}
              onClick={onConnect}
              disabled={busy || connecting}
              style={{
                display: "inline-flex", alignItems: "center", gap: 6,
                padding: "8px 14px", borderRadius: 10,
                border: "1px solid rgba(245,158,11,0.45)", background: "rgba(245,158,11,0.12)", color: UI.warning,
                fontSize: 12, fontWeight: 700,
                cursor: (busy || connecting) ? "not-allowed" : "pointer", opacity: (busy || connecting) ? 0.6 : 1,
              }}
            >
              {connecting ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
              {connecting
                ? `${tr("socialPanel.action.redirectingToPrefix")}${meta.name}${tr("socialPanel.action.redirectingToSuffix")}`
                : `${tr("socialPanel.action.reconnectPrefix")}${meta.name}`}
            </button>
            <DisconnectButton provider={summary.provider} busy={busy} onClick={onDisconnect} />
          </>
        ) : (
          // Not connected → Connect (live) or Coming soon (setup pending). No Disconnect.
          <button
            type="button"
            data-testid={`social-connect-${summary.provider}`}
            onClick={onConnect}
            disabled={busy || !meta.liveConnect}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 7,
              padding: "9px 16px",
              borderRadius: 10,
              border: "none",
              background: meta.liveConnect ? UI.gradient : UI.surface2,
              color: meta.liveConnect ? "#fff" : UI.textSec,
              fontSize: 12,
              fontWeight: 700,
              cursor: (busy || !meta.liveConnect) ? "not-allowed" : "pointer",
              opacity: busy ? 0.7 : 1,
              boxShadow: meta.liveConnect ? undefined : `inset 0 0 0 1px ${UI.border}`,
            }}
          >
            {busy ? <Loader2 size={13} className="animate-spin" /> : <LinkIcon size={13} />}
            {connecting
              ? `${tr("socialPanel.action.redirectingToPrefix")}${meta.name}${tr("socialPanel.action.redirectingToSuffix")}`
              : meta.liveConnect
                ? tr("socialPanel.action.connect")
                : tr("publishDestinations.comingSoon")}
          </button>
        )}
      </div>
    </section>
  );
}

/** Shared destructive Disconnect button used in both healthy and degraded states. */
function DisconnectButton({ provider, busy, onClick }: { provider: SocialProvider; busy: boolean; onClick: () => void }) {
  const { t: tr } = useLocale();
  return (
    <button
      type="button"
      data-testid={`social-disconnect-${provider}`}
      onClick={onClick}
      disabled={busy}
      style={{
        display: "inline-flex", alignItems: "center", gap: 6,
        padding: "8px 14px", borderRadius: 10,
        border: "1px solid rgba(239,68,68,0.4)", background: "transparent", color: "#F87171",
        fontSize: 12, fontWeight: 700,
        cursor: busy ? "not-allowed" : "pointer", opacity: busy ? 0.6 : 1,
      }}
    >
      {busy ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
      {tr("socialPanel.action.disconnectPrefix")}{PLATFORMS[provider].name}
    </button>
  );
}

export function SocialAccountsPanel() {
  const { t: tr } = useLocale();
  const [summaries, setSummaries] = useState<PlatformConnectionSummary[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [busyProvider, setBusyProvider] = useState<SocialProvider | null>(null);
  /** Only set while a connect click is redirecting the browser away — drives the button label. */
  const [connectingProvider, setConnectingProvider] = useState<SocialProvider | null>(null);
  // Forward-looking "Add another account" entry — off unless the workspace opts in.
  const multiAccountEnabled = isMultiSocialAccountsEnabled();

  const load = useCallback(async () => {
    setLoadError(false);
    try {
      const { platforms } = await fetchSocialConnections();
      setSummaries(platforms);
    } catch {
      setSummaries(null);
      setLoadError(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleConnect(provider: SocialProvider) {
    setBusyProvider(provider);
    setConnectingProvider(provider);
    try {
      if (provider === "pinterest") {
        const result = await startPinterestConnect();
        if (!result.ok) toast.error(result.message);
        return; // navigates away on success
      }
      const result = await startSocialConnect(provider);
      if (result.status === "oauth_url" && result.url) {
        window.location.assign(result.url);
        return;
      }
      toast.info(result.message || `${PLATFORMS[provider].name}${tr("socialPanel.toast.connectionComingSoonSuffix")}`);
    } catch (e) {
      toast.error((e as Error).message || tr("socialPanel.toast.couldNotStartConnection"));
    } finally {
      setBusyProvider(null);
      setConnectingProvider(null);
    }
  }

  async function handleDisconnect(summary: PlatformConnectionSummary) {
    const provider = summary.provider;
    setBusyProvider(provider);
    try {
      if (provider === "pinterest") {
        // Optimistic: the server round trip (bearer verification + DB update) can take
        // seconds on a slow network — flip the row immediately, settle in background,
        // and reconcile from the server either way (load() restores the truth on failure).
        setSummaries(prev => prev?.map(s => (s.provider === "pinterest"
          ? { ...s, status: "not_connected" as const, connected: false, accountCount: 0, accountName: null, accounts: [] }
          : s)) ?? prev);
        toast.success(tr("socialPanel.toast.pinterestDisconnected"));
        disconnectPinterest()
          .catch(() => { toast.error(tr("socialPanel.toast.pinterestDisconnectFailed")); })
          .finally(() => { void load(); });
        return;
      } else {
        const primary = summary.accounts[0];
        if (!primary) return;
        const res = await disconnectSocial(primary.id);
        if (res.usePinterestFlow) {
          await disconnectPinterest();
        }
        toast.success(`${PLATFORMS[provider].name}${tr("socialPanel.toast.disconnectedSuffix")}`);
      }
      await load();
    } catch (e) {
      toast.error((e as Error).message || tr("socialPanel.toast.couldNotDisconnect"));
    } finally {
      setBusyProvider(null);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div>
        <h2 style={{ margin: "0 0 4px", fontSize: 15, fontWeight: 800, color: UI.text }}>{tr("socialPanel.title")}</h2>
        <p style={{ margin: 0, fontSize: 12, color: UI.textSec, lineHeight: 1.5 }}>
          {tr("socialPanel.description")}
        </p>
      </div>

      {loadError && (
        <div
          data-testid="social-load-error"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 10,
            padding: "10px 12px",
            borderRadius: 10,
            background: "rgba(245,158,11,0.10)",
            border: "1px solid rgba(245,158,11,0.28)",
          }}
        >
          <p style={{ margin: 0, fontSize: 12, color: UI.warning, lineHeight: 1.5 }}>
            {tr("socialPanel.loadError")}
          </p>
          <button
            type="button"
            onClick={() => void load()}
            style={{
              flexShrink: 0,
              padding: "6px 12px",
              borderRadius: 9,
              border: `1px solid ${UI.border}`,
              background: "transparent",
              color: UI.text,
              fontSize: 11,
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            {tr("publishDestinations.tryAgain")}
          </button>
        </div>
      )}

      {summaries === null && !loadError && (
        <div
          data-testid="social-loading"
          style={{
            padding: 40,
            textAlign: "center",
            fontSize: 13,
            color: UI.textSec,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
          }}
        >
          <Loader2 size={16} className="animate-spin" /> {tr("socialPanel.loading")}
        </div>
      )}

      {(summaries !== null || loadError) &&
        SOCIAL_PROVIDERS.map(provider => {
          const summary =
            (summaries ?? notConnectedSummaries()).find(s => s.provider === provider);
          if (!summary) return null;
          return (
            <PlatformCard
              key={provider}
              summary={summary}
              busy={busyProvider === provider}
              connecting={connectingProvider === provider}
              multiAccount={multiAccountEnabled}
              onConnect={() => void handleConnect(provider)}
              onDisconnect={() => void handleDisconnect(summary)}
            />
          );
        })}
    </div>
  );
}
