"use client";

import { useCallback, useMemo, useState } from "react";
import { Lock, AlertTriangle, X, ShieldCheck, Eye, EyeOff, Sparkles } from "lucide-react";
import type {
  GenerationLogsOverview,
  GenerationLogRow,
  GenerationDisplayStatus,
} from "@/lib/server/generationLogs";

// ── formatters ───────────────────────────────────────────────────────────────

function fmtDateTime(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(t));
}

function fmtRelative(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

function na(v: React.ReactNode): React.ReactNode {
  return v === null || v === undefined || v === "" ? <span className="text-gray-300">—</span> : v;
}

const STATUS_TONE: Record<GenerationDisplayStatus, { bg: string; fg: string }> = {
  success: { bg: "rgba(16,185,129,0.12)", fg: "#047857" },
  failed: { bg: "rgba(239,68,68,0.12)", fg: "#B91C1C" },
  blocked: { bg: "rgba(245,158,11,0.14)", fg: "#B45309" },
  pending: { bg: "rgba(59,130,246,0.12)", fg: "#1D4ED8" },
};

function StatusBadge({ status }: { status: GenerationDisplayStatus }) {
  const tone = STATUS_TONE[status];
  return <span className="rounded-full px-2 py-0.5 text-[10.5px] font-black uppercase" style={{ background: tone.bg, color: tone.fg }}>{status}</span>;
}

// ── types ────────────────────────────────────────────────────────────────────

type Filters = {
  dateFrom: string;
  dateTo: string;
  email: string;
  workspace: string;
  type: string;
  status: string;
  promptVersion: string;
  model: string;
  errorCode: string;
};

const EMPTY_FILTERS: Filters = {
  dateFrom: "", dateTo: "", email: "", workspace: "", type: "", status: "", promptVersion: "", model: "", errorCode: "",
};

function dayOf(iso: string | null): string {
  return iso ? iso.slice(0, 10) : "";
}

// ── prompt reveal state ──────────────────────────────────────────────────────

type RevealState = { loading: boolean; text: string | null; audited: boolean | null; error: string | null };

// ── component ────────────────────────────────────────────────────────────────

export default function GenerationLogsClient({ overview, canSeeFullPrompt }: { overview: GenerationLogsOverview; canSeeFullPrompt: boolean }) {
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [selected, setSelected] = useState<GenerationLogRow | null>(null);
  const [reveal, setReveal] = useState<RevealState>({ loading: false, text: null, audited: null, error: null });

  const set = <K extends keyof Filters>(k: K, v: Filters[K]) => setFilters(prev => ({ ...prev, [k]: v }));

  const filtered = useMemo(() => {
    return overview.rows.filter(r => {
      const d = dayOf(r.createdAt);
      if (filters.dateFrom && d && d < filters.dateFrom) return false;
      if (filters.dateTo && d && d > filters.dateTo) return false;
      if (filters.email && r.userEmail !== filters.email) return false;
      if (filters.workspace && r.workspace !== filters.workspace) return false;
      if (filters.type && r.type !== filters.type) return false;
      if (filters.status && r.displayStatus !== filters.status) return false;
      if (filters.model && r.model !== filters.model) return false;
      if (filters.errorCode && r.errorCode !== filters.errorCode) return false;
      // promptVersion filter is inert (never stored) — see note under filters.
      return true;
    });
  }, [overview.rows, filters]);

  const openRow = useCallback((r: GenerationLogRow) => {
    setSelected(r);
    setReveal({ loading: false, text: null, audited: null, error: null });
  }, []);

  const doReveal = useCallback(async (id: string) => {
    setReveal({ loading: true, text: null, audited: null, error: null });
    try {
      const resp = await fetch(`/api/admin/generation-logs/${id}/prompt`, { credentials: "include" });
      const body = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        setReveal({ loading: false, text: null, audited: null, error: (body as { error?: string }).error ?? `Failed (${resp.status})` });
        return;
      }
      const b = body as { promptFull: string | null; finalPrompt: string | null; promptSnapshot: string | null; audited: boolean };
      const text = b.promptFull ?? b.finalPrompt ?? b.promptSnapshot ?? "(prompt is empty)";
      setReveal({ loading: false, text, audited: b.audited, error: null });
    } catch (e) {
      setReveal({ loading: false, text: null, audited: null, error: String(e) });
    }
  }, []);

  const select = (label: string, value: string, onChange: (v: string) => void, options: string[], disabled?: boolean) => (
    <label className="flex flex-col gap-0.5">
      <span className="text-[10px] font-bold uppercase text-gray-400">{label}</span>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        disabled={disabled}
        className="rounded-lg border px-2 py-1.5 text-[12px] font-semibold"
        style={{ background: disabled ? "#F3F4F6" : "#FFFFFF", borderColor: "#E5E7EB", color: disabled ? "#9CA3AF" : "#374151" }}
      >
        <option value="">{disabled ? "n/a" : "All"}</option>
        {options.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    </label>
  );

  return (
    <main className="h-full overflow-y-auto" style={{ background: "#F8FAFC", color: "#111827" }}>
      <div className="mx-auto max-w-[1500px] px-6 py-7">
        {/* Header */}
        <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="mb-2 inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[11px] font-bold" style={{ background: "#FFFFFF", borderColor: "#E5E7EB", color: "#4B5563" }}>
              <Lock className="h-3.5 w-3.5" />
              {canSeeFullPrompt ? "Super Admin · Internal" : "Support · Internal"}
            </div>
            <h1 className="text-[25px] font-black tracking-tight text-gray-950">Generation Logs</h1>
            <p className="mt-1 text-[13px] text-gray-500">Debug AI generation failures, safety blocks, and irrelevant outputs. Read-only.</p>
          </div>
          <div className="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-[12px] font-semibold text-gray-500" style={{ background: "#FFFFFF", borderColor: "#E5E7EB" }}>
            <Sparkles className="h-4 w-4" />
            {overview.rows.length.toLocaleString()} loaded
          </div>
        </div>

        {!overview.available && (
          <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
              <p className="text-[13px] font-semibold text-amber-900">Generation logs unavailable — pin_generations could not be read.</p>
            </div>
          </div>
        )}

        {overview.warnings.length > 0 && (
          <div className="mb-4 rounded-lg border px-4 py-3 text-[11.5px] text-gray-500" style={{ background: "#FFFFFF", borderColor: "#E5E7EB" }}>
            {overview.warnings.map((w, i) => <p key={i}>· {w}</p>)}
          </div>
        )}

        {/* Filters */}
        <div className="mb-4 flex flex-wrap items-end gap-2.5 rounded-xl border p-3" style={{ background: "#FFFFFF", borderColor: "#E5E7EB" }}>
          <label className="flex flex-col gap-0.5">
            <span className="text-[10px] font-bold uppercase text-gray-400">From</span>
            <input type="date" value={filters.dateFrom} onChange={e => set("dateFrom", e.target.value)} className="rounded-lg border px-2 py-1.5 text-[12px]" style={{ borderColor: "#E5E7EB", color: "#374151" }} />
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="text-[10px] font-bold uppercase text-gray-400">To</span>
            <input type="date" value={filters.dateTo} onChange={e => set("dateTo", e.target.value)} className="rounded-lg border px-2 py-1.5 text-[12px]" style={{ borderColor: "#E5E7EB", color: "#374151" }} />
          </label>
          {select("User email", filters.email, v => set("email", v), overview.filters.emails)}
          {select("Workspace", filters.workspace, v => set("workspace", v), overview.filters.workspaces)}
          {select("Type", filters.type, v => set("type", v), overview.filters.types)}
          {select("Status", filters.status, v => set("status", v), overview.filters.statuses)}
          {select("Prompt ver.", filters.promptVersion, v => set("promptVersion", v), overview.filters.promptVersions, true)}
          {select("Model", filters.model, v => set("model", v), overview.filters.models, overview.filters.models.length === 0)}
          {select("Error code", filters.errorCode, v => set("errorCode", v), overview.filters.errorCodes, overview.filters.errorCodes.length === 0)}
          <button
            type="button"
            onClick={() => setFilters(EMPTY_FILTERS)}
            className="rounded-lg border px-3 py-1.5 text-[12px] font-bold text-gray-600"
            style={{ borderColor: "#E5E7EB", background: "#FFFFFF" }}
          >
            Reset
          </button>
          <span className="ml-auto self-center text-[12px] font-semibold text-gray-400">{filtered.length} shown</span>
        </div>

        {/* Table */}
        <div className="overflow-x-auto rounded-xl border" style={{ background: "#FFFFFF", borderColor: "#E5E7EB" }}>
          <table className="w-full text-[12px]" style={{ minWidth: 1400 }}>
            <thead>
              <tr className="border-b text-left text-[10px] uppercase text-gray-400" style={{ borderColor: "#EEF0F3" }}>
                <th className="px-3 py-2.5 font-bold">Created</th>
                <th className="px-3 py-2.5 font-bold">User</th>
                <th className="px-3 py-2.5 font-bold">Workspace</th>
                <th className="px-3 py-2.5 font-bold">Type</th>
                <th className="px-3 py-2.5 font-bold">Status</th>
                <th className="px-3 py-2.5 font-bold">Source</th>
                <th className="px-3 py-2.5 font-bold">Trend kw</th>
                <th className="px-3 py-2.5 font-bold">Idea id</th>
                <th className="px-3 py-2.5 font-bold">Prompt v</th>
                <th className="px-3 py-2.5 font-bold">Model</th>
                <th className="px-3 py-2.5 font-bold">ms</th>
                <th className="px-3 py-2.5 font-bold">In tok</th>
                <th className="px-3 py-2.5 font-bold">Out tok</th>
                <th className="px-3 py-2.5 font-bold">Cost</th>
                <th className="px-3 py-2.5 font-bold">Error</th>
                <th className="px-3 py-2.5 font-bold">C/E/P</th>
                <th className="px-3 py-2.5 font-bold">Feedback</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(r => (
                <tr key={r.id} onClick={() => openRow(r)} className="cursor-pointer border-b hover:bg-gray-50" style={{ borderColor: "#F3F4F6" }}>
                  <td className="whitespace-nowrap px-3 py-2 text-gray-600">{fmtDateTime(r.createdAt)}</td>
                  <td className="max-w-[180px] truncate px-3 py-2 text-gray-700" title={r.userEmail ?? r.userId ?? ""}>{r.userEmail ?? na(r.userId)}</td>
                  <td className="px-3 py-2 text-gray-600">{na(r.workspace)}</td>
                  <td className="px-3 py-2 text-gray-600">{na(r.type)}</td>
                  <td className="px-3 py-2"><StatusBadge status={r.displayStatus} /></td>
                  <td className="max-w-[130px] truncate px-3 py-2 text-gray-500" title={`${r.sourceType ?? ""} ${r.sourceId ?? ""}`}>{na(r.sourceType)}</td>
                  <td className="max-w-[130px] truncate px-3 py-2 text-gray-600" title={r.trendKeyword ?? ""}>{na(r.trendKeyword)}</td>
                  <td className="max-w-[90px] truncate px-3 py-2 font-mono text-[10.5px] text-gray-400">{na(r.productIdeaId)}</td>
                  <td className="px-3 py-2 text-gray-400">{na(r.promptVersion)}</td>
                  <td className="px-3 py-2 text-gray-600">{na(r.model)}</td>
                  <td className="px-3 py-2 text-gray-400">{na(r.latencyMs)}</td>
                  <td className="px-3 py-2 text-gray-400">{na(r.inputTokens)}</td>
                  <td className="px-3 py-2 text-gray-400">{na(r.outputTokens)}</td>
                  <td className="px-3 py-2 text-gray-400">{na(r.costEstimate)}</td>
                  <td className="max-w-[120px] truncate px-3 py-2 text-red-600" title={r.errorMessage ?? ""}>{na(r.errorCode)}</td>
                  <td className="px-3 py-2 text-gray-400">{na(r.copiedExportedPublished)}</td>
                  <td className="px-3 py-2 text-gray-400">{na(r.userFeedback)}</td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr><td colSpan={17} className="px-4 py-16 text-center text-[13px] text-gray-400">No generation logs match the current filters.</td></tr>
              )}
            </tbody>
          </table>
        </div>

        <p className="mt-3 text-[11px] text-gray-400">
          Latency, token counts, cost, prompt version, copy/export/publish, and user feedback are not recorded on generations yet (shown as —).
          {overview.windowSaturated && " Showing the most recent 500 generations."}
        </p>
      </div>

      {/* Detail drawer */}
      {selected && (
        <DetailDrawer
          row={selected}
          canSeeFullPrompt={canSeeFullPrompt}
          reveal={reveal}
          onReveal={() => doReveal(selected.id)}
          onClose={() => setSelected(null)}
        />
      )}
    </main>
  );
}

// ── drawer ───────────────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="mb-1.5 text-[11px] font-black uppercase tracking-wide text-gray-400">{title}</h3>
      {children}
    </div>
  );
}

