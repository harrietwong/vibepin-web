/**
 * Instagram comment keyword → private reply (DM): PURE decision logic.
 *
 * No env, no network, no database — everything here is deterministic so it can be
 * unit-tested directly (scripts/test-instagram-comment-dm.ts). The Graph calls live
 * in commentDm.ts and the orchestration (claim → send → record) in commentDmRun.ts.
 */

/** Meta: a private reply must be sent within 7 days of the comment. */
export const PRIVATE_REPLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** We stop 1 hour short of Meta's limit so a slow run never lands a late send. */
export const PRIVATE_REPLY_SAFETY_MARGIN_MS = 60 * 60 * 1000;
/** A `claimed` row untouched for this long is considered abandoned and reclaimed. */
export const CLAIM_STALE_MS = 15 * 60 * 1000;
/** Retryable failures (rate limit / 5xx / network) give up after this many attempts. */
export const MAX_SEND_ATTEMPTS = 5;
/** last_error is trimmed to this many characters. */
export const ERROR_MESSAGE_MAX = 500;

export type CommentDmRule = {
  id: string;
  connectionId: string;
  /** null = every post of the account. */
  mediaId: string | null;
  keywords: string[];
  dmText: string;
  publicReplyEnabled: boolean;
  publicReplyText: string | null;
  /** ISO timestamp — only comments at/after this instant are eligible. */
  startAfter: string;
  enabled: boolean;
  /** ISO timestamp — tie-breaker (oldest rule wins). */
  createdAt: string;
};

export type InstagramComment = {
  id: string;
  mediaId: string;
  text: string | null;
  /** ISO timestamp from Meta, e.g. 2017-08-31T19:16:02+0000. */
  timestamp: string | null;
  /** from.id — the commenter's Instagram-scoped id. */
  fromId: string | null;
  /** username (falls back to from.username). */
  username: string | null;
  /** parent_id — set when this is a reply to another comment (never DM'd). */
  parentId?: string | null;
};

export type CommentAccount = {
  /** The connected account's IG user id (social_connections.provider_account_id). */
  igUserId: string;
  /** The connected account's @username (without @), if known. */
  username: string | null;
};

// ── Keyword matching ──────────────────────────────────────────────────────────

/** NFKC + lower-case + trim. NFKC folds full-width forms (ＰＲＩＣＥ → PRICE). */
export function normalizeForMatch(value: string): string {
  return value.normalize("NFKC").toLowerCase().trim();
}

