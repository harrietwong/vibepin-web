# 产品方向重规划：Keyword Trend / Pin Ideas / Product Opportunity

> ⚠️ **已废弃（SUPERSEDED）**：本稿已被《产品方向重规划 keyword-pin-product v2.0 final 20260710.md》取代。
> v2.0 主要修订：全局禁用 Opportunity/Opportunity Score/Why opportunity 及一切机会标签；取消 Content Fit / Product Fit（K5）；取消 Keyword 页 Opportunity 列（K4 改为整列删除）；Pin Ideas 新增 Commercial Signal（Product Related / Content Only）；Product 页只保留 Demand/Trend/Competition 三指标 + 白话解释，不做综合结论。

版本：v1.0（2026-07-10）
依据：《pin和product idea 调研 0710》（市场调研，权威优先级最高）+ 《pin idea和product opportunity 的prd v1.0 20260710》 + 2026-07-10 代码审查结论。
冲突裁决原则：**调研结论覆盖 PRD v1.0；PRD 未被推翻的部分继续有效。**

---

## 0. 一句话总纲

三个页面不是三个平行的"信息列表页"，而是**同一条用户链路上的三个决策页**，各自服务一个决策对象：

| 页面 | 决策对象 | 用户要做的决定 | 指标语言 |
|---|---|---|---|
| Keyword Trend（Keyword Tool） | 关键词 | 这个主题值不值得追？什么时候追？追哪条分支？ | demand / trend / seasonality / related terms |
| Pin Ideas | 内容样本 | 我该模仿什么？为什么它有效？怎么发得更好？ | saves / format / why-it-works / publishing value |
| Product Opportunity Finder | 产品机会 | 这个产品值不值得进？值不值得继续研究？ | demand / competition / trend / opportunity score |

**去重总原则：同一个指标在全产品里只有一个"主指标"位置，其余页面只保留"语境角色"。**

- Trend：Keyword Tool 的主指标 → Pin Ideas 里只是来源上下文 badge → Product Opportunity 里是机会组件之一
- Saves：Pin Ideas 的主指标 → Product Opportunity 里是"被收藏验证"的证据 → Keyword Tool 里只以 Popular Pins 预览出现
- Demand：Keyword Tool 里是搜索需求 → Product Opportunity 里是"搜索+收藏验证"的产品需求 → **Pin Ideas 里不再以 Demand 名义出现**
- Competition：只在 Product Opportunity 作为主指标 → Keyword Tool P0 不做（P1 可做"饱和度"） → **Pin Ideas 卡片永远不做**

---

## 1. 对 PRD v1.0 的裁决表（哪些条目被调研推翻）

| # | PRD v1.0 原要求 | 调研裁决 | 结果 |
|---|---|---|---|
| 1 | Pin Card 显示 Demand Badge（High/Medium/Low） | Demand 是关键词层属性，硬放到 Pin 卡片会让用户误读"这张图=高需求市场" | **推翻**。改为 Search-backed（来源关键词）+ Saves + Saves/day + Trend keyword badge |
| 2 | Pin Card 显示 Competition Badge | Pin 层 competition 语义站不住（个性化 feed、聚合统计、官方强调 relevance 而非拥挤度），现有实现也是伪计算 | **推翻**。卡片永不显示；Detail 里 P1 以 "Pattern saturation / Similar Pin density" 出现，附方法说明与 Not enough data |
| 3 | Pin Card 显示 Opportunity Label（Best Opportunity 等） | Opportunity score 是产品研究语言，不适合内容灵感卡 | **推翻**。机会评分只留在 Product 页 |
| 4 | Pin 的 Trend 拆 Keyword Trend + Pin Trend 双层数值 | Trend 本质属于 keyword 层；Pin 卡片只需轻量上下文 badge | **收窄**。卡片只显示 Rising keyword / Seasonal now / Evergreen；Pin 自身收藏加速度用 "Fast-saving" 标签表达，不做数值型 Pin Trend |
| 5 | Product 页 Source Filter（Product Pin / STL / product-like / Amazon / Etsy…） | 调研同样要求展示 provenance，与 PRD 一致 | **维持 PRD**，并推翻代码里"provenance 永不进 UI"的旧裁决 |
| 6 | Product Card/Detail 显示 Demand / Competition / Trend / Opportunity Score | 调研强化：这正是产品页该承载的（Jungle Scout / Helium 10 惯例），但**综合分必须可解释、组件必须可展开** | **维持并加强** |
| 7 | High Demand 定义（trend 热度+suggestion rank+结果内排名+category 前 20%） | 该定义整体迁移到 **Keyword 层与 Product 层**使用；Pin 层不再输出 High/Medium/Low Demand | **迁移** |
| 8 | Keyword 工具展示 Competition | P0 不做任何 competition；P1 若做，必须改名 Content/Product saturation 并公开算法 | **推翻（P0）**。注意：现有 /app/trends 已把 Competition 做成表格主列+筛选（tooltip 已诚实标注 "visual content density"）——处置见 §2.5 |

