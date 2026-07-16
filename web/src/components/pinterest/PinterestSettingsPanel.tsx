"use client";

/**
 * Pinterest Integration settings — one page, three visual states:
 * not_connected | connected | limited_access
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  AlertTriangle,
  Check,
  ChevronRight,
  Link as LinkIcon,
  Loader2,
  Plus,
  Trash2,
} from "lucide-react";
import NextLink from "next/link";
import { SETTINGS_PINTEREST_PATH } from "@/lib/settingsPaths";
import {
  derivePinterestSettingsState,
  type PinterestSettingsVisualState,
} from "@/lib/pinterest/pinterestSettingsState";
import { isMultiSocialAccountsEnabled } from "@/lib/socialFeatureFlags";
import {
  disconnectPinterest,
  fetchPinterestStatus,
  startPinterestConnect,
  syncPinterestAccount,
  type PinterestClientError,
  type PinterestStatus,
} from "@/lib/pinterestClient";
import { fetchSocialConnections } from "@/lib/social/socialClient";
import { SupportChatModal } from "@/components/support/SupportChatModal";

const UI = {
  surface: "var(--app-surface, #161D2E)",
  surface2: "var(--app-surface-2, #1A2235)",
  border: "var(--app-border, rgba(255,255,255,0.10))",
  text: "var(--app-text, #E2E8F0)",
  textSec: "var(--app-text-sec, #8892A4)",
  success: "#10B981",
  warning: "#F59E0B",
  error: "#EF4444",
  gradient: "linear-gradient(135deg,#FF4D8D 0%,#D946EF 52%,#7C3AED 100%)",
};

type NoticeType = "success" | "error" | "info";
const CALLBACK_MESSAGES: Record<string, { type: NoticeType; msg: string }> = {
  connected: { type: "success", msg: "Pinterest connected" },
  // User backed out of the Pinterest authorization — not an error.
  cancelled: { type: "info", msg: "Pinterest connection was cancelled. You can try again when ready." },
  denied: { type: "info", msg: "Pinterest connection was cancelled. You can try again when ready." },
  state_mismatch: { type: "error", msg: "Security check failed — please try connecting again" },
  state_expired: { type: "error", msg: "Connection request expired — please try again" },
  session_expired: { type: "error", msg: "Your session expired — please sign in and retry" },
  missing_code: { type: "error", msg: "Pinterest did not return an authorization code" },
  exchange_failed: {
    type: "error",
    msg: "Could not complete Pinterest authorization — check App ID and App secret in web/.env.local",
  },
  persist_failed: { type: "error", msg: "Pinterest authorized but saving the connection failed — try again" },
  config_error: { type: "error", msg: "Pinterest is not configured on the server" },
  error: { type: "error", msg: "Pinterest authorization failed" },
};

/** Notice colors for the small OAuth-return banner (success = green, info = neutral, error = red). */
function noticeColors(type: NoticeType): { color: string; bg: string; border: string } {
  if (type === "success") return { color: UI.success, bg: "rgba(16,185,129,0.1)", border: "rgba(16,185,129,0.25)" };
  if (type === "info") return { color: UI.textSec, bg: "rgba(148,163,184,0.10)", border: "rgba(148,163,184,0.22)" };
  return { color: UI.error, bg: "rgba(239,68,68,0.1)", border: "rgba(239,68,68,0.25)" };
}

/**
 * Cross-check the SHARED social-connections source (the same DB connection record
 * the Social accounts tab and Publish destinations read) for a live Pinterest
 * connection. Used ONLY as a fallback when the Pinterest-specific
 * /api/pinterest/status read fails — so a transient status error (cold DB, a slow
 * response, the panel's own 5s abort) can never hide a connection that is actually
 * live, and the two Settings surfaces can never disagree.
 *
 * Sandbox-safe by construction: /api/social/connections reports Pinterest connected
 * only from the real DB connection (getActiveConnection), never from the sandbox
 * token — so this can never fake "connected" in Settings. The synthesized status is
 * tagged connectionSource:"db" for the same reason (it reflects a real user record).
 *
 * Returns a connected PinterestStatus, or null when Pinterest isn't connected there
 * (or the shared source is itself unreachable).
 */
