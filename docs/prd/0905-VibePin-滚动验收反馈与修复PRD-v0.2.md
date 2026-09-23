# 0905 VibePin 滚动验收反馈与修复 PRD v0.2

状态：PRD 与低保真线框复审完成；产品实机视觉 / USER E2E 尚未执行；继续收集反馈，暂不进入实施
维护日期：2026-09-05
适用环境：VibePin Preview / 测试 Supabase
本轮静态审查绑定源码基线：`f995a0249865c65ea448b88186724b9cc7141e84`
历史回执绑定部署：`dpl_FiqJ7bkHQQkbaNLkcdyxwRxiTaaL`；本轮没有现场重查 alias、视觉状态或该部署
历史回执绑定 manifest：`f585e17f3ddd2f331a79271095a9758f30d94761`
Production：禁止修改、迁移、付款或发布

## 1. 文档目的

本文件集中记录用户在 Preview 人工验收中连续提交的缺陷和体验反馈，并把它们映射到源码可确认事实、静态风险、页面模板、非页面 surface 和可执行验收条件。它是滚动问题台账和实施入口，不替代各领域既有权威 PRD，也不把“找到路由/代码”写成视觉或业务 PASS。

在用户明确说“开始实施”前，各领域只允许：

- 只读复现、根因定位和 affected files 盘点；
- 补充需求、状态机、错误契约和验收用例；
- 不改代码，不创建 checkout，不上传、生成、排期、发布或删除内容；
- 不修改 env、数据库、Storage、OAuth 配置、Vercel 部署或 Production。

### 1.1 Astra 修订记录

本 v0.2 由 Astra 在隔离工作树做文档级独立复核，未修改产品代码或运行环境。相对 v0.1：补齐 FB-0905-39..49 汇总并登记 FB-0905-50；校准 `CONFIRMED_SOURCE / STATIC_RISK / USER_REPORT`；纠正 URL 隐私、provider capability 字段、schedule save/due-time、历史 Posted receipt、四套餐 usage path/mode、设计 token；把 64 page modules 映射到 template/state，并新增 layouts、loading/error/not-found、callbacks、assistant/support/help overlays 等非页面矩阵；线框升级为三张 v0.2 coverage assets。

文档完成与产品完成严格分离：本轮可交付 `STATIC_REVIEW_DOCUMENT_COMPLETE`；implementation、runtime、screen、USER E2E、四套餐 test accounts、OAuth/checkout/provider、DB 与 Production 全部仍待各自授权和证据。

### 1.2 最终复审记录与阅读入口

2026-09-05：Astra 主审已完成“独立审查 → 子 agent 修订 → 再审 → 定点修订 → 最终复核”。本节仅签收文档与低保真图稿，不放行实现或部署。

| 检查项 | 本轮实际结果 |
|---|---|
| 源码页面与 PRD 清单 | 64 个唯一 URL；清单缺失 0、额外 0 |
| 页面到模板/状态包映射 | 64 个入口全部映射；缺失 0、重复 0 |
| 问题台账 | 原 FB-0905-01..49 保留；新增 FB-0905-50 |
| 非页面界面 | layouts、loading/error/404、回调、嵌套弹窗、Assistant、Support 与全局反馈另列，不混入网页计数 |
| 图稿质量 | 三张 SVG XML 解析通过；最终 PNG 已重新渲染；主审逐张复核层级、禁用态、文本溢出及移动视口 |
| 业务一致性 | 复核 capability 必填、历史回执/当前状态、排期保存/到期发布、额度配置/实际模式、取消/显式 Save 与 URL 隐私边界 |
| 尚未完成 | 产品实现、64 页逐页实机画面、运行时可访问性、四账号×两轮、真实 OAuth/Creem/provider 验收 |

图稿入口：[关键 UI](assets/0905-ui-review/0905-VibePin-关键UI线框-v0.2.png)、[公共/Auth/设置](assets/0905-ui-review/0905-VibePin-公共认证与设置UI线框-v0.2.png)、[移动端与路由覆盖](assets/0905-ui-review/0905-VibePin-响应式与路由覆盖线框-v0.2.png)。同目录 SVG 为可编辑源。重点先读 §5 问题总表、§6.2 设计基线、§10.1 四套餐用例、§14 页面与状态覆盖。

Skill 来源为本机 `frontend-design`、`interaction-design`、`web-design-guidelines`；后者规则已按其要求在线读取 [Web Interface Guidelines](https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md)。本轮未生成 AI 位图设计稿：线框是可编辑 SVG，PNG 是其渲染结果。

## 2. 权威文档与去重规则

以下文档继续拥有各自领域的数据模型和业务规则，本文件仅记录新增要求和当前 Preview 回归证据：

- `0901-VibePin-Create-Pin生产阻断补充PRD-v1.0.md`
- `0901-VibePin-Product与Product-Picker补充PRD-v1.0.md`
- `0901-Reference创意智能补充PRD-v1.0.md`
- `0901-Multichannel发布目标与OAuth补充PRD.md`
- `0901-收款定价与Auth补充PRD-v1.0.md`
- `0904-VibePin-媒体存储与URL抓取安全补充PRD-v1.0.md`
- `0905-VibePin-统一Preview验收结论-v2.0.md`

规则：

1. 已有 requirement 继续使用原 ID，不创建第二套事实源。
2. 用户截图是缺陷发现证据，不是根因或修复 PASS。
3. 当前部署的回归不能用旧部署的 PASS 覆盖。
4. 所有修复必须先证明数据归属和状态语义，再处理视觉症状。
5. Creem checkout session、OAuth code、token、owner id 和完整私有媒体 URL 不进入文档和日志。
6. 每条结论必须标注证据等级：`CONFIRMED_SOURCE`（当前绑定源码可直接确认）、`STATIC_RISK`（由结构推导、需运行验证）或 `USER_REPORT`（用户截图/操作观察、需同部署复现）。三者都不是修复 PASS。
7. `64/64` 只表示 64 个 `page.tsx` 入口被列入清单；不代表逐页视觉通过，也不覆盖 `layout/loading/error/not-found`、OAuth callback、assistant、support/help overlay 等非页面 surface。
8. 代码位置、部署号与测试数字只在绑定证据仍适用时引用；无法现场重查时写明历史回执或静态风险，不使用“已确认通过”。

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
7. 新增 URL query/history state 只承载 allowlist 内、可分享且无副作用的筛选/排序/分页/公开资源 id；selection、私有 owner/workspace/draft/task id、token/code/session、未保存输入、表单草稿和动作 intent 一律不得新增到 query/history。既有服务端授权的 opaque detail path（包括 `/app/support/tickets/[id]`、`/admin/users/[id]`）可保留，不要求全站 ID 体系改造，但必须继续做 owner/role auth 与 referrer/analytics/log 脱敏。
8. 可恢复不等于全部 URL 化：私有/瞬时状态使用 owner-scoped server draft、session state 或内存状态；刷新后若无法安全恢复，应明确提示而不是泄露或猜测。

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
| FB-0905-34 | Schedule / Publish 一致性与主次 | P0 | 用户见到 Sandbox Board 名称，是否为其明确选择且有效的目标仍待核实；Publish 被高亮但用户主任务是排期 | Schedule/Publish 共享 destination identity/capability 规则；schedule 保存成功不等于到期 provider 发布成功；Schedule 为主 CTA |
| FB-0905-35 | Batch Edit 输入态 | P1 | 可编辑单元格像普通文字，整行大面积浅紫，用户看不出可输入 | 输入控件有清晰边界、label/focus/hover；批量状态不用整行紫色表达 |
| FB-0905-36 | Posted destination / Board 真相 | P0 | Posted 编辑行当前目标为空；历史 receipt 是否完整仍待读取核实 | Posted 由 immutable provider receipt 决定；缺失该历史 intent 所需的 destination/remote 证据才不是完整 Posted，当前 editable 目标为空不降格历史成功 |
| FB-0905-37 | Batch mixed accounts | P0/P1 | 每行重复超长 mixed-account 文案，Board 无法设置，`Publish to` 也不能选择账号 | 工具条只显示一次 compact Mixed 状态；先选账号再选其 Board；支持逐行修复或显式批量覆盖 |
| FB-0905-38 | 全局 UI 去 AI 味与交互流畅度 | P1 横切 | 巨型标题、渐变主按钮、紫色大色块、胶囊堆叠、卡片套卡片、长解释和迟钝跳变让界面模板化 | 建立克制、内容优先的 VibePin 工作台设计系统和可测的交互响应/连续性标准 |
| FB-0905-39 | Plan 批量动作 | P1；P0 条件升级 | Publish 命名与 handler/selection 语义不一致；尚未证明已向 provider 只发第一条 | 冻结完整 selection；真实发布时每条/每目标均有结果；当前编辑动作改名为 Edit selected |
| FB-0905-40 | 语义控件/模态 | P0 | 非原生交互、字段关联、focus trap/restore 与滚动 owner 不统一 | 建立可键盘完成、可聚焦、可恢复的 Field/Modal/Drawer 基础契约 |
| FB-0905-41 | 图片/长列表/CLS | P1 | 图片尺寸与失败占位不统一，大数组直接渲染 | 预留尺寸；50+ 条目分页/窗口化/渐进加载；局部失败不重置全页 |
| FB-0905-42 | URL/locale/theme | P1 | 可分享状态与私有瞬时状态边界不清，刷新/Back 恢复不一致 | 仅 allowlist 的 shareable filters/public ids 入 URL；私有 id、selection、token、草稿、未保存输入绝不入 URL |
| FB-0905-43 | 公共页/账户交互 | P1 | Auth、Pricing、Contact、Settings/Social 的异步与错误恢复不一致 | 统一字段级错误、可访问状态、可恢复 next 与局部 pending；良性操作不强制二次确认 |
| FB-0905-44 | 旧根级流程 | P1；P0 条件升级 | 旧 Dashboard/Settings/Preview 形成第二套写入 surface；尚未证明越权或错写 | 退役或安全兼容；canonical route、逐路由 query allowlist、零旧写 API |
| FB-0905-45 | Settings 假成功 | P0 | 保存失败可能显示成功 | 只有 durable local/server readback 才显示成功；否则保留 dirty/error |
| FB-0905-46 | Plan Publish 文案 | P1 | `Publish selected` 实际进入编辑 | 在 dispatch 链路完成前改名 `Edit selected`，不得夸大动作结果 |
| FB-0905-47 | Public/Auth/Legal 壳层 | P1 | `main`、skip link、focus、lang/theme 不统一 | 统一 PublicShell/LegalLayout 与无 JS/异常可恢复路径 |
| FB-0905-48 | App 状态/一致性/性能 | P1 | 筛选、详情、跨页记录和长列表恢复不一致 | 按 URL 安全矩阵、canonical lifecycle 与性能门禁验收 |
| FB-0905-49 | Settings/Admin 基础设施 | P1 | 空 modal route、双呈现、原生 confirm、表格/权限/focus 不统一 | 统一基础组件；深链不空白；按角色呈现；危险终态才确认/撤销 |
| FB-0905-50 | Auth callback 输入 | P1；若形成开放重定向/认证绕过则 P0 | cookie `next` decode 位于保护性异常处理外，畸形编码可能导致 500 | 单一 non-throwing sanitizer；query/cookie precedence、编码绕过与 callback replay 两轮 |

