"use client";

import { useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import Image from "next/image";
import {
  CalendarDays, Sparkles, RefreshCw, Clock,
  CheckCircle2, XCircle, Loader2, Circle,
  ExternalLink, TrendingUp, List, ChevronLeft, ChevronRight,
} from "lucide-react";
import { ManualPublishActions } from "@/components/ManualPublishActions";

type QueueItem = {
  id: string;
  image_url: string | null;
  product_url: string;
  board_name: string;
  caption: string | null;
  keyword: string | null;
  scheduled_at: string;
  status: "pending" | "processing" | "done" | "failed";
  error_message: string | null;
  pin_id: string | null;
};

type ApiResponse = { items: QueueItem[] } | { error: string };
type PageView = "list" | "calendar";

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = d.getTime() - now.getTime();
  const diffH = Math.round(diffMs / 3_600_000);
  if (Math.abs(diffH) < 1) return "< 1h";
  if (diffH > 0 && diffH < 24) return `In ${diffH}h`;
  if (diffH < 0 && diffH > -24) return `${Math.abs(diffH)}h ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

function getMondayOf(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay();
  d.setDate(d.getDate() - (day === 0 ? 6 : day - 1));
  d.setHours(0, 0, 0, 0);
  return d;
}

const STATUS_META = {
  pending:    { icon: Circle,       color: "#9CA3AF", bg: "#F3F4F6",               label: "Pending",    dot: "#9CA3AF" },
  processing: { icon: Loader2,      color: "#F59E0B", bg: "rgba(245,158,11,0.08)", label: "Processing", dot: "#F59E0B" },
  done:       { icon: CheckCircle2, color: "#10B981", bg: "rgba(16,185,129,0.08)", label: "Published",  dot: "#10B981" },
  failed:     { icon: XCircle,      color: "#EF4444", bg: "rgba(239,68,68,0.08)",  label: "Failed",     dot: "#EF4444" },
};

function StatusBadge({ status }: { status: QueueItem["status"] }) {
  const m = STATUS_META[status] ?? STATUS_META.pending;
  const Icon = m.icon;
  return (
    <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold"
      style={{ background: m.bg, color: m.color }}>
      <Icon className={`w-2.5 h-2.5 ${status === "processing" ? "animate-spin" : ""}`} />
      {m.label}
    </span>
  );
}

// ── List row ──────────────────────────────────────────────────────────────────
function QueueRow({ item, mutate }: { item: QueueItem; mutate: () => void }) {
  const domain = (() => {
    try { return new URL(item.product_url).hostname.replace(/^www\./, ""); }
    catch { return item.product_url; }
  })();

  const isPublishable = item.status === "pending" || item.status === "processing" || item.status === "failed";

  async function markPublished() {
    const resp = await fetch("/api/publish", {
      method:  "PATCH",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ id: item.id }),
    });
    if (!resp.ok) {
      const data = await resp.json() as { error?: string };
      throw new Error(data.error ?? "Update failed");
    }
    mutate();
  }

  return (
    <div className="flex items-center gap-4 px-6 py-4 border-b border-gray-100 hover:bg-gray-50/50 transition-colors">
      <div className="relative w-10 h-14 rounded-lg overflow-hidden shrink-0 bg-gray-100 border border-gray-200">
        {item.image_url
          ? <Image src={item.image_url} alt="" fill className="object-cover" unoptimized />
          : <div className="w-full h-full flex items-center justify-center">
              <Sparkles className="w-3.5 h-3.5 text-gray-300" />
            </div>
        }
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <StatusBadge status={item.status} />
          {item.keyword && (
            <span className="text-[11px] font-semibold text-gray-700 capitalize truncate max-w-[160px]">
              {item.keyword}
            </span>
          )}
        </div>
        <p className="text-[11px] text-gray-500 truncate">
          {item.board_name}
          {domain && <> · <span className="text-gray-400">{domain}</span></>}
        </p>
        {item.status === "failed" && item.error_message && (
          <p className="text-[10px] text-red-400 mt-0.5 truncate">{item.error_message}</p>
        )}
        {item.status === "done" && item.pin_id && (
          <a href={`https://www.pinterest.com/pin/${item.pin_id}/`} target="_blank" rel="noopener noreferrer"
            className="inline-flex items-center gap-0.5 text-[10px] text-[#C026D3] hover:underline mt-0.5">
            View on Pinterest <ExternalLink className="w-2.5 h-2.5" />
          </a>
        )}
      </div>

      {/* Manual publish actions */}
      <div className="flex items-center gap-3 shrink-0">
        {isPublishable && (
          <ManualPublishActions
            imageUrl={item.image_url}
            keyword={item.keyword}
            description={item.caption}
            affiliateLink={item.product_url}
            onMarkPublished={markPublished}
            compact
          />
        )}
        <div className="text-right">
          <p className="text-[11px] font-semibold text-gray-600">{fmtDate(item.scheduled_at)}</p>
          <p className="text-[10px] text-gray-400 mt-0.5">
            {new Date(item.scheduled_at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
          </p>
        </div>
      </div>
    </div>
  );
}

