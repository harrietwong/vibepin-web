# PRD v1.0：AI 短视频引流 + 独立站铺货（一人企业）

- 状态：草案 / 未实施全自动闭环
- 日期：2026-09-11
- Owner：独立站铺货（发布走 VibePin，本仓 `D:\代码\Pinterest flow`）
- 优先级：P0 每天 40 条候选报告 → 人审选出 30 条上架发布
- 技能根目录：`D:\代码\shopify\Skills`（全部 skill 已迁到此处，禁止再写旧 `创业工作台/Skills` 路径）
- 2026-09-11 用户裁定：保留去重且不改；识货不要先走 Pinterest 反查；货源价格无下限；独立站售价 $25–$80；利润 >50%；每天报告 40 条，从中选 30 条上架；类目含美妆个护；Shopify Admin API 可建品；FastMoss 可登录；去重产能够用；Pinterest / Ins 都走 VibePin。

**上游证据**

- [0910 选品与流水线](../0910-高互动视频商品选品与自动化流水线.md)
- [0910 Pinterest 视频发布成功方案](../0910-Pinterest视频Pin发布成功方案.md)
- [0910 高评 Pin 采集](../../output/pin-comment-harvest-20260910/candidates.jsonl)（A 级 32 / B 级 30）
- [0910 跨平台博主溯源](../0910-高评商品视频跨平台博主溯源.md)
- [0910 交接](../coordination/2026-09-10-高评视频选品交接.md)
- Accio 建议 + `D:\代码\shopify\创业工作台\2026_AI自动化铺货项目PRD.md`（v1.1，已归档）

