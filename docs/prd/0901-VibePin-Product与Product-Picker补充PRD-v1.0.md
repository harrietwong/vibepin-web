# 0901 VibePin Product Opportunities / 商品选择补充 PRD v1.0

状态：`READY FOR IMPLEMENTATION REVIEW`，尚未取得最终 runtime 的桌面与 390px USER PASS  
日期：2026-09-01  
适用范围：Product Opportunities、Saved Products、Create Pin Product Picker、商品图驱动的选品灵感、社区灵感入口  
上位文档：Product Opportunities PRD v3.7  
问题输入：`CP-04`、`CP-05`、`CP-06`、`CP-07`、`PR-01`、`PR-03`

### Requirement IDs

| Requirement ID | 台账来源 | 必须实现的结果 |
|---|---|---|
| `PO90-01` | CP-04、PR-03 | Create Pin 商品入口、Product Picker 与 Product Catalog 使用一套信息架构和一个 Product Opportunities 事实源 |
| `PO90-02` | CP-03、PR-03 | 粉色、乱码、broken image 与永久 spinner 全部收敛到中性深灰 fallback |
| `PO90-03` | CP-05、PR-03 | Uploaded、URL Imported、Amazon、Product Ideas 改为用户可理解且可追溯的来源 taxonomy |
| `PO90-04` | CP-06、PR-01 | “选品灵感”按真实 API/data/auth/error code 区分 loading、empty、error、retry |
| `PO90-05` | PR-01 | test Supabase 0 行只显示诚实空态，认证/服务/环境错误不得伪装为空态 |
| `PO90-06` | PR-01、PR-03 | Catalog、Saved、filters、lineage、merchant link 与 Pinterest source link 可核验且语义一致 |
| `PO90-07` | CP-04/05/06、PR-01/03 | 同一最终 Preview runtime 完成桌面与 390px 两轮只读 USER 验收 |
| `PO90-08` | CP-07 | 上传→分析→推荐绑定同一 intent/image，换图隔离旧响应，Retry 只重试失败阶段 |
| `PO90-09` | 全部 | 仅 Preview/test-bound；不得访问或推断 Production，不以 VPS/Product Supply 结果代替 UI 验收 |
| `PO90-10` | 0905 USER | `/app/products` 页头收敛到 app shell 紧凑标题尺度，不使用 Landing hero 视觉层级 |
| `PO90-11` | 0905 USER | 空结果必须区分真实 catalog 空、当前筛选为空与 API/data/auth/环境错误，不得用假数据填充 |
| `PO90-12` | 0905 USER | All products / Physical / Digital 合并进搜索筛选工具栏，桌面与 390px 均保持清晰层级和可操作性 |

## 1. 目标

1. 把上传、URL 导入、我的商品、Product Opportunities、社区灵感和 AI 创建收进一个可理解的“添加内容 / 创建 Pin”入口。
2. 让 Picker 的 tab、筛选、卡片标签、图标和 provenance 使用同一来源语义，不再用 `Uploaded`、`Product Ideas` 混合“来源”“状态”和“推荐结论”。
3. 消除粉色/随机渐变 fallback、broken image、alt 文本挤入图片区和永久 spinner。
4. 把“选品灵感无法加载”和“上传后一直分析”拆成可观察、可恢复、不串旧结果的状态机。
5. 测试库 0 行时显示诚实空态；认证、网络、JSON、环境绑定或服务错误必须显示错误态。
6. 保持 v3.7 的 PDP、商家图、Pinterest Evidence、生命周期、去重和指标真实性门禁。

## 2. 非目标与安全边界

1. 本 PRD 不授权 VPS stage、activate、dry-run、canary、apply 或 timer 变更。
2. 不修改 Preview、Production 或测试 Supabase 的 schema、数据、环境变量或部署。
3. 不放宽 PDP、商家图、provenance、duplicate、lifecycle 或 v47 红线。
4. 不把用户上传图、URL 导入结果、Amazon 标签或社区 Pin 自动提升为 Product Opportunity。
5. 不把 Pinterest 图片当作缺失商品图兜底，不以 Pin 标题伪造商品名。
6. 只读验收不点击收藏、Create Pin、上传、URL 导入、生成或其他写动作。
7. 浏览器侧不得直连 Production，也不得在失败后静默切换 Supabase 项目。

## 3. 对象与信息架构

### 3.1 六类对象必须分开

| 用户对象 | 它是什么 | 它不是什么 | provenance 最小要求 |
|---|---|---|---|
| 我的商品 | 当前用户已保存、上传或导入的商品资产容器 | 不是来源或推荐等级 | 原始来源、创建时间、原始 URL/文件、最近使用时间、owner |
| Amazon | 商品平台/商家来源，可出现在“我的商品”或 Product Opportunities | 不是独立工作流，不代表推荐、质量或联盟资格 | canonical URL、域名、导入方式或 Opportunity ID；可用时保留 ASIN |
| URL 导入 | 用户提供商品 URL，系统验证并提取信息的输入方式 | 不是 Product Opportunity 或社区灵感 | original/normalized/canonical URL、域名、提取时间、结果/失败原因 |
| 上传 | 用户提供本地商品图片的输入方式 | 不证明 PDP、商家、价格或 Pinterest demand | 文件来源、稳定资产 URL、上传时间、owner；无 PDP 时明确“仅图片” |
| Product Opportunities | 通过 v3.7 门禁的稳定真实商品目录 | 不是用户上传库、社区 Pin 池或通用 AI 推荐 | Opportunity ID、真实 PDP、商家图、Primary/Additional Pinterest Evidence、更新时间 |
| 社区灵感 | 可追溯 Pin/参考图，用于视觉方向或构图 | 不是商品，不提供 PDP、价格或商品需求结论 | Pin ID/URL、图片 URL、来源关键词/分类、抓取时间 |

