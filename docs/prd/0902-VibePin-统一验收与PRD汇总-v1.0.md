# VibePin 0901 验收问题与补充 PRD 汇总

日期：2026-09-01  
范围：Preview / 测试 Supabase；不授权 Production promote、生产 migration/DB/env/VPS 变更、真实付款或真实发布。

## 1. 总结

今天反馈的问题已经归并为 5 份正式补充 PRD，分别负责 Pricing/Auth、Multichannel/OAuth、Product/Product Picker、Create Pin、Reference/创意智能。五份文档之间已经明确责任边界，避免同一功能由多个模块各自实现一套。

PRD 已完成不等于全部代码和 USER E2E 已完成。当前统一 Preview 已包含 Create Pin UI、CP-13 durable sync 和发布前确认等一批 P0 修复；Pricing/Billing 与三平台已保存连接的桌面/390 两轮 UI 已闭合，但新 OAuth consent/callback 生命周期、Reference 上传生成、Create Pin 剩余移动/恢复链、Creem/B-C、受控发布和 Product Supply 审计门禁仍未闭合，因此当前结论仍是 `READY_FOR_PRODUCTION: NO`。

## 2. 五份 PRD 总览

| PRD | 负责的问题 | 核心裁决 | 当前状态 |
|---|---|---|---|
| Pricing / Auth | 套餐价格、平台图标、Content 计量、extra account、Billing/Usage、Creem Test、测试登录与 Google OAuth、B/C 安全 | Preview 与 Production 完全隔离；Pricing 口径统一；Google OAuth 不可用不能伪装 PASS；私有路由必须 verified identity | PRD 完成；平台图标已部署；当前 USER 验收部分完成 |
| Multichannel / OAuth | 三平台连接、exact identity、单卡/Batch destination 一致性、optional schedule、发布前确认、计量与恢复 | 三入口共享 canonical connection/capability；禁止默认 Pinterest/账号/Board 兜底；任何 provider dispatch 前必须显式确认 | PRD 完成；发布前确认已部署；两轮 USER/OAuth/移动端未闭合 |
| Product / Product Picker | 商品来源标签、Picker 分类、深灰 fallback、选品灵感失败诊断、Catalog/Picker 单一数据源 | 用户看到真实来源和真实空态；不得用 Uploaded/Product Ideas 等内部词糊弄；API 错误必须可诊断 | PRD 完成；当前空数据桌面/390 PASS；非空、保存和 Create Pin 接力未验 |
| Create Pin | Studio UI、批量编辑、来源入口、生成原子状态、Reference groups、style reference、toast、destination、排期、draft durable sync | 一个创建状态机、一个 intent/job/usage/toast；失败可恢复；账号隔离；批量与单卡 destination 一致；发布时间默认可选 | PRD 完成；UI、CP-13、发布确认已部署；完整 USER E2E 未闭合 |
| Reference / 创意智能 | 商品图、analysis、recommendation、direction、style reference、429、analytics、与 Create Pin generation 的交接 | 单一 upload→analysis→recommendation→setup 链；统一深灰 fallback；exact stage/error；selectedReferences 持久且 owner-scoped | PRD 完成；桌面/390 pre-action PASS；完整上传→生成链未执行 |

## 3. Pricing / Auth

### 用户问题

- `N accounts per platform` 缺少支持平台图标。
- Monthly/Yearly 卡片与 comparison 可能口径不同。
- Content、scheduled post、extra account 价格容易被误解。
- Billing/Usage 不能把 unavailable、unmetered、0 used 混为一谈。
- Preview 登录频繁失效，Google OAuth 点击报错。
- 生成失败信息、private routes 和 analytics 存在隐私与伪造身份风险。

### PRD 要求

- 四张卡片及 comparison 使用 canonical `PlatformIcon`，显示 Pinterest、Instagram、Facebook Page；TikTok 隐藏。
- Monthly 为 `$19/$49/$99`；Yearly 页面月均为 `$15/$39/$79`，年付总额 `$180/$468/$948`。
- 一个 Content 无论发几个渠道，只计一个 scheduled post。
- Extra account 仅付费套餐可买：月付 `$7/account/month`，年付 `$60/year`，可展示为 `$5/month billed annually`。
- Billing/Usage 明确区分 `metered / unmetered / unavailable`，GET 不得隐式写库。
- Preview 推荐 email/password 测试账号路径；凭据只能由用户亲自输入。
- Google OAuth 必须使用独立测试 client、正确 Site URL/callback/allowlist；错误页面不得泄露原始 OAuth/Supabase 信息。
- 未认证 private routes 返回 JSON 401；analytics 必须 auth-before-body。
- Creem 仅 Test Mode，验收到金额/周期正确即停止，禁止最终支付和保存付款方式。

