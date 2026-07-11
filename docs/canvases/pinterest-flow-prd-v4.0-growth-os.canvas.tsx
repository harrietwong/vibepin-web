import {
  Stack, H1, H2, H3, Text, Grid, Row, Stat, Divider,
  Card, CardHeader, CardBody, Table, Callout, Pill, Code,
  useHostTheme, computeDAGLayout,
} from 'cursor/canvas';

/**
 * VibePin PRD v4.0 — Pinterest Growth OS
 * 基于 v3.0 (Creator / Scheduler) 演进而来，反映当前实际代码状态。
 * 产品已从「Pin 生成器 + 排期」升级为「Pinterest 增长智能平台」。
 * 历史版本：pinterest-flow-prd-v3.0-creator-scheduler.canvas.tsx
 */

/* ── Data Pipeline Flow Diagram ── */
const pipelineNodes = [
  { id: 'interest' }, { id: 'trends' }, { id: 'pins' },
  { id: 'products' }, { id: 'scoring' },
];
const pipelineEdges = [
  { from: 'interest', to: 'trends' },
  { from: 'trends', to: 'pins' },
  { from: 'pins', to: 'products' },
  { from: 'products', to: 'scoring' },
];
const pipelineLabels: Record<string, string> = {
  interest: 'Interest Discovery',
  trends: 'Trend Fetcher',
  pins: 'Pin Scraper',
  products: 'Shop the Look',
  scoring: 'Score Engine',
};
const pipelineSubLabels: Record<string, string> = {
  interest: 'trend_interests table',
  trends: 'trend_keywords + crawl_queue',
  pins: 'pin_samples table',
  products: 'pin_products table',
  scoring: 'product_scores + view',
};

const pipelineLayout = computeDAGLayout({
  nodes: pipelineNodes,
  edges: pipelineEdges,
  direction: 'horizontal',
  nodeWidth: 136,
  nodeHeight: 48,
  rankGap: 24,
  nodeGap: 18,
  padding: 16,
});