### 3.2 统一入口

统一入口叫 `添加内容`；处于明确生成语境时可显示 `创建 Pin`，但弹层内部来源名称与顺序一致：

1. `从我的商品选择`：打开 canonical Product Picker，默认“我的商品”。
2. `从 Product Opportunities 选品`：打开同一 Picker，进入“选品灵感”。
3. `通过商品链接导入`：成功后归入“我的商品”。
4. `上传商品图片`：成功后归入“我的商品”。
5. `从社区灵感创作`：打开 Reference Picker，与商品 role 分离。

AI 生图可以作为同层的 `AI 创建`，但它是创作方式，不与商品来源筛选混排。

现有快捷入口可以保留，但同一动作必须使用同名、同图标、同说明和同一 canonical handler。仅打开、切换或取消不得创建资产、请求生成或写 DB。Product Picker 只有两个一级 tab：`我的商品` 与 `选品灵感`；上传和 URL 导入是“我的商品”的动作，不是一级 tab。

## 4. Taxonomy、文案与图标

### 4.1 替换旧标签

| 旧标签 | 新用户标签 | 语义 | 图标语义 | 禁止解释 |
|---|---|---|---|---|
| `Uploaded` | `上传的商品图` | 本地上传图片 | Image Up/Upload + 文字 | 已验证商品、推荐商品 |
| `URL Imported` | `链接导入` | 用户通过 URL 导入 | Link + 文字 | 已通过 Opportunity 门禁 |
| `Product Ideas` | tab：`选品灵感`；卡片来源：`VibePin 商品机会` | Product Opportunities 商品 | Compass/Sparkles + 文字 | AI 生成、质量评级、保证热卖 |
| `Amazon` | `Amazon` | 平台/商家域 | Store 或合规品牌标识 + 文字 | 导入方式、联盟资格、推荐等级 |
| `Recent` | 移出来源，改为排序 `最近使用` | 时间排序 | Clock 仅用于排序 | 商品来源 |
| `Pin Ideas` | `社区灵感` | Pin/参考图池 | Images/Users + 文字 | Product Opportunity、商品图、PDP |

### 4.2 “我的商品”筛选

筛选只描述原始来源：

```text
全部
上传的商品图
链接导入
Amazon
Shopify（仅功能启用或存在数据时）
导入问题（仅存在失败项时）
```

`最近使用`、`最近添加`、`名称 A–Z` 只属于排序。`VibePin 商品机会` 不作为“我的商品”的默认来源筛选；用户选择 Opportunity 时在当前选择中保留 Opportunity ID，不退化成普通 Uploaded。

### 4.3 “选品灵感”筛选

“选品灵感”只展示 Product Opportunities，支持 Physical/Digital、Search、Category、Platform、Demand、Trend 与排序。Amazon 是 platform 值。Demand/Trend/Fastest Growing 只在对应 family 的 v3.7 metric release gate 通过时出现。

卡片不得显示 `Product Ideas`、`Recommended`、`Hot` 或没有真实指标支持的结论。

## 5. 图片与 fallback

### 5.1 状态机

```text
idle → loading → loaded
              ↘ missing
              ↘ decode_failed
              ↘ blocked_or_expired
```

1. 空 URL、`undefined`、`null`、1×1、无法解码、加载错误和超时都进入中性 fallback。
2. `onError` 后移除/隐藏损坏 `<img>`，不能只降低 opacity 后继续显示 broken icon 或 alt 文本。
3. 请求完成后没有有效自然尺寸也视为失败。
4. 列表、详情、AI 抽屉、Product Picker、Reference Picker 和 Create Pin 卡片共用一个 fallback component/token。

### 5.2 视觉与 a11y

fallback 使用深灰中性底色、低对比度轮廓图标与短文案：`商品图片不可用` 或 `参考图片不可用`。

禁止粉色、粉紫、随机渐变、品牌主渐变、Pinterest 图片、其他商品图或随机占位图作为失败兜底；禁止永久 spinner。粉紫色仅用于选择、焦点与 AI 主 CTA，不表达图片失败。

真实商品名存在时 `alt="{商品名}"`；名称未知时使用空 `alt=""`，卡片可访问名称由来源、域名和动作组成，不写“Product”。fallback 图标 `aria-hidden="true"`，短文案承担语义。

## 6. 状态机

### 6.1 Product、Saved 与“选品灵感”读取

```text
initial → loading → ready_nonempty
                  → ready_empty
                  → error → retrying → ready_nonempty | ready_empty | error
```

| 状态 | 唯一合法判定 | UI |
|---|---|---|
| loading | 请求已发，尚无可验证响应 | 有界 skeleton；不得同时显示空态 |
| ready_nonempty | HTTP 200、合法 JSON、`items.length > 0`、环境绑定正确 | 卡片、筛选、更新时间 |
| ready_empty | HTTP 200、合法 JSON、`items=[]`、环境绑定正确 | 诚实空态；不显示 Retry |
| error | 401/403/错误 404、429、5xx、network、timeout、非用户 abort、非法 JSON/shape 或环境不明 | 错误说明与 Retry；保留选择，不显示伪空态 |
| retrying | 用户点击 Retry 后同一请求重发 | Retry 禁用并显示进行中；不得重复并发 |

