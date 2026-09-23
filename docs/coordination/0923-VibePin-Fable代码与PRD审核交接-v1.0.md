# 0923 VibePin — Fable 代码与 PRD 审核交接 v1.0

> 生成时间：2026-09-23（America/New_York）  
> 目的：把当前 Preview、尚未部署的本地候选、未闭环外部事项、PRD 与设计证据集中交给下一位技术总监和 Fable 审核。  
> 本文是只读盘点，不授权 Production、真实付款、数据库迁移、社交平台发布或直接合并。

## 1. 当前可验证的 Preview 基线

- 稳定入口：https://vibepin-fb-preview.vercel.app
- 当前部署提交：`b3661877f0ca1d343b5eea1b18b81059e3115931`
- 分支：`codex/three-platform-plan-0922`
- 部署 ID：`dpl_9WKbJEGrt1d9kXeReZQnHMWsr4DM`
- Unique URL：https://web-2fr33oz21-harriets-projects-86e9e358.vercel.app
- Vercel 状态：Preview / Ready
- 当前干净部署工作区：`D:\vp-worktrees\deploy-three-platform-plan-b3661877`
- 部署回执：`D:\vp-tmp\coordination\receipts\THREE_PLATFORM_PLAN_PREVIEW_DEPLOYMENT_B3661877_20260922.md`
- 回执 SHA-256：`B63A224B398C2C0473F20E970CB9E284C81BD95937ADA26DE73A73039D580F4C`

当前 `/api/version` 已通过 Vercel 鉴权请求读回：

```text
buildSha=b3661877f0ca1d343b5eea1b18b81059e3115931
deploymentId=dpl_9WKbJEGrt1d9kXeReZQnHMWsr4DM
environment=preview
```

## 2. 当前 Preview 已经包含的主要工作

`8398388974ccdb855c83064d107b72819b81be24..b3661877` 的集成线修改约 490 个文件。以下不是“本地未部署”，而是已经进入当前 Preview 的主要能力：

1. 0901 Product Picker、Reference、Multichannel、Pricing/Auth 与 Create Pin 目的地真相合同。
2. Create Pin CP-13/CP-14 相关的持久化草稿同步、目的地显式状态、原子生成设置与恢复。
3. 私有媒体与出站媒体边界、URL 抓取安全、发布资产与发布意图账本。
4. Pinterest 图片/视频发布、视频封面、批量视频上传、恢复、定时与幂等安全线。
5. Public shell 的语言/主题、本地化 Pricing、Auth 回跳清洗、Product truth state。
6. 四套餐 Credit/Account quota 测试工具与 Preview 验收线。
7. Instagram Reels 持久化发布与 authenticated reconciliation。
8. Studio 卡片真相、媒体比例/alt text、发布证据、Weekly Plan 外部渠道展示。

因此，审核时不能从旧分支 SHA 是否直接位于 Preview 祖先链，简单推断“未部署”；大量 worker 提交已被修改后 cherry-pick 到集成线。

## 3. 本地主仓库状态：不可直接作为合并来源

- 主目录：`D:\代码\Pinterest flow`
- 当前分支：`feat/referral-credits-0904`
- 当前 HEAD：`b2d8f36ca8b0ed262d19c4f0a436e1863205e2f7`
- 已跟踪改动：147 项
- 未跟踪路径：5,346 项

该目录混有多轮历史任务、文档、截图、缓存和开发改动。下一位技术总监不得在此直接执行全量 commit、merge、clean 或 deploy。任何集成必须从 `b3661877` 新建干净 worktree，再按明确文件所有权导入。

主目录中尚未形成可部署候选的 tracked 代码主要分布为：`web/src/lib` 约 39 个文件、`web/src/components` 约 23 个文件、`web/src/app` 约 19 个文件，另有 backend crawler、systemd、测试脚本、i18n 与配置改动。它们来自多轮历史任务叠加，当前没有单一干净 HEAD、完整测试回执或明确所有权，不能统称为“待部署代码”。未跟踪内容则以选品原始数据、图片、生成/标注输出、UI 截图证据和临时 PRD 审查目录为主。

