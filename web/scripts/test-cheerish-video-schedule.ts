import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ALLOWED_BOARDS, CANARY_MAPPING_ID, SAFE_PRIVATE_STORAGE_BYTES, SOCIAL_CONNECTION_PROJECTION, authoritativeDestination, buildCanaryScheduledAt, buildDraftId, chunkRows, dedupeManifest, isTerminalUploadState, needsVideoNormalization, patchSourceCsvRow, readRequiredFlag, resolveRequiredBoards, runConcurrentWithSequentialRetry, selectExpectedPinterestConnection, selectRowsForCommand, shouldUseRetry1, targetVideoBitrateKbps, uploadAttemptKeys, validateManifest, validatePreviewBinding, type CheerishScheduleRow } from "./lib/cheerish-video-schedule";

const row = (n: number): CheerishScheduleRow => ({
  sourceCsv: n < 41 ? "D:/data/2026-09-17/video-product-map.csv" : "D:/data/2026-09-18/video-product-map.csv",
  rowIndex: n + 2,
  mappingId: n === 41 ? CANARY_MAPPING_ID : `map-${n}`,
  localFilePath: `D:/data/videos/${n}.mp4`,
  sha256: n.toString(16).padStart(64, "0"),
  productHandle: n < 41 ? "coffee-pod-maker-b0gjf188h7" : n === 41 ? "enchanted-led-rose-glass-dome" : "personalized-preserved-rose-box-necklace",
  destinationUrl: n < 41 ? "https://cheerish.co/products/coffee-pod-maker-b0gjf188h7" : n === 41 ? "https://cheerish.co/products/enchanted-led-rose-glass-dome" : "https://cheerish.co/products/personalized-preserved-rose-box-necklace",
  board: n < 41 ? "Home & Kitchen Finds" : "Gift Ideas for Her & Personalized Jewelry",
  title: `Unique title ${n}`,
  description: `Unique description for video ${n}.`,
  scheduledAt: new Date(Date.UTC(2026, 8, 19 + Math.floor(n / 22), 13, n % 22)).toISOString(),
});

