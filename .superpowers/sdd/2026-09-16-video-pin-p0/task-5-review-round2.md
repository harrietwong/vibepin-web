# Task 5 Round 2 独立审查

结论：**CHANGES REQUESTED**。Critical 0，Important 4，Minor 0。不能标记 APPROVED。

审查范围：`c3bf41175548880322f7be0445410090e627d0f6` → 实际 HEAD `1cb4a521cd3ccd8e5202ae3cad4f08575e9628f1`。已读原审查、更新后的实施报告/progress、fix review package，并检查实际 diff 和完整相关实现。本轮仅写本报告；未修改产品代码/测试/索引/HEAD，未调用真实 provider、数据库或 Storage，未部署、推送或合并。

## 上轮问题状态

| 项目 | 状态 | 证据 |
|---|---|---|
| I1：客户端 mode 控制视频路径 | 部分修复，未关闭 | 正常已持久化视频无论省略 mode 都走封面；实际图片也忽略伪造视频 hint。但草稿读取错误/null 仍被当成 image，见 R2-I1。 |
| I2：自由文本推断进入封面事实 | 部分修复，未关闭 | 封闭枚举过滤原动作/品牌/材质例子；新增 cover prompt、独立 motion/audio/temporal detector 类型和禁止修复的验证错误。但无效观察会被默认成虚构静态事实，见 R2-I2。 |
| I3：安全测试隔离了待测边界 | 有改善，未关闭 | canonical/path/provenance 生命周期和 bounded handler 现已实际运行。生产 DB owner selector 和最终 provider 消息拼装仍被替换，两个破坏性内存变异均未被测试发现，见 R2-I3。 |
| Minor：独立脚本依赖外部环境变量 | 已关闭 | 原 cover 与新 hardening 脚本均在动态 import 前自行设置虚拟配置；无外部配置运行均退出 0。 |

## Critical

无。

## Important

### R2-I1：草稿读取失败仍然错误放行客户端视觉事实

位置：[videoCoverEvidence.ts:98](D:/vp-tmp/wt-video-pin-p0-task5/web/src/lib/ai-copy/v2/videoCoverEvidence.ts:98)，关联 [videoCoverEvidence.ts:47](D:/vp-tmp/wt-video-pin-p0-task5/web/src/lib/ai-copy/v2/videoCoverEvidence.ts:47)、[route.ts:143](D:/vp-tmp/wt-video-pin-p0-task5/web/src/app/api/ai-copy/v2/analyze/route.ts:143)。

`defaultLoadOwnedDraft` 把查询 error/no data 转 null，resolver 又把异常 catch 成 null；selector 把 null（也包括缺失/畸形 media）直接视为 image。一次临时数据库失败就足以让实际视频重新走客户端 `imageObserved` 分支，而且请求显式声明 video_cover 也不影响结果。

实测：真实 resolver 在 loader 抛错和返回 null 时均返回 `{kind:'image'}`。真实 route + 本地认证/session mocks，在 loader 抛 `temporary DB failure`、请求包含 `mediaEvidenceMode:'video_cover'` 和 `imageObserved.summary:'A person walks while singing'` 时，返回 **HTTP 200 / fact-card-v1 / image_observed / no_keyword_demand_data**，并调用 session completion。无法确认媒体类型不等于已确认图片，错误事实还会进入持久化/重放。

修复要求：区分 confirmed image、confirmed video、missing/unknown/read failure；读取失败必须安全错误或无视觉证据降级，不能接纳客户端视觉事实。对旧图片保持兼容时，应保留可验证的旧图片条件，不能把所有未知状态都自动判 image。补充真实 loader 错误、not-found 和畸形数据分支测试。

### R2-I2：无效模型观察被默认值变成虚构视觉事实

位置：[videoCoverEvidence.ts:43](D:/vp-tmp/wt-video-pin-p0-task5/web/src/lib/ai-copy/v2/videoCoverEvidence.ts:43)，关联 [videoCoverEvidence.ts:106](D:/vp-tmp/wt-video-pin-p0-task5/web/src/lib/ai-copy/v2/videoCoverEvidence.ts:106)。

parser 对任何缺失/非法 composition 强行填 `still_life`，对 layout 填 `centered`，之后无条件产出观察事实并标 `degradedMode:'none'`。这些是内容事实，不能作为缺省值猜测。provider 返回 `{}`、`null`，或者仅有禁止内容且非法 composition/layout 时，没有任何支持“静物、居中”的视觉证据。

实测三个输入：`null`、`{}`、`{objects:['person singing','真皮','Nike shoes'],composition:'unknown',layout:'unknown'}`，全部返回 `imageObserved.summary:'still_life composition'`、`style:'centered'`、`degradedMode:'none'`。新增 [test-ai-copy-v2-video-cover.ts:63](D:/vp-tmp/wt-video-pin-p0-task5/web/scripts/test-ai-copy-v2-video-cover.ts:63) 甚至把非法 composition 转静物写成了预期行为。

修复要求：无效枚举值应舍弃，不能生成事实；schema 无效或无可用观察时应无视觉事实/安全降级。保留有效字段时也不能为缺失字段补内容。新增 schema 空/错类型/全非法/部分合法反例。

### R2-I3：生产 owner 查询和真实 provider 拼装被破坏仍全绿

位置：[test-ai-copy-v2-video-cover-hardening.ts:16](D:/vp-tmp/wt-video-pin-p0-task5/web/scripts/test-ai-copy-v2-video-cover-hardening.ts:16)、[test-ai-copy-v2-video-cover-hardening.ts:25](D:/vp-tmp/wt-video-pin-p0-task5/web/scripts/test-ai-copy-v2-video-cover-hardening.ts:25)，关联 [test-ai-copy-v2-routes.ts:222](D:/vp-tmp/wt-video-pin-p0-task5/web/scripts/test-ai-copy-v2-routes.ts:222)。

