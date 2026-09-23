# 后台用量与套餐可见性 PRD v0.2

**状态：** Codex 终审「需修改后批准」（2026-09-01），已按裁决修订为 v0.2。
**实施基线（exact base，不可只写分支名）：** `codex/admin-cockpit-on-live@27c70f9`
**日期：** 2026-08-31
**作者：** Fable 5
**关联：** `后台运营驾驶舱 admin operator console v1.1 20260714.md`（本文是其 §支柱4 Customer 360 的补强，不是新支柱）
**候选分支：** `codex/admin-cockpit-on-live`（驾驶舱 P0，PR #1）；用量世系在 `integrate/usage-phase1-0829`

---

## 0. 一句话

后台每个用户身上要能看到：**他是什么套餐、这个周期发了多少、还剩多少、以及这个数字可不可信**。

---

## 1. 关键前提：绝大部分基建已经存在（本次核实，2026-08-31）

这份 PRD 最重要的结论是**不要新建表**。生产库里已经有一张 `usage_accounts`，它逐字段就是本需求要的东西：

生产实测（只读 GET，用户 `e9324dfa`）：

```
plan_key: "pro"
period_start: 2026-08-01T09:40Z   period_end: 2026-09-01T09:40Z
ai_images_limit: 800              ai_images_used: 2         ai_images_reserved: 0
ai_text_generations_limit: 2000   ai_text_generations_used: 1
scheduled_posts_limit: 300        scheduled_posts_used: 107
bonus_images_balance: 0           version: 118
```

配套的 `usage_events` 是流水账（生产 119 行，2026-08-01 ~ 08-30，全部属于这一个用户）：

| usage_type | operation | 行数 |
|---|---|---|
| scheduled_post | consume | 107 |
| ai_text_generation | reserve / release / settle_success | 3 / 2 / 1 |
| ai_image | reserve / settle_success / expire | 2 / 2 / 1 |
| account | account_init | 1 |

**这意味着 P0 不是"做计量"，而是"把已有计量在后台露出来"。** 用户侧的 `GET /api/billing/usage` 已经上线并被 Settings 使用，后台缺的只是管理员视角。

### 1.1 三个必须先解决的事实问题

| # | 事实 | 影响 |
|---|---|---|
| **F1** | 生产 `usage_events` 的列是 `user_id` / `account_id` / `reservation_id` / `balance_before` / `balance_after` / `source`，而仓库里的 `backend/db/migrate_v57_usage_events.sql` 写的是 `owner_id` / `owner_type` / `quantity`。**两者不是同一张表。** 生产实际跑的是 v55/v56 世系（`usage_accounts` + reserve/settle），v57 是另一条设计。 | 任何按 v57 写的查询在生产会直接 42703 报错。后台实现必须按**生产实际列**写，并在 PR 里说明 v57 的归属（是否该废弃）。 |
| **F2** | **两套计量实现同时在生产运行，其中一套在静默失败。** `web/src/lib/server/usage.ts`（v57 设计，写 `owner_id`）与 `web/src/lib/server/usage/` 目录（v55/v56，写 `usage_accounts`）**都被线上路由调用**——`/api/generate`、`/api/ai-copy`、`/api/pin-drafts` 三个路由同时 import 两者。 | 见下方 F2-EXT。后台必须只用 `lib/server/usage/` 那套。 |
| **F3** | `scheduled_post` 的 `balance_after` 是**递增**的（106→107），即它记录的是"已用累计"而非"剩余余额"，字段名有误导性。 | UI 文案不能写"余额"，要写"本周期已用"。展示剩余必须用 `limit - used` 现算。 |

### 1.2 F2 升级为生产缺陷（2026-08-31 实测，非推断）

本次核实发现 F2 不只是「代码库有两套实现」这种整洁性问题，而是**线上正在发生的静默失败**：

| 观测 | 证据 |
|---|---|
| `usage.ts` 写入的列是 `owner_id` / `owner_type` / `reference_type` | `git show 5bcc1a6:web/src/lib/server/usage.ts`（`TABLE = "usage_events"`，insert 见 :62-105） |
| 生产 `usage_events` **没有 `owner_id` 列** | `GET /rest/v1/usage_events?select=owner_id` → **HTTP 400**（实测；生产实际列为 `user_id`/`account_id`/`balance_before`/`balance_after`/`source`/`reservation_id`） |
| 因此 `recordUsage()` 的每一次写入在生产都失败 | 二者相矛盾，必然失败 |
| 失败被**静默吞掉** | `recordUsage` 捕获后仅 `console.error` 并 `return { recorded: false }`，调用方不感知（:90-101） |
| 生产 119 行 `usage_events` **全部由 v55/v56 那套写入** | 全部带 `balance_after`/`reservation_id`，这是 v55 SQL 函数才会写的列 |

