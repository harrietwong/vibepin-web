# Phase D 任务书 —— 额度执行 / 逐账号移除 / Plan 多账号 / 批量选板

> **已完成(2026-08-07)**。四项落地提交:
> ① `f4ccaae` 额度执行 · ③ `8a0e39b` 逐账号移除 · ② `afad6a8` Plan 账号筛选+徽标 ·
> ④ `8847c03` 批量选板按目标 · 另 `b1ea143` 非 Pinterest 平台的移除守卫(硬化)。
> 门禁:tsc 0、i18n 2663×18、生产 build exit 0、registry 139/138/1。
> 详见文末「交付记录」。以下为原始任务书,保留作对照。

**分支**:`merge/failure-handling-0731`(worktree `C:/Users/44740/AppData/Local/Temp/wt-merge-0731`)
**基线**:`998cffa`(Phase C)
**零迁移**:Phase D **不新增任何 SQL 文件**。额度靠数行(`social_connections`)判定,不落 DB 约束。
谁想写 v60 就是走错了方向——停下来汇报。

前置世系(已完成,勿重做):
- Phase A `3862264`:Settings 收敛 + 4 态映射 `lib/social/accountUiState.ts`
- Phase B `41435b8`:v59 统一 social_connections + `connectDecision.ts` 身份三分支 + connection 粒度 CAS
- Phase C `998cffa`:每条 Pin 钉定 `targetConnectionId`/`targetAccountLabel`,纯函数在 `lib/studio/publishTarget.ts`

---

## 执行顺序与提交纪律(硬性)

**顺序 ① → ③ → ② → ④,每完成一项立刻 commit。**

前三期共出现 7 次执行代理上下文耗尽。逐项提交的意义:中途死掉时留下的是一个干净前缀,
而不是需要主对话逐文件盘点的现场。上下文吃紧时**先 commit 已完成项,再回报断点**,
不要试图一口气做完。

每项 commit 前必须本地跑 `npx tsc --noEmit`;四项全做完再跑完整门禁(见末尾)。

上下文纪律:用 `grep -n` 定位再读片段,**不要整读** `WeeklyPlanWorkspace.tsx`(3022 行)、
`StudioBoard.tsx`、`BatchEditDrawer.tsx` 这类大文件。

---

## ① 额度执行(Accounts per platform)

**目标**:`planEntitlements.ts` 里已存在但标注 "data only — not enforced" 的
`accountsPerPlatform`(free 1 / starter 1 / pro 2 / business 3)真正生效。这组数字
**定价页 FAQ 已对外承诺**,所以口径必须与 `pricingPlans.ts` 一致(现有
`scripts/test-plan-entitlements.ts` 已断言数字一致,它只断言数字、不断言注释文案,
因此可以放心更新注释)。

### 计数规则(不得自行发挥)
- 已用 = `listActiveConnections(uid).length`(`lib/server/pinterest/connectionStore.ts:318`)。
  **已断开的行不计数**——用户断开后必须能重新连接,否则额度变成单向棘轮。
- 上限 = `PLAN_ENTITLEMENTS[resolvePlan(uid)].accountsPerPlatform`;`null` = 不限。
- **两套 entitlements 不要合并**。`server/entitlements.ts` 负责 plan *解析*(安全关键:
  永不读 user_metadata)+ Shopify 店铺上限;`planEntitlements.ts` 负责每档数字。
  正确做法是**单向 import**:服务端校验从 `planEntitlements.ts` 取数字,解析仍走
  `resolvePlan`。不要把数字复制第二份。

### 两个执行点
**(a) 连接开始** —— `src/app/api/auth/pinterest/connect/route.ts` 的 **GET 和 POST 都要**
(GET 是导航入口,POST 是按钮实际调用的热路径,只堵一个等于没堵)。

> **`reconnect` 参数存在时一律放行。** 重连是修复已有行,不新增行;把重连也拦掉会让
> 达到上限的用户永远无法修复坏掉的连接。两个 handler 都已经解析了 `reconnectId`
> (`sanitizeReconnectId`),直接用。

**(b) OAuth 回调** —— `src/app/api/auth/pinterest/callback/route.ts`。开始时没超限、
授权途中被别的流程占掉名额是可能的,所以回调必须复查。

