"use client";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import { useState, useEffect, useRef } from "react";
import {
  Layers, Sparkles, ClipboardList, Clock,
  BarChart2, Compass, ShoppingBag, Settings, Target,
  User, CreditCard, Bell, Receipt, HelpCircle,
  Cookie, Globe, Moon, Sun, LogOut, Check, ChevronRight,
} from "lucide-react";
import { createBrowserClient } from "@supabase/ssr";
import { getStoredTheme, setStoredTheme, toggleTheme, type AppTheme } from "@/lib/appTheme";

const supabase = createBrowserClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
);

const V_ICON = (
  <svg viewBox="0 0 20 20" fill="none" width="16" height="16" aria-hidden>
    <path d="M4 5.5L10 15L16 5.5" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

type NavItem = {
  id:    string;
  href:  string;
  icon:  React.ComponentType<{ style?: React.CSSProperties }>;
  label: string;
  matchFn: (p: string) => boolean;
};

const NAV_ITEMS: NavItem[] = [
  { id: "home",          href: "/app/workspace/home-decor", icon: Layers,       label: "Home",           matchFn: (p) => p.startsWith("/app/workspace") && !p.includes("opportunities") },
  { id: "create-pins",   href: "/app/studio",               icon: Sparkles,      label: "Create Pins",    matchFn: (p) => p === "/app/studio" || p.startsWith("/app/studio/") },
  { id: "weekly-plan",   href: "/app/plan",                 icon: ClipboardList, label: "Weekly Plan",    matchFn: (p) => p === "/app/plan" || p.startsWith("/app/plan/") },
  { id: "my-pins",       href: "/app/history",              icon: Clock,         label: "My Pins",        matchFn: (p) => p === "/app/history" || p.startsWith("/app/history/") },
  { id: "opportunities", href: "/app/workspace/home-decor", icon: Target,        label: "Opportunities",  matchFn: (p) => p.includes("/opportunities") },
  { id: "keyword-trends", href: "/app/trends",              icon: BarChart2,     label: "Keyword Trends", matchFn: (p) => p === "/app/trends" || p.startsWith("/app/trends/") },
  { id: "viral-pins",    href: "/app/discover",             icon: Compass,       label: "Pin Ideas",      matchFn: (p) => p === "/app/discover" || p.startsWith("/app/discover/") },
  { id: "product-ideas", href: "/app/products",             icon: ShoppingBag,   label: "Product Ideas",  matchFn: (p) => p === "/app/products" || p.startsWith("/app/products/") },
  { id: "settings",      href: "/settings",                 icon: Settings,      label: "Settings",       matchFn: (p) => p === "/settings" || p.startsWith("/settings/") },
];

const LANGUAGES = [
  { code: "en", label: "English" },
  { code: "zh", label: "中文" },
  { code: "ja", label: "日本語" },
  { code: "ko", label: "한국어" },
  { code: "de", label: "Deutsch" },
  { code: "fr", label: "Français" },
  { code: "es", label: "Español" },
  { code: "pt", label: "Português" },
  { code: "ru", label: "Русский" },
];

// ── User dropdown item ─────────────────────────────────────────────────────────

const BASE_ITEM: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 10,
  padding: "9px 14px", cursor: "pointer", fontSize: "13px",
  color: "#C4CFDF", background: "none", border: "none",
  width: "100%", textAlign: "left",
};

function DropdownItem({ icon: Icon, label, right, onClick, danger }: {
  icon: React.ComponentType<{ style?: React.CSSProperties }>;
  label: React.ReactNode;
  right?: React.ReactNode;
  onClick?: () => void;
  danger?: boolean;
}) {
  const [hov, setHov] = useState(false);
  return (
    <button
      type="button"
      style={{
        ...BASE_ITEM,
        color: danger ? (hov ? "#F87171" : "#EF4444") : "#C4CFDF",
        background: hov ? (danger ? "rgba(239,68,68,0.07)" : "rgba(255,255,255,0.05)") : "none",
      }}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      onClick={onClick}
    >
      <Icon style={{ width: 15, height: 15, color: danger ? "currentColor" : "#8892A4", flexShrink: 0 }} />
      <span style={{ flex: 1 }}>{label}</span>
      {right}
    </button>
  );
}

