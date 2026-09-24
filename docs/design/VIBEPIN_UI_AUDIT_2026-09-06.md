# VibePin 登录后界面审查（第一轮）

日期：2026-09-06  
状态：审查与渐进实施进行中；基础、App Shell、核心页面外层、Settings、Insights 与高频模态交互已完成首轮改造。

## 1. 审查范围

- 产品：VibePin 登录后的客户工作台。
- 核心任务：发现机会或选择商品，生成 Pin，检查与编辑，安排发布，回看结果。
- 核心页面：Studio、My Pins、Opportunities、Keyword Trends、Pin Ideas、Product Opportunities、Weekly Plan、Insights、Settings、Help & Support。
- 视觉参考：`references/refero-ai-product-generation.md`、`references/refero-veed.md`、`references/refero-morphic.md`。
- 本轮证据：Codex 内置浏览器中的线上预览，在 624×624 窄视口逐页重新捕获；同时核对当前工作树代码。

## 2. 总体判断

VibePin 已经有清楚的紫粉品牌识别、统一的全局外壳和相当完整的业务能力，但登录后各页仍像由不同批次独立完成：页面标题、筛选器、卡片、空状态、错误状态、Settings 导航模型及响应式策略没有统一合同。Studio 具备成为“总店”的业务地位，却还没有成为全站共享的交互范式。

当前优先级不是换一套颜色，而是先统一结构、组件和状态表达，再做视觉精修。

## 3. 页面证据与健康度

| 步骤 | 页面                  | 当前表现                                                                                                                                                                                    | 健康度 |
| ---- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 1    | Studio / Create Pins  | 主任务清楚，创建入口明确；低于 768px 已强制单列，390/768/1024/1440 的内置浏览器目视检查显示网格可读；卡片内部仍有高密度与历史样式债务。                                                     | 一般   |
| 2    | My Pins               | 搜索已使用共享图标与可编程名称，筛选项具备 pressed 语义，功能文字和触控高度已纳入统一合同；真实登录态下 5 组历史记录及卡片操作可正常读取。                                                  | 良好   |
| 3    | Opportunities         | 分类导航、统一错误态和 Retry 可用，错误不泄露内部实现；测试库缺少 `trend_opportunities_view`，因此当前只能验收到安全失败态，真实内容布局仍待数据环境复核。                                  | 一般   |
| 4    | Keyword Trends        | 搜索任务明确；技术错误详情已从客户界面移除，低于 768px 时两组 900/950px 宽表会转换为带字段标签的两列信息卡。测试库缺少 `trend_keywords`，真实数据卡仍待完整截图验证。                       | 一般   |
| 5    | Pin Ideas             | 搜索与筛选能力完整；Analysis 宽表在窄屏已改为带字段标签的卡片，缩略图保留视觉锚点，主要操作在触控布局始终可见而不依赖 hover。测试库无 viral pin，填充态仍待复核。                           | 良好   |
| 6    | Product Opportunities | 已接入共享 `AppPage`、`PageHeader` 与 `Button`；窄屏商品类型卡保持双列，搜索独占一行，来源筛选横向可达，排序、保存视图和选择器保持触控尺寸。测试库缺少 `pin_products`，真实结果卡仍待复核。 | 良好   |
| 7    | Settings              | 已统一为路由可深链的全局响应式弹窗：桌面双栏、窄屏全屏，标签可横向浏览，并补齐焦点锁定、方向键、Escape、嵌套弹窗与焦点恢复。                                                                | 良好   |
| 8    | Help & Support        | 首页与文章详情已统一使用 `AppPage`、`PageHeader`、共享按钮和语义 Token；搜索具备可编程名称，文章标题/正文/支持 CTA 层级一致。本地登录态已验证首页与 Connect Pinterest 文章。                | 良好   |
| 9    | Weekly Plan           | 桌面保留周历；窄屏默认进入 List，并把行转换为带字段标签的纵向卡片。显式 `?view=calendar` 深链仍保留横向画布作为高级入口。                                                                   | 良好   |
| 10   | Insights              | 当前本地工作树已可访问，并接入统一 PageHeader、FeedbackState、语义 Token 与响应式排版；热力图和表格保留可读宽度横向浏览，断连状态提供明确下一步。线上旧预览仍与当前代码不一致。             | 良好   |

## 4. 已确认的优势

1. `web/src/app/globals.css:161` 和 `web/src/app/globals.css:200` 已有完整的亮色/暗色应用 Token 基础。
2. `web/src/app/globals.css:49` 已提供统一 `:focus-visible` 样式。
3. `web/src/app/app/layout.tsx:47` 集中定义客户侧导航，图标来源基本统一为 Lucide。
4. Studio 已将创建、编辑、排期、发布聚合在同一主任务内，适合成为其他页面的体验母版。
5. 空状态通常提供下一步动作，不是纯粹的空白页面。

