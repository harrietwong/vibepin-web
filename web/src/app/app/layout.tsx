"use client";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import {
  Sparkles, ClipboardList, Clock,
  BarChart2, Compass, ShoppingBag, Settings, Target,
  User, CreditCard, HelpCircle, LogOut, Moon, Sun, Monitor,
} from "lucide-react";
import { createBrowserClient } from "@supabase/ssr";
import { LocaleProvider, useLocale } from "@/lib/i18n/LocaleProvider";
import { LanguageRegionModal } from "@/components/settings/LanguageRegionModal";
import type { MessageKey } from "@/lib/i18n/messages/en";
import BrandLogo from "@/components/BrandLogo";
import {
  SETTINGS_DEFAULT_PATH,
} from "@/lib/settingsPaths";
import { SettingsModal, type SettingsTab } from "@/components/settings/SettingsModal";
import { ThemeProvider, useTheme } from "@/lib/theme/ThemeProvider";
import type { ThemePreference } from "@/lib/theme/themeStore";
import { TopbarLanguageTheme } from "@/components/app/TopbarLanguageTheme";
import { AssistantProvider } from "@/lib/assistant/AssistantProvider";
import { AssistantLauncher } from "@/components/assistant/AssistantLauncher";
import { AssistantPanel } from "@/components/assistant/AssistantPanel";
import { useSessionUser } from "@/lib/useSessionUser";
import { markNavClick, markRouteVisible } from "@/lib/navTiming";
import { initPinDraftSync } from "@/lib/pinDraftSync";
import { initAllUserStoreSync } from "@/lib/userStoreSyncRegistry";
import { SyncStatusIndicator } from "@/components/sync/SyncStatusIndicator";

const supabase = createBrowserClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
);

type NavItem = {
  id:       string;
  href:     string;
  icon:     React.ComponentType<{ style?: React.CSSProperties }>;
  labelKey?: MessageKey;
  label?:    string;
  matchFn:  (p: string) => boolean;
  superAdminOnly?: boolean;
};

const NAV_ITEMS: NavItem[] = [
  { id: "create-pins",    href: "/app/studio",               icon: Sparkles,      labelKey: "nav.createPins",     matchFn: (p) => p === "/app/studio" || p.startsWith("/app/studio/") },
  { id: "weekly-plan",    href: "/app/plan",                 icon: ClipboardList, labelKey: "nav.weeklyPlan",     matchFn: (p) => p === "/app/plan" || p.startsWith("/app/plan/") },
  { id: "my-pins",        href: "/app/history",              icon: Clock,         labelKey: "nav.myPins",         matchFn: (p) => p === "/app/history" || p.startsWith("/app/history/") },
  // Opportunities = the keyword-opportunity workspace page. matchFn covers the full
  // /app/workspace/* prefix so the item stays highlighted on any category.
  { id: "opportunities",  href: "/app/workspace/home-decor", icon: Target,        labelKey: "nav.opportunities",  matchFn: (p) => p.startsWith("/app/workspace") },
  { id: "keyword-trends", href: "/app/trends",               icon: BarChart2,     labelKey: "nav.keywordTrends",  matchFn: (p) => p === "/app/trends" || p.startsWith("/app/trends/") },
  { id: "viral-pins",     href: "/app/discover",             icon: Compass,       labelKey: "nav.pinIdeas",       matchFn: (p) => p === "/app/discover" || p.startsWith("/app/discover/") },
  { id: "product-ideas",  href: "/app/products",             icon: ShoppingBag,   labelKey: "nav.productIdeas",   matchFn: (p) => p === "/app/products" || p.startsWith("/app/products/") },
  // NOTE: Internal admin pages (/app/admin, /app/admin/visual-review) are
  // intentionally NOT surfaced in the client sidebar — access them by direct
  // URL only. Do not add Admin / Visual Review nav entries here, even
  // super-admin-only ones. The routes and their auth gate remain unchanged.
  { id: "settings",       href: SETTINGS_DEFAULT_PATH,       icon: Settings,      labelKey: "nav.settings",       matchFn: (p) => p.startsWith("/app/settings") || p === "/settings" || p.startsWith("/settings/") },
  // Official Customer Support MVP entry point (Help & Support page -> Contact
  // Support form -> ticket -> admin reply -> email). Do NOT point this at the
  // Ask VibePin assistant — that's a separate, currently-disabled AI page
  // assistant, not customer support.
  { id: "help-support",   href: "/app/help",                 icon: HelpCircle,    labelKey: "nav.helpSupport",    matchFn: (p) => p.startsWith("/app/help") || p.startsWith("/app/support") },
];


