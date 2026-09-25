/**
 * Instagram comment keyword → private reply (DM): orchestration (server-only).
 *
 * One run over one connection:
 *   1. scope gate  — the stored grant must include INSTAGRAM_COMMENT_DM_SCOPES;
 *   2. token       — via the injected getter (production: getInstagramAccessToken);
 *   3. reclaim     — `claimed` rows untouched for CLAIM_STALE_MS are retried (Meta
 *                    accepts only one private reply per comment, so a retry after
 *                    an unknown outcome cannot double-send);
 *   4. scan        — rule media + (if any all-posts rule) the recent media, newest
 *                    comments first, stopping at the oldest instant any rule can use;
 *   5. claim       — INSERT … ON CONFLICT (connection_id, comment_id) DO NOTHING
 *                    RETURNING. No row back → another run owns it → skip. This unique
 *                    constraint is THE idempotency guarantee; nothing else is trusted;
 *   6. send        — private reply, then (only if it succeeded and the rule asks) the
 *                    public reply, whose failure never changes the DM status.
 *
 * dryRun: steps 3, 5 and 6 are skipped entirely — nothing is written, nothing sent;
 * the would-send list is returned.
 *
 * The database client and the token getter are injected so the whole flow can be
 * exercised against a fake (scripts/test-instagram-comment-dm.ts) and so the claim
 * can be proven against the real unique constraint on the test project.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { hasInstagramCommentDmScopes } from "./config";
import {
  CLAIM_STALE_MS,
  MAX_SEND_ATTEMPTS,
  classifyMetaError,
  commentTimeMs,
  evaluateComment,
  isWithinReplyWindow,
  scanCutoffMs,
  trimErrorMessage,
  type CommentDmRule,
  type InstagramComment,
  type MetaErrorKind,
} from "./commentDmLogic";
import {
  MetaGraphError,
  listMediaComments,
  listRecentMedia,
  replyToComment,
  sendPrivateReply,
} from "./commentDm";

export const RULES_TABLE = "instagram_comment_dm_rules";
export const EVENTS_TABLE = "instagram_comment_dm_events";

/** Per-connection cap on private-reply attempts in one run. */
export const MAX_SENDS_PER_CONNECTION = 40;
/** Reclaim at most this many stale claims per connection per run. */
const RECLAIM_BATCH = 20;
/** Handled comment ids are preloaded for this far back (> the 7-day reply window). */
const HANDLED_LOOKBACK_MS = 8 * 24 * 60 * 60 * 1000;

export type CommentDmConnection = {
  id: string;
  user_id: string;
  provider_account_id: string | null;
  provider_account_username: string | null;
  scopes: string[] | null;
  connection_status: string | null;
};

export type CommentDmDeps = {
  db: SupabaseClient;
  getToken: (userId: string, connectionId: string) => Promise<{ accessToken: string } | null>;
  now?: () => number;
};

export type WouldSend = {
  commentId: string;
  mediaId: string;
  username: string | null;
  text: string | null;
  timestamp: string | null;
  ruleId: string;
  keyword: string;
};

export type ConnectionOutcome =
  | "ok"
  | "missing_scopes"
  | "no_token"
  | "token_invalid"
  | "rate_limited"
  | "error"
  | "deadline"
  | "send_cap";

export type ConnectionRunResult = {
  connectionId: string;
  username: string | null;
  outcome: ConnectionOutcome;
  message: string | null;
  mediaScanned: number;
  commentsSeen: number;
  matches: WouldSend[];
  sent: number;
  failed: number;
  retryLater: number;
  skipped: number;
  reclaimed: number;
  lostClaims: number;
  mediaErrors: Array<{ mediaId: string; message: string }>;
};

export type RunOptions = {
  dryRun: boolean;
  /** Absolute epoch ms; the run stops cleanly (no new media / sends) past it. */
  deadlineAt: number;
  maxSends?: number;
};

type EventRow = {
  id: string;
  connection_id: string;
  rule_id: string | null;
  comment_id: string;
  media_id: string | null;
  comment_timestamp: string | null;
  status: string;
  attempts: number;
  updated_at: string;
};

