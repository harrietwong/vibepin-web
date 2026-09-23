# 0905 VibePin 最近24小时PRD汇总 — Agent实施详细版 v1.1

修订日期：2026-09-06。原路径保留以维持现有引用；内容版本升级v1.1。原Word业务批注14条的处理记录与0906 Bug增量见§18。四套餐独立执行入口：[测试用例](../测试用例/0906-VibePin-四套餐Credit独立测试用例-v1.0.md)。

状态：文档合并与需求澄清；不构成执行、部署、付款或数据迁移指令。
对应读者：架构/实现/测试/集成 agent。面向产品负责人的同编号版本：[业务版](0905-VibePin-最近24小时PRD汇总-业务版-v1.0.md)。

## 0. 口径、版本与执行入口

### 0.1 时间窗及覆盖范围

冻结窗口：2026-09-04 21:59 至 2026-09-05 21:59，America/New_York（UTC−04:00）。以当前文档元数据、正文修订记录和本会话产出共同识别；不是按文件名日期筛选。汇总的是窗口内整理文档的有效内容，不宣称这些文档全文均为窗口内新增。

本轮识别10份相关源文件：滚动PRD两个版本、Product补充、Multichannel补充、媒体安全、Create Pin实施PRD、统一验收结论两个版本、剩余副作用验收包、人工验收单页用例。重复版本只保留有效规则，不重复计作缺陷。窗口外的领域PRD作为依赖，不把其旧状态冒充24小时内进展；同期市场调研、邀请返积分旧稿、文档目录整理不自动加入本轮修复范围。

共同索引：保留50项反馈 `FB-0905-01..50` 与6个跨文档工作包 `U24-01..06`。2026-09-06修订新增§18，纳入Word的14条批注及0906 Bug报告的24个来源检查项；它们与既有需求去重，不计作24个新Bug。原时间窗口不变，增量修订不冒充原24小时内发现。

### 0.2 阅读顺序

1. 本节：冲突裁决、缺陷状态与实施前置。
2. §3–14：保留已审v0.2原章节号，包含50项缺陷、方案、交互规则、四套餐测试与64页面清单。
3. §15：跨文档补充方案，包括媒体安全、生成数量、草稿隔离、版本门禁与真实链路。
4. §16：逐项执行卡与两轮测试、证据交付。
5. §17：历史来源追溯；§18：0906最新业务裁决、Bug映射、实施契约和当前核验。发生冲突时§18及已同步修订的正文优先。

本文件不只是目录：核心需求与验收内文已并入，可直接拆票；源文档链接用于追溯，不能以“见旧PRD”替代本节与§15的冲突裁决。

### 0.3 版本/证据冲突裁决（施工前必读）

| 冲突 | 本合并版采用的规则 | 禁止做法 |
|---|---|---|
| 老人工验收单要求 Publish 主色；最新用户要求排期为主 | Schedule 为排期工作流主CTA，Publish now次级；缺条件时主操作是修复 | 用旧截图PASS否定用户新要求 |
| MC旧文把unknown/failed/posted压成单维优先级 | current attempt独立聚合；immutable历史成功回执永久保留；见FB25/36 | 当前可编辑目标空就擦除过去发布成功 |
| MC旧文修复/取消全部零副作用 | 关闭确认本身不dispatch；嵌套picker里用户明确Save的编辑可保留 | 把Save误当发布，或虚称已Save流程零DB写 |
| Schedule保存与provider发布混为一谈 | 保存冻结时间/内容/目标；到期重验capability并执行 | 用Scheduled当远端Posted，或隐式fallback Board |
| 旧码表把Title/Description/URL/Board全部必填 | action/provider/media capability决定；当前Pinterest示例title/desc/website可选，Board按能力必填 | 给所有平台强加Pinterest Board |
| Credits included/snapshot/shadow混用 | display included≠snapshot cap≠effective enforce；按path+flag测，详§10.1 | shadow没拒绝就判产品失败；开enforce只为通过验收 |
| CP实施文基线fec→2142与本轮审查f995混杂 | 2142重做裁决是该源文当时历史；f995是本次UI静态基线；新施工先冻结实际candidate ancestry | 复制旧行号/基线红项豁免，擅自退回2142或搬脏树 |
| CP实施文末保留旧D-3/D-8“未决/删code” | 后文明确数量公式与路线A产品意图；前文已作废删除destination安全code的裁决 | 删除可达422安全门；重新询问已清楚的数量公式 |
| client循环、每group请求与目标逐slot服务端编排不同 | 产品数量/计量语义固定；目标durable编排。per-user锁下采用有界并发/队列，先设计后替换 | 将已有serial盲改parallel，导致429或重复扣费 |
| 媒体PRD早段“未部署/v76 absent”与后续回执不同 | 早段是历史checkpoint；S07后续文档报告f995已Preview部署。本文未实时核验alias/DB | 将历史“未部署”当实时结论，或据报告宣称完整隐私PASS |
| 旧验收中固定数量/handle/Sandbox名称 | 作为历史样本，不是硬编码目标或目前实时事实 | 因名字变更判错、默认选第一个账号或删除测试数据 |

来源旧规则中 auth-first 前置检查之前的 charge-then-refund 只作为兼容分支待审，不是新实现推荐：优先在capability/auth/确认无效时即阻断，不reserve/claim/dispatch。已产生fresh reservation的失败必须可归属、可补偿，不能释放其他attempt或成功腿账本。

### 0.4 当前完成度应如何表达

本轮只整理文档。S07历史回执报告：f995 runtime / f585 manifest / dpl_FiqJ7 的Preview部署、部分桌面/390只读UI、saved OAuth状态和代码两轮通过；真实生成、有效目标排期/发布、fresh OAuth、checkout和完整隐私仍未完成全链路验收。S01随后登记的用户缺陷可能发生在这些局部PASS之后或PASS未覆盖的状态，两者并不互相证明对方错误。

对每个ticket使用：`USER_REPORT / CONFIRMED_SOURCE / STATIC_RISK / CODE_VERIFIED / USER_VERIFIED / BLOCKED / NOT_EXECUTED`。同一票可含多种证据；关闭必须绑定exact runtime/deployment、状态、round和场景。不能用“文档写完”“构建通过”“空页面正常”关闭真实业务链路。

历史来源中的日期/计数/commit只作为追溯。本轮没有实时读取Preview、生产或测试DB。目标站点仍为Preview；实际执行时重新校验唯一部署和测试绑定。文档中的示例授权文本不是用户已经发出的授权。

### 0.5 文件位置和UI线框

源文件分布在 `docs/prd` 与 `docs/开发过程产物`，图稿在 `docs/素材`。整理期间部分文件位置发生变化，本轮按§17最终解析路径链接，不擅自搬动既有文档。
图稿为SVG低保真状态/布局设计，不是64张页面的实机截图或高保真UI交付：

- [关键UI：Studio / Batch / AI / Product](../素材/0905-VibePin-关键UI线框-v0.2.png)
- [公共 / Auth / Pricing / Contact / Settings](../素材/0905-VibePin-公共认证与设置UI线框-v0.2.png)
- [390移动端 / Plan / History / Admin / 64入口](../素材/0905-VibePin-响应式与路由覆盖线框-v0.2.png)

本轮复用上一轮已审的frontend-design、interaction-design、web-design-guidelines建议，没有新一轮产品UI实测。完整64入口与非页面surface矩阵见§14，依旧要求每个route单独验收，不能只抽一个模板。

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
| FB-0905-01 | Studio 失败图片 | P1/P0 条件升级 | 失败卡粉色假图与多套fallback混杂 | 按任务/媒体失败统一回退，失败不得显示粉色假图；有效成品正常显示，串号另升P0 |
| FB-0905-02 | Studio 失败媒体 | P1 | 深灰整块色块粗糙 | 使用中性深灰微渐变和精细图标层次，不回到红粉紫品牌渐变 |
| FB-0905-03 | Failed 卡动作 | P1 | 至少两个单卡各自重复渲染两个 `Edit` | 每卡只保留一个 canonical Edit，共用同一 handler 与可访问名称 |
| FB-0905-04 | Batch destinations | P0 | Batch “发布到”与单卡不一致、缺少选择 | 共用 canonical destination picker 和 capability |
| FB-0905-05 | Batch 发布时间 | P1 | 时间字段常驻，像必填 | 默认折叠并标注可选，由按钮展开 |
| FB-0905-06 | Create Pin 入口 | P1 | 入口分组和动作需要澄清 | AI与上传两个顶层入口；上传内选本地/URL/商品/已支持方式，底层校验与归属复用 |
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
| FB-0905-27 | 全部页面标题 | P1 | 大标题挤占首屏 | 所有页面删除独立大标题/Hero标题占位，含公共页；保留语义h1和必要紧凑导航 |
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
| FB-0905-39 | Plan 批量发布 | P1；P0 条件升级 | Publish handler与完整selection不一致 | 保留Publish selected，逐条可靠提交并显示提交状态与查看结果；不得改成编辑 |
| FB-0905-40 | 语义控件/模态 | P0 | 非原生交互、字段关联、focus trap/restore 与滚动 owner 不统一 | 建立可键盘完成、可聚焦、可恢复的 Field/Modal/Drawer 基础契约 |
| FB-0905-41 | 图片/长列表/CLS | P1 | 图片尺寸与失败占位不统一，大数组直接渲染 | 预留尺寸；50+ 条目分页/窗口化/渐进加载；局部失败不重置全页 |
| FB-0905-42 | URL/locale/theme | P1 | 可分享状态与私有瞬时状态边界不清，刷新/Back 恢复不一致 | 仅 allowlist 的 shareable filters/public ids 入 URL；私有 id、selection、token、草稿、未保存输入绝不入 URL |
| FB-0905-43 | 公共页/账户交互 | P1 | Auth、Pricing、Contact、Settings/Social 的异步与错误恢复不一致 | 统一字段级错误、可访问状态、可恢复 next 与局部 pending；良性操作不强制二次确认 |
| FB-0905-44 | 旧根级流程 | P1；P0 条件升级 | 旧 Dashboard/Settings/Preview 形成第二套写入 surface；尚未证明越权或错写 | 退役或安全兼容；canonical route、逐路由 query allowlist、零旧写 API |
| FB-0905-45 | Settings 假成功 | P0 | 保存失败可能显示成功 | 只有 durable local/server readback 才显示成功；否则保留 dirty/error |
| FB-0905-46 | Plan Publish语义 | P1 | `Publish selected` 实际进入编辑 | 修正handler为真实逐条发布，发布与编辑分别保留；已提交不等于Posted |
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

