# Product Opportunity 定位校正 v3.1

**日期：** 2026-07-14　**状态：** 决策人已定调并二次拍板（八条调整全部落地），直接作为 PRD 与实施依据
**版本：** v3.1（**唯一现行版本**）。取代同目录 v3.0 草案——v3.0 的 §13 开放问题已被决策人在本版全部回答，v3.0 不再单独存在。
**性质：** **定向修订**（不是全面重写）。本文只校正 Product Opportunity 这一条线的产品定位、数据模型、字段优先级、指标定义、采集成功定义与验收标准。

**v3.1 相对 v3.0 的八条变化（决策人 2026-07-14 拍板）：**

| # | 变化 | 落地章节 |
|---|---|---|
| 1 | **删除 Competition badge**（属 marketplace evaluation，不属 Pinterest opportunity discovery） | §7.6、§7.1、§7.5、§9.2、§2 |
| 2 | Demand badge **改名 `Pinterest Interest`**（禁 `Product Demand`） | §7.6 |
| 3 | Trend badge **改名 `Keyword Trend`**（禁 `Product Trend`） | §7.6 |
| 4 | Card badge 集合定为 **Pinterest Interest / Keyword Trend / Source(Merchant)** | §7.1、§7.6 |
| 5 | **Etsy API：MVP 不立项**，记为 Future Enhancement；且**仅用于 enrichment，不用于 discovery** | §6.4 |
| 6 | `detail_fetch_status` 四态 **`available \| blocked \| not_found \| not_attempted`**；**UI 不展示技术状态**，统一 "Product details unavailable" | §6.3、§7.3 |
| 7 | Commercial Signal **全站统一 `Product Linked` / `Content Only`**；**禁 `Product Related`** | §8 |
| 8 | 核心原则块写进开头 | §0 |

**取代/修订关系：**

| 被修订文档 | 被修订范围 | 未受影响部分 |
|---|---|---|
| 《产品方向重规划 keyword-pin-product v2.0 final 20260710》 | **§3 Product Opportunity Finder 全节**（§3.1 Card / §3.2 Detail / §3.3 三指标解释 / §3.4 验收）＋ **§2.2 Pin Ideas 的 `Product Related` 措辞**（v3.1 第 7 条统一为 `Product Linked`） | §0 全局原则、§1 Keyword Trend、§2 Pin Ideas 其余部分、§6 全局红线 **全部继续有效** |
| 《数据侧任务书-参考池与Product池 v1.1 20260713》 | **§3 Product 数据字段规范**（升级为分级字段表）、**T2 任务卡的写后验证/验收标准** | §1 双池用途、§2 双来源与两层准入、§6 全局红线、其余任务卡（T1/T3–T10）继续有效 |

> **本文不废止任何全局红线。** v2.0 §6（禁 Opportunity 标签 / 禁编造 / 不跨页重复）与 v1.1 §6（逐任务放行 / STL 不动 / 可整批回滚 / 合规只读）在本文下**继续全量生效**。

---

## 0. 定位校正（决策人定调）

### 0.1 核心原则（**最高优先级，任何后续设计冲突以此为准**）

```
VibePin: Pinterest Opportunity Discovery Tool

不是 Product Database
不是 Marketplace Intelligence Tool

核心资产：Pinterest evidence
         = source pin + saves + trend + external product link

Product details: Optional enrichment only
```

### 0.2 旧的隐含假设（**废弃**）

> `Product Opportunity = 完整商品数据库`

在这个假设下，采集端的成功标准变成"把商品详情页抓全"，抓不到就想办法**凑**——于是 Pin 标题被写进 `product_name`、Pin 图被写进 `product_image_url`。这正是 T10 报告中 798 行历史脏数据的**病根**（798/798 假商品图、798/798 收藏数混用）。**问题不在实现，在定位。**

### 0.3 新定位

```
发现机会      >  完整复制商品
真实链接      >  猜测字段
缺失字段 NULL >  制造假数据
```

**新流程：**

```
Pinterest Pin
  → 发现 External Product URL
  → 验证 Pinterest 用户兴趣（来源 Pin 真实 + 收藏数真实）
  → 形成 Product Opportunity
  → 用户点击 View Product 去看商品
```

**核心资产（我们真正拥有、竞品拿不到的东西）：**

1. **Pinterest 内容证据**（是哪张 Pin、长什么样、发布多久）
2. **用户收藏行为**（saves / velocity —— 真实的兴趣投票）
3. **商品来源链接**（可点击验证的真实外部商品页）
4. **关键词趋势**（trend / search keyword 上下文）
5. **类目关系**（category、相似聚合）

**核心资产**不是**商品详情**，也不是**市场竞争情报**。用户到 VibePin 来不是为了看价格或市场竞争度——那 Amazon/Etsy/Jungle Scout 自己就有；用户来是为了知道**"Pinterest 上的人正在为什么样的商品疯狂收藏"**。

### 0.4 两条边界（v3.1 新增，用来防止产品被拉回旧定位）

| 我们**不做** | 因为 |
|---|---|
| **Marketplace evaluation**（竞争度、市场饱和度、卖家数、利润估算、选品评分） | 这是 Jungle Scout / Helium 10 的地盘。做它意味着回答"这个商品市场竞争如何"——**不是我们的问题**。 |
| **Product database / catalog**（完整商品详情、SKU、库存、比价） | 这是 Amazon/Etsy 自己的地盘。做它意味着与外部站点的反爬做无尽军备竞赛，并制造凑数据的激励。 |

> **我们只回答一个问题：Pinterest 上哪些商品机会正在被用户关注。**

---

## 1. 页面重新定义：Product Opportunity Finder 不是商品商城

