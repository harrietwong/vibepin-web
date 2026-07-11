import {
  Stack, H1, H2, H3, Text, Grid, Row, Stat, Divider,
  Card, CardHeader, CardBody, Table, Callout, Pill, Code,
  useHostTheme,
} from 'cursor/canvas';

function InfoBlock({ label, value }: { label: string; value: string }) {
  const theme = useHostTheme();
  return (
    <div style={{ padding: '9px 12px', background: theme.fill.tertiary, borderRadius: 4 }}>
      <Text size="small" weight="semibold">{label}</Text>
      <Text size="small" tone="secondary" style={{ marginTop: 3 }}>{value}</Text>
    </div>
  );
}

function StepBox({ n, title, detail }: { n: string; title: string; detail: string }) {
  const theme = useHostTheme();
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
      <div style={{
        minWidth: 24, height: 24, borderRadius: '50%',
        background: theme.fill.secondary, border: `1px solid ${theme.stroke.primary}`,
        display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: 1,
      }}>
        <Text size="small" weight="semibold">{n}</Text>
      </div>
      <Stack gap={2}>
        <Text size="small" weight="semibold">{title}</Text>
        <Text size="small" tone="secondary">{detail}</Text>
      </Stack>
    </div>
  );
}

export default function IGShoppingTagExtensionPRD() {
  const theme = useHostTheme();

  return (
    <Stack gap={32} style={{ padding: 36, maxWidth: 960, margin: '0 auto' }}>

      {/* ── 标题 ─────────────────────────────────────────── */}
      <Stack gap={8}>
        <Row gap={10} align="center">
          <H1>Instagram Shopping Tag Extension PRD</H1>
          <Pill tone="warning" active size="sm">高风险探索项</Pill>
        </Row>
        <Text tone="secondary">
          Social Flow 主线 MVP 的独立增强模块 — 在 Instagram 帖子中自动挂载商品标签（Product Tag），实现站内购买跳转
        </Text>
        <Text tone="tertiary" size="small">
          v1.0 · 2026-05-12 · 本文档独立于主线 MVP PRD，仅在主线稳定后评估启动
        </Text>
      </Stack>

      <Grid columns={4} gap={14}>
        <Stat value="9 项" label="前置依赖（任一缺失即阻断）" tone="danger" />
        <Stat value="5–10 天" label="Meta App Review 审核周期" tone="warning" />
        <Stat value="部分地区" label="Instagram Shopping 不可用" tone="warning" />
        <Stat value="主线稳定后" label="建议启动时机" />
      </Grid>

      <Callout tone="danger" title="本文档定位">
        Instagram Shopping Tag 的依赖链长度和外部不可控性，远超其带来的商业价值增量。本文档存在的目的是：当有人在未来提出"加 Shopping Tag"时，能直接引用此 PRD 评估可行性，而不是在主线 MVP 里重新讨论。
      </Callout>

      <Divider />

      {/* ── 背景与动机 ──────────────────────────────────── */}
      <Stack gap={12}>
        <H2>背景与动机</H2>
        <Grid columns={2} gap={16}>
          <Card>
            <CardHeader>主线 MVP 当前 Instagram 能力</CardHeader>
            <CardBody>
              <Stack gap={6}>
                <Text size="small">主线 MVP（Social Flow v1.0）中 Instagram 模块的边界：</Text>
                <Text size="small">· 自动发布 1:1 场景图到 Instagram Feed</Text>
                <Text size="small">· AI 生成情绪化 Caption + Hashtags</Text>
                <Text size="small">· Caption 末尾自动追加 link-in-bio CTA</Text>
                <Text size="small">· <Text as="span" weight="semibold">不包含任何 Shopping Tag / 商品标签功能</Text></Text>
                <Text size="small" tone="secondary">用户点击图片无法直接跳转商品页，购买路径为：看到帖子 → 点主页 bio 链接 → 进入独立站</Text>
              </Stack>
            </CardBody>
          </Card>
          <Card>
            <CardHeader>Shopping Tag 能带来什么</CardHeader>
            <CardBody>
              <Stack gap={6}>
                <Text size="small">开启 Shopping Tag 后，用户点击帖子即可直接看到：</Text>
                <Text size="small">· 商品名称 + 价格标签（浮层展示）</Text>
                <Text size="small">· 点击标签直接跳转商品购买页</Text>
                <Text size="small">· 帖子在 Instagram Shop 标签页获得额外曝光</Text>
                <Text size="small">· 购物漏斗从 3 步（bio 链接）缩短至 2 步</Text>
                <Text size="small" tone="secondary">行业数据：带 Shopping Tag 的帖子点击率比无 Tag 高 20–40%（Meta 官方数据，2024）</Text>
              </Stack>
            </CardBody>
          </Card>
        </Grid>
      </Stack>

      <Divider />

      {/* ── 前置依赖全景 ────────────────────────────────── */}
      <Stack gap={12}>
        <H2>前置依赖全景（9 项，任一缺失即阻断）</H2>
        <Text tone="secondary" size="small">这是本功能复杂度的核心所在。每一项都是独立的外部依赖，部分存在地区限制或不确定的审核周期。</Text>
        <Table
          headers={['#', '依赖项', '操作方', '估计耗时', '风险等级', '阻断性']}
          rows={[
            ['1', 'Instagram 账号为专业账号（Business/Creator）', '用户', '5 min', '低', '是'],
            ['2', 'Instagram 账号绑定 Facebook 主页', '用户', '10 min', '低', '是'],
            ['3', 'Facebook Business Manager（BM）创建', '用户', '30 min', '低', '是'],
            ['4', 'BM 域名验证（DNS TXT 或 Meta Pixel）', '用户', '1–24h（DNS 传播）', '中', '是'],
            ['5', 'Meta Commerce Manager 商品目录创建', '用户 + 系统辅助', '1–2h', '中', '是'],
            ['6', '商品 Feed 同步至 Commerce Manager', '系统自动（需开发）', '1–3 天（Meta 审核）', '中', '是'],
            ['7', 'Instagram Shopping 功能申请（地区受限）', '用户', '3–7 天（Meta 人工审核）', '高', '是'],
            ['8', 'App 权限 <Code>instagram_shopping_tag_products</Code> 申请', '我们（开发方）', '5–10 工作日（Meta App Review）', '高', '是'],
            ['9', 'Instagram Shopping 在用户所在地区可用', '外部（地区政策）', '不可控', '极高', '是'],
          ]}
          rowTone={['success','success','success','neutral','neutral','neutral','warning','warning','danger']}
          striped
        />
        <Callout tone="warning" title="地区限制是最大不可控项">
          Instagram Shopping 目前在中国大陆注册账号、部分东南亚地区、多个非洲和中东国家不可用。若目标用户群中有相当比例来自这些地区，本功能的实际覆盖率可能远低于预期。需在启动前做用户地区分布调研。
        </Callout>
      </Stack>

      <Divider />

      {/* ── 技术架构 ─────────────────────────────────────── */}
      <Stack gap={12}>
        <H2>技术架构</H2>
        <Grid columns={2} gap={16}>
          <Stack gap={10}>
            <H3>新增系统组件</H3>
            <Stack gap={8}>
              <StepBox n="1" title="Eligibility Check 服务"
                detail="检测用户账号是否满足 9 项前置条件，逐项返回状态；每次发布前自动运行，不满足时降级为普通 Feed 发布" />
              <StepBox n="2" title="Commerce Manager Feed 同步器"
                detail="将主线 Metadata Scraper 抓取的商品数据格式化为 Meta Product Catalog CSV/JSON Feed，定时推送至 Commerce Manager，轮询审核状态" />
              <StepBox n="3" title="Product Tag 坐标计算器"
                detail="基于 AI 生成图的产品 mask 中心点，自动计算 product_tags 的 x/y 坐标（0–1 归一化），确保标签落在产品主体上" />
              <StepBox n="4" title="扩展发布器（IG Publisher v2）"
                detail="在现有 Graph API 发布流程中注入 product_tags 数组；发布前检查 Catalog 状态，Catalog 未 active 时静默降级为普通帖子" />
            </Stack>
          </Stack>
          <Stack gap={10}>
            <H3>API 调用链（新增部分）</H3>
            <Stack gap={6}>
              <InfoBlock
                label="Commerce Manager Feed"
                value="POST /catalog/feeds（创建）\nPATCH /catalog/feeds/{id}（更新商品）\nGET /catalog/feeds/{id}/items（审核状态轮询）"
              />
              <InfoBlock
                label="发布带 Tag 的帖子"
                value={'POST /{ig-user-id}/media\n  image_url, caption,\n  product_tags: [{\n    product_id,\n    merchant_id,\n    x, y\n  }]'}
              />
              <InfoBlock
                label="所需新增 App 权限"
                value="catalog_management\ninstagram_shopping_tag_products\ncatalog_management（FB App）"
              />
            </Stack>
          </Stack>
        </Grid>

        <Divider />

        <H3>Eligibility Check 流程（用户视角）</H3>
        <Table
          headers={['检测项', '检测方法', '通过', '失败处理']}
          rows={[
            ['账号为专业账号', 'Graph API 返回 account_type 字段', '继续', '展示转换为专业账号教程链接'],
            ['已绑定 FB 主页', 'Graph API connected_instagram_account', '继续', '展示绑定步骤指引'],
            ['BM 域名验证', 'Business.get_owned_domains 状态', '继续', '提示完成 DNS 验证，预计等待时间'],
            ['Commerce Catalog 存在且 active', 'Catalog API 状态轮询', '继续', '引导创建 Catalog，并显示当前处理进度'],
            ['Instagram Shopping 已申请通过', 'commerce_account.review_status', '开启 Tag 功能', '显示申请步骤 + 预计审核时间（3–7天）'],
            ['App 权限已获批', '检测 access_token 权限范围', '开启 Tag 功能', '提示等待 Meta App Review（仅对我们，非用户）'],
          ]}
          striped
        />
      </Stack>

      <Divider />

      {/* ── 风险登记 ─────────────────────────────────────── */}
      <Stack gap={12}>
        <H2>风险登记</H2>
        <Table
          headers={['风险', '概率', '影响', '缓解措施']}
          rows={[
            ['Meta App Review 被拒', '中（~30%）', '极高，整个功能无法上线', '提前 4 周提交；准备详细使用说明和测试账号；被拒后根据反馈修改重试'],
            ['用户所在地区不支持 IG Shopping', '中（取决于用户地区分布）', '高，该用户永久无法使用', '提前做用户地区调研；覆盖率 < 60% 时推迟启动'],
            ['Meta API 静默变更', '中（历史上多次发生）', '中，需紧急修复', '订阅 Meta for Developers Changelog；预留 2 周/季度的维护缓冲期'],
            ['Commerce Manager Feed 审核不通过', '低（产品真实存在）', '中，Tag 功能被暂停', '确保 Feed 字段完整（price / availability / description），配置 Feed 监控告警'],
            ['用户 BM 域名验证失败', '中（DNS 操作对非技术卖家困难）', '中，个别用户受阻', '提供手把手图文教程；支持 Meta Pixel 方案（更简单的备选验证方式）'],
            ['产品标签坐标偏移（标签不在产品上）', '低（mask 计算通常准确）', '低，影响体验', '发布前 Dashboard 展示标签预览，用户可拖动调整坐标'],
          ]}
          rowTone={['danger','warning','neutral','neutral','neutral','neutral']}
          striped
        />
      </Stack>

      <Divider />

      {/* ── 成功指标 ─────────────────────────────────────── */}
      <Stack gap={12}>
        <H2>成功指标</H2>
        <Text tone="secondary" size="small">仅对已成功开启 Shopping Tag 的用户账号统计，排除因地区限制或审核未通过而无法使用的账号。</Text>
        <Table
          headers={['指标', '目标', '衡量方式', '对比基准']}
          rows={[
            ['Shopping Tag 开通率', '> 60%（满足条件的用户中）', 'Eligibility Check 通过率统计', '—'],
            ['Tag 点击率（product_taps）', '> 2%（Tag 展示次数中）', 'ig_media insights: product_taps / impressions', '无 Tag 版本 link-in-bio 点击率'],
            ['购买转化率提升', 'Shopping Tag 帖子比无 Tag 帖子 +20%', '独立站 UTM 参数追踪（IG Shopping vs bio link）', '主线 MVP 的 bio link 转化率'],
            ['用户 Eligibility 完成时长', '< 30 min（从引导开始到全部条件满足）', '用户操作日志时间戳', '—'],
            ['Tag 降级发生率', '< 10%（本应有 Tag 但降级为普通帖子）', '发布日志统计', '—'],
          ]}
          striped
        />
      </Stack>

      <Divider />

      {/* ── 实施建议 ─────────────────────────────────────── */}
      <Stack gap={12}>
        <H2>实施建议与启动条件</H2>
        <Grid columns={2} gap={16}>
          <Card>
            <CardHeader>建议启动条件（全部满足再立项）</CardHeader>
            <CardBody>
              <Stack gap={7}>
                <Text size="small">1. 主线 MVP v1.0 上线稳定运行 &gt; 4 周，付费用户 &gt; 50</Text>
                <Text size="small">2. 用户调研确认 &gt; 40% 的付费用户有 Instagram Shopping 开通意愿</Text>
                <Text size="small">3. 用户地区分布调研确认 IG Shopping 覆盖率 &gt; 60%</Text>
                <Text size="small">4. Meta App Review 已提前提交（建议在条件 1 满足时同步提交，利用等待期）</Text>
                <Text size="small">5. 至少 5 个早期用户愿意参与 Beta 测试并协助完成 Eligibility 配置</Text>
              </Stack>
            </CardBody>
          </Card>
          <Card>
            <CardHeader>预估开发周期</CardHeader>
            <CardBody>
              <Stack gap={7}>
                <Text size="small"><Text as="span" weight="semibold">Eligibility Check 服务：</Text> 1 周</Text>
                <Text size="small"><Text as="span" weight="semibold">Commerce Manager Feed 同步：</Text> 1.5 周</Text>
                <Text size="small"><Text as="span" weight="semibold">Product Tag 坐标计算 + 发布器改造：</Text> 1 周</Text>
                <Text size="small"><Text as="span" weight="semibold">Onboarding 引导 UI：</Text> 1 周</Text>
                <Text size="small"><Text as="span" weight="semibold">测试 + Meta App Review 等待期：</Text> 2–3 周</Text>
                <Text size="small" weight="semibold">合计：约 7–8 周（含审核等待）</Text>
                <Text size="small" tone="secondary">注：App Review 期间可并行开发其他 P1 功能（如 9:16 Story 图、批量 SKU）</Text>
              </Stack>
            </CardBody>
          </Card>
        </Grid>

        <Callout tone="info" title="替代方案（低风险过渡）">
          在 Shopping Tag 功能上线前，可通过以下方式降低购买路径摩擦：① Linktree 或 Beacons 工具将 bio 链接改为商品聚合页（每个商品一行）；② 帖子 Caption 中写明商品名称，用户可直接搜索；③ Instagram Story Swipe-Up 链接（需 10k+ 粉丝）。这些方案无需 API 开发，可立即落地。
        </Callout>
      </Stack>

      <Divider />

      {/* ── 不做的明确声明 ──────────────────────────────── */}
      <Stack gap={12}>
        <H2>明确不在本 Extension PRD 范围内的能力</H2>
        <Table
          headers={['功能', '原因']}
          rows={[
            ['Pinterest Shopping Tag', 'Pinterest Catalog 依赖同样复杂，且本 Extension 专注 Instagram，不做两平台混合'],
            ['Instagram Checkout（站内结账）', 'Checkout 仅对美国用户开放，且需要 Meta Payment 资质，复杂度极高'],
            ['商品目录自动定价 / 库存同步', '超出内容营销工具范畴，属于 ERP / 库存系统职责'],
            ['Instagram Live Shopping', '直播带货产品形态与本工具完全不同，不在规划内'],
            ['TikTok Shop / Facebook Shop', '不同平台的独立生态，需单独立项'],
          ]}
          striped
        />
      </Stack>

      <Text tone="quaternary" size="small" style={{ marginTop: 4 }}>
        Social Flow — Instagram Shopping Tag Extension PRD · v1.0 · 2026-05-12 · 高风险探索项 · 主线 MVP 稳定后评估启动
      </Text>

    </Stack>
  );
}
