# VibePin Studio 工作台改版与 URL 驱动 AI PRD v2.0

> 更新日期：2026-09-20  
> 状态：需求定稿，进入交互标注与实施拆分  
> 适用范围：Studio、Social Accounts、Insights、Schedule Plan 与共享发布能力  
> 参考原则：借鉴 Tailwind 的工作流，不复制其品牌、视觉资产、收费模型或非核心功能

## 1. Executive Summary

### 1.1 Problem Statement

当前 Studio 的创建、编辑、账号选择和排期交互分散。AI 入口重复，图片与视频动作混用，发布账号菜单会被卡片遮挡，日历默认展示过去日期，草稿与历史记录的归属也不清晰。

### 1.2 Proposed Solution

将 Studio 改为“素材卡片内编辑 + 右侧智能排期”的统一工作台。Website URL 作为 AI 创建的第一等输入；图片、文案、视频封面、发布账号和排期均在对应功能模块内完成，并复用现有 Draft、AI 与发布链路。

### 1.3 Success Criteria

| ID | 指标 | 目标 |
|---|---|---:|
| SC-01 | P0 验收用例通过率 | 100% |
| SC-02 | Stable QA 跳转到 Vercel 登录 | 0 次 |
| SC-03 | Schedule Plan 首屏出现过去日期 | 0 次 |
| SC-04 | 视频卡出现图片生成动作 | 0 次 |
| SC-05 | 用户已编辑字段被 AI 静默覆盖 | 0 次 |
| SC-06 | 发布账号菜单被卡片遮挡或裁切 | 0 次 |
| SC-07 | 不同账号或工作区之间发生 Draft / History 串读 | 0 次 |

## 2. User Experience & Functionality

### 2.1 Users And User Stories

| ID | User Story |
|---|---|
| US-01 | 作为商家，我希望输入 Website URL 后直接获得可编辑内容，减少手工搬运商品信息。 |
| US-02 | 作为内容创作者，我希望在同一张卡片完成媒体、文案、发布账号和排期设置。 |
| US-03 | 作为视频发布者，我希望在视频预览上选择封面，不看到无关的图片生成动作。 |
| US-04 | 作为运营人员，我希望日历默认聚焦今天及未来，并能快速调整每日发布数量。 |
| US-05 | 作为多账号用户，我希望草稿和历史跟随 VibePin 账号，而不是绑定当前设备。 |

### 2.2 Scope

#### P0

1. Studio 三段式布局与响应式卡片网格。
2. URL 驱动的 AI 图片和文案创建。
3. 图片卡、视频卡、比例选择和视频封面交互。
4. 发布账号选择、发布确认和排期。
5. Schedule Plan 默认日期、展开方式和每日发布数量。
6. Social Accounts 统一入口。
7. Draft 与 History 的服务端持久化。
8. Stable QA 访问修复。

#### P1

1. Insights 顶级入口与诊断页面。
2. 从 Insights 创建带上下文的新 Draft。
3. Full planner 的拖放、空槽创建和完整视图。
4. 多平台多账号额度与迁移。

#### Non-Goals

1. 不复制 Tailwind 的 CSV Import、Browser Extension、Turbo、Sites、Credits 或 Demo 模块。
2. 不重做完整视频编辑器；本期只支持视频封面。
3. 不实现广告投放、广告 ROI 或销售归因。
4. 不允许未经用户确认自动发布。
5. 不建立第二套 Draft、AI、账号、排期或发布状态。

### 2.3 Primary Flow

```text
Create with AI / Upload media
→ URL 分析或媒体上传
→ 创建 Draft 卡片
→ 编辑媒体与文案
→ 选择发布账号
→ Publish now 或 Schedule
→ Schedule Plan 查看结果
→ Insights 分析表现
```

### 2.4 FR-01 Studio Workbench

#### Layout

| 可用工作区宽度 | 主区列数 | Schedule Plan |
|---|---:|---|
| ≥1600px | 4 列 | Collapsed 或 Docked |
| 1280–1599px | 3 列；日历展开后最低 2 列 | Docked |
| 1024–1279px | 2 列 | Drawer |
| 768–1023px | 2 列；单卡不足 320px 时 1 列 | Drawer |
| <768px | 1 列 | 全高 Sheet |

