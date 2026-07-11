import {
  Stack, H1, H2, H3, Text, Grid, Row, Stat, Divider,
  Card, CardHeader, CardBody, Table, Callout, Pill, Code,
  useHostTheme, computeDAGLayout,
} from 'cursor/canvas';

/**
 * VibePin PRD v2.0 — Pinterest-first 战略收敛版
 * 复制自 pinterest-flow-prd.canvas.tsx（v2.1 风格库向）并重写矩阵 / 模块 / 技术 / 定价 / 路线图。
 * 上一版画布保留作历史对照：pinterest-flow-prd.canvas.tsx
 */

// ─── MVP 主线数据流（Pinterest-first · 先发预览与导出）──────────────────────────
const dagNodes = [
  { id: 'style' }, { id: 'ingest' }, { id: 'scrape' },
  { id: 'engine' }, { id: 'copy' }, { id: 'preview' }, { id: 'export' },
];
const dagEdges = [
  { from: 'style', to: 'ingest' },
  { from: 'ingest', to: 'scrape' },
  { from: 'scrape', to: 'engine' },
  { from: 'engine', to: 'copy' },
  { from: 'copy', to: 'preview' },
  { from: 'preview', to: 'export' },
];
const nodeLabels: Record<string, string> = {
  style: 'Pin Style Library',
  ingest: 'URL / 上传图 / 多链接',
  scrape: '抓取商品信息',
  engine: 'AI Pin Creative Engine',
  copy: 'Pin 文案层',
  preview: '预览 / 编辑',
  export: '下载 / CSV / 复制',
};
const nodeSubLabels: Record<string, string> = {
  style: '模板配置入口 · P0',
  ingest: '单链 · 轻量批量粘贴',
  scrape: 'Shopify / Etsy / Fallback',
  engine: 'API-first · 多模型路由',
  copy: 'Title · Desc · Keywords · 链接绑定',
  preview: 'MVP 默认把关节点',
  export: '不强制 OAuth',
};
const layout = computeDAGLayout({
  nodes: dagNodes, edges: dagEdges,
  direction: 'horizontal',
  nodeWidth: 138, nodeHeight: 50, rankGap: 28, nodeGap: 22, padding: 18,
});

