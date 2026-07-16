# VibePin Pinterest Creative Intelligence Layer PRD

**版本：** v0.2（修订版，取代 v0.1 初稿 `docs/根据商品图推荐参考的pinterest图-prd初稿.txt`）
**状态：** Approved for Phase A
**范围：** Create Pins → Generate AI Image Drawer（AiVersionDrawer）、AI Copy、Pinterest Keywords、Reference、Quality Evaluation
**产品原则：** Pinterest-first · Pin-draft-first · Product-aware · Reference-aware · AI on demand

## v0.2 相对 v0.1 的关键修订

1. **补充代码现状对照**：v0.1 把大量已存在的模块写成从零建设；v0.2 全部改写为"对齐/升级现有模块"，避免重复建设。
2. **合规规则升级为硬规则章节**（第 4 章）：正面裁决 pin_samples（Pinterest 爬取素材）的使用边界。
3. **服务端持久化提为 Phase A 硬前置**：不落库则 Phase C/D 的学习与全部成功指标无从谈起（v38 跨浏览器事故的同款教训）。
4. **阶段计划改为 Phase A/B/C/D**，每阶段带验收标准；A 先做"生成图→trend keyword"（现状已接近完成，改动最小），B 做"商品图→推荐参考图"。
5. **大模型方向（原 13 章）冻结为愿景章节**，写死训练触发条件，采纳调研报告《是否训练大模型的report.md》结论：现在不训练。
6. **事件清单从 20+ 砍到 8 个关键事件**先落地。

---

## 1. 背景与现状对照

VibePin 已具备完整 Create Pins 闭环（Upload/Product → Pin Draft → AI Copy/AI Image → Edit → Board → Schedule/Publish）。当前质量问题不是流程缺失，而是：生成图 AI 感/棚拍感重、商品与场景匹配不足、文案偏图片描述而非搜索导向、关键词与商品/方向结合不足、生成后无质量筛选。

**代码现状（2026-07-11 核实）——本 PRD 所有功能需求以此为基线：**

| 能力 | 现状 | 落点 |
|---|---|---|
| 结构化 Prompt Builder + Negative Rules | **已存在**。DIRECTION BRIEF / CATEGORY PLAYBOOK / PRODUCT REQUIREMENTS / STRICTLY AVOID 分区 | `web/src/lib/studio/hiddenPromptBuilder.ts` |
| Creative Directions + Pattern | **有雏形** | `web/src/lib/studio/creativeDirections.ts`、`categoryPlaybooks.ts`、`creativeIntent.ts`、`creativeControls.ts` |
| Style References（参考图输入） | **已存在**。Drawer 内 Style references 条 + 参考影响模式（layout_scene_strong / style_mood_balanced / product_only / none） | `AiVersionDrawer.tsx`、`referenceAnalysis.ts`、`InlineCreateAssetPicker.tsx` |
| Reference 推荐后端 | **已存在**。从 `pin_samples` 取 `is_reference_eligible` 参考图，按 save_count 排序；已有 visual_format / human_presence / composition_type / reference_quality_score 等分类字段 | `web/src/app/api/reference-candidates/route.ts`、`backend/db/migrate_v22.sql` |
| 图片分析 | **已存在**。提取 imageSummary / visibleObjects / colors / style / ocrText / category；上传、Shopify 选品、AI 生成结果走同一链路 | `web/src/lib/ai-copy/visionServer.ts`、`/api/ai-copy/analyze`、`startImageAnalysis.ts` |
| 关键词推荐 | **已存在**。trend_keywords 表 + coverage-led 排序（相关性 0.7 / 归一化搜索量 0.3） | `web/src/lib/ai-copy/keywordContext.ts` |
| Shopify 商品数据 | **已存在**。store_products：title / description_text / product_type / tags[] / vendor / 图片等（无独立 category 字段） | `backend/db/migrate_v39_shopify_store_sync.sql`、`productStore.ts` |

**真实缺口（本 PRD 要解决的）：**

