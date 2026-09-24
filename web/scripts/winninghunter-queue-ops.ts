import { createHash, randomUUID } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { createClient } from "@supabase/supabase-js";
import {
  BOARD_IDS, BOARD_NAMES, buildExistingShiftPlan, buildWinningHunterPlan,
  buildWinningHunterPortraitTransformCommand, dedupeWinningHunterQueue,
  isWinningHunterUploadStateTerminal, MAX_PRIVATE_VIDEO_BYTES, winningHunterUploadAttemptKeys,
  type WinningHunterQueueItem,
} from "./lib/winninghunter-queue-ops";
import { handleVideoUploadPrepare, handleVideoUploadFinalize, VIDEO_UPLOAD_BUCKET } from "../src/lib/server/media/videoUploadHandler";
import { createVideoUploadStore } from "../src/lib/server/media/videoUploadStore";
import { createSupabaseVideoStorage } from "../src/lib/server/media/supabaseVideoStorage";
import { createMediaProvenanceStore } from "../src/lib/server/mediaProvenance";

const USER_ID = "4cf569cd-1f20-404d-93d7-1e2c0b8a7251";
const CONNECTION_ID = "a273f91c-4589-4fce-b19c-e24f2bdf6c99";
const PREVIEW_REF = "snulmwprsahzqvdbyenc";
const arg = (name: string, fallback?: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : fallback; };
const has = (name: string) => process.argv.includes(name);
function loadEnvFile(path: string) { if (!existsSync(path)) return; for (const line of readFileSync(path, "utf8").split(/\r?\n/)) { const m = line.match(/^([^#=]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2]; } }
loadEnvFile(resolve(arg("--env", "D:/代码/Pinterest flow/web/.env.test.local")!));
const supabaseUrl = process.env.TEST_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const serviceKey = process.env.TEST_SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
if (!supabaseUrl || !serviceKey) throw new Error("missing_preview_env");
if (!new URL(supabaseUrl).hostname.startsWith(`${PREVIEW_REF}.`)) throw new Error("preview_project_mismatch");
const queuePath = arg("--queue"); if (!queuePath) throw new Error("missing_required_flag:--queue");
const now = new Date(arg("--now", new Date().toISOString())!); if (!Number.isFinite(now.getTime())) throw new Error("invalid_now");
const output = resolve(arg("--out", "D:/vp-tmp/publish-prep/winninghunter-48-dry-run.json")!);
const journalPath = resolve(arg("--journal", "D:/vp-tmp/publish-prep/winninghunter-48-journal.json")!);
const command = process.argv[2] ?? "dry-run"; if (!["dry-run", "stage"].includes(command)) throw new Error(`unknown_command:${command}`);
if (command === "stage" && has("--apply") && !has("--confirm-apply")) throw new Error("apply_requires_explicit_--confirm-apply");
const apply = command === "stage" && has("--apply") && has("--confirm-apply");
const restBase = `${supabaseUrl.replace(/\/$/, "")}/rest/v1`;
const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
const execFileAsync = promisify(execFile);
async function rest(path: string, init: RequestInit = {}) { const response = await fetch(`${restBase}${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } }); if (!response.ok) throw new Error(`preview_http_${response.status}:${path}`); return response; }
// Registered video-upload path (prepare -> signed PUT -> finalize) instead of a
// bare storage POST, so every upload gets a video_upload_items row (media
// registration) rather than an object with no ledger entry.
const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
async function databaseClock(): Promise<Date> {
  const response = await fetch(`${restBase}/pin_drafts?select=vibepin_user_id&limit=1`, { headers });
  const stamp = response.headers.get("date");
  if (!response.ok || !stamp || !Number.isFinite(Date.parse(stamp))) throw new Error("database_clock_unavailable");
  return new Date(stamp);
}
async function existingUploadProxy(sha256: string): Promise<string | null> {
  const { data, error } = await db.from("video_upload_items").select("private_path").eq("owner_user_id", USER_ID).eq("declared_checksum_sha256", sha256.toLowerCase()).eq("status", "finalized").order("finalized_at", { ascending: false }).limit(1).maybeSingle();
  if (error) throw error;
  return data?.private_path ? `/api/storage-media?path=${encodeURIComponent(String(data.private_path))}` : null;
}
type UploadAttemptState = { batchId?: string; batchStatus: string; itemStatus: string; privatePath?: string };
async function inspectUploadAttemptState(batchKey: string): Promise<UploadAttemptState> {
  const batchResult = await db.from("video_upload_batches").select("id,status").eq("owner_user_id", USER_ID).eq("idempotency_key", batchKey).maybeSingle();
  if (batchResult.error) throw batchResult.error;
  if (!batchResult.data?.id) return { batchStatus: "missing", itemStatus: "missing" };
  const itemResult = await db.from("video_upload_items").select("private_path,status").eq("owner_user_id", USER_ID).eq("batch_id", batchResult.data.id).eq("ordinal", 0).maybeSingle();
  if (itemResult.error) throw itemResult.error;
  return { batchId: String(batchResult.data.id), batchStatus: String(batchResult.data.status ?? "unknown"), itemStatus: String(itemResult.data?.status ?? "missing"), privatePath: itemResult.data?.private_path ? String(itemResult.data.private_path) : undefined };
}

function hashFile(path: string) { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
function probe(path: string) {
  const data = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name,profile,pix_fmt,width,height,color_range,sample_rate,channels", "-show_entries", "format=duration", "-of", "json", path], { encoding: "utf8" })) as any;
  const v = data.streams?.find((s: any) => s.codec_type === "video"); const a = data.streams?.find((s: any) => s.codec_type === "audio"); if (!v?.width || !v.height) throw new Error(`ffprobe_invalid:${path}`);
  return { width: v.width, height: v.height, pixelFormat: v.pix_fmt, colorRange: v.color_range, videoCodec: v.codec_name, audioCodec: a?.codec_name, durationMs: Math.round(Number(data.format?.duration) * 1000) };
}
async function normalizeVideo(item: WinningHunterQueueItem) {
  const source = item.source_files[0]; if (!source || !existsSync(source)) throw new Error(`missing_source:${item.queue_rank}`); const checksum = hashFile(source); if (checksum !== item.sha256.toLowerCase()) throw new Error(`sha_mismatch:${item.queue_rank}`); const facts = probe(source);
  const limitedRange = !facts.colorRange || facts.colorRange === "tv";
  const compliant = facts.width === 1080 && facts.height === 1920 && facts.pixelFormat === "yuv420p" && limitedRange && facts.videoCodec === "h264" && facts.audioCodec === "aac"; if (compliant) return { path: source, facts: { ...facts, colorRange: facts.colorRange ?? "implicit-tv" }, checksum };
  const outDir = "D:/vp-tmp/publish-prep/winninghunter-normalized"; mkdirSync(outDir, { recursive: true }); const out = `${outDir}/${checksum}-portrait-v3.mp4`;
  if (!existsSync(out)) {
    const temporary = `${out}.${randomUUID()}.tmp.mp4`;
    await execFileAsync("ffmpeg", ["-loglevel", "error", ...buildWinningHunterPortraitTransformCommand(source, temporary, facts.durationMs)], { windowsHide: true, maxBuffer: 1024 * 1024 });
    const staged = probe(temporary); const stagedLimited = !staged.colorRange || staged.colorRange === "tv";
    if (statSync(temporary).size > MAX_PRIVATE_VIDEO_BYTES || staged.width !== 1080 || staged.height !== 1920 || staged.pixelFormat !== "yuv420p" || !stagedLimited || staged.videoCodec !== "h264" || (staged.audioCodec && staged.audioCodec !== "aac")) throw new Error(`normalization_invalid:${item.queue_rank}`);
    renameSync(temporary, out);
  }
  const normalized = probe(out); const normalizedLimited = !normalized.colorRange || normalized.colorRange === "tv"; if (statSync(out).size > MAX_PRIVATE_VIDEO_BYTES || normalized.width !== 1080 || normalized.height !== 1920 || normalized.pixelFormat !== "yuv420p" || !normalizedLimited || normalized.videoCodec !== "h264" || (normalized.audioCodec && normalized.audioCodec !== "aac")) throw new Error(`normalization_invalid:${item.queue_rank}`); return { path: out, facts: { ...normalized, colorRange: normalized.colorRange ?? "implicit-tv" }, checksum: hashFile(out) };
}

async function mapConcurrent<T, R>(items: readonly T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length); let cursor = 0;
  async function run() { while (true) { const index = cursor++; if (index >= items.length) return; results[index] = await worker(items[index]); } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}
async function readDrafts() { const response = await rest(`/pin_drafts?select=vibepin_user_id,draft_id,payload,status,updated_at,created_at,archived_at,deleted_at,scheduled_at,publish_claimed_at&vibepin_user_id=eq.${USER_ID}&limit=1000`); const rows = await response.json() as any[]; if (!Array.isArray(rows)) throw new Error("preview_drafts_shape"); return rows; }
async function resolveConnection() { const response = await rest(`/social_connections?select=id,user_id,provider,provider_account_username,connection_status,needs_reconnect,disconnected_at&id=eq.${CONNECTION_ID}&limit=1`); const rows = await response.json() as any[]; const data = rows[0]; if (!data || data.user_id !== USER_ID || data.provider !== "pinterest" || data.provider_account_username?.toLowerCase() !== "cheerishh" || data.connection_status !== "connected" || data.needs_reconnect || data.disconnected_at) throw new Error("pinterest_connection_mismatch"); }
function boardName(id: string) { return BOARD_NAMES[id] ?? "Home & Kitchen Finds"; }
function payloadFor(item: WinningHunterQueueItem, plan: any, mediaUrl: string, facts: any) { const stamp = new Date().toISOString(); const name = boardName(plan.boardId); const title = item.copy.pinterest.title; return { id: plan.draftId, contentId: plan.draftId, media: [{ id: `video_${plan.sha256.slice(0, 24)}`, kind: "video", url: mediaUrl, source: "upload", width: facts.width, height: facts.height, durationMs: facts.durationMs, altText: title }], imageUrl: "", coverMediaId: `video_${plan.sha256.slice(0, 24)}`, title, description: item.copy.pinterest.description, altText: title, keyword: item.handle.replaceAll("-", " "), category: name, destinationUrl: item.public_url, boardId: plan.boardId, boardName: name, status: "ready", planningStatus: "ready", plannedAt: plan.plannedAt, scheduledDate: plan.plannedAt.slice(0, 10), scheduledTime: plan.plannedAt.slice(11, 16), scheduleTimezone: "America/New_York", scheduleSource: "smart", scheduleLocked: false, autoScheduled: true, createdAt: stamp, updatedAt: stamp, addedToPlanAt: stamp, idempotencyKey: plan.idempotencyKey, sourceVideoSha256: plan.sha256, sourceMappingId: plan.idempotencyKey, sourceLocalFileName: basename(item.source_files[0] ?? ""), targetAccountLabel: "cheerishh", targetConnectionId: CONNECTION_ID, scheduledDestinations: [{ provider: "pinterest", socialConnectionId: CONNECTION_ID, accountLabel: "cheerishh", boardId: plan.boardId, boardName: name, capturedAt: stamp }] }; }
function providerErrorCode(error: unknown): string { const message = error instanceof Error ? error.message : String(error); return message.split(/\s+/, 1)[0] || "unknown"; }

/** One prepare -> signed PUT -> finalize round trip, matching
 * cheerish-video-schedule.ts's uploadVideoAttempt (registered upload path). */
async function uploadPrivateAttempt(path: string, facts: any, checksum: string, attempt: 0 | 1): Promise<string> {
  const size = statSync(path).size; const contentType = "video/mp4"; const store = createVideoUploadStore(db); const serverNow = await databaseClock();
  const keys = winningHunterUploadAttemptKeys(checksum, attempt);
  const body = { idempotencyKey: keys.batchIdempotencyKey, files: [{ ordinal: 0, idempotencyKey: keys.itemIdempotencyKey, filename: basename(path), contentType, byteSize: size, checksumSha256: checksum, width: facts.width, height: facts.height, durationMs: facts.durationMs }] };
  const prep = await handleVideoUploadPrepare(new Request("http://ops/prepare", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), {
    getUserId: async () => USER_ID, enabled: true, configured: true, bucket: VIDEO_UPLOAD_BUCKET, store, now: () => serverNow,
    createSignedUpload: async ({ path: objectPath, upsert }) => { const { data, error } = await db.storage.from(VIDEO_UPLOAD_BUCKET).createSignedUploadUrl(objectPath, { upsert }); if (error || !data?.signedUrl || !data.token) throw error ?? new Error("signed_upload_unavailable"); return { signedUrl: data.signedUrl, token: data.token }; },
  });
  let prepared = await prep.json() as { batchId?: string; uploads?: Array<{ signedUrl: string; token: string; path: string }>; code?: string };
  let skipTransfer = false;
  if (!prep.ok || !prepared.batchId || !prepared.uploads?.[0]) {
    const state = await inspectUploadAttemptState(keys.batchIdempotencyKey);
    if (isWinningHunterUploadStateTerminal(state.batchStatus) || isWinningHunterUploadStateTerminal(state.itemStatus)) throw new Error(prepared.code ?? `prepare_failed_${prep.status}`);
    if (state.itemStatus !== "prepared" || !state.batchId || !state.privatePath) throw new Error(prepared.code ?? `prepare_failed_${prep.status}`);
    const stored = await db.storage.from(VIDEO_UPLOAD_BUCKET).download(state.privatePath);
    if (!stored.error && stored.data?.size === size) { skipTransfer = true; prepared = { batchId: state.batchId, uploads: [{ path: state.privatePath, signedUrl: "", token: "" }] }; }
    else { const signed = await db.storage.from(VIDEO_UPLOAD_BUCKET).createSignedUploadUrl(state.privatePath, { upsert: false }); if (signed.error || !signed.data?.signedUrl || !signed.data.token) throw new Error(`prepare_recovery_failed:${signed.error?.message ?? "missing capability"}`); prepared = { batchId: state.batchId, uploads: [{ path: state.privatePath, signedUrl: signed.data.signedUrl, token: signed.data.token }] }; }
  }
  if (!skipTransfer) {
    const upload = prepared.uploads?.[0]; if (!upload) throw new Error("prepare_failed_missing_upload");
    const file = new File([readFileSync(path)], basename(path), { type: contentType }); const form = new FormData(); form.append("cacheControl", "3600"); form.append("", file);
    const sent = await fetch(upload.signedUrl, { method: "PUT", headers: { "x-upsert": "false" }, body: form }); if (!sent.ok) throw new Error(`storage_upload_failed_${sent.status}`);
  }
  const fin = await handleVideoUploadFinalize(new Request("http://ops/finalize", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ batchId: prepared.batchId, ordinal: 0 }) }), {
    getUserId: async () => USER_ID, enabled: true, configured: true, bucket: VIDEO_UPLOAD_BUCKET, store, now: () => serverNow, createSignedUpload: async () => { throw new Error("unused"); },
    storage: createSupabaseVideoStorage({ supabaseUrl, serviceRoleKey: serviceKey }), recordCleanup: (i) => createMediaProvenanceStore(db).recordCleanup(i),
  });
  const finalized = await fin.json() as { proxyUrl?: string; code?: string }; if (!fin.ok || !finalized.proxyUrl) throw new Error(`finalize_failed_${finalized.code ?? fin.status}`);
  return finalized.proxyUrl;
}

/** Upload with the same 0/1 retry-on-terminal-state semantics as
 * cheerish-video-schedule.ts's uploadVideo, plus a dedupe lookup against
 * already-finalized video_upload_items rows for this checksum. */
async function uploadPrivate(path: string, facts: any, checksum: string): Promise<string> {
  const existing = await existingUploadProxy(checksum); if (existing) return existing;
  let lastProviderCode = "unknown"; let lastState: UploadAttemptState = { batchStatus: "missing", itemStatus: "missing" };
  for (const attempt of [0, 1] as const) {
    const keys = winningHunterUploadAttemptKeys(checksum, attempt);
    try { return await uploadPrivateAttempt(path, facts, checksum, attempt); }
    catch (error) {
      lastProviderCode = providerErrorCode(error);
      lastState = await inspectUploadAttemptState(keys.batchIdempotencyKey);
      if (attempt === 0) { if (isWinningHunterUploadStateTerminal(lastState.batchStatus) || isWinningHunterUploadStateTerminal(lastState.itemStatus)) continue; throw error; }
      throw new Error(`upload_retry_exhausted:${checksum}:${lastProviderCode}:${lastState.batchStatus}:${lastState.itemStatus}`);
    }
  }
  throw new Error(`upload_retry_exhausted:${checksum}:${lastProviderCode}:${lastState.batchStatus}:${lastState.itemStatus}`);
}

async function main() {
  const queue = JSON.parse(readFileSync(resolve(queuePath!), "utf8")) as { queue?: WinningHunterQueueItem[] }; const candidates = (queue.queue ?? []).filter((item) => item.queue_class === "ready_after_platform_gates" && item.readiness === "ready_after_platform_gates"); if (candidates.length !== 48) throw new Error(`expected_ready_count:48:${candidates.length}`); const unique = dedupeWinningHunterQueue(candidates); if (unique.duplicates.length) throw new Error("queue_duplicates");
  const rows = await readDrafts(); if (apply) { mkdirSync(dirname(journalPath), { recursive: true }); writeFileSync(`${journalPath}.backup-${Date.now()}.json`, JSON.stringify(rows, null, 2)); await resolveConnection(); }
  const existingKeys = new Set(rows.flatMap((row: any) => [row.payload?.sourceVideoSha256, row.payload?.idempotencyKey, row.payload?.destinationUrl].filter(Boolean))); const skippedExisting = unique.accepted.filter((item) => existingKeys.has(item.sha256.toLowerCase()) || existingKeys.has(`winninghunter:${item.sha256.toLowerCase()}`) || existingKeys.has(item.public_url)); const missing = unique.accepted.filter((item) => !existsSync(item.source_files[0] ?? "")); const fresh = unique.accepted.filter((item) => !skippedExisting.includes(item) && !missing.includes(item)); const plans = buildWinningHunterPlan(fresh, now); const shifts = buildExistingShiftPlan(rows as any, now, plans.length);
  const report: any = { mode: apply ? "stage-apply" : "dry-run", mayPublish: false, previewRef: PREVIEW_REF, userId: USER_ID, connectionId: CONNECTION_ID, generatedAt: new Date().toISOString(), dedupe: { input: candidates.length, unique: unique.accepted.length, existingSkipped: skippedExisting.length, missingSource: missing.length }, plans: [], shifts, backup: apply ? `${journalPath}.backup-*` : null };
  const completed = apply && existsSync(journalPath) ? new Set<string>((JSON.parse(readFileSync(journalPath, "utf8")).completedDraftIds ?? []) as string[]) : new Set<string>();
  const prepared = apply || has("--normalize") ? await mapConcurrent(fresh, 8, normalizeVideo) : fresh.map(() => null);
  for (let index = 0; index < fresh.length; index += 1) { const item = fresh[index]; const plan = plans[index]; const media = prepared[index]; report.plans.push({ ...plan, sourceExists: true, normalized: media ? { width: media.facts.width, height: media.facts.height, pixelFormat: media.facts.pixelFormat, colorRange: media.facts.colorRange, byteSize: statSync(media.path).size } : null }); if (!apply || completed.has(plan.draftId)) continue; const mediaUrl = await uploadPrivate(media!.path, media!.facts, media!.checksum); const payload = payloadFor(item, plan, mediaUrl, media!.facts); const stamp = new Date().toISOString(); await rest(`/pin_drafts?on_conflict=vibepin_user_id,draft_id`, { method: "POST", headers: { "content-type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ vibepin_user_id: USER_ID, draft_id: plan.draftId, payload, status: "ready", updated_at: stamp, created_at: stamp, deleted_at: null, scheduled_at: plan.scheduledAt }) }); const check = await rest(`/pin_drafts?select=draft_id,payload,scheduled_at&vibepin_user_id=eq.${USER_ID}&draft_id=eq.${encodeURIComponent(plan.draftId)}&limit=1`); const checked = (await check.json() as any[])[0]; if (!checked || Number.isNaN(Date.parse(checked.scheduled_at)) || Date.parse(checked.scheduled_at) !== Date.parse(plan.scheduledAt) || checked.payload?.sourceVideoSha256 !== plan.sha256) throw new Error(`readback_mismatch:${plan.draftId}`); completed.add(plan.draftId); writeFileSync(journalPath, JSON.stringify({ completedDraftIds: [...completed], lastDraftId: plan.draftId, report }, null, 2)); }
  if (apply) for (const shift of shifts) { const row: any = rows.find((candidate: any) => candidate.draft_id === shift.draftId); if (!row) continue; const payload = { ...row.payload, plannedAt: shift.plannedAt, scheduledDate: shift.plannedAt.slice(0, 10), scheduledTime: shift.plannedAt.slice(11, 16), scheduleTimezone: "America/New_York", scheduleSource: "smart", scheduleLocked: false, updatedAt: new Date().toISOString() }; await rest(`/pin_drafts?on_conflict=vibepin_user_id,draft_id`, { method: "POST", headers: { "content-type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ vibepin_user_id: USER_ID, draft_id: shift.draftId, payload, status: row.status, updated_at: payload.updatedAt, scheduled_at: shift.scheduledAt }) }); }
  mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, JSON.stringify(report, null, 2)); console.log(JSON.stringify({ mode: report.mode, fresh: fresh.length, shifts: shifts.length, output, mayPublish: false }, null, 2));
}
main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