其余 PRD 条目（数据链路、来源关系保留、Physical/Digital tabs、Saved/Picker、状态页、验收标准中与上表不冲突的部分）继续有效。

---

## 2. Keyword Trend（Keyword Tool）——主题机会发现与分流

> Keyword Trend 是**现有功能**（`web/src/app/app/trends/page.tsx`，1668 行 + `lib/keyword-data/*`）。
> 现状已相当完整：trend_history 真实曲线、weekly/monthly/yearly change、Official/Estimated/Derived 数据源标注（"not search volume" 诚实命名已落实）、Interest/Save Signal 波段、Best Bet/Steady/Competitive 机会标签、related keywords 搜索表。
> 因此本节是**改造清单**，不是从零规划。

### 2.1 定位

全产品的**上游导航枢纽**。回答"有没有人搜、在不在涨、什么时候是窗口、该往内容走还是往产品走"，并把用户送进 Pin Ideas 或 Product Opportunity。它自己不展开单个 Pin 细节，也不放产品评分卡。

### 2.2 现状 vs 调研的差距（P0 改造项）

| # | 现状 | 调研要求 | 动作 |
|---|---|---|---|
| K1 | CTA 只有 "Create Pin Ideas"（直接跳生成流程） | 每个 keyword 必须有两个**浏览跳转**：View Pin Ideas / View Product Opportunities | 行尾/详情加双 CTA，带 `?keyword=` 参数落地下游页自动筛选；"Create Pin Ideas" 保留为第三动作 |
| K2 | related keywords 混在一张大表 | 按来源分组：Core / **Search dropdown suggestions**（keyword_expansions，我们已有的独特数据，目前完全未上 UI）/ Related & rising | 列表加"来源"分组或 Source 列；接入 keyword_expansions |
| K3 | **Competition 是表格主列 + 筛选器**（tooltip 已注明 "visual content density"） | P0 不放 competition；若保留必须叫 saturation 且降权 | 改名 **Content saturation**，从主列降级到详情面板/次要列，筛选器随之改名；不新增任何算法 |
| K4 | Opportunity 标签（Best Bet/Steady/Competitive）是主列 | Keyword 层可以有"值不值得追"结论，但语言应是主题分流而非产品评分 | 保留标签，把 subtitle 语义改为分流建议（"适合内容切入 / 适合产品研究"），与 K5 联动 |
| K5 | 无 Content fit / Product fit | 调研 P0：帮用户决定去哪个下游页 | 规则版：该 keyword 下 pin_samples 的电商外链密度 + digital-evidence 比例 → Content fit / Product fit / Hybrid 徽标 |
| K6 | Trend State 已有（rising 等） | Rising / Seasonal / Evergreen 三态 + peak months | 补 Seasonal 判定（notes.refreshCadence/季节词表）与 peak months（有数据才显示） |

**P0 保持不动的现状资产**：trend sparkline（真实 trend_history）、周/月/年变化、数据源标注体系、Interest/Save Signal、region 筛选。

### 2.3 P1

- Product saturation（若做，公开算法口径：top N 结果重复视觉模式数 / unique creators / shoppable 密度）
- Related trends 对比、跨市场对比、audience-specific trends

### 2.4 代码落点

