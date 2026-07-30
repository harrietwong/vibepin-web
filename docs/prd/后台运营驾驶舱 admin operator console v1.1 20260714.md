# 后台运营驾驶舱 PRD v1.2

**状态：** P0 已实施（branch `feat/admin-cockpit`，见 §8 实施记录），待终审合并 + 部署
**日期：** 2026-07-16（初稿 2026-07-14）
**作者：** Fable 5（基于创始人确认的产品方向）
**取代：** `【后台系统未实施 优先级不高】.txt`（定位文档，其"不做清单"与最终定位在本文档中继承并展开）
**关联文档：**
- `docs/prd/Admin Dashboard PRD v1.0 20260714.md`（现状 PRD，描述已上线的 8 个 admin 模块）
- `docs/调研报告/【后台】SaaS Customer Intelligence Admin System for VibePin.md`（竞品调研，本方案对其结论做了阶段化裁剪）

---

## 1. 定位一句话

后台不是"数据看板"，是**创始人的每日运营驾驶舱**：每天打开一次，5 分钟内知道"谁在成功、谁被卡住、今天该帮谁"，然后去行动。

**功能准入标准（唯一过滤器）：** 一个信息如果不能直接导向一次干预动作（发邮件 / 送 token / 修 bug / 改 onboarding），就不进后台。

## 2. 阶段判断：激活期，不是留存期

VibePin 计费刚接完 Creem（Paddle 被拒后切换，creem_* 表 v45 已应用；本文早期版本写 Paddle，以此为准）、用户量小。此阶段每个用户都值得被单独看见，后台围绕**激活漏斗**构建，而非客户管理：

```
注册 → 连接 Pinterest → 首次 AI 生成 → 首次成功发布 → 7 天内再次发布
```

**北极星激活事件：首次成功发布（first successful publish）。**
用户量小的时候，创始人手动把每个卡住的人推过这条线，就是最高杠杆的增长动作。

调研报告面向"成熟 SaaS 支持控制台"，其 P0 清单中的 Customer List、Customer 360、Support 集成、内部备注均已建成（见现状 PRD），本方案不重建，只做客户视角的翻转与补强。

## 3. 四大产品支柱

### 支柱 1：今日阻塞名单（最优先）

每天一份**可行动清单**，把 System Health 从系统视角翻转为客户视角——不是"今天失败率 3%"，而是"Ava 和另外 2 个人今天发布失败了"。

**入选阻塞类型（P0 全集，不再多）：**

| 阻塞类型 | 判定 | 建议动作 |
|---|---|---|
| 发布失败 | 24h 内有失败的发布且此后无成功发布 | 查错误码 → 修复 / 回复用户 |
| Pinterest 断连 | 连接状态异常 / token 刷新失败 | 引导重连邮件 |
| 生成连续失败 | 24h 内 ≥2 次 AI 生成失败且无成功 | 查 generation logs → 修复 / 送 token 补偿 |
| 注册未激活 | 注册 >48h 未连接 Pinterest | 引导邮件 |
| 连接未创作 | 连接 >72h 无任何生成或 Pin 创建 | onboarding 引导 |

**每条记录必含：** 用户（邮箱+深链到 Customer 360）、阻塞类型、首次发生时间、原因摘要、建议动作。
**排序：** 付费用户置顶，其余按阻塞时长降序。
**清单为空时**明确显示"今日无阻塞"，让"打开即安心"成为一种确定的体验。

### 支柱 2：成功创作者画像（每周视角）

每周回答：过去 7 天谁发布最多、谁的内容表现最好、他们的功能路径是什么（AI 生成占比、关键词、品类、是否导入 board）。

**两个产品出口：**
1. **可复制的成功路径 → 反哺 onboarding。** 例："成功用户都在第一天导入了 board" → 引导所有新用户这么做。
2. **喂给 Creative Intelligence。** 成功创作者的内容特征进入已有的校准工具，形成内容层面的学习。