证据索引（同一 ID 可同时有多种证据）：

| 证据等级 | 覆盖 | 解释 |
|---|---|---|
| USER_REPORT | FB-0905-01..38 | 来自用户在历史 Preview 部署的截图/操作观察；能证明当时可见症状，不能证明当前源码根因或修复结果 |
| CONFIRMED_SOURCE | FB-0905-30/31 的请求键与 payload 路径；FB-0905-39、44..50 的明确源码结构 | 绑定 `f995a024...` 的静态事实；只证明代码形态/分支存在，不证明运行中一定触发 |
| STATIC_RISK | FB-0905-40..44、47..50 的焦点/滚动/URL/性能/hydration/权限结果，以及所有 page/non-page state gaps | 需在同一最终 runtime/deployment 做浏览器、HTTP 与 canonical readback 验证；不能写 PASS |

后续每条验证记录必须写 `evidenceType + runtime/deployment + route/surface + state + actual result`；截图不能标为 `CONFIRMED_SOURCE`，route inventory 不能标为 visual PASS。

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

`USER_REPORT`（历史部署可访问树）：至少两个失败卡在同一个卡片动作组中连续出现两个 `Edit`，不是相邻卡各一个造成的视觉错觉。本轮未现场复查；实施时仍需在最终 runtime 的组件树定位两个渲染分支，但产品裁决已确定：

- 同一卡只保留一个 canonical Edit handler，删除重复条件分支；
- accessible name 使用 `Edit {Pin title}`，保证跨卡归属明确；
- `Retry`、`Choose another board` 和 `Edit` 是不同修复动作，不得为了减少按钮而合并其业务含义。

验收：每张失败卡可见 Edit=1、可访问 Edit=1；焦点和打开的 draft id 一致；未点击 Save 的 Edit 取消不持久化该表单草稿；10 张失败卡无重复 key 或跨卡误编辑。

### FB-0905-04 至 FB-0905-15

这些问题继续由 Create Pin、Product、Reference、Multichannel 既有 PRD 的 canonical requirement 管理。本轮把截图作为当前部署的回归/未闭环证据，禁止复制新的 destination、product、recommendation、generation 或 toast 状态模型。

最低共同验收：

- 三语言、键盘、焦点恢复、390px 无横向溢出；
- 打开/关闭/切换入口不创建上传、job、placeholder、usage、schedule 或 publish；
- 所有失败保留安全 `method/path/status/code/requestId/time`，不显示原始 provider body；
- 重试复用稳定 intent 或明确创建 child intent，不能盲目重放；
- UI state、HTTP、测试 DB、Storage/usage 证据可按同一 stable id 对账。

### FB-0905-25 Published 与失败状态互相矛盾

`USER_REPORT`：历史 Preview 的 `Failed > Publish failures` 中同一卡图片主徽标显示 `Posted`，但卡片下方仍显示发布失败/需处理信息。该状态会让用户误判是否已经成功发布，按 P0 处理；本轮未声明当前部署仍复现。

要求：

- 所有卡片、Failed 子筛选、Plan、History 和详情共用一个 canonical lifecycle/result projection；projection 必须同时保留 `historical delivery receipt` 与 `current workflow/attempt` 两个维度，不能把它们压成一个易误读的 badge；
- 某个 completed intent 的全部 destination 均有可信 published receipt 时，该 intent 的 `Posted` 历史事实永久保留；后续新 intent/retry 的失败、unknown，或当前 editable destination 缺失，不得擦除历史 receipt；
- 当前 attempt 仍按 `delivery_unknown / partial / failed / published` 独立展示。部分成功必须显示 `Partially published / Needs attention` 并列出逐 destination 结果，不得把任一成功腿投影成该 attempt 全部 Posted；
- 历史回执显示精确 provider/account/Board/Page、remote id/permalink 和时间；当前 retry readiness 另显 destination 已删除、断连或 capability 失效，并提供修复入口；
- `Publish failures` 只包含当前仍需处理的 attempt，不得仅因内容曾经 Posted 而隐藏，也不得把历史 Posted 徽标放在当前失败卡的主状态位；详情中仍可见历史成功；
- retry 不得清除或改写已成功 destination 的 immutable receipt，且不得把当前目标配置反向写进历史 receipt。

验收：全成功、全失败、部分成功、超时未知、失败后重试成功、历史 Posted 后新 attempt 失败各两轮；卡片/筛选/count/Plan/详情一致；无重复 provider dispatch、usage 或 receipt 丢失。

### FB-0905-26 Retry 后没有 destination 的修复死路

`USER_REPORT`：历史 Preview 中失败卡点击 Retry 后打开 `Confirm publishing destinations`，显示 `No saved publishing destination`、两行红色说明和禁用的 `Publish now to 0 destination(s)`；弹窗内没有明显修复入口。本轮未现场复查。

要求：

- 0 个可发布 destination 时继续 fail closed，不得恢复任何默认 Pinterest/account/Board/Page；
- 把散落红字替换为结构化 action-required 区域，明确原因并提供主操作 `Choose publishing destinations` 或 `Edit destinations`；
- 主操作必须携带当前 draft/content/attempt 上下文进入 canonical destination picker；保存后回到同一确认弹窗并显示精确 provider、account、Board/Page；
- stale、deleted、disconnected、owner-mismatch 和 capability-disabled 分别给出安全原因和对应修复入口；
- `Retry` 不能直接 dispatch；destination 修复后必须再次由用户确认；关闭发布确认本身不创建 publish/schedule/usage/provider side effect。嵌套 picker 中用户已经明确 Save 的 destination 编辑可以保留，不能把整个先前工作流概括为“零 DB 写”；
- 卡片保留一个 canonical `Edit`，不得因 destination 修复再生成第二个同名按钮。

验收：无保存目标、已删除 Board、断开的 connection、部分 destination 可用、修复后重新确认、取消修复、篡改/stale receipt 各两轮；0 destination 始终 0 provider call/0 usage；保存后的目标与最终 receipt 一致。

## 6.1 Reference / Pin Ideas 详细要求

### FB-0905-30 Choose Pin References 内的商品相关推荐与刷新

`USER_REPORT`：picker 的 `Pin Ideas` 长期显示看似固定的一批图片；用户切换商品后仍观察到相同内容。截图不能单独证明后端从未刷新。

`CONFIRMED_SOURCE`（绑定源码基线）的请求/缓存缺口：

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
- 手动刷新不应重复已选项，不创建 generation job、generation reservation 或 generation usage，也不改变已保存 reference；若 recommendation provider 本身计量，必须在调用前显示其独立额度/计费语义并以 recommendation meter 单独记账，不能混入 AI image usage；
- 空态区分“暂无匹配推荐”“正在刷新”“登录/权限问题”“服务错误”，均提供正确下一步。

验收：商品 A→B→A、同商品缓存命中、TTL 到期、手动刷新、旧响应晚到、离线旧缓存、空集、401/403/429/5xx、28 条固定 fixture 去重各两轮；核对 UI、HTTP fingerprint、cache provenance 与 selection/linkback；390px 无重复外层推荐或横向溢出。

预期 affected files：`usePinIdeas.ts`、`pinIdeas.ts`、`InlineCreateAssetPicker.tsx`、`api/reference-candidates/route.ts`、`AiVersionDrawer.tsx`、`recommendationRequest.ts`、`referenceServe.ts` 和相关 analytics/tests；`viral-pins` 仅保留有时限、可识别的兼容 fallback，不再充当商品推荐主源。

### FB-0905-31 只有产品图、未选择 Reference 时生成失败

`USER_REPORT`：用户仅选择产品图、未手动选择 Reference，点击生成 2 个 Pin 后新增两个失败 slot；截图能证明该历史 attempt 整组失败，但不能单独确定根因。

`CONFIRMED_SOURCE`：当前 selection planner 在零 Reference 时建立 `reference=null` group，payload 允许 `style_ref:null`，Generate gate 也不要求 Reference；因此不能把本次失败归因为“前端隐式必填”。商品图读取、provider/worker、usage/limit 或服务端任务都仍只是候选，必须取得同一 attempt 的脱敏 terminal code/status/requestId 后才能定根因。

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
- 全失败、部分成功和结果未知使用唯一稳定 toast/state；主界面只显示短原因与下一步，`stage/code/requestId/time/model` 进入折叠诊断或 `Copy support details`，不在卡片主路径堆技术字段；
- 确定失败需释放 reservation/placeholder 并只结算实际完成 usage；unknown 保留可恢复状态，不允许盲目再次扣费；
- Retry 复用或派生可追溯 intent，默认保留本次 product/direction/mode；用户可在重试前进入 Reference picker 修正。

验收：selected reference、auto-match 命中、auto-match 空集、recommendation 429/5xx/timeout、product+direction only、无效商品图、provider 单 slot 失败、两 slot 全失败、double-loss unknown、刷新后恢复和双击 Generate 各两轮；核对 UI/HTTP/job/slot/placeholder/reservation/usage 同一 intent，确保 2 个 Pin 不会因“未手选 Reference”整组失败或重复计费。

### FB-0905-32 Publishing accounts 展开后页面无法滚动

`USER_REPORT`：历史 Preview 在 `Studio?filter=unscheduled` 的 1007×632 视口中展开 `Publishing accounts` 后无法继续下拉，底部内容不可达；最终 runtime 仍需复现与修复后两轮。

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

`USER_REPORT`：历史 Preview 的确认页在 0 destination 时连续显示多行红色说明，主按钮仍占强视觉位置但不可用；Pinterest Board 被隐藏在深层编辑中。

要求：

- 弹窗只保留一句紧邻 destination 区域的轻量说明，例如 `Choose a destination to continue.`，使用低饱和 warning/neutral，不使用大片红色或重复解释；
- 提供一个明确主操作 `Choose destinations`，点击后就地打开 canonical destination/account/Board 选择，不要求用户猜测返回哪个页面；
- Title、media、destination 与 provider account 位于主编辑区；其余必填字段必须由“provider + action + media type + 当前 capability snapshot”计算。Pinterest 发布/排期需要 Board 时显示 Board；Facebook 仅在目标模型需要 Page 时显示 Page；Instagram/Facebook 不得被全局强制填写 Description、URL 或 Pinterest Board。`More details` 只能容纳该能力下真正可选的 alt text、product/link、内部审计等；
- 哪个字段缺失就在哪个字段下显示短错误并聚焦/滚入可见范围，顶部只允许一条 compact summary；
- disabled CTA 文案不显示 `0 destination(s)` 这类系统计数，应显示用户动作，例如 `Choose a destination`；
- 修复字段后错误原位消失，不需要关闭弹窗重来；Cancel/Escape/X/backdrop 不触发本次 publish/schedule/usage/provider action；已明确保存的独立字段编辑按其自身 Save contract 处理。

