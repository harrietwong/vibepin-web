import { createHash } from "node:crypto";
import { join } from "node:path";

export const PREVIEW_REF = "snulmwprsahzqvdbyenc";
export const ALLOWED_BOARDS = ["Gift Ideas for Her & Personalized Jewelry", "Home & Kitchen Finds", "Cleaning & Self-Care Finds", "Smart Gadgets & Everyday Essentials"] as const;
export const SOCIAL_CONNECTION_PROJECTION = "id,user_id,provider,provider_account_username,provider_account_name,connection_status,needs_reconnect,disconnected_at,access_token_encrypted";
const AUTH_0918: Record<string, string> = {
  "enchanted-led-rose-glass-dome": "https://cheerish.co/products/enchanted-led-rose-glass-dome",
  "personalized-preserved-rose-bear-necklace": "https://cheerish.co/products/personalized-preserved-rose-bear-necklace",
  "personalized-preserved-rose-box-necklace": "https://cheerish.co/products/personalized-preserved-rose-box-necklace",
};

export type CheerishScheduleRow = {
  sourceCsv: string; rowIndex: number; mappingId: string; draftId: string; localFilePath?: string; privateStorageLocator?: string; sha256: string;
  productHandle: string; destinationUrl: string; board: string; title: string; description: string; scheduledAt: string;
};
export type PinterestConnectionCandidate = {
  provider: string; connection_status?: string | null; needs_reconnect?: boolean | null;
  disconnected_at?: string | null; provider_account_username?: string | null;
  provider_account_name?: string | null;
};
export type VideoNormalizationFacts = {
  videoCodec?: string; videoProfile?: string; pixelFormat?: string;
  audioCodec?: string; audioProfile?: string; audioSampleRate?: number; audioChannels?: number;
};

export const PORTRAIT_TRANSFORM_VERSION = "cheerish-portrait-v1";
export const PORTRAIT_WIDTH = 1080;
export const PORTRAIT_HEIGHT = 1920;

export type CheerishManifestMedia = {
  draftId: string;
  schedule: string;
  board: string;
  destination: string;
  connection: string;
  title: string;
  description: string;
  url: string;
  mediaUrl: string;
  width: number;
  height: number;
  durationMs: number;
  originalDigest: string;
  status: string;
  [key: string]: unknown;
};

export function buildPortraitTransformIdempotencyKey(originalDigest: string, version = PORTRAIT_TRANSFORM_VERSION): string {
  return `portrait:${version}:${createHash("sha256").update(`${version}:${originalDigest.toLowerCase()}`).digest("hex")}`;
}

export function buildPortraitTransformOutputPath(root: string, originalDigest: string, version = PORTRAIT_TRANSFORM_VERSION): string {
  const digest = createHash("sha256").update(`${version}:${originalDigest.toLowerCase()}`).digest("hex");
  return join(root, `portrait-${digest}.mp4`);
}

