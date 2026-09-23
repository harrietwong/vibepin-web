# VibePin — Category Workspace IA & Daily Habit OS
**设计文档 v1.0 · 2026-05-26**

---

## 核心设计原则 Summary

VibePin 的留存风险不是内容不够，是用户不知道"今天要做什么"就关掉了。

设计的根本反模式是把 Discover/Trends/Products 三个页面做成三条信息流，用户每天随机逛，不知道结束点在哪。正确路径是：**把 VibePin 做成 Pinterest 版的 Bloomberg Terminal，不是 Pinterest 版的 BuzzFeed。**

核心设计原则三条：

**1. 任务完成 > 内容消费。** 用户的心智模型是「我今天选了 3 个机会，对应做了动作，关掉」，而不是「我刷了 40 条」。完成感是日常习惯的触发器，无限滚动是习惯杀手。

**2. Intelligence-first，不是 content-first。** 每条机会的价值不是"看到了什么"，而是"系统告诉我这个机会为什么值得跑"。评分层级（blue_ocean/early_trend）、爆款 Pin 样本、变现路径——这三件事必须在一张卡里同时呈现，让用户不用跳页就能决策。

**3. Category Workspace 是护城河，Top 10 是漏斗。** Top 10 负责引流和 FOMO，Category Workspace 负责让用户每天回来把工作做完。两者的关系是「入场券」vs「专业工作台」，前者免费，后者付费。

---

## A. Category Workspace 默认首页结构

### 设计原则：进来就知道"今天干什么"

用户点击进入 `Home Decor` Category Workspace，第一屏必须同时回答三个问题：
- 今天有几个新机会？
- 我的 daily task 完成了几个？
- 有没有我在关注的词出现了动静？

---

### 第一屏布局（从上到下）

**[区块 0] Category Header Bar** *(固定顶部，始终可见)*

```
[ 🏠 Home Decor ]  [ Fashion ]  [ Wedding ]  [ + Add Category ]
                                                    ↑ 付费解锁多 Category
```

- 展示字段：当前 Category 名称、Tab 切换、最后数据更新时间（`Data as of 2h ago`）
- 用户动作：切换 Category Tab / 设置 Category 偏好
- 区块目的：让用户有「这是我的专属工作台」的归属感，不是一个全局榜单

---

**[区块 1] Daily Status Bar** *(16px 高的状态条，第一眼看到)*

```
┌─────────────────────────────────────────────────────────────┐
│  Today's Session   ●●○  1/3 Picked   [2 new Blue Oceans]  [Finish Today →] │
└─────────────────────────────────────────────────────────────┘
```

- 展示字段：当日进度（0/3 → 1/3 → 2/3 → 3/3）、新机会数量 badge、完成按钮
- 用户动作：点击 `Finish Today` → 触发 Completion Loop 结算页
- 区块目的：**核心留存触点**。每天进来第一眼看到未完成状态，产生回来继续的冲动

---

**[区块 2] Today's Opportunities Feed** *(主体，占据 60-70% 视口)*

布局：列表式（非网格）。每张卡片信息密度比卡片网格高，更像「任务行」而非「图片展示」。

**单张 Opportunity 卡片结构：**

```
┌──────────────────────────────────────────────────────────────────┐
│ [BLUE OCEAN]  japandi living room                  Score 87  ↑+12 │
│ ─────────────────────────────────────────────────────────────── │
│ [Pin 缩略图1] [Pin 缩略图2] [Pin 缩略图3]  (3张，付费用户可点击大图) │
│                                                                  │
│ 💡 Monetize:  Home decor affiliate (Wayfair/Amazon) · Printable  │
│               wall art · Shopify dropship                        │
│                                                                  │
│ 📝 Title Templates:  (仅展示 1 条，付费展示 3 条)                 │
│   "10 Japandi Living Room Ideas That Feel Instantly Calm"        │
│   [See 2 more ↓]  ← 付费解锁                                    │
│                                                                  │
│ [View Pins]  [View Products ×8]  [+ Add to Plan]  [···]         │
└──────────────────────────────────────────────────────────────────┘
```

