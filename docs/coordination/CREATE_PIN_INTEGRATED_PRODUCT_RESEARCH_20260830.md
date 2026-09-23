# VibePin Create Pin 产品需求与独立调研整合报告

> 版本：2026-08-30  
> 结论责任人：Codex Advisor  
> 范围：Create Pins、Plan、Schedule、Publish、Failed recovery，以及与主流程直接相关的 Link to Pin、Brand Kit、轻量图片编辑。Insights 不在本报告范围。  
> 状态：产品评审稿，不代表开发完成或已上线。

## 1. 最终产品判断

Create Pin 应定位为 **从商品或内容来源出发，批量产出真正不同的 Pin，并完成审核、自动排期、发布和失败恢复的工作台**。

它不应走两个极端：

- 不能只是一个把 Prompt 交给图片模型的生成器。
- 也不应该投入大量成本复制 Canva 的完整自由画布。

VibePin 最有价值的完整链路是：

**Choose source → Generate variations → Quick edit → Preflight → Auto schedule → Publish → Recover**

本轮整合后的优先级结论是：

1. 先完成现有 Create Pin 主流程的可靠性和 UI 收敛。
2. 再把 Link to Pin、多方向 Fresh Pin、轻量文字图层和发布前检查连成一个差异化闭环。
3. Brand Kit 作为生成和编辑的共享约束，不单独做成孤立的 Settings 功能。
4. 高成本的商品锁定、局部重绘和商品变化同步放在后续阶段。

## 2. 调研范围与证据层级

### 2.1 已讨论产品资料

- 用户对 Create Pin、Plan、Schedule、Failed、产品选择和按钮层级的连续批注。
- 0826 批注版 PRD 的 3 条结构化评论。
- 0826 修订版与 Plan 悬浮交互补充版 PRD。
- 0817 Create Pin / Plan 布局 PRD、0824 多图与快速编辑 PRD、历史失败恢复 PRD。
- Zcode `sess_4a48bb8f-9a9d-4fe5-a77a-7da4a9b77177` 的研究结论。
- Claude `80631ec9` 集成基线和逐文件碰撞审计。

### 2.2 用户研究证据

Zcode 研究工件共扫描 171 条去重视频和 116 个频道，深读 19 条新视频与 19 位创作者，抓取 996 条评论，形成 21 条需求证据和 20 个候选功能。报告中明确区分用户评论、视频演示、厂商旁证和弱信号。

高强度信号集中在：

- URL 到 Pin 与图片提取。
- Fresh Pin 变体疲劳。
- 跨工具搬运和批量出口断裂。
- AI 文字错误与商品失真。
- 生成后无法局部编辑。
- 品牌一致性。
- 尺寸、裁切、链接和字段校验。
- AI modified 标签焦虑。

### 2.3 Codex 独立竞品与官方核验

本轮额外核验了 Pinterest、Tailwind 和 Canva 的当前官方资料，并检查了本地保存的 Tailwind Plan、SmartSchedule、失败页、Pinterest Create Pin、VibePin UI 方案。

关键外部事实：

