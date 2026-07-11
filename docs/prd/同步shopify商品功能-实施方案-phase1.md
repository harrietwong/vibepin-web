# Shopify 商品同步 Phase 1 — 实施方案（Step 2）

> 基线：《同步shopify商品功能-规划任务书-v2修正版.md》（§2/§4/§6/§7/§7A 为权威决策）+《同步shopify商品功能-仓库审计-step1.md》（Step 1，事实来源）+ 产品负责人审计后补充裁决 a–k（2026-07-11）。
> 本文不重新讨论已批准决策。所有 `file:line` 引用沿用审计报告口径（相对 `d:\代码\Pinterest flow\`）。
> workspace = Supabase user id（裁决 b）；归属字段统一 `vibepin_user_id`。

---

## 1. 执行摘要

**就绪度：高。** 无硬性技术阻塞（审计 §D）。OAuth/加密模板（`web/src/lib/server/pinterest/*`、`web/src/lib/server/crypto.ts`）、ProductSelection/linkedProducts 关联体系（`ProductPickerModal.tsx:34-48`、`pinMetadata.ts:26-39`）、Batch Edit "product" URL 模式（`BatchEditDrawer.tsx:443`）、AI grounding 挂点（`/api/ai-copy` 的 `productContext`，`route.ts:34-64`）、服务端图片转 bytes（`visionServer.ts:229-262`）全部可直接扩展。

**三大风险：**
1. **WP0（草稿服务端权威持久化）是最大单项工程且是关键路径**——`pinDraftStore.ts` 纯 localStorage（审计 B5），Shopify 关联字段挂在它上面；WP0 不落地，"关联产品跨设备可见"（决策 6）不成立。缓解：WP0 独立先行、协议做成收敛式（LWW + outbox diff），对 store API 表面零改动。
2. **分片同步的并发/恢复正确性**——锁、cursor、entitlement 截停、tombstone 清扫全在 `store_connections` 单行 sync state 上（裁决 j），实现错了会出现重复同步或静默截断。缓解：CAS 锁 + run_id 防陈旧分片 + 纯函数化 sync engine 单测覆盖状态机全路径。
3. **外部配置依赖**——Partner dashboard scopes 仍含 `read_inventory,read_product_listings`（§7A 待修正项 1）、三个 GDPR webhook URL 未配置（待修正项 2）。发布门禁项，不阻塞开发。

**复用清单（只扩展不重写）：** `crypto.ts`（AES-GCM + `safeEqual`）、`oauthState.ts` 模式、`connectionStore.ts` 模式、`authUser.ts` 全部鉴权 helper、`ProductPickerModal.tsx`、`InlineCreateAssetPicker.tsx`、`PinDetailsDrawer.tsx` 产品卡与 "Use as destination URL"、`BatchEditDrawer.tsx` product 模式、`/api/ai-copy` productContext、`visionServer.ts`、`studioBoardFlag.ts` flag 模式、`SettingsModal.tsx` tab 架构、`routeHelpers.ts` 错误映射范式、`isMissingTableError` 降级模式。

**新建清单：** v38（pin_drafts）+ v39（store_connections/store_products/store_product_images/store_product_variants）迁移；`web/src/lib/server/shopify/*`（config/hmac/oauthState/connectionStore/productStore/adminClient/syncEngine/normalize）；`web/src/lib/server/entitlements.ts`；`/api/integrations/shopify/**` 9 条 route + `/api/pin-drafts`；`web/src/lib/pinDraftSync.ts`、`shopifyFlag.ts`、`shopifyClient.ts`；`ShopifyTab.tsx`、`ShopifyProductPickerPanel.tsx`。

---

## 2. 能力地图 + 差距矩阵

| 能力 | 状态 | 依据（审计） | 差距动作 |
|---|---|---|---|
| OAuth state/CSRF/加密 token 存储 | Done（模板） | B3：`oauthState.ts`、`crypto.ts`、`connectionStore.ts` | 按模板新建 Shopify 版；`crypto.ts` 增加按 env 名取密钥的 cipher 工厂（`SHOPIFY_TOKEN_ENCRYPTION_KEY`，裁决 g） |
| HMAC 验签（launch/webhook） | Missing | B11：无任何 webhook 端点 | 新建 `server/shopify/hmac.ts`，复用 `crypto.ts:118-123 safeEqual` + node:crypto createHmac |
| StoreConnection 四态 + sync state | Missing | B3 差距①②④ | v39 新表，复合唯一键 `(vibepin_user_id, shop_domain)`（裁决 b） |
| 产品选择/关联体系 | Done（宿主） | B4：ProductSelection、linkedProducts/primaryProduct 两层、saveToLibrary 逐个可选 | 扩 `ProductSourceKind` 加 `"shopify"`（裁决 d）+ picker 加 tab/source |
| 草稿服务端权威持久化 | **Missing（决策 6 前置项触发）** | B5：纯 localStorage，persist-failure Retry 仅配额重试 | WP0：v38 `pin_drafts` 表 + `/api/pin-drafts` + 写穿/合并协议（裁决 c） |
| AI Copy productContext | Partial | B6：`{title, category, productUrl, attributes[]}` 已存在（`route.ts:34`） | 扩字段 vendor/tags/price/availability（§4F） |
| CDN 图进视觉链路 | Done | B6：`fetchImageAsDataUrl` 已支持任意公网 https，8s/10MB | 仅加 SSRF 收敛（限本用户已同步 ProductImage URL） |
| 同步锁 | Missing（现有不可复用） | B11：publish lock 是进程内 Set | sync state 落 `store_connections` 行（status+cursor+lock expiry），CAS 抢占 |
| entitlement | Missing | B10：仅 email 白名单布尔 | 新建 `server/entitlements.ts`（裁决 h：config 常量 + user_metadata.plan） |
| Settings 管理面 | Partial | B9：Settings 是 modal+tabs；integrations/page.tsx 是 5 行 redirect | 新增 SettingsModal "Shopify" tab；redirect 改指 Shopify tab（裁决 a） |
| Batch "product" URL 模式 | Done | B4：`BatchEditDrawer.tsx:443, :993-997`，逐 Pin 用自身 primary product URL | 零改动，WP7 加测试验证 Shopify 快照 URL 生效 |
| 单条 Use-as-destination 确认语义 | Done | B4：`PinDetailsDrawer.tsx:540-552` 空填/非空 confirm | 零改动；deleted/stale 时加警告文案 |
| Feature flag 机制 | Done（模式） | B10：`studioBoardFlag.ts` env>localStorage>默认 | 新建 `shopifyFlag.ts`（`NEXT_PUBLIC_SHOPIFY_INTEGRATION`，默认 off） |
| 迁移应用状态 | Needs verification | B1：v32–v37 authored-not-applied，代码不可见 | 发布门禁：SQL Editor 盘点 v32–v37 后依次执行 v38/v39 |
| Partner dashboard scopes/webhooks | Blocked（外部） | §7A 待修正项 | 发布门禁清单项，非代码 |

---

## 3. 架构

### 3.1 实体关系

```
auth.users (Supabase)
  1 ──< store_connections            (vibepin_user_id, shop_domain) UNIQUE；status 四态 + sync state
           1 ──< store_products      (vibepin_user_id, store_connection_id, external_product_id) UNIQUE；tombstone: deleted_at
                    1 ──< store_product_images    (product_id, external_image_id) UNIQUE
                    1 ──< store_product_variants  (product_id, external_variant_id) UNIQUE（schema-only）
  1 ──< pin_drafts                   (vibepin_user_id, draft_id) PK；payload jsonb = PinDraft 全量，LWW on updated_at
```

草稿↔产品关联（裁决 d）：`PinDraft.linkedProducts[]`（`pinDraftStore.ts:82-83`）内的 `LinkedProduct.productId` = `store_products.id`（服务端 uuid），`source = "shopify"`，title/imageUrl/productUrl/price/currency 为选中时快照（决策 9 冻结语义）。不复用 `creatorProductLink`（provider 硬编码 "amazon"，`creatorProductLink.ts:162-233`）。

命名调和（§3.5）：DB 命名空间 `store_*` 避开爬虫表 `pin_products`；用户可见命名——picker tab/badge = **"Shopify"**，Amazon/URL 导入库仍叫 **"My Products"**，选品情报仍叫 **"Product Opportunities"**（`pinMetadata.ts:57-60` 现有 label）。全产品不新增任何叫 "Products" 的入口。

### 3.2 API 路由清单

全部 `export const runtime = "nodejs"; export const dynamic = "force-dynamic";`。错误一律 `{error, code}`（审计 B13）。禁止沿用 `/api/import/product-urls` 无鉴权先例（裁决 k）。

| 方法 | 路径 | 鉴权 | 用途 |
|---|---|---|---|
| GET | `/api/integrations/shopify/launch` | **HMAC**（query）+ cookie session 判定 | Shopify App URL 入口（§7A 锁定） |
| GET | `/api/integrations/shopify/connect` | cookie session（`getUserIdFromCookies`） | 浏览器导航发起 OAuth（302） |
| POST | `/api/integrations/shopify/connect` | Bearer（`getUserIdFromBearer`） | Settings 按钮热路径，返回 `{url}` |
| GET | `/api/integrations/shopify/callback` | **HMAC** + sealed state cookie | OAuth 回调（§7A 锁定） |
| GET | `/api/integrations/shopify/status` | Bearer-or-cookie（`getUserIdFromBearerOrCookies`) | 连接 + 同步状态（safe，无 token） |
| POST | `/api/integrations/shopify/sync` | Bearer | 启动/续传一个同步分片 |
| POST | `/api/integrations/shopify/disconnect` | Bearer | 断开（吊销 + 软删 + tombstone） |
| GET | `/api/integrations/shopify/products` | Bearer | picker 查询（搜索/筛选/分页） |
| GET | `/api/integrations/shopify/products/[id]` | Bearer | 详情 + 图片列表 + 新鲜度检查 |
| POST | `/api/integrations/shopify/webhooks` | **HMAC**（`X-Shopify-Hmac-Sha256` over raw body） | 3 个 GDPR + app/uninstalled，按 `X-Shopify-Topic` 分发 |
| GET/PUT/DELETE | `/api/pin-drafts` | Bearer | WP0 草稿权威存储（非 Shopify 专属，不放 integrations 下） |

### 3.3 OAuth 流程（文字步骤）

1. 入口 A（Shopify 侧）：`GET /launch?shop=x.myshopify.com&hmac=…&timestamp=…` → 校验 query HMAC（去除 hmac 参数、按 key 字典序拼 `k=v&…`、HMAC-SHA256(hex, SHOPIFY_CLIENT_SECRET)、`safeEqual`）+ shop 域名正则 `^[a-z0-9][a-z0-9-]*\.myshopify\.com$` → 已登录（`getUserIdFromCookieSession`）→ 进入第 3 步；未登录 → 302 `/login?returnTo=/app/settings/shopify?shop=x.myshopify.com`（登录后落 Shopify tab，shop 预填）。
2. 入口 B（VibePin 侧）：Settings Shopify tab 输入 shop 域名点 Connect → `POST /connect {shopDomain}`。
3. connect：校验配置（`SHOPIFY_CLIENT_ID/SECRET/REDIRECT_URI/TOKEN_ENC_KEY` 齐备，缺失 → 500 `config_error`）→ 校验域名 → **entitlement 检查**（`resolvePlan(userId)`，活跃连接数 ≥ maxStores → 403 `plan_limit_stores`；free maxStores=0 直接拒）→ 生成 state（`randomBytes(32)` base64url，照 `oauthState.ts:59-61`）→ `{state, uid, shopDomain, exp(10min), returnTo}` AES-GCM seal 进 HttpOnly cookie `shopify_oauth_state` → 302/返回 `https://{shop}/admin/oauth/authorize?client_id={KEY}&scope=read_products&redirect_uri={REDIRECT_URI}&state={state}`。
4. callback：`GET /callback?code=…&shop=…&state=…&hmac=…` → 校验 query HMAC → unseal cookie：state 匹配 + uid 匹配 + 未过期 + shop 与 sealed shopDomain 一致 → **单次使用清除 cookie**（照 `oauthState.ts:81-92`）→ `POST https://{shop}/admin/oauth/access_token {client_id, client_secret, code}` → 得 offline `{access_token, scope}`（legacy install flow，token 不过期）。
5. 落库：token 用 SHOPIFY_TOKEN_ENCRYPTION_KEY 加密（`v1:` 前缀格式照 `crypto.ts:22-25`）→ GraphQL `shop { name primaryDomain { host } }` 取店名/主域 → upsert `store_connections`（onConflict `(vibepin_user_id, shop_domain)`，status=connected，清 disconnected_at/uninstalled_at）→ GraphQL `webhookSubscriptionCreate(topic: APP_UNINSTALLED, callbackUrl: …/webhooks)` 注册卸载 webhook（失败仅记 sync_error 级日志，不阻断）。
6. 302 → `/app/settings/shopify?shopify=connected`（打开 Shopify tab，见 §7 UI）；tab 引导语指向 Create Pins 的 Select product（§3.1 任务书）。任何失败 → 302 `/app/settings/shopify?shopify=<error_code>`。
7. Reconnect = 重走 3–6 覆盖凭证（决策 13）；reauth_required 状态由 API 调用收到 401/`invalid token` 时置位。

### 3.4 分片同步流

**驱动模型（决策 4）**：客户端循环 `POST /sync` 直至终态；每个请求处理 1–3 页（每页 50 个商品，GraphQL cost 控制在限额内），请求内预算 ~20s，远低于 300s。

**sync state 状态机（全部落 `store_connections` 行，裁决 j）：**

```
idle ──Sync now──▶ running(cursor=null, run_id=新, lock=now+120s, sync_started_at=now)
running ──分片成功──▶ running(cursor=endCursor, synced_count+=n, lock 续期)   [心跳=每分片续 lock]
running ──hasNextPage=false──▶ completed(tombstone 清扫 + last_full_sync_at=now, lock/cursor 清空)
running ──synced_count ≥ plan cap──▶ limit_reached(total_count=productsCount, lock/cursor 清空)
running ──GraphQL/网络错误──▶ error(sync_error=消息, cursor 保留)  ──Sync now──▶ running(从 cursor 续传)
running(lock 已过期) ──任何新 /sync──▶ 接管：沿用 cursor 续传（中断恢复）
completed/limit_reached/error ──Sync now──▶ 新 run（cursor 重置，run_id 更新）
```

- **锁**：`POST /sync` 开头做 DB 条件更新（CAS）：`update … set sync_status='running', sync_lock_expires_at=now()+120s, … where id=:id and vibepin_user_id=:uid and (sync_status <> 'running' or sync_lock_expires_at < now())`；未命中行 → 409 `sync_in_progress`。分片体携带 `run_id`，落 cursor 前校验行内 `sync_run_id` 未变（防陈旧分片写入）。
- **幂等 upsert**：按 `(vibepin_user_id, store_connection_id, external_product_id)` onConflict merge；重复分片安全。
- **删除检测（无增量 webhook 的 Phase 1 方案）**：完成整轮后执行 tombstone 清扫——`update store_products set deleted_at=now(), status='deleted' where store_connection_id=:id and deleted_at is null and last_synced_at < :sync_started_at`（本轮没见到的商品即已删）。
- **entitlement 截停（不静默截断，决策 3）**：查询按 `sortKey: UPDATED_AT, reverse: true`（最近优先）；upsert 前检查 `synced_count`，达到 plan cap 即停止翻页，另发 `productsCount` 查询取 Y，置 `limit_reached`。UI 展示横幅 **"Synced X of Y products"** + 升级引导（数据来自 `/status` 的 `synced_count/total_count`）。
- **限流退避**：读响应 `extensions.cost.throttleStatus.currentlyAvailable`，低于下一页预估 cost 时在分片内 sleep（≤2s）或提前返回 `hasMore: true` 让客户端下一轮再来；收到 `THROTTLED` 错误 → 指数退避一次后重试，仍失败 → error 态（cursor 保留，可续传）。
- **Sync now** = 同一管线重入（决策 7）；进行中（锁未过期）按钮禁用。

### 3.5 Picker 流

共享层：`ShopifyProductPickerPanel`（新组件）+ `shopifyClient.ts` 查询封装（裁决 e："共享同一套查询 API 与选择组件逻辑，不做大一统重构"）。

1. **Edit Pin / Batch 场景**：`ProductPickerModal` tabs（`ProductPickerModal.tsx:77, :342-347`）增加 `shopify` tab → 面板内搜索（title ilike）、状态筛选（active/draft/archived，tombstone 默认隐藏，决策 8）、行卡 = 主图 + 标题 + 价格 + 状态 + 图片数 + "Shopify" 徽标（`sourceBadge` 映射 `:62-68` 增 `shopify → "Shopify"`）→ 行内 Details 展开轻量预览（多图缩略）→ 选择产出 `ProductSelection`：`{id: store_products.id, title, imageUrl: primary_image_url, url: product_url, canonicalUrl: product_url, store: shop_name, price, currency, source: "shopify", asPrimary(照 :182 现有开关), saveToLibrary(勾选框照 use_link 模式 :426-431，默认 false——绝不自动入库，决策 5)}`。
2. **AI Drawer 场景**：`InlineCreateAssetPicker`（`AiVersionDrawer.tsx:430-442` 宿主）增加 Shopify source 区，内嵌同一 `ShopifyProductPickerPanel`（多图选择模式）；选中图片追加进 `productImages`、元数据进 `productMetadata {title, productUrl}`（`AiVersionDrawer.tsx:50, :63` 现有契约，零契约改动）。
3. 未连接/flag 关闭：tab/source 不渲染（flag off）或渲染空态 "Connect your Shopify store in Settings → [Open Settings]"（连接态由 `/status` 客户端缓存 60s）。

### 3.6 Product → Pin 流

入口（§3.2 任务书）：StudioBoard header 次级动作 `[Select product]`（插入 `StudioBoard.tsx:358-363` 动作组）+ 空状态次级链接 "Create from your store? Select a product"（与 `:392` Create-with-AI 并列）。两处都打开 `ProductPickerModal`（Shopify tab 预选）。

确认选择后才创建草稿（打开 picker/选中不创建）：调 `createBoardDraft`（`pinDraftStore.ts:348`）——`imageUrl` = 选中主图（Shopify CDN 直链，决策 3 不代理）、`source: "uploaded_image"` 语义沿用、`linkedProducts` 写入 shopify LinkedProduct（primary）、`title` 预填产品标题（用户可改）、**`destinationUrl` 保持空**（§2：绝不自动填 URL）。草稿状态 Unscheduled，进入现有生命周期，同步永不建草稿（§2）。

Destination link（§4G，全部复用现状）：单条 = `PinDetailsDrawer.tsx:540-552` 的空填/confirm 替换；批量 = BatchEditDrawer "product" 模式逐 Pin 用自身 primary product URL（`:993-997`）。解绑不清 URL、产品变更不回写（快照即冻结）。

### 3.7 AI grounding 流

1. 客户端：`generatePinCopy.ts` 的 `inferProductContext`（`:60-84`，已读 primary product 的 title/category/productUrl/attributes/source）扩展：当 `source === "shopify"` 且草稿有 `linkedProducts` shopify 快照，附加 `vendor`、`tags`（≤10）、`price`（含 currency 格式化）、`availability`；`category` 沿用 `productType`。
2. 服务端：`/api/ai-copy` 的 `ProductContext` 类型（`route.ts:51,:101`）加同名可选字段；`buildContextBlock`（`:119-126`）把 vendor/tags 织入 Product 行、price/availability 仅在非空时输出（§4F "仅在相关时"）。`contextUsed` 契约不变（`:368-372`，只回真实输入，不暴露原始 payload）；`contextSourcesUsed` 的 "product" 条件（`:363`）不变。
3. 视觉链路：Shopify CDN https 直链走现有 `fetchImageAsDataUrl`（`visionServer.ts:229-262`，8s/10MB 现状即通过）。**SSRF 收敛**（审计 B6 需注意项）：`/api/ai-copy/analyze` 与 ai-copy 主路径中，当请求方声明产品图来源为 shopify 时，服务端校验该 URL 存在于本用户 `store_product_images.source_image_url`，否则按普通外链走原有 `safeImageUrl` 规则。
4. keywordContext：零改动——产品 `productType/tags` 已通过 productContext 进入 `keywordHints`（`route.ts:292`），不重写关键词系统（§4F）。

### 3.8 错误态流

| 场景 | 行为 | 用户可见 |
|---|---|---|
| env 未配置 | connect/launch 500 `config_error`；callback 302 `?shopify=config_error` | tab 顶部错误条 |
| HMAC 失败 | launch/webhooks 401 `hmac_invalid`（webhook 返回 401 让 Shopify 重试/告警） | 无（安全事件日志） |
| state 过期/不匹配 | callback 302 `?shopify=state_mismatch` | "Connection attempt expired — try again" |
| plan 超店数 | 403 `plan_limit_stores` | tab 内升级引导 |
| 同步中再点 | 409 `sync_in_progress` | 按钮禁用 + 进度条 |
| GraphQL 401/token 失效 | 连接置 `reauth_required` | tab "Reconnect" 主按钮 |
| GraphQL throttled/5xx | 退避重试 → error 态（cursor 保留） | "Sync failed — Retry"（续传） |
| 表未应用（v38/v39） | `isMissingTableError` 模式（`errors.ts:19-25`）→ status 返回 not_connected/空列表，不 500 | 功能呈未连接态（裁决 i） |
| 产品已删/归档被草稿引用 | 独立警告徽标，生命周期不变（§2/决策 8） | drawer 警告 + use-link 时二次确认文案 |
| 断开/卸载 | token 置 null + status=disconnected + 商品 tombstone；草稿引用保留并显示 stale | picker 隐藏、drawer 警告 |
| pin-drafts 服务端写失败 | outbox 保留 + 退避重试；localStorage 仍有全量 | 复用现有 saved indicator，不新增打扰 |

---

## 4. 精确数据模型（v38 / v39 DDL 草稿）

约定（裁决 i，样板 `api/migrations/001_pinterest_connections.sql`）：additive + idempotent（IF NOT EXISTS）、RLS enable 且**无任何 permissive policy**（仅 service-role，经 `web/src/lib/supabase.ts:15-19` createServerClient 访问）、复用 `update_updated_at` 触发器模式（`001:41-49`）、SQL Editor 手工执行。

### 4.1 `backend/db/migrate_v38_pin_drafts.sql`（WP0）

```sql
-- v38: server-authoritative Pin Draft storage (决策6前置项). Additive; run in Supabase SQL Editor.
create extension if not exists "uuid-ossp";

create table if not exists pin_drafts (
  vibepin_user_id uuid        not null,
  draft_id        text        not null,            -- client id, e.g. "pd_1720..._ab12cd" (pinDraftStore genId)
  payload         jsonb       not null,            -- full PinDraft object (authority)
  status          text,                            -- promoted copy of payload.status (query aid)
  updated_at      timestamptz not null,            -- = payload.updatedAt; LWW authority
  created_at      timestamptz not null default now(),
  archived_at     timestamptz,                     -- promoted copy of payload.archivedAt
  deleted_at      timestamptz,                     -- tombstone (deleteDraft); payload retained 30d for recovery
  primary key (vibepin_user_id, draft_id)
);

create index if not exists pin_drafts_user_updated
  on pin_drafts (vibepin_user_id, updated_at desc);
create index if not exists pin_drafts_user_live
  on pin_drafts (vibepin_user_id) where deleted_at is null;

alter table pin_drafts enable row level security;
-- (No permissive policies: service-role only.)
```

生命周期：upsert（LWW：仅当传入 `updated_at >= 行内 updated_at` 才覆盖）→ 删除置 `deleted_at`（tombstone）→ 服务端同样执行 500 条上限（超出把最旧的置 tombstone，与 `pinDraftStore.ts:25 MAX_DRAFTS` 对齐）。单 payload 上限 200KB（413 `payload_too_large`）。

### 4.2 `backend/db/migrate_v39_shopify_store_sync.sql`（WP1）

```sql
-- v39: Shopify store sync — connections + synced products (Phase 1). Additive; SQL Editor.
create extension if not exists "uuid-ossp";

create table if not exists store_connections (
  id                       uuid primary key default uuid_generate_v4(),
  vibepin_user_id          uuid not null,
  provider                 text not null default 'shopify',      -- future-safe: woocommerce/etsy
  shop_domain              text not null,                        -- lowercase *.myshopify.com
  shop_name                text,
  primary_domain           text,                                 -- storefront host for product URLs
  access_token_encrypted   text,                                 -- AES-256-GCM "v1:" via SHOPIFY_TOKEN_ENCRYPTION_KEY; never plaintext
  scopes                   text[] not null default '{}',
  status                   text not null default 'connected'
    check (status in ('connected','degraded','reauth_required','disconnected')),
  -- sync state (决策4 / 裁决j: cursor+lock live on this row)
  sync_status              text not null default 'idle'
    check (sync_status in ('idle','running','completed','limit_reached','error')),
  sync_cursor              text,
  sync_run_id              text,
  sync_lock_expires_at     timestamptz,
  sync_started_at          timestamptz,
  sync_error               text,
  synced_count             integer not null default 0,
  total_count              integer,                              -- productsCount at limit check ("of Y")
  last_full_sync_at        timestamptz,
  last_incremental_sync_at timestamptz,                          -- reserved for 1.1 webhooks
  uninstalled_at           timestamptz,
  disconnected_at          timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);
create unique index if not exists store_connections_user_shop
  on store_connections (vibepin_user_id, shop_domain);
create index if not exists store_connections_active
  on store_connections (vibepin_user_id) where disconnected_at is null;

create table if not exists store_products (
  id                   uuid primary key default uuid_generate_v4(),
  vibepin_user_id      uuid not null,
  store_connection_id  uuid not null references store_connections(id) on delete cascade,
  source               text not null default 'shopify',
  external_product_id  text not null,                            -- numeric part of Shopify GID
  handle               text,
  title                text not null default '',
  description_text     text,                                     -- normalized plain text (from descriptionHtml)
  product_url          text,                                     -- onlineStoreUrl ?? https://{primary_domain||shop_domain}/products/{handle}
  status               text not null default 'active'
    check (status in ('active','draft','archived','deleted')),
  vendor               text,
  product_type         text,
  tags                 text[] not null default '{}',
  price_amount         numeric(12,2),
  compare_at_price     numeric(12,2),
  currency             text,
  availability         text not null default 'unknown'
    check (availability in ('in_stock','out_of_stock','unknown')), -- derived: status+variants.availableForSale (§4B: no read_inventory)
  primary_image_url    text,
  image_count          integer not null default 0,
  created_at_source    timestamptz,
  updated_at_source    timestamptz,
  last_synced_at       timestamptz,
  sync_error           text,
  archived_at          timestamptz,
  deleted_at           timestamptz,                              -- tombstone: picker hides by default
  raw_source           jsonb,                                    -- debug snapshot, 30-day retention
  raw_source_saved_at  timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create unique index if not exists store_products_identity
  on store_products (vibepin_user_id, store_connection_id, external_product_id);
create index if not exists store_products_conn_updated
  on store_products (store_connection_id, updated_at_source desc);
create index if not exists store_products_user_live
  on store_products (vibepin_user_id) where deleted_at is null;

create table if not exists store_product_images (
  id                   uuid primary key default uuid_generate_v4(),
  vibepin_user_id      uuid not null,
  product_id           uuid not null references store_products(id) on delete cascade,
  external_image_id    text not null,
  source_image_url     text not null,                            -- Shopify CDN direct link (决策3: no proxy/cache)
  width                integer,
  height               integer,
  alt_text             text,
  position             integer not null default 0,
  variant_external_ids text[] not null default '{}',             -- variantAssociation
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create unique index if not exists store_product_images_identity
  on store_product_images (product_id, external_image_id);
create index if not exists store_product_images_user
  on store_product_images (vibepin_user_id, source_image_url);   -- SSRF allowlist lookup (§3.7)

-- schema-only in Phase 1 (决策11): no UI reads beyond availability derivation
create table if not exists store_product_variants (
  id                   uuid primary key default uuid_generate_v4(),
  vibepin_user_id      uuid not null,
  product_id           uuid not null references store_products(id) on delete cascade,
  external_variant_id  text not null,
  title                text,
  price_amount         numeric(12,2),
  sku                  text,
  available_for_sale   boolean,
  external_image_id    text,
  position             integer not null default 0,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create unique index if not exists store_product_variants_identity
  on store_product_variants (product_id, external_variant_id);

-- updated_at triggers (reuse shared proc, pattern from api/migrations/001:41-49)
do $$
begin
  if exists (select 1 from pg_proc where proname = 'update_updated_at') then
    drop trigger if exists store_connections_updated_at on store_connections;
    create trigger store_connections_updated_at before update on store_connections
      for each row execute procedure update_updated_at();
    drop trigger if exists store_products_updated_at on store_products;
    create trigger store_products_updated_at before update on store_products
      for each row execute procedure update_updated_at();
  end if;
end$$;

alter table store_connections      enable row level security;
alter table store_products         enable row level security;
alter table store_product_images   enable row level security;
alter table store_product_variants enable row level security;
-- (No permissive policies on any of the four: service-role only.)
```

`adminUrl` 为读取时派生（`https://{shop_domain}/admin/products/{external_product_id}`），不建列。raw_source 30 天保留：同步引擎 upsert 时若 `raw_source_saved_at` 超 30 天且本次未更新则置 null（无 cron 前提下的惰性清理）。

---

## 5. 文件级变更计划

**M = modify（路径已核实存在），C = create（新建）。**

### 服务端库
| 文件 | 类型 | 职责 / 依赖 |
|---|---|---|
| `web/src/lib/server/crypto.ts` | M | 追加 `createTokenCipher(envVarName)` 工厂（返回 encrypt/decrypt/sealJson/unsealJson，绑定指定 env 密钥）；Pinterest 现有导出零改动 |
| `web/src/lib/server/entitlements.ts` | C | `PlanKey`→`{maxStores, maxSyncedProducts}` 常量表（free 0/0、starter 1/100、pro 2/500、business 3/1000）+ `resolvePlan(userId)`（supabase admin getUserById → `user_metadata.plan`，email 白名单与 `useUserTier.ts:6-28` 对齐映射 pro）。不写 DB 约束（裁决 h） |
| `web/src/lib/server/shopify/config.ts` | C | 读 `SHOPIFY_CLIENT_ID/CLIENT_SECRET/REDIRECT_URI/API_VERSION`；`isShopifyConfigured()`、`buildAuthorizeUrl(shop, state)`、`isValidShopDomain()`。参照 `server/pinterest/config.ts` 模式 |
| `web/src/lib/server/shopify/hmac.ts` | C | `verifyLaunchQueryHmac(searchParams)`（字典序 k=v& + HMAC-SHA256 hex）、`verifyWebhookHmac(rawBody, headerB64)`；依赖 node:crypto createHmac + `crypto.ts safeEqual`（裁决 k） |
| `web/src/lib/server/shopify/oauthState.ts` | C | 照 `server/pinterest/oauthState.ts` 全套语义（10min TTL、单次使用、returnTo 白名单），cookie 名 `shopify_oauth_state`，payload 增 `shopDomain`，seal 用 shopify cipher |
| `web/src/lib/server/shopify/connectionStore.ts` | C | `store_connections` CRUD：`upsertConnection`、`listConnections(userId)`、`getConnection(userId, id)`、`acquireSyncLock`(CAS)、`updateSyncProgress`、`finishSync`、`markReauthRequired`、`markUninstalled(shopDomain)`、`disconnect`、`toSafeStatus`（token 永不出响应，照 `connectionStore.ts:237-252`）；`isMissingTableError` 降级 |
| `web/src/lib/server/shopify/productStore.ts` | C | `upsertProductsBatch`（含 images/variants 子表 diff）、`listProducts({q, status, cursor, limit})`、`getProductWithImages`、`tombstoneStale(connId, before)`、`tombstoneAll(connId)`、`countActive(userId)`、`isOwnedProductImageUrl(userId, url)`（SSRF allowlist） |
| `web/src/lib/server/shopify/adminClient.ts` | C | GraphQL fetch（`https://{shop}/admin/api/{SHOPIFY_API_VERSION}/graphql.json`，`X-Shopify-Access-Token`）；typed error（401→reauth、THROTTLED、5xx）；cost 读取 |
| `web/src/lib/server/shopify/normalize.ts` | C | 纯函数：GraphQL product node → 行结构；availability 派生（active + 任一 variant availableForSale → in_stock；active 无 → out_of_stock；其余 unknown）；descriptionHtml → 纯文本；product_url 回退链；GID → 数字 id |
| `web/src/lib/server/shopify/syncEngine.ts` | C | `runSyncChunk(userId, connectionId)`：锁 CAS → 翻 1–3 页（50/页，`sortKey: UPDATED_AT, reverse: true`，images first:20 + variants first:50）→ normalize → entitlement 截停 → upsert → cursor/进度落库 → 完成时 tombstone 清扫。依赖 adminClient/normalize/productStore/entitlements |

### API routes（全部 C）
| 文件 | 职责 |
|---|---|
| `web/src/app/api/pin-drafts/route.ts` | WP0：GET 分页列出（cursor=updated_at,draft_id）、PUT 批量 LWW upsert（≤50）、DELETE 批量 tombstone；`getUserIdFromBearer` |
| `web/src/app/api/integrations/shopify/launch/route.ts` | §3.3 步骤 1 |
| `web/src/app/api/integrations/shopify/connect/route.ts` | GET+POST 双入口（照 `api/auth/pinterest/connect/route.ts:155-253`）|
| `web/src/app/api/integrations/shopify/callback/route.ts` | §3.3 步骤 4–6 |
| `web/src/app/api/integrations/shopify/status/route.ts` | safe status 聚合 |
| `web/src/app/api/integrations/shopify/sync/route.ts` | 调 syncEngine，返回分片结果 |
| `web/src/app/api/integrations/shopify/products/route.ts` | picker 查询 |
| `web/src/app/api/integrations/shopify/products/[id]/route.ts` | 详情/新鲜度 |
| `web/src/app/api/integrations/shopify/disconnect/route.ts` | 尝试 `DELETE /admin/api_permissions/current.json` 吊销（失败忽略）→ 软删 + tombstoneAll |
| `web/src/app/api/integrations/shopify/webhooks/route.ts` | raw body（`await req.text()`）→ HMAC → 按 `X-Shopify-Topic` 分发：`app/uninstalled` → markUninstalled+tombstoneAll；`shop/redact` → 按 shop_domain purge 该店 store_* 数据；`customers/data_request`、`customers/redact` → 无客户数据，记录后 200 |

### 客户端库与 UI
| 文件 | 类型 | 职责 |
|---|---|---|
| `web/src/lib/pinDraftSync.ts` | C | WP0 写穿引擎：订阅 `DRAFT_STORE_EVENT`（`pinDraftStore.ts:26`）→ 与上次快照按 `(id, updatedAt)` diff → outbox（changed/deleted）→ 1.5s debounce 批量 PUT/DELETE（Bearer=supabase session）；启动时 GET 全量分页 → `mergeServerDrafts` LWW 合并 → 以合并结果 seed diff 基线（本地独有/更新的草稿自然进入 outbox = **migration-on-first-load**，无需一次性标志位）；失败退避重试，localStorage 仍为缓存/离线层（裁决 c） |
| `web/src/lib/pinDraftStore.ts` | M | 仅两处 additive：① `mergeServerDrafts(serverDrafts, deletedIds)` 内部合并（逐条 updatedAt LWW，写 localStorage + emit）；② 审核全部 40 个 mutation 确保写路径都 bump `updatedAt`（现 `updateDraft:560` 已做，个别未 bump 的补齐）。store API 表面不变（裁决 c） |
| `web/src/lib/pinMetadata.ts` | M | `ProductSourceKind`（`:18-24`）加 `"shopify"`；`normalizeProductSource` 加 case；`productSourceLabel` 加 `"Shopify"`（裁决 d） |
| `web/src/lib/shopifyFlag.ts` | C | `NEXT_PUBLIC_SHOPIFY_INTEGRATION` + localStorage `vp:shopify_integration` override，**默认 off**；结构照抄 `studioBoardFlag.ts:28-57` |
| `web/src/lib/shopifyClient.ts` | C | status（60s 客户端缓存）/connect/sync 循环驱动/products 查询/disconnect 的 Bearer fetch 封装 + 类型 |
| `web/src/lib/settingsPaths.ts` | M | 加 `SETTINGS_SHOPIFY_PATH = "/app/settings/shopify"` |
| `web/src/app/app/settings/shopify/page.tsx` | C | null 页（照 `settings/pinterest/page.tsx:1-4`），由 AppLayout 检测路径开 modal |
| `web/src/app/app/settings/integrations/page.tsx` | M | redirect 目标 `SETTINGS_PINTEREST_PATH` → `SETTINGS_SHOPIFY_PATH`（裁决 a，§7A Preferences URL） |
| `web/src/app/app/layout.tsx` | M | 路径→tab 映射（`layout.tsx:346-371`）加 `/app/settings/shopify` → tab `"shopify"` |
| `web/src/components/settings/ShopifyTab.tsx` | C | 管理面全部 UI（§7 UI 计划），独立文件避免再撑大 SettingsModal |
| `web/src/components/settings/SettingsModal.tsx` | M | `SettingsTab` union + TABS（`:1179-1191`）插入 `{id:"shopify", label:"Shopify", testId:"settings-tab-shopify"}`（brand 名用 literal label，flag off 时过滤不显示）+ 渲染分支 |
| `web/src/components/studio/ShopifyProductPickerPanel.tsx` | C | 共享面板：搜索/筛选/行卡/详情预览/单选(ProductSelection 模式)与多图选择(asset 模式)两种输出 |
| `web/src/components/studio/ProductPickerModal.tsx` | M | 加 `shopify` tab（`:77, :342-347`）+ `sourceBadge` 映射（`:62-68`）+ saveToLibrary 勾选逻辑沿用 `:426-431` |
| `web/src/components/studio/InlineCreateAssetPicker.tsx` | M | 加 Shopify source 区（内嵌共享面板，多图输出到 role="product" 资产回调） |
| `web/src/components/studio/StudioBoard.tsx` | M | header `[Select product]`（`:358-363`）+ 空状态链接（`:379-396`）+ 确认后 `createBoardDraft` 产品→草稿映射（§3.6） |
| `web/src/components/studio/PinDetailsDrawer.tsx` | M | 产品卡（`:1126-1169`）支持 shopify source chip；`productId` 为 shopify 时抓 `/products/[id]` 新鲜度 → stale/deleted 警告徽标；use-as-destination 警告文案 |
| `web/src/lib/ai-copy/generatePinCopy.ts` | M | `inferProductContext`（`:60-84`）扩 vendor/tags/price/availability |
| `web/src/app/api/ai-copy/route.ts` | M | `ProductContext` 类型 + `buildContextBlock`（`:119-126`）扩字段；shopify 产品图 SSRF allowlist 校验挂点 |
| `web/src/app/api/ai-copy/analyze/route.ts` | M | 同上 SSRF allowlist 校验 |
| `web/.env.example` | M | 追加 `SHOPIFY_CLIENT_ID/CLIENT_SECRET/REDIRECT_URI/API_VERSION=2026-07/TOKEN_ENCRYPTION_KEY/SCOPES/APP_URL` + `SHOPIFY_PRODUCT_LIMIT_FREE|STARTER|PRO|BUSINESS`（entitlement env 覆盖，缺省 0/100/500/1000）+ `NEXT_PUBLIC_SHOPIFY_INTEGRATION`。命名以用户 2026-07-11 已配置的 Vercel/本地变量为准；另有 `SHOPIFY_OAUTH_STATE_SECRET`、`SHOPIFY_INTEGRATION_ENABLED` 已存在但暂不消费（state seal 直接用 TOKEN_ENCRYPTION_KEY；UI flag 必须用 NEXT_PUBLIC_ 前缀变量） |
| `web/package.json` | M | 新增 test scripts（§9） |

注意：`web/AGENTS.md` 警告本仓库 Next.js 与常识版本有差异——执行代理写任何 route/页面前先读 `node_modules/next/dist/docs/` 对应章节。

---

## 6. API 契约

通用：错误 `{error: string, code: string}` + 语义 status（401 `unauthorized` / 400 `bad_request` / 403 `plan_limit_stores` / 404 `not_found` / 409 `sync_in_progress`·`not_connected` / 413 `payload_too_large` / 500 `config_error` / 502 `upstream_error` / 503 `database_unavailable`），映射范式照 `routeHelpers.ts:22-67`。

### 6.1 `/api/pin-drafts`（WP0）
- **GET** `?cursor&limit=100` → `{drafts: [{draftId, updatedAt, deletedAt?, payload}], nextCursor?}`（按 updated_at desc, draft_id 稳定排序；含 tombstone 供本地删除收敛）
- **PUT** body `{drafts: [{draftId, updatedAt, payload}]}`（≤50/批）→ `{applied, skippedStale}`（服务端 LWW：incoming.updatedAt < 行内 → skip）
- **DELETE** body `{draftIds: string[], deletedAt}` → `{applied}`（tombstone）

### 6.2 connect
- **POST** `{shopDomain: "x.myshopify.com"}` → 200 `{url}`（authorize URL；同时 Set-Cookie sealed state）
- 错误：400 `invalid_shop_domain` / 403 `plan_limit_stores` / 409 `already_connected`（同店活跃连接存在→前端引导 Reconnect）/ 500 `config_error`
- **GET** `?shop=…` → 302 authorize（cookie session；失败 302 `/app/settings/shopify?shopify=<code>`）

### 6.3 launch（GET，Shopify App URL）
- query `shop, hmac, timestamp…` → HMAC 通过 + 已登录 → 302 authorize；未登录 → 302 login+returnTo；HMAC 失败 → 401 `hmac_invalid`

### 6.4 callback（GET）
- 成功 → 302 `/app/settings/shopify?shopify=connected`
- 失败 → 302 `?shopify=state_mismatch|hmac_invalid|token_exchange_failed|plan_limit_stores|config_error`

### 6.5 status（GET）
```json
{ "configured": true, "connections": [{
    "id": "uuid", "shopDomain": "x.myshopify.com", "shopName": "X Store",
    "status": "connected", "scopes": ["read_products"],
    "lastFullSyncAt": "…", "sync": { "status": "limit_reached", "syncedCount": 100,
      "totalCount": 342, "cursor": null, "error": null, "startedAt": "…", "resumable": false } }],
  "plan": { "key": "starter", "maxStores": 1, "maxSyncedProducts": 100 } }
```
未连接/表未应用 → `{configured, connections: [], plan}`（200，不报错）。token 类字段永不出现。

### 6.6 sync（POST）
- body `{connectionId}` → 200 `{state: "running", hasMore: true, syncedCount, totalCount?, cursor}`（客户端见 hasMore=true 继续 POST）｜终态 `{state: "completed"|"limit_reached"|"error", syncedCount, totalCount, error?}`
- 409 `sync_in_progress`（锁未过期且非本 run）；409 `not_connected`。plan 店数限额不在此路强制（同步仅受商品 cap，以 state=limit_reached 表达）

### 6.7 products（GET，picker 查询）
- `?connectionId&q&status=active|draft|archived&includeDeleted=false&cursor&limit=30`
- → `{products: [{id, title, handle, productUrl, adminUrl, status, availability, vendor, productType, tags, price: {amount, currency, compareAt?}, primaryImageUrl, imageCount, updatedAtSource, deletedAt?}], nextCursor?}`
- 排序 updated_at_source desc；默认过滤 `deleted_at is null`

### 6.8 products/[id]（GET，详情 + 新鲜度）
- → 上述行字段 + `{images: [{id, url, width, height, altText, position}], stale: {deleted: bool, archived: bool, unavailable: bool}}`；404 `not_found`（已被 purge → 前端按 deleted 处理）

### 6.9 disconnect（POST）
- body `{connectionId}` → `{ok: true}`（吊销尽力而为；连接 status=disconnected、token null、商品全部 tombstone；草稿引用保留=stale）

### 6.10 webhooks（POST，单端点分发）
- 校验 `X-Shopify-Hmac-Sha256`（base64 HMAC-SHA256(raw body, SHOPIFY_CLIENT_SECRET)，`safeEqual`）失败 → 401
- `X-Shopify-Topic`: `app/uninstalled` | `customers/data_request` | `customers/redact` | `shop/redact`；处理成功一律 200 `{ok: true}`；幂等（重复投递安全）

---

## 7. UI 计划（逐屏，全部 flag 门控）

### 7.1 Settings → Shopify tab（唯一管理面；新 `ShopifyTab.tsx`，结构照 PinterestTab `SettingsModal.tsx:451-634` / AmazonTab `:729`）
- **未连接**：说明文案 + shop 域名输入 + `[Connect Shopify]`（POST connect → 跳授权）；free plan → 按钮替换为升级引导（entitlement 来自 status.plan）。
- **已连接**：店名 + 域名 + 状态点（connected 绿/degraded 黄/reauth_required 红）+ 已授 scopes + last synced + `[Sync now]` `[Disconnect]`；引导语 "Find your products in Create Pins → Select product"。
- **同步中**：进度条 `Synced {syncedCount}{totalCount ? ` of ${totalCount}` : ""}`，Sync now 禁用；客户端循环驱动（`shopifyClient.ts`）。中断后回来：resumable=true → `[Resume sync]`。
- **limit_reached**：横幅 "Synced 100 of 342 products — most recently updated first. Upgrade to sync more." + 升级链接（决策 3 不静默截断）。
- **error**：`sync_error` 摘要 + `[Retry]`（续传）。
- **reauth_required**：红色条 + `[Reconnect]`（重走 OAuth 覆盖凭证）。
- **disconnected（卸载/断开后）**：历史店名 + `[Connect again]`；提示已同步商品已归档、草稿引用保留。
- OAuth 回跳 `?shopify=<code>` toast/错误条在 tab 内消化（照 PinterestTab 处理 `?pinterest=` 的模式）。

### 7.2 Create Pins（StudioBoard）
- Header 动作组（`StudioBoard.tsx:358-363`）：`[Select product]` 次级按钮，位于 History 旁；仅 flag on 显示（连接与否都显示，未连接时打开的 picker tab 呈连接引导空态）。Upload-first 不变（§2）。
- 空状态（`:379-396`）：主 CTA "Upload images" 不动；次级链接行加 "Create from your store? **Select a product**"（与 "No image yet? Create with AI" 并列）。
- 确认选择 → 每个选中商品创建一张 Unscheduled 卡（§3.6 映射）；多图选择时首图为卡面。

### 7.3 ProductPickerModal — Shopify tab（`ProductPickerModal.tsx` 扩展）
- Tab 排序：`recommended / my_products / shopify / use_link / create`；tab 徽标 "Shopify"。
- 状态：**loading**（骨架行）/ **empty-连接了没商品**（"No products synced yet — Sync now in Settings" + 打开 Settings 链接）/ **disconnected**（"Connect your Shopify store" + Open Settings）/ **failed**（重试）/ **搜索无结果**。
- 行卡：主图 60px + 标题 + `Shopify · active · $19.99 · 4 images`；tombstone 默认隐藏（决策 8）；archived/draft 有状态筛选可见。
- 详情预览：行内展开多图缩略 + description 摘要 + [View in Shopify]（adminUrl）。
- 底部：`asPrimary` 开关沿用（`:182`）、`saveToLibrary` 勾选沿用 use_link 模式（`:426-431`），默认不勾（决策 5）。

### 7.4 InlineCreateAssetPicker — Shopify source（AI Drawer 用，`AiVersionDrawer.tsx:430-442` 宿主）
- 现有 source 区追加 "From Shopify"，内嵌同一 `ShopifyProductPickerPanel`（多图模式）；选中图追加进 Product images 区（当前 Pin 图保持 #1，§3.3 任务书与 `AiVersionDrawer.tsx:225` 现状一致）；商品 title/productUrl 进 `productMetadata`。
- 未连接：source 区显示同 7.3 disconnected 空态。

### 7.5 PinDetailsDrawer 关联产品（`PinDetailsDrawer.tsx:1126-1169` 扩展）
- Primary 产品卡 source chip 显示 "Shopify"（`productSourceLabel`）；价格/店名来自快照。
- **stale/deleted 警告**：`source === "shopify"` 且有 `productId` → drawer 打开时经 `/products/[id]` 新鲜度检查（60s 客户端缓存）：deleted/404 → 琥珀徽标 "Product no longer in your store"；archived → "Product archived"；out_of_stock → 灰色小字。徽标独立，不改 Unscheduled/Scheduled/Posted 生命周期（§2）。
- "Use as destination URL"（`:540-552, :1076-1079, :1163-1164`）零逻辑改动；当产品 stale/deleted 时 confirm 文案追加警告（§4G：警告不阻塞）。
- 发布/排期时刻的轻量新鲜度检查（决策 10）：调度与 Publish now 入口前置同一 freshness 调用，结果仅 toast 警告。

### 7.6 Batch Edit
- 零改动：URL "product" 模式（`BatchEditDrawer.tsx:993-997`）对 shopify 快照 URL 天然生效；展示层产品名/来源已有。WP7 补测试与文案核对。

---

## 8. 迁移策略

1. **v32–v37 盘点提醒**：执行 v38/v39 前先在 SQL Editor 确认 v32(social)/v33(customer360)/v34(audit)/v35(support_tickets)/v36(keyword rank)/v37(pin_save_snapshots) 的实际应用状态（审计 B1 需验证项）。v38/v39 与它们无依赖，可独立先行。
2. **手工 DDL**：§4 两份文件即为可直接粘贴执行的草稿；均 additive + idempotent，可重复执行。
3. **优雅降级**（裁决 i）：`pin_drafts` 未应用 → `/api/pin-drafts` GET 返回空、PUT 静默 202（客户端 outbox 保留重试），前端行为=现状纯 localStorage，**零回归**；`store_*` 未应用 → status 返回未连接态，picker tab 呈连接引导。全部走 `isMissingTableError` 模式（`errors.ts:19-25`）。
4. **Feature flag**：`NEXT_PUBLIC_SHOPIFY_INTEGRATION`（默认 off）+ localStorage `vp:shopify_integration` dev override，照 `studioBoardFlag.ts` 三级解析。flag 只控 UI 表面（Settings tab / picker tab / StudioBoard 入口 / drawer chip）；launch/callback/webhooks 路由不受 flag 控制（Partner dashboard 已锁 URL）。WP0 草稿同步不挂此 flag（独立价值，独立发布）。
5. **草稿上迁与回滚**：migration-on-first-load 是收敛协议的自然结果（§5 pinDraftSync）——首次启动 GET 服务端为空 → 本地 500 条以内草稿全部进入 outbox 批量上行；任何一批失败仅重试，不丢本地。回滚 = 停用 pinDraftSync 初始化调用（一行），本地 localStorage 始终保有全量镜像，无数据风险；`pin_drafts` 表留存不影响任何现有查询。
6. **不破坏现有工作流论证**：① 所有 store/组件改动 additive（新增 tab/source/字段，未动任何现有分支）；② `ProductSourceKind` 加值——`normalizeProductSource` default 分支保证旧数据不受影响；③ publish/schedule/rebalance/pinReadiness 零触碰；④ flag off 时 UI 与今日逐像素一致；⑤ WP0 写穿失败时行为=现状。

---

## 9. 测试计划（按审计 B12 惯例）

**tsx 脚本单测**（`web/scripts/test-*.ts`，串行进 `npm run test`；新增单项 script）：
| script | 覆盖 |
|---|---|
| `test:pin-draft-sync` → `web/scripts/test-pin-draft-sync.ts` | diff/outbox、LWW 合并（本地新/服务端新/相等）、tombstone 收敛、首载上迁、500 上限、退避重试队列 |
| `test:shopify-hmac` → `web/scripts/test-shopify-hmac.ts` | launch query HMAC（正/负/参数重排/缺参）、webhook body HMAC（正/负/篡改）、timing-safe |
| `test:shopify-oauth-state` → `web/scripts/test-shopify-oauth-state.ts` | state 生成/seal/unseal、过期、uid 不匹配、shopDomain 不匹配、单次使用、returnTo 白名单 |
| `test:shopify-normalize` → `web/scripts/test-shopify-normalize.ts` | GraphQL node→行、availability 派生矩阵、HTML→纯文本、product_url 回退、GID 解析、多 workspace 键 |
| `test:shopify-sync-engine` → `web/scripts/test-shopify-sync-engine.ts` | 状态机全转移、锁 CAS/过期接管/陈旧 run_id 拒写、幂等 upsert、entitlement 截停（99→100 边界）、tombstone 清扫、THROTTLED 退避（mock store/client） |
| `test:shopify-entitlements` → `web/scripts/test-shopify-entitlements.ts` | 四档 plan 解析（user_metadata/白名单/缺省 free）、maxStores/maxSyncedProducts 数值 |
| `test:shopify-product-selection` → `web/scripts/test-shopify-product-selection.ts` | 行→ProductSelection/LinkedProduct 映射、saveToLibrary 默认 false、source badge/label、`normalizeProductSource("shopify")` |
| `test:shopify-ai-grounding` → `web/scripts/test-shopify-ai-grounding.ts` | inferProductContext 扩字段、buildContextBlock 输出、contextUsed 不含原始 payload、SSRF allowlist 判定 |

**Playwright e2e**（`web/tests/e2e`，`E2E_TEST_MODE`，mock API）：
- `shopify-settings.spec.ts`：tab 出现（flag on）/ connect 表单校验 / 同步进度与 limit_reached 横幅 / disconnect 确认 / `?shopify=connected` toast。
- `shopify-picker.spec.ts`：StudioBoard Select product → picker Shopify tab → 搜索 → 确认建卡（destinationUrl 为空断言）→ drawer 产品卡 chip + Use-as-destination confirm 流。

**dev store 手工冒烟**（发布门禁）：真 OAuth 全链、≥1 商品同步、断开重装、卸载 webhook（dev store 卸载 app）、GDPR webhook 用 Partner dashboard 测试投递、坏 token（改库触发 reauth_required）、删除商品后 Sync now → tombstone → drawer 警告。

---

## 10. 工作包

**WP0 — 草稿服务端权威持久化（前置，决策 6 / 裁决 c）**
- 目标：pin_drafts 服务端权威 + 写穿 + 启动合并 + 首载上迁；store API 表面零改动。
- 依赖：无。文件：`migrate_v38_pin_drafts.sql`、`api/pin-drafts/route.ts`、`pinDraftSync.ts`、`pinDraftStore.ts`(M, additive)、app 初始化挂载点（`web/src/app/app/layout.tsx` 一行 init）。
- 验收：两浏览器 profile 间草稿收敛；断网编辑→恢复后上行；服务端 skipStale 生效；表未应用时零回归。
- 测试：`test:pin-draft-sync` + 手工双设备。风险：mutation 未 bump updatedAt 的漏网（WP0 内审全部 40 个导出）；payload 体积（413 上限+分页）。**可独立合并 ✔**（对用户不可见，dark launch）。

**WP1 — v39 schema + 存储层 + entitlements**
- 目标：四张 store_* 表 + connectionStore/productStore + entitlements 模块。
- 依赖：无（与 WP0 并行）。文件：`migrate_v39_shopify_store_sync.sql`、`server/shopify/connectionStore.ts`、`productStore.ts`、`server/entitlements.ts`、`crypto.ts`(M)。
- 验收：CRUD/CAS 锁/降级单测过；无任何 UI/route 暴露。测试：`test:shopify-entitlements` + store 层纳入 `test:shopify-sync-engine` mock。风险：低。**可独立合并 ✔**

**WP2 — OAuth + webhooks**
- 目标：launch/connect/callback/status/disconnect + 单 webhook 端点（3 GDPR + uninstalled）+ hmac/oauthState/config。
- 依赖：WP1。文件：§5 对应 routes + `server/shopify/{config,hmac,oauthState}.ts`、`.env.example`(M)。
- 验收：dev store 真连接成功、token 密文落库、HMAC 负例 401、卸载 webhook 置 disconnected+tombstone、`already_connected`/`plan_limit_stores` 生效。
- 测试：`test:shopify-hmac`、`test:shopify-oauth-state`。风险：Shopify 侧配置联调（§7A）。**可独立合并 ✔**（无 UI，routes dark）

**WP3 — 分片同步管线 + products 查询**
- 目标：syncEngine + normalize + adminClient + sync/products/products[id] routes。
- 依赖：WP1、WP2。验收：dev store 全量同步、断点续传（中途杀请求→Resume）、limit_reached 截停 + total_count、tombstone 清扫、409 并发拒绝。
- 测试：`test:shopify-normalize`、`test:shopify-sync-engine`。风险：GraphQL cost 调参（页大小可配）。**可独立合并 ✔**（无 UI）

**WP4 — Settings Shopify tab**
- 目标：§7.1 全部状态 + integrations redirect 改指 + layout 映射 + `shopifyFlag.ts` + `shopifyClient.ts`。
- 依赖：WP2（connect/status）、WP3（sync UI）。文件：`ShopifyTab.tsx`、`SettingsModal.tsx`(M)、`settingsPaths.ts`(M)、`settings/shopify/page.tsx`、`settings/integrations/page.tsx`(M)、`layout.tsx`(M)。
- 验收：flag off 无痕；on 时七种状态可达；`?shopify=` 回跳消化。测试：`shopify-settings.spec.ts`。风险：SettingsModal 大文件合并冲突（改动收敛在 TABS+分支两处）。**可独立合并 ✔**（flag off）

**WP5 — Picker 集成（Create Pins + AI Drawer）**
- 目标：共享面板 + ProductPickerModal tab + InlineCreateAssetPicker source + StudioBoard 入口 + 产品→草稿创建 + `pinMetadata.ts` source 扩展。
- 依赖：WP3（products API）、WP0（关联跨设备权威）、WP4（连接引导跳转）。
- 验收：选中→建 Unscheduled 卡、destinationUrl 空、linkedProducts 快照齐、saveToLibrary 默认不入库、AI Drawer 多图追加、未连接空态。
- 测试：`test:shopify-product-selection`、`shopify-picker.spec.ts`。风险：`web/src/app/app/studio/page.tsx` 并发编辑警告（memory 提示）——只改 StudioBoard.tsx，不碰 page.tsx。**可独立合并 ✔**（flag off）

**WP6 — AI grounding**
- 目标：productContext 扩字段 + SSRF allowlist + contextUsed 校验。
- 依赖：WP5。文件：`generatePinCopy.ts`(M)、`api/ai-copy/route.ts`(M)、`api/ai-copy/analyze/route.ts`(M)。
- 验收：shopify 草稿生成的 copy 请求含 vendor/tags/price、contextSourcesUsed 含 "product"、CDN 图走视觉链路成功、非本人产品图 URL 拒绝。测试：`test:shopify-ai-grounding`。风险：低（挂点现成）。**可独立合并 ✔**

**WP7 — 目的地安全 + 关联展示**
- 目标：PinDetailsDrawer shopify chip + stale/deleted 警告 + 发布/排期时刻 freshness 警告 + Batch product 模式回归验证。
- 依赖：WP5。验收：deleted 产品显示徽标且生命周期不变、use-link 警告确认、Batch product 模式对 shopify URL 生效。测试：并入 `shopify-picker.spec.ts` + `test:shopify-product-selection` 补断言。**可独立合并 ✔**

**WP8 — QA/安全/发布加固**
- 目标：dev store 全链冒烟、多 workspace 隔离验证（两账号互不可见）、webhook 幂等、日志脱敏复查（token/HMAC 不出日志）、`npm run test` + `next build` 全绿、发布门禁清单执行。
- 依赖：WP0–WP7。**不可独立合并**（验收性质）。

---

## 11. 结尾五件套

**① 推荐实施顺序**：WP0 ∥ WP1 → WP2 → WP3 → WP4 → WP5 → WP6 ∥ WP7 → WP8。（WP0 与 WP1–WP3 完全并行；WP5 合并前 WP0 必须已上线。）

**② 推荐首个 PR**：**WP0**（`migrate_v38_pin_drafts.sql` + `/api/pin-drafts` + `pinDraftSync.ts`）。理由：关键路径最长项、对用户完全 dark、独立可测、失败可一行回滚；同周可并行开 WP1 PR。

**③ 执行代理不得触碰的区域**：发布管线（`/api/pinterest/pins`、publish 锁）、`pinReadiness`、排期/rebalance/Smart Schedule 逻辑、`web/src/app/app/studio/page.tsx`（4605 行 legacy+v2 宿主，只改 `StudioBoard.tsx`）、Pinterest OAuth 各模块（`crypto.ts` 仅 additive 工厂）、`/api/import/product-urls`（不修不仿）、`pin_products` 爬虫体系与 VPS 管线、i18n catalog 结构（仅加 key）、`creatorProductLink` 的 Amazon 语义。另：写代码前读 `node_modules/next/dist/docs/`（`web/AGENTS.md` 版本警告）。

**④ 最小浏览器可演示里程碑**（任务书 §10 建议）：dev store 从 Settings Shopify tab 连接 → Sync now 同步 ≥1 商品（进度条到 completed）→ Create Pins `[Select product]` 选中该商品建 Unscheduled 卡 → AI Copy 生成含产品 grounding（contextSourcesUsed 含 product）→ drawer 显式 "Use as destination URL" → 排期。需要：WP1–WP5 + WP6 最小挂点（WP0 可后置于演示但不后置于发布）。

**⑤ 发布门禁清单**：
1. Partner dashboard scopes 改为仅 `read_products`（§7A 待修正项 1）；
2. 三个 GDPR webhook URL 配置为 `https://vibepin.co/api/integrations/shopify/webhooks`（待修正项 2），投递测试通过；
3. Vercel 生产 env：`SHOPIFY_CLIENT_ID/CLIENT_SECRET/REDIRECT_URI/API_VERSION=2026-07/TOKEN_ENCRYPTION_KEY`（独立密钥，非 Pinterest 共用）——用户已于 2026-07-11 配置，**但 REDIRECT_URI/APP_URL 曾指向一次性部署域名，需确认已改为 `https://vibepin.co/...`**；UI 灰度另需 `NEXT_PUBLIC_SHOPIFY_INTEGRATION`；
4. SQL Editor：v32–v37 应用状态盘点 → 执行 v38、v39 并回读验证（表存在 + RLS on + 无 policy）；
5. `npm run test` 全绿 + `next build` 通过 + 两条 Playwright spec 通过；
6. dev store 冒烟：连接/同步/断开/重装/卸载 webhook/坏 token reauth/删除商品 tombstone；
7. 多账号隔离抽查（A 的店与商品对 B 完全不可见，含 picker 与 API 直调）；
8. 日志与响应脱敏复查（access_token、HMAC secret、state 不出现在任何日志/响应/客户端）；
9. `NEXT_PUBLIC_SHOPIFY_INTEGRATION` 灰度开启（先内部账号 localStorage override 验证，再全量）。
