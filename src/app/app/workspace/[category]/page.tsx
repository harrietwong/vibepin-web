"use client";

import { useState, useEffect, useCallback } from "react";
import { useParams, useRouter }             from "next/navigation";
import useSWR                               from "swr";
import Link                                 from "next/link";
import { toast }                            from "sonner";

import {
  CATEGORIES, ACTIVE_CATEGORIES, SOON_CATEGORIES,
  getCategoryStatus, isCategoryReady, type CategoryDef,
} from "@/lib/categories";
import { useWeeklyPlan }        from "@/lib/useWeeklyPlan";
import { useUserTier }          from "@/lib/useUserTier";
import { createBrowserClient }  from "@supabase/ssr";

const supabase = createBrowserClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
);
import { WeeklyPlanBar }        from "@/components/workspace/WeeklyPlanBar";
import { WorkspaceOpportunityCard } from "@/components/workspace/WorkspaceOpportunityCard";
import { WeeklyPlanModal }      from "@/components/workspace/WeeklyPlanModal";
import type { WorkspaceFeedItem } from "@/app/api/workspace/feed/route";
import { buildPrefillFromWorkspace, openCreatePins } from "@/lib/createPinsPrefill";

type TargetCount = 7 | 14 | 21;

const FEED_LIMIT = 24;

// ── Digital idea candidate (from Plan action handoff) ─────────────────────────

type DigitalIdeaCandidate = {
  ideaId:  string;
  keyword: string;
  niche:   string;
  format:  string;
};

