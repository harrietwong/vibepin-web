/**
 * Mock publishing provider — the active provider for MVP.
 *
 * It lets the entire connect → review → select destinations → publish flow be
 * exercised end-to-end with no third-party credentials. It never performs real
 * network calls and never auto-publishes: it only ever runs when a route is
 * reached because the merchant explicitly acted.
 *
 * Behaviour:
 *   getConnectUrl  → no live OAuth; returns a "coming soon / setup pending" hint
 *                    so the UI can show a clear next step.
 *   getConnections → returns nothing; real connections are read from the DB by
 *                    the server store, not the provider, for MVP.
 *   publishPost    → reports "not_implemented" (no live adapter) rather than
 *                    pretending a post succeeded.
 *   disconnect     → no-op (the DB row is cleared by the route).
 */

import { platformName } from "../platforms";
import type {
  DisconnectInput,
  GetConnectUrlInput,
  GetConnectUrlResult,
  GetConnectionsInput,
  PublishPostInput,
  PublishResult,
  SocialConnection,
  SocialPublishingProvider,
} from "../types";

export const mockProvider: SocialPublishingProvider = {
  id: "mock",

  async getConnectUrl(input: GetConnectUrlInput): Promise<GetConnectUrlResult> {
    return {
      url: null,
      status: "coming_soon",
      message: `${platformName(input.provider)} connection setup is pending — we'll email you when it's ready to connect.`,
    };
  },

  async getConnections(_input: GetConnectionsInput): Promise<SocialConnection[]> {
    return [];
  },

  async publishPost(input: PublishPostInput): Promise<PublishResult> {
    return {
      ok: false,
      status: "not_implemented",
      error: `Publishing to ${platformName(input.provider)} is not available yet.`,
    };
  },

  async disconnect(_input: DisconnectInput): Promise<void> {
    /* no-op — the API route clears the stored connection row */
  },
};
