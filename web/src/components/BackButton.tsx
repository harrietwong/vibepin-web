"use client";

import Link from "next/link";
import { useLocale } from "@/lib/i18n/LocaleProvider";

/**
 * "← Back" affordance for public marketing/legal pages. Pinned in the sticky
 * nav (not just a buried footer link) so it's visible without scrolling.
 *
 * Uses an ordinary localized link so keyboard users, direct visitors, and
 * server-rendered public pages all have a predictable, accessible target.
 */
export function BackButton({ fallbackHref = "/" }: { fallbackHref?: string }) {
  const { t } = useLocale();

  return (
    <Link
      href={fallbackHref}
      className="min-h-11 inline-flex items-center gap-1.5 rounded-md px-2 text-[12px] font-semibold transition-colors hover:text-[var(--public-text)] focus-visible:outline-2 focus-visible:outline-offset-2"
      style={{ color: "var(--public-text-muted)", background: "none", border: "none", cursor: "pointer" }}
    >
      ← {t("public.common.back")}
    </Link>
  );
}