1. 无任何生成结果质量评估/排序（`/api/generate` 只转发 urls）。
2. 无 embedding / 向量检索基础设施（全库无 pgvector 痕迹）。
3. 图片分析结果、recommendedKeywords、参考图选择全在 localStorage（`pinDraftStore.ts`、`assetStore.ts`），违反本 PRD 约束"账号体系服务端持久化"。
4. `lib/analytics.ts` 事件不落库（仅 dev console + CustomEvent）。
5. reference-candidates 不感知商品（不吃 image analysis / 商品元数据）。
6. keywordContext 不吃商品 title/tags/product_type，也不吃已选 creative direction。

---

## 2. 定位与目标

Creative Intelligence Layer 是现有创建流程中的智能决策层，不是新工作区：

```text
Product / Image understanding → Pattern matching → Creative direction
→ Reference + keyword context → Controlled generation → Quality evaluation
→ Pin Draft Card → Publish feedback
```

核心目标：

1. 自动理解上传图片/商品的类别、属性、使用场景（现有 analysis 扩展）。
2. 每个商品推荐 3–5 个 Pinterest 创意方向（现有 creativeDirections 升级）。
3. **根据商品图推荐参考图**（Recommended for this product，Phase B）。
4. **根据图片（含生成图）推荐匹配的 trend keywords**（Phase A）。
5. 方向、参考、关键词、商品信息共同进入 AI Image / AI Copy。
6. 多候选生成 + 质量评估排序（Phase C）。
7. 用户选择/修改/发布行为服务端落库，供后续 ranker 训练（Phase A 起）。

用户感知：不写复杂 Prompt，看到的是 "Recommended for this product" 的方向卡、参考图组和关键词 chips，每项带推荐理由。

### 非目标

- 不重写 Create Pins、不重做 AI Image Drawer 结构、不新增创意工作台；
- 不新建与 `creativeDirections.ts` / `categoryPlaybooks.ts` / `hiddenPromptBuilder.ts` 重复的平行模块；
- 不自动发布未经确认的内容；不把方向选择变成新的 Draft 状态；
- 不展示虚假 Save/Click Potential、Trend Score；
- **现在不训练任何大模型 / LoRA / 微调**（见第 9 章触发条件）。

---

## 3. 目标用户

Shopify / Etsy / WooCommerce sellers、Pinterest creators、affiliate marketers、bloggers、agencies。典型路径：一张普通商品图 → 系统给出适合的 Pinterest 场景方向 + 参考图 + 关键词 → 生成真实生活感的图和文案 → 编辑后排程发布。

---

## 4. 合规硬规则（必须遵守，覆盖所有 Phase）

针对 `pin_samples`（VPS 爬虫抓取的 Pinterest 图片库）与 Pinterest API 数据：

1. **pin_samples 来源的参考图只做"灵感展示"**：UI 必须标注来源为 Pinterest，提供 linkback（source_url / pinterest_url），不得遮蔽来源。
2. **绝不作为生成的图像条件输入**：pin_samples 图片不得作为 style reference 图片喂给图像模型，不得用于生成衍生内容。生成条件参考图仅限：用户上传素材、用户自有/品牌素材、明确授权的素材、用户自己的历史生成结果。
3. **进入 prompt 的只能是派生模式标签**：从 pin_samples 学到的规律以结构化标签形式使用（visual_format、composition_type、human_presence、scene 类型等），不携带原图。
4. 不新增任何 Pinterest 图片永久缓存流程；现存 pin_samples 缓存管线的合规审查作为独立事项跟进，本 PRD 功能不扩大其使用面。
5. 关键词展示遵守数据诚实原则：无依据不标 Trending、不展示未实际使用的关键词、不将英文关键词伪装为本地化关键词。
6. 不展示内部 judge 分数 / chain of thought；不将参考描述为"复制这个 Pin"。

---

## 5. 功能需求（以现有代码为基线的增量）

### 5.1 图片/商品分析（扩展 visionServer）

现有 6 字段基础上按需扩展（Phase B 前完成即可）：`productType`（细粒度）、`useCases[]`、`recommendedSceneTypes[]`、`humanPresenceSuitable`、`packagingText`。分析不阻塞手动编辑 Draft（现状已满足，保持）。Shopify 流程继续走同一链路。

