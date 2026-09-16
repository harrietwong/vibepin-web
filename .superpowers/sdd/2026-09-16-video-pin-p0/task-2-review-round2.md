# Task 2 Independent Review — Round 2

结论：**CHANGES REQUIRED / NOT APPROVED**。相对于要求审查的 `ac860375a952d29fcfbd4b8fbba0861360757125`，仍有 1 个 Critical、3 个 Important；审查过程中出现的跟进提交 `c65e0f80` 已单独验证修复其中一个 Important，因此跟进状态仍有 1 个 Critical、2 个 Important 未解决。

比较基线：`5f5fe502968f96effb7fc9be9b9fd372d6520512`。已重新阅读原审查、更新实现报告、进度、round2 review package，以及当前完整 handler/store/Storage adapter、三个生产 route、client/hash、v77 migration/rollback 和聚焦/PGlite 测试。所有行号以 ac860375 为准，除明确标注的跟进验证。

## Prior Findings Recheck

| 原项 | 本轮结果 |
| --- | --- |
| C1 finalize 请求间的失败误删 | 已修复：数据库 claim/CAS 对失效 token 拒绝 finalize/fail；handler 只有获得 cleanupAllowed + cleanupScheduled 才删除。新的 outbox 竞争另列 R2-C1。 |
| I1 declared 冒充 verified | 正常上传路径已修复：生产 adapter 忽略 uploader SHA，未知 checksum 持久化 NULL，verified dimensions/duration 保持 NULL，provenance 带来源标签。来源标签约束的 NULL 漏洞另列 R2-I1。 |
| I2 finalized/provenance 非原子 | 已修复：同一 RPC 事务提交二者；碰撞回滚；成功 replay 检查完整 provenance。 |
| I3 native video cookie 鉴权 | 已修复：生产 route 引用 verified bearer-or-cookie helper；响应 Vary 包括 Cookie。 |
| I4 能力过期、重签及补偿 | 部分修复：拒绝过期/终态、签发前持久化 outbox、fail/outbox 原子、删除失败保留责任；仍有清理与确认竞争及真实签发时间差，见 R2-C1。 |
| I5 ftyp / initial range | 主要修复：206、MIME、区间、总长和实际字节校验；完整 ftyp box size/minor/brand 校验；错误响应和旧截断 fixture 已被拒绝。 |
| I6 playback 上游校验 | 主要修复：状态、MIME、区间/总长、超量和短流均有校验；full 200 的 malformed Content-Range 小问题见 Minor。 |
| I7 生产边界与有效测试 | 有改善，但未完成：新增 store RPC、Storage HEAD、播放 route 接线、client 测试；真实 owner query 的 mutation 仍存活，见 R2-I3。 |
| Minor 稳定码、全量摘要 | 已修复主要问题：query failure 不再装作 not-found；冲突映射 409；浏览器使用增量哈希。14 种长度已与 Node SHA-256 交叉验证。 |

## Critical

### R2-C1. 延迟清理能取得删除权后，finalize 仍然提交成功

位置：`backend/db/migrate_v77_video_media.sql:466-468`、`:514-515`、`:542-545`；相关既有清理协议为 `backend/db/migrate_v76_publish_asset_materializer.sql:1558-1563`。

claim 的最长两分钟窗口可以跨过 batch/capability 到期边界。claim 不延迟/互斥 outbox 清理；v76 cleanup lease 只看 outbox 到期，不检查 upload claim。finalize 只检查自己的 token/lease，没有检查对象已进入清理，也没有与正在 processing 的 outbox 协商，而是无条件将它改成 done 并清空清理 lease。

实际 PGlite 复现（使用真实当前 RPC，SQL 调整时间字段只用于模拟跨过两小时边界）：prepare → claim(120 秒) → batch/capability/outbox 到期但 claim 仍有效 → `publish_cleanup_lease` → `video_upload_item_finalize`。结果同时为：

```text
cleanupLease: { leased: true, leaseToken: "bbbb...", attempts: 1 }
finalize: { status: "finalized", provenanceReady: true }
outbox: { status: "done", lease_token: null }
```

清理者已经取得的外部删除操作无法靠数据库清空 lease 撤销，因此仍可能删除刚成功的视频；后续清理 settle 失败也无法还原视频。先删除再 finalize 同样会产生 finalized 指向已删对象。

此外 `:357` 用数据库 prepare 开始时间加两小时作为能力终点，真正 Storage 签名发生在 RPC 之后；outbox 可能早于真实 token 到期。临近 token 到期才开始的上传，也可能在 token 到期后才完成，当前没有覆盖在途上传的确定性终止/静默期。不能把“已过数据库预计两小时”直接等价于“此路径不再可能写入”。

修复：给上传确认和清理一个共同的、受状态和 lease 约束的删除权协议。清理取得权利前必须原子排除有效 finalize claim；finalize 不能覆盖正在进行的清理。持久化能力时间应覆盖实际签发和允许的在途窗口，并保留安全的延迟复查责任。测试至少覆盖 cleanup先claim、finalize先claim、能力晚签发和延迟上传完成。

## Important

### R2-I1. NULL 可以绕过 provenance 来源约束，播放仍把它当 ready

位置：`backend/db/migrate_v77_video_media.sql:308-316`；`web/src/lib/server/media/storageMediaHandler.ts:60`。