P0 形态是一个"本周 Top 创作者"卡片（Top 10：发布数、生成数、AI 占比、最近活跃），不做图表趋势。路径归因（他们做对了什么）放 P1。

### 支柱 3：AI 学习闭环（差异化资产）

已有 Visual Review + Creative Intelligence 校准工具是别家没有的资产。本支柱把它们和客户行为打通：

**核心指标：AI 采用率 = 被用户实际发布的生成结果 / 全部生成结果。**
"用户采用率"是比"生成成功率"更真实的 AI 质量指标——生成成功但被丢弃，说明质量不行；被采用并发布，才是真正的成功。

**P0 只算一个数**（全局采用率 + 7 天趋势方向），按品类/风格拆分放 P1，与 Visual Review 评分的相关性分析放 P2。

### 支柱 4：Customer 360（降级为支撑层）

已有 v0，够用。**不再单独加码**，只做两件事：
1. 顶部加 **Alert Strip**：该用户当前的未解决阻塞（与支柱 1 同一套判定逻辑）。
2. 加**红黄绿健康标记**，以创作成功为主轴：

| 信号 | 判定 |
|---|---|
| 7 天内活跃 | 有任何登录/操作 |
| 14 天内有成功发布 | 至少 1 次 |
| Pinterest 连接健康 | 无断连/刷新失败 |
| 无未解决阻塞 | 支柱 1 判定为空 |

四个布尔信号：全真 = 绿；1 个假 = 黄；≥2 个假 = 红。**必须显示 drivers**（为什么是黄）。
**Override 规则：** 欠费/订阅异常不参与评分，但强制封顶为黄——商业健康是降级项，不是主轴（继承定位文档："核心问题不是哪个客户赚多少钱"）。

Customer 360 的角色是支柱 1、2 点进去看细节的**落地页**，不是独立产品。

## 4. 明确不做（继承定位文档并强化）

- ❌ CRM / 销售漏斗 / 收入分析 / Enterprise Account / 复杂 Customer Success（原定位文档全集）
- ❌ "给管理员看的"复杂图表页——图表不能告诉你今天帮谁，就是装饰
- ❌ 提前的自动化干预（自动邮件、自动送 credit）——用户量小，**手动干预本身就是用户调研**
- ❌ 调研报告中的 P1/P2 项在用户量过 500 或有专职客服前一律不动：feedback 投票门户、segments、raw event inspector、可配置 pinned fields、细粒度角色权限
- ❌ 独立 orders 抽象、在后台重建 Paddle 计费面板（只读镜像 + 深链，Paddle 为唯一事实源）

## 5. 衡量后台本身是否成功

| 指标 | 目标 |
|---|---|
| 激活率 | 注册 → 首次成功发布的转化率与耗时持续改善 |
| 阻塞响应时间 | 用户遇到阻塞 → 被创始人发现 <24h（打开驾驶舱即发现） |
| AI 采用率 | 随 Creative Intelligence 校准迭代而提升 |

## 6. 节奏与优先级

| 阶段 | 内容 | 前置条件 |
|---|---|---|
| **P0（现在）** | 今日阻塞名单 + 激活漏斗视图；Customer 360 加 Alert Strip + 健康标记 | 无新基建，现有表派生 |
| **P1** | 成功创作者周报卡片 + 路径归因；AI 采用率按品类拆分 | P0 上线后观察 2 周 |
| **P2** | `customer_events` 事件底座（真实 timeline 替换合成 activity）；Paddle webhook mirror 完成后补 billing snapshot；error_incidents 归一化 | Paddle 履约层上线 |
| **不排期** | 第 4 节全部 | 用户 >500 或有专职客服 |

## 7. 技术方案（P0，实施时核实数据源）

**原则：零新表起步，只读派生优先，事件底座推迟到 P2。**

