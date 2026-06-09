import { catLabel } from "@/lib/categories";
import {
  classifySourcePin,
  shouldShowInPinIdeas,
  type AssetRoleV2,
  type DestinationType,
  type ItemType,
  type ProductSubtype,
  type ProductType,
  type RiskFlag,
  type SourceContext,
} from "@/lib/assetClassification";

export type PinIdea = {
  id: string;
  image_url: string;
  title?: string;
  source_keyword: string | null;
  save_count: number;
  category?: string;
  visual_format?: string;
  source_url?: string | null;
  outbound_link?: string | null;
  item_type?: ItemType;
  product_type?: ProductType;
  product_subtype?: ProductSubtype;
  destination_type?: DestinationType;
  asset_role?: AssetRoleV2;
  source_context?: SourceContext;
  risk_flags?: RiskFlag[];
};

export type PinIdeaPickerAsset = {
  id: string;
  imageUrl: string;
  title?: string;
  source: "pin_ideas";
  assetRole: "pin_reference";
  category?: string;
  keyword?: string;
  visualFormat?: string;
  saveSignal?: string;
};

export const PIN_IDEAS_SWR_KEY = "pin_ideas_reference";

export type PinIdeasFetchResult = {
  pins: PinIdea[];
  lastUpdatedAt: string | null;
  source: string;
  itemCount: number;
};

async function fetchWithTimeout(input: RequestInfo | URL, ms = 15000): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(input, { signal: ctrl.signal, cache: "no-store" });
  } finally {
    clearTimeout(timer);
  }
}

function mapApiRow(r: Record<string, unknown>): PinIdea {
  const saveCount = (r.save_count as number) ?? 0;
  const keyword = (r.source_keyword as string | null) ?? (r.category as string | null) ?? null;
  const classified = classifySourcePin({
    title: (r.title as string | null) ?? keyword,
    description: r.description as string | null,
    sourceUrl: r.source_url as string | null,
    destinationUrl: (r.outbound_link as string | null) ?? (r.source_url as string | null),
    category: r.category as string | null,
    isPinterestPin: true,
  });
  return {
    id: r.id as string,
    image_url: (r.image_url as string) ?? "",
    title: (r.title as string | undefined) ?? keyword ?? undefined,
    source_keyword: keyword,
    save_count: saveCount,
    category: r.category ? catLabel(String(r.category)) : undefined,
    visual_format: undefined,
    source_url: r.source_url as string | null,
    outbound_link: r.outbound_link as string | null,
    item_type: classified.item_type,
    product_type: classified.product_type,
    product_subtype: classified.product_subtype,
    destination_type: classified.destination_type,
    asset_role: classified.asset_role,
    source_context: classified.source_context,
    risk_flags: classified.risk_flags,
  };
}

/** Shared fetch path for Pin Ideas / reference picker (API-first, same data family as discover). */
export async function fetchPinIdeasWithMeta(): Promise<PinIdeasFetchResult> {
  try {
    const resp = await fetchWithTimeout("/api/viral-pins?limit=160");
    if (resp.ok) {
      const json = await resp.json() as Record<string, unknown>;
      const rows = (json.items ?? json.data ?? []) as Record<string, unknown>[];
      const pins = rows.map(mapApiRow).filter(p => !!p.image_url && shouldShowInPinIdeas(p));
      return {
        pins,
        lastUpdatedAt: (json.lastUpdatedAt as string | null) ?? null,
        source: (json.source as string) ?? "pin_ideas_api",
        itemCount: typeof json.itemCount === "number" ? json.itemCount : pins.length,
      };
    }
  } catch {
    /* fall through */
  }

  try {
    const { supabase } = await import("@/lib/supabase");
    const { data, error } = await supabase
      .from("pin_samples")
      .select("id,image_url,save_count,source_keyword,title,description,category,source_url,outbound_link,scraped_at")
      .not("image_url", "is", null)
      .order("save_count", { ascending: false })
      .limit(160);

    if (error) throw new Error(error.message);

    const pins = (data ?? []).map(r => mapApiRow(r as Record<string, unknown>)).filter(p => !!p.image_url && shouldShowInPinIdeas(p));

    const scraped = (data ?? []).map(r => r.scraped_at as string | null).filter(Boolean) as string[];
    const lastUpdatedAt = scraped.length ? scraped.sort().reverse()[0] : null;

    return {
      pins,
      lastUpdatedAt,
      source: "pin_samples_fallback",
      itemCount: pins.length,
    };
  } catch (e) {
    throw new Error(e instanceof Error ? e.message : "Failed to load pin ideas");
  }
}

export async function fetchPinIdeas(): Promise<PinIdea[]> {
  const result = await fetchPinIdeasWithMeta();
  return result.pins;
}

export function mapPinIdeaToPickerAsset(idea: PinIdea): PinIdeaPickerAsset {
  const saves = idea.save_count;
  const saveSignal = saves >= 10_000 ? "High saves"
    : saves >= 1_000 ? "Growing"
    : saves >= 100 ? "Moderate"
    : undefined;

  return {
    id: idea.id,
    imageUrl: idea.image_url,
    title: idea.title ?? idea.source_keyword ?? undefined,
    source: "pin_ideas",
    assetRole: "pin_reference",
    category: idea.category,
    keyword: idea.source_keyword ?? undefined,
    visualFormat: idea.visual_format,
    saveSignal,
  };
}
