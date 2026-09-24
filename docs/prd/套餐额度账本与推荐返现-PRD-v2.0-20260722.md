# VibePin 额度账本 / 用量计量 / 推荐奖励 — PRD v2.0

- **版本**：v2.0（取代 `修改套餐账本套餐用量与新增额度返现功能prd0721.txt` v1.0）
- **日期**：2026-07-22
- **基线**：master `581f6b3`
- **状态**：待排期。**不可作为单一任务实施** —— 见 §0 裁决。

---

## 0. 裁决：拆分实施，不得一次性交付

v1.0 把「新建财务账本 + 跨语言异步结算 + 计费周期发放 + 认证改造 + 四个 AI 入口 + UI 替换 + 涉欺诈的推荐系统」压在一个任务里。经代码侦察与独立终审，v1.0 中关于「已有额度系统」「Billing 页慢」「单一生成入口」的前提**与代码事实不符**。按 v1.0 原样实施，极可能造成重复扣费、额度悬挂、供应商成本绕过、或订阅发放错误。

**本 PRD 的实施顺序（详见 §21）**：

| 阶段 | 内容 | 依赖 |
|---|---|---|
| Phase 0 | 冻结产品/记账契约（本文档即产出） | — |
| Phase 1A | 建真实 Postgres 集成测试通道 | Phase 0 |
| Phase 1B | 收口 AI 供应商边界（3 个未认证路由） | Phase 0（可与 1A 并行） |
| Phase 1C | 验证既有计费镜像 | Phase 0（可与 1A/1B 并行） |
| Phase 2 | 落地休眠态记账原语（schema + RPC，不启用） | 0 + 1A |
| Phase 3 | 订阅周期发放 | 1C + 2 |
| Phase 4 | 生成计量接入（同步文本路径 / 异步图片路径可并行） | 2 |
| Phase 5 | 启用记账 + 替换假 UI | 全部 |
| Phase 6 | 推荐归因与奖励 | 2 之后可开发；**上线须待计费解冻** |

---

## 1. 现状事实（已核实，覆盖 v1.0 的错误前提）

> 以下每条均有 file:line 证据，v1.0 中与之冲突的表述作废。

1. **不存在任何额度系统。** 全部 55 个迁移（v2..v52）中没有额度/配额/用量/账本表，没有列，没有计数器。这是**全新建设**，不是「修复现有实现」。
   - ⛔ v1.0 §1「Do not create a second disconnected credit system if one already exists. Migrate or repair」→ 作废。

2. **UI 正在向用户显示假余额。** `web/src/lib/accountSummary.ts:1` 是写死的 `EXISTING_APP_TOKEN_BALANCE = 34`；`:72` 的元数据覆盖字段从无代码写入。因此**每个用户看到的都是同一个「34 Tokens」**，渲染于 `web/src/app/app/layout.tsx:242,484,523` 与 `SettingsModal.tsx:523`；「Used this month」恒为 `—`。上线真额度 = 移除一处对用户可见的虚假信息，属用户可见行为变更。

3. **`/api/generate` 不是唯一 AI 入口**（尽管 `route.ts:243-248` 自称如此）。另有三个路由直接调用 AI 供应商，**既无认证也无审核门**：`/api/ai-copy`、`/api/ai-copy/analyze`、`/api/quality-judge`。它们今天就在被匿名调用并产生真实供应商成本。

4. **Billing 页不做同步 Creem 调用。** `/api/billing/creem/status/route.ts:61,74` 只读本地 Supabase 镜像，无 `creemClient` 导入、无 api.creem.io 请求。`migrate_v45_creem_billing.sql:8-10` 明确声明 `creem_customers` + `creem_subscriptions` 为「billing state 的 SOURCE OF TRUTH」。
   - ⛔ v1.0 §9 整节（「不要每次打开都同步调 Creem」「新建本地快照表」）→ **删除**，它解决的是一个已解决的问题；再加一层快照是冗余。

