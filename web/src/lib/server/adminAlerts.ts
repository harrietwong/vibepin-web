// ── Admin proactive alerts — A 部分:异常主动提醒 ──────────────────────────
//
// PRD: docs/prd/后台异常提醒与功能评价体系-PRD-v0.1-20260902.md §2
//
// WHY THIS EXISTS
// `adminActionCenter.ts` already knows who is stuck (5 blocker types, exact vs
// inferred data quality). Nothing ever pushed that out — the founder only finds
// out by opening /admin/today. This module is the SEND layer only: it selects a
// narrow, high-confidence subset of the existing judgment, deduplicates by
// state-transition (not daily re-send), and mails a single summary.
//
// HARD CONSTRAINTS FROM THE PRD (do not relax without re-reading §2.1/§2.2):
//   * Only 3 of the 5 blocker types are ever pushed: publish_failure,
//     pinterest_disconnected, generation_failures. signup_not_connected and
//     connected_not_creating stay page-only (no urgency, high noise).
//   * publish_failure MUST be dataQuality === "exact". Inferred publish failures
//     stay page-only — the error rate of the inference path is unknown, and a
//     false alarm here is the single most credibility-destroying failure mode
//     (§5 "告警疲劳" — the whole feature dies the day the founder starts
//     ignoring the inbox).
//   * Only accountKind === "customer" — never alert on test/internal logins.
//   * available === false (the action center itself couldn't compute) ⇒ push
//     NOTHING. Silence over a false "all clear" AND over a possibly-wrong list.
//   * This module MUST NOT reimplement blocker predicates — it only calls
//     getActionCenter() and filters/dedupes the result. Two judgment paths
//     drifting apart is exactly the failure the PRD calls out (§2.2, §5).
//
// DEDUPE (application-layer; admin_audit_events has no unique constraint — see
// PRD F3): key = `${userId}:${blockerType}`. We read the latest
// alert.blocker_notified / alert.blocker_cleared row per key and treat
// "notified" as still-open until a "cleared" row supersedes it. A blocker that
// is newly open (not already in the "notified" state) is a NEW alert; one that
// was notified and is no longer present gets a cleared row (no email); one
// already notified stays silent (that is the whole point of state-transition
// dedupe, not daily re-send).
//
// SEND: one summary email per run (never one email per blocker — inbox
// flooding is explicitly called out as a failure mode). sendEmail() is
// best-effort: ok:false or a thrown exception must never fail the run, and
// must never cause a blocker to be re-flagged as unsent (the audit row for
// blocker_notified is written regardless of email outcome, so a flaky provider
// cannot cause duplicate sends on the next cron tick — see §2.6 acceptance:
// "邮件发送失败不影响 cron 完成").

import { sendEmail, escapeHtml } from "@/lib/support/email";
import { getActionCenter, type ActionCenter, type BlockerItem, type BlockerType } from "./adminActionCenter";
import type { SupabaseLikeDb, TableRef, PgError } from "./adminQueryUtils";

// ── the 3 pushed blocker types (PRD §2.1) ───────────────────────────────────

const PUSHED_BLOCKER_TYPES: ReadonlySet<BlockerType> = new Set([
  "publish_failure",
  "pinterest_disconnected",
  "generation_failures",
]);

const AUDIT_ACTION_NOTIFIED = "alert.blocker_notified";
const AUDIT_ACTION_CLEARED = "alert.blocker_cleared";
const AUDIT_TARGET_TYPE = "user_blocker";

const HUMAN_LABELS: Record<BlockerType, string> = {
  publish_failure: "Publish failure",
  pinterest_disconnected: "Pinterest disconnected",
  generation_failures: "Generation failures",
  signup_not_connected: "Signup, never connected",
  connected_not_creating: "Connected, never creating",
};

const SUGGESTED_ACTIONS: Record<BlockerType, string> = {
  publish_failure: "Check the failed publish attempt and, if it is a Pinterest-side error, help the user retry.",
  pinterest_disconnected: "Reach out and help them reconnect their Pinterest account — nothing downstream can post until they do.",
  generation_failures: "Look at the generation error and see whether it is a transient provider issue or something the user is doing.",
  signup_not_connected: "",
  connected_not_creating: "",
};

// ── dedupe key ────────────────────────────────────────────────────────────

export function blockerKey(userId: string, blockerType: BlockerType): string {
  return `${userId}:${blockerType}`;
}

