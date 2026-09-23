# VibePin Create Pin 已讨论需求报告

> 版本：2026-08-30 阶段稿  
> 用途：先还原用户批注、既有 PRD、Claude 实现结论、Zcode 研究建议与代码审计共同形成的 Create Pin 需求基线。  
> 范围：Create Pins、Plan、Schedule、Publish、Failed recovery。Insights 明确不在本报告范围。

## 1. 结论先行

Create Pin 本轮不是重新做一套生成器，而是把现有能力收敛成一个可靠的内容工作台：用户能快速创建或导入内容，在同一屏编辑多条 Pin，自动安排发布时间，并在发布失败后看懂原因、直接修复。

产品主线应分成三层：

1. **当前必须完成的核心工作流**：Draft 编辑、多图、多选与批量操作、发布目标、自动排期、Plan、异步发布结果、失败恢复。
2. **已有能力的补齐与纠错**：产品选择自动带入、图片兜底、最近 Board、状态一致性、用户可读错误、生成只执行一次。
3. **调研支持但尚未批准进入当前实现的扩展能力**：Link to Pin 增强、多方向 Fresh Pin、Brand Kit、可编辑文字图层、发布前质量检查、AI 局部编辑。

当前最安全的实现基线是 `integrate/create-pins-on-fanout-0827@80631ec9`。它已经包含较完整的媒体、发布目标、生命周期、失败恢复、Plan 和批量编辑模型。当前脏主工作树只能逐条移植尚未被吸收的 UI 意图，不能整体覆盖基线。

## 2. 核心用户流程

用户进入 Create Pins 后的默认流程应为：

1. 通过 **Generate AI Pin、Upload images、Choose product、粘贴 URL** 创建内容。
2. 内容进入 Drafts；一条 Content 可以包含 1 到 N 张媒体。
3. 用户在竖向卡片中快速编辑标题、描述、Website URL、发布目标和排期。
4. 用户可多选内容后进行批量编辑、发布、删除或清除选择。
5. 点击 Schedule 后，系统自动放入下一个可用时段；自定义时间是次级入口。
6. 如果 Plan 已打开，刚排期的内容在对应时段短暂高亮；Plan 关闭时只显示轻量 `+N` 反馈，不强行展开。
7. 发布任务被接受后，用户可以离开当前界面；各平台结果随后独立更新。
8. 失败内容保留原图或兜底图、可读原因和直接动作；已经成功的平台不得被重复发布。

## 3. Create Pins 信息架构

### 3.1 生命周期

顶部状态统一为：

- Drafts
- Scheduled
- Posted
- Failed
- All

默认进入 Drafts。Plan 不是内容状态，不能混入这组 Tab。

一条内容在 Draft、Scheduled、Posted 和异常处理过程中始终是同一条 Content。Failed 是需要处理的工作视图，不抹掉内容已经 Scheduled 或部分 Posted 的事实；All 只是聚合视图，不创建副本。

### 3.2 卡片默认形态

Draft 卡片默认可编辑，不使用鼠标悬浮后慢慢展开的交互。桌面采用窄而高的竖向卡片和多列布局，以 2:3 媒体为视觉中心。

默认展示：

- Media
- Title
- Description
- Website URL
- Destinations（建议替换界面标题 `Publish to`）
- Schedule
- Saved / Processing / Failed 等必要状态

低频字段放进统一的 Details：Alt text、Tagged topics、Tag products、AI disclosure、Comments、Similar products 和平台特有设置。所有卡片都必须提供同一套 Details 入口，不能有的有、有的没有。

### 3.3 AI 与创建入口

页面顶部保留三个并列但轻量的入口：Generate AI Pin、Upload images、Choose product。Batch edit 不属于常驻创建入口。

卡片内 Generate copy 与 Generate AI Image / Regenerate image 都使用 compact secondary 样式，不能占据整行主按钮，也不能因为展开连接状态而让卡片宽度变化。

## 4. 产品选择与 Website URL

用户从自己的产品库、社区产品库、Shopify、Etsy 或 URL Import 选择产品时：

- 自动带入所选产品图片。
- 自动带入产品公开 URL 到 Website URL。
- 只有 Website URL 为空时才自动填写，绝不覆盖用户手动输入的链接。
- UI 不显示不可编辑的 `No linked product` 占位框；未选择时应提供 Choose product，选择后显示产品摘要和替换/移除入口。
- 旧的 ProductPickerModal 不应恢复；所有来源应进入统一的 Canonical Product Picker。

## 5. 多图内容

### 5.1 内容模型

一条 Content 可以包含多张媒体；这些媒体共享 Title、Description、Website URL、Destinations 和 Schedule。第一张媒体默认是 Cover，用户可以新增、移除、替换、排序和更换 Cover。

### 5.2 多图上传

上传一张图片时直接创建一条 Draft，不弹窗。

一次上传两张及以上时，询问用户：

