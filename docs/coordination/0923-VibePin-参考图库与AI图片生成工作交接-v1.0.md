# VibePin 参考图库与 AI 图片生成工作交接 v1.0

> 交接日期：2026-09-23  
> 范围：Pinterest 参考图采集、筛选、用户审核、标注、推荐/后台参考、Gemini 图片生成、结果验收，以及相关 Studio AI 入口  
> 当前结论：需求和本地验证产物较完整，但没有形成可直接部署的一条干净代码线；实体类目稳定性实验仍在独立工作树，最新用户审核决定尚未全部固化。

## 1. 一句话现状

当前工作已经完成“方案定义 + 多轮本地采集/标注/生成试验 + 部分 Fable 审查 + 全流程 PRD”，但尚未完成“最新用户决定回写 → 所有类目连续两轮稳定生成 → 代码独立审查与合并 → Preview 验收 → 生产部署”。

## 2. 本轮实际处理范围与责任边界

- 本轮直接整理和更新的核心文档是：`D:\代码\Pinterest flow\docs\prd\0918-VibePin-参考图库标注与社媒图片生成全流程PRD-v1.0.md`。
- 文件名保留 v1.0，正文版本已更新为 v1.2，目的是避免产生重复副本。
- 该 PRD 已与 Studio 主 PRD 的最新交互规则对齐，包括图片卡片 AI 入口、视频卡片边界、共享 AI 抽屉、Draft/History 服务端真相和恢复逻辑。
- 本轮没有修改业务代码、没有提交 Git、没有推送远端、没有部署 Preview/Production、没有写生产数据库。
- 当前主工作区存在大量其他会话和其他功能留下的修改；这些修改不能归为本轮成果，也不能整批提交或部署。

## 3. 当前部署与 Git 状态

### 3.1 主工作区

- 路径：`D:\代码\Pinterest flow`
- 当前分支：`feat/referral-credits-0904`
- 当前 HEAD：`b2d8f36ca8b0ed262d19c4f0a436e1863205e2f7`
- HEAD 提交：`docs: plan physical category stability runs`
- HEAD 日期：2026-09-12
- 工作区状态条目：552 条，包含大量已暂存、未暂存、未跟踪和删除项。
- 当前目录不存在 `.vercel\project.json`，没有直接绑定 Vercel 项目。
- 因此，当前主工作区中的脏代码和本交接所列新文档都不能视为已经部署。

### 3.2 已知的独立 Preview 记录

- 另一个独立工作树曾部署过提交 `b3661877f0ca1d343b5eea1b18b81059e3115931`。
- 提交主题是 `feat: show external channels in weekly plan`，属于三平台排期功能，不是本次参考图库与 AI 图片生成闭环。
- 当前主工作区 HEAD 不是该 Preview 提交的祖先，两者属于不同历史/分支，不能用那个 Preview 证明本地当前改动已上线。

### 3.3 实体类目稳定性实验工作树

