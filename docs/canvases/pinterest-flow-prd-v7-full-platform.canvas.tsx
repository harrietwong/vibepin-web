import {
  Stack, H1, H2, H3, Text, Grid, Row, Stat, Divider,
  Card, CardHeader, CardBody, Table, Callout, Pill, Code,
  useHostTheme, computeDAGLayout,
} from 'cursor/canvas';

/**
 * VibePin PRD v7.1 — Full Platform & Data Operations (Detailed)
 * 基于 2026-06-11 代码 + VPS_DEPLOY_LOG.md 整合。
 * 历史：v4 Growth OS · v5 Data Intelligence · v6 Current State
 */

/* ══ Pipeline DAG ══ */
const pipeNodes = [
  { id: 'interests' }, { id: 'keywords' }, { id: 'pins' },
  { id: 'products' }, { id: 'scores' }, { id: 'view' }, { id: 'pages' },
];
const pipeEdges = [
  { from: 'interests', to: 'keywords' },
  { from: 'keywords', to: 'pins' },
  { from: 'pins', to: 'products' },
  { from: 'products', to: 'scores' },
  { from: 'scores', to: 'view' },
  { from: 'view', to: 'pages' },
];
const pipeLabel: Record<string, string> = {
  interests: 'Interest Seeds',
  keywords:  'Trend Keywords',
  pins:      'Pin Evidence',
  products:  'Product Signals',
  scores:    'Score Engine',
  view:      'Opportunity View',
  pages:     'App Pages',
};
const pipeSub: Record<string, string> = {
  interests: 'trend_interests',
  keywords:  'trend_keywords + crawl_queue',
  pins:      'pin_samples',
  products:  'pin_products',
  scores:    'product_scores + keyword_product_map',
  view:      'trend_opportunities_view',
  pages:     'Workspace · Pin Ideas · Products · Keyword Tool',
};
const pipeLayout = computeDAGLayout({
  nodes: pipeNodes, edges: pipeEdges,
  direction: 'horizontal',
  nodeWidth: 120, nodeHeight: 52,
  rankGap: 16, nodeGap: 12, padding: 14,
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
          <line key={i} x1={e.sourceX} y1={e.sourceY} x2={e.targetX - 7} y2={e.targetY}
            stroke={theme.stroke.secondary} strokeWidth={1.5} markerEnd="url(#pArr)" />
        ))}
        {pipeLayout.nodes.map(node => {
          const accent = node.id === 'view' || node.id === 'pages';
          const fill = accent ? theme.accent.primary : theme.fill.tertiary;
          const tc = accent ? theme.text.onAccent : theme.text.primary;
          const sc = accent ? theme.text.onAccent : theme.text.tertiary;
          return (
            <g key={node.id}>
              <rect x={node.x} y={node.y} width={120} height={52} rx={5}
                fill={fill} stroke={theme.stroke.primary} strokeWidth={1} />
              <text x={node.x + 60} y={node.y + 18} textAnchor="middle"
                fill={tc} fontSize={9.5} fontFamily="system-ui, sans-serif" fontWeight={600}>
                {pipeLabel[node.id]}
              </text>
              <text x={node.x + 60} y={node.y + 34} textAnchor="middle"
                fill={sc} fontSize={7.5} fontFamily="system-ui, sans-serif">
                {pipeSub[node.id]}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/* ══ User flow DAG ══ */
const flowNodes = [
  { id: 'landing' }, { id: 'intel' }, { id: 'studio' }, { id: 'plan' },
];
const flowEdges = [
  { from: 'landing', to: 'intel' },
  { from: 'intel',   to: 'studio' },
  { from: 'studio',  to: 'plan' },
];
const flowLabel: Record<string, string> = {
  landing: 'Landing / Auth',
  intel:   'Intelligence 调研',
  studio:  'Create Pins',
  plan:    'Weekly Plan',
};
const flowSub: Record<string, string> = {
  landing: '/ · /signup',
  intel:   'Keyword · Pin Ideas · Products · Home',
  studio:  '/app/studio',
  plan:    '/app/plan',
};
const flowLayout = computeDAGLayout({
  nodes: flowNodes, edges: flowEdges,
  direction: 'horizontal',
  nodeWidth: 128, nodeHeight: 48,
  rankGap: 18, nodeGap: 12, padding: 14,
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
          <line key={i} x1={e.sourceX} y1={e.sourceY} x2={e.targetX - 7} y2={e.targetY}
            stroke={theme.stroke.secondary} strokeWidth={1.5} markerEnd="url(#fArr)" />
        ))}
        {flowLayout.nodes.map(node => (
          <g key={node.id}>
            <rect x={node.x} y={node.y} width={128} height={48} rx={5}
              fill={theme.accent.primary} stroke={theme.stroke.primary} strokeWidth={1} />
            <text x={node.x + 64} y={node.y + 18} textAnchor="middle"
              fill={theme.text.onAccent} fontSize={10} fontFamily="system-ui, sans-serif" fontWeight={600}>
              {flowLabel[node.id]}
            </text>
            <text x={node.x + 64} y={node.y + 34} textAnchor="middle"
              fill={theme.text.onAccent} fontSize={8} fontFamily="system-ui, sans-serif">
              {flowSub[node.id]}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}

/* ══ Daily job DAG ══ */
const dailyNodes = [
  { id: 'trends' }, { id: 'crawl1' }, { id: 'crawl2' }, { id: 'stl' }, { id: 'views' },
];
const dailyEdges = [
  { from: 'trends', to: 'crawl1' },
  { from: 'crawl1', to: 'crawl2' },
  { from: 'crawl2', to: 'stl' },
  { from: 'stl', to: 'views' },
];
const dailyLabel: Record<string, string> = {
  trends: 'trends', crawl1: 'crawl main', crawl2: 'catch-up', stl: 'stl-score', views: 'views',
};
const dailyLayout = computeDAGLayout({
  nodes: dailyNodes, edges: dailyEdges,
  direction: 'horizontal', nodeWidth: 96, nodeHeight: 36,
  rankGap: 12, nodeGap: 8, padding: 10,
});

function DailyJobDiagram() {
  const theme = useHostTheme();
  return (
    <div style={{ overflowX: 'auto' }}>
      <svg width={dailyLayout.width} height={dailyLayout.height + 6} style={{ display: 'block' }}>
        <defs>
          <marker id="dArr" markerWidth="6" markerHeight="6" refX="4" refY="3" orient="auto">
            <path d="M0,0 L0,6 L6,3 z" fill={theme.stroke.secondary} />
          </marker>
        </defs>
        {dailyLayout.edges.map((e, i) => (
          <line key={i} x1={e.sourceX} y1={e.sourceY} x2={e.targetX - 6} y2={e.targetY}
            stroke={theme.stroke.secondary} strokeWidth={1.5} markerEnd="url(#dArr)" />
        ))}
        {dailyLayout.nodes.map(node => (
          <g key={node.id}>
            <rect x={node.x} y={node.y} width={96} height={36} rx={4}
              fill={theme.fill.tertiary} stroke={theme.stroke.primary} strokeWidth={1} />
            <text x={node.x + 48} y={node.y + 22} textAnchor="middle"
              fill={theme.text.primary} fontSize={8.5} fontFamily="system-ui, sans-serif" fontWeight={600}>
              {dailyLabel[node.id]}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}

export default function VibePin_PRD_V7() {
  return (
    <Stack gap={28} style={{ padding: 36, maxWidth: 1100, margin: '0 auto' }}>

      {/* Header */}
      <Stack gap={8}>
        <Row gap={10} align="center">
          <H1>VibePin — PRD v7.1</H1>
          <Pill tone="success" active size="sm">Full Platform</Pill>
          <Pill tone="info" size="sm">Detailed</Pill>
          <Pill tone="info" size="sm">2026-06-11</Pill>
        </Row>
        <Text tone="secondary">
          全平台产品需求文档（详细版）：所有页面与功能、前端取数/API 参数、分类过滤、
          页面跳转、后台 pipeline 全步骤、run_worker 云任务、VPS cron 定时调度、
          数据库结构、评分体系、运维脚本。整合 v5 数据情报模型、v6 当前状态、VPS_DEPLOY_LOG。
        </Text>
        <Grid columns={5} gap={10}>
          <Stat value="18+" label="页面路由" tone="success" />
          <Stat value="20" label="API 路由" />
          <Stat value="10" label="pipeline 步骤" />
          <Stat value="5" label="run_worker jobs" />
          <Stat value="12,461" label="pin_samples (VPS)" />
        </Grid>
      </Stack>

      <Divider />

      {/* 1. 产品定位 */}
      <Stack gap={12}>
        <H2>1. 产品定位与技术架构</H2>
        <Grid columns={2} gap={14}>
          <Card>
            <CardHeader>产品定位</CardHeader>
            <CardBody>
              <Stack gap={6}>
                <Text size="small">
                  VibePin 是 Pinterest-first 的增长情报与内容生成平台。核心竞争力是
                  <strong>自建数据管线</strong>——后台脚本持续抓取 Pinterest 趋势关键词、
                  高收藏 Pin 和商品信号，落库 Supabase 后由前端多页面消费。
                </Text>
                <Text size="small" tone="secondary">
                  用户旅程：发现趋势 / Pin 参考 / 商品机会 → AI 生成 Pin（2:3）→ 规划一周内容 →（未来）审核发布。
                </Text>
              </Stack>
            </CardBody>
          </Card>
          <Card>
            <CardHeader>目标用户</CardHeader>
            <CardBody>
              <Stack gap={5}>
                <Text size="small">Affiliate Marketer — 高转化商品 Pinterest 推广</Text>
                <Text size="small">Etsy / Shopify 卖家 — 趋势选品、上新</Text>
                <Text size="small">POD / 数字商品卖家 — printable、template 需求</Text>
                <Text size="small">Pinterest 创作者 — 稳定高收藏 Pin 输出</Text>
                <Text size="small">代运营团队 — 多客户 Weekly Plan 管理</Text>
              </Stack>
            </CardBody>
          </Card>
        </Grid>
        <Table
          headers={['维度', '当前实现']}
          rows={[
            ['前端', 'Next.js 16 + React 19 + TypeScript 5 + Tailwind CSS 4'],
            ['认证', 'Supabase Auth — 邮箱注册 + OAuth；@supabase/ssr'],
            ['数据仓', 'Supabase PostgreSQL（迁移 v23/v24+）+ Storage（studio/ 生成图）'],
            ['AI 图像', 'Flux.1 Schnell via RunPod Serverless，默认 2:3 纵向'],
            ['AI 文案', 'OpenAI GPT-4o — Title / Description / Board 建议'],
            ['数据管线', 'Python 3.12 — pipeline.py 编排 + run_worker.py 云入口'],
            ['生产调度', '阿里云 VPS 47.89.181.103 · cron 0 9 * * * UTC · /opt/vibepin/backend'],
            ['前端部署', 'Vercel · SWR 数据缓存 · revalidate 60–300s'],
            ['监控', 'Sentry + PostHog（配置存在）'],
          ]}
          striped
        />
        <Callout tone="info" title="Pin Ideas vs Product Opportunities">
          <Text size="small">
            <strong>Pin Ideas</strong>（/app/discover）= 内容参考：高收藏 Pin 的格式、构图、角度（pin_samples）。
            <strong>Product Opportunities</strong>（/app/products）= 可变现商品：带 opportunity 分的实物/数字商品（pin_products + product_scores）。
            Landing FAQ 与产品文案均强调此区分。
          </Text>
        </Callout>
      </Stack>

      <Divider />

      {/* 2. 导航与页面地图 */}
      <Stack gap={12}>
        <H2>2. 导航结构与全站页面地图</H2>
        <Text tone="secondary" size="small">
          应用内侧边栏（<Code>web/src/app/app/layout.tsx</Code>）按 WORKFLOW + INTELLIGENCE 组织。
          用户菜单含 Language、Profile、Billing、Logout。
        </Text>

        <H3>2.1 营销 / 认证（公开）</H3>
        <Table
          headers={['页面', '路径', '状态', '功能要点']}
          rows={[
            ['Landing Page', '/', '上线', 'Hero + CTA · 情报演示表 · 趋势 ticker · 6 用例 · 4 档定价 · 6 FAQ · 社交证明 · useLandingAssets 拉真实图'],
            ['Login', '/login', '上线', 'Supabase 邮箱登录 → /app'],
            ['Signup', '/signup', '上线', '注册 · OAuth 回调'],
            ['Privacy', '/privacy', '上线', '隐私政策'],
            ['Terms', '/terms', '上线', '服务条款'],
            ['Pinterest App', '/pinterest-app', '上线', '说明 VibePin 如何使用 Pinterest 数据/API'],
          ]}
          striped
        />

        <H3>2.2 WORKFLOW — 内容生产</H3>
        <Table
          headers={['侧边栏 (i18n key)', '路径', '功能', '主要操作']}
          rows={[
            ['Home (nav.home)', '/app/workspace/[category]', '机会看板默认落点', '类目切换 · 机会卡 · 周进度 · Create Pin'],
            ['Create Pins (nav.createPins)', '/app/studio', 'AI Pin 工作室', 'URL/上传/参考图 · 生成 · 文案 · 加计划'],
            ['Weekly Plan (nav.weeklyPlan)', '/app/plan', '本周内容日历', 'Calendar/Board/Overview · 排期 · Brief'],
            ['My Pins (nav.myPins)', '/app/history', '生成历史', 'Session 分组 · 状态 · 下载 · Remix'],
          ]}
          striped
        />

        <H3>2.3 INTELLIGENCE — 数据情报</H3>
        <Table
          headers={['侧边栏', '路径', '功能', '主要操作']}
          rows={[
            ['Opportunities', '/app/workspace/.../opportunities', '机会聚焦视图', 'tier 榜 · 跳转 Studio'],
            ['Keyword Trends', '/app/trends', 'Keyword Tool', '搜词 · 榜单 · bands · 趋势曲线 · 相关词'],
            ['Pin Ideas', '/app/discover', '高收藏 Pin 画廊', 'Latest/Rising · 类目 · 参考 → Studio'],
            ['Product Opportunities', '/app/products', '商品情报', 'Physical/Digital · 过滤 · opportunity 排序'],
          ]}
          striped
        />

        <H3>2.4 设置与其它</H3>
        <Table
          headers={['页面', '路径', '功能']}
          rows={[
            ['Settings — Language', '/app/settings/language', 'UI 语言 · AI 文案语言 · Pinterest region'],
            ['Settings — Legacy', '/settings', 'Pinterest/IG OAuth · 发布偏好 · daily_limit'],
            ['Product Library', '/app/product-library', '用户收藏商品（productLibraryStore）'],
            ['Queue', '/app/queue', '发布队列（框架）'],
            ['Preview', '/preview/[taskId]', '生成任务预览'],
            ['Dashboard legacy', '/dashboard', '旧入口'],
          ]}
          striped
        />

        <H3>2.5 支持类目（ACTIVE_CATEGORIES）</H3>
        <Text size="small" tone="secondary">
          home-decor · fashion · beauty · food · travel · holidays-seasonal 等。
          Fashion 过滤时 CATEGORY_CHILDREN 同时匹配 womens-fashion / mens-fashion / kids-fashion。
          默认类目：home-decor。<Code>/app</Code> 重定向至 <Code>/app/workspace/home-decor</Code>。
        </Text>
      </Stack>

      <Divider />

      {/* 3. 各页面详解 */}
      <Stack gap={14}>
        <H2>3. 各页面功能详细说明</H2>

        {/* 3.1 Landing */}
        <Card>
          <CardHeader trailing={<Pill tone="success" size="sm">上线</Pill>}>3.1 Landing Page（/）</CardHeader>
          <CardBody>
            <Stack gap={8}>
              <Table
                headers={['区块', '内容']}
                rows={[
                  ['Hero', '主标题 + 双 CTA（Get started / See demo）→ signup'],
                  ['Intel 演示表', '静态 INTEL_ROWS：关键词、趋势%、竞争、分数（营销示意）'],
                  ['趋势 Ticker', 'TICKERS 滚动条：Boho / Nails / Japandi 等'],
                  ['产品演示', '三栏：Keyword Tool · Pin Ideas · Product Opportunities 截图区'],
                  ['用例 USE_CASE_META', '6 类：Home Decor / Fashion / Beauty / Food / Digital / Agency'],
                  ['定价 PRICING', 'Free $0 · Creator $19 · Growth $49 · Agency $99'],
                  ['FAQ', '5 问：产品做什么 · Pin vs Product · 是否自动发布 · 是否连 Pinterest · 数据来源'],
                  ['Testimonials', 'Creators / Sellers / Agencies 分组评价'],
                  ['Stats', '240k+ opportunities · 14k+ creators · 400+ categories · 32 languages'],
                ]}
                striped
              />
              <Text size="small" tone="secondary">
                素材：<Code>useLandingAssets</Code> 按类目从 pin_samples / pin_products 抽样真实图片。
                PIN_FORMATS 展示：Lifestyle · Close-up · Text Overlay · Tutorial · Moodboard 等。
              </Text>
            </Stack>
          </CardBody>
        </Card>

        {/* 3.2 Workspace */}
        <Card>
          <CardHeader trailing={<Pill tone="success" size="sm">上线</Pill>}>3.2 Home / Workspace</CardHeader>
          <CardBody>
            <Stack gap={8}>
              <Text size="small">
                登录后默认落点。URL 路径参数 category（如 home-decor）驱动数据过滤。
                <Code>GET /api/workspace/feed?category=&limit=24&offset=0</Code>
              </Text>
              <Table
                headers={['卡片元素', '数据来源', '展示字段']}
                rows={[
                  ['关键词机会', 'trend_opportunities_view', 'keyword · score_tier · opportunity_score · linked_pins/products · YoY/WoW · lifecycle'],
                  ['证据 Pin 缩略', 'pin_samples（每词最多 3 张）', 'image_url · save_count · trend_keyword_id'],
                  ['商品信号', 'keyword_product_map → pin_products', 'product_name · domain · image_url · source_url'],
                  ['Monetize hint', 'workspaceStatics.getMonetizeHint', '按 tier 生成变现路径文案'],
                  ['Title templates', 'workspaceStatics.getTitleTemplates', '3 条标题模板建议'],
                  ['周进度条', 'useWeeklyPlan + weekly_plans', '当前/目标 7·14·21 pins'],
                ]}
                striped
              />
              <Text size="small" tone="secondary">
                Feed 过滤：category 匹配 · score_tier ≠ low（隐藏 Watchlist）· 按 opportunity_score 降序。
                Pin 缩略图条件：save_count ≥ 100 · image_url 非空。
              </Text>
            </Stack>
          </CardBody>
        </Card>

        {/* 3.3 Weekly Plan */}
        <Card>
          <CardHeader trailing={<Pill tone="success" size="sm">上线</Pill>}>3.3 Weekly Plan</CardHeader>
          <CardBody>
            <Stack gap={8}>
              <Table
                headers={['视图', '展示']}
                rows={[
                  ['Calendar', 'MON–SUN 七列 · 每日 Pin 卡片 · 拖拽感布局'],
                  ['Board', '按状态分列：待发 / 已发 / 需排期'],
                  ['Overview', 'weeklyPlanStats：完成率 · 已排期 · 待加日期 · 未加入'],
                ]}
                striped
              />
              <Table
                headers={['数据表 / Hook', '字段 / 逻辑']}
                rows={[
                  ['weekly_plans', 'user_id · category · week_start（周一）· target_count · status'],
                  ['weekly_plan_items', 'keyword_id · keyword · tier · score · planned_date · sort_order · generated_asset_id · status'],
                  ['useWeeklyPlan', 'SWR key: weekly-plan:{category}:{weekStart}:{userId}'],
                  ['pin_drafts', 'DraftDetailsDrawer · 草稿详情编辑'],
                  ['Brief enrichment', 'title_hook · description_angle · content_type · visual_direction · monetization_path · cta_suggestion'],
                ]}
                striped
              />
              <Text size="small" tone="secondary">
                状态流：pending → processing → done / failed。
                从 Studio 通过 buildWeeklyPlanItemFromGeneratedPin 写入。
                回流 Studio：buildPrefillFromWeeklyPlan → createPinsPrefill。
              </Text>
            </Stack>
          </CardBody>
        </Card>

        {/* 3.4 Studio */}
        <Card>
          <CardHeader trailing={<Pill tone="success" size="sm">上线</Pill>}>3.4 Create Pins (Studio)</CardHeader>
          <CardBody>
            <Grid columns={2} gap={12}>
              <Stack gap={6}>
                <Text size="small"><strong>输入方式</strong></Text>
                <Text size="small">商品 URL → /api/fetch-og 抓 OG 图+标题</Text>
                <Text size="small">多图上传 → Supabase Storage / data URL</Text>
                <Text size="small">InlineCreateAssetPicker：Pin Ideas · Product Ideas · 本地上传 · URL 导入</Text>
                <Text size="small">createPinsPrefill：keyword · product_url · reference_pin · weekly plan 预填</Text>
                <Text size="small">Reference Mode：style_ref 图参与 Flux 生成</Text>
                <Text size="small">配置：Pin Type · count(1–8) · format 2:3 · text_overlay · reference_strength</Text>
              </Stack>
              <Stack gap={6}>
                <Text size="small"><strong>生成链路</strong></Text>
                <Text size="small">1. POST /api/generate → stdin JSON → generator.py</Text>
                <Text size="small">2. prompt_enhancer 组装 prompt（含 content language hint）</Text>
                <Text size="small">3. RunPod Flux 生成 → upload studio/{timestamp}.png</Text>
                <Text size="small">4. pinMetadata：GPT Title/Description/Board</Text>
                <Text size="small">5. studioPersistence → generated_assets + history</Text>
                <Text size="small">6. PinDetailsDrawer / BatchEditDrawer · 加 Weekly Plan</Text>
              </Stack>
            </Grid>
            <Table
              headers={['Pin Type', '适用场景']}
              rows={[
                ['Lifestyle Scene', '使用场景 + 生活化语境'],
                ['Product Collage', '多单品拼贴'],
                ['Moodboard', '情绪板、质感配色'],
                ['Gift Guide', '礼赠节日'],
                ['How to Style', '搭配教程感'],
                ['Seasonal Campaign', '季节节日主题'],
                ['Product Spotlight', '单 SKU 强焦点'],
                ['Collection / Roundup', '合集清单'],
              ]}
              striped
            />
            <Text size="small" tone="secondary">
              生成状态：pending · processing · done · failed · stale running 自动 resolve。
              Remix：remixRecoveryStore 保存 setup snapshot 可恢复。
            </Text>
          </CardBody>
        </Card>

        {/* 3.5 Keyword Tool */}
        <Card>
          <CardHeader trailing={<Pill tone="success" size="sm">上线</Pill>}>3.5 Keyword Trends（Keyword Tool）</CardHeader>
          <CardBody>
            <Stack gap={8}>
              <Table
                headers={['API', 'Query 参数', '返回']}
                rows={[
                  ['/api/keyword-tool/search', 'keyword · region', '委托 /api/keyword-trends?q=&limit=1 → summary'],
                  ['/api/keyword-tool/related', 'keyword · category · region', '同类目相关词 RelatedKeywordRow[]'],
                  ['/api/keyword-trends', 'q · region · category · limit · offset · freshness · opportunity_focus', 'summary + trending[] + meta'],
                ]}
                striped
              />
              <Table
                headers={['展示字段', 'DB 来源', '说明']}
                rows={[
                  ['search_volume_level', 'trend_keywords', 'very_high / high / medium / low'],
                  ['yearly_change / weekly_change', 'trend_keywords', 'YoY / WoW %'],
                  ['trend_lifecycle', 'trend_keywords', 'rising / peak / declining / steady / unclear'],
                  ['opportunity_tier / score_tier', 'trend_opportunities_view', 'Blue Ocean / Early Trend / Steady / Competitive'],
                  ['linked_pins_count / linked_products_count', 'trend_opportunities_view', '证据覆盖度'],
                  ['trend_history / trend_series', 'trend_keywords', '52 周曲线 · TrendHistoryChart'],
                  ['source_layer / data_quality', 'trend_keywords', 'pinterest_trends_api / typeahead_estimated 等'],
                  ['Interest/Trend/Competition/Save bands', '前端 mapTrendKeywordRow', 'Low / Medium / High / Very High'],
                  ['Opportunity labels', '前端', 'Best Bet · Steady · Competitive · Watchlist'],
                ]}
                striped
              />
              <Text size="small" tone="secondary">
                region 来自 Settings 的 Pinterest Region（usePinterestRegion）。
                新鲜度：pipeline_runs job=trends 或 trend_keywords.last_updated_at。
                跳转：buildPrefillFromKeywordTrend → openCreatePins。
              </Text>
            </Stack>
          </CardBody>
        </Card>

        {/* 3.6 Pin Ideas */}
        <Card>
          <CardHeader trailing={<Pill tone="success" size="sm">上线</Pill>}>3.6 Pin Ideas（/app/discover）</CardHeader>
          <CardBody>
            <Stack gap={8}>
              <Table
                headers={['能力', '实现细节']}
                rows={[
                  ['主 API', 'GET /api/viral-pins?limit=160&category=&offset= — revalidate 60s'],
                  ['Fallback', 'fetchPinIdeasWithMeta → Supabase pin_samples limit 160'],
                  ['排序', 'API 默认 save_count DESC；页面 Tab 可切 Latest / Rising'],
                  ['Latest Tab', '按 scraped_at 新近度（前端重排）'],
                  ['Rising Tab', 'save_velocity = saves / days_since_creation'],
                  ['入库门槛', 'scraper_v2: save≥500 · age≤90d · 非 meme/wallpaper 等负向词'],
                  ['分类', 'classifySourcePin → shouldShowInPinIdeas（pin_idea / content_opportunity）'],
                  ['Pin Format', 'inferPinFormat：Lifestyle · Tutorial · Text Overlay 等 7 类'],
                  ['过滤', '类目 · Physical/Digital · selectedNiches · Pin Format · 搜索'],
                  ['信号标签', 'assessPin → PrimaryBadge: best_bet / steady / competitive'],
                  ['操作', 'Bookmark · 加入 Product Library · openCreatePins(reference)'],
                  ['外链', 'source_url / outbound_link 查看原 Pin'],
                ]}
                striped
              />
            </Stack>
          </CardBody>
        </Card>

        {/* 3.7 Product Opportunities */}
        <Card>
          <CardHeader trailing={<Pill tone="success" size="sm">上线</Pill>}>3.7 Product Opportunities（/app/products）</CardHeader>
          <CardBody>
            <Stack gap={10}>
              <Table
                headers={['能力', '实现细节']}
                rows={[
                  ['主 API', 'GET /api/products/top?limit=200&sort=opportunity&offset= — 90s 内存缓存'],
                  ['JOIN', 'pin_products + product_scores（product_scores IS NOT NULL）'],
                  ['排序 sort', 'opportunity（默认）· saves · velocity（source_pin_save_count）'],
                  ['Fallback', 'pin_products save≥10 · 无 product_scores 时无 opportunity 排序'],
                  ['详情 API', 'GET /api/product/[id]/intelligence'],
                ]}
                striped
              />
              <H3>Physical（实物）</H3>
              <Table
                headers={['功能', '说明']}
                rows={[
                  ['类目', 'Category 下拉 · CATEGORY_CHILDREN 父子映射'],
                  ['平台', 'Etsy · Amazon · Poshmark · Target · Walmart 等 domain 过滤'],
                  ['利基', 'useNicheScope selectedNiches → seed_keyword / product_name'],
                  ['搜索', 'product_name · seed_keyword · domain 模糊匹配'],
                  ['卡片', '图 · 名 · 域名 · save_count · opportunity_score · market tag'],
                  ['跳转 Studio', 'buildPrefill 带 product_url · product_name · images'],
                ]}
                striped
              />
              <H3>Digital（数字）</H3>
              <Table
                headers={['功能', '说明']}
                rows={[
                  ['识别', 'is_digital · 域名 TPT/Payhip/Gumroad/CreativeMarket · title token'],
                  ['关键词组', 'planners · templates · worksheets · wall_art · kids_education · business · crafts_svg'],
                  ['管线', 'digital_product_scraper.py · MIN_SAVES=20'],
                  ['展示', '按 niche 分组 · 平台 · format · 估算需求'],
                ]}
                striped
              />
            </Stack>
          </CardBody>
        </Card>

        {/* 3.8 My Pins */}
        <Card>
          <CardHeader trailing={<Pill tone="success" size="sm">上线</Pill>}>3.8 My Pins（History）</CardHeader>
          <CardBody>
            <Text size="small">
              按 generation session 分组展示。字段：Pin Type · 输入商品快照 · 各 Pin 状态 · image_url（storage-image 代理）。
              操作：加入 Weekly Plan · 下载 · 查看/编辑 Title/Description · Remix · Batch Edit。
              数据：generated_assets · fetchGenerationsFromDb · /api/history-storage。
              状态：pending → processing → done / failed；resolveStaleRunningEntries 清理卡住任务。
            </Text>
          </CardBody>
        </Card>

        {/* 3.9 Settings */}
        <Card>
          <CardHeader trailing={<Pill tone="success" size="sm">上线</Pill>}>3.9 Settings</CardHeader>
          <CardBody>
            <Grid columns={2} gap={14}>
              <Stack gap={6}>
                <Text size="small"><strong>/app/settings/language</strong></Text>
                <Text size="small">App UI：en · zh-CN · zh-TW · ja · ko · de · es · pt + beta</Text>
                <Text size="small">Content Language：AI 生成 Pin 文案语言（可与 UI 不同）</Text>
                <Text size="small">Pinterest Region：US · UK · CA · AU · DE · FR … → Keyword Tool region 参数</Text>
                <Text size="small">LocaleProvider + localStorage 持久化</Text>
                <Text size="small">侧边栏 Globe 图标快捷打开 LanguageRegionModal</Text>
              </Stack>
              <Stack gap={6}>
                <Text size="small"><strong>/settings（Legacy FastAPI）</strong></Text>
                <Text size="small">Pinterest OAuth：/api/auth/pinterest · 连接状态 · username</Text>
                <Text size="small">Instagram OAuth：/api/auth/instagram</Text>
                <Text size="small">auto_publish（默认 false）· review_image · review_copy</Text>
                <Text size="small">daily_limit 1–25 · default_platforms: both/pinterest/instagram</Text>
                <Text size="small">default_style: scandinavian 等</Text>
              </Stack>
            </Grid>
          </CardBody>
        </Card>

        {/* 3.10 其它 */}
        <Card>
          <CardHeader trailing={<Pill tone="neutral" size="sm">框架</Pill>}>3.10 Product Library · Queue · Publish</CardHeader>
          <CardBody>
            <Table
              headers={['模块', '状态', '说明']}
              rows={[
                ['Product Library', '部分', 'productLibraryStore + assetStore · 从 Pin Ideas / Products 收藏'],
                ['Queue /app/queue', '框架', '发布队列 UI 存在'],
                ['/api/publish', '未验证', 'Pinterest 发布 · OAuth token 依赖 legacy API'],
                ['/api/publish-jobs', '未验证', '批量发布任务'],
                ['/api/composer-drafts', '上线', 'Studio 草稿持久化'],
                ['/api/import/product-urls', '上线', '批量导入商品 URL'],
              ]}
              striped
            />
          </CardBody>
        </Card>
      </Stack>

      <Divider />

      {/* 4. 取数逻辑 */}
      <Stack gap={12}>
        <H2>4. 前端取数逻辑（完整）</H2>
        <Callout tone="info" title="核心原则">
          <Text size="small">
            Intelligence 页面共享 Supabase 仓库。trend_opportunities_view 是关键词机会聚合中枢。
            API-first + SWR/fetch；失败 fallback Supabase 直连。assetClassification 运行时过滤展示。
          </Text>
        </Callout>

        <Table
          headers={['页面', '取数入口', '主表/视图', 'Query / 过滤']}
          rows={[
            ['Workspace', '/api/workspace/feed', 'trend_opportunities_view → pin_samples → kpm → pin_products', 'category · score_tier≠low · limit 24 · offset'],
            ['Keyword 搜索', '/api/keyword-tool/search → keyword-trends', 'trend_keywords + opp view', 'q · region · pickBestMatch 精确/LIKE'],
            ['Keyword 相关', '/api/keyword-tool/related', 'trend_keywords + opp', 'category · wordOverlapScore 排序'],
            ['Keyword 榜单', '/api/keyword-trends', 'trend_keywords', 'category · region · limit 20 · trendingSortScore'],
            ['Pin Ideas', '/api/viral-pins', 'pin_samples', 'limit 160 · category · order save_count DESC'],
            ['Pin Ideas FB', 'fetchPinIdeasWithMeta', 'pin_samples', 'image_url NOT NULL · classify 过滤'],
            ['Products', '/api/products/top', 'pin_products ⨝ product_scores', 'sort=opportunity · min_score · limit 200'],
            ['Products FB', 'fetchProductIdeasWithMeta', 'pin_products', 'save≥10 · 无 scores 时 opportunity=null'],
            ['Studio Picker', 'fetchPinIdeas / fetchProductIdeas', '同上', 'InlineCreateAssetPicker 双 tab'],
            ['Weekly Plan', 'useWeeklyPlan', 'weekly_plans + weekly_plan_items', 'user_id · week_start 周一'],
            ['My Pins', 'fetchGenerationsFromDb', 'generated_assets', 'user_id · task_id 分组'],
            ['Landing', 'useLandingAssets', 'pin_samples + pin_products', 'pickByCategory 抽样'],
            ['Opportunities API', '/api/opportunities', 'trend_opportunities_view', 'tier · category 过滤'],
            ['Top Keywords', '/api/keywords/top', 'trend_keywords', 'priority_score 排序'],
          ]}
          striped
        />

        <H3>4.1 API 缓存与新鲜度</H3>
        <Table
          headers={['API', 'revalidate / 缓存', 'lastUpdatedAt 来源']}
          rows={[
            ['/api/viral-pins', '60s', 'pipeline_runs crawl completed · scraped_at'],
            ['/api/products/top', '120s route + 90s 内存 Map', 'pipeline_runs stl-score · scraped_at'],
            ['/api/keyword-trends', '300s', 'pipeline_runs trends · last_updated_at'],
            ['/api/workspace/feed', 'force-dynamic 无缓存', '实时查询'],
          ]}
          striped
        />

        <H3>4.2 assetClassification 展示过滤</H3>
        <Table
          headers={['函数', '保留', '排除']}
          rows={[
            ['shouldShowInPinIdeas', 'pin_idea · content_opportunity', 'product · product_collection'],
            ['shouldShowInProductIdeas', 'product · product_collection', 'pin_idea · content_opportunity'],
            ['classifySourcePin', 'asset_role=pin_reference', '纯商品类 Pin'],
            ['classifyDestination', 'domain/price/url → product 或 collection', 'article/blog → content_opportunity'],
            ['risk_flags', 'ip_sensitive（IP 敏感词 token）', '—'],
          ]}
          striped
        />
      </Stack>

      <Divider />

      {/* 5. 跳转 */}
      <Stack gap={12}>
        <H2>5. 页面跳转与预填参数</H2>
        <Table
          headers={['来源', '目标', '触发', 'URL / 参数']}
          rows={[
            ['Workspace 机会卡', '/app/studio', 'Create Pin', '?keyword= · opportunity_id= · category='],
            ['Pin Ideas', '/app/studio', 'Use as Reference', 'createPinsPrefill: reference_pin_id · style_ref · keyword'],
            ['Product Opportunities', '/app/studio', 'Studio 图标', 'product_url · product_name · product_images[]'],
            ['Keyword Trends', '/app/studio', 'Create Pin for keyword', 'keyword · category · tier'],
            ['Weekly Plan', '/app/studio', 'Edit / Regenerate', 'weeklyPlanHandoff → prefill'],
            ['Studio 完成', '/app/history', '导航/提示', 'session_id'],
            ['History / Studio', '/app/plan', 'Add to Weekly Plan', 'generated_asset_id → weekly_plan_items'],
            ['Landing Hero', '/signup', 'CTA', '—'],
            ['任意 Intelligence', '/app/workspace/[cat]', '侧边栏 Home', '路径 category 变更'],
            ['/app', '/app/workspace/home-decor', 'middleware/redirect', '—'],
          ]}
          striped
        />
        <UserFlowDiagram />
      </Stack>

      <Divider />

      {/* 6. 后台跑数 */}
      <Stack gap={12}>
        <H2>6. 后台跑数管线（完整）</H2>
        <PipelineDiagram />

        <H3>6.1 pipeline.py 全步骤</H3>
        <Table
          headers={['步骤', '脚本', '输入', '输出', '核心逻辑']}
          rows={[
            ['interests', 'interest_discovery.py', 'Pinterest 类目', 'trend_interests', 'discover_and_upsert · interest_slug · is_active'],
            ['trends', 'trend_fetcher.py', 'trend_interests', 'trend_keywords + crawl_queue', 'L1 官方 Trends → L2 Resource → L3 Typeahead；filter: vol≥medium · YoY≥100% · WoW≥0%'],
            ['crawl', 'scraper_v2.py', 'crawl_queue', 'pin_samples + keyword_expansions', 'curl_cffi + Playwright · save≥500 入库 · ≥5000 STL 标记 · ≤90d'],
            ['stl', 'shop_the_look.py', 'pin_samples save≥5000', 'pin_products', 'Playwright Shop the Look · 商品 save≥10 或有价 · URL 规范化'],
            ['score', 'calculate_product_scores.py', 'pin_products + trend_keywords', 'product_scores + keyword_product_map', 'opportunity 加权打分 · M2M 映射'],
            ['digital', 'digital_product_scraper.py', '数字关键词组', 'pin_products', 'TPT/Gumroad 等 · MIN_SAVES=20 · intent token'],
            ['enrich', 'trend_fetcher enrich', 'trend_keywords', 'trend_history 52w', 'time_series API'],
            ['enrich_competition', 'trend_fetcher', 'trend_keywords', 'competition_* 字段', '竞争信号补全'],
            ['classify', 'classify_product_signals + classify_reference_pins', 'products / pins', 'product_type 等写回', '信号分类'],
            ['opportunities', 'generate_opportunities.py', '聚合', 'opportunities 表', '可选机会表生成'],
          ]}
          striped
        />

        <H3>6.2 crawl_queue 队列逻辑</H3>
        <Table
          headers={['状态', '行为']}
          rows={[
            ['新词', 'insert pending · priority_score 来自 trend'],
            ['pending', '保持 pending · 更高 priority 则 bump'],
            ['processing/running', '不覆盖'],
            ['completed >7d', 'requeue pending（stale requeue）'],
            ['failed attempts<3', 'requeue pending'],
            ['MIN_PENDING_FOR_CRAWL', '20 — daily catch-up 触发阈值'],
          ]}
          striped
        />

        <H3>6.3 run_worker.py 云任务</H3>
        <Table
          headers={['Job', 'handler', '默认参数', '锁 / 超时']}
          rows={[
            ['smoke', 'cloud_smoke.run_smoke', 'top_n≤5 · crawl≤3 kw', '无锁 · 部署验证'],
            ['trends', 'job_trends → step_interests + step_trends', 'top_n=30 · region=US', 'trends · 1h'],
            ['crawl', 'job_crawl → step_crawl', 'limit_keywords=80 · concurrency=3', 'crawl · 2h'],
            ['stl-score', 'job_stl_score → step_stl + step_score', 'stl_limit=300', 'stl-score · 1.5h'],
            ['daily', 'job_daily 全流程', '同上 · catch-up 若 pending≥20', 'daily · 3h'],
          ]}
          striped
        />

        <H3>6.4 daily 任务顺序</H3>
        <DailyJobDiagram />
        <Table
          headers={['#', '步骤', '写入/更新', '影响页面']}
          rows={[
            ['1', 'job_trends', 'trend_keywords · crawl_queue', 'Keyword Tool · Workspace'],
            ['2', 'job_crawl main', 'pin_samples（≤80 keywords）', 'Pin Ideas · Workspace 证据'],
            ['3', 'job_crawl catch-up', 'pin_samples 追加', '同上（queue 积压时）'],
            ['4', 'job_stl_score', 'pin_products · product_scores', 'Product Opportunities'],
            ['5', 'refresh_pipeline_views', '检查 trend_opportunities_view', 'Workspace · Keyword'],
            ['—', 'pipeline_runs', 'finished_at · stats JSON', '各 API lastUpdatedAt'],
          ]}
          striped
        />

        <H3>6.5 生产 VPS 定时调度</H3>
        <Callout tone="success" title="2026-06-10 生产验证通过">
          <Text size="small">
            服务器 47.89.181.103（阿里云 Ubuntu 24.04 弗吉尼亚）· 部署路径 /opt/vibepin/backend ·
            venv .venv · 迁移 v23+v24 已应用 · Windows Task Scheduler 可停用。
          </Text>
        </Callout>
        <Table
          headers={['配置项', '值']}
          rows={[
            ['Cron', '0 9 * * * UTC ≈ 北京 17:00'],
            ['命令', '.venv/bin/python run_worker.py --job daily >> logs/cron_daily.log 2>&1'],
            ['安装', 'bash scripts/install_cron_daily.sh'],
            ['部署', 'scripts/deploy_vps_paramiko.py（Windows → zip → SSH）'],
            ['首次自动跑', '2026-06-10 01:00–03:53 UTC（stl ~3h）'],
            ['环境变量', 'SUPABASE_URL · SUPABASE_SERVICE_ROLE_KEY（deploy.env）'],
            ['推荐关闭', 'ENABLE_PINTEREST_TRENDS_L1=false · ENABLE_PINTEREST_RESOURCE_L2=false'],
            ['Playwright', 'pip playwright · install chromium · install-deps chromium'],
          ]}
          striped
        />

        <H3>6.6 运维脚本（Windows → VPS）</H3>
        <Table
          headers={['脚本', '用途']}
          rows={[
            ['remote_bootstrap.py', 'VPS 初始化 venv + requirements-cloud.txt'],
            ['remote_verify.py / remote_cloud_verify.py', '全链路验证'],
            ['remote_status.py', '远程 pipeline 状态'],
            ['remote_run_stl.py / remote_fix_stl.py', '手动/修复 stl-score'],
            ['remote_clear_and_stl.py', '清锁 + nohup 后台 stl'],
            ['remote_poll_stl.py', '轮询 stl 完成'],
            ['remote_install_cron.py', '安装 cron'],
            ['clear_stale_runs.py', '清过期 lock + stale running runs'],
            ['check_pipeline_status.py', '本地查 Supabase 状态（最常用）'],
            ['verify_db_labels.py', 'trend labels + crawl_queue 检查'],
          ]}
          striped
        />

        <H3>6.7 入库阈值</H3>
        <Table
          headers={['层级', '阈值', '常量 / 脚本']}
          rows={[
            ['Pin 候选', 'save ≥ 500', 'PIN_CANDIDATE_SAVES · scraper_v2'],
            ['Pin 病毒', 'save ≥ 5,000', 'PIN_VIRAL_SAVES · STL 触发'],
            ['Pin 精品', 'save ≥ 10,000', 'PIN_PREMIUM_SAVES'],
            ['Pin 年龄', '≤ 90 天', 'FRESHNESS_DAYS'],
            ['负向过滤', 'meme/wallpaper/anime…', 'NEGATIVE_TERMS'],
            ['STL 源 Pin', 'save ≥ 5,000', 'STL_MIN_SAVES · shop_the_look'],
            ['商品保留', 'save ≥ 10 或有 price', 'MIN_PRODUCT_SAVE'],
            ['数字商品', 'save ≥ 20 + 平台 token', 'digital_product_scraper'],
            ['Trend 入库', 'vol≥medium · YoY≥100% · WoW≥0%', 'trend_fetcher filter'],
            ['Crawl 并发', '默认 3（max 5）', 'run_worker --concurrency'],
            ['每词 Pin 上限', '75', 'pipeline --max-pins'],
          ]}
          striped
        />

        <H3>6.8 命令速查</H3>
        <Table
          headers={['场景', '命令']}
          rows={[
            ['VPS 日更', 'run_worker.py --job daily'],
            ['只趋势', 'run_worker.py --job trends'],
            ['只爬 Pin', 'run_worker.py --job crawl --limit-keywords 80 --concurrency 3'],
            ['只 STL+分', 'run_worker.py --job stl-score --stl-limit 300'],
            ['部署验证', 'run_worker.py --job smoke'],
            ['完整 pipeline', 'py pipeline.py'],
            ['单步', 'py pipeline.py --step trends|crawl|stl|score|digital|enrich|classify'],
            ['本地状态', 'python scripts/check_pipeline_status.py'],
            ['清锁重跑', 'python scripts/clear_stale_runs.py'],
          ]}
          striped
        />
      </Stack>

      <Divider />

      {/* 7. Pinterest API */}
      <Stack gap={12}>
        <H2>7. Pinterest API / Resource 调用层</H2>
        <Text tone="secondary" size="small">
          curl_cffi 模拟 Chrome → 首页 bootstrap cookie/csrftoken/appVersion → 带 Headers 调 Resource。
          Cookie 持久化：backend/pinterest_profile/。L1/L2 可通过 env 关闭。
        </Text>
        <Table
          headers={['接口', 'Endpoint', '数据', '调用方']}
          rows={[
            ['Trends Suggested', 'trends.../keywords/suggested/', 'keyword · volume · YoY/WoW', 'trend_fetcher L1'],
            ['Trends Category Top', 'trends.../categories/top/', '类目 top 词', 'trend_fetcher L1'],
            ['Time Series', 'trends.../keywords/time_series/', '52 周 0–100 序列', 'enrich'],
            ['TrendingSearchResource', 'resource/TrendingSearchResource/get/', '内部趋势', 'trend_fetcher L2'],
            ['TrendKeywordsResource', 'resource/TrendKeywordsResource/get/', '关键词趋势', 'L2 fallback'],
            ['AdvancedTypeaheadResource', 'resource/AdvancedTypeaheadResource/get/', '扩词/联想', 'L3 + scraper'],
            ['BaseSearchResource', 'resource/BaseSearchResource/get/', 'Pin 搜索+分页', 'scraper_v2'],
            ['PinResource', 'resource/PinResource/get/', 'Pin 详情·save·link', 'scraper_v2'],
            ['RelatedPinFeedResource', 'resource/RelatedPinFeedResource/get/', '相关 Pin 图', 'scraper_v2 premium'],
          ]}
          striped
        />
      </Stack>

      <Divider />

      {/* 8. 数据库 */}
      <Stack gap={12}>
        <H2>8. 数据库结构（Supabase PostgreSQL）</H2>
        <Table
          headers={['表/视图', '角色', '关键字段', '消费方']}
          rows={[
            ['trend_interests', '爬取入口', 'interest_slug · country · is_active · last_fetched_at', '管线'],
            ['trend_keywords', '关键词事实', 'keyword · category · yearly/weekly_change · search_volume_level · priority_score · trend_history · source_layer · region', 'Keyword Tool'],
            ['crawl_queue', '抓取队列', 'keyword · priority_score · status · attempts · last_error · scheduled_at', '管线'],
            ['keyword_expansions', '扩词记录', 'seed_keyword · expanded_keyword', '管线'],
            ['pin_samples', 'Pin 证据', 'pin_id · trend_keyword_id · image_url · save_count · save_velocity · outbound_link · scraped_at · category', 'Pin Ideas · Workspace · STL'],
            ['pin_products', '商品信号', 'parent_pin_id · product_name · source_url · domain · price · is_digital · source_pin_save_count · scraped_at', 'Products · Studio'],
            ['product_scores', '商品分', 'opportunity_score · trend_score · save_velocity_score · freshness_score · competition_score', 'Products API'],
            ['keyword_product_map', '词商品 M2M', 'keyword_id · product_id · relevance_score · total_saves', 'Workspace'],
            ['trend_opportunities_view', '机会聚合', 'score_tier · opportunity_tier · linked_pins/products_count · data_confidence · monetization_confidence', 'Workspace · Keyword'],
            ['pipeline_runs', '跑数记录', 'job_type · status · started_at · finished_at · stats · created_by', '新鲜度 API'],
            ['pipeline_locks', '分布式锁', 'lock_name · holder · expires_at', 'run_worker'],
            ['generated_assets', '用户 Pin', 'user_id · task_id · image_url · title · description · pin_type · status', 'History · Studio'],
            ['weekly_plans', '周计划头', 'user_id · week_start · target_count · category', 'Weekly Plan'],
            ['weekly_plan_items', '计划项', 'keyword · planned_date · sort_order · generated_asset_id · status', 'Weekly Plan'],
          ]}
          striped
        />
        <Text tone="secondary" size="small">
          VPS 快照 2026-06-10：pin_samples 12,461 · pin_products 2,246 · crawl_queue completed 1,365 pending 0 ·
          L3 labels pinterest_typeahead_estimated · search_volume=null 符合预期。
        </Text>
      </Stack>

      <Divider />

      {/* 9. 评分 */}
      <Stack gap={12}>
        <H2>9. 评分与分级体系</H2>

        <H3>9.1 关键词机会 tier（trend_opportunities_view）</H3>
        <Table
          headers={['Tier', '标签', '条件概要', '建议']}
          rows={[
            ['high', 'Blue Ocean', 'YoY≥200% 且 (saves≥5000 或 vol very_high) 且 linked_pins≤30', '优先布局'],
            ['medium', 'Early Trend / Steady', 'YoY≥100% 有证据；或 high vol 且 WoW≥0%', '差异化跟进'],
            ['low', 'Competitive / Watchlist', '不满足 high/medium', '观望或跳过'],
          ]}
          striped
        />

        <H3>9.2 opportunity_score 公式</H3>
        <Table
          headers={['子分', '权重', '校准']}
          rows={[
            ['save_velocity_score', '40%', 'log10 · 1000 saves/day → 100'],
            ['trend_score', '30%', 'log10 · 500% YoY → 100'],
            ['freshness_score', '20%', '90 天线性衰减'],
            ['product_density_score', '10%', '每词≥10 产品 → 100'],
          ]}
          striped
        />
        <Text size="small" tone="secondary">
          competition_score = 100 − density_score（单独存储，不进 opportunity 公式）。
        </Text>

        <H3>9.3 Market Tag（lib/scoring.ts 前端）</H3>
        <Table
          headers={['Tag', '含义', '展示']}
          rows={[
            ['hidden_supply', '高需求低供给', 'Best Bet / 蓝'],
            ['new_account_friendly', '新号友好', 'Good Start / 绿'],
            ['oversaturated', '竞争过度', 'Crowded / 红'],
            ['low_volume', '需求太小', 'Low Volume / 灰'],
            ['Steady', '稳定无强信号', 'Steady / 白'],
          ]}
          striped
        />

        <H3>9.4 Pin 信号层级（scraper_v2）</H3>
        <Table
          headers={['层级', 'save 门槛', '用途']}
          rows={[
            ['Candidate', '500', '进 pin_samples'],
            ['Viral', '5,000', 'STL 资格'],
            ['Premium', '10,000', '高置信度 · related graph'],
          ]}
          striped
        />
      </Stack>

      <Divider />

      {/* 10. 技术栈 */}
      <Stack gap={12}>
        <H2>10. 技术栈明细</H2>
        <Grid columns={2} gap={14}>
          <Card>
            <CardHeader>前端</CardHeader>
            <CardBody>
              <Stack gap={4}>
                <Text size="small">Next.js 16 (Turbopack) · React 19 · TS 5 · Tailwind 4</Text>
                <Text size="small">Supabase SSR Auth · SWR 2.4 · Sonner toast</Text>
                <Text size="small">Lucide icons · i18n 8+ 语言 LocaleProvider</Text>
                <Text size="small">部署 Vercel</Text>
              </Stack>
            </CardBody>
          </Card>
          <Card>
            <CardHeader>Backend 管线</CardHeader>
            <CardBody>
              <Stack gap={4}>
                <Text size="small">Python 3.12 · Playwright · curl_cffi · BeautifulSoup4</Text>
                <Text size="small">backend/db/db.py Supabase HTTP 封装</Text>
                <Text size="small">pipeline_tracking.py 锁+runs</Text>
                <Text size="small">部署 VPS /opt/vibepin/backend</Text>
              </Stack>
            </CardBody>
          </Card>
          <Card>
            <CardHeader>AI</CardHeader>
            <CardBody>
              <Stack gap={4}>
                <Text size="small">Flux.1 Schnell RunPod · 2:3 默认</Text>
                <Text size="small">GPT-4o 文案 · prompt_enhancer</Text>
                <Text size="small">contentLanguagePromptHint 多语言</Text>
              </Stack>
            </CardBody>
          </Card>
          <Card>
            <CardHeader>基础设施</CardHeader>
            <CardBody>
              <Stack gap={4}>
                <Text size="small">Supabase PG + Storage CDN</Text>
                <Text size="small">FastAPI legacy（/settings OAuth）</Text>
                <Text size="small">Sentry · PostHog</Text>
              </Stack>
            </CardBody>
          </Card>
        </Grid>
      </Stack>

      <Divider />

      {/* 11. Pin 生成规则 */}
      <Stack gap={10}>
        <H2>11. 高转化 Pin 生成规则</H2>
        <Table
          headers={['规则', '说明']}
          rows={[
            ['2:3 纵向', 'Pinterest-first 默认比例'],
            ['视觉焦点', '主体清晰 · 主次分明'],
            ['生活化', '强场景 · 避免纯白底电商直出'],
            ['构图留白', '为 Title 叠加预留安全边距'],
            ['平台原生感', '像自然 Pin 而非广告'],
            ['禁止虚假折扣', '用户未提供则不虚构促销'],
            ['移动端可读', '含字时最小字号手机可读'],
            ['禁止误导宣称', '不虚假功效 · 不冒充官方'],
          ]}
          striped
        />
      </Stack>

      <Divider />

      {/* 12. 缺口 Roadmap */}
      <Stack gap={12}>
        <H2>12. 已知缺口与 Roadmap</H2>
        <Grid columns={3} gap={14}>
          <Card>
            <CardHeader trailing={<Pill tone="success" size="sm">已解决</Pill>}>数据工厂定时</CardHeader>
            <CardBody>
              <Stack gap={4}>
                <Text size="small">VPS cron daily 2026-06-10 验证</Text>
                <Text size="small">pipeline_runs + pipeline_locks 追踪</Text>
                <Text size="small">check_pipeline_status 本地监控</Text>
              </Stack>
            </CardBody>
          </Card>
          <Card>
            <CardHeader trailing={<Pill tone="warning" size="sm">P1</Pill>}>发布闭环</CardHeader>
            <CardBody>
              <Stack gap={4}>
                <Text size="small">Pinterest OAuth 端到端未验证</Text>
                <Text size="small">批量发布 · 排期 · 时区 · 每日上限</Text>
                <Text size="small">发布后 Pin URL + 表现回写</Text>
              </Stack>
            </CardBody>
          </Card>
          <Card>
            <CardHeader trailing={<Pill tone="warning" size="sm">P1</Pill>}>信号产品化</CardHeader>
            <CardBody>
              <Stack gap={4}>
                <Text size="small">Digital 商品平台标识/分组加强</Text>
                <Text size="small">Workspace evidence reason 展示</Text>
                <Text size="small">Keyword 数据来源 + last_fetched 明示</Text>
                <Text size="small">Studio 自动 brief 带入三源信号</Text>
              </Stack>
            </CardBody>
          </Card>
        </Grid>
        <Callout tone="error" title="当前最大风险">
          <Text size="small">
            发布闭环未端到端验证；Pinterest cookie/API shape 变化可能导致管线空跑（需监控 pipeline_runs 成功率与 crawl_queue failed）。
            stl-score 单次可运行 1–3 小时，daily 锁超时设为 3h。
          </Text>
        </Callout>
      </Stack>

      <Text tone="quaternary" size="small" style={{ marginTop: 12 }}>
        VibePin PRD v7.1 Detailed · 2026-06-11 · 替代 v6 作为全平台基准 · 参考 backend/VPS_DEPLOY_LOG.md
      </Text>
    </Stack>
  );
}
