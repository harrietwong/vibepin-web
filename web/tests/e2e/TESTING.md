# E2E 测试指南 — 账号、环境、跑法

本文件是给"后续来测试的人"看的：用哪个测试账号、需要哪些环境变量、每类测试怎么跑、
以及一个必须知道的安全现状。改动测试流程时请同步更新本文件。

---

## 1. 测试账号（唯一约定账号）

所有需要"已登录用户"的 E2E 测试统一使用这一个账号：

| 字段 | 值 |
|---|---|
| Email | `e2e-purchase-intent@vibepin.test` |
| Password | `E2ePurchaseIntent!2026` |
| User ID (uuid，**测试库**) | `988ca85e-923b-4771-840f-d5c0520c6d88` |

- **这个账号只存在于测试库**（ref `snulmwprsahzqvdbyenc`），生产库里已删除，符合隔离纪律。
- 邮箱后缀是 `.test`（保留域名），**不会**收到真实邮件，也不会误发给真人。
- 账号已 `email_confirm`（免验证，直接可登录）。
- 重建脚本是幂等的：见 §5，重复跑会复用同一账号，不会报错、不产生重复。

> **不要在测试里硬编码新的随机账号。** 需要"已登录"就用这一个。需要"未登录/匿名"
> 就清 cookie（`page.context().clearCookies()`），不要登录。

---

## 2. 数据库隔离（已合规，务必按这个跑）

测试账号在**测试库** `snulmwprsahzqvdbyenc`，生产库 `jaxteelkecvlozdrdoog` 里没有它。
但有一个坑：`web/.env.local`（dev server 日常用的配置）指向的是**生产库**
（`NEXT_PUBLIC_SUPABASE_URL` = 自定义 Auth 域名 `auth.vibepin.co`，其后端是生产库）。

所以**普通 `npm run dev` 起的 server 连的是生产库**，用它跑登录类 E2E 会去生产库找账号
（找不到，测试库账号不在那）。要用测试库，必须用专用启动脚本：

```bash
cd web
npm run dev:testdb    # 见 scripts/dev-testdb.mjs
```

这个脚本**不改 `.env.local`**：它把测试库的 Supabase 三项 + `E2E_TEST_MODE=false`
预先注入进程环境（`@next/env` 不会覆盖已存在的 `process.env`，已验证），其余 50 项配置
仍从 `.env.local` 拿。脚本带硬断言：若 `.env.test.local` 不指向测试库 ref 就拒绝启动，
防止"测试 server 误连生产"。

**给后续测试的人的硬规则：**

1. 跑登录类 / 购买意图 E2E → **一律用 `npm run dev:testdb` 起 server**，不要用 `npm run dev`。
2. 需要写业务数据 / seed / 造更多用户的脚本 → 直接读 `web/.env.test.local`
   （见 §5 的模板），并在任何写操作前打印目标 ref 断言 `== snulmwprsahzqvdbyenc`、
   `!= jaxteelkecvlozdrdoog`。
3. **永不**对生产库执行造用户 / 批量删除 / seed。生产库只读探测。

---

## 3. 环境变量

跑测试前按需设置。凭据不要提交进仓库——用 shell 环境变量或本地未跟踪文件。

| 变量 | 作用 | 何时需要 |
|---|---|---|
| `E2E_USER_EMAIL` | 测试账号邮箱（填 §1 的值） | 所有"已登录"测试 |
| `E2E_USER_PASSWORD` | 测试账号密码（填 §1 的值） | 所有"已登录"测试 |
| `E2E_TEST_MODE` | **必须为 `false` 或不设**。为 `true` 时 `proxy.ts` 会跳过整个 `/app/**` 登录守卫，任何重定向断言都失去意义（会把"未通过的守卫"显示成全绿） | 见 §4 的坑 |
| `CREEM_MODE` | 计费开关：`disabled`（默认/安全值）\| `test`（sandbox 计费）\| `live`（仅生产运行时可用）。**关闭时付费套餐渲染为 "Coming soon"，付费 checkout 测试会自动 skip** | 跑付费 checkout 覆盖时设 `test` |

### `E2E_TEST_MODE` 的坑（`npm run dev:testdb` 已自动处理）

`web/.env.local` 里默认有一行 `E2E_TEST_MODE=true`。它为 `true` 时 `proxy.ts` 会跳过整个
`/app/**` 登录守卫，任何重定向断言都失去意义。**Next.js 加载 `.env.local` 的优先级高于
shell 环境变量**，所以命令行前面写 `E2E_TEST_MODE=false` 盖不住它。

好消息：`npm run dev:testdb` 会**注入** `E2E_TEST_MODE=false`（注入的 `process.env`
不被 `.env.local` 覆盖），所以用它起 server 时守卫自动开启，无需手改 `.env.local`。
只有当你坚持用普通 `npm run dev` 跑鉴权测试时，才需要临时手改 `.env.local`（不推荐）。

**判断守卫有没有真正生效**：未登录 curl 一下受保护页，应看到 307 跳 login——
```bash
curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" --noproxy '*' \
  http://127.0.0.1:3000/app/studio
# 期望：307 http://127.0.0.1:3000/login?next=%2Fapp%2Fstudio
# 若是 200，说明 E2E_TEST_MODE 还在生效，守卫被绕过了，测试结果不可信
```

---

## 4. 起 dev server

Playwright 默认打 `http://localhost:3000`（见 `playwright.config.ts`，可用
`PLAYWRIGHT_TEST_BASE_URL` 覆盖）。

