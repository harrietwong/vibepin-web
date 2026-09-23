# VibePin Create Pin 生产阻断补充 PRD v1.0

> 日期：2026-09-01
>
> 状态：`PRODUCTION BLOCKED`
>
> 范围：Create Pin / Studio / Batch Edit / AI Drawer / Generation recovery / 与发布目标直接相连的 UI
>
> 文档性质：生产放行补充规格，不代表实现完成、Preview 已部署或 USER E2E 已通过
> 明确排除：Insights、生产部署、生产数据库、真实发布、付款和 OAuth 状态变更

## 0. 产品裁决

Create Pin 的当前目标不是继续堆入口或状态提示，而是让用户从“选来源”到“生成、编辑、排期、发布前准备和失败恢复”始终操作同一条可追踪的 Content。任何 UI 都不得创建平行的 Product、Reference、generation job、usage、destination 或 publish result 事实源。

本 PRD 对 2026-09-01 统一 Preview 台账中的 `CP-01..CP-12`、当日新增持久化阻断 `CP-13`、发布目标展示漂移 `CP-14` 与 `ST-01..ST-05` 给出可实现和可验收的最终契约。所有 P0 必须在同一个最终 Preview runtime/deployment 上关闭；P1 必须完成或有经产品负责人接受的明确处置。此前本地测试、旧 Preview 截图或代码字符串检查都不能单独解除 Production blocker。

当前 Studio UI 候选 `codex/unified-preview-ui-feedback-0901@2142aeeba81189c25c9e5758b573a959f10bc1c5` 已完成三轮机械门禁，但尚未集成或部署。它只覆盖 ST 视觉基线，不关闭 generation、Product/Reference、destination 或 USER E2E 的 P0。

## 1. 权威输入与冲突顺序

本稿使用以下冻结或当日快照作为输入：

| 输入 | 精确身份 | 本稿用法 |
|---|---|---|
| 统一 Preview 问题台账 | `docs/prd/0901-统一Preview用户验收问题台账.md`；编写快照 SHA-256 `211C227354AC6E81ECB75C0D196C96C094A8DC7F20BD6890EDF5093BD65A1D17` | `CP-01..12`、`ST-01..05` 和生产放行边界 |
| 0830 Create Pin 产品稿 | `codex/createpin-prd-0830@e8bee249c270a6d77c21ad8c48a86fa1cdb1cae5`；文档 SHA-256 `8E19F23872EE659BA56CEAED5E3011935AEB21BAAFD83A78FE0A01E02E2DD2BC` | 保留 Content、intent、group/slot、Plan 单按钮、Schedule、Publish/Failed 的长期模型 |
| Product / Picker PRD | `codex/product-picker-supplemental-prd-0901@dbd756c55bc3b8dd29396b179d1d980ba7268e9e`；SHA-256 `1627D220BA6B751513A968A916C1B43347A6963D23F9276709C53150ED13E9CC` | 消费 `PO90-01..09` 的商品来源、fallback、加载和上传链路 |
| Reference / 创意智能 PRD | `codex/reference-creative-prd-v1-0901@dbbe66ef717d63b21e2e6718bf8377bd3e3ffb09`；SHA-256 `6AA416F711ACDDBE6C4642C9A89FB543047FC42E256F899A7496A26572478F63` | 消费 `RCI-01..16` 的 analysis、recommendation、selection、direction 和 provenance |
| Multichannel / OAuth PRD | `codex/multichannel-oauth-prd-0901@8f410f3936f86b3b4cd16c4ca4ede300fdc1dfac`；SHA-256 `E9F1A6EE2BDD9DA24AA9168B41BAF810BF649288D5ED8DEB06E405FF96715AC2` | 双向锁定 destination、optional schedule、publish result、usage 与 recovery |
| Studio UI 候选 | `codex/unified-preview-ui-feedback-0901@2142aeeba81189c25c9e5758b573a959f10bc1c5` | ST-01..05 的实现候选；尚未构成 Preview USER PASS |
| Multichannel incident receipt | `MULTICHANNEL_PUBLISH_INCIDENT_READ_ONLY_60DB_20260901.md`；SHA-256 `5E5B8BAE7B805BC42214F33AC2D7EDD0FF1E91D3AAB78457C83FD78AA79A087A` | runtime `2142aeeb` / deployment `dpl_2v1...` 的重复 `PUT /api/pin-drafts` 422、`PUT /api/user-store` 202 与 canonical `pin_drafts` 缺行证据；登记为 CP-13 |
| 当前发布入口只读 readback | `FINAL_POST_STUDIO_PUBLISH_ENTRY_READBACK_83983889_20260901.md`；SHA-256 `C6A2A16895B65DE4E8B2E6B6346ADBB0E38DAD5FAEC0E4AAC561B2D484ECEABB` | source `83983889...` / deployment `dpl_64y1...`：卡片显示 `Home Decor` 后单击一次 Publish 入口未出现确认框；GET-only 复核 jobs/destinations/usage 均为 0，登记为 CP-14；不得据此推断具体前置 blocker |

冲突顺序固定为：当日用户明确反馈与本 PRD > 0901 领域冻结 PRD > 0830 Create Pin 稿 > 更早 Create Pins / Plan 草案。Insights 始终由独立文档和会话负责。

## 2. 范围与非目标

### 2.1 本期范围

1. 统一创建入口：上传、URL、商品或社区灵感、AI。
2. 商品来源 taxonomy、选品灵感加载与诚实错误/空态。
3. 图片上传到 analysis、recommendation、direction 和 generation 的可恢复链路。
4. Direction 卡片视觉依据与 Creative direction 明确输入态。
5. style reference、setup 与 generation intent 的原子保存、owner 隔离和恢复。
6. 单一 generation feedback、稳定 toast id、group/slot/placeholders、计量与幂等。
7. Batch Edit 与单卡一致的 destinations；可选且默认折叠的发布时间。
8. Studio 视觉基线：深灰 fallback、低噪声失败入口、紧凑卡片、Plan 单控制、Schedule/Publish 层级。
9. 草稿 durable sync：混合批次逐草稿保存/拒绝、可操作错误、reload 与账户切换对账。
10. 卡片显示的发布目标必须等于发布确认读取的明确 intent；旧 Board/category 兼容投影不得伪装成已保存目标。
11. 两轮真实 Preview USER E2E：每轮桌面 `1440×900` 与移动 `390×844`。

### 2.2 非目标

1. 不建设 Insights、效果分析或内容诊断页面。
2. 不在 Create Pin 内实现 OAuth 连接管理；连接动作回到 Settings。
3. 不创建第二套 Product catalog、Reference recommendation cache、generation lifecycle、usage ledger 或 publish engine。
4. 不授权 Production 部署、Production DB/migration、真实发布、付款或环境修改。
5. 不以 mock provider、源码字符串、旧 deployment 或 build PASS 代替真实 USER 证据。

## 3. 稳定 Requirement Anchors

