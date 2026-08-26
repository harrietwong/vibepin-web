# 后台运营驾驶舱 PRD v1.8

**状态：** **P0 已终审通过，待合并 master + 部署。** §7.4 已在隔离测试库与 production build 下逐项复验（见 §9.2/§9.5）；`user_metadata.role` 越权修复已合入 `feat/admin-cockpit`，hydration 定向复验无报错，非超管最终停在 `/app?admin=forbidden` 并看到明确提示。`feat/admin-cockpit` 当前为 `master` 超集，**非 merge 净增量待回流**（准确清单以 `git log --no-merges master..feat/admin-cockpit` 为准）。**v33/v34/v51/v52 四迁移均已应用生产并逐列复核**。付费置顶只信 `app_metadata.plan`（`isPaid`/`planOf` 均已收窄，各带回归测试）。
**日期：** 2026-07-16（初稿 2026-07-14；§8 topology 于 2026-07-17 复核订正）
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
**Billing 完全不参与（2026-07-22 定稿）：** 健康分只看创作成功，**billing 状态既不参与评分、也不做封顶 override**。早期版本曾写"欠费强制封顶为黄"，实现审查时发现代码有意未做（`computeHealth` 注释 "Billing NEVER participates"），创始人裁定**以代码为准、删除该 override**——理由是它与本 PRD 的定位自相矛盾（"核心问题不是哪个客户赚多少钱"）：一个欠费但正在高频成功创作的用户，健康分不该因此变黄。欠费属于计费侧关注点，不进创作健康度。

Customer 360 的角色是支柱 1、2 点进去看细节的**落地页**，不是独立产品。

## 4. 明确不做（继承定位文档并强化）

- ❌ CRM / 销售漏斗 / 收入分析 / Enterprise Account / 复杂 Customer Success（原定位文档全集）
- ❌ "给管理员看的"复杂图表页——图表不能告诉你今天帮谁，就是装饰
- ❌ 提前的自动化干预（自动邮件、自动送 credit）——用户量小，**手动干预本身就是用户调研**
- ❌ 调研报告中的 P1/P2 项在用户量过 500 或有专职客服前一律不动：feedback 投票门户、segments、raw event inspector、可配置 pinned fields、细粒度角色权限
- ❌ 独立 orders 抽象、在后台重建 Creem 计费面板（只读镜像 + 深链，Creem 为唯一事实源）

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
| **P2** | `customer_events` 事件底座（真实 timeline 替换合成 activity）；Creem webhook mirror 完成后补 billing snapshot；error_incidents 归一化 | Creem 履约层上线 |
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
  - **付费用户置顶**：⚠️ PARTIAL，好于原判断。计费履约已切到 Creem（`creem_*` 表 v45 已应用，webhook 履约层 `web/src/app/api/webhooks/creem`）。**信任边界（随 master `e2543f6` 追合后订正）**：只信 `app_metadata.plan`（Creem webhook 写入的服务端缓存），**绝不读 `user_metadata.plan`**（用户可自改 = 可自授付费，`e2543f6` 已判定不可信）。P0 用 `app_metadata.plan` 过 `normalizePlanKey` 做置顶排序（付费 tier 且不为 free 即置顶）；付费置顶是排序提示、非授权门禁，取只读缓存即可，零新增查询；拿不到时不排序，不阻塞上线。实现见 `adminActionCenter.ts` `isPaid` / `customer360.ts` `planOf`。
