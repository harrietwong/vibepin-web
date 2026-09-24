# VibePin Design System

版本：1.0-draft  
日期：2026-09-06  
适用范围：`web/src/app/app/**` 登录后客户界面  
规范级别：实施合同；除明确记录的例外外，后续 UI 修改必须遵守。

## 1. 产品体验定位

VibePin 的登录后产品不是通用数据后台，而是一个从机会发现到内容发布的 **Editorial Creator Studio（编辑式创作工作台）**。

用户的主任务链路是：

`发现机会 → 选择方向或商品 → 生成 Pin → 审阅与编辑 → 排期或发布 → 回看表现`

Studio 是全站的“总店”。其他页面必须能清楚回答两个问题：

1. 我在这里找到的内容，如何带回 Studio 继续创作？
2. 我在 Studio 生成的内容，之后在哪里管理、安排和复盘？

### 体验原则

1. **内容先于界面。** 图片、视频、Pin 草稿和机会证据是视觉主角；产品 chrome 退后。
2. **一次只突出一个主动作。** 品牌渐变只用于当前页面最重要的创建动作。
3. **结构比装饰重要。** 优先统一标题、工具栏、状态和布局，再讨论阴影、动效或新颜色。
4. **状态必须给出下一步。** Loading、empty、error、success 都应保持上下文并告诉用户接下来能做什么。
5. **窄屏重新编排，不缩小桌面版。** 低于 768px 时改为单列、抽屉或列表，不允许硬压缩多列画布。

## 2. 参考来源与取舍

本系统吸收三份 Refero 参考，但不复制其品牌：

| 来源 | 采用 | 不采用 |
|---|---|---|
| AI Product Generation | 浅色纸张画布、媒体优先、低阴影、宽松留白 | 橙色品牌、营销页超大标题 |
| VEED | Prompt-first 创建入口、一个醒目的主 CTA、10px 控件与 16px 媒体卡 | 荧光绿色、双字体营销风格 |
| Morphic | 深色沉浸式预览、生成内容画廊、紧凑媒体控制 | 全站纯黑、蓝色品牌替换 |

VibePin 保留现有紫粉识别。深色“影院”只用于媒体预览、灯箱和审片场景，不扩散成第二套产品品牌。

## 3. 信息架构

### 主导航分组

| 分组 | 页面 | 主要任务 | 回到 Studio 的动作 |
|---|---|---|---|
| Create | Studio | 创建、编辑、生成 | 当前主任务 |
| Library | My Pins | 管理草稿和成品 | Create another / Edit in Studio |
| Discover | Opportunities | 找到内容缺口 | Create from opportunity |
| Discover | Pin Ideas | 浏览和保存灵感 | Use this idea |
| Discover | Product Opportunities | 选择值得推广的商品 | Create product Pin |
| Plan | Weekly Plan | 安排、调整发布节奏 | Create for empty slot |
| Measure | Insights | 回看结果和下一步建议 | Create from insight |
| Measure | Keyword Trends | 验证关键词趋势 | Create with keyword |
| System | Settings / Help | 配置与求助 | 返回原页面 |

### 待产品决策

- Weekly Plan 必须只有一个权威体验：优先建议成为 Studio 的 `Plan` 模式；不得长期维护独立 `/app/plan` 和 Studio 内 Plan 两套界面。
- Insights 与 Keyword Trends 的上线状态必须由导航、路由和权限共同决定；未就绪页面不得出现可点击入口。
- Settings 采用一种权威模型：路由驱动的全局响应式弹窗。URL 保留深链能力；桌面使用双栏 dialog，低于 768px 使用全屏工作区；关闭时回到来源页面并恢复焦点。不得再增加第二套设置页布局。

## 4. 视觉语言

### 4.1 色彩

现有 `--app-*` 是登录后界面的基础语义 Token。页面组件必须使用语义变量，禁止直接写品牌或中性色十六进制。

#### Light