| 维度 | ❌ 旧理解（商品商城 / 选品工具） | ✅ 新定义（机会发现） |
|---|---|---|
| 页面在回答什么 | "这个商品长什么样、多少钱、竞争大不大" | "Pinterest 上哪些内容正在把用户导向真实商品，用户对它有多热" |
| 卡片主图 | Product Image | **Source Pin Image**（商品图为可选增强） |
| 卡片 badge | Demand / Trend / **Competition** | **Pinterest Interest / Keyword Trend / Source(Merchant)** |
| 一行缺详情时 | 隐藏 / 不入库 | **照常展示**，显示 "Product details unavailable" + "View source product" |
| 商品详情 | 必需品 | **增强项（Optional enrichment only）** |
| 成功指标 | 商品详情完整率 | **发现了多少条真实的、有 Pinterest 兴趣验证的商品机会** |

> **功能名 "Product Opportunity Finder" 保留**（导航/页面标题），与 v2.0 §0 一致；禁的仍然是指标层的 Opportunity 标签/评分/结论。

---

## 2. 数据模型：一行 = 一个 Opportunity，不是一个 Product

一行 `pin_products` 记录的语义从"一个商品"变为 **"一条经 Pinterest 验证的商品机会"**：

```
Opportunity
├── Opportunity Evidence（必须，缺一不成立）
│   ├── 来自哪张 Pin           parent_pin_id / source_pin_url
│   ├── 指向哪个真实商品       external_product_url
│   ├── Pinterest 用户多热     source_pin_save_count（+ save velocity）
│   ├── 属于什么类目/词        category / keyword & trend context
│   ├── 怎么发现的             discovery_method
│   └── 现在是否有效           lifecycle_status
│
└── Product Details（Optional enrichment；抓不到就 NULL）
    ├── product_name
    ├── product_image_url
    ├── price / currency
    ├── merchant_name
    ├── availability
    └── detail_fetch_status   ← available | blocked | not_found | not_attempted
```

**🔴 数据模型中不存在 competition / saturation / opportunity score / product rating 这一层。**（v3.1 第 1、4 条）任何"市场竞争 / 商品评分"派生字段一律**不建、不存、不算、不展示**。

**provenance 分离是结构性要求**：Pinterest 侧字段与 External product 侧字段**永远分列存放，永不互相回填**。这是本次校正最不可让步的一条。

---

## 3. 字段优先级表（两级）

### 3.A 必须字段 —— Opportunity Evidence（缺任一 → **不得成为 Opportunity，不得写入**）

| 字段 | 语义 | 缺失时 |
|---|---|---|
| `parent_pin_id` | 来源 Pin 的 pin_id（溯源主键） | **拒收该行** |
| `source_pin_url` | 来源 Pin 的 Pinterest 链接 | **拒收该行** |
| `external_product_url` | 真实外部商品详情页 URL（须过 PDP 闸门） | **拒收该行** |
| `source_pin_save_count` | 来源 Pin 的真实收藏数（Pinterest 兴趣证据） | **拒收该行** |
| `category` | 类目 | **拒收该行** |
| keyword / trend context（`seed_keyword` / `source_keyword` / `trend_keyword_id`） | 关键词与趋势上下文 | **拒收该行** |
| `discovery_method` | `shop_the_look` \| `outbound_link` | **拒收该行** |
| `lifecycle_status` | `active` \| `retired` | **拒收该行** |

> **列映射与 schema 现状（2026-07-14 实证）：**
> - 沿用 v1.1 §3：`external_product_url` = `source_url`（语义=商品页）；`source_pin_save_count` 已在库；`discovery_method` / `source_pin_saves` / `source_pin_image_url` 为 v45 列；
> - ✅ **v47 迁移已应用**（不再是设想）：**`product_name` 已放宽为可空**、**`detail_fetch_status` 已建**、**`availability` 已建**。→ **本文 §6 描述的"Etsy 详情字段全 NULL 仍是合法 Opportunity"在 DB 层已真实可行**；
> - ⏳ **v48（技术侧进行中）**：把 `detail_fetch_status` 的 CHECK 约束修正为**最终四态** `available | blocked | not_found | not_attempted`（§6.3）；partial unique index（§9.2 ④）随之落地。

### 3.B 增强字段 —— Product Details（**Optional enrichment only，非阻塞**；抓不到一律 NULL，**绝不猜测、绝不代填**）

| 字段 | 语义 | 抓不到时 |
|---|---|---|
| `product_name` | **商品页上的商品标题** | **NULL**（❌ 禁止回退 Pin 标题；v47 放宽为可空） |
| `product_image_url` | **商家 CDN 上的真实商品图** | **NULL**（❌ 禁止回退 pinimg 图） |
| `price` | 商品价格 | NULL |
| `currency` | 币种 | NULL |
| `merchant_name` | 商家名 | NULL（`merchant_domain` 从 URL 即可得，属可靠字段，可用于 Source badge） |
| `availability` | 在售/售罄 | NULL |
| `detail_fetch_status` | `available` \| `blocked` \| `not_found` \| `not_attempted` | **必填**（见 §6.3） |

**NULL 是合法且诚实的状态。** 一行 Opportunity 的价值由 3.A 决定，不由 3.B 决定。

---

## 4. 三条永久禁止（红线，任何管线/回填/修复任务都不得突破）

| # | 禁止 | 为什么 |
|---|---|---|
| **① 禁止把 Pin 标题写进 `product_name`** | Pin 标题是**内容标题**（"25 Cozy Fall Outfit Ideas"），不是商品名（"Wool Blend Oversized Cardigan"）。二者语义完全不同。 | **T10 脏数据的直接病根**：798 行 `product_name` 全部是来源 Pin 标题。 |
| **② 禁止把 Pin 图（i.pinimg.com）写进 `product_image_url`** | Pin 图是生活方式/场景图，不是商品图。 | T10：798/798 行 `image_url` 落在 `i.pinimg.com`，**0 行**落在商家 CDN。 |
| **③ 禁止猜测/推断/代填任何商品字段** | 包括但不限于：用来源 Pin 收藏数冒充产品收藏数、用类目均价猜价格、用域名猜商家名、用 Pin 描述凑商品描述。 | T10：798/798 行 `save_count` 与 `source_pin_save_count` **逐行完全相等**（直接抄写）。 |

