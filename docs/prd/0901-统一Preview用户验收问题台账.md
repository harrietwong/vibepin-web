# 0901 统一 Preview 用户验收问题台账

状态：持续收集（用户仍在追加问题）  
范围：Preview / 测试 Supabase；Production 发布前必须关闭所有 P0，P1 必须有明确处置与回归证据。  
总负责人：Sol/root；各领域会话负责产出详细 PRD，不以本台账代替领域 PRD。

## 领域 PRD 交付

| 领域 | 状态 | 精确交付 |
|---|---|---|
| Pricing / Billing / Auth / B-C | 已完成并经 root 复核 | `codex/pricing-auth-prd-0901@1c99c647005c1714d9c449853eaf9cbaac195ce5`；`C:\vp-wt\pricing-auth-prd-0901\docs\prd\0901-收款定价与Auth补充PRD-v1.0.md`；19874 bytes；SHA-256 `3718DBA85803CDAEE0733957F491DA7BF69DD5CBF489B51509E6C6DB0DB50D3D`。仅文档，尚未集成或部署。 |
| Multichannel / OAuth / Publish | v1.0 扩展提交完成并经 root 独立复核；supersede 初始 664972 交付 | `codex/multichannel-oauth-prd-0901@8f410f3936f86b3b4cd16c4ca4ede300fdc1dfac`；parent `664972eb9eec482ea7c38bf7493c67f742e9e212`；`C:\vp-wt\multichannel-oauth-prd-0901\docs\prd\0901-Multichannel发布目标与OAuth补充PRD.md`；36268 bytes；SHA-256 `E9F1A6EE2BDD9DA24AA9168B41BAF810BF649288D5ED8DEB06E405FF96715AC2`；`MC-REQ-*` / `MC-A01..30`。仅文档，尚未实现或 USER PASS；与 Create Pin 的双向 anchors 和 P0 开放问题未闭合前不得 Production。 |
| Product / Product Picker | v1.0 最终回执已完成并经 root 独立复核；supersede 初始 a63e18 交付 | `codex/product-picker-supplemental-prd-0901@dbd756c55bc3b8dd29396b179d1d980ba7268e9e`；parent `a63e18f96a63d03c354550ef3cccbbf3104dff61`；`C:\vp-wt\product-picker-supplemental-prd-0901\docs\prd\0901-VibePin-Product与Product-Picker补充PRD-v1.0.md`；29400 bytes；SHA-256 `1627D220BA6B751513A968A916C1B43347A6963D23F9276709C53150ED13E9CC`；`PO90-01..09` / `A-01..18`。Receipt 3841 bytes，SHA-256 `9D1ACB184529C8C5BB175E6D71BF70038FB450CE2457E831CD76CE9579D61820`。仅文档，尚未实现或 USER PASS。 |
| Reference / 创意智能 | v1.0 已完成并经 Sol/high 与 root 独立复核；supersede 旧 78db8d 草案 | `codex/reference-creative-prd-v1-0901@dbbe66ef717d63b21e2e6718bf8377bd3e3ffb09`；`D:\vp-tmp\wt-reference-prd-v1-0901\docs\prd\0901-Reference创意智能补充PRD-v1.0.md`；28510 bytes；SHA-256 `6AA416F711ACDDBE6C4642C9A89FB543047FC42E256F899A7496A26572478F63`；`RCI-01..16` / `AC-RCI-01..10`。仅文档，尚未实现或验收。 |
| Create Pin / Batch Edit / Studio UI | Production-blocker PRD v1.0 与 Studio UI 代码候选均已完成并经 root 独立复核 | PRD `codex/createpin-production-blocker-prd-0901@3f865f316ac97af3bc15fda8962b3fd47e74132d`，parent `fec94a7...`；`D:\vp-tmp\wt-createpin-production-blocker-prd-0901\docs\prd\0901-VibePin-Create-Pin生产阻断补充PRD-v1.0.md`；42945 bytes；SHA-256 `83E14BAAB920BE9B35AE0FF5540BBD6EA456FCB4BDD9CDF67B161AF0F3622810`；20 `CP-REQ-*` / `CP-A01..31`。UI candidate `codex/unified-preview-ui-feedback-0901@2142aeeba81189c25c9e5758b573a959f10bc1c5`，clean；receipt 3756 bytes，SHA-256 `558A039EC14253BF4432D71759DBDC340E2C25286E839DD39DF04ED535A0BCF3`。UI提交只实现 `ST-01..05` 候选，不改 generation/recovery/destination data；`CP-01..12` 仍需按 PRD实现并在最终 Preview USER 验收。 |

