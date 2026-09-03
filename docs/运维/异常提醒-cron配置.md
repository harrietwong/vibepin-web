# 后台异常提醒 — VPS cron 配置

被卡住的客户由 `/api/cron/admin-alerts` 端点检测并发邮件通知。判定逻辑复用驾驶舱既有的
`getActionCenter()`(**不是另写一套**),所以邮件内容与 `/admin/today` 页面永远一致。

依据 PRD:`docs/prd/后台异常提醒与功能评价体系-PRD-v0.1-20260902.md`

## 前置:无迁移

本端点是**纯只读派生 + 写审计行**,不依赖任何新表。去重记录写入 `admin_audit_events`
(v34,**已应用生产**),只新增两种 `action` 值:`alert.blocker_notified` / `alert.blocker_cleared`。

`admin_audit_events` 不存在时端点优雅降级(`available:false`),**不 500**,但也不会去重
——降级方向是"可能重复通知"而非"静默漏发"。

## 环境变量

### 1. `CRON_SECRET`(必需)

与 `publish-due` / `expire-reservations` **共用同一个密钥**,两处配置:

1. **Vercel 环境变量**:`CRON_SECRET`,勾选 Production。改动后需重新部署才生效。
   - 未配置时端点返回 **503 `cron_not_configured`** 并打日志(安全默认:绝不裸奔)。
   - 密钥不匹配返回 **401 `unauthorized`**。
2. **VPS 环境**:在跑 crontab 的用户下导出同一个值(见下)。

### 2. 告警收件人(二选一,按优先级)

| 变量 | 说明 |
|---|---|
| `ALERT_EMAIL_TO` | **推荐**。告警专用收件地址,与后台管理员名单解耦 |
| `SUPER_ADMIN_EMAILS` | 回退。未配 `ALERT_EMAIL_TO` 时取**第一个**地址 |

两者都没配 → 端点仍正常完成,返回 `email.skipped = true` 且
`reason = "no_recipient_configured"`,**不报错**。

### 3. `RESEND_API_KEY`(邮件通道)

复用工单系统既有配置。**未配置时 `sendEmail()` 返回 `{ok:true, skipped:true}` 并把邮件内容
打进日志,不抛错** —— 本地/预览环境天然静默,无需额外开关。

## crontab 示例

```cron
# 每天 09:00(Asia/Shanghai)检查被卡住的客户并发汇总邮件。
CRON_SECRET=在此填入与Vercel相同的密钥
0 9 * * * curl -fsS -m 90 -H "Authorization: Bearer $CRON_SECRET" https://<prod-domain>/api/cron/admin-alerts >> /var/log/vibepin-alerts.log 2>&1
```

说明:

- **频率是每天一次,不是每小时。** 创始人每天看一次后台,小时级推送只会制造噪音;
  驾驶舱 PRD 的目标是「阻塞 <24h 被发现」,每日一次即达标。
- `-m 90` 给 curl 一个上限;端点自身 `maxDuration = 60`。
- **不要放进 `vercel.json` 的 crons** —— 本项目既有约定是 VPS crontab
  (Hobby 计划的 Vercel cron 每天只跑一次且不可控)。
- 日志追加到 `/var/log/vibepin-alerts.log`,方便核对每次的计数。

## 验证

手动 curl 一次:

```bash
curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://<prod-domain>/api/cron/admin-alerts
```

返回形如:

```json
{
  "available": true,
  "scanned": 3,
  "newlyNotified": 1,
  "cleared": 0,
  "stillOpen": 2,
  "email": { "sent": true, "skipped": false, "failed": false },
  "warnings": []
}
```

| 字段 | 含义 |
|---|---|
| `available` | 判定本身是否可信。**false 时一条都不推**(数据不可靠时保持沉默) |
| `scanned` | 本次扫描到的**可推送**阻塞数(已过滤:只含 3 类、只含真实客户、publish_failure 只含 exact) |
| `newlyNotified` | 本次**新增**的阻塞数 —— 即真正触发邮件的条数 |
| `cleared` | 本次检测到已消失、写入 `alert.blocker_cleared` 的条数(不发邮件) |
| `stillOpen` | 已通知过、本次仍存在的阻塞数(不重复发邮件) |
| `email.sent` | 邮件是否真正发出 |
| `email.skipped` | 无新增阻塞、或未配收件人/邮件通道 |
| `email.failed` | 发信失败(**不影响端点返回 200**,见下) |
| `warnings` | 降级说明(如审计表不可读、auth 用户列表拿不到) |

失败时(异常/鉴权)返回非 200 且结构为 `{error, code, message}`。

### 预期行为核对

- **连续跑两次**:第二次 `newlyNotified` 应为 **0**,`email.skipped` 为 true
  —— 状态转换去重生效,同一个问题不会天天重复发。
- **阻塞解决后再出现**:重新计入 `newlyNotified` 并再次发邮件。
- **发信失败**:`email.failed = true` 但端点仍返回 200。
  这是刻意设计 —— `alert.blocker_notified` 审计行**无论邮件是否发出都会写入**,
  以免一个 flaky 的邮件服务商导致下一次 cron 重复发信。
  **代价:发信真失败时该条告警不会重试**,但失败摘要写入 `admin_audit_events` 可查,
  且后台页面本身是兜底。取舍依据 PRD §2.1「宁可漏报,不可误报」。

## 排查

| 现象 | 检查 |
|---|---|
| 503 `cron_not_configured` | Vercel 未配 `CRON_SECRET`,或配了但未重新部署 |
| 401 `unauthorized` | VPS 与 Vercel 的密钥不一致 |
| `email.skipped` 恒为 true 且 `scanned > 0` | 未配 `ALERT_EMAIL_TO` / `SUPER_ADMIN_EMAILS`,看返回的 `reason` |
| 收到邮件但内容与 `/admin/today` 不一致 | 不应发生 —— 两者调用同一个 `getActionCenter()`。若出现请报告 |
| 一直收不到邮件但 `newlyNotified > 0` | 查 `RESEND_API_KEY` 是否配置;`email.skipped=true` 说明走了本地日志降级 |

## 与其他 cron 的关系

| 端点 | 频率 | 用途 |
|---|---|---|
| `/api/cron/publish-due` | `*/5 * * * *` | 发布到期的 Pin |
| `/api/cron/expire-reservations` | `*/15 * * * *` | 清理过期的用量预留 |
| `/api/cron/admin-alerts` | `0 9 * * *` | **本文档** —— 被卡住的客户告警 |

三者共用同一个 `CRON_SECRET`。