5. **结算跨语言，且部分成功是一等状态。** 图片生成由 TS 入队 `generation_jobs`（`route.ts:915`），由 Python VPS worker（`api/app/worker.py`，systemd 单元**当前处于禁用状态**）履约。Web 路由入队后立即返回，永远不知道结果——**它只能预留**。一个 job 可以 4 槽中成功 2 槽（`terminal_status:150` 返回 `done|partial|failed`）。孤儿重认领只重跑非 `done` 槽（`worker.py:307`），因此「认领即扣费」会对每个被重认领的 job 重复扣费。

6. **套餐额度只以展示字符串存在**，无机器可读数值。`pricingPlans.ts:203`：`{ label: "AI image credits", values: ["10 / month", "150 / month", "800 / month", "3,000 / month"] }`。价格：free 0、starter $19、pro $49、business $99（月付）。

7. **不存在「高级模型」。** 所有套餐使用同一模型，高级套餐只是**额度更大**。因此 `pricingPlans.ts:266-269` 那句 FAQ —— *"Standard generations usually use fewer credits, while higher-quality or premium model generations may use more."* —— **是错误文案，必须删除**（见 §3）。
   - ⛔ v1.0 §3 提议的「1 图 = 5 credits」→ 作废，见 §3。

8. **测试框架无法证明账本并发安全。** 123 个注册测试，100% 内存假件/模块 mock，**零 DB 集成先例**。`FakeSupabase` 字典会让 Postgres 本可串行化的竞态「通过」。

9. **仅个人账号**，无团队/工作区表。`workspace_id uuid` 是 3 张表上未使用的前向兼容空列，注释写明「= vibepin user today」。v1.0 中「user or workspace」的表述统一按 **user_id** 落地，保留 `workspace_id` 空列作前向兼容。

10. **无推荐/联盟代码或表。** 全新建设。

11. **既有安全姿态必须不退化。** `resolvePlan`（`entitlements.ts:219`）优先级：creem_subscriptions（active/trialing/未过期 scheduled_cancel 中**排名最高**者）→ `app_metadata.plan` → free。**`user_metadata` 永不读取**（P0 自授权漏洞的既定修复）。所有 Creem 表 RLS 启用且零策略 = 仅 service-role。

12. **近期合规成果必须不退化。** Creem 审核门按**每个原始字段 + composite** 送审（修复了已证实的上下文稀释绕过），fail-closed，严格早于 enqueue/FastAPI/inline。认证前置与输入上限（`MAX_MODERATION_CHECKS=56`）刚落地以阻断请求放大。live moderation 走 api.creem.io 且确实拒绝违规内容。`CREEM_MODE=disabled`，checkout 关闭（"Coming soon"），生产无 `CREEM_API_KEY`。

---

## 2. 单一事实源：套餐额度配置

每个在售套餐必须有显式的月度额度。新建集中的服务端配置，至少包含：内部 plan key、Creem product id、显示名、月度额度、允许的功能、套餐排名。

**额度取值直接采用已公开的定价页数值**（`pricingPlans.ts:203`）：

| plan key | 月度额度 | 依据 |
|---|---|---|
| free | **10** | 定价页已公示 |
| starter | **150** | 定价页已公示 |
| pro | **800** | 定价页已公示 |
| business | **3,000** | 定价页已公示 |

```ts
type PlanEntitlement = {
  planKey: PlanKey;
  displayName: string;
  monthlyCredits: number;
  creemProductIds: string[];
  rank: number;
  features: { textGeneration: boolean; imageGeneration: boolean; batchGeneration: boolean };
};
```

**禁止**在前端组件、API 路由、webhook 处理器中各自硬编码额度值。`pricingPlans.ts` 的展示字符串应由该配置派生，避免两处数字漂移。

---

## 3. 额度成本模型（**已决策**）

### 3.1 决策：1 张图 = 1 credit

`AI image credits` 的诚实读法就是**一张标准图消耗 1 个 image credit**。若按 v1.0 的 5 credits，Free 的 10 credits 只够生 2 张图，与定价页公示的数字直接矛盾。

```ts
export const CREDIT_COSTS = {
  imageGeneration: 1,     // 每张成功产出的图片
  imageRegeneration: 1,   // 重生成同样按张计
  textGeneration: 0,      // 见 3.3
} as const;
```