assert.deepEqual(ALLOWED_BOARDS, ["Gift Ideas for Her & Personalized Jewelry", "Home & Kitchen Finds", "Cleaning & Self-Care Finds", "Smart Gadgets & Everyday Essentials"]);
const rows = Array.from({ length: 87 }, (_, i) => row(i));
assert.deepEqual(chunkRows(rows.slice(0, 10), 4).map((chunk) => chunk.map((item) => item.mappingId)), [
  ["map-0", "map-1", "map-2", "map-3"], ["map-4", "map-5", "map-6", "map-7"], ["map-8", "map-9"],
]);
assert.deepEqual(chunkRows(rows.slice(0, 1), 4).map((chunk) => chunk.length), [1], "canary remains a single-row batch");
assert.equal(validateManifest(rows).ok, true);
assert.equal(validateManifest(rows.slice(0, 86)).ok, false);
assert.equal(validateManifest(rows.map((item, index) => index === 41 ? { ...item, mappingId: "not-the-canary" } : item)).ok, false, "manifest requires exactly one canary mapping");
assert.equal(validateManifest(rows.map((r, i) => i === 0 ? { ...r, destinationUrl: "https://amazon.com/dp/x" } : r)).ok, false);
assert.equal(validateManifest(rows.map((r, i) => i === 41 ? { ...r, board: "Home & Kitchen Finds" } : r)).ok, false);
assert.equal(authoritativeDestination("personalized-preserved-rose-box-necklace"), "https://cheerish.co/products/personalized-preserved-rose-box-necklace");
assert.equal(authoritativeDestination("unknown"), null);
const duplicate = { ...rows[1], mappingId: "duplicate", sha256: rows[0].sha256 };
assert.equal(dedupeManifest([...rows, duplicate]).accepted.length, 87);
assert.equal(dedupeManifest([...rows, duplicate]).duplicates.length, 1);
assert.deepEqual(selectRowsForCommand(rows, "canary").map((item) => item.mappingId), [CANARY_MAPPING_ID]);
assert.equal(validateManifest(rows).rows.filter((item) => item.mappingId === CANARY_MAPPING_ID).length, 1);
assert.equal(selectRowsForCommand(rows, "stage-all").length, 86);
assert.equal(selectRowsForCommand(rows, "stage-all").some((item) => item.mappingId === CANARY_MAPPING_ID), false);
assert.throws(() => selectRowsForCommand(rows, "retry-canary"), /unknown_command/);
assert.equal(buildCanaryScheduledAt(new Date("2026-01-15T17:30:00.000Z")), "2026-01-15T12:29:00-05:00");
assert.equal(buildCanaryScheduledAt(new Date("2026-07-15T16:30:00.000Z")), "2026-07-15T12:29:00-04:00");
const scheduleSource = readFileSync("scripts/cheerish-video-schedule.ts", "utf8");
assert.doesNotMatch(scheduleSource, /buildCanaryScheduledAt\(new Date\(Date\.now\(\)\s*-\s*60_000\)\)/, "canary caller must not subtract a second minute");
assert.match(scheduleSource, /scheduleRow\(db,\s*ctx,\s*boards,\s*row,\s*upload,\s*buildCanaryScheduledAt\(new Date\(\)\)\)/, "canary scheduling passes the finalized upload before its time override");
const cheerish = { provider: "pinterest", connection_status: "connected", provider_account_username: "@cheerishh", needs_reconnect: false, disconnected_at: null };
assert.equal(selectExpectedPinterestConnection([cheerish], "cheerishh"), cheerish);
const namedCheerish = { ...cheerish, provider_account_username: "unrelated", provider_account_name: "@cheerishh" };
assert.equal(selectExpectedPinterestConnection([namedCheerish], "cheerishh"), namedCheerish);
assert.throws(() => selectExpectedPinterestConnection([{ ...cheerish, provider_account_username: "other" }], "cheerishh"), /expected_pinterest_connection_count:0/);
assert.throws(() => selectExpectedPinterestConnection([cheerish, { ...cheerish }], "cheerishh"), /expected_pinterest_connection_count:2/);
assert.throws(() => selectExpectedPinterestConnection([cheerish], ""), /expected_pinterest_username_required/);
assert.equal(readRequiredFlag(["node", "script", "--manifest", "rows.json"], "--manifest"), "rows.json");
assert.throws(() => readRequiredFlag(["node", "script", "--other", "rows.json"], "--manifest"), /missing_required_flag:--manifest/);
assert.throws(() => readRequiredFlag(["node", "script", "--manifest"], "--manifest"), /missing_required_flag_value:--manifest/);
assert.match(SOCIAL_CONNECTION_PROJECTION, /(?:^|,)provider(?:,|$)/);
const availableBoards = ALLOWED_BOARDS.map((name, index) => ({ id: `board-${index}`, name }));
assert.deepEqual(resolveRequiredBoards(availableBoards), Object.fromEntries(ALLOWED_BOARDS.map((name, index) => [name, `board-${index}`])));
assert.throws(() => resolveRequiredBoards(availableBoards.slice(0, -1)), /required_pinterest_board_count:0/);
assert.throws(() => resolveRequiredBoards([...availableBoards, { id: "duplicate", name: ALLOWED_BOARDS[0] }]), /required_pinterest_board_count:2/);
const sourceCsv = [
  "pinterest_account,pinterest_board,pinterest_title,pinterest_description,pinterest_destination_url,publish_status,pinterest_scheduled_at,pinterest_pin_id,published_at,publish_error,notes,rights_status,consent_reference",
  "acct,board,\"old, title\",old description,https://example.test/old,draft,,,,,,approved,consent-123",
].join("\r\n");
const patchedCsv = patchSourceCsvRow(sourceCsv, 2, {
  pinterest_title: "new, title",
  publish_status: "scheduled",
  pinterest_scheduled_at: "2026-09-19T09:00:00-04:00",
  notes: "scheduled by cheerish-video-schedule",
});
assert.equal(patchedCsv, [
  "pinterest_account,pinterest_board,pinterest_title,pinterest_description,pinterest_destination_url,publish_status,pinterest_scheduled_at,pinterest_pin_id,published_at,publish_error,notes,rights_status,consent_reference",
  "acct,board,\"new, title\",old description,https://example.test/old,scheduled,2026-09-19T09:00:00-04:00,,,\"\",\"scheduled by cheerish-video-schedule\",approved,consent-123",
].join("\r\n"));
assert.throws(() => patchSourceCsvRow(sourceCsv, 2, { rights_status: "revoked" } as never), /csv_patch_column_not_allowed/);
assert.throws(() => patchSourceCsvRow(sourceCsv, 2, { publish_status: "draft" }), /csv_patch_invalid_status/);
assert.match(buildDraftId(rows[0]), /^cheerish_[0-9a-f]{56}$/);
assert.equal(validatePreviewBinding("https://snulmwprsahzqvdbyenc.supabase.co", "snulmwprsahzqvdbyenc").ok, true);
assert.equal(validatePreviewBinding("https://jaxteelkecvlozdrdoog.supabase.co", "snulmwprsahzqvdbyenc").ok, false);
const compliantVideo = { videoCodec: "h264", videoProfile: "High", pixelFormat: "yuv420p", audioCodec: "aac", audioProfile: "LC", audioSampleRate: 48_000, audioChannels: 2 };
assert.equal(needsVideoNormalization({ ...compliantVideo, audioProfile: "HE-AAC" }, 50 * 1024 * 1024), true, "HE-AAC must be normalized to AAC-LC");
assert.equal(needsVideoNormalization({ ...compliantVideo, pixelFormat: "yuvj420p" }, 50 * 1024 * 1024), true, "yuvj420p must be normalized to yuv420p");
assert.equal(needsVideoNormalization(compliantVideo, 40 * 1024 * 1024), false, "H264 High with AAC-LC stereo below the storage ceiling is upload-ready");
assert.equal(needsVideoNormalization(compliantVideo, SAFE_PRIVATE_STORAGE_BYTES + 1), true, "files above the private-storage ceiling must be normalized");
assert.equal(targetVideoBitrateKbps(18_600), 3200, "short videos retain the quality ceiling");
assert.deepEqual(uploadAttemptKeys("a".repeat(64), 0), { batchIdempotencyKey: `ops_batch_${"a".repeat(48)}`, itemIdempotencyKey: `ops_item_${"a".repeat(48)}` });
assert.deepEqual(uploadAttemptKeys("b".repeat(64), 1), { batchIdempotencyKey: `ops_batch_retry1_${"b".repeat(48)}`, itemIdempotencyKey: `ops_item_retry1_${"b".repeat(48)}` });
for (const status of ["failed", "expired", "canceled", "cleaning"]) assert.equal(isTerminalUploadState(status), true);
for (const status of ["prepared", "uploading", "finalizing", "finalized", ""]) assert.equal(isTerminalUploadState(status), false);
for (const state of [
  { batchStatus: "missing", itemStatus: "missing" },
  { batchStatus: "prepared", itemStatus: "prepared" },
  { batchStatus: "uploading", itemStatus: "uploading" },
  { batchStatus: "finalizing", itemStatus: "finalizing" },
]) assert.equal(shouldUseRetry1(state), false);
assert.equal(shouldUseRetry1({ batchStatus: "failed", itemStatus: "failed" }), true);
assert.equal(shouldUseRetry1({ batchStatus: "ready", itemStatus: "expired" }), true);
const bitrateAt160Seconds = targetVideoBitrateKbps(160_000);
assert.ok(bitrateAt160Seconds < 3200, "long videos reduce video bitrate below the quality ceiling");
assert.ok((bitrateAt160Seconds + 128) * 1000 * 160 <= SAFE_PRIVATE_STORAGE_BYTES * 8, "long-video audio and video budget stays within private storage");
const bitrateAt199Point6Seconds = targetVideoBitrateKbps(199_600);
assert.ok(bitrateAt199Point6Seconds < bitrateAt160Seconds, "longer videos receive a lower bitrate budget");
assert.ok((bitrateAt199Point6Seconds + 128) * 1000 * 199.6 <= SAFE_PRIVATE_STORAGE_BYTES * 8, "199.6-second audio and video budget stays within private storage");

