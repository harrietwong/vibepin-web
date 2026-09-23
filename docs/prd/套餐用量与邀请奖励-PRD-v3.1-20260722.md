# VibePin 套餐用量计量与邀请奖励 — PRD v3.1

- **版本**：v3.1 —— 取代 v3.0 / v2.0（`套餐额度账本与推荐返现-PRD-v2.0-20260722.md`）/ v1.0（`修改套餐账本套餐用量与新增额度返现功能prd0721.txt`）
- **日期**：2026-07-22
- **基线**：master `aca1e57`
- **根本原则**：**废弃 Credit / Points / 积分抽象层**。用户直接看到真实单位：AI images、AI text generations、Scheduled posts、Bonus AI images。用户不需要理解「一次生成等于几个 Credit」。
- **状态**：产品契约已冻结（§0 决策全部落定）。实施必须**分阶段**，不可一次性交付。

### v3.1 变更说明

> **补充决策取代 v3.0 冻结决策 8。文本生成改为可量化、独立执行的额度。v3.0 其余不冲突的决策一律保持冻结。**

同时新增：文本模型单一服务端配置源、`textGenerationService` 抽象层、结构化输出校验；阶段计划新增 **1D** 与 **4T**，并把 Phase 6 按额度类型拆为 **6A/6B/6C**。

---

## 0. 已决策事项（本版全部落定，实施时不得再改）

| # | 决策 | 说明 |
|---|---|---|
| 1 | **1 张成功图片 = 1 次 AI image allowance** | 公示数字不变：10 / 150 / 800 / 3,000 |
| 2 | **不存在「高级模型」** | 所有套餐同一模型，高级套餐只是量更大。`pricingPlans.ts:266-269` 的 "premium model generations may use more" **必须删除** |
| 3 | **多平台发布 = 按内容算 1 次** | 一次点击发到 Pinterest+IG+TikTok 只扣 1 次 Scheduled post |
| 4 | **Scheduled post 额度覆盖所有发布**（含立即发布） | 否则「改成立即发布」就是免费绕过通道 |
| 5 | **批量生成上限**：Free 不支持 / Starter 4 张每批 / Pro 10 张每批 / Business 10 张每批 | 填补定价页 "Limited" 的空白定义 |
| 6 | **Free 套餐周期锚点 = 账号注册成功时刻**，按滚动月推进 | 无 Creem 订阅，故不能用订阅周期 |
| 7 | **不允许负余额** | 奖励撤销时若额度已用完，余额归零并阻断新生成，不追讨、不为负 |
| 8 | ~~文本生成本期不限量、不扣量~~ → **【v3.1 取代】文本生成独立计量并执行额度**：Free 20 / Starter 500 / Pro 2,000 / Business 10,000 | **一次完整文案请求 = 1 次**，无论同时返回 title/description/hashtags/altText。⚠️ **必须先公示数字再开启执行**，见 §6 |
| 9 | **账号删除后财务流水匿名化保留 7 年** | 删除时以匿名 ID 替换 user_id，保留金额与时间用于对账，丢弃身份信息 |
| 10 | **用户不可选择文本模型** | 全体用户使用同一默认模型，模型 ID 只存在于服务端配置层；服务端**忽略**客户端传入的任何 model 字段 |
| 11 | **不实现 `internalCostWeight`** | 投机性结构，与「不要过度设计」冲突。列入 Future Phase，待真正出现多模型成本路由需求时再加 |

---

## 1. 现状事实（已核实，覆盖 v1.0/v2.0 的错误前提）

> 每条均有 file:line 证据。与之冲突的旧表述一律作废。

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

123 个注册测试，**100% 内存假件/模块 mock，零 DB 集成先例**。`FakeSupabase` 字典会让 Postgres 本能串行化的竞态「通过」。

---

## 2. 唯一服务端套餐配置源

