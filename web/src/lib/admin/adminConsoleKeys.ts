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
