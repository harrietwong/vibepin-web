import {
  Stack,
  H1,
  H2,
  H3,
  Text,
  Grid,
  Row,
  Stat,
  Divider,
  Card,
  CardHeader,
  CardBody,
  Table,
  Callout,
  Pill,
  Code,
  useHostTheme,
  computeDAGLayout,
} from 'cursor/canvas';

/**
 * VibePin PRD v5.0 - Data Intelligence Operating Model
 *
 * This PRD refreshes the older v4.0 Growth OS PRD with the current code reality:
 * - Workspace, Keyword Tool, Pin Opportunity and ProductSignals all sit on the
 *   same Pinterest intelligence warehouse.
 * - Data is produced by Python pipelines, persisted in Supabase, then consumed
 *   by Next.js API routes and app pages.
 * - The current product strength is not a single page. It is the shared data
 *   system that turns Pinterest trend, pin and product signals into actionable
 *   opportunity cards.
 */

const pipelineNodes = [
  { id: 'interests' },
  { id: 'keywords' },
  { id: 'pins' },
  { id: 'products' },
  { id: 'scores' },
  { id: 'view' },
  { id: 'pages' },
];

const pipelineEdges = [
  { from: 'interests', to: 'keywords' },
  { from: 'keywords', to: 'pins' },
  { from: 'pins', to: 'products' },
  { from: 'products', to: 'scores' },
  { from: 'scores', to: 'view' },
  { from: 'view', to: 'pages' },
];

const pipelineLabels: Record<string, string> = {
  interests: 'Interest Seeds',
  keywords: 'Trend Keywords',
  pins: 'Pin Evidence',
  products: 'Product Signals',
  scores: 'Score Engine',
  view: 'Opportunity View',
  pages: 'Product Pages',
};

const pipelineSubLabels: Record<string, string> = {
  interests: 'trend_interests',
  keywords: 'trend_keywords + crawl_queue',
  pins: 'pin_samples',
  products: 'pin_products',
  scores: 'product_scores + keyword_product_map',
  view: 'trend_opportunities_view',
  pages: 'Workspace / Keyword Tool / Products',
};

const pipelineLayout = computeDAGLayout({
  nodes: pipelineNodes,
  edges: pipelineEdges,
  direction: 'horizontal',
  nodeWidth: 132,
  nodeHeight: 54,
  rankGap: 18,
  nodeGap: 14,
  padding: 16,
});