| 字段 | 免费可见 | 付费可见 |
|------|---------|---------|
| 机会词 + 评级 tier | ✅ | ✅ |
| Score 数值 | 显示范围区间（70-90） | 精确数值 87 |
| Score 变化趋势 ↑+12 | ❌ | ✅ |
| Pin 缩略图数量 | 1 张（点击不放大） | 3 张（可点击进 Trends 页） |
| Monetize hint | ✅ 文字 | ✅ + 产品域名/价格 |
| Title Templates | 1 条 | 3 条 |
| View Products | 显示有无（「×8 products」）| 可点进 Products 页过滤 |
| Add to Plan | ✅（限 5 条） | ✅（无限） |
| 机会数量上限 | 3 条/天 | 10 条/天 |

- 用户动作：
  - `[View Pins]` → 侧边抽屉展开 3-6 张高收藏 Pin 大图（Trends 页数据）
  - `[View Products]` → 侧边抽屉展开关联商品列表（Products 页数据）
  - `[+ Add to Plan]` → 加入本周计划，更新 Daily Status Bar 进度
  - `[···]` → 更多：Mark as seen / Add to Watchlist / Hide
- 区块目的：**信息整合，一站决策**。用户不需要跳页，在一张卡里完成「看样本 → 理解变现 → 选标题 → 加入计划」的完整决策

---

**[区块 3] Watchlist Alerts** *(折叠区，有触发时展开)*

```
┌─ 🔔 Alerts (2 new) ──────────────────────────────────────────┐
│  ↑ "small space bedroom" early_trend → blue_ocean  [View]   │
│  📦 8 new shoppable products in "cottagecore decor"  [View]  │
└──────────────────────────────────────────────────────────────┘
```

- 展示字段：触发类型图标、关键词名、变化描述、时间戳
- 用户动作：`[View]` → 直接打开对应机会详情
- 区块目的：**FOMO 触发**。让用户知道他们「关注的词有动静」，强化每天必须回来看的理由

---

**[区块 4] This Week's Plan** *(折叠，默认展示 3 行)*

```
┌─ 📋 Your Plan · This Week (5 items) ─────────────────────────┐
│  Mon  japandi living room      [Generate Pin]  [Scheduled]   │
│  Tue  wedding nails 2026       [Generate Pin]  [Pending]     │
│  Wed  diy wall art ideas       [Generate Pin]  [Draft]       │
│  [View All Plan →]                                           │
└─────────────────────────────────────────────────────────────┘
```

- 展示字段：星期、关键词、状态（Scheduled/Pending/Draft/Published）、快捷操作
- 用户动作：`[Generate Pin]` → 跳转 Studio，带入关键词 context；`[View All Plan]` → 展开完整计划视图
- 区块目的：**连接情报与生产**。把「发现机会」和「生成内容」连在同一个工作台里，而不是两个孤立页面

---

**[区块 5] Category Trend Pulse** *(底部，小尺寸折叠图)*

```
┌─ 📈 Home Decor · 30-day Momentum ────────────────────────────┐
│  [迷你折线图：过去 30 天该 Category 的 YoY 增长趋势均值]          │
│  Category avg YoY: +148%   vs last week: ▲+12%              │
│  Top rising subcategory: Japandi (+284%)                     │
└──────────────────────────────────────────────────────────────┘
```

- 展示字段：30天趋势图（Category 级别）、YoY 均值、环比、最快上升子类目
- 用户动作：无（纯信息展示，增强用户对该 Category 的认知深度）
- 区块目的：**权威感建立**。让用户觉得「VibePin 比我更懂这个类目」，形成依赖

---

### 视口分配建议

