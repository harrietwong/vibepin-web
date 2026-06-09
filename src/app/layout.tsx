import type { Metadata } from "next";
import { Toaster } from "sonner";
import "./globals.css";

export const metadata: Metadata = {
  title: "VibePin — Pinterest Opportunity Intelligence & Content Planning",
  description:
    "VibePin helps Pinterest creators, ecommerce sellers, and content marketers discover content opportunities, review demand and competition signals, create Pin drafts, and plan weekly Pinterest content.",
  openGraph: {
    title: "VibePin — Pinterest Opportunity Intelligence for Creators and Sellers",
    description:
      "Discover Pinterest content opportunities, review demand and competition signals, plan Pin drafts, and organise your weekly Pinterest content.",
    type: "website",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        {children}
        <Toaster position="bottom-right" richColors closeButton />
      </body>
    </html>
  );
}