- **激活漏斗** `adminActivationFunnel.ts`：按用户聚合五个里程碑时间戳（注册=`auth.users.created_at` / 首连=`pinterest_connections.created_at` / 首生成=`pin_generations` 最早 `created_at` / 首发布=见下 / 7 天复发布=见下），近 30 天注册用户为统计口径。**"首发布"和"7 天复发布"两个里程碑继承上面的发布落库 GAP**：P0 用 `pin_drafts.payload.postedAt` 存在性近似（需要客户端已同步该 draft 到服务端，`pin_drafts` v38 表），漏斗这两段的人数标注"近似（基于草稿同步状态）"。
- **健康标记与 Alert Strip**：与阻塞名单共用同一判定函数，单用户版本供 Customer 360 调用（`getUserBlockers(userId)`），保证两处口径永远一致。"14 天内有成功发布"信号继承同一个 `postedAt` 近似口径。
- **AI 采用率**：⚠️ PARTIAL。`pin_generations` 有 `draft_id` 列，但它引用的是旧的 `composer_drafts` 表（`migrate_v22.sql` SECTION 10，`REFERENCES composer_drafts(id)`），不是当前的 `pin_drafts`（v38，主键是 `(vibepin_user_id, draft_id)` 且 `draft_id` 是 text 而非 uuid）——**generation 和当前草稿系统之间没有可 join 的外键**。P0 近似口径：`total_pins`/`pin_urls`（generation 产出的图片 URL 集合）与 `pin_drafts.payload` 中引用的图片 URL 做字符串匹配，判定"该 generation 的产物是否出现在一个 `postedAt` 非空的 draft 里"，UI 必须标注"按图片 URL 近似关联，非精确外键"。P1 修复：在 studio 端生成 draft 时把 `pin_generations.id`（或 `session_id`）写入 `pin_drafts.payload.generationId`，一次性打通链路，之后 P0 的近似口径可退役。

### 7.3 工程硬规则（继承项目规范）
- 所有用户可见字符串走 admin i18n（adminMessages 体系，EN/中文两套，与现有 admin 一致）。
- 颜色只用 `--admin-*` token；缺表/缺列一律优雅降级为 n/a + 警告行（沿用 adminOverview 模式）。
- 全部只读，无 mutation；super admin gating 沿用 `getCurrentSuperAdmin()`。
- 前置清债已完成：v33（`admin_support_notes`）与 v34（`admin_audit_events`）均已应用生产，并通过 PostgREST 逐表复核；为将来写操作（送 token 等 safe actions）备好审计底座。

### 7.4 验收清单
- [ ] 阻塞名单五类判定各构造一个真实/模拟用户，逐类验证出现与消失（阻塞解决后离开名单）
- [ ] 漏斗各段人数与 SQL 手工核对一致
- [ ] Customer 360 Alert Strip 与阻塞名单对同一用户口径一致
- [ ] 健康标记 drivers 正确显示"为什么是黄/红"
- [ ] 空态：无阻塞时显示"今日无阻塞"
- [ ] i18n EN/中文切换无硬编码残留；深浅色主题正常
- [ ] 非 super admin 访问被重定向

### 7.5 数据源核实结果（2026-07-14）

代码、隔离测试库与生产迁移状态均已复核；生产业务数据未用于造数或破坏性测试。

