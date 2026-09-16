# Task 2 Independent Review — Round 4

结论：**APPROVED**（限定 Task 2 代码审查范围）。最终提交没有剩余 Critical / Important。Round 3 的在途上传清理阻断已关闭；本轮在初始提交中发现的两个问题也已修复并独立复验。

审查范围：`3b6b11239562189cae00cf7e882bad9c89ca7d4a..884c2611c2b1deb7d62d3737651939b569ef8945`，包含初始送审 `1da8c3cd3dad5e88593bdd4a65dd5c6e05b51183` 与跟进修复 `884c2611`。已阅读上一轮审查、更新 implementer report、Round 4 package、实际差异和关联生产实现。遵循 requesting-code-review / verification-before-completion：结论基于真实代码、本地运行和内存破坏探针，不只采用实现报告。

## Critical

无。

## Important

无未关闭项。

## 已关闭的问题与独立证据

| 项目 | 结果与位置 |
| --- | --- |
| 真实上传 deadline | [videoDirectUpload.ts:55](D:/vp-tmp/wt-video-pin-p0-0916-final/web/src/lib/studio/videoDirectUpload.ts:55) 创建独立 AbortController，在第 65 行设置 15 分钟定时中止，并将 signal 传给真实 PUT fetch。caller abort 也向该控制器传播。测试验证实际 fetch 的 signal、计时参数和两类稳定错误。 |
| signed-upload 协议与秘密 | [videoDirectUpload.ts:41](D:/vp-tmp/wt-video-pin-p0-0916-final/web/src/lib/studio/videoDirectUpload.ts:41) 在发送前核对 HTTPS、bucket/path、token 和 upsert=false；传输采用安装的 Storage SDK 对应的 PUT、FormData cacheControl=3600、空名 file 字段、x-upsert=false，不手工指定 multipart boundary。错误不携带 signed URL/token。 |
| 时间边界数学 | [videoUploadLimits.ts:6](D:/vp-tmp/wt-video-pin-p0-0916-final/web/src/lib/videoUploadLimits.ts:6) 为 2h capability + 15m 最大在途 + 5m visibility tail = 2h20m。首次清理观察允许在 capability+5m，但不是终结边界。DB [migrate_v77_video_media.sql:281](D:/vp-tmp/wt-video-pin-p0-0916-final/backend/db/migrate_v77_video_media.sql:281) 强制 late_upload_recheck_after = capability_expires_at + 20m；post-sign confirmation 第 542 行同步扩展尾部。 |
| cleanup 不依赖浏览器通知 | prepare/reissue 原子创建延迟 outbox，确认能力后才暴露 token；abort/timeout 尝试 finalize 只是加速路径。finalize 通知失败、失败登记失败或即时 remove 失败，不会删除原有持久责任。focused 用例实际覆盖这些故障分支。 |
| 旧观察跨边界结算 | 初始 1da8c3cd 只检查 settlement 的 now()，独立 RPC 探针证明：边界前 lease/缺失观察、边界后 settle 可错误得到 done。修复后的 [migrate_v77_video_media.sql:385](D:/vp-tmp/wt-video-pin-p0-0916-final/backend/db/migrate_v77_video_media.sql:385) 检查 old.last_attempted_at：旧 lease 必须回 pending，清空 completed/dead-letter/lease，保留下一次检查。相同探针现在先 pending，重新领取边界后的 lease 并进行新观察后才 done。 |
| 迟到对象和 early dead-letter | PG 测试实际插入本地 storage.objects 迟到对象，在第二次 lease 下删除后才结算 done。额外独立探针将 attempts 设到 10 并在边界前 settle failed/delete_failed，得到 pending、deadLettered=false、非空 next_attempt_at。 |
| deadline 破坏检测 | 初始 focused runner 在移除 deadline 的 controller.abort() 后停在 29/31、Node 却 exit 0。修复后的 [test-video-upload-private.ts:14](D:/vp-tmp/wt-video-pin-p0-0916-final/web/scripts/test-video-upload-private.ts:14) 加入真实 5 秒 watchdog、完成计数及 beforeExit gate。同一内存变异 applied=true，现在 exit 1，明确报告 test_timeout 与 incomplete 29/31。 |
| 清理边界破坏检测 | 内存去掉 last_attempted_at guard，并同步函数 hash 以避免仅因 manifest 失败：现有 [verify-v77-video-media.mjs:333](D:/vp-tmp/wt-video-pin-p0-0916-final/backend/tests/pglite_v37/verify-v77-video-media.mjs:333) 行为断言失败，exit 1，精确指出旧观察跨边界不能终结清理。 |
| migration / rollback / permissions | migration 与 rollback 使用一致 cleanup trigger hash `4024c51379966b96cc60a0d093575e19`；late-recheck 的 NOT NULL、精确 CHECK、trigger/function ownership 和权限均纳入 manifest。本地完整 verifier 覆盖 reapply、rollback/reapply 和漂移前置拒绝；c65 的“先检查、后撤权” gate 保留。 |

