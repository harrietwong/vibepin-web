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
import type { PlatformConnectionSummary, SocialConnection } from "@/lib/social/types";
import { SETTINGS_SOCIAL_PATH } from "@/lib/settingsPaths";

/** The plan the panel needs to know about — only "is it paid?" changes the UI. */
type SocialPlanKey = "free" | "starter" | "pro" | "business";

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
import {
  startPinterestConnect,
  disconnectPinterest,
  syncPinterestAccount,
  getScheduledCountForConnection,
} from "@/lib/pinterestClient";
import {
  accountUiState,
  ACCOUNT_UI_STATE_LABEL_KEY,
  ACCOUNT_UI_STATE_DESCRIPTION_KEY,
  ACCOUNT_UI_STATE_TONE,
  type AccountUiState,
} from "@/lib/social/accountUiState";
import {
  SOCIAL_CONNECTIONS_CHANGED_EVENT,
  notifyConnectionsChanged,
} from "@/lib/social/connectionsCache";
import { accountDisplayLabel } from "@/lib/social/accountIdentity";
import { EXTRA_ACCOUNT_PRICE_USD } from "@/lib/pricingPlans";
import {
  BillingDisabledError,
  BillingRefusedError,
  startExtraAccountCheckout,
} from "@/lib/billing/creemCheckoutClient";
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
  // Reconnect auto-restore: the previously selected Page was re-verified with the
  // fresh token — fully connected again with zero typing.
  reconnected: { type: "success", msg: "Facebook Page reconnected successfully." },
  // Auto-restore ran but the saved Page failed verification with the new token.
  // The saved id is preserved server-side; the manual form takes over.
  page_reconnect_verification_failed: {
    type: "info",
    msg: "We couldn't automatically reconnect your previous Page. Enter a Page ID to continue.",
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

/**
 * `?pinterest=<status>` OAuth-return consumption. Moved here from the retired
 * PinterestSettingsPanel when Pinterest joined Social accounts (PRD §2): the
 * callback redirects to this page now, and a historical redirect to
 * /app/settings/pinterest is forwarded here with its query intact by that route's
 * redirect stub — so an authorization outcome is never silently dropped.
 * Statuses mirror the redirects in api/auth/pinterest/{connect,callback}/route.ts.
 */
const PINTEREST_CALLBACK_MESSAGES: Record<string, { type: OAuthNoticeType; msg: string }> = {
  connected: { type: "success", msg: "Pinterest connected" },
  // The user backed out of the Pinterest authorization — not an error.
  cancelled: { type: "info", msg: "Pinterest connection was cancelled. You can try again when ready." },
  denied: { type: "info", msg: "Pinterest connection was cancelled. You can try again when ready." },
  state_mismatch: { type: "error", msg: "Security check failed — please try connecting again" },
  state_expired: { type: "error", msg: "Connection request expired — please try again" },
  session_expired: { type: "error", msg: "Your session expired — please sign in and retry" },
  missing_code: { type: "error", msg: "Pinterest did not return an authorization code" },
  exchange_failed: { type: "error", msg: "Could not complete Pinterest authorization — please try again" },
  persist_failed: { type: "error", msg: "Pinterest authorized but saving the connection failed — try again" },
  config_error: { type: "error", msg: "Pinterest is not configured on the server" },
  error: { type: "error", msg: "Pinterest authorization failed" },
};

/**
 * Whether a platform's "Add another account" entry is offered.
 *
 * Pinterest is on unconditionally as of v59: the storage now keys a connection by
 * (user, provider, account), and the callback refuses to overwrite one account with
 * another — so adding a second account creates a second row instead of silently
 * replacing the first. That was the entire reason the entry was hidden behind a flag.
 *
 * Every other platform still stores at most one row per user, so their entry stays
 * behind NEXT_PUBLIC_ENABLE_MULTI_SOCIAL_ACCOUNTS until their storage is unified too;
 * showing it earlier would offer an action that quietly overwrites the connection
 * the merchant already has.
 */
function isMultiAccountAllowed(provider: SocialProvider, flagEnabled: boolean): boolean {
  // Facebook and Instagram joined Pinterest: each stores one row per connected
  // account, publishes to a named account, and can drop one without signing the
  // others out. Platforms still on one-row-per-user stay behind the flag, where
  // the entry would quietly overwrite the connection the merchant already has.
  if (provider === "pinterest" || provider === "facebook" || provider === "instagram") return true;
  return flagEnabled;
}

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

/** Chip palette per tone (PRD §5): amber = something to do, grey = simply off, green = fine. */
const TONE_STYLES: Record<"green" | "amber" | "grey", Omit<StatusChip, "label">> = {
  green: { color: UI.success, bg: "rgba(16,185,129,0.12)", border: "rgba(16,185,129,0.3)" },
  amber: { color: UI.warning, bg: "rgba(245,158,11,0.12)", border: "rgba(245,158,11,0.35)" },
  grey: { color: UI.textSec, bg: "rgba(255,255,255,0.05)", border: UI.border },
};

/**
 * Customer-visible state for a platform that HAS an account, or null for an empty
 * platform slot. The four account states describe an account; a platform nobody has
 * connected yet is not an account, so it keeps the plain "Not connected" /
 * "Setup pending" affordance instead of being mislabelled "Disconnected".
 */
function platformAccountState(summary: PlatformConnectionSummary): AccountUiState | null {
  if (summary.accounts.length === 0) return null;
  const primary =
    summary.accounts.find(a => a.connectionStatus === "connected") ?? summary.accounts[0];
  return accountUiState({
    connectionStatus: primary.connectionStatus,
    scopes: primary.scopes,
    // Scope completeness is only knowable (and only required) for Pinterest today.
    enforcePinterestScopes: summary.provider === "pinterest",
  });
}

function statusChip(summary: PlatformConnectionSummary, tr: (key: MessageKey) => string): StatusChip {
  const state = platformAccountState(summary);
  if (state) {
    return { label: tr(ACCOUNT_UI_STATE_LABEL_KEY[state]), ...TONE_STYLES[ACCOUNT_UI_STATE_TONE[state]] };
  }
  return {
    label: summary.liveConnect ? tr("publishDestinations.notConnected") : tr("socialPanel.status.setupPending"),
    ...TONE_STYLES.grey,
  };
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
  onReconnect,
  onDisconnect,
  onRemoveAccount,
  busyAccountId,
  onRefresh,
}: {
  summary: PlatformConnectionSummary;
  busy: boolean;
  connecting: boolean;
  /** Whether the "Add another account" entry is enabled (advanced feature flag). */
  multiAccount: boolean;
  /** Connect a first account, or ADD another one — never targets an existing row. */
  onConnect: () => void;
  /**
   * Repair one existing connection. Separate from onConnect because the server has
   * to treat them differently: a reconnect that comes back as a different account is
   * refused (PRD §10), while an add is exactly how you connect a different account.
   */
  onReconnect: (connectionId: string | null) => void;
  onDisconnect: () => void;
  /** Remove ONE account (only reachable when the platform holds more than one). */
  onRemoveAccount: (account: SocialConnection) => void;
  /** The account row currently mid-Remove, if any. */
  busyAccountId: string | null;
  /** Re-fetch the connection list (used after a Facebook Page selection). */
  onRefresh: () => void;
}) {
  const { t: tr } = useLocale();
  const meta = PLATFORMS[summary.provider];
  const chip = statusChip(summary, tr);
  const connected = summary.connected;
  // With several accounts on one platform there is no single platform-level status to
  // show: each account row carries its own (PRD 0809 §2). A unified "Connected" chip up
  // here would be a claim about all of them, and would read as healthy while one account
  // silently needed a reconnect. The header then only counts them.
  const hasSeveralAccounts = summary.accountCount > 1;
  // ONE customer-visible state per account (PRD §6) — null for an empty platform slot.
  const accountState = platformAccountState(summary);
  // A degraded connection is the ONLY case that shows Reconnect. Derived from the
  // same single state as the chip, so the badge and the buttons can never disagree.
  const degraded = accountState === "needs_reconnect" || accountState === "needs_attention" || accountState === "disconnected";
  // Healthy = a usable connection with no problem → Disconnect only.
  const healthy = connected && accountState === "connected";

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
            <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: UI.text }}>
              {hasSeveralAccounts ? `${meta.name} · ${summary.accountCount}${tr("socialPanel.card.accountsCountSuffix")}` : meta.name}
            </p>
            {!hasSeveralAccounts && <Chip chip={chip} />}
          </div>
          <p style={{ margin: "3px 0 0", fontSize: 12, color: UI.textSec }}>
            {connected
              ? hasSeveralAccounts
                ? tr("socialPanel.card.eachAccountBelow")
                : summary.accountName
                  ? summary.accountName
                  : tr("socialPanel.card.accountConnected")
              : meta.liveConnect
                ? tr("socialPanel.card.connectToPublish")
                : tr("socialPanel.card.setupPendingComingSoon")}
          </p>
          {/* One plain-language explanation for the one state — never a stack of
              technical reasons (PRD §5/§7). Suppressed for the healthy case, where
              the green "Connected" chip already says everything. */}
          {accountState && accountState !== "connected" && (
            <p
              data-testid={`social-account-state-${summary.provider}`}
              data-account-state={accountState}
              style={{ margin: "4px 0 0", fontSize: 11.5, color: UI.textSec, lineHeight: 1.5 }}
            >
              {tr(ACCOUNT_UI_STATE_DESCRIPTION_KEY[accountState])}
            </p>
          )}
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

      {/* Per-account rows + their own Remove. Renders only above one account, where
          the platform-level Disconnect stops being able to express "remove this one". */}
      <AccountRows summary={summary} busyAccountId={busyAccountId} onRemoveAccount={onRemoveAccount} />

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
              // Names the row being repaired so the callback can require that the
              // account coming back is that same account.
              onClick={() => onReconnect(summary.accounts[0]?.id ?? null)}
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
      // Tell every other mounted surface (the publish drawer's destination rows)
      // that this platform just became connected.
      notifyConnectionsChanged();
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

