import { getBillingMode } from "@/lib/server/creem/billingMode";
import { hasPublicSessionCookie } from "@/lib/auth/publicSessionHint";
import { cookies } from "next/headers";
import PricingPageClient from "./pricing-client";
import { PublicShell } from "@/components/public/PublicShell";
import { igFbHidden } from "@/lib/social/visibleProviders";

// Product decision: hide Instagram/Facebook behind NEXT_PUBLIC_HIDE_IG_FB.
// Two static English variants (this metadata isn't i18n-routed today — it's
// a fixed SEO description regardless of locale), picked by the same flag as
// every other pricing surface.
export function generateMetadata() {
  return {
    title: "Pricing — VibePin",
    description: igFbHidden()
      ? "Simple pricing for AI content creation and Pinterest publishing. Start free, upgrade when you create more."
      : "Simple pricing for AI content creation and multi-platform publishing across Pinterest, Instagram, and Facebook. Start free, upgrade when you create more.",
  };
}

// Force per-request rendering. `billingEnabled` is read from CREEM_MODE at
// request time; reading process.env alone does NOT opt a route out of static
// prerendering in Next 16, so without this the billing posture would be baked
// into the build and a production CREEM_MODE change would need a rebuild to take
// effect. force-dynamic makes flipping CREEM_MODE (disabled→live) apply on the
// next request. (The page is auth-driven and interactive — never statically
// useful anyway.)
export const dynamic = "force-dynamic";

export default async function PricingPage() {
  // Prices are static USD from pricingPlans; no geo/localization lookup needed
  // (Creem is merchant-of-record and handles currency at checkout).
  //
  // Read the server billing posture so paid CTAs render their "coming soon"
  // disabled state at FIRST paint when checkout is turned off (CREEM_MODE=
  // disabled) — nobody is routed through signup only to hit a 503.
  const billingEnabled = getBillingMode() !== "disabled";
  // This is a local presence hint only: unlike Supabase `getSession()`, reading
  // the request cookies cannot refresh an expired token or delay first paint.
  // The client separately verifies its user before any billing action can run.
  const initialSessionHint = hasPublicSessionCookie((await cookies()).getAll());
  return <PublicShell><PricingPageClient billingEnabled={billingEnabled} initialSessionHint={initialSessionHint} /></PublicShell>;
}
