# Instagram 评论关键词自动私信 — cron 与上线配置

`/api/cron/instagram-comment-dm`：有人在（站长自己的）Instagram 帖子下评论了规则里的关键词，
就用 Meta 的 **Private Reply** 给评论者发一条私信；可选再在评论下公开回复一句。

> **本文件只给出配置，不代表已执行。** crontab 由部署会话在用户批准后添加；
> 非部署会话不 ssh VPS、不改 crontab、不跑任何 `vercel` 命令。

## 范围（Phase 1）

- 只服务站长自己的 Instagram 账号；管理入口是超管后台 `/admin/instagram-auto-dm`，
  **不对客户开放**，客户 Settings 不出现任何入口。
- 后台 API 全部按当前超管自己的 `user_id` 过滤，看不到也改不了别人的连接/规则。
- **扫描范围限制**：「全部帖子」规则只扫描**最近 30 天内、最新的 50 条帖子**；更老帖子下的评论
  **不会被处理**，除非为那条帖子单独建一条指定帖子的规则（指定帖子的规则总会被扫描）。
- **省配额**：「全部帖子」扫描会跳过 Meta 报告 `comments_count = 0` 的帖子（字段缺失或不是数字时照常扫描，
  避免误跳过）。原因：每 5 分钟 × 最多 50 条帖子 × 至少 1 次请求 ≈ 每小时 600+ 次调用，
  Instagram Login 的限流（BUC）与账号曝光量挂钩，小账号容易触顶。

## 为什么是轮询而不是 webhook

评论 webhook（`comments` 字段）需要 **Advanced Access（App Review）+ App 处于 Live**，
目前都没有。所以 Phase 1 由 VPS crontab 每 5 分钟轮询一次。
等 App Review 通过后再考虑 webhook（届时轮询可以保留为兜底）。

## Meta 规则（决定了实现）

| 规则 | 实现 |
|---|---|
| Meta 文档称每条评论只能收到**一次** private reply（重复发送时 Meta 实际返回的错误码**尚未验证**，Phase 0 核实） | 我们自己的保证：事件表 `UNIQUE(connection_id, comment_id)`；先抢占（insert … on conflict do nothing）再发，抢不到就不发。**不依赖 Meta 拒绝第二次发送** |
| 必须在评论后 **7 天内** 发 | 只处理 7 天减 1 小时安全余量内的评论 |
| 私信进对方 Inbox（已关注）或 Request 文件夹（未关注） | 无需处理 |
| 私信会附带被评论帖子的链接 | Meta 自动加 |

## 前置：v83 迁移

`backend/db/migrate_v83_instagram_comment_dm.sql`（纯新增 + 幂等：两张表 + 索引，RLS 开启、无 policy，只有 service role 可读写）。

- 测试库 `snulmwprsahzqvdbyenc`：已 apply（2026-09-24）。**内部站 preview.vibepin.co 用的就是这个库，所以 Phase 1 不需要再 apply。**
- 生产库 `jaxteelkecvlozdrdoog`：**不 apply**。用户已定 IG 功能只上内部站，对外站 vibepin.co 不上 IG（2026-09-25）。以后若对外上线，再由部署会话按标准跑法 apply（需用户批准）。

未 apply 时端点返回 `{"ok":true,"available":false}` + 200，不会让 crontab 报警，但什么也不做。

## 环境变量

**无新增。** 复用 `CRON_SECRET`（与 `/api/cron/publish-due`、`/api/cron/expire-reservations` 同一个）。
Instagram 相关沿用已有的 `INSTAGRAM_APP_ID` / `INSTAGRAM_APP_SECRET` / `INSTAGRAM_REDIRECT_URI` /
`INSTAGRAM_TOKEN_ENC_KEY`。超管身份沿用 `SUPER_ADMIN_EMAILS` / `app_metadata.role`。

未配置 `CRON_SECRET` 时端点返回 **503 `cron_not_configured`**（绝不裸奔）。

## crontab 行（内部站；部署会话在用户批准后添加）

```cron
# 内部站：每 5 分钟轮询 IG 评论并发送关键词私信。写法（域名与密钥的取法）照抄内部站 publish-due 那一条。
*/5 * * * * curl -fsS -m 70 -H "Authorization: Bearer $CRON_SECRET" https://preview.vibepin.co/api/cron/instagram-comment-dm >> /var/log/vibepin-ig-comment-dm.log 2>&1
```

- 路由 `maxDuration = 60`，内部 **25 秒**后停止开始任何新工作（扫描帖子、翻评论页、抢占、发送都检查）。
  每个 Graph 请求 15 秒超时，所以 24.9 秒开始的一次私信（≤15s）+ 公开回复（≤15s）+ 写库仍能在 60 秒内结束，
  避免"私信已发但函数被杀、行没更新成 sent → 15 分钟后重试"。curl 超时给 70 秒。
- 每个连接每次最多尝试 40 条私信；多出来的下一轮继续。
- 多个调用方/重叠调用安全：唯一约束保证同一评论最多被抢占一次（测试库实测：5 轮 × 8 路并发抢占，每轮恰好 1 个成功）。
- 手动看"会发给谁"而不真发：`GET /api/cron/instagram-comment-dm?dryRun=1`（同样要 Bearer）。
  不抢占、不发送、不写库，返回 would-send 列表。

返回体里每个连接的 `outcome`：

