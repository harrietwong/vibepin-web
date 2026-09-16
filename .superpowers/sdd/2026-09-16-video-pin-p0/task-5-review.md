# Task 5 独立审查

结论：**CHANGES REQUESTED**。Critical 0；Important 3；Minor 1。当前 HEAD 不满足 Task 5 验收条件，不能标记 APPROVED。

审查基线：`d7635c02b2bb010380c39d5c7777fbdadbcab8da`；实际 HEAD：`c3bf41175548880322f7be0445410090e627d0f6`。已阅读计划、实施报告、审查包、实际 diff，以及关联的 vision/storage handler、事实验证、session store 和客户端调用代码。仅写本报告；未修改产品代码、测试、HEAD 或索引，未进行外部服务调用、部署、推送或合并。

## 已确认的优点

- video_cover 分支使用认证得到的 owner；默认草稿查询具有 owner、draft_id、未删除三个条件。
- 默认 poster resolver 校验私有 bucket、路径 owner 和 exact provenance，再通过 owner-aware `handleStorageImageGet` 读取。该 handler 在下载流上限制 12 MiB，vision 转换再限制 10 MiB；没有视频 URL 回退。
- 新增依赖注入为每次调用传入，没有新增模块级可变 test override。
- media evidence 和 unavailable 状态写入同一 fact card，并由 analyze 重放及 generate 输出沿用；事实策略保留 `image_observed / observed / descriptive_only`。
- UI 包含要求的 `Based on the video cover frame` 文案；现有图片和 legacy flag-off 客户端回归用例通过。

## Critical

无。

## Important

1. **客户端可以通过省略 mediaEvidenceMode 绕过服务端视频封面规则。** [route.ts:142](D:/vp-tmp/wt-video-pin-p0-task5/web/src/app/api/ai-copy/v2/analyze/route.ts:142)

   只有客户端传入 `mediaEvidenceMode === "video_cover"` 时才读取 owned draft；否则第 145–147 行继续采用客户端 `imageObserved`。因此字段并非注释声称的 hint，而是决定是否执行整个视频安全路径的开关。即使 draftId 指向无封面视频，省略该字段也能持久化自报的视觉事实，并缺失 `video_cover_unavailable` 和 cover 标签。只读内存探针调用真实 handler（认证/session/keyword 边界使用本地 mocks），提交 `draftId: "owned-video-without-poster"`、`imageObserved.summary: "The person dances and sings"`，不提交 mode：实际返回 HTTP 200、fact-card-v1、上述 image_observed 事实、`no_keyword_demand_data`，owned-cover loader 调用数为 **0**。

   修复方向：依据认证 owner 的持久化草稿确定 media kind，服务端对实际 video 强制走封面路径；客户端 hint 仅用于兼容或一致性检查。保留旧图片请求行为，同时加入 mode 缺失/伪造和视频无封面情况下不得接纳客户端视觉事实的测试。

2. **封面推断黑名单不能履行禁止运动/声音/材质/品牌/数量推断的约束，生成器也没有兜底。** [videoCoverEvidence.ts:37](D:/vp-tmp/wt-video-pin-p0-task5/web/src/lib/ai-copy/v2/videoCoverEvidence.ts:37)

   英文关键词黑名单只匹配少数词，不识别实际语义；第 106–110 行把漏过的任意字段都作为视觉证据。只读探针对真实 `analyzeOwnedVideoCover` 注入 provider 返回值后，`A person walks across the room while singing`、`Nike shoes`、`ceramic mug`、`steel bottle` 和 `Buy one get one free` 全部原样保留。默认 [visionServer.ts:648](D:/vp-tmp/wt-video-pin-p0-task5/web/src/lib/ai-copy/visionServer.ts:648) 还复用允许 visibly-obvious brand/material 的普通图片提示，而不是严格视频封面提示。

   该问题不止影响证据展示：真实 `buildPromptForSession` 将上述走动/唱歌描述列为 grounding fact，完全没有 cover-only 指令；真实 `validateCopy` 对包含同样动作/唱歌的 title/description/altText 返回 `{ "valid": true, "issues": [] }`。现有独立 detector 的类别只有 commercial claims，不能覆盖运动、声音、语音或时间序列。商业声明检测可阻止部分最终文案，但不能阻止错误事实被展示/持久化，也不能阻止非商业的动作/声音声明。

   修复方向：为封面提供严格的静态观察协议和验证边界，将禁止类别覆盖到观察、生成及修复阶段；验证失败应舍弃视觉证据或安全降级。不要仅追加几个英文黑名单词。加入未出现在实现词表中的同义表达、非英语、任意品牌/材质、拼写数量，以及生成/修复中动作和声音声明的反例测试。

