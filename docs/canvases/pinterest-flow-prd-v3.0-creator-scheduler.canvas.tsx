import {
  Stack, H1, H2, H3, Text, Grid, Row, Stat, Divider,
  Card, CardHeader, CardBody, Table, Callout, Pill, Code,
  useHostTheme, computeDAGLayout,
} from 'cursor/canvas';

/**
 * VibePin PRD v3.0 — AI Pinterest Pin Generator & Scheduler（Creator / Seller）
 * 取代 v2.0「下载优先、OAuth Beta」假设：批量发布与排期为 P0。
 * 历史版本：pinterest-flow-prd-v2.0-pinterest-first.canvas.tsx
 */

const dagNodes = [
  { id: 'ingest' }, { id: 'analyze' }, { id: 'directions' },
  { id: 'generate' }, { id: 'copyboard' }, { id: 'preview' }, { id: 'publish' },
];
const dagEdges = [
  { from: 'ingest', to: 'analyze' },
  { from: 'analyze', to: 'directions' },
  { from: 'directions', to: 'generate' },
  { from: 'generate', to: 'copyboard' },
  { from: 'copyboard', to: 'preview' },
  { from: 'preview', to: 'publish' },
];
const nodeLabels: Record<string, string> = {
  ingest: '图 / URL 输入',
  analyze: '品类 · 风格 · 人群',
  directions: '3–5 Pin 方向',
  generate: '批量 Pin 图',
  copyboard: '文案 + Board 建议',
  preview: '预览 · 多选',
  publish: '批量发 · 排期',
};
const nodeSubLabels: Record<string, string> = {
  ingest: '上传商品图 · 商品链接',
  analyze: 'AI Creative Strategy',
  directions: 'Pin Type Library',
  generate: 'API-first 2:3',
  copyboard: 'Title · Desc · Link',
  preview: 'Bulk select',
  publish: 'OAuth · Queue · Retry',
};

const layout = computeDAGLayout({
  nodes: dagNodes,
  edges: dagEdges,
  direction: 'horizontal',
  nodeWidth: 128,
  nodeHeight: 46,
  rankGap: 26,
  nodeGap: 18,
  padding: 16,
});