function PipelineDiagram() {
  const theme = useHostTheme();
  return (
    <div style={{ overflowX: 'auto' }}>
      <svg width={pipelineLayout.width} height={pipelineLayout.height + 8} style={{ display: 'block' }}>
        <defs>
          <marker id="pipelineArrow" markerWidth="7" markerHeight="7" refX="5" refY="3.5" orient="auto">
            <path d="M0,0 L0,7 L7,3.5 z" fill={theme.stroke.secondary} />
          </marker>
        </defs>
        {pipelineLayout.edges.map((edge, index) => (
          <line
            key={index}
            x1={edge.sourceX}
            y1={edge.sourceY}
            x2={edge.targetX - 7}
            y2={edge.targetY}
            stroke={theme.stroke.secondary}
            strokeWidth={1.5}
            markerEnd="url(#pipelineArrow)"
          />
        ))}
        {pipelineLayout.nodes.map(node => {
          const isView = node.id === 'view';
          const isPages = node.id === 'pages';
          const fill = isView ? theme.accent.primary : isPages ? theme.fill.secondary : theme.fill.tertiary;
          const textColor = isView ? theme.text.onAccent : theme.text.primary;
          const subColor = isView ? theme.text.onAccent : theme.text.tertiary;
          return (
            <g key={node.id}>
              <rect
                x={node.x}
                y={node.y}
                width={132}
                height={54}
                rx={5}
                fill={fill}
                stroke={theme.stroke.primary}
                strokeWidth={1}
              />
              <text
                x={node.x + 66}
                y={node.y + 20}
                textAnchor="middle"
                fill={textColor}
                fontSize={10}
                fontFamily="system-ui, sans-serif"
                fontWeight={600}
              >
                {pipelineLabels[node.id]}
              </text>
              <text
                x={node.x + 66}
                y={node.y + 36}
                textAnchor="middle"
                fill={subColor}
                fontSize={8.5}
                fontFamily="system-ui, sans-serif"
              >
                {pipelineSubLabels[node.id]}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

const pageRows = [
  [
    'Workspace',
    '/app/workspace/[category]',
    '/api/workspace/feed',
    'trend_opportunities_view -> pin_samples -> keyword_product_map -> pin_products',
    '机会卡片、证据图、商品信号、标题模板、monetize hint',
  ],
  [
    'Keyword Tool Search',
    '/api/keyword-tool/search',
    '同一路由',
    'trend_keywords + trend_opportunities_view',
    '关键词摘要、interest/trend/competition/save bands、Best Bet/Steady/Competitive',
  ],
  [
    'Keyword Tool Related',
    '/api/keyword-tool/related',
    '同一路由',
    'trend_keywords + trend_opportunities_view',
    '同类关键词列表、趋势状态、机会标签、数据来源说明',
  ],
  [
    'Pin Opportunity',
    '/api/opportunities, /api/keywords/top',
    '同一路由',
    'trend_opportunities_view',
    '关键词机会榜、score_tier、confidence、top_product_ids',
  ],
  [
    'Trends / Viral Pins',
    '/app/trends, /api/viral-pins',
    'Supabase / API',
    'pin_samples',
    'Pin 图片、save_count、source_keyword、velocity 相关证据',
  ],
  [
    'Products',
    '/app/products',
    '/api/products/top',
    'pin_products joined product_scores',
    '商品名、图、域名、source_url、opportunity_score、子分',
  ],
  [
    'Studio',
    '/app/studio',
    '/api/opportunities + Supabase',
    'opportunities, pin_samples, pin_products',
    '参考趋势、参考 Pin、商品候选，用于生成工作流',
  ],
  [
    'Discover',
    '/app/discover',
    'Supabase direct',
    'pin_samples + pin_products',
    '偏发现页的数据证据和商品预览，和机会体系共享底层表',
  ],
];

const scriptRows = [
  [
    'Full pipeline',
    'py pipeline.py',
    '全链路：趋势 -> Pin -> 商品 -> 分数',
    '需要 Supabase env，可选 proxy',
  ],
  [
    'Trend fetch',
    'py pipeline.py --step trends',
    '写 trend_keywords + crawl_queue',
    '可加 --interest home_decor, --top 30, --dry-run',
  ],
  [
    'Pin crawl',
    'py pipeline.py --step crawl',
    '消费 crawl_queue，写 pin_samples',
    '可加 --concurrency 3, --limit-keywords 20',
  ],
  [
    'Shop the Look',
    'py pipeline.py --step stl',
    '从高信号 Pin 提取商品，写 pin_products',
    '内部启动 shop_the_look.py --db',
  ],
  [
    'Product score',
    'py pipeline.py --step score',
    '写 product_scores + keyword_product_map',
    '可直接跑 py calculate_product_scores.py --verbose',
  ],
  [
    'Digital signals',
    'py pipeline.py --step digital',
    '数字商品旁路采集，写 pin_products + pin_samples',
    '可加 --digital-group planners templates',
  ],
  [
    'Trend history',
    'py pipeline.py --step enrich',
    '补 trend_history，用于 lifecycle',
    '依赖 Pinterest Trends time_series API',
  ],
];

const apiRows = [
  [
    'Pinterest Trends official',
    'trends.pinterest.com/api/v3/trends/keywords/suggested/',
    '趋势关键词、volume、YoY/WoW、time_series',
    'trend_fetcher.py Layer 1',
  ],
  [
    'Pinterest Trends category',
    'trends.pinterest.com/api/v3/trends/categories/top/',
    '分类下 top trend keywords',
    'trend_fetcher.py Layer 1',
  ],
  [
    'Pinterest time series',
    'trends.pinterest.com/api/v3/trends/keywords/time_series/',
    '52 周 0-100 normalized history',
    'trend_fetcher.py enrich',
  ],
  [
    'TrendingSearchResource',
    'www.pinterest.com/resource/TrendingSearchResource/get/',
    '内部趋势搜索资源',
    'trend_fetcher.py Layer 2',
  ],
  [
    'TrendKeywordsResource',
    'www.pinterest.com/resource/TrendKeywordsResource/get/',
    '内部关键词趋势资源',
    'trend_fetcher.py Layer 2 fallback',
  ],
  [
    'AdvancedTypeaheadResource',
    'www.pinterest.com/resource/AdvancedTypeaheadResource/get/',
    '关键词扩展、搜索联想',
    'trend_fetcher.py Layer 3, scraper_v2.py',
  ],
  [
    'BaseSearchResource',
    'www.pinterest.com/resource/BaseSearchResource/get/',
    'Pin 搜索结果和分页 bookmark',
    'trend_fetcher.py 估算, scraper_v2.py 抓 Pin',
  ],
  [
    'PinResource',
    'www.pinterest.com/resource/PinResource/get/',
    'Pin 详情、图片、save_count、outbound link',
    'scraper_v2.py',
  ],
  [
    'RelatedPinFeedResource',
    'www.pinterest.com/resource/RelatedPinFeedResource/get/',
    '高信号 Pin 的 related graph',
    'scraper_v2.py premium expansion',
  ],
];

export default function PinterestFlowPRDV5DataIntelligence() {
  return (
    <Stack gap={28} style={{ padding: 36, maxWidth: 1120, margin: '0 auto' }}>
      <Stack gap={8}>
        <Row gap={10} align="center">
          <H1>VibePin PRD v5.0</H1>
          <Pill tone="info" size="sm">Data Intelligence Refresh</Pill>
          <Pill tone="success" active size="sm">Code-Verified</Pill>
        </Row>
        <Text tone="secondary">
          本版 PRD 重新梳理当前 <Code>Workspace</Code>, <Code>Keyword Tool</Code>,
          <Code>Pin Opportunity</Code> 和 <Code>ProductSignals</Code> 的真实数据链路。
          参考旧版 v4.0 PRD，但以当前代码中的 Python pipeline、Supabase schema、
          Next.js API routes 和页面取数逻辑为准。
        </Text>
        <Callout tone="info" title="核心判断">
          <Text size="small">
            当前产品不是多个孤立页面，而是一套 Pinterest 数据情报系统。后台脚本把趋势、Pin、
            商品、数字商品信号统一落到 Supabase，再由 <Code>trend_opportunities_view</Code>
            和少量明细表支撑前端所有发现、选题、选品和生成入口。
          </Text>
        </Callout>
      </Stack>

      <Grid columns={4} gap={12}>
        <Stat value="7" label="核心数据阶段" />
        <Stat value="9" label="Pinterest API/Resource" />
        <Stat value="8" label="主要消费页面/API" />
        <Stat value="1" label="核心聚合视图" tone="success" />
      </Grid>

      <Divider />

      <Stack gap={12}>
        <H2>1. Product Positioning</H2>
        <Grid columns={2} gap={14}>
          <Card>
            <CardHeader>产品定位</CardHeader>
            <CardBody>
              <Stack gap={8}>
                <Text size="small">
                  VibePin 是 Pinterest-first 的增长情报与内容生成系统。它先发现高机会关键词和高保存 Pin，
                  再映射商品信号，最后把这些证据交给内容生成和发布流程。
                </Text>
                <Text size="small" tone="secondary">
                  一句话：用 Pinterest 原生趋势、Pin 保存行为和商品链接信号，帮用户决定发什么、怎么发、推什么商品。
                </Text>
              </Stack>
            </CardBody>
          </Card>
          <Card>
            <CardHeader>当前真实边界</CardHeader>
            <CardBody>
              <Stack gap={8}>
                <Text size="small">
                  数据采集和评分已形成后台管线；前端 Workspace、Keyword Tool、Products、Studio 等页面已经在消费这些表。
                </Text>
                <Text size="small" tone="secondary">
                  仍需重点补齐的是稳定调度、可观测性、失败重试、数据新鲜度 SLA，以及把 ProductSignals 的数字商品口径前端化。
                </Text>
              </Stack>
            </CardBody>
          </Card>
        </Grid>
      </Stack>

      <Divider />

      <Stack gap={12}>
        <H2>2. End-to-End Data Flow</H2>
        <PipelineDiagram />
        <Table
          headers={['阶段', '脚本/模块', '输入', '输出', '作用']}
          rows={[
            ['Interest Seeds', 'interest_discovery.py', 'Pinterest interest/category source or DB cache', 'trend_interests', '建立趋势抓取的类目入口'],
            ['Trend Keywords', 'trend_fetcher.py', 'trend_interests', 'trend_keywords, crawl_queue', '三层 Pinterest API fallback，筛选高增长/中高 volume 关键词'],
            ['Pin Evidence', 'scraper_v2.py', 'crawl_queue', 'pin_samples, keyword_expansions', '抓搜索结果、Pin 详情、related pins，过滤高保存和新鲜 Pin'],
            ['Physical Products', 'shop_the_look.py via pipeline.py', 'pin_samples', 'pin_products', '从高信号 Pin 提取商品卡片/外链商品'],
            ['Digital ProductSignals', 'digital_product_scraper.py', '固定数字商品关键词组 + Pinterest search', 'pin_products, pin_samples', '识别 TPT、Payhip、Gumroad、CreativeMarket、Etsy digital 等数字商品信号'],
            ['Scoring', 'calculate_product_scores.py', 'pin_products, pin_samples, trend_keywords', 'product_scores, keyword_product_map', '计算商品机会分，并建立关键词与商品映射'],
            ['Serving View', 'SQL migrations v12-v16', 'trend_keywords, pin_samples, keyword_product_map, product_scores', 'trend_opportunities_view', '前端主要聚合视图，输出机会 tier、confidence、saves、products、lifecycle'],
          ]}
          striped
        />
      </Stack>

      <Divider />

      <Stack gap={12}>
        <H2>3. Data Sources</H2>
        <Grid columns={3} gap={14}>
          <Card>
            <CardHeader>Pinterest Trends</CardHeader>
            <CardBody>
              <Text size="small">
                主要负责关键词、搜索热度、YoY/WoW 增长、52 周趋势历史。真实数据优先使用官方 Trends API，
                拿不到时回退到 Pinterest 内部 resource，再回退到 typeahead + search 估算。
              </Text>
            </CardBody>
          </Card>
          <Card>
            <CardHeader>Pinterest Pins</CardHeader>
            <CardBody>
              <Text size="small">
                主要负责保存数、Pin 图片、outbound link、创建时间、related graph。当前目标是高信号样本库，
                不是全量 Pinterest 归档。
              </Text>
            </CardBody>
          </Card>
          <Card>
            <CardHeader>Product Signals</CardHeader>
            <CardBody>
              <Text size="small">
                由 Shop the Look 物理商品链路和 digital product scraper 共同写入 <Code>pin_products</Code>。
                数字商品通过平台域名、URL token、标题 token 识别。
              </Text>
            </CardBody>
          </Card>
        </Grid>
      </Stack>

      <Divider />

      <Stack gap={12}>
        <H2>4. Evaluation System</H2>
        <H3>4.1 Trend Keyword Filter</H3>
        <Table
          headers={['维度', '当前口径', '代码位置']}
          rows={[
            ['search_volume_score', '必须 medium 或以上。真实 Trends 数据中 volume_score >= 2', 'backend/trend_fetcher.py'],
            ['YoY growth', '真实 Trends 数据默认 pct_growth_yoy >= 100%', 'backend/trend_fetcher.py'],
            ['WoW growth', '默认 pct_growth_wow >= 0%，即不能下跌', 'backend/trend_fetcher.py'],
            ['priority_score', 'yoy/10 + wow*2 + mom/10*1.5 + volume*5，部分 Pinterest-native 词加 bonus', 'backend/trend_fetcher.py'],
            ['fallback estimate', 'typeahead 估算源放宽阈值，依赖 volume_score 和 recent activity', 'backend/trend_fetcher.py'],
          ]}
          striped
        />

        <H3>4.2 Pin Evidence Filter</H3>
        <Table
          headers={['维度', '当前口径', '影响']}
          rows={[
            ['Candidate Pin', 'save_count >= 500', '进入 pin_samples 的基本门槛'],
            ['Freshness', 'age <= 90 days', '保证 trend recency，不做历史归档'],
            ['Viral Pin', 'save_count >= 5000', '触发 Shop the Look / premium expansion'],
            ['Premium Pin', 'save_count >= 10000', '最高信号 tier，用于置信度和扩图'],
            ['Save Velocity', 'save_count / days_since_creation', '用于 high growth、trend_stage 和后续商品打分'],
          ]}
          striped
        />

        <H3>4.3 Product Opportunity Score</H3>
        <Table
          headers={['子分', '权重', '算法口径']}
          rows={[
            ['save_velocity_score', '40%', 'log10 scale，1000 saves/day 映射为 100'],
            ['trend_score', '30%', 'log10 scale，500% YoY 映射为 100'],
            ['freshness_score', '20%', '90 天线性衰减，越新越高'],
            ['product_density_score', '10%', '每关键词产品数，10 个产品封顶为 100'],
            ['competition_score', '单独存储', '100 - product_density_score，不进入 opportunity_score 主公式'],
          ]}
          striped
        />

        <H3>4.4 Opportunity Tier and Confidence</H3>
        <Table
          headers={['字段', '含义', '当前口径']}
          rows={[
            ['opportunity_tier / score_tier = high', 'Blue Ocean', 'YoY >= 200 且 saves >= 5000 或 volume very_high，且 linked_pins_count <= 30'],
            ['opportunity_tier / score_tier = medium', 'Early Trend / Steady', 'YoY >= 100 且有需求证据且未过度饱和，或 high volume 且 weekly_change >= 0'],
            ['opportunity_tier / score_tier = low', 'Competitive / Watchlist', '不满足 high/medium 的关键词'],
            ['monetization_confidence', '商品覆盖置信度', 'linked_products_count >= 5 为 high，1-4 为 medium，0 为 low'],
            ['data_confidence', '整体证据置信度', '综合 products、pins、total_source_saves；direct pins 可在无商品时提供 medium 证据'],
          ]}
          striped
        />
      </Stack>

      <Divider />

      <Stack gap={12}>
        <H2>5. Page Data Contracts</H2>
        <Table
          headers={['页面/能力', '入口', 'API', '取数表/视图', '返回给页面的数据']}
          rows={pageRows}
          striped
        />
        <Callout tone="warning" title="页面取数关键点">
          <Text size="small">
            Workspace 和 Pin Opportunity 不是直接从原始表拼逻辑，而是优先读 <Code>trend_opportunities_view</Code>。
            Trends/Viral Pins 更偏原始 Pin 明细，Products 更偏 <Code>pin_products</Code> 与
            <Code>product_scores</Code> 的 join。Studio 则是消费这些情报，服务生成工作流。
          </Text>
        </Callout>
      </Stack>

      <Divider />

      <Stack gap={12}>
        <H2>6. API Surface</H2>
        <H3>6.1 Internal Web API</H3>
        <Table
          headers={['API', '主要消费者', '数据来源', '说明']}
          rows={[
            ['/api/workspace/feed', 'Workspace category page', 'trend_opportunities_view, pin_samples, keyword_product_map, pin_products', '分页返回机会卡片，过滤 score_tier != low'],
            ['/api/keyword-tool/search', 'Keyword Tool search, Trends page search', 'trend_keywords, trend_opportunities_view', '返回单关键词 summary 和定性 bands'],
            ['/api/keyword-tool/related', 'Keyword Tool related keywords', 'trend_keywords, trend_opportunities_view', '按 category 返回相关词和机会标签'],
            ['/api/opportunities', 'Opportunity drawer, Studio references', 'trend_opportunities_view', '支持 limit/category/min_score/min_products/confidence/offset'],
            ['/api/keywords/top', 'Keyword leaderboards', 'trend_opportunities_view', '类似 opportunities，但默认要求 min_products=1'],
            ['/api/products/top', 'Products page', 'pin_products + product_scores', '按 opportunity/saves/velocity 排序'],
            ['/api/viral-pins', 'Viral Pins/Trends', 'pin_samples', 'Pin 明细浏览入口'],
            ['/api/product/[id]/intelligence', 'Product detail intelligence', 'pin_products, pin_samples', '单商品相关 intelligence 明细'],
          ]}
          striped
        />

        <H3>6.2 Pinterest APIs and Resources</H3>
        <Table
          headers={['名称', 'Endpoint', '拿什么', '调用方']}
          rows={apiRows}
          striped
        />
        <Callout tone="info" title="Pinterest 请求上下文">
          <Text size="small">
            当前脚本用 <Code>curl_cffi</Code> impersonate Chrome，并先访问 Pinterest 首页 bootstrap cookie、
            csrftoken 和 appVersion。请求通常带 <Code>X-CSRFToken</Code>, <Code>X-App-Version</Code>,
            <Code>X-Pinterest-Source-Url</Code>, <Code>X-Pinterest-Pws-Handler</Code> 和 <Code>X-B3-*</Code> tracing headers。
          </Text>
        </Callout>
      </Stack>

      <Divider />

      <Stack gap={12}>
        <H2>7. Script Runbook</H2>
        <Table
          headers={['任务', '命令', '作用', '备注']}
          rows={scriptRows}
          striped
        />
        <Grid columns={2} gap={14}>
          <Card>
            <CardHeader>推荐日常刷新顺序</CardHeader>
            <CardBody>
              <Stack gap={6}>
                <Text size="small">1. <Code>py pipeline.py --step trends</Code> 刷新趋势词和队列</Text>
                <Text size="small">2. <Code>py pipeline.py --step crawl --concurrency 2</Code> 抓 Pin 证据</Text>
                <Text size="small">3. <Code>py pipeline.py --step stl</Code> 提取商品信号</Text>
                <Text size="small">4. <Code>py pipeline.py --step score</Code> 计算商品分和关键词商品映射</Text>
                <Text size="small">5. <Code>py pipeline.py --step digital</Code> 补数字商品信号</Text>
              </Stack>
            </CardBody>
          </Card>
          <Card>
            <CardHeader>最小验证命令</CardHeader>
            <CardBody>
              <Stack gap={6}>
                <Text size="small"><Code>py trend_fetcher.py --interest home_decor --top 10 --db</Code></Text>
                <Text size="small"><Code>py scraper_v2.py --test</Code></Text>
                <Text size="small"><Code>py calculate_product_scores.py --dry-run --verbose</Code></Text>
                <Text size="small"><Code>py digital_product_scraper.py --dry-run --group planners</Code></Text>
              </Stack>
            </CardBody>
          </Card>
        </Grid>
      </Stack>

      <Divider />

      <Stack gap={12}>
        <H2>8. Data Model</H2>
        <Table
          headers={['表/视图', '角色', '关键字段']}
          rows={[
            ['trend_interests', '趋势兴趣入口', 'interest_slug, interest_name, country, is_active, last_fetched_at'],
            ['trend_keywords', '关键词事实表', 'keyword, category, yearly_change, weekly_change, search_volume_level, priority_score, trend_history, trend_lifecycle'],
            ['crawl_queue', 'Pin 抓取队列', 'keyword, source_interest, category, priority_score, status, attempts, last_error'],
            ['keyword_expansions', 'Pinterest typeahead 扩词记录', 'seed_keyword, expanded_keyword, source_interest'],
            ['pin_samples', 'Pin 证据样本', 'pin_id, trend_keyword_id, image_url, save_count, save_velocity, age_days, trend_stage, outbound_link'],
            ['pin_products', '商品信号', 'parent_pin_id, product_name, source_url, domain, merchant, image_url, save_count, product_url_hash'],
            ['product_scores', '商品评分', 'product_id, opportunity_score, trend_score, save_velocity_score, freshness_score, competition_score'],
            ['keyword_product_map', '关键词商品关系', 'keyword_id, product_id, relevance_score, total_pins, total_saves'],
            ['trend_opportunities_view', '前端主聚合视图', 'keyword_id, keyword, score_tier, data_confidence, linked_pins_count, linked_products_count, total_source_saves'],
          ]}
          striped
        />
      </Stack>

      <Divider />

      <Stack gap={12}>
        <H2>9. ProductSignals Detail</H2>
        <Grid columns={2} gap={14}>
          <Card>
            <CardHeader>Physical Product Signals</CardHeader>
            <CardBody>
              <Text size="small">
                由 Shop the Look 链路从 viral physical-product pins 提取。适合 Etsy、Amazon、Shopify、Wayfair、
                Target、Walmart 等实物商品场景。当前通过 <Code>pin_products</Code> 与 score engine 进入 Products 和 Workspace。
              </Text>
            </CardBody>
          </Card>
          <Card>
            <CardHeader>Digital Product Signals</CardHeader>
            <CardBody>
              <Text size="small">
                由 <Code>digital_product_scraper.py</Code> 直接搜索 planners、templates、worksheets、trackers、
                wall art、kids education、business、crafts/svg 等关键词组。识别条件包括数字商品平台域名、
                Etsy URL token 和标题中的 printable/template/pdf/svg/download 等 intent token。
              </Text>
            </CardBody>
          </Card>
        </Grid>
        <Table
          headers={['维度', '当前口径']}
          rows={[
            ['数字商品关键词组', 'planners, templates, worksheets, trackers, wall_art, kids_education, business, crafts_svg'],
            ['强平台信号', 'teacherspayteachers.com, tpt.com, payhip.com, gumroad.com, creativemarket.com, creativefabrica.com 等'],
            ['Etsy 判断', 'Etsy 需要 URL token 或 title token 证明是 digital listing'],
            ['标题 token', 'printable, template, worksheet, planner, tracker, notion, canva, pdf, svg, instant download 等'],
            ['最低 saves', 'MIN_DIGITAL_SAVES = 20，低于 physical pin 的 500 门槛'],
            ['写入', 'pin_products 为主，同时补 pin_samples 以便 Viral Pins/Trends 可展示 digital content'],
          ]}
          striped
        />
      </Stack>

      <Divider />

      <Stack gap={12}>
        <H2>10. Current Gaps and PRD Requirements</H2>
        <Table
          headers={['问题', '影响', '建议要求']}
          rows={[
            ['调度仍偏手动', '数据新鲜度依赖人跑脚本', '接入 cron/Railway scheduler，按 step 分频调度，记录 run logs'],
            ['ProductSignals 前端表达不足', '数字商品信号已采集但产品化不明显', '在 Products/Workspace 增加 digital badge、platform、intent reason、group filter'],
            ['API 健康不可见', 'Pinterest resource 变更时难定位', '为每个 pipeline step 记录成功率、HTTP 状态、空结果率、写入数'],
            ['score_tier 语义混合历史包袱', '前端仍读 score_tier，但实际是 opportunity_tier alias', '新代码优先使用 opportunity_tier，保留 score_tier 兼容'],
            ['关键词生命周期依赖 enrich/classify', '未补 trend_history 时 lifecycle 可能为空或 unclear', '把 enrich + classify 纳入标准 pipeline，并在 UI 显示数据时间'],
            ['Shop the Look 依赖高保存 Pin', '低保存但高转化商品可能漏掉', '补充 outbound product extraction 和 merchant domain signals'],
            ['反爬风险', 'Pinterest API/resource 不稳定', '实现 proxy、backoff、失败重试、resource shape 监测'],
          ]}
          striped
        />
      </Stack>

      <Divider />

      <Stack gap={12}>
        <H2>11. Proposed v5 Roadmap</H2>
        <Grid columns={3} gap={14}>
          <Card>
            <CardHeader>P0 - Stabilize Data Factory</CardHeader>
            <CardBody>
              <Stack gap={6}>
                <Text size="small">定时运行 pipeline steps，并持久化 run history。</Text>
                <Text size="small">建立 Supabase 表级数据新鲜度监控。</Text>
                <Text size="small">为 Pinterest API 空返回、403、shape 变化加告警。</Text>
                <Text size="small">把 enrich/classify 纳入标准趋势刷新流程。</Text>
              </Stack>
            </CardBody>
          </Card>
          <Card>
            <CardHeader>P1 - Productize Signals</CardHeader>
            <CardBody>
              <Stack gap={6}>
                <Text size="small">Workspace 卡片显示 evidence reason，而不只显示分数。</Text>
                <Text size="small">Products 增加 physical/digital/source platform filters。</Text>
                <Text size="small">Keyword Tool 明确展示数据来源和 last_fetched_at。</Text>
                <Text size="small">Pin Opportunity 把 monetization_confidence 与 opportunity_tier 分开呈现。</Text>
              </Stack>
            </CardBody>
          </Card>
          <Card>
            <CardHeader>P2 - Close Growth Loop</CardHeader>
            <CardBody>
              <Stack gap={6}>
                <Text size="small">Studio 自动带入关键词、参考 Pin、商品信号生成 brief。</Text>
                <Text size="small">发布后回写表现数据，形成 post-performance feedback。</Text>
                <Text size="small">按 workspace category 生成 weekly plan。</Text>
                <Text size="small">将高机会词转为可执行内容日历。</Text>
              </Stack>
            </CardBody>
          </Card>
        </Grid>
      </Stack>

      <Divider />

      <Stack gap={10}>
        <H2>12. Source Evidence</H2>
        <Table
          headers={['证据类型', '文件']}
          rows={[
            ['旧版 PRD 参考', 'docs/canvases/pinterest-flow-prd-v4.0-growth-os.canvas.tsx'],
            ['Pipeline orchestrator', 'backend/pipeline.py'],
            ['Trend fetching and Pinterest APIs', 'backend/trend_fetcher.py'],
            ['Pin scraping and filters', 'backend/scraper_v2.py'],
            ['Digital ProductSignals', 'backend/digital_product_scraper.py'],
            ['Product scoring formula', 'backend/calculate_product_scores.py'],
            ['Opportunity view SQL', 'backend/db/migrate_v12.sql, migrate_v15.sql, migrate_v16.sql'],
            ['Workspace feed API', 'web/src/app/api/workspace/feed/route.ts'],
            ['Keyword Tool APIs', 'web/src/app/api/keyword-tool/search/route.ts, related/route.ts'],
            ['Top opportunities/products APIs', 'web/src/app/api/opportunities/route.ts, keywords/top/route.ts, products/top/route.ts'],
          ]}
          striped
        />
        <Text tone="quaternary" size="small">
          VibePin PRD v5.0 - Data Intelligence Operating Model - generated from current repository state on 2026-06-02.
        </Text>
      </Stack>
    </Stack>
  );
}