主区不得限制为最多两列。活动卡可跨两列，未活动卡保持紧凑。

#### Header Fields And Buttons

| 类型 | 名称 | 规则 |
|---|---|---|
| 搜索 | Search content | 按标题、URL、Board 或状态搜索 |
| 筛选 | Status | All / Draft / Scheduled / Published / Failed |
| 筛选 | Destination | All / Pinterest / Instagram / Facebook |
| 按钮 | `Create with AI` | 打开共享 `Create AI version` 抽屉 |
| 按钮 | `Upload media` | 上传图片或视频并创建 Draft |
| 按钮 | `Bulk actions` | 仅在选中卡片后启用 |
| 按钮 | `History` | 打开当前账号与工作区的服务端历史 |
| 状态 | Selection count | 显示已选卡片数量 |
| 状态 | Save status | Saving / Saved / Waiting to sync |

#### Rules

1. 卡片网格滚动时，顶部工具栏保持可用。
2. 未活动卡不得同时挂载全部重型编辑控件。
3. 移动端的 URL 创建、AI、账号选择和日历均使用全高 Sheet。
4. 功能文字不小于 12px；主要触控目标不小于 44px。

#### Acceptance Criteria

| ID | 验收要求 |
|---|---|
| AC-01 | 1920px 下日历收起时显示 4 列，1440px 下显示 3 列。 |
| AC-02 | 390px 下为单列，字段和主动作无水平溢出。 |
| AC-03 | 搜索、筛选和批量选择可通过键盘完成。 |

### 2.5 FR-02 Content Card Editor

#### Field Order

| 顺序 | 字段 | 规则 |
|---:|---|---|
| 1 | Media preview | 显示媒体、选择框、类型和处理状态 |
| 2 | AI disclosure | 仅 AI 生成内容显示 |
| 3 | Media actions | 根据 `mediaType` 显示 |
| 4 | Website URL | 可选；为 AI 和跳转提供上下文 |
| 5 | Pin title | 按目标平台校验 |
| 6 | Description / Caption | 按目标平台生成或编辑 |
| 7 | Pinterest Board | 选择 Pinterest 时必填 |
| 8 | Recommended keywords / Tags | 可选；显示推荐来源 |
| 9 | Alt text | 可选；可由 AI 建议 |
| 10 | Publish destinations | 发布前至少选择 1 个 |
| 11 | Custom time | Schedule 时必填 |
| 12 | Primary actions | Schedule / Publish / Save status |

#### Button Matrix

| 按钮 | 图片卡 | 视频卡 | 规则 |
|---|---:|---:|---|
| Select | 显示 | 显示 | 用于批量操作 |
| More | 显示 | 显示 | Duplicate / Move / Delete |
| `Change media` | 显示 | 显示 | 替换前保留字段并确认影响 |
| `Aspect ratio` | 显示 | 显示 | 轻量 Popover |
| `Create AI version` | 显示 | 不显示 | 打开共享 AI 抽屉 |
| `Regenerate image` | 显示 | 不显示 | 复用现有图片生成任务 |
| `Edit cover image` | 不显示 | 显示 | 只位于视频主预览覆盖层 |
| `AI writing` | 显示 1 次 | 显示 1 次 | 打开共享文案面板 |
| `Schedule` | 显示 | 显示 | 目标与时间合法时启用 |
| `Publish` | 显示 | 显示 | 打开统一发布确认 |
| `Retry` | 失败时 | 失败时 | 只重试失败阶段 |

#### Media Ratio

| 媒体类型 | 选项 |
|---|---|
| 图片 | Original / 2:3 / 1:1 / 4:5 / 9:16 |
| 视频 | Original / 9:16 / 2:3 / 1:1 / 16:9 |

1. 选择后立即更新预览，不覆盖原文件。
2. 默认居中裁切；用户可拖动位置或选择 Fit。
3. 视频改比例不得改变时长、音频、封面时间点或文案。
4. 失败时保留原媒体，并显示 `Retry` 和 `Reset to original`。

