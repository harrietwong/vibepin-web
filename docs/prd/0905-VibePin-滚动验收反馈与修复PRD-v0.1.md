# 0905 VibePin 滚动验收反馈与修复 PRD v0.1

状态：64 个页面入口静态审查完成；继续收集反馈，暂不进入实施
维护日期：2026-09-05
适用环境：VibePin Preview / 测试 Supabase
当前产品部署：`dpl_FiqJ7bkHQQkbaNLkcdyxwRxiTaaL`
当前 runtime：`f995a0249865c65ea448b88186724b9cc7141e84`
当前 manifest：`f585e17f3ddd2f331a79271095a9758f30d94761`
Production：禁止修改、迁移、付款或发布

## 1. 文档目的

本文件集中记录用户在 Preview 人工验收中连续提交的缺陷和体验反馈。它是滚动问题台账和实施入口，不替代各领域既有权威 PRD。

在用户明确说“开始实施”前，各领域只允许：

- 只读复现、根因定位和 affected files 盘点；
- 补充需求、状态机、错误契约和验收用例；
- 不改代码，不创建 checkout，不上传、生成、排期、发布或删除内容；
- 不修改 env、数据库、Storage、OAuth 配置、Vercel 部署或 Production。

## 2. 权威文档与去重规则

以下文档继续拥有各自领域的数据模型和业务规则，本文件仅记录新增要求和当前 Preview 回归证据：

- `0901-VibePin-Create-Pin生产阻断补充PRD-v1.0.md`
- `0901-VibePin-Product与Product-Picker补充PRD-v1.0.md`
- `0901-Reference创意智能补充PRD-v1.0.md`
- `0901-Multichannel发布目标与OAuth补充PRD.md`
- `0901-收款定价与Auth补充PRD-v1.0.md`
- `0905-VibePin-统一Preview验收结论-v2.0.md`

规则：

1. 已有 requirement 继续使用原 ID，不创建第二套事实源。
2. 用户截图是缺陷发现证据，不是根因或修复 PASS。
3. 当前部署的回归不能用旧部署的 PASS 覆盖。
4. 所有修复必须先证明数据归属和状态语义，再处理视觉症状。
5. Creem checkout session、OAuth code、token、owner id 和完整私有媒体 URL 不进入文档和日志。

## 3. 优先级

- P0：阻断登录、核心数据加载、生成、支付，或可能错发、重复计费、跨用户串数据。
- P1：明显影响理解、恢复、可访问性或主要工作流效率，但有安全替代路径。
- P2：视觉精修或低风险一致性问题。

## 4. 总体体验原则

1. 错误状态必须告诉用户“发生了什么、接下来能做什么”，不能只有 unknown error。
2. 相同业务动作只保留一个入口；不同动作必须使用不同名称。
3. 图片失败状态可以有设计感，但不能伪装成真实内容。
4. 主题、语言、账号、destination、商品、Reference 和 generation intent 必须复用各自唯一事实源。
5. 桌面与 390px 都要完成两轮验收；移动端点击热区不小于 44px。
6. UI 文案必须完整支持 en、zh-CN、zh-TW，不能中英混排。

## 5. 缺陷总表

| ID | 模块 | 级别 | 当前问题 | 目标状态 |
|---|---|---:|---|---|
| FB-0905-01 | Studio 草稿媒体 | P1/P0 条件升级 | 粉色大图与深灰 fallback 并存，来源不透明 | 追溯真实媒体 provenance；合法粉色图保留，legacy placeholder/junk 才 fallback |
| FB-0905-02 | Studio 失败媒体 | P1 | 深灰整块色块粗糙 | 使用中性深灰微渐变和精细图标层次，不回到红粉紫品牌渐变 |
| FB-0905-03 | Failed 卡动作 | P1 | 至少两个单卡各自重复渲染两个 `Edit` | 每卡只保留一个 canonical Edit，共用同一 handler 与可访问名称 |
| FB-0905-04 | Batch destinations | P0 | Batch “发布到”与单卡不一致、缺少选择 | 共用 canonical destination picker 和 capability |
| FB-0905-05 | Batch 发布时间 | P1 | 时间字段常驻，像必填 | 默认折叠并标注可选，由按钮展开 |
| FB-0905-06 | Create Pin 入口 | P1 | AI、上传、URL、商品/灵感入口割裂 | 一个统一“添加内容/创建 Pin”入口，快捷入口只 deep-link |
| FB-0905-07 | 全局坏图 | P1 | broken image、alt/文件名挤入图片区 | 所有 Product/Reference/Pin 媒体使用统一状态机和 fallback |
| FB-0905-08 | Product Picker 标签 | P1 | `Uploaded`、`Product Ideas` 与图标无意义 | 展示用户可理解且可追溯的来源 taxonomy |
| FB-0905-09 | Product Inspiration | P0 | 选品灵感无法加载 | canonical API；区分 loading、空态、鉴权、服务错误和重试 |
| FB-0905-10 | AI 生成 | P0 | “生成 2 个 Pin”失败 | job/group/slot/usage 可对账，错误可行动，重试不重复副作用 |
| FB-0905-11 | 风格参考图 | P0 | 关闭/重开或失败后未恢复选择 | Generate 前原子保存完整 setup，并按 owner/workspace 隔离 |
| FB-0905-12 | 上传后推荐 | P0 | 上传商品图后分析/推荐无法完成 | upload→analysis→recommendation 状态可恢复，换图隔离旧响应 |
| FB-0905-13 | 推荐方向 | P1 | 只有文字，和图片依据关系弱 | 方向卡显示可追溯缩略图、来源和 Why it fits |
| FB-0905-14 | Creative direction | P1 | 看不出是输入框 | 明确 textarea/edit 状态、边框、焦点、保存/取消 |
| FB-0905-15 | Generation toast | P0 | 同时出现“正在生成”成功色和“未生成”错误 | 单 attempt 单稳定 toast id，pending 原位更新到唯一终态 |
| FB-0905-16 | Google OAuth / 测试登录 | P0 | Google 授权报 error code；IAB 不记住 Google 凭据 | 修 Preview OAuth 配置；测试登录路径可用；浏览器凭据问题单独解释 |
| FB-0905-17 | Creem Test checkout | P0 | Checkout 显示 `Payment Error / An unknown error occurred` | Test 产品/价格/session/return URL 正确，错误可诊断、可返回 |
| FB-0905-18 | Studio 失败提醒 | P1 回归 | 历史大 Banner、重复 notice、count 口径错误 | 只保留 Failed badge + quiet notice，按 Pin 计数 |
| FB-0905-19 | Studio 密度/CTA | P1 | 历史卡片过大、间距散、主次动作反复变化 | token 化；按用户最新裁决由 Schedule 使用唯一主色、Publish 为次级；桌面多列、390 单列 |
| FB-0905-20 | Plan | P1 | 历史入口难发现、固定后挤布局 | 单一 Plan 控制；hover/focus preview；不足两列自动 overlay |
| FB-0905-21 | Contact 成功态 | P2 | `Message sent` 只在大空卡中显示两行文字，不够精细 | 紧凑、明确、品牌一致的成功反馈及下一步 |
| FB-0905-22 | Landing 导航 | P1 | 未登录 Landing/Pricing 无主题和语言控制 | 右上角复用工作台主题/语言 preference 与组件语义 |
| FB-0905-23 | 登录回跳 / Google | P0 | 邮箱密码登录后回到 Landing/Pricing 登录入口；Google 链接失败 | 登录成功只跳 sanitized `next`；Google Preview OAuth 可完成或返回可诊断安全错误 |
| FB-0905-24 | 四套餐 Credit E2E | P0 验收 | 缺少 Free/Starter/Pro/Business 独立账号的额度显示、near-limit、耗尽与错误截图证据 | 四个 owner-isolated 合成测试账号各跑两轮；不靠真实 AI 大量消耗；形成脱敏截图报告 |
| FB-0905-25 | Failed / Published 状态 | P0 | `Publish failures` 列表中的同一卡同时显示 `Posted` 和失败原因 | canonical lifecycle reducer 决定唯一主状态；部分成功/未知不得伪装成完全 Posted |
| FB-0905-26 | Failed Retry / destination | P0 | Retry 后弹窗只有 `No saved publishing destination` 红字与禁用按钮，没有可完成的修复入口 | 在原上下文中直接进入 destination 修复，保存后重新确认；0 destination 必须 fail closed |
| FB-0905-27 | 工作台页面标题 | P1 | Product 页面巨型标题占用过多首屏；用户要求所有工作台页面避免营销 Hero 尺寸 | authenticated app 共用紧凑 page-header token；Landing 营销 Hero 不受影响 |
| FB-0905-28 | Product Opportunities 数据 | P0 | Digital 筛选下只显示 `No products match these filters`，无法判断真空集还是加载/数据异常 | 区分 filtered empty、catalog empty、sync/auth/API error；不使用假数据掩盖问题 |
| FB-0905-29 | Product 类型筛选 | P1 | `All products / Physical / Digital` 单独悬在标题与筛选条之间，位置和层级突兀 | 并入统一筛选工具条，成为清晰的 Product type 字段并适配 390px |
| FB-0905-30 | Pin Ideas 商品相关推荐 | P0 | Choose Pin References 每次换商品仍出现同一批长期未更新图片，且推荐在外层重复出现 | Pin Ideas 按当前商品指纹动态推荐、显示新鲜度并隔离旧响应；推荐集中在 picker 内 |
| FB-0905-31 | 无 Reference 的 AI 生成 | P0 | 只有产品图、未手选 Reference 时生成 2 张，两个 slot 均立即 `Generation failed` | Reference 保持可选；自动匹配商品参考，匹配不到则退到 product-image + direction/prompt-only；失败可诊断且不重复计费 |
| FB-0905-32 | Studio 滚动 / Publishing accounts | P0 | 展开卡片内 `Publishing accounts` 后页面无法继续下拉，未填字段和底部操作不可达 | 明确唯一滚动容器；展开内容不得被固定高度/overflow 或残留 scroll lock 截断；桌面与 390px 全字段可达 |
| FB-0905-33 | 发布确认错误与必填字段 | P0 | 0 destination 弹窗用大段红字吓人且不可行动；必填 Board 仍藏在 Details | 轻量就地错误；缺什么就在对应字段补；Board/destination 等发布必填项全部置于主编辑区 |
| FB-0905-34 | Schedule / Publish 一致性与主次 | P0 | Publish failed 的内容仍可 Schedule 到内部 demo Board；Publish 被高亮但用户主任务是排期 | Schedule/Publish 共用同一 preflight 与 destination 真相；Schedule 为主 CTA，Publish 为次级 |
| FB-0905-35 | Batch Edit 输入态 | P1 | 可编辑单元格像普通文字，整行大面积浅紫，用户看不出可输入 | 输入控件有清晰边界、label/focus/hover；批量状态不用整行紫色表达 |
| FB-0905-36 | Posted destination / Board 真相 | P0 | Posted 行仍缺 destination/Board，无法确认发布到哪里或是否只成功一部分 | Posted 只由 immutable provider receipt 决定，并展示精确账号、Board/Page、remote id/permalink；缺失即非完整 Posted |
| FB-0905-37 | Batch mixed accounts | P0/P1 | 每行重复超长 mixed-account 文案，Board 无法设置，`Publish to` 也不能选择账号 | 工具条只显示一次 compact Mixed 状态；先选账号再选其 Board；支持逐行修复或显式批量覆盖 |
| FB-0905-38 | 全局 UI 去 AI 味与交互流畅度 | P1 横切 | 巨型标题、渐变主按钮、紫色大色块、胶囊堆叠、卡片套卡片、长解释和迟钝跳变让界面模板化 | 建立克制、内容优先的 VibePin 工作台设计系统和可测的交互响应/连续性标准 |

