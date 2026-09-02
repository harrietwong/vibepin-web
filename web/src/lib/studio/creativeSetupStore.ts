/** Owner-scoped persistence for the pre-generation Reference setup.
 *
 * This is deliberately setup-only: it stores no generation job, placeholder,
 * toast, reservation, usage record, prompt body, or provider response. The verified
 * Pin Draft owner scope supplies the namespace, preventing account A from seeing
 * account B's drawer selections on the same browser.
 */

import { getPinDraftOwnerScope } from "@/lib/pinDraftStore";
import type { AiVersionDrawerSetup } from "@/components/studio/AiVersionDrawer";
import type { CanonicalProductSelection } from "./productSelection";

export type PersistedCreativeSetup = AiVersionDrawerSetup;

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

function opaqueDigest(value: unknown): string {
  const input = JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Scratch setup keys never expose merchant URLs in localStorage key names. */
export function creativeSetupKeyForScratchProduct(product?: CanonicalProductSelection | null): string {
  if (!product) return "scratch:empty";
  const id = product.id?.trim();
  if (id && !/^(?:https?:|data:|blob:)/i.test(id)) return `scratch:product:${id}`;
  return `scratch:digest:${opaqueDigest({
    id: id || null,
    imageUrl: product.imageUrl || null,
    publicUrl: product.publicUrl || null,
    canonicalUrl: product.canonicalUrl || null,
    source: product.source || null,
    store: product.store || null,
    commerceIds: product.commerceIds || null,
  })}`;
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