### 3.2 决策：不存在「高级模型」，删除该文案

产品事实：**所有套餐使用同一模型，高级套餐只是额度更大**，不存在按模型分级的消耗差异。

因此必须：
- **删除** `pricingPlans.ts:266-269` 中 "higher-quality or premium model generations may use more" 这句 FAQ —— 它承诺了一个不存在的机制。
- 成本表**不**按模型分级。保留 `pricing_version` 字段用于未来演进，但当前版本只有一档成本。
- 若未来确需差异化，须先改公开文案再改代码，不可反向。

### 3.3 文本生成：本期计 0，仅计量不扣费

定价页把文本能力作为**独立包含功能**列出，未纳入 "AI image credits"。因此本期**不得**用图片额度静默扣文本。

- 本期 `textGeneration: 0`，只记录用量（ledger 记 0 额度的计量事件），不扣费。
- 若未来要对文本收费，须先把额度名称在**所有位置**改为 "AI credits" 并公示文本成本，再启用扣费。

### 3.4 「Limited」批量生成需要数值定义

`pricingPlans.ts:206-207` 对 Starter 公示 "Limited" 批量生成，代码中无任何定义。**启用扣费前必须给出数字**，否则无法执行也无法验收。

### 3.5 成本必须可配置且前端不得重复定义

UI 通过安全的服务端端点或服务端渲染数据读取同一份**生效成本配置**。**生成前必须向用户披露本次将消耗的额度**。服务端计算全部成本，**绝不信任客户端传来的成本**。

---

## 4. 账本架构（表设计）

所有变更必须通过**数据库函数（RPC）**作为唯一写入接口，TypeScript 与 Python 调用同一组事务性 RPC。撤销直接写表权限；所有新表 RLS 启用且零宽松策略。

```text
credit_accounts
  id, user_id UNIQUE, plan_key
  recurring_available, recurring_reserved
  bonus_available,     bonus_reserved
  current_period_start, current_period_end
  version, created_at, updated_at

credit_grants
  id, account_id, bucket (recurring|bonus)
  source_type, source_id
  original_amount, available_amount, reserved_amount, consumed_amount
  expires_at
  UNIQUE(account_id, source_type, source_id)      -- 发放幂等

credit_reservations
  id, account_id, request_key
  generation_job_id UNIQUE NULL
  pricing_version
  requested_amount, charged_amount, released_amount
  state (open|partial|settled|released|expired)
  expires_at, created_at
  UNIQUE(account_id, request_key)                 -- 重试幂等

credit_reservation_items
  id, reservation_id, slot_key, cost
  state (pending|succeeded|failed|expired), settled_at
  UNIQUE(reservation_id, slot_key)                -- 按槽幂等

credit_reservation_allocations
  reservation_item_id, grant_id, amount
  UNIQUE(reservation_item_id, grant_id)

credit_ledger
  id, account_id, grant_id, reservation_id, reservation_item_id
  operation, bucket
  available_delta, reserved_delta, consumed_delta
  idempotency_key, balance_before, balance_after
  metadata(安全字段), created_at
  UNIQUE(account_id, idempotency_key)
```

**扣减顺序**：先 recurring 后 bonus；同 bucket 内按 `expires_at` 最早优先。bonus 额度在正常月度重置中**不清零**，除非有显式过期日期。

**operation 类型**：`monthly_allocation` / `generation_reservation` / `generation_charge` / `reservation_release` / `referral_reward` / `promotional_credit` / `manual_adjustment` / `refund_reversal` / `subscription_change` / `expiration`。

---

## 5. 预留/结算：TS 预留、Python 结算

### 5.1 强制顺序（不可调换）

```text
认证 → 请求校验 → 审核(fail-closed) → 额度预留 → AI 生成 → 结算或释放
```

**零扣费场景**（必须全部满足）：审核拒绝、审核不可用、校验失败、供应商从未被调用、生成失败、超时、无可用结果、用户在生成开始前取消。