```ts
type PlanEntitlements = {
  planKey: PlanKey;                    // free | starter | pro | business
  displayName: string;
  monthlyAiImages: number | null;      // null = unlimited
  monthlyAiTextGenerations: number | null;  // v3.1：当前无套餐使用 null
  monthlyScheduledPosts: number | null;
  connectedAccountsPerPlatform: number | null;
  connectedPlatforms: number | null;
  maxBatchSize: number;                // 0 = 不支持批量
  maxStores: number;                   // 既有 Shopify（不得回归）
  maxSyncedProducts: number;
  rank: number;
  creemProductIds: string[];
  features: {
    aiImageGeneration: boolean;
    aiTextGeneration: boolean;         // v3.1
    scheduling: boolean;
    batchGeneration: boolean;
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
| **批量单批张数** | 0（不支持） | **4** | **10** | **10** | 【决策 5】填补 "Limited" |
| **AI text generations / 月** | **20** | **500** | **2,000** | **10,000** | 【v3.1 决策 8】⚠️ **定价页尚未公示，必须先公示再执行**，见 §6.2 |
| Shopify 店铺 | 0 | 1 | 2 | 3 | 既有 `entitlements.ts:36-39` |
| Shopify 同步商品 | 0 | 100 | 500 | 1000 | 既有，env 可覆盖 |

**前端、后端、Billing、Pricing、权限判断必须读取同一份配置。** `pricingPlans.ts` 的展示字符串应由该配置派生，杜绝数字漂移。

### 2.2 必须修正的既有文案

| 位置 | 问题 | 处理 |
|---|---|---|
| `pricingPlans.ts:266-269` | 承诺"高级模型消耗更多 credits"，但**无高级模型** | **删除该句** |
| `pricingPlans.ts:203` 等 | "AI image credits" | 改为 "AI images" |
| `en.ts:122` `billing.freeDesc` | "up to 2 boards and limited AI credits" —— **"2 boards" 在别处不存在**，与"1 account on 1 platform"矛盾 | 重写，×20 语言 |
| `pricingPlans.ts:226` | Calendar planning Free 值为 `"Basic"`，违反该文件自身 L5-7 的取值规则 | 归一为 `"Limited"` 或给出定义 |
| Free `"Product management: Limited"`（`:233`） | 但 `entitlements.ts:36` 是 `maxStores: 0`，Free 根本连不了店 | 文案与执行对齐 |

### 2.3 禁止默认降级为 Free

**任何位置读取不到套餐时，不得默认按 Free 处理。** 必须区分「确认为 Free」与「暂时读不到」，后者保持上一次已验证状态并显示刷新提示。

---

## 3. 用户侧术语（全面去 Credit 化）

### 3.1 允许的单位

```text
AI images
AI text generations      ← v3.1 新增
Scheduled posts
Bonus AI images
```

**同时禁止在用户界面出现的模型信息**（v3.1 决策 10）：

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

**另有 6 处硬编码组件**：`NotificationPreferencesCard.tsx:27`（`lowTokenBalance` **是持久化偏好键，改名有存量数据迁移含义**）、`SettingsModal.tsx:508`（testId）、`SupportChat.tsx:269,350`、`DraftDetailsDrawer.tsx:1687-1689`（testId + 种子文案）、`admin/users/[id]/page.tsx:217`（管理端）、`lib/assistant/knowledge.ts:48`（检索关键词，非展示）。

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

**请求 4 张但只剩 2 张**：阻止请求并提示，或明确允许用户调整为 2 张。**不得静默生成，不得产生负额度。**

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

### 5.2 计数锚点

以 **`pin_drafts` 行 + 一次发布动作** 为计数单位，而非 `social_publish_job_destinations` 行数。发布记录必须携带幂等键，使同一内容的同一次发布动作只计一次，无论扇出到几个平台。

### 5.3 重试与崩溃不得重复扣量（关键）

因 `/api/cron/publish-due` 已知的 at-least-once 行为（1.5），**计数不可基于「发布成功事件」**。必须：
- 在**认领时**写入带唯一约束的用量事件（`UNIQUE(idempotency_key)`），键含 draft_id + 计划时刻
- 重认领命中同一键 → 幂等无操作，**不重复扣**
- 发布最终失败：按 5.4 规则处理

### 5.4 取消与失败的额度归还

- **用户在执行前取消定时发布** → **归还**额度（写 `release` 事件）
- **发布最终失败且从未真正投递** → **归还**额度
- **系统已真实执行过投递**（即使后续报错）→ **不归还**，且不重复扣
- 既有实现在失败时会清空 `scheduled_at` 以避免重试风暴（`publishDueLogic.ts:120-155`），归还逻辑须与之对齐

### 5.5 Business 的 Unlimited

`monthlyScheduledPosts: null` 表示不限量：跳过额度检查，但**仍写用量事件**用于统计与滥用观察。

---

## 6. AI text generation 用量规则【v3.1 取代旧决策 8】

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
1. 合入 v3.1 产品契约
2. 定价页公示 20 / 500 / 2,000 / 10,000
3. 验证生产定价页确实显示了正确数字
4. 再通过服务端特性开关启用文本额度执行
```

