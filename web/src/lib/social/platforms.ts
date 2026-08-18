/**
 * Canonical catalog of the social platforms VibePin can publish approved content
 * to. Shared by the Settings "Social accounts" tab, the "Publish destinations"
 * selector, the API routes, and the provider abstraction so there is a single
 * source of truth for names, ordering, and per-platform capabilities.
 *
 * IMPORTANT: this file is import-safe on both server and client — no secrets, no
 * Node-only APIs.
 */

export type SocialProvider = "pinterest" | "instagram" | "facebook" | "tiktok";

/** Lifecycle of a connected account. Mirrors social_connections.connection_status. */
export type ConnectionStatus =
  | "connected"
  | "not_connected"
  | "expired"
  | "revoked"
  | "error";

/** Which vendor/back-end brokered a connection. Mirrors social_connections.auth_provider. */
export type AuthProvider =
  | "zernio"
  | "oneup"
  | "publer"
  | "ayrshare"
  | "official"
  | "mock";

export interface PlatformMeta {
  provider: SocialProvider;
  /** Display name. Brand names are never localized. */
  name: string;
  /** Brand accent color used for the icon chip. */
  brandColor: string;
  /** What connecting unlocks — shown on the Settings card. */
  capabilities: string[];
  /**
   * Whether a real connection path exists yet. Pinterest has live OAuth today;
   * the others are structurally ready but surface a "setup pending" state until
   * a provider adapter is wired.
   */
  liveConnect: boolean;
  /**
   * Whether this platform can be a destination for a FUTURE-DATED publish.
   *
   * Separate from `liveConnect` on purpose: publishing now and publishing later
   * are different capabilities with different requirements. Publishing later
   * additionally requires that the chosen destination be persisted with the Pin
   * and re-read at due time — and today only Pinterest is (boardId +
   * targetConnectionId ride the draft; the due-time worker reads them back).
   *
   * A merchant who ticks Instagram and schedules currently gets Pinterest only,
   * silently, because the intent was never stored and the due worker is
   * Pinterest-only. Until scheduled destination intent is persisted, scheduling
   * is refused for those platforms rather than accepted and quietly dropped.
   *
   * Publish now is unaffected — it dispatches immediately from the live
   * selection, so nothing has to survive until later.
   */
  liveSchedule: boolean;
}

export const SOCIAL_PROVIDERS: readonly SocialProvider[] = [
  "pinterest",
  "instagram",
  "facebook",
  "tiktok",
] as const;

export const PLATFORMS: Record<SocialProvider, PlatformMeta> = {
  pinterest: {
    provider: "pinterest",
    name: "Pinterest",
    brandColor: "#E60023",
    capabilities: ["Read your boards", "Publish Pins", "Sync board list", "Track publishing status"],
    liveConnect: true,
    liveSchedule: true,
  },
  instagram: {
    provider: "instagram",
    name: "Instagram",
    brandColor: "#E1306C",
    capabilities: ["Publish photo posts", "Repurpose product posts", "Track publishing status"],
    liveConnect: true,
    liveSchedule: false,
  },
  facebook: {
    provider: "facebook",
    name: "Facebook Page",
    brandColor: "#1877F2",
    capabilities: ["Publish to your Page", "Repurpose product posts", "Track publishing status"],
    liveConnect: true,
    liveSchedule: false,
  },
  tiktok: {
    provider: "tiktok",
    name: "TikTok",
    brandColor: "#010101",
    capabilities: ["Publish video posts", "Repurpose product posts", "Track publishing status"],
    liveConnect: false,
    liveSchedule: false,
  },
};

export function isSocialProvider(value: unknown): value is SocialProvider {
  return typeof value === "string" && (SOCIAL_PROVIDERS as readonly string[]).includes(value);
}

export function platformName(provider: SocialProvider): string {
  return PLATFORMS[provider].name;
}

/**
 * THE scheduling-capability rule. Every surface that can create a future-dated
 * publish — the drawer, batch edit, Smart Schedule, and the server route that
 * persists scheduled_at — must consult this one function, so the client and the
 * server can never disagree about what is schedulable.
 */
export function canSchedule(provider: SocialProvider): boolean {
  return PLATFORMS[provider].liveSchedule;
}

/**
 * The destinations from `selected` that cannot currently be scheduled.
 * Empty array ⇒ the selection is safe to persist with a future date.
 */
export function unschedulableDestinations(selected: readonly SocialProvider[]): SocialProvider[] {
  return selected.filter(p => !canSchedule(p));
}
