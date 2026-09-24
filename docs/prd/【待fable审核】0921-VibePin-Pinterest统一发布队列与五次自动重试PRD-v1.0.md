# VibePin Pinterest 统一发布队列与五次自动重试 PRD v1.0

> 文档状态：Draft for implementation  
> 产品范围：Pinterest 图片与视频发布  
> 创建日期：2026-09-21  
> 决策：每个发布目标总共最多尝试 5 次，包含首次发布和 4 次自动重试  
> 适用入口：Studio 立即发布、批量发布、定时发布  

## 1. Executive Summary

### Problem Statement

VibePin 当前的图片上传、视频上传、立即发布和定时发布由多套状态逻辑驱动。立即发布会让浏览器同步等待 Pinterest，批量发布又按内容串行处理；定时任务第一次明确失败后会清除排期并向客户展示失败，系统缺少持久化自动重试、结果核对和跨设备恢复能力。

本次事故还暴露了错误证据丢失、数据库迁移与运行时代码不同步、Studio 预览比例不代表真实媒体比例、发布 cron 配置漂移等问题。上述问题会造成页面长时间转圈、排期到时仍未发布、客户过早收到失败提示，以及在结果未知时重复发布的风险。

### Proposed Solution

建立 Pinterest 统一持久化发布队列：立即发布和定时发布都只创建后台发布任务，由服务端 worker 按 destination 执行图片或视频发布。对于确认未送达且可以安全重试的错误，系统总共最多尝试 5 次；前 4 次失败仅展示中性重试状态，第 5 次仍失败才置为最终失败并通知客户。

对于 Pinterest 可能已经创建 Pin、但本地未能保存结果的情况，系统必须先进入结果核对状态，确认未创建后才能重试，禁止盲目重复调用创建 Pin 接口。

### Success Criteria

- 100% 的 Studio 立即发布请求在 2 秒内返回持久化 `jobId`，不等待 Pinterest 完成媒体处理。
- 100% 的可安全重试失败按照统一的 5 次尝试策略执行；第 5 次以前不得产生客户可见的最终失败通知。
- 100% 的 `delivery_unknown` 任务先进入 reconciliation，不得在未确认投递结果时再次调用 Pinterest 创建 Pin。
- 同一 `publish_intent + destination` 在并发 worker、cron 重叠、进程重启场景下最多只产生一个已发布 Pin。
- 100% 的最终失败记录包含脱敏后的阶段、HTTP 状态、provider code、request ID 或明确的“provider 未提供”标记。
- 排期发布从原定时间到首次 worker claim 的 P95 延迟不超过 5 分钟；队列最老可执行任务超过 15 分钟时触发内部报警。
- 图片和视频上传任务不得因单个文件一直 pending 而阻止用户继续添加或处理其他文件。

## 2. User Experience & Functionality

### User Personas

- 内容运营者：在 Studio 中批量上传图片或视频，填写字段并立即发布或排期发布。
- 独立站卖家：需要把多个商品视频稳定发布到指定 Pinterest 账号和 Board，不希望人工盯守草稿。
- 客服与运营管理员：需要知道发布卡在哪个阶段、系统是否还会自动重试，以及是否需要客户处理授权或素材。
- 技术运维人员：需要监控 cron、队列积压、Pinterest 错误、未知投递和重复发布风险。

### User Stories

#### Story 1：立即发布进入后台队列

As a 内容运营者, I want to 点击立即发布后马上得到已提交反馈 so that 我可以离开页面或继续处理其他内容，而不必等待 Pinterest。

Acceptance Criteria:

- 点击立即发布后，前端在 2 秒内收到 `202 Accepted` 和 `jobId`。
- 页面显示“已加入发布队列，离开页面也会继续”。
- 浏览器关闭、刷新或换设备后，用户重新登录仍能看到相同任务状态。
- 重复点击同一个仍在处理的发布任务不得创建第二个 provider dispatch。

#### Story 2：排期到时可靠进入发布队列

As a 内容运营者, I want to 排期内容在到达时间后自动发布 so that 我不需要打开 Studio 或手动点击发布。

Acceptance Criteria:

- 到期扫描器只负责将内容原子地加入发布队列，不在扫描请求内等待 Pinterest。
- 原始 `scheduled_at` 在重试期间保留，用于展示原定发布时间和计算延迟。
- 排期任务进入重试时显示尝试次数和下一次重试时间，不显示最终失败。
- 内容成功发布或进入最终失败后，才结束该次排期生命周期。