| 数据需求 | 来源（table.column / 代码路径） | 状态 | P0 处理 |
|---|---|---|---|
| 1. 发布成功 | 无服务端记录；结果仅 return 给客户端，客户端写自己的 `pin_drafts.payload.remotePinId`/`postedAt`（`web/src/lib/server/pinterest/publishPin.ts`、`web/src/lib/smartSchedule.ts`） | ❌ GAP | 用 `pin_drafts.payload.postedAt` 存在性近似"已发布"，标注口径说明 |
| 1. 发布失败 | 无任何记录（客户端 toast，不落库）；`publish_jobs`/`social_publish_jobs` 结构齐全但 Pinterest 流程明确不写它们 | ❌ GAP | 用"计划时间已过但未见 postedAt"间接推断，标注"近似推断" |
| 2. AI 生成记录 | ✅ `pin_generations.status/error_type/error_message/created_at/user_id/keyword`，`web/src/lib/studioPersistence.ts` `insertGenerationToDb()` 写、`web/src/lib/server/adminOverview.ts`/`generationLogs.ts` 已读 | ✅ VERIFIED | 直接用；注意写入是客户端发起，非服务端强一致 |
| 3. 生成→草稿→发布关联 | `pin_generations.draft_id` 指向旧表 `composer_drafts`（`migrate_v22.sql`），与现行 `pin_drafts`（v38）无外键 | ⚠️ PARTIAL（近似口径：图片 URL 匹配） | 按生成产物图片 URL 与 draft payload 图片 URL 匹配近似关联，UI 标注"近似关联" |
| 4. Pinterest 连接状态 | ✅/⚠️ `pinterest_connections.needs_reconnect/disconnected_at`（`web/src/lib/server/pinterest/connectionStore.ts`），有状态列但无 `last_error` 文本 | ⚠️ PARTIAL | 判定用 `needs_reconnect OR disconnected_at`；原因摘要用固定文案，不展示具体错误 |
| 5. 注册与活跃信号 | ✅ `auth.users`（service role listUsers，`adminOverview.ts`/`customer360.ts` 先例）；7 天活跃 = `last_sign_in_at` + `pin_generations.created_at` 等合成 activity（`customer360.ts` 已有"synthesized activity"模式） | ✅ VERIFIED | 直接复用 `customer360.ts` 现有合成逻辑 |
| 6. Plan / 付费状态 | ✅ `auth.users.app_metadata.plan`（Creem webhook 写的服务端缓存，`customer360.ts` `planOf()` / `adminActionCenter.ts` `isPaid()` 读）；计费已切 Creem（`creem_*` 表 v45） | ⚠️ PARTIAL（信任边界已收窄） | **只用 `app_metadata.plan`** 做置顶排序（过 `normalizePlanKey`）；绝不读用户可自改的 `user_metadata.plan`（`e2543f6` 信任边界）。排序提示非授权门禁 |
| 7. Support 工单 | ✅ `support_tickets.status`（'Open'/'In progress'/...）+ `user_id`，`backend/db/migrate_v35_support_tickets.sql`，`web/src/app/api/admin/support/tickets/route.ts` | ✅ VERIFIED | 直接用，按 user_id 聚合未关闭工单数 |
| 8. v33/v34 迁移 | `backend/db/migrate_v33_admin_support_notes.sql`（建表 `admin_support_notes`：客服内部备注）；`backend/db/migrate_v34_admin_audit_events.sql`（建表 `admin_audit_events`：管理员敏感操作审计日志） | ✅ 已应用生产并复核 | 保持现状；未来写操作复用审计底座 |
| 9. Admin i18n + 主题 | `web/src/lib/admin/adminMessages.ts`（catalog）；`--admin-*` CSS token 约定（现有 admin 页面统一遵守） | ✅ VERIFIED | 新增文案沿用同一 catalog + token 体系 |
| 10. 分析事件表 | ✅ `analytics_events`（v41，`web/src/app/api/analytics/events/route.ts`），`web/src/lib/analytics.ts` 定义事件类型（含 `draft_published`），事件落库非仅 console | ✅ VERIFIED（范围窄） | 可作为 7 天活跃信号的补充信号，不作为主信号（当前事件集中在 Creative Intelligence 相关操作，非全量行为埋点） |

---

## 8. 实施记录（P0，2026-07-16；topology 2026-07-17 复核订正）

创始人决策采用**方案 B**：发布事件服务端落库作为 P0 instrumentation 先行（admin 仍全只读），随后构建派生层与 UI。实施在 `feat/admin-cockpit` 分支（自 master `45b825c` 切出，独立 worktree）。

**Git 拓扑（2026-07-17 现场 `git log` 复核，不沿用早前描述）：**
- `master` HEAD = `b6f935f`（`merge: unify feat/pinterest-production-transition into master`）。本节前 5 个提交已经随这次生产化统一并入 `master`，即 master 现已包含驾驶舱的 P0 核心。
- `feat/admin-cockpit` 是 `master` 的**超集**：多次把前进的 master 合了进来（最近一次追合含 master 的 10 个 Creem/billing 提交，其中 `e2543f6` 移除 `user_metadata.plan` 授权），核心 5 提交已随生产化统一合并入 master。
- 因此本分支相对 master 的**净增量**（`git log master..feat/admin-cockpit` 的非 merge 提交）= 早期两修复 `3d4180b`/`1514eae` + 二次评审四修复 `48622b3`/`6123cae`/`22b24fa`/`1c8d118` + 文档订正 `0ab2f2b` + 付费置顶安全修复 `99702ff`（及本次 `planOf` 收窄）。其余提交为共享历史。

