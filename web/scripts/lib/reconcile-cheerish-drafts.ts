export const CONNECTION_ID = "a273f91c-4589-4fce-b19c-e24f2bdf6c99";
export const ACCOUNT_LABEL = "cheerishh";
export const BOARD_IDS: Record<string, string> = {
  "Cleaning & Self-Care Finds": "813814663855482395",
  "Gift Ideas for Her & Personalized Jewelry": "813814663855482394",
  "Home & Kitchen Finds": "813814663854885698",
  "Smart Gadgets & Everyday Essentials": "813814663855482397",
};

export type ManifestRow = {
  mappingId: string;
  sha256: string;
  localFilePath: string;
  sourceLocalFileName?: string;
  title: string;
  description: string;
  destinationUrl: string;
  boardName: string;
  scheduledAt: string;
};

export type DraftPayload = {
  title?: string;
  description?: string;
  destinationUrl?: string;
  boardName?: string;
  boardId?: string;
  scheduledDate?: string;
  scheduledTime?: string;
  plannedAt?: string;
  scheduleTimezone?: string;
  media?: Array<{ id?: string; kind?: string; url?: string; [key: string]: unknown }>;
  remotePinId?: string;
  postedAt?: string;
  publishError?: string;
  failureType?: string;
  destinationResults?: Array<{ status?: string; [key: string]: unknown }>;
  scheduledDestinations?: Array<{ provider?: string; socialConnectionId?: string; boardId?: string; [key: string]: unknown }>;
  [key: string]: unknown;
};

export type ExistingDraft = {
  userId: string;
  draftId: string;
  status: string;
  scheduledAt: string | null;
  updatedAt: string;
  publishClaimedAt: string | null;
  payload: DraftPayload;
};

export type Match = {
  row: ManifestRow;
  draftId: string;
  media: NonNullable<DraftPayload["media"]>[number];
  mediaId: string;
  boardId: string;
  current: ExistingDraft;
};

export type ReviewPatch = {
  operation: "update_existing_pin_draft";
  draftId: string;
  expected: { userId: string; status: string; scheduled_at: string | null; updatedAt: string; mediaId: string; mediaUrl: string };
  media: NonNullable<DraftPayload["media"]>[number];
  set: {
    status: "ready";
    scheduled_at: string;
    payload: Record<string, unknown>;
  };
};

function localDateTime(value: string): { date: string; time: string } | null {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/.exec(value);
  return match ? { date: match[1], time: match[2] } : null;
}

function payloadDateTime(payload: DraftPayload): { date: string; time: string } | null {
  if (typeof payload.scheduledDate !== "string" || typeof payload.scheduledTime !== "string") return null;
  const date = payload.scheduledDate.trim();
  const time = payload.scheduledTime.trim().slice(0, 5);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && /^\d{2}:\d{2}$/.test(time) ? { date, time } : null;
}

export function classifyExistingDraft(draft: ExistingDraft): "draft" | "scheduled" | "posted" | "failed" {
  if (draft.payload.remotePinId || draft.payload.postedAt || draft.payload.destinationResults?.some((result) => result.status === "published")) return "posted";
  if (draft.payload.publishError || draft.payload.failureType || draft.payload.destinationResults?.some((result) => result.status === "failed")) return "failed";
  if (draft.scheduledAt) return "scheduled";
  return "draft";
}

function matchFields(row: ManifestRow, draft: ExistingDraft): boolean {
  const dateTime = localDateTime(row.scheduledAt);
  const currentDateTime = payloadDateTime(draft.payload);
  return !!dateTime && !!currentDateTime
    && draft.payload.title === row.title
    && draft.payload.description === row.description
    && draft.payload.destinationUrl === row.destinationUrl
    && draft.payload.boardName === row.boardName
    && currentDateTime.date === dateTime.date
    && currentDateTime.time === dateTime.time;
}

export function reconcileDrafts(rows: ManifestRow[], existing: ExistingDraft[]): { ok: boolean; items: Match[]; failures: string[] } {
  const items: Match[] = [];
  const failures: string[] = [];
  const used = new Set<string>();
  for (const row of rows) {
    const candidates = existing.filter((draft) => matchFields(row, draft));
    if (candidates.length === 0) { failures.push(`${row.mappingId}: missing existing draft for title/date/board/content`); continue; }
    if (candidates.length > 1) { failures.push(`${row.mappingId}: ambiguous existing draft (${candidates.map((draft) => draft.draftId).join(",")})`); continue; }
    const draft = candidates[0];
    if (used.has(draft.draftId)) { failures.push(`${row.mappingId}: ambiguous duplicate use of ${draft.draftId}`); continue; }
    used.add(draft.draftId);
    const lifecycle = classifyExistingDraft(draft);
    if (lifecycle !== "draft") { failures.push(`${row.mappingId}: existing draft ${draft.draftId} is not_draft (${lifecycle})`); continue; }
    if (draft.status !== "ready" && draft.status !== "draft") { failures.push(`${row.mappingId}: existing draft ${draft.draftId} has unsupported status ${draft.status}`); continue; }
    const media = draft.payload.media?.filter((item) => item.kind === "video" && typeof item.id === "string" && typeof item.url === "string") ?? [];
    if (media.length !== 1) { failures.push(`${row.mappingId}: existing draft ${draft.draftId} must have exactly one video media item`); continue; }
    const boardId = BOARD_IDS[row.boardName];
    if (!boardId) { failures.push(`${row.mappingId}: missing board id for ${row.boardName}`); continue; }
    items.push({ row, draftId: draft.draftId, media: media[0], mediaId: media[0].id!, boardId, current: draft });
  }
  return { ok: failures.length === 0, items, failures };
}

