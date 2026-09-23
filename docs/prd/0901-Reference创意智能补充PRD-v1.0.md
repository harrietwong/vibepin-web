# 0901 Reference / 创意智能补充 PRD v1.0

**状态：** Ready for implementation planning；不是 Preview 或 Production 放行结论

**Owner：** Reference / Creative Intelligence

**用户入口：** `/app/studio` → `用 AI 创建`

**问题来源：** 0901 统一 Preview 用户验收问题台账 `CP-03`、`CP-07`、`CP-08`、`CP-09`、`CP-10`、`CP-11`、`PR-02`、`PR-03`

**对齐文档：** `Pinterest创意智能层-PRD-v0.2.md`、`0828-任务书-参考图推荐P0-两类提交.md`、Create Pin 0721 Revised Section E、`0830VibePin Create Pin 新功能与旧功能调整 PRD——产品评审草案.md`

## 0. 文档目的与裁决顺序

本 PRD 只补齐 Reference / 创意智能链路，不重做 Create Pin。它定义商品图、analysis、recommendation、direction、style reference 与 generation setup 之间的契约，以及这些输入如何在真实 provider 链中被追踪和恢复。

发生冲突时按以下顺序裁决：

1. 安全、owner 隔离、计费幂等和 Production 禁入。
2. Create Pin PRD 的 generation intent、reference group、slot、placeholder、job、terminal aggregation 合同。
3. 本 PRD 的创意输入、analysis/recommendation、direction、reference persistence 与交接合同。
4. 0828 Reference 请求/响应、`excludeIds`、`served`、429、analytics 合同。
5. 创意智能层 v0.2 的定位、服务端持久化和不自动发布原则。

Create Pin 0721 Revised Section E 已取代 v0.2 §4 中“推荐 Pin 原图绝不进入生成”的旧规定。用户显式选择的推荐 Pin 可作为一次生成的 `style_reference`；来源、linkback、provenance 与辅助 `patternTags` 必须同时保留。不得并行维护“只传标签”和“传 Reference 图”两套选择状态。

本 v1.0 取代本领域当日更早的补充草稿。

## 1. 范围与去重

### 1.1 本 PRD 负责

1. AI Drawer 内商品图、Reference 和 Direction 的媒体 fallback、loading/error/ready 表达。
2. `upload → analysis → recommendation → excludeIds/linkback → generation setup` 的单一状态机。
3. exact HTTP/status/error code 的安全保留、阶段化错误文案和恢复动作。
4. 推荐方向的代表图、视觉依据、来源与 provenance。
5. Creative direction 的可编辑输入态和最终值一致性。
6. `selectedReferences` 在关闭 Drawer、生成失败、reload/recovery 后的 owner-scoped 持久化。
7. 给 Create Pin generation 的冻结 setup snapshot、correlation IDs 和验收要求。
8. no-mock provider job、usage/reservation、429 与 analytics 的接口证据。

### 1.2 Create Pin PRD 独占

1. Studio shell、顶部入口、卡片网格、filter、全局 layout 和 Plan。
2. Batch Edit、批量 destination、发布与排期。
3. 响应式 shell 的列数、Drawer 容器和页面级移动布局。
4. `generationIntentId` 的持久化、reference groups、slot、placeholder、job dispatch/polling、idempotency、usage/metering。
5. generation toast/status renderer、成功/部分/失败聚合和 Retry 执行。

本 PRD 可以规定 Create Pin 接口必须满足的结果，但不得在 Reference 代码中复制上述能力。

### 1.3 非目标

1. 不新建第二个 Product Picker、Reference Picker、AI Drawer、direction model 或 generation state。
2. 不改 Reference scoring 公式、不训练模型、不新增 embedding。
3. 不自动选择 Reference、不自动发布、不自动 OAuth、不通过 flood 制造 429。
4. 不把 localStorage 升格为跨设备事实源。
5. 不在本文授权任何浏览器、上传、生成、部署、env、DB、migration 或 Production 动作。