**本分支相关的全部提交：5 个已随生产化统一并入 master（共享历史），其余为非 merge 净增量待回流（准确清单以 `git log --no-merges master..feat/admin-cockpit` 为准；下表列主要项，含文档订正与 planOf 测试 `68d95c5` 等收尾提交）。真实 commit message 摘要，非杜撰：**

| 提交 | 是否已在 master | 内容 |
|---|---|---|
| `2cca984` | ✅ 已在 master | `feat(observability): server-side pinterest publish events (attempted/succeeded/failed)` — 三事件落库 `analytics_events`（即时路由 + 排期 cron 双路径；`publishAttemptId` 贯穿；错误消息脱敏 ≤300 字符；best-effort 永不影响发布）；同时打通 `pin_drafts.payload.sourceGenerationId/sourceAssetKey` |
| `3687213` | ✅ 已在 master | `fix(observability): terminal publish event for the cron trial-access skip` — cron trial-access 跳过时补终结事件，杜绝 attempted 悬挂 |
| `f76c624` | ✅ 已在 master | `feat(admin): server-side derivation layer for the operator console` — 派生层 `adminActionCenter.ts`（5 类阻塞 + `getUserBlockers` + 健康分）/ `adminActivationFunnel.ts` / `adminAiAdoption.ts` / `adminQueryUtils.ts`（分页防 1000 行陷阱，无 per-user N+1） |
| `05e0563` | ✅ 已在 master | `feat(admin): /admin/today operator console UI + Customer 360 alert strip` — UI `/admin/today`（阻塞名单/漏斗/Top 创作者占位/采用率）+ AdminNav "Today" 首项 + Customer 360 Alert Strip & 健康标记；admin i18n 新增文案（EN+中文）+ `adminTFmt` 插值 |
| `2a4f9ec` | ✅ 已在 master | `fix(observability): analytics client construction is best-effort too` — 分析客户端构造失败也降级为 best-effort，杜绝其反噬发布路径 |
| `3d4180b` | ❌ 净增量 | `fix(studio): persist generation context columns + request id (v52)` — 修复自 ~2026-06-14 起的 schema drift：`pin_generations` 缺 13 个扩展上下文列，PostgREST 拒整条 INSERT 且写入方 `catch {}` 吞错，导致一个月的生成历史**从未落库**（只活在 localStorage）。v52 迁移补 13 列 + `generation_request_id`（+ 部分索引）；HistoryEntry 携带 `generationRequestId`，Studio 主生成流把 `sessionId` 写为 request id |
| `1514eae` | ❌ 净增量 | `fix(admin): adoption exact-link keys on generation_request_id` — 采用率精确关联原本拿 `draft.sourceGenerationId` 去比 `generation.id`（草稿从不存的 DB uuid），生产里精确链路永远无法命中；改为优先比 `generation_request_id`（DB id 留作兜底），`loadGenerations` SELECT 该列并在缺列时回退，兼容 pre-v52 库 |
| `48622b3` | ❌ 净增量 | `fix(admin): connected_not_creating existence check must be all-time, not 30-day window` — 二次评审 P1：老用户 30 天前创作过、近期未创作被误判"从未创作"；存在性判定改全历史，窗口性指标保持窗口；补 3 个回归测试 |
| `6123cae` | ❌ 净增量 | `fix(admin): localize relative-time strings on /admin/today` — 二次评审 P1：相对时间硬编码英文（just now/3h ago）漏进中文界面；走 admin i18n 双语 catalog |
| `22b24fa` | ❌ 净增量 | `fix(admin): always show exact/inferred publish split note, including 0/0` — 二次评审 P1：0/0 时口径说明被隐藏（真实数据正好踩中）；始终显示，0/0 用专门文案 |
| `1c8d118` / `0ab2f2b` | ❌ 净增量 | 文档订正：§8 提交列表 + 迁移应用状态 + 残留 Paddle→Creem |
| `99702ff` | ❌ 净增量 | `security(admin): stop trusting user_metadata.plan in Action Center isPaid` — `isPaid` 只信 `app_metadata.plan`（对齐 `e2543f6`）+ `normalizePlanKey`；配回归测试 |
| `d8dbb9f` | ❌ 净增量 | `fix(admin): planOf trusts app_metadata.plan only` — 同类漏洞 `customer360.ts` `planOf` 收窄（+ 回归测试 `test-customer360-plan.ts`） |