#### Story 3：图片和视频自动重试

As a 内容运营者, I want to 临时发布故障由系统自动恢复 so that 我不必反复点击重试或重新建立草稿。

Acceptance Criteria:

- 每个 Pinterest destination 总共最多尝试 5 次，首次发布计为第 1 次。
- 默认重试时间为第 2 次 1 分钟后、第 3 次 5 分钟后、第 4 次 15 分钟后、第 5 次 60 分钟后，并加入 ±20% jitter。
- Pinterest 返回有效 `Retry-After` 时优先遵守该值。
- 第 1–4 次可重试失败只记录内部 attempt，不发送最终失败通知。
- 第 5 次仍明确失败后进入 `failed_final`，只发送一次客户失败通知。
- 任意一次重试成功后立即结束后续重试，并只发送一次成功通知。

#### Story 4：未知投递结果防止重复 Pin

As a 内容运营者, I want to 系统在发布结果不确定时先检查 Pinterest so that 同一份内容不会被重复发布。

Acceptance Criteria:

- 网络断开、超时、成功响应缺少 Pin ID、provider 已调用但 settlement 失败等场景进入 `delivery_unknown`。
- `delivery_unknown` 自动进入 `reconciling`，不得直接创建下一次发送 attempt。
- reconciliation 确认已创建时，任务恢复为 `published` 并保存远程 Pin ID/URL。
- reconciliation 确认未创建时，任务才可进入 `retry_wait`。
- reconciliation 仍无法判断时继续保持未知状态并触发内部报警，不向客户宣称发布失败。

#### Story 5：需要客户处理的错误可理解、可恢复

As a 内容运营者, I want to 授权、Board 或素材问题被准确说明 so that 我修复问题后可以继续原任务。

Acceptance Criteria:

- 授权失效、Board 不存在或无权限、必填字段不合法、素材明确不支持时进入 `blocked_user`。
- `blocked_user` 不消耗五次 provider 尝试，不展示为普通临时发布失败。
- UI 提供具体处理动作，例如重新连接 Pinterest、重新选择 Board 或更换素材。
- 问题修复后继续同一个发布 intent，并保留原排期和审计链路。

#### Story 6：上传不中断后续工作

As a 内容运营者, I want to 上传过程中继续添加图片或视频 so that 单个慢文件不会阻塞整批工作。

Acceptance Criteria:

- 图片和视频使用统一的可追加任务队列。
- 单个文件具有独立的排队、检查、上传、完成、失败、取消和重试状态。
- 默认视频上传并发为 3；图片上传并发值由压测确定，初始建议为 3。
- 每个请求必须有 `AbortController`、阶段超时和 slot 释放逻辑。
- 单个文件超时或失败不影响其他文件继续上传。
- 每个文件完成后立即建立或更新对应草稿，不等待整批文件全部完成。

#### Story 7：所有卡片保留发布字段和真实媒体信息

As a 内容运营者, I want to 在草稿、排期、重试中、失败和已发布卡片中查看完整字段 so that 我能核对实际发布内容和结果。

Acceptance Criteria:

- 所有生命周期的卡片都显示标题、描述、目标 URL、Board、Pinterest 账号和媒体类型。
- 已发布卡片可以只读，但不得隐藏标题、描述或目标链接。
- 卡片展示源媒体真实宽高比，不得用 CSS 裁切后的外观冒充真实发布比例。
- 发布中卡片显示当前阶段、尝试次数、最近更新时间和下一次动作。
- 已发布卡片显示 Pinterest Pin 链接；缺少历史结果时明确显示“历史发布明细不可用”。

### Unified User Flow

```text
上传图片/视频
  → 媒体检查与草稿创建
  → 用户选择 Pinterest 账号与 Board
  → 立即发布或设置排期
  → 创建持久化 publish intent
  → 按 destination 加入发布队列
  → worker 原子 claim
  → 预检查与素材准备
  → Pinterest 媒体上传/创建 Pin
  → published
     或 retry_wait → 下一次安全重试
     或 delivery_unknown → reconciling
     或 blocked_user → 用户修复后继续
     或 failed_final → 第五次失败后通知一次
```

### Customer-Facing Status Copy