## 证据边界

- 当前人工验收页面：`/app/studio`，测试账号已登录。
- 当前已部署候选：runtime `554bd5c308fd8fdc3afcf4c2a303c8a3ee03070b`，manifest `aae34a19f4d914a1251e4c801f7e177cd6ecb532`，deployment `dpl_EGpDj4kxzChG4oHkQQm6Way4XRMr`，unique `https://web-ish8q4861-harriets-projects-86e9e358.vercel.app`，stable `https://vibepin-fb-preview.vercel.app`，test Supabase ref `snulmwprsahzqvdbyenc`。该候选仅为当前验收基线；0901 后续 UI/缺陷修复尚未集成。
- 用户截图和 Browser Comments 是问题发现证据；最终 PASS 必须绑定包含修复的新 runtime/deployment，并记录桌面、390px、console 和关键 HTTP。
- 历史部署上的修复证据只作回归背景，不得替代新候选 USER PASS。

## 跨领域所有权与唯一事实源

| 领域 | 唯一所有权 | 必须消费 / 产出的稳定标识 | 禁止产生的平行状态 |
|---|---|---|---|
| Product / Product Picker | 商品目录、来源 taxonomy、商品证据、图片资产可用性与统一 fallback | `productId` / `opportunityId`、asset/image identity、canonical provenance | 不保存 Reference 推荐状态；不以 `Uploaded` / `Product Ideas` 文案替代真实来源字段。 |
| Reference / 创意智能 | 图片 analysis、推荐请求与 basis、`excludeIds`、选择集合、linkback/provenance、direction 语义 | `imageKey`、analysis revision、recommendation `requestId`、selected reference IDs | 不创建第二套 generation job/usage 状态；不把 toast 当终态事实源。 |
| Create Pin / Studio | Drawer intent 的原子保存与恢复、group/slot/placeholders、生成聚合、卡片与 Batch UI | `generationIntentId`、group/slot、job/draft IDs；透传 Product/Reference snapshot | 不复制 Product catalog；不另建 recommendation cache；同一生成 attempt 不得有多个互相矛盾的终态。 |
| Multichannel / Publish | canonical connection/capability、destination snapshot、publish intent/job、逐平台结果与一次 Content 计量 | `connectionId`、provider account/Page/Board snapshot、`publishIntentId`、remote ID/permalink、usage record | 单卡与 Batch 不得各自维护 provider 列表；TikTok 不得由 UI 绕过服务端能力门禁。 |
| Pricing / Billing | 套餐展示、provider 展示集合、Billing/Usage 诚实读回、Creem Test 产品映射 | plan/product key、billing account/subscription、usage period | 不单独硬编码社媒 provider 集合；必须复用客户可见 provider registry，排除 TikTok。 |

链路必须是 `product/asset identity → imageKey + analysis revision → recommendation requestId + selected reference snapshot → generationIntentId + group/slot/job → publishIntentId + destination snapshot`。任何阶段重试只能复用或明确替换本阶段稳定 ID，不得重放前一阶段副作用。

### 已复核的当前候选补证

- `UNIFIED_PREVIEW_FINAL_554BD5C3_20260901.md`：4929 bytes，SHA-256 `29A499F9F2C0F378184A16CF9F85598268EFBDC34DDFABEA37DE630424D44988`；仅证明 `READY_FOR_SERIAL_PREVIEW_USER_ACCEPTANCE`，不是 Production verdict。
- `FINAL_API_READBACK_554BD5C3_20260901.md`：2512 bytes，SHA-256 `D2CB0033526AA04B655624A6CBBC652F4A5EADC701C7544018BCB59C819D46FD`；Product/Saved exact unique authenticated 200，Billing/Social/stable 因 bounded CLI timeout 未证明。
- `FINAL_SOCIAL_CONNECTIONS_DB_READBACK_554BD5C3_20260901.md`：1651 bytes，SHA-256 `47444C410C0703C3BF713347E98204106F550D6EB697E3DCC1DD97867F612652`；测试库三平台连接行两轮稳定，但不证明 live OAuth 或 app route。
- `PRICING_BC_USER_IAB_BLOCKED_554BD5_20260901.md`：2229 bytes，SHA-256 `AE08972B452B8A929D6F69B8B5872FA6B7665AB91982EE8FD317F60B59601F79`；`BLOCKED_IAB_UNAVAILABLE`，非产品 FAIL、非 USER PASS。
- `PRICING_BC_CODE_RERUN_E756_20260901.md`：4330 bytes，SHA-256 `8AF3BB2FE2E220A13BFF975D72712B82548CA3367BBF37424F0CFF8A089972D7`；平台图标提交 `e75676b...` 的 registry `223/215/8` 与 395 assertions PASS。该隔离 worktree 的依赖 junction 不完整，scoped ESLint 与 typecheck 均为 `TOOLING_BLOCKED`，不是产品 FAIL/PASS；successor candidate 完整依赖树必须 fresh 跑 ESLint、typecheck 和 webpack。