- 页面：`web/src/app/app/trends/page.tsx`（K1–K6 全部在此 + `lib/keyword-data/mapTrendKeywordRow.ts` 的标签文案）
- 数据：`trend_keywords`（weekly/monthly/yearly change、trend_history 已有）+ `keyword_expansions`（下拉词已落库；**需补 rank 列**，DDL 待审批）
- 新增：keyword → 下游页的 URL 参数协议（`/app/discover?keyword=…`、`/app/products?keyword=…`）

### 2.5 Competition 列处置（需拍板）

现有 Competition 列不是伪数据（有口径、有诚实 tooltip），但按调研它站错了位置：keyword 层的"竞争"容易被读成市场竞争。两个选项：
- **A（推荐，与调研一致）**：改名 Content saturation + 降为次要信息，主列让位给 Content/Product fit
- B：维持现状不动，只改 tooltip 强化"内容密度≠市场竞争"
默认按 A 执行。

---

## 3. Pin Ideas ——内容灵感与发布决策

### 3.1 定位（重新立论）

**内容灵感 + 发布决策工具，不是市场机会评分工具。** 核心问题：这张图为什么值得参考？它来自哪个真实搜索语境？我能不能复刻一个更好的版本？

### 3.2 P0 卡片字段（替换现有伪指标）

**下线（本次重规划最重要的减法）**：
- ~~Demand Badge~~（现实现=saves 阈值伪装，删）
- ~~Competition Badge~~（现实现永远出不了 High，纯误导，删）
- ~~Est. Monthly Vol = saves×12~~（虚构指标，删）
- ~~假 sparkline、demo 模板标题 fallback、reactions←saves fallback~~（删/改"—"）

**上线**：
| 字段 | 来源 | 说明 |
|---|---|---|
| Pin 图 + 标题 | 已有 | 无标题显示 source keyword，不编造 |
| Saves | 已有 | 主指标 |
| Saves/day | save_velocity | 主指标；数据缺失显示 "—" |
| Freshness | pin_created_at/scraped_at | "最近值得参考"判断 |
| Source keyword chip | `source_keyword`（DB 已有，UI 未接） | 点击→筛选同 suggestion keyword |
| Trend keyword badge | `seed_keyword` + trend_keywords.pct_growth_yoy | Rising keyword / Seasonal now / Evergreen，轻量 badge |
| Format | **改用 DB `visual_format`**（弃用前端 inferPinFormat 重复推断） | staticcollage/tutorial/product-shot 等 |
| Fast-saving 标签 | save_velocity 在同 category 分位前 10% | 替代数值型 Pin Trend |
| Save / Use as Reference | 已有 | 保留 |

### 3.3 P0 Detail 抽屉

- 大图、标题、category/niche
- **Discovered via 区块**：Trend Keyword → Suggestion Keyword →（rank 落库后显示 Rank N）→ 实际搜索词，全部可点击筛选
- Saves、Saves/day、Freshness
- Source keyword 的 trend 上下文（badge + 跳 Keyword Tool 看完整曲线）
- **Why it works**（P0，规则版）：基于 visual_format、text_overlay_level、image_ratio（2:3）、saves 分位、标题-关键词匹配、季节相关。每维一条，数据不足的维度不输出
- **Optimization suggestions**（P0，规则版）：标题改法、是否加 text overlay、比例建议、format 建议（collage/tutorial/checklist）、该用哪个 category/niche 发布
- Publishing value 说明（一句话：为什么/为什么不值得现在发）
- Landing URL/domain、product tags（如有 → CTA 跳 Product Opportunity）
- 打开 Pinterest 原 Pin、Create Pin from this idea（保留现有）

**Detail 条件显示（P1）**：Pattern saturation / Similar Pin density——同 suggestion keyword 下相似 Pin 数、30 天新增、其中高表现条数；必须附 "Based on visually similar Pins in current search results, low confidence" 方法说明；样本不足显示 Not enough data。

### 3.4 筛选与排序（P0）

筛选：Category（已有）、Trend Keyword、Search Keyword（新增，选项从结果聚合）、Format（改用 DB 字段）、Freshness（7/30/90 天）、Saved only（已有）。
排序：Most saved / Fastest saving（saves/day）/ Newest found / （关键词上下文存在时）Search-backed relevance。
**删除**：Demand/Competition/Trend 三个伪指标筛选器、"product_signal→reaction_count" 错位排序。

