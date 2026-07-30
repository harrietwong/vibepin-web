# Create Pins & Plan 工作流优化 PRD v1.0 — Fable 评审报告

**评审人：** Fable 5（3 个代码核查代理并行验证 + 汇总）
**日期：** 2026-07-11
**结论：** 方向正确，可实施；但存在 1 个范围性缺口（自动到期发布不存在）、1 个产品冲突（AI Copy 回滚昨日 v1.2 交付）、2 个现存 bug（Plan 抽屉失败不落库、描述 800/500 不一致）需先定夺。

---

## 一、产品评审摘要

（完整版见主对话，此处存档要点）

**重大冲突：** PRD 第 7 节要求删除的 Short/Standard/SEO-rich 长度上限与 per-run 语言选择，是 2026-07-10 刚按 Create Pins PRD v1.2 验收交付的功能。需明确这是有意取代 v1.2。**建议折中：只收 UI，保留 API 参数与上限逻辑，语言未来降级到 Settings**（调研报告原建议即 defer to settings，PRD 砍成非目标属于过度执行）。

**7 个优化点：**
1. Banner 数字（仅 publish failure）与 Failed 筛选内容（混合两类失败）会对不上 → Banner 跳转应带 publish 子筛选。
2. 13.2 "按错误类型分配操作"缺数据结构 → 需增 `errorCategory: transient | content | auth` 落库。
3. Banner 缺会话级 dismiss（调研明确建议有）。
4. 失败邮件通知应标"下一轮 P1"而非无限期非目标（scheduled 失败恰发生在用户离线时）。
5. 批量 Retry（仅 transient）缺失，token 失效批量翻车场景体验差。
6. 默认切 Unscheduled 需要空状态引导（"All pins scheduled — view in Plan"）防止"Pin 全丢了"恐慌。
7. Open in Plan 应深链定位到该 Pin，不是 Plan 首页。

**肯定项：** Product 不自动写 URL 的防御规则组、不新增 Publishing 生命周期、失败不保留 Scheduled、Move to Unscheduled 保留后台失败历史。

---

## 二、Current Verified Behavior（对 PRD §18 二十问的核实）