/**
 * Select which of the action center's items are eligible to be pushed at all
 * (independent of dedupe state). Pure function — PRD §2.1's three rules.
 */
export function selectPushableBlockers(center: ActionCenter): BlockerItem[] {
  if (center.available !== true) return [];
  return center.items.filter(
    (item) =>
      PUSHED_BLOCKER_TYPES.has(item.blockerType) &&
      item.accountKind === "customer" &&
      (item.blockerType !== "publish_failure" || item.dataQuality === "exact"),
  );
}

// ── audit row shape (subset actually read/written) ───────────────────────

export interface AuditRow {
  action: string;
  target_id: string | null;
  created_at: string;
  metadata?: Record<string, unknown> | null;
}

/** Minimal DB surface this module needs beyond SupabaseLikeDb (which has no insert). */
export interface AuditTableRef extends TableRef {
  insert(row: Record<string, unknown>): PromiseLike<{ error: PgError }>;
}

export interface AlertsDb extends SupabaseLikeDb {
  from(table: string): AuditTableRef;
}

async function writeAuditRow(
  db: AlertsDb,
  action: typeof AUDIT_ACTION_NOTIFIED | typeof AUDIT_ACTION_CLEARED,
  targetId: string,
  metadata: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const { error } = await db.from("admin_audit_events").insert({
      actor_id: null,
      actor_email: null,
      actor_role: "system",
      action,
      target_type: AUDIT_TARGET_TYPE,
      target_id: targetId,
      metadata,
    });
    if (error) return { ok: false, error: error.message ?? error.code ?? "unknown error" };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ── evidence summary (for both audit metadata and the email body) ─────────

function evidenceSummary(item: BlockerItem): string {
  const ev = item.evidence;
  switch (item.blockerType) {
    case "publish_failure":
      return ev.publishErrorMessage
        ? `${ev.failedPublishCount ?? 1} failed publish attempt(s) — ${ev.publishErrorMessage}`
        : `${ev.failedPublishCount ?? 1} failed publish attempt(s)`;
    case "pinterest_disconnected":
      return ev.disconnectReason === "needs_reconnect" ? "Needs reconnect" : "Disconnected";
    case "generation_failures":
      return ev.generationErrorMessage
        ? `${ev.failedGenerationCount ?? 2} failed generation(s) — ${ev.generationErrorMessage}`
        : `${ev.failedGenerationCount ?? 2} failed generation(s)`;
    default:
      return "";
  }
}

// ── email assembly (pure) ──────────────────────────────────────────────────

export interface AlertEmailContent {
  subject: string;
  text: string;
  html: string;
}

const ADMIN_USER_BASE_URL = "https://vibepin.co/admin/users";

/**
 * Build the one summary email for a run's newly-notified blockers. Pure
 * function — no I/O, no dedupe logic, so it is trivial to unit test against a
 * fixed BlockerItem[] and to prove every field is HTML-escaped.
 */
export function buildAlertEmail(items: readonly BlockerItem[]): AlertEmailContent {
  const count = items.length;
  const subject = `[VibePin] ${count} 位客户被卡住`;

  const textLines = items.map((item) => {
    const label = HUMAN_LABELS[item.blockerType];
    const action = SUGGESTED_ACTIONS[item.blockerType];
    const link = `${ADMIN_USER_BASE_URL}/${item.userId}`;
    return [
      `- ${item.email ?? "(no email on file)"} — ${label}`,
      `  First seen: ${item.firstSeenAt ?? "unknown"}`,
      `  ${evidenceSummary(item)}`,
      action ? `  Suggested action: ${action}` : null,
      `  ${link}`,
    ]
      .filter(Boolean)
      .join("\n");
  });
  const text = `${count} customer(s) are blocked right now:\n\n${textLines.join("\n\n")}\n`;

  const htmlItems = items
    .map((item) => {
      const label = HUMAN_LABELS[item.blockerType];
      const action = SUGGESTED_ACTIONS[item.blockerType];
      const link = `${ADMIN_USER_BASE_URL}/${item.userId}`;
      const emailDisplay = escapeHtml(item.email ?? "(no email on file)");
      const evidence = escapeHtml(evidenceSummary(item));
      const firstSeen = escapeHtml(item.firstSeenAt ?? "unknown");
      return `
      <li>
        <strong>${emailDisplay}</strong> — ${escapeHtml(label)}<br/>
        First seen: ${firstSeen}<br/>
        ${evidence}<br/>
        ${action ? `Suggested action: ${escapeHtml(action)}<br/>` : ""}
        <a href="${escapeHtml(link)}">${escapeHtml(link)}</a>
      </li>`;
    })
    .join("\n");
  const html = `<p>${count} customer(s) are blocked right now:</p><ul>${htmlItems}</ul>`;

  return { subject, text, html };
}

// ── recipient resolution (PRD §6 待裁决 1: prefer ALERT_EMAIL_TO) ─────────

export function resolveAlertRecipient(env: NodeJS.ProcessEnv = process.env): { to: string | null; reason?: string } {
  const direct = (env.ALERT_EMAIL_TO ?? "").trim();
  if (direct) return { to: direct };
  const superAdmins = (env.SUPER_ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
  if (superAdmins.length > 0) return { to: superAdmins[0] };
  return { to: null, reason: "no_recipient_configured: neither ALERT_EMAIL_TO nor SUPER_ADMIN_EMAILS is set" };
}

// ── run result / orchestration ─────────────────────────────────────────────

export interface AdminAlertsRunResult {
  available: boolean;
  scanned: number;
  newlyNotified: number;
  cleared: number;
  stillOpen: number;
  email: { sent: boolean; skipped: boolean; failed: boolean; reason?: string; errorSummary?: string };
  warnings: string[];
}

export interface RunAdminAlertsOptions {
  /** Injected action center (tests). Defaults to a fresh getActionCenter() call. */
  center?: ActionCenter;
  /** Injected audit-table db. Defaults to the real service-role client. */
  db?: AlertsDb;
  env?: NodeJS.ProcessEnv;
}

export async function runAdminAlerts(options: RunAdminAlertsOptions = {}): Promise<AdminAlertsRunResult> {
  const warnings: string[] = [];
  const env = options.env ?? process.env;

  const center = options.center ?? (await getActionCenter());
  if (center.available !== true) {
    return {
      available: false,
      scanned: 0,
      newlyNotified: 0,
      cleared: 0,
      stillOpen: 0,
      email: { sent: false, skipped: true, failed: false, reason: "action_center_unavailable" },
      warnings: [...warnings, ...center.warnings],
    };
  }

  const resolvedDb: AlertsDb =
    options.db ?? ((await (await import("./adminQueryUtils")).createAdminDb()) as unknown as AlertsDb);

  const pushable = selectPushableBlockers(center);
  const nowKeys = new Set(pushable.map((item) => blockerKey(item.userId, item.blockerType)));

  // Need dedupe state for both the currently-pushable set AND any previously
  // notified keys that might have disappeared (to write blocker_cleared). We
  // don't know the previously-notified set without reading first, so read
  // broadly: all NOTIFIED/CLEARED rows scoped to keys we can see right now is
  // not enough to find "disappeared" keys. Read unscoped (bounded by table
  // size/window) instead — see loadAllDedupeState below.
  const { notifiedKeys, available: dedupeAvailable } = await loadAllDedupeState(resolvedDb, warnings);

  const newlyNotifiedItems: BlockerItem[] = [];
  let stillOpen = 0;
  for (const item of pushable) {
    const key = blockerKey(item.userId, item.blockerType);
    if (notifiedKeys.has(key)) {
      stillOpen += 1;
    } else {
      newlyNotifiedItems.push(item);
    }
  }

  const disappearedKeys = dedupeAvailable
    ? Array.from(notifiedKeys).filter((key) => !nowKeys.has(key))
    : [];

  // Write blocker_cleared rows first (order doesn't affect correctness, but
  // keeps a clean read-then-two-writes shape).
  let cleared = 0;
  for (const key of disappearedKeys) {
    const result = await writeAuditRow(resolvedDb, AUDIT_ACTION_CLEARED, key, { at: new Date().toISOString() });
    if (result.ok) cleared += 1;
    else warnings.push(`Failed to write blocker_cleared for ${key}: ${result.error}`);
  }

  // Write blocker_notified rows for genuinely new blockers, regardless of
  // email outcome below — the row is what makes dedupe idempotent, not the
  // send.
  let newlyNotified = 0;
  for (const item of newlyNotifiedItems) {
    const key = blockerKey(item.userId, item.blockerType);
    const result = await writeAuditRow(resolvedDb, AUDIT_ACTION_NOTIFIED, key, {
      firstSeenAt: item.firstSeenAt,
      evidence: evidenceSummary(item),
      dataQuality: item.dataQuality,
    });
    if (result.ok) newlyNotified += 1;
    else warnings.push(`Failed to write blocker_notified for ${key}: ${result.error}`);
  }

  const emailResult = await sendSummaryIfAny(newlyNotifiedItems, resolvedDb, env, warnings);

  return {
    available: true,
    scanned: pushable.length,
    newlyNotified,
    cleared,
    stillOpen,
    email: emailResult,
    warnings,
  };
}

/**
 * Unscoped latest-per-key scan of admin_audit_events restricted to our two
 * action values — needed to detect "was notified, now gone" without already
 * knowing the key. Bounded by a lookback window (PAGE_SIZE-ish) so it never
 * grows unbounded; a key whose last write falls outside the window degrades
 * to "not notified" (a rare duplicate send is the safe failure direction, not
 * a silent miss).
 */
const DEDUPE_LOOKBACK_ROWS = 5000;

async function loadAllDedupeState(
  db: AlertsDb,
  warnings: string[],
): Promise<{ notifiedKeys: Set<string>; available: boolean }> {
  try {
    const { data, error } = await db
      .from("admin_audit_events")
      .select<AuditRow>("action, target_id, created_at")
      .eq("target_type", AUDIT_TARGET_TYPE)
      .in("action", [AUDIT_ACTION_NOTIFIED, AUDIT_ACTION_CLEARED])
      .order("created_at", { ascending: true })
      .limit(DEDUPE_LOOKBACK_ROWS);
    if (error) {
      warnings.push(`Dedupe state unavailable — admin_audit_events read failed: ${error.message ?? error.code ?? "unknown error"}`);
      return { notifiedKeys: new Set(), available: false };
    }
    const latestActionByKey = new Map<string, string>();
    for (const row of data ?? []) {
      if (!row.target_id) continue;
      latestActionByKey.set(row.target_id, row.action); // ascending order ⇒ last write wins
    }
    const notifiedKeys = new Set<string>();
    for (const [key, action] of latestActionByKey) {
      if (action === AUDIT_ACTION_NOTIFIED) notifiedKeys.add(key);
    }
    return { notifiedKeys, available: true };
  } catch (e) {
    warnings.push(`Dedupe state unavailable — admin_audit_events read threw: ${e instanceof Error ? e.message : String(e)}`);
    return { notifiedKeys: new Set(), available: false };
  }
}

async function sendSummaryIfAny(
  newlyNotifiedItems: readonly BlockerItem[],
  db: AlertsDb,
  env: NodeJS.ProcessEnv,
  warnings: string[],
): Promise<AdminAlertsRunResult["email"]> {
  if (newlyNotifiedItems.length === 0) {
    return { sent: false, skipped: true, failed: false, reason: "no_new_blockers" };
  }
  const recipient = resolveAlertRecipient(env);
  if (!recipient.to) {
    warnings.push(recipient.reason ?? "no_recipient_configured");
    return { sent: false, skipped: true, failed: false, reason: recipient.reason };
  }

  const { subject, text, html } = buildAlertEmail(newlyNotifiedItems);

  try {
    const result = await sendEmail({ to: recipient.to, subject, text, html });
    if (!result.ok) {
      await writeAuditRow(db, AUDIT_ACTION_NOTIFIED, "__email_failure__", {
        at: new Date().toISOString(),
        errorSummary: result.errorSummary ?? "sendEmail returned ok:false",
        note: "email send failed; blocker_notified rows for this run were already written and are not retried",
      }).catch(() => undefined);
      return { sent: false, skipped: !!result.skipped, failed: true, errorSummary: result.errorSummary };
    }
    if (result.skipped) {
      return { sent: false, skipped: true, failed: false, reason: "email_provider_not_configured" };
    }
    return { sent: true, skipped: false, failed: false };
  } catch (e) {
    const errorSummary = e instanceof Error ? e.message.slice(0, 300) : "Unknown error";
    await writeAuditRow(db, AUDIT_ACTION_NOTIFIED, "__email_failure__", {
      at: new Date().toISOString(),
      errorSummary,
      note: "sendEmail threw; blocker_notified rows for this run were already written and are not retried",
    }).catch(() => undefined);
    warnings.push(`sendEmail threw: ${errorSummary}`);
    return { sent: false, skipped: false, failed: true, errorSummary };
  }
}