function formatNiche(niche: string): string {
  return niche.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

function formatFormat(format: string): string {
  return format.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

function DigitalIdeaBanner({
  candidate,
  onAdd,
  onDismiss,
}: {
  candidate: DigitalIdeaCandidate;
  onAdd: () => Promise<void>;
  onDismiss: () => void;
}) {
  const [adding, setAdding] = useState(false);

  async function handleAdd() {
    setAdding(true);
    await onAdd();
    setAdding(false);
  }

  return (
    <div style={{
      marginBottom: 16,
      padding: "14px 16px",
      borderRadius: 12,
      background: "rgba(192,38,211,0.04)",
      border: "1px solid rgba(192,38,211,0.2)",
      display: "flex",
      alignItems: "flex-start",
      gap: 12,
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{ margin: "0 0 2px", fontSize: "9px", fontWeight: 700, color: "#C026D3", textTransform: "uppercase", letterSpacing: "0.08em" }}>
          Digital Product Idea
        </p>
        <p style={{ margin: "0 0 6px", fontSize: "14px", fontWeight: 800, color: "var(--app-text)", textTransform: "capitalize" }}>
          {candidate.keyword}
        </p>
        <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
          <span style={{ fontSize: "9px", fontWeight: 600, padding: "2px 7px", borderRadius: 20, background: "var(--app-surface-3)", color: "#6B7280" }}>
            {formatNiche(candidate.niche)}
          </span>
          <span style={{ fontSize: "9px", fontWeight: 600, padding: "2px 7px", borderRadius: 20, background: "rgba(124,58,237,0.08)", color: "#7C3AED" }}>
            {formatFormat(candidate.format)}
          </span>
        </div>
      </div>
      <div style={{ display: "flex", gap: 6, flexShrink: 0, alignItems: "center" }}>
        <button
          type="button"
          onClick={handleAdd}
          disabled={adding}
          style={{
            padding: "7px 14px", fontSize: "12px", fontWeight: 700, borderRadius: 8, border: "none",
            background: adding ? "var(--app-border)" : "linear-gradient(135deg, #FF4D8D 0%, #D946EF 52%, #7C3AED 100%)",
            color: adding ? "#9CA3AF" : "#fff",
            cursor: adding ? "default" : "pointer",
            whiteSpace: "nowrap",
          }}
        >
          {adding ? "Adding…" : "Add to Weekly Plan"}
        </button>
        <button
          type="button"
          onClick={onDismiss}
          style={{ padding: 5, borderRadius: 6, border: "1px solid var(--app-border)", background: "var(--app-surface)", cursor: "pointer", display: "flex", alignItems: "center" }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--app-text-muted)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
    </div>
  );
}

// ── Coming Soon state ─────────────────────────────────────────────────────────

function ComingSoonState({ catDef, category, userEmail }: {
  catDef: CategoryDef | undefined;
  category: string;
  userEmail: string | null;
}) {
  const label  = catDef?.label ?? category;
  const emoji  = catDef?.emoji ?? "📌";
  const status = getCategoryStatus(category);
  const isSoon = status === "soon";

  const mailtoHref = (() => {
    const subject = `Request VibePin category: ${label}`;
    const body = [
      `I want VibePin to support ${label}. My use case is:`,
      "",
      "(describe your use case here)",
      "",
      ...(userEmail ? [`Email: ${userEmail}`] : []),
    ].join("\n");
    return `mailto:hi@vibepin.app?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  })();

  return (
    <div style={{
      flex: 1, display: "flex", alignItems: "center", justifyContent: "center",
      flexDirection: "column", gap: "24px", padding: "40px 20px",
      background: "var(--app-bg)",
    }}>
      <div style={{ textAlign: "center", maxWidth: "480px" }}>
        <div style={{ fontSize: "44px", marginBottom: "16px", lineHeight: 1 }}>{emoji}</div>
        <h2 style={{ margin: "0 0 12px", fontSize: "20px", fontWeight: 800, color: "var(--app-text)" }}>
          {label} Workspace {isSoon ? "is Coming Soon" : "is Not Yet Available"}
        </h2>
        <p style={{ margin: 0, fontSize: "13px", color: "var(--app-text-sec)", lineHeight: 1.7 }}>
          We're still collecting enough trend, pin, and product signals to build reliable
          weekly plans for <strong style={{ color: "var(--app-text-sec)" }}>{label}</strong>.
          Once the data reaches our readiness threshold this workspace will activate automatically.
        </p>
        {isSoon && (
          <p style={{ margin: "12px 0 0", fontSize: "12px", color: "var(--app-text-muted)" }}>
            This category is in our pipeline — check back in the next update.
          </p>
        )}
      </div>

      <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", justifyContent: "center" }}>
        <Link
          href="/app/workspace/home-decor"
          style={{
            padding: "9px 22px", fontSize: "13px", fontWeight: 700,
            borderRadius: "8px", border: "none",
            background: "linear-gradient(135deg, #FF4D8D 0%, #D946EF 52%, #7C3AED 100%)", color: "#fff", textDecoration: "none",
            whiteSpace: "nowrap",
          }}
        >
          Go to Home Decor Workspace →
        </Link>
        <a
          href={mailtoHref}
          style={{
            padding: "9px 20px", fontSize: "13px", fontWeight: 600,
            borderRadius: "8px", border: "1px solid var(--app-border)",
            background: "transparent", color: "var(--app-text-sec)", textDecoration: "none",
            whiteSpace: "nowrap",
          }}
        >
          Request {label}
        </a>
      </div>

      {/* Show soon categories so users know what's coming */}
      {SOON_CATEGORIES.length > 0 && (
        <div style={{ textAlign: "center" }}>
          <p style={{ margin: "0 0 10px", fontSize: "10px", fontWeight: 700, color: "var(--app-text-muted)", textTransform: "uppercase", letterSpacing: "0.08em" }}>
            Coming Soon
          </p>
          <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", justifyContent: "center" }}>
            {SOON_CATEGORIES.map(c => (
              <span key={c.id} style={{
                padding: "3px 10px", borderRadius: "20px", fontSize: "11px", fontWeight: 600,
                border: "1px solid var(--app-border)", color: "var(--app-text-muted)", whiteSpace: "nowrap",
              }}>
                {c.emoji} {c.label}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function WorkspaceCategoryPage() {
  const params   = useParams();
  const router   = useRouter();
  const category = (params.category as string) ?? "home-decor";
  const catDef   = CATEGORIES.find(c => c.id === category);
  const ready    = isCategoryReady(category);

  const { isPro }                        = useUserTier();
  const [targetCount, setTargetCount]    = useState<TargetCount>(7);
  const [showModal, setShowModal]        = useState(false);
  const [userEmail, setUserEmail]        = useState<string | null>(null);
  const [digitalCandidate, setDigitalCandidate] = useState<DigitalIdeaCandidate | null>(null);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setUserEmail(data.user?.email ?? null));
  }, []);

  // Parse digital product idea handoff from Plan action
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    if (p.get("source") === "digital_idea") {
      const ideaId  = p.get("ideaId")  ?? "";
      const keyword = p.get("keyword") ?? "";
      const niche   = p.get("niche")   ?? "";
      const format  = p.get("format")  ?? "";
      if (ideaId && keyword) setDigitalCandidate({ ideaId, keyword, niche, format });
    }
  }, []);

  const {
    items,
    selectedCount,
    isSelected,
    addToWeeklyPlan,
    removeFromWeeklyPlan,
    buildWeeklyPlan,
    isPlanReady,
    weekLabel,
    userId,
    authLoading,
  } = useWeeklyPlan(category, targetCount);

  useEffect(() => {
    if (!authLoading && !userId) {
      router.replace("/login");
    }
  }, [authLoading, userId, router]);

  // ── Paginated feed state ─────────────────────────────────────────────────────
  const [allItems,    setAllItems]    = useState<WorkspaceFeedItem[]>([]);
  const [hasMore,     setHasMore]     = useState(false);
  const [loadOffset,  setLoadOffset]  = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);

  // Reset when category changes
  useEffect(() => {
    setAllItems([]);
    setHasMore(false);
    setLoadOffset(0);
  }, [category]);

  // Initial page via SWR (cache per category)
  const feedKey = ready
    ? `/api/workspace/feed?category=${category}&limit=${FEED_LIMIT}&offset=0`
    : null;

  const { data: swrPage, isLoading: feedLoading, error: feedError } = useSWR<{
    data: WorkspaceFeedItem[];
    hasMore: boolean;
  }>(
    feedKey,
    (url: string) =>
      fetch(url)
        .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }),
    { revalidateOnFocus: false },
  );

  // Sync initial SWR page into allItems. useEffect is more reliable than onSuccess
  // because it fires after React's commit phase and won't race with category resets.
  useEffect(() => {
    if (!swrPage) return;
    setAllItems(swrPage.data);
    setHasMore(swrPage.hasMore);
    setLoadOffset(swrPage.data.length);
  }, [swrPage]);

  const handleLoadMore = useCallback(async () => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    try {
      const url = `/api/workspace/feed?category=${category}&limit=${FEED_LIMIT}&offset=${loadOffset}`;
      const r   = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const json = await r.json() as { data: WorkspaceFeedItem[]; hasMore: boolean };
      setAllItems(prev => [...prev, ...json.data]);
      setHasMore(json.hasMore);
      setLoadOffset(prev => prev + json.data.length);
    } catch {
      toast.error("Failed to load more opportunities");
    } finally {
      setLoadingMore(false);
    }
  }, [category, hasMore, loadOffset, loadingMore]);

  function handleCreateSelectedPins() {
    const selected = allItems.filter(item => isSelected(item.keyword_id));
    if (!selected.length) return;
    const keywords    = selected.map(i => i.keyword).join(",");
    const keywordIds  = selected.map(i => i.keyword_id).join(",");
    const p = new URLSearchParams({ from: "batch", keywords, keyword_ids: keywordIds, category });
    router.push(`/app/studio?${p.toString()}`);
  }

  function handleCreatePins(item: WorkspaceFeedItem) {
    const prefill = buildPrefillFromWorkspace(item, category);
    openCreatePins(url => router.push(url), prefill);
  }

  async function handleAdd(item: Parameters<typeof addToWeeklyPlan>[0]) {
    const err = await addToWeeklyPlan(item);
    if (err) toast.error(err);
  }

  async function handleAddDigitalIdea() {
    if (!digitalCandidate) return;
    const err = await addToWeeklyPlan({
      keyword_id: digitalCandidate.ideaId,
      keyword:    digitalCandidate.keyword,
      tier:       "evergreen",
      score:      null,
    });
    if (err) {
      toast.error(`Could not add to plan: ${err}`);
    } else {
      toast.success("Added to Weekly Plan", { description: digitalCandidate.keyword });
      setDigitalCandidate(null);
    }
  }

  async function handleRemove(keywordId: string) {
    const err = await removeFromWeeklyPlan(keywordId);
    if (err) toast.error(err);
  }

  async function handleBuildPlan() {
    const err = await buildWeeklyPlan();
    if (err) { toast.error(err); return; }
    setShowModal(true);
  }

  function handleUpgradePrompt() {
    toast.info("Upgrade to Pro to plan 14 or 21 keywords per week.", {
      description: "Free plan is limited to 7 keywords.",
      action: { label: "Upgrade", onClick: () => router.push("/settings") },
    });
  }

  if (authLoading) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "var(--app-text-muted)", background: "var(--app-bg)" }}>
        <span style={{ fontSize: "13px" }}>Loading…</span>
      </div>
    );
  }

  // Gate: non-ready category shows coming soon
  if (!ready) {
    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--app-bg)" }}>
        {/* Category tabs still visible so users can navigate to ready ones */}
        <CategoryTabs category={category} />
        <ComingSoonState catDef={catDef} category={category} userEmail={userEmail} />
      </div>
    );
  }

  const isBeta = getCategoryStatus(category) === "beta";

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--app-bg)" }}>

      {isBeta && (
        <div style={{
          padding: "7px 20px", fontSize: "11px", fontWeight: 600,
          background: "rgba(245,158,11,0.08)", borderBottom: "1px solid rgba(245,158,11,0.15)",
          color: "#D97706", flexShrink: 0,
        }}>
          Beta category · signals still expanding — opportunities may be limited
        </div>
      )}

      <WeeklyPlanBar
        selectedCount={selectedCount}
        targetCount={targetCount}
        isPro={isPro}
        isPlanReady={isPlanReady}
        onTargetChange={setTargetCount}
        onBuildPlan={handleBuildPlan}
        onCreateSelectedPins={selectedCount > 0 ? handleCreateSelectedPins : undefined}
        onUpgradePrompt={handleUpgradePrompt}
      />

      <CategoryTabs category={category} title={catDef ? `${catDef.emoji} ${catDef.label}` : category} />

      {/* Feed grid */}
      <div style={{ flex: 1, overflowY: "auto", padding: "16px 20px" }}>

        {/* Digital idea candidate banner */}
        {digitalCandidate && (
          <DigitalIdeaBanner
            candidate={digitalCandidate}
            onAdd={handleAddDigitalIdea}
            onDismiss={() => setDigitalCandidate(null)}
          />
        )}

        {/* Tagline + Recommended Mix */}
        {!feedLoading && !feedError && allItems.length > 0 && (
          <div style={{ marginBottom: "14px", display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
            <p style={{ margin: 0, fontSize: "12px", color: "var(--app-text-muted)" }}>
              Ranked weekly opportunities backed by trend, pin, and product signals.
            </p>
            <div style={{
              display: "flex", alignItems: "center", gap: "5px",
              padding: "3px 8px 3px 6px",
              borderRadius: "20px",
              border: "1px solid var(--app-border)",
              background: "var(--app-surface-2)",
              flexShrink: 0,
            }}>
              <span style={{ fontSize: "9px", fontWeight: 700, color: "var(--app-text-muted)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                Aim for
              </span>
              {[
                { icon: "↑", label: "Rising",   pct: "40%", color: "#059669" },
                { icon: "∞", label: "Evergreen", pct: "40%", color: "#0284C7" },
                { icon: "◎", label: "Seasonal",  pct: "20%", color: "#9333EA" },
              ].map(({ icon, label, pct, color }) => (
                <span key={label} style={{ fontSize: "9px", fontWeight: 600, color, whiteSpace: "nowrap" }}>
                  {icon} {label} {pct}
                </span>
              ))}
            </div>
          </div>
        )}

        {feedLoading ? (
          <p style={{ color: "var(--app-text-sec)", fontSize: "13px" }}>Loading opportunities…</p>
        ) : feedError ? (
          <div style={{ color: "#DC2626", fontSize: "13px", padding: "12px", background: "rgba(220,38,38,0.06)", borderRadius: "8px", border: "1px solid rgba(220,38,38,0.2)" }}>
            Something went wrong loading <strong>{catDef?.label ?? category}</strong>.
            <button
              onClick={() => window.location.reload()}
              style={{ marginLeft: "8px", color: "#C026D3", background: "none", border: "none", cursor: "pointer", fontSize: "12px", textDecoration: "underline" }}
            >
              Retry
            </button>
          </div>
        ) : allItems.length === 0 ? (
          <div style={{ padding: "32px 0", textAlign: "center" }}>
            <p style={{ margin: "0 0 8px", fontSize: "14px", color: "var(--app-text-sec)" }}>
              No opportunities available for <strong style={{ color: "var(--app-text-sec)" }}>{catDef?.label ?? category}</strong> right now.
            </p>
            <p style={{ margin: "0 0 20px", fontSize: "12px", color: "var(--app-text-muted)" }}>
              We update the database weekly — check back soon, or try another category.
            </p>
            <Link
              href="/app/workspace/home-decor"
              style={{ padding: "8px 20px", fontSize: "12px", fontWeight: 700, borderRadius: "7px", background: "linear-gradient(135deg, #FF4D8D 0%, #D946EF 52%, #7C3AED 100%)", color: "#fff", textDecoration: "none" }}
            >
              Try Home Decor
            </Link>
          </div>
        ) : (
          <>
            <div style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
              gap: "12px",
            }}>
              {allItems.map(item => (
                <WorkspaceOpportunityCard
                  key={item.keyword_id}
                  item={item}
                  isSelected={isSelected(item.keyword_id)}
                  canAdd={!isSelected(item.keyword_id) && selectedCount < targetCount}
                  isPro={isPro}
                  onCreatePins={() => handleCreatePins(item)}
                  onAdd={() => handleAdd({
                    keyword_id: item.keyword_id,
                    keyword:    item.keyword,
                    tier:       item.tier,
                    score:      item.opportunity_score,
                  })}
                  onRemove={() => handleRemove(item.keyword_id)}
                />
              ))}
            </div>

            {/* Load More / End of list */}
            <div style={{ marginTop: "24px", textAlign: "center", paddingBottom: "8px" }}>
              {hasMore ? (
                <button
                  type="button"
                  onClick={handleLoadMore}
                  disabled={loadingMore}
                  style={{
                    padding: "9px 28px", fontSize: "13px", fontWeight: 700,
                    borderRadius: "8px", border: "1px solid var(--app-border)",
                    background: loadingMore ? "var(--app-surface-2)" : "var(--app-surface)",
                    color: loadingMore ? "#9CA3AF" : "var(--app-text-sec)",
                    cursor: loadingMore ? "default" : "pointer",
                    transition: "background 0.15s",
                  }}
                >
                  {loadingMore ? "Loading…" : "Load more opportunities"}
                </button>
              ) : (
                <p style={{ fontSize: "12px", color: "var(--app-text-dim)" }}>
                  You&#39;ve reached the end of this week&#39;s recommendations.
                </p>
              )}
            </div>
          </>
        )}
      </div>

      {showModal && (
        <WeeklyPlanModal
          items={items}
          weekLabel={weekLabel}
          category={category}
          onClose={() => setShowModal(false)}
          feedItems={allItems}
        />
      )}
    </div>
  );
}

// ── Category tabs ─────────────────────────────────────────────────────────────

function CategoryTabs({ category, title }: { category: string; title?: string }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: "10px",
      padding: "12px 20px 10px", flexWrap: "wrap",
      borderBottom: "1px solid var(--app-border)", background: "var(--app-surface)", flexShrink: 0,
    }}>
      {title && (
        <h1 style={{ margin: 0, fontSize: "15px", fontWeight: 800, color: "var(--app-text)", marginRight: "4px" }}>
          {title} Workspace
        </h1>
      )}

      <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", marginLeft: title ? "auto" : 0 }}>
        {/* Active categories (ready + beta) — clickable */}
        {ACTIVE_CATEGORIES.map(c => (
          <Link
            key={c.id}
            href={`/app/workspace/${c.id}`}
            style={{
              padding: "3px 10px", borderRadius: "20px", fontSize: "11px", fontWeight: 600,
              textDecoration: "none", whiteSpace: "nowrap",
              border:      `1px solid ${c.id === category ? "#C026D3" : "var(--app-border)"}`,
              background:  c.id === category ? "rgba(217,70,239,0.1)" : "transparent",
              color:       c.id === category ? "#C026D3" : "var(--app-text-sec)",
            }}
          >
            {c.emoji} {c.label}{c.status === "beta" ? <span style={{ fontSize: "8px", marginLeft: "4px", color: "#D97706", fontWeight: 700 }}>β</span> : null}
          </Link>
        ))}

        {/* Soon categories — disabled pills */}
        {SOON_CATEGORIES.map(c => (
          <span
            key={c.id}
            title="Collecting signals — request early access"
            style={{
              padding: "3px 10px", borderRadius: "20px", fontSize: "11px", fontWeight: 600,
              border: "1px solid var(--app-border)", color: "var(--app-text-dim)", whiteSpace: "nowrap",
              cursor: "default", userSelect: "none",
            }}
          >
            {c.emoji} {c.label}
          </span>
        ))}
      </div>
    </div>
  );
}