**绝不允许先开执行、指望定价页事后补上。** 同一次部署可同时包含两者，但**执行开关必须保持关闭，直到公开定价页验证通过**。

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

### 6.5 文本模型统一配置（决策 10）

- 单一服务端配置源 `TEXT_MODEL_DEFAULT`，模型 ID **不得**硬编码于页面组件、API 路由、Server Action、数据库业务逻辑、Pricing、Billing 或任何生成按钮
- 生产环境缺失或无效的 `TEXT_MODEL_DEFAULT` → **在调用供应商之前 fail-closed**
- **不保留**文案模型的多环境回退链（供应商 endpoint / API key 配置可另行保留）
- **不得**把 `TEXT_MODEL_DEFAULT` 套用到视觉分析：`visionModel` 是独立的内部关注点
- 业务路由调用 `textGenerationService`，**绝不**直接调用 Gemini / OpenAI 兼容 SDK
- 客户端传入的 `model` / `modelId` 等字段一律**丢弃**并使用默认模型 —— 治理行为是「忽略」，不是「报错」，更不是「照它给的模型执行」

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
ai_text_generations_used -- v3.1：受额度约束，与图片/发布完全独立
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
2. **独立清扫器**：Postgres 函数 + 经验证的 Supabase `pg_cron`（**启用前须确认扩展与调度器可用**），并在每次新预留前机会性调用同一过期函数。清扫器必须：只释放已过期且 job 无活跃租约的 pending 槽；把 job 标记为 canceled/failed 防止重启的 worker 再调供应商；恢复 Bonus；**套餐额度仅在原周期仍有效时恢复**（过期周期的额度不得变成新周期的额度）；写不可变 release/expiration 事件。
3. **竞态**：worker 认领时原子校验 reservation 为 open 且未过期；过期后的结算 fail-closed，**迟到产出不得发布**。
4. **TTL**：大于最大合法排队+供应商耗时，可配置且有绝对上限。用户可取消未开始处理的 job 以释放预留。

### 8.5 API 响应语义

异步入队路由**只预留、不结算**，因此**不能**返回最终消耗量：

```json
{ "jobId": "...",
  "usage": { "aiImagesReserved": 4, "maximumCharge": 4, "aiImagesAvailableAfterReservation": 146 } }
```

最终消耗量由**轮询/状态接口**在结算后给出。同步路径可直接返回最终值。

**服务端计算全部用量，绝不信任客户端传来的数量。**

---

## 9. 周期重置

### 9.1 锚点

- **付费套餐**：跟随 Creem 实际订阅周期
- **Free 套餐**：**账号注册成功时刻**，按滚动月推进【决策 6】

存储：`period_start` / `period_end` / `next_reset_date` / `last_reset_event` / `period_anchor`。

### 9.2 续费

Creem 续费成功后：更新本地订阅快照 → 创建新使用周期 → 当期用量重置为 0 → **每次续费只执行一次** → **Webhook 重试不得重复重置**（唯一约束键 = 订阅 + 周期）。

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

### 9.5 存量用户初始化

- **禁止**从 `accountSummary`、`token_balance`、`user_metadata` 导入余额（部分路径**用户可写**，不可作为财务状态）。那个 `34` 是假值，**不迁移**。
- 因无历史用量，已消耗量无法重建 → **每个已验证的当前周期初始化一次 usage_account，用量从 0 起算**。
- 订阅状态未知者标记 `review_required`，**不猜测**。
- **不得**把存量用户重置为 Free；**不得**在部署时给所有用户重复发放。
- 破坏性变更前提供 **dry-run 报告**。

---

## 10. Bonus AI images（邀请奖励额度）

