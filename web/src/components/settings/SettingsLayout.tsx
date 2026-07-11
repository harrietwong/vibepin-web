"use client";

import Link from "next/link";
import { SETTINGS_NAV, type SettingsSectionId } from "@/lib/settingsPaths";

const UI = {
  border: "var(--app-border, rgba(255,255,255,0.10))",
  text: "var(--app-text, #E2E8F0)",
  textSec: "var(--app-text-sec, #8892A4)",
  surface: "var(--app-surface, #161D2E)",
  activeBg: "rgba(59,130,246,0.12)",
  activeBorder: "rgba(59,130,246,0.35)",
};

export function SettingsLayout({
  active,
  title,
  description,
  children,
}: {
  active: SettingsSectionId;
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="app-page" style={{ height: "100%", overflow: "hidden", display: "flex" }}>
      <aside
        data-testid="settings-local-nav"
        style={{
          width: 220,
          flexShrink: 0,
          borderRight: `1px solid ${UI.border}`,
          padding: "20px 12px",
          overflowY: "auto",
          background: "var(--app-shell-bg)",
        }}
      >
        <p style={{ margin: "0 0 14px", padding: "0 10px", fontSize: 11, fontWeight: 800, color: UI.textSec, letterSpacing: "0.08em", textTransform: "uppercase" }}>
          Settings
        </p>
        <nav style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {SETTINGS_NAV.map(item => {
            const isActive = item.id === active;
            return (
              <Link
                key={item.id}
                href={item.href}
                data-testid={`settings-nav-${item.id}`}
                style={{
                  display: "block",
                  padding: "9px 12px",
                  borderRadius: 10,
                  fontSize: 13,
                  fontWeight: isActive ? 700 : 600,
                  color: isActive ? "#93C5FD" : UI.textSec,
                  textDecoration: "none",
                  background: isActive ? UI.activeBg : "transparent",
                  border: isActive ? `1px solid ${UI.activeBorder}` : "1px solid transparent",
                }}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
      </aside>

      <div style={{ flex: 1, overflowY: "auto", padding: "24px 28px 40px" }}>
        <header style={{ marginBottom: 22, maxWidth: 720 }}>
          <h1 data-testid="settings-page-title" style={{ margin: "0 0 6px", fontSize: 22, fontWeight: 800, color: UI.text }}>
            {title}
          </h1>
          {description && (
            <p style={{ margin: 0, fontSize: 13, color: UI.textSec, lineHeight: 1.6 }}>{description}</p>
          )}
        </header>
        <div style={{ maxWidth: 720 }}>{children}</div>
      </div>
    </div>
  );
}