## 5. 结构性问题

### P0 — 响应式策略失效

- Weekly Plan 已补窄屏替代路径：首次测量低于 768px 且 URL 未显式指定视图时默认进入 List；List 行转为带字段标签的纵向卡片，周历仅作为用户主动选择的横向画布。
- Studio 已在低于 768px 时强制单列，避免大型编辑卡被压缩成两列；卡片内部编辑密度仍是下一轮债务。
- Trends 桌面继续保留 900/950px 可比较宽表；低于 768px 时表头隐藏、每行转为带本地化字段标签的两列卡片，操作区独占一行，不再把桌面表格压进手机。
- App Shell 已在窄屏切换为五入口底栏，次要入口收进 More drawer；桌面保留 68px rail，并让键盘 focus 与 hover 共用文字提示。

### P0 — 线上状态与当前代码不一致（发布门槛）

- 当前代码的导航包含 Weekly Plan 和 Insights，但线上预览侧栏没有这两个入口。
- `/app/insights` 在线上旧预览返回 404；当前本地实现已经可用并通过 7 项 Insights MVP 测试，上线前仍需随当前工作树一并部署和复核。
- `/app/plan` 在线上重定向到 Studio 内的 Plan 视图，而当前工作树仍保留独立 3014 行页面。
- 在开始大范围 UI 修改前，必须先确定“独立 Plan 页面”还是“Studio 内 Plan 模式”为唯一架构，不能维护两套。

### P0 — 错误状态压过产品体验

- Opportunities 的统一错误态与 Retry 已通过本地登录态检查；测试库因缺少 `trend_opportunities_view` 仍无法加载 Home Decor，真实内容态不能据此宣称完成。
- Keyword Trends 的本地客户界面已屏蔽数据库表名和 schema cache 原文，保留安全、可行动的通用提示；线上旧预览仍需随当前代码重新部署验证。
- 顶栏持续出现同步异常；虽然说明数据保存在设备上，但全站常驻警告会削弱信任。

### P1 — 缺少共享页面合同

关键页面的样式实现统计：

| 文件                  | 内联 style | className | 硬编码色值 | `--app-*` Token |
| --------------------- | ---------: | --------: | ---------: | --------------: |
| app layout            |         38 |         1 |         10 |              35 |
| Studio                |        175 |         4 |         47 |              14 |
| My Pins               |        185 |         0 |         97 |             112 |
| Pin Ideas             |         95 |       305 |         89 |              88 |
| Product Opportunities |         34 |       188 |         63 |               0 |
| Keyword Trends        |         42 |       339 |        102 |               5 |
| Opportunities         |         52 |         0 |         26 |              39 |
| Help                  |         19 |         1 |         10 |               7 |

同一产品同时依赖大量内联样式、Tailwind 工具类、硬编码颜色和 CSS 变量，导致主题覆盖、状态色、间距与组件行为难以统一。

### P1 — 层级和文字规范漂移

- 页面 H1 在 15px、19px、22px、24px 之间变化：`workspace/[category]/page.tsx:572`、`history/page.tsx:1170`、`trends/page.tsx:1659`、`products/page.tsx:1004`、`help/page.tsx:49`。
- 页面 eyebrow 有 `MY PINS`、`KEYWORD TRENDS`、`DAILY PRODUCT TRACKING` 等不同语气和不同存在条件。
- 主 CTA 有渐变、纯紫、描边和文字链接等多种表达，没有“创建 / 保存 / 发布 / 危险操作”统一层级。

### P1 — Settings 的实现模型已明确，仍需清理遗留壳

- App Shell 通过 `SettingsModal` 接管全部 `/app/settings/*` 路由（`web/src/app/app/layout.tsx:413`、`:576`）。
- `web/src/components/settings/SettingsLayout.tsx` 当前没有被页面引用。
- 当前决定保留“路由驱动的全局响应式弹窗”：URL 负责深链，App Shell 负责承载；桌面为双栏 dialog，低于 768px 为全屏设置工作区。
- 多个 settings route 仍只返回 `null`，后续应移除未使用的 `SettingsLayout`，并为路由到弹窗的映射补一组统一测试，避免双轨重新出现。

### P2 — 可访问性风险

- 图标侧栏虽然有 `aria-label`，但文字提示主要依赖鼠标 hover；需要确认键盘 focus 也能展示名称。
- 多个控件和辅助文字使用 10–12px 字号；窄视口截图中低对比灰字已难以辨认。
- Settings 已在本地登录态专项验证：焦点锁定、方向键切换标签、Escape、关闭后回到账户入口、嵌套客服弹窗只关闭最上层、dialog/tab/tabpanel 标题关系均通过。
- 截图无法证明完整 WCAG 合规；仍需键盘、缩放 200%、对比度和读屏测试。