```
─────────────────── 100vh ────────────────────
  [0] Category Header Bar          ~44px  固定
  [1] Daily Status Bar             ~48px  固定
  ──────────────────────────────────────────
  [2] Today's Opportunities Feed   ~60%   主体（可滚动）
      (每张卡片约 160px，默认展示 3-4 张)
  [3] Watchlist Alerts             折叠（有 alert 时展开）
  [4] This Week's Plan             折叠（3 行预览）
  [5] Category Trend Pulse         折叠（底部）
─────────────────────────────────────────────
```

---

## B. Daily Feed 排序与筛选逻辑

### 默认排序：Intelligence Score（综合评分）

**排序优先级（非数学公式，是优先级链）：**

```
Level 1（硬过滤）:  排除 avoid tier；排除用户已标记 "Seen" 的词
Level 2（Tier 排序）: blue_ocean → early_trend → hot_red_sea
Level 3（同 Tier 内）: save_velocity_score 降序（上升速度最快的优先）
Level 4（Tie-break）: freshness_score 降序（数据最新的优先）
Level 5（个性化加权）: 用户过去 7 天点击/添加过的子类目 +10% 权重（付费功能）
```

**设计意图：** 为什么 velocity 比 score 更适合做 Level 3 tie-break？因为 score 是存量评估，velocity 是增量信号。对用户来说，「正在爆」比「历史上好」更值得今天行动。

---

### 切换排序选项（Feed 右上角 Dropdown）

| 排序名 | 核心逻辑 | 适用场景 |
|--------|---------|---------|
| **Intelligence Score** *(默认)* | Tier 优先 → velocity → freshness | 每日必看，快速决策 |
| **Fastest Rising** | save_velocity_score 全场最高优先，忽略 tier | 找正在爆的词，提前布局 |
| **Most Shoppable** | linked_products 数量降序；有 price_range 的优先 | Affiliate / Etsy 卖家，找可变现商品 |
| **Lowest Competition** | blue_ocean 内 YoY 增长最高但 product 数最少 | 新品类开荒，避开红海 |

**注：**「Fastest Rising」和「Most Shoppable」对免费用户可见选项但灰显，点击提示升级。「Intelligence Score」和「Lowest Competition」免费用户可用。

---

### 筛选 Chip（Feed 顶部）

```
[ All Tiers ▼ ]  [ Any Format ▼ ]  [ Updated: Today ▼ ]  [ Has Products ]
```

| 筛选维度 | 免费 | 付费 |
|---------|------|------|
| Tier 筛选（blue/early/hot） | ✅ | ✅ |
| Has Products（有商品情报） | 可见，灰显 | ✅ |
| Updated Today/Week | 仅 Today | 可选 Today/3d/Week |
| 自定义 Score 阈值 | ❌ | ✅ |

---

### 免费用户 Feed 交互设计

免费用户看到的 Feed 是「可见但不可用」而非「不可见」：

```
┌──────────────────────────────────────────────────────────┐
│ [BLUE OCEAN]  home office inspo              Score 70-90  │
│ [Pin 缩略图]  [🔒 模糊图]  [🔒 模糊图]                    │
│ 💡 Monetize: Furniture affiliate · ...                    │
│ 📝 "10 Home Office Ideas That Actually Work"              │
│                   [🔒 2 more templates — Upgrade]         │
│ [View Pins]  [🔒 View Products]  [+ Add to Plan]          │
└──────────────────────────────────────────────────────────┘
```

第 4、5 条卡片整体半透明 + `[Upgrade to see 7 more opportunities today]` 内联 CTA 横条，不打断 Modal，内联在 Feed 里。

---

## C. "只选 3 个机会就结束一天" 的 Completion Loop

### 核心心理模型

**关键设计决策：为什么是 3 而不是 5 或 10？**
- 3 个机会对应「今天可以生产的 Pin 数量」的心理预期
- 3 个足够让用户体验完整的 tier 多样性（1 blue_ocean + 1 early_trend + 1 hot_red_sea）
- 超过 5 个开始感觉是「作业」，而不是「工作完成了」