**统一处置：抓不到 → 一律 NULL。** 违反以上任一条的行，**不得写入，不得展示**；已写入的按 v1.1 T10 处置（软退役，见 §10.4）。

---

## 5. 采集成功的新定义

### 5.1 废弃旧定义

> ❌ 废弃：**"成功 = 抓到商品详情页的全部字段"**

这个定义把"外部站点的反爬策略"错误地记成了"我们的失败"，并制造了**凑数据**的动机。

### 5.2 新定义

> ✅ **Discovery Success = 发现真实外部商品链接 + Pinterest 来源验证通过**
>
> 即：3.A 必须字段全部齐备（`external_product_url` 过 PDP 闸门 + `source_pin_url`/`parent_pin_id`/`source_pin_save_count` 真实）。**与是否抓到商品详情无关。**

### 5.3 两个指标必须分开统计（**不得合并成一个"成功率"**）

| 指标 | 定义 | 分母 |
|---|---|---|
| **Discovery success rate** | 发现有效商品链接（过 PDP 闸门 + 来源验证）的数量 ÷ 尝试数 | 扫描/尝试的 Pin 数 |
| **Detail enrichment rate** | 成功获取商品详情的数量（`detail_fetch_status='available'`）÷ **已发现的有效链接数** | Discovery 成功的行数 |

**示例（必须能这样表达）：**

| 域名族 | Discovery success rate | Detail enrichment rate |
|---|---:|---:|
| Etsy | **100%** | **0%**（WAF 403 → `blocked`） |
| Shopify 独立站 | 高 | 高（~83%，T10 实测） |
| Poshmark | 高 | 高（100%，T10 抽样） |

> 🔴 **禁止表述**："Etsy = 0%"。这句话把"详情抓不到"说成了"发现失败"，是旧定位的语言残留。**正确表述**："Etsy：Discovery 100% / Detail 0%（blocked）"。

---

## 6. Etsy 处理策略（单独一节，因为它是 70.4% 的存量）

**结论：不排除 Etsy。**

### 6.1 判定

| 事实 | 含义 |
|---|---|
| Etsy 对合规轻量 GET 一律 403（T10：240/240 全拦，零例外；T1 dry-run 独立复现） | 这是**商品详情抓取被拦**（detail fetch blocked） |
| Etsy 的 URL 合法（`/listing/…` 过 PDP 闸门） | 商品**链接是真的** |
| 来源 Pin 真实、`source_pin_save_count` 真实 | Pinterest **兴趣验证通过** |
| ⇒ | **这是一条完全合法的 Product Opportunity** |

> **决策人原话（v3.1 第 5 条）：** 当前 Etsy 即使 `product_name` / `product_image_url` / `price` 全 NULL，**只要 `external_product_url` + `source_pin_url` + Pinterest evidence 存在，即为合法 Opportunity。**

### 6.2 处置规则

1. **写入 Opportunity**：3.A 必须字段齐备 → 正常入库；
2. **详情字段全部 NULL**：`product_name` / `product_image_url` / `price` / `currency` / `availability` = NULL；
3. **`detail_fetch_status = 'blocked'`**；
4. **UI 照常展示**：卡片主图 = Source Pin Image；详情区显示 **"Product details unavailable"** + **"View source product"**（**不显示技术原因**，见 §6.3）；
5. **不为了抓 Etsy 详情去突破合规红线**（渲染型/代理型抓取违反 v1.1 §6 红线第 4 条）。

### 6.3 `detail_fetch_status` 四态（DB 层）

> **状态（2026-07-14）**：列已由 **v47 建好并应用** ✅；**v48 正在把 CHECK 约束修正为下表最终四态**（v3.0 草案曾写 `success/blocked/unavailable`，**作废**）。

| 值 | 含义 | UI 展示 |
|---|---|---|
| `available` | 详情抓取成功，增强字段有值 | 展示 Product Name / Price / Product Image（增强区） |
| `blocked` | 站点 WAF/反爬拦截（403 等），**链接本身有效** | **"Product details unavailable"** |
| `not_found` | 商品已下架 / 404 / 重定向走了 | **"Product details unavailable"**（并触发 `lifecycle_status` 复核，见 §10.4） |
| `not_attempted` | 尚未尝试增强（如 Discovery 刚写入、增强队列未跑到） | **"Product details unavailable"** |

**🔴 UI 不展示技术状态（v3.1 第 6 条）：**
- ✅ 唯一允许的用户可见文案：**"Product details unavailable"**（+ "View source product" CTA）；
- ❌ **禁止**显示 "Merchant blocks preview" / "Blocked by merchant" / "403" / "not_found" / 任何暴露抓取内部状态的措辞；
- ❌ **禁止**因 status 不同而给出不同的用户文案。**四态在 UI 上收敛为同一句话。**

> `detail_fetch_status` 的价值是**内部的**：把"我们抓不到"（blocked）、"商品没了"（not_found）、"还没抓"（not_attempted）区分开，用于 dry-run 报告、增强队列调度与后续优化决策。**它是运营字段，不是用户字段。**

### 6.4 Etsy 官方 API —— **Future Enhancement，MVP 不立项**

| 项 | 决策 |
|---|---|
| MVP 是否立项 | ❌ **不立项**（v3.1 第 5 条） |
| 状态 | 📌 **Future Enhancement**（记录在案，待未来独立评估申请/配额/成本） |
| 用途边界（**硬约束**） | **Etsy API 仅用于 Product enrichment（补 3.B 增强字段），绝不用于 Opportunity discovery。** Discovery 永远只依赖 Pinterest evidence（§3.A）。 |
| 为什么划这条线 | 若 discovery 依赖外部 API，产品的核心资产就从"Pinterest evidence"漂移成"外部商品目录"——那就退回旧定位了。API 只能锦上添花，不能成为发现机会的前置条件。 |