### 当前门禁

- 平台图标已进入当前 Preview。
- 当前 Yearly 桌面、平台语义、Content/extra-account 文案与无横溢已有直接证据。
- Monthly/Yearly 和 Free Billing/Usage 已完成当前部署桌面/390 两轮 USER UI 验收；Creem Test checkout、付费套餐 Billing、B/C USER 与 Google OAuth 仍未闭合。

原文：`C:\vp-wt\pricing-auth-prd-0901\docs\prd\0901-收款定价与Auth补充PRD-v1.0.md`

## 4. Multichannel / OAuth

### 用户问题

- Settings、单卡、Batch Edit 显示的发布目标不一致。
- Batch Edit 只有 Pinterest 或缺少实际账号/Page/Board 选择。
- 发布时间看起来像必填字段。
- 卡片菜单“立即发布”此前会直接进入执行，用户没有目标确认感知。
- 不清楚三平台 OAuth 是否真正保存，刷新和重登是否仍存在。

### PRD 要求

- Settings Social、单卡 destinations、Batch Edit 必须消费同一 canonical connection/capability registry。
- 保存 exact provider/account/Page/Board identity，并在刷新、重登后保持一致。
- TikTok 前端隐藏，服务端也 fail closed，旧草稿不能绕过。
- 发布时间默认不展开；只有用户选择 Schedule/Add publish time 后才出现。切回 Publish now 必须清空隐藏旧时间。
- 单卡、Batch、Plan 的立即发布都必须进入同一确认组件，展示 Content、媒体、exact provider/account/Board/Page、立即或排期方式、禁用原因。
- 禁止默认 Pinterest destination、默认账号或默认 Board/Page 兜底。
- Cancel、Escape、关闭、返回、backdrop 都必须零 dispatch、零 job、零 usage。
- 部分成功与 unknown delivery 不能盲重试；使用稳定 intent/idempotency，保留 remote ID/permalink 和逐 destination 结果。
- 同一 Content 多渠道只计一次。

### 当前门禁

- 发布前确认 P0 已部署。
- 测试库两轮 GET 均读到 Pinterest、Instagram、Facebook 三条 connected 记录，状态稳定。
- 当前部署 Settings Social 已完成桌面/390 两轮，并通过 reload 证明三平台身份与连接状态持久；但 fresh OAuth consent/callback 或 reconnect/disconnect 生命周期、合法 destination 的确认/取消路径、HTTP/remote/usage 证据仍未闭合。
- 未授权真实发布。

原文：`C:\vp-wt\multichannel-oauth-prd-0901\docs\prd\0901-Multichannel发布目标与OAuth补充PRD.md`

## 5. Product / Product Picker

### 用户问题

- 商品卡出现粉色 fallback、乱码、白块或破图。
- `Uploaded`、`URL Imported`、`Product Ideas` 等标签用户价值低或语义混乱。
- “选品灵感无法加载”只有泛化错误，无法定位 API、认证还是数据问题。
- Catalog、Picker、Saved、社区灵感可能使用不同来源。

### PRD 要求

- 商品库、URL 导入、Amazon、Product Opportunity、Saved、社区灵感六类对象必须分开，但统一进入一个 Picker。
- 用户词汇改为“用户上传、链接导入、Amazon、商品机会/选品灵感、已保存、社区灵感”，避免内部流水线标签。
- missing、decode error、tiny、unsupported 统一深灰 fallback；不得显示文件名、URL、raw alt、乱码或永久 spinner。
- Catalog、Saved 与 Picker 使用同一 canonical Product source，保留 provenance、merchant link、Pinterest/source link。
- “无法加载选品灵感”必须保留真实 HTTP、安全 error code 与 requestId，并区分 401、404、429、5xx、HTML-as-JSON、诚实空态。
- 测试 Supabase 真为空时显示诚实零数据状态，不造 mock 商品。
- 桌面和 390px 两轮验证无横向溢出、筛选和状态一致。

### 当前门禁

