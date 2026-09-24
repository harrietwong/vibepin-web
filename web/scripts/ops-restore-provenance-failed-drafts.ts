/**
 * Repairs Cheerish drafts whose media has no `media_asset_provenance` row.
 *
 * Root cause: these media objects were written to storage by a route that
 * bypassed the upload RPC, so no registration row was ever created for the object
 * path. `v76PinterestVideoRuntime` resolves that row by bucket + object path and
 * rejects on its very first predicate. The rejection is terminal, which clears
 * `scheduled_at`, so a failed draft silently drops out of the queue forever.
 *
 * Registration is always the fix and is always honest: content-type and byte-size
 * are measured by an actual storage HEAD against the object (so the
 * `storage_head_verified` labels are earned, not asserted), dimensions and
 * duration are carried over verbatim from what the uploader declared in the
 * payload, and the checksum stays null under `checksum_source: 'unavailable'`
 * because the bytes were never hashed at upload time.
 *
 * Three cohorts, selected with `--cohort`, differing only in whether the draft
 * also needs a new schedule:
 *
 *   dropped-11 / later-8  (`reschedule: true`)
 *     Already failed and unqueued. Register, THEN restore a schedule — that order
 *     is a hard constraint, since a schedule restored first just fails again at
 *     the next tick. Their original times are in the past and cannot be reused
 *     (they would fire at once), so each takes the next free future top-of-hour
 *     in America/New_York, preserving relative order and the one-per-hour cadence.
 *
 *   bleeding-24  (`reschedule: false`)
 *     NOT yet failed: still holding a valid future schedule, but guaranteed to
 *     fail when it arrives. Registering the media is the entire fix, and the
 *     existing schedule is deliberately left untouched so the draft simply
 *     publishes on time. This run performs no draft write at all for them.
 *
 * Read-only by default. `--apply` performs writes, guarded by a compare-and-swap
 * on `updated_at` so a draft another session has touched since the pre-flight read
 * is skipped rather than clobbered. Re-running is safe: an existing, valid
 * registration row is recognised and the run resumes at whatever step remains.
 *
 * Scope is always an explicit draft-id allowlist. The 400-class failures are
 * deliberately NOT touched by any cohort.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { scheduleFieldsInTimeZone } from "./lib/cheerish-video-schedule";

const PRODUCTION_REF = "jaxteelkecvlozdrdoog";
const EXPECTED_TEST_REF = "snulmwprsahzqvdbyenc";
const BUCKET = "generated-private";
const OWNER_USER_ID = "4cf569cd-1f20-404d-93d7-1e2c0b8a7251";
const SCHEDULE_TIME_ZONE = "America/New_York";
const MIN_PUBLISHABLE_MS = 4_000;
const MAX_PUBLISHABLE_MS = 300_000;

/**
 * Cohort 1 — the originally approved eleven. Provenance failures inside the
 * investigated window (2026-09-22T18:00Z..2026-09-23T16:00Z), already dropped out
 * of the queue. Identified by their preserved original schedule and independently
 * corroborated by `winninghunter-48-journal.json` completedDraftIds.
 * Applied 2026-09-24T02:05Z; retained here so the run stays idempotent.
 */
const COHORT_DROPPED_11 = [
  "cheerish_ba6243a97914b7cd27ee67b91fdd7a0ff00136fa1fac0ad3164e9165",
  "cheerish_a254a4c56ba7691df0badc45e8e3b7ee93fb0246144c43659e7ef2c6",
  "cheerish_a73a6fe64d79efdb68abd2d06dc70fd8fd1e5ce7f6f8183e6c201685",
  "cheerish_b917adf7321593f1f84de033032cf32dff74185b0e75ddd72eb1b969",
  "cheerish_1cbfbafd79e42188bf7ecd08553b87e7fc9fa2787db1bbf655e73300",
  "cheerish_dec9b7de2f0d33d7022b8e1b744d7a9789d30cd70890b0733ed18ec0",
  "cheerish_91574be01a3c77504699aa77f782c528fcc1790a224454fa938df3a2",
  "cheerish_51050d68d9e86cda43c27dd4124145563f416e21afb1d69a86ded676",
  "cheerish_1aeec1c4ddea7059652227b262eedc699b63454a6d35d56ca1082828",
  "cheerish_6daa0d652fba04930f672d6e8052025c5c155496001c65de9289f703",
  "cheerish_9670b0810f9c9d55c98127d562e10ef1bd76d6bf5facbb6f0e87942a",
] as const;

