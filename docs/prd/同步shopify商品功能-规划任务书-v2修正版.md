# VibePin Shopify 商品同步 — Phase 1 规划任务书（v2 修正版）

> 本文档取代《同步shopify商品功能-gpt初稿.txt》，作为交给规划代理的任务说明。
> 产出分两步：**先做仓库审计并回报事实清单，经确认后再产出完整实施方案**。不要一次性输出全部交付物。
> 调研基线：《docs/调研报告/同步shopify etsy功能调研.md》。本文与调研报告冲突时，以本文为准。

---

## 0. 与初稿的关键差异（阅读前须知）

1. **不新建"Products / My Products"一级导航或页签**（产品负责人已决策：入口已经太多）。产品浏览只发生在可复用的 Picker 内部；连接与同步管理放在 Settings → Integrations。
2. **Shopify 作为现有 ProductSelection 产品体系的一个新来源接入**，不另建平行的 Product Library。仓库已有完整的产品选择/关联体系（见 §1.5），必须扩展它而不是重建。
3. **Vercel Hobby 300 秒 / 无后台 job 系统是硬前提**，同步架构必须一开始就按"分片、可续传、客户端驱动"设计，这不是开放问题。
4. Phase 1 范围进一步收窄：ProductCollection 整体推迟到 1.1；ProductVariant 只建 schema 不建 UI。
5. 已定架构决策见 §6（除非审计发现事实性反例，否则不重新讨论）；真正需要产品负责人拍板的项集中在 §7。

---

## 1. 硬前提（已核实的仓库与平台事实，不是待验证假设）

规划必须建立在以下事实之上，审计时只需补充细节，不需要重新质疑：

1. **部署与运行时**：Vercel Hobby plan，serverless 函数 `maxDuration` 上限 300 秒；web 应用**没有任何后台 job / queue / cron 机制**（VPS 上的调度器是独立的爬虫管线，禁止混用）。任何"初次全量同步"都不可能在单个请求内完成。
2. **数据库迁移现实**：本仓库迁移是 authored-not-applied 模式，DDL 需在 SQL Editor 手工执行（raw :5432 被代理拦截），且已有 v32/v33/v34 迁移排队未应用。迁移策略必须按"人工执行 + 版本排队"来写。
3. **草稿持久化**：`web/src/lib/pinDraftStore.ts` 是 localStorage 优先 + 服务端持久化（带 persist-failure Retry）。产品↔草稿关联应跟随现有草稿持久化通道，不另开新通道。
4. **可复用的 OAuth / 加密基础设施**：Pinterest OAuth 全链路已存在且可作为模板 —— `web/src/app/api/auth/pinterest/connect/route.ts`、`web/src/lib/server/pinterest/oauthState.ts`（state/CSRF）、`web/src/lib/server/pinterest/connectionStore.ts`（连接记录）、`web/src/lib/server/crypto.ts`（token 加密）。另有多平台社交连接体系（social connections，cookie session）。
5. **已有产品体系（本次集成的宿主，必须扩展而非重建）**：
   - `web/src/components/studio/ProductPickerModal.tsx`：已有 `ProductSelection` 类型（`asPrimary`、`saveToLibrary`、URL 导入、My Products 库、price/currency/source 字段）。
   - Amazon Associates 功能已交付：Studio 产品上下文条（product context bar）、生成 Pin 的产品继承、regenerate 保留、Weekly Plan 交接、Batch Edit 展示（`web/src/lib/affiliate/` 模块）。
   - **Pin 草稿已存在"关联产品"概念**（primary product / creatorProductLink）。Shopify 产品挂到草稿上必须复用同一关联机制，不得新建平行的 linkedProduct 字段。
   - Batch Edit 已有 URL 四模式：fill / replace / **product** / clear —— "Use product link as destination" 的批量语义已部分存在。
   - Website URL 已定为可选字段，不阻塞发布（已从 pinReadiness 必填集中移除）。
   - 命名冲突警告：仓库另有 `pin_products`（爬取的 Pinterest 商品情报表）和 Product Ideas / Product Opportunity 工具。规划必须给出命名调和方案，避免出现第三个叫"Products"的概念。