诊断必须记录 HTTP method、exact path、status、稳定 error code、request ID、runtime/deployment 和时间；UI 不显示 token、SQL、堆栈或 secret。

Retry 只重试当前失败 GET，不重放上传、保存、生成或导入；同一视图只有一个在途请求，旧响应丢弃；成功后清除错误；自动重试有界。

### 6.2 测试库空态

只有同时满足以下条件才显示空态：

1. runtime/deployment 与 test-bound 台账一致。
2. 请求目标为同源 Preview API。
3. 已认证请求返回 HTTP 200 JSON。
4. `items` 是真实空数组，未被 catch、fallback 或过滤异常改写。
5. console 无 uncaught error，Network 无 Production ref。

推荐文案：

```text
Product Opportunities：暂时没有通过验证的商品
新的合格商品会在完成商品页与来源审核后显示在这里。

Saved Products：还没有收藏商品
你收藏的 Product Opportunities 会显示在这里。

选品灵感：暂时没有可用的商品机会
你仍可从“我的商品”上传图片或导入商品链接。
```

### 6.3 上传后的分析与推荐

```text
idle → file_selected → uploading → uploaded
→ analysis_pending → analysis_ready
→ recommendations_loading → recommendations_ready

uploading → upload_failed
analysis_pending → analysis_failed
recommendations_loading → recommendations_failed
```

1. 每次选图生成新的 `intentId` 与 `imageKey`。
2. 换图时取消旧请求；无法取消时通过 `intentId` 丢弃旧响应。
3. Retry 只重试失败阶段。
4. `analysis_ready` 必须绑定本次 `imageKey`；推荐请求携带同一 `imageKey`、analysis source/status。
5. 无真实分析结果时不得写“已分析完成”，不得使用旧图或 mock。
6. 推荐 200 + 空数组是诚实空态；网络/服务问题是错误态。
7. 同一未提交 intent 可恢复完成状态；新 intent 不继承旧结果。
8. 任一阶段不能有 uncaught error、永久 spinner 或矛盾提示。

## 7. Provenance 用户契约

### 7.1 Product Opportunity

卡片最少显示真实商品图、有证据才显示的真实商品名、Platform/Category、`Pinterest Product Pin` 或 `Pinterest Source Pin`、独立的 `查看 Pinterest 证据`/`查看商品` 链接，以及 `最后更新 {time}`。

详情列出 Primary 与 Additional Evidence，不将多个 Pin 指标相加成 SKU 指标；只显示真实 merchant product URL。指标未过 release gate 时省略，不显示假 0。

### 7.2 我的商品

1. `上传的商品图`：无商品链接时明确“仅图片”。
2. `链接导入`：显示来源域名，只使用验证后的 normalized/canonical URL。
3. `Amazon`：显示平台与商品链接；不显示“推荐/热卖”，除非另有真实指标。
4. 来自 Opportunity 的选择显示 `VibePin 商品机会`，保留 Opportunity/Pinterest/merchant 关联。

### 7.3 社区灵感

显示 `社区灵感`、Pinterest/允许的原始链接、已知分类/关键词与抓取时间，并说明“用于视觉参考，不代表商品或可购买链接”。

## 8. API 只读契约

### 8.1 v3.7 事实源 GET

| Surface | Method 与 exact path | 认证 | 200 最小响应 | 关键错误 |
|---|---|---|---|---|
| Product 列表 | `GET /api/product-opportunities` | Bearer/cookie user | `{ items, accessibleCount, hasLockedCatalog, metricControls, planAccess }` | 401；400 metric 未就绪；503 |
| Product detail | `GET /api/product-opportunities/{id}` | Bearer/cookie user | `{ item }` | 401、404、503 |
| Saved Products | `GET /api/saved-product-opportunities` | Bearer/cookie user | `{ items }` | 401、503 |
| 社区灵感 | `GET /api/reference-candidates` | 现有 Preview 会话边界 | 实现时冻结唯一 `{ items, source, lastUpdatedAt? }` shape | 401/403（如需登录）、500/503 |

Product list query：

```text
limit, offset
family=physical|digital
search, category, platform
demand=high_recent_demand
trend=rising|steady|cooling
sort=most_saved|newest|fastest_growing
```

`demand`、`trend`、`fastest_growing` 只有 `metricControls.available=true` 时可用，前端不能绕过 API 门禁。

### 8.2 “选品灵感无法加载”的真实诊断契约

当前 test-bound runtime 的事实边界：

1. Product Catalog 已存在认证 GET：`/api/product-opportunities`、`/api/product-opportunities/{id}`、`/api/saved-product-opportunities`。
2. 当前 Picker 兼容链仍可能请求 `GET /api/products/top?limit=400&sort=most_saved`，并在失败后尝试浏览器 Supabase fallback；这会让 API 失败、DB 空表、筛选后空数组与错误 fallback 混成同一“没有商品”表象。
3. 当前服务错误体主要是 `{ error: string }`，尚未冻结稳定 `code`；因此 Network status 与 server log 是现阶段诊断事实，不能声称已有完整 error-code 契约。
4. 目标实现必须取消静默 browser-DB fallback，让 Picker 与 Catalog 共用认证 API，并返回稳定 `code` 与 `requestId`。

目标错误响应：

