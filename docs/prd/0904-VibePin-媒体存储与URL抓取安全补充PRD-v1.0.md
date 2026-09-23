# 0904 VibePin 媒体存储与 URL 抓取安全补充 PRD v1.0

> 状态：代码侧候选已完成，Preview 尚未部署；Production 仍阻断  
> 范围：`/api/fetch-og`、`/api/storage-image`、`/api/history-storage`、Studio 生成/上传媒体生命周期  
> 非范围：本 PRD 不授权修改 Supabase bucket、数据库、环境变量或 Production。

## 1. 背景与结论

当前代码已补齐 URL 抓取的 SSRF 防护，以及媒体代理的认证、owner 校验、响应类型和大小限制。但如果 `generated` bucket 仍为 public，调用者可以绕过应用路由，直接访问对象公开 URL；仅修 `/api/storage-image` 不能形成完整隐私边界。

因此本阶段结论为：

- URL 抓取代码候选可进入 Preview 验证。
- 受保护媒体代理代码候选可进入 Preview 验证。
- 媒体隐私不得判定完成，直到 bucket 架构、历史对象迁移和匿名直链测试全部闭环。
- `READY_FOR_PRODUCTION: NO`。

## 2. 目标

1. 所有由用户提供的 URL 必须在认证后访问，并抵御私网、重定向、DNS rebinding、超大响应和滥用。
2. 草稿、上传、生成中间产物默认私有，只能由资源 owner 经受保护路由或短时签名 URL 读取。
3. 发布到第三方所需的公开媒体与私有草稿媒体分离，不允许用“整个 generated bucket 公开”换取 provider 可访问性。
4. 历史媒体保持可追踪、可迁移、可回滚，不通过删除数据来消除告警。

## 3. 安全需求

### SEC-URL-01 认证先于网络

`/api/fetch-og` 在 DNS、HTTP 或重定向请求前完成登录态校验。未认证请求不得产生任何外部网络访问。

### SEC-URL-02 SSRF 与 DNS rebinding

- 仅允许 HTTP/HTTPS。
- 禁止 URL credentials、非 Web 端口、localhost、私网、链路本地、保留地址、IPv4-mapped IPv6 和混合公私 DNS 答案。
- 预检解析与连接时解析都必须执行公网判定；连接时答案变化为私网时拒绝。
- 每次 redirect 都按新 URL 重新验证；最多 3 次。

### SEC-URL-03 响应与滥用边界

- HTML 响应上限 256 KiB，同时检查 `Content-Length` 与真实流式字节数。
- 按用户限流；超限返回稳定错误码和有界重试时间。
- 客户端只看到通用错误，不泄漏上游地址、DNS 结果、内部堆栈或凭证。

### SEC-MEDIA-01 私有草稿资产

以下资产必须保存在 private bucket 或等价私有前缀：

- Studio 用户上传图；
- AI 生成中间图和未发布成品；
- Product/Reference 选择中属于用户私有的数据；
- 历史生成任务仅 owner 可见的输出。

读取必须同时验证登录用户、对象 owner 和对象路径，响应使用 private cache、`Vary: Authorization, Cookie` 与 `X-Content-Type-Options: nosniff`。

### SEC-MEDIA-02 发布资产分离

provider 确需公网读取时，系统在用户最终确认发布后生成独立发布资产：

- 优先使用 provider 支持的上传接口；否则复制到独立 public publish bucket 或生成有界签名 URL。
- public 对象不得沿用私有草稿的永久 URL。
- 发布资产必须绑定 publish intent、用户、来源对象和生命周期。
- 取消、失败、超时和未派发状态不得创建永久公开副本。

### SEC-MEDIA-03 Owner 映射

不得长期依赖“查询最近 500 个 generation jobs 并比对 URL”作为访问控制。必须建立可索引的 durable 映射，至少包含：

- object path；
- owner user id；
- source type；
- generation/upload/publish intent id；
- created/retention state；
- published copy 或 provider remote id（如存在）。

访问控制查询必须按 owner + exact path 命中，不得模糊匹配、跨用户扫描或使用任意来源 URL 作为授权证据。

### SEC-MEDIA-04 响应安全