验收：缺 destination、缺 Pinterest Board、缺 Facebook Page、断开的账号、多个字段同时缺失、修复后提交、取消修复各两轮；桌面/390 只出现一个 summary，每个缺失字段一个短提示，键盘可直接抵达。

### FB-0905-34 Schedule/Publish 共用前置校验，Schedule 为主 CTA

`USER_REPORT`：用户在历史 Preview 观察到发布失败的内容仍提示 `Scheduled to VibePin Sandbox Demo Board`；页面同时把 Publish 做成粉紫高亮，而用户的主要工作流是先排期。名称只证明需要核对来源，不单独证明 Board 无效。

要求：

- Schedule 保存与 Publish now 共用 destination/account identity、字段 schema 和禁止默认回退的规则，但不是同一个时间点的成功含义：保存时验证“可被排期”并冻结 schedule intent/revision；到期执行时必须重新读取连接、provider/action capability、Board/Page 可用性与内容 revision；
- QA/Sandbox 命名本身不能判定目标无效：用户明确选择、owner-scoped 且 capability 有效的真实测试 Board 可以使用；禁止的是隐藏 fixture、跨 owner 目标或系统自动 fallback。发现 legacy 自动目标时标记 `Needs attention` 并要求重选；
- 只有 schedule intent 与 canonical readback 成功后整卡当前工作流状态才为 `Scheduled`；这只证明 VibePin 已保存排期，不证明 provider 已发布。到期后转为 `dispatching/published/partial/failed/delivery_unknown`；旧 attempt 仍保留在 History/attempt details，不覆盖当前主徽标；
- 如果已有 destination 的部分成功或 unknown receipt，Schedule 必须保护已发布腿并明确本次仅作用于哪些未发布目标；保存时允许的目标若到期时 capability 失效，必须 fail closed 为 action-required/failed，不得因“排期保存成功”继续发送；
- Studio 卡片、Batch Edit 和确认弹窗统一 CTA 层级：`Schedule` 使用唯一品牌主色；`Publish now` 使用中性次级按钮；破坏性操作保持独立；
- 默认焦点和 Enter 不得意外触发 Publish now；任何实际 Schedule/Publish 仍需显示精确目标与时间的确认。

验收：同一 draft 的 Schedule/Publish capability 对照、无 Board、用户明确选择且有效的 test Board、隐藏 fixture fallback、断开账号、部分成功、unknown、排期保存与到期执行的状态迁移、CTA 视觉和键盘 Enter 各两轮；无默认 destination、无重复 dispatch/usage。

媒体身份必须与 Website URL 分开：Website URL 是可选商家落地页；受保护 render URL 只供 owner-scoped UI 预览；媒体 source identity 指向私有原始对象；provider delivery asset 只为某次 intent/destination 在 dispatch 边界生成。Schedule 保存只冻结 source provenance/checksum、内容 revision、目标与时间，不签发 URL、不复制 public asset；到期执行通过 live capability 后才 materialize。确认页取消本身不得创建 intent/materialization/usage/provider call；但用户在嵌套 picker 中明确点击 Save 的 destination 编辑可以独立持久化，返回确认页后仍需再次确认本次发布。历史 receipt、DB 或日志永不保存 signed URL/token/query。

实际 Schedule 点击不必机械打开大型 modal：当目标、时间与影响已在当前 surface 清楚可见时，可用紧邻 CTA 的确认摘要或轻量确认；多目标、覆盖、冲突、外部立即发布等高风险动作再使用完整 dialog。

### FB-0905-35 至 FB-0905-37 Batch Edit 输入、Posted 真相和 mixed accounts

Batch Edit 是高密度编辑器，不是数据展示表。要求：

- 可编辑的 Title、Description、URL、Alt text、Product、Publish to、Board 和 Publish time 使用明确输入边界、label/placeholder、hover 和 focus ring；只读 receipt 使用不同视觉语义；
- 删除整行浅紫背景，选中状态只在行首 selection marker/细边框表达；品牌紫只用于主 CTA、焦点或少量状态；
- Posted 内容的 provider/account/Board/Page 来自 immutable historical publish receipt；完整 Posted 历史回执独立持久化，即使当前 editable destination 被删除、connection 断开或 retry 无可用目标，也不得消失或降格。当前“能否编辑/再次发布”与历史“曾发布成功”是两个维度；
- Posted 行默认只读展示已发布目标和 permalink；缺失当前 editable destination 只影响新的 retry/republish 能力，不得擦除已有 remote id/permalink。“未来再发布/排期到新目标”必须创建明确的新 intent，不能覆盖历史 receipt；
- mixed-account 批选时，Board 单元格显示短状态 `Mixed accounts`，完整原因只在工具条/侧栏出现一次；不得在每行重复长段落；
- `Publish to` 必须能打开 canonical account selector。用户先选择 provider account，再只显示属于该账号的 Board/Page；账号变化必须清空不兼容 Board；
- 用户可选择只编辑同一账号的行、逐行修复，或明确将全部未发布行覆盖到一个新账号；已发布/unknown 腿不可被批量覆盖；
- 横向表格需有冻结的 Content/selection 列、可见滚动提示和正确焦点保持，390px 改为 stacked editor，不压缩成不可读表格。

验收：同账号批量、两个 Pinterest 账号、Pinterest+Facebook、mixed Board、Posted 单腿/双腿/部分成功/unknown、账号切换清 Board、逐行编辑、显式批量覆盖、取消和 390px 各两轮；不得出现重复长错误、空账号选择器或 receipt 被改写。

## 6.2 FB-0905-38 VibePin 全局 UI 与交互体验基线

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

- 字体先复用现有本地/系统栈 `-apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", sans-serif`，不得为“重设计”增加网络字体或产生 FOIT；品牌图形复用 `public/logo.png`、`logo-mark.svg` 与既有 favicon，除非另有品牌资产评审；
- 颜色以中性 surface、清晰文本层级和细分隔线为主；品牌紫只用于当前选择、键盘 focus 和每个 surface 唯一的主操作；正文与背景至少 4.5:1，大字至少 3:1，控件边界/focus/状态图形至少 3:1；
- Schedule 是 Studio 的主要任务色，Publish now 为次级；warning/error 只占必要范围，不铺满整卡；
- authenticated app 使用 `12/16 caption`、`14/20 secondary`、`16/24 body/control`、`20/28 section`、`24/32 mobile h1`、`28–32/36 desktop h1` 的受控 type scale；常规正文 400/500、label 600、标题 650–700，不靠随意加粗；
- spacing 使用 4px 基础栅格：字段内距至少 8/12，字段组 16，面板段落 24，一级页面区块 32；桌面内容 gutter 24–32，390px gutter 16；圆角只允许 6/8/12 三档，弹窗/抽屉不额外放大；
- 控件高度桌面至少 36px，触控目标至少 44×44px；输入框、选择器、只读值、链接和按钮必须一眼可区分；同一动作在所有 surface 使用同一名称；
- focus ring 使用可见 2px 外环并与相邻色达到 3:1；不得以 `outline:none`、阴影或纯色变替代；全局规则存在也要验证局部 inline/style 是否覆盖；
- 组件优先使用真实内容结构、分隔线和留白，避免为了“高级感”增加无意义容器；
- 每个页面最多一个视觉 signature；Studio 的 signature 是内容媒体与排期状态，不再额外堆叠渐变装饰。

### 丝滑交互标准

- 点击后 100ms 内必须出现 pressed/pending/optimistic-safe 反馈；500ms 是面板动效时长上限，不是阻塞交互的许可。任何动画期间关闭、取消、滚动和无冲突的输入均保持可用；
- motion token：即时反馈 100ms、hover/focus 120–150ms、小菜单 180–220ms、drawer/modal 240–320ms、退出 160–220ms；仅特殊编排可到 500ms，且不得阻塞。只动画 opacity/transform，禁止 `transition: all` 与布局抖动；`prefers-reduced-motion` 下位移/持续动画降为 0–50ms 的非运动状态切换；
- 筛选、展开、切 tab、返回后保留滚动位置、输入草稿、selection 和焦点；异步旧响应不得覆盖新状态；
- skeleton 与真实布局尺寸一致，图片加载失败不引发 card 跳高；按钮 pending 时保持宽度；
- 安全的本地编辑可 optimistic update；发布、排期、扣额度等外部副作用必须等待可信 receipt；
- 错误优先就地显示并提供一个下一步；toast 只承担跨页面或后台完成，不与 field error 重复；
- hover 是补充，不承载唯一功能；键盘、触控和 390px 拥有等价路径；
- 连续操作应支持撤销/返回，不重复打开相同 drawer、不丢上下文、不出现多个 competing spinner/toast。

全局验收：建立 desktop 1440/1280/1007 与 mobile 390 的 golden screenshots；关键任务 `选择内容→补字段→选目标→排期` 两轮计时；记录输入反馈 ≤100ms、局部 pending ≤300ms 出现、布局位移、scroll/focus restore、重复 toast、慢速/错误状态。截图是人工比对证据，不能以未经测量的“98% match”等假百分比代替 diff 或验收记录。

设计审查能力：

- 当前已使用本机 `frontend-design` skill，把“去 AI 味”落实为克制的 token、单一视觉 signature、真实内容结构和明确文案；
- root 本轮已在线读取官方 `web-interface-guidelines` 最新规则；Astra 同时使用本机已安装的 skill 说明落实语义/a11y/响应式门禁。该读取是规则资料获取，不是产品浏览器验收；64 个入口登记仍不是运行 PASS；
- 当前已使用 `interaction-design` 检查任务流、状态连续性和微交互；它提供审查标准和状态契约，但不能替代真实用户两轮验收；
- 新 skill 在安装前先审计来源和指令；执行模型可按 checklist 修改，root 与 Astra 独立 reviewer 必须复核截图、状态机和最终 diff。

## 6.3 Product Opportunities 详细要求

### FB-0905-27 工作台标题统一收紧

`Product Opportunities` 当前使用接近营销 Hero 的字号，占据过多首屏。该规则适用于登录后的 app 页面，不改变 Landing 的品牌 Hero：

