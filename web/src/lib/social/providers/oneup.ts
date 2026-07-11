/**
 * OneUp provider adapter — SKELETON.
 *
 * Placeholder for a future OneUp integration, mirroring zernio.ts. Register in
 * ../index.ts and fill in the real calls when credentials are available. Every
 * method degrades honestly until then.
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

// const ONEUP_API_BASE = process.env.ONEUP_API_BASE ?? "https://api.oneupapp.io";
// const ONEUP_API_KEY = process.env.ONEUP_API_KEY;

export const oneupProvider: SocialPublishingProvider = {
  id: "oneup",

  async getConnectUrl(input: GetConnectUrlInput): Promise<GetConnectUrlResult> {
    return {
      url: null,
      status: "coming_soon",
      message: `${platformName(input.provider)} connection via OneUp is not configured yet.`,
    };
  },

  async getConnections(_input: GetConnectionsInput): Promise<SocialConnection[]> {
    return [];
  },

  async publishPost(input: PublishPostInput): Promise<PublishResult> {
    return {
      ok: false,
      status: "not_implemented",
      error: `OneUp publishing for ${platformName(input.provider)} is not configured yet.`,
    };
  },

  async disconnect(_input: DisconnectInput): Promise<void> {
    /* TODO */
  },
};