```json
{
  "error": "面向用户、可本地化的短消息",
  "code": "CATALOG_UNAVAILABLE",
  "requestId": "opaque-request-id"
}
```

| HTTP / client 状态 | 稳定 code | 归类 | UI 与 Retry |
|---|---|---|---|
| 401 | `AUTH_REQUIRED` | auth error | 显示登录提示；登录后重新 GET，不显示空态 |
| 403 | `CATALOG_FORBIDDEN` | auth/entitlement error | 说明无权访问；不得换库或直连 DB |
| 400（metric gate） | `METRIC_FILTER_NOT_READY` | request capability error | 清除未开放筛选并重新 GET；不把 catalog 归零 |
| 404（detail） | `PRODUCT_NOT_FOUND` | stale selection | 关闭/标记该详情不可用；列表可继续使用 |
| 429 | `RATE_LIMITED` | transient error | 展示稍后重试；尊重 Retry-After，不 flood |
| 500/503 | `CATALOG_UNAVAILABLE` | service/data error | 错误态；一次用户触发 GET Retry |
| network/timeout | `NETWORK_ERROR` / `REQUEST_TIMEOUT` | transport error | 错误态；有界 Retry，不自动切 DB |
| HTTP 200 但 JSON/shape 非法 | `INVALID_RESPONSE` | contract error | 错误态；记录 runtime 与 response shape |
| Preview ref/runtime 不匹配 | `WRONG_ENVIRONMENT` | lineage error | 立即停止验收，禁止显示内容或空态 |

每次失败证据记录：surface、method、exact path/query、status、response `code`/`requestId`、runtime、deployment、test ref、时间、console。不得记录 bearer token、cookie、magic-link fragment、数据库密钥或完整错误堆栈。

### 8.3 Picker / Catalog 单一来源收敛

当前兼容端点 `GET /api/products/top?limit=400&sort=most_saved` 读取 legacy `pin_products`，只可作为迁移期兼容事实。最终“选品灵感”必须与 `/app/products` 共用 `GET /api/product-opportunities`：

1. 共用 Opportunity ID、商品图/链接、Evidence 类型、更新时间与权限。
2. API 失败后不得从浏览器直读 Supabase 作为静默 fallback。
3. 不把 `/api/products/top` 的 `Product Ideas` 标签、legacy score 或 source-pin saves 当作 v3.7 结论。
4. 收敛前如仍使用兼容端点，必须标明兼容数据源并保留全部真实性门禁；不能宣布 PR-03 完成。

### 8.4 Product item 字段

```text
id
productName|null
productImageUrl
productUrl
merchant|null
domain|null
category|null
productType|null
productFamily=physical|digital
pinterestUrl
pinterestEvidenceType=product_pin|source_pin
additionalPinterestEvidence[]
latestPinterestSaves|null
latestPinterestSnapshotAt|null
savesGained30d|null
currentSavesGained7d|null
previousSavesGained7d|null
highRecentDemand|null
recentMomentum|null
momentumPercent|null
```

`null` 表示未知或未过门禁，不能转成 `0`、`Stable`、`Low Demand`、`Product` 或其他推断。

### 8.5 非只读隔离

以下不属于只读验收：`POST/DELETE /api/saved-product-opportunities`、URL 导入、上传、图片分析/推荐、AI 生成和 Create Pin 草稿/发布。只读 USER 轮不得触发；实现测试需单独可回滚用例与副作用清单。

## 9. DB 只读契约

服务端通过 service role 读取，浏览器不直接读取：

| DB 对象 | 读取目的 | 用户端允许看到 | 禁止泄露 |
|---|---|---|---|
| `product_opportunity_catalog_v1` | active 目录、Primary Evidence、已放行指标 | 商品、平台、分类、Evidence 链接、公开指标 | lifecycle/internal status、SQL 字段、未放行指标 |
| `product_opportunities` | 稳定身份、详情、历史收藏回读 | 真实商品字段 | raw provenance、审核原因、内部 discovery method |
| `product_opportunity_evidence` | Primary/Additional Evidence | Pin URL 与 Product/Source Pin 类型 | selection reason、错误计数 |
| `product_opportunity_metrics` | 已放行 saves/trend | release gate 允许值 | stale/counter regression 原始值 |
| `product_metric_calibrations` / `product_metric_release_gates` | 决定控件/badge | 控件可用性 | 阈值、审批字段 |
| `saved_product_opportunities` | 当前用户收藏/历史 | 当前用户记录 | 其他用户记录 |

边界：

1. catalog view 只含 active Opportunity 与 active Primary Evidence。
2. catalog view 不直接授权 anon/authenticated；服务端做套餐与字段裁剪。
3. Saved 启用 RLS；GET 只返回当前用户，写入只经服务端套餐校验。
4. Picker 不读取 `product_scores`，不运行 scoring，不重算旧分数。
5. `pin_products` 只作兼容/发现证据，不是 v3.7 稳定身份。
6. retired/inactive、缺商家图、缺合法 Pinterest Evidence 或缺 Product URL 的记录不得进入目录。

社区灵感从 `pin_samples` 或受控 read view 仅返回 `id`、`image_url`、`category`、`title`、`source_keyword`、`seed_keyword`、`pinterest_url`、`scraped_at`。内部 eligibility、quality score、bucket 和审核标记不返回。无合法 `pinterest_url` 的候选不能显示为可追溯社区灵感。

## 10. Test-bound 环境

