/**
 * test-account-quota.ts — Phase D ①:Pinterest 侧账号额度真正执行的规则面。
 *
 * 覆盖:
 *  1. 计数规则:已断开的行不计数(否则额度变单向棘轮);
 *  2. null = 不限;
 *  3. 每档数字来自 server/planEntitlements.ts 的 connectedAccountsPerPlatform,
 *     不复制第二份(旧的 lib/planEntitlements.ts accountsPerPlatform 已删除);
 *  4. 路由契约:GET/POST 都有 gate、reconnect 一律放行、
 *     callback 里 create 与 revived 拦截 / 非 revived 放行、拒绝时不写行。
 *
 * 共享池(加购 slot)规则本身在 test-account-allowance.ts;这里只固定
 * accountQuota 这层适配器的形状与委托关系。
 * Run: npx tsx scripts/test-account-quota.ts
 */

// accountQuota → server/entitlements → supabase, which builds a client at module
// load. These placeholders keep that import from throwing; nothing here talks to a
// real database (every assertion below is either pure or reads source text). They
// must be set before the dynamic imports in main() — hence no static import of the
// module under test.
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

let passed = 0;
function test(name: string, fn: () => void) { fn(); passed++; console.log(`  OK  ${name}`); }
async function testAsync(name: string, fn: () => Promise<void>) {
  await fn(); passed++; console.log(`  OK  ${name}`);
}

const root = join(process.cwd());
const read = (p: string) => readFileSync(join(root, p), "utf8");

