// Unified prefill adapter for Create Pins
// All source pages (Workspace, Product Signals, Viral Pins, etc.) route through here.

import type { CreativeDirectionSnapshotV2 } from "./studioPersistence";

// ── Types ──────────────────────────────────────────────────────────────────────

export type PrefillSource =
  | "workspace" | "weekly_plan" | "keyword_trends"
  | "viral_pins" | "pin_opportunities" | "product_signals"
  | "product_ideas" | "manual";

export type CreatePinsPrefill = {
  source: PrefillSource;
  opportunity?: {
    id?: string;
    title: string;
    keyword?: string;
    category?: string;
    primaryLabel?: "Best Bet" | "Steady" | "Competitive";
    trendState?: "Rising" | "Evergreen" | "Seasonal";
    evidenceSentence?: string;
    score?: number;
  };
  productImages?: Array<{
    id?: string;
    imageUrl: string;
    title?: string;
    source: "product_signals" | "product_ideas" | "uploaded" | "url" | "recent";
    category?: string;
    productUrl?: string;
    sourceDomain?: string;
  }>;
  pinReferences?: Array<{
    id?: string;
    imageUrl: string;
    title?: string;
    source: "viral_pins" | "pin_opportunities" | "uploaded" | "url" | "recent";
    category?: string;
    keyword?: string;
    saveCount?: number;
    visualFormat?: string;
    humanPresence?: string;
    saveSignal?: string;
    primaryLabel?: "Best Bet" | "Steady" | "Competitive";
    trendState?: "Rising" | "Evergreen" | "Seasonal";
  }>;
  promptSeed?: string;
  creativeDirectionSeed?: string;
  creativeDirectionSnapshot?: Partial<CreativeDirectionSnapshotV2>;
};

// ── SessionStorage helpers ─────────────────────────────────────────────────────

const SS_PREFIX = "vbp_cp_";