export function parsePrivateStorageLocator(locator: string, expectedOwner: string): { bucketId: "generated-private"; objectPath: string } {
  const value = locator.trim();
  if (!value || /^https?:\/\//i.test(value)) throw new Error("private_locator_invalid");
  const match = value.match(/^private:\/\/([^/]+)\/(.+)$/i);
  if (!match || match[1] !== "generated-private") throw new Error("private_locator_bucket_invalid");
  const objectPath = decodeURIComponent(match[2]);
  if (!expectedOwner || !objectPath.startsWith(`${expectedOwner}/`) || objectPath.includes("..") || objectPath.includes("\\")) throw new Error("private_locator_owner_invalid");
  return { bucketId: "generated-private", objectPath };
}

export async function readPortraitSource(
  source: { localFilePath?: string; privateStorageLocator?: string; sha256: string },
  ownerId: string,
  readers: { readLocal(path: string): Promise<Uint8Array>; readPrivate(locator: { bucketId: "generated-private"; objectPath: string }): Promise<Uint8Array> },
): Promise<Uint8Array> {
  if (!/^[0-9a-f]{64}$/i.test(source.sha256)) throw new Error("portrait_source_digest_missing");
  if (source.localFilePath) return readers.readLocal(source.localFilePath);
  if (source.privateStorageLocator) return readers.readPrivate(parsePrivateStorageLocator(source.privateStorageLocator, ownerId));
  throw new Error("portrait_source_locator_missing");
}

export function canReplaceManifestMedia(input: {
  status?: string | null;
  publish_claimed_at?: string | null;
  publishClaimedAt?: string | null;
  archived_at?: string | null;
  deleted_at?: string | null;
  archivedAt?: string | null;
  deletedAt?: string | null;
  remotePinId?: string | null;
  postedAt?: string | null;
  destinationResults?: Array<{ status?: string | null }>;
}): boolean {
  const status = String(input.status ?? "").toLowerCase();
  const alreadyPublished = !!input.remotePinId || !!input.postedAt
    || input.destinationResults?.some((result) => result.status === "published") === true;
  return !["posted", "published", "claimed", "publishing", "deleted", "archived"].includes(status)
    && !input.publish_claimed_at && !input.publishClaimedAt
    && !input.archived_at && !input.deleted_at && !input.archivedAt && !input.deletedAt
    && !alreadyPublished;
}

export function replaceVideoMediaPayload<T extends Record<string, unknown>>(current: T, replacement: { url: string; width: number; height: number; durationMs: number; provenance?: Record<string, unknown> }): T {
  const media = Array.isArray(current.media) ? current.media as Array<Record<string, unknown>> : [];
  if (!media.length) throw new Error("portrait_media_missing");
  return {
    ...current,
    media: media.map((item, index) => index === 0 ? { ...item, url: replacement.url, width: replacement.width, height: replacement.height, durationMs: replacement.durationMs, ...(replacement.provenance ? { provenance: replacement.provenance } : {}) } : item),
  } as T;
}

/**
 * Foreground is always contained (never cropped); only the blurred background
 * is cover-scaled and cropped to fill the portrait canvas.
 */
export function buildPortraitTransformFilter(): string {
  return `[0:v]split=2[bg0][fg0];[bg0]scale=${PORTRAIT_WIDTH}:${PORTRAIT_HEIGHT}:force_original_aspect_ratio=increase,crop=${PORTRAIT_WIDTH}:${PORTRAIT_HEIGHT},boxblur=luma_radius=24:luma_power=2[bg];[fg0]scale=${PORTRAIT_WIDTH}:${PORTRAIT_HEIGHT}:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,scale=in_range=auto:out_range=tv,format=yuv420p[v]`;
}

export function buildPortraitTransformCommand(inputPath: string, outputPath: string): string[] {
  return ["-y", "-i", inputPath, "-filter_complex", buildPortraitTransformFilter(), "-map", "[v]", "-map", "0:a?", "-c:v", "libx264", "-profile:v", "high", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "48000", "-ac", "2", "-b:a", "128k", "-movflags", "+faststart", outputPath];
}

export function buildCompatibilityNormalizeCommand(inputPath: string, outputPath: string, durationMs: number): string[] {
  const videoBitrateKbps = targetVideoBitrateKbps(durationMs);
  return [
    "-y", "-i", inputPath,
    "-vf", "scale=in_range=auto:out_range=tv,format=yuv420p",
    "-c:v", "libx264", "-profile:v", "high", "-pix_fmt", "yuv420p", "-preset", "medium",
    "-b:v", `${videoBitrateKbps}k`, "-maxrate", `${videoBitrateKbps}k`, "-bufsize", `${videoBitrateKbps * 2}k`,
    "-c:a", "aac", "-profile:a", "aac_low", "-ar", "48000", "-ac", "2", "-b:a", "128k",
    "-movflags", "+faststart", outputPath,
  ];
}

export function normalizeManifestMedia<T extends CheerishManifestMedia>(
  input: T,
  replacementMediaUrl?: string,
): T & { provenance: Record<string, unknown> } {
  if (!canReplaceManifestMedia(input)) throw new Error("portrait_transform_refused_terminal");
  const key = buildPortraitTransformIdempotencyKey(input.originalDigest);
  const alreadyTransformed = input.width === PORTRAIT_WIDTH && input.height === PORTRAIT_HEIGHT
    && (input.provenance as Record<string, unknown> | undefined)?.transformIdempotencyKey === key;
  if (input.width === PORTRAIT_WIDTH && input.height === PORTRAIT_HEIGHT) {
    return { ...input, provenance: { ...(input.provenance as Record<string, unknown> | undefined), transformVersion: PORTRAIT_TRANSFORM_VERSION, transformIdempotencyKey: key, ...(alreadyTransformed ? {} : { source: "portrait" }) } };
  }
  return {
    ...input,
    ...(replacementMediaUrl ? { mediaUrl: replacementMediaUrl } : {}),
    width: PORTRAIT_WIDTH,
    height: PORTRAIT_HEIGHT,
    provenance: {
      ...(input.provenance as Record<string, unknown> | undefined),
      source: "portrait-normalization",
      transformVersion: PORTRAIT_TRANSFORM_VERSION,
      transformIdempotencyKey: key,
      originalDigest: input.originalDigest,
    },
  };
}

export const SAFE_PRIVATE_STORAGE_BYTES = 45 * 1024 * 1024;
const AUDIO_BITRATE_KBPS = 128;
const STORAGE_BUDGET_FRACTION = 0.95;
const MIN_VIDEO_BITRATE_KBPS = 700;
const MAX_VIDEO_BITRATE_KBPS = 3200;

export function uploadAttemptKeys(checksum: string, attempt: 0 | 1): { batchIdempotencyKey: string; itemIdempotencyKey: string } {
  const suffix = checksum.toLowerCase().slice(0, 48);
  const retry = attempt === 1 ? "_retry1" : "";
  return {
    batchIdempotencyKey: `ops_batch${retry}_${suffix}`,
    itemIdempotencyKey: `ops_item${retry}_${suffix}`,
  };
}

export function isTerminalUploadState(status: string | null | undefined): boolean {
  return new Set(["failed", "expired", "canceled", "cleaning"]).has(String(status ?? "").toLowerCase());
}

export function shouldUseRetry1(state: { batchStatus?: string | null; itemStatus?: string | null }): boolean {
  return isTerminalUploadState(state.batchStatus) || isTerminalUploadState(state.itemStatus);
}

export function targetVideoBitrateKbps(durationMs: number): number {
  if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error("invalid_video_duration_ms");
  const totalBitrateKbps = (SAFE_PRIVATE_STORAGE_BYTES * STORAGE_BUDGET_FRACTION * 8) / durationMs;
  const videoBitrateKbps = Math.floor(totalBitrateKbps - AUDIO_BITRATE_KBPS);
  return Math.max(MIN_VIDEO_BITRATE_KBPS, Math.min(MAX_VIDEO_BITRATE_KBPS, videoBitrateKbps));
}

export function needsVideoNormalization(facts: VideoNormalizationFacts, byteSize: number): boolean {
  return byteSize > SAFE_PRIVATE_STORAGE_BYTES
    || facts.videoCodec?.toLowerCase() !== "h264"
    || !["high", "main"].includes(facts.videoProfile?.toLowerCase() ?? "")
    || facts.pixelFormat?.toLowerCase() !== "yuv420p"
    || facts.audioCodec?.toLowerCase() !== "aac"
    || facts.audioProfile?.toLowerCase() !== "lc"
    || ![44_100, 48_000].includes(facts.audioSampleRate ?? 0)
    || facts.audioChannels !== 2;
}

export function resolveRequiredBoards(boards: Array<{ id: string; name: string }>): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const required of ALLOWED_BOARDS) {
    const matches = boards.filter((board) => board.name.trim().toLowerCase() === required.toLowerCase());
    if (matches.length !== 1) throw new Error(`required_pinterest_board_count:${matches.length}:${required}`);
    resolved[required] = matches[0].id;
  }
  return resolved;
}

