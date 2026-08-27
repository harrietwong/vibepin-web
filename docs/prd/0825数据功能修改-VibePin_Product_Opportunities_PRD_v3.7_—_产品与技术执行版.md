# VibePin Product Opportunities PRD v3.7

> 状态：业务口径已闭合；本地实现已完成，等待分阶段生产门禁
> 基于：Product Opportunities PRD v3.6 业务需求版
> 目的：把 v3.6 的业务方向补充为可实现、可测试、可回滚的产品与技术规格
> 原则：真实证据优先；缺数据就少展示；不以累计 Saves、关键词趋势或内部样本排名冒充近期 Product Demand

---

## 1. 本版本解决什么问题

v3.6 已确定 Product Opportunities 的核心价值：

```text
Discover
→ Verify Pinterest Evidence
→ Research Real Product
→ Save Product
→ Continue Tracking
→ Observe Demand / Trend Changes
→ Return and Decide
```

v3.7 补齐以下执行问题：

1. 什么是稳定的 Product Opportunity。
2. Primary Pinterest Evidence 如何选择、保存和切换。
3. Active、Inactive、Retired 如何影响全量商品追踪。
4. 每日 Save snapshot 如何产生、校验和恢复。
5. G30、Current G7、Previous G7 如何从不完整历史中诚实计算。
6. High Demand、Rising、Stable、Cooling 如何校准和显示。
7. 缺名称、缺图片、缺历史、指标回撤时如何展示。
8. Saved Products 如何实现账号隔离、收藏记录和产品留存。
9. 旧 Demand、Trend、Competition、Opportunity Score 如何退役。
10. 如何分阶段上线，避免等待 30 天才发现采集链路无效。

---

## 2. 范围

### 2.1 P0 范围

1. 稳定 Product Opportunity 实体。
2. Pinterest Evidence 关系。
3. Primary Evidence 持久化。
4. Active Tracking Set。
5. 每日有界追踪任务。
6. Append-only Save snapshots。
7. 30d Saves Gained。
8. Current G7 / Previous G7。
9. High Demand / Rising / Stable / Cooling / Insufficient Signal。
10. Product Opportunities 列表与筛选。
11. Product Detail Modal。
12. Pinterest Evidence 和真实商品页链接。
13. 商品收藏与 Saved Products 入口。
14. 数据质量、任务健康和产品行为埋点。

### 2.2 P1 范围

1. 30D Timeline UI。
2. Alerts。
3. Additional Evidence 排序增强。
4. Emerging Products。
5. Category Benchmark。
6. Saved Products 分组、备注和高级筛选。
7. Product Picker enhancements。

### 2.3 明确不做

1. 根据 Pinterest Saves 推算销量或收入。
2. Marketplace Competition。
3. Seller Saturation。
4. Opportunity Score。
5. 多 Pin Saves 直接相加。
6. 小时级 snapshot。
7. 缺失历史插值或伪造回填。
8. 用 Pin 标题填充 merchant product_name。
9. 用 Pinterest 托管图片冒充 Product Image。

### 2.4 首发用户与类目

首发聚焦 Etsy、POD 和视觉型小型电商卖家，不同时覆盖所有 Pinterest 兴趣领域。

首发类目：

1. Home Decor。
2. Wedding / Celebrations。
3. Gifts。
4. Jewelry / Accessories。
5. Fashion。
6. Digital Products，包括 Printables、Templates、Invitations、Planners 和其他可验证的数字商品。

Physical 与 Digital 必须作为两个独立数据族校准 Demand 门槛。Fashion 可以与 Jewelry / Accessories 共用导航入口，但数据分析应保留更细的 Product Type，避免服装、首饰、鞋包被强行使用同一分布。

Beauty 作为下一候选类目，在首发数据审计证明真实商品页、真实商品图和证据覆盖足够后再决定是否加入。Food、Travel 和 Auto 不进入首发 Product Opportunities。

---

## 3. 核心业务对象

### 3.1 Product Opportunity

Product Opportunity 是稳定的商品机会实体，不等于某一条 `pin_products` 发现记录。

它需要在以下情况保持稳定身份：

1. 同一商品被多个 Pinterest Pins 发现。
2. Primary Evidence Pin 被替换。
3. 一条历史发现记录被 Retired。
4. 同一商品 URL 后续重新产生合法 Active 记录。
5. 用户已经收藏该商品。

建议最小字段：

```text
id
canonical_product_url
product_url_hash
product_type
category
platform
lifecycle_status
tracking_priority
primary_evidence_id
first_discovered_at
last_evidence_at
created_at
updated_at
```

业务规则：

1. `id` 是 Saved Products、Metrics 和 Evidence 的稳定外键。
2. `pin_products` 保留为发现、商品 enrichment 和 provenance 证据，不被破坏性迁移。
3. 同一 active canonical product identity 最多对应一个 active Product Opportunity。
4. Retired Opportunity 和后续重新发现的 active evidence 可以共存。
5. 不允许通过覆盖 retired 历史记录实现重新激活。

### 3.2 Product Opportunity Evidence

一个 Product Opportunity 可以拥有多个 Pinterest Evidence Pins。

建议字段：

```text
id
product_opportunity_id
pin_id
pin_url
evidence_type
is_primary
evidence_status
valid_from
valid_to
selection_reason
last_successful_snapshot_at
consecutive_not_found_count
created_at
updated_at
```

`evidence_type`：

```text
product_pin
source_pin
validating_pin
```

`evidence_status`：

```text
active
temporarily_unavailable
invalid
retired
```

以上是内部数据状态，禁止原样显示给用户。

### 3.3 Primary Evidence

每个 active Product Opportunity 最多一个 Primary Evidence Pin。

选择顺序：

1. 与真实商品页面有明确关系、且当前可访问的 Product Pin。
2. 没有合格 Product Pin 时，选择来源最清晰、指标可读取的 Source Pin。
3. Additional Evidence 只用于解释和验证，不参与 MVP 指标相加。

业务裁决：当普通 Source Pin 直接指向真实商品详情页、商品页具有真实商品图且证据关系可审计时，允许该 Source Pin 成为 Primary Evidence；不要求必须存在 Pinterest Product Pin。

没有 Product Pin 不等于没有真实商品：

1. 普通 Pinterest Pin 可能直接链接到 Etsy listing、Shopify PDP 或独立站商品详情页，但该 Pin 没有 Pinterest catalog/product metadata。此时真实商品页存在，该普通 Pin 是 Source Pin Evidence。
2. 一个灵感图或搭配图可能包含 Shop the Look 商品卡，点击后能到真实商家商品页，但 Pinterest 没有提供独立的 Product Pin ID。此时搭配图是 Source Pin Evidence。
3. 只有 Pinterest Pin 图片、没有真实商品详情页 URL 的内容不构成 Product Opportunity，应留在 Pin Ideas，而不是进入 Product Opportunities。

因此，Source Pin 不会被写成或展示成 Product Pin。两者都是 Product Opportunity 的不同 Evidence 类型，用户可以通过 Pinterest 链接亲自验证。

Primary Evidence 必须持久化，不能在每次 API 请求中临时重算。

切换规则：

1. 新 Pin Saves 更高不能单独触发切换。
2. 单次 404、timeout 或 429 不能触发切换。
3. Primary Pin 连续确认失效后，才允许选择新的 Primary。
4. 切换必须记录旧、新 Pin、时间和原因。
5. 不同 Primary Pins 的历史不能直接拼成一条连续 G30/G7 曲线。
6. 切换后，新 Primary 只有满足自身历史门槛才显示 Demand/Trend。

首发规则：Primary Evidence 必须在三个独立自然日的采集结果中连续确认 `not_found`，才允许自动切换。`timeout`、`429`、解析失败或同日重复尝试均不计入三次确认。若存在其他合格 Evidence，切换后从新 Evidence 自身的历史重新计算指标；若不存在，则暂停对外展示近期指标并等待证据修复。

---

## 4. 生命周期与追踪资格

### 4.1 Product Opportunity 生命周期

```text
discovered
→ active ↔ inactive
   ↓        ↓
   retired (终态)
```

含义：

1. `discovered`：已发现，但实体和证据门禁尚未全部完成。
2. `active`：可进入发现页和 Tracking Set。
3. `inactive`：暂不出现在默认发现页，但历史保留，可恢复。
4. `retired`：不再追踪、不出现在用户发现页，历史永久保留。

状态约束：所有新实体必须先以 `discovered` 且不携带生命周期时间戳进入；`discovered` 只能进入 `active` 或 `retired`；`active` 可进入 `inactive` 或 `retired`；`inactive` 可恢复为 `active` 或进入 `retired`；`retired` 为不可逆终态。该约束必须由数据库直接执行，不能只依赖 RPC 或应用代码。Evidence 一旦退役也不能在原记录上恢复，需保留历史并建立新的当前证据记录。

### 4.2 商品收藏

收藏是用户与 Product Opportunity 的关系，不修改 Opportunity 的全局生命周期，也不决定商品是否进入趋势追踪。

建议字段：

```text
id
user_id
product_opportunity_id
status
created_at
updated_at
```

约束：

```text
UNIQUE(user_id, product_opportunity_id)
```

规则：

