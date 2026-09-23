# VibePin Product Opportunities PRD v3.6

## 1. 产品目标

VibePin Product Opportunities 是一个面向电商卖家的 **Pinterest 产品机会发现与持续追踪工具**。

它要帮助用户完成的不是“找到一个 Pinterest 上收藏很多的商品”，而是完整回答：

1. **这个产品现在值得研究吗？**
2. **近期 Demand 强不强？**
3. **需求还在 Rising，还是已经 Stable / Cooling？**
4. **Pinterest 上的原始证据是什么？**
5. **实际销售的商品是什么？**
6. **如果我感兴趣，能不能持续观察它的变化？**

市场调研显示，真正强烈的客户需求是产品发现、趋势判断、降低错误选品成本和持续验证，而不是单独购买一个 Pinterest Save History 工具。完整的“Discovery + Evidence + Product + Monitoring”比 Save Tracking 单独存在更有商业价值。

---

# 2. 核心用户

VibePin 第一阶段优先服务能够快速根据趋势行动的视觉型电商卖家。

主要包括：

1. Etsy Physical Sellers
2. POD Sellers
3. Etsy Digital Product Sellers
4. Pinterest-heavy Shopify / Small DTC Sellers

优先类目包括 Home Decor、Wedding、Gifts、Jewelry、Accessories、Fashion、Stationery、Printables、Digital Products、POD、Beauty 和其他视觉型 Lifestyle Products。

这类用户对趋势、饱和、产品发现的敏感度较高，而且 Pinterest 与他们的选品和视觉研究天然匹配。市场调研将 trend-sensitive Etsy/POD sellers 判断为当前最适合 VibePin 的 Primary ICP。

---

# 3. Product Opportunity 的业务生命周期

一个 Product 被 VibePin 发现以后，不能只作为一条静态商品数据保存。

每一个仍处于 Active 状态的 Product Opportunity，都应该进入持续观察状态。

完整生命周期：

**Discovered → Active Tracking → Demand / Trend → Saved / Watched → Continued Tracking → Inactive / Retired**

业务规则如下：

1. 新发现且符合 Product Opportunity 条件的商品进入 Active。
2. Active Product 持续观察其 Pinterest Saves 变化。
3. 持续观察产生历史数据，历史数据再产生 Demand、Trend 和 Timeline。
4. 用户主动 Save / Watch 的 Product 应始终被视为高价值候选。
5. 长期没有活动、证据失效或已经不再具有研究价值的 Product 可以转为 Inactive / Retired。
6. 并不是所有历史商品都要永久保持最高追踪优先级。

市场调研认为 Continuous Tracking 对 Active 和 Watchlisted Product 有明显价值，但没有必要永久追踪整个历史数据库。

---

# 4. Product 与 Pinterest Evidence 的关系

每个 Product Opportunity 必须有一个明确的 **Primary Pinterest Evidence Pin**，用于计算当前 Product 的 Demand、Trend 和历史曲线。

优先规则：

1. 如果存在直接对应真实商品的 Product Pin，则优先使用 Product Pin。
2. 如果没有 Product Pin，则使用当前最可靠的 Source Pin。
3. 其他相关 Pins 可以作为 Additional Evidence 展示，但 MVP 不直接把多个 Pin 的 Saves 相加。

原因是同一个商品可能拥有很多不同 Pinterest Pins。如果简单：

`Pin A Saves + Pin B Saves + Pin C Saves`

产品会因为“发布 Pin 数量更多”而获得天然优势，导致 Demand 含义失真。

因此 MVP 的核心指标都基于一个清晰、可审计的 Primary Evidence Pin。

未来如果 VibePin 拥有可靠的多 Pin 聚合方法，再单独设计 Product-level multi-Pin Demand。

---

# 5. Total Saves

Total Saves 表示当前 Primary Pinterest Evidence Pin 的**历史累计 Pinterest Saves**。

例如：

**18.4K total saves**

Total Saves 用于告诉用户：

> 这个 Product Opportunity 已经积累了多大的 Pinterest 社会兴趣。

但 Total Saves 不等于当前 Demand。

一个 Product 可以拥有 100K lifetime Saves，但最近一个月几乎没有增长，因此不能因为 lifetime 很高就被标记为 High Demand。

---

# 6. Demand 的定义

前台继续使用：

**HIGH DEMAND**

High Demand 是面向电商用户的产品语言。

它的业务定义是：

> **这个 Product 最近正在获得较强的 Pinterest 保存需求。**

它是 Pinterest-based demand signal，不等于经过验证的 Marketplace Sales，也不代表实际成交量。

