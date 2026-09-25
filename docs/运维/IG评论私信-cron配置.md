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
| 每条评论只能私信 **一次** | 事件表 `UNIQUE(connection_id, comment_id)`；先抢占（insert … on conflict do nothing）再发，抢不到就不发 |
| 必须在评论后 **7 天内** 发 | 只处理 7 天减 1 小时安全余量内的评论 |
| 私信进对方 Inbox（已关注）或 Request 文件夹（未关注） | 无需处理 |
| 私信会附带被评论帖子的链接 | Meta 自动加 |

## 前置：v83 迁移

`backend/db/migrate_v83_instagram_comment_dm.sql`（纯新增 + 幂等：两张表 + 索引，RLS 开启、无 policy，只有 service role 可读写）。

- 测试库 `snulmwprsahzqvdbyenc`：已 apply（2026-09-24）。
- **生产库：未 apply**。上线前由部署会话按标准跑法 apply（需用户批准；apply 前打印并核对 project ref）。

未 apply 时端点返回 `{"ok":true,"available":false}` + 200，不会让 crontab 报警，但什么也不做。

## 环境变量

**无新增。** 复用 `CRON_SECRET`（与 `/api/cron/publish-due`、`/api/cron/expire-reservations` 同一个）。
Instagram 相关沿用已有的 `INSTAGRAM_APP_ID` / `INSTAGRAM_APP_SECRET` / `INSTAGRAM_REDIRECT_URI` /
`INSTAGRAM_TOKEN_ENC_KEY`。超管身份沿用 `SUPER_ADMIN_EMAILS` / `app_metadata.role`。

未配置 `CRON_SECRET` 时端点返回 **503 `cron_not_configured`**（绝不裸奔）。

## crontab 行（部署会话在用户批准后添加）

```cron
# 每 5 分钟轮询 IG 评论并发送关键词私信。与 publish-due 共用 CRON_SECRET。
*/5 * * * * curl -fsS -m 70 -H "Authorization: Bearer $CRON_SECRET" https://<prod-domain>/api/cron/instagram-comment-dm >> /var/log/vibepin-ig-comment-dm.log 2>&1
```

- 路由 `maxDuration = 60`，内部 45 秒后停止开始新工作（干净退出），所以 curl 超时给 70 秒。
- 每个连接每次最多尝试 40 条私信；多出来的下一轮继续。
- 多个调用方/重叠调用安全：唯一约束保证同一评论最多发一次。
- 手动看"会发给谁"而不真发：`GET /api/cron/instagram-comment-dm?dryRun=1`（同样要 Bearer）。
  不抢占、不发送、不写库，返回 would-send 列表。

返回体里每个连接的 `outcome`：

| outcome | 含义 | 处理 |
|---|---|---|
| `ok` | 正常 | — |
| `missing_scopes` | 该连接没授予评论/私信权限 | 后台页点"重新连接并授予评论 + 私信权限" |
| `no_token` | 连接已断开/过期 | 重新连接 |
| `token_invalid` | Meta 返回 OAuthException 190 | 重新连接；已抢占的行保持 `claimed`，重连后自动重试 |
| `rate_limited` | Meta 限流（code 4/17/32/613 或 HTTP 429） | 本轮停止该连接，下一轮自动继续 |
| `deadline` / `send_cap` | 时间预算 / 条数上限用完 | 下一轮继续 |
| `error` | 读库等内部错误 | 看日志 |

`claimed` 超过 15 分钟未更新的行会被下一轮重新接管重试（Meta 同一评论只接受一次私信，所以重试不会重复发）；
可重试错误（5xx/网络/限流）最多尝试 5 次后记为 `failed`。其它 4xx 直接 `failed`，`last_error` 保存 Meta 原始报错（截断约 500 字）。
公开回复只在私信成功后才发，它失败不会改变私信状态（记在 `public_reply_status`）。

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

## 上线顺序

1. 部署会话：合并分支 → 门禁 → 部署（按项目部署纪律）。
2. 部署会话：生产 apply v83（需用户批准）。
3. 部署会话：按上面添加 crontab 行（需用户批准）。
4. 站长：Meta 后台加两个权限 + Instagram App 打开「允许访问消息」。
5. 站长：后台 `/admin/instagram-auto-dm` → **重新连接并授予评论 + 私信权限**（即 `features=comment_dm`）→ 回到后台确认显示"已授予"。
6. 站长：新建规则（默认停用，开始时间默认 7 天前）→ **预览匹配**（只看不发）→ 确认名单无误。
7. 站长：启用规则。下一轮 cron（≤5 分钟）开始真实发送；后台"最近记录"看 `sent` / `failed` 与报错。

回滚：在后台停用规则即可立即停止发送（无需改代码或 crontab）。
