# 数据侧任务书 v1.1：参考池 + Product 池（取代 v1.0）

> ## ⚠️ 部分内容被 v3.1 校正（2026-07-14）
>
> **本文 §3 Product 数据字段规范 与 T2 任务卡的写后验证/验收标准，已被《Product Opportunity 定位校正 v3.1 20260714.md》（唯一现行版本）定向修订。**
>
> 主要变化：
> - §3 字段规范升级为**两级字段优先级表**：Opportunity Evidence（必须，缺一不得写入）/ Product Details（**Optional enrichment**，抓不到即 NULL，新增 `detail_fetch_status` 四态 + `lifecycle_status`）；
> - **schema 已就位**：**v47 迁移已应用** —— `product_name` 放宽可空 ✅、`detail_fetch_status` ✅、`availability` ✅。"详情字段可 NULL"在 DB 层已真实可行（v48 正在把 `detail_fetch_status` 的 CHECK 约束修正为四态 `available | blocked | not_found | not_attempted`）；
> - T2 验收由"商品图/product_name/price 存在"改为**四红线**（来源真实性 / 不伪造商品 / provenance 分离 / 生命周期），**NULL 视为通过、假数据视为失败**；另加第五条断言：**无 marketplace evaluation 残留**；
> - dry-run 指标拆为 **Discovery success rate** 与 **Detail enrichment rate** 两个数（禁止只报一个"域名成功率"）；
> - **Etsy 不排除**：403 = Detail blocked，不等于 Discovery 失败。Etsy 官方 API = **Future Enhancement，MVP 不立项**，且仅用于 enrichment，绝不用于 discovery；
> - **🔴 Competition 全线删除**（Card / Detail / 排序 / 数据模型 / 验收 / dry-run 报告口径）——属 marketplace evaluation，不属 Pinterest opportunity discovery。**T3 验证条目须同步去掉 Competition**（见 T3 卡内指引）；
> - **T10 处置已定**：**软退役**（`lifecycle_status='retired'`），**硬删除需另行批准**。
>
> **§1 双池用途、§2 双来源与两层准入、§4 任务分级、T1/T3–T10 其余任务卡、§6 全局红线继续全量有效。**

**日期：** 2026-07-13　**状态：** 计划文档（执行冻结）
**取代：** 《数据侧任务书-参考池与三工具数据 v1.0 20260713》——v1.0 的 WS3"爬取端丢弃非 2:3"已确认为错误（会误杀 Product 候选），本版修正。

> **执行冻结声明：本版本仅为任务书。未经逐项批准，不得运行 crawler、不得写库、不得跑 scoring、不得启用任何 timer。** 每项任务标注 P0/P1/P2、开始条件、停止条件、验收结果、写入与回滚方式。

**放行状态（2026-07-13 决策人批复）：**

| 任务 | 状态 |
|---|---|
| T6 关键词手动刷新 | ✅ **已放行**（仅手动 bounded，不开 timer） |
| T4 参考池回填 | ⚠️ **仅试跑阶段放行**：50 张人工校准 + 100 行小批量回填；剩余全量需凭试跑报告二次批准 |
| T1 Outbound dry-run | 业务主线最高优先级；待本 v1.1 修正版正式批准后放行；**T6/T4 不得拖延 T1** |
| 其余（T2/T3/T5/T7/T8/T9） | 未放行 |

---

## 1. 两个数据池的用途（互不混用）

### 参考池（pin_samples 中 is_reference_eligible=true 的子集）
- **用途**：Create Pin 的创意参考图（灵感展示 + 派生模式标签）；
- **关注**：构图、版式、场景、文字覆盖、人物出镜、视觉风格；
- **筛选规则只作用于 eligibility 标志**：≈2:3 比例、质量档、水印、生活场景感等，**只决定该行是否进参考池，绝不在爬取端丢行**；
- **禁止**：不作为 Product Opportunity 的商品数据来源；爬取图不作生成图像输入（PRD v0.2 §4 合规硬规则不变）。