| 角色 | Token | 当前值 |
|---|---|---:|
| 页面画布 | `--app-bg` | `#F7F7FB` |
| 主表面 | `--app-surface` | `#FFFFFF` |
| 次表面 | `--app-surface-2` | `#F8FAFC` |
| 选中/嵌入表面 | `--app-surface-3` | `#EEF2F7` |
| 普通边框 | `--app-border` | `#E5E7EB` |
| 强边框 | `--app-border-hi` | `#D1D5DB` |
| 主文字 | `--app-text` | `#111827` |
| 次文字 | `--app-text-sec` | `#6B7280` |
| 弱文字 | `--app-text-muted` | `#9CA3AF` |
| 品牌主色 | `--app-brand` | `#7C3AED` |
| 品牌辅助 | `--app-brand-2` | `#8B5CF6` |
| 品牌弱底 | `--app-brand-soft` | `rgba(124, 58, 237, 0.10)` |
| 成功文字 | `--app-positive-text` | `#15803D` |

#### Dark

| 角色 | Token | 当前值 |
|---|---|---:|
| 页面画布 | `--app-bg` | `#080A12` |
| 主表面 | `--app-surface` | `#11131D` |
| 次表面 | `--app-surface-2` | `#151823` |
| 选中/嵌入表面 | `--app-surface-3` | `#181B27` |
| 主文字 | `--app-text` | `#F8FAFC` |
| 次文字 | `--app-text-sec` | `#A1A1AA` |
| 品牌主色 | `--app-brand` | `#8B5CF6` |
| 品牌辅助 | `--app-brand-2` | `#A78BFA` |
| 成功文字 | `--app-positive-text` | `#86EFAC` |

#### 色彩使用规则

- `--brand-grad` 只用于“Generate / Create”这一类当前主任务，不用于 Save、Filter、Tab 或普通卡片。
- 成功、警告、危险、信息必须使用语义 Token；禁止用品牌色表达错误。
- 状态底色与状态文字分开选 Token；浅色背景上的成功正文使用 `--app-positive-text`，不能直接把高亮成功色当正文色。
- 颜色不能成为唯一状态信号，必须同时提供图标、文字或形状变化。
- 页面内新增颜色前，先在 `globals.css` 定义语义 Token，并在本文件登记用途。
- 深色主题不得再通过新增 Tailwind utility override 扩张；新组件直接消费 `--app-*`。

### 4.2 字体

功能界面继续使用现有 system / Inter 字体栈，不新增网络字体依赖。

| 角色 | 字号 / 行高 | 字重 | 用途 |
|---|---|---:|---|
| Page title | `24px / 30px` | 800 | 每页唯一 H1 |
| Section title | `18px / 24px` | 700 | 主区块 H2 |
| Card title | `15px / 20px` | 650–700 | 卡片标题 |
| Body | `14px / 21px` | 400–500 | 正文与输入 |
| UI label | `13px / 18px` | 600 | 按钮、Tab、筛选器 |
| Helper | `12px / 17px` | 400–500 | 辅助说明、时间、元数据 |

规则：

- 功能文字不得小于 12px；10–11px 仅限非关键媒体元数据，且对比度合格。
- H1 使用 sentence case，不混用全大写 eyebrow 代替页面标题。
- 同屏最多三个明显字重；不靠全大写和加粗同时制造层级。
- 标题和操作文案使用用户语言，不暴露表名、schema、provider code 等内部实现。

### 4.3 间距

基础网格为 4px。允许的常用间距：

| Token | 值 | 典型用途 |
|---|---:|---|
| `--vp-space-1` | 4px | 图标内部微距 |
| `--vp-space-2` | 8px | 紧凑控件、标签间距 |
| `--vp-space-3` | 12px | 表单行、卡片内部小间距 |
| `--vp-space-4` | 16px | 控件组、手机页面 padding |
| `--vp-space-6` | 24px | 卡片 padding、区块间距 |
| `--vp-space-8` | 32px | 页面段落间距 |
| `--vp-space-12` | 48px | 大区块间距 |

禁止在页面代码中新增 13px、18px、27px 等任意布局间距；特殊媒体比例不受此限制。

### 4.4 圆角与边框

| 角色 | 圆角 |
|---|---:|
| 输入、按钮、Tab、菜单项 | 10px |
| 普通卡片、Toolbar、Empty/Error State | 16px |
| 图片、视频、生成结果主容器 | 24px |
| Drawer / Modal | 24px |
| Status / Filter pill | 999px |

- 普通表面使用 `1px solid var(--app-border)`。
- 默认卡片不使用大阴影；靠画布、表面色阶和边框分层。
- 阴影只允许用于菜单、Drawer、Modal、拖拽浮层和媒体灯箱。
- 图片圆角不得小于其外层卡片圆角，也不得让图片边角露出外层。

