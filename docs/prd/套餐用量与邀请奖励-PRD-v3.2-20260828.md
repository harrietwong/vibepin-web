# VibePin 套餐用量计量与邀请奖励 — PRD v3.2

- **版本**：v3.2 —— 取代 v3.1（`套餐用量与邀请奖励-PRD-v3.1-20260722.md`）【v3.2】
- **日期**：2026-08-28【v3.2】
- **基线**：【v3.2】基线定义改为"生产 deploymentId + 其祖先 SHA，每次部署刷新"（不再用某个 master 提交号，见 review §4-L / Codex 裁决 #21）。当前值：生产 `dpl_GdtGTzX3` = `deploy/fanout-visibility-0810@5bcc1a6`（gitDirty=1，2026-08-18 21:16 CLI 部署，含 FB/IG 多账号、不含 schedule-social-guard / p0 fan-out）；待上线候选 `80631ec9`（`integrate/create-pins-on-fanout-0827`）。
- **根本原则**：**废弃 Credit / Points / 积分抽象层**。用户直接看到真实单位：AI images、AI text generations、Scheduled posts、Bonus AI images。用户不需要理解「一次生成等于几个 Credit」。
- **状态**：【v3.2】v3.1 §0 决策 1–11（除决策 5 已撤销，见下）继续冻结；2026-08-28 产品负责人对 `0827 用量计量PRD审查-Codex裁决-待用户决策清单.md` #1–#14 逐条拍板，见新 §0.1。三项独立额度（图片/文本/发布）仍是唯一 MVP 契约，**Credit 不进入实施**（裁决 14，Codex 裁决 #14）。本版仍是**实施契约**，enforce 前必须先满足新 §14「enforce 就绪清单」。

### v3.2 变更说明

> 【v3.2】本版依据三份材料修订：① `用量计量-产品裁决记录-20260828.md`（产品负责人 2026-08-28 对 Codex #1–#14 的裁决，是本次修订的**唯一**产品变更来源）；② `0827 用量计量PRD-v3.1与Credit-0723 实现审查-fable.md`（实现现状核对）；③ `0827 用量计量PRD审查-Codex裁决-待用户决策清单.md` #15–#26（无需产品决策的文书修订）。改动逐条见文末「v3.1 → v3.2 变更清单」。
>
> **结构说明**：为保留 §0–§13 编号与 v3.1 逐条可比对，新增两节插入为 **§14「enforce 就绪清单」**与 **§15「Credit 0723 关系」**，原 §14 起的章节整体后移两位（原 §14 邀请奖励 → §16；原 §15 Edge cases → §17；……原 §22 最终报告要求 → §24）。除新增内容外，其余章节文字与 v3.1 逐字相同。

---

## 0. 已决策事项（v3.1 冻结部分，除决策 5 外continued 不得再改）

| # | 决策 | 说明 |
|---|---|---|
| 1 | **1 张成功图片 = 1 次 AI image allowance** | 公示数字不变：10 / 150 / 800 / 3,000 |
| 2 | **不存在「高级模型」** | 所有套餐同一模型，高级套餐只是量更大。`pricingPlans.ts:266-269` 的 "premium model generations may use more" **必须删除**（review §1 决策2：`pricingPlans.ts:283` 仍在，仍未修） |
| 3 | **多平台发布 = 按内容算 1 次** | 一次点击发到 Pinterest+IG+TikTok 只扣 1 次 Scheduled post |
| 4 | **Scheduled post 额度覆盖所有发布**（含立即发布） | 否则「改成立即发布」就是免费绕过通道 |
| 5 | ~~批量生成上限：Free 不支持 / Starter 4 张每批 / Pro 10 张每批 / Business 10 张每批~~ | 【v3.2】**撤销**（产品裁决记录 2026-08-28 #5）：一次生成张数由用户在 Create Pins 自选，**不按套餐限制**；生成越多扣越多。API 单次上限（当前 4，`ALLOW_MAX_IMAGES_PER_REQUEST_OVER_4` 可调至 99）是**技术容量限制**，对用户显示为"本次最多可生成 N 张"，**不是套餐权益**，不再出现在套餐对比表里。原批量权益表述作废，见 §2.1 脚注。 |
| 6 | **Free 套餐周期锚点 = 账号注册成功时刻**，按滚动月推进 | 无 Creem 订阅，故不能用订阅周期 |
| 7 | **不允许负余额** | 奖励撤销时若额度已用完，余额归零并阻断新生成，不追讨、不为负 |
| 8 | 文本生成独立计量并执行额度：Free 20 / Starter 500 / Pro 2,000 / Business 10,000 | 一次完整文案请求 = 1 次，无论同时返回 title/description/hashtags/altText。⚠️ 必须先公示数字再开启执行，见 §6.2（【v3.2】§6.2 已补裁决 9） |
| 9 | **账号删除后财务流水匿名化保留 7 年** | 依赖账号删除功能作为触发点，其 PRD 落地前本条不可验收（review 4.2-J） |
| 10 | **用户不可选择文本模型** | 全体用户使用同一默认模型，模型 ID 只存在于服务端配置层；服务端**忽略**客户端传入的任何 model 字段 |
| 11 | **不实现 `internalCostWeight`** | 投机性结构，与「不要过度设计」冲突。列入 Future Phase |

### 0.1 追加裁决（2026-08-28，产品负责人对 Codex 裁决 #1–#14 逐条答复）【v3.2】

> 来源：`docs/prd/用量计量-产品裁决记录-20260828.md`。事实前提：生产 `creem_subscriptions` = 0 行（当前无付费用户）；`usage_accounts` = 1 行（负责人自己的账号）。

| # | 议题 | 裁决 | PRD 落点 |
|---|---|---|---|
| 1 | Shadow 期间累计用量如何转 enforce | 负责人账号：切换日清零重计（选项 C 的落地方式）；真实用户：无历史用量，从上线日正常计 | 【v3.2】§9.5「切换日」 |
| 2 | 年付用户的月度额度 | **A**：按月发放、按月重置，锚点 = 订阅生效日；付费仍按年 | 【v3.2】§9.1（新增子周期） |
| 3 | 新额度何时约束存量用户 | 上线后立即生效，**无宽限**（当前无存量用户争议场景） | 【v3.2】§9.5 |
| 4 | 失败发布退不退 | **A**：确认未投递退；投递过或状态未知不退；退后再成功重新扣。需要四态（`not_sent` / `rejected` / `sent` / `delivery_unknown`）+ `release` 事件 + 重试重扣 | 【v3.2】§5.3 / §5.4 |
| 5 | 批量权益 0/4/10/10 | 撤销 v3.1 决策 5，见 §0 表行 5 | 【v3.2】§2.1 |
| 6 | 请求数超剩余额度 | **B**：弹确认，一键改成剩余数 | 【v3.2】§4.3 |
| 7 | 存量账户预建 vs 惰性 | **C**：付费用户预建、Free 惰性；当前无存量，以负责人账号为基础 | 【v3.2】§9.5 |
| 8 | 三类额度开启顺序 | **A**：分阶段，哪类满足公示+UI+账本+回滚就单独开；技术形态为三个独立开关叠在全局 `USAGE_METERING_MODE` 上 | 【v3.2】§6.2 / 新 §14 |
| 9 | 文案额度公示后是否先通知存量付费用户 | 无付费用户，**不通知**；公示后即可执行 | 【v3.2】§6.2 |
| 10 | Past due / Canceled / Expired / 未知的权益 | **A**：Canceled 保留到期末；Past due / 未知保留最近已验证权益并暂停升级；Expired 确认后转 Free | 【v3.2】§9.4a（新增） |
| 11 | 入队响应是否显示"预留后余额" | 显示（Codex 推荐 A）；入队响应加 `usage.reserved` / `usage.availableAfterReservation` | 【v3.2】§8.5 |
| 12 | 生产缺 `TEXT_MODEL_DEFAULT` | **C**：部署门禁 + 运行期断言（仅 `VERCEL_ENV=production` 生效）+ 告警 | 【v3.2】§6.5 |
| 13 | Free 定价页 Calendar "Basic" / Product management "Limited" | **A**：文案跟随可执行权益（具体措辞待负责人确认，见 §2.2.1） | 【v3.2】§2.2 / §2.2.1 |
| 14 | Credit P4 证据门槛 | **A + 并行准备**：严格完成 Credit 0723 四项前置才进 P4；同时允许现在启动 P0 审计、P3 成本采集、告警、研究设计 | 【v3.2】新 §15 |

**待负责人另行确认（本轮未答）**：S4「额外账号付费」是否最终口径。未确认前 §2.1 不含该加购项。

---

## 1. 现状事实（已核实，覆盖 v1.0/v2.0 的错误前提）

> 每条均有 file:line 证据。与之冲突的旧表述一律作废。本节 v3.2 未改动，逐字保留 v3.1 §1。

### 1.1 全部套餐数字目前**零执行**

`pricingPlans.ts` 中 8 个数字（10/150/800/3000 images、5/150/300/Unlimited posts）**全部是纯营销文案，代码中没有任何一处限制**。

代码中**唯一真正被执行**的额度是 Shopify：`web/src/lib/server/entitlements.ts:27-40` 的 `maxStores`/`maxSyncedProducts`（free 0/0、starter 1/100、pro 2/500、business 3/1000）—— 而它**在定价页上根本没有公示**。

⚠️ 这不是「修改现有计量方案」，而是**建设第一个计量系统**。

### 1.2 UI 正在显示假余额

`web/src/lib/accountSummary.ts:1` 写死 `EXISTING_APP_TOKEN_BALANCE = 34`，`:72` 的元数据覆盖字段**从无代码写入**。因此每个用户看到的都是同一个「34 Tokens」，渲染于 `app/app/layout.tsx:242,484,523` 与 `SettingsModal.tsx:523`。`customer360.ts:357` 读的 `user_metadata["tokens"]` 也无写入者。