- 名称统一为 **Bonus AI images**，不叫 Credit。
- 与套餐额度**分开保存、分开显示**。
- 优先消耗本周期会过期的套餐额度，再消耗 Bonus。
- 正常月度重置**不清除** Bonus；仅在显式设置了到期时间时才过期。
- **不允许负余额**【决策 7】：奖励撤销时若 Bonus 已用完，余额归零并阻断新生成，**不追讨、不为负**。撤销必须写独立的 `reverse` 事件，**绝不修改或删除历史记录**。

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

⚠️ **分阶段上线期间（v3.1）：某种额度的真实来源尚未上线时，不得为它展示编造的计数器。** 最终完成态才三条进度条齐全；在此之前只展示已有真实数据的那几条。

### 11.3 头部入口

```text
118 AI images left        →  点击进入 Billing/Usage
```
或多限制时简化为 `View usage`。

**必须移除** `EXISTING_APP_TOKEN_BALANCE = 34` 及其全部渲染点。

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

## 14. 邀请奖励

本期只做 **Bonus AI images**，不做现金返现（涉税务、佣金支付、欺诈、退款、拒付、身份验证、财务对账）。架构保留未来 Affiliate 扩展性。

⚠️ **checkout 当前关闭，合格事件（首次付费）无法发生 → 奖励发放逻辑可开发，但上线必须等计费解冻。**

### 14.1 表

**referral_codes**：owner_user_id、code、active、created_at
**referral_relationships**：referrer_user_id、referred_user_id、attribution_at、status、qualifying_event、reward_status
**referral_rewards**：referrer_user_id、referred_user_id、bonus_images、source_payment_ref、pending_at、granted_at、reversed_at、reason、idempotency_key

### 14.2 归因

- 首次有效访问保存 referral code（`https://vibepin.co/?ref=ABC123`）
- 注册后绑定关系
- **不得在每次访问时覆盖已存在的有效归因**
- 不能邀请自己；一个新用户只能归属一个邀请人；同一笔付款只能产生一次奖励

### 14.3 合格条件

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
- 撤销后若已用完 → 归零，**不为负**【决策 7】
- 推荐 webhook 必须幂等

### 14.4 防滥用

拦截/标记：自荐、同账户重复绑定、同一付款重复奖励、webhook 重试重复奖励、循环邀请、大量异常账号、免费注册直接拿完整奖励、退款后保留奖励、客户端伪造 referral 状态。

**IP 只能作为风险信号**，不得仅凭共享 IP 自动判定作弊。**不得在前端暴露被邀请用户的隐私信息**，只显示：`Pending referral` / `Qualified referral` / `Reward granted` / `Reward reversed`。

### 14.5 Referral 页面（Settings → Referrals）

```text
Invite friends, earn bonus AI images

Share your referral link. When a new user subscribes to an eligible paid
VibePin plan and the referral qualifies, you both receive bonus AI images.
```

显示：referral link、Copy button、奖励规则、Successful referrals、Pending referrals、Bonus AI images earned、每月上限、Referral Terms 链接。

条款须说明资格、反欺诈、奖励撤销、**奖励无现金价值**。

**禁止用词**：Cashback / Cash reward / Commission / Credits / Points。

---

## 15. Edge cases（必须在实现中覆盖）

| 场景 | 要求 |
|---|---|
| 图片部分成功 | 只按成功数量消耗（8.3） |
| 网络超时 | 释放预留，零消耗 |
| 用户重复点击 | 同一幂等键不重复扣 |
| Webhook 重试 | 不重复重置、不重复奖励 |
| 套餐升级 | 保留已用量，改用新上限（9.3） |
| 套餐降级 | 下周期生效（9.4） |
| 订阅取消 | 本周期保留至期末 |
| 退款 | Pending 取消 / 已发放写 reverse |
| 更换邮箱 | 归属保持原 user ID（§12） |
| Workspace 成员变化 | 本期无 Workspace（1.12） |
| Billing API 暂不可用 | 展示上次已验证快照 + 非阻塞提示，**不得变 Free** |
| Worker 停摆 | 准入控制 + 清扫器（8.4） |
| 发布崩溃重认领 | 幂等键防重复扣（5.3） |
| 账号删除 | 财务流水匿名化保留 7 年【决策 9】 |

---

## 16. 测试要求

