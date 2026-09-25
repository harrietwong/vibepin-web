/**
 * Instagram comment → DM: data access for the super-admin page (server-only).
 *
 * EVERY function is scoped to the caller's OWN user id: phase 1 automates only the
 * site owner's own Instagram account, so a super admin sees and edits only their
 * own connections, rules and events — never another merchant's.
 */

import { createServerClient } from "@/lib/supabase";
import { hasInstagramCommentDmScopes } from "./config";
import { EVENTS_TABLE, RULES_TABLE, ruleFromRow, type CommentDmConnection } from "./commentDmRun";
import type { CommentDmRule, RuleInput } from "./commentDmLogic";

function db() {
  return createServerClient();
}

export type AdminConnectionView = {
  id: string;
  username: string | null;
  name: string | null;
  connectionStatus: string | null;
  hasCommentDmScopes: boolean;
  scopes: string[];
};

export type AdminRuleView = CommentDmRule & {
  lastRunAt: string | null;
  lastRunStatus: string | null;
  lastRunError: string | null;
  updatedAt: string | null;
};

export type AdminEventView = {
  id: string;
  connectionId: string;
  ruleId: string | null;
  commentId: string;
  mediaId: string | null;
  commenterUsername: string | null;
  commentText: string | null;
  commentTimestamp: string | null;
  status: string;
  attempts: number;
  lastError: string | null;
  publicReplyStatus: string | null;
  sentAt: string | null;
  createdAt: string;
};

type ConnRow = CommentDmConnection & { provider_account_name: string | null };

/** The caller's own Instagram connection rows (full, for the runner). */
export async function listOwnInstagramConnections(userId: string): Promise<ConnRow[]> {
  const { data, error } = await db()
    .from("social_connections")
    .select("id, user_id, provider_account_id, provider_account_username, provider_account_name, scopes, connection_status")
    .eq("user_id", userId)
    .eq("provider", "instagram")
    .order("created_at", { ascending: true });
  if (error) throw new Error(`Could not read Instagram connections: ${error.message}`);
  return (data as ConnRow[] | null) ?? [];
}

export function toConnectionView(row: ConnRow): AdminConnectionView {
  const scopes = Array.isArray(row.scopes) ? row.scopes : [];
  return {
    id: row.id,
    username: row.provider_account_username,
    name: row.provider_account_name,
    connectionStatus: row.connection_status,
    hasCommentDmScopes: hasInstagramCommentDmScopes(scopes),
    scopes,
  };
}

/** One of the caller's own connections, or null (foreign / missing id). */
export async function getOwnInstagramConnection(userId: string, connectionId: string): Promise<ConnRow | null> {
  if (!/^[0-9a-fA-F-]{16,64}$/.test(connectionId)) return null;
  const rows = await listOwnInstagramConnections(userId);
  return rows.find(r => r.id === connectionId) ?? null;
}

function toRuleView(row: Record<string, unknown>): AdminRuleView {
  return {
    ...ruleFromRow(row),
    lastRunAt: typeof row.last_run_at === "string" ? row.last_run_at : null,
    lastRunStatus: typeof row.last_run_status === "string" ? row.last_run_status : null,
    lastRunError: typeof row.last_run_error === "string" ? row.last_run_error : null,
    updatedAt: typeof row.updated_at === "string" ? row.updated_at : null,
  };
}

export async function listOwnRules(userId: string): Promise<AdminRuleView[]> {
  const { data, error } = await db()
    .from(RULES_TABLE)
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`Could not read rules: ${error.message}`);
  return ((data as Array<Record<string, unknown>> | null) ?? []).map(toRuleView);
}

export async function getOwnRule(userId: string, ruleId: string): Promise<AdminRuleView | null> {
  if (!/^[0-9a-fA-F-]{16,64}$/.test(ruleId)) return null;
  const { data, error } = await db()
    .from(RULES_TABLE)
    .select("*")
    .eq("user_id", userId)
    .eq("id", ruleId)
    .limit(1);
  if (error) throw new Error(`Could not read rule: ${error.message}`);
  const row = ((data as Array<Record<string, unknown>> | null) ?? [])[0];
  return row ? toRuleView(row) : null;
}

function toRow(input: Partial<RuleInput>): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  if ("mediaId" in input) row.media_id = input.mediaId;
  if ("keywords" in input) row.keywords = input.keywords;
  if ("dmText" in input) row.dm_text = input.dmText;
  if ("publicReplyEnabled" in input) row.public_reply_enabled = input.publicReplyEnabled;
  if ("publicReplyText" in input) row.public_reply_text = input.publicReplyText;
  if ("startAfter" in input) row.start_after = input.startAfter;
  if ("enabled" in input) row.enabled = input.enabled;
  return row;
}

export async function createOwnRule(
  userId: string,
  connectionId: string,
  input: RuleInput,
): Promise<AdminRuleView> {
  const now = new Date().toISOString();
  const { data, error } = await db()
    .from(RULES_TABLE)
    .insert({ ...toRow(input), user_id: userId, connection_id: connectionId, created_at: now, updated_at: now })
    .select("*");
  if (error) throw new Error(`Could not create rule: ${error.message}`);
  return toRuleView(((data as Array<Record<string, unknown>>) ?? [])[0]);
}

export async function updateOwnRule(
  userId: string,
  ruleId: string,
  input: Partial<RuleInput>,
): Promise<AdminRuleView | null> {
  const { data, error } = await db()
    .from(RULES_TABLE)
    .update({ ...toRow(input), updated_at: new Date().toISOString() })
    .eq("user_id", userId)
    .eq("id", ruleId)
    .select("*");
  if (error) throw new Error(`Could not update rule: ${error.message}`);
  const row = ((data as Array<Record<string, unknown>> | null) ?? [])[0];
  return row ? toRuleView(row) : null;
}

export async function deleteOwnRule(userId: string, ruleId: string): Promise<boolean> {
  const { data, error } = await db()
    .from(RULES_TABLE)
    .delete()
    .eq("user_id", userId)
    .eq("id", ruleId)
    .select("id");
  if (error) throw new Error(`Could not delete rule: ${error.message}`);
  return ((data as unknown[] | null) ?? []).length > 0;
}

export async function listRecentEvents(connectionIds: string[], limit = 100): Promise<AdminEventView[]> {
  if (!connectionIds.length) return [];
  const { data, error } = await db()
    .from(EVENTS_TABLE)
    .select("*")
    .in("connection_id", connectionIds)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`Could not read events: ${error.message}`);
  return ((data as Array<Record<string, unknown>> | null) ?? []).map(r => ({
    id: String(r.id),
    connectionId: String(r.connection_id),
    ruleId: typeof r.rule_id === "string" ? r.rule_id : null,
    commentId: String(r.comment_id),
    mediaId: typeof r.media_id === "string" ? r.media_id : null,
    commenterUsername: typeof r.commenter_username === "string" ? r.commenter_username : null,
    commentText: typeof r.comment_text === "string" ? r.comment_text : null,
    commentTimestamp: typeof r.comment_timestamp === "string" ? r.comment_timestamp : null,
    status: String(r.status),
    attempts: typeof r.attempts === "number" ? r.attempts : 0,
    lastError: typeof r.last_error === "string" ? r.last_error : null,
    publicReplyStatus: typeof r.public_reply_status === "string" ? r.public_reply_status : null,
    sentAt: typeof r.sent_at === "string" ? r.sent_at : null,
    createdAt: String(r.created_at),
  }));
}
