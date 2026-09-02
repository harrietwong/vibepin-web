# 0901 Multichannel 发布审计阻断 USER 验收用例

## 1. 验收边界

- 只在最终 clean HEAD 对应的隔离 Preview 与测试数据库执行；每轮先登记 source commit、deployment id、unique/stable URL、测试 Supabase ref 与 `v72` 应用证明。
- 桌面视口 `1440x900`、移动视口 `390x844` 各执行两轮。每轮记录起止登录态、完整点击路径、可见结果、console error、关键 HTTP method/path/status、intent/job/remote evidence 与时间戳。
- Pinterest、Instagram、Facebook 的 OAuth、Reconnect、Disconnect、Remove 不是本轮默认动作；如需要，必须停在授权按钮前，由用户亲自完成，并另记授权范围与 callback 保存证据。
- 真实测试发布不是默认动作。每一次最终 Confirm 前必须取得 action-time authorization，并展示 exact provider/account/Board/Page、完整文案、媒体、目标 URL、预期远端帖子与 `scheduled_post +1` 副作用。
- 禁止 Production、真实付款、Production 数据写入、环境变量修改、数据库迁移执行、自动重试未知交付、清理或删除用户要求保留的测试数据。

## 2. 前置身份与数据

| Provider | 必须核对的官方身份 | 发布子目标 |
|---|---|---|
| Pinterest | provider account id `804455689597649673`；页面实际 handle 必须现场记录 | 用户在动作边界明确选择的 exact Board ID/name；不得使用默认 Board |
| Instagram | provider account id `17841478940147145`；现场记录 handle/display name | 无默认替代账号 |
| Facebook | Page id `965649823305245`；Page `vibepin.co` | exact Page；不得回退到用户账号或其他 Page |

准备三类 Content：

1. 单图、三个 provider 都可发布的 Content。
2. 无 destination、旧 legacy `boardId/targetConnectionId` 仍有值的 Content。
3. 至少两张 destinations 不同的 Content，用于 Batch mixed/all/none。

所有 Content 必须使用测试媒体和测试文案，标题中带唯一时间戳；不得包含真实客户、订单、token、OTP 或其他敏感信息。

## 3. Round 1 / Round 2 只读与零副作用验收

### U-01 Settings Social canonical identity

1. 打开 `/app/settings/social`。
2. 桌面与移动分别核对 Pinterest、Instagram、Facebook 的图标、Connected/needs attention 状态、official identity、账号/Page id（UI 可脱敏但必须能与 canonical API 对上）。
3. 核对 TikTok 文本、图标、按钮和占位均不可见。
4. 刷新页面、关闭并重开 Settings，再核一次三 provider 身份。

预期：两次读取一致；页面只消费服务端 canonical connection；移动 modal/card/header/account/action 均 `scrollWidth <= clientWidth`，无页面或 modal 横向滚动。

### U-02 Studio 单卡 destinations 与确认页

1. 打开 `/app/studio`，选择已保存三个 exact destinations 的 Content。
2. 打开 Edit destinations，核对 provider、account、Pinterest Board、Facebook Page 与 Settings 完全一致。
3. 打开“立即发布”确认页，但不点击最终 Confirm。
4. 核对 Content title、media、description、destination URL、Publish now、三个 exact destination、disabled reason、Cancel 和带数量的 Confirm 按钮。
5. 分别用 Cancel、Escape、关闭按钮、backdrop/Back 退出；每种退出后重新打开。

预期：打开和所有退出路径都不修改 draft/destinations/schedule，不产生 publish job、usage consume 或 provider POST；焦点进入 dialog、Tab/Shift+Tab 被限制、关闭后恢复到触发按钮；390px 无横溢。

### U-03 禁止 legacy/default destination fallback

1. 打开“无 destination、但 legacy Board/account 字段仍有值”的 Content。
2. 从卡片菜单、单卡编辑、Plan 各尝试进入 Publish/Schedule 确认。

预期：显示 `no destinations`/Edit destinations 引导，最终按钮禁用；不得自动出现 Pinterest、首个账号、默认 Board/Page；Network 中 provider POST、job、usage 均为 0。

### U-04 stale capability 与 disabled reason

在不执行 OAuth lifecycle 的前提下，使用测试 fixture 或已存在的 expired/scope-missing/disconnected row：

1. Settings、单卡、Batch、Plan 分别打开同一 destination。
2. 记录四处 reason code/copy。

预期：`account_expired`、`permission_missing`、`needs_reconnect`、`not_connected`、`owner_mismatch`、`subdestination_required` 等原因与 canonical resolver 一致；不可用腿不 dispatch，不被替换为其他账号。

### U-05 Batch mixed 与批量确认

1. 选中至少两张 destinations 不同的 Content，打开 Batch Edit。
2. 核对 all/none/mixed 状态、三 provider 图标/身份/Board/Page/disabled reason。
3. 不保存直接 Cancel/关闭，核对零 mutation。
4. 再次打开，明确应用同一组 exact destinations；打开批量 Publish 确认。
5. 核对每张 Content 都有独立冻结的 title/media/destinations/receipt；使用 Escape 退出。