市场研究显示 Pinterest Saves 是有意义的兴趣和 planning-intent evidence，但不能直接等价于订单或销售额。

---

# 7. Demand 的核心公式

Demand 使用：

## Rolling 30-Day Saves Gained

定义：

```text
G30 = S(today) - S(~30 days ago)
```

其中：

`S(today)` = 今天的累计 Pinterest Saves

`S(~30 days ago)` = 大约 30 天前的真实累计 Pinterest Saves

例如：

```text
30 days ago: 17,100 Saves
Today:        18,400 Saves

G30 = +1,300 Saves
```

用户展示：

**+1.3K saves · 30d**

市场调研同样建议使用 Rolling 30 Days 作为当前 Demand 的主要时间窗口。

---

# 8. High Demand 的判定规则

MVP **不使用“同类产品 Top 20% / Top 25%”作为 High Demand 的必要条件。**

原因是当前 VibePin 不同类目的 Product 数量和历史覆盖还比较有限，如果进一步要求“相同 Product Type + 相同 Category + 有 30 天历史”，实际用于比较的商品数量会过小，最后形成的是 VibePin 自己的小样本互相排名，而不是可靠的 Demand 判断。

因此 MVP 使用：

## Absolute Demand Threshold

定义：

```text
High Demand =
拥有足够有效的 30d 历史
AND
G30 >= T30
```

其中：

`T30` = VibePin 的 High Demand 绝对 30d Saves 门槛。

例如未来通过真实数据校准后，可能发现某个水平以上的 30d Saves Growth 才足以称为 High Demand。

但具体 `T30` 数字现在不人为写死。

规则是：

1. 先持续积累真实 30d Product history。
2. 查看整个 Product Opportunities 数据库真实的 G30 分布。
3. 根据真实分布确定一个具有业务意义的 `T30`。
4. 一旦确定，High Demand 使用相对稳定的业务门槛。
5. 该门槛可以周期性重新校准，但不能随着当前搜索结果、当前页面或当前 Category 每天变化。

这样：

**High Demand = 产品自身近期获得了足够强的真实 Save Growth。**

而不是：

**High Demand = 因为它刚好在 VibePin 当前抓到的十几个同类商品中排名比较高。**

---

# 9. Category Benchmarking 的定位

Category comparison 不删除，但从 High Demand 的**判定条件**调整为未来的**Context**。

未来当数据量足够大时，可以告诉用户：

> Strong for Jewelry

> Above typical Home Decor activity

或者在 Detail 中提供 category benchmark。

但 MVP 中：

**Category Benchmark 不决定 Product 有没有资格成为 High Demand。**

High Demand 首先由真实的绝对近期 Demand 决定。

---

# 10. Trend 的定义

Trend 与 Demand 是两个不同概念。

Demand 回答：

> **现在需求强不强？**

Trend 回答：

> **需求正在加速、稳定还是降温？**

Trend 使用两个连续的 7 天周期。

定义：

```text
Current G7
= S(today) - S(7 days ago)
```

```text
Previous G7
= S(7 days ago) - S(14 days ago)
```

然后比较：

```text
Current G7 vs Previous G7
```

市场调研支持使用最近 7 天与前 7 天比较，因为这样可以比 30d vs previous 30d 更快发现趋势拐点。

---

# 11. Rising / Stable / Cooling

Trend 有三个用户状态：

## Rising

当：

```text
Current G7 明显高于 Previous G7
```

显示：

**RISING**

含义：

> 最近一个星期 Pinterest Saves 增长速度正在明显变快。

---

## Stable

当：

```text
Current G7 与 Previous G7 变化处于正常波动范围
```

显示：

**STABLE**

含义：

> 最近的 Pinterest Save Demand 保持相对稳定。

---

## Cooling

当：

```text
Current G7 明显低于 Previous G7
```

显示：

**COOLING**

含义：

> 产品仍然可能有需求，但是最近新增 Saves 的速度正在下降。

---

# 12. Trend 的有效活动门槛

不能只使用百分比变化判断 Trend。

例如：

```text
Previous G7 = 1
Current G7 = 3
```

虽然数学上增长了 200%，但不能因此显示：

**RISING**

因此 Trend 必须先经过有效活动判断。

业务逻辑：

```text
历史是否足够？
↓
最近 14 天是否有足够真实 Save Activity？
↓
如果有，再比较 Current G7 与 Previous G7
↓
Rising / Stable / Cooling
```

如果历史或活动量不足：

内部状态：

**Insufficient Signal**

Card 上不显示 Trend badge。

