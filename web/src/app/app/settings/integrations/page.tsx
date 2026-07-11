import { redirect } from "next/navigation";
import { SETTINGS_PINTEREST_PATH, SETTINGS_SHOPIFY_PATH } from "@/lib/settingsPaths";
import { resolveShopifyIntegrationFromEnv } from "@/lib/shopifyFlag";

// Redirect target is the Shopify tab (裁决 a) once the integration is enabled;
// falls back to the previous Pinterest target when the flag is off (or its
// localStorage-only override, which this server-rendered redirect can't read)
// so flag-off behavior stays byte-for-byte unchanged (§8.4 UI-only gating).
export default function IntegrationsRedirectPage() {
  redirect(resolveShopifyIntegrationFromEnv() === true ? SETTINGS_SHOPIFY_PATH : SETTINGS_PINTEREST_PATH);
}