```bash
cd web
npm run dev:testdb    # 测试库 + 守卫开启，推荐用于所有登录类 E2E
# 或（连生产库、且 E2E_TEST_MODE 可能绕过守卫，不推荐跑鉴权测试）：
# npm run dev
```

注意：
- Next 16 不允许**同一项目目录**同时起两个 dev server（换端口也不行）。要换配置只能先停旧的。
- dev 模式首屏 hydration 慢：SSR 出来的按钮"可见"但 React 还没接管，**过早点击会落空**。
  测试里统一用 `waitUntil: "networkidle"` 加载页面，别用 `domcontentloaded`。

---

## 5. 重建 / 复用测试账号

账号已存在，通常不用重建。若测试库账号丢失，用 service role key 重建（幂等）。
**脚本读 `.env.test.local`（测试库），并带 ref 断言防止误写生产：**

```bash
cd web
node - <<'EOF'
import { readFileSync } from "node:fs";
const env = {};
for (const line of readFileSync(".env.test.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
const url = env.NEXT_PUBLIC_SUPABASE_URL, key = env.SUPABASE_SERVICE_ROLE_KEY;
// 硬断言：必须是测试库，绝不能误写生产
if (!url.includes("snulmwprsahzqvdbyenc") || url.includes("jaxteelkecvlozdrdoog")) {
  console.error("❌ 目标不是测试库，中止"); process.exit(1);
}
const email = "e2e-purchase-intent@vibepin.test";
const password = "E2ePurchaseIntent!2026";
const admin = { apikey: key, Authorization: `Bearer ${key}` };
const list = await fetch(`${url}/auth/v1/admin/users?per_page=200`, { headers: admin }).then(r => r.json());
const existing = (list.users || []).find(u => u.email === email);
if (existing) { console.log("复用已有:", existing.id); }
else {
  const res = await fetch(`${url}/auth/v1/admin/users`, {
    method: "POST", headers: { ...admin, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  const b = await res.json();
  if (!res.ok) { console.error("失败:", res.status, b); process.exit(1); }
  console.log("已创建:", b.id);
}
EOF
```

---

## 6. 跑测试

### 6.1 购买意图 / 鉴权链路（本轮的核心测试）

覆盖：Landing/Pricing 的 CTA 跳转、购买意图跨登录保留、阻断匿名 checkout、
`next` 开放重定向防护、年付不被降级成月付。

```bash
cd web
# 1) 先起测试库 server（另一个终端，保持运行）：
npm run dev:testdb
# 2) 跑测试：
E2E_USER_EMAIL="e2e-purchase-intent@vibepin.test" \
E2E_USER_PASSWORD="E2ePurchaseIntent!2026" \
npx playwright test tests/e2e/pricing-purchase-intent.spec.ts tests/e2e/landing-purchase-intent.spec.ts --reporter=list
```

**关于 skip**：付费 checkout 相关用例受 `CREEM_MODE` 门控。计费关闭（默认）时，
`/pricing` 的付费按钮是 "Coming soon"，这些用例会**自动 skip 并给出原因**——这是正确的，
不是失败。要跑满全部覆盖，起 server 前给 `dev:testdb` 注入 `CREEM_MODE=test`：

```bash
# 停掉正在跑的 dev:testdb，然后带 CREEM_MODE 重起：
CREEM_MODE=test npm run dev:testdb
# 确认 /pricing 出现 "Start Pro" 而非 "Coming soon"：
curl -s --noproxy '*' http://127.0.0.1:3000/pricing | grep -o "Start Pro\|Coming soon" | sort | uniq -c
```
（`CREEM_MODE` 从 shell 注入，不被 `.env.local` 覆盖，跑完关掉 server 即恢复，无需改文件。）

期望：`CREEM_MODE=test` 下全绿（0 failed、0 skipped）；未设时付费用例 skip、其余全绿。

### 6.2 其他现有测试

- `npx playwright test` —— 跑全部 e2e（`playwright.config.ts` 已排除 `auth.setup.ts`）
- 非浏览器单测在 `package.json` 的 `test:*` 脚本里（`npm run test` 是聚合入口）
- `npx tsc --noEmit` —— 类型检查
- `npm run validate:i18n && npm run validate:i18n-coverage` —— i18n 覆盖

---

## 7. 测试为什么这么写（经验教训，避免重复踩坑）

- **不要伪造 Supabase 登录**（种假 session cookie + `page.route` 拦 `/auth/v1/user`）。
  `getUser()` 会在本地就拒绝非法 JWT，根本不发那个网络请求，route 永远拦不到。
  这种测试会"偶然通过一次"然后稳定失败。已登录场景**只能**用真实账号 + 表单登录。
- **断言自己服务端收到的参数，别断言第三方 SDK 怎么被调用**。老测试断言
  `paddle.Checkout.open(...)` 的调用形状，Paddle→Creem 迁移后（改成整页
  `window.location.assign`）全废。现在的做法是拦截 `/api/billing/creem/checkout`
  断言请求体的 `{plan, interval}` —— 换支付商也不会全废。
- **hydration 竞态**：见 §4，一律 `networkidle` + 必要时给按钮 `waitFor visible`。

---

## 8. helper 速查

| 文件 | 用途 |
|---|---|
| `tests/e2e/helpers/billingMode.ts` | 运行时探测计费开关；`isBillingEnabled()` / `proCtaLocator()` / skip 原因常量 |
| `tests/e2e/helpers/creemCheckout.ts` | 拦截 Creem checkout API、录请求体、fulfill 假 URL（避免真打 Creem） |
| `tests/e2e/auth.setup.ts` | 用 `E2E_USER_*` 登录并存 storageState，供需要复用会话的测试 |