预期：Batch 不退化为 Pinterest 文本；每张卡独立 receipt，不复用或扩大另一张卡的 destination；Escape 为零 dispatch/usage/job。

### U-06 Plan optional schedule 与零 destination

1. 在 Plan 打开有 destination 的 Content；默认保持 Publish now。
2. 展开 Schedule，输入时间和 IANA timezone；切回 Publish now 或 Cancel。
3. 再次打开，确认隐藏旧时间已清空。
4. 对无 destination Content 尝试 Schedule。

预期：时间仅在明确选择 Schedule 后必填；Cancel/切回 now 清除 `scheduledAt/timezone`；0 destination 返回 `no_destinations`，draft write、quota check/usage record、provider job 均为 0。

## 4. 受控测试发布（需逐动作授权）

每一次最终 Confirm 前先生成 action-boundary receipt，至少写入：provider、exact account/Page id 与 display identity、Pinterest Board id/name、Content/draft id、完整文案、媒体 URL/哈希、destination URL、Publish now/Schedule、intent id、fingerprint、预期远端副作用、预期计量。

### U-07 三 provider 单腿测试

分别对 Pinterest、Instagram、Facebook 各执行一次：

1. 在确认页逐项对照 action-boundary receipt。
2. 用户明确 action-time authorization 后，只点击一次 Confirm；禁用双击。
3. 记录 provider request 前的 intent/job、HTTP method/path/status、provider response、remote id、permalink、destination result、console、完成时间。

预期：只发布到 receipt 中的 exact destination；2xx 不能单独算 PASS，必须有真实 remote id，平台支持 permalink 时链接必须指向相同官方身份；不得生成假的成功链接。

### U-08 三平台 fan-out 与 Content 计量

1. 使用一个新 Content，同时确认 Pinterest + Instagram + Facebook。
2. 发布前读取当前周期 `scheduled_post` usage。
3. 取得一次 action-time authorization 后确认一次。
4. 发布后核对三个 destination result/remote id/permalink 与 usage。

预期：三个远端帖子、一个 stable intent、逐 destination job/evidence；同一个 Content 不论三个渠道，净用量只 `+1 scheduled_post`，不得 `+3`。

### U-09 明确失败、partial success 与退款

只使用可控测试 fixture，不故意攻击真实账号：

1. 构造一个明确 provider 4xx 且无 remote object 的腿，以及一个成功腿。
2. 核对成功腿保留 published/remote id，失败腿记录 provider status/reason 且允许同 intent 受控恢复。
3. 核对全失败且均明确未发送/被拒时，fresh consume 被释放，净 usage `0`；partial success 时净 usage 保持 `+1`。

预期：成功腿永不重发；失败恢复不创建新 intent、不重复计量。

### U-10 ambiguous timeout 与 reconcile

仅用可控故障注入，不中断真实 provider 请求：

1. 令测试 provider adapter 返回无 remote id 的 timeout/5xx ambiguous 结果。
2. 核对 UI 显示 delivery unknown，并锁定再次 Submit。
3. 调用 `GET /api/publish/reconcile?intentId=<original>`，记录 owner-scoped destination status/evidence。

预期：unknown 不退款、不自动重试、不创建新 intent；只有 reconcile 明确为 failed 且无远端对象后，才允许同 intent 的受控恢复。

### U-11 owner isolation

1. 用测试 owner A 创建 intent/evidence。
2. 用测试 owner B 查询同一 intent id。

预期：B 得到 404/owner-scoped empty，不得看到 A 的 fingerprint、destination、remote id/permalink 或 evidence；A 可读取自己的完整结果。

## 5. 每轮必存证据

- exact branch/HEAD、Preview deployment/URL、test DB ref、v72 migration applied proof。
- 桌面/移动截图与 overflow 数值；起止 auth 状态；点击路径。
- console error/warning；关键 HTTP method/path/status（Authorization、cookie、token 必须脱敏）。
- confirmation receipt：intent id、SHA-256 fingerprint、source revision、destination ids、confirmedAt。
- durable ledger：intent job id、per-destination job id/status/attempt/retryAllowed、provider status、remote id/permalink、evidence。
- usage before/after/net、fresh/replayed/released 口径。
- 任何外部副作用及保留数据；未获 action-time authorization 的真实发布必须写 `NOT_RUN`，不得写 PASS。

## 6. 判定

- `BLOCKED_DB_MIGRATION`：最终测试数据库未应用 v72 时，provider routes 必须 503 fail closed；这证明保护生效，但不能把发布链判 PASS。
- `USER_E2E_BLOCKED`：无 Preview、登录、provider test identity、action-time authorization 或浏览器控制时，明确停在哪一步和所需条件。
- `FAIL`：出现默认 destination、未经确认 dispatch、Cancel/Escape 后 mutation/job/usage、unknown 自动重试、跨 owner 泄露、Content fan-out 多扣量或假的 remote success。
- `PASS`：必须在同一最终 Preview 完成两轮只读/零副作用验收；涉及真实发布的用例只有在逐动作授权并取得 remote/usage/reconcile 全链证据后才能单独 PASS。
