/** Owner-scoped persistence for the pre-generation Reference setup.
 *
 * This is deliberately setup-only: it stores no generation job, placeholder,
 * toast, reservation, usage record, prompt body, or provider response. The verified
 * Pin Draft owner scope supplies the namespace, preventing account A from seeing
 * account B's drawer selections on the same browser.
 */

import { getPinDraftOwnerScope } from "@/lib/pinDraftStore";
import type { SelectedReference } from "./selectedReferences";
type VariationMode = "distinct" | "similar";

export type PersistedCreativeSetup = {
  productImages: string[];
  referenceImages: string[];
  referenceSelections?: SelectedReference[];
  count: number;
  format: string;
  modelKey: string;
  variationMode: VariationMode;
  selectedDirectionId: string | null;
  selectedTagIds: string[];
  directionBrief: string;
  briefManuallyEdited: boolean;
};

type SetupEnvelope = { version: 1; updatedAt: string; setups: Record<string, PersistedCreativeSetup> };
const PREFIX = "vp:creative_setup:v1";
const MAX_SETUPS = 80;

function storageKey(): string | null {
  if (typeof window === "undefined") return null;
  const scope = getPinDraftOwnerScope();
  if (!scope?.ownerUserId) return null;
  return `${PREFIX}:${encodeURIComponent(scope.ownerUserId)}:${encodeURIComponent(scope.workspaceId)}`;
}

function sanitizeKey(key: string): string {
  return key.trim().slice(0, 160);
}

function readEnvelope(): SetupEnvelope {
  const key = storageKey();
  if (!key) return { version: 1, updatedAt: "", setups: {} };
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? "") as Partial<SetupEnvelope>;
    return parsed.version === 1 && parsed.setups && typeof parsed.setups === "object"
      ? { version: 1, updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "", setups: parsed.setups }
      : { version: 1, updatedAt: "", setups: {} };
  } catch {
    return { version: 1, updatedAt: "", setups: {} };
  }
}

export function loadCreativeSetup(key: string): PersistedCreativeSetup | undefined {
  const safeKey = sanitizeKey(key);
  if (!safeKey) return undefined;
  return readEnvelope().setups[safeKey];
}

export function saveCreativeSetup(key: string, setup: PersistedCreativeSetup): boolean {
  const storeKey = storageKey();
  const safeKey = sanitizeKey(key);
  if (!storeKey || !safeKey) return false;
  const envelope = readEnvelope();
  const setups = { ...envelope.setups, [safeKey]: setup };
  const keys = Object.keys(setups);
  for (const stale of keys.slice(0, Math.max(0, keys.length - MAX_SETUPS))) delete setups[stale];
  try {
    localStorage.setItem(storeKey, JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), setups } satisfies SetupEnvelope));
    return true;
  } catch {
    return false;
  }
}

export function creativeSetupStorageKeyForTest(ownerUserId: string, workspaceId = "default"): string {
  return `${PREFIX}:${encodeURIComponent(ownerUserId)}:${encodeURIComponent(workspaceId)}`;
}
