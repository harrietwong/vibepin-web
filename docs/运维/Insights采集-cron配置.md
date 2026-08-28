# Insights 数据采集 — VPS cron 配置（Insights 方案 v6 · 第 2 步）

> **本文档描述的定时任务尚未启用。** 端点代码在分支 `feat/insights-on-live` 上，
> **尚未部署**；迁移 v64 只 apply 到了测试库 `snulmwprsahzqvdbyenc`，**生产库没有**。
> 在部署会话把代码上线、并由用户决定对生产库 apply v64 之前，**不要**把下面的
> crontab 加到 VPS 上——它只会每晚打出一串 200/503 噪声，一行数据也存不下来。
> 启用顺序在文末"启用前置条件"。

## 为什么要有采集，而不是"页面上直接读"

今天的 Insights 是**页面加载时现场调 Pinterest**：用户等着，我们一个 Pin 一个 Pin 地
拉分析数据。这有三重问题，其中只有前两重能靠缓存缓解：

1. 慢——每个 Pin 一次 HTTP 往返；
2. 把 60 次/分钟的额度花在"有人打开页面"上，而不是花在"我们要留下来的数据"上；
3. **它永远只能显示 Pinterest 今天愿意返回的数字。** Pinterest 的自然流量分析是一个
   滑动窗口：一个 Pin 的第 7 天数据，过了第 7 天就再也取不回来了。
   **当时没有人记录的指标，就是永久丢失的。**

所以采集必须与渲染解耦，并且必须是一本**账本**（v64 的五张表）。这个 cron 就是账本的
写入端。

## 两个端点

| 端点 | 方法 | 作用 |
|---|---|---|
| `/api/cron/insights-connections` | GET | 返回**全部**可用的 Pinterest 连接 `[{connectionId, userId}]`（未断开且持有 token）。 |
| `/api/cron/insights-collect` | POST | 对**一个**连接跑当日采集：`account_daily` → `registry` → `pin_task`，返回每段的 `collection_run` 摘要。 |

**为什么是两个端点、循环放在外面**：每日预算是**按连接**算的（60 次：7 固定 + 12 预留
+ 41 点位）。同一个用户的两个 Pinterest 账号各有各的 60 次——平台按 token 计量，把两个
账号塞进一次请求共用一个预算，等于让第二个账号替第一个账号的流量挨限流。而且一次请求
跑完所有账号，会在撞上 API 额度之前先撞上 serverless 的时间上限。

## 环境变量 CRON_SECRET

**复用现有的同一个密钥**，与 `/api/cron/publish-due`、`/api/cron/expire-reservations`
完全一致，不要另建：

1. **Vercel 环境变量**：`CRON_SECRET`（Production 勾选）。未配置时端点返回
   **503 `cron_not_configured`** 并打日志——安全默认，绝不裸奔。
2. **VPS 环境**：跑 crontab 的用户下导出同一个值。

## crontab 示例

`crontab -e`，把 `<prod-domain>` 换成生产域名：

```cron
# ── Insights 采集：每天 03:00 与 03:40 各跑一轮（UTC 或 VPS 本地时区，见下）──
CRON_SECRET=在此填入与Vercel相同的密钥
0 3 * * * /usr/local/bin/vibepin-insights-collect.sh >> /var/log/vibepin-insights.log 2>&1
40 3 * * * /usr/local/bin/vibepin-insights-collect.sh >> /var/log/vibepin-insights.log 2>&1
```

`/usr/local/bin/vibepin-insights-collect.sh`（`chmod 750`，属主是跑 cron 的用户）：

```bash
#!/usr/bin/env bash
set -uo pipefail
DOMAIN="https://<prod-domain>"
AUTH="Authorization: Bearer ${CRON_SECRET:?CRON_SECRET is not set}"

echo "=== $(date -u +%FT%TZ) insights collect ==="

# 1) 取工作清单。取不到就整轮退出——宁可这一晚不采，也不要对着空清单假装成功。
LIST=$(curl -fsS -m 60 -H "$AUTH" "$DOMAIN/api/cron/insights-connections") || {
  echo "connections endpoint failed; aborting this round"; exit 1; }

# 2) 逐个连接跑一次。单个连接失败不影响其它连接（|| true）。
for id in $(printf '%s' "$LIST" | jq -r '.[].connectionId'); do
  echo "--- connection $id"
  curl -sS -m 180 -X POST \
    -H "$AUTH" -H "Content-Type: application/json" \
    -d "{\"connectionId\":\"$id\",\"maxCalls\":30}" \
    "$DOMAIN/api/cron/insights-collect" || true
  echo
  sleep 2   # 相邻连接之间留一点间隔，避免自己把自己顶到 429
done
```

说明：
- **依赖 `jq`**（`apt-get install -y jq`）。不想装的话可以用
  `grep -o '"connectionId":"[^"]*"' | cut -d'"' -f4` 代替，但 `jq` 更稳。
- **`maxCalls` 硬上限 30**，端点自身还会再夹一次（`Math.min(requested, 30)`），
  所以即使这里写成 999 也只会给 30。
- **一天跑两轮**是有意的：单轮上限 30 次，每日预算 60 次。第二轮会读 `collection_run`
  账本算出今天已经花掉多少，只申请剩下的额度；预算用完时它返回
  `stopReason: "daily_budget_exhausted"` 并且**一次 Pinterest 调用都不发**，
  不是"再花 30 次"。所以多跑一轮是安全的，漏跑一轮才有代价。
