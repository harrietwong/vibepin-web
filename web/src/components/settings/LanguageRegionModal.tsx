"use client";

import { useState } from "react";
import Link from "next/link";
import { Globe, X, ChevronDown, ChevronUp } from "lucide-react";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import {
  PRIMARY_APP_LANGUAGES,
  BETA_APP_LANGUAGES,
  PINTEREST_REGIONS,
  ALL_APP_LANGUAGES,
  type LanguageCode,
  type ContentLanguageSetting,
  type PinterestRegionCode,
} from "@/lib/i18n/config";
import type { MessageKey } from "@/lib/i18n/messages/en";

function OptionRow({
  active,
  label,
  sublabel,
  onClick,
  disabled,
  testId,
}: {
  active: boolean;
  label: string;
  sublabel?: string;
  onClick: () => void;
  disabled?: boolean;
  testId?: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        width: "100%",
        padding: "9px 12px",
        borderRadius: 8,
        border: active ? "1px solid rgba(59,130,246,0.45)" : "1px solid var(--app-border)",
        background: active ? "rgba(59,130,246,0.1)" : "var(--app-surface-2)",
        color: disabled ? "var(--app-text-dim)" : "var(--app-text)",
        cursor: disabled ? "not-allowed" : "pointer",
        textAlign: "left",
        opacity: disabled ? 0.55 : 1,
      }}
    >
      <span>
        <span style={{ display: "block", fontSize: 13, fontWeight: active ? 700 : 500 }}>{label}</span>
        {sublabel && (
          <span style={{ display: "block", fontSize: 10, color: "var(--app-text-muted)", marginTop: 2 }}>
            {sublabel}
          </span>
        )}
      </span>
      {active && (
        <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#3B82F6", flexShrink: 0 }} />
      )}
    </button>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 20 }}>
      <h3 style={{ margin: "0 0 8px", fontSize: 11, fontWeight: 700, color: "var(--app-text-muted)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
        {title}
      </h3>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>{children}</div>
    </section>
  );
}

type Props = {
  embedded?: boolean;
  onClose?: () => void;
};