**对标账号**：[emogetshop](https://de.pinterest.com/emogetshop/)（department store，兴趣板轮转日更，10–18 秒商品演示）

---

## 1. 问题与目标

### 1.1 要解决什么

一人把「看到 Ins/TK/Pinterest 爆款演示视频 → 找到可上的货 → 独立站上架 → 每天发视频引流」做成可重复流程。当前人力瓶颈在选品判断、识货、成片合规、发布调度，不在再写一份愿景。

### 1.2 成功标准（90 天）

| 阶段 | 周期 | 必须发生的事 | 数字门槛 |
|---|---|---|---|
| V0 已完成 | 2026-09-10 | Pinterest 视频 Pin 生产发布通；高评圈测绘完成 | 1 条 201 成功 Pin；62 条候选 |
| V1 | 第 1 周 | 发现 + 识货 + 日报告 + 人审 + 去重 + Shopify 上架 + VibePin 发布 | **每天报告 40 条**；人审选出 **30 条上架并发布** |
| V2 | 第 2–4 周 | 人只点「要/不要」和「就是这个货」；评论回链、SEO 热词 | 连续 7 天：报告 40 / 上架 30；48h 零互动 SKU 停推 |

日报告 40 条配比（候选池，不是最终上架数）：15 家居 + 10 宠物 + 10 美妆个护 + 5 健康硬件。最终 30 条由人从这 40 条里选。

### 1.3 非目标（明确不做）

- 不做保健品/补剂（「吃进去」的货）。健康赛道只做可穿戴/可使用的硬件。美妆个护做妆、肤、工具、个护，不做口服。
- 不把未授权素材送进 VibePin / Gemini 生成库（铺货成片走去重目录，和 VibePin 生成库分开）。
- 不编造 FastMoss 数据；账号可登录，登录后用真数据。
- 识货**不要一上来走 Pinterest 反查**。Pinterest 是发布渠道（走 VibePin），以及识货链最末的可选兜底。
- 不改、不删现有去重流水线（`D:\代码\shopify\Skills\视频去重流水线`）。

---

## 2. 证据摘要（写需求前必须承认的事实）

**已证实**

- Pinterest 高评商品视频几乎全是独立站，$8–40 家居小物，评论在问 Where to buy / Link。62 条里 37 条是 2026-08 新发。这是发现侧观察，**不是**独立站售价下限。
- 发现效率：种子相似流 ≫ 关键词搜索（51/62 vs 11/62）。
- 发布：`cover_image_key_frame_time: 1` + DB 解密 token → 201。静态 env token 已 401。禁止体外 refresh。Pinterest / Ins 发布都走本仓 VibePin。
- 对标号按兴趣板切，不按 SKU 砸同一个板。
- 识货目标是 **英文产品信息 / 描述 / 详情图**，不要求原购买页。顺序：**本机 Google 镜头网页 → 本机 Amazon 以图搜网页 → 最后 1688**。禁止在数据中心爬 Lens；付费 API 不是默认。
- 跨平台同源博主目前钉死：TikTok `@doorslidefold`、Instagram/TikTok `@mavigadget`。多数高评 Pin 是店家广告片，不是 KOL 原创库。
- FastMoss 账号可登录；Lens 自动化被验证码拦。
- Shopify Admin API 可建品。去重日产能撑得住发布时间窗。

**Accio 建议中采纳的**

- 类目：居家黑科技 / 智能健康硬件 / 宠物周边；本 PRD 再加 **美妆个护**。
- 物流 <1kg；货源 4.5 星且近期带图评 ≥50。
- 监测评论购买意向，而不是只看播放。
- 上架时写 Pinterest SEO 标题/描述/alt。
- Amazon / AliExpress / 其他独立站同款比价后若无法做到售价 $25–$80 且利润 >50% 则丢弃。
- 自己的成片加水印；评论「where to buy」自动回独立站链接（V2）。

**Accio 建议中按用户裁定改写的**

| Accio / 初稿 | 本 PRD |
|---|---|
| 视频去重流水线 | **保留**，调用 `D:\代码\shopify\Skills\视频去重流水线`，不改其处理逻辑 |
| Google Lens 网页爬取当主链 | **数据中心爬网页否决**。默认：**本机浏览器打开 Google 镜头网页**（截图/抽帧上传）。付费 SerpAPI 只在本机也被墙、且你愿意付钱时才用 |
| 定价 $19.99–$59.99；货源也卡售价带 | **货源无下限**；**独立站 ≥$25、不设上限**；**利润 >50%** |
| 日更后期才到 30 | **每天报告 40 条，人审选 30 条上架发布** |
| Ins 后期再接、与 VibePin 拆开 | **现在就走 VibePin**（Pinterest 方案也在本仓） |

---

## 3. 类目与日报配比

<a id="req-cat"></a>

| 权重 | 类目 | 对应 Accio / 图中勾选 | 收什么 | 不收什么 | 日报 40 条 |
|---|---|---|---|---|---|
| P0 | 居家与生活黑科技 | 居家日用、厨房、五金、家电 | Problem-solver：收纳、清洁对比、小工具、厨房 gadget、**沙发/织物修复套装**、**园艺工具、户外廊架** | 大家电、改水电安装工程、纯装饰无功能、品牌油漆/脱漆剂 | 15 |
| P1 | 宠物周边 | 宠物用品 | 喂食/饮水/逗猫狗、可演示的小物 | 处方粮、活体 | 10 |
| P1 | 美妆个护 | 新增 | 妆、肤、工具、个护；**磨脚/去角质打磨仪**、编发器、洁面仪 | 口服补剂、医疗宣称、处方药妆 | 10 |
| P1 | 智能健康硬件 | 保健、运动户外 | 筋膜枪、姿态纠正、按摩仪、助眠灯等**穿戴/使用** | 补剂、减肥药、医疗宣称 | 5 |

人从 40 条里选出 30 条上架。上架后的类目不必严守 15/10/10/5，但日报必须按上表凑满 40。

Pinterest 发帖必须落到兴趣板，不要新建「SKU-日期」板。建议板：Home, Kitchen, Bedroom, Beauty, Baby, Decorate, Outdoor, Garden, Pet, Health。圣诞季临时加 Christmas。第一批少往纯 Tool 板砸。

### 3.1 受众与品类经验 `REQ-AUDIENCE`

Pinterest 主力是 **25–45 岁女性**，爱收藏「我想住进这个家 / 我想成为这样」。不是 TikTok 整蛊，也不是五金店车间。2026-09-11 对 50 条高评视频的裁定如下。

**不要（直接丢）**

1. 纯 DIY 教程、Dollar Tree 材料包、只教你做没有一件可邮成品。
2. 合集/小黄车一条视频好几个货，拆不清就不进。
3. 低俗整蛊：便便茶漏、马桶杯、便便提盖。
4. 品牌乳胶漆、木器脱漆剂、漂白粉、车间木家具打磨（砂纸机翻新整桌那种）。
5. 改水电安装工程。免打孔租房方案（折叠门/门帘）可以留一款测。
6. 同一 SKU 多条视频只留评论最高一条。
7. 截帧不是商品本体的，禁止拿去识图。

**要（优先，可测）**

1. 家的即时变美：床品、抱枕、床垫罩、壁灯、氛围灯、收纳、免打孔门。
2. 手部 3 秒看懂的清洁/厨房小工具，画面要能进 Home/Kitchen 板。磁力擦窗这类痛点对比，留。
3. 美妆个护工具：编发器、洁面仪、**磨脚/去角质打磨仪**。不是口服补剂。
4. **沙发/织物/皮革修复套装**：开箱即用的成品套装，可以测。不是「教你整屋翻新」的教程。
5. **园艺工具、花园场景、户外廊架**：可以进 Outdoor/Garden 板。售价不设上限，日报写运费。
6. 母婴浴室：浴椅、浴架。
7. 可爱但不脏的礼物/软装。
8. 售价 ≥$25、不设上限；利润 >50%。床品和大件可以。

**发 Pin 再滤一层**

1. 问：会不会被存进卧室/厨房/花园/婚礼/宝宝房？不会就丢掉。
2. 标题用第一人称欲望句，不要车间术语和折扣堆砌。

---

## 4. 筛选红线

### 4.1 选品 `REQ-PRODUCT`

必须同时满足：

1. **货源/竞品原价没有下限。** 1688 几块钱也可以，只要独立站卖得出去。
2. **独立站售价不低于 $25，不设上限。** 床垫罩、抱枕、花洒、门、登山杖、**廊架、园艺工具**都可以进。
3. **利润 >50%。** `(独立站售价 − 货源到岸成本) / 独立站售价 > 0.50`。到岸成本 = 1688/货源价 + 预估国际运费 + 平台/支付损耗预估。
4. **定价锚点**：可比 TikTok Shop 同款**略高**，对齐其他独立站常见价，不要按 TK Shop 最低价死跟。仍必须 ≥$25 且利润 >50%。
5. 重量 **≤1kg** 为默认；**床上用品、门、花洒、廊架、大件园艺**允许超过 1kg，日报写预估运费。
6. 1688 或 AliExpress：**≥4.5 星**，近 90 天带图评价 **≥50**。
7. 3 秒能看懂功能；有前后对比或 wow 操作。
8. 能挂**自己的独立站产品页**，不是只能挂 Amazon 联盟。
9. FastMoss：登录后只用**增长期**（创作者/视频数环比升、GMV 未平台）。没有数据就写「无」，不编造。

丢弃：Etsy 数字食谱、`#AD` 导流口服保健品、无实物氛围片、服装 lookbook、无外链 UGC、纯 DIY 教程、低俗整蛊、品牌漆/脱漆剂。

海外同款（含其他独立站）售价已压到我方无法同时满足 ≥$25 和利润 >50% → **放弃**。

### 4.2 选视频 `REQ-VIDEO`（发现用，不是发布用）

发现层（别人的片，只作选品情报）：

1. 前 3 秒有视觉奇观或痛点。
2. 分辨率 ≥720p（能看清商品）。
3. 评论里出现购买信号：`where to buy` / `link` / `need this` / `how much`。Pinterest 代理指标：评论 **≥50** 进 B 级，**≥100** 进 A 级。
4. 时长偏好 **8–25 秒**（对标 emoget 10–18 秒）。
5. 无中文字幕硬烧、无他人零售品牌大 Logo（发现时可记录，发布时必须去掉）。

发布层：原始片进 `D:\代码\社媒\视频原始\`，经现有去重流水线后进 `D:\代码\社媒\视频去重后\`，再经 VibePin 发 Pinterest（主）和 Ins。去重逻辑沿用 skill，本 PRD 不改参数。可加独立站水印（不挡商品）。

---

## 5. 系统流程（目标：每天报告 40 → 上架 30）

```
TK / Ins / 抖音 / FastMoss 发现 → 购买意向判定
    → 识货（自带链抽 listing → 本机 Google 镜头网页 → 本机 Amazon 网页以图搜 → 最后 1688）
    → 独立站售价 $25–$80 且利润 >50%
    → 日报告 40 条（视频来源 / 原始商品 link / 1688 货源 / 建议售价）
    → 人审选出 30 条「要 + 就是这个货」
    → Shopify Admin API 上架 ∥ 视频去重
    → VibePin 发 Pinterest 30 条（主）+ Ins
    → 48h 回收 + 评论回链（V2）
```

Pinterest 相似流只用来**扩发现**（已经跑通的采集脚本可继续用），**不要用来做识货第一步**。

### 模块 A — 发现 `REQ-DISC`

**输入源（发现视频，按默认顺序）**

1. TikTok：`@mavigadget`、FastMoss 增长期创作者、关键词。
2. Instagram：`@mavigadget` Reels、Explore。
3. 抖音：同款演示。
4. FastMoss：登录使用真数据。
5. Pinterest 相似流 / 视频搜索：仅作补充发现，**不参与识货排序**。

**触发**：评论购买信号过线，或 Pinterest A/B 级。存储：`products.json` 一行一个候选，状态 `discovered`。

人审交互必须是每条 **要 / 不要** 两按钮（项目惯例），未点不要默认要。日报 40 条全部进审；只有点「要」的进入上架 30 配额（超过 30 时按人点的顺序截断，或等人指定）。

### 模块 B — 识货 `REQ-SOURCE`

要的是 **标题、描述、产品详情图**。没有原购买页也没关系。顺序固定，命中即停。**不要爬 Google Lens / Bing / Yandex 网页**（数据中心 IP 必被墙）。**1688 是最后一档，前面都失败才用。**

1. 视频/主页自带独立站、TK Shop、Ins 商品页：直接抽 title / description / 详情图。有就停。
2. ffmpeg 抽 1–3 帧（或视频截图）→ **本机打开 Google 智能镜头网页**（`lens.google.com` / 图片搜索上传）。不要走付费 API，也不要让 WorkBuddy 在数据中心 IP 上爬。裁到商品本体，避开猫/手/人脸。从「完全匹配 / 外观匹配 / 购物」收英文标题、描述入口、详情图。
3. Google 网页空结果或被墙 → **本机 Amazon 以图搜网页**（搜索框相机 / StyleSnap）。收回 ASIN 后再打开商品页抽 bullet / 描述 / 详情图。
4. 以上都没有可用产品信息，才允许 **1688 `image_search`**（`C:\Users\44740\.codex\skills\1688-product-find`，AK 已配置）。写入 `source_fallback=1688`。

Pinterest 封面反查不进自动主链。

输出：至少 1 套「标题 + 描述 + ≥3 张详情图」；人点「就是这个」。独立站建议售价 $25–$80，利润 >50%。1688 链接只在第 4 步或算成本时才需要。

### 模块 C — 成片 / 去重 `REQ-CREATIVE`

沿用现有 skill，**不改去重算法与参数**：

- 入口：`D:\代码\shopify\Skills\视频去重流水线`
- 处理：镜像、1.1x 缩放裁剪、对比度偏移、1.05x 变速、动态 FPS（以 skill 内脚本为准）
- 输入：`D:\代码\社媒\视频原始\`
- 输出：`D:\代码\社媒\视频去重后\`
- 可选：独立站水印；V2 加英文配音

人审选出 30 条后再去重。机器耗时已确认撑得住发布时间窗。

### 模块 D — 独立站 `REQ-STORE`

- 平台：Shopify。**用 Admin API 建品**（已确认可用，不走「先手动 + CSV」）。
- 从货源抽主图、标题、属性；英文 listing。
- 售价：在 $25–$80 内取心理价（.99）；可高于 TK Shop 同款，对齐其他独立站；利润必须 >50%。
- 每品一个产品 URL，UTM：`utm_source=pinterest&utm_medium=video_pin&utm_campaign={sku}`。
- 映射表 `products.json`：`video_intel_id` ↔ `shopify_product_id` ↔ `shopify_url` ↔ `1688_source` ↔ `pin_id`。

上架 skill 从 `D:\代码\shopify\Skills` 取；必须经过人审货源，禁止把错误同款直接铺进店。

### 模块 E — 分发 `REQ-DIST`

发布通道：**走 VibePin（本仓 `D:\代码\Pinterest flow`）**，不要另写一套生产发布器。Pinterest 已验证方案与 Ins Multichannel 接入都在这个项目里。

**Pinterest（主转化）**

- API v5 五步：register media → S3 → poll succeeded → `POST /pins` 且 `media_source.source_type=video_id` + `cover_image_key_frame_time`。
- Token：`pinterest_connections` 解密。Host：`api.pinterest.com`。
- 标题：第一人称欲望句 + 功能词（SEO）。描述：场景长尾词 + 不堆折扣。Alt：英文功能句。
- 调度：人审通过的 **30 条**按兴趣板轮转；7:00–22:00 间隔 ≥20 分钟；同 SKU ≤2 个角度；单板当日 2–3 条。
- Google Trends 热词：V2 自动填；V1 人写 3 个搜索词即可。

**Instagram（V1 就接）**

- 走 VibePin Multichannel 已有 Instagram 连接，不另开官方 API 项目。
- 视觉钩子 + 评论 Link；V2 才自动回独立站。注意平台禁止评论区垃圾链接，回复必须像客服一句 + 链接，限购买意向评论。

**硬门槛**：每天报告 40 条；每天上架并发布 30 条。按兴趣板轮转，不要砸同一个板。

### 模块 F — 回收 `REQ-LOOP`

- 48h 保存=0 且出站=0 → 停推该 SKU。
- V2：评论文案含 buy/link/where → AI 回独立站 URL。
- 不自动删 Pin，除非违规。

### 模块 G — 每日报告 `REQ-REPORT`

每天固定给 40 条，供人从中选 30 条。每条至少包含：

| 字段 | 说明 |
|---|---|
| `video_source` | 平台 + 创作者 + 视频 URL（TK / Ins / 抖音 / FastMoss / 补充发现的 Pin） |
| `listing_source` | 产品信息来自哪：自带链 / google_lens / amazon_visual / 1688 |
| `listing_url` | 用来抽标题、描述、详情图的页面（Amazon / 独立站 / 其他）。没有原购买页就写识图命中的 listing |
| `title_en` / `description_en` / `detail_images[]` | 英文标题、描述、详情图。这三样是识货必达 |
| `1688_source` | 仅第 4 步或算成本时才填 |
| `tk_shop_price` | 若有 TK Shop 标价，记下来作锚 |
| `peer_dtc_price` | 其他独立站同款可见价（有则写） |
| `proposed_store_price` | 建议独立站售价，$25–$80 |
| `profit_margin` | `(售价 − 到岸成本) / 售价`，必须 >50% |
| `category` | 家居 / 宠物 / 美妆个护 / 健康硬件 |

没有 `video_source`、`title_en`、`description_en`、`detail_images`、`proposed_store_price` 的行不得计入 40 条。`1688_source` 不是日报准入条件。

---

## 6. 数据与目录

| 路径 | 用途 |
|---|---|
| `D:\代码\Pinterest flow\` | VibePin 本仓；Pinterest / Ins 发布都走这里 |
| `D:\代码\Pinterest flow\output\pin-comment-harvest-20260910\` | 已有 Pinterest 候选 |
| `D:\代码\Pinterest flow\scripts\pin_comment_harvest.py` | 已有发现脚本 |
| `D:\代码\Pinterest flow\tmp\pinterest-video-test\publish_video_pin.py` | 已验证 Pinterest 发布配方 |
| `D:\代码\社媒\视频原始\` | 采集到的原片 |
| `D:\代码\社媒\视频去重后\` | 去重后可发 |
| `D:\代码\shopify\products.json` | 映射表 |
| `D:\代码\shopify\Skills\` | 全部 skill（去重、文案等） |

`products.json` 最小字段：`id, category, status, video_source, original_product_link, source_platform, source_url, comment_count, buy_intent, shopify_url, 1688_source, cost_cents, tk_shop_price_cents, peer_dtc_price_cents, price_cents, profit_margin, weight_g, pin_ids[], created_at`。

---

## 7. 验收

### V1（第 1 周）必过

1. 连续至少 1 天交出 **40 条**完整日报（含视频来源、原始商品 link、1688 货源、建议售价、利润）。
2. 人审选出 **30 条**后，Shopify Admin API 建品成功，售价均在 **$25–$80**，利润均 **>50%**。
3. 30 条经去重后由 **VibePin** 发到 Pinterest（201 + `creative_type=VIDEO`）；Ins 至少打通同一批里的可发子集。
4. 货源匹配来自自带链或 1688/Amazon/AE，**不是**先 Pinterest 反查出来的。
5. 去重 skill 未被改参数；调用路径是 `D:\代码\shopify\Skills\视频去重流水线`。

---

## 8. 已关闭的问题（2026-09-11）

1. Shopify Admin API 建品：**可以用**，V1 就走 API。
2. FastMoss：**一直可以登录**，发现模块按已登录处理。
3. 去重耗时：**撑得住**发布时间窗。
4. Ins / Pinterest：**现在就走 VibePin**（本仓已接入 Multichannel；Pinterest 方案也在本仓）。铺货业务和 VibePin 产品功能仍分开记账，但发布实现复用本仓，不另起炉灶。

---

## 9. 给实施 Agent 的执行顺序

1. **不要改** `D:\代码\shopify\Skills\视频去重流水线`。其他 skill 也只从 `D:\代码\shopify\Skills` 读取。
2. `products.json` + 人审页 + **每日 40 条报告**（视频来源 / 原始商品 link / 1688 / 建议售价 / 利润）。
3. 发现优先 TK/Ins/抖音/FastMoss（可登录）。
4. 识货：自带 listing → **本机 Google 镜头网页** → **本机 Amazon 网页以图搜**。**都不行才 1688**。WorkBuddy 不许在数据中心爬 Lens。
5. 货源价格不设下限；独立站售价过滤 $25–$80；利润 >50%；定价可高于 TK Shop、对齐其他独立站。
6. 人审选出 30 条 → Shopify Admin API 建品 → 去重 → **VibePin 发 Pinterest + Ins**。
7. 评论回链和水印放在上架发布跑通之后。