- 建立共享 app page-header token，桌面标题建议不超过 32px，390px 不超过 24px；
- eyebrow、标题、说明和主操作保持紧凑节奏，首屏优先露出业务数据与工具；
- Studio、Products、Analytics、Settings 等登录后页面逐页盘点，禁止各自复制巨大标题；
- 标题仍为唯一页面 `h1`，缩小视觉尺寸不能破坏语义或可访问性。

验收：所有 authenticated 一级页面在 1440、1280、390 两轮截图；标题层级一致、无截断/重叠，首屏可看到主要工具或首行数据；Landing Hero 不被误改。

### FB-0905-28 Product 数据空态必须诚实

当前 `Digital` 筛选下显示 `No products match these filters`。该文案只允许用于“canonical API 成功返回且基础 catalog 非空，但当前筛选结果为 0”的场景。

`CONFIRMED_SOURCE`：绑定源码页面没有完整消费 SWR/error 状态，兼容 API 失败后可能进入 fallback 并把错误投影成空数组；因此尚无同部署 HTTP 证据前，不能把截图直接判定为“Digital 确实没有商品”。Product 权威 PRD的四态要求继续为准。

要求：

- `filtered_empty`：显示当前条件摘要、`Clear filters` 和切换到 `All products`；
- `catalog_empty`：说明目前还没有可用 Product Opportunities，并显示数据新鲜度/同步状态和下一步；
- `loading/refreshing`：使用稳定 skeleton 或进度文案，不提前显示空态；
- `unauthenticated/forbidden`：走登录或权限恢复，不显示空数据；
- `API/sync/error`：主界面显示短原因和 Retry，不拿空数组吞掉错误；安全 `code/requestId/time/runtime/deployment` 只进入折叠诊断、support copy 或测试证据；
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

验收：邮箱密码与 Google 各两轮；`next=/pricing`、`next=/app/studio`、缺失 next、恶意 external next；刷新目标页 session 仍有效；浏览器 back 不重复 callback；console 无 auth loop。正常 HTTPS OAuth authorize/callback 请求可以按协议短暂携带一次性 `code/state`；日志、截图、analytics、referrer、错误 UI 和 callback 后最终目标 URL 不得保留或泄露它们。

## 8. Pricing / Creem Test 详细要求

### FB-0905-17 Creem Test Payment Error

`USER_REPORT`：用户曾从绑定历史 Preview 的 Pricing 进入某次 Creem Test checkout session，第三方页面显示 `Payment Error` 和 `An unknown error occurred`。这证明该次历史 session 失败，不证明本轮 checkout 当前活性；也不能仅凭页面猜测是付款失败、产品失效、session 过期还是 return URL/config 错误。

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

四个测试账号历史上已获用户授权；本轮仅编辑文档，不创建账号、不 seed、不改测试 DB。正式执行时仍须绑定同一个明确的测试 Supabase ref 并证明它不是 Production。

### 10.1.1 当前源码事实与待统一项

| 能力 | 展示配置事实 | 当前 enforcement / readback | 本轮裁决 |
|---|---|---|---|
| AI images / 月 | `server/planEntitlements.ts`：10 / 150 / 800 / 3000 | `usage_accounts` period snapshot + reservation/settlement；Usage API 返回 included、effective limit、settled used | 四套餐两轮测 0、limit-1、limit、over-limit；失败/释放/部分结算不得多扣 |
| Scheduled posts / 月 | 5 / 150 / 300 / Unlimited | 同一 usage account 独立 bucket；`null` 表示 unlimited；一次 Content 跨渠道计 1 | 有限套餐测边界；Business 不做 limit-1/limit，改测多次操作始终无 cap 且 usage 仍可观测 |
| AI text generations / 月 | server registry 与 Usage API `included` 为 20 / 500 / 2000 / 10000，虽 registry 注释仍称“未发布” | period 初始化会把该数字 snapshot 到 `usage_accounts`；但 legacy `lib/planEntitlements.ts` 对该 bucket 返回 `null`，生成路径还受 `meterGeneration.ts` 原子 flag/mode 影响 | 登记为 cross-source/path-mode ambiguity；不得笼统宣称“全局已 enforcement”或“全局不 enforcement”，实现前列出每个真实 action path 与运行模式 |
| Accounts / platform | 1 / 1 / 2 / 3 | server account allowance；连接动作前与 callback 时复核 | 属 feature cap，不是可消耗 credit；测试已有账号、上限、超限和 reconnect |
| Shopify stores | 0 / 1 / 2 / 3 | server entitlement；product sync 0 / 100 / 500 / 1000 且可有 env override | 属 feature/capacity entitlement；需把 effective override 与展示差异单独报告 |
| Product Opportunities | Free 10，其他套餐 full (`null`) | Product API gate | 属 catalog access，不进入 Usage progress bar |

套餐解析不能由测试客户端直接声称。当前绑定源码的解析顺序是：最高等级的有效 Creem grant（active/trialing 或未到期 scheduled-cancel）→ service-role 可写的 `app_metadata.plan` 缓存 fallback → Free；另有明确 whitelist 的 Pro floor。正式 E2E 必须通过受信任的 test fixture/服务端管理路径形成可审计事实，不使用 `user_metadata`，也不把 `app_metadata.plan` 简化成唯一 authority。

Usage UI 必须区分：

- `included`：当前 canonical plan config 宣称包含的额度；
- `limit`：当前 period snapshot 配置上限；是否实际阻断由 effective mode 与 per-usage-type flag/action path 共同决定；
- `used`：settled usage，不含仍可释放的 reservation；
- `reserved`：仅用于执行/诊断证据，不得伪装成已用；
- `unmetered`：尚无 account row，`used=null`，不得伪造 0；
- `unlimited`：`limit=null` 且可计量，绝不渲染为 0/NaN；
- `shadow`：计量或拒绝是否处于 shadow 必须由真实 server 配置证明；本验收不切换 enforcement 模式。

AI text 与其他 meter 在执行前必须建立 action-path matrix，至少列：UI 动作/API route → allowance resolver → period snapshot → reserve/meter/settle helper → shadow/enforce flag → provider-before/after 顺序。`/api/billing/usage` 返回的 included 数字只证明展示配置；period snapshot 只证明账户上限被记录；二者都不能单独证明某条 generation 路径会拒绝超限。若真实 Preview 处于 shadow，超限未阻断应记录为“当前模式观察”，不能当作产品 FAIL；同时用纯 enforcement fixture 证明未来阻断分支，四账号 × 两轮真实 Preview 仍不得用 mock 替代。

### 10.1.2 执行边界与步骤

- 测试数据全部绑定唯一 `runid` 和 owner；账号格式可使用 `e2e-credit-{plan}-{runid}@vibepin.test`，不复用真实用户；
- 不靠真实 provider 生成数百/数千张图片。通过已有、受审计且 owner-scoped 的测试 fixture/API 设置 period snapshot 和 counters；若不存在这样的入口则标 `NOT EXECUTED`，不得临时假造 generic consume endpoint；
- 随机密码、service-role key、session/token、owner id 不写日志、截图、URL、报告或仓库；网络层允许浏览器正常携带安全 cookie/header，但证据导出必须脱敏，不能承诺“网络中没有 token”；
- 每次 seed、reservation、settlement、release、测试与 cleanup 绑定同一 runid，只能清理该 run 的合成数据；
- rollover 以服务端当前定义的 period/timezone 和 `period_start/end` 为准，测试月界、升级/降级中途 snapshot 变化与 bonus images，不能只测静态总数。

每个有限 bucket、每个套餐、每轮执行：

1. 登录并核对安全目标路径、session owner、resolved plan、period 与 Usage `metered/unmetered`；
2. Pricing、Billing、Usage 对照展示 registry、period snapshot、env override 和当前 mode 的 effective enforcement；允许有契约明确、可追溯的 snapshot/override 差异，只有未经解释或不符合同一 action-path/mode contract 的差异才 FAIL，不以 UI 文案自证；
3. 验证 0 或 unmetered 状态；设置到 `limit-1` 后执行真实最小产品动作，核对 reserve → provider/job → settle/release 的顺序；
4. 达到 limit 后再次发起产品动作：真实 `enforce` 路径必须在 provider request/job/placeholder/usage side effect 前返回明确 `limit_reached`；真实 Preview 若处于 `shadow`，只记录 provider/usage 实际观察，不把“未阻断”误判为产品 FAIL，并用纯 enforcement fixture 单独证明未来阻断分支；不是调用臆造的“纯测试消费入口”；
5. 覆盖 response lost、并发双击、部分成功、确定失败和 reservation expiry：settled 数量等于实际完成单元，失败释放，unknown 不盲扣/盲重试；
6. Business scheduled posts 另测 `Unlimited` 展示、可观测 used、重复计划/发布与跨周期，不执行不存在的 limit-1；
7. Accounts/Shopify/Product catalog 以 feature-cap 用例单列，不与 credit counter 相加；
8. 登出并切换账号，验证 UI/HTTP/DB 证据 owner 隔离；第二轮使用新 session，不复用旧页面状态。

报告必须覆盖 Free/Starter/Pro/Business × 2 轮，并为每轮列出 `PASS / FAIL / NOT EXECUTED`、默认/near-limit/exhausted/error 截图、HTTP status/code/requestId、DB before/after、reservation/settlement/release、provider request count、console、预期/实际和 cleanup。实际 `enforce` 路径的超限与所有 capability/auth 等前置失败必须证明 provider request count=0；`shadow` 路径按真实观察报告并与纯 enforcement fixture 分栏，不得混写。示意 quota 数字或 mock 截图不得冒充 Preview 证据。

## 11. 实施顺序

当前阶段为 Phase 0，等待用户继续提交反馈。

1. Phase 0：持续收集、去重、只读根因和 affected files。
2. Phase 1：用户确认开始实施后，各 owner 在独立 worktree 完成最小修复。
3. Phase 2：每个 owner 完成两轮 focused tests、scoped ESLint、typecheck、registry 和必要 build。
4. Phase 3：root 与 Astra 独立 reviewer 审查安全、状态机、数据归属和跨模块 seam。
5. Phase 4：root 冻结唯一 successor manifest，fresh build 并仅部署 Preview。
6. Phase 5：桌面与 390px 两轮 USER 验收；有副作用步骤逐项单独授权。

## 12. 放行条件

- 所有 P0 在同一最终 runtime/deployment 上有代码门禁和当前 USER 证据；
- P1 有关闭证据或用户接受的明确延期；
- 粉色合法图片反例、相邻卡 Edit 归属和 Creem Test 8 映射均覆盖；
- 无真实付款、无未确认 provider publish、无 Production DB/env/Storage/OAuth 修改；
- 最终结论仍由 root 与 Astra 独立 reviewer 复核，不能由执行会话自评替代。

截至第 12 节的滚动反馈结论：`COLLECTING_FEEDBACK / IMPLEMENTATION_NOT_STARTED / READY_FOR_PRODUCTION: NO`。