### Product 池（pin_products）
- **用途**：Product Opportunity Finder；
- **硬要求**：必须对应真实商品 + 真实商品详情页链接 + 可追溯的 Pinterest 来源 Pin；
- **关注**：商品图、商品链接、来源 Pin、收藏数、商业信号；
- **明确规则**：参考池的视觉筛选一概不适用——只要 Pin 能关联到真实商品详情页，穿搭图/家居场景图/生活方式图都可进入 Product 池，但**来源 Pin 图片与真实商品图片必须分字段存放**（见 §3）。

---

## 2. Product 池双来源（并存，分工明确）

| 来源 | 角色 | 说明 |
|---|---|---|
| **Shop the Look** | **主来源，负责准确率，保留不动** | Pinterest 已明确建立 Pin↔商品关联，可信度最高；数量可能有限。现有采集与数据一律不修改、不迁移、不停。 |
| **Outbound Link** | **补量来源，负责数量与覆盖率** | Pin 站外跳转到 Shopify/Etsy/品牌官网/其他电商的**具体商品详情页**才可进入候选池。 |

**Outbound Link 准入判定（两层，缺一不可）：**
1. **URL 规则层**：命中商品详情页模式（Shopify `/products/…`、Etsy `/listing/…`、Amazon `/dp/…`、品牌站商品路径等）；
2. **页面验证层**（轻量只读）：og:type=product / schema.org Product 标记 / 价格元素存在，任一满足；防 404、下架、重定向首页。

**拒绝清单（一律不收）**：店铺首页、分类页、collection 页、搜索页、博客、教程、Lookbook、社媒链接、短链无法解析终点者。

---

## 3. Product 数据字段规范（Product Pin 与 Source Pin 不得混用）

> ⚠️ **本节已被 v3.1 §3 字段优先级表校正**：字段分为 A 必须（Opportunity Evidence）/ B 增强（Product Details，**Optional enrichment**）两级；B 级抓不到一律 NULL 且**不阻塞写入**；新增 `detail_fetch_status`（四态 `available | blocked | not_found | not_attempted`）与 `lifecycle_status`。**v47 迁移已应用**（`product_name` 放宽可空、`detail_fetch_status`、`availability` 均已生效；v48 修正 CHECK 约束）。下表的列映射仍然有效，但"哪些字段必需"以 v3.1 §3 为准。

| 字段 | 语义 | 现有列映射（pin_products v5） |
|---|---|---|
| product_url | 商品详情页链接（外部电商） | source_url（沿用，语义=商品页） |
| product_image_url | **真实商品图**（商品页/商品卡的图） | image_url（沿用） |
| product_pin_url | Product Pin 的 Pinterest 链接（Shop the Look 场景才有） | 现有 pinterestPinUrl 拆分后保留此义 |
| source_pin_url | 来源 Pin（生活方式/穿搭图那张）的 Pinterest 链接 | 需从合并字段拆出（三工具 PRD P2-2 已要求） |
| source_pin_image_url | 来源 Pin 的图片 | **缺列，需新增** |
| parent_pin_id | 来源 Pin 的 pin_id（追溯键） | 已有 |
| discovery_method | `shop_the_look` \| `outbound_link` | **缺列，需新增**（回滚与统计的主键维度） |
| merchant_domain | 电商域名 | domain（沿用） |
| product_title | 商品标题 | product_name（沿用） |
| product_saves | Product Pin 自身收藏数（无 Product Pin 则 NULL，不得回填 source 值） | save_count 语义需拆分 |
| source_pin_saves | 来源 Pin 收藏数 | **缺列，需新增** |

- Outbound Link 场景通常**没有 Product Pin**：product_pin_url/product_saves 置 NULL，绝不拿 source 值冒充；
- 迁移文件按惯例 **authored-not-applied**（SQL Editor 人工执行）；**P0 dry-run 阶段不需要任何迁移**。

---

## 4. 任务分级总表