- 只允许 PNG、JPEG、WebP、GIF、AVIF。
- 同时限制 `Content-Length` 与真实流式字节数，当前上限 12 MiB。
- 空 body、未知 MIME、超限、owner 不匹配和证据缺失全部 fail closed。
- history API 只返回受保护 proxy URL，不返回可绕过的原始私有对象 URL。

### SEC-MEDIA-05 发布资产 Materializer

所有即时发布与排期发布必须使用同一条 durable 顺序，任何路由不得绕过：

`auth → client receipt → stored draft/schedule revision → exact owner/capability → prepare intent → materialize → claim → meter → provider → remote evidence → cleanup/reconcile`

- `prepare` 只落不可变确认、来源 revision 和 destination snapshot，不授予 provider dispatch 权。
- Materialization 以 `intent + destination + source checksum + strategy version` 幂等；Pinterest/social 两条兼容路由必须复用同一资产记录。
- 策略优先级固定为 provider bytes、短时 signed URL、独立 public publish copy。永久公开私有草稿 URL 禁止作为策略。
- signed URL token 只能存在于服务端本次调用内存，不得写数据库、日志、evidence 或客户端响应。
- public publish copy 必须使用不可猜路径、`upsert:false`、短 retention 和 durable cleanup outbox；不得复用 legacy `generated` bucket。
- 每个 destination 独立 materialize/claim/settle；失败 sibling 不阻断 ready sibling，成功 destination 不得重发。
- source checksum/etag 在确认后发生变化时返回 conflict，要求用户重新确认。
- provider 请求已发出但响应/settlement 丢失时进入 `delivery_unknown`，禁止盲重试或提前清理仍可能被 provider 抓取的对象。
- Schedule 保存只准备 intent，不签 URL、不复制 public 对象；到期时重新核验连接能力并 materialize。
- Cancel/Escape/X 在请求发送前保持零 DB、Storage、meter、provider 副作用；请求到达服务器后断开连接不等于取消，必须通过 reconcile 展示真实状态。
- Zernio 等未验证媒体摄取契约的 provider 默认 `publish_asset_strategy_unverified` fail closed；OneUp 等未实现 provider 在 materialize 前拒绝。

v76 至少包含 `publish_assets`、`publish_asset_deliveries`、append-only `provider_publish_attempts`，并扩展 intent/destination 状态与 cleanup outbox 的 lease、retry、dead-letter 字段。所有写 RPC 仅 `service_role` 可执行、固定 `search_path`，并在数据库内再次核对 owner、fingerprint、source revision 和 destination identity。

## 4. 数据迁移与回滚

1. 先盘点 bucket public/private 状态、匿名 GET、现有对象数量和代码中的永久 public URL 依赖。
2. 创建或确认 private draft/generated bucket，不直接翻转现有 bucket 后假设客户端兼容。
3. 建立 owner/path 映射并回填历史对象；无法确定 owner 的对象隔离为 `unresolved`，不得公开。
4. 新写入切换到 private 路径；旧读路径保留观察期。
5. 发布路径改为 provider upload 或独立 publish asset。
6. 观察期通过后关闭旧 public 读取；不删除历史对象。
7. 回滚只回滚应用读写选择，不重新把 private bucket 全量设为 public。
8. v76 schema/RPC 先在 PGlite 完成 apply-twice、并发 lease/CAS、partial destination、cancel/reconcile/rollback；再在显式绑定的隔离 test Supabase 复验，最后才允许接入 Preview 路由。

## 5. 验收用例