### 7.1 页面与导航
- 新增 `/admin/today`（运营驾驶舱），设为 AdminNav 第一项（Overview 之前或合并考量由实施时定，倾向独立新页、Overview 保留系统视角）。
- 页面结构：① 今日阻塞名单（表格，用户深链）② 激活漏斗（5 段横条 + 各段卡住人数）③ 本周 Top 创作者卡片（P0 可先占位）④ AI 采用率单数卡片。

### 7.2 数据派生（全部只读查询，复用 `web/src/lib/server/` 模式）

**核实结论先行：Pinterest 发布这条链路，成功和失败都不落库。** `POST /api/pinterest/pins` → `publishPinForUser()`（`web/src/lib/server/pinterest/publishPin.ts`）只把结果 return 给前端，不写任何表；发布成功后 `remotePinId`/`postedAt` 由客户端写回自己的 `pin_drafts.payload`（JSONB，见 `web/src/lib/smartSchedule.ts` 的 `d.postedAt` 判定），发布失败则完全没有留痕——只在客户端抛错/toast。项目里另有一张结构完整的 `publish_jobs` 表（`status/error_message/retry_count/published_at/pinterest_pin_url`，`backend/db/schema.sql` + `migrate_v14.sql`）和 `/api/publish-jobs` 路由，但那是旧的单独调度路径，当前 Studio 的发布走的是 `/api/pinterest/pins`，不写 `publish_jobs`——不能假设这张表有当前数据。v32 的 `social_publish_jobs` 同理明确注释"Pinterest 不走这里"。**这是本次核实中唯一可能改变 P0 范围的发现**，处理方式见下与 §7.5。

- **阻塞名单** `adminActionCenter.ts`：
  - **生成失败**：✅ `pin_generations.status`（'failed'）+ `error_type` + `error_message` + `created_at` + `user_id`，`web/src/lib/studioPersistence.ts` 的 `insertGenerationToDb()` 写入，`web/src/lib/server/adminOverview.ts` `loadErrors()`/`web/src/lib/server/generationLogs.ts` 已在读。注意写入是客户端发起（生成成功/失败后由前端调用insert），非服务端强一致，但字段齐全、admin 现有代码已验证可用。
  - **发布失败**：❌ GAP（见上）。P0 fallback：不做"发布失败"独立判定，改用**间接信号**——`pin_drafts.payload` 中 `plannedAt`/`scheduled_at` 已过期但 `postedAt`/`remotePinId` 仍为空（"过期未发布"），配合客户端此前上报的 `draft_published` analytics 事件（`web/src/lib/analytics.ts`，落 `analytics_events` 表，v41）缺失来交叉推断。UI 必须标注"基于草稿状态推断，非服务端发布日志"。P1 应把 `publishPinForUser()` 改为发布前后各写一行（成功写 `pin_drafts` 促升列或新 `publish_attempts` 表，失败必须落库 `error_message`），这是最值得优先做的instrumentation。
  - **Pinterest 断连**：⚠️ PARTIAL。`pinterest_connections`（`web/src/lib/server/pinterest/connectionStore.ts`）有 `needs_reconnect`（boolean）+ `disconnected_at`，够判定"断连"，但没有 `last_error`/`last_refresh_error` 文本列——只知道"需要重连"，不知道"为什么"。P0 用 `needs_reconnect=true OR disconnected_at IS NOT NULL` 判定，原因摘要退化为固定文案"token 已过期或被撤销"，不展示具体错误。多平台的 `social_connections`（v32）有 `connection_status`（含 error）更细，但当前只服务 IG/FB/TikTok，Pinterest 不经过这张表。
  - **注册未激活/连接未创作**：✅ VERIFIED。Supabase `auth.users`（service role，`db.auth.admin.listUsers`，`adminOverview.ts`/`customer360.ts` 已有先例）联查 `pinterest_connections` + `pin_generations`（`user_id`, `created_at`）。
  - **付费用户置顶**：⚠️ PARTIAL，好于原判断。v44 `billing_customers`/`billing_subscriptions` 迁移已编写（Paddle webhook 履约镜像，`web/src/app/api/paddle/webhook`），但 webhook 是否已在生产实际收到并落库事件，只读代码审查无法确认。同时 `auth.users.app_metadata.plan` / `user_metadata.plan` 已被 `customer360.ts` 的 `planOf()` 读取并在 Customer 360 现有页面展示——这是一个更轻量、已经在跑的 plan 信号。P0 用 `user_metadata.plan`/`app_metadata.plan` 做置顶排序（付费 tier 名不为空/不为 free 即置顶），`billing_subscriptions.status='active'` 作为存在时的更强信号叠加使用；两者都拿不到时不排序，不阻塞上线。