## 2. Requirement IDs

| ID | 级别 | Requirement |
|---|---|---|
| `RCI-01` | P0 | 只使用现有 analysis、recommendation、selectedReferences 与 Create Pin generation 状态，不建立平行 lifecycle |
| `RCI-02` | P0 | Drawer 内商品、Reference、Direction 代表图的 broken/decode/missing 路径统一深灰中性 fallback，无乱码、白块或永久 spinner |
| `RCI-03` | P0 | 每个失败保留 exact stage、HTTP status、safe error code、requestId；用户看到具体可行动错误，不能只有“加载失败” |
| `RCI-04` | P0 | 上传后 analysis/recommendation 可从 pending 到 ready/failed；换图取消旧请求并隔离旧响应；Retry 只重试失败阶段 |
| `RCI-05` | P0 | 换一批使用同 seed、新 requestId、bounded excludeIds；已选项保留、被排除项不重复 |
| `RCI-06` | P1 | 推荐方向显示商品/Reference 代表图、Why it fits、来源和可追溯依据；缺图使用 `RCI-02` fallback |
| `RCI-07` | P1 | Creative direction 是明显可编辑的 form input，含 label/focus/helper/Save/Cancel/a11y；生成使用最终 committed 可见值 |
| `RCI-08` | P0 | 每张 Reference 保留 source/sourceUrl/reason/patternTags/role；linkback 与来源响应一致 |
| `RCI-09` | P0 | 同一 owner/intent 的 style reference 与 setup 在 Drawer close、generation failure、reload/recovery 后持久；A→B 不串数据 |
| `RCI-10` | P0 | Reference 向 Create Pin 只交付一份冻结 setup snapshot；不自行创建第二 intent/job/placeholder/toast/charge |
| `RCI-11` | P0 | 每个 generation intent 使用单一 toast id；pending/running/unknown 只显示中性进度，最终只出现一个 completed/partial/failed/cancelled 结果 |
| `RCI-12` | P0 | 真实 provider job、usage/reservation 与 Retry 保持 intent/group/slot 幂等；429 遵守 Retry-After，不二次 dispatch/charge |
| `RCI-13` | P1 | analysis/recommendation/reference/direction/generation correlation analytics 完整且 bounded，不含密钥、原图 bytes 或完整自由文本 |
| `RCI-14` | P0 | Preview 使用 verified user/workspace owner 隔离；没有可验证 owner 时不恢复旧 setup |
| `RCI-15` | P0 | 同一 final candidate 完成 desktop + 390px 两轮 no-mock USER 验收；历史 deployment 证据不能代替 |
| `RCI-16` | P0 | 本领域所有实现与验收仅限 Preview test backend；Production 不得带入 |

## 3. 单一数据与状态模型

### 3.1 权威字段

| 领域 | 权威字段/对象 | 禁止的影子状态 |
|---|---|---|
| Owner | verified `workspaceId + userId` | 客户端自报 owner 作为授权 |
| Creation setup | 当前 setup snapshot + stable client setup id | 第二份 Drawer-only generation setup |
| Product revision | 当前素材 stable id/url 的 `imageKey` + 单调 revision | 仅按 UI index 判断当前图 |
| Analysis | `imageAnalysisStatus/error/retryAfter` | 新 `creativeAnalysisState` |
| Recommendation | 现有 `recStatus/recommendationBasis/served` | 第二个 recommendation lifecycle |
| References | `selectedReferences`，snapshot 字段 `referenceSelections` | 上传/推荐/Saved 各自维护 selection |
| Direction | `selectedDirectionId/directionBrief/briefManuallyEdited` | 隐藏 prompt 作为用户可见值 |
| Generation | Create Pin `generationIntentId/groups/slots/job/status/usage` | Reference 自建 job 或计费状态 |

### 3.2 Owner 与 stale guard

