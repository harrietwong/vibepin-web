"use client";

import { useState, useEffect, useRef, Suspense, useCallback } from "react";
import Link from "next/link";
import { X, ArrowUpRight, Bell, Loader2, Copy, AlertCircle, Zap, Moon, Sun, Monitor, Check, LifeBuoy, TicketCheck } from "lucide-react";
import { createBrowserClient } from "@supabase/ssr";
import { toast } from "sonner";
import { usePathname, useRouter } from "next/navigation";
import { PinterestSettingsPanel } from "@/components/pinterest/PinterestSettingsPanel";
import { PinterestAdvancedSettings } from "@/components/pinterest/PinterestAdvancedSettings";
import { SocialAccountsPanel } from "@/components/social/SocialAccountsPanel";
import { isSocialDevToolsEnabled } from "@/lib/socialFeatureFlags";
import {
  deriveAccountBillingSummary,
  normalizePlanName,
  isPaidPlan,
  type AccountBillingSummary,
} from "@/lib/accountSummary";
import {
  getNotificationPrefs,
  saveNotificationPrefs,
  type NotificationKey,
  type NotificationPrefs,
} from "@/lib/notificationPrefsStore";
import { formatEnglishDateTime, browserTimeZone } from "@/lib/dateTimeFormat";
import {
  fetchPinterestStatus,
  fetchPinterestDebugStatus,
  type PinterestClientError,
  type PinterestStatus,
  type PinterestDebugStatus,
} from "@/lib/pinterestClient";
import { derivePinterestSettingsState } from "@/lib/pinterest/pinterestSettingsState";
import { ContactSupportModal } from "@/components/support/ContactSupportModal";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import type { MessageKey } from "@/lib/i18n/messages/en";
import { useTheme } from "@/lib/theme/ThemeProvider";
import type { ThemePreference } from "@/lib/theme/themeStore";
import {
  PINTEREST_REGIONS,
  ALL_APP_LANGUAGES,
  type PinterestRegionCode,
  type ContentLanguageSetting,
  type LanguageCode,
} from "@/lib/i18n/config";
import {
  getPublishingPrefs,
  savePublishingPrefs,
  defaultPublishingPrefs,
  type PublishingPrefs,
  type PublishingMode,
  type PublishingFormat,
} from "@/lib/publishingPrefsStore";
import { SmartScheduleConfigForm } from "@/components/plan/SmartScheduleConfigForm";
import { EXISTING_APP_TOKEN_BALANCE } from "@/lib/accountSummary";
import {
  getAmazonAffiliateSettings,
  saveAmazonAffiliateSettings,
  defaultAmazonAffiliateSettings,
  type AmazonAffiliateSettings,
} from "@/lib/affiliate/amazonAffiliateSettings";
import { AMAZON_MARKETPLACES, type AmazonMarketplace } from "@/lib/affiliate/amazon";
import { isShopifyIntegrationEnabled } from "@/lib/shopifyFlag";
import { ShopifyTab } from "@/components/settings/ShopifyTab";

const PRICING_PATH = "/pricing";

const supabase = createBrowserClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
);

// ── Tab type ──────────────────────────────────────────────────────────────────
export type SettingsTab =
  | "account"
  | "billing"
  | "pinterest"
  | "social"
  | "publishing"
  | "amazon"
  | "shopify"
  | "smart-schedule"
  | "ai-settings"
  | "appearance"
  | "language"
  | "support";

// ── Design tokens ─────────────────────────────────────────────────────────────
const UI = {
  bg:        "var(--app-shell-bg, #0B1120)",
  surface:   "var(--app-surface, #161D2E)",
  surface2:  "var(--app-surface-2, #1A2235)",
  border:    "var(--app-border, rgba(255,255,255,0.10))",
  text:      "var(--app-text, #E2E8F0)",
  textSec:   "var(--app-text-sec, #8892A4)",
  textMuted: "#5B6577",
  success:   "#10B981",
  warning:   "#F59E0B",
  blue:      "#93C5FD",
  gradient:  "linear-gradient(135deg,#FF4D8D 0%,#D946EF 52%,#7C3AED 100%)",
};

// ── Shared primitives ─────────────────────────────────────────────────────────

function Toggle({ on, onClick, label, testId }: {
  on: boolean; onClick: () => void; label: string; testId?: string;
}) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} data-testid={testId}
      onClick={onClick}
      style={{
        width: 38, height: 22, borderRadius: 999, border: "none", cursor: "pointer", flexShrink: 0,
        background: on ? UI.success : "rgba(255,255,255,0.14)", position: "relative", transition: "background 0.15s",
      }}>
      <span style={{
        position: "absolute", top: 3, left: on ? 19 : 3, width: 16, height: 16, borderRadius: "50%",
        background: "#fff", transition: "left 0.15s",
      }} />
    </button>
  );
}

const field: React.CSSProperties = {
  width: "100%", boxSizing: "border-box", padding: "9px 12px", borderRadius: 9,
  border: `1px solid var(--app-border, rgba(255,255,255,0.10))`,
  background: "var(--app-surface-2, #1A2235)", color: "var(--app-text, #E2E8F0)",
  fontSize: 13, outline: "none",
};

const labelCss: React.CSSProperties = {
  display: "block", fontSize: 11, fontWeight: 700, color: "var(--app-text-sec, #8892A4)",
  marginBottom: 5, textTransform: "uppercase", letterSpacing: "0.05em",
};

function SectionCard({ children, testId }: { children: React.ReactNode; testId?: string }) {
  return (
    <section data-testid={testId} style={{
      background: UI.surface, border: `1px solid ${UI.border}`, borderRadius: 16, padding: "18px 18px",
    }}>
      {children}
    </section>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 style={{ margin: "0 0 12px", fontSize: 15, fontWeight: 800, color: UI.text }}>{children}</h2>;
}

function ToggleRow({ label, description, on, onClick, testId, noBorder }: {
  label: string; description: string; on: boolean; onClick: () => void; testId?: string; noBorder?: boolean;
}) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 14, padding: "11px 0",
      borderBottom: noBorder ? "none" : `1px solid ${UI.border}`,
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: UI.text }}>{label}</p>
        {description && <p style={{ margin: "2px 0 0", fontSize: 11.5, color: UI.textSec }}>{description}</p>}
      </div>
      <Toggle on={on} onClick={onClick} label={label} testId={testId} />
    </div>
  );
}

// ── Account Tab ───────────────────────────────────────────────────────────────

const NOTIF_ROWS: { key: NotificationKey; labelKey: MessageKey; descKey: MessageKey }[] = [
  { key: "publishSuccess",     labelKey: "account.notif.publishSuccess",     descKey: "account.notif.publishSuccessDesc" },
  { key: "publishFailed",      labelKey: "account.notif.publishFailed",      descKey: "account.notif.publishFailedDesc" },
  { key: "weeklySummary",      labelKey: "account.notif.weeklySummary",      descKey: "account.notif.weeklySummaryDesc" },
  { key: "productOpportunity", labelKey: "account.notif.productOpportunity", descKey: "account.notif.productOpportunityDesc" },
];