### 3.5 代码落点

- `web/src/app/app/discover/page.tsx`：PIN_SELECT 补 `seed_keyword,source_keyword,trend_keyword_id,visual_format,text_overlay_level,image_ratio`；删 getDemandBand/getCompetitionBand/momentumToTrendKey 的 UI 挂载；~400 行 demo 代码拆出独立文件
- `web/src/lib/scoring.ts`：assessPin/estMonthlyVol/MOCK_OPPORTUNITIES 从 Pin Ideas 路径退役（Keyword/Product 层若复用 getMomentum 单独保留）
- 建议新建 `/api/pin-ideas` route：收敛现有 3 条取数路径（discover 直连 / reference-candidates / viral-pins），服务端做 keyword join + 分位计算

---

## 4. Product Opportunity Finder ——产品机会验证与评分

### 4.1 定位

**唯一承载 Demand / Competition / Trend / Opportunity Score 的页面。** 核心问题：这个产品是否已被 Pinterest 的搜索与收藏行为验证？证据链是什么？值不值得进入 Product Picker / 选品流程？

### 4.2 P0 卡片字段

现有 `deriveProductOpportunityPublicMetrics`（demand 分位 + competition 聚类 + trend + opportunityLabel）**已经算好但只用于排序——P0 第一件事就是把它渲染出来**：

| 字段 | 状态 |
|---|---|
| 产品图 / 标题 / Product type（Physical/Digital）/ Category | 已有 |
| Demand badge（high/medium/low，分位法） | 已算未渲染 → 渲染 |
| Trend badge（rising/stable/declining） | 已算未渲染 → 渲染 |
| Competition badge（low/medium/high/unknown） | 已算未渲染 → 渲染；unknown 显示 "Not enough data" 而不是硬给 |
| Opportunity label（Best/Good/Niche/Watch/Crowded） | 已算未渲染 → 渲染 |
| Validating saves（product-pin saves 优先，precedence 已实现） | 已有 |
| Saves/day | 需要收藏快照，P0 先不做数值、P1 补 |
| Source keyword | seed_keyword 已有 → 标注为 Trend Keyword 并可点击 |
| **Source type**（Product Pin / Shop the Look / Product link Pin / product-like） | discovery_method/section_type 已有 → 用户语言映射后上卡（推翻"provenance 不进 UI"旧裁决） |
| **Validating source count**（几个 source pin 验证） | product_metrics.productSourcePinCount 已算 → 渲染 |

### 4.3 P0 Detail 抽屉（"机会说明书"）

- Demand breakdown：saves 值 + 同类分位 + 来源（product pin 还是 source pin）
- Trend：当前状态 + 来源（keyword_trend / velocity）；历史曲线 P1
- Competition breakdown：similar pin count / product family count / 口径来源（internal_cluster 等），直接把 `competition.source` 翻译成人话
- **Opportunity Score 组件化展示**：不给黑箱总分；把 demand/competition/trend 三个组件并排 + 标签结论
- **Provenance 模块（P0 核心差异化）**：Product Pin URL 与 Source Pin URL 分开两行展示（现在合并成一个 "Pinterest Pin URL"，拆开）；source type；（P1）source pin 列表
- Product Pin saves 与 Source Pin saves 分行（已有）
- **Why this is an opportunity**：一句可解释理由（规则拼装：demand 分位 + competition 状态 + trend + validating sources）
- Related searches / related products（P1）
- Save Product / Add to Product Picker / Open Product Pin / Open Source Pin / Open External Product（前三已有，补 Open Source Pin）

### 4.4 筛选（P0）

- Product Type tabs（已有）、Category（已有）、Platform（已有）
- **Source filter**：All / Pinterest Product Pin / Shop the Look / Product link Pin / Amazon / Etsy / Shopify / Other（替换现有 all|amazon 二值）
- Trend Keyword 筛选（seed_keyword 聚合）
- 排序已支持 opportunity/most_saved/newest/rising/low_competition（route 已实现）→ UI 下拉补齐这几项

### 4.5 代码落点

