"use client";

/**
 * Top-right quick controls: App-language pill + Theme icon button.
 *
 * Both read/write the SAME stores as Settings, so the header controls and
 * Settings → Language / Appearance always show the same value:
 *   • Language → useLocale().preferences.appLanguage / savePreferences(...)
 *   • Theme    → useTheme().theme / setTheme(...)
 *
 * This changes the APP UI language only. AI content language (Settings → AI
 * Settings / Language → AI content language) is a separate preference and is not
 * touched here.
 */

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Moon, Sun, Monitor } from "lucide-react";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import { useTheme } from "@/lib/theme/ThemeProvider";
import { ALL_APP_LANGUAGES, appLanguageShortLabel, type LanguageCode } from "@/lib/i18n/config";
import type { ThemePreference } from "@/lib/theme/themeStore";
import type { MessageKey } from "@/lib/i18n/messages/en";

const ICON_BTN: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", justifyContent: "center",
  cursor: "pointer", flexShrink: 0,
};

const MENU: React.CSSProperties = {
  position: "absolute", top: "calc(100% + 8px)", right: 0,
  background: "var(--app-dropdown-bg)", border: "1px solid var(--app-dropdown-border)",
  borderRadius: 12, boxShadow: "0 16px 44px rgba(0,0,0,0.4), 0 4px 14px rgba(0,0,0,0.28)",
  zIndex: 600, overflow: "hidden", padding: "5px 0",
};

function MenuRow({ active, onClick, testId, children }: {
  active: boolean; onClick: () => void; testId?: string; children: React.ReactNode;
}) {
  const [hov, setHov] = useState(false);
  return (
    <button
      type="button"
      data-testid={testId}
      role="menuitemradio"
      aria-checked={active}
      onClick={onClick}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        display: "flex", alignItems: "center", gap: 9, width: "100%",
        padding: "8px 12px", border: "none", textAlign: "left", cursor: "pointer",
        fontSize: 13, whiteSpace: "nowrap",
        color: active ? "var(--app-brand, #A78BFA)" : "var(--app-dropdown-text)",
        background: hov ? "var(--app-dropdown-hover)" : "none",
        fontWeight: active ? 700 : 500,
      }}
    >
      {children}
    </button>
  );
}

// ── App-language pill ──────────────────────────────────────────────────────────

function LanguageControl() {
  const { preferences, savePreferences, t } = useLocale();
  const [open, setOpen] = useState(false);
  const [hov, setHov] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = preferences.appLanguage;

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  function pick(code: LanguageCode) {
    setOpen(false);
    if (code !== current) void savePreferences({ appLanguage: code });
  }

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        type="button"
        data-testid="topbar-language-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("topbar.language" as MessageKey)}
        title={t("language.appLanguage")}
        onClick={() => setOpen(o => !o)}
        onMouseEnter={() => setHov(true)}
        onMouseLeave={() => setHov(false)}
        style={{
          display: "inline-flex", alignItems: "center", gap: 4,
          height: 28, padding: "0 8px", borderRadius: 20,
          border: "1px solid var(--app-border-hi, var(--app-border))",
          background: hov || open ? "var(--app-dropdown-hover)" : "var(--app-surface-2)",
          color: "var(--app-text)", fontSize: 11.5, fontWeight: 800, letterSpacing: "0.02em",
          cursor: "pointer", flexShrink: 0, transition: "background 0.12s",
        }}
      >
        <span data-testid="topbar-language-short">{appLanguageShortLabel(current)}</span>
        <ChevronDown style={{ width: 12, height: 12, opacity: 0.7 }} />
      </button>

      {open && (
        <div data-testid="topbar-language-menu" role="menu" style={{ ...MENU, width: 210, maxHeight: 360, overflowY: "auto" }}>
          {ALL_APP_LANGUAGES.map(l => (
            <MenuRow key={l.code} active={l.code === current} onClick={() => pick(l.code)} testId={`topbar-language-option-${l.code}`}>
              <span style={{
                width: 26, fontSize: 11, fontWeight: 800, color: "var(--app-dropdown-muted)", flexShrink: 0,
              }}>{appLanguageShortLabel(l.code)}</span>
              <span style={{ flex: 1 }}>{l.nativeLabel}</span>
              {l.code === current && <Check style={{ width: 14, height: 14, flexShrink: 0 }} />}
            </MenuRow>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Theme icon button ────────────────────────────────────────────────────────

const THEME_ROWS: { value: ThemePreference; labelKey: MessageKey; Icon: typeof Sun }[] = [
  { value: "light",  labelKey: "theme.light", Icon: Sun     },
  { value: "dark",   labelKey: "theme.dark",  Icon: Moon    },
  { value: "system", labelKey: "theme.auto",  Icon: Monitor },
];

function ThemeControl() {
  const { theme, setTheme } = useTheme();
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const [hov, setHov] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const CurrentIcon = theme === "light" ? Sun : theme === "system" ? Monitor : Moon;

  function pick(value: ThemePreference) {
    setOpen(false);
    setTheme(value);
  }

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        type="button"
        data-testid="topbar-theme-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("topbar.theme" as MessageKey)}
        title={t("appearance.title")}
        onClick={() => setOpen(o => !o)}
        onMouseEnter={() => setHov(true)}
        onMouseLeave={() => setHov(false)}
        style={{
          ...ICON_BTN, width: 28, height: 28, borderRadius: "50%",
          border: "1px solid var(--app-border-hi, var(--app-border))",
          background: hov || open ? "var(--app-dropdown-hover)" : "var(--app-surface-2)",
          color: "var(--app-text)", transition: "background 0.12s",
        }}
      >
        <CurrentIcon style={{ width: 14, height: 14 }} />
      </button>

      {open && (
        <div data-testid="topbar-theme-menu" role="menu" style={{ ...MENU, width: 150 }}>
          {THEME_ROWS.map(({ value, labelKey, Icon }) => (
            <MenuRow key={value} active={theme === value} onClick={() => pick(value)} testId={`topbar-theme-option-${value}`}>
              <Icon style={{ width: 14, height: 14, flexShrink: 0 }} />
              <span style={{ flex: 1 }}>{t(labelKey)}</span>
              {theme === value && <Check style={{ width: 14, height: 14, flexShrink: 0 }} />}
            </MenuRow>
          ))}
        </div>
      )}
    </div>
  );
}

export function TopbarLanguageTheme() {
  return (
    <div data-testid="topbar-language-theme" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <LanguageControl />
      <ThemeControl />
    </div>
  );
}