1. 用户只能看到和修改自己的收藏。
2. 收藏不复制商品字段，不制造第二份商品真相。
3. 所有 Active Product Opportunities 都持续追踪，不要求用户先收藏。
4. 用户收藏或取消收藏不会启动、停止或改变该商品的全局趋势采集。
5. 用户取消收藏后，不删除商品的公共历史 snapshots。
6. 如果商品后续无法继续使用，Saved Products 保留历史，不静默消失。

用户界面不得显示 `retired`、`inactive`、`unavailable`、`evidence_status`、`insufficient_signal` 等内部状态词。商品无法继续查看时使用普通用户语言，例如：

```text
This product can’t be viewed right now.
```

仍然保留用户之前看到的商品信息、Pinterest Evidence 和历史变化；不静默删除。

前台按钮使用心形图标和 `Save`，对应中文“收藏”。提供独立的 `Saved Products` 入口，展示用户的收藏记录。

收藏的用户价值：

1. 把感兴趣的商品加入个人观察清单。
2. 用户下次回来可以快速找到它，并查看从 Rising、Stable 到 Cooling 的变化。
3. 后续可以产生收藏商品变化提醒。
4. 它不是下载、拥有商品、Pinterest Save 或进入 Create Pins。

套餐访问规则：

| Plan | Product Opportunities | Demand / Trend | 收藏 |
|---|---|---|---|
| Free | 固定前 10 个完整机会 | 对这 10 个商品完整显示 | 可收藏可访问的商品 |
| Starter | 完整目录 | 完整显示 | P0 不另设 Product-specific 上限 |
| Pro | 完整目录 | 完整显示 | P0 不另设 Product-specific 上限 |
| Business | 完整目录 | 完整显示 | P0 不另设 Product-specific 上限 |

规则：

1. 不在同一张用户可见 Product Card 上故意遮掉部分真实指标。
2. Free 的限制作用于可访问商品集合，不作用于后台是否继续追踪。
3. 付费套餐看到同一份真实全局数据，不为不同套餐计算不同 Demand/Trend。
4. Free 用户不能通过收藏、直接 URL、搜索或接口参数访问固定 10 个之外的 Product Opportunity 详情。
5. 付费套餐 P0 先共享完整目录和完整指标，不人为制造 Starter、Pro、Business 三份不同数据。
6. Free 的 10 个商品由服务端保存稳定的展示编号 1–10；它不是每次请求按当前排序临时截出的前十，也不会因搜索、分页或其他用户行为漂移。
7. Free 展示集合如需替换，必须由业务审核新商品证据后显式调整编号，并记录变更；不得按当天 Saves 自动替换。
8. 用户从付费套餐降为 Free 后，原收藏关系和收藏时间继续保留，但固定 10 个以外的商品详情不再开放；Saved Products 使用“升级套餐后可查看”等用户语言，不删除历史，也不显示内部状态名。

### 4.3 收藏与 Create Pins 的边界

Product Card 有两个完全独立的动作：

1. `Save`：加入 Saved Products，方便以后回来查看。
2. `Create Pin`：把这个商品作为创作素材带入 Create Pins，生成新的 Pin 图片和文案。

规则：

1. 收藏不会自动进入 Create Pins。
2. Create Pin 不会自动收藏商品。
3. 两个按钮必须使用不同图标、不同文案和不同成功提示。
4. Create Pin 必须复用已有 Product Picker / Create Pins handoff，不建立第二套创作流程。
5. Create Pin 使用商品时仍遵守图片来源、商品真实性和用户权限规则。
6. Product Opportunity handoff 只携带真实商家商品图、真实商品链接、可选真实名称和经过映射的自然分类标签；不得把内部分类值当作机会标题、关键词或商品名。名称为空时，Create Pins 只能描述“所选商品”，不得补造名称。

### 4.4 Tracking Set

P0 默认追踪策略：

| 状态 | 建议频率 |
|---|---:|
| 新发现 | 每日 |
| High Demand / Rising | 每日 |
| Active Stable | 每 2–3 天 |
| Cooling / 长期低活动 | 每周 |
| Repeatedly unavailable | 暂停 |
| Retired | 不追踪 |

业务要求：所有 Active Product Opportunities 都必须持续观察趋势，不以是否被用户收藏为前提。

P0 首发采用每日覆盖全部 Active Product Opportunities。未来数据规模扩大时，可以调整执行批次、时间窗口和内部优先级，但任何仍对用户展示趋势的 Active Product 都必须保持足以支撑其指标声明的 observation cadence。套餐限制只决定用户能看到多少趋势详情、能收藏多少商品，不改变全局数据事实。

---

## 5. Snapshot 数据合同

### 5.1 原始事实

`pin_save_snapshots` 是原始历史真相。

最小数据：

```text
pin_id
save_count
captured_at
captured_on
observation_status
```

规则：

1. 每个 Pin 每个 UTC day 最多一个 canonical snapshot。
2. 重试必须幂等。
3. 原始 observation 不因后续计算而修改。
4. 不生成不存在日期的 snapshot。
5. 不为缺失天数插值。
6. snapshot 写入失败不得被报告为成功追踪。

### 5.2 Observation 状态

建议状态：

```text
valid
counter_regression
implausible
fetch_failed
```

`fetch_failed` 可以存储在独立 tracking attempt 表，不应伪装成 Save snapshot。

### 5.3 Counter Regression

当累计 Saves 下降时：

1. 保留原始 observation。
2. 标记 `counter_regression`。
3. 该点默认不进入 Demand/Trend 计算。
4. 不把负数解释为负 Demand。
5. 不立即产生 Cooling。
6. 后续观测稳定后，由统一算法决定新的有效基线。

### 5.4 日期边界

指标计算不得假设刚好存在第 7、14、30 天的 snapshot。

必须配置：

```text
G7 anchor tolerance
G14 anchor tolerance
G30 anchor tolerance
minimum valid observations
maximum allowed history gap
```

初始建议用于数据审计，不作为最终业务阈值：

1. 7d anchor 优先选择距离目标日最近的有效 observation。
2. 30d anchor 同理。
3. 超出允许容差时返回 `insufficient_history`。
4. 实际天数必须随指标保存，便于审计。

v1 Shadow Metrics 的保守技术默认值：

1. 14 天窗口至少 10 个有效自然日 observation。
2. 30 天窗口至少 20 个有效自然日 observation。
3. 相邻有效 observation 的最大缺口为 3 天。
4. 上述规则与 anchor tolerance 同时满足，才允许生成对应指标。
5. 任一累计 Saves 回撤都会切断旧基线；旧原始数据永久保留，但回撤前后的数据不得拼接。只有新基线自身重新积累出合格 14d/30d 历史后，指标才恢复。

首发采用：7d 和 14d anchor 允许目标点 ±1 天；30d anchor 允许目标点 ±3 天。超出容差或有效 observation 数不足时不生成该指标。首轮上线后根据真实缺口率复核容差，但不得为了提高覆盖率自动扩大窗口。

---

## 6. Demand

### 6.1 Total Saves

```text
Total Saves = Primary Evidence Pin 最新有效累计 Saves
```

禁止：

1. 将多个 Pins 的 Saves 相加。
2. 将 Source Pin 和 Product Pin Saves 相加。
3. 将 Product 页面销量、评论或 Pin 数量混入 Total Saves。

### 6.2 Rolling 30-Day Saves Gained

```text
G30 = latest_valid_save_count - valid_anchor_around_30d_save_count
```

结果必须携带：

```text
latest_snapshot_at
anchor_snapshot_at
actual_window_days
g30
metric_status
```

`metric_status`：

```text
valid
insufficient_history
insufficient_activity
counter_regression
stale
```

### 6.3 High Demand

```text
High Demand = valid G30 AND G30 >= T30
```

`T30` 必须：

1. 来自真实生产 snapshot 分布分析。
2. 由业务负责人明确确认。
3. 独立于当前搜索结果、当前页面和当前 Category。
4. 有版本号和生效时间。
5. 可以周期性重新校准，但不能每天漂移。
6. Physical 与 Digital 分开校准，分别拥有自己的阈值版本。

阈值确定前：

1. 可以展示 `+N saves · 30d`。
2. 不显示 High Demand。
3. 不使用累计 Saves percentile 临时代替。

建议增加配置记录：

```text
metric_version
t30
effective_from
calibration_sample_size
calibration_window
approved_at
```

---

## 7. Trend

### 7.1 窗口

```text
Current G7 = latest - anchor_around_7d
Previous G7 = anchor_around_7d - anchor_around_14d
```

### 7.2 有效性门禁

Trend 必须按以下顺序判断：

```text
Primary Evidence 是否稳定
→ 历史是否足够
→ snapshots 是否有效且不过期
→ 最近 14 天绝对 Activity 是否达到门槛
→ Current 与 Previous 的绝对差是否达到门槛
→ 再比较相对变化
```

任何门禁不通过：

```text
internal status = insufficient_signal
Card = 不显示 Trend badge
```

### 7.3 状态

```text
Rising
Stable
Cooling
Insufficient Signal
```

判定模型必须同时包含：

```text
minimum_14d_activity
minimum_absolute_delta
relative_change_boundary
```

具体数值在真实分布审计后确定。不得以 `1 → 3` 之类的低量变化产生 Rising。

### 7.4 算法版本

每个派生指标应记录 `metric_version`。调整 Activity Gate 或相对变化边界时，可以重新计算而不修改 raw snapshots。

---

## 8. Product Card

### 8.1 信息顺序