/**
 * Cohort 2 — the twenty-four still holding a future schedule with no registration
 * row. These have NOT failed yet; each one is a scheduled failure waiting for its
 * hour (the earliest is 2026-09-24T13:00Z). Registering the media is sufficient
 * and their existing schedules must be left exactly as they are, so they simply
 * publish on time. Ordered by scheduled_at.
 */
const COHORT_BLEEDING_24 = [
  "cheerish_dc5be2c4d4785db3536f746e93dd4b2c1fa37333738d8c80d8c1dbd7", // 2026-09-24T13:00:00+00:00
  "cheerish_411376a24e856516c5b330cf9b82ca46ba32cf9a5ad9533fdd25207a", // 2026-09-24T14:00:00+00:00
  "cheerish_b770c61004d554173c574bfac4ed3e2c6da78e926461206d22a25c93", // 2026-09-24T15:00:00+00:00
  "cheerish_8d0ded16a3263726b59a7e6bb009e5463c062fda7931aa1fa09742d4", // 2026-09-24T16:00:00+00:00
  "cheerish_20ce05613736ddfff23cf8266cdb9900f77aea39b984c029c57b44dc", // 2026-09-24T17:00:00+00:00
  "cheerish_a70ba485366db137fa2a582cfcfed1c30a3ee34ac2901c66ce4f36e1", // 2026-09-24T18:00:00+00:00
  "cheerish_db4ea6a59be875064aeb67a0416f1b3fad3c8575017ebfb9c22a5fa4", // 2026-09-24T19:00:00+00:00
  "cheerish_5f21648f817fcae5a98bd429137f6debdb7a3c0e79df77294b1994ba", // 2026-09-24T20:00:00+00:00
  "cheerish_608c78b4f8e3cbf0244f83020170f43cc42513e12f772a220874046a", // 2026-09-24T21:00:00+00:00
  "cheerish_6f19667959a6f71d34008b0bebec2b3b312938818d4a4bbe0b56347b", // 2026-09-24T22:00:00+00:00
  "cheerish_b41db4fba2df65184c262574329d1b8876a5a1b6da06ccdd55bef31a", // 2026-09-24T23:00:00+00:00
  "cheerish_1b9d84383aff016056e62cff87c45866361e2b3ff4bd802d1249b819", // 2026-09-25T00:00:00+00:00
  "cheerish_9635b43517673fd588eb96632483e3a0803eb808fc86b4fff452024f", // 2026-09-25T13:00:00+00:00
  "cheerish_e18b090367fe23be8bb7cd45bd1bad23db482f20cd2ffbe16c332117", // 2026-09-25T14:00:00+00:00
  "cheerish_43fdc6e144e503855cb4edf68660eca417e3b012444155fe7bfb6644", // 2026-09-25T15:00:00+00:00
  "cheerish_5f343a60938616b019ecbc45749fa5d9cd10d9ac85d0e9643ffcfbd3", // 2026-09-25T16:00:00+00:00
  "cheerish_a34fb1fd761e28aef1c328bb2d7067fd58af65d1e1db62a8f30ce23f", // 2026-09-25T17:00:00+00:00
  "cheerish_22125b14ce18f2604107d13e900af7f96640a486b94f79866d3a106f", // 2026-09-25T18:00:00+00:00
  "cheerish_3a4b656d719a84e1eeddbb1853d1d1191fec5a6386b954e3f37b7130", // 2026-09-25T19:00:00+00:00
  "cheerish_805b387feba08798a467cd297b54ae45d99959b7f84c54aeb6591cfe", // 2026-09-25T20:00:00+00:00
  "cheerish_4a1b1423b8ee8b648dc44d559efee2c066420050ce06283e3c7fed8e", // 2026-09-25T21:00:00+00:00
  "cheerish_3d3daa62b9326c14478623e27c3ee2b6ce68ed60f0dd806471af9f82", // 2026-09-25T22:00:00+00:00
  "cheerish_7a6b0c1b28f4623c3396aef47ff2f21f98cdfb958db1714ab0704481", // 2026-09-25T23:00:00+00:00
  "cheerish_1ec9daad01dac7e41cf81a593d213b56f5a7d0dadecdefa496a4d7fa", // 2026-09-26T00:00:00+00:00
] as const;

/**
 * Cohort 3 — the eight that failed the same way after the investigated window
 * (original schedules 2026-09-23T13:00Z..20:00Z) and are likewise unqueued.
 * Treated exactly like cohort 1: register, then reschedule. Ordered by their
 * original time so the restored sequence preserves the intended order.
 */
