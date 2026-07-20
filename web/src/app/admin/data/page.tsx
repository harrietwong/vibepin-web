import { redirect } from "next/navigation";
import { AlertTriangle, Boxes, CalendarDays, Database, ImageIcon, Lock, ShieldCheck } from "lucide-react";
import { getCurrentSuperAdmin } from "@/lib/server/superAdmin";
import { getDataFreshness } from "@/lib/server/dataFreshness";
import { getDailyCrawlActivity, type LatestPin, type LatestProduct } from "@/lib/server/dailyCrawlActivity";
import type { FreshnessStatus } from "@/lib/server/productOpportunityAdminStatus";
import { AdminT } from "../AdminT";
import type { AdminMessageKey } from "@/lib/admin/adminMessages";

export const dynamic = "force-dynamic";

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(t));
}

function fmtNum(v: number | null | undefined): string {
  return v === null || v === undefined ? "—" : v.toLocaleString();
}

function Card({ icon: Icon, title, right, children }: { icon: React.ComponentType<{ className?: string }>; title: React.ReactNode; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border" style={{ background: "var(--admin-surface, #FFFFFF)", borderColor: "var(--admin-border, #E5E7EB)" }}>
      <div className="flex items-center justify-between gap-3 border-b px-4 py-3" style={{ borderColor: "var(--admin-border, #E5E7EB)" }}>
        <div className="flex items-center gap-2">
          <Icon className="h-4 w-4 text-gray-500" />
          <h2 className="text-[14px] font-black text-gray-950">{title}</h2>
        </div>
        {right}
      </div>
      {children}
    </section>
  );
}

function StatTile({ label, value, tone }: { label: React.ReactNode; value: string | number; tone?: "danger" | "muted" }) {
  const color = tone === "danger" ? "var(--admin-danger, #B91C1C)" : tone === "muted" ? "var(--admin-text-muted, #9CA3AF)" : "var(--admin-text, #030712)";
  return (
    <div className="rounded-lg border px-4 py-3" style={{ background: "var(--admin-surface-2, #F9FAFB)", borderColor: "var(--admin-border-soft, #EEF0F3)" }}>
      <p className="text-[11px] font-bold uppercase text-gray-400">{label}</p>
      <p className="mt-1 text-[20px] font-black" style={{ color }}>{value}</p>
    </div>
  );
}

function Grid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-2 gap-3 p-4 md:grid-cols-3 xl:grid-cols-5">{children}</div>;
}