6. **AI 链路**：AI Copy 走共享 `PinAICopyPanel` + `/api/ai-copy`，已有 `contextUsed{imageSummary, recommendedKeywords, boardName}` 机制与关键词编织；视觉分析走 data-URL 字节（`web/src/lib/ai-copy/visionServer.ts`）。Shopify CDN 图片进入 AI 链路需要**服务端拉取转 bytes**，这一步必须写入方案。
7. **Settings 结构**：`web/src/app/app/settings/integrations/page.tsx` 已存在，另有 pinterest / social 等独立设置页。Shopify 连接管理应挂在现有 Integrations 页面结构下，先审计其当前形态。

---

## 2. 产品规则（不可违反的 invariants）

- Pin Draft Card 是唯一核心发布对象；Product 只是可复用上下文和 AI 输入。
- 同步商品**绝不**自动创建 Pin 草稿；连接 Shopify **绝不**自动排期或发布任何内容。
- 选择商品**绝不**静默覆盖 Pin 的 Website URL：
  - Product URL 属于 Product；Website URL 属于 Pin；
  - 仅显式的 "Use product link as destination" 动作可把 Product URL 填入**空的** Pin URL；
  - Pin URL 已有值时，替换必须弹确认；
  - 解绑产品不自动清空 Pin URL；产品 URL 后续变更不静默更新已有草稿。
- 商品图片用于 AI Image 生成时，不覆盖原 Pin 图；生成结果产出新的子草稿卡，源 Pin 永不被改写。
- Create Pins 保持 Upload-first：主操作仍是 Upload images，"Select product" 是次级动作；不引入 source-mode 选择器。
- 产品的缺失/下架/删除/售罄只产生**独立警告**，绝不改变 Pin 的 Unscheduled / Scheduled / Posted 生命周期。
- Pinterest 仍是唯一真实发布目的地。

---

## 3. 信息架构（修正后，共三个产品表面）

**不新增任何一级导航项或独立 Products 页面。** 功能分布：

### 3.1 Settings → Integrations → Shopify（连接与同步管理，唯一的管理面）
- Connect Shopify、已连店铺名/域名、连接状态、已授 scopes、last synced、Sync now、初次同步进度、reconnect、disconnect、同步错误。
- 不放任何 Pin 创建、AI 生成、排期控制。
- OAuth 成功后：创建 StoreConnection → 启动初次同步 → 显示进度 → 引导语指向 Create Pins 的 "Select product"（因为没有 Products 页可跳）。

### 3.2 Create Pins（消费面之一）
- Header 增加次级动作 `[Select product]`（与现有 Upload images / History 并列，先审计现有 header 再定确切位置）。
- 空状态增加次级入口："Create from your store? → Select a product"。
- 点击打开**扩展后的现有 ProductPickerModal**：Shopify 作为新 source（与 My Products / URL Import 并列），支持搜索、状态筛选、商品行（主图/标题/价格/状态/图片数/source 徽标）、轻量详情预览、多图选择、确认后才创建 Unscheduled 草稿。打开 picker 或选中商品本身不创建草稿。
- 商品目录规模较大时的浏览体验（分页/搜索）全部在 picker 内解决；不做独立库页。

### 3.3 Generate AI Image Drawer（消费面之二）
- 保留现有 Drawer，不重设计。现有 Product images 区的 Add 接到同一个 Picker（Shopify source）。
- 从已有草稿打开时：当前 Pin 图保持 Product Image #1；Shopify 图作为追加输入；商品元数据进入生成上下文。

### 3.4 Edit Pin 内的关联产品展示
- 复用/扩展 Amazon Associates 已有的产品上下文展示（先审计现状），呈现紧凑摘要：缩略图 + 标题 + `Shopify · 状态 · 价格` + [View product] [Change]。
- 当关联产品有 URL 时显示 "Product link available → [Use product link as destination]"，规则见 §2。
- 审计并说明与 Batch Edit 现有 URL "product" 模式的关系，保证单条与批量语义一致。