⚠️ 这是**正在对用户显示的虚假信息**，且 `user_metadata` 用户可写，绝不可作为财务状态来源。

### 1.3 「一条帖子」在现有代码里没有唯一定义

用户在 `DraftDetailsDrawer.tsx:944-969` 点一次发布到 Pinterest+IG+TikTok，实际写入：

| 数法 | 结果 | 问题 |
|---|---|---|
| `social_publish_jobs` | **1** | Pinterest 根本不写这张表 |
| `social_publish_job_destinations` | **2** | 漏掉 Pinterest |
| `analytics_events` | **1** | 只有 Pinterest，且该表**故意允许丢写** |

Pinterest 走 `/api/pinterest/pins`，其他平台走 `/api/publish/social`（该路由 L146-155 **显式跳过 Pinterest**）。**没有任何现有查询能得出正确的「本月发帖数」。**

→ 决策 3/4 解决了这个问题：以**内容**为计数单位，覆盖所有发布路径。

### 1.4 发布路径有四条，互不统一

1. `POST /api/pinterest/pins` — 立即发布 Pinterest（主路径）
2. `GET /api/cron/publish-due` — 定时发布，**仅 Pinterest**，`DUE_LIMIT=20`/次
3. `POST /api/publish/social` — 多平台扇出，**显式跳过 Pinterest**，且**无定时能力**（客户端在 Pinterest 成功后同步触发）
4. 遗留：`POST /api/publish`（`publishing_queue`）、`POST /api/publish-jobs`（`publish_jobs`）

⚠️ 因此「150 scheduled posts/月」当前实际只能指 Pinterest。

### 1.5 发布重复计数风险（已知且未修）

`web/src/app/api/cron/publish-due/route.ts:16-21` 自述：进程在 Pinterest 建 Pin 后、写成功前崩溃 → 10 分钟后（`CLAIM_STALE_MS`）重认领 → **重复发一次真实 Pin**。`publishPinForUser` 对 Pinterest 无幂等键。

⚠️ 任何基于「发布成功事件」的计数都会在崩溃时多扣。

### 1.6 `analytics_events` 不可作为计费账本

`lib/server/publishEvents.ts:10-14` 声明硬边界：分析写入失败绝不可影响发布；`recordPublishEvent` 把所有错误吞进 `console.warn`（L194-198），调用方 fire-and-forget。且事件名全部以 `pinterest_` 为前缀。

⚠️ **故意有损 + 仅 Pinterest = 不能当账本。**

### 1.7 `/api/generate` 不是唯一 AI 入口

尽管 `route.ts:243-248` 自称如此，另有三个路由直接调用 AI 供应商，**既无认证也无审核门**：
- `/api/ai-copy`（文本+视觉）
- `/api/ai-copy/analyze`（视觉）
- `/api/quality-judge`（视觉）

它们今天就在被匿名调用并产生真实供应商成本。

### 1.8 Billing 页**不做**同步 Creem 调用

`/api/billing/creem/status/route.ts:61,74` 只读本地 Supabase 镜像，无 `creemClient` 导入、无 api.creem.io 请求。`migrate_v45_creem_billing.sql:8-10` 明确声明 `creem_customers` + `creem_subscriptions` 为「billing state 的 SOURCE OF TRUTH」。

⚠️ v1.0 §9「新建本地快照表」→ **删除**。已解决的问题，再加一层是冗余。**保留** stale-while-revalidate 的 UI 要求（不闪 Free）。

### 1.9 结算跨语言，部分成功是常态

图片由 TS 入队 `generation_jobs`（`route.ts:915`），由 Python worker（`api/app/worker.py`，systemd 单元**当前禁用**）履约。Web 路由入队后立即返回，**只能预留**。一个 job 可 4 槽成功 2 槽（`terminal_status:150` → `done|partial|failed`）。孤儿重认领只重跑非 `done` 槽（`worker.py:307`）。

⚠️ 「认领即扣量」会对每个被重认领的 job 重复扣量。

### 1.10 上传自己的图片**不碰任何 AI 供应商**

`/api/studio/upload/route.ts` 全流程：bearer 认证 → 类型白名单 → 12MB 上限 → Storage 上传。无任何供应商调用、无 `generation_jobs` 插入。

→ 可安全声明上传不消耗 AI image allowance。

### 1.11 连接账号数**零执行**

`social_connections`（v32 L28-53）无任何每用户数量约束；`/api/social/connect` 与 `socialConnectionStore.ts` 无 limit/plan/entitlement 引用。**免费用户现在可在 4 个平台连无限个账号。**

### 1.12 仅个人账号

无 teams/workspaces/organizations 表。`workspace_id uuid` 是 3 张表上未使用的前向兼容空列，注释写明「= vibepin user today」。本 PRD 一律按 **user_id** 落地，保留 `workspace_id` 空列。

### 1.13 既有安全与合规成果不得退化

- `resolvePlan`（`entitlements.ts:219`）优先级：creem_subscriptions（active/trialing/未过期 scheduled_cancel 中**排名最高**者）→ `app_metadata.plan` → free。**`user_metadata` 永不读取**（P0 自授权漏洞的既定修复）。
- Creem 表 RLS 启用零策略（仅 service-role）。
- Creem 审核门按**每原始字段 + composite** 送审（修复了已证实的上下文稀释绕过），fail-closed，严格早于 enqueue/FastAPI/inline。认证前置与 `MAX_MODERATION_CHECKS=56` 已落地。
- `CREEM_MODE=disabled`，checkout 关闭（"Coming soon"），生产无 `CREEM_API_KEY`。

### 1.14 测试框架无法证明并发安全

123 个注册测试，**100% 内存假件/模块 mock，零 DB 集成先例**。`FakeSupabase` 字典会让 Postgres 本能串行化的竞态「通过」。【v3.2】review 确认已建 DB 集成通道（§1.14 状态 ✅，`test-db-*` 五个真 Postgres 通道），但 16.1 的测试要求本身不降级，见新 §14。

---

## 2. 唯一服务端套餐配置源

```ts
type PlanEntitlements = {
  planKey: PlanKey;                    // free | starter | pro | business
  displayName: string;
  monthlyAiImages: number | null;      // null = unlimited
  monthlyAiTextGenerations: number | null;
  monthlyScheduledPosts: number | null;
  connectedAccountsPerPlatform: number | null;
  connectedPlatforms: number | null;
  maxBatchSize: number;                // 【v3.2】不再是套餐权益字段（裁决5撤销 v3.1 决策5）：仅表示技术容量上限，不用于套餐差异化判断，见 §2.1 脚注
  maxStores: number;                   // 既有 Shopify（不得回归）
  maxSyncedProducts: number;
  rank: number;
  creemProductIds: string[];
  features: {
    aiImageGeneration: boolean;
    aiTextGeneration: boolean;
    scheduling: boolean;
    batchGeneration: boolean;          // 【v3.2】语义变化：不再指"套餐是否允许批量"，全体套餐均为 true；仅用于历史兼容，不建议新代码依赖
    analytics: boolean;
    teamWorkspace: boolean;            // 全部 false，尚无实现
  };
};
```

语义：`null` = unlimited；`0` = 不支持该功能；正整数 = 每订阅周期允许数量。

### 2.1 最终额度表（**保留全部已公示数字，不发明新数字**）

| 项 | Free | Starter | Pro | Business | 来源 |
|---|---|---|---|---|---|
| **AI images / 月** | 10 | 150 | 800 | 3,000 | 定价页已公示（`pricingPlans.ts:203`） |
| **Scheduled posts / 月** | 5 | 150 | 300 | `null`(Unlimited) | 定价页已公示（`:197`） |
| **连接平台数** | 1 | 4 | 4 | 4 | 定价页已公示（`:188-191`） |
| **每平台账号数** | 1 | 1 | 2 | 3 | 定价页已公示（`:192-196`） |
| **AI text generations / 月** | **20** | **500** | **2,000** | **10,000** | 【决策 8】定价页尚未公示，必须先公示再执行，见 §6.2 |
| Shopify 店铺 | 0 | 1 | 2 | 3 | 既有 `entitlements.ts:36-39` |
| Shopify 同步商品 | 0 | 100 | 500 | 1000 | 既有，env 可覆盖 |
| 额外账号付费（S4） | 待确认 | 待确认 | 待确认 | 待确认 | 【v3.2】待负责人确认最终口径后写入；**未确认前本表不含加购**（产品裁决记录 2026-08-28 末尾） |

【v3.2】**批量单批张数行已删除**（撤销 v3.1 决策 5）：用户在 Create Pins 自选一次生成张数，**不按套餐限制**，生成越多扣越多。API 单次请求上限（当前 4，`ALLOW_MAX_IMAGES_PER_REQUEST_OVER_4` 环境变量可放宽至 99）是**技术容量限制**，对用户显示为"本次最多可生成 N 张"而非套餐权益差异，**不出现在定价页套餐对比表中**。

**前端、后端、Billing、Pricing、权限判断必须读取同一份配置。** `pricingPlans.ts` 的展示字符串应由该配置派生，杜绝数字漂移。

### 2.2 必须修正的既有文案