### 16.1 DB 集成测试通道是**前置条件**

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

### 16.2 功能断言

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

### 16.3 文本额度专项断言【v3.1 新增】

33. 一次完整文案（title+description+hashtags+altText 同时返回）**只消耗 1 次**
34. 重新生成再消耗 1 次；只重生成标题也是 1 次
35. **同一请求内部的质量门重试不额外计数**
36. `/api/ai-copy/analyze` 与 `/api/quality-judge` **不消耗文本额度**
37. 模型失败 / 超时 / 审核拒绝 / JSON 无效 / 空内容 **均不消耗**
38. **额度不足时不调用模型**
39. 文本并发请求不能突破额度（**须在真实 Postgres 上验证**）
40. 相同 idempotency key 不重复计数
41. **图片生成不消耗文本额度；文本生成不消耗图片额度**
42. 保存草稿、发布已有文案 **不消耗文本额度**
43. **客户端传入 `model` / `modelId` 不改变实际使用的模型**
44. 全体用户默认调用服务端配置的同一模型
45. **只改环境变量即可换模型，无需改业务代码**
46. 生产环境缺失/无效 `TEXT_MODEL_DEFAULT` → **调用供应商前 fail-closed**
47. 用户 A 不能读取/消耗用户 B 的文本用量

---

## 17. 迁移

- **迁移号：先检查未合并分支再定号**。master 最高为 v52，但 v45、v29 已各出现重复，此前有过 v51/v52 碰撞。
- 必须**追加式 + 幂等**（`create table if not exists`、`add column if not exists`、`create index if not exists`）
- **RLS 启用、零宽松策略**（仅 service-role）
- 经 `backend/scripts/run_migration.py --apply` 应用，由用户执行
- 提供 dry-run 报告后再做破坏性变更
- **不得**删除现有 Creem customer/subscription 映射，**不得**破坏 Checkout 与 Webhook
- 无法确认的数据标 `review_required`，不猜测
- 那个 `34` 假 token 值**不迁移**（1.2）

---

## 18. 可观测性

结构化指标：生成尝试、成功消耗、释放预留、额度不足拒绝、周期重置、幂等去重命中、邀请奖励、奖励撤销、陈旧计费快照、外部计费刷新失败、**滞留预留数、结算失败数、守恒不变量违例**。

**禁止记录**：原始 prompt、API key、支付密钥、完整住址、客户端日志中的完整邀请风险数据。

**告警**：预留滞留超时、结算失败、守恒违例、重复尝试激增。

---

## 19. 实施阶段（不可一次性交付）

| 阶段 | 内容 | 依赖 | 完成判据 | 状态 |
|---|---|---|---|---|
| **1B-PR1** | 三个 AI 路由加认证 | — | 未认证零供应商调用 | ✅ **已上线** `aca1e57` / `dpl_3hSUA6UK` |
| **1B-PR2** | 按认证用户持久化限流（v53 迁移） | — | 超限零供应商调用；合法批量不被误伤 | 🔄 进行中 |
| **1D** | **【v3.1 新增】文本生成边界加固**：`TEXT_MODEL_DEFAULT` 单一配置源 + `textGenerationService` + 结构化输出校验 + 客户端 model 隔离 | 1B-PR2 后**立即做**（无账本依赖） | 服务契约/校验失败/模型输入隔离测试齐备 | 待办 |
| **1A** | 建真实 Postgres 集成测试通道 | — | 20 并发预留断言通过；缺凭据时**失败而非静默通过** | 待办 |
| **1C** | 验证既有计费镜像 + 去 Credit 文案（160 值 ×20 语言 + 6 硬编码）+ **移除假 34** | —（可并行） | 本地读取/优先级/不闪 Free；i18n 门禁通过 | 待办 |
| **2** | 落地休眠态用量原语（schema + RPC，**不启用**）—— **覆盖全部三种额度**含文本预留/结算/幂等/权益字段 | 1A | DB 并发套件全绿 | 待办 |
| **3** | 周期初始化/重置与订阅联动 | 1C + 2 | 重置幂等、升级/降级/取消/初始化正确 | 待办 |
| **4I** | AI image 计量接入（TS 预留 + Python 按槽结算） | 2 + 3 | 全部图片入口接入，**enforcement 仍关闭** | 待办 |
| **4T** | **【v3.1 新增】AI text 计量接入** | 1A + 2 + 3（**不依赖 Python worker**） | 全部文案入口接入，**enforcement 仍关闭** | 待办 |
| **5A** | 统一发布动作与投递状态机（`publish_action_id`、`delivery_unknown`） | — | 四条发布路径统一；立即/定时同一契约 | 待办 |
| **5B** | Scheduled post 计量接入 | 2 + 5A | 多平台 1 次、立即发布 1 次、重认领不重复 | 待办 |
| **NEW** | 连接账号数执行（F9：目前零执行） | 2 | 每平台账号数按套餐生效 | 待办 |
| **6A** | **文本**定价公示 + Billing + enforcement 切换 | 4T + **定价页已公示并验证** | 生产定价页显示 20/500/2000/10000 后才开开关 | 待办 |
| **6B** | **图片** enforcement 切换 | 4I + worker 带凭据且健康 + 清扫器可用 | DB 套件全绿、路由覆盖审计通过、回滚就绪 | 待办 |
| **6C** | **发布** enforcement 切换 | 5B + 全部发布路径已统一 | 同上 | 待办 |
| **7** | 邀请归因与奖励 | 2 之后可开发 | **上线须待计费解冻** | 待办 |