**绝不允许把额度扣减移到审核之前。**

### 5.2 幂等键归属

客户端提供稳定的不透明 request UUID **仅用于重试关联**；服务端必须用「认证用户 ID + 路由 + 操作」对其加盐/哈希后作为最终 key。**客户端永不控制归属者与成本**。最终 key 落 `credit_reservations.request_key`；`generation_jobs` 存 `credit_reservation_id`。

### 5.3 单事务原子性

预留必须在**一个数据库事务**内完成：锁定 credit_account 与候选 grants → 创建 reservation + slot 行 + grant 分配 + ledger 流水 → 插入 `generation_jobs` 行。这样才能消除「已预留但入队崩溃」的空档。

### 5.4 Worker 按槽结算

```text
settle_generation_slot(reservation_id, slot_key, outcome)
```

- 成功槽：`pending → succeeded` **仅一次**，其预留额转为已消耗。
- 终态失败槽：`pending → failed` **仅一次**，释放其 grant 分配。
- 重认领跳过已 `succeeded` 的槽，因此**不会重复扣费**。
- 2/4 成功 → 2 槽扣费、2 槽释放，reservation 置 `partial`，`charged_amount` 恰为 2 个槽成本。
- **瞬时失败不得标记槽为 failed**；只有终态放弃才释放。

### 5.5 Worker 停摆与预留过期（关键：worker 当前禁用）

**不得依赖已禁用的 VPS worker 释放预留。**

1. **准入控制**：生产 worker 模式下，预留前必须检查 worker 心跳新鲜度。若 worker 已知禁用或心跳陈旧 → 在审核/预留/供应商调用**之前**返回 `503 generation_unavailable`，**消耗零额度**。
2. **独立清扫器**：用 Postgres 函数 + 经验证的 Supabase `pg_cron` 调度（**启用前须先确认扩展与调度器可用**）；同时在每次新预留前机会性调用同一过期函数。
   清扫器必须：只释放已过期且 job 无活跃处理租约的 pending 槽；把对应 job 标记为 canceled/failed 以防重启的 worker 再调供应商；恢复 bonus 额度；**recurring 额度仅在原 grant 仍有效时恢复**（过期周期的额度不得变成新周期的额度）；写入不可变的 release/expiration 流水。
3. **竞态**：worker 认领时必须原子校验 reservation 为 open 且未过期；过期后的结算必须 fail-closed，且**迟到的产出不得发布**。
4. **TTL**：必须大于最大合法排队+供应商耗时，可配置且有绝对上限。用户可取消尚未开始处理的 job 以释放预留。

### 5.6 余额不足

```json
{ "code": "insufficient_credits", "message": "You do not have enough credits for this request." }
```
UI 显示：`You need {required} credits, but only {available} credits are available.` 并提供升级/查看套餐入口。余额不足时**生成不得启动**。

---

## 6. 月度发放与重置

月度额度遵循**用户实际订阅计费周期**，不是自然月 1 日。存储：current_period_start / current_period_end / last_allocation_event / next_reset_date。

- **激活或续订**：更新订阅快照 → **恰好一次**发放本套餐 recurring 额度 → 写不可变 allocation 流水 → 更新周期日期。发放幂等键 = `UNIQUE(account_id, source_type, source_id)`，其中 source_id 绑定「订阅 + 周期」。
- **升级**：保留已消耗量，把本周期额度提升到新套餐额度，仅在适当时发放正差额。**绝不重复发放整份额度**。
- **降级**：下个计费周期生效（除非既有计费实现已是立即降级）。
- **取消**：按当前 Creem 行为保留本周期访问至期末；期满后**不再发放** recurring 额度。
- **Webhook 重试不得重复发放**。
- **Free 套餐周期定义**：需明确（无订阅则无 Creem 周期）——建议以账号创建日锚定滚动月。**此项待产品确认。**

### 6.1 存量用户初始化（bootstrap）

