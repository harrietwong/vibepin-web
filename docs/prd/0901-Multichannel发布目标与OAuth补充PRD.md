# 0901 Multichannel/发布补充 PRD v1.1

- 文档状态：v1.1 / Production Blocker / 待实现与待验收
- 日期：2026-09-01
- Owner：Multichannel
- 优先级：P0
- 输入台账：`CP-01`、`MC-01`、`MC-02`、`MC-03`
- Requirement namespace：`MC-REQ-*`
- 基线 runtime：`b007957064082c291ebc3cf230ac9e25c230826d`
- 基线 manifest：`864349b0076b9d62b72f2281d209c34ef95f13ac`
- 当前 test-bound Preview deployment：`dpl_D6w29wpXBLTLFX8kQMEDEo1px2Vq`
- Stable Preview：`https://vibepin-fb-preview.vercel.app`
- Unique Preview：`https://web-mipx22asq-harriets-projects-86e9e358.vercel.app`
- 测试 Supabase project ref：`snulmwprsahzqvdbyenc`
- Create Pin PRD：[0901-VibePin-Create-Pin生产阻断补充PRD-v1.0](./0901-VibePin-Create-Pin生产阻断补充PRD-v1.0.md)，source branch `codex/createpin-production-blocker-prd-0901`，source HEAD `3f865f316ac97af3bc15fda8962b3fd47e74132d`

> 本文是产品契约与验收门禁，不是当前候选的 PASS 证明，也不授权 OAuth、发布、数据库、环境或 Production 操作。候选重新部署后，验收必须登记新的 exact runtime、manifest、deployment 和数据环境，历史证据不得平移。

## 1. 背景与目标

当前用户会在三个入口查看或修改发布目标：Settings Social、Studio 单卡 destinations、Batch Edit destinations。任何入口如果维护自己的 provider 列表、连接状态或可发布判断，就会出现同一个账号在某处 Connected、在另一处不可选，或 Batch Edit 只显示 Pinterest 的分裂体验。

本补充 PRD 要求三个入口共享一份 canonical connection/capability 事实，并完成以下 P0 目标：

1. Pinterest、Instagram、Facebook OAuth 成功后保存可验证的 exact identity，刷新和重新登录后仍存在。
2. Settings、单卡 destinations、Batch Edit destinations 对同一连接显示相同身份、状态、能力和不可用原因。
3. TikTok 在客户侧全部隐藏，旧客户端或陈旧草稿也不能绕过服务端能力校验发布或排期。
4. 在受控 test-bound Preview 中，对三平台各执行一次可审计测试发布；记录 HTTP、provider remote ID/permalink、计量和恢复结果。
5. 对超时、未知投递和部分成功禁止盲目重试，避免重复外部帖子和重复扣量。
6. 将卡片菜单的 `立即发布` 视为不可静默执行的高风险外部动作；任何 provider dispatch 前必须展示并取得一次明确的目标确认，且不得采用默认 Pinterest destination 兜底。

### 1.1 Requirement Anchors 与 Create Pin 分工

本 PRD 冻结 Multichannel 所拥有的跨页面连接、目标、发布和计量契约。Create Pin PRD 拥有 Content/Pin 卡片、编辑入口、可选排期交互与草稿持久化，但不得复制或改写 Multichannel 的 provider/account/Board/Page/capability 规则。

