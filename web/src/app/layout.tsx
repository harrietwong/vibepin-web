import type { Metadata } from "next";
import { Toaster } from "sonner";
import "./globals.css";

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

// Anti-FOUC: set data-theme on <html> before first paint so the app shell never
// flashes the wrong theme. Scoped to /app paths so marketing/landing routes keep
// their own styling. Mirrors themeStore (THEME_STORAGE_KEY, DEFAULT_THEME="dark").
//
// The /admin branch below is a fully independent admin-console concern (own
// storage key, own `data-admin-theme` attribute, own --admin-* CSS vars in
// globals.css) — it never reads/writes the /app theme state above, and vice
// versa. Mirrors lib/admin/adminTheme.ts (ADMIN_THEME_STORAGE_KEY, DEFAULT_ADMIN_THEME="light").
const THEME_INIT_SCRIPT = `(function(){try{
  if(location.pathname.startsWith('/app')){
    var t=localStorage.getItem('vp:appearance_theme:v1');
    var r=t==='light'?'light':t==='system'?(window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'):'dark';
    document.documentElement.setAttribute('data-theme',r);
  } else if(location.pathname.startsWith('/admin')){
    var at=localStorage.getItem('vibepin-admin-theme');
    document.documentElement.setAttribute('data-admin-theme', at==='dark'?'dark':'light');
  }
}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>
        {children}
        <Toaster position="bottom-right" richColors closeButton />
      </body>
    </html>
  );
}