| 级别 | 任务 | 写库 |
|---|---|---|
| **P0** | T1 Outbound Link dry-run（只读） | ❌ |
| **P0** | T2 bounded apply（T1 通过后） | ✅ 小批量 insert-only |
| **P0** | T3 Product Opportunity 页面/详情验证 | ❌ |
| **P1** | T4 参考池元数据回填（业务解耦；仅在主机资源健康且不影响 T1 时并行） | ✅ 仅更新分类字段 |
| **P1** | T5 场景词表 + 详情级抓取改造 + 产出率审计 | 改造后按批准爬 |
| **P1** | T6 trend_keywords 手动刷新（不开 timer） | ✅ bounded 手动 |
| **P1** | **T10 历史 Outbound 脏数据清理（新立项，未放行）**——完成后撤除 T3 的 created_at 临时下限 | ✅ 按行修正 |
| **P2** | T7 P0 五类密度目标（各 300→500）+ 快照重爬纳入节奏 | 按批准 |
| **P2** | T8 Scheduler 启用（最后） | — |
| **P2** | T9 Admin 黄牌清理（retired 标记）/ stock 池另立任务书 | 前端/另册 |

---

## 5. 任务卡

### T1（P0）Outbound Link dry-run —— 只读，不写库
- **开始条件**：本任务书获批准；无需迁移、无需新表。
- **做什么**：扫描 pin_samples 中 outbound_link 非空的行，跑 §2 两层判定，仅生成报告。
- **报告必含**：扫描 Pin 数；含站外链接 Pin 数；判定为具体商品页数量；**URL 规则命中但页面验证失败数量**；Shopify/Etsy/其他电商域名分布；首页/分类页/内容页各拒绝数量；可提取商品标题数量；可提取商品图数量；可提取价格数量；projected inserts；duplicates（对现有 pin_products 按 parent_pin_id+product_url 去重）；existing rows；rejection reasons 分布；**明确声明"本次未写库"**。
- **停止条件**：外部页面验证请求失败率 >30%（说明验证层实现有问题，先修再跑）；或扫描中触发目标站点限流。
- **验收**：报告完整覆盖上述各项；人工抽查 20 条"判定通过"样本，误收率 ≤10%（首页/分类页混入即算误收）。
- **写入/回滚**：无写入，无需回滚。

### T2（P0）bounded apply —— 首次写入

> ⚠️ **本任务卡的"写后验证/验收"已被 v3.1 §9.2 四红线取代**（来源真实性 / 不伪造商品 / provenance 分离 / 生命周期）+ **§9.3 第五条断言（无 marketplace evaluation 残留）**；新流程图见 v3.1 §9.1（写入先于详情增强，详情失败不阻塞）。**开始条件更新**：三个缺列的迁移已由 **v47 应用完毕**（`product_name` 可空 / `detail_fetch_status` / `availability`），不再是待办。下方"约束/回滚方式/停止条件"继续有效。

- **开始条件**：T1 报告经你 review 通过；discovery_method 等三个缺列的迁移已 authored 并在 SQL Editor 应用。
- **约束**：首批 ≤100 行；**insert-only**（不 update、不 delete、不触碰任何 shop_the_look 行）；**不跑 scoring**；每行带 discovery_method='outbound_link' + 本批统一 created_at 窗口。
- **回滚方式**：`DELETE FROM pin_products WHERE discovery_method='outbound_link' AND created_at BETWEEN <批次窗口>`——单条 SQL 可整批撤销，不影响 Shop the Look 数据。
- **写后验证（全过才算通过）**：Product Opportunity 页出现新商品；商品链接全部指向具体商品页；抽查无首页/分类页混入；Product Pin 与 Source Pin 字段正确区分（outbound 行 product_pin 侧为 NULL）；product_saves 与 source_pin_saves 不混用；商品图/分类/来源正确；Admin 数据新鲜度页 Products Added 计数更新。
- **停止条件**：写后验证任一项不过 → 立即整批回滚，修正后重新走 T1。

### T3（P0）Product Opportunity 页面与详情验证