## 4. 尚未部署或仍需语义核对的代码

### 4.1 明确未进入当前 Preview patch-equivalence 的候选

1. `codex/cheerish-vertical-studio-fix-0920@d9f460b2c53336440af4119fc1c1a623ba1c5264`
   - 主题：Cheerish 全范围竖版视频规范化。
   - 仅涉及 `web/scripts/cheerish-video-schedule.ts`、对应 lib 与测试。
   - `git cherry b3661877` 显示 1 个正向 patch；不能自动部署，需与集成线现有 `1c25972a`、`9f97c098` 的调度/竖版修复做语义 diff。

2. `codex/feedback-media-placeholder-0917@566c123d802ffbbc4677015bae4e20628c51cf5a`
   - 主题：粉色/灰色兜底、legacy placeholder 识别、selected media fallback。
   - 有 5 个 patch 未被 Git 判定为 patch-equivalent。
   - 当前 Preview 已有修改后集成提交 `d6397dc5 fix media load lifecycle fallback`、`e1c52825`、`20c2b531` 等；必须做行为级 diff，不能直接重复 cherry-pick。

3. `codex/createpin-media-fallback-0916@e58a18b0c70f6c0b21f899574bc9f4e1ab53c94d`
   - 主题：拒绝可检测的 placeholder 媒体。
   - 1 个 patch 未被 Git 判定为 patch-equivalent。
   - 可能已被后续媒体真相和 QA 媒体过滤逻辑部分覆盖；需通过测试矩阵判断剩余缺口。

### 4.2 不得直接当作“未部署”的旧 worker 分支

以下分支存在非等价 SHA，但当前 Preview 已包含同主题的后续集成提交；它们只作为审查证据，不应整支合并：

- `codex/video-pin-p0-task4`
- `codex/video-pin-p0-task5`
- `codex/video-pin-p0-task7`
- `codex/video-pin-p0-0916-integrated`
- `codex/cheerish-ui-worker-0920`
- `codex/cheerish-publish-worker-0920`
- `codex/credit-account-quota-live-0918`
- `codex/studio-lifecycle-consistency-cd95`
- `codex/credit-e2e-live-0917`
- `codex/creem-preview-diagnosis-0917`
- `codex/feedback-product-truth-0917`
- `codex/feedback-public-shell-0917`
- `codex/feedback-auth-sanitizer-0917`

## 5. 仍未闭环的事项

### 5.1 外部配置或真实环境事项

1. Google OAuth：当前出现“应用未经 Google 验证”。本地代码和 Preview 未因 worktree 清理损坏；根因位于 Google Cloud OAuth consent/publishing/verification 或 Supabase Google provider 配置。需核对 scope、品牌/域名、测试用户、Google redirect URI 与 Supabase URL allowlist。
2. Creem Test：代码与防误付门禁已部署，但真实 Test Checkout 完成链仍需受控验收；禁止 Production/真实付款。
3. Supabase linter：`trend_opportunities_view` Security Definer 与 `tasks`、`user_settings`、`audit_log` RLS 告警仍需确认是否已在目标 test Supabase 安全应用；不得仅凭本地 migration 文件宣称完成。
4. Product Opportunities：前端 truth state 已部署；非空 catalog 依赖测试库数据供应，空数据库只能诚实显示空态。
5. Google/Meta/Pinterest 等第三方验证、OAuth App Review 与 Production provider 配置不属于本地代码部署完成度。

### 5.2 当前 Preview 仍需两轮人工验收的业务链

1. Failed 卡片重复 Edit、Posted/Failed 状态真相、Retry/Edit/目的地恢复。
2. 缺少发布目标时的轻量确认、缺失字段就地定位、账号/Board 必填字段前置。
3. Batch Edit 输入框辨识度、mixed account/Board 错误、Publish-to 账号选择。
4. Choose Pin References 按商品动态推荐、不同商品差异化、刷新和过期策略。
5. 仅商品图、不选 Reference 时的自动推荐/提示词生成，以及双图失败恢复。
6. Contact 成功态、Landing/Pricing 主题与语言一致性。
7. 四套餐额度显示、耗尽 toast/modal 与跨账号 quota 隔离。
8. 64 页面去“AI 模板味”、响应式、键盘、焦点、滚动和动效完整审查。
9. Studio/Plan/Publish/Pricing/Auth/Product 在 1440 与 390 两轮 USER 证据。

