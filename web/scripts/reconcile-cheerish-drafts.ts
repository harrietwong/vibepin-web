import { readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import {
  ACCOUNT_LABEL,
  BOARD_IDS,
  CONNECTION_ID,
  buildReviewPatch,
  assertApplyInvocation,
  classifyExistingDraft,
  reconcileDrafts,
  mergeApplyPayload,
  validateApplyPreflight,
  validateApplyResultCount,
  type ExistingDraft,
  type ManifestRow,
} from "./lib/reconcile-cheerish-drafts";

const DEFAULT_MANIFEST = "D:/vp-tmp/publish-prep/cheerish-schedule-manifest-draft.json";
const DEFAULT_ENV = "D:/代码/Pinterest flow/web/.env.test.local";
const DEFAULT_REPORT = "D:/vp-tmp/coordination/reconcile-62-dryrun-report.md";
const DEFAULT_PATCH = "D:/vp-tmp/coordination/reconcile-62-dryrun-patch.json";
const DEFAULT_BEFORE = "D:/vp-tmp/coordination/reconcile-62-apply-before.json";
const DEFAULT_EXECUTION = "D:/vp-tmp/coordination/reconcile-62-apply-execution-report.md";

function flag(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : (process.argv[index + 1] ?? "");
}

function loadEnv(path: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (match) result[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
  return result;
}

function readManifest(path: string): ManifestRow[] {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Array<Record<string, unknown>>;
  return raw.map((item) => ({
    mappingId: String(item.mappingId ?? ""), sha256: String(item.sha256 ?? ""), localFilePath: String(item.localFilePath ?? ""),
    sourceLocalFileName: basename(String(item.localFilePath ?? "")), title: String(item.title ?? ""), description: String(item.description ?? ""),
    destinationUrl: String(item.destinationUrl ?? ""), boardName: String(item.board ?? ""), scheduledAt: String(item.scheduledAt ?? ""),
  }));
}

function markdownReport(args: {
  manifest: string; patch: string; rows: ManifestRow[]; excluded: ExistingDraft[]; matches: ReturnType<typeof reconcileDrafts>["items"]; failures: string[];
}): string {
  const boardCounts = new Map<string, number>(); const dateCounts = new Map<string, number>();
  for (const match of args.matches) {
    boardCounts.set(match.row.boardName, (boardCounts.get(match.row.boardName) ?? 0) + 1);
    dateCounts.set(match.row.scheduledAt.slice(0, 10), (dateCounts.get(match.row.scheduledAt.slice(0, 10)) ?? 0) + 1);
  }
  const lines = [
    "# Cheerish Preview 62 Draft Reconciliation (dry-run)", "", `Generated: ${new Date().toISOString()}`, "",
    "## Safety", "", "Read-only Supabase selects only. No database write, deployment, upload, publish, or mutation is performed.",
    `- Preview manifest: \`${args.manifest}\``, `- Review patch: \`${args.patch}\``, `- Account: @${ACCOUNT_LABEL} (${CONNECTION_ID})`, "",
    "## Scope", "", `- Manifest rows: ${args.rows.length}`, `- Existing non-draft rows excluded from mutation: ${args.excluded.length}`,
    `- Matched existing draft rows: ${args.matches.length}`, `- Failures: ${args.failures.length}`, "",
    "## Counts", "", `- Dates: ${[...dateCounts.entries()].sort().map(([key, value]) => `${key}=${value}`).join(", ") || "none"}`,
    `- Boards: ${[...boardCounts.entries()].sort().map(([key, value]) => `${key}=${value}`).join(", ") || "none"}`,
    `- Account: @${ACCOUNT_LABEL}=${args.matches.length}`, `- Board IDs: ${Object.entries(BOARD_IDS).map(([key, value]) => `${key}=${value}`).join(", ")}`, "",
    "## Failures", "", ...(args.failures.length ? args.failures.map((failure) => `- ${failure}`) : ["- none"]), "",
    "## 1:1 Matches", "", "| Manifest mapping | Existing draft | Existing media | Board | Scheduled at |", "|---|---|---|---|---|",
    ...args.matches.map((match) => `| ${match.row.mappingId} | ${match.draftId} | ${match.mediaId} | ${match.row.boardName} | ${match.row.scheduledAt} |`), "",
    "## Review", "", "The patch contains only updates to these existing draft IDs. It carries expected current status/schedule/media identity and never creates a draft or changes scheduled, posted, or failed rows.", "",
  ];
  return `${lines.join("\n")}\n`;
}

async function main() {
  const command = process.argv[2] ?? "dry-run";
  if (command === "apply") assertApplyInvocation(process.argv);
  else if (command !== "dry-run") throw new Error("only_dry_run_or_exact_apply_is_supported");
  const manifestPath = resolve(flag("--manifest", DEFAULT_MANIFEST));
  const env = loadEnv(resolve(flag("--env-file", DEFAULT_ENV)));
  const reportPath = resolve(flag("--report", DEFAULT_REPORT));
  const patchPath = resolve(flag("--patch", DEFAULT_PATCH));
  const beforePath = resolve(flag("--before", DEFAULT_BEFORE));
  const executionPath = resolve(flag("--execution-report", DEFAULT_EXECUTION));
  if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("missing_supabase_env");
  const manifest = readManifest(manifestPath);
  const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const connection = await db.from("social_connections").select("id,user_id,provider,provider_account_username,provider_account_name,connection_status,needs_reconnect,disconnected_at").eq("id", CONNECTION_ID).maybeSingle();
  if (connection.error) throw connection.error;
  if (!connection.data || connection.data.provider !== "pinterest" || connection.data.connection_status !== "connected" || connection.data.needs_reconnect || connection.data.disconnected_at || ![connection.data.provider_account_username, connection.data.provider_account_name].some((value) => String(value ?? "").replace(/^@/, "").toLowerCase() === ACCOUNT_LABEL)) throw new Error("pinterest_connection_identity_mismatch");
  const result = await db.from("pin_drafts").select("vibepin_user_id,draft_id,status,scheduled_at,payload").eq("vibepin_user_id", connection.data.user_id).is("deleted_at", null).limit(500);
  if (result.error) throw result.error;
  const existing = (result.data ?? []).map((item) => ({ userId: String(item.vibepin_user_id), draftId: String(item.draft_id), status: String(item.status ?? ""), scheduledAt: item.scheduled_at ? String(item.scheduled_at) : null, payload: (item.payload ?? {}) as ExistingDraft["payload"] }));
  if (command === "apply") {
    const document = JSON.parse(readFileSync(patchPath, "utf8")) as { mode?: string; writesPerformed?: boolean; patches?: ReturnType<typeof buildReviewPatch>[] };
    if (document.mode !== "dry-run" || document.writesPerformed !== false || !Array.isArray(document.patches) || document.patches.length !== 62) throw new Error("invalid_dry_run_patch");
    const byId = new Map(existing.map((item) => [item.draftId, item]));
    const preflightRows: ExistingDraft[] = [];
    const failures: string[] = [];
    for (const patch of document.patches) {
      const current = byId.get(patch.draftId);
      if (!current) { failures.push(`${patch.draftId}: missing_on_preflight`); continue; }
      const failure = validateApplyPreflight(patch, current);
      if (failure) failures.push(failure);
      preflightRows.push(current);
    }
    if (new Set(document.patches.map((patch) => patch.draftId)).size !== document.patches.length) failures.push("duplicate_patch_draft_id");
    if (failures.length) throw new Error(`preflight_failed:\n${failures.join("\n")}`);
    writeFileSync(beforePath, `${JSON.stringify({ mode: "apply-preflight", writesPerformed: false, connectionId: CONNECTION_ID, drafts: preflightRows }, null, 2)}\n`, "utf8");
    const updateResults: Array<{ draftId: string; updatedAt: string }> = [];
    for (const patch of document.patches) {
      const current = byId.get(patch.draftId)!;
      const updatedAt = new Date().toISOString();
      const mergedPayload = mergeApplyPayload(current.payload, patch.set.payload);
      const updated = await db.from("pin_drafts").update({ payload: mergedPayload, status: "ready", updated_at: updatedAt, scheduled_at: patch.set.scheduled_at, publish_claimed_at: null }).eq("vibepin_user_id", current.userId).eq("draft_id", patch.draftId).is("scheduled_at", null).select("draft_id");
      if (updated.error) throw updated.error;
      validateApplyResultCount(updated.data?.length ?? 0, patch.draftId);
      updateResults.push({ draftId: patch.draftId, updatedAt });
    }
    const after = await db.from("pin_drafts").select("vibepin_user_id,draft_id,status,scheduled_at,payload").eq("vibepin_user_id", connection.data.user_id).in("draft_id", document.patches.map((patch) => patch.draftId));
    if (after.error) throw after.error;
    const afterById = new Map((after.data ?? []).map((item) => [String(item.draft_id), item]));
    const verifyFailures: string[] = [];
    for (const patch of document.patches) {
      const item = afterById.get(patch.draftId); const payload = item?.payload as ExistingDraft["payload"] | undefined;
      if (!item || String(item.status) !== "ready" || String(item.scheduled_at ?? "") !== patch.set.scheduled_at || payload?.targetConnectionId !== CONNECTION_ID || payload?.targetAccountLabel !== ACCOUNT_LABEL || payload?.boardId !== patch.set.payload.boardId || payload?.boardName !== patch.set.payload.boardName || payload?.title !== patch.set.payload.title || payload?.description !== patch.set.payload.description || payload?.destinationUrl !== patch.set.payload.destinationUrl) verifyFailures.push(`${patch.draftId}: post_apply_mismatch`);
    }
    writeFileSync(executionPath, `# Cheerish Preview apply execution\n\n- Confirmation: exact\n- Writes performed: ${updateResults.length}\n- Post-apply failures: ${verifyFailures.length}\n- Before snapshot: ${beforePath}\n\n${verifyFailures.length ? verifyFailures.map((failure) => `- ${failure}`).join("\n") : "All 62 rows re-read and verified."}\n`, "utf8");
    console.log(JSON.stringify({ ok: verifyFailures.length === 0, mode: "apply", writesPerformed: updateResults.length, verifyFailures, beforePath, executionPath }, null, 2));
    if (verifyFailures.length) process.exitCode = 2;
    return;
  }
  if (existing.length !== manifest.length) throw new Error(`scope_count_mismatch:manifest=${manifest.length}:existing=${existing.length}`);
  const handled = new Set<string>(); const excluded: ExistingDraft[] = []; const candidateRows: ManifestRow[] = [];
  for (const row of manifest) {
    const stable = existing.filter((draft) => draft.payload.sourceMappingId === row.mappingId || draft.payload.sourceVideoSha256 === row.sha256);
    const nonDraft = stable.filter((draft) => classifyExistingDraft(draft) !== "draft");
    if (nonDraft.length === 1) { handled.add(nonDraft[0].draftId); excluded.push(nonDraft[0]); }
    else candidateRows.push(row);
  }
  const reconciled = reconcileDrafts(candidateRows, existing.filter((draft) => !handled.has(draft.draftId)));
  const failures = [...reconciled.failures];
  if (manifest.length !== 87) failures.unshift(`manifest row count is ${manifest.length}, expected 87`);
  if (excluded.length !== 25) failures.unshift(`excluded non-draft row count is ${excluded.length}, expected 25 (24 scheduled + 1 posted)`);
  if (reconciled.items.length !== 62) failures.unshift(`matched draft row count is ${reconciled.items.length}, expected 62`);
  const patches = reconciled.items.map((match) => buildReviewPatch(match));
  writeFileSync(patchPath, `${JSON.stringify({ mode: "dry-run", writesPerformed: false, connectionId: CONNECTION_ID, accountLabel: ACCOUNT_LABEL, patches }, null, 2)}\n`, "utf8");
  writeFileSync(reportPath, markdownReport({ manifest: manifestPath, patch: patchPath, rows: manifest, excluded, matches: reconciled.items, failures }), "utf8");
  console.log(JSON.stringify({ ok: failures.length === 0, mode: "dry-run", manifestRows: manifest.length, excluded: excluded.length, matched: reconciled.items.length, failures, reportPath, patchPath }, null, 2));
  if (failures.length) process.exitCode = 2;
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
