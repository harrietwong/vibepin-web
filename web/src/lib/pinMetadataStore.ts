/**
 * pinMetadataStore.ts — persists per-pin metadata drafts in localStorage.
 */

import type { MetadataTouchedFlags, PinMetadataDraft } from "./pinMetadata";
import { EMPTY_TOUCHED } from "./pinMetadata";

const STORE_KEY = "vp:pin_metadata:v1";
const MAX_PINS = 2000;
export const METADATA_STORE_EVENT = "vp:pin_metadata_updated";

export type StoredPinMetadata = {
  pinId: string;
  sessionId: string;
  imageUrl: string;
  metadataDraft: PinMetadataDraft;
  title: string;
  description: string;
  altText: string;
  destinationUrl: string;
  plannedDate: string;
  plannedTime?: string;
  plannedAt?: string;
  planningStatus: string;
  touched: MetadataTouchedFlags;
  updatedAt: string;
};

type StoreData = { pins: Record<string, StoredPinMetadata> };

function ok(): boolean { return typeof window !== "undefined"; }

function load(): StoreData {
  if (!ok()) return { pins: {} };
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return { pins: {} };
    const p = JSON.parse(raw) as Partial<StoreData>;
    return { pins: p.pins ?? {} };
  } catch { return { pins: {} }; }
}

function persist(data: StoreData): void {
  if (!ok()) return;
  const sorted = Object.values(data.pins)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, MAX_PINS);
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ pins: Object.fromEntries(sorted.map(p => [p.pinId, p])) }));
  } catch { /* quota */ }
}

function emit(): void {
  if (ok()) window.dispatchEvent(new Event(METADATA_STORE_EVENT));
}

export function getPinMetadata(pinId: string): StoredPinMetadata | null {
  return load().pins[pinId] ?? null;
}

export function getSessionPinMetadata(sessionId: string): StoredPinMetadata[] {
  return Object.values(load().pins).filter(p => p.sessionId === sessionId);
}

export function savePinMetadata(record: Omit<StoredPinMetadata, "updatedAt"> & { updatedAt?: string }): StoredPinMetadata {
  const data = load();
  const now = new Date().toISOString();
  const stored: StoredPinMetadata = {
    ...record,
    touched: { ...EMPTY_TOUCHED, ...record.touched },
    updatedAt: record.updatedAt ?? now,
  };
  data.pins[stored.pinId] = stored;
  persist(data);
  emit();
  return stored;
}

export function deletePinMetadata(pinId: string): void {
  const data = load();
  delete data.pins[pinId];
  persist(data);
  emit();
}