1. 服务端从同源会话解析 owner，并以 RLS 或显式 owner predicate 读写。客户端传入的 owner 仅用于 correlation。
2. 恢复 key 至少包含 `workspaceId:userId:setupId`；生成后沿用 `generationIntentId`。
3. analysis/recommendation 响应 apply 前必须同时匹配 `ownerKey + setup/intent id + productRevision + requestId`。
4. 换图、切换 workspace、登出或开始新 setup 后，旧请求即使成功返回也必须丢弃，并记录 stale event。
5. A→B→A 中 B 不可读取 A 的图、references、direction、job 或 usage；A 返回后只恢复 A 自己的未提交 setup/intent。

## 4. 媒体 fallback 合同

该合同只覆盖 AI Drawer、推荐卡、Direction 依据和 selected Reference tray；Create Pin 卡片/shell fallback 由 Create Pin PRD 实现，但视觉 token 必须一致。0901 台账对 missing/error 使用统一深灰 fallback 的要求，取代 Create Pin 旧草案中的“品牌化兜底图”表述；品牌渐变只用于 AI/主要 CTA，不用于缺图、解码失败或普通错误面。

### 4.1 状态

| 媒体态 | 可见结果 |
|---|---|
| loading | 固定比例深灰 skeleton；有超时边界 |
| ready | 显示解码成功且尺寸有效的图片 |
| missing | 立即显示统一深灰 fallback |
| decode_error | `onError/decode` 后转 fallback，不重复加载循环 |
| unsupported/tiny | 显示 fallback 与来源标签；不冒充真实图 |

### 4.2 视觉与 a11y

1. fallback 使用统一深灰中性色和固定 aspect ratio；品牌渐变、粉紫随机色、白块不得用于失败。
2. 不把文件名、URL、raw alt 或错误字符串绘制进图片区域，避免乱码和文字挤压。
3. 图片 alt 使用用户可理解的短标签；fallback 通过 `aria-label` 表达“图片不可用”，不朗读内部 URL。
4. loading 超过配置的媒体超时后必须转 fallback；不得永久 spinner。
5. fallback 不能改变卡片尺寸、方向选中态、Reference provenance 或可操作按钮位置。

## 5. Exact error contract

### 5.1 归一化错误

每个 upload、analysis、recommendation 和 generation handoff 错误必须在内存、QA 证据与安全日志中保留：

```ts
type CreativeError = {
  stage: "upload" | "analysis" | "recommendation" | "generation";
  httpStatus: number | null;
  errorCode: string;
  requestId: string | null;
  retryable: boolean;
  retryAfterSeconds?: number;
  safeMessageKey: string;
};
```

1. `httpStatus` 保留真实响应状态；network/abort/timeout 无 HTTP 时为 `null`，`errorCode` 分别记录 `network`、`aborted`、`timeout`。
2. `errorCode` 优先取服务端安全 code；不得把 provider raw body、stack、token 或完整 URL 作为 code。
3. 用户界面显示阶段化、可行动文案，例如“商品已上传，但分析超时；重试分析”，不能只显示泛化“加载失败”。
4. Create Pin PRD 禁止客户端暴露 raw HTTP/provider error 仍然有效：exact status/code 用于 QA evidence、support correlation 与安全日志；用户只看到 safe message 与短 request/support id。
5. Retry 必须按 `stage` 精确路由，不得重新执行已经成功的上游阶段。

### 5.2 HTTP/恢复矩阵