function DefinitionGrid({ rows }: { rows: Array<[string, string]> }) {
  return (
    <dl className="grid grid-cols-1 gap-px text-[13px] sm:grid-cols-2" style={{ background: "var(--admin-border, #E5E7EB)" }}>
      {rows.map(([label, value]) => (
        <div key={label} className="px-4 py-3" style={{ background: "var(--admin-surface, #FFFFFF)" }}>
          <dt className="text-[11px] font-bold uppercase" style={{ color: "var(--admin-text-secondary, #6B7280)" }}>{label}</dt>
          <dd className="mt-1 font-semibold" style={{ color: "var(--admin-text, #111827)" }}>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

const TONE: Record<FreshnessStatus, { bg: string; fg: string; key: AdminMessageKey }> = {
  fresh: { bg: "rgba(16,185,129,0.12)", fg: "#047857", key: "status.fresh" },
  stale: { bg: "rgba(245,158,11,0.13)", fg: "#B45309", key: "status.stale" },
  unknown: { bg: "rgba(107,114,128,0.10)", fg: "#4B5563", key: "status.unknown" },
};

function StatusBadge({ status }: { status: FreshnessStatus }) {
  const tone = TONE[status];
  return <span className="rounded-full px-2.5 py-1 text-[11px] font-black uppercase" style={{ background: tone.bg, color: tone.fg }}><AdminT k={tone.key} /></span>;
}

// ── Daily crawl output — image evidence strips ────────────────────────────────

function fmtShortDate(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(t));
}

function ImageStrip({ items }: {
  items: Array<{ key: string; imageUrl: string; caption: string; sub: string; href: string | null }>;
}) {
  if (!items.length) return <p className="px-4 py-4 text-[12px] text-gray-400">No images yet.</p>;
  return (
    <div className="flex gap-2.5 overflow-x-auto px-4 py-3">
      {items.map(it => {
        const body = (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={it.imageUrl} alt={it.caption} loading="lazy"
              className="h-[150px] w-[100px] rounded-lg border object-cover"
              style={{ borderColor: "var(--admin-border, #E5E7EB)" }} />
            <p className="mt-1 w-[100px] truncate text-[10px] font-semibold text-gray-700" title={it.caption}>{it.caption}</p>
            <p className="w-[100px] truncate text-[9px] text-gray-400" title={it.sub}>{it.sub}</p>
          </>
        );
        return it.href ? (
          <a key={it.key} href={it.href} target="_blank" rel="noopener noreferrer" className="shrink-0 no-underline">{body}</a>
        ) : (
          <div key={it.key} className="shrink-0">{body}</div>
        );
      })}
    </div>
  );
}

function pinStripItems(pins: LatestPin[]) {
  return pins.map(p => ({
    key: p.id,
    imageUrl: p.image_url,
    caption: (p.title ?? "").trim() || p.source_keyword || p.seed_keyword || "Untitled",
    sub: `${(p.save_count ?? 0).toLocaleString()} saves · ${p.source_keyword ?? p.seed_keyword ?? p.category ?? ""} · ${fmtShortDate(p.scraped_at)}`,
    href: null,
  }));
}

function productStripItems(products: LatestProduct[]) {
  return products.map(p => ({
    key: p.id,
    imageUrl: p.image_url,
    // product_name is nullable (v47) and NULL exactly when the merchant page could
    // not be read. Do NOT let seed_keyword (a discovery seed, not a product name) or
    // a fabricated "Product" impersonate the name — that is the T10 disease. Show an
    // explicit status that plainly is NOT a product name; the seed keyword still shows
    // truthfully in the sub-line below.
    caption: (p.product_name ?? "").trim() || "Name unavailable",
    sub: `${((p.save_count || p.source_pin_save_count) ?? 0).toLocaleString()} saves · ${p.seed_keyword ?? ""} · ${fmtShortDate(p.created_at)}`,
    href: null,
  }));
}

export default async function AdminDataPage() {
  const admin = await getCurrentSuperAdmin();
  if (!admin) redirect("/app?admin=forbidden");

  const [d, daily] = await Promise.all([getDataFreshness(), getDailyCrawlActivity(7)]);
  const { inventory, samples, products, productCoverage, scores, visualReview, quality } = d;

  return (
    <main className="h-full overflow-y-auto" style={{ background: "var(--admin-bg, #F8FAFC)", color: "var(--admin-text, #111827)" }}>
      <div className="mx-auto max-w-[1180px] px-6 py-7">
        {/* Header */}
        <div className="mb-5">
          <div className="mb-2 inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[11px] font-bold" style={{ background: "var(--admin-surface, #FFFFFF)", borderColor: "var(--admin-border, #E5E7EB)", color: "var(--admin-text-secondary, #4B5563)" }}>
            <Lock className="h-3.5 w-3.5" />
            <AdminT k="data.badge" />
          </div>
          <h1 className="text-[25px] font-black tracking-tight text-gray-950"><AdminT k="data.title" /></h1>
          <p className="mt-1 text-[13px] text-gray-500"><AdminT k="data.subtitle" /></p>
        </div>

        {d.warnings.length > 0 && (
          <div className="mb-5 rounded-lg border px-4 py-3 text-[11.5px] text-gray-500" style={{ background: "var(--admin-surface, #FFFFFF)", borderColor: "var(--admin-border, #E5E7EB)" }}>
            {d.warnings.map((w, i) => <p key={i}>· {w}</p>)}
          </div>
        )}

        <div className="flex flex-col gap-5">
          {/* Daily crawl activity — what the pipeline produced each day (UTC) */}
          <Card icon={CalendarDays} title="Daily crawl activity (last 7 days · UTC)">
            <div className="overflow-x-auto">
              <table className="w-full text-[12.5px]">
                <thead>
                  <tr className="border-b text-left" style={{ borderColor: "var(--admin-border, #E5E7EB)" }}>
                    {["Date", "Trend keywords updated", "Pins scraped", "Products added", "Save snapshots"].map(h => (
                      <th key={h} className="px-4 py-2.5 text-[11px] font-bold uppercase text-gray-400">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {daily.days.map(row => {
                    const idle = !row.pinsScraped && !row.productsAdded && !row.trendKeywordsUpdated && !row.saveSnapshots;
                    return (
                      <tr key={row.date} className="border-b last:border-0" style={{ borderColor: "var(--admin-border-soft, #EEF0F3)", opacity: idle ? 0.55 : 1 }}>
                        <td className="px-4 py-2.5 font-mono text-[12px] font-semibold text-gray-700">{row.date}</td>
                        <td className="px-4 py-2.5 font-semibold tabular-nums">{fmtNum(row.trendKeywordsUpdated)}</td>
                        <td className="px-4 py-2.5 font-semibold tabular-nums">{fmtNum(row.pinsScraped)}</td>
                        <td className="px-4 py-2.5 font-semibold tabular-nums">{fmtNum(row.productsAdded)}</td>
                        <td className="px-4 py-2.5 font-semibold tabular-nums">
                          {daily.snapshotsAvailable ? fmtNum(row.saveSnapshots) : "n/a"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="px-4 py-2 text-[11px] text-gray-400">
              Pins = pin_samples.scraped_at · Products = pin_products.created_at · Trend keywords = trend_keywords.last_updated_at ·
              Save snapshots = pin_save_snapshots.captured_on (one per pin per day, migrate_v37).
            </p>
            {daily.warnings.map((w, i) => (
              <p key={i} className="flex items-center gap-2 px-4 pb-3 text-[12px] text-gray-400"><AlertTriangle className="h-3.5 w-3.5 text-amber-500" /> {w}</p>
            ))}
          </Card>

          {/* Latest crawl output — image evidence */}
          <Card icon={ImageIcon} title="Latest crawled pins">
            <ImageStrip items={pinStripItems(daily.latestPins)} />
            <p className="px-4 pb-3 text-[11px] text-gray-400">Newest pin_samples by scraped_at (with image).</p>
          </Card>
          <Card icon={ImageIcon} title="Latest new products">
            <ImageStrip items={productStripItems(daily.latestProducts)} />
            <p className="px-4 pb-3 text-[11px] text-gray-400">Newest pin_products by created_at (with image).</p>
          </Card>

          {/* Inventory */}
          <Card icon={Boxes} title={<AdminT k="data.inventory.title" />}>
            <Grid>
              <StatTile label="pin_samples" value={fmtNum(inventory.pinSamples)} />
              <StatTile label="pin_products" value={fmtNum(inventory.pinProducts)} />
              <StatTile label="product_scores" value={fmtNum(inventory.productScores)} />
              <StatTile label="visual_asset_reviews" value={inventory.visualReviewsAvailable ? fmtNum(inventory.visualReviews) : "n/a"} tone={inventory.visualReviewsAvailable ? undefined : "muted"} />
              <StatTile label="product_ideas" value={inventory.productIdeasAvailable ? fmtNum(inventory.productIdeas) : "n/a"} tone={inventory.productIdeasAvailable ? undefined : "muted"} />
            </Grid>
          </Card>

          {/* pin_samples freshness */}
          <Card icon={Database} title="pin_samples freshness" right={<StatusBadge status={samples.status} />}>
            {samples.available ? (
              <>
                <Grid>
                  <StatTile label={<AdminT k="stat.created24h" />} value={fmtNum(samples.last24h)} />
                  <StatTile label={<AdminT k="stat.created48h" />} value={fmtNum(samples.last48h)} />
                  <StatTile label={<AdminT k="stat.created5d" />} value={fmtNum(samples.last5d)} />
                  <StatTile label="Missing image_url" value={fmtNum(samples.missingImageUrl)} tone={(samples.missingImageUrl ?? 0) > 0 ? "danger" : undefined} />
                  <StatTile label={<AdminT k="stat.total" />} value={fmtNum(inventory.pinSamples)} />
                </Grid>
                <DefinitionGrid rows={[
                  ["Latest pin_samples.scraped_at", fmtDate(samples.latestScrapedAt)],
                  ["Latest pin_samples.created_at_source", fmtDate(samples.latestCreatedAtSource)],
                ]} />
                <p className="px-4 py-2 text-[11px] text-gray-400">pin_samples has no created_at column — scraped_at is the ingestion clock (used for the windows above).</p>
              </>
            ) : (
              <div className="flex items-center gap-2 px-4 py-4 text-[12.5px] text-gray-400"><AlertTriangle className="h-3.5 w-3.5 text-amber-500" /> pin_samples not available.</div>
            )}
          </Card>

          {/* pin_products freshness */}
          <Card icon={Database} title="pin_products freshness" right={<StatusBadge status={products.status} />}>
            <Grid>
              <StatTile label={<AdminT k="stat.created24h" />} value={fmtNum(products.last24h)} />
              <StatTile label={<AdminT k="stat.created48h" />} value={fmtNum(products.last48h)} />
              <StatTile label={<AdminT k="stat.created5d" />} value={fmtNum(products.last5d)} />
              <StatTile label="Missing image_url" value={fmtNum(products.missingImageUrl)} tone={(products.missingImageUrl ?? 0) > 0 ? "danger" : undefined} />
              <StatTile label={<AdminT k="stat.total" />} value={fmtNum(inventory.pinProducts)} />
            </Grid>
            <DefinitionGrid rows={[
              ["Latest pin_products.created_at", fmtDate(products.latestCreatedAt)],
              ["Latest pin_products.scraped_at", fmtDate(products.latestScrapedAt)],
            ]} />
            <p className="px-4 py-2 text-[11px] font-semibold text-emerald-700">
              This is the Product Opportunity v1 readiness signal — Product Opportunity reads pin_products directly, not product_scores.
            </p>
          </Card>

          {/* Product Opportunity coverage (pin_products only) */}
          <Card icon={Boxes} title="Product Opportunity coverage (pin_products)">
            <Grid>
              <StatTile label="With product URL" value={fmtNum((inventory.pinProducts ?? 0) - (productCoverage.missingProductUrl ?? 0))} />
              <StatTile label="Missing product URL" value={fmtNum(productCoverage.missingProductUrl)} tone={(productCoverage.missingProductUrl ?? 0) > 0 ? "danger" : undefined} />
              <StatTile label="With product saves" value={fmtNum(productCoverage.withProductSaves)} />
              <StatTile label="With source-Pin saves" value={fmtNum(productCoverage.withSourcePinSaves)} />
              <StatTile label="Without category" value={fmtNum(productCoverage.withoutCategory)} tone={(productCoverage.withoutCategory ?? 0) > 0 ? "muted" : undefined} />
            </Grid>
            <p className="px-4 py-2 text-[11px] text-gray-400">Readiness = enough pin_products rows with an image, a product URL, and save evidence. Scoring is not part of this check.</p>
          </Card>

          {/* product_scores freshness — OPTIONAL / not required for Product Opportunity */}
          <Card icon={Database} title="product_scores freshness (optional)" right={<StatusBadge status={scores.status} />}>
            <p className="px-4 pt-3 text-[12px] font-semibold text-gray-600">
              Product scoring is currently not required for Product Opportunity v1. A STALE status here does not block Product Opportunity.
            </p>
            <DefinitionGrid rows={[
              ["Total product_scores rows", fmtNum(scores.total)],
              ["Latest product_scores.scored_at", fmtDate(scores.latestScoredAt)],
              ["Latest product_scores.updated_at", scores.updatedAtAvailable ? fmtDate(scores.latestUpdatedAt) : "n/a (no updated_at column — scored_at used)"],
              ["Fresh threshold", "48 hours"],
            ]} />
          </Card>

          {/* Visual Review counters */}
          <Card icon={ImageIcon} title={<AdminT k="data.visualReview.title" />}>
            {visualReview.available ? (
              <Grid>
                <StatTile label="Reviewed" value={fmtNum(visualReview.reviewed)} />
                <StatTile label="Unreviewed" value={fmtNum(visualReview.unreviewed)} />
                <StatTile label="PASS" value={fmtNum(visualReview.pass)} />
                <StatTile label="REVIEW" value={fmtNum(visualReview.review)} />
                <StatTile label="REJECT" value={fmtNum(visualReview.reject)} tone={(visualReview.reject ?? 0) > 0 ? "danger" : undefined} />
              </Grid>
            ) : (
              <>
                <Grid>
                  <StatTile label="Reviewed" value="n/a" tone="muted" />
                  <StatTile label="Unreviewed (candidates)" value={fmtNum(visualReview.unreviewed)} />
                  <StatTile label="PASS" value="n/a" tone="muted" />
                  <StatTile label="REVIEW" value="n/a" tone="muted" />
                  <StatTile label="REJECT" value="n/a" tone="muted" />
                </Grid>
                <div className="flex items-center gap-2 px-4 pb-3 text-[12px] text-gray-400"><AlertTriangle className="h-3.5 w-3.5 text-amber-500" /> visual_asset_reviews table not found — apply migration v31.</div>
              </>
            )}
            {visualReview.available && (
              <p className="px-4 py-2 text-[11px] text-gray-400">Latest reviewed {fmtDate(visualReview.latestUpdatedAt)} · unreviewed = candidate images minus reviewed (estimate).</p>
            )}
          </Card>

          {/* Quality counters */}
          <Card icon={ShieldCheck} title={<AdminT k="data.quality.title" />}>
            <Grid>
              <StatTile label="Missing image (samples)" value={fmtNum(quality.missingImageSamples)} tone={(quality.missingImageSamples ?? 0) > 0 ? "danger" : undefined} />
              <StatTile label="Missing image (products)" value={fmtNum(quality.missingImageProducts)} tone={(quality.missingImageProducts ?? 0) > 0 ? "danger" : undefined} />
              <StatTile label="Broken image" value="n/a" tone="muted" />
              <StatTile label="Duplicate clusters" value="n/a" tone="muted" />
              <StatTile label="Reviewed / unreviewed" value={`${fmtNum(visualReview.reviewed ?? 0)} / ${fmtNum(visualReview.unreviewed)}`} />
            </Grid>
            <p className="px-4 py-2 text-[11px] text-gray-400">Broken-image and duplicate-cluster counters are not instrumented in v0.</p>
          </Card>
        </div>

        <div className="mt-5 inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-[12px] font-semibold" style={{ background: "var(--admin-surface, #FFFFFF)", borderColor: "var(--admin-border, #E5E7EB)", color: "var(--admin-text-secondary, #6B7280)" }}>
          <ShieldCheck className="h-4 w-4 text-emerald-600" />
          <AdminT k="data.footer" />
        </div>
      </div>
    </main>
  );
}
