# Task 2 Independent Review — Round 3

结论：**CHANGES REQUIRED / NOT APPROVED**。上一轮三个主修项均已通过独立复现；没有剩余 Critical，但能力在途上传补偿仍有 1 个 Important 未闭合。

审查范围：`c65e0f802fb95bb972d8515229c391a43af29f7d..3b6b11239562189cae00cf7e882bad9c89ca7d4a`。已阅读 round2 review、更新 implementer report、round3 review package、实际差异及关联生产代码/测试；仅新增本报告，无产品代码、测试、分支、索引或外部状态修改。下列行号对应 `3b6b1123`。

## 已验证关闭

| 项目 | 独立复现结果 |
| --- | --- |
| 清理 lease 与 finalize 互斥 | 原 claim-first 探针重跑：cleanup 返回 `cleanup_item_unavailable/40001`，finalize 成功。反向 cleanup-first：先成功领取清理 lease，item 进入 cleaning；claim 返回 `video_upload_item_not_finalizable`，finalize 返回 `video_upload_claim_lost`。未再出现两种权利同时成功。 |
| NULL/矛盾来源 fail-closed | 原缺所有 source 标签的 video insert 被 CHECK 以 23514 拒绝。五个 source 字段分别设 NULL，真实 proxy 均返回 403 且 Storage 读取次数为零。PGlite 套件还覆盖逐字段 NULL、unknown source 和 checksum 来源/值矛盾。 |
| owner 查询 mutation | 与上一轮完全相同的内存编译变异，移除 `findItem` 的 owner_user_id 条件，确认 `applied=true`；测试现在在 `test-video-upload-private.ts:526` 的 query predicate 断言失败，exit 1。未变异版本 30/30。 |
| c65 rollback gate | 删除 capability_expires_at 的 NOT NULL 后执行 rollback，返回 `v77_rollback_collision/P0001`，service insert 权限仍为 true，没有先修改权限。 |
| 上一轮 Minor | full 200 改为检查原始 Content-Range 必须缺失；finalized replay 接受 draft/publish_pending/published/retained，原问题已修复。 |

清理触发器通过锁定 upload item 并将其转入不可重新确认的 cleaning 状态，关闭了原数据误删竞争。签名返回后、能力暴露给浏览器前，再原子确认延迟清理时间，也修复了“按签名前时间估算真实签发终点”的主要偏差。

## Critical

无。

## Important

### R3-I1. 五分钟 grace 没有对应上传时限，晚完成对象仍可能失去清理责任

位置：`web/src/lib/videoUploadLimits.ts:8-10`，`web/src/lib/studio/videoDirectUpload.ts:29-31`；相关清理结算是 `backend/db/migrate_v76_publish_asset_materializer.sql:1589-1593`，调度由 `backend/db/migrate_v77_video_media.sql:522-525` 更新。

这属于 Round 2 R2-C1 中已经要求覆盖的“token 过期前启动、过期后才完成的上传”，并非新的扩展需求。当前修复把清理延后到签发后两小时加五分钟，并在注释中声称覆盖在途上传；但 direct upload helper 没有最长上传时限、abort 或晚完成后的补偿，安装的 Storage SDK 此调用也没有传入时限。代码中没有保证已接收上传一定在这五分钟内落盘的 provider 合同。

因此允许以下未闭合路径：token 有效期结束前启动一个慢上传 → 到期加五分钟时对象尚不可见 → cleanup 领取 lease，item 进入 cleaning → 删除返回 object_not_found，outbox 结算 done → 原上传随后完成并创建对象。此时 finalize 会正确拒绝 cleaning，但对象已经留在 Storage，outbox 没有下一次复查。

独立实际 RPC 探针确认：cleanup 获得 lease 后调用 `publish_cleanup_settle(...,'done','object_not_found')`，得到 `outbox.status='done', next_attempt_at=null`。该结算没有检查/保存仍在途的上传责任。外部 Storage 没有被调用；这里证明的是本地协议对迟到提交缺少后续责任，不声称已在真实服务上制造了该对象。

修复要求：将清理终结建立在可验证的上传结束/拒绝晚提交合同上，或为该路径保留持久的迟到对象复查责任。若依赖 provider 最大请求时长，必须明确可靠上界，并让清理覆盖该上界；仅把五分钟改成另一个无依据的常量不能闭合此路径。测试应使用可延迟完成的 Storage adapter，先让清理返回 object_not_found，再让旧上传完成，验证对象被后续移除或仍有 pending 清理责任。

## Minor

- 正常准备/确认/播放分支的风险明显下降。当前没有新增需要阻塞的 Minor；此前 progress 文案更新可在整体验收时完成。

## 本轮执行证据

- `node backend/tests/pglite_v37/verify-v77-video-media.mjs`：**134 assertions, failures=[], verdict pass，exit 0**。
- `node D:/vp-tmp/npm-cache-video-pin-p0/_npx/fd45a72a545557e9/node_modules/tsx/dist/cli.mjs scripts/test-video-upload-private.ts`（web cwd）：**30 passed, 0 failed，exit 0**。
- 与 Round 2 相同的 owner-filter 内存 mutation：**applied=true，测试 exit 1**，缺失 owner 条件被精确断言检出。未修改磁盘文件。
- 独立真实 PGlite 顺序/barrier 探针：claim-first、cleanup-first、NULL-source insert、rollback drift均如上表；同时验证 object_not_found 后 outbox 无后续调度。
- 独立 proxy 探针：content_type_source、byte_size_source、checksum_source、dimensions_source、duration_source 各自 NULL 时，共 **5/5 返回 403、无 Storage 读取**。
- `git diff --check`：exit 0。确认审查 HEAD 为 `3b6b11239562189cae00cf7e882bad9c89ca7d4a`。
- 无真实 Supabase、Storage、Pinterest、外部 API、部署、推送或合并；所有数据库操作仅在内存 PGlite 中执行。

## Assessment

原三个主修项的修复通过；清理与确认互斥已成立，来源校验和测试破坏检测也已补齐。剩余 Important 是 late-upload 清理终结合同。该项关闭前，Task 2 尚不能标记 APPROVED。