3. **新安全测试替换了待证明的权限/下载/provider 边界，无法发现其被破坏。** [test-ai-copy-v2-video-cover.ts:23](D:/vp-tmp/wt-video-pin-p0-task5/web/scripts/test-ai-copy-v2-video-cover.ts:23)；[test-ai-copy-v2-routes.ts:223](D:/vp-tmp/wt-video-pin-p0-task5/web/scripts/test-ai-copy-v2-routes.ts:223)

   cross-owner 用例让 `resolveOwnedPoster` 直接返回 null，没有执行真实 canonical/path/provenance 校验。所有 helper 用例都替换三个默认依赖；route 用例则替换整个 `analyzeVideoCover`，并主动向 `providerInputs` 写入固定 `COVER_ONLY` 后断言它存在。这样不会覆盖真实 draft 查询、私有 handler 调用、owner 传递、字节边界或真实 provider 输入；删除这些默认实现中的安全校验，新测试仍没有观察点可失败。缺少真实 missing-poster、failed/unresolved provenance、下载失败/超限的贯穿用例；panel 只做源码字符串检查。实施报告中的 RED 只是模块不存在，也不是这些行为的失败证据。

   修复方向：mock DB/Storage/provider 的 I/O 边界，保留生产 selector、owner/provenance 校验、bounded handler 和 provider 拼装执行；断言准确的 owner/draft/path 调用、实际收到的 data URL、缺失/越权时零 provider 调用及安全响应。用独立临时副本或内存变异验证，移除 owner 校验、改发视频 URL、忽略上限时测试必须失败。不要修改被审查工作树执行 mutation。

## Minor

1. **新增测试不能在无 Supabase 环境变量的独立进程中启动。** [test-ai-copy-v2-video-cover.ts:2](D:/vp-tmp/wt-video-pin-p0-task5/web/scripts/test-ai-copy-v2-video-cover.ts:2)

   静态导入最终触发 `src/lib/supabase.ts` 的模块级客户端初始化。直接运行新脚本时实际报 `Error: supabaseUrl is required.`；其他 routes 测试在导入前设置了虚拟配置。设置 `NEXT_PUBLIC_SUPABASE_URL=https://test.invalid` 和虚拟 anon key 后新测试通过。建议测试自行设置虚拟配置后动态导入，或避免纯测试导入时初始化客户端，确保登记到 core 后可独立复现。

## 本次验证证据

全部在工作树 `web` 目录本地执行；使用现有缓存的 tsx CLI，未下载依赖。命令前缀为 `node C:/Users/44740/AppData/Local/npm-cache/_npx/fd45a72a545557e9/node_modules/tsx/dist/cli.mjs`。

- `scripts/test-ai-copy-v2-routes.ts`：43 passed，0 failed，退出 0。
- `scripts/test-ai-copy-v2-facts.ts`：全部通过，退出 0。
- `scripts/test-ai-copy-v2-ui.ts`：通过，包含图片 v2 和 legacy flag-off，退出 0。
- `scripts/test-ai-copy-v2-video-cover.ts`：无配置首次退出 1；提供上述虚拟配置后通过，退出 0。
- `scripts/check-test-registry.ts`：239 tracked，231 runnable，8 excluded with reason，退出 0。
- `node node_modules/typescript/bin/tsc --noEmit --incremental false`：完成，退出 0，无诊断。
- `git diff --check`：退出 0。
- 两个独立内存探针：确认 Important 1 的 mode omission 行为，以及 Important 2 的未过滤事实和 `valid:true` 输出；不调用网络、不写测试文件。

没有运行完整生产 build、浏览器 UI QA、全部 Web suite 或真实数据库测试；本报告不将已有自报结果当作这些检查的证明。未发现新增路径/token 返回，但上述 grounding 缺口和安全测试缺口已经足够阻断 Task 5 验收。