- **Publish together**：组成一条多媒体 Content。
- **Publish separately**：每张图片成为一条独立 Content。

弹窗必须比现有大图方案更轻：只保留两个清晰的视觉选项、一个简短说明、Don't show this again、Cancel 和 Continue。不能把 Pinterest、Instagram 的完整说明重复铺两遍。

Settings 可保存用户的默认选择，但只影响未来从页面顶部上传多图的行为。用户已经在某个 Draft 内点击 Add images 时，不再询问，直接加入当前 Content。

### 5.3 多图兼容性

VibePin 的内容模型允许多图，但实际发布格式必须按目标平台能力转换。Pinterest 官方网页端当前一次选择多张图片会创建多个独立 Pin；不能把“多图 Content”直接等同于一定能通过 API 发布 Pinterest Carousel。

对要求统一比例的目标格式，在编辑阶段即检查尺寸/比例并标出具体问题媒体，提供 Review & crop；不能等发布失败后才告知。

## 6. 多选与批量编辑

- 每张卡片都有清晰可见的选择框。
- 顶部 Select all 只选择当前筛选范围内可见内容。
- 选中至少一条后出现轻量批量操作栏。
- **Batch edit 只在选中至少两条内容后显示。**
- 工具栏仅显示选中数量、Batch edit、Publish、Delete、Clear selection，不内嵌完整表单。

批量编辑建议采用两层结构：

1. 轻量工具栏负责进入与常用动作。
2. 点击 Batch edit 后进入专用表格式工作区或成熟 Drawer，逐行保持图片、Title、Description、Website URL、Destinations 和 Schedule 可见；不要在原卡片区弹出一个塞满字段的大弹窗。

批量操作必须先做 impact preview：哪些内容可执行、哪些缺 Board/账号/媒体条件、哪些会跳过。一次处理 10 条时，8 条成功、2 条失败必须逐条可定位，不能只显示一个全局失败。

## 7. 发布目标与 Board

一条 Content 可以同时选择 Pinterest、Instagram 和 Facebook，每个平台记录独立的 account、Board/Page 和结果。

- 只有一个可用账号时不增加无意义的账号选择器。
- 有多个账号时必须由用户明确选择，不能自动取第一个。
- Pinterest Board 必须跟随 Pinterest Account；切换账号后不能保留另一账号的 Board。
- 对没有 Board 的现有内容，优先预填该账号最近一次有效选择的 Board。
- 如果确实没有任何可复用 Board，显示 Choose board / Select a board，而不是 `No board`。
- 最近 Board 只是预填建议，用户仍能修改。

Settings 中的 Default publishing destinations 仅影响未来新内容，不得改写已存在 Draft、Scheduled 或 Posted 内容。

## 8. Schedule 与 Plan

### 8.1 Schedule

主流程不要求用户先选日期和时间。点击 Schedule 后，系统自动分配到该账号 SmartSchedule 的下一个可用时段。

自定义时间仅作为小号次级入口，例如时钟图标或 `Custom time` 链接，不能与 Schedule 主按钮并列成同等权重。Scheduled 编辑页只保留一个时间修改入口。

### 8.2 Plan 打开、固定与关闭

Plan 使用**同一个按钮**控制，不出现“打开”和“关闭”两个独立按钮：

- 鼠标悬浮或键盘聚焦右侧触发区：Plan 临时覆盖出现。
- 点击同一个按钮：Plan 固定在右侧。
- 再次点击同一个按钮：取消固定并关闭。
- 固定状态持久化。

未固定时，Plan 覆盖在卡片上方，不改变 Grid 宽度；固定时，Grid 重新排布，不能只剩一列卡片。当前建议 Plan 固定宽度约 320–360px，同时保证常见桌面宽度至少保留两列可读卡片，宽屏目标为三列以上。

### 8.3 Plan 内容

Plan 是七天周视图，而不是简单列表。至少显示日期、时间槽、缩略图、平台标识和 Scheduled / Published / Failed 状态；提供前后周、Today 和 Open full planner。

右侧 Plan 负责快速查看与即时反馈；完整 Plan 页面负责跨周拖拽、复杂排程和高级操作。

## 9. 发布状态与结果

发布必须使用异步任务语义：

- accepted：VibePin 已可靠保存发布任务与完整目标列表。
- publishing：平台正在处理。
- published：平台返回明确成功并保存外部 ID、URL 和时间。
- failed：该发布目标失败且需要处理。

`accepted` 绝不能显示为 Published。一次 Publish 操作最多显示一次即时反馈，例如 `Publishing started. Results will update automatically.`；不得按平台连续弹出多个成功 Toast。

Publish results 从第一帧就列出本次所有目标，随后独立更新。只有成功目标显示 View on Pinterest / Instagram / Facebook；删除全局 View Pin。

Retry 默认只处理失败或未完成的目标，不能重复发布已经成功的平台。

## 10. Failed 与 Needs attention

