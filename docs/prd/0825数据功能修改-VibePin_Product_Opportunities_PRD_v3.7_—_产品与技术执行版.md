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
→ active
→ inactive
→ retired
```

含义：

1. `discovered`：已发现，但实体和证据门禁尚未全部完成。
2. `active`：可进入发现页和 Tracking Set。
3. `inactive`：暂不出现在默认发现页，但历史保留，可恢复。
4. `retired`：不再追踪、不出现在用户发现页，历史永久保留。

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
3. 多个 Product Opportunities 共用同一 Primary Pin 时，只请求一次，再把同一个真实 observation 写入各自 Evidence；不得重复消耗请求。
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

---

## 20. 最终产品定义

Product Opportunities 不是一个累计 Saves 排行榜，也不是一个把关键词趋势、Pin Saves 和内部评分混成结论的黑箱。

它是：

> 从 Pinterest 发现真实商品，把每个商品绑定到一个可审计的 Primary Evidence Pin，持续保存真实的 Pinterest Save observations，用过去 30 天新增 Saves 表达近期 Demand，用最近 7 天与前 7 天的变化表达 Momentum，并让用户收藏自己关心的机会或直接使用商品创建新的 Pin。

当证据、历史或活动量不足时，系统少展示，而不是制造判断。
