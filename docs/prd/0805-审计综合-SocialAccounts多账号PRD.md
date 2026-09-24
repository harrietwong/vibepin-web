# 审计综合:Social Accounts 与多 Pinterest Account PRD(§21 前置审计)

> 2026-08-05 · Fable 终审 · 两路只读审计(UI 面 / 数据模型)交叉验证,四个承重结论已由主对话独立抽验
> 结论:**PRD 方向可行,但"多账号"是数据模型级改造而非 Settings 改版;必须分四期,且第一期就能交付 PRD 一半的验收标准。**

---

## 一、审计要点(§21 的 19 问浓缩为 8 个事实)

1. **一 user 一 Pinterest 是物理约束,不是习惯**。`pinterest_connections` 唯一索引建在 `vibepin_user_id` 单列(`api/migrations/001:34`),加上 `maybeSingle()`、`upsert(onConflict: vibepin_user_id)`、uid 键进程缓存——四层写死。多账号 = 改表 + 改 8 个 store 函数签名 + 波及 18 文件/10 条路由。

2. **两套连接模型并存,Pinterest 已经"劈成两半"**:token 在私有表 `pinterest_connections`,default board 却存在 `social_connections` 里 provider='pinterest' 行的 metadata——统一进 social 模型是必然方向,PRD 判断正确。

3. **PinDraft 零账号字段**。发布目标只有 `boardId/boardName` 两个裸字符串;`SocialPostRef` 也只有 provider 无 connectionId。板写入点 9 处。存量回填唯一可行语义:绑到该用户现存唯一连接。

4. **Reconnect 今天就是 PRD §10 明令禁止的样子**:callback 无任何身份比对,覆盖时把 `pinterestUserId/Username/AccountType` 显式清 null(`callback/route.ts:167-176`)——用 B 账号重连会**静默吞掉 A 的连接**,连"变了"都检测不到。这是审计发现的最高优先级行为缺陷。

5. **cron/重试全部按 uid 隐式取号**,且存在一个 user 级共享 default board(任意一次编辑 Pin 都会覆盖它,`DraftDetailsDrawer` 三处写)。PRD"固定目标"的要求在当前签名下无参数可传。

6. **额度:数字全齐、执行为零**。`planEntitlements.accountsPerPlatform`(1/1/2/3)注释明写 "not enforced";定价 FAQ **已对外承诺**这组数字。token CAS(v49)锁粒度是 uid,多账号必须改成 connection 粒度。

7. **workspace/成员/角色完全空白**:无表、无角色,`workspace_id` 是恒 NULL 孤儿列。PRD 里"Owner/Admin 设置默认账号""团队成员可用性"没有任何承载点。

8. **UI 面的意外发现**:
   - `/api/pinterest/debug-status` **完全无 gate**(裸端点,任意登录用户可拉诊断);
   - DraftDetailsDrawer 的 SANDBOX 徽章 / "Environment:" 明文 / Trial 提示**在生产对客户无条件显示**——PRD §10.2 要藏的东西一部分今天就在漏;
   - Settings 侧栏 Pinterest 与 Social accounts **两个 tab 并存**,且 Settings 默认落地页是 Pinterest,OAuth 默认回跳指向它(5 处引用 + 1 处裸字符串);
   - Settings 的 Board UI 是 localStorage 孤岛,**可安全删除**(发布链依赖的是另一套服务端 default-board);唯一副作用:Board rotation 失去编辑入口(Smart Schedule 仍读已存配置);
   - 状态今天是 3 态 + 5 态 + 第三套简化文案三套并行,`limited_access` 一态两义,最坏同屏叠 5 层状态。

---

## 二、分期方案(Fable 建议)

### Phase A:Settings 收敛 + 状态归一(零迁移,先交付一半验收标准)
- Social accounts 进 `SETTINGS_NAV` 成默认页;删 Pinterest tab;`/app/settings/pinterest` 保留为重定向(OAuth 历史回跳不 404)
- 状态归一 4 态:拆 `limited_access` 双语义(缺 scope→Needs reconnect,同步失败/暂时异常→Needs attention);三套文案源收敛到一处映射
- 移除 Developer tools;**顺手安全修**:debug-status API 收权(super_admin)或删除
- 移除 DraftDetailsDrawer 的 Sandbox/Environment/Trial 客户可见诊断(审计发现,PRD §10.2 精神内)
- Board UI 撤出 Settings(已证实安全)
- 覆盖验收标准 1-9 中的 8 条

### Phase B:连接模型统一 + Reconnect 身份校验(v59 迁移)
- Pinterest 迁入 `social_connections`:加 `unique(user_id, provider, provider_account_id)` + `token_version` 列;CAS 与刷新合并锁改 connection 粒度
- callback 增加"取回授权账号身份→比对→重复检测"(§9.2/§10);**不同账号重连时给 PRD 的双选项弹窗,禁止覆盖**
- 8 个 store 函数签名 connectionId 化,10 条路由跟进
- 迁移落 `backend/db/`(标准 runner),弃用 `api/migrations/` 旧路径;**查号 v59**(v50-52 历史空洞不回填;注意 v42 已撞号、v53-56 被未跟踪草稿占用)

### Phase C:Pin 固定目标 + Publish destination(§13/§14/§17)
- PinDraft/payload 加 `targetConnectionId`(+快照);9 个 board 写入点补账号;存量回填绑现存唯一连接
- cron/重试/批量链路带账号;user 级共享 default board 改为 per-connection(迁入各行 metadata 后自然解决)
- Publish destination 组件:先账号后 Board,切账号清 Board

### Phase D:额度执行 + Plan filter + Remove 流程(§11/§16/§18)
- 额度:**直接计数 social_connections 行 vs entitlements**,不走 usage_events 计量(账号数是状态不是事件;免改 v57 CHECK);统一两套 entitlements 文件口径
- Plan Account filter + 卡片账号身份(**必须在补合并后的集成分支形态上做**——Plan 已并入 Create Pins)
- Remove:MVP 只做 Keep / Cancel scheduled Pins,**Reassign 二期**

---

## 三、待用户裁决(实施前必须定)

| # | 裁决点 | Fable 建议 |
|---|---|---|
| 1 | 实施基线 | 先补合并集成分支(prod-transition 新 12 提交)+ 重跑门禁,All work 落在集成分支上 |
| 2 | §14 收紧(排程前强制选 Account+Board) | **不收紧**:维持"排程可先行、发布前强制",只加 Account 维度;否则 Smart Schedule 批量体验大幅回退 |
| 3 | 团队角色 | 审计证实完全空白 → MVP 降级为单用户退化态(Owner=当前用户),角色/审计日志只留字段与接口形状 |
| 4 | Board rotation 编辑入口 | 随 Board UI 一起删,已存 rotation 继续生效,"搬去哪"另开小票 |
| 5 | Remove 的 Reassign | 二期;MVP 只做 Keep / Cancel |
| 6 | debug-status 裸端点 | Phase A 顺手收权,不另立项 |

## 四、明确不做(本 PRD 范围外,审计中确认)
- workspace 多成员/邀请/角色系统(裁决 3 的另一半)
- Website verification / Catalog / Pinterest Tag(PRD 自己排除)
- 跨设备失败一致性(P2,另一条线)