| outcome | 含义 | 处理 |
|---|---|---|
| `ok` | 正常 | — |
| `missing_scopes` | 该连接没授予 `instagram_business_manage_comments`（运行只要求这一项；`manage_messages` 仍会申请但不作硬性要求） | 后台页点"重新连接并授予评论 + 私信权限" |
| `no_token` | 连接已断开/过期 | 重新连接 |
| `token_invalid` | Meta 返回 OAuthException 190 | 重新连接；已抢占的行保持 `claimed`，重连后自动重试 |
| `rate_limited` | Meta 限流（code 4/17/32/613 或 HTTP 429） | 本轮停止该连接，下一轮自动继续 |
| `deadline` / `send_cap` | 时间预算 / 条数上限用完 | 下一轮继续 |
| `circuit_open` | 同一连接本轮**连续 3 次**终止性 4xx（多半是账号级问题，如没开「允许访问消息」） | 本轮停止该连接，不再消耗其它评论；`last_run_error` 里有 Meta 原始报错。修好设置后在后台点「重试失败项」 |
| `error` | 读库/写库等内部错误（任何一次事件行写入失败都会停止该连接；私信已发但没记上的不计入 sent） | 看日志 `[instagram-comment-dm]` |

`claimed` 超过 15 分钟未更新的行会被下一轮重新接管重试。行只有在"发送结果没能记上"（进程被杀/写库失败）
或可重试错误时才停在 `claimed`；25 秒预算 + 写库检查把这个窗口压到很小，但**重试是否会被 Meta 拒绝为重复发送尚未验证**（见 Phase 0）。

- `attempts` 只统计**暂时性失败**（5xx / 网络 / `is_transient`），满 5 次记为 `failed`。
  停止类错误（token 190、限流 4/17/32/613/429）和重新接管**都不计数**。
- 其它 4xx 直接 `failed`，`last_error` 保存 Meta 原始报错（截断约 500 字）。
- 公开回复只在私信成功后才发，它失败不会改变私信状态（记在 `public_reply_status`）。
- 后台「重试失败项」：把**该账号**、评论仍在 7 天（减 1 小时）窗口内的 `failed` 行改回 `claimed`
  （attempts 归零、updated_at 设为很早的时间），下一轮 cron 的接管步骤会重试。
- **规则全部停用时**：该账号遗留的 `claimed` 行不会被处理（只有有启用规则的连接才会跑）；
  7 天内重新启用任一规则后会被重新接管。若对应规则已被删除/停用，接管时记为 `skipped`。

## Meta 后台配置

1. App Dashboard → Use cases → **Instagram API（Instagram 登录）** → Permissions，添加：
   - `instagram_business_manage_comments`（Meta Private Replies 文档列出的必需权限，与 `instagram_business_basic` 一起）
   - `instagram_business_manage_messages`（按裁决一并申请；Meta 文档未把它列为 private reply 的必需项，**是否必需未验证**）
2. App 未 Live / 未过 App Review 时，只有 **App 角色账号**（管理员/开发者/测试者）能授权这些权限：
   站长的 Instagram 账号必须在 App Roles 里（Instagram Testers 需在 Instagram 端接受邀请）。
3. 在 Instagram App 里打开：**设置 → 消息和快拍回复 → 消息控制 → 已连接的工具 →「允许访问消息」(Allow access to messages)**。
   不开的话私信接口会被拒。

## 授权流程说明

- 普通 connect（客户走的）**完全不变**，只申请 `instagram_business_basic` + `instagram_business_content_publish`。
- 只有超管访问 `/api/auth/instagram/connect?features=comment_dm` 时才追加上面两个权限；
  非超管带这个参数会被静默忽略。
- 授权完成后会回到 **设置 → 社交账号**（`/app/settings/social`，回跳路径白名单只允许 `/app/*`），
  请再手动打开 `/admin/instagram-auto-dm`。后台按钮会带上 `reconnect=<连接 id>`，所以账号数到上限也不会被拒。
- 授予的权限以 Meta token 交换返回的 `permissions` 为准写入 `social_connections.scopes`；
  若 Meta 未返回 `permissions`，回退值只含基础两项，后台会显示"未授予"——此时再重连一次即可。

## Phase 0 试运行（上线前必做）

在真实启用规则前，用站长自己的账号做一次小规模验证，并把结果记下来：

1. **分页假设**：找一条评论数 > 50 的帖子，建一条只针对它的规则（停用状态），点「预览匹配」，
   确认**最新**的评论出现在结果里（验证 Meta 按新到旧返回、我们只翻前几页的假设）。
2. **单次私信**：用第二个 Instagram 账号在自己的帖子下评论关键词 → 启用规则 → 等一轮 cron（≤5 分钟），
   确认第二个账号**恰好收到一条**私信，后台记录为 `sent`。
3. **重复发送错误码**：若日志/后台出现对同一评论的第二次 private reply 被 Meta 拒绝，
   记录 Meta 返回的 `code` / `error_subcode` / message，回填到本文档和 `commentDmLogic.ts` 的分类说明里
   （目前该错误码**未验证**，代码不依赖它）。

## 上线顺序

1. 部署会话：合并进内部站下一版 → 门禁 → 部署到内部站 preview.vibepin.co（按项目部署纪律）。
2. v83：内部站用测试库，已 apply，无需操作（生产库不 apply，见上文）。
3. 部署会话：按上面添加**内部站** crontab 行（需用户批准）。不要加到生产 runner。
4. 站长：Meta 后台加两个权限 + Instagram App 打开「允许访问消息」。
5. 站长：后台 `/admin/instagram-auto-dm` → **重新连接并授予评论 + 私信权限**（即 `features=comment_dm`）→ 回到后台确认显示"已授予"。
6. 站长：先做上面的 **Phase 0 试运行**（三项全部记录）。
7. 站长：新建规则（默认停用，开始时间默认 7 天前）→ **预览匹配**（只看不发）→ 确认名单无误。
8. 站长：启用规则。下一轮 cron（≤5 分钟）开始真实发送；后台"最近记录"看 `sent` / `failed` 与报错。

回滚：在后台停用规则即可立即停止发送（无需改代码或 crontab）。