### 3.5 命名调和（必交付）
给出用户可见命名方案，区分：Shopify 同步商品、My Products（Amazon/URL 导入）、Product Ideas/Opportunity（选品情报）。目标：picker 内一眼可分 source，且全产品不出现两个含义不同的 "Products" 入口。

---

## 4. Phase 1 范围

### A. StoreConnection 基础
仿照 `connectionStore.ts` 模式：workspace/store 隔离、`crypto.ts` 加密凭证、状态机（connected / degraded / reauth_required / disconnected）、已授 scopes、last full sync / last incremental sync 时间戳、sync error、reconnect / disconnect 处理。schema 对多店铺 future-safe，但 Phase 1 UI 只支持单店铺。

### B. Shopify OAuth
- Unlisted public app（不做 App Store 上架）：Partner dashboard 配置、install 入口、OAuth callback、state 校验（复用 oauthState 模式）、shop-domain 校验、token 加密存储。
- 只读最小 scope：`read_products`（availability 从 product status + variant availableForSale 派生，Phase 1 不申请 `read_inventory`）。
- 必须实现三个 GDPR compliance webhooks（`customers/data_request`、`customers/redact`、`shop/redact`——public app 强制要求，即使不上架）+ `app/uninstalled` 处理（吊销凭证、软删连接）。

### C. 初次商品同步（受 §1.1 约束）
- Shopify Admin GraphQL API，**游标分页 + 服务端 checkpoint + 客户端驱动续传**：每个请求只同步一批（如 100–250 个），把 cursor 存入 StoreConnection 的 sync state，前端轮询/续发直至完成。Bulk Operations 留作 1.1 备选（若审计发现分页方案在目标目录规模下明显不可行，才改用 Bulk Operations 提交 + 轮询完成状态，同样满足 300s 约束）。
- Phase 1 同步规模上限：由套餐 entitlement 决定（见 §7.3：100/500/1000），按 `updatedAtSource` 最近优先；**不得静默截断**，超限展示 Synced X of Y + 升级引导。
- 手动 Sync now = 重跑同一条分片管线；进行中禁止并发触发（复用发布锁的思路做同步锁）。
- 幂等 upsert（按 store + externalProductId）；删除/下架用 tombstone（`deletedAt`），picker 默认隐藏；部分失败可重试、GraphQL cost 限流退避。

### D. 数据模型（最小集）
- `StoreConnection`（见 A）。
- `Product`：source（enum，future-safe：shopify/woocommerce/etsy）、sourceStoreId、externalProductId、title、description（规范化纯文本）、productUrl、adminUrl（派生）、status（规范化 active/draft/archived/deleted）、vendor、productType、tags、price/compareAtPrice/currency、availability（派生）、primaryImage、createdAtSource/updatedAtSource、lastSyncedAt、syncStatus/syncError、deletedAt/archivedAt、rawSourceVersion（原始 JSON 快照，30 天保留）。
- `ProductImage`：sourceImageUrl（Shopify CDN 直链）、width/height/altText/position、variantAssociation。
- `ProductVariant`：**只建 schema**（externalVariantId、title、price、sku、availableForSale、imageId），Phase 1 无 UI。
- `ProductCollection`：**推迟到 1.1**，不建。
- 不建模 inventory locations、订单、客户、履约。
- 与现有 ProductSelection / creatorProductLink 的映射关系必须在审计后明确：Shopify Product 如何投影成草稿上的关联产品记录。

### E. Picker 集成
扩展 `ProductPickerModal`（及审计发现的相关 picker 基建：InlineCreateAssetPicker / CreateAssetPicker / assetStore），新增 Shopify source：搜索、状态筛选、行卡展示、详情预览、多图选择、确认选择。选中的 Shopify 商品产出与现有 `ProductSelection` 兼容的结构（含 `asPrimary` 语义；`saveToLibrary` 对 Shopify source 是用户逐个可选动作，绝不自动入库，见 §7.5）。