**口径落地（较 §7.5 的演进）：**
- 发布成功/失败从"❌ GAP 纯推断"升级为**双口径**：新数据走精确事件（EXACT），历史数据继续 `postedAt`/`publishError` 推断（INFERRED），UI 强制标注 inferred 徽标
- AI 采用率关联从"图片 URL 字符串匹配"升级为 `sourceGenerationId` ↔ `generation_request_id` 精确关联（新草稿，`1514eae` 修正关联键），URL 匹配仅作历史数据回退
- 事件口径：409 去重与请求体校验失败**不算** attempt（attempt 从提交给 Pinterest 起算）；每个 attempted 必有恰一个终结事件

**付费置顶安全语义（`99702ff`，随 master 的 `e2543f6` 追合后修复）：**
- master `e2543f6` 判定 `user_metadata.plan` 不可信（用户可自改 → 自授付费）。阻塞名单 `isPaid` 原先 app_metadata 缺失时回退读 `user_metadata.plan`，等于在 admin 侧重开该漏洞。已改为**只信 `app_metadata.plan`**（Creem webhook 写入的服务端缓存，与 `resolvePlan` 的 fallback 同源）+ 过 `normalizePlanKey`；付费置顶是排序提示非授权门禁，此口径正确且零新增查询。同类漏洞 `customer360.ts` 的 `planOf`（Customer 360 页面展示 plan）本次一并收窄。

**待办（合并/上线前）：**
- [ ] 把净增量回流合并进 `master`：`3d4180b`/`1514eae` + 二次评审 4 修复 `48622b3`/`6123cae`/`22b24fa`/`1c8d118` + `0ab2f2b` + 安全修复 `99702ff` + `planOf` 收窄
- [x] ~~v52 迁移应用~~ **已应用**（2026-07-16，`run_migration.py --apply` HTTP 201 + PostgREST 逐列复核 status/generation_request_id/setup_snapshot 存在）。schema drift 造成的 ~2026-06-14 起整月生成行静默丢失自此止血；历史丢失行不可从 DB 恢复（各浏览器 localStorage 50 条/设备 + storage bucket 可部分重建）
- [x] ~~v51 迁移应用~~ **已应用**（2026-07-16，同通道，HTTP 201）
- [x] ~~v33/v34 状态确认~~ **已确认并应用**（2026-07-16：探测确认原先未应用 → 应用 → PostgREST 复核 `admin_support_notes`/`admin_audit_events` 存在）
- [x] §7.4 浏览器实测与复验完成：名单/漏斗/Alert Strip 一致，EN/中文切换、相对时间、精确/推断、空态与 0/0 口径均已覆盖
- [ ] 已知局限：BatchEditDrawer 在 Studio 上下文的 `pinId` 非草稿 ID（join 不上，无害）；事件仅从部署起累积

## 9. §7.4 验收 + 安全评审（2026-07-21~22）

### 9.1 隔离测试环境（不碰生产）

生产库禁止造测试数据，本轮建立独立测试库并把规则固化进 `.claude/CLAUDE.md`「测试环境隔离」章节：

| 环境 | project ref | 凭据文件 |
|---|---|---|
| 生产 | `jaxteelkecvlozdrdoog` | `.env.local`（只读探测） |
| 测试 | `snulmwprsahzqvdbyenc` | `web/.env.test.local` |

