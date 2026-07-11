# Shopify 商品同步 Phase 1 — 仓库审计报告（Step 1）

> 审计日期：2026-07-11。只读审计，未修改任何产品代码。
> 依据：《同步shopify商品功能-规划任务书-v2修正版.md》§1 / §7 / §8。
> 分类口径：**已验证**（事实成立，可直接依赖）/ **可复用但不完整**（存在但需扩展或有出入）/ **缺失**（不存在，需新建）/ **需验证**（仓库内无法确证，需外部核实）。
> 所有路径为仓库内绝对定位（相对 `d:\代码\Pinterest flow\`）。

---

## A. 执行摘要

仓库**基本就绪**：OAuth/加密模板（Pinterest 全链路）、ProductSelection/creatorProductLink 产品关联体系、Batch Edit "product" URL 模式、AI Copy 的 productContext 挂点与服务端图片转 bytes 能力全部真实存在且质量良好，Shopify 可按任务书方案以"新 source"接入。但有三个最大风险：**① 决策 6 的前置项被触发** —— Pin 草稿（`pinDraftStore.ts`）是纯 localStorage 存储，没有任何服务端权威持久化，"persist-failure Retry" 只是 localStorage 配额重试；产品关联字段全部挂在这份本地数据上，跨设备不可见。为草稿补服务端权威持久化是 Phase 1 必做前置工程，且是整个项目最大的单项工作量。**② 套餐 entitlement 基建缺失** —— 现有 gating 只有一个 email 白名单布尔值（`useUserTier.ts`），没有 per-plan 可配置限额模块，决策 3 的 100/500/1000 限额与"Free 不可连店"需要新建 entitlement 层。**③ Settings → Integrations 页面实际不存在** —— `settings/integrations/page.tsx` 只是 5 行 redirect 到 Pinterest 设置 tab，Settings 整体是 modal+tabs 架构，Shopify 管理面需要新建 tab 或把 integrations 改造成真页面（§7A 的 Preferences URL 当前落在 Pinterest tab 上）。此外 web 应用没有任何 webhook 接收端点与 HMAC 验签基建，GDPR webhooks 需从零建（但 `crypto.ts` 的 timing-safe 比较可复用）。无硬性技术阻塞项。

---

## B. 逐项事实清单

### B1. 数据库与 ORM

| 结论 | 事实 | 位置 |
|---|---|---|
| 已验证 | ORM 无（无 Prisma/drizzle/pg），统一用 `@supabase/supabase-js` REST 客户端。浏览器 anon 单例 + 服务端 service-role 客户端（bypass RLS，本地无 key 时回退 anon） | `web/src/lib/supabase.ts:12`（anon 单例）、`:15-19`（createServerClient service-role） |
| 已验证 | 迁移目录：`backend/db/migrate_v2.sql` … `migrate_v37_pin_save_snapshots.sql`（连续编号，最新 v37）。web 专属表另有 `api/migrations/001_pinterest_connections.sql` | `backend/db/`（Glob 确认 v2–v37 全在）、`api/migrations/001_pinterest_connections.sql` |
| 已验证 | DDL 执行约定：手工在 Supabase SQL Editor 执行（"raw :5432 is proxy-blocked"），迁移写法要求 additive + idempotent（`IF NOT EXISTS`），敏感表开 RLS 且**不加任何 permissive policy**（只允许 service-role 访问） | `backend/db/migrate_v36_keyword_expansion_rank.sql:8`（SQL Editor 约定原文）、`migrate_v35_support_tickets.sql:3-13`（additive/idempotent/RLS 约定）、`api/migrations/001_pinterest_connections.sql:51-54`（RLS no-policy 模式） |
| 已验证 | 代码普遍对"表未应用"做优雅降级：missing-table 错误当作空数据/静默回退，不抛 500 | `web/src/lib/social/server/socialConnectionStore.ts:215`（v32 未应用 → 返回 []）、`web/src/lib/server/pinterest/errors.ts:19-25`（isMissingTableError）、`web/src/lib/studioPersistence.ts:666-688`（缺列回退 insert） |
| 需验证 | authored-not-applied 队列：任务书断言 v32/v33/v34 排队未应用；此外仓库还有 **v35（support_tickets）、v36（keyword_expansions.rank）、v37（pin_save_snapshots）**，其应用状态无法从代码确证（代码全部做了降级，跑起来看不出）。Shopify 迁移应编号 **v38 起** | `backend/db/migrate_v35_support_tickets.sql`、`migrate_v36_*.sql`、`migrate_v37_*.sql` |

### B2. 认证与 workspace

| 结论 | 事实 | 位置 |
|---|---|---|
| 已验证 | Supabase Auth。两套仓库级约定：JSON API 走 `Authorization: Bearer <access token>`；浏览器导航路由（OAuth connect/callback）走 Supabase SSR cookie session。统一 helper 集中在 `authUser.ts`，带 60s verified-token 内存缓存 | `web/src/lib/server/authUser.ts:47`（getUserIdFromBearer）、`:55`（getUserIdFromCookies）、`:87`（getUserIdFromBearerOrCookies）、`:96`（getUserIdFromCookieSession，免网络验证的导航守卫）、`:26-28`（60s 缓存） |
| 已验证 | 典型 route 鉴权示例：① `/api/studio/upload` → `getUserIdFromBearer`（`web/src/app/api/studio/upload/route.ts:44`）；② `/api/pinterest/pins` → `getUserIdFromBearerOrCookies`（`web/src/app/api/pinterest/pins/route.ts:38`）；③ `/api/auth/pinterest/connect` GET 用 cookie session（`route.ts:163`）、POST 用 Bearer-或-cookie（`route.ts:222`）；④ 旧式 route 内联 Bearer 校验（`web/src/app/api/composer-drafts/route.ts:42-54`） | 如左 |
| 已验证（重要出入） | **不存在 workspace 数据模型**。所有归属都是单用户键：`pinterest_connections.vibepin_user_id`（unique，`api/migrations/001:34`）、`composer_drafts.user_id`、`pin_generations.user_id`。任务书/决策 6 中的 "workspace" 在本仓库现实中 = Supabase user id。Admin 的 Customer 360 "workspaces" 是管理端派生视图，不是归属模型 | `web/src/lib/server/pinterest/connectionStore.ts:18`、`web/src/app/api/composer-drafts/route.ts:120`、`web/src/lib/server/customer360.ts` |
| 需注意 | 也存在**完全无鉴权**的 API route（`/api/import/product-urls`，匿名可触发服务端抓取任意 URL）——Shopify 新 route 不应沿用该先例 | `web/src/app/api/import/product-urls/route.ts:6-40` |

### B3. Pinterest OAuth 全链路（Shopify OAuth 模板评估）

| 结论 | 事实 | 位置 |
|---|---|---|
| 已验证 | `connect/route.ts`：GET（浏览器导航，302 到授权页）+ POST（JSON，返回 `{url}`，"Connect" 按钮热路径）双入口；配置校验（enc key + app env）→ 生成 state → sealed cookie → redirect。错误统一 `{error, code}` 或 redirect `?pinterest=config_error` | `web/src/app/api/auth/pinterest/connect/route.ts:155-203`（GET）、`:212-253`（POST） |
| 已验证 | `oauthState.ts`：state = `randomBytes(32).toString("base64url")`（`:59-61`）；`{state, uid, exp, returnTo}` 用 AES-GCM seal 进 HttpOnly cookie（`:63-71`），TTL 10 分钟（`:26`），callback 验证 state 匹配 + uid 匹配 + 未过期后**单次使用清除**（`:81-92`）；returnTo 强制同源 `/app/*` 白名单（`:29-39`）；另有明文 returnTo cookie 仅用于失败回跳（`:17-25`） | `web/src/lib/server/pinterest/oauthState.ts` |
| 已验证 | `crypto.ts`：AES-256-GCM，输出 `"v1:" + base64(iv|ct|tag)`（`:22-25`）；密钥来自 env `PINTEREST_TOKEN_ENC_KEY`（32 字节，base64 或 hex，`:30-62`）；`sealJson/unsealJson`（`:103-115`）；`safeEqual` timing-safe 比较（`:118-123`，可直接复用于 Shopify HMAC 验签比较） | `web/src/lib/server/crypto.ts` |
| 已验证 | `connectionStore.ts`：表 `pinterest_connections`；token 加密后落库、只在 API 调用前解密、绝不进响应（`toSafeStatus` `:237-252`）；`upsertConnection`（`:91`，onConflict vibepin_user_id）、`getActiveConnection` 120s 进程内行缓存（`:83-138`）、`decryptTokens`（`:141`）、`updateTokens`（`:154`）、`markNeedsReconnect`（`:201`）、`disconnect` 软断开（token 置 null + `disconnected_at`，`:210-226`）。连接状态字段：`needs_reconnect`(bool)、`disconnected_at`、`scopes[]`、`access/refresh_token_expires_at` | `web/src/lib/server/pinterest/connectionStore.ts` |
| 可复用但不完整 | **作为 Shopify OAuth 模板的差距**：① 每用户单连接（unique `vibepin_user_id`）→ StoreConnection 需 `(user_id, shop_domain)` 复合唯一键（多店 future-safe）；② 无四态状态机（现只有两个标志位）→ 需新增 connected/degraded/reauth_required/disconnected 字段；③ 无 shop-domain 校验、无 HMAC 验证概念（Shopify launch URL / webhooks 必需）；④ 无 sync cursor / lastFullSync / syncError 等同步态字段；⑤ 加密 key 名是 Pinterest 专名（`PINTEREST_TOKEN_ENC_KEY`），复用同一 key 还是新增 `SHOPIFY_TOKEN_ENC_KEY` 需在方案中定 | 同上 + `web/src/lib/server/pinterest/config.ts`（buildAuthorizeUrl 模式） |
| 已验证 | 另有多平台 social 连接体系（v32，cookie session、provider 枚举、mock provider），是"多 provider 连接管理 UI"更近的参照 | `web/src/lib/social/server/socialConnectionStore.ts`、`backend/db/migrate_v32_social_connections.sql`、`web/src/app/api/social/connect/route.ts` |

### B4. 现有产品体系（宿主）

| 结论 | 事实 | 位置 |
|---|---|---|
| 已验证 | `ProductSelection` 完整结构：`{id?, title, imageUrl?, url?, canonicalUrl?, store?, price?, currency?, source: string, asPrimary: boolean, saveToLibrary: boolean}`。**source 是自由 string 不是枚举**；badge 映射只认 `url/url_imported`→"URL Imported"、`product_signal/product_ideas`→"Product Ideas"、其余→"My Products"（`:62-68`）。新增 `"shopify"` source 只需扩 badge 映射 | `web/src/components/studio/ProductPickerModal.tsx:34-48`（类型）、`:62-68`（sourceBadge） |
| 已验证 | `asPrimary` 语义：picker 顶栏 "Link as Primary / Tagged" 开关，Pin 无 Primary 时默认 Primary（`:182`）；`saveToLibrary` 语义：仅 `use_link`/`create` tab 显示勾选框（`:426-431`），从 My Products 选择时恒为 true（`:257`）。**从库外 source 选择时 saveToLibrary 是逐个可选** —— 与决策 5 的"绝不自动灌入 My Products"兼容，Shopify tab 照抄 use_link 的勾选模式即可 | `ProductPickerModal.tsx:182-183, 251-259, 290-319, 426-431` |
| 已验证 | Picker tabs：`recommended / my_products / use_link / create`（`:77, :342-347`）；数据来源 = `assetStore.getByRole("product")`（`:201-212`，订阅刷新），非 API | `ProductPickerModal.tsx` |
| 已验证 | **My Products 库 = localStorage**：key `vp_assets_v1`，上限 200 条，按 imageUrl+role 去重；无服务端表 | `web/src/lib/assetStore.ts:56`（key）、`:96-109`（saveAsset）、`:107`（cap 200） |
| 已验证 | 草稿关联机制（两层）：① `PinDraft` 顶层字段 `linkedProducts?: LinkedProduct[]`、`primaryProductId?`、`productId?`、`creatorProductLinkId?`、`sourceProductImageUrl?`、`destinationUrlSource?`（`web/src/lib/pinDraftStore.ts:82-92`）；② `metadataDraft.primaryProduct / taggedProducts`（`LinkedProduct` 定义在 `web/src/lib/pinMetadata.ts:26-39`，经 `resolvePinProducts` 读、`writePinProducts` 写，`pinDraftStore.ts:589-618` syncPinMetadataStore 同步）。**`ProductSourceKind` 枚举（`pinMetadata.ts:18-24`）没有 shopify 值**，需扩展 | 如左 |
| 已验证 | affiliate 模块：`creatorProductLink.ts` — `CreatorProductLink`（`:27-40`），localStorage `vp:creator_product_links:v1`（`:62`）+ 可注入 repo 抽象（`:55-116`，已为换存储后端做了准备），`getOrCreateCreatorProductLink`（`:162-233`，按 productId+trackingId+marketplace 去重，**provider 硬编码 "amazon"**）；`amazonAffiliateSettings.ts` — localStorage `vp:amazon_affiliate_settings:v1`（`:21`），文件头自述 "No backend user-settings table exists yet"（`:5`）；`pinAffiliateInheritance.ts` — `applyCreatorProductLinkToPinDraft` 只填空 URL、manual 永不覆盖（`:41-74`），`preserveAffiliateContextOnRegenerate` 保留产品身份+目的地（`:83-101`） | `web/src/lib/affiliate/` |
| 已验证 | Weekly Plan handoff 保留产品上下文：`productId / creatorProductLinkId / sourceProductImageUrl / destinationUrlSource` 随 handoff 进入 PinDraft | `web/src/lib/pinDraftStore.ts:522-527` |
| 已验证 | `productUrlImportClient` 契约：`POST /api/import/product-urls` body `{urls: string[]}`（≤20）→ `{results: [{sourceUrl, sourceDomain, status(success/partial/blocked/unsupported/error/failed), title?, candidates?[{id,imageUrl,width,height,score,reason}], normalizedUrl?, provider?(含 "shopify"), …}]}`。服务端已有 **Shopify URL 适配器**（走 `/products/{handle}.json`）——是"逐 URL 抓取"，与 OAuth 同步无关，但证明 Shopify 数据形态已被消化过 | `web/src/lib/productUrlImportClient.ts:57-101`、`web/src/app/api/import/product-urls/route.ts`、`web/src/lib/productUrlImport/adapters/shopify.ts:21-40` |
| 已验证 | Batch Edit URL 四模式：`type DestUrlMode = "fill_empty" | "replace" | "product" | "clear"`；`product` 模式语义 = 每个选中 Pin 用**它自己的 primary product URL**，无产品 URL 的 Pin 原样跳过、不整批失败 | `web/src/components/studio/BatchEditDrawer.tsx:443`（类型）、`:993-997`（applyBulkDestination） |
| 已验证 | 单条 "Use product link as destination"：空则填、非空弹 `window.confirm` 确认后替换，绝不静默覆盖（与 §2 规则一致，Shopify 直接复用） | `web/src/components/studio/PinDetailsDrawer.tsx:540-552`（canUsePrimaryUrl + confirm）、`:1076-1079, :1163-1164`（两处按钮） |
| 已验证 | Edit Pin 关联产品展示（§3.4 要扩展的现状）：Primary 产品卡 = 缩略图 + 标题 + source chip + store + price + [Change] [Use as destination URL] [Edit link] [Remove]，`ProductPickerModal` 仅在此处与 BatchEditDrawer 场景被引用 | `web/src/components/studio/PinDetailsDrawer.tsx:24, :533-557, :1126-1169, :1291` |

### B5. Pin 草稿持久化（决策 6 关键验证项）

| 结论 | 事实 | 位置 |
|---|---|---|
| **已验证（决策 6 前置项触发）** | `pinDraftStore.ts` 是**纯客户端存储**：localStorage key `vp:pin_drafts:v1`（`:24`），上限 500（`:25`），全文件无任何 fetch/supabase 调用。内存缓存为一级真源、localStorage 为持久镜像（`:150-189`）；**"persist-failure Retry"（`hasPersistFailure`/`retryPersist`，`:192-205`）只处理 localStorage 配额写失败，与服务端无关**。跨设备打开时草稿无处可加载——每台设备是独立的 localStorage 集 | `web/src/lib/pinDraftStore.ts` 全文 |
| 已验证 | 现有的"服务端持久化"是另外两条通道，都不是 Pin Draft：① `pin_generations` 表 = **生成会话历史**（客户端 supabase 直写，running→completed 生命周期、setup_snapshot 快照）；② `composer_drafts` 表 = **Studio 预填上下文 handoff**（源页面 → Studio 导航前落库）。均不承载 PinDraft 的编辑/生命周期/产品关联 | `web/src/lib/studioPersistence.ts:502-549`（insert）、`:606-692`（running session）、`web/src/app/api/composer-drafts/route.ts:1-30`（自述用途） |
| 已验证 | 草稿图片已在服务端（Supabase Storage `generated` bucket，`/api/studio/upload` 返回稳定 publicUrl），**只有草稿元数据不在服务端** | `web/src/app/api/studio/upload/route.ts:1-19` |
| **明确回答** | **现有通道不满足"服务端权威、跨设备可见"。** Shopify 关联产品状态若按现状挂在草稿上，只存在于单设备 localStorage。按决策 6 原文，"为这些草稿补服务端持久化是 Phase 1 前置项"——需要新建 pin_drafts 服务端表 + 同步协议（扩展现有 PinDraft 模型与 store API，localStorage 降级为缓存层），这是 Phase 1 最大的一块新增工程，工作量应按独立 WP 计 | — |

### B6. AI 链路

| 结论 | 事实 | 位置 |
|---|---|---|
| 已验证 | `/api/ai-copy` 请求契约：`{draftId?, imageUrl?, destinationUrl?, category?, keyword?, language?, country?, length?(short/standard/seo-rich), mode?(initial/regenerate), previousCopy?, productContext?, boardContext?, imageAnalysis?(缓存分析→快路径), recommendedKeywords?}`。**`productContext {title, category, productUrl, attributes[]}` 已存在**（`route.ts:34`）——Shopify grounding 有现成挂点，扩字段即可（vendor/tags/price/availability） | `web/src/app/api/ai-copy/route.ts:34-64` |
| 已验证 | 响应契约：`{ok, requestId, pathUsed(fast_text/vision_fallback), output{title,description,altText,tags,keywords}, contextUsed{imageSummary, recommendedKeywords, boardName}, context{imageContext, productContext, pageContext, boardContext, keywordContext, …}, contextSourcesUsed[], contextSummary, contextDetails[], timingsMs, provider, model, promptVersion, fallbackUsed}`；错误 = `{ok:false, requestId, error, userMessage}`，422（图片/质量门），502（上游） | `route.ts:387-414`（成功）、`:415-423`（错误） |
| 已验证 | contextUsed 只含真实输入（imageSummary/recommendedKeywords/boardName，`:368-372`）；"product" 进入 contextSourcesUsed 的条件是 productContext.title/category 非空（`:363`）——与 §4F "只展示真实输入"要求兼容 | `route.ts:362-372` |
| 已验证 | keywordContext 接入点：慢路径在 vision 分析后调 `retrievePinterestKeywords`（`route.ts:319-331`，来源 `trend_keywords` 表，相关性优先），快路径信任上传时预计算的 keywords（`:255`）；上传时异步分析走 `/api/ai-copy/analyze` | `web/src/lib/ai-copy/keywordContext.ts:1-52`、`web/src/app/api/ai-copy/analyze/route.ts` |
| 已验证（改动极小） | `visionServer.ts` 图片输入：`fetchImageAsDataUrl` **已经是"服务端拉取任意公网 https 图片 → data-URL bytes"**，8s 超时、10MB 上限、content-type 校验；`safeImageUrl` 只挡 blob:/data:/localhost。Shopify CDN（cdn.shopify.com）https 直链**现状即可通过**，喂外部 CDN 图无需新机制——§1.6 说的"需要服务端拉取转 bytes"这一步已存在 | `web/src/lib/ai-copy/visionServer.ts:229-262`（fetch+限制）、`:106-118`（safeImageUrl）、`:98`（MAX_IMAGE_BYTES） |
| 需注意 | `safeImageUrl` 仅黑名单 localhost 系 hostname，无内网 IP/DNS-rebinding 防护；给它喂用户可控 URL 时的 SSRF 面在 Shopify 场景可通过"只允许本 workspace 已同步 ProductImage 的 URL"收敛 | 同上 |

### B7. AI Image Drawer（AiVersionDrawer）Product images 区

| 结论 | 事实 | 位置 |
|---|---|---|
| 已验证 | "Product images" 区存在（AssetStrip，label/helper/empty text/Add/Remove）；**Add 按钮当前接的是 `InlineCreateAssetPicker`（role="product"），不是 `ProductPickerModal`** —— 仓库有两套 picker：Edit Pin 用 ProductPickerModal，AI Drawer 用 InlineCreateAssetPicker。§3.3 "接到同一个 Picker" 需要把 Shopify source 同时接入两者（或借此收敛） | `web/src/components/studio/AiVersionDrawer.tsx:466-475`（区块）、`:371-375`（openProductPicker）、`:430-442`（InlineCreateAssetPicker host） |
| 已验证 | 从已有草稿打开时 productImages 默认 = 当前 Pin 图（`draft.imageUrl`），Shopify 图作追加输入的语义（§3.3）与现状一致；生成参数含 `productImages: string[]` + `productMetadata: {title?, productUrl?}[]`（商品元数据已能进生成上下文） | `AiVersionDrawer.tsx:225`（默认值）、`:50, :63`（AiVersionOptions） |

### B8. Create Pins 页（header 与空状态）

| 结论 | 事实 | 位置 |
|---|---|---|
| 已验证 | `studio/page.tsx`（4605 行）按 `studioBoardV2` flag 渲染 `StudioBoard`（v2 板）或 legacy；flag 解析：env `NEXT_PUBLIC_STUDIO_BOARD_V2` > localStorage `vp:studio_board_v2` > **默认 board-v2** | `web/src/app/app/studio/page.tsx:4854-4874`、`web/src/lib/studioBoardFlag.ts:28-57` |
| 已验证 | Header 现状：标题 "Create Pins" + savedIndicator + `History` 链接（右侧）；有卡片时另有 "Upload more" 按钮行。`[Select product]` 次级动作**缺失**，但插入点明确（header 右侧动作组 `:358-363` 或 Upload more 行 `:366-374`） | `web/src/components/studio/StudioBoard.tsx:346-375` |
| 已验证 | 空状态现状：拖放上传区，主 CTA "Upload images"（`:388`），次级链接 "No image yet? Create with AI"（`:392`）。"Create from your store? → Select a product" **缺失**，可与 Create-with-AI 并列追加，不破坏 Upload-first | `StudioBoard.tsx:379-396` |

### B9. Settings → Integrations 现状

| 结论 | 事实 | 位置 |
|---|---|---|
| **已验证（与任务书假设有出入）** | `settings/integrations/page.tsx` 只有 5 行：`redirect(SETTINGS_PINTEREST_PATH)`。而 `/app/settings/pinterest/page.tsx` 渲染 null——真正的设置 UI 是 **AppLayout 检测路径后打开的 SettingsModal（modal + tabs）**，tabs = account / billing / pinterest / social / publishing / **amazon** / smart-schedule / ai-settings / appearance / language / support。**不存在可直接挂 Shopify 卡片的独立 Integrations 页面** | `web/src/app/app/settings/integrations/page.tsx:1-6`、`web/src/app/app/settings/pinterest/page.tsx:1-4`、`web/src/components/settings/SettingsModal.tsx:1179-1191`（TABS）、`web/src/lib/settingsPaths.ts`（SETTINGS_NAV 无 integrations 项） |
| 可复用但不完整 | 扩展路径二选一：① 新增 SettingsModal tab（照 PinterestTab `:451-634` / AmazonTab `:729` 的结构，工作量最小、与现有 IA 一致）；② 把 `/app/settings/integrations` 改造成真页面（符合 §7A Preferences URL 语义，但偏离现有 modal 架构）。§7A 的 `https://vibepin.co/app/settings/integrations` 当前实际落到 Pinterest tab | 同上 |

### B10. 套餐 / entitlement 基建

| 结论 | 事实 | 位置 |
|---|---|---|
| 已验证 | `pricingPlans.ts`：`PlanKey = "free"|"starter"|"pro"|"business"`，纯营销展示数据（价格/bullets），**无任何运行时 entitlement 数值** | `web/src/lib/pricingPlans.ts:9-28` |
| 已验证 | 现有 gating 全貌：`useUserTier.ts` = email 白名单数组 + `user_metadata.plan === "pro"` → 单个布尔 `isPro`（客户端 hook，注释自述 "V1: email whitelist only. No Stripe, no DB table"）；使用处如 WorkspaceOpportunityCard / WeeklyPlanBar。**无 server-side plan 解析、无 per-plan 限额配置、无 entitlement 模块** | `web/src/lib/useUserTier.ts:6-28` |
| 已验证 | Feature flag 机制 = `NEXT_PUBLIC_*` 构建期 env（`NEXT_PUBLIC_STUDIO_BOARD_V2`、`NEXT_PUBLIC_ENABLE_MULTI_SOCIAL_ACCOUNTS`、`NEXT_PUBLIC_ENABLE_ASK_VIBEPIN`），部分带 localStorage dev override；无远程/按用户 flag 系统 | `web/src/lib/studioBoardFlag.ts`、`web/.env.example:73,78` |
| 缺失 | 决策 3 要求的"可配置 entitlements（Free 0 店 / Starter 1 店 100 / Pro 2 店 500 / Business 3 店 1000）"没有任何现成载体，需要新建一个 server 端可读的 plan→entitlement 配置模块（可先 config 常量 + user_metadata.plan 解析，忌写进 DB 约束——与决策 3 一致） | — |

### B11. Webhook 端点与锁机制

| 结论 | 事实 | 位置 |
|---|---|---|
| 缺失 | **web 应用没有任何 webhook 接收端点**（API route 全列表中无 /api/webhooks/*；`web/src` 全树无 hmac/webhook 命中）。GDPR 三 webhook + app/uninstalled 需从零新建；HMAC 验签可复用 `crypto.ts` 的 `safeEqual`（timingSafeEqual，`web/src/lib/server/crypto.ts:118-123`）+ node:crypto createHmac | Glob `web/src/app/api/**/route.ts` 全列表核对 |
| 已验证（不可直接复用） | 现有"publish lock" = `/api/pinterest/pins` 内**进程内内存 Set**（`_inFlightPublishes`，key `${userId}:${sourcePinId}`），注释明言 "NOT durable idempotency：不跨重启、不跨实例"，仅防同进程双击竞态；客户端另有各 surface 的 in-flight 守卫 | `web/src/app/api/pinterest/pins/route.ts:29-35, :70-79, :144` |
| 结论 | 同步锁不能复用该机制——分片同步天然跨多个请求（可能跨实例），锁必须落 DB（放进 StoreConnection 的 sync state：status + heartbeat/expiry 时间戳），这与决策 4/7 的"持久化 sync cursor 与进度"是同一张表的同一批字段，无额外架构成本 | — |

### B12. 测试约定与环境变量约定

| 结论 | 事实 | 位置 |
|---|---|---|
| 已验证 | 测试两套：① **tsx 脚本单测**（无 jest/vitest）：`web/scripts/test-*.ts` 共 74 个，`npm run test` 串行全跑，另有 `test:xxx` 单项 script（如 `test:batch-edit`、`test:pin-board`）；② **Playwright e2e**：`web/tests/e2e`（`test:e2e`，`playwright.config.ts`），`.auth` 存登录态，`E2E_TEST_MODE=true` 绕过 auth 中间件（勿在 prod 开） | `web/package.json:scripts`、`web/tests/`、`web/.env.example:99` |
| 已验证 | env 约定：`web/.env.example` 为模板、真值在 `web/.env.local`（gitignored）；命名风格 = server-only 无前缀（`PINTEREST_APP_ID/APP_SECRET/REDIRECT_URI/TOKEN_ENC_KEY`、`SUPABASE_SERVICE_ROLE_KEY`、`LINAPI_*`），客户端可见必须 `NEXT_PUBLIC_*`；文件内注释明确"Next.js 不读 api/.env"。Shopify 对应命名顺理成章：`SHOPIFY_API_KEY / SHOPIFY_API_SECRET / SHOPIFY_REDIRECT_URI / SHOPIFY_API_VERSION=2026-07 /（可选）SHOPIFY_TOKEN_ENC_KEY` | `web/.env.example` 全文 |
| 已验证 | Vercel 约束佐证：`export const maxDuration = 300` 已是仓库现值（Hobby 上限），`vercel.json` 无函数级配置 | `web/src/app/api/generate/route.ts:30`、`web/vercel.json` |

### B13. API route 通用模式

| 结论 | 事实 | 位置 |
|---|---|---|
| 已验证 | 响应约定：成功 `Response.json({...})` / `NextResponse.json({ok:true,...})`；错误统一 `{error: string, code: string}` + 恰当 status（401 unauthorized / 400 bad body / 409 冲突如 publish_in_progress、not_connected / 503 database / 500 config / 502 上游）。`export const dynamic = "force-dynamic"`、需要 Node 的加 `export const runtime = "nodejs"` | `web/src/lib/server/pinterest/routeHelpers.ts:22-67`（错误映射范本）、`web/src/app/api/ai-copy/route.ts:30`、`web/src/app/api/studio/upload/route.ts:24-25` |
| 已验证 | 错误处理范式：模块级 typed Error（code 字段）+ route 顶层 catch 统一映射为安全消息（凭证/内部细节不出响应），dev-only diagnostics 字段 | `web/src/lib/server/pinterest/errors.ts`、`routeHelpers.ts:15-19`（SAFE_MESSAGES）、`ai-copy/route.ts:415-423` |

---

## C. 与 §7 已批准决策的冲突或风险点

1. **决策 6（跨设备权威持久化）——前置项确认触发，且比字面更大**：审计确认草稿系统无服务端权威持久化（B5）。且不止 PinDraft：**My Products 库（assetStore）、creatorProductLink、amazonAffiliateSettings 全部是 localStorage**。决策 5 要求 Shopify 复用 ProductSelection/creatorProductLink 关联机制——若严格执行决策 6 的"关联产品状态跨设备可见"，则草稿服务端化时**关联字段所引用的对象**（至少 Shopify 产品记录本身，服务端表已在 Phase 1 计划内；以及 creatorProductLink 若被 Shopify 复用）也需服务端可解析。建议方案中明确：Shopify 产品经 picker 选中后写入草稿的关联记录**以服务端 Product 表 id 为准**（快照冗余 title/imageUrl/productUrl 到草稿，符合决策 9 快照语义），不依赖设备本地 assetStore。
2. **决策 3（可配置 entitlements）——基建为零**：现状是 email 白名单布尔（B10）。"Free 不可连店"的 server-side 强制点（connect route 处校验 plan）需要新建 server 端 plan 解析（现 `useUserTier` 是客户端 hook）。无冲突，但工作量在方案里不能按"已有 gating 体系"估。
3. **§1.7/§3.1（Settings → Integrations 页面）——与事实有出入**：该"页面"是 5 行 redirect，真实 Settings 是 modal+tabs（B9）。Shopify 管理面要么新增 tab（贴现状）要么造真页面（贴 §7A Preferences URL）。需产品负责人在 Step 2 前拍板；两条路都不难，但影响 §7A dashboard 配置的 Preferences URL 语义。
4. **"workspace" 术语与现实**：决策 6/§4H 反复用 workspace 隔离，但仓库无 workspace 模型，一切按 Supabase user id 隔离（B2）。Phase 1 应明确"workspace = user id"，StoreConnection/Product 表用 `user_id`（或叫 `vibepin_user_id` 随 pinterest_connections 惯例）+ `(user_id, shop_domain)`、`(user_id, store_id, external_product_id)` 复合键即可满足隔离要求；不要为 Phase 1 发明 workspace 表。
5. **§3.3（AI Drawer 的 Add 接"同一个 Picker"）**：现实是两套 picker（ProductPickerModal vs InlineCreateAssetPicker，B7）。Shopify source 需接两处，或方案里明确 AI Drawer 继续走 InlineCreateAssetPicker 并为其加 Shopify source——与 §4E 列出的 InlineCreateAssetPicker/CreateAssetPicker 审计项吻合，非冲突但必须写清。
6. **决策 2 vs §7A 待修正项**：dashboard Scopes 当前 `read_inventory,read_product_listings,read_products` 与"仅 read_products"冲突——任务书自己已列为待修正，仓库侧无对应代码，提醒发布前改 dashboard 即可（需验证：dashboard 实际状态仓库不可见）。
7. **风格提醒（非冲突）**：`/api/import/product-urls` 无鉴权先例（B2）不应被 Shopify 的 products/sync 查询 route 沿用；Shopify 全部 route 须走 `authUser.ts` helper。

## D. 真正的实施阻塞项

**无硬性阻塞。** 以下为"开工前必须先行/先拍板"项（均已有明确路径）：

1. **草稿服务端权威持久化（决策 6 前置项）**——Phase 1 内的前置工程包，建议独立 WP 且先行（其余 WP 的"关联产品跨设备可见"验收依赖它）。
2. **v38+ 迁移需人工 SQL Editor 执行**（含此前排队的 v32-v37 应用状态需先盘点确认）——流程性依赖，非技术阻塞。
3. **Settings 管理面形态**（modal tab vs 真页面）需产品负责人一句话拍板（见 C3）。
4. 外部依赖（Shopify Partner dashboard 的 scopes 修正 + 3 个 compliance webhook URL 配置、dev store）——任务书 §7A 已列，仓库侧无阻塞。