function AccountTab({ saveFnRef }: { saveFnRef: React.MutableRefObject<(() => Promise<void>) | null> }) {
  const { t } = useLocale();
  const [name, setName]               = useState("");
  const [email, setEmail]             = useState("");
  const [userId, setUserId]           = useState<string | null>(null);
  const [workspaceName, setWorkspaceName] = useState("My Workspace");
  const [loading, setLoading]         = useState(true);
  const [prefs, setPrefs]             = useState<NotificationPrefs | null>(null);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      const user = data.user;
      const meta = { ...(user?.app_metadata ?? {}), ...(user?.user_metadata ?? {}) } as Record<string, unknown>;
      const n = typeof meta.full_name === "string" ? meta.full_name : typeof meta.name === "string" ? meta.name : "";
      setName(n);
      setEmail(user?.email ?? "");
      setUserId(user?.id ?? null);
      const ws = typeof meta.workspace_name === "string" ? meta.workspace_name
               : typeof meta.workspaceName  === "string" ? meta.workspaceName : "My Workspace";
      setWorkspaceName(ws);
      setLoading(false);
    });
    setPrefs(getNotificationPrefs());
  }, []);

  async function handleSave() {
    try {
      const { error } = await supabase.auth.updateUser({
        data: { full_name: name.trim() || undefined, name: name.trim() || undefined },
      });
      if (error) throw error;
      if (prefs) saveNotificationPrefs(prefs);
      toast.success(t("toast.settingsSaved"));
    } catch (e) {
      toast.error((e as Error).message || t("toast.couldNotSave"));
    }
  }
  saveFnRef.current = handleSave;

  const initial = (name || email || "V")[0]?.toUpperCase() ?? "V";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <SectionCard>
        <SectionTitle>{t("account.profileTitle")}</SectionTitle>
        {loading ? (
          <p style={{ margin: 0, fontSize: 13, color: UI.textSec, display: "flex", alignItems: "center", gap: 7 }}>
            <Loader2 size={14} className="animate-spin" /> {t("common.loading")}
          </p>
        ) : (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 18 }}>
              <div style={{
                width: 48, height: 48, borderRadius: "50%", flexShrink: 0,
                background: UI.gradient, display: "flex", alignItems: "center",
                justifyContent: "center", fontSize: 17, fontWeight: 800, color: "#fff",
              }}>{initial}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: UI.text }}>{name || email || t("account.yourProfile")}</p>
                <p style={{ margin: "2px 0 0", fontSize: 12, color: UI.textSec }}>{email}</p>
              </div>
              <button type="button" style={{
                padding: "7px 13px", borderRadius: 9, fontSize: 12, fontWeight: 700,
                border: `1px solid ${UI.border}`, background: "transparent", color: UI.textSec,
                cursor: "default", flexShrink: 0,
              }}>{t("common.changePhoto")}</button>
            </div>
            <label style={{ display: "block", marginBottom: 14 }}>
              <span style={labelCss}>{t("account.fullName")}</span>
              <input value={name} onChange={e => setName(e.target.value)} placeholder={t("account.fullNamePlaceholder")} style={field} />
            </label>
            <label style={{ display: "block" }}>
              <span style={labelCss}>{t("account.emailAddress")}</span>
              <div style={{ position: "relative" }}>
                <input value={email} readOnly tabIndex={-1}
                  style={{ ...field, color: UI.textSec, cursor: "default", paddingRight: 36 }} />
                <span style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", color: UI.textMuted, pointerEvents: "none" }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="3" y="11" width="18" height="11" rx="2" />
                    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                  </svg>
                </span>
              </div>
              <p style={{ margin: "4px 0 0", fontSize: 11, color: UI.textMuted }}>{t("account.emailManaged")}</p>
            </label>
          </>
        )}
      </SectionCard>

      <SectionCard testId="account-workspace-card">
        <SectionTitle>{t("account.workspaceTitle")}</SectionTitle>
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "10px 12px", borderRadius: 10, background: UI.surface2, border: `1px solid ${UI.border}`,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{
              width: 30, height: 30, borderRadius: 8, flexShrink: 0,
              background: "rgba(59,130,246,0.18)", border: "1px solid rgba(59,130,246,0.3)",
              display: "flex", alignItems: "center", justifyContent: "center",
            }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#93C5FD" strokeWidth="2">
                <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" />
                <rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" />
              </svg>
            </div>
            <div>
              <p style={{ margin: 0, fontSize: 13, fontWeight: 700, color: UI.text }}>{workspaceName}</p>
              <p style={{ margin: 0, fontSize: 11, color: UI.textSec }}>{t("account.workspaceOwner")}</p>
            </div>
          </div>
          {userId && (
            <button type="button" data-testid="workspace-copy-id"
              onClick={async () => { try { await navigator.clipboard.writeText(userId); toast.success(t("toast.workspaceIdCopied")); } catch { toast.error(t("toast.couldNotCopy")); } }}
              style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "5px 10px", borderRadius: 7, border: `1px solid ${UI.border}`, background: "transparent", color: UI.textSec, fontSize: 11, fontWeight: 600, cursor: "pointer" }}>
              <Copy size={11} /> {t("common.copyId")}
            </button>
          )}
        </div>
      </SectionCard>

      <SectionCard>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
          <Bell size={14} style={{ color: UI.textSec }} />
          <SectionTitle>{t("account.notifTitle")}</SectionTitle>
        </div>
        {prefs === null ? (
          <p style={{ margin: 0, fontSize: 12, color: UI.textSec }}>{t("common.loading")}</p>
        ) : (
          NOTIF_ROWS.map((row, i) => (
            <ToggleRow key={row.key} label={t(row.labelKey)} description={t(row.descKey)}
              on={prefs[row.key]} noBorder={i === NOTIF_ROWS.length - 1}
              onClick={() => setPrefs(p => p ? { ...p, [row.key]: !p[row.key] } : p)} />
          ))
        )}
      </SectionCard>
    </div>
  );
}

// ── Billing Tab ───────────────────────────────────────────────────────────────