虽然测试开始经过实际 poster resolver/handler，所有视频用例仍注入 `loadOwnedDraft` 和 `analyzePoster`，没有观察默认数据库过滤链和 chatJson 实际请求。声称“只 mock I/O 并执行 production provider assembly”的实施报告超出证据。

本轮执行了真正的内存 mutation：拦截 Node 的 `_compile`，仅针对 videoCoverEvidence 模块的编译内存，删除生产 `.eq("vibepin_user_id",userId)`，并把生产 provider `image_url.url: input.dataUrl` 改为 `private://raw-video.mp4`。记录明确显示两个变异分别应用 **1** 次。随后原 cover、新 hardening 和 routes **45/45** 全部通过，进程退出 0；磁盘和 git 状态未改变。测试不能识别本任务最重要的两类破坏。

修复要求：默认 draft 查询通过可记录的 DB I/O fake 执行，断言 owner/draft/deleted filters；默认 provider 拼装通过 chatJson 或底层网络 I/O fake 执行，断言只含真实 bounded poster data URL、严格提示和正确 owner cost context。保留上述两个 mutation 为验收，修复后必须红；新增覆盖 download/provider 失败和响应去敏感字段的贯穿测试。

### R2-I4：当前提交类型检查失败，不能作为可集成修复

位置：[route.ts:145](D:/vp-tmp/wt-video-pin-p0-task5/web/src/app/api/ai-copy/v2/analyze/route.ts:145)、[validateCopy.ts:496](D:/vp-tmp/wt-video-pin-p0-task5/web/src/lib/ai-copy/v2/validateCopy.ts:496)。

独立执行 `node node_modules/typescript/bin/tsc --noEmit --incremental false` 已完整结束，**退出 1，8 处诊断**，与本次实施报告“typecheck passed”矛盾。上轮相同命令通过，当前诊断均涉及本轮改动。

- route.ts:145：TS18047，`cover` 可能为 null。
- validateCopy.ts:496：TS2345，包含 video 类型的 `DetectedClaimType` 传给仅接受 `CommercialDetectedClaimType` 的函数。
- [test-ai-copy-v2-routes.ts:299](D:/vp-tmp/wt-video-pin-p0-task5/web/scripts/test-ai-copy-v2-routes.ts:299)：TS2339，回调形参仅声明 key 却读取 value。
- [test-ai-copy-v2-video-cover-hardening.ts:59](D:/vp-tmp/wt-video-pin-p0-task5/web/scripts/test-ai-copy-v2-video-cover-hardening.ts:59) 和同文件第 70 行：未缩窄 image/video 联合类型就读取 analysis。
- [test-ai-copy-v2-video-cover.ts:16](D:/vp-tmp/wt-video-pin-p0-task5/web/scripts/test-ai-copy-v2-video-cover.ts:16)、同文件第 44、57 行：TS2322，provenance fixture 缺少 owner_user_id/source_type/intent_id/lifecycle_state，使用了不存在的旧结构。

修复要求：修正产品类型缩窄、commercial trap 类型和实际 provenance fixture，而非增加 any/关闭严格检查；重新运行完整 typecheck 并更新报告的实际结果。

## 回归与其他检查

- 普通 image 的模式不强制 video；检测到 video_motion/audio/temporal 也仅在 `mediaEvidence.mode==='video_cover'` 时拒绝。已有图片事实和 legacy flag-off runtime 测试通过，本轮未发现普通 image/legacy 功能退化。
- cover-specific generation prompt 已进入共享 generate/repair prompt，独立检测失败/不支持的 motion/audio/temporal claim 会拒绝。非英语测试目前通过注入正确 detector 类型验证消费者；没有真实模型语义准确性验证，本次禁止真实 provider 调用。
- poster exact path、private bucket、owner-aware handler、12 MiB 流限制/10 MiB vision 限制仍保留；正常 missing poster、cross-owner path、failed/unresolved provenance、oversize 情况下观察到零 provider 调用。
- 没有新增模块级可变依赖覆盖。持久化的正常 video evidence 和 unavailable replay 测试通过；错误识别为 image 的 R2-I1 不受此保护。

## 本轮实际命令结果

所有命令在工作树 web 目录执行；tsx 使用已安装缓存 `C:/Users/44740/AppData/Local/npm-cache/_npx/fd45a72a545557e9/node_modules/tsx/dist/cli.mjs`，没有下载依赖。

- `test-ai-copy-v2-video-cover.ts`：独立配置运行通过，退出 0。
- `test-ai-copy-v2-video-cover-hardening.ts`：通过，退出 0。
- `test-ai-copy-v2-routes.ts`：45 passed / 0 failed，退出 0。
- `test-ai-copy-v2-facts.ts`、`test-ai-copy-v2-ui.ts`：通过，退出 0。
- `check-test-registry.ts`：240 tracked / 232 runnable / 8 excluded，退出 0。
- `tsc --noEmit --incremental false`：退出 1，上述 8 处错误。
- `git diff --check`：退出 0。
- resolver/route/schema 只读内存探针：复现 R2-I1、R2-I2。
- `_compile` 内存 mutation：2 处变异均确认应用；cover/hardening/routes 仍全绿，证明 R2-I3。

未运行全量 Web suite、生产 build 或浏览器 QA；不声称这些通过。应先修复以上 Important 并重新独立验证，再决定集成。