- **`-sS` 而不是 `-fsS`**：这里**故意**不让 curl 因为 HTTP 错误码而吞掉响应体。
  503 的响应体里写着失败原因，这正是我们要记进日志的东西。
- `sleep 2` 只是相邻连接之间的礼貌间隔，跟 429 退避无关——429 退避在服务端。
- **时区**：crontab 走 VPS 本地时区。采集本身按 **UTC 日**计算预算与日期
  （`callsSpentToday` 用 UTC 零点切分），所以只要两轮落在同一个 UTC 日内即可；
  VPS 若是 Asia/Shanghai，`0 3` 与 `40 3` 都在 UTC 前一天 19:00/19:40，同一个 UTC 日，没问题。

## 验证

手动跑一遍：

```bash
# 工作清单
curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://<prod-domain>/api/cron/insights-connections

# 单个连接
curl -sS -X POST -H "Authorization: Bearer $CRON_SECRET" -H "Content-Type: application/json" \
  -d '{"connectionId":"<uuid>","maxCalls":30}' https://<prod-domain>/api/cron/insights-collect
```

`insights-collect` 返回形如：

```json
{
  "connectionId": "…",
  "callsMade": 9,
  "callsBudget": 30,
  "stoppedEarly": false,
  "stopReason": null,
  "runs": [
    { "id": "…", "kind": "account_daily", "callsMade": 2, "callsBudget": 30, "skippedReason": null, "error": null },
    { "id": "…", "kind": "registry",      "callsMade": 5, "callsBudget": 28, "skippedReason": null, "error": null },
    { "id": "…", "kind": "pin_task",      "callsMade": 2, "callsBudget": 23, "skippedReason": null, "error": null }
  ]
}
```

**`runs` 就是这套账本存在的理由**：光看"数据是空的"，分不清是"问了、Pinterest 没给"
还是"我们压根没问"。所以每一段都要自报花了多少、为什么停：

| 字段 | 含义 |
|---|---|
| `skippedReason: "rate_limited"` | 撞上 429。任务留在 `pending`，`attempts+1`，窗口还开着，下一轮重试。**这一轮后续步骤会被整段跳过**——限流是按 token 按分钟算的，继续打就是白打。 |
| `skippedReason: "budget_exhausted"` | 本轮 30 次用完。 |
| `skippedReason: "deadline"` | 撞到 100s 自设时限（低于路由的 `maxDuration = 300`，好让它有时间把账本行写完再退出）。 |
| `skippedReason: "no_permission"` | 403/401：不是"没有数据"，是"我们没被授权读"。 |
| `stopReason: "daily_budget_exhausted"` | 今天 60 次已经花完，本轮一次都没发。**这是正常的第二轮结果，不是故障。** |
| `runs: []` + `skipped: "not_connected"` | 连接已断开或没有 token——不是错误，只是不可采。 |
| `runs: []` + `skipped: "schema_unavailable"` | v64 没 apply 到这个库。端点返回 200，不会每晚报警。 |

鉴权自检：
- 不带 header 或密钥不匹配 → **401 `unauthorized`**；
- Vercel 未配 `CRON_SECRET` → **503 `cron_not_configured`**；
- 真正的采集失败 → **503 `collection_failed`**，绝不返回绿色的 200。
  （一个"报告成功却什么都没采到"的采集器，正是这本账本要让它不可能发生的东西。）

## 预算怎么花

每连接每天 60 次 = **7 固定 + 12 预留 + 41 点位**：

- **固定 7**：账号日度分析 1 + Top Pins 1 + registry 增量首页 1 + 全量扫描 ≤4 页。
  这些跳过就永久有洞（Pinterest 的日度窗口会滑走），所以排在最前面、无条件跑。
- **预留 12**：429 退避与重试的余地。不是"可以花的额度"，是"被限流时有地方可去"。
- **点位 41**：t1/t7/t30 三个固定测量点，只给 **VibePin 自己发布的 Pin** 建。
  registry 扫出来的老 Pin 不建点位——它们的发布时间是历史，建出来就已经过期了。

窗口是 `[due, expiry)`：t1 `[+1, +3)`、t7 `[+7, +10)`、t30 `[+30, +37)`；
优先级 t7 > t30 > t1。**窗口关了就取消，不顺延**——第 20 天量到的"第 7 天数据"
不是第 7 天数据，记下来只会污染它本来要支撑的那个对比。取消发生在**花钱之前**。

## 启用前置条件（按顺序）

1. 分支 `feat/insights-on-live` 合并并**部署到生产**（部署会话的活，本会话不做）。
2. 用户决定后，对**生产库** apply `backend/db/migrate_v64_insights_collection.sql`
   （标准跑法 `backend/scripts/run_migration.py --apply`）。
   未 apply 时端点优雅降级：返回 200 + `skipped: "schema_unavailable"`，
   `ownerConnectionForPin` 在请求路径上返回 null 而不是抛异常——所以**先部署后迁移
   不会把线上 Insights 打挂**，只是采不到数据。
3. Vercel 生产环境已有 `CRON_SECRET`（与 publish-due 同一个）。
4. 再把上面的 crontab 加到 VPS，先手动跑一次两个 curl 确认返回体正常。
5. 观察 3 天：`/var/log/vibepin-insights.log` 里每个连接每晚应有 3 段 `runs`，
   `callsMade` 之和不超过 60。