### 4.5 品牌签名：Creation Rail

Studio 的标志性组件是 **Creation Rail**：一个媒体输入与 Prompt 组合的创建入口，连接输入、生成进度和结果画布。

- 它应是 Studio 首屏唯一高饱和区域。
- 提交后 Rail 保留上下文并转成可追踪的生成状态，不用全屏 loading 替换页面。
- Opportunities、Pin Ideas、Products、Plan 和 Insights 的主 CTA 都把结构化上下文送入同一个 Creation Rail。
- 其他页面不得复制一套自己的“迷你生成器”。

## 5. 布局合同

### 5.1 App Shell

| 视口 | 导航 | 顶栏 | 页面内容 |
|---|---|---|---|
| `≥ 1280px` | 68px 图标 rail，可通过 hover 与 keyboard focus 显示标签 | 48–56px | 内容区 fluid，阅读页最大 1280px |
| `1024–1279px` | 60–68px 图标 rail | 48–56px | 收紧 gutter，不压缩核心编辑器 |
| `768–1023px` | 图标 rail 或可关闭 drawer | 52–56px | 两列只在各列仍 ≥320px 时存在 |
| `< 768px` | 顶部品牌栏 + 底部主导航；More 打开 drawer | 56px | 单列，左右 padding 16px |

移动端底部主导航只放 Studio、My Pins、Discover、Plan、More。其余入口进入 More，不把 8–10 个图标挤进一行。

### 5.2 Page Shell

所有路由使用 `AppPage`：

- 桌面 gutter 24–32px；移动端 16px。
- 页面顶部使用统一 `PageHeader`，不得自定义 H1 尺寸。
- `PageHeader` 与首个内容区间距 24px；内容区块间距 32px。
- 数据阅读页默认最大宽度 1280px；Studio 和 Plan 可使用 fluid variant。
- 页面级错误/空状态占据内容区，不覆盖全局导航。

### 5.3 响应式重排

- Studio：宽屏可双列；窄屏结果卡单列，详细编辑进入 `ResponsiveDrawer`。
- Weekly Plan：宽屏周历；低于 1024px 使用按日视图；低于 768px 使用列表，不显示被压缩的七列。
- 数据表：优先转为卡片/主次列布局；只有数据比较确实需要时才允许带明确提示的横向滚动。
- 桌面宽表转换为移动卡片时，每个值必须保留本地化字段标签；缩略图可作为视觉 rail，但不能挤压主要操作和长文本。
- FilterBar：桌面单行；移动端显示摘要按钮，打开 sheet；常用 1–2 个筛选可以留在页面。
- Modal：桌面居中对话框；移动端升级为全高 sheet，并保留可见关闭操作。

## 6. 公共组件合同

以下组件应集中在 `web/src/components/ui/` 或对应共享域，不允许页面复制视觉实现。

### `AppPage`

负责页面宽度、gutter、背景和纵向节奏。Variant：`content | fluid | focus`。

### `PageHeader`

结构固定为 eyebrow（可选）→ H1 → description（可选）→ actions。移动端 actions 换行但不截断。

### `SectionHeader`

H2、说明和可选文字操作。不得用多个不同字号的 div 模拟标题。

### `Toolbar` 与 `FilterBar`

统一搜索、筛选、排序、结果数和批量操作。筛选状态必须可见、可清除、可通过键盘操作。

### 按钮

| 组件 | 用途 | 视觉 |
|---|---|---|
| `PrimaryButton` | 页面唯一主动作；创建时可用渐变 | 品牌填充，44px 触控高度 |
| `SecondaryButton` | 保存、重试、次级流转 | 中性或单色品牌弱底 |
| `TertiaryButton` | Toolbar 和低权重动作 | 无填充，hover 显示表面 |
| `DangerButton` | 删除、断开、不可逆操作 | 危险语义色，不用品牌渐变 |
| `IconButton` | 只有图标的局部动作 | 至少 40×40px，必须有 accessible name |

同一 action 的文案在按钮、进度、toast 中保持一致，例如 `Publish` → `Publishing…` → `Published`。

### `MediaCard`

统一图片比例、状态层、选中态、hover 动作和键盘 focus。操作默认不遮挡主体；触控布局中的主动作与恢复动作必须始终可见，不得只靠 hover、透明度变化或鼠标指针暴露。