市场调研同样明确指出，低量噪声不能因为百分比变化巨大就自动被判断为 Rising/Cooling。

具体最低 Activity Gate 和 Rising/Cooling 的百分比边界，应根据 VibePin 实际历史分布校准，而不是当前 PRD 人为制造一个行业标准。

---

# 13. Demand 和 Trend 可以组合

允许：

### HIGH DEMAND · RISING

当前需求强，而且增长还在加速。

### HIGH DEMAND · STABLE

当前需求强，近期增长速度保持稳定。

### HIGH DEMAND · COOLING

过去 30 天的需求仍然强，但最近 7 天的增长速度已经下降。

例如：

```text
G30 = +4,800 Saves
→ High Demand

Previous G7 = +1,000
Current G7  = +600
→ Cooling
```

最终：

**HIGH DEMAND · COOLING**

这是非常重要的选品状态。

它帮助用户区分：

> “热门而且还在继续爆发”

和：

> “现在仍然很热门，但可能已经开始过峰。”

---

# 14. 历史数据必须从现在开始持续积累

Demand、Trend 和 Timeline 都依赖连续历史。

所以：

> **Product 入库以后，只要仍然是 Active Product Opportunity，就必须持续观察 Pinterest Saves。**

没有持续 observation，就没有真实 Trend。

历史数据积累本身属于 P0，不能因为 Timeline UI 暂时不做就暂停数据积累。

原因很简单：

> 今天没有记录的数据，以后无法真实补回来。

---

# 15. 已有历史数据怎么处理

VibePin 已经存在部分 Pinterest Save 历史，因此不能全部重新从 Day 0 开始。

每个 Product 根据 Primary Evidence Pin 的真实历史独立判断。

## 状态 A：已有约 30 天或以上有效历史

可以直接计算：

- G30
- High Demand
- Trend
- Timeline

无需等待 Product 再入库 30 天。

---

## 状态 B：已有约 14–29 天历史

可以计算：

- Current G7
- Previous G7
- Rising / Stable / Cooling

但暂时没有完整 G30，就不显示正式 High Demand。

---

## 状态 C：已有约 7–13 天历史

可以计算：

**7d Saves Gained**

但还不能判断 Rising / Stable / Cooling。

---

## 状态 D：不足约 7 天

只展示：

**Total Saves**

继续积累历史。

---

# 16. 缺数据的产品展示原则

最高优先级规则：

> **没有数据，就少展示，不制造判断。**

例如：

**Vitamin C Serum**

`Amazon · Beauty`

`18.4K total saves`

这就是完全合法的 Product Card。

不应该出现：

- Trend: no data
- Demand: no data
- Declining
- Low Demand
- Fake 30d Saves
- Fake Rising
- Fake Stable

用户不需要知道 VibePin 后台哪个字段缺失。

---

# 17. 历史异常的处理原则

Pinterest 的累计 Saves 如果偶尔出现下降：

```text
Yesterday: 18,500
Today:     17,900
```

不能立即解释成：

`-600 demand`

也不能因此直接判断：

**Cooling**

业务上应把这种情况视作潜在：

- Pinterest metric correction
- Pin data revision
- 数据异常

原始 observation 保留，但异常负变化不能直接成为 Demand/Trend 判断依据。

市场调研也指出 Pinterest 的实时 metrics 可能在之后发生修订，因此 counter regression 需要防御性处理。

---

# 18. Product Opportunities 页面

页面标题：

**Product Opportunities**

副标题：

**Find products getting strong Pinterest save activity.**

用户首先选择：

**Physical | Digital**

然后提供：

1. Search
2. Category
3. Platform
4. Demand
5. Trend
6. Sort

默认：

**Most Saved**

当真实 Trend 数据覆盖成熟后，可以增加：

**Fastest Growing**

Demand / Trend Filter 只有在足够多 Product 拥有真实数据以后才开放。

---

# 19. Product Card

Product Card 的业务目标是：

> **让用户在两秒左右决定这个商品是否值得继续研究。**

Card 信息顺序：

### 1. Product Image

真实 Product Image。

### 2. Product Name

真实商品名称。

### 3. Platform · Category

例如：

**Etsy · Jewelry**

### 4. Demand / Trend

例如：

**HIGH DEMAND · RISING**

### 5. Recent Demand

例如：

**+1.3K saves · 30d**

### 6. Historical Context

例如：

**18.4K total saves**

### 7. Actions

- Save / Watch
- Add to Product Picker
- Pinterest ↗
- View Product ↗

Product Card 不承担复杂分析。