function DataFlowDiagram() {
  const theme = useHostTheme();
  return (
    <div style={{ overflowX: 'auto' }}>
      <svg width={layout.width} height={layout.height + 8} style={{ display: 'block' }}>
        <defs>
          <marker id="arrV20" markerWidth="7" markerHeight="7" refX="5" refY="3.5" orient="auto">
            <path d="M0,0 L0,7 L7,3.5 z" fill={theme.stroke.secondary} />
          </marker>
        </defs>
        {layout.edges.map((e, i) => (
          <line key={i} x1={e.sourceX} y1={e.sourceY} x2={e.targetX - 7} y2={e.targetY}
            stroke={theme.stroke.secondary} strokeWidth={1.5} markerEnd="url(#arrV20)" />
        ))}
        {layout.nodes.map(node => {
          const isExport = node.id === 'export';
          const isPreview = node.id === 'preview';
          const fill = isExport ? theme.accent.primary
            : isPreview ? theme.fill.primary
            : theme.fill.tertiary;
          return (
            <g key={node.id}>
              <rect x={node.x} y={node.y} width={138} height={50} rx={5}
                fill={fill}
                stroke={theme.stroke.primary}
                strokeWidth={isPreview ? 1.5 : 1} />
              <text x={node.x + 69} y={node.y + 18} textAnchor="middle"
                fill={isExport ? theme.text.onAccent : theme.text.primary}
                fontSize={10.5} fontFamily="system-ui, sans-serif" fontWeight="500">
                {nodeLabels[node.id]}
              </text>
              <text x={node.x + 69} y={node.y + 34} textAnchor="middle"
                fill={isExport ? theme.text.onAccent : theme.text.tertiary}
                fontSize={9} fontFamily="system-ui, sans-serif">
                {nodeSubLabels[node.id]}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function InfoBlock({ label, value }: { label: string; value: string }) {
  const theme = useHostTheme();
  return (
    <div style={{ padding: '9px 12px', background: theme.fill.tertiary, borderRadius: 4 }}>
      <Text size="small" weight="semibold">{label}</Text>
      <Text size="small" tone="secondary" style={{ marginTop: 3 }}>{value}</Text>
    </div>
  );
}

export default function SocialFlowPRDV20PinterestFirst() {
  const theme = useHostTheme();

  return (
    <Stack gap={32} style={{ padding: 36, maxWidth: 980, margin: '0 auto' }}>

      <Stack gap={8}>
        <Row gap={10} align="center">
          <H1>VibePin — MVP PRD</H1>
          <Pill tone="success" active size="sm">v2.0 Pinterest-first · API-first</Pill>
        </Row>
        <Text tone="secondary">
          面向电商卖家、联盟创作者与内容创作者的 <strong>Pinterest-first</strong> 商品 Pin 生成与批量工作台。不限家居：
          Fashion / Beauty / Gift / Digital 等与风格库联动验证。
        </Text>
        <Callout tone="info" title="一句话产品描述（v2.0 定稿）">
          VibePin 是一个 Pinterest-first 商品 Pin 生成与批量发布工具。用户从高转化 Pin 风格库选择模板，输入商品链接、图片或<strong>轻量批量 URL</strong>，系统生成 Pinterest-ready 图片、标题、描述、关键词和商品链接，并支持批量预览、编辑、下载、导出与排程。
          <Text size="small" style={{ marginTop: 10 }}>
            Instagram Feed 与 Caption CTA 为<strong>辅助输出</strong>，<strong>不作为 MVP 主链路</strong>；OAuth 与平台发布移至 Beta（8–10 周），避免阻挡首次「生成即价值」体验。
          </Text>
        </Callout>
        <Text tone="tertiary" size="small">
          本文档由 v2.1 画布复制并重写战略层；历史双平台 / ComfyUI-SAM 管线见 <Code>pinterest-flow-prd.canvas.tsx</Code>。日期 2026-05-13。
        </Text>
      </Stack>

      <Grid columns={4} gap={14}>
        <Stat value="P0 核心" label="风格库 + Creative Engine + 导出" tone="success" />
        <Stat value="1 credit" label="= 1 Pin 图 + title + desc + keywords" />
        <Stat value="3×" label="默认单商品 3 变体 = 3 credits" />
        <Stat value="P1" label="Pinterest OAuth 发布 · CSV 导入" />
      </Grid>

      <Divider />

      <Stack gap={12}>
        <H2>MVP 范围决策矩阵（v2.0 重写）</H2>
        <Text tone="secondary" size="small">
          与「CSV 一句产品描述」矛盾已统一：<strong>MVP</strong> 支持<strong>多行 URL 粘贴（约 5–10 条）轻量批量</strong>；<strong>CSV 文件上传</strong>、Shopify Collection 导入进 P1/P2。
        </Text>
        <Table
          headers={['功能', '建议优先级', '本期状态', '说明']}
          rows={[
            ['Pin Style Gallery / 风格库（含 Tab · 模板元数据）', 'P0', '必做', '一级产品模块，非仅落地页装饰；配置入口驱动生成'],
            ['商品 URL / 单图上传', 'P0', '必做', '核心输入'],
            ['单商品默认 3 个 Pin 变体', 'P0', '必做', '与 credits 计费对齐'],
            ['Pinterest 2:3 Pin 图片生成', 'P0', '必做', '主输出'],
            ['Pin 标题 / 描述 / 关键词 + 商品链接绑定', 'P0', '必做', '商业信息必须准确'],
            ['预览 / 编辑 / 下载 / 复制文案', 'P0', '必做', 'MVP 闭环'],
            ['项目保存（需账户）', 'P0', '必做', '可与「先预览后注册」分阶段'],
            ['轻量批量：多 URL 粘贴队列（5–10）', 'P0.5', '可做', 'Bulk Workspace 最小集'],
            ['Pinterest OAuth + Board + 一键发布 / 排程', 'P1', 'Beta', '不卡住 MVP 首次价值'],
            ['Instagram Feed 辅助图 + Caption', 'P1', '辅助', '非主线'],
            ['CSV 批量上传', 'P1', '后续', '与文档一句描述对齐为「增强」'],
            ['Analytics', 'P1/P2', '后续', '—'],
          ]}
          rowTone={[
            'success', 'success', 'success', 'success', 'success', 'success', 'success',
            'neutral', 'neutral', 'neutral', 'neutral', 'neutral',
          ]}
          striped
        />
      </Stack>

      <Divider />

      <Stack gap={12}>
        <H2>MVP 默认用户路径（先价值后授权）</H2>
        <Callout tone="success" title="主流程（不写「理想」，即 MVP 默认）">
          1 选择 Pin 风格 → 2 输入商品 URL / 上传图 / 粘贴多条 URL → 3 抓取商品信息 → 4 生成 3 个 Pin 变体（图）→
          5 生成标题 / 描述 / 关键词 → 6 预览编辑 → 7 下载 / 导出 CSV / 复制文案 → 8 保存项目（需注册）→
          9<strong>仅当用户要官方发布时再</strong>连接 Pinterest OAuth 与 Board（P1）。
        </Callout>
        <Table
          headers={['原则', '说明']}
          rows={[
            ['Pinterest-first', '主页、话术、仪表盘以 Pin 生成与导出为先'],
            ['API-first 图像', 'MVP 不以商品像素级复刻为目标；图像 API 可多模型替换'],
            ['OAuth 后置', '首访不要求 Pinterest / Meta 绑定'],
          ]}
          striped
        />
      </Stack>

      <Divider />

      <Stack gap={12}>
        <H2>用户画像与核心场景</H2>
        <Grid columns={2} gap={16}>
          <Card>
            <CardHeader>目标用户</CardHeader>
            <CardBody>
              <Stack gap={6}>
                <Text size="small"><Text as="span" weight="semibold">角色：</Text> 电商卖家、联盟创作者、Pinterest-heavy 店主；家居为优势类目，首屏素材需 Fashion / Gift 等）</Text>
                <Text size="small"><Text as="span" weight="semibold">痛点：</Text> 不知道从哪种 Pin「范式」起手 + 空白 Prompt + 批量商品链接效率</Text>
              </Stack>
            </CardBody>
          </Card>
          <Card>
            <CardHeader>与 v2.1 的差异（执行层）</CardHeader>
            <CardBody>
              <Stack gap={6}>
                <Text size="small">· Instagram 与双平台发布<strong>降级</strong>为 P1 辅助</Text>
                <Text size="small">· 删除 ComfyUI / SAM / ControlNet / 泊松融合作为 MVP 承诺</Text>
                <Text size="small">·「商品保真」改为「吸引力 + 信息准确 + 合规」</Text>
                <Text size="small">· 定价改为 <strong>credits</strong>，与 3 变体默认一致</Text>
              </Stack>
            </CardBody>
          </Card>
        </Grid>
      </Stack>

      <Divider />

      <Stack gap={14}>
        <H2>P0 核心功能模块（重组）</H2>

        <Card collapsible defaultOpen>
          <CardHeader trailing={<Pill tone="success" size="sm">P0 · 模块 A</Pill>}>
            Pin Style Library — 一级产品模块
          </CardHeader>
          <CardBody>
            <Text tone="secondary" size="small" style={{ marginBottom: 10 }}>
              风格库 = 全生成系统的<strong>配置入口</strong>（非仅营销图墙）。用户点击 <Code>Use this style</Code> 即写入下列字段。
            </Text>
            <Table
              headers={['字段', '示例']}
              rows={[
                ['category', 'Fashion / Home / Beauty / Food / Gift Guide / Digital'],
                ['pin_type', 'Outfit Collage / Product Feature / Gift Guide / Routine Steps'],
                ['visual_style', 'Minimal / Vintage / Luxury / Warm Editorial / Clean Studio'],
                ['layout', 'Single Product / Collage / Listicle / Moodboard / Scene'],
                ['aspect_ratio', '2:3（Pinterest 主）'],
                ['prompt_skeleton', '系统模板 + 可选 Advanced 用户补充'],
                ['copy_structure', 'SEO title + benefit body + CTA + 链接位'],
                ['best_for', '展示给用户的「适合类目」说明'],
                ['output_count', '默认 3 变体 / 可配置'],
              ]}
              striped
            />
          </CardBody>
        </Card>

        <Card collapsible defaultOpen={false}>
          <CardHeader trailing={<Pill tone="success" size="sm">P0 · 模块 B</Pill>}>
            Bulk Workspace — 批量生成工作台（P0.5 最小集）
          </CardHeader>
          <CardBody>
            <Text size="small" style={{ marginBottom: 10 }}><strong>输入：</strong>单 URL · 多个 URL 粘贴（5–10）· 上传图 + 手动标题。<strong>P1：</strong>CSV · Shopify/Etsy Collection import。</Text>
            <Table
              headers={['工作台字段', '说明']}
              rows={[
                ['product_url', '商品链接'],
                ['product_title', '抓取或手填'],
                ['image_url', '主图'],
                ['category', '类目标签'],
                ['selected_template', '所选 Pin 风格模板 ID'],
                ['generated_variants', '默认 3'],
                ['status', 'pending / generating / ready / failed'],
                ['schedule_time', '排程（P1）'],
                ['board', 'Pinterest Board（P1）'],
              ]}
              striped
            />
            <H3 style={{ marginTop: 14 }}>批量操作</H3>
            <Text size="small">Apply style to all · Generate 3 variants each · Regenerate selected · Inline edit copy · Download selected · Export CSV · Schedule selected（P1）</Text>
          </CardBody>
        </Card>

        <Card collapsible defaultOpen={false}>
          <CardHeader trailing={<Pill tone="success" size="sm">P0 · 模块 C</Pill>}>
            商品同步 — Metadata Scraper
          </CardHeader>
          <CardBody>
            <Text size="small"><Code>title</Code> · <Code>price</Code> · <Code>currency</Code> · <Code>image_url</Code> · <Code>product_url</Code> · <Code>category_tags</Code></Text>
            <Callout tone="warning" title="抓取失败" style={{ marginTop: 10 }}>手动填写 + 上图，流程不断。</Callout>
          </CardBody>
        </Card>

        <Card collapsible defaultOpen>
          <CardHeader trailing={<Pill tone="success" size="sm">P0 · 模块 D</Pill>}>
            AI Pin Creative Engine — 图像 + 版式 + 文案管线
          </CardHeader>
          <CardBody>
            <Callout tone="neutral" title="战略声明">
              MVP <strong>不以</strong>商品级抠图、ControlNet、泊松融合为承诺；优先验证<strong>风格库驱动的 Pin 创意</strong>。图像采用 <strong>API-first、多模型可替换</strong>路由（如第三方图像生成 API）。
            </Callout>
            <Table
              headers={['层级', '说明']}
              rows={[
                ['Style Template Layer', 'Pin Type · Visual Style · Layout · Copy Structure（来自 Library）'],
                ['Creative Generation Layer', '生成 Pin 主图：场景 / 拼贴 / moodboard / gift-guide 式等，依模板'],
                ['Prompt Planner', 'LLM 读商品信息 + 风格模板 → 组装图像生成 prompt'],
                ['Pin Layout', '模板化版式 + 可选生成式版式扩展'],
                ['Copy + SEO Layer', 'Title · Description · Keywords · CTA · 绑定商品链接（必须准确）'],
              ]}
              striped
            />
            <Divider />
            <H3>质量标准（替换「像素级保真」）</H3>
            <Callout tone="warning" title="法务 / 产品表述">
              生成图用于 Pinterest 灵感与营销创意，<strong>不承诺</strong>对商品像素级复刻。<strong>商品链接、标题、价格等商业信息必须准确。</strong> 不使用「仿制他人爆款」话术；使用「similar style」「proven Pin format」。
            </Callout>
            <Table
              headers={['维度', '标准 / 手段']}
              rows={[
                ['Pin 吸引力', '抽样：是否像易被保存的高质 Pin'],
                ['风格匹配度', '与用户所选模板一致性（人工 + 轻度规则）'],
                ['商品相关性', '内容与输入商品 / 类目明显相关'],
                ['链接一致性', 'URL · 标价 · 标题不自相矛盾'],
                ['合规与安全', '不冒充实拍鉴定；不虚假功效承诺'],
                ['版式可读性', '移动端可读（若含覆盖文字）'],
                ['批量稳定性', '同批风格统一但变体不过分雷同'],
              ]}
              striped
            />
          </CardBody>
        </Card>

        <Card collapsible defaultOpen>
          <CardHeader trailing={<Pill tone="success" size="sm">P0 · 模块 E</Pill>}>
            预览 · 编辑 · 导出 · 复制
          </CardHeader>
          <CardBody>
            <Text size="small">展示 3 变体卡片；就地编辑文案；单张 / 批量下载图片；导出含链接与文案的 CSV；复制标题与描述。</Text>
          </CardBody>
        </Card>

        <Card collapsible defaultOpen={false}>
          <CardHeader trailing={<Pill tone="neutral" size="sm">P1 · Beta</Pill>}>
            Pinterest 发布（OAuth · Board · 排程）
          </CardHeader>
          <CardBody>
            <Text size="small"><Code>Pinterest v5</Code>：<Code>POST /media</Code> · <Code>POST /pins</Code>。<strong>移至 8–10 周 Beta</strong>，不阻碍 MVP。</Text>
          </CardBody>
        </Card>

        <Card collapsible defaultOpen={false}>
          <CardHeader trailing={<Pill tone="neutral" size="sm">P1</Pill>}>
            Instagram 辅助输出
          </CardHeader>
          <CardBody>
            <Text size="small">可选用 1:1 裁剪 / 次级生成 · Caption + link-in-bio CTA。<strong>非 MVP 主线。</strong></Text>
          </CardBody>
        </Card>
      </Stack>

      <Divider />

      <Stack gap={12}>
        <H2>P0 业务逻辑数据流</H2>
        <Text tone="secondary" size="small">下图强调「风格 → 抓取 → Creative → 文案 → 预览 → 导出」。发布为 P1 支线（未画出）。</Text>
        <DataFlowDiagram />
        <Text size="small" tone="secondary">任务状态机可保留 <Code>awaiting_review</Code>；<Code>publishing</Code> 仅当用户开启 OAuth 后出现。</Text>
      </Stack>

      <Divider />

      <Stack gap={12}>
        <H2>失败降级策略（节选 · 对齐 API-first）</H2>
        <Table
          headers={['失败节点', '兜底']}
          rows={[
            ['商品抓取失败', '手填 + 上传图'],
            ['图像 API 超时 / 限额', '重试 · 切换备用模型路由 · 提示稍后'],
            ['生成无可读物料', '重试 Prompt Planner · 回退极简模板'],
            ['文案生成失败', '标题 = 品类 + 商品名 skeleton；关键词 = 类目默认集'],
          ]}
          striped
        />
      </Stack>

      <Divider />

      <Stack gap={12}>
        <H2>MVP 技术路线（API-first）</H2>
        <Table
          headers={['层级', '建议', '职责']}
          rows={[
            ['前端', 'Next.js 15 + Tailwind', '落地页 Pin Gallery · Workspace · 预览 · SSE'],
            ['后端', 'FastAPI + Worker + Redis', '抓取 · 队列 · credits 计量'],
            ['图像生成', '第三方图像 API / 多模型路由', '可替换 · 不保 ComfyUI 栈'],
            ['Prompt Planner', 'LLM', 'metadata + 模板 → image prompt'],
            ['Pin Layout', '模板渲染 + AI 延展（迭代）', '—'],
            ['文案', 'LLM API', 'Title / Desc / Keywords'],
            ['存储', 'Supabase', 'PostgreSQL · Storage CDN'],
          ]}
          striped
        />
      </Stack>

      <Divider />

      <Stack gap={12}>
        <H2>计费：Credits Hypothesis</H2>
        <Callout tone="info" title="定义">
          <Code>1 credit = 1 Pin image + 1 title + 1 description + keywords</Code>。
          单商品默认 3 变体 = <strong>3 credits</strong>。
        </Callout>
        <Table
          headers={['版本', '价格', 'Credits / 月', '说明']}
          rows={[
            ['Free', '$0', '~20 credits', '带水印或可限清晰度 · 校验 PMF'],
            ['Starter', '$19', '~150 credits', '个人卖家'],
            ['Growth', '$49', '~500 credits', '轻量批量'],
            ['Pro', '$99', '~1200 credits', '高频 + 未来将开「发布」套件'],
          ]}
          rowTone={['neutral', 'success', 'success', 'info']}
          striped
        />
        <Text tone="secondary" size="small">旧版「品次」表废弃；对外物料与 Stripe 计量统一用 credits。</Text>
      </Stack>

      <Divider />

      <Stack gap={12}>
        <H2>成功指标（调整）</H2>
        <Table
          headers={['指标', '目标', '备注']}
          rows={[
            ['首次价值完成率', '≥ 70% 用户生成并下载或复制 ≥1 Pin', '不限 OAuth'],
            ['三变体完成率', '≥ 50% 跑满 3 credits', '—'],
            ['注册转化（预览后）', '跟踪「先预览再注册」漏斗', 'PostHog'],
            ['7 日付费转化', '维持 &gt; 15% 假设待验证', '—'],
          ]}
          striped
        />
      </Stack>

      <Divider />

      <Stack gap={12}>
        <H2>合规与安全（修订）</H2>
        <Table
          headers={['风险', '措施']}
          rows={[
            ['AI 图被误解为官方实拍', '文案与 ToS 标明营销创意用途；避免「100% 真实商品图」承诺'],
            ['价格 / 链接错误', '发布前强校验抓取字段；用户手改记录版本'],
            ['Token 安全', '加密存储 · 最小权限 · 审计日志'],
          ]}
          striped
        />
      </Stack>

      <Divider />

      <Stack gap={14}>
        <H2>落地页（与 v2.1 一致方向 · 略）</H2>
        <Text size="small">High-Converting Pin Styles · Hero「Turn Product Links Into Pinterest-Ready Pins」· Use this style 弹层 · 合规用语见 v2.1 画布；实现稿 <Code>social-flow-landing-page.canvas.tsx</Code>。</Text>
      </Stack>

      <Divider />

      <Stack gap={12}>
        <H2>版本路线图（重写）</H2>
        <Grid columns={3} gap={14}>
          <Card>
            <CardHeader trailing={<Pill tone="success" size="sm">约 6 周</Pill>}>
              MVP
            </CardHeader>
            <CardBody>
              <Stack gap={5}>
                <Text size="small">· Landing + Pin Style Gallery + Use style 弹层</Text>
                <Text size="small">· URL / 上传图 · 抓取</Text>
                <Text size="small">· 单商品 3 Pin 变体 + 文案 · credits</Text>
                <Text size="small">· 预览编辑 · 下载 · 复制 · CSV 导出结果</Text>
                <Text size="small">· 轻量批量：5–10 URL 队列</Text>
                <Text size="small">· 项目保存（账户）</Text>
              </Stack>
            </CardBody>
          </Card>
          <Card>
            <CardHeader trailing={<Pill tone="warning" size="sm">8–10 周 Beta</Pill>}>
              发布与批量增强
            </CardHeader>
            <CardBody>
              <Stack gap={5}>
                <Text size="small">· Pinterest OAuth · Board · 一键发 / 排程</Text>
                <Text size="small">· CSV 导入 · Bulk Workspace 全量</Text>
                <Text size="small">· 账户体系完善 · 额度与账单</Text>
              </Stack>
            </CardBody>
          </Card>
          <Card>
            <CardHeader trailing={<Pill tone="neutral" size="sm">P1 / P2</Pill>}>
              后续
            </CardHeader>
            <CardBody>
              <Stack gap={5}>
                <Text size="small">· Instagram 辅助</Text>
                <Text size="small">· Analytics</Text>
                <Text size="small">· Shopify App · Brand Kit · Team · Public API</Text>
              </Stack>
            </CardBody>
          </Card>
        </Grid>
      </Stack>

      <Text tone="quaternary" size="small" style={{ marginTop: 4 }}>
        VibePin PRD v2.0 Pinterest-first · 2026-05-13 · 由 v2.1 复制改写
      </Text>

    </Stack>
  );
}