const COHORT_LATER_8 = [
  "cheerish_21f7bc18c6ff50a327fdcb4f7d0936e1fe063216c7080e670066ed93", // prev 2026-09-23T13:00:00.000Z
  "cheerish_8d8f07369c010f26c9957aeb27134309974843c7844cda554dc48bfb", // prev 2026-09-23T14:00:00.000Z
  "cheerish_b5b21c91e8a9898dfff16c9b9b59ce29d155acb1a640cce0b22140a4", // prev 2026-09-23T15:00:00.000Z
  "cheerish_6c6ec8298a7b995e10878341810f9343a41eee5eff5104fa48d370e2", // prev 2026-09-23T16:00:00.000Z
  "cheerish_b238edeee82f290ba38314db9d6ddc162ef70094c85e859d567e0b6b", // prev 2026-09-23T17:00:00.000Z
  "cheerish_4e6149493e596b2a006233c0eb7cb6825c466e05b73b2277d1fe2970", // prev 2026-09-23T18:00:00.000Z
  "cheerish_994e1bc27e5a92142083c04cb9baf7edabe42e2f31763690548eb3b5", // prev 2026-09-23T19:00:00.000Z
  "cheerish_ee41342eaa2c435be8f22899a56b57c2383e75430a3c0522f23a5a7a", // prev 2026-09-23T20:00:00.000Z
] as const;

type CohortName = "dropped-11" | "bleeding-24" | "later-8";
type CohortSpec = {
  /** Register the media AND move the draft to a new future slot. */
  reschedule: boolean;
  /** Required pre-condition on `scheduled_at` before this run will touch a draft. */
  expect: "unqueued" | "scheduled";
  ids: readonly string[];
  label: string;
};
const COHORTS: Record<CohortName, CohortSpec> = {
  "dropped-11": { reschedule: true, expect: "unqueued", ids: COHORT_DROPPED_11, label: "dropped by the investigated-window failures" },
  // Register-only. Rescheduling these would move working future schedules for no
  // reason and risk colliding with the slots cohorts 1 and 3 occupy.
  "bleeding-24": { reschedule: false, expect: "scheduled", ids: COHORT_BLEEDING_24, label: "still queued but unregistered (failure pending)" },
  "later-8": { reschedule: true, expect: "unqueued", ids: COHORT_LATER_8, label: "same-class failures after the investigated window" },
};

const argv = process.argv.slice(2);
const has = (name: string) => argv.includes(name);
const flag = (name: string, fallback: string) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback; };
const APPLY = has("--apply");
if (APPLY && has("--dry-run")) throw new Error("choose_either_--dry-run_or_--apply");
const cohortName = flag("--cohort", "dropped-11") as CohortName;
const cohort = COHORTS[cohortName];
if (!cohort) throw new Error(`unknown_cohort:${cohortName}:expected_one_of:${Object.keys(COHORTS).join("|")}`);
const TARGET_DRAFT_IDS = cohort.ids;
const envPath = resolve(flag("--env", "D:/代码/Pinterest flow/web/.env.test.local"));
const receiptPath = resolve(flag("--receipt", "D:/vp-tmp/coordination/receipts/PROVENANCE_RESTORE_20260923.md"));

function loadEnv(path: string): Record<string, string> {
  if (!existsSync(path)) throw new Error(`missing_env_file:${path}`);
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
  }
  return out;
}
const env = loadEnv(envPath);
const supabaseUrl = (env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/$/, "");
const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY ?? "";
if (!supabaseUrl || !serviceKey) throw new Error("missing_supabase_env");

/**
 * Target assertion. Printed before any connection is opened so the receipt and
 * the console both show which database this run could possibly have touched.
 * Writing test fixtures into production is worse than not running at all.
 */
const projectRef = new URL(supabaseUrl).hostname.split(".")[0];
console.log(`[target] project ref: ${projectRef}`);
console.log(`[target] mode: ${APPLY ? "APPLY (writes)" : "DRY-RUN (read-only)"}`);
if (projectRef === PRODUCTION_REF) throw new Error(`refusing_to_run_against_production:${projectRef}`);
if (projectRef !== EXPECTED_TEST_REF) throw new Error(`unexpected_project_ref:${projectRef}:expected:${EXPECTED_TEST_REF}`);
console.log(`[target] assertion passed: ref !== ${PRODUCTION_REF}\n`);

const restBase = `${supabaseUrl}/rest/v1`;
const storageBase = `${supabaseUrl}/storage/v1/object`;
const authHeaders = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };

/** The test project resets connections under load; retry transport faults only. */
async function withRetry<T>(label: string, run: () => Promise<T>, attempts = 6): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { return await run(); } catch (error) {
      last = error;
      if (attempt < attempts - 1) await new Promise((r) => setTimeout(r, 1_000 * (attempt + 1)));
    }
  }
  throw new Error(`${label}_failed:${last instanceof Error ? last.message : String(last)}`);
}

