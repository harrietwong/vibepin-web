import {
  Stack, H1, H2, H3, Text, Grid, Row, Stat, Divider,
  Card, CardHeader, CardBody, Table, Callout, Pill, Code,
  useHostTheme, computeDAGLayout,
} from 'cursor/canvas';

/**
 * VibePin PRD v6.0 — Current State Document
 * 基于 2026-06-05 实际代码状态重写。
 * 历史版本：v4.0 Growth OS · v5.0 Data Intelligence Refresh
 *
 * 本文档用途：
 *   - 完整描述当前已上线的功能、取数逻辑、跳转逻辑
 *   - 作为新成员 onboarding 和产品评审的参考基准
 *   - 替代旧版 PRD，旧版仅供历史参考
 */

/* ══════════════════════════════════════════════════════════
   1. DATA PIPELINE DIAGRAM
   ══════════════════════════════════════════════════════════ */

const pipeNodes = [
  { id: 'seeds' }, { id: 'keywords' }, { id: 'pins' },
  { id: 'products' }, { id: 'scores' }, { id: 'view' },
];
const pipeEdges = [
  { from: 'seeds', to: 'keywords' },
  { from: 'keywords', to: 'pins' },
  { from: 'pins', to: 'products' },
  { from: 'products', to: 'scores' },
  { from: 'scores', to: 'view' },
];
const pipeLabel: Record<string, string> = {
  seeds:    'Interest Seeds',
  keywords: 'Trend Keywords',
  pins:     'Pin Evidence',
  products: 'Product Signals',
  scores:   'Score Engine',
  view:     'Opportunity View',
};
const pipeSub: Record<string, string> = {
  seeds:    'trend_interests',
  keywords: 'trend_keywords + crawl_queue',
  pins:     'pin_samples',
  products: 'pin_products (physical + digital)',
  scores:   'product_scores + keyword_product_map',
  view:     'trend_opportunities_view',
};
const pipeLayout = computeDAGLayout({
  nodes: pipeNodes, edges: pipeEdges,
  direction: 'horizontal',
  nodeWidth: 140, nodeHeight: 52,
  rankGap: 20, nodeGap: 14, padding: 16,
});