### 5.2 关键词智能（Phase A 核心）

原则不变：**Relevance first, search volume second**。推荐 5–8 个。

增量：

- `keywordContext.ts` 查询输入扩展：现有（imageSummary / visibleObjects / style / category / boardName）之外，加入 **商品 title、tags[]、product_type**（draft 关联商品时）与 **已选 creative direction 的关键词组/场景词**（已选择方向时）。
- 生成图完成后自动分析产出的 recommendedKeywords 在 **生成结果卡片上可见**（chips），不再只藏在 AI Copy panel。
- AI Copy 生成时（`/api/ai-copy`）在已有"概念参考"注入基础上加入 direction 上下文。
- Context used 只显示真实使用的输入（现状原则，保持）。

### 5.3 Reference 推荐（Phase B 核心）

把 `/api/reference-candidates` 从"按类目拉热门"升级为 **product-aware**：

```text
输入：draft 的 image analysis（category/style/colors/visibleObjects）
      + 商品元数据（product_type/tags/title）
→ pin_samples 元数据过滤（category、is_reference_eligible、image_quality_band、watermark）
→ 规则打分：类目匹配 + 场景/风格兼容 + human_presence 适配 + reference_quality_score + save_count
→ 返回 Recommended for this product（每张带推荐理由字段）
```

UI：AiVersionDrawer 的 Style references 区加 "Recommended" 组（升级现有 `StyleReferencePicker` recommended tab 的逻辑）。展示遵守第 4 章硬规则：Pinterest 来源图仅展示+标注+linkback；用户点选后系统提取其**模式标签**进入 prompt（经 `hiddenPromptBuilder` 的 REFERENCE REQUIREMENTS 分区），原图不进生成。

不做 embedding 起步；pgvector 与训练 ranker 属 Phase D。

### 5.4 Creative Direction（对齐升级，Phase B）

不新建模块。在 `creativeDirections.ts` + `categoryPlaybooks.ts` 上补齐结构化字段：Direction name / Why it fits / Scene / Composition / Lighting / Human presence / Pinterest intent / Suggested keywords / Prompt instructions / Negative rules。规则：默认 3–5 个；单选主方向；可编辑、可重新生成；须给推荐理由；方向选择不创建 Draft；选择结果服务端落库（Phase A 的持久化承接）。

### 5.5 Quality Judge（Phase C）

Rubric-based VLM judge（复用 visionServer 基建），评分维度：product preservation / realism / creator likeness / scene fit / Pinterest fit / composition / AI artifacts / safety。行为：生成 N 张（现状上限 4）→ 全部评估 → 排序 → **只隐藏明显无效项，其余按分排序展示**。失败不污染正常 Draft；不训练专用模型；不展示内部分数。

### 5.6 Creator-Style Controls（现状保持+微调）

用户可见简单控制项（Natural creator photo / Product in use / Less AI-looking / More lived-in / Tutorial 等）继续映射为对 direction 与 prompt builder 的结构化调整（`creativeControls.ts` 已承接）。不暴露 CFG / sampler / hidden prompt / judge score。

---

## 6. 数据与持久化（Phase A 硬前置）

原则：所有用户选择和分析结果跟随账号体系服务端持久化；localStorage 仅作缓存/恢复（系统约束，v38 事故教训）。

**v41 迁移（authored-not-applied 惯例，SQL Editor 手工执行；v40 编号已被 user_store_docs 占用）：**

1. Pin draft 服务端模型（v38 建立的表）增加创意智能字段（jsonb 优先，避免宽表）：
   - `image_analysis` jsonb（summary/objects/colors/style/ocr/category/model/updatedAt/status）
   - `recommended_keywords` jsonb
   - `creative_selections` jsonb（selected direction、selected/rejected references、removed keywords 等）
2. `analytics_events` 表：id / workspace_id / user_id / draft_id / event_name / payload jsonb / created_at，按 event_name+created_at 建索引。

**事件埋点 v1（只做这 8 个，服务端落库）：**