**两个后果，都比原 PRD 描述的严重：**

1. **额度校验形同虚设。** `checkAllowance` 读同一张表的 v57 列，读失败时**fail-open**（注释明写 "fails OPEN ... so metering can"）。即 `/api/generate` 里那次 `checkAllowance(meteringUserId, "ai_image", count, plan)` 在生产**恒返回 allowed**，
   无论用户是否超额。真正在拦人的是 `lib/server/usage/meterGeneration` 的 ledger 路径——**但只在 metering mode 开启时**。
2. **后台若接 `usage.ts` 会显示恒 0，且不报错。** 这正是本 PRD 最容易踩的坑。

**处置建议（提请裁决）**：本 PRD 的实现**只用 `lib/server/usage/`**，这一条不需要等裁决。
但 `usage.ts` 本身是否该删除/标注 deprecated、以及 `/api/generate` 那次 fail-open 的 `checkAllowance` 是否该摘掉，
**超出本 PRD 范围**，属于计量世系（`integrate/usage-phase1-0829`）的责任。建议单独提给该分支的负责人，
不要在驾驶舱分支里顺手改——那会把一个只读功能变成动计费逻辑的高风险改动。

**Codex 裁决补充：只标 deprecated 不够，必须收敛为单一世系。** 结构性防护（本 PRD 负责前两条，其余属计量分支）：
1. Admin 与用户侧 API **共享同一个只读函数**（如 `readUsageSnapshot(userId)`），不各写一份查询；
2. 测试库 schema fingerprint 断言（见 §5.1）；
3. 静态门禁：任何对 `usage_events.owner_id/owner_type` 的运行时引用、或从旧 `usage.ts` 的 import，即失败；
4. 迁完所有调用方后**删除**旧 `usage.ts`。

**已核实的一处 Codex 误判（2026-09-01）**：Codex 提示"当前工作树仍是旧 v57 路由，正确的 metered:false 版本在 usage 集成 refs"。实测**不成立**——本 PRD 的实施基线 `codex/admin-cockpit-on-live@27c70f9` 里，`web/src/app/api/billing/usage/route.ts` 已经是读 `usage_accounts` 的诚实版本（含 `metered` 三态）。仍然成立的是：`/api/generate`、`/api/ai-copy`、`/api/pin-drafts` 三个路由确实还 import 着坏掉的 `usage.ts`。

**F1/F2/F3 全部为观测到的事实**（生产 GET 返回 + `git grep` + 迁移源码）。

F3 的源码确认（2026-08-31 补）：`backend/db/migrate_v55_usage_primitives.sql` 的 SQL 函数里
`v_balance_before := v_used + v_reserved`，随后 `v_balance_after := v_balance_before + v_quantity`
（:731/:753/:792/:799）。**即两列记录的是「已占用总量」的前后快照，单调递增，不是剩余余额**——
与生产实测的 101→107 递增一致。该迁移第 407 行的注释也写明其用途是让账本「self-checking」。
因此 UI 的「剩余」必须用 `limit - used` 现算，任何直接把 `balance_after` 当余额展示的实现都是错的。

---

## 2. 目标与非目标

**目标**
1. 管理员在 Customer 360 看到某个用户的套餐、周期、三类配额的已用/上限/剩余。
2. 驾驶舱能一眼看出"谁快用完了"（潜在的升级线索或卡点）。
3. 数字带**可信度标注**：有 `usage_accounts` 行的是实测，没有的显示"未计量"，绝不编造 0。

**非目标**（继承驾驶舱 PRD §4）
- ❌ 不在后台做计费面板、不镜像 Creem 账单（Creem 是唯一事实源，只放深链）
- ❌ 不做发放/扣减 credit 的写操作（P0 全只读；写操作需要审计底座，见 §6）
- ❌ 不做收入分析、ARPU、churn 预测

---

## 3. P0 功能

### 3.1 Customer 360 新增「用量与套餐」卡片

位置：Alert Strip 与健康标记之下。