## 13. Skill 驱动的全局 UI / 交互审查

### 13.1 审查基线与方法

本轮只读审查绑定源码基线 `f995a0249865c65ea448b88186724b9cc7141e84`。部署号只来自历史回执；本轮没有浏览器现场复查 alias、截图或当前视觉状态，也没有改产品代码、数据库、环境变量或 Production。以下表格中的“需整改”表示 requirement/risk 已登记，不是已复现或已修复。

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
| Pricing / Creem | 月年切换、年度总价、CTA、错误返回、周期恢复 | 历史某次 Test checkout 失败；本轮未重测当前活性 |
| Contact | 字段错误、发送成功、焦点与下一步 | 需整改 |
| App shell / Settings | 深链、模态、菜单、主题/语言、关闭后返回 | 需整改 |
| Social / Destination | connection → account → Page/Board、错误恢复 | 需整改；禁止默认回退 |
| Product Opportunities | 标题、筛选、四态空态、URL 状态、图片性能 | 需整改 |
| Product / Pin Ideas Picker | 产品/参考图来源、可选择语义、长列表 | 需整改 |
| AI Create / Reference | product-aware 推荐、无 Reference 生成、禁用原因、恢复 | 需整改 |
| Studio Cards | 必填字段、Board、轻量错误、CTA 层级、图片 fallback | 需整改 |
| Batch Edit | 输入可识别、混合账号、Board、逐目的地结果 | 需整改 |
| Plan / Schedule | 排期优先、批量动作、键盘、发布一致性 | selection/editor 动作语义缺口为 P1；仅在实测错发/漏发时升 P0 |
| Publish / Retry / History | 确认、幂等、逐目的地回执、Posted/Failed 一致 | 需整改 |
| Billing / Usage / Credits | loading/error/empty、四套餐额度、limit reached | 需真实两轮验收 |
| 全局质量 | i18n、RTL、390px、a11y、reduced motion、CLS、长列表 | 需建立统一门禁 |

“已审查”不等于“已实现”或“已通过 USER 验收”。本矩阵只用于确保没有遗漏关键功能。

### 13.3 新增 P0/P1 缺口

#### FB-0905-39 Plan 批量 Publish 的 selection 与动作语义不一致（P1；有错发/漏发才升 P0）

`CONFIRMED_SOURCE`：`PlanListView.tsx` 的 eligibility 使用 selection `.some(...)`，后续又用 `.find(...)` 取单个非 Posted draft；`WeeklyPlanWorkspace.tsx` 的 `Publish selected` handler 实际进入 calendar/edit draft 流程。源码证明的是“批量命名、完整 selection 与编辑 handler 不一致”，不证明已经向 provider 只 dispatch 第一条。若运行验证发现漏发、错发或 selection 未经确认即 dispatch，升级 P0。

要求：

- 当前 handler 若只打开批量/日历编辑，按钮必须命名 `Edit selected` 或更准确的动作；只有真正进入发布时才使用 Publish；
- 真正的批量 Publish 必须对完整 selection 冻结 snapshot，逐条建立稳定 intent/idempotency key；
- 确认页展示每条 Pin、每个 provider/account/Page/Board 和 now/schedule 模式；
- 任意条目缺 destination/Board 时禁止静默丢弃，必须标记 `action_required`；
- 终态聚合为 all success / partial / all failed / unknown，并保留逐条、逐目的地回执；
- Cancel/Escape/close/backdrop 为零 provider dispatch；重复确认不能重复 job、usage 或远端发布。

验收：1/2/5 条、混合 Posted/Failed/Draft、混合有效/无 destination、重复点击、超时后恢复各两轮；selection 中每条都必须有可追溯结果。

#### FB-0905-40 语义控件、键盘和模态基础设施（P0）

以下是 `CONFIRMED_SOURCE` 的局部结构或 `STATIC_RISK`，不等于运行中的键盘失败已经全部复现。全局 `globals.css` 已有 `:focus-visible` 基础；局部 `outline:none`、inline style、portal/overlay 仍需逐项验证是否覆盖或破坏它：

- `InlineCreateAssetPicker.tsx:385-445`：卡片选择不是原生按钮，缺 `aria-pressed`；
- `PlanListView.tsx:273,304,312`：可点击容器缺键盘语义；
- `BatchEditDrawer.tsx:408`：图标关闭按钮缺可访问名称；
- `DraftDetailsDrawer.tsx`、`BatchEditDrawer.tsx`、`AiVersionDrawer.tsx`：可见 dialog/backdrop/close 分支存在；focus trap、restore、background inert 和异常卸载后的 scroll unlock 标为 `STATIC_RISK`，需运行验证；
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

`CONFIRMED_SOURCE`：Product/Pin Ideas/Reference 与 Plan/Batch 多处大数组直接 `.map()`，没有统一的 50+ 策略。若图片已有固定 CSS width/height/aspect-ratio，可能已经预留空间；缺 HTML `width/height` 只作为稳定尺寸与响应式审查项，不能单凭源码宣称已经发生 CLS：

- `InlineCreateAssetPicker.tsx:563-581,1503-1521`、`PlanListView.tsx:256`、`BatchEditDrawer.tsx:1611`：大数组直接映射；
- `ProductImageSurface.tsx`、`DraftDetailsDrawer.tsx`、`PlanListView.tsx`、`BatchEditDrawer.tsx`：核对固定容器、CSS aspect-ratio、响应式 source sizes、loading priority 与失败状态是否共同避免 layout shift。

要求：

- 超过 50 个条目使用分页、窗口化或渐进加载；滚动时不能整页重排；
- 图片在请求前预留 aspect ratio/width/height，非首屏 lazy load，首屏主图才允许高优先级；
- decode/timeout/tiny/unsupported fallback 不改变卡片尺寸；
- 搜索、筛选、刷新保留滚动锚点和已选项；数据更新只替换受影响条目；
- skeleton 与真实内容同尺寸，避免 CLS；失败可单项重试，不重置整个列表。

验收：28、60、120、500 条；慢图、404、decode fail、10s timeout；滚动中筛选/刷新/选中；桌面与 390px 各两轮，并记录 CLS、长任务和交互延迟。

#### FB-0905-42 可恢复 URL 状态与统一 locale/theme（P1）

URL 只承载可分享、无副作用、无隐私的导航状态。`STATIC_RISK`：Pricing 周期、Product/Discover/Trends 的一部分筛选、Settings 子页和公开详情 deep link 的恢复模型不统一；但“可恢复”不能被解释为把全部 UI state 塞进 query。

要求：

- allowlist 可包含：Pricing `period=month|year`、无敏感值的 filter/sort/view/page、公开且经授权可分享的 content/category/article id、Settings tab 枚举；每条 route 都要定义 name/type/最大长度/default/canonical serialization；
- 新增 query/history 禁止包含：selection ids、owner/workspace/user id、私有 draft/task/job/attempt/destination/connection id、OAuth code/state/token/session、checkout session、私有媒体 URL、未保存 Title/Description/URL/Creative direction、表单 dirty 内容或 provider request payload；既有、服务端授权且脱敏的 opaque detail path 按 §4 例外保留；
- 搜索词只有在产品明确允许分享、长度受限、去除控制字符且不含私密内容时才可入 URL；默认使用本地 state，用户主动“复制筛选链接”时再生成 allowlisted URL；
- Settings 从哪个页面打开可由受控 history state/session referrer token 恢复；不得把私有来源 id 复制进 URL。不可安全恢复时关闭到 canonical app fallback 并给出短说明；
- 已保存 `lang/dir/theme` 在 hydration 前应用，避免先英文后中文、LTR/RTL 闪烁和暗色原生控件失配；
- 日期、时间、数字、价格统一通过 `Intl.*`；禁止散落的 `en-US` 硬编码；
- Back/Forward 不重放 provider action、checkout、generation、schedule、publish 或 OAuth callback，只恢复 allowlisted UI state；未知 query 被丢弃并 canonical replace，不透传到 redirect target。

验收：刷新、复制链接、新标签、Back/Forward、登录前后、恶意/超长/重复/双重编码 query、en/zh-CN/zh-TW/RTL、浅色/深色/系统模式各两轮；浏览器地址、history、analytics、日志和截图中均无上述禁止字段。

#### FB-0905-43 公共页面与账户流程的精细交互（P1）

补充要求：

- Auth：idle → validating → submitting → success/failure；Google/OAuth 需有跳转中、弹窗未打开、provider 拒绝和可重试状态；密码重置成功禁止使用浏览器 `alert()`；
- Signup：Terms/Privacy 必须是真实可达链接，不能使用 `href="#"`；
- Pricing：月/年切换使用 radiogroup 或等价语义并同步 URL；年付同时显示 `USD $X/month, billed annually as USD $Y/year`；只有当前卡片进入 loading；
- Contact：字段错误内联；成功态是紧凑、可聚焦、有下一步的确认组件；
- Settings：切 tab 不重置内容滚动；有 dirty state 时关闭需明确处理；
- Social：Page ID/URL 使用正确 input type/name/autocomplete/inputMode；Page/Board 加载失败在当前行内恢复，不只弹 toast；
- Landing：禁止 `transition: all`；公共入场与菜单遵循 reduced-motion；主题和语言控制与工作台同源。
- 确认只用于不可逆、外部副作用、高风险覆盖或用户会失去未保存内容的动作；筛选、打开详情、保存可安全撤销的本地偏好等良性动作不得机械增加确认弹窗。

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

- 动效时长只引用 §6.2 的唯一 motion token：即时反馈 100ms、hover/focus 120–150ms、小菜单 180–220ms、drawer/modal 240–320ms、退出 160–220ms；特殊编排上限 500ms 且不得阻塞；本节不定义第二套范围；
- 只动画 `opacity` 和 `transform`，禁止 `transition: all` 及布局属性动画；
- 动画必须可中断，快速重复操作以用户最后一次意图为准；
- 超过 300ms 的操作显示局部 progress；页面其余区域保持可读，不能全屏假死；
- 乐观更新只用于可安全回滚的本地状态；publish、schedule、checkout、credit 等副作用必须等待服务端事实；
- drawer/modal 开关保留焦点、滚动和 selection；失败不清空已填内容；
- 同一异步 attempt 只更新一个稳定 toast/status，不允许 success 与 error 同时出现；
- `prefers-reduced-motion` 下取消位移和持续动画，但保留立即可辨识的状态变化。

### 13.6 全局 UI 验收锚点

- `UI-A01`：每个界面只有一个视觉主任务；Schedule 为 Create Pin 的 primary，Publish 为 secondary。
- `UI-A02`：所有发布目标都需要精确、已连接且 owner-scoped 的 account 与兼容 media；Pinterest 在 capability 要求时必须选 Board，Facebook 按 canonical target model 选择 Page/account，Instagram 不需要 Board。Title、Description、Website URL 默认可选，仅在某 provider/action capability 明确要求时就地升级为必填；Details 只放当前能力下的高级/可选项。
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