- 路径：`D:\代码\pinterest-flow-glm-physical-20260912`
- 分支：`glm/physical-stability-20260912`
- HEAD：`88abc754c1676a8c631c72506204dfcf4e2e1903`
- HEAD 提交：`fix(stability): enforce 3-bucket gate, history hash dedup, dynamic paths, and replenish reference rounds`
- 该工作树的 `output\` 目前仍是未跟踪内容。
- 实验记录明确为 `production_database_written=false`。
- 该分支和实验输出尚未合并到主工作区，也未部署。

## 4. 已完成的产品与验证工作

### 4.1 已定义的完整产品流程

已在核心 PRD 中写清以下上线流程：

1. 从 Pinterest 等来源采集自然流社媒参考图，并记录 Pin ID、来源 URL、原始创建时间、收藏数、互动数据、采集时间、尺寸和原图哈希。
2. 通过时间、收藏、商品图/广告大片排除、AI 异常、文字水印、重复图和可执行结构等硬门禁。
3. 用户在审核页只使用“要 / 不要”两个按钮；没有点“不要”的默认保留。
4. 对通过图执行结构化标注，区分商品类别、场景、构图、人物/使用关系、光线、配色、真实感、营销角度、文字布局、风险和 generation access。
5. 用户上传商品、输入商品链接、选择商品库商品或从当前卡片进入 AI 生成。
6. 后台根据商品身份、类目、场景、结构、真实感和多样性检索参考图；前台不要求用户浏览庞大图库。
7. 将参考图转成可执行风格卡，只借空间关系、构图、镜头、光线、内容叙事和生活杂乱度，不复制原图人物、文字、品牌、水印或整张作品。
8. Gemini 图片模型生成多个结构明显不同的自然流社媒方向，并锁定商品轮廓、颜色、材质、标志和真实功能。
9. 自动 QA 检查商品保真、支撑/接触、肢体、空间位置、品牌文字和 AI 假感；只返工失败方向。
10. 记录用户采用、不要、返工、发布及后续表现，形成可迭代的检索和风格权重。

### 4.2 已完成的历史生成基线

- Home：3 个商品、12 张生成图，用户保留 10 张、不要 2 张；已形成可用基线。
- Fashion：7 个商品池、6 张生成图，用户保留 6 张；质量方向得到用户认可，目标是保持博主感并进一步提升真实感。
- Beauty：首轮 5 张生成图，历史记录为 2 张保留、其余隔离或排除；之后又完成了新参考图采集和审核。
- Garden/Outdoor：旧一轮 4 张生成图全部被用户否决；之后重做了参考图采集，但尚未用最终用户决定完成稳定生成闭环。
- Food & Drink：首轮 3 张生成图，历史记录为 1 张保留、2 张返工/不要。
- DIY & Crafts：首轮 4 张生成图，历史记录为 1 张保留，其余返工、不要或身份隔离。
- Wedding：已补采参考图并恢复来源/创建时间/收藏等证据，但没有完成正式标注和生成闭环。
- Digital Products：用户提过需要覆盖，但当前稳定性设计明确暂缓，尚未进入本轮实体类目验证。

### 4.3 0912 独立工作树的最新采集证据

- Home：16 张唯一合格参考图；Gemini 视觉短名单 10 张中建议保留 8 张。
- Fashion：24 张唯一合格参考图；视觉短名单 10 张中模型建议保留 8 张。
- Beauty：8 张唯一合格参考图；视觉短名单 8 张中建议保留 6 张。
- Garden/Outdoor：18 张唯一合格参考图；视觉短名单 10 张中模型建议保留 7 张。
- Food & Drink：25 张唯一合格参考图；视觉短名单 10 张中建议保留 8 张。
- DIY & Crafts：13 张唯一合格参考图；视觉短名单 10 张中只有 5 张可保留，模型结论为 `needs_recollection`。
- Wedding：23 张唯一合格参考图；视觉短名单 10 张中建议保留 10 张。
- 7 类共 133 条候选通过确定性字段校验，`failures=0`、`metadata_missing=0`。
- 上述视觉短名单审查模型为 `gemini-3.8-flash`，不等于 Fable 审查，也不等于用户最终批准。

## 5. 已知结论冲突，必须先修正

- Fashion：用户明确表示衣柜/衣帽间图都不属于本轮 Fashion，应全部剔除。Gemini 审查只剔除了 2 张，仍可能保留了挂衣架或偏收纳的候选。后续应以用户决定为准，重新固化 Fashion 审核 JSON。
- Garden：用户明确指定 `garden_outdoor_r3_8585055536885905` 不要，其他当页候选要。Gemini 审查却把该图标记为保留。后续应把该图写入明确排除，不得进入正式标注或生成配方。
- Beauty：用户已口头确认“Beauty 可以”，但需要确认审核页的最终导出 JSON 是否已经落盘；不能只依赖浏览器本地状态。
- Food：曾打开新审核页，但当前交接证据中没有找到用户最终导出的决定文件。
- Wedding：模型视觉审查为 10/10 可用，但用户之前要求重新采集高收藏自然流内容；仍需用户最终确认，不可把模型结论当作用户结论。
- DIY：当前候选只有 5/10 达到真实自然流要求，未达到最低 6 张门槛，必须补采，不能直接生成。

## 6. 当前待处理事项

1. 将最新用户审核决定写入结构化 JSON，优先修正 Fashion 和 Garden 冲突。
2. 核对 Beauty、Food、Wedding 审核页是否有真实导出文件；没有导出时重新打开页面并只固化决定，不重复审核已经确认的图片。
3. DIY 重新采集真实手作过程、手部制作、工具接触、半成品和工作台，排除教程长图、多宫格海报、卧室改造图。
4. 对所有最终保留参考图生成当前 v5 标注，不得用历史 v3 Fable PASS 冒充 v5 已审查。
5. 以最终用户审核结果生成每类风格卡，检查至少覆盖 3 种不同结构方向。
6. Home、Fashion 补一轮新参考图生成；Beauty、Garden、Food、DIY、Wedding 各完成两轮稳定生成。
7. 每个商品至少 3 个结构明显不同的方向，不能只换颜色、背景或角度微调。
8. 每类达到商品身份保真不低于 90%、严重支撑/接触/人体错误为 0、明显假图不高于 10%、用户生成图保留率不低于 70%，并连续两轮通过。
9. 完成真实 Fable 独立审查；若 Fable 不可调用，必须明确标记未审查，不能用 Gemini 或其他模型替代名义。
10. 把实验工作树的代码与数据变更拆成干净提交，由 Codex/Fable 分别审产品逻辑和代码，再合入明确的集成分支。
11. 部署到独立 Preview，按真实商品上传/链接输入/商品库选择三种入口做端到端人工验收。
12. Preview 通过后再决定生产部署；当前禁止从 552 项混合改动的主工作区直接部署。

## 7. 核心需求文档位置

### 7.1 本功能的权威 PRD

- `D:\代码\Pinterest flow\docs\prd\0918-VibePin-参考图库标注与社媒图片生成全流程PRD-v1.0.md`
- 正文版本：v1.2。
- 内容：业务背景、用户需求、采集、审核、标注、检索、生成算法、字段、按钮、规则、QA、反馈闭环、验收和停止条件。
- 当前 SHA-256：`7ADD1BD85011E0F7151B9ADFD23006EF9B8CD55AA3D830AF9ECAA3FE226B3919`。

### 7.2 Studio 与 URL 驱动 AI 的主 PRD

- `D:\代码\Pinterest flow\docs\prd\0918-VibePin-Tailwind工作台交互改版与URL驱动AI-PRD-v2.0.md`
- 内容：Studio 主工作流、URL 输入、图片/视频卡片动作、共享 AI 抽屉、账号和排期、Draft/History 等。
- 参考图库 PRD 已按该文档的最新交互边界同步。

### 7.3 历史需求基线

- `D:\代码\Pinterest flow\docs\prd\0901-Reference创意智能补充PRD-v1.0.md`
- `D:\代码\Pinterest flow\docs\prd\Pinterest创意智能层-PRD-v0.2.md`
- `D:\代码\Pinterest flow\docs\prd\0903-VibePin-CreatePin-业务PRD-v2.0.md`
- 全部 PRD 目录：`D:\代码\Pinterest flow\docs\prd`

## 8. 调研、审查与状态文档位置

### 8.1 产品与竞品调研

- `D:\代码\Pinterest flow\docs\审查报告\0908-VibePin自然流社媒图片方案-v1.0.md`
- `D:\代码\Pinterest flow\docs\调研报告\0831-用户反馈驱动的视觉生成闭环-调研与方案.md`
- `D:\代码\Pinterest flow\docs\调研报告\0827 按输入推荐参考图 竞品调研.md`
- `D:\代码\Pinterest flow\docs\调研报告\VibePin 上传商品选择商品 AI 生图与参考图推荐调研报告.md`

### 8.2 稳定性设计与执行计划

- `D:\代码\Pinterest flow\docs\superpowers\specs\2026-09-12-vibepin-physical-category-stability-design.md`
- `D:\代码\Pinterest flow\docs\superpowers\plans\2026-09-12-vibepin-physical-category-stability.md`

### 8.3 汇总状态与终审结论

- `D:\代码\Pinterest flow\docs\审查报告\0908-VibePin多类目标注与Gemini首稿-终审总结.md`
- `D:\代码\Pinterest flow\docs\审查报告\0910-四类目标注与生成方案-Fable终审原文.md`
- `D:\代码\Pinterest flow\docs\审查报告\0911-多类目生成验证交付状态.md`
- `D:\代码\Pinterest flow\docs\审查报告\0912-VibePin多类目验证当前状态.md`
- Fable 和 Codex 历史审查总目录：`D:\代码\Pinterest flow\docs\审查报告`

## 9. 审核页与本地证据位置

### 9.1 主工作区历史审核页

- `D:\代码\Pinterest flow\docs\素材\0908-家具参考图50张审核.html`
- `D:\代码\Pinterest flow\docs\素材\0908-Fashion参考图首轮审核.html`
- `D:\代码\Pinterest flow\docs\素材\0909-Beauty参考图扩充审核.html`
- `D:\代码\Pinterest flow\docs\素材\0911-家居第二轮生成结果审核.html`
- `D:\代码\Pinterest flow\docs\素材\0911-Fashion第一轮生成结果审核.html`
- `D:\代码\Pinterest flow\docs\素材\0911-Beauty第一轮生成结果审核.html`
- `D:\代码\Pinterest flow\docs\素材\0911-Garden第一轮生成结果审核.html`
- `D:\代码\Pinterest flow\docs\素材\0911-Food第一轮生成结果审核.html`
- `D:\代码\Pinterest flow\docs\素材\0911-DIY第一轮生成结果审核.html`
- `D:\代码\Pinterest flow\docs\素材\0911-Wedding参考图补采审核.html`

### 9.2 0912 实验工作树的新审核页

- 目录：`D:\代码\pinterest-flow-glm-physical-20260912\output\physical-stability-20260912\review`
- 包含 Home、Fashion、Beauty、Garden/Outdoor、Food & Drink、DIY & Crafts、Wedding 七个审核页。
- 这些页面用于本地验证，不代表结果已经合并进产品或写入生产数据库。

### 9.3 关键生成和标注证据

- Home：`D:\代码\Pinterest flow\output\product-generation-20260910\home-lived-in-round2-final`
- Fashion：`D:\代码\Pinterest flow\output\fashion-generation-20260908`
- Beauty：`D:\代码\Pinterest flow\output\beauty-generation-20260911\final-audit`
- Garden/Food/DIY：`D:\代码\Pinterest flow\output\multicategory-generation-20260910\final-audit`
- 多类目正式标注：`D:\代码\Pinterest flow\output\multicategory-annotation-20260911\formal`
- 多类目风格卡：`D:\代码\Pinterest flow\output\parallel-generation-plan-20260911\style-cards.json`
- Wedding 补采：`D:\代码\Pinterest flow\output\wedding-reference-replenish-20260911`
- 最新稳定性实验：`D:\代码\pinterest-flow-glm-physical-20260912\output\physical-stability-20260912`

## 10. 代码审核范围

### 10.1 参考图库与生成实验代码

- 优先审核独立分支 `glm/physical-stability-20260912` 相对其基线的变更。
- 核心关注：三结构桶门禁、Pin ID 与 SHA-256 跨轮去重、创建时间/收藏门槛、动态输出路径、补采轮次、审核页持久化和导出。
- 该分支 `output\` 未跟踪，代码审查和数据证据审查应分开进行。

### 10.2 Studio AI 入口相关本地代码

当前主工作区存在一批已暂存的 Studio/草稿同步代码，主要包括：

- `web\src\components\studio\AiVersionDrawer.tsx`
- `web\src\components\studio\BatchEditDrawer.tsx`
- `web\src\components\studio\PinBoardCard.tsx`
- `web\src\components\studio\StudioBoard.tsx`
- `web\src\components\sync\SyncStatusIndicator.tsx`
- `web\src\lib\contentDraftModel.ts`
- `web\src\lib\pinDraftStore.ts`
- `web\src\lib\pinDraftSync.ts`
- `web\src\app\api\pin-drafts\route.ts`
- 相关测试：`web\scripts\test-generation-setup-atomic.ts`、`test-generation-single-toast.ts`、`test-pin-details-persistence.ts`、`test-pin-drafts-per-draft-outcome.ts`。

当前主工作区另有未暂存的 Studio 相关代码：

- `web\src\components\studio\PinCardMedia.tsx`
- `web\src\components\studio\ProductPickerModal.tsx`
- `web\src\components\studio\SelectedAssetPreview.tsx`
- `web\src\components\studio\StudioBoardFilters.tsx`
- `web\src\hooks\usePinBoardDrafts.ts`
- `web\src\lib\studio\pinLifecycle.ts`
- `web\src\lib\studio\publishErrorDisplay.ts`

这些代码来自多个任务，尚未证明全部属于本 PRD，也没有完成统一验收。审核时不要把当前暂存区直接视为可发布变更集。

## 11. 建议的 Fable 审核顺序

1. 先读本交接，确认当前状态和未固化的用户决定。
2. 读参考图库全流程 PRD v1.2，审业务价值、流程边界、字段、生成算法、QA 和停止条件。
3. 对照 Studio 主 PRD v2.0，检查两份 PRD 是否存在入口、按钮、状态或 Draft/History 冲突。
4. 读实体类目稳定性设计，检查门槛是否足够严格且成本可控。
5. 审核 0912 独立工作树中的 `reference-run-summary.json`、`visual-shortlist-audit-gemini38.json` 和七个审核页。
6. 以用户决定覆盖模型决定，重点复核 Fashion 衣柜图、Garden 指定排除图、DIY 补采和 Wedding 的高收藏自然流要求。
7. 再做代码审查，检查实现是否真正支持 PRD，不要只看页面文案或本地静态审核页。
8. 输出必须分为：阻断项、上线前必须修、可延后、证据不足；不得把 Gemini 审查写成 Fable 审查。

## 12. 建议的代码集成与部署顺序

1. 冻结当前主工作区，不在 552 项混合改动上直接继续堆叠或部署。
2. 为参考图库/生成闭环创建独立集成分支或工作树，只挑选已确认的代码和文档。
3. 将最新用户审核决定固化为版本化 JSON，并加入回归测试。
4. 分别审采集/标注脚本、检索/风格卡逻辑、生成服务、Studio 入口和草稿持久化。
5. 跑确定性测试、类型检查、相关集成测试和真实浏览器验收。
6. 生成一个只包含本功能的 Preview 部署。
7. 用至少 Home、Fashion、Beauty、Garden 四类真实商品做入口到结果的端到端验收。
8. Fable 做独立产品审查，Codex 做代码和证据验收，二者结论都归档。
9. 阻断项清零后才允许生产部署。

## 13. 当前交接结论

- 文档已经集中在 `docs\prd`、`docs\审查报告`、`docs\调研报告`、`docs\superpowers` 和本交接所列输出目录。
- 产品方向已经较清楚：不是生成白底商品图，而是使用真实自然流参考结构，把已有商品转成多方向、真实、像博主手拍的社媒图片。
- 当前最大缺口不是继续扩大文档数量，而是把用户最终审核、v5 标注、连续两轮生成、代码集成和 Preview 验收串成一条可追踪的证据链。
- 当前状态应标记为 `IN_PROGRESS / NOT_DEPLOYED`，不能标记为已上线或生产完成。
