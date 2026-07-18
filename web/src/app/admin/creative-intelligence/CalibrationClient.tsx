"use client";

/**
 * Judge calibration section (internal, super-admin) — /admin/creative-intelligence.
 *
 * Lists recent generation_judged events (thumbnail + verdict + overall) and records a
 * human Agree/Disagree per (draftId, judgeVersion). Reads come from
 * GET /api/admin/creative-intelligence/calibration; writes REUSE the existing
 * POST /api/admin/visual-review upsert (same auth + server-derived fields), with the
 * field mapping documented in lib/judgeCalibration.ts.
 */

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Check, RefreshCw, ThumbsDown, ThumbsUp } from "lucide-react";
import {
  buildCalibrationNote,
  buildCalibrationSourceId,
  CALIBRATION_SOURCE_TYPE,
  NEUTRAL_CALIBRATION_SCORES,
  type CalibrationAgreement,
  type CalibrationItem,
  type CalibrationResponse,
} from "@/lib/judgeCalibration";

const VERDICT_TONE: Record<string, { bg: string; fg: string }> = {
  ok: { bg: "rgba(16,185,129,0.12)", fg: "#047857" },
  borderline: { bg: "rgba(245,158,11,0.13)", fg: "#B45309" },
  invalid: { bg: "rgba(239,68,68,0.12)", fg: "#B91C1C" },
};

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(t));
}

