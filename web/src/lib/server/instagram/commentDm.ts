/**
 * Instagram comment keyword → private reply (DM): Graph API calls (server-only).
 *
 * Endpoints (Instagram API with Instagram Login, host graph.instagram.com):
 *   GET  /<IG_USER_ID>/media?fields=id,timestamp,permalink,caption
 *   GET  /<IG_MEDIA_ID>/comments?fields=id,text,timestamp,from,username,parent_id
 *        — top-level comments only, reverse-chronological, ≤50 per page, no
 *          timestamp filter (so we stop paging once a page is older than needed).
 *   POST /<IG_USER_ID>/messages   {"recipient":{"comment_id"},"message":{"text"}}
 *        — the private reply. One per comment, within 7 days.
 *   POST /<IG_COMMENT_ID>/replies {"message"} — optional public reply.
 *
 * Every failure is raised as MetaGraphError carrying Meta's numeric code so
 * commentDmLogic.classifyMetaError can decide stop / retry / final. The access
 * token never appears in an error message or a log line.
 */

import { INSTAGRAM_GRAPH_URL } from "./config";
import type { InstagramComment } from "./commentDmLogic";

export class MetaGraphError extends Error {
  /** 0 = no HTTP response (network failure / timeout). */
  httpStatus: number;
  code: number | null;
  subcode: number | null;
  isTransient: boolean | null;
  constructor(
    message: string,
    httpStatus: number,
    code: number | null = null,
    subcode: number | null = null,
    isTransient: boolean | null = null,
  ) {
    super(message);
    this.name = "MetaGraphError";
    this.httpStatus = httpStatus;
    this.code = code;
    this.subcode = subcode;
    this.isTransient = isTransient;
  }
}

const REQUEST_TIMEOUT_MS = 15_000;

function scrub(message: string, token: string): string {
  return token ? message.split(token).join("[redacted]") : message;
}

type GraphErrorBody = {
  error?: {
    message?: unknown;
    code?: unknown;
    error_subcode?: unknown;
    is_transient?: unknown;
  };
};

async function graphRequest<T>(url: string, init: RequestInit, token: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (err) {
    throw new MetaGraphError(scrub(`Network error calling Instagram: ${(err as Error).message}`, token), 0);
  }
  const json = (await res.json().catch(() => ({}))) as T & GraphErrorBody;
  if (!res.ok || json?.error) {
    const e = json?.error ?? {};
    const message = typeof e.message === "string" && e.message ? e.message : `Instagram request failed (${res.status})`;
    throw new MetaGraphError(
      scrub(message, token),
      res.ok ? 400 : res.status,
      typeof e.code === "number" ? e.code : null,
      typeof e.error_subcode === "number" ? e.error_subcode : null,
      typeof e.is_transient === "boolean" ? e.is_transient : null,
    );
  }
  return json;
}

function graphGet<T>(path: string, params: Record<string, string>, token: string): Promise<T> {
  const qs = new URLSearchParams({ ...params, access_token: token });
  return graphRequest<T>(`${INSTAGRAM_GRAPH_URL}/${path}?${qs.toString()}`, { method: "GET" }, token);
}