### 13.7 线框范围、映射与证据边界

本 PRD 的第一、二张图只定义八个重点面板，不代表全部页面视觉稿：

- A Studio scheduling：默认无账号 fail-closed；精确 account；仅 Pinterest 显示 required Board；Schedule primary；
- B Batch readiness：明确输入边界、mixed account 摘要、逐行 readiness/结果；
- C AI setup + nested Choose Pin References：外层 setup 与内层 picker 的层级、product-aware 推荐、刷新/旧缓存/禁用原因；
- D Product Opportunities：紧凑 header、同一 filter surface、真实 filtered-empty；
- E Auth recovery：email/Google 的字段级错误、安全 next、fallback；
- F Pricing：月/年、年付总额和 source-bound 套餐事实；
- G Contact success：紧凑成功、焦点与下一步；
- H Public nav + 390×330 component crop：theme/locale 与窄宽组件响应，不冒充完整 390×844 页面验收。

第三张覆盖 I 390×844 Studio、J 390×844 Batch、K Plan compact、L History compact、M Admin table family 与 N route/surface inventory。它是覆盖导航图，不是 64 页逐张设计图；每个实际 route 仍须通过 §14 的 template/state checklist。

线框文件：

- `docs/prd/assets/0905-ui-review/0905-VibePin-关键UI线框-v0.2.svg` 与 `.png`；
- `docs/prd/assets/0905-ui-review/0905-VibePin-公共认证与设置UI线框-v0.2.svg` 与 `.png`；
- `docs/prd/assets/0905-ui-review/0905-VibePin-响应式与路由覆盖线框-v0.2.svg` 与 `.png`。

图内账号、内容、日期、推荐 freshness 和计数均为布局 fixture；除明确标注 `source-bound` 的套餐数字外不得上线。未经真实算法与样本测量的 match 百分比全部移除；quota 说明数字若不是当前 registry/readback 绑定值，必须标 `Illustrative — not production copy`。线框不构成视觉 PASS、可访问性 PASS、provider capability 或数据正确性证据。

截至第 13 节的结论：`REQUIREMENTS_AND_STATIC_RISKS_RECORDED / WIREFRAME_CONTRACT_DEFINED / IMPLEMENTATION_NOT_STARTED / RUNTIME_AND_SCREEN_VERIFICATION_PENDING / READY_FOR_PRODUCTION: NO`。

## 14. 全部页面入口与非页面 surface 盘点

### 14.1 覆盖口径

本节以 `web/src/app/**/page.tsx` 为事实源，共识别 64 个页面入口：公共/根级 20 个、`/app`（含 Settings）33 个、`/admin` 11 个。`CONFIRMED_SOURCE` 仅表示文件/结构存在；本轮没有逐页运行或视觉 PASS。每个入口实施后按以下九项检查：

1. 页面唯一主任务与视觉层级；
2. `main`、标题层级、语义控件和可访问名称；
3. 键盘路径、`focus-visible`、modal/drawer 焦点圈闭与归还；
4. Loading、empty、filtered empty、stale、forbidden、error、partial、unknown、success；
5. 390px、桌面、滚动 owner、safe area 和触控目标；
6. en/zh-CN/zh-TW、日期/价格/数字 `Intl.*`、浅色/深色/系统主题；
7. URL、刷新、Back/Forward、新标签和登录前后恢复；
8. 图片尺寸/懒加载/失败占位、长列表、CLS、reduced motion；
9. 对不可逆/外部副作用动作使用与风险相称的确认、稳定 attempt、canonical readback 和失败恢复；良性导航/筛选不强制确认。

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
| 18 | `/dashboard` | 旧重复页面 | P1 退役/redirect 至 `/app/dashboard`；若实测错写、越权或绕过发布安全门禁再升 P0。禁止旧 queue/settings 写入模型继续可达。 |
| 19 | `/settings` | 旧重复页面 | P0 退役/redirect 至 `/app/settings`；禁止失败时假成功。 |
| 20 | `/preview/[taskId]` | 旧重复页面 | 退役并迁移旧链接；私有 task/draft id 不得进入 URL。确需分享时使用独立、可撤销、公开语义的 share id，且只读。 |
| 21 | `/app` | app alias | redirect `/app/studio`；鉴权、query 和来源恢复一致。 |
| 22 | `/app/admin` | admin alias | redirect `/admin`；权限失败语义一致。 |
| 23 | `/app/admin/visual-review` | admin alias | redirect `/admin/visual-review`；权限失败语义一致。 |
| 24 | `/app/connect/pinterest` | OAuth 过渡页 | 保留；timeout/manual fallback、bfcache 防重放、焦点和 reduced motion。 |
| 25 | `/app/dashboard` | App 首页 | 保留；移除硬编码浅色孤岛，统一主题、loading/error/empty 和可靠计数。 |
| 26 | `/app/discover` | 发现 | 保留；仅 allowlisted、可分享的筛选/排序/视图/分页 URL 化；私有详情、selection/saved item lists 保留 scoped state，drawer 可恢复。 |
| 27 | `/app/help` | 帮助 | 保留且允许公开访问；搜索需 label/`aria-live`，增加“我的工单”入口。 |
| 28 | `/app/help/[slug]` | 帮助详情 | 保留；无效 slug、上一篇/下一篇、标题锚点、返回搜索状态。 |
| 29 | `/app/history` | 历史 | 保留；allowlisted search/tab 可 URL 化，selection 留在本地/session；与 Studio/Plan 使用同一 canonical 生命周期。 |
| 30 | `/app/plan` | 旧 app alias | redirect `/app/studio` 并保留安全 query；禁止第二个 Plan 数据模型。 |
| 31 | `/app/product-library` | 商品库 | 保留；new collection label/focus、图片尺寸、空态/失败、URL 和 50+ 性能。 |
| 32 | `/app/products` | Product Opportunities | 保留；紧凑标题、筛选同层、真实四态、canonical API、图片/分页/URL。 |
| 33 | `/app/products/saved` | Saved Products | 保留；空态区分无收藏/过滤为空/加载失败，Back 返回原筛选。 |
| 34 | `/app/queue` | 发布队列 | 保留；queued/running/retryable/unknown/terminal 分态和稳定远端回执。 |
| 35 | `/app/studio` | Create Pin 主工作台 | 保留；按 FB-0905-01..40 及 UI-A01..12 执行，Schedule 主、Publish 次。 |
| 36 | `/app/support/tickets` | 工单列表 | 保留；从 Help 可发现、i18n、loading/error/empty、状态和分页。 |
| 37 | `/app/support/tickets/[id]` | 工单详情 | 保留现有 opaque detail id 契约；服务端 owner auth、referrer/analytics 日志脱敏、权限/404/附件失败、回复 loading/error/success。不得附带 owner id/token/payload query。 |
| 38 | `/app/trends` | 趋势 | 保留；仅 allowlisted、可分享的 keyword/filter/offset/public detail ref URL 化；私有详情与 selection 保留 scoped state，空数据不伪造。 |
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
| 63 | `/admin/users/[id]` | Admin 用户详情 | 保留受保护的 opaque detail id 契约；服务端角色授权、referrer/analytics 脱敏、权限/404、tabs、support note 成功/错误。不得在 query 增加 owner/token/payload。 |
| 64 | `/admin/visual-review` | Admin 视觉评审 | 保留；键盘打分、图片尺寸、保存冲突/失败、filter URL 和刷新。 |

### 14.2.1 Page → template → state 精确映射

状态包：`R`=route/auth/redirect/invalid-param；`D`=initial/loading/refreshing/success/empty/filtered-empty/stale/error/forbidden/partial/unknown；`F`=idle/dirty/validating/pending/success/error/conflict；`O`=overlay open/close/nested/focus/scroll/dirty-close；`M`=media loading/success/decode/404/timeout/fallback；`A`=action capability/preflight/confirm/dispatch/readback；`X`=390/desktop/theme/locale/reduced-motion/keyboard。每个 route 的验收记录必须逐项标 PASS/FAIL/NOT APPLICABLE，并解释 N/A；不能用 template 抽测代替所有 route 的 route/auth/i18n 验收。

| Template | 精确 routes | 必测状态包 |
|---|---|---|
| T-PUBLIC-MARKETING | `/`, `/about`, `/careers`, `/welcome` | R,D,M,X；Landing 另测 carousel pause、静态 demo 非伪控件 |
| T-LEGAL | `/acceptable-use-policy`, `/pinterest-app`, `/privacy`, `/refund-policy`, `/terms` | R,D,X；main/h1/skip/anchor/print/链接有效 |
| T-PUBLIC-FORM | `/contact`, `/data-deletion-status` | R,D,F,X；token 仅由服务端安全消费，不回显/记录 |
| T-AUTH | `/login`, `/signup` | R,D,F,X；safe next、provider fallback、session readback、Terms/Privacy |
| T-PRICING | `/pricing` | R,D,F,X；period URL allowlist、source-bound price、checkout return/error |
| T-LEGACY-ROOT | `/keyword-trends`, `/products`, `/sourcing`, `/dashboard`, `/settings`, `/preview/[taskId]` | R,X；每路由单列 target/status/query allowlist/auth/零旧写；私有 task id 入口应退役，不能泛化透传 |
| T-APP-ROUTER | `/app`, `/app/admin`, `/app/admin/visual-review`, `/app/plan`, `/app/virals`, `/app/settings/integrations`, `/app/settings/pinterest` | R,X；精确 target、auth、query canonicalization；OAuth/auth 回落不 blanket 308 |
| T-OAUTH-TRANSITION | `/app/connect/pinterest` | R,D,F,X；timeout、manual fallback、bfcache、reduced motion、cookie/URL 清理 |
| T-APP-DASHBOARD | `/app/dashboard` | R,D,M,X；theme、计数 provenance、唯一滚动 owner |
| T-DISCOVERY-LIST | `/app/discover`, `/app/products`, `/app/products/saved`, `/app/product-library`, `/app/trends` | R,D,F,O,M,X；allowlisted filters、Back/Forward、50+/500、详情/选择不入 URL |
| T-HELP | `/app/help`, `/app/help/[slug]` | R,D,F,O,X；invalid slug、搜索 live、Help→Tickets、Support Chat |
| T-PUBLISH-OPS | `/app/studio`, `/app/history`, `/app/queue` | R,D,F,O,M,A,X；current intent 与 immutable history、schedule save/due-time、partial/unknown |
| T-SUPPORT | `/app/support/tickets`, `/app/support/tickets/[id]` | R,D,F,O,M,X；owner auth、invalid/forbidden/404 区分、reply/attachment、返回列表状态 |
| T-WORKSPACE | `/app/workspace/[category]` | R,D,F,O,M,X；invalid category、source lineage、安全 prefill、Back/refresh |
| T-SETTINGS-MODAL | `/app/settings`, `/app/settings/ai-brand`, `/app/settings/billing`, `/app/settings/language`, `/app/settings/profile`, `/app/settings/publishing`, `/app/settings/shopify`, `/app/settings/social`, `/app/settings/support`, `/app/settings/workspace` | R,D,F,O,X；modal-backed fallback、tab mapping、dirty/pending/error/readback |
| T-SMART-SCHEDULE | `/app/settings/smart-schedule` | R,D,F,O,A,X；实体 page 与 modal 只能有一个 presentation/scroll owner |
| T-ADMIN-OVERVIEW | `/admin`, `/admin/data`, `/admin/pipeline`, `/admin/today` | R,D,M,X；server role、forbidden≠404、timezone/locale、长表/刷新 |
| T-ADMIN-TOOLS | `/admin/creative-intelligence`, `/admin/generation-logs`, `/admin/users`, `/admin/users/[id]`, `/admin/support`, `/admin/support/[id]`, `/admin/visual-review` | R,D,F,O,M,X；role capabilities、keyboard row action、async AI/send 防重、终态确认/undo |