async function main() {
const { canAddAccount, evaluateAccountQuota } = await import("../src/lib/server/pinterest/accountQuota");
const { PLAN_ENTITLEMENTS } = await import("../src/lib/server/planEntitlements");

// evaluateAccountQuota now consults the shared allowance module, which reads the
// OTHER platforms' counts and the purchased-slot total. Inject both so these
// assertions stay pure: no DB, no network, no add-on products configured.
const offline = { countActive: async () => ({}), purchasedSlots: async () => 0 };

console.log("\n=== 计数规则 ===");
test("未达上限 → 允许;正好达上限 → 拒绝;超出(历史脏数据)→ 拒绝", () => {
  assert.equal(canAddAccount(2, 0), true);
  assert.equal(canAddAccount(2, 1), true);
  assert.equal(canAddAccount(2, 2), false);
  assert.equal(canAddAccount(2, 3), false);
});
test("null 上限 = 不限,任何已用数都允许", () => {
  assert.equal(canAddAccount(null, 0), true);
  assert.equal(canAddAccount(null, 999), true);
});
test("上限 0 时任何新增都拒绝", () => {
  assert.equal(canAddAccount(0, 0), false);
});

console.log("\n=== 每档数字取自 planEntitlements(不复制第二份)===");
await testAsync("free=1 / starter=1 / pro=2 / business=3,且 evaluateAccountQuota 直接引用它", async () => {
  for (const plan of ["free", "starter", "pro", "business"] as const) {
    const limit = PLAN_ENTITLEMENTS[plan].connectedAccountsPerPlatform;
    const q = await evaluateAccountQuota("u", plan, 0, offline);
    assert.equal(q.limit, limit, `${plan} 上限必须等于 PLAN_ENTITLEMENTS`);
    assert.equal(q.plan, plan);
  }
  assert.equal(PLAN_ENTITLEMENTS.free.connectedAccountsPerPlatform, 1);
  assert.equal(PLAN_ENTITLEMENTS.starter.connectedAccountsPerPlatform, 1);
  assert.equal(PLAN_ENTITLEMENTS.pro.connectedAccountsPerPlatform, 2);
  assert.equal(PLAN_ENTITLEMENTS.business.connectedAccountsPerPlatform, 3);
});
await testAsync("free 已有 1 个活跃 → 拒绝;pro 已有 1 个 → 允许,2 个 → 拒绝", async () => {
  assert.equal((await evaluateAccountQuota("u", "free", 1, offline)).canAddAccount, false);
  assert.equal((await evaluateAccountQuota("u", "pro", 1, offline)).canAddAccount, true);
  assert.equal((await evaluateAccountQuota("u", "pro", 2, offline)).canAddAccount, false);
});
await testAsync("used 如实回传,供横幅/日志使用", async () => {
  assert.deepEqual(await evaluateAccountQuota("u", "pro", 2, offline), {
    used: 2, limit: 2, plan: "pro", canAddAccount: false,
  });
});
await testAsync("买了 1 个加购 slot 后,超出套餐的第 N+1 个账号被放行", async () => {
  const withSlot = { countActive: async () => ({ pinterest: 1 }), purchasedSlots: async () => 1 };
  assert.equal((await evaluateAccountQuota("u", "starter", 1, withSlot)).canAddAccount, true);
  // 名额与 slot 都用完 → 仍然拒绝(池是共享的,不是无限的)
  const spent = { countActive: async () => ({ pinterest: 2 }), purchasedSlots: async () => 1 };
  assert.equal((await evaluateAccountQuota("u", "starter", 2, spent)).canAddAccount, false);
});

console.log("\n=== 计数口径:断开的行不占额度 ===");
test("计数口径由 accountAllowance 独占:未断开 且 有 token", () => {
  const allowance = read("src/lib/server/social/accountAllowance.ts");
  assert.ok(
    allowance.includes('.is("disconnected_at", null)') &&
      allowance.includes('.not("access_token_encrypted", "is", null)'),
    "活跃计数必须是 未断开 且 有 token(与 listActiveConnections 同一判定)",
  );
  const src = read("src/lib/server/pinterest/accountQuota.ts");
  assert.ok(src.includes("evaluateAccountAllowance"), "必须委托给唯一实现,不得自己再数一遍");
  assert.ok(!/listConnections/.test(src), "不得按全部连接计数,否则断开后无法重连");
});
test("listActiveConnections 的定义仍是 未断开 且 有 token", () => {
  const store = read("src/lib/server/pinterest/connectionStore.ts");
  assert.ok(
    store.includes("filter(r => !r.disconnected_at && !!r.access_token_encrypted)"),
    "计数口径变了就必须同步 callback 里那份内联的相同判定",
  );
});
test("callback 内联计数与 listActiveConnections 判定一致", () => {
  const cb = read("src/app/api/auth/pinterest/callback/route.ts");
  assert.ok(
    cb.includes("rows.filter(r => !r.disconnected_at && !!r.access_token_encrypted).length"),
    "callback 必须用同一判定,且不得再发一次 DB 请求",
  );
});

console.log("\n=== 连接开始:GET 与 POST 都要堵,reconnect 放行 ===");
const connectSrc = read("src/app/api/auth/pinterest/connect/route.ts");
test("gate 在 GET 与 POST 各调用一次", () => {
  const hits = connectSrc.match(/isOverAccountLimit\(uid, reconnectId\)/g) ?? [];
  assert.equal(hits.length, 2, "只堵一个入口等于没堵");
});
test("reconnect 存在时一律放行(重连修的是已有行,不新增)", () => {
  assert.ok(/if \(reconnectId\) return false;/.test(connectSrc));
});
test("GET 拒绝走 ?pinterest=limit_reached 重定向;POST 走 403 + code", () => {
  assert.ok(connectSrc.includes('integrationsRedirect(req, "limit_reached")'));
  assert.ok(connectSrc.includes('code: "limit_reached"'));
});
test("拒绝时不 seal state、不建授权 URL(不写任何状态)", () => {
  const gateIdx = connectSrc.indexOf("if (await isOverAccountLimit(uid, reconnectId))");
  const payloadIdx = connectSrc.indexOf("let payload: ConnectPayload;");
  assert.ok(gateIdx > 0 && gateIdx < payloadIdx, "gate 必须在构造 payload 之前");
});

console.log("\n=== OAuth 回调:decision 之后复查,decideConnect 保持纯函数 ===");
const cbSrc = read("src/app/api/auth/pinterest/callback/route.ts");
test("create 与 revived 的 update 都算新增 → 受额度约束", () => {
  assert.ok(
    cbSrc.includes('decision.action === "create" || (decision.action === "update" && decision.revived)'),
    "复活一条已断开的行会让活跃数 +1,必须同样拦截",
  );
});
test("拦截发生在 upsertConnection 之前(拒绝就是不写行)", () => {
  const gateIdx = cbSrc.indexOf("const addsAnAccount");
  const upsertIdx = cbSrc.indexOf("await upsertConnection(");
  assert.ok(gateIdx > 0 && upsertIdx > gateIdx, "额度检查必须先于写入");
});
test("decideConnect 仍是纯函数:不 import 额度/套餐", () => {
  const dec = read("src/lib/server/pinterest/connectDecision.ts");
  assert.ok(!dec.includes("accountQuota"), "额度不得塞进决策函数");
  assert.ok(!dec.includes("entitlements"), "决策函数不得读套餐");
  assert.ok(!dec.includes("import "), "connectDecision 应保持零依赖纯函数");
});
test("零迁移:额度不落 DB 约束(config 才是上限的家)", () => {
  const quota = read("src/lib/server/pinterest/accountQuota.ts");
  assert.ok(!/CREATE\s|ALTER TABLE|CHECK \(/i.test(quota));
});

console.log("\n=== 两套 entitlements 单向 import ===");
test("accountAllowance 从 server/planEntitlements 取数字、从 server/entitlements 取 plan 解析", () => {
  const src = read("src/lib/server/social/accountAllowance.ts");
  assert.ok(src.includes('from "@/lib/server/planEntitlements"'));
  assert.ok(src.includes("resolvePlan"));
  assert.ok(
    !/connectedAccountsPerPlatform:\s*\d/.test(src),
    "数字不得在此复制第二份",
  );
  const quota = read("src/lib/server/pinterest/accountQuota.ts");
  assert.ok(
    !/connectedAccountsPerPlatform:\s*\d/.test(quota),
    "数字不得在此复制第二份",
  );
});
test("两个 entitlement 键名已收敛为一个", () => {
  const client = read("src/lib/planEntitlements.ts");
  assert.ok(
    !/^\s*accountsPerPlatform:/m.test(client),
    "accountsPerPlatform 已删除,唯一键名是 server/planEntitlements 的 connectedAccountsPerPlatform",
  );
  const server = read("src/lib/server/planEntitlements.ts");
  assert.ok(server.includes("connectedAccountsPerPlatform"), "唯一键名必须还在");
});

console.log("\n=== i18n:limit 横幅文案 18 语言齐全 ===");
test("每个 locale 都有 socialPanel.limit.title/body/upgrade/dismiss", () => {
  const locales = ["ar","de","es","fr","hi","id","it","ja","ko","nl","pl","pt","ru","th","tr","vi","zh-CN","zh-TW"];
  for (const l of locales) {
    const src = read(`src/lib/i18n/messages/${l}.ts`);
    for (const k of ["title", "body", "upgrade", "dismiss"]) {
      assert.ok(src.includes(`"socialPanel.limit.${k}"`), `${l} 缺 socialPanel.limit.${k}`);
    }
  }
  const en = read("src/lib/i18n/messages/en/socialPanel.ts");
  for (const k of ["title", "body", "upgrade", "dismiss"]) {
    assert.ok(en.includes(`"socialPanel.limit.${k}"`), `en 缺 socialPanel.limit.${k}`);
  }
});
test("面板消费 ?pinterest=limit_reached 并渲染横幅(不是 toast)", () => {
  const panel = read("src/components/social/SocialAccountsPanel.tsx");
  assert.ok(panel.includes('flag === "limit_reached"'));
  assert.ok(panel.includes('data-testid="pinterest-account-limit"'));
  assert.ok(panel.includes('href="/pricing"'), "Upgrade CTA 必须可点");
  assert.ok(!panel.includes('limit_reached: { type:'), "不得降级成一闪而过的 toast");
});

console.log(`\nAccount quota: ${passed} passed, 0 failed\n`);
}

main().catch((err) => { console.error(err); process.exit(1); });