## 6. 统一设计方向

方向名：**Editorial Creator Studio（编辑式创作工作台）**。

- 从 AI Product Generation 借用：白纸式画布、媒体优先、低阴影、图片网格、编辑器退居内容之后。
- 从 VEED 借用：Prompt-first 创建入口、一个高辨识主动作、10px 控件与 16px 媒体卡片体系。
- 从 Morphic 借用：沉浸式媒体预览和生成结果画廊；深色仅用于预览器、灯箱和视频审片，不覆盖整个后台。
- 保留 VibePin 的紫粉品牌，不引入 VEED 绿色、Fourmula 橙色或 Morphic 蓝色作为第二套品牌色。

建议的基础合同：

- 4px 基础网格；常用间距只允许 4/8/12/16/24/32/48。
- 控件圆角 10px，普通卡片 16px，媒体容器 24px，胶囊只用于筛选和状态。
- 页面背景与卡片靠色阶和 1px 边框分层；除浮层和媒体灯箱外不使用大阴影。
- 品牌渐变只用于核心创建动作；普通保存、筛选、切换用单色或中性样式。
- 页面标题统一 24px/800，二级标题 18px/700，正文 14px/400–500，辅助文字不低于 12px。
- 窄屏下内容单列；周历改为按日横向分页或 List；Studio 卡片单列并把编辑区放入抽屉。

## 7. 建议的公共组件合同

第一批应建立并强制复用：

- `AppPage`
- `PageHeader`
- `PageActions`
- `SectionHeader`
- `Toolbar`
- `FilterBar`
- `PrimaryButton` / `SecondaryButton` / `DangerButton`
- `StatusPill`
- `MediaCard`
- `EmptyState`
- `ErrorState`
- `LoadingState`
- `ResponsiveDrawer`

页面不得重新定义上述组件的颜色、圆角、阴影、字号或交互状态。

## 8. 实施顺序

### Slice 1 — 基础与 Studio

1. 建立正式 Token、字体、间距、圆角和按钮层级。
2. 建立公共页面与状态组件。
3. 统一 App Shell 的导航、顶栏、焦点和移动端模式。
4. 重构 Studio 的页面头、创建入口、结果网格和窄屏编辑方式。

### Slice 2 — 内容与机会页

1. My Pins、Pin Ideas、Product Opportunities 复用同一 Header、FilterBar、MediaCard 和 EmptyState。
2. Opportunities、Trends 统一错误、加载、数据为空和重试反馈。
3. 决定 Trends 的产品去留；若按既有 PRD 下线，不为其继续投入视觉重构。

### Slice 3 — Plan、Settings 与 Help

1. 选择唯一 Plan 架构并删除重复体验。
2. 为窄屏提供 List/按日视图，禁止七列硬压缩。
3. 将 Settings 统一成明确的路由页或明确的全局模态，不再双轨。
4. Help 使用共享页面结构，并补齐客服、错误恢复和返回上下文。

## 9. Agent 治理要求（拟纳入最终规范）

后续 Agent 的 UI 修改必须：

1. 先读最终版 `VIBEPIN_DESIGN_SYSTEM.md`。
2. 优先复用公共组件，禁止页面局部重造按钮、卡片、空状态和筛选器。
3. 新颜色必须先成为语义 Token；页面代码不得新增任意十六进制颜色。
4. 同一页面必须验证 1440、1024、768、390 四个宽度。
5. 必须覆盖 loading、empty、error、success、disabled、focus 六类状态。
6. 不得以隐藏溢出代替响应式设计。
7. 修改后运行 UI 合同检查、类型检查和目标页面浏览器验收。
8. 不得推送、合并或部署，除非任务明确授权。

## 10. 当前证据与限制

- 本地最新代码已通过官方 `npm run dev:testdb` 连接隔离测试 Supabase，并使用唯一测试账号完成登录态检查；没有连接生产数据库。
- 已为 Studio、Weekly Plan、My Pins、Opportunities、Keyword Trends、Pin Ideas、Product Opportunities、Insights、Settings、Help 与 Help Article 建立可复现截图矩阵：2 个主题 × 4 个视口 × 11 条路由，共 88/88 张；清单与最终 URL 记录在 `docs/design/evidence/ui-2026-09-06/manifest.json`。
- 矩阵完整性复核结果：88 个唯一键、0 失败、0 登录页重定向、0 缺失文件；每个主题/视口组合均有 11 张截图。
- 截图脚本会验证实际 viewport、`document.documentElement.dataset.theme`、登录后最终 URL和页面 ready selector。Settings 使用全局设置弹窗标题 `[data-testid="settings-modal-title"]`，其余页面使用可见 H1。
- 独立产品审查发现 8 张目标为 `light` 的截图视觉仍呈深色。manifest 只证明根节点 `data-theme=light`，不能证明页面内部完全遵循亮色 Token；需由独立代码审查区分 ThemeProvider 竞态、页面硬编码和采集脚本问题，修复前不计作亮色视觉通过。
- 这组证据证明登录态 App Shell、主题、响应式布局以及当前可达的 loading / skeleton / empty / safe error 状态；它不等同于所有页面的真实数据 success-state 验收。测试库缺表或缺数据的页面仍需在具备填充数据的隔离环境补拍成功态。
- 本地 Next 开发服务器编译和内存重启会延长页面就绪时间；脚本包含服务恢复重试与增量 manifest，这属于证据采集基础设施，不应直接记为产品性能缺陷。
- Insights 已接入 `AppPage`、`PageHeader`、`FeedbackState`、语义热力图 Token 与安全错误文案，并通过 7 项 MVP 合同测试；其功能文件仍是工作树中的未跟踪实现，交付时必须与页面代码一起纳入。
- 工作树同时存在大量用户及其他任务的未提交改动；后续实施继续按文件归属限制写入范围，不做全局机械重写。