async function rest(path: string, init: RequestInit = {}): Promise<Response> {
  return withRetry(`rest:${path.slice(0, 60)}`, async () => {
    const response = await fetch(`${restBase}${path}`, { ...init, headers: { ...authHeaders, ...(init.headers ?? {}) } });
    if (!response.ok) throw new Error(`http_${response.status}:${(await response.text()).slice(0, 200)}`);
    return response;
  });
}

type DraftRow = { draft_id: string; vibepin_user_id: string; status: string | null; scheduled_at: string | null; updated_at: string; publish_claimed_at: string | null; archived_at: string | null; deleted_at: string | null; payload: Record<string, any> };

async function readDrafts(ids: readonly string[]): Promise<Map<string, DraftRow>> {
  const list = ids.map((id) => `"${id}"`).join(",");
  const response = await rest(`/pin_drafts?select=draft_id,vibepin_user_id,status,scheduled_at,updated_at,publish_claimed_at,archived_at,deleted_at,payload&vibepin_user_id=eq.${OWNER_USER_ID}&draft_id=in.(${list})`);
  const rows = await response.json() as DraftRow[];
  return new Map(rows.map((row) => [row.draft_id, row]));
}

/** Every future schedule for this owner; the restore must not double-book an hour. */
async function readOccupiedSlots(): Promise<Set<number>> {
  const occupied = new Set<number>();
  for (let offset = 0; ; offset += 200) {
    const response = await rest(`/pin_drafts?select=scheduled_at&vibepin_user_id=eq.${OWNER_USER_ID}&scheduled_at=not.is.null&order=scheduled_at.asc&limit=200&offset=${offset}`);
    const rows = await response.json() as Array<{ scheduled_at: string }>;
    for (const row of rows) { const t = Date.parse(row.scheduled_at); if (Number.isFinite(t)) occupied.add(t); }
    if (rows.length < 200) break;
  }
  return occupied;
}

async function readProvenance(objectPath: string): Promise<Record<string, any> | null> {
  const response = await rest(`/media_asset_provenance?select=*&owner_user_id=eq.${OWNER_USER_ID}&bucket_id=eq.${BUCKET}&object_path=eq.${encodeURIComponent(objectPath)}&limit=1`);
  const rows = await response.json() as Array<Record<string, any>>;
  return rows[0] ?? null;
}

/**
 * Measures the stored object. content_type and byte_size must come from the
 * object itself, because the row labels them `storage_head_verified` and a
 * publish-time byte comparison will catch any discrepancy anyway.
 */
async function headObject(objectPath: string): Promise<{ contentType: string; byteSize: number }> {
  return withRetry(`head:${objectPath.slice(-40)}`, async () => {
    const response = await fetch(`${storageBase}/${BUCKET}/${objectPath}`, { method: "HEAD", headers: authHeaders });
    if (!response.ok) throw new Error(`storage_head_${response.status}`);
    const contentType = (response.headers.get("content-type") ?? "").split(";")[0].trim();
    const byteSize = Number(response.headers.get("content-length"));
    if (!contentType || !Number.isSafeInteger(byteSize) || byteSize <= 0) throw new Error("storage_head_incomplete");
    return { contentType, byteSize };
  });
}

function mediaObjectPath(payload: Record<string, any>): string | null {
  const raw = String(payload?.media?.[0]?.url ?? "");
  if (!raw.startsWith("/api/storage-media?")) return null;
  const path = new URLSearchParams(raw.slice(raw.indexOf("?") + 1)).get("path");
  if (!path || path.includes("..") || path.includes("\\")) return null;
  if (!path.startsWith(`${OWNER_USER_ID}/`)) return null;
  return path;
}

/** The next free top-of-hour at or after `from`, skipping already-booked instants. */
function nextFreeHour(from: Date, occupied: Set<number>): Date {
  const slot = new Date(from);
  slot.setUTCMinutes(0, 0, 0);
  if (slot.getTime() <= from.getTime()) slot.setUTCHours(slot.getUTCHours() + 1);
  while (occupied.has(slot.getTime())) slot.setUTCHours(slot.getUTCHours() + 1);
  return slot;
}

/**
 * Clears the terminal-failure bookkeeping so the draft is a clean queue
 * candidate again, and rewrites the wall-clock schedule fields to match the new
 * instant. The failed Pinterest destination row is dropped rather than edited:
 * leaving it would make the UI show a published/failed state for a pin that is
 * about to be attempted afresh.
 */