### F. AI grounding
- 不新建第二套 AI Copy；扩展现有 `/api/ai-copy` 请求：注入 product title / description / productType / vendor / tags / 选中图 / product URL（price、availability 仅在相关时）。
- `contextUsed` 只展示真实输入（如 linked product title/category），不暴露原始 Shopify payload。
- Shopify CDN 图进入视觉链路：服务端拉取转 bytes 供 `visionServer.ts`（含超时与大小上限）。
- 类目/tags 接入现有关键词匹配（keywordContext）作为加分项，不重写关键词系统。

### G. Destination link 安全
按 §2 规则实现单条动作；审计并对齐 Batch Edit 现有 "product" URL 模式，保证语义统一；已删除/下架产品的 URL 使用时给出警告（不阻塞）。

### H. 安全与运维
OAuth state/CSRF、token 加密、workspace/store 隔离（复合键，防多店泄漏）、最小 scope、webhook HMAC 验签（compliance + uninstall）、重复同步保护（同步锁）、重试策略、日志与可观测（lastSyncedAt/syncStatus 面向用户可见）、断开清理（吊销 + 软删 + 商品 tombstone，草稿上的产品引用保留但标记 stale）、数据删除（workspace 级 purge）、过期产品警告。

---

## 5. 非目标（Phase 1 不做）

- 新增一级导航 / 独立 Products 页 / 新页签（**产品负责人硬性决策**）
- WooCommerce、Etsy、Pinterest Catalog feed
- 同步后自动建草稿、自动排期、自动发布
- 增量 webhook 同步（products/create|update|delete —— 1.1 再做；Phase 1 只有 compliance + uninstall webhooks）
- ProductCollection 同步与筛选、variant 选择 UI
- 多店铺 UI（schema future-safe 即可）
- back-in-stock / price-drop / evergreen 自动化
- 订单/客户/库存/履约同步、按产品的分析
- App Store 上架与审核
- 批量多商品生成（1.2，从何处入口届时再定，schema 与 picker 保持 future-safe）

---

## 6. 已定架构决策（默认成立，除非审计发现事实性反例）

1. Shopify 记录持久化在现有数据库，新增表，沿用现行迁移排队流程。
2. 存原始 payload 快照（rawSourceVersion），30 天保留，仅用于 debug。
3. 商品图**用 Shopify CDN 直链，不代理不缓存**；AI 视觉链路例外（服务端即取即用转 bytes，不落盘）。发布前对目的地 URL 做轻量状态校验（仅警告）。
4. 初次同步 = 分片游标 + 客户端驱动续传（见 §4C），不引入新 job 系统。
5. 无 job 系统的兜底 = 上述分片方案本身；不做定时任务。
6. Phase 1 用游标分页 GraphQL，不用 Bulk Operations（除非审计证明不可行）。
7. Sync now = 重入同一分片管线 + 同步锁防并发。
8. 已删除/归档商品：草稿冻结不动，Edit Pin 内显示独立警告徽标；picker 默认隐藏 tombstone。
9. 草稿在产品更新后保持冻结（快照语义）；不自动传播任何字段。
10. 仅在发布/排期时刻对关联产品做一次轻量新鲜度检查（status + URL），结果只用于警告。
11. Variants：schema-only。
12. StoreConnection 状态机：connected / degraded / reauth_required / disconnected。
13. Reconnect = 重走 OAuth 覆盖凭证；uninstall webhook = 吊销 + 软删 + tombstone。
14. Scopes：仅 `read_products`。
15. 外部依赖：Shopify Partner 账号 + app 配置 + dev store；compliance webhooks 必须实现；无 App Store 审核依赖。

---

## 7. 已批准的最终决策（2026-07-11 产品负责人确认，不得重新展开讨论，除非审计事实证明某项不可行）