---

## 7. Product 页面字段（对 v2.0 §3.1 / §3.2 的定向修订）

### 7.1 Product Card —— 必须显示

| 字段 | 来源 | 说明 |
|---|---|---|
| **Source Pin Image** | `source_pin_image_url` | **卡片主图**（← 对 v2.0 §3.1 的关键修订，见 §7.4） |
| **Keyword** | `seed_keyword` / `source_keyword` | 可点击筛选 |
| **Category** | `category` | |
| **Saves** | `source_pin_save_count` | Pinterest 兴趣证据（product-pin 存在时按既有 precedence） |
| **External Product Source** | `external_product_url` | |
| **Merchant / domain** | `merchant_domain`（从 URL 可得，可靠） | 用户语言展示（"Etsy" / "Shopify store" / 域名） |
| **View Product** | 跳 `external_product_url` | **核心 CTA** |

**Card Badge 集合（v3.1 第 4 条，最终定稿）：**

| ✅ 显示 | ❌ 删除 |
|---|---|
| **Pinterest Interest** | ~~Competition~~ |
| **Keyword Trend** | ~~Opportunity Score~~ |
| **Source (Merchant)** | ~~Product Rating~~ |
| | ~~Product Demand / Product Trend（旧名）~~ |

### 7.2 Product Card —— 商品详情存在（`detail_fetch_status='available'`）时**额外**显示

- **Product Name**（`product_name`）
- **Price**（`price` + `currency`）
- **Product Image**（`product_image_url`，作为副图/缩略角标，**不取代 Source Pin Image 主图位**）

### 7.3 Product Card —— 商品详情不存在（`blocked` / `not_found` / `not_attempted`）时

- 显示 **"Product details unavailable"** + **"View source product"**；
- **三种状态使用同一句文案**（§6.3）；
- 🔴 **不要隐藏该卡片**。Opportunity 的价值在 3.A，不在 3.B。

### 7.4 ⚠️ 与 v2.0 §3.1 的冲突及处置（**明确记录**）

| | v2.0 §3.1（旧） | v3.1（新） |
|---|---|---|
| Card 主图 | **Product Image** | **Source Pin Image** |
| Product Name | 保留（必显） | **可选增强**（NULL 时不显示） |
| Demand badge | 保留 | **改名 `Pinterest Interest`**（§7.6） |
| Trend badge | 保留 | **改名 `Keyword Trend`**（§7.6） |
| **Competition badge** | **保留（必显）** | **🔴 删除**（§7.6） |
| Source Type / Validating Source Count | 保留 | 保留（并入 Source(Merchant) 叙事） |

**处置：本文明确覆盖 v2.0 §3.1 的"卡片主图 = Product Image"与"Competition badge 必显"这两条。**

**卡片主图改为 Source Pin Image 的理由（三条，写清楚以免日后反复）：**
1. **数据现实**：真实商品图的获取率天然受站点反爬支配（Etsy 系 = 0%）。把主图绑定在一个**外部站点可以随时掐断**的字段上，等于把产品的可用性外包给 Etsy 的 WAF。
2. **历史教训**：v2.0 的"Product Image 必显"正是采集端"凑图"的需求来源——抓不到真商品图，就拿 pinimg 图冒充（T10：798/798）。**要求必显一个抓不到的字段，就是在制造假数据的激励。**
3. **产品逻辑**：Source Pin Image 才是我们真正的核心资产（§0）。用户在 Pinterest 上被打动的、正在疯狂收藏的，就是那张 Pin 图。

**v2.0 §3.2 Detail 字段**：保留其结构（Product Pin URL / Source Pin URL 分行、Product Pin Saves / Source Pin Saves 分行），这些**恰恰就是 provenance 分离**，与 v3.1 完全一致。仅修订：① Competition 从 Detail 移除；② Demand/Trend 改名；③ 详情字段 NULL 时按 §7.3 展示。

### 7.5 Detail 字段（在 v2.0 §3.2 基础上）

| 分区 | 字段 |
|---|---|
| **Pinterest Evidence** | Source Pin Image、Source Pin URL、Source Pin Saves、**Pinterest Interest**、**Keyword Trend**、Trend Keyword、Search Keyword、Freshness、Category、Discovery method（用户语言：Shop the Look / Product link Pin）、Validating Source Count |
| **External Product** | External Product URL（**主 CTA: View Product**）、**Source (Merchant / domain)**、Product Name\*、Price\*、Product Image\*、Availability\*、详情缺失提示（"Product details unavailable" + "View source product"） |
| **Product Pin（仅 Shop the Look）** | Product Pin URL、Product Pin Saves（**outbound 行一律 NULL，不得回填 source 值**） |
| **信号** | **Commercial Signal**（`Product Linked` / `Content Only`，见 §8） |
| **🔴 已删除** | ~~Competition~~、~~Opportunity / Opportunity Score / Why opportunity~~、~~Product Rating~~ |

`*` = 增强字段，NULL 时**不渲染该行**（不显示空占位、不显示 "—" 冒充数据）。

### 7.6 Badge 定义（**Metric Definition，v3.1 定稿**）

#### 7.6.1 ✅ `Pinterest Interest`（原 Demand badge，**改名**）