export function buildReviewPatch(match: Match, connectionId = CONNECTION_ID, accountLabel = ACCOUNT_LABEL): ReviewPatch {
  const dateTime = localDateTime(match.row.scheduledAt);
  if (!dateTime) throw new Error(`invalid_schedule:${match.row.mappingId}`);
  const capturedAt = new Date().toISOString();
  return {
    operation: "update_existing_pin_draft",
    draftId: match.draftId,
    expected: { userId: match.current.userId, status: match.current.status, scheduled_at: match.current.scheduledAt, updatedAt: match.current.updatedAt, mediaId: match.mediaId, mediaUrl: String(match.media.url) },
    media: match.media,
    set: {
      status: "ready",
      scheduled_at: match.row.scheduledAt,
      payload: {
        title: match.row.title,
        description: match.row.description,
        destinationUrl: match.row.destinationUrl,
        boardId: match.boardId,
        boardName: match.row.boardName,
        scheduledDate: dateTime.date,
        scheduledTime: dateTime.time,
        plannedAt: `${dateTime.date}T${dateTime.time}`,
        scheduleTimezone: "America/New_York",
        targetConnectionId: connectionId,
        targetAccountLabel: accountLabel,
        scheduledDestinations: [{ provider: "pinterest", socialConnectionId: connectionId, accountLabel, boardId: match.boardId, boardName: match.row.boardName, capturedAt }],
      },
    },
  };
}

export function assertApplyInvocation(argv: readonly string[]): void {
  if (argv[2] !== "apply" || argv[3] !== "--confirm-preview-write" || argv[4] !== "snulmwprsahzqvdbyenc" || argv.length > 5) {
    throw new Error("apply_requires_exact_confirmation: apply --confirm-preview-write snulmwprsahzqvdbyenc");
  }
}

export function mergeApplyPayload(current: DraftPayload, patch: ReviewPatch["set"]["payload"], updatedAt?: string): DraftPayload {
  const forbidden = new Set(["sourceVideoSha256", "sourceMappingId", "sourceLocalFileName"]);
  const next = { ...current };
  for (const [key, value] of Object.entries(patch)) if (!forbidden.has(key)) next[key] = value;
  if (updatedAt) next.updatedAt = updatedAt;
  return next;
}

export function validateApplyPreflight(patch: ReviewPatch, current: ExistingDraft): string | null {
  if (isAlreadyApplied(patch, current)) return "already_applied";
  if (current.userId !== patch.expected.userId) return `${patch.draftId}: user_id_mismatch`;
  if (current.status !== patch.expected.status) return `${patch.draftId}: status_mismatch`;
  if (current.scheduledAt !== patch.expected.scheduled_at) return `${patch.draftId}: scheduled_at_mismatch`;
  if (current.publishClaimedAt !== null) return `${patch.draftId}: publish_claimed`;
  if (classifyExistingDraft(current) !== "draft") return `${patch.draftId}: posted_or_failed`;
  const media = current.payload.media?.find((item) => item.id === patch.expected.mediaId);
  if (!media || media.id !== patch.expected.mediaId || media.url !== patch.expected.mediaUrl) return `${patch.draftId}: media_cas_mismatch`;
  return null;
}

export function isAlreadyApplied(patch: ReviewPatch, current: ExistingDraft): boolean {
  const target = patch.set.payload;
  return current.status === "ready" && sameInstant(current.scheduledAt, patch.set.scheduled_at) && current.publishClaimedAt === null
    && current.payload.targetConnectionId === target.targetConnectionId && current.payload.targetAccountLabel === target.targetAccountLabel
    && current.payload.boardId === target.boardId && current.payload.boardName === target.boardName
    && current.payload.title === target.title && current.payload.description === target.description
    && current.payload.destinationUrl === target.destinationUrl
    && hasExpectedPinterestDestination(current.payload, String(target.boardId))
    && current.payload.media?.some((media) => media.id === patch.expected.mediaId && media.url === patch.expected.mediaUrl) === true;
}

export function sameInstant(left: string | null | undefined, right: string | null | undefined): boolean {
  if (!left || !right) return false;
  const leftMs = Date.parse(left); const rightMs = Date.parse(right);
  return Number.isFinite(leftMs) && Number.isFinite(rightMs) && leftMs === rightMs;
}

export function hasExpectedPinterestDestination(payload: DraftPayload, boardId: string): boolean {
  const destinations = payload.scheduledDestinations?.filter((destination) => destination.provider === "pinterest") ?? [];
  return destinations.length === 1
    && destinations[0].socialConnectionId === CONNECTION_ID
    && destinations[0].boardId === boardId;
}

export function validateApplyResultCount(count: number, draftId: string): void {
  if (count !== 1) throw new Error(`${draftId}: update_returned_${count}_rows`);
}