/**
 * PRD §10: the reconnect that landed on the wrong Pinterest account.
 *
 * Nothing was written — the original connection is untouched and still publishing to
 * the account it always did. The user is offered the two things they could actually
 * have meant, named by account so the choice is unambiguous, and neither option is
 * pre-taken for them. Dismissing changes nothing either way.
 */
function AccountMismatchNotice({
  expected,
  got,
  busy,
  onSignInToOriginal,
  onAddAsNew,
  onDismiss,
}: {
  expected: string | null;
  got: string | null;
  busy: boolean;
  onSignInToOriginal: () => void;
  onAddAsNew: () => void;
  onDismiss: () => void;
}) {
  const { t: tr } = useLocale();
  // Usernames come from Pinterest and may be absent (a connection whose profile
  // never synced). Fall back to a neutral phrase rather than printing "@null".
  const expectedLabel = expected ? `@${expected}` : tr("socialPanel.mismatch.theOriginalAccount");
  const gotLabel = got ? `@${got}` : tr("socialPanel.mismatch.aDifferentAccount");

  return (
    <div
      data-testid="pinterest-account-mismatch"
      role="alert"
      style={{
        padding: "12px 14px",
        borderRadius: 12,
        background: "rgba(245,158,11,0.10)",
        border: "1px solid rgba(245,158,11,0.30)",
      }}
    >
      <p style={{ margin: 0, fontSize: 12.5, fontWeight: 700, color: UI.warning }}>
        {tr("socialPanel.mismatch.title")}
      </p>
      <p style={{ margin: "5px 0 0", fontSize: 12, color: UI.textSec, lineHeight: 1.55 }}>
        {tr("socialPanel.mismatch.bodyPrefix")}{gotLabel}{tr("socialPanel.mismatch.bodyMiddle")}{expectedLabel}
        {tr("socialPanel.mismatch.bodySuffix")}
      </p>
      <div style={{ marginTop: 11, display: "flex", flexWrap: "wrap", gap: 8 }}>
        <button
          type="button"
          data-testid="pinterest-mismatch-signin-original"
          onClick={onSignInToOriginal}
          disabled={busy}
          style={{
            display: "inline-flex", alignItems: "center", gap: 6,
            padding: "8px 14px", borderRadius: 10,
            border: "1px solid rgba(245,158,11,0.45)", background: "rgba(245,158,11,0.14)",
            color: UI.warning, fontSize: 12, fontWeight: 700,
            cursor: busy ? "not-allowed" : "pointer", opacity: busy ? 0.6 : 1,
          }}
        >
          <RefreshCw size={13} /> {tr("socialPanel.mismatch.signInPrefix")}{expectedLabel}
        </button>
        <button
          type="button"
          data-testid="pinterest-mismatch-add-new"
          onClick={onAddAsNew}
          disabled={busy}
          style={{
            display: "inline-flex", alignItems: "center", gap: 6,
            padding: "8px 14px", borderRadius: 10,
            border: `1px solid ${UI.border}`, background: "transparent",
            color: UI.textSec, fontSize: 12, fontWeight: 700,
            cursor: busy ? "not-allowed" : "pointer", opacity: busy ? 0.6 : 1,
          }}
        >
          <Plus size={13} /> {tr("socialPanel.mismatch.addPrefix")}{gotLabel}{tr("socialPanel.mismatch.addSuffix")}
        </button>
        <button
          type="button"
          data-testid="pinterest-mismatch-dismiss"
          onClick={onDismiss}
          style={{
            padding: "8px 12px", borderRadius: 10,
            border: "1px solid transparent", background: "transparent",
            color: UI.textMuted, fontSize: 12, fontWeight: 600, cursor: "pointer",
          }}
        >
          {tr("socialPanel.mismatch.dismiss")}
        </button>
      </div>
    </div>
  );
}