| # | 问题 | 核实结果 |
|---|------|---------|
| 1 | 默认筛选切 Unscheduled 影响 | 现默认 **All**，纯内存 `useState`，**无任何持久化/恢复机制**（StudioBoard.tsx:47, usePinBoardDrafts.ts:25）→ 改默认值无兼容负担 |
| 2 | Schedule 后移出默认列表 | 筛选是纯客户端 `useMemo` 过滤，lifecycle 变 scheduled 后卡片**自动**从 Unscheduled 视图消失，无需新逻辑；无滚动保持代码（一般无需）；Toast 已显示真实时间（smartSchedule.ts:232-238），缺 `[Open in Plan]` action |
| 3 | Scheduled 卡错误 CTA | **属实**：展开态 footer 固定渲染 Schedule 按钮，不判断 lifecycle（PinBoardCard.tsx:541-544）。收起态已正确（Edit + View Plan，:406-414）；Unschedule 已存在于 ⋮ 菜单（:275） |
| 4 | 编辑保留 schedule time | **已满足**：persistNow 只 patch 6 个字段，updateDraft 浅合并，不触碰 scheduledDate/Time（PinBoardCard.tsx:151-161, pinDraftStore.ts:622-625）；自动保存 debounce 400ms + collapse/unmount flush |
| 5 | AI Copy 旧偏好兼容 | 长度/语言均为 PinAICopyPanel 内 `useState`，**无持久化**；API 有安全默认（language??en：ai-copy/route.ts:212；normalizeCopyLength→standard 含 legacy "detailed"：visionServer.ts:470-474）→ **删 UI 低风险** |
| 6 | Generate 填空/确认逻辑 | **不存在**：applyCopy 无条件覆盖 title/description/altText（PinBoardCard.tsx:227-236），仅 destinationUrl 保留已有值 → 全新逻辑。失败行为已合规（throw 前不写 filler，PinAICopyPanel.tsx:185-190） |
| 7 | ProductPickerModal 复用 | **可直接复用**：5 个 tab（Recommended/Search/Shopify/Use a link/Create manually），确认才 onSelect→createBoardDraft（StudioBoard.tsx:186-219）语义与 PRD 8.3 一致 |
| 8 | Shopify 进入 ProductSelection | 是，Shopify 是 modal 内 tab（store_products.id）；"Select product" 按钮已在 header（StudioBoard.tsx:412-416，gated on shopifyEnabled）；无页面级 Import from Shopify；creatorProductLink 是 Amazon affiliate 体系，与 Shopify picker 无关 |
| 9 | URL 自动覆盖 | **存在冲突**：Plan 抽屉 attachProduct 在 URL 为空时**自动填** Product URL（DraftDetailsDrawer.tsx:719-722），违反 PRD 10.3.1；StudioBoard 路径从不自动填；解绑不清 URL（合规）；已有 "Use primary URL" 按钮 + window.confirm 覆盖确认（:932-938）≈ PRD 10.2 雏形 |
| 10 | 可复用 Banner 容器 | **无**：ui/ 下无 Banner/Alert 组件；Plan 页两条横幅是各自内联 div、样式重复硬编码（plan/page.tsx:2246-2260）→ 需新建共享组件 |
| 11 | 两类失败可区分 | 数据层可区分（publishError vs generationStatus），但 lifecycle 合并为单一 failed（pinLifecycle.ts:46），**无 failureType 持久化字段**，UI/筛选不分桶 |
| 12 | Failed 筛选承载力 | 筛选机制可承载；但 Failed 卡当前**不显示错误文本、不显示原排程时间**，仅 Try again/Edit + Regenerate/Delete，**无 Move to Unscheduled**（PinBoardCard.tsx:269-271,397-404） |
| 13 | Publish now 统一性 | **不统一**：Plan 抽屉 footer 是 "Publish now" 而同抽屉溢出菜单是 **"Pin now"**（DraftDetailsDrawer.tsx:1092-1096 vs 1490-1493，两套 i18n key 均在 en.ts:323/360）；其余 5 处硬编码 "Publish now" 未走 i18n；**单 Pin 发布无确认弹窗**（仅 Batch 有，BatchEditDrawer.tsx:1596-1605） |
| 14 | 现有预发布校验 | **两套不一致体系**：pinReadiness.ts（严格：image+title+description+altText+board，Studio/Batch 使用）vs Plan 抽屉私有逻辑（Schedule 仅 board+日期时间；Publish 仅 image+board，DraftDetailsDrawer.tsx:795-811,1041-1043）；服务端有 URL 校验+100/500/500 截断（pins/route.ts:53-67）；字段级错误提示基本缺失（仅 boardError 一处） |
| 15 | Carousel 比例校验归属 | **Carousel 功能不存在**（全仓零命中），PRD 14 相关条款作废或标 N/A；另发现 PinDetailsDrawer.tsx:1136 描述 maxLength=800 与产品承诺 500 不一致（现存 bug） |
| 16 | 服务端持久化真实性 | **双写模型**：localStorage 为客户端权威（vp:pin_drafts:v1）+ outbox 同步到 pin_drafts 表 payload jsonb（LWW by updatedAt）；title/description/URL/board/scheduled/remotePinId/remotePinUrl/publishError/product 关联**全部只在 payload 内**，无独立列；smartSchedule slot 分配纯客户端 |
| 17 | 需要迁移的改动 | 见第五节：**最小路径零迁移**（新字段走 payload jsonb）；若要服务端可查询失败计数才需 v42 |
| 18 | 平行字段/重复逻辑 | 有：双校验体系（#14）、双发布失败处理（Studio 落库 vs Plan 抽屉仅本地 state）、双 Publish 文案体系（i18n vs 硬编码）、Batch URL "product" 模式与单 Pin "Use primary URL" 是两套实现 |
| 19 | 能否最小修改完成 | 能。绝大部分是条件渲染、字段增补与逻辑收敛，无需重写；详见第五节 |
| 20 | 浏览器 QA | 见第八节 |

### 🔴 范围性缺口：自动到期发布不存在

