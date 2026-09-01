"use client";

/**
 * The "Usage & Plan" body for Customer 360 — the one place a per-user allowance
 * is rendered, so the card and any future surface cannot describe the same state
 * differently.
 *
 * The whole point of this component is that THREE different situations look
 * different on screen:
 *
 *   metered      real measured numbers. A measured 0 is drawn as 0 with a bar at
 *                0% — that is a fact about the user, not missing data.
 *   unmetered    the read succeeded and the user simply has no usage account yet.
 *                No bar is drawn at all (there is no measured fraction to draw),
 *                and the plan's included allowance is shown instead, labelled.
 *   unavailable  the read failed. Shown as a sync error. Never as zeros, never as
 *                "not metered" — "we could not look" is a different claim from
 *                "we looked and there was nothing".
 *
 * Two derived values are deliberately NOT collapsed into one: remaining
 * (max(limit-used,0)) and overage (used-limit). Folding an overage into a
 * remaining of 0 would hide that the user went past their cap, which is exactly
 * the case an operator opened this page to find.
 */

import { AlertTriangle, Infinity as InfinityIcon } from "lucide-react";
import { AdminT, AdminTFmt } from "../AdminT";
import { USAGE_METRIC_KEY } from "@/lib/admin/adminConsoleKeys";
import { USAGE_METRIC_KEYS, type UsageMetricView, type UsageSummaryView } from "@/lib/server/adminUsage";

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" }).format(new Date(t));
}

/**
 * Bar fill is clamped to 100% so an over-limit row still renders sanely; the
 * overage is reported as its own number rather than as an overflowing bar.
 */
function BarRow({ metric }: { metric: UsageMetricView }) {
  const label = <AdminT k={USAGE_METRIC_KEY[metric.key]} />;

  // Not measured (unmetered / unavailable): show what the plan includes, and
  // draw no bar — a bar implies a measured fraction we do not have.
  if (metric.used === null) {
    return (
      <div className="px-4 py-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="text-[12.5px] font-bold text-gray-900">{label}</span>
          <span className="text-[12px] text-gray-500">
            {metric.included === null ? (
              <AdminT k="usage.included.unlimited" />
            ) : (
              <AdminTFmt k="usage.included" vars={{ n: metric.included.toLocaleString() }} />
            )}
          </span>
        </div>
      </div>
    );
  }

  const pct = metric.ratio === null ? null : Math.min(Math.round(metric.ratio * 1000) / 10, 100);
  const tone =
    metric.overage !== null ? "#B91C1C" : metric.ratio !== null && metric.ratio >= 0.8 ? "#B45309" : "#4338CA";

  return (
    <div className="px-4 py-3">
      <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-[12.5px] font-bold text-gray-900">{label}</span>
        <span className="text-[12px] text-gray-500">
          <strong className="text-gray-900">{metric.used.toLocaleString()}</strong>
          {" / "}
          {metric.unlimited ? (
            <span className="inline-flex items-center gap-1 font-semibold text-gray-700">
              <InfinityIcon className="h-3.5 w-3.5" />
              <AdminT k="usage.unlimited" />
            </span>
          ) : (
            (metric.limit ?? 0).toLocaleString()
          )}
          {metric.remaining !== null && (
            <>
              {" · "}
              <AdminTFmt k="usage.remaining" vars={{ n: metric.remaining.toLocaleString() }} />
            </>
          )}
          {metric.overage !== null && (
            <>
              {" · "}
              <strong style={{ color: "#B91C1C" }}>
                <AdminTFmt k="usage.overage" vars={{ n: metric.overage.toLocaleString() }} />
              </strong>
            </>
          )}
        </span>
      </div>
      {metric.showProgress && pct !== null && (
        <div className="h-2 w-full overflow-hidden rounded-full" style={{ background: "#F1F5F9" }}>
          <div className="h-full rounded-full" style={{ width: `${pct}%`, background: tone }} />
        </div>
      )}
    </div>
  );
}