> ⚠️ **本卡的验收对象已被 v3.1 校正**：三工具 PRD §3 / §3.4 已整节失效，**改按 v3.1 §7（Card/Detail 字段）+ §9.2 四红线 + §9.3 断言验证**。
> 具体差异：**不再验证 Competition**（已删除）；Demand/Trend 改名为 **`Pinterest Interest`** / **`Keyword Trend`**；Card badge 应为 **Pinterest Interest / Keyword Trend / Source(Merchant)** 三件套；卡片主图应为 **Source Pin Image**；详情缺失行应显示 **"Product details unavailable" + "View source product"** 且**不隐藏卡片**；Commercial Signal 应为 **`Product Linked` / `Content Only`**。

- **开始条件**：T2 通过。
- **做什么**：按 ~~三工具 PRD §3~~ **v3.1 §7** 验收标准过一遍 Card/Detail（~~Demand/Trend/Competition~~ **Pinterest Interest / Keyword Trend / Source(Merchant)** + 解释句、URL 与 Saves 分行、Not enough data 保护、无 Opportunity/Competition 字样），outbound 来源行在 Source Type 映射为用户语言（"Product link Pin"）。
- **验收**：~~三工具 PRD §3.4 各条~~ **v3.1 §9.2 四红线 + §9.3 第五条断言** + outbound 行显示正确。
- **写入/回滚**：只读验证，无写入。

### T4（P1）参考池元数据回填 —— 分两阶段
**资源说明**：业务逻辑与 Product 池解耦（不爬取、不新增行），但分类运行**占用 CPU、网络（VLM 调用）与数据库资源**——仅在主机资源健康且不影响 T1 执行时并行；T1 需要资源时 T4 让路。

**阶段 A：试跑（已放行）**
- **范围**：① 50 张校准样本（P0 五类分层抽样）——只产出"图片 + 预测标签"校准表供人工核对，**不写库**；② 100 行小批量回填——仅 UPDATE visual_format/human_presence/composition_type/text_overlay_level 四列（quality band 与 eligibility 本阶段不动）。
- **试跑报告必含**：人工标注一致率、单批耗时、VLM 调用次数/成本、错误率、CPU/内存占用观察。
- **验收（阶段 A）**：**人工标注一致率 ≥80%**（allow unknown——模型不确定时输出 unknown 计为合规输出，不强求 High/lifestyle 等任何档位占比）；100 行回填无错误写入。
- **停止条件**：分类器输出异常率 >15%，或运行明显挤占 T1 资源。
- **写入/回滚**：仅 UPDATE 四个分类列；批次 updated_at 窗口可定位；字段幂等可重跑覆盖，无破坏性。

**阶段 B：全量（未放行）**
- **开始条件**：阶段 A 报告经决策人二次批准。
- **范围**：剩余 eligible 池（~1,948 行减去试跑批）全量回填 + quality band 按校准结论调阈值后重打。
- **验收**：P0 五类 visual_format 已知率 ≥80%（unknown 允许存在，计入"已知率"分母但诚实标注比例）。

### T5（P1）场景词表 + 详情级抓取改造 + 产出率审计
- **开始条件**：T4 完成（同一分类器管线先验证过）。
- **做什么**：模式库反推场景词表（每 P0 类目 8-12 原型 × 5-8 变体，≥60 词，词表文件入库）；爬虫进详情页取 title/description/alt；linkback 必填校验；**比例/质量等参考池条件只写 eligibility 标志，不丢行**（v1.0 错误的正式修正点）；抽查 90% 不合格行损耗原因，目标产出率 9.5%→≥20%。
- **验收**：词表覆盖全部原型；新爬批次 title 有效率 ≥60%；产出率报告产出。
- **写入/回滚**：新行 insert；按批次 scraped_at 窗口可清理。

### T6（P1）trend_keywords 手动刷新
- **开始条件**：批准即可（已断更 8 天+，影响线上 Keyword 工具）。**手动 bounded 运行，不开 timer。**
- **验收**：Admin 数据新鲜度页 Trend keywords updated 恢复非零；关键词 last_updated_at 刷新。
- **写入/回滚**：按管线既有 upsert 语义；单次运行日志留存。

### T7（P2）密度目标与快照节奏
- **开始条件**：T5 改造完成且一次 bounded 爬取验证通过。
- **目标**：P0 五类 eligible 各 ≥300（一期）→500（二期）；每场景原型 ≥30；pin_save_snapshots（v37 已存在，07-11 已实跑 153 条）纳入对 eligible 池的轮转回访。
- **验收**：密度达标；快照连续产出 7 天。