export function ruleFromRow(row: Record<string, unknown>): CommentDmRule {
  return {
    id: String(row.id),
    connectionId: String(row.connection_id),
    mediaId: typeof row.media_id === "string" && row.media_id ? row.media_id : null,
    keywords: Array.isArray(row.keywords) ? row.keywords.map(k => String(k)) : [],
    dmText: typeof row.dm_text === "string" ? row.dm_text : "",
    publicReplyEnabled: row.public_reply_enabled === true,
    publicReplyText: typeof row.public_reply_text === "string" ? row.public_reply_text : null,
    startAfter: typeof row.start_after === "string" ? row.start_after : new Date(0).toISOString(),
    enabled: row.enabled === true,
    createdAt: typeof row.created_at === "string" ? row.created_at : new Date(0).toISOString(),
  };
}

function toMetaError(err: unknown): MetaGraphError {
  if (err instanceof MetaGraphError) return err;
  return new MetaGraphError((err as Error)?.message ?? "Unknown error", 0);
}

function kindOf(err: MetaGraphError): MetaErrorKind {
  return classifyMetaError({
    httpStatus: err.httpStatus,
    code: err.code,
    subcode: err.subcode,
    isTransient: err.isTransient,
    message: err.message,
  });
}

/**
 * Claim one comment: INSERT … ON CONFLICT (connection_id, comment_id) DO NOTHING
 * RETURNING id. Returns the new row id, or null when the comment is already owned
 * (by an earlier run or a concurrent one). Throws on a real database error.
 */
export async function claimCommentEvent(
  db: SupabaseClient,
  row: {
    connection_id: string;
    rule_id: string;
    comment_id: string;
    media_id: string | null;
    commenter_id: string | null;
    commenter_username: string | null;
    comment_text: string | null;
    comment_timestamp: string | null;
  },
  nowIso: string,
): Promise<string | null> {
  const { data, error } = await db
    .from(EVENTS_TABLE)
    .upsert(
      { ...row, status: "claimed", attempts: 1, created_at: nowIso, updated_at: nowIso },
      { onConflict: "connection_id,comment_id", ignoreDuplicates: true },
    )
    .select("id");
  if (error) throw new Error(`claim failed: ${error.message}`);
  const rows = (data as Array<{ id: string }> | null) ?? [];
  return rows[0]?.id ?? null;
}

function emptyResult(conn: CommentDmConnection): ConnectionRunResult {
  return {
    connectionId: conn.id,
    username: conn.provider_account_username,
    outcome: "ok",
    message: null,
    mediaScanned: 0,
    commentsSeen: 0,
    matches: [],
    sent: 0,
    failed: 0,
    retryLater: 0,
    skipped: 0,
    reclaimed: 0,
    lostClaims: 0,
    mediaErrors: [],
  };
}

type DeliverVerdict = "sent" | "failed" | "retry" | "stop_token" | "stop_rate";

/**
 * Send the private reply for an already-claimed event row and record the result.
 * The caller owns the claim; this never claims.
 */
async function deliver(
  db: SupabaseClient,
  ctx: { igUserId: string; token: string; nowIso: () => string },
  event: { id: string; attempts: number; commentId: string },
  rule: CommentDmRule,
): Promise<{ verdict: DeliverVerdict; message: string | null }> {
  try {
    await sendPrivateReply(ctx.igUserId, event.commentId, rule.dmText, ctx.token);
  } catch (raw) {
    const err = toMetaError(raw);
    const kind = kindOf(err);
    const message = trimErrorMessage(err.message);
    if (kind === "terminal") {
      await db
        .from(EVENTS_TABLE)
        .update({ status: "failed", last_error: message, updated_at: ctx.nowIso() })
        .eq("id", event.id);
      return { verdict: "failed", message };
    }
    if (event.attempts >= MAX_SEND_ATTEMPTS) {
      const final = trimErrorMessage(`Gave up after ${event.attempts} attempts: ${message}`);
      await db
        .from(EVENTS_TABLE)
        .update({ status: "failed", last_error: final, updated_at: ctx.nowIso() })
        .eq("id", event.id);
      return { verdict: "failed", message: final };
    }
    // Stay `claimed`; updated_at = now → reclaimed after CLAIM_STALE_MS.
    await db
      .from(EVENTS_TABLE)
      .update({ last_error: message, updated_at: ctx.nowIso() })
      .eq("id", event.id);
    if (kind === "token_invalid") return { verdict: "stop_token", message };
    if (kind === "rate_limited") return { verdict: "stop_rate", message };
    return { verdict: "retry", message };
  }

  const sentAt = ctx.nowIso();
  await db
    .from(EVENTS_TABLE)
    .update({ status: "sent", sent_at: sentAt, last_error: null, updated_at: sentAt })
    .eq("id", event.id);

  const publicText = rule.publicReplyText?.trim();
  if (rule.publicReplyEnabled && publicText) {
    let publicStatus = "sent";
    try {
      await replyToComment(event.commentId, publicText, ctx.token);
    } catch (raw) {
      publicStatus = trimErrorMessage(`failed: ${toMetaError(raw).message}`, 300);
    }
    // Recorded separately; a public-reply failure never touches the DM status.
    await db
      .from(EVENTS_TABLE)
      .update({ public_reply_status: publicStatus, updated_at: ctx.nowIso() })
      .eq("id", event.id);
  }
  return { verdict: "sent", message: null };
}

