"use client";

import Link from "next/link";
import { ShieldAlert } from "lucide-react";
import { useLocale } from "@/lib/i18n/LocaleProvider";

export default function AdminForbiddenNotice() {
  const { t } = useLocale();

  return (
    <section
      role="alert"
      aria-live="polite"
      style={{
        width: "min(560px, calc(100% - 32px))",
        margin: "72px auto",
        padding: "32px",
        border: "1px solid var(--app-border)",
        borderRadius: 20,
        background: "var(--app-card-bg)",
        boxShadow: "var(--app-card-shadow)",
        color: "var(--app-text)",
      }}
    >
      <span
        aria-hidden="true"
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 42,
          height: 42,
          borderRadius: 12,
          color: "#b45309",
          background: "rgba(245, 158, 11, 0.14)",
        }}
      >
        <ShieldAlert size={22} />
      </span>
      <h1 style={{ margin: "18px 0 8px", fontSize: 24, lineHeight: 1.2 }}>
        {t("adminForbidden.title")}
      </h1>
      <p style={{ margin: 0, color: "var(--app-text-muted)", lineHeight: 1.65 }}>
        {t("adminForbidden.description")}
      </p>
      <Link
        href="/app/studio"
        style={{
          display: "inline-flex",
          marginTop: 24,
          padding: "10px 16px",
          borderRadius: 10,
          background: "var(--app-accent)",
          color: "white",
          fontSize: 13,
          fontWeight: 700,
          textDecoration: "none",
        }}
      >
        {t("adminForbidden.back")}
      </Link>
    </section>
  );
}