### FB-0905-01 失败图片统一回退

已知直接证据：

- 粉色卡对应标题 `VibePin QA T0 2026-08-29T08:24:11Z`；
- 卡内媒体可访问名称为 `qa-slide-1`；
- 页面把它渲染为成功加载的 `<img>`，而不是当前深灰 fallback；
- 相邻卡已走 `Image preview unavailable` 深灰 fallback。

0906批注明确：本项首要目标是失败时不显示粉色假图，并统一各类失败预览。正常有效图片正常显示；颜色本身不是失败判据。为避免旧图被当成本次成品，需核对：

- `draft.imageUrl`、`sourceImageUrl`、media cover、setup snapshot 的来源类型；
- 安全文件名/路径摘要、MIME、像素尺寸、字节数和内容哈希；
- 创建时间、创建入口、QA seed/placeholder identity；
- owner/workspace 归属，不输出 owner id、token 或完整私有 URL。

裁决：

- 当前attempt失败且没有有效成品时统一失败预览，不继续显示粉色占位或其他attempt的旧图；正常有效图片按原样展示；
- 已知 legacy QA placeholder、坏 URL、decode error、1×1/2×2 junk、unsupported 或超时才进入 fallback；
- 禁止按主色、平均色或“看起来像粉色”过滤；
- 如果发现跨 owner、错绑 Storage path 或 source/media 不一致，本项立即升为 P0。

验收：

- 当前失败无成品时粉色假图不再显示；正常有效图片回归仍显示；
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

- 桌面100%缩放下1440×900、1280×800、1007×632及移动390×844截图两轮；同时检查首屏密度、卡片动作可达性；
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

这些问题继续沿用领域 canonical requirement；本合并版 §15.7 已补齐 FB04..15 的逐项实现与验收摘要，不需在旧文之间来回查找。截图是历史部署症状，不是本轮实时复现；禁止复制新的 destination、product、recommendation、generation 或 toast 状态模型。

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
- 正文/控件沿用12/16辅助、14/20次级、16/24正文、20/28必要章节的受控字号；所有页面取消独立可见大标题。页面h1可视觉隐藏，导航中的紧凑页名不新增标题占位；常规正文400/500、label600；
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

### FB-0905-27 所有页面去掉独立大标题

0906批注要求所有页面不显示大标题。本规则覆盖工作台、公共/Landing、认证、Settings/Admin和法务外壳；原Landing豁免作废：

- 删除独立大标题/Hero标题及其空白占位，不以缩小到32px替代；
- 页面身份放入紧凑导航/面包屑或必要小型上下文标签，首屏直接展示工具、内容和状态；
- 按§14全部页面逐一检查，包含Studio、Products、Analytics、Settings、Landing、Auth、Admin与法务页；
- 保留唯一语义h1（可视觉隐藏）、document title和必要正文章节标题，确保读屏与SEO不丢页面身份。

验收：全部页面在1440、1280、390及桌面100%缩放两轮检查，无独立大标题或遗留空白占位；首屏核心工具可见，语义页面名称和正文层级可读。

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

0906根审校正：当前`GET /api/billing/usage`实际返回plan、periodStart/periodEnd及aiImages/aiTextGenerations/scheduledPosts各自的used/limit；当前接口没有included/reserved字段。下面的字段扩展与period/reservation要求属于实施目标；旧分支快照不能声称在当前分支已接线。独立测试须记录NOT_IMPLEMENTED而非构造假回读。

| 能力 | 展示配置事实 | 当前 enforcement / readback | 本轮裁决 |
|---|---|---|---|
| AI images / 月 | 当前`web/src/lib/planEntitlements.ts`：10 / 150 / 800 / 3000 | 当前usage.ts按usage_events聚合；period snapshot及reservation/settlement为待逐路径确认的目标，不能当作已全部接通 | 四套餐两轮测0、limit-1、limit、over-limit；失败/释放/部分结算不得多扣 |
| Scheduled posts / 月 | 当前`web/src/lib/planEntitlements.ts`：5 / 150 / 300 / null（Unlimited） | 当前usage_events独立usage_type；“一次Content跨渠道计1”为待业务冻结的目标草案，尚需证明保存/取消路径接线一致；null表示unlimited | 实施前冻结唯一计量口径；有限套餐测边界，Business测无cap但usage可观测，取消只释放本次未派发占用 |
| AI text generations / 月 | 当前本地`lib/planEntitlements.ts`返回null；旧汇总曾记20 / 500 / 2000 / 10000及另一registry，是历史版本证据 | 旧文的usage_accounts/meterGeneration接线描述不得直接当当前分支事实；按真实action path、配置和读回核对 | 当前代码无固定文案上限；旧目标与当前实现差异保留，商业改限额须明确裁决，不假造已启用 |
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
- 粉色合法图片反例、相邻卡 Edit 归属、Creem Test 8 映射、boards:write scope契约冲突核对（§18.7）、计量聚合与并发admission闭环（§18.5/§18.8）以及四套餐×两轮独立报告（FB24/C07）均覆盖；
- 无真实付款、无未确认 provider publish、无 Production DB/env/Storage/OAuth 修改；
- 最终结论仍由root与指定的Claude Fable 5独立reviewer复核，不能由执行会话自评替代。

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

- 保留`Publish selected`并把handler修为逐条提交发布；`Edit selected`独立只编辑。禁止以改名为编辑代替发布能力；
- 真正的批量 Publish 必须对完整 selection 冻结 snapshot，逐条建立稳定 intent/idempotency key；
- 确认页展示每条 Pin、每个 provider/account/Page/Board 和 now/schedule 模式；
- 任意条目缺 destination/Board 时禁止静默丢弃，必须标记 `action_required`；
- 可靠接收后显示“发布已提交，可查看发布结果”；逐条显示accepted/action_required/skipped/rejected，部分未接收需说明。后台结果聚合为all success/partial/all failed/unknown，并保留逐目标回执；
- 提交前Cancel/Escape/close/backdrop不dispatch；可靠提交后关闭面板不取消后台任务。重复确认不能重复job、usage或远端发布；

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
- 标题：所有页面移除独立大标题，页名通过紧凑导航或视觉隐藏h1表达；没有Landing豁免；
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
- D Product Opportunities：按0906批注删除独立大标题，必要导航紧凑；同一filter surface、真实filtered-empty；
- E Auth recovery：email/Google 的字段级错误、安全 next、fallback；
- F Pricing：月/年、年付总额和 source-bound 套餐事实；
- G Contact success：紧凑成功、焦点与下一步；
- H Public nav + 390×330 component crop：theme/locale 与窄宽组件响应，不冒充完整 390×844 页面验收。

第三张覆盖 I 390×844 Studio、J 390×844 Batch、K Plan compact、L History compact、M Admin table family 与 N route/surface inventory。它是覆盖导航图，不是 64 页逐张设计图；每个实际 route 仍须通过 §14 的 template/state checklist。

线框文件：

- `docs/素材/0905-VibePin-关键UI线框-v0.2.svg` 与 `.png`；
- `docs/素材/0905-VibePin-公共认证与设置UI线框-v0.2.svg` 与 `.png`；
- `docs/素材/0905-VibePin-响应式与路由覆盖线框-v0.2.svg` 与 `.png`。

图内账号、内容、日期、推荐 freshness 和计数均为布局 fixture；除明确标注 `source-bound` 的套餐数字外不得上线。未经真实算法与样本测量的 match 百分比全部移除；quota 说明数字若不是当前 registry/readback 绑定值，必须标 `Illustrative — not production copy`。线框不构成视觉 PASS、可访问性 PASS、provider capability 或数据正确性证据。

0906修订后旧线框若仍包含统一单入口、大标题、发布改编辑或不明确的Retry错误位置，仅保留为历史布局参考；实施按本版正文与§18，不得按旧图复原已被批注否决的交互。

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
| 19 | `/settings` | 旧重复页面 | 退役/redirect至`/app/settings`：路由治理按FB44为P1；页面内保存失败却显示成功按FB45为P0，分票验收。 |
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
| 30 | `/app/plan` | 旧 app alias | redirect至`/app/studio?view=plan`；固定`view=plan`只用于定位Plan区域，仅保留`planView=calendar|list`，其他query丢弃；禁止第二个Plan数据模型。 |
| 31 | `/app/product-library` | 商品库 | 保留；new collection label/focus、图片尺寸、空态/失败、URL 和 50+ 性能。 |
| 32 | `/app/products` | Product Opportunities | 保留；删除独立大标题、筛选同层、真实四态、canonical API、图片/分页/URL。 |
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
| `/app/plan` | `/app/studio?view=plan` | 当前alias行为待核对；目标中的`view=plan`是固定路由选择器，不来自用户query | 仅保留`planView=calendar|list`这一UI allowlist；丢弃其他query并拒绝action/private参数 |
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

要求：按业务批注保留`Publish selected`，完成完整selection → 逐条服务端可靠接收 → 后台dispatch → 逐条结果链路。发布按钮不进入普通编辑；可靠接收才提示已提交，provider receipt才证明已发布。与FB-0905-39及§18共同验收。

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


## 15. 跨文档补充解决方案