1. Tailwind SmartPin 当前支持从 URL 创建 Pin，并每 7 天自动生成新的 Fresh Pin 草稿；用户可以选择 URL 中的图片、在多个设计之间切换、编辑文案并一键进入下一个可用时段。[Tailwind SmartPin 官方帮助](https://support.tailwindapp.com/en/articles/10683674-getting-started-with-smartpin)
2. Tailwind SmartSchedule 允许按账号生成 1–50 个每日时段，并区分自动时段与自定义时间。[Tailwind SmartSchedule 官方帮助](https://support.tailwindapp.com/en/articles/1577579-how-do-i-generate-a-new-time-slot-schedule)
3. Pinterest 官方建议持续发布原创内容并避免重复 Pin；重复上传可能被视为 spam。[Pinterest Pin 分发与表现说明](https://help.pinterest.com/en/business/article/pin-performance-and-distribution)
4. Pinterest 当前网页排期一次可选多张图片，但每张图片会创建独立 Pin；移动端多选会拼成一个视频 Pin。排期后可改时间、标题、Board、描述和链接，但不能改媒体。[Pinterest 官方 Schedule Pins](https://help.pinterest.com/en/business/article/schedule-pins)
5. Pinterest v5 开发文档说明 organic Pin 创建已简化为 image 或 video；因此 VibePin 不能只凭 UI 名称假定当前 API 一定支持 Carousel。[Pinterest Developer：Create boards and Pins](https://developers.pinterest.com/docs/work-with-organic-content-and-users/create-boards-and-pins/)
6. Pinterest AI 标签不仅读取 IPTC 元数据，也使用分类器识别生成或修改内容；用户主动披露也会触发标签。[Pinterest Gen AI labels](https://help.pinterest.com/en/article/gen-ai-labels)
7. Canva Brand Kit 的核心是 Logo、颜色、字体、图片、模板和使用规范，并支持多个品牌；Magic Edit 采用选区加文字指令的局部替换模式。[Canva Brand Kit](https://www.canva.com/pro/brand-kit/)、[Canva Magic Edit](https://www.canva.com/features/ai-replace/)

### 2.4 Codex 独立代码核验

在干净的 `integrate/create-pins-on-fanout-0827@80631ec9` worktree 中完成只读源码检查，并运行 9 组聚焦测试：

- Plan sidebar model：23/23
- Studio / Plan matching：15/15
- Create Pins / Batch Edit UI：28/28
- Batch Edit planning：35/35
- Pin readiness：21/21
- Publish error display：9/9
- Product selection：31/31
- Media notice：12/12
- Studio flow regression：19/19

合计 **193/193 通过**。这些测试证明若干领域与 UI 契约存在，但不覆盖浏览器真实交互、真实平台发布或下文的生成重复执行 P0。

## 3. 目标用户与核心任务

### 3.1 主要用户

- Etsy / Shopify 小型卖家。
- 数字产品和 POD 卖家。
- 博客、联盟营销和 Pinterest 流量运营者。
- 同时经营 Pinterest、Instagram 和 Facebook 的小团队。

### 3.2 用户真正想完成的任务

用户不是为了“生成一张漂亮图片”而使用 Create Pin。完整任务是：

1. 从商品、网页或已有图片快速开始。
2. 一次得到多个可用且有明显差异的版本。
3. 只修改文字、图片、颜色、CTA 或局部，不整张重做。
4. 确认链接、账号、Board、尺寸和平台要求没有问题。
5. 不挑时间，直接进入合理的下一个发布时段。
6. 发布后看到真实结果；失败时知道怎么修。

## 4. 产品信息架构

### 4.1 Create Pins 是工作台，不是历史仓库

默认进入 Drafts；顶部生命周期为 Drafts / Scheduled / Posted / Failed / All。Plan 是独立的时间上下文，不属于生命周期 Tab。

一条 Content 在 Draft、Scheduled、Posted 与失败恢复中保持同一身份。Failed 是异常工作视图；部分成功的内容仍是 Posted，并附带 Needs attention。

### 4.2 页面入口

页面顶部保留三个轻量创建入口：

- Generate AI Pin
- Upload images
- Choose product

Link to Pin 可以在 Choose product / Import URL 流程中成为一级来源，也可以在验证后升级为独立入口。Batch edit 只在多选后出现，不作为常驻顶部按钮。

### 4.3 Draft 卡片

Draft 默认就是紧凑编辑态，不使用 hover 展开。默认字段：Media、Title、Description、Website URL、Destinations、Schedule、Saved/Processing 状态。

建议把 `Publish to` 改为 **Destinations**；它不仅表示平台，还包含 Account 与 Board/Page。

所有生命周期卡片共享同一个 Details 入口。Alt text、Tagged topics、Tag products、AI disclosure、Comments、Similar products 和平台高级字段放入 Details，不占据卡片主区。

Generate copy 与 Regenerate image 都是轻量 secondary action。连接状态展开不能改变卡片宽度。

## 5. 输入与产品关联

### 5.1 产品选择

所有产品来源进入统一 Canonical Product Picker。选择产品后自动带入图片和公开 URL；Website URL 仅在为空时自动填写，绝不覆盖手动链接。

如果产品没有可公开访问的 URL，应明确提示 Link unavailable，而不是构造虚假链接。Shopify Admin URL、私网 URL 和非 HTTP(S) 链接不能进入最终发布字段。

### 5.2 Link to Pin

Link to Pin 最小闭环建议：

1. 粘贴 URL。
2. 提取标题、描述、主图候选和最终出站链接。
3. 过滤评论图、推荐商品、广告与低清图片。
4. 用户确认图片和商品信息。
5. 一次生成三个不同方向。
6. 进入普通 Draft 卡片继续编辑和自动排期。

它必须扩展现有 `urlImportService` 链，不再新建第二套 parser/backend。

安全门：API 鉴权、按用户限流、DNS 与连接地址校验、每次重定向复核、IPv4/IPv6 私网阻断、流式下载上限、错误与 API key 脱敏。Etsy public listing 必须等这些门通过后再接入。

## 6. 多图产品逻辑

### 6.1 VibePin 内容模型

一条 Content 支持 1 到 N 张媒体，第一张为 Cover。Title、Description、Website URL、Destinations 和 Schedule 属于整条 Content。

### 6.2 上传交互

- 单图：直接创建 Draft。
- 多图：弹出轻量 Publish together / Publish separately 选择。
- Draft 内 Add images：直接加入当前 Content，不再次询问。
- `Don't show this again`：保存为未来顶部多图上传默认值，并可在 Settings > Create Pins 修改。

### 6.3 平台能力降级

VibePin 必须把“Content 有多张媒体”和“某平台支持何种发布格式”分开。

建议发布适配规则：

- 平台支持目标多图格式：按一个 destination 发布多图。
- 平台只支持单图：在发布前让用户选择拆分为多条，或只发布 Cover。
- 平台能力未知：阻断并显示 Verify platform support，不能默默尝试。
- 比例或数量不兼容：在编辑阶段标出具体媒体并提供 Review & crop。

在 Pinterest API 实测通过前，界面不应承诺 `Pinterest Carousel`。可使用中性产品术语 `Multi-image content`，最终发布格式由 destination 决定。

## 7. Batch Edit 最终建议

### 7.1 采用全屏表格式工作区

本轮调研后建议明确选择 **全屏表格式 Batch Edit**，不采用塞满字段的 modal。

理由：

- 批量编辑的对象是多行重复字段，表格更适合横向比较。
- 用户需要同时看到图片、Title、Description、Website URL、Destinations 和 Schedule。
- 当前 `80631ec9` 已有全屏工作区和 35 条规划测试，不需要再造一套交互。
- Modal 在窄宽度下会迫使字段纵向堆叠，反而比当前卡片更累赘。

### 7.2 入口保持轻量

- 每张卡片显示选择框。
- 选中任意内容后显示轻量工具栏。
- Batch edit 只在选中至少 2 条时显示。
- 工具栏只包含数量、Batch edit、Publish、Delete、Clear。
- 全屏工作区直接自动保存单元格修改，不再增加 Preview / Apply / Save 三层确认。

### 7.3 批量执行前预览影响

Schedule、Publish、Replace product、Replace URL 等高影响动作需显示本次会修改多少条、跳过多少条及原因。结果必须逐条可定位。

## 8. Schedule 与 Plan 最终建议

### 8.1 Schedule 默认自动分配

用户点击 Schedule 后，系统直接使用目标账号的下一个可用 SmartSchedule 时段。自定义时间放在小号时钟入口中。

这一策略同时符合用户批注和 Tailwind 已验证的心智：用户主要想“加入计划”，不是每次都做日历决策。

### 8.2 Plan 使用同一个控制按钮

同一个按钮完成以下状态转换：

1. Hover / focus：临时覆盖打开。
2. Click：固定显示。
3. 再次 click：取消固定并关闭。

不能额外再放第二个关闭按钮。Escape 只关闭未固定覆盖层；固定状态持久化。

### 8.3 固定后的宽度规则

当前实现使用 344px Plan 和 `minmax(248px, 1fr)` 卡片。产品验收不能只检查组件宽度，还要检查最终列数。

建议规则：

- 固定 Plan 后，内容区必须至少容纳 2 列卡片。
- 如果当前窗口不足以满足 2 列，Plan 自动退化为覆盖层，不允许固定后只剩 1 列。
- 超宽屏可使用 3–4 列；Plan 不需要无限变宽。
- Tablet 使用 Drawer；Mobile 使用全屏 Plan，不依赖 hover。

### 8.4 Plan 内容

Plan 采用一周七天视图，显示时间、缩略图、平台和 Scheduled / Published / Failed。未来排期优先，已发布历史弱化。Schedule 成功后：Plan 打开则定位并高亮；Plan 关闭则按钮显示 `+N`，不强制展开。

## 9. Publish 与失败恢复

### 9.1 异步结果

状态必须区分 accepted / publishing / published / failed。任务被 VibePin 接受不等于平台发布成功。

一次 Publish 只显示一次即时反馈。完整 destination list 从第一帧就出现，每个平台随后独立更新。成功平台保留外部链接；失败平台提供独立动作。

### 9.2 按钮命名

建议最终统一为：

- 加入自动排期：Schedule
- 保存 Scheduled 修改：Save changes
- 立即执行发布：Publish
- 查看历史发布：View results
- 复用已发布内容：Edit for reuse

不常驻显示 Publish now / Publish again；如果从 Scheduled 立即发布，在确认文案里说明会跳过原排期。

### 9.3 Failed 与 Needs attention

Failed 保留与其他生命周期一致的卡片结构，只增加问题类型、客户可读原因和动作。不能变成只有错误文字的另一套页面。

失败原因采用稳定分类：

- Board unavailable → Choose board
- Account disconnected → Reconnect
- Image dimensions/aspect ratio → Review & crop
- Invalid link → Edit link
- Generation failed → Try again / Edit prompt
- Temporary provider failure → Retry

严禁显示 raw provider error、HTTP 状态、ID、token 或响应体。

图片加载失败时依次尝试当前媒体、产品图、参考图或父内容媒体；最终使用品牌化兜底图。不能出现白块、永久 Spinner 或 `No image`。

## 10. 差异化生成与编辑路线

### 10.1 一次多方向 Fresh Pin

建议默认一次生成 3 个方向：

- Product / scene：商品或主题作为主视觉。
- Text-led：强标题、CTA 和信息层级。
- Collage / list：多图、步骤或卖点组合。

每个方向内部可生成 1–2 个 composition variant。必须复用现有 creative direction 和 output variant 类型，避免新建第二套方向模型。

### 10.2 轻量文字图层优先

第一期不做 Canva 式自由画布。建议支持：

- 编辑图上标题、CTA 和副文案。
- 修改字体、颜色、对齐和安全区位置。
- 应用 Brand Kit。
- 拼写、溢出和移动端可读性提示。
- 保存版本并导出为最终 raster 图片。

文字图层按 `mediaId` 拥有，坐标标准化，发布前必须扁平化成公开可访问的最终媒体。仅在浏览器上叠 DOM 文字不构成可发布结果。

### 10.3 AI 局部编辑后置

第二期加入锁定商品/Logo/人物，只允许修改背景或选区。交互可借鉴 Canva Magic Edit 的“刷选区域 + 输入修改要求”，但必须增加商品保真与版本回退。

## 11. Brand Kit 产品决策

建议 MVP 为 **每个 workspace 一个激活中的 Brand Kit**，数据模型从第一天支持未来多个 kit，不立即开放复杂的多品牌管理 UI。

MVP 内容：

- Logo 引用，不把二进制直接塞入配置。
- 主色、辅色和文本色。
- Heading / Body 字体角色。
- CTA 样式。
- 默认边距和安全区。
- 品牌语气与禁用词。

应用优先级：用户本次手动修改 > 当前 Content 覆盖 > Brand Kit > 系统默认。用户修改 Brand Kit 不追溯改写已 Scheduled 或 Posted 内容。

## 12. 发布前检查器

不新建第二套 preflight engine。扩展现有 readiness、media rules、destination validation 和 publish error mapping，形成一个用户可见的 Review 汇总。

第一期检查：

- 是否有可发布媒体。
- 平台图片数量、比例和格式。
- 文字是否溢出安全区。
- Title / Description / Alt text 的当前平台限制。
- Website URL 格式和可达性。
- Pinterest Account 与 Board 是否有效匹配。
- 多平台 destination 是否完整。
- AI disclosure 是否需要确认。

阻断规则仅限确定会失败或明显违规的情况；可读性、重复度和品牌一致性先做提示，不直接禁止发布。

## 13. 当前实现：保留、修正、扩展

### 13.1 保留

- `80631ec9` 的 Content / destination / media / lifecycle 主模型。
- StudioPlanSidebar 的 hover、pin 和单按钮交互。
- 自动 Schedule 和 Plan `+N` / highlight 信号。
- Canonical Product Picker 与空 URL 自动带入。
- 最近 Pinterest Board 按目标账号预填。
- 失败媒体候选链和 PinFallbackArtwork。
- 客户错误安全映射。
- 全屏 Batch Edit。
- per-destination publish results 和 retry 范围。

### 13.2 必须修正

1. `StudioBoard.handleAiGenerate` 不能再调用会改变状态的 `enqueueGeneration()` 探测模式后再调用一次。一次点击只允许一个真实执行或入队。
2. Batch edit 从当前 `selectedIds.size > 0` 改为只有 `selectedIds.size >= 2` 才显示入口。
3. 固定 Plan 的响应式验收增加“至少两列”，窄窗口自动回退覆盖层。
4. 清理残余 `No image` / `No board` / QA Board / Studio Board V2 / raw internal error 测试文案。
5. 统一所有卡片的 Details、轻量 AI action、产品摘要和 destination 标题。
6. 产品连接展开时保持卡片固定宽度。
7. 对 Pinterest 多图能力加明确 capability gate，删除未经验证的 Carousel 承诺。

### 13.3 后续扩展

- Link to Pin 提取质量与 Etsy public listing。
- Fresh Pin 多方向合同和生成流程。
- 轻量文字图层与拼写/裁切检查。
- Workspace Brand Kit。
- 商品锁定与局部 AI 编辑。
- 商品价格/标题/链接变化提醒。

## 14. 推荐实施分期

### Phase 0：基线与 P0

1. 在精确 `80631ec9` 的隔离 worktree 完成基线收敛。
2. 修复生成重复执行并补编排级计数测试。
3. 移植 Batch edit 至少两条才显示的规则。
4. 验证当前安全 worker 的 outbound guard，Create Pin 不重复实现。

完成标准：主脏工作树未被覆盖；一次点击只有一次生成；聚焦测试、Studio tests、typecheck 通过。

### Phase 1：Create / Edit / Schedule 主流程

1. 收敛创建入口和卡片字段。
2. 产品自动带入图片与 URL。
3. 多图上传轻量选择和媒体比例提示。
4. 全屏 Batch Edit 与 impact preview。
5. 自动 Schedule、小号 Custom time、Plan 单按钮和响应式固定。
6. Failed 卡片、兜底图、客户错误与 per-destination actions。

完成标准：桌面、Tablet、Mobile 浏览器 QA；Draft/Scheduled/Posted/Failed/All 状态一致；刷新后发布结果可恢复。

### Phase 2：差异化 MVP

1. Link to Pin 智能图片提取。
2. 三方向 Fresh Pin。
3. 轻量文字图层、拼写、安全区和移动端预览。
4. Workspace Brand Kit。
5. 统一 Review / Preflight。

完成标准：同一个 URL 能产出三个视觉和文案方向明显不同、可继续编辑、通过检查并自动排期的 Draft。

### Phase 3：高级编辑与商品同步

1. 商品/人物/Logo 锁定。
2. 选区局部重绘和版本回退。
3. 商品价格、标题、库存和链接变化提醒。
4. CSV、多 URL、店铺列表批量生成。

## 15. 需求优先级

| 优先级 | 功能 | 本轮结论 |
|---|---|---|
| P0 | 生成单次执行、基线收敛、状态与错误安全 | 立即处理 |
| P0 | Plan 固定后至少两列、Batch edit 至少两选 | 立即处理 |
| P1 | 卡片、产品关联、多图、自动 Schedule、Plan、Failed recovery | 当前产品主线 |
| P1 | Link to Pin、智能图片提取、三方向 Fresh Pin | 差异化 MVP |
| P1 | 文字图层、Brand Kit、发布前检查 | 差异化 MVP |
| P2 | 商品锁定、局部 AI 编辑、商品变化提醒 | 主流程稳定后 |
| P2 | CSV / 多 URL / 店铺级批量 | 依赖 Link to Pin 稳定 |
| 暂不做 | 完整 Canva 式自由画布 | 成本高且偏离核心优势 |
| 暂不做 | 未验证的 Pinterest Carousel 承诺 | 官方/API 能力不明确 |
| 禁止 | 规避 AI modified 标签 | 平台与信任风险 |

## 16. 关键验收标准

1. 默认进入 Drafts；Plan 不在生命周期 Tab。
2. 卡片无 hover 展开，所有生命周期均有一致 Details。
3. 顶部创建入口轻量；Batch edit 不常驻。
4. 选择产品后图片和公开 URL 正确带入，不覆盖手动 URL。
5. 多图上传只在顶部多图场景询问一次。
6. 多图平台能力不明确时不默默发布。
7. Batch edit 仅在至少两选时出现，并使用全屏表格工作区。
8. Schedule 默认自动分配；自定义时间是次级入口。
9. 同一个 Plan 按钮完成 hover、固定和关闭。
10. 固定 Plan 后 Draft Grid 至少两列；窄窗口退化覆盖层。
11. 图片失败不出现白块、永久 Spinner 或 `No image`。
12. 无 Board 时优先最近有效 Board；否则显示 Choose board。
13. 客户界面无 raw technical error。
14. 发布从第一帧列出全部 destinations，结果独立更新。
15. Retry 不重复发布已成功 destination。
16. 一次生成点击只发生一次真实执行或入队。
17. 文字图层最终能扁平化为可发布图片。
18. AI disclosure 透明提示，不提供规避能力。

## 17. 尚需产品确认但不阻塞 Phase 0

1. Workspace 是否需要在第一版支持多个 Brand Kit；本报告建议先一个 active kit、模型可扩展。
2. Fresh Pin 默认是否固定三个方向；本报告建议场景型、文字型、拼贴/清单型。
3. Publish preflight 中哪些提示未来可以升级为阻断；本报告建议首版只阻断确定失败项。
4. Etsy public listing 的商业优先级；技术上必须晚于 URL Import 安全门。

## 18. 最终结论

Create Pin 当前最该做的不是继续堆按钮，而是把“来源、变体、编辑、检查、排期、结果”连成一个可恢复的工作流。

最先交付的是可靠且轻量的 Create / Edit / Schedule / Recover；最能拉开差距的是 URL to Pin + 三方向 Fresh Pin + 可编辑文字层 + 自动排期。Plan、Batch Edit 和 Failed UI 都应服务这条主线，而不是各自成为独立复杂系统。