| Stage | Exact condition | 用户状态 | 恢复 |
|---|---|---|---|
| Upload | 4xx/5xx/network | 上传失败；本地文件选择保留 | 只重试 upload |
| Analysis | 401 | 测试登录失效 | 登录恢复后用户重试 |
| Analysis | 422 | 图片不可分析 | 换图或显式重试 |
| Analysis | 429 + Retry-After | 显示真实倒计时 | 归零后一次手动重试 |
| Analysis | timeout/network/5xx | 商品已上传，分析失败 | 只重试 analysis |
| Recommendation | 200 + 0 items | 诚实空态，不是错误 | 换一批/换商品 |
| Recommendation | 401/429/5xx/network | 推荐区显示具体失败；selected tray 保留 | 只重试 recommendation |
| Generation | 429 pre-dispatch | 未开始；不得扣费 | Create Pin 确认未 dispatch/reserve 后，按其合同创建关联 `retryOfIntentId` 的显式重试 |
| Generation | acceptance unknown | 中性“确认结果中” | poll/reconcile，不创建新 intent |
| Generation | terminal partial/failed | 单一 warning/error | 仅失败 slot/group，Create Pin 幂等 |

## 6. 无 mock 状态机

下列视图态全部由 §3 的现有字段派生，不落新 enum。

| Phase | 权威条件 | 唯一 UI | 下一步/恢复 |
|---|---|---|---|
| Empty | 无稳定商品素材 | 添加商品图 | 选择/上传 |
| Uploading | 上传未完成 | 深灰进度；无推荐成功态 | ready 或 upload error |
| Analysis none | 商品 ready，status=`none` | 分析 CTA | 每 setup/图自动一次或手动触发 |
| Analysis pending | status=`pending` | skeleton + 正在分析；同图 CTA disabled | ready/failed；换图 abort |
| Analysis ready | status=`ready` 且 revision 匹配 | 当前图分析依据 | 发 recommendation |
| Analysis failed | status=`failed` | exact stage/code 对应文案 | 只重试 analysis |
| Analysis rate-limited | failed + rate_limited | Retry-After 倒计时 | 归零后手动重试 |
| Recs loading | request in flight | rec skeleton；selected tray 保留 | ready/empty/error |
| Recs ready | items>0 | 诚实 basis、理由、来源、linkback、选择、换一批 | select/refresh |
| Recs empty | 200 + items=0 | 类目/供给空态 | 换一批/换商品 |
| Recs failed | `recStatus=error` | exact recommendation error | 只重试 recs |
| Direction ready | committed direction | Direction cards + visual evidence + Edit | select/edit |
| Direction editing | dirty/focused | form input + Save/Cancel；Generate disabled | save/cancel |
| Setup ready | 商品、direction、model/count 有效 | Generate CTA + 真实副作用说明 | 冻结 snapshot 交 Create Pin |
| Generation pending | Create Pin intent 非终态 | 一个稳定 toast id 的中性进度 | poll/reconcile |
| Generation terminal | Create Pin aggregator terminal | completed/partial/failed/cancelled 恰好一个 | 展示结果或幂等 Retry |

### 6.1 Upload → analysis → recommendation

1. 文件先在 Preview test asset boundary 上传成功，取得稳定 asset id/url；随后才触发 `/api/ai-copy/analyze`。
2. 同一商品、setup 和阶段 analysis 单飞；换图递增 product revision，并 abort 旧 analysis 与 recommendation。
3. 旧响应不得覆盖新图；记录 `image_analysis_discarded_stale`。
4. recommendation 首次请求使用当前 `imageKey`、新 `requestId`、UTC daily seed、`limit=9`，`excludeIds` 为空。
5. analysis ready 才可标“为此商品推荐”；仅 text/basis 或 category fallback 时使用既有诚实标题合同。

### 6.2 换一批、selection、linkback 与 provenance

1. 换一批创建新 `requestId`，保持同一 daily seed。
2. `excludeIds = 去重(累计展示 ids ∪ 已选 ids)`，最多 72；超出时 FIFO 丢最早项。
3. 已选 Reference 固定保留在 selected tray 与原卡选中态；只替换未选推荐位；新结果不得包含 excluded id。
4. 每项统一保存 `id/imageUrl/source/sourceUrl/title/reason/patternTags/role`。
5. 来源 taxonomy 与 Product Picker 共用用户词汇：用户上传、商品库、Saved reference、Pinterest inspiration、历史生成。unknown 用中性“来源不可用”。
6. linkback 使用响应的 exact `sourceUrl/pinterestUrl`；不得猜 URL。打开 linkback 不触发 OAuth、发布或写入。
7. 推荐 Pin 只有用户显式选择后才作为 `style_reference` 进入 frozen setup；取消选择同时从 tray、卡片、snapshot 与后续 group 移除。