## 6. Create Pin / Studio 详细要求

### FB-0905-01 草稿粉色媒体来源追溯

已知直接证据：

- 粉色卡对应标题 `VibePin QA T0 2026-08-29T08:24:11Z`；
- 卡内媒体可访问名称为 `qa-slide-1`；
- 页面把它渲染为成功加载的 `<img>`，而不是当前深灰 fallback；
- 相邻卡已走 `Image preview unavailable` 深灰 fallback。

当前不能仅凭颜色断言该图是坏图。实现前必须只读核对：

- `draft.imageUrl`、`sourceImageUrl`、media cover、setup snapshot 的来源类型；
- 安全文件名/路径摘要、MIME、像素尺寸、字节数和内容哈希；
- 创建时间、创建入口、QA seed/placeholder identity；
- owner/workspace 归属，不输出 owner id、token 或完整私有 URL。

裁决：

- 合法真实粉色上传图或生成图必须正常展示；
- 已知 legacy QA placeholder、坏 URL、decode error、1×1/2×2 junk、unsupported 或超时才进入 fallback；
- 禁止按主色、平均色或“看起来像粉色”过滤；
- 如果发现跨 owner、错绑 Storage path 或 source/media 不一致，本项立即升为 P0。

验收：

- 合法粉色照片 fixture 仍显示；
- legacy pink placeholder fixture 显示 fallback；
- missing、decode、tiny、unsupported、timeout 显示 fallback；
- A→B→A 不串图；
- source chain 变化后 renderer 正确 reset，不保留旧 cursor。

### FB-0905-02 失败兜底视觉重做

视觉方向：安静的“暗房预览板”，不是整块色卡，也不是品牌宣传面。

建议 token：

- base `#20242B`；
- depth `#181C22`；
- soft highlight `rgba(255,255,255,.045)`；
- border `rgba(255,255,255,.08)`；
- icon `#8B93A1`；
- text `#AAB1BC`。

允许使用角度很小、明度差很低的深灰渐变、轻微径向高光或细微纹理；禁止红、粉、紫和彩色渐变。只保留一个视觉 signature：中央“裁切框/底片框”式图标容器，明确这是预览不可用，而不是一张真实图片。

`Generation failed` 与 `Image unavailable` 共用骨架，通过图标或状态文案区分。busy 只使用细微 opacity/shimmer，并遵守 `prefers-reduced-motion`。

验收：

- 1440、1280、390 截图两轮；
- 不再出现无层次的整块色墙；
- 不出现品牌粉紫、broken icon、raw alt、永久 spinner；
- 正文对比度不低于 4.5:1，非文本状态至少 3:1；
- aria-label 能区分 generation failed 与 unavailable。

### FB-0905-03 Failed 卡 Edit 归属

当前部署的完整可访问树已确认：至少两个失败卡在同一个卡片动作组中连续出现两个 `Edit`，不是相邻卡各一个造成的视觉错觉。实施时仍需在组件树定位两个渲染分支，但产品裁决已确定：

- 同一卡只保留一个 canonical Edit handler，删除重复条件分支；
- accessible name 使用 `Edit {Pin title}`，保证跨卡归属明确；
- `Retry`、`Choose another board` 和 `Edit` 是不同修复动作，不得为了减少按钮而合并其业务含义。

验收：每张失败卡可见 Edit=1、可访问 Edit=1；焦点和打开的 draft id 一致；取消后零写；10 张失败卡无重复 key 或跨卡误编辑。

### FB-0905-04 至 FB-0905-15

这些问题继续由 Create Pin、Product、Reference、Multichannel 既有 PRD 的 canonical requirement 管理。本轮把截图作为当前部署的回归/未闭环证据，禁止复制新的 destination、product、recommendation、generation 或 toast 状态模型。

最低共同验收：

- 三语言、键盘、焦点恢复、390px 无横向溢出；
- 打开/关闭/切换入口不创建上传、job、placeholder、usage、schedule 或 publish；
- 所有失败保留安全 `method/path/status/code/requestId/time`，不显示原始 provider body；
- 重试复用稳定 intent 或明确创建 child intent，不能盲目重放；
- UI state、HTTP、测试 DB、Storage/usage 证据可按同一 stable id 对账。

### FB-0905-25 Published 与失败状态互相矛盾

当前直接证据：`Failed > Publish failures` 中同一卡图片主徽标显示 `Posted`，但卡片下方仍显示发布失败/需处理信息。该状态会让用户误判是否已经成功发布，按 P0 处理。

要求：

- 所有卡片、Failed 子筛选、Plan、History 和详情共用一个 canonical lifecycle/result reducer；
- 主状态优先级至少为 `delivery_unknown > failed/partial > published`；只有本次确认的全部 destination 都有可信 published receipt 时才显示 `Posted`；
- 部分成功必须显示 `Partially published / Needs attention`，并按 destination 展示成功、失败、未知，不得把任一成功腿投影成整卡 Posted；
- 历史成功 receipt 不得覆盖后续 retry 的失败/未知；retry 也不得清除已成功 destination 的 remote id/permalink；
- `Publish failures` 只能包含当前仍需处理的卡；修复完成后由 canonical 状态自动移出，不能仅靠客户端 badge 覆盖。

验收：全成功、全失败、部分成功、超时未知、失败后重试成功、历史 Posted 后新 attempt 失败各两轮；卡片/筛选/count/Plan/详情一致；无重复 provider dispatch、usage 或 receipt 丢失。

### FB-0905-26 Retry 后没有 destination 的修复死路

当前直接证据：失败卡点击 Retry 后打开 `Confirm publishing destinations`，显示 `No saved publishing destination`、两行红色说明和禁用的 `Publish now to 0 destination(s)`；弹窗内没有明显的 destination 选择或编辑操作，因此用户无法完成发布或编辑。

要求：

- 0 个可发布 destination 时继续 fail closed，不得恢复任何默认 Pinterest/account/Board/Page；
- 把散落红字替换为结构化 action-required 区域，明确原因并提供主操作 `Choose publishing destinations` 或 `Edit destinations`；
- 主操作必须携带当前 draft/content/attempt 上下文进入 canonical destination picker；保存后回到同一确认弹窗并显示精确 provider、account、Board/Page；
- stale、deleted、disconnected、owner-mismatch 和 capability-disabled 分别给出安全原因和对应修复入口；
- `Retry` 不能直接 dispatch；destination 修复后必须再次由用户确认；Cancel、Escape、X、backdrop 全部零副作用；
- 卡片保留一个 canonical `Edit`，不得因 destination 修复再生成第二个同名按钮。

验收：无保存目标、已删除 Board、断开的 connection、部分 destination 可用、修复后重新确认、取消修复、篡改/stale receipt 各两轮；0 destination 始终 0 provider call/0 usage；保存后的目标与最终 receipt 一致。

## 6.1 Reference / Pin Ideas 详细要求

### FB-0905-30 Choose Pin References 内的商品相关推荐与刷新

当前直接证据：picker 的 `Pin Ideas` 长期显示看似固定的一批图片；用户切换商品后仍观察到相同内容。截图不能单独证明后端从未刷新，因此实施前必须只读核对请求、缓存命中和返回 provenance。

只读代码审计已确认当前实现缺口：

- picker 调用的 `usePinIdeas()` 没有商品参数，SWR key 固定为 `pin_ideas_reference`，30 秒去重窗口且不在 focus 时刷新；
- 第一请求是 `GET /api/reference-candidates?limit=120`，不携带 product/category/image/style；失败后退到全局 viral-pins / pin-samples；
- picker 只在客户端按 search/category/format 过滤，因此切换商品不会改变请求键或候选事实源；
- 已存在的 product-aware `POST /api/reference-candidates` 只由外层 AI drawer 推荐区使用，没有接入 picker，形成外层商品推荐与 picker 全局 Pin Ideas 两套展示；
- 结论：当前 picker 不会因为换商品而可靠刷新为该商品专属推荐；固定请求键和服务端/SWR 缓存会使同一批内容反复出现。

产品裁决：

- 商品相关 Pin 推荐集中在 `Choose Pin References > Pin Ideas` 内；外层抽屉/页面不再重复一套 recommendation list，只保留打开 picker 的入口、已选摘要和必要状态；
- 有选中商品时，recommendation fingerprint 至少绑定 owner/workspace、规范化 product ids、商品图片/类别版本和必要的 locale；换商品必须产生新 fingerprint；
- 无商品时明确显示通用灵感模式，不得把通用结果伪装成“为该商品推荐”；
- 首次打开、商品变化、手动刷新、缓存到期分别定义触发规则；允许 stale-while-revalidate，但必须显示 `Refreshing` 和安全的 `Last updated`，新请求失败时标明当前内容为旧缓存；
- 响应必须携带 request/fingerprint/version/fetchedAt 或等价证据；旧商品的迟到响应不能覆盖新商品；
- 推荐需去重，并应用已选、已隐藏、最近使用的 `excludeIds`；同一商品可稳定复用短期缓存，但不能永久固定为同一批；
- 手动刷新不应重复已选项，不创建 generation/job/usage，也不改变已保存 reference；
- 空态区分“暂无匹配推荐”“正在刷新”“登录/权限问题”“服务错误”，均提供正确下一步。

验收：商品 A→B→A、同商品缓存命中、TTL 到期、手动刷新、旧响应晚到、离线旧缓存、空集、401/403/429/5xx、28 条固定 fixture 去重各两轮；核对 UI、HTTP fingerprint、cache provenance 与 selection/linkback；390px 无重复外层推荐或横向溢出。

