"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, Monitor, Moon, Sun } from "lucide-react";
import Link from "next/link";
import { LocaleProvider, useLocale } from "@/lib/i18n/LocaleProvider";
import { ALL_APP_LANGUAGES, appLanguageShortLabel, type LanguageCode } from "@/lib/i18n/config";
import { ThemeProvider, useTheme } from "@/lib/theme/ThemeProvider";
import type { ThemePreference } from "@/lib/theme/themeStore";
import {
  closePublicMenuOnEscape,
  isPublicHeaderCompact,
  PUBLIC_CONTROL_MIN_SIZE,
} from "./publicShellContract";

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
        minHeight: PUBLIC_CONTROL_MIN_SIZE,
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
      closePublicMenuOnEscape(event.key, () => setOpen(false), () => triggerRef.current?.focus());
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
        style={{ minHeight: PUBLIC_CONTROL_MIN_SIZE, minWidth: PUBLIC_CONTROL_MIN_SIZE }}
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
        style={{ minHeight: PUBLIC_CONTROL_MIN_SIZE, minWidth: PUBLIC_CONTROL_MIN_SIZE }}
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
  const { t } = useLocale();
  const [compact, setCompact] = useState(false);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 390px)");
    const update = () => setCompact(isPublicHeaderCompact(window.innerWidth));
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  return (
    <div
      data-testid="public-language-theme"
      data-compact={compact || undefined}
      className="public-shell-controls"
      role="group"
      aria-label={t("public.controls.appearance")}
    >
      <PublicLanguageControl />
      <PublicThemeControl />
    </div>
  );
}

export function PublicNavLinks({ active, compact = false }: { active?: "pricing" | "about" | "careers" | "contact"; compact?: boolean }) {
  const { t } = useLocale();
  const linkClass = "public-nav-link hover:text-[var(--public-text)] transition-colors focus-visible:outline-2 focus-visible:outline-offset-2";
  if (compact) {
    return (
      <>
        <Link href="/about" className={linkClass}>{t("public.nav.about")}</Link>
        <Link href="/privacy" className={linkClass}>{t("public.nav.privacy")}</Link>
        <Link href="/terms" className={linkClass}>{t("public.nav.terms")}</Link>
      </>
    );
  }
  return (
    <>
      <Link href="/#create" className={linkClass}>{t("public.nav.howItWorks")}</Link>
      <Link href="/app/products" className={linkClass}>{t("public.nav.productOpportunities")}</Link>
      <Link href="/app/studio" className={linkClass}>{t("public.nav.createPins")}</Link>
      <Link href="/pricing" aria-current={active === "pricing" ? "page" : undefined} className={active === "pricing" ? `${linkClass} font-semibold` : linkClass}>{t("public.nav.pricing")}</Link>
    </>
  );
}

export function PublicAuthHeader() {
  return (
    <header className="public-auth-header">
      <PublicLanguageTheme />
    </header>
  );
}

export function PublicShell({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider>
      <LocaleProvider>
        <div className="public-shell min-h-screen min-w-0 overflow-x-clip">
          {children}
        </div>
      </LocaleProvider>
    </ThemeProvider>
  );
}
