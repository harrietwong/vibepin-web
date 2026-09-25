/**
 * splitMixedVideoOps.ts — the operator-script entry point for the mixed
 * Pinterest+Instagram single-video split (T2 block 6, design doc
 * 0924-混合视频草稿自动拆分-技术设计-v0.1.md §2 (c), §3).
 *
 * Operator scripts write `pin_drafts` straight through PostgREST, so they bypass
 * `/api/pin-drafts` and its `mixed_video_requires_split` refusal; the cron would
 * then refuse the Instagram side at due time. This module is how a script writes a
 * mixed draft correctly: validate the IG caption, split, write BOTH rows.
 *
 *   1. `instagramCaptionIssues(caption)` — an empty / linked caption throws
 *      `MixedVideoCaptionRejected` BEFORE anything is written.
 *   2. `splitMixedVideoDraft(draft, { instagramCaption })` — the same pure split
 *      the UI uses (deterministic child id `${draftId}__ig`).
 *   3. Parent first (Pinterest-only, upsert/merge — the script owns its content),
 *      then the child with `resolution=ignore-duplicates`: an existing child —
 *      which the merchant may have edited in the app — is NEVER overwritten.
 *   4. Read back: both rows must exist, and the parent must carry no Instagram
 *      destination.
 *
 * Replaying the same input any number of times leaves exactly two rows. A draft
 * that is not a mixed single video is written as one row, unchanged.
 *
 * The transport is injected (`rest(path, init)` — the same shape as the scripts'
 * own PostgREST helper), so this module never picks a database: the caller's
 * helper decides the project, and test-db-config / env guards stay where they are.
 */
import {
  instagramCaptionIssues,
  splitMixedVideoDraft,
  type InstagramCaptionIssueCode,
} from "../../src/lib/studio/splitMixedVideoDraft";
import type { PinDraft } from "../../src/lib/pinDraftStore";

export type PostgrestRest = (path: string, init?: RequestInit) => Promise<Response>;

export class MixedVideoCaptionRejected extends Error {
  constructor(public readonly draftId: string, public readonly issues: InstagramCaptionIssueCode[]) {
    super(`instagram_caption_rejected:${draftId}:${issues.join(",")}`);
    this.name = "MixedVideoCaptionRejected";
  }
}

export type WriteMixedVideoDraftInput = {
  rest: PostgrestRest;
  userId: string;
  /** The draft exactly as the script would have written it (may name both platforms). */
  draft: PinDraft;
  /** The Instagram caption (e.g. the queue's `copy.instagram.caption`). Only
   *  required — and validated — when the draft actually needs splitting. */
  instagramCaption?: string | null;
  /** The `scheduled_at` column value the script computed (ISO), or null. Both
   *  rows get the same instant: the split copies the schedule. */
  scheduledAt: string | null;
  now?: Date;
};

export type WriteMixedVideoDraftResult =
  | { split: false; draftIds: [string] }
  | { split: true; draftIds: [string, string]; childInserted: boolean };

/** Pure planning step (no I/O) — exported so a dry-run can show what would be
 *  written, and for tests. Throws `MixedVideoCaptionRejected` on a bad caption. */
export function planMixedVideoDraftWrite(draft: PinDraft, instagramCaption: string | null | undefined, now?: Date) {
  const probe = splitMixedVideoDraft(draft, { instagramCaption: instagramCaption ?? "", now });
  if (!probe.split) return probe;
  const issues = instagramCaptionIssues(instagramCaption);
  if (issues.length) throw new MixedVideoCaptionRejected(draft.id, issues);
  return probe;
}

function rowFor(userId: string, draft: PinDraft, scheduledAt: string | null): Record<string, unknown> {
  return {
    vibepin_user_id: userId,
    draft_id: draft.id,
    payload: draft,
    status: draft.status ?? null,
    updated_at: draft.updatedAt,
    created_at: draft.createdAt,
    deleted_at: null,
    scheduled_at: scheduledAt,
  };
}

async function ensureOk(response: Response, what: string): Promise<void> {
  if (response.ok) return;
  let detail = "";
  try { detail = (await response.text()).slice(0, 200); } catch { /* ignore */ }
  throw new Error(`${what}_failed_${response.status}${detail ? `:${detail}` : ""}`);
}

export async function writeMixedVideoDraft(input: WriteMixedVideoDraftInput): Promise<WriteMixedVideoDraftResult> {
  const plan = planMixedVideoDraftWrite(input.draft, input.instagramCaption, input.now);
  const upsert = `/pin_drafts?on_conflict=vibepin_user_id,draft_id`;

  // The parent (or the unsplit draft) — the script owns this content, so merge.
  await ensureOk(await input.rest(upsert, {
    method: "POST",
    headers: { "content-type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(rowFor(input.userId, plan.parent, input.scheduledAt)),
  }), "parent_write");
  if (!plan.split) return { split: false, draftIds: [plan.parent.id] };

  // The child — insert only when absent; a merchant-edited child is never overwritten.
  const childResponse = await input.rest(upsert, {
    method: "POST",
    headers: { "content-type": "application/json", Prefer: "resolution=ignore-duplicates,return=representation" },
    body: JSON.stringify(rowFor(input.userId, plan.child, input.scheduledAt)),
  });
  await ensureOk(childResponse, "child_write");
  let childInserted = false;
  try {
    const inserted = await childResponse.json() as unknown[];
    childInserted = Array.isArray(inserted) && inserted.length > 0;
  } catch { childInserted = false; }

  // Read back both rows under this owner.
  const ids = [plan.parent.id, plan.child.id];
  const check = await input.rest(
    `/pin_drafts?select=draft_id,payload&vibepin_user_id=eq.${encodeURIComponent(input.userId)}`
    + `&draft_id=in.(${ids.map(id => `"${id}"`).join(",")})`,
  );
  await ensureOk(check, "readback");
  const rows = await check.json() as Array<{ draft_id: string; payload: Record<string, unknown> }>;
  const byId = new Map(rows.map(row => [row.draft_id, row]));
  if (!byId.has(plan.parent.id) || !byId.has(plan.child.id)) throw new Error(`readback_missing:${ids.join(",")}`);
  const parentDestinations = byId.get(plan.parent.id)!.payload?.scheduledDestinations;
  if (Array.isArray(parentDestinations)
      && parentDestinations.some(d => (d as { provider?: unknown })?.provider === "instagram")) {
    throw new Error(`readback_parent_still_mixed:${plan.parent.id}`);
  }
  return { split: true, draftIds: [plan.parent.id, plan.child.id], childInserted };
}