| 位置 | 问题 | 处理 | 状态【v3.2】 |
|---|---|---|---|
| `pricingPlans.ts:266-269`（现址 `:283`） | 承诺"高级模型消耗更多 credits"，但**无高级模型** | **删除该句** | 【v3.2】仍未修（review 决策2：`pricingPlans.ts:283` 仍在，两条世系都在） |
| `pricingPlans.ts:203` 等 | "AI image credits" | 改为 "AI images" | 【v3.2】仍未修（review §2.2：`×11` 处仍在） |
| `en.ts:122` `billing.freeDesc` | "up to 2 boards and limited AI credits" —— **"2 boards" 在别处不存在**，与"1 account on 1 platform"矛盾 | 重写，×20 语言 | 已修（review §1.1：✅） |
| `pricingPlans.ts:226` | Calendar planning Free 值为 `"Basic"`，违反该文件自身 L5-7 的取值规则 | 归一为 `"Limited"` 或给出定义 | 【v3.2】仍未修；具体措辞见 §2.2.1（裁决 13） |
| Free `"Product management: Limited"`（`:233`） | 但 `entitlements.ts:36` 是 `maxStores: 0`，Free 根本连不了店 | 文案与执行对齐 | 【v3.2】仍未修；具体措辞见 §2.2.1（裁决 13） |

#### 2.2.1 决策 13：Free 定价页文案（提议措辞，**待负责人确认**）【v3.2 新增】

裁决选项 A：文案跟随可执行权益，不承诺代码没有提供的能力。以下为**提议措辞**，尚未经负责人对具体文字拍板：

- **Product management**（Free）：`"—"`（不可用；`entitlements.ts:36` `maxStores=0`，Free 用户连不了任何 Shopify 店）
- **Calendar planning**（Free）：`"Limited"`，并加一行定义：`"Limited — 可手动安排日历排期，暂不含智能排程建议"`

⚠️ 上述措辞**待负责人确认**后方可实施；确认前不得据此改代码或定价页文案。

### 2.3 禁止默认降级为 Free

**任何位置读取不到套餐时，不得默认按 Free 处理。** 必须区分「确认为 Free」与「暂时读不到」，后者保持上一次已验证状态并显示刷新提示。

---

## 3. 用户侧术语（全面去 Credit 化）

### 3.1 允许的单位

```text
AI images
AI text generations
Scheduled posts
Bonus AI images
```

**同时禁止在用户界面出现的模型信息**（决策 10）：

```text
Powered by Gemini / Model used / Select model / 任何模型 ID
```

模型属于内部基础设施，不是用户功能。服务端内部服务返回的 `provider` / `model` 字段**不得**出现在 Billing 或任何用户可见文案中。

### 3.2 禁止在用户界面出现

```text
Credit / Credits / 积分 / Points / Token / Tokens
Cashback / Cash reward / Commission
```

例外：`PRICING_REASSURANCE` 中的 "No credit card required"（信用卡，非额度）保留。

### 3.3 文案改动规模

**8 个 i18n key × 20 个语言文件 = 160 个字符串值**：

| key | 英文现值 | 命名空间 |
|---|---|---|
| `account.credits` | "Credits" | account |
| `common.token` | "Token" | common |
| `billing.freeDesc` | "Free plan — up to 2 boards and limited AI credits per month." | billing |
| `billing.tokenBalance` | "Token balance" | billing |
| `billing.aboutTokens` | "About tokens" | billing |
| `billing.tokensAvailable` | "tokens available" | billing |
| `billing.noUsage` | "No usage data yet…" | billing |
| `pinDetails.reportCreditsIssue` | "Report credits issue" | pinDetails |

**另有 6 处硬编码组件**：`NotificationPreferencesCard.tsx:27`（`lowTokenBalance` 是持久化偏好键）、`SettingsModal.tsx:508`（testId）、`SupportChat.tsx:269,350`、`DraftDetailsDrawer.tsx:1687-1689`（testId + 种子文案）、`admin/users/[id]/page.tsx:217`（管理端）、`lib/assistant/knowledge.ts:48`（检索关键词，非展示）。

【v3.2】**`lowTokenBalance` 键明确保留，仅改展示文案**（review §4-I，Codex 裁决 #18）：该键是用户通知偏好的持久化存储键，不是用户可见术语，**改名有存量偏好数据迁移含义、不划算**；只需把渲染给用户看的文字从 "Low token balance" 改为 "Running low on AI images" 之类的真实单位表述，键名 `lowTokenBalance` 本身不动。

⚠️ 改 i18n 必须跑 `validate:i18n` 与 `validate:i18n-coverage`。注意后者在基线上已 exit 1（234 处既存 missing key），**不得把既存问题算作本次引入，也不得掩盖新引入的问题**。

---

## 4. AI image 用量规则

### 4.1 计量规则

```text
成功生成 1 张         = 消耗 1 次
批量成功 4 张         = 消耗 4 次
重新生成 1 张         = 消耗 1 次
部分成功（4 中 2 张） = 消耗 2 次

生成失败              = 不消耗
Prompt 审核不通过      = 不消耗
Moderation 服务失败    = 不消耗
超时 / 无可用图片返回  = 不消耗
用户在生成开始前取消   = 不消耗
上传自己的图片        = 不消耗（见 1.10）
```

### 4.2 强制顺序

```text
用户身份验证
→ 请求参数验证
→ Prompt Moderation（fail-closed）
→ 检查剩余 AI image allowance
→ 原子预留额度
→ 调用图片生成服务
→ 按成功返回数量结算
→ 失败时释放预留
```

**绝不可把额度扣减移到 Moderation 之前。**

### 4.3 额度不足

生成开始前必须检查；不足时**不得调用图片模型**。

```json
{ "code": "ai_image_limit_reached",
  "message": "You have reached your AI image limit for this billing period." }
```

前端：
```text
You have used all AI images included in your current plan.
Upgrade your plan to generate more images.
```

【v3.2】**请求张数超过剩余额度（裁决 6，选项 B）**：弹出确认对话框，明确提示剩余可用数量，并提供**一键"改为剩余数量"**的操作；不得阻止对话框外自动生成，不得静默减量，不得产生负额度。原文"阻止请求并提示，或明确允许用户调整为 2 张"的二选一表述作废，**只保留选项 B**（review §3 序号3、Codex 裁决 #6）。

### 4.4 必须审计的全部入口

普通生成、重新生成、批量生成、编辑后重生成、队列任务、后台 worker、重试请求、fallback provider、所有 API 路由、Server Action、以及**任何可能绕开主生成接口的路径**。

已知需纳入：`/api/generate`（worker/FastAPI/inline 三分支）、`/api/ai-copy`、`/api/ai-copy/analyze`、`/api/quality-judge`。

---

## 5. Scheduled post 用量规则

### 5.1 计量规则（决策 3 + 4）

```text
内容成功进入发布队列或成功立即发布 = 消耗 1 次

多平台发布（Pinterest+IG+TikTok）  = 仍然只消耗 1 次   【决策 3】
立即发布                           = 消耗 1 次        【决策 4】
定时发布                           = 消耗 1 次

草稿                = 不消耗
仅预览              = 不消耗
发布重试            = 不重复消耗（见 5.3）
```

【v3.2】**向任一平台发布均消耗 1 次**：`/api/publish/social` 在**无 Pinterest 目标**时（social-only 发布，如只发 IG/FB）**也是计量点**，与 Pinterest 路径共用同一 draft 键——同一次发布动作即使扇出到多个非 Pinterest 平台也只计 1 次，但**只发非 Pinterest 平台不能免费**（review §4-D，Codex 裁决 #15：此项不是新业务选择，v3.1 决策 3/4 已回答"是"，只是工程此前漏接该路由）。

### 5.2 计数锚点

以 **`pin_drafts` 行 + 一次发布动作** 为计数单位，而非 `social_publish_job_destinations` 行数。发布记录必须携带幂等键，使同一内容的同一次发布动作只计一次，无论扇出到几个平台。

### 5.3 投递状态四态与重试（关键）【v3.2 依裁决 4 全面重写，08-28 二次修正为四态】

因 `/api/cron/publish-due` 已知的 at-least-once 行为（1.5），**计数不可基于「发布成功事件」**。发布动作的结果必须落在以下四态之一，且判定必须来自平台/供应商的**真实响应**，**不得**用 `catch` 分支或 `result.ok === false` 直接代理业务事实（Codex 裁决 #36：异常不必然代表已投递，正常错误返回也不必然代表从未触网）：

```text
not_sent          -- 请求从未离开我们（参数校验失败、board 不属于该账号、账号未连接/需重连、被本地拦截）→ 归还
rejected          -- 供应商明确返回错误且什么都没创建（4xx 且响应无资源 id）→ 归还
sent              -- 供应商返回资源（201 / 有 pin id），即使我们之后持久化失败 → 扣
delivery_unknown  -- 超时、5xx、网络中断、进程在响应前崩溃 → 扣，不退，不重扣
```

- 在**认领时**写入带唯一约束的用量事件（`UNIQUE(idempotency_key)`），键含 draft_id + 计划时刻
- 重认领命中同一键 → 幂等无操作，**不重复扣**
- `not_sent` 与 `rejected` → **归还**额度，写 `release` 事件
- `sent` 与 `delivery_unknown` → **不归还**，按已消耗处理
- `rejected` 的判定只认供应商返回的 HTTP 状态码与资源 id 字段，不认错误文本；拿不到状态码一律按 `delivery_unknown`。
- 归还后再次成功发布 → **重新消耗 1 次**（防重武装见 5.3a）

#### 5.3a 归还后重试不得变成免费漏洞【v3.2 新增】

⚠️ 若无以下保护，会有一个免费漏洞：`consume(k)` → `release(k:release)` → 同日重试 → `consume(k)` 命中原幂等键被折叠为 no-op → **重试成功却一分不扣**。产品要求只有一条：**退回后再次成功必须再扣一次**。具体实现方式（attempt 级键铸造新键，或把已释放的 consume 行标记 void 允许重新武装）**由工程依据并发与审计约束决定**，不是产品决定（Codex 裁决 #37）。

