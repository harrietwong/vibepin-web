"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, Monitor, Moon, Sun } from "lucide-react";
import { LocaleProvider, useLocale } from "@/lib/i18n/LocaleProvider";
import { ALL_APP_LANGUAGES, appLanguageShortLabel, type LanguageCode } from "@/lib/i18n/config";
import { ThemeProvider, useTheme } from "@/lib/theme/ThemeProvider";
import type { ThemePreference } from "@/lib/theme/themeStore";

const MENU_STYLE: React.CSSProperties = {
  position: "absolute",
  top: "calc(100% + 8px)",
  right: 0,
  zIndex: 100,
  padding: 5,
  border: "1px solid var(--public-border-hi)",
  borderRadius: 12,
  background: "var(--public-surface)",
  color: "var(--public-text)",
  boxShadow: "0 16px 40px rgba(15, 23, 42, 0.18)",
};

function PublicMenuRow({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={active}
      onClick={onClick}
      className="public-shell-menu-row focus-visible:outline-2 focus-visible:outline-offset-[-2px]"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 9,
        width: "100%",
        minHeight: 36,
        padding: "8px 10px",
        border: 0,
        borderRadius: 8,
        background: active ? "var(--public-accent-soft)" : "transparent",
        color: active ? "var(--public-accent-strong)" : "var(--public-text)",
        fontSize: 12,
        fontWeight: active ? 750 : 550,
        textAlign: "left",
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}

function useEscapeClose(
  open: boolean,
  setOpen: (open: boolean) => void,
  triggerRef: React.RefObject<HTMLButtonElement | null>,
  containerRef: React.RefObject<HTMLDivElement | null>,
) {
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [containerRef, open, setOpen, triggerRef]);
}

function PublicLanguageControl() {
  const { preferences, savePreferences, t } = useLocale();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  useEscapeClose(open, setOpen, triggerRef, containerRef);

  const current = preferences.appLanguage;
  const choose = (code: LanguageCode) => {
    setOpen(false);
    if (code !== current) void savePreferences({ appLanguage: code });
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        data-testid="public-language-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("public.controls.language")}
        title={t("public.controls.language")}
        onClick={() => setOpen(!open)}
        className="public-shell-control focus-visible:outline-2 focus-visible:outline-offset-2"
      >
        <span>{appLanguageShortLabel(current)}</span>
        <ChevronDown aria-hidden="true" size={13} />
      </button>
      {open && (
        <div data-testid="public-language-menu" role="menu" style={{ ...MENU_STYLE, width: 212, maxHeight: 360, overflowY: "auto" }}>
          {ALL_APP_LANGUAGES.map(language => (
            <PublicMenuRow key={language.code} active={language.code === current} onClick={() => choose(language.code)}>
              <span style={{ width: 27, color: "var(--public-text-muted)", fontSize: 10, fontWeight: 800 }}>
                {appLanguageShortLabel(language.code)}
              </span>
              <span style={{ flex: 1 }}>{language.nativeLabel}</span>
              {language.code === current && <Check aria-hidden="true" size={14} />}
            </PublicMenuRow>
          ))}
        </div>
      )}
    </div>
  );
}

const THEME_OPTIONS: { value: ThemePreference; Icon: typeof Sun; label: string }[] = [
  { value: "light", Icon: Sun, label: "theme.light" },
  { value: "dark", Icon: Moon, label: "theme.dark" },
  { value: "system", Icon: Monitor, label: "theme.system" },
];

function PublicThemeControl() {
  const { theme, setTheme } = useTheme();
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  useEscapeClose(open, setOpen, triggerRef, containerRef);
  const CurrentIcon = theme === "light" ? Sun : theme === "system" ? Monitor : Moon;

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        data-testid="public-theme-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("public.controls.theme")}
        title={t("public.controls.theme")}
        onClick={() => setOpen(!open)}
        className="public-shell-control public-shell-control--icon focus-visible:outline-2 focus-visible:outline-offset-2"
      >
        <CurrentIcon aria-hidden="true" size={15} />
      </button>
      {open && (
        <div data-testid="public-theme-menu" role="menu" style={{ ...MENU_STYLE, width: 148 }}>
          {THEME_OPTIONS.map(({ value, Icon, label }) => (
            <PublicMenuRow key={value} active={theme === value} onClick={() => { setTheme(value); setOpen(false); }}>
              <Icon aria-hidden="true" size={14} />
              <span style={{ flex: 1 }}>{t(label as Parameters<typeof t>[0])}</span>
              {theme === value && <Check aria-hidden="true" size={14} />}
            </PublicMenuRow>
          ))}
        </div>
      )}
    </div>
  );
}

export function PublicLanguageTheme() {
  return (
    <div data-testid="public-language-theme" className="public-shell-controls" aria-label="Public appearance controls">
      <PublicLanguageControl />
      <PublicThemeControl />
    </div>
  );
}

export function PublicShell({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider>
      <LocaleProvider>
        <div className="public-shell min-h-screen min-w-0 overflow-x-clip">
          <PublicLanguageTheme />
          {children}
        </div>
      </LocaleProvider>
    </ThemeProvider>
  );
}