预期 affected files：`usePinIdeas.ts`、`pinIdeas.ts`、`InlineCreateAssetPicker.tsx`、`api/reference-candidates/route.ts`、`AiVersionDrawer.tsx`、`recommendationRequest.ts`、`referenceServe.ts` 和相关 analytics/tests；`viral-pins` 仅保留有时限、可识别的兼容 fallback，不再充当商品推荐主源。

### FB-0905-31 只有产品图、未选择 Reference 时生成失败

当前直接证据：用户仅选择产品图、未手动选择 Reference，点击生成 2 个 Pin 后新增两个失败 slot；两张保留了同一产品图预览并显示 `AI generated / Generation failed`。截图能证明本次 attempt 整组失败，但不能单独确定是 no-reference preflight、provider payload、图片读取、模型错误、额度或异步聚合问题。

只读源码审计已排除“Reference 在前端是隐式必填”这一假设：当前 selection planner 会在零 Reference 时建立一个 `reference=null` group，payload 明确发送 `style_ref:null`、`referenceImageCountRequested:0`、商品图和仅 product 的 `image_inputs`，Generate gate 也不要求 Reference。当前推荐图只有用户主动点击选择后才进入 generation input，不会自动注入。因此这次两 slot 全失败更可能发生在商品图读取、provider/worker、usage/limit 或服务端任务阶段；必须取得同一 attempt 的脱敏 terminal code/status/requestId 后才能定根因。

当前客户端还有一个确定的可观测性缺口：group 的普通异常进入 catch 后只把全部 placeholder 标为失败并累计 `failCount`，没有把原始安全 error code/stage/requestId 绑定到 draft；最终 UI 统一显示 `No AI Pins were generated / Generation failed`。因此用户现在看到的页面本身无法回答“为什么失败”，这也是本项必须修复的组成部分。

产品裁决：Reference 是增强创意方向的可选输入，不能成为生成的隐式必填项。生成前必须明确选择以下一种模式并在 UI 中可见：

1. `Selected references`：使用用户明确选择的 Reference；
2. `Auto-matched references`：用户未选择时，系统按当前商品 fingerprint 获取新鲜、可追溯的候选，并自动选择合格参考；
3. `Product + direction only`：没有合格推荐或推荐服务失败时，仅使用商品图、商品信息和 Creative direction/prompt 生成。

要求：

- 用户未手选 Reference 时不得直接校验失败；自动匹配也不得写入“我的 Reference”或伪装成用户选择；
- 自动匹配必须展示来源、匹配依据和更新时间，并允许用户查看、替换或关闭；
- 自动匹配为空、429、5xx 或超时应降级到 `Product + direction only`，除非模型明确不支持该输入组合；若模型不支持，生成按钮前置禁用并解释，不得先创建两个必败 placeholder；
- prompt builder 必须在 reference 数组为空时生成合法 payload，不输出 `undefined/null` 伪 URL，不把空数组序列化成 provider 的必填 image part；
- product image 必须完成可读性、MIME、尺寸、权限和 owner 校验；失败时在创建 job/usage 前给出具体可行动错误；
- 一次 2-slot attempt 共用稳定 intent/group id，但每个 slot 独立记录 provider outcome；一个失败不能覆盖另一个成功；
- 全失败、部分成功和结果未知使用唯一稳定 toast/state，显示安全 `stage/code/requestId/time/model`，不只显示 `Generation failed`；
- 确定失败需释放 reservation/placeholder 并只结算实际完成 usage；unknown 保留可恢复状态，不允许盲目再次扣费；
- Retry 复用或派生可追溯 intent，默认保留本次 product/direction/mode；用户可在重试前进入 Reference picker 修正。

验收：selected reference、auto-match 命中、auto-match 空集、recommendation 429/5xx/timeout、product+direction only、无效商品图、provider 单 slot 失败、两 slot 全失败、double-loss unknown、刷新后恢复和双击 Generate 各两轮；核对 UI/HTTP/job/slot/placeholder/reservation/usage 同一 intent，确保 2 个 Pin 不会因“未手选 Reference”整组失败或重复计费。

### FB-0905-32 Publishing accounts 展开后页面无法滚动

当前直接证据：在 `Studio?filter=unscheduled` 的多列 Draft 卡片中展开 `Publishing accounts` 后，面板内容延伸到当前 1007×632 视口底部以下，但页面不能继续向下滚动，导致未填写项和后续操作不可见、不可达。

要求：

- Studio shell 必须定义一个且只有一个主纵向滚动容器；普通 inline card 展开不能给 `html/body/main` 留下 `overflow:hidden` 或不可恢复的 scroll lock；
- 如果 Publishing accounts 是 inline section，卡片和 grid row 必须随内容增高，页面 scrollHeight 同步增长；禁止固定高度、错误 `max-height` 或祖先 overflow 裁掉内容；
- 如果它是 popover/listbox，则使用受控 overlay/portal，最大高度按可用视口计算，面板自身可滚动且不截断底部动作；
- modal/drawer 关闭、Escape、路由切换和异常卸载必须成对释放 body lock；多个 overlay 需要引用计数或统一 owner，不能互相提前/延迟解锁；
- 展开后把标题或首个可操作项滚入可见区域，并考虑 sticky header；不得突然把用户滚回页面顶部；
- 所有 destination、错误、未填字段、保存/取消和 Schedule/Publish 在鼠标、触控与键盘下都可到达；焦点不能被不可见内容捕获；
- 关闭并重新打开、切换筛选和 Back/Forward 后滚动能力保持正常，不复制第二套 destination selector。

验收：1007×632、1440×900、390×844，1/3/10 个 accounts、长名称/错误文案、连续展开两张卡、打开/关闭 drawer 后再展开、Escape/X/backdrop、键盘 Tab/Shift+Tab 各两轮；记录主容器 clientHeight/scrollHeight/overflowY、底部操作可见性和 0 横向溢出。

### FB-0905-33 发布确认错误轻量化、必填字段前置

当前直接证据：`Confirm publishing destinations` 在 0 destination 时连续显示三行红色说明，主按钮仍占据强视觉位置但不可用；同时发布必填的 Board 被隐藏在 Details/深层编辑中。

要求：

- 弹窗只保留一句紧邻 destination 区域的轻量说明，例如 `Choose a destination to continue.`，使用低饱和 warning/neutral，不使用大片红色或重复解释；
- 提供一个明确主操作 `Choose destinations`，点击后就地打开 canonical destination/account/Board 选择，不要求用户猜测返回哪个页面；
- Title、media、destination、provider account、Pinterest Board/Facebook Page 等发布/排期必填项必须位于主编辑区；`More details` 只能容纳 alt text、可选 product、内部审计等可选项；
- 哪个字段缺失就在哪个字段下显示短错误并聚焦/滚入可见范围，顶部只允许一条 compact summary；
- disabled CTA 文案不显示 `0 destination(s)` 这类系统计数，应显示用户动作，例如 `Choose a destination`；
- 修复字段后错误原位消失，不需要关闭弹窗重来；Cancel/Escape/X/backdrop 零写。

验收：缺 destination、缺 Pinterest Board、缺 Facebook Page、断开的账号、多个字段同时缺失、修复后提交、取消修复各两轮；桌面/390 只出现一个 summary，每个缺失字段一个短提示，键盘可直接抵达。

### FB-0905-34 Schedule/Publish 共用前置校验，Schedule 为主 CTA

当前直接证据：用户观察到发布失败的内容仍提示 `Scheduled to VibePin Sandbox Demo Board`；页面同时把 Publish 做成粉紫高亮，而用户的主要工作流是先排期。

要求：

- Schedule 与 Publish now 必须共用 canonical destination/account/Board/Page capability preflight，不允许一个失败、另一个通过的隐式 fallback；
- `VibePin Sandbox Demo Board`、QA Board 等内部 fixture 永远不能成为客户可见或自动选择的目标；发现 legacy internal Board 时标记 `Needs attention` 并要求重选；
- Schedule 成功后整卡主状态为 `Scheduled`，旧 publish failure 只保留在 History/attempt details，不能继续作为当前主徽标；
- 如果已有 destination 的部分成功或 unknown receipt，Schedule 必须保护已发布腿并明确本次仅作用于哪些未发布目标；
- Studio 卡片、Batch Edit 和确认弹窗统一 CTA 层级：`Schedule` 使用唯一品牌主色；`Publish now` 使用中性次级按钮；破坏性操作保持独立；
- 默认焦点和 Enter 不得意外触发 Publish now；任何实际 Schedule/Publish 仍需显示精确目标与时间的确认。

验收：同一 draft 的 Schedule/Publish preflight 对照、无 Board、internal demo Board、断开账号、部分成功、unknown、排期成功后的状态迁移、CTA 视觉和键盘 Enter 各两轮；无默认 destination、无重复 dispatch/usage。

### FB-0905-35 至 FB-0905-37 Batch Edit 输入、Posted 真相和 mixed accounts

Batch Edit 是高密度编辑器，不是数据展示表。要求：

- 可编辑的 Title、Description、URL、Alt text、Product、Publish to、Board 和 Publish time 使用明确输入边界、label/placeholder、hover 和 focus ring；只读 receipt 使用不同视觉语义；
- 删除整行浅紫背景，选中状态只在行首 selection marker/细边框表达；品牌紫只用于主 CTA、焦点或少量状态；
- Posted 内容的 provider/account/Board/Page 来自 immutable publish receipt；如果预期两个 destination 但只有一个成功，主状态为 `Partially published/Needs attention`，不能显示完整 Posted；
- Posted 行默认只读展示已发布目标和 permalink；“未来再发布/排期到新目标”必须创建明确的新 intent，不能覆盖历史 receipt；
- mixed-account 批选时，Board 单元格显示短状态 `Mixed accounts`，完整原因只在工具条/侧栏出现一次；不得在每行重复长段落；
- `Publish to` 必须能打开 canonical account selector。用户先选择 provider account，再只显示属于该账号的 Board/Page；账号变化必须清空不兼容 Board；
- 用户可选择只编辑同一账号的行、逐行修复，或明确将全部未发布行覆盖到一个新账号；已发布/unknown 腿不可被批量覆盖；
- 横向表格需有冻结的 Content/selection 列、可见滚动提示和正确焦点保持，390px 改为 stacked editor，不压缩成不可读表格。

