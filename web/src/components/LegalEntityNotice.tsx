import { LEGAL_ENTITY_NAME } from "@/lib/legalEntity";
import { showFooterLegalEntity } from "@/lib/legalEntityFlag";
import { useLocale } from "@/lib/i18n/LocaleProvider";

/** Low-key footer line naming VibePin's legal operating entity. Gated by
 * NEXT_PUBLIC_SHOW_FOOTER_LEGAL_ENTITY (see legalEntityFlag.ts) — the flag
 * only controls this footer line, never the Privacy/Terms/Contact disclosure. */
export function LegalEntityNotice() {
  const { t } = useLocale();
  if (!showFooterLegalEntity()) return null;

  return (
    <p className="text-[10px]" style={{ color: "#374151" }}>
      {t("public.footer.legalEntity").replace("{entity}", LEGAL_ENTITY_NAME)}
    </p>
  );
}