### 5.4 取消与失败的额度归还【v3.2 依裁决 4 重写，08-28 二次修正为四态】

- **用户在执行前取消定时发布** → **归还**额度（写 `release` 事件）
- `not_sent` 与 `rejected` → **归还**并写 `release` 事件
- `sent` 与 `delivery_unknown` → **不归还**、不重复扣
- 退回后再次成功 → **再扣一次**
- 归还的幂等键 = 原 consume 键 + `:release`
- 既有实现在失败时会清空 `scheduled_at` 以避免重试风暴（`publishDueLogic.ts:120-155`），归还逻辑须与之对齐

### 5.5 Business 的 Unlimited

`monthlyScheduledPosts: null` 表示不限量：跳过额度检查，但**仍写用量事件**用于统计与滥用观察。

---

## 6. AI text generation 用量规则

### 6.1 计量单位 = 一次逻辑用户操作，不是一次供应商调用

```text
完整文案（title + description + hashtags + altText 一起返回）  = 1 次
重新生成全部文案                                              = 1 次
只重新生成标题                                                = 1 次
只重新生成描述                                                = 1 次

同一请求内部的质量重试或供应商回退                            = 不额外计数
/api/ai-copy/analyze（图片分析）                              = 0
/api/quality-judge（质量评判）                                = 0

生成失败 / 超时 / 审核拒绝 / JSON 无效 / 必填字段缺失 / 空内容  = 0
用户手动编辑文本                                              = 0
保存草稿                                                      = 0
发布或定时发布已有文案                                        = 0
```

⚠️ **供应商调用次数不是计费单位。** `/api/ai-copy` 内部的质量门重试（`route.ts:311-320`、`:348-354`）会多打一次模型，但**仍只计 1 次**。`analyze` 与 `quality-judge` 是内部辅助调用，**不计文本额度**，除非某端点直接返回用户请求的文案。

### 6.2 ⚠️ 公示先于执行（硬性前置条件）

定价页目前**没有任何文本数字**（只有定性的 `"AI titles, descriptions, and hashtags"` → Limited/✓/✓/✓）。**执行一个未公示的限额不可接受。**

强制顺序：

```text
1. 合入产品契约
2. 定价页公示 20 / 500 / 2,000 / 10,000
3. 验证生产定价页确实显示了正确数字
4. 再通过服务端特性开关启用文本额度执行
```

**绝不允许先开执行、指望定价页事后补上。** 同一次部署可同时包含两者，但**执行开关必须保持关闭，直到公开定价页验证通过**。

【v3.2】**裁决 9 确认**：生产当前 0 付费用户，公示后**无需**另加"通知存量付费用户"步骤，第 1→4 步顺序不变（产品裁决记录 #9）。

【v3.2】**裁决 8 明确"独立开关"**：第 4 步的"服务端特性开关"具体为**三类额度各自一个执行开关**（图片 `USAGE_ENFORCE_AI_IMAGES`、文本 `USAGE_ENFORCE_AI_TEXT`、发布 `USAGE_ENFORCE_SCHEDULED_POSTS`，命名示例，由工程定），叠加在现有全局 `USAGE_METERING_MODE`（决定 off/shadow）之上；全局 mode 不再单独决定某一类是否 enforce。开启顺序由产品逐类裁决（分阶段，选项 A），验收条件见新 §14。

### 6.3 强制顺序

```text
认证
→ 请求参数校验
→ 适用的内容审核
→ 原子预留 1 次 text generation
→ 调用 textGenerationService（服务端配置的默认模型）
→ 校验完整结果（schema / 字段 / 长度 / 非空）
→ 成功后结算 1 次
→ 任何非成功结果均释放预留
```

- **额度不足时不得调用模型**
- **预留或账本访问失败 → 不调用模型**
- **供应商成功但结算失败 → 不得报告为「已扣量的成功生成」**：安全重试结算；仍失败则请求失败，由独立过期机制释放预留
- 只有**通过服务端校验**的结果才算成功并扣量

### 6.4 额度不足错误

```json
{ "code": "ai_text_limit_reached",
  "message": "You have reached your AI text generation limit for this billing period." }
```

前端：
```text
You have used all AI text generations included in your current plan.
Upgrade your plan to continue generating AI content.
```

### 6.5 文本模型统一配置（决策 10 / 12）

- 单一服务端配置源 `TEXT_MODEL_DEFAULT`，模型 ID **不得**硬编码于页面组件、API 路由、Server Action、数据库业务逻辑、Pricing、Billing 或任何生成按钮
- **不保留**文案模型的多环境回退链（供应商 endpoint / API key 配置可另行保留）
- **不得**把 `TEXT_MODEL_DEFAULT` 套用到视觉分析：`visionModel` 是独立的内部关注点
- 业务路由调用 `textGenerationService`，**绝不**直接调用 Gemini / OpenAI 兼容 SDK
- 客户端传入的 `model` / `modelId` 等字段一律**丢弃**并使用默认模型 —— 治理行为是「忽略」，不是「报错」，更不是「照它给的模型执行」

【v3.2】**生产环境缺失或无效的 `TEXT_MODEL_DEFAULT` → fail-closed（裁决 12，选项 C）**，具体定义为三层，缺一不可：
1. **部署门禁**：predeploy guard 现有 check 8 在部署期检测缺失/无效配置，拦截发布；
2. **运行期断言**：仅当 `VERCEL_ENV=production` 时，对缺失/无效的模型配置做显式断言并**拒绝调用供应商**，不得静默回退到其他模型；
3. **告警**：断言触发时必须产生可观测告警，而不是吞掉错误让文本生成默默不可用。

代码现状 `AI_COPY_TEXT_MODEL || "gemini-2.5-flash"`（`visionServer.ts:163`）的静默回退链**必须替换**为上述运行期断言。`AI_COPY_TEXT_MODEL` 是代码中的实际环境变量名，是本 PRD `TEXT_MODEL_DEFAULT` 概念的同一配置项（命名不统一，文档层面视为别名，不强制改名）。

### 6.6 结构化输出校验

去除 Markdown 代码围栏 → 解析 JSON → 校验期望字段 → 强制长度上限 → 清洗与去重 hashtag → 拒绝空输出与混入的解释性文字。

⚠️ **不得整体重写现有结构化输出实现**（`/api/ai-copy` 已返回 `{title, description, altText, tags, keywords}`）。审计现有实现，抽取可复用的校验，**只补经核实确实缺失的部分**。必要时用适配器保持现有 API 响应契约（例如服务层 `hashtags` 映射到现有响应的 `tags`）。

### 6.7 内部模型档案（决策 11：不实现 `internalCostWeight`）

若确需类型，仅限：

```ts
type InternalModelProfile = {
  key: string;
  provider: string;
  modelId: string;
  enabled: boolean;
};
```

当前恰好一个启用档案，来自服务端配置，**永不暴露给客户端**。

❌ **不得**把 `internalCostWeight` 加入数据库、权益配置、用量事件、Billing 或任何计费计算。列入 Future Phase，待真正出现多模型成本路由需求且已批准时再加。

---

## 7. 数据库设计

### 7.1 usage_accounts

```text
id
user_id UNIQUE
plan_key
period_start
period_end
period_anchor            -- 'subscription' | 'signup'（Free 用 signup，决策 6）
ai_images_used
scheduled_posts_used
ai_text_generations_used -- 受额度约束，与图片/发布完全独立
bonus_ai_images_available
bonus_ai_images_used
version
created_at, updated_at
```

### 7.2 usage_reservations（AI image 预留，跨语言结算用）

```text
id
account_id
request_key                      -- 服务端加盐后的幂等键
generation_job_id UNIQUE NULL
requested_quantity
consumed_quantity
released_quantity
state                            -- open | partial | settled | released | expired
expires_at
created_at
UNIQUE(account_id, request_key)
```

### 7.3 usage_reservation_items（按槽）

```text
id
reservation_id
slot_key
state                            -- pending | succeeded | failed | expired
settled_at
UNIQUE(reservation_id, slot_key)
```

### 7.4 usage_events（不可变）

```text
id
user_id
usage_type       -- ai_image | ai_text_generation | scheduled_post | bonus_ai_image
operation        -- reserve | consume | release | grant | reverse | reset | manual_adjustment
quantity
source           -- 生成入口 / 发布路径 / webhook / referral
reference_type, reference_id
idempotency_key
balance_before, balance_after
metadata（安全字段，不含 prompt/密钥/隐私）
created_at
UNIQUE(user_id, idempotency_key)
```

### 7.5 扣减顺序

**先消耗本周期会过期的套餐额度，再消耗 Bonus AI images。** Bonus 在正常月度重置中**不清零**，仅在显式设置了到期时间时才过期。

### 7.6 写入接口

所有变更必须通过**数据库函数（RPC）**作为唯一写入接口，TypeScript 与 Python 调用同一组事务性 RPC。撤销直接写表权限。新表 RLS 启用零宽松策略（仅 service-role）。

⚠️ **service-role 绕过 RLS**，故跨用户归属检查必须在**路由层**单独测试。

---

## 8. 预留 / 结算（TS 预留、Python 结算）

### 8.1 幂等键归属

客户端提供稳定的不透明 request UUID **仅用于重试关联**；服务端必须用「已认证 user_id + 路由 + 操作」加盐/哈希后作为最终键。**客户端永不控制归属者与数量。**

### 8.2 单事务原子性

预留必须在**一个事务**内完成：锁定 usage_account → 创建 reservation + slot 行 → 写 usage_events → 插入 `generation_jobs` 行。消除「已预留但入队崩溃」的空档。`generation_jobs` 存 `usage_reservation_id`。

### 8.3 Worker 按槽结算