1. **分发**：public Shopify app + 多租户 OAuth。不以 custom app token 作为生产架构。Phase 1 必须包含强制 compliance webhooks 与 `app/uninstalled` 处理。
2. **Scopes**：Phase 1 仅申请 `read_products`。不申请 read_inventory、read_product_listings、orders、customers 或任何 write scope。商品更新 webhooks、增量同步、collections、完整 variant 行为推迟到 1.1。
3. **套餐限额**（必须是可配置 entitlements，不得硬编码进数据库约束；计费实现后定，先用 feature flag / 账户 entitlement）：
   - Free：不可连店，不可导入商品
   - Starter：1 家店，最多 100 个 active synced products
   - Pro：2 家店，最多 500 个
   - Business：3 家店，最多 1000 个
   - 限额按 workspace 内 active synced products 总量计。**不得静默截断**：超限时展示已同步数、总数、升级/选择状态。
   - Phase 1 执行解释（默认）：按 `updatedAtSource` 最近优先同步至限额，横幅显示 "Synced X of Y products" + 升级引导；商品级 active/inactive 勾选管理推迟 1.1，除非审计发现廉价实现路径。
4. **同步架构**：游标分页 GraphQL + 小幂等服务端分片 + 持久化 sync cursor 与进度 + 客户端续传直至完成 + 中断后安全恢复 + 手动 Sync now。不得围绕长请求或不存在的 job queue 设计。迁移走仓库现行手工 DDL 流程。
5. **产品关联**：复用现有 ProductSelection / creatorProductLink 关联及 Batch Edit "product" URL 行为；除非审计证明现有机制无法承载 Shopify，否则不得引入平行的 linked-product 字段体系。Shopify 是 ProductPickerModal 内独立 source，**不得自动把同步商品灌入 My Products**（选中时的 `saveToLibrary` 仍是用户逐个可选动作）。
6. **跨设备持久化（权威性要求）**：Shopify 连接、同步商品、同步进度、关联产品状态、Pin 草稿编辑与生命周期必须以认证账号/workspace 为权威，跨设备可见。localStorage 只能是缓存/恢复层，不能是 Shopify 关联草稿的权威来源。**若审计确认当前草稿系统无服务端权威持久化，则为这些草稿补服务端持久化是 Phase 1 前置项**——通过扩展现有草稿持久化模型实现，不得为 Shopify 链接单建平行持久化系统。
7. **产品行为**：同步不建草稿；选中产品不自动覆盖 Pin 目的地 URL；仅显式 "Use product link as destination"；已有 URL 替换需确认；解绑或产品更新不静默改动已有 Pin URL（与 §2 一致）。
8. **Phase 1 边界**：含 OAuth 连接、StoreConnection 持久化、product schema、初次分页同步、Sync now、同步进度与恢复、ProductPickerModal 集成、单商品建 Pin、product-grounded AI 上下文、显式目的地链接行为、跨设备持久化。推迟 1.1：ProductCollection、product/collection 增量 webhooks、完整 variant 选择、自动对账、更广的多店工作流。Variant 表可先建，Phase 1 只用最小 variant 数据。多店说明：schema 与 entitlement 支持多店（Pro/Business 限额可配），**Phase 1 管理 UI 先只提供单店连接**，多店管理 UI 属 1.1 的"更广多店工作流"。
9. **交付流程**：先只回报已验证仓库事实清单（现存能力、确切可复用文件、缺失基建、与本决策的冲突、真正的实施阻塞项）；产品负责人确认后再产出完整实施方案与执行工作包。

## 7A. Shopify 应用外部配置基线（Partner dev dashboard 现状，2026-07-11）

- App：**vibePin**（org: PocketProfit Studio），版本基于 `vibepin-1`（Active）
- App URL：`https://vibepin.co/api/integrations/shopify/launch`（**非嵌入**，"Embed app in Shopify admin" 未勾选）——该端点必须验证 HMAC，并对已登录用户发起 OAuth 或跳转到 Settings → Integrations
- Preferences URL：`https://vibepin.co/app/settings/integrations`
- Redirect URL：`https://vibepin.co/api/integrations/shopify/callback`
- Use legacy install flow：**已勾选**（配合自建 authorization-code OAuth，保持勾选；scope 以授权 URL 参数为准，但 dashboard Scopes 字段应保持一致以免混淆）
- Webhooks API version：**2026-07**——代码中 Admin GraphQL 调用必须固定同一版本（写入 env/config 常量）
- **待修正项**：
  1. dashboard Scopes 字段当前为 `read_inventory,read_product_listings,read_products`，与决策 2 冲突 → 发布版本前改为仅 `read_products`；
  2. 三个 GDPR compliance webhook 端点（customers/data_request、customers/redact、shop/redact）尚未配置（在 app Settings 内），public 分发强制要求。

