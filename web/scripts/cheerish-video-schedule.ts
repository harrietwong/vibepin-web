import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { validateManifest, validatePreviewBinding, buildDraftId, buildCanaryScheduledAt, buildPortraitTransformCommand, buildPortraitTransformOutputPath, canReplaceManifestMedia, chunkRows, dedupeManifest, isTerminalUploadState, mediaId, needsVideoNormalization, patchSourceCsvRow, PREVIEW_REF, readRequiredFlag, replaceVideoMediaPayload, resolveRequiredBoards, runConcurrentWithSequentialRetry, SAFE_PRIVATE_STORAGE_BYTES, selectExpectedPinterestConnection, selectRowsForCommand, shouldUseRetry1, SOCIAL_CONNECTION_PROJECTION, targetVideoBitrateKbps, uploadAttemptKeys, type CheerishScheduleRow } from "./lib/cheerish-video-schedule";
import { handleVideoUploadPrepare, handleVideoUploadFinalize, VIDEO_UPLOAD_BUCKET } from "../src/lib/server/media/videoUploadHandler";
import { createVideoUploadStore } from "../src/lib/server/media/videoUploadStore";
import { createSupabaseVideoStorage } from "../src/lib/server/media/supabaseVideoStorage";
import { createMediaProvenanceStore } from "../src/lib/server/mediaProvenance";
import { PinterestClient } from "../src/lib/server/pinterest/service";
import { buildScheduledAt } from "../src/app/api/pin-drafts/promote";
import { buildPublishConfirmation } from "../src/lib/studio/publishConfirmation";

const manifestArg = readRequiredFlag(process.argv, "--manifest");
const command = process.argv[2] ?? "dry-run";
const COMMANDS = new Set(["dry-run", "tick", "ensure-boards", "canary", "stage-all"]);
if (!COMMANDS.has(command)) throw new Error(`unknown_command:${command}`);

function env(name: string): string { const value = process.env[name]?.trim(); if (!value) throw new Error(`missing ${name}`); return value; }
const supabaseUrl = env("NEXT_PUBLIC_SUPABASE_URL");
const serviceKey = env("SUPABASE_SERVICE_ROLE_KEY");
const binding = validatePreviewBinding(supabaseUrl, PREVIEW_REF);
if (!binding.ok) throw new Error(binding.error);
process.env.PUBLISH_DUE_LIMIT = "1";
process.env.VIDEO_PIN_UPLOAD_ENABLED = "true";
process.env.CRON_SECRET ||= randomUUID();

const parsed = JSON.parse(readFileSync(manifestArg, "utf8"));
const checked = validateManifest(parsed);
if (!checked.ok) throw new Error(`manifest_invalid:\n${checked.errors.slice(0, 20).join("\n")}`);
for (const row of checked.rows) if (row.localFilePath && !existsSync(row.localFilePath)) throw new Error(`missing file ${row.localFilePath}`);
const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