- **激活漏斗** `adminActivationFunnel.ts`：按用户聚合五个里程碑时间戳（注册=`auth.users.created_at` / 首连=`pinterest_connections.created_at` / 首生成=`pin_generations` 最早 `created_at` / 首发布=见下 / 7 天复发布=见下），近 30 天注册用户为统计口径。**"首发布"和"7 天复发布"两个里程碑继承上面的发布落库 GAP**：P0 用 `pin_drafts.payload.postedAt` 存在性近似（需要客户端已同步该 draft 到服务端，`pin_drafts` v38 表），漏斗这两段的人数标注"近似（基于草稿同步状态）"。
- **健康标记与 Alert Strip**：与阻塞名单共用同一判定函数，单用户版本供 Customer 360 调用（`getUserBlockers(userId)`），保证两处口径永远一致。"14 天内有成功发布"信号继承同一个 `postedAt` 近似口径。
- **AI 采用率**：⚠️ PARTIAL。`pin_generations` 有 `draft_id` 列，但它引用的是旧的 `composer_drafts` 表（`migrate_v22.sql` SECTION 10，`REFERENCES composer_drafts(id)`），不是当前的 `pin_drafts`（v38，主键是 `(vibepin_user_id, draft_id)` 且 `draft_id` 是 text 而非 uuid）——**generation 和当前草稿系统之间没有可 join 的外键**。P0 近似口径：`total_pins`/`pin_urls`（generation 产出的图片 URL 集合）与 `pin_drafts.payload` 中引用的图片 URL 做字符串匹配，判定"该 generation 的产物是否出现在一个 `postedAt` 非空的 draft 里"，UI 必须标注"按图片 URL 近似关联，非精确外键"。P1 修复：在 studio 端生成 draft 时把 `pin_generations.id`（或 `session_id`）写入 `pin_drafts.payload.generationId`，一次性打通链路，之后 P0 的近似口径可退役。

### 7.3 工程硬规则（继承项目规范）
- 所有用户可见字符串走 admin i18n（adminMessages 体系，EN/中文两套，与现有 admin 一致）。
- 颜色只用 `--admin-*` token；缺表/缺列一律优雅降级为 n/a + 警告行（沿用 adminOverview 模式）。
- 全部只读，无 mutation；super admin gating 沿用 `getCurrentSuperAdmin()`。
- 前置清债：核实 v33（`backend/db/migrate_v33_admin_support_notes.sql`，建表 `admin_support_notes`）、v34（`backend/db/migrate_v34_admin_audit_events.sql`，建表 `admin_audit_events`）两个迁移在生产是否已应用（走 `backend/scripts/run_migration.py --apply`），为将来任何写操作（送 token 等 safe actions）备好审计底座。本次核实为纯代码审查，未连接生产库确认应用状态。

### 7.4 验收清单
- [ ] 阻塞名单五类判定各构造一个真实/模拟用户，逐类验证出现与消失（阻塞解决后离开名单）
- [ ] 漏斗各段人数与 SQL 手工核对一致
- [ ] Customer 360 Alert Strip 与阻塞名单对同一用户口径一致
- [ ] 健康标记 drivers 正确显示"为什么是黄/红"
- [ ] 空态：无阻塞时显示"今日无阻塞"
- [ ] i18n EN/中文切换无硬编码残留；深浅色主题正常
- [ ] 非 super admin 访问被重定向