- 当前 Preview 的桌面/390 零数据状态、筛选与 GET-only JSON 空态已 PASS。
- 非空商品卡、Save、链接导入、上传和 Create Pin handoff 未完成 USER 验收。
- Product Supply 的 100 Pin worker 数据指标正常，但正式审计 receipt 缺 before-sentinel，仍未放行 canary/apply/enable。

原文：`C:\vp-wt\product-picker-supplemental-prd-0901\docs\prd\0901-VibePin-Product与Product-Picker补充PRD-v1.0.md`

## 6. Create Pin

### 用户问题

- Studio 顶部大失败 Banner 噪声过高，同时又有第二条 warning。
- “N destinations need attention” 实际统计的是 Pin，文案口径错误。
- 缺图使用红、粉、紫随机 fallback，部分区域显示乱码。
- 卡片过大、字段间距粗、Plan 入口弱、Schedule 按钮抢主 CTA。
- Batch Edit 的 destination 与单卡不一致，发布时间应为可选或折叠。
- 卡片可能只因 legacy Board/category 显示 `Home Decor/家居`，但发布确认并没有明确保存的 provider/account destination；用户会误以为已经选好发布目标。
- 选中多个内容后的创建入口需要统一支持上传、URL、商品库/社区素材。
- style reference 关闭后丢失；生成失败出现“正在生成”和“未生成”两条互相矛盾 Toast。
- 2 refs × count4、placeholder、usage、reload recovery 与 React #310 必须稳定。
- Draft 同步的整批 422 会让一条坏 Draft 阻断合法 siblings，并存在 A→B 账号串 outbox 风险。

### PRD 要求

- 移除常驻全宽 failure banner，Failed badge/低噪声通知按 Pin 数计数并可进入问题列表。
- Studio 所有缺图统一深灰；品牌渐变只留给 AI 入口或唯一主 CTA。
- 卡片使用统一 spacing/control tokens；桌面合理多列，390 单列无横溢。
- Plan 只有一个控制；hover/focus 预览、click 固定、再次 click 取消；空间不足时 overlay，移动端全屏。
- Publish 是唯一主 CTA；Schedule 低视觉权重，桌面小按钮、移动端仍保留至少 44px 点击热区。
- 创建来源统一为上传、URL、Product Picker/社区素材入口，不维护平行创建生命周期。
- Batch 与单卡共享 destination；Schedule 默认不必填，mixed 状态不得静默覆盖。
- 卡片 chip、Batch、Plan、确认框与 dispatch receipt 必须读取同一份明确 destination intent；legacy Board/category 只能显示“尚未选择发布目标”，不能伪装成可发布 chip。图片或字段在弹框前阻断时必须给出持久、卡片级原因。
- style reference、direction、model、count、variation 在关闭、失败、reload/recovery 后保持 owner-scoped。
- 每个 generation intent 只有一个 job、placeholder 集、usage/reservation 和稳定 toast；unknown 先 reconcile，不自动二次 dispatch。
- 2 个 references × count4 必须得到 2 groups、每组 slots 0..3、8 placeholders、8 attributed results、usage=8，无重复。
- CP-13 使用 server per-draft outcome、client per-draft ack/error、owner-scoped store 与 account-switch reconcile；deterministic 422 不热重试。

### 当前门禁

- Studio UI 改造、CP-13 durable sync 和发布前确认代码已经进入当前 Preview，机械回归三轮通过。
- 当前桌面已观察到 Batch Edit 开关无 React #310、无大 Banner、深灰 fallback、紧凑卡片和禁用的零目标发布确认。
- 390px pre-action UI 已闭合，包括 Batch Edit 无 React #310、AI Drawer 与单一 Plan 控制；CP-13 per-card action-required、reload/A→B→A、有效 destination identity、完整 generation/recovery USER 链仍未闭合。
- 新增 `CP-14 / P0`：当前代码的卡片展示仍允许 legacy Board 投影，而发布确认只接受 explicit `scheduledDestinations[]`；一次安全 Publish-entry 点击后未出现确认框。GET-only 复核 jobs/destinations/usage 均为 0，因此没有发布或扣量副作用，但展示真实性与持久前置错误反馈尚未修复和两轮验收。

原文：`D:\vp-tmp\wt-createpin-production-blocker-prd-0901\docs\prd\0901-VibePin-Create-Pin生产阻断补充PRD-v1.0.md`

