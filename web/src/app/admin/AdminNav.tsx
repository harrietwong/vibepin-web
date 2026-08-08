"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Sun, LayoutDashboard, Database, ImageIcon, Users, ScrollText, Workflow, ShieldCheck, LifeBuoy, Sparkles } from "lucide-react";
import { useAdminChrome } from "./AdminChromeProvider";
import type { AdminMessageKey } from "@/lib/admin/adminMessages";

type AdminNavItem = {
  id: string;
  href: string;
  labelKey: AdminMessageKey;
  icon: React.ComponentType<{ style?: React.CSSProperties }>;
  matchFn: (p: string) => boolean;
};

// Internal admin navigation only. No customer nav, Create Pins, Product Ideas,
// workspace controls, token badge, or Ask VibePin here — this is a separate
// control plane rendered outside the customer /app shell.
const ADMIN_NAV: AdminNavItem[] = [
  {
    id: "today",
    href: "/admin/today",
    labelKey: "nav.today",
    icon: Sun,
    matchFn: (p) => p === "/admin/today" || p.startsWith("/admin/today/"),
  },
  {
    id: "overview",
    href: "/admin",
    labelKey: "nav.overview",
    icon: LayoutDashboard,
    matchFn: (p) => p === "/admin",
  },
  {
    id: "data",
    href: "/admin/data",
    labelKey: "nav.data",
    icon: Database,
    matchFn: (p) => p === "/admin/data" || p.startsWith("/admin/data/"),
  },
  {
    id: "pipeline",
    href: "/admin/pipeline",
    labelKey: "nav.pipeline",
    icon: Workflow,
    matchFn: (p) => p === "/admin/pipeline" || p.startsWith("/admin/pipeline/"),
  },
  {
    id: "customers",
    href: "/admin/users",
    labelKey: "nav.customers",
    icon: Users,
    matchFn: (p) => p === "/admin/users" || p.startsWith("/admin/users/"),
  },
  {
    id: "support",
    href: "/admin/support",
    labelKey: "nav.support",
    icon: LifeBuoy,
    matchFn: (p) => p === "/admin/support" || p.startsWith("/admin/support/"),
  },
  {
    id: "generation-logs",
    href: "/admin/generation-logs",
    labelKey: "nav.generationLogs",
    icon: ScrollText,
    matchFn: (p) => p === "/admin/generation-logs" || p.startsWith("/admin/generation-logs/"),
  },
  {
    id: "visual-review",
    href: "/admin/visual-review",
    labelKey: "nav.visualReview",
    icon: ImageIcon,
    matchFn: (p) => p === "/admin/visual-review" || p.startsWith("/admin/visual-review/"),
  },
  {
    id: "creative-intelligence",
    href: "/admin/creative-intelligence",
    labelKey: "nav.creativeIntelligence",
    icon: Sparkles,
    matchFn: (p) => p === "/admin/creative-intelligence" || p.startsWith("/admin/creative-intelligence/"),
  },
];

export default function AdminNav() {
  const path = usePathname();
  const { t } = useAdminChrome();

  return (
    <aside
      style={{
        width: 224,
        flexShrink: 0,
        height: "100dvh",
        display: "flex",
        flexDirection: "column",
        background: "#0F172A",
        borderRight: "1px solid #1E293B",
        color: "#E2E8F0",
      }}
    >
      {/* Header */}
      <div
        style={{
          height: 64,
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "0 18px",
          borderBottom: "1px solid #1E293B",
          flexShrink: 0,
        }}
      >
        <span
          style={{
            width: 30,
            height: 30,
            borderRadius: 8,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "linear-gradient(135deg,#6366F1 0%,#4338CA 100%)",
            flexShrink: 0,
          }}
        >
          <ShieldCheck style={{ width: 17, height: 17, color: "#FFFFFF" }} />
        </span>
        <div style={{ minWidth: 0 }}>
          <p style={{ margin: 0, fontSize: 14, fontWeight: 800, letterSpacing: "-0.01em", color: "#F8FAFC" }}>
            {t("shell.title")}
          </p>
          <p style={{ margin: 0, fontSize: 10.5, fontWeight: 600, color: "#64748B", textTransform: "uppercase", letterSpacing: "0.06em" }}>
            {t("shell.internal")}
          </p>
        </div>
      </div>

      {/* Nav */}
      <nav style={{ flex: 1, padding: "12px 12px", display: "flex", flexDirection: "column", gap: 3, overflowY: "auto" }}>
        {ADMIN_NAV.map((item) => {
          const active = item.matchFn(path);
          const Icon = item.icon;
          return (
            <Link
              key={item.id}
              href={item.href}
              data-testid={`admin-nav-${item.id}`}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 11,
                padding: "9px 12px",
                borderRadius: 9,
                textDecoration: "none",
                fontSize: 13,
                fontWeight: active ? 750 : 600,
                color: active ? "#F8FAFC" : "#94A3B8",
                background: active ? "rgba(99,102,241,0.16)" : "transparent",
                border: active ? "1px solid rgba(99,102,241,0.32)" : "1px solid transparent",
              }}
            >
              <Icon style={{ width: 17, height: 17, color: active ? "#818CF8" : "#64748B", flexShrink: 0 }} />
              {t(item.labelKey)}
            </Link>
          );
        })}
      </nav>

      {/* Footer */}
      <div style={{ padding: "12px 16px", borderTop: "1px solid #1E293B", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 11, fontWeight: 600, color: "#64748B" }}>
          <ShieldCheck style={{ width: 13, height: 13, color: "#34D399" }} />
          {t("shell.superAdminGated")}
        </div>
      </div>
    </aside>
  );
}