验收：同账号批量、两个 Pinterest 账号、Pinterest+Facebook、mixed Board、Posted 单腿/双腿/部分成功/unknown、账号切换清 Board、逐行编辑、显式批量覆盖、取消和 390px 各两轮；不得出现重复长错误、空账号选择器或 receipt 被改写。

## 6.3 FB-0905-38 VibePin 全局 UI 与交互体验基线

### 设计方向

VibePin 工作台的核心是“快速判断内容、修正字段、安排发布”，不是展示 AI 能生成多少装饰。视觉基线采用安静的 editorial operations canvas：内容图片和状态是主角，界面退后。

必须减少的 AI 模板特征：

- 巨型标题、全屏 Hero 式 app header；
- 粉紫渐变覆盖所有主按钮、整行/整卡大色块；
- 过量圆角胶囊、卡片套卡片、每段都有 icon+标题+说明；
- generic glow、无业务意义的渐变、悬浮装饰和无差别动效；
- 一次解释三遍的长文案、系统术语和没有下一步的错误；
- 所有按钮同等高亮、输入框伪装成文本、状态仅靠颜色。

统一设计系统：

- 颜色以中性 surface、清晰文本层级和细分隔线为主；品牌紫只用于当前选择、键盘 focus 和每个 surface 唯一的主操作；
- Schedule 是 Studio 的主要任务色，Publish now 为次级；warning/error 只占必要范围，不铺满整卡；
- authenticated app 标题使用紧凑 type scale；正文、caption、数据和状态使用固定层级，不靠随意加粗；
- 输入框、选择器、只读值、链接和按钮必须一眼可区分；同一动作在所有 surface 使用同一名称；
- 组件优先使用真实内容结构、分隔线和留白，避免为了“高级感”增加无意义容器；
- 每个页面最多一个视觉 signature；Studio 的 signature 是内容媒体与排期状态，不再额外堆叠渐变装饰。

### 丝滑交互标准

- 点击后 100ms 内必须有 pressed/loading/optimistic-safe 反馈；超过 300ms 显示局部进度，不能整页僵住；
- hover/pressed 使用 100–150ms，popover/menu 使用 200–300ms，modal/drawer 使用 300–500ms 且关闭可更快；只动画 opacity/transform，避免 height/layout 抖动；遵守 `prefers-reduced-motion`；
- 筛选、展开、切 tab、返回后保留滚动位置、输入草稿、selection 和焦点；异步旧响应不得覆盖新状态；
- skeleton 与真实布局尺寸一致，图片加载失败不引发 card 跳高；按钮 pending 时保持宽度；
- 安全的本地编辑可 optimistic update；发布、排期、扣额度等外部副作用必须等待可信 receipt；
- 错误优先就地显示并提供一个下一步；toast 只承担跨页面或后台完成，不与 field error 重复；
- hover 是补充，不承载唯一功能；键盘、触控和 390px 拥有等价路径；
- 连续操作应支持撤销/返回，不重复打开相同 drawer、不丢上下文、不出现多个 competing spinner/toast。

全局验收：建立 desktop 1440/1280/1007 与 mobile 390 的 golden screenshots；关键任务 `选择内容→补字段→选目标→排期` 两轮计时；记录 input latency、layout shift、scroll/focus restore、重复 toast、网络慢速/错误状态。高级模型以“是否像真实内容运营工具，而非通用 AI dashboard”为独立设计审查门禁。

设计审查能力：

- 当前已使用本机 `frontend-design` skill，把“去 AI 味”落实为克制的 token、单一视觉 signature、真实内容结构和明确文案；
- 当前已使用 `web-design-guidelines` 并依据 [Vercel Web Interface Guidelines](https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md) 完成 64 个页面入口的 UX/a11y/响应式静态审查；
- 当前已使用 `interaction-design` 检查任务流、状态连续性和微交互；它提供审查标准和状态契约，但不能替代真实用户两轮验收；
- 新 skill 在安装前先审计来源和指令；执行模型可按 checklist 修改，高级模型必须独立看截图、状态机和最终 diff。

## 6.2 Product Opportunities 详细要求

### FB-0905-27 工作台标题统一收紧

`Product Opportunities` 当前使用接近营销 Hero 的字号，占据过多首屏。该规则适用于登录后的 app 页面，不改变 Landing 的品牌 Hero：

- 建立共享 app page-header token，桌面标题建议不超过 32px，390px 不超过 24px；
- eyebrow、标题、说明和主操作保持紧凑节奏，首屏优先露出业务数据与工具；
- Studio、Products、Analytics、Settings 等登录后页面逐页盘点，禁止各自复制巨大标题；
- 标题仍为唯一页面 `h1`，缩小视觉尺寸不能破坏语义或可访问性。

验收：所有 authenticated 一级页面在 1440、1280、390 两轮截图；标题层级一致、无截断/重叠，首屏可看到主要工具或首行数据；Landing Hero 不被误改。

### FB-0905-28 Product 数据空态必须诚实

当前 `Digital` 筛选下显示 `No products match these filters`。该文案只允许用于“canonical API 成功返回且基础 catalog 非空，但当前筛选结果为 0”的场景。

只读源码审计发现：当前页面没有完整消费 SWR/error 状态，兼容 API 失败后还可能静默进入 Supabase fallback，最终把加载/服务错误投影成空数组；因此尚无 HTTP 证据前，不能把截图直接判定为“Digital 确实没有商品”。Product 权威 PRD 已新增 `catalog_empty / type_empty / filtered_empty / load_error` 四态要求，实施时以该事实源为准。

要求：

- `filtered_empty`：显示当前条件摘要、`Clear filters` 和切换到 `All products`；
- `catalog_empty`：说明目前还没有可用 Product Opportunities，并显示数据新鲜度/同步状态和下一步；
- `loading/refreshing`：使用稳定 skeleton 或进度文案，不提前显示空态；
- `unauthenticated/forbidden`：走登录或权限恢复，不显示空数据；
- `API/sync/error`：显示安全 `code/requestId/time/runtime/deployment` 和 Retry，不拿空数组吞掉错误；
- stale cache 可继续展示，但必须明确陈旧并后台刷新；禁止注入演示/假数据冒充恢复；
- 计数、筛选可用项和 Saved Products 必须来自同一 canonical response/version。

验收：基础 catalog 有数据但 Digital=0、全 catalog=0、loading、stale、401、403、429、5xx、timeout、Retry 成功各两轮；核对 HTTP 与 UI 状态一致，不出现 200 error→empty 的错误折叠。

### FB-0905-29 Product type 筛选位置

`All products / Physical / Digital` 不再作为标题下方独立漂浮的 segmented control。它是筛选条件，应进入与搜索、Category、Platform、Sort 同一个 filter surface：

- 桌面放在工具条首部并标注 `Product type`，与 Apply/Clear 的作用域一致；
- 选择立即生效或由 Apply 生效只能保留一种模型；若保留 Apply，所有控件在提交前显示 pending state；
- 390px 使用可折叠 Filter sheet/stack，不允许横向挤压、孤立悬浮或把主要结果推到首屏之外；
- URL query、刷新、Back/Forward 和 Clear filters 必须恢复同一类型状态；
- 键盘使用 Tab/Arrow/Space，选中态同时具备文字、`aria-pressed`/radiogroup 语义，不能只靠紫色。

验收：All/Physical/Digital 与 Category/Platform/Search/Sort 组合、Apply/Clear、URL restore、Back/Forward、390px、键盘各两轮；工具条和结果区无 layout shift。

## 7. Auth / OAuth 详细要求

### FB-0905-16 Google OAuth 与测试登录

必须拆开两个问题：

- 产品问题：Preview Google OAuth client、Supabase provider、Site URL、redirect allowlist、PKCE callback 或 test-user 配置错误；
- 浏览器问题：Codex IAB 与用户常用 Chrome 可能不是同一 profile，Google 账号选择和密码管理器状态不会自动共享。

要求：

- Preview 与 Production 使用不同 OAuth client/redirect 配置；
- callback `next` 只允许站内安全路径；
- provider error 映射为可行动的 VibePin 页面和安全 correlation code；
- 提供测试 email/password 或 Magic Link 登录路径，但密码、OTP、magic token 不写文档、不回显；
- 用户亲自完成第三方登录、密码、OTP 和最终 consent。

### FB-0905-23 登录回跳与 next 契约

新增直接证据：`/login?next=/pricing` 的邮箱密码表单完成后，用户观察到又回到 Landing/Pricing 的未登录路径；同页 Google 登录链接失败。

要求：

- 邮箱密码、Magic Link、Google callback 共用一个 `sanitizeNext()`；
- 只接受站内绝对路径，拒绝 scheme、host、`//`、反斜杠和编码绕过；
- session 建立后才执行 replace navigation，并在目标页完成一次服务端/客户端一致的 session readback；
- 已登录用户访问 `/login?next=...` 时直接去安全目标，不重复显示登录表单；
- `/pricing` 的登录态与 CTA 状态不得因 hydration 暂时回退；
- Google 失败区分 provider config、state/PKCE、callback allowlist、test-user 和 session persistence，但客户只看到安全错误码与重试/邮箱登录入口。

验收：邮箱密码与 Google 各两轮；`next=/pricing`、`next=/app/studio`、缺失 next、恶意 external next；刷新目标页 session 仍有效；浏览器 back 不重复 callback；console 无 auth loop，网络中无 token/code 泄露。

## 8. Pricing / Creem Test 详细要求

### FB-0905-17 Creem Test Payment Error

事件：用户从当前 Preview Pricing 进入 Creem Test checkout，第三方页面显示 `Payment Error` 和 `An unknown error occurred`。这证明 checkout 当前不可用，但不能仅凭页面猜测是付款失败、产品失效、session 过期还是 return URL/config 错误。

只读诊断顺序：

1. VibePin plan/period/add-on 到 Creem Test product/price 的映射；
2. session 创建 HTTP status、安全 error code 和 request/correlation id；
3. session 的 test/live mode、active product/price、currency、billing interval；
4. success/cancel return URL 与当前 Preview deployment/allowlist；
5. Creem Test dashboard 中同一 correlation 的状态；
6. 测试 DB 中 billing/subscription 是否保持诚实状态。

要求：

- Starter/Pro/Business 的月付/年付和 extra account 月付/年付共 8 个映射必须全部指向 Test active resource；
- 到达 checkout 后先显示 VibePin、套餐、金额、周期和 Test 标识；
- session 失效或映射错误时回到 VibePin 可恢复错误页，可重新选择套餐，但不自动创建循环 session；
- 错误页面显示用户可理解文案和安全 reference，不显示 raw Creem body；
- 不填写真实卡、不保存付款方式、不完成付款、不创建 Production checkout。