function restoredPayload(payload: Record<string, any>, scheduledAtIso: string): Record<string, any> {
  const next: Record<string, any> = { ...payload };
  for (const key of ["publishError", "failureType", "errorCategory", "publishFailureCode", "publishFailedAt", "lastPublishError", "previousScheduledTime"]) delete next[key];
  const results = Array.isArray(payload.destinationResults) ? payload.destinationResults : [];
  const kept = results.filter((r: any) => String(r?.status ?? "").toLowerCase() !== "failed");
  if (kept.length) next.destinationResults = kept; else delete next.destinationResults;
  next.status = "ready";
  next.planningStatus = "ready";
  next.updatedAt = new Date().toISOString();
  const fields = scheduleFieldsInTimeZone(scheduledAtIso, SCHEDULE_TIME_ZONE);
  next.plannedAt = fields.plannedAt;
  next.scheduledDate = fields.scheduledDate;
  next.scheduledTime = fields.scheduledTime;
  next.scheduleTimezone = fields.scheduleTimezone;
  return next;
}

type Plan = {
  draftId: string; decision: "restore" | "skip"; reason: string;
  objectPath?: string; contentType?: string; byteSize?: number;
  width?: number; height?: number; durationMs?: number;
  previousScheduledTime?: string; newScheduledAt?: string; newLocal?: string;
  expectedUpdatedAt?: string; provenanceExists?: boolean;
  /** Register-only: the pre-existing schedule this run must preserve verbatim. */
  keptScheduledAt?: string;
};

async function buildPlans(): Promise<Plan[]> {
  const drafts = await readDrafts(TARGET_DRAFT_IDS);
  const occupied = await readOccupiedSlots();
  const plans: Plan[] = [];
  let cursor = new Date();
  for (const draftId of TARGET_DRAFT_IDS) {
    const draft = drafts.get(draftId);
    if (!draft) { plans.push({ draftId, decision: "skip", reason: "draft_not_found" }); continue; }
    if (draft.deleted_at || draft.archived_at) { plans.push({ draftId, decision: "skip", reason: "draft_deleted_or_archived" }); continue; }
    if (draft.publish_claimed_at) { plans.push({ draftId, decision: "skip", reason: "draft_publish_claimed" }); continue; }
    // Each cohort asserts the schedule state it was defined by, so a draft that
    // has moved since the cohort was built is skipped instead of mishandled.
    // Rescheduling cohorts must still be unqueued (a schedule means someone
    // already restored it); the register-only cohort must still BE queued (losing
    // its schedule means it already failed and belongs to a different cohort).
    if (cohort.expect === "unqueued" && draft.scheduled_at) { plans.push({ draftId, decision: "skip", reason: `already_scheduled:${draft.scheduled_at}` }); continue; }
    if (cohort.expect === "scheduled" && !draft.scheduled_at) { plans.push({ draftId, decision: "skip", reason: "no_longer_scheduled_already_failed" }); continue; }
    const payload = draft.payload ?? {};
    const previous = payload.previousScheduledTime ? String(payload.previousScheduledTime) : "";
    // Only the rescheduling cohorts carry a preserved original time; the
    // register-only cohort has never failed, so it has none and needs none.
    if (cohort.reschedule && !previous) { plans.push({ draftId, decision: "skip", reason: "missing_previousScheduledTime" }); continue; }
    const objectPath = mediaObjectPath(payload);
    if (!objectPath) { plans.push({ draftId, decision: "skip", reason: "unparsable_media_locator" }); continue; }
    const media = payload.media?.[0] ?? {};
    const width = Number(media.width), height = Number(media.height), durationMs = Number(media.durationMs);
    if (![width, height, durationMs].every((v) => Number.isSafeInteger(v) && v > 0)) { plans.push({ draftId, decision: "skip", reason: "payload_media_facts_incomplete", objectPath }); continue; }
    if (durationMs < MIN_PUBLISHABLE_MS || durationMs > MAX_PUBLISHABLE_MS) { plans.push({ draftId, decision: "skip", reason: `duration_out_of_publishable_range:${durationMs}`, objectPath }); continue; }
    // A row may already exist because an earlier run registered the media and
    // then lost the connection before restoring the schedule. Skipping such a
    // draft would strand exactly the row that most needs finishing, so instead
    // verify the existing row is the shape publish time requires and, if so,
    // resume at the schedule step. A row that does NOT match is left alone: this
    // script repairs its own half-finished work, it does not overwrite someone
    // else's registration.
    const existing = await readProvenance(objectPath);
    if (existing) {
      const usable = existing.media_kind === "video"
        && existing.content_type_source === "storage_head_verified"
        && existing.byte_size_source === "storage_head_verified"
        && existing.dimensions_source === "browser_declared"
        && existing.duration_source === "browser_declared"
        && Number(existing.width) === width && Number(existing.height) === height && Number(existing.duration_ms) === durationMs
        && ["draft", "publish_pending", "published", "retained"].includes(String(existing.lifecycle_state));
      if (!usable) { plans.push({ draftId, decision: "skip", reason: "provenance_row_present_but_unusable", objectPath, provenanceExists: true }); continue; }
      // Register-only: a usable row is the entire goal, so there is nothing left
      // to do and the draft keeps the schedule it already has.
      if (!cohort.reschedule) { plans.push({ draftId, decision: "skip", reason: "already_registered_nothing_to_do", objectPath, provenanceExists: true, keptScheduledAt: draft.scheduled_at ?? undefined }); continue; }
      const slot = nextFreeHour(cursor, occupied);
      occupied.add(slot.getTime());
      cursor = slot;
      const newScheduledAt = slot.toISOString();
      plans.push({
        draftId, decision: "restore", reason: "provenance_already_registered_resume_schedule", objectPath,
        contentType: String(existing.content_type ?? ""), byteSize: Number(existing.byte_size), width, height, durationMs,
        previousScheduledTime: previous, newScheduledAt,
        newLocal: `${scheduleFieldsInTimeZone(newScheduledAt, SCHEDULE_TIME_ZONE).plannedAt} ${SCHEDULE_TIME_ZONE}`,
        expectedUpdatedAt: draft.updated_at, provenanceExists: true,
      });
      continue;
    }
    let head: { contentType: string; byteSize: number };
    try { head = await headObject(objectPath); }
    catch (error) { plans.push({ draftId, decision: "skip", reason: `storage_head_failed:${error instanceof Error ? error.message : String(error)}`, objectPath }); continue; }
    if (head.contentType !== "video/mp4") { plans.push({ draftId, decision: "skip", reason: `unexpected_content_type:${head.contentType}`, objectPath }); continue; }
    // Register-only: write the row and leave the existing schedule untouched, so
    // the draft publishes at the hour it was always going to.
    if (!cohort.reschedule) {
      plans.push({
        draftId, decision: "restore", reason: "provenance_missing_register_only", objectPath,
        contentType: head.contentType, byteSize: head.byteSize, width, height, durationMs,
        expectedUpdatedAt: draft.updated_at, provenanceExists: false, keptScheduledAt: draft.scheduled_at ?? undefined,
      });
      continue;
    }
    const slot = nextFreeHour(cursor, occupied);
    occupied.add(slot.getTime());
    cursor = slot;
    const newScheduledAt = slot.toISOString();
    plans.push({
      draftId, decision: "restore", reason: "provenance_missing_and_unqueued", objectPath,
      contentType: head.contentType, byteSize: head.byteSize, width, height, durationMs,
      previousScheduledTime: previous, newScheduledAt,
      newLocal: `${scheduleFieldsInTimeZone(newScheduledAt, SCHEDULE_TIME_ZONE).plannedAt} ${SCHEDULE_TIME_ZONE}`,
      expectedUpdatedAt: draft.updated_at, provenanceExists: false,
    });
  }
  return plans;
}