| ID | 用例 | 预期 |
|---|---|---|
| SEC-A01 | 未登录调用 fetch-og | 401；DNS/HTTP 调用次数为 0 |
| SEC-A02 | URL 首次解析公网、连接时变私网 | 拒绝；无私网连接 |
| SEC-A03 | 公网 URL redirect 到私网 | 第二次请求前拒绝 |
| SEC-A04 | 非 80/443 或协议不匹配端口 | 拒绝 |
| SEC-A05 | `Content-Length` 或流式 body 超 256 KiB | 有界失败，无完整 body 落内存 |
| SEC-A06 | 同一用户连续抓取超限 | 429/稳定 code；未继续外呼 |
| SEC-A07 | 未登录读取 storage-image | 401；DB/Storage 调用次数为 0 |
| SEC-A08 | A 用户请求 B 用户对象 | 403/404；无对象内容 |
| SEC-A09 | owner 读取合法图片 | 成功；private cache、Vary、nosniff 正确 |
| SEC-A10 | 未知 MIME、空 body、超过 12 MiB | fail closed |
| SEC-A11 | history 查询 | 只返回当前 owner 的 proxy URL |
| SEC-A12 | 匿名请求 private draft 原始 Supabase URL | 失败；不能绕过应用鉴权 |
| SEC-A13 | 用户确认发布前 | 不存在公开副本或永久公网 URL |
| SEC-A14 | 用户取消/发布失败 | 无新增永久 public 对象 |
| SEC-A15 | 合法发布 | public/provider 资产可追踪到 exact intent 与 owner |
| SEC-A16 | 历史 owner 未解析对象 | 隔离，不公开、不误归属 |
| SEC-A17 | 390px/桌面读取私有媒体 | 正常显示，不发生横向溢出或 public URL 泄漏 |
| SEC-A18 | 32/100 个相同 intent 并发 | 一个 materialization winner、一个 claim、一次 provider dispatch |
| SEC-A19 | Pinterest/social 兼容路由同时收到同一 intent | 复用同一 publish asset/delivery；不重复复制、签名或发布 |
| SEC-A20 | 确认后 source checksum/etag 改变 | 409 conflict；claim/meter/provider 均为 0 |
| SEC-A21 | signed URL 发布 | token 不进入 DB、JSON、console、attempt evidence；TTL 后不可访问 |
| SEC-A22 | mixed destination materialization | ready sibling 可继续；失败 sibling 保持 not-sent/retryable；成功目标不重发 |
| SEC-A23 | Schedule 保存后尚未到期 | 只存在 prepared schedule intent；无 signed URL/public copy/provider 请求 |
| SEC-A24 | cancel 与 materialize/claim 并发 | CAS 线性化；成功 cancel 后 reserve/claim 必须失败，越过边界则显示 cancel-pending |
| SEC-A25 | provider 响应或 ledger settlement 丢失 | `delivery_unknown` + remote/request evidence；禁止盲重试 |
| SEC-A26 | cleanup 404/5xx/lease 超时 | 404 视为完成；5xx 有界退避；lease 可接管；上限后 dead-letter |
| SEC-A27 | legacy public 迁移 | owner 高置信回填、冲突 unresolved、checksum 一致、双读通过后才关闭匿名 public read |

## 6. 发布门禁

以下条件缺一不可：

- focused 安全测试连续两轮通过；
- test registry、TypeScript、ESLint、完整 webpack build 通过；
- Preview 部署后验证匿名直链不可读、owner 可读、跨 owner 不可读；
- 上传、生成、历史记录和发布确认四条链路不返回私有原始 URL；
- public publish asset 的创建与清理具有 intent/owner 审计证据；
- Production bucket 状态、迁移 SQL/脚本、回滚步骤经过独立安全审查；
- 未得到 Production 明确授权前，不执行 bucket、DB 或环境变更。

## 7. 当前实现状态