验收：8 个映射的后端契约两轮；至少月/年各一个 Test checkout UI 两轮；HTTP/Creem Test log/测试 DB 三方 correlation；取消/错误后无 active subscription、无 usage entitlement 变化。

## 9. Contact 与 Landing 详细要求

### FB-0905-21 Contact 成功态精修

当前成功态在大面积空卡内只有标题和说明，信息层级弱。目标使用紧凑成功组件：

- 明确成功图标；
- `Message sent` 标题；
- 预计回复时间；
- 一个主要下一步，例如 `Back to VibePin`；
- 一个次要动作，例如 `Send another message`，仅在业务允许时出现；
- 不再次提交原表单，不泄露刚才的表单内容。

成功组件应使用低饱和品牌高光而非大面积霓虹；`role=status` / `aria-live=polite` 只播报一次；焦点移到成功标题或主要下一步；刷新语义明确；390px 不产生大空白或按钮溢出。

### FB-0905-22 Landing/Pricing 主题与语言

Landing、Pricing、Contact 等未登录公共页面右上角加入与工作台一致的：

- 主题切换：浅色、深色或跟随系统；
- 语言切换：en、zh-CN、zh-TW；
- preference key、locale catalog、icon、aria-label 和菜单交互复用公共组件；
- 未登录也能持久化，登录后不产生两个冲突 preference；
- SSR/hydration 不闪白、不先英文后中文、不产生 hydration warning；
- 390px 时可折叠导航，但主题和语言仍可达，且不挤掉 Login/Get started。

验收：每个公共页面桌面/390 两轮；切换后跨 Pricing→Contact→Login 保持；刷新保持；键盘/Escape/焦点恢复；无 console error 或横向溢出。

## 10. 实施所有权

| 模块 | 当前任务 | 说明 |
|---|---|---|
| Create Pin / Studio / Batch | `createpin0826` | 唯一当前 Create Pin 任务；禁止联系两个旧 `create pin` |
| Product / Product Picker | 数据线0901 / Product owner | 只消费 canonical Product provenance，不复制 catalog |
| Reference / Creative | 创意智能层 | 只拥有 analysis/recommendation/selection/direction |
| Destination / OAuth / Publish | 多渠道发布 | 只拥有 canonical connection/capability/publish intent |
| Pricing / Billing / Auth / Marketing | 收款定价 | Creem Test、登录、公共页 preference 与 Contact 成功态 |
| Integration / Preview | 部署 | 只在实施、代码门禁和 root 复核完成后组装 Preview |

## 10.1 FB-0905-24 四套餐 Credit E2E

目标账号和预期权益：

| 套餐 | AI images / 月 | Scheduled posts / 月 | Accounts / platform |
|---|---:|---:|---:|
| Free | 10 | 5 | 1 |
| Starter | 150 | 150 | 1 |
| Pro | 800 | 300 | 2 |
| Business | 3000 | Unlimited | 3 |

边界：

- 只使用测试 Supabase `snulmwprsahzqvdbyenc`；明确拒绝 Production ref；
- 账号使用 `e2e-credit-{plan}-{runid}@vibepin.test`，不复用真实用户；
- 套餐由受信任的 test-only `app_metadata.plan` 或等价服务端事实源设置，不能信任客户端 `user_metadata`；
- 不通过真实生成 150/800/3000 张图耗尽额度；使用 owner-isolated fixture 将计量设置为 `limit-1` 和 `limit`；
- 随机密码、service-role key、session token 不写日志、截图、报告或仓库；
- 每次账号创建、seed、测试和 cleanup 绑定同一 `runid`，只能清理该 run 的合成数据。

每个套餐每轮执行：

1. 登录，核对目标 URL、session owner 和套餐；
2. Pricing/Billing/Usage 核对套餐名、周期、总额度、已用、剩余；
3. 零使用态核对；
4. seed 到 `limit-1`，刷新并核对 remaining=1；
5. 发起一次最小受控 usage 行为或调用纯测试消费入口，核对到达 limit；
6. 再发起一次被拒行为，必须返回明确 `limit_reached`，且 provider job、placeholder、reservation 和 usage 不增加；
7. Business scheduled posts 显示 Unlimited，不得渲染为 0、null 或 NaN；
8. 记录 UI 截图、HTTP status/code/requestId、测试 DB before/after count 与 console；
9. 退出并切换下一账号，验证前一账号的数据不可见；
10. 第二轮使用全新 session 或彻底登出后重新登录，不复用旧页面状态冒充通过。

报告必须列出每个套餐每轮的 PASS/FAIL/NOT EXECUTED、截图路径、失败错误码、预期/实际值和清理状态。任何无法安全 fixture 的 credit 类型标记 NOT EXECUTED，不得用 mock 截图冒充真实 Preview。

## 11. 实施顺序

当前阶段为 Phase 0，等待用户继续提交反馈。

1. Phase 0：持续收集、去重、只读根因和 affected files。
2. Phase 1：用户确认开始实施后，各 owner 在独立 worktree 完成最小修复。
3. Phase 2：每个 owner 完成两轮 focused tests、scoped ESLint、typecheck、registry 和必要 build。
4. Phase 3：高级模型独立审查安全、状态机、数据归属和跨模块 seam。
5. Phase 4：root 冻结唯一 successor manifest，fresh build 并仅部署 Preview。
6. Phase 5：桌面与 390px 两轮 USER 验收；有副作用步骤逐项单独授权。

## 12. 放行条件

- 所有 P0 在同一最终 runtime/deployment 上有代码门禁和当前 USER 证据；
- P1 有关闭证据或用户接受的明确延期；
- 粉色合法图片反例、相邻卡 Edit 归属和 Creem Test 8 映射均覆盖；
- 无真实付款、无未确认 provider publish、无 Production DB/env/Storage/OAuth 修改；
- 最终结论仍由 root/高级模型独立复核，不能由执行会话自评替代。

截至第 12 节的滚动反馈结论：`COLLECTING_FEEDBACK / IMPLEMENTATION_NOT_STARTED / READY_FOR_PRODUCTION: NO`。

## 13. Skill 驱动的全局 UI / 交互审查

### 13.1 审查基线与方法

本轮只读审查绑定 Preview 精确源码 `f995a0249865c65ea448b88186724b9cc7141e84`，未把历史部署截图扩张为当前代码通过，也未改产品代码、数据库、环境变量或 Production。

本轮采用三套设计规则：

- `frontend-design`：建立非模板化、非“大渐变 + 大圆角卡片 + 满屏紫色”的视觉方向；
- `web-design-guidelines`：检查语义控件、label、键盘、焦点、错误、图片尺寸、长列表、URL 状态、响应式和性能；
- `interaction-design`：定义连续、可中断、可恢复的状态转换和动效时长，而不是只加动画。

审查原则：视觉只是状态事实的表达层。任何 Posted、Failed、Scheduled、Destination、Board、Plan、Credit、Checkout、OAuth 状态都必须先由 canonical 数据和状态机判定，再决定颜色、标签、按钮和反馈。

### 13.2 重点功能覆盖矩阵

| 功能面 | 本轮重点检查 | 当前结论 |
|---|---|---|
| Landing / 公共导航 | 主题、语言、移动导航、动效、公共 preference | 需整改 |
| Auth | 登录/注册/Google/重置、`next`、错误定位、自动填充 | 需整改 |
| Pricing / Creem | 月年切换、年度总价、CTA、错误返回、周期恢复 | 需整改；真实 checkout 仍阻断 |
| Contact | 字段错误、发送成功、焦点与下一步 | 需整改 |
| App shell / Settings | 深链、模态、菜单、主题/语言、关闭后返回 | 需整改 |
| Social / Destination | connection → account → Page/Board、错误恢复 | 需整改；禁止默认回退 |
| Product Opportunities | 标题、筛选、四态空态、URL 状态、图片性能 | 需整改 |
| Product / Pin Ideas Picker | 产品/参考图来源、可选择语义、长列表 | 需整改 |
| AI Create / Reference | product-aware 推荐、无 Reference 生成、禁用原因、恢复 | 需整改 |
| Studio Cards | 必填字段、Board、轻量错误、CTA 层级、图片 fallback | 需整改 |
| Batch Edit | 输入可识别、混合账号、Board、逐目的地结果 | 需整改 |
| Plan / Schedule | 排期优先、批量动作、键盘、发布一致性 | 存在 P0 |
| Publish / Retry / History | 确认、幂等、逐目的地回执、Posted/Failed 一致 | 需整改 |
| Billing / Usage / Credits | loading/error/empty、四套餐额度、limit reached | 需真实两轮验收 |
| 全局质量 | i18n、RTL、390px、a11y、reduced motion、CLS、长列表 | 需建立统一门禁 |

“已审查”不等于“已实现”或“已通过 USER 验收”。本矩阵只用于确保没有遗漏关键功能。

### 13.3 新增 P0/P1 缺口

#### FB-0905-39 Plan 批量 Publish 可能只处理第一条（P0）

只读源码发现 `web/src/components/plan/PlanListView.tsx:223-227` 的批量 Publish 使用 `find()` 选取第一条非 Posted draft。用户选中多条后，界面语义是批量动作，但实现可能只把第一条送入发布，其余条目没有明确 success/failure/skipped 结果。

要求：

- 批量 Publish 必须对完整 selection 冻结 snapshot，逐条建立稳定 intent/idempotency key；
- 确认页展示每条 Pin、每个 provider/account/Page/Board 和 now/schedule 模式；
- 任意条目缺 destination/Board 时禁止静默丢弃，必须标记 `action_required`；
- 终态聚合为 all success / partial / all failed / unknown，并保留逐条、逐目的地回执；
- Cancel/Escape/close/backdrop 为零 provider dispatch；重复确认不能重复 job、usage 或远端发布。

验收：1/2/5 条、混合 Posted/Failed/Draft、混合有效/无 destination、重复点击、超时后恢复各两轮；selection 中每条都必须有可追溯结果。

#### FB-0905-40 语义控件、键盘和模态基础设施（P0）

当前存在多处 `div role=button`、可点击 `div`、仅视觉 label、缺少 `aria-pressed`、缺少焦点圈闭/焦点归还、错误只用 toast 或纯文字的问题。重点文件包括：

- `InlineCreateAssetPicker.tsx:385-445`：卡片选择不是原生按钮，缺 `aria-pressed`；
- `PlanListView.tsx:273,304,312`：可点击容器缺键盘语义；
- `BatchEditDrawer.tsx:408`：图标关闭按钮缺可访问名称；
- `DraftDetailsDrawer.tsx:1568-1620`、`BatchEditDrawer.tsx:1500,1877-1878`、`AiVersionDrawer.tsx:1452-1482`：dialog/focus/scroll 契约不完整；
- `login/page.tsx:110`、`signup/page.tsx:140`、`ContactForm.tsx:103,155`：可见 label 未与输入唯一关联；
- 登录、注册和 Contact 的失败状态缺字段级关联、`role=alert`/`aria-live` 和首错聚焦。