function BillingTab() {
  const { t } = useLocale();
  const [summary, setSummary] = useState<AccountBillingSummary>(() => deriveAccountBillingSummary(null));
  const [loaded, setLoaded] = useState(false);
  const [supportOpen, setSupportOpen] = useState(false);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setSummary(deriveAccountBillingSummary(data.user));
      setLoaded(true);
    });
  }, []);

  const planName   = normalizePlanName(summary.planName);
  const paid       = isPaidPlan(planName);
  const planStatus = summary.planStatus ?? t("billing.statusActive");
  const lastActivity = summary.lastCreditActivityAt ? formatEnglishDateTime(summary.lastCreditActivityAt) : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <SectionCard testId="billing-current-plan">
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, marginBottom: 10 }}>
          <div>
            <p style={{ margin: "0 0 2px", fontSize: 11, color: UI.textSec, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em" }}>{t("billing.currentPlan")}</p>
            <h2 style={{ margin: 0, fontSize: 24, fontWeight: 800, color: UI.text }}>{loaded ? planName : "…"}</h2>
          </div>
          <span style={{
            display: "inline-flex", alignItems: "center", gap: 5, marginTop: 4,
            padding: "4px 10px", borderRadius: 20, fontSize: 11, fontWeight: 700,
            color: UI.success, background: "rgba(16,185,129,0.12)", border: "1px solid rgba(16,185,129,0.3)",
          }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: UI.success }} />
            {planStatus}
          </span>
        </div>
        <p style={{ margin: "0 0 14px", fontSize: 12, color: UI.textSec, lineHeight: 1.5 }}>
          {paid ? t("billing.paidDesc") : t("billing.freeDesc")}
        </p>
        {paid ? (
          <button type="button" disabled style={{
            padding: "9px 15px", borderRadius: 9, background: UI.surface2, border: `1px solid ${UI.border}`,
            color: UI.textMuted, fontSize: 12, fontWeight: 700, cursor: "not-allowed",
          }}>{t("billing.manageBilling")}</button>
        ) : (
          <Link href={PRICING_PATH} data-testid="billing-upgrade-button" style={{
            display: "inline-flex", alignItems: "center", gap: 7,
            padding: "9px 16px", borderRadius: 9, background: UI.gradient,
            color: "#fff", textDecoration: "none", fontSize: 12, fontWeight: 800,
          }}>
            {t("billing.upgradePlan")} <ArrowUpRight size={13} />
          </Link>
        )}
      </SectionCard>

      <SectionCard testId="billing-token-balance">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <SectionTitle>{t("billing.tokenBalance")}</SectionTitle>
          <Link href={PRICING_PATH} style={{ fontSize: 12, color: UI.blue, textDecoration: "none", fontWeight: 700 }}>
            {t("billing.aboutTokens")} ↗
          </Link>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
          <div style={{
            width: 36, height: 36, borderRadius: "50%",
            background: "rgba(59,130,246,0.15)", border: "1px solid rgba(59,130,246,0.3)",
            display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
          }}>
            <Zap size={16} style={{ color: "#60A5FA" }} />
          </div>
          <span style={{ fontSize: 28, fontWeight: 800, color: UI.text }}>{loaded ? summary.tokenBalance : "…"}</span>
          <span style={{ fontSize: 13, color: UI.textSec }}>{t("billing.tokensAvailable")}</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
          {[
            { label: t("billing.usedThisMonth"), value: loaded ? String(summary.usedThisMonth ?? "—") : "—" },
            { label: t("billing.remaining"),     value: loaded ? String(summary.tokenBalance) : "—" },
            { label: t("billing.lastActivity"),  value: lastActivity ?? "—" },
          ].map(({ label, value }) => (
            <div key={label} style={{ padding: "10px 12px", borderRadius: 10, background: UI.surface2, border: `1px solid ${UI.border}` }}>
              <p style={{ margin: "0 0 3px", fontSize: 10, fontWeight: 700, color: UI.textMuted, textTransform: "uppercase", letterSpacing: "0.04em" }}>{label}</p>
              <p style={{ margin: 0, fontSize: 13, fontWeight: 700, color: UI.textSec }}>{value}</p>
            </div>
          ))}
        </div>
      </SectionCard>

      <SectionCard testId="billing-usage-history">
        <SectionTitle>{t("billing.usageHistory")}</SectionTitle>
        <div style={{ display: "flex", alignItems: "center", gap: 9, color: UI.textMuted, padding: "4px 0" }}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
          </svg>
          <p style={{ margin: 0, fontSize: 12, lineHeight: 1.5 }}>
            {t("billing.noUsage")}
          </p>
        </div>
      </SectionCard>

      <SectionCard testId="billing-need-help">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <div>
            <p style={{ margin: "0 0 2px", fontSize: 13, fontWeight: 700, color: UI.text }}>{t("billing.needHelp")}</p>
            <p style={{ margin: 0, fontSize: 11.5, color: UI.textSec }}>{t("billing.needHelpDesc")}</p>
          </div>
          <button
            type="button"
            data-testid="billing-contact-support-button"
            onClick={() => setSupportOpen(true)}
            style={{ padding: "8px 14px", borderRadius: 9, border: `1px solid ${UI.border}`, background: UI.surface2, color: UI.text, fontSize: 12, fontWeight: 700, cursor: "pointer", flexShrink: 0 }}
          >
            {t("billing.contactSupport")}
          </button>
        </div>
      </SectionCard>

      <ContactSupportModal
        open={supportOpen}
        onClose={() => setSupportOpen(false)}
        source="billing"
        defaultCategory="billing_or_subscription"
        defaultSubject="Billing question"
        extraContext={{
          plan: planName,
          paymentStatus: summary.planStatus,
          billingPageUrl: typeof window !== "undefined" ? window.location.href : null,
        }}
      />
    </div>
  );
}

// ── Pinterest Tab ─────────────────────────────────────────────────────────────

/**
 * Safe, non-secret sandbox / provider diagnostics — Developer tools only. Makes the
 * "provider configured vs user connected" distinction visible: a sandbox token can
 * make `canAttemptSandboxPublish` true without the user having any connection. Never
 * shows tokens (only presence booleans).
 */