#### Video Cover

| 类型 | 名称 | 规则 |
|---|---|---|
| 入口 | `Edit cover image` | 桌面 hover / focus 显示；移动端持续显示 |
| 字段 | Current frame | 大图预览当前帧 |
| 字段 | Timeline | 支持拖动和键盘微调 |
| 字段 | Suggested frames | 推荐帧缩略图 |
| 按钮 | `Use current frame` | 选择当前帧 |
| 按钮 | `Upload cover` | 能力支持时显示 |
| 按钮 | `Save cover` | 保存同一个 cover asset |
| 按钮 | `Cancel` | 放弃未保存变化 |

视频主预览下方不得出现 `Media · 1` 封面卡、`Choose cover frame` 大按钮或第二个封面入口。

#### Card Rules

1. 媒体识别完成后，按钮集合必须立即按 `mediaType=image|video` 重新计算。
2. 视频卡不得显示 `Create AI version`、`Regenerate image`、`重新生成图片` 或同义动作。
3. 每张卡只保留一个 `AI writing` 入口；标题字段旁不得重复显示。
4. AI 只自动填充空白且 `userTouched=false` 的字段。
5. AI 建议与现有内容冲突时，必须先显示差异，再允许逐字段或全部应用。
6. 保存后的封面必须在卡片、Schedule Plan、发布确认和 provider payload 中一致。
7. 折叠卡显示媒体、标题、目标、状态和主动作；展开卡显示完整字段。

#### Save And History

| 状态 | 显示条件 |
|---|---|
| Saving | 正在写入服务端 Draft |
| Saved | 服务端确认保存成功 |
| Waiting to sync | 离线或服务端保存失败 |

不得显示 `Saved to this device` 或“已储存到这台装置”。本地只保存缓存和待同步队列；Draft 与 History 以 VibePin 账号和工作区的服务端数据为准。

#### Acceptance Criteria

| ID | 验收要求 |
|---|---|
| AC-04 | 图片卡与视频卡显示正确的按钮集合，媒体替换后无旧动作残留。 |
| AC-05 | 视频封面入口只出现在主视频预览覆盖层。 |
| AC-06 | 同一封面在卡片、排期、发布确认和最终发布数据中一致。 |
| AC-07 | 每张卡仅有 1 个 AI 文案入口。 |
| AC-08 | 同一账号跨设备可恢复 Draft 与 History；不同账号不能串读。 |

### 2.6 FR-03 AI Creation And Copy

#### Shared Entry Points

| 入口 | 位置 | 初始上下文 |
|---|---|---|
| `Create with AI` | Studio 顶部 | 空白 Setup，Website URL 自动聚焦 |
| `Create AI version` | 图片卡 | 预填当前图片、URL、文案和 Draft ID |
| `Regenerate image` | 图片卡 | 预填原 Setup 和当前图片 |

三个入口复用同一个 `Create AI version` 抽屉、Setup schema、生成服务、额度校验、占位卡、失败恢复和审计记录。不得新增平级的 From URL / From product / From media 三套流程。

#### URL Flow

```text
输入 Website URL
→ Analyze URL
→ 展示 Page summary 与 Extracted media
→ 选择 Primary image 和 Reference images
→ 设置 Creative direction
→ Generate
→ 创建 N 个 Draft 占位卡
→ 结果逐张回填
```

系统可在后台识别页面类型，但不得显示商品页提示卡、阻断弹窗或站外设置引导。

#### Image Generation Fields

| 字段 | 规则 |
|---|---|
| Website URL | 可选；保留原始输入 |
| Page summary | 只读；展示主体和事实摘要 |
| Primary image | 必填；来自 URL、卡片或上传 |
| Additional images | 可选；辅助主体一致性 |
| Style references | 可选；只影响风格，不改变主体事实 |
| Creative direction | 可编辑 |
| Style / Scene / Composition / Mood | 复用现有选项 |
| Model | 使用当前可用模型 |
| Quantity | 继承当前产品限制 |
| Aspect ratio | 默认 Pinterest 推荐比例 |
| Diversity | 控制结果差异程度 |

