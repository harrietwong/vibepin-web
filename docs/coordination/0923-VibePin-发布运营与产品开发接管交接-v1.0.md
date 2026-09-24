# VibePin 发布运营与产品开发接管交接 v1.0

> 更新时间：2026-09-23（America/New_York）  
> 交接范围：VibePin Studio、AI Copy、Pinterest/Instagram/YouTube 发布、排期运营、Preview、后续产品优化  
> 环境边界：只允许 Preview / Test Supabase；Production 未授权、未部署、未改库

## 0. 接管结论

当前系统不是一个已经闭环的“三平台自动发布器”，而是三条成熟度不同的链路：

1. Pinterest：已经接入 VibePin 的草稿、排期、VPS cron、私有视频存储和 durable publish intent，正在真实运行 Preview 排期。
2. Instagram：VibePin API 已能发布 Reels，已实测 5 条；但没有把整批内容稳定接入每日排期。
3. YouTube：仍由本机独立 Python/OAuth 发布器上传和排期；VibePin 只展示 `externalPublishingPlans`，不会原生调用 YouTube。

当前产品代码里已经有批量视频上传、视频封面、卡片 AI 文案入口、AI Copy v2、Pinterest 视频发布、Instagram Reels、真实比例展示、发布字段恢复、外部渠道计划显示等功能；但是统一后台队列、五次自动重试、自动 reconciliation、YouTube 原生接入和完整三平台排期仍未完成。

## 1. 需要立即处理的风险

### 1.1 已停止商品仍有 YouTube 未来排期