新增 `media_asset_provenance_video_fact_sources_check` 的来源列均允许 NULL，CHECK 内部没有 `IS TRUE`/显式非空。PostgreSQL CHECK 对 UNKNOWN 放行。只填 owner/bucket/path、video、video/mp4、size、draft，所有来源与维度/时长为 NULL 的行能够插入。播放 handler 也完全不检查这些来源，最终可返回 200。

实际 PGlite insert：`rejected(...)` 返回 null（未拒绝）；随后以同样的 provenance 调用真实 playback handler，得到 HTTP 200。当前正常 finalize RPC 会填完整标签，所以这不是已证明的浏览器任意写入入口；但数据库和读取两层都未满足要求的 unknown/unresolved facts fail-closed，generic provenance register 或异常数据可绕开“已验证事实”的读取约束。

修复：video 分支整体使用 `IS TRUE`，明确必需字段非空；播放检查所需事实来源及完整性。补充逐字段 NULL、未知来源、来源/值矛盾的 PGlite和读取测试，正常历史 image 行仍应兼容。

### R2-I2. ac860375 的 rollback 未检查新增 schema 漂移

位置：`backend/db/rollback_v77_video_media.sql:4-13`。

该提交的 preflight 只检查表注释；在 capability_expires_at 已丢失 NOT NULL 的漂移 schema 上仍执行 rollback 并撤销 service writes。实际针对 **ac860375 committed rollback** 的 PGlite 探针返回 `error:null, can_insert:false`，不符合既定 rollback 拒绝不匹配 schema 的要求。

跟进状态：审查过程中协调者提交了 `c65e0f80 fix(video): harden v77 rollback manifest`。我单独对它重复同一探针，得到 `v77_rollback_collision/P0001, can_insert:true`；该具体问题在 c65e0f80 已修复。未把此跟进结果冒充 ac860375 的通过证据。

### R2-I3. 真实 owner 查询仍未测试，关键 mutation 存活

位置：`web/scripts/test-video-upload-private.ts:59-84`；目标实现 `web/src/lib/server/media/videoUploadStore.ts:41-44`。

新增 production store 测试只调用 claim/finalize/fail，from 被设置为直接抛错；所有 handler 测试继续注入 findItem stub。PGlite verifier直接执行 SQL RPC，并没有通过 TypeScript createVideoUploadStore。因此两套测试之间缺少实际查询/adapter 的组合。

我在 **内存编译 hook** 中明确移除了 findItem 的 `.eq("owner_user_id", ownerUserId)`，输出 `applied=true`，然后原聚焦测试仍 **27 passed, 0 failed**。这直接证明“测试可识别 owner 隔离破坏”的验收项尚未满足。当前未变异产品实现本身仍有正确过滤；这项是实际测试缺口，不是声称已发生跨用户泄漏。

prepare/finalize 生产 route 也没有被该脚本实际导入；Supabase adapter 新测试只验证 HEAD 不信任 metadata，未验证真实 readRange/remove 的方法、路径、header/响应适配。补齐生产 route 接线和真实 store query 测试，并将 handler/store 与本地 PGlite 合作运行，覆盖本报告的清理竞争和 NULL 来源案例。

## Minor

- `web/src/lib/server/media/storageMediaHandler.ts:71` 以 `!upstreamRange` 判断“没有 Content-Range”，实际同时包括 malformed header。full 200 带 `Content-Range: malformed` 仍被接受，已复现 200；应检查原始 header 是否缺失，与报告“no Content-Range”合同一致。
- `video_upload_item_claim` 的 finalized replay 只接受 provenance lifecycle=draft，而播放与 v76 允许 publish_pending/published/retained。后续集成涉及这些生命周期时，应明确 replay 合同，避免已发布的有效对象被误判 provenance_incomplete。
- progress 仍是最初 Task 2 pending 文案，未反映新提交和本轮状态；建议更新审查后的进度记录。

## Independent Verification

- 未变异聚焦脚本独立运行两次，均 **27/27，exit 0**。
- 从 `git show ac860375:backend/tests/pglite_v37/verify-v77-video-media.mjs` 读取提交版本，通过 stdin 执行，**115 assertions、failures=[]、exit 0**，避免把开始时已有的未提交 verifier 修改算入提交证据。第一种长命令参数方式触及 Windows 长度限制，改用 stdin 成功，无文件修改。
- 真实 PGlite 故障探针：cleanup lease 与 finalize 同时成功；NULL 来源 video provenance insert 成功；旧 rollback 接受 schema 漂移；c65e0f80 拒绝相同漂移。
- 内存 mutation 1：删 Cookie Vary，测试在第 21 项失败，exit 1，能检出。
- 内存 mutation 2：client `upsert:false → true`，实际 client 测试失败，exit 1，能检出。
- 内存 mutation 3：删 store findItem owner filter，已确认变异生效，整个聚焦脚本仍 27/27，exit 0，未检出。
- 增量 SHA-256 与 Node createHash 比较，覆盖 0/1/55/56/63/64/65/127/128/129/65535/65536/65537/1000000 字节，**14/14 一致**。
- 无产品代码、测试文件、数据库文件、索引或 HEAD 修改。只新增本报告。没有外部服务调用、远端 DB/Storage、部署、推送或合并；所有数据库写操作仅发生在内存 PGlite。

## Assessment

本轮修复明显改善了原有风险，原 finalize 竞争和原子 provenance 缺口已关闭，但新的到期清理协议仍可能删除成功对象，来源约束和测试有效性仍有阻塞项。**当前不能 APPROVED**；包含 c65e0f80 的跟进状态也不能改变这一结论。