`web/`（PinDraft/Weekly Plan 产品面）**没有任何 cron/worker/轮询会在 scheduled time 到点时自动发布**（vercel.json 无 crons，无处理 plannedAt 的 API）。现在 "Scheduled" 只是日历展示状态，实际发布全靠人工 Publish now。仓库里的 publishing_queue/publish_jobs + backend publisher.py 是**另一套未对接的旧模型**。

PRD 14.3 "Publish now **或自动到期发布**前检查" 隐含假设该能力存在。必须显式决策：
- **A（建议）**：本轮不做自动发布，PRD 中明确"Scheduled 到点不自动发布，需 Publish now"，失败恢复流程仅覆盖手动发布路径；自动发布列为独立的下一轮项目（需要 cron + durable idempotency + token 服务端刷新，体量不小）。
- **B**：本轮包含自动发布 → 范围显著扩大，P0 排期需重估。

### 🔴 现存 bug（无论 PRD 是否实施都应修）

1. **Plan 抽屉发布失败不落库**：catch 块仅 setPublishError（React state）+ toast，从不 updateDraft → Pin 仍显示 Scheduled、错误刷新即丢、跨设备不可见（DraftDetailsDrawer.tsx:897-918）。直接违反 PRD 11.5，Studio 路径则正确落库（StudioBoard.tsx:180-183）。Batch 失败同样不持久化。
2. **PinDetailsDrawer 描述上限 800**：UI 允许输 800 字，服务端发布时截到 500，用户所见非所发（PinDetailsDrawer.tsx:1136）。

---

## 三、Gap Matrix

| PRD 节 | 现状 | 差距 | 体量 |
|--------|------|------|------|
| 5.1 默认 Unscheduled | 默认 All | 改默认值 + 空状态引导文案 | 小 |
| 5.2 Schedule 后行为 | 视图过滤自动生效；Toast 无跳转 | Toast 加 [Open in Plan] action | 小 |
| 6.3 Scheduled 卡 CTA | 展开态固定 Schedule 按钮 | footer 按 lifecycle 条件渲染 | 小 |
| 6.1/6.4 编辑保时/Unschedule | 已满足 | 无 | — |
| 7.1/7.2 AI 控件收敛 | 控件在 PinAICopyPanel | 删 UI 控件，API 保留默认值 | 小 |
| 7.3 填空+确认替换 | 无条件覆盖 | 新写合并规则 + 确认弹窗 | 中 |
| 7.4 失败行为 | 已满足 | 无 | — |
| 8 商品入口 | Select product 已在 header | 空状态加 "Create from your store?" 引导 | 小 |
| 9 Edit Pin Product 字段 | 卡片仅静态 "No linked product" 占位 | 卡片上做 Product 关联/摘要/Change/Remove UI | 中 |
| 10.2 Use product link | Plan 抽屉有雏形（window.confirm） | 统一为设计弹窗；Studio 卡片补同功能 | 中 |
| 10.3.1 不自动填 URL | attachProduct 空时自动填 | 删除自动填，改提示条 | 小 |
| 11.1 命名统一 | Pin now 残留 + 硬编码 | 统一 i18n key "Publish now" | 小 |
| 11.2 确认弹窗 | 仅 Batch 有 | 单 Pin 各入口加确认（复用一个组件） | 小-中 |
| 11.5 失败落库 | Plan 抽屉/Batch 不落库 | 统一失败写 publishError+failureType+previousScheduledTime | 中 |
| 12 全局 Banner | 无组件 | 新建共享 FailureBanner + 两页挂载 + 计数 | 中 |
| 13 Failed 恢复 | 无错误展示/无 Move to Unscheduled/无 errorCategory | Failed 卡信息区 + 操作矩阵 + 错误分类映射 | 中-大 |
| 14 校验统一 | 双体系不一致；Carousel 条款作废 | Plan 抽屉接入 pinReadiness；URL 校验入 readiness；800→500 | 中 |
| 15 持久化 | payload jsonb 已同步全部字段 | 新字段进 payload 即可；"服务端计算计数"降级为"同步后客户端计算" | 小 |

---

## 四、Exact Files Involved