```text
settle_generation_slot(reservation_id, slot_key, outcome)
```

- 成功槽：`pending → succeeded` **仅一次**，转为已消耗
- 终态失败槽：`pending → failed` **仅一次**，释放
- 重认领跳过已 `succeeded` 槽 → **不重复扣量**
- 2/4 成功 → 消耗 2、释放 2，reservation 置 `partial`
- **瞬时失败不得标记槽为 failed**；只有终态放弃才释放

### 8.4 Worker 停摆与预留过期（关键：worker 当前禁用）

**不得依赖已禁用的 worker 释放预留。**

1. **准入控制**：生产 worker 模式下，预留前检查 worker 心跳新鲜度；已知禁用或心跳陈旧 → 在审核/预留/供应商调用**之前**返回 `503 generation_unavailable`，**零消耗**。
2. **独立清扫器**：Postgres 函数 + 经验证的 Supabase `pg_cron`，并在每次新预留前机会性调用同一过期函数。清扫器必须：只释放已过期且 job 无活跃租约的 pending 槽；把 job 标记为 canceled/failed 防止重启的 worker 再调供应商；恢复 Bonus；**套餐额度仅在原周期仍有效时恢复**（过期周期的额度不得变成新周期的额度）；写不可变 release/expiration 事件。
3. **竞态**：worker 认领时原子校验 reservation 为 open 且未过期；过期后的结算 fail-closed，**迟到产出不得发布**。
4. **TTL**：大于最大合法排队+供应商耗时，可配置且有绝对上限。用户可取消未开始处理的 job 以释放预留。

### 8.5 API 响应语义【v3.2 依裁决 11 重写】

异步入队路由**只预留、不结算**，因此**不能**返回最终消耗量。响应形状在既有 `{jobId, slots}` 基础上补入 `usage.reserved` / `usage.availableAfterReservation`（裁决 11，Codex 推荐选项 A：不能因为当前代码少返回字段就直接把产品契约删掉）：

```json
{ "jobId": "...",
  "slots": [ /* 既有槽位信息 */ ],
  "usage": { "reserved": 4, "availableAfterReservation": 146 } }
```

最终消耗量由**结算后的状态接口**给出，通过轮询：

```json
GET /api/generation-jobs/[id]
{ "usage": { "reserved": 4, "settledSuccess": 2, "settledFailed": 2 } }
```

同步路径可直接返回最终值。

**服务端计算全部用量，绝不信任客户端传来的数量。**

---

## 9. 周期重置

### 9.1 锚点

- **付费套餐**：跟随 Creem 实际订阅周期
- **Free 套餐**：**账号注册成功时刻**，按滚动月推进（决策 6）

存储：`period_start` / `period_end` / `next_reset_date` / `last_reset_event` / `period_anchor`。

【v3.2】**年付订阅需要"订阅周期内的月度子周期"（裁决 2，选项 A）**：年付账户**按月发放、按月重置**，锚点 = 订阅生效日；付费仍按年收取一次。`usage_ensure_account` 不能原样把 webhook 返回的一年周期当作用量周期存储——这是一项**实施项**，需要在订阅周期内再切出月度子周期用于额度重置。

### 9.2 续费

Creem 续费成功后：更新本地订阅快照 → 创建新使用周期 → 当期用量重置为 0 → **每次续费只执行一次** → **Webhook 重试不得重复重置**（唯一约束键 = 订阅 + 周期）。【v3.2】年付账户的"续费"在本条语义上，指**月度子周期**的滚动推进，不是等待年度续费事件（见 9.1）。

### 9.3 升级

使用新套餐上限，**保留当前周期已使用量**，不清零、不重复赠送整份新周期。

```text
旧套餐 150 张，已用 100 张
升级到 800 张
当前周期剩余 = 800 - 100 = 700 张
```

### 9.4 降级 / 取消

- **降级**：默认下个订阅周期生效，除非现有 Creem 逻辑明确为立即生效
- **取消**：按现有 Creem 行为保留本周期访问至期末；期满后不再重置发放

#### 9.4a 订阅同步异常状态的权益【v3.2 新增，裁决 10，选项 A】

Past due / Canceled / Expired / 未知这四种 Billing 状态此前未审（review §6 未审项）。裁决如下：

- **Canceled**：已付周期内保留原权益，到期末转 Free
- **Past due**（扣款失败）与**未知**（Creem 同步失败读不到）：保留**最近一次已验证权益**，但**暂停升级**（不允许在此状态下购买新套餐）
- **Expired**（周期结束未续）：经确认后转 Free
- 与既有『不得默认降级 Free』原则（§2.3）一致：**任何非确定状态不得直接判定为 Free**

### 9.5 存量账户建账与"切换日"【v3.2 依裁决 1/3/7 全面重写】

- **建账策略（裁决 7，选项 C）**：付费用户在 enforce 前**预建**账户行（在用户做任何计量动作之前建好，使 Billing 显示真实的 0/N 而非"尚未计量"）；Free 用户维持**惰性建账**（首次计量动作时建账）。当前生产 0 付费用户、`usage_accounts` 仅 1 行，选项 C 与"继续惰性"当前**零成本等价**，可随时执行。
- **"切换日"定义（裁决 1）**：三类额度中任一类从 shadow 转 enforce 的服务端生效时刻。切换日之前的用量只是 shadow 记录，不构成可执行余额：
  - **负责人自己的账号**（生产唯一一行 `usage_accounts`）：切换日当天**清零重计**（该行是负责人自测产生，非真实用户行为）。
  - **真实用户**：shadow 期间没有账户行（惰性建账），**没有历史用量可带**，从上线日起按 enforce 后的正常规则计数——不存在"是否沿用 shadow 用量"的问题。
- **新额度约束存量用户的时点（裁决 3）**：enforce 上线后**立即生效，无宽限期**。当前无付费用户、无存量用户争议场景；未来若出现真实存量付费用户中途遭遇新限制的场景，须重开本条另行裁决。
- 禁止从 `accountSummary`、`token_balance`、`user_metadata` 导入余额（部分路径**用户可写**，不可作为财务状态）。那个 `34` 是假值，**不迁移**。
- 订阅状态未知者标记 `review_required`，**不猜测**（另见 §9.4a）。
- **不得**把存量用户重置为 Free；**不得**在部署时给所有用户重复发放。
- 破坏性变更前提供 **dry-run 报告**。

---

## 10. Bonus AI images（邀请奖励额度）

【v3.2】**状态：Phase 7 未开工**（review §4-K，Codex 裁决 #20）——本节为设计规格，代码目前只有 DB 列和 Billing 类型字段 `bonusImages`，**无 referral 路由、无发放逻辑、Billing 不渲染 Bonus 行**。以下条款是未来实施时的既定契约，不代表当前已实现。

- 名称统一为 **Bonus AI images**，不叫 Credit。
- 与套餐额度**分开保存、分开显示**。
- 优先消耗本周期会过期的套餐额度，再消耗 Bonus。
- 正常月度重置**不清除** Bonus；仅在显式设置了到期时间时才过期。
- **不允许负余额**（决策 7）：奖励撤销时若 Bonus 已用完，余额归零并阻断新生成，**不追讨、不为负**。撤销必须写独立的 `reverse` 事件，**绝不修改或删除历史记录**。

---

## 11. Billing 页面

### 11.1 加载策略

**保留** stale-while-revalidate 的 UI 要求，但**不新建快照表**（1.8：本地镜像已存在）：

```text
1. 立即读取本地 creem_customers / creem_subscriptions
2. 立即读取本地 usage_accounts
3. 立即渲染
4. 数据过期时后台刷新
5. 刷新期间继续展示上一次已验证数据
6. 刷新失败不得把套餐变成 Free
```

**禁止出现**：进入 Billing 后长时间全屏 loading；先显示 Free 再跳付费；因 Creem 超时导致套餐消失；每次切 Settings 都重新请求 Creem。

⚠️ v1.0「快照缺失时同步拉取 Creem」在计费冻结、生产无 `CREEM_API_KEY` 的前提下**不可靠，移除**。仅在本地完全无快照时执行一次受控服务端同步（且计费解冻后才有意义）。

### 11.2 展示内容

**Current plan**：套餐名、订阅状态、月付/年付、当前周期、下次续费或到期日、Manage subscription 按钮。

**Usage this billing period** —— 每种独立进度条：

```text
AI images
32 / 150 used
118 remaining
Resets on August 18, 2026

AI text generations
86 / 500 used
414 remaining
Resets on August 18, 2026

Scheduled posts
46 / 300 used
254 remaining
Resets on August 18, 2026

Bonus AI images
20 available
```

**禁止**显示 `720 Credits` 这类合并余额，**禁止**把不同功能混成同一个数字。**禁止**显示模型名称、"Powered by Gemini"、"Model used"、"Select model"。

⚠️ **分阶段上线期间：某种额度的真实来源尚未上线时，不得为它展示编造的计数器。** 最终完成态才三条进度条齐全；在此之前只展示已有真实数据的那几条。

### 11.3 头部入口

```text
118 AI images left        →  点击进入 Billing/Usage
```
或多限制时简化为 `View usage`。

**必须移除** `EXISTING_APP_TOKEN_BALANCE = 34` 及其全部渲染点。

【v3.2】**状态：Phase 7 未开工**（review §4-K，Codex 裁决 #20）——两条审查世系均无此入口，需与 §10 Bonus 一并实施。

---

## 12. 账号隔离

- 服务端必须从已验证 Session 取身份：`web/src/lib/server/authUser.ts` 的 `getUserIdFromBearer` / `getUserIdFromCookies` / `getUserIdFromBearerOrCookies`。
  ⚠️ `getUserIdFromCookieSession` **未做网络验证**，禁止用于用量扣减。
