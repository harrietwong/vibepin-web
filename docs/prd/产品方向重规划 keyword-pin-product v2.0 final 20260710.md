# 产品方向 FINAL：Keyword Trend / Pin Ideas / Product Opportunity Finder

版本：v2.0 FINAL（2026-07-10）
状态：**最终方向，直接作为 PRD 与实施依据**。取代同目录 v1.0 重规划稿及《pin idea和product opportunity 的prd v1.0》中与本文冲突的条目。

---

## 0. 总体原则

**减少复杂指标，只保留用户容易理解、能直接帮助决策的字段。**

全产品禁用（UI 文案、字段名、标签、tooltip 一律不得出现）：
- Content Fit / Product Fit
- Opportunity / Opportunity Score / Strong Opportunity / Good Opportunity / Best Opportunity / Niche Opportunity 等一切机会类标签
- Why opportunity
- 其他用户难理解的内部评分或专业名词（黑箱综合分、内部置信度等）

> 说明：**"Product Opportunity Finder" 作为功能名保留**（导航/页面标题），禁的是指标层的 Opportunity 标签、评分与结论。

每个字段都必须能回答一个简单问题：
1. 这个关键词现在有没有趋势？（Keyword Trend）
2. 这张 Pin 为什么值得参考？（Pin Ideas）
3. 这个 Product 是否有真实需求和竞争空间？（Product Opportunity）

**指标分工（不跨页重复）**：
| 页面 | 主指标 |
|---|---|
| Keyword Trend | 关键词趋势、季节性、变化率 |
| Pin Ideas | Saves、内容形式、发布建议 |
| Product Opportunity | Demand、Trend、Competition、来源证据 |

---

## 1. Keyword Trend

**定位**：帮助用户判断一个关键词是否值得继续查看，并进入对应的 Pin Ideas 或 Product 页面。

### 1.1 字段清单

**保留 / 补齐**：
| 字段 | 现状 | 动作 |
|---|---|---|
| Keyword | 已有 | 保留 |
| Trend（含 sparkline，真实 trend_history） | 已有 | 保留 |
| Seasonality（Rising / Seasonal / Evergreen + peak months） | Trend State 部分已有 | 补 Seasonal 判定与 peak months（有数据才显示） |
| Weekly / Monthly / Yearly Change | 已有（trend_keywords 三列俱全） | 保留 |
| Related Keywords | 已有（related 表） | 保留 |
| **Pinterest Search Suggestions** | keyword_expansions 已落库、UI 未用 | 新增：在 related 区独立分组"Search suggestions"（真实下拉框词） |
| **Popular Pins 预览** | 无 | 新增：keyword 详情内按 seed_keyword 取 pin_samples top-saves 缩略图条，点击进 Pin Ideas |
| **View Pin Ideas** | 无（现有按钮是"Create Pin Ideas"生成流程） | 新增浏览跳转，带 `?keyword=` 参数 |
| **View Product Opportunities** | 无 | 新增浏览跳转，带 `?keyword=` 参数 |

**删除 / 降级**：
| 字段 | 现状 | 动作 |
|---|---|---|
| Competition（表格主列 + 筛选器） | 已有，口径=内容视觉密度 | **改名 `Content Saturation`，从主列和筛选器移除，降级为 keyword 详情面板内的辅助信息**（保留现有诚实 tooltip 口径） |
| Opportunity 列（Best Bet / Steady / Competitive） | 已有主列 | **整列删除**，相关筛选一并删除 |
| Content Fit / Product Fit | 无 | **不做**（v1.0 稿的 K5 取消） |

### 1.2 验收标准

- Given 用户搜索一个关键词，Then 能看到 Trend 曲线、周/月/年变化、季节性，以及 Related Keywords 与 Search Suggestions 两个分组。
- Given 任一 keyword 行/详情，Then 存在 View Pin Ideas 与 View Product Opportunities 两个入口，点击后下游页已按该 keyword 预筛并显示来源提示。
- Then 页面任何位置不出现 Competition 主列、Best Bet/Steady/Competitive、Opportunity 字样；Content Saturation 只出现在详情辅助区。

---

## 2. Pin Ideas

