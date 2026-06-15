import BrandLogo from "@/components/BrandLogo";
import Link from "next/link";
import { CONTAINER } from "./shared";

const FOOTER_COLUMNS = [
  {
    title: "Product",
    links: [
      { label: "Intelligence", href: "#create" },
      { label: "Pin Ideas", href: "/app/discover?demo=true" },
      { label: "Product Opportunities", href: "/app/products?demo=true" },
      { label: "Create Pins", href: "/app/studio?demo=true" },
      { label: "Weekly Plan", href: "/app/plan?demo=true" },
      { label: "Pricing", href: "#pricing" },
    ],
  },
  {
    title: "Resources",
    links: [
      { label: "Help Center", href: "mailto:support@vibepin.co" },
      { label: "Pinterest Guide", href: "/app/discover?demo=true" },
    ],
  },
  {
    title: "Company",
    links: [{ label: "Contact", href: "mailto:support@vibepin.co" }],
  },
  {
    title: "Legal",
    links: [
      { label: "Privacy Policy", href: "/privacy" },
      { label: "Terms of Service", href: "/terms" },
      { label: "Pinterest App", href: "/pinterest-app" },
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
  return (
    <footer
      className="border-t pt-14 pb-8"
      style={{ borderColor: "rgba(255,255,255,0.07)", background: "var(--surface)" }}
    >
      <div className={`${CONTAINER} grid grid-cols-2 md:grid-cols-5 gap-8 mb-10`}>
        <div className="col-span-2 md:col-span-1">
          <div className="flex items-center gap-2 mb-3">
            <BrandLogo size={28} />
            <span className="font-black text-white text-sm tracking-tight">VibePin</span>
          </div>
          <p className="text-[11px] leading-relaxed" style={{ color: "#4B5563" }}>
            Pinterest growth intelligence for creators, sellers, affiliate marketers, and
            Pinterest teams.
          </p>
        </div>
        {FOOTER_COLUMNS.map(col => (
          <div key={col.title}>
            <p
              className="text-[10px] font-bold uppercase tracking-widest mb-3"
              style={{ color: "#4B5563" }}
            >
              {col.title}
            </p>
            <ul className="space-y-2.5">
              {col.links.map(link => (
                <li key={link.label}>
                  <FooterLink href={link.href} label={link.label} />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div
        className={`${CONTAINER} border-t pt-6 flex flex-col sm:flex-row justify-between gap-2 text-[11px]`}
        style={{ borderColor: "rgba(255,255,255,0.06)", color: "#374151" }}
      >
        <p>© 2026 VibePin. All rights reserved.</p>
        <p>VibePin is not affiliated with or endorsed by Pinterest.</p>
      </div>
    </footer>
  );
}
