import { redirect } from "next/navigation";
import { SETTINGS_SOCIAL_PATH, SETTINGS_SHOPIFY_PATH } from "@/lib/settingsPaths";
import { resolveShopifyIntegrationFromEnv } from "@/lib/shopifyFlag";

// Redirect target is the Shopify tab (裁决 a) once the integration is enabled;
// with the flag off it falls back to Social accounts, which is where Pinterest —
// the previous fallback target — now lives (PRD §2). The flag-off branch is still
// UI-only gating (§8.4): only the destination section changed, not the behaviour.
export default function IntegrationsRedirectPage() {
  redirect(resolveShopifyIntegrationFromEnv() === true ? SETTINGS_SHOPIFY_PATH : SETTINGS_SOCIAL_PATH);
}