// ── Sidebar nav item (compact icon-only + hover tooltip) ─────────────────────────
// The sidebar is icon-only by default; the text label lives in `data-sidebar-label`
// (hidden by CSS on the compact rail) and is re-surfaced on hover as a fixed-position
// tooltip to the RIGHT of the icon. Fixed positioning escapes the nav's overflow
// clipping and never shifts layout. Kept at module scope so the React Compiler
// doesn't treat it as a component created during render.

const NAV_TOOLTIP: React.CSSProperties = {
  position: "fixed", transform: "translateY(-50%)", whiteSpace: "nowrap",
  padding: "6px 11px", borderRadius: 8,
  background: "var(--app-dropdown-bg)", border: "1px solid var(--app-dropdown-border)",
  color: "var(--app-text)", fontSize: 12, fontWeight: 700,
  boxShadow: "0 8px 24px rgba(0,0,0,0.4)", zIndex: 1000, pointerEvents: "none",
};

function SidebarNavItem({ item, active, label }: { item: NavItem; active: boolean; label: string }) {
  const [tip, setTip] = useState<{ top: number; left: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const Icon = item.icon;

  const show = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setTip({ top: r.top + r.height / 2, left: r.right + 10 });
  }, []);

  return (
    <Link
      href={item.href}
      aria-label={label}
      data-testid={`nav-${item.id}`}
      style={{ textDecoration: "none" }}
      onClick={() => markNavClick(item.href)}
    >
      <div
        ref={ref}
        data-sidebar-nav-item=""
        style={{
          display: "flex", alignItems: "center",
          gap: 12, padding: "10px 12px", minHeight: 42, borderRadius: 12,
          background: active ? "linear-gradient(135deg, var(--app-nav-active-bg), rgba(139,92,246,0.08))" : "transparent",
          border: active ? "1px solid rgba(139,92,246,0.18)" : "1px solid transparent",
          cursor: "pointer", transition: "background 0.12s, border-color 0.12s, color 0.12s",
        }}
        onMouseEnter={e => { show(); if (!active) e.currentTarget.style.background = "var(--app-nav-hover-bg)"; }}
        onMouseLeave={e => { setTip(null); if (!active) e.currentTarget.style.background = "transparent"; }}
      >
        <Icon style={{ width: 19, height: 19, color: active ? "var(--app-brand)" : "var(--app-nav-text)", flexShrink: 0 }} />
        <span data-sidebar-label="" style={{
          fontSize: "13px", fontWeight: active ? 750 : 600,
          color: active ? "var(--app-nav-text-active)" : "var(--app-nav-text)",
          lineHeight: 1.2,
          whiteSpace: "normal", overflow: "hidden", textOverflow: "ellipsis",
        }}>{label}</span>
      </div>
      {tip && (
        <span role="tooltip" style={{ ...NAV_TOOLTIP, top: tip.top, left: tip.left }}>{label}</span>
      )}
    </Link>
  );
}

// ── User dropdown item ─────────────────────────────────────────────────────────

const BASE_ITEM: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 10,
  padding: "9px 14px", cursor: "pointer", fontSize: "13px",
  color: "var(--app-dropdown-text)", background: "none", border: "none",
  width: "100%", textAlign: "left",
};

