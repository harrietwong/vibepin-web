# Task 5 Round 3 独立审查

结论：**CHANGES REQUESTED**。Critical 0，Important 1，Minor 0。上一轮四项 Important 均已关闭，但本轮引入了合法旧图片草稿的兼容性回归，不能标记 APPROVED。

范围：`1cb4a521cd3ccd8e5202ae3cad4f08575e9628f1` → 实际 HEAD `e8590ab8515e35255dc223a173ac186c79f0b194`。已读 Round 2 审查、更新报告、Round 3 review package，以及实际 diff/相关完整实现。仅写本报告；未修改产品代码、测试、索引或 HEAD。没有外部服务调用、部署、推送、合并。

## 上轮四项关闭证据

| 项目 | 结论 | 本轮独立证据 |
|---|---|---|
| R2-I1：null/throw 被视为 image | 关闭 | [videoCoverEvidence.ts:102](D:/vp-tmp/wt-video-pin-p0-task5/web/src/lib/ai-copy/v2/videoCoverEvidence.ts:102) 将读取失败归为 unknown；route 只允许 confirmed image 接纳客户端视觉事实。loader throw/null/畸形 payload 的 hardening + route 反例通过，视觉事实清空并持久化 unavailable。 |
| R2-I2：空观察被补成静物/居中 | 关闭 | [videoCoverEvidence.ts:41](D:/vp-tmp/wt-video-pin-p0-task5/web/src/lib/ai-copy/v2/videoCoverEvidence.ts:41) 无默认内容；null/空/全拒绝观察产生无视觉事实降级，部分合法字段保留且 summary/style 留空。对应独立测试通过。 |
| R2-I3：生产边界变异仍全绿 | 关闭 | 新 production-boundary 测试执行默认 DB selector 和 provider 拼装。正常运行退出 0；两种独立内存 mutation 均红，详见下文。 |
| R2-I4：8 处 TypeScript 错误 | 关闭 | 独立运行完整 `node node_modules/typescript/bin/tsc --noEmit --incremental false`，已结束，退出 0、无诊断。 |

## Critical

无。

## Important

### R3-I1：合法 imageUrl-only 旧图片被错误标为视频封面不可用

位置：[videoCoverEvidence.ts:48](D:/vp-tmp/wt-video-pin-p0-task5/web/src/lib/ai-copy/v2/videoCoverEvidence.ts:48)，关联 [route.ts:143](D:/vp-tmp/wt-video-pin-p0-task5/web/src/app/api/ai-copy/v2/analyze/route.ts:143)。

新 selector 要求 payload 包含 `media[0].kind === "image"` 才认定为图片。项目的合法旧图片合同并不要求 media 数组：[contentDraftModel.ts:192](D:/vp-tmp/wt-video-pin-p0-task5/web/src/lib/contentDraftModel.ts:192) 明确把 imageUrl-only 草稿转为 image；[pinDraftStore.ts:499](D:/vp-tmp/wt-video-pin-p0-task5/web/src/lib/pinDraftStore.ts:499) 明确“不物化 legacy single-image fallback”，避免重写旧草稿。服务端旧 payload 因此不会自然补齐 media。

本轮只读探针使用已加载的合法 owner 草稿：`{id:'legacy-image', imageUrl:'/api/storage-image?path=studio/uploads/owner/image.png', source:'uploaded_image', altText:'Blue mug'}`。既有 `contentMedia` 返回 kind=image，新 resolver 却返回 kind=unknown、mode=video_cover、video_cover_unavailable。调用真实 analyze handler（仅认证/session/draft I/O 使用本地 mocks），携带正常图片观察 `Blue mug / mug / blue`，实际返回 **HTTP 200、facts:[]、fact-card-v2、mediaEvidence.mode:'video_cover'、video_cover_unavailable**。

影响：开启 v2 的已有图片草稿丢失视觉/关键词相关性依据，生成结果和 UI 被错误附加“视频封面”标签。当前所谓图片回归用例仅覆盖带显式 media 数组的新图片；legacy flag-off 测试通过也不能证明旧图片在 v2 中兼容。这违反 Task 5 的 existing image / legacy 不退化要求。

修复要求：区分读取失败/缺失/畸形数据与**成功读取的合法旧图片形状**。为后者保留受验证的图片路径，必要时结合私有图片 provenance/内容类型确认；不能重新把所有 unknown 判 image，也不能允许显式 video 借 imageUrl 旁路。加入 imageUrl-only owner 草稿的 route 回归，断言保留原图片事实、不出现 video_cover 标签，并保留 null/throw/video 缺封面的安全反例。

## Minor

无。

## 生产边界 Mutation 证据

仅拦截 Node `_compile` 中该模块的内存代码，未修改磁盘；每种变异单独进程执行新增 production-boundary 测试：

- 删除默认 `.eq("vibepin_user_id",userId)`：确认变异应用 1 次；[test-ai-copy-v2-video-cover-production-boundaries.ts:47](D:/vp-tmp/wt-video-pin-p0-task5/web/scripts/test-ai-copy-v2-video-cover-production-boundaries.ts:47) 的 DB 过滤链断言失败，退出 1。
- 将默认 provider `image_url.url` 从 poster data URL 改为 `private://raw-video.mp4`：确认变异应用 1 次；[test-ai-copy-v2-video-cover-production-boundaries.ts:57](D:/vp-tmp/wt-video-pin-p0-task5/web/scripts/test-ai-copy-v2-video-cover-production-boundaries.ts:57) 的 bounded poster bytes 断言失败，退出 1。

因此原 R2-I3 所指的两种真实破坏现已能被测试检测。正常生产边界用例同时断言 owner/draft/deleted 条件、严格静态提示、owner cost context；封面 helper 未读取媒体的 video URL 字段。

## 本轮验证结果

在工作树 web 目录使用本地已缓存 tsx CLI；未安装/下载依赖。

- `test-ai-copy-v2-routes.ts`：46 passed、0 failed，退出 0。
- `test-ai-copy-v2-video-cover.ts`、`test-ai-copy-v2-video-cover-hardening.ts`、`test-ai-copy-v2-video-cover-production-boundaries.ts`：均通过，退出 0。
- `test-ai-copy-v2-facts.ts`、`test-ai-copy-v2-ui.ts`：通过，退出 0。显式 media 图片及 legacy flag-off 无新增失败，但未覆盖 R3-I1。
- `check-test-registry.ts`：241 tracked、233 runnable、8 excluded，退出 0。
- `node node_modules/typescript/bin/tsc --noEmit --incremental false`：退出 0，零诊断。
- `git diff --check`：退出 0。
- 只读内存对比探针及真实 route 探针：复现 R3-I1。
- 正常私有 poster 读取仍经过 exact owner/provenance 和 bounded handler；missing/越权/failed/unresolved/超限用例零 provider 调用。未发现新增 raw video、path 或 token 被加入安全结果字段。

未运行全量 Web suite、生产 build、真实 provider 或浏览器 QA；本报告不声称这些已通过。建议仅修复上述兼容性问题并复核，不重新放宽已关闭的安全边界。