- **禁止**从 `accountSummary`、`token_balance`、`tokenBalance`、`credits` 或任何 auth metadata 导入余额——其中部分路径含**用户可写**元数据，不可作为财务状态。
- 因无历史用量，已消耗量无法重建。**每个已验证的当前计费周期发放一次 bootstrap grant**，以该周期为唯一键。
- 订阅状态未知者**不发放任何猜测性付费额度**，标记待审。
- **不得**把所有存量用户重置为 Free；**不得**在部署时给每个存量用户平白发一整份月度额度。
- 破坏性变更前提供 **dry-run 迁移报告**。

---

## 7. AI 供应商边界收口（Phase 1B）

**新规则**：*任何已认证的生产请求，未经校验、适用的 fail-closed 审核、以及原子额度预留，不得调用 AI 供应商。*

三个路由必须纳入：`/api/ai-copy`、`/api/ai-copy/analyze`、`/api/quality-judge`。

- 个人额度需要**已认证的归属者**，因此这必然给这些路由**加上认证**。
- ⚠️ **这是破坏性行为变更，必须显式公告，不得静默实施。** 实施前须先追踪调用方；若存在依赖它们的匿名 UI 流程，只能二选一：使用前要求登录，或单独立项做匿名配额系统。**匿名请求不可扣任何用户的额度。**
- inline/FastAPI 路径既有的匿名行为，仅在**显式按环境门控、隔离于生产之外**时保留。
- **认证必须早于审核**，以防匿名审核请求放大（此前已修复的同类问题）。

---

## 8. 账号隔离

所有额度、用量、订阅、推荐、计费数据按已认证账号隔离。

- **绝不接受浏览器传入的 `userId`/`accountId`/`workspaceId` 作为归属证明**，一律从服务端会话派生（`web/src/lib/server/authUser.ts`：`getUserIdFromBearer` / `getUserIdFromCookies` / `getUserIdFromBearerOrCookies`）。⚠️ `getUserIdFromCookieSession` **未做网络验证**，禁止用于额度扣减。
- 每个查询都必须带已认证归属者作用域；新表 RLS 启用零策略（service-role only）。
- ⚠️ **service-role 调用绕过 RLS**，因此跨用户归属检查必须在**路由层**单独测试，不能只靠 RLS。
- 用户绝不能：查看/花费他人余额、查看他人用量或流水、访问他人订阅、使用他人推荐数据、通过对象 ID 改动他人账号、猜 ID 越权。
- 管理员访问走显式特权路径 + 审计日志。
- **不得**把基于邮箱的归属与不可变 user ID 混用；改邮箱不得新建额度账号或暴露原账号。

---

## 9. ~~Billing 页加载优化~~ → 删除，改为「复用既有镜像」

> **v1.0 §9 整节删除。** 该节假设 Billing 页每次打开都同步调 Creem——事实不成立（见 §1.4）。

**替代要求**：
- 继续以 `creem_customers` + `creem_subscriptions` 作为本地已验证计费镜像，**不新建第三层快照表**。仅在确有缺失的周期/同步字段时**扩展既有表**。
- Billing 读取保持本地，且必须保持 `resolvePlan` 优先级。
- **移除** v1.0 提出的「快照缺失时同步拉取 Creem」「陈旧后台刷新」——在计费冻结、生产无 `CREEM_API_KEY` 的前提下，该行为既无必要也不可靠。
- 保留测试：Settings 读本地镜像、永不阻塞于 Creem、**已知付费快照加载中绝不闪现 Free**。

---

## 10. API 响应语义（异步路径修正）

⚠️ 入队式图片路由**只入队、不结算**，因此**不能**返回 `creditsCharged`。

```json
{
  "jobId": "...",
  "usage": {
    "creditsReserved": 4,
    "maximumCharge": 4,
    "creditsAvailableAfterReservation": 146
  }
}
```

最终的 `creditsCharged` / `creditsReleased` / 剩余余额由**轮询/状态接口**在结算后给出。同步路径可直接返回最终扣费。

---

## 11. 额度与用量 UI

移除 `EXISTING_APP_TOKEN_BALANCE = 34` 及其全部渲染点（`layout.tsx:242,484,523`、`SettingsModal.tsx:523`）。**禁止**把 auth metadata 当作金额来源。