function DropdownItem({ icon: Icon, label, right, onClick, danger, testId }: {
  icon: React.ComponentType<{ style?: React.CSSProperties }>;
  label: React.ReactNode;
  right?: React.ReactNode;
  onClick?: () => void;
  danger?: boolean;
  testId?: string;
}) {
  const [hov, setHov] = useState(false);
  return (
    <button
      type="button"
      data-testid={testId}
      style={{
        ...BASE_ITEM,
        color: danger ? (hov ? "#F87171" : "#EF4444") : "var(--app-dropdown-text)",
        background: hov ? (danger ? "rgba(239,68,68,0.07)" : "var(--app-dropdown-hover)") : "none",
      }}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      onClick={onClick}
    >
      <Icon style={{ width: 15, height: 15, color: danger ? "currentColor" : "var(--app-dropdown-muted)", flexShrink: 0 }} />
      <span style={{ flex: 1 }}>{label}</span>
      {right}
    </button>
  );
}

// Pinterest icon (lucide doesn't include it; use a small inline SVG wrapper)
function PinterestMark({ style }: { style?: React.CSSProperties }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" style={{ width: 15, height: 15, color: "var(--app-dropdown-muted)", flexShrink: 0, ...style }}>
      <path d="M12 0C5.373 0 0 5.373 0 12c0 5.084 3.163 9.426 7.627 11.174-.105-.949-.2-2.403.042-3.441.218-.937 1.407-5.965 1.407-5.965s-.359-.719-.359-1.782c0-1.668.967-2.914 2.171-2.914 1.023 0 1.518.769 1.518 1.69 0 1.029-.655 2.568-.994 3.995-.283 1.194.599 2.169 1.777 2.169 2.133 0 3.772-2.249 3.772-5.495 0-2.873-2.064-4.882-5.012-4.882-3.414 0-5.418 2.561-5.418 5.207 0 1.031.397 2.138.893 2.738a.36.36 0 01.083.345l-.333 1.36c-.053.22-.174.267-.402.161-1.499-.698-2.436-2.889-2.436-4.649 0-3.785 2.75-7.262 7.929-7.262 4.163 0 7.398 2.967 7.398 6.931 0 4.136-2.607 7.464-6.227 7.464-1.216 0-2.359-.631-2.75-1.378l-.748 2.853c-.271 1.043-1.002 2.35-1.492 3.146C9.57 23.812 10.763 24 12 24c6.627 0 12-5.373 12-12S18.627 0 12 0z" />
    </svg>
  );
}

// ── User dropdown ──────────────────────────────────────────────────────────────

const THEME_OPTS: { id: ThemePreference; Icon: React.ComponentType<{ style?: React.CSSProperties }> }[] = [
  { id: "dark",   Icon: Moon    },
  { id: "light",  Icon: Sun     },
  { id: "system", Icon: Monitor },
];

