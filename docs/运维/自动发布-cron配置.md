# 自动到期发布 — VPS cron 配置（PRD WP-A）

到期的 Pin 由 `/api/cron/publish-due` 端点发布。Vercel Hobby 的内置 cron 每天只跑一次，
无法满足"每 5 分钟扫一次到期"的需求，所以改由 **VPS crontab 带密钥调用**该受保护端点。

## 前置：先 apply 迁移 v42

端点依赖 `pin_drafts.scheduled_at` 与 `pin_drafts.publish_claimed_at` 两列。
**必须先在 Supabase SQL Editor 执行** `backend/db/migrate_v42_scheduled_publish.sql`
（可重复执行）。未 apply 时端点会优雅降级，返回 `{claimed:0,published:0,failed:0,skipped:0}`，
不会 500 —— 但在迁移落地前不会真正发布任何 Pin。

## 环境变量 CRON_SECRET

同一个密钥要在两处配置：

1. **Vercel 环境变量**（Project → Settings → Environment Variables）：`CRON_SECRET`，
   生产环境勾选 Production。改动后需重新部署才生效。
   - 未配置时端点返回 **503 `cron_not_configured`** 并打日志（安全默认：绝不裸奔）。
2. **VPS 环境**：在跑 crontab 的用户下导出同一个值（见下）。

生成一个足够强的随机密钥，例如：

```bash
openssl rand -hex 32
```

## crontab 示例

编辑 crontab（`crontab -e`），加入（把 `<prod-domain>` 换成生产域名）：

```cron
# 每 5 分钟发布到期的 Pin。-m 60 = 60s 连接/传输超时；-fsS = 静默但失败可见。
CRON_SECRET=在此填入与Vercel相同的密钥
*/5 * * * * curl -fsS -m 60 -H "Authorization: Bearer $CRON_SECRET" https://<prod-domain>/api/cron/publish-due >> /var/log/vibepin-publish.log 2>&1
```

说明：
- crontab 顶部的 `CRON_SECRET=...` 会注入到该行的 `$CRON_SECRET`。也可以改为从
  `/etc/environment` 或 systemd env 读取，避免密钥明文写在 crontab 里。
- `-m 60` 给 curl 一个上限；端点自身 `maxDuration = 300`（当前 Vercel Hobby 上限），
  单次最多认领并发布 20 条，稳定跑在超时之内。
- 日志追加到 `/var/log/vibepin-publish.log`，方便核对每次返回的计数。

## 验证

手动 curl 一次，看返回的 JSON 计数：

```bash
curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://<prod-domain>/api/cron/publish-due
```

返回形如：

```json
{ "claimed": 2, "published": 2, "failed": 0, "skipped": 0 }
```

- `claimed`  本次原子认领成功（拿到锁）的行数。
- `published` 成功发布到 Pinterest 的行数。
- `failed`    发布失败/异常的行数（已写入失败语义，不再被扫描）。
- `skipped`   被跳过的行数（认领竞争失败 = 已被别的实例/上一轮认领，或 schema 抖动）。

鉴权自检：
- 不带 header 或密钥不匹配 → **401 `unauthorized`**。
- Vercel 未配 `CRON_SECRET` → **503 `cron_not_configured`**。

## 语义与已知限制

- **原子认领防重**：每行用一次条件 `UPDATE … RETURNING` 把 `publish_claimed_at` 置为
  `now()`，仅当该行仍可认领（`publish_claimed_at IS NULL` 或旧锁已超过 10 分钟）。
  只有 RETURNING 命中的行才会被本实例处理，所以多实例/重复触发不会重复发。
- **逐行独立**：每行独立 try/catch；单个账号 token 失效只把该行标记为 `auth` 失败，
  不会中断整批，也不会 retry 风暴（发布后无论成败都清空排程字段，行会离开到期扫描）。
- **at-least-once（MVP 已知窗口）**：认领 UPDATE 与结果 UPDATE 是两步。若进程在
  **Pinterest 已创建 Pin 之后、我们持久化成功之前**崩溃，10 分钟后该行锁过期会被重新
  认领并再次发布 —— 因为 `publishPinForUser` 对 Pinterest 没有幂等键。窗口很小且有界；
  持久化幂等键是后续 P1。
- **时区（MVP 已知偏差）**：`scheduled_at` 由 `payload.plannedAt`（本地墙钟字符串
  `YYYY-MM-DDTHH:mm`，客户端刻意不做 UTC 转换）计算，服务端也不存每用户时区，因此把墙钟
  时间**按 UTC 解释**。结果确定但可能相对用户本地偏差一个时区；每用户时区是后续 P1。
```
