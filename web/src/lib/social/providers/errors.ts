/**
 * Errors shared by provider adapters. Kept separate so routes can translate a
 * misconfiguration into a safe, user-facing message without importing any
 * vendor-specific code.
 */

/** Safe, client-displayable message for any unconfigured publishing provider. */
export const PROVIDER_NOT_CONFIGURED_MESSAGE = "Social publishing provider is not configured yet.";

/**
 * Thrown by a provider adapter when required server-side configuration (e.g.
 * ZERNIO_API_KEY) is missing. The message is intentionally generic — it never
 * contains secrets or which exact key is missing (that detail is only exposed,
 * key-name-only, via the authenticated /api/social/provider-status route).
 */
export class ProviderConfigError extends Error {
  readonly code = "provider_not_configured";
  constructor(message: string = PROVIDER_NOT_CONFIGURED_MESSAGE) {
    super(message);
    this.name = "ProviderConfigError";
  }
}

export function isProviderConfigError(err: unknown): err is ProviderConfigError {
  return err instanceof ProviderConfigError;
}
