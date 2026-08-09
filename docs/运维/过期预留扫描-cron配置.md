# 过期预留扫描 — VPS cron 配置（用量计量）

`/api/cron/expire-reservations` 释放"预留了但活儿没干完"的额度。

## 为什么必须有它

图片/文案生成是 **先 reserve、干完再 settle**。中途死掉的（用户关页面、worker 崩），
预留会一直挂在 `pending`，额度被占住。而 `usage_settle_reservation_item` 对
**过了 `expires_at` 的预留一律拒绝**，所以那些槽位再也没人能释放 ——
数据库函数 `usage_expire_reservations` 是唯一能释放的东西，**而在此之前没有任何东西调它**。

- **shadow 阶段（当前）**：无害。只记账不拦截，挂着的预留没人感觉得到。
- **转 enforce 之后**：同样这些行立刻变成**单向额度泄漏** —— 用户额度只减不增，会被错误挡住。

所以这条 cron **必须在开 enforce 之前挂上，并且被证明真的在跑**，不能和 enforce 同时上。

## 为什么走 VPS crontab 而不是 Vercel cron

和 `/api/cron/publish-due` 同一个原因：**Vercel Hobby 的内置 cron 每天只跑一次**，
对扫描类任务没有意义。本项目已经为同类需求做过这个选择，这里跟着走，
**不新增运维面**（可以复用同一条 crontab、同一个密钥）。

## 前置：v55 usage primitives 必须已 apply

端点依赖数据库函数 `usage_expire_reservations`（v55 usage primitives）。
未 apply 时端点**优雅降级**：返回 `{"expired":0,"skipped":0,"available":false}` 且 **200**，
不会让 crontab 每分钟报警 —— 但在迁移落地前它什么也不会释放。

> `available:false` 与 `expired:0` 是**两件事**：前者=函数还没部署，后者=函数跑了但没东西要扫。
> 排查时先看这个字段，别把"没部署"误读成"一切正常"。

## 环境变量 CRON_SECRET

**复用 publish-due 的同一个密钥**，无需新建。若尚未配置，见
[`自动发布-cron配置.md`](自动发布-cron配置.md#环境变量-cron_secret)。

未配置时端点返回 **503 `cron_not_configured`** 并打日志（安全默认：绝不裸奔）。

## crontab 示例

在已有的 crontab 里**追加一行**即可（`crontab -e`，`<prod-domain>` 换成生产域名）：

```cron
# 每 15 分钟扫一次过期预留。与 publish-due 共用 CRON_SECRET。
*/15 * * * * curl -fsS -m 60 -H "Authorization: Bearer $CRON_SECRET" https://<prod-domain>/api/cron/expire-reservations >> /var/log/vibepin-expire.log 2>&1
```

**频率怎么定**：取决于预留 TTL。扫描间隔应当**明显小于 TTL**，否则用户会看到额度
"卡住不还"。15 分钟是个安全默认；enforce 上线前若把 TTL 调短，这里要同步调。

单次最多扫 `SWEEP_LIMIT = 100` 条，`maxDuration = 60`，稳定跑在超时内；
吞吐靠**调用频率**而不是加大批量。

## 验证

手动 curl 一次：

```bash
curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://<prod-domain>/api/cron/expire-reservations
```

返回形如：

```json
{ "expired": 3, "skipped": 2, "available": true }
```

- `expired`   本次真正过期并释放的预留数。
- `skipped`   被**有意跳过**的数量：worker 心跳still新鲜（活着的慢活儿）或
              并发 settle 抢先完成。**skipped 不是错误**，是保护生效的证据。
- `available` 函数是否已部署（见上）。

鉴权自检：
- 不带 header 或密钥不匹配 → **401 `unauthorized`**（且不碰任何账本）。
- 未配 `CRON_SECRET` → **503 `cron_not_configured`**。
- 扫描真失败（超时/DB 不可用）→ **503 `database_unavailable`**。
  **绝不会返回绿色的 200** —— 一个"报告成功但其实什么也没扫"的 sweeper，
  正是这个端点要防的那种故障。

## 验收：必须证明它真的在跑

**配置存在 ≠ 实际生效**（本项目已多次吃这个亏）。挂上后按下面走一遍：

1. 在**测试库**（`snulmwprsahzqvdbyenc`，绝不用生产库）造一条 `state='pending'` 且
   `expires_at` 已过去的预留，且**不要**关联 `running` 且心跳新鲜的 job
   （否则它会被正确地 skip 掉）。
2. 等一个调度周期（≤15 分钟），或直接手动 curl 一次。
3. 确认三件事同时成立：
   - 该预留 `state` 变成 `expired`；
   - `usage_events` 多出一条 `operation='expire'` 的行，幂等键为 `expire:<reservation_id>`；
   - 对应账户的 `*_reserved` 计数下降（额度真的还回去了）。
4. 再手动跑一次，确认**不会重复计数** —— 幂等键保证同一预留只记一次。

只看 `/var/log/vibepin-expire.log` 里有 200 是**不够**的：那只证明端点被打到了，
不证明它释放了任何东西。

## 安全语义（都在 SQL 函数里，不在路由）

路由只是一个带鉴权的触发器；真正的正确性保证只有数据库能原子地做到：

- **账户行锁**：与 reserve/settle/release 串行化。已经在途的 settle 持锁，
  扫描会等它、然后重读发现槽位已不是 pending —— 两者**恰好只有一个生效**。
- **心跳即生命证明**：`running` 且 worker 心跳在 `p_lease_seconds`（300s）内的 job
  会被跳过。**绝不会把用户正在渲染的活儿从底下抽掉。**
- **幂等**：每次过期写一条 `usage_events`，幂等键 `expire:<reservation_id>`，
  所以重复触发不会重复计数 —— 这条 cron 可以任意频率、多实例、永远重复调用。
- **终止孤儿 job**：过期时把关联的 `queued`/`running` job 置为 `failed`，
  防止一个"复活"的 worker 事后交付早已过期的产出。