// ── User dropdown ──────────────────────────────────────────────────────────────

function UserDropdown({ email, onLogout, onClose, theme, onThemeToggle }: {
  email: string | null;
  onLogout: () => Promise<void>;
  onClose: () => void;
  theme: AppTheme;
  onThemeToggle: () => void;
}) {
  const [langOpen, setLangOpen] = useState(false);
  const [lang, setLang] = useState("zh");

  return (
    <>
      <div style={{ position: "fixed", inset: 0, zIndex: 499 }} onClick={onClose} />
      <div
        data-testid="user-dropdown"
        style={{
          position: "absolute", top: "calc(100% + 8px)", right: 0,
          width: 276, background: "#1A2236",
          borderRadius: 14, border: "1px solid rgba(255,255,255,0.1)",
          boxShadow: "0 16px 48px rgba(0,0,0,0.45), 0 4px 16px rgba(0,0,0,0.3)",
          zIndex: 500, overflow: "hidden",
        }}
      >
        {/* Header */}
        <div style={{ padding: "14px 16px 10px", borderBottom: "1px solid rgba(255,255,255,0.07)" }}>
          <p style={{ margin: 0, fontSize: "14px", fontWeight: 700, color: "#E2E8F0" }}>My Account</p>
          {email && <p style={{ margin: "2px 0 0", fontSize: "11px", color: "#6B7A96" }}>{email}</p>}
        </div>

        <div style={{ padding: "5px 0" }}>
          <DropdownItem icon={User} label="个人主页" />
          <DropdownItem icon={CreditCard} label="我的套餐" />
          <DropdownItem
            icon={CreditCard}
            label="Token / Credits"
            right={<span style={{ fontSize: "11px", fontWeight: 700, color: "#3B82F6", background: "rgba(59,130,246,0.15)", padding: "1px 8px", borderRadius: 20 }}>34</span>}
          />
          <DropdownItem
            icon={Bell}
            label="通知中心"
            right={<span style={{ fontSize: "10px", fontWeight: 700, color: "#fff", background: "#EF4444", padding: "1px 7px", borderRadius: 20 }}>12</span>}
          />
          <DropdownItem icon={Receipt} label="账单与发票" />
          <DropdownItem icon={HelpCircle} label="帮助中心" />
          <DropdownItem icon={Cookie} label="Cookies Policy" />

          <div style={{ height: 1, background: "rgba(255,255,255,0.07)", margin: "4px 0" }} />

          {/* Language with submenu */}
          <div
            style={{ position: "relative" }}
            onMouseEnter={() => setLangOpen(true)}
            onMouseLeave={() => setLangOpen(false)}
          >
            <button
              type="button"
              data-testid="language-menu-item"
              style={{ ...BASE_ITEM, justifyContent: "space-between" }}
              onMouseEnter={e => (e.currentTarget.style.background = "rgba(255,255,255,0.05)")}
              onMouseLeave={e => (e.currentTarget.style.background = "none")}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <Globe style={{ width: 15, height: 15, color: "#8892A4" }} />
                <span style={{ color: "#C4CFDF" }}>语言</span>
              </div>
              <ChevronRight style={{ width: 13, height: 13, color: "#6B7A96" }} />
            </button>

            {langOpen && (
              <div
                data-testid="language-submenu"
                style={{
                  position: "absolute", right: "calc(100% + 4px)", top: 0,
                  width: 160, background: "#1A2236",
                  borderRadius: 12, border: "1px solid rgba(255,255,255,0.1)",
                  boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
                  overflow: "hidden", padding: "4px 0", zIndex: 501,
                }}
              >
                {LANGUAGES.map(l => (
                  <button
                    key={l.code}
                    type="button"
                    data-testid={l.code === "zh" ? "lang-zh" : undefined}
                    onClick={() => setLang(l.code)}
                    style={{
                      display: "flex", alignItems: "center", justifyContent: "space-between",
                      width: "100%", padding: "8px 12px", background: "none", border: "none",
                      fontSize: "12px", color: lang === l.code ? "#3B82F6" : "#C4CFDF",
                      fontWeight: lang === l.code ? 700 : 400, cursor: "pointer", textAlign: "left",
                    }}
                    onMouseEnter={e => (e.currentTarget.style.background = "rgba(255,255,255,0.05)")}
                    onMouseLeave={e => (e.currentTarget.style.background = "none")}
                  >
                    <span>{l.label}</span>
                    {lang === l.code && <Check style={{ width: 12, height: 12, color: "#3B82F6" }} />}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Theme */}
          <button
            type="button"
            style={{ ...BASE_ITEM, justifyContent: "space-between" }}
            onClick={onThemeToggle}
            onMouseEnter={e => (e.currentTarget.style.background = "var(--app-dropdown-hover)")}
            onMouseLeave={e => (e.currentTarget.style.background = "none")}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              {theme === "dark"
                ? <Moon style={{ width: 15, height: 15, color: "#8892A4" }} />
                : <Sun style={{ width: 15, height: 15, color: "#8892A4" }} />}
              <span style={{ color: "var(--app-dropdown-text)" }}>主题切换</span>
            </div>
            <span style={{ fontSize: "11px", color: "var(--app-dropdown-muted)" }}>
              {theme === "dark" ? "深色" : "浅色"}
            </span>
          </button>

          <div style={{ height: 1, background: "rgba(255,255,255,0.07)", margin: "4px 0" }} />

          <DropdownItem icon={LogOut} label="退出登录" danger onClick={onLogout} />
        </div>
      </div>
    </>
  );
}

// ── App Layout ─────────────────────────────────────────────────────────────────

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const path   = usePathname();
  const router = useRouter();
  const [userEmail,    setUserEmail]    = useState<string | null>(null);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [theme, setTheme] = useState<AppTheme>("dark");
  const avatarRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setTheme(getStoredTheme());
  }, []);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setUserEmail(data.user?.email ?? null);
    });
  }, []);

  function handleThemeToggle() {
    setTheme(prev => {
      const next = toggleTheme(prev);
      setStoredTheme(next);
      return next;
    });
  }

  async function handleLogout() {
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  const userInitial = userEmail ? userEmail[0].toUpperCase() : "V";

  return (
    <div data-theme={theme} style={{ display: "flex", overflow: "hidden", height: "100dvh", background: "var(--app-shell-bg)" }}>

      {/* ── Sidebar ── */}
      <aside
        data-testid="app-sidebar"
        style={{
          width: 80, flexShrink: 0, height: "100dvh",
          display: "flex", flexDirection: "column",
          background: "var(--app-sidebar-bg)",
          borderRight: "1px solid var(--app-sidebar-border)",
        }}
      >
        {/* Logo */}
        <div style={{
          height: 56, display: "flex", alignItems: "center", justifyContent: "center",
          borderBottom: "1px solid var(--app-sidebar-border)", flexShrink: 0,
        }}>
          <Link href="/app/workspace/home-decor" style={{ textDecoration: "none" }}>
            <div style={{
              width: 36, height: 36, borderRadius: 10,
              background: "linear-gradient(135deg,#FF4D8D 0%,#D946EF 52%,#7C3AED 100%)",
              display: "flex", alignItems: "center", justifyContent: "center",
            }}>
              {V_ICON}
            </div>
          </Link>
        </div>

        {/* Nav */}
        <nav style={{ flex: 1, padding: "10px 8px", display: "flex", flexDirection: "column", gap: 2, overflowY: "auto" }}>
          {NAV_ITEMS.filter((item, idx, arr) => arr.findIndex(i => i.id === item.id) === idx).map(item => {
            const active = item.matchFn(path);
            const Icon   = item.icon;
            return (
              <Link key={item.id} href={item.href} title={item.label} data-testid={`nav-${item.id}`} style={{ textDecoration: "none" }}>
                <div
                  style={{
                    display: "flex", flexDirection: "column", alignItems: "center",
                    gap: 3, padding: "8px 4px", borderRadius: 10,
                    background: active ? "var(--app-nav-active-bg)" : "none",
                    cursor: "pointer", transition: "background 0.12s",
                  }}
                  onMouseEnter={e => { if (!active) e.currentTarget.style.background = "var(--app-dropdown-hover)"; }}
                  onMouseLeave={e => { if (!active) e.currentTarget.style.background = "none"; }}
                >
                  <Icon style={{ width: 18, height: 18, color: active ? "#3B82F6" : "var(--app-nav-text)" }} />
                  <span style={{
                    fontSize: "9px", fontWeight: active ? 700 : 500,
                    color: active ? "#3B82F6" : "var(--app-nav-text)",
                    textAlign: "center", lineHeight: 1.2,
                    whiteSpace: "nowrap", maxWidth: 68, overflow: "hidden", textOverflow: "ellipsis",
                  }}>{item.label}</span>
                </div>
              </Link>
            );
          })}
        </nav>
      </aside>

      {/* ── Main area ── */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>

        {/* App top bar (token + avatar) */}
        <div style={{
          height: 52, flexShrink: 0,
          display: "flex", alignItems: "center", justifyContent: "flex-end",
          gap: 8, padding: "0 16px",
          background: "var(--app-topbar-bg)",
          borderBottom: "1px solid var(--app-sidebar-border)",
        }}>
          {/* Token badge */}
          <div style={{
            display: "flex", alignItems: "center", gap: 5,
            padding: "4px 10px", borderRadius: 20,
            background: "rgba(59,130,246,0.1)", border: "1px solid rgba(59,130,246,0.22)",
          }}>
            <svg width="10" height="10" viewBox="0 0 20 20" fill="none">
              <circle cx="10" cy="10" r="8.5" stroke="#3B82F6" strokeWidth="2" />
              <path d="M7 10l2 2 4-4" stroke="#3B82F6" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span style={{ fontSize: "11px", fontWeight: 700, color: "#3B82F6" }}>34</span>
            <span style={{ fontSize: "10px", color: "#6B7A96" }}>Token</span>
          </div>

          {/* Bell */}
          <div style={{ position: "relative" }}>
            <button type="button" style={{ background: "none", border: "none", cursor: "pointer", padding: 4, display: "flex" }}>
              <Bell style={{ width: 16, height: 16, color: "#6B7A96" }} />
            </button>
            <span style={{
              position: "absolute", top: 3, right: 3,
              width: 7, height: 7, borderRadius: "50%",
              background: "#EF4444", border: "1.5px solid #111827",
              display: "block",
            }} />
          </div>

          {/* Avatar */}
          <div ref={avatarRef} style={{ position: "relative" }}>
            <button
              data-testid="user-avatar"
              type="button"
              onClick={() => setDropdownOpen(v => !v)}
              style={{
                width: 32, height: 32, borderRadius: "50%",
                background: "linear-gradient(135deg,#FF4D8D 0%,#7C3AED 100%)",
                border: dropdownOpen ? "2px solid #3B82F6" : "2px solid rgba(255,255,255,0.15)",
                cursor: "pointer",
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: "13px", fontWeight: 700, color: "#fff",
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
                theme={theme}
                onThemeToggle={handleThemeToggle}
              />
            )}
          </div>
        </div>

        {/* Page content */}
        <div style={{ flex: 1, overflow: "hidden", minHeight: 0, display: "flex", flexDirection: "column" }}>
          {children}
        </div>
      </div>
    </div>
  );
}
