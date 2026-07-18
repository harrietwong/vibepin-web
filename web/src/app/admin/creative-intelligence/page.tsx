import Link from "next/link";
import { redirect } from "next/navigation";
import { AlertTriangle, BarChart3, Lock, Sparkles } from "lucide-react";
import { getCurrentSuperAdmin } from "@/lib/server/superAdmin";
import {
  getCreativeIntelligenceMetrics,
  type CreativeIntelligenceWindow,
} from "@/lib/server/creativeIntelligence";
import CalibrationClient from "./CalibrationClient";

export const dynamic = "force-dynamic";

// ── Small presentational helpers (mirrors /admin/data conventions) ────────────

function Card({ title, sub, children }: { title: React.ReactNode; sub?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border" style={{ background: "var(--admin-surface, #FFFFFF)", borderColor: "var(--admin-border, #E5E7EB)" }}>
      <div className="border-b px-4 py-3" style={{ borderColor: "var(--admin-border, #E5E7EB)" }}>
        <h2 className="text-[14px] font-black text-gray-950">{title}</h2>
        {sub && <p className="mt-0.5 text-[11.5px] text-gray-500">{sub}</p>}
      </div>
      {children}
    </section>
  );
}

function fmtNum(v: number): string {
  return v.toLocaleString();
}

/** Simple text/CSS bar (no chart library) — width relative to the group max. */
function TextBar({ count, max, tone }: { count: number; max: number; tone: string }) {
  const pct = max > 0 ? Math.max(count > 0 ? 4 : 0, Math.round((count / max) * 100)) : 0;
  return (
    <div className="h-[10px] w-full overflow-hidden rounded" style={{ background: "var(--admin-surface-2, #F3F4F6)" }}>
      <div className="h-full rounded" style={{ width: `${pct}%`, background: tone }} />
    </div>
  );
}

const VERDICT_TONES: Record<string, string> = {
  ok: "#10B981",
  borderline: "#F59E0B",
  invalid: "#EF4444",
};

export default async function AdminCreativeIntelligencePage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  const admin = await getCurrentSuperAdmin();
  if (!admin) redirect("/app?admin=forbidden");

  const params = await searchParams;
  const windowDays: CreativeIntelligenceWindow = params.days === "30" ? 30 : 7;
  const m = await getCreativeIntelligenceMetrics(windowDays);

  const funnelMax = Math.max(1, ...m.funnel.map(f => f.count));
  const bucketMax = Math.max(1, ...m.judge.overallBuckets.map(b => b.count));

  return (
    <main className="h-full overflow-y-auto" style={{ background: "var(--admin-bg, #F8FAFC)", color: "var(--admin-text, #111827)" }}>
      <div className="mx-auto max-w-[1180px] px-6 py-7">
        {/* Header */}
        <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="mb-2 inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[11px] font-bold" style={{ background: "var(--admin-surface, #FFFFFF)", borderColor: "var(--admin-border, #E5E7EB)", color: "var(--admin-text-secondary, #4B5563)" }}>
              <Lock className="h-3.5 w-3.5" />
              Super Admin only · Internal
            </div>
            <h1 className="text-[25px] font-black tracking-tight text-gray-950">Creative Intelligence</h1>
            <p className="mt-1 text-[13px] text-gray-500">
              Upload-to-publish funnel, selection rates, and quality-judge distribution. Read-only report + judge calibration.
            </p>
          </div>
          {/* 7 / 30 day toggle */}
          <div className="inline-flex overflow-hidden rounded-lg border" style={{ borderColor: "var(--admin-border, #E5E7EB)" }}>
            {([7, 30] as const).map(d => {
              const active = windowDays === d;
              return (
                <Link
                  key={d}
                  href={d === 7 ? "/admin/creative-intelligence" : "/admin/creative-intelligence?days=30"}
                  className="px-4 py-2 text-[12.5px] font-bold no-underline"
                  style={active
                    ? { background: "rgba(99,102,241,0.14)", color: "#4338CA" }
                    : { background: "var(--admin-surface, #FFFFFF)", color: "#6B7280" }}
                >
                  Last {d} days
                </Link>
              );
            })}
          </div>
        </div>

        {/* Availability / warnings */}
        {!m.available && (
          <div className="mb-5 rounded-lg border border-amber-200 bg-amber-50 px-4 py-4">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
              <p className="text-[13px] font-semibold text-amber-900">{m.warnings[0] ?? "analytics_events not available."}</p>
            </div>
          </div>
        )}
        {m.available && m.warnings.length > 0 && (
          <div className="mb-5 rounded-lg border px-4 py-3 text-[11.5px] text-gray-500" style={{ background: "var(--admin-surface, #FFFFFF)", borderColor: "var(--admin-border, #E5E7EB)" }}>
            {m.warnings.map((w, i) => <p key={i}>· {w}</p>)}
          </div>
        )}

        <div className="flex flex-col gap-5">
          {/* a) Funnel counts */}
          <Card
            title={<span className="inline-flex items-center gap-2"><BarChart3 className="h-4 w-4 text-gray-500" /> Creative funnel (event counts)</span>}
            sub="Raw event counts per stage — stages are related but NOT strictly per-session (one upload can produce several generations), so this is a volume funnel, not a per-user conversion funnel."
          >
            <div className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-4 xl:grid-cols-8">
              {m.funnel.map(f => (
                <div key={f.event} className="rounded-lg border px-3 py-3" style={{ background: "var(--admin-surface-2, #F9FAFB)", borderColor: "var(--admin-border-soft, #EEF0F3)" }}>
                  <p className="break-words text-[10px] font-bold uppercase leading-tight text-gray-400">{f.event.replace(/_/g, " ")}</p>
                  <p className="mt-1 text-[20px] font-black tabular-nums text-gray-950">{fmtNum(f.count)}</p>
                  <div className="mt-2">
                    <TextBar count={f.count} max={funnelMax} tone="#6366F1" />
                  </div>
                </div>
              ))}
            </div>
            {m.available && m.funnel.every(f => f.count === 0) && (
              <p className="px-4 pb-4 text-[12.5px] text-gray-400">No events in this window yet — the sink fills as signed-in users run the studio flow.</p>
            )}
          </Card>

          {/* b) Ratio cards */}
          <Card
            title="Selection rates & activity"
            sub="Each rate states its exact numerator / denominator. n/a = denominator is 0 in this window."
          >
            <div className="grid grid-cols-2 gap-3 p-4 xl:grid-cols-4">
              {m.rateCards.map(rc => (
                <div key={rc.id} className="rounded-lg border px-4 py-3" style={{ background: "var(--admin-surface-2, #F9FAFB)", borderColor: "var(--admin-border-soft, #EEF0F3)" }}>
                  <p className="text-[11px] font-bold uppercase text-gray-400">{rc.label}</p>
                  <p className="mt-1 text-[20px] font-black text-gray-950">{rc.pct === null ? "n/a" : `${rc.pct}%`}</p>
                  <p className="mt-1 font-mono text-[10.5px] text-gray-400">{rc.basis}</p>
                  <p className="font-mono text-[10.5px] text-gray-400">{fmtNum(rc.numerator)} / {fmtNum(rc.denominator)}</p>
                </div>
              ))}
              <div className="rounded-lg border px-4 py-3" style={{ background: "var(--admin-surface-2, #F9FAFB)", borderColor: "var(--admin-border-soft, #EEF0F3)" }}>
                <p className="text-[11px] font-bold uppercase text-gray-400">Regenerate clicks</p>
                <p className="mt-1 text-[20px] font-black text-gray-950">{fmtNum(m.regenerateClicks)}</p>
                <p className="mt-1 font-mono text-[10.5px] text-gray-400">count(regenerate_clicked)</p>
              </div>
              <div className="rounded-lg border px-4 py-3" style={{ background: "var(--admin-surface-2, #F9FAFB)", borderColor: "var(--admin-border-soft, #EEF0F3)" }}>
                <p className="text-[11px] font-bold uppercase text-gray-400">Keywords removed</p>
                <p className="mt-1 text-[20px] font-black text-gray-950">{fmtNum(m.keywordRemovals)}</p>
                <p className="mt-1 font-mono text-[10.5px] text-gray-400">count(keyword_removed)</p>
              </div>
            </div>
          </Card>

          {/* c) Judge distribution */}
          <Card
            title="Quality-judge distribution (generation_judged)"
            sub={`Verdict share + overall-score histogram over the ${m.judgeSampleCapped ? "most recent 2,000" : "window's"} generation_judged events. Rows without a recognizable verdict/overall are excluded from their respective denominators.`}
          >
            {m.judge.total === 0 ? (
              <p className="px-4 py-6 text-[12.5px] text-gray-400">No judged generations in this window yet.</p>
            ) : (
              <div className="grid grid-cols-1 gap-5 p-4 lg:grid-cols-2">
                {/* Verdict share */}
                <div>
                  <p className="mb-2 text-[11px] font-bold uppercase text-gray-400">Verdict share ({fmtNum(m.judge.verdictTotal)} events)</p>
                  <div className="flex flex-col gap-2">
                    {(["ok", "borderline", "invalid"] as const).map(v => {
                      const count = m.judge.verdictCounts[v];
                      const pct = m.judge.verdictTotal > 0 ? Math.round((count / m.judge.verdictTotal) * 100) : 0;
                      return (
                        <div key={v} className="flex items-center gap-3">
                          <span className="w-[84px] shrink-0 text-[11.5px] font-black uppercase" style={{ color: VERDICT_TONES[v] }}>{v}</span>
                          <div className="flex-1"><TextBar count={count} max={Math.max(1, m.judge.verdictTotal)} tone={VERDICT_TONES[v]} /></div>
                          <span className="w-[90px] shrink-0 text-right font-mono text-[11.5px] text-gray-600">{fmtNum(count)} · {pct}%</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
                {/* Overall histogram */}
                <div>
                  <p className="mb-2 text-[11px] font-bold uppercase text-gray-400">Overall score histogram ({fmtNum(m.judge.overallTotal)} events with overall)</p>
                  <div className="flex flex-col gap-2">
                    {m.judge.overallBuckets.map(b => (
                      <div key={b.label} className="flex items-center gap-3">
                        <span className="w-[84px] shrink-0 font-mono text-[11.5px] text-gray-500">{b.label}</span>
                        <div className="flex-1"><TextBar count={b.count} max={bucketMax} tone="#6366F1" /></div>
                        <span className="w-[90px] shrink-0 text-right font-mono text-[11.5px] text-gray-600">{fmtNum(b.count)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </Card>

          {/* Judge calibration (Task 6) */}
          <CalibrationClient />
        </div>

        {/* d) Data-source caveat */}
        <div className="mt-5 rounded-lg border px-4 py-3 text-[12px]" style={{ background: "var(--admin-surface, #FFFFFF)", borderColor: "var(--admin-border, #E5E7EB)", color: "var(--admin-text-secondary, #6B7280)" }}>
          <p className="flex items-center gap-2 font-bold text-gray-700"><Sparkles className="h-4 w-4 text-emerald-600" /> Data source & known limits</p>
          <ul className="mt-1.5 list-disc pl-6">
            <li><span className="font-mono">analytics_events</span> (migrate_v41) — client-side beacons via <span className="font-mono">POST /api/analytics/events</span>. Best-effort by contract: signed-out sessions are dropped, lost beacons are never retried, and events pre-dating the sink are absent — treat every number as directional, not a complete ledger.</li>
            <li>Counts are raw event volumes (not deduped per user/session). Stages fire at different granularities: analysis events are per upload, judge/keep events are per generated result.</li>
            <li>Judge verdicts/overall come from the client-reported <span className="font-mono">generation_judged</span> payload ({m.judgeSampleCapped ? "sampled to the most recent 2,000 rows in this window" : "all rows in this window"}).</li>
          </ul>
        </div>
      </div>
    </main>
  );
}