统一要求：

- 优先使用 `<button>`、`<a>`、`<input>`、`<select>`；自定义控件必须补齐完整键盘模型；
- 每个字段有唯一 `id/name/label/type/autocomplete`，email 关闭拼写检查；
- 提交错误保留用户输入，在字段附近显示短错误，并把焦点移到错误摘要或首个错误字段；
- 所有模态进入时保存触发器和页面滚动，Tab 圈闭，Escape/关闭后归还焦点，背景 inert，正文只有一个滚动 owner；
- 390px 触控目标至少 44px，fixed footer 不遮挡最后一个字段或错误。

验收：仅键盘完成登录、Contact、Reference 选择、Batch Edit、设置和发布确认；NVDA/VoiceOver 基础朗读顺序；桌面与 390px 各两轮。

#### FB-0905-41 图片、长列表与布局稳定性（P1）

当前 Product/Pin Ideas/Reference 与 Plan/Batch 列表没有统一的大列表策略，且多处原生图片缺明确尺寸或懒加载：

- `InlineCreateAssetPicker.tsx:563-581,1503-1521`、`PlanListView.tsx:256`、`BatchEditDrawer.tsx:1611`：大数组直接映射；
- `ProductImageSurface.tsx:81-111`、`DraftDetailsDrawer.tsx:1626`、`PlanListView.tsx:288`、`BatchEditDrawer.tsx:768,1646,1680,2015,2048`：需要固定容器比例、尺寸提示和加载策略。

要求：

- 超过 50 个条目使用分页、窗口化或渐进加载；滚动时不能整页重排；
- 图片在请求前预留 aspect ratio/width/height，非首屏 lazy load，首屏主图才允许高优先级；
- decode/timeout/tiny/unsupported fallback 不改变卡片尺寸；
- 搜索、筛选、刷新保留滚动锚点和已选项；数据更新只替换受影响条目；
- skeleton 与真实内容同尺寸，避免 CLS；失败可单项重试，不重置整个列表。

验收：28、60、120、500 条；慢图、404、decode fail、10s timeout；滚动中筛选/刷新/选中；桌面与 390px 各两轮，并记录 CLS、长任务和交互延迟。

#### FB-0905-42 可恢复 URL 状态与统一 locale/theme（P1）

需要写入 URL 或路由历史的状态包括：Pricing 月/年周期、Product filters/type/sort、Settings 子页、可分享的面板/筛选。当前关闭 `/app/settings/*` 可能强制去 `/app`，Pricing 周期和多处 picker 状态也无法通过刷新、Back/Forward 恢复。

要求：

- URL 是可分享状态的事实源；本地瞬时输入、敏感字段和未提交内容不得放入 URL；
- Settings 从哪个页面打开就回到哪个页面，深链关闭不丢失来源；
- 已保存 `lang/dir/theme` 在 hydration 前应用，避免先英文后中文、LTR/RTL 闪烁和暗色原生控件失配；
- 日期、时间、数字、价格统一通过 `Intl.*`；禁止散落的 `en-US` 硬编码；
- Back/Forward 不重放 provider action、checkout 或 publish，只恢复安全 UI 状态。

验收：刷新、复制链接、新标签、Back/Forward、登录前后、en/zh-CN/zh-TW/RTL、浅色/深色/系统模式各两轮。

#### FB-0905-43 公共页面与账户流程的精细交互（P1）

补充要求：

- Auth：idle → validating → submitting → success/failure；Google/OAuth 需有跳转中、弹窗未打开、provider 拒绝和可重试状态；密码重置成功禁止使用浏览器 `alert()`；
- Signup：Terms/Privacy 必须是真实可达链接，不能使用 `href="#"`；
- Pricing：月/年切换使用 radiogroup 或等价语义并同步 URL；年付同时显示 `USD $X/month, billed annually as USD $Y/year`；只有当前卡片进入 loading；
- Contact：字段错误内联；成功态是紧凑、可聚焦、有下一步的确认组件；
- Settings：切 tab 不重置内容滚动；有 dirty state 时关闭需明确处理；
- Social：Page ID/URL 使用正确 input type/name/autocomplete/inputMode；Page/Board 加载失败在当前行内恢复，不只弹 toast；
- Landing：禁止 `transition: all`；公共入场与菜单遵循 reduced-motion；主题和语言控制与工作台同源。

### 13.4 去“AI 模板味”的设计基线

目标不是把所有页面重新装饰一遍，而是让界面像成熟的运营工具：安静、直接、可扫读、状态可信。

- 画布：中性浅灰/深灰，内容区与导航用细边界和层级区分，不依赖大渐变背景；
- 品牌色：紫色只用于当前 selection、明确 focus 和当前唯一 primary action；同一视口不允许五六个紫色 CTA 抢注意力；
- 标题：应用内页面标题使用紧凑产品级尺寸，不使用 Landing hero 大标题；
- 容器：减少 card 套 card、过大圆角、整块彩色底、发光阴影和重复 pill；
- 表单：白/中性底、清晰 1px 边界、label、placeholder、hover 和 focus ring，使用户一眼知道哪里能输入；
- 状态：Error/Warning/Success 使用图标 + 短标题 + 一句行动建议；详细诊断进入 disclosure，不在主流程堆多行红字；
- 数据：Posted、Scheduled、Failed、Credit、Destination 等事实使用文字、图标和时间共同表达，不能只靠颜色；
- 文案：减少泛化 marketing 句和重复解释；短句优先，按钮使用动词 + 目标，例如 `Choose Board`、`Retry generation`。

### 13.5 交互动效与“丝滑”标准

- 按压、选中、hover：100–150ms；菜单/小面板：200–300ms；modal/drawer：300–500ms；
- 只动画 `opacity` 和 `transform`，禁止 `transition: all` 及布局属性动画；
- 动画必须可中断，快速重复操作以用户最后一次意图为准；
- 超过 300ms 的操作显示局部 progress；页面其余区域保持可读，不能全屏假死；
- 乐观更新只用于可安全回滚的本地状态；publish、schedule、checkout、credit 等副作用必须等待服务端事实；
- drawer/modal 开关保留焦点、滚动和 selection；失败不清空已填内容；
- 同一异步 attempt 只更新一个稳定 toast/status，不允许 success 与 error 同时出现；
- `prefers-reduced-motion` 下取消位移和持续动画，但保留立即可辨识的状态变化。

### 13.6 全局 UI 验收锚点

- `UI-A01`：每个界面只有一个视觉主任务；Schedule 为 Create Pin 的 primary，Publish 为 secondary。
- `UI-A02`：必填 Title、Description、URL、Publishing account、Board 位于主路径；Details 只能放高级/可选项。
- `UI-A03`：所有错误在发生位置附近提供一个明确恢复动作；原始技术详情默认折叠。
- `UI-A04`：所有选择、发布、排期和付款状态有 canonical readback，刷新后保持一致。
- `UI-A05`：所有菜单、列表、表单、抽屉和模态可仅用键盘完成，并正确管理焦点。
- `UI-A06`：390px 无横向溢出、双滚动和 fixed footer 遮挡；触控目标至少 44px。
- `UI-A07`：50+ 条目采用分页/窗口化/渐进加载；图片预留尺寸、非首屏懒加载，fallback 不引发布局跳动。
- `UI-A08`：Loading、Empty、Filtered empty、Stale、Forbidden、Error、Partial、Unknown 不得互相冒充。
- `UI-A09`：页面动效尊重 reduced-motion，且没有 `transition: all`、无限装饰动画或影响主线程的布局动画。
- `UI-A10`：en/zh-CN/zh-TW 与浅/深/系统主题在首屏、刷新、跨页面和登录前后保持一致。
- `UI-A11`：批量操作的 selection 数量与终态回执数量相等；每条、每目的地都可追溯。
- `UI-A12`：视觉对比图需至少覆盖默认、hover/focus、loading、empty、error、partial、success，不允许只交付理想态。

### 13.7 需要出图的范围

本 PRD 配套两张四面板低保真线框，锁定最容易误解的布局和状态：

1. Studio 卡片：必填字段、Publishing account、Board、轻量错误、Schedule 主按钮；
2. Batch Edit：可识别输入、混合账号、逐条 readiness、逐目的地结果；
3. AI Create / Choose Pin References：product-aware 推荐、更新时间、刷新、禁用原因和选中条；
4. Product Opportunities：紧凑标题、同一筛选面、真实四态数据区。

第二张覆盖 Auth 错误恢复、Pricing 年付总价、Contact 成功态和 390px Settings/Social 目的地恢复。两张图均为布局与状态契约，不是最终视觉稿；开发仍需复用真实组件和设计 token，不用 AI 生图替代真实组件设计。

线框文件：

- `docs/prd/assets/0905-ui-review/0905-VibePin-关键UI线框-v0.1.svg`；
- `docs/prd/assets/0905-ui-review/0905-VibePin-关键UI线框-v0.1.png`（评审预览）；
- `docs/prd/assets/0905-ui-review/0905-VibePin-公共认证与设置UI线框-v0.1.svg`；
- `docs/prd/assets/0905-ui-review/0905-VibePin-公共认证与设置UI线框-v0.1.png`（评审预览）。

截至第 13 节的横切审查结论：`FULL_UI_STATIC_AUDIT_COMPLETE / IMPLEMENTATION_NOT_STARTED / USER_E2E_PENDING / READY_FOR_PRODUCTION: NO`；第 14 节继续完成 64 个页面入口的逐页登记与核对。

## 14. 全部页面入口逐页审查（64/64）

### 14.1 覆盖口径

本节以 `web/src/app/**/page.tsx` 为事实源，共识别 64 个页面入口：公共/根级 20 个、`/app` 核心 20 个、`/app/settings` 13 个、`/admin` 11 个。每个入口都按以下九项检查：

1. 页面唯一主任务与视觉层级；
2. `main`、标题层级、语义控件和可访问名称；
3. 键盘路径、`focus-visible`、modal/drawer 焦点圈闭与归还；
4. Loading、empty、filtered empty、stale、forbidden、error、partial、unknown、success；
5. 390px、桌面、滚动 owner、safe area 和触控目标；
6. en/zh-CN/zh-TW、日期/价格/数字 `Intl.*`、浅色/深色/系统主题；
7. URL、刷新、Back/Forward、新标签和登录前后恢复；
8. 图片尺寸/懒加载/失败占位、长列表、CLS、reduced motion；
9. 外部动作前确认、稳定 attempt、canonical readback 和失败恢复。