- **绝不信任前端传入的** `userId` / `accountId` / `workspaceId` / `email`。
- 所有查询必须包含当前用户所有权条件；新表 RLS 启用零策略。
- ⚠️ **service-role 绕过 RLS** → 跨用户归属必须在路由层单独测试。
- 用户 A 不能：查看 B 的套餐/用量/奖励/邀请关系、消耗 B 的额度、猜 ID 越权、改请求中的 userId 绕过。
- **不得用 email 作为长期所有权主键**。换邮箱后订阅与用量仍归属原 immutable user ID。
- 管理员访问走显式特权路径 + 审计日志。
- Workspace 尚不存在（1.12）：本期按 user_id 落地，保留 `workspace_id` 空列。若未来启用，须验证成员归属与角色，并在 PRD 写清额度归属个人还是 Workspace。

---

## 13. AI 供应商边界收口

**规则**：*任何已认证的生产请求，未经校验、适用的 fail-closed 审核、以及原子额度预留，不得调用 AI 供应商。*

三个路由必须纳入：`/api/ai-copy`、`/api/ai-copy/analyze`、`/api/quality-judge`。

- 个人额度需要**已认证归属者**，因此这必然给它们**加上认证**。
- ⚠️ **这是破坏性行为变更，必须显式公告，不得静默实施。** 实施前先追踪调用方；若有依赖它们的匿名 UI 流程，只能二选一：使用前要求登录，或单独立项做匿名配额。**匿名请求不可扣任何用户的额度。**
- inline/FastAPI 既有匿名行为，仅在**显式按环境门控、隔离于生产之外**时保留。
- **认证必须早于审核**，防匿名审核请求放大（同类问题此前已修）。

---

## 14. enforce 就绪清单【v3.2 新增，review §3 / §4-G，Codex 裁决 #16】

> 三类额度（图片 / 文本 / 发布）**各自独立**转 enforce，每类必须先满足下表全部行才能打开对应的执行开关（裁决 8）。本节是 6A/6B/6C 阶段的**准入条件**，不是功能范围本身；每行给出可验证的验收方法，不接受"应该可以"式的口头确认。

| 额度类型 | 检查项 | 验收方法 | 状态（08-27 审查快照） |
|---|---|---|---|
| 全部三类 | 定价页展示对应数字 | curl 生产定价页，grep 数字字样 | 图片/发布 ✅ 已公示；文本 ❌ 未公示 |
| 全部三类 | 该类型有独立执行开关且默认关闭 | 代码 review + 生产 env 读取确认默认值 | ❌ 目前只有一个全局 `USAGE_METERING_MODE` |
| 全部三类 | `*_limit_reached` 前端 UI 存在（含超额确认+一键调整，裁决 6） | 截图 / E2E 测试触发限额场景 | ❌ 前端目前无 `ai_image_limit_reached` / `ai_text_limit_reached` 处理 |
| 图片 | 账本路径覆盖：预留、按槽结算、失败释放 | DB 集成测试 20 并发断言（§1.14） | ✅ v55 已验证 |
| 文本 | 账本路径覆盖：预留、结算、失败释放 | 同上 | ✅ 08-08 已实测 |
| 发布 | 账本路径覆盖：认领时消耗、`not_sent`/`rejected` 归还、`sent`/`delivery_unknown` 不归还、归还后重试重扣（§5.3/5.4） | 构造四态测试用例 + DB 断言 | ❌ 当前无 release 函数，`meterScheduledPost.ts` 只消耗不归还 |
| 发布 | social-only 路径已计量（§5.1） | `/api/publish/social` 无 Pinterest 目标时验证扣量 | ❌ 当前 0 处计量 |
| 图片 | 批量按用户自选张数扣量、API 容量上限文案化（裁决 5） | 前端提示语走查 | 待实施 |
| 全部三类 | 预留过期扫描器在跑 | crontab 验收记录 | ✅ 08-16 已验收 |
| 全部三类 | shadow 分布已被复核（避免切换日误伤） | 抽查生产 shadow 用量分布 | 待实施 |
| 全部三类 | 客服话术/宏已起草 | 客服文档链接 | 待实施 |
| 全部三类 | 有回滚路径 = 关闭对应开关 | 代码 review 确认关闭开关等价于 shadow | 待实施（开关未建，暂无法验证） |

### 14.1 "切换日"运行手册（stub）【v3.2 新增】

1. 先在测试库（`snulmwprsahzqvdbyenc`）验证：建负责人测试账号，触发切换，确认清零逻辑正确、事件写入正确。
2. 生产切换当天：负责人账号（`usage_accounts` 唯一一行）计数器归零；真实用户账户从当天起按新规则计数（无历史迁移）。
3. 记录切换时间戳，写入不可变审计事件，供日后追溯"切换日之前/之后"边界。
4. 分类型独立执行：图片/文本/发布可以在不同日期各自切换，互不阻塞。

---

## 15. Credit 0723 关系【v3.2 新增】

> 依据：`docs/prd/定价方案 credit 方案 0723 prd.txt`（v1.1）+ `0827 用量计量PRD-v3.1与Credit-0723 实现审查-fable.md` §2 + Codex 裁决 #14/#42。

- Credit 0723 PRD **§七 Billing 章节应直接引用本 PRD §11**，不再各写一份 Billing 展示要求（review §4-P，Codex 裁决 #24：消除重复来源是文书维护，不改变独立额度模式）。
- **P0 真实套餐与成本审计表**已产出：`docs/审查报告/0828 Credit-0723 P0 真实套餐与成本审计表-fable.md`（review §4-M：本审查报告 §1/§2 已是它的 80%，补齐 Creem 产品 ID 与 LinAPI 实际价格两列成稿）。
- **P3 成本监控现状**：`ai_cost_events` 表在生产**不存在**（探测 404）；`aiCostLog.ts` fail-safe，表不存在只回 `recorded:false`，自 07-31 起零成本数据且从未有报错提醒。`aiCostRates.ts` 三个模型费率仍是 `TODO`（`null`）。P3 三步（裁决 14 并行准备项）：
  1. apply `ai_cost_events` 迁移（纯建表+索引+RLS，`if not exists` 幂等）。**编号说明**：v58 撞号仍在 27+ 分支共存，`ai_cost_events` 若沿用旧编号应取当时可用的最新号（04-27 审查确定为 v64 起，需在实际改号当天重新扫描全部 worktree 确认）；`run_migration.py --sql <路径>` 按文件路径 apply、不按号，编号不阻塞 apply。
  2. 从 LinAPI 账单填 `aiCostRates.ts` 三个模型的真实费率。
  3. 给 `aiCostLog` 的 `recorded:false` 加**每日聚合告警**——fail-safe 本身是对的，但需要一个旁路可观测点防止再次静默丢 27 天数据。
- **P4 证据门槛（裁决 14）**：严格完成 Credit 0723 的四项前置（真实成本、真实套餐表、压力测算、用户理解测试）后才能进入 P4 决策；当前 P3 为零，**不能作出任何 Credit 是否上线、共池、权重、加购、结转、Auto-Refill 的商业结论**。允许现在**并行**启动的准备工作：P0 审计（已完成）、P3 成本采集（本节流程）、成本告警（本节流程）、用户理解测试的**研究设计**（不代表已获批的方案）。**累计 ≥30 天成本数据、且 shadow 用量分布覆盖足够的付费用户样本**后，才把 P4 列入评估议程（review §4-O 建议的数据门槛，非日期门槛）。
- 三项独立额度（图片/文本/发布）继续作为**唯一 MVP 契约**；Credit **不进入实施**，不得以任何形式提前上线加购/共池/权重等 Credit 概念（Codex 裁决 #14 结论段）。

---

## 16. 邀请奖励

本期只做 **Bonus AI images**，不做现金返现（涉税务、佣金支付、欺诈、退款、拒付、身份验证、财务对账）。架构保留未来 Affiliate 扩展性。

⚠️ **checkout 当前关闭，合格事件（首次付费）无法发生 → 奖励发放逻辑可开发，但上线必须等计费解冻。**

【v3.2】**状态：Phase 7 未开工**（同 §10，review §4-K）。

### 16.1 表

**referral_codes**：owner_user_id、code、active、created_at
**referral_relationships**：referrer_user_id、referred_user_id、attribution_at、status、qualifying_event、reward_status
**referral_rewards**：referrer_user_id、referred_user_id、bonus_images、source_payment_ref、pending_at、granted_at、reversed_at、reason、idempotency_key

### 16.2 归因

- 首次有效访问保存 referral code（`https://vibepin.co/?ref=ABC123`）
- 注册后绑定关系
- **不得在每次访问时覆盖已存在的有效归因**
- 不能邀请自己；一个新用户只能归属一个邀请人；同一笔付款只能产生一次奖励

### 16.3 合格条件

```text
1. 新用户通过有效 referral link 注册
2. 新用户不是邀请人本人
3. 新用户完成首次成功付费订阅
4. 付款未被退款或 Chargeback
5. 经过配置的观察期
6. 奖励正式到账
```

```ts
export const REFERRAL_REWARDS = {
  inviterBonusImages: 20,
  newUserBonusImages: 10,
  holdDays: 7,
  maxQualifiedReferralsPerMonth: 20,
};
```
**以上为建议默认值，必须可配置**，最终数值在启用前确认。

- 观察期内显示 `Pending`
- 到账显示 `20 bonus AI images added`
- 退款/撤销：Pending 直接取消；已发放的**创建独立 reverse 事件**，**不允许修改或删除历史记录**
- 撤销后若已用完 → 归零，**不为负**（决策 7）
- 推荐 webhook 必须幂等

### 16.4 防滥用