### 7.5 数据源核实结果（2026-07-14）

纯代码 + 迁移文件审查，未连接生产库查询（活跃数据量/迁移实际应用状态需实施时用 `run_migration.py`/Supabase 确认）。

| 数据需求 | 来源（table.column / 代码路径） | 状态 | P0 处理 |
|---|---|---|---|
| 1. 发布成功 | 无服务端记录；结果仅 return 给客户端，客户端写自己的 `pin_drafts.payload.remotePinId`/`postedAt`（`web/src/lib/server/pinterest/publishPin.ts`、`web/src/lib/smartSchedule.ts`） | ❌ GAP | 用 `pin_drafts.payload.postedAt` 存在性近似"已发布"，标注口径说明 |
| 1. 发布失败 | 无任何记录（客户端 toast，不落库）；`publish_jobs`/`social_publish_jobs` 结构齐全但 Pinterest 流程明确不写它们 | ❌ GAP | 用"计划时间已过但未见 postedAt"间接推断，标注"近似推断" |
| 2. AI 生成记录 | ✅ `pin_generations.status/error_type/error_message/created_at/user_id/keyword`，`web/src/lib/studioPersistence.ts` `insertGenerationToDb()` 写、`web/src/lib/server/adminOverview.ts`/`generationLogs.ts` 已读 | ✅ VERIFIED | 直接用；注意写入是客户端发起，非服务端强一致 |
| 3. 生成→草稿→发布关联 | `pin_generations.draft_id` 指向旧表 `composer_drafts`（`migrate_v22.sql`），与现行 `pin_drafts`（v38）无外键 | ⚠️ PARTIAL（近似口径：图片 URL 匹配） | 按生成产物图片 URL 与 draft payload 图片 URL 匹配近似关联，UI 标注"近似关联" |
| 4. Pinterest 连接状态 | ✅/⚠️ `pinterest_connections.needs_reconnect/disconnected_at`（`web/src/lib/server/pinterest/connectionStore.ts`），有状态列但无 `last_error` 文本 | ⚠️ PARTIAL | 判定用 `needs_reconnect OR disconnected_at`；原因摘要用固定文案，不展示具体错误 |
| 5. 注册与活跃信号 | ✅ `auth.users`（service role listUsers，`adminOverview.ts`/`customer360.ts` 先例）；7 天活跃 = `last_sign_in_at` + `pin_generations.created_at` 等合成 activity（`customer360.ts` 已有"synthesized activity"模式） | ✅ VERIFIED | 直接复用 `customer360.ts` 现有合成逻辑 |
| 6. Plan / 付费状态 | ⚠️ `auth.users.user_metadata.plan`/`app_metadata.plan`（`customer360.ts` `planOf()` 已读）；v44 `billing_customers`/`billing_subscriptions` 已建表但生产 webhook 落库状态未核实 | ⚠️ PARTIAL（好于预期，非纯 GAP） | 用 `user_metadata.plan` 做置顶排序，`billing_subscriptions.status` 存在时叠加增强 |
| 7. Support 工单 | ✅ `support_tickets.status`（'Open'/'In progress'/...）+ `user_id`，`backend/db/migrate_v35_support_tickets.sql`，`web/src/app/api/admin/support/tickets/route.ts` | ✅ VERIFIED | 直接用，按 user_id 聚合未关闭工单数 |
| 8. v33/v34 迁移 | `backend/db/migrate_v33_admin_support_notes.sql`（建表 `admin_support_notes`：客服内部备注）；`backend/db/migrate_v34_admin_audit_events.sql`（建表 `admin_audit_events`：管理员敏感操作审计日志） | 文件存在，生产应用状态未核实 | 实施前用 `run_migration.py --apply` 确认/应用 |
| 9. Admin i18n + 主题 | `web/src/lib/admin/adminMessages.ts`（catalog）；`--admin-*` CSS token 约定（现有 admin 页面统一遵守） | ✅ VERIFIED | 新增文案沿用同一 catalog + token 体系 |
| 10. 分析事件表 | ✅ `analytics_events`（v41，`web/src/app/api/analytics/events/route.ts`），`web/src/lib/analytics.ts` 定义事件类型（含 `draft_published`），事件落库非仅 console | ✅ VERIFIED（范围窄） | 可作为 7 天活跃信号的补充信号，不作为主信号（当前事件集中在 Creative Intelligence 相关操作，非全量行为埋点） |