以下六个工作包与业务版的U24编号一一对应。它们补齐滚动50项没有完整展开的底层保障；不新增第二套领域模型。

### U24-01 草稿私有媒体与发布资产分离（P0）

关联：SEC-URL-01..03、SEC-MEDIA-01..05；FB01/07/10/31/34/36。

**缺陷与影响**：应用图片代理做owner校验，不代表底层public bucket直链已关闭。私有草稿、生成中间产物若永久公开，可绕过登录查看；而把所有bucket直接改私有又会破坏provider抓图。

**目标架构**：Website URL是用户可选商家落地页；source object是私有媒体身份；owner preview经protected renderer读取；delivery asset是特定发布intent/destination所需的独立交付对象，四者不得互换。

**调用顺序**：auth → non-mutating receipt/revision/capability preflight → prepare intent → materialize → claim → meter → provider → remote evidence → cleanup/reconcile。Schedule保存只prepare，不签URL、不复制public对象；到期重验后才materialize。

**实现约束**：

- fetch-og认证早于DNS/HTTP；仅http(s)、Web端口，拒绝credentials、私网/保留/链路本地/IPv4-mapped IPv6和混合DNS答案；预检及连接时双重校验，逐跳重验，redirect最多3次。
- HTML流式上限256 KiB，用户级rate limit；不要只相信Content-Length；错误不得泄漏解析地址/上游凭证。
- 媒体读取只允许PNG/JPEG/WebP/GIF/AVIF；同时检查声明和流式12 MiB上限；空body/MIME未知/归属缺证fail closed；private cache、Vary Authorization/Cookie、nosniff。
- durable provenance按exact bucket+object_path+owner索引；不以最近500个job扫描作为长期授权依据。
- materialization key绑定intent、destination、source checksum、strategy version。provider bytes优先，其次短时signed URL，再独立public publish copy；signed token只在服务端调用内存，禁止DB/log/客户端evidence。
- public副本采用不可猜路径、upsert=false、短retention与durable cleanup outbox；不能复用旧generated公共bucket。
- 一个destination的失败不丢掉ready sibling；已成功腿不能再次发出；source变化返回409重新确认。
- provider调用后响应丢失为delivery_unknown；网络断开不等于成功取消，不得提前删除provider可能仍在拉取的资产。
- 未验证摄取策略的provider明确不可用；不要为“能发布”临时开放草稿bucket或跳过claim。

**验收**：两轮auth-before-network、DNS变更/redirect私网/超限/429、owner/anon/cross-owner HTTP、同intent 32/100并发winner、兼容路由同intent、source变更、partial与unknown、signedURL无持久化、Schedule未到期无materialize。S05的SEC-A01..27为原始锚点。

**完成度**：历史代码/SQL测试不等于Storage HTTP与真实provider验收通过。保留待验证，不执行任何DB/bucket变更。

### U24-02 历史媒体迁移、策略合并与清理（P0）

关联：SEC-MEDIA-03/05、v75/v76历史回执。与U24-01分工：01处理新读写/交付，02处理既有对象与生命周期运维。

**缺陷**：legacy public对象仍可能可匿名读；owner回填不可靠会串图；旧permissive RLS policy与新policy按OR生效可绕过新限制；清理没有消费者时“已入队”不是“已删除”。

**方案与步骤**：

1. 只读inventory冻结bucket public/private、对象数量、匿名访问、policy/RPC ACL、应用永久URL依赖。
2. 新写private；按exact path/provenance回填owner与checksum；冲突/缺证标unresolved并隔离，不认领给当前用户、不删除。
3. 对照真实迁移链做apply-twice、同名结构冲突、owner/role/跨用户、concurrency/CAS与rollback；不能手工造简化schema让测试假绿。
4. 历史双读验证并证明新读兼容后，再进入受控public-read关闭；旧public不能当回滚保险。
5. cleanup worker使用lease/重试/退避/dead-letter；404算已清理，5xx可有界重试，超时lease可接管；人工运维有明确runbook。
6. rollback保留对象、owner映射、intent/attempt/usage审计；不恢复全bucket公开，不删除schema历史证据消除告警。

**验收**：匿名直链拒绝、owner仍可读、B看不到A、历史对象校验一致、unresolved不可公开；worker 404/5xx/lease接管/死信恢复；数据before/after一致；真实环境rollback必须另记，不把本地模拟当实机。

**历史记录处理**：媒体PRD有多个checkpoint及“v76 absent”旧段，S07后续统一回执报告测试v76已应用两次并保全数据。只接受其限定的schema兼容证据，不推出“隐私关闭完成”；实际环境需要fresh binding重新核实。

### U24-03 生成数量、服务端编排与按成功图片计费（P0）

关联：CP-12a/CP-12b、FB10/11/15/31；来源S06明确更正旧产品数乘法与按intent扣1的误解。

**固定产品规则**：

`totalRequested = max(referenceCount, 1) × variantsPerReference`。

产品数决定每张图中的主体数，不参与总张数乘法。例如3个商品 + 2张参考 × 每参考4个变体 = 8张，每张应按同一商品组合呈现。无reference仍有一组product+direction输入，不能总数变成0。

- 每次provider调用容量是运输批次，不是用户请求的产品总量上限；不得静默截断，不额外按套餐造一套图片数量上限。
- UI显示每组数量与总量；当前1/2/3/4选择是现有控件事实，不应误写为新的不可扩展产品上限；大请求通过余额校验、队列、取消和资源保护承接。
- AI image按确认成功图片数结算：8张成功扣8，不是一个parent intent扣1；跨平台publish Content计1属于另一bucket。
- failure不结算；unknown先保留/对账，不把“timeout不扣”写成可被重复领取成功结果的漏洞。server生成的受控attempt/run身份与payload fingerprint防客户端复用ID逃避计量。

**实施方案**：

- durable parent intent冻结owner、products、reference groups、direction、model、format、count、source provenance/version。
- child slot的key绑定parent+group+variant；服务端统一reserve/admission、幂等和恢复。关闭页面不丢未完成任务。
- bounded concurrency必须协调现有per-user锁与provider限流；S06“已有serial”和“目标parallel”是不同层次，不可仅用Promise.all替换。
- 失败slot可单独恢复；成功slot/媒体/usage不重做；progress反映真实已完成/失败/待核对。
- CP-12b先查Hook已位于早退前的源码事实；正确则补runtime开合测试，不无故重排组件。
- count/admission/取消策略需在施工票明确余额不足、过大输入、资源等待的精确响应；不因无产品级截断要求而移除安全request-body/并发防护。

**验收**：1商品/1参考×4、3商品/2参考×4、0参考×2、超过单次provider容量、某slot失败、父/子重复回调、刷新、双击、response loss；逐slot数量、来源、reservation与settlement可核对。不得用源码字符串测试替代运行状态测试。

### U24-04 逐草稿同步与全部本地状态的账号隔离（P0）

关联：CP-13a/b/c、FB11/18/25/39；S06的安全门及CAS要求继续有效，旧基线“删不可达422”的决策已作废。

**缺陷**：整批校验早退会因一个坏草稿阻断合法siblings；统一重试422制造循环；单例同步引擎+全局local key在A退出/B登录后可能用B token重播A outbox。

**服务端协议**：

- 仅auth/JSON/envelope等整请求问题整体拒绝；字段格式、单条大小、destination、CAS逐条outcome。
- `applied`才ack；`stale`附server current完整行供rebase；`rejected`进入action_required不热重试；`deferred`有界退避。
- outcomes缺失/unknown ID不能确认本地项成功；mixed409不可整chunk ack；保留既有destination_not_schedulable/unavailable安全门。
- CAS rebase不复活已取消schedule、不丢provider receipt。单条oversize客户端预检也要可见action_required。
- 余额不足的整批排期admission若采用全拒，仅作用于本批新排期项，不阻断无关普通草稿同步；不得删校验以达成“好项继续”。

**客户端与store作用域**：

`unknown → scoped(identity, epoch, signal) → cleared`。unknown/cleared不读写私有数据；activate/clear先abort旧任务再增加epoch；每个await后重新验证lease；token所属用户必须匹配lease。

- 覆盖pinDraftStore/Sync、userStoreSync、mediaOffload及相关adapters；不能只隔离一处drawer/cache。
- 本地key可用owner/workspace分区；server storeKey保持既有稳定adapter名，owner由认证上下文控制。
- 没有真实workspace来源时用明确定义personal scope，不能用userId伪造workspace。
- 先scope后init、先stop后signOut；清timer/listener/outbox/cache和失效回调；先server pull再把初始空local当empty。
- legacy无owner数据不自动认领；逻辑隔离，保留必要回滚窗口，不物理删除。

**验收**：good+bad mixed、全拒新排期+普通草稿、409 stale current、缺失outcome、oversize、两次409、logout时inflight、A→B→A、B无A图片/字段/usage、reload/server pull；所有deterministic rejected均有卡片级下一步。

### U24-05 基线、跨分支成果与发布保护（P0工程门禁）

关联：S06历史D-1/D-8更正，S07统一验收；不是要求将当前Preview降回某个旧commit。

**问题**：不同会话在不同世系复现同名缺陷；脏工作区借用别人的文件能编译，不代表clean checkout可复现；文档同一页保留作废裁决，复制行号会误删安全门。

**方案**：

1. 派工前root冻结exact base SHA、祖先关系、source tree、owner和files；核对S01所审f995与待实施候选的差异。
2. 每个ticket列“已在base存在/部分存在/不存在”，已有修复只补缺口和回归，禁止重建第二条状态链。
3. worker独立worktree；不得借未提交文件、共享node_modules并发安装、擅自杀其他任务进程。
4. baseline lint/type错误只能来自该exact clean tree的独立证据；旧fec/2142豁免不得跨候选沿用。资源/依赖失败写TOOLING_BLOCKED，不冒充产品失败或PASS。
5. 两轮focused + registry + scoped lint + typecheck +必要完整build；重型命令串行。
6. root先review状态/隐私/计量，再review cross-module seam；部署owner唯一组装和fresh predeploy guard，防遗漏他线成果；无绕过/强推/自动合并授权。
7. Production gate仍NO。历史测试库apply、Preview Ready、代码高审均不能自动推出Production可迁移/可付款/可发布。

