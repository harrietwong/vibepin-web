/**
 * Message-key maps for the admin operator console (/admin/today + Customer 360
 * alert strip). Kept OUTSIDE the page files so the i18n gate test can import
 * them (Next.js pages may not have arbitrary named exports) and so the blocker
 * list and the per-user strip can never use different labels.
 *
 * Compile-time guarantee: each Record is keyed by the full server-layer enum,
 * so adding a BlockerType / FunnelStage / health driver without a message key
 * is a type error.
 */

import type { BlockerType, UserHealth } from "@/lib/server/adminActionCenter";
import type { FunnelStage } from "@/lib/server/adminActivationFunnel";
import type { AccountKind } from "@/lib/server/adminAccountKind";
import type { GenerationErrorType } from "@/lib/studioPersistence";
import type { AdminMessageKey } from "@/lib/admin/adminMessages";

export const BLOCKER_LABEL_KEY: Record<BlockerType, AdminMessageKey> = {
  publish_failure: "blocker.publish_failure.label",
  pinterest_disconnected: "blocker.pinterest_disconnected.label",
  generation_failures: "blocker.generation_failures.label",
  signup_not_connected: "blocker.signup_not_connected.label",
  connected_not_creating: "blocker.connected_not_creating.label",
};

export const BLOCKER_ACTION_KEY: Record<BlockerType, AdminMessageKey> = {
  publish_failure: "blocker.publish_failure.action",
  pinterest_disconnected: "blocker.pinterest_disconnected.action",
  generation_failures: "blocker.generation_failures.action",
  signup_not_connected: "blocker.signup_not_connected.action",
  connected_not_creating: "blocker.connected_not_creating.action",
};

export const FUNNEL_STAGE_KEY: Record<FunnelStage, AdminMessageKey> = {
  signup: "funnel.stage.signup",
  pinterestConnected: "funnel.stage.pinterestConnected",
  firstGeneration: "funnel.stage.firstGeneration",
  firstPublish: "funnel.stage.firstPublish",
  repeatPublish: "funnel.stage.repeatPublish",
};

export const HEALTH_DRIVER_KEY: Record<UserHealth["drivers"][number], AdminMessageKey> = {
  activeLast7d: "c360.health.driver.activeLast7d",
  publishedLast14d: "c360.health.driver.publishedLast14d",
  pinterestHealthy: "c360.health.driver.pinterestHealthy",
  noOpenBlockers: "c360.health.driver.noOpenBlockers",
};

export const HEALTH_BAND_KEY: Record<UserHealth["band"], AdminMessageKey> = {
  green: "c360.health.band.green",
  yellow: "c360.health.band.yellow",
  red: "c360.health.band.red",
};

/**
 * Chip label per account kind. `customer` maps to null: a real customer is the
 * default and gets NO chip — labelling the normal case would make the list
 * noisier, not clearer.
 */
export const ACCOUNT_KIND_KEY: Record<AccountKind, AdminMessageKey | null> = {
  customer: null,
  test: "today.accountKind.test",
  internal: "today.accountKind.internal",
};

/**
 * Human label per generation failure class. Keyed by the FULL GenerationErrorType
 * union, so adding a failure class without a label is a compile error rather
 * than a raw enum leaking into the operator's screen.
 *
 * Values that are not in the union (older rows, a provider string we never
 * classified) are rendered verbatim by the caller — showing the raw value beats
 * showing nothing when someone is debugging a live failure.
 */
export const GENERATION_ERROR_KEY: Record<GenerationErrorType, AdminMessageKey> = {
  rate_limited: "genError.rate_limited",
  safety_blocked: "genError.safety_blocked",
  image_load_failed: "genError.image_load_failed",
  model_returned_text: "genError.model_returned_text",
  api_auth_error: "genError.api_auth_error",
  api_payload_error: "genError.api_payload_error",
  api_server_error: "genError.api_server_error",
  provider_busy: "genError.provider_busy",
  user_generation_limit: "genError.user_generation_limit",
  configuration_error: "genError.configuration_error",
  unknown_error: "genError.unknown_error",
};

/** Resolve a raw error_type to a message key, or null when it is unrecognized. */
export function generationErrorKey(raw: string | null | undefined): AdminMessageKey | null {
  if (!raw) return null;
  return (GENERATION_ERROR_KEY as Record<string, AdminMessageKey | undefined>)[raw] ?? null;
}