function KV({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1">
      <span className="text-[12px] text-gray-500">{k}</span>
      <span className="max-w-[60%] break-words text-right text-[12px] font-semibold text-gray-800">{v}</span>
    </div>
  );
}

function DetailDrawer({ row, canSeeFullPrompt, reveal, onReveal, onClose }: {
  row: GenerationLogRow;
  canSeeFullPrompt: boolean;
  reveal: RevealState;
  onReveal: () => void;
  onClose: () => void;
}) {
  const s = row.inputSummary;
  const failed = row.displayStatus === "failed" || row.displayStatus === "blocked";

  return (
    <>
      <div style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.35)", zIndex: 60 }} onClick={onClose} />
      <aside
        style={{
          position: "fixed", top: 0, right: 0, height: "100dvh", width: "min(560px, 92vw)",
          background: "#FFFFFF", borderLeft: "1px solid #E5E7EB", zIndex: 61,
          display: "flex", flexDirection: "column", boxShadow: "-12px 0 40px rgba(0,0,0,0.12)",
        }}
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-3 border-b px-5 py-3.5" style={{ borderColor: "#E5E7EB" }}>
          <div className="flex items-center gap-2">
            <StatusBadge status={row.displayStatus} />
            <span className="text-[13px] font-bold text-gray-800">{fmtDateTime(row.createdAt)}</span>
            <span className="text-[11px] text-gray-400">· {fmtRelative(row.createdAt)}</span>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100"><X className="h-4 w-4" /></button>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
          {/* Meta */}
          <Section title="Generation">
            <div className="rounded-lg border px-3 py-1.5" style={{ borderColor: "#EEF0F3" }}>
              <KV k="Type" v={na(row.type)} />
              <KV k="Model" v={na(row.model)} />
              <KV k="Prompt version" v={na(row.promptVersion)} />
              <KV k="Trace / request id" v={<span className="font-mono text-[11px]">{na(row.requestId)}</span>} />
              <KV k="User" v={row.userEmail ?? na(row.userId)} />
              <KV k="Workspace" v={na(row.workspace)} />
              <KV k="Source" v={`${row.sourceType ?? "—"}${row.sourceId ? ` · ${row.sourceId}` : ""}`} />
              <KV k="Generation id" v={<span className="font-mono text-[11px]">{row.id}</span>} />
            </div>
          </Section>

          {/* Input summary */}
          <Section title="Input summary">
            {s ? (
              <div className="rounded-lg border px-3 py-1.5" style={{ borderColor: "#EEF0F3" }}>
                <KV k="Mode" v={na(s.mode)} />
                <KV k="Opportunity" v={na(s.opportunityTitle)} />
                <KV k="Keyword" v={na(s.keyword ?? row.trendKeyword)} />
                <KV k="Category" v={na(s.category)} />
                <KV k="Detected category" v={na(s.detectedCategory)} />
                <KV k="Output type" v={na(s.outputType)} />
                <KV k="Format" v={na(s.format)} />
                <KV k="Images / reference" v={na(s.imagesPerReference)} />
                <KV k="Products · references" v={`${s.productCount} · ${s.referenceCount}`} />
                {s.userInstructions && <KV k="User instructions" v={s.userInstructions} />}
                {s.productImages.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 pt-2">
                    {s.productImages.map((u, i) => (
                      // eslint-disable-next-line @next/next/no-img-element -- internal admin thumbnail
                      <img key={i} src={u} alt="" referrerPolicy="no-referrer" loading="lazy" style={{ width: 44, height: 44, objectFit: "cover", borderRadius: 6, background: "#F1F5F9" }} />
                    ))}
                  </div>
                )}
              </div>
            ) : <p className="text-[12px] text-gray-400">No structured input snapshot.</p>}
          </Section>

          {/* Output preview */}
          <Section title={`Output preview (${row.outputImages.length})`}>
            {row.outputImages.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {row.outputImages.map((u, i) => (
                  // eslint-disable-next-line @next/next/no-img-element -- internal admin thumbnail of the user's own generated image
                  <img key={i} src={u} alt="" referrerPolicy="no-referrer" loading="lazy" style={{ width: 76, height: 76, objectFit: "cover", borderRadius: 8, background: "#F1F5F9" }} />
                ))}
              </div>
            ) : <p className="text-[12px] text-gray-400">No output images.</p>}
          </Section>

          {/* Error details */}
          {failed && (
            <Section title="Error details">
              <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2">
                <p className="text-[12px] font-bold text-red-700">{row.errorCode ?? row.displayStatus}</p>
                {row.errorMessage && <p className="mt-1 whitespace-pre-wrap text-[12px] text-red-600">{row.errorMessage}</p>}
              </div>
            </Section>
          )}

          {/* Related */}
          <Section title="Related Product Idea / product">
            {row.relatedProductIds.length > 0 || row.relatedProductNames.length > 0 ? (
              <div className="rounded-lg border px-3 py-1.5" style={{ borderColor: "#EEF0F3" }}>
                {row.relatedProductNames.length > 0 && <KV k="Products" v={row.relatedProductNames.join(", ")} />}
                {row.relatedProductIds.length > 0 && <KV k="Product ids" v={<span className="font-mono text-[10.5px]">{row.relatedProductIds.join(", ")}</span>} />}
              </div>
            ) : <p className="text-[12px] text-gray-400">No related product idea recorded.</p>}
          </Section>

          {/* User feedback + eval */}
          <Section title="Feedback / eval">
            <div className="rounded-lg border px-3 py-1.5" style={{ borderColor: "#EEF0F3" }}>
              <KV k="User feedback" v={na(row.userFeedback)} />
              <KV k="Internal eval score" v={na(row.internalEvalScore)} />
            </div>
          </Section>

          {/* Prompt (sensitive) */}
          <Section title="Full internal prompt (sensitive)">
            {!row.hasFullPrompt ? (
              <p className="text-[12px] text-gray-400">No stored prompt for this generation.</p>
            ) : !canSeeFullPrompt ? (
              <div className="flex items-start gap-2 rounded-lg border px-3 py-2.5" style={{ borderColor: "#E5E7EB", background: "#F9FAFB" }}>
                <EyeOff className="mt-0.5 h-4 w-4 shrink-0 text-gray-400" />
                <p className="text-[12px] text-gray-500">Restricted to Super Admin. The full internal prompt template is hidden for the Support role.</p>
              </div>
            ) : reveal.text !== null ? (
              <div>
                <pre className="max-h-[280px] overflow-auto whitespace-pre-wrap rounded-lg border px-3 py-2 text-[11.5px] text-gray-800" style={{ borderColor: "#E5E7EB", background: "#F9FAFB" }}>{reveal.text}</pre>
                <p className="mt-1.5 flex items-center gap-1.5 text-[11px] text-gray-400">
                  <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" />
                  {reveal.audited ? "This view was recorded in the admin audit log." : "Shown, but the audit event could not be recorded (apply migration v34)."}
                </p>
              </div>
            ) : (
              <div>
                <button
                  type="button"
                  onClick={onReveal}
                  disabled={reveal.loading}
                  className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-bold text-white"
                  style={{ background: "#111827", opacity: reveal.loading ? 0.6 : 1 }}
                >
                  <Eye className="h-3.5 w-3.5" />
                  {reveal.loading ? "Revealing…" : "Reveal full prompt (audited)"}
                </button>
                {reveal.error && <p className="mt-1.5 text-[11.5px] font-semibold text-red-600">{reveal.error}</p>}
                <p className="mt-1.5 text-[11px] text-gray-400">Revealing records an audit event (who / when / which generation).</p>
              </div>
            )}
          </Section>
        </div>

        {/* Footer */}
        <div className="flex items-center gap-2 border-t px-5 py-3 text-[11.5px] font-semibold text-gray-500" style={{ borderColor: "#E5E7EB" }}>
          <ShieldCheck className="h-4 w-4 text-emerald-600" />
          Read-only. No secrets or tokens are shown. No write actions in v0.
        </div>
      </aside>
    </>
  );
}