### 状态组件

- `LoadingState`：保留最终布局的 skeleton；超过约 8 秒显示阶段说明和取消/后台继续选项。
- `EmptyState`：一句事实 + 一句价值说明 + 一个主动作；不使用虚假成功语气。
- `ErrorState`：用户可理解的原因 + 可执行恢复动作 + 可选支持编号；不得暴露内部错误。
- `StatusPill`：只表达短状态或分类，不承载主动作。
- `ProgressState`：显示 generation 的阶段、数量和部分成功；不能把部分成功归为全失败。

### `ResponsiveDrawer`

桌面右侧详情面板，移动端底部/全高 sheet。必须支持 Escape、焦点锁定、关闭后焦点恢复、背景不可交互和标题关联。

### Modal / Settings dialog

- 所有模态表面复用 `useModalFocus`，包含 body scroll lock、Tab 焦点循环、Escape、关闭后焦点恢复和最上层弹窗判断。
- 嵌套模态只响应最上层：例如 Settings 内打开客服后，第一次 Escape 只关闭客服并回到“Contact support”，第二次才关闭 Settings。
- Settings 导航使用 `tablist → tab → tabpanel`；选中项采用 roving `tabIndex`，支持左右/上下方向键、Home、End。
- 真正阻断背景操作的表面必须同时具有 `role="dialog"`、`aria-modal="true"`、可编程标题，以及 `tabIndex={-1}` 作为无可聚焦子项时的后备。
- 桌面浮动助手、hover preview、非阻断详情等不锁定背景的表面不得伪装成 modal；移动端转为 sheet 时才启用 `aria-modal` 与焦点锁定。
- 新增 `aria-modal` 的文件会被 `check:ui-contract` 检查；同一文件未使用 `useModalFocus` 时合同直接失败。
- 已统一消费者：Settings、Support Chat、Language & Region、Smart Schedule、Weekly Plan Pin Details、Custom time、通用确认框、发布确认框、素材灯箱、助手变更确认与移动端助手 sheet。
- 桌面 Settings 使用 184px 导航栏和独立滚动内容区；窄屏标签变为横向滚动，内容与底部操作区分别保持可达。
- Save 使用单色 `primary`；品牌渐变仍只用于 Create / Generate。

## 7. 交互与动效

动效用于反馈、方向和连续性，不用于装饰。

| Token | 时长 | 用途 |
|---|---:|---|
| `--vp-motion-fast` | 120ms | hover、press、icon feedback |
| `--vp-motion-base` | 180ms | tab、filter、selection |
| `--vp-motion-panel` | 240ms | menu、drawer、sheet |
| `--vp-motion-dialog` | 280ms | modal、lightbox |

推荐 easing：`cubic-bezier(0.16, 1, 0.3, 1)` 进入，`cubic-bezier(0.55, 0, 1, 0.45)` 退出。

规则：

- 优先动画 `transform` 与 `opacity`，不动画大范围 width/height/top/left。
- 生成任务可后台运行；动画不得阻止导航或编辑其他草稿。
- hover、focus、selected、pressed、disabled 必须分别可辨认。
- `prefers-reduced-motion: reduce` 下取消位移、缩放和循环动画，只保留即时状态变化。
- Toast 不作为唯一反馈；关键状态必须同时保留在任务或卡片上。

## 8. 内容与状态文案

- 使用主动、具体的动词：`Create Pin`、`Save changes`、`Retry`、`Connect Pinterest`。
- 空状态说明用户还没有什么，并给出最短下一步。
- 错误文案说明“什么没完成”和“现在能做什么”；内部细节写日志，不写 UI。
- 按钮使用 sentence case；全大写只用于极短非交互元数据。
- 语言切换后不允许在同一组件混杂中英文。
- 日期、数字、时区和相对时间必须来自统一格式化工具。

## 9. 可访问性底线

- 正文和关键控件达到 WCAG AA 对比度；文字不可只靠低透明度变淡。
- 键盘顺序与视觉顺序一致；所有功能可在不使用鼠标时完成。
- `:focus-visible` 清楚且不被 overflow 裁切。
- 触控目标建议 44×44px，最低不得小于 40×40px。
- 表单必须有可编程 label；placeholder 不能替代 label。
- Icon-only 控件必须有 `aria-label`；装饰图标 `aria-hidden`。
- 异步成功/失败使用合适的 live region，但避免重复朗读进度。
- Modal/Drawer 必须管理焦点；页面跳转后将焦点放到主标题或主内容。
- 验证 200% zoom、键盘、reduced motion 和亮/暗主题。

