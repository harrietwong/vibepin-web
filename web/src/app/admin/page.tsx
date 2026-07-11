import { redirect } from "next/navigation";
import {
  AlertTriangle,
  Boxes,
  Database,
  ImageIcon,
  Lock,
  ShieldCheck,
  Sparkles,
  Users,
  Workflow,
} from "lucide-react";
import { getCurrentSuperAdmin } from "@/lib/server/superAdmin";
import { getAdminOverview, type AdminOverview, type OverallFreshness } from "@/lib/server/adminOverview";
import type { FreshnessStatus } from "@/lib/server/productOpportunityAdminStatus";

export const dynamic = "force-dynamic";

// ── formatters ───────────────────────────────────────────────────────────────

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(t));
}

function fmtRelative(iso: string | null): string {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const diff = Date.now() - t;
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

function fmtNum(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return value.toLocaleString();
}

// ── presentational pieces ──────────────────────────────────────────────────

function Card({
  icon: Icon,
  title,
  right,
  id,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  right?: React.ReactNode;
  id?: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-6 rounded-xl border" style={{ background: "#FFFFFF", borderColor: "#E5E7EB" }}>
      <div className="flex items-center justify-between gap-3 border-b px-4 py-3" style={{ borderColor: "#E5E7EB" }}>
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

function StatTile({ label, value, tone }: { label: string; value: string | number; tone?: "danger" | "muted" }) {
  const color = tone === "danger" ? "#B91C1C" : tone === "muted" ? "#9CA3AF" : "#030712";
  return (
    <div className="rounded-lg border px-4 py-3" style={{ background: "#F9FAFB", borderColor: "#EEF0F3" }}>
      <p className="text-[11px] font-bold uppercase text-gray-400">{label}</p>
      <p className="mt-1 text-[20px] font-black" style={{ color }}>{value}</p>
    </div>
  );
}

function StatGrid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-2 gap-3 p-4 md:grid-cols-3 xl:grid-cols-5">{children}</div>;
}

function DefinitionGrid({ rows }: { rows: Array<[string, string]> }) {
  return (
    <dl className="grid grid-cols-1 gap-px text-[13px] sm:grid-cols-2" style={{ background: "#E5E7EB" }}>
      {rows.map(([label, value]) => (
        <div key={label} className="px-4 py-3" style={{ background: "#FFFFFF" }}>
          <dt className="text-[11px] font-bold uppercase" style={{ color: "#6B7280" }}>{label}</dt>
          <dd className="mt-1 font-semibold" style={{ color: "#111827" }}>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Unavailable({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 px-4 py-3 text-[12px] font-semibold text-gray-400">
      <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
      {children}
    </div>
  );
}

const FRESH_TONE: Record<OverallFreshness, { bg: string; fg: string; border: string; label: string }> = {
  fresh: { bg: "rgba(16,185,129,0.12)", fg: "#047857", border: "rgba(16,185,129,0.28)", label: "FRESH" },
  warning: { bg: "rgba(245,158,11,0.13)", fg: "#B45309", border: "rgba(245,158,11,0.32)", label: "WARNING" },
  stale: { bg: "rgba(239,68,68,0.12)", fg: "#B91C1C", border: "rgba(239,68,68,0.30)", label: "STALE" },
  unknown: { bg: "rgba(107,114,128,0.10)", fg: "#4B5563", border: "rgba(107,114,128,0.24)", label: "UNKNOWN" },
};

function FreshnessBadge({ status }: { status: OverallFreshness }) {
  const tone = FRESH_TONE[status];
  return (
    <span
      className="inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-black uppercase"
      style={{ background: tone.bg, borderColor: tone.border, color: tone.fg }}
    >
      {tone.label}
    </span>
  );
}

function SubStatusBadge({ status }: { status: FreshnessStatus }) {
  const map: Record<FreshnessStatus, OverallFreshness> = { fresh: "fresh", stale: "stale", unknown: "unknown" };
  return <FreshnessBadge status={map[status]} />;
}

function HealthPill({ overview }: { overview: AdminOverview }) {
  const failing =
    (overview.generation.failedToday ?? 0) > 0 ||
    overview.jobs.runs.some(r => r.status === "failed" || r.status === "error") ||
    overview.errors.items.length > 0;
  const stale = overview.freshness.overall === "stale";
  const status: OverallFreshness = stale ? "stale" : failing ? "warning" : overview.freshness.overall === "unknown" ? "unknown" : "fresh";
  const tone = FRESH_TONE[status];
  const label = status === "fresh" ? "HEALTHY" : status === "warning" ? "NEEDS ATTENTION" : status === "stale" ? "STALE DATA" : "UNKNOWN";
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px] font-black uppercase"
      style={{ background: tone.bg, borderColor: tone.border, color: tone.fg }}
    >
      <ShieldCheck className="h-3.5 w-3.5" />
      {label}
    </span>
  );
}

// ── page ─────────────────────────────────────────────────────────────────────

export default async function AdminHomePage() {
  const admin = await getCurrentSuperAdmin();
  if (!admin) redirect("/app?admin=forbidden");

  const overview = await getAdminOverview();
  const { users, generation, inventory, freshness, visualReview, jobs, errors } = overview;

  return (
    <main className="h-full overflow-y-auto" style={{ background: "#F8FAFC", color: "#111827" }}>
      <div className="mx-auto max-w-[1180px] px-6 py-7">
        {/* Header */}
        <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="mb-2 inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[11px] font-bold" style={{ background: "#FFFFFF", borderColor: "#E5E7EB", color: "#4B5563" }}>
              <Lock className="h-3.5 w-3.5" />
              Super Admin only · Internal
            </div>
            <h1 className="text-[25px] font-black tracking-tight text-gray-950">Admin Home</h1>
            <p className="mt-1 text-[13px] text-gray-500">
              Read-only system overview for founder / support / data ops. &ldquo;Today&rdquo; = since {fmtDate(overview.sinceToday)} UTC.
            </p>
          </div>
          <div className="flex flex-col items-end gap-2">
            <HealthPill overview={overview} />
            <span className="text-[11px] text-gray-400">Snapshot {fmtRelative(overview.generatedAt)}</span>
          </div>
        </div>

        {/* Global warnings */}
        {overview.warnings.length > 0 && (
          <div className="mb-5 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
              <div>
                <p className="text-[13px] font-bold text-amber-900">{overview.warnings.length} degraded / unavailable source{overview.warnings.length === 1 ? "" : "s"}</p>
                <ul className="mt-1 space-y-0.5">
                  {overview.warnings.map((w, i) => (
                    <li key={i} className="text-[12px] text-amber-800">· {w}</li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        )}

        <div className="flex flex-col gap-5">
          {/* 1. Users / Usage */}
          <Card icon={Users} title="Users / Usage">
            {users.available ? (
              <StatGrid>
                <StatTile label="Total users" value={fmtNum(users.totalUsers)} />
                <StatTile label="Active today" value={fmtNum(users.activeToday)} />
                <StatTile label="New today" value={fmtNum(users.newToday)} />
                <StatTile label="Total workspaces" value={users.workspacesAvailable ? fmtNum(users.totalWorkspaces) : "n/a"} tone={users.workspacesAvailable ? undefined : "muted"} />
                <StatTile label="Active workspaces today" value={users.workspacesAvailable ? fmtNum(users.activeWorkspacesToday) : "n/a"} tone={users.workspacesAvailable ? undefined : "muted"} />
              </StatGrid>
            ) : (
              <Unavailable>User metrics unavailable — a Supabase service-role key is required to list auth users.</Unavailable>
            )}
            {users.available && !users.workspacesAvailable && (
              <p className="px-4 pb-3 text-[11px] text-gray-400">No <code>workspaces</code> table in this schema yet — workspace metrics show once one exists.</p>
            )}
          </Card>

          {/* 2. Generation */}
          <Card
            icon={Sparkles}
            title="Generation (AI)"
            right={
              generation.available && generation.statusAvailable ? (
                <span className="text-[12px] font-bold" style={{ color: (generation.failedToday ?? 0) > 0 ? "#B91C1C" : "#047857" }}>
                  {generation.failureRatePct ?? 0}% failures today
                </span>
              ) : undefined
            }
          >
            {generation.available ? (
              <>
                <StatGrid>
                  <StatTile label="Generations today" value={fmtNum(generation.today)} />
                  <StatTile label="Successful today" value={generation.statusAvailable ? fmtNum(generation.successToday) : "n/a"} tone={generation.statusAvailable ? undefined : "muted"} />
                  <StatTile label="Failed today" value={generation.statusAvailable ? fmtNum(generation.failedToday) : "n/a"} tone={(generation.failedToday ?? 0) > 0 ? "danger" : generation.statusAvailable ? undefined : "muted"} />
                  <StatTile label="Failure rate" value={generation.statusAvailable ? `${generation.failureRatePct ?? 0}%` : "n/a"} tone={generation.statusAvailable ? undefined : "muted"} />
                  <StatTile label="Latest generation" value={fmtRelative(generation.latestCreatedAt)} />
                </StatGrid>
                {!generation.statusAvailable && (
                  <p className="px-4 pb-3 text-[11px] text-gray-400">Success/failure split needs the <code>pin_generations.status</code> column.</p>
                )}
              </>
            ) : (
              <Unavailable>Generation metrics unavailable — <code>pin_generations</code> table not found.</Unavailable>
            )}
          </Card>

          {/* 3. Data Inventory */}
          <Card icon={Boxes} title="Data Inventory">
            <StatGrid>
              <StatTile label="pin_samples" value={fmtNum(inventory.pinSamples)} />
              <StatTile label="pin_products" value={fmtNum(inventory.pinProducts)} />
              <StatTile label="product_scores" value={fmtNum(inventory.productScores)} />
              <StatTile label="product_ideas" value={inventory.productIdeasAvailable ? fmtNum(inventory.productIdeas) : "n/a"} tone={inventory.productIdeasAvailable ? undefined : "muted"} />
              <StatTile label="visual_asset_reviews" value={inventory.visualReviewsAvailable ? fmtNum(inventory.visualReviews) : "n/a"} tone={inventory.visualReviewsAvailable ? undefined : "muted"} />
            </StatGrid>
            {(!inventory.productIdeasAvailable || !inventory.visualReviewsAvailable) && (
              <p className="px-4 pb-3 text-[11px] text-gray-400">
                {!inventory.productIdeasAvailable && "No product_ideas table (Product Ideas derive from pin_products). "}
                {!inventory.visualReviewsAvailable && "visual_asset_reviews pending migration v31."}
              </p>
            )}
          </Card>

          {/* 4. Data Freshness */}
          <Card icon={Database} title="Data Freshness" id="data-freshness" right={<FreshnessBadge status={freshness.overall} />}>
            <div className="grid grid-cols-1 gap-4 p-4 lg:grid-cols-2">
              {/* pin_samples */}
              <div className="rounded-lg border" style={{ borderColor: "#EEF0F3" }}>
                <div className="flex items-center justify-between border-b px-3 py-2" style={{ borderColor: "#EEF0F3" }}>
                  <span className="text-[12px] font-black text-gray-700">pin_samples</span>
                  {freshness.samplesAvailable && <SubStatusBadge status={freshness.samplesStatus} />}
                </div>
                {freshness.samplesAvailable ? (
                  <div className="grid grid-cols-3 gap-2 p-3">
                    <StatTile label="24h" value={fmtNum(freshness.samplesLast24h)} />
                    <StatTile label="48h" value={fmtNum(freshness.samplesLast48h)} />
                    <StatTile label="5d" value={fmtNum(freshness.samplesLast5d)} />
                  </div>
                ) : (
                  <Unavailable>pin_samples not available.</Unavailable>
                )}
              </div>
              {/* pin_products */}
              <div className="rounded-lg border" style={{ borderColor: "#EEF0F3" }}>
                <div className="flex items-center justify-between border-b px-3 py-2" style={{ borderColor: "#EEF0F3" }}>
                  <span className="text-[12px] font-black text-gray-700">pin_products</span>
                  <SubStatusBadge status={freshness.productStatus} />
                </div>
                <div className="grid grid-cols-3 gap-2 p-3">
                  <StatTile label="24h" value={fmtNum(freshness.productsLast24h)} />
                  <StatTile label="48h" value={fmtNum(freshness.productsLast48h)} />
                  <StatTile label="5d" value={fmtNum(freshness.productsLast5d)} />
                </div>
              </div>
            </div>
            <DefinitionGrid rows={[
              ["Latest pin_samples.scraped_at", fmtDate(freshness.samplesLatestAt)],
              ["Latest pin_products.created_at", fmtDate(freshness.productsLatestCreatedAt)],
              ["Latest pin_products.scraped_at", fmtDate(freshness.productsLatestScrapedAt)],
              ["Latest product_scores.scored_at", fmtDate(freshness.scoringLatestAt)],
            ]} />
            <p className="px-4 py-2 text-[11px] text-gray-400">Fresh threshold: 48h. pin_samples has no created_at column — scraped_at is the ingestion clock.</p>
          </Card>

          {/* 5. Visual Review */}
          <Card icon={ImageIcon} title="Visual Review">
            {visualReview.available ? (
              <StatGrid>
                <StatTile label="Reviewed" value={fmtNum(visualReview.reviewed)} />
                <StatTile label="Unreviewed" value={fmtNum(visualReview.unreviewed)} />
                <StatTile label="PASS" value={fmtNum(visualReview.pass)} />
                <StatTile label="REVIEW" value={fmtNum(visualReview.review)} />
                <StatTile label="REJECT" value={fmtNum(visualReview.reject)} tone={(visualReview.reject ?? 0) > 0 ? "danger" : undefined} />
              </StatGrid>
            ) : (
              <>
                <StatGrid>
                  <StatTile label="Reviewed" value="n/a" tone="muted" />
                  <StatTile label="Unreviewed (candidates)" value={fmtNum(visualReview.unreviewed)} />
                  <StatTile label="PASS" value="n/a" tone="muted" />
                  <StatTile label="REVIEW" value="n/a" tone="muted" />
                  <StatTile label="REJECT" value="n/a" tone="muted" />
                </StatGrid>
                <Unavailable>visual_asset_reviews table not found — apply migration v31 to enable review metrics.</Unavailable>
              </>
            )}
            {visualReview.available && (
              <p className="px-4 pb-3 text-[11px] text-gray-400">
                Latest reviewed {fmtRelative(visualReview.latestReviewedAt)} · unreviewed is an estimate (candidate images minus reviewed).
              </p>
            )}
          </Card>

          {/* 6. Pipeline / Jobs */}
          <Card icon={Workflow} title="Pipeline / Jobs">
            {jobs.available ? (
              jobs.runs.length > 0 ? (
                <div className="overflow-x-auto">
                  <table className="w-full text-[12.5px]">
                    <thead>
                      <tr className="border-b text-left text-[11px] uppercase text-gray-400" style={{ borderColor: "#EEF0F3" }}>
                        <th className="px-4 py-2 font-bold">Job</th>
                        <th className="px-3 py-2 font-bold">Status</th>
                        <th className="px-3 py-2 font-bold">Latest run</th>
                        <th className="px-3 py-2 font-bold">Rows</th>
                        <th className="px-3 py-2 font-bold">Failed</th>
                        <th className="px-3 py-2 font-bold">Last success</th>
                        <th className="px-4 py-2 font-bold">Latest error</th>
                      </tr>
                    </thead>
                    <tbody>
                      {jobs.runs.map(r => {
                        const bad = r.status === "failed" || r.status === "error";
                        return (
                          <tr key={r.jobType} className="border-b align-top" style={{ borderColor: "#F3F4F6" }}>
                            <td className="px-4 py-2.5 font-bold text-gray-900">{r.jobType}</td>
                            <td className="px-3 py-2.5">
                              <span
                                className="rounded-full px-2 py-0.5 text-[10.5px] font-black uppercase"
                                style={{
                                  background: bad ? "rgba(239,68,68,0.12)" : r.status === "completed" ? "rgba(16,185,129,0.12)" : "rgba(107,114,128,0.12)",
                                  color: bad ? "#B91C1C" : r.status === "completed" ? "#047857" : "#4B5563",
                                }}
                              >
                                {r.status ?? "—"}
                              </span>
                            </td>
                            <td className="px-3 py-2.5 text-gray-600">{fmtRelative(r.startedAt)}</td>
                            <td className="px-3 py-2.5 text-gray-700">{fmtNum(r.rowsProcessed)}</td>
                            <td className="px-3 py-2.5" style={{ color: (r.failedRows ?? 0) > 0 ? "#B91C1C" : "#6B7280" }}>{r.failedRows === null ? "—" : fmtNum(r.failedRows)}</td>
                            <td className="px-3 py-2.5 text-gray-600">{fmtRelative(r.lastSuccessAt)}</td>
                            <td className="max-w-[220px] truncate px-4 py-2.5 text-[11.5px] text-gray-500" title={r.errorMessage ?? undefined}>{r.errorMessage ?? "—"}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Unavailable>pipeline_runs is present but has no rows yet.</Unavailable>
              )
            ) : (
              <Unavailable>pipeline_runs table not found — job status unavailable.</Unavailable>
            )}
          </Card>

          {/* 7. Top Errors */}
          <Card icon={AlertTriangle} title="Top Errors" right={errors.items.length > 0 ? <span className="text-[12px] font-bold text-red-600">{errors.items.length} recent</span> : undefined}>
            {errors.items.length > 0 ? (
              <ul className="divide-y" style={{ borderColor: "#F3F4F6" }}>
                {errors.items.map((e, i) => (
                  <li key={i} className="flex items-start justify-between gap-3 px-4 py-2.5">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span
                          className="rounded-full px-2 py-0.5 text-[10px] font-black uppercase"
                          style={{
                            background: e.kind === "generation" ? "rgba(124,58,237,0.10)" : e.kind === "pipeline" ? "rgba(37,99,235,0.10)" : "rgba(245,158,11,0.12)",
                            color: e.kind === "generation" ? "#6D28D9" : e.kind === "pipeline" ? "#1D4ED8" : "#B45309",
                          }}
                        >
                          {e.kind}
                        </span>
                        <span className="truncate text-[12px] font-bold text-gray-700">{e.source}</span>
                      </div>
                      <p className="mt-0.5 truncate text-[12px] text-gray-500" title={e.message}>{e.message}</p>
                    </div>
                    <span className="shrink-0 text-[11px] text-gray-400">{fmtRelative(e.at)}</span>
                  </li>
                ))}
              </ul>
            ) : errors.available ? (
              <div className="flex items-center gap-2 px-4 py-3 text-[12px] font-semibold text-emerald-600">
                <ShieldCheck className="h-3.5 w-3.5" />
                No recent generation, pipeline, or integration failures.
              </div>
            ) : (
              <Unavailable>No error-event sources available yet.</Unavailable>
            )}
          </Card>
        </div>

        {/* Footer */}
        <div className="mt-5 inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-[12px] font-semibold" style={{ background: "#FFFFFF", borderColor: "#E5E7EB", color: "#6B7280" }}>
          <ShieldCheck className="h-4 w-4 text-emerald-600" />
          Read-only. No crawler / apply / requeue / timer / scoring / mutation controls on this page.
        </div>
      </div>
    </main>
  );
}