**验收**：clean checkout独立复跑、runtime/manifest/unique/stable绑定一致、变更列表精确、既有分支工作未丢失、baseline债务明确、旧任务未被误唤醒。Create Pin任务只路由到createpin0826。

### U24-06 真实业务链路、两轮证据与安全测试边界（P0验收）

关联：FB24及S09/S10。文档制定测试不等于这些动作已经执行。

| 场景 | 前置与操作 | 必须得到的证据 |
|---|---|---|
| OAuth新授权 | 指定provider/测试身份/新增或重连；用户处理密码OTP最终consent；回Preview后刷新两次 | official identity与owner一致，既有连接不被覆盖；callback safe outcome，持久化一致，无content/usage副作用 |
| Product非空闭环 | 一个唯一前缀测试商品，URL import/upload二选一，Save一次，刷新进入Create Pin | 同一canonical Product/provenance，无来源不明复制；错误不是empty；本步不自动生图 |
| Reference→生成 | 明确测试素材、count及调用预算；一次Generate，故意刷新后观察恢复 | setup先持久化，parent/slot/usage一致，单toast，partial/unknown诚实；生成媒体私有 |
| 有效目标排期→取消 | exact账号Board/Page，至少30分钟后的测试时间；保存并回读，到期前取消 | schedule/ref/time一致；未到期0provider/materialize；cancel-vs-claim CAS结果明确 |
| Creem Test | 指定plan/cadence，CTA一次；核对Test/金额/周期，到付款前退出 | 未付款不升级entitlement；不保存付款方式、不真实付款，不循环创建session |
| 真实provider发布 | 独立确认exact Content、媒体、平台、账号、Board/Page、时间与远端清理范围 | 每destination receipt/remote evidence、Content计量+1、unknown先reconcile、不重复发送 |
| 四套餐额度 | 4个独立合成账号，各两轮新session；finite/unlimited/unmetered/shadow分开 | display/balance/limit/used/reserved对应实际path；耗尽、部分失败、重复回调、跨周期；全错误截图与脱敏记录 |

限制：不要为了消耗额度真实生成数千图；用受审计owner-scoped fixture构造near-limit，真实最小动作验证产品路径。无fixture入口时注明缺口，不能发明generic consume endpoint当真实E2E。mock可以测policy但不能替代4账号真实环境。Content usage与AI image usage不能混算。

测试对象按runid隔离；只有预先明确可删除的本轮数据可以走产品清理路径。audit/intent/job/usage/remote evidence保留；不SQL删除、不直接Storage删除伪造清理成功。已经发出provider请求的超时只读reconcile，不盲retry。角色无权资源可采用不可枚举404，内部证据区分404/forbidden，不泄漏资源存在。

### 15.7 FB04..15独立施工摘要（补齐原文引用段）

| ID | 解决方案与主要影响面 | 关键验收 |
|---|---|---|
| FB-0905-04 | 单卡/Batch/Plan/Settings复用provider registry、canonical connection DTO与capability；发布引用scheduledDestinations，不从boardName推造目标 | 同一账号/Board列表、切账号清旧Board、0目标禁用、无隐式fallback |
| FB-0905-05 | 自定义时间为transactional可选编辑；未设置用明确产品排期策略，手工值可展开修改；不把空时间当已保存 | 关闭/取消未保存编辑不写入；切回Publish now显式清空scheduledAt；取消已持久化排期走CAS且readback为未排期；时区一致；Batch多值mixed不被第一行覆盖 |
| FB-0905-06 | AI与上传双入口；上传内选本地/URL/Product/其他已支持方式，复用同一素材和draft规则 | 每入口返回上下文正确，开关入口不产生job，发布动作不冒充编辑 |
| FB-0905-07 | 共用ImageSurface success/loading/decode/tiny/unsupported/timeout状态；固定尺寸，source变化reset，合法粉色图不滤 | 五种失败+合法粉图+A→B旧回调均正确，无raw alt/抖动 |
| FB-0905-08 | 用户来源分Uploaded/URL Imported/Amazon/Product inspiration；收藏来源≠商品事实源，Pin Ideas是参考图不是Product | 列表/Picker/Create Pin来源一致，历史taxonomy有明确映射，三语言 |
| FB-0905-09 | Product inspiration走canonical API，加载/权限/服务错误/空catalog/filtered empty分态；停止浏览器Supabase兼容兜底吞错 | 401/403/429/5xx/timeout正确，真实非空Save/handoff，安全诊断 |
| FB-0905-10 | generation intent/group/slot durable编排，输入/模型支持预检，安全terminal code绑定失败项；见U24-03 | count=2全成/部分/全败/unknown，HTTP-job-slot-usage一致 |
| FB-0905-11 | Generate前持久化完整setup（refs/products/provenance/direction/model/format/count），owner/workspace隔离，不能setState即认保存 | close/generate/fail/reload恢复；setup确认先于placeholder；A→B→A不串 |
| FB-0905-12 | 上传、分析、推荐分阶段状态；换商品令旧请求失效；失败只retry对应阶段，保留已成功上传及输入 | A→B慢响应、429/timeout、刷新恢复，推荐失败不改成上传失败 |
| FB-0905-13 | 推荐方向展示真实来源缩略图、简短依据/Why it fits与已选态，集中在picker的推荐不在外层再复制 | 缩略图/source和方向关联，无假百分比，无重复推荐列表 |
| FB-0905-14 | Creative direction明显textarea、label、focus/边界与dirty保存取消；生成使用已确认可见输入 | 键盘可编辑、取消不覆盖、reload/生成读取相同direction |
| FB-0905-15 | 同attempt稳定toast/status id，pending非success，completed/partial/failed/unknown原位更新，inflight ref锁到可信终态 | 双击/重复callback/recovery单attempt/占位/usage；unknown不误报0生成失败 |

### 15.8 Product与Multichannel领域补充（与FB去重）

Product的六类对象必须分清：Product Opportunity、canonical Product、saved relation、Reference/Pin Idea、Content、publish destination；不能把“收藏Pin图片”当成商品入库。PO90-10/11/12分别映射FB27/28/29。

- Product Opportunity展示merchant和Pinterest原始链接、freshness与lineage；个人商品显示创建方式和来源；Saved只代表关系，不另建相同商品副本。
- filters使用单一apply模型；server response提供一致result/count/version；空catalog与筛选空不同。上游sync失败应短提示，不由用户猜清筛选能否恢复。
- Data Supply是单独系统；本汇总不授权canary/apply/timer enable，也不以伪数据填满空页验收。
- connection identity使用provider官方不可变ID，display name只展示；reconnect错账号拒绝覆盖；Settings/单卡/Batch/Plan同源。
- account、media、permission、expiry、Board/Page capability实时重验；TikTok目前不支持时UI隐藏且server拒绝，不只是藏按钮。
- 时间字段可选不代表发布目的地可省。只展示用户先前明确保存的目标或未选中的建议；建议绝不自动选中/保存。最终目标仍要用户确认，不能因名字或历史receipt静默派发。
- quota不足导致排期admission全拒与per-draft保存隔离分开；成功destination不重发，未知先reconcile；费用释放只对本流程fresh claim/reservation。
- partial应展示成功/失败/未知逐腿详情，History保存不可变发布事实；FB25/36取代旧MC单一badge降格历史的歧义。

## 16. 交付、验收与报告规范

### 16.1 每个agent的任务卡

每张卡必须包含：公共ID与领域anchor；exact base/runtime；证据等级和复现前置；用户影响；目标状态；文件/函数影响面；不修改范围；依赖owner；状态/API/DB变化；幂等/权限/计量边界；两个独立round的命令和预期；desktop/390 USER用例；回滚与cleanup；未完成项。

执行模型承担边界明确的编码/测试/整理，高级reviewer审查架构、权限、媒体隐私、计量、发布和冲突。任一结果必须可由root独立复跑，不以worker“全部绿”自证。当前用户只要求文档，不在本轮启动实施任务。

### 16.2 风险分层顺序

§11定义流程门，回答“满足什么条件才能进入下一步”；本节定义同一流程内的风险施工顺序，回答“优先做什么”。两者叠加使用，阶段编号互不对应，不得任选一套替代另一套。

| 阶段 | 范围 | 出口 |
|---|---|---|
| 0 冻结 | U24-05、源文冲突表、逐票base差异 | exact候选与owner确认；不从旧PRD直接checkout |
| 1 可信数据 | U24-01/02/04、generation身份/usage/目标安全门 | 权限/幂等/CAS/媒体资产基础契约两轮 |
| 2 核心恢复 | FB10/11/15/25/26/31/32/33/34/36/37、U24-03 | 生成/失败/排期/目标可修复且不误发 |
| 3 商业闭环 | Auth/Creem/Credit、Product非空/Reference推荐 | 真实最小路径可验，费用与身份一致 |
| 4 全站体验 | UI38..49、64页面及非页面状态 | desktop/390、三语言、theme、键盘/滚动一致 |
| 5 统一验收 | U24-06、最终same-deployment两轮 | PASS/FAIL/UNKNOWN/NOT_EXECUTED完整报告；不推导Production |

视觉工作可并行设计，但不能先用新颜色掩盖尚未确定的状态事实。涉及同一StudioBoard/Settings/共享i18n的变更由owner串行集成，避免各线互相覆盖。

领域设计优先级：0906批注覆盖旧标题上限，全部页面删除独立大标题；Product旧20/18px页头仅可作为必要导航/上下文标签，不保留独立标题块。保留h1语义。i18n验收至少en/zh-CN/zh-TW；新增key覆盖全部启用catalog，不以旧数量或三语PASS替代完整覆盖。

