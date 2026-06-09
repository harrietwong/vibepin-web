import { getCategoryMatchSet, catLabel } from "@/lib/categories";
import { matchesCategory } from "@/lib/productIdeasCategoryMatch";
import {
  classifyDestination,
  shouldShowInProductIdeas,
  type AssetRoleV2,
  type DestinationType,
  type ItemType,
  type ProductSubtype,
  type ProductType,
  type RiskFlag,
  type SourceContext,
} from "@/lib/assetClassification";

export type ProductIdea = {
  id:                    string;
  product_name:          string;
  price:                 number | null;
  currency:              string | null;
  source_url:            string | null;
  domain:                string | null;
  merchant:              string | null;
  image_url:             string;
  save_count:            number;
  reaction_count:        number;
  source_pin_save_count: number;
  seed_keyword:          string | null;
  parent_pin_id:         string;
  scraped_at:            string | null;
  opportunity_score:     number | null;
  trend_score:           number | null;
  save_velocity_score:   number | null;
  item_type?:            ItemType;
  product_type?:         ProductType;
  product_subtype?:      ProductSubtype;
  destination_type?:     DestinationType;
  asset_role?:           AssetRoleV2;
  source_context?:       SourceContext;
  risk_flags?:           RiskFlag[];
};

export type ProductIdeaPickerAsset = {
  id:           string;
  imageUrl:     string;
  title:        string;
  source:       "product_ideas";
  assetRole:    "product_image";
  category?:    string;
  productUrl?:  string;
  sourceDomain?: string;
};

export const PRODUCT_IDEAS_SWR_KEY = "pin_products_scored";

export type ProductIdeasFetchResult = {
  products: ProductIdea[];
  lastUpdatedAt: string | null;
  source: string;
  itemCount: number;
};

export const PRODUCT_IDEA_PICKER_CATEGORIES = [
  "All Products",
  "Home Decor",
  "Fashion",
  "Beauty",
  "DIY & Crafts",
  "Digital Products",
  "Food & Drink",
  "Wedding",
  "Travel",
] as const;

const LABEL_TO_CAT_ID: Record<string, string> = {
  "Home Decor":       "home-decor",
  "Fashion":          "fashion",
  "Beauty":           "beauty",
  "DIY & Crafts":     "diy-crafts",
  "Digital Products": "digital-products",
  "Food & Drink":     "food-and-drink",
  "Wedding":          "wedding",
  "Travel":           "travel",
};

function mapApiRow(r: Record<string, unknown>): ProductIdea {
  return {
    id:                    r.id as string,
    product_name:          r.product_name as string,
    price:                 r.price as number | null,
    currency:              r.currency as string | null,
    source_url:            r.source_url as string | null,
    domain:                r.domain as string | null,
    merchant:              r.merchant as string | null,
    image_url:             (r.image_url as string) ?? "",
    save_count:            (r.save_count as number) ?? 0,
    reaction_count:        0,
    source_pin_save_count: (r.source_pin_save_count as number) ?? 0,
    seed_keyword:          r.seed_keyword as string | null,
    parent_pin_id:         "",
    scraped_at:            r.scraped_at as string | null,
    opportunity_score:     r.opportunity_score as number | null,
    trend_score:           r.trend_score as number | null,
    save_velocity_score:   r.save_velocity_score as number | null,
    item_type:             r.item_type as ItemType | undefined,
    product_type:          r.product_type as ProductType | undefined,
    product_subtype:       r.product_subtype as ProductSubtype | undefined,
    destination_type:      r.destination_type as DestinationType | undefined,
    asset_role:            r.asset_role as AssetRoleV2 | undefined,
    source_context:        r.source_context as SourceContext | undefined,
    risk_flags:            r.risk_flags as RiskFlag[] | undefined,
  };
}

