import { redirect } from "next/navigation";
import { AlertTriangle, Lock, Workflow } from "lucide-react";
import { getCurrentSuperAdmin } from "@/lib/server/superAdmin";
import { getPipelineStatus } from "@/lib/server/pipelineStatus";

export const dynamic = "force-dynamic";

function fmtDateTime(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(t));
}

function fmtRelative(iso: string | null): string {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

function fmtDuration(sec: number | null): string {
  if (sec === null || sec === undefined) return "—";
  if (sec < 60) return `${Math.round(sec)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function fmtNum(v: number | null): React.ReactNode {
  return v === null || v === undefined ? <span className="text-gray-300">—</span> : v.toLocaleString();
}

function na(v: React.ReactNode): React.ReactNode {
  return v === null || v === undefined || v === "" ? <span className="text-gray-300">—</span> : v;
}

function StatusBadge({ status }: { status: string | null }) {
  const bad = status === "failed" || status === "error";
  const ok = status === "completed";
  return (
    <span
      className="rounded-full px-2 py-0.5 text-[10.5px] font-black uppercase"
      style={{
        background: bad ? "rgba(239,68,68,0.12)" : ok ? "rgba(16,185,129,0.12)" : "rgba(107,114,128,0.12)",
        color: bad ? "#B91C1C" : ok ? "#047857" : "#4B5563",
      }}
    >
      {status ?? "—"}
    </span>
  );
}

export default async function AdminPipelinePage() {
  const admin = await getCurrentSuperAdmin();
  if (!admin) redirect("/app?admin=forbidden");

  const p = await getPipelineStatus();

  return (
    <main className="h-full overflow-y-auto" style={{ background: "#F8FAFC", color: "#111827" }}>
      <div className="mx-auto max-w-[1320px] px-6 py-7">
        {/* Header */}
        <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="mb-2 inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[11px] font-bold" style={{ background: "#FFFFFF", borderColor: "#E5E7EB", color: "#4B5563" }}>
              <Lock className="h-3.5 w-3.5" />
              Super Admin only · Internal
            </div>
            <h1 className="text-[25px] font-black tracking-tight text-gray-950">Pipeline / Jobs</h1>
            <p className="mt-1 text-[13px] text-gray-500">Latest run per job — status, timing, row counts, and errors. Read-only.</p>
          </div>
          {p.available && (
            <div className="flex gap-2">
              <div className="rounded-lg border px-4 py-3 text-center" style={{ background: "#FFFFFF", borderColor: "#E5E7EB" }}>
                <p className="text-[11px] font-bold uppercase text-gray-400">Runs today</p>
                <p className="mt-1 text-[20px] font-black text-gray-950">{p.runsToday.toLocaleString()}</p>
              </div>
              <div className="rounded-lg border px-4 py-3 text-center" style={{ background: "#FFFFFF", borderColor: "#E5E7EB" }}>
                <p className="text-[11px] font-bold uppercase text-gray-400">Failed today</p>
                <p className="mt-1 text-[20px] font-black" style={{ color: p.failedToday > 0 ? "#B91C1C" : "#030712" }}>{p.failedToday.toLocaleString()}</p>
              </div>
            </div>
          )}
        </div>

        {!p.available ? (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-4">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
              <p className="text-[13px] font-semibold text-amber-900">Pipeline job history table not available yet.</p>
            </div>
          </div>
        ) : (
          <>
            {p.warnings.length > 0 && (
              <div className="mb-4 rounded-lg border px-4 py-3 text-[11.5px] text-gray-500" style={{ background: "#FFFFFF", borderColor: "#E5E7EB" }}>
                {p.warnings.map((w, i) => <p key={i}>· {w}</p>)}
              </div>
            )}

            {p.jobs.length > 0 ? (
              <div className="overflow-x-auto rounded-xl border" style={{ background: "#FFFFFF", borderColor: "#E5E7EB" }}>
                <table className="w-full text-[12.5px]" style={{ minWidth: 1180 }}>
                  <thead>
                    <tr className="border-b text-left text-[10px] uppercase text-gray-400" style={{ borderColor: "#EEF0F3" }}>
                      <th className="px-4 py-2.5 font-bold">Job</th>
                      <th className="px-3 py-2.5 font-bold">Status</th>
                      <th className="px-3 py-2.5 font-bold">Started</th>
                      <th className="px-3 py-2.5 font-bold">Ended</th>
                      <th className="px-3 py-2.5 font-bold">Duration</th>
                      <th className="px-3 py-2.5 font-bold">Processed</th>
                      <th className="px-3 py-2.5 font-bold">Skipped</th>
                      <th className="px-3 py-2.5 font-bold">Failed</th>
                      <th className="px-3 py-2.5 font-bold">Retryable</th>
                      <th className="px-3 py-2.5 font-bold">Last success</th>
                      <th className="px-4 py-2.5 font-bold">Error</th>
                    </tr>
                  </thead>
                  <tbody>
                    {p.jobs.map(j => (
                      <tr key={j.jobName} className="border-b align-top" style={{ borderColor: "#F3F4F6" }}>
                        <td className="px-4 py-2.5 font-bold text-gray-900">{j.jobName}</td>
                        <td className="px-3 py-2.5"><StatusBadge status={j.status} /></td>
                        <td className="whitespace-nowrap px-3 py-2.5 text-gray-600">{fmtDateTime(j.startedAt)}</td>
                        <td className="whitespace-nowrap px-3 py-2.5 text-gray-600">{fmtDateTime(j.endedAt)}</td>
                        <td className="px-3 py-2.5 text-gray-600">{fmtDuration(j.durationSeconds)}</td>
                        <td className="px-3 py-2.5 text-gray-700">{fmtNum(j.processedRows)}</td>
                        <td className="px-3 py-2.5 text-gray-500">{fmtNum(j.skippedRows)}</td>
                        <td className="px-3 py-2.5" style={{ color: (j.failedRows ?? 0) > 0 ? "#B91C1C" : "#6B7280" }}>{fmtNum(j.failedRows)}</td>
                        <td className="px-3 py-2.5 text-gray-600">{j.retryable === null ? <span className="text-gray-300">—</span> : j.retryable ? "Yes" : "No"}</td>
                        <td className="whitespace-nowrap px-3 py-2.5 text-gray-600">{fmtRelative(j.lastSuccessAt)}</td>
                        <td className="max-w-[240px] px-4 py-2.5 text-[11.5px] text-gray-500">
                          {j.errorCode && <span className="mr-1 font-bold text-red-600">{j.errorCode}</span>}
                          <span className="text-gray-500" title={j.errorReason ?? undefined}>{na(j.errorReason)}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="rounded-xl border px-4 py-16 text-center text-[13px] text-gray-400" style={{ background: "#FFFFFF", borderColor: "#E5E7EB" }}>
                pipeline_runs is present but has no rows yet.
              </div>
            )}

            <p className="mt-3 text-[11px] text-gray-400">
              Skipped rows, failed rows, error code, and retryable are read from run metadata when present (otherwise —). &ldquo;Today&rdquo; is since 00:00 UTC.
            </p>
          </>
        )}

        <div className="mt-5 inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-[12px] font-semibold" style={{ background: "#FFFFFF", borderColor: "#E5E7EB", color: "#6B7280" }}>
          <Workflow className="h-4 w-4 text-emerald-600" />
          Read-only. No run / requeue / apply / timer / product-supply / scoring controls on this page.
        </div>
      </div>
    </main>
  );
}
