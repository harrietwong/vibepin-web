"use client";

import { useState, useEffect } from "react";
import useSWR from "swr";
import { createBrowserClient } from "@supabase/ssr";

// ── Helpers ───────────────────────────────────────────────────────────────────

function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}

// Returns the Monday of the current week as "YYYY-MM-DD"
export function getWeekStart(): string {
  const d   = new Date();
  const day = d.getDay(); // 0=Sun … 6=Sat
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d.toISOString().split("T")[0];
}

// "Week of May 26" label
export function formatWeekLabel(weekStart: string): string {
  const d = new Date(weekStart + "T00:00:00");
  return `Week of ${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
}

// sort_order → date within the week (0=Mon … 6=Sun, wraps for 14/21 plans)
function sortOrderToDate(order: number, weekStart: string): string {
  const d = new Date(weekStart + "T00:00:00");
  d.setDate(d.getDate() + (order % 7));
  return d.toISOString().split("T")[0];
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type WeeklyPlanItem = {
  id: string;
  plan_id: string;
  user_id: string;
  keyword_id: string;
  keyword: string;
  category: string;
  tier: string;
  score: number | null;
  planned_date: string | null;
  sort_order: number;
  status: string;
  generated_asset_id: string | null;
  created_at: string;
};

type WeeklyPlan = {
  id: string;
  user_id: string;
  category: string;
  week_start: string;
  target_count: number;
  status: string;
};

export type AddToWeeklyPlanInput = {
  keyword_id: string;
  keyword: string;
  tier: string;
  score: number | null;
};

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useWeeklyPlan(category: string, targetCount: number = 7) {
  const weekStart = getWeekStart();
  const supabase  = createClient();

  // ── Auth: resolve userId before any DB writes ─────────────────────────────
  const [userId, setUserId]       = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setUserId(data.user?.id ?? null);
      setAuthLoading(false);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Read current week's plan (wait for auth) ──────────────────────────────
  // Key includes userId so SWR caches per-user and never fetches before auth
  const planKey = userId
    ? `weekly-plan:${category}:${weekStart}:${userId}`
    : null;

  const {
    data: plan,
    mutate: mutatePlan,
  } = useSWR<WeeklyPlan | null>(planKey, async () => {
    const { data } = await supabase
      .from("weekly_plans")
      .select("*")
      .eq("category", category)
      .eq("week_start", weekStart)
      .maybeSingle();
    return (data as WeeklyPlan | null) ?? null;
  }, { revalidateOnFocus: false });

  // ── Read items (only when plan exists) ───────────────────────────────────
  const itemsKey = plan?.id ? `weekly-plan-items:${plan.id}` : null;
  const {
    data: items = [],
    mutate: mutateItems,
  } = useSWR<WeeklyPlanItem[]>(itemsKey, async () => {
    const { data } = await supabase
      .from("weekly_plan_items")
      .select("*")
      .eq("plan_id", plan!.id)
      .order("sort_order", { ascending: true });
    return (data ?? []) as WeeklyPlanItem[];
  }, { revalidateOnFocus: false });

  // Effective target: respect what was stored on the plan (e.g. if plan was
  // created with 14, honour that even if caller passes 7 again)
  const effectiveTargetCount = plan?.target_count ?? targetCount;

  const selectedCount = items.length;
  const isSelected    = (keywordId: string) =>
    items.some(i => i.keyword_id === keywordId);

  // ── Add to weekly plan ────────────────────────────────────────────────────
  // Returns null on success, error message string on failure
  async function addToWeeklyPlan(item: AddToWeeklyPlanInput): Promise<string | null> {
    if (!userId) return "Not logged in";
    if (selectedCount >= effectiveTargetCount) return "Plan is full";

    // Upsert the plan row (idempotent via unique constraint)
    const { data: p, error: planErr } = await supabase
      .from("weekly_plans")
      .upsert(
        {
          user_id:      userId,        // required for NOT NULL + RLS
          category,
          week_start:   weekStart,
          target_count: targetCount,
          status:       "planning",
        },
        { onConflict: "user_id,category,week_start" }
      )
      .select("id")
      .single();

    if (planErr || !p) {
      return planErr?.message ?? "Failed to create plan";
    }

    // Stable sort_order: max existing + 1 avoids collisions after removals
    const nextOrder = items.length > 0
      ? Math.max(...items.map(i => i.sort_order)) + 1
      : 0;

    const { error: itemErr } = await supabase
      .from("weekly_plan_items")
      .upsert(
        {
          plan_id:    p.id,
          user_id:    userId,          // required for NOT NULL + RLS
          keyword_id: item.keyword_id,
          keyword:    item.keyword,
          category,
          tier:       item.tier,
          score:      item.score,
          sort_order: nextOrder,
          status:     "planned",
        },
        { onConflict: "plan_id,keyword_id" }
      );

    if (itemErr) return itemErr.message;

    await mutatePlan();
    await mutateItems();
    return null;
  }

  // ── Remove from weekly plan ───────────────────────────────────────────────
  async function removeFromWeeklyPlan(keywordId: string): Promise<string | null> {
    if (!plan) return "No plan exists";
    const { error } = await supabase
      .from("weekly_plan_items")
      .delete()
      .eq("plan_id", plan.id)
      .eq("keyword_id", keywordId);
    if (error) return error.message;
    await mutateItems();
    return null;
  }

  // ── Build plan: assign planned_dates + mark ready ─────────────────────────
  async function buildWeeklyPlan(): Promise<string | null> {
    if (!plan) return "No plan exists";
    if (selectedCount < effectiveTargetCount) {
      return `Need ${effectiveTargetCount - selectedCount} more keyword${effectiveTargetCount - selectedCount !== 1 ? "s" : ""}`;
    }

    // Assign planned_date where missing
    for (const item of items.filter(i => !i.planned_date)) {
      const { error } = await supabase
        .from("weekly_plan_items")
        .update({ planned_date: sortOrderToDate(item.sort_order, weekStart) })
        .eq("id", item.id);
      if (error) return error.message;
    }

    const { error } = await supabase
      .from("weekly_plans")
      .update({ status: "ready", updated_at: new Date().toISOString() })
      .eq("id", plan.id);

    if (error) return error.message;

    await mutatePlan();
    await mutateItems();
    return null;
  }

  return {
    plan,
    items,
    selectedCount,
    targetCount:    effectiveTargetCount,
    weekStart,
    isSelected,
    addToWeeklyPlan,
    removeFromWeeklyPlan,
    buildWeeklyPlan,
    isPlanReady:    plan?.status === "ready",
    weekLabel:      formatWeekLabel(weekStart),
    userId,
    authLoading,
  };
}