function PipelineDiagram() {
  const theme = useHostTheme();
  return (
    <div style={{ overflowX: 'auto' }}>
      <svg width={pipeLayout.width} height={pipeLayout.height + 8} style={{ display: 'block' }}>
        <defs>
          <marker id="pArr" markerWidth="7" markerHeight="7" refX="5" refY="3.5" orient="auto">
            <path d="M0,0 L0,7 L7,3.5 z" fill={theme.stroke.secondary} />
          </marker>
        </defs>
        {pipeLayout.edges.map((e, i) => (
          <line key={i}
            x1={e.sourceX} y1={e.sourceY}
            x2={e.targetX - 7} y2={e.targetY}
            stroke={theme.stroke.secondary} strokeWidth={1.5}
            markerEnd="url(#pArr)"
          />
        ))}
        {pipeLayout.nodes.map(node => {
          const isView = node.id === 'view';
          const fill   = isView ? theme.accent.primary : theme.fill.tertiary;
          return (
            <g key={node.id}>
              <rect x={node.x} y={node.y} width={140} height={52} rx={5}
                fill={fill} stroke={theme.stroke.primary} strokeWidth={1} />
              <text x={node.x + 70} y={node.y + 19} textAnchor="middle"
                fill={isView ? theme.text.onAccent : theme.text.primary}
                fontSize={10} fontFamily="system-ui, sans-serif" fontWeight={600}>
                {pipeLabel[node.id]}
              </text>
              <text x={node.x + 70} y={node.y + 36} textAnchor="middle"
                fill={isView ? theme.text.onAccent : theme.text.tertiary}
                fontSize={8.5} fontFamily="system-ui, sans-serif">
                {pipeSub[node.id]}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════
   2. USER FLOW DIAGRAM
   ══════════════════════════════════════════════════════════ */

const flowNodes = [
  { id: 'workspace' }, { id: 'research' }, { id: 'signals' },
  { id: 'create' }, { id: 'plan' },
];
const flowEdges = [
  { from: 'workspace', to: 'research' },
  { from: 'research',  to: 'signals' },
  { from: 'signals',   to: 'create' },
  { from: 'create',    to: 'plan' },
];
const flowLabel: Record<string, string> = {
  workspace: 'Workspace',
  research:  'Keyword / Pin 调研',
  signals:   'Product Signals',
  create:    'Create Pins',
  plan:      'Weekly Plan',
};
const flowSub: Record<string, string> = {
  workspace: '/app/workspace/[cat]',
  research:  '/app/trends · /app/discover',
  signals:   '/app/products',
  create:    '/app/studio',
  plan:      '/app/plan',
};
const flowLayout = computeDAGLayout({
  nodes: flowNodes, edges: flowEdges,
  direction: 'horizontal',
  nodeWidth: 132, nodeHeight: 52,
  rankGap: 20, nodeGap: 14, padding: 16,
});

function UserFlowDiagram() {
  const theme = useHostTheme();
  return (
    <div style={{ overflowX: 'auto' }}>
      <svg width={flowLayout.width} height={flowLayout.height + 8} style={{ display: 'block' }}>
        <defs>
          <marker id="fArr" markerWidth="7" markerHeight="7" refX="5" refY="3.5" orient="auto">
            <path d="M0,0 L0,7 L7,3.5 z" fill={theme.stroke.secondary} />
          </marker>
        </defs>
        {flowLayout.edges.map((e, i) => (
          <line key={i}
            x1={e.sourceX} y1={e.sourceY}
            x2={e.targetX - 7} y2={e.targetY}
            stroke={theme.stroke.secondary} strokeWidth={1.5}
            markerEnd="url(#fArr)"
          />
        ))}
        {flowLayout.nodes.map(node => (
          <g key={node.id}>
            <rect x={node.x} y={node.y} width={132} height={52} rx={5}
              fill={theme.accent.primary} stroke={theme.stroke.primary} strokeWidth={1} />
            <text x={node.x + 66} y={node.y + 19} textAnchor="middle"
              fill={theme.text.onAccent} fontSize={10}
              fontFamily="system-ui, sans-serif" fontWeight={600}>
              {flowLabel[node.id]}
            </text>
            <text x={node.x + 66} y={node.y + 36} textAnchor="middle"
              fill={theme.text.onAccent} fontSize={8.5} fontFamily="system-ui, sans-serif">
              {flowSub[node.id]}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════
   MAIN EXPORT
   ══════════════════════════════════════════════════════════ */

export default function VibePin_PRD_V6() {
  return (
    <Stack gap={28} style={{ padding: 36, maxWidth: 1100, margin: '0 auto' }}>

      {/* ── Header ── */}
      <Stack gap={8}>
        <Row gap={10} align="center">
          <H1>VibePin — PRD v6.0</H1>
          <Pill tone="success" active size="sm">Current State</Pill>
          <Pill tone="info" size="sm">2026-06-05</Pill>
        </Row>
        <Text tone="secondary">
          <strong>VibePin</strong> 是面向 Pinterest 创作者、Etsy/Shopify 卖家和 Affiliate Marketer 的一体化增长工具。
          它自动把 Pinterest 趋势信号 → Pin 证据 → 商品机会转化为可执行的内容计划与 AI 生成 Pin。
          本文档基于 2026-06-05 实际代码状态编写，是 v4.0 / v5.0 的替代版本。
        </Text>
        <Grid columns={4} gap={12}>
          <Stat value="7" label="已上线页面" tone="success" />
          <Stat value="2" label="商品类型（实物 + 数字）" />
          <Stat value="9" label="DB 核心表 / 视图" />
          <Stat value="6" label="后台 Pipeline 步骤" />
        </Grid>
      </Stack>

      <Divider />

      {/* ══ 1. 项目简介 ══ */}
      <Stack gap={12}>
        <H2>1. 项目简介</H2>
        <Grid columns={2} gap={14}>
          <Card>
            <CardHeader>产品定位</CardHeader>
            <CardBody>
              <Stack gap={6}>
                <Text size="small">
                  VibePin 是 Pinterest-first 的增长情报与内容生成平台。核心竞争力是
                  <strong>自建数据管线</strong>——后台脚本持续抓取 Pinterest 趋势关键词、
                  高收藏 Pin 和商品信号，落库后由前端多个页面消费，帮助用户做出选题、选品和内容决策。
                </Text>
                <Text size="small" tone="secondary">
                  一句话：发现 Pinterest 趋势 → 挖掘高机会商品 → AI 生成 Pin → 计划每周内容。
                </Text>
              </Stack>
            </CardBody>
          </Card>
          <Card>
            <CardHeader>目标用户</CardHeader>
            <CardBody>
              <Stack gap={6}>
                <Text size="small">· Affiliate Marketer — 寻找高转化商品在 Pinterest 推广</Text>
                <Text size="small">· Etsy / Shopify 卖家 — 发现平台需求趋势，选品上新</Text>
                <Text size="small">· POD（Print on Demand）卖家 — 发掘数字设计需求</Text>
                <Text size="small">· Pinterest 内容创作者 — 稳定输出高收藏 Pin</Text>
                <Text size="small">· 小型 Pinterest 代运营团队</Text>
              </Stack>
            </CardBody>
          </Card>
        </Grid>

        <Table
          headers={['维度', '说明']}
          rows={[
            ['产品名', 'VibePin'],
            ['技术栈', 'Next.js 16.2 + TypeScript + Tailwind CSS 4 + Supabase + Python 数据管线'],
            ['AI 服务', 'Flux.1 Schnell (RunPod) 图像生成 + GPT-4o 文案生成'],
            ['部署', 'Vercel (前端) + Railway (后端管线) + Supabase (数据库 + 存储)'],
            ['认证', 'Supabase Auth — 邮箱注册 + OAuth 回调'],
          ]}
          striped
        />
      </Stack>

      <Divider />

      {/* ══ 2. 导航结构与页面清单 ══ */}
      <Stack gap={12}>
        <H2>2. 导航结构与页面清单</H2>
        <Text tone="secondary" size="small">
          侧边栏分两个区块：<strong>WORKFLOW</strong>（内容生产工作流）和 <strong>INTELLIGENCE</strong>（数据情报）。
        </Text>

        <H3>2.1 WORKFLOW — 内容生产链路</H3>
        <Table
          headers={['侧边栏名称', '路径', '一句话功能', '主要操作']}
          rows={[
            [
              'Workspace',
              '/app/workspace/[category]',
              '按类目浏览机会卡片，是进入平台的默认落点',
              '切换类目 · 查看机会 · 点击 "Create Pin" 跳转 Studio',
            ],
            [
              'Weekly Plan',
              '/app/plan',
              '本周内容日历，追踪每日待发 Pin 进度',
              '查看每日计划 · 切换 Calendar / Board / Overview 视图 · 管理 Pin 状态',
            ],
            [
              'Create Pins',
              '/app/studio',
              'AI 驱动的 Pin 生成工作室',
              '选择来源（机会 / 关键词 / 商品 / 周计划）→ 配置风格 → 生成图 + 文案',
            ],
            [
              'Generated Pins',
              '/app/history',
              '已生成 Pin 的历史记录与管理',
              '查看生成结果 · 加入计划 · 重新生成',
            ],
          ]}
          striped
        />

        <H3>2.2 INTELLIGENCE — 数据情报模块</H3>
        <Table
          headers={['侧边栏名称', '路径', '一句话功能', '主要操作']}
          rows={[
            [
              'Keyword Trends',
              '/app/trends',
              '查看趋势关键词的搜索量、增长率和竞争度',
              '搜索关键词 · 按类目过滤 · 查看趋势曲线 · 跳转 Studio 生成 Pin',
            ],
            [
              'Pin Opportunities',
              '/app/discover',
              '浏览 Pinterest 上高收藏 Pin（Latest + Rising Virals）',
              '按物理 / 数字过滤 · 查看 Save Velocity · 跳转 Studio',
            ],
            [
              'Product Signals',
              '/app/products',
              '发现正在 Pinterest 上被收藏传播的可变现商品',
              '切换实物 / 数字商品 · 按类目 / 平台 / 利基过滤 · 跳转 Studio',
            ],
          ]}
          striped
        />
      </Stack>

      <Divider />

      {/* ══ 3. 各页面功能详细说明 ══ */}
      <Stack gap={16}>
        <H2>3. 各页面功能详细说明</H2>

        {/* 3.1 Workspace */}
        <Card>
          <CardHeader trailing={<Pill tone="success" size="sm">✅ 上线</Pill>}>
            3.1 Workspace — 机会看板
          </CardHeader>
          <CardBody>
            <Stack gap={8}>
              <Text size="small">
                用户登录后的默认落点。URL 包含 category 参数（如 <Code>/app/workspace/home-decor</Code>），
                切换类目会更新 URL 和数据。页面按加权 feed 混合展示三类机会卡片：
              </Text>
              <Table
                headers={['卡片类型', '数据来源', '展示内容']}
                rows={[
                  ['关键词机会卡', 'trend_opportunities_view', 'keyword、score_tier (Blue Ocean / Early Trend / Steady / Competitive)、linked_pins_count、linked_products_count、生命周期标签'],
                  ['爆款 Pin 卡', 'pin_samples', 'Pin 图片、save_count、关联关键词、Save Velocity 标签'],
                  ['商品信号卡', 'pin_products + product_scores', '商品图、来源域名、save_count、opportunity_score、product type (physical / digital)'],
                ]}
                striped
              />
              <Text size="small" tone="secondary">
                每周计划进度条显示在顶部（当前 / 目标 Pins，目标可选 7 / 14 / 21）。
                点击任意卡片上的「Create Pin」直接带参数跳转 Studio。
              </Text>
            </Stack>
          </CardBody>
        </Card>

        {/* 3.2 Weekly Plan */}
        <Card>
          <CardHeader trailing={<Pill tone="success" size="sm">✅ 上线</Pill>}>
            3.2 Weekly Plan — 本周内容日历
          </CardHeader>
          <CardBody>
            <Stack gap={8}>
              <Text size="small">
                展示当前自然周（周一–周日）的 Pin 发布计划。支持三种视图模式：
              </Text>
              <Table
                headers={['视图', '展示方式']}
                rows={[
                  ['Calendar', '按天列显示计划 Pin，直观查看每日密度'],
                  ['Board', '看板风格，按状态（待发 / 已发）分列'],
                  ['Overview', '汇总本周完成率和目标进度'],
                ]}
                striped
              />
              <Text size="small" tone="secondary">
                计划项来自用户在 Studio 或 Workspace 中手动添加。每个 Pin 有状态：
                <Code>pending → processing → done / failed</Code>。
                计划目标（7 / 14 / 21 pins/week）在 Workspace 顶部设置。
              </Text>
            </Stack>
          </CardBody>
        </Card>

        {/* 3.3 Studio */}
        <Card>
          <CardHeader trailing={<Pill tone="success" size="sm">✅ 上线</Pill>}>
            3.3 Create Pins (Studio) — AI 内容工作室
          </CardHeader>
          <CardBody>
            <Stack gap={8}>
              <Grid columns={2} gap={10}>
                <Stack gap={5}>
                  <Text size="small"><strong>输入方式</strong></Text>
                  <Text size="small">· 商品 URL 粘贴（自动抓取 OG 元数据 + 图片）</Text>
                  <Text size="small">· 图片直接上传（多图）</Text>
                  <Text size="small">· 来自 Workspace / Product Signals / Keyword 的机会带参数跳入</Text>
                  <Text size="small">· 参考 Pin 上传（Reference Mode，复刻风格）</Text>
                </Stack>
                <Stack gap={5}>
                  <Text size="small"><strong>生成流程</strong></Text>
                  <Text size="small">1. AI 分析商品品类 + 目标人群</Text>
                  <Text size="small">2. 推荐 3–5 个 Pin 创意方向（Pin Type Library）</Text>
                  <Text size="small">3. Flux.1 Schnell 生成 2:3 纵向 Pin 图</Text>
                  <Text size="small">4. GPT-4o 生成 Title + Description + Board 建议</Text>
                  <Text size="small">5. 结果落入 generated_assets 表，可加入 Weekly Plan</Text>
                </Stack>
              </Grid>
              <Table
                headers={['Pin Type', '适用场景']}
                rows={[
                  ['Lifestyle Scene', '使用场景 + 生活化语境'],
                  ['Product Collage', '多单品 / 多角度拼贴'],
                  ['Moodboard', '情绪板、质感与配色'],
                  ['Gift Guide', '礼赠、节日'],
                  ['How to Style', '搭配、教程感'],
                  ['Seasonal Campaign', '季节 / 节日主题'],
                  ['Product Spotlight', '单 SKU 强焦点'],
                  ['Collection / Roundup', '合集、清单'],
                ]}
                striped
              />
            </Stack>
          </CardBody>
        </Card>

        {/* 3.4 Keyword Trends */}
        <Card>
          <CardHeader trailing={<Pill tone="success" size="sm">✅ 上线</Pill>}>
            3.4 Keyword Trends — 关键词趋势
          </CardHeader>
          <CardBody>
            <Stack gap={8}>
              <Text size="small">
                搜索特定关键词，返回其在 Pinterest 上的搜索热度、YoY/WoW 增长、竞争度定性评分和关联词列表。
                页面同时展示各类目的关键词榜单，并支持切换类目过滤。
              </Text>
              <Table
                headers={['展示字段', '来源', '说明']}
                rows={[
                  ['search_volume_level', 'trend_keywords', 'very_high / high / medium / low'],
                  ['yearly_change / weekly_change', 'trend_keywords', 'Pinterest 官方 YoY / WoW 增长百分比'],
                  ['trend_lifecycle', 'trend_keywords', 'rising / peak / declining / steady / unclear'],
                  ['opportunity_tier', 'trend_opportunities_view', 'Blue Ocean / Early Trend / Steady / Competitive'],
                  ['linked_products_count', 'trend_opportunities_view', '该词关联商品数量（商品覆盖置信度依据）'],
                  ['related keywords', 'trend_keywords + trend_opportunities_view', '同类目的相关词列表'],
                ]}
                striped
              />
              <Text size="small" tone="secondary">
                定性 band 展示（Interest · Trend · Competition · Save Signal）由前端 <Code>/api/keyword-tool/search</Code> 计算，
                基于 search_volume_level、weekly_change、linked_pins_count 等字段映射为 Low / Medium / High / Very High。
              </Text>
            </Stack>
          </CardBody>
        </Card>

        {/* 3.5 Pin Opportunities */}
        <Card>
          <CardHeader trailing={<Pill tone="success" size="sm">✅ 上线</Pill>}>
            3.5 Pin Opportunities (Discover) — 高收藏 Pin 画廊
          </CardHeader>
          <CardBody>
            <Stack gap={8}>
              <Text size="small">
                展示 Pinterest 上经过筛选的高收藏 Pin 样本（save_count ≥ 500）。
                两个子标签页：
              </Text>
              <Table
                headers={['标签', '排序逻辑', '数据来源']}
                rows={[
                  ['Latest', '按 scraped_at 时间排序，展示最近抓取的 Pin', 'pin_samples'],
                  ['Rising Virals', '按 save_velocity（saves / 天数）排序，找增速最快的 Pin', 'pin_samples + trend_opportunities_view'],
                ]}
                striped
              />
              <Text size="small" tone="secondary">
                支持 Physical / Digital 切换过滤。每张 Pin 卡片展示：Pin 图、save_count、
                来源关键词、market signal 标签（如 Steady / Rising）。点击可查看原 Pin 或跳转 Studio。
              </Text>
            </Stack>
          </CardBody>
        </Card>

        {/* 3.6 Product Signals */}
        <Card>
          <CardHeader trailing={<Pill tone="success" size="sm">✅ 上线</Pill>}>
            3.6 Product Signals — 商品情报
          </CardHeader>
          <CardBody>
            <Stack gap={10}>
              <Text size="small">
                发现正在 Pinterest 上被高频收藏的可变现商品。页面顶部有 <strong>Physical / Digital</strong> 两个标签，
                对应两类完全不同的数据链路和展示逻辑。
              </Text>

              <H3>Physical（实物商品）</H3>
              <Table
                headers={['功能', '说明']}
                rows={[
                  ['数据来源', 'pin_products JOIN product_scores JOIN keyword_product_map，通过 /api/products/top 返回'],
                  ['排序', '默认 Opportunity Score 降序；可切换 Saves · Pin Viral · Price'],
                  ['类目过滤', 'Category 筛选器；点 Fashion 会同时匹配 womens-fashion / mens-fashion / kids-fashion（CATEGORY_CHILDREN 映射）'],
                  ['平台过滤', '按域名筛选：Etsy · Amazon · Poshmark · Us · Target · Walmart'],
                  ['利基过滤', '来自用户设置的 selectedNiches；匹配 seed_keyword 或 product_name'],
                  ['搜索框', '模糊匹配 product_name / seed_keyword / domain'],
                  ['商品卡', '商品图 + 名称 + 来源域名 + save_count + opportunity_score + market tag（Steady / Rising 等）'],
                  ['跳转 Studio', '点商品卡右上角图标，带 product_url 参数打开 Studio'],
                ]}
                striped
              />

              <H3>Digital（数字商品）</H3>
              <Table
                headers={['功能', '说明']}
                rows={[
                  ['数据来源', 'pin_products（is_digital=true 或 digital intent token 命中），由 digital_product_scraper.py 写入'],
                  ['识别逻辑', '平台域名（TPT / Payhip / Gumroad / CreativeMarket）或标题 token（printable / template / pdf / svg / instant download 等）'],
                  ['关键词组', 'planners · templates · worksheets · trackers · wall_art · kids_education · business · crafts_svg'],
                  ['展示', '按 niche 分组，每组展示代表性商品、估算月销量、平台、format'],
                  ['Niche 过滤', '与实物商品共享 selectedNiches 过滤器'],
                ]}
                striped
              />
            </Stack>
          </CardBody>
        </Card>

        {/* 3.7 Generated Pins */}
        <Card>
          <CardHeader trailing={<Pill tone="success" size="sm">✅ 上线</Pill>}>
            3.7 Generated Pins (History) — 历史记录
          </CardHeader>
          <CardBody>
            <Text size="small">
              展示用户所有生成任务的结果，按 session 分组。每组显示生成参数（Pin Type、输入商品）和
              各 Pin 的状态（pending / processing / done / failed）。支持：加入 Weekly Plan、
              下载图片、查看 Title / Description 文案。数据表：<Code>generated_assets</Code>。
            </Text>
          </CardBody>
        </Card>
      </Stack>

      <Divider />

      {/* ══ 4. 取数逻辑汇总 ══ */}
      <Stack gap={12}>
        <H2>4. 取数逻辑汇总</H2>
        <Callout tone="info" title="核心原则">
          <Text size="small">
            所有 Intelligence 页面（Workspace / Keyword Trends / Pin Opportunities / Product Signals）
            最终都从同一套 Supabase 表族取数。<Code>trend_opportunities_view</Code> 是最重要的聚合视图，
            Workspace 和 Keyword Trends 优先读它；Products 更靠 pin_products + product_scores；
            Pin Opportunities 直接读 pin_samples 明细。
          </Text>
        </Callout>
        <Table
          headers={['页面', '前端 API / 取数入口', '主要表 / 视图', '关键过滤条件']}
          rows={[
            [
              'Workspace',
              '/api/workspace/feed',
              'trend_opportunities_view → pin_samples → keyword_product_map → pin_products',
              'category = 当前 URL 参数；score_tier != low；分页',
            ],
            [
              'Keyword Trends (搜索)',
              '/api/keyword-tool/search',
              'trend_keywords + trend_opportunities_view',
              'keyword = 搜索词（精确 + LIKE）',
            ],
            [
              'Keyword Trends (相关词)',
              '/api/keyword-tool/related',
              'trend_keywords + trend_opportunities_view',
              'category = 当前类目；排除搜索词本身',
            ],
            [
              'Pin Opportunities',
              '/api/viral-pins 或 Supabase 直连',
              'pin_samples',
              'save_count ≥ 500；按 scraped_at 或 save_velocity 排序；类目 / 物理数字 filter',
            ],
            [
              'Product Signals (实物)',
              '/api/products/top',
              'pin_products JOIN product_scores',
              'category（含子分类）· domain · seed_keyword · search；分页 50 条',
            ],
            [
              'Product Signals (数字)',
              'Supabase 直连 或 /api/products/top?digital=true',
              'pin_products（is_digital / intent token）',
              'digital intent token 命中；按 niche group 聚合',
            ],
            [
              'Studio 参考数据',
              '/api/opportunities + Supabase',
              'trend_opportunities_view + pin_samples + pin_products',
              '机会词推荐；参考 Pin；商品候选',
            ],
            [
              'Weekly Plan',
              'Supabase 直连',
              'weekly_plan_items + generated_assets',
              'user_id + 当前周 ISO week；按 scheduled_date 排序',
            ],
          ]}
          striped
        />
      </Stack>

      <Divider />

      {/* ══ 5. 跳转逻辑 ══ */}
      <Stack gap={12}>
        <H2>5. 跳转逻辑（页面间联动）</H2>
        <Text tone="secondary" size="small">
          各页面之间通过 URL query 参数传递上下文，Studio 是核心汇聚点。
        </Text>
        <Table
          headers={['从', '到', '触发条件', '携带参数']}
          rows={[
            [
              'Workspace 机会卡',
              '/app/studio',
              '点「Create Pin」按钮',
              '?keyword=xxx &opportunity_id=xxx',
            ],
            [
              'Product Signals 商品卡',
              '/app/studio',
              '点商品卡片右上角 Studio 图标',
              '?product_url=xxx &product_name=xxx',
            ],
            [
              'Pin Opportunities Pin 卡',
              '/app/studio',
              '点「Use as Reference」',
              '?reference_pin_id=xxx &keyword=xxx',
            ],
            [
              'Keyword Trends 关键词行',
              '/app/studio',
              '点「Create Pin for this keyword」',
              '?keyword=xxx',
            ],
            [
              'Workspace / 任意页',
              '/app/workspace/[category]',
              '侧边栏点击 Workspace 或类目切换',
              'URL 路径参数 category 变更',
            ],
            [
              'Studio 生成完成',
              '/app/history',
              '任务完成后自动提示或手动导航',
              '—',
            ],
            [
              'Generated Pins 历史卡',
              '/app/plan',
              '点「Add to Weekly Plan」',
              '携带 generated_asset_id 写入 weekly_plan_items',
            ],
            [
              '首页 Landing',
              '/signup 或 /login',
              'Hero CTA 按钮',
              '—',
            ],
            [
              '/app (根路径)',
              '/app/workspace/home-decor',
              '自动重定向',
              '—',
            ],
          ]}
          striped
        />

        <UserFlowDiagram />
      </Stack>

      <Divider />

      {/* ══ 6. 数据管线 ══ */}
      <Stack gap={12}>
        <H2>6. 后台数据管线（Python Scripts）</H2>
        <Text tone="secondary" size="small">
          管线由 <Code>pipeline.py</Code> 统一编排，各步骤可独立触发。
          当前为手动运行，生产环境计划接入 Railway Scheduler 定时调度。
        </Text>
        <PipelineDiagram />
        <Table
          headers={['步骤', '脚本', '输入', '输出表', '核心逻辑']}
          rows={[
            [
              '1. Interest Seeds',
              'interest_discovery.py',
              'Pinterest 兴趣类目源',
              'trend_interests',
              '建立趋势抓取的类目入口；缓存 interest_slug',
            ],
            [
              '2. Trend Keywords',
              'trend_fetcher.py',
              'trend_interests',
              'trend_keywords + crawl_queue',
              '3 层 Pinterest API fallback（官方 Trends → 内部 Resource → Typeahead 估算）；过滤条件：volume ≥ medium + YoY ≥ 100% + WoW ≥ 0%',
            ],
            [
              '3. Pin Evidence',
              'scraper_v2.py',
              'crawl_queue',
              'pin_samples + keyword_expansions',
              'Playwright + curl_cffi 抓 Pin；save_count ≥ 500 进库；≥ 5000 触发 Shop the Look；记录 save_velocity / age_days',
            ],
            [
              '4. Physical Products',
              'shop_the_look.py',
              'pin_samples（save ≥ 5000）',
              'pin_products',
              '提取 Pin 上商品卡片 / 外链；规范化 URL；过滤重复和低质量条目',
            ],
            [
              '5. Digital Products',
              'digital_product_scraper.py',
              '固定数字商品关键词组',
              'pin_products + pin_samples',
              '搜索 planner/template 等词；域名 + URL token + 标题 token 识别数字商品；MIN_SAVES = 20',
            ],
            [
              '6. Score Engine',
              'calculate_product_scores.py',
              'pin_products + pin_samples + trend_keywords',
              'product_scores + keyword_product_map',
              '多维打分（save_velocity 40% + trend 30% + freshness 20% + density 10%）；建立关键词商品 M2M 映射',
            ],
          ]}
          striped
        />

        <H3>运行命令速查</H3>
        <Table
          headers={['操作', '命令']}
          rows={[
            ['完整链路', 'py pipeline.py'],
            ['只刷趋势词', 'py pipeline.py --step trends --interest home_decor --top 30'],
            ['只爬 Pin', 'py pipeline.py --step crawl --concurrency 2 --limit-keywords 20'],
            ['只跑商品提取', 'py pipeline.py --step stl'],
            ['只跑数字商品', 'py pipeline.py --step digital --digital-group planners templates'],
            ['只重算分数', 'py pipeline.py --step score'],
            ['补趋势历史', 'py pipeline.py --step enrich'],
            ['验证（不写库）', 'py calculate_product_scores.py --dry-run --verbose'],
          ]}
          striped
        />
      </Stack>

      <Divider />

      {/* ══ 7. Pinterest API 调用层 ══ */}
      <Stack gap={12}>
        <H2>7. Pinterest API / Resource 调用层</H2>
        <Text tone="secondary" size="small">
          后台脚本用 <Code>curl_cffi</Code> 模拟 Chrome，先请求 Pinterest 首页获取
          bootstrap cookie / csrftoken / appVersion，再带必要 Headers 调用以下接口。
        </Text>
        <Table
          headers={['接口 / Resource', 'Endpoint（简写）', '取什么', '调用脚本']}
          rows={[
            ['Trends Official', 'trends.pinterest.com/api/v3/trends/keywords/suggested/', '关键词、volume、YoY/WoW', 'trend_fetcher Layer 1'],
            ['Trends Category', 'trends.pinterest.com/api/v3/trends/categories/top/', '分类下 top 趋势词', 'trend_fetcher Layer 1'],
            ['Time Series', 'trends.pinterest.com/api/v3/trends/keywords/time_series/', '52 周 0-100 normalized 历史', 'trend_fetcher enrich'],
            ['TrendingSearchResource', 'pinterest.com/resource/TrendingSearchResource/get/', '内部趋势搜索', 'trend_fetcher Layer 2'],
            ['TrendKeywordsResource', 'pinterest.com/resource/TrendKeywordsResource/get/', '内部关键词趋势', 'trend_fetcher Layer 2 fallback'],
            ['AdvancedTypeaheadResource', 'pinterest.com/resource/AdvancedTypeaheadResource/get/', '关键词扩展 / 联想', 'trend_fetcher Layer 3 + scraper'],
            ['BaseSearchResource', 'pinterest.com/resource/BaseSearchResource/get/', 'Pin 搜索结果 + 分页 bookmark', 'scraper_v2'],
            ['PinResource', 'pinterest.com/resource/PinResource/get/', 'Pin 详情 + save_count + outbound link', 'scraper_v2'],
            ['RelatedPinFeedResource', 'pinterest.com/resource/RelatedPinFeedResource/get/', '高信号 Pin 的 related graph', 'scraper_v2 premium'],
          ]}
          striped
        />
      </Stack>

      <Divider />

      {/* ══ 8. 数据库结构 ══ */}
      <Stack gap={12}>
        <H2>8. 数据库结构（Supabase PostgreSQL）</H2>
        <Table
          headers={['表 / 视图', '角色', '关键字段']}
          rows={[
            ['trend_interests', '爬取入口', 'interest_slug, interest_name, country, is_active, last_fetched_at'],
            ['trend_keywords', '关键词事实表（核心）', 'keyword, category, yearly_change, weekly_change, search_volume_level, priority_score, trend_lifecycle, trend_history (JSON 52w)'],
            ['crawl_queue', 'Pin 抓取任务队列', 'keyword, source_interest, category, priority_score, status, attempts, last_error'],
            ['keyword_expansions', 'Pinterest typeahead 扩词记录', 'seed_keyword, expanded_keyword, source_interest'],
            ['pin_samples', 'Pin 证据样本', 'pin_id, trend_keyword_id, seed_keyword, image_url, save_count, save_velocity, age_days, trend_stage, outbound_link, category'],
            ['pin_products', '商品信号（实物 + 数字共用）', 'parent_pin_id, seed_keyword, product_name, source_url, domain, merchant, image_url, save_count, price, is_digital, product_url_hash'],
            ['product_scores', '商品评分', 'product_id, opportunity_score, trend_score, save_velocity_score, freshness_score, competition_score'],
            ['keyword_product_map', '关键词-商品 M2M', 'keyword_id, product_id, relevance_score, total_pins, total_saves'],
            ['trend_opportunities_view', '前端主聚合视图（v12–v16）', 'keyword_id, keyword, category, score_tier, opportunity_tier, data_confidence, monetization_confidence, linked_pins_count, linked_products_count, total_source_saves, trend_lifecycle'],
            ['generated_assets', '用户生成的 Pin', 'user_id, task_id, image_url, title, description, pin_link, board_id, status, pin_type'],
            ['weekly_plan_items', '周计划项', 'user_id, generated_asset_id, scheduled_date, status'],
          ]}
          striped
        />
      </Stack>

      <Divider />

      {/* ══ 9. 评分与分级体系 ══ */}
      <Stack gap={12}>
        <H2>9. 评分与分级体系</H2>

        <H3>9.1 关键词机会分级（trend_opportunities_view）</H3>
        <Table
          headers={['Tier', '标签', '判断条件', '建议行动']}
          rows={[
            ['high', 'Blue Ocean', 'YoY ≥ 200% 且 (saves ≥ 5000 或 volume very_high) 且 linked_pins_count ≤ 30', '优先布局，快速占坑'],
            ['medium', 'Early Trend / Steady', 'YoY ≥ 100% 有需求证据未过度饱和；或 high volume 且 WoW ≥ 0%', '跟进布局，差异化切入'],
            ['low', 'Competitive / Watchlist', '不满足 high / medium', '可跳过或观望'],
          ]}
          striped
        />

        <H3>9.2 商品机会分（product_scores.opportunity_score）</H3>
        <Table
          headers={['子分', '权重', '算法']}
          rows={[
            ['save_velocity_score', '40%', 'log10 scale；1000 saves/day → 100'],
            ['trend_score', '30%', 'log10 scale；500% YoY → 100'],
            ['freshness_score', '20%', '90 天线性衰减，越新越高'],
            ['product_density_score', '10%', '每关键词产品数，≥ 10 个封顶为 100'],
          ]}
          striped
        />

        <H3>9.3 Market Tag（前端 lib/scoring.ts）</H3>
        <Table
          headers={['Tag', '含义', '前端展示']}
          rows={[
            ['hidden_supply', '高保存 + 低竞争，供给不足', '蓝色 · Blue Ocean'],
            ['new_account_friendly', '适合新账号起步', '绿色 · Good Start'],
            ['oversaturated', '竞争过度', '红色 · Crowded'],
            ['low_volume', '需求太小', '灰色 · Low Volume'],
            ['Steady', '稳定但无显著机会信号', '白色 · Steady'],
          ]}
          striped
        />

        <H3>9.4 类目父子关系（lib/categories.ts）</H3>
        <Text size="small" tone="secondary">
          点击 "Fashion" 过滤器时，同时匹配 DB 中 womens-fashion / mens-fashion / kids-fashion 标签的商品：
        </Text>
        <Table
          headers={['父分类', '包含子分类']}
          rows={[
            ['fashion', 'womens-fashion · mens-fashion · kids-fashion'],
          ]}
          striped
        />
      </Stack>

      <Divider />

      {/* ══ 10. 技术栈 ══ */}
      <Stack gap={12}>
        <H2>10. 技术栈</H2>
        <Grid columns={2} gap={14}>
          <Card>
            <CardHeader>前端</CardHeader>
            <CardBody>
              <Stack gap={5}>
                <Text size="small">· Next.js 16.2 (Turbopack) + React 19 + TypeScript 5</Text>
                <Text size="small">· Tailwind CSS 4</Text>
                <Text size="small">· Supabase SSR + Auth (@supabase/ssr ^0.10)</Text>
                <Text size="small">· SWR 2.4（数据获取 + 缓存）</Text>
                <Text size="small">· Lucide React（图标）· Sonner（Toast）</Text>
                <Text size="small">· 部署：Vercel</Text>
              </Stack>
            </CardBody>
          </Card>
          <Card>
            <CardHeader>数据管线 (Backend)</CardHeader>
            <CardBody>
              <Stack gap={5}>
                <Text size="small">· Python 3.12</Text>
                <Text size="small">· Playwright（有头 / 无头 Pinterest 抓取）</Text>
                <Text size="small">· curl_cffi（模拟 Chrome，绕过 TLS 指纹）</Text>
                <Text size="small">· BeautifulSoup4（HTML 解析）</Text>
                <Text size="small">· 自研 Supabase HTTP 封装 (backend/db/db.py)</Text>
                <Text size="small">· Cookie 会话持久化：backend/pinterest_profile/</Text>
                <Text size="small">· 部署：Railway（计划中）</Text>
              </Stack>
            </CardBody>
          </Card>
          <Card>
            <CardHeader>AI 服务</CardHeader>
            <CardBody>
              <Stack gap={5}>
                <Text size="small">· 图像生成：Flux.1 Schnell via RunPod Serverless</Text>
                <Text size="small">· 输出比例：2:3（Pinterest-first 纵向）</Text>
                <Text size="small">· 文案生成：OpenAI GPT-4o</Text>
                <Text size="small">· 图像分割：SAM 2 via Replicate（规划中）</Text>
              </Stack>
            </CardBody>
          </Card>
          <Card>
            <CardHeader>基础设施</CardHeader>
            <CardBody>
              <Stack gap={5}>
                <Text size="small">· 数据库：Supabase PostgreSQL（schema v16，16 次迁移）</Text>
                <Text size="small">· 存储：Supabase Storage + CDN（生成图片）</Text>
                <Text size="small">· 监控：Sentry + PostHog</Text>
                <Text size="small">· 后端 API（最小化）：FastAPI legacy + ARQ 任务队列</Text>
              </Stack>
            </CardBody>
          </Card>
        </Grid>
      </Stack>

      <Divider />

      {/* ══ 11. 当前缺口与 Roadmap ══ */}
      <Stack gap={12}>
        <H2>11. 当前缺口与 Roadmap</H2>
        <Callout tone="error" title="最大缺口">
          <Text size="small">
            数据管线仍为<strong>手动触发</strong>，生产环境无定时调度，数据新鲜度完全依赖人工操作。
            发布闭环（Pinterest OAuth → 批量发布 → 排期）框架存在但未端到端验证。
            数字商品信号采集已完成但<strong>前端产品化不足</strong>（缺少 digital badge / 平台标识 / 分组过滤器）。
          </Text>
        </Callout>
        <Grid columns={3} gap={14}>
          <Card>
            <CardHeader trailing={<Pill tone="danger" size="sm">P0</Pill>}>
              稳定数据工厂
            </CardHeader>
            <CardBody>
              <Stack gap={5}>
                <Text size="small">· 接入 Railway Scheduler 按步骤定时调度</Text>
                <Text size="small">· 为每个 pipeline step 记录 run_log（成功率、写入数、HTTP 状态）</Text>
                <Text size="small">· Supabase 表级数据新鲜度监控（last_updated_at 指标）</Text>
                <Text size="small">· Pinterest API 空返回 / 403 / shape 变化告警</Text>
                <Text size="small">· Cookie 会话过期自动检测与提醒</Text>
                <Text size="small">· enrich + classify 纳入标准趋势刷新流程</Text>
              </Stack>
            </CardBody>
          </Card>
          <Card>
            <CardHeader trailing={<Pill tone="warning" size="sm">P1</Pill>}>
              信号产品化
            </CardHeader>
            <CardBody>
              <Stack gap={5}>
                <Text size="small">· Product Signals 增加 Physical / Digital 平台标识和分组过滤器</Text>
                <Text size="small">· Workspace 卡片显示 evidence reason（不只是 tier 分数）</Text>
                <Text size="small">· Keyword Trends 明确展示数据来源 + last_fetched_at</Text>
                <Text size="small">· Pin Opportunities 把 monetization_confidence 与 opportunity_tier 分开展示</Text>
                <Text size="small">· Studio 自动带入关键词 + 参考 Pin + 商品信号生成 brief</Text>
              </Stack>
            </CardBody>
          </Card>
          <Card>
            <CardHeader trailing={<Pill tone="neutral" size="sm">P2</Pill>}>
              闭合增长循环
            </CardHeader>
            <CardBody>
              <Stack gap={5}>
                <Text size="small">· Pinterest OAuth 端到端验证（授权 → token → 发布 → 吊销）</Text>
                <Text size="small">· 批量发布（Board 选择 + 多 Pin 提交 + 部分失败不阻塞）</Text>
                <Text size="small">· 发布排期（时间槽 + 时区 + 每日上限 + 队列顺延）</Text>
                <Text size="small">· 发布后回写 Pinterest Pin URL + 表现数据</Text>
                <Text size="small">· 高机会词自动生成可执行内容日历</Text>
                <Text size="small">· Analytics Dashboard（已发 Pin 表现追踪）</Text>
              </Stack>
            </CardBody>
          </Card>
        </Grid>
      </Stack>

      <Divider />

      {/* ══ 12. 高转化 Pin 生成规则 ══ */}
      <Stack gap={10}>
        <H2>12. 高转化 Pin 生成规则</H2>
        <Table
          headers={['规则', '说明']}
          rows={[
            ['2:3 纵向比例', 'Pinterest-first，Studio 默认输出比例'],
            ['视觉焦点明确', '主次分明，主体清晰可辨'],
            ['生活化语境', '强生活场景，避免纯白底电商图直出'],
            ['构图不过度拥挤', '保持视觉呼吸感'],
            ['文案留白', '为 Title 叠加层预留安全边距'],
            ['平台原生感', '看起来像自然 Pin，而非广告图'],
            ['禁止虚假折扣', '用户未提供折扣信息时，禁止虚构促销文案'],
            ['移动端可读', '若含字，最小字号需在手机屏幕可读'],
            ['禁止误导性宣称', '不虚假功效，不冒充官方鉴定'],
          ]}
          striped
        />
      </Stack>

      <Text tone="quaternary" size="small" style={{ marginTop: 12 }}>
        VibePin PRD v6.0 — Current State Document — 2026-06-05
      </Text>
    </Stack>
  );
}
