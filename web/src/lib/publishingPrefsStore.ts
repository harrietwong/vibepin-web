/**
 * Publishing preferences — local workspace prefs (localStorage).
 * Controls weekly goal, default mode, format, and safety check toggles.
 */

import { makeSingletonAdapter } from "./userStoreSyncHelpers";
import { isSocialProvider, type SocialProvider } from "./social/platforms";

export type PublishingMode   = "manual" | "smart";
export type PublishingFormat = "standard" | "simplified";

/**
 * What happens when several images are picked at once (PRD §12).
 *
 * "ask" is the default on purpose: the first multi-image upload is the moment the
 * merchant learns the two outcomes exist, and guessing for them there is the exact
 * mistake that produced one 12-image post instead of 12 posts. Once they answer and
 * tick "Don't show this again", their answer is stored here — not in a bespoke
 * localStorage key — so it syncs across devices with the rest of their prefs.
 */
export type MultiUploadDefault = "ask" | "together" | "separate";

/**
 * A default publishing destination (PRD §17): one account per platform, plus the
 * board for Pinterest (board ids are per-account, so the two travel together).
 *
 * This is a RECOMMENDATION applied when NEW content is created. It is deliberately
 * NOT a rewrite rule: changing it here must never touch content the merchant has
 * already drafted, scheduled or posted.
 */
export type DefaultDestination = {
  provider:           SocialProvider;
  socialConnectionId: string;
  boardId?:           string;
  boardName?:         string;
  accountLabel?:      string;
};

export type PublishingPrefs = {
  weeklyGoal:          number;           // 1–14, default 5
  defaultMode:         PublishingMode;   // default "manual"
  defaultFormat:       PublishingFormat; // default "standard"
  duplicateUrlWarning: boolean;          // default true
  showAltTextField:    boolean;          // default true
  imageRefresh:        boolean;          // default false
  multiUploadDefault:  MultiUploadDefault;   // default "ask" (PRD §12)
  defaultDestinations: DefaultDestination[]; // default [] (PRD §17)
  updatedAt?:          string;           // ISO — stamped on every save (account sync)
};

const STORE_KEY = "vp:publishing_prefs:v1";
export const PUBLISHING_PREFS_EVENT = "vp:publishing_prefs_updated";

/**
 * The pre-prefs home of the multi-upload answer: a bespoke localStorage key written
 * by Create Pins. Kept only so an existing answer survives; `migrateMultiUploadMode`
 * adopts it once and deletes it.
 */
export const LEGACY_MULTI_UPLOAD_KEY = "vp:studio:multi-upload-mode";

export function defaultPublishingPrefs(): PublishingPrefs {
  return {
    weeklyGoal:          5,
    defaultMode:         "manual",
    defaultFormat:       "standard",
    duplicateUrlWarning: true,
    showAltTextField:    true,
    imageRefresh:        false,
    multiUploadDefault:  "ask",
    defaultDestinations: [],
  };
}

function asMultiUploadDefault(v: unknown): MultiUploadDefault | null {
  return v === "ask" || v === "together" || v === "separate" ? v : null;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/**
 * Sanitize stored destinations. This runs on every read, not just on the UI's own
 * writes, because the account-sync engine writes raw server JSON straight into the
 * same localStorage key — a half-record from an older/newer client must degrade to
 * "no default" rather than reach draft creation as a destination pointing nowhere.
 *
 * SEVERAL entries per provider are allowed — a merchant with two Pinterest accounts
 * may want new content to default to both. Deduping is by ACCOUNT
 * (`${provider}:${socialConnectionId}`, last one wins), so a duplicated payload still
 * cannot produce two conflicting defaults for the same account, while two different
 * accounts on one platform both survive. Keying on the provider alone silently
 * discarded the second account.
 */
export function sanitizeDefaultDestinations(raw: unknown): DefaultDestination[] {
  if (!Array.isArray(raw)) return [];
  const byAccount = new Map<string, DefaultDestination>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    if (!isSocialProvider(r.provider)) continue;
    const socialConnectionId = str(r.socialConnectionId);
    if (!socialConnectionId) continue;
    const entry: DefaultDestination = { provider: r.provider, socialConnectionId };
    const boardId = str(r.boardId);
    const boardName = str(r.boardName);
    const accountLabel = str(r.accountLabel);
    if (boardId) entry.boardId = boardId;
    if (boardName) entry.boardName = boardName;
    if (accountLabel) entry.accountLabel = accountLabel;
    byAccount.set(`${r.provider}:${socialConnectionId}`, entry);
  }
  return [...byAccount.values()];
}

function ok(): boolean { return typeof window !== "undefined"; }