redirect、`return null` 和 modal-backed 页面不是“没有 UI 就跳过”，而是按路由契约审查：目标必须唯一、query/来源可恢复、鉴权一致，且不能让旧页面继续执行另一套写入流程。

### 14.2 64 个页面入口清单与处置

| # | 页面入口 | 类型 | 审查结论 / 主要验收点 |
|---:|---|---|---|
| 1 | `/` | 公共主页面 | 保留；补图片固有尺寸、可暂停/减弱轮播、静态示例不可伪装成可点击控件、公共 theme/locale。 |
| 2 | `/about` | 公共信息 | 保留；补 `main`/skip link、focus-visible、公共主题和语言。 |
| 3 | `/acceptable-use-policy` | 法务 | 保留；并入统一 LegalLayout，补 `main`、目录/锚点焦点、locale/theme。 |
| 4 | `/careers` | 公共信息 | 保留；补 `main`/skip link、键盘焦点和移动排版。 |
| 5 | `/contact` | 公共表单 | 保留；字段 label/name/autocomplete、内联错误、首错聚焦、成功确认和下一步。 |
| 6 | `/data-deletion-status` | 安全状态 | 保留；missing/invalid/expired token 分态、短错误、重试/联系支持，禁止泄露 token。 |
| 7 | `/login` | Auth | 保留；Google/email/password 的 pending/error/return path、字段关联、无 `alert()`、移动端不抢焦点。 |
| 8 | `/pinterest-app` | 公共/法务 | 保留；统一 LegalLayout、语义标题、公共 theme/locale。 |
| 9 | `/pricing` | 定价/付款入口 | 保留；月年 URL 状态、年付总额、单卡 loading、Creem 错误返回、语义切换组。 |
| 10 | `/privacy` | 法务 | 保留；统一 LegalLayout、`main`/skip link、目录键盘路径。 |
| 11 | `/refund-policy` | 法务 | 保留；统一 LegalLayout、locale/theme、退款入口清楚可达。 |
| 12 | `/signup` | Auth | 保留；真实 Terms/Privacy 链接、字段错误/密码要求、Google 回调和 return path。 |
| 13 | `/terms` | 法务 | 保留；统一 LegalLayout、`main`/skip link、locale/theme。 |
| 14 | `/welcome` | Onboarding | 保留；定义完成/跳过/返回状态，避免孤立模板页并补主题/语言。 |
| 15 | `/keyword-trends` | alias | 仅 308/服务端 redirect 至 `/app/trends`；保留安全 query，不渲染第二套页面。 |
| 16 | `/products` | alias | 仅 redirect 至 `/app/products`；保留安全 query，不复制数据逻辑。 |
| 17 | `/sourcing` | alias | 仅 redirect 至 `/app/trends`；保留安全 query。 |
| 18 | `/dashboard` | 旧重复页面 | P0 退役/redirect 至 `/app/dashboard`；禁止旧 queue/settings 写入模型继续可达。 |
| 19 | `/settings` | 旧重复页面 | P0 退役/redirect 至 `/app/settings`；禁止失败时假成功。 |
| 20 | `/preview/[taskId]` | 旧重复页面 | P0 退役或只读兼容 redirect；禁止旧 SSE/API/publish 与 Studio 并存。 |
| 21 | `/app` | app alias | redirect `/app/studio`；鉴权、query 和来源恢复一致。 |
| 22 | `/app/admin` | admin alias | redirect `/admin`；权限失败语义一致。 |
| 23 | `/app/admin/visual-review` | admin alias | redirect `/admin/visual-review`；权限失败语义一致。 |
| 24 | `/app/connect/pinterest` | OAuth 过渡页 | 保留；timeout/manual fallback、bfcache 防重放、焦点和 reduced motion。 |
| 25 | `/app/dashboard` | App 首页 | 保留；移除硬编码浅色孤岛，统一主题、loading/error/empty 和可靠计数。 |
| 26 | `/app/discover` | 发现 | 保留；筛选/搜索/排序/视图/分页/savedOnly URL 化，drawer 可恢复。 |
| 27 | `/app/help` | 帮助 | 保留且允许公开访问；搜索需 label/`aria-live`，增加“我的工单”入口。 |
| 28 | `/app/help/[slug]` | 帮助详情 | 保留；无效 slug、上一篇/下一篇、标题锚点、返回搜索状态。 |
| 29 | `/app/history` | 历史 | 保留；search/tab/selection URL 化，与 Studio/Plan 使用同一 canonical 生命周期。 |
| 30 | `/app/plan` | 旧 app alias | redirect `/app/studio` 并保留安全 query；禁止第二个 Plan 数据模型。 |
| 31 | `/app/product-library` | 商品库 | 保留；new collection label/focus、图片尺寸、空态/失败、URL 和 50+ 性能。 |
| 32 | `/app/products` | Product Opportunities | 保留；紧凑标题、筛选同层、真实四态、canonical API、图片/分页/URL。 |
| 33 | `/app/products/saved` | Saved Products | 保留；空态区分无收藏/过滤为空/加载失败，Back 返回原筛选。 |
| 34 | `/app/queue` | 发布队列 | 保留；queued/running/retryable/unknown/terminal 分态和稳定远端回执。 |
| 35 | `/app/studio` | Create Pin 主工作台 | 保留；按 FB-0905-01..40 及 UI-A01..12 执行，Schedule 主、Publish 次。 |
| 36 | `/app/support/tickets` | 工单列表 | 保留；从 Help 可发现、i18n、loading/error/empty、状态和分页。 |
| 37 | `/app/support/tickets/[id]` | 工单详情 | 保留；权限/404/附件失败、图片尺寸、回复 loading/error/success。 |
| 38 | `/app/trends` | 趋势 | 保留；keyword/filter/offset/evidence drawer URL 化，空数据不伪造。 |
| 39 | `/app/virals` | alias | redirect `/app/discover`；保留安全 query。 |
| 40 | `/app/workspace/[category]` | 分类工作区 | 保留；无效 category、source lineage、Plan/Studio prefill 刷新和 Back 不丢。 |
| 41 | `/app/settings` | modal route | 只作为 SettingsModal 深链；打开/关闭/刷新必须保留来源和 tab。 |
| 42 | `/app/settings/ai-brand` | modal route | 深链到 AI Brand tab；dirty state、保存/失败、焦点和返回来源。 |
| 43 | `/app/settings/billing` | modal route | 深链到 Billing；loading/error/empty/active/canceled 和 Usage tri-state。 |
| 44 | `/app/settings/integrations` | router | 根据可用集成 redirect Shopify/Social；目标必须可解释、可预测。 |
| 45 | `/app/settings/language` | modal route | 语言/区域草稿与已保存值分离；首屏 hydration 前应用。 |
| 46 | `/app/settings/pinterest` | alias | redirect Social tab 并保留安全 query；不再有单独 Pinterest 状态源。 |
| 47 | `/app/settings/profile` | modal route | Profile 字段 label/autocomplete、dirty/保存失败、owner readback。 |
| 48 | `/app/settings/publishing` | modal route | Publishing defaults 的表单语义、禁用原因、保存回读。 |
| 49 | `/app/settings/shopify` | modal route | Shopify connect/reconnect/sync/disconnect 明确状态，移除 `window.confirm`。 |
| 50 | `/app/settings/smart-schedule` | 实体 route + modal 风险 | P1 统一为一个呈现模型；不得同时在底层页面和 SettingsModal 重复内容/滚动。 |
| 51 | `/app/settings/social` | modal route | connection/account/Page/Board 链路逐行恢复；禁止默认 destination。 |
| 52 | `/app/settings/support` | modal route | Help/Contact/Ticket 入口与诊断复制反馈；隐私字段默认折叠。 |
| 53 | `/app/settings/workspace` | modal route | workspace identity、通知、权限、保存失败和跨账户隔离。 |
| 54 | `/admin` | Admin 概览 | 保留；统一主题/locale、可追溯指标、loading/error/empty、表格响应式。 |
| 55 | `/admin/creative-intelligence` | Admin 工具 | 保留；校准项键盘评分、图片尺寸、保存反馈和空态。 |
| 56 | `/admin/data` | Admin 数据 | 保留；日期/数字 locale、图片 CLS、长表格分页/虚拟化、失败来源证据。 |
| 57 | `/admin/generation-logs` | Admin 日志 | 保留；可点击行改为键盘可达控件，filter URL 化，详情 modal 管理焦点。 |
| 58 | `/admin/pipeline` | Admin 管线 | 保留；running/idle/failed/stale、时间 locale、表格和重试反馈。 |
| 59 | `/admin/support` | Admin 工单 | 保留；筛选/分页 URL、i18n、loading/error/empty、行操作可达。 |
| 60 | `/admin/support/[id]` | Admin 工单详情 | 保留；AI 摘要/翻译/发送/重试分态，防重复发送，日期 locale。 |
| 61 | `/admin/today` | Admin 今日 | 保留；时区明确、blocker 空态/错误、表格长列表和稳定刷新。 |
| 62 | `/admin/users` | Admin 用户 | 保留；搜索 input focus、筛选 URL、数量口径、分页/性能。 |
| 63 | `/admin/users/[id]` | Admin 用户详情 | 保留；权限/404、tabs URL、图片尺寸、support note 成功/错误。 |
| 64 | `/admin/visual-review` | Admin 视觉评审 | 保留；键盘打分、图片尺寸、保存冲突/失败、filter URL 和刷新。 |

### 14.3 跨页面新增缺口

#### FB-0905-44 旧根级页面仍可形成第二套产品流程（P0）

`web/src/proxy.ts:64-72` 只对 `/app` 做 session redirect；`/dashboard`、`/settings`、`/preview/[taskId]` 位于该边界外，且分别保留旧 task queue、settings 保存与 SSE/publish 逻辑。仓库仍有旧 `/settings` 链接来源，包括 `web/src/components/Sidebar.tsx:86` 和 `web/src/app/app/workspace/[category]/page.tsx:374`。

要求：

- 三个旧入口不得继续承载独立写入流程；默认使用 308/服务端 redirect 到 canonical `/app` 入口；
- 若 `/preview/[taskId]` 为历史分享链接确实需要保留，只允许鉴权后的只读兼容页，任何发布/重试必须进入 canonical Studio intent；
- redirect 保留 allowlist 内 query，拒绝开放重定向、敏感参数和 action replay；
- proxy/auth、导航 active state、analytics 和测试全部只认 canonical route。

