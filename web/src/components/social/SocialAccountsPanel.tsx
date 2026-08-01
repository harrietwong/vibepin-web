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
import { useRouter, useSearchParams } from "next/navigation";
import { Check, Link as LinkIcon, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { PlatformIcon } from "@/components/social/PlatformIcon";
import { PLATFORMS, SOCIAL_PROVIDERS, type SocialProvider } from "@/lib/social/platforms";
import type { PlatformConnectionSummary } from "@/lib/social/types";
import { SETTINGS_SOCIAL_PATH } from "@/lib/settingsPaths";

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

/**
 * `?facebook=<status>` OAuth-return consumption (照 PinterestSettingsPanel /
 * ShopifyTab's `?pinterest=` / `?shopify=` pattern): read via useSearchParams,
 * toast once, then router.replace to a clean URL so a refresh never re-fires
 * the toast. Statuses mirror the redirects in
 * api/auth/facebook/{connect,callback}/route.ts.
 */
type OAuthNoticeType = "success" | "error" | "info";
const FACEBOOK_CALLBACK_MESSAGES: Record<string, { type: OAuthNoticeType; msg: string }> = {
  connected: { type: "success", msg: "Facebook connected" },
  select_page: { type: "info", msg: "Facebook connected — choose which Page to publish to." },
  reconnect_required: {
    type: "error",
    msg: "Facebook connected, but some required permissions were not granted. Please reconnect and allow all of them.",
  },
  // Authorization succeeded — Meta just didn't enumerate the Pages (it omits
  // Pages reached through a Business portfolio). Informational, never an error.
  page_discovery_empty: {
    type: "info",
    msg: "Facebook didn't list your Pages automatically. Enter your Page URL or Page ID to finish connecting.",
  },
  graph_api_error: {
    type: "error",
    msg: "Facebook returned an error while reading your Pages — please try connecting again.",
  },
  cancelled: { type: "info", msg: "Facebook connection was cancelled. You can try again when ready." },
  session_expired: { type: "error", msg: "Your session expired — please sign in and retry" },
  state_expired: { type: "error", msg: "Connection request expired — please try again" },
  state_mismatch: { type: "error", msg: "Security check failed — please try connecting again" },
  exchange_failed: { type: "error", msg: "Could not complete Facebook authorization — please try again" },
  permissions_failed: { type: "error", msg: "Facebook authorized but reading your permissions failed — try again" },
  profile_failed: { type: "error", msg: "Facebook authorized but reading your profile failed — try again" },
  discovery_failed: { type: "error", msg: "Facebook authorized but reading your accounts failed — try again" },
  persist_failed: { type: "error", msg: "Facebook authorized but saving the connection failed — try again" },
  config_error: { type: "error", msg: "Facebook is not configured on the server" },
  error: { type: "error", msg: "Facebook authorization failed" },
};

/**
 * `?instagram=<status>` OAuth-return consumption. Fully independent from the
 * `?facebook=` handling above — Instagram runs through its own dedicated
 * "Instagram Login" flow (api/auth/instagram/{connect,callback}). Statuses mirror
 * the redirects in those routes.
 */
const INSTAGRAM_CALLBACK_MESSAGES: Record<string, { type: OAuthNoticeType; msg: string }> = {
  connected: { type: "success", msg: "Instagram connected" },
  cancelled: { type: "info", msg: "Instagram connection was cancelled. You can try again when ready." },
  personal_account: {
    type: "error",
    msg: "VibePin currently supports Instagram Business and Creator accounts. Please switch to a professional account and try again.",
  },
  session_expired: { type: "error", msg: "Your session expired — please sign in and retry" },
  state_expired: { type: "error", msg: "Connection request expired — please try again" },
  state_mismatch: { type: "error", msg: "Security check failed — please try connecting again" },
  exchange_failed: { type: "error", msg: "Could not complete Instagram authorization — please try again" },
  profile_failed: { type: "error", msg: "Instagram authorized but reading your profile failed — try again" },
  persist_failed: { type: "error", msg: "Instagram authorized but saving the connection failed — try again" },
  config_error: { type: "error", msg: "Instagram is not configured on the server" },
  error: { type: "error", msg: "Instagram authorization failed" },
};

/** Human-readable labels for the required Facebook permissions (for the missing-scope hint). */
const FACEBOOK_SCOPE_LABELS: Record<string, string> = {
  pages_show_list: "See your Pages",
  pages_manage_posts: "Publish to your Page",
  pages_read_engagement: "Read Page details",
};
const REQUIRED_FACEBOOK_SCOPES_UI = [
  "pages_show_list",
  "pages_manage_posts",
  "pages_read_engagement",
] as const;

/** Client-safe shape of metadata.facebook produced by socialConnectionStore.sanitizeMetadata. */
type FacebookMeta = {
  connectionState?: string | null;
  facebookUserName?: string | null;
  selectedPageId?: string | null;
  selectedPageName?: string | null;
  candidatePages?: Array<{
    pageId?: string | null;
    pageName?: string | null;
    canPublish?: boolean | null;
  }> | null;
};

function readFacebookMeta(summary: PlatformConnectionSummary): FacebookMeta | null {
  const account = summary.accounts[0];
  const meta = account?.metadata as { facebook?: FacebookMeta } | null | undefined;
  return meta?.facebook ?? null;
}

/** Client-safe shape of metadata.instagram produced by socialConnectionStore.sanitizeMetadata. */
type InstagramMeta = {
  connectionState?: string | null;
  accountType?: string | null;
};

function readInstagramMeta(summary: PlatformConnectionSummary): InstagramMeta | null {
  const account = summary.accounts[0];
  const meta = account?.metadata as { instagram?: InstagramMeta } | null | undefined;
  return meta?.instagram ?? null;
}

/** Friendly label for an Instagram account_type (BUSINESS / MEDIA_CREATOR). */
function instagramAccountTypeLabel(accountType: string | null | undefined): string | null {
  if (accountType === "BUSINESS") return "Business account";
  if (accountType === "MEDIA_CREATOR") return "Creator account";
  return null;
}

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
  onRefresh,
}: {
  summary: PlatformConnectionSummary;
  busy: boolean;
  connecting: boolean;
  /** Whether the "Add another account" entry is enabled (advanced feature flag). */
  multiAccount: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  /** Re-fetch the connection list (used after a Facebook Page selection). */
  onRefresh: () => void;
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

      {/* Facebook Page connection detail (display only). Shown whenever there is a
          stored Facebook row, including degraded/error states, so the user sees
          exactly what is connected and what is missing. Includes the Page picker
          when several Pages await selection. */}
      {summary.provider === "facebook" && summary.accounts.length > 0 && (
        <FacebookDetails summary={summary} onRefresh={onRefresh} />
      )}

      {/* Instagram connection detail (display only). Independent of Facebook — reads
          only the Instagram row's sanitized metadata.instagram (no tokens). */}
      {summary.provider === "instagram" && summary.accounts.length > 0 && (
        <InstagramDetails summary={summary} />
      )}

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

/** Mask a Page id for display — first 4 + last 4 chars (e.g. `9656...5245`). */
function maskPageId(pageId: string): string {
  if (pageId.length <= 8) return pageId;
  return `${pageId.slice(0, 4)}...${pageId.slice(-4)}`;
}

/**
 * Facebook Page connection detail (display only + Page picker).
 *
 * Renders the connecting Facebook user, the selected Page, granted-vs-missing
 * permissions, token expiry, and a state hint. When several Pages await selection
 * it shows a picker. It NEVER shows any token — all data comes from the sanitized
 * metadata.facebook projection (page tokens are stripped server-side). Instagram
 * is fully decoupled and not rendered here.
 */
/**
 * Manual Page connect — shown when Meta authorized us but `/me/accounts` came
 * back empty (`page_discovery_empty`). That happens when the Page is owned by a
 * Business portfolio: it is unreachable via enumeration yet perfectly reachable
 * by id, so we let the user name it instead of dead-ending them.
 *
 * The server holds the user token; this form only ever sends an id/URL and only
 * ever receives display fields back. No token is read, rendered, or stored here.
 */
const CONNECT_PAGE_ERRORS: Record<string, string> = {
  FACEBOOK_PAGE_ACCESS_DENIED:
    "You don't have access to that Page with the permissions you granted. Make sure you're an admin of it, then try again.",
  FACEBOOK_PAGE_NOT_FOUND: "No Facebook Page matches that ID. Double-check the number and try again.",
  FACEBOOK_GRAPH_API_ERROR: "Facebook returned an error — please try again in a moment.",
  no_facebook_connection: "Connect Facebook first, then add your Page.",
};

function FacebookManualPageForm({ onConnected }: { onConnected: () => void }) {
  const [pageId, setPageId] = useState("");
  const [pageUrl, setPageUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const canSubmit = (pageId.trim() !== "" || pageUrl.trim() !== "") && !submitting;

  async function handleSubmit() {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/integrations/facebook/connect-page", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          pageId.trim() ? { pageId: pageId.trim() } : { pageUrl: pageUrl.trim() },
        ),
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        pageName?: string | null;
        error?: string;
        code?: string;
      };
      if (!res.ok || !body.ok) {
        // Prefer our copy for known codes; fall back to the server's message,
        // which is already stripped of anything token-shaped.
        const known = body.code ? CONNECT_PAGE_ERRORS[body.code] : undefined;
        toast.error(known ?? body.error ?? "Could not connect that Page — please try again");
        return;
      }
      toast.success(body.pageName ? `Publishing to ${body.pageName}` : "Facebook Page connected");
      setPageId("");
      setPageUrl("");
      onConnected();
    } catch {
      toast.error("Could not connect that Page — please try again");
    } finally {
      // Always restores, including on the throw path above.
      setSubmitting(false);
    }
  }

  const inputStyle: React.CSSProperties = {
    width: "100%",
    padding: "7px 9px",
    borderRadius: 7,
    border: `1px solid ${UI.border}`,
    background: UI.surface,
    color: UI.text,
    fontSize: 12,
  };

  return (
    <div data-testid="facebook-manual-page-form" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <p style={{ margin: 0, fontSize: 11.5, color: UI.textSec, lineHeight: 1.5 }}>
        Facebook didn&apos;t list your Pages automatically — this is common when the Page belongs to a
        Business portfolio. Enter the Page ID (find it under your Page&apos;s <strong>About</strong> section)
        or paste the Page URL.
      </p>
      <input
        aria-label="Facebook Page ID"
        placeholder="Page ID — e.g. 1234567890"
        value={pageId}
        onChange={e => setPageId(e.target.value)}
        disabled={submitting}
        style={inputStyle}
      />
      <input
        aria-label="Facebook Page URL"
        placeholder="or Page URL — https://www.facebook.com/…"
        value={pageUrl}
        onChange={e => setPageUrl(e.target.value)}
        disabled={submitting}
        style={inputStyle}
      />
      <button
        type="button"
        onClick={() => void handleSubmit()}
        disabled={!canSubmit}
        style={{
          alignSelf: "flex-start",
          padding: "7px 14px",
          borderRadius: 7,
          border: "none",
          background: canSubmit ? UI.blue : UI.surface2,
          color: canSubmit ? "#fff" : UI.textMuted,
          fontSize: 12,
          fontWeight: 600,
          cursor: canSubmit ? "pointer" : "not-allowed",
        }}
      >
        {submitting ? "Connecting…" : "Connect this Page"}
      </button>
    </div>
  );
}

