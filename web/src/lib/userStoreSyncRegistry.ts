/**
 * userStoreSyncRegistry.ts — WP-B wiring.
 *
 * Registers every account-level store adapter with the generic write-through sync
 * engine (userStoreSync.ts) and exposes a single init entry point that the app
 * shell calls alongside initPinDraftSync (same access token).
 *
 * Each adapter is defined next to its store (so the store owns its own updatedAt
 * stamping + change event); this module only collects them. Registration is
 * idempotent and SSR-safe — registerStoreSync is inert without window, and the
 * engine mounts each instance once both registration and init have happened.
 */

import { initUserStoreSync, registerStoreSync, type GetAccessToken } from "./userStoreSync";

import { smartScheduleSyncAdapter } from "./smartScheduleStore";
import { notificationPrefsSyncAdapter } from "./notificationPrefsStore";
import { publishingPrefsSyncAdapter } from "./publishingPrefsStore";
import { brandProfileSyncAdapter } from "./brandProfileStore";
import { amazonAffiliateSettingsSyncAdapter } from "./affiliate/amazonAffiliateSettings";
import { nichesSyncAdapter } from "./niches";
import { creatorProductLinksSyncAdapter } from "./affiliate/creatorProductLink";
import { bookmarksSyncAdapter } from "./useBookmarks";
import { pinMetadataSyncAdapter } from "./pinMetadataStore";
import { pinSessionsSyncAdapter, pinRecordsSyncAdapter } from "./pinStore";

let _registered = false;

function registerAll(): void {
  if (_registered) return;
  _registered = true;
  // Singletons (one fixed doc_id each)
  registerStoreSync(smartScheduleSyncAdapter);
  registerStoreSync(notificationPrefsSyncAdapter);
  registerStoreSync(publishingPrefsSyncAdapter);
  registerStoreSync(brandProfileSyncAdapter);
  registerStoreSync(amazonAffiliateSettingsSyncAdapter);
  registerStoreSync(nichesSyncAdapter);
  // Collections (doc_id per row)
  registerStoreSync(creatorProductLinksSyncAdapter);
  registerStoreSync(bookmarksSyncAdapter);
  registerStoreSync(pinMetadataSyncAdapter);
  registerStoreSync(pinSessionsSyncAdapter);
  registerStoreSync(pinRecordsSyncAdapter);
}

/**
 * Register every store adapter and mount the shared engine on the given token.
 * Mirrors initPinDraftSync's contract: idempotent, SSR-safe, failures degrade to
 * pure-localStorage behaviour (the engine retries in the background).
 */
export function initAllUserStoreSync(getToken: GetAccessToken): void {
  registerAll();
  initUserStoreSync(getToken);
}