export function authoritativeDestination(handle: string): string | null { return AUTH_0918[handle] ?? null; }
export function buildDraftId(row: Pick<CheerishScheduleRow, "sha256">): string { return `cheerish_${row.sha256.toLowerCase().slice(0, 56)}`; }

export function validatePreviewBinding(url: string, expectedRef = PREVIEW_REF) {
  let ref = "";
  try { ref = new URL(url).hostname.split(".")[0] ?? ""; } catch { return { ok: false as const, error: "invalid_supabase_url" }; }
  return ref === expectedRef && ref !== "jaxteelkecvlozdrdoog"
    ? { ok: true as const, projectRef: ref }
    : { ok: false as const, error: "preview_project_mismatch" };
}

export function readRequiredFlag(args: string[], flag: string): string {
  const index = args.indexOf(flag);
  if (index < 0) throw new Error(`missing_required_flag:${flag}`);
  const value = args[index + 1]?.trim();
  if (!value || value.startsWith("--")) throw new Error(`missing_required_flag_value:${flag}`);
  return value;
}

export function validateManifest(input: unknown): { ok: boolean; rows: CheerishScheduleRow[]; errors: string[] } {
  const rows = Array.isArray(input) ? input as CheerishScheduleRow[] : [];
  const errors: string[] = [];
  if (rows.length === 0) errors.push("manifest must contain at least one row");
  const titles = new Set<string>(); const descriptions = new Set<string>();
  rows.forEach((r, i) => {
    const label = `row ${i + 1}`;
    for (const key of ["sourceCsv","mappingId","draftId","sha256","productHandle","destinationUrl","board","title","description","scheduledAt"] as const) {
      if (typeof r?.[key] !== "string" || !String(r[key]).trim()) errors.push(`${label} missing ${key}`);
    }
    if ((!r?.localFilePath || !String(r.localFilePath).trim()) && (!r?.privateStorageLocator || !String(r.privateStorageLocator).trim())) errors.push(`${label} missing source locator`);
    if (!Number.isInteger(r?.rowIndex) || r.rowIndex < 2) errors.push(`${label} invalid rowIndex`);
    if (!/^[0-9a-f]{64}$/i.test(r?.sha256 ?? "")) errors.push(`${label} invalid sha256`);
    if (!/^https:\/\/cheerish\.co\/products\/[a-z0-9-]+$/.test(r?.destinationUrl ?? "")) errors.push(`${label} invalid destinationUrl`);
    if (!(ALLOWED_BOARDS as readonly string[]).includes(r?.board)) errors.push(`${label} invalid board`);
    if ((r?.title?.length ?? 0) > 100 || (r?.description?.length ?? 0) > 500) errors.push(`${label} copy too long`);
    if (!Number.isFinite(Date.parse(r?.scheduledAt ?? ""))) errors.push(`${label} invalid scheduledAt`);
    if (titles.has(r?.title)) errors.push(`${label} duplicate title`); else titles.add(r?.title);
    if (descriptions.has(r?.description)) errors.push(`${label} duplicate description`); else descriptions.add(r?.description);
    const auth = authoritativeDestination(r?.productHandle ?? "");
    if (r?.sourceCsv?.includes("2026-09-18")) {
      if (!auth || r.destinationUrl !== auth) errors.push(`${label} authoritative URL mismatch`);
      if (r.board !== "Gift Ideas for Her & Personalized Jewelry") errors.push(`${label} 0918 board mismatch`);
    }
  });
  return { ok: errors.length === 0, rows, errors };
}