1. 真实 Product Image。
2. 真实 Product Name；有则展示，没有则省略，不影响商品资格。
3. Platform · Category；无法证明则省略对应部分。
4. High Demand；仅在真实 G30 和已确认 T30 下显示。
5. Rising / Stable / Cooling；仅在 Trend 门禁通过时显示。
6. `+N saves · 30d`；仅在 G30 有效时显示。
7. `N total saves`；仅使用 Primary Evidence。
8. Save。
9. Create Pin。
10. Pinterest ↗。
11. View Product ↗。

### 8.2 缺数据

禁止显示：

```text
Product
No data
Low Demand
Stable
Declining
0 saves · 30d
```

除非 `0` 是经过有效历史窗口证明的真实 0。

Product Opportunities 用户页面要求真实 Product Image。图片必须来自真实商品页或允许使用的商品证据来源，不能使用 Pinterest 托管图片代替。

系统在发现阶段无法总是在发请求前知道商品是否有合格图片，因此允许执行一次有界的商品证据检查。检查后仍没有真实 Product Image 时：

1. 不创建或激活用户可见 Product Opportunity。
2. 不进入默认页、搜索结果、Saved Products 或持续 Tracking Set。
3. 可以只在内部拒绝审计记录中保存 URL 和拒绝原因，避免反复抓取。
4. 不得为了提高商品数量使用 Pin 图片补位。

### 8.3 默认发现页资格

数据合法不等于必须排在默认第一页。

默认排序优先级：

1. 有真实 Product Image。
2. 有真实外链和可访问 Pinterest Evidence。
3. Evidence freshness 更高。
4. Most Saved。

没有真实 Product Image 的候选不属于用户可见 Product Opportunity。Product Name 和标题不是资格门槛；有可证明的真实名称就展示，没有就省略，绝不使用 Pin 标题或 `Product` 补位。

---

## 9. Product Detail Modal

Modal 不使用右侧 Drawer。

区域：

1. Product。
2. Demand。
3. Trend。
4. Primary Pinterest Evidence。
5. Additional Evidence。
6. Product Source。
7. Save。
8. Create Pin。

每个指标必须可解释：

```text
30d Saves Gained
Current 7d
Previous 7d
Primary Evidence Pin
Last updated
```

不向普通用户展示内部阈值、SQL 字段或错误栈。

前端也不得显示 lifecycle、evidence、tracking 或 metric 的内部枚举值。所有状态必须翻译成用户能够理解的结果或直接省略。

---

## 10. 查询、筛选和排序

首发筛选：

1. Physical / Digital。
2. Search。
3. Category。
4. Platform。
5. Demand。
6. Trend。

首发排序：

1. Most Saved。
2. Newest Discovered。
3. Fastest Growing，仅在真实 Trend 覆盖达到上线门槛后开放。

Demand / Trend 筛选开放条件：

1. 不能只依据“页面能渲染”。
2. 必须达到预先定义的有效指标覆盖率。
3. 必须通过异常率和误报抽样复核。

首发门槛：Physical 与 Digital 分开计算覆盖率；某一数据族至少 70% 的用户可见 Active Products 同时具有有效 G30 和 G7 Trend，且异常回撤率、跨 Evidence 拼接率均通过数据质量门禁后，才对该数据族开放 Demand/Trend 筛选和 Fastest Growing 排序。未达到 70% 时，已有真实指标仍可在单个商品卡片展示，但不得提供会让用户误以为覆盖完整的全局筛选或排序。

---

## 11. 旧指标退役

新版本上线前必须关闭以下用户侧逻辑：

1. 用 lifetime Saves percentile 生成 High/Medium/Low Demand。
2. 用当前请求结果集动态产生 Demand 阈值。
3. 用 Keyword yearly growth 生成 Product Trend。
4. 用旧 trend_score/save_velocity_score 生成 Rising/Stable/Declining。
5. Product Competition badge。
6. Opportunity Score。

兼容期可以保留旧字段供管理员审计，但用户 API 不得把它们混入新指标。

新旧接口建议通过明确版本字段区分：

```text
metrics_model = product_saves_v1
metric_version = 1
```

---

## 12. Tracking Job

### 12.1 调用链

```text
scheduled tracking job
→ acquire lock
→ select due Primary Evidence Pins
→ dedupe pin_id
→ bounded batches
→ fetch Pinterest metric
→ validate observation
→ idempotent snapshot write
→ update evidence health
→ compute current metrics
→ emit health report
```

### 12.2 自动化要求

1. 请求预算。
2. 每请求 timeout。
3. Job timeout。
4. 全局锁和防重叠。
5. 有界并发。
6. 429 backoff。
7. 5xx/network bounded retry。
8. 失败传播。
9. tree-kill。
10. 孤儿进程检查。
11. 幂等 snapshot。
12. 可重跑。
13. 不因单 Pin 失败终止整批。
14. 首次自动运行验证。

v1 容量与“20 条”口径：

1. 每日趋势追踪上限为 2,499 个去重后的 Primary Evidence Pins，不是 20 个商品。
2. 每次任务的 Pinterest 实际请求硬预算为 5,000 次；为每个 Pin 预留首次请求和最多一次重试，并为 session/bootstrap 保留 2 次余量。
3. 多个 Product Opportunities 共用同一 Primary Pin 时，只请求一次，并且每个 Pin 每个 UTC 自然日只保存一条 canonical raw observation；各 Evidence 的健康状态与指标引用同一真实事实，不复制出多条可能漂移的 snapshot，也不得重复消耗请求。
4. `MAX_BATCH=20` 只约束“已完成商家页补证的新 Product Opportunity 准入写入批次”，用于保证每批可审计、可回滚；它不是每日全量趋势追踪上限。
5. 若未来 Active Primary Pins 超过 2,499，任务必须在联网前拒绝，待完成确定性分片和新预算审查后再扩容；不得静默漏追踪仍向用户展示趋势的商品。

### 12.3 健康报告

每次运行至少报告：

```text
eligible pins
due pins
attempted
successful observations
snapshot writes
deduped pins
404
429
5xx/network failures
timeouts
retries
counter regressions
metric compute failures
stale active evidence
duration
lock released
orphan count
```

### 12.4 Product Supply 到稳定商品的自动准入

Product Supply 与稳定 Product Opportunity 必须保持两个独立写入域。前者只负责发现并写入经过商家页红线的 legacy 候选，后者只消费某一次成功 Product Supply 报告中返回的精确 inserted IDs，不得无界扫描历史表，也不得把 Product Supply 成功等同于用户目录增长。

正式自动链为：

```text
23:00 Product Supply
→ 冻结成功报告和精确 legacy IDs
→ 120 分钟 Pinterest 冷却
→ 03:15 Product Opportunity Admission
→ 再次证明 Pin 身份、Pin 到同一 PDP 的直接关系、商家页和真实商品图
→ 整轮最多 50 行，拆为最多 20 行的独立原子批次
→ 每批精确回读；失败只按返回 ID 做保留历史的回滚
→ 120 分钟 Pinterest 冷却
→ 06:15 全量 Active Product Tracking
```

自动准入必须满足：

1. 仅接受 `mode=apply`、完整处理 100 个互不重复 Source Pins、类目严格为 Fashion 29 / Women's Fashion 22 / Home Decor 29 / Digital Products 20、无失败批次且生成时间不超过 6 小时的 Product Supply 报告。当前线上仍在运行的 Physical-only 36/28/36 报告不能作为该 Digital 首发自动准入链的输入。
2. 报告必须证明整轮写入上限 50、原子批次上限 20；顶层写入数、增量写入数、outcome 写入数和精确 inserted IDs 数量必须一致；任何失败行、错误记录、ID 重复、缺失或超过 50 时整轮拒绝。
3. 零 inserted IDs 是合法自然零，不访问 Pinterest、不访问商家页、不写数据库。
4. 每个精确 ID 在联网前从数据库回读；缺行、多行或顺序无法重建时拒绝。
5. 每个准入批次不超过 20；整轮不超过 50；不得通过多次 flush 绕过上限。
6. 默认 service 为 preflight，安装文件不等于启用 timer；必须先完成手动 dry-run、单批 canary、回读和回滚演练。
7. Admission 或 Tracking 未满足 `SAFE_FOR_APPLY` 时必须失败关闭，不得用 `SAFE_FOR_DRY_RUN` 或 cooldown waiver 继续。

商家换域或 PDP 规范化允许采用保守重定向证明，但不得把重定向当成 URL 猜测：

1. Pinterest Pin 实际直接链接的原始商家 URL 必须原样保留为证据；最终响应的真实 PDP 才作为稳定商品身份。
2. 只接受一至两跳的 HTTP 301、302、303、307、308；每一跳必须首尾连续，且受现有最多三次商家请求预算约束。
3. 必须保留最终解析 URL、完整重定向链和确定性 SHA-256；Python 准入、数据库 RPC 与数据库约束必须使用同一证明规则。
4. JavaScript 跳转、meta refresh、缺失 Location、断链、错误哈希、超过两跳、Pinterest/Pinimg 目标、非 HTTP 目标或最终 URL 不是 PDP 时一律拒绝。
5. 同一稳定商品的每条 Primary/Additional Pinterest Evidence 均需独立完成这项证明；不得因已有一条 Evidence 通过而跳过后续 Pin 的验证。
6. 前端只展示最终真实商品链接和诚实的 Pinterest Evidence 类型，不展示内部重定向字段或技术状态词。