export function LanguageRegionPanel({ embedded, onClose }: Props) {
  const { draftPreferences, setDraftPreferences, savePreferences, saving, t, closeLanguageModal } = useLocale();
  const [showBeta, setShowBeta] = useState(false);

  async function handleSave() {
    await savePreferences(draftPreferences);
    if (!embedded) closeLanguageModal();
    onClose?.();
  }

  function renderLanguageOption(code: LanguageCode, nativeLabel: string, beta?: boolean, disabled?: boolean) {
    const active = draftPreferences.appLanguage === code;
    return (
      <OptionRow
        key={code}
        testId={`lang-app-${code}`}
        active={active}
        disabled={disabled}
        label={nativeLabel}
        sublabel={beta ? t("lang.beta") : undefined}
        onClick={() => !disabled && setDraftPreferences({ appLanguage: code })}
      />
    );
  }

  const contentOptions: { value: ContentLanguageSetting; label: string }[] = [
    { value: "same", label: t("lang.sameAsApp") },
    ...PRIMARY_APP_LANGUAGES.map(l => ({ value: l.code as ContentLanguageSetting, label: l.nativeLabel })),
  ];

  return (
    <div data-testid="language-region-panel" style={embedded ? undefined : { padding: "4px 0 0" }}>
      {!embedded && (
        <p style={{ margin: "0 0 16px", fontSize: 12, color: "var(--app-text-sec)", lineHeight: 1.55 }}>
          {t("lang.modalSubtitle")}
        </p>
      )}

      <Section title={t("lang.appLanguage")}>
        {PRIMARY_APP_LANGUAGES.map(l => renderLanguageOption(l.code, l.nativeLabel))}
        <button
          type="button"
          data-testid="lang-more-languages"
          onClick={() => setShowBeta(v => !v)}
          style={{
            display: "flex", alignItems: "center", gap: 6, marginTop: 4,
            padding: "6px 4px", background: "none", border: "none",
            color: "var(--app-text-sec)", fontSize: 12, fontWeight: 600, cursor: "pointer",
          }}
        >
          {showBeta ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          {t("lang.moreLanguages")}
        </button>
        {showBeta && BETA_APP_LANGUAGES.map(l => renderLanguageOption(
          l.code,
          l.nativeLabel,
          l.beta,
          l.disabled,
        ))}
      </Section>

      <Section title={t("lang.contentLanguage")}>
        {contentOptions.map(opt => (
          <OptionRow
            key={opt.value}
            testId={`lang-content-${opt.value}`}
            active={draftPreferences.contentLanguage === opt.value}
            label={opt.label}
            onClick={() => setDraftPreferences({ contentLanguage: opt.value })}
          />
        ))}
        {showBeta && BETA_APP_LANGUAGES.filter(l => !l.disabled).map(l => (
          <OptionRow
            key={`content-${l.code}`}
            active={draftPreferences.contentLanguage === l.code}
            label={l.nativeLabel}
            sublabel={t("lang.beta")}
            onClick={() => setDraftPreferences({ contentLanguage: l.code })}
          />
        ))}
      </Section>

      <Section title={t("lang.pinterestRegion")}>
        {PINTEREST_REGIONS.map(r => (
          <OptionRow
            key={r.code}
            testId={`region-${r.code}`}
            active={draftPreferences.pinterestRegion === r.code}
            label={t(r.labelKey as MessageKey)}
            onClick={() => setDraftPreferences({ pinterestRegion: r.code as PinterestRegionCode })}
          />
        ))}
      </Section>

      <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
        <button
          type="button"
          data-testid="lang-save-button"
          disabled={saving}
          onClick={handleSave}
          style={{
            flex: 1, minWidth: 120, padding: "10px 16px", borderRadius: 8, border: "none",
            background: "linear-gradient(135deg,#FF4D8D 0%,#D946EF 52%,#7C3AED 100%)",
            color: "#fff", fontSize: 13, fontWeight: 700, cursor: saving ? "default" : "pointer",
            opacity: saving ? 0.7 : 1,
          }}
        >
          {saving ? t("common.saving") : t("common.save")}
        </button>
        {!embedded && (
          <button
            type="button"
            onClick={() => { closeLanguageModal(); onClose?.(); }}
            style={{
              padding: "10px 16px", borderRadius: 8,
              border: "1px solid var(--app-border)", background: "transparent",
              color: "var(--app-text-sec)", fontSize: 13, fontWeight: 600, cursor: "pointer",
            }}
          >
            {t("common.cancel")}
          </button>
        )}
      </div>

      {!embedded && (
        <Link
          href="/app/settings/language"
          onClick={() => closeLanguageModal()}
          style={{
            display: "inline-block", marginTop: 12, fontSize: 11,
            color: "#3B82F6", textDecoration: "none", fontWeight: 600,
          }}
        >
          {t("lang.openInSettings")} →
        </Link>
      )}
    </div>
  );
}

export function LanguageRegionModal() {
  const { languageModalOpen, closeLanguageModal, t } = useLocale();
  if (!languageModalOpen) return null;

  return (
    <>
      <div
        data-testid="language-region-backdrop"
        style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 600 }}
        onClick={closeLanguageModal}
      />
      <div
        role="dialog"
        aria-modal
        aria-labelledby="language-region-title"
        data-testid="language-region-modal"
        style={{
          position: "fixed", top: "50%", left: "50%", transform: "translate(-50%, -50%)",
          width: "min(480px, calc(100vw - 32px))", maxHeight: "min(86vh, 720px)",
          overflowY: "auto", zIndex: 601,
          background: "var(--app-surface)", border: "1px solid var(--app-border-hi)",
          borderRadius: 16, boxShadow: "0 24px 64px rgba(0,0,0,0.45)",
          padding: "20px 20px 18px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Globe size={18} color="#3B82F6" />
            <h2 id="language-region-title" style={{ margin: 0, fontSize: 16, fontWeight: 800, color: "var(--app-text)" }}>
              {t("lang.modalTitle")}
            </h2>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={closeLanguageModal}
            style={{ background: "none", border: "none", cursor: "pointer", padding: 4, color: "var(--app-text-muted)" }}
          >
            <X size={18} />
          </button>
        </div>
        <LanguageRegionPanel />
      </div>
    </>
  );
}

export function currentLanguageLabel(code: LanguageCode): string {
  return ALL_APP_LANGUAGES.find(l => l.code === code)?.nativeLabel ?? code;
}