**定位**：内容参考和发布优化工具，**不做市场评分**。

### 2.1 Pin Card 字段

**保留 / 新增**：
| 字段 | 数据来源 | 说明 |
|---|---|---|
| Pin Image | 已有 | |
| Title | 已有 | 无标题显示 Search Keyword；**不编造** |
| Saves | save_count | 主指标 |
| Saves/day | save_velocity | 缺失显示 "—" |
| Freshness | pin_created_at / scraped_at | 发布/发现时间 |
| Trend Keyword | seed_keyword（DB 已有，UI 未接） | badge：Rising / Seasonal / Evergreen（来自 trend_keywords 变化率），点击→筛选 |
| Search Keyword | source_keyword（DB 已有，UI 未接） | chip，点击→筛选同下拉词 |
| Format | **DB visual_format**（弃用前端 inferPinFormat） | static / collage / tutorial 等 |
| Fast Saving | save_velocity 同 category 分位前 10% | 轻量标签，无数字评分 |
| **Commercial Signal** | 见 2.2 | 只有两个状态：`Product Related` / `Content Only` |
| Save | 已有 | 保留 |
| Use as Reference | 已有 | 保留 |

**删除（Phase 1 第一批）**：
- Demand badge（现实现 = saves 阈值伪装）
- Competition badge（现实现永远出不了 High，纯误导）
- Opportunity / Opportunity Score（从未该出现在此页）
- Pin Trend 数字评分（不做数值型趋势分）
- 虚构 Monthly Volume（Est. Monthly Vol = saves×12）
- 假 sparkline（SPARKLINE_PATHS 装饰线）
- 假 reactions（reactions 缺失时回退显示 saves → 改 "—"）
- 编造标题（demoTitleTemplate 作为 fallback → 改 Search Keyword / "Untitled pin"）
- Demand / Competition / Trend 三个伪指标筛选器；"product_signal→reaction_count" 错位排序

### 2.2 Commercial Signal（不评分，只显状态）

- **Product Related**：满足任一 —— Shop the Look 关联、Product Pin、Product Tag、Product Link、External Product URL。
  落地判定（现有数据）：`is_ecommerce = true`，或 `outbound_link` 命中电商域规则，或该 pin 是 `pin_products.parent_pin_id`（已被产品采集验证）。
- **Content Only**：以上皆无。
- Product Related 的卡片/详情提供 "View related products" 入口 → 跳 Product Opportunity（按 keyword/pin 预筛）。

### 2.3 Pin Detail 字段

保留：Discovered via（Trend Keyword → Search Keyword，均可点击筛选；rank 落库后追加 Rank N）、Trend Keyword、Search Keyword、Saves、Saves/day、Freshness、Format、Commercial Signal、**Why it works**（规则版：visual_format / text_overlay_level / image_ratio 2:3 / saves 分位 / 标题-关键词匹配 / 季节相关，每维一条，数据不足不输出）、**Optimization Suggestions**（规则版：标题、text overlay、比例、format 建议、发布 category/niche）、**Publishing Tips**（一句"适不适合现在发"的白话提示）、Pinterest Source（原 Pin 链接）。

不展示：Demand、Competition、Opportunity、Why opportunity、任何数值评分。

### 2.4 验收标准

- Given 任意 Pin Card，Then 可见 Saves、Saves/day、Freshness、Format、Trend Keyword、Search Keyword、Commercial Signal，且**不出现** Demand/Competition/Opportunity 字样与任何编造数值。
- Given 打开 Pin Detail，Then 可见 Discovered via 链路、Why it works、Optimization Suggestions、Publishing Tips、Pinterest Source。
- Given 一张无标题 Pin，Then 显示其 Search Keyword 或 "Untitled pin"，而不是模板编造标题。
- Given Commercial Signal = Product Related，Then 详情内有跳转 Product Opportunity 的入口。

---

## 3. Product Opportunity Finder

**定位**：帮助用户判断一个 Product 是否有真实需求、近期趋势和竞争空间。**不生成统一机会结论或综合评分，由用户根据三个指标自己判断。**

### 3.1 Product Card 字段

