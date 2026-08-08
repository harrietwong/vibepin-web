# WP3 设计:AI 生图迁移到持久化后端

状态:待用户审批 | 作者:Fable(advisor) | 2026-07-16

## 1. 现状(已核实)

- `web/src/app/api/generate/route.ts`(503 行,Vercel,maxDuration=300):已有双路径——
  优先转发 `FASTAPI_URL/api/tasks`(带健康检查),不可达时**回落 spawn python generator.py**。
  spawn 路径 = Vercel 生产不可用(无 Python)+ 触发 Next 全仓库 file-tracing 警告。
- `backend/generator.py`(2261 行):**纯 LinAPI HTTP 客户端 + 提示词工程**(httpx → api.linapi.net,
  无本地模型)。这 2000+ 行提示词逻辑是资产,必须复用,不许重写。
- `api/app` FastAPI 原型:骨架完整,`task_worker.py`/`publisher.py` 已接 Supabase
  (上传 bucket "generated")。任务状态目前不落库(进程内),不可恢复。
- 客户端 `generateAiVersions.ts`:单次 fetch **同步等全量结果**——浏览器刷新 = promise 消失 =
  卡片被 `failStaleGeneratingDrafts` 判死(已知 P1)。

## 2. 目标不变量(= 报告 WP3 验收 10 条)

连续 50 任务无永久 Generating / Drawer 关闭继续 / 刷新恢复 / 部分成功保留 /
provider 超时可重试 / worker 重启不丢任务 / 同请求不重复建卡 / 图片 URL 匿名可读 /
Pinterest 能读最终 URL / Vercel 无 Python。

## 3. 架构:Supabase 作队列(DB-as-queue),VPS 跑 worker

```
Studio UI ── POST /api/generate (Next/Vercel) ──▶ generation_jobs 行(queued) ──▶ 返回 jobId(<1s)
                                                        │
      VPS worker(systemd,复用 generator.py)◀── 轮询+CAS 认领(queued→running)
                                                        │  逐 slot:LinAPI → 上传 Supabase Storage
                                                        ▼  → 增量写 results[slot] + heartbeat
Studio UI ── 每 4s GET /api/generation-jobs/[id] ◀── 行状态(done/partial/failed)
      └─ 逐 slot completeGeneratedDraft(url) / failGeneratedDraft
```

**与报告推荐的唯一偏差**:报告写 "Next → FastAPI endpoint"。本设计用 **DB 作队列**,VPS 不暴露
任何 HTTP 端口。理由:(a) 免去 VPS 公网端点的 TLS/鉴权/防滥用整套工作;(b) claim-CAS 模式
在本仓已被 publish-due cron 验证;(c) Vercel↔VPS 网络抖动不影响入队。报告的目标(任务持久化、
Vercel 去 Python)全部达成,仅传输层不同。FastAPI 框架仍可作为 worker 进程的宿主(复用原型)。

## 4. 数据模型(migrate_v51_generation_jobs.sql,只写不 apply)

```sql
create table generation_jobs (
  id                uuid primary key default gen_random_uuid(),
  vibepin_user_id   uuid not null,
  status            text not null default 'queued',   -- queued|running|done|partial|failed
  params            jsonb not null,                    -- 全量多模态参数(产品图/参考图/创意方向/模型/count/ratio)
  results           jsonb not null default '[]',       -- [{slot,status:'pending|done|failed',imageUrl?,error?}]
  claimed_at        timestamptz,                       -- worker 认领时刻(CAS)
  worker_heartbeat_at timestamptz,                     -- 心跳;超时可重认领
  created_at/updated_at/finished_at timestamptz
);
-- partial index: (status) where status in ('queued','running');RLS service-role only
```

## 5. 关键语义

1. **认领**:`UPDATE ... SET status='running',claimed_at=now() WHERE id=? AND status='queued'`
   (CAS,零行=别人抢了)。心跳每 30s;`running` 且心跳 > 5min → 视为 worker 崩溃,可重认领。
2. **逐 slot 幂等**:重认领的 worker 跳过 `results[slot].status='done'` 的槽,只补 pending/failed
   → 部分成功永不丢、同请求不重复建卡(卡片由 slot 索引一一对应客户端占位 draft)。
3. **部分成功**:任一 slot 失败不影响其余;终态 `partial`;客户端逐 slot 判定成功/失败卡。
4. **worker 健康门**:worker 每 30s 更新一行 `worker_status.last_seen`;POST /api/generate 先查
   新鲜度,worker 死 → 直接 503"生成服务暂不可用"(诚实失败,不产僵尸任务)。
   兜底:`queued` 超 10min 无人认领 → 客户端轮询侧标记失败。
5. **刷新恢复**(修掉已知 P1):占位 draft 记 `generationJobId`。`failStaleGeneratingDrafts`
   重构为 **reconcile**:mount 时收集 generating drafts 的 jobId → 查任务状态 → 活任务恢复轮询,
   死/未知任务才判失败。Drawer 关闭/页面刷新都不再杀任务。
6. **上传**:worker 直传 Supabase Storage(service key 在 VPS env),公开 bucket,稳定 URL;
   客户端拿到的一律是可匿名访问的 https URL(Pinterest 可读)。
7. **分析/关键词/QualityJudge**:不变——客户端 completeGeneratedDraft 后照旧异步启动。

## 6. 分阶段交付(各自独立 commit + 可回退)

- **P1 基建**:migrate_v51 + worker(FastAPI 宿主包 generator.py,VPS systemd,沿用爬虫部署模式)
  + POST /api/generate 走 enqueue(env `GENERATION_MODE=worker|inline` 开关,inline=现状回落)
  + GET /api/generation-jobs/[id] + 客户端 enqueue+轮询。
- **P2 恢复语义**:failStale→reconcile 重构 + 刷新/关 Drawer 场景测试。
- **P3 清理**:删 spawn 路径与 BACKEND_DIR 引用(消 file-tracing 警告),Vercel 彻底无 Python。

测试:每阶段纯 node 单测(claim CAS/幂等/partial/reconcile 用 mock supabase)+ 浏览器 QA
(生成中刷新→卡片存活→完成)。worker 侧 pytest(认领/心跳/断点续跑)进 backend/tests。

## 7. 风险与依赖

- **VPS 单点**:worker 死 → 健康门快速失败,不静默。上线前 **VPS 密码轮换是硬前置**
  (worker 将持有 LINAPI_KEY + Supabase service key,当前 root 密码已泄露过)。
- VPS 内存 1.6G 无 swap:worker 是 IO-bound(HTTP 转发),常驻内存小;并发 slot 上限设 2。
- LINAPI_KEY 从 Vercel env 迁至 VPS env(deploy.env 模式);Vercel 侧仅保留 Supabase 凭据。

## 8. 待用户决策

1. worker 宿主定 VPS(47.89.181.103)可否?(备选:Railway/Fly 等托管,但多一套凭据面)
2. Storage bucket 沿用原型的 "generated" 公开桶?
3. 切换策略:P1 用 GENERATION_MODE 开关灰度,还是直接硬切?