Settings 的 13 个 page modules 不是 13 个独立 tab。当前 source inventory 为 11 个 modal tabs；index/profile/workspace 映射到 account 族，integrations/pinterest 为 router/alias，smart-schedule 同时存在实体 page 与 modal 风险，appearance/amazon 有 tab 但没有独立 public deep route。实现验收使用“13 route contracts + 11 tab mappings”，不能把文件数当作独立页面数。

### 14.2.2 非页面 surface 与系统状态矩阵

当前源码 inventory：64 个 `page.tsx`、3 个 `layout.tsx`、1 个 `loading.tsx`、0 个 `error.tsx` / `global-error.tsx` / `not-found.tsx` / `template.tsx` / `default.tsx`，以及 107 个 `route.ts`。107 个 route handlers 是服务端/API surface，不是 107 个网页；这里只枚举会影响浏览器呈现、重定向或关键 UI 状态的类别。

| Surface | 源码盘点 | 证据等级 | 实施/验收契约 |
|---|---|---|---|
| Root/App/Admin layouts | `app/layout.tsx`, `app/app/layout.tsx`, `app/admin/layout.tsx` | CONFIRMED_SOURCE | slow layout、auth/role、theme/lang hydration、唯一 main/scroll owner、child throw 后恢复；layout shell 不把 forbidden 伪装 404 |
| Route loading | 仅 `/app/connect/pinterest/loading.tsx` | CONFIRMED_SOURCE | skeleton 与终态同尺寸、无永久 spinner、reduced motion；其他异步 route 明确由页面局部 AsyncState 或新增 segment loading 承担 |
| Error/not-found boundary | 对应文件当前为 0 | CONFIRMED_SOURCE；运行影响为 STATIC_RISK | render/chunk/hydration throw、未知 public/app/admin route、invalid dynamic param；提供可恢复 error/not-found，保留安全导航，不泄露 stack/request payload |
| Auth callback | `/auth/callback/route.ts` | CONFIRMED_SOURCE；异常路径 STATIC_RISK | query/cookie precedence、malformed `%`、单双编码 `//`/反斜杠/scheme/control chars/nested next/超长、重复 callback/bfcache；sanitize fallback 永不 throw，清理 code/state |
| Social OAuth | Pinterest/Facebook/Instagram connect + callback routes | CONFIRMED_SOURCE | connected/cancelled/session-expired/state-expired/state-mismatch/exchange/persist/account-limit/account-mismatch/Page/IG-personal；cookie 清理、return context、URL 清洁、无重复 toast/write |
| Shopify OAuth | connect/launch/callback routes | CONFIRMED_SOURCE | store normalization、state/owner/capacity、cancel/error/persist/webhook warning、return tab、重复 callback 幂等 |
| Billing transitions | Creem checkout/status/return 与 portal 相关 route/client | CONFIRMED_SOURCE | plan/period mapping、single-card pending、cancel/error/session-expired、no entitlement before trusted webhook/readback |
| Settings overlays | `SettingsModal`, `LanguageRegionModal` | CONFIRMED_SOURCE；focus/scroll 为 STATIC_RISK | 11 tab mapping、nested overlay、focus trap/restore、background inert、dirty close、segment render error fallback |
| Studio/Plan overlays | `DraftDetailsDrawer`, `BatchEditDrawer`, `AiVersionDrawer`, `PinDetailsModal`, `SmartScheduleDrawer`, `CustomTimeModal`, `WeeklyPlanModal`, publish/confirm dialogs | CONFIRMED_SOURCE；行为为 STATIC_RISK/USER_REPORT | nested open/close、scroll lock ref-count、focus、390 footer、capability fields、Cancel 边界、selection snapshot/readback |
| Product/Discovery overlays | Product/Reference picker、Opportunity/Niche/Trend/Pin/Capture drawers/modals | CONFIRMED_SOURCE | loading/empty/stale/error/media fallback、50+ strategy、A→B late response、选择不进入 URL、关闭保留来源 |
| Assistant | `AssistantProvider`, `AssistantLauncher`, `AssistantPanel/Chat/FindingCard/Preview` | CONFIRMED_SOURCE | app-wide z-index 与 overlay nesting、page-context redaction、loading/error/retry、launcher keyboard/focus、不得发送未保存私密字段 |
| Support/Help overlays | `SupportChatModal`, `SupportChat`, `ContactSupportModal`（deprecated inventory）、Help detail integration | CONFIRMED_SOURCE | canonical 入口、deprecated surface 不重复、附件/发送 pending/error/success、防重复、隐私摘要默认折叠 |
| Global feedback | toast/banner/inline error/skeleton/empty/partial/unknown | STATIC_RISK | 同 attempt 单一稳定 status；field error 就地，toast 不重复；screen reader announcement 去重；刷新后由 canonical readback 决定 |

非页面验收必须补：nested overlay（Settings→Support、Studio→Picker→Confirm）、Back/Forward、Escape/X/backdrop、快速重复开关、route change/unmount、chunk/render error、offline/reconnect、390×844 和 reduced motion。存在 source 文件不代表 focus、滚动、z-index 或异常恢复已通过。

### 14.3 跨页面新增缺口

#### FB-0905-44 旧根级页面仍可形成第二套产品流程（P1；若证实错写/越权再升 P0）

`CONFIRMED_SOURCE`：`web/src/proxy.ts:64-72` 的共享 session redirect 只覆盖 `/app`；`/dashboard`、`/settings`、`/preview/[taskId]` 位于该边界外并保留旧流程，且仓库仍有旧 `/settings` 链接来源。该结构证明共享壳层/路由治理缺口，不证明相关 API 可越权；API auth/owner 必须独立验证。若运行证实错 owner 写入、未确认发布或旧流程绕过 canonical safety gate，再升 P0。

要求：

- 三个旧入口不得继续承载独立写入流程；默认使用 308/服务端 redirect 到 canonical `/app` 入口；
- 若 `/preview/[taskId]` 为历史分享链接确实需要保留，只允许鉴权后的只读兼容页，任何发布/重试必须进入 canonical Studio intent；
- 每个 redirect 单独定义 target、永久/临时 status、query allowlist、长度/重复值/canonicalization；未知、code/state/token、私有 selection/draft/task、`modal=publish` 等 action replay 参数全部丢弃；OAuth/auth 回落不得 blanket 308；
- proxy/auth、导航 active state、analytics 和测试全部只认 canonical route。

验收：登录/未登录、刷新、Back/Forward、旧书签、无效 taskId 各两轮；三条旧 URL 不得调用旧写 API，不得出现第二套 Settings/Publish UI。

当前 13 个 legacy/alias/router contract 必须逐条收口，不能再沿用旧的固定小计概括：

| 入口 | Canonical target | 当前源码行为 | 修订 contract |
|---|---|---|---|
| `/keyword-trends` | `/app/trends` | `redirect()`，query 丢弃 | 稳定 alias 可在迁移期使用永久 redirect；只保留明示 trend filter allowlist |
| `/products` | `/app/products` | `redirect()`，query 丢弃 | 只保留 Product filter allowlist |
| `/sourcing` | `/app/trends` | `redirect()`，query 丢弃 | 明确历史 filter 映射，否则丢弃 |
| `/dashboard` | `/app/dashboard` | 仍渲染旧 task UI | 退役旧写 surface；跳转前不得发旧 API |
| `/settings` | `/app/settings` | 仍渲染旧 settings UI | 退役旧 save surface；不把网络失败写成成功 |
| `/preview/[taskId]` | canonical Studio/history 或独立 public share | 仍渲染旧 SSE/edit/publish UI | 私有 task id 入口退役；公开分享只能用独立可撤销 share contract，默认只读 |
| `/app` | `/app/studio` | `admin=forbidden` 为终态提示，其余 redirect | 仅 allowlist `admin=forbidden`；未知 query 丢弃 |
| `/app/admin` | `/admin` | `redirect()` | 不透传 customer query；server role 重新验证 |
| `/app/admin/visual-review` | `/admin/visual-review` | `redirect()` | 不透传 query；server role 重新验证 |
| `/app/plan` | `/app/studio?view=plan` | 映射 legacy `view`，其余 query 盲透传 | 只保留 `planView=calendar|list` 等明确 UI allowlist；拒绝 action/private 参数 |
| `/app/virals` | `/app/discover` | route-group source `app/(dashboard)/virals` 使用 `redirect()`，query 丢弃 | 可选映射公开 discover filter；否则 canonical target |
| `/app/settings/integrations` | Shopify 或 Social tab | 根据 server env 选择 target | 临时 server redirect；目标可解释，query 默认丢弃 |
| `/app/settings/pinterest` | Social tab | 第一值化后盲透传 query | 只保留已定义的 OAuth outcome 枚举；消费一次后清洁 URL，code/state/token 永不透传 |

永久/临时 status 必须在实现 ticket 中逐条固定：稳定 GET alias 在兼容窗口可用 308；依赖 auth、env、OAuth outcome 或一次性状态的 redirect 使用 non-cacheable 临时语义。所有路由测试 unknown/repeated/malformed/encoded slash/backslash/`//`/absolute/CRLF/oversize/code/state/token/action-replay query。

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

`CONFIRMED_SOURCE`：这些页面缺一致的 `main`/skip-link 壳层，root layout 初始 `lang="en"`；LangProvider 可能在客户端更新，因此实际 hydration/lang 闪烁标为 `STATIC_RISK`。`globals.css` 已有全局 `*:focus-visible` baseline，不能仅因组件未写局部 class 判失败；需运行/级联验证局部 inline/outline reset 后的可见性、对比与首屏语言。