## 7. 推荐 Direction 与编辑

### 7.1 可追溯视觉依据

1. 每个 Direction 展示 name、Why it fits、当前商品代表图，以及最多 2 张相关 Reference 缩略图或结构化 visual cues。
2. 代表图旁显示来源；点击 Reference 依据可回到对应推荐卡或 linkback。
3. Direction 依据必须能回溯 `productRevision/imageKey + selectedReferenceIds + analysis requestId + recommendation requestId`。
4. 无可用图时显示 `RCI-02` 深灰 fallback 和 visual cue，不隐藏来源、不伪造代表图。
5. selected 状态同时使用边框/check/`aria-selected`，不得只靠颜色；切换 Direction 不清空 References。

### 7.2 明显可编辑输入态

1. Creative direction 使用真实 `textarea/input`，有持久 label、可见边框、Edit affordance、focus ring 和 helper。
2. 支持 Tab、Enter/明确 Save、Escape/Cancel；Cancel 恢复上次 committed 值。
3. dirty 时 Generate disabled，并提示先 Save；Save 后 `directionBrief` 是唯一可见/生成值。
4. generation snapshot 中的 direction 文本必须逐字等于最终 committed 可见值；不得从隐藏旧 prompt 生成。
5. analytics 只记录 direction id、edited boolean、长度 bucket，不发送正文。

## 8. Style reference 持久与 recovery

1. 所有来源共用 `selectedReferences`；snapshot 使用同结构的 `referenceSelections`，不得各自维护数组。
2. Drawer close/reopen、route 往返、generation failure 和页面 reload 都恢复同一 owner/setup 的商品、References、Direction、model、count、variation。
3. Create Pin 接受 generation setup 后，其 recoverable intent snapshot 必须包含完整 `referenceSelections` 与 provenance；失败不能只恢复 flat URLs。
4. 服务端 owner-scoped snapshot 是事实源；local cache 只做短期恢复。冲突时使用 owner 匹配、revision 更新且可验证的服务端记录。
5. 只有显式 Remove、Reset/New creation 或用户完成当前动作后明确开始新 setup 才清除；close、failure、unknown、reload 不清除。
6. 恢复时某媒体已失效，保留 selection/provenance 并显示深灰 fallback；不得静默删除或替换为别的 owner 的图。

## 9. 与 Create Pin generation 的接口

Reference 不执行 generation orchestration，只交付冻结 setup。

```ts
type CreativeGenerationSetup = {
  setupId: string;
  ownerCorrelation: string;
  productRevision: number;
  productImages: Array<{ assetId?: string; imageUrl: string; role: "product" }>;
  referenceSelections: Array<{
    id: string; imageUrl: string; source: string; sourceUrl?: string;
    reason?: string; patternTags?: string[]; role: "style_reference";
  }>;
  directionId: string;
  directionBrief: string;
  analysisRequestId?: string;
  recommendationRequestId?: string;
  modelKey: string;
  countPerGroup: 1 | 2 | 3 | 4;
};
```

1. snapshot 在一次 Generate 点击时冻结，之后 UI rerender 不得改变已提交 payload。
2. Reference 只调用一次 Create Pin generation entrypoint；不得用 state-changing POST 探测 inline/worker。
3. Create Pin 将每个 Reference 映射为一个 group；无 Reference 时仍有一个无参考 group。
4. Create Pin 创建 `generationIntentId`、expected slots、upfront placeholders、job 与 usage/reservation；Reference 只保存 returned correlation。
5. Reference client role `style_reference` 到 generation wire role `reference` 的映射由共享 adapter 完成一次，不出现第三词汇。