```yaml
runtime: b007957064082c291ebc3cf230ac9e25c230826d
manifest_commit: 864349b0076b9d62b72f2281d209c34ef95f13ac
deployment: dpl_D6w29wpXBLTLFX8kQMEDEo1px2Vq
stable_url: https://vibepin-fb-preview.vercel.app
unique_url: https://web-mipx22asq-harriets-projects-86e9e358.vercel.app
supabase_ref: snulmwprsahzqvdbyenc
environment: Preview / test-bound
production_touched: false
```

1. 验收前用 release receipt 核对 runtime/deployment/test ref；旧 `dpl_5nW...` 证据仅作历史背景。
2. 只访问 stable/unique Preview 与同源 API；bundle、Network、响应不得出现 Production ref。
3. 未认证 GET 的 401 JSON 是正确 auth 边界，不是业务空态。
4. 认证 GET 200 JSON 后才可验收业务空态/内容态。
5. Preview 成功不能推断 Production schema、数据或上线状态。
6. 修复后必须绑定新 runtime/deployment 重验，本登记不会自动继承。

## 11. i18n

| 语义 key | English | 简体中文 | 繁體中文 |
|---|---|---|---|
| addContent | Add content | 添加内容 | 新增內容 |
| chooseMyProducts | Choose from My Products | 从我的商品选择 | 從我的商品選擇 |
| productOpportunities | Product Opportunities | Product Opportunities | Product Opportunities |
| productInspiration | Product inspiration | 选品灵感 | 選品靈感 |
| communityInspiration | Community inspiration | 社区灵感 | 社群靈感 |
| uploadedProductImage | Uploaded product image | 上传的商品图 | 上傳的商品圖片 |
| urlImported | Imported from link | 链接导入 | 連結匯入 |
| imageOnly | Image only | 仅图片 | 僅圖片 |
| vibepinOpportunity | VibePin product opportunity | VibePin 商品机会 | VibePin 商品機會 |
| productPinEvidence | Pinterest Product Pin | Pinterest Product Pin | Pinterest Product Pin |
| sourcePinEvidence | Pinterest Source Pin | Pinterest Source Pin | Pinterest Source Pin |
| imageUnavailable | Product image unavailable | 商品图片不可用 | 商品圖片無法使用 |
| referenceUnavailable | Reference image unavailable | 参考图片不可用 | 參考圖片無法使用 |
| retry | Try again | 重试 | 重試 |
| lastUpdated | Last updated {time} | 更新于 {time} | 更新於 {time} |
| noQualifiedProducts | No verified products yet | 暂时没有通过验证的商品 | 暫時沒有通過驗證的商品 |

所有 key 必须在 en、zh-CN、zh-TW 完整存在，不在组件硬编码单一语言。品牌名不翻译，周边说明本地化；时间使用 locale-aware formatter，详情提供含时区的完整时间。

## 12. A11y

1. 入口、tab、筛选、Retry、关闭与链接均可键盘到达。
2. dialog 使用 `role="dialog"`、可见标题和 `aria-labelledby`；关闭后焦点返回触发器。
3. tab 使用 `tablist/tab/tabpanel` 与 `aria-selected`，不只靠颜色。
4. 图标旁始终有文字；图标不作为唯一语义。
5. loading/error/retry success 使用适度 `aria-live`，不循环播报 skeleton。
6. 同一错误只播报一次。
7. 选中卡片使用 `aria-pressed` 或 checkbox 语义，至少两种视觉/文本反馈。
8. 390px 主要点击目标至少 44×44 CSS px，桌面有清晰 focus ring。
9. 达到 WCAG 2.1 AA；粉紫色不单独承担状态。
10. `prefers-reduced-motion` 下关闭 shimmer/脉冲。

## 13. Desktop 与 390px

### 13.1 Desktop

1. Product Picker 只有一个 canonical 实现。
2. 内容区至少两列；来源、域名、更新时间和按钮不覆盖图片。
3. 筛选可换行但不引发页面水平滚动；长文本截断且可在详情读取。
4. Detail 与 Picker 不叠加；详情打开时背景不可交互。

### 13.2 390px

1. Picker 为全屏 sheet，无横向溢出。
2. 标题/关闭固定；tab 可横向滚动或等宽，不截断当前项。
3. 单列或两列由可读性决定，卡片最小内容宽度 156px。
4. 来源/分类用可滚动 chips 或折叠面板。
5. 底部 CTA 固定且不遮最后一张卡，支持 safe-area inset。
6. 错误/空态首屏可见，Retry 无需横向滚动。
7. Detail 的 merchant link、Evidence、更新时间、Save、Create Pin 不重叠。

## 14. 验收标准

### 14.1 只读 Product/Saved

| ID | 场景 | 预期 | 副作用 |
|---|---|---|---|
| A-01 | 未认证 GET | 三个 Product/Saved 路径返回 401 JSON；页面进入登录态 | 无 |
| A-02 | Product 合法空态 | 认证 catalog GET 200、`items=[]`；诚实空态 | 无 |
| A-03 | Saved 合法空态 | saved GET 200、`items=[]`；“还没有收藏商品” | 无 |
| A-04 | 受控 503/非法 JSON | 错误 + Retry；不显示空态；不访问 Production | 无 |
| A-05 | Retry | 只重发一个失败 GET；成功后错误消失 | 无 |
| A-06 | 内容态 | 商品图、PDP、Evidence 类型、更新时间与 JSON 一致 | 无新增/更新 |
| A-07 | 筛选排序 | UI/query 一致；未过门禁控件不出现 | 无 |
| A-08 | Detail | detail GET 200；merchant/Evidence 链接分开 | 无 |
| A-09 | 断图 | 中性 fallback，无粉色、broken icon、alt 文字或永久 spinner | 无 |

