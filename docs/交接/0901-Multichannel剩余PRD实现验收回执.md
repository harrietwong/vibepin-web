# 0901 Multichannel 剩余 PRD 实现验收回执

## 边界

- 基线：`8398388974ccdb855c83064d107b72819b81be24`
- 分支：`codex/multichannel-prd-remaining-0901`
- worktree：`C:\vp-wt\multichannel-prd-remaining-0901`
- 权威 PRD：`C:\vp-wt\multichannel-oauth-prd-0901\docs\prd\0901-Multichannel发布目标与OAuth补充PRD.md`
- 本工作只修改代码、测试与本回执；未启动浏览器，未执行 OAuth、发布、部署、push/merge、环境文件写入、数据库写入/迁移或 Production 动作。

## 实现

1. 新增 canonical destination capability：Settings、Studio 单卡、Batch、Plan 共用 exact provider/connection/identity/capability/disabled-reason 语义。
2. destination intent 必须冻结 exact `socialConnectionId`；Pinterest 必须冻结 exact Board；移除 first/default/remembered Pinterest、账号和 Board fallback。
3. Batch Edit 使用共享 `PublishDestinations`，支持逐账号/Board 目标、mixed 状态、明确 Apply；显示三 provider exact 摘要，不再退化为 Pinterest 文本。
4. Plan 采用同一 exact account model；不加载默认账号或默认 Board；单账号只在用户明确勾选 provider 时冻结，未选择时 fail closed。
5. optional scheduling：Publish now 清除隐藏旧时间；scheduled 模式要求完整时间与 timezone；Batch 可明确清空日期和时间。
6. OAuth reconnect/callback：目标行消失或官方 identity 缺失时零写入 fail closed；callback 将精确 reason 回传 Settings。
7. 服务端 validation、immediate social publish、scheduled cron 全部在计量/job/provider 之前验证 exact owner-scoped destination；0 usable destination 不 dispatch。
8. 逐 destination 保留 provider/account、requested/accepted/publishing/published/failed/delivery_unknown、remote id/permalink、错误码与时间证据；`delivery_unknown` 锁住盲目 Retry，必须先 reconcile 原 job。
9. 同一 Content fan-out 仍只消费一个 scheduled-post idempotency key；未改变 Pricing/计量产品口径。

## 变更路径

### 新增

- `web/src/lib/social/destinationCapability.ts`
- `web/scripts/test-multichannel-prd-remaining.ts`
- `docs/交接/0901-Multichannel剩余PRD实现验收回执.md`

### 修改

- `web/src/components/social/PublishDestinations.tsx`
- `web/src/components/social/SocialAccountsPanel.tsx`
- `web/src/components/studio/BatchEditDrawer.tsx`
- `web/src/components/studio/StudioBoard.tsx`
- `web/src/components/plan/DraftDetailsDrawer.tsx`
- `web/src/app/app/studio/page.tsx`
- `web/src/app/api/publish/social/route.ts`
- `web/src/app/api/publish/destinations/validate/route.ts`
- `web/src/app/api/cron/publish-due/publishDueLogic.ts`
- `web/src/app/api/pin-drafts/promote.ts`
- `web/src/app/api/auth/facebook/callback/route.ts`
- `web/src/app/api/auth/instagram/callback/route.ts`
- `web/src/app/api/auth/pinterest/callback/route.ts`
- `web/src/lib/social/scheduledDestinations.ts`
- `web/src/lib/social/publishFanout.ts`
- `web/src/lib/social/publishRules.ts`
- `web/src/lib/social/socialClient.ts`
- `web/src/lib/social/accountActions.ts`
- `web/src/lib/studio/publishContent.ts`
- `web/src/lib/studio/publishResults.ts`
- `web/src/lib/contentDraftModel.ts`
- `web/src/lib/server/social/reconnectIdentity.ts`
- `web/src/lib/server/pinterest/connectDecision.ts`
- `web/src/lib/i18n/messages/en/studioModals.ts`
- `web/src/lib/i18n/messages/zh-CN.ts`
- `web/src/lib/i18n/messages/zh-TW.ts`
- `web/scripts/test-pinterest-callback-identity.ts`
- `web/scripts/test-publish-confirmation.ts`
- `web/scripts/test-publish-content.ts`
- `web/scripts/test-publish-due-claim.ts`
- `web/scripts/test-publish-fanout.ts`
- `web/scripts/test-publish-social-account-guard.ts`
- `web/scripts/test-registry.ts`
- `web/scripts/test-schedule-social-guard.ts`
- `web/scripts/test-scheduled-account-identity.ts`
- `web/scripts/test-scheduled-destinations.ts`
- `web/scripts/test-settings-account-actions.ts`
- `web/scripts/test-social-reconnect-identity.ts`