### 9.1 单一 toast 与唯一终态

1. 每个 intent 使用稳定 toast id `generation:{generationIntentId}`；所有进度和终态更新同一 id。
2. submitting/accepted/queued/running/unknown 是非终态，统一中性 loading 视觉；不得使用成功色/check。
3. terminal 只允许 `completed`、`partial`、`failed`、`cancelled` 之一；同一 intent 只 emit 一次 terminal toast。
4. `completed` 要求全部 expected slots 成功；`partial` 要求至少一项成功且至少一项失败/缺失；`failed` 要求零成功且失败已确认。
5. acceptance unknown 只显示“确认结果中”，先 poll/reconcile；不得同时显示“正在生成”成功态和“未生成”错误。
6. Retry 由 Create Pin 仅重试失败/缺失 slot/group；已成功 slot 不重发，placeholder 不重复，idempotency/usage 不二次执行。

## 10. Provider、usage/reservation、429 与 analytics

### 10.1 Provider 与计量

1. no-mock USER 验收调用真实 Preview provider，记录 intentId、jobId、groupId、slotId、provider mode、terminal outcome。
2. usage/reservation 关联 verified owner + intent/job；同 intent replay 返回原 job/result，不创建第二 reservation/charge。
3. partial 按现有计量合同记录真实成功数；本文不改变计费公式。
4. generation failure/recovery 必须保留 snapshot 和 job correlation；不得通过新 intent 隐藏旧 job。

### 10.2 429

1. analysis、recommendation、generation 的 429 必须保留 exact HTTP 429、safe code、request/intent id 与合法整数 `Retry-After ≥ 1`。
2. UI 按服务端秒数倒计时，归零前无 Retry；不自动循环。
3. generation pre-dispatch 429 不得创建 provider job 或 charge；倒计时后由 Create Pin 先确认未 dispatch/reserve，再按 Create Pin 合同创建关联 `retryOfIntentId` 的显式重试。只有传输/acceptance 不确定时才复用原 intent 做 reconcile。
4. 只验收自然 429，禁止 flood；未自然出现记 `NOT_OBSERVED`。

### 10.3 Analytics 与 payload bounds

| Event/record | 关联字段 |
|---|---|
| `image_analysis_started/ready/failed/rate_limited/discarded_stale` | setup/intent、imageKey、productRevision、requestId、safe error |
| `reference_recs_requested/served/refreshed` | requestId、imageKey、analysis status、basis、excludedCount |
| `reference_selected/rejected` | setup/intent、referenceId、source |
| `direction_selected` | setup/intent、directionId、evidenceCount |
| Create Pin `generation_started/completed/partial/duplicate_suppressed` | generationIntentId、groups/count、expected/succeeded/failed |
| generation job/usage audit | owner、intent/job/group/slot、reservation/settlement outcome |

1. `excludeIds ≤ 72`；recommendation `limit=9`；selected references 沿用上限 3。
2. count `1–4`；最多 3 reference groups × 4 slots，总 expected slots ≤12。
3. analytics 单事件 payload ≤4096 bytes；超限先截断 ids/文本，保留 correlation、basis、counts、status。
4. 不发送图片 bytes/data URL、token、Cookie、provider key、raw provider body、完整 prompt、Creative direction 正文。
5. analytics best-effort，不得改变用户结果；generation intent/job/usage 记录才是执行和计量事实源。

## 11. Production 排除与允许副作用

### 11.1 仅 Preview test backend 允许

1. 测试上传对象、analysis/cache、owner-scoped setup/intent snapshot。
2. recommendation served 与 analytics events。
3. 动作时确认后的真实 provider test job、Pin Draft、placeholder、usage/reservation 与测试额度消耗。
4. 用户要求保留的测试数据不自动清理。

### 11.2 明确禁止