### 16.3 两轮测试不是重复截图

Round 1从干净session与唯一runid执行正常、边界与错误路径；Round 2刷新/重登/Back/跨owner/恢复后重走相同合同，使用可区分的测试数据或幂等replay标签。源码contract、单元/集成、浏览器、DB/Storage/provider证据分别记账。必须绑定同一个最终候选，跨部署旧PASS只能历史引用。

每个用例至少记录：Case ID、需求ID、round、时间、environment/runtime/deployment、前置、操作、期望、实际、状态、截图链接、console、method/path/status/safe code/requestId、脱敏before/after/usage/remote evidence、cleanup与限制。正常授权协议可携带token/code，但导出证据必须脱敏。

所有失败、超限、unknown、修复入口异常都留截图；截图不能含密码/OTP/token、完整私有URL、owner/connection ID或敏感表单。不能截图的控制器失败写明不可取证原因，不能伪造图片。最终报告必须有：已通过、未通过、阻断、未执行四张清单与下一步，不只写总PASS。

### 16.4 最小回归矩阵

- Studio：普通/生成失败/发布失败/历史Posted+新失败/partial/unknown；每卡Edit唯一；缺目标就地修；页面滚动与Batch单选→双选→开合。
- AI：product-only、selected refs、auto-match空集/失败、数量公式、多slot部分失败、单toast、刷新恢复、并发和success结算。
- Product：catalog有/无、filtered empty、权限/网络/上游错误、Saved/provenance/handoff、图片五类失败与真粉图。
- Publish/Plan：三平台identity；Board/Page依赖；0目标/篡改/stale/owner mismatch；save vs due-time；cancel race；same intent replay；逐腿remote evidence。
- Auth/商业：email/Google/safe next/malformed callback；8个Creem Test映射；四套餐finite/unlimited/unmetered/path-mode；connected slots与credit分开。
- 全站：64route矩阵 + layouts/error/404/callback/assistant/support/overlays；1440/1280/1007/390；en/zh-CN/zh-TW；light/dark/system；键盘/焦点/reduced motion；50+/500条性能。
- 安全：auth-before-network、SSRF/DNS/redirect/body、owner/anon/cross-owner、public bypass、migration/cleanup。真实DB/RPC/Storage验证需明确环境和操作权限。


## 17. 来源清单与追溯

mtime为America/New_York；以本轮最终解析路径为准。源文件未被本次改写。SHA用于核对输入，不是实时部署凭证。

| Source | 文档 | mtime / bytes | 合并方式 |
|---|---|---|---|
| S01 | [0905-VibePin-滚动验收反馈与修复PRD-v0.2.md](0905-VibePin-滚动验收反馈与修复PRD-v0.2.md) | 2026-09-05 08:38:25 / 115438 | 当前滚动需求；合并核心规则 |
| S02 | [0905-VibePin-滚动验收反馈与修复PRD-v0.1.md](0905-VibePin-滚动验收反馈与修复PRD-v0.1.md) | 2026-09-05 08:18:22 / 80507 | 被v0.2替代；去重追溯 |
| S03 | [0901-VibePin-Product与Product-Picker补充PRD-v1.0.md](0901-VibePin-Product与Product-Picker补充PRD-v1.0.md) | 2026-09-05 06:18:53 / 39548 | PO90领域及0905新增 |
| S04 | [0901-Multichannel发布目标与OAuth补充PRD.md](0901-Multichannel发布目标与OAuth补充PRD.md) | 2026-09-05 06:28:01 / 57460 | 连接/发布/OAuth；歧义按§0.3校准 |
| S05 | [0904-VibePin-媒体存储与URL抓取安全补充PRD-v1.0.md](0904-VibePin-媒体存储与URL抓取安全补充PRD-v1.0.md) | 2026-09-05 03:12:21 / 18501 | URL/媒体/资产/v75-v76历史 |
| S06 | [0903-VibePin-CreatePin-实施PRD-v1.0.md](0903-VibePin-CreatePin-实施PRD-v1.0.md) | 2026-09-05 01:30:20 / 52009 | CP数量/同步/隔离/世系；剔除作废规则 |
| S07 | [0905-VibePin-统一Preview验收结论-v2.0.md](../开发过程产物/0905-VibePin-统一Preview验收结论-v2.0.md) | 2026-09-05 05:14:29 / 11565 | 历史较新Preview证据，非实时status |
| S08 | [0904-VibePin-统一Preview验收结论-v1.0.md](../开发过程产物/0904-VibePin-统一Preview验收结论-v1.0.md) | 2026-09-05 03:12:21 / 17298 | 旧checkpoint，不覆盖S07 |
| S09 | [0905-VibePin-Preview剩余副作用验收包-v1.0.md](../开发过程产物/0905-VibePin-Preview剩余副作用验收包-v1.0.md) | 2026-09-05 05:06:30 / 15459 | 剩余真实链路/操作边界 |
| S10 | [0905-VibePin-统一人工验收单页用例-v1.0.md](../开发过程产物/0905-VibePin-统一人工验收单页用例-v1.0.md) | 2026-09-05 05:42:41 / 7693 | 历史人工用例，CTA等修正 |

### 17.1 Source SHA-256

- S01：`523CAE10ECF10E85993EF2F2BFF7E870732CF52317F8B58DC7A7AE0B14A2A685`
- S02：`3EE2977249ECAD617891ECC954FCA3A00654E6119EEB1C99B056537F03AA0603`
- S03：`4F0EB38F66EC0ED49EF700071E5EC57F5446B7B79B9643BD36CF9226A654AA20`
- S04：`C9CCE4AC8B9B84C570D85710E70161800A23DBF10AB053E04EA356E4B4A2D612`
- S05：`5D850AA66E9DAC4A99DFDFAE8620B714A3A73C279B0620DBC1C93DA80D2D4997`
- S06：`296A22633476FC6A363158EA8F6EF0B907B3F573A77493870F925CFF5C94978D`
- S07：`EE348C9758BD379A4965D650B53EC51BE02782ABC11673B34495650F82B69BA0`
- S08：`13F5DBB9A2300990515237F914566E825D76AEAD27CD78BCA51FCC7DD42CF478`
- S09：`8FE6792AF5A8A5EDF7D7FC6DC7F3EFDECD97EE0B7F4CAAE3D1CFE4719DC95C89`
- S10：`E5F11656138405C0A0A5F769D1363F9555262ACC736C981334759A8513293CAA`

### 17.2 不自动纳入新增需求的材料

同期文档索引和Pinterest市场调研不属于本批Bug修复PRD；市场定位建议不自动变成待实施缺陷。0901其他领域PRD、0902 RLS告警、0903业务/开发版和邀请奖励旧版可作依赖，不把其全部旧问题或旧PASS算为24小时新增。目录移动不等于重新授权实施。

最终文档结论：`TWO_AUDIENCE_CONSOLIDATION / 50_SHARED_FB_IDS / 6_CROSS_DOCUMENT_PACKAGES / 64_ROUTE_REQUIREMENTS / NO_PRODUCT_MUTATION / LIVE_ACCEPTANCE_NOT_EXECUTED`。

## 18. 0906业务批注与Bug报告合并修订

### 18.1 本轮优先级与14条批注裁决

本节和已同步修订的正文共同构成v1.1实施基线。来源为原Word批注ID 0–13、0906当前Bug审查报告和当前本地代码；不扩展到0906新功能规划报告。批注中的明确业务决定优先于旧PRD、旧线框和本轮子模型建议。旧FB/U24编号保持稳定。文档修订完成不等于功能完成，生产放行仍为NO。

| 批注ID | 对应需求 | 本轮裁决及关闭证据 |
|---|---|---|
| C00 | FB01/02/07 | 先修失败卡粉色假图及多种失败回退不一致；正常有效图正常显示。没有本次有效成品不得拿旧图假装成功；需失败→恢复两轮截图。 |
| C01 | FB02/19/38/41 | UI会话已确认：旧视觉回归与数据stale分开验收，冻结1440/1280/1007/390的容器、列数、卡宽、首屏密度、卡高和刷新动作合同；当前仍需实机验证，详见18.10。 |
| C02 | FB04/35/37/39/46 | 批量每个按钮都核查可点击、handler与文案；完整selection映射到完整结果。 |
| C03 | FB25/34/36 | 查明已发布Pin的Board在请求、provider回执、持久化还是展示层缺失；历史回执缺项不猜补、不重发补证据。 |
| C04 | FB06 | AI和上传两个一级入口；上传再选择本地文件、URL、商品和已支持方式。原统一单入口方案撤销。 |
| C05 | FB10/15/31、U24-03 | 必须复现和查因；本地测试与线上provider证据分开，未取得同attempt证据不能写根因已找到。 |
| C06 | FB12/13/30 | 上传商品图分析+Keyword Trends信号+数据库真实候选形成推荐；定义来源、版本、失效与降级。 |
| C07 | FB24 | 独立四套餐测试用例已另列，ZCode按四账号×两轮执行并交付原始证据。 |
| C08 | FB26/33 | Retry解释目标为0的原因，具体错误字段红边/文字、首错聚焦和修复入口；不能只报数量。 |
| C09 | FB30/31 | 自动推荐必须分别验证接口、picker接入和生成消费；不可用/未验证明确列出。 |
| C10 | FB35/40 | 按frontend-design与interaction-design审查字段、焦点、脏状态、保存回读及移动布局；属于PRD设计要求，未冒充UI已实现。 |
| C11 | FB39/46 | 发布与编辑是独立动作，发布不得进入普通编辑。 |
| C12 | FB39/46 | 点击发布后逐条可靠提交，提示已提交并提供结果入口；禁止改名Edit来替代。 |
| C13 | FB27/38 | UI会话已确认：所有页面含Landing删除独立PageHeader/Hero；工具页以sr-only h1加紧凑topbar/breadcrumb表达页面身份，文章/表单仅保留必要正文标题；当前仍需全路由验收，详见18.10。 |