#### Image Generation Buttons And States

| 类型 | 名称 | 规则 |
|---|---|---|
| 按钮 | `Analyze URL` | URL 合法时启用 |
| 按钮 | `Add images` | 添加主体图 |
| 按钮 | `Add references` | 添加风格参考 |
| 按钮 | `Generate directions` | 生成 3 个不同方向 |
| 按钮 | `Generate` | Setup 合法且额度通过后启用 |
| 按钮 | `Cancel generation` | 仅在可安全取消阶段显示 |
| 按钮 | `Retry failed` | 只重试失败结果 |
| 状态 | Analyzing / Ready / Partial / Failed | URL 分析状态 |
| 状态 | Generating N items | 显示总数、成功数和失败数 |

#### AI Writing Fields And Buttons

| 类型 | 名称 | 规则 |
|---|---|---|
| 字段 | Content purpose | Featured product / Promotion / Behind the scenes / Lifestyle / Informational |
| 字段 | Topic or product | 由 URL、媒体分析或卡片上下文预填 |
| 字段 | Keywords or phrases | 可选 |
| 字段 | Call to action | 可选；结合目标 URL |
| 字段 | Language | 默认工作区语言 |
| 字段 | Destination | Pinterest / Instagram / Facebook |
| 字段 | Existing copy handling | Fill empty fields / Suggest replacements |
| 按钮 | `Generate copy` | 输入合法时启用 |
| 按钮 | `Regenerate` | 保留输入并生成新版本 |
| 按钮 | `Apply this field` | 只应用当前字段 |
| 按钮 | `Apply all suggestions` | 应用前显示覆盖范围 |
| 按钮 | `Keep current` | 保留已有内容 |

#### AI Rules

1. 生成前保存主体名称、卖点、材质、颜色、结构、数量和文字标识。
2. 用户确认 Primary image 与主体数量后，冻结不可改变的主体事实。
3. Generate 后立即创建对应数量的占位卡。
4. 未通过主体一致性、结构、文字和明显 AI 痕迹检查的结果不得进入发布。
5. 失败结果可单独重试；成功结果和 Setup 必须保留。
6. AI 生成内容保留 `AI-generated` 底层状态，视觉标签关闭也不得删除来源记录。
7. AI 文案失败不得清空现有字段或阻止手动编辑。

#### Acceptance Criteria

| ID | 验收要求 |
|---|---|
| AC-09 | 三个 AI 入口使用同一组件、状态和后端任务。 |
| AC-10 | URL 分析后直接进入摘要和素材确认，不出现额外引导。 |
| AC-11 | 生成 N 张时立即出现 N 个占位卡，并逐张回填。 |
| AC-12 | 关闭、刷新或失败后可恢复 URL 分析与 AI Setup。 |
| AC-13 | 用户修改过的字段不会被 AI 静默覆盖。 |

### 2.7 FR-04 Publishing Destination

#### Fields

| 字段 | 规则 |
|---|---|
| Pinterest destination | 选择准确账号和 Board |
| Instagram destination | 选择准确 publishing identity |
| Facebook destination | 选择准确 Page |
| Publish mode | Publish now / Schedule |
| Schedule time | Schedule 时必填，使用工作区时区 |
| Media preview | 使用当前媒体和当前视频封面 |
| Copy preview | 按平台展示最终标题或 Caption |
| Validation issues | 按 destination 展示不可发布原因 |

账号选项必须显示平台图标、头像、display name、username 或脱敏唯一 ID，以及连接状态。

#### Buttons And States

| 类型 | 名称 | 规则 |
|---|---|---|
| 按钮 | `Select publishing destinations` | 未选择目标时显示 |
| 按钮 | `Publish now` | 所有必填字段合法时启用 |
| 按钮 | `Schedule` | 目标和时间合法时启用 |
| 按钮 | `Back to edit` | 返回卡片并保留选择 |
| 按钮 | `Retry failed destinations` | 只重试失败平台 |
| 状态 | Publishing | 分平台显示进度 |
| 状态 | Partial success | 成功平台不重发 |
| 状态 | Unknown | 先查询 provider，再决定是否重试 |