- **应用头部/账号菜单**：`{remaining} credits left`，点击进入 Usage/Billing。
- **Settings → Billing 立即展示**：
  - 当前套餐：名称、状态、计费周期、周期起止、下次续订/到期日、Manage subscription
  - 月度用量：总额度、本周期已用、recurring 剩余、bonus 剩余、总可用、下次重置日、进度条
  - 标签建议：`Monthly allowance` / `Used this cycle` / `Monthly credits remaining` / `Bonus credits` / `Total available` / `Resets on {date}`
  - **bonus 不得并入月度重置数值而不加解释**
- **用量明细**：文本请求数、生成图片数、文本消耗额度、图片消耗额度
- **近期活动**：时间、动作、增减额度、结果余额。**不暴露内部 ID、供应商细节、prompt 或私有元数据。**

---

## 12. 推荐奖励（Phase 6，本期仅额度不做现金）

现金返现引入额外的支付、欺诈、退款、会计与合规要求。**本期只做额度奖励**，架构保留未来联盟能力。

⚠️ **checkout 处于关闭状态（"Coming soon"），因此推荐奖励的合格事件（首笔付费订阅）当前无法发生。Phase 6 的上线必须等待计费解冻。**

### 表
- **referral_codes**：owner_user_id、code、active、created_at
- **referral_relationships**：referrer_user_id、referred_user_id、attribution_at、status、qualifying_event、reward_status
- **referral_rewards**：referrer_user_id、referred_user_id、credit_amount、source_payment_ref、pending_at、granted_at、reversed_at、reason、idempotency_key

### 合格规则
被推荐用户须：① 经有效推荐链接新建账号 ② 不是推荐人本人 ③ 完成首笔成功付费订阅 ④ 未通过其他推荐人合格过 ⑤ 持有期内无退款/取消欺诈/拒付。

```ts
export const REFERRAL_REWARDS = {
  inviterCredits: 100, newUserCredits: 50,
  qualifyingEvent: "first_paid_subscription",
  holdDays: 7, maxRewardsPerMonth: 20,
};
```
以上为**建议默认值，必须可配置**。

- 首笔付款在奖励释放前被退款/拒付 → **取消待发奖励**。
- 已发放后付款被撤销 → **新建一条 reversal 流水**，**绝不静默修改旧流水**。
- 推荐 webhook 必须幂等。
- 归因：首次合格访问捕获 code 并与注册关联；**不得在每次访问时覆盖已有的有效归因**。

### 防滥用
拦截/标记：自荐、同一认证用户的多账号、对同一被推荐账号重复推荐、同一笔付款重复合格、明显环形推荐、code 篡改、webhook 重复发奖、仅免费注册即发奖、失败或退款付款产生的奖励。共享 IP **单独不足以判定欺诈**，仅作复核信号记录。奖励上限可配置。**不得暴露被推荐用户的隐私信息。**

### UI（Settings → Referral）
个人链接、复制按钮、奖励说明、成功/待定推荐数、已得额度、月度上限、条款链接。状态文案：`Pending — reward becomes available after the qualification period.` / `Reward granted — 100 credits added.` / `Reward reversed because the qualifying payment was refunded or reversed.` 需配套简明推荐条款（资格、反欺诈、奖励撤销、**奖励无现金价值**）。

---

## 13. 测试要求

### 13.1 DB 集成测试通道是**前置条件**（Phase 1A）

SQL 评审 + `FakeSupabase` **不足以**保证财务并发正确性。最小可行通道：

1. 独立的 Supabase 测试项目/一次性数据库，与 master 迁移一致
2. 用 `backend/scripts/run_migration.py --apply` 应用候选迁移到该测试库
3. 新增 `npx tsx scripts/test-credit-ledger-db.ts`
4. **注册进 `web/scripts/test-registry.ts`**（不注册会导致构建失败）；若不放进快速单测套件，则注册为显式外部 DB 测试，并把 `npm run test:db` 设为强制发布门禁
5. 用唯一 run ID 隔离并行运行
6. **至少 20 个并发 reserve RPC** 打向只够部分成功的余额
7. 断言：精确成功数、余额非负、account/grant/ledger 守恒、无重复幂等键
8. 并发重放相同 request_key 与相同 webhook 发放键
9. reserve-vs-expire、settle-vs-expire 竞态
10. service-role 可写 + anon/authenticated 直接访问表必须失败
11. **跨用户路由归属单独测试**（service-role 绕过 RLS）

