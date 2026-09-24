import { createHash, randomUUID } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { promisify } from "node:util";
import {
  BOARD_IDS, BOARD_NAMES, buildExistingShiftPlan, buildWinningHunterPlan,
  buildWinningHunterPortraitTransformCommand, dedupeWinningHunterQueue,
  MAX_PRIVATE_VIDEO_BYTES,
  type WinningHunterQueueItem,
} from "./lib/winninghunter-queue-ops";

const USER_ID = "4cf569cd-1f20-404d-93d7-1e2c0b8a7251";
const CONNECTION_ID = "a273f91c-4589-4fce-b19c-e24f2bdf6c99";
const PREVIEW_REF = "snulmwprsahzqvdbyenc";
const BUCKET = "generated-private";
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
const storageBase = `${supabaseUrl.replace(/\/$/, "")}/storage/v1/object`;
const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
const execFileAsync = promisify(execFile);
async function rest(path: string, init: RequestInit = {}) { const response = await fetch(`${restBase}${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } }); if (!response.ok) throw new Error(`preview_http_${response.status}:${path}`); return response; }

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
async function uploadPrivate(path: string, sourceChecksum: string) { const normalizedChecksum = hashFile(path); const objectPath = `${USER_ID}/winninghunter/cheerish-portrait-v1-${sourceChecksum}-${normalizedChecksum}.mp4`; const existing = await fetch(`${storageBase}/${BUCKET}/${objectPath}`, { method: "HEAD", headers }); if (!existing.ok) { const response = await fetch(`${storageBase}/${BUCKET}/${objectPath}`, { method: "POST", headers: { ...headers, "content-type": "video/mp4", "x-upsert": "false" }, body: readFileSync(path) }); if (!response.ok && response.status !== 409) throw new Error(`storage_upload_${response.status}`); } const check = await fetch(`${storageBase}/${BUCKET}/${objectPath}`, { method: "HEAD", headers }); const length = Number(check.headers.get("content-length")); if (!check.ok || !Number.isFinite(length) || length !== statSync(path).size) throw new Error(`storage_readback_mismatch:${sourceChecksum}`); return `/api/storage-media?path=${encodeURIComponent(objectPath)}`; }

async function main() {
  const queue = JSON.parse(readFileSync(resolve(queuePath!), "utf8")) as { queue?: WinningHunterQueueItem[] }; const candidates = (queue.queue ?? []).filter((item) => item.queue_class === "ready_after_platform_gates" && item.readiness === "ready_after_platform_gates"); if (candidates.length !== 48) throw new Error(`expected_ready_count:48:${candidates.length}`); const unique = dedupeWinningHunterQueue(candidates); if (unique.duplicates.length) throw new Error("queue_duplicates");
  const rows = await readDrafts(); if (apply) { mkdirSync(dirname(journalPath), { recursive: true }); writeFileSync(`${journalPath}.backup-${Date.now()}.json`, JSON.stringify(rows, null, 2)); await resolveConnection(); }
  const existingKeys = new Set(rows.flatMap((row: any) => [row.payload?.sourceVideoSha256, row.payload?.idempotencyKey, row.payload?.destinationUrl].filter(Boolean))); const skippedExisting = unique.accepted.filter((item) => existingKeys.has(item.sha256.toLowerCase()) || existingKeys.has(`winninghunter:${item.sha256.toLowerCase()}`) || existingKeys.has(item.public_url)); const missing = unique.accepted.filter((item) => !existsSync(item.source_files[0] ?? "")); const fresh = unique.accepted.filter((item) => !skippedExisting.includes(item) && !missing.includes(item)); const plans = buildWinningHunterPlan(fresh, now); const shifts = buildExistingShiftPlan(rows as any, now, plans.length);
  const report: any = { mode: apply ? "stage-apply" : "dry-run", mayPublish: false, previewRef: PREVIEW_REF, userId: USER_ID, connectionId: CONNECTION_ID, generatedAt: new Date().toISOString(), dedupe: { input: candidates.length, unique: unique.accepted.length, existingSkipped: skippedExisting.length, missingSource: missing.length }, plans: [], shifts, backup: apply ? `${journalPath}.backup-*` : null };
  const completed = apply && existsSync(journalPath) ? new Set<string>((JSON.parse(readFileSync(journalPath, "utf8")).completedDraftIds ?? []) as string[]) : new Set<string>();
  const prepared = apply || has("--normalize") ? await mapConcurrent(fresh, 8, normalizeVideo) : fresh.map(() => null);
  for (let index = 0; index < fresh.length; index += 1) { const item = fresh[index]; const plan = plans[index]; const media = prepared[index]; report.plans.push({ ...plan, sourceExists: true, normalized: media ? { width: media.facts.width, height: media.facts.height, pixelFormat: media.facts.pixelFormat, colorRange: media.facts.colorRange, byteSize: statSync(media.path).size } : null }); if (!apply || completed.has(plan.draftId)) continue; const mediaUrl = await uploadPrivate(media!.path, item.sha256.toLowerCase()); const payload = payloadFor(item, plan, mediaUrl, media!.facts); const stamp = new Date().toISOString(); await rest(`/pin_drafts?on_conflict=vibepin_user_id,draft_id`, { method: "POST", headers: { "content-type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ vibepin_user_id: USER_ID, draft_id: plan.draftId, payload, status: "ready", updated_at: stamp, created_at: stamp, deleted_at: null, scheduled_at: plan.scheduledAt }) }); const check = await rest(`/pin_drafts?select=draft_id,payload,scheduled_at&vibepin_user_id=eq.${USER_ID}&draft_id=eq.${encodeURIComponent(plan.draftId)}&limit=1`); const checked = (await check.json() as any[])[0]; if (!checked || Number.isNaN(Date.parse(checked.scheduled_at)) || Date.parse(checked.scheduled_at) !== Date.parse(plan.scheduledAt) || checked.payload?.sourceVideoSha256 !== plan.sha256) throw new Error(`readback_mismatch:${plan.draftId}`); completed.add(plan.draftId); writeFileSync(journalPath, JSON.stringify({ completedDraftIds: [...completed], lastDraftId: plan.draftId, report }, null, 2)); }
  if (apply) for (const shift of shifts) { const row: any = rows.find((candidate: any) => candidate.draft_id === shift.draftId); if (!row) continue; const payload = { ...row.payload, plannedAt: shift.plannedAt, scheduledDate: shift.plannedAt.slice(0, 10), scheduledTime: shift.plannedAt.slice(11, 16), scheduleTimezone: "America/New_York", scheduleSource: "smart", scheduleLocked: false, updatedAt: new Date().toISOString() }; await rest(`/pin_drafts?on_conflict=vibepin_user_id,draft_id`, { method: "POST", headers: { "content-type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ vibepin_user_id: USER_ID, draft_id: shift.draftId, payload, status: row.status, updated_at: payload.updatedAt, scheduled_at: shift.scheduledAt }) }); }
  mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, JSON.stringify(report, null, 2)); console.log(JSON.stringify({ mode: report.mode, fresh: fresh.length, shifts: shifts.length, output, mayPublish: false }, null, 2));
}
main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
