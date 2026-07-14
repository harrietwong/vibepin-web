"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { createBrowserClient } from "@supabase/ssr";
import { Layers, Sparkles, BarChart2, ArrowRight } from "lucide-react";
import { getWeekStart, formatWeekLabel } from "@/lib/useWeeklyPlan";
import { useLocale } from "@/lib/i18n/LocaleProvider";

const supabase = createBrowserClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
);

export default function DashboardPage() {
  const { t: tr } = useLocale();
  const [plan, setPlan] = useState<any>(null);
  const [items, setItems] = useState<any[]>([]);
  const [signalCount, setSignalCount] = useState<number | null>(null);
  const [topCategory, setTopCategory] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { setLoading(false); return; }

      const weekStart = getWeekStart();

      const [planRes, signalRes] = await Promise.all([
        supabase
          .from("weekly_plans")
          .select("*")
          .eq("user_id", user.id)
          .eq("week_start", weekStart)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
        supabase
          .from("trend_keywords")
          .select("id, category", { count: "exact" })
          .eq("status", "active")
          .limit(200),
      ]);

      const planData = planRes.data ?? null;
      setPlan(planData);

      if (planData?.id) {
        const { data: itemsData } = await supabase
          .from("weekly_plan_items")
          .select("id, generated_asset_id, keyword, status")
          .eq("plan_id", planData.id);
        setItems(itemsData ?? []);
      }

      setSignalCount(signalRes.count ?? 0);

      const cats = (signalRes.data ?? []).map((r: any) => r.category).filter(Boolean);
      if (cats.length > 0) {
        const freq: Record<string, number> = {};
        for (const c of cats) freq[c] = (freq[c] ?? 0) + 1;
        setTopCategory(Object.entries(freq).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null);
      }

      setLoading(false);
    }
    load();
  }, []);

  const selectedCount = items.length;
  const targetCount   = plan?.target_count ?? 7;
  const createdCount  = items.filter(i => i.generated_asset_id != null).length;
  const planStatus    = plan?.status ?? null;

  const workspaceHref = plan?.category
    ? `/app/workspace/${encodeURIComponent(plan.category)}`
    : "/app/studio";

  return (
    <div className="h-full overflow-y-auto bg-[#F7F8FA]">
      <div className="max-w-[680px] mx-auto px-6 py-10">

        <p className="text-[11px] font-semibold uppercase tracking-widest text-gray-400 mb-1">{tr("dashboard.overview")}</p>
        <h1 className="text-2xl font-black text-gray-900 tracking-tight mb-8">{tr("dashboard.weeklyProgress")}</h1>

        <div className="space-y-4">

          {/* Block 1 — Current Weekly Plan */}
          <div className="bg-white rounded-2xl border border-gray-200 p-5">
            <div className="flex items-center gap-2 mb-4">
              <Layers className="h-4 w-4 text-gray-400" />
              <span className="text-[10px] font-bold uppercase tracking-widest text-gray-400">{tr("dashboard.currentWeeklyPlan")}</span>
            </div>

            {loading ? (
              <div className="h-14 animate-pulse bg-gray-100 rounded-xl" />
            ) : plan ? (
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-[28px] font-black text-gray-900 tabular-nums leading-none">
                    {selectedCount}
                    <span className="text-[16px] font-semibold text-gray-400"> / {targetCount}</span>
                  </p>
                  <p className="text-[11px] text-gray-400 mt-1 capitalize">
                    {plan.category} · {formatWeekLabel(plan.week_start)}
                  </p>
                  <span className={`mt-2 inline-block text-[9px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-full ${
                    planStatus === "ready"
                      ? "bg-emerald-50 text-emerald-600"
                      : "bg-amber-50 text-amber-600"
                  }`}>
                    {planStatus === "ready" ? tr("dashboard.statusReady") : tr("dashboard.statusDraft")}
                  </span>
                </div>
                <Link
                  href={planStatus === "ready" ? "/app/plan" : workspaceHref}
                  className="no-underline shrink-0 flex items-center gap-1.5 rounded-full px-4 py-2 text-[12px] font-semibold text-white"
                  style={{ background: "linear-gradient(135deg, #FF4D8D 0%, #D946EF 52%, #7C3AED 100%)" }}
                >
                  {planStatus === "ready" ? tr("dashboard.openWeeklyPlan") : tr("dashboard.continueWorkspace")}
                  <ArrowRight className="h-3.5 w-3.5" />
                </Link>
              </div>
            ) : (
              <div className="flex items-center justify-between gap-4">
                <p className="text-[13px] text-gray-400">{tr("dashboard.noPlanThisWeek")}</p>
                <Link
                  href={workspaceHref}
                  className="no-underline shrink-0 flex items-center gap-1.5 rounded-full px-4 py-2 text-[12px] font-semibold"
                  style={{ background: "transparent", color: "#6B7280", border: "1px solid #E5E7EB" }}
                >
                  {tr("dashboard.continueCreating")} <ArrowRight className="h-3.5 w-3.5" />
                </Link>
              </div>
            )}
          </div>

          {/* Block 2 — Create Progress */}
          <div className="bg-white rounded-2xl border border-gray-200 p-5">
            <div className="flex items-center gap-2 mb-4">
              <Sparkles className="h-4 w-4 text-gray-400" />
              <span className="text-[10px] font-bold uppercase tracking-widest text-gray-400">{tr("dashboard.createProgress")}</span>
            </div>

            {loading ? (
              <div className="h-14 animate-pulse bg-gray-100 rounded-xl" />
            ) : (
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-[28px] font-black text-gray-900 tabular-nums leading-none">
                    {createdCount}
                    <span className="text-[16px] font-semibold text-gray-400"> / {selectedCount || targetCount}</span>
                  </p>
                  <p className="text-[11px] text-gray-400 mt-1">{tr("dashboard.pinsCreatedThisWeek")}</p>
                </div>
                <Link
                  href="/app/studio"
                  className="no-underline shrink-0 flex items-center gap-1.5 rounded-full px-4 py-2 text-[12px] font-semibold"
                  style={{ background: "transparent", color: "#6B7280", border: "1px solid #E5E7EB" }}
                >
                  {tr("dashboard.continueCreating")} <ArrowRight className="h-3.5 w-3.5" />
                </Link>
              </div>
            )}
          </div>

          {/* Block 3 — New Signals */}
          <div className="bg-white rounded-2xl border border-gray-200 p-5">
            <div className="flex items-center gap-2 mb-4">
              <BarChart2 className="h-4 w-4 text-gray-400" />
              <span className="text-[10px] font-bold uppercase tracking-widest text-gray-400">{tr("dashboard.newSignals")}</span>
            </div>

            {loading ? (
              <div className="h-14 animate-pulse bg-gray-100 rounded-xl" />
            ) : (
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-[28px] font-black text-gray-900 tabular-nums leading-none">
                    {signalCount ?? "—"}
                  </p>
                  <p className="text-[11px] text-gray-400 mt-1">
                    {topCategory
                      ? <>{tr("dashboard.activeOpportunitiesTopPrefix")}<span className="capitalize font-medium text-gray-600">{topCategory}</span></>
                      : tr("dashboard.activeOpportunitiesThisWeek")}
                  </p>
                </div>
                <Link
                  href={workspaceHref}
                  className="no-underline shrink-0 flex items-center gap-1.5 rounded-full px-4 py-2 text-[12px] font-semibold"
                  style={{ background: "transparent", color: "#6B7280", border: "1px solid #E5E7EB" }}
                >
                  {plan?.category ? tr("dashboard.viewWorkspace") : tr("dashboard.continueCreating")} <ArrowRight className="h-3.5 w-3.5" />
                </Link>
              </div>
            )}
          </div>

        </div>
      </div>
    </div>
  );
}