export function dedupeManifest(rows: CheerishScheduleRow[]) {
  const sha = new Set<string>(); const file = new Set<string>(); const id = new Set<string>();
  const accepted: CheerishScheduleRow[] = []; const duplicates: CheerishScheduleRow[] = [];
  for (const row of rows) {
    const keys = [row.sha256.toLowerCase(), (row.localFilePath ?? row.privateStorageLocator ?? "").toLowerCase(), row.mappingId];
    if (sha.has(keys[0]) || file.has(keys[1]) || id.has(keys[2])) duplicates.push(row);
    else { sha.add(keys[0]); file.add(keys[1]); id.add(keys[2]); accepted.push(row); }
  }
  return { accepted, duplicates };
}

export function chunkRows<T>(rows: T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1) throw new Error("invalid_chunk_size");
  const chunks: T[][] = [];
  for (let index = 0; index < rows.length; index += size) chunks.push(rows.slice(index, index + size));
  return chunks;
}

/**
 * Run a batch concurrently, then retry only rejected items one at a time in
 * their original input order. This keeps throughput for the normal path while
 * avoiding a second concurrent burst against storage when a transient upload
 * or finalize operation fails.
 */
export async function runConcurrentWithSequentialRetry<T, R>(
  rows: readonly T[],
  worker: (row: T) => Promise<R>,
): Promise<R[]> {
  const firstPass = await Promise.allSettled(
    rows.map((row) => Promise.resolve().then(() => worker(row))),
  );
  const results = new Array<R>(rows.length);
  const failedIndexes: number[] = [];
  firstPass.forEach((result, index) => {
    if (result.status === "fulfilled") results[index] = result.value;
    else failedIndexes.push(index);
  });
  for (const index of failedIndexes) results[index] = await worker(rows[index]);
  return results;
}