- 已实现：fetch-og auth-first、双阶段 DNS 防护、redirect 复验、端口限制、256 KiB 上限、用户限流、错误脱敏。
- 已实现：storage/history auth-first、owner/path 校验、仅认证拉取、MIME/12 MiB 限制、private cache、proxy-only history。
- 已实现但仅提交、未部署：`9cf19817aa133c80d4685c00e41edfaa6ad416d5` 建立 private draft/generated bucket 候选、`(bucket_id, object_path)` durable owner provenance、私有 upload/generation、cleanup outbox、generation owner trust boundary、即时/排期 fail-closed publish gate，以及 legacy publish 410。
- 已实现但仅提交、未部署：后继 `7916249bd35bcc3a7eeada5b8f31e69ed1e7a2c6` 修正 v75 legacy schema 收敛、`failed/unresolved` provenance 可见性、同名 CHECK/policy 冲突 fail-closed，并新增非破坏、可重复执行的 rollback 与 PGlite 验证。
- 已实现但仅提交、未部署：生成与分析的公网图片抓取拒绝所有 `is_global != true` 地址，逐跳重解析并固定已校验 IP；Supabase private object/signed/render URL 的 query、fragment、host case、显式默认端口和 scheme redirect 形态均不会落入普通公网抓取。
- 待完成：intent-bound 独立 publish asset materializer、provider 可读有界 URL 生命周期、失败补偿与 remote evidence。
- 待完成：legacy public `generated` bucket inventory、owner backfill、checksum、unresolved 隔离、双读验证和最终 public-read 关闭。
- 待完成：`storage.objects` 现有 permissive policy 审计；新 policy 会与旧 broad policy 按 OR 合并，不能单独证明私有边界。
- 本地已完成：v75 PGlite 两轮各 65 条断言，覆盖 apply-twice、旧 schema/PK、重复物理路径、anon/auth/service-role、cross-owner、policy/CHECK tamper 与 rollback/re-apply；同时真实证明 broad permissive policy 会 OR 绕过 owner/lifecycle 策略，因此该项仍是部署阻断。
- 已完成（仅 test、非部署）：在显式绑定的 test ref `snulmwprsahzqvdbyenc` 上，权威 v75 SQL 已由受控 runner 按 apply1→pre-apply2 checker→apply2→final after2 checker 顺序应用两次；apply1/apply2 均 exit 0、HTTP 201、`RESULT: APPLIED`，after1、pre-apply2、final after2 checker 均 exit 0、`ok=true`、`errors=[]`。`generated-private` 已创建为 private 且 0 对象；v75 两表均 0 行；`pin_drafts=86`、`social_connections=3`、legacy `generated` 保持 `public=true` 且 51 个对象；v76 仍 absent。
- v75 权威 SQL SHA-256：`29B64AB6428B0D1D46FCEA7664E506343E915602401D8870A2F6B1B82A6E556B`；after1/final inventory fingerprint 均为 `8D2AFBDC94431675C20ACD7026468A84BDBA8F0BFFD4990BAE4DFAAA969DF3B5`，前后保持不变。该结果是 schema/catalog 与数据保持验证，不等同于运行时隐私 PASS；Storage HTTP、runtime owner/cross-owner 对抗、rollback、部署和 Production 均未执行。
- 待完成：cleanup outbox 消费者、告警与恢复 runbook。
- 待完成：后继 Preview 部署绑定和匿名/跨 owner/owner 三组真实环境验收；当前 Preview 仍是旧 runtime，不得把本提交的代码证据当成部署证据。

## 8. 2026-09-04 安全检查点回执

### v76 test apply/repair 状态（2026-09-05）

最终 test-only receipt 为 `D:\vp-tmp\coordination\receipts\SUPABASE_TEST_V76_APPLY_REPAIR_FINAL_20260905.md`：原 `9b4d805…`（SQL `C1816B3E…`）apply1 HTTP 201 后 checker 失败三类；只读诊断确认两个真实 `service_role` trigger guard ACL 漏撤销与一个 RI owner checker 假设错误。最终 `d8968ae…`（SQL `A584B556…`）通过本地 PGlite `280/280 × 2`、高审 P0/P1/P2=0、checker `85/85 × 2`；apply1/apply2 均 HTTP 201，after/pre/final checker 均 `ok`，fingerprint `4d304…` 保持不变。业务聚合与原 before artifact hash `e7d0…`/归档路径保持，仅重绑元数据。Production 永久拒绝且未触碰；未执行 rollback、Storage HTTP/RPC、provider/publish/payment/deploy/env。v76 仍为 test-only 证据，当前 Preview `3be/Gpjs` 未集成 `d8968ae`，`READY_FOR_PRODUCTION: NO`。

- Worktree：`D:\vp-tmp\wt-media-privacy-architecture-0904`
- Branch：`codex/media-privacy-architecture-0904`
- Parent：`be1d4940f712c6460ef460e33e830a3f249956f6`
- HEAD：`9cf19817aa133c80d4685c00e41edfaa6ad416d5`
- Receipt：`D:\vp-tmp\coordination\receipts\MEDIA_PRIVACY_ARCHITECTURE_9CF19817_20260904.md`
- Receipt SHA-256：`C28368C664CF0545BE458C82DBC3752C2E2244D80F98480448A5950722F90249`
- 独立高级审查：代码 P0=0、P1=0；允许作为 `security hardening + fail-closed publish gate` 非部署检查点提交。
- Exact-HEAD 关键结果：媒体隐私 16/16、媒体 offload 15/15、URL import 43/43、发布/排期相关 277/277、AI auth/provider/rate-limit 94/94、Python 55/55、registry 233/225/8、typecheck、webpack 71/71、diff-check 全通过。
- Lint：新增/其余改动文件 0 error / 7 warnings；全 changed-file 范围仍命中 `WeeklyPlanWorkspace.tsx` 的既有 3 errors / 15 warnings，未作为本检查点新增错误冒充清零。
- 结论：`CODE_CHECKPOINT_COMMITTED / DEPLOYMENT_BLOCKED / READY_FOR_PRODUCTION:NO`。