| 项 | 内容 |
|---|---|
| **命名** | **`Pinterest Interest`**（全文统一）。🔴 **禁用 `Product Demand` / `Demand`** |
| **定义** | **基于 Pinterest 用户行为的兴趣强度** |
| **数据源** | `source_pin_save_count` + save velocity（**仅 3.A 证据**） |
| **它不是什么** | 🔴 **不是商品市场需求（market demand）**。它衡量的是"Pinterest 用户对这条内容的收藏热度"，**不能**被解读为"这个商品在市场上好卖" |
| **档位** | High / Medium / Low / Not enough data（同类分位；数据不足显示 **Not enough data**，不硬给结论） |
| **必须的白话解释句** | 例："该 Pin 的收藏表现处于同类前列（数据源：Pinterest saves 同类分位）" —— 沿用 v2.0 §3.3 的"每个 badge 旁一句数据从哪来"要求 |
| **禁止** | 不得参与任何综合评分；不得与 price / 商品字段做任何计算 |

#### 7.6.2 ✅ `Keyword Trend`（原 Trend badge，**改名**）

| 项 | 内容 |
|---|---|
| **命名** | **`Keyword Trend`**（全文统一）。🔴 **禁用 `Product Trend`** |
| **定义** | **基于 keyword trend / search trend 的 Pinterest 内容趋势** |
| **数据源** | `trend_keywords` 的变化率（weekly / monthly / yearly change）、search trend |
| **它不是什么** | 🔴 **不是商品销量趋势**。它衡量的是"Pinterest 上这个关键词的内容热度走向" |
| **档位** | Rising / Stable / Declining / Not enough data |
| **必须的白话解释句** | 例："相关关键词近期正在上升（数据源：trend_keywords yearly change）" |
| **与 Keyword Trend 页的关系** | 沿用 v2.0 §6.3"指标不跨页重复"：**数值与曲线只在 Keyword Trend 页**；Product 页只出 badge + 一句解释 |

#### 7.6.3 ✅ `Source (Merchant)`

| 项 | 内容 |
|---|---|
| **定义** | 商品来源商家 / 域名（`merchant_domain`，从 URL 直接可得，**不依赖详情抓取**） |
| **展示** | 用户语言（"Etsy" / "Shopify store" / "Amazon" / 域名），**不直出内部字段** |
| **为什么它可以做 badge** | 它是**可靠字段**：即使 detail fetch 被 403，域名依然 100% 可得。这与"必显一个抓不到的字段"的错误正相反 |

#### 7.6.4 🔴 `Competition` —— **删除（v3.1 第 1 条）**

> **理由（决策人原话，写进 PRD）：**
>
> **Competition 属于 marketplace evaluation，不属于 Pinterest opportunity discovery。**
> 它回答的是"这个商品市场竞争如何"，而 **VibePin 回答的是"Pinterest 上哪些商品机会正在被用户关注"**。
> **Competition 容易把产品重新引导回商品评分工具。**

**执行范围（全部移除，不保留、不降级、不藏进 Detail）：**

| 层 | 动作 |
|---|---|
| **Card** | 移除 Competition badge |
| **Detail** | 移除 Competition 行与其解释句 |
| **筛选/排序** | 移除 "Low competition" 排序项与任何 competition 筛选器（排序保留 Most saved 默认 / Rising / Newest） |
| **数据模型** | 不建、不存 competition / saturation 派生字段（§2） |
| **验收标准** | 从 §9.2 与 v2.0 §3.4 中移除一切 Competition 相关条款（§9.3 是新的全局断言） |
| **代码（技术侧）** | `deriveProductCompetition` 等派生函数退出 Product 页路径 |

> 注：**Keyword Trend 页的 `Content Saturation`**（v2.0 §1.1 已把 Competition 降级并改名的那一项，口径 = 内容视觉密度、只在 keyword 详情辅助区）**是另一个东西，不在本条删除范围内**——它衡量的是"Pinterest 内容密度"（内容侧），不是"商品市场竞争"（marketplace 侧）。v2.0 §1 继续有效。

#### 7.6.5 🔴 其他一律禁止

- ❌ `Opportunity Score` / `Opportunity Label`（Best / Good / Niche / Strong / Watch / Crowded）
- ❌ `Product Rating` / 星级 / 0–100 分 / A-B-C 等级
- ❌ 任何"这个商品值不值得做"的综合结论
- ❌ 任何跨 Pinterest 侧与商品侧混算的复合指标

---

## 8. Commercial Signal（**全站统一措辞，v3.1 第 7 条**）

> Commercial Signal **不代表商品价值评分**，只代表 **"该内容是否连接到真实、已验证的商品来源"**。

| 状态 | 定义 |
|---|---|
| **`Product Linked`** | **Verified external product URL exists** —— 存在**已过 PDP 闸门**的 `external_product_url`（即 3.A 齐备） |
| **`Content Only`** | 不存在 |

### 8.1 全站统一（**跨页强制**）

| 页面 | 旧措辞 | **v3.1 统一后** |
|---|---|---|
| Product Opportunity | （无/混用） | **`Product Linked` / `Content Only`** |
| **Pin Ideas**（v2.0 §2.2） | ~~`Product Related`~~ | **`Product Linked` / `Content Only`** |

**🔴 禁止 `Product Related`。理由：`Related` 一词包含推测**——"相关"意味着我们在猜这条内容和某个商品有关系；而我们只承认一件事：**外链存在且已验证**。措辞必须与判定强度一致。

> **这意味着三工具 PRD v2.0 §2.2 也被本文校正**（Pin Ideas 页的 `Product Related` → `Product Linked`）。判定规则不变（v2.0 §2.2 的落地判定：`is_ecommerce=true` / `outbound_link` 命中电商域规则 / 该 pin 是 `pin_products.parent_pin_id`），**但措辞与"已验证"语义必须对齐——即 outbound_link 须过 PDP 闸门才算 Product Linked。**

### 8.2 禁止（沿用 v2.0 §6 全局红线）

- ❌ 任何分数（0–100、1–5 星、百分比）
- ❌ 任何等级（High / Medium / Low、A/B/C）—— Commercial Signal **只有两个状态**
- ❌ 任何 Opportunity 标签
- ❌ 任何"这个商品值不值得做"的综合结论