#### Account Menu Rules

1. 账号菜单通过共享 Portal / Popover 挂载到卡片滚动容器之外。
2. 菜单层级高于卡片、Sticky 顶栏、选择框和媒体操作层。
3. 下方空间不足时自动向上展开；高度超出视口时内部滚动。
4. 页面滚动、卡片展开或窗口变化时，菜单跟随触发按钮重新定位。
5. 选项整行可点击，并支持方向键、Enter、Escape 和 Tab。
6. 选择后立即显示平台、账号名和唯一身份摘要。
7. 无可用账号时显示 `Connect account`；连接失效时显示 `Reconnect`。
8. 未选择目标时不得默认 Pinterest、Board 或账号。

#### Acceptance Criteria

| ID | 验收要求 |
|---|---|
| AC-14 | 账号菜单不被当前卡片、相邻卡片或滚动容器遮挡。 |
| AC-15 | 鼠标、键盘和触控均可选择账号。 |
| AC-16 | 刷新后保留已选 identity；不同账号不能读取彼此的选择。 |
| AC-17 | Partial success 只重试失败平台。 |

### 2.8 FR-05 Schedule Plan

#### Display States

| 状态 | 规则 |
|---|---|
| Collapsed | 右边缘显示竖向计划把手，整块区域可点击 |
| Docked | ≥1280px 与主区并排，不覆盖卡片 |
| Drawer | <1280px 从右侧打开 |
| Full planner | 展示未来周、日、列表和未排期内容 |

#### Fields And Buttons

| 类型 | 名称 | 规则 |
|---|---|---|
| 字段 | Date range | 显示开始和结束日期 |
| 字段 | Day column | 日期、星期和已排数量 |
| 字段 | Scheduled item | 缩略图、标题、时间、渠道和状态 |
| 字段 | Empty slot | 可接收拖放或打开排期 |
| 字段 | Unscheduled count | 显示未排期 Draft 数量 |
| 字段 | Scheduled count | 显示当前 7 天已排数量 |
| 字段 | Daily publishing average | 标题区显示“每天平均发布 X 条” |
| 按钮 | `Expand calendar` | 整个竖向把手均可触发 |
| 按钮 | `Collapse calendar` | 收回侧栏 |
| 按钮 | `Next 7 days` | 查看未来日期 |
| 按钮 | `Today` | 回到今天开始的 7 天 |
| 按钮 | `View past` | 显式进入历史模式 |
| 按钮 | `Back to today` | 退出历史模式 |
| 按钮 | `Expand to full planner` | 仅放在右上角 |
| 按钮 | `Collapse to side panel` | 仅放在完整计划右上角 |
| 按钮 | `Schedule content` | 在空槽或内容卡打开排期 |

底部不得显示 `Open full planner` 或“开启完整计划”。

#### Date Rules

1. 首次打开显示 Today 至 Today + 6 days。
2. 默认视图不按自然周回退到周一。
3. Docked、Drawer 和 Full planner 的初始视口均不得显示过去日期。
4. 今天列保留今天已排内容。
5. 默认模式不提供向过去翻页；查看历史必须点击 `View past`。
6. 历史模式默认显示截至昨天的前 7 天，并提供 `Back to today`。
7. 日期边界按工作区时区计算。
8. 例如周日 23:00 打开，第一列仍为当天周日，后续为周一至周六。

#### Smart Schedule

| 类型 | 名称 | 规则 |
|---|---|---|
| 字段 | Daily post goal | 1–10 条/天；套餐可限制上限 |
| 字段 | Workspace time zone | 只读 |
| 字段 | Eligible days | 默认每天；Full planner 可配置 |
| 状态 | Smart scheduled | 可随目标变化重新分布 |
| 状态 | Manually locked | 不参与自动移动 |
| 按钮 | `每天平均发布 X 条` | 点击打开轻量选择器 |
| 按钮 | `Undo` | 30 秒内撤销本次重排 |