/** Keywords that survive normalization (blank entries never match everything). */
export function normalizeKeywords(keywords: readonly string[]): string[] {
  const out: string[] = [];
  for (const k of keywords) {
    const n = normalizeForMatch(String(k ?? ""));
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
}

/** The first keyword (normalized) contained in the comment text, or null. */
export function matchKeyword(text: string | null | undefined, keywords: readonly string[]): string | null {
  if (!text) return null;
  const haystack = normalizeForMatch(text);
  if (!haystack) return null;
  for (const k of normalizeKeywords(keywords)) {
    if (haystack.includes(k)) return k;
  }
  return null;
}

// ── Eligibility ───────────────────────────────────────────────────────────────

function parseTs(value: string | null | undefined): number | null {
  if (!value) return null;
  // Meta returns +0000 (no colon); Date.parse handles it in V8, but normalize anyway.
  const iso = /[+-]\d{4}$/.test(value) ? `${value.slice(0, -2)}:${value.slice(-2)}` : value;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** Epoch ms of a Meta/ISO timestamp, or null when missing/unparseable. */
export function commentTimeMs(value: string | null | undefined): number | null {
  return parseTs(value);
}

/** True when the comment was written by the connected account itself. */
export function isOwnComment(comment: InstagramComment, account: CommentAccount): boolean {
  if (comment.fromId && comment.fromId === account.igUserId) return true;
  const mine = account.username?.replace(/^@/, "").trim().toLowerCase();
  const theirs = comment.username?.replace(/^@/, "").trim().toLowerCase();
  return Boolean(mine && theirs && mine === theirs);
}

/** Still inside Meta's 7-day private-reply window, minus our 1-hour safety margin. */
export function isWithinReplyWindow(commentMs: number, nowMs: number): boolean {
  return nowMs - commentMs <= PRIVATE_REPLY_WINDOW_MS - PRIVATE_REPLY_SAFETY_MARGIN_MS;
}

/** Oldest comment instant any enabled rule could still act on (pagination stop point). */
export function scanCutoffMs(rules: readonly CommentDmRule[], nowMs: number): number {
  const windowStart = nowMs - (PRIVATE_REPLY_WINDOW_MS - PRIVATE_REPLY_SAFETY_MARGIN_MS);
  const starts = rules
    .filter(r => r.enabled)
    .map(r => parseTs(r.startAfter))
    .filter((v): v is number => v !== null);
  if (!starts.length) return windowStart;
  return Math.max(windowStart, Math.min(...starts));
}

/**
 * Pick the rule for a comment, or null.
 *
 * Candidates: enabled, on this media (or all-posts), comment at/after start_after,
 * and a keyword hit. Order: a media-specific rule beats an all-posts rule; then the
 * OLDEST rule (created_at) wins; id breaks exact ties so the choice is stable.
 */
export function selectRule(
  comment: InstagramComment,
  rules: readonly CommentDmRule[],
): { rule: CommentDmRule; keyword: string } | null {
  const commentMs = parseTs(comment.timestamp);
  if (commentMs === null) return null;
  const hits: Array<{ rule: CommentDmRule; keyword: string }> = [];
  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (rule.mediaId && rule.mediaId !== comment.mediaId) continue;
    const startMs = parseTs(rule.startAfter);
    if (startMs === null || commentMs < startMs) continue;
    const keyword = matchKeyword(comment.text, rule.keywords);
    if (!keyword) continue;
    hits.push({ rule, keyword });
  }
  hits.sort((a, b) => {
    const aSpecific = a.rule.mediaId ? 0 : 1;
    const bSpecific = b.rule.mediaId ? 0 : 1;
    if (aSpecific !== bSpecific) return aSpecific - bSpecific;
    const aCreated = parseTs(a.rule.createdAt) ?? 0;
    const bCreated = parseTs(b.rule.createdAt) ?? 0;
    if (aCreated !== bCreated) return aCreated - bCreated;
    return a.rule.id < b.rule.id ? -1 : a.rule.id > b.rule.id ? 1 : 0;
  });
  return hits[0] ?? null;
}

export type CommentVerdict =
  | { eligible: true; rule: CommentDmRule; keyword: string }
  | {
      eligible: false;
      reason: "already_handled" | "reply" | "own_comment" | "no_timestamp" | "outside_window" | "no_match";
    };

/**
 * Full eligibility check for one comment. `handledCommentIds` is an optimisation
 * (events already recorded); the UNIQUE(connection_id, comment_id) claim is still
 * the real guarantee against double sends.
 */
export function evaluateComment(
  comment: InstagramComment,
  rules: readonly CommentDmRule[],
  ctx: { account: CommentAccount; nowMs: number; handledCommentIds?: ReadonlySet<string> },
): CommentVerdict {
  if (ctx.handledCommentIds?.has(comment.id)) return { eligible: false, reason: "already_handled" };
  // Only top-level comments qualify; a row that explicitly names a parent is a reply.
  if (comment.parentId) return { eligible: false, reason: "reply" };
  if (isOwnComment(comment, ctx.account)) return { eligible: false, reason: "own_comment" };
  const commentMs = parseTs(comment.timestamp);
  if (commentMs === null) return { eligible: false, reason: "no_timestamp" };
  if (!isWithinReplyWindow(commentMs, ctx.nowMs)) return { eligible: false, reason: "outside_window" };
  const hit = selectRule(comment, rules);
  if (!hit) return { eligible: false, reason: "no_match" };
  return { eligible: true, rule: hit.rule, keyword: hit.keyword };
}

// ── Error classification ─────────────────────────────────────────────────────

export type MetaErrorInput = {
  /** HTTP status; 0 = the request never got a response (network / timeout). */
  httpStatus: number;
  code?: number | null;
  subcode?: number | null;
  isTransient?: boolean | null;
  message?: string | null;
};

export type MetaErrorKind =
  /** OAuthException 190 — the token is dead. Stop this connection; reconnect needed. */
  | "token_invalid"
  /** Graph throttling (4 / 17 / 32 / 613, or HTTP 429). Stop this connection for this run. */
  | "rate_limited"
  /** 5xx, network, or Meta flagged it transient. Leave the claim; retry later. */
  | "retryable"
  /** Any other 4xx. Final — record Meta's message. */
  | "terminal";

/**
 * Graph API throttling codes (Graph API error-handling guide): 4 app-level, 17
 * user-level, 32 page-level, 613 custom rate limit. NOTE: Instagram's own error
 * table also documents code 4 / subcode 2207051 as a spam restriction on
 * publishing; it is still treated as throttling here (retried, bounded by
 * MAX_SEND_ATTEMPTS) rather than inventing a subcode rule we haven't observed.
 */
export const RATE_LIMIT_CODES: ReadonlySet<number> = new Set([4, 17, 32, 613]);

export function classifyMetaError(err: MetaErrorInput): MetaErrorKind {
  if (err.code === 190) return "token_invalid";
  if (typeof err.code === "number" && RATE_LIMIT_CODES.has(err.code)) return "rate_limited";
  if (err.httpStatus === 429) return "rate_limited";
  if (!err.httpStatus || err.httpStatus >= 500) return "retryable";
  if (err.isTransient === true) return "retryable";
  return "terminal";
}

export function trimErrorMessage(message: string | null | undefined, max = ERROR_MESSAGE_MAX): string {
  const clean = String(message ?? "").replace(/\s+/g, " ").trim() || "Unknown error";
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

// ── Rule input validation (admin API) ────────────────────────────────────────

export const MAX_KEYWORDS = 20;
export const MAX_KEYWORD_LENGTH = 100;
export const MAX_DM_TEXT_LENGTH = 1000;
export const MAX_PUBLIC_REPLY_LENGTH = 1000;

export type RuleInput = {
  mediaId: string | null;
  keywords: string[];
  dmText: string;
  publicReplyEnabled: boolean;
  publicReplyText: string | null;
  startAfter: string;
  enabled: boolean;
};

/**
 * Validate a rule body from the admin page. `partial` (PATCH) validates only the
 * fields present; otherwise every field is required except the optional ones,
 * and `enabled` defaults to FALSE (new rules start disabled).
 */
export function parseRuleInput(
  body: unknown,
  opts: { partial: boolean },
): { ok: true; value: Partial<RuleInput> } | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "Body must be a JSON object" };
  const b = body as Record<string, unknown>;
  const out: Partial<RuleInput> = {};
  const has = (k: string) => Object.prototype.hasOwnProperty.call(b, k);

  if (has("mediaId") || !opts.partial) {
    const m = b.mediaId;
    if (m === null || m === undefined || (typeof m === "string" && !m.trim())) out.mediaId = null;
    else if (typeof m === "string" && /^[0-9A-Za-z_-]{1,64}$/.test(m.trim())) out.mediaId = m.trim();
    else return { ok: false, error: "mediaId must be a media id or empty" };
  }
  if (has("keywords") || !opts.partial) {
    const raw = b.keywords;
    const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[,，\n]/) : null;
    if (!list) return { ok: false, error: "keywords must be a list" };
    const keywords: string[] = [];
    for (const k of list) {
      const t = String(k ?? "").trim();
      if (!t) continue;
      if (t.length > MAX_KEYWORD_LENGTH) return { ok: false, error: `Each keyword must be ≤ ${MAX_KEYWORD_LENGTH} characters` };
      if (!normalizeForMatch(t)) continue;
      if (!keywords.some(x => normalizeForMatch(x) === normalizeForMatch(t))) keywords.push(t);
    }
    if (!keywords.length) return { ok: false, error: "At least one keyword is required" };
    if (keywords.length > MAX_KEYWORDS) return { ok: false, error: `At most ${MAX_KEYWORDS} keywords` };
    out.keywords = keywords;
  }
  if (has("dmText") || !opts.partial) {
    const t = typeof b.dmText === "string" ? b.dmText.trim() : "";
    if (!t) return { ok: false, error: "DM text is required" };
    if (t.length > MAX_DM_TEXT_LENGTH) return { ok: false, error: `DM text must be ≤ ${MAX_DM_TEXT_LENGTH} characters` };
    out.dmText = t;
  }
  if (has("publicReplyText") || !opts.partial) {
    const t = typeof b.publicReplyText === "string" ? b.publicReplyText.trim() : "";
    if (t.length > MAX_PUBLIC_REPLY_LENGTH) {
      return { ok: false, error: `Public reply must be ≤ ${MAX_PUBLIC_REPLY_LENGTH} characters` };
    }
    out.publicReplyText = t || null;
  }
  if (has("publicReplyEnabled") || !opts.partial) {
    out.publicReplyEnabled = b.publicReplyEnabled === true;
  }
  if (out.publicReplyEnabled && !out.publicReplyText && (!opts.partial || has("publicReplyText"))) {
    return { ok: false, error: "Public reply text is required when public reply is on" };
  }
  if (has("startAfter") || !opts.partial) {
    const ms = typeof b.startAfter === "string" ? Date.parse(b.startAfter) : NaN;
    if (!Number.isFinite(ms)) return { ok: false, error: "startAfter must be a date/time" };
    out.startAfter = new Date(ms).toISOString();
  }
  if (has("enabled")) out.enabled = b.enabled === true;
  else if (!opts.partial) out.enabled = false;
  return { ok: true, value: out };
}
