export type ItemType =
  | "product"
  | "product_collection"
  | "pin_idea"
  | "content_opportunity"
  | "unknown";

export type ProductType =
  | "physical_product"
  | "digital_product"
  | "service"
  | "unknown";

export type ProductSubtype =
  | "apparel"
  | "home_decor"
  | "beauty"
  | "jewelry"
  | "craft_supply"
  | "travel_gear"
  | "food_drink"
  | "printable"
  | "template"
  | "digital_download"
  | "game_asset"
  | "map_asset"
  | "course"
  | "ebook"
  | "software"
  | "unknown";

export type DestinationType =
  | "product_page"
  | "digital_download_product_page"
  | "collection_page"
  | "article"
  | "blog_post"
  | "video"
  | "tutorial"
  | "game_content"
  | "direct_image"
  | "unknown";

export type AssetRoleV2 =
  | "product_image"
  | "pin_reference"
  | "content_source";

export type SourceContext =
  | "uploaded"
  | "url_imported"
  | "discovered_from_pin"
  | "discovered_from_trends"
  | "saved_from_product_ideas"
  | "saved_from_pin_ideas";

export type RiskFlag = "ip_sensitive";

export type ClassifiedAsset = {
  item_type: ItemType;
  product_type: ProductType;
  product_subtype: ProductSubtype;
  destination_type: DestinationType;
  asset_role: AssetRoleV2;
  source_context: SourceContext;
  risk_flags: RiskFlag[];
};

export type ClassificationInput = {
  title?: string | null;
  description?: string | null;
  domain?: string | null;
  sourceUrl?: string | null;
  destinationUrl?: string | null;
  price?: number | string | null;
  currency?: string | null;
  category?: string | null;
  source?: string | null;
  isPinterestPin?: boolean;
  hasProductSchema?: boolean;
  hasCommerceSignals?: boolean;
  hasDownloadSignals?: boolean;
};

const SHOP_DOMAINS = [
  "shopify", "etsy", "woocommerce", "gumroad", "payhip",
  "creativefabrica", "creativemarket", "amazon", "ebay",
];

const DIGITAL_TOKENS = [
  "digital", "download", "printable", "template", "canva", "notion",
  "planner", "ebook", "pdf", "course", "preset", "software", "svg",
  "mockup", "worksheet", "spreadsheet", "gumroad", "payhip",
];

const GAME_ASSET_TOKENS = [
  "minecraft", "game asset", "game map", "map pack", "city map",
  "world download", "unity asset", "unreal asset", "roblox",
];

const ARTICLE_TOKENS = [
  "article", "blog", "blog post", "guide", "how to", "ideas",
  "tutorial", "tips", "recipe", "review", "roundup",
];

const VIDEO_TOKENS = [
  "youtube", "youtu.be", "vimeo", "video", "shorts", "watch",
];

const IP_TOKENS = [
  "minecraft", "anime", "danmachi", "disney", "pokemon", "marvel",
  "harry potter", "barbie", "lego", "nintendo",
];

function textOf(input: ClassificationInput): string {
  return [
    input.title,
    input.description,
    input.domain,
    input.sourceUrl,
    input.destinationUrl,
    input.category,
    input.source,
  ].filter(Boolean).join(" ").toLowerCase();
}

function containsAny(text: string, tokens: string[]): boolean {
  return tokens.some(token => text.includes(token));
}

function hasPrice(input: ClassificationInput): boolean {
  if (typeof input.price === "number") return input.price > 0;
  if (typeof input.price === "string") return /\$|€|£|\b(price|usd|eur|gbp)\b/i.test(input.price);
  return false;
}

export function inferProductSubtype(input: ClassificationInput): ProductSubtype {
  const text = textOf(input);
  if (containsAny(text, ["map pack", "city map", "game map", "minecraft map", "world download"])) return "map_asset";
  if (containsAny(text, GAME_ASSET_TOKENS)) return "game_asset";
  if (containsAny(text, ["printable", "planner", "worksheet", "checklist"])) return "printable";
  if (containsAny(text, ["template", "canva", "notion"])) return "template";
  if (containsAny(text, ["ebook", "pdf book"])) return "ebook";
  if (containsAny(text, ["course", "lesson", "workshop"])) return "course";
  if (containsAny(text, ["software", "app", "plugin", "tool"])) return "software";
  if (containsAny(text, ["download", "digital file", "svg", "preset", "mockup"])) return "digital_download";
  if (containsAny(text, ["ring", "bracelet", "necklace", "jewelry", "jewellery"])) return "jewelry";
  if (containsAny(text, ["yarn", "fabric", "bead", "craft", "crochet", "knit kit", "embroidery", "clay", "diy kit", "scrapbook"])) return "craft_supply";
  if (containsAny(text, ["luggage", "suitcase", "backpack", "travel", "packing cube", "passport", "carry on", "duffel"])) return "travel_gear";
  if (containsAny(text, ["dress", "jeans", "shirt", "handbag", "outfit", "shoe"])) return "apparel";
  if (containsAny(text, ["skincare", "makeup", "beauty", "nail"])) return "beauty";
  if (containsAny(text, ["snack", "coffee", "tea", "drink", "sauce", "spice", "granola", "chocolate", "beverage"])) return "food_drink";
  if (containsAny(text, ["decor", "wall art", "pillow", "candle", "vase", "lamp", "rug"])) return "home_decor";
  return "unknown";
}