/**
 * Run the automation for ONE connection. `rules` must already be the rules to apply
 * (the cron passes enabled rules; Preview passes the rules it wants to test, marked
 * enabled). Never throws for Meta/database failures — they land in the result.
 */
export async function runCommentDmForConnection(
  deps: CommentDmDeps,
  conn: CommentDmConnection,
  rules: readonly CommentDmRule[],
  opts: RunOptions,
): Promise<ConnectionRunResult> {
  const { db } = deps;
  const now = deps.now ?? Date.now;
  const nowIso = () => new Date(now()).toISOString();
  const maxSends = opts.maxSends ?? MAX_SENDS_PER_CONNECTION;
  const result = emptyResult(conn);
  const activeRules = rules.filter(r => r.enabled && r.connectionId === conn.id);
  const rulesById = new Map(activeRules.map(r => [r.id, r]));

  if (!hasInstagramCommentDmScopes(conn.scopes)) {
    result.outcome = "missing_scopes";
    result.message = "Connection was not granted the comment/DM permissions — reconnect with features=comment_dm.";
    return result;
  }
  const igUserId = conn.provider_account_id;
  const tokenInfo = igUserId ? await deps.getToken(conn.user_id, conn.id) : null;
  if (!igUserId || !tokenInfo?.accessToken) {
    result.outcome = "no_token";
    result.message = "No usable Instagram token for this connection (disconnected or expired) — reconnect.";
    return result;
  }
  const token = tokenInfo.accessToken;
  const ctx = { igUserId, token, nowIso };
  let attemptsThisRun = 0;

  const stopFor = (verdict: DeliverVerdict, message: string | null): boolean => {
    if (verdict === "stop_token") {
      result.outcome = "token_invalid";
      result.message = message;
      return true;
    }
    if (verdict === "stop_rate") {
      result.outcome = "rate_limited";
      result.message = message;
      return true;
    }
    return false;
  };
  const tally = (verdict: DeliverVerdict) => {
    if (verdict === "sent") result.sent++;
    else if (verdict === "failed") result.failed++;
    else result.retryLater++;
  };

  // ── 3. Reclaim stale claims (never in dry run) ─────────────────────────────
  if (!opts.dryRun) {
    const cutoff = new Date(now() - CLAIM_STALE_MS).toISOString();
    const { data: stale, error: staleErr } = await db
      .from(EVENTS_TABLE)
      .select("id, connection_id, rule_id, comment_id, media_id, comment_timestamp, status, attempts, updated_at")
      .eq("connection_id", conn.id)
      .eq("status", "claimed")
      .lt("updated_at", cutoff)
      .order("updated_at", { ascending: true })
      .limit(RECLAIM_BATCH);
    if (staleErr) {
      result.outcome = "error";
      result.message = trimErrorMessage(`Could not read stale claims: ${staleErr.message}`);
      return result;
    }
    for (const row of (stale as EventRow[] | null) ?? []) {
      if (now() > opts.deadlineAt) {
        result.outcome = "deadline";
        return result;
      }
      if (attemptsThisRun >= maxSends) {
        result.outcome = "send_cap";
        return result;
      }
      const nextAttempts = (row.attempts ?? 0) + 1;
      // Conditional takeover: only the run whose UPDATE still sees a stale claim wins.
      const { data: taken, error: takeErr } = await db
        .from(EVENTS_TABLE)
        .update({ attempts: nextAttempts, updated_at: nowIso() })
        .eq("id", row.id)
        .eq("status", "claimed")
        .lt("updated_at", cutoff)
        .select("id");
      if (takeErr || !((taken as unknown[] | null) ?? []).length) continue;
      result.reclaimed++;

      const rule = row.rule_id ? rulesById.get(row.rule_id) : undefined;
      if (!rule) {
        await db
          .from(EVENTS_TABLE)
          .update({ status: "skipped", last_error: "Rule was removed or disabled before the reply was sent", updated_at: nowIso() })
          .eq("id", row.id);
        result.skipped++;
        continue;
      }
      const commentMs = commentTimeMs(row.comment_timestamp);
      if (commentMs === null || !isWithinReplyWindow(commentMs, now())) {
        await db
          .from(EVENTS_TABLE)
          .update({ status: "failed", last_error: "Private-reply window (7 days) has passed", updated_at: nowIso() })
          .eq("id", row.id);
        result.failed++;
        continue;
      }
      attemptsThisRun++;
      const { verdict, message } = await deliver(db, ctx, { id: row.id, attempts: nextAttempts, commentId: row.comment_id }, rule);
      tally(verdict);
      if (stopFor(verdict, message)) return result;
    }
  }

  if (!activeRules.length) return result;

  // ── Preload handled comment ids (optimisation only; the claim is the gate) ──
  const handled = new Set<string>();
  {
    const since = new Date(now() - HANDLED_LOOKBACK_MS).toISOString();
    const { data, error } = await db
      .from(EVENTS_TABLE)
      .select("comment_id")
      .eq("connection_id", conn.id)
      .gte("created_at", since)
      .limit(5000);
    if (error) {
      result.outcome = "error";
      result.message = trimErrorMessage(`Could not read handled comments: ${error.message}`);
      return result;
    }
    for (const r of (data as Array<{ comment_id: string }> | null) ?? []) handled.add(r.comment_id);
  }

  // ── 4. Media to scan ──────────────────────────────────────────────────────
  const mediaIds: string[] = [];
  for (const r of activeRules) if (r.mediaId && !mediaIds.includes(r.mediaId)) mediaIds.push(r.mediaId);
  if (activeRules.some(r => !r.mediaId)) {
    try {
      for (const m of await listRecentMedia(igUserId, token, now())) {
        if (!mediaIds.includes(m.id)) mediaIds.push(m.id);
      }
    } catch (raw) {
      const err = toMetaError(raw);
      const kind = kindOf(err);
      result.outcome = kind === "token_invalid" ? "token_invalid" : kind === "rate_limited" ? "rate_limited" : "error";
      result.message = trimErrorMessage(err.message);
      return result;
    }
  }

  const account = { igUserId, username: conn.provider_account_username };
  const stopBeforeMs = scanCutoffMs(activeRules, now());

  for (const mediaId of mediaIds) {
    if (now() > opts.deadlineAt) {
      result.outcome = "deadline";
      return result;
    }
    let comments: InstagramComment[];
    try {
      comments = await listMediaComments(mediaId, token, { stopBeforeMs });
    } catch (raw) {
      const err = toMetaError(raw);
      const kind = kindOf(err);
      if (kind === "token_invalid" || kind === "rate_limited") {
        result.outcome = kind;
        result.message = trimErrorMessage(err.message);
        return result;
      }
      result.mediaErrors.push({ mediaId, message: trimErrorMessage(err.message, 200) });
      continue;
    }
    result.mediaScanned++;
    result.commentsSeen += comments.length;

    for (const comment of comments) {
      const verdict = evaluateComment(comment, activeRules, { account, nowMs: now(), handledCommentIds: handled });
      if (!verdict.eligible) continue;

      if (opts.dryRun) {
        result.matches.push({
          commentId: comment.id,
          mediaId: comment.mediaId,
          username: comment.username,
          text: comment.text,
          timestamp: comment.timestamp,
          ruleId: verdict.rule.id,
          keyword: verdict.keyword,
        });
        handled.add(comment.id);
        continue;
      }

      if (now() > opts.deadlineAt) {
        result.outcome = "deadline";
        return result;
      }
      if (attemptsThisRun >= maxSends) {
        result.outcome = "send_cap";
        return result;
      }

      // ── 5. Claim — the only gate against a double send ──────────────────
      let eventId: string | null;
      try {
        eventId = await claimCommentEvent(
          db,
          {
            connection_id: conn.id,
            rule_id: verdict.rule.id,
            comment_id: comment.id,
            media_id: comment.mediaId,
            commenter_id: comment.fromId,
            commenter_username: comment.username,
            comment_text: comment.text,
            comment_timestamp: comment.timestamp,
          },
          nowIso(),
        );
      } catch (claimErr) {
        result.outcome = "error";
        result.message = trimErrorMessage((claimErr as Error).message);
        return result;
      }
      handled.add(comment.id);
      if (!eventId) {
        result.lostClaims++;
        continue;
      }

      // ── 6. Send ─────────────────────────────────────────────────────────
      attemptsThisRun++;
      const sent = await deliver(db, ctx, { id: eventId, attempts: 1, commentId: comment.id }, verdict.rule);
      tally(sent.verdict);
      if (stopFor(sent.verdict, sent.message)) return result;
    }
  }
  return result;
}