**核心修改：**
- `web/src/components/studio/StudioBoard.tsx` — 默认筛选、Toast action、Move to Unscheduled handler、失败处理
- `web/src/hooks/usePinBoardDrafts.ts` — 筛选默认值/failureType 子筛选
- `web/src/components/studio/PinBoardCard.tsx` — 展开态 footer 条件渲染、Failed 信息区、applyCopy 合并规则、Product 摘要区、⋮ 菜单
- `web/src/components/pins/PinAICopyPanel.tsx` — 删长度/语言控件、替换确认
- `web/src/components/plan/DraftDetailsDrawer.tsx` — 失败落库（bug）、attachProduct 去自动填、Publish 确认、pinReadiness 接入、Pin now→Publish now
- `web/src/components/studio/BatchEditDrawer.tsx` — 批量失败落库
- `web/src/lib/studio/pinLifecycle.ts` — failureType/errorCategory 派生与徽章
- `web/src/lib/pinDraftStore.ts` — 新字段（failureType/errorCategory/previousScheduledTime/publishErrorCode）
- `web/src/lib/pinReadiness.ts` — URL 格式校验并入、供 Plan 抽屉复用
- `web/src/lib/smartSchedule.ts` — Toast 文案带 action 参数
- `web/src/app/app/plan/page.tsx` — Banner 挂载、命名
- `web/src/components/studio/PinDetailsDrawer.tsx` — maxLength 800→500
- `web/src/components/plan/PlanListView.tsx`、`PinHoverPreview.tsx` — 确认弹窗接入
- `web/src/lib/i18n/messages/*.ts` — 统一 publishNow key、删 pinNow、新增 Banner/确认/失败文案（18 locales）

**新建：**
- `web/src/components/ui/FailureBanner.tsx`（或 components/shared/）— 共享持久 Banner
- 确认弹窗可复用现有 modal 模式（BatchEditDrawer 内已有样板）

---

## 五、Data Migration Requirements

**最小路径：零迁移。** pin_drafts.payload 是 jsonb，新增 `failureType`、`errorCategory`、`previousScheduledTime`、`publishErrorCode` 直接作为 PinDraft 可选字段随 payload 同步，与现有 optional 字段模式一致，向后兼容（旧 payload 无该 key → undefined）。

**Banner 计数**：PRD 12.4 写"数量从服务端状态计算"。最小实现为**同步后客户端计算**（store 内 count publishError 非空且 failureType=publish 的 draft），跨设备一致性由既有 outbox 同步保证。若未来要严格服务端计数/邮件通知/analytics，则需 v42 迁移仿 v41 模式 promote 一列（如 `publish_failed_at timestamptz`），并在 promote.ts + route.ts 的 buildPromotedColumns 登记、处理 isMissingColumnError 降级。**本轮不建议做。**

---

## 六、Risk List

1. **自动发布范围误解**（🔴 最高）：若干 PRD 条款（14.3、13 的部分场景）隐含自动发布存在。需按第二节决策 A/B 后再排期。
2. **LWW 同步覆盖失败状态**：payload 整包 LWW 合并，若设备 A 失败落库、设备 B 离线持旧副本后编辑，B 的 updatedAt 更新会整包覆盖 A 的 publishError。现有架构固有风险，本轮接受但需知晓。
3. **in-flight 锁非持久**：server 锁是 per-process 内存 Set，Vercel 多实例/重启下防重不可靠；durable idempotency 仍是 P1 欠账（与既有结论一致）。
4. **errorCategory 分类准确性**：transient/content 分类依赖对 Pinterest 错误码的映射（现有 board_not_owned/needs_reconnect/publish_in_progress 等可映射），未知错误需默认 transient（宁可让用户 Retry）。
5. **i18n 面积**：文案改动 × 18 locales；建议本轮新文案先英文 + 英文回退机制兜底，翻译批量补。
6. **AI Copy 回滚的用户感知**：昨日刚上的控件消失，若有真实用户在用需要 changelog/公告。
7. **Failed 筛选语义变化**：Banner 只统计 publish，Failed 筛选混两类 — 若不做子筛选，数字对不上（产品优化点 1）。

---

## 七、P0 / P1