1. 不发布、不排期、不写 Pinterest/Instagram/Facebook、不 OAuth。
2. 不付款、不做 Creem checkout。
3. 不读取或写入 Production DB/storage，不改 Production env、migration、deploy、VPS/timer。
4. 不把 Preview fixture、test owner、test Supabase ref、provider test key 或 debug route 带入 Production bundle/config。
5. 不用 mock、route interception、历史 deployment 输出或伪造登录冒充 USER PASS。

## 12. 与 Create Pin 的接口表

| 接口面 | Reference / 创意智能提供 | Create Pin 提供 | 集成不变量 |
|---|---|---|---|
| Media fallback | Drawer 商品/Reference/Direction 统一深灰 token 与 error state | shell/card media fallback renderer | 同 token；不复制 shell layout 逻辑 |
| Product input | stable asset/url、imageKey、revision、analysis correlation | upload/product picker 容器与 Content 关联 | 换图递增 revision；旧响应不 apply |
| Recommendation | items、served、basis、excludeIds、selection/provenance/linkback | Drawer 容器和页面导航 | selectedReferences 单一集合 |
| Direction | direction cards、representative evidence、committed brief | Fresh Pin direction/output variant 执行 | 复用同 direction id/type，不建第二 direction model |
| Frozen setup | `CreativeGenerationSetup` 一次性交付 | generation intent、groups/slots/placeholders | 一次点击只交付一次；snapshot immutable |
| Generation progress | 展示 correlation 与 setup recovery 入口 | job dispatch/poll、aggregator、single toast id | Reference 不直接推导 terminal |
| Retry | 保留 setup、失败阶段与 correlation | intent reconciliation、失败 slot/group 重试 | 不重复 job/placeholder/charge |
| Usage | 展示测试副作用和 receipt | reservation/meter/settlement | verified owner + intent/job 幂等 |
| Responsive | Drawer 内容在 390px 可操作、无内部 overflow | shell/grid/Drawer container breakpoint | shell/layout 缺陷回 Create Pin，不在 Reference 重做 |
| BatchEdit/Publish | 无 | 全部行为与 UI | 本 PRD 不进入该范围 |

## 13. 两轮验收矩阵

最终证据必须绑定同一个 exact runtime/deployment、Preview test backend 和 verified test owner。

| Matrix ID | Requirements | Round / viewport | 操作 | 预期 | 必收证据 |
|---|---|---|---|---|---|
| `AC-RCI-01` | RCI-02、RCI-03、RCI-04 | R1 1440 | 上传 fixture，观察 broken/decode、analysis pending→ready/failed | 深灰 fallback；无乱码；错误保留 stage/HTTP/code/requestId；无永久 pending | screenshot、Console、upload/analyze HTTP |
| `AC-RCI-02` | RCI-04、RCI-05、RCI-08 | R1 1440 | 推荐→选中→换一批→linkback | 同 seed、新 requestId、excludeIds≤72、不重复、选择保留、linkback exact | request/response、served、excludeIds、source URL |
| `AC-RCI-03` | RCI-06、RCI-07 | R1 1440→390 | 查看 Direction 依据，编辑/Cancel/Save，切 390 | 代表图/来源可追溯；输入态明显；390 无内部横向溢出；payload 等于 committed 值 | 两 viewport screenshot、a11y、frozen setup |
| `AC-RCI-04` | RCI-09、RCI-14 | R1 390 | close/reopen、reload、generation failure recovery | 同 owner setup/reference/direction 恢复；无跨 owner 数据 | before/after snapshot、owner-safe receipt |
| `AC-RCI-05` | RCI-10、RCI-11、RCI-12 | R1 390 | count=1 真实 provider generation | 一次 frozen setup；单 toast id；pending 中性；唯一 terminal；job/usage/reservation 可关联 | intent/job/group/slot/toast/usage receipt |
| `AC-RCI-06` | RCI-02、RCI-03、RCI-04 | R2 390 | 使用不同 fixture 重复 upload/analysis/recs | 不复用 R1 imageKey/result；具体错误与 fallback 一致 | HTTP/code/requestId、Console、screenshots |
| `AC-RCI-07` | RCI-05、RCI-06、RCI-07、RCI-08 | R2 390→1440 | 选择、换一批、linkback、Direction 编辑后切桌面 | 状态保持、provenance 与 final brief 一致 | excludeIds、source、snapshot、两 viewport |
| `AC-RCI-08` | RCI-09、RCI-14 | R2 owner A→B→A | 切换 owner/workspace 并恢复 | B 看不到 A；A 只恢复自己的 setup | owner-scoped API/status、无敏感内容截图 |
| `AC-RCI-09` | RCI-10、RCI-11、RCI-12、RCI-13 | R2 1440 | 第二次真实 generation；自然 429 若出现 | 幂等 job/usage；单 terminal；429 尊重 Retry-After、不 flood | job/usage、analytics≤4KiB、429 或 NOT_OBSERVED |
| `AC-RCI-10` | RCI-15、RCI-16 | 两轮 | 核 exact candidate/test binding/side effects | 两轮同 candidate；Production refs/actions=0 | runtime/deployment、bundle/test ref、side-effect ledger |

