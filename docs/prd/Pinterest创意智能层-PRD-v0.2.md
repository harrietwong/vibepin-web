# VibePin Pinterest Creative Intelligence Layer PRD

**版本：** v0.3（修订版，取代 v0.1 初稿 `docs/根据商品图推荐参考的pinterest图-prd初稿.txt`）
**状态：** Approved for Phase A；第 4 章合规规则于 2026-07-21 由产品负责人修订（见 §4 变更说明与 §4.4 风险记录）
**范围：** Create Pins → Generate AI Image Drawer（AiVersionDrawer）、AI Copy、Pinterest Keywords、Reference、Quality Evaluation
**产品原则：** Pinterest-first · Pin-draft-first · Product-aware · Reference-aware · AI on demand

## v0.2 相对 v0.1 的关键修订

1. **补充代码现状对照**：v0.1 把大量已存在的模块写成从零建设；v0.2 全部改写为"对齐/升级现有模块"，避免重复建设。
2. **合规规则升级为硬规则章节**（第 4 章）：正面裁决 pin_samples（Pinterest 爬取素材）的使用边界。
3. **服务端持久化提为 Phase A 硬前置**：不落库则 Phase C/D 的学习与全部成功指标无从谈起（v38 跨浏览器事故的同款教训）。
4. **阶段计划改为 Phase A/B/C/D**，每阶段带验收标准；A 先做"生成图→trend keyword"（现状已接近完成，改动最小），B 做"商品图→推荐参考图"。
5. **大模型方向（原 13 章）冻结为愿景章节**，写死训练触发条件，采纳调研报告《是否训练大模型的report.md》结论：现在不训练。
6. **事件清单从 20+ 砍到 8 个关键事件**先落地。

## v0.3 相对 v0.2 的关键修订（2026-07-21）

1. **第 4 章合规规则改写**：解除"pin_samples 原图不得进入生图请求"的限制。用户主动选择的 Pin 图
   现在与 Product images 一同发送给生图模型，角色为 `style_reference`；Product image 角色为 `product`。
   patternTags 降为辅助信号，不再是唯一通道。上限 3 张、不自动选中、保留 Pinterest 来源与 linkback 不变。
2. **新增 §4.2 角色区分强制要求**：生成请求必须显式区分 `role=product` 与 `role=style_reference`。
3. **新增 §4.4 风险与限制**：如实记录规则 6（不复制可识别内容）当前无技术强制手段，以及第三方版权
   素材使用面扩大的事实。该节是风险记录，不是合规结论。
4. **Reference ↔ 生成结果关联成为硬要求**：每张 Reference 独立成 generation group，结果需持久化
   referenceId / referenceImageUrl / referenceSource（详见 `create pin流程变更0721-prd.txt` Section G/G2）。
5. **数量规则**：`totalPins = max(refs,1) × pinsPerReference`，pinsPerReference ∈ {1,2,3}，
   单批上限 9 Pins；group 之间串行调用（受单用户生成锁约束）。
6. **无商品生成不再被禁止**（§4.1 第 7 条修正 + §4.5）：需实测验证后才放开按钮。

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

> **v0.3 变更（2026-07-21，产品决策）**：本章原第 2、3 条禁止 `pin_samples` 原图进入生图请求，
> 只允许派生 patternTags。该限制已由产品负责人明确解除，替换为下列 Pin Style Reference 规则。
> 变更的已知边界见本章末"风险与限制"，未经产品负责人书面确认不得再次收紧或放宽。

针对 `pin_samples`（VPS 爬虫抓取的 Pinterest 图片库）与 Pinterest API 数据：

### 4.1 Pin Style Reference 使用规则

1. **用户明确选择的 pin_samples Pin 图，必须和 Product images 一起发送给生图模型。**
2. Pin 图在请求中的角色必须是 `style_reference`。
3. Product image 的角色必须是 `product`。
4. Pin 图只用于指导场景、构图、氛围、色彩关系、商品展示方式和 Pinterest 版式。
5. Pin 图绝不能作为 product、content reference、商品主体或需要复刻的内容条件。
6. 生成结果不得复制 Pin 图中的具体商品、人物身份、品牌标识、文字、水印或其他可识别内容。
7. **当存在 Product image 时**，Product image 始终是生成结果中的商品主体和事实来源。
   没有 Product image 时，若当前模型支持 prompt-only / style-reference-only，
   可基于 prompt + style_reference 生成。**不得理解为所有 Style Reference 生成都
   强制要求存在 Product image。** 无商品生成的开关必须经实测验证（见 §4.5）。
