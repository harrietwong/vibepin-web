import BrandLogo from "@/components/BrandLogo";
import Link from "next/link";
import { LegalEntityNotice } from "@/components/LegalEntityNotice";
import { CONTAINER } from "./shared";
import { useLocale } from "@/lib/i18n/LocaleProvider";

const FOOTER_COLUMNS = [
  {
    id: "product",
    links: [
      { id: "intelligence", href: "#create" },
      { id: "pinIdeas", href: "/app/discover" },
      { id: "productOpportunities", href: "/app/products" },
      { id: "createPins", href: "/app/studio" },
      { id: "weeklyPlan", href: "/app/plan" },
      { id: "pricing", href: "/pricing" },
    ],
  },
  {
    id: "resources",
    links: [
      { id: "helpCenter", href: "/app/help" },
      { id: "howWeUsePinterest", href: "/pinterest-app" },
    ],
  },
  {
    id: "company",
    links: [
      { id: "about", href: "/about" },
      { id: "careers", href: "/careers" },
      { id: "contact", href: "/contact" },
    ],
  },
  {
    id: "legal",
    links: [
      { id: "privacyPolicy", href: "/privacy" },
      { id: "termsOfService", href: "/terms" },
      { id: "acceptableUsePolicy", href: "/acceptable-use-policy" },
      { id: "refundPolicy", href: "/refund-policy" },
      { id: "pinterestApp", href: "/pinterest-app" },
    ],
  },
] as const;

function FooterLink({ href, label }: { href: string; label: string }) {
  const isExternal = href.startsWith("mailto:");
  const isHash = href.startsWith("#");
  const className =
    "text-[12px] transition-colors hover:text-gray-300";
  const style = { color: "#5B6472" };

  if (isExternal) {
    return (
      <a href={href} className={className} style={style}>
        {label}
      </a>
    );
  }
  if (isHash) {
    return (
      <a href={href} className={className} style={style}>
        {label}
      </a>
    );
  }
  return (
    <Link href={href} className={className} style={style}>
      {label}
    </Link>
  );
}

export function LandingFooter() {
  const { t } = useLocale();
  return (
    <footer
      className="border-t pt-14 pb-8"
      style={{ borderColor: "rgba(255,255,255,0.07)", background: "var(--surface)" }}
    >
      <div className={`${CONTAINER} grid grid-cols-2 md:grid-cols-5 gap-8 mb-10`}>
        <div className="col-span-2 md:col-span-1">
          <div className="flex items-center gap-2 mb-3">
            <BrandLogo size={30} />
            <span className="font-black text-white text-sm tracking-tight">VibePin</span>
          </div>
          <p className="text-[11px] leading-relaxed mb-3" style={{ color: "#4B5563" }}>
            {t("public.footer.description")}
          </p>
          <a
            href="mailto:support@vibepin.co"
            className="text-[12px] font-semibold transition-colors hover:text-gray-300"
            style={{ color: "#8B93A1" }}
          >
            support@vibepin.co
          </a>
        </div>
        {FOOTER_COLUMNS.map(col => (
          <div key={col.id}>
            <p
              className="text-[10px] font-bold uppercase tracking-widest mb-3"
              style={{ color: "#4B5563" }}
            >
              {t(`public.footer.column.${col.id}` as never)}
            </p>
            <ul className="space-y-2.5">
              {col.links.map(link => (
                <li key={link.id}>
                  <FooterLink href={link.href} label={t(`public.footer.link.${link.id}` as never)} />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div
        className={`${CONTAINER} border-t pt-6 flex flex-col gap-2 text-[11px]`}
        style={{ borderColor: "rgba(255,255,255,0.06)", color: "#374151" }}
      >
        <div className="flex flex-col sm:flex-row justify-between gap-2">
          <p>{t("public.footer.copyright")}</p>
          <p>{t("public.footer.pinterestDisclaimer")}</p>
        </div>
        <LegalEntityNotice />
      </div>
    </footer>
  );
}