async function pinterestStatusFromSocialFallback(): Promise<PinterestStatus | null> {
  try {
    const { platforms } = await fetchSocialConnections();
    const pin = platforms.find(p => p.provider === "pinterest");
    if (!pin?.connected) return null;
    const acct = pin.accounts.find(a => a.connectionStatus === "connected") ?? pin.accounts[0] ?? null;
    const accountType = typeof acct?.metadata?.accountType === "string" ? acct.metadata.accountType : null;
    return {
      connected: true,
      account: {
        id: acct?.providerAccountId ?? null,
        username: acct?.providerAccountUsername ?? null,
        accountType,
      },
      scopes: acct?.scopes ?? [],
      needsReconnect: pin.status === "expired",
      lastSyncedAt: acct?.updatedAt ?? null,
      connectionSource: "db",
    };
  } catch {
    return null;
  }
}

const CAPABILITIES = [
  "Boards access",
  "Pin publishing",
] as const;

function PinterestMark({ size = 40 }: { size?: number }) {
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: "#E60023",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
      }}
      aria-hidden
    >
      <svg width={size * 0.5} height={size * 0.5} viewBox="0 0 24 24" fill="#fff">
        <path d="M12 0C5.373 0 0 5.373 0 12c0 5.084 3.163 9.426 7.627 11.174-.105-.949-.2-2.403.042-3.441.218-.937 1.407-5.965 1.407-5.965s-.359-.719-.359-1.782c0-1.668.967-2.914 2.171-2.914 1.023 0 1.518.769 1.518 1.69 0 1.029-.655 2.568-.994 3.995-.283 1.194.599 2.169 1.777 2.169 2.133 0 3.772-2.249 3.772-5.495 0-2.873-2.064-4.882-5.012-4.882-3.414 0-5.418 2.561-5.418 5.207 0 1.031.397 2.138.893 2.738a.36.36 0 01.083.345l-.333 1.36c-.053.22-.174.267-.402.161-1.499-.698-2.436-2.889-2.436-4.649 0-3.785 2.75-7.262 7.929-7.262 4.163 0 7.398 2.967 7.398 6.931 0 4.136-2.607 7.464-6.227 7.464-1.216 0-2.359-.631-2.75-1.378l-.748 2.853c-.271 1.043-1.002 2.35-1.492 3.146C9.57 23.812 10.763 24 12 24c6.627 0 12-5.373 12-12S18.627 0 12 0z" />
      </svg>
    </div>
  );
}

function StatusBadge({ tone, label }: { tone: "success" | "warning"; label: string }) {
  const color = tone === "success" ? UI.success : UI.warning;
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
        color,
        background: tone === "success" ? "rgba(16,185,129,0.12)" : "rgba(245,158,11,0.12)",
        border: `1px solid ${tone === "success" ? "rgba(16,185,129,0.3)" : "rgba(245,158,11,0.35)"}`,
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: color }} />
      {label}
    </span>
  );
}

function OutlineButton({
  children,
  onClick,
  disabled,
  testId,
  tone = "default",
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  testId?: string;
  tone?: "default" | "danger" | "primary";
}) {
  const border =
    tone === "danger" ? "rgba(239,68,68,0.4)" : tone === "primary" ? "rgba(59,130,246,0.45)" : UI.border;
  const color = tone === "danger" ? "#F87171" : tone === "primary" ? "#93C5FD" : UI.text;
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      disabled={disabled}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "8px 14px",
        borderRadius: 10,
        fontSize: 12,
        fontWeight: 700,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.6 : 1,
        border: `1px solid ${border}`,
        background: "transparent",
        color,
      }}
    >
      {children}
    </button>
  );
}