### 18.2 0906报告来源逐项映射

下表覆盖8项P0、5项P1、lint、4项结构欠账和6项收款检查，共24个来源项；来源项互相重叠，不相加为新Bug总数。“报告实跑”只归属于ZCode报告，本文没有重新运行122脚本、整库pytest或全量lint。

| 来源键 | 来源问题 | 合并到 | 当前证据和处置 |
|---|---|---|---|
| ZB-P0-1 | 用量聚合/allowance失败 | FB24、U24-03、§18.5 | 报告称6断言失败；先区分实现错误与mock脱节，不能直接宣称所有额度均错。保持商业激活阻断。 |
| ZB-P0-2 | production boards:write | §18.7、S04多渠道OAuth；FB34/36为影响面 | 当前请求scope确含该项；代码同时有“省略该项”和“实测需要该项”的冲突注释。必须核对审核scope、granted scope和脱敏真实请求，禁止盲删或直接改测试放行。 |
| ZB-P0-3 | postedAt与摘要回归 | FB25/36、§18.4 | 报告称2断言失败；cron路径已有postedAt/remotePinId，需定位具体handler或字符串断言过期。 |
| ZB-P0-4 | 生成失败及无参考模式 | FB10/15/31、U24-03 | 历史用户现象；代码允许空参考，根因待同attempt运行证据。 |
| ZB-P0-5 | 状态矛盾与Retry死路 | FB25/26/36、§18.3/4 | 与旧票重复，按批注补充错误字段、Board持久化和历史回执。 |
| ZB-P0-6 | Creem错误与激活 | FB17、§18.8 | 历史checkout现象+报告环境快照；不把报告变量状态说成当前生产事实。 |
| ZB-P0-7 | 登录回跳及Google | FB16/23/50 | 延续sanitizeNext/session readback/环境隔离，保留本地与Preview证据边界。 |
| ZB-P0-8 | 灵感加载和假空态 | FB09/28 | 延续loading/filtered_empty/catalog_empty/auth/error/stale分离；禁用空数组吞错。 |
| ZB-P1-1 | failureType缺失 | FB15/18/25/36 | 报告测试崩溃；缺失分类应为安全unknown，不默认可重试/可行动；需补旧数据兼容。 |
| ZB-P1-2 | Etsy source类型 | §18.9工程门禁；无直接重复FB，FB08仅为影响面 | 报告4处typecheck错；Provider已有etsy不代表另一source联合类型闭合，按当前诊断定位，不凭有etsy分支关闭。 |
| ZB-P1-3 | pytest失效import | U24-05、§18.9 | 导入group_rows_by_key_signature而当前实现未检出；先确认替代契约，不能随意补空函数或删用例。 |
| ZB-P1-4 | 设置假成功 | FB45 | 旧PRD为P0，此报告P1不构成降级裁决；仍按可信持久化/读回验收。 |
| ZB-P1-5 | 批量操作语义 | FB04/37/39/46、§18.3 | 采用C02/C11/C12明确业务裁决，发布逐条提交，编辑单独保留。 |
| ZB-LINT | lint噪音和真实问题 | U24-05、§18.9 | 11827 errors/37079 warnings是来源计数；临时产物与src问题分栏，不以噪音豁免hooks等真实缺陷。 |
| ZB-ARCH-1 | 生成无durable任务 | U24-03、§18.5 | 同步子进程和本地锁不足以支持跨实例恢复；已有credit RPC不等于生成已接入。 |
| ZB-ARCH-2 | 多渠道同步直发账本 | FB34/39、§18.4 | Pinterest已有pin_drafts claim；social先dispatch后落账不能满足“可靠接收后离开页面”。 |
| ZB-ARCH-3 | 外部cron单点 | FB34、§18.4 | 代码引用VPS触发，运行健康未核验；需要触发监测、补扫和多渠道到期派发。 |
| ZB-ARCH-4 | 不返还/并发/fail-open/匿名 | FB24、U24-03、§18.5 | usage已有release/reverse，v69已有reservation RPC；问题是业务接线与原子性，不能写全仓库不存在。 |
| ZB-BILL-1 | live配置映射 | FB17、§18.8 | 六个基础套餐与八个含加购目标分别记录；本任务不切live。 |
| ZB-BILL-2 | 生产webhook证据 | FB17/24、U24-06 | 为后续上线证据门禁，未有生产事件证据不得写已验证。 |
| ZB-BILL-3 | extra account加购 | FB17、§18.8 | 当前六项基础映射未覆盖加购月/年；承诺入口、价格、权益和退款都需闭环。 |
| ZB-BILL-4 | credit钱包/推荐奖励接线 | FB24、U24-03、§18.8 | RPC与helper存在，需action-path接线矩阵；不能以“死代码”代替逐路径分析。 |
| ZB-BILL-5 | Paddle历史权益迁移 | FB17/24、§18.8 | legacy webhook仍写user_metadata.plan；真实受影响用户数待只读审计，禁止宣称全部已降级。 |
| ZB-BILL-6 | 退款/争议处理 | FB17/24、§18.8 | 记录事件、权益处置、通知和人工SOP均需核验；不能以收到事件等同已处理。 |

### 18.3 按钮与字段行为合同

| 控件 | 启用及显示 | 点击后的动作 | 失败和取消 |
|---|---|---|---|
| AI创建 | Studio明确一级入口 | 进入AI设置，选商品/方向/可选参考，Generate另行提交 | 开关入口不生成；保留所属草稿上下文 |
| 上传 | 与AI并列 | 打开本地上传、URL、商品和已支持其他方式菜单 | 未支持项不伪装可用，取消不提交素材 |
| Edit selected | 有可编辑选择 | 只编辑完整选择集合；明确已发布/unknown只读范围 | 保存失败保留dirty，取消未保存部分无写入 |
| Publish selected | 非空选择；不可提交行需能解释 | 在当前发布surface显示范围/目标；点击提交完整集合，服务端逐条可靠接收，返回逐条接收结果 | 不打开普通编辑；双击幂等；0可提交时定位字段；部分拒绝显示数量 |
| Schedule | 用户明确排期、时间及目标有效 | 保存排期并读回，显示Scheduled | 不提前provider dispatch；取消已保存排期是独立操作 |
| Retry | 当前失败/需修复项；unknown先核对 | 打开本次失败的目标/字段诊断，修复后仅提交失败目标 | 历史成功不重发；目标读取失败不能误报未选 |
| 查看发布结果 | 至少存在可靠接收记录 | 打开同一submission在Plan/History的owner-scoped结果详情 | 刷新或Back只读，不重新提交 |
| 保存目标 | 账号及所需Board/Page有效 | 保存当前编辑目标并读回，回到原发布surface | 不修改历史receipt，不自动发布 |

提交提示按实际结果显示：全部接收“已提交N条发布，可查看结果”；部分接收“已提交A条，B条需要修复，C条已跳过”；未接收显示安全错误。accepted仅证明服务端已保存任务，不能提前展示Posted。提交后关闭弹窗不取消任务；明确取消任务需独立接口和状态机支持。不可因单条失效静默从selection中删除；每个输入项最终都对应接收、拒绝、跳过或待核对记录。

字段规范适用于Batch、单卡与Retry：

| 字段 | 业务内容及规则 | 错误与状态 |
|---|---|---|
| title/description/websiteUrl/altText | 常驻标签、按provider/action决定必填；长度采用该provider当前能力schema，URL与媒体身份分开 | 未定义长度不得编造；字段红边+文字+aria-invalid，失败保留输入 |
| provider/accountId | 账号必须属于当前用户且连接有效；先账号后Board/Page | 断连给Reconnect；重新连接后重新验证capability |
| destinationId/boardId/pageId | 只列当前账号可用目标；换账号清理不兼容目标；历史值只读 | 区分missing/deleted/forbidden/disconnected/unavailable/read_error，不用0覆盖原因 |
| scheduledAt/timezone | 排期明确启用时必填，保存统一时间事实并保留用户时区呈现；立即发布不带未提交排期 | 过去时间、DST歧义或非法输入就地错误；不静默改时刻 |
| dirty/saveState | unchanged/dirty/saving/saved/error；状态绑定row与revision | saved必须durable readback；迟到响应不能覆盖新编辑 |
| fieldErrors | 建议规范为fieldPath、safeCode、messageKey、repairAction；是目标契约，非声称既有接口 | 首错聚焦、可滚动、红色不是唯一信号；修正一项只清对应项 |

已核验的Pinterest当前实现：`server/pinterest/publishPin.ts`截断title到100、description到500、altText到500字符；其中description注释明确500为产品约束。PRD目标是表单在提交前展示对应计数并校验，不依赖后台静默截断；其他渠道按自己的有效schema，不能复用Pinterest数值。此为当前项目代码约束，不作为第三方最新官方限制声明。

批量验收必须覆盖0/1/2/5条、mixed accounts、Posted/failed/draft/unknown混选、遮罩遮挡、disabled原因、键盘与触控、快速连点、部分提交失败和关闭后查询。UI设计验收按100%缩放与390移动，焦点/hover不得改变控件位置；控件高度建议桌面至少36px，触控热区至少44px。动画遵循已有响应目标，不阻塞输入，减少动效下保留状态反馈。

### 18.4 发布队列与历史Board证据

目标流程：完整selection snapshot → 每条/每destination服务端持久化接收 → worker逐条处理 → provider结果 → 不可变receipt → Studio/Plan/History投影。单进程循环发送完再写账本不能满足可靠接收要求。迁移时复用现有pin_drafts/social_publish_jobs能力，避免两条路径对同一intent重复派发。

