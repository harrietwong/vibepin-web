import { getBillingMode } from "@/lib/server/creem/billingMode";
import PricingPageClient from "./pricing-client";

export const metadata = {
  title: "Pricing — VibePin",
  description:
    "Simple pricing for AI content creation and multi-platform publishing across Pinterest, Instagram, TikTok, and Facebook. Start free, upgrade when you create more.",
};

// Force per-request rendering. `billingEnabled` is read from CREEM_MODE at
// request time; reading process.env alone does NOT opt a route out of static
// prerendering in Next 16, so without this the billing posture would be baked
// into the build and a production CREEM_MODE change would need a rebuild to take
// effect. force-dynamic makes flipping CREEM_MODE (disabled→live) apply on the
// next request. (The page is auth-driven and interactive — never statically
// useful anyway.)
export const dynamic = "force-dynamic";

export default function PricingPage() {
  // Prices are static USD from pricingPlans; no geo/localization lookup needed
  // (Creem is merchant-of-record and handles currency at checkout).
  //
  // Read the server billing posture so paid CTAs render their "coming soon"
  // disabled state at FIRST paint when checkout is turned off (CREEM_MODE=
  // disabled) — nobody is routed through signup only to hit a 503.
  const billingEnabled = getBillingMode() !== "disabled";
  return <PricingPageClient billingEnabled={billingEnabled} />;
}
