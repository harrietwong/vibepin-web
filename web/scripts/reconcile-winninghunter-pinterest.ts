/** Local-only reconciliation for the 48-item WinningHunter Pinterest stage.
 * Default mode is a read-only dry run. --apply is the only write path.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, basename, join } from "node:path";

const RECEIPT = "D:/vp-tmp/publish-prep/winninghunter-48-stage-receipt.json";
const QUEUE = "D:/代码/社媒/视频+产品链接 交付文件夹/2026-09-21_winninghunter-outwardsk-christmas-krejova-filamniceent/agent-output/winninghunter-three-platform-priority-queue.json";
const OUT = join(dirname(QUEUE), "pinterest-schedule-receipt.json");
const EXPECTED = 48;
const EXPECTED_PREVIEW_REF = "snulmwprsahzqvdbyenc";
const EXPECTED_USER_ID = "4cf569cd-1f20-404d-93d7-1e2c0b8a7251";
const EXPECTED_CONNECTION_ID = "a273f91c-4589-4fce-b19c-e24f2bdf6c99";

type AnyRow = Record<string, any>;
function readJson(path: string): AnyRow { if (!existsSync(path)) throw new Error(`missing_file:${path}`); return JSON.parse(readFileSync(path, "utf8")); }
function rows(value: AnyRow): AnyRow[] {
  for (const key of ["plans", "items", "entries", "rows", "schedule", "pinterest", "planned_items"]) if (Array.isArray(value[key])) return value[key];
  if (Array.isArray(value)) return value;
  throw new Error("receipt_items_array_not_found");
}
function value(row: AnyRow, ...keys: string[]): any { for (const key of keys) if (row[key] != null) return row[key]; return undefined; }
function fail(messages: string[]): never { throw new Error(`validation_failed:\n${messages.map((x) => `- ${x}`).join("\n")}`); }
function atomicWrite(path: string, data: string): void { const tmp = `${path}.tmp-${process.pid}`; writeFileSync(tmp, data, "utf8"); renameSync(tmp, path); }

export function reconcile(receipt: AnyRow, queueDoc: AnyRow, now = new Date()) {
  const receiptRows = rows(receipt);
  const queueRows: AnyRow[] = Array.isArray(queueDoc) ? queueDoc : queueDoc.queue;
  const errors: string[] = [];
  if (receipt.mode !== "stage-apply") errors.push(`unexpected_receipt_mode=${receipt.mode}`);
  if (receipt.mayPublish !== false) errors.push("receipt_may_publish");
  if (receipt.previewRef !== EXPECTED_PREVIEW_REF) errors.push(`unexpected_preview_ref=${receipt.previewRef}`);
  if (receipt.userId !== EXPECTED_USER_ID) errors.push(`unexpected_user_id=${receipt.userId}`);
  if (receipt.connectionId !== EXPECTED_CONNECTION_ID) errors.push(`unexpected_connection_id=${receipt.connectionId}`);
  if (!Array.isArray(queueRows)) errors.push("queue_array_not_found");
  if (receiptRows.length !== EXPECTED) errors.push(`receipt_count=${receiptRows.length}, expected=${EXPECTED}`);
  const eligible = (queueRows ?? []).filter((r) => r.queue_class === "ready_after_platform_gates" || r.readiness === "ready_after_platform_gates");
  if (eligible.length !== EXPECTED) errors.push(`queue_ready_count=${eligible.length}, expected=${EXPECTED}`);
  const bySha = new Map((queueRows ?? []).map((r) => [String(r.sha256).toLowerCase(), r]));
  const seen = new Set<string>();
  const updates: AnyRow[] = [];
  for (const [i, stage] of receiptRows.entries()) {
    const sha = String(value(stage, "sha256", "sha", "content_sha256") ?? "").toLowerCase();
    const item = bySha.get(sha);
    if (!sha || !item) { errors.push(`row_${i + 1}:sha256_not_in_queue`); continue; }
    if (seen.has(sha)) errors.push(`row_${i + 1}:duplicate_sha256`); seen.add(sha);
    const expectedKey = `winninghunter:${sha}`;
    const idem = String(value(stage, "idempotencyKey", "idempotency_key") ?? "");
    if (idem !== expectedKey) errors.push(`row_${i + 1}:idempotencyKey=${idem}, expected=${expectedKey}`);
    const planned = value(stage, "scheduled_at", "scheduledAt", "plannedAt", "planned_at");
    if (!planned || Number.isNaN(Date.parse(String(planned)))) errors.push(`row_${i + 1}:invalid_plan_time`);
    const draftId = String(value(stage, "draftId", "draft_id") ?? "");
    if (!draftId) errors.push(`row_${i + 1}:missing_draft_id`);
    updates.push({ item, sha, draftId, idempotencyKey: expectedKey, scheduledAt: planned });
  }
  if (seen.size !== EXPECTED) errors.push(`unique_sha256=${seen.size}, expected=${EXPECTED}`);
  if (errors.length) fail(errors);
  const updatedQueue = JSON.parse(JSON.stringify(queueDoc));
  const updateBySha = new Map(updates.map((u) => [u.sha, u]));
  for (const item of updatedQueue.queue) { const u = updateBySha.get(String(item.sha256).toLowerCase()); if (!u) continue; item.platforms ??= {}; item.platforms.pinterest = { ...(item.platforms.pinterest ?? {}), status: "scheduled", scheduled_at: u.scheduledAt, remote_id: null, attempts: 0 }; }
  return {
    updatedQueue,
    updates,
    receipt: {
      generated_at: now.toISOString(),
      mode: "pinterest_reconciliation",
      preview_ref: EXPECTED_PREVIEW_REF,
      user_id: EXPECTED_USER_ID,
      connection_id: EXPECTED_CONNECTION_ID,
      count: updates.length,
      items: updates.map(({ item, draftId, ...rest }) => ({ queue_rank: item.queue_rank, draft_id: draftId, ...rest })),
    },
  };
}

function main() {
  const apply = process.argv.slice(2).includes("--apply");
  const result = reconcile(readJson(RECEIPT), readJson(QUEUE));
  if (!apply) { console.log(JSON.stringify({ mode: "dry-run", count: result.updates.length, output: OUT }, null, 2)); return; }
  const backup = `${QUEUE}.backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  copyFileSync(QUEUE, backup); mkdirSync(dirname(OUT), { recursive: true });
  atomicWrite(QUEUE, `${JSON.stringify(result.updatedQueue, null, 2)}\n`);
  atomicWrite(OUT, `${JSON.stringify(result.receipt, null, 2)}\n`);
  console.log(JSON.stringify({ mode: "apply", count: result.updates.length, backup, output: OUT }, null, 2));
}
if (process.argv[1] && basename(process.argv[1]).startsWith("reconcile-winninghunter-pinterest")) main();