最低记录契约：submissionId、itemId、owner/workspace、contentRevision、destinationIdentity、idempotencyKey、acceptedAt、attemptId、status、attemptCount、nextAttemptAt、claim/lease、safeError、receipt引用。名称可映射现有schema，但必须在任务卡列映射；不将示例字段冒充已建表。内部标识不进入公开URL/analytics。

状态：accepted/queued → dispatching → published/partial/failed/delivery_unknown；action_required/rejected/skipped在接收结果中独立记录。claim租约过期后先判断远端是否可能接收；unknown先reconcile，不能因超时自动重复发。确定可重试的失败做有界退避，重试次数/间隔由受审配置管理并在实施卡冻结，不在PRD臆造固定秒数。

receipt必须持久化本次provider、account、Board/Page ID及可显示快照、remoteId/permalink、postedAt、contentRevision和attempt关联。Board缺失排查顺序为原请求→provider response→存储行→API映射→UI；既有postedAt写入路径也要回归。历史证据不全显示缺失字段及待核对，已有可信成功不抹除；禁止用当前Board补历史、禁止为补证据再发布。

到期触发必须有lastSuccessfulScan、queueLag、overdueCount、staleClaims和lastDispatchError等可监测信息，VPS触发失效后可安全补扫；多个触发重叠不重复claim。支持的多渠道必须进入同一到期职责覆盖；未接通渠道明确不可排期。worker中断、cron停摆/恢复、重复扫描、断连、部分成功、未知和跨实例竞争是P0验收场景。

### 18.5 生成任务与计量规则

现状与目标分栏：当前generate route为同步子进程、本地TTL锁；credit_reservations、reserve_credits和release_credits能力在迁移/helper中已经存在。需要证明生成、文案、排程、取消分别是否调用，而不是新建第二套不关联账本。

目标生成任务持久化owner、intent、group、slot、输入快照、模型/模式、状态、safe stage/code/requestId和资源结算关系。张数继续遵守U24-03公式，不按产品数相乘、不静默截断。刷新后读取原任务；确定失败释放对应未结算预留，成功按有效产出张数结算，unknown先核对且有受控超时处理。终态可恢复不代表无限重试或无限并发。

业务规则：

1. 对收费生成和计量动作先校验登录、owner、capability、输入及有效权益；匿名不得未经计量直接消耗provider。若另有游客试用，必须先定义独立预算/限流规则，当前不能把匿名无限放行当试用。
2. admission与预留必须原子，跨实例不能靠本机文件锁保证额度。有限bucket中settled+activeReserved不超过effectiveLimit，禁止check-then-act并发透支。
3. 用量读取失败显示unavailable，付费成本动作按受控错误阻止新调用，不把错误折叠used=0；纯展示可保留明确标旧的上次值。shadow观察不是正式enforce通过。
4. 生成图片按成功张数；推荐和文案若有独立meter，必须单独说明。AI text当前代码null不代表可以从旧文臆造限额，商业上限变更单列待决策。
5. 排程保存产生的占用与已发布消费明确区分。取消未dispatch的排程释放/冲回本次占用；重复取消幂等。已dispatch/unknown/成功不得以取消编辑盲目返还。“一次Content跨渠道计1”目前只作为目标草案，实施前由业务冻结唯一scheduled_post计量口径并写入action-path表；不得从当前代码或旧文默认推断为已生效规则。
6. reservation/settlement/release/reverse均关联同一业务对象和幂等键；不释放其他尝试、其他成功腿或其他用户的额度。数据库有RPC但未接入时记录缺口，不伪造执行痕迹。

验收进入独立四套餐用例。ZB-P0-1先用当前mock复现聚合错误，再用真实受控数据库验证净额与分页/period口径；禁止只修断言或关闭enforce来通过。生成2张失败需保留同attempt证据，provider根因尚未确认前只能标诊断未闭环。

### 18.6 上传商品图与趋势数据库推荐

目标推荐输入至少包含owner/workspace、productId列表、image identity/checksum/version、商品分析得到的关键词/类目、locale、所用趋势信号版本/时间和候选源。数据库对象与实际表字段映射由当前代码核查形成；不得把通用viral列表标作已理解当前商品的推荐。

流程：图片权限与可读性检查 → 分析商品事实/关键词 → 查询可用Keyword Trends信号 → 检索数据库候选 → 过滤坏图/权限/重复项 → 返回相关性理由、sourceId/sourceType、生成/更新时间与fingerprint → picker展示 → 用户选择或明确自动模式 → 生成保存本次参考快照。图片授权可用性、素材来源与商品事实独立校验。

fingerprint包含商品图片版本与趋势/候选版本，A→B→A和过期响应不能串图。候选为空、趋势缺失、分析失败、DB错误、未接通、超时必须分开。趋势缺失时可展示明确标注“未使用趋势信号”的商品匹配或“通用灵感”；禁止伪造商品相关性。人工选择不会被后台刷新覆盖。

UI状态建议available/empty/unavailable/loading/stale/error/unsupported；这些是目标状态字典，不宣称既有API已返回。Refresh只刷新该推荐，不创建生成job/AI image用量；Recommendation meter如存在须独立明确。无Reference仍是可选模式；是否可降级到商品+方向须以实际模型能力为依据。

C09关闭证据必须包括：POST推荐接口有真实商品相关结果；Reference picker实际调用该商品路径；生成payload消费对应候选；换商品/趋势版本结果可更新。仅单测通过或API存在不足以写“自动推荐可用”。

当前源码核查映射如下。这里只声明已观察到代码路径，不声明线上数据库可用或用户失败已复现：

| 当前位置 | 已存在行为 | 需要补齐或验证 |
|---|---|---|
| `RecommendedOpportunitiesSection.tsx` | 从trend_keywords选active条目，用商品上下文规则评分；选机会后按trend_keyword_id读取pin_samples | 该路径不等于图像分析→趋势→统一服务端推荐；refCountByKeyword支持项未在当前调用传入 |
| `product-led-recommendations.ts` | 商品类目/类型/用途等本地规则评分 | 不是embedding或模型视觉检索，不把推导分数当真实销量/需求事实 |
| `api/reference-candidates/route.ts` GET/POST | GET通用合格参考池；POST固定质量候选池后做商品上下文相关性排序 | top-200池的候选覆盖、趋势关联、租户/fingerprint、真实DB数据与过期处理需验证 |
| `AiVersionDrawer.tsx` | 推荐卡selectedRefIds保存选择，inspirationPatterns将风格标签用于prompt；独立referenceUrls作为生成referenceImages | 根审确认代码注释明确这是仅标签灵感路径。不是“选中图片必然漏传”的已证实Bug；产品必须区分采用灵感标签与采用图片参考，并按本轮目标接通需要的图片引用 |
| `StyleReferencePicker.tsx` | 旧路径直接读pin_samples并按save_count排序 | 核查当前可达路径，与另一GET通用picker并存时避免只修一处 |
| `generate/route.ts`与`generator.py` | 单HTTP请求接受单style_ref，有商品/参考时走子进程；后端有图片/provider/上传错误类别 | 多参考需按U24-03在group层编排，单请求上限不是产品总张数上限；UI是否呈现同attempt安全错误待实机 |

可复用数据库字段：trend_keywords的id/keyword/category/search_volume_level/priority_score/yearly_change；pin_samples的id/image_url/trend_keyword_id/save_count/scraped_at及v22的is_reference_eligible/reference_quality_score/visual_format/watermark_detected等；v41在pin_drafts定义image_analysis/recommended_keywords/creative_selections。存在迁移不证明目标数据库已经应用，实施卡须列实际schema核对。新鲜度不能只靠产品ID列表变化；图片版本、趋势/候选变更也需失效。

本轮子模型实际执行三组本地测试并经根审区分证据等级：test-reference-scoring.ts 13通过，test-creative-recommendations.ts 12通过，test-generation-manifest.ts 48通过，退出码均0。第四个moderation-gate测试因成本日志网络旁路中止，不计PASS。它们未确认线上provider根因；自动推荐完整业务链路状态仍为PARTIALLY_WIRED / LIVE_E2E_NOT_VERIFIED。

### 18.7 OAuth scope与登录

本项owner为多渠道发布与Pinterest OAuth，不属于FB16的Google登录域；FB34/36只作为发布与历史回执的影响面。

当前pinterest/config.ts的PRODUCTION_SCOPES含boards:write，注释既写“不需要”，又写真实POST/pins曾报缺少该scope；required scopes另未包含该项。报告说该scope未审核，本文未读取Pinterest后台或线上token，因此保留为阻断的契约冲突。

实施先冻结目标环境、应用审核允许scope、实际token granted scopes及失败endpoint/code，再选择最小可工作的scope集；若平台确需该项而未审核，完成审核/能力限制流程后才能放行。测试必须覆盖request scopes、required capability、已连接旧token和环境强制规则；不得仅为了旧测试通过删除真实发布所需权限，也不得为通过测试绕开审核约束。

Google/邮箱/Magic Link继续共用不抛异常sanitizeNext，session可靠建立后回跳并读回。环境差异和旧部署现象单列；本轮不修改OAuth配置，不把scope冲突与Google登录失败混为同一根因。

### 18.8 商业激活与历史权益

收款工作分为六个基础套餐产品与额外账号月/年两项增量；当前creemProducts六映射不能冒充八项齐备。逐项核对mode、product identity、currency、interval、active状态和entitlement映射；缺项保持明确不可购买。额外账号源文目标为7美元/月、60美元/年，实施前核对生效价格合同；不臆造未创建的live ID。

上线门禁：计量聚合、并发 admission、匿名/fail-open风险先闭环；Test checkout排查及签名事件测试通过；webhook验签、去重、乱序、重放、失败重试和权益读回通过；live配置与受控真实事件证据属于后续明确上线工作，不在本次文档任务执行。

钱包接线用矩阵列出UI/API→权益解析→reserve→provider/job→commit/release→Usage展示；推荐奖励、FEFO和套餐额度不是同一bucket，不能因helper存在就认为已生效。未接线能力标“未启用”，不得在营销页承诺可用。