保留：Product Image、Product Name、Product Type（Physical/Digital）、Category、**Demand**、**Trend**、**Competition**、Saves（product-pin 优先 precedence，已实现）、**Source Type**（Product Pin / Shop the Look / Product link Pin，用户语言映射，不直出内部字段）、**Validating Source Count**（几个 source pin 验证）、Trend Keyword（seed_keyword，点击→筛选）、Save、Add to Product Picker。

**删除**：Opportunity / Opportunity Score / Best-Good-Niche-Watch-Crowded 等一切机会标签（现 `deriveOpportunityLabel` 的输出不得进入 UI，代码一并退役）；"Best Opportunity" 排序项改为 "Most saved"（默认）+ Rising + Low competition + Newest。

### 3.2 Product Detail 字段

保留：Product Image、Product Name、Product Type、Category、Demand、Trend、Competition、**Product Pin Saves 与 Source Pin Saves 分行**、Validating Source Count、Trend Keyword、Search Keyword（parent pin join pin_samples.source_keyword）、Source Type、**Product Pin URL 与 Source Pin URL 分开两行**（现合并为一个 "Pinterest Pin URL"，拆开，各带打开按钮）、External Product URL、Save Product、Add to Product Picker。

### 3.3 Demand / Trend / Competition 的简单解释（必须）

每个 badge 旁一句白话解释，模板：
- Demand High：该产品收藏表现处于同类前列（数据源：saves 同类分位，`deriveProductDemand` 已算 percentile）
- Demand Low / unknown：收藏表现低于同类 / 暂无足够收藏数据
- Trend Rising：相关关键词近期正在上升（keyword yearly_change）；Declining / Stable 同理
- Competition Low：当前识别到的相似产品较少（similar pin / product family 计数）；High：相似产品较多；unknown：**显示 "Not enough data"，不硬给结论**

### 3.4 验收标准

- Given 任意 Product Card，Then 可见 Demand/Trend/Competition 三个 badge + Saves + Source Type + Validating Source Count + Trend Keyword，且**全页 UI 不出现 Opportunity / Opportunity Score / Why opportunity 字样**。
- Given Product 来自 Shop the Look，When 打开 Detail，Then Product Pin URL 与 Source Pin URL 分行展示且都可打开，Product Pin Saves 与 Source Pin Saves 分行展示。
- Given 三个指标任一，Then 其旁有一句可读解释；数据不足时显示 Not enough data。
- Given 点击 Add to Product Picker，Then 该 Product 进入 Picker 候选清单。

---

## 4. 代码实施清单

### Phase 1（纯前端为主）

**P1-1 Pin Ideas 下线虚构指标** — `web/src/app/app/discover/page.tsx`
- 删 UI：Demand/Competition badge（卡片、抽屉、AnalysisRow）、三个伪指标筛选器、Est. Monthly Vol 卡、`Sparkline`/`SPARKLINE_PATHS`、`demoTitleTemplate` prod fallback、reactions←saves fallback、`product_signal` 排序
- 删依赖：`getDemandBand` / `getCompetitionBand` / `momentumToTrendKey` 的页面挂载；`lib/scoring.ts` 中 `assessPin`/`estMonthlyVol` 退出 Pin Ideas 路径，`MOCK_OPPORTUNITIES` 删除
- ~400 行 demo 代码（CaptureModal/DemoBanner/DemoAnalysisRow/MON_*/SAT_*）拆出独立文件

**P1-2 Pin Ideas 接真实字段** — 同文件
- `PIN_SELECT` 增补：`seed_keyword,source_keyword,trend_keyword_id,visual_format,is_ecommerce`
- 卡片/抽屉上：Search Keyword chip、Trend Keyword badge（join trend_keywords 变化率 → Rising/Seasonal/Evergreen）、Format 改用 `visual_format`、Fast Saving（velocity 同类分位前 10%）、Commercial Signal（§2.2 规则）
- 筛选器换为：Trend Keyword / Search Keyword / Format（DB 字段）/ Freshness（7/30/90 天）/ Commercial Signal

**P1-3 Product 页展示三指标** — `web/src/app/api/products/top/route.ts` + `app/products/page.tsx`
- route：每行挂 `publicMetrics`（`deriveProductOpportunityPublicMetrics` 已在排序中调用，去掉 `opportunityLabel` 字段后随行返回）
- 页面：ProductCard/ProductDrawer 渲染 Demand/Trend/Competition badge + §3.3 解释句 + Validating Source Count + Source Type