export function inferDestinationType(input: ClassificationInput): DestinationType {
  const text = textOf(input);
  if (/\.(jpg|jpeg|png|webp|gif)(\?|#|$)/i.test(input.destinationUrl ?? input.sourceUrl ?? "")) return "direct_image";
  if (containsAny(text, VIDEO_TOKENS)) return "video";
  if (containsAny(text, ["tutorial", "how to"])) return "tutorial";
  if (containsAny(text, ["blog", "blog post"])) return "blog_post";
  if (containsAny(text, ["game guide", "walkthrough", "gameplay"])) return "game_content";
  if (containsAny(text, ARTICLE_TOKENS)) return "article";
  if (containsAny(text, ["collection", "shop the look", "lookbook"])) return "collection_page";
  if (input.hasDownloadSignals || containsAny(text, DIGITAL_TOKENS) || containsAny(text, GAME_ASSET_TOKENS)) {
    return "digital_download_product_page";
  }
  if (input.hasProductSchema || input.hasCommerceSignals || hasPrice(input) || containsAny(text, SHOP_DOMAINS)) return "product_page";
  return "unknown";
}

export function classifyDestination(input: ClassificationInput): ClassifiedAsset {
  const text = textOf(input);
  const destination_type = inferDestinationType(input);
  const product_subtype = inferProductSubtype(input);
  const isDigital =
    destination_type === "digital_download_product_page" ||
    product_subtype === "printable" ||
    product_subtype === "template" ||
    product_subtype === "digital_download" ||
    product_subtype === "game_asset" ||
    product_subtype === "map_asset" ||
    product_subtype === "course" ||
    product_subtype === "ebook" ||
    product_subtype === "software";
  const commerce =
    input.hasProductSchema ||
    input.hasCommerceSignals ||
    hasPrice(input) ||
    destination_type === "product_page" ||
    destination_type === "digital_download_product_page";

  if (destination_type === "collection_page") {
    return {
      item_type: "product_collection",
      product_type: isDigital ? "digital_product" : "physical_product",
      product_subtype,
      destination_type,
      asset_role: "product_image",
      source_context: input.isPinterestPin ? "discovered_from_pin" : "discovered_from_trends",
      risk_flags: containsAny(text, IP_TOKENS) ? ["ip_sensitive"] : [],
    };
  }

  if (commerce) {
    return {
      item_type: "product",
      product_type: isDigital ? "digital_product" : "physical_product",
      product_subtype,
      destination_type,
      asset_role: "product_image",
      source_context: input.isPinterestPin ? "discovered_from_pin" : "discovered_from_trends",
      risk_flags: containsAny(text, IP_TOKENS) ? ["ip_sensitive"] : [],
    };
  }

  const contentType: ItemType =
    destination_type === "article" ||
    destination_type === "blog_post" ||
    destination_type === "video" ||
    destination_type === "tutorial" ||
    destination_type === "game_content"
      ? "content_opportunity"
      : "pin_idea";

  return {
    item_type: contentType,
    product_type: "unknown",
    product_subtype,
    destination_type,
    asset_role: "pin_reference",
    source_context: input.isPinterestPin ? "discovered_from_pin" : "discovered_from_trends",
    risk_flags: containsAny(text, IP_TOKENS) ? ["ip_sensitive"] : [],
  };
}

export function classifySourcePin(input: ClassificationInput): ClassifiedAsset {
  const dest = classifyDestination({ ...input, isPinterestPin: true });
  return {
    ...dest,
    item_type: dest.item_type === "content_opportunity" ? "content_opportunity" : "pin_idea",
    asset_role: "pin_reference",
    source_context: "discovered_from_pin",
  };
}

export function normalizeLegacyAssetRole(role?: string | null, assetRole?: string | null): AssetRoleV2 {
  if (assetRole === "product_image" || assetRole === "pin_reference" || assetRole === "content_source") return assetRole;
  if (role === "product") return "product_image";
  if (role === "style_reference") return "pin_reference";
  return "content_source";
}

export function shouldShowInProductIdeas(item: Partial<ClassifiedAsset>): boolean {
  if (item.item_type !== "product" && item.item_type !== "product_collection") return false;
  if (item.risk_flags?.includes("ip_sensitive")) return false;
  if (item.product_subtype === "game_asset" || item.product_subtype === "map_asset") return false;
  return true;
}

export function shouldShowInPinIdeas(item: Partial<ClassifiedAsset>): boolean {
  return item.item_type === "pin_idea" || item.item_type === "content_opportunity";
}

export function isProductPickerAsset(item: { role?: string | null; assetRole?: string | null }): boolean {
  return normalizeLegacyAssetRole(item.role, item.assetRole) === "product_image";
}

export function isReferencePickerAsset(item: { role?: string | null; assetRole?: string | null }): boolean {
  return normalizeLegacyAssetRole(item.role, item.assetRole) === "pin_reference";
}
