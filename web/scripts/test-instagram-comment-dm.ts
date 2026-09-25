/**
 * Instagram comment keyword → private reply (DM) unit tests.
 * Run: npx tsx scripts/test-instagram-comment-dm.ts
 *
 * No network, no database: globalThis.fetch is mocked and the Supabase client is an
 * in-memory fake that ENFORCES UNIQUE(connection_id, comment_id) exactly like the
 * v83 table, so the "two overlapping polling runs" case exercises the real claim
 * code path (upsert … ignoreDuplicates → INSERT … ON CONFLICT DO NOTHING RETURNING).
 * The same claim is proven against the real constraint on the TEST project by
 * scripts/test-instagram-comment-dm-claim-live.ts.
 *
 * Covers:
 *   - default authorize URL byte-for-byte unchanged; opt-in scopes appended only on request
 *   - scope detection
 *   - keyword match (NFKC / case / trim / blanks)
 *   - eligibility (own comment, start_after, 7d − 1h window, already handled)
 *   - rule selection (media-specific first, then oldest)
 *   - Meta error classification
 *   - rule input validation (new rules default disabled)
 *   - runner: overlapping runs → one DM; dry run writes/sends nothing; token 190 stops;
 *     terminal 4xx stored; rate limit keeps claim; public-reply failure never flips DM;
 *     stale-claim reclaim; missing scopes; send cap
 */