### 13.1 判定

1. 所有 P0 matrix 在同一 final candidate 完成，才能给 Reference USER PASS。
2. 登录、浏览器控制、provider 或外部服务不可用分别记 `BLOCKED`/`NOT_OBSERVED`，不能从代码测试推导 USER PASS。
3. 自然 failed/partial/429 未出现时对该分支记 `NOT_OBSERVED`；不得人为制造 Production 副作用。
4. Console 出现 uncaught error、React #310、页面 crash、跨 owner 数据、重复 job/charge、冲突 toast 或 Production ref 均为 P0 FAIL。

## 14. Traceability

| 台账 ID | 对应 Requirement | 主要章节 | 验收 Matrix |
|---|---|---|---|
| `CP-03` | RCI-02、RCI-03 | §4、§5 | AC-RCI-01、06 |
| `CP-07` | RCI-03、RCI-04 | §5、§6.1 | AC-RCI-01、06 |
| `CP-08` | RCI-06 | §7.1 | AC-RCI-03、07 |
| `CP-09` | RCI-07 | §7.2 | AC-RCI-03、07 |
| `CP-10` | RCI-09、RCI-14 | §8、§3.2 | AC-RCI-04、08 |
| `CP-11` | RCI-10、RCI-11、RCI-12、RCI-13 | §9、§10 | AC-RCI-05、AC-RCI-09 |
| `PR-02` | RCI-04、RCI-05、RCI-08、RCI-10、RCI-11、RCI-12、RCI-13、RCI-15、RCI-16 | §6、§9、§10、§13 | AC-RCI-01、AC-RCI-02、AC-RCI-04、AC-RCI-05、AC-RCI-06、AC-RCI-07、AC-RCI-08、AC-RCI-09、AC-RCI-10 |
| `PR-03` | RCI-02、06、08 | §4、§6.2、§7 | AC-RCI-02、03、07 |

## 15. 实施与放行门禁

1. Reference、Create Pin、data/service、auth/platform 按 §12 接口拆分提交；不得由一个实现复制多个 Owner 状态。
2. Contract tests 必须覆盖 fallback、exact error、analysis stale guard、excludeIds、selection/provenance、direction edit、reference recovery、frozen setup、single toast、owner isolation 与 payload bounds。
3. TypeScript、registry、专项测试与 fresh webpack build 必须绑定 exact candidate；历史绿灯不能替代新增门禁。
4. USER 验收由 Sol/high 按 §13 逐项复核；独立审查不可用时只记 `NO VERDICT`。
5. Production 必须维持 §11 的零带入规则；本 PRD 或 docs commit 不授权任何 Production 行为。