---

### 状态机设计

```
[进入 Category Workspace]
         │
         ▼
  ┌─────────────────┐
  │  FRESH STATE    │  Daily Status Bar: ○○○ 0/3 Picked
  │  系统预选 3 个  │  （系统推荐：1 blue_ocean + 1 early_trend + 1 hot_red_sea）
  └────────┬────────┘
           │ 用户点击 "+ Add to Plan"
           ▼
  ┌─────────────────┐
  │  PICKING (1/3)  │  Status Bar: ●○○ 1/3 Picked  · [Undo]
  └────────┬────────┘
           │
           ▼
  ┌─────────────────┐
  │  PICKING (2/3)  │  Status Bar: ●●○ 2/3 Picked
  └────────┬────────┘
           │
           ▼
  ┌─────────────────┐
  │  READY (3/3)    │  Status Bar: ●●● 3/3 Picked  · [Finish Today →]
  │  按钮变为高亮   │  整个 Status Bar 变为绿色高亮
  └────────┬────────┘
           │ 点击 [Finish Today]
           ▼
  ┌─────────────────────────────────────────────────────────┐
  │  COMPLETION MODAL（轻量，不是全屏）                      │
  │                                                         │
  │  ✅ Today's session done                                │
  │                                                         │
  │  You picked:                                            │
  │  · japandi living room          [blue_ocean]            │
  │  · nail ideas 2026              [early_trend]           │
  │  · small apartment decor        [hot_red_sea]           │
  │                                                         │
  │  Next step:  [Generate Pins for these →]  [Close]       │
  │                                                         │
  │  🔥 7-day streak · Come back tomorrow for new signals   │
  └─────────────────────────────────────────────────────────┘
           │
           ▼
  ┌─────────────────┐
  │  DONE STATE     │  Feed 变为 80% 透明度（今天份额已用）
  │                 │  Status Bar: ✅ Done for today · New signals at 8:00 AM
  └─────────────────┘
```

---

### DONE STATE 设计（防止信息流化的关键）

当用户完成 3/3 后，Feed 不消失，而是变成「今日已完成」状态：

```
──────────────────────────────────────────────
  ✅ You're done for today.  New signals arrive at 8:00 AM.
  ─────────────────────────────────────────────
  [Feed 变为 80% 不透明，点击任何机会可查看，但 Add to Plan 变为 "Already planned for today"]
──────────────────────────────────────────────
```

**为什么有效防止信息流化：**
- 不是强制离开页面，用户仍可浏览（无强制感）
- 「已完成」的视觉状态让继续刷的边际价值下降
- 「8:00 AM 新信号」设定了明天回来的时间锚点

---

### 系统推荐 vs 用户自选

系统推荐逻辑（伪代码）：

```javascript
recommended = [
  opportunities.find(o => o.tier === 'blue_ocean' && !user.seen),      // 1 blue_ocean
  opportunities.find(o => o.tier === 'early_trend' && !user.seen),     // 1 early_trend
  opportunities.find(o => o.tier === 'hot_red_sea' && o.products > 3), // 1 有商品情报
]
```

推荐的 3 个卡片显示 `[Recommended for today]` badge，用户可：
- 直接一键 `Accept All 3 & Finish`
- 手动替换任意一张
- 忽略推荐，自己选

---

## D. Saved Opportunities / Watchlist / Alerts

### D1. Saved Opportunities 组织结构

```
/app/plan
  ├── This Week
  │     ├── japandi living room  [Status: Draft]  [Generate →]
  │     ├── wedding nails 2026   [Status: Scheduled]
  │     └── diy wall art         [Status: Published ✓]
  ├── Last Week（折叠，最近 3 周可见；更早付费查看）
  └── All Saved（按 Category 分组）
        ├── Home Decor (12)
        ├── Fashion (5)
        └── Wedding (3)
```