### v75 迁移验证后继回执

- Worktree：`D:\vp-tmp\wt-media-v75-validation-0904`
- Branch：`codex/media-v75-validation-0904`
- Parent：`9cf19817aa133c80d4685c00e41edfaa6ad416d5`
- HEAD：`7916249bd35bcc3a7eeada5b8f31e69ed1e7a2c6`
- Receipt：`D:\vp-tmp\coordination\receipts\MEDIA_V75_PGLITE_VALIDATION_7916249B_20260904.md`
- Receipt SHA-256：`63F09C2A5A1DC3583DDD1BA149501CBECE837FEA241CB5B953FE68B8608B9264`
- 独立高级复审：P0=0、P1=0；允许作为 `v75 migration/rollback + PGlite validation checkpoint` 提交，不允许部署。
- 测试：提交后 PGlite 两轮各 65/65；媒体隐私 16/16；diff-check PASS；worktree clean。
- 结论：`MIGRATION_CHECKPOINT_COMMITTED / REAL_SUPABASE_POLICY_AUDIT_REQUIRED / DEPLOYMENT_BLOCKED`。

### test Supabase v75 受控 apply 两次回执（2026-09-04）

- 目标：仅 test ref `snulmwprsahzqvdbyenc`；Production ref 被永久拒绝；未执行 v76、Storage HTTP、runtime owner/cross-owner、rollback、部署、环境变更或 Production 操作。
- 权威 SQL：`29B64AB6428B0D1D46FCEA7664E506343E915602401D8870A2F6B1B82A6E556B`。
- apply1/apply2：均 exit `0`、HTTP `201`、`RESULT: APPLIED`；无 retry。
- after1、pre-apply2、final after2 checker：均 exit `0`、`ok=true`、`errors=[]`；after1/final fingerprint 均为 `8D2AFBDC94431675C20ACD7026468A84BDBA8F0BFFD4990BAE4DFAAA969DF3B5`。
- 数据与对象保持：`pin_drafts=86`、`social_connections=3`；legacy `generated` 为 `public=true`、51 个对象；`generated-private` 为 private、0 对象；v75 两表 0 行；v76 absent。
- 解释边界：这是受控 schema/catalog、ACL/RLS 形态和数据保持证据，不是 Storage HTTP 或 runtime owner/cross-owner 运行时隐私证据；rollback 也未执行。Receipt：`D:\vp-tmp\coordination\receipts\SUPABASE_TEST_V75_APPLY1_20260904.md`、`D:\vp-tmp\coordination\receipts\SUPABASE_TEST_V75_APPLY2_FINAL_20260904.md`。

### v76 本地 schema checkpoint（2026-09-04）

- Branch：`codex/publish-asset-v76-schema-0904`；HEAD：`6d07601385dfd84762b54d5d79824224bfe31a8c`；Parent：`7916249bd35bcc3a7eeada5b8f31e69ed1e7a2c6`。
- 4 files；v76 多轮验证 `122/122`；v75 `65/65 × 2`；media privacy `16/16`；Opus：P0=0、P1=0、P2=14。
- Receipt：`D:\vp-tmp\coordination\receipts\PUBLISH_ASSET_V76_SCHEMA_6D076013_20260904.md`；SHA-256：`46166E2C517B955C21D6A137BAE5B0187F12518518B3DFE779D295EDBECB745B`。
- 这是本地 v76 schema checkpoint；v76 仍 absent，未部署、未执行 v76 外部 DB apply。v75 test apply 两次已完成，但 Storage HTTP、runtime owner/cross-owner、rollback、broad `storage.objects` policy 审计/收窄仍是门禁；`READY_FOR_PRODUCTION:NO`。
