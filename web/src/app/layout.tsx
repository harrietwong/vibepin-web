import type { Metadata } from "next";
import { Toaster } from "sonner";
import { PreviewBadge } from "@/components/dev/PreviewBadge";
import { LEGAL_ENTITY_NAME, LEGAL_CONTACT_EMAIL, LEGAL_WEBSITE_URL } from "@/lib/legalEntity";
import { PUBLIC_THEME_INIT_SCRIPT } from "@/lib/theme/publicThemeBootstrap";
import "./globals.css";

const ORGANIZATION_JSON_LD = {
  "@context": "https://schema.org",
  "@type": "Organization",
  name: "VibePin",
  legalName: LEGAL_ENTITY_NAME,
  url: LEGAL_WEBSITE_URL,
  email: LEGAL_CONTACT_EMAIL,
};

export const metadata: Metadata = {
  title: "VibePin — Pinterest Opportunity Intelligence & Content Planning",
  description:
    "VibePin helps Pinterest creators, ecommerce sellers, and content marketers discover content opportunities, review demand and competition signals, create Pin drafts, and plan weekly Pinterest content.",
  icons: {
    icon: [
      { url: "/favicon-16x16.png", sizes: "16x16", type: "image/png" },
      { url: "/favicon-32x32.png", sizes: "32x32", type: "image/png" },
      { url: "/favicon.ico",       sizes: "any" },
    ],
    shortcut: "/favicon.ico",
    apple:    [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
    other:    [{ rel: "manifest", url: "/site.webmanifest" }],
  },
  openGraph: {
    title: "VibePin — Pinterest Opportunity Intelligence for Creators and Sellers",
    description:
      "Discover Pinterest content opportunities, review demand and competition signals, plan Pin drafts, and organise your weekly Pinterest content.",
    type: "website",
    images: [{ url: "/icon-512.png", width: 512, height: 512, alt: "VibePin" }],
  },
  twitter: {
    card:   "summary",
    images: ["/icon-512.png"],
  },
};

// Anti-FOUC: set data-theme on <html> before first paint so the app and public
// shell never flash the wrong theme. Mirrors themeStore
// (THEME_STORAGE_KEY, DEFAULT_THEME="dark").
//
// The /admin branch below is a fully independent admin-console concern (own
// storage key, own `data-admin-theme` attribute, own --admin-* CSS vars in
// globals.css) — it never reads/writes the /app theme state above, and vice
// versa. Mirrors lib/admin/adminTheme.ts (ADMIN_THEME_STORAGE_KEY, DEFAULT_ADMIN_THEME="light").
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: PUBLIC_THEME_INIT_SCRIPT }} />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(ORGANIZATION_JSON_LD) }}
        />
      </head>
      <body>
        {children}
        <Toaster position="bottom-right" richColors closeButton />
        {/* Non-production only (self-hides in production) — makes "which
            deployment is this?" answerable without reading the address bar. */}
        <PreviewBadge />
      </body>
    </html>
  );
}