选择新数量后立即应用，不增加 Save 按钮。系统从今天的下一个可用时段开始补齐，只移动 Smart scheduled 内容；已发布和 Manually locked 内容保持不变。当天槽位不足时顺延到未来，不得写入过去。Draft 不足时只更新目标和空槽，不创建虚假内容。

#### Acceptance Criteria

| ID | 验收要求 |
|---|---|
| AC-18 | 首屏始终显示今天开始的连续 7 天。 |
| AC-19 | 过去日期仅通过 `View past` 进入。 |
| AC-20 | 右侧把手的图标、文字和空白区域均可点击，并支持 Enter / Space。 |
| AC-21 | 完整展开和折叠按钮只位于右上角。 |
| AC-22 | 修改每日数量后立即重排，不移动锁定或已发布内容。 |
| AC-23 | 重排不得创建重复 destination job。 |

### 2.9 FR-06 Social Accounts

Settings 只保留一个 `Social accounts` 入口，各平台共用账号卡。

#### Fields And Buttons

| 类型 | 名称 | 规则 |
|---|---|---|
| 搜索 | Search settings | 搜索设置项 |
| 筛选 | Platform | All / Pinterest / Instagram / Facebook |
| 字段 | Connected count | 显示已连接数量和套餐上限 |
| 字段 | Identity | 平台、头像、display name、username、脱敏 ID |
| 字段 | Connection status | Connected / Needs reconnect / Needs attention / Disconnected |
| 字段 | Capabilities | Publish / Schedule / Insights / Auto-post |
| 字段 | Last refreshed | 最近校验时间 |
| 按钮 | `Add account` | 选择平台后开始连接 |
| 按钮 | `Refresh` | 重新拉取 identity 和 capability |
| 按钮 | `Reconnect` | Token 或权限异常时显示 |
| 按钮 | `Remove` | 二次确认后解除连接 |

#### Rules

1. `Connected` 仅在 OAuth callback、identity 和必要权限校验成功后显示。
2. Instagram 不得默认显示 Auto-post；能力不足时原位说明原因。
3. Studio 只读取 connectionId 与 capability；连接管理统一返回 Settings。

#### Acceptance Criteria

| ID | 验收要求 |
|---|---|
| AC-24 | Settings、单卡和批量编辑读取同一 identity 与 capability。 |
| AC-25 | 未连接、权限不足、失效和真实可用状态可区分。 |

### 2.10 FR-07 Insights

Insights 为 Measure 分组下的顶级入口。本期页面包括 Overview、Content、Content detail、Diagnosis 和 Recommendations。

#### Fields And Buttons

| 类型 | 名称 | 规则 |
|---|---|---|
| 筛选 | Date range | 7 / 30 / 90 天或自定义 |
| 筛选 | Platform | All / Pinterest / Instagram / Facebook |
| 筛选 | Account | 只显示当前 owner 的有效连接 |
| 筛选 | Content status | Published / Partial / Failed |
| 搜索 | Search content | 按标题、URL 或 Board |
| 按钮 | `Compare period` | 对比上一等长周期 |
| 按钮 | `Open content detail` | 查看各 destination 原生指标 |
| 按钮 | `Generate based on this insight` | 创建新 Draft |
| 按钮 | `Refresh` | 刷新并显示数据时间 |

#### Rules

1. 不合并不同平台的 Impressions、Views 或 Media Views。
2. Unsupported、Not connected、No permission、Not refreshed 和真实 0 必须分开显示。
3. 跨平台比较使用各平台自身历史基线。
4. 样本不足时只显示原始数据，不生成强因果结论。
5. Recommendation 使用 Keep / Change / Test，并可携带上下文创建新 Draft。

#### Acceptance Criteria

| ID | 验收要求 |
|---|---|
| AC-26 | 不生成跨平台伪“总曝光”。 |
| AC-27 | 从 Recommendation 创建新 Draft 时不修改历史发布结果。 |

### 2.11 FR-08 Stable QA Access

#### Environments