async function fetchWithTimeout(input: RequestInfo | URL, ms = 15000): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(input, { signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Same fetch path as /app/products (Product Ideas page). */
export async function fetchProductIdeasWithMeta(): Promise<ProductIdeasFetchResult> {
  try {
    const resp = await fetchWithTimeout("/api/products/top?limit=200&sort=opportunity");
    if (resp.ok) {
      const json = await resp.json() as Record<string, unknown>;
      const rows = (json.items ?? json.data ?? []) as Record<string, unknown>[];
      const products = rows.map(mapApiRow).filter(p => !!p.image_url && shouldShowInProductIdeas(p));
      return {
        products,
        lastUpdatedAt: (json.lastUpdatedAt as string | null) ?? null,
        source: (json.source as string) ?? "product_ideas_api",
        itemCount: typeof json.itemCount === "number" ? json.itemCount : products.length,
      };
    }
  } catch {
    /* fall through to Supabase */
  }

  try {
    const { supabase } = await import("@/lib/supabase");
    const { data, error } = await supabase
      .from("pin_products")
      .select("id,product_name,price,currency,source_url,domain,merchant,image_url,save_count,reaction_count,source_pin_save_count,seed_keyword,parent_pin_id,scraped_at")
      .gte("save_count", 10)
      .not("image_url", "is", null)
      .order("save_count", { ascending: false })
      .limit(200);

    if (error) throw new Error(error.message);

    const products = (data ?? []).map(r => {
      const classified = classifyDestination({
        title: r.product_name,
        domain: r.domain,
        sourceUrl: r.source_url,
        price: r.price,
        currency: r.currency,
        category: r.seed_keyword,
        hasCommerceSignals: true,
      });
      return {
        ...r,
        opportunity_score:     null,
        trend_score:           null,
        save_velocity_score:   null,
        item_type:             classified.item_type,
        product_type:          classified.product_type,
        product_subtype:       classified.product_subtype,
        destination_type:      classified.destination_type,
        asset_role:            classified.asset_role,
        source_context:        classified.source_context,
        risk_flags:            classified.risk_flags,
      };
    }).filter(p => shouldShowInProductIdeas(p)) as ProductIdea[];

    const scraped = products.map(p => p.scraped_at).filter(Boolean) as string[];
    const lastUpdatedAt = scraped.length ? scraped.sort().reverse()[0] : null;

    return {
      products,
      lastUpdatedAt,
      source: "pin_products_fallback",
      itemCount: products.length,
    };
  } catch (e) {
    throw new Error(e instanceof Error ? e.message : "Failed to load product ideas");
  }
}

export async function fetchProductIdeas(): Promise<ProductIdea[]> {
  const result = await fetchProductIdeasWithMeta();
  return result.products;
}

export async function fetchProductIdeasCategoryMap(): Promise<Record<string, string>> {
  const { supabase } = await import("@/lib/supabase");
  const map: Record<string, string> = {};

  const { data: kws } = await supabase
    .from("trend_keywords")
    .select("keyword,category")
    .eq("status", "active")
    .limit(3000);
  (kws ?? []).forEach((r: { keyword: string | null; category: string | null }) => {
    if (r.keyword && r.category) map[r.keyword] = r.category;
  });

  const { data: exps } = await supabase
    .from("keyword_expansions")
    .select("expanded_keyword,source_interest")
    .limit(5000);
  (exps ?? []).forEach((r: { expanded_keyword: string | null; source_interest: string | null }) => {
    if (!r.expanded_keyword || !r.source_interest) return;
    const cat = r.source_interest.split(":")[1];
    if (cat && !map[r.expanded_keyword]) map[r.expanded_keyword] = cat;
  });

  return map;
}

export function filterProductIdeas(
  products: ProductIdea[],
  opts: { search: string; categoryLabel: string; kwCatMap?: Record<string, string> },
): ProductIdea[] {
  let list = products.filter(p => !!p.image_url && shouldShowInProductIdeas(p));
  const q = opts.search.trim().toLowerCase();

  if (q) {
    list = list.filter(p =>
      p.product_name.toLowerCase().includes(q) ||
      (p.seed_keyword ?? "").toLowerCase().includes(q) ||
      (p.domain ?? "").toLowerCase().includes(q),
    );
  }

  if (opts.categoryLabel !== "All Products") {
    const catId = LABEL_TO_CAT_ID[opts.categoryLabel];
    if (catId && opts.kwCatMap) {
      const matchSet = getCategoryMatchSet(catId);
      list = list.filter(p => p.seed_keyword != null && matchSet.has(opts.kwCatMap![p.seed_keyword]));
    } else {
      list = list.filter(p =>
        matchesCategory(`${p.product_name} ${p.seed_keyword ?? ""}`, opts.categoryLabel),
      );
    }
  }

  return list;
}

export function mapProductIdeaToPickerAsset(
  idea: ProductIdea,
  kwCatMap?: Record<string, string>,
): ProductIdeaPickerAsset {
  const dbCat = idea.seed_keyword && kwCatMap?.[idea.seed_keyword]
    ? kwCatMap[idea.seed_keyword]
    : undefined;

  return {
    id:           idea.id,
    imageUrl:     idea.image_url,
    title:        idea.product_name,
    source:       "product_ideas",
    assetRole:    "product_image",
    category:     dbCat ? catLabel(dbCat) : undefined,
    productUrl:   idea.source_url ?? undefined,
    sourceDomain: idea.domain ?? undefined,
  };
}
