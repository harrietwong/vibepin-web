"use client";

import {
  LineChart, Line, XAxis, YAxis, Tooltip,
  ResponsiveContainer, ReferenceLine,
} from "recharts";
import { useLocale } from "@/lib/i18n/LocaleProvider";

export type TrendPoint = { date: string; value: number };

// ── Mini sparkline (used in table rows) ──────────────────────────────────────

export function TrendSparkline({
  data,
  color = "#E60023",
  height = 36,
}: {
  data: TrendPoint[];
  color?: string;
  height?: number;
}) {
  if (!data || data.length < 2) return null;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 2, right: 2, left: 2, bottom: 2 }}>
        <Line
          type="monotone"
          dataKey="value"
          stroke={color}
          strokeWidth={1.5}
          dot={false}
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

// ── Full chart (used in keyword detail / expanded view) ──────────────────────

const MONTH_ABBR = ["Jan","Feb","Mar","Apr","May","Jun",
                    "Jul","Aug","Sep","Oct","Nov","Dec"];

function formatDate(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00Z");
  return `${MONTH_ABBR[d.getUTCMonth()]} '${String(d.getUTCFullYear()).slice(2)}`;
}

export function TrendHistoryChart({
  trendHistory,
  label,
}: {
  trendHistory: TrendPoint[] | null | undefined;
  label?: string;
}) {
  const { t: tr } = useLocale();
  if (!trendHistory || trendHistory.length < 6) {
    return (
      <div className="flex items-center justify-center py-4 text-[11px] text-gray-400">
        {tr("trendChart.noData")}
      </div>
    );
  }

  // Sample every 4th point for X-axis labels (≈monthly ticks)
  const tickIndices = new Set(
    trendHistory
      .map((_, i) => i)
      .filter(i => i % 4 === 0 || i === trendHistory.length - 1)
  );

  const latest = trendHistory[trendHistory.length - 1];
  const oldest = trendHistory[0];
  const midpoint = trendHistory[Math.floor(trendHistory.length / 2)];
  const direction = latest.value >= oldest.value ? "rising" : "falling";
  const dirColor  = direction === "rising" ? "#059669" : "#DC2626";

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-bold uppercase tracking-widest text-gray-400">
            {label ?? tr("trendChart.defaultLabel")}
          </span>
          <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded-full"
            style={{
              background: direction === "rising" ? "rgba(5,150,105,0.1)" : "rgba(220,38,38,0.1)",
              color: dirColor,
            }}>
            {direction === "rising" ? tr("trendChart.rising") : tr("trendChart.falling")}
          </span>
        </div>
        <span className="text-[10px] font-bold tabular-nums" style={{ color: dirColor }}>
          {latest.value}
        </span>
      </div>

      {/* Chart */}
      <ResponsiveContainer width="100%" height={72}>
        <LineChart data={trendHistory} margin={{ top: 4, right: 4, left: -30, bottom: 0 }}>
          <XAxis
            dataKey="date"
            tickFormatter={v => tickIndices.has(trendHistory.findIndex(d => d.date === v))
              ? formatDate(v) : ""}
            tick={{ fontSize: 8, fill: "#9CA3AF" }}
            axisLine={false}
            tickLine={false}
            interval={0}
          />
          <YAxis domain={[0, 100]} hide />
          <ReferenceLine y={midpoint.value} stroke="#E5E7EB" strokeDasharray="3 3" />
          <Tooltip
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const pt = payload[0].payload as TrendPoint;
              return (
                <div style={{
                  background: "#fff", border: "1px solid #E5E7EB",
                  borderRadius: 6, padding: "4px 8px", fontSize: 10,
                }}>
                  <p style={{ color: "#374151", fontWeight: 600 }}>{formatDate(pt.date)}</p>
                  <p style={{ color: "#E60023" }}>{tr("trendChart.tooltip.indexPrefix")}{pt.value}</p>
                </div>
              );
            }}
          />
          <Line
            type="monotone"
            dataKey="value"
            stroke="#E60023"
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 3, fill: "#E60023" }}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>

      {/* Footer note */}
      <p className="text-[9px] text-gray-400 mt-0.5">
        {tr("trendChart.footerNote")}
      </p>
    </div>
  );
}