function renderTable(plans: Plan[]): string {
  if (!cohort.reschedule) {
    const lines = [
      "| # | draft_id | decision | reason | bytes | w x h | dur ms | schedule (preserved, UTC) |",
      "|---|---|---|---|---|---|---|---|",
    ];
    plans.forEach((p, i) => lines.push(`| ${i + 1} | \`${p.draftId.slice(0, 24)}…\` | ${p.decision} | ${p.reason} | ${p.byteSize ?? "-"} | ${p.width && p.height ? `${p.width}x${p.height}` : "-"} | ${p.durationMs ?? "-"} | ${p.keptScheduledAt ?? "-"} |`));
    return lines.join("\n");
  }
  const lines = [
    "| # | draft_id | decision | reason | bytes | w x h | dur ms | original (UTC) | new (UTC) | new (NY) |",
    "|---|---|---|---|---|---|---|---|---|---|",
  ];
  plans.forEach((p, i) => lines.push(`| ${i + 1} | \`${p.draftId.slice(0, 24)}…\` | ${p.decision} | ${p.reason} | ${p.byteSize ?? "-"} | ${p.width && p.height ? `${p.width}x${p.height}` : "-"} | ${p.durationMs ?? "-"} | ${p.previousScheduledTime ?? "-"} | ${p.newScheduledAt ?? "-"} | ${p.newLocal ?? "-"} |`));
  return lines.join("\n");
}