## Create Pin / Batch Edit

| ID | 级别 | 实际问题 | 期望 / 验收要点 |
|---|---|---|---|
| CP-01 | P0 | 批量编辑的“发布到”只显示 Pinterest/静态值，与单卡编辑的多渠道选择不一致。 | 批量与单卡使用同一 destination 能力模型；显示已连接 Pinterest/Instagram/Facebook 的账号或 Page；TikTok 隐藏；支持 mixed selection 与部分不可用原因；不因打开/关闭产生发布请求。 |
| CP-02 | P1 | 批量编辑直接暴露发布时间输入，用户无法判断是否必填。 | 发布时间明确标注“可选”；默认折叠，仅由“设置发布时间”按钮展开；未设置时发布/保存不被阻断；批量设置与清除语义明确。 |
| CP-03 | P0 | AI 抽屉商品图、产品选择器和卡片出现 broken image、文字挤入图片或粉色兜底。 | 所有 missing/decode-error/1×1/broken URL/loading/failed 路径统一深灰中性 fallback；不显示 alt 文本乱码、不出现粉紫随机背景、无永久 spinner。 |
| CP-04 | P1 | 顶部入口分散：AI 创建、上传更多、URL 导入、社区/灵感生成缺少统一信息架构。 | 设计统一“添加内容/创建 Pin”入口；点击后清晰选择上传、URL 导入、从商品/社区灵感选择、AI 生图；保留现有快捷入口但避免重复和歧义。 |
| CP-05 | P1 | 产品选择器来源标签 `Uploaded` / `Product Ideas` 不解释来源和用途，且图标语义不明。 | 使用用户可理解的来源/状态文案与图标；来源筛选、卡片标签和数据 provenance 一致；中英/繁中完整；标签不能冒充质量或推荐结论。 |
| CP-06 | P0 | “选品灵感”无法加载，Retry 后仍无可验证成功链路。 | 记录 exact API method/path/status/error code；加载、空态、错误、重试、成功态完整；测试库无数据时显示诚实空态而非泛化失败；不得请求 Production。 |
| CP-07 | P0 | 上传商品图后推荐内容无法加载/长时间停在分析提示。 | 上传→analysis pending→ready/failed→recommendations 的状态机可恢复；换图取消旧请求并隔离旧结果；Retry 只重试失败阶段；console 无 uncaught error。 |
| CP-08 | P1 | 推荐方向仅文字，和商品/参考图的关系不可感知。 | 每个方向展示与其依据关联的缩略图/视觉线索、来源和选中态；缺少图时使用中性 fallback；方向切换不丢选择。 |
| CP-09 | P1 | Creative direction 展示像普通文本，看不出可编辑。 | 明确输入框/编辑态、边框、焦点、label、helper 和保存/取消；键盘可达；生成请求使用可见最终值。 |
| CP-10 | P0 | 风格参考图在关闭/重开或重新进入时未恢复上次选择。源码根因已定位：普通关闭会调用 `saveSetup()`，但 Generate 路径未先保存 setup，随后 `onPlaceholdersReady` 直接关闭 drawer，导致本次 reference selection 没有写回 `aiSetupCache`。 | 同一未提交生成 intent 内持久化商品图、style reference、方向、模型、count；Generate 前先原子保存 setup/intent；刷新/恢复按 owner 隔离；删除/显式“新建”才清除；A→B 不串数据。 |
| CP-11 | P0 | 点击生成后无 AI Pin，且同时显示“正在生成 2 个 Pin”成功色提示与“未生成任何 AI Pin”错误。源码根因已定位：`onPlaceholdersReady` 使用 `toast.success` 表示进行中，`onSettled` 全失败时又创建 `toast.error`，两条提示没有共享稳定 id。 | 单一稳定 toast id；pending 只能用 loading/info；terminal success/partial/failure/unknown 原位 update 或 dismiss；失败保留 recoverable intent，Retry 不重复 job/placeholders/charge；记录 HTTP/job/usage。 |
| CP-12 | P0 回归 | Batch Edit 曾因 Hook 顺序触发 React #310；count=4 曾在 UI 不可达。 | closed→open→closed 无崩溃；2 refs×4=8 可达并产生 8 upfront placeholders、两组 count4、稳定 slot attribution 和单次计量。 |

