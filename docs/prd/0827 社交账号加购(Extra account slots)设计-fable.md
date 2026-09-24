# 社交账号加购(Extra account slots)设计

作者:Fable 5 日期:2026-08-27 状态:实施基线(用户裁决:参考 Tailwind 加购、不封顶)
依据:`docs/审查报告/0827 多渠道发布与多账号 PRD0805-0809 实现现状审查与方案建议-fable.md` §五/§六/§八;Creem 计费层只读探查(`creem_subscriptions` 一用户多订阅已是一等公民;未映射产品 id 镜像为 `plan=null` 不污染套餐解析)。

## 1. 产品规则

| 项 | 规则 |
|---|---|
| 单位 | **1 个 slot = 1 个额外可连接的社交账号**(Pinterest 账号 / Facebook Page / Instagram 账号任一) |
| 池 | **跨平台共享池**(any-platform)。原因:一个产品、一条订阅、一个数量;用户不用预先决定"多买的是 Pinterest 还是 IG";与 Later/Planoly 的 set 语义更接近。 |
| 生效公式 | 平台 P 允许新增连接 ⇔ `active(P) < included(plan, P)` **或** `Σ_Q max(0, active(Q) − included(plan, Q)) < purchasedSlots`。即先用套餐自带名额,超出部分从共享池扣。 |
| 上限 | **无上限**。`purchasedSlots` 可任意增加;套餐自带名额 1/1/2/3 不变(定价页/测试冻结值不动)。 |
| 谁能买 | **付费套餐**(Starter / Pro / Business)。Free 到额度仍是 Upgrade。 |
| 计费 | 按月(可选按年)。Creem 一条订阅,`items[0].units = N`;加买/减买走 `POST /v1/subscriptions/{id}` 改 `units`(`update_behavior: proration-charge`)。 |
| 降级/取消 | 沿用现有 grandfathering(`connectionLimit.ts:24-29`):超限账号保留、不能新增。加购订阅取消 → `purchasedSlots = 0`,同样只拦新增。 |
| 计数 | **用户持有的每一行都占名额,已断开(Disconnected)行也占;只有 Remove(硬删)释放**(用户 2026-08-27 裁决,PRD 0805 §11);从未连接过的占位行(无 token / 无身份 / 无 disconnected_at)不计;Reconnect 不占名额(update 分支不查)。FB/IG 的棘轮由"三平台都有按账号 Remove"解决。 |
| 价格 | **待用户定**。参考:Buffer $5-6/channel,Later $11.25/set,Planoly $8-10/set,Tailwind 整套餐 $17.99/账号。建议 **$7/账号/月,年付 $5/账号/月**(介于 Buffer 与 Later 之间,低于 Starter 单价避免"买加购不如再开一套餐")。 |

## 2. 数据与真值

- **真值 = `creem_subscriptions` 中产品 id ∈ 加购产品集合的、可授权状态的订阅行**(复用 `filterAccessGrantingSubscriptions`),`purchasedSlots = Σ units`。
- `units` 来源:webhook `subscription.*` 事件 `items[].units`(Creem SubscriptionItemEntity 有 `units`)。需要在 `creem_subscriptions` 上**加一列 `units integer not null default 1`**(迁移 **v66**(原取 v63 与 v3.7 的 `migrate_v63_product_opportunities_v1.sql` 撞号,v64/v65 被 Insights 占用,2026-08-28 改号)——按 CLAUDE.md 只写文件不 apply)。
- 不新增表;不写 `app_metadata` 缓存(读路径是 connect 起点与 callback,查一次 `creem_subscriptions` 即可,与 `resolvePlan` 同源)。
- "限制只在配置不在 DB 约束"(entitlements 决策 3)不受影响:购买数量是计费状态,不是套餐限制。

## 3. 代码面(单一实现,两处调用)

| 层 | 改动 |
|---|---|
| `lib/server/creem/creemProducts.ts` | 新增 `CREEM_PRODUCT_EXTRA_ACCOUNT_{MONTHLY,YEARLY}` env + `isExtraAccountProduct(id)`;**不进** plan map(保持 `resolveCreemProduct` 对它返回 null) |
| `lib/server/creem/creemStore.ts` / webhook `route.ts` | `upsertCreemSubscription` 记录 `units`(从 `items[0].units`,缺省 1);加购订阅**跳过** `allocateUsageForCycle`(不是套餐周期) |
| 新 `lib/server/social/accountAllowance.ts` | `getPurchasedExtraSlots(uid)` + `evaluateAccountAllowance(uid, provider)` 实现 §1 公式;active 计数一次查 `social_connections` 按 provider 分组;fail-open 语义保留 |
| `lib/server/social/connectionLimit.ts`、`lib/server/pinterest/accountQuota.ts` | 都委托给 `evaluateAccountAllowance`;两个 entitlement 键名收敛为一个(`connectedAccountsPerPlatform`),`lib/planEntitlements.ts` 的 `accountsPerPlatform` 改为 re-export 或删除并修引用 |
| `api/auth/{facebook,instagram}/connect` 起点 | 与 Pinterest 一样预检(到额度直接回跳,不进 OAuth) |
| `api/billing/creem/checkout/route.ts` | body 增加 `kind: "plan" \| "extra_account"`,`units`(1..N),加购只允许付费套餐;`metadata: { userId, kind }` |
| `SocialAccountsPanel.tsx` + i18n ×19 | 到额度 banner 第二 CTA "Add another account · $X/mo"(付费套餐)→ checkout;统一处理 `account_limit` 与 `limit_reached` 两个回跳标志 |
| `pricingPlans.ts` / `pricing-client.tsx` | 删 "Connected platforms" 行;删所有 TikTok 提及(bullets/row/caption/FAQ);caption 与 FAQ 加一句加购说明(用户定价后填数) |
| `scripts/test-plan-entitlements.ts` 等 | 更新对"Connected platforms"行的断言;新增 `test-account-allowance.ts`(池公式、active-only、fail-open、Free 不可买) |

## 4. 需要用户提供 / 裁决
1. 在 Creem 后台建加购产品(月付、可选年付),把产品 id 填进 `CREEM_PRODUCT_EXTRA_ACCOUNT_MONTHLY/YEARLY`(Vercel 生产 env + `.env.local`)。
2. 价格(建议 $7/月、$5/月年付)。
3. 是否允许 Free 购买(建议否)。
4. v66 迁移由用户 `run_migration.py --apply`。

## 5. 验收
- 限额 1 的 Starter 用户:连 1 个 Pinterest → 再连 IG 成功(不同平台);再连第 2 个 Pinterest → 拒绝 + banner(两个 CTA);购买 1 slot 后 → 第 2 个 Pinterest 成功;第 2 个 IG 仍拒绝(池已用完);再买 1 slot → 成功。
- 断开 A 再连 B(限额 1):**拒绝**(A 仍占位);Remove A 后再连 B:成功。
- Free 到额度:只有 Upgrade。
- 加购订阅取消:已连账号保留,新增被拒。
- 定价页:无 "Connected platforms" 行、无 TikTok;`npm run validate:i18n`、`test-plan-entitlements` 绿。