async function testConcurrentSequentialRetry() {
  const retryAttempts = new Map<string, number>();
  const retryEvents: string[] = [];
  const retryRows = ["a", "b", "c", "d"];
  const retryResults = await runConcurrentWithSequentialRetry(retryRows, async (item) => {
    const attempt = (retryAttempts.get(item) ?? 0) + 1;
    retryAttempts.set(item, attempt);
    retryEvents.push(`${item}-${attempt}`);
    if ((item === "b" || item === "c") && attempt === 1) throw new Error(`transient-${item}`);
    return `${item}-${attempt}`;
  });
  assert.deepEqual(retryResults, ["a-1", "b-2", "c-2", "d-1"]);
  assert.deepEqual([...retryAttempts.entries()], [["a", 1], ["b", 2], ["c", 2], ["d", 1]]);
  assert.deepEqual(retryEvents, ["a-1", "b-1", "c-1", "d-1", "b-2", "c-2"], "retries are sequential and input ordered");
  await assert.rejects(
    runConcurrentWithSequentialRetry(["x"], async () => { throw new Error("still-broken"); }),
    /still-broken/,
  );
}

testConcurrentSequentialRetry().then(() => console.log("cheerish-video-schedule tests passed"))
  .catch((error) => { console.error(error); process.exitCode = 1; });