import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  buildAuthorizeUrl,
  hasInstagramCommentDmScopes,
  INSTAGRAM_COMMENT_DM_SCOPES,
} from "../src/lib/server/instagram/config";
import {
  classifyMetaError,
  evaluateComment,
  matchKeyword,
  parseRuleInput,
  selectRule,
  trimErrorMessage,
  type CommentDmRule,
  type InstagramComment,
} from "../src/lib/server/instagram/commentDmLogic";
import {
  runCommentDmForConnection,
  type CommentDmConnection,
} from "../src/lib/server/instagram/commentDmRun";

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${name}\n       ${(err as Error).stack ?? err}`);
  }
}

// ── Fixtures ────────────────────────────────────────────────────────────────

const NOW = Date.parse("2026-09-24T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const iso = (ms: number) => new Date(ms).toISOString();
/** Meta's timestamp shape: +0000, no colon, no millis. */
const metaTs = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "+0000");

const IG_USER = "17841400000000001";
const CONN_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";

function rule(over: Partial<CommentDmRule> = {}): CommentDmRule {
  return {
    id: "r-1",
    connectionId: CONN_ID,
    mediaId: null,
    keywords: ["price"],
    dmText: "Here is the link!",
    publicReplyEnabled: false,
    publicReplyText: null,
    startAfter: iso(NOW - 7 * DAY),
    enabled: true,
    createdAt: iso(NOW - 10 * DAY),
    ...over,
  };
}

function comment(over: Partial<InstagramComment> = {}): InstagramComment {
  return {
    id: "c-1",
    mediaId: "m-1",
    text: "What's the PRICE?",
    timestamp: metaTs(NOW - HOUR),
    fromId: "900",
    username: "shopper",
    ...over,
  };
}

const account = { igUserId: IG_USER, username: "myshop" };

// ── In-memory Supabase fake (only what commentDmRun uses) ───────────────────

type Row = Record<string, unknown>;

class FakeDb {
  tables: Record<string, Row[]> = { instagram_comment_dm_events: [], instagram_comment_dm_rules: [] };
  writes = 0;
  private seq = 0;
  from(table: string) {
    return new Query(this, table);
  }
  nextId() {
    this.seq++;
    return `00000000-0000-4000-8000-${String(this.seq).padStart(12, "0")}`;
  }
}

class Query implements PromiseLike<{ data: unknown; error: null | { message: string } }> {
  private filters: Array<(r: Row) => boolean> = [];
  private op: "select" | "update" | "upsert" | "insert" | "delete" = "select";
  private payload: Row | null = null;
  private returning = false;
  private ignoreDuplicates = false;
  private conflictCols: string[] = [];
  private orderBy: { col: string; asc: boolean } | null = null;
  private max: number | null = null;
  constructor(private db: FakeDb, private table: string) {}

  select(_cols?: string) {
    if (this.op !== "select") this.returning = true;
    return this;
  }
  eq(col: string, v: unknown) { this.filters.push(r => r[col] === v); return this; }
  lt(col: string, v: string) { this.filters.push(r => String(r[col]) < v); return this; }
  gte(col: string, v: string) { this.filters.push(r => String(r[col]) >= v); return this; }
  in(col: string, vs: unknown[]) { this.filters.push(r => vs.includes(r[col])); return this; }
  order(col: string, o?: { ascending?: boolean }) { this.orderBy = { col, asc: o?.ascending !== false }; return this; }
  limit(n: number) { this.max = n; return this; }
  update(p: Row) { this.op = "update"; this.payload = p; return this; }
  insert(p: Row) { this.op = "insert"; this.payload = p; return this; }
  delete() { this.op = "delete"; return this; }
  upsert(p: Row, o: { onConflict: string; ignoreDuplicates?: boolean }) {
    this.op = "upsert";
    this.payload = p;
    this.conflictCols = o.onConflict.split(",").map(s => s.trim());
    this.ignoreDuplicates = o.ignoreDuplicates === true;
    return this;
  }

  then<A, B>(
    onOk?: ((v: { data: unknown; error: null | { message: string } }) => A | PromiseLike<A>) | null,
    onErr?: ((e: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    // Yield to the event loop first so concurrent runs genuinely interleave.
    return new Promise<{ data: unknown; error: null | { message: string } }>(resolve => {
      setTimeout(() => resolve(this.execute()), 0);
    }).then(onOk, onErr);
  }

  private execute(): { data: unknown; error: null | { message: string } } {
    const rows = (this.db.tables[this.table] ??= []);
    const match = (r: Row) => this.filters.every(f => f(r));
    if (this.op === "select") {
      let out = rows.filter(match);
      if (this.orderBy) {
        const { col, asc } = this.orderBy;
        out = [...out].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : 1) * (asc ? 1 : -1));
      }
      if (this.max !== null) out = out.slice(0, this.max);
      return { data: out.map(r => ({ ...r })), error: null };
    }
    this.db.writes++;
    if (this.op === "upsert" || this.op === "insert") {
      const p = this.payload!;
      const dup = this.conflictCols.length
        ? rows.find(r => this.conflictCols.every(c => r[c] === p[c]))
        : undefined;
      if (dup) {
        if (this.ignoreDuplicates) return { data: this.returning ? [] : null, error: null };
        return { data: null, error: { message: "duplicate key value violates unique constraint" } };
      }
      const row = { id: this.db.nextId(), last_error: null, public_reply_status: null, sent_at: null, ...p };
      rows.push(row);
      return { data: this.returning ? [{ ...row }] : null, error: null };
    }
    if (this.op === "update") {
      const hit = rows.filter(match);
      for (const r of hit) Object.assign(r, this.payload);
      return { data: this.returning ? hit.map(r => ({ ...r })) : null, error: null };
    }
    const keep = rows.filter(r => !match(r));
    const gone = rows.filter(match);
    this.db.tables[this.table] = keep;
    return { data: this.returning ? gone : null, error: null };
  }
}

// ── Fetch mock ──────────────────────────────────────────────────────────────

type SendBehaviour = { status: number; body: unknown } | null;

function installFetch(opts: {
  media: Array<{ id: string; timestamp: string; comments_count?: unknown }>;
  comments: Record<string, Array<Record<string, unknown>>>;
  sendResult?: (commentId: string, n: number) => SendBehaviour;
  replyResult?: () => SendBehaviour;
}) {
  const calls = {
    messages: [] as Array<{ commentId: string; text: string }>,
    replies: 0,
    gets: 0,
    commentMedia: [] as string[],
    mediaUrls: [] as string[],
  };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    assert.ok(url.startsWith("https://graph.instagram.com/v25.0/"), `unexpected host: ${url}`);
    const method = init?.method ?? "GET";
    await new Promise(r => setTimeout(r, 1));
    if (method === "GET" && url.includes(`/${IG_USER}/media?`)) {
      calls.gets++;
      calls.mediaUrls.push(url);
      return Response.json({ data: opts.media });
    }
    const cm = url.match(/\/v25\.0\/([^/?]+)\/comments\?/);
    if (method === "GET" && cm) {
      calls.gets++;
      calls.commentMedia.push(decodeURIComponent(cm[1]));
      return Response.json({ data: opts.comments[decodeURIComponent(cm[1])] ?? [] });
    }
    if (method === "POST" && url.endsWith(`/${IG_USER}/messages`)) {
      const body = JSON.parse(String(init?.body));
      calls.messages.push({ commentId: body.recipient.comment_id, text: body.message.text });
      const r = opts.sendResult?.(body.recipient.comment_id, calls.messages.length) ?? null;
      if (r) return Response.json(r.body, { status: r.status });
      return Response.json({ recipient_id: "526", message_id: `mid-${calls.messages.length}` });
    }
    if (method === "POST" && /\/replies$/.test(url)) {
      calls.replies++;
      const r = opts.replyResult?.() ?? null;
      if (r) return Response.json(r.body, { status: r.status });
      return Response.json({ id: "reply-1" });
    }
    throw new Error(`unmocked request ${method} ${url}`);
  }) as typeof fetch;
  return calls;
}

const conn: CommentDmConnection = {
  id: CONN_ID,
  user_id: USER_ID,
  provider_account_id: IG_USER,
  provider_account_username: "myshop",
  scopes: ["instagram_business_basic", "instagram_business_content_publish", ...INSTAGRAM_COMMENT_DM_SCOPES],
  connection_status: "connected",
};

function deps(db: FakeDb) {
  return {
    db: db as unknown as SupabaseClient,
    getToken: async () => ({ accessToken: "secret-token" }),
    now: () => NOW,
  };
}
const liveOpts = { dryRun: false, deadlineAt: NOW + 60_000 };

const rawComment = (id: string, text: string, over: Record<string, unknown> = {}) => ({
  id,
  text,
  timestamp: metaTs(NOW - HOUR),
  from: { id: `u-${id}`, username: `user_${id}` },
  username: `user_${id}`,
  ...over,
});

// ── Tests ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const originalFetch = globalThis.fetch;
  console.log("instagram comment → DM");

  await test("default authorize URL is byte-for-byte the pre-change URL", () => {
    const env = { appId: "APPID", appSecret: "s", redirectUri: "https://vibepin.co/api/auth/instagram/callback" };
    const expected =
      "https://www.instagram.com/oauth/authorize?client_id=APPID" +
      "&redirect_uri=https%3A%2F%2Fvibepin.co%2Fapi%2Fauth%2Finstagram%2Fcallback" +
      "&response_type=code&scope=instagram_business_basic%2Cinstagram_business_content_publish&state=ST4TE";
    assert.equal(buildAuthorizeUrl(env, "ST4TE"), expected);
    assert.equal(buildAuthorizeUrl(env, "ST4TE", []), expected);
  });

  await test("comment_dm scopes are appended only when requested", () => {
    const env = { appId: "APPID", appSecret: "s", redirectUri: "https://x/cb" };
    const url = new URL(buildAuthorizeUrl(env, "S", INSTAGRAM_COMMENT_DM_SCOPES));
    assert.equal(
      url.searchParams.get("scope"),
      "instagram_business_basic,instagram_business_content_publish,instagram_business_manage_comments,instagram_business_manage_messages",
    );
    // A base scope passed as "extra" is not duplicated.
    const dup = new URL(buildAuthorizeUrl(env, "S", ["instagram_business_basic"]));
    assert.equal(dup.searchParams.get("scope"), "instagram_business_basic,instagram_business_content_publish");
  });

  await test("hasInstagramCommentDmScopes needs both scopes", () => {
    assert.equal(hasInstagramCommentDmScopes(["instagram_business_basic", "instagram_business_content_publish"]), false);
    assert.equal(hasInstagramCommentDmScopes(["instagram_business_manage_comments"]), false);
    assert.equal(hasInstagramCommentDmScopes([...INSTAGRAM_COMMENT_DM_SCOPES]), true);
    assert.equal(hasInstagramCommentDmScopes(null), false);
  });

  await test("keyword match: NFKC, case-insensitive, trimmed substring, any keyword", () => {
    assert.equal(matchKeyword("What's the PRICE?", ["price"]), "price");
    assert.equal(matchKeyword("ＰＲＩＣＥ please", [" Price "]), "price"); // full-width → NFKC
    assert.equal(matchKeyword("send me the LINK", ["price", "link"]), "link");
    assert.equal(matchKeyword("多少钱？", ["多少钱"]), "多少钱");
    assert.equal(matchKeyword("nice pic", ["price", "link"]), null);
    assert.equal(matchKeyword("anything", ["", "   "]), null); // blanks never match everything
    assert.equal(matchKeyword(null, ["price"]), null);
  });

  await test("eligibility: own comment (by id or username) is skipped", () => {
    const rules = [rule()];
    const ctx = { account, nowMs: NOW };
    assert.deepEqual(evaluateComment(comment({ fromId: IG_USER }), rules, ctx), { eligible: false, reason: "own_comment" });
    assert.deepEqual(evaluateComment(comment({ fromId: null, username: "MyShop" }), rules, ctx), { eligible: false, reason: "own_comment" });
    assert.equal(evaluateComment(comment(), rules, ctx).eligible, true);
  });

  await test("eligibility: start_after, 7d − 1h window, already handled", () => {
    const ctx = { account, nowMs: NOW };
    // Before start_after → no rule matches.
    const late = [rule({ startAfter: iso(NOW - 30 * 60 * 1000) })];
    assert.deepEqual(evaluateComment(comment(), late, ctx), { eligible: false, reason: "no_match" });
    // Exactly at start_after → eligible.
    const at = [rule({ startAfter: iso(NOW - HOUR) })];
    assert.equal(evaluateComment(comment(), at, ctx).eligible, true);
    // 6d 22h old → inside; 6d 23h 30m → outside (7d minus the 1h margin).
    const wide = [rule({ startAfter: iso(NOW - 30 * DAY) })];
    assert.equal(evaluateComment(comment({ timestamp: metaTs(NOW - 6 * DAY - 22 * HOUR) }), wide, ctx).eligible, true);
    assert.deepEqual(
      evaluateComment(comment({ timestamp: metaTs(NOW - 6 * DAY - 23.5 * HOUR) }), wide, ctx),
      { eligible: false, reason: "outside_window" },
    );
    assert.deepEqual(
      evaluateComment(comment(), wide, { ...ctx, handledCommentIds: new Set(["c-1"]) }),
      { eligible: false, reason: "already_handled" },
    );
    assert.deepEqual(evaluateComment(comment({ timestamp: null }), wide, ctx), { eligible: false, reason: "no_timestamp" });
  });

  await test("rule selection: media-specific first, then oldest; disabled ignored", () => {
    const all = rule({ id: "all-old", createdAt: iso(NOW - 20 * DAY) });
    const specificNew = rule({ id: "spec-new", mediaId: "m-1", createdAt: iso(NOW - 1 * DAY) });
    const specificOld = rule({ id: "spec-old", mediaId: "m-1", createdAt: iso(NOW - 2 * DAY) });
    const otherMedia = rule({ id: "other", mediaId: "m-2", createdAt: iso(NOW - 30 * DAY) });
    const disabled = rule({ id: "off", mediaId: "m-1", enabled: false, createdAt: iso(NOW - 40 * DAY) });
    assert.equal(selectRule(comment(), [all, specificNew, specificOld, otherMedia, disabled])?.rule.id, "spec-old");
    assert.equal(selectRule(comment(), [all, otherMedia])?.rule.id, "all-old");
    const allNew = rule({ id: "all-new", createdAt: iso(NOW - DAY) });
    assert.equal(selectRule(comment(), [allNew, all])?.rule.id, "all-old");
    // A media-specific rule whose keyword doesn't hit does not shadow an all-posts hit.
    const specMiss = rule({ id: "spec-miss", mediaId: "m-1", keywords: ["link"] });
    assert.equal(selectRule(comment(), [specMiss, all])?.rule.id, "all-old");
  });

  await test("error classification", () => {
    assert.equal(classifyMetaError({ httpStatus: 400, code: 190 }), "token_invalid");
    for (const code of [4, 17, 32, 613]) assert.equal(classifyMetaError({ httpStatus: 400, code }), "rate_limited");
    assert.equal(classifyMetaError({ httpStatus: 429 }), "rate_limited");
    assert.equal(classifyMetaError({ httpStatus: 500, code: 2 }), "retryable");
    assert.equal(classifyMetaError({ httpStatus: 503 }), "retryable");
    assert.equal(classifyMetaError({ httpStatus: 0 }), "retryable"); // network
    assert.equal(classifyMetaError({ httpStatus: 400, code: 1, isTransient: true }), "retryable");
    assert.equal(classifyMetaError({ httpStatus: 400, code: 10 }), "terminal");
    assert.equal(classifyMetaError({ httpStatus: 400, code: 100 }), "terminal");
    assert.equal(classifyMetaError({ httpStatus: 403 }), "terminal");
    const long = trimErrorMessage("x".repeat(2000));
    assert.equal(long.length, 500);
  });

  await test("rule input: new rules default disabled; validation", () => {
    const ok = parseRuleInput(
      { keywords: "price, 多少钱 ,, PRICE", dmText: " hi ", startAfter: "2026-09-17T00:00:00Z" },
      { partial: false },
    );
    assert.ok(ok.ok);
    if (ok.ok) {
      assert.equal(ok.value.enabled, false);
      assert.deepEqual(ok.value.keywords, ["price", "多少钱"]);
      assert.equal(ok.value.dmText, "hi");
      assert.equal(ok.value.mediaId, null);
      assert.equal(ok.value.publicReplyEnabled, false);
    }
    assert.equal(parseRuleInput({ keywords: [" "], dmText: "x", startAfter: "2026-09-17" }, { partial: false }).ok, false);
    assert.equal(parseRuleInput({ keywords: ["a"], dmText: " ", startAfter: "2026-09-17" }, { partial: false }).ok, false);
    assert.equal(parseRuleInput({ keywords: ["a"], dmText: "x", startAfter: "nope" }, { partial: false }).ok, false);
    assert.equal(
      parseRuleInput({ keywords: ["a"], dmText: "x", startAfter: "2026-09-17", publicReplyEnabled: true }, { partial: false }).ok,
      false,
    );
    const patch = parseRuleInput({ enabled: true }, { partial: true });
    assert.ok(patch.ok);
    if (patch.ok) assert.deepEqual(patch.value, { enabled: true });
  });

  // ── Runner ────────────────────────────────────────────────────────────────

  await test("two overlapping polling runs on the same comment → exactly one DM", async () => {
    const db = new FakeDb();
    const calls = installFetch({
      media: [{ id: "m-1", timestamp: metaTs(NOW - DAY) }],
      comments: { "m-1": [rawComment("c-1", "price?")] },
    });
    const [a, b] = await Promise.all([
      runCommentDmForConnection(deps(db), conn, [rule()], liveOpts),
      runCommentDmForConnection(deps(db), conn, [rule()], liveOpts),
    ]);
    assert.equal(calls.messages.length, 1, "exactly one private reply sent");
    assert.equal(a.sent + b.sent, 1);
    assert.equal(a.lostClaims + b.lostClaims, 1, "the other run lost the claim");
    const events = db.tables.instagram_comment_dm_events;
    assert.equal(events.length, 1);
    assert.equal(events[0].status, "sent");
    // A third run later finds it handled and sends nothing.
    await runCommentDmForConnection(deps(db), conn, [rule()], liveOpts);
    assert.equal(calls.messages.length, 1);
  });

  await test("dry run: no writes, no sends, returns would-send list", async () => {
    const db = new FakeDb();
    const calls = installFetch({
      media: [{ id: "m-1", timestamp: metaTs(NOW - DAY) }],
      comments: {
        "m-1": [
          rawComment("c-1", "PRICE please"),
          rawComment("c-2", "nice"),
          rawComment("c-3", "price", { from: { id: IG_USER, username: "myshop" }, username: "myshop" }),
        ],
      },
    });
    const r = await runCommentDmForConnection(deps(db), conn, [rule()], { ...liveOpts, dryRun: true });
    assert.equal(calls.messages.length, 0);
    assert.equal(calls.replies, 0);
    assert.equal(db.writes, 0);
    assert.deepEqual(r.matches.map(m => [m.commentId, m.ruleId, m.keyword]), [["c-1", "r-1", "price"]]);
  });

  await test("token invalid (190) on send → stop connection, claim kept for retry", async () => {
    const db = new FakeDb();
    const calls = installFetch({
      media: [{ id: "m-1", timestamp: metaTs(NOW - DAY) }],
      comments: { "m-1": [rawComment("c-1", "price"), rawComment("c-2", "price")] },
      sendResult: () => ({ status: 400, body: { error: { message: "Error validating access token", type: "OAuthException", code: 190 } } }),
    });
    const r = await runCommentDmForConnection(deps(db), conn, [rule()], liveOpts);
    assert.equal(r.outcome, "token_invalid");
    assert.equal(calls.messages.length, 1, "stopped after the first failure");
    const ev = db.tables.instagram_comment_dm_events;
    assert.equal(ev.length, 1);
    assert.equal(ev[0].status, "claimed");
    assert.match(String(ev[0].last_error), /validating access token/);
    assert.ok(!String(ev[0].last_error).includes("secret-token"));
  });

  await test("other 4xx → terminal failed with Meta's message; next comment still processed", async () => {
    const db = new FakeDb();
    installFetch({
      media: [{ id: "m-1", timestamp: metaTs(NOW - DAY) }],
      comments: { "m-1": [rawComment("c-1", "price"), rawComment("c-2", "price")] },
      sendResult: (id) => id === "c-1"
        ? { status: 400, body: { error: { message: "This message is sent outside of allowed window.", code: 10 } } }
        : null,
    });
    const r = await runCommentDmForConnection(deps(db), conn, [rule()], liveOpts);
    assert.equal(r.outcome, "ok");
    assert.equal(r.failed, 1);
    assert.equal(r.sent, 1);
    const byId = Object.fromEntries(db.tables.instagram_comment_dm_events.map(e => [e.comment_id, e]));
    assert.equal(byId["c-1"].status, "failed");
    assert.equal(byId["c-1"].last_error, "This message is sent outside of allowed window.");
    assert.equal(byId["c-2"].status, "sent");
  });

  await test("rate limit (code 4) → claim stays retryable, connection stops", async () => {
    const db = new FakeDb();
    const calls = installFetch({
      media: [{ id: "m-1", timestamp: metaTs(NOW - DAY) }],
      comments: { "m-1": [rawComment("c-1", "price"), rawComment("c-2", "price")] },
      sendResult: () => ({ status: 400, body: { error: { message: "Application request limit reached", code: 4 } } }),
    });
    const r = await runCommentDmForConnection(deps(db), conn, [rule()], liveOpts);
    assert.equal(r.outcome, "rate_limited");
    assert.equal(calls.messages.length, 1);
    assert.equal(db.tables.instagram_comment_dm_events[0].status, "claimed");
  });

  await test("public reply failure never flips a sent DM", async () => {
    const db = new FakeDb();
    const calls = installFetch({
      media: [{ id: "m-1", timestamp: metaTs(NOW - DAY) }],
      comments: { "m-1": [rawComment("c-1", "price")] },
      replyResult: () => ({ status: 400, body: { error: { message: "Comment is not replyable", code: 100 } } }),
    });
    const r = await runCommentDmForConnection(
      deps(db), conn, [rule({ publicReplyEnabled: true, publicReplyText: "Check your DMs!" })], liveOpts,
    );
    assert.equal(r.sent, 1);
    assert.equal(calls.replies, 1);
    const ev = db.tables.instagram_comment_dm_events[0];
    assert.equal(ev.status, "sent");
    assert.match(String(ev.public_reply_status), /^failed: Comment is not replyable/);
  });

  await test("public reply is not attempted when the DM failed", async () => {
    const db = new FakeDb();
    const calls = installFetch({
      media: [{ id: "m-1", timestamp: metaTs(NOW - DAY) }],
      comments: { "m-1": [rawComment("c-1", "price")] },
      sendResult: () => ({ status: 400, body: { error: { message: "nope", code: 100 } } }),
    });
    await runCommentDmForConnection(deps(db), conn, [rule({ publicReplyEnabled: true, publicReplyText: "x" })], liveOpts);
    assert.equal(calls.replies, 0);
  });

  await test("stale claim (> 15 min) is reclaimed and sent once", async () => {
    const db = new FakeDb();
    db.tables.instagram_comment_dm_events.push({
      id: "ev-stale",
      connection_id: CONN_ID,
      rule_id: "r-1",
      comment_id: "c-9",
      media_id: "m-1",
      comment_timestamp: iso(NOW - 2 * HOUR),
      status: "claimed",
      attempts: 1,
      created_at: iso(NOW - 20 * 60 * 1000),
      updated_at: iso(NOW - 20 * 60 * 1000),
    });
    db.tables.instagram_comment_dm_events.push({
      id: "ev-fresh",
      connection_id: CONN_ID,
      rule_id: "r-1",
      comment_id: "c-8",
      media_id: "m-1",
      comment_timestamp: iso(NOW - 2 * HOUR),
      status: "claimed",
      attempts: 1,
      created_at: iso(NOW - 5 * 60 * 1000),
      updated_at: iso(NOW - 5 * 60 * 1000),
    });
    const calls = installFetch({ media: [], comments: {} });
    const r = await runCommentDmForConnection(deps(db), conn, [rule()], liveOpts);
    assert.equal(r.reclaimed, 1);
    assert.deepEqual(calls.messages.map(m => m.commentId), ["c-9"]);
    const byId = Object.fromEntries(db.tables.instagram_comment_dm_events.map(e => [e.id, e]));
    assert.equal(byId["ev-stale"].status, "sent");
    assert.equal(byId["ev-stale"].attempts, 2);
    assert.equal(byId["ev-fresh"].status, "claimed", "a fresh claim is left alone");
  });

  await test("missing comment-dm scopes → nothing fetched or written", async () => {
    const db = new FakeDb();
    const calls = installFetch({ media: [], comments: {} });
    const r = await runCommentDmForConnection(
      deps(db), { ...conn, scopes: ["instagram_business_basic", "instagram_business_content_publish"] }, [rule()], liveOpts,
    );
    assert.equal(r.outcome, "missing_scopes");
    assert.equal(calls.gets + calls.messages.length, 0);
    assert.equal(db.writes, 0);
  });

  await test("send cap stops the connection cleanly", async () => {
    const db = new FakeDb();
    const many = Array.from({ length: 5 }, (_, i) => rawComment(`c-${i}`, "price"));
    const calls = installFetch({ media: [{ id: "m-1", timestamp: metaTs(NOW - DAY) }], comments: { "m-1": many } });
    const r = await runCommentDmForConnection(deps(db), conn, [rule()], { ...liveOpts, maxSends: 3 });
    assert.equal(r.outcome, "send_cap");
    assert.equal(calls.messages.length, 3);
    assert.equal(db.tables.instagram_comment_dm_events.length, 3);
  });

  await test("media-specific rule scans its media even without an all-posts rule", async () => {
    const db = new FakeDb();
    const calls = installFetch({
      media: [],
      comments: { "old-media": [rawComment("c-1", "price")] },
    });
    const r = await runCommentDmForConnection(deps(db), conn, [rule({ mediaId: "old-media" })], liveOpts);
    assert.equal(r.sent, 1);
    assert.equal(calls.messages[0].commentId, "c-1");
  });

  await test("all-posts scan skips comments_count=0 media; missing count still scanned; rule media always scanned", async () => {
    const db = new FakeDb();
    const calls = installFetch({
      media: [
        { id: "m-zero", timestamp: metaTs(NOW - DAY), comments_count: 0 },
        { id: "m-some", timestamp: metaTs(NOW - DAY), comments_count: 3 },
        { id: "m-nofield", timestamp: metaTs(NOW - DAY) },
        { id: "m-bad", timestamp: metaTs(NOW - DAY), comments_count: "7" },
        { id: "m-pinned", timestamp: metaTs(NOW - DAY), comments_count: 0 },
      ],
      comments: { "m-nofield": [rawComment("c-1", "price")] },
    });
    const r = await runCommentDmForConnection(
      deps(db),
      conn,
      [rule({ id: "all" }), rule({ id: "pinned", mediaId: "m-pinned", keywords: ["link"] })],
      liveOpts,
    );
    assert.ok(calls.mediaUrls[0].includes("comments_count"), "comments_count is requested");
    assert.ok(!calls.commentMedia.includes("m-zero"), "zero-comment media is never requested for /comments");
    assert.ok(calls.commentMedia.includes("m-some"));
    assert.ok(calls.commentMedia.includes("m-nofield"), "missing field → still scanned");
    assert.ok(calls.commentMedia.includes("m-bad"), "non-number count → still scanned");
    assert.ok(calls.commentMedia.includes("m-pinned"), "rule-specified media is always scanned");
    assert.equal(r.sent, 1);
  });

  globalThis.fetch = originalFetch;
  console.log(`\nInstagram comment → DM: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