| Multichannel anchor | 本 PRD 责任 | Create Pin 对应 anchor | Create Pin 责任 |
|---|---|---|---|
| <a id="mc-req-destination-model"></a>`MC-REQ-DESTINATION-MODEL` | 三入口及发布确认共享 provider/account/Board/Page/validation/disabled-reason 模型；禁止静默/default destination fallback | [`CP-REQ-PUBLISH-DESTINATIONS`](./0901-VibePin-Create-Pin生产阻断补充PRD-v1.0.md#cp-req-publish-destinations) | 单卡与 Batch Edit 提供同一 destination 入口并保存 canonical 引用 |
| <a id="mc-req-provider-identity"></a>`MC-REQ-PROVIDER-IDENTITY` | 三 provider exact identity、图标与 TikTok 隐藏 | [`CP-REQ-PROVIDER-PRESENTATION`](./0901-VibePin-Create-Pin生产阻断补充PRD-v1.0.md#cp-req-provider-presentation) | 卡片与 Batch UI 使用 registry 提供的身份和图标，不自行硬编码 |
| <a id="mc-req-oauth-lifecycle"></a>`MC-REQ-OAUTH-LIFECYCLE` | OAuth 保存、刷新、过期、重连、断连语义 | [`CP-REQ-CONNECTION-READONLY`](./0901-VibePin-Create-Pin生产阻断补充PRD-v1.0.md#cp-req-connection-readonly) | Create Pin 只消费连接状态；连接动作回到 Settings |
| <a id="mc-req-schedule-optional"></a>`MC-REQ-SCHEDULE-OPTIONAL` | Publish now 与 optional schedule 的统一执行和最终确认契约 | [`CP-REQ-SCHEDULING-OPTIONAL`](./0901-VibePin-Create-Pin生产阻断补充PRD-v1.0.md#cp-req-scheduling-optional) | 发布时间默认不必填，仅在用户明确选择 Schedule 后展开与保存 |
| <a id="mc-req-publish-result"></a>`MC-REQ-PUBLISH-RESULT` | 逐 provider result、remote ID/permalink 与部分成功 | [`CP-REQ-PUBLISH-FEEDBACK`](./0901-VibePin-Create-Pin生产阻断补充PRD-v1.0.md#cp-req-publish-feedback) | 卡片展示同一 job 的逐 provider 状态，不合并或伪造成功 |
| <a id="mc-req-usage-once"></a>`MC-REQ-USAGE-ONCE` | 同一 Content 多渠道计量一次 | [`CP-REQ-CONTENT-IDENTITY`](./0901-VibePin-Create-Pin生产阻断补充PRD-v1.0.md#cp-req-content-identity) | Create Pin 保持稳定 Content intent，编辑或重开不能生成重复扣量身份 |
| <a id="mc-req-recovery"></a>`MC-REQ-RECOVERY` | 0 publishable、charge/refund、幂等与 ambiguous recovery | [`CP-REQ-PUBLISH-RECOVERY`](./0901-VibePin-Create-Pin生产阻断补充PRD-v1.0.md#cp-req-publish-recovery) | UI 在未知投递时锁住重复发布并引导查询/恢复 |
| <a id="mc-req-preview-gate"></a>`MC-REQ-PREVIEW-GATE` | 受控 Preview 动作边界、显式发布确认与两轮桌面/390 验收 | [`CP-REQ-PREVIEW-ACCEPTANCE`](./0901-VibePin-Create-Pin生产阻断补充PRD-v1.0.md#cp-req-preview-acceptance) | Create Pin 提供同一候选、同一 Content 的入口与用户可见证据 |

互引规则：Create Pin source PRD 已反向引用以上 8 个 `MC-REQ-*` anchors，本 PRD 也已引用其 8 个 `CP-REQ-*` anchors。两份 source 文档仍位于不同分支；只有最终集成分支同时包含两个文件且 link/anchor check 通过，才可关闭 `MC-A30` 与 `CP-A31`。任何 anchor 语义冲突以 domain owner 裁决为准，未解决前不得进入 Production。

### 1.2 0901 `立即发布` 事故证据与 UX 根因

在 exact manifest `60db2264d79ffe28babc7c16e0a389a66b98076d`、runtime `2142aeeba81189c25c9e5758b573a959f10bc1c5`、deployment `dpl_2v1Nv9HDzWysUirZpYYHbUqTX4UW` 的 Preview 验收中，执行者从卡片菜单点击 `立即发布`，原本预期进入目标摘要/确认页；实际实现却直接进入 `handlePublish`，且草稿没有 destinations 时可以采用 Pinterest default fallback。这是交互与动作语义不匹配的 P0 Production blocker：用户无法在不可逆外部动作前核对目标，也没有 Cancel 边界。

该次点击的只读事后审计已经关闭副作用疑点：完整验收时间窗内，exact deployment 的 `POST /api/pinterest/pins`、`POST /api/publish/social` 和 legacy `POST /api/publish` 均为 `0`；exact test DB 的 publish jobs、destinations、09:30Z 后 usage events 与 Pinterest publish analytics 也均为 `0`。裁决是 `INCIDENT_CLOSED_NO_PUBLISH_DISPATCH_OBSERVED`，只说明这一次点击没有到达 provider dispatch，不证明现有交互安全或发布功能 PASS。

权威只读 receipt：`D:\vp-tmp\coordination\receipts\MULTICHANNEL_PUBLISH_INCIDENT_READ_ONLY_60DB_20260901.md`，4515 bytes，SHA-256 `5E5B8BAE7B805BC42214F33AC2D7EDD0FF1E91D3AAB78457C83FD78AA79A087A`。

## 2. 范围

### 2.1 本期范围

- Settings Social 的连接、重连、断开、移除和身份展示契约。
- Studio 单卡 destinations 的账号、Page、Pinterest Board 选择与保存。
- Batch Edit destinations 的同源能力、混合选择和批量保存语义。
- Pinterest、Instagram、Facebook 的 OAuth 回调保存、连接状态和 exact identity。
- 三个平台共享 registry 提供的品牌图标、accessible label 与禁用态表现。
- TikTok 的客户侧隐藏与服务端 fail-closed 拒绝。
- Publish now 与 optional schedule 共用的目标快照、幂等、逐 destination 结果、remote ID/permalink 和计量契约。
- 卡片菜单、单卡编辑与 Batch Edit 共用的发布前确认、Cancel、无默认目标兜底与可访问性契约。
- Preview 两轮桌面与 390px 移动 UI 验收，以及一组受控测试发布验收。

### 2.2 非目标

- 不在本文中开通 TikTok。
- 不重设计套餐、extra account 定价或购买流程。
- 不修改第三方平台权限范围之外的 provider 能力。
- 不以 mock provider、伪造 remote ID、静态 DOM 字符串或历史部署截图替代真实 Preview 验收。
- 不授权 Production 发布、真实付款、Production 数据写入、环境变量修改或 migration。

## 3. Canonical 模型

### 3.1 Canonical connection

每条连接必须有稳定的内部 `connectionId`，并至少包含以下事实：

| 字段 | 契约 |
|---|---|
| `connectionId` | VibePin 内部稳定 ID；所有选择、草稿和发布任务引用它 |
| `ownerId` | 当前 workspace/user 的所有者边界；服务端强制校验 |
| `provider` | 仅允许当前 registry 中的 canonical key：`pinterest`、`instagram`、`facebook` |
| `iconKey` | shared provider registry 的品牌图标键；UI 不得用纯文本替代 provider 识别 |
| `providerAccountId` | 第三方官方 API 返回的不可变身份；禁止用 handle/name 代替主键 |
| `displayIdentity` | handle、用户名或 Page 名称的展示快照；可变化，不能作为归属或幂等键 |
| `state` | `connected`、`needs_reconnect`、`needs_attention` 或 `disconnected` |
| `capabilities` | 当前连接可执行的动作与明确不可用原因 |
| `metadata` | provider 特有元数据；例如 Pinterest Board、Facebook Page、token/version 信息 |

Settings 可以展示当前 owner 的完整连接生命周期；destinations 只能展示当前动作下可选的连接，但两者必须来自同一 canonical connection 查询与 capability 解析器。

### 3.2 Canonical capability

每个平台/连接至少解析以下能力：

| 能力 | 含义 |
|---|---|
| `selectable` | 是否能成为当前 Content 的 destination |
| `publishNow` | 是否能立即发布 |
| `schedule` | 是否能进入排期 |
| `requiresMedia` | 平台是否要求媒体，以及当前 Content 是否满足 |
| `requiresSubdestination` | 是否还需选择 Board、Page 等子目标 |
| `unavailableReason` | 不可选时的 canonical reason code 与用户文案 |

`unavailableReason` 至少覆盖：`not_connected`、`needs_reconnect`、`permission_missing`、`account_expired`、`media_required`、`subdestination_required`、`unsupported_provider`、`owner_mismatch`。reason code 在三个入口必须一致，展示文案可以按上下文补充操作提示。

禁止由 Settings、单卡或 Batch Edit 各自硬编码 provider 状态。三个入口必须消费同一 provider registry、connection DTO 和 capability 结果。未知 provider、owner 不匹配、非 connected、缺少权限、缺少媒体或缺少子目标时均 fail closed，并返回可解释原因，不能静默过滤后继续发布。

### 3.3 Destination 引用

保存到 Content/PinDraft/排期任务的 destination 至少包含：

| 字段 | 契约 |
|---|---|
| `provider` | canonical provider key |
| `connectionId` | authoritative connection 引用 |
| `providerAccountIdSnapshot` | 保存时的审计快照，不替代 connection 引用 |
| `subdestinationId` | Pinterest `boardId` 等；无子目标的平台为空 |
| `displayIdentitySnapshot` | 保存时的用户可见快照，用于历史和问题定位 |
| `capabilityVersion` | 保存时能力版本；执行前仍须重新校验实时能力 |

切换 Pinterest `connectionId` 时必须清空旧 `boardId`，并从新账号重新加载 Board。任何 Board 必须通过 owner、connection 和 provider 三重归属校验。

当 canonical resolver 返回 `0 publishable destinations` 时，单卡与 Batch Edit 都必须保留三 provider 的可解释 disabled 状态，禁用最终 Publish/Schedule 提交，不创建可执行 provider job。服务端即使先执行 usage consume/reserve，也必须在同一失败流程中只释放本流程拥有的 fresh consume，使用户可见净用量为 `0`。

## 4. Exact Provider Identity

当前测试数据的权威目标身份如下。UI 可以显示更多友好字段，但验收必须同时记录官方 ID；若 handle/name 与历史值不同，以同一 provider 官方 identity API 的最新读回为准，并登记变化，不能直接判为另一个账号。

| Provider | Official identity ID | 预期展示身份 | 发布目标 |
|---|---|---|---|
| Pinterest | `804455689597649673` | 历史 handle `vibepinvibepin`；验收记录实际 handle | 该 Pinterest 账号下用户明确选择的测试 Board |
| Instagram | `17841478940147145` | 历史 username `sensalab__`，name `Sensa`；验收记录实际值 | 该 Instagram professional account |
| Facebook | `965649823305245` | Page `vibepin.co` | 该 Facebook Page |

每个平台必须显示 shared registry 提供的正式品牌图标，并带有可访问名称。Batch Edit 不得退化为单独一行 `Pinterest` 文本；图标、display identity、账号/Page/Board、Connected/disabled 状态和原因必须与单卡一致。TikTok 图标、文本和入口均不可见。

身份规则：

1. OAuth callback 必须先用 provider 官方 API 解析 `providerAccountId`，再进行 owner-scoped upsert。
2. Reconnect 返回的官方 ID 与目标 connection 不一致时，必须停止并提示身份不匹配；不得覆盖另一连接。
3. display name/handle 变化只更新展示快照，不得创建重复连接或改变历史发布归属。
4. token、refresh token、authorization code、PKCE verifier、cookie 和密钥不得返回客户端、进入 DOM、analytics、错误文案或普通日志。

## 5. OAuth 与保存契约

### 5.1 状态机

OAuth 生命周期采用以下状态：

`not_connected -> authorizing -> callback_verifying -> connected`

失败或失效分支为 `authorization_failed`、`needs_reconnect`、`needs_attention`、`disconnected`。`connected` 只代表当前 token/scope/identity 通过最近一次服务端验证；UI 不得在 callback 保存完成前显示 Connected，也不得把 provider popup/redirect 成功等同于连接落库成功。

### 5.2 发起授权

1. 发起端生成一次性、短时有效、签名的 state，并绑定 owner、provider、return path、intent、nonce 和目标 connection（仅 reconnect 时）。
2. 支持的平台应使用 PKCE；callback 必须验证 state、nonce、owner session、provider 和 redirect allowlist。
3. OAuth scope 采用实现发布所需的最小权限；验收 receipt 记录平台返回的实际 scope，不请求与发布无关的额外权限。
4. 用户取消、拒绝授权或 state 过期时返回 Settings 的可恢复状态，不新增半连接，不覆盖旧 token。

### 5.3 Callback 保存

1. 服务端交换 token，调用官方 identity API，并验证账号/Page 对当前授权可用。
2. 在同一 owner + provider + providerAccountId 约束内进行幂等 upsert；重复 callback 不新增第二条连接。
3. 保存 token/version、scope、过期信息和 identity 后，才返回 `connected`。
4. 保存失败必须显示明确错误并保持原连接可恢复；不得出现 UI Connected 但刷新后消失。
5. Disconnect 只改变连接可用状态；Remove 必须执行引用检查。二者不是本轮只读 UI 验收或测试发布的允许动作。

### 5.4 Refresh、过期与断连

1. 页面刷新、modal 重开和重新登录后必须从服务端 canonical connection 重新取数，不能依赖内存中的 Connected 状态。
2. 可刷新 token 在服务端完成 refresh；刷新成功更新 token/version/expiry，但 `providerAccountId` 不变。
3. refresh 被拒、scope 被撤销或官方 identity 不再可用时，连接转为 `needs_reconnect` 或 `needs_attention`，三入口同步禁用 publish/schedule 并显示同一 reason。
4. 用户主动 Disconnect 后状态为 `disconnected`，历史 Content、排期快照和 publish result 仍可审计；不得级联删除历史 remote ID/permalink。
5. 到期或断连发生在排期执行前时，执行器必须在 provider dispatch 前失败并按 fresh consume 所有权释放用量；不得使用过期 token，也不得把任务标记为 published。
6. 到期或断连发生在 provider 已接收但本地结果未知后时，状态为 `delivery_unknown`；不得自动退款或自动重发，先查询 provider/job。

### 5.5 OAuth 后两轮 UI 门禁

每个平台授权后都必须完成两轮验收：

| 轮次 | 操作 | 必须结果 |
|---|---|---|
| Round 1 | callback 返回后进入 Settings，再进入单卡与 Batch Edit destinations | exact identity、Connected 和 capability 三处一致；TikTok 不出现 |
| Round 2 | 刷新页面，关闭再打开 modal；可用同一测试账号重新登录 Preview 后复查 | 连接仍存在，无重复卡片、无身份漂移；三处状态仍一致 |

## 6. 三个 UI 入口的统一行为

### 6.1 Settings Social

- 显示 Pinterest、Instagram、Facebook 的官方 ID 对应展示身份与 canonical state。
- 显示与 destinations 相同的 shared registry 品牌图标和 accessible label。
- Connected 仅表示 callback 保存、identity 校验和可用权限均成功。
- `needs_reconnect`、`needs_attention`、`disconnected` 使用与 destinations 相同的 reason code。
- TikTok 不显示卡片、入口、占位、Connect、Reconnect、Disconnect 或 Remove。

### 6.2 单卡 destinations

- 显示当前 Content 可用的 Pinterest、Instagram、Facebook 连接与相同身份。
- 不可发布时保留平台上下文并展示明确原因，不将“不满足媒体要求”误报为“未连接”。
- Pinterest 必须明确选择属于当前 connection 的 Board。
- 关闭抽屉/弹窗不保存、不排期、不发布；保存必须是明确动作。

### 6.3 Batch Edit destinations

- Provider、identity、Connected 状态、能力和不可用原因与同一时刻的单卡完全一致。
- 多选卡片的相同 destination 使用 `all selected`、`none selected`、`mixed` 三态；不得把 mixed 静默解释为全部选择或全部清除。
- 用户只有在明确提交 Batch Edit 后才批量保存；打开、切换 tab、取消或关闭均无副作用。
- 批量保存逐卡校验 owner、connection、capability 和子目标。任一卡失败时给出逐卡结果，不得悄悄丢弃失败卡。
- 不得用仅含 `Pinterest` 的静态文本行代替真实 provider/account/Board/Page selector。

### 6.4 TikTok 隐藏与服务端保护

TikTok 可以保留在未来 provider registry 或迁移兼容层，但当前客户侧必须全部隐藏。以下入口均不得出现 TikTok：Settings Social、单卡 destinations、Batch Edit、排期摘要、发布确认、结果列表和 Pricing provider 展示。

服务端不得只依赖 UI 隐藏。陈旧草稿、旧客户端或手工 payload 传入 `tiktok` 时，保存、排期和发布接口必须返回稳定的 unsupported/capability 错误，并且不扣量、不创建 publish job、不发生外部请求。

### 6.5 Optional Scheduling 统一契约

发布时间是可选项，不是创建或发布 Content 的必填字段。单卡与 Batch Edit 必须共享以下模型：

| 字段 | 契约 |
|---|---|
| `publishMode` | `now` 或 `scheduled`；默认 `now` |
| `scheduledAt` | `publishMode=scheduled` 时必填的带时区时间；`now` 时必须为空 |
| `timezone` | 用户明确选择或 workspace 明确配置的 IANA timezone |
| `destinations` | 与立即发布完全相同的 canonical destination 引用 |
| `contentIntentId` | 同一 Content 的稳定 intent；立即发布与排期不得各自生成不兼容身份 |

用户只有点击明确的 `Schedule`/`Add publish time` 动作后才展开日期时间控件。未展开、取消或切回 Publish now 时，`scheduledAt` 必须为空，不能保留隐藏的旧时间。Batch Edit 中时间也使用 `all/none/mixed` 三态；mixed 不得静默覆盖所有卡片。

Publish now 与 scheduled execution 使用同一 capability、owner、connection、Board/Page、幂等、计量和逐 provider result 契约。排期保存时冻结目标快照，真正执行前重新验证 canonical connection/capability；验证失败不得 dispatch，并按第 8 节恢复。

### 6.6 发布前显式确认与禁止默认目标兜底

卡片菜单 `立即发布`、单卡编辑中的 Publish、Batch Edit 的 Publish/Schedule 都必须先进入同一确认组件。打开确认组件本身只能读取和展示事实，不得创建 provider request、publish job、usage consume、排期或草稿 mutation。

确认页必须在任何 provider POST 之前完整展示：

| 确认事实 | 必须展示的内容 |
|---|---|
| Content | title、可辨识的媒体缩略图/类型/数量；媒体不可用时显示明确错误，不得用正常缩略图占位 |
| Provider identity | Pinterest/Instagram/Facebook 的 provider 名称、官方 account/Page ID、display identity 与连接状态 |
| Subdestination | Pinterest exact Board ID/name；Facebook exact Page ID/name；Instagram exact publishing identity；不适用时明确标记 |
| 执行语义 | `Publish now` 或 `Schedule`；Schedule 时展示本地时间、IANA timezone 和可解析的绝对时间 |
| 不可发布目标 | provider、稳定 disabled-reason code、用户可读原因；不得静默过滤 |
| 动作 | 明确的 `Cancel` 与带目标数量/模式的确认按钮，例如 `立即发布到 3 个渠道` 或 `排期到 3 个渠道` |

发布确认使用用户在 canonical destination model 中明确保存或本次明确选择的 destinations。草稿没有 destination、旧 destination 已失效、Board/Page 缺失或 capability 结果为 0 时，确认按钮必须禁用并引导用户返回 Edit destinations；服务端也必须 fail closed。客户端和服务端都禁止选择第一个账号、默认 Pinterest、默认 Board/Page 或任何 registry 顺序兜底。

只有用户激活确认按钮后，才能冻结同一份 destination snapshot、创建 intent/job、执行一次 Content 用量 consume 并进入 provider dispatch。服务端只接受确认 receipt 中的 destination IDs；请求到达时如 canonical identity/capability 已变化，必须整体或逐腿 fail closed，不能改投其他目标。

`Cancel`、Escape、关闭 dialog、浏览器 Back 或失焦不得 dispatch、排期、扣量或修改 destinations。确认按钮必须防双击并绑定稳定 intent/idempotency key；提交后显示逐 destination 进度，未知结果进入第 8 节 recovery，禁止再次生成新 intent。

确认 dialog 必须满足键盘和可访问性契约：打开后焦点进入标题，焦点被限制在 dialog 内，Escape 等价于 Cancel，按钮具有可辨识 accessible name，provider 图标有 label，错误与状态变化通过适当 live region 宣告。所有文案走 i18n key；不得混用未翻译的 `Publish`、`Schedule`、provider error 或字符串拼接。桌面 `1440x900` 与移动 `390x844` 均必须完整显示 Content、destinations、模式和两个动作，且 `scrollWidth <= clientWidth`、无页面/dialog 内横向滚动。

## 7. 受控 Preview 测试发布动作边界

### 7.1 前置条件

测试发布只能在 exact test-bound Preview 上进行，并满足：

1. runtime、manifest、deployment、stable/unique URL 与测试数据库绑定已只读核验。
2. 三个 provider 的 official identity API 与 UI identity 一致。
3. 使用专门测试 Content，文案和媒体不含客户、密钥或 Production 数据。
4. 在打开确认页后、点击最终确认按钮前生成 action-boundary receipt，记录 provider、官方账号/Page ID、display identity、Content/draft ID、完整文案、媒体、Pinterest Board、Publish now/Schedule、预期远端副作用和计量预期。
5. 明确标记 `test environment`；本 PRD 本身不构成 OAuth 或发布授权。
6. 确认页展示值与 receipt、canonical API 和最终 dispatch payload 完全一致；任一事实未知或不一致时不得点击确认。

允许的受控副作用是：每个平台最多创建一个可识别的测试帖子，测试数据与远端测试帖子按验收要求保留。禁止付款、Production 写入、断开/删除账号、清理用户数据或修改环境。

### 7.2 单次提交与不重复重试

1. 一次 Content 可以同时选择 Pinterest、Instagram、Facebook，并只触发一次最终 Publish 动作。
2. 客户端生成稳定的 content intent；服务端对同一 intent/destination 保证幂等。
3. 网络超时、客户端失联、HTTP 5xx 或结果未知时，禁止用户、测试人员和自动 worker 直接再次点击 Publish。
4. 重试前必须先按 intent/job 查询已有逐 destination 结果、provider remote ID 和外部可见状态。
5. 已 `published` 的 destination 永不重发；只有明确 `failed` 且确认未产生远端对象的 destination 才可用同一 intent 进入受控恢复。
6. capability 解析后为 `0 publishable destinations` 时，返回明确的不可发布结果及逐 provider disabled reason；不得把空 fan-out 当成功。
7. 部分 destination 不可发布时，最终确认页必须明确列出“将发布”和“不会发布”的目标。未经用户明确确认，不得静默丢弃失败腿后继续发布其余平台。
8. 未选择 destination 时必须阻断并返回 Edit destinations；不得采用 Pinterest、第一条 connection、默认 Board/Page 或历史最后一次目标作为 fallback。
9. 用户 Cancel 或未完成最终确认时，provider POST、publish job、usage consume 和 schedule mutation 必须均为 `0`。

### 7.3 HTTP 与结果证据

每个关键请求必须记录经过脱敏的 method、path、HTTP status、时间、correlation/request ID 和响应结果类别。不得记录 Authorization、cookie、OAuth code、token、签名 URL 查询密钥或用户秘密。

必须覆盖以下请求类型：

| 请求类型 | 预期证据 |
|---|---|
| Canonical connections/capabilities | 200 JSON；三入口使用同一连接与能力事实 |
| Pinterest Board 列表 | 200 JSON；Board 归属于已选 `connectionId` |
| Publish intent/job 创建 | 单次 accepted 或明确的幂等 replay；记录 job/intent ID |
| Provider dispatch/result | 每个 destination 独立状态；成功有真实 remote ID，支持时有 permalink |
| Usage 查询 | 发布前后同一账号、同一计量周期的 scheduled-post 净变化 |
| Failure recovery | 明确区分 pre-dispatch、provider rejected、delivery unknown 和 replay |

HTTP 2xx 只说明该请求被处理，不能单独证明远端发布成功。PASS 必须同时有 provider 确认后的 remote ID；平台支持 permalink 时还需 permalink 可解析到相同官方目标。无 remote ID 时 UI 不得生成假的成功链接。

### 7.4 逐 destination 状态

UI 与 API 至少区分 `requested`、`accepted`、`publishing`、`published`、`failed`、`delivery_unknown`。多渠道任务可以部分成功；总状态不得把一个平台成功包装成三个平台全部成功。

每个结果至少保留：provider、connectionId、providerAccountId snapshot、subdestination、intent/job ID、attempt、started/finished time、HTTP/result category、remote ID、permalink、error code、是否允许重试。

### 7.5 失败与成功状态的 canonical precedence

失败列表、卡片 badge 和详情抽屉必须消费同一份 canonical lifecycle/result reducer，不得分别根据“最近一次尝试”“任一成功腿”或本地缓存自行推导。对一个 Content/draft 的多 destination fan-out，状态优先级固定为：

1. `delivery_unknown`：任一已 dispatch destination 的最终投递未知时，卡片不得显示可误解为完成的 `Posted`；必须显示“结果未知/正在核对”，锁住盲目 Retry，并保留原 intent/job。
2. `failed`：不存在未知腿且至少一条已确认失败、仍可恢复的 destination 时，卡片主状态为 `Publish failed`。即使另一条 destination 已 `published`，也不得用 `Posted` 覆盖失败事实；UI 可以附带“部分已发布”摘要，但失败腿必须显式可见。
3. `published`：仅当所有已确认目标均 `published`，且没有 `failed`、`delivery_unknown` 或未解决的 `requested/publishing` 状态时，才允许显示 `Posted`。
4. `cancelled`/`draft`/`scheduled` 等非投递终态继续按既有生命周期显示；历史成功结果不得清除当前失败或未知结果，历史 attempt 只进入诊断，不改变当前 badge。

状态 reducer 必须以同一 `contentIntentId`/draft ID 聚合结果，并在 Plan、Create Pins/Failed→Publish failures、单卡详情和 Batch 结果中保持相同 precedence。任何“卡体仍有 publish failure 但 badge=Posted”的组合均为 P0 状态一致性缺陷。

### 7.6 Retry 与 destination repair

Retry 只能针对同一 intent 中已确认 `failed` 且经查询确认没有远端对象的 destination；`published` 和 `delivery_unknown` destination 必须保护，不能重发。点击 Retry 前先读取 canonical destination snapshot 和当前 capability：

- 若存在可恢复的已保存目标，确认页列出 exact provider/account/Board/Page、失败原因及将重试的 destination；沿用原 Content intent/idempotency key，不创建新 Content 或重复计量。
- 若目标为空、已失效、owner 不匹配、Board/Page 缺失或当前 `publishable=0`，Retry 必须 fail closed，明确显示 `No saved publishing destination` 及逐 provider disabled reason，并提供 **Edit destinations / 修复发布目标** CTA。该 CTA 进入单卡或 Batch 的 canonical destination 编辑器，允许用户显式选择并保存目标；不得在 Retry 流程内自动选择 Pinterest、第一条 account、默认 Board/Page 或上次目标。
- 在用户保存至少一个当前可发布目标前，Retry CTA 保持 disabled，且不得创建 provider request、job、usage consume、schedule 或修改原失败记录。保存后必须重新生成待确认的 destination snapshot，并要求用户再次确认；不能把“修复目标”隐式视为 Retry/Publish。
- malformed、过期、被篡改或与当前 Content/media/destination 不一致的 retry receipt 一律拒绝并保持原状态；若内容或目标在确认后发生变化，原 receipt 失效，必须回到编辑/重新确认。

Repair 成功后，失败卡不得立即变成 `Posted`；在新的确认和 dispatch 之前仍显示 `Publish failed`，并保留已发布腿与失败腿的逐 destination 结果。修复 CTA、取消、Escape、关闭和浏览器 Back 均为零副作用边界。

### 7.7 Destination panel scroll ownership（FB-0905-32）

Studio 单卡展开 `Publishing accounts` 后，所有 destination 行、未填写项和底部动作必须仍可通过同一个明确的纵向滚动容器到达。当前实现审计到的结构是：`StudioBoard` body 与 `DraftDetailsDrawer` body 各自承担 `overflowY:auto`，`PublishDestinations` 以 inline 子树渲染；账号展开没有独立的高度/溢出契约，也没有把新展开内容滚入可视区的 focus/scroll 保障。这种组合可能把滚轮焦点留在错误容器，或让展开项被卡片/视口边界遮住。

Canonical 要求如下：

- 每个 surface（Studio card、单卡 drawer、Batch drawer）必须声明唯一 scroll owner；外层 page、modal body、destination panel 不得形成互相拦截滚轮的嵌套 `overflow:auto` 链。若 destination 列表需要独立滚动，必须有明确 `max-height`、可见 scrollbar、键盘滚动和屏幕阅读器名称；否则随 modal body 一起自然增长。
- 账号列表与 destination selector 默认 inline 渲染在其所属 modal/card 的语义 subtree 中，复用同一 canonical selector；不得复制一套 portal selector。若因 clipping 必须 portal，portal 必须带 `aria-controls`/`aria-expanded`、定位碰撞处理、滚动/resize 重定位和关闭时焦点恢复，且不能脱离当前 dialog 的 inert/focus scope。
- 展开或校验失败后，触发控件保持可见焦点；若目标在 scroll owner 可视区外，调用受限的 `scrollIntoView({block:"nearest"})`，不得滚动整个页面到顶部或锁死 body。Tab/Shift+Tab 必须按视觉顺序经过全部 provider、account、Board/Page、validation 和底部动作。
- modal 打开、嵌套 panel 展开、关闭、Escape、Backdrop/Back 返回后，body/app shell 的原始 `overflow`、`position`、`padding-right` 和滚动位置必须恢复；不得遗留 body lock 导致页面无法继续向下滚动。
- 桌面 `1280x720`、`1440x900` 与移动 `390x844` 均须验证：展开任一多账号 provider 后，未填 Board/Page 和底部 Publish/Schedule/Cancel 可达；destination 内容不被 header/footer 遮挡；指定 scroll owner 的 `scrollHeight > clientHeight` 时可滚到底；无横向溢出；关闭后重新打开滚动位置和焦点符合约定。

该要求只约束容器、焦点和可达性，不改变 provider/account/capability 的 canonical 数据模型。

### 7.8 Destination dependency、失败 CTA 与结果展示（FB-0905-33/34/36/37）

单卡、Batch Edit、Retry、Publish confirmation 和 Schedule 必须消费同一 canonical `connection → account → subdestination` 依赖图。provider/account 变化会使其 Board/Page 立即失效并清空；任何缺失或失效节点都必须就地显示原因和修复入口，不能由 `defaultBoard`、sandbox demo board、第一条账号或 registry 顺序补齐。

- **0 destination**：确认页不应只显示沉重的阻断文案。保留明确的零副作用 disabled 状态，同时提供就地 `Edit destinations`，展开同一 selector 让用户选择 provider/account/Board/Page；保存后返回新的确认快照，不能把 CTA 变成隐式 Publish。
- **必填项可达**：Board/Page 等必填字段必须在首屏或同一 scroll owner 内紧邻错误提示和修复控件，不得藏在 `Details`、溢出菜单或不可达的折叠区。错误摘要应显示“缺哪个目标/为什么不可发布”，并将焦点送到第一个缺失字段。
- **Publish 与 Schedule**：`Publish failed` 是当前投递结果，不得继续显示或执行会把失败卡直接写成 Scheduled 的 Schedule primary。失败卡的主动作是 Retry/修复目标；Schedule 只能在内容与目标重新通过 preflight、用户明确选择时间并完成独立确认后出现。Publish now 为 secondary，不得复用旧 schedule 时间或 sandbox demo board。
- **Posted 展示**：已发布行必须显示实际 destination（provider、account、Board/Page）和 remote ID/permalink（若支持）；若只发布了部分腿，必须显示逐腿状态与失败/未知腿，不能用单一 `Posted` 隐去未完成目标。
- **Batch mixed-account**：Batch 的 provider/account/Board/Page 选择器只渲染一次 canonical 结构。多账号或 mixed 状态用短 identity（名称+末尾 ID）和折叠详情表达，避免重复长文案；`Publish to` 必须可逐 provider 展开选择账号及子目标，并显示 all/none/mixed 与 disabled reason。保存按每张卡生成 exact destination snapshot，不能把第一张卡或 Pinterest 作为批量默认。
- **Receipt 与 intent**：目标修复只更新待确认的 destination snapshot；原失败 Content intent、历史结果和 usage 不被覆盖。Retry/Publish/Reschedule 均须带 receipt、intent/job 关联，未经再次确认不得 dispatch 或扣量。

上述约束适用于桌面 `1280x720`/`1440x900` 与移动 `390x844` 两轮验收；每轮需证明 0 destination、缺 Board/Page、Publish failed、Posted、Batch mixed-account 五类状态均可理解、可达且无默认目标副作用。

## 8. 计量与恢复

### 8.1 计量单位

发布计量采用 Content 口径：同一个 Content 无论发布到一个还是多个渠道，只计 `1 scheduled post`。同一次 Content fan-out 到 Pinterest、Instagram、Facebook 的预期是三个远端帖子、scheduled-post 净用量 `+1`，而不是 `+3`。

额外 social account slot 是独立的 entitlement/付费维度，不能用发布 destination 数量替代，也不能改变 Content 计量单位。

### 8.2 幂等与扣量

- 计量幂等键必须稳定绑定 Content intent 与计量周期，而不是绑定 destination 数量。
- 同一 intent 的 replay 不得再次扣量。
- 服务端在首次实际 dispatch 前取得一次计量 consume 结果，并记录它是否为 fresh consume。
- 只有该流程拥有 fresh consume 时，才有资格执行对应 release/refund；replay 不能释放别的尝试产生的用量。
- `0 publishable destinations` 可以采用 charge-then-refund/release 的内部实现，但同一 intent 最终净用量必须为 `0`，且不得短暂向用户展示为已消耗。
- 部分成功只对 Content 计量一次；失败腿后续受控恢复沿用同一 Content intent，不产生第二次 scheduled-post 扣量。

### 8.3 失败分类

| 失败位置 | 远端副作用 | remote ID | 计量净结果 | 恢复规则 |
|---|---:|---:|---:|---|
| capability/pre-dispatch 校验失败 | 无 | 无 | `0` | 修正输入后可重新提交新动作 |
| `0 publishable destinations` | 无 | 无 | consume/reserve 若发生必须在同一流程 release，净 `0` | 返回逐 provider disabled reason，不创建 provider job |
| provider 明确 4xx rejected，确认未创建对象 | 无 | 无 | fresh consume 释放，净 `0` | 记录失败后允许受控重试 |
| HTTP 5xx/timeout/连接中断，投递未知 | 未知 | 未知 | 不自动释放 | 先查询 job/provider，不盲目重试 |
| 部分 destination 成功 | 有 | 成功腿有 | Content 总计保持 `+1` | 仅恢复已确认失败且无远端对象的腿 |
| 幂等 replay | 不新增 | 返回原结果 | 不新增、不释放 | 返回原 job/结果 |

## 9. 两轮用户端验收要求

每轮都使用同一 exact deployment，并分别完成桌面 `1440x900` 和移动 `390x844`。每轮记录起止登录态、完整点击路径、可见结果、console error、关键 HTTP 状态和是否产生副作用。

### 9.1 Settings Social

1. 路径：登录 Preview -> Settings -> Social。
2. Pinterest `804455689597649673` 显示实际 handle 并为 Connected。
3. Instagram `17841478940147145` 显示实际 username/name 并为 Connected。
4. Facebook Page `965649823305245` 显示 `vibepin.co` 并为 Connected。
5. 三个平台显示正确的 shared registry 品牌图标与 accessible label；TikTok 完全不出现。
6. Connected、needs reconnect 和 disabled reason 与 destinations 的 canonical 结果一致。
7. 桌面 rail 保持既有布局；移动端 modal、content、card、provider header、account row、chip 和 actions 均满足 `scrollWidth <= clientWidth`，无页面或 modal 内横向滚动条。
8. 全程不点击 Connect、Reconnect、Disconnect、Remove 或 OAuth。

### 9.2 单卡与 Batch Edit destinations

1. 路径：Studio/Create Pins -> 打开一张现有测试卡 -> Edit destinations。
2. 记录三个 provider 的图标、identity、Connected、selectable、不可用原因和 Pinterest Board/Page。
3. 关闭单卡，不保存，验证无 draft mutation、排期、发布或计量副作用。
4. 选中两张以上测试卡 -> Batch Edit -> destinations。
5. 验证平台、identity、状态、能力和原因与单卡一致，并验证 all/none/mixed 三态。
6. 取消/关闭 Batch Edit，验证无保存、排期、发布或计量副作用。
7. 桌面和 390px 均无横向溢出；TikTok 不出现。
8. 验证发布时间默认不展开且不必填；选择 Schedule 后才要求带时区时间，取消后隐藏值被清空。
9. Batch Edit 不得只有 Pinterest 文本；与单卡相同的 provider/account/Board/Page 选择器和 disabled reason 均可见。

### 9.3 OAuth 后 Round 1/2

OAuth 验收与上述只读 UI 验收分开执行。每个平台经用户亲自完成 OAuth/权限确认后，在同一轮继续验证 callback 保存；随后执行刷新、modal 重开和重新登录复查。不得索要、回显或保存用户密码、OTP、API key 或 token。

### 9.4 受控发布

用户端 UI 两轮通过后，另启一组受控测试发布。每轮先从卡片菜单、单卡与 Batch 中至少各打开一次相同确认页，核对 Content title/media、exact provider/account/Board/Page、Publish now/Schedule、disabled reason、Cancel 与确认按钮。先执行一次 Cancel 并证明零 job、零 provider POST、零 usage；再由已取得动作授权的用户对冻结 receipt 中的 destinations 激活一次最终确认。

Pinterest、Instagram、Facebook 各只执行一次目标发布；可以同一 Content fan-out 一次完成。每个平台必须核对 exact target、脱敏 HTTP、request/correlation ID、job/intent、逐腿状态、remote ID/permalink、console 和 Content 计量。任何结果未知时立即锁住重复提交，保留原 intent 并按第 8 节查询恢复，不重复点击、不创建新 intent。

## 10. 验收矩阵

| Case ID | 台账 | 场景 | 操作与证据 | 通过标准 | 优先级 |
|---|---|---|---|---|---|
| MC-A01 | CP-01, MC-02 | 三入口 canonical connection | 同时采集 Settings、单卡、Batch 的 provider/connection/capability | 三入口 exact connection、状态、能力、reason 一致 | P0 |
| MC-A02 | MC-01 | Pinterest exact identity | OAuth 官方 identity + callback 保存 + UI Round 1/2 | ID `804455689597649673`，实际 handle 一致且刷新后保留 | P0 |
| MC-A03 | MC-01 | Instagram exact identity | OAuth 官方 identity + callback 保存 + UI Round 1/2 | ID `17841478940147145`，实际 username/name 一致且刷新后保留 | P0 |
| MC-A04 | MC-01 | Facebook exact Page | OAuth 官方 identity + callback 保存 + UI Round 1/2 | Page ID `965649823305245` / `vibepin.co` 一致且刷新后保留 | P0 |
| MC-A05 | MC-01 | OAuth 重复 callback | 在安全测试中重放同一 callback/intention 结果 | 不新增重复连接，不覆盖其他身份，不泄露 token | P0 |
| MC-A06 | MC-01 | Reconnect 身份不匹配 | 目标 connection 与官方返回 ID 不同 | fail closed；原连接不被覆盖 | P0 |
| MC-A07 | MC-02 | TikTok 客户侧隐藏 | 检查 Settings、单卡、Batch、确认与结果 UI | 所有客户侧入口均无 TikTok | P0 |
| MC-A08 | MC-02 | TikTok 服务端保护 | 使用受控陈旧 payload 只验证拒绝契约 | 稳定 4xx/capability 错误；无 job、外部请求和扣量 | P0 |
| MC-A09 | CP-01, MC-02 | Batch mixed 三态 | 选择 destinations 不同的多张卡 | all/none/mixed 正确；无静默覆盖 | P0 |
| MC-A10 | CP-01 | 打开/关闭无副作用 | 单卡与 Batch 分别打开后取消 | draft、schedule、publish job、usage 均不变 | P0 |
| MC-A11 | MC-02 | Pinterest account/Board 绑定 | 切换账号并读取 Board | 旧 Board 被清空；只可选新 connection 所属 Board | P0 |
| MC-A12 | MC-02 | 桌面两轮 UI | 1440x900 完成 Settings、单卡、Batch | rail 不回归；三 provider 一致；console 无关键 error | P0 |
| MC-A13 | MC-02 | 390px 两轮 UI | 390x844 完成 Settings、单卡、Batch | 指定容器 `scrollWidth <= clientWidth`，可操作且无横溢 | P0 |
| MC-A14 | MC-03 | 最终动作边界 | 发布前冻结 exact receipt | runtime、环境、账号/Page、Content、媒体、目标、副作用齐全 | P0 |
| MC-A15 | MC-03 | 三 provider 单次 fan-out | 同一测试 Content 最终 Publish 一次 | 三 destination 各最多一个远端对象；无重复请求 | P0 |
| MC-A16 | MC-03 | Remote result | 核对 UI/API/provider 结果 | 每个成功腿有真实 remote ID；支持时 permalink 指向 exact identity | P0 |
| MC-A17 | MC-03 | Content 计量 | 比较发布前后 usage | 三 provider 同一 Content 净用量仅 `+1` | P0 |
| MC-A18 | MC-03 | Pre-dispatch 失败恢复 | 构造安全、不会触发 provider 请求的能力失败 | 无 remote ID，fresh consume 释放，净用量 `0`，Content 可编辑 | P0 |
| MC-A19 | MC-03 | Partial success | 一个腿成功、一个腿确认失败的受控条件或正式测试 fixture | 成功腿不重发；仅失败腿可恢复；总用量仍 `+1` | P0 |
| MC-A20 | MC-03 | Delivery unknown | 模拟/观察 timeout 或未知结果，不再次发布 | 状态为 unknown，先查 job/provider，不自动退款、不盲重试 | P0 |
| MC-A21 | MC-03 | Idempotent replay | 对同一 intent 查询或受控 replay | 返回原 job/结果，无新远端对象、无新增或错误释放用量 | P0 |
| MC-A22 | MC-01, MC-02 | Owner 隔离 | 使用另一 owner 的 connectionId/boardId 进行只读安全契约测试 | 404/403 fail closed，不暴露身份、能力或 token | P0 |
| MC-A23 | MC-01 | OAuth 隐私 | 检查 callback、client payload、DOM、console 与脱敏日志 | 不出现 token、code、PKCE verifier、cookie、密钥 | P0 |
| MC-A24 | CP-01, MC-02 | Schedule 目标快照 | 保存排期后重开并在执行前复核 | 原 connection/Board 快照保留；执行前实时 capability 再校验 | P0 |
| MC-A25 | CP-01, MC-02 | Provider 图标与可访问性 | 对比 Settings、单卡、Batch 的 registry output | Pinterest/Instagram/Facebook 图标和 label 一致；Batch 非纯 Pinterest 文本 | P0 |
| MC-A26 | MC-01 | Refresh/过期/断连 | 刷新、重登与受控 token-state fixture | 状态持久；过期/撤权转 needs reconnect；断连不删除历史结果 | P0 |
| MC-A27 | CP-01, MC-02 | Optional scheduling | 单卡与 Batch 检查 now/scheduled/all-none-mixed | 时间默认非必填；仅明确 Schedule 后必填；取消清空隐藏值 | P0 |
| MC-A28 | MC-03 | 0 publishable + charge/refund | 构造三 provider 全不可发布的安全输入并比对 usage | 逐 provider 原因可见；无 provider job/remote ID；净用量 `0` | P0 |
| MC-A29 | CP-01, MC-02 | Disabled-reason parity | 对同一缺媒体/断连/缺 Board 条件采集三入口 | canonical reason code 一致，无静默过滤 | P0 |
| MC-A30 | CP-01, MC-03 | Cross-PRD traceability | 检查 Create Pin v1.0 与 Multichannel v1.1 anchors | `CP-REQ-*` 与 `MC-REQ-*` 双向可解析且语义无冲突 | P0 |
| MC-A31 | CP-01, MC-03 | 卡片菜单发布前确认 | 从 `立即发布` 打开确认页，不点击最终确认 | 展示 Content title/media、exact provider/account/Board/Page、now/schedule 与 Cancel；无 provider POST/job/usage | P0 |
| MC-A32 | CP-01, MC-03 | Cancel 零副作用 | 分别使用 Cancel、Escape、关闭 dialog 与浏览器 Back | destinations/draft/schedule 不变；provider POST、job、usage 均为 0 | P0 |
| MC-A33 | CP-01, MC-02 | 禁止默认 destination fallback | 对无 destination、失效 Board/Page 和 0 publishable 草稿打开发布入口 | 确认被阻断并引导 Edit destinations；不得选默认 Pinterest/账号/Board/Page | P0 |
| MC-A34 | CP-01, MC-03 | 确认页键盘/a11y/i18n/响应式 | 桌面 1440x900 与 390x844 各两轮进行 Tab/Shift+Tab/Escape、screen-reader name 与语言切换检查 | focus trap/restore、accessible name/live region/i18n 正确；完整事实和动作可见，无横溢 | P0 |
| MC-A35 | MC-03 | 确认到结果的可审计链 | 对用户确认的一次 fan-out 关联 confirmation receipt、HTTP、job、destination results、remote ID/permalink、usage 与 recovery | 仅确认目标 dispatch；同一 intent 全链可关联；未知结果锁重提并先查询恢复 | P0 |
| MC-A36 | CP-01, MC-03 | Result precedence 防止假 Posted | 构造一条 Content 同时含 published 与 failed/unknown destination 的结果，并在 Failed→Publish failures、卡体、详情和 Plan 读取 | failed/unknown 优先于 Posted；显示“部分已发布/结果未知”及逐腿事实；仅全目标 published 才显示 Posted | P0 |
| MC-A37 | CP-01, MC-03 | Retry 无目标进入修复 | 对无保存目标、失效 Board/Page、owner mismatch 与 0 publishable 草稿点击 Retry | 显示 `No saved publishing destination`、逐 provider disabled reason 和 Edit destinations CTA；Retry disabled；无 request/job/usage/状态伪成功 | P0 |
| MC-A38 | CP-01, MC-03 | Retry 修复后重新确认 | 在 canonical editor 显式保存新目标后返回 Retry | 生成新的目标快照并再次展示确认；原 intent/content 计量身份保持；未确认前无 dispatch；成功后仅恢复失败腿 | P0 |
| MC-A39 | CP-01, MC-03 | Retry receipt 与取消 fail closed | 使用 malformed/tampered/stale receipt，及内容/目标确认后变更；执行 Cancel、Escape、关闭、Back | receipt 被拒绝并保留原结果；任何取消路径零 provider POST/job/usage/destination mutation；published/unknown 腿不重发 | P0 |
| MC-A40 | CP-01, MC-02 | Destination scroll ownership | 在 Studio 单卡展开 Publishing accounts，并在单卡/Batch drawer 重复展开 | 唯一 scroll owner；所有账号、Board/Page、未填项和底部动作可达；无滚轮拦截、遮挡或横溢 | P0 |
| MC-A41 | CP-01, MC-02 | Focus/scrollIntoView 顺序 | 键盘 Tab/Shift+Tab 展开账号、触发缺失字段校验并关闭 | 焦点留在触发控件或首个错误；仅 nearest 容器滚动；焦点顺序与视觉顺序一致；关闭后恢复原焦点 | P0 |
| MC-A42 | CP-01, MC-02 | Modal body-lock cleanup | 打开/关闭 drawer、Backdrop、Escape、浏览器 Back 后检查 app shell/body 样式与滚动位置 | `overflow`/`position`/padding/scrollTop 全部恢复；再次打开可继续向下滚；桌面与 390px 均无内部不可达区域 | P0 |
| MC-A43 | CP-01, MC-03 | 0 destination 就地修复 | 从无保存目标的确认/Retry 状态点击 Edit destinations | 同一 canonical selector 就地展开；可选择 provider/account/Board/Page；保存后重新确认；无默认目标、无 dispatch/job/usage | P0 |
| MC-A44 | CP-01, MC-02 | Required target 可达 | 构造缺 Board、缺 Facebook Page、失效 account/Board/Page 的单卡与 Batch 状态 | 首屏或同一 scroll owner 内显示具体缺项、disabled reason 和修复控件；焦点到首个错误；不藏在 Details | P0 |
| MC-A45 | CP-01, MC-03 | Publish failed 不得伪排期 | 对 publish failed 卡检查 footer/overflow 并尝试 Schedule | 主动作是 Retry/修复；Schedule 不复用旧时间或 sandbox demo board；未重新通过 preflight+确认不得写 scheduled | P0 |
| MC-A46 | CP-01, MC-03 | Posted destination 完整展示 | 对全成功、部分成功和含 unknown 的结果行/卡体/详情读取 | 每腿 provider/account/Board/Page、状态、remote ID/permalink 可见；部分成功/unknown 不被单一 Posted 覆盖 | P0 |
| MC-A47 | CP-01, MC-02 | Batch mixed-account 选择 | 多张卡含不同账号/Board/Page 与 all/none/mixed 状态，打开 Publish to | 单一 canonical selector；账号可逐 provider 选择；短 identity 不重复长文案；每卡保存 exact snapshot；无第一卡/Pinterest 默认 | P0 |

## 11. Receipt 最小字段

每次用户端或发布验收必须输出独立 receipt，至少包含：

| 类别 | 字段 |
|---|---|
| 候选身份 | runtime、manifest commit/path/hash、deployment ID、stable/unique URL、目标环境、数据 project ref |
| 执行身份 | 执行者/模型、开始结束时间、Round、desktop/mobile viewport、起止登录态 |
| UI | 完整点击路径、可见 identity/status/capability、TikTok 结果、overflow 测量、console error |
| HTTP | 脱敏 method/path/status、request/correlation ID、结果类别；不得含秘密 |
| 发布边界 | provider、official target ID、display identity、Content/draft、完整文案、媒体、Board/Page、预期副作用 |
| 发布确认 | 确认页快照、now/schedule、timezone、明确选择的 destination IDs、disabled reasons、Cancel/Confirm 动作、确认时间 |
| 发布结果 | intent/job、attempt、逐 destination 状态、remote ID、permalink、时间、实际保留副作用 |
| 计量 | 发布前、发布后、周期、幂等键类别、fresh/replay/refund 判断、净变化 |
| 恢复 | 是否投递未知、是否允许重试、已执行的查询、成功腿保护结果 |
| 终态 | PASS/FAIL/BLOCKED/NOT TESTED、阻断点、未执行动作、tab/viewport 清理 |
| 文件完整性 | receipt absolute path、bytes、SHA-256 |

## 12. 裁决规则

- `PASS`：本 case 的产品结果与证据全部满足，且来自 exact 当前候选。
- `FAIL`：已执行到目标功能，产品结果明确违反契约。
- `BLOCKED`：登录、OAuth、provider、IAB、外部权限或环境使 case 未到达可裁决点；不得记为产品 FAIL。
- `NOT TESTED`：本轮未执行；不得用源码、历史输出或其他部署结果补成 PASS。
- OAuth/UI 两轮中任一轮缺失，`MC-01` 不得 PASS。
- 三 provider 任一身份未核对，或 remote ID/计量缺证据，受控发布不得 PASS。
- 超时/未知投递后发生无证据重复点击，整组发布验收 FAIL，并先调查是否产生重复远端对象。
- 任何未展示确认、静默/default destination fallback、Cancel 后出现 provider POST/job/usage，均为 P0 FAIL，且必须先关闭可能的外部副作用事故。
- `INCIDENT_CLOSED_NO_PUBLISH_DISPATCH_OBSERVED` 只能关闭 60db/2142/dpl_2v1 那一次点击的事故，不得作为 `MC-A31` 至 `MC-A35` 或发布功能 PASS 证据。

## 13. Release Gate

进入 Production 候选前必须满足：

1. `CP-01`、`MC-01`、`MC-02`、`MC-03` 对应的全部 P0 case 在同一 exact Preview 候选上通过。
2. 三入口共享 canonical connection/capability 的代码与运行时证据同时成立。
3. 三 provider exact identity、两轮 UI、TikTok 全隐藏、桌面与 390px 无横溢均有 receipt。
4. 受控发布的 remote ID/permalink、Content 计量 `+1`、失败净 `0` 与 no-blind-retry 有可审计证据。
5. 没有未裁决的 delivery unknown、重复远端对象、token 泄露或 owner 越权风险。
6. 由 Sol 对证据和方案做最终审查；Claude Opus 可用时再做独立审查。Opus 不可用只能记录 `NO VERDICT/BLOCKED`，不能冒充通过。
7. Production 发布、环境变更、migration、真实付款或正式账号发布必须另行取得明确动作授权；本 PRD 不提供该授权。
8. Create Pin v1.0 与本文 v1.1 的 requirement anchors 已双向链接，且第 14 节 P0 开放问题全部裁决并写回两份 PRD。
9. `MC-A31` 至 `MC-A47` 在同一最终 Preview 上通过，证明发布前确认、Cancel 零副作用、无默认目标兜底、可访问/响应式、结果优先级、Retry 目标修复、destination 依赖、失败/Posted 展示、Batch mixed-account 和全链回执均成立。

## 14. 开放问题

Create Pin source 依赖已解决：exact source path、commit 与 8 个 `CP-REQ-*` anchors 已核验；最终集成分支的双向 link check 仍由 `MC-A30/CP-A31` 管理，不再作为开放问题重复登记。

以下问题在 v1.0 中保留为显式决策项。标记 P0 的问题未决时，Production 必须阻断；不得由实现者或测试人员自行猜测。

| OQ ID | 问题 | 建议默认 | 决策 Owner | Release 影响 |
|---|---|---|---|---|
| MC-OQ-02 | Pinterest 受控测试发布使用哪个 exact Board ID/name？ | 由用户在 action boundary 从账号 `804455689597649673` 下明确选择并写入 receipt | Multichannel + 用户 | P0，未指定不得点击 Publish |
| MC-OQ-03 | Instagram/Facebook 当前 API 是否均返回稳定 permalink？ | remote ID 强制；provider 不支持 permalink 时记录 `unsupported_by_provider`，禁止伪造 | Multichannel | P0，需在验收前冻结平台能力 |
| MC-OQ-04 | Batch Edit 的 mixed schedule 被用户点击 Schedule 时，是统一覆盖还是仅填空值？ | 默认要求二次确认并统一覆盖所有选中卡；不得静默覆盖 | Create Pin | P0，交互未定不得上线 Batch scheduling |
| MC-OQ-05 | 三 provider token refresh 的提前窗口和 retry 次数是多少？ | 每个平台单独配置有界 refresh；一次失败转 needs reconnect，不在发布动作内循环刷新 | Auth/Multichannel | P0，需完成安全审查 |
| MC-OQ-06 | 部分 destination 不可发布时是否允许用户确认后继续其余平台？ | 默认允许，但必须列出跳过目标与原因并二次确认；0 publishable 必须阻断 | Product + Multichannel | P0，需与 Create Pin 文案一致 |
| MC-OQ-07 | 受控 Preview 测试帖子保留多久、由谁清理？ | 本轮按用户要求保留；任何后续删除需独立授权并保存 remote receipt | Multichannel + 用户 | P1，不阻断测试但禁止自动清理 |
| MC-OQ-08 | scheduled post 的 Content 计量日/周期边界按创建、计划时间还是实际 dispatch？ | 沿用计量服务 canonical 周期，UI 不自行推导；在正式验收前写明 receipt 口径 | Billing/Usage | P0，未裁决不得 Production |