export function selectRowsForCommand(rows: CheerishScheduleRow[], command: string, canaryMappingId: string): CheerishScheduleRow[] {
  if (!canaryMappingId.trim()) throw new Error("canary_mapping_id_required");
  if (command === "canary") return rows.filter((row) => row.mappingId === canaryMappingId);
  if (command === "stage-all") return rows.filter((row) => row.mappingId !== canaryMappingId);
  throw new Error(`unknown_command:${command}`);
}

export function buildCanaryScheduledAt(now: Date): string {
  const target = new Date(now.getTime() - 60_000);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(target);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const local = `${value("year")}-${value("month")}-${value("day")}T${value("hour")}:${value("minute")}:00`;
  return `${local.slice(0, 16)}:00+08:00`;
}

export function scheduleFieldsInTimeZone(scheduledAt: string, timeZone = "Asia/Shanghai") {
  const instant = new Date(scheduledAt);
  if (!Number.isFinite(instant.getTime())) throw new Error("schedule_invalid");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year:"numeric", month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit", hourCycle:"h23",
  }).formatToParts(instant);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const scheduledDate = `${value("year")}-${value("month")}-${value("day")}`;
  const scheduledTime = `${value("hour")}:${value("minute")}`;
  return { plannedAt:`${scheduledDate}T${scheduledTime}`, scheduledDate, scheduledTime, scheduleTimezone:timeZone };
}

export function normalizePinterestUsername(value: string): string {
  return value.trim().replace(/^@/, "").toLocaleLowerCase("en-US");
}

export function selectExpectedPinterestConnection<T extends PinterestConnectionCandidate>(
  connections: T[], expectedUsername: string,
): T {
  const expected = normalizePinterestUsername(expectedUsername);
  if (!expected) throw new Error("expected_pinterest_username_required");
  const matches = connections.filter((connection) => {
    return connection.provider === "pinterest"
      && connection.connection_status === "connected"
      && !connection.needs_reconnect
      && !connection.disconnected_at
      && [connection.provider_account_username, connection.provider_account_name]
        .some((identity) => normalizePinterestUsername(identity ?? "") === expected);
  });
  if (matches.length !== 1) throw new Error(`expected_pinterest_connection_count:${matches.length}`);
  return matches[0];
}

const CSV_PATCH_COLUMNS = new Set([
  "pinterest_account", "pinterest_board", "pinterest_title", "pinterest_description",
  "pinterest_destination_url", "publish_status", "pinterest_scheduled_at", "pinterest_pin_id",
  "published_at", "publish_error", "notes",
]);

function parseCsvLine(line: string): string[] {
  const fields: string[] = []; let field = ""; let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"' && quoted && line[index + 1] === '"') { field += '"'; index += 1; }
    else if (character === '"') quoted = !quoted;
    else if (character === "," && !quoted) { fields.push(field); field = ""; }
    else field += character;
  }
  if (quoted) throw new Error("csv_patch_invalid_csv");
  fields.push(field); return fields;
}
function csvField(value: string, forceQuote = false): string { return forceQuote || /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value; }

export function patchSourceCsvRow(source: string, rowIndex: number, patch: Record<string, string>): string {
  for (const key of Object.keys(patch)) if (!CSV_PATCH_COLUMNS.has(key)) throw new Error(`csv_patch_column_not_allowed:${key}`);
  if (patch.publish_status && patch.publish_status !== "scheduled") throw new Error("csv_patch_invalid_status");
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.split(newline);
  const header = parseCsvLine(lines[0] ?? "");
  if (rowIndex < 2 || rowIndex > lines.length || !lines[rowIndex - 1]) throw new Error("csv_patch_invalid_row");
  const fields = parseCsvLine(lines[rowIndex - 1]);
  if (fields.length !== header.length) throw new Error("csv_patch_column_count_mismatch");
  for (const [key, value] of Object.entries(patch)) {
    const index = header.indexOf(key); if (index < 0) throw new Error(`csv_patch_missing_column:${key}`);
    fields[index] = value;
  }
  lines[rowIndex - 1] = fields.map((value, index) => csvField(value, header[index] === "publish_error" || header[index] === "notes")).join(",");
  return lines.join(newline);
}

export function mediaId(row: CheerishScheduleRow): string { return `video_${createHash("sha256").update(row.sha256).digest("hex").slice(0, 24)}`; }