**P0（本轮必做）：**
1. Plan 抽屉/Batch 发布失败落库（bug 修复，含 failureType/previousScheduledTime/errorCategory 字段落地）
2. Scheduled 展开卡 footer：Schedule → "Scheduled for … [Open in Plan]"
3. 默认筛选 Unscheduled + 空状态引导 + Schedule Toast 加 [Open in Plan]
4. Publish now 命名统一（删 Pin now）+ 单 Pin 确认弹窗（所有入口）
5. Generate copy 填空规则 + 替换确认；删长度/语言 UI 控件（保留 API 参数与上限逻辑）
6. attachProduct 取消自动填 URL → "Product link available [Use product link as destination]" 提示条（含已有值确认弹窗，替换 window.confirm）
7. FailureBanner 组件 + Create Pins/Plan 挂载 + 客户端计数 + 跳转 Failed(publish) 子筛选
8. Failed 卡信息区（错误文案+推荐修复+原排程时间）+ 操作矩阵（Retry/Edit 按 errorCategory 主次互换、Move to Unscheduled、Delete）
9. Plan 抽屉接入 pinReadiness 统一校验 + URL 格式校验并入 + PinDetailsDrawer 800→500
10. Edit Pin 的 Product 字段区（摘要/Change/View/Remove）——若体量超预算可降 P1，与 #6 联动

**P1（下一轮）：**
- 自动到期发布（独立项目：cron + durable idempotency + 服务端 token 刷新）
- durable publish idempotency（DB 级）
- 批量 Retry（仅 transient）
- 失败邮件通知
- Banner 会话级 dismiss
- 服务端失败计数列（v42）
- 语言/长度偏好进 Settings

**作废条款：** Carousel 比例校验（14.1/14.2）——功能不存在，待 Carousel 立项时再随附。

---

## 八、Acceptance Checklist（可执行版）

PRD §17 基础上修订：
- [ ] 默认筛选 Unscheduled；空 Unscheduled 且有 Scheduled 时显示引导空状态
- [ ] Schedule 成功：卡片离开 Unscheduled 视图、Toast 含真实时间 + Open in Plan、All/Scheduled 可见
- [ ] Scheduled 展开卡无 Schedule 按钮，显示时间 + Open in Plan（深链定位该 Pin）
- [ ] Scheduled metadata 编辑后 scheduledDate/Time 不变（已满足，回归项）
- [ ] AI 面板仅 Generate copy；双字段有值时确认弹窗；只填空字段；失败不写 filler
- [ ] API 直调带 length/language 仍正常（兼容回归）
- [ ] 选 Product（任何入口）不改 Website URL；Use product link 空填/有值确认；解绑不清 URL
- [ ] 全部入口文案 = Publish now（grep 无 "Pin now"）；单 Pin 确认弹窗；双击仅 1 次 API（client+server 锁回归）
- [ ] 任何入口发布失败：lifecycle=Failed、publishError+failureType+previousScheduledTime 持久化、刷新/换设备可见
- [ ] Banner 两页显示、仅计 publish、Retry/Move/Delete 后即时更新、0 时消失
- [ ] Failed 卡显示错误+推荐修复+原排程时间；transient 主按钮 Retry、content 主按钮 Edit；Move to Unscheduled 生效且字段/Product 关联保留
- [ ] Plan 抽屉 Schedule/Publish 走 pinReadiness；board 缺失字段级报错；描述超 500 被 UI 拦截（含 PinDetailsDrawer）

## 九、决策记录与实施计划（2026-07-11 用户确认）

**已确认决策：**
1. **自动到期发布进入本轮（MVP 必做）** → 推翻"零迁移"结论，v42 迁移成为必须；durable idempotency 从 P1 升 P0。
2. **AI Copy 收 UI 留 API**：删除界面控件，API 的 length/language 参数与服务端默认值保留。
3. **定时触发器：VPS cron** 每 5 分钟带密钥调用受保护接口（Vercel Hobby cron 一天仅一次，不可用）。

### 自动发布 MVP 架构（WP-A）