function SandboxDiagnostics() {
  const [debug, setDebug] = useState<PinterestDebugStatus | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    fetchPinterestDebugStatus().then(setDebug).catch(() => setFailed(true));
  }, []);

  const rows: [string, string][] = debug
    ? [
        ["API environment", debug.apiEnv],
        ["Sandbox token present", debug.sandboxTokenPresent ? "Yes" : "No"],
        ["Can attempt sandbox publish", debug.canAttemptSandboxPublish ? "Yes" : "No"],
        ["Standard access required", debug.standardAccessRequired ? "Yes" : "No"],
      ]
    : [];

  return (
    <section
      data-testid="pinterest-sandbox-diagnostics"
      style={{ border: `1px solid ${UI.border}`, borderRadius: 12, padding: "12px 14px", background: UI.surface2 }}
    >
      <p style={{ margin: 0, fontSize: 12.5, fontWeight: 700, color: UI.text }}>Provider diagnostics</p>
      <p style={{ margin: "2px 0 10px", fontSize: 11, color: UI.textSec }}>
        Sandbox / provider config only — this is not a user connection.
      </p>
      {failed ? (
        <p style={{ margin: 0, fontSize: 12, color: UI.warning }}>Could not load diagnostics.</p>
      ) : !debug ? (
        <p style={{ margin: 0, display: "flex", alignItems: "center", gap: 7, fontSize: 12, color: UI.textSec }}>
          <Loader2 size={13} className="animate-spin" /> Loading…
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
          {rows.map(([k, v]) => (
            <div key={k} style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
              <span style={{ color: UI.textSec }}>{k}</span>
              <span style={{ color: UI.text, fontWeight: 600 }}>{v}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * Safe connection diagnostics — Developer tools only. Surfaces the technical status
 * detail (env, connection source, last fetch time, and the raw safe fetch error)
 * that the normal Pinterest card deliberately hides. Never shows tokens/secrets.
 */
function StatusDiagnostics({ status, statusError, lastFetchAt }: {
  status: PinterestStatus | null;
  statusError: string | null;
  lastFetchAt: number | null;
}) {
  const rows: [string, string][] = [
    ["API environment", status?.apiEnv ?? status?.environment ?? "unknown"],
    ["Connection source", status?.connectionSource ?? "none"],
    ["Needs reconnect", status?.needsReconnect ? "Yes" : "No"],
    ["Last status fetch", lastFetchAt ? new Date(lastFetchAt).toLocaleTimeString() : "—"],
    ["Status fetch error", statusError ?? "none"],
  ];
  return (
    <section
      data-testid="pinterest-status-diagnostics"
      style={{ border: `1px solid ${UI.border}`, borderRadius: 12, padding: "12px 14px", background: UI.surface2 }}
    >
      <p style={{ margin: 0, fontSize: 12.5, fontWeight: 700, color: UI.text }}>Connection diagnostics</p>
      <p style={{ margin: "2px 0 10px", fontSize: 11, color: UI.textSec }}>Technical status detail — not shown to normal users.</p>
      <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
        {rows.map(([k, v]) => (
          <div key={k} style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 12 }}>
            <span style={{ color: UI.textSec }}>{k}</span>
            <span style={{ color: k === "Status fetch error" && statusError ? UI.warning : UI.text, fontWeight: 600, textAlign: "right", wordBreak: "break-word" }}>{v}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function PinterestTabContent() {
  const [pinterestStatus, setPinterestStatus] = useState<PinterestStatus | null>(null);
  const [pinterestLoaded, setPinterestLoaded] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [lastFetchAt, setLastFetchAt] = useState<number | null>(null);
  const [devToolsOpen, setDevToolsOpen] = useState(false);

  useEffect(() => {
    fetchPinterestStatus()
      .then(s => { setPinterestStatus(s); setStatusError(null); setLastFetchAt(Date.now()); setPinterestLoaded(true); })
      .catch((e: PinterestClientError) => {
        // Keep the debug detail here; the normal card never shows this.
        setPinterestStatus({
          connected: !!e.needsReconnect,
          account: null, scopes: [],
          needsReconnect: !!e.needsReconnect,
        });
        setStatusError(e.message || e.code || "status fetch failed");
        setLastFetchAt(Date.now());
        setPinterestLoaded(true);
      });
  }, []);

  const visualState = pinterestLoaded ? derivePinterestSettingsState(pinterestStatus) : null;
  const isConnected = visualState === "connected" || visualState === "limited_access";
  // Sandbox concepts kept separate from a real user connection (see status route).
  const sandboxDemo = pinterestStatus?.connectionSource === "sandbox_demo";
  const sandboxEnv = (pinterestStatus?.apiEnv ?? pinterestStatus?.environment) === "sandbox";
  // Boards actually load (real connection, or sandbox token backing the publish path).
  const canLoadBoards = isConnected || sandboxDemo;
  // Board defaults, manual board sync, publishing-access detail, advanced setup, and
  // diagnostics are developer/debug surfaces. Normal users never see them — they live
  // behind a collapsed "Developer tools" section shown only outside production. Also
  // shown in sandbox mode, or when a status fetch error needs diagnosing.
  const showDevTools = isSocialDevToolsEnabled() && pinterestLoaded && (canLoadBoards || sandboxEnv || !!statusError);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
      <div data-testid="pinterest-connection-card">
        <PinterestSettingsPanel />
      </div>
      {showDevTools && (
        <div
          data-testid="pinterest-developer-tools"
          style={{ marginTop: 16, border: "1px solid var(--app-border)", borderRadius: 12, overflow: "hidden" }}
        >
          <button
            type="button"
            data-testid="pinterest-developer-tools-toggle"
            onClick={() => setDevToolsOpen(o => !o)}
            style={{
              display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%",
              padding: "12px 14px", border: "none", background: "transparent", cursor: "pointer", textAlign: "left",
            }}
          >
            <span style={{ fontSize: 12.5, fontWeight: 700, color: "var(--app-text-sec)" }}>Developer tools</span>
            <span style={{ fontSize: 11, color: "#5B6577" }}>{devToolsOpen ? "Hide" : "Show"}</span>
          </button>
          {devToolsOpen && (
            <div style={{ padding: "0 4px 6px", display: "flex", flexDirection: "column", gap: 12 }}>
              <StatusDiagnostics status={pinterestStatus} statusError={statusError} lastFetchAt={lastFetchAt} />
              {sandboxEnv && <SandboxDiagnostics />}
              {canLoadBoards && (
                <PinterestAdvancedSettings
                  limited={visualState === "limited_access"}
                  needsReconnect={!!pinterestStatus?.needsReconnect}
                />
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function PinterestTab() {
  return (
    <Suspense fallback={
      <PinterestTabFallback />
    }>
      <PinterestTabContent />
    </Suspense>
  );
}

function PinterestTabFallback() {
  const { t } = useLocale();
  return (
    <div style={{ padding: 40, textAlign: "center", fontSize: 13, color: UI.textSec, display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
      <Loader2 size={16} className="animate-spin" /> {t("pinterest.checkingConnection")}
    </div>
  );
}

// ── Publishing Tab ────────────────────────────────────────────────────────────

function PublishingTab({ saveFnRef }: { saveFnRef: React.MutableRefObject<(() => Promise<void>) | null> }) {
  const { t } = useLocale();
  const [prefs, setPrefs] = useState<PublishingPrefs>(() => defaultPublishingPrefs());

  useEffect(() => { setPrefs(getPublishingPrefs()); }, []);

  function patch(p: Partial<PublishingPrefs>) { setPrefs(prev => ({ ...prev, ...p })); }

  async function handleSave() {
    savePublishingPrefs(prefs);
    toast.success(t("toast.publishingSaved"));
  }
  saveFnRef.current = handleSave;

  const modeBtn = (mode: PublishingMode, label: string) => (
    <button type="button" onClick={() => patch({ defaultMode: mode })} style={{
      flex: 1, padding: "9px 0", borderRadius: 9,
      border: `1px solid ${prefs.defaultMode === mode ? "rgba(59,130,246,0.45)" : UI.border}`,
      background: prefs.defaultMode === mode ? "rgba(59,130,246,0.12)" : "transparent",
      color: prefs.defaultMode === mode ? UI.blue : UI.textSec,
      fontSize: 12, fontWeight: 700, cursor: "pointer",
    }}>{label}</button>
  );

  const fmtBtn = (fmt: PublishingFormat, label: string) => (
    <button type="button" onClick={() => patch({ defaultFormat: fmt })} style={{
      flex: 1, padding: "9px 0", borderRadius: 9,
      border: `1px solid ${prefs.defaultFormat === fmt ? "rgba(59,130,246,0.45)" : UI.border}`,
      background: prefs.defaultFormat === fmt ? "rgba(59,130,246,0.12)" : "transparent",
      color: prefs.defaultFormat === fmt ? UI.blue : UI.textSec,
      fontSize: 12, fontWeight: 700, cursor: "pointer",
    }}>{label}</button>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <SectionCard>
        <SectionTitle>{t("publishing.defaults")}</SectionTitle>
        <div style={{ marginBottom: 14 }}>
          <span style={labelCss}>{t("publishing.defaultMode")}</span>
          <div data-testid="publishing-mode" style={{ display: "flex", gap: 8 }}>
            {modeBtn("manual", t("publishing.modeManual"))}
            {modeBtn("smart", t("publishing.modeSmart"))}
          </div>
          <p style={{ margin: "5px 0 0", fontSize: 11, color: UI.textMuted }}>
            {prefs.defaultMode === "smart"
              ? t("publishing.modeSmartHint")
              : t("publishing.modeManualHint")}
          </p>
        </div>
        <div>
          <span style={labelCss}>{t("publishing.defaultFormat")}</span>
          <div data-testid="publishing-format" style={{ display: "flex", gap: 8 }}>
            {fmtBtn("standard", t("publishing.formatStandard"))}
            {fmtBtn("simplified", t("publishing.formatSimplified"))}
          </div>
          <p style={{ margin: "5px 0 0", fontSize: 11, color: UI.textMuted }}>
            {t("publishing.formatHint")}
          </p>
        </div>
      </SectionCard>

      <SectionCard>
        <SectionTitle>{t("publishing.safetyChecks")}</SectionTitle>
        <ToggleRow
          label={t("publishing.duplicateUrl")}
          description={t("publishing.duplicateUrlDesc")}
          on={prefs.duplicateUrlWarning}
          onClick={() => patch({ duplicateUrlWarning: !prefs.duplicateUrlWarning })}
          testId="publishing-duplicate-url-warning"
        />
        <ToggleRow
          label={t("publishing.showAltText")}
          description={t("publishing.showAltTextDesc")}
          on={prefs.showAltTextField}
          onClick={() => patch({ showAltTextField: !prefs.showAltTextField })}
          testId="publishing-show-alt-text"
        />
        <ToggleRow
          label={t("publishing.imageRefresh")}
          description={t("publishing.imageRefreshDesc")}
          on={prefs.imageRefresh}
          onClick={() => patch({ imageRefresh: !prefs.imageRefresh })}
          testId="publishing-image-refresh"
          noBorder
        />
      </SectionCard>
    </div>
  );
}

// ── Amazon Associates Tab ─────────────────────────────────────────────────────

const MARKETPLACE_LABELS: Record<AmazonMarketplace, string> = {
  US: "United States — amazon.com",
  UK: "United Kingdom — amazon.co.uk",
  CA: "Canada — amazon.ca",
  DE: "Germany — amazon.de",
  FR: "France — amazon.fr",
  IT: "Italy — amazon.it",
  ES: "Spain — amazon.es",
  AU: "Australia — amazon.com.au",
  JP: "Japan — amazon.co.jp",
};

function AmazonTab({ saveFnRef }: { saveFnRef: React.MutableRefObject<(() => Promise<void>) | null> }) {
  const { t } = useLocale();
  const [settings, setSettings] = useState<AmazonAffiliateSettings>(() => defaultAmazonAffiliateSettings());

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setSettings(getAmazonAffiliateSettings()); }, []);

  function patch(p: Partial<AmazonAffiliateSettings>) { setSettings(prev => ({ ...prev, ...p })); }

  async function handleSave() {
    saveAmazonAffiliateSettings(settings);
    toast.success(t("settings.amazon.saved"));
  }
  saveFnRef.current = handleSave;

  // MVP readiness: a tracking ID is the only requirement (marketplace always valid).
  const ready = !!settings.trackingId.trim();

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <SectionCard testId="amazon-affiliate-section">
        <SectionTitle>Amazon Associates</SectionTitle>
        <p style={{ margin: "-6px 0 14px", fontSize: 12, color: UI.textSec, lineHeight: 1.5 }}>
          {t("settings.amazon.desc")}
        </p>

        <div style={{ marginBottom: 14 }}>
          <span style={labelCss}>{t("settings.amazon.marketplace")}</span>
          <select data-testid="amazon-marketplace" value={settings.marketplace}
            onChange={e => patch({ marketplace: e.target.value as AmazonMarketplace })}
            style={{ ...field, cursor: "pointer" }}>
            {AMAZON_MARKETPLACES.map(m => <option key={m} value={m}>{MARKETPLACE_LABELS[m]}</option>)}
          </select>
        </div>

        <div>
          <span style={labelCss}>{t("settings.amazon.trackingId")}</span>
          <input data-testid="amazon-tracking-id" value={settings.trackingId}
            onChange={e => patch({ trackingId: e.target.value })}
            placeholder="yourtag-20"
            style={field} />
          <p style={{ margin: "5px 0 0", fontSize: 11, color: UI.textMuted }}>
            {t("settings.amazon.trackingIdHint")}
          </p>
        </div>

        <div data-testid="amazon-status" style={{
          marginTop: 16, display: "flex", alignItems: "center", gap: 7,
          fontSize: 12, fontWeight: 600, color: ready ? UI.success : UI.textSec,
        }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: ready ? UI.success : UI.textMuted }} />
          {ready
            ? t("settings.amazon.ready")
            : t("settings.amazon.notReady")}
        </div>
      </SectionCard>
    </div>
  );
}

// ── Smart Schedule Tab ────────────────────────────────────────────────────────
// Renders the shared SmartScheduleConfigForm so Settings → Smart Schedule and the
// Weekly Plan Smart Schedule modal read/write the exact same canonical config.

function SmartScheduleTab({ saveFnRef }: { saveFnRef: React.MutableRefObject<(() => Promise<void>) | null> }) {
  const ref = useRef<(() => void) | null>(null);
  useEffect(() => {
    saveFnRef.current = async () => { ref.current?.(); };
  }, [saveFnRef]);
  return <SmartScheduleConfigForm saveRef={ref} showBoards={false} />;
}

// ── AI Settings Tab ───────────────────────────────────────────────────────────

function AiSettingsTab({ saveFnRef, onOpenTab }: {
  saveFnRef: React.MutableRefObject<(() => Promise<void>) | null>;
  onOpenTab: (tab: SettingsTab) => void;
}) {
  const { draftPreferences, setDraftPreferences, savePreferences, t } = useLocale();

  // "Same as app language" + every supported app language (native label).
  const contentLanguageOptions: { value: ContentLanguageSetting; label: string }[] = [
    { value: "same", label: t("lang.sameAsApp") },
    ...ALL_APP_LANGUAGES.map(l => ({ value: l.code as ContentLanguageSetting, label: l.nativeLabel })),
  ];

  async function handleSave() {
    await savePreferences(draftPreferences);
    toast.success(t("toast.aiSettingsSaved"));
  }
  saveFnRef.current = handleSave;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <SectionCard>
        <SectionTitle>{t("ai.title")}</SectionTitle>
        <p style={{ margin: "-6px 0 14px", fontSize: 12, color: UI.textSec, lineHeight: 1.5 }}>
          {t("ai.desc")}
        </p>

        <div style={{ marginBottom: 16 }}>
          <span style={labelCss}>{t("ai.contentLanguage")}</span>
          <select data-testid="ai-settings-language"
            value={draftPreferences.contentLanguage}
            onChange={e => setDraftPreferences({ contentLanguage: e.target.value as ContentLanguageSetting })}
            style={{ ...field, cursor: "pointer" }}>
            {contentLanguageOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <p style={{ margin: "5px 0 0", fontSize: 11, color: UI.textMuted }}>
            {t("ai.contentLanguageHint")}
          </p>
          <p data-testid="ai-settings-content-existing-note" style={{ margin: "4px 0 0", fontSize: 11, color: UI.textMuted, fontStyle: "italic" }}>
            {t("language.contentExistingNote")}
          </p>
        </div>

        <div>
          <span style={labelCss}>{t("ai.region")}</span>
          <select data-testid="ai-settings-region"
            value={draftPreferences.pinterestRegion}
            onChange={e => setDraftPreferences({ pinterestRegion: e.target.value as PinterestRegionCode })}
            style={{ ...field, cursor: "pointer" }}>
            {PINTEREST_REGIONS.map(r => (
              <option key={r.code} value={r.code}>{t(r.labelKey as MessageKey)}</option>
            ))}
          </select>
          <p style={{ margin: "5px 0 0", fontSize: 11, color: UI.textMuted }}>
            {t("ai.regionHint")}
          </p>
        </div>
      </SectionCard>

      {/* Shortcut: App UI language lives on the dedicated Language tab. */}
      <div data-testid="ai-settings-language-shortcut" style={{
        display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
        padding: "12px 14px", borderRadius: 12,
        border: "1px solid rgba(59,130,246,0.28)", background: "rgba(59,130,246,0.08)",
      }}>
        <p style={{ margin: 0, fontSize: 12, color: UI.textSec, lineHeight: 1.5 }}>
          {t("ai.gotoLanguageNotice")}
        </p>
        <button type="button" data-testid="ai-settings-open-language"
          onClick={() => onOpenTab("language")}
          style={{
            flexShrink: 0, display: "inline-flex", alignItems: "center", gap: 6,
            padding: "8px 13px", borderRadius: 9, border: "1px solid rgba(59,130,246,0.4)",
            background: "rgba(59,130,246,0.14)", color: UI.blue, fontSize: 12, fontWeight: 700, cursor: "pointer",
          }}>
          {t("ai.openLanguageSettings")}
        </button>
      </div>
    </div>
  );
}

// ── Language Tab ──────────────────────────────────────────────────────────────

function LanguageTab({ saveFnRef }: { saveFnRef: React.MutableRefObject<(() => Promise<void>) | null> }) {
  const { draftPreferences, setDraftPreferences, savePreferences, t } = useLocale();

  const appLanguageOptions = ALL_APP_LANGUAGES.map(l => ({ value: l.code, label: l.nativeLabel }));
  const contentLanguageOptions: { value: ContentLanguageSetting; label: string }[] = [
    { value: "same", label: t("lang.sameAsApp") },
    ...ALL_APP_LANGUAGES.map(l => ({ value: l.code as ContentLanguageSetting, label: l.nativeLabel })),
  ];

  async function handleSave() {
    // savePreferences already shows a localized "language saved" toast in the
    // newly-selected language — no extra toast here (avoids a stale-language one).
    await savePreferences(draftPreferences);
  }
  saveFnRef.current = handleSave;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <SectionCard testId="language-section">
        <SectionTitle>{t("language.title")}</SectionTitle>
        <p style={{ margin: "-6px 0 14px", fontSize: 12, color: UI.textSec, lineHeight: 1.5 }}>
          {t("language.desc")}
        </p>

        <div style={{ marginBottom: 16 }}>
          <span style={labelCss}>{t("language.appLanguage")}</span>
          <select data-testid="language-app-language"
            value={draftPreferences.appLanguage}
            onChange={e => setDraftPreferences({ appLanguage: e.target.value as LanguageCode })}
            style={{ ...field, cursor: "pointer" }}>
            {appLanguageOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <p style={{ margin: "5px 0 0", fontSize: 11, color: UI.textMuted }}>
            {t("language.appLanguageHint")}
          </p>
          <p data-testid="language-app-existing-note" style={{ margin: "4px 0 0", fontSize: 11, color: UI.textMuted, fontStyle: "italic" }}>
            {t("language.appLanguageExistingNote")}
          </p>
        </div>

        <div>
          <span style={labelCss}>{t("language.aiContentLanguage")}</span>
          <select data-testid="language-content-language"
            value={draftPreferences.contentLanguage}
            onChange={e => setDraftPreferences({ contentLanguage: e.target.value as ContentLanguageSetting })}
            style={{ ...field, cursor: "pointer" }}>
            {contentLanguageOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <p style={{ margin: "5px 0 0", fontSize: 11, color: UI.textMuted }}>
            {t("language.aiContentLanguageHint")}
          </p>
          <p data-testid="language-content-existing-note" style={{ margin: "4px 0 0", fontSize: 11, color: UI.textMuted, fontStyle: "italic" }}>
            {t("language.contentExistingNote")}
          </p>
        </div>
      </SectionCard>
    </div>
  );
}

// ── Appearance Tab ────────────────────────────────────────────────────────────

const THEME_OPTIONS: {
  value: ThemePreference;
  labelKey: MessageKey;
  descKey: MessageKey;
  testId: string;
  icon: React.ComponentType<{ size?: number; style?: React.CSSProperties }>;
  // Mini-preview swatch colors (top bar, surface, accent).
  preview: { bg: string; surface: string; border: string; text: string };
}[] = [
  {
    value: "dark", labelKey: "theme.dark", descKey: "appearance.darkDesc",
    testId: "appearance-theme-dark", icon: Moon,
    preview: { bg: "#0B0E17", surface: "#161D2E", border: "rgba(255,255,255,0.10)", text: "#E2E8F0" },
  },
  {
    value: "light", labelKey: "theme.light", descKey: "appearance.lightDesc",
    testId: "appearance-theme-light", icon: Sun,
    preview: { bg: "#F8FAFC", surface: "#FFFFFF", border: "#E5E7EB", text: "#0F172A" },
  },
  {
    value: "system", labelKey: "theme.system", descKey: "appearance.systemDesc",
    testId: "appearance-theme-system", icon: Monitor,
    preview: { bg: "linear-gradient(135deg,#0B0E17 0 50%,#F8FAFC 50% 100%)", surface: "#94A3B8", border: "rgba(148,163,184,0.4)", text: "#94A3B8" },
  },
];

function AppearanceTab() {
  const { theme, resolvedTheme, setTheme } = useTheme();
  const { t } = useLocale();

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <SectionCard testId="preferences-appearance-section">
        <SectionTitle>{t("appearance.title")}</SectionTitle>
        <p style={{ margin: "-6px 0 14px", fontSize: 12, color: UI.textSec, lineHeight: 1.5 }}>
          {t("appearance.desc")}
        </p>

        <div
          role="radiogroup"
          aria-label={t("appearance.themeAria")}
          data-testid="appearance-theme-toggle"
          style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}
        >
          {THEME_OPTIONS.map(opt => {
            const active = theme === opt.value;
            const Icon = opt.icon;
            return (
              <button
                key={opt.value}
                type="button"
                role="radio"
                aria-checked={active}
                data-testid={opt.testId}
                onClick={() => setTheme(opt.value)}
                style={{
                  position: "relative", textAlign: "left", cursor: "pointer",
                  padding: 12, borderRadius: 12,
                  border: `1.5px solid ${active ? "rgba(59,130,246,0.55)" : UI.border}`,
                  background: active ? "rgba(59,130,246,0.10)" : "transparent",
                  transition: "border-color 0.12s, background 0.12s",
                }}
              >
                {active && (
                  <span style={{
                    position: "absolute", top: 10, right: 10, width: 18, height: 18, borderRadius: "50%",
                    background: "#3B82F6", display: "flex", alignItems: "center", justifyContent: "center",
                  }}>
                    <Check size={11} style={{ color: "#fff" }} strokeWidth={3} />
                  </span>
                )}
                {/* Mini preview */}
                <div style={{
                  height: 56, borderRadius: 8, marginBottom: 10, overflow: "hidden",
                  background: opt.preview.bg, border: `1px solid ${opt.preview.border}`,
                  position: "relative", display: "flex", alignItems: "flex-end", padding: 6, gap: 4,
                }}>
                  <div style={{ width: 14, height: "70%", borderRadius: 3, background: opt.preview.surface, border: `1px solid ${opt.preview.border}` }} />
                  <div style={{ flex: 1, height: "70%", borderRadius: 3, background: opt.preview.surface, border: `1px solid ${opt.preview.border}` }} />
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 3 }}>
                  <Icon size={14} style={{ color: active ? UI.blue : UI.textSec }} />
                  <span style={{ fontSize: 13, fontWeight: 700, color: active ? UI.text : UI.text }}>{t(opt.labelKey)}</span>
                </div>
                <p style={{ margin: 0, fontSize: 11, color: UI.textSec, lineHeight: 1.4 }}>{t(opt.descKey)}</p>
              </button>
            );
          })}
        </div>

        {theme === "system" && (
          <p style={{ margin: "12px 0 0", fontSize: 11.5, color: UI.textMuted, display: "flex", alignItems: "center", gap: 6 }}>
            <Monitor size={12} /> {t("appearance.followingDevice")} <strong style={{ color: UI.textSec, fontWeight: 700 }}>{resolvedTheme === "dark" ? t("theme.dark") : t("theme.light")}</strong>
          </p>
        )}
      </SectionCard>

      {/* Language lives on its own dedicated Language tab (not here) so the UI
          language control is easy to find. */}
      <SectionCard testId="appearance-language-pointer">
        <SectionTitle>{t("appearance.languageSection")}</SectionTitle>
        <p style={{ margin: "-6px 0 0", fontSize: 12, color: UI.textSec, lineHeight: 1.5 }}>
          {t("appearance.languageMovedHint")}
        </p>
      </SectionCard>
    </div>
  );
}

// ── Support Tab ───────────────────────────────────────────────────────────────

function SupportTab({ onClose }: { onClose: () => void }) {
  const { t } = useLocale();
  const pathname = usePathname();
  const router = useRouter();

  function goTo(href: string) {
    onClose();
    router.push(href);
  }

  async function copyDiagnosticInfo() {
    let email = "";
    let userId = "";
    try {
      const { data } = await supabase.auth.getUser();
      email  = data.user?.email ?? "";
      userId = data.user?.id    ?? "";
    } catch { /* ignore */ }
    const info = [
      `Page: ${pathname}`,
      `Browser: ${typeof navigator !== "undefined" ? navigator.userAgent : "unknown"}`,
      `Timezone: ${browserTimeZone()}`,
      `User: ${email || "not signed in"}`,
      `Workspace ID: ${userId || "—"}`,
      `Time: ${new Date().toISOString()}`,
    ].join("\n");
    try {
      await navigator.clipboard.writeText(info);
      toast.success(t("toast.diagnosticCopied"));
    } catch { toast.error(t("toast.couldNotCopyDiagnostic")); }
  }

  function SupportCard({ icon, title, description, children }: {
    icon: React.ReactNode; title: string; description: string; children: React.ReactNode;
  }) {
    return (
      <div style={{ display: "flex", gap: 13, padding: "15px 16px", borderRadius: 14, border: `1px solid ${UI.border}`, background: UI.surface, alignItems: "flex-start" }}>
        <div style={{ width: 34, height: 34, borderRadius: 9, flexShrink: 0, background: UI.surface2, border: `1px solid ${UI.border}`, display: "flex", alignItems: "center", justifyContent: "center" }}>
          {icon}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ margin: 0, fontSize: 13, fontWeight: 800, color: UI.text }}>{title}</p>
          <p style={{ margin: "3px 0 10px", fontSize: 12, color: UI.textSec, lineHeight: 1.5 }}>{description}</p>
          {children}
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <SupportCard icon={<LifeBuoy size={16} style={{ color: UI.textSec }} />}
        title="Help & Support"
        description="Browse help articles or contact our support team. Tickets get a reply by email.">
        <button type="button" data-testid="support-open-help-button" onClick={() => goTo("/app/help")} style={{
          display: "inline-flex", alignItems: "center", gap: 7, padding: "8px 14px",
          borderRadius: 9, border: "none", background: UI.gradient, color: "#fff",
          fontSize: 12, fontWeight: 800, cursor: "pointer",
        }}>
          <LifeBuoy size={13} /> Open Help &amp; Support
        </button>
      </SupportCard>

      <SupportCard icon={<TicketCheck size={16} style={{ color: UI.textSec }} />}
        title="My support tickets"
        description="See the status of tickets you've already opened.">
        <button type="button" data-testid="support-my-tickets-button" onClick={() => goTo("/app/support/tickets")} style={{
          display: "inline-flex", alignItems: "center", gap: 7, padding: "8px 14px", borderRadius: 9,
          border: `1px solid ${UI.border}`, background: "transparent", color: UI.text,
          fontSize: 12, fontWeight: 700, cursor: "pointer",
        }}>
          <TicketCheck size={13} /> View my tickets
        </button>
      </SupportCard>

      <SupportCard icon={<AlertCircle size={16} style={{ color: UI.textSec }} />}
        title={t("support.diagnosticTitle")}
        description={t("support.diagnosticDesc")}>
        <button type="button" data-testid="support-copy-diagnostic-info" onClick={copyDiagnosticInfo} style={{
          display: "inline-flex", alignItems: "center", gap: 7, padding: "8px 14px", borderRadius: 9,
          border: `1px solid ${UI.border}`, background: "transparent", color: UI.text,
          fontSize: 12, fontWeight: 700, cursor: "pointer",
        }}>
          <Copy size={13} /> {t("support.copyDiagnostic")}
        </button>
      </SupportCard>
    </div>
  );
}

// ── Tab list ──────────────────────────────────────────────────────────────────

// `labelKey` is translated; `label` is a literal kept for brand names
// ("Amazon Associates") that must not be localized.
const TABS: { id: SettingsTab; labelKey?: MessageKey; label?: string; testId: string }[] = [
  { id: "account",        labelKey: "settings.tab.account",       testId: "settings-tab-account" },
  { id: "billing",        labelKey: "settings.tab.billing",       testId: "settings-tab-billing" },
  { id: "pinterest",      labelKey: "settings.tab.pinterest",     testId: "settings-tab-pinterest" },
  { id: "social",         labelKey: "settings.tab.social",        testId: "settings-tab-social" },
  { id: "publishing",     labelKey: "settings.tab.publishing",    testId: "settings-tab-publishing" },
  { id: "amazon",         labelKey: "settings.tab.amazon",        testId: "settings-tab-amazon" },
  { id: "shopify",        label: "Shopify",                       testId: "settings-tab-shopify" },
  { id: "smart-schedule", labelKey: "settings.tab.smartSchedule", testId: "settings-tab-smart-schedule" },
  { id: "ai-settings",    labelKey: "settings.tab.aiSettings",    testId: "settings-tab-ai-settings" },
  { id: "appearance",     labelKey: "settings.tab.appearance",    testId: "settings-tab-appearance" },
  { id: "language",       labelKey: "settings.tab.language",      testId: "settings-tab-language" },
  { id: "support",        labelKey: "settings.tab.support",       testId: "settings-tab-support" },
];

// ── SettingsModal ─────────────────────────────────────────────────────────────

export function SettingsModal({
  open,
  initialTab = "account",
  onClose,
}: {
  open: boolean;
  initialTab?: SettingsTab;
  onClose: () => void;
}) {
  const { t } = useLocale();
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const accountSaveFn       = useRef<(() => Promise<void>) | null>(null);
  const publishingSaveFn    = useRef<(() => Promise<void>) | null>(null);
  const amazonSaveFn        = useRef<(() => Promise<void>) | null>(null);
  const smartScheduleSaveFn = useRef<(() => Promise<void>) | null>(null);
  const aiSettingsSaveFn    = useRef<(() => Promise<void>) | null>(null);
  const languageSaveFn      = useRef<(() => Promise<void>) | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => { if (open) setTab(initialTab); }, [open, initialTab]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape" && open) onClose(); }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const handleSave = useCallback(async () => {
    const fn = tab === "account"        ? accountSaveFn.current
             : tab === "publishing"     ? publishingSaveFn.current
             : tab === "amazon"         ? amazonSaveFn.current
             : tab === "smart-schedule" ? smartScheduleSaveFn.current
             : tab === "ai-settings"    ? aiSettingsSaveFn.current
             : tab === "language"       ? languageSaveFn.current
             : null;
    if (!fn) return;
    setSaving(true);
    try { await fn(); } finally { setSaving(false); }
  }, [tab]);

  const showSave = tab === "account" || tab === "publishing" || tab === "amazon" || tab === "smart-schedule" || tab === "ai-settings" || tab === "language";

  if (!open) return null;

  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 1000,
        display: "flex", alignItems: "center", justifyContent: "center",
        background: "rgba(15,23,42,0.45)", backdropFilter: "blur(2px)",
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        data-testid="settings-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t("settings.title")}
        style={{
          width: "min(920px, calc(100vw - 64px))",
          height: "78vh",
          maxHeight: 820,
          minHeight: 620,
          display: "flex",
          flexDirection: "column",
          background: "var(--app-shell-bg, #0B1120)",
          borderRadius: 20,
          border: `1px solid var(--app-border, rgba(255,255,255,0.10))`,
          boxShadow: "0 24px 64px rgba(0,0,0,0.5), 0 8px 24px rgba(0,0,0,0.3)",
          overflow: "hidden",
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{
          padding: "16px 22px 14px", borderBottom: `1px solid ${UI.border}`,
          display: "flex", alignItems: "flex-start", justifyContent: "space-between", flexShrink: 0,
        }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 16, fontWeight: 800, color: UI.text }}>{t("settings.title")}</h1>
            <p style={{ margin: "2px 0 0", fontSize: 12, color: UI.textSec }}>
              {t("settings.subtitle")}
            </p>
          </div>
          <button type="button" data-testid="settings-modal-close" onClick={onClose} aria-label={t("settings.closeAria")}
            style={{
              width: 30, height: 30, borderRadius: 8, border: `1px solid ${UI.border}`,
              background: "transparent", cursor: "pointer", flexShrink: 0,
              display: "flex", alignItems: "center", justifyContent: "center", color: UI.textSec,
            }}>
            <X size={15} />
          </button>
        </div>

        {/* Body */}
        <div style={{ display: "flex", flex: 1, minHeight: 0, overflow: "hidden" }}>
          {/* Sidebar — only real tabs, no phantom entries */}
          <div style={{
            width: 164, flexShrink: 0, borderRight: `1px solid ${UI.border}`,
            padding: "12px 8px", display: "flex", flexDirection: "column", gap: 2, overflowY: "auto",
          }}>
            {TABS.filter(tabItem => tabItem.id !== "shopify" || isShopifyIntegrationEnabled()).map(tabItem => {
              const active = tab === tabItem.id;
              return (
                <button key={tabItem.id} type="button" data-testid={tabItem.testId} onClick={() => setTab(tabItem.id)}
                  style={{
                    display: "block", width: "100%", textAlign: "left",
                    padding: "9px 12px", borderRadius: 9, border: "none",
                    fontSize: 13, fontWeight: active ? 700 : 500, cursor: "pointer",
                    background: active ? "rgba(59,130,246,0.12)" : "transparent",
                    color: active ? UI.blue : UI.textSec,
                    transition: "background 0.12s, color 0.12s",
                    whiteSpace: "nowrap", overflow: "hidden", textOverflow: "clip",
                  }}>
                  {tabItem.labelKey ? t(tabItem.labelKey) : tabItem.label}
                </button>
              );
            })}
          </div>

          {/* Content */}
          <div style={{ flex: 1, overflowY: "auto", padding: "18px 20px 52px", minWidth: 0 }}>
            {tab === "account"        && <AccountTab       saveFnRef={accountSaveFn} />}
            {tab === "billing"        && <BillingTab />}
            {tab === "pinterest"      && <PinterestTab />}
            {tab === "social"         && <SocialAccountsPanel />}
            {tab === "publishing"     && <PublishingTab    saveFnRef={publishingSaveFn} />}
            {tab === "amazon"         && <AmazonTab        saveFnRef={amazonSaveFn} />}
            {/* Rendered whenever the tab is active, regardless of the flag: launch/callback
                routes are never flag-gated (§8.4), so a real OAuth return can land here even
                with the UI flag off. The flag only gates discoverability (TABS filter above,
                picker/StudioBoard entry points) — never a real, already-connected state. */}
            {tab === "shopify"        && <ShopifyTab />}
            {tab === "smart-schedule" && <SmartScheduleTab saveFnRef={smartScheduleSaveFn} />}
            {tab === "ai-settings"    && <AiSettingsTab    saveFnRef={aiSettingsSaveFn} onOpenTab={setTab} />}
            {tab === "appearance"     && <AppearanceTab />}
            {tab === "language"       && <LanguageTab      saveFnRef={languageSaveFn} />}
            {tab === "support"        && <SupportTab onClose={onClose} />}
          </div>
        </div>

        {/* Footer */}
        <div style={{
          padding: "12px 20px", borderTop: `1px solid ${UI.border}`,
          display: "flex", justifyContent: "flex-end", gap: 10, flexShrink: 0,
        }}>
          <button type="button" data-testid="settings-cancel" onClick={onClose}
            style={{
              padding: "9px 18px", borderRadius: 10, border: `1px solid ${UI.border}`,
              background: "transparent", color: UI.textSec, fontSize: 13, fontWeight: 600, cursor: "pointer",
            }}>
            {t("common.cancel")}
          </button>
          {showSave && (
            <button type="button" data-testid="settings-save" onClick={() => void handleSave()} disabled={saving}
              style={{
                padding: "9px 20px", borderRadius: 10, border: "none",
                background: saving ? "rgba(255,255,255,0.1)" : UI.gradient,
                color: saving ? UI.textSec : "#fff", fontSize: 13, fontWeight: 700,
                cursor: saving ? "not-allowed" : "pointer",
                display: "flex", alignItems: "center", gap: 7,
              }}>
              {saving ? <><Loader2 size={13} className="animate-spin" /> {t("common.saving")}</> : t("common.saveChanges")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