/**
 * PRD §9.2 / §18: the connect attempt refused because the plan's account limit is
 * already used up.
 *
 * A banner rather than a toast, for the same reason as the mismatch notice: nothing
 * was written, and the user has a real choice to make (upgrade, buy one more
 * account, or remove an account they no longer publish to). A toast would vanish
 * before any of them is actionable.
 *
 * Two different situations wear the same banner:
 *   free  → the only way up is a plan. One CTA: Upgrade.
 *   paid  → their plan's included accounts are spent, and buying a single extra
 *           account slot ($X/month, usable on ANY platform) is cheaper and more
 *           precise than jumping a whole tier. Second CTA: Add another account.
 * The plan comes from /api/social/connections, resolved server-side by the same
 * resolver the connect gate uses, so we never offer a purchase the server refuses.
 */
function AccountLimitNotice({
  plan,
  onDismiss,
}: {
  plan: SocialPlanKey;
  onDismiss: () => void;
}) {
  const { t: tr } = useLocale();
  const [checkoutBusy, setCheckoutBusy] = useState(false);
  const canBuySlot = plan !== "free";

  async function handleAddAccount() {
    setCheckoutBusy(true);
    try {
      const url = await startExtraAccountCheckout(1, "month");
      window.location.assign(url);
      // Navigation follows — keep the button busy until the page unloads.
    } catch (err) {
      setCheckoutBusy(false);
      if (err instanceof BillingDisabledError) {
        toast.info(tr("socialPanel.limit.addSlotUnavailable"));
      } else if (err instanceof BillingRefusedError) {
        // Server-authored, customer-readable: it knows exactly why it refused.
        toast.error(err.userMessage);
      } else {
        toast.error(tr("socialPanel.limit.addSlotFailed"));
      }
    }
  }

  return (
    <div
      data-testid="pinterest-account-limit"
      role="alert"
      style={{
        padding: "12px 14px",
        borderRadius: 12,
        background: "rgba(245,158,11,0.10)",
        border: "1px solid rgba(245,158,11,0.30)",
      }}
    >
      <p style={{ margin: 0, fontSize: 12.5, fontWeight: 700, color: UI.warning }}>
        {tr("socialPanel.limit.title")}
      </p>
      <p style={{ margin: "5px 0 0", fontSize: 12, color: UI.textSec, lineHeight: 1.55 }}>
        {canBuySlot ? tr("socialPanel.limit.bodyPaid") : tr("socialPanel.limit.body")}
      </p>
      <div style={{ marginTop: 11, display: "flex", flexWrap: "wrap", gap: 8 }}>
        <a
          href="/pricing"
          data-testid="pinterest-limit-upgrade"
          style={{
            display: "inline-flex", alignItems: "center", gap: 6,
            padding: "8px 14px", borderRadius: 10, textDecoration: "none",
            border: "1px solid rgba(245,158,11,0.45)", background: "rgba(245,158,11,0.14)",
            color: UI.warning, fontSize: 12, fontWeight: 700,
          }}
        >
          {tr("socialPanel.limit.upgrade")}
        </a>
        {canBuySlot && (
          <button
            type="button"
            data-testid="social-limit-add-account"
            onClick={() => void handleAddAccount()}
            disabled={checkoutBusy}
            style={{
              display: "inline-flex", alignItems: "center", gap: 6,
              padding: "8px 14px", borderRadius: 10,
              border: "1px solid rgba(245,158,11,0.45)", background: "transparent",
              color: UI.warning, fontSize: 12, fontWeight: 700,
              cursor: checkoutBusy ? "wait" : "pointer",
              opacity: checkoutBusy ? 0.7 : 1,
            }}
          >
            {checkoutBusy ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                {tr("socialPanel.limit.addSlotBusy")}
              </>
            ) : (
              `${tr("socialPanel.limit.addSlot")} · $${EXTRA_ACCOUNT_PRICE_USD.monthly}${tr("socialPanel.limit.perMonth")}`
            )}
          </button>
        )}
        <button
          type="button"
          data-testid="pinterest-limit-dismiss"
          onClick={onDismiss}
          style={{
            padding: "8px 12px", borderRadius: 10,
            border: "1px solid transparent", background: "transparent",
            color: UI.textMuted, fontSize: 12, fontWeight: 600, cursor: "pointer",
          }}
        >
          {tr("socialPanel.limit.dismiss")}
        </button>
      </div>
    </div>
  );
}