- `web/src/app/api/products/top/route.ts`：per-row 挂 `publicMetrics`（函数已在调用，零额外查询）
- `web/src/app/app/products/page.tsx`：ProductCard/ProductDrawer 渲染 badges + provenance；SourceFilter 类型扩展
- `web/src/lib/productIdeas.ts`：暴露 discovery_method 的用户语言映射（内部字段仍不直出）

---

## 5. 跨页链路（P0）

```
Keyword Trend ──View Pin Ideas──▶ Pin Ideas（keyword 预筛）
      │                              │ product tags/外链存在
      └──View Product Opportunities──▶ Product Opportunity（keyword 预筛）
                                     ▲
Pin Ideas Detail ──"这张图挂了产品"────┘
```

- URL 参数协议：`?keyword=<trend_keyword>&search_keyword=<suggestion>`，两个下游页读取后自动设置筛选并显示来源面包屑
- Pin Ideas Detail 的 Trend keyword badge 反向跳 Keyword Trend 详情

---

## 6. 数据层支撑与缺口

| 需求 | 现状 | 动作 |
|---|---|---|
| trend keyword → pin 链路 | pin_samples.seed_keyword/source_keyword/trend_keyword_id 已落库 | 前端接入即可（零后端改动） |
| 下拉词 rank | keyword_expansions 未存顺序 | 加 `rank` 列（一行 DDL，走 SQL Editor 审批）；落库前 UI 不显示 rank |
| 下拉词上 Keyword 页 | keyword_expansions 已落库但 UI 未用 | K2：related 列表按来源分组接入 |
| Keyword 周/月/年变化 + 趋势曲线 | trend_keywords 的 weekly/monthly/yearly_change + trend_history **已有** | 直接用（此前误判为缺口） |
| Pin 收藏 7d/30d 速度 | 只有单点 save_count + 历史平均 velocity | P0 用 velocity 分位近似（Fast-saving 标签）；P1 建 pin_save_snapshots（重爬记 delta） |
| Product saves/day | 同上 | P1 |
| visual_format / text_overlay_level | 后端分类器已写入 pin_samples | 前端改用 DB 字段，弃用 inferPinFormat 双轨 |
| Content fit / Product fit | 可由现有字段规则计算（outbound 电商密度 + digital evidence） | P0 规则版 |

---

## 7. 实施路线图

**Phase 1（纯前端，最快见效，先做减法再做加法）**
1. Product 页：渲染已算好的 Demand/Trend/Competition/Opportunity badges + validating source count（route 挂 publicMetrics）
2. Pin Ideas：下线四个伪指标（Demand/Competition badge、Est. Monthly Vol、假 sparkline/标题/reactions fallback）
3. Pin Ideas：接入 source_keyword/seed_keyword/visual_format，上 Source keyword chip + Trend keyword badge + Format（DB 字段）

**Phase 2（前端 + 轻后端）**
4. Product 页：Source filter 扩展 + Detail provenance 模块（Product Pin / Source Pin URL 拆分）+ Why-this-is-an-opportunity
5. Pin Ideas Detail：Discovered via 区块 + 规则版 Why it works / Optimization suggestions / Publishing value
6. Keyword Trend：双浏览 CTA + URL 参数协议（K1）、Competition→Content saturation 改名降级（K3）、Trend State 补 Seasonal（K6）
7. `/api/pin-ideas` 收敛取数路径

**Phase 3（需审批/数据积累）**
8. keyword_expansions.rank DDL → Suggestion Rank 上 UI；下拉词分组接入 Keyword 页（K2）+ Content/Product fit（K5）
9. P1 项：pin_save_snapshots、pattern saturation（Pin Detail、带方法说明）、Product saturation（Keyword P1）、related products/searches、Saved 状态与 notes 落库

**每阶段验收红线（数据诚实）**：任何指标必须能回答"数据从哪来、怎么算的"；算不出来就显示 Not enough data / "—"，绝不显示编造值。

---

## 8. 度量本次重规划是否成功

- Pin Ideas：卡片点击→Use as Reference/Create Pin 转化率上升；用户不再看到任何虚构指标（0 个 fabricated fields）
- Product Opportunity：卡片→Save/Picker 转化率上升；带 provenance 的 Detail 打开时长
- Keyword Trend：View Pin Ideas / View Product Opportunities 两个 CTA 的点击占比（验证"上游枢纽"定位）