`direction_selected`、`direction_rejected`、`reference_selected`、`reference_rejected`、`keyword_removed`、`generation_kept`（含 deleted 对偶）、`regenerate_clicked`、`draft_published`。现有 analysis/ai_copy 事件保留并一并落库。`track()` 改为 fire-and-forget beacon（失败静默，不影响主流程）。

事件关联字段：workspaceId / userId / draftId / productId / directionId / referenceIds / generationId / modelVersion / promptVersion（可空，尽量带）。

---

## 7. 系统约束

1. 不覆盖原始上传图；每张生成结果独立 Pin Draft Card（现状，保持）。
2. Creative Direction 不是 Draft lifecycle。
3. Judge 失败、AI Copy 失败不污染/覆盖已有字段。
4. 服务端持久化为准，localStorage 只是缓存。
5. 不破坏 Upload-first、Pin-draft-first。
6. 不将未验证规律包装成保证表现。

---

## 8. 阶段计划与验收标准

### Phase A — 生成图→trend keyword + 持久化基建（本期执行）

实施：

- A1 `keywordContext.ts` 输入扩展：商品 title/tags/product_type + 已选 direction。
- A2 生成结果卡片可见 keyword chips（≤8）。
- A3 v41 迁移 + draft 分析/关键词/选择 服务端持久化接通（沿 v38 sync 路径）。
- A4 `analytics_events` 落库 + beacon；8 事件接入。

验收：

- 关联 Shopify 商品的 draft，其推荐关键词可反映商品词（可用真实 trend_keywords 数据验证）；
- 生成图完成分析后卡片上出现关键词 chips；无关键词时不显示空壳；
- 换浏览器登录同账号，分析结果与关键词仍在（迁移应用后）；
- 事件写入 analytics_events；beacon 失败不影响任何用户流程；
- 现有测试 + build 通过；不触碰进行中的 support/客服相关未提交文件。

### Phase B — 商品图→推荐参考图（Recommended for this product）

实施：product-aware reference-candidates（规则打分）、Drawer Recommended 组、合规硬规则落地（标注/linkback/派生标签机制）、reference 选择事件落库。

验收：上传商品图后 Drawer 内出现带理由的推荐参考组；选择参考后 prompt 仅包含派生标签；Pinterest 来源图带来源标注与 linkback；选择/拒绝事件落库。

### Phase C — Quality Judge v0

实施：rubric VLM judge、4 候选评分排序、隐藏明显无效、`GenerationEvaluation` 存储。
验收：多候选时优质图排前；无效图不直接展示但可查看；judge 失败时降级为现状行为。

### Phase D — Embedding 检索 + 小 ranker

pgvector、参考图/关键词向量检索、reference ranker / keyword ranker 训练。
**准入条件**（满足其一才启动）：启发式排序的接受率连续多轮迭代不再提升；或已积累数千条 reference/keyword 选择事件。

### 成功指标

产品侧：direction 选择率、推荐 reference 选择率、首次生成保留率、regenerate rate、AI image rejection rate、Less AI-looking 使用率、AI Copy 编辑距离、keyword removal rate、Draft→Schedule/Publish 转化率。
Pinterest 侧（可用时）：impressions、saves、save rate、outbound clicks、direction-level performance。
所有指标以 analytics_events 为数据源——**Phase A 不落库则全部无法统计**。

---

## 9. 大模型方向（冻结的愿景，非排期）

采纳《是否训练大模型的report.md》结论：**现在不训练**。愿景方向保留：Pinterest Multimodal Creative Model、Product-Preserving Image Model（LoRA）、Pinterest Copy Model、Multimodal Quality Model、Personalization Model。

**训练触发条件（全部满足才立项单个窄任务）：**

1. prompt + 检索 + judge 的质量指标已平台期；
2. 某一窄任务（如"beauty product in creator vanity scene"）持续失败且有充足已接受样本；
3. 存在 rights-clean 数据集（不混入 Pinterest 政策模糊内容）；
4. 离线 judge 与线上 publish/save/click 指标结论一致；
5. 能精确定义 eval 目标。