## 验证

### 聚焦矩阵

- 20 个脚本，覆盖 canonical capability、scheduled destinations/account identity、schedule guard、due claim、confirmation、publish content/fanout/results、OAuth reconnect/callback、Settings lifecycle、Batch/Plan UI contracts、entitlements、i18n、pin-draft sync。
- Round 1：全部通过；其中一次 PowerShell 输出汇总 OOM 后，`test-publish-content.ts` 单独真实重跑为 19/19。
- Round 2：20/20 脚本 exit 0。
- Round 3：20/20 脚本 exit 0。
- 最终变更后确认：20/20 脚本，685/685 assertions，39,909 ms，exit 0。
- `test-publish-social-account-guard.ts` 保留已登记 TEST DRIFT：18 passed / 2 failed / exit 1。两条旧断言仍要求旧的跨路由 key 源码形状与旧的零目标计量实现；不作为当前 runtime P1，也未通过修改测试/runtime 掩盖。

### Registry / ESLint

- `scripts/check-test-registry.ts`：3 轮 exit 0；226 tracked scripts，218 纳入 `npm test`，8 个有理由排除。
- 严格 scoped ESLint（新增与纯逻辑/route 变更路径，`--quiet`）：3 轮 exit 0。
- 全 changed-file ESLint：exit 1，14 errors / 45 warnings；代表性错误点（Studio effect、Plan render-time ref、PublishDestinations/SocialAccountsPanel effect、Batch document cursor）已只读核对在基线 `83983889` 中存在。未扩大范围修复基线 lint debt。

### TypeScript / webpack

- 首次 standalone typecheck：exit 2，发现 4 个本次类型错误；逐项修复。
- standalone typecheck retry：exit 0，117,639 ms。
- webpack 无环境 Round 1：编译和内置 TypeScript 通过；page-data 因未配置 `NEXT_PUBLIC_SUPABASE_URL` 被阻断，exit 1，记 ENV_BLOCKED，不记代码 FAIL。
- 未写 `.env`；仅为机械构建进程注入非秘密 placeholder Supabase URL/key。
- webpack PASS 1：exit 0，71/71 static pages，253,841 ms。
- webpack PASS 2：exit 0，71/71 static pages，203,312 ms。
- webpack PASS 3：exit 0，71/71 static pages，225,188 ms。
- 三次 webpack 内置 TypeScript 均 exit 0。

## 仍需外部门禁

1. 在集成后的 exact Preview 做桌面 1440x900 与移动 390x844 两轮 USER E2E：Settings、Studio 单卡、Batch、Plan exact identity/capability、TikTok 隐藏、无横向溢出。
2. 用户亲自完成 Pinterest/Instagram/Facebook OAuth/权限确认后，验证 callback 保存、刷新、过期、重连、断连两轮一致性；不得向代理提供密码、OTP、token 或 key。
3. 经独立动作授权后做受控 Preview 测试发布：逐 provider 核 target ID、Board/Page、HTTP、job/request、remote id/permalink、Content 计量 +1、partial success、失败退款与 delivery-unknown reconciliation；禁止盲重试。
4. 最终集成分支需同时包含 Create Pin 与 Multichannel PRD，跑通 MC-A30/CP-A31 双向 anchor/link 门禁。
5. 本提交不是 Production 放行；仍需 Sol 集成审查和 Claude Opus 独立审查。Opus 不可用时只能记 NO VERDICT。