## 6. PRD 权威目录与版本

所有当前集中版 PRD 都放在：

```text
D:\代码\Pinterest flow\docs\prd
```

重要：这些近期 PRD 多数当前在主仓库中显示为 `??` 未跟踪，尚未进入可靠 Git 历史。Fable 审核前可以直接读取，但下一步应在干净 docs-only worktree 中做一次明确的文档快照提交；不要在脏主目录里全量提交。

### 6.1 总汇总与用户批注入口

1. `0905-VibePin-最近24小时PRD汇总-业务批注版-v1.0.docx`
2. `0905-VibePin-最近24小时PRD汇总-业务版-v1.0.md`
3. `0905-VibePin-最近24小时PRD汇总-Agent实施版-v1.0.md`
   - 文件名为 v1.0，但正文标题已经是 v1.1；审核时以正文与 SHA 为准。
4. `0905-VibePin-滚动验收反馈与修复PRD-v0.2.md`
5. `【待fable审核】0905-VibePin-统一Preview人工验收用例-v1.0.md`

### 6.2 0901 领域 PRD

1. `0901-VibePin-Create-Pin生产阻断补充PRD-v1.0.md`
2. `0901-Multichannel发布目标与OAuth补充PRD.md`
3. `0901-Reference创意智能补充PRD-v1.0.md`
4. `0901-VibePin-Product与Product-Picker补充PRD-v1.0.md`
5. `0901-收款定价与Auth补充PRD-v1.0.md`
6. `0901-统一Preview用户验收问题台账.md`

### 6.3 安全、Create Pin 与媒体

1. `0902-Supabase安全告警与RLS补充PRD-v1.0.md`
2. `0902-VibePin-CreatePin-业务PRD-v1.0.md`
3. `0902-VibePin-CreatePin-开发PRD-v1.0.md`
4. `0902-VibePin-统一验收与PRD汇总-v1.0.md`
5. `0903-VibePin-CreatePin-业务PRD-v2.0.md`
6. `0903-VibePin-CreatePin-开发PRD-v2.0.md`
7. `0903-VibePin-CreatePin-实施PRD-v1.0.md`
8. `0904-VibePin-媒体存储与URL抓取安全补充PRD-v1.0.md`

### 6.4 Credit / 邀请

1. `0904-邀请返积分-PRD-v1.0.md`
2. `0904-邀请返积分-PRD-v2.0.md`
3. `0904-邀请返积分-PRD-v3.0.md`

### 6.5 0918 新工作台、参考图库与当前验收

1. `0918-VibePin-Tailwind工作台交互改版与URL驱动AI-PRD-v2.0.md`
2. `0918-VibePin-参考图库标注与社媒图片生成全流程PRD-v1.0.md`
   - 文件名为 v1.0，正文标题已经是 v1.2。
3. `0918-VibePin-当前Preview人工验收用例-v1.0.md`

### 6.6 0921 待 Fable 审核

1. `【待fable审核】0921-VibePin-Studio改版业务版PRD-v1.0.md`
2. `【待fable审核】0921-VibePin-Pinterest统一发布队列与五次自动重试PRD-v1.0.md`

## 7. UI 设计系统、审计与证据

权威目录：`D:\代码\Pinterest flow\docs\design`

优先阅读：