| 字段 | 来源 | 无数据时 |
|---|---|---|
| 套餐 | `usage_accounts.plan_key`；无行则回落 `app_metadata.plan` 过 `normalizePlanKey` | "未知" |
| 周期 | `period_start` ~ `period_end` | "尚未计量" |
| AI 图片 | `ai_images_used` / `ai_images_limit` | 显示套餐 included 值 + "未计量"徽标 |
| AI 文案 | `ai_text_generations_used` / `_limit` | 同上 |
| 排期发布 | `scheduled_posts_used` / `_limit` | 同上 |
| 赠送图片 | `bonus_images_balance` | 0 时不显示该行 |

**安全边界（不可协商）**：套餐只信 `usage_accounts.plan_key` 或 `app_metadata.plan`，**绝不读 `user_metadata.plan`**——这是 `e2543f6`/`d8dbb9f` 已经关掉的越权口子，Customer 360 的 `planOf` 已收窄，本卡片必须沿用同一函数。

**三态诚实展示（Codex 裁决，P0 必做）**：
| 状态 | 含义 | UI |
|---|---|---|
| `metered` | 确有 `usage_accounts` 行 | 显示真实数字，**真实 0 要显示为 0** |
| `unmetered` | 确认零行（用户从未触发计量） | `used=null`，显示套餐 included，**不显示进度条** |
| `unavailable` | 查询失败 / 缺表 / 缺列 / 权限 / 超时 | 显示"同步异常"，**绝不降级成 unmetered** |

`unmetered` 与 `unavailable` 混同是本功能最容易犯的诚实性错误：前者是"我们确认没测过"，后者是"我们不知道"。

**剩余值规则**：
- 有限额度：`max(limit - used, 0)`
- `used > limit`：额外显示"超出 X"，**不能只显示剩余 0**（那会掩盖超额事实）
- `limit = null`：显示"不限量"，**不参与除法、不参与 80% 判断**

**套餐冲突可观测**：`usage_accounts.plan_key`（本周期执行快照）与 `app_metadata.plan`（当前履约缓存）不一致时，以账户快照展示，但打一个内部"套餐数据不一致"标记，**不静默掩盖漂移**。展示、筛选、Customer 360 必须调用同一 `effectivePlan` 逻辑，否则会出现"在 A 套餐筛选里出现、详情却显示 B 套餐"。

**诚实性要求**：
- `*_reserved` 不计入"已用"（在途预留可能被释放），与用户侧 `/api/billing/usage` 的口径保持一致，否则同一用户在前后台看到两个数。
- 无 `usage_accounts` 行 → `metered: false`，显示套餐包含额度 + "未计量"徽标，**不显示进度条**。
- 剩余 = `limit - used` 现算，不读 `balance_after`（见 F3）。

### 3.2 配额关注（独立卡片，**不进阻塞名单**）

**Codex 裁决：不得加入现有故障阻塞名单。** 阻塞名单回答"谁的创作链路坏了"，配额告警回答"谁可能需要升级/加购"——两者的严重性、建议动作、清空条件、成功指标都不同，换个颜色不能消除语义混淆。

改为 `/admin/today` 上一张独立的「配额关注」卡片：
- **只纳入** `metered=true` 且额度为有限正数的用户
- **不纳入** 不限量（`limit=null`）、未计量、查询失败的用户
- 同时显示周期剩余时间与绝对剩余额度（只有百分比不足以判断紧急度）
- 80% 只是运营启发式，**不作为故障判定，也不进入健康评分 driver**

### 3.3 客户列表加「套餐」列

`/admin/users` 现有列表加一列套餐，支持按套餐筛选。数据来自同一 loader，不新增 per-user 查询（沿用 `adminQueryUtils.ts` 的分页批量模式，避免 N+1）。

---

## 4. 技术方案

**零新表。** 全部只读派生自 `usage_accounts` + `auth.users`。

新建 `web/src/lib/server/adminUsage.ts`：

```
loadUsageAccounts(userIds: string[]): Map<string, UsageAccountRow>
  → 单次 in() 批量查询，沿用 adminQueryUtils 分页（防 1000 行截断）
summarizeUsage(row | null, plan): UsageSummaryView
  → 纯函数，含 metered 标志；无行时返回套餐 included 值 + metered:false
```

- 缺表/缺列 → 优雅降级为 n/a + 警告行（沿用 `adminOverview` 既有模式），**不得整页 500**。
- 新增文案全部走 `adminMessages.ts`（en + zh 双语），中文不得出现硬编码英文。
- 复用生产在跑的 `lib/server/usage/` 常量，不引 `usage.ts`（见 F2）。

