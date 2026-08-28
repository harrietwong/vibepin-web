import "server-only";

import { createServerClient } from "@/lib/supabase";
import {
  publishedPinterestPinsFromDraft,
  type VibePinPublishedPinterestPin,
} from "./publishProvenance";

const TABLE = "pin_drafts";
const PAGE_SIZE = 500;

export type { VibePinPublishedPinterestPin } from "./publishProvenance";
export {
  legacyPublishedPinterestPinFromDraft,
  parseDestinationResults,
  publishedPinterestPinsFromDraft,
} from "./publishProvenance";

export type VibePinPublishedPinterestResult = {
  pins: Map<string, VibePinPublishedPinterestPin>;
  storageAvailable: boolean;
};

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
 *
 * Keyed by Pin id, not by draft: one draft can produce several Pins (one per
 * destination account), and one Pin belongs to exactly one draft. Rows arrive newest
 * first and the first record for a Pin wins, so a re-published draft's latest
 * attribution is the one Insights uses.
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
      for (const record of publishedPinterestPinsFromDraft(String(row.draft_id ?? ""), payload)) {
        if (!pins.has(record.pinId)) pins.set(record.pinId, record);
      }
    }

    if ((data ?? []).length < PAGE_SIZE) break;
  }

  return { pins, storageAvailable: true };
}