8. patternTags 可以继续作为辅助 prompt 信号，但不能代替用户选择的 Pin 原图。
9. 系统不得自动选择推荐 Pin，必须由用户主动选择。
10. 最多选择 3 张 Pin Style References；每张 Reference 生成 1–3 张，单批上限
    3 References × 3 Pins = 9 Pins。
11. UI 继续显示 Pinterest 来源和原 Pin linkback，不得遮蔽来源。

### 4.5 无商品生成的放开条件

`AiVersionDrawer` 的 Generate 按钮当前为 `disabled={productUrls.length === 0}`。
放开该限制必须满足：

1. Commit 3 实测当前模型（gemini_image / gpt_image）在无 product_images、
   仅 prompt（可选 style_ref）条件下是否真能返回图片；
2. 实测通过才放开按钮，且 Creative direction 不得为空；
3. 实测不通过则保持禁用，并在本节记录实测结论与限制，不得凭假设放开；
4. 不得为此新增模型或新建生成系统。

### 4.2 生成请求的角色区分（强制）

生成请求必须显式区分两类图像输入，不允许合并成一个无角色的图片数组：

```text
image_inputs:
  - role=product     真实商品主体，需要在生成结果中保留
  - role=reference   Pin 灵感图，只指导场景、构图和风格
```

线上 wire 值说明：`/api/generate` 现有实现对风格参考发出的 role 值是 `reference`
（见 `buildImageInputs`）；`style_reference` 是客户端选择状态的角色名。不要在
wire 上引入第二套词汇。

**已知服务端限制（Commit 2 必须解决）**：`/api/generate` 当前忽略客户端传入的
`body.image_inputs`，改由 `product_images` + 单个 `style_ref` 字符串重建，
因此单次请求只能携带一张参考图。多张 Reference 必须拆成多个 group 串行请求，
且 `/api/generate` 持有单用户 `active-generation` 锁，并发第二次调用返回 429。

### 4.3 其余合规规则（不变）

12. 不新增任何 Pinterest 图片永久缓存流程；现存 pin_samples 缓存管线的合规审查作为独立事项跟进。
13. 关键词展示遵守数据诚实原则：无依据不标 Trending、不展示未实际使用的关键词、不将英文关键词伪装为本地化关键词。
14. 不展示内部 judge 分数 / chain of thought；不将参考描述为"复制这个 Pin"。

### 4.4 风险与限制（如实记录，非免责声明）

以下为 v0.3 变更引入的已知问题，工程实现无法消除，记录在此避免后续被误读为"已通过合规评估"：

1. **规则 6 目前没有技术强制手段。** 生成结果"不得复制具体商品、人物身份、品牌标识、文字、水印"依赖
   prompt 层指令与 `role=style_reference` 语义提示，不是对模型输出的硬约束。以参考图作条件的图像模型
   确实会复现参考图中的可识别元素（reference strength 越高越明显）。当前管线**没有**对输出做
   相似度检测、人脸/商标识别或水印检测。规则 6 应被理解为产品意图，而非已实现的保证。
2. **本次变更扩大了第三方版权素材的使用面。** `pin_samples` 是爬取的第三方 Pinterest 图片，
   常含可识别人物与品牌标识。将其作为生图条件产出用户的商业发布物，与"展示并标注来源"是
   不同性质的使用；linkback 与来源角标缓解的是展示侧主张，不覆盖衍生作品主张。且产物通常
   被用户发布回 Pinterest——即素材的来源平台。
3. **建议法务复核后再上生产。** 本 PRD 记录的是产品决策，不构成合规结论。Preview/QA 阶段不受影响。
4. 若后续引入输出侧检测（近重复检测、商标/人脸过滤），应回到本章补充为规则 6 的强制手段。

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