### 14.2 Picker 与入口

| ID | 场景 | 预期 |
|---|---|---|
| A-10 | 统一入口 | 五类入口清晰；快捷入口同一 canonical flow；打开/取消无写入 |
| A-11 | 我的商品 | 上传/链接/Amazon/Shopify 是来源；Recent 只在排序；无模糊旧标签 |
| A-12 | 选品灵感 | 只展示 Product Opportunities；Amazon 是 platform；与 `/app/products` provenance 一致 |
| A-13 | 社区灵感 | 显示 Pin 来源和视觉参考说明，不出现 PDP/商品结论 |
| A-14 | 空态/错误 | 200 空数组是空态；401/5xx/network/非法 JSON 是错误；Retry 有界 |
| A-15 | 换图隔离 | A 分析中换 B，A 响应不能覆盖 B；Retry 只重试 B 当前失败阶段 |
| A-16 | fallback | Picker、详情、AI 抽屉和卡片共用中性 fallback |
| A-17 | i18n | en/zh-CN/zh-TW 无缺 key、泄漏或语义漂移 |
| A-18 | a11y | 键盘、焦点恢复、读屏、44px 目标和 AA 对比通过 |

### 14.3 Requirement-to-acceptance 矩阵

| Requirement ID | 主验收用例 | 必须保留的证据 |
|---|---|---|
| `PO90-01` | A-07、A-10、A-12 | Catalog/Picker exact GET 与同一 Opportunity ID/links 对照；打开/取消无写请求 |
| `PO90-02` | A-09、A-16 | 桌面/390 断图截图、DOM 中无 broken image/乱码、无粉紫错误背景 |
| `PO90-03` | A-11、A-12、A-13、A-17 | 三语言标签、图标 accessible name、card provenance 对照 |
| `PO90-04` | A-01、A-04、A-05、A-14 | method/path/status/code/requestId、loading/empty/error/retry 截图 |
| `PO90-05` | A-02、A-03、A-14 | test ref、认证 200 JSON、`items=[]`、无 Production ref |
| `PO90-06` | A-06、A-07、A-08、A-12 | Catalog/Saved/filter/detail JSON、merchant 与 Pinterest links、last updated |
| `PO90-07` | 两轮 USER 证据 | exact runtime/deployment、viewport、console、关键 GET 与截图 |
| `PO90-08` | A-15 | intentId/imageKey、abort/stale-response 丢弃、阶段性 Retry 证据 |
| `PO90-09` | A-01 至 A-18 | Network allowlist、bundle/test ref、零 Production/VPS/DB/timer 变更声明 |
| `PO90-10` | A-19 | Desktop/390 页头截图、计算样式、与 app shell 相邻页面标题层级对照 |
| `PO90-11` | A-20 至 A-22 | 认证 GET status/shape、raw total、active filters、code/requestId 与对应 UI 截图 |
| `PO90-12` | A-23、A-24 | 类型筛选与搜索/筛选工具栏同层截图、键盘语义、390px width/overflow 证据 |

### 14.4 两轮 USER 证据

1. 同一最终 runtime/deployment 完成桌面与 390px 两轮。
2. 覆盖 `/app/products`、`/app/products/saved`、Create Pin Product Picker、Reference Picker。
3. 每轮记录 exact URL、runtime、deployment、viewport、账号环境、关键 GET method/path/status、响应 shape、console 与截图。
4. 只读轮不得出现 POST/PATCH/PUT/DELETE，不点击 Save/Create Pin/Upload/Import/Generate。
5. 两轮通过后才可把 CP-04/05/06、PR-01/03 标为 USER PASS。
6. CP-07 需要单独受控、可回滚的副作用测试；只读轮不能替代。
7. IAB 不可用是 `BLOCKED_BROWSER_CONTROL`，不是产品 FAIL 或 USER PASS。

## 15. 状态与完成定义

| 台账项 | 本 PRD 覆盖 | 文档状态 | 完成条件 |
|---|---|---|---|
| CP-04 | 统一入口与 canonical handler | SPECIFIED | Desktop/390 与无副作用回归通过 |
| CP-05 | taxonomy、标签、图标、i18n | SPECIFIED | 三语言和 Picker/card/provenance 一致 |
| CP-06 | loading/empty/error/retry | SPECIFIED | exact GET 证据与两轮 USER PASS |
| CP-07 | 上传→分析→推荐、换图隔离 | SPECIFIED | 受控副作用测试通过，无 stale result |
| PR-01 | Product/Saved/test-bound/390 | SPECIFIED | 同一最终 deployment 两轮 USER PASS |
| PR-03 | taxonomy/fallback/provenance | SPECIFIED | canonical Product API 收敛且语义一致 |

本 PRD 完成不等于功能上线。只有代码进入最终候选、test-bound 门禁通过、桌面与 390px 两轮 USER PASS、P0 无遗留且 Production 边界未突破，才允许关闭台账项。

## 16. 实施顺序

1. 冻结 taxonomy、i18n key 和统一入口 IA。
2. 抽取全局中性 image fallback 与图片状态机。
3. 让“选品灵感”收敛到 Product Opportunities v3.7 API。
4. 完成 Product/Saved/Picker 的 loading、empty、error、retry 和 stale-request 隔离。
5. 完成上传→分析→推荐的 `intentId/imageKey` 状态机。
6. 完成 desktop/390、i18n、a11y 与无副作用门禁。
7. 在新的 test-bound runtime 上执行两轮 USER 验收。