> **`decideConnect` 保持纯函数,不要把额度塞进去。** 在路由里、拿到 decision 之后判断:
> - `action === "create"` → 超限则拒写。
> - `action === "update" && revived === true`(复活一条已断开的行)→ **按计数规则这会让
>   活跃数 +1,所以同样拦截**。这是明确决策,不是疏漏,请在代码注释里写明理由。
> - `action === "update" && revived === false`(修复一条本来就活跃的行)→ 放行,活跃数不变。
> - `action === "reject"` → 维持现状。

### 拒绝形态
照抄 `account_mismatch` 的既有模式:**不写任何行** → 重定向 `?pinterest=limit_reached`
→ 面板显示横幅 + Upgrade CTA(文案取 PRD §9.2 / §18)。新增 i18n key 必须补齐 18 语言。

### 边界
- 并发两个 OAuth 流同时通过检查 → MVP 接受。**禁止**为此加 DB 唯一约束/CHECK
  (`server/entitlements.ts` 决策 3:上限住在 config,永不住在 DB 约束)。
- `connectedPlatforms` 本期**不执行**,超出范围。
- **QA 陷阱,必须写进你的完成报告**:`server/entitlements.ts` 的 `PRO_EMAIL_WHITELIST`
  把 `zhihuihuang321@gmail.com`(即用户本人)托底到 `pro` = 2 个账号。用户手工测试时
  **看不到 free 档的 1 个上限**,别让他误判成"门禁没生效"。

---

## ③ 逐账号移除(先修 Remove,再做前置检查)

**本期发现的真问题(主对话已核实)**:`src/app/api/pinterest/disconnect/route.ts` 调用的是
`disconnect(uid)` —— **不带 connectionId**。store 层从 Phase B 起就支持逐连接
(`connectionStore.ts:537` 的可选 `connectionId` 参数走 `.eq("id", …)`),但路由不收、
客户端不传。**结果:多账号下点任何一个账号的 Remove,会把该用户所有活跃连接一起断掉。**
这必须先修——在 Remove 还是"一键全断"的时候做排程前置检查毫无意义。

### 步骤
1. **路由收 connectionId**:`DELETE /api/pinterest/disconnect?connectionId=…`。
   **用 query 参数,不要用 DELETE body**(代理/fetch 实现会丢弃 DELETE body)。
   **参数缺省时保持现有全量行为**,老的 Settings 单账号断开路径零变化。
2. **客户端传 id**:`src/lib/pinterestClient.ts:535` 加可选参数。
   注意 `social/disconnect` 对 Pinterest 是转交给专用路由的,**实际调用链要 grep 追一遍**
   (`SocialAccountsPanel.tsx` → client),不要凭猜改。
3. **前置排程检查(MVP 只做 Keep / Cancel,Reassign 二期,PRD §11)**:
   Remove 前统计"钉定到该连接、且仍处于排程中"的 Pin 数,弹确认:
   - **Keep**:保留排程。发布时 Phase C 的 `retryBlockReason` 已经会给出
     `target_disconnected`,拦截已经做好了,这里不用再造。
   - **Cancel**:把这些 Pin 取消排程。
   - 数量为 0 时不要弹框,直接断开。

> **数据源要查两处,别猜**:排程状态主要在客户端 `lib/pinDraftStore.ts`,但被 promote 过的
> 草稿可能还在服务端队列里(见 `src/app/api/pin-drafts/promote.ts`、
> `src/app/api/cron/publish-due/publishDueLogic.ts`,以及测试 `test-pin-draft-promote`、
> `test-publish-due-claim`)。先读这两处确认真实存放位置,再决定统计口径,并把结论写进报告。

---

## ② Plan 账号筛选 + 卡片身份徽标

在**已存在**的筛选面板里加第二个 select,不要另造 UI:
`src/components/plan/WeeklyPlanWorkspace.tsx` 的 `weekly-plan-filters-panel`(约 2327-2348 行,
现在只有一个 category select,结构照抄即可,含 clear 按钮与计数 `· 1` 的联动)。

- 筛选依据 `draft.targetConnectionId`;**必须有一个"未指定目标"的独立分桶**——
  adopt-once 之前的老草稿没有 target,不能让它们从筛选结果里凭空消失。
- 卡片徽标直接用 Phase C 已有的 `targetAccountHandle(draft)`(`lib/studio/publishTarget.ts`),
  不要新写取值逻辑。
- **单连接零感知**:活跃连接 ≤1 时,筛选项和徽标**都不渲染**。这是 Phase C 不变量 4 的延续,
  写进验收标准。

---