function DataFlowDiagramV3() {
  const theme = useHostTheme();
  return (
    <div style={{ overflowX: 'auto' }}>
      <svg width={layout.width} height={layout.height + 8} style={{ display: 'block' }}>
        <defs>
          <marker id="arrV30" markerWidth="7" markerHeight="7" refX="5" refY="3.5" orient="auto">
            <path d="M0,0 L0,7 L7,3.5 z" fill={theme.stroke.secondary} />
          </marker>
        </defs>
        {layout.edges.map((e, i) => (
          <line
            key={i}
            x1={e.sourceX}
            y1={e.sourceY}
            x2={e.targetX - 7}
            y2={e.targetY}
            stroke={theme.stroke.secondary}
            strokeWidth={1.5}
            markerEnd="url(#arrV30)"
          />
        ))}
        {layout.nodes.map(node => {
          const isPublish = node.id === 'publish';
          const isPreview = node.id === 'preview';
          const fill = isPublish
            ? theme.accent.primary
            : isPreview
              ? theme.fill.primary
              : theme.fill.tertiary;
          return (
            <g key={node.id}>
              <rect
                x={node.x}
                y={node.y}
                width={128}
                height={46}
                rx={5}
                fill={fill}
                stroke={theme.stroke.primary}
                strokeWidth={isPreview ? 1.5 : 1}
              />
              <text
                x={node.x + 64}
                y={node.y + 17}
                textAnchor="middle"
                fill={isPublish ? theme.text.onAccent : theme.text.primary}
                fontSize={10}
                fontFamily="system-ui, sans-serif"
                fontWeight="500"
              >
                {nodeLabels[node.id]}
              </text>
              <text
                x={node.x + 64}
                y={node.y + 31}
                textAnchor="middle"
                fill={isPublish ? theme.text.onAccent : theme.text.tertiary}
                fontSize={8.5}
                fontFamily="system-ui, sans-serif"
              >
                {nodeSubLabels[node.id]}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export default function SocialFlowPRDV30CreatorScheduler() {
  return (
    <Stack gap={28} style={{ padding: 36, maxWidth: 980, margin: '0 auto' }}>

      {/* ── Header ───────────────────────────────────────── */}
      <Stack gap={8}>
        <Row gap={10} align="center">
          <H1>VibePin — PRD v3.0</H1>
          <Pill tone="success" active size="sm">
            Pin Generator &amp; Scheduler · Creator-wide
          </Pill>
        </Row>
        <Text tone="secondary">
          <strong>AI Pinterest Pin Generator &amp; Scheduler for Product Creators。</strong>
          中文：面向商品型 creator / seller 的 AI Pin 图生成、批量发布与排期工具。
          不局限于家居或「单张场景图替换」——核心是：从商品输入到高转化 Pin 的规模化生产与发布闭环。
        </Text>
        <Callout tone="info" title="与 v2.0 的关键差异">
          <Text size="small">
            v2.0 将「仅下载 / 导出」作为 MVP 主轴、OAuth 排期推迟到 Beta。
            <strong> v3.0 将 Pinterest OAuth、Bulk publish、Schedule、Queue 与 Retry 提升为 P0</strong>，
            产品叙事从「工具型生成」转为「生成 + 编排 + 上架」。
          </Text>
        </Callout>
      </Stack>

      <Divider />

      {/* 1. Product Positioning */}
      <Stack gap={10}>
        <H2>1. Product Positioning</H2>
        <Text tone="secondary" size="small">
          弱化：仅服务 Shopify / Etsy 家居独立站、以「单品 AI 场景图」为唯一心智。
        </Text>
        <Table
          headers={['维度', 'v3.0 定位']}
          rows={[
            ['一句英文', 'AI Pinterest Pin Generator & Scheduler for Product Creators'],
            ['一句中文', '面向需要批量生产并发布商品链接 Pin 的 creator / seller：上传图或粘贴链接 → 高转化 Pin → 批量发布与排期'],
            ['价值主张', '减少从「有货」到「有 Pin 在场上跑」的时间；品类覆盖广，模板与创意方向由系统推荐'],
            ['技术表述', 'API-first 图像与 LLM；不写死单一 ComfyUI / SAM / ControlNet 路线，按成本与质量迭代评估'],
          ]}
          striped
        />
      </Stack>

      <Divider />

      {/* 2. Target Users */}
      <Stack gap={10}>
        <H2>2. Target Users</H2>
        <Text tone="secondary" size="small">
          目标用户<strong>不限家居</strong>。Phase 1 demo / 模板仍可优先展示 Fashion、Home、Beauty，但 PRD 与用户故事不锁类目。
        </Text>
        <Grid columns={2} gap={12}>
          <Card>
            <CardHeader>Primary</CardHeader>
            <CardBody>
              <Stack gap={6}>
                <Text size="small">· 多 SKU、多链接需要规律上 Pin 的 seller</Text>
                <Text size="small">· Affiliate / curator：批量组货、指南类、合集 Pin</Text>
                <Text size="small">· 小型独立站与 Etsy handmade：资源有限、需要自动化编排</Text>
              </Stack>
            </CardBody>
          </Card>
          <Card>
            <CardHeader>Category coverage（示例，非排他）</CardHeader>
            <CardBody>
              <Stack gap={6}>
                <Text size="small">
                  Fashion · Jewelry · Beauty · Home Decor · Digital Products · Etsy Handmade · Small Shopify · Affiliate
                </Text>
              </Stack>
            </CardBody>
          </Card>
        </Grid>
      </Stack>

      <Divider />

      {/* 3. Core Use Cases */}
      <Stack gap={10}>
        <H2>3. Core Use Cases</H2>
        <Table
          headers={['场景', '简述']}
          rows={[
            ['单次上新', '一条链接或一张图 → 推荐方向 → 生成多套 Pin → 选一或多张发布 / 排期'],
            ['批量 catalog', '多条 URL 或批量图 → 队列生成 → 批量预览勾选 → 批量发帖'],
            ['参考图复刻', '用户提供参考 Pin / 图 → Reference Mode 提取构图与氛围 → 用自己商品出类似风格 Pin'],
            ['Campaign 排期', '设定日期时间槽与每日上限 → 队列灌入 → 失败重试 → 已发 URL 回写'],
            ['轻量运营', 'Auto Mode 少操作；高级用户可切 Custom Prompt（非默认入口）'],
          ]}
          striped
        />
      </Stack>

      <Divider />

      {/* 4. MVP Scope */}
      <Stack gap={10}>
        <H2>4. MVP Scope（v3.0）</H2>
        <Callout tone="success" title="MVP 边界">
          MVP = 能稳定完成「输入商品 → 分析与方向 → 多 Pin 生成 → 文案与 Board 建议 → 多选 →
          <strong>OAuth 后批量发布与排期</strong>」；下载/导出可作为辅助，但<strong>不能替代发布主线</strong>。
        </Callout>
        <Text size="small" tone="secondary">
          Instagram 自动发布、Shopping Tag、像素级商品保真等均<strong>不作为 P0</strong>；
          合规上强调营销创意用途，不绑定「必须 ComfyUI 管线」。
        </Text>
      </Stack>

      <Divider />

      {/* 5. AI Creative Strategy Engine */}
      <Stack gap={12}>
        <H2>5. AI Creative Strategy Engine</H2>
        <Text tone="secondary" size="small">
          系统<strong>不依赖写死的长 prompt 库</strong>。由 AI 根据：品类、视觉风格、使用场景、目标人群、
          Pinterest 搜索/保存意图，动态选择 Pin 结构、营销角度与传给图像模型的条件（非对外展示的一坨固定模板）。
        </Text>
        <Table
          headers={['模式', '行为', '默认？']}
          rows={[
            [
              'Auto Mode',
              '仅图或 URL；系统识别品类 / 风格 / 场景 / 人群 → 从 Pin Creative Type Library 中推荐 3–5 个方向 → 用户一键 Auto Generate 或点选子集',
              '是 · 默认',
            ],
            [
              'Reference Mode',
              '用户上传参考 Pin 或参考图；系统提取构图、色彩、氛围、版式特征 → 与用户商品结合生成「类似风格」的新 Pin（合规：相似的是版式与美学气质，不宣称复制他人爆款）',
              '否 · 显式入口',
            ],
            [
              'Custom Prompt Mode',
              '高级用户可输入额外 creative 指令；可选增强，不是必填，也不是首屏主路径',
              '否 · 进阶',
            ],
          ]}
          striped
        />
        <Callout tone="warning" title="弱化项（相对旧 PRD）">
          不以「固定家居场景 prompt 列表」为产品核心配置；预设侧重点是 <strong>Pin Type（创意类型）</strong>，
          具体 prompt 由 Strategy Engine 拼装与迭代。
        </Callout>
      </Stack>

      <Divider />

      {/* 6. Pin Creative Type Library */}
      <Stack gap={12}>
        <H2>6. Pin Creative Type Library（非 Prompt Library）</H2>
        <Text size="small" tone="secondary">
          库中条目是「创意类型 / 版式意图」，供 Strategy Engine 映射到动态生成策略；不面向运营逐条维护英文 prompt 段落。
        </Text>
        <Table
          headers={['Pin Type', '说明']}
          rows={[
            ['Lifestyle Scene', '使用场景与生活方式语境'],
            ['Product Collage', '多单品或多角度拼贴'],
            ['Moodboard', '情绪板、质感与配色导向'],
            ['Gift Guide', '礼赠、节日与赠礼心智'],
            ['How to Style', '搭配、教程感、步骤暗示'],
            ['Seasonal Campaign', '季节 / 节日主题'],
            ['Problem / Solution', '痛点—解决结构（视觉暗示即可）'],
            ['Before / After', '前后对比类（需合规，避免夸大功效）'],
            ['Product Spotlight', '单 SKU 强焦点'],
            ['Collection / Roundup', '合集、清单、主题聚合'],
          ]}
          striped
        />
        <H3>品类 → 方向示例（系统自动选 3–5 个）</H3>
        <Table
          headers={['类目示例', '常见推荐方向']}
          rows={[
            ['Fashion', 'Outfit inspiration · How to style · Seasonal look · Product collage'],
            ['Home', 'Room scene · Moodboard · Small-space styling · Gift guide'],
            ['Beauty', 'Flat lay · Routine step · Gift guide · Before / after（合规边界内）'],
          ]}
          striped
        />
      </Stack>

      <Divider />

      {/* 7. High-Converting Pin Generation Rules */}
      <Stack gap={10}>
        <H2>7. High-Converting Pin Generation Rules</H2>
        <Text size="small" tone="secondary">
          生成管线与质检规则层应显式编码下列约束（产品规则，非实现细节）。
        </Text>
        <Table
          headers={['规则', '说明']}
          rows={[
            ['2:3 vertical', 'Pinterest-first 纵向主比例'],
            ['Clear focal point', '视觉焦点明确，主次分明'],
            ['Product obvious', '商品或可识别的商品载体在画面中清晰可辨'],
            ['Lifestyle / use-case', '强生活化或使用情境，避免纯白底电商图直出当终稿'],
            ['Clean composition', '不过度拥挤'],
            ['High-save visual', '偏平台常见「易收藏」美学（清新、层次、对比适度）'],
            ['Whitespace for overlay', '为未来或自动文案层预留安全边距'],
            ['Platform-native look', '观感像原生 Pin 生态，而非违和广告屏摄'],
            ['No fake discounts', '用户未提供折扣信息则禁止虚构促销文案或角标'],
            ['No unreadable text', '若含字，移动端需可读'],
            ['No misleading claims', '不虚假功效、不冒充官方鉴定'],
          ]}
          striped
        />
      </Stack>

      <Divider />

      {/* 8. Business Flow */}
      <Stack gap={12}>
        <H2>8. Business Flow（轻便主路径）</H2>
        <Card>
          <CardBody>
            <Stack gap={6}>
              <Text size="small"><strong>Step 1</strong> 上传商品图 / 粘贴商品 URL</Text>
              <Text size="small"><strong>Step 2</strong> AI 识别品类、风格、目标用户与使用场景</Text>
              <Text size="small"><strong>Step 3</strong> 系统推荐 3–5 个 Pin 创意方向（来自 Type Library + Engine）</Text>
              <Text size="small"><strong>Step 4</strong> 用户选择 Auto Generate 或手动勾选方向</Text>
              <Text size="small"><strong>Step 5</strong> 批量生成多张 Pinterest Pin 图</Text>
              <Text size="small"><strong>Step 6</strong> 自动生成 Title / Description / Link / Board 建议</Text>
              <Text size="small"><strong>Step 7</strong> 用户预览并批量勾选保留</Text>
              <Text size="small"><strong>Step 8</strong> 批量发布到 Pinterest 或排期发布</Text>
            </Stack>
          </CardBody>
        </Card>
        <Text size="small" tone="secondary">
          支线：Reference Mode / Custom Prompt 在 Step 1–4 之间切入；不改变 Step 8 的发布必选地位。
        </Text>
      </Stack>

      <Divider />

      {/* 9. Bulk Publish & Scheduling Flow */}
      <Stack gap={12}>
        <H2>9. Bulk Publish &amp; Scheduling Flow</H2>
        <Callout tone="success" title="P0 能力清单">
          Pinterest OAuth · Board 选择 · 批量勾选发布 · 按日期时间排期 · Daily publish limit ·
          Queue 状态可见 · Failed Pin 重试 · Published Pin URL 回写到任务 / 面板
        </Callout>
        <Table
          headers={['环节', '产品要点']}
          rows={[
            ['OAuth', '最少权限原则；断开与重连状态可见'],
            ['Board', '默认 Board + 每张 Pin 可覆盖；Board 建议来自 Step 6'],
            ['Bulk publish', '一次性提交多 Pin；部分失败不阻塞成功项回写'],
            ['Schedule', '时间槽、时区、与每日上限联动'],
            ['Daily limit', '防刷与账号安全；队列自动顺延'],
            ['Queue', '等待中 / 发送中 / 已发 / 失败 / 已排期'],
            ['Retry', '可单条或批量重试；记录失败原因码（用户可读）'],
            ['URL write-back', '已发布 Pin 链接落库，便于导出与复盘'],
          ]}
          striped
        />
        <DataFlowDiagramV3 />
      </Stack>

      <Divider />

      {/* 10. Failure Handling */}
      <Stack gap={10}>
        <H2>10. Failure Handling</H2>
        <Table
          headers={['失败类型', '产品行为']}
          rows={[
            ['URL 抓取失败', '引导改手填标题/图/链接；保留队列位'],
            ['图像生成失败', '自动重试；降级为简化版式；通知用户该张失败原因'],
            ['方向推荐置信度低', '提示用户切换 Reference 或补充一张场景图'],
            ['发布 API 限流 / 拒收', '进入重试队列；触及 daily limit 则顺延排期'],
            ['部分 Pin 发布成功', '成功项写回 URL；失败项独立展示与重试'],
            ['Token 过期', 'OAuth 重连引导；队列暂停并明确提示'],
          ]}
          striped
        />
      </Stack>

      <Divider />

      {/* 11. Landing Page Requirements */}
      <Stack gap={12}>
        <H2>11. Landing Page Requirements</H2>
        <Table
          headers={['元素', '要求']}
          rows={[
            ['Hero title', '示例：Create High-Converting Pinterest Pins From Any Product'],
            [
              'Subtitle',
              'Upload product photos or paste product links. Generate Pinterest-ready images, SEO titles, descriptions, and schedule them in bulk — no design skills required.',
            ],
            ['Social proof / 类目', '首屏展示多类目高转化案例：Fashion · Beauty · Home · Jewelry · Digital / Printable'],
            [
              'Make Similar',
              '每张案例提供「Make one like this」/「Create similar style」：进入 Reference 流并引导上传自有商品图',
            ],
            ['主线 CTA', '强调生成 + 排期 + 批量，而非仅下载'],
            ['弱化的内容', '不强调「仅家居」；Instagram 不为并列主卖点；无 Shopping Tag 承诺'],
          ]}
          striped
        />
      </Stack>

      <Divider />

      {/* 12. Pricing Hypothesis */}
      <Stack gap={12}>
        <H2>12. Pricing Hypothesis</H2>
        <Text size="small" tone="secondary">
          计费需覆盖「生成」与「发布动作」成本；下列为假设，待与工程计量对齐。
        </Text>
        <Table
          headers={['概念', '假设']}
          rows={[
            ['Credit / 生成', '1 unit ≈ 1 张 Pin 图 + 配套 Title/Desc/Link 建议（与 v2 可对齐或拆分「发布 credit」）'],
            ['Schedule / publish', '可按成功发布条数计量，或与高级档包月绑定；需避免与生成 credit 重复计费逻辑混乱'],
            ['Free', '有限生成 + 有限排期槽位，用于激活；具体数字 PMF 阶段定'],
            ['Paid', '按 volume 分档：生成量、并发队列、每日发布上限、Board 数'],
          ]}
          striped
        />
      </Stack>

      <Divider />

      {/* 13. Roadmap P0 P1 P2 */}
      <Stack gap={14}>
        <H2>13. P0 / P1 / P2 Roadmap</H2>
        <Grid columns={3} gap={14}>
          <Card>
            <CardHeader trailing={<Pill tone="success" size="sm">P0</Pill>}>
              必做
            </CardHeader>
            <CardBody>
              <Stack gap={5}>
                <Text size="small">· Product image upload</Text>
                <Text size="small">· Product URL import</Text>
                <Text size="small">· AI product / category analysis</Text>
                <Text size="small">· Auto creative direction generation（3–5）</Text>
                <Text size="small">· AI Pin image generation（bulk）</Text>
                <Text size="small">· Reference style mode</Text>
                <Text size="small">· Pinterest 2:3 output</Text>
                <Text size="small">· Pin title + description + link + Board suggestion</Text>
                <Text size="small">· Bulk preview &amp; selection</Text>
                <Text size="small">· Pinterest OAuth</Text>
                <Text size="small">· Bulk publish</Text>
                <Text size="small">· Schedule publish</Text>
                <Text size="small">· Queue, daily limit, retry</Text>
                <Text size="small">· Published URL write-back</Text>
              </Stack>
            </CardBody>
          </Card>
          <Card>
            <CardHeader trailing={<Pill tone="warning" size="sm">P1</Pill>}>
              后续
            </CardHeader>
            <CardBody>
              <Stack gap={5}>
                <Text size="small">· Shopify App integration</Text>
                <Text size="small">· Etsy deeper integration</Text>
                <Text size="small">· Instagram asset export / caption（非自动发布主线）</Text>
                <Text size="small">· Team workspace</Text>
                <Text size="small">· Analytics dashboard</Text>
                <Text size="small">· Brand style kit</Text>
                <Text size="small">· A/B testing</Text>
                <Text size="small">· More image ratios</Text>
                <Text size="small">· Custom Prompt Mode（高级入口，可与 Auto/Reference 并行迭代）</Text>
              </Stack>
            </CardBody>
          </Card>
          <Card>
            <CardHeader trailing={<Pill tone="neutral" size="sm">P2</Pill>}>
              Optional 探索
            </CardHeader>
            <CardBody>
              <Stack gap={5}>
                <Text size="small">· 公共 API / Webhook</Text>
                <Text size="small">· Enterprise SLA ·  SSO</Text>
                <Text size="small">· 多平台扩展（若在 Pin 主轴稳固后）</Text>
                <Text size="small">· 按需评估 ComfyUI 等本地化管线（非必选）</Text>
              </Stack>
            </CardBody>
          </Card>
        </Grid>

        <Grid columns={4} gap={12}>
          <Stat value="P0" label="生成 + OAuth + Bulk + Schedule" tone="success" />
          <Stat value="动态" label="Creative Strategy Engine" />
          <Stat value="类型库" label="Pin Creative Types" />
          <Stat value="弱化" label="Instagram · Shopping Tag · 像素保真" />
        </Grid>
      </Stack>

      <Text tone="quaternary" size="small" style={{ marginTop: 8 }}>
        VibePin PRD v3.0 · Creator-wide · Bulk publish &amp; schedule as P0 · 2026-05-12
      </Text>
    </Stack>
  );
}