/** Plain, non-technical permission summary shown in the connected state. */
function PermissionSummary({ canReadBoards, canPublish }: { canReadBoards: boolean; canPublish: boolean }) {
  const rows: { label: string; ok: boolean; note?: string }[] = [
    { label: "Boards access", ok: canReadBoards },
    { label: "Pin publishing", ok: canPublish, note: canPublish ? undefined : "Limited until approved" },
  ];
  return (
    <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 10 }}>
      {rows.map(row => (
        <div key={row.label} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 13 }}>
          <span style={{ color: UI.textSec }}>{row.label}</span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: row.ok ? UI.success : UI.warning, fontWeight: 600 }}>
            {row.ok ? <Check size={14} /> : <AlertTriangle size={14} />}
            {row.note ?? (row.ok ? "Enabled" : "Unavailable")}
          </span>
        </div>
      ))}
    </div>
  );
}

export function PinterestSettingsPanel() {
  const params = useSearchParams();
  const router = useRouter();
  const [status, setStatus] = useState<PinterestStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [disconnecting, setDisconnecting] = useState(false);
  const [connecting, setConnecting] = useState(false);
  // A status refresh failed (timeout / backend error). This NEVER turns the panel
  // into a scary red error card — it only drives a small muted "couldn't refresh"
  // note. The last known-good status is kept so a transient failure can't drop a
  // connected user to "not connected". Raw diagnostics live in Developer tools.
  const [refreshFailed, setRefreshFailed] = useState(false);
  // Contact Support entry point — supplements "Try again" / "Reconnect
  // Pinterest", never replaces them.
  const [supportOpen, setSupportOpen] = useState(false);
  // Monotonic id + abort controller for the status fetch. A newer load (or a
  // Disconnect) bumps the id and aborts the old request so a late/slow status
  // response can never overwrite fresher UI state (e.g. flip back to "connected"
  // right after the user disconnected).
  const loadSeqRef = useRef(0);
  const loadAbortRef = useRef<AbortController | null>(null);
  const [oauthNotice] = useState(() => {
    const flag = params.get("pinterest");
    return flag ? (CALLBACK_MESSAGES[flag] ?? null) : null;
  });

  const load = useCallback(async () => {
    // Supersede any in-flight load: bump the sequence and abort the old request so
    // its result is ignored and can't overwrite this one.
    loadAbortRef.current?.abort();
    const controller = new AbortController();
    loadAbortRef.current = controller;
    const seq = ++loadSeqRef.current;
    const isCurrent = () => seq === loadSeqRef.current;

    setLoading(true);

    // Hard 5s timeout so the panel never sits on "Checking connection…" forever.
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      const next = await fetchPinterestStatus(controller.signal);
      if (!isCurrent()) return; // superseded by a newer load / a Disconnect
      setStatus(next);
      setRefreshFailed(false);
    } catch (e) {
      if (!isCurrent()) return; // superseded — never let a stale result touch state
      const err = e as PinterestClientError;
      // A definitive "needs reconnect" is real connection state (expired/revoked),
      // not a refresh failure — reflect it so the user gets Reconnect + Disconnect.
      if (!controller.signal.aborted && err.needsReconnect) {
        setStatus({ connected: true, account: null, scopes: [], needsReconnect: true });
        setRefreshFailed(false);
      } else {
        // The Pinterest-specific status read failed (timeout / database_error /
        // configuration_error / network). Before dropping a possibly-connected user
        // to "not connected", cross-check the SHARED social-connections source (the
        // same DB record the Social accounts tab + Publish destinations read). If it
        // reports Pinterest connected, trust it and render connected — a status blip
        // must never hide a live connection, and the Settings surfaces must agree.
        const fallback = await pinterestStatusFromSocialFallback();
        if (!isCurrent()) return; // superseded while the fallback was in flight
        if (fallback) {
          setStatus(fallback);
          setRefreshFailed(false);
        } else {
          // Neither source confirms a connection — a genuine backend status-loading
          // problem, NOT a user-facing error. Never blank to a red card: keep the
          // last known-good status if we have one (so a connected user stays connected
          // across a transient failure); otherwise fall back to not-connected so the
          // user simply sees "Connect Pinterest". The raw safe error is surfaced only
          // in Developer tools.
          setRefreshFailed(true);
          setStatus(prev => prev ?? { connected: false, account: null, scopes: [], needsReconnect: false, connectionSource: "none" });
        }
      }
    } finally {
      clearTimeout(timeout);
      // Only the current load may clear the spinner — a superseded load must not
      // toggle loading state that a newer load owns.
      if (isCurrent()) setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    // Abort any in-flight status fetch on unmount and invalidate its sequence.
    return () => { loadAbortRef.current?.abort(); loadSeqRef.current++; };
  }, [load]);

  useEffect(() => {
    const flag = params.get("pinterest");
    if (!flag) return;
    const m = CALLBACK_MESSAGES[flag];
    if (m && m.type !== "error") {
      const notify = m.type === "success" ? toast.success : m.type === "info" ? toast.info : toast.error;
      notify(m.msg);
    }
    router.replace(SETTINGS_PINTEREST_PATH);
    if (flag === "connected") {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void load();
      // Deferred, best-effort account backfill (see syncPinterestAccount doc).
      // Reload status again after it resolves so the real username replaces the
      // generic fallback without the user needing to refresh anything.
      void syncPinterestAccount().then(synced => { if (synced) void load(); });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  const visualState: PinterestSettingsVisualState = useMemo(
    () => derivePinterestSettingsState(status),
    [status],
  );
  const visibleOauthNotice = oauthNotice && !(oauthNotice.type === "error" && visualState !== "not_connected")
    ? oauthNotice
    : null;

  // Plain permission summary is derived from granted scopes only (never invented).
  const scopes = status?.scopes ?? [];
  const canReadBoards = scopes.includes("boards:read") || scopes.includes("boards:write");
  const canPublish = scopes.includes("pins:write");
  // "Add another Pinterest account" is a forward-looking, off-by-default entry.
  const multiAccountEnabled = isMultiSocialAccountsEnabled();

  const username = status?.account?.username;

  function handleConnect() {
    // Set synchronously, before any await, so the button reacts on the very next
    // render — no waiting on network or auth work to show the redirecting state.
    setConnecting(true);
    void startPinterestConnect().then(result => {
      if (!result.ok) {
        toast.error(result.message);
        setConnecting(false);
      }
      // On success the browser is navigating away; leave connecting=true.
    });
  }

  function handleDisconnect() {
    if (disconnecting) return; // one click is enough — ignore repeats while in flight
    const prevStatus = status;
    setDisconnecting(true);
    // Cancel any in-flight status load and invalidate its sequence so a slow status
    // response can't flip the card back to "connected" after we disconnect.
    loadAbortRef.current?.abort();
    loadSeqRef.current++;
    // Fully optimistic: the server round trip (bearer verification + DB update) can
    // take seconds on a slow network — reflect not-connected and confirm IMMEDIATELY,
    // and let the DELETE settle in the background. On failure, restore the previous
    // connected state with a safe, retryable message.
    setStatus({ connected: false, account: null, scopes: [], needsReconnect: false, connectionSource: "none" });
    setRefreshFailed(false);
    setLoading(false);
    toast.success("Pinterest disconnected");
    disconnectPinterest()
      .catch(() => {
        setStatus(prevStatus);
        toast.error("Could not disconnect Pinterest. Please try again.");
      })
      .finally(() => {
        setDisconnecting(false);
      });
  }

  // Full spinner only on the very first load (no status yet). Subsequent refreshes
  // happen in the background so the connection card never blanks to a spinner.
  if (loading && !status) {
    return (
      <div
        data-testid="pinterest-settings-loading"
        style={{
          background: UI.surface,
          border: `1px solid ${UI.border}`,
          borderRadius: 16,
          padding: 40,
          textAlign: "center",
          color: UI.textSec,
          fontSize: 13,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
        }}
      >
        <Loader2 size={16} className="animate-spin" /> Checking connection…
      </div>
    );
  }

  // Small, muted, non-blocking note reused across the not-connected / connected
  // cards when a background status refresh failed. Never a red "broken" banner.
  const refreshNote = refreshFailed ? (
    <p data-testid="pinterest-refresh-failed" style={{ margin: "0 0 12px", fontSize: 11.5, color: UI.textSec }}>
      Could not refresh connection status.
    </p>
  ) : null;

  if (visualState === "not_connected") {
    return (
      <div data-testid="pinterest-state-not-connected">
        {refreshNote}
        {visibleOauthNotice && (
          <p
            data-testid="pinterest-oauth-notice"
            style={{
              margin: "0 0 14px",
              padding: "10px 12px",
              borderRadius: 10,
              fontSize: 12,
              color: noticeColors(visibleOauthNotice.type).color,
              background: noticeColors(visibleOauthNotice.type).bg,
              border: `1px solid ${noticeColors(visibleOauthNotice.type).border}`,
            }}
          >
            {visibleOauthNotice.msg}
          </p>
        )}
        <div
          style={{
            background: UI.surface,
            border: `1px solid ${UI.border}`,
            borderRadius: 16,
            padding: "36px 28px",
            textAlign: "center",
          }}
        >
          <div style={{ display: "flex", justifyContent: "center", marginBottom: 16, opacity: 0.85 }}>
            <PinterestMark size={52} />
          </div>
          <p style={{ margin: "0 0 8px", fontSize: 16, fontWeight: 700, color: UI.text }}>No Pinterest account connected</p>
          <p style={{ margin: "0 0 22px", fontSize: 13, color: UI.textSec, lineHeight: 1.6, maxWidth: 420, marginInline: "auto" }}>
            Connect your Pinterest account to publish approved Pins from VibePin.
          </p>
          <button
            type="button"
            data-testid="pinterest-connect"
            onClick={handleConnect}
            disabled={connecting}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              padding: "10px 20px",
              borderRadius: 10,
              border: "none",
              background: UI.gradient,
              color: "#fff",
              fontSize: 13,
              fontWeight: 700,
              cursor: connecting ? "not-allowed" : "pointer",
              opacity: connecting ? 0.8 : 1,
            }}
          >
            {connecting ? <Loader2 size={14} className="animate-spin" /> : <LinkIcon size={14} />}
            {connecting ? "Redirecting to Pinterest..." : "Connect Pinterest"}
          </button>
          <ul
            style={{
              margin: "28px 0 0",
              padding: 0,
              listStyle: "none",
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 8,
              textAlign: "left",
              maxWidth: 380,
              marginInline: "auto",
            }}
          >
            {CAPABILITIES.map(cap => (
              <li key={cap} style={{ fontSize: 12, color: UI.textSec, display: "flex", alignItems: "center", gap: 6 }}>
                <Check size={12} style={{ color: UI.success, flexShrink: 0 }} />
                {cap}
              </li>
            ))}
          </ul>
        </div>
      </div>
    );
  }

  const isLimited = visualState === "limited_access";

  return (
    <div data-testid={isLimited ? "pinterest-state-limited-access" : "pinterest-state-connected"}>
      {refreshNote}
      {visibleOauthNotice && (
        <p
          style={{
            margin: "0 0 14px",
            padding: "10px 12px",
            borderRadius: 10,
            fontSize: 12,
            color: noticeColors(visibleOauthNotice.type).color,
            background: noticeColors(visibleOauthNotice.type).bg,
            border: `1px solid ${noticeColors(visibleOauthNotice.type).border}`,
          }}
        >
          {visibleOauthNotice.msg}
        </p>
      )}

      <div
        style={{
          background: UI.surface,
          border: `1px solid ${isLimited ? "rgba(245,158,11,0.3)" : "rgba(16,185,129,0.28)"}`,
          borderRadius: 16,
          padding: "20px 18px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
            <PinterestMark size={36} />
            <div>
              <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: UI.text }}>
                Connected as {username ? `@${username}` : "your Pinterest account"}
              </p>
              {status?.needsReconnect && !isLimited && (
                <p style={{ margin: "4px 0 0", fontSize: 11, color: UI.warning }}>Reconnect required to restore publishing</p>
              )}
            </div>
          </div>
          <StatusBadge tone={isLimited ? "warning" : "success"} label={isLimited ? "Limited Access" : "Connected"} />
        </div>

        {isLimited && (
          <div
            style={{
              marginTop: 16,
              padding: "12px 14px",
              borderRadius: 10,
              background: "rgba(245,158,11,0.1)",
              border: "1px solid rgba(245,158,11,0.28)",
              display: "flex",
              gap: 10,
              alignItems: "flex-start",
            }}
          >
            <AlertTriangle size={16} style={{ color: UI.warning, flexShrink: 0, marginTop: 1 }} />
            <p style={{ margin: 0, fontSize: 12, color: "#FCD34D", lineHeight: 1.55 }}>
              Your Pinterest account is connected, but publishing may be limited until Standard Access is approved.
            </p>
          </div>
        )}

        <PermissionSummary canReadBoards={canReadBoards} canPublish={canPublish} />

        {/* Actions. Normal healthy connection = Disconnect only. Reconnect appears
            solely when the token is actually invalid (needsReconnect); never for a
            healthy account. Board sync is not a user-facing action — boards load
            automatically wherever they're needed (e.g. the publish drawer). */}
        <div style={{ marginTop: 18, display: "flex", flexWrap: "wrap", gap: 8 }}>
          {status?.needsReconnect && (
            <OutlineButton
              testId="pinterest-reconnect"
              tone="primary"
              onClick={handleConnect}
              disabled={connecting || disconnecting}
            >
              {connecting ? <Loader2 size={13} className="animate-spin" /> : <LinkIcon size={13} />}
              {connecting ? "Redirecting to Pinterest..." : "Reconnect Pinterest"}
            </OutlineButton>
          )}
          {status?.needsReconnect && (
            <OutlineButton testId="pinterest-connection-contact-support" onClick={() => setSupportOpen(true)}>
              Contact support
            </OutlineButton>
          )}
          <OutlineButton testId="pinterest-disconnect" tone="danger" onClick={() => void handleDisconnect()} disabled={disconnecting}>
            {disconnecting ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
            {disconnecting ? "Disconnecting..." : "Disconnect Pinterest"}
          </OutlineButton>
          {/* Forward-looking multi-account entry — off unless the workspace opts in. */}
          {!isLimited && !status?.needsReconnect && multiAccountEnabled && (
            <OutlineButton testId="pinterest-add-account" onClick={handleConnect} disabled={connecting || disconnecting}>
              <Plus size={13} /> Add another Pinterest account
            </OutlineButton>
          )}
        </div>

        {isLimited && (
          <NextLink
            href="https://developers.pinterest.com/docs/getting-started/set-up-app/"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              marginTop: 14,
              fontSize: 12,
              color: "#93C5FD",
              textDecoration: "none",
            }}
          >
            Learn more about Pinterest access <ChevronRight size={14} />
          </NextLink>
        )}
      </div>
      <SupportChatModal
        open={supportOpen}
        onClose={() => setSupportOpen(false)}
        seedText="I'm having trouble connecting Pinterest"
        initialContext={{
          source: "pinterest_connection",
          connectedAccountId: status?.account?.id ?? null,
          connectionStatus: status?.needsReconnect ? "expired" : status?.connected ? "connected" : "disconnected",
          tokenExpired: !!status?.needsReconnect,
          lastConnectedAt: status?.lastSyncedAt ?? null,
        }}
      />
    </div>
  );
}

/** @deprecated Use PinterestSettingsPanel */
export const PinterestIntegrationCard = PinterestSettingsPanel;