**P1-4 删除 Opportunity 体系** — `web/src/lib/productOpportunityCounts.ts`、route.ts、`ProductOpportunityPicker.tsx`
- 删 `OpportunityLabel` 类型、`deriveOpportunityLabel`、`opportunityRank` 排序（route 默认排序改 saves desc；Picker 内排序改 saves）
- 排序下拉：Most saved（默认）/ Rising / Low competition / Newest
- 全局验收：`grep -ri "opportunity" web/src/app/app/{discover,products}/ web/src/components/products/` 的 UI 字符串为 0（功能名 "Product Opportunity Finder" 页标题除外）

### Phase 2

**P2-1 Pin Detail 完整化** — Discovered via 区块 + 规则版 Why it works / Optimization Suggestions / Publishing Tips（`discover/page.tsx` 抽屉；建议同时新建 `/api/pin-ideas` 收敛 3 条取数路径并做 keyword join/分位计算）
**P2-2 Product provenance** — Detail 拆分 Product Pin URL / Source Pin URL 两行（`pinterestPinUrl` 拆开）+ Search Keyword（route join pin_samples）+ Source filter 扩展（All / Product Pin / Shop the Look / Product link Pin / Amazon / Etsy / Shopify / Other，替换现有 all|amazon）
**P2-3 Keyword Trend 跳转** — `trends/page.tsx`：View Pin Ideas / View Product Opportunities 双 CTA；Opportunity 列删除；Competition 主列/筛选移除 → 详情 Content Saturation；`mapTrendKeywordRow.ts` 删 `getOpportunityLabel`/`oppIndex`
**P2-4 keyword 参数联动** — 三页 URL 协议 `?keyword=<trend>&search_keyword=<suggestion>`，下游页读取→自动筛选→显示来源面包屑；Keyword 详情加 Popular Pins 预览条（pin_samples top saves by seed_keyword）

### Phase 3（需审批/数据积累）

- `keyword_expansions.rank` DDL（一行，SQL Editor 审批）→ Suggestion Rank 上 UI + Search suggestions 分组完善
- `pin_save_snapshots`（重爬记录 saves delta）→ 真实 7d/30d Saves/day、趋势历史
- Similar Pins / Similar Products（Detail 内，带口径说明与 Not enough data）
- 更完整的来源验证（source pin 列表、多 source 聚合展示）

---

## 5. 数据层现状与缺口（不变项沿用 v1.0 核实结论）

| 需求 | 现状 | 动作 |
|---|---|---|
| trend/search keyword → pin 链路 | pin_samples 三字段已落库 | 前端接入（零后端改动） |
| keyword 周/月/年变化 + trend_history | trend_keywords 已有 | 直接用 |
| 下拉词（Search Suggestions） | keyword_expansions 已落库未上 UI | Phase 2/3 接入；rank 列待 DDL |
| visual_format / text_overlay_level | 后端分类器已写入 | 前端改用，弃 inferPinFormat 双轨 |
| Commercial Signal 判定 | is_ecommerce + outbound_link + pin_products.parent_pin_id 均已有 | 规则拼装即可 |
| Pin 7d/30d 收藏速度 | 只有单点 save_count + 平均 velocity | P1 用分位近似（Fast Saving），Phase 3 建快照 |
| Product Demand/Trend/Competition | deriveProduct* 全部已实现（含 percentile、unknown 保护） | 渲染 + 解释句即可 |

---

## 6. 全局验收红线

1. 三页 UI 不出现：Opportunity、Opportunity Score、Why opportunity、Content Fit、Product Fit、Best Bet、Best/Good/Niche Opportunity、Crowded、Watch（作为标签）。
2. 任何指标可回答"数据从哪来、怎么算"；算不出显示 "Not enough data" / "—"，绝不显示编造值。
3. 同一套市场指标不跨页重复：Demand/Competition 只在 Product 页；Trend 数值与曲线只在 Keyword 页（Pin/Product 页仅 badge + 一句解释）。
