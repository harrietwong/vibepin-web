import { SETTINGS_SOCIAL_PATH } from "./settingsPaths";

/**
 * Canonical dark-app route for Pinterest OAuth return + connection management.
 *
 * Points at Social accounts (PRD §2): Pinterest no longer has its own Settings
 * section, and the `?pinterest=<status>` the OAuth callback appends is consumed
 * there. The legacy `/app/settings/pinterest` route still exists as a redirect for
 * old bookmarks, but nothing should send new traffic to it.
 */
export const PINTEREST_INTEGRATIONS_PATH = SETTINGS_SOCIAL_PATH;