---

## 8. 实施记录（P0，2026-07-16）

创始人决策采用**方案 B**：发布事件服务端落库作为 P0 instrumentation 先行（admin 仍全只读），随后构建派生层与 UI。实施在 `feat/admin-cockpit` 分支（自 master 45b825c 切出，独立 worktree），提交序列：

| 提交 | 内容 |
|---|---|
| `2cca984` | 三事件落库：`pinterest_publish_attempted/succeeded/failed` 写入 `analytics_events`（即时路由 + 排期 cron 双路径；`publishAttemptId` 贯穿；错误消息脱敏 ≤300 字符；best-effort 永不影响发布）。同时打通 `pin_drafts.payload.sourceGenerationId/sourceAssetKey`（生成→草稿精确关联，零迁移） |
| `3687213` | cron trial-access 跳过时补终结事件，杜绝 attempted 悬挂 |
| `f76c624` | 派生层：`adminActionCenter.ts`（5 类阻塞 + `getUserBlockers` + 健康分）/ `adminActivationFunnel.ts` / `adminAiAdoption.ts` / `adminQueryUtils.ts`（分页防 1000 行陷阱，无 per-user N+1） |
| `05e0563` | UI：`/admin/today`（阻塞名单/漏斗/Top 创作者占位/采用率）+ AdminNav "Today" 首项 + Customer 360 Alert Strip & 健康标记；admin i18n 新增 65 key（EN+中文）+ `adminTFmt` 插值 |

**口径落地（较 §7.5 的演进）：**
- 发布成功/失败从"❌ GAP 纯推断"升级为**双口径**：新数据走精确事件（EXACT），历史数据继续 `postedAt`/`publishError` 推断（INFERRED），UI 强制标注 inferred 徽标
- AI 采用率关联从"图片 URL 字符串匹配"升级为 `sourceGenerationId` 精确关联（新草稿），URL 匹配仅作历史数据回退
- 事件口径：409 去重与请求体校验失败**不算** attempt（attempt 从提交给 Pinterest 起算）；每个 attempted 必有恰一个终结事件

**待办（合并/上线前）：**
- [ ] `backend/db/migrate_v51_publish_events_index.sql`（`analytics_events` 补 `(user_id, event_name, created_at desc)` 索引）——已编写未应用，创始人签字后走 `run_migration.py --apply`
- [ ] v33/v34 生产应用状态确认（同上通道）
- [ ] §7.4 验收清单的浏览器实测项（真实数据下的名单/漏斗/Alert Strip 一致性）
- [ ] 已知局限：BatchEditDrawer 在 Studio 上下文的 `pinId` 非草稿 ID（join 不上，无害）；事件仅从部署起累积

## 文档历史

| 版本 | 日期 | 变更 |
|---|---|---|
| v1.0 | 2026-07-14 | 初版：四支柱定位 + P0/P1/P2 节奏 + P0 技术方案 |
| v1.1 | 2026-07-14 | 数据源核实结果写入 §7.2/§7.5 |
| v1.2 | 2026-07-16 | 方案 B 实施记录（§8）：事件落库 + 派生层 + UI 四提交；Paddle→Creem 订正 |