**每条 Saved Opportunity 的数据结构：**

```typescript
interface SavedOpportunity {
  id: string
  keyword: string
  category: string
  tier: 'blue_ocean' | 'early_trend' | 'hot_red_sea'
  score: number
  saved_at: Date
  week_label: string          // "Week of May 26"
  status: 'draft' | 'in_progress' | 'scheduled' | 'published'
  generated_pin_ids: string[]
  notes: string               // 用户手写备注（付费功能）
}
```

---

### D2. Watchlist 设计

**最小 Watchlist 集合（v1 只做这三类）：**

| Watchlist 类型 | 说明 | 示例 |
|---------------|------|------|
| **Keywords** | 关注特定关键词的动态（tier 变化、score 变化） | `japandi living room` |
| **Sub-niches** | 关注某个子类目整体走势 | `Cottagecore`, `Dark Academia` |
| **Domains** | 关注特定卖家/平台的 Pin 表现 | `wayfair.com`, `etsy.com/shop/xyz` |

**Watchlist 数据结构：**

```typescript
interface WatchlistItem {
  type: 'keyword' | 'subniche' | 'domain'
  value: string
  added_at: Date
  last_alert_at: Date | null
  alert_config: {
    tier_upgrade: boolean
    score_change_threshold: number  // score 变化超过 N 时通知
    velocity_spike: boolean         // 周涨幅超过 50% 时通知
    new_products: boolean           // 出现新 shoppable products 时通知
  }
}
```

---

### D3. Alerts 触发条件

| 触发条件 | 为什么有效 | 用户层级 |
|---------|-----------|---------|
| **Tier 升级**：`early_trend` → `blue_ocean` | 最高价值信号，竞争窗口正在打开 | 免费 + 付费 |
| **Save Velocity 突增**：7天涨幅 > 50% | 爆款前兆 | 付费 |
| **新 Shoppable Products**：关注词下出现 ≥5 个新商品 | 品类商业化成熟度提升 | 付费 |
| **Score 大幅上升**：opportunity_score ↑≥15 | 整体信号变强 | 付费 |
| **Tier 降级警告**：`blue_ocean` → `early_trend` | 帮用户知道该收手了 | 付费 |
| **Weekly Category Report** | 维系非每日回访用户 | 免费（简化）+ 付费（完整）|

---

## E. Email + In-app Report 拆分设计

### 设计原则

**Email 的唯一任务是「让用户打开 VibePin」，不是「在邮件里完成工作」。**

---

### Email 结构

**主题行公式：**
```
[N new Blue Oceans in Home Decor] — Your signals for [Mon, May 26]
```
有 Alert 时：
```
🔔 "small space bedroom" just hit Blue Ocean — act before it fills up
```

**邮件正文（从上到下）：**

```
────────────────────────────────────────────
[VibePin Logo]  Home Decor · Mon, May 26
────────────────────────────────────────────

📡 Today's Top Signal
"japandi living room"  →  BLUE OCEAN  Score 87 ↑
Monetize: Home decor affiliate · Printable wall art
[→ Open in workspace]

────────────────────────────────────────────
Today's 3 Opportunities

#1  japandi living room      [BLUE OCEAN]   Score 87
    "10 Japandi Ideas That Feel Instantly Calm"
    [View in workspace →]

#2  home office inspo        [EARLY TREND]  Score 71
    "Small Home Office Setup Ideas for 2026"
    [View in workspace →]

#3  diy wall art ideas       [HOT RED SEA]  Score 64
    [View in workspace →]
────────────────────────────────────────────
[FREE]  Upgrade to see 10 opportunities + product intelligence
[PAID]  7 more opportunities waiting in your workspace

[Open Home Decor Workspace →]
────────────────────────────────────────────
🔔 Watchlist（仅有 Alert 时出现）
  "small space bedroom" moved to Early Trend  [View →]
────────────────────────────────────────────
```

