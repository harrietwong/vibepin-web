# Gemini Flash Garden wave2

使用 `opencodex/google-antigravity/gemini-3.8-flash`。若实际 provider/model 不符立即停止。禁止 MixToken、Google API Key provider、Fable 和其他付费接口。

只处理 `output/parallel-garden-collection-20260911/wave2/`；禁止读取任何 HTML，尤其不要读取含 base64 图片的审核页。先列小文件，再按文件逐个读取，单次读取不超过 300 行；图片逐张查看，不得把整目录编码进上下文。

任务：

1. 汇总 `wave-1/2/3-manifest.json` 与 `raw/` 现有回执，核对图片路径、Pin ID/URL、原始创建时间、收藏/互动、本地采集时间。
2. 对现有 Garden 图片逐张视觉标注：场景、风格、构图、镜头、光线、配色、生活杂乱度、自然流类型、商品落位、支撑接触、遮挡、真实性风险、重复度、证据置信度、generation_access、direct_recipe/structure_only/exclude 与理由。
3. 严格排除白底商品、目录/卖场、过度棚拍、明显 AI、普通单一迷你花盆和不可落位画面；风格差异不足不得凑数。
4. 本任务不补采、不生成产品图、不读取旧审核页、不重审旧 16 张。
5. 输出到 `output/opencodex-gemini-flash-20260912/garden/`：`manifest.json`、`annotations.json`、`model-receipt.json`、`README.md`。记录真实 provider/model、ZCode session ID、输入文件 SHA256、扫描/保留/排除/时间未知数量。
6. 不改数据库、不部署、不删除、不提交 Git，不编造元数据。