function UserDropdown({ email, onLogout, onClose, onOpenSettings }: {
  email: string | null;
  onLogout: () => Promise<void>;
  onClose: () => void;
  onOpenSettings: (tab: SettingsTab) => void;
}) {
  const router = useRouter();
  const { theme, setTheme } = useTheme();
  const { t } = useLocale();

  function openSettings(tab: SettingsTab) {
    onClose();
    onOpenSettings(tab);
  }

  function navigate(href: string) {
    onClose();
    router.push(href);
  }

  return (
    <>
      <div style={{ position: "fixed", inset: 0, zIndex: 499 }} onClick={onClose} />
      <div
        data-testid="account-menu"
        style={{
          position: "absolute", top: "calc(100% + 8px)", right: 0,
          width: 276, background: "var(--app-dropdown-bg)",
          borderRadius: 14, border: "1px solid var(--app-dropdown-border)",
          boxShadow: "0 16px 48px rgba(0,0,0,0.45), 0 4px 16px rgba(0,0,0,0.3)",
          zIndex: 500, overflow: "hidden",
        }}
      >
        {/* Header */}
        <div style={{ padding: "14px 16px 10px", borderBottom: "1px solid var(--app-border)" }}>
          <p style={{ margin: 0, fontSize: "14px", fontWeight: 700, color: "var(--app-text)" }}>
            {email ?? t("account.myAccount")}
          </p>
          {email && <p style={{ margin: "2px 0 0", fontSize: "11px", color: "var(--app-text-muted)" }}>{email}</p>}
        </div>

        <div style={{ padding: "5px 0" }}>
          <DropdownItem
            icon={User}
            label={t("account.accountSettings")}
            testId="account-menu-account"
            onClick={() => openSettings("account")}
          />
          <DropdownItem
            icon={CreditCard}
            label={t("account.billing")}
            testId="account-menu-billing"
            onClick={() => openSettings("billing")}
          />

          <div style={{ height: 1, background: "var(--app-border)", margin: "4px 0" }} />

          <DropdownItem
            icon={PinterestMark}
            label={t("account.pinterest")}
            testId="account-menu-pinterest"
            onClick={() => openSettings("pinterest")}
          />

          <DropdownItem
            icon={HelpCircle}
            label={t("account.support")}
            onClick={() => navigate("/app/help")}
          />

          {/* Appearance toggle */}
          <div style={{ padding: "6px 14px 8px", borderTop: "1px solid var(--app-border)" }}>
            <p style={{ margin: "0 0 6px", fontSize: 10, fontWeight: 600, color: "var(--app-dropdown-muted)", textTransform: "uppercase", letterSpacing: "0.07em" }}>
              {t("account.appearance")}
            </p>
            <div style={{ display: "flex", gap: 4 }}>
              {THEME_OPTS.map(({ id, Icon }) => {
                const active = theme === id;
                return (
                  <button
                    key={id}
                    type="button"
                    data-testid={`theme-toggle-${id}`}
                    onClick={() => setTheme(id)}
                    style={{
                      flex: 1, display: "flex", flexDirection: "column", alignItems: "center",
                      gap: 3, padding: "6px 0", borderRadius: 8, cursor: "pointer",
                      background: active ? "rgba(59,130,246,0.13)" : "transparent",
                      border: `1px solid ${active ? "rgba(59,130,246,0.32)" : "var(--app-border)"}`,
                      color: active ? "#60A5FA" : "var(--app-dropdown-muted)",
                    }}
                  >
                    <Icon style={{ width: 13, height: 13 }} />
                    <span style={{ fontSize: 9, fontWeight: 700 }}>{t(`theme.${id}` as MessageKey)}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div style={{ height: 1, background: "var(--app-border)", margin: "4px 0" }} />

          <DropdownItem icon={LogOut} label={t("account.signOut")} danger onClick={onLogout} />
        </div>
      </div>
    </>
  );
}

// ── App Layout ─────────────────────────────────────────────────────────────────

function AppLayoutInner({ children }: { children: React.ReactNode }) {
  const path   = usePathname();
  const router = useRouter();
  const { t }  = useLocale();
  const { user: sessionUser } = useSessionUser();
  const userEmail = sessionUser?.email ?? null;
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab,  setSettingsTab]  = useState<SettingsTab>("account");
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);
  const avatarRef = useRef<HTMLDivElement>(null);

  const navItems = useMemo(
    () => NAV_ITEMS
      .filter(item => !item.superAdminOnly || isSuperAdmin)
      .filter((item, idx, arr) => arr.findIndex(i => i.id === item.id) === idx),
    [isSuperAdmin],
  );

  useEffect(() => {
    fetch("/api/admin/me", { credentials: "include" })
      .then(resp => setIsSuperAdmin(resp.ok))
      .catch(() => setIsSuperAdmin(false));
  }, []);

  // WP0: server-authoritative Pin Draft persistence — write-through engine.
  // initPinDraftSync is idempotent and SSR-safe; failures degrade to the
  // existing pure-localStorage behaviour (outbox retries in the background).
  useEffect(() => {
    const getToken = async () =>
      (await supabase.auth.getSession()).data.session?.access_token ?? null;
    initPinDraftSync(getToken);
    // WP-B: account-level sync for the settings/prefs + local caches (schedule,
    // notifications, publishing, brand, affiliate, niches, bookmarks, pin metadata,
    // pin sessions/records). Same token; same degrade-to-localStorage guarantees.
    initAllUserStoreSync(getToken);
  }, []);

  // Dev-only nav timing: log once the new route has committed.
  useEffect(() => {
    markRouteVisible(path);
  }, [path]);

  // NOTE: a manual `router.prefetch()` sweep over NAV_ITEMS was tried here as
  // prefetch insurance on top of Link's own viewport-based auto-prefetch, but
  // it caused "Router action dispatched before initialization" and left the
  // Plan page stuck on its loading skeleton — the effect could re-fire mid
  // client-side transition (its deps included the `router` object and the
  // `navItems` memo) and raced the App Router's internal dispatcher. Removed;
  // `Link` already prefetches every sidebar route since the icons are always
  // in the viewport, so this manual sweep wasn't buying anything real.

  // Auto-open modal when navigating to /app/settings* routes
  /* eslint-disable react-hooks/set-state-in-effect -- Route-driven settings modal sync is intentional in the app shell. */
  useEffect(() => {
    if (path.startsWith("/app/settings/billing")) {
      setSettingsTab("billing"); setSettingsOpen(true);
    } else if (path.startsWith("/app/settings/pinterest")) {
      setSettingsTab("pinterest"); setSettingsOpen(true);
    } else if (path.startsWith("/app/settings/shopify")) {
      setSettingsTab("shopify"); setSettingsOpen(true);
    } else if (path.startsWith("/app/settings/social")) {
      setSettingsTab("social"); setSettingsOpen(true);
    } else if (path.startsWith("/app/settings/publishing") || path.startsWith("/app/settings/scheduler")) {
      setSettingsTab("publishing"); setSettingsOpen(true);
    } else if (path.startsWith("/app/settings/smart-schedule")) {
      setSettingsTab("smart-schedule"); setSettingsOpen(true);
    } else if (path.startsWith("/app/settings/language")) {
      setSettingsTab("language"); setSettingsOpen(true);
    } else if (
      path.startsWith("/app/settings/ai-settings") ||
      path.startsWith("/app/settings/ai-brand") ||
      path.startsWith("/app/settings/ai") ||
      path.startsWith("/app/settings/preferences")
    ) {
      setSettingsTab("ai-settings"); setSettingsOpen(true);
    } else if (path.startsWith("/app/settings/support")) {
      setSettingsTab("support"); setSettingsOpen(true);
    } else if (
      path.startsWith("/app/settings/workspace") ||
      path.startsWith("/app/settings/profile")
    ) {
      setSettingsTab("account"); setSettingsOpen(true);
    } else if (path.startsWith("/app/settings")) {
      setSettingsTab("account"); setSettingsOpen(true);
    }
  }, [path]);
  /* eslint-enable react-hooks/set-state-in-effect */

  async function handleLogout() {
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  const handleSettingsClose = useCallback(() => {
    setSettingsOpen(false);
    if (path.startsWith("/app/settings")) {
      router.push("/app");
    }
  }, [path, router]);

  function openSettings(tab: SettingsTab) {
    setSettingsTab(tab);
    setSettingsOpen(true);
  }

  const userInitial = userEmail ? userEmail[0].toUpperCase() : "V";

  return (
    <div style={{ display: "flex", overflow: "hidden", height: "100dvh", background: "var(--app-shell-bg)" }}>

      {/* ── Sidebar ── */}
      <aside
        data-testid="app-sidebar"
        className="app-sidebar"
        style={{
          width: 68, flexShrink: 0, height: "100dvh",
          display: "flex", flexDirection: "column",
          background: "var(--app-sidebar-bg)",
          borderRight: "1px solid var(--app-sidebar-border)",
          boxShadow: "inset -1px 0 0 rgba(255,255,255,0.015)",
        }}
      >
        {/* Logo */}
        <div style={{
          height: 64, display: "flex", alignItems: "center", justifyContent: "center",
          padding: "0 12px",
          borderBottom: "1px solid var(--app-sidebar-border)", flexShrink: 0,
        }}>
          <Link href="/app/studio" style={{ display: "flex", alignItems: "center", gap: 10, textDecoration: "none" }}>
            <BrandLogo size={32} />
            <span data-sidebar-label="" style={{ fontSize: 22, fontWeight: 800, letterSpacing: "-0.03em", color: "var(--app-text)" }}>VibePin</span>
          </Link>
        </div>

        {/* Nav */}
        <nav style={{ flex: 1, padding: "12px 12px", display: "flex", flexDirection: "column", gap: 4, overflowY: "auto" }}>
          {navItems.map(item => (
            <SidebarNavItem
              key={item.id}
              item={item}
              active={item.matchFn(path)}
              label={item.label ?? t(item.labelKey!)}
            />
          ))}
        </nav>

        <button
          type="button"
          onClick={() => openSettings("billing")}
          style={{
            margin: "0 8px 14px",
            padding: "9px 8px",
            borderRadius: 14,
            border: "1px solid var(--app-sidebar-border)",
            background: "var(--app-surface-2)",
            color: "var(--app-text)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 10,
            cursor: "pointer",
            textAlign: "left",
          }}
        >
          <span style={{
            width: 32, height: 32, borderRadius: "50%",
            display: "flex", alignItems: "center", justifyContent: "center",
            flexShrink: 0,
            background: "linear-gradient(135deg,#A855F7 0%,#7C3AED 100%)",
            color: "#fff", fontSize: 13, fontWeight: 800,
          }}>
            {userInitial}
          </span>
          <span data-sidebar-label="" style={{ minWidth: 0, flex: 1 }}>
            <span data-sidebar-label="" style={{ display: "block", fontSize: 13, fontWeight: 700, lineHeight: 1.15, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              Zoe
            </span>
          </span>
        </button>
      </aside>

      {/* ── Main area ── */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>

        {/* App top bar (token + avatar) */}
        <div style={{
          height: 40, flexShrink: 0,
          display: "flex", alignItems: "center", justifyContent: "flex-end",
          gap: 6, padding: "0 14px",
          background: "var(--app-topbar-bg)",
          borderBottom: "1px solid var(--app-sidebar-border)",
        }}>
          {/* WP-E: account-sync status (hidden when synced; dot+tooltip otherwise) */}
          <SyncStatusIndicator />

          {/* Top-right quick controls: App language + Theme (sync with Settings) */}
          <TopbarLanguageTheme />

          {/* Avatar */}
          <div ref={avatarRef} style={{ position: "relative" }}>
            <button
              data-testid="account-menu-trigger"
              type="button"
              onClick={() => setDropdownOpen(v => !v)}
              style={{
                width: 28, height: 28, borderRadius: "50%",
                background: "linear-gradient(135deg,#FF4D8D 0%,#7C3AED 100%)",
                border: dropdownOpen ? "2px solid #3B82F6" : "2px solid rgba(255,255,255,0.15)",
                cursor: "pointer",
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: "11px", fontWeight: 700, color: "#fff",
                transition: "border-color 0.15s",
              }}
            >
              {userInitial}
            </button>
            {dropdownOpen && (
              <UserDropdown
                email={userEmail}
                onLogout={async () => { await handleLogout(); setDropdownOpen(false); }}
                onClose={() => setDropdownOpen(false)}
                onOpenSettings={(tab) => { setDropdownOpen(false); openSettings(tab); }}
              />
            )}
          </div>
        </div>

        {/* Page content */}
        <div style={{ flex: 1, overflow: "hidden", minHeight: 0, display: "flex", flexDirection: "column" }}>
          {children}
        </div>
      </div>

      <LanguageRegionModal />

      {/* Settings modal — rendered in the layout so it's available across all /app/* pages */}
      <SettingsModal
        open={settingsOpen}
        initialTab={settingsTab}
        onClose={handleSettingsClose}
      />

      {/* Global VibePin assistant — fixed launcher + contextual panel, above all drawers/modals */}
      <AssistantLauncher />
      <AssistantPanel />
    </div>
  );
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider>
      <LocaleProvider>
        <AssistantProvider>
          <AppLayoutInner>{children}</AppLayoutInner>
        </AssistantProvider>
      </LocaleProvider>
    </ThemeProvider>
  );
}