**依赖顺序**：本功能读的 `usage_accounts` 在生产已存在，因此**不依赖 `integrate/usage-phase1-0829` 上线**。但若该分支先上线，`v68` 会引入 `release` 操作，届时"已用"口径会变（退款会减少 used），需同步核对。

---

## 5. 验收标准（v0.2：Codex 裁决后重写）

原 v0.1 的「与用户侧 `/api/billing/usage` 逐字段一致」**必要但不充分**——若两边共享同一个错误实现（例如都读 v57 列而拿到 0），比对会一致地错。因此改为四层独立验收：

### 5.1 Schema 世系门禁
在测试库用 `information_schema` 断言：v55/v56 的必需列存在（`user_id`/`account_id`/`balance_before`/`balance_after`/`reservation_id`/`source`），**且明确断言 v57 世系的 `owner_id`/`owner_type` 不存在**。任一不符即失败。

### 5.2 独立 oracle
直接查 `usage_accounts`，按本 PRD 定义**独立重算**期望值。**不得复用**页面 loader、API adapter 或同一个纯函数——否则测的是"实现与自己一致"。

### 5.3 测试矩阵（全部必须覆盖）
- 无账户行（unmetered）
- 已计量且 `used=0`（真实 0，与 unmetered 必须可区分）
- `used`/`reserved` 同时非零 → **确认 reserved 不计入已用**
- 79% / 恰好 80% / 超过 100%（`used > limit` 显示"超出 X"，不是剩余 0）
- `limit=null` 不限量（不参与除法、不参与 80% 判断）
- 套餐中途变更；`usage_accounts.plan_key` 与 `app_metadata.plan` 不一致
- 周期刚开始 / 刚结束 / 已过期
- 缺表 / 缺列 / 权限错误 / 网络错误 → 全部归入 `unavailable`，**不得降级成 unmetered**
- **至少两个不同用户**，证明批量 Map 不串号
- 伪造 `user_metadata.plan` 无效

### 5.4 负向/变异验证（证明测试真的能抓错）
临时把实现改成：查 `owner_id` / 把 reserved 计入 used / 把无行当成 0——**测试必须变红**。不红则说明测试没有防住 F1/F2 类错误，验收不成立。

### 5.5 生产只读 smoke（不承担完整验收）
生产 1 个有账户行的用户 + 3 个无账户行的用户，逐个核对。**GET 无副作用**：请求前后 `usage_accounts` 与 `usage_events` 行数必须不变（禁止后台读取触发 `ensureAccount`）。

## 6. 后续阶段

**P1 — 用量趋势**：每个用户近 3 个周期的用量曲线（`usage_events` 按周期聚合），识别"用量突然归零"（流失前兆）与"月月顶格"（加购线索）。

**P2 — 管理员写操作**：发放 bonus credit / 调整配额。**前置条件**：`admin_audit_events`（v34，已应用生产）必须先接上——任何改变用户计费状态的操作都要留审计。这也是驾驶舱 PRD 明确推迟到"有 safe actions 底座"之后的原因。

**P2 — 成本视角**：`ai_cost_events`（v58）落库后，把"用了多少"和"花了我们多少钱"并列，回答"哪个用户在亏钱"。注意 `ai_cost_events` 在生产**尚不存在**（本次 GET 返回 404）。

---

## 7. 风险

| 风险 | 缓解 |
|---|---|
| 两套计量实现并存（F2），实现者接错导致恒 0 | 实现前先跑一次生产只读对账；验收标准第 1 条就是与用户侧 API 逐字段比对 |
| `balance_after` 语义误读（F3） | UI 不使用该列；剩余一律现算 |
| 单用户样本（生产只有 1 个用户有计量行） | 其余场景用测试库 `snulmwprsahzqvdbyenc` 造，**绝不在生产造数据** |
| v57 与生产 schema 不符（F1）被后续会话误用 | 按 Codex 裁决改为 tombstone（§1.1） |
| **跨用户泄露** | Admin loader 必须**先完成 super-admin 门禁再用 service-role 批量读**；绝不提供接受任意 userId 的普通用户 API |
| **缓存泄露** | Admin 用量响应必须私有、动态，不得进入共享/CDN 缓存 |
| **异常值被洗掉** | 负数、非整数、`used > limit`、空周期、重复账户行 → 触发数据质量警告，**不得自动洗成 0** |
| **GET 产生副作用** | 后台读取**禁止**调用 `ensureAccount`；验收比对请求前后行数不变（§5.5） |
| **实施基线漂移** | 固定 exact base `27c70f9`，不只写分支名 |