要求：提取 PublicShell/LegalLayout，提供 skip link、唯一 `main`、标题锚点、focus-visible、动态 `lang/dir`、首屏 theme/color-scheme、移动导航、统一页脚；所有公共页面不得复制一套固定英文/固定暗色模板。

#### FB-0905-48 App 页面可恢复状态、数据一致性与性能（P1）

- `app/discover/page.tsx:1216-1251,1541-1757`：shareable allowlisted filters/sort/view/page 未完整 URL 化；selection/saved item lists 留在 scoped store，不 URL 化；
- `app/trends/page.tsx:1411-1424,1654-1907`：公开且 allowlisted 的 keyword/filter/offset/detail ref 未完整 URL 化；
- `app/history/page.tsx:1198-1215`：allowlisted search/tab 可恢复；selection 必须留在 scoped store/session，不序列化选中 id 列表；
- `app/history/page.tsx:1053-1260` 与 `WeeklyPlanWorkspace.tsx:2212-2268` 使用不同本地状态链，fresh browser 可能出现 History 有记录而 Plan 空；
- `BatchEditDrawer.tsx:1545-1790` 直接渲染长表格；Product Library 图片需要核对 CSS 固定尺寸/aspect 是否已预留空间，缺 HTML intrinsic attrs 是 standards/performance debt，不单独证明已发生 CLS；
- `app/help/page.tsx:71-77` 搜索缺 label/结果 live region，且 Help 未清楚链接到已有 tickets 路由。

验收：刷新、新标签、Back/Forward、bfcache、登录前后、28/60/120/500 条、慢图/404、桌面/390 各两轮；URL 恢复不触发 publish/schedule/OAuth/checkout，History/Plan/Studio 的同一记录状态一致。

#### FB-0905-49 Settings/Admin 交互基础设施不统一（P1）

当前静态证据包括：

- `/app/settings/*` 多数 `page.tsx` 直接 `return null`，由 `app/layout.tsx` 的 SettingsModal 接管；`return null` 本身是 modal-backed 架构，不等于用户必然空白；
- 确定缺口是这些 segment 没有独立 error/not-found/fallback boundary；当 layout/modal render、chunk 或 hydration 失败时缺局部恢复。`/app/settings/smart-schedule` 另有实体页面，存在双呈现/双滚动 `STATIC_RISK`；
- `SettingsModal.tsx:1568-1715` 和 `LanguageRegionModal.tsx:200-233` 有 dialog 基础语义，但需要统一验证 focus trap、Escape、触发器焦点归还、背景 inert、dirty close；
- `ShopifyTab.tsx:283` 使用 `window.confirm`，无法统一样式、焦点、i18n 和移动体验；
- `app/settings/smart-schedule/page.tsx:26` 的外部 Save 与内部表单状态分离，未证明 saving/disabled/error/draft preservation 能同步；
- `GenerationLogsClient.tsx:225` 以 `<tr onClick>` 打开详情，缺键盘等价；`304,319` 的 backdrop/关闭按钮缺完整 dialog/focus 契约；
- `UsersTableClient.tsx:159`、`SupportNotesClient.tsx:105` 使用 `outline-none`；由于存在全局 focus baseline，需核对 CSS 级联后是否仍有 ≥2px、3:1 focus ring，不能仅凭字符串判定失败；
- `CalibrationClient.tsx:143-212` 的异步投票缺少成功/失败 `aria-live` 与失败后的就地重试/焦点策略；
- `AdminSupportTicketDetail.tsx:616-620` 的 Resolve/Close 会改变工单终态，未见统一确认或短期 undo；
- `admin/layout.tsx:22-24` 允许 support role 进入 admin 壳层，但不可访问的敏感导航仍可能先显示、点击后再拒绝；导航可见性应与服务端角色能力一致；
- 多个 admin 页面使用无显式 locale 的 `toLocaleString()/toLocaleDateString()`，表格与日志直接 `.map()`，图片只有 CSS 尺寸；
- `admin/layout.tsx` 与 app shell 均采用 `100dvh + overflow:hidden`，每个页面必须明确唯一滚动 owner，避免再次出现页面无法下拉。

要求：建立统一 Modal/Drawer、ConfirmDialog、Field、AsyncState、DataTable、ImageSurface、DateTime 组件契约；空 route 必须提供显式 redirect 或可恢复 fallback；Admin 按角色隐藏/解释无权入口，危险终态动作确认或可撤销。Admin 可以保持高密度，但不得以牺牲键盘、对比度、错误恢复和响应式为代价。

#### FB-0905-50 Auth callback 畸形 next 必须 non-throwing（P1；安全影响条件升级）

`CONFIRMED_SOURCE`：`web/src/app/auth/callback/route.ts` 对 cookie `next` 的 `decodeURIComponent` 位于主 `try` 之外；畸形 `%` 输入可能在 sanitizer/fallback 前抛错。当前结论是可恢复性与输入验证缺口，不在没有运行证据时断言开放重定向或认证绕过。

要求：query/cookie 使用同一 non-throwing `sanitizeNext()`，先限长与安全 decode，再拒绝 scheme/host/`//`/反斜杠/控制字符/嵌套 next/双重编码；定义 query 与 cookie precedence；任何异常回到固定站内 fallback。callback 成功/失败/重复/bfcache 都清理 code/state/cookie，一次性 outcome 不因 Back 重放。

验收：合法 `/pricing`、`/app/studio`、缺失 next、畸形 `%`、单双编码 external/slash/backslash/scheme/control chars、重复 key、超长、nested next、cookie/query 冲突、callback replay 各两轮；不得 500、开放跳转、auth loop 或泄露。

### 14.4 页面族验收用例

以下用例用于实现后的两轮验证；每轮都要保留实际结果、截图、console、关键 HTTP 和 canonical readback，不能只记录“看起来正常”。

| 用例 ID | 页面族 | 两轮必测 |
|---|---|---|
| PAGE-A01 | Landing/About/Careers/Welcome | keyboard-only 导航、skip link、主题/语言刷新保持、390 无溢出、reduced motion。 |
| PAGE-A02 | Legal/Pinterest App | 唯一 main/h1、目录锚点、focus、打印/窄屏、所有法律链接有效。 |
| PAGE-A03 | Contact/Data deletion | 正常、字段错误、网络失败、重复提交、成功下一步、token invalid/expired，首错聚焦且无敏感泄露。 |
| PAGE-A04 | Login/Signup/Auth callbacks | email/password、Google success/deny/popup fail、forgot password、Terms/Privacy；query/cookie next precedence、畸形/单双编码/超长输入、callback replay/bfcache、URL/cookie cleanup、A→B session。 |
| PAGE-A05 | Pricing | Monthly/Yearly/Content/extra account、四套餐、Creem Test mapping、checkout error return、URL 恢复。 |
| PAGE-A06 | Legacy/Alias/Router routes | §14.3 列出的 13 个入口逐一验证 target、永久/临时 status、allowlisted keys、重复/畸形/超长/敏感参数、未登录 redirect、Back/idempotence、零旧写 API。 |
| PAGE-A07 | App shell/Dashboard/Help | theme/locale、menu/dialog focus、Help→Tickets、loading/error/empty、唯一滚动 owner。 |
| PAGE-A08 | Discover/Trends/Products/Saved/Library | default/filtered/empty/error/stale、URL/Back、图片 fallback、60/120/500 条性能。 |
| PAGE-A09 | Studio/Plan/History/Queue | create/generate/schedule/publish/partial/unknown/readback；Schedule primary；同一记录跨页一致。 |
| PAGE-A10 | Settings contracts | 13 个 route contract + 11 个 modal tab mapping；alias/tab/fallback、appearance/amazon 无独立 deep route、smart-schedule 单一呈现；dirty close、save/pending/error、Social capability fields、Shopify confirm。 |
| PAGE-A11 | Admin overview/data/pipeline/today | 权限、loading/error/empty/stale、时区/locale、长表格、刷新不跳位。 |
| PAGE-A12 | Admin users/logs/support/review | filter URL、键盘行操作、modal focus、AI action pending/error、重复发送防护、图片 CLS。 |
| PAGE-A13 | Layout/Error/Not-found | root/app/admin slow layout；render/chunk/hydration throw；unknown route、invalid dynamic id、forbidden≠404；恢复导航、无 stack/payload 泄露。 |
| PAGE-A14 | Overlay/Assistant/Support | nested overlay、focus/inert/scroll owner、Escape/X/backdrop/route-unmount、快速重复操作、assistant context redaction、support send/attachment error、390/reduced motion。 |

### 14.5 设计 Skill 对实施的约束

三套 Skill 的建议必须作为实现评审门禁，而不是参考性文字：

- `frontend-design`：每个页面先写一句“用户来这里完成什么”，再确定单一视觉主任务；禁止默认套用大渐变、大圆角卡片海、满屏 pill 和重复紫色 CTA；
- `web-design-guidelines`：语义 HTML、label/name/autocomplete、键盘/focus、inline error、URL 状态、图片尺寸、50+ 列表策略、reduced motion 和 hydration 稳定性为硬门禁；
- `interaction-design`：每个异步动作必须有 idle/pending/success/error/partial/unknown 状态图；动画只服务因果和空间连续性，使用可中断的 opacity/transform，不得用动效掩盖延迟或状态不确定性；
- 任何 Skill 建议若与 canonical 数据、隐私、计费、发布或 OAuth 安全边界冲突，以事实正确和 fail-closed 为先；不得为了“丝滑”使用假成功、盲重试或提前乐观发布。

前三张 v0.2 线框中，第一、二张只覆盖八个重点面板，第三张补 390 全视口、Plan/History/Admin family 与 route/surface coverage。Admin、法务与信息页仍以 template/state 组件契约为主，不把 coverage sheet 冒充每页最终视觉稿；若实现者无法唯一确定焦点/滚动/状态行为，再补交状态线框，不用 AI 生图替代真实 UI 组件。

### 14.6 本轮静态审查边界

本轮结论只证明 64 个页面入口已被登记、静态源码已按三套 Skill 规则审查、具体缺口与验收条件已写入 PRD。它不证明这些问题已修复，也不证明 Preview USER E2E、四套餐 credits、真实 Creem checkout、OAuth consent、provider publish 或 Production 已通过。

本轮最终结论：`STATIC_REVIEW_DOCUMENT_COMPLETE / 64_PAGE_MODULES_REGISTERED / NON_PAGE_SURFACES_REGISTERED / IMPLEMENTATION_NOT_STARTED / RUNTIME_AND_SCREEN_VERIFICATION_PENDING / USER_E2E_PENDING / READY_FOR_PRODUCTION: NO`。