任何一步失败时保持 Production、VPS、DB、timer 与部署不变；不得用旧 deployment、静态检查或测试库空表替代 USER PASS。

## 17. Product Supply 引用边界

Product Supply 属于独立数据线门禁，不在本 PRD 展开。它只负责向 Product Opportunities 提供通过既有真实性、安全上限、审计与回滚门禁的数据；Product UI/Picker 仍必须独立通过本 PRD 的 test-bound API、空态、provenance、桌面和 390px USER 验收。

本 PRD 不改变 Product Supply 候选、scan/write/atomic 上限、VPS、DB、timer、canary、apply 或 Production 状态，也不把任何 Product Supply dry-run、报告或本地测试引用为 Product USER PASS。

## 18. 0905 `/app/products` USER 反馈补充

本节仅冻结 Preview/test-bound 产品需求与验收口径，不授权实现、部署、环境写入、数据库写入或 Product Supply 操作。以下根因来自对当前工作区代码的只读定位；实现分支仍须在 exact candidate 上复核，不能把本节当作代码已完成证明。

### 18.1 紧凑工作台页头（`PO90-10`）

用户问题：`Product Opportunities` 标题视觉体量过大，像 Landing hero，挤占工作台首屏并压低主要筛选和结果区。

当前根因：`web/src/app/app/products/page.tsx` 单独使用 `24px + font-black` 页头，而同一 app shell 已存在约 `19–20px + font-semibold` 的紧凑页面标题模式；Product 页未复用统一页头 token/组件。

目标契约：

1. Product 页标题属于 app shell 一级页标题，不属于营销 Hero；桌面采用 `20px`、390px 采用 `18px`，字重不高于 `700`，紧凑行高，不使用超大留白或渐变 Hero。
2. 副标题和“工作原理”是次级信息；不得与标题争夺主层级，不得把首个搜索/筛选控件推到桌面首屏之外。
3. 工作台其他页面后续统一时应抽取 app-shell page-header token；本需求不授权顺带重做 Landing、Dashboard、Trends 或 Insights。

### 18.2 空态、筛选空与错误态（`PO90-11`）

用户问题：选择 Digital 后出现 `No products match these filters`，用户无法判断是测试库确实没有 Digital、默认/残留筛选误选，还是 API/data/auth 已失败。

当前根因：

1. `web/src/app/app/products/page.tsx` 默认 `productClass="physical"`，只消费 `data/isLoading/mutate`，没有消费 SWR `error`；请求失败且无 data 时可能落入通用 `products.length === 0` 分支。
2. 页面用客户端 `isDigitalProduct` 再分类，若 API 已返回数据但 taxonomy 无充分 Digital 证据，Digital 的 class total 会为 0；这与 catalog 原始 0 行不是同一事实。
3. `web/src/lib/productIdeas.ts` 当前先请求兼容端点 `/api/products/top`，失败后静默直连 Supabase fallback；API 失败、fallback 空表、过滤归零可能形成相同表象。
4. 类型选择与 category/platform/subtype/search 等筛选分别保存在本地状态；切换类型后残留条件可继续把结果降为 0，但类型选择本身未进入统一 active-filter 解释。

必须冻结为四个互斥状态：

| 状态 | 唯一判定 | UI | 禁止 |
|---|---|---|---|
| `catalog_empty` | 认证、test-bound、同源 GET HTTP 200、合法 JSON、API 原始 `items=[]`，且响应 lineage 正确 | `暂时没有通过验证的商品`；说明等待真实性审核数据；不显示 Retry | 不生成 mock，不显示 `No products match these filters` |
| `type_empty` | GET 200 且 catalog 原始总数大于 0，但所选 Physical/Digital 的服务端或冻结 taxonomy count 为 0，其他筛选均为默认 | `当前没有通过验证的数字/实体商品`；允许切回 All products | 不暗示 API 失败，不伪造某类型数量 |
| `filtered_empty` | GET 200，所选类型原始 count 大于 0，应用一个或多个非默认搜索/分类/平台/排序外筛选后结果为 0 | 列出有效筛选摘要，提供 `Clear filters`；保留当前类型 | 不把默认类型选择称为用户误选，不清除搜索以外状态而不告知 |
| `load_error` | 401/403/429/5xx/network/timeout/非法 JSON/shape/错误环境，或缺少可验证的 200 响应 | 错误态，安全展示稳定 `code`、`requestId` 和 Retry；登录错误给登录入口 | 不显示任何 empty 文案，不静默切库/直连 DB，不复用旧 data 冒充本次成功 |

补充约束：

1. API 响应必须提供或允许可靠推导 `catalogTotal`、`physicalTotal`、`digitalTotal`；客户端筛选后的 `visibleCount` 不能冒充服务端 catalog count。
2. All products 是默认类型；首次进入不得默认把真实 catalog 隐藏在 Physical 下。URL 明确携带合法类型参数时才恢复该类型，并在工具栏可见。
3. Retry 只重发同一个认证 GET。失败期间不得调用 Production、不得浏览器直连 Supabase、不得用 mock/旧缓存填充。
4. 排序不会改变集合，不应造成 empty；若排序字段不可用，应禁用该排序或显示 capability error，而不是归零。
5. 用户可见错误只暴露安全 `status/code/requestId`；token、cookie、SQL、Supabase key、堆栈和内部表名不得进入 UI。

