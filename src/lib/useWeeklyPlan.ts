"use client";

import { useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { createBrowserClient } from "@supabase/ssr";
import { useSessionUser } from "@/lib/useSessionUser";
import { logPlanStep, logPlanTiming } from "@/lib/planLoadTiming";

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
  // Create the Supabase client ONCE per hook mount, not on every render. This hook
  // lives inside the Plan page, which re-renders many times during the OAuth-return
  // sequence (hydrated / category / restoreNotice / calendarEditDraft all flip in
  // quick succession) — `createBrowserClient()` on every render meant every one of
  // those renders spun up an independent client instance, each with its own
  // internal auth-session bookkeeping. Right after a full-page reload from OAuth
  // (the exact moment the stored session token is most likely to need a refresh),
  // that adds up to redundant, possibly-serialized session-refresh work across
  // instances — a very plausible contributor to the multi-second "plan row ready"
  // delay this file's [Plan timing] logs are instrumented to catch. One instance,
  // reused for the hook's lifetime, is strictly correct and cannot be slower.
  const [supabase] = useState(() => createClient());

  // Dev-only: elapsed-time reference for the [Plan Load] instrumentation below.
  // `useState`'s lazy initializer runs exactly once (on this hook instance's
  // first render), which is the React-blessed way to capture a one-time
  // impure value — unlike computing it inline during render.
  const [mountedAt] = useState(() => performance.now());
  const loggedRef = useRef({ session: false, plan: false, items: false });

  // ── Auth: resolve userId before any DB writes ─────────────────────────────
  // Shared SWR cache (web/src/lib/useSessionUser.ts) — the app shell
  // (web/src/app/app/layout.tsx) already resolves this once per session, so
  // navigating here normally reads it from cache instead of firing a second
  // `auth.getUser()` round trip before the plan/items SWR keys can even start.
  const { user: sessionUser, loading: authLoading } = useSessionUser();
  const userId = sessionUser?.id ?? null;

  useEffect(() => {
    if (!authLoading && !loggedRef.current.session) {
      loggedRef.current.session = true;
      logPlanStep("session user ready", performance.now() - mountedAt, `userPresent=${!!userId}`);
      logPlanTiming("auth ready", performance.now() - mountedAt, `userPresent=${!!userId}`);
      // This codebase has no workspace partition — weekly_plans/weekly_plan_items
      // are keyed by user_id only (see the "[Plan identity]" diagnostic in
      // app/app/plan/page.tsx). Logged explicitly so "is workspace resolution
      // fragile?" has a definitive, in-product answer: there is no separate
      // workspace-resolution step to be fragile.
      logPlanTiming("workspace ready", 0, "n/a — no workspace partition, plan is keyed by user_id only");
    }
  }, [authLoading, userId, mountedAt]);

  // ── Read current week's plan (wait for auth) ──────────────────────────────
  // Key includes userId so SWR caches per-user and never fetches before auth
  const planKey = userId
    ? `weekly-plan:${category}:${weekStart}:${userId}`
    : null;

  const {
    data: plan,
    mutate: mutatePlan,
    isLoading: planLoading,
    error: planError,
  } = useSWR<WeeklyPlan | null>(planKey, async () => {
    // Isolates two very different possible bottlenecks: (a) how long it took for
    // this fetcher to even START (auth wait / SWR scheduling — should be ~0 since
    // planKey only goes non-null once auth already resolved) vs. (b) the raw
    // Supabase PostgREST round trip itself. If "response received" 's queryMs is
    // the big number, the delay is the DB/network round trip, not client logic.
    logPlanTiming("weekly plan query started", performance.now() - mountedAt);
    const tQuery0 = performance.now();
    const { data, error } = await supabase
      .from("weekly_plans")
      .select("*")
      .eq("user_id", userId)
      .eq("category", category)
      .eq("week_start", weekStart)
      .maybeSingle();
    const queryMs = performance.now() - tQuery0;
    logPlanTiming("weekly plan query response received", performance.now() - mountedAt, `queryMs=${Math.round(queryMs)} error=${!!error}`);
    return (data as WeeklyPlan | null) ?? null;
  }, { revalidateOnFocus: false });

  useEffect(() => {
    // planKey is only non-null once auth has resolved to a real user, so this
    // never fires prematurely while session-user is still loading.
    if (planKey && !planLoading && !loggedRef.current.plan) {
      loggedRef.current.plan = true;
      logPlanStep("plan row ready", performance.now() - mountedAt, `planId=${plan?.id ?? "none"}`);
      logPlanTiming("planId resolved", performance.now() - mountedAt, `planId=${plan?.id ?? "none"}`);
    }
  }, [planKey, planLoading, plan, mountedAt]);

  // ── Read items (only when plan exists) ───────────────────────────────────
  const itemsKey = plan?.id ? `weekly-plan-items:${plan.id}` : null;
  const {
    data: items = [],
    mutate: mutateItems,
    isLoading: itemsLoading,
    error: itemsError,
  } = useSWR<WeeklyPlanItem[]>(itemsKey, async () => {
    const { data } = await supabase
      .from("weekly_plan_items")
      .select("*")
      .eq("plan_id", plan!.id)
      .order("sort_order", { ascending: true });
    return (data ?? []) as WeeklyPlanItem[];
  }, { revalidateOnFocus: false });

  useEffect(() => {
    if (itemsKey && !itemsLoading && !loggedRef.current.items) {
      loggedRef.current.items = true;
      logPlanStep("plan items ready", performance.now() - mountedAt, `count=${items.length}`);
    }
  }, [itemsKey, itemsLoading, items, mountedAt]);

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
    // Load-health signals for the Plan page's stuck/error fallback.
    // dataLoading collapses to `authLoading` while planKey/itemsKey are still
    // null (paused SWR keys report isLoading=false), then picks up the plan
    // and items fetches once each key goes live — so it's `true` for exactly
    // as long as *something* in the waterfall hasn't settled yet.
    dataLoading:    authLoading || planLoading || itemsLoading,
    // A real SWR error (not just "still loading") on either fetch.
    loadError:      planError ?? itemsError ?? null,
  };
}
