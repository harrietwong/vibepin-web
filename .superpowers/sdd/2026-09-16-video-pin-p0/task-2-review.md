# Task 2 Independent Review

结论：**CHANGES REQUIRED — NOT APPROVED**。

审查基线：`d7635c02b2bb010380c39d5c7777fbdadbcab8da`；审查 HEAD：`5f5fe502968f96effb7fc9be9b9fd372d6520512`。已阅读计划、实现报告、审查包，以及实际 handler、route、Storage adapter、store、provenance 和 v77 RPC；未修改生产代码、索引、分支或 HEAD。遵循 requesting-code-review 和 verification-before-completion。以下行号均对应审查 HEAD。

## Strengths

- Handler 在读取请求 JSON、DB 查询和 Storage 调用之前鉴权；owner 查询和删除路径都限定用户、batch、ordinal，播放也再次比对 owner/bucket/path。
- 已接入真实 v77 RPC 和私有 Storage；生产上传端和浏览器 helper 都设置 `upsert:false`。错误正文不直接包含 provider 错误、签名或服务密钥。
- 服务端初始字节读取有内存上限；播放使用流且拒绝超量 body；成功响应固定私有缓存、nosniff、Range 相关 headers。

## Critical

### C1. 并发失败可以删除已经成功确认的视频

位置：`web/src/lib/server/media/videoUploadHandler.ts:129-132`，`web/src/lib/server/media/videoUploadStore.ts:49-52`。

`findItem` 之后没有 claim/lease；`failItem` 无状态条件地更新行，随后无论更新是否成功都删除对象。两个请求同时读到 prepared 后，A 可以先完成 finalize 和 provenance，B 的慢 HEAD 请求再抛临时错误；B 随即把 A 的 finalized 行改为 failed 并删除成功视频，已登记的 draft provenance 仍存在。即使只给 update 加 status 条件也不够：删除动作必须取决于请求确实拥有失败转换/清理权。

本地确定性 barrier 复现：`winner 200 loser 503 finalStatus failed removed 1`。修复需要原子的 finalization claim/CAS 和受该 claim 约束的清理；补充两请求交错测试，保证成功对象永不被失败竞争者移除。

## Important

### I1. 未验证的声明被提升成 verified 事实

位置：`web/src/lib/server/media/videoUploadHandler.ts:146-148`；`web/src/lib/server/media/videoUploadStore.ts:43-45`。

Storage 没有 SHA-256 时直接采用浏览器的 declared checksum；宽、高、时长始终直接采用 declared 值，然后写进 `p_verified_checksum_sha256 / p_verified_width / p_verified_height / p_verified_duration_ms` 和没有来源标签的 provenance。报告所称“labelled declared fact”在实际持久化中不存在。只检查前 64 字节不能证明这些事实，也不能把用户提交的 metadata header 自动当作服务端计算的摘要。

本地注入无 checksum 的 stat，声明 checksum 为 64 个 a、尺寸 999×888、时长 1 ms，得到 HTTP 200，全部原样传入 finalize store。应保留明确的 declared/observed 事实，只有经受信任的服务验证后才能填 verified；需要与 v77 的非空约束协调，而不能通过复制声明满足约束。时长的 4 秒至 5 分钟约束也应使用共享常量，当前仅校验大于 0。

### I2. finalized 与可读 provenance 之间存在永久不可恢复窗口

位置：`web/src/lib/server/media/videoUploadHandler.ts:128`、`:147-149`。

v77 finalize RPC 先提交 finalized，随后单独 upsert provenance。如果两步之间进程退出，重试看到 finalized 就直接返回成功，永远不修复缺失的 provenance，播放返回 403。若第二步失败后的 `failItem` 也失败，当前清理还会删除对象，却继续留下 finalized 行，后续仍返回成功。

本地重放一个 finalized/无 provenance 的记录：HTTP 200，`provenanceCalls 0`。应在同一数据库事务中持久化最终事实和 provenance，或实现明确的可恢复中间状态及幂等恢复；重复成功响应必须对应已提交的完整结果。

### I3. 生产播放路由无法接受原生 video 标签请求

位置：`web/src/app/api/storage-media/route.ts:16`。

该 route 只调用 `getUserIdFromBearer`。计划中的 `<video src="/api/storage-media?...">` 不能自行附加应用的 Authorization header，同源请求发送的是 cookie；现有 image proxy 已使用 verified bearer-or-cookie helper。因此登录用户也会在正常原生播放器路径得到 401。没有实现其他携带 bearer 的流式播放机制。

已实际导入生产 GET，以只有 cookie 的 Request 调用，结果 `401 external calls: 0`，证明 cookie 在进入任何验证前已被忽略。应使用现有经过验证的 cookie 回退并相应把 Cookie 加入 Vary；补充生产 route 接线测试。

### I4. 过期/终态 replay 仍签发上传能力，清理后可重新制造孤儿

位置：`web/src/lib/server/media/videoUploadHandler.ts:93-101`、`:131-132`；`web/src/app/api/studio/video-upload/prepare/route.ts:20`。

prepare 不检查 existing.expiresAt/status，也忽略 prepareItem 的返回 status。v77 的 item prepare 对完全相同的已存在项在检查 batch 过期/可准备状态前就返回，因此旧的 failed/finalized/过期项都能获得新能力。本地注入符合 RPC 行为的 expired failed replay，得到 `200 signed 1`。

此外本地安装的 Supabase SDK 文档与实现表明 createSignedUploadUrl 有效两小时且无 expiresIn 参数，而 ledger 默认十五分钟；删除一次不能撤销已签发能力，删除后 `upsert:false` 也不能阻止向已空出的同一路径再次上传。当前只有删除失败才登记 outbox，成功删除后没有覆盖能力有效期的延迟复查/清理记录，产生未追踪私有孤儿。