## 10. 页面配方

### Studio

`PageHeader → Creation Rail → generation status → result board → responsive editor`

生成结果是主视觉；批量操作进入共享 Toolbar；窄屏不并排显示大型编辑器。

### My Pins / Pin Ideas / Product Opportunities

`PageHeader → FilterBar → result summary → MediaCard grid → pagination/infinite state`

三页共享结构，只因任务语义改变卡片元数据和 CTA。My Pins 的筛选项使用 `aria-pressed`；Pin Ideas 的 Analysis 宽表在窄屏转为带字段标签的卡片；Product Opportunities 的窄屏控件顺序固定为类型、搜索、来源、排序与局部动作。

### Opportunities / Keyword Trends / Insights

`PageHeader → scope controls → summary → evidence/content → next action`

数据错误使用共享 ErrorState；不得直接渲染数据库或 provider 原文。

### Weekly Plan

`PageHeader → date controls → view switcher → calendar/day/list → unscheduled tray`

拖拽必须有键盘替代；窄屏可以保留周视图，但七日列必须维持可读宽度并在内容区域横向浏览，不能把七列硬压进屏幕。List 仍作为不依赖拖拽的替代视图。

### Settings / Help

Help 首页使用 `PageHeader → Ask VibePin → searchable article list`；文章页使用 `PageHeader(back link + article H1 + short answer) → article sections → support CTA`。两者共享表面、输入、按钮和内容宽度，并在提交问题后保留来源页面上下文，不维护文章专用颜色或渐变对象。Settings 的初始标签由 URL 决定，通过唯一全局响应式弹窗呈现；桌面双栏，移动端全屏。

## 11. 组件复用与代码约束

1. 页面不得重造本文件列出的公共组件；缺少能力时扩展共享组件 API。
2. 页面代码不得新增任意十六进制、rgb/rgba 品牌色或阴影值。
3. 禁止用 Tailwind dark override 修补新组件；新组件直接使用语义 Token。
4. 禁止用 `overflow: hidden` 隐藏响应式失败。
5. 业务逻辑与视觉组件分离；大型页面应把视觉区域拆成可验证组件。
6. 仅一个页面需要的业务组件放在页面域；两个及以上页面使用的视觉模式进入共享 UI。
7. 新 icon 使用项目既有 Lucide；不得使用 emoji、ASCII 或自制 SVG 代替功能图标。
8. 改变公共组件前先检查全部调用者；不得为了单页效果破坏其他页面。
9. 需要例外时，在 PR/任务说明中写明原因、范围、到期条件，并同步更新本规范。

## 12. 验收矩阵

每个修改页面至少验证：

| 维度 | 必测值 |
|---|---|
| 视口 | 1440、1024、768、390 |
| 主题 | Light、Dark |
| 数据 | Loading、Empty、Partial、Success、Error |
| 输入 | Mouse、Keyboard；触控布局人工检查 |
| 可访问性 | Focus、200% zoom、reduced motion、控件名称 |
| 内容 | 长标题、长筛选值、0/1/多结果、错误恢复 |

代码门槛：

```bash
npm run check:ui-contract -- <本任务修改的 UI 文件或目录...>
npm run typecheck:ui-foundations
npm run test:ui-foundations
npm run lint
npm run typecheck
npm run test:core
```

涉及 Studio、Plan、Settings 时分别增加对应测试。需要登录的浏览器/E2E 验证必须遵守 `web/tests/e2e/TESTING.md`，只能使用测试库。

## 13. Definition of Done

一个 UI 改动只有同时满足以下条件才算完成：

1. 任务链路可完成，原有业务行为未被视觉重构破坏。
2. 使用共享 Token 与组件，没有新增页面级视觉分叉。
3. 四档视口、双主题和关键状态均已检查。
4. 键盘、focus、reduced motion 和错误恢复已验证。
5. lint、typecheck 和相关功能测试通过，或明确记录与本改动无关的既有失败。
6. 浏览器截图与目标设计在相同视口和状态下完成对照检查。
7. 规范、组件文档和 Agent 检查清单在新增模式时同步更新。