---

# 20. Pinterest ↗

每个拥有 Pinterest Evidence 的 Product 提供：

**Pinterest ↗**

它解决：

> **为什么 VibePin 认为这个产品值得看？**

点击以后，用户可以直接查看原始 Pinterest Pin，亲自验证：

- Pin 内容
- Saves
- Creative
- Pinterest Context

这让 VibePin 的判断可以被用户审计，而不是要求用户相信一个黑箱评分。

---

# 21. View Product ↗

每个拥有真实 external product URL 的 Product 提供：

**View Product ↗**

可能跳转到：

- Etsy
- Amazon
- Shopify
- Independent Store
- Gumroad
- Payhip
- 其他真实商品页面

它解决：

> **实际卖的到底是什么？**

用户可以继续研究：

- Price
- Product positioning
- Merchant
- Reviews，如果平台提供
- Product variants
- Merchandising
- Competitor positioning

市场调研认为“Pinterest Evidence + Real Product Page”是 VibePin 当前最强的差异化之一。

---

# 22. Save / Watch

Save 的业务含义不是简单收藏。

它表示：

> **这个 Product 已经进入用户的候选清单，我希望 VibePin继续帮我观察。**

规则：

1. 用户 Save Product 后进入 Watchlist。
2. Watchlisted Product 是后续 Tracking 的高优先级对象。
3. 用户回来以后可以看到 Demand / Trend 是否发生变化。
4. Watchlist 是未来 Alerts 的基础。

最终留存循环：

**Discover → Save / Watch → Continue Tracking → State Change → Return → Decision**

市场调研认为这条循环比“搜索数据库然后导出离开”更具有持续订阅价值。

---

# 23. Product Detail Modal

点击 Product Card 主体打开：

**Product Detail Modal**

不使用右侧 Drawer。

Modal 需要帮助用户完成第二阶段的深入判断。

主要包含：

### Product

商品图片、名称、Platform、Category、Product Type。

### Demand

有真实 30d 数据时展示：

- High Demand
- 30d Saves Gained

### Trend

有真实 ≥14d history 时展示：

- Rising / Stable / Cooling
- Current 7d
- Previous 7d

### Pinterest Evidence

展示 Primary Evidence Pin，以及其他有效的 Source / Validating Pins。

### Product Source

提供真实 external Product Page。

### Actions

- Save / Watch
- Pinterest
- View Product
- Product Picker

---

# 24. Timeline

历史数据：

**现在开始积累。**

Timeline UI：

**P1 实现，不阻塞 Product Opportunities MVP 上线。**

第一版：

## Pinterest Save Activity · 30D

推荐展示：

**Daily Saves Gained**

例如：

```text
Aug 21 +82
Aug 22 +115
Aug 23 +96
Aug 24 +171
Aug 25 +210
```

或者：

**7-Day Rolling Save Velocity**

Timeline 的主要目标是让用户看到：

1. 持续增长
2. 突然爆发
3. 增速变慢
4. 开始 Cooling
5. 是否已经过峰

不要把 Lifetime Cumulative Saves 作为唯一主曲线，因为累计值通常只会上升，很难直接看出趋势转折。

市场调研同样建议 Timeline 第一版使用 Daily Saves Gained 或 Rolling Save Velocity，并将 Timeline 定位为 P1，而不是 Discovery Card 的核心。

---

# 25. Alerts

Alerts 属于 P1。

当 Tracking 已经稳定、Trend 误报率足够低以后，可以产生：

- **Saved product started Rising**
- **Product became High Demand**
- **High Demand product started Cooling**
- **Watched product materially accelerated**

Alerts 的核心价值是：

> 用户不需要每天自己回来检查几十个 Product。

---

# 26. Sales Estimate

Sales Estimate 是值得研究的下一层 Product Validation，但不属于当前 P0。

未来 Product Detail 可以形成三层证据：

## 第一层：Pinterest Demand

例如：

**HIGH DEMAND**

**+1.3K saves · 30d**

## 第二层：Pinterest Trend

例如：

**RISING**

## 第三层：Commerce Validation

未来如果拥有可信并允许商业使用的数据来源，可以展示：

**Estimated Monthly Sales**

**Estimated Monthly Revenue**

必须明确写：

**Estimated**

不能让用户误认为这是 Etsy / Shopify 后台真实订单数据。

Sales Estimate 的作用是增强 VibePin 的选品判断，而不是替换 Pinterest Demand。

---

# 27. Sales Estimate 的产品原则

未来如果引入 Sales Estimate，必须满足：