function graphPostJson<T>(path: string, body: unknown, token: string): Promise<T> {
  return graphRequest<T>(
    `${INSTAGRAM_GRAPH_URL}/${path}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    },
    token,
  );
}

// ── Media ─────────────────────────────────────────────────────────────────────

export type CommentDmMedia = {
  id: string;
  timestamp: string | null;
  permalink: string | null;
  caption: string | null;
  /** Meta's comments_count; null when the field was missing / not a number. */
  commentsCount: number | null;
};

export const RECENT_MEDIA_LIMIT = 50;
export const RECENT_MEDIA_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** The account's most recent media: at most 50, and none older than 30 days. */
export async function listRecentMedia(
  igUserId: string,
  token: string,
  nowMs: number = Date.now(),
): Promise<CommentDmMedia[]> {
  const json = await graphGet<{ data?: Array<Record<string, unknown>> }>(
    `${encodeURIComponent(igUserId)}/media`,
    { fields: "id,timestamp,permalink,caption,comments_count", limit: String(RECENT_MEDIA_LIMIT) },
    token,
  );
  const oldest = nowMs - RECENT_MEDIA_MAX_AGE_MS;
  return (Array.isArray(json.data) ? json.data : [])
    .filter(m => typeof m.id === "string" && m.id)
    .map(m => ({
      id: m.id as string,
      timestamp: typeof m.timestamp === "string" ? m.timestamp : null,
      permalink: typeof m.permalink === "string" ? m.permalink : null,
      caption: typeof m.caption === "string" ? m.caption : null,
      commentsCount: typeof m.comments_count === "number" && Number.isFinite(m.comments_count) ? m.comments_count : null,
    }))
    .filter(m => {
      const t = m.timestamp ? Date.parse(m.timestamp.replace(/([+-]\d{2})(\d{2})$/, "$1:$2")) : NaN;
      return !Number.isFinite(t) || t >= oldest;
    })
    .slice(0, RECENT_MEDIA_LIMIT);
}

// ── Comments ─────────────────────────────────────────────────────────────────

export const COMMENTS_PAGE_SIZE = 50;
export const COMMENTS_MAX_PAGES = 4;

function toComment(mediaId: string, raw: Record<string, unknown>): InstagramComment | null {
  if (typeof raw.id !== "string" || !raw.id) return null;
  const from = raw.from && typeof raw.from === "object" ? (raw.from as Record<string, unknown>) : null;
  const fromId = from && (typeof from.id === "string" || typeof from.id === "number") ? String(from.id) : null;
  const username =
    typeof raw.username === "string" && raw.username
      ? raw.username
      : from && typeof from.username === "string" && from.username
        ? from.username
        : null;
  return {
    id: raw.id,
    mediaId,
    text: typeof raw.text === "string" ? raw.text : null,
    timestamp: typeof raw.timestamp === "string" ? raw.timestamp : null,
    fromId,
    username,
    parentId:
      (typeof raw.parent_id === "string" && raw.parent_id) || typeof raw.parent_id === "number"
        ? String(raw.parent_id)
        : null,
  };
}

/**
 * Top-level comments on one media, newest first. Pages until a page's oldest
 * comment is before `stopBeforeMs` (Meta returns newest first and cannot filter by
 * time) or `maxPages` pages have been read.
 */
export async function listMediaComments(
  mediaId: string,
  token: string,
  opts: {
    stopBeforeMs: number;
    maxPages?: number;
    /** Checked before every page after the first; true → stop paging, return what we have. */
    isPastDeadline?: () => boolean;
  },
): Promise<InstagramComment[]> {
  const maxPages = Math.max(1, opts.maxPages ?? COMMENTS_MAX_PAGES);
  const out: InstagramComment[] = [];
  let after: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    if (page > 0 && opts.isPastDeadline?.()) break;
    const params: Record<string, string> = {
      fields: "id,text,timestamp,from,username,parent_id",
      limit: String(COMMENTS_PAGE_SIZE),
    };
    if (after) params.after = after;
    const json: {
      data?: Array<Record<string, unknown>>;
      paging?: { cursors?: { after?: unknown }; next?: unknown };
    } = await graphGet(`${encodeURIComponent(mediaId)}/comments`, params, token);
    const rows = Array.isArray(json.data) ? json.data : [];
    let oldestOnPage = Infinity;
    for (const raw of rows) {
      const c = toComment(mediaId, raw);
      if (!c) continue;
      out.push(c);
      const t = c.timestamp ? Date.parse(c.timestamp.replace(/([+-]\d{2})(\d{2})$/, "$1:$2")) : NaN;
      if (Number.isFinite(t)) oldestOnPage = Math.min(oldestOnPage, t);
    }
    const cursor = json.paging?.cursors?.after;
    const hasNext = typeof json.paging?.next === "string" && typeof cursor === "string" && cursor;
    if (!hasNext || rows.length === 0 || oldestOnPage < opts.stopBeforeMs) break;
    after = cursor as string;
  }
  return out;
}

// ── Replies ──────────────────────────────────────────────────────────────────

/** Send the one allowed private reply (DM) to the author of `commentId`. */
export async function sendPrivateReply(
  igUserId: string,
  commentId: string,
  text: string,
  token: string,
): Promise<{ messageId: string | null; recipientId: string | null }> {
  const json = await graphPostJson<{ message_id?: unknown; recipient_id?: unknown }>(
    `${encodeURIComponent(igUserId)}/messages`,
    { recipient: { comment_id: commentId }, message: { text } },
    token,
  );
  return {
    messageId: typeof json.message_id === "string" ? json.message_id : null,
    recipientId: typeof json.recipient_id === "string" ? json.recipient_id : null,
  };
}

/** Public reply under the comment (POST /<comment-id>/replies, `message`). */
export async function replyToComment(
  commentId: string,
  text: string,
  token: string,
): Promise<{ id: string | null }> {
  const json = await graphPostJson<{ id?: unknown }>(
    `${encodeURIComponent(commentId)}/replies`,
    { message: text },
    token,
  );
  return { id: typeof json.id === "string" ? json.id : null };
}