### 18.3 类型筛选并入工具栏（`PO90-12`）

用户问题：All products / Physical / Digital 分段按钮悬在页面中间，与搜索和其他筛选割裂，形成错误的内容层级；在窄屏还会挤压真正的筛选任务。

当前根因：`web/src/app/app/products/page.tsx` 把类型选择实现为搜索工具栏上方的两张大卡片，使用独立 grid、图标、总数和选中背景；它在视觉上更像入口卡而不是一级筛选，并且没有真正的 All products 状态。

目标契约：

1. 类型选择改为搜索/Filters 同一工具栏内的单选 segmented control：`All products`、`Physical`、`Digital`。
2. 使用 `radiogroup/radio` 或等价单选语义，必须有可见选中状态、`aria-checked`、键盘方向键/Tab/Space 操作和明确 focus ring；不得只靠颜色。
3. 总数不是第三层营销卡内容；可在标签内以短 count 呈现，count 必须来自同一成功响应，未知时不显示 `0`。
4. 切换类型只改变 `family` 条件并回到第一页，不得重置 search/category/platform 等显式筛选；结果为空时由 18.2 的状态机解释并提供清除动作。
5. Desktop 保持类型、搜索、Filters、排序为一个工具区；次要动作可换行，但类型筛选不得悬在 Header 与工具栏之间。
6. 390px 使用横向可滚动但无页面横向溢出的 segmented row，或独占一行的三等分控制；每个目标至少 44px 高，标签不得截断为无意义文本。

### 18.4 精确影响文件

| 文件 | 预期职责 | 本次 PRD 动作 |
|---|---|---|
| `web/src/app/app/products/page.tsx` | 页头尺度、All/Physical/Digital 状态、工具栏合并、四态渲染、筛选摘要 | 只定位，不修改 |
| `web/src/lib/useProductIdeas.ts` | 向页面暴露 loading/error/retry/previous-data 语义，限制自动重试 | 只定位，不修改 |
| `web/src/lib/productIdeas.ts` | 移除静默 browser-DB fallback，返回 canonical API 的安全状态与计数 | 只定位，不修改 |
| `web/src/app/api/products/top/route.ts` | 当前 legacy 兼容端点；迁移期响应 shape 与错误契约 | 只定位，不修改 |
| `web/src/lib/productOpportunityCounts.ts` | raw/type/visible count 与 reduced-results 文案的事实边界 | 只定位，不修改 |
| `web/src/lib/i18n/messages/en.ts`、`zh-CN.ts`、`zh-TW.ts` 及其他 locale | 紧凑页头、三段类型筛选、四态文案、Retry/清除筛选文案 | 只定位，不修改 |
| `web/scripts/test-product-opportunity-counts.ts`、`web/scripts/test-product-ideas-picker.ts` | count/state/toolbar 的 focused contract | 只定位，不修改 |

最终实现仍应收敛到第 8.3 节的 canonical `GET /api/product-opportunities`；在该路由落地前，`/api/products/top` 仅是明确标记的兼容边界，不能继续以浏览器 Supabase fallback 隐藏失败。

### 18.5 Desktop + 390px 两轮验收

| ID | Viewport / 场景 | 操作 | 必须观察到 | 证据与副作用 |
|---|---|---|---|---|
| A-19 | Desktop 与 390px 页头 | 进入 `/app/products` | 标题分别不超过 20px/18px、紧凑行高；首屏可见类型/搜索工具区；无 Landing hero 视觉 | 截图 + computed style；GET-only，零写 |
| A-20 | 真实空 catalog | test-bound 认证 GET 返回 200、`items=[]`、totals 皆 0 | 显示 `catalog_empty`；无筛选误选文案、无 Retry、无假卡 | status/shape/test ref/requestId + 截图；零写 |
| A-21 | 类型空 / 筛选空 | 先验证 raw catalog 非空；选择 count=0 的类型，再在非空类型添加不匹配筛选 | 前者显示 `type_empty` 并可回 All；后者显示 `filtered_empty`、筛选摘要和 Clear filters | raw/type/visible counts + query/UI 对照；零写 |
| A-22 | API/auth/data 错误 | 分别受控返回 401、503、timeout 或 invalid shape 后点击一次 Retry | 只显示 `load_error`；安全 code/requestId；Retry 只重发一次 GET；不出现 empty 或旧卡片 | Network + console + UI；无 Supabase fallback、无 Production ref、零写 |
| A-23 | Desktop 工具栏 | 依次选择 All/Physical/Digital，使用键盘切换并组合 search/category/platform | 三段控制与搜索/Filters 同属一个工具区；选中/焦点/结果摘要一致；无悬浮大卡 | 1440 或 1280 截图、a11y tree、GET/query；零写 |
| A-24 | 390px 工具栏 | 390×844 重复 A-23 并滚动页面 | body/html `scrollWidth <= innerWidth`；三段标签可读、44px 目标、无控件遮挡；空/错误态首屏可理解 | 截图 + width/target size + console；零写 |

两轮定义：在同一 exact Preview runtime/deployment 上，Desktop 完整执行 A-19 至 A-23，390px 完整执行 A-19 至 A-24；两轮都必须记录认证 GET、响应状态/shape、active filters、console 和无写请求证明。只有这些证据闭合，`PO90-10/11/12` 才可从 `SPECIFIED` 变为 `USER PASS`。