**免费 vs 付费邮件差异：**

| 元素 | 免费 | 付费 |
|------|------|------|
| 机会数量 | 3 条 | 3 条摘要 + 「7 more」钩子 |
| Score 数值 | 范围（70-90） | 精确值 87 |
| Pin 缩略图 | 无 | 1 张/条（嵌入式）|
| Monetize hint | 文字 | 文字 + 商品数量 |
| Deep link 目标 | Workspace 首页 | 直达对应 opportunity 卡片 |
| Watchlist alerts | ❌ | ✅ |
| 发送频率 | 每周一次 Digest | 每日（有新 blue_ocean 时）|

---

### Email 与 In-app 互补关系

```
Email（唤醒）        →    In-app（执行）
─────────────────────────────────────────
"3 new signals"      →    完整 10 条 Feed
Score 范围（模糊）   →    精确 Score + 趋势图
1 个 title template  →    3 个 + 自定义提示
文字变现 hint        →    可点击商品列表
主 CTA 点击          →    直达对应 opportunity 卡片（付费 deep link）
```

---

### In-app Daily Loop 完整流程

```
Step 1: 进入 Category Workspace
         → 看 Alert 区（有没有 Watchlist 触发）
         → 看 Daily Status Bar（今天 0/3，快速知道要干什么）

Step 2: 浏览 Today's Opportunities（3-10 条）
         → 每条卡片：看 Pin 样本 → 理解变现 → 选标题模板

Step 3: Add to Plan（3 次）
         → Status Bar: 0/3 → 1/3 → 2/3 → 3/3

Step 4: Finish Today
         → Completion modal：展示今日 3 个选择 + [Generate Pins →]

Step 5（可选）: 在 Plan 页查看本周进度
         → 已生成的 Pin → 已排期 → 已发布
```

---

## F. Free vs Paid 在 Category Workspace 的边界

### 设计原则：免费用户每天有「再来一次就能完成」的感觉

不让免费用户感觉「完全用不了」，要让他们感觉「差一点点，升级就好了」。

---

### 完整分层对照表

| 功能 | 免费 | Starter | Pro | Agency |
|------|------|---------|-----|--------|
| Category Workspace 数量 | 1 个 | 2 个 | 5 个 | 无限 |
| 每日机会数量 | 3 条 | 5 条 | 10 条 | 10+ 条（含历史归档）|
| Score 展示 | 区间（70-90）| 精确值 | 精确值 + 历史曲线 | 全部 |
| Pin 缩略图数量/卡 | 1 张（不可放大）| 2 张 | 3 张（可点开 Trends）| 3 张 + 批量导出 |
| Title Templates 数量/卡 | 1 条 | 2 条 | 3 条 | 3 条 + AI 自定义 |
| Monetize hint | 文字 | 文字 + 商品数 | 文字 + 商品详情 | 同 Pro + API 导出 |
| View Products | 显示数量（灰色）| ✅ 基础 | ✅ 完整价格/域名 | ✅ + 批量导出 |
| Add to Plan 上限 | 5 条 | 20 条 | 无限 | 无限 + 多账号 |
| Export CSV | ❌ | ❌ | ✅（月 100 条）| ✅ 无限 |
| Watchlist | ❌ | 5 个词 | 无限 | 无限 |
| Alerts（In-app） | ❌ | ✅ 基础（tier 升级）| ✅ 全部 | ✅ 全部 + Webhook |
| Email 频率 | 每周 1 次 | 每日 | 每日 + 即时 alert | 每日 + 即时 |
| 历史数据（Plan 归档）| 最近 1 周 | 最近 4 周 | 最近 3 个月 | 全部 |
| Score 变化趋势 ↑↓ | ❌ | ✅ | ✅ | ✅ |
| Category Trend Pulse 图 | 7 天 | 30 天 | 90 天 | 90 天 |
| 团队共享 Workspace | ❌ | ❌ | ❌ | ✅ |