// ── Calendar chip (one item in a day cell) ────────────────────────────────────
function CalendarChip({ item }: { item: QueueItem }) {
  const m = STATUS_META[item.status] ?? STATUS_META.pending;
  return (
    <div className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 mb-1 last:mb-0 group/chip cursor-default"
      style={{ background: m.bg, border: `1px solid ${m.color}22` }}>
      <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: m.dot }} />
      <span className="text-[10px] font-semibold truncate" style={{ color: m.color }}>
        {item.keyword ?? item.board_name}
      </span>
      {item.status === "done" && item.pin_id && (
        <a href={`https://www.pinterest.com/pin/${item.pin_id}/`} target="_blank" rel="noopener noreferrer"
          onClick={e => e.stopPropagation()}
          className="ml-auto opacity-0 group-hover/chip:opacity-100 transition-opacity">
          <ExternalLink className="w-2.5 h-2.5" style={{ color: m.color }} />
        </a>
      )}
    </div>
  );
}

// ── Calendar view ─────────────────────────────────────────────────────────────
function CalendarView({ items }: { items: QueueItem[] }) {
  const [weekStart, setWeekStart] = useState(() => getMondayOf(new Date()));

  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart);
    d.setDate(weekStart.getDate() + i);
    return d;
  });

  const today = new Date();

  function prev() {
    setWeekStart(d => { const n = new Date(d); n.setDate(n.getDate() - 7); return n; });
  }
  function next() {
    setWeekStart(d => { const n = new Date(d); n.setDate(n.getDate() + 7); return n; });
  }

  const weekLabel = (() => {
    const end = days[6];
    const s = days[0];
    if (s.getMonth() === end.getMonth()) {
      return `${s.toLocaleDateString("en-US", { month: "long" })} ${s.getDate()}–${end.getDate()}, ${s.getFullYear()}`;
    }
    return `${s.toLocaleDateString("en-US", { month: "short", day: "numeric" })} – ${end.toLocaleDateString("en-US", { month: "short", day: "numeric" })}, ${end.getFullYear()}`;
  })();

  const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

  return (
    <div className="flex-1 flex flex-col bg-white">
      {/* Week nav */}
      <div className="flex items-center gap-3 px-6 py-3 border-b border-gray-100">
        <button type="button" onClick={prev}
          className="rounded-full p-1.5 hover:bg-gray-100 transition-colors text-gray-500">
          <ChevronLeft className="w-4 h-4" />
        </button>
        <span className="text-[13px] font-semibold text-gray-700 min-w-[220px] text-center">{weekLabel}</span>
        <button type="button" onClick={next}
          className="rounded-full p-1.5 hover:bg-gray-100 transition-colors text-gray-500">
          <ChevronRight className="w-4 h-4" />
        </button>
        <button type="button"
          onClick={() => setWeekStart(getMondayOf(new Date()))}
          className="ml-2 rounded-full px-3 py-1 text-[11px] font-semibold transition-colors"
          style={{ background: "rgba(192,38,211,0.08)", color: "#C026D3" }}>
          Today
        </button>
      </div>

      {/* Day columns */}
      <div className="flex flex-1 divide-x divide-gray-100 overflow-y-auto">
        {days.map((day, i) => {
          const isToday = isSameDay(day, today);
          const dayItems = items.filter(item => isSameDay(new Date(item.scheduled_at), day));
          const studioLink = `/app/studio`;

          return (
            <div key={i} className="flex-1 flex flex-col min-w-0"
              style={isToday ? { background: "rgba(8,145,178,0.02)" } : undefined}>
              {/* Day header */}
              <div className="px-2 py-2 border-b border-gray-100 text-center shrink-0">
                <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-400">
                  {DAY_LABELS[i]}
                </p>
                <p
                  className={`text-[15px] font-black mt-0.5 leading-none w-7 h-7 mx-auto flex items-center justify-center rounded-full ${isToday ? "text-white" : "text-gray-800"}`}
                  style={isToday ? { background: "#C026D3" } : undefined}
                >
                  {day.getDate()}
                </p>
              </div>

              {/* Items */}
              <div className="flex-1 p-2 overflow-y-auto">
                {dayItems.map(item => (
                  <CalendarChip key={item.id} item={item} />
                ))}

                {/* Add pin CTA */}
                <Link href={studioLink}
                  className="flex items-center justify-center gap-1 w-full rounded-lg py-1.5 mt-1 opacity-0 hover:opacity-100 transition-opacity no-underline group/add"
                  style={{ border: "1px dashed #E5E7EB" }}
                  title="Create a pin for this day">
                  <span className="text-[10px] font-semibold text-gray-300 group-hover/add:text-[#C026D3] transition-colors">
                    + Create
                  </span>
                </Link>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function QueuePage() {
  const [view, setView] = useState<PageView>("calendar");
  const [tab,  setTab]  = useState<"upcoming" | "done" | "failed">("upcoming");

  const { data, error, isLoading, mutate } = useSWR<ApiResponse>(
    "publish-queue",
    () => fetch("/api/publish").then(r => r.json()),
    { revalidateOnFocus: true, refreshInterval: 30_000 },
  );

  const items: QueueItem[] = "items" in (data ?? {}) ? (data as { items: QueueItem[] }).items : [];
  const pending = items.filter(i => i.status === "pending" || i.status === "processing");
  const done    = items.filter(i => i.status === "done");
  const failed  = items.filter(i => i.status === "failed");
  const tabItems = tab === "upcoming" ? pending : tab === "done" ? done : failed;

  const apiError      = !isLoading && data && "error" in data ? (data as { error: string }).error : null;
  const tableNotExist = apiError?.includes("publishing_queue");

  return (
    <div className="app-page min-h-screen flex flex-col">
      {/* Header */}
      <div className="px-6 py-5 bg-white border-b border-gray-200 flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Content Calendar</h1>
          <p className="text-sm text-gray-500 mt-0.5">Plan · Schedule · Publish</p>
        </div>
        <div className="flex items-center gap-3">
          {/* View toggle */}
          <div className="flex items-center gap-0.5 bg-gray-100 rounded-full p-0.5">
            {([
              { id: "calendar" as PageView, Icon: CalendarDays, label: "Calendar" },
              { id: "list"     as PageView, Icon: List,         label: "List"     },
            ]).map(({ id, Icon, label }) => (
              <button key={id} type="button" onClick={() => setView(id)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-semibold transition-all"
                style={view === id
                  ? { background: "#fff", color: "#C026D3", boxShadow: "0 1px 3px rgba(0,0,0,0.08)" }
                  : { color: "#9CA3AF" }}>
                <Icon className="w-3.5 h-3.5" /> {label}
              </button>
            ))}
          </div>

          {pending.length > 0 && (
            <span className="text-[11px] font-bold rounded-full px-2.5 py-1"
              style={{ background: "rgba(192,38,211,0.08)", color: "#C026D3" }}>
              {pending.length} pending
            </span>
          )}
          <button type="button" onClick={() => mutate()}
            className="rounded-full p-2 hover:bg-gray-100 transition-colors text-gray-400 hover:text-gray-600"
            title="Refresh">
            <RefreshCw className={`w-4 h-4 ${isLoading ? "animate-spin" : ""}`} />
          </button>
          <Link href="/app/studio"
            className="flex items-center gap-1.5 px-4 py-2 rounded-full text-[13px] font-bold text-white no-underline transition-all hover:brightness-105"
            style={{ background: "linear-gradient(135deg, #FF4D8D 0%, #D946EF 52%, #7C3AED 100%)" }}>
            <Sparkles className="w-3.5 h-3.5" /> Create Pin
          </Link>
        </div>
      </div>

      {/* Table-not-exist state */}
      {tableNotExist ? (
        <div className="flex-1 flex items-center justify-center px-6 py-16">
          <div className="max-w-sm w-full text-center">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl mb-5"
              style={{ background: "rgba(192,38,211,0.08)" }}>
              <CalendarDays className="w-8 h-8 text-[#C026D3]" />
            </div>
            <h2 className="text-lg font-semibold text-gray-900 mb-2">Queue not set up yet</h2>
            <p className="text-sm text-gray-500 mb-4 leading-relaxed">
              The <code className="text-xs bg-gray-100 px-1.5 py-0.5 rounded">publishing_queue</code> table
              needs to be created in Supabase first.
            </p>
            <p className="text-xs text-gray-400">
              Run the SQL from the error response of <code className="bg-gray-100 px-1 py-0.5 rounded">POST /api/publish</code>.
            </p>
          </div>
        </div>
      ) : view === "calendar" ? (
        /* ── Calendar view ───────────────────────────────────────────────── */
        <div className="flex-1 flex flex-col overflow-hidden">
          {items.length === 0 && !isLoading && (
            <div className="px-6 py-3 bg-amber-50 border-b border-amber-100 flex items-center gap-2">
              <span className="text-[11px] text-amber-700 font-semibold">
                No scheduled pins yet — generate a pin in Studio, fill in the product URL, then click Schedule to Pinterest.
              </span>
              <Link href="/app/studio" className="ml-auto text-[11px] font-bold no-underline"
                style={{ color: "#C026D3" }}>
                Open Studio →
              </Link>
            </div>
          )}
          <CalendarView items={items} />
        </div>
      ) : (
        /* ── List view ───────────────────────────────────────────────────── */
        <div className="flex-1 flex flex-col">
          {/* Status tabs */}
          <div className="px-6 py-3 bg-white border-b border-gray-100 flex items-center gap-6">
            {[
              { key: "upcoming" as const, label: "Upcoming", count: pending.length, color: "#C026D3" },
              { key: "done"     as const, label: "Published", count: done.length,   color: "#10B981" },
              { key: "failed"   as const, label: "Failed",    count: failed.length, color: "#EF4444" },
            ].map(t => (
              <button key={t.key} type="button" onClick={() => setTab(t.key)}
                className="flex items-center gap-2 text-sm font-semibold transition-colors pb-0.5"
                style={{
                  color: tab === t.key ? t.color : "#9CA3AF",
                  borderBottom: tab === t.key ? `2px solid ${t.color}` : "2px solid transparent",
                }}>
                {t.label}
                <span className="text-[10px] font-bold rounded-full px-1.5 py-0.5"
                  style={{
                    background: tab === t.key ? `${t.color}15` : "#F3F4F6",
                    color: tab === t.key ? t.color : "#9CA3AF",
                  }}>
                  {t.count}
                </span>
              </button>
            ))}
            <div className="ml-auto flex items-center gap-1.5 text-[10px] text-gray-400">
              <Clock className="w-3 h-3" /> Auto-refreshes every 30s
            </div>
          </div>

          {/* Rows */}
          <div className="flex-1 bg-white">
            {isLoading && (
              <div>
                {[1, 2, 3, 4].map(i => (
                  <div key={i} className="flex items-center gap-4 px-6 py-4 border-b border-gray-100">
                    <div className="w-10 h-14 rounded-lg bg-gray-100 animate-pulse shrink-0" />
                    <div className="flex-1 space-y-2">
                      <div className="h-3 bg-gray-100 rounded animate-pulse w-32" />
                      <div className="h-2.5 bg-gray-100 rounded animate-pulse w-48" />
                    </div>
                    <div className="h-3 bg-gray-100 rounded animate-pulse w-16" />
                  </div>
                ))}
              </div>
            )}
            {!isLoading && tabItems.length === 0 && (
              <div className="py-16 text-center">
                {items.length === 0 ? (
                  <div className="max-w-sm mx-auto">
                    <CalendarDays className="w-10 h-10 text-gray-200 mx-auto mb-3" />
                    <p className="text-sm text-gray-500 mb-4">
                      Generate a pin in Studio, fill in product URL + caption, then click Schedule.
                    </p>
                    <div className="flex gap-3 justify-center">
                      <Link href="/app/studio"
                        className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full text-sm font-bold text-white no-underline"
                        style={{ background: "linear-gradient(135deg, #FF4D8D 0%, #D946EF 52%, #7C3AED 100%)" }}>
                        <Sparkles className="w-3.5 h-3.5" /> Open Studio
                      </Link>
                      <Link href="/app/trends"
                        className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full text-sm font-medium text-gray-600 bg-white border border-gray-200 hover:bg-gray-50 transition-colors no-underline">
                        <TrendingUp className="w-3.5 h-3.5" /> Browse Trends
                      </Link>
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-gray-400">No {tab} pins.</p>
                )}
              </div>
            )}
            {!isLoading && tabItems.map(item => <QueueRow key={item.id} item={item} mutate={mutate} />)}
          </div>
        </div>
      )}
    </div>
  );
}