| Anchor | 台账 | 稳定语义 |
|---|---|---|
| <a id="cp-req-entry-ia"></a>`CP-REQ-ENTRY-IA` | CP-04 | Create Pin 只有一套“添加内容”信息架构，统一承载上传、URL、商品/社区灵感和 AI；快捷入口只是同一模型的捷径。 |
| <a id="cp-req-product-taxonomy"></a>`CP-REQ-PRODUCT-TAXONOMY` | CP-05 | Product 来源标签来自 canonical provenance，用户可理解、可追溯，不能用 `Uploaded` / `Product Ideas` 冒充来源事实。 |
| <a id="cp-req-media-fallback"></a>`CP-REQ-MEDIA-FALLBACK` | CP-03、ST-05 | missing、loading timeout、decode error、1×1、broken URL 和 generation failure 统一深灰中性 fallback，无乱码、粉紫背景或永久 spinner。 |
| <a id="cp-req-product-inspiration"></a>`CP-REQ-PRODUCT-INSPIRATION` | CP-06 | 选品灵感具有可诊断的 loading/empty/error/retry/ready 状态和 exact HTTP 证据。 |
| <a id="cp-req-upload-recommend"></a>`CP-REQ-UPLOAD-RECOMMEND` | CP-07 | 上传、analysis、recommendation 绑定同一 owner/intent/image；换图隔离旧响应，Retry 只重试失败阶段。 |
| <a id="cp-req-direction-evidence"></a>`CP-REQ-DIRECTION-EVIDENCE` | CP-08 | Direction 卡片展示与商品/Reference 关联的代表图、来源、依据和选中态。 |
| <a id="cp-req-direction-input"></a>`CP-REQ-DIRECTION-INPUT` | CP-09 | Creative direction 是清晰可编辑且键盘可达的 form input；请求只使用已提交的可见值。 |
| <a id="cp-req-generation-setup-atomic"></a>`CP-REQ-GENERATION-SETUP-ATOMIC` | CP-10 | Generate 前原子保存 owner-bound setup、selection 和 intent；失败、关闭、刷新后可恢复，只有显式新建/删除才清除。 |
| <a id="cp-req-generation-feedback-atomic"></a>`CP-REQ-GENERATION-FEEDBACK-ATOMIC` | CP-11 | 同一 generation attempt 只有一个稳定 toast id；pending 非 success，终态原位更新；未知结果保留 recoverable intent。 |
| <a id="cp-req-generation-groups"></a>`CP-REQ-GENERATION-GROUPS` | CP-12 | `max(referenceCount,1) × count` 在 request/job/group/slot/placeholder/result/retry/usage 全链一致；2 refs×4 必须是 8。 |
| <a id="cp-req-durable-draft-sync"></a>`CP-REQ-DURABLE-DRAFT-SYNC` | CP-13 | 一个语义不合法或目标不可用的草稿不能阻断同批合法草稿持久化；每个 draft 有可对账 outcome、可操作错误和 owner-scoped 恢复，不以 user-store 202 冒充 canonical durability。 |
| <a id="cp-req-batch-capabilities"></a>`CP-REQ-BATCH-CAPABILITIES` | CP-01、CP-02 | Batch Edit 与单卡能力一致；至少两选才出现；destinations 和 optional schedule 支持 all/none/mixed。 |
| <a id="cp-req-publish-destinations"></a>`CP-REQ-PUBLISH-DESTINATIONS` | CP-01 | 单卡和 Batch 使用同一 canonical destination 引用、能力、子目标与 disabled reason。 |
| <a id="cp-req-destination-presentation-truth"></a>`CP-REQ-DESTINATION-PRESENTATION-TRUTH` | CP-14 | 卡片、Batch、Plan 与确认框显示同一份明确保存的 destination intent；仅有 legacy Board/category 时必须标为“尚未选择发布账号/目标”，不能显示成可发布 destination chip。 |
| <a id="cp-req-provider-presentation"></a>`CP-REQ-PROVIDER-PRESENTATION` | CP-01 | Provider identity/icon 来自 shared registry；Pinterest、Instagram、Facebook 一致，TikTok 客户侧隐藏。 |
| <a id="cp-req-connection-readonly"></a>`CP-REQ-CONNECTION-READONLY` | CP-01 | Create Pin 只读消费连接状态；Connect/Reconnect/Disconnect/Remove 回到 Settings。 |
| <a id="cp-req-scheduling-optional"></a>`CP-REQ-SCHEDULING-OPTIONAL` | CP-02 | 发布时间可选且默认折叠；只有明确选择 Schedule 才展开和要求时间，取消后清空隐藏值。 |
| <a id="cp-req-publish-feedback"></a>`CP-REQ-PUBLISH-FEEDBACK` | CP-01 | 一个 publish job 的逐 destination 状态独立显示；部分成功不伪装成全成功或全失败。 |
| <a id="cp-req-content-identity"></a>`CP-REQ-CONTENT-IDENTITY` | CP-01 | 编辑、重开和多渠道 fan-out 保持稳定 Content intent；同一 Content 发布计量一次。 |
| <a id="cp-req-publish-recovery"></a>`CP-REQ-PUBLISH-RECOVERY` | CP-01 | delivery unknown 时锁住重复发布，先查询原 intent/job/result；成功 destination 永不重发。 |
| <a id="cp-req-studio-visual"></a>`CP-REQ-STUDIO-VISUAL` | ST-01..05 | Studio 使用低噪声失败入口、紧凑 token、单 Plan 控制和明确 CTA 层级，桌面/390 均可用。 |
| <a id="cp-req-preview-acceptance"></a>`CP-REQ-PREVIEW-ACCEPTANCE` | 全部 | 所有 P0 与 P1 处置必须绑定同一个最终 Preview，并完成两轮桌面+390、console/HTTP/副作用证据。 |

## 4. 与 Multichannel 的双向契约

下表引用 [《0901 Multichannel 发布目标与 OAuth 补充 PRD》](./0901-Multichannel发布目标与OAuth补充PRD.md) 的冻结 anchors。两份 PRD 的 anchors 未在最终集成分支双向解析前，Create Pin 与 Multichannel 均保持 `Production blocked`。