Failed 内容继续使用与 Drafts、Scheduled、Posted 相同的内容卡结构，而不是变成另一种陌生列表。卡片增加：

- Generation failed 或 Publishing failed 类型。
- 一行安全、可行动的客户语言原因。
- 与原因匹配的动作：Try again、Edit prompt、Reconnect、Choose board、Review & crop、Edit 或 Retry。

禁止展示 HTTP 状态码、数据库 ID、Job ID、token、上游响应或任何 raw error。

媒体展示规则：

- 原图仍可用时保留原图。
- 生成失败但有产品图/参考图时，使用最可信来源作为兜底。
- 所有图片解码失败时使用带品牌感的渐变/图形兜底，不显示白块、无限 Spinner 或 `No image`。

部分成功时，内容仍是 Posted，同时带 Needs attention，并可出现在 Failed 工作视图。成功目标与外部链接必须保留。

## 11. Scheduled 与 Posted

Scheduled 和 Posted 默认可比 Draft 更紧凑，但必须提供明确的 Details/Edit 入口，字段与 Draft 保持同源。

Scheduled 的主动作是 Save changes；Publish now 是次级动作，并明确说明将取消等待原排期、立即创建发布任务。

Posted 保留上一轮每个平台的发布结果。用户编辑的是当前 Content，用于后续复用或新的发布操作，不会修改已经发布到平台的历史帖子。

## 12. 已发现的实现阻断项

### P0：AI 生成可能重复执行

`80631ec9` 的 `StudioBoard.handleAiGenerate` 把会改变状态的 `enqueueGeneration()` 当作运行模式探针，后续又执行/入队一次。一次点击可能造成两次生成、重复任务或孤儿任务。必须先改为一次点击只发生一次 inline execution 或一次 worker enqueue，并增加计数型编排测试。

### URL Import 安全门

现有 URL Import 链已经存在，不应再造第二套后端。Etsy/WooCommerce 增强之前必须先满足认证、按用户限流、DNS/IPv4/IPv6/重定向 SSRF 防护、流式响应上限和错误脱敏。当前安全 worker 的 outbound guard 是独占工作，不允许 Create Pin 复制实现。

## 13. 研究扩展需求的当前处置

### 可以进入产品设计

- Link to Pin 输入与智能图片选择
- 一次生成多个真正不同的 Fresh Pin 方向
- 文字作为独立可编辑图层
- Brand Kit 基础能力
- 发布前尺寸、裁切、可读性、链接和内容一致性检查
- 商品主体锁定与受控背景/局部编辑

### 暂不直接进入实现

- 新建第二套 URL parser 或 publish preflight engine
- Brand Kit 数据表、CRUD 与 Settings UI
- 完整 Canva 式自由画布
- 未确认 API 能力的 Pinterest Carousel
- 规避 AI modified 标签的任何功能
- Insights、跨平台表现分析与内容诊断

## 14. 推荐优先级

### P0

1. 修复一次点击重复生成。
2. 以 `80631ec9` 为基线完成逐文件收敛，不覆盖当前脏主树。
3. 完成状态、失败图片、失败文案、最近 Board 和 per-destination 结果一致性。
4. 验证 Pinterest 多图真实 API 能力，未验证前采用保守降级。

### P1

1. 完成卡片、Details、轻量 AI 按钮、创建入口和选择器 UI。
2. 完成多图上传选择、比例检查和 Media Strip。
3. 完成多选、Batch edit、impact preview。
4. 完成自动 Schedule 和单按钮 Plan 悬浮/固定交互。
5. 完成异步 Publish results 和 Failed recovery。

### P2

1. Link to Pin 体验与提取质量增强。
2. 多方向 Fresh Pin 合同与生成流程。
3. Brand Kit、文字图层、发布前检查器的产品设计和纯领域合同。
4. 商品锁定与 AI 局部编辑原型。

## 15. 尚需用户确认的产品决策

1. Batch edit 最终采用全屏表格式工作区，还是保留现有成熟 Drawer；建议以选中数量和屏幕宽度自适应，但只保留一个入口。
2. 多图上传 `Don't show this again` 后，默认行为在哪里修改；建议放 Settings > Create Pins。
3. Brand Kit 是每用户一个，还是支持多个品牌/工作区。
4. 多方向生成默认产出几个方向，方向是否固定为场景型、文字型、拼贴型。
5. 文字编辑首版只支持文字/颜色/图片/CTA，还是同时加入商品锁定和局部重绘。
6. 发布前检查哪些是提示、哪些可以阻断发布。

## 16. 本阶段不代表已完成开发

本报告是需求与基线收敛，不是实现完成证明。到目前为止，Zcode 的最终回复没有调用工具或检查 `80631ec9`；Claude 的 `80631ec9` 是代码基线，但仍存在 P0、真实平台发布、浏览器 QA 和产品决策门。进入开发后，每个工作包仍需隔离 worktree、明确 allowlist、独立测试和 Advisor 验收。