- `queued`：等待发布。
- `preparing`：正在准备媒体。
- `sending`：正在发送到 Pinterest。
- `awaiting_provider`：等待 Pinterest 处理。
- `retry_wait`：Pinterest 暂时未完成，正在自动重试 · {attempt}/5。
- `reconciling`：正在确认 Pinterest 是否已创建，避免重复发布。
- `blocked_user`：需要处理后继续发布。
- `published`：发布成功。
- `failed_final`：五次尝试后仍未成功。

### Non-Goals

- 本期不改造 Instagram、TikTok 或其他社交平台的发布流程。
- 本期不建设通用跨平台工作流引擎。
- 本期不对视频做内容理解、字幕生成或 AI 文案生成。
- 本期不自动裁剪用户视频；只做明确、可审计的媒体兼容性标准化。
- 本期不承诺修复 Pinterest 自身服务故障，只保证安全重试、状态透明和不重复发布。
- 本期不删除历史发布实现，迁移期保留回滚开关。

## 3. AI System Requirements (If Applicable)

### Applicability

本功能不依赖生成式 AI。失败分类、重试决策和 reconciliation 必须由确定性规则驱动，不允许模型决定是否再次调用 Pinterest 创建 Pin。

### Tool Requirements

- Pinterest API：媒体注册、媒体状态查询、创建 Pin、远程结果核对。
- 服务端任务 worker：执行 destination 级 claim、heartbeat、retry 和 reconciliation。
- PostgreSQL/Supabase：持久化 intent、destination、attempt、lease、provider evidence 和通知去重状态。
- 媒体探测工具：读取容器、编码、像素格式、宽高、时长和文件大小。
- FFmpeg：仅在兼容性规则要求时进行可审计的标准化处理。
- 监控系统：cron heartbeat、队列积压、未知投递年龄、重试恢复率和重复发布检测。

### Evaluation Strategy

虽然不使用 AI，仍需建立确定性发布评估集：

- 固定图片样本：JPEG、PNG、WebP、透明背景、边界尺寸和超限文件。
- 固定视频样本：9:16、1:1、16:9、`yuv420p`、`yuvj420p/full-range`、边界时长和超限文件。
- Provider mock 场景：429、明确 4xx、5xx、连接断开、响应丢失、创建成功但 settlement 失败。
- 并发场景：两个 worker 同时 claim、cron 重叠、进程在 provider 成功后崩溃、lease 过期恢复。
- 每次发布版本上线前必须完成 mock 回归；Preview 验证不得使用生产客户数据。

## 4. Technical Specifications

### Architecture Overview

#### Target Components

- Studio Upload Queue：统一图片和视频上传任务状态。
- Publish Command API：校验请求并创建持久化 publish intent，返回 `jobId`。
- Schedule Enqueuer：扫描到期草稿并创建/激活 publish intent，不直接调用 Pinterest。
- Publish Worker：按 destination 原子 claim 并执行 provider 调用。
- Reconciliation Worker：处理 `delivery_unknown`，确认远程是否已创建。
- Status API/SSE：向 Studio 提供持久化任务状态。
- Notification Dispatcher：只在成功、最终失败或需要客户处理时通知，并保证幂等。
- Operations Monitor：监控 heartbeat、积压、stale lease、unknown 年龄和重复风险。

#### State Machine

```text
queued
  → claimed
  → preparing
  → sending
  → awaiting_provider
  → published

preparing/sending/awaiting_provider
  → retry_wait
  → queued

sending/awaiting_provider
  → delivery_unknown
  → reconciling
  → published
  → retry_wait（仅确认未创建后）
  → delivery_unknown（仍无法确认）

preparing
  → blocked_user

retry_wait + attempt_no = 5
  → failed_final
```

### Data Model

优先扩展现有 `publish_intents`、`publish_intent_destinations` 和 `provider_publish_attempts`，通过新增迁移完成，不建立无关联的影子任务表。

`publish_intent_destinations` 建议新增：

- `publish_state`
- `attempt_no`，约束范围 `0..5`
- `max_attempts`，本期固定为 `5`
- `next_attempt_at`
- `retry_class`
- `last_stage`
- `last_provider_status`
- `last_provider_code`
- `last_provider_message`
- `last_request_id`
- `last_media_id`
- `last_heartbeat_at`
- `claim_token`
- `claim_expires_at`
- `reconcile_required_at`
- `reconciled_at`
- `final_failure_at`
- `terminal_notified_at`

数据库约束与索引：