⚠️ **缺少 DB 凭据时测试不得静默通过**；发布门禁必须失败或显式报告「强制 DB 套件未运行」。

### 13.2 功能断言

1. 文本生成按配置成本扣费（本期为 0，仅计量）
2. 图片生成扣 1 credit
3. 多图扣正确总额
4. 生成失败净扣费为 0
5. 审核拒绝扣费为 0
6. 审核不可用扣费为 0
7. 余额不足时**模型不被调用**
8. 并发请求无法超支
9. 相同幂等键重试不重复扣费
10. Webhook 重试不重复发放月度额度
11. 月度重置保留 bonus
12. Billing 页从本地镜像渲染，不等 Creem
13. 陈旧计费数据刷新不会把可见套餐替换为 Free
14–16. 用户 A 不能查看/花费/查流水 用户 B
17. 拒绝自荐
18. 一个被推荐用户不能让多个推荐人合格
19. 一笔付款不能重复发奖
20. 退款付款不产生有效奖励
21. 奖励额度产生不可变流水
22. 撤销奖励产生独立 reversal 流水
23. 改邮箱保持正确额度账号
24. 客户端传入 user ID 无法绕过账号隔离
25. **worker 停摆时预留被清扫器释放，且迟到产出不发布**（新增）
26. **孤儿重认领不重复扣费**（新增）
27. **部分成功只对成功槽扣费**（新增）

---

## 14. 迁移

- 迁移号：**先检查未合并分支再定号**（master 上 v45、v29 已各出现重复，此前有过 v51/v52 碰撞）。当前 master 最高为 v52。
- 必须**追加式 + 幂等**（`create table if not exists`、`add column if not exists`、`create index if not exists`）。
- **RLS 启用、零宽松策略**（仅 service-role）。
- 经 `backend/scripts/run_migration.py --apply` 应用，由用户执行。
- 提供 dry-run 报告后再做破坏性变更。

---

## 15. 可观测性

结构化指标：生成尝试、成功扣费、释放预留、余额不足拒绝、月度发放、幂等去重命中、推荐奖励、奖励撤销、陈旧计费快照、外部计费刷新失败、**滞留预留数、结算失败数、守恒不变量违例**。

**禁止记录**：原始 prompt、API key、支付密钥、完整住址、客户端日志中的完整推荐风险数据。

**告警**：预留滞留超时、结算失败、负余额/守恒违例、重复尝试激增。

---

## 16. v1.0 遗漏项（本版补入）

- Worker 健康准入控制（§5.5）
- 预留 TTL、取消、清扫、周期边界行为（§5.5）
- Worker 租约与 settle-vs-expire 竞态（§5.5）
- 按槽幂等与 `generation_jobs` 外键关系（§4、§5.4）
- 异步 API 语义：reserved vs 最终 charged（§10）
- 每次预留记录成本表版本 `pricing_version`（§4）
- 存量用户 bootstrap 发放（§6.1）
- Free 套餐计费周期定义（§6，**待产品确认**）
- 移除假 34 token，禁止把 auth metadata 当金额（§1.2、§6.1、§11）
- Starter 批量生成的数值定义（§3.4，**待产品确认**）
- 特性开关灰度切换与回滚（不得丢失开放中的预留）
- 对账任务：account / grant / reservation / ledger 总量核对（§15）
- 已花费的推荐奖励被撤销后的**负余额策略**（**待产品确认**）
- 账号删除/留存与不可变财务记录的关系（**待法务/产品确认**）
- 推荐 cookie 同意、归因有效期、条款版本、账号关联滥用策略
- 迁移号碰撞检查（§14）
- 凭据轮换后确认 Python worker 仅持有必需的最小 service 凭据

