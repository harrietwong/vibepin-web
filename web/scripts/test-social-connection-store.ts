/**
 * test-social-connection-store.ts — multi-connection semantics of the Pinterest
 * connection store's PURE surface (Phase B, v59).
 *
 * Covers: pickDefaultConnection (the uid→connection compatibility layer's chooser —
 * single-connection users must behave exactly as before v59) and toSafeStatus.
 * The connection-scoped CAS itself is a DB write (updateTokens
 * .eq("id", connectionId).eq("token_version", …)) — asserted here only via the
 * exported signature requiring a connectionId, and verified by code review.
 * Run: npx tsx scripts/test-social-connection-store.ts
 */

import { randomBytes } from "node:crypto";
process.env.PINTEREST_TOKEN_ENC_KEY = randomBytes(32).toString("base64");
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

let passed = 0;
function test(name: string, fn: () => void) {
  fn(); passed++; console.log(`  OK  ${name}`);
}

async function main() {
  const store = await import("../src/lib/server/pinterest/connectionStore");
  type Row = import("../src/lib/server/pinterest/connectionStore").PinterestConnectionRow;

  const row = (id: string, over: Partial<Row> = {}): Row => ({
    id,
    vibepin_user_id: "u1",
    pinterest_user_id: `pid-${id}`,
    pinterest_username: `@${id}`,
    pinterest_account_type: "BUSINESS",
    access_token_encrypted: "enc",
    refresh_token_encrypted: null,
    access_token_expires_at: null,
    refresh_token_expires_at: null,
    scopes: ["user_accounts:read", "boards:read", "pins:read", "pins:write"],
    needs_reconnect: false,
    disconnected_at: null,
    token_version: 0,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    ...over,
  } as Row);

  console.log("\n=== pickDefaultConnection:uid 兼容层的选择语义 ===");
  test("0 条 → null(NotConnected 路径不变)", () => {
    assert.equal(store.pickDefaultConnection([]), null);
  });
  test("1 条 → 就是它(pre-v59 单连接用户行为逐字不变)", () => {
    const a = row("a");
    assert.equal(store.pickDefaultConnection([a]), a);
  });
  test("多条无默认 → 最早的一条(created_at 升序的 [0],pre-v59 行为的锚)", () => {
    const a = row("a"), b = row("b");
    assert.equal(store.pickDefaultConnection([a, b]), a);
  });
  test("多条 + 默认集命中 → 默认那条", () => {
    const a = row("a"), b = row("b");
    assert.equal(store.pickDefaultConnection([a, b], new Set(["b"])), b);
  });
  test("默认 id 不在活跃列表(已删/已断开)→ 回落最早一条,不炸", () => {
    const a = row("a"), b = row("b");
    assert.equal(store.pickDefaultConnection([a, b], new Set(["gone"])), a);
  });

  console.log("\n=== toSafeStatus:对外状态投影(永不带密钥) ===");
  test("null / 已断开 / 无 token → connected:false 全空", () => {
    for (const r of [null, row("a", { disconnected_at: "2026-01-03T00:00:00Z" }), row("a", { access_token_encrypted: null })]) {
      const s = store.toSafeStatus(r as Row | null);
      assert.deepEqual({ c: s.connected, a: s.account }, { c: false, a: null });
    }
  });
  test("正常行 → connected + 账号身份 + scopes,无任何 token 字段", () => {
    const s = store.toSafeStatus(row("a"));
    assert.equal(s.connected, true);
    assert.equal(s.account?.id, "pid-a");
    assert.ok(!("accessToken" in (s as unknown as Record<string, unknown>)));
    assert.ok(!JSON.stringify(s).includes("enc"), "序列化后不得出现密文");
  });
  test("needs_reconnect 或缺必需 scope → needsReconnect:true", () => {
    assert.equal(store.toSafeStatus(row("a", { needs_reconnect: true })).needsReconnect, true);
    assert.equal(store.toSafeStatus(row("a", { scopes: ["boards:read"] })).needsReconnect, true);
  });

  console.log("\n=== toAccountIdentity:身份在断开后仍然成立 ===");
  test("已断开 / 无 token 的行仍报得出它是谁(Settings 列表要用),且不含密文", () => {
    for (const r of [
      row("a", { disconnected_at: "2026-01-03T00:00:00Z", access_token_encrypted: null }),
      row("a", { access_token_encrypted: null }),
    ]) {
      const id = store.toAccountIdentity(r);
      assert.equal(id.id, "pid-a");
      assert.equal(id.username, "@a");
      assert.ok(!JSON.stringify(id).includes("enc"), "身份投影不得带出密文");
    }
  });
  test("toSafeStatus 与 toAccountIdentity 分工不变:前者答能不能发,后者答是谁", () => {
    const dead = row("a", { disconnected_at: "2026-01-03T00:00:00Z", access_token_encrypted: null });
    assert.equal(store.toSafeStatus(dead).account, null, "发布侧仍然什么都拿不到");
    assert.equal(store.toAccountIdentity(dead).id, "pid-a", "列表侧仍然认得出这一行");
  });
  test("一条活跃行上,两个投影给出同一个身份(只有一份定义)", () => {
    const live = row("a");
    assert.deepEqual(store.toSafeStatus(live).account, store.toAccountIdentity(live));
  });

  console.log("\n=== 占位行:列表侧与额度侧共用同一个判定 ===");
  const { isPlaceholderConnectionRow } = await import("../src/lib/social/connectionPlaceholder");

  test("从未连接过的占位行(无 token / 未断开 / 无身份)=> 是占位行", () => {
    // savePinterestDefaultBoard 在还没有任何账号时写下的 “只记住默认板” 的行。
    assert.equal(
      isPlaceholderConnectionRow({ hasAccessToken: false, disconnectedAt: null, providerAccountId: null }),
      true,
    );
  });
  test("已断开但留有身份的行 => 不是占位行(仍是账号,仍占额度)", () => {
    assert.equal(
      isPlaceholderConnectionRow({
        hasAccessToken: false,
        disconnectedAt: "2026-08-01T00:00:00Z",
        providerAccountId: "pid-a",
      }),
      false,
    );
  });
  test("有 token 但身份尚未同步的行 => 不是占位行(token 就是那条救命的事实)", () => {
    assert.equal(
      isPlaceholderConnectionRow({ hasAccessToken: true, disconnectedAt: null, providerAccountId: null }),
      false,
    );
  });

  test("列表守卫与额度计数指向同一个模块,不得各写一份", () => {
    const listing = readFileSync("src/lib/social/server/socialConnectionStore.ts", "utf8");
    const counting = readFileSync("src/lib/server/social/accountAllowance.ts", "utf8");
    for (const [what, src] of [["列表", listing], ["计数", counting]] as const) {
      assert.ok(src.includes("isPlaceholderConnectionRow"), what + "侧必须调用共享判定");
      assert.ok(/connectionPlaceholder"/.test(src), what + "侧必须从共享模块导入,而不是自己复述一遍");
    }
    assert.ok(
      !listing.includes("!safe.connected && !row.disconnected_at && !row.pinterest_user_id"),
      "旧的内联判定必须消失,否则两处会各自漂移",
    );
  });

  console.log("\n=== CAS 签名面(connection 粒度) ===");
  test("updateTokens / markNeedsReconnect / getConnectionById 均以 connectionId 为首参(类型层面)", () => {
    assert.equal(typeof store.updateTokens, "function");
    assert.equal(typeof store.markNeedsReconnect, "function");
    assert.equal(typeof store.getConnectionById, "function");
    assert.ok(store.updateTokens.length >= 2, "updateTokens(connectionId, tokens, ...)");
  });

  console.log("\n=== Facebook 多行:失败要闭合,不许猜 (E1a-01) ===");
  // 同一张 social_connections 表,Facebook 侧曾经四处 `.maybeSingle()`。
  // 用户连上第二个 Facebook 账号后 PostgREST 直接报 multiple rows,
  // 两个账号一起废掉。行为断言在 scripts/test-facebook-pages.ts(带假 db 真跑),
  // 这里守的是**契约**:签名收得下 connectionId,且多行时是 throw 而不是取 [0]。
  test("四个读函数都接受调用方指名的那一行", () => {
    const fbSrc = readFileSync("src/lib/server/facebook/connectionStore.ts", "utf8");
    for (const sig of [
      "export async function selectFacebookPage(",
      "export async function getFacebookUserToken(",
      "export async function connectFacebookPageManually(",
      "export async function getStoredFacebookSelection(",
    ]) {
      assert.ok(fbSrc.includes(sig), `缺少导出:${sig}`);
    }
    // 旧的单行读法一处都不能剩:它就是第二个账号一进来就全崩的原因。
    // 只看代码行 —— 注释里提到 maybeSingle 是在解释这个 bug,不该算复发。
    const codeLines = fbSrc
      .split(/\r?\n/)
      .filter(line => {
        const t = line.trim();
        return t !== "" && !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*");
      });
    assert.ok(
      !codeLines.some(line => line.includes(".maybeSingle()")),
      "maybeSingle 在用户可能持有多行时必然报错,必须全部改成显式解析",
    );
    assert.ok(
      fbSrc.includes("export const MULTIPLE_FACEBOOK_CONNECTIONS"),
      "失败闭合需要一个调用方能分辨的错误标识",
    );
  });

  test("多行且没指名 => 抛错;恰好一行 => 保持旧的单账号行为", () => {
    const fbSrc = readFileSync("src/lib/server/facebook/connectionStore.ts", "utf8");
    assert.ok(
      /if \(rows\.length > 1\) \{[\s\S]*?throw new Error\(MULTIPLE_FACEBOOK_CONNECTIONS\)/.test(fbSrc),
      "多行无目标必须 throw —— 静默挑一行就是发到别人主页的那种错",
    );
    assert.ok(
      !/rows\[0\]\s*\?\?\s*null;\s*\/\/\s*pick/.test(fbSrc),
      "不得存在'先取第一行再说'的兜底",
    );
    // 单账号老用户的路径逐字不变:恰好一行时仍旧返回那一行。
    assert.ok(fbSrc.includes("return rows[0] ?? null;"), "恰好一行时照旧返回该行");
  });

  test("user_id 过滤无条件生效,connectionId 只是额外收窄", () => {
    const fbSrc = readFileSync("src/lib/server/facebook/connectionStore.ts", "utf8");
    // connectionId 来自请求体。它若替代了 user_id,伪造一个 id 就能碰别人的连接。
    assert.ok(
      /\.eq\("user_id", uid\)\s*\.eq\("provider", PROVIDER\);/.test(fbSrc),
      "归属过滤必须先于任何分支无条件加上",
    );
    assert.ok(
      /target\?\.connectionId\s*\r?\n?\s*\?\s*await query\.eq\("id", target\.connectionId\)/.test(fbSrc),
      "connectionId 必须是在归属过滤之上再 .eq,不是另起一条查询",
    );
  });

  console.log(`\nSocial connection store: ${passed} passed, 0 failed\n`);
}
void main();