- 唯一约束：`(publish_intent_id, destination_key)`。
- 唯一约束：`(publish_intent_id, destination_key, attempt_no)` 对应 attempt ledger。
- Check constraint：`attempt_no BETWEEN 0 AND 5`。
- Claim 索引：`(publish_state, next_attempt_at)`。
- Reconciliation 索引：`(publish_state, reconcile_required_at)`。
- 每个 destination 只允许一个未过期 active claim。
- 已进入 `published` 的 destination 永久禁止再次 provider dispatch。

### API Contracts

#### POST `/api/publish/jobs`

Purpose：统一接收 Studio 立即发布和批量发布请求。

Request：

- `draftId`
- `destinationIds`
- `idempotencyKey`
- `mode: immediate | scheduled`

Response：

- `202 Accepted`
- `jobId`
- `status: queued | existing`
- `statusUrl`

Requirements：

- 服务端从会话派生用户，不接受客户端 `userId`。
- 同一用户、draft、destination 和 idempotency key 重复请求返回原任务。
- API 不等待 Pinterest provider 调用完成。

#### GET `/api/publish/jobs/{jobId}`

返回：

- intent 总状态。
- 每个 destination 的状态。
- `attemptNo/maxAttempts`。
- 当前阶段和最近更新时间。
- 下一次重试时间。
- 脱敏 provider evidence。
- 成功后的 remote Pin ID/URL。
- 客户需要执行的恢复动作。

#### POST `/api/publish/jobs/{jobId}/resume`

仅用于 `blocked_user` 问题修复后的继续执行，不允许绕过 `delivery_unknown` reconciliation。

### Retry Classification

#### Retryable

- 连接在确认未发送前失败。
- Pinterest 返回可安全重试的 429。
- Pinterest 返回临时 5xx 且能够确认未创建 Pin。
- 媒体处理返回明确的临时状态。
- worker 在 provider 调用前崩溃或 lease 过期。

#### Reconciliation Required

- 创建 Pin 请求已发送但响应丢失。
- Provider 返回成功状态但缺少远程 Pin ID。
- Provider 成功后数据库 settlement 失败。
- Worker 在 provider 调用后、结果持久化前崩溃。
- 旧 claim 过期但无法证明 provider 尚未接收请求。

#### Blocked User

- OAuth token 失效或权限不足。
- Board 不存在、不可写或不属于目标账号。
- 标题、描述、目标 URL 等必填字段不合法。
- 素材违反明确的格式、大小、时长或尺寸约束。

### Video-Specific Requirements

- 发布前保存真实媒体宽高、时长、容器、codec、pixel format 和文件 fingerprint。
- `yuvj420p/full-range` 等已知兼容风险必须标准化为 Pinterest 支持的 `yuv420p/TV-range`。
- 标准化不得改变用户选择的纵横比；禁止无提示裁剪。
- 媒体已经注册并获得 `mediaId` 后，后续安全恢复优先复用该 `mediaId`。
- Media polling 属于幂等 GET，可在 provider deadline 内安全重试。
- 在 Pinterest 未提供且未验证稳定 idempotency key 前，`POST /pins` 不得盲目重放。

### Image-Specific Requirements

- 图片发布接入与视频相同的 intent、destination、attempt 和通知模型。
- 图片上传请求必须有客户端和服务端超时。
- Provider 创建结果未知时同样进入 reconciliation，不得因为图片体积小就直接重发。
- 图片媒体 fingerprint 用于内部审计和重复风险判断，不作为跨用户内容封禁依据。

### Scheduler and Worker Requirements

- 到期扫描器不得在单个 HTTP 请求内等待完整 Pinterest 视频处理。
- Worker 通过数据库原子 RPC 或等价的 `FOR UPDATE SKIP LOCKED` 语义领取任务。
- Claim 使用 lease 和 heartbeat；lease 过期后必须根据最后阶段决定重试或 reconciliation。
- 初始并发建议：每个 Pinterest 账号同时最多 3 个视频、5 个图片；最终值由 Preview 压测确定。
- 全局并发和账号并发必须同时生效。
- 429 必须降低对应账号的发送速率，不影响其他账号。
- cron/client timeout 必须大于 route 的最大执行时间，或将任务改为短请求 enqueue 模式。

### Frontend Requirements