拦截/标记：自荐、同账户重复绑定、同一付款重复奖励、webhook 重试重复奖励、循环邀请、大量异常账号、免费注册直接拿完整奖励、退款后保留奖励、客户端伪造 referral 状态。

**IP 只能作为风险信号**，不得仅凭共享 IP 自动判定作弊。**不得在前端暴露被邀请用户的隐私信息**，只显示：`Pending referral` / `Qualified referral` / `Reward granted` / `Reward reversed`。

### 16.5 Referral 页面（Settings → Referrals）

```text
Invite friends, earn bonus AI images

Share your referral link. When a new user subscribes to an eligible paid
VibePin plan and the referral qualifies, you both receive bonus AI images.
```

显示：referral link、Copy button、奖励规则、Successful referrals、Pending referrals、Bonus AI images earned、每月上限、Referral Terms 链接。

条款须说明资格、反欺诈、奖励撤销、**奖励无现金价值**。

**禁止用词**：Cashback / Cash reward / Commission / Credits / Points。

---

## 17. Edge cases（必须在实现中覆盖）

| 场景 | 要求 |
|---|---|
| 图片部分成功 | 只按成功数量消耗（8.3） |
| 网络超时 | 释放预留，零消耗 |
| 用户重复点击 | 同一幂等键不重复扣 |
| Webhook 重试 | 不重复重置、不重复奖励 |
| 套餐升级 | 保留已用量，改用新上限（9.3） |
| 套餐降级 | 下周期生效（9.4） |
| 订阅取消 | 本周期保留至期末 |
| 【v3.2】订阅 Past due / 未知 | 保留最近已验证权益，暂停升级（9.4a） |
| 退款 | Pending 取消 / 已发放写 reverse |
| 更换邮箱 | 归属保持原 user ID（§12） |
| Workspace 成员变化 | 本期无 Workspace（1.12） |
| Billing API 暂不可用 | 展示上次已验证快照 + 非阻塞提示，**不得变 Free** |
| Worker 停摆 | 准入控制 + 清扫器（8.4） |
| 发布崩溃重认领 | 幂等键防重复扣（5.3） |
| 【v3.2】发布 not_sent/rejected/sent/delivery_unknown | 只有 `not_sent`/`rejected` 归还，其余不归还，归还后重试重扣（5.3/5.4） |
| 账号删除 | 财务流水匿名化保留 7 年（决策 9） |

---

## 18. 测试要求

【v3.2】enforce 前置验收清单见新 §14；本节测试仍是功能正确性的最低要求，不因 §14 而减少。

### 18.1 DB 集成测试通道是**前置条件**

SQL 评审 + `FakeSupabase` **不足以**保证并发正确性（1.14）。最小可行通道：

1. 独立的 Supabase 测试项目/一次性数据库，与 master 迁移一致
2. `backend/scripts/run_migration.py --apply` 应用候选迁移
3. 新增 `npx tsx scripts/test-usage-ledger-db.ts`
4. **注册进 `web/scripts/test-registry.ts`**（不注册会导致构建失败）；若不入快速套件，注册为显式外部 DB 测试并把 `npm run test:db` 设为强制发布门禁
5. 唯一 run ID 隔离并行运行
6. **至少 20 个并发预留 RPC** 打向只够部分成功的余额
7. 断言：精确成功数、余额非负、account/reservation/events 守恒、无重复幂等键
8. 并发重放相同 request_key 与相同 webhook 重置键
9. reserve-vs-expire、settle-vs-expire 竞态
10. service-role 可写 + anon/authenticated 直接访问表必须失败
11. 跨用户路由归属单独测试

⚠️ **缺少 DB 凭据时不得静默通过**；发布门禁必须失败或显式报告「强制 DB 套件未运行」。

### 18.2 功能断言

1. 成功生成 1 张消耗 1 次
2. 成功生成 4 张消耗 4 次
3. **部分成功只按成功数量消耗**
4. 生成失败不消耗
5. Moderation 拒绝不消耗
6. Moderation 服务失败不消耗
7. 额度不足时**不调用图片模型**
8. 并发请求不能超额
9. 相同 idempotency key 不重复扣
10. 重新生成正确扣量
11. **上传自己的图片不扣 AI image allowance**
12. 创建草稿不扣 Scheduled post
13. **Scheduled post 只扣一次**
14. **发布重试/崩溃重认领不重复扣量**
15. 月度重置不清除 Bonus AI images
16. 升级套餐保留已使用量
17. Billing 立即读取本地数据
18. Creem 刷新期间不会错误显示 Free
19. 用户 A 无法读取 B 的用量
20. 用户 A 无法消耗 B 的额度
21. 前端伪造 userId 无法绕过隔离
22. 自我邀请被拒绝
23. 同一付款不发两次奖励
24. 退款后奖励被取消或反转
25. Webhook 重试不重复重置/重复奖励
26. 换邮箱后套餐与用量仍属原账号
27. **多平台发布只扣 1 次**（决策 3）
28. **立即发布也扣 1 次**（决策 4）
29. **Business Unlimited 跳过检查但仍写事件**
30. **worker 停摆时预留被清扫器释放，迟到产出不发布**
31. **孤儿重认领不重复扣量**
32. **奖励撤销不产生负余额**（决策 7）
33. 【v3.2】social-only 发布（无 Pinterest 目标）也消耗 1 次（§5.1，裁决对应决策4应用）
34. 【v3.2】发布结果 `not_sent` / `rejected` 归还额度；`sent` / `delivery_unknown` 不归还（§5.3/5.4，裁决4）
35. 【v3.2】归还后同一 draft 再次成功发布，重新消耗 1 次，不因幂等键折叠为免费（§5.3a）
36. 【v3.2】请求图片数超剩余额度时弹出确认对话框，一键调整为剩余数量后可继续（裁决6）
37. 【v3.2】生产 `VERCEL_ENV=production` 且 `TEXT_MODEL_DEFAULT` 缺失/无效时，文本生成在调用供应商前拒绝并告警（裁决12）
38. 【v3.2】入队响应包含 `usage.reserved` / `usage.availableAfterReservation`；结算后状态接口包含 `usage.settledSuccess` / `usage.settledFailed`（裁决11）

### 18.3 文本额度专项断言

39. 一次完整文案（title+description+hashtags+altText 同时返回）**只消耗 1 次**
40. 重新生成再消耗 1 次；只重生成标题也是 1 次
41. **同一请求内部的质量门重试不额外计数**
42. `/api/ai-copy/analyze` 与 `/api/quality-judge` **不消耗文本额度**
43. 模型失败 / 超时 / 审核拒绝 / JSON 无效 / 空内容 **均不消耗**
44. **额度不足时不调用模型**
45. 文本并发请求不能突破额度（**须在真实 Postgres 上验证**）
46. 相同 idempotency key 不重复计数
47. **图片生成不消耗文本额度；文本生成不消耗图片额度**
48. 保存草稿、发布已有文案 **不消耗文本额度**
49. **客户端传入 `model` / `modelId` 不改变实际使用的模型**
50. 全体用户默认调用服务端配置的同一模型
51. **只改环境变量即可换模型，无需改业务代码**
52. 用户 A 不能读取/消耗用户 B 的文本用量

---

## 19. 迁移

- **迁移号：先检查未合并分支再定号**。【v3.2】截至 08-27 审查，下一个可用号为 **v64**（v63 已被 `integrate/multichannel-0827` 的 S4 占用；v58/v59 仍双号占用中，改号当天须重新扫描全部 worktree）。
- 必须**追加式 + 幂等**（`create table if not exists`、`add column if not exists`、`create index if not exists`）
- **RLS 启用、零宽松策略**（仅 service-role）
- 经 `backend/scripts/run_migration.py --apply` 应用，由用户执行
- 提供 dry-run 报告后再做破坏性变更
- **不得**删除现有 Creem customer/subscription 映射，**不得**破坏 Checkout 与 Webhook
- 无法确认的数据标 `review_required`，不猜测
- 那个 `34` 假 token 值**不迁移**（1.2）

---

## 20. 可观测性

结构化指标：生成尝试、成功消耗、释放预留、额度不足拒绝、周期重置、幂等去重命中、邀请奖励、奖励撤销、陈旧计费快照、外部计费刷新失败、**滞留预留数、结算失败数、守恒不变量违例**。【v3.2】新增：`ai_cost_events` 写入失败（`recorded:false`）的每日聚合告警（§15）；文本模型运行期 fail-closed 触发告警（§6.5）。

**禁止记录**：原始 prompt、API key、支付密钥、完整住址、客户端日志中的完整邀请风险数据。

**告警**：预留滞留超时、结算失败、守恒违例、重复尝试激增。

---

## 21. 实施阶段（不可一次性交付）

