import "server-only";

import { createServerClient } from "@/lib/supabase";

const TABLE = "pin_drafts";
const PAGE_SIZE = 500;

export type VibePinPublishedPinterestPin = {
  pinId: string;
  draftId: string;
  title: string | null;
  imageUrl: string | null;
  postUrl: string;
  publishedAt: string | null;
  mediaType: string | null;
};

export type VibePinPublishedPinterestResult = {
  pins: Map<string, VibePinPublishedPinterestPin>;
  storageAvailable: boolean;
};

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function pinterestPinId(value: unknown): string | null {
  const id = nonEmptyString(value);
  return id && /^\d+$/.test(id) ? id : null;
}

function mediaType(payload: Record<string, unknown>): string | null {
  return nonEmptyString(payload.mediaType)
    ?? nonEmptyString(payload.format)
    ?? (nonEmptyString(payload.imageUrl) ? "IMAGE" : null);
}

/**
 * Convert one server-authoritative VibePin draft into a Pinterest publish
 * provenance record. `remotePinId` is written only after Pinterest confirms a
 * successful publish, so title/image similarities never qualify a Pin.
 */
export function publishedPinterestPinFromDraft(
  draftId: string,
  payload: Record<string, unknown>,
): VibePinPublishedPinterestPin | null {
  const pinId = pinterestPinId(payload.remotePinId);
  if (!pinId) return null;

  return {
    pinId,
    draftId,
    title: nonEmptyString(payload.title),
    imageUrl: nonEmptyString(payload.imageUrl) ?? nonEmptyString(payload.sourceImageUrl),
    postUrl: nonEmptyString(payload.remotePinUrl) ?? `https://www.pinterest.com/pin/${pinId}/`,
    publishedAt: nonEmptyString(payload.postedAt),
    mediaType: mediaType(payload),
  };
}

function isMissingTable(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  const message = error.message ?? "";
  return error.code === "42P01"
    || error.code === "PGRST205"
    || message.includes("Could not find the table")
    || (message.includes("relation") && message.includes("does not exist"));
}

/**
 * Authoritative whitelist for Insights. Deleted/tombstoned drafts remain valid
 * provenance: deleting a local draft does not unpublish its remote Pinterest Pin.
 */
export async function listVibePinPublishedPinterestPins(
  uid: string,
): Promise<VibePinPublishedPinterestResult> {
  const db = createServerClient();
  const pins = new Map<string, VibePinPublishedPinterestPin>();

  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await db
      .from(TABLE)
      .select("draft_id,payload")
      .eq("vibepin_user_id", uid)
      .order("updated_at", { ascending: false })
      .range(from, from + PAGE_SIZE - 1);

    if (error) {
      if (isMissingTable(error)) return { pins, storageAvailable: false };
      throw new Error(`Unable to read VibePin publish records: ${error.message}`);
    }

    for (const row of data ?? []) {
      const payload = row.payload && typeof row.payload === "object" && !Array.isArray(row.payload)
        ? row.payload as Record<string, unknown>
        : {};
      const record = publishedPinterestPinFromDraft(String(row.draft_id ?? ""), payload);
      if (record && !pins.has(record.pinId)) pins.set(record.pinId, record);
    }

    if ((data ?? []).length < PAGE_SIZE) break;
  }

  return { pins, storageAvailable: true };
}