如果 Product Supply 在安全增量写入后、完整成功报告落盘前中断，这些 legacy 行必须保留，但自动准入不得按宽泛时间窗口猜测它们属于哪次运行。恢复只能通过单独的、最多 20 行的审核 manifest 和独立回读凭据完成；不得把中断运行伪装为完整 100-Pin 成功。

---

## 13. 数据质量门槛

### 13.1 Product Opportunity 合法性

必须具备：

1. 稳定 Opportunity identity。
2. 真实 external Product URL。
3. 至少一个合法 Pinterest Evidence Pin。
4. discovery method。
5. provenance。
6. lifecycle 状态。

仅 `discovered` 候选或内部拒绝审计可为空：

1. Product Name。
2. Product Image。缺图时不得进入 `active`、用户页面或 Tracking Set。
3. Price。
4. Currency。
5. Merchant。
6. Availability。

### 13.2 Demand 合法性

1. Primary Evidence 未发生未处理切换。
2. 当前和 anchor snapshots 都有效。
3. 日期窗口满足容差。
4. 没有 counter regression 污染。
5. 数据未过期。

### 13.3 上线前数据审计

必须从生产库只读统计：

1. Active Opportunity 数。
2. 去重 Primary candidate Pin 数。
3. 已有 ≥7d、≥14d、≥30d 历史的数量和比例。
4. 每 Pin observation 天数分布。
5. 最大 gap 分布。
6. counter regression 数量和比例。
7. Product Pin 与 Source Pin 覆盖。
8. 有名称、有图片、有外链的覆盖。
9. 已失效 Evidence 覆盖。
10. 按 Category/Platform 的样本分布。

没有该审计，不得承诺上线时已有多少 High Demand 或 Trend 商品。

---

## 14. 埋点和成功指标

建议事件：

```text
product_opportunities_viewed
product_card_opened
pinterest_evidence_clicked
external_product_clicked
product_saved
product_unsaved
create_pin_from_product_clicked
demand_filter_used
trend_filter_used
saved_products_viewed
```

首发观察指标：

1. Product Card → Pinterest 点击率。
2. Product Card → View Product 点击率。
3. 收藏转化率。
4. Saved Products 7 日和 30 日回访率。
5. 每位活跃用户收藏数。
6. Rising/Cooling 状态变化后的回访率。
7. 有效 Evidence 覆盖率。
8. 14d/30d 指标覆盖率。
9. Tracking success rate。
10. Counter regression 和异常率。

埋点不得包含 secret、完整用户 Prompt 或不必要的个人数据。

---

## 15. 分阶段发布

### Phase 0：只读基线

1. 审计生产 snapshot 和 Product 数据。
2. 冻结指标定义。
3. 确认 Pinterest 数据访问方式和商业使用边界。
4. 产出容量和请求预算。

### Phase 1：数据底座，不改用户 UI

1. 新增稳定 Opportunity entity。
2. 新增 Evidence 关系。
3. 新增 Primary Evidence。
4. 新增 Saved Products 数据结构。
5. 新增 Tracking Queue。
6. 开始持续 snapshot。
7. 验证连续自动运行。

### Phase 2：Shadow Metrics

1. 计算 G30/G7，但不向用户展示 badge。
2. 与 raw snapshots 抽样核对。
3. 分析 T30 和 Activity Gate 分布。
4. 检查误报、回撤和 Primary 切换。

### Phase 3：用户 UI

1. Product Card。
2. Product Detail Modal。
3. Save 与 Saved Products 入口。
4. Create Pin handoff。
5. Pinterest / View Product。
6. 有数据的商品逐步显示 Demand/Trend。
7. 旧指标停止对用户输出。

### Phase 4：P1

1. Timeline。
2. Alerts。
3. Emerging。
4. Category Benchmark。

---

## 16. 验收标准

### 16.1 数据

1. 同一 Pin 同一天重跑不产生重复 canonical snapshot。
2. Retired 与后续 Active evidence 可以共存。
3. Primary Evidence 同时最多一个。
4. Primary 切换有完整审计记录。
5. 不同 Pins 的历史不会直接拼接。
6. 负数回撤不产生负 Demand 或直接 Cooling。
7. 缺历史返回 Insufficient Signal。
8. product_name/image/price 不被伪造。

### 16.2 算法

1. G30 使用真实约 30d anchor。
2. Current/Previous G7 使用同一个 Primary Pin。
3. 低量百分比变化不能产生 Rising/Cooling。
4. 阈值未确认前不显示 High Demand。
5. 旧 percentile Demand 和 keyword Trend 不再进入用户 API。

### 16.3 UI

1. NULL Product Name 不显示 `Product`。
2. NULL Product Image 的候选不会进入用户 Product Opportunities API 或页面。
3. Pinterest 与 View Product 链接分开。
4. 无指标时不显示 no-data badge。
5. Card 与 Modal 指标一致。
6. 收藏状态刷新后仍持久化。
7. 用户之间收藏数据完全隔离。
8. Save 与 Create Pin 互不产生隐式副作用。

### 16.4 自动化

1. timeout、锁、失败传播和回滚测试通过。
2. 429/404/5xx/timeout 均有测试。
3. 任务失败不产生假成功报告。
4. 首次 timer 自动触发通过。
5. 无孤儿浏览器或 worker。
6. 部署 SHA 与目标 commit 一致。

---

## 17. 回滚

1. 新表和新字段优先使用 additive migration。
2. 原始 `pin_products` 和 `pin_save_snapshots` 不破坏性重写。
3. 新 Metrics UI 使用 feature flag。
4. 回滚 UI 时继续保留 snapshot 采集，避免丢失不可补历史。
5. Tracking Job 可以独立 disable。
6. 旧指标仅作为短期内部对照，不作为用户 fallback。
7. 回滚不得恢复伪造 Product Name、图片或旧 Demand/Trend 标签。

---

## 18. 已确认业务口径

本节记录已经闭合的产品决策；后续技术实现不得自行改写这些口径：

已确认：

1. 首发聚焦，并加入 Digital Products 和 Fashion。
2. 没有真实 Product Image 的候选不进入用户可见 Product Opportunities。
3. Physical 与 Digital 分开校准。
4. 用户已保存的历史不静默删除；前端不得显示内部技术状态词。
5. 所有 Active Product Opportunities 都持续追踪，不要求用户先收藏。
6. 用户动作使用收藏语义，并提供独立 Saved Products 入口。
7. Save 与 Create Pin 是两个独立功能。
8. Product Name 和标题不是商品资格门槛；缺失时省略，不制造内容。
9. 普通 Source Pin 直接指向真实商品页时允许作为 Primary Evidence。
10. Free 只能访问固定 10 个完整 Product Opportunities；所有付费套餐访问完整目录和完整趋势指标。

已裁决的首发口径：

1. Primary Evidence 连续三个独立自然日确认找不到后才允许切换；网络类失败不计数。
2. 7d/14d anchor 容差为 ±1 天，30d anchor 容差为 ±3 天。
3. Physical 与 Digital 分别达到 70% 有效 G30+G7 覆盖且质量门禁通过后，才开放对应数据族的 Demand/Trend 筛选和增长排序。
4. 前端使用 `High recent demand`，不使用容易被理解成全市场销量结论的 `HIGH DEMAND`。旁边固定说明 `Based on Pinterest saves gained in the last 30 days`；中文为“依据过去 30 天 Pinterest 新增收藏量”。

---

## 19. 2026-08-25 生产数据基线审计

本节是只读审计结果，不代表已经迁移、补证、写库或上线。

生产库现有：

```text
pin_products rows = 4,110
Physical rows = 2,099
Digital rows = 2,011
legacy pin_save_snapshots rows = 32,491
```

按本 PRD 的最低候选门槛做保守筛选：

```text
真实 external Product URL
+ 非 Pinterest 托管 image URL
+ 可审计 Pinterest Pin ID
+ 非 retired
+ Physical / Digital 已识别
```

结果：

```text
候选 rows = 122
候选 unique products = 122
Physical = 111
Digital = 11
Product Pin Primary 候选 = 0
Source Pin Primary 候选 = 122
detail fetch 已明确 available = 23
detail fetch 历史未知 = 99
```

主要排除原因是非互斥计数：

```text
Pinterest 托管图片 = 3,868
retired = 833
无商品图 = 116
无可审计 Pin = 4
无真实商品页 URL = 1
```

重要限制：非 Pinterest 图片域名只能证明它是“迁移候选”，不能单独证明图片来自商家商品页。122 行仍需执行证据回填和商品图 provenance 校验，通过后才可以激活为用户可见 Product Opportunity。23 行 `available` 可以优先复核；99 行历史状态未知，不得仅凭现有 URL 自动激活。

历史指标覆盖：

```text
7d anchor 候选 = 1
14d anchor 候选 = 2
today observation = 0
完整 G30 + Current G7 + Previous G7 = 0
```

因此当前数据尚不满足新 Demand/Trend 上线条件。正确顺序是：先建立稳定实体与 Primary Evidence，完成 122 行证据复核，再启用全量 active 每日 snapshots；指标历史不足期间只展示真实商品和证据，不显示 Demand/Trend badge。不得用旧 percentile、关键词趋势或 source Pin lifetime saves 冒充新指标。