/**
 * Per-account rows with their own Remove — Phase D ③.
 *
 * Only rendered when a platform actually holds more than one account. With a single
 * account the card's platform-level Disconnect already IS "remove this account", and
 * duplicating it would give the same act two buttons with two code paths.
 *
 * This exists because until now a multi-account platform had no way to remove one
 * account: the only control was the platform-level Disconnect, which tore down every
 * connection at once.
 */
function AccountRows({
  summary,
  busyAccountId,
  onRemoveAccount,
}: {
  summary: PlatformConnectionSummary;
  busyAccountId: string | null;
  onRemoveAccount: (account: SocialConnection) => void;
}) {
  const { t: tr } = useLocale();
  if (summary.accounts.length < 2) return null;

  return (
    <div
      data-testid={`social-account-rows-${summary.provider}`}
      style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 6 }}
    >
      {summary.accounts.map(account => {
        const busy = busyAccountId === account.id;
        // Display name first, then @username, then a masked id — never a fabricated
        // name, and never a bare "Account connected" (identical for every row once a
        // merchant holds two accounts). See lib/social/accountIdentity.
        const label = accountDisplayLabel(
          {
            displayName: account.providerAccountName,
            username: account.providerAccountUsername,
            accountId: account.providerAccountId,
          },
          {
            maskedTemplate: (last4) => tr("socialPanel.card.accountMasked").replace("{last4}", last4),
            unidentifiedLabel: tr("socialPanel.card.accountUnidentified"),
          },
        );
        return (
          <div
            key={account.id}
            data-testid={`social-account-row-${account.id}`}
            style={{
              display: "flex", alignItems: "center", gap: 10,
              padding: "8px 10px", borderRadius: 10,
              border: `1px solid ${UI.border}`, background: UI.surface2,
            }}
          >
            <span
              style={{
                flex: 1, minWidth: 0, fontSize: 12, fontWeight: 600, color: UI.text,
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              }}
            >
              {label}
            </span>
            <button
              type="button"
              data-testid={`social-remove-account-${account.id}`}
              onClick={() => onRemoveAccount(account)}
              disabled={busy}
              style={{
                display: "inline-flex", alignItems: "center", gap: 5,
                padding: "6px 11px", borderRadius: 9,
                border: `1px solid ${UI.border}`, background: "transparent", color: UI.textSec,
                fontSize: 11.5, fontWeight: 700,
                cursor: busy ? "not-allowed" : "pointer", opacity: busy ? 0.6 : 1,
              }}
            >
              {busy ? <Loader2 size={12} className="animate-spin" /> : null}
              {tr("socialPanel.account.remove")}
            </button>
          </div>
        );
      })}
    </div>
  );
}