| Multichannel anchor | Create Pin anchor | 边界 |
|---|---|---|
| [`MC-REQ-DESTINATION-MODEL`](./0901-Multichannel发布目标与OAuth补充PRD.md#mc-req-destination-model) | `CP-REQ-PUBLISH-DESTINATIONS` | Multichannel 拥有 canonical 模型；Create Pin 负责单卡/Batch 的一致消费与保存。 |
| [`MC-REQ-PROVIDER-IDENTITY`](./0901-Multichannel发布目标与OAuth补充PRD.md#mc-req-provider-identity) | `CP-REQ-PROVIDER-PRESENTATION` | Provider exact identity/icon 由 registry 提供，Create Pin 不硬编码。 |
| [`MC-REQ-OAUTH-LIFECYCLE`](./0901-Multichannel发布目标与OAuth补充PRD.md#mc-req-oauth-lifecycle) | `CP-REQ-CONNECTION-READONLY` | OAuth 生命周期属于 Settings/Multichannel；Create Pin 只显示状态和入口。 |
| [`MC-REQ-SCHEDULE-OPTIONAL`](./0901-Multichannel发布目标与OAuth补充PRD.md#mc-req-schedule-optional) | `CP-REQ-SCHEDULING-OPTIONAL` | now/scheduled、timezone 与目标快照语义必须一致。 |
| [`MC-REQ-PUBLISH-RESULT`](./0901-Multichannel发布目标与OAuth补充PRD.md#mc-req-publish-result) | `CP-REQ-PUBLISH-FEEDBACK` | Multichannel 保存逐平台事实；Create Pin 只投影，不合并或制造成功。 |
| [`MC-REQ-USAGE-ONCE`](./0901-Multichannel发布目标与OAuth补充PRD.md#mc-req-usage-once) | `CP-REQ-CONTENT-IDENTITY` | 一个 Content fan-out 只计一次；UI 重开或 replay 不改变身份。 |
| [`MC-REQ-RECOVERY`](./0901-Multichannel发布目标与OAuth补充PRD.md#mc-req-recovery) | `CP-REQ-PUBLISH-RECOVERY` | 未知投递先查询，禁止盲目重发或错误退款。 |
| [`MC-REQ-PREVIEW-GATE`](./0901-Multichannel发布目标与OAuth补充PRD.md#mc-req-preview-gate) | `CP-REQ-PREVIEW-ACCEPTANCE` | 两领域必须在同一最终候选交付用户可见证据。 |

## 5. 单一数据契约

### 5.1 来源与商品

`ProductSource` 必须是结构化事实，不是展示文案：

```ts
type ProductSource =
  | "user_upload"
  | "url_import"
  | "shopify"
  | "amazon"
  | "product_opportunity"
  | "community_inspiration";
```

每个选择至少保留 `productId/opportunityId`、`source`、`sourceUrl/canonicalUrl`、`imageAssetId/imageUrl`、`provenanceRevision` 与公开链接可用性。`Uploaded`、`Product Ideas` 只能作为旧数据迁移输入，不能直接作为最终用户标签。

### 5.2 Drawer setup 与 generation attempt

```ts
type GenerationSetup = {
  ownerUserId: string;
  workspaceId: string;
  setupRevision: string;
  productSelections: ProductSelectionSnapshot[];
  selectedReferences: ReferenceSnapshot[];
  referenceSelections: ReferenceSelectionSnapshot[];
  selectedDirectionId: string | null;
  committedDirectionBrief: string;
  modelKey: string;
  format: string;
  pinsPerReference: 1 | 2 | 3 | 4;
  variationMode: string;
};

type GenerationAttempt = {
  generationIntentId: string;
  ownerUserId: string;
  workspaceId: string;
  immutableFingerprint: string;
  setupRevision: string;
  retryOfIntentId?: string;
  state: "drafting" | "persisting" | "accepted" | "generating" |
    "partial" | "completed" | "failed" | "unknown" | "cancelled";
  expectedOutputCount: number;
  groups: GenerationGroup[];
  jobId?: string;
  toastId: string;
  usageReservationId?: string;
};
```

`immutableFingerprint` 必须覆盖 owner、workspace、产品/参考资产 identity、方向最终值、model、format、每组 count 和 retry target；不能把完整 prompt、完整 URL、图片 bytes 或 secret 写入 lookup key、DOM、console 或 analytics。

### 5.3 Group、slot 与 placeholder

```text
groupCount = max(selectedReferences.length, 1)
expectedOutputCount = groupCount × pinsPerReference
```

每个 slot 必须保留 `groupId`、`referenceId/referenceImageKey`、`slotIndex`、`placeholderDraftId`、`status`、`resultDraftId/resultAssetId` 和安全错误类别。数组位置不能代替 slot identity。2 references×4 必须在第一条 provider 请求前已有 8 个可归属 placeholders；两个组各自拥有 4 个 slot。

### 5.4 Destination 与排期

单卡和 Batch 均消费 Multichannel 的 canonical destination：provider、`connectionId`、provider account identity snapshot、Pinterest Board/Facebook Page 等子目标、capability revision 和 disabled reason。发布时间使用 `publishMode=now|scheduled`；`now` 时 `scheduledAt` 必须为空，`scheduled` 时才需要带 IANA timezone 的时间。

### 5.5 Canonical draft durable-sync outcome（CP-13 / P0）

`pin_drafts` 是登录账户下 Draft 的 canonical server authority；`user-store` 只保存其各自 adapter 的文档。`PUT /api/user-store` 返回 202 不能证明相同 Pin 已写入 `pin_drafts`，UI 也不得据此显示“所有更改已同步”。

一个语法合法的 Draft 批次必须返回逐草稿 outcome，而不是只返回整批 success/failure：

```ts
type DraftSyncOutcome = {
  draftId: string;
  status: "applied" | "stale" | "rejected" | "deferred";
  updatedAt?: string;
  code?: "destination_not_schedulable" | "destination_unavailable" | "quota_exceeded" | "stale" | "storage_unavailable";
  userMessageKey?: string;
  retryable: boolean;
};
```

同一响应可以同时包含 `applied` 和 `rejected`。只有 malformed JSON、缺失认证、无法识别整个 envelope 等 request-level 错误可以拒绝整批；单条 destination、schedule、quota 或 stale 问题必须隔离到该 `draftId`。服务端不得先发现一个坏草稿就跳过所有合法 sibling；客户端只 acknowledge 已 `applied` 或已完成 merge 的 `stale` 项，不能清空未持久化项。

每条本地 Draft 及 outbox record 必须绑定 verified `ownerUserId + workspaceId + draftId + updatedAt`。不得把 A 的全局 localStorage/outbox 与 B 的当前 access token 组合发送；登出/切换账户先冻结 A scope、停止其 timer/request，再初始化 B scope。A 重登后按自己的 scope reconcile，不新建 schedule、publish、generation、usage 或重复 Draft。

## 6. 状态机

### 6.1 媒体状态

```text
empty → loading → ready
          ├→ decode_failed ─┐
          ├→ timeout ───────┤→ neutral_fallback
          └→ invalid_media ─┘
```

`loading` 必须有有界超时；任何失败都退出 spinner。fallback 使用统一深灰背景、低对比中性图标和可访问名称，不渲染 broken `<img>` 的 alt 文本，不显示 `No image`，也不使用红、粉、紫或随机渐变。

### 6.2 Product inspiration 读取

```text
idle → loading → ready(items>0)
               → empty(items=0, request succeeded)
               → error(auth|environment|network|server|schema)
error → retrying → ready | empty | error
```

真实 `200 + items=[]` 才是空态。401/403、test binding 错误、5xx、timeout 或 schema 错误不得伪装为空态。Retry 创建新 requestId，但不写 Product、Draft、schedule、job 或 usage。

### 6.3 Upload → analysis → recommendation

```text
selected → uploading → uploaded
uploaded → analysis_pending → analysis_ready → recommendation_pending → recommendation_ready
                         └→ analysis_failed
recommendation_pending ──→ recommendation_failed
```

每次换图产生新 `imageKey/setupRevision`，取消旧 AbortController，并用 revision guard 丢弃迟到响应。Retry 只从明确失败阶段继续；analysis 失败不能重复上传，recommendation 失败不能重复 analysis。用户已选的 Reference 在换一批时保留；`excludeIds` 有界、去重且不重复展示当前可见项。

### 6.4 原子 setup、generation 与反馈

```text
editing
  → persisting_setup_and_intent
  → accepted
  → generating
  → completed | partial | failed | unknown | cancelled
```

Generate 的顺序是硬契约：

1. 读取并规范化当前可见 setup。
2. 校验 owner/workspace 与所有资产可访问性。
3. 原子保存 setup snapshot、stable intent、fingerprint 和 recovery metadata。
4. 只有保存成功后才锁定 CTA、建立 group/slot/placeholders 并提交生成。
5. 使用 `toastId = generation:{ownerScope}:{generationIntentId}` 显示 loading/info。
6. HTTP replay、job poll、reload recovery 和 ambiguous transport recovery 复用同一 intent。
7. 最终用同一 toast id 原位更新为 completed、partial、failed 或 unknown；不得新增互相矛盾的第二条终态提示。

`unknown` 表示提交结果未知，不等于失败。此时保留 recoverable intent，禁止新建 job、placeholders、reservation 或扣量；刷新和 Retry 必须先 exact reconcile。只有服务端证明原 attempt 已终态失败且无活跃/已完成 job 后，用户明确 Try again 才可建立带 `retryOfIntentId` 的子 intent，并默认只覆盖失败 slot。

### 6.5 Toast 与 CTA 状态

| Attempt 状态 | Toast | CTA/placeholder |
|---|---|---|
| persisting / accepted / generating | 单一 loading/info；不能使用绿色 success | Generate disabled；placeholders 显示明确进度 |
| completed | 同 id 更新为 success，展示成功数 | placeholders 全部替换为结果；CTA 恢复 |
| partial | 同 id 更新为 neutral/warning，展示成功数与失败数 | 成功 slot 保留，失败 slot 可恢复；CTA 不允许整批盲重试 |
| failed | 同 id 更新为 error，展示失败数和安全原因 | 所有 pending spinner 结束；无 orphan placeholder；保留一个 recoverable intent |
| unknown | 同 id 更新为 neutral “正在确认结果” | 阻止新提交；提供 Recheck，不显示“未生成任何 Pin” |
| cancelled | dismiss 或同 id 更新为 cancelled | 未开始 slot 停止，已完成结果保留 |

重复点击、重复 `onPlaceholdersReady`、重复 `onSettled` 或 React Strict Mode 重放不得新增 toast、job、placeholder、reservation、usage event 或 charge。成功数、失败数和 Retry target 必须来自同一 slot 集合。

### 6.6 Owner 隔离与恢复

本地或服务端 recovery record 必须绑定 verified `ownerUserId + workspaceId`。A 登出后 B 登录时，B 不得读取、提交或恢复 A 的 setup、prompt、Reference 或 intent；B 的 mount 必须产生 0 次 A-payload replay、0 个 B job 和 0 次 B usage。A 再登录时可以按自己的 owner scope 恢复原 intent。没有可验证 owner 时 fail closed。

### 6.7 Batch destination 与 optional schedule

Batch 只在 `selectedCount >= 2` 时出现。destinations 使用 `all/none/mixed` 三态；mixed 不能静默解释为 all 或 none。打开、切换、取消和关闭不会保存、排期、发布或计量。

发布时间默认折叠并标注“可选”。只有用户点击“设置发布时间”才展开；清除或取消后 `publishMode=now` 且隐藏时间为空。Batch 时间同样使用 all/none/mixed；保存前展示 changed/skipped/failed 影响。

### 6.8 Draft durable-sync 与账户切换（CP-13 / P0）

```text
local_dirty → queued → syncing → synced
                         ├→ action_required(destination/schedule/quota)
                         ├→ deferred(transient/server unavailable) → retrying
                         └→ stale → merge_required → queued | synced

owner A active → A frozen on sign-out → owner B isolated → B reconcile
                                      └→ A re-login → A reconcile
```

`action_required` 是确定性语义拒绝，不能无限指数重试；用户修正对应 Draft 后才产生新 `updatedAt` 并重新入队。`deferred` 才允许有界自动重试。同步 UI 必须指出具体 Draft 和动作，例如“此 Pin 的 Pinterest Board 已不可用，请重新选择”；不能只有一个全局黄点和“正在重试”。reload 后，本地较新的 rejected Draft 仍可见并保持 `action_required`，服务端较新事实按现有 LWW/CAS merge；任何一方都不能静默覆盖另一方。同步和 reconcile 绝不触发 schedule、publish、provider generation 或 usage。

## 7. 详细功能要求

### 7.1 统一创建入口

Desktop 使用一个主要“添加内容/创建 Pin”入口，打开后展示上传图片、从 URL 导入、从我的商品选择、从选品/社区灵感选择、使用 AI 创建。现有快捷按钮可保留为该入口的 deep link，但不能开启不同的数据模型或重复 drawer。Mobile 使用同一 action sheet，不堆叠多个大 CTA。

### 7.2 Product taxonomy 与选品灵感

来源文案必须回答“来自哪里”，而不是“系统觉得它好不好”。建议用户文案为：我的上传、URL 导入、Shopify、Amazon、选品机会、社区灵感。每个 label 由 canonical source 映射并配有可访问图标；中英、简中、繁中一致。

选品灵感加载必须显示具体可行动状态：登录失效、测试环境未绑定、服务暂不可用、请求超时、暂无灵感。错误 UI 提供 Retry 并保留当前 picker 状态；不得用永久 spinner 或泛化 `could not be loaded` 吞掉原因。

从我的商品、Shopify、Amazon、选品机会或社区灵感选择商品后，必须把公开商品 URL 自动带入 Website URL 的空字段；已有手动值永远不覆盖。没有公开 URL 时保持可编辑空字段并显示安全说明，不能出现不可编辑的 `No linked product` 死状态。用户可以随时选择、更换、解除产品关联，产品关联和 Website URL 仍是两个独立字段。

### 7.3 Direction 与 Creative direction

每个 Direction 卡显示代表缩略图、来源、`Why it fits`/对应本地化解释和选中态。代表图只能来自当前商品、已选 Reference 或该推荐响应；缺图使用统一 fallback，不能虚构图片。

Creative direction 使用标准 label、明显边框、focus ring、helper、字数约束和 Save/Cancel 语义。关闭但未保存时恢复 committed 值；Generate 只读取 committed 可见值。键盘可进入、编辑、保存和取消。

### 7.4 Style reference 持久化（CP-10 / P0）

当前根因已定位：`AiVersionDrawer.closeDrawer()` 会 `saveSetup() → onSetupChange`，但 `doGenerate()` 直接调用 `onGenerate`；随后 `StudioBoard.onPlaceholdersReady` 关闭 Drawer，导致本次 `selectedReferences/referenceSelections` 未写入 `aiSetupCache`。

修复边界固定为：Generate 前先完成 `CP-REQ-GENERATION-SETUP-ATOMIC`；关闭/重开、全失败、刷新和恢复都能回填同 owner 的商品、Reference、Direction、model、format 和 count。只有用户明确“新建”或删除选择才清除；不能在普通 close、Generate、失败或 route refresh 时隐式清空。

### 7.5 单一 generation feedback（CP-11 / P0）

当前根因已定位：`StudioBoard.onPlaceholdersReady` 使用 `toast.success` 表达 pending；`onSettled` 全失败时另建 `toast.error`，两条提示无稳定共享 id，导致同一页面同时显示绿色“正在生成”与红色“未生成任何 Pin”。

修复必须满足 `CP-REQ-GENERATION-FEEDBACK-ATOMIC`。pending 只能是 loading/info；终态在原 toast 原位更新或 dismiss。全失败必须停止 pending spinner 和重复 CTA，保留 recoverable intent；Retry 先 reconcile，不能重复 job/placeholders/reservation/usage/charge。toast 与 request/job/usage 通过非敏感 correlation 关联，但客户 UI 不显示内部 ID。

### 7.6 2 refs×count4 与 React #310（CP-12 / P0 回归）

`pinsPerReference` 必须可选 1、2、3、4；2 refs×4 的 UI 总数明确显示 8。所有 8 placeholders 在第一组结果返回前创建，两组各 4，结果和失败按 slot 稳定归属，整批只触发一个用户 intent 和一次计量语义。

`BatchEditDrawer` 的所有 Hooks 必须位于任何 early return 之前。closed→open→closed、单选→双选→清空和刷新都不能触发 React #310；真实运行时回归必须补充，不能只用源码字符串断言。

### 7.7 Destinations、默认值与发布结果

Batch 与单卡显示相同的 Pinterest、Instagram、Facebook provider、账号/Page、Board、状态、capability 和 disabled reason。TikTok 客户侧完全隐藏。单账号可预填；多账号必须明确选择。Pinterest 可以按账号提示最近有效 Board，但切换账号必须清除旧 Board；不得出现 `QA Board`、测试 Board、`No board` 或仅有 `Pinterest` 的静态行。

发布结果属于 Multichannel。Create Pin 只显示同一 publish intent/job 的逐 destination accepted/publishing/published/failed/delivery_unknown。部分成功保留成功 remote ID/permalink；Retry 不重发已成功腿。打开 destinations、Batch、Plan 或 optional schedule 不得触发 publish。

当前 source `8398388974ccdb855c83064d107b72819b81be24` 的只读源码和 USER 证据确认了 CP-14：卡片 `PinBoardCard` 使用 `contentDestinations()` 展示 chip；该 helper 在 `scheduledDestinations[]` 为空时仍可能从 legacy `targetConnectionId`，甚至仅有 `boardId/boardName`，投影出 Pinterest/Board。发布确认却使用 `explicitPublishDestinations()`，只接受明确保存的 `scheduledDestinations[]`。因此卡片可能显示 `Home Decor/家居`，但确认边界判定为零 canonical destination。这个视觉投影不能作为发布授权或账号身份。

修复不得恢复默认 Pinterest/默认账号/默认 Board 兜底。对无明确 intent 的旧 Draft，卡片应显示中性、可行动的“尚未选择发布目标”，并引导打开同一个 destination picker；只有保存了 provider、connection/account 与所需 Board/Page 的 intent 后，才显示真实 destination chip。所有 Publish 入口仍需进入确认框；若图片或字段前置校验阻断，必须在点击后显示持久、卡片级、可行动原因，不能只有短暂 toast 或无反馈。卡片 chip、确认框、dispatch receipt 与 server job 必须基于同一 snapshot/fingerprint。

点击主 Schedule 动作时，默认使用 Smart Schedule 的下一个合法时段，不要求用户先选择时间；自定义发布时间是小号次级入口并默认折叠。未找到合法时段时必须说明原因并保持 Draft，不得静默写入虚假时间。

### 7.8 Durable draft sync（CP-13 / P0）

对 runtime `2142aeeba81189c25c9e5758b573a959f10bc1c5` 的只读源码审计确认：`PUT /api/pin-drafts` 只有两个 422 来源，分别是 `destination_not_schedulable` 与 `destination_unavailable`；两者都在任何逐 Draft 写入前对整批 `return 422`。因此一个坏 Draft 会阻断同批所有合法 Draft。客户端 `pinDraftSync.flush()` 又把非 202/409 的 422 归入通用失败，保留整批 outbox 并持续 backoff；响应中的 `drafts[]/code/userMessage` 没有进入卡片级状态。incident receipt 未保存 422 response body，所以不能在本事故中猜定是哪一个 code，但两条可能路径具有同一整批阻断机制。

后续 GET-only test DB readback 进一步排除了“现存服务器行自身持续触发”的解释：`pin_drafts` 共 59 行但 live scheduled 为 0；`social_connections` 恰有 3 条 connected；persisted Draft 中 TikTok/不可排期引用为 0，缺失或断连 connection 引用也为 0。结合重复 PUT 422，可确定至少有一个仅存在于客户端待同步 batch/outbox 的 incoming payload 带有拒绝条件，并阻断了其合法 siblings。`scheduledDestinations` 或 `targetConnectionId` 残留是高概率候选，但在取得该请求的脱敏 422 body 前仍是待证假设，不能写成已定字段级根因。

同一源码的 `pinDraftStore` 使用非 owner-scoped key `vp:pin_drafts:v1`，`pinDraftSync` 是进程级 idempotent singleton；logout 只调用 `signOut`，没有停机、清空或切换 scope。后续 `getToken` 读取当前 session，存在 A 本地 outbox 被 B token 提交的隐私/重复风险。实现不得只把 batch size 改成 1 来掩盖问题；必须同时完成 server per-draft outcome、client per-draft ack/error、owner scoping 与 reload/account-switch reconcile。

用户可见状态至少区分“已保存到服务器”“仅保存在此设备/等待同步”“需要处理”。点击状态可定位具体 Draft；修正后错误原位消失。任何 rejected Draft 都保留编辑内容，不得因 server canonical 缺行在 reload 时消失，也不得因 pull 回来的旧行覆盖较新的本地修正。

## 8. Studio 视觉与交互基线

| 台账 | 最终要求 | 当前候选边界 |
|---|---|---|
| ST-01 | 移除 Studio 常驻全宽失败 Banner；Failed badge/低噪声通知按 Pin 数计数并可进入 Failed→Publish failures | `2142aeeb` 已实现候选；需最终 Preview USER 验证 |
| ST-02 | 卡片和字段使用 Studio spacing token；1440/1280 保持合理多列，390 单列无横向溢出 | `2142aeeb` 已实现候选；需真实 viewport 证据 |
| ST-03 | Plan 只有一个控制：hover/focus 预览，click 固定，再 click 取消关闭；不足两列时 overlay，移动全屏 | `2142aeeb` 已实现 container-aware 候选；需 USER 交互证据 |
| ST-04 | Publish 为唯一主 CTA；Schedule 低视觉权重，桌面 34px 视觉高度，移动点击热区至少 44px | `2142aeeb` 已实现候选；需 390 运行时证据 |
| ST-05 | 日常兜底统一深灰；品牌渐变只用于 AI/主 CTA | `2142aeeb` 已实现候选；仍需覆盖 Drawer/Picker/失败链全路径 |

卡片字段顺序保持 Media、Title、Description、Website URL、Destinations、Schedule/Publish、状态。AI 文案与 AI 图按钮使用轻量 secondary 风格。destination 展开前后卡片宽度和网格列数不变。Failed 卡片与其他生命周期卡片结构一致，只增加安全失败原因和动作。

所有 Draft、Scheduled、Posted、Failed 卡片必须有一致的 Details 入口；不得只在部分卡片显示。页面和客户数据中不得出现 `Studio Board V2`、`QA Board`、`No board`、`No image`、fake token 或其他 QA/内部标记。

## 9. i18n 与文案

1. 所有客户可见字符串必须使用 message key，至少覆盖 English、简体中文、繁体中文；中文界面不能夹杂 `Review`、`Publish to`、`No image`、`No board` 或内部英文错误。
2. Pin 计数按 Pin 使用正确单复数，不把 destination 数显示成失败 Pin 数。
3. Generation 文案必须明确区分“正在生成”“已生成 N 个”“生成 N 个、失败 M 个”“未能确认结果”“未生成任何 Pin”。
4. 错误只显示稳定客户类别；raw provider body、HTTP status、stack、token、job/database ID 不进入 UI。
5. 来源标签、Direction 依据、optional schedule、mixed selection 和 disabled reason 三语言语义一致。
6. Draft sync 的 `destination_not_schedulable`、`destination_unavailable`、`quota_exceeded`、`stale` 与 `storage_unavailable` 使用稳定 message key；English、简中、繁中都必须说明受影响 Pin 和下一步，不能回显 raw response。

## 10. A11y

1. 统一入口、picker、Direction、Creative direction、Plan、Batch、Schedule 和 Publish 均可键盘操作并有可见 focus。
2. 单一 generation toast 使用同一 live-region 节点更新；pending 使用 polite，明确失败可以 assertive，但不能同时存在冲突播报。
3. 图像 fallback 提供与上下文一致的 accessible name；装饰图标 `aria-hidden`，不读取 raw alt 乱码。
4. modal/drawer/sheet 使用正确 dialog 语义、focus trap、Escape 和 focus return；Plan 固定态不伪装为 modal。
5. 390px 所有主要触控目标至少 44×44；桌面视觉紧凑不能缩小移动点击热区。
6. 状态不能只靠颜色区分；loading、partial、failed、unknown 均有文本和可识别 icon。
7. Draft 从 syncing 进入 action-required 时通过单一 polite live-region 播报一次；卡片上的错误与修正动作可键盘聚焦，修复后不会重复播报旧错误。

## 11. Desktop 与 390px

### 11.1 Desktop `1440×900`

1. Studio 常规宽度至少显示两列可编辑卡片；Plan 只有在容器仍能容纳两列时 dock。
2. destinations 展开不改变卡片宽度；Batch 是可读的全屏工作区。
3. AI Drawer 同时展示商品、Reference、Direction、Creative direction、model、count 与明确总量，不造成主要 CTA 拥挤。
4. 失败提示低噪声，不覆盖创建入口或卡片操作。

### 11.2 Mobile `390×844`

1. `documentElement.scrollWidth`、`body.scrollWidth` 和主要容器宽度不得大于 390；drawer 内也不得横向溢出。
2. 卡片单列；Plan 为全屏/overlay，不依赖 hover；Schedule 触控热区至少 44px。
3. 统一创建入口使用 action sheet；Batch 双选后工具栏和 mixed destination 可完整操作。
4. Toast 不遮挡唯一主 CTA；长中文、英文和繁中均可换行且不截断关键状态。

## 12. HTTP、Console 与可观测性

每轮必须记录脱敏 method、path、status、duration、request/correlation ID 和结果类别。至少覆盖：

| 阶段 | 关键请求与证据 |
|---|---|
| Studio/auth | `/app/studio`、session/auth、draft/history GET；200/明确 redirect；登录 owner 一致 |
| Product inspiration | Product/Saved/Opportunity GET；区分 200 empty、401/403、429、5xx、timeout |
| Upload | `/api/studio/upload`；文件 fixture path/SHA、HTTP、asset/image identity；不记录图片 bytes 或签名 URL secret |
| Analysis | analysis 请求；imageKey/setupRevision、stage、HTTP、safe code/requestId |
| Recommendation | `/api/reference-candidates`；basis、requestId、bounded excludeIds、selected IDs 与 linkback |
| Generation submit | `/api/generate`；intent/fingerprint replay 类别、group/slot 数、job ID、HTTP |
| Job recovery | `/api/generation-jobs/{id}`；queued/running/partial/done/failed/unknown 和 slot readback |
| Usage | `/api/billing/usage` 或 test ledger readback；reservation/settle/replay 与净变化 |
| Destinations | canonical connections/capabilities/Boards；单卡与 Batch 同一结果 |
| Draft durable sync | `/api/pin-drafts` GET/PUT；记录脱敏 batch requestId、每 draft outcome/code、applied/rejected/deferred 数；与 `/api/user-store` 分开判定 |

console 必须采集 error/warn、source/stack（脱敏后）、unhandled rejection 和 React invariant。最终 PASS 要求无 React #310、无 uncaught error、无敏感信息、无意外写请求。HTTP 2xx 只能证明请求处理，不能单独证明 provider generation 或远端发布成功。

Analytics 只记录 bounded IDs/类别/计数/延迟桶；不得记录完整 prompt、完整 URL query、token、cookie、OAuth code、图片 bytes 或 raw provider body。

## 13. 副作用边界

| 动作 | 预期副作用 | 验收边界 |
|---|---|---|
| 打开 Studio、切 tab、打开/关闭 Drawer/Picker/Batch/Plan、单选/双选、编辑但取消 | 无服务端写入 | 不得出现 upload、generation、schedule、publish、usage POST/DELETE |
| 保存本地 setup | owner-scoped 本地/测试状态 | 不触发 provider、job、usage；A→B 隔离 |
| 测试上传 | 测试 Storage/草稿可能新增数据 | exact fixture+SHA、asset ID、保留测试数据；不得触 Production |
| Analysis / recommendation | 测试服务状态和请求日志 | 同 imageKey/revision；无 generation job/usage |
| Provider generation | 测试 job/assets/reservation/usage | 必须先核 exact test-bound candidate；一次 intent；保留测试数据；不发布 |
| Schedule 编辑 | 只有明确保存才写测试草稿/计划 | 默认折叠和取消无写；不得触真实发布 |
| Draft sync/reconcile | 测试 `pin_drafts` 行和 owner-scoped outbox 可能更新 | 只同步对应 Draft；不能触 schedule/publish/generation/usage；保留 incident 既有 59 行与无关 sentinel |
| Publish、OAuth、付款 | 本 PRD 不授权 | 全部禁止；需要另行 action-time 授权 |

## 14. 两轮 USER E2E 验收矩阵

每轮使用同一个最终 runtime/deployment，并按 `1440×900 → 390×844` 完成。Round 2 必须刷新并重开关键表面，不能直接沿用 Round 1 DOM。每个 Case 保存截图、viewport、点击路径、可见结果、console、关键 HTTP、登录 owner、job/usage 非敏感 ID 和副作用账本。

| Case | 覆盖 | 操作 | PASS |
|---|---|---|---|
| CP-A01 | 全部 | 登录 exact Preview，进入 `/app/studio` | runtime/deployment/test binding 可核；正确 owner；无 Production ref |
| CP-A02 | CP-04 | 打开统一创建入口并逐项查看 | Upload、URL、我的商品、选品/社区灵感、AI 都进入同一 IA，无重复模型 |
| CP-A03 | CP-05 | 查看来源筛选和卡片标签 | canonical taxonomy、图标、三语言与 provenance 一致 |
| CP-A03B | CP-04、CP-05 | 从我的商品/社区灵感选择有 URL 与无 URL 商品 | 空 Website URL 自动带入公开 URL；手动 URL 不覆盖；无 URL 仍可编辑且可换/解绑产品 |
| CP-A04 | CP-03、ST-05 | 对 missing/decode/broken/1×1/loading-timeout/failed fixture 逐项检查 | 全部深灰 fallback；无 broken alt、粉紫、白块和永久 spinner |
| CP-A05 | CP-06 | 打开选品灵感成功与 200 empty 条件 | ready/诚实 empty 正确；method/path/status/requestId 留证 |
| CP-A06 | CP-06 | 观察安全 error fixture 后 Retry | 错误类别具体；Retry 新 requestId；无 Draft/job/usage 写入 |
| CP-A07 | CP-07 | 上传安全 fixture | upload→analysis→recommendation 有界完成；stage/HTTP/requestId 可关联 |
| CP-A08 | CP-07 | analysis/recommendation 中换图 | 旧请求取消或迟到响应被丢弃，新图使用新 imageKey/revision |
| CP-A09 | CP-08 | 查看并切换 Direction | 每卡有代表图/来源/依据；选中态保留；缺图用统一 fallback |
| CP-A10 | CP-09 | 编辑、Cancel、Save Creative direction | 输入 affordance 明确；键盘可达；Generate payload 等于 committed 值 |
| CP-A11 | CP-10 | 选择 style references，关闭/重开 Drawer | 同 owner 恢复完全；普通 close 不清除 |
| CP-A12 | CP-10 | 选择 references 后直接 Generate，并在全失败/刷新后重开 | Generate 前 setup 已保存；references/model/count/direction 可回填 |
| CP-A13 | CP-11 | 0→all success | 同一 toast id：pending loading/info 原位变 success；只一个终态 |
| CP-A14 | CP-11 | 0 success / all failed | 同一 toast id 原位 error；pending 消失；无 generating orphan；intent 可恢复 |
| CP-A15 | CP-11 | partial success | 一个 neutral/warning 终态；成功数+失败数与 slot 一致；成功结果保留 |
| CP-A16 | CP-11、CP-12 | 双击 Generate、重复 callback/Strict Mode | 一个 intent/job/placeholder set/reservation/usage；无第二 toast |
| CP-A17 | CP-11 | 提交 commit 后两次响应丢失的确定性测试 | UI 为 unknown/rechecking；刷新 exact replay 原 job；不新建 job/charge |
| CP-A18 | CP-11 | generating 中刷新/重开 | 原 intent/job/group/slot 恢复；终态继续更新同一反馈 |
| CP-A19 | CP-10、CP-11 | owner A 生成未知→登出→B→A | B 零 replay/job/usage 且看不到 A；A 重登恢复原 intent |
| CP-A20 | CP-11 | quota 0、剩余额度、自然 429（如出现） | UX 诚实；429 遵守 Retry-After、不 flood；usage/reservation 对账 |
| CP-A21 | CP-12 | UI 选择 2 refs×count4 并生成 | 明确总数 8；8 upfront placeholders；2 groups×4；slot 归属稳定；一次 intent/usage |
| CP-A22 | CP-12 | Batch closed→open→closed，单选→双选→清空 | 无 React #310；双选才显示 Batch；状态可重复操作 |
| CP-A23 | CP-01 | 对比 Settings、单卡、Batch destinations | 三 provider identity/icon/capability/reason 一致；TikTok 不出现 |
| CP-A24 | CP-01 | 两张 destination 不同的卡进入 Batch，取消退出 | all/none/mixed 正确；无 silent overwrite；draft/schedule/publish/usage 不变 |
| CP-A25 | CP-02 | 单卡和 Batch 打开 optional schedule | 默认折叠/非必填；明确展开才要求时间；取消清空隐藏时间 |
| CP-A25B | CP-02 | 点击主 Schedule，不先打开自定义时间 | 自动分配下一个合法时段；无时段时保持 Draft 并显示原因 |
| CP-A26 | CP-01 | 新 Draft 读取默认目标/最近 Board，切换账号 | 合法默认带入；切账号清旧 Board；无 `QA Board`/测试文案/`No board` |
| CP-A27 | CP-01 | 只读检查既有 publish result/failed fixture | 逐 destination 事实一致；partial 不覆写成功；delivery unknown 禁止盲重试 |
| CP-A28 | ST-01..05 | 桌面检查失败入口、卡密度、Plan、CTA、fallback | 低噪声、两列、单 Plan 控制、Publish 主 CTA、Schedule 次级 |
| CP-A28B | 今日 Browser Comments | 对比不同 lifecycle 卡片、展开 destinations 和所有客户文案 | 每卡有 Details；展开不变宽；无 Studio Board V2/QA Board/No board/No image/内部标记 |
| CP-A29 | ST-02..04 | 390px 重复入口、卡、Batch、Drawer、Plan | 无横向溢出；单列；Plan overlay/fullscreen；触控目标≥44px |
| CP-A30 | 全部 | 每轮结束汇总 console/HTTP/side effects | 无 uncaught/React invariant/secret；关键请求齐；意外写请求为 0 |
| CP-A31 | 跨 PRD | 验证本稿与 Multichannel anchors | `CP-REQ-*` / `MC-REQ-*` 双向可解析且无语义冲突 |
| CP-A32 | CP-13 | 同批提交 1 个合法 Draft + 1 个 `destination_not_schedulable` Draft | 合法项 durable `applied`；坏项 `action_required` 且指向具体 Draft；无整批热重试 |
| CP-A33 | CP-13 | 同批提交 1 个合法 Draft + 1 个已断开/已删除 connection Draft | 合法项持久化；坏项显示 reconnect/重新选择动作；修正后只重试坏项 |
| CP-A34 | CP-13 | 422/partial outcome 后刷新、离线→在线、服务端 stale 冲突 | 本地新编辑不丢；逐项 reconcile；无重复 Draft、schedule、publish、job 或 usage |
| CP-A35 | CP-13 | owner A 有 pending/action-required Draft→登出→B 登录→A 重登 | B 零 A-payload PUT、零 A 内容可见、零副作用；A 恢复原 outbox 并只同步自己的行 |
| CP-A36 | CP-13 | 对比 `/api/user-store` 202 与 `/api/pin-drafts` outcomes/DB readback；在不触发 retry 的既有失败请求上留存脱敏 422 code/body 与 pending/action-required 数 | 仅 canonical Draft outcome+readback 可显示 server-synced；exact draftId/title/updatedAt 可对账；不记录 owner ID、connection ID、token 或完整 payload |
| CP-A37 | CP-14 | 准备仅有 legacy Board/category、明确零 destination、一个合法 canonical destination 三类安全 Draft；逐一对比卡片 chip、点击 Publish 后确认框和 GET-only 副作用账本 | legacy/零目标不伪装成可发布 chip，并显示“尚未选择发布目标”；合法目标显示 exact provider/account/Board；三类都进入确认框或给出持久卡片级前置原因；未点最终确认时 jobs/destinations/usage 增量均为 0 |

任何真实上传或 provider generation 都必须使用已登记的安全 fixture，记录 path 和 SHA-256，并在 exact test-bound Preview 上执行。测试数据按用户要求保留。若 provider、登录、quota 或浏览器控制阻断，必须标 `USER_E2E_BLOCKED` / `NOT_OBSERVED`，不能把机械测试升级为 USER PASS。

### 14.1 台账追踪

| 台账项 | Requirement | 验收 Case |
|---|---|---|
| CP-01、CP-14 | `CP-REQ-BATCH-CAPABILITIES`、`CP-REQ-PUBLISH-DESTINATIONS`、`CP-REQ-DESTINATION-PRESENTATION-TRUTH`、`CP-REQ-PROVIDER-PRESENTATION`、`CP-REQ-CONNECTION-READONLY`、`CP-REQ-PUBLISH-FEEDBACK`、`CP-REQ-CONTENT-IDENTITY`、`CP-REQ-PUBLISH-RECOVERY` | CP-A23、A24、A26、A27、A31、A37 |
| CP-02 | `CP-REQ-BATCH-CAPABILITIES`、`CP-REQ-SCHEDULING-OPTIONAL` | CP-A25、A25B |
| CP-03 | `CP-REQ-MEDIA-FALLBACK` | CP-A04、A28 |
| CP-04 | `CP-REQ-ENTRY-IA` | CP-A02、A03B |
| CP-05 | `CP-REQ-PRODUCT-TAXONOMY` | CP-A03、A03B |
| CP-06 | `CP-REQ-PRODUCT-INSPIRATION` | CP-A05、A06 |
| CP-07 | `CP-REQ-UPLOAD-RECOMMEND` | CP-A07、A08 |
| CP-08 | `CP-REQ-DIRECTION-EVIDENCE` | CP-A09 |
| CP-09 | `CP-REQ-DIRECTION-INPUT` | CP-A10 |
| CP-10 | `CP-REQ-GENERATION-SETUP-ATOMIC` | CP-A11、A12、A18、A19 |
| CP-11 | `CP-REQ-GENERATION-FEEDBACK-ATOMIC` | CP-A13..A20 |
| CP-12 | `CP-REQ-GENERATION-GROUPS`、`CP-REQ-BATCH-CAPABILITIES` | CP-A16、A21、A22 |
| CP-13 | `CP-REQ-DURABLE-DRAFT-SYNC` | CP-A32..A36 |
| ST-01 | `CP-REQ-STUDIO-VISUAL` | CP-A28 |
| ST-02 | `CP-REQ-STUDIO-VISUAL` | CP-A28、A29 |
| ST-03 | `CP-REQ-STUDIO-VISUAL` | CP-A28、A29 |
| ST-04 | `CP-REQ-STUDIO-VISUAL` | CP-A28、A29 |
| ST-05 | `CP-REQ-MEDIA-FALLBACK`、`CP-REQ-STUDIO-VISUAL` | CP-A04、A28 |

## 15. 代码影响面与实现边界

以下是预期最小影响面；实施前必须以最终基线重新审计，不能整文件覆盖或使用 ours/theirs：

| 责任 | 预期文件 |
|---|---|
| Drawer setup、CP-10、Direction/输入 | `web/src/components/studio/AiVersionDrawer.tsx` |
| CP-11 toast、Drawer lifecycle、Batch/Studio 汇总 | `web/src/components/studio/StudioBoard.tsx` |
| Batch Hook、destinations、optional schedule | `web/src/components/studio/BatchEditDrawer.tsx` |
| count4 / selection / groups | `web/src/lib/studio/selectedReferences.ts`、`web/src/lib/studio/generateAiVersions.ts`、`web/src/lib/studio/runAiGeneration.ts` |
| Recovery 与 owner isolation | `web/src/lib/studio/generationRecovery.ts`、`web/src/lib/pinDraftStore.ts` |
| Product/Reference picker 和 recommendation | `web/src/components/studio/CanonicalProductPicker.tsx`、`web/src/components/studio/InlineCreateAssetPicker.tsx`、`web/src/lib/studio/recommendationRequest.ts` |
| Upload/generation/job API | `web/src/app/api/studio/upload/route.ts`、`web/src/app/api/reference-candidates/route.ts`、`web/src/app/api/generate/route.ts`、`web/src/app/api/generation-jobs/[id]/route.ts` |
| Usage | `web/src/lib/server/usage/meterGeneration.ts`、`web/src/lib/server/usage/settleGenerationJob.ts` |
| Draft durable sync | `web/src/app/api/pin-drafts/route.ts`、`web/src/lib/pinDraftSync.ts`、`web/src/lib/pinDraftStore.ts`、`web/src/app/app/layout.tsx`、`web/src/components/sync/SyncStatusIndicator.tsx`、`web/scripts/test-pin-draft-sync.ts`、`web/scripts/test-pin-draft-conditional-write.ts` |
| Media/Studio UI | `PinFallbackArtwork.tsx`、`PinCardMedia.tsx`、`PinBoardCard.tsx`、`StudioBoardFilters.tsx`、`StudioPlanSidebar.tsx`、`boardUI.ts`、Studio-only CSS/i18n |
| Worker | `backend/tests/test_generation_worker.py` 所约束的 worker enqueue/result 路径 |

CP-10/CP-11 不得通过仅修改 toast 文案、仅在 close 时保存或仅加前端 debounce 解决。跨 client/API/job/worker 的稳定 intent、fingerprint、owner、group/slot 和 usage 契约必须保持；如需要 additive migration/RPC 变更，只能提交可审查 migration+rollback，并在获授权的 test DB 验证，绝不直接应用 Production。

## 16. 机械回归门禁

每个实现候选至少连续独立运行两轮，最终集成候选再运行完整矩阵：

1. Focused：CP-10 setup persistence、CP-11 single-toast、double click/callback、unknown recovery、A→B→A、count4、2×4、Batch Hook order、destination mixed、optional schedule、fallback；CP-13 mixed valid/rejected batch、per-draft ack/error、deterministic 422 no-hot-retry、owner switch、reload/stale reconcile。
2. Studio：完整 Studio registry，包括 generation orchestration/jobs/recovery/metering/limit、Product/Reference、Batch、Plan、publish result。
3. Backend：generation worker、slot attribution、settle-once、owner/idempotency 合同。
4. TypeScript：`tsc --noEmit`。
5. Build：Next webpack/default build，明确环境型 warning/blocker。
6. Diff gate：exact parent/HEAD/files、`git diff --check`、tracked+untracked clean、无 Production/env/migration side effect。

源码字符串断言可以做 guard，但不能是 Hook order、44px touch target、single toast、2×4、owner isolation 或 recovery 的唯一证据。

## 17. 实施分期

### Phase 0A — 生成原子状态（P0）

关闭 CP-10、CP-11、CP-12：Generate 前原子保存、stable toast id、unknown recovery、owner isolation、count4、2×4、React #310 和 usage 对账。完成门是 focused + Studio + backend + typecheck/build 全绿，且两轮真实 USER generation 通过。

### Phase 0B — 创建来源与可恢复链（P0）

关闭 CP-03、CP-06、CP-07：全链 fallback、选品灵感真实状态、上传→analysis→recommendation 与 stale guard。依赖 Product `PO90-*` 和 Reference `RCI-*` owner 的冻结输出。

### Phase 0C — Destinations 一致性（P0）

关闭 CP-01、CP-14：Batch 与单卡 canonical parity、mixed、安全取消、default destinations、逐 destination result，以及 card chip/confirmation/dispatch 的同一明确 intent。legacy Board/category 不得伪装为可发布目标；前置 blocker 必须卡片级可见。依赖 Multichannel `MC-REQ-*`；两份 PRD anchors 未双向解析不得完成。

### Phase 0D — Draft durable sync（P0）

关闭 CP-13：服务端逐 Draft semantic validation/outcome、客户端逐项 ack/action-required、owner-scoped store/outbox 生命周期、reload/account-switch reconcile 与 canonical DB readback。必须先用 deterministic route/sync tests 覆盖 mixed batch，再在 test-bound Preview 以安全 Draft fixture 完成两轮 USER 证据；不触发发布、generation 或 usage。

### Phase 1 — 信息架构与可用性（P1）

关闭 CP-02、CP-04、CP-05、CP-08、CP-09 和 ST-01..05：统一入口、taxonomy、Direction 视觉、Creative direction affordance、optional schedule、Studio 视觉/响应式。`2142aeeb` 可作为 ST 候选逐 hunk 集成，不得据此跳过 USER 验收。

### Phase 2 — 统一候选与两轮 USER E2E

在一个 test-bound Preview 集成所有依赖，冻结 runtime/deployment/manifest/DB ref；先完成无副作用只读项，再执行已授权的测试上传与 generation；禁止 Publish/OAuth/payment/Production。Round 1/2 全部 CP-A01..37 有证据后才进入最终审查。

## 18. Production Release Gate

以下全部成立前，Create Pin 状态固定为 `PRODUCTION BLOCKED`：

1. CP-01、CP-03、CP-06、CP-07、CP-10、CP-11、CP-12、CP-13 所有 P0 关闭。
2. CP-02、CP-04、CP-05、CP-08、CP-09 与 ST-01..05 已完成，或有经用户接受且记录理由/风险/后续日期的处置。
3. `CP-REQ-*`、`MC-REQ-*`、`PO90-*` 与 `RCI-*` 在最终集成分支可解析，职责无冲突。
4. 同一最终 runtime/deployment 完成两轮 `1440×900 + 390×844` USER E2E；每轮 console、HTTP、owner、job/slot/usage 和副作用证据齐全。
5. 2 refs×4=8、single toast、全失败、partial、unknown/double-loss、refresh recovery、A→B→A、quota/429 和 Batch closed→open→closed 均有直接证据。
6. 不出现 React #310、互相矛盾 toast、broken/乱码/粉紫 fallback、永久 spinner、测试 Board/内部错误或敏感字段。
7. 无意外 upload/generation/schedule/publish/usage 写入；允许的测试数据明确列出并保留。
8. mixed Draft batch 的合法 sibling 可 durable persist；拒绝项有 card-level action；reload 与 A→B→A 无丢失、越权 replay 或热重试；`user-store` 202 不被计作 Draft synced。
9. Sol/high 完成最终方案与证据审查；Claude Opus 独立审查可用时给出 verdict，不可用则记 `NO VERDICT`，不得伪造 PASS。
10. 本 PRD 不构成 push、merge、deploy、Production migration、真实发布、付款或 OAuth 授权；这些动作仍需独立流程。

## 19. 完成定义

文档完成不等于产品完成。只有当上述 Release Gate 全部满足、最终 receipt 绑定 exact runtime/deployment/commit、所有 P0 关闭且 USER E2E 两轮通过，Create Pin 才可从 `PRODUCTION BLOCKED` 进入发布评审。任何缺失、间接或来自旧候选的证据均保持 blocked，不以“未发现错误”推定通过。