Digital 当前只有 11 个门槛候选，明显不足以代表完整 Digital 市场。Digital 可以进入同一技术工作流，但首发前必须单独扩充真实商品页和真实商品图来源，并单独达到 70% 指标覆盖门槛。

### 19.1 2026-08-25 严格历史质量复核

在加入“14d 至少 10 个有效日、30d 至少 20 个有效日、最大缺口 3 天”的口径后，生产只读复核结果为：

1. 迁移候选仍为 122 个，Physical 111、Digital 11；全部为 Source Pin + `outbound_link` 候选。
2. 111 个候选拥有 0 天可用历史；11 个候选只有 1–9 天历史。
3. 当日有效 observation 为 0；7d anchor 覆盖 1，14d anchor 覆盖 2，完整 G30 + Current G7 + Previous G7 仍为 0。
4. 23 个候选的旧详情抓取状态为可用，99 个为历史未知；该字段仍不能替代新的商家页、PDP 和商品图 provenance 复核。
5. 122 个候选目前都不能直接激活。先逐批补证并建立稳定实体，再开始每日全量 tracking；在真实历史形成前，用户侧只展示商品与证据，不展示 Demand/Trend 结论。

### 19.2 2026-08-26 Product Supply 切换前复核

本次仍为生产只读审计。与 2026-08-25 基线相比：

```text
pin_products rows = 4,114（+4）
legacy pin_save_snapshots rows = 32,597（+106）
严格迁移候选 = 122（无增长）
Physical = 111
Digital = 11
Product Pin Primary 候选 = 0
Source Pin Primary 候选 = 122
detail fetch 已明确 available = 23
detail fetch 历史未知 = 99
```

历史覆盖仍为：

```text
111 个候选 = 0 天 observation
11 个候选 = 1–9 天 observation
7d anchor = 1
14d anchor = 2
today observation = 0
完整 G30 + Current G7 + Previous G7 = 0
```

Pinterest 托管图片排除数由 3,868 增至 3,872，正好增加 4 行；总行数增长没有转化为任何新的严格迁移候选。这证明 Product Supply 的运行成功和 Product Opportunity 的业务资格必须分开报告：扫描量、候选链接或 legacy 写入量不能冒充真实可见商品数量，更不能冒充 Demand/Trend 覆盖。

2026-08-26 的无缝切换采用：每日扫描 100 个 Source Pins，最多写入 50 个通过共享红线的 legacy 发现行，任何原子写入批次不超过 20；正式 timer 仅在零写 dry-run 和一行精确回读 canary 均通过后恢复。该切换用于阻止继续写入 Pinterest 卡片标题、图片或价格，但它本身不会自动创建 v3.7 稳定 Product Opportunity，也不会补出 G30/G7 历史。

### 19.2.1 2026-08-27 自动运行前只读复核

2026-08-27 00:26:49 UTC（上海 08:26:49）的最新生产 GET 审计进一步确认，Supply 扫描能力与可发布趋势数据仍是两件事：

```text
pin_products rows = 4,115
legacy pin_save_snapshots rows = 33,521
严格迁移候选 = 122（Physical 111 / Digital 11，仍无增长）
当前自动准入口径候选 = 24（Physical 17 / Digital 7）
自动准入分类 = Fashion 6 / Women's Fashion 2 / Home Decor 9 / Digital Products 7
自动准入范围外 / Category-Family 不一致 = 91 / 7
detail available / legacy unknown = 23 / 99
Pinterest 托管图片排除 = 3,872
0 天 observation = 111
1–9 天 observation = 11
10–19 / 20–29 / 30+ 天 observation = 0 / 0 / 0
today / 7d / 14d / 30d anchor = 0 / 2 / 2 / 0
完整 G30 + Current G7 + Previous G7 = 0
Digital today / 7d / 14d / 30d / full metric = 0 / 0 / 0 / 0 / 0
自动准入口径 today / 7d / 14d / 30d / full metric = 0 / 0 / 0 / 0 / 0
```

审计工具现固定输出所有零值，而不是省略字段。122 只是满足最小 URL / image host / Pin ID / family 条件的技术迁移集合，不能再被描述为当前自动准入可消费的首发库存；按已审查的 Fashion、Women's Fashion、Home Decor、Digital Products Category-Family 组合收紧后只有 24 个。其余包括 91 个当前自动准入未审查类目和 7 个 Category-Family 不一致行。与上一份审计相比，legacy `pin_products` 增加 5 行，但技术迁移集合仍是同一批 122 个，合格增量为 0。`today` 从 1 变成 0、7d anchor 从 1 变成 2，是审计跨过 UTC 自然日边界后的窗口移动，不是 snapshot 被删除；当前 UTC day 确实没有候选 observation。真实结论仍是：商品发现链可以每日运行，但 Demand/Trend 尚无一个候选具备完整历史，当前自动准入口径的 24 个商品连一个有效 anchor 都没有；任何用户侧增长结论继续保持隐藏。

2026-08-27 03:42:05 UTC 又执行了一次仅 GET 的独立复核。`pin_products=4,115`、旧 snapshots `=33,521`、技术迁移候选 `=122`、已审查自动准入候选 `=24`、`available/legacy_unknown=23/99`，以及自动准入范围的 `today/7d/14d/30d/full=0/0/0/0/0` 均与 00:26 审计完全一致。该时间段没有新增合格候选，也没有新增可用趋势历史；因此不因“任务正在准备上线”而推断数据自然达标。

### 19.2.2 2026-08-27 06:58:54 UTC 增量复核

同一 GET-only 审计随后得到：`pin_products=4,115`、旧 snapshots `=34,073`、技术迁移候选 `=123`（Physical 112 / Digital 11）、已审查自动准入候选 `=25`（Physical 18 / Digital 7）、`available/legacy_unknown=24/99`。相对 03:42 审计，snapshot 增加 552，且 Home Decor / Physical 增加一个技术候选和一个已审查自动准入候选；没有重复合格 identity。

这次增长不能被描述为趋势指标已经达标：25 个自动准入候选的 `today/7d/14d/30d/full` 仍为 `0/0/0/0/0`，全体 123 个技术候选的 30-day anchor 和完整 G30 + Current G7 + Previous G7 仍为 0。可确认的业务事实仅是 legacy 发现与 snapshot 数据继续增长；v3.7 稳定实体尚未上线，长期趋势历史尚未建立，Demand/Trend 和 Fastest Growing 必须继续隐藏。完整报告固定为 `backend/docs/product_opportunities_v37_production_audit_20260827T065854.041782Z.json`。

同日 07:05:21 UTC 使用 service-role 只读 GET 检查生产 PostgREST OpenAPI schema：共发现 72 条可见路径，旧 `/pin_products` 与 `/pin_save_snapshots` 控制路径均存在，v63 的 Product Opportunity / Evidence / Metric / Saved Product 表与 RPC 匹配路径为 0。这证明 Stage 0 当前未发现已部署的同名 v63 API 定义冲突，但不构成应用迁移的授权。完整证据固定为 `backend/docs/product_opportunities_v37_schema_presence_audit_20260827T070521Z.json`。

同日 07:11:09 UTC 对 `https://vibepin.co/` 的公开渲染文本复核发现，当前生产首页仍显示 `Opportunity score 94`、`+210% Demand vs last 30 days`、`Low Competition`、静态高保存 Pin / 商品数量，以及伪造的 `Live` 周涨幅。这是当前生产的 P0 数据诚实问题。隔离候选已经不再渲染旧 mock intelligence panels，营销诚实契约也通过，但在候选真正推广并完成线上复核前，不得宣称用户侧旧指标已经退役。当前生产 Web 版本不得作为回滚目标；回滚 SHA 也必须单独证明不包含这些伪造或退役指标。完整证据固定为 `backend/docs/product_opportunities_v37_live_web_truth_audit_20260827T071109Z.json`。

类目准备度的进一步只读拆分显示：`wedding` 有 14 个技术候选，其中 Physical 13、Digital 1；`digital-products` 也同时存在 Digital 7、Physical 7。当前数据没有独立的 `gifts` 或 `jewelry-accessories` 来源类目。这证明“来源类目名直接决定 Product Family”只适用于已经逐对审查的四个组合，不能扩展成通用分类器。Wedding / Celebrations、Gifts、Jewelry / Accessories 仍是 PRD 首发业务类目，但当前自动准入尚未实现它们的完整证据合同，不能宣称已经覆盖。

后续实现必须把获客来源与用户看到的业务分类分开：`source_category` 只记录发现来源；用户侧 Category 必须来自明确审核过的来源映射，或来自商家页可证明的结构化分类。Product Family 仍独立为 Physical / Digital。不得用 Pin 标题、seed keyword 或普通描述猜测 Gifts、Wedding、Jewelry / Accessories，也不得为了让首发类目变绿而把 Wedding 的 Digital 商品强制改成 Physical。正式加入这些类目前，需要固定合法 Category-Family 组合、每日 100 个 Source Pins 内的预算分配、零写 dry-run、精确 ID canary 和独立质量回读。

本地 v63 候选现已完成第一层拆分：每个准入 manifest 必须在 provenance 中独立保存经过审查的 `source_category`，Python 写前校验和数据库 RPC/约束都会验证它与 Product Family 一致；缺失、未知或错配均在写入前拒绝。用户侧 `category` 继续作为单独字段，因此未来选择单标签或多标签都不会抹掉真实获客来源。数据库生命周期守卫现同时把 `source_category` 作为不可改写的采集事实：即使 Fashion 与 Women's Fashion 同属 Physical，也不能在实体建立后把一个来源改写成另一个；其他非来源 provenance 字段仍可按正常审计流程补充。该修改尚未应用到生产。