export function savePrefill(prefill: CreatePinsPrefill): string {
  const key = `${SS_PREFIX}${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  try { sessionStorage.setItem(key, JSON.stringify(prefill)); } catch { /* SSR / private browsing */ }
  return key;
}

export function loadPrefill(key: string): CreatePinsPrefill | null {
  if (!key.startsWith(SS_PREFIX)) return null;
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    sessionStorage.removeItem(key); // consume once
    return JSON.parse(raw) as CreatePinsPrefill;
  } catch { return null; }
}

// Navigate to Create Pins with the prefill saved in sessionStorage.
// `navigate` is typically `router.push` or `(url) => { window.location.href = url; }`.
export function openCreatePins(
  navigate: (url: string) => void,
  prefill: CreatePinsPrefill,
): void {
  if (process.env.NODE_ENV !== "production") {
    console.log("[OpenCreatePins]", {
      source: prefill.source,
      hasOpportunity: !!prefill.opportunity,
      productCount: prefill.productImages?.length ?? 0,
      referenceCount: prefill.pinReferences?.length ?? 0,
      hasPromptSeed: !!prefill.promptSeed,
    });
  }
  const key = savePrefill(prefill);
  navigate(`/app/studio?prefillKey=${encodeURIComponent(key)}`);
}

// ── Source adapters ────────────────────────────────────────────────────────────

export function buildPrefillFromWorkspace(
  item: {
    keyword_id: string;
    keyword: string;
    category?: string | null;
    tier: string;
    opportunity_score?: number | null;
    pct_growth_yoy?: number | null;
    total_source_saves: number;
    trend_lifecycle?: string | null;
    pin_samples: Array<{ id: string; image_url: string | null; save_count: number }>;
  },
  fallbackCategory: string,
): CreatePinsPrefill {
  const TIER_LABEL: Record<string, "Best Bet" | "Steady" | "Competitive"> = {
    best_bet: "Best Bet", steady: "Steady", competitive: "Competitive",
    blue_ocean: "Best Bet", early_trend: "Steady", hot_red_sea: "Competitive",
  };
  const trendState: "Rising" | "Evergreen" | "Seasonal" =
    item.trend_lifecycle === "rising" ? "Rising" :
    item.trend_lifecycle === "seasonal" ? "Seasonal" : "Evergreen";

  let evidenceSentence = "Steady demand · Consistent save signal";
  if (item.total_source_saves >= 50000)      evidenceSentence = "High demand · Less crowded · Strong save signal";
  else if (item.total_source_saves >= 10000) evidenceSentence = "Strong save signal · Clear visual pattern";
  else if ((item.pct_growth_yoy ?? 0) > 50)  evidenceSentence = "Fast growing · Early opportunity";

  const topPins = item.pin_samples.filter(p => p.image_url).slice(0, 3);

  return {
    source: "workspace",
    opportunity: {
      id: item.keyword_id,
      title: item.keyword,
      keyword: item.keyword,
      category: item.category ?? fallbackCategory,
      primaryLabel: TIER_LABEL[item.tier],
      trendState,
      evidenceSentence,
      score: item.opportunity_score ?? undefined,
    },
    pinReferences: topPins.map(p => ({
      id: p.id,
      imageUrl: p.image_url!,
      source: "viral_pins" as const,
      category: item.category ?? fallbackCategory,
      keyword: item.keyword,
      saveCount: p.save_count,
    })),
  };
}

export function buildPrefillFromProductSignal(product: {
  id: string;
  product_name: string;
  image_url: string;
  seed_keyword?: string | null;
  source_url?: string | null;
  domain?: string | null;
}): CreatePinsPrefill {
  return {
    source: "product_signals",
    productImages: [{
      id: product.id,
      imageUrl: product.image_url,
      title: product.product_name,
      source: "product_signals",
      category: product.seed_keyword ?? undefined,
      productUrl: product.source_url ?? undefined,
      sourceDomain: product.domain ?? undefined,
    }],
    ...(product.seed_keyword ? {
      opportunity: {
        title: product.seed_keyword,
        keyword: product.seed_keyword,
        category: product.seed_keyword,
      },
    } : {}),
  };
}

export function buildPrefillFromViralPin(pin: {
  id: string;
  image_url: string;
  save_count?: number;
  source_keyword?: string | null;
  category?: string | null;
}): CreatePinsPrefill {
  return {
    source: "viral_pins",
    pinReferences: [{
      id: pin.id,
      imageUrl: pin.image_url,
      source: "viral_pins",
      category: pin.category ?? pin.source_keyword ?? undefined,
      keyword: pin.source_keyword ?? undefined,
      saveCount: pin.save_count,
    }],
    ...(pin.source_keyword ? {
      opportunity: {
        title: pin.source_keyword,
        keyword: pin.source_keyword,
        category: pin.category ?? pin.source_keyword ?? undefined,
      },
    } : {}),
  };
}

export function buildPrefillFromKeywordTrend(item: {
  keyword: string;
  category?: string | null;
  opportunityLabel?: string;
  trendState?: string;
}): CreatePinsPrefill {
  const primaryLabel: "Best Bet" | "Steady" | "Competitive" =
    item.opportunityLabel === "Best Bet" ? "Best Bet" :
    item.opportunityLabel === "Competitive" ? "Competitive" : "Steady";
  const trendState: "Rising" | "Evergreen" | "Seasonal" =
    item.trendState?.toLowerCase() === "rising" ? "Rising" :
    item.trendState?.toLowerCase() === "seasonal" ? "Seasonal" : "Evergreen";

  return {
    source: "keyword_trends",
    opportunity: {
      title: item.keyword,
      keyword: item.keyword,
      category: item.category ?? undefined,
      primaryLabel,
      trendState,
    },
  };
}

export function buildPrefillFromWeeklyPlan(item: {
  keyword_id: string;
  keyword: string;
  category?: string;
  tier?: string;
  title_hook?: string;
}): CreatePinsPrefill {
  const primaryLabel: "Best Bet" | "Steady" | "Competitive" =
    item.tier === "best_bet" ? "Best Bet" :
    item.tier === "competitive" ? "Competitive" : "Steady";
  return {
    source: "weekly_plan",
    opportunity: {
      id: item.keyword_id,
      title: item.keyword,
      keyword: item.keyword,
      category: item.category,
      primaryLabel,
    },
    ...(item.title_hook ? { promptSeed: item.title_hook } : {}),
  };
}

// ── Composer Draft helpers ─────────────────────────────────────────────────────
//
// openCreatePinsWithDraft() is the new preferred navigation path.
// It writes a composer_draft to the DB before navigating so Studio can always
// recover the full context — even after a page refresh or tab switch.
//
// Falls back to the sessionStorage path (openCreatePins) on auth or network failure
// so the user is never blocked.

export async function openCreatePinsWithDraft(
  navigate: (url: string) => void,
  prefill: CreatePinsPrefill,
  token: string | null | undefined,
): Promise<void> {
  if (token) {
    try {
      const body = {
        source_page:             prefill.source,
        source_context:          prefill.opportunity ?? null,
        opportunity_id:          prefill.opportunity?.id ?? null,
        selected_reference_ids:  prefill.pinReferences?.map(r => r.id).filter(Boolean) ?? [],
        selected_product_ids:    prefill.productImages?.map(p => p.id).filter(Boolean) ?? [],
        draft_snapshot:          prefill,
      };
      const res = await fetch("/api/composer-drafts", {
        method:  "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body:    JSON.stringify(body),
      });
      if (res.ok) {
        const { draft_id } = await res.json() as { draft_id: string };
        if (draft_id) {
          // Also save to sessionStorage as a backup (belt-and-suspenders)
          savePrefill(prefill);
          navigate(`/app/studio?draft_id=${encodeURIComponent(draft_id)}`);
          return;
        }
      }
    } catch {
      // fall through to sessionStorage path
    }
  }
  // Fallback: sessionStorage only
  openCreatePins(navigate, prefill);
}

// Convert a composer_draft API response (with resolved_* fields) back to CreatePinsPrefill.
// Used by Studio on mount when ?draft_id= is present.
export function draftToPrefill(draft: Record<string, unknown>): CreatePinsPrefill | null {
  // If the draft already contains a full snapshot, use it directly
  const snapshot = draft.draft_snapshot as CreatePinsPrefill | null | undefined;
  if (snapshot && typeof snapshot === "object" && "source" in snapshot) {
    return snapshot as CreatePinsPrefill;
  }

  // Otherwise reconstruct from resolved objects
  const sourcePage = (draft.source_page as string | null) ?? "workspace";
  const source: PrefillSource = [
    "workspace","weekly_plan","keyword_trends","viral_pins",
    "pin_opportunities","product_signals","product_ideas","manual",
  ].includes(sourcePage) ? (sourcePage as PrefillSource) : "workspace";

  const opp = draft.resolved_opportunity as Record<string, unknown> | null | undefined;
  const refs = (draft.resolved_references as Array<Record<string, unknown>> | null | undefined) ?? [];
  const prods = (draft.resolved_products as Array<Record<string, unknown>> | null | undefined) ?? [];

  const primaryLabel: "Best Bet" | "Steady" | "Competitive" =
    opp?.primary_label === "Best Bet" ? "Best Bet" :
    opp?.primary_label === "Competitive" ? "Competitive" : "Steady";

  const trendState: "Rising" | "Evergreen" | "Seasonal" =
    opp?.trend_state === "Rising" ? "Rising" :
    opp?.trend_state === "Seasonal" ? "Seasonal" : "Evergreen";

  return {
    source,
    ...(opp ? {
      opportunity: {
        id:              (opp.id as string | undefined),
        title:           (opp.title ?? opp.canonical_keyword ?? "") as string,
        keyword:         (opp.canonical_keyword ?? opp.title ?? "") as string,
        category:        (opp.category as string | undefined),
        primaryLabel,
        trendState,
        evidenceSentence: (opp.evidence_sentence as string | undefined),
        score:           (opp.score as number | undefined),
      },
    } : {}),
    ...(refs.length > 0 ? {
      pinReferences: refs.map(r => ({
        id:        (r.id as string | undefined),
        imageUrl:  (r.image_url as string) ?? "",
        source:    "viral_pins" as const,
        category:  (r.category as string | undefined),
        keyword:   (r.seed_keyword as string | undefined),
        saveCount: (r.save_count as number | undefined),
      })).filter(r => r.imageUrl),
    } : {}),
    ...(prods.length > 0 ? {
      productImages: prods.map(p => ({
        id:          (p.id as string | undefined),
        imageUrl:    (p.image_url as string) ?? "",
        title:       (p.product_name as string | undefined),
        source:      "product_signals" as const,
        sourceDomain: (p.domain as string | undefined),
        productUrl:  (p.source_url as string | undefined),
      })).filter(p => p.imageUrl),
    } : {}),
  };
}

// ── Prompt builder ─────────────────────────────────────────────────────────────

type CatStyleEntry = { style: string; refMood: string; baseScene: string; prodScene: string };

const CAT_STYLE_MAP: Record<string, CatStyleEntry> = {
  "home":    { style: "room decor",     refMood: "room styling, mood, layout, and lighting",         baseScene: "a cozy, aesthetic interior scene with soft natural lighting and styled decor",      prodScene: "a cozy, aesthetic interior scene with soft natural lighting and editorial styling" },
  "fashion": { style: "fashion",         refMood: "styling, mood, lighting, and composition",          baseScene: "a clean, editorial fashion shot with natural light and Pinterest-native styling",  prodScene: "a clean, editorial fashion scene with natural light and styled details" },
  "beauty":  { style: "beauty",          refMood: "mood, styling, lighting, and composition",          baseScene: "a clean beauty flatlay with soft lighting and minimal props",                      prodScene: "a clean beauty scene with soft lighting and editorial product styling" },
  "digital": { style: "digital product", refMood: "mood, layout, and presentation",                    baseScene: "a clean desk or device mockup with editorial styling",                             prodScene: "a clean desk or device mockup scene with editorial styling" },
  "food":    { style: "food",            refMood: "styling, mood, and composition",                    baseScene: "a styled food scene with natural light and appetizing composition",                 prodScene: "a styled food scene with natural light and editorial presentation" },
  "wedding": { style: "wedding",         refMood: "mood, styling, and composition",                    baseScene: "a romantic, elegant scene with soft lighting and polished detail",                  prodScene: "a romantic, elegant scene with soft lighting and polished styling" },
  "travel":  { style: "travel",          refMood: "mood, lighting, and composition",                   baseScene: "a scenic, wanderlust-worthy scene with editorial styling",                          prodScene: "a scenic travel scene with editorial styling and vibrant natural light" },
};

function getStyle(category?: string): CatStyleEntry | null {
  if (!category) return null;
  const c = category.toLowerCase();
  for (const [k, s] of Object.entries(CAT_STYLE_MAP)) { if (c.includes(k)) return s; }
  return null;
}

export function buildPromptFromPrefill(prefill: CreatePinsPrefill): string {
  const hasProducts = (prefill.productImages?.length ?? 0) > 0;
  const hasRefs     = (prefill.pinReferences?.length ?? 0) > 0;
  const kw          = prefill.opportunity?.title ?? prefill.opportunity?.keyword ?? "";
  const s           = getStyle(prefill.opportunity?.category);

  if (hasProducts && hasRefs) {
    return [
      kw ? `Create a Pinterest-native${s ? ` ${s.style}` : ""} Pin${kw ? ` for "${kw}"` : ""}.` : "Create a Pinterest-native product Pin.",
      "Use the uploaded product images as the main items to feature. Keep their color, shape, material, and key details recognizable.",
      `Use the selected Pin references as visual guidance for ${s?.refMood ?? "mood, layout, lighting, and composition"}. Do not copy the exact scene.`,
      `Place the products naturally in ${s?.prodScene ?? "a clean, aesthetic Pinterest-native scene"}.`,
      "No text overlay. No typography. No watermark. Vertical 2:3 format.",
    ].join("\n\n");
  }

  if (hasProducts) {
    const prodTitle = prefill.productImages![0].title ?? "the product";
    return [
      `Create a Pinterest-native${s ? ` ${s.style}` : ""} Pin featuring "${prodTitle}".`,
      "Keep the product's color, shape, material, and key details recognizable.",
      `Place it naturally in ${s?.prodScene ?? "a clean, aesthetic Pinterest-native scene"}.`,
      "No text overlay. No typography. No watermark. Vertical 2:3 format.",
    ].join("\n\n");
  }

  if (hasRefs && kw) {
    return [
      `Create a Pinterest-native${s ? ` ${s.style}` : ""} Pin for "${kw}".`,
      `Use the selected Pin references as visual guidance for ${s?.refMood ?? "mood, layout, lighting, and composition"}. Do not copy the exact scene.`,
      `Create ${s?.baseScene ?? "a polished, aesthetic Pinterest-native scene"}.`,
      "No text overlay. No typography. No watermark. Vertical 2:3 format.",
    ].join("\n\n");
  }

  if (hasRefs) {
    return [
      "Create a Pinterest-native Pin inspired by the selected references.",
      "Use them as visual guidance for mood, layout, lighting, and composition. Do not copy the exact scene.",
      "No text overlay. No typography. No watermark. Vertical 2:3 format.",
    ].join("\n\n");
  }

  if (kw) {
    return [
      `Create a Pinterest-native${s ? ` ${s.style}` : ""} Pin for "${kw}".`,
      `Create ${s?.baseScene ?? "a polished, aesthetic Pinterest-native scene"}.`,
      "No text overlay. No typography. No watermark. Vertical 2:3 format.",
    ].join("\n\n");
  }

  return "";
}