---

### 免费用户三个内联升级触点（不打断 Modal）

**触点 1：Feed 第 4 条卡片位置**
```
┌──────────────────────────────────────────────────────┐
│  🔒  7 more opportunities in Home Decor today        │
│  Includes 2 more Blue Oceans with product signals    │
│  [Upgrade to Pro →]                                  │
└──────────────────────────────────────────────────────┘
```

**触点 2：Add to Plan 第 6 次时（内联提示）**
```
You've saved 5 opportunities (free limit).
[Upgrade to save more]  or  [Remove one to make space]
```

**触点 3：View Products 点击时（侧边抽屉半打开，内容模糊）**
```
8 shoppable products found
[🔒 Domains, prices & affiliate links are Pro features]
[See a preview — Upgrade to unlock]
```

---

## V1 最小可实现范围（2 周交付）

### Week 1：Workspace 骨架 + Completion Loop

| 任务 | 依赖现有模块 | 新增组件 |
|------|------------|---------|
| Category Header Bar（Tab 切换） | `/discover` 筛选逻辑 | `CategoryTabs` 组件 |
| Daily Status Bar（0/3 进度条） | 新 | `DailyStatusBar` 组件 |
| Opportunity 卡片新样式（Pin 缩略图 + Monetize + Template） | `OpportunityCard` 现有组件 | 扩展 `OpportunityCard` |
| Add to Plan 动作（更新进度条） | Supabase `saved_opportunities` 表 | `useDailyPlan` hook |
| Completion Modal（3/3 后触发）| 新 | `CompletionModal` 组件 |
| DONE STATE（Feed 变半透明）| 新 | CSS class + 状态管理 |

### Week 2：Watchlist + Alert + Email 基础版

| 任务 | 依赖现有模块 | 新增 |
|------|------------|------|
| Watchlist 数据表 | Supabase schema | Migration SQL（新增 `watchlist` 表）|
| Watchlist UI 区块 | 新 | `WatchlistPanel` 组件 |
| Alert 触发：Tier 升级检测 | `trend_opportunities_view` tier 字段 | Python cron 脚本，写入 `alerts` 表 |
| Alert 在 Workspace 展示 | 新 | `AlertBanner` 组件 |
| Email Daily Digest（基础版）| 新 | Next.js API route + Resend 模板 |
| Free / Paid 字段切割（前端 guard）| `useUser` hook | 在 `OpportunityCard` 内加 `isPro` 判断 |

### V1 不做（推迟到 V2）

- 个性化加权排序（需要用户行为数据积累）
- Streak/Gamification 完整功能
- Domain Watchlist
- Export CSV
- Agency 团队 Workspace
- Email 即时 Alert（先做每日 Digest）
- Score 历史曲线（需要历史快照数据）

---

## V1 → V2 → V3 升级路线

| V1（2 周）| V2（+4-6 周）| V3（+3 个月）|
|-----------|-------------|-------------|
| 固定 Category Workspace 骨架 | 用户自定义 Category 顺序与选择 | AI 推荐用户应该关注的 Category |
| 手动 Pick 3 | 系统智能推荐 3（基于历史偏好）| 个性化排序（ML）|
| Alert：Tier 升级 | Alert：全部触发条件 | Alert：跨 Category 机会对比 |
| Email 每日 Digest | Email 即时 Alert | Email A/B 测试 |
| Free/Pro 2 层 | Starter/Pro/Agency 完整 3 层 | Enterprise + API 访问 |
| Completion Loop（3/3）| Streak + Weekly Review | 团队共享 Workspace + 分工 |
| Plan 页基础版 | Plan → Studio 一键跳转带 context | Plan 与 Publish Queue 完整整合 |

---

*VibePin Category Workspace IA v1.0 · 设计文档 · 2026-05-26*
*参考 PRD：docs/canvases/pinterest-flow-prd-v4.0-growth-os.canvas.tsx*