- 立即发布按钮不再绑定长时间 provider 请求。
- 页面从统一 job 状态派生 loading、retry、reconcile、blocked 和 terminal UI。
- 使用轮询或 SSE 获取后台进度；断线重连后从服务器恢复状态。
- 上传进度以每文件任务为单位，不使用会永久停在 `Uploading 0/1` 的单一全局状态。
- 已发布卡片保持字段可见但只读。
- 所有卡片按真实媒体比例展示，并额外显示检测到的尺寸。
- 批量发布展示每个 destination 的独立状态，不用一个失败覆盖整批结果。

### Integration Points

- Pinterest OAuth account connections。
- Pinterest Board selection and validation。
- Pinterest media registration、upload、poll 和 Pin creation API。
- Supabase Auth：服务端从 session 推导用户身份。
- Supabase/PostgreSQL：RLS、service-role worker、intent ledger、attempt ledger。
- VibePin Studio drafts、scheduled publishing、history 和 destination results。
- Vercel/外部 cron：只负责触发 enqueue/worker，不作为任务状态的唯一载体。

### Security & Privacy

- 发布 API 不接受客户端传入的 `userId`、Pinterest token 或任意 account ownership 声明。
- 所有 draft、intent、destination 和 account 必须校验属于当前用户。
- Pinterest access token 只在服务端读取，不写入日志、前端响应或 provider evidence。
- Provider message 进入数据库前必须脱敏并限制长度，禁止保存原始响应 body。
- RLS 阻止客户端直接修改 attempt、claim、remote ID、attempt count 和通知状态。
- Service-role worker 只能通过受控 RPC claim 和 settle 任务。
- 用户删除草稿或撤销排期时使用 CAS，已进入 provider in-flight 的任务不得被静默删除，必须完成 reconciliation。

### Observability

必须采集：

- 队列等待时间 P50/P95。
- 从原定排期到首次 claim、最终成功的延迟。
- 按图片/视频、阶段、HTTP 状态、attempt number 统计成功率。
- Retry recovery rate 和 fifth-attempt final failure rate。
- `delivery_unknown` 数量、最老年龄和 reconciliation 结果。
- Claim lease 过期和 stale recovery 数量。
- Cron heartbeat、运行时长、扫描数、入队数和错误数。
- Provider request ID、media ID 和 remote Pin ID 的覆盖率。
- 重复发布检测事件。
- 数据库迁移/RPC capability mismatch。
- 客户通知去重失败。

报警阈值：

- publish cron/worker heartbeat 超过 10 分钟。
- 最老可执行任务超过 15 分钟未 claim。
- `delivery_unknown` 超过 15 分钟未进入 reconciliation。
- 出现 settlement failure、重复 remote ID 或 schema mismatch。
- 同一账号连续 429 或 5xx 超过配置阈值。

### Test Requirements

- 第 1 次失败、第 2 次成功：不产生失败通知，最终成功。
- 前 4 次失败、第 5 次成功：客户从未看到最终失败。
- 5 次明确失败：只产生一次 `failed_final` 和一次客户通知。
- 数据库拒绝创建第 6 次 attempt。
- 图片和视频均覆盖相同重试规则。
- 429 遵守 `Retry-After`。
- Auth/Board/素材错误进入 `blocked_user`，不消耗五次 provider attempts。
- Provider 已创建但响应丢失：进入 reconciliation，不发生第二次创建。
- Provider 成功后进程在 settlement 前崩溃：恢复后确认成功。
- 两个 worker 并发 claim：只有一个获得执行权。
- Lease 过期但 provider 调用阶段未知：进入 reconciliation。
- 已发布 destination 永不再次 dispatch。
- 一个平台 destination 成功、另一个 retry/unknown 时保持独立状态。
- 重试期间保留原始排期。
- 浏览器关闭、刷新、换设备后任务继续且状态可恢复。
- 图片上传、视频上传过程中继续追加文件。
- 一个上传请求超时后释放并发 slot，其他文件继续。
- Studio 显示真实横竖比例、完整标题、描述、链接和 Board。
- Preview 缺少要求的迁移或 RPC 时，发布功能 fail closed 并产生内部报警。

## 5. Risks & Roadmap

### Phased Rollout

#### MVP / P0：发布可靠性止血

- 新增发布重试与 reconciliation 所需数据库迁移。
- 发布证据完整落库并在 cron 路径透传真实状态。
- 数据库层限制最多 5 次 attempts。
- 实现可安全重试的退避调度。
- 重试耗尽前抑制最终失败通知。
- 保留原始排期并展示下一次重试时间。
- 修复/验证 `publish-due` cron 安装与 timeout 配置。
- 增加 schema capability health check。

