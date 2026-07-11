import {
  Stack, H1, H2, H3, Text, Grid, Row, Divider,
  Card, CardHeader, CardBody, Callout, Pill, Button, Select,
  useHostTheme, useCanvasState,
} from 'cursor/canvas';

/** Landing spec — aligned with PRD v3.0 (pinterest-flow-prd-v3.0-creator-scheduler.canvas.tsx) */
const CALC_OPTIONS = [
  { value: '5',  label: '5 products / week' },
  { value: '10', label: '10 products / week' },
  { value: '20', label: '20 products / week' },
  { value: '50', label: '50 products / week' },
];
function calcSavings(perWeek: number) {
  const manualMin = 45; // resize + copy + publish manually
  const toolMin   = 5;  // upload / URL → bulk Pins → schedule with VibePin
  const hoursPerMonth = Math.round((perWeek * 4 * (manualMin - toolMin)) / 60);
  const daysPerYear   = Math.round((hoursPerMonth * 12) / 8);
  return { hoursPerMonth, daysPerYear };
}

// ─── Reusable primitives ──────────────────────────────────────────────────────
function SectionLabel({ children }: { children: string }) {
  const theme = useHostTheme();
  return (
    <div style={{
      display: 'inline-block', padding: '3px 10px', borderRadius: 99,
      border: `1px solid ${theme.stroke.secondary}`,
      marginBottom: 8,
    }}>
      <Text size="small" tone="secondary">{children}</Text>
    </div>
  );
}

