"use client";

/**
 * Admin-only top-right control bar: language (EN/中文) + theme (light/dark).
 * Rendered once in the shared admin layout, so it appears on every /admin/*
 * page. Intentionally minimal — no avatar, no token badge, no client-app nav;
 * those belong to the customer /app shell only, never here.
 */

import { Moon, Sun } from "lucide-react";
import { useAdminChrome } from "./AdminChromeProvider";

export default function AdminTopbar() {
  const { theme, setTheme, lang, setLang } = useAdminChrome();

  return (
    <div
      style={{
        height: 48,
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "flex-end",
        gap: 8,
        padding: "0 20px",
        background: "var(--admin-surface, #FFFFFF)",
        borderBottom: "1px solid var(--admin-border, #E5E7EB)",
      }}
    >
      {/* Language toggle: EN / 中文 */}
      <div
        role="group"
        aria-label="Admin UI language"
        style={{
          display: "inline-flex",
          borderRadius: 20,
          border: "1px solid var(--admin-border, #E5E7EB)",
          overflow: "hidden",
        }}
      >
        <button
          type="button"
          data-testid="admin-topbar-lang-en"
          onClick={() => setLang("en")}
          style={{
            padding: "5px 12px",
            fontSize: 11.5,
            fontWeight: 800,
            letterSpacing: "0.02em",
            border: "none",
            cursor: "pointer",
            background: lang === "en" ? "var(--admin-accent, #4338CA)" : "transparent",
            color: lang === "en" ? "#FFFFFF" : "var(--admin-text-secondary, #6B7280)",
          }}
        >
          EN
        </button>
        <button
          type="button"
          data-testid="admin-topbar-lang-zh"
          onClick={() => setLang("zh")}
          style={{
            padding: "5px 12px",
            fontSize: 11.5,
            fontWeight: 800,
            letterSpacing: "0.02em",
            border: "none",
            cursor: "pointer",
            background: lang === "zh" ? "var(--admin-accent, #4338CA)" : "transparent",
            color: lang === "zh" ? "#FFFFFF" : "var(--admin-text-secondary, #6B7280)",
          }}
        >
          中文
        </button>
      </div>

      {/* Theme toggle: light / dark */}
      <button
        type="button"
        data-testid="admin-topbar-theme"
        aria-label="Toggle admin theme"
        title={theme === "dark" ? "Switch to light" : "Switch to dark"}
        onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
        style={{
          width: 28,
          height: 28,
          borderRadius: "50%",
          border: "1px solid var(--admin-border, #E5E7EB)",
          background: "var(--admin-surface-2, #F9FAFB)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          cursor: "pointer",
          color: "var(--admin-text, #111827)",
        }}
      >
        {theme === "dark" ? <Moon style={{ width: 14, height: 14 }} /> : <Sun style={{ width: 14, height: 14 }} />}
      </button>
    </div>
  );
}