function hashFile(path: string): string { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
function probe(path: string) {
  const raw = execFileSync("ffprobe", ["-v","error","-show_entries","stream=index,codec_type,codec_name,profile,pix_fmt,width,height,sample_rate,channels","-show_entries","format=duration","-of","json",path], { encoding: "utf8" });
  const data = JSON.parse(raw) as { streams?: Array<{codec_type?:string;codec_name?:string;profile?:string;pix_fmt?:string;width?:number;height?:number;sample_rate?:string;channels?:number}>; format?: {duration?:string} };
  const video = data.streams?.find((stream) => stream.codec_type === "video"); const audio = data.streams?.find((stream) => stream.codec_type === "audio"); const durationMs = Math.round(Number(data.format?.duration) * 1000);
  if (!video?.width || !video.height || !Number.isSafeInteger(durationMs)) throw new Error(`ffprobe_invalid ${path}`);
  return { width: video.width, height: video.height, durationMs, videoCodec: video.codec_name, videoProfile: video.profile, pixelFormat: video.pix_fmt, audioCodec: audio?.codec_name, audioProfile: audio?.profile, audioSampleRate: Number(audio?.sample_rate), audioChannels: audio?.channels };
}
function uploadSource(row: CheerishScheduleRow): string {
  if (!row.localFilePath) throw new Error(`private_source_requires_injected_reader:${row.mappingId}`);
  if (hashFile(row.localFilePath) !== row.sha256.toLowerCase()) throw new Error(`sha_mismatch ${row.mappingId}`);
  let sourcePath = row.localFilePath;
  let sourceFacts = probe(sourcePath);
  if (sourceFacts.width !== 1080 || sourceFacts.height !== 1920) {
    const outDir = "D:/vp-tmp/publish-prep/normalized"; mkdirSync(outDir, { recursive: true });
    const out = buildPortraitTransformOutputPath(outDir, row.sha256);
    if (!existsSync(out) || probe(out).width !== 1080 || probe(out).height !== 1920) {
      execFileSync("ffmpeg", buildPortraitTransformCommand(sourcePath, out), { stdio: "inherit" });
    }
    sourcePath = out;
    sourceFacts = probe(sourcePath);
    if (sourceFacts.width !== 1080 || sourceFacts.height !== 1920) throw new Error(`portrait_transform_invalid ${row.mappingId}`);
  }
  if (!needsVideoNormalization(sourceFacts, statSync(sourcePath).size)) return sourcePath;
  const videoBitrateKbps = targetVideoBitrateKbps(sourceFacts.durationMs);
  const videoMaxrateKbps = videoBitrateKbps;
  const videoBufsizeKbps = videoMaxrateKbps * 2;
  const outDir = "D:/vp-tmp/publish-prep/normalized"; mkdirSync(outDir, { recursive: true });
  const out = join(outDir, `${row.sha256}.mp4`);
  if (existsSync(out) && statSync(out).size <= SAFE_PRIVATE_STORAGE_BYTES && !needsVideoNormalization(probe(out), statSync(out).size)) return out;
  execFileSync("ffmpeg", ["-y","-i",sourcePath,"-c:v","libx264","-profile:v","high","-pix_fmt","yuv420p","-preset","medium","-b:v",`${videoBitrateKbps}k`,"-maxrate",`${videoMaxrateKbps}k`,"-bufsize",`${videoBufsizeKbps}k`,"-c:a","aac","-profile:a","aac_low","-ar","48000","-ac","2","-b:a","128k","-movflags","+faststart",out], { stdio: "inherit" });
  if (statSync(out).size > SAFE_PRIVATE_STORAGE_BYTES) throw new Error(`normalized_video_too_large ${row.mappingId}`);
  if (needsVideoNormalization(probe(out), statSync(out).size)) throw new Error(`normalized_video_invalid ${row.mappingId}`);
  return out;
}

async function resolveConnection() {
  const expectedUsername = process.env.EXPECTED_PINTEREST_USERNAME?.trim() || readRequiredFlag(process.argv, "--expected-pinterest-username");
  const { data, error } = await db.from("social_connections").select(SOCIAL_CONNECTION_PROJECTION).eq("provider","pinterest").is("disconnected_at", null).not("access_token_encrypted","is",null);
  if (error) throw error;
  const active = selectExpectedPinterestConnection(data ?? [], expectedUsername);
  return { uid: String(active.user_id), connectionId: String(active.id), label: String(active.provider_account_username || active.provider_account_name || "Pinterest") };
}

async function ensureBoards(uid: string, connectionId: string) {
  const client = await PinterestClient.forConnection(uid, connectionId); const all: Array<{id:string;name:string}> = []; let bookmark: string | undefined;
  do { const page = await client.listBoards(bookmark); all.push(...page.items); bookmark = page.bookmark ?? undefined; } while (bookmark);
  return resolveRequiredBoards(all);
}

async function existingProxy(uid: string, sha: string): Promise<string | null> {
  const { data, error } = await db.from("video_upload_items")
    .select("private_path")
    .eq("owner_user_id", uid)
    .eq("declared_checksum_sha256", sha.toLowerCase())
    .eq("status", "finalized")
    .order("finalized_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data?.private_path ? `/api/storage-media?path=${encodeURIComponent(String(data.private_path))}` : null;
}

async function databaseClock(): Promise<Date> {
  const response = await fetch(`${supabaseUrl}/rest/v1/video_upload_batches?select=id&limit=1`, { headers: { apikey: serviceKey, authorization: `Bearer ${serviceKey}` } });
  const stamp = response.headers.get("date");
  if (!response.ok || !stamp || !Number.isFinite(Date.parse(stamp))) throw new Error("database_clock_unavailable");
  return new Date(stamp);
}

type UploadAttemptState = { batchId?: string; batchStatus: string; itemStatus: string; privatePath?: string };

async function inspectAttemptState(uid: string, batchKey: string): Promise<UploadAttemptState> {
  const batchResult = await db.from("video_upload_batches").select("id,status").eq("owner_user_id", uid).eq("idempotency_key", batchKey).maybeSingle();
  if (batchResult.error) throw batchResult.error;
  if (!batchResult.data?.id) return { batchStatus: "missing", itemStatus: "missing" };
  const itemResult = await db.from("video_upload_items").select("private_path,status").eq("owner_user_id", uid).eq("batch_id", batchResult.data.id).eq("ordinal", 0).maybeSingle();
  if (itemResult.error) throw itemResult.error;
  return { batchId: String(batchResult.data.id), batchStatus: String(batchResult.data.status ?? "unknown"), itemStatus: String(itemResult.data?.status ?? "missing"), privatePath: itemResult.data?.private_path ? String(itemResult.data.private_path) : undefined };
}

function providerCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split(/\s+/, 1)[0] || "unknown";
}

async function uploadVideoAttempt(uid: string, row: CheerishScheduleRow, source: string, facts: ReturnType<typeof probe>, checksum: string, attempt: 0 | 1): Promise<{ proxyUrl:string;width:number;height:number;durationMs:number }> {
  const size = statSync(source).size; const contentType = "video/mp4"; const store = createVideoUploadStore(db); const serverNow = await databaseClock();
  const keys = uploadAttemptKeys(checksum, attempt);
  const body = { idempotencyKey: keys.batchIdempotencyKey, files: [{ ordinal:0,idempotencyKey:keys.itemIdempotencyKey,filename:basename(source),contentType,byteSize:size,checksumSha256:checksum,...facts }] };
  const prep = await handleVideoUploadPrepare(new Request("http://ops/prepare",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)}), {
    getUserId: async()=>uid, enabled:true, configured:true, bucket:VIDEO_UPLOAD_BUCKET, store, now:()=>serverNow,
    createSignedUpload: async({path,upsert})=>{ const {data,error}=await db.storage.from(VIDEO_UPLOAD_BUCKET).createSignedUploadUrl(path,{upsert}); if(error||!data?.signedUrl||!data.token) throw error??new Error("signed_upload_unavailable"); return {signedUrl:data.signedUrl,token:data.token}; },
  });
  let prepared = await prep.json() as {batchId?:string;uploads?:Array<{signedUrl:string;token:string;path:string}>;code?:string};
  let skipTransfer = false;
  if (!prep.ok || !prepared.batchId || !prepared.uploads?.[0]) {
    const state = await inspectAttemptState(uid, keys.batchIdempotencyKey);
    if (isTerminalUploadState(state.batchStatus) || isTerminalUploadState(state.itemStatus)) throw new Error(prepared.code ?? `prepare_failed_${prep.status}`);
    if (state.itemStatus !== "prepared" || !state.batchId || !state.privatePath) throw new Error(prepared.code ?? `prepare_failed_${prep.status}`);
    const stored = await db.storage.from(VIDEO_UPLOAD_BUCKET).download(state.privatePath);
    if (!stored.error && stored.data?.size === size) {
      skipTransfer = true;
      prepared = { batchId: state.batchId, uploads:[{path:state.privatePath,signedUrl:"",token:""}] };
    } else {
      const signed = await db.storage.from(VIDEO_UPLOAD_BUCKET).createSignedUploadUrl(state.privatePath,{upsert:false});
      if (signed.error || !signed.data?.signedUrl || !signed.data.token) throw new Error(`prepare_recovery_failed ${signed.error?.message ?? "missing capability"}`);
      prepared = { batchId:state.batchId, uploads:[{path:state.privatePath,signedUrl:signed.data.signedUrl,token:signed.data.token}] };
    }
  }
  if (!skipTransfer) {
    const upload = prepared.uploads?.[0]; if (!upload) throw new Error("prepare_failed_missing_upload");
    const file = new File([readFileSync(source)], basename(source), { type: contentType }); const form = new FormData(); form.append("cacheControl","3600"); form.append("",file);
    const sent = await fetch(upload.signedUrl,{method:"PUT",headers:{"x-upsert":"false"},body:form}); if(!sent.ok) throw new Error(`storage_upload_failed_${sent.status}`);
  }
  const fin = await handleVideoUploadFinalize(new Request("http://ops/finalize",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({batchId:prepared.batchId,ordinal:0})}), {
    getUserId:async()=>uid,enabled:true,configured:true,bucket:VIDEO_UPLOAD_BUCKET,store,now:()=>serverNow,createSignedUpload:async()=>{throw new Error("unused");},
    storage:createSupabaseVideoStorage({supabaseUrl,serviceRoleKey:serviceKey}),recordCleanup:i=>createMediaProvenanceStore(db).recordCleanup(i),
  });
  const finalized = await fin.json() as {proxyUrl?:string;code?:string}; if(!fin.ok||!finalized.proxyUrl) throw new Error(`finalize_failed_${finalized.code ?? fin.status}`);
  return { proxyUrl: finalized.proxyUrl, ...facts };
}

