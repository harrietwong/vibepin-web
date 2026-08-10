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

  console.log("\n=== CAS 签名面(connection 粒度) ===");
  test("updateTokens / markNeedsReconnect / getConnectionById 均以 connectionId 为首参(类型层面)", () => {
    assert.equal(typeof store.updateTokens, "function");
    assert.equal(typeof store.markNeedsReconnect, "function");
    assert.equal(typeof store.getConnectionById, "function");
    assert.ok(store.updateTokens.length >= 2, "updateTokens(connectionId, tokens, ...)");
  });

  console.log(`\nSocial connection store: ${passed} passed, 0 failed\n`);
}
void main();