同日对最近 720 小时 `pin_samples` 做 GET-only 供给池审计，并排除数据库已记录的 492 个 Source Pins 后，Fashion / Women's Fashion / Home Decor / Digital Products / Wedding 各自至少仍可选择 100 个未抓过的 Source Pins；可见候选池分别为 793 / 552 / 1,011 / 1,458 / 565。`gifts` 和 `jewelry-accessories` 独立来源桶均为 0。该结果证明 Wedding 可以进入后续零写 dry-run，但 Gifts 与 Jewelry / Accessories 不能通过给不存在的桶分配额度来伪造覆盖。

不扩大每日 100 个 Source Pins 的建议验证配额为：Fashion 23 / Women's Fashion 18 / Home Decor 24 / Wedding 15 / Digital Products 20。总量仍为 100，Digital 保留 20，Wedding 获得独立样本，Fashion 合计仍有 41。该数字只作为下一阶段 dry-run 候选，不替代生产 36/28/36，也不构成部署许可。Gifts 与 Jewelry / Accessories 先作为商家结构化分类可证明的细分业务标签进行质量统计；在没有稳定证据与样本前不提供对应筛选项。若后续建立独立来源桶，必须重新评估 100 条预算，不得额外叠加请求。

### 19.2.3 2026-08-27 10:22:33 UTC 自动运行前基线

同一 GET-only 审计在永久 Product Supply timer 下一次触发前复跑。除审计时间外，结果与 06:58:54 UTC 报告完全一致：`pin_products=4,115`、旧 snapshots `=34,073`、技术迁移候选 `=123`、已审查自动准入候选 `=25`（Physical 18 / Digital 7），且 25 个候选的 `today/7d/14d/30d/full` 仍全部为 0。该报告只用于精确对比今晚自动运行后的增量，不代表 v3.7 已上线或趋势指标已达标。完整证据固定为 `backend/docs/product_opportunities_v37_production_audit_20260827T102233Z.json`。

### 19.2.4 2026-08-27 10:35:49 UTC Product Supply 触发前复核

永久 Product Supply timer 当前为 enabled + active，下一次真实触发为 `2026-08-27T15:03:44Z`。上一轮 timer 在写入前以 exit 10 拒绝，journal 证明原因是 Pinterest cooldown 只有 91.43 分钟、低于 120 分钟，而不是发生了部分写入。当前只读 preflight 的 cooldown 已达 328.52 分钟，按固定触发时刻预计为 596.38 分钟；真实 VPS 锁均为空、无相关进程、service 本身没有作为 boot target 启用，新的 Admission / Tracking timer 也尚未安装。结论仅为“今晚具备自动尝试条件”，不能提前宣称本次运行通过。完整证据固定为 `backend/docs/product_supply_pretrigger_readiness_20260827T103549Z.json`。

### 19.2.5 2026-08-27 15:03:50 UTC 首次完整自动运行复核

永久 timer 确实自动触发了唯一 service invocation `b0f7bda39ad64aaf8f5e28f9da4c0e5d`，并在 86 分 23 秒后以 service exit 0 自然结束。它完整扫描 100 个 Source Pins，Physical-only 配额仍为 36/28/36；业务漏斗为 937 个原始候选、807 个拒绝、130 个去重前接受、48 个唯一候选、13 次商家页验证、0 个商家验证通过、0 个安全 legacy 写入。数据库运行前后均为 `pin_products=4,115`，排序 ID 校验和均为 `bb72bcd04dfbaef9ffec177b6b8d0dfb`，没有脏写。

这次运行仍然 **BLOCK**，不得宣称首次自动运行通过：第 79 个 Source Pin 触发 120 秒整 Pin 超时，最终报告明确记录 `renderFailureCount=1`、`resultTrust=partial:some_pins_failed_to_render`。严格 `--require-scheduled-run` 审计因此 exit 1，并且该报告不得进入自动 Admission。服务退出后两个真实 VPS 锁均释放、相关进程为 0、内核窗口无 OOM，下一次 timer 已排到 `2026-08-28T15:06:06Z`。完整只读证据固定为 `backend/docs/product_supply_automatic_run_audit_20260828T003013+0800.json`。

后续静态定位确认，该 Pin 为 Home Decor Source Pin `1127518456800539414`，关键词为 `kids room decor ideas`。整 Pin 内部存在多个 Playwright 默认等待，并且旧实现最多串行读取、点击 10 个通用 tab；这些等待的累计预算可以耗尽 120 秒总墙钟。候选 `f93a29a993594605bffed9115119e8210a6bfcf1` 没有提高 120 秒总预算，也没有放宽零渲染失败门禁，而是将可选 DOM 探测分别限制在 5–8 秒、通用 tab 最多处理 4 个，并在报告中保留精确超时阶段。该修复的本地聚焦回归为 264 passed / 35 subtests；仍须由后续永久 timer 自动运行证明 `renderFailureCount=0`，本次 BLOCK 报告本身不得改判。

同一报告还证明当前主要产量瓶颈不是 50 行安全上限，而是商家图证据覆盖：13 个商家候选全部因缺少可证明的商家商品图被拒绝，其中 5 个为 HTTP 403；8 个 Amazon PDP 返回 200，7 个已经能够证明名称来自页面，但旧抽取器仍未读到商品主图。候选 `6839e7609ddff3f1fe288c48a42918e105a75fc9` 仅新增 Amazon 商品页中明确标识的 `landingImage` / `imgBlkFront` 主图证据，优先页面声明的最大尺寸；非 Amazon 同名元素、Pinterest 托管图、Source Pin/卡片图及任意未标识页面图片仍拒绝。完整证据为 `backend/docs/product_supply_merchant_image_gap_20260828T003013+0800.json`；本地全后端为 898 passed / 2 skipped，真实提升仍必须由后续永久 timer 证明。

### 19.3 自动准入候选实现状态

隔离候选已补齐 Product Supply 与 v3.7 之间的自动准入编排，但本节不表示已部署或已启用：

1. 自动准入只消费一份新鲜 Product Supply apply 报告中的精确 inserted IDs，不扫描无界历史数据。
2. 整轮最多 50 行，按 20/20/10 的最大原子批次独立生成 manifest、写入、回读和回滚凭据。
3. 每行仍重新执行 Pinterest Pin 与同一 PDP 的直接关系证明和商家页商品图证明；Product Supply 卡片字段不能升级为 v3.7 证据。
4. 零新行按自然零报告，零 provider 请求、零数据库写入。
5. 候选日程为 23:00 Product Supply、03:15 Admission、06:15 Tracking，按所有外层 timeout 的最坏结束时间保留两段完整 120 分钟冷却。
6. Admission service 和 timer 默认关闭；生产 v63 migration、手动 canary、首次 timer 自动触发和连续运行证据仍是上线前门槛。

### 19.4 2026-08-26 隔离候选验证状态

以下结论只适用于隔离分支候选，不表示已经迁移生产数据库、部署 Web、启用 Admission 或启用 Tracking：