- 用户已经停止 Crawling Christmas / Grinch 商品，不再继续发布；已经发布的内容不用删除。
- Pinterest 的 21 条 Grinch 草稿已取消排期。
- YouTube 当时只有 `youtube.upload` 权限，无法通过 API 修改或删除已经排期的视频。
- 截至 2026-09-23 10:37 UTC，回执中仍有 10 条 Grinch 视频的未来 `publishAt`，下一条为 `2026-09-23T11:30:00Z`。
- 权威回执：[cheerish-crawling-christmas-20260922-youtube-receipt.json](file:///D:/代码/youtube/youtube%20underground%20architect%20workflow/cheerish-crawling-christmas-20260922-youtube-receipt.json)
- 接管者应先确认远端实际状态；如仍为 scheduled，需使用包含 `youtube.force-ssl` 的 OAuth token 或 YouTube Studio 取消。不要删除已经 public 的旧视频。

### 1.2 Stable Preview 当前被 Vercel SSO 拦截

- 最后一次有完整回执的产品部署为 commit `b3661877f0ca1d343b5eea1b18b81059e3115931`。
- 当时 stable alias 已指向该部署并通过 `/api/version` 校验。
- 2026-09-23 重新只读访问 `https://vibepin-fb-preview.vercel.app/api/version`，返回的是 Vercel SSO 登录 HTML，不是 VibePin JSON。
- 接管者不能把当前 stable alias 宣称为可供用户直接验收，必须先修复 Deployment Protection / alias，再重新核对 build SHA。
- 部署回执：[THREE_PLATFORM_PLAN_PREVIEW_DEPLOYMENT_B3661877_20260922.md](file:///D:/vp-tmp/coordination/receipts/THREE_PLATFORM_PLAN_PREVIEW_DEPLOYMENT_B3661877_20260922.md)

### 1.3 “每天 10 条、三平台同排”尚未应用

- 用户确认过的目标是：从 2026-09-23 起，America/New_York 每天 10 条，时间为 `06:00、07:30、09:00、10:30、12:00、13:30、15:00、16:30、18:00、19:30`。
- 对应队列 rank 6–55，共 50 条，覆盖 2026-09-23 至 2026-09-27。
- 脚本 dry-run 已通过，Pinterest 和 Instagram 连接均有效。
- 但 `youtube-daily-ten-receipt.json` 不存在，dry-run 输出 `youtubeReceiptRows: 0`，因此没有执行 `--apply`。
- 也没有建立 50 条 Instagram clone 草稿，dry-run 输出 `existingInstagramClones: 0`。
- 不得把该方案描述为已经生效。

## 2. 用户长期需求与产品方向

### 2.1 获客与定位

- 用户参考 TikTok 上教授 Pinterest 副业的博主。博主的优势不是工具深度，而是通过 TikTok 教育大量不了解 Pinterest 的副业人群。
- VibePin 的营销可参考这种“教程 + 简单可见结果”的打法，但产品需要比单纯 Prompt 生成标题/描述更可靠。
- 差异化重点：事实有依据、关键词来源诚实、结果可校验、可以直接进入批量制作和发布流程。

### 2.2 Trends 与 Pin Ideas

- 用户不希望继续维护一个覆盖所有类目的高收藏图片推荐系统，人工标注成本过高。
- 更偏好的方向是浏览器插件：用户在 Pinterest 里自己采集想参考的图片，再进入 VibePin 批量生图。
- Trends 不需要独立入口；如果未来能稳定同步官方 Pinterest Trends，可把趋势证据直接接入 AI 文案。
- 当前代码保留 Trends / Discover 路由，只能通过 `NEXT_PUBLIC_HIDE_LEGACY_DISCOVERY=true` 隐藏导航，不删除页面。
- 官方 Trends 数据同步、浏览器插件都未实现。

### 2.3 AI 文案

- 每次只返回一个最佳版本，不固定三个版本。
- 事实来源必须区分用户输入、商品、页面、图片观察、Board 和 AI 推断。
- 材质、价格、库存、品牌、数量、功效等商业声明必须有 verified/asserted 证据。
- `trend_keywords` 才能被当作需求信号；产品标题、图片、Board 只是相关性证据，不能伪装成搜索量。
- 没有可靠关键词时进入 `no_keyword_demand_data`，仍可按商品和图片事实生成。
- 用户希望未来可以比较两种文案：博主 Prompt 方案与 VibePin grounded SEO 方案，并对比实际流量。该双模式 A/B 功能尚未实现。

### 2.4 Amazon / 商品链接

- 用户希望粘贴 Amazon 或独立站商品链接后自动获得标题、卖点、图片、价格、评分和 Pinterest 发布字段。
- 目前没有已接入的 Amazon Product Advertising API，也没有接入店小秘、妙手或其他 ERP 的采集 API。
- 现有 URL/import 能力不能宣称可稳定采集 Amazon 详情页与评论。
- 安全的 P0 是：读取允许访问的页面标题/OG metadata，再生成字段；评论、评分、价格必须来自合规 API 或商家明确提供的数据。

### 2.5 Studio 与发布体验

- 支持批量视频上传，上传时仍可继续添加下一个文件。
- 视频卡只在主视频预览上显示封面入口，封面选择要持久化并用于 AI 与发布。
- 每张卡只有一个 AI 文案入口，靠近标题字段。
- Draft、Scheduled、Retrying、Failed、Posted 都应展示标题、描述、URL、Board、账号和真实媒体比例。
- 发布失败不应第一次就通知客户最终失败；明确可重试的错误总共尝试 5 次，未知投递先 reconciliation。
- Draft/History 事实源必须是数据库，设备本地仅作缓存；换设备后同一账号应能看到。

## 3. 账号、环境和身份边界

### 3.1 Preview / Test

- Test Supabase ref：`snulmwprsahzqvdbyenc`
- Production Supabase ref：`jaxteelkecvlozdrdoog`，禁止触碰
- VibePin 运营测试账号：`cheerish-multi-20260918135659@vibepin.test`
- VibePin user id：`4cf569cd-1f20-404d-93d7-1e2c0b8a7251`
- 通用 `e2e-purchase-intent@vibepin.test` 不是视频运营账号，不得用于该批次发布。

### 3.2 平台目标

- Pinterest：`@cheerishh`
- Pinterest connection id：`a273f91c-4589-4fce-b19c-e24f2bdf6c99`
- 同一测试账号还连接过 `vibepin` Pinterest 账号；发布前必须按 connection id + username 双重核对，不能只按当前登录态猜测。
- Instagram：`@cheerish.coo`（旧界面曾显示 `@sensalab__`）
- Instagram connection id：`985e9d66-2f54-4eea-8e95-4b6c17d6c8f1`
- Instagram provider account id：`17841478940147145`
- YouTube：`CheerishHome` / `@cheerishhome`
- YouTube channel id：`UCHsRBl-62BorMJ3iSB9ZSMw`

## 4. 以前怎样排期

### 4.1 内容准备规则

1. 读取 WinningHunter/铺货队列，确认 Shopify 商品为 ACTIVE、视频本地文件存在、Cheerish 公开商品 URL 有效。
2. 按 SHA-256 内容去重，再按商品去重；标题与 URL 错配、同内容多商品歧义、品牌/水印未确认的内容阻断。
3. Pinterest 文案使用 title、description、destination URL、账号和 Board。
4. Instagram Caption 不放链接。
5. YouTube Shorts 描述保留完整 Cheerish 商品 URL。
6. 不写未实时确认的折扣、销量、配送、库存、材质或功效。
7. 视频标准化为 1080×1920，前景 contain、不裁掉主体，背景模糊填充；H.264 High、`yuv420p` TV range、AAC-LC、48kHz stereo、faststart，私有存储安全上限按 45 MB 控制。

权威内容队列：[winninghunter-three-platform-priority-queue.json](file:///D:/代码/社媒/视频+产品链接%20交付文件夹/2026-09-21_winninghunter-outwardsk-christmas-krejova-filamniceent/agent-output/winninghunter-three-platform-priority-queue.json)

### 4.2 实际已经应用的排期

- Pinterest：48 条原品视频，America/New_York 每天 09:00–20:00，每小时 1 条，2026-09-22 至 2026-09-25。
- YouTube：同 48 条，通常比 Pinterest 晚 10 分钟，09:10–20:10；通过独立 YouTube API 脚本实际上传并设置 `publishAt`。
- Instagram：已实际发布前 5 条用于 API 验证；没有整批每日排期。
- 2026-09-23 10:37 UTC 数据库只读快照：Pinterest 非 Grinch 活跃排期 58 条、全部 `ready`、0 overdue，下一条 `2026-09-23T11:00:00Z`。
- 同一时间按 YouTube 原品回执计算：48 条中仍有 36 条未来 `publishAt`；这是回执计算，不是实时远端 API 状态证明。

Pinterest 排期回执：[pinterest-schedule-receipt.json](file:///D:/代码/社媒/视频+产品链接%20交付文件夹/2026-09-21_winninghunter-outwardsk-christmas-krejova-filamniceent/agent-output/pinterest-schedule-receipt.json)

YouTube 排期回执：[youtube-schedule-receipt.json](file:///D:/代码/社媒/视频+产品链接%20交付文件夹/2026-09-21_winninghunter-outwardsk-christmas-krejova-filamniceent/agent-output/youtube-schedule-receipt.json)

### 4.3 计划但未应用的每日 10 条方案

- rank 6–55，共 50 条。
- 每天 10 个美东时段：`06:00、07:30、09:00、10:30、12:00、13:30、15:00、16:30、18:00、19:30`。
- Pinterest 和 Instagram 计划同一时刻；YouTube 通过单独回执映射到 VibePin 的 `externalPublishingPlans`。
- 执行脚本：[ops-three-platform-daily-ten.ts](file:///D:/vp-worktrees/three-platform-plan-0922/web/scripts/ops-three-platform-daily-ten.ts)
- 当前只允许 dry-run；缺少 50 条 YouTube verified receipt 时脚本会拒绝 `--apply`。

## 5. VibePin 的发布接入方式

### 5.1 Pinterest 原生链路

```text
Studio 上传
→ /api/studio/video-upload/prepare + finalize
→ generated-private 私有对象与 provenance
→ pin_drafts 保存媒体、字段、connection、Board、scheduled_at
→ VPS 每 5 分钟调用 /api/cron/publish-due
→ durable publish intent / destination / provider attempt
→ Pinterest POST /media
→ 上传视频
→ GET /media/{mediaId} 轮询
→ POST /pins
→ 保存 remote Pin id/url 与 destinationResults
```

- VPS cron 的 curl 超时已从 60 秒提高到 330 秒，以覆盖视频链路最长处理时间。
- 当前 durable 视频链路能防止 `delivery_unknown` 被盲目重试，但还没有自动 reconciliation worker。
- 2026-09-22 有一条视频在上传阶段进入 unknown；通过媒体 API 证明 `mediaId` 仍为 `registered`、没有进入 Pin create，再安全重发成功。远端 Pin：`813814595212178138`。

### 5.2 Instagram 原生链路

- OAuth 与 connection 已存在。
- `/api/publish/social` 已支持 Reels。
- 私有视频 materialization、durable attempt、usage metering、unknown state、近期媒体只读 reconciliation 已落代码。
- 首条 unknown 后通过近期媒体核对恢复；rank 2–5 直接发布成功。
- 尚未建立统一的 50 条 Instagram scheduled drafts。

Instagram 回执：[instagram-ranks-2-5-receipt.json](file:///D:/代码/社媒/视频+产品链接%20交付文件夹/2026-09-21_winninghunter-outwardsk-christmas-krejova-filamniceent/agent-output/instagram-ranks-2-5-receipt.json)

### 5.3 YouTube 外部链路

- YouTube 不在 VibePin 原生 `scheduledDestinations` 中。
- 本地 Python 脚本使用 YouTube OAuth 上传为 private，并写入未来 `publishAt`。
- VibePin Weekly Plan 只读取 `externalPublishingPlans` 展示 YouTube badge、时间和链接；cron 不会发布 YouTube。
- 本地发布器目录：[youtube underground architect workflow](file:///D:/代码/youtube/youtube%20underground%20architect%20workflow)

## 6. 已改代码与当前状态

### 6.1 当前接管分支

- Worktree：[three-platform-plan-0922](file:///D:/vp-worktrees/three-platform-plan-0922)
- Branch：`codex/three-platform-plan-0922`
- HEAD：`b3661877f0ca1d343b5eea1b18b81059e3115931`
- Main workspace 分支 `feat/referral-credits-0904` 存在大量不同任务的混合修改，不是集成候选；禁止 reset、clean 或整体提交。

### 6.2 已提交并进入 b366 祖先链的主要功能

| 功能 | 关键提交 | 当前结论 |
|---|---|---|
| 批量视频上传 orchestration | `1fd6aed3` 等 | 多文件隔离、恢复与失败兄弟隔离已落代码 |
| 可追加视频上传队列 | `4b1c2060`、`6c8589f3` | 上传中可以继续添加文件，生命周期加固 |
| 视频封面选择 | `9153ea4d`、`9127d2b1` | 封面帧选择持久化并用于发布和 AI |
| 卡片 AI 文案快捷入口 | `09121b76`、`3e3b00a6`、`2b7c4580`、`5227c3aa` | 单卡入口、busy lock、跨卡形态保护 |
| AI Copy v2 | `344235e2` 至 `2669212b`、`04b0ebe0` Preview 验证 | 事实卡、关键词证据、校验、session/RLS 已实现；由双 flag 控制 |
| Pinterest 视频 API | `003ef47c`、`eb8bfed6`、`8d68f291` | register/upload/poll/create + durable attempt |
| 视频纵版与兼容性 | `1c25972a`、`d9f460b2` | 真实 1080×1920、full-range 转 TV-range、主体不裁切 |
| Studio 卡片真实性 | `d0c79e17`、`629f9b05`、`e1ab7712`、`b6c21116` | 草稿/排期/已发布字段恢复、真实比例、alt text、只读 posted |
| Instagram Reels | `c269f548` 至 `29bb6884` | 官方发布、durable settlement、近期媒体 reconciliation |
| Weekly Plan 外部渠道 | `b3661877` | YouTube 计划只展示，不进入原生 dispatch |

AI Copy v2 内部 Preview 回执：[AI_COPY_V2_INTERNAL_PREVIEW_04B0EBE0_20260916.md](file:///D:/vp-tmp/coordination/receipts/AI_COPY_V2_INTERNAL_PREVIEW_04B0EBE0_20260916.md)

Pinterest/纵版排期回执：[CHEERISH_VERTICAL_SCHEDULE_20260920.md](file:///D:/vp-tmp/coordination/receipts/CHEERISH_VERTICAL_SCHEDULE_20260920.md)

### 6.3 AI Copy v2 运行开关

- Server：`AI_COPY_V2_ENABLED=true`
- Client：`NEXT_PUBLIC_AI_COPY_V2=true`
- 任一关闭时走旧 AI Copy。
- Preview 曾设置两 flag 为 true；Production 未改。
- 接管者需重新读取当前 Vercel Preview env，不能沿用旧回执假设。

### 6.4 尚未提交的运营脚本

当前 worktree 有 1 个 tracked 修改和 12 个左右 untracked `ops-*` 工具，不能当作正式产品代码：

- [cheerish-video-schedule.ts](file:///D:/vp-worktrees/three-platform-plan-0922/web/scripts/lib/cheerish-video-schedule.ts)：仅增加 `Christmas Gift Ideas & Holiday Fun` 到允许 Board。
- [ops-inspect-original-queue.ts](file:///D:/vp-worktrees/three-platform-plan-0922/web/scripts/ops-inspect-original-queue.ts)：只读检查有效排期、due 和下一批。
- [ops-inspect-draft-failure.ts](file:///D:/vp-worktrees/three-platform-plan-0922/web/scripts/ops-inspect-draft-failure.ts)：查看单草稿失败与媒体。
- [ops-reconcile-draft-intent.ts](file:///D:/vp-worktrees/three-platform-plan-0922/web/scripts/ops-reconcile-draft-intent.ts)：查看 intent、attempt 和 Pinterest evidence。
- [ops-inspect-pinterest-media.ts](file:///D:/vp-worktrees/three-platform-plan-0922/web/scripts/ops-inspect-pinterest-media.ts)：只读查询 Pinterest media 状态。
- [ops-find-pinterest-pin.ts](file:///D:/vp-worktrees/three-platform-plan-0922/web/scripts/ops-find-pinterest-pin.ts)：按 Board/标题/URL 核对远端 Pin。
- [ops-resolve-unuploaded-pinterest-attempt.ts](file:///D:/vp-worktrees/three-platform-plan-0922/web/scripts/ops-resolve-unuploaded-pinterest-attempt.ts)：仅在证据证明 upload 未完成、Pin 未创建时清理本地 unknown 结果。
- [ops-publish-next-original-now.ts](file:///D:/vp-worktrees/three-platform-plan-0922/web/scripts/ops-publish-next-original-now.ts)：把指定或下一条原品改为 due，并直接调用本地 publish-due handler。
- [ops-cancel-crawling-christmas-batch.ts](file:///D:/vp-worktrees/three-platform-plan-0922/web/scripts/ops-cancel-crawling-christmas-batch.ts)：取消 Grinch Pinterest 批次。
- [ops-prepare-crawling-christmas-batch.ts](file:///D:/vp-worktrees/three-platform-plan-0922/web/scripts/ops-prepare-crawling-christmas-batch.ts)：已停止商品的准备脚本，不应再执行。
- [ops-verify-crawling-christmas-batch.ts](file:///D:/vp-worktrees/three-platform-plan-0922/web/scripts/ops-verify-crawling-christmas-batch.ts)：已停止商品的核验脚本。
- [ops-three-platform-daily-ten.ts](file:///D:/vp-worktrees/three-platform-plan-0922/web/scripts/ops-three-platform-daily-ten.ts)：50 条三平台每日 10 条方案，目前只 dry-run。

接管者应逐个代码审查，决定提交到专用 ops 分支还是归档；不要把整批未提交脚本直接混入产品部署。

## 7. VibePin 当前需要优化的地方

### P0：发布可靠性

1. 建立真正统一的后台发布队列。Studio 立即发布和定时发布都应只创建 job，HTTP 请求不等待 provider。
2. 实现 destination 级最多 5 次尝试：首次 + 4 次自动重试；明确失败才重试。
3. 实现自动 reconciliation worker。`delivery_unknown` 必须查询 media / recent Pins 后决定 published 或 retry_wait。
4. 自动保存 stage、HTTP status、provider code、request id、media id；当前 v81 迁移未应用时只有 fallback evidence。
5. 监控 cron heartbeat、最老 due、claim age、unknown age 和 retry backlog。
6. 图片和视频共用一致的 retry / unknown / final failure 规则。

权威 PRD：[0921-VibePin-Pinterest统一发布队列与五次自动重试PRD-v1.0.md](file:///D:/代码/Pinterest%20flow/docs/prd/【待fable审核】0921-VibePin-Pinterest统一发布队列与五次自动重试PRD-v1.0.md)

### P0：Preview 与验收

1. 修复 stable alias 的 Vercel SSO，确保无 Vercel Session 时进入 VibePin 登录页。
2. 每次部署冻结 exact commit、deployment ID、unique URL、stable alias、test DB ref。
3. 重新做桌面和移动端两轮 authenticated UI 验收，不能继承旧截图 PASS。
4. 核对 Preview env 中 AI Copy、legacy discovery、video upload 等 flags。

### P0：三平台排期

1. 先处理仍未来排期的 Grinch YouTube 视频。
2. 决定是否继续现有小时排期，还是切换到用户确认的每天 10 条。
3. 若切换，先生成并远端核验 50 条 YouTube receipt，再运行 daily-ten dry-run。
4. Instagram 先 canary 1 条、再 4 条、再批量；每阶段都必须 remote readback，不能只信本地 201。
5. 避免同一内容在 Pinterest/Instagram clone 与原草稿之间重复发布。

### P1：Studio

1. 后台 upload queue 要持久化，单个文件慢或失败不能阻塞继续添加。
2. 所有卡片状态始终展示标题、描述、URL、Board、账号和真实比例。
3. 文字“Saved on this device”与服务端事实源冲突，应改成账号/云端同步状态。
4. Posted 卡片必须保留远端证据与平台链接。
5. 将发布阶段、attempt、下次重试时间和 reconciliation 状态做成用户可理解的 UI。

权威业务 PRD：[0921-VibePin-Studio改版业务版PRD-v1.0.md](file:///D:/代码/Pinterest%20flow/docs/prd/【待fable审核】0921-VibePin-Studio改版业务版PRD-v1.0.md)

### P1：AI Copy / SEO

1. 对 Preview 当前 flag-on 行为重新做真实 UI smoke。
2. 建立“博主 Prompt”与“VibePin grounded SEO”两个实验模式，保存生成版本与发布表现，不伪造因果。
3. 官方 Pinterest Trends 只有拿到可靠来源时才能显示“官方”；否则显示估算/未知。
4. Amazon/独立站 URL 导入先做标题和页面 metadata，价格/评分/评论必须接合规 API。
5. 非英语不使用英语关键词库作为需求证据。
6. 浏览器插件采集 Pinterest 参考图是后续独立 Goal，不继续扩大人工全类目标注。

## 8. 接管后的建议执行顺序

1. 只读核对当前时间、Grinch YouTube 10 条远端状态；停止未来排期，不动已发布视频。
2. 修复 Stable Preview 的 Vercel SSO / alias，并验证 `/api/version` 返回应用 JSON。
3. 运行 Pinterest 队列只读检查，确认没有 overdue、stale claim 或 delivery_unknown。
4. 读取三个回执：Pinterest、YouTube、Instagram，建立平台 × 内容 × 时间矩阵。
5. 让用户确认采用“当前小时排期”还是“每天 10 条”。不要在未确认且 YouTube receipt 缺失时运行 `--apply`。
6. 把运营脚本从产品代码中分离，审查后做一个 clean ops commit；禁止从当前 dirty main workspace 集成。
7. 按统一发布队列 PRD 实现五次重试和 reconciliation worker，先测试库迁移、mock provider、并发/崩溃恢复，再 Preview。
8. 对 AI Copy v2、批量视频上传、封面、卡片字段和 Plan 外部渠道做两轮 UI 验收。
9. 最后再决定是否把 YouTube 原生接入 VibePin；此前保持“外部计划展示 + 独立发布器”。

## 9. 安全与操作禁区

- 不触碰 Production Supabase、Production Vercel、真实支付或正式 OAuth 配置。
- 不 reset/clean 主工作区；现有修改属于多个任务。
- 不用浏览器当前登录账号推断发布目标；按 user id、connection id、username/channel id 校验。
- 不盲目重试 `delivery_unknown`。
- 不把 YouTube external plan 放入 `scheduledDestinations`，否则 VibePin cron 会误认为自己负责发布。
- 不执行已停止 Grinch 批次的 prepare/verify 脚本。
- 不把本地 receipt 当成远端当前状态，涉及删除、取消或重复风险时必须读远端 API。
- 不把 AI Copy 内部分数展示成精确 SEO/Search Volume。

## 10. 接管者首先应读的文件

1. [AI_ADVISOR_WORKFLOW.md](file:///D:/代码/Pinterest%20flow/docs/coordination/AI_ADVISOR_WORKFLOW.md)
2. [0906-VibePin-技术总监新会话接管指令-v1.0.md](file:///D:/代码/Pinterest%20flow/docs/coordination/0906-VibePin-技术总监新会话接管指令-v1.0.md)
3. [0921-VibePin-Pinterest统一发布队列与五次自动重试PRD-v1.0.md](file:///D:/代码/Pinterest%20flow/docs/prd/【待fable审核】0921-VibePin-Pinterest统一发布队列与五次自动重试PRD-v1.0.md)
4. [0921-VibePin-Studio改版业务版PRD-v1.0.md](file:///D:/代码/Pinterest%20flow/docs/prd/【待fable审核】0921-VibePin-Studio改版业务版PRD-v1.0.md)
5. [0918-VibePin-Tailwind工作台交互改版与URL驱动AI-PRD-v2.0.md](file:///D:/代码/Pinterest%20flow/docs/prd/0918-VibePin-Tailwind工作台交互改版与URL驱动AI-PRD-v2.0.md)
6. [0910-Pinterest视频Pin发布成功方案.md](file:///D:/代码/Pinterest%20flow/docs/0910-Pinterest视频Pin发布成功方案.md)
7. [VIBEPIN_DESIGN_SYSTEM.md](file:///D:/代码/Pinterest%20flow/docs/design/VIBEPIN_DESIGN_SYSTEM.md)
8. [AGENT_UI_CHECKLIST.md](file:///D:/代码/Pinterest%20flow/docs/design/AGENT_UI_CHECKLIST.md)
9. [web/AGENTS.md](file:///D:/代码/Pinterest%20flow/web/AGENTS.md)

## 11. 推荐的新会话启动指令

```text
你现在接管 VibePin 的发布运营与产品开发。先完整阅读
D:\代码\Pinterest flow\docs\coordination\0923-VibePin-发布运营与产品开发接管交接-v1.0.md。

第一轮只做只读核对：
1. 检查 Grinch YouTube 未来 10 条是否仍 scheduled；已经发布的不要删除。
2. 检查 Stable Preview 是否仍被 Vercel SSO 拦截，并读取当前 build SHA。
3. 检查 Preview Test DB 的 Pinterest due/unknown/stale claims。
4. 核对当前小时排期与 daily-ten dry-run，不执行 --apply。
5. 盘点 codex/three-platform-plan-0922 的已提交代码和未提交 ops 脚本。

给我一份短状态：立即风险、实际生效排期、代码边界、建议下一步。没有新授权不得部署 Production、改生产数据库、真实付款或盲目重发 unknown。
```