| 阶段 | 内容 | 依赖 | 完成判据 | 状态 |
|---|---|---|---|---|
| **1B-PR1** | 三个 AI 路由加认证 | — | 未认证零供应商调用 | ✅ **已上线** `aca1e57` / `dpl_3hSUA6UK` |
| **1B-PR2** | 按认证用户持久化限流（v53 迁移） | — | 超限零供应商调用；合法批量不被误伤 | 🔄 进行中 |
| **1D** | 文本生成边界加固：`TEXT_MODEL_DEFAULT` 单一配置源 + `textGenerationService` + 结构化输出校验 + 客户端 model 隔离 | 1B-PR2 后**立即做** | 服务契约/校验失败/模型输入隔离测试齐备 | 【v3.2】✅ 静态实现已完成，⚠️ 运行期 fail-closed 断言（裁决12）待补 |
| **1A** | 建真实 Postgres 集成测试通道 | — | 20 并发预留断言通过；缺凭据时**失败而非静默通过** | ✅ 已建（`test-db-*` 五个通道） |
| **1C** | 验证既有计费镜像 + 去 Credit 文案（160 值 ×20 语言 + 6 硬编码）+ **移除假 34** | —（可并行） | 本地读取/优先级/不闪 Free；i18n 门禁通过 | 部分完成，见 §2.2/§3.3 |
| **2** | 落地休眠态用量原语（schema + RPC，**不启用**）—— 覆盖全部三种额度含文本预留/结算/幂等/权益字段 | 1A | DB 并发套件全绿 | ✅ v55/v56 已 apply 生产 |
| **3** | 周期初始化/重置与订阅联动 | 1C + 2 | 重置幂等、升级/降级/取消/初始化正确 | 【v3.2】部分完成；年付子周期（9.1）、切换日建账（9.5）、9.4a 待实施 |
| **4I** | AI image 计量接入（TS 预留 + Python 按槽结算） | 2 + 3 | 全部图片入口接入，**enforcement 仍关闭** | ✅ 已接入（shadow） |
| **4T** | AI text 计量接入 | 1A + 2 + 3 | 全部文案入口接入，**enforcement 仍关闭** | ✅ 已接入（shadow） |
| **5A** | 统一发布动作与投递状态机（`publish_action_id`、`not_sent/rejected/sent/delivery_unknown`） | — | 四条发布路径统一；立即/定时同一契约 | 【v3.2】❌ 待办，是 §5.3 四态的前置 |
| **5B** | Scheduled post 计量接入 | 2 + 5A | 多平台 1 次、立即发布 1 次、重认领不重复、release 归还（§5.3/5.4） | 【v3.2】部分完成：消耗已接入，release/归还未接入 |
| **NEW** | 连接账号数执行（F9：目前零执行） | 2 | 每平台账号数按套餐生效 | 待办 |
| **6A** | **文本** enforce 切换 | 4T + §14 就绪清单全绿 + 独立开关 | 生产定价页显示 20/500/2000/10000 后才开开关 | 待办 |
| **6B** | **图片** enforce 切换 | 4I + worker 带凭据且健康 + 清扫器可用 + §14 就绪清单全绿 | DB 套件全绿、路由覆盖审计通过、回滚就绪 | 待办 |
| **6C** | **发布** enforce 切换 | 5B + 全部发布路径已统一 + §14 就绪清单全绿 | 同上 | 待办 |
| **7** | 邀请归因与奖励 | 2 之后可开发 | **上线须待计费解冻** | ❌ **未开工**（§10/§16） |

**为何把 Phase 6 按额度拆分**：文本是同步路径、不依赖 Python 图片 worker；把三者绑在一个切换上，会让文本执行被当前**禁用中**的图片 worker 无谓阻塞。

**Phase 1D 为何插在最前**：它完全不依赖用量账本（单一模型配置源、服务抽象层、结构化校验、拒绝客户端 model），是 1B 之后最干净的一刀，且为 4T 铺好地基。

---

## 22. 不可违反的约束

- 不破坏既有 Creem 审核合规门（每字段 + composite、fail-closed、早于任何 enqueue/FastAPI/inline 分发）
- 不改 Creem 产品价格、checkout 链接、产品 ID、webhook secret、订阅映射
- 不启用 checkout、不改 `CREEM_MODE`（当前 `disabled`）
- 不为授权目的读取 `user_metadata`
- 不回归既有 Shopify `maxStores`/`maxSyncedProducts` 执行
- 迁移追加式幂等、RLS 零策略、经 run_migration.py 应用
- Python worker 当前**禁用**，设计必须定义结算侧停摆时的正确行为
- inline/FastAPI 的匿名放行是既定文档化决策，**变更必须显式声明，不得静默**
- 【v3.2】Credit 不进入实施（裁决14）；三项独立额度不重开为共池/权重制

---

## 23. 五大风险与守护

| # | 风险 | 守护 |
|---|---|---|
| 1 | 并发超额使用 | 行锁 SQL RPC、条件余额检查、唯一键、守恒不变量、**真实 Postgres 并发测试** |
| 2 | 重认领/部分成功/worker 停摆导致重复扣量或额度悬挂 | 按槽状态机、job 关联预留、仅终态释放、租约检查、独立清扫器、settle/expire 竞态测试 |
| 3 | 未认证/未计量路由绕过供应商成本 | 供应商调用全量清单、生产端认证边界、认证早于审核、**「每次供应商调用必须持有有效预留」的测试** |
| 4 | 发布崩溃重认领导致重复扣 Scheduled post | **认领时**写幂等用量事件（非成功事件），唯一约束防重 |
| 5 | 展示额度与实际消耗不符 | 1 图 = 1 次、单一配置源、生成前披露、文本不扣量、启用前复核定价文案 |

---

## 24. 最终报告要求

完成后须明确报告：修改的代码文件、修改的 PRD、每个套餐的最终限制、**套餐限制的唯一数据来源**、AI 图片扣量规则、Scheduled post 扣量规则（含 §5.3 四态归还语义）、文字生成是否有限制、Bonus AI images 存储方式、Billing 加载优化方式、本地 subscription snapshot 同步方式、账号隔离方式、Referral 奖励规则、防重复与防作弊方式、数据库迁移结果、自动化测试结果、TypeScript 检查结果、Production build 结果、**是否存在任何可绕过用量统计的生成或发布路径**、**§14 enforce 就绪清单每一项的验收证据**。

**不要只完成 UI。** 只有在所有图片生成入口、发布入口、Webhook、订阅周期与账号隔离全部连接后，才能宣布完成。

**若任何生成或发布路径可以绕过用量统计，不得声称完成。**

---

## v3.1 → v3.2 变更清单

| # | 变更 | 依据 |
|---|---|---|
| 1 | 基线字段改为"deploymentId + 祖先 SHA"定义，值更新为 `dpl_GdtGTzX3`=`5bcc1a6`，候选 `80631ec9` | review §4-L，Codex 裁决 #21 |
| 2 | 撤销 v3.1 决策 5（批量单批张数按套餐限制）；改为用户自选张数、API 硬顶为技术容量限制 | 产品裁决 #5 |
| 3 | §2.1 删除"批量单批张数"行；新增"额外账号付费（S4）"待确认占位行 | 产品裁决 #5；产品裁决记录末尾"待负责人另行确认" |
| 4 | §2.2 新增决策 13 提议措辞子节 2.2.1（Product management "—"；Calendar "Limited"+定义），标"待负责人确认" | 产品裁决 #13 |
| 5 | §3.3 明确 `lowTokenBalance` 键保留，仅改展示文案 | review §4-I，Codex 裁决 #18 |
| 6 | §4.3 请求数超剩余额度：统一为选项 B（弹确认+一键改剩余数） | 产品裁决 #6 |
| 7 | §5.1 补写"向任一平台发布均消耗 1 次"，`/api/publish/social` 无 Pinterest 目标时也计量 | review §4-D，Codex 裁决 #15 |
| 8 | §5.3/§5.4 全面重写为 `not_sent/rejected/sent/delivery_unknown` 四态（08-28 二次修正：`not_sent` 与 `rejected` 拆开为两态，均归还）；新增 §5.3a 防重武装/防免费重试漏洞说明 | 产品裁决 #4，`docs/设计/用量计量-退额四态与年付子周期-设计-20260828.md` §A.1，Codex 裁决 #36/#37 |
| 9 | §6.2 补写裁决 9（无需通知存量付费用户）与裁决 8（三个独立开关的具体形态） | 产品裁决 #8/#9 |
| 10 | §6.5 明确 fail-closed = 部署门禁+运行期断言（仅生产）+告警；注明 `AI_COPY_TEXT_MODEL` 是 `TEXT_MODEL_DEFAULT` 的实际变量名 | 产品裁决 #12 |
| 11 | §8.5 入队响应补 `usage.reserved`/`usage.availableAfterReservation`；结算状态接口补 `usage.settledSuccess`/`usage.settledFailed` | 产品裁决 #11 |
| 12 | §9.1 新增年付月度子周期（锚点=订阅生效日，付费仍按年） | 产品裁决 #2 |
| 13 | §9.4 新增 9.4a 订阅异常状态权益（Canceled/Past due/未知/Expired） | 产品裁决 #10 |
| 14 | §9.5 全面重写：建账策略（付费预建/Free惰性）+"切换日"定义（负责人账号清零、真实用户无历史）+ 无宽限 | 产品裁决 #1/#3/#7 |
| 15 | §10、§11.3、§16（原§14）标注"Phase 7 未开工" | review §4-K，Codex 裁决 #20 |
| 16 | 新增 §14「enforce 就绪清单」+ 14.1 切换日运行手册 stub | review §4-G，Codex 裁决 #16 |
| 17 | 新增 §15「Credit 0723 关系」：P0/P3/P4 现状与门槛、迁移编号建议 v64、Billing 引用统一 | review §4-M/N/O/P，产品裁决 #14，Codex 裁决 #24 |
| 18 | §17（原§17 迁移）迁移号更新为下一个可用号 v64 | review §4-N |
| 19 | §18（原§16 测试要求）新增 33–38 号断言，覆盖 social-only 计量、四态归还、防重扣、超额确认、fail-closed、响应字段 | 对应各产品裁决 |
| 20 | §21（原§19 实施阶段）状态列按 08-27 审查更新，1A/2/4I/4T 标记已完成，5A/5B/7 标记缺口 | review §1 表 |
| 21 | 原 §14 起全部章节顺序 +2（邀请奖励→§16 等），因插入新 §14/§15 | 结构调整，见开头"结构说明" |
| 22 | §0 决策表行 5 标记撤销并给出新表述；新增 §0.1 追加裁决表（14 项） | 产品裁决记录全文 |

---
