import { headers } from "next/headers";
import PricingPageClient from "./pricing-client";

export const metadata = {
  title: "Pricing — VibePin",
  description:
    "Simple pricing for AI content creation and multi-platform publishing across Pinterest, Instagram, TikTok, and Facebook. Start free, upgrade when you create more.",
};

export default async function PricingPage() {
  // Reading a request header opts this route into dynamic rendering (expected).
  const hdrs = await headers();
  // Vercel geo header. Absent locally / on non-Vercel hosts — pass undefined,
  // never a sentinel like "OTHERS" (that would be an invalid Paddle country).
  const country = hdrs.get("x-vercel-ip-country") ?? undefined;

  return <PricingPageClient country={country} />;
}