验收：登录/未登录、刷新、Back/Forward、旧书签、无效 taskId 各两轮；三条旧 URL 不得调用旧写 API，不得出现第二套 Settings/Publish UI。

#### FB-0905-45 旧 Settings 网络失败仍提示保存成功（P0）

`web/src/app/settings/page.tsx:134-149` 在网络保存失败分支调用 `toast.success("Settings saved locally")`，但该分支没有足够证据证明设置已可靠写入本地或 canonical server。这会把失败冒充成功，并可能让用户以为语言、通知或账户设置已经生效。

要求：

- canonical Settings 只在服务端/本地事实源确认后显示 success；
- 离线保存若是正式能力，必须有 durable local revision、pending sync 标记、owner scope、重试和 server readback；否则显示短错误并保留 dirty state；
- 旧 `/settings` 退役后仍保留一条反向回归，防止类似 false-success 逻辑迁入 SettingsModal。

验收：200、400、401、409、429、500、断网、response lost、A→B→A，各两轮；success、pending sync、failed 不能混淆。

#### FB-0905-46 Plan “Publish selected” 文案与实际动作不一致（P1）

`web/src/components/plan/WeeklyPlanWorkspace.tsx:2628-2641` 中 `wp-publish-selected` 与 Batch Edit 都调用 `openBatchEditFor([...selectedIds])`。当前按钮说 Publish，实际只是进入编辑抽屉，属于高风险意图误导。

要求：要么改名为 `Edit selected`，要么完成显式发布确认 → provider dispatch → 逐条结果的真实链路；在后者未完成前不得保留 Publish 文案。与 FB-0905-39 的完整 selection 语义一起验收。

#### FB-0905-47 公共/Auth/法务页面缺统一可访问壳层（P1）

`about/page.tsx:17-69`、`careers/page.tsx:12-53`、`contact/page.tsx:22-83`、`acceptable-use-policy/page.tsx:24-251`、`privacy/page.tsx:15-325`、`refund-policy/page.tsx:14-300`、`terms/page.tsx:16-271`、`pinterest-app/page.tsx:14-220`、`welcome/page.tsx:10-45` 缺少一致的 `main`/skip link；公共导航多处只有 hover，没有明确 focus-visible。`web/src/app/layout.tsx:64` 固定 `lang="en"`，主题/`color-scheme` 初始化主要集中在 app/admin 壳层。

要求：提取 PublicShell/LegalLayout，提供 skip link、唯一 `main`、标题锚点、focus-visible、动态 `lang/dir`、首屏 theme/color-scheme、移动导航、统一页脚；所有公共页面不得复制一套固定英文/固定暗色模板。

#### FB-0905-48 App 页面可恢复状态、数据一致性与性能（P1）

- `app/discover/page.tsx:1216-1251,1541-1757`：filters/search/sort/view/page/savedOnly 未完整 URL 化；
- `app/trends/page.tsx:1411-1424,1654-1907`：keyword/filter/offset/evidence drawer 未完整 URL 化；
- `app/history/page.tsx:1198-1215`：search/tab/selection 未完整 URL 化；
- `app/history/page.tsx:1053-1260` 与 `WeeklyPlanWorkspace.tsx:2212-2268` 使用不同本地状态链，fresh browser 可能出现 History 有记录而 Plan 空；
- `BatchEditDrawer.tsx:1545-1790` 直接渲染长表格；`product-library/page.tsx:109,226,304,363` 多张图缺固有尺寸；
- `app/help/page.tsx:71-77` 搜索缺 label/结果 live region，且 Help 未清楚链接到已有 tickets 路由。

验收：刷新、新标签、Back/Forward、bfcache、登录前后、28/60/120/500 条、慢图/404、桌面/390 各两轮；URL 恢复不触发 publish/schedule/OAuth/checkout，History/Plan/Studio 的同一记录状态一致。

#### FB-0905-49 Settings/Admin 交互基础设施不统一（P1）

当前静态证据包括：

- `/app/settings/*` 多数 `page.tsx` 直接 `return null`，由 `app/layout.tsx:536-541` 的 SettingsModal 接管；`/app/settings/smart-schedule` 却渲染实体页面，存在双呈现/双滚动模型；
- `app/settings/page.tsx:3` 以及 ai-brand、billing、language、profile、publishing、shopify、social、support、workspace 的空 page 在路径检测、JS 或 hydration 异常时没有 fallback，深链可能成为空白页；
- `SettingsModal.tsx:1568-1715` 和 `LanguageRegionModal.tsx:200-233` 有 dialog 基础语义，但需要统一验证 focus trap、Escape、触发器焦点归还、背景 inert、dirty close；
- `ShopifyTab.tsx:283` 使用 `window.confirm`，无法统一样式、焦点、i18n 和移动体验；
- `app/settings/smart-schedule/page.tsx:26` 的外部 Save 与内部表单状态分离，未证明 saving/disabled/error/draft preservation 能同步；
- `GenerationLogsClient.tsx:225` 以 `<tr onClick>` 打开详情，缺键盘等价；`304,319` 的 backdrop/关闭按钮缺完整 dialog/focus 契约；
- `UsersTableClient.tsx:159`、`SupportNotesClient.tsx:105` 使用 `outline-none`，未同时证明替代 focus ring；
- `CalibrationClient.tsx:143-212` 的异步投票缺少成功/失败 `aria-live` 与失败后的就地重试/焦点策略；
- `AdminSupportTicketDetail.tsx:616-620` 的 Resolve/Close 会改变工单终态，未见统一确认或短期 undo；
- `admin/layout.tsx:22-24` 允许 support role 进入 admin 壳层，但不可访问的敏感导航仍可能先显示、点击后再拒绝；导航可见性应与服务端角色能力一致；
- 多个 admin 页面使用无显式 locale 的 `toLocaleString()/toLocaleDateString()`，表格与日志直接 `.map()`，图片只有 CSS 尺寸；
- `admin/layout.tsx` 与 app shell 均采用 `100dvh + overflow:hidden`，每个页面必须明确唯一滚动 owner，避免再次出现页面无法下拉。

要求：建立统一 Modal/Drawer、ConfirmDialog、Field、AsyncState、DataTable、ImageSurface、DateTime 组件契约；空 route 必须提供显式 redirect 或可恢复 fallback；Admin 按角色隐藏/解释无权入口，危险终态动作确认或可撤销。Admin 可以保持高密度，但不得以牺牲键盘、对比度、错误恢复和响应式为代价。

### 14.4 页面族验收用例

以下用例用于实现后的两轮验证；每轮都要保留实际结果、截图、console、关键 HTTP 和 canonical readback，不能只记录“看起来正常”。

| 用例 ID | 页面族 | 两轮必测 |
|---|---|---|
| PAGE-A01 | Landing/About/Careers/Welcome | keyboard-only 导航、skip link、主题/语言刷新保持、390 无溢出、reduced motion。 |
| PAGE-A02 | Legal/Pinterest App | 唯一 main/h1、目录锚点、focus、打印/窄屏、所有法律链接有效。 |
| PAGE-A03 | Contact/Data deletion | 正常、字段错误、网络失败、重复提交、成功下一步、token invalid/expired，首错聚焦且无敏感泄露。 |
| PAGE-A04 | Login/Signup | email/password、Google success/deny/popup fail、forgot password、safe next、Terms/Privacy、A→B session。 |
| PAGE-A05 | Pricing | Monthly/Yearly/Content/extra account、四套餐、Creem Test mapping、checkout error return、URL 恢复。 |
| PAGE-A06 | Legacy/Alias routes | 9 个 alias/legacy 入口逐一验证 canonical target、query allowlist、未登录 redirect、零旧写 API。 |
| PAGE-A07 | App shell/Dashboard/Help | theme/locale、menu/dialog focus、Help→Tickets、loading/error/empty、唯一滚动 owner。 |
| PAGE-A08 | Discover/Trends/Products/Saved/Library | default/filtered/empty/error/stale、URL/Back、图片 fallback、60/120/500 条性能。 |
| PAGE-A09 | Studio/Plan/History/Queue | create/generate/schedule/publish/partial/unknown/readback；Schedule primary；同一记录跨页一致。 |
| PAGE-A10 | Settings 13 routes | 每条深链、modal tab、dirty close、save/pending/error、主题/语言首屏、Social/Page/Board、Shopify confirm。 |
| PAGE-A11 | Admin overview/data/pipeline/today | 权限、loading/error/empty/stale、时区/locale、长表格、刷新不跳位。 |
| PAGE-A12 | Admin users/logs/support/review | filter URL、键盘行操作、modal focus、AI action pending/error、重复发送防护、图片 CLS。 |

### 14.5 设计 Skill 对实施的约束

三套 Skill 的建议必须作为实现评审门禁，而不是参考性文字：

- `frontend-design`：每个页面先写一句“用户来这里完成什么”，再确定单一视觉主任务；禁止默认套用大渐变、大圆角卡片海、满屏 pill 和重复紫色 CTA；
- `web-design-guidelines`：语义 HTML、label/name/autocomplete、键盘/focus、inline error、URL 状态、图片尺寸、50+ 列表策略、reduced motion 和 hydration 稳定性为硬门禁；
- `interaction-design`：每个异步动作必须有 idle/pending/success/error/partial/unknown 状态图；动画只服务因果和空间连续性，使用可中断的 opacity/transform，不得用动效掩盖延迟或状态不确定性；
- 任何 Skill 建议若与 canonical 数据、隐私、计费、发布或 OAuth 安全边界冲突，以事实正确和 fail-closed 为先；不得为了“丝滑”使用假成功、盲重试或提前乐观发布。

现有两张线框已覆盖最容易产生实现分歧的八个重点面板。Admin、法务与信息页以统一组件契约为主，本轮无需额外视觉图；若实施者无法从组件契约唯一确定焦点/滚动/状态行为，再补交状态线框，不用 AI 生图替代真实 UI 组件。

### 14.6 本轮静态审查边界

本轮结论只证明 64 个页面入口已被登记、静态源码已按三套 Skill 规则审查、具体缺口与验收条件已写入 PRD。它不证明这些问题已修复，也不证明 Preview USER E2E、四套餐 credits、真实 Creem checkout、OAuth consent、provider publish 或 Production 已通过。

本轮最终结论：`64_PAGE_ENTRY_STATIC_AUDIT_COMPLETE / SKILL_RECOMMENDATIONS_IN_PRD / IMPLEMENTATION_NOT_STARTED / USER_E2E_PENDING / READY_FOR_PRODUCTION: NO`。