/**
 * The Remove confirmation shown ONLY when the account still has scheduled Pins
 * pinned to it (count > 0). With nothing scheduled there is no decision to make, so
 * the Remove happens straight away — a dialog that only ever has one sensible answer
 * is noise.
 *
 * Two answers, deliberately not three:
 *  · Keep — the Pins stay scheduled. Nothing extra is built for this: a Pin whose
 *    target is gone is already stopped at publish time with `target_disconnected`
 *    (Phase C), so "Keep" is genuinely the do-nothing branch.
 *  · Cancel schedules — un-schedules them server-side before the removal.
 * Re-assigning them to another account is a separate feature, not a checkbox here.
 */
function RemoveAccountDialog({
  accountLabel,
  scheduledCount,
  busy,
  onKeep,
  onCancelSchedules,
  onDismiss,
}: {
  accountLabel: string;
  scheduledCount: number;
  busy: boolean;
  onKeep: () => void;
  onCancelSchedules: () => void;
  onDismiss: () => void;
}) {
  const { t: tr } = useLocale();
  return (
    <div
      data-testid="pinterest-remove-account-dialog"
      role="alertdialog"
      aria-label={tr("socialPanel.removeDialog.title")}
      style={{
        padding: "12px 14px",
        borderRadius: 12,
        background: "rgba(245,158,11,0.10)",
        border: "1px solid rgba(245,158,11,0.30)",
      }}
    >
      <p style={{ margin: 0, fontSize: 12.5, fontWeight: 700, color: UI.warning }}>
        {tr("socialPanel.removeDialog.title")}
      </p>
      <p style={{ margin: "5px 0 0", fontSize: 12, color: UI.textSec, lineHeight: 1.55 }}>
        {`${accountLabel}${tr("socialPanel.removeDialog.bodyPrefix")}${scheduledCount}${tr("socialPanel.removeDialog.bodySuffix")}`}
      </p>
      <div style={{ marginTop: 11, display: "flex", flexWrap: "wrap", gap: 8 }}>
        <button
          type="button"
          data-testid="pinterest-remove-keep"
          onClick={onKeep}
          disabled={busy}
          style={{
            display: "inline-flex", alignItems: "center", gap: 6,
            padding: "8px 14px", borderRadius: 10,
            border: "1px solid rgba(245,158,11,0.45)", background: "rgba(245,158,11,0.14)",
            color: UI.warning, fontSize: 12, fontWeight: 700,
            cursor: busy ? "not-allowed" : "pointer", opacity: busy ? 0.6 : 1,
          }}
        >
          {tr("socialPanel.removeDialog.keep")}
        </button>
        <button
          type="button"
          data-testid="pinterest-remove-cancel-schedules"
          onClick={onCancelSchedules}
          disabled={busy}
          style={{
            display: "inline-flex", alignItems: "center", gap: 6,
            padding: "8px 14px", borderRadius: 10,
            border: `1px solid ${UI.border}`, background: "transparent",
            color: UI.textSec, fontSize: 12, fontWeight: 700,
            cursor: busy ? "not-allowed" : "pointer", opacity: busy ? 0.6 : 1,
          }}
        >
          {tr("socialPanel.removeDialog.cancelSchedules")}
        </button>
        <button
          type="button"
          data-testid="pinterest-remove-dismiss"
          onClick={onDismiss}
          disabled={busy}
          style={{
            padding: "8px 12px", borderRadius: 10,
            border: "1px solid transparent", background: "transparent",
            color: UI.textMuted, fontSize: 12, fontWeight: 600,
            cursor: busy ? "not-allowed" : "pointer",
          }}
        >
          {tr("socialPanel.removeDialog.dismiss")}
        </button>
      </div>
    </div>
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
  /**
   * A reconnect the server refused because a different Pinterest account authorized
   * (PRD §10). Holds both usernames so the offer can name them; null when there is
   * no pending decision.
   */
  const [accountMismatch, setAccountMismatch] = useState<{ expected: string | null; got: string | null } | null>(null);
  /**
   * A connect the server refused because the plan's account limit is used up
   * (PRD §9.2 / §18). Like the mismatch, nothing was written and the user has a real
   * choice, so it persists as a banner instead of a toast.
   */
  const [accountLimitReached, setAccountLimitReached] = useState(false);
  /**
   * The user's plan, from the connections response. Drives ONE thing: whether the
   * limit banner offers to sell an extra account slot. Defaults to "free" so an
   * older/failed response can only ever under-offer, never over-promise.
   */
  const [plan, setPlan] = useState<SocialPlanKey>("free");
  /**
   * A per-account Remove waiting on the user because that account still has Pins
   * scheduled through it. Holds the account plus the count so the prompt can be
   * specific ("3 Pins"), rather than a vague warning nobody can act on.
   */
  const [pendingRemoval, setPendingRemoval] = useState<
    { account: SocialConnection; label: string; scheduledCount: number } | null
  >(null);
  /** The account row currently mid-Remove — disables just that row, not the card. */
  const multiAccountEnabled = isMultiSocialAccountsEnabled();
  const [busyAccountId, setBusyAccountId] = useState<string | null>(null);
  // Forward-looking "Add another account" entry — off unless the workspace opts in.


  const load = useCallback(async () => {
    setLoadError(false);
    try {
      const { platforms, plan: resolvedPlan } = await fetchSocialConnections();
      setSummaries(platforms);
      setPlan(resolvedPlan ?? "free");
    } catch {
      setSummaries(null);
      setLoadError(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Stay in step with the publish drawer: connecting a platform from a Pin's
  // destination rows must be reflected here too (and vice versa), so the two
  // surfaces can never show contradictory connection states.
  useEffect(() => {
    function onChanged() {
      void load();
    }
    window.addEventListener(SOCIAL_CONNECTIONS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(SOCIAL_CONNECTIONS_CHANGED_EVENT, onChanged);
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
    if (flag === "connected" || flag === "select_page") { notifyConnectionsChanged(); void load(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  // `?pinterest=<status>` OAuth-return consumption (see PINTEREST_CALLBACK_MESSAGES
  // above). Same contract as the Facebook/Instagram handlers: toast once, clear the
  // query so a refresh can't re-fire it, refresh the list on success. On a completed
  // connect it also kicks off the deferred account backfill — the callback skips the
  // profile read to keep the redirect fast, so without this the card would sit on a
  // generic name until the next sync.
  useEffect(() => {
    const flag = params.get("pinterest");
    if (!flag) return;

    // A refused reconnect is NOT a toast. Nothing was written and the user has a
    // real decision to make (sign in as the original account, or add the one that
    // just authorized as a second account — PRD §10), so it stays on screen as a
    // banner with both options rather than vanishing after a few seconds.
    if (flag === "account_mismatch") {
      setAccountMismatch({
        expected: params.get("expected"),
        got: params.get("got"),
      });
      router.replace(SETTINGS_SOCIAL_PATH);
      return;
    }

    // Same treatment for the plan limit: a persistent banner with an Upgrade CTA,
    // not a toast. Both the connect start and the OAuth callback redirect here.
    if (flag === "limit_reached") {
      setAccountLimitReached(true);
      router.replace(SETTINGS_SOCIAL_PATH);
      return;
    }

    const m = PINTEREST_CALLBACK_MESSAGES[flag];
    if (m) {
      const notify = m.type === "success" ? toast.success : m.type === "error" ? toast.error : toast.info;
      notify(m.msg);
    }
    router.replace(SETTINGS_SOCIAL_PATH);
    if (flag === "connected") {
      // A successful authorization resolves any pending mismatch / limit banner.
      setAccountMismatch(null);
      setAccountLimitReached(false);
      notifyConnectionsChanged();
      void load();
      void syncPinterestAccount().then(synced => { if (synced) void load(); });
    }
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
    if (flag === "connected") { notifyConnectionsChanged(); void load(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  /**
   * Start a connect / reconnect / add-another flow.
   *
   * `reconnectConnectionId` is what separates "repair this account" from "add an
   * account": only the former makes the callback refuse a different Pinterest
   * account instead of writing it. Reconnect passes it; Connect and Add another
   * deliberately do not.
   */
  async function handleConnect(provider: SocialProvider, reconnectConnectionId?: string | null) {
    setBusyProvider(provider);
    setConnectingProvider(provider);
    try {
      if (provider === "pinterest") {
        const result = await startPinterestConnect(undefined, reconnectConnectionId ?? null);
        if (!result.ok) toast.error(result.message);
        return; // navigates away on success
      }
      // Pass the reconnect target: a repair must not be refused by the plan gate.
      const result = await startSocialConnect(provider, undefined, reconnectConnectionId ?? null);
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
          .finally(() => { notifyConnectionsChanged(); void load(); });
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

  /**
   * Remove ONE account (Phase D ③).
   *
   * Asks the server what is still scheduled through that account first. Nothing
   * scheduled ⇒ remove immediately; otherwise hand the decision to the user rather
   * than quietly stranding work they planned.
   *
   * Pinterest-only, asserted rather than assumed. The rows this hangs off render for
   * any platform holding 2+ accounts, and only Pinterest's storage can produce that
   * today — but the scheduled-count and disconnect calls below are Pinterest routes.
   * Handing them a Facebook connection id would hit the store's provider filter,
   * match zero rows, and return a cheerful 200 that the UI would render as a
   * successful removal until the next load() silently put the account back. When
   * another platform goes multi-account it needs its own branch here, and this guard
   * is what will make that a visible error instead of a phantom success.
   */
  async function handleRemoveAccount(provider: SocialProvider, account: SocialConnection) {
    if (provider !== "pinterest") {
      console.error(`[social] per-account removal is not wired for ${provider}`);
      toast.error(tr("socialPanel.toast.couldNotDisconnect"));
      return;
    }
    setBusyAccountId(account.id);
    try {
      const label = accountDisplayLabel(
        {
          displayName: account.providerAccountName,
          username: account.providerAccountUsername,
          accountId: account.providerAccountId,
        },
        {
          maskedTemplate: (last4) => tr("socialPanel.card.accountMasked").replace("{last4}", last4),
          unidentifiedLabel: tr("socialPanel.card.accountUnidentified"),
        },
      );
      const scheduledCount = await getScheduledCountForConnection(account.id);
      if (scheduledCount > 0) {
        // The dialog owns the next step. Release the row so the card isn't frozen
        // behind a prompt the user may legitimately dismiss.
        setPendingRemoval({ account, label, scheduledCount });
        setBusyAccountId(null);
        return;
      }
      await removeAccount(provider, account, false);
      setBusyAccountId(null);
    } catch (e) {
      toast.error((e as Error).message || tr("socialPanel.toast.couldNotDisconnect"));
      setBusyAccountId(null);
    }
  }

  /**
   * The actual removal. Optimistically drops just THIS account from the card —
   * decrementing the count and re-deriving the displayed name — instead of blanking
   * the platform, which is what the all-accounts Disconnect path does and what would
   * be wrong here: the user's other accounts are still connected.
   */
  async function removeAccount(
    provider: SocialProvider,
    account: SocialConnection,
    cancelScheduled: boolean,
  ) {
    setSummaries(prev => prev?.map(s => {
      if (s.provider !== provider) return s;
      const accounts = s.accounts.filter(a => a.id !== account.id);
      const primary = accounts.find(a => a.connectionStatus === "connected") ?? accounts[0] ?? null;
      return {
        ...s,
        accounts,
        accountCount: Math.max(0, s.accountCount - 1),
        accountName: primary?.providerAccountUsername ?? primary?.providerAccountName ?? null,
        connected: accounts.some(a => a.connectionStatus === "connected"),
        status: accounts.length ? s.status : ("not_connected" as const),
      };
    }) ?? prev);

    try {
      await disconnectPinterest(account.id, { cancelScheduled });
      toast.success(tr("socialPanel.toast.accountRemoved"));
    } catch {
      toast.error(tr("socialPanel.toast.accountRemoveFailed"));
    } finally {
      notifyConnectionsChanged();
      await load(); // the server is the truth either way — restores the row on failure
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

      {accountLimitReached && (
        <AccountLimitNotice plan={plan} onDismiss={() => setAccountLimitReached(false)} />
      )}

      {pendingRemoval && (
        <RemoveAccountDialog
          accountLabel={pendingRemoval.label}
          scheduledCount={pendingRemoval.scheduledCount}
          busy={busyAccountId === pendingRemoval.account.id}
          onKeep={() => {
            const { account } = pendingRemoval;
            setPendingRemoval(null);
            setBusyAccountId(account.id);
            // Keep = do nothing extra. Those Pins stay scheduled and are stopped at
            // publish time by the existing target_disconnected block.
            void removeAccount(account.provider, account, false).finally(() => setBusyAccountId(null));
          }}
          onCancelSchedules={() => {
            const { account } = pendingRemoval;
            setPendingRemoval(null);
            setBusyAccountId(account.id);
            void removeAccount(account.provider, account, true).finally(() => setBusyAccountId(null));
          }}
          onDismiss={() => setPendingRemoval(null)}
        />
      )}

      {accountMismatch && (
        <AccountMismatchNotice
          expected={accountMismatch.expected}
          got={accountMismatch.got}
          busy={busyProvider === "pinterest"}
          onSignInToOriginal={() => {
            // Retry the SAME repair: still a reconnect, so a second wrong account is
            // refused again rather than quietly taking over the connection.
            const pinterest = summaries?.find(s => s.provider === "pinterest");
            void handleConnect("pinterest", pinterest?.accounts[0]?.id ?? null);
          }}
          onAddAsNew={() => {
            // Deliberately NOT a reconnect: this is the user accepting the account
            // that authorized, so it goes down the plain Add path and gets its own row.
            void handleConnect("pinterest");
          }}
          onDismiss={() => setAccountMismatch(null)}
        />
      )}

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
              multiAccount={isMultiAccountAllowed(provider, multiAccountEnabled)}
              onConnect={() => void handleConnect(provider)}
              onReconnect={id => void handleConnect(provider, id)}
              onDisconnect={() => void handleDisconnect(summary)}
              onRemoveAccount={account => void handleRemoveAccount(provider, account)}
              busyAccountId={busyAccountId}
              onRefresh={() => void load()}
            />
          );
        })}
    </div>
  );
}