---

## 17. 五大风险与守护

| # | 风险 | 守护 |
|---|---|---|
| 1 | 并发超支或重复发放 | 行锁 SQL RPC、条件余额检查、数据库唯一键、守恒不变量、**真实 Postgres 并发测试** |
| 2 | 重认领/部分成功/worker 停摆导致重复扣费或额度悬挂 | 按槽状态机、job 关联预留、仅终态释放、worker 租约检查、独立过期清扫器、settle/expire 竞态测试 |
| 3 | 未认证/未计量路由绕过供应商成本 | 供应商调用全量清单、生产端认证边界、认证早于审核、fail-closed 审核、**「每次供应商调用都必须持有有效预留」的测试** |
| 4 | Webhook 重试/乱序/升级/bootstrap 导致月度发放错误 | 订阅周期唯一发放键、单调 webhook 处理、已验证周期日期、显式 bootstrap 策略、未知状态不发放 |
| 5 | 展示额度与实际消耗不符 | **标准图 = 1 个公示 credit**、成本表版本化、生成前披露成本、文本不静默扣费、启用前复核定价文案 |

---

## 18. 待产品决策清单（阻塞 Phase 0 收尾）

1. **Free 套餐的计费周期锚点**（无 Creem 订阅）—— 建议按账号创建日滚动月。
2. **Starter「Limited」批量生成的具体数字**。
3. **推荐奖励撤销后若额度已花完**，是否允许负余额（建议：允许负余额并阻断新生成，不追讨）。
4. **账号删除后**不可变财务流水的留存期限。
5. 文本生成未来是否收费（当前决策为 0，若改需先改文案）。

---

## 19. 最终报告要求

实施后须报告：数据库 schema 变更、迁移结果、额度来源、成本配置、**全部文本生成路径审计**、**全部图片生成路径审计**、预留与结算实现、月度发放行为、Billing 缓存行为、账号隔离保护、推荐合格规则、奖励值与配置位置、新增测试与结果、tsc 结果、构建结果、**失败/被拒请求零扣费的确认**、**跨账号无法访问计费或用量的确认**、**Creem checkout / 产品映射 / webhook 验证未被破坏的确认**。

**若任何文本、图片、重试、队列、批量或回退生成路径可以绕过额度记账，不得声称完成。**

---

## 20. 不可违反的约束

- 不破坏既有 Creem 审核合规门（每字段 + composite、fail-closed、早于任何 enqueue/FastAPI/inline 分发）
- 不改 Creem 产品价格、checkout 链接、产品 ID、webhook secret、订阅映射
- 不启用 checkout、不改 `CREEM_MODE`（当前 `disabled`）
- 不为授权目的读取 `user_metadata`
- 迁移追加式幂等、RLS 零策略、经 run_migration.py 应用
- Python VPS worker 当前**禁用**，设计必须定义结算侧停摆时的正确行为
- inline/FastAPI 的匿名放行是既定文档化决策，**变更必须显式声明，不得静默**

---

## 21. 阶段验收口径

每个阶段必须**独立可发布、独立可验证**。

- **Phase 1A 完成** = DB 集成通道可跑，20 并发 reserve 断言通过，缺凭据时**失败而非静默通过**
- **Phase 1B 完成** = 三个路由已认证 + 有界 + 适用审核；破坏性变更已公告
- **Phase 1C 完成** = Billing 本地读取/优先级/不闪 Free 的测试齐备
- **Phase 2 完成** = schema + RPC 落地但**未启用**；DB 并发套件全绿
- **Phase 3 完成** = 发放幂等（webhook 重放不重复）、升级/降级/取消/bootstrap 正确
- **Phase 4 完成** = 所有生成路径接入预留/结算，**enforcement 仍关闭**
- **Phase 5 启用前置** = worker 已带凭据且健康、清扫器独立可用、DB 并发套件全绿、路由覆盖审计通过、回滚方案就绪
- **Phase 6 上线前置** = 核心账本稳定 + 真实支付/退款生命周期验证 + 计费解冻