## 前三轮修复抽查

- cleanup lease 锁定 upload item 并先进入 cleaning，live finalize claim 拒绝 cleanup；claim/finalize/reissue 不能复活 cleaning。完整 PG 套件保留两个获取顺序的 barrier 检查。
- 所有 video provenance source 的 NULL/矛盾依旧 DB fail-closed，proxy 独立拒绝，未回退到把 browser declaration 当 verified facts。
- production findItem 的 owner + batch + ordinal 查询断言仍在；真实 route/store/storage/client 都由 focused 套件导入。native video cookie auth、Vary Cookie/Authorization/Range 保留。
- 原子 finalize + provenance/replay、失败 cleanup 权、完整 ftyp、初始 206、播放 200/206/416 与 upstream MIME/range/length 验证、流式 SHA-256 均由本轮通过的生产适配测试或 PG 测试继续覆盖。

## Minor

- 非阻塞： [videoDirectUpload.ts:80](D:/vp-tmp/wt-video-pin-p0-0916-final/web/src/lib/studio/videoDirectUpload.ts:80) 在上传中止后 await best-effort finalize，但通知请求自身没有截止时间。Storage 上传已被中止且 DB 责任仍安全；若通知永久不返回，调用者收到 timeout/aborted 错误也会延后。后续可给通知独立短时限，以改善交互上的错误返回时限。本项不影响本轮要求的 Storage 在途 deadline 或持久清理保证。

## 执行证据与边界

- `node backend/tests/pglite_v37/verify-v77-video-media.mjs`：**140 assertions，failures=[]，verdict pass，exit 0**。运行时补丁内容已核对与最终提交一致。
- cached tsx 执行 `scripts/test-video-upload-private.ts`：**31 passed，0 failed，exit 0**；最终提交之后再次执行通过。
- `npm run typecheck`：**exit 0**。
- 独立跨边界 RPC 探针、attempts=10 early failure 探针：**exit 0**，结果如上。
- deadline-abort removal mutation：**applied=true，exit 1**。fresh-observation-guard removal mutation：**applied=true，exit 1**。均只在内存改写，没有改动磁盘产品文件。
- 最终 `git rev-parse HEAD` 为 `884c2611c2b1deb7d62d3737651939b569ef8945`；产品/测试 tracked diff 为空，`git diff --check` **exit 0**。审查员仅新增此报告。
- 无真实 Supabase/Storage/Pinterest 调用，无部署、推送、合并、生产迁移或外部状态变更。模拟结果验证本地协议与边界，不声称已验证真实 provider 的网络/落盘 SLA。

Task 2 可以进入后续集成验收。此结论不是部署许可；此前 v75 广泛 Storage policy 的既有 deployment_blocked gate 仍须保留。