- **v42 迁移**：pin_drafts 提升 `scheduled_at timestamptz`、`publish_claimed_at timestamptz`（认领锁）列；在 promote.ts/buildPromotedColumns 写入时从 payload（plannedAt / scheduledDate+scheduledTime）计算，含 isMissingColumnError 降级；建 partial index（scheduled_at 非空）。
- **Cron 端点**：`/api/cron/publish-due`，Bearer CRON_SECRET 保护；查询 `scheduled_at <= now()` 且属 scheduled 生命周期的行；**逐行原子认领**（`UPDATE ... SET publish_claimed_at=now() WHERE publish_claimed_at IS NULL OR publish_claimed_at < now()-interval '10 min' RETURNING`）实现 DB 级防重；每次运行限批（≤20，受 maxDuration 300s 约束）。
- **发布核心复用**：把 /api/pinterest/pins 的发布逻辑抽成 `lib/server/pinterest/publishPin.ts`，路由与 cron 共用；token 刷新走现有 PinterestClient.forUser（needs_reconnect → errorCategory=auth）。
- **结果回写**：成功/失败均写回 payload（posted+remotePinId+remotePinUrl 或 publishError+failureType+previousScheduledTime+errorCategory）并 bump updatedAt，客户端经既有 LWW 同步取回。已知风险：离线客户端 outbox 可能整包覆盖（架构固有，MVP 接受并记录）。
- **VPS**：`*/5 * * * * curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://<prod>/api/cron/publish-due`。

### 工作包与阶段（按文件冲突域划分，同阶段内无共享文件）

- **Phase 1**：**WP-B**（Opus）数据模型字段 + Plan 抽屉/Batch 失败落库 bug + Publish now 统一命名 + 共享确认弹窗 + 服务端发布逻辑抽库 ‖ **WP-D**（Sonnet）AI Copy 收 UI + 填空/确认替换。
- **Phase 2**：**WP-A**（Opus）自动发布 MVP ‖ **WP-C**（Sonnet）默认筛选/空状态/Toast 跳转/Scheduled 卡 footer/Failed 卡信息与操作矩阵 ‖ **WP-E**（Sonnet）attachProduct 去自动填 + Use product link + pinReadiness 统一 + 800→500。
- **Phase 3**：**WP-F**（Sonnet）FailureBanner 组件与挂载 → 集成验证（typecheck/build/测试脚本）→ Fable 终审 → 浏览器 QA。

## 十、Browser QA Plan

环境：127.0.0.1 dev（注意 --noproxy gotcha），Pinterest sandbox 或 mock。

1. **创建→排程主链路**：Upload → 卡片出现（Unscheduled 默认视图）→ Generate copy（空字段）→ Schedule → 卡片消失 + Toast → 点 Open in Plan → Plan 中定位到该 Pin。
2. **Scheduled 编辑**：All 视图展开 scheduled 卡 → 确认 footer 无 Schedule → 改 title → 收起 → 重开确认时间未变 → 换浏览器（第二账号会话）确认同步。
3. **AI Copy 矩阵**：空/空、有/空、空/有、有/有 四种组合各点一次 Generate copy；有/有 时 Cancel 与 Replace 各验一次；断网点 Generate 验失败不清字段。
4. **Product/URL**：Plan 抽屉 attach product（URL 空）→ 确认 URL 未被自动填 → 点 Use product link → 填入；URL 有值时再换 product → 点 Use product link → 确认弹窗 Keep/Replace 两分支；Remove product → URL 保留。
5. **Publish now**：Plan 日历、Plan 抽屉 footer、Plan 列表、hover 预览、Studio ⋮ 菜单、Batch 六入口各验：确认弹窗出现、文案一致；确认后快速双击 → 网络面板仅 1 次 POST；第二浏览器同时发同一 Pin → 409。
6. **失败恢复**：mock 发布 500 → 卡片变 Failed + Banner 出现（两页都看）→ Failed 筛选卡片显示错误+原排程时间 → Retry（mock 成功）→ Posted + Banner 计数减 → 再造两个失败 → 一个 Move to Unscheduled、一个 Delete → Banner 归零消失；全程刷新页面 + 换设备验证持久。
7. **校验**：无 board Schedule → 字段级报错；非法 URL（ftp://、纯文本）Schedule/Publish 均被拦；描述输入 501 字被拦（三个编辑面）；断开 Pinterest 连接后 Publish → 清晰错误非静默失败。
8. **回归**：Batch Edit URL 四模式、Unschedule、Duplicate/Download、AI Image 抽屉（不受影响）、i18n 切换语言后新文案英文回退。