1. `VIBEPIN_DESIGN_SYSTEM.md`
2. `VIBEPIN_UI_AUDIT_2026-09-06.md`
3. `AGENT_UI_CHECKLIST.md`
4. `SLICE_1_IMPLEMENTATION_PLAN.md`
5. `reviews\GPT6_PRODUCT_UX_REVIEW_2026-09-06.md`
6. `reviews\GPT6_ASTRA_CODE_REVIEW_2026-09-06.md`
7. `reviews\FABLE_UI_CODE_REVIEW_PROMPT_2026-09-06.md`
8. `evidence\ui-2026-09-06\` 下的 light/dark × 390/768/1024/1440 截图证据。

这些设计文件和截图目前同样多为 Git 未跟踪状态，必须先做 docs-only 快照，不得在主脏工作区误清理。

## 8. 验收与部署回执目录

完整回执目录：

```text
D:\vp-tmp\coordination\receipts
```

本轮重点：

1. `THREE_PLATFORM_PLAN_PREVIEW_DEPLOYMENT_B3661877_20260922.md`
2. `FOUR_PLAN_CREDIT_ACCEPTANCE_FFDD9B_20260918.md`
3. `UNIFIED_FEEDBACK_PREVIEW_DEPLOYMENT_E5DA2547_20260917.md`
4. `PINK_MEDIA_ROOT_CAUSE_20260917.md`
5. `PRODUCT_EMPTY_ROOT_CAUSE_20260917.md`
6. `ASTRA_FINAL_REVIEW_513753F7_20260917.md`
7. `ASTRA_FINAL_REVIEW_59FF703B_ADDENDUM_20260917.md`

回执是证据，不自动等于当前 `b3661877` 的完整 USER PASS；必须核对每份回执绑定的 SHA、部署 ID 与环境。

## 9. Fable 建议审核顺序

1. 冻结代码基线为 `b3661877`，禁止直接基于脏主目录审查。
2. 先审 `0921 Studio` 与 `0921 Pinterest统一发布队列` 两份待审 PRD，查冲突和未决策项。
3. 再审 `0918 工作台` 与 `0918 参考图库`，检查是否与 0905/0901 重复或相互矛盾。
4. 用 `0905 Agent实施版 v1.1` 作为缺陷总索引，逐条映射到当前代码、测试和回执。
5. 对 4.1 中三个非 patch-equivalent 候选做语义 diff；只导入当前基线确实缺失且测试可证明的最小补丁。
6. 单独审查 Google OAuth、Creem、Supabase RLS、Credit 原子性、Publish 幂等和媒体隐私，不允许只做 UI 结论。
7. 生成明确矩阵：`已部署且验证 / 已部署未 USER 验证 / 本地候选未部署 / 仅 PRD / 外部配置阻塞 / 不再需要`。
8. 修复后跑三轮代码门禁与两轮 USER 验收，再决定新的 Preview；不得直接 promote Production。

## 10. 给 Fable 的审查问题

1. `b3661877` 是否完整覆盖 0905 缺陷表中的 P0/P1，而不是只覆盖相同标题？
2. 三个非 patch-equivalent 候选中，哪些行为已经被集成线的后续实现取代？
3. 0921 两份 PRD 是否与现有 v76/v78/v80 发布账本、Pinterest/Instagram worker 和 Studio 卡片真相冲突？
4. 0918 参考图库方案的采集、标注、推荐、生成、质检和计费边界是否足够安全且可分期？
5. Google OAuth、Creem Test、RLS linter、Product catalog 和四套餐额度中，哪些必须在下一次 Preview 前完成？
6. 当前 64 页面 UI/响应式验收是否需要分 slice，而不是一次性大改？
7. 哪些 PRD 应合并为当前权威版本，哪些应明确标注历史/废弃？

## 11. 下一位技术总监的第一批安全动作

1. 从 `b3661877` 创建全新干净审核 worktree。
2. 在另一个 docs-only worktree 中将 `docs/prd`、`docs/design`、必要 `docs/coordination` 做一次精确快照提交，列出文件清单与 SHA-256。
3. 不复制主目录的 5,346 个未跟踪路径，不执行 `git add .`。
4. 对三个候选分支做文件级与行为级 diff，先写审查报告，再决定是否实现。
5. 用当前稳定 Preview 做只读人工验收，不进行真实付款、Production 发布、社交平台盲发或数据库写入。

