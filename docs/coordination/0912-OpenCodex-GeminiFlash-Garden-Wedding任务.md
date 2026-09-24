# OpenCodex / Google AI Pro Gemini Flash 执行任务

## 身份与费用门禁

- 必须使用 `google-antigravity/gemini-3.8-flash`，通过本机 OpenCodex 回环代理执行。
- 开始时报告实际 provider/model；若不是 `google-antigravity`，立即停止。
- 禁止 MixToken、Fable、ZCode GLM、Google API Key provider 和其他付费 API；不得把结果冒充 Fable 或 Codex 终审。

## 目标

接续 Garden 与 Wedding 第二轮候选，完成现有未完成候选的证据整理和逐图标注；仅在强候选不足时补采新的 Pinterest Pin。只为本轮新候选生成审核材料，用户已审核的旧候选不得重新送审。

## 必读

- `memory/2026-09-11.md`
- `memory/2026-09-12.md`
- `output/parallel-garden-collection-20260911/wave2/`
- `output/parallel-wedding-collection-20260911/wave2/`
- `docs/素材/0911-Garden与Wedding高收藏参考图补采审核.html`

## 证据门禁

- 每张记录 Pin URL、Pin ID、原始创建/发布时间、收藏或可见互动数、本地采集时间。
- 近半年只能由 Pin 原始创建时间判断；缺失则 `unknown`，不得用采集时间替代。
- 高收藏与真实自然流分别判定；缺少互动证据不得声称热门。
- 排除白底商品、目录页、模板海报、过度棚拍、明显 AI 伪影和无法合理植入商品的画面。

## Garden

- 避免此前单一、普通的迷你花盆方向。
- 候选应覆盖自然乡村、地中海、现代极简、英式花园、都市阳台、复古折衷等不同审美；不能用相近构图和色调凑数。
- 要有真实家庭/博主自然发布感，允许轻度生活杂物、自然不完美和真实尺度。

## Wedding

- 必须是真实婚礼或筹备过程的自然流内容，不是婚庆商品图。
- 优先仪式、桌面布置、宾客视角、细节记录、居家筹备和场地布置过程。
- 排除戒指/美甲/发型单品、模板拼贴和没有商品植入空间的画面。

## 标注字段

逐图输出：类目、场景、视觉风格、构图、镜头角度、光线、配色、生活杂乱度、自然流内容类型、营销表达、文字安全区、可植入商品类型、商品尺度与落位约束、真实性风险、重复度、证据置信度、`generation_access`、`direct_recipe / structure_only / exclude` 结论及理由。

## 输出

写入 `output/opencodex-gemini-flash-20260912/`：

- `garden-manifest.json`
- `wedding-manifest.json`
- `annotations.json`
- `collection-receipts.json`
- `README.md`
- 新候选联系表和 HTML 审核页。审核页仅用“要 / 不要”两个按钮；未点“不要”默认为“要”，系统 `exclude` 锁定。

若全部不合格，诚实交付 0 或少量强候选，不能降门禁凑数。本任务不生成最终产品图。

## 禁止

- 不修改生产数据库、不部署、不提交或推送 Git。
- 不删除或覆盖旧审核结果。
- 不重新审核用户已通过的 16 张候选。
- 不编造创建时间、收藏、评论、点击或转化数据。

完成后报告真实 provider/model、ZCode session ID、扫描/保留/排除/时间未知数量、输出文件、未完成项和任何配额错误。
