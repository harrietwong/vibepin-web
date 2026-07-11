import {
  Stack, H1, H2, H3, Text, Grid, Row, Stat, Divider,
  Card, CardHeader, CardBody, Table, Callout, Pill, Code,
  useHostTheme, computeDAGLayout,
} from 'cursor/canvas';

// ─── P0 Data Flow DAG ────────────────────────────────────────────────────────
const dagNodes = [
  { id: 'url' }, { id: 'meta' }, { id: 'ai' }, { id: 'auth' },
  { id: 'quality' }, { id: 'copy' }, { id: 'preview' },
  { id: 'pub_p' }, { id: 'pub_ig' }, { id: 'success' },
];
const dagEdges = [
  { from: 'url', to: 'meta' },
  { from: 'meta', to: 'ai' },
  { from: 'meta', to: 'auth' },
  { from: 'ai', to: 'quality' },
  { from: 'quality', to: 'copy' },
  { from: 'copy', to: 'preview' },
  { from: 'preview', to: 'pub_p' },
  { from: 'preview', to: 'pub_ig' },
  { from: 'auth', to: 'pub_p' },
  { from: 'auth', to: 'pub_ig' },
  { from: 'pub_p', to: 'success' },
  { from: 'pub_ig', to: 'success' },
];
const nodeLabels: Record<string, string> = {
  url: '输入商品 URL', meta: '抓取 Metadata', ai: 'AI 场景图生成',
  auth: '双平台 OAuth', quality: '质量过滤', copy: 'AI 文案生成',
  preview: '用户预览 / 编辑', pub_p: 'Pinterest 发布',
  pub_ig: 'Instagram 发布', success: '发布完成',
};
const nodeSubLabels: Record<string, string> = {
  url: 'Shopify / Etsy', meta: 'API + Playwright',
  ai: 'Flux.1 · 2:3 + 1:1', auth: 'Pinterest + Meta OAuth',
  quality: 'CLIP · 多维检测', copy: 'GPT-4o · 双套文案',
  preview: '人工把关节点', pub_p: 'Pinterest v5 API',
  pub_ig: 'Meta Graph API', success: '写回双平台 ID',
};
const layout = computeDAGLayout({
  nodes: dagNodes, edges: dagEdges,
  direction: 'horizontal',
  nodeWidth: 132, nodeHeight: 50, rankGap: 40, nodeGap: 26, padding: 20,
});