1. Product Supply 新写入行可以按精确 inserted IDs 进入自动准入；新的 Supply 行不依赖已经废弃的 legacy `product_type`，而是只从经过审查的来源类目推导 Physical / Digital 大类。来源类目未知或与声明大类冲突时 fail-closed。
2. 更细的 Product Type 只能来自商家页可证明的结构化字段；Pinterest 标题、seed keyword、Pin 卡片文本和来源类目都不能伪造更细类型。名称仍可为空。
3. 数据库层已补充来源证明、Evidence、Primary Evidence、每日幂等 observation、回撤防御、同族同版本校准和发布门禁；缺少关键证明的直接写入会被拒绝，而不是依赖应用调用方自觉。
4. 数据库层直接约束 Product Opportunity 生命周期：新实体只能从无生命周期时间戳的 `discovered` 开始；允许 `discovered → active/retired`、`active → inactive/retired`、`inactive → active/retired`，拒绝 active 回退 discovered、retired 复活和 retired Evidence 原地复活；状态时间由触发器统一维护。
5. Demand、Trend 和 Fastest Growing 控件按 Physical / Digital 分开开放。每个数据族必须同时满足：至少一个用户可见商品、有效指标覆盖率不低于 70%、质量复核通过、批准时间存在、同族同版本校准已批准且生效。即使比例字段被错误写成 70%，零可见商品也不能开放控件。
6. 用户只有主动点击 Apply 时才记录 Demand / Trend 筛选使用事件；收藏与 Create Pin 保持独立入口和独立副作用。
7. 回滚脚本、发布文件 manifest 和执行 runbook 已纳入自动准入、tracking、metrics、API、UI、analytics、PDP/图片 provenance 及共享 Product Supply core，避免只部署半套功能。
8. Create Pin 只有在持久化草稿或浏览器一次性副本至少一条成功后才跳转并提示成功；两条路径都失败时必须留在当前页面并显示可重试错误，不能进入空白 Studio。
9. Saved Products 的状态与时间由数据库统一维护：首次收藏建立收藏时间，重复收藏不得刷新该历史时间；首次取消收藏建立移除时间，重复取消不得刷新该历史时间；取消后再次收藏才开启新的收藏周期。`saved` 与移除时间并存、`removed` 却没有移除时间，以及倒序时间均由数据库拒绝。调用方提交的伪造时间不能覆盖数据库事实。
10. Saved Products 的写入只能经过执行套餐准入检查的服务端 API。登录用户可读取自己的收藏关系，但不得通过 Supabase/PostgREST 直接插入或修改关系来绕过 Free 固定 10 个的限制；数据库写权限仅授予服务端角色。
11. 用户看到的商品链接必须与稳定 Product Opportunity 身份及其 Pinterest Evidence 指向同一商品：`canonical_product_url`、`external_product_url` 和 Evidence 的外链必须一致，`canonical_url_hash` 必须等于 canonical URL UTF-8 字节的真实 SHA-256。Active 实体不得在原行偷换为另一商品 URL；真实的新商品应保留旧历史并建立新实体。
12. 商家名与商品名相同，属于可选但必须可证明的商家页字段。只有 JSON-LD brand、`og:site_name` 等明确商家页字段及其精确值证明同时存在时才写入；否则 `merchant=NULL`，并继续使用真实 PDP 域名作为 Platform，不得根据 Pin 卡片或域名猜出商家名。
13. Platform/domain 不是可编辑商品字段，必须由 canonical PDP URL 的真实 hostname 确定。数据库拒绝缺失或与商品链接主机名不一致的 domain，避免用可信平台名包装另一条商品链接。
14. Category 搜索同时支持内部稳定分类值和用户看到的自然名称；例如 `womens-fashion` 必须可被 `Women's Fashion` 或 `Womens Fashion` 命中，`digital-products` 必须可被 `Digital Products` 命中。内部 slug 仍不得直接显示给用户。
15. Product Opportunity 为空时必须区分“完整目录尚无合格商品”和“当前筛选没有匹配”，不能声称下一次趋势追踪会新增商品。Saved Products 也必须区分“没有收藏”和“当前商品类型没有匹配”。所有筛选空状态提供返回完整结果的入口。无名称商品的无障碍标签使用“来自某商家/平台的商品详情”描述，不把平台名包装成商品标题。
16. Create Pin handoff 不得复用会把 source category 提升为 opportunity title/keyword 的旧适配行为。`womens-fashion`、`home-decor` 等内部值不得进入 Studio 用户可见上下文；真实名称、商家图和 PDP 必须逐字段原样保持。
17. Product Supply 的一行 canary 与永久 timer 日常运行必须使用两个互斥的审计口径。Canary 仍严格等于一行；当前 Physical-only 日常运行必须证明 100 Pin、36/28/36、整轮写入 0–50、原子批次不超过 20、精确 inserted IDs、零失败和每批红线回读。不得用 canary 的一行上限误判合法日常运行，也不得让 Physical 审计口径接受尚未授权的 Digital 29/22/29/20 候选。
18. Product Supply 的每份原子批次回执都必须独立闭合。有写入 ID 时，必须证明精确 expected/actual IDs、相同回读数量、全部红线通过、明确写入时间边界和精确回滚指令；无写入 ID 时不得携带伪造的写后校验、写入时间或回滚证据。所有批次 ID 的并集必须与整轮顶层 inserted IDs 完全一致，自然零也不能跳过该检查。
19. Saved Products 只表示用户的收藏清单，可用于稍后比较或进入 Create Pin；前端不得用“收藏后追踪”等文案暗示 Save 会启动数据采集。所有 Active Product Opportunities 始终由系统统一追踪，与任何用户是否收藏无关。
20. Product Supply 定时运行验收必须把每个新增商品精确绑定回原始 `pin_samples`：`parent_pin_id`、`source_pin_id`、Pinterest URL、`source_category` 和 seed keyword 必须逐字段一致，且来源类目必须属于该次已批准配额。只验证整轮 100 条的类目总数，不能证明实际写入商品没有串类目。
21. Product Supply 的“首次自动运行通过”必须证明报告来自永久 timer 的精确最新一次 service invocation，而不是仅凭报告内容推断。必须同时核对 timer 仍启用且运行中、最近触发时间与 service 启动时间一致、service 成功退出且由该 timer 触发、唯一 invocation identity、报告生成时间与文件落盘时间均落在该 service 执行窗口内，以及下一次 timer 触发仍在未来。手动或 transient apply 即使数据本身合格，也不得冒充自动首跑。
22. Product Supply 自动运行报告必须同时给出可闭合的业务漏斗：扫描 Source Pins、原始候选、拒绝候选、去重前接受、批内重复、唯一候选、数据库已有/跨批重复、商家页核验尝试/成功/失败、因整轮安全上限跳过、最终安全 legacy 写入，以及商品名称存在/缺失数量。各层算术不闭合时不得宣称数据达标。扫描 100 个 Source Pins 不等于新增 100 个商品；最终写入也只是 discovery feed，不能在 v3.7 Admission 未部署时宣称已新增用户可见 Product Opportunity。
23. 自动 Admission 不得使用弱于 Product Supply 独立审计工具的上游报告门禁。两条路径必须共用同一原子批次回执合同；报告不是 trusted/authenticated、存在页面渲染失败、单批超过 20、精确 ID 回读或回滚证据缺损、存在隐藏 ID/红线失败，或 Supply 漏斗算术不闭合时，Admission 必须在读取候选数据库行和调用 Pinterest/商家页之前拒绝。Admission 自身报告必须保留已验证的上游漏斗，供后续区分 discovery 写入与稳定 Product Opportunity 写入。
24. 自动 Admission 的真实 apply 还必须证明其上游报告来自永久 Product Supply timer 的精确最新一次成功 service invocation，并复用 Product Supply 定时验收的同一来源证明合同。手动或 transient 报告只允许用于有界 dry-run/审计，不得进入自动稳定商品写入。timer 未启用或未运行、最近 service 失败、触发来源或 invocation 不匹配、报告生成/落盘时间不在该次 service 窗口内、报告文件内容与已验证来源不完全一致，或下一次触发无效时，必须在读取候选数据库行和调用 Pinterest/商家页之前拒绝。真实 apply 必须重新核验完整来源和精确报告内容，不得只信任调用方传入的“已验证”标志。Admission 报告必须保留已验证的自动运行来源。

当前隔离候选验证：