应拒绝不允许上传的生命周期/过期 replay，明确已完成 replay 的响应，不再签新 token；将能力有效期、在途上传以及延迟清理纳入持久化补偿合同。删除和 outbox 均失败时也不能静默丢失恢复责任。

### I5. finalize 没有验证初始 Range 的响应和有效容器结构

位置：`web/src/lib/server/media/videoUploadHandler.ts:107-114`、`:143-144`。

readBounded 不检查 HTTP 状态、Content-Range 或实际读取范围；hasFtyp 只检查偏移 4 的四个字符。现有“有效 MP4”测试 fixture 仅 12 字节，却声明 ftyp box 长 24 字节，缺少必需的 minor version，整个对象本身就是截断容器。它仍成功成为 finalized video；错误响应只要含有这四个字符也会成功。本地 `new Response(ftyp, {status:500})` 得到 finalization 200。

应验证成功且对应请求起始区间的响应，校验 ftyp box 的最小长度、box size 和允许的 brand/container 合同，并使用真实合法的最小 fixture。至少覆盖 500、错误区间、截断 box、假 magic 和不允许的 brand。

### I6. 播放代理伪造了未经验证的 Content-Range 和 Content-Type

位置：`web/src/lib/server/media/storageMediaHandler.ts:51-59`、`:27-38`。

代理只检查 upstream.ok 及可选 Content-Length；没有校验 upstream Content-Range 的起止/总长、状态与区间的一致性，也没有核对实际 Content-Type。于是请求 bytes=4-7/12、上游返回 206 bytes=0-3/999 text/html 时，仍把这些字节改标为 video/mp4、206 bytes=4-7/12。没有 content-length 的短流也正常结束，仍宣称长度 4。

本地复现：错误上游区间得到 `206 bytes 4-7/12 ABCD`；2 字节上游得到 `206 Content-Length=4 bodyLength=2`。应验证实际响应的 MIME、206 区间和总长度；在流结束检查总读取长度，拒绝短流；对允许的 full 200 明确限定条件，不能仅靠重写响应头实现安全 Range。

### I7. 聚焦测试隔离掉了关键生产边界

位置：`web/scripts/test-video-upload-private.ts:28-30`、`:117-143`。

该脚本仅导入两个纯 handler，所有 store 和 Storage 行为均由宽松 stub 返回；未导入任何生产 route、createVideoUploadStore、createSupabaseVideoStorage 或 client helper。成功 replay 是手动改成 finalized，未运行实际状态转换；跨 owner 案例直接让 findItem 返回 null，不能证明 DB 过滤；无崩溃/并发、真实响应 headers、过期终态 replay、未知 checksum 的测试。聚焦套件 12/12 通过，同时上述故障注入全部复现。

修复代码时必须补充生产接线/adapter 测试和本地 PGlite 驱动的 store 生命周期集成测试。至少让每个以上故障在修复前变红，并证明现有鉴权、owner 过滤、upsert 和 token redaction 的破坏会被检出。

## Minor

- `web/src/lib/server/media/videoUploadStore.ts:12,34` 把所有 RPC 错误压为一个通用错误，并把查询失败当作 not-found；handler 再把 idempotency conflict 返回为 502 capability unavailable。建议保留安全的稳定业务错误码，区分 409 冲突、过期、404 和暂时基础设施错误，避免客户端对确定性冲突重试。
- `web/src/lib/studio/videoDirectUpload.ts:14-16` 在浏览器一次性读取整个最大 100 MiB 文件计算摘要。服务端没有全量缓冲，但后续并发两个上传时此 helper 会占用至少两份文件字节及 digest 开销；建议增量哈希/worker，并明确客户端内存约束。
- 实现报告写 11/11，本次实际 12/12；报告“声明值带标签”与真实写入不符，必须修正文档。

## Verification Evidence

- `git rev-parse HEAD`：确认上述完整 HEAD；已检查实际 diff 与所有 Task 2 生产文件。
- 运行 `node D:/vp-tmp/npm-cache-video-pin-p0/_npx/fd45a72a545557e9/node_modules/tsx/dist/cli.mjs scripts/test-video-upload-private.ts`（cwd 为 web）：exit 0，**12 passed, 0 failed**。初次使用 web/node_modules/tsx 路径不存在；随后使用已有本地 npm 缓存，无联网安装。
- 运行临时内存 `tsx -e` 探针，直接调用当前 handler：未验证事实 200；缺 provenance 的 finalized replay 200 且不恢复；500 ftyp 响应 finalize 200；并发 winner 200 后 loser 503 删除成功对象；expired failed prepare 200 且签发能力；错区间和短流均返回 206。所有输入为本地 stub，未修改实现。
- 实际导入生产 storage-media GET，用 dummy 配置并将 fetch 替换为拒绝任何外部调用的 stub：cookie-only 请求 401，external calls 0。
- 独立运行 `node backend/tests/pglite_v37/verify-v77-video-media.mjs`：exit 0，`verdict: pass`，**94 assertions, failures: []**。该校验验证迁移/RPC 合同，不覆盖新生产 handler/store 的组合与故障恢复；上述发现仍成立。
- 无外部服务、真实数据库、Storage、Pinterest、部署、推送或合并操作。本报告是唯一新写入文件。

## Assessment

存在 1 个 Critical 和 7 个 Important，Task 2 不满足验收。先修复最终确认/清理状态机、验证事实来源、播放鉴权和 Range 验证，再以真实生产边界回归测试重新提交独立审查。