任何写操作前必须打印 project ref 并断言 ≠ 生产。`backend/scripts/setup_test_db.py`（按 console 实读表转录 DDL，52 个迁移非线性自洽不整链重放）与 `seed_test_cockpit.py`（17 个 `e2e-cockpit-*@example.test` 合成用户覆盖五类阻塞 + 负向对照 + 付费/伪造付费 + 漏斗五段）已纳入候选分支。造数密码不写死：可由 `COCKPIT_E2E_PASSWORD` 注入，否则每次随机生成。全程复核生产 `pin_generations` 仍 4 行、0 个 e2e 用户。

### 9.2 §7.4 逐项验收结果（浏览器实测 + 独立复核）

用 API 换 session 注入 cookie（绕开登录表单 hydration 竞态）+ 无 bypass 实例（:3100）+ 有 bypass 对照（:3000）验证门禁真实生效：

| 项 | 结果 | 关键证据 |
|---|---|---|
| 阻塞消失 | ✅ | 翻转数据后 11→7 行，三类阻塞离开名单 |
| 空态 | ✅ | 「今日无阻塞 / No blockers today」中英双语 |
| 0/0 口径 | ✅ | 零发布 cohort 下两发布段均显示「尚无发布数据可归因」 |
| 独立 SQL 对账 | ✅ | 按 PRD 定义独立写 SQL（非照抄实现），五段 18/12/5/3/1 全对 |
| 健康 drivers | ✅ | 三档 Healthy/Needs attention/At risk + 具体 why |
| 已登录普通用户被拒 | ✅ | 重定向离开后台 |
| 真超管无 bypass 通过 | ✅ | 页面渲染，替代 bypass 假对照 |
| `/api/admin/*` 负向 | ✅ | 未认证/普通用户 403 无泄露，超管 200 正对照 |
| AI 采用率 UI 断言 | ✅ | DOM 实测 60%、3/5、2 exact·1 inferred |
| hydration | ✅ | production build 下 `/admin/today` + 两种 Customer 360 数据形态定向复验，控制台 0 error/0 warning |

### 9.3 越权漏洞（浏览器实证 + 已修并合入候选分支）

**§7.4「非 super admin 访问被重定向」实测判负**：`superAdmin.ts` 的 `isSuperAdminUser`/`adminRoleOf` 回退信任**用户可自改的** `user_metadata.role`。实证：app_metadata 空、仅自设 `user_metadata.role='super_admin'` 的用户完整进入 `/admin/today`（徽章 "Super Admin only · Internal"，见客户邮箱），`/api/admin/me` 返回 `{"isSuperAdmin":true}`；伪造 `support` 进入 `/admin/generation-logs` 读 9 条日志。同类回退还有 `generationDebugAccess.ts`（完整 prompt 访问权）。**既有测试 `test-shared-pin-details` 曾把该漏洞断言为正确规格**。

Codex 裁决：必须移除，无合理例外（Supabase 官方明确 user_metadata 不可用于授权）。修复内容：两处授权只信 `app_metadata.role` + 邮箱允许名单；`E2E_TEST_MODE` 补上此前缺失的 `NODE_ENV !== production` 硬门；predeploy-guard 补拦 `ENABLE_LOCAL_ADMIN_BYPASS`。安全分支已追合最新 master 后合入 `feat/admin-cockpit`；最终安全套件 26/26。**迁移零风险**：生产 5 用户 0 人靠 metadata.role 授权（全走 `SUPER_ADMIN_EMAILS`），0 测试依赖该路径。

### 9.4 回流顺序（Codex 裁决）

Codex 否决"先回流驾驶舱"：不得把已知可利用漏洞作为已签收版本传播。该顺序已在候选分支闭环：**安全分支追合最新 master → 合入驾驶舱 → 重跑全部门禁与授权负向测试 → Codex 最终签收**。剩余动作仅为把已签收的 `feat/admin-cockpit` 合并进健康、未被其他会话占用的 master worktree，再部署。

### 9.5 最终终审（2026-08-26）