---

## 9. T2 Pipeline 新流程（修订 v1.1 T2）

### 9.1 流程图

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. Pinterest Pin（pin_samples，outbound_link 非空）              │
└───────────────┬─────────────────────────────────────────────────┘
                ▼
┌─────────────────────────────────────────────────────────────────┐
│ 2. 外链发现 External Product URL Discovery                       │
│    解析 outbound_link；短链展开到终点                            │
└───────────────┬─────────────────────────────────────────────────┘
                ▼
┌─────────────────────────────────────────────────────────────────┐
│ 3. 🚪 PDP 闸门（Product Detail Page Gate）—— v1.1 §2 两层判定    │
│    ① URL 规则层：/products/ · /listing/ · /dp/ · 品牌商品路径    │
│    ② 页面验证层（只读轻量）：og:type=product / schema.org        │
│       Product / 价格元素 —— 任一满足                             │
│    ⛔ 拦截：search / browse / category / collection / 店铺首页 /  │
│       博客 / 教程 / lookbook / 社媒 / 短链解析失败                │
│    ⚠️ 403（WAF）≠ 不是商品页：URL 规则层过 + 已知电商域          │
│       → 放行为 Opportunity，标 detail_fetch_status='blocked'     │
└───────────────┬─────────────────────────────────────────────────┘
                ▼
┌─────────────────────────────────────────────────────────────────┐
│ 4. 必须字段校验（§3.A）                                          │
│    parent_pin_id · source_pin_url · external_product_url ·      │
│    source_pin_save_count · category · keyword ctx ·             │
│    discovery_method · lifecycle_status                          │
│    ❌ 任一缺失 → 拒收（记 rejection reason，不写库）              │
└───────────────┬─────────────────────────────────────────────────┘
                ▼
┌─────────────────────────────────────────────────────────────────┐
│ 5. ✅ 写入 Opportunity（insert-only）                            │
│    lifecycle_status='active'                                    │
│    detail_fetch_status='not_attempted'；详情字段 NULL            │
│    ★ 到这一步 Discovery 就已经成功了（§5.2）                     │
└───────────────┬─────────────────────────────────────────────────┘
                ▼