function FacebookDetails({ summary, onRefresh }: { summary: PlatformConnectionSummary; onRefresh: () => void }) {
  const fb = readFacebookMeta(summary);
  const account = summary.accounts[0];
  const [selecting, setSelecting] = useState<string | null>(null);
  if (!fb && !account) return null;

  const grantedScopes = new Set(account?.scopes ?? []);
  const missing = REQUIRED_FACEBOOK_SCOPES_UI.filter(s => !grantedScopes.has(s));
  const state = fb?.connectionState ?? null;
  const tokenExpiresAt = account?.tokenExpiresAt ?? null;
  const expiryLabel = tokenExpiresAt
    ? new Date(tokenExpiresAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })
    : null;

  const candidatePages = fb?.candidatePages ?? [];
  const needsSelection = state === "page_selection_required" && candidatePages.length > 1;

  const rows: Array<{ label: string; value: string }> = [];
  if (fb?.facebookUserName) rows.push({ label: "Facebook", value: fb.facebookUserName });
  if (fb?.selectedPageName) rows.push({ label: "Page", value: fb.selectedPageName });
  if (expiryLabel) rows.push({ label: "Access expires", value: expiryLabel });

  async function handleSelectPage(pageId: string) {
    setSelecting(pageId);
    try {
      const res = await fetch("/api/integrations/facebook/select-page", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pageId }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; pageName?: string | null; error?: string };
      if (!res.ok || !body.ok) {
        toast.error(body.error || "Could not select that Page — please try again");
        return;
      }
      toast.success(body.pageName ? `Publishing to ${body.pageName}` : "Facebook Page selected");
      onRefresh();
    } catch {
      toast.error("Could not select that Page — please try again");
    } finally {
      setSelecting(null);
    }
  }

  return (
    <div
      data-testid="facebook-connection-detail"
      style={{
        marginTop: 14,
        padding: "12px 14px",
        borderRadius: 10,
        background: UI.surface2,
        border: `1px solid ${UI.border}`,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      {rows.map(r => (
        <div key={r.label} style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 12 }}>
          <span style={{ color: UI.textSec }}>{r.label}</span>
          <span style={{ color: UI.text, fontWeight: 600, textAlign: "right", minWidth: 0, wordBreak: "break-word" }}>
            {r.value}
          </span>
        </div>
      ))}

      {state === "page_discovery_empty" && (
        <FacebookManualPageForm onConnected={onRefresh} />
      )}

      {(state === "reconnect_required" || missing.length > 0) && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <p style={{ margin: 0, fontSize: 11.5, color: UI.warning, lineHeight: 1.5 }}>
            Missing required permissions — reconnect and allow all of them:
          </p>
          <ul style={{ margin: 0, paddingLeft: 16 }}>
            {missing.map(s => (
              <li key={s} style={{ fontSize: 11.5, color: UI.textSec }}>
                {FACEBOOK_SCOPE_LABELS[s] ?? s}
              </li>
            ))}
          </ul>
        </div>
      )}

      {needsSelection && (
        <div data-testid="facebook-page-selector" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <p style={{ margin: 0, fontSize: 11.5, color: UI.blue, lineHeight: 1.5 }}>
            Choose which Page to publish to:
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {candidatePages.map(p => {
              const pageId = typeof p.pageId === "string" ? p.pageId : "";
              const busySelecting = selecting === pageId;
              const disabled = !pageId || selecting !== null;
              return (
                <button
                  key={pageId || (p.pageName ?? "page")}
                  type="button"
                  data-testid={`facebook-select-page-${pageId}`}
                  onClick={() => pageId && void handleSelectPage(pageId)}
                  disabled={disabled}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 10,
                    padding: "9px 12px",
                    borderRadius: 9,
                    border: `1px solid ${UI.border}`,
                    background: "transparent",
                    color: UI.text,
                    fontSize: 12,
                    fontWeight: 600,
                    textAlign: "left",
                    cursor: disabled ? "not-allowed" : "pointer",
                    opacity: disabled && !busySelecting ? 0.6 : 1,
                  }}
                >
                  <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                    <span style={{ wordBreak: "break-word" }}>{p.pageName || "Untitled Page"}</span>
                    <span style={{ fontSize: 10.5, color: UI.textSec, fontWeight: 500 }}>
                      {pageId ? maskPageId(pageId) : ""}
                      {p.canPublish === false ? " · can't publish" : ""}
                    </span>
                  </span>
                  {busySelecting
                    ? <Loader2 size={13} className="animate-spin" style={{ color: UI.textSec, flexShrink: 0 }} />
                    : <Check size={13} style={{ color: UI.textMuted, flexShrink: 0 }} />}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Instagram connection detail (display only).
 *
 * Renders the connected @username, account type (Business / Creator), and token
 * expiry. It reads ONLY the Instagram row's sanitized metadata.instagram + account
 * fields — never any Facebook data — so the two platform cards are fully
 * independent. There is no Page picker and no token is ever shown (Instagram stores
 * no token in metadata).
 */
function InstagramDetails({ summary }: { summary: PlatformConnectionSummary }) {
  const ig = readInstagramMeta(summary);
  const account = summary.accounts[0];
  if (!ig && !account) return null;

  const username = account?.providerAccountUsername ?? null;
  const typeLabel = instagramAccountTypeLabel(ig?.accountType);
  const tokenExpiresAt = account?.tokenExpiresAt ?? null;
  const expiryLabel = tokenExpiresAt
    ? new Date(tokenExpiresAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })
    : null;

  const rows: Array<{ label: string; value: string }> = [];
  if (username) rows.push({ label: "Instagram", value: `@${username}` });
  if (typeLabel) rows.push({ label: "Account", value: typeLabel });
  if (expiryLabel) rows.push({ label: "Access expires", value: expiryLabel });

  if (rows.length === 0) return null;

  return (
    <div
      data-testid="instagram-connection-detail"
      style={{
        marginTop: 14,
        padding: "12px 14px",
        borderRadius: 10,
        background: UI.surface2,
        border: `1px solid ${UI.border}`,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      {rows.map(r => (
        <div key={r.label} style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 12 }}>
          <span style={{ color: UI.textSec }}>{r.label}</span>
          <span style={{ color: UI.text, fontWeight: 600, textAlign: "right", minWidth: 0, wordBreak: "break-word" }}>
            {r.value}
          </span>
        </div>
      ))}
    </div>
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
  const params = useSearchParams();
  const router = useRouter();
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

  // `?facebook=<status>` OAuth-return consumption (see FACEBOOK_CALLBACK_MESSAGES
  // above) — mirrors PinterestSettingsPanel / ShopifyTab: toast once, clear the
  // query param via router.replace so a refresh never re-fires it, then refresh
  // the connection list on success so the card flips to "connected" immediately.
  useEffect(() => {
    const flag = params.get("facebook");
    if (!flag) return;
    const m = FACEBOOK_CALLBACK_MESSAGES[flag];
    if (m) {
      const notify = m.type === "success" ? toast.success : m.type === "error" ? toast.error : toast.info;
      notify(m.msg);
    }
    router.replace(SETTINGS_SOCIAL_PATH);
    // Refresh on both a completed connection and a pending Page choice so the card
    // flips to "connected" (or shows the Page picker) immediately.
    if (flag === "connected" || flag === "select_page") void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  // `?instagram=<status>` OAuth-return consumption — fully independent of the
  // `?facebook=` handler above (its own dedicated Instagram Login flow). Toast once,
  // clear the query param, and refresh the list on success so the Instagram card
  // flips to "connected" immediately without touching the Facebook card.
  useEffect(() => {
    const flag = params.get("instagram");
    if (!flag) return;
    const m = INSTAGRAM_CALLBACK_MESSAGES[flag];
    if (m) {
      const notify = m.type === "success" ? toast.success : m.type === "error" ? toast.error : toast.info;
      notify(m.msg);
    }
    router.replace(SETTINGS_SOCIAL_PATH);
    if (flag === "connected") void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

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
              onRefresh={() => void load()}
            />
          );
        })}
    </div>
  );
}