async function uploadVideo(uid: string, row: CheerishScheduleRow): Promise<{proxyUrl:string;width:number;height:number;durationMs:number}> {
  const source = uploadSource(row); const facts = probe(source); const checksum = hashFile(source); const existing = await existingProxy(uid, checksum);
  if (existing) return { proxyUrl: existing, ...facts };
  let lastProviderCode = "unknown"; let lastState: UploadAttemptState = { batchStatus: "missing", itemStatus: "missing" };
  for (const attempt of [0, 1] as const) {
    const keys = uploadAttemptKeys(checksum, attempt);
    try { return await uploadVideoAttempt(uid, row, source, facts, checksum, attempt); }
    catch (error) {
      lastProviderCode = providerCode(error);
      lastState = await inspectAttemptState(uid, keys.batchIdempotencyKey);
      if (attempt === 0) {
        if (shouldUseRetry1(lastState)) continue;
        throw error;
      }
      throw new Error(`upload_retry_exhausted:${row.mappingId}:${lastProviderCode}:${lastState.batchStatus}:${lastState.itemStatus}`);
    }
  }
  throw new Error(`upload_retry_exhausted:${row.mappingId}:${lastProviderCode}:${lastState.batchStatus}:${lastState.itemStatus}`);
}

function localFields(scheduledAt: string) { const local = scheduledAt.slice(0,16); return { plannedAt:local,scheduledDate:local.slice(0,10),scheduledTime:local.slice(11,16),scheduleTimezone:"America/New_York" }; }
function patchScheduledSource(row: CheerishScheduleRow, ctx: { label: string }, scheduledAt: string): void {
  const source = readFileSync(row.sourceCsv, "utf8");
  const patched = patchSourceCsvRow(source, row.rowIndex, {
    pinterest_account: ctx.label, pinterest_board: row.board, pinterest_title: row.title,
    pinterest_description: row.description, pinterest_destination_url: row.destinationUrl,
    publish_status: "scheduled", pinterest_scheduled_at: scheduledAt,
  });
  const temporary = `${row.sourceCsv}.${randomUUID()}.tmp`;
  writeFileSync(temporary, patched, "utf8");
  renameSync(temporary, row.sourceCsv);
}
async function scheduleRow(db: SupabaseClient, ctx:{uid:string;connectionId:string;label:string}, boards:Record<string,string>, row:CheerishScheduleRow, upload:{proxyUrl:string;width:number;height:number;durationMs:number}, override?:string) {
  const now = new Date().toISOString(); const scheduledAt = override ?? row.scheduledAt; const draftId = buildDraftId(row); const mId = mediaId(row); const boardId = boards[row.board];
  const sourceLocalFileName = row.localFilePath ? basename(row.localFilePath) : undefined;
  const payload:any = { id:draftId,contentId:draftId,imageUrl:"",media:[{id:mId,kind:"video",url:upload.proxyUrl,source:"upload",width:upload.width,height:upload.height,durationMs:upload.durationMs,altText:row.title}],coverMediaId:mId,keyword:row.productHandle.replaceAll("-"," "),category:row.board,title:row.title,description:row.description,altText:row.title,destinationUrl:row.destinationUrl,boardId,boardName:row.board,weeklyPlanItemId:"",generationSessionId:"cheerish-2026-09",status:"ready",planningStatus:"ready",createdAt:now,updatedAt:now,source:"uploaded_image",idempotencyKey:row.mappingId,addedToPlanAt:now,targetConnectionId:ctx.connectionId,targetAccountLabel:ctx.label,scheduledDestinations:[{provider:"pinterest",socialConnectionId:ctx.connectionId,accountLabel:ctx.label,boardId,boardName:row.board,capturedAt:now}],sourceVideoSha256:row.sha256,sourceLocalFileName,sourcePrivateStorageLocator:row.privateStorageLocator,sourceMappingId:row.mappingId,...localFields(scheduledAt) };
  const computed = buildScheduledAt(payload); if(!computed) throw new Error(`schedule_invalid ${row.mappingId}`);
  const confirmation = buildPublishConfirmation(payload,{onlyPending:false,mode:{kind:"now"},actionId:"ops-check"}); if(confirmation.blockers.length) throw new Error(`publish_blocked ${row.mappingId}: ${confirmation.blockers.map(b=>b.code).join(",")}`);
  const {data:old,error:readError}=await db.from("pin_drafts").select("payload,status,publish_claimed_at,archived_at,deleted_at").eq("vibepin_user_id",ctx.uid).eq("draft_id",draftId).maybeSingle(); if(readError) throw readError;
  if (old && !canReplaceManifestMedia({ status: old.status ?? old.payload?.status, publish_claimed_at: old.publish_claimed_at ?? old.payload?.publish_claimed_at ?? old.payload?.publishClaimedAt })) throw new Error(`portrait_transform_refused_terminal:${row.mappingId}`);
  const persistedPayload = old?.payload ? replaceVideoMediaPayload(old.payload, { url: upload.proxyUrl, width: upload.width, height: upload.height, durationMs: upload.durationMs }) : payload;
  const {error}=await db.from("pin_drafts").upsert({vibepin_user_id:ctx.uid,draft_id:draftId,payload:persistedPayload,status:"ready",updated_at:now,created_at:old?undefined:now,archived_at:old?.archived_at ?? null,deleted_at:old?.deleted_at ?? null,scheduled_at:computed},{onConflict:"vibepin_user_id,draft_id"}); if(error) throw error;
  return {draftId,status:"scheduled",scheduledAt:computed};
}