function DataPipelineDiagram() {
  const theme = useHostTheme();
  return (
    <div style={{ overflowX: 'auto' }}>
      <svg width={pipelineLayout.width} height={pipelineLayout.height + 8} style={{ display: 'block' }}>
        <defs>
          <marker id="arrPipeline" markerWidth="7" markerHeight="7" refX="5" refY="3.5" orient="auto">
            <path d="M0,0 L0,7 L7,3.5 z" fill={theme.stroke.secondary} />
          </marker>
        </defs>
        {pipelineLayout.edges.map((e, i) => (
          <line
            key={i}
            x1={e.sourceX} y1={e.sourceY}
            x2={e.targetX - 7} y2={e.targetY}
            stroke={theme.stroke.secondary}
            strokeWidth={1.5}
            markerEnd="url(#arrPipeline)"
          />
        ))}
        {pipelineLayout.nodes.map(node => {
          const isScoring = node.id === 'scoring';
          const fill = isScoring ? theme.accent.primary : theme.fill.tertiary;
          return (
            <g key={node.id}>
              <rect
                x={node.x} y={node.y}
                width={136} height={48}
                rx={5}
                fill={fill}
                stroke={theme.stroke.primary}
                strokeWidth={1}
              />
              <text
                x={node.x + 68} y={node.y + 18}
                textAnchor="middle"
                fill={isScoring ? theme.text.onAccent : theme.text.primary}
                fontSize={10} fontFamily="system-ui, sans-serif" fontWeight="500"
              >
                {pipelineLabels[node.id]}
              </text>
              <text
                x={node.x + 68} y={node.y + 33}
                textAnchor="middle"
                fill={isScoring ? theme.text.onAccent : theme.text.tertiary}
                fontSize={8.5} fontFamily="system-ui, sans-serif"
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

/* ── User Journey Flow Diagram ── */
const journeyNodes = [
  { id: 'discover' }, { id: 'viral' }, { id: 'product' },
  { id: 'studio' }, { id: 'publish' },
];
const journeyEdges = [
  { from: 'discover', to: 'viral' },
  { from: 'viral', to: 'product' },
  { from: 'product', to: 'studio' },
  { from: 'studio', to: 'publish' },
];
const journeyLabels: Record<string, string> = {
  discover: '发现趋势',
  viral: '分析爆款 Pin',
  product: '选品情报',
  studio: '生成内容',
  publish: '发布排期',
};
const journeySubLabels: Record<string, string> = {
  discover: '/discover · 机会评分',
  viral: '/trends · 高收藏 Pin',
  product: '/products · 商品评分',
  studio: '/studio · AI 生成',
  publish: 'OAuth · Queue · 排期',
};
const journeyStatus: Record<string, 'built' | 'partial' | 'planned'> = {
  discover: 'built',
  viral: 'built',
  product: 'built',
  studio: 'built',
  publish: 'planned',
};

const journeyLayout = computeDAGLayout({
  nodes: journeyNodes,
  edges: journeyEdges,
  direction: 'horizontal',
  nodeWidth: 128,
  nodeHeight: 48,
  rankGap: 24,
  nodeGap: 18,
  padding: 16,
});

function UserJourneyDiagram() {
  const theme = useHostTheme();
  return (
    <div style={{ overflowX: 'auto' }}>
      <svg width={journeyLayout.width} height={journeyLayout.height + 8} style={{ display: 'block' }}>
        <defs>
          <marker id="arrJourney" markerWidth="7" markerHeight="7" refX="5" refY="3.5" orient="auto">
            <path d="M0,0 L0,7 L7,3.5 z" fill={theme.stroke.secondary} />
          </marker>
        </defs>
        {journeyLayout.edges.map((e, i) => (
          <line
            key={i}
            x1={e.sourceX} y1={e.sourceY}
            x2={e.targetX - 7} y2={e.targetY}
            stroke={theme.stroke.secondary}
            strokeWidth={1.5}
            markerEnd="url(#arrJourney)"
          />
        ))}
        {journeyLayout.nodes.map(node => {
          const status = journeyStatus[node.id];
          const isPublish = node.id === 'publish';
          const fill = isPublish
            ? theme.fill.secondary
            : status === 'built'
              ? theme.accent.primary
              : theme.fill.tertiary;
          return (
            <g key={node.id}>
              <rect
                x={node.x} y={node.y}
                width={128} height={48}
                rx={5}
                fill={fill}
                stroke={isPublish ? theme.stroke.secondary : theme.stroke.primary}
                strokeWidth={isPublish ? 1.5 : 1}
                strokeDasharray={isPublish ? '4 3' : undefined}
              />
              <text
                x={node.x + 64} y={node.y + 18}
                textAnchor="middle"
                fill={status === 'built' ? theme.text.onAccent : theme.text.primary}
                fontSize={10} fontFamily="system-ui, sans-serif" fontWeight="500"
              >
                {journeyLabels[node.id]}
              </text>
              <text
                x={node.x + 64} y={node.y + 33}
                textAnchor="middle"
                fill={status === 'built' ? theme.text.onAccent : theme.text.tertiary}
                fontSize={8.5} fontFamily="system-ui, sans-serif"
              >
                {journeySubLabels[node.id]}
              </text>
            </g>
          );
        })}
      </svg>
      <Text size="small" tone="tertiary" style={{ marginTop: 8 }}>
        实心蓝 = 已上线 · 虚线 = 待完成
      </Text>
    </div>
  );
}

/* ── Main Export ── */
export default function PinterestGrowthOSPRDV40() {
  return (
    <Stack gap={28} style={{ padding: 36, maxWidth: 1020, margin: '0 auto' }}>

      {/* ── Header ── */}
      <Stack gap={8}>
        <Row gap={10} align="center">
          <H1>VibePin — PRD v4.0</H1>
          <Pill tone="success" active size="sm">Pinterest Growth OS</Pill>
          <Pill tone="info" size="sm">基于实际代码重写</Pill>
        </Row>
        <Text tone="secondary">
          <strong>Pinterest Growth OS — 从趋势发现到批量发布的全链路增长工具。</strong>
          面向 Pinterest Affiliate Marketers、Etsy/Shopify 卖家、内容创作者与小型团队。
          自动完成：趋势发现 → 爆款 Pin 分析 → 商品情报 → AI 内容生成 → 批量排期发布。
        </Text>
        <Callout tone="info" title="v4.0 与 v3.0 的关键差异">
          <Text size="small">
            v3.0 将「商品输入 → 生成 Pin → 发布」作为主线，定位为 Pin Generator + Scheduler。
            <strong> v4.0 反映当前实际代码状态</strong>：产品已演进为「数据智能驱动的增长平台」，
            核心竞争力在于自主抓取 Pinterest 趋势与商品情报，内容生成与发布是最终输出环节，而非唯一主线。
          </Text>
        </Callout>
      </Stack>

      <Divider />

      {/* 1. Product Positioning */}
      <Stack gap={10}>
        <H2>1. Product Positioning</H2>
        <Table
          headers={['维度', 'v4.0 定位']}
          rows={[
            ['产品名', 'VibePin · Pinterest Growth OS'],
            ['一句英文', 'Discover trending niches, find viral products, generate & schedule Pinterest pins — all automated.'],
            ['一句中文', '自动发现 Pinterest 趋势 → 挖掘爆款商品 → AI 生成 Pin → 批量排期发布'],
            ['核心差异化', '有自己的 Pinterest 趋势 & 商品情报数据库（自主抓取），不依赖用户自带 insight'],
            ['变现服务对象', 'Affiliate Marketer · Etsy/Shopify Seller · POD Seller · Pinterest Agency · Content Creator'],
            ['技术路线', 'Next.js 前端 + Python 数据管线 + Supabase + RunPod Flux.1 + GPT-4o'],
          ]}
          striped
        />
      </Stack>

      <Divider />

      {/* 2. Current Feature Inventory */}
      <Stack gap={12}>
        <H2>2. 已上线功能清单（截至 v4.0）</H2>
        <Callout tone="success" title="已构建并上线">
          <Text size="small">以下功能均有对应代码实现，可在 Web 端使用。</Text>
        </Callout>
        <Table
          headers={['模块', '路径', '核心能力', '状态']}
          rows={[
            ['趋势发现', '/app/discover', '浏览趋势关键词，按机会评分排序；支持 niche 筛选、类目过滤；显示 blue_ocean / hot_red_sea / early_trend / avoid 评级', '✅ 上线'],
            ['爆款 Pin 分析', '/app/trends', '展示高收藏 Pin 画廊（≥500 saves）；按关键词 / 时间 / 类目过滤；Save Velocity 展示', '✅ 上线'],
            ['商品情报', '/app/products', '来自 Shop the Look 的商品列表；综合打分（opportunity + trend + save_velocity + freshness）；域名 / 价格 / 相关关键词', '✅ 上线'],
            ['内容工作室', '/app/studio', 'URL 粘贴或图片上传 → AI 分析商品 → 生成 Pin 图（Flux.1）+ Title / Desc / Link / Board 建议', '✅ 上线'],
            ['任务面板', '/app/dashboard', '生成任务队列；任务状态（pending/processing/done/failed）；历史记录', '✅ 上线'],
            ['平台设置', '/settings', 'Pinterest / Instagram OAuth 接入入口；账号连接状态；用户偏好', '✅ 框架上线'],
            ['认证系统', '/login, /signup', 'Supabase Auth；邮箱注册 + OAuth 回调', '✅ 上线'],
            ['Landing Page', '/', 'Hero · 功能展示 · CTA；多类目案例', '✅ 上线'],
          ]}
          striped
        />
      </Stack>

      <Divider />

      {/* 3. Data Intelligence Pipeline */}
      <Stack gap={12}>
        <H2>3. 数据情报管线（后台自动运行）</H2>
        <Text tone="secondary" size="small">
          这是 VibePin 与竞品的核心差异：有一套<strong>全自动的 Pinterest 数据抓取与评分管线</strong>，
          为前端的 Discover / Trends / Products 三个模块持续供给新鲜数据。
        </Text>
        <DataPipelineDiagram />
        <Table
          headers={['步骤', '脚本', '输入', '输出表', '说明']}
          rows={[
            ['1. Interest Discovery', 'interest_discovery.py', 'Pinterest Trends 官方兴趣类目', 'trend_interests', '抓取 Pinterest 兴趣分类（如 home_decor、fashion）'],
            ['2. Trend Fetcher', 'trend_fetcher.py', 'trend_interests', 'trend_keywords + crawl_queue', '3 层 API fallback；过滤条件：搜索量 ≥ medium，YoY 增长 ≥ 100%，周涨幅 ≥ 0%'],
            ['3. Pin Scraper', 'scraper_v2.py', 'crawl_queue', 'pin_samples', 'Playwright 抓取高收藏 Pin（≥500 saves，90天内）；带 Cookie 鉴权'],
            ['4. Shop the Look', 'shop_the_look.py', 'pin_samples', 'pin_products', '提取 Pin 上的商品卡片；规范化 URL；过滤低质量商品'],
            ['5. Score Engine', 'calculate_product_scores.py', 'pin_products + trend_keywords', 'product_scores + keyword_product_map', '多维打分：opportunity / trend / save_velocity / freshness；写入 trend_opportunities_view'],
            ['6. Orchestrator', 'pipeline.py', '全链路', '全链路', '5 步骤统一调度；支持单步执行与并发控制'],
          ]}
          striped
        />
        <Callout tone="warning" title="运营注意">
          <Text size="small">
            管线当前为手动触发（命令行），生产环境需配置定时调度（cron 或 Railway scheduler）以保持数据新鲜度。
            Chrome Cookie 持久化存储在 /backend/pinterest_profile/，需定期维护会话有效性。
          </Text>
        </Callout>
      </Stack>

      <Divider />

      {/* 4. Database Schema */}
      <Stack gap={12}>
        <H2>4. 核心数据库结构（Supabase PostgreSQL）</H2>
        <Table
          headers={['表名', '用途', '主要字段']}
          rows={[
            ['trend_keywords', '已发现的趋势关键词', 'keyword, search_volume, yoy_growth, weekly_change, category, crawl_status'],
            ['pin_samples', '每个关键词的 Pin 样本', 'keyword_id, pin_url, save_count, image_url, outbound_url, scraped_at'],
            ['pin_products', 'Shop the Look 商品', 'pin_id, product_url, domain, title, price, save_count, category'],
            ['product_scores', '商品综合评分', 'product_id, opportunity_score, trend_score, save_velocity_score, freshness_score'],
            ['keyword_product_map', '关键词 ↔ 商品 M2M', 'keyword_id, product_id, confidence'],
            ['generated_assets', '用户生成的 Pin', 'user_id, task_id, image_url, title, description, pin_link, board_id, status'],
            ['publish_jobs', '发布历史', 'user_id, asset_id, platform, pinterest_pin_url, scheduled_at, published_at, status'],
            ['trend_opportunities_view', '聚合视图（v12）', 'keyword, linked_products, linked_pins, total_saves, opportunity_score, confidence_tier'],
          ]}
          striped
        />
      </Stack>

      <Divider />

      {/* 5. User Journey */}
      <Stack gap={12}>
        <H2>5. 用户增长路径（Discovery-First）</H2>
        <Text tone="secondary" size="small">
          v4.0 的核心叙事是<strong>发现驱动</strong>：用户先看到数据和机会，再生成内容，最后发布。
          这与 v3.0 的「输入商品 → 生成」路径不同，前者依赖平台情报数据优势。
        </Text>
        <UserJourneyDiagram />
        <Table
          headers={['步骤', '用户行为', '平台提供', '页面']}
          rows={[
            ['1. 发现趋势', '浏览高机会关键词，了解 Pinterest 当前热点', '关键词评分（blue_ocean / early_trend / hot_red_sea）、竞争度、相关 Pin 数量', '/discover'],
            ['2. 分析爆款', '查看目标关键词下的高收藏 Pin，理解视觉风格', 'Pin 画廊 + Save Velocity + 外链来源', '/trends'],
            ['3. 选品情报', '找到正在 Pinterest 上被收藏传播的可变现商品', '商品综合评分、价格区间、来源域名、相关关键词', '/products'],
            ['4. 生成内容', '粘贴商品链接或上传图片，AI 生成多套 Pin', 'AI 品类分析 + Pin 方向推荐 + Flux.1 图像生成 + GPT-4o 文案', '/studio'],
            ['5. 发布排期', '批量预览选择，连接 Pinterest 账号，排期发布', 'OAuth + 批量发布 + 队列管理 + 失败重试（待完成）', '/dashboard + settings'],
          ]}
          striped
        />
      </Stack>

      <Divider />

      {/* 6. Content Studio — Detail */}
      <Stack gap={12}>
        <H2>6. 内容工作室（Studio）详细规格</H2>
        <Text tone="secondary" size="small">
          Studio 是从「情报」到「内容」的转化节点，也是用户的主要操作界面。
        </Text>
        <Grid columns={2} gap={14}>
          <Card>
            <CardHeader>输入方式</CardHeader>
            <CardBody>
              <Stack gap={6}>
                <Text size="small">· 商品 URL 粘贴（自动抓取 OG 数据、标题、图片）</Text>
                <Text size="small">· 图片直接上传（支持多图）</Text>
                <Text size="small">· 参考 Pin 上传（Reference Mode）</Text>
              </Stack>
            </CardBody>
          </Card>
          <Card>
            <CardHeader>AI 分析输出</CardHeader>
            <CardBody>
              <Stack gap={6}>
                <Text size="small">· 品类 + 目标人群识别</Text>
                <Text size="small">· 视觉风格分析</Text>
                <Text size="small">· 推荐 3–5 个 Pin 创意方向（Pin Type Library）</Text>
              </Stack>
            </CardBody>
          </Card>
          <Card>
            <CardHeader>Pin 图生成</CardHeader>
            <CardBody>
              <Stack gap={6}>
                <Text size="small">· 图像模型：Flux.1 Schnell via RunPod Serverless</Text>
                <Text size="small">· 输出比例：2:3（Pinterest-first）</Text>
                <Text size="small">· 批量生成，任务队列管理</Text>
                <Text size="small">· 生成失败自动重试</Text>
              </Stack>
            </CardBody>
          </Card>
          <Card>
            <CardHeader>文案生成</CardHeader>
            <CardBody>
              <Stack gap={6}>
                <Text size="small">· 模型：GPT-4o</Text>
                <Text size="small">· 输出：Title + Description + 目标链接 + Board 建议</Text>
                <Text size="small">· 关键词植入（来自 Discover 模块的趋势词）</Text>
              </Stack>
            </CardBody>
          </Card>
        </Grid>

        <H3>Pin Creative Type Library（当前支持）</H3>
        <Table
          headers={['Pin Type', '适用场景']}
          rows={[
            ['Lifestyle Scene', '使用场景与生活方式语境（家居、时尚、美妆）'],
            ['Product Collage', '多单品或多角度拼贴（合集类内容）'],
            ['Moodboard', '情绪板、质感与配色导向'],
            ['Gift Guide', '礼赠、节日与赠礼心智'],
            ['How to Style', '搭配、教程感、步骤暗示'],
            ['Seasonal Campaign', '季节 / 节日主题'],
            ['Problem / Solution', '痛点—解决结构'],
            ['Product Spotlight', '单 SKU 强焦点'],
            ['Collection / Roundup', '合集、清单、主题聚合'],
          ]}
          striped
        />
      </Stack>

      <Divider />

      {/* 7. Opportunity Scoring System */}
      <Stack gap={12}>
        <H2>7. 机会评分体系</H2>
        <Text tone="secondary" size="small">
          前端 <Code>/lib/scoring.ts</Code> 实现，消费 <Code>trend_opportunities_view</Code> 数据。
        </Text>
        <Table
          headers={['评级', 'Tier 名', '含义', '建议行动']}
          rows={[
            ['🔵', 'blue_ocean', '高搜索量 + 低竞争 + 上升趋势', '优先布局，快速发 Pin 占坑'],
            ['🔴', 'hot_red_sea', '高搜索量 + 高竞争', '差异化切入，走 Reference Mode 出风格 Pin'],
            ['🟡', 'early_trend', '上升趋势明显但体量尚小', '提前布局，等待爆发'],
            ['⚫', 'avoid', '下降或无明显信号', '暂时跳过'],
          ]}
          striped
        />
        <H3>评分维度（product_scores 表）</H3>
        <Table
          headers={['维度', '计算依据', '权重方向']}
          rows={[
            ['opportunity_score', '综合得分（主排序字段）', 'High'],
            ['trend_score', '关键词 YoY 增长率 + 周涨幅', 'High'],
            ['save_velocity_score', '单位时间内新增 Save 速率', 'Medium'],
            ['freshness_score', '数据采集时间新鲜度', 'Low'],
          ]}
          striped
        />
      </Stack>

      <Divider />

      {/* 8. What's Missing — P0 Next */}
      <Stack gap={12}>
        <H2>8. 待完成核心能力（下一阶段 P0）</H2>
        <Callout tone="error" title="当前最大缺口">
          <Text size="small">
            发布闭环尚未完整：Pinterest OAuth 框架已有但未经完整测试，
            批量发布 / 排期队列 / 失败重试逻辑仍需完善。
            数据管线为手动触发，生产环境缺少定时调度。
          </Text>
        </Callout>
        <Table
          headers={['能力', '当前状态', '优先级', '说明']}
          rows={[
            ['Pinterest OAuth 完整流程', '框架存在（/api/routes/auth.py）', 'P0', '需端到端验证：授权 → token 存储 → 刷新 → 发布 → 吊销'],
            ['批量发布到 Pinterest', '未实现', 'P0', 'Board 选择 + 多 Pin 提交 + 部分失败不阻塞'],
            ['发布排期（Schedule）', '未实现', 'P0', '时间槽 + 时区 + 每日上限 + 队列顺延'],
            ['Queue 状态可见', '任务面板基础版', 'P0', '等待中/发送中/已发/失败/已排期 五态'],
            ['已发 Pin URL 写回', '未实现', 'P0','发布成功后 Pinterest URL 落库，便于复盘'],
            ['数据管线定时调度', '手动命令行', 'P0', '接入 Railway scheduler 或 cron；保证数据新鲜度'],
            ['失败重试 + 原因展示', '未实现', 'P1', '单条 / 批量重试；失败原因用户可读'],
            ['Pinterest Token 过期引导', '未实现', 'P1', 'OAuth 重连 + 队列暂停提示'],
          ]}
          striped
        />
      </Stack>

      <Divider />

      {/* 9. Tech Stack */}
      <Stack gap={12}>
        <H2>9. 技术栈（当前实际）</H2>
        <Grid columns={2} gap={14}>
          <Card>
            <CardHeader>前端 · Web</CardHeader>
            <CardBody>
              <Stack gap={5}>
                <Text size="small">· Next.js 16.2 + React 19 + TypeScript 5</Text>
                <Text size="small">· Tailwind CSS 4</Text>
                <Text size="small">· Supabase SSR + Auth（@supabase/ssr ^0.10）</Text>
                <Text size="small">· SWR 2.4（数据获取）</Text>
                <Text size="small">· Lucide React（图标）</Text>
                <Text size="small">· Sonner（Toast 通知）</Text>
                <Text size="small">· 部署：Vercel</Text>
              </Stack>
            </CardBody>
          </Card>
          <Card>
            <CardHeader>数据管线 · Backend</CardHeader>
            <CardBody>
              <Stack gap={5}>
                <Text size="small">· Python 3.12</Text>
                <Text size="small">· Playwright（Pinterest 抓取，Cookie 鉴权）</Text>
                <Text size="small">· curl_cffi（反 Bot 绕过）</Text>
                <Text size="small">· BeautifulSoup4（HTML 解析）</Text>
                <Text size="small">· 自研轻量 Supabase HTTP 封装（/db/db.py）</Text>
                <Text size="small">· 部署：命令行 / 待接入 Railway</Text>
              </Stack>
            </CardBody>
          </Card>
          <Card>
            <CardHeader>AI 服务</CardHeader>
            <CardBody>
              <Stack gap={5}>
                <Text size="small">· 图像生成：Flux.1 Schnell via RunPod Serverless</Text>
                <Text size="small">· 文案生成：OpenAI GPT-4o</Text>
                <Text size="small">· 图像分割：SAM 2 via Replicate（MVP 阶段待启用）</Text>
              </Stack>
            </CardBody>
          </Card>
          <Card>
            <CardHeader>基础设施</CardHeader>
            <CardBody>
              <Stack gap={5}>
                <Text size="small">· 数据库：Supabase PostgreSQL（v12 schema，12 次迁移）</Text>
                <Text size="small">· 存储：Supabase Storage + CDN</Text>
                <Text size="small">· 后端 API：FastAPI（legacy，最小化）+ ARQ 任务队列</Text>
                <Text size="small">· 监控：Sentry + PostHog</Text>
                <Text size="small">· 后端部署：Railway</Text>
              </Stack>
            </CardBody>
          </Card>
        </Grid>
      </Stack>

      <Divider />

      {/* 10. Full Roadmap */}
      <Stack gap={14}>
        <H2>10. P0 / P1 / P2 Roadmap</H2>
        <Grid columns={3} gap={14}>
          <Card>
            <CardHeader trailing={<Pill tone="success" size="sm">P0 · 待完成</Pill>}>
              发布闭环 + 管线自动化
            </CardHeader>
            <CardBody>
              <Stack gap={5}>
                <Text size="small">· Pinterest OAuth 端到端验证</Text>
                <Text size="small">· 批量发布（Board 选择 + 多 Pin）</Text>
                <Text size="small">· 发布排期（时间槽 + 每日上限）</Text>
                <Text size="small">· Queue 五态可见</Text>
                <Text size="small">· 已发 Pin URL 写回</Text>
                <Text size="small">· 数据管线定时调度（Railway scheduler）</Text>
                <Text size="small">· Token 过期 OAuth 重连引导</Text>
              </Stack>
            </CardBody>
          </Card>
          <Card>
            <CardHeader trailing={<Pill tone="warning" size="sm">P1 · 增强</Pill>}>
              功能深度
            </CardHeader>
            <CardBody>
              <Stack gap={5}>
                <Text size="small">· Reference Mode（上传参考 Pin 复刻风格）</Text>
                <Text size="small">· Custom Prompt Mode（高级入口）</Text>
                <Text size="small">· 失败重试 + 失败原因展示</Text>
                <Text size="small">· Analytics Dashboard（已发 Pin 表现）</Text>
                <Text size="small">· Brand Style Kit（用户品牌色彩 / 字体）</Text>
                <Text size="small">· Shopify / Etsy 深度集成（商品自动导入）</Text>
                <Text size="small">· Instagram 资产导出（非自动发布主线）</Text>
                <Text size="small">· A/B 测试支持（多版本 Pin）</Text>
              </Stack>
            </CardBody>
          </Card>
          <Card>
            <CardHeader trailing={<Pill tone="neutral" size="sm">P2 · 探索</Pill>}>
              平台扩展
            </CardHeader>
            <CardBody>
              <Stack gap={5}>
                <Text size="small">· Team Workspace + 多账号管理</Text>
                <Text size="small">· 公共 API / Webhook</Text>
                <Text size="small">· Enterprise SLA + SSO</Text>
                <Text size="small">· SAM 2 商品背景替换（高精度）</Text>
                <Text size="small">· 多平台扩展（Pinterest 主轴稳固后）</Text>
                <Text size="small">· ComfyUI 本地化管线（按成本评估）</Text>
              </Stack>
            </CardBody>
          </Card>
        </Grid>

        <Grid columns={4} gap={12}>
          <Stat value="✅ 4" label="已上线核心模块" tone="success" />
          <Stat value="🔴 P0" label="发布闭环 + 管线调度" tone="danger" />
          <Stat value="12" label="数据库迁移版本" />
          <Stat value="5步" label="自主数据情报管线" />
        </Grid>
      </Stack>

      <Divider />

      {/* 11. High-Converting Pin Rules */}
      <Stack gap={10}>
        <H2>11. 高转化 Pin 生成规则（延续 v3.0）</H2>
        <Table
          headers={['规则', '说明']}
          rows={[
            ['2:3 vertical', 'Pinterest-first 纵向主比例（当前 Studio 默认输出）'],
            ['Clear focal point', '视觉焦点明确，主次分明'],
            ['Product obvious', '商品在画面中清晰可辨'],
            ['Lifestyle / use-case', '强生活化语境，避免纯白底电商图直出'],
            ['Clean composition', '不过度拥挤'],
            ['High-save visual', '偏平台「易收藏」美学（清新、层次、对比适度）'],
            ['Whitespace for overlay', '为文案层预留安全边距'],
            ['Platform-native look', '观感像原生 Pin，而非广告图'],
            ['No fake discounts', '用户未提供折扣信息禁止虚构促销文案'],
            ['No unreadable text', '若含字，移动端需可读'],
            ['No misleading claims', '不虚假功效，不冒充官方鉴定'],
          ]}
          striped
        />
      </Stack>

      <Divider />

      {/* 12. Pricing Hypothesis */}
      <Stack gap={12}>
        <H2>12. 定价假设（待与工程计量对齐）</H2>
        <Table
          headers={['概念', '假设']}
          rows={[
            ['Credit / 生成', '1 credit ≈ 1 张 Pin 图 + 配套 Title/Desc/Link 建议'],
            ['情报数据访问', '作为付费功能：Discover 高级筛选、产品评分详情、批量导出'],
            ['Schedule / publish', '按成功发布条数计量，或与高级档包月绑定'],
            ['Free 层', '有限生成额度 + 基础 Discover + 有限排期槽，用于激活'],
            ['Paid 分层', 'Starter（个人）→ Pro（卖家）→ Agency（团队 + 多账号）'],
          ]}
          striped
        />
      </Stack>

      <Text tone="quaternary" size="small" style={{ marginTop: 8 }}>
        VibePin PRD v4.0 · Pinterest Growth OS · 基于实际代码重写 · 2026-05-25
      </Text>
    </Stack>
  );
}