```text
release topology = PASS for the local Product-only candidate; functional commit 6839e7609ddff3f1fe288c48a42918e105a75fc9 descends from production remote b22930ebe73847cf35bc44be789414902ae6b599 and remains bounded by the exact 76-artifact Product manifest; the superseded 99efabc whole-tree candidate must not be deployed because it also carries unrelated Usage/Metering production files
backend = full suite PASS; 898 passed, 2 live-credential tests skipped, 77 subtests passed from the clean Product-only committed state
production build = PASS, 70 static pages generated from the Product-only candidate
TypeScript = PASS
Web tests = PASS; 132/132 registry tests passed with zero failures after excluding unrelated Usage/Metering tests
Web dependency security = PASS; clean npm ci installed 417 packages and npm audit --audit-level=low reported 0 known vulnerabilities with Next.js 16.3.3 and the reviewed lockfile
local rendered Product truth = PASS; the built localhost candidate passed the executable Product-truth verifier
release manifest contract = PASS; the current 6839e760 manifest/automation contract passed 23/23
shell wrappers = PASS; ShellCheck 0.11.0 passed the exact 6839e760 Git blobs for cloud_lib, Product Supply, Product Opportunity Admission and Product Tracking, excluding only the intentional dynamic-source SC1091 diagnostic; all six unit blobs and four wrapper blobs match the release-manifest SHA-256 values, and the focused systemd/worker/automation/admission group passed 156/156; exact systemd-analyze verify for the not-yet-installed candidate units remains a deployment-host gate

candidate systemd units = NEEDS VPS EVIDENCE; 2026-08-27T17:10:44Z 的只读检查证明现有 Supply service/timer 可以被 systemd 255 解析，但其 SHA-256 均不等于候选，Admission/Tracking 四个 unit 尚不存在，因此旧 unit 的 verify PASS 不得冒充候选通过。正式安装前必须对六个候选 unit 的精确暂存字节执行 SHA-256 与 systemd-analyze verify；证据为 `backend/docs/product_opportunities_v37_systemd_evidence_gap_20260827T171044Z.json`
local candidate systemd boundary = PASS; 2026-08-27T17:40:00Z 已证明六个 unit 与四个 wrapper 的提交 blob SHA-256 全部等于 6839e760 manifest，四个 wrapper 的精确 LF Git blob 通过 ShellCheck，聚焦自动化测试 156/156；该本地 PASS 不得替代 VPS 的 systemd-analyze，证据为 `backend/docs/product_opportunities_v37_local_systemd_gate_20260827T174000Z.json`
production data readiness = BLOCK; the 2026-08-27T12:10:42Z GET-only pre-Supply audit found 123 technical migration candidates but only 25 in the reviewed automatic-Admission scope (18 Physical / 7 Digital), and all 25 had zero today/G7/G14/G30/full-metric coverage; discovery inventory exists but launch-ready trend intelligence does not
first complete permanent-timer Product Supply attempt = BLOCK; invocation b0f7bda39ad64aaf8f5e28f9da4c0e5d scanned 100/100 and wrote zero dirty rows, but one render failure made resultTrust partial and the strict scheduled audit exited 1; this receipt is ineligible for automatic Admission
daily capacity contract = PASS in candidate code; Product Supply scans 100 Source Pins and may write 0-50 legacy discovery rows across atomic batches of at most 20, while Product Tracking independently covers up to 2,499 unique active Primary Pins and at most 5,000 provider requests per day; 20 is not a per-day Product limit
Web deployment reproducibility = PASS; Vercel installCommand is npm ci, package.json/package-lock.json/vercel.json are one exact release boundary, and deployment must fail review if the lockfile is omitted or dependencies are re-resolved
Vercel candidate deployment = BLOCK; authenticated Vercel CLI read-back proves the latest Ready deployment has entrypoint `.`, exposes no Git/source metadata, and embeds the historical `web/vercel.json@096d921` configuration. This is strong evidence for CLI upload from the `web` working directory, where Root Directory `.` is correct; it must not be changed to `web` merely to match a monorepo assumption because that may create `web/web`. Promotion remains blocked because no immutable build exists for functional candidate 6839e760; that candidate must be uploaded from the exact `web` directory and its build log must prove npm ci, Next.js 16.3.3, TypeScript success and Product routes

2026-08-27T17:05:44Z 的新一轮 Chrome 只读检查再次证明已登录账号中存在 `web` 项目的 Build and Deployment 页面，且目标设置 URL 与页面标题正确；但两次接管既有页面和一次新同会话页面的 DOM 读取均在权威设置值出现前超时。因此 Root Directory 与候选构建日志仍未证明，不能将“页面存在”误报为平台门槛通过。证据：`backend/docs/product_opportunities_v37_vercel_evidence_gap_20260827T170544Z.json`。
2026-08-27T17:36:28Z 使用已认证 Vercel CLI 58.4.0 完成只读回读。进一步读取部署 JSON 后确认：最新部署入口为 `.`，没有 Git/source 字段，内嵌配置与 096d921 时期的 `web/vercel.json` 完全一致，因此现行路径是从 `web` 目录上传的强证据，Root Directory=`.` 不应被改成 `web`。最近 Ready 构建的 npm install/Next.js 16.2.6 只能证明旧部署，不能证明 6839e760；Web promotion 仍为 BLOCK，但所需动作是精确候选 Preview 与日志回读，而不是先改 Root Directory。证据：`backend/docs/product_opportunities_v37_vercel_deployment_mode_20260827T175000Z.json`。
database contract / PGlite transaction checks = PASS
current lifecycle trigger = PASS in an exact PostgreSQL-compatible transaction harness; valid transitions and timestamps passed, invalid rollback and retired reactivation were rejected
exact schema rollback object scan = PASS; 0 v63 relations and 0 v63 functions remained
saved-state PGlite transaction = PASS; forged timestamps normalized, repeated Save/Remove idempotent, resave opened a new interval, rollback leftovers 0
saved-write privilege check = PASS; authenticated SELECT true, authenticated INSERT/UPDATE false, service-role SELECT/INSERT/UPDATE true
product-link identity transaction = PASS; mismatched entity URLs rejected, mismatched Evidence URL rejected, valid identity activated, active link substitution rejected
canonical hash transaction = PASS; forged 64-character hash rejected, exact SHA-256 accepted
merchant provenance transaction = PASS; unproven merchant rejected, NULL accepted, page-proven merchant accepted
platform identity transaction = PASS; missing/forged domain rejected, exact PDP hostname accepted
category/family transaction = PASS; missing, unknown and Physical/Digital-mismatched source buckets rejected, exact Digital Products pair accepted
source category provenance database execution = PASS; v63 migration executed in ephemeral PostgreSQL, missing source and Digital-vs-Physical mismatch both produced zero rows, exact Fashion/Physical source wrote one Active row, same-family Fashion-to-Women's-Fashion source tampering was rejected while an unrelated audit note remained appendable, and full rollback removed Product, Evidence and admission RPC with zero remnants
category labels = PASS; internal slugs remain query values but are never rendered as user-facing category names
category search aliases = PASS; Fashion, Women's Fashion/Womens Fashion, Home Decor and Digital Products natural labels resolve through the catalog search text without changing stored category identity
truthful empty/accessibility copy = PASS; tracking is not described as product discovery and a missing Product Name remains a descriptive product-details label rather than a fabricated title
filtered empty-state distinction = PASS; catalog filters and Saved Product family filters cannot make an existing catalog/history look globally empty, and both states provide a clear recovery action
Create Pin evidence-only handoff = PASS; NULL Product Name remains absent, merchant image/PDP remain exact, known categories become natural labels, and no internal category slug is promoted to a title or keyword
Product Supply receipt contracts = PASS; one-row canary and 0–50-row scheduled execution are mutually exclusive fail-closed audits, with the scheduled authority pinned to the currently deployed Physical 36/28/36 mix
Product Supply timer-origin contract = PASS; scheduled acceptance binds the permanent timer's exact last trigger to one successful service invocation and to the report generation/mtime window, so a manual canary or transient apply cannot impersonate the first automatic run
Product Supply business-funnel contract = PASS; source scan, raw/rejected/unique candidates, duplicates, merchant verification, cap skips, safe legacy writes and optional-name completeness are explicit non-negative counts with closed arithmetic; the receipt does not relabel legacy discovery writes as user-visible stable Product Opportunities
Automatic Admission timer-origin contract = PASS; real apply requires the permanent Product Supply timer's exact latest successful invocation, matching report-time chain and exact report SHA-256 before DB/provider access; the apply entry point revalidates the proof instead of trusting a caller flag, while manual/transient reports remain dry-run/audit-only
Supply-to-Admission shared receipt contract = PASS; automatic Admission uses the same exact atomic receipt authority as the cutover audit, rejects untrusted/render-failed/unsafe/unclosed reports before DB/provider work, and carries the validated upstream funnel into its own report
Product Supply response diagnostics = PASS; response parse error count/samples and product JSON totals remain auditable, while only authentication/render/write/readback/red-line failures block a scheduled receipt; a measured non-JSON or released response body is not fabricated into a failed product row
Product Supply zero/host audit = PASS; natural zero still requires internally consistent atomic receipts, regional pinimg.* and pinterest.* image hosts are rejected by parsed hostname, and an unrelated merchant path containing those words is not falsely rejected
Product Supply atomic receipt closure = PASS; all 8 receipts in the current production report were structurally audited, the one inserted ID matched exact readback and the seven zero-ID receipts contained no phantom write evidence
merchant verification freshness transaction = PASS; older than 24 hours and future beyond 5 minutes rejected by RPC, valid current proof activated, active-row future timestamp update rejected by database trigger
public URL transaction = PASS; loopback/private/internal/credentialed PDP or image URLs rejected, public merchant/CDN domains accepted, rollback helper leftovers 0
optional display-field bounds = PASS; exact 500-character Product Name, 200-character merchant and 160-character Product Type are preserved, while blank or overlong direct writes are rejected; overlong merchant-page labels are omitted rather than truncated and do not disqualify an otherwise real product
observation capture-time transaction = PASS; UTC date mismatch, observations older than 24 hours, future timestamps beyond 5 minutes, observations predating their Evidence, owner direct-table bypasses, and service-role direct writes were rejected; the guarded RPC wrote one current observation and rollback leftovers were 0
Saved Products client boundary = PASS; locked Free records expose no product/image/Evidence/metric payload and browser responses use requiresUpgrade instead of internal lifecycle/access status enums
working tree = clean before this documentation update
```

仍未闭合的生产门槛：

1. 生产 v63 migration、122 行历史候选逐批补证、Web/API 部署和生产回读尚未执行。
2. 当前线上 100-Pin Product Supply 配额仍是 Physical-only（Fashion 36 / Women’s Fashion 28 / Home Decor 36）；它不能被描述为已经供给 Digital。本地发布候选已在不扩大 100-Pin 总预算的前提下改为 Fashion 29 / Women’s Fashion 22 / Home Decor 29 / Digital Products 20，并与自动准入口径一致，但尚未部署。该候选必须单独完成零写 dry-run、精确 ID canary 和明确的部署授权，旧 36/28/36 报告不得被自动准入当作 Digital 首发报告。
3. 新 Demand / Trend 在真实每日 observations 形成并分别达到 70% 质量门槛前必须保持隐藏；不得用旧指标或迁移前 snapshots 填绿。
4. Product Supply 的一行生产 canary 和 23:00 timer 恢复属于 legacy 发现链切换，只能证明该链不会继续写入 Pin 卡片商品字段，不能替代 v3.7 上线验收。
5. 首次完整永久 timer 运行已经发生，但因 1 个 render failure 被严格门禁拒绝；必须先审查根因并由后续自然 timer 运行产生一份零 render failure 的完整报告，才能关闭“首次成功自动 receipt”门槛。不得手工重跑冒充永久 timer 证据。

---

## 20. 最终产品定义

Product Opportunities 不是一个累计 Saves 排行榜，也不是一个把关键词趋势、Pin Saves 和内部评分混成结论的黑箱。

它是：

> 从 Pinterest 发现真实商品，把每个商品绑定到一个可审计的 Primary Evidence Pin，持续保存真实的 Pinterest Save observations，用过去 30 天新增 Saves 表达近期 Demand，用最近 7 天与前 7 天的变化表达 Momentum，并让用户收藏自己关心的机会或直接使用商品创建新的 Pin。

当证据、历史或活动量不足时，系统少展示，而不是制造判断。