async function applyPlan(plan: Plan): Promise<{ draftId: string; ok: boolean; detail: string }> {
  // Step 1: registration. Must land before the schedule, or the next tick
  // reproduces the original failure. Skipped when a prior run already wrote a
  // verified row — this step is the resumable half.
  if (plan.provenanceExists) {
    const already = await readProvenance(plan.objectPath!);
    if (!already) return { draftId: plan.draftId, ok: false, detail: "expected_existing_provenance_row_vanished" };
  } else {
  const registration = {
    owner_user_id: OWNER_USER_ID, bucket_id: BUCKET, object_path: plan.objectPath,
    media_kind: "video", source_type: "upload", lifecycle_state: "draft", intent_id: null,
    content_type: plan.contentType, byte_size: plan.byteSize,
    // Measured against the stored object by HEAD just above, so the labels are accurate.
    content_type_source: "storage_head_verified", byte_size_source: "storage_head_verified",
    // Not recomputed: the bytes were never hashed at upload time, and claiming a
    // verified digest we did not compute would be a lie the publisher trusts.
    checksum_sha256: null, checksum_source: "unavailable",
    // Carried over verbatim from what the uploader declared in the payload, which
    // is what `browser_declared` means and what publish time compares against.
    width: plan.width, height: plan.height, duration_ms: plan.durationMs,
    dimensions_source: "browser_declared", duration_source: "browser_declared",
    updated_at: new Date().toISOString(),
  };
  await rest(`/media_asset_provenance?on_conflict=bucket_id,object_path`, {
    method: "POST",
    headers: { "content-type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(registration),
  });
  const confirmed = await readProvenance(plan.objectPath!);
  if (!confirmed) return { draftId: plan.draftId, ok: false, detail: "provenance_row_not_visible_after_write" };
  }

  // Register-only cohort: the row was the whole fix. Deliberately no draft write —
  // the existing schedule is what we are protecting, and the draft now resolves a
  // valid registration when its hour arrives. Re-read to prove it did not move.
  if (!cohort.reschedule) {
    const after = (await readDrafts([plan.draftId])).get(plan.draftId);
    if (!after?.scheduled_at) return { draftId: plan.draftId, ok: false, detail: "schedule_disappeared_during_registration" };
    if (plan.keptScheduledAt && Date.parse(after.scheduled_at) !== Date.parse(plan.keptScheduledAt)) {
      return { draftId: plan.draftId, ok: false, detail: `schedule_changed_during_registration:${after.scheduled_at}` };
    }
    return { draftId: plan.draftId, ok: true, detail: `registered_only:schedule_preserved=${after.scheduled_at}` };
  }

  // Step 2: schedule, compare-and-swap on updated_at so a draft another session
  // has modified since the pre-flight read is left alone rather than clobbered.
  const current = (await readDrafts([plan.draftId])).get(plan.draftId);
  if (!current) return { draftId: plan.draftId, ok: false, detail: "draft_vanished_before_schedule" };
  if (current.updated_at !== plan.expectedUpdatedAt) return { draftId: plan.draftId, ok: false, detail: `cas_lost:updated_at_changed:${current.updated_at}` };
  if (current.scheduled_at) return { draftId: plan.draftId, ok: false, detail: `cas_lost:already_scheduled:${current.scheduled_at}` };
  const stamp = new Date().toISOString();
  const payload = restoredPayload(current.payload ?? {}, plan.newScheduledAt!);
  payload.updatedAt = stamp;
  const response = await rest(`/pin_drafts?vibepin_user_id=eq.${OWNER_USER_ID}&draft_id=eq.${encodeURIComponent(plan.draftId)}&updated_at=eq.${encodeURIComponent(plan.expectedUpdatedAt!)}&scheduled_at=is.null&publish_claimed_at=is.null&deleted_at=is.null&archived_at=is.null`, {
    method: "PATCH",
    headers: { "content-type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify({ payload, status: "ready", scheduled_at: plan.newScheduledAt, updated_at: stamp }),
  });
  const updated = await response.json() as unknown[];
  if (updated.length !== 1) return { draftId: plan.draftId, ok: false, detail: `cas_lost:updated_rows_${updated.length}` };
  return { draftId: plan.draftId, ok: true, detail: `scheduled_at=${plan.newScheduledAt}` };
}

async function verify(plans: Plan[]): Promise<string[]> {
  const lines: string[] = [];
  const drafts = await readDrafts(TARGET_DRAFT_IDS);
  for (const plan of plans.filter((p) => p.decision === "restore")) {
    const draft = drafts.get(plan.draftId);
    const provenance = await readProvenance(plan.objectPath!);
    // Rescheduled drafts must sit on their new slot; register-only drafts must
    // still sit on exactly the slot they had before this run touched anything.
    const expectedInstant = cohort.reschedule ? plan.newScheduledAt! : plan.keptScheduledAt!;
    const scheduleOk = !!draft?.scheduled_at && !!expectedInstant && Date.parse(draft.scheduled_at) === Date.parse(expectedInstant);
    const provenanceOk = !!provenance
      && provenance.content_type_source === "storage_head_verified"
      && provenance.byte_size_source === "storage_head_verified"
      && provenance.dimensions_source === "browser_declared"
      && provenance.duration_source === "browser_declared"
      && provenance.media_kind === "video"
      && Number(provenance.width) === plan.width
      && Number(provenance.height) === plan.height
      && Number(provenance.duration_ms) === plan.durationMs
      && Number(provenance.byte_size) === plan.byteSize
      && provenance.checksum_source === "unavailable"
      && provenance.checksum_sha256 === null
      && ["draft", "publish_pending", "published", "retained"].includes(String(provenance.lifecycle_state));
    const errorCleared = !draft?.payload?.publishError;
    lines.push(`| \`${plan.draftId.slice(0, 24)}…\` | ${provenanceOk ? "PASS" : "FAIL"} | ${scheduleOk ? "PASS" : "FAIL"} | ${errorCleared ? "PASS" : "FAIL"} | ${draft?.scheduled_at ?? "null"} |`);
  }
  return lines;
}

async function main() {
  const plans = await buildPlans();
  const restore = plans.filter((p) => p.decision === "restore");
  const skip = plans.filter((p) => p.decision === "skip");
  console.log(renderTable(plans));
  console.log(`\nplanned restores: ${restore.length}  skipped: ${skip.length}  (scope: ${TARGET_DRAFT_IDS.length})`);

  const sections: string[] = [
    "",
    "---",
    "",
    `## Cohort \`${cohortName}\` — ${cohort.ids.length} drafts ${cohort.label} (${APPLY ? "apply" : "dry-run"})`,
    "",
    `- Generated: ${new Date().toISOString()}`,
    `- Target project ref: \`${projectRef}\` (asserted !== \`${PRODUCTION_REF}\`)`,
    `- Mode: ${APPLY ? "apply" : "dry-run"}`,
    `- Action: ${cohort.reschedule ? "register media, then move to a new future slot" : "register media ONLY — existing schedules are preserved verbatim"}`,
    `- Scope: ${TARGET_DRAFT_IDS.length} drafts. The 400-class failures are out of scope and untouched.`,
    "",
    "### Plan",
    "",
    renderTable(plans),
    "",
  ];

  // The receipt accumulates every cohort; earlier sections are the durable record
  // of work already applied and must never be overwritten by a later run.
  const writeReceipt = (body: string) => {
    mkdirSync(dirname(receiptPath), { recursive: true });
    const prior = existsSync(receiptPath) ? readFileSync(receiptPath, "utf8").replace(/\s*$/, "\n") : "";
    writeFileSync(receiptPath, `${prior}${body}`, "utf8");
  };

  if (!APPLY) {
    sections.push("### Result", "", "Dry run — no writes performed. Re-run with `--apply` after reviewing the table above.", "");
    writeReceipt(`${sections.join("\n")}\n`);
    console.log(`\nDRY-RUN complete. No writes. Receipt: ${receiptPath}`);
    return;
  }

  const results: Array<{ draftId: string; ok: boolean; detail: string }> = [];
  for (const plan of restore) {
    const result = await applyPlan(plan);
    results.push(result);
    console.log(`${result.ok ? "OK  " : "FAIL"} ${plan.draftId.slice(0, 24)}… ${result.detail}`);
  }
  const verification = await verify(plans);
  sections.push(
    "### Apply results", "",
    "| draft_id | outcome | detail |", "|---|---|---|",
    ...results.map((r) => `| \`${r.draftId.slice(0, 24)}…\` | ${r.ok ? "applied" : "failed"} | ${r.detail} |`),
    "",
    "### Read-back verification", "",
    `| draft_id | provenance row | ${cohort.reschedule ? "new schedule" : "schedule preserved"} | payload clean | scheduled_at |`, "|---|---|---|---|---|",
    ...verification, "",
  );
  writeReceipt(`${sections.join("\n")}\n`);
  const failed = results.filter((r) => !r.ok).length;
  const verifyFailed = verification.filter((line) => line.includes("FAIL")).length;
  console.log(`\nAPPLY complete. applied=${results.length - failed} failed=${failed} verify_failures=${verifyFailed}`);
  console.log(`Receipt: ${receiptPath}`);
  if (failed || verifyFailed) process.exitCode = 2;
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