function emit(): void {
  if (ok()) window.dispatchEvent(new Event(PUBLISHING_PREFS_EVENT));
}

export function getPublishingPrefs(): PublishingPrefs {
  if (!ok()) return defaultPublishingPrefs();
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return defaultPublishingPrefs();
    const p = JSON.parse(raw) as Partial<PublishingPrefs>;
    const d = defaultPublishingPrefs();
    return {
      weeklyGoal:          typeof p.weeklyGoal === "number" ? Math.min(14, Math.max(1, p.weeklyGoal)) : d.weeklyGoal,
      defaultMode:         p.defaultMode === "smart" ? "smart" : d.defaultMode,
      defaultFormat:       p.defaultFormat === "simplified" ? "simplified" : d.defaultFormat,
      duplicateUrlWarning: typeof p.duplicateUrlWarning === "boolean" ? p.duplicateUrlWarning : d.duplicateUrlWarning,
      showAltTextField:    typeof p.showAltTextField    === "boolean" ? p.showAltTextField    : d.showAltTextField,
      imageRefresh:        typeof p.imageRefresh        === "boolean" ? p.imageRefresh        : d.imageRefresh,
      multiUploadDefault:  asMultiUploadDefault(p.multiUploadDefault) ?? d.multiUploadDefault,
      defaultDestinations: sanitizeDefaultDestinations(p.defaultDestinations),
      updatedAt:           typeof p.updatedAt === "string" ? p.updatedAt : undefined,
    };
  } catch {
    return defaultPublishingPrefs();
  }
}

/**
 * Persist a partial change without clobbering the fields the caller doesn't own.
 *
 * Two surfaces write these prefs — the Settings tab and the Create Pins upload
 * dialog — and Settings holds a copy loaded when it mounted. Saving that whole copy
 * would silently revert a multi-upload answer given in Create Pins meanwhile. Every
 * write therefore re-reads first and merges.
 */
export function patchPublishingPrefs(patch: Partial<PublishingPrefs>): PublishingPrefs {
  const next = { ...getPublishingPrefs(), ...patch };
  savePublishingPrefs(next);
  return next;
}

/**
 * One-time adoption of the pre-prefs multi-upload answer.
 *
 * Only adopts when the pref is still untouched (`ask`): an answer the merchant has
 * since given in Settings must win over a stale browser key. The key is removed
 * either way once it has been considered, so this is idempotent and cheap to call
 * from every entry point that reads the preference.
 */
export function migrateMultiUploadMode(): PublishingPrefs {
  const prefs = getPublishingPrefs();
  if (!ok()) return prefs;
  let legacy: string | null = null;
  try {
    legacy = localStorage.getItem(LEGACY_MULTI_UPLOAD_KEY);
  } catch {
    return prefs;
  }
  if (legacy === null) return prefs;
  const adopted = legacy === "together" || legacy === "separate" ? legacy : null;
  const next = adopted && prefs.multiUploadDefault === "ask"
    ? patchPublishingPrefs({ multiUploadDefault: adopted })
    : prefs;
  try { localStorage.removeItem(LEGACY_MULTI_UPLOAD_KEY); } catch { /* pref already adopted */ }
  return next;
}

/**
 * The defaults that should seed NEW content, narrowed to accounts that are still
 * connected right now.
 *
 * `connectedIds === null` means "we don't know yet" (connections not loaded) and
 * yields NO defaults on purpose: prefilling from an unverified default can pin new
 * content to an account that has since been disconnected, which surfaces much later
 * as a publish failure. No prefill is recoverable; a wrong one is not.
 */
export function resolveDefaultDestinations(
  connectedIds: ReadonlySet<string> | null,
  prefs: PublishingPrefs = getPublishingPrefs(),
): DefaultDestination[] {
  if (!connectedIds) return [];
  return prefs.defaultDestinations.filter(d => connectedIds.has(d.socialConnectionId));
}

export function savePublishingPrefs(prefs: PublishingPrefs): void {
  if (!ok()) return;
  const payload: PublishingPrefs = { ...prefs, updatedAt: new Date().toISOString() };
  localStorage.setItem(STORE_KEY, JSON.stringify(payload));
  emit();
}

/**
 * Account-level sync adapter (WP-B). Singleton doc under storeKey `publishing_prefs`.
 * Reads/writes the same localStorage key + event as the getters/setters above, so
 * the Settings UI keeps working unchanged; the engine adds cross-device persistence.
 */
export const publishingPrefsSyncAdapter = makeSingletonAdapter<PublishingPrefs>({
  storeKey: "publishing_prefs",
  eventName: PUBLISHING_PREFS_EVENT,
  localStorageKey: STORE_KEY,
  docId: "prefs",
  emit,
});