- 候选分支内的初始化/造数脚本通过语法、连通性、逐列 schema 合同与实际 reset+seed 验证；隔离测试库重造 17 个合成用户，覆盖五类阻塞、精确/推断发布、45 天历史负向对照、付费/伪造付费排序、五段漏斗与权限正负样本；每次写入前硬断言测试 project ref，未向生产造数，测试账号密码不再硬编码。
- production build 浏览器实测通过：`/admin/today` 基本渲染、Today 首项导航、只读标识、阻塞表、五段漏斗、P1 占位、AI 采用率、EN/中文切换及中文相对时间均符合清单；Customer 360 的阻塞/无阻塞两种形态与 Today 一致，0 hydration/console 错误。
- 非超管安全门禁真实生效；补修二次跳转丢失 `admin=forbidden` 的问题，最终 URL 为 `/app?admin=forbidden`，并显示可访问、双语的权限提示；安全回归 26/26。
- 全量门禁最终为 **132/132**，`tsc --noEmit` 零错误，production build 成功。全量门禁首次暴露 basket 同毫秒连续写入可能不推进 LWW 时间戳，已修为严格单调并复跑全绿。
- 结论：`feat/admin-cockpit` 满足 P0 功能、安全、数据诚实、i18n、权限与生产构建要求；**签收通过，待回流 master + 部署**。

## 文档历史

| 版本 | 日期 | 变更 |
|---|---|---|
| v1.0 | 2026-07-14 | 初版：四支柱定位 + P0/P1/P2 节奏 + P0 技术方案 |
| v1.1 | 2026-07-14 | 数据源核实结果写入 §7.2/§7.5 |
| v1.2 | 2026-07-16 | 方案 B 实施记录（§8）：事件落库 + 派生层 + UI 四提交；Paddle→Creem 订正 |
| v1.3 | 2026-07-17 | §8 topology 复核订正：列全 7 个相关提交（含 `2a4f9ec`/`3d4180b`/`1514eae`），厘清 5 已入 master + 2 仅在分支的真实关系；补 v52 未应用 + 整月 `pin_generations` 静默丢行；清剩余 Paddle 引用 → Creem |
| v1.4 | 2026-07-18 | 迁移 v33/34/51/52 全部已应用+复核（订正 v1.3 的"未应用"）；追合 master 10 个 Creem 提交（含 `e2543f6` 移除 user_metadata plan 授权）；付费置顶安全修复 `99702ff`（isPaid 只信 app_metadata）+ `planOf` 同类收窄；净增量列表更新 |
| v1.5 | 2026-07-18 | 三次评审闭环：追合 `dc74a0f`（pricing）；清 §6.1/§7.5/§8 三处残留"读 user_metadata.plan"旧口径；§8 提交表补齐至 9 个真实净增量（原写"7 个"）；补 `planOf` 回归测试 `test-customer360-plan.ts` |
| v1.6 | 2026-07-22 | 新增 §9：隔离测试库 + §7.4 逐项浏览器验收（独立复核，含按 PRD 定义独立写的漏斗 SQL 对账）+ **越权漏洞实证**（user_metadata.role 自授超管）+ 已修（独立 security 分支）+ Codex 裁决的回流顺序。状态：驾驶舱功能验收通过，签收阻塞于安全修复回流 master + hydration prod-build 复验 |
| v1.7 | 2026-07-22 | 代码↔PRD 对照审查（Fable 终审）：支柱4 **删除 billing override**（创始人裁定以代码为准——健康分只看创作成功，欠费不封顶，与本 PRD 定位自洽）；修复推断发布失败未受 24h 窗口约束的真实缺口（`0cc6f96`，附 4 个回归测试，回退验证 34/4→38/0）；C360 硬编码色值记为已知不一致（v0 页面既有风格，不在本次范围） |
| v1.8 | 2026-08-26 | Codex 最终终审：安全分支合入候选、production build/hydration 与隔离测试库浏览器复验通过；修复 `/app?admin=forbidden` 参数丢失并补双语提示/安全回归；修复 basket LWW 同毫秒时间戳；最终 132/132 + tsc + production build 全绿，状态更新为“待合并 master + 部署” |
