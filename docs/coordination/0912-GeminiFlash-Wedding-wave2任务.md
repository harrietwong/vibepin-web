# Gemini Flash Wedding wave2

使用 `opencodex/google-antigravity/gemini-3.8-flash`。若实际 provider/model 不符立即停止。禁止 MixToken、Google API Key provider、Fable 和其他付费接口。

只处理 `output/parallel-wedding-collection-20260911/wave2/`；禁止读取任何 HTML，尤其不要读取含 base64 图片的审核页。先列小文件，再按文件逐个读取，单次读取不超过 300 行；图片逐张查看，不得把整目录编码进上下文。

任务：

1. 汇总 `mixtoken-batches/` 的历史回执和 `images/` 现有候选；历史 MixToken 回执只作为输入证据，不得发起新的 MixToken 请求。
2. 核对每张图片的 Pin ID/URL、原始创建时间、收藏/互动、本地采集时间；缺失明确 `unknown`。
3. 逐张视觉标注：真实婚礼/筹备场景、风格、构图、镜头、光线、配色、生活杂乱度、自然流类型、商品落位、支撑/人体关系、遮挡、真实性风险、重复度、证据置信度、generation_access、direct_recipe/structure_only/exclude 与理由。
4. 严格排除白底商品、戒指/美甲/发型单品、模板拼贴、婚庆目录、明显 AI、没有植入空间的画面；不得因收藏高而放过商品图。
5. 本任务不补采、不生成产品图、不读取旧审核页、不重审旧 16 张。
6. 输出到 `output/opencodex-gemini-flash-20260912/wedding/`：`manifest.json`、`annotations.json`、`model-receipt.json`、`README.md`。记录真实 provider/model、ZCode session ID、输入文件 SHA256、扫描/保留/排除/时间未知数量。
7. 不改数据库、不部署、不删除、不提交 Git，不编造元数据。