export default function CalibrationClient() {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<CalibrationResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [saveErrors, setSaveErrors] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/creative-intelligence/calibration", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json() as CalibrationResponse);
    } catch (e) {
      setError((e as Error).message || "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const vote = useCallback(async (item: CalibrationItem, agreement: CalibrationAgreement) => {
    const key = buildCalibrationSourceId(item.draftId, item.judgeVersion);
    setSavingKey(key);
    setSaveErrors(prev => ({ ...prev, [key]: "" }));
    try {
      const res = await fetch("/api/admin/visual-review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source_type: CALIBRATION_SOURCE_TYPE,
          source_id: key,
          image_url: item.imageUrl,
          ...NEUTRAL_CALIBRATION_SCORES,
          tags: [],
          reviewer_note: buildCalibrationNote({
            agreement,
            judgeVersion: item.judgeVersion,
            verdict: item.verdict,
            overall: item.overall,
            draftId: item.draftId,
          }),
        }),
      });
      const body = await res.json().catch(() => ({})) as { error?: string; detail?: string };
      if (!res.ok) throw new Error(body.detail || body.error || `HTTP ${res.status}`);
      setData(prev => prev ? {
        ...prev,
        items: prev.items.map(it =>
          it.draftId === item.draftId && it.judgeVersion === item.judgeVersion
            ? { ...it, agreement, reviewedAt: new Date().toISOString() }
            : it),
      } : prev);
    } catch (e) {
      setSaveErrors(prev => ({ ...prev, [key]: (e as Error).message || "Save failed" }));
    } finally {
      setSavingKey(null);
    }
  }, []);

  return (
    <section className="rounded-xl border" style={{ background: "var(--admin-surface, #FFFFFF)", borderColor: "var(--admin-border, #E5E7EB)" }}>
      <div className="flex items-center justify-between gap-3 border-b px-4 py-3" style={{ borderColor: "var(--admin-border, #E5E7EB)" }}>
        <div>
          <h2 className="text-[14px] font-black text-gray-950">Judge calibration</h2>
          <p className="mt-0.5 text-[11.5px] text-gray-500">
            Recent generation_judged verdicts — mark Agree/Disagree to build a human calibration set.
            Votes upsert into visual_asset_reviews (namespaced <code>judge_calibration:*</code> rows, one per draft + judge version).
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[12px] font-bold text-gray-600"
          style={{ borderColor: "var(--admin-border, #E5E7EB)", background: "var(--admin-surface-2, #F9FAFB)" }}
        >
          <RefreshCw className="h-3.5 w-3.5" /> Refresh
        </button>
      </div>

      {loading ? (
        <p className="px-4 py-8 text-center text-[12.5px] text-gray-400">Loading judged generations…</p>
      ) : error ? (
        <p className="flex items-center gap-2 px-4 py-6 text-[12.5px] text-gray-500">
          <AlertTriangle className="h-4 w-4 text-amber-500" /> {error}
        </p>
      ) : !data || !data.available ? (
        <p className="flex items-center gap-2 px-4 py-6 text-[12.5px] text-gray-500">
          <AlertTriangle className="h-4 w-4 text-amber-500" />
          {data?.warnings[0] ?? "analytics_events not available."}
        </p>
      ) : data.items.length === 0 ? (
        <p className="px-4 py-8 text-center text-[12.5px] text-gray-400">
          No judged generations with a renderable draft image yet. Verdicts appear here after AI generations are quality-judged.
        </p>
      ) : (
        <>
          {!data.persistenceAvailable && (
            <p className="flex items-center gap-2 px-4 pt-3 text-[12px] text-amber-700">
              <AlertTriangle className="h-3.5 w-3.5" /> visual_asset_reviews unavailable — votes cannot be saved (migration v31).
            </p>
          )}
          <ul className="divide-y" style={{ borderColor: "var(--admin-border-soft, #EEF0F3)" }}>
            {data.items.map(item => {
              const key = buildCalibrationSourceId(item.draftId, item.judgeVersion);
              const tone = VERDICT_TONE[item.verdict] ?? VERDICT_TONE.ok;
              const saving = savingKey === key;
              const saveError = saveErrors[key];
              return (
                <li key={key} className="flex items-center gap-4 px-4 py-3">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={item.imageUrl}
                    alt={item.title ?? item.draftId}
                    loading="lazy"
                    className="h-[96px] w-[72px] shrink-0 rounded-lg border object-cover"
                    style={{ borderColor: "var(--admin-border, #E5E7EB)" }}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[12.5px] font-bold text-gray-900" title={item.title ?? item.draftId}>
                      {item.title ?? "Untitled draft"}
                    </p>
                    <p className="mt-0.5 truncate font-mono text-[10.5px] text-gray-400" title={item.draftId}>{item.draftId}</p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-2">
                      <span className="rounded-full px-2 py-0.5 text-[10.5px] font-black uppercase" style={{ background: tone.bg, color: tone.fg }}>
                        {item.verdict}
                      </span>
                      <span className="text-[11px] font-semibold text-gray-600">
                        overall {item.overall === null ? "—" : item.overall}
                      </span>
                      <span className="text-[10.5px] text-gray-400">{item.judgeVersion} · judged {fmtDate(item.judgedAt)}</span>
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1.5">
                    <div className="flex items-center gap-2">
                      {(["agree", "disagree"] as const).map(a => {
                        const active = item.agreement === a;
                        const Icon = a === "agree" ? ThumbsUp : ThumbsDown;
                        return (
                          <button
                            key={a}
                            type="button"
                            disabled={saving || !data.persistenceAvailable}
                            onClick={() => void vote(item, a)}
                            className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[12px] font-bold disabled:opacity-50"
                            style={active
                              ? { background: a === "agree" ? "rgba(16,185,129,0.12)" : "rgba(239,68,68,0.12)", color: a === "agree" ? "#047857" : "#B91C1C", borderColor: a === "agree" ? "rgba(16,185,129,0.35)" : "rgba(239,68,68,0.35)" }
                              : { background: "var(--admin-surface-2, #F9FAFB)", color: "#4B5563", borderColor: "var(--admin-border, #E5E7EB)" }}
                          >
                            <Icon className="h-3.5 w-3.5" />
                            {a === "agree" ? "Agree" : "Disagree"}
                          </button>
                        );
                      })}
                    </div>
                    {item.agreement && !saveError && (
                      <span className="inline-flex items-center gap-1 text-[10.5px] font-semibold text-emerald-700">
                        <Check className="h-3 w-3" /> Recorded {item.agreement} · {fmtDate(item.reviewedAt)}
                      </span>
                    )}
                    {saving && <span className="text-[10.5px] text-gray-400">Saving…</span>}
                    {saveError && <span className="text-[10.5px] font-semibold text-red-600">{saveError}</span>}
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}

      {data?.warnings && data.warnings.length > 0 && data.available && (
        <div className="border-t px-4 py-2" style={{ borderColor: "var(--admin-border-soft, #EEF0F3)" }}>
          {data.warnings.map((w, i) => <p key={i} className="text-[11px] text-gray-400">· {w}</p>)}
        </div>
      )}
    </section>
  );
}