┌─────────────────────────────────────────────────────────────────┐
│ 6. 详情增强（Optional enrichment：可选、非阻塞、                 │
│    失败不影响第 5 步的成果）                                     │
│    抓 product_name / product_image_url / price / currency /      │
│    merchant_name / availability                                 │
│    ├─ 成功    → detail_fetch_status='available'                  │
│    ├─ 403/反爬 → 'blocked'    ，详情字段保持 NULL                │
│    ├─ 404/下架 → 'not_found'  ，详情 NULL（触发 lifecycle 复核） │
│    └─ 未跑到  → 'not_attempted'（保持第 5 步的初值）             │
│    🔴 任何情况下不得回退 Pin 标题 / Pin 图 / 猜测值（§4）        │
│    🔴 本步骤不产出任何 competition / score / rating（§7.6.4）    │
└─────────────────────────────────────────────────────────────────┘
```

**关键结构变化**：第 5 步（写入）在第 6 步（详情）**之前且不依赖它**。旧管线把详情抓取当作写入的前置条件，抓不到就凑——这是 T10 脏数据的**机制性成因**。新管线里详情抓取是一个**可以整体失败而不影响产出**的旁路。

### 9.2 新验收标准（**四红线**，取代 v1.1 T2 的"product_name/price/image 全部存在"）

> ❌ **正式废弃**的旧验收：*"商品图/分类/来源正确" + 隐含要求 product_name / price / product_image 全部存在*。
> 该条在 Etsy 系（70.4% 存量）上**永远不可能通过**，只会逼出假数据。

| # | 红线 | 验收方法 |
|---|---|---|
| **①来源真实性** | `source_pin_url` 与 `external_product_url` **均存在且均可打开**；`source_pin_save_count` 非空且与 pin_samples 一致 | 抽查 30 行：两个 URL 全部可访问；saves 与 pin_samples 逐行核对 |
| **②不伪造商品** | `product_image_url` ≠ `source_pin_image_url` 且 host **不含 i.pinimg.com**；`product_name` ≠ 来源 Pin 标题 | SQL 全量断言：`product_image_url LIKE '%pinimg%'` 计数 = **0**；`product_name = (来源 Pin title)` 计数 = **0**；**NULL 视为通过** |
| **③provenance 分离** | Pinterest 侧与 External product 侧字段不合并、不互相回填。outbound 行 `product_pin_url` / `product_saves` 必须为 **NULL**（不得抄 source 值） | SQL 全量断言：`discovery_method='outbound_link' AND product_saves IS NOT NULL` 计数 = **0**；`save_count = source_pin_save_count` 计数 = **0** |
| **④生命周期** | `retired` 旧行与 `active` 新行**可并存**；同一 `parent_pin_id + external_product_url` 允许一条 retired + 一条 active（重采不因唯一约束失败；由 v47 **partial unique index** 保证） | 构造重复采集用例：旧行 retired 后新行成功 insert；`/api/products/top` 只返回 active |

**外加（沿用 v1.1，不变）：**
- STL（`discovery_method='shop_the_look'`）**零回归、零触碰**；
- 全批可按 `discovery_method + created_at 窗口` **一条 SQL 整批回滚**；
- 首批 ≤100 行、insert-only、不跑 scoring。

**注意**：红线 ② 的 NULL 视为通过——**这正是本次校正的要点**。旧验收把 NULL 判为失败，新验收把**假数据**判为失败。

### 9.3 🔴 第五条全局断言（v3.1 新增：**无 marketplace evaluation 残留**）

除四红线外，UI 与数据侧还须通过：

| 断言 | 检查方法 |
|---|---|
| Product 页 UI **不出现** `Competition` / `Opportunity` / `Opportunity Score` / `Why opportunity` / `Product Rating` / `Product Demand` / `Product Trend` 字样 | grep Product 页与 products 组件的 UI 字符串与 i18n 文案 = **0**（功能名 "Product Opportunity Finder" 页标题除外） |
| Commercial Signal 全站**只出现** `Product Linked` / `Content Only`；**不出现** `Product Related` | grep Product 页 + Pin Ideas 页 = **0** 处 `Product Related` |
| Badge 只有三个：`Pinterest Interest` / `Keyword Trend` / `Source(Merchant)` | Card 快照人工核对 |
| 数据侧无 competition / saturation / score 派生列被 Product 页读取 | 代码路径检查 |

---

## 10. dry run 新指标体系（修订 v1.1 T1 报告口径）

### 10.1 报告必含（**Discovery 与 Detail 分开**）

**A. Discovery 层（决定产出）**

| 指标 |
|---|
| 扫描 Pin 数 |
| 含站外链接 Pin 数 |
| 过 PDP 闸门数（= 判定为具体商品页） |
| PDP 闸门拒绝数 + **rejection reason 分布**（首页 / 分类 / collection / 搜索 / 博客 / 教程 / 社媒 / 短链失败 / 其他） |
| 必须字段校验拒收数 + **缺失字段分布** |
| **Discovery success rate = 过闸门且必须字段齐备 ÷ 尝试数** |
| duplicates（对现有 pin_products 按 `parent_pin_id + external_product_url` 去重）/ existing rows / projected inserts |

**B. Detail 层（不影响产出，只用于后续优化）**

| 指标 |
|---|
| **Detail enrichment rate = `detail_fetch_status='available'` ÷ Discovery 成功数** |
| **`detail_fetch_status` 四态分布**：`available` / `blocked` / `not_found` / `not_attempted` |
| 可提取 product_name / product_image / price 各自数量（**均以 Discovery 成功数为分母**） |

**C. 按域名族的双指标交叉表（必出）**

| 域名族 | 行数 | Discovery success rate | Detail enrichment rate | 主要 blocked 原因 |
|---|---|---|---|---|
| Etsy | | 预期 ~100% | 预期 0% | WAF 403 |
| Shopify 独立站 | | | | |
| Amazon | | | | |
| 数字商品市场 | | | | |
| … | | | | |

> 🔴 报告中**禁止**出现只写一个数字的"XX 域名成功率"。任何域名的成绩必须是**两个数**。

**D. 声明**：明确写"本次未写库"（沿用 v1.1 T1）。

**E. 🔴 报告中不得出现 competition / saturation / opportunity score 任何口径**（v3.1 第 1 条）。

### 10.2 停止条件（修订）

| 条件 | 处置 |
|---|---|
| **Discovery success rate 异常低**（< 预期基线，说明闸门实现有 bug 或词源不对） | 停，先修 |
| **PDP 闸门误收率 > 10%**（人工抽查 20 条判定通过样本，首页/分类页混入即算误收） | 停，先修闸门（沿用 v1.1） |
| 外部**网络失败率**（timeout/5xx）> 30% | 停，先修（沿用 v1.1） |
| 触发目标站点限流（429） | 停 |
| **Detail enrichment rate 低** | ✅ **不是停止条件**（这是站点策略，不是我们的失败） |

> ⚠️ **403 不计入"网络失败率"**（沿用 T10 报告的方法学）：403 是站点 WAF 访问策略，归入 `detail_fetch_status='blocked'`，是**结果**不是**故障**。

### 10.3 T2 写后验证（修订）

按 §9.2 四红线 + §9.3 第五条断言 + STL 零回归 + 可整批回滚。**删除**旧的"商品图 / product_name / price 存在"检查。

### 10.4 `lifecycle_status` 语义 + T10 处置（**决策已定**）

| 值 | 何时 |
|---|---|
| `active` | 正常可见（`/api/products/top` 只返回 active） |
| `retired` | 商品下架/404（`detail_fetch_status='not_found'` 且复核确认）、来源 Pin 失效、或按 T10 整批退役 |

**T10 的 798 行历史脏数据 —— 决策人已定（回答 v3.0 §13 问题 2）：**

| 项 | 决策 |
|---|---|
| 处置方式 | ✅ **软退役**（`lifecycle_status='retired'`），**可逆，STL 零影响** |
| 硬删除 | 🔴 **需另行批准**。未获单独授权前，**不得执行 `DELETE`** |
| 前置 | 退役前须导出 798 行全量原始值到 evidence 文件（沿用 v1.1 T10 写入/回滚要求） |
| 后续 | 退役后撤除 `/api/products/top` 的 `created_at >= 2026-07-13T14:28:03Z` **临时下限**（该常量是技术债；撤除后重跑 T3 六项验证 + 确认 STL 零回归） |

---

## 11. 核心 KPI 改写

### 11.1 废弃

> ❌ **"商品详情完整率"不再作为主要成功指标。**
> 它衡量的是外部站点的反爬强度，不是我们的产品价值。

> ❌ **任何 marketplace evaluation 类 KPI**（竞争度覆盖、选品评分分布等）**不作为本产品的 KPI**（v3.1 第 1 条 / §0.4）。

### 11.2 新主 KPI

> ✅ **我们发现了多少条真实的、经 Pinterest 兴趣验证的商品机会。**

| 层级 | KPI | 定义 |
|---|---|---|
| **主 KPI** | **Verified Opportunities** | `lifecycle_status='active'` 且 3.A 必须字段齐备的行数 |
| 主 KPI 质量护栏 | **Opportunity 真实性** | §9.2 四红线 + §9.3 断言全过（假数据 = 0）；抽查商品链接可打开率 |
| 主 KPI 覆盖度 | **Discovery success rate** | 见 §5.3 |
| 主 KPI 深度 | **Verified Opportunities 的 saves 中位数 / P90** | 证明发现的是"Pinterest 用户真的在关注"的机会，不是长尾垃圾 |
| 覆盖广度 | 类目 / keyword 覆盖数 | P0 五类均有产出 |
| **增强 KPI（次要）** | **Detail enrichment rate** | **只用于指导优化方向（哪些站值得未来接官方 API），不作为产出成败判据** |

### 11.3 一句话对照

| | 旧 | 新 |
|---|---|---|
| 我们在优化什么 | 把商品抓全 / 给商品打分 | **发现更多真实机会** |
| Etsy 403 意味着 | 失败 | **一条 Discovery 成功、Detail blocked 的合法 Opportunity** |
| 抓不到详情怎么办 | 想办法凑 | **写 NULL，展示 "Product details unavailable" + "View source product"** |
| 竞争度怎么算 | 算 Competition badge | **不算。那不是我们的问题（§0.4）** |
| 什么算 0 分 | 详情不全 | **一行假数据 / 一个 marketplace evaluation 指标混进来** |

---

## 12. 与既有红线的关系（确认，不改）

| 来源 | 红线 | v3.1 下的状态 |
|---|---|---|
| v2.0 §6.1 | UI 不出现 Opportunity/Score/Fit/Best Bet 等标签 | ✅ 继续有效并**扩大**：追加 Competition / Product Rating / Product Related（§9.3） |
| v2.0 §6.2 | 算不出显示 "Not enough data" / 不显示编造值 | ✅ 继续有效并强化为 §4 三条永久禁止 |
| v2.0 §6.3 | 指标不跨页重复 | ✅ 继续有效（Keyword Trend 数值与曲线只在 Keyword 页；Product 页只出 badge + 解释句） |
| v1.1 §6.1 | 逐任务放行 | ✅ 继续有效（本文是 PRD，不是执行放行） |
| v1.1 §6.2 | STL 不否定、不停止、不修改 | ✅ 继续有效 |
| v1.1 §6.3 | 可按 discovery_method + 时间窗口整批回滚 | ✅ 继续有效（§9.2） |
| v1.1 §6.4 | 合规：linkback 必填、只读轻量请求、不扩图片缓存面 | ✅ 继续有效（§6：不为抓 Etsy 突破此条） |
| v1.1 §6.5 | 算不出显示 Not enough data，绝不编造 | ✅ 继续有效 |

---

## 13. 决策记录（v3.0 §13 开放问题 —— **已全部关闭**）

| # | 原开放问题 | **决策人裁定（2026-07-14）** | 落地 |
|---|---|---|---|
| 1 | Demand / Trend / **Competition** 三 badge 去留 | **Competition 删除**（marketplace evaluation，不属机会发现，且易把产品拉回商品评分工具）；**Demand → `Pinterest Interest`**；**Trend → `Keyword Trend`**；Card badge 定为 **Pinterest Interest / Keyword Trend / Source(Merchant)** | §7.1 / §7.6 |
| 2 | T10 798 行：软退役 vs 硬删除 | **软退役**（`lifecycle_status='retired'`）。**硬删除需另行批准** | §10.4 |
| 3 | blocked 行是否给用户可见技术提示 | **不区分**。UI 统一 **"Product details unavailable"**；**禁止** "Merchant blocks preview" 等技术措辞 | §6.3 / §7.3 |
| 4 | Etsy 官方 API 是否立项 | **MVP 不立项**，记为 **Future Enhancement**；且**仅用于 enrichment，绝不用于 discovery** | §6.4 |
| 5 | Commercial Signal 措辞是否统一 | **强制统一 `Product Linked` / `Content Only`**；**禁 `Product Related`**（"Related" 含推测）。**含 Pin Ideas 页** | §8 |
| 6 | 新增列的迁移编号与落地时机 | **技术侧代理处理。✅ v47 已应用**（`product_name` 放宽可空 + `detail_fetch_status` + `availability`）；**⏳ v48 进行中**（把 `detail_fetch_status` CHECK 约束改为四态 + partial unique index） | §3 注 / §6.3 / §9.2 ④ |

**本文无未决开放问题。**

---

## 14. 一页总结

| 问题 | v3.1 答案 |
|---|---|
| Product Opportunity 是什么？ | **Pinterest Opportunity Discovery Tool**。不是 Product Database，不是 Marketplace Intelligence Tool |
| 一行数据是什么？ | **一条经 Pinterest 验证的商品机会**（不是一个商品） |
| 核心资产是什么？ | **Pinterest evidence = source pin + saves + trend + external product link** |
| 商品详情是什么？ | **Optional enrichment only** |
| 什么算采集成功？ | **发现真实外链 + Pinterest 来源验证通过**（与详情无关） |
| 抓不到详情怎么办？ | **NULL + `detail_fetch_status`（内部四态）；UI 统一 "Product details unavailable"，照常展示，不隐藏** |
| Etsy 怎么办？ | **收，Discovery 100% / Detail 0%（blocked）**——不排除、不造假；官方 API = Future Enhancement，仅 enrichment |
| 卡片主图是什么？ | **Source Pin Image**（商品图是可选增强） |
| 卡片有哪三个 badge？ | **Pinterest Interest / Keyword Trend / Source(Merchant)** |
| Competition 呢？ | **🔴 删除。** 那是 marketplace evaluation，不是 Pinterest opportunity discovery |
| Commercial Signal？ | **`Product Linked` / `Content Only`**（全站统一，禁 `Product Related`） |
| 什么绝对不能做？ | **Pin 标题 → product_name；Pin 图 → product_image_url；猜任何商品字段；把 marketplace evaluation 指标塞回来** |
| 主 KPI 是什么？ | **Verified Opportunities：发现了多少条真实、有 Pinterest 兴趣验证的商品机会** |
</content>
</invoke>