## 11. 2026-09-06 实施进度补充

已落地：

- App Shell 的桌面 rail、键盘提示、移动端五入口底栏和 More drawer 已统一。
- Studio、Weekly Plan、My Pins、Opportunities、Keyword Trends、Pin Ideas、Product Opportunities、Insights、Help 的页面外层已接入共同层级与响应式规则。
- Settings 已验证桌面双栏、窄屏全屏、语义 tabs、方向键、Escape、嵌套客服和焦点恢复。
- `useModalFocus` 已成为高频模态的共享合同，覆盖语言/地区、智能排期、Weekly Plan Pin Details、自定义时间、通用确认、发布确认、素材灯箱与助手确认；移动端助手 sheet 模态化，桌面助手保持非模态。
- `check:ui-contract` 已覆盖新增 TSX/CSS module 的颜色、阴影、圆角、12px 最小功能文字，并新增 `aria-modal → useModalFocus` 守卫。
- 本轮真实登录态验证：Smart Schedule 首焦点、Shift+Tab 循环与关闭后回到触发按钮通过；Pin Details → Custom time 的两层 Escape 顺序与逐层焦点返回通过；发布确认框焦点循环通过。

仍未达到 Definition of Done：

- Weekly Plan 的窄屏主路径已改为 List 优先，列表已转换为带字段标签的纵向卡片；显式 Calendar/Month 深链继续使用可横向浏览的完整时间画布。
- Studio 的窄屏结果网格已强制单列，并已纳入 390/768/1024/1440、亮/暗主题的仓库内截图矩阵。
- Studio 内部编辑卡与部分历史 drawer 仍有高密度、小字号和局部硬编码债务；其中若文件由其他任务占用，只能在其改动收敛后迁移。
- Keyword Trends 已补窄屏卡片替代与自动化源码合同；测试库当前缺少趋势表，只验证到安全错误态，仍需在有真实趋势数据的环境完成卡片视觉验收。
- My Pins 已补齐搜索名称、筛选 pressed 语义和统一 12px/触控高度合同；本地测试库的 5 组真实历史记录及卡片操作已完成桌面目视检查。
- Pin Ideas 的 Analysis 结果在窄屏改为字段化卡片，触控布局中的关键操作强制可见；测试库无 viral pin，仍需在有填充数据的环境验证卡片密度与长内容。
- Product Opportunities 已迁移到共享页面头和按钮层级，窄屏控制区按“类型 → 搜索 → 来源 → 排序/动作”重排；测试库缺少 `pin_products`，仍需验证真实商品结果卡。
- Opportunities 已确认安全失败态、Retry 和分类导航可用；测试库缺少 `trend_opportunities_view`，成功态与空态截图仍待补齐。
- Opportunities 的推荐内容比例提示已移除 9px 文字、字面色值和符号图标，改用 12px 语义 Token 与 Lucide 图标；分页状态也改为按分类派生，清除 3 个 effect 触发的 React lint 错误，Retry 运行态复核通过。
- Help 首页与文章详情已移除各自维护的字面色、渐变和圆角对象，统一使用共享页面层级、Button、语义 Token 和 12px 功能字号；本地浏览器验证首页搜索/文章列表，以及文章返回链接、H1、步骤列表和 Contact Support CTA。
- 共享 CSS 中 9 处未定义的 `--vp-space-5/7/10` 引用已替换为正式 4px 网格 Token，并增加自动化守卫防止未定义间距重新进入。
- 390/768/1024/1440、亮/暗主题目标的结构性截图矩阵已经形成；全站仍不能宣布完成，因为 8 张亮色目标存在视觉深色疑点，Keyword Trends、Pin Ideas、Product Opportunities、Opportunities 等页面缺少真实填充数据 success-state，且后续代码审查和终审尚未结束。