/** Record the connection's last run on its rules (surfaced on the admin page). */
export async function recordConnectionRun(
  db: SupabaseClient,
  result: ConnectionRunResult,
  nowIso: string,
): Promise<void> {
  const status = result.outcome;
  const error =
    status === "ok" || status === "deadline" || status === "send_cap"
      ? result.failed > 0
        ? `${result.failed} failed this run`
        : null
      : result.message;
  const { error: dbErr } = await db
    .from(RULES_TABLE)
    .update({ last_run_at: nowIso, last_run_status: status, last_run_error: error })
    .eq("connection_id", result.connectionId);
  if (dbErr) console.error("[instagram-comment-dm] record run failed:", dbErr.message);
}

export type CronRunSummary = {
  dryRun: boolean;
  connections: ConnectionRunResult[];
  skippedForDeadline: number;
};

/** Every connection with ≥1 enabled rule, processed sequentially under one deadline. */
export async function runCommentDmCron(deps: CommentDmDeps, opts: RunOptions): Promise<CronRunSummary> {
  const { db } = deps;
  const now = deps.now ?? Date.now;
  const summary: CronRunSummary = { dryRun: opts.dryRun, connections: [], skippedForDeadline: 0 };

  const { data: ruleRows, error: rulesErr } = await db.from(RULES_TABLE).select("*").eq("enabled", true);
  if (rulesErr) throw new Error(`Could not read rules: ${rulesErr.message}`);
  const rows = (ruleRows as Array<Record<string, unknown>> | null) ?? [];
  if (!rows.length) return summary;

  const connectionIds = [...new Set(rows.map(r => String(r.connection_id)))];
  const { data: connRows, error: connErr } = await db
    .from("social_connections")
    .select("id, user_id, provider_account_id, provider_account_username, scopes, connection_status")
    .eq("provider", "instagram")
    .in("id", connectionIds);
  if (connErr) throw new Error(`Could not read connections: ${connErr.message}`);

  for (const conn of (connRows as CommentDmConnection[] | null) ?? []) {
    if (now() > opts.deadlineAt) {
      summary.skippedForDeadline++;
      continue;
    }
    // A rule only ever acts on its owner's own connection.
    const rules = rows
      .filter(r => String(r.connection_id) === conn.id && String(r.user_id) === conn.user_id)
      .map(ruleFromRow);
    if (!rules.length) continue;
    let result: ConnectionRunResult;
    try {
      result = await runCommentDmForConnection(deps, conn, rules, opts);
    } catch (err) {
      result = { ...emptyResult(conn), outcome: "error", message: trimErrorMessage((err as Error).message) };
    }
    summary.connections.push(result);
    if (!opts.dryRun) await recordConnectionRun(db, result, new Date(now()).toISOString());
  }
  return summary;
}
