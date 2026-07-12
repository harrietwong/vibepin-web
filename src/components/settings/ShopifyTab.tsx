"use client";

/**
 * Settings → Shopify tab (WP4, §7.1 of the Phase 1 implementation plan).
 *
 * Structure mirrors PinterestSettingsPanel.tsx: one connection card with a
 * status dot, a small `?shopify=<code>` OAuth-return banner consumed on
 * mount (照 PinterestSettingsPanel's `?pinterest=` handling — read via
 * useSearchParams, cleared via router.replace so a refresh never re-shows
 * the toast), and plain hardcoded English copy (this tab is a connection
 * management surface like Pinterest's, not a simple form like the
 * i18n-driven Amazon/Publishing tabs).
 *
 * Phase 1 scope: a single active connection is rendered at a time (the plan
 * spec describes 7 mutually exclusive states, not a multi-store list). Plan
 * tiers above Starter that allow >1 store are schema-ready but the
 * multi-connection list UI is not part of this work package.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  AlertTriangle,
  Check,
  ExternalLink,
  Link as LinkIcon,
  Loader2,
  RefreshCw,
  ShoppingBag,
  Trash2,
} from "lucide-react";
import { SETTINGS_SHOPIFY_PATH } from "@/lib/settingsPaths";
import {
  connectShopify,
  disconnectShopify,
  getShopifyStatus,
  invalidateShopifyStatusCache,
  runSyncToCompletion,
  type ShopifyClientError,
  type ShopifyConnectionStatus,
  type ShopifyStatusResponse,
} from "@/lib/shopifyClient";

const PRICING_PATH = "/pricing";

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
};

type NoticeType = "success" | "error" | "info";
const CALLBACK_MESSAGES: Record<string, { type: NoticeType; msg: string }> = {
  connected: { type: "success", msg: "Shopify store connected" },
  state_mismatch: { type: "error", msg: "Connection attempt expired — try again" },
  hmac_invalid: { type: "error", msg: "Security check failed — please try connecting again" },
  token_exchange_failed: { type: "error", msg: "Could not complete Shopify authorization — please try again" },
  plan_limit_stores: { type: "error", msg: "Store limit reached for your plan — upgrade to connect more stores" },
  config_error: { type: "error", msg: "Shopify is not configured on the server" },
};

function noticeColors(type: NoticeType): { color: string; bg: string; border: string } {
  if (type === "success") return { color: UI.success, bg: "rgba(16,185,129,0.1)", border: "rgba(16,185,129,0.25)" };
  if (type === "info") return { color: UI.textSec, bg: "rgba(148,163,184,0.10)", border: "rgba(148,163,184,0.22)" };
  return { color: UI.error, bg: "rgba(239,68,68,0.1)", border: "rgba(239,68,68,0.25)" };
}

/** Friendly relative time for "last synced" / connection history — no library, plain English. */
function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "Never";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "Never";
  const diffSec = Math.round((Date.now() - then) / 1000);
  if (diffSec < 60) return "Just now";
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin} minute${diffMin === 1 ? "" : "s"} ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr} hour${diffHr === 1 ? "" : "s"} ago`;
  const diffDay = Math.round(diffHr / 24);
  if (diffDay < 30) return `${diffDay} day${diffDay === 1 ? "" : "s"} ago`;
  const diffMonth = Math.round(diffDay / 30);
  if (diffMonth < 12) return `${diffMonth} month${diffMonth === 1 ? "" : "s"} ago`;
  const diffYear = Math.round(diffMonth / 12);
  return `${diffYear} year${diffYear === 1 ? "" : "s"} ago`;
}

const SCOPE_LABELS: Record<string, string> = {
  read_products: "Read products",
};
function scopeLabel(scope: string): string {
  return SCOPE_LABELS[scope] ?? scope;
}

/** Tolerate a pasted full URL ("https://yourstore.myshopify.com/admin") in the shop input. */
function extractShopDomain(input: string): string {
  let s = input.trim().toLowerCase();
  s = s.replace(/^https?:\/\//, "");
  s = s.replace(/\/.*$/, "");
  return s;
}

function StatusDot({ tone }: { tone: "success" | "warning" | "error" }) {
  const color = tone === "success" ? UI.success : tone === "warning" ? UI.warning : UI.error;
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
        background: tone === "success" ? "rgba(16,185,129,0.12)" : tone === "warning" ? "rgba(245,158,11,0.12)" : "rgba(239,68,68,0.12)",
        border: `1px solid ${tone === "success" ? "rgba(16,185,129,0.3)" : tone === "warning" ? "rgba(245,158,11,0.35)" : "rgba(239,68,68,0.35)"}`,
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: color }} />
      {tone === "success" ? "Connected" : tone === "warning" ? "Degraded" : "Needs reconnect"}
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
  const border = tone === "danger" ? "rgba(239,68,68,0.4)" : tone === "primary" ? "rgba(59,130,246,0.45)" : UI.border;
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

const field: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "9px 12px",
  borderRadius: 9,
  border: `1px solid ${UI.border}`,
  background: UI.surface2,
  color: UI.text,
  fontSize: 13,
  outline: "none",
};

const cardStyle: React.CSSProperties = {
  background: UI.surface,
  border: `1px solid ${UI.border}`,
  borderRadius: 16,
  padding: "20px 18px",
};

type SyncProgress = { syncedCount: number; totalCount?: number | null };

export function ShopifyTab() {
  const params = useSearchParams();
  const router = useRouter();

  const [status, setStatus] = useState<ShopifyStatusResponse | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);

  const [shopInput, setShopInput] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [activeSync, setActiveSync] = useState(false);
  const [syncProgress, setSyncProgress] = useState<SyncProgress | null>(null);

  const [oauthNotice] = useState(() => {
    const flag = params.get("shopify");
    return flag ? (CALLBACK_MESSAGES[flag] ?? null) : null;
  });

  // Guards against a superseded status load overwriting a fresher one.
  const loadSeqRef = useRef(0);

  const load = useCallback(async (opts?: { fresh?: boolean }): Promise<ShopifyStatusResponse | null> => {
    const seq = ++loadSeqRef.current;
    try {
      const next = await getShopifyStatus(opts);
      if (seq !== loadSeqRef.current) return null; // superseded
      setStatus(next);
      setRefreshFailed(false);
      setLoaded(true);
      return next;
    } catch {
      if (seq !== loadSeqRef.current) return null;
      setRefreshFailed(true);
      setLoaded(true);
      return null;
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  // `?shopify=<code>` consumption (照 PinterestSettingsPanel 的 `?pinterest=` 模式):
  // notify, clear the query param so a refresh never re-fires the toast, and on a
  // successful first connect kick off one fresh sync automatically (§3.1 semantics).
  useEffect(() => {
    const flag = params.get("shopify");
    if (!flag) return;
    const m = CALLBACK_MESSAGES[flag];
    if (m) {
      const notify = m.type === "success" ? toast.success : m.type === "error" ? toast.error : toast.info;
      notify(m.msg);
    }
    router.replace(SETTINGS_SHOPIFY_PATH);
    if (flag === "connected") {
      invalidateShopifyStatusCache();
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void load({ fresh: true }).then(fresh => {
        const conn = fresh?.connections.find(c => c.status !== "disconnected");
        if (conn) void handleSync(conn.id, { fresh: true });
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  async function handleConnect(shopDomainInput: string) {
    const shopDomain = extractShopDomain(shopDomainInput);
    if (!shopDomain) {
      toast.error("Enter your Shopify store domain");
      return;
    }
    setConnecting(true);
    try {
      const { url } = await connectShopify(shopDomain);
      window.location.assign(url);
      // Browser is navigating away; leave connecting=true.
    } catch (err) {
      const e = err as ShopifyClientError;
      toast.error(e.message || "Could not start Shopify connection");
      setConnecting(false);
    }
  }

  async function handleDisconnect(connectionId: string) {
    if (disconnecting) return;
    if (typeof window !== "undefined") {
      const ok = window.confirm(
        "Disconnect this Shopify store? Synced products will be archived; draft Pins that reference them are kept.",
      );
      if (!ok) return;
    }
    setDisconnecting(true);
    try {
      await disconnectShopify(connectionId);
      toast.success("Shopify store disconnected");
      await load({ fresh: true });
    } catch {
      toast.error("Could not disconnect Shopify. Please try again.");
    } finally {
      setDisconnecting(false);
    }
  }

  async function handleSync(connectionId: string, opts?: { fresh?: boolean }) {
    if (activeSync) return;
    setActiveSync(true);
    setSyncProgress(null);
    try {
      const result = await runSyncToCompletion(connectionId, {
        fresh: opts?.fresh ?? false,
        onProgress: p => setSyncProgress({ syncedCount: p.syncedCount, totalCount: p.totalCount ?? null }),
      });
      if (result.state === "completed") toast.success("Shopify sync complete");
      else if (result.state === "limit_reached") toast.info("Synced up to your plan limit");
      else if (result.state === "error") toast.error(result.error || "Shopify sync failed");
      else if (result.state === "sync_in_progress") toast.info("A sync for this store is already in progress");
    } catch (err) {
      toast.error((err as Error).message || "Shopify sync failed");
    } finally {
      setActiveSync(false);
      setSyncProgress(null);
      void load({ fresh: true });
    }
  }

  // ── First load ────────────────────────────────────────────────────────────
  if (!loaded) {
    return (
      <div
        data-testid="shopify-settings-loading"
        style={{
          ...cardStyle,
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
        <Loader2 size={16} className="animate-spin" /> Checking Shopify connection…
      </div>
    );
  }

  const connections = status?.connections ?? [];
  const current = connections.find(c => c.status !== "disconnected") ?? null;
  const historical = !current && connections.length > 0 ? connections[connections.length - 1] : null;
  const plan = status?.plan ?? { key: "free", maxStores: 0, maxSyncedProducts: 0 };
  const gatedByPlan = plan.maxStores === 0;

  const refreshNote = refreshFailed ? (
    <p data-testid="shopify-refresh-failed" style={{ margin: "0 0 12px", fontSize: 11.5, color: UI.textSec }}>
      Could not refresh connection status.
    </p>
  ) : null;

  const notice = oauthNotice ? (
    <p
      data-testid="shopify-oauth-notice"
      style={{
        margin: "0 0 14px",
        padding: "10px 12px",
        borderRadius: 10,
        fontSize: 12,
        color: noticeColors(oauthNotice.type).color,
        background: noticeColors(oauthNotice.type).bg,
        border: `1px solid ${noticeColors(oauthNotice.type).border}`,
      }}
    >
      {oauthNotice.msg}
    </p>
  ) : null;

  // ── Not connected (never connected) ──────────────────────────────────────
  if (!current && !historical) {
    return (
      <div data-testid="shopify-state-not-connected">
        {refreshNote}
        {notice}
        <div style={{ ...cardStyle, padding: "36px 28px", textAlign: "center" }}>
          <div style={{ display: "flex", justifyContent: "center", marginBottom: 16, opacity: 0.85 }}>
            <ShoppingBag size={44} style={{ color: UI.textSec }} />
          </div>
          <p style={{ margin: "0 0 8px", fontSize: 16, fontWeight: 700, color: UI.text }}>No Shopify store connected</p>
          <p style={{ margin: "0 0 22px", fontSize: 13, color: UI.textSec, lineHeight: 1.6, maxWidth: 420, marginInline: "auto" }}>
            Connect your Shopify store to bring your products into Create Pins.
          </p>

          {gatedByPlan ? (
            <>
              <p style={{ margin: "0 0 14px", fontSize: 12.5, color: UI.warning }}>
                Your plan does not include a Shopify store connection.
              </p>
              <a
                href={PRICING_PATH}
                data-testid="shopify-upgrade-link"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "10px 20px",
                  borderRadius: 10,
                  border: "none",
                  background: "linear-gradient(135deg,#FF4D8D 0%,#D946EF 52%,#7C3AED 100%)",
                  color: "#fff",
                  fontSize: 13,
                  fontWeight: 700,
                  textDecoration: "none",
                }}
              >
                Upgrade to connect a store
              </a>
            </>
          ) : (
            <div style={{ maxWidth: 360, marginInline: "auto", textAlign: "left" }}>
              <input
                data-testid="shopify-shop-domain-input"
                value={shopInput}
                onChange={e => setShopInput(e.target.value)}
                placeholder="yourstore.myshopify.com"
                style={{ ...field, marginBottom: 10 }}
              />
              <button
                type="button"
                data-testid="shopify-connect"
                onClick={() => void handleConnect(shopInput)}
                disabled={connecting}
                style={{
                  width: "100%",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 8,
                  padding: "10px 20px",
                  borderRadius: 10,
                  border: "none",
                  background: "linear-gradient(135deg,#FF4D8D 0%,#D946EF 52%,#7C3AED 100%)",
                  color: "#fff",
                  fontSize: 13,
                  fontWeight: 700,
                  cursor: connecting ? "not-allowed" : "pointer",
                  opacity: connecting ? 0.8 : 1,
                }}
              >
                {connecting ? <Loader2 size={14} className="animate-spin" /> : <LinkIcon size={14} />}
                {connecting ? "Redirecting to Shopify..." : "Connect Shopify"}
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── Disconnected (history) ───────────────────────────────────────────────
  if (!current && historical) {
    return (
      <div data-testid="shopify-state-disconnected">
        {refreshNote}
        {notice}
        <div style={cardStyle}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
            <ShoppingBag size={30} style={{ color: UI.textMuted }} />
            <div>
              <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: UI.text }}>
                {historical.shopName ?? historical.shopDomain}
              </p>
              <p style={{ margin: "2px 0 0", fontSize: 12, color: UI.textSec }}>Disconnected</p>
            </div>
          </div>
          <p style={{ margin: "0 0 18px", fontSize: 12.5, color: UI.textSec, lineHeight: 1.55 }}>
            Products synced from this store have been archived. Draft Pins that reference them are kept and still work.
          </p>
          {gatedByPlan ? (
            <a
              href={PRICING_PATH}
              data-testid="shopify-upgrade-link"
              style={{ fontSize: 12.5, fontWeight: 700, color: UI.blue }}
            >
              Upgrade to reconnect a store →
            </a>
          ) : (
            <OutlineButton testId="shopify-connect-again" tone="primary" onClick={() => void handleConnect(historical.shopDomain)} disabled={connecting}>
              {connecting ? <Loader2 size={13} className="animate-spin" /> : <LinkIcon size={13} />}
              {connecting ? "Redirecting to Shopify..." : "Connect again"}
            </OutlineButton>
          )}
        </div>
      </div>
    );
  }

  // From here on `current` is a live (non-disconnected) connection.
  const conn = current as ShopifyConnectionStatus;
  const isReauth = conn.status === "reauth_required";
  const isDegraded = conn.status === "degraded";
  const sync = conn.sync;

  return (
    <div data-testid={isReauth ? "shopify-state-reauth-required" : "shopify-state-connected"}>
      {refreshNote}
      {notice}

      <div style={{ ...cardStyle, border: `1px solid ${isReauth ? "rgba(239,68,68,0.35)" : isDegraded ? "rgba(245,158,11,0.3)" : "rgba(16,185,129,0.28)"}` }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
            <ShoppingBag size={30} style={{ color: UI.textSec, flexShrink: 0 }} />
            <div style={{ minWidth: 0 }}>
              <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: UI.text, overflow: "hidden", textOverflow: "ellipsis" }}>
                {conn.shopName ?? conn.shopDomain}
              </p>
              <p style={{ margin: "2px 0 0", fontSize: 11.5, color: UI.textSec }}>{conn.shopDomain}</p>
            </div>
          </div>
          <StatusDot tone={isReauth ? "error" : isDegraded ? "warning" : "success"} />
        </div>

        {isReauth && (
          <div
            style={{
              marginTop: 16,
              padding: "12px 14px",
              borderRadius: 10,
              background: "rgba(239,68,68,0.1)",
              border: "1px solid rgba(239,68,68,0.28)",
              display: "flex",
              gap: 10,
              alignItems: "flex-start",
            }}
          >
            <AlertTriangle size={16} style={{ color: UI.error, flexShrink: 0, marginTop: 1 }} />
            <p style={{ margin: 0, fontSize: 12, color: "#FCA5A5", lineHeight: 1.55 }}>
              Your Shopify connection needs to be reauthorized before syncing can continue.
            </p>
          </div>
        )}

        {!isReauth && conn.scopes.length > 0 && (
          <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 8 }}>
            {conn.scopes.map(s => (
              <div key={s} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, color: UI.textSec }}>
                <Check size={13} style={{ color: UI.success }} /> {scopeLabel(s)}
              </div>
            ))}
          </div>
        )}

        {!isReauth && (
          <p style={{ margin: "14px 0 0", fontSize: 12, color: UI.textSec }}>
            Last synced: {relativeTime(conn.lastFullSyncAt)}
          </p>
        )}

        {/* Sync sub-states */}
        {!isReauth && sync.status === "running" && (
          <div data-testid="shopify-sync-progress" style={{ marginTop: 14 }}>
            <p style={{ margin: "0 0 6px", fontSize: 12.5, color: UI.text, fontWeight: 600 }}>
              Synced {syncProgress?.syncedCount ?? sync.syncedCount}
              {(syncProgress?.totalCount ?? sync.totalCount) ? ` of ${syncProgress?.totalCount ?? sync.totalCount}` : ""}
            </p>
            <div style={{ height: 6, borderRadius: 999, background: "rgba(255,255,255,0.08)", overflow: "hidden" }}>
              <div
                style={{
                  height: "100%",
                  width: activeSync ? "60%" : "35%",
                  background: UI.blue,
                  transition: "width 0.3s",
                }}
              />
            </div>
          </div>
        )}

        {!isReauth && sync.status === "limit_reached" && (
          <div
            data-testid="shopify-limit-banner"
            style={{
              marginTop: 14,
              padding: "12px 14px",
              borderRadius: 10,
              background: "rgba(245,158,11,0.1)",
              border: "1px solid rgba(245,158,11,0.28)",
            }}
          >
            <p style={{ margin: 0, fontSize: 12, color: "#FCD34D", lineHeight: 1.55 }}>
              Synced {sync.syncedCount}{sync.totalCount ? ` of ${sync.totalCount}` : ""} products — most recently updated first.{" "}
              <a href={PRICING_PATH} style={{ color: UI.blue, fontWeight: 700 }}>Upgrade to sync more.</a>
            </p>
          </div>
        )}

        {!isReauth && sync.status === "error" && (
          <div
            data-testid="shopify-error-banner"
            style={{
              marginTop: 14,
              padding: "12px 14px",
              borderRadius: 10,
              background: "rgba(239,68,68,0.1)",
              border: "1px solid rgba(239,68,68,0.28)",
            }}
          >
            <p style={{ margin: 0, fontSize: 12, color: "#FCA5A5", lineHeight: 1.55 }}>
              Sync failed{sync.error ? `: ${sync.error}` : "."}
            </p>
          </div>
        )}

        {!isReauth && (
          <p style={{ margin: "14px 0 0", fontSize: 11.5, color: UI.textSec }}>
            Find your products in Create Pins → Select product.
          </p>
        )}

        <div style={{ marginTop: 18, display: "flex", flexWrap: "wrap", gap: 8 }}>
          {isReauth ? (
            <>
              <OutlineButton testId="shopify-reconnect" tone="primary" onClick={() => void handleConnect(conn.shopDomain)} disabled={connecting}>
                {connecting ? <Loader2 size={13} className="animate-spin" /> : <LinkIcon size={13} />}
                {connecting ? "Redirecting to Shopify..." : "Reconnect"}
              </OutlineButton>
              <OutlineButton testId="shopify-disconnect" tone="danger" onClick={() => void handleDisconnect(conn.id)} disabled={disconnecting}>
                {disconnecting ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                {disconnecting ? "Disconnecting..." : "Disconnect"}
              </OutlineButton>
            </>
          ) : (
            <>
              {sync.status === "running" && !activeSync ? (
                <OutlineButton testId="shopify-resume-sync" tone="primary" onClick={() => void handleSync(conn.id)} disabled={activeSync || disconnecting}>
                  <RefreshCw size={13} /> Resume sync
                </OutlineButton>
              ) : sync.status === "error" ? (
                <OutlineButton testId="shopify-retry-sync" tone="primary" onClick={() => void handleSync(conn.id)} disabled={activeSync || disconnecting}>
                  <RefreshCw size={13} /> Retry
                </OutlineButton>
              ) : (
                <OutlineButton testId="shopify-sync-now" onClick={() => void handleSync(conn.id)} disabled={activeSync || sync.status === "running" || disconnecting}>
                  {activeSync ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
                  {activeSync ? "Syncing..." : "Sync now"}
                </OutlineButton>
              )}
              <OutlineButton testId="shopify-disconnect" tone="danger" onClick={() => void handleDisconnect(conn.id)} disabled={disconnecting || activeSync}>
                {disconnecting ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                {disconnecting ? "Disconnecting..." : "Disconnect"}
              </OutlineButton>
            </>
          )}
        </div>

        {isDegraded && !isReauth && (
          <a
            href="https://help.shopify.com/en/manual/apps"
            target="_blank"
            rel="noreferrer"
            style={{ marginTop: 14, display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11.5, color: UI.textSec }}
          >
            Learn more about Shopify app access <ExternalLink size={11} />
          </a>
        )}
      </div>
    </div>
  );
}