### T8（P2）Scheduler 启用 —— 最后一步
- **开始条件（缺一不可）**：dry-run → review → bounded apply → 页面验证 → **同一 job 连续 ≥3 次手动运行稳定**（无卡死、无锁残留、结果符合预期）。
- **顺序**：逐 job 开 timer（**关键词刷新 → 场景词爬取 → 分类 → Outbound Product Harvest → 快照重爬**）；本机 4 个 VibePin 计划任务保持禁用并归档删除；VibePin-Classify-Daily 待 VPS 分类 job 接管后下线。
- **停止条件**：任一 job 开 timer 后首周出现卡死/锁残留 → 关 timer 回手动模式。
- **验收**：Admin 数据新鲜度连续 7 天各计数正常。

### T10（P1，新立项 2026-07-13）历史 Outbound 脏数据清理
**背景（T2/T3 实证发现）**：v27 时期的 `outbound_link_bootstrap` 批（798 行，其中约 448 行进入可见集）存在两类污染，违反 §3 字段规范：
1. **`save_count` 混用**：把来源 Pin 的收藏数抄进了产品侧 `save_count`（抽样 500/500 行全中，最高 54K）——§3 红线明令 Product Saves 与 Source Pin Saves 不得混用；会污染 Product 页 Demand 分位与 Most-saved 排序；
2. **商品图造假**：`image_url` 存的是 pinimg 来源 Pin 生活方式图，不是真实商品图——§1 红线要求商品图与来源 Pin 图分字段且不混。

**当前止血措施（已实施，非终局）**：`/api/products/top` 的 outbound tier 加了 `created_at >= 2026-07-13T14:28:03Z` 临时下限，只放行 T2 干净语料，历史行重新隔离为不可见。**该下限是技术债，本任务完成并抽查通过后必须撤除**（否则未来所有新 outbound 批次都要手动调这个常量）。

- **开始条件**：决策人单独放行（本条尚未放行）。
- **做什么**：
  a. 逐行判定 798 行历史数据的可救性——`source_url` 是否仍为有效商品详情页、能否重新抓取真实商品图与标题/价格；
  b. **可救行**：修正 `image_url`（真商品图）、把误抄的收藏值迁移到 `source_pin_saves`、`save_count` 归位（无 Product Pin 则置 NULL 而非 0）、补 `source_pin_image_url`；
  c. **不可救行**（404/下架/实为分类页）：标记退役或删除（需决策人明确选择哪种）；
  d. 完成后撤除 T3 的 `created_at` 临时下限，并重新跑 T3 六项验证。
- **写入/回滚**：UPDATE 需按行快照（清理前导出全量 798 行原始值到 evidence 文件）；DELETE 需决策人单独授权。
- **验收**：798 行中无 pinimg 商品主图；无 save_count 混用来源值；抽查 30 行商品链接仍有效；撤除时间下限后 T3 六项仍全过；STL 零回归。
- **停止条件**：可救率 <50% 时暂停并重新评估（可能直接退役整批更划算）。

### T9（P2）杂项
- Admin Home 两条遗留黄牌（product_scores 停更 / legacy pipeline deprecated）在 adminOverview 标记 retired 消音；
- Stock（Unsplash/Pexels）/ 用户自有 Pin 回流 / AI 自产参考库：创意参考池专用，**另立任务书**，与本爬虫管线分库分权。

---

## 6. 全局红线（所有任务共用）

1. 本任务书批准 ≠ 执行批准：每个 T 单独放行；
2. Shop the Look 现有采集与数据不否定、不停止、不修改；
3. 任何写入必须可按 discovery_method + 时间窗口整批回滚；
4. 合规不变：linkback 必填、爬取图仅展示+派生标签、不扩大永久图片缓存面、外部商品页验证为只读轻量请求；
5. 算不出的指标显示 Not enough data，绝不编造（三工具 PRD 红线沿用）。