async function tick() { const { GET } = await import("../src/app/api/cron/publish-due/route"); const res = await GET(new Request("http://local/api/cron/publish-due",{headers:{authorization:`Bearer ${process.env.CRON_SECRET}`}})); const body = await res.json(); console.log(JSON.stringify({status:res.status,body},null,2)); if(!res.ok) process.exitCode=1; }

async function main() {
  if(command==="dry-run") { console.log(JSON.stringify({ok:true,rows:checked.rows.length,ref:binding.projectRef},null,2)); return; }
  if(command==="tick") { await tick(); return; }
  const ctx=await resolveConnection(); const boards=await ensureBoards(ctx.uid,ctx.connectionId);
  if(command==="ensure-boards") { console.log(JSON.stringify({ctx:{...ctx,uid:ctx.uid.slice(0,8)+"…"},boards},null,2)); return; }
  const selected = selectRowsForCommand(checked.rows, command);
  if (command === "canary" && selected.length !== 1) throw new Error(`canary_mapping_count:${selected.length}`);
  const unique = dedupeManifest(selected);
  if (unique.duplicates.length) throw new Error(`duplicate_schedule_rows:${unique.duplicates.map((row) => row.mappingId).join(",")}`);
  const results=[] as any[];
  if (command === "stage-all") {
    for (const group of chunkRows(unique.accepted, 4)) {
      const uploads = await runConcurrentWithSequentialRetry(group, (row) => uploadVideo(ctx.uid, row));
      for (let index = 0; index < group.length; index += 1) {
        const row = group[index]; const scheduled = await scheduleRow(db, ctx, boards, row, uploads[index]);
        if (scheduled.status === "scheduled" && scheduled.scheduledAt) patchScheduledSource(row, ctx, scheduled.scheduledAt);
        results.push({ mappingId: row.mappingId, ...scheduled }); console.log(JSON.stringify(results.at(-1)));
      }
    }
  } else {
    for (const row of unique.accepted) {
      const upload = await uploadVideo(ctx.uid, row); const scheduled = await scheduleRow(db, ctx, boards, row, upload, buildCanaryScheduledAt(new Date()));
      if (scheduled.status === "scheduled" && scheduled.scheduledAt) patchScheduledSource(row, ctx, scheduled.scheduledAt);
      results.push({ mappingId: row.mappingId, ...scheduled }); console.log(JSON.stringify(results.at(-1)));
    }
  }
  console.log(JSON.stringify({ok:true,count:results.length,results},null,2));
}
main().catch(error=>{ console.error(error instanceof Error?error.message:String(error)); process.exitCode=1; });