export function UsagePanel({ summary }: { summary: UsageSummaryView }) {
  const isMetered = summary.state === "metered";

  return (
    <>
      {/* State banner — only for the two non-normal states, each worded so the
          operator can tell "nothing measured" from "measurement failed". */}
      {summary.state === "unmetered" && (
        <div className="flex items-start gap-2 border-b px-4 py-2.5 text-[12px]" style={{ borderColor: "#EEF0F3", background: "rgba(107,114,128,0.05)", color: "#4B5563" }}>
          <span className="mt-px shrink-0 rounded-full px-2 py-0.5 text-[10px] font-black uppercase" style={{ background: "rgba(107,114,128,0.14)", color: "#4B5563" }}>
            <AdminT k="usage.badge.unmetered" />
          </span>
          <span><AdminT k="usage.state.unmetered" /></span>
        </div>
      )}
      {summary.state === "unavailable" && (
        <div className="flex items-start gap-2 border-b px-4 py-2.5 text-[12px]" style={{ borderColor: "#EEF0F3", background: "rgba(245,158,11,0.08)", color: "#92400E" }}>
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
          <span className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-black uppercase" style={{ background: "rgba(245,158,11,0.18)", color: "#92400E" }}>
            <AdminT k="usage.badge.unavailable" />
          </span>
          <span><AdminT k="usage.state.unavailable" /></span>
        </div>
      )}

      {/* Plan drift: shown, never silently resolved. */}
      {summary.planDrift && summary.accountPlan && summary.appMetadataPlan && (
        <div className="border-b px-4 py-2.5 text-[12px]" style={{ borderColor: "#EEF0F3", background: "rgba(99,102,241,0.06)", color: "#4338CA" }}>
          <AdminTFmt k="usage.planDrift" vars={{ account: summary.accountPlan, app: summary.appMetadataPlan }} />
        </div>
      )}

      <dl className="grid grid-cols-1 gap-px sm:grid-cols-2" style={{ background: "#E5E7EB" }}>
        <div className="px-4 py-3" style={{ background: "#FFFFFF" }}>
          <dt className="text-[11px] font-bold uppercase" style={{ color: "#6B7280" }}><AdminT k="usage.plan" /></dt>
          <dd className="mt-1 font-semibold capitalize" style={{ color: "#111827" }}>{summary.plan}</dd>
        </div>
        <div className="px-4 py-3" style={{ background: "#FFFFFF" }}>
          <dt className="text-[11px] font-bold uppercase" style={{ color: "#6B7280" }}><AdminT k="usage.period" /></dt>
          <dd className="mt-1 font-semibold" style={{ color: "#111827" }}>
            {isMetered && summary.periodStart && summary.periodEnd
              ? `${fmtDate(summary.periodStart)} – ${fmtDate(summary.periodEnd)}`
              : <span className="text-gray-400"><AdminT k="usage.period.none" /></span>}
          </dd>
        </div>
      </dl>

      <div className="divide-y" style={{ borderColor: "#F3F4F6" }}>
        {USAGE_METRIC_KEYS.map(k => <BarRow key={k} metric={summary.metrics[k]} />)}
      </div>

      {/* Bonus grant: hidden at 0 (PRD 3.1) — an always-visible "0 bonus" row is
          noise on every account that never received a grant. */}
      {isMetered && summary.bonusImages !== null && summary.bonusImages > 0 && (
        <div className="flex items-baseline justify-between gap-2 border-t px-4 py-3" style={{ borderColor: "#F3F4F6" }}>
          <span className="text-[12.5px] font-bold text-gray-900"><AdminT k="usage.bonusImages" /></span>
          <span className="text-[12px] font-semibold text-gray-900">{summary.bonusImages.toLocaleString()}</span>
        </div>
      )}

      {summary.anomalies.length > 0 && (
        <p className="border-t px-4 py-2 text-[11px] text-amber-700" style={{ borderColor: "#F3F4F6" }}>
          <AdminTFmt k="usage.anomaly" vars={{ codes: summary.anomalies.join(", ") }} />
        </p>
      )}

      <p className="border-t px-4 py-2 text-[11px] text-gray-400" style={{ borderColor: "#F3F4F6" }}>
        <AdminT k="usage.footer" />
      </p>
    </>
  );
}