**为何把 Phase 6 按额度拆分**：文本是同步路径、不依赖 Python 图片 worker；把三者绑在一个切换上，会让文本执行被当前**禁用中**的图片 worker 无谓阻塞。

**Phase 1D 为何插在最前**：它完全不依赖用量账本（单一模型配置源、服务抽象层、结构化校验、拒绝客户端 model），是 1B 之后最干净的一刀，且为 4T 铺好地基。

---

## 20. 不可违反的约束

- 不破坏既有 Creem 审核合规门（每字段 + composite、fail-closed、早于任何 enqueue/FastAPI/inline 分发）
- 不改 Creem 产品价格、checkout 链接、产品 ID、webhook secret、订阅映射
- 不启用 checkout、不改 `CREEM_MODE`（当前 `disabled`）
- 不为授权目的读取 `user_metadata`
- 不回归既有 Shopify `maxStores`/`maxSyncedProducts` 执行
- 迁移追加式幂等、RLS 零策略、经 run_migration.py 应用
- Python worker 当前**禁用**，设计必须定义结算侧停摆时的正确行为
- inline/FastAPI 的匿名放行是既定文档化决策，**变更必须显式声明，不得静默**

---

## 21. 五大风险与守护

| # | 风险 | 守护 |
|---|---|---|
| 1 | 并发超额使用 | 行锁 SQL RPC、条件余额检查、唯一键、守恒不变量、**真实 Postgres 并发测试** |
| 2 | 重认领/部分成功/worker 停摆导致重复扣量或额度悬挂 | 按槽状态机、job 关联预留、仅终态释放、租约检查、独立清扫器、settle/expire 竞态测试 |
| 3 | 未认证/未计量路由绕过供应商成本 | 供应商调用全量清单、生产端认证边界、认证早于审核、**「每次供应商调用必须持有有效预留」的测试** |
| 4 | 发布崩溃重认领导致重复扣 Scheduled post | **认领时**写幂等用量事件（非成功事件），唯一约束防重 |
| 5 | 展示额度与实际消耗不符 | 1 图 = 1 次、单一配置源、生成前披露、文本不扣量、启用前复核定价文案 |

---

## 22. 最终报告要求

完成后须明确报告：修改的代码文件、修改的 PRD、每个套餐的最终限制、**套餐限制的唯一数据来源**、AI 图片扣量规则、Scheduled post 扣量规则、文字生成是否有限制、Bonus AI images 存储方式、Billing 加载优化方式、本地 subscription snapshot 同步方式、账号隔离方式、Referral 奖励规则、防重复与防作弊方式、数据库迁移结果、自动化测试结果、TypeScript 检查结果、Production build 结果、**是否存在任何可绕过用量统计的生成或发布路径**。

**不要只完成 UI。** 只有在所有图片生成入口、发布入口、Webhook、订阅周期与账号隔离全部连接后，才能宣布完成。

**若任何生成或发布路径可以绕过用量统计，不得声称完成。**