function DataFlowDiagram() {
  const theme = useHostTheme();
  return (
    <div style={{ overflowX: 'auto' }}>
      <svg width={layout.width} height={layout.height + 8} style={{ display: 'block' }}>
        <defs>
          <marker id="arr2" markerWidth="7" markerHeight="7" refX="5" refY="3.5" orient="auto">
            <path d="M0,0 L0,7 L7,3.5 z" fill={theme.stroke.secondary} />
          </marker>
        </defs>
        {layout.edges.map((e, i) => (
          <line key={i} x1={e.sourceX} y1={e.sourceY} x2={e.targetX - 7} y2={e.targetY}
            stroke={theme.stroke.secondary} strokeWidth={1.5} markerEnd="url(#arr2)" />
        ))}
        {layout.nodes.map(node => {
          const isSuccess = node.id === 'success';
          const isPreview = node.id === 'preview';
          const isPubP    = node.id === 'pub_p';
          const isPubIG   = node.id === 'pub_ig';
          const fill = isSuccess ? theme.accent.primary
            : isPreview ? theme.fill.primary
            : (isPubP || isPubIG) ? theme.fill.secondary
            : theme.fill.tertiary;
          return (
            <g key={node.id}>
              <rect x={node.x} y={node.y} width={132} height={50} rx={5}
                fill={fill}
                stroke={isSuccess ? theme.accent.primary : isPreview ? theme.stroke.primary : theme.stroke.primary}
                strokeWidth={isPreview ? 1.5 : 1} />
              <text x={node.x + 66} y={node.y + 18} textAnchor="middle"
                fill={isSuccess ? theme.text.onAccent : theme.text.primary}
                fontSize={11} fontFamily="system-ui, sans-serif" fontWeight="500">
                {nodeLabels[node.id]}
              </text>
              <text x={node.x + 66} y={node.y + 34} textAnchor="middle"
                fill={isSuccess ? theme.text.onAccent : theme.text.tertiary}
                fontSize={9.5} fontFamily="system-ui, sans-serif">
                {nodeSubLabels[node.id]}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ─── Reusable style block ─────────────────────────────────────────────────────
function InfoBlock({ label, value }: { label: string; value: string }) {
  const theme = useHostTheme();
  return (
    <div style={{ padding: '9px 12px', background: theme.fill.tertiary, borderRadius: 4 }}>
      <Text size="small" weight="semibold">{label}</Text>
      <Text size="small" tone="secondary" style={{ marginTop: 3 }}>{value}</Text>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function SocialFlowPRD() {
  const theme = useHostTheme();

  return (
    <Stack gap={32} style={{ padding: 36, maxWidth: 980, margin: '0 auto' }}>

      {/* ── 标题 ─────────────────────────────────────────── */}
      <Stack gap={8}>
        <Row gap={10} align="center">
          <H1>Social Flow — MVP PRD</H1>
          <Pill tone="success" active size="sm">v2.1 · 落地页转化 / Pin 风格库</Pill>
        </Row>
        <Text tone="secondary">
          面向电商与联盟创作者的 Pinterest / Instagram 内容工具：从<strong>高转化 Pin 风格模板</strong>出发，用商品链接或图片生成可发布的图与文案（家居为优势类目，首页与模板需展示跨类目能力）。
        </Text>
        <Callout tone="info" title="一句话产品描述（对外 / 内部对齐）">
          用户可以从高转化 Pin 风格库中选择模板，上传商品链接、图片或 CSV，系统批量生成<strong>同类风格</strong>的 Pinterest Pin 图片、标题、描述、关键词和商品链接，并支持批量预览、编辑、导出与排程。
        </Callout>
        <Text tone="tertiary" size="small">
          v2.1（+ 首屏风格库 · Style-to-Pin · 合规用语）· v2.0 基线：IG 仅 Feed + Caption CTA · Shopping Tag 见独立 Extension PRD · 2026-05-13 · 6 周
        </Text>
      </Stack>

      <Grid columns={4} gap={14}>
        <Stat value="P0 × 8" label="MVP 必做功能项" tone="success" />
        <Stat value="P1/P2 × 9" label="暂缓，后续版本迭代" />
        <Stat value="< 5 min" label="单品完整处理时长目标" />
        <Stat value="$0.025–0.05" label="中位成本/品（含1次重试）" />
      </Grid>

      <Divider />

      {/* ── MVP 范围矩阵 ──────────────────────────────────── */}
      <Stack gap={12}>
        <H2>MVP 范围决策矩阵</H2>
        <Text tone="secondary" size="small">先验证"AI 内容生产 + 发布效率"核心价值。Instagram 仅做 Feed 发布 + Caption CTA，Shopping Tag 已拆分为独立 Extension PRD，Reels 等延后至 P1。</Text>
        <Table
          headers={['功能', '优先级', '本期状态', '收敛理由']}
          rows={[
            ['商品 URL 抓取（Shopify / Etsy / Fallback）', 'P0', '保留', '核心入口，无此功能产品无法启动'],
            ['AI 场景图生成（Flux.1 + ControlNet）', 'P0', '保留', '核心差异化，是用户付费的直接动机'],
            ['2:3 Pinterest 图', 'P0', '保留', '基础格式，生成主尺寸'],
            ['1:1 Instagram Feed 图（Outpainting）', 'P0', '保留', '扩图逻辑简单，单方向扩，风险低'],
            ['AI 文案生成（双平台差异化）', 'P0', '保留', '文案是发布必需项，GPT-4o 成本极低'],
            ['用户预览 + 手动编辑界面', 'P0', '保留', '降低卖家心理门槛，是信任建立的关键步骤'],
            ['Pinterest 普通 Pin 发布', 'P0', '保留', 'API 成熟，无前置审核依赖'],
            ['Instagram 普通 Feed 发布', 'P0', '保留', 'Content Publish API 权限相对独立，可先跑通'],
            ['9:16 Story / Reels 图', 'P1', '暂缓', 'Outpainting 幅度大，质量风险高；Reels 需视频格式'],
            ['Shopping Tag（Pinterest / Instagram）', '移除', '不做', '依赖链过长，不在本产品规划内，见独立 Extension PRD'],
            ['批量 SKU 处理', 'P1', '暂缓', '单品流程跑通后再扩展'],
            ['Reels 伪视频生成', 'P2', '暂缓', 'FFmpeg + 额外存储成本，MVP 阶段回报不明确'],
            ['多产品组合图 / UGC Remix', 'P2', '暂缓', '二期差异化功能，现阶段不在验证范围内'],
          ]}
          rowTone={[
            'success','success','success','success','success','success','success','success',
            'neutral','danger','neutral','neutral','neutral',
          ]}
          striped
        />
      </Stack>

      <Divider />

      {/* ── 用户画像（精简版）───────────────────────────────── */}
      <Stack gap={12}>
        <H2>用户画像与核心场景</H2>
        <Grid columns={2} gap={16}>
          <Card>
            <CardHeader>目标用户</CardHeader>
            <CardBody>
              <Stack gap={6}>
                <Text size="small"><Text as="span" weight="semibold">角色：</Text> 以<strong>家居</strong>为首发优势类目的独立站 / Etsy 卖家；扩展至 Fashion、Gift Guide、联盟变现等 Pinterest 高潜类目创作者</Text>
                <Text size="small"><Text as="span" weight="semibold">平台：</Text> Shopify / Etsy / 联盟链接，SKU 或链接批量，中小团队</Text>
                <Text size="small"><Text as="span" weight="semibold">团队：</Text> 1–3 人，无专职设计师</Text>
                <Text size="small"><Text as="span" weight="semibold">核心痛点：</Text> 不知道「什么样的 Pin 像能转化的 Pin」+ 空白 Prompt 门槛高 + 多平台制作耗时</Text>
              </Stack>
            </CardBody>
          </Card>
          <Card>
            <CardHeader>核心价值主张（P0 + 转化核心）</CardHeader>
            <CardBody>
              <Stack gap={6}>
                <Text size="small"><Text as="span" weight="semibold">Style-to-Pin：</Text> 先让用户看到「我的商品也能做成这种 Pinterest 图」——从<strong>可点击的爆款风格库</strong>（类目 Tab + 示例 Pin）进入，一键带入 Pin 类型、视觉风格、Prompt 预设、比例（2:3）、文案结构与关键词方向。</Text>
                <Text size="small">选定模板 + 粘贴商品 URL / 上传图（或 CSV 批量）→ 自动生成 → 预览 / 编辑 → 下载或排程发布 Pinterest + IG Feed</Text>
                <Text size="small">· 2:3 Pinterest 图 + SEO 文案；1:1 Instagram Feed 图 + Caption CTA（link in bio）</Text>
                <Text size="small">· <strong>默认模板库</strong>（Category / Pin Type / Visual Style）+ <strong>高级折叠</strong>「Advanced: Add custom direction」满足 Power User</Text>
                <Text size="small" tone="secondary">Instagram 购买引导仅通过 Caption CTA 实现；落地页<strong>先试后注册</strong>：Generate preview first → Save / download 再要求 signup（目标体验，可与 MVP 裁剪对齐）。</Text>
              </Stack>
            </CardBody>
          </Card>
        </Grid>
      </Stack>

      <Divider />

      {/* ── 核心功能（P0）────────────────────────────────── */}
      <Stack gap={14}>
        <H2>P0 核心功能模块</H2>

        {/* 模块 1 */}
        <Card collapsible defaultOpen={false}>
          <CardHeader trailing={<Pill tone="success" size="sm">P0 · 模块 1</Pill>}>
            商品同步 — Metadata Scraper
          </CardHeader>
          <CardBody>
            <Grid columns={2} gap={18}>
              <Stack gap={6}>
                <H3>抓取优先级</H3>
                <Stack gap={5}>
                  <Text size="small"><Text as="span" weight="semibold">Shopify：</Text> <Code>/products/{'{handle}'}.json</Code> 或 Storefront API</Text>
                  <Text size="small"><Text as="span" weight="semibold">Etsy：</Text> <Code>GET /v3/application/listings/{'{id}'}</Code></Text>
                  <Text size="small"><Text as="span" weight="semibold">Fallback：</Text> Playwright OG 标签 + JSON-LD 结构化数据</Text>
                </Stack>
              </Stack>
              <Stack gap={6}>
                <H3>输出字段</H3>
                <Text size="small"><Code>product_id</Code> · <Code>title</Code> · <Code>price</Code> · <Code>currency</Code> · <Code>image_url</Code> · <Code>product_url</Code> · <Code>category_tags</Code></Text>
                <Callout tone="warning" title="抓取失败降级">
                  若自动抓取失败，引导用户手动填写标题、价格并上传图片，不强制中断流程。
                </Callout>
              </Stack>
            </Grid>
          </CardBody>
        </Card>

        {/* 模块 2 */}
        <Card collapsible defaultOpen={true}>
          <CardHeader trailing={<Pill tone="success" size="sm">P0 · 模块 2</Pill>}>
            AI 视觉引擎 — 场景生成 + 双尺寸适配
          </CardHeader>
          <CardBody>
            <Stack gap={14}>
              <Grid columns={2} gap={18}>
                <Stack gap={8}>
                  <H3>场景生成管线</H3>
                  <Stack gap={5}>
                    <Text size="small"><Text as="span" weight="semibold">Step 1：</Text> SAM 2（Replicate）前景分割，输出产品 binary mask</Text>
                    <Text size="small"><Text as="span" weight="semibold">Step 2：</Text> MiDaS depth map + canny edge 双重 ControlNet conditioning</Text>
                    <Text size="small"><Text as="span" weight="semibold">Step 3：</Text> Flux.1 Schnell 4-step，基础分辨率 1024×1536（2:3），~2s</Text>
                    <Text size="small"><Text as="span" weight="semibold">Step 4：</Text> 泊松融合 + 颜色谐调合成最终图</Text>
                    <Text size="small"><Text as="span" weight="semibold">Step 5（1:1）：</Text> Flux.1 Fill 对上下边缘 Outpainting，~1.5s</Text>
                  </Stack>
                </Stack>
                <Stack gap={8}>
                  <H3>平台风格差异化</H3>
                  <InfoBlock
                    label="Pinterest — 干净灵感图"
                    value="clean editorial, bright airy light, crisp shadows, high-key exposure, product-centered, white negative space"
                  />
                  <InfoBlock
                    label="Instagram — 有温度生活方式图"
                    value="warm film-grain, golden hour light, lifestyle props (mug/book), human-scale context, soft vignette"
                  />
                </Stack>
              </Grid>

              {/* 多维质量标准 */}
              <Divider />
              <H3>AI 图片多维质量评估标准</H3>
              <Callout tone="danger" title="核心约束">
                AI 生成图必须保留商品核心外观，不得改变材质、颜色、结构和尺寸比例。家居商品（灯具、藤编、木纹、布料）AI 极易"美化过度"，虚假效果会直接引发售后纠纷和虚假宣传风险。
              </Callout>
              <Table
                headers={['质量维度', '检测方法', '通过标准', '失败处理']}
                rows={[
                  ['产品一致性', 'CLIP 图文相似度（产品图 vs 生成图）', 'CLIP Score > 0.28', '重试 1 次，仍失败进入人工选择'],
                  ['产品完整性', '检测 mask 区域是否被遮挡 / 截断', 'mask 覆盖率 > 95%', '重新生成，调整产品位置'],
                  ['场景自然度', 'Aesthetic Score（LAION 美学分类器）', '> 6.0 / 10', '重试 1 次'],
                  ['颜色保真度', 'HSV 直方图对比（产品区域）', 'ΔE < 15（CIELAB）', '颜色谐调参数调整后重试'],
                  ['平台适配度', '人工抽样评分（每周 50 张）', '> 85% 评分合格', '调整 style prompt 权重'],
                  ['文案一致性', 'GPT-4o 二次校验：文案是否准确描述商品', '无明显错误描述', '重新生成文案'],
                ]}
                striped
              />
            </Stack>
          </CardBody>
        </Card>

        {/* 模块 3 */}
        <Card collapsible defaultOpen={true}>
          <CardHeader trailing={<Pill tone="success" size="sm">P0 · 模块 3</Pill>}>
            用户预览与发布控制（人工把关节点）
          </CardHeader>
          <CardBody>
            <Stack gap={14}>
              <Grid columns={2} gap={18}>
                <Stack gap={8}>
                  <H3>默认发布模式</H3>
                  <Text size="small">MVP 默认<Text as="span" weight="semibold">非全自动</Text>，而是：</Text>
                  <div style={{ padding: '12px 14px', background: theme.fill.tertiary, borderRadius: 5, borderLeft: `3px solid ${theme.accent.primary}` }}>
                    <Text size="small" weight="semibold">自动生成 → 用户预览 → 一键发布</Text>
                    <Text size="small" tone="secondary" style={{ marginTop: 4 }}>Dashboard 展示两套图（2:3 / 1:1）和两套文案，用户可直接点"发布"或先编辑文案 / 重新生成图片</Text>
                  </div>
                  <Text size="small" tone="secondary">降低卖家心理门槛，是信任建立的关键步骤。全自动发布作为高级设置，不作为 MVP 默认。</Text>
                </Stack>
                <Stack gap={8}>
                  <H3>发布控制面板设置项</H3>
                  <Stack gap={5}>
                    <Text size="small"><Code>auto_publish</Code> — 开 / 关（默认关，需手动确认）</Text>
                    <Text size="small"><Code>review_image</Code> — 图片生成后是否需审核（默认开）</Text>
                    <Text size="small"><Code>review_copy</Code> — 文案生成后是否需审核（默认开）</Text>
                    <Text size="small"><Code>platforms</Code> — 仅 Pinterest / 仅 IG / 双平台（默认双平台）</Text>
                    <Text size="small"><Code>daily_limit</Code> — 每日最大发布数（默认 10，防止超 IG Rate Limit）</Text>
                    <Text size="small"><Code>schedule_time</Code> — 预约发布时间（可选，UTC）</Text>
                  </Stack>
                </Stack>
              </Grid>
            </Stack>
          </CardBody>
        </Card>

        {/* 模块 4 */}
        <Card collapsible defaultOpen={false}>
          <CardHeader trailing={<Pill tone="success" size="sm">P0 · 模块 4</Pill>}>
            双平台发布 — Pinterest v5 API + Meta Graph API（普通帖子）
          </CardHeader>
          <CardBody>
            <Grid columns={2} gap={18}>
              <Stack gap={6}>
                <H3>Pinterest 普通 Pin</H3>
                <Stack gap={4}>
                  <Text size="small">1. <Code>POST /v5/media</Code> 上传 2:3 图，获取 <Code>media_id</Code></Text>
                  <Text size="small">2. <Code>POST /v5/pins</Code> 创建 Pin（标题 + 描述 + Board ID）</Text>
                  <Text size="small">3. 写回 <Code>pin_id</Code> / <Code>pin_url</Code></Text>
                  <Text size="small" tone="secondary">所需权限：<Code>pins:read</Code> + <Code>pins:write</Code> + <Code>boards:read</Code></Text>
                </Stack>
              </Stack>
              <Stack gap={6}>
                <H3>Instagram Feed 发布（含 Caption CTA）</H3>
                <Stack gap={4}>
                  <Text size="small">1. <Code>POST /{'{ig-user-id}'}/media</Code>（image_url + caption）</Text>
                  <Text size="small">2. <Code>POST /{'{ig-user-id}'}/media_publish</Code>（creation_id）</Text>
                  <Text size="small">3. 写回 <Code>ig_media_id</Code> / <Code>ig_permalink</Code></Text>
                  <Text size="small" tone="secondary">所需权限：<Code>instagram_basic</Code> + <Code>instagram_content_publish</Code>，仅此两项，无任何 Commerce 相关权限</Text>
                </Stack>
              </Stack>
            </Grid>
          </CardBody>
        </Card>

        {/* 模块 5 */}
        <Card collapsible defaultOpen={true}>
          <CardHeader trailing={<Pill tone="success" size="sm">P0 · 模块 5</Pill>}>
            智能文案 — GPT-4o 双平台差异化生成 + Caption CTA
          </CardHeader>
          <CardBody>
            <Grid columns={2} gap={18}>
              <Stack gap={8}>
                <H3>Pinterest（SEO 驱动）</H3>
                <Stack gap={5}>
                  <Text size="small"><Text as="span" weight="semibold">标题：</Text> 品类词 + 风格词 + 使用场景（≤ 100 字符）</Text>
                  <Text size="small"><Text as="span" weight="semibold">描述：</Text> 3–5 句，含 3 个 Pinterest Trends 热词</Text>
                  <Text size="small"><Text as="span" weight="semibold">末句 CTA（固定格式）：</Text></Text>
                  <InfoBlock label="示例" value="Shop this look at [店铺名] — link in bio." />
                  <Text size="small" tone="secondary">Prompt 约束：禁 Emoji，语义密度优先，不得捏造商品属性</Text>
                </Stack>
              </Stack>
              <Stack gap={8}>
                <H3>Instagram（情绪驱动 + Link-in-Bio CTA）</H3>
                <Stack gap={5}>
                  <Text size="small"><Text as="span" weight="semibold">结构：</Text> Hook 句 + 场景叙事 2–3 行 + CTA 行 + 空行 + Hashtags</Text>
                  <Text size="small"><Text as="span" weight="semibold">CTA 行（二选一，系统随机 A/B）：</Text></Text>
                  <InfoBlock label="选项 A" value="Shop this look via the link in bio." />
                  <InfoBlock label="选项 B" value="Tap the link in bio to bring this piece home." />
                  <Text size="small"><Text as="span" weight="semibold">Hashtags：</Text> 15–25 个，大 / 中 / 小体量混合，GPT-4o 按品类动态生成</Text>
                  <Text size="small" tone="secondary">CTA 是唯一的购买引导入口（无 Shopping Tag），措辞须自然融入叙事，不显突兀</Text>
                </Stack>
              </Stack>
            </Grid>
            <Callout tone="neutral" style={{ marginTop: 12 }}>
              用户可在预览界面直接编辑任意文案内容。A/B CTA 表现数据（点击 bio 链接率）在 v1.2 Analytics 模块中统计，MVP 阶段记录用户修改了哪套 CTA 作为定性参考。
            </Callout>
          </CardBody>
        </Card>
      </Stack>

      <Divider />

      {/* ── Onboarding Flow ────────────────────────────────── */}
      <Stack gap={12}>
        <H2>用户 Onboarding Flow（一级模块）</H2>
        <Text tone="secondary" size="small">Onboarding 质量直接决定激活率。每一步均需提供跳过选项和状态提示，不强制阻断流程。</Text>
        <Callout tone="success" title="与落地页联动的理想路径（转化优先 · 可与全功能 OAuth 并行迭代）">
          用户点击某风格「Use this style / Make Pins Like This」→ 弹层：粘贴商品 URL 或上传图 → 自动读商品信息并套用该 Pin 风格 → 生成若干变体（如 3）→ 预览 / 编辑 / 下载。<strong>先出预览再注册</strong>；连接 Pinterest / IG 可在「保存、排程、一键发布」环节再引导。
        </Callout>

        <Table
          headers={['步骤', '内容', '可选/必须', '失败处理']}
          rows={[
            ['Step 1', '注册 / 登录（Email 或 Google OAuth）', '必须（全功能链路）／ landing 可先跳过', '—'],
            ['Step 1b（推荐）', '从 Pin 风格库选模板 · 或使用 Hero「Paste URL」直达', '强烈推荐', '无 URL 可走 Demo'],
            ['Step 2', '粘贴商品链接 / 上传图 /（未来）CSV 批量', '必须', '提供 Demo · 抓取失败手动填'],
            ['Step 3', '连接 Pinterest（OAuth）', '发布前必须', '失败则仅下载素材'],
            ['Step 4', '连接 Instagram（Meta OAuth）', '建议', '可跳过'],
            ['Step 5', '确认模板参数：Pin Type / Visual Style / 比例 2:3 · 文案结构', '必须', '默认值来自所选模板'],
            ['Step 5b', 'Advanced：自定义一句方向（luxury editorial / cozy vintage 等）', '可选', '折叠收纳'],
            ['Step 6', '平台授权健康检查（Eligibility）', '自动', '异常标红'],
            ['Step 7', '生成预览（多变体）', '自动', '失败重试 · 降级'],
            ['Step 8', '确认发布或导出', '用户操作', '—'],
          ]}
          striped
        />

        <H3>Dashboard 平台状态看板</H3>
        <Table
          headers={['项目', '状态示例', '异常时提示']}
          rows={[
            ['Pinterest 账号授权', '已授权（@username）', '点击重新授权'],
            ['Instagram 账号授权', '已授权（@username）', '需专业账号，点此转换'],
            ['今日 IG 发布额度', '8 / 25（已发布 8 条）', '超限自动排队，显示预计时间'],
            ['商品任务队列', '3 条处理中 / 12 条已完成', '失败条目一键重试'],
          ]}
          striped
        />
      </Stack>

      <Divider />

      {/* ── 数据流 ─────────────────────────────────────────── */}
      <Stack gap={12}>
        <H2>P0 业务逻辑数据流</H2>
        <Text tone="secondary" size="small">人工把关节点（预览/编辑）是核心设计，不可绕过。Pinterest / Instagram 并行发布，独立失败不互相阻塞。</Text>
        <DataFlowDiagram />
        <Grid columns={2} gap={18}>
          <Stack gap={6}>
            <H3>任务状态机</H3>
            <Text size="small">
              <Code>pending</Code> → <Code>scraping</Code> → <Code>generating</Code> →
              <Code>copywriting</Code> → <Code>awaiting_review</Code> →
              <Code>publishing</Code> → <Code>done</Code>
            </Text>
            <Text size="small" tone="secondary"><Code>awaiting_review</Code> 阶段暂停等待用户确认，超 48h 未操作自动归档</Text>
            <Text size="small" tone="secondary">Pinterest 与 Instagram 在 <Code>publishing</Code> 阶段 asyncio.gather 并行，各自独立写回状态</Text>
          </Stack>
          <Stack gap={6}>
            <H3>关键字段流转</H3>
            <Stack gap={4}>
              <Text size="small"><Text as="span" weight="semibold">AI 输出：</Text> <Code>img_2x3_url</Code> / <Code>img_1x1_url</Code></Text>
              <Text size="small"><Text as="span" weight="semibold">文案输出：</Text> <Code>copy_pinterest</Code> / <Code>copy_instagram</Code></Text>
              <Text size="small"><Text as="span" weight="semibold">发布写回：</Text> <Code>pin_id</Code> / <Code>ig_media_id</Code> / <Code>published_at</Code></Text>
            </Stack>
          </Stack>
        </Grid>
      </Stack>

      <Divider />

      {/* ── 失败降级策略 ───────────────────────────────────── */}
      <Stack gap={12}>
        <H2>失败降级策略</H2>
        <Text tone="secondary" size="small">用户不在乎技术链路多复杂，只在乎"失败时还能不能继续用"。每个失败点必须有可用的兜底路径。</Text>
        <Table
          headers={['失败节点', '触发条件', '兜底策略', '用户感知']}
          rows={[
            ['商品 URL 抓取失败', 'API 超时 / 平台限制 / URL 格式不支持', '弹出手动填写表单（标题、价格、图片上传）', '提示"自动识别失败，请手动填写"，流程继续'],
            ['图片分割失败（SAM 2）', 'Replicate 超时 / 图片质量过低', '使用原图直接作为前景 + 纯色/纹理背景模板', '标注"基础模式"，提示可上传更高清主图'],
            ['AI 图质量不达标', 'CLIP Score 低 / Aesthetic Score 低', '自动重试最多 2 次（换随机 seed）；仍不达标进入人工选择（展示全部候选图）', '提示"正在优化图片质量"，用户可手动选择'],
            ['Outpainting 接缝明显', '边缘过渡分数低', '自动重试 1 次（调整 boundary padding）；失败则裁剪 2:3 图为 1:1（居中裁剪）', '展示裁剪版，标注"裁剪模式"'],
            ['Pinterest OAuth 失败', 'Token 过期 / 权限不足', '仅生成素材并提供下载，不执行发布；提示重新授权', '图片 + 文案可下载，手动发布'],
            ['Instagram 权限不足', '<Code>instagram_content_publish</Code> 未授权', '降级：提供"复制 Caption + 下载图片"一键操作，用户手动发 IG', '明确提示所缺权限及申请步骤'],
            ['IG Rate Limit 超限', '24h 发布超 25 次', '自动入队，次日 0:00 UTC 继续；Dashboard 显示排队位置和预计时间', '提示"今日额度已满，已安排明日发布"'],
            ['GPT-4o 文案生成失败', 'API 超时 / 内容政策拦截', '使用商品标题填充最简模板（标题 + 品类词 + 默认 Hashtag 集）', '提示"文案自动生成失败，使用基础模板"，可手动编辑'],
            ['双平台发布部分失败', '某一平台发布成功，另一平台失败', '已发布平台写回状态；失败平台标记 failed，提供单独重试按钮', 'Dashboard 分别显示两平台状态'],
          ]}
          striped
        />
      </Stack>

      <Divider />

      {/* ── 技术架构 ─────────────────────────────────────── */}
      <Stack gap={12}>
        <H2>技术架构（P0 MVP · 6 周交付）</H2>
        <Table
          headers={['层级', '选型', '职责', '月成本']}
          rows={[
            ['前端', 'Next.js 15 + Tailwind → Vercel', '落地页、Dashboard、预览编辑、SSE 进度、OAuth 回调', '~$0（Hobby）'],
            ['后端 API', 'Python 3.12 + FastAPI → Railway', '抓取、调度、Pinterest + Meta API 封装', '~$5–20'],
            ['AI 场景生成', 'ComfyUI + Flux.1 Schnell → RunPod Serverless', '4-step 场景背景生成，~2s/张', '~$0.002/张'],
            ['AI Outpainting', 'Flux.1 Fill → RunPod Serverless', '1:1 边缘扩图，~1.5s/次', '~$0.002/次'],
            ['前景分割', 'SAM 2 → Replicate API', '产品 mask 提取', '~$0.005/次'],
            ['图像合成', 'Pillow + OpenCV → Railway Worker', '泊松融合、颜色谐调、裁剪', '含后端'],
            ['文案生成', 'OpenAI GPT-4o API', '双平台文案，每品 ~$0.003', '按量'],
            ['数据库 + 存储', 'Supabase（PostgreSQL + Storage CDN）', '全部资产托管', '~$0（Free）'],
            ['任务队列', 'Upstash Redis + ARQ', '多步骤异步任务，状态机，重试', '~$0（Free）'],
            ['用户认证', 'Supabase Auth', '邮箱 + Google OAuth', '~$0'],
            ['监控', 'Sentry + PostHog', '错误追踪 + 用户漏斗', '~$0（Free）'],
          ]}
          striped
        />
      </Stack>

      <Divider />

      {/* ── 成本三档估算 ──────────────────────────────────── */}
      <Stack gap={12}>
        <H2>成本三档估算（单品跨平台完整处理）</H2>
        <Text tone="secondary" size="small">商业定价应基于中位成本而非理想路径成本。$0.012 仅是无任何重试的最优情况，不应作为定价基准。</Text>
        <Table
          headers={['路径场景', '包含步骤', '估算成本', '适用定价参考']}
          rows={[
            ['理想路径（无重试）', 'SAM2 + Flux×1 + Outpainting×1 + GPT-4o×1 + 存储', '$0.012–0.02', '不建议用于定价，过于乐观'],
            ['常规路径（含 1 次局部重试）', '上述 + 质量不达标重试 1 次（+Flux×1）', '$0.025–0.05', '建议作为定价成本基准'],
            ['高质量路径（多图候选 + 人工选择）', '生成 3 张候选 + Outpainting×3 + 人工选图', '$0.06–0.12', 'Pro 套餐定价参考（3–5 美元/品可盈利）'],
          ]}
          rowTone={['success', 'neutral', 'info']}
        />
        <Grid columns={3} gap={14}>
          <InfoBlock label="容易超预算的项目" value="SAM 2 分割 · Outpainting 多次 · 失败重试 · CDN 存储 · GPT-4o 文案 · 队列日志存储" />
          <InfoBlock label="中位成本对应定价" value="Starter $19/月（~380 品），Growth $49/月（~980 品），成本占收入约 25–50%" />
          <InfoBlock label="规模化优化路径" value="RunPod 专属实例（降低 GPU 成本 40%）· 批量推理合并 · 图片复用（同款不同风格）" />
        </Grid>
      </Stack>

      <Divider />

      {/* ── 成功指标（两类分开）──────────────────────────── */}
      <Stack gap={12}>
        <H2>MVP 成功指标</H2>
        <Text tone="secondary" size="small">产品效率指标衡量工具本身是否好用；营销效果指标不写死绝对值，以用户自身历史基准为对比，避免因账号差异导致指标失真。</Text>

        <H3>产品效率指标（工具好不好用）</H3>
        <Table
          headers={['指标', '目标', '衡量方式', '评测周期']}
          rows={[
            ['单品生成耗时', '< 5 min（全流程）', '任务日志 scraping_at → awaiting_review_at', '上线首周'],
            ['用户首次成功发布率', '> 70%（注册后 7 天内完成首发）', 'PostHog 激活漏斗', '首批用户满 7 天'],
            ['任务整体成功率', '> 90%（含降级成功）', '数据库 task status 统计', '持续监控'],
            ['AI 图片通过率', '> 85%（多维检测全过）', '质检模块日志', '持续监控'],
            ['文案人工修改率', '< 40%（用户不修改直接发布）', 'PostHog 编辑事件', '持续监控'],
            ['30 天用户留存率', '> 40%', 'PostHog 队列分析', '首批用户满 30 天'],
            ['Free Trial → 付费转化率', '> 15%', 'Stripe 订阅事件', '前 3 个月'],
          ]}
          striped
        />

        <H3>营销效果指标（内容效果，对比用户自身历史基准）</H3>
        <Table
          headers={['指标', '目标', '说明', '衡量方式']}
          rows={[
            ['Pinterest Pin CTR 提升', '比用户历史基准 +100%（即翻倍）', '不写死 3%，因账号粉丝量 / 品类差异大', 'Pinterest Analytics API，对比用户开通前 30 天均值'],
            ['Instagram Feed 互动率提升', '比用户历史基准 +50%', '同理，互动率受账号量级影响显著', 'Meta Graph API insights，对比历史均值'],
            ['内容发布频率提升', '使用本工具后发布频率 ≥ 使用前 3 倍', '验证"效率"核心价值是否兑现', '数据库 published_at 时间戳统计'],
          ]}
          striped
        />
      </Stack>

      <Divider />

      {/* ── 商业模式 ─────────────────────────────────────── */}
      <Stack gap={12}>
        <H2>商业模式假设（Pricing Hypothesis）</H2>
        <Text tone="secondary" size="small">核心收费点是 AI 场景图生成量，而非发布次数本身。Reels、批量处理、Analytics 作为付费套餐差异化壁垒。</Text>
        <Table
          headers={['版本', '价格', 'AI 图额度', '平台', '核心权益', '目标用户']}
          rows={[
            ['Free Trial', '$0', '10 品次', '1 平台', '全功能体验 · 图片带水印', '拉新激活 · 不限时'],
            ['Starter', '$19/月', '100 品次', 'Pinterest + IG Feed', '无水印 · 基础文案', 'Etsy 小卖家，SKU < 50'],
            ['Growth', '$49/月', '500 品次', 'Pinterest + IG Feed', '批量处理 · 去水印 · 风格模板', 'Shopify 卖家，SKU 50–200'],
            ['Pro', '$99/月', '2000 品次', '双平台全功能', 'Reels · 发布日历 · Analytics · 团队协作 · 品牌模板', '规模化卖家，SKU 200+'],
          ]}
          rowTone={['neutral', 'success', 'success', 'info']}
        />
        <Grid columns={2} gap={16}>
          <InfoBlock label="定价验证方法" value="MVP 阶段先跑 Free Trial → Starter 转化率；若 > 15% 则验证愿意付费；3 个月后再测 Growth / Pro 升级意愿" />
          <InfoBlock label="LTV / CAC 目标" value="Starter 年 LTV $228，Growth $588，目标 LTV/CAC > 3x；CAC 通过 Pinterest / Instagram 自然流量 + SEO 控制在 $40 以内" />
        </Grid>
      </Stack>

      <Divider />

      {/* ── 合规与安全 ────────────────────────────────────── */}
      <Stack gap={12}>
        <H2>合规与安全</H2>
        <Text tone="secondary" size="small">本产品处理用户 OAuth Token、商品图片、平台账号权限，合规问题一旦出现可导致账号封禁或法律风险。</Text>
        <Table
          headers={['风险项', '具体场景', '建议措施']}
          rows={[
            ['OAuth Token 泄露', '数据库被攻击 / 日志暴露 Token', 'AES-256 加密存储；Token 不写入应用日志；定期轮换提醒'],
            ['AI 图虚假宣传', 'AI 改变产品颜色 / 材质 / 尺寸后发布', '质检层强制颜色保真度检测；用户协议注明 AI 图仅用于场景展示，不代替真实商品图'],
            ['用户图片版权', '用户上传非自有商品图', 'Onboarding 时用户勾选确认拥有图片使用权；不储存用户原始图超 90 天'],
            ['平台政策合规', 'Pinterest / Meta API 使用条款变更', '订阅两平台 Changelog；API 使用严格限于授权范围，不做爬虫滥用'],
            ['数据删除权', '用户注销账号时数据保留', '账号注销 → 7 天内清除：图片资产、Metadata、OAuth Token、发布记录'],
            ['审计日志', '谁在何时发布了什么', '所有发布操作写入 audit_log 表（user_id + action + timestamp + platform + content_id），保留 180 天'],
          ]}
          striped
        />
      </Stack>

      <Divider />

      {/* ── 落地页设计规格 ────────────────────────────────── */}
      <Stack gap={14}>
        <H2>落地页设计规格 · 高转化 Pin 灵感库 + Style-to-Pin</H2>
        <Text tone="secondary" size="small">
          首屏目标：让用户<strong>先看到</strong>「原来我的商品也能生成这种 Pinterest 图」——做成<strong>可点击的爆款风格库 + 一键同款参数</strong>（非空白 Prompt）。不暴露技术细节。设计稿协同：<Text as="span" weight="semibold">social-flow-landing-page.canvas.tsx</Text>（须与本节对齐）。
        </Text>

        <Callout tone="success" title="对外文案禁区与推荐用语">
          <Text size="small">推荐：<Code>Create similar Pinterest-style Pins</Code> · <Code>Make Pins Like This</Code> · <Code>Use this template</Code></Text>
          <Text size="small" style={{ marginTop: 6 }}>价值句：<strong>Start with a proven Pin style. Customize it with your own product.</strong>（从高转化 Pin 风格开始，用自有商品生成类似风格的内容。）</Text>
          <Text size="small" tone="secondary" style={{ marginTop: 6 }}>避免：<Code>Copy viral Pins</Code>、「复制爆款」等易被解读为抄袭的表述——「同款」仅指<strong>风格参考</strong>。</Text>
        </Callout>

        <Card>
          <CardHeader>推荐首屏 Hero（英文可复制）</CardHeader>
          <CardBody>
            <Grid columns={2} gap={16}>
              <Stack gap={5}>
                <Text size="small"><Text as="span" weight="semibold">主标题：</Text> Turn Product Links Into Pinterest-Ready Pins</Text>
                <Text size="small"><Text as="span" weight="semibold">副标题：</Text> Choose a proven Pin style, add your product link, and generate scroll-stopping Pinterest images, titles, descriptions, and keywords in minutes.</Text>
                <Text size="small"><Text as="span" weight="semibold">主 CTA：</Text> Generate Free Pins</Text>
                <Text size="small"><Text as="span" weight="semibold">输入框占位：</Text> Paste your product URL</Text>
                <Text size="small"><Text as="span" weight="semibold">次 CTA：</Text> Browse Pin Styles</Text>
              </Stack>
              <Stack gap={5}>
                <Text size="small"><Text as="span" weight="semibold">布局：</Text> 非单张 Hero — 右侧或首屏下方为<strong>视觉墙</strong>（多枚示例 Pin 缩略图），传递「风格库」心智。</Text>
                <Text size="small"><Text as="span" weight="semibold">首屏必露三类示例（跨类目）：</Text> Fashion outfit collage · Home decor scene · Gift guide roundup — 表明非仅家居工具。</Text>
              </Stack>
            </Grid>
          </CardBody>
        </Card>

        <H3>High-Converting Pin Styles — 类目 Tab + 模板墙</H3>
        <Text tone="secondary" size="small">Tab：<Code>Fashion</Code> · <Code>Home Decor</Code> · <Code>Beauty</Code> · <Code>Food</Code> · <Code>Gift Guides</Code> · <Code>Digital Products</Code>。每 Tab 展示 6–9 张示例 Pin；每张下设 <Code>Use this style</Code> / <Code>Make Pins Like This</Code>。</Text>
        <Table
          headers={['类目', '示例 Pin 方向']}
          rows={[
            ['Fashion', 'Outfit collage · Street style · Seasonal capsule wardrobe'],
            ['Home Decor', 'Cozy room scene · Product moodboard · Giftable decor'],
            ['Beauty', 'Product flat lay · Routine steps · Before/after'],
            ['Food', 'Recipe pin · Ingredient layout · Healthy snack guide'],
            ['Gift Guides', 'Gifts for Her · Holiday guide · Amazon/Etsy roundup'],
            ['Digital', 'Planner mockup · Template showcase · Course promo'],
          ]}
          striped
        />

        <H3>风格分区标题文案</H3>
        <InfoBlock label="标题" value="Start With a Pin Style That Already Works" />
        <InfoBlock label="副标题" value="Choose from fashion, home, beauty, food, gift guide, and affiliate-style Pin templates. Then generate your own version with your product." />

        <H3>模板卡片（节选 · 每张含 Best for / Output / CTA）</H3>
        <Table
          headers={['模板名', 'Best for', 'Output', '按钮']}
          rows={[
            ['Outfit Collage Pin', 'Fashion, accessories, seasonal outfits', 'Collage-style visual + SEO title + shopping-ready description', 'Use this style'],
            ['Cozy Room Scene Pin', 'Home decor, furniture, lighting, rugs', 'Lifestyle scene + decor-inspired Pin copy', 'Use this style'],
            ['Gift Guide Pin', 'Affiliate, Etsy, seasonal campaigns', 'Multi-product guide angle + gift-focused title', 'Use this style'],
            ['Routine Steps / Flat Lay / Before–After', 'Beauty SKUs', '步骤感或平铺 + 对应文案结构', 'Use this template'],
          ]}
          striped
        />

        <H3>用户点击「Use this style」后 — 轻量流程</H3>
        <Text size="small">
          1 点击模板 → 2 弹层：Paste product URL / Upload image → 3 自动读商品信息 → 4 套用该 Pin 风格（Pin Type / Visual Style / Prompt preset / 2:3 / 文案结构 / 关键词方向）→ 5 生成多变体（如 3）→ 6 预览、编辑、下载或排程。<strong>不要求先连接 Pinterest。</strong>
        </Text>

        <H3>「一商品多风格」示例区</H3>
        <Text tone="secondary" size="small">区块标题：<Code>See How One Product Becomes Multiple Pin Styles</Code></Text>
        <Table
          headers={['示例输入', '多风格输出']}
          rows={[
            ['一件连衣裙', 'Outfit collage / Summer style angle / Gift guide angle'],
            ['一盏灯（家居）', 'Cozy room / Minimal decor / Warm vintage'],
            ['一瓶护肤品', 'Flat lay / Routine steps / Luxury editorial'],
          ]}
          striped
        />

        <H3>推荐整页章节顺序（10 段）</H3>
        <Stack gap={4}>
          <Text size="small">1 Hero（标题 + URL + Generate Free Pins + Browse Pin Styles）· 2 Product URL · 3 <strong>Pin Style Gallery</strong>（类目 Tab · 模板墙——转化核心）</Text>
          <Text size="small">4 How it works：Choose style → Add product → Generate → Review &amp; Schedule · 5 Before/After（商品图 → Pin）</Text>
          <Text size="small">6 Bulk workflow（如 50 links → 150 Pins 叙事）· 7 Template library（Pin types + visual styles · 折叠 Advanced prompt）</Text>
          <Text size="small">8 Pricing · 9 FAQ · （可选）Social proof</Text>
        </Stack>

        <Grid columns={2} gap={16}>
          <Card>
            <CardHeader>产品差异化心智：Style-to-Pin Workflow</CardHeader>
            <CardBody>
              <Stack gap={5}>
                <Text size="small">Browse proven styles → Pick a style → Add product links → Generate <strong>similar</strong> Pins（合规表述）</Text>
                <Text size="small" tone="secondary">对比仅「Paste URL → Generate」：降低「不知道写什么」的空白页焦虑。</Text>
              </Stack>
            </CardBody>
          </Card>
          <Card>
            <CardHeader>模板与自定义（非二选一）</CardHeader>
            <CardBody>
              <Stack gap={5}>
                <Text size="small"><Text as="span" weight="semibold">默认：</Text>模板库 — Category · Pin Type · Visual Style（覆盖约 80% 用户）</Text>
                <Text size="small"><Text as="span" weight="semibold">高级：</Text>折叠 <Code>Advanced: Add custom direction</Code>（例：luxury fall editorial / cozy vintage room）</Text>
              </Stack>
            </CardBody>
          </Card>
        </Grid>

        <Table
          headers={['竞品参考', '借鉴要点', '本产品差异化']}
          rows={[
            ['BlogToPin', '首屏 URL + 右侧 Pin 阵列', '+ 类目 Tab 风格库 + 模板元数据（Best for / Output）+ Style-to-Pin'],
            ['Pin Generator', 'ROI 计算器', '保留计算器 + 绑定「选一风格再生成」路径'],
            ['泛用 AI 写作工具', '—', '先选 Pin 范式，再填空商品，降低 Prompt 摩擦'],
          ]}
          striped
        />
      </Stack>

      <Divider />

      {/* ── 路线图 ───────────────────────────────────────── */}
      <Stack gap={12}>
        <H2>版本路线图</H2>
        <Grid columns={3} gap={14}>
          <Card>
            <CardHeader trailing={<Pill tone="success" size="sm">6 周</Pill>}>
              MVP v1.0（P0）
            </CardHeader>
            <CardBody>
              <Stack gap={5}>
                <Text size="small">· 商品 URL 抓取（含手动降级）</Text>
                <Text size="small">· AI 场景图 2:3 + 1:1（与所选模板风格联动）</Text>
                <Text size="small">· 落地页：<strong>Pin Style Gallery</strong>（类目 Tab · 示例墙 · Use this style）</Text>
                <Text size="small">· <strong>模板预设</strong>写入生成：Pin Type / Visual / prompt 骨架 / 2:3 / 文案结构 · 折叠 Advanced 自定义</Text>
                <Text size="small">· GPT-4o 双平台文案</Text>
                <Text size="small">· 用户预览 + 编辑界面</Text>
                <Text size="small">· Pinterest + IG Feed 普通发布</Text>
                <Text size="small">· 基础任务状态机 + 失败降级</Text>
                <Text size="small">· Onboarding Flow</Text>
                <Text size="small">· Dashboard 状态看板</Text>
              </Stack>
            </CardBody>
          </Card>
          <Card>
            <CardHeader trailing={<Pill tone="warning" size="sm">3 个月后</Pill>}>
              v1.2（P1 · 商业化增强）
            </CardHeader>
            <CardBody>
              <Stack gap={5}>
                <Text size="small">· 9:16 Story 图（Outpainting）</Text>
                <Text size="small">· 批量 SKU 处理</Text>
                <Text size="small">· 发布日历 / 预约发布</Text>
                <Text size="small">· Analytics Dashboard（CTR + 互动率）</Text>
              </Stack>
            </CardBody>
          </Card>
          <Card>
            <CardHeader trailing={<Pill tone="neutral" size="sm">6 个月后</Pill>}>
              v2.0（P2 · 差异化壁垒）
            </CardHeader>
            <CardBody>
              <Stack gap={5}>
                <Text size="small">· Reels 伪视频生成</Text>
                <Text size="small">· 多产品组合图（Room Set）</Text>
                <Text size="small">· UGC 评论图 AI 增强</Text>
                <Text size="small">· A/B 测试（风格 / 文案）</Text>
                <Text size="small">· 品牌风格 LoRA 微调</Text>
                <Text size="small">· 团队协作 + 权限管理</Text>
                <Text size="small">· TikTok / Facebook 扩展</Text>
              </Stack>
            </CardBody>
          </Card>
        </Grid>
      </Stack>

      <Text tone="quaternary" size="small" style={{ marginTop: 4 }}>
        Social Flow MVP PRD · v2.1 · 2026-05-13 · 内部研发 &amp; 早期投资人参阅
      </Text>

    </Stack>
  );
}