P0 上线门槛：

- 所有新增迁移在 Preview 完整应用。
- 自动重试、未知结果、防重复、通知去重测试全部通过。
- Preview 连续执行固定图片和视频发布语料，无重复 Pin。
- 保留关闭新 worker 并恢复旧流程的 feature flag。

#### v1.1 / P1：统一异步发布体验

- 立即发布和排期发布统一进入 Publish Command API。
- API 返回 `202 + jobId`。
- Studio 使用轮询或 SSE 展示 destination 级状态。
- 定时扫描与 provider worker 完全分离。
- 图片上传迁移到可追加并发队列。
- 所有生命周期卡片恢复完整字段和真实媒体比例。

#### v2.0 / P2：运营效率与自动恢复

- 自动化 reconciliation 扩展和长期 unknown 处置台。
- 账号级自适应限流。
- 发布成功率、阶段耗时、重试恢复率和积压运营看板。
- 重复 Pin 风险检测与人工核对工具。
- 根据实际指标调整并发、退避和告警阈值。

### Technical Risks

#### Risk 1：未知结果盲目重试造成重复 Pin

Mitigation：把 `delivery_unknown` 与普通 failed 分离；任何可能已触达 `POST /pins` 的请求必须先 reconciliation。

#### Risk 2：Pinterest 不提供足够的远程查询或稳定幂等能力

Mitigation：保存 request/media/remote evidence；无法确认时保持 unknown 并转人工处置，不能为了自动化而牺牲去重安全。

#### Risk 3：迁移与应用版本不同步

Mitigation：部署前执行 capability check；缺少 RPC、字段或约束时 fail closed，禁止静默 fallback 丢失证据。

#### Risk 4：重试风暴触发 Pinterest 限流

Mitigation：指数退避、jitter、`Retry-After`、账号级和全局并发限制。

#### Risk 5：旧数据缺少 destination evidence

Mitigation：旧记录显示明确的“历史发布明细不可用”；不得伪造阶段、错误码或成功链接。

#### Risk 6：视频标准化增加处理时间和存储成本

Mitigation：仅对不兼容媒体处理；以 fingerprint 复用标准化产物；记录原始与最终尺寸、codec 和转换原因。

#### Risk 7：排期时间和技术重试时间语义混淆

Mitigation：分别保存并展示 `scheduled_at`、`next_attempt_at` 和 `published_at`，不使用同一个字段承担三种含义。

#### Risk 8：通知重复或过早发送

Mitigation：使用 `terminal_notified_at` 和唯一 notification dedupe key；attempt 事件只进入内部 telemetry。

### Dependencies And Constraints

- Pinterest API 的媒体处理时间、限流和远程查询能力属于外部依赖。
- 数据层继续使用现有 Supabase/PostgreSQL 和 RLS 模型。
- Web 层继续使用现有 Next.js Studio。
- 具体 worker 托管方式和正式环境 cron provider 为 `TBD`，但必须满足持久化、并发 claim、heartbeat 和可观测性要求。
- 本期不得部署到正式环境，直到 Preview 数据库迁移、固定测试语料和重复发布保护全部验收通过。

### Final Release Gate

- 代码审查确认图片、视频、立即发布、排期发布均进入同一持久化规则。
- 数据库约束可以拒绝第 6 次 attempt 和并发重复 claim。
- `delivery_unknown` 测试证明不会触发盲目重发。
- 第 5 次以前没有客户最终失败通知。
- Preview 中能够关闭浏览器后继续发布，并在其他设备查看状态。
- 监控能够识别 cron 未运行、任务积压、unknown 超时和 schema mismatch。
- 回滚开关经过演练；关闭新发布 worker 后不会丢失或重复执行已领取任务。

### Open Implementation Decisions

- Worker 采用 Vercel route + 外部 cron、Supabase scheduled function，还是独立常驻 worker，需要在实施设计阶段根据运行时限制决定。
- Pinterest reconciliation 可使用的远程查询能力需要用当前授权账号进行只读 API 验证。
- 图片账号并发初始建议为 5、视频为 3，最终值必须通过 Preview 压测确定。
- 状态更新采用短轮询还是 SSE，需要结合 Vercel 运行环境与成本进行技术评审。