| 环境 | 访问规则 |
|---|---|
| Production | 正式域名与 VibePin 登录 |
| Stable QA | `preview.vibepin.co`，只使用 VibePin 登录 |
| Branch Preview | 保留 Vercel 平台保护，仅供开发人员 |

#### Rules

1. Stable QA 不得依赖 Vercel 团队登录 Cookie。
2. VibePin 登录成功后返回原始 Studio 路径。
3. 每次部署后检查最终 Host、状态码和重定向链。
4. 检测到 `vercel.com/sso-api` 时，该部署不得标记为可验收。
5. 不在评审链接中携带可转发的保护绕过 Token。

#### Acceptance Criteria

| ID | 验收要求 |
|---|---|
| AC-28 | 无 Vercel Session 的无痕浏览器可打开 Stable QA。 |
| AC-29 | 未登录时进入 VibePin 登录，登录后返回 `/app/studio`。 |

## 3. AI System Requirements

### 3.1 Required Capabilities

| 能力 | 输入 | 输出 |
|---|---|---|
| URL analysis | Website URL | 页面摘要、事实和可用媒体 |
| Image generation | 主图、参考图、方向和参数 | 可编辑图片 Draft |
| Copy generation | URL、媒体、目的和渠道 | Title、Description、Caption、Alt、Keywords、Board 建议 |
| Quality gate | 生成结果与主体事实 | Pass / Retry / Failed |

### 3.2 Evaluation Strategy

| ID | 检查项 | 通过条件 |
|---|---|---|
| AI-E01 | 主体身份、颜色、结构、数量 | 发布候选中关键事实错误为 0 |
| AI-E02 | 文字和明显 AI 结构错误 | 未通过结果不得进入发布 |
| AI-E03 | 用户字段保护 | `userTouched=true` 的字段覆盖次数为 0 |
| AI-E04 | 任务恢复 | 刷新后可恢复 Setup、成功结果和失败状态 |
| AI-E05 | 渠道约束 | 文案符合所选平台字段长度与格式规则 |

## 4. Technical Specifications

### 4.1 Architecture Overview

```text
Studio UI
→ Existing Draft service
→ URL analysis / AI generation / Copy generation
→ Destination validation
→ Publish or Schedule service
→ Provider result
→ History and Insights
```

所有入口使用同一个 Content、Draft、connection identity、schedule job 和 publish result 事实源。

### 4.2 Required Data

| 领域 | 关键字段 |
|---|---|
| URL | sourceUrl, pageType, analysisStatus, extractedMedia, extractedFacts, analyzedAt |
| AI Setup | setupId, sourceDraftId, primaryMediaId, referenceMediaIds, creativeDirection, model, quantity, aspectRatio, diversity |
| Suggestions | suggestedValue, source, confidence, appliedAt, userTouched |
| Media | mediaType, sourceAspectRatio, targetAspectRatio, fitMode, cropPosition, derivedAssetId |
| Video cover | coverAssetId, coverSource, coverTimestampMs, platformCompatibility |
| Ownership | ownerAccountId, workspaceId, destinationId |
| Persistence | syncStatus, serverVersion, updatedAt |
| Schedule | workspaceTimeZone, rangeStart, rangeEnd, pastViewActive, dailyPostGoal, scheduleSource, smartScheduleLocked |

服务端 Draft 与 History 是事实源。本地存储只用于缓存和待同步队列。所有查询按 `ownerAccountId + workspaceId` 隔离；发布记录额外保存 `destinationId`。

### 4.3 Integration Points

1. Create Pin：复用现有 Draft 和 Board 能力。
2. Social Accounts：读取同一 connection identity 与 capability。
3. Multichannel Publish：按 destination 保存结果并保证幂等。
4. Insights：读取 provider 原生指标，不修改发布事实。
5. Schedule Plan：读取同一 schedule job 和视频封面。

### 4.4 Security And Privacy

1. 服务端验证 owner、workspace、connection 和 destination 权限。
2. 不向其他账号暴露 Draft、History、媒体或发布结果。
3. OAuth Token 不进入客户端持久化数据。
4. 删除或解除账号连接必须二次确认。
5. AI 输入、输出和来源记录按现有数据保留策略处理。