## 7. Reference / 创意智能

### 用户问题

- 上传商品图后推荐长期加载或失败，只有泛化“无法加载”。
- 推荐方向只有文字，缺少对应图片与来源依据。
- Creative direction 看不出来是输入框。
- style reference 关闭后或生成失败后没有恢复。
- 乱码/破图需要统一深灰 fallback。
- AI 生成失败、429、analytics、usage 与 Create Pin 可能重复创建状态和扣量。

### PRD 要求

- 只有一个 `upload → analysis → recommendation → selection/linkback → frozen setup` 状态机。
- loading/missing/decode/tiny/unsupported 统一深灰、固定比例、可访问 fallback；不显示内部 URL/文件名/raw alt。
- 每个错误保留 stage、HTTP status、安全 error code、requestId、retryable/Retry-After；UI 显示阶段化可行动文案。
- 换图 abort 旧请求，旧 response 不得覆盖新图；Retry 只重试失败阶段。
- 换一批使用同 seed、新 requestId、bounded `excludeIds ≤72`；已选 References 保留且不重复出现。
- Direction 显示商品代表图、最多两张 Reference、Why it fits、来源和 provenance。
- Creative direction 使用真正 textarea/input，具有 label、边框、focus、Save/Cancel；dirty 时禁用 Generate，最终生成值必须等于 committed 可见值。
- selectedReferences 在 Drawer close、route 往返、generation failure、reload/recovery 后保持 owner-scoped；A→B 不串数据。
- Reference 只交一份 frozen setup 给 Create Pin；不创建第二套 intent/job/placeholder/toast/charge。
- 429 使用整数 Retry-After 倒计时，结束后允许一次手动重试，不自动循环。
- analytics request/served/selected/refreshed/direction 事件可关联，payload `≤4096`，不得包含 token、密钥、原图 bytes 或完整自由文本。

### 当前门禁

- 当前 Preview 桌面和 390px 的 Drawer pre-action UI 已 PASS，包括两个 Add、三个 Direction、模型、count 1..4、无横溢和禁用 Generate。
- 完整 fixture 上传、analysis、recommendation、换一批、selection/linkback、style persistence、generation、usage/analytics/429 仍未执行；这些动作需要文件上传和测试额度的即时确认。

原文：`D:\vp-tmp\wt-reference-prd-v1-0901\docs\prd\0901-Reference创意智能补充PRD-v1.0.md`

## 8. 跨模块统一原则

1. 所有严格 USER PASS 必须绑定同一个 exact source、deployment、stable/unique URL 和测试 Supabase ref；旧部署证据只作历史背景。
2. Preview 与 Production 的 Supabase、OAuth client、Creem、域名、env、DB 和发布数据完全隔离。
3. 用户凭据、OTP、token、cookie、Authorization、OAuth code、checkout session、provider raw body 不进入截图、日志或 receipt。
4. 所有不可逆外部动作都必须在动作前显示 exact 对象、目标与结果边界，并获得确认。
5. unknown/timeout/partial delivery 先 reconcile，禁止自动重试造成重复帖子、job、placeholder、usage 或扣量。
6. i18n 至少覆盖 English、简体中文、繁体中文；禁止中文页面混入 `Review`、`No image`、`No board` 等内部词。
7. 桌面 `1440x900` 与移动 `390x844` 都是正式 USER 验收门禁。

## 9. 当前上线结论

- 当前 Preview：source `8398388974ccdb855c83064d107b72819b81be24`，deployment `dpl_64y1FQXaspLTxXVo2M6ZY3aFMBFk`。
- 当前状态：`PREVIEW_DEPLOYED_AND_PARTIALLY_VERIFIED`。
- 统一验收：`UNIFIED_PREVIEW_ACCEPTANCE_BLOCKED`。
- 生产结论：`READY_FOR_PRODUCTION: NO`。

主要剩余门禁：fresh OAuth consent/callback 或 reconnect 生命周期与 Multichannel destination/确认；Create Pin CP-13 owner/recovery、CP-14 destination 展示真实性、有效 destination 与 generation USER 链；Reference 完整上传生成；Creem Test checkout、付费 Billing 与 B/C；Product 非空/save/handoff；Product Supply 审计完整的新 dry-run 及后续单独授权的 canary/apply/enable；受控发布、恢复和计量证据。