## ④ 批量编辑:板选择器按目标连接

Phase C 记录在案的保留项。`BatchEditDrawer.tsx` 的板*选择器*目前仍列默认连接的板
(发布调用已按各 Pin 钉定目标走,所以不变量没破,只是选板 UI 不对)。

明确行为,**不要自创合并 UI**:
- 选中的 Pin 目标**全部相同** → 列该目标连接的板。
- 目标**混合** → 禁用板编辑,给一句提示(说明按账号分批操作)。
- 板缓存已按 connectionId 分键(`lib/pinterest/boardsCache.ts`),直接用,别绕过缓存。

---

## 测试与门禁

- 新增测试登记进 `web/scripts/test-registry.ts`(额度/移除 → CORE;Plan/批量 → PLAN 或 STUDIO)。
  **`check-test-registry` 只对 git-tracked 文件生效**,提交前看不到未登记问题——Phase A 在这里栽过。
- 建议新增:`test-account-quota`(计数规则/reconnect 放行/revived 计数/null 不限)、
  逐连接 disconnect 的参数契约。纯函数化优先,避免依赖真实 HTTP。
- 四项全部完成后跑全套并把**真实数字**写进报告:
  `npx tsc --noEmit` / `npm run validate:i18n` / `npm run build` / `npm test` / `npx tsx scripts/check-test-registry.ts`

## 禁止事项

不 push、不部署、不 apply 任何迁移、不新建迁移文件;不碰 `web/.env*`;
token/secret 永不进日志;不动工作区里其他会话的未跟踪草稿。

---

# 交付记录(2026-08-07)

## 实现与计划的差异

计划外增加的一项(**本轮排查中发现的真 bug**):
`/api/pinterest/disconnect` 路由一直调 `disconnect(uid)` 不传 connectionId,
而 store 层不带 id 时匹配该用户**全部活跃行**。单账号时不可见,
多账号下点任一账号的 Remove **会断掉全部账号**。③ 的第一步就是修它,
前置排程检查建立在这之上——Remove 还是"一键全断"时,前置检查没有意义。

各项的关键决策(实现时定的,不在原任务书里):

- ①:额度读取失败 **fail-open**——手里已经拿到 token 的授权,不能因为
  计费读取抖动而丢弃。并发两个 OAuth 流可能超额 1 个,MVP 接受(禁止加 DB 约束)。
- ③:Cancel 必须 **bump `payload.updatedAt`**。`mergeServerDrafts` 是按该字段
  last-write-wins,不 bump 的话浏览器副本仍显得更新,下次同步推回去重新武装
  `scheduled_at`——用户刚取消的 Pin 照样会发出去。这一条是查 `pinDraftStore.ts:866`
  确认的,不是推断。
- ③:排程真相在 **`pin_drafts.scheduled_at` 服务端表**,不在浏览器 store
  (cron 只扫表)。在本地数就会少数,在本地取消就会留下 cron 仍在发的行。
- ②:`effectiveTargetFilter` 中和"看不见却仍生效"的筛选——两个账号时设的筛选,
  删到只剩一个后 select 不再渲染(不变量 4),筛选就会既看不见又没法清除。
- ④:**未钉定 + 已钉定 = 混合**。未钉定的草稿发布时采用的是**默认**连接,
  未必是那个已钉定的账号;当成同一个就会给出错的板。

## 记录在案的保留项

- **非 Pinterest 平台的逐账号移除未实现**(`b1ea143` 让它显式失败而不是假成功)。
  账号行对任何 2+ 账号平台都渲染,但 handler 走的是 Pinterest 专用路由;
  FB/IG 走多账号时必须补各自分支。
- Reassign(移除时把 Pin 改指到另一账号)属二期,本轮只做 Keep / Cancel(PRD §11)。
- `connectedPlatforms` 额度仍未执行(本轮只做 `accountsPerPlatform`)。

## QA 注意

**用户本人测不出 free 档的 1 个上限**:`server/entitlements.ts` 的
`PRO_EMAIL_WHITELIST` 把 `zhihuihuang321@gmail.com` 托底到 `pro`(= 2 个账号)。
要验 free 档必须用白名单外的测试账号(且只在测试库 `snulmwprsahzqvdbyenc`)。

## 上线前置(未变)

`v57` + `v59` 迁移**仍未 apply**,Phase B 起的连接存储依赖它们;
Phase D 本身零迁移。不 push、不部署由用户指定的部署会话统一处理。