---

## 8. 交付流程与交付物

**Step 1 — 仓库审计（先行，单独回报）**：按 §1 补全细节 + 核查以下清单，产出"已验证 / 可复用但不完整 / 缺失 / 需验证"四分类的事实清单，**每项可复用能力必须给出确切文件路径与可复用点**：
- 数据库与 ORM、迁移文件现状；认证与 workspace 归属；Pinterest OAuth 与 crypto 细节；API route 模式；现有 ProductPickerModal / assetStore / productUrlImportClient / affiliate 模块的确切数据结构与草稿关联机制；AI Image Drawer 的 Product images 区现状；Create Pins header 与空状态现状；pinDraftStore 与服务端持久化契约；`/api/ai-copy` 请求契约与 contextUsed；Batch Edit URL 模式实现；settings/integrations 页面现状；测试与环境变量约定。

**Step 2 — 完整方案（审计确认后）**：
- 执行摘要（就绪度、三大风险、复用/新建清单）
- 能力地图 + 差距矩阵（Done / Partial / Missing / Blocked / Needs verification）
- 架构（实体、API 路由、OAuth 流、分片同步流、picker 流、product→pin 流、AI grounding 流、错误态流）
- 精确数据模型（表、字段、索引、唯一约束、外键、生命周期）
- 文件级变更计划（create/modify、职责、依赖；路径必须先核实存在的目录结构）
- API 契约（connect / callback / status / list products / product detail / sync now / sync status / disconnect / picker 查询）
- 按 §3 四个表面的逐屏 UI 计划（含 loading / empty / disconnected / reconnect / failed-sync / stale 态；每屏标注复用或扩展的现有组件）
- 迁移策略（手工 DDL 现实、与现有草稿兼容、回滚、feature flag、不破坏任何现有工作流）
- 测试计划（单测、OAuth 安全、同步幂等、规范化、多 workspace 隔离、图片 URL、浏览器 QA、dev store 冒烟、断开/重装、过期 token、删除商品）

## 9. 工作包（预期形态，可按审计结果微调）

- WP1 — schema + StoreConnection 基础（含迁移文件，可独立合并）
- WP2 — Shopify OAuth + compliance/uninstall webhooks
- WP3 — 分片同步管线 + Sync now + 同步锁
- WP4 — Settings → Integrations → Shopify 管理 UI
- WP5 — Picker 扩展（Shopify source）+ Create Pins / AI Image Drawer 接入
- WP6 — 产品 grounded AI Copy / AI Image 上下文
- WP7 — Destination link 安全 + Edit Pin 关联产品展示
- WP8 — QA、安全与发布加固

每个 WP 给出：目标、依赖、确切文件、验收标准、测试、风险、能否独立合并。

## 10. 方案验收标准

- 基于已验证的仓库文件；不重写 Create Pins / AI Copy / AI Image Drawer / ProductPickerModal（只扩展）
- Pin Draft Card 保持核心对象；同步不建草稿；URL 永不静默覆盖
- **不新增一级导航或页签**；Shopify 融入现有 ProductSelection 体系并给出命名调和方案
- 同步方案在 Vercel 300s / 无 job 系统前提下可行
- 对 WooCommerce / Etsy future-safe 但不提前实现
- OAuth 与 workspace 隔离按安全关键处理
- 拆成可独立评审合并的小 WP，Phase 1 边界清晰
- 列明 Shopify Partner 配置等外部依赖

结尾必须给出：① 推荐实施顺序；② 推荐首个 PR；③ 执行代理不得触碰的区域；④ 最小浏览器可演示里程碑（建议：dev store 连接 → 同步 ≥1 个商品 → picker 选中 → 生成 1 张带产品 grounding 的草稿卡 → 显式采用产品链接 → 排期）；⑤ 发布门禁清单。