function StepBadge({ n }: { n: number }) {
  const theme = useHostTheme();
  return (
    <div style={{
      width: 28, height: 28, borderRadius: '50%', flexShrink: 0,
      background: theme.accent.primary,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <Text size="small" weight="bold" style={{ color: theme.text.onAccent }}>{n}</Text>
    </div>
  );
}

/** PRD v3 · multi-category showcase — "Make one like this" → Reference Mode onboarding */
function CategoryExampleCard({
  category, pinType, sampleTitle, gradient,
}: {
  category: string;
  pinType: string;
  sampleTitle: string;
  gradient: string;
}) {
  const theme = useHostTheme();
  return (
    <div style={{
      borderRadius: 10,
      border: `1px solid ${theme.stroke.primary}`,
      overflow: 'hidden',
      background: theme.bg.editor,
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
      padding: 12,
    }}>
      <Row gap={8} align="center" wrap>
        <Pill tone="success" size="sm">{category}</Pill>
        <Text size="small" tone="tertiary">{pinType}</Text>
      </Row>
      <div style={{
        width: '100%',
        aspectRatio: '2 / 3',
        borderRadius: 8,
        background: gradient,
        border: `1px solid ${theme.stroke.secondary}`,
      }} />
      <Text size="small" weight="semibold" style={{ lineHeight: 1.35 }}>{sampleTitle}</Text>
      <Button variant="secondary" style={{ width: '100%' }}>Make one like this</Button>
      <Text size="small" tone="tertiary" style={{ fontSize: 10 }}>
        [Dev] CTA → Reference Mode: store `example_ref_id` / asset; next screen = upload user product image (or URL). Do not claim “copy viral Pin”.
      </Text>
    </div>
  );
}

function PainCard({ icon, title, desc }: { icon: string; title: string; desc: string }) {
  const theme = useHostTheme();
  return (
    <div style={{ padding: '20px 18px', borderRadius: 8, border: `1px solid ${theme.stroke.primary}` }}>
      <div style={{
        width: 36, height: 36, borderRadius: 8, marginBottom: 12,
        background: theme.fill.secondary,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 18,
      }}>{icon}</div>
      <Text size="small" weight="semibold">{title}</Text>
      <Text size="small" tone="secondary" style={{ marginTop: 6 }}>{desc}</Text>
    </div>
  );
}

function PricingCard({ plan, price, period, desc, features, highlighted, cta }: {
  plan: string; price: string; period: string; desc: string;
  features: string[]; highlighted?: boolean; cta: string;
}) {
  const theme = useHostTheme();
  return (
    <div style={{
      padding: '24px 20px',
      borderRadius: 10,
      border: highlighted
        ? `2px solid ${theme.accent.primary}`
        : `1px solid ${theme.stroke.primary}`,
      background: highlighted ? theme.fill.secondary : theme.bg.editor,
      position: 'relative',
    }}>
      {highlighted && (
        <div style={{
          position: 'absolute', top: -12, left: '50%', transform: 'translateX(-50%)',
          padding: '2px 12px', borderRadius: 99, background: theme.accent.primary,
        }}>
          <Text size="small" weight="semibold" style={{ color: theme.text.onAccent, fontSize: 11 }}>
            Most Popular
          </Text>
        </div>
      )}
      <Stack gap={4}>
        <Text size="small" weight="semibold" tone="secondary">{plan}</Text>
        <Row gap={4} align="end">
          <H2 style={{ lineHeight: 1 }}>{price}</H2>
          <Text size="small" tone="tertiary" style={{ paddingBottom: 3 }}>{period}</Text>
        </Row>
        <Text size="small" tone="secondary">{desc}</Text>
      </Stack>
      <Divider style={{ margin: '16px 0' }} />
      <Stack gap={7}>
        {features.map((f, i) => (
          <Row key={i} gap={8} align="center">
            <div style={{ width: 16, height: 16, borderRadius: '50%', background: theme.fill.secondary, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <Text size="small" style={{ fontSize: 9, color: theme.accent.primary }}>✓</Text>
            </div>
            <Text size="small">{f}</Text>
          </Row>
        ))}
      </Stack>
      <div style={{ marginTop: 20 }}>
        <Button variant={highlighted ? 'primary' : 'secondary'} style={{ width: '100%' }}>{cta}</Button>
      </div>
    </div>
  );
}

function FaqItem({ q, a }: { q: string; a: string }) {
  return (
    <Card collapsible defaultOpen={false}>
      <CardHeader>{q}</CardHeader>
      <CardBody>
        <Text size="small" tone="secondary">{a}</Text>
      </CardBody>
    </Card>
  );
}

// ─── Main Landing Page ────────────────────────────────────────────────────────
export default function SocialFlowLandingPage() {
  const theme = useHostTheme();
  const [calcValue, setCalcValue] = useCanvasState<string>('calc-products', '10');
  const savings = calcSavings(parseInt(calcValue));

  return (
    <Stack gap={0} style={{ maxWidth: 1100, margin: '0 auto', fontFamily: 'system-ui, -apple-system, sans-serif' }}>

      {/* ── SPEC HEADER ────────────────────────────────────── */}
      <div style={{ padding: '10px 40px', background: theme.fill.primary, borderBottom: `1px solid ${theme.stroke.primary}` }}>
        <Row gap={12} align="center">
          <Pill tone="info" active size="sm">Landing Page Spec</Pill>
          <Text size="small" tone="secondary">VibePin · Align PRD v3.0 — Pin Generator &amp; Scheduler · creator-wide categories</Text>
          <div style={{ flex: 1 }} />
          <Text size="small" tone="tertiary">v3.0 spec · 2026-05-12</Text>
        </Row>
      </div>

      <Stack gap={0} style={{ padding: '0 40px' }}>

        {/* ══════════════════════════════════════════════════ */}
        {/* SECTION 1 — NAV                                   */}
        {/* ══════════════════════════════════════════════════ */}
        <div style={{ padding: '18px 0', borderBottom: `1px solid ${theme.stroke.tertiary}` }}>
          <Row align="center" justify="space-between">
            <Row gap={8} align="center">
              <div style={{ width: 28, height: 28, borderRadius: 6, background: theme.accent.primary }} />
              <Text weight="bold">VibePin</Text>
            </Row>
            <Row gap={24} align="center">
              {['Examples', 'Features', 'Pricing', 'FAQ'].map(item => (
                <Text key={item} size="small" tone="secondary">{item}</Text>
              ))}
              <Button variant="ghost">Log in</Button>
              <Button variant="primary">Start creating</Button>
            </Row>
          </Row>
          <Text size="small" tone="tertiary" style={{ marginTop: 6 }}>
            [Dev note] Sticky nav. Examples → #category-showcase. CTA → /signup or #hero-input. Pinterest-first; Instagram not in primary nav.
          </Text>
        </div>

        {/* ══════════════════════════════════════════════════ */}
        {/* SECTION 2 — HERO                                  */}
        {/* ══════════════════════════════════════════════════ */}
        <div style={{ padding: '72px 0 48px' }} id="hero-input">
          <Grid columns="1fr 1fr" gap={48} align="center">

            {/* Left: Copy */}
            <Stack gap={20}>
              <Row gap={10} align="center" wrap>
                <Pill tone="success" size="sm">Pinterest-first</Pill>
                <Pill tone="neutral" size="sm">Bulk generate &amp; schedule</Pill>
                <Pill tone="neutral" size="sm">Any product category</Pill>
              </Row>
              <H1 style={{ fontSize: 40, lineHeight: 1.12, letterSpacing: -0.5 }}>
                Create High-Converting Pinterest Pins From Any Product
              </H1>
              <Text tone="secondary" style={{ fontSize: 17, lineHeight: 1.6 }}>
                Upload product photos or paste product links. Generate Pinterest-ready images, SEO titles, descriptions, and schedule them in bulk — no design skills required.
              </Text>

              {/* Input CTA block — URL + image (spec) */}
              <div style={{ padding: '18px 20px', borderRadius: 10, border: `1px solid ${theme.stroke.primary}`, background: theme.fill.tertiary }}>
                <Stack gap={10}>
                  <div style={{
                    padding: '10px 14px', borderRadius: 7,
                    border: `1px dashed ${theme.stroke.secondary}`,
                    background: theme.bg.editor,
                  }}>
                    <Text size="small" tone="tertiary">Upload product images (drag &amp; drop) — or paste product URLs</Text>
                  </div>
                  <div style={{
                    padding: '10px 14px', borderRadius: 7,
                    border: `1px solid ${theme.stroke.secondary}`,
                    background: theme.bg.editor,
                  }}>
                    <Text size="small" tone="tertiary">https://your-shop.com/products/...</Text>
                  </div>
                  <Row gap={10} wrap>
                    <Button variant="primary" style={{ flex: 1, minWidth: 140 }}>Generate Pins</Button>
                    <Button variant="secondary" style={{ flex: 1, minWidth: 140 }}>Browse examples</Button>
                  </Row>
                  <Text size="small" tone="tertiary" style={{ textAlign: 'center' }}>
                    Connect Pinterest when you&apos;re ready to publish · Credits-based · ~20 starter credits on free tier (exact TBD)
                  </Text>
                </Stack>
                <Text size="small" tone="tertiary" style={{ marginTop: 10 }}>
                  [Dev] Track `hero_upload`, `hero_paste_url`, `cta_primary`. OAuth not required before first preview (product decision); bulk publish path is P0 per PRD v3.
                </Text>
              </div>

              <Row gap={16} align="center" wrap>
                {['Fashion', 'Beauty', 'Home', 'Jewelry', 'Digital', 'Etsy'].map(p => (
                  <Row key={p} gap={5} align="center">
                    <div style={{ width: 8, height: 8, borderRadius: '50%', background: theme.accent.primary }} />
                    <Text size="small" tone="secondary">{p}</Text>
                  </Row>
                ))}
              </Row>
            </Stack>

            {/* Right: Multi-category mosaic (replace with real shots) */}
            <Stack gap={14} style={{ alignItems: 'stretch' }}>
              <Callout tone="info" title="Hero visual — multi-category">
                <Text size="small">
                  Use 5 real 2:3 Pin renders: Fashion outfit grid, Beauty flat-lay, Home room scene, Jewelry macro, Digital/printable mockup.
                  Optional auto-rotate carousel. Instagram is not parity-sized here.
                </Text>
              </Callout>
              <Grid columns={3} gap={10}>
                {[
                  { label: 'Fashion', sub: 'How to style', g: 'linear-gradient(145deg,#fce7f3,#fbcfe8)' },
                  { label: 'Beauty', sub: 'Flat lay', g: 'linear-gradient(145deg,#fef3c7,#fcd34d)' },
                  { label: 'Home', sub: 'Room scene', g: 'linear-gradient(145deg,#e7e5e4,#d6d3d1)' },
                  { label: 'Jewelry', sub: 'Spotlight', g: 'linear-gradient(145deg,#fae8ff,#e9d5ff)' },
                  { label: 'Digital', sub: 'Mockup', g: 'linear-gradient(145deg,#dbeafe,#93c5fd)' },
                  { label: 'Schedule', sub: 'Queue', g: 'linear-gradient(145deg,#d1fae5,#34d399)' },
                ].map(tile => (
                  <div key={tile.label} style={{
                    borderRadius: 8,
                    border: `1px solid ${theme.stroke.primary}`,
                    overflow: 'hidden',
                  }}>
                    <div style={{
                      aspectRatio: '2/3',
                      background: tile.g,
                      display: 'flex',
                      alignItems: 'flex-end',
                      padding: 8,
                    }}>
                      <Stack gap={2}>
                        <Text size="small" weight="semibold">{tile.label}</Text>
                        <Text size="small" tone="tertiary" style={{ fontSize: 10 }}>{tile.sub}</Text>
                      </Stack>
                    </div>
                  </div>
                ))}
              </Grid>
              <Text size="small" tone="tertiary" style={{ textAlign: 'center' }}>
                Each tile can deep-link to #category-showcase with category pre-filter · CTA overlays optional.
              </Text>
            </Stack>
          </Grid>
        </div>

        {/* ══════════════════════════════════════════════════ */}
        {/* SECTION 2B — CATEGORY SHOWCASE + MAKE SIMILAR    */}
        {/* ══════════════════════════════════════════════════ */}
        <div id="category-showcase" style={{ padding: '56px 0', borderTop: `1px solid ${theme.stroke.tertiary}` }}>
          <Stack gap={28}>
            <Stack gap={8} style={{ textAlign: 'center', alignItems: 'center' }}>
              <SectionLabel>High-converting examples</SectionLabel>
              <H2>See Pins across categories — then make yours</H2>
              <Text tone="secondary" style={{ maxWidth: 640, textAlign: 'center' }}>
                Not home-only: swap in on-brand photography per vertical. Every card exposes the same Reference-style path (layout &amp; mood, not “clone viral”).
              </Text>
            </Stack>
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
              gap: 16,
            }}>
              <CategoryExampleCard
                category="Fashion"
                pinType="How to style"
                sampleTitle="Layered fall outfit — 3 pieces you already own"
                gradient="linear-gradient(180deg,#fff1f2 0%,#fecdd3 100%)"
              />
              <CategoryExampleCard
                category="Beauty"
                pinType="Routine / flat lay"
                sampleTitle="5-minute glow routine · clean girl aesthetic"
                gradient="linear-gradient(180deg,#fffbeb 0%,#fde68a 100%)"
              />
              <CategoryExampleCard
                category="Home decor"
                pinType="Room scene"
                sampleTitle="Small living room · warm minimal layout"
                gradient="linear-gradient(180deg,#fafaf9 0%,#d6d3d1 100%)"
              />
              <CategoryExampleCard
                category="Jewelry"
                pinType="Product spotlight"
                sampleTitle="Everyday gold stack — gift-ready"
                gradient="linear-gradient(180deg,#faf5ff 0%,#e9d5ff 100%)"
              />
              <CategoryExampleCard
                category="Digital / printable"
                pinType="Device mockup"
                sampleTitle="Notion planner pack · start today"
                gradient="linear-gradient(180deg,#eff6ff 0%,#93c5fd 100%)"
              />
            </div>
          </Stack>
        </div>

        {/* ══════════════════════════════════════════════════ */}
        {/* SECTION 3 — PAIN POINTS                          */}
        {/* ══════════════════════════════════════════════════ */}
        <div style={{ padding: '64px 0', borderTop: `1px solid ${theme.stroke.tertiary}` }}>
          <Stack gap={32}>
            <Stack gap={8} style={{ textAlign: 'center', alignItems: 'center' }}>
              <SectionLabel>Sound familiar?</SectionLabel>
              <H2>Posting great Pins at scale is exhausting</H2>
              <Text tone="secondary" style={{ maxWidth: 560, textAlign: 'center' }}>
                Product creators juggle dozens of SKUs and affiliate links. Pinterest rewards consistent, save-worthy 2:3 creatives — not one-off scene swaps.
              </Text>
            </Stack>
            <Grid columns={3} gap={16}>
              <PainCard
                icon="📌"
                title="Manual Pin design doesn’t scale"
                desc="Opening Canva for every URL burns time. You need direction, batch generation, and a queue — not another one-off canvas."
              />
              <PainCard
                icon="🧭"
                title="Blank prompts = weak Pins"
                desc="High-intent Pins follow recognizable creative types (gift guide, collage, how-to-style). Guessing layouts from scratch underperforms."
              />
              <PainCard
                icon="📆"
                title="Publishing is where momentum dies"
                desc="Generating files without OAuth, bulk post, and schedule still leaves you manually uploading. Shipping means publish + retry + write-back URLs."
              />
            </Grid>
            <Text size="small" tone="tertiary" style={{ textAlign: 'center' }}>
              [Dev note] Illustrations: neutral SaaS, not “home decor only”. Optional category tabs above cards.
            </Text>
          </Stack>
        </div>

        {/* ══════════════════════════════════════════════════ */}
        {/* SECTION 4 — HOW IT WORKS                         */}
        {/* ══════════════════════════════════════════════════ */}
        <div style={{ padding: '64px 40px', background: theme.fill.tertiary, margin: '0 -40px', borderTop: `1px solid ${theme.stroke.tertiary}`, borderBottom: `1px solid ${theme.stroke.tertiary}` }}>
          <Stack gap={32}>
            <Stack gap={8} style={{ textAlign: 'center', alignItems: 'center' }}>
              <SectionLabel>How it works</SectionLabel>
              <H2>Upload or link → directions → bulk Pins → publish</H2>
              <Text tone="secondary">PRD v3 flow — highlight Auto Mode + optional Reference (“Make one like this”).</Text>
            </Stack>
            <Grid columns={4} gap={0}>
              {[
                { n: 1, title: 'Upload or URL', desc: 'Product images or product links in bulk' },
                { n: 2, title: 'Understand product', desc: 'AI reads category, vibe, audience & use case' },
                { n: 3, title: 'Creative directions', desc: '3–5 Pin types recommended (Type Library)' },
                { n: 4, title: 'Choose path', desc: 'Auto generate or pick directions / reference' },
                { n: 5, title: 'Bulk Pin images', desc: '2:3 Pinterest-first outputs' },
                { n: 6, title: 'Copy + Boards', desc: 'Title, description, link, Board suggestions' },
                { n: 7, title: 'Preview & select', desc: 'Multi-select Pins to ship' },
                { n: 8, title: 'Publish / schedule', desc: 'OAuth · queue · daily limits · retry · URL write-back' },
              ].map((step, i, arr) => (
                <Stack key={step.n} gap={0} style={{ alignItems: 'center', position: 'relative' }}>
                  {i < arr.length - 1 && (
                    <div style={{
                      position: 'absolute', top: 14, left: '58%', right: '-12%',
                      height: 1, background: theme.stroke.secondary, zIndex: 0,
                    }} />
                  )}
                  <Stack gap={10} style={{ alignItems: 'center', textAlign: 'center', padding: '0 6px', zIndex: 1 }}>
                    <StepBadge n={step.n} />
                    <Text size="small" weight="semibold">{step.title}</Text>
                    <Text size="small" tone="secondary">{step.desc}</Text>
                  </Stack>
                </Stack>
              ))}
            </Grid>
            <Text size="small" tone="tertiary" style={{ textAlign: 'center' }}>
              [Dev note] Mobile: 2×4 or vertical stepper. Connector lines optional below md.
            </Text>
          </Stack>
        </div>

        {/* ══════════════════════════════════════════════════ */}
        {/* SECTION 5 — OUTPUT SHOWCASE                      */}
        {/* ══════════════════════════════════════════════════ */}
        <div style={{ padding: '64px 0', borderBottom: `1px solid ${theme.stroke.tertiary}` }}>
          <Stack gap={32}>
            <Stack gap={8} style={{ textAlign: 'center', alignItems: 'center' }}>
              <SectionLabel>What you get</SectionLabel>
              <H2>Pinterest-native Pins — generated, reviewed, shipped</H2>
              <Text tone="secondary" style={{ maxWidth: 640, textAlign: 'center' }}>
                Primary output is 2:3 Pins with SEO copy and Board suggestions. Bulk select, then publish or schedule. Instagram export stays P1 — not a headline here.
              </Text>
            </Stack>

            <Grid columns={3} gap={24}>
              {/* Pinterest — primary */}
              <div style={{ padding: '20px', borderRadius: 10, border: `2px solid ${theme.accent.primary}`, background: theme.fill.secondary }}>
                <Stack gap={12}>
                  <Row gap={8} align="center">
                    <Pill tone="success" size="sm">Pinterest · P0</Pill>
                    <Text size="small" tone="secondary">2:3 · feed native</Text>
                  </Row>
                  <div style={{ width: '100%', height: 220, borderRadius: 8, background: theme.fill.primary, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <Text size="small" tone="tertiary" style={{ fontSize: 10 }}>Replace: cat-specific high-save Pin</Text>
                  </div>
                  <Stack gap={4}>
                    <Text size="small" weight="semibold">Pin title + description + destination URL + keyword hints</Text>
                    <Text size="small" tone="secondary">Bulk publish &amp; scheduled slots · queue status · failed retry · published URL write-back</Text>
                  </Stack>
                </Stack>
              </div>

              {/* Second pin variant preview */}
              <div style={{ padding: '20px', borderRadius: 10, border: `1px solid ${theme.stroke.primary}` }}>
                <Stack gap={12}>
                  <Row gap={8} align="center">
                    <Pill tone="neutral" size="sm">Pin variant B</Pill>
                    <Text size="small" tone="secondary">Collage / moodboard</Text>
                  </Row>
                  <div style={{ width: '100%', height: 220, borderRadius: 8, background: theme.fill.tertiary, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <Text size="small" tone="tertiary" style={{ fontSize: 10 }}>Creative type from library</Text>
                  </div>
                  <Text size="small" tone="secondary">Users pick from 3–5 suggested directions or run Auto Mode end-to-end.</Text>
                </Stack>
              </div>

              {/* Instagram — P1 footnote */}
              <div style={{ padding: '20px', borderRadius: 10, border: `1px dashed ${theme.stroke.secondary}`, opacity: 0.85 }}>
                <Stack gap={12}>
                  <Row gap={8} align="center">
                    <Pill tone="neutral" size="sm">Instagram</Pill>
                    <Text size="small" tone="secondary">P1 · optional export</Text>
                  </Row>
                  <div style={{ width: '100%', height: 220, borderRadius: 8, background: theme.fill.tertiary, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <Text size="small" tone="tertiary" style={{ fontSize: 10 }}>1:1 crop or separate render — not MVP promise on landing</Text>
                  </div>
                  <Text size="small" tone="tertiary">No Shopping Tags narrative. Keep copy honest and Pinterest-first.</Text>
                </Stack>
              </div>
            </Grid>

            <Callout tone="neutral">
              [Dev note] Source 5+ real Pins across categories for this section. Lazy-load video/GIF optional. A/B: “Bulk schedule” chip above fold.
            </Callout>
          </Stack>
        </div>

        {/* ══════════════════════════════════════════════════ */}
        {/* SECTION 6 — SAVINGS CALCULATOR                   */}
        {/* ══════════════════════════════════════════════════ */}
        <div style={{ padding: '64px 0', borderBottom: `1px solid ${theme.stroke.tertiary}` }}>
          <Grid columns="1fr 1fr" gap={48} align="center">
            <Stack gap={12}>
              <SectionLabel>Time savings</SectionLabel>
              <H2>See how much time you save</H2>
              <Text tone="secondary">
                Every SKU or affiliate link you Pin manually stacks up — creative direction, renders, copy, and posting. VibePin compresses the loop so you spend time on products, not uploads.
              </Text>
              <Stack gap={6}>
                <Text size="small" weight="semibold">How many new products do you add per week?</Text>
                <Select
                  options={CALC_OPTIONS}
                  value={calcValue}
                  onChange={v => setCalcValue(v)}
                />
              </Stack>
              <Text size="small" tone="tertiary">
                [Dev note] 参考 Pin Generator 的 calculator 交互。可加第二个 Select "How many platforms?" (1/2) 增加参与感。
              </Text>
            </Stack>

            <div style={{ padding: '32px 28px', borderRadius: 12, border: `2px solid ${theme.accent.primary}`, background: theme.fill.secondary }}>
              <Stack gap={20}>
                <Text size="small" tone="secondary" style={{ textAlign: 'center' }}>With VibePin, you save</Text>
                <Stack gap={4} style={{ textAlign: 'center' }}>
                  <H1 style={{ fontSize: 56, lineHeight: 1, color: theme.accent.primary }}>
                    {savings.hoursPerMonth}+ hrs
                  </H1>
                  <Text tone="secondary">every month on product content creation</Text>
                </Stack>
                <Divider />
                <Grid columns={2} gap={12}>
                  <Stack gap={2} style={{ textAlign: 'center' }}>
                    <Text weight="bold" style={{ fontSize: 24 }}>{savings.daysPerYear}</Text>
                    <Text size="small" tone="secondary">working days saved per year</Text>
                  </Stack>
                  <Stack gap={2} style={{ textAlign: 'center' }}>
                    <Text weight="bold" style={{ fontSize: 24 }}>40 min</Text>
                    <Text size="small" tone="secondary">saved per product vs manual</Text>
                  </Stack>
                </Grid>
                <Button variant="primary" style={{ width: '100%' }}>Start Saving Time Free</Button>
              </Stack>
            </div>
          </Grid>
        </div>

        {/* ══════════════════════════════════════════════════ */}
        {/* SECTION 7 — FEATURES                             */}
        {/* ══════════════════════════════════════════════════ */}
        <div style={{ padding: '64px 0', borderBottom: `1px solid ${theme.stroke.tertiary}` }}>
          <Stack gap={32}>
            <Stack gap={8} style={{ textAlign: 'center', alignItems: 'center' }}>
              <SectionLabel>Features</SectionLabel>
              <H2>Everything to generate, select, and ship Pins</H2>
              <Text tone="secondary">AI Creative Strategy Engine + Pin Type Library — not a fixed prompt zoo. API-first image stack.</Text>
            </Stack>
            <Grid columns={4} gap={16}>
              {[
                { title: 'Upload + URL import', desc: 'Bring product photos or paste product links — including light bulk paste.' },
                { title: 'Auto creative directions', desc: '3–5 Pin types recommended from the Pin Creative Type Library per item.' },
                { title: 'Reference Mode', desc: '“Make one like this” learns layout, palette, and mood from your chosen example — not “copy viral.”' },
                { title: 'Bulk Pin generation', desc: 'Produce many 2:3 renders per batch; swap or regenerate per card.' },
                { title: 'Pin copy + Boards', desc: 'Title, description, destination link, keyword hints, Board suggestions.' },
                { title: 'Pinterest OAuth', desc: 'Connect when you are ready; scopes documented in PRD v3.' },
                { title: 'Bulk publish & schedule', desc: 'Queue, daily limits, retry, and published URL write-back.' },
                { title: 'Custom Prompt (advanced)', desc: 'Optional power mode — never the default hero path.' },
              ].map(({ title, desc }) => (
                <div key={title} style={{ padding: '16px', borderRadius: 8, border: `1px solid ${theme.stroke.primary}` }}>
                  <div style={{ width: 8, height: 8, borderRadius: '50%', background: theme.accent.primary, marginBottom: 10 }} />
                  <Text size="small" weight="semibold">{title}</Text>
                  <Text size="small" tone="secondary" style={{ marginTop: 6 }}>{desc}</Text>
                </div>
              ))}
            </Grid>
          </Stack>
        </div>

        {/* ══════════════════════════════════════════════════ */}
        {/* SECTION 8 — PRICING                              */}
        {/* ══════════════════════════════════════════════════ */}
        <div style={{ padding: '64px 0', borderBottom: `1px solid ${theme.stroke.tertiary}` }}>
          <Stack gap={32}>
            <Stack gap={8} style={{ textAlign: 'center', alignItems: 'center' }}>
              <SectionLabel>Pricing</SectionLabel>
              <H2>Credits for generation · plans for volume</H2>
              <Text tone="secondary">
                Align with PRD v3 hypothesis: bundle image + copy per credit; priced tiers may combine generation + publish slots — finalize with finance.
              </Text>
            </Stack>
            <Grid columns={4} gap={16}>
              <PricingCard
                plan="Free"
                price="$0"
                period=""
                desc="Prove value on live products."
                features={[
                  '~20 credits / cycle',
                  'Auto + Reference entry',
                  'Pinterest OAuth (limited queue)',
                  'Watermark or clarity cap (TBD)',
                ]}
                cta="Start free"
              />
              <PricingCard
                plan="Starter"
                price="$19"
                period="/ mo"
                desc="Solo creators shipping weekly."
                features={[
                  '~150 credits / month',
                  'Bulk publish & schedule',
                  'Daily limit controls',
                  'Failed retry + URL write-back',
                ]}
                highlighted
                cta="Choose Starter"
              />
              <PricingCard
                plan="Growth"
                price="$49"
                period="/ mo"
                desc="Higher batch volume."
                features={[
                  '~500 credits / month',
                  'Deeper queues & exports',
                  'Priority support',
                  'CSV workflows (roadmap)',
                ]}
                cta="Choose Growth"
              />
              <PricingCard
                plan="Pro"
                price="$99"
                period="/ mo"
                desc="Heavy Pin producers."
                features={[
                  '~1,200 credits / month',
                  'Early publish-suite features',
                  'Success touchpoint (later)',
                ]}
                cta="Talk to us"
              />
            </Grid>
            <Text size="small" tone="tertiary" style={{ textAlign: 'center' }}>
              [Dev note] Stripe meters TBD. Surface “credits = Pin image + copy bundle” tooltip near pricing.
            </Text>
          </Stack>
        </div>

        {/* ══════════════════════════════════════════════════ */}
        {/* SECTION 9 — FAQ                                  */}
        {/* ══════════════════════════════════════════════════ */}
        <div style={{ padding: '64px 0', borderBottom: `1px solid ${theme.stroke.tertiary}` }}>
          <Grid columns="1fr 2fr" gap={48}>
            <Stack gap={8}>
              <SectionLabel>FAQ</SectionLabel>
              <H2>Questions creators ask before upgrading</H2>
              <Text tone="secondary">Can't find an answer? Email hello@socialflow.ai</Text>
            </Stack>
            <Stack gap={8}>
              <FaqItem
                q="Do I need design skills?"
                a="No. Upload a product photo or paste a link. The AI Creative Strategy Engine proposes Pin directions; you can run Auto Mode or pick types. Reference Mode powers the “Make one like this” path."
              />
              <FaqItem
                q="Is this only for home decor?"
                a="No. Fashion, beauty, jewelry, digital goods, Etsy handmade, and small Shopify catalogs are all in-scope. Homepage examples intentionally span categories."
              />
              <FaqItem
                q="Do you rely on fixed prompts?"
                a="Operators maintain a Pin Creative Type Library (gift guide, collage, etc.), but user-facing prompts are assembled dynamically per product analysis — plus optional custom prompt for experts."
              />
              <FaqItem
                q="Can I bulk publish or schedule Pins?"
                a="Yes — that’s P0 in PRD v3. After OAuth you can bulk publish selections, assign Board targets, schedule by time, honor daily limits, retry failures, and store published Pin URLs."
              />
              <FaqItem
                q="Is Instagram included?"
                a="Instagram export is secondary (P1). The landing narrative stays Pinterest-first; don’t imply feed posting parity."
              />
              <FaqItem
                q="Will you fake discounts in my Pins?"
                a="No. High-converting rules forbid fake discounts unless you supply compliant offer copy."
              />
              <FaqItem
                q="What integrations exist for Shopify/Etsy?"
                a="URLs work today; dedicated Shopify App and deeper Etsy flows are roadmap (P1). Say so plainly if not shipped."
              />
            </Stack>
          </Grid>
        </div>

        {/* ══════════════════════════════════════════════════ */}
        {/* SECTION 10 — FINAL CTA                           */}
        {/* ══════════════════════════════════════════════════ */}
        <div style={{ padding: '80px 0', textAlign: 'center' }}>
          <Stack gap={20} style={{ alignItems: 'center' }}>
            <H2 style={{ fontSize: 32 }}>
              Ready to ship Pins on autopilot?
            </H2>
            <Text tone="secondary" style={{ maxWidth: 520, textAlign: 'center', fontSize: 16 }}>
              Upload assets or paste URLs, approve your batch, then let VibePin handle Pinterest publishing and schedules — Fashion to digital and everything between.
            </Text>
            <Row gap={12} align="center">
              <Button variant="primary">Generate Pins</Button>
              <Button variant="ghost">View examples</Button>
            </Row>
            <Text size="small" tone="tertiary">Credits-based · Pinterest OAuth when you publish</Text>
          </Stack>
          <Text size="small" tone="tertiary" style={{ marginTop: 20 }}>
            [Dev note] 背景可用浅暖灰 section，品牌主色 CTA 按钮。可加少量 grid 背景纹理（无颜色，仅 stroke.tertiary 线）。
          </Text>
        </div>

        {/* ══════════════════════════════════════════════════ */}
        {/* FOOTER                                            */}
        {/* ══════════════════════════════════════════════════ */}
        <div style={{ padding: '32px 0', borderTop: `1px solid ${theme.stroke.tertiary}` }}>
          <Grid columns={4} gap={24}>
            <Stack gap={8}>
              <Row gap={8} align="center">
                <div style={{ width: 20, height: 20, borderRadius: 4, background: theme.accent.primary }} />
                <Text weight="semibold">VibePin</Text>
              </Row>
              <Text size="small" tone="secondary">AI Pinterest Pin generator & scheduler for product creators.</Text>
            </Stack>
            <Stack gap={8}>
              <Text size="small" weight="semibold">Product</Text>
              {['Features', 'Pricing', 'FAQ', 'Changelog'].map(item => (
                <Text key={item} size="small" tone="secondary">{item}</Text>
              ))}
            </Stack>
            <Stack gap={8}>
              <Text size="small" weight="semibold">Resources</Text>
              {['Blog', 'Pinterest Guide', 'Pin Type Library spec', 'Help Center'].map(item => (
                <Text key={item} size="small" tone="secondary">{item}</Text>
              ))}
            </Stack>
            <Stack gap={8}>
              <Text size="small" weight="semibold">Legal</Text>
              {['Privacy Policy', 'Terms of Service', 'Cookie Policy'].map(item => (
                <Text key={item} size="small" tone="secondary">{item}</Text>
              ))}
            </Stack>
          </Grid>
          <Divider style={{ margin: '24px 0' }} />
          <Row justify="space-between" align="center">
            <Text size="small" tone="tertiary">© 2026 VibePin. All rights reserved.</Text>
            <Text size="small" tone="tertiary">Bulk-ready · OAuth when you publish</Text>
          </Row>
        </div>

      </Stack>

      {/* ── DEV NOTES SUMMARY ──────────────────────────────── */}
      <div style={{ margin: '0 40px 40px', padding: '20px 24px', borderRadius: 8, border: `1px solid ${theme.stroke.secondary}`, background: theme.fill.tertiary }}>
        <H3>Dev Notes Summary</H3>
        <Grid columns={2} gap={16} style={{ marginTop: 12 }}>
          <Stack gap={6}>
            <Text size="small" weight="semibold">色彩规格</Text>
            <Text size="small" tone="secondary">背景：白色 / 米白 #FAF9F7（section alternation）</Text>
            <Text size="small" tone="secondary">主色：建议青绿 #00B08A 或暖橙 #F5824A（待确认品牌色）</Text>
            <Text size="small" tone="secondary">文字：#1A1A1A（标题）/ #6B7280（正文）/ #9CA3AF（辅助）</Text>
          </Stack>
          <Stack gap={6}>
            <Text size="small" weight="semibold">技术选型建议</Text>
            <Text size="small" tone="secondary">框架：Next.js 15 App Router · Tailwind CSS · Framer Motion（动效）</Text>
            <Text size="small" tone="secondary">字体：Inter 或 Geist（现代无衬线，适合 SaaS 工具）</Text>
            <Text size="small" tone="secondary">分析：Vercel Analytics + PostHog（hero URL input 转化漏斗必追踪）</Text>
          </Stack>
          <Stack gap={6}>
            <Text size="small" weight="semibold">必须在上线前准备</Text>
            <Text size="small" tone="secondary">· 5 条以上真实高质 Pin 预览（Fashion · Beauty · Home · Jewelry · Digital）+ “Make one like this” 链路验收</Text>
            <Text size="small" tone="secondary">· Pinterest OAuth + 沙盒账号跑通 bulk publish / schedule / retry / URL write-back</Text>
            <Text size="small" tone="secondary">· Credits 与发布额度文案与计费一致（法务审折扣与功效表述）</Text>
          </Stack>
          <Stack gap={6}>
            <Text size="small" weight="semibold">转化优化 A/B 测试项</Text>
            <Text size="small" tone="secondary">· Hero：“Any product” vs category carousel 首帧</Text>
            <Text size="small" tone="secondary">· CTA：“Generate Pins” vs “Start scheduling”</Text>
            <Text size="small" tone="secondary">· 定价：突出 Starter vs Pro（按批次卖家画像）</Text>
          </Stack>
        </Grid>
      </div>

    </Stack>
  );
}