## Studio 视觉与交互基线

| ID | 级别 | 要求 |
|---|---|---|
| ST-01 | P1 | 移除 Create Pins 常驻全宽失败 Banner；Failed badge 为事实源，使用低噪声入口；计数单位是 Pin，不是 destination。 |
| ST-02 | P1 | 卡片更紧凑、间距 token 化；1440/1280 维持合理多列，390px 单列且无横向溢出。 |
| ST-03 | P1 | Plan 使用一个可发现控制：hover/focus 预览、click 固定、再次 click 取消并关闭；不足两列时 overlay；移动端全屏。 |
| ST-04 | P1 | Publish 是唯一主 CTA；Schedule 是低视觉权重按钮，桌面紧凑、移动点击热区至少 44px。 |
| ST-05 | P1 | 所有日常兜底图统一深灰；品牌渐变只用于 AI/主要 CTA，不用于错误、缺图或普通控件。 |

## Pricing / Billing / Auth

| ID | 级别 | 要求 |
|---|---|---|
| PB-01 | P1 | Pricing 的“每平台账号数”旁显示 Pinterest/Instagram/Facebook 图标；TikTok 不显示；桌面/390px 不溢出。 |
| PB-02 | P0 | Monthly/Yearly、Content 计量、extra account、Billing/Usage、Creem Test checkout 边界需要在最终候选完成两轮 USER 证据。 |
| PB-03 | P0 | Google OAuth 在测试 Supabase 授权页报错；明确测试账号的推荐登录方式，并校验 Preview Auth Site URL/redirect allowlist/provider 配置。不得暴露密码/token。 |

## Multichannel / OAuth

| ID | 级别 | 要求 |
|---|---|---|
| MC-01 | P0 | Pinterest/Instagram/Facebook OAuth 授权后连接保存必须在 test-bound Preview 各完成两轮 UI 验证，显示 exact account/Page identity。 |
| MC-02 | P0 | Settings、单卡 destinations、Batch Edit destinations 必须共享同一 canonical connection/capability 语义；TikTok 客户侧隐藏。 |
| MC-03 | P0 | 受控测试发布必须在最终动作前再次确认 provider、账号/Page、内容和副作用；禁止 Production、付款和重复盲重试。 |

## Product / Reference

| ID | 级别 | 要求 |
|---|---|---|
| PR-01 | P0 | Product/Saved/Inspirations 使用测试 Supabase；加载、空态、错误态和 390px 两轮 USER 证据完整。 |
| PR-02 | P0 | 推荐链路上传→分析→推荐→换一批/excludeIds→选择保留→来源/linkback→生成不得 mock；自然 429 仅观察，不 flood。 |
| PR-03 | P1 | Product picker 的来源 taxonomy、图标、fallback 和 Reference 推荐方向视觉表达统一，provenance 可追溯。 |

## 生产放行规则

1. 每个领域 PRD 必须给出明确状态机、数据契约、错误/恢复、i18n、a11y、桌面/390px和无副作用回归。
2. 所有 P0 必须在同一最终 runtime/deployment 上完成代码门禁与 USER 证据；旧 deployment 证据只能作历史背景。
3. Preview/test DB 数据按用户要求保留；Production env/DB/migration/VPS/timer、真实付款和真实发布仍禁止，除非另行明确授权。
4. 最终由 Sol/high 逐项审查，再尝试 Claude Opus 独立审查；外部审查不可用则明确 `NO VERDICT`，不得伪造。