Paddle迁移先只读盘点legacy subscriber与现有真相源差异，保留来源、映射、时间和审计；对已付费用户制定不中断权益的迁移、重放和回退策略。未经数据证据不声称已有用户被降为free，也不得信任客户端可改的metadata直接授予权益。

退款/争议至少定义事件状态、订阅/加购/credit影响、未消费与已消费处理、幂等、人工复核及通知。具体经济规则若源文未裁定列待确认，不能擅自制定一律扣回或永久封禁。需要待确认的规则阻断相应商业能力放行，不阻止其余文档整理。

### 18.9 工程验证与优先级

Etsy按实际typecheck位置修复source/provider联合类型与所有调用者，不能只看到Provider包含etsy就关闭；后端import问题先确认被移除函数的替代测试目标，禁止新增空实现或删除14个测试绕过收集。lint临时目录排除和src真实缺陷分开输出，hooks等问题仍需修复与回归。

先做根因及契约核对、登录/计量/scope/回执与关键按钮，再做durable生成及多渠道队列/补扫，随后商业激活门禁。设置假成功沿用原P0；P1涉及构建失败、无法操作或错发时按实际影响升级，不能把报告“可上线后跟进”当统一豁免。

来源测试快照：前端118/122脚本通过（4失败脚本），typecheck4错误，lint11827错误/37079警告；后端报告354通过但有1个收集错误、14用例阻塞。后端不能概括全绿，也不自行推算其未覆盖测试总数。当前本地定向测试结果单列在修订审查记录，不能迁移为当前Preview两轮PASS。

### 18.10 UI会话确认的响应式 stale 与页面标题合同

本节是C01和C13的实施级替换条款。来源为Codex「UI」任务的只读审查，裁决为建议采纳；它是目标合同，不是当前实现PASS。现有截图矩阵主要覆盖11个登录后route及1440/1024/768/390，不能替代64 route、1280/1007、Landing、真实stale/partial/error、200% zoom和移动真机。

#### 18.10.1 Golden viewport与布局算法

| viewport | shell/container | grid/card | overlay与scroll |
|---|---|---|---|
| 1440×900 | rail 68px；工具/数据页`max-width:1280px`居中；gutter 32px；Studio/Plan允许fluid | media 4列仅当card content width≥260px；editable 3列且card≥320px；gap 16px | 页面单一纵向scroll owner |
| 1280×800 | rail 60–68px；gutter 24px | media 3列且card≥280px；editable最多3列，字段/动作宽度不足320px降2列 | 禁止缩字号、热区或按钮保列数 |
| 1007×632 | rail 60px或closable drawer；gutter 24px | 主内容2列且每列≥320px；Weekly Plan默认day/list | Studio editor、Plan unscheduled tray、长filters进入drawer/overlay；禁止七列硬压缩和双纵向滚动 |
| 390×844 | 无side rail；top brand bar 56px；bottom nav；gutter 16px | 单列、358px content width；section gap 16px | filters summary button→sheet；primary/Retry常驻；touch target优先44×44px且不得小于40×40px |

正文、form和card action不得产生page-level horizontal scroll。只有真实比较型数据可在局部scroll container横滚，并提供edge fade或“横向滚动查看更多”。drawer/modal独立滚动，关闭时restore页面scroll和trigger focus。1024/768只作插值断点，不得替代业务golden matrix的1280/1007。

首屏合同：删除topbar下的独立title strip/Hero blank；context/filter strip建议40–48px；first actionable content位于topbar下72–128px。1440/1280媒体页至少完整第一行；1007至少2张完整核心卡；390至少1张完整卡并露出下一项/状态，创建表单和法务正文可按任务密度例外，但必须记录理由。

卡片合同：media slot先锁`aspect-ratio`；loading/success/failed/image-unavailable/retry不能改变外框高度。status summary最多2行，actions独占1行；desktop control≥36px，mobile touch area≥44px；诊断进入disclosure。视觉回归单列：失败卡不得出现粉/紫大色墙、broken image、raw filename和permanent spinner。

#### 18.10.2 stale状态机和副作用门禁

`stale = lastKnownGoodSnapshot存在 AND (freshnessTTLExpired OR requestVersion < currentFilter/Product/AccountVersion OR refreshFailedAfterSnapshot)`。若lastKnownGood不存在，状态必须为error/unavailable；视觉样式旧或用户主观认为内容旧不得触发数据stale。

| state | 可显示内容 | UI和动作 | 禁止 |
|---|---|---|---|
| loading | 无或原位占位 | 同尺寸skeleton，目标300ms内出现 | 用spinner无限占位、改变卡高 |
| empty | 权威请求成功且集合=0 | 原因和下一步 | 将错误或未加载伪装为空 |
| filtered-empty | 权威成功、当前filters结果=0 | `Clear filters` | 清除用户未确认的其他状态 |
| success | 当前版本可信结果 | 正常业务动作 | 缺readback即报成功 |
| partial | 已成功子集 | `部分内容未加载`和`重试未完成部分` | 丢弃成功部分或全量重复副作用 |
| stale | lastKnownGood | warning icon、更新时间、1px warning border/rail、`刷新数据`/`重试刷新` | 整卡染黄红、无时间、冒充current |
| error | 无可信快照 | 短句和`重试` | 展示旧数据却不标stale |
| unknown | 最终事实未确认 | `检查状态` | 报成功、盲重试副作用 |

stale文案固定为：更新中`正在更新 · 当前显示 {time} 保存的数据`；失败`未能更新 · 当前显示 {time} 保存的数据`；disclosure`部分信息可能已变化，更新前不会自动覆盖你的编辑。` 颜色不得作为唯一信号。

Refresh必须是read-only freshness动作，不创建generation job、不扣credit、不schedule、不publish。stale数据参与生成、排期、发布前，server必须按owner、object/revision、current destination/capability执行preflight/readback；冲突返回`Review latest changes/查看最新变化`，禁止silent overwrite或使用旧target继续。请求A→B后A的late response不得覆盖B；刷新按钮pending保持宽度。

状态变更通过polite live region只播报一次。Tab order按视觉顺序，`focus-visible` 2px且不被overflow裁切；keyboard/touch均可Refresh、Retry、open details、close drawer；Escape只关闭topmost overlay并restore focus。

#### 18.10.3 删除独立PageHeader后的route contract

统一替换旧设计规范4.2“Page title 24px / 每页唯一H1”、5.2“页面顶部统一PageHeader”及recipe“PageHeader → …”：`每页唯一语义h1；工具页默认sr-only，页面身份由紧凑topbar/breadcrumb承担；仅文章/表单中属于正文结构的h1可见；禁止独立PageHeader/Hero占位。`

- App tool route：topbar使用14–16px route label，可选breadcrumb；main内唯一sr-only h1；route transition后更新document title并将focus送到main/h1；首屏直接进入creation rail、filters、date controls或content state。
- Studio：topbar显示Studio/Create Pins，main直接进入Creation Rail。
- List/analytics：main从FilterBar、scope controls或result summary开始。
- Settings：route main为sr-only h1；modal/drawer title 18–20px并由`aria-labelledby`引用，不视为Hero。
- Help/Legal：禁止banner；article title作为阅读列正文h1可见，允许24/30，紧接TOC/body；禁止36–60px Hero、gradient title和额外blank band。
- Admin：route name进入admin topbar/breadcrumb；main从status summary/table开始并保留semantic h1。
- Auth：form card内20–24px task title可见；页面外不得重复标题。
- Landing：撤销豁免。nav后直接进入interactive product demo/evidence；value proposition与demo同组，18–24px；禁止48–64px Hero和title-only whitespace。唯一sr-only h1必须与可见首屏语义一致且不堆关键词；业务h2与内容同组，desktop建议≤32px。

每个route保留准确唯一的document title、description、canonical（适用时）和OG metadata。sr-only h1、document title、visible route label语义一致；不得从h2开始或存在多个sr-only h1。breadcrumb使用`nav[aria-label]`和`aria-current="page"`。sr-only不得用`display:none`或`hidden`。

当前Landing/Public/Legal的3xl–6xl headings、Landing `transition:all`、Insights 26–36px page titles登记为implementation conflict，未完成前不关闭C13。

#### 18.10.4 Button与interaction contract

Canonical labels：`Create Pin`/`Generate Pins`、`Schedule`、secondary `Publish now`、`Filters`、`Apply filters`、`Clear filters`、`Refresh data`、`Retry refresh`、`Retry`、`Review latest changes`。同一surface只有一个primary；nav/breadcrumb不是button；label必须verb+object。Pending copy可变化但reserved width不变；disabled control旁必须有reason，不能用`0 targets`替代动作名。

#### 18.10.5 验收矩阵与关闭条件

Route families：Landing/Public、Auth、App shell、Studio、Plan、History、Discover/Trends/Products/Insights、Settings、Help/Legal、Admin。每族覆盖：

1. 1440×900、1280×800、1007×632、390×844，browser 100%；另做200% zoom reflow。
2. light/dark/system；en、zh-CN、zh-TW及全部enabled locale；长文案、长account name。
3. loading、empty、filtered-empty、success、partial、stale、error、unknown；N/A写原因。
4. mouse、keyboard、touch；focus、Escape、scroll restore、reduced motion、44px target和0 page-level horizontal overflow。
5. Round 1 clean session；Round 2刷新、Back、re-login、A→B data switch后复走。每格只记PASS/FAIL/NOT_EXECUTED；截图存在不等于交互PASS。

C01/C13关闭前还需要Chrome/Edge桌面100%缩放的1440/1280/1007与两种DPR；iOS Safari/Android Chrome 390真机；键盘全流程、screen-reader page name、200% zoom、slow/offline recovery和真实last-known-good stale。当前状态保持DOC_COMPLETE / UI_NOT_FULLY_VERIFIED。