### 4.5 Error Handling

| 场景 | 用户状态 | 系统行为 |
|---|---|---|
| URL 无法读取 | Retry / Upload media instead | 保留 URL，不扣生成量 |
| URL 部分成功 | Partial | 展示可用信息，允许补充上传 |
| AI 图片失败 | Partial success / Failed | 保留 Setup 和成功结果 |
| AI 文案失败 | 可继续编辑 | 不清空现有内容 |
| Board 推荐失败 | 手动选择 | 不自动选择默认 Board |
| 视频抽帧失败 | Retry | 保留视频和原封面 |
| 比例适配失败 | Retry / Reset | 保留原媒体 |
| 账号连接失效 | Reconnect | 仅禁用对应 destination |
| 账号菜单空间不足 | 自动翻转或内部滚动 | 不允许被卡片裁切 |
| 服务端保存失败 | Waiting to sync | 本地排队，恢复后按版本同步 |
| History 加载失败 | Retry | 不回退为设备本地残缺历史 |
| 日历加载失败 | Retry | 不用过去日期兜底 |
| 智能重排失败 | Retry | 回滚原排期，不生成重复任务 |
| Stable QA 跳转 Vercel | 不可验收 | 阻止发布验收链接 |

### 4.6 Non-Functional Requirements

1. 验收视口：390×844、768px、1024px、1280×720、1440×900、1920×1080。
2. 支持 Light / Dark、Loading / Empty / Partial / Success / Error。
3. 支持键盘顺序、焦点恢复、200% Zoom 和 reduced motion。
4. Modal / Drawer / Popover 关闭后焦点返回触发按钮。
5. Publish 和 Schedule 必须幂等；Unknown 状态先查询 provider。
6. 新 UI 复用 VibePin 语义 Token 和共享组件。

## 5. Risks & Roadmap

### 5.1 Delivery Order

| 阶段 | 内容 |
|---|---|
| P0-A | Studio 布局、卡片字段顺序、图片/视频动作 |
| P0-B | URL + AI 创建、AI 文案、任务恢复 |
| P0-C | 发布账号菜单、服务端保存、History |
| P0-D | Schedule Plan、每日发布数量、Stable QA |
| P1 | Insights、Full planner、多账号增强 |
| P2 | 完整视频编辑、字幕、自动实验建议 |

### 5.2 Risks

| 风险 | 影响 | 控制措施 |
|---|---|---|
| 新旧 AI 入口产生双状态 | Draft 和额度不一致 | 强制复用同一 Setup 与任务 |
| 媒体类型状态残留 | 视频出现生图动作 | 按标准化 mediaType 派生按钮 |
| Popover 被容器裁切 | 无法选择发布账号 | Portal + 视口碰撞检测 |
| 智能重排产生重复任务 | 重复发布 | destination job 幂等键与回滚 |
| 本地缓存被误认为事实源 | 跨设备记录不一致 | 服务端版本与账号隔离 |
| Stable QA 依赖 Vercel Session | 无法验收 | 固定 QA 域名与部署后重定向检查 |

### 5.3 Dependencies And References

1. Create Pin：`0903-VibePin-CreatePin-业务PRD-v2.0.md`。
2. 发布目标与 OAuth：`0901-Multichannel发布目标与OAuth补充PRD.md`。
3. Insights：`0826VibePin_Insights_业务需求PRD_v1.md`。
4. Social Accounts：`0805-审计综合-SocialAccounts多账号PRD.md`。
5. AI 图片：`0918-VibePin-参考图库标注与社媒图片生成全流程PRD-v1.0.md`。
6. 视频发布：`docs/0910-Pinterest视频Pin发布成功方案.md`。
7. UI 合同：`docs/design/VIBEPIN_DESIGN_SYSTEM.md` 与 `docs/design/AGENT_UI_CHECKLIST.md`。
8. 交互研究：JCodesMore `ai-website-cloner-template` 仅用于公开或已授权页面的截图、状态遍历和视觉对比。

冲突优先级：安全与发布事实契约 > 本 PRD > 页面视觉参考。