1. 明确知道数据来自哪里。
2. 明确告诉用户它是 Estimate 还是真实公开数据。
3. 不能根据 Pinterest Saves 直接粗暴转换成 Sales。
4. 如果来自第三方 Provider，必须确认可以用于商业产品。
5. 如果 Estimate 质量不足，则宁可不展示。

VibePin 不应该因为竞品展示 Revenue，就制造一个无法解释的销售数字。

---

# 28. Competition 与 Opportunity Score

当前不进入 Product Opportunities 核心业务。

Pinterest Save history 可以支持：

- Demand
- Momentum

但暂时无法可靠支持：

- Marketplace Competition
- Seller Saturation
- Actual Sales Competition

同样，没有必要把多个不确定信号合成：

**Opportunity Score 87/100**

市场调研显示，用户会质疑第三方黑箱估算，因此 VibePin 当前更应该依赖**真实 Evidence + 简单可解释指标 + 原始链接**。

---

# 29. Pin Ideas

Pin Ideas 与 Product Opportunities 明确分工。

Pin Ideas 回答：

> **什么 Pinterest 内容值得参考？**

每张 Pin Card 展示：

1. Image
2. Pinterest Saves
3. Title
4. Keyword
5. Recency
6. Save

Pin Ideas 不展示 Product Demand、Trend、Competition、Opportunity Score 或内部图片分类标签。

---

# 30. MVP 用户完整流程

用户进入 Product Opportunities 后应该能够完成：

### 1. Discover

发现新的 Product Opportunities。

### 2. Scan

通过：

**Product + High Demand + Trend + Saves**

快速筛选。

### 3. Verify

点击：

**Pinterest ↗**

查看真实 Pinterest Evidence。

### 4. Research

点击：

**View Product ↗**

研究真实商品。

### 5. Investigate

打开 Product Detail Modal 查看更多 Demand / Trend Evidence。

### 6. Save

把真正有兴趣的商品加入 Watchlist。

### 7. Return

以后回来查看这个机会有没有：

**Rising → Stable → Cooling**

或：

**普通 → High Demand**

这才构成 VibePin 的完整选品闭环。

---

# 31. P0

当前 Product Opportunities 应优先完成：

1. Product Discovery
2. Product Card
3. Search / Physical / Digital / Category / Platform
4. Total Saves
5. Continuous Product Tracking
6. 30d Saves Gained
7. High Demand
8. Rising / Stable / Cooling
9. Missing-data rules
10. Pinterest Evidence
11. View Product
12. Product Detail Modal
13. Save / Watch

其中 Demand / Trend 只有在相应 Product 的历史成熟以后自动出现，不要求为了页面完整而造数据。

---

# 32. P1

完成核心闭环并开始观察真实用户行为后，再做：

1. 30D Save Activity Timeline
2. Alerts
3. Product Picker enhancements
4. More validating Pins
5. Emerging Products
6. Sales Estimate / Revenue Estimate feasibility
7. 更成熟的 Watchlist
8. Category benchmarking

---

# 33. 产品成功标准

上线以后真正要验证的不是“页面有没有数据”，而是：

1. 用户是否反复进入 Product Opportunities。
2. 用户是否会点击 Pinterest Evidence。
3. 用户是否会点击 View Product。
4. 用户是否 Save / Watch 候选商品。
5. 用户是否回来查看已保存 Product 的变化。
6. Rising / Cooling 是否会真正改变选品判断。
7. 用户是否愿意为了持续获得新 Product Opportunities 和持续 Tracking 而保持订阅。

市场调研认为最可能让用户付费的不是 Save counter、单独 Timeline 或 AI Score，而是：

> **High-quality Product Opportunity discovery + inspectable Pinterest evidence + real product page + monitored trajectory.**

---

# 34. 最终业务定义

VibePin Product Opportunities 的核心产品逻辑是：

> **从 Pinterest 发现真实产品，用过去 30 天新增 Saves 判断 Demand，用最近 7 天与前 7 天的变化判断 Trend，让用户查看原始 Pinterest Evidence 和真实商品，并持续观察自己真正关心的 Product Opportunities。**

最终每个 Product 必须帮助用户回答五个问题：

### 1. 这个产品现在值得看吗？

**High Demand / 30d Saves**

### 2. 它还在上涨吗？

**Rising / Stable / Cooling**

### 3. 为什么 VibePin 这么判断？

**Pinterest ↗**

### 4. 实际商品是什么？

**View Product ↗**

### 5. 我想继续观察怎么办？

**Save / Watch**

这五个问题构成 Product Opportunities 的核心业务闭环。