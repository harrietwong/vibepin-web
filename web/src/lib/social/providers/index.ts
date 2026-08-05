/**
 * Provider registry + resolver.
 *
 * The rest of the app never imports a concrete vendor. It calls
 * getSocialProvider() and programs against the SocialPublishingProvider
 * contract, so switching the active back-end (mock → Zernio → OneUp → Publer →
 * Ayrshare → official APIs) happens here alone.
 *
 * Selection order:
 *   1. SOCIAL_PUBLISHING_PROVIDER env var (zernio | oneup | mock), if it maps
 *      to a registered provider.
 *   2. mock — the safe MVP default (no credentials, no live network calls).
 */

import type { AuthProvider } from "../platforms";
import type { SocialPublishingProvider } from "../types";
import { mockProvider } from "./mock";
import { zernioProvider, isZernioConfigured, zernioMissingEnv, zernioConfig } from "./zernio";
import { oneupProvider } from "./oneup";
import { officialProvider } from "./official";

const REGISTRY: Partial<Record<AuthProvider, SocialPublishingProvider>> = {
  mock: mockProvider,
  zernio: zernioProvider,
  oneup: oneupProvider,
  official: officialProvider,
};

/** The provider id configured via env (defaults to "mock"). */
export function selectedProviderId(): AuthProvider {
  const configured = (process.env.SOCIAL_PUBLISHING_PROVIDER ?? "").trim().toLowerCase();
  return (configured in REGISTRY ? configured : "mock") as AuthProvider;
}

/** The provider VibePin currently uses. Defaults to the mock provider. */
export function getSocialProvider(): SocialPublishingProvider {
  return REGISTRY[selectedProviderId()] ?? mockProvider;
}

/**
 * Server-only, secret-free description of the active provider's configuration.
 * Reports whether required env is present — never the values themselves.
 */
export function getProviderStatus(): {
  provider: AuthProvider;
  configured: boolean;
  baseUrlConfigured: boolean;
  missingEnv: string[];
} {
  const provider = selectedProviderId();
  if (provider === "zernio") {
    return {
      provider,
      configured: isZernioConfigured(),
      baseUrlConfigured: !!zernioConfig().baseUrl,
      missingEnv: zernioMissingEnv(),
    };
  }
  // mock (and any other no-config provider) is always "configured".
  return { provider, configured: true, baseUrlConfigured: true, missingEnv: [] };
}

/** Look up a specific provider by id (e.g. to re-run publishing on the one that owns a connection). */
export function getSocialProviderById(id: AuthProvider | null | undefined): SocialPublishingProvider {
  if (!id) return getSocialProvider();
  return REGISTRY[id] ?? getSocialProvider();
}

export { mockProvider, zernioProvider, oneupProvider, officialProvider };
