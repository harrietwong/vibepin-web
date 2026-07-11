// Creative Asset Model V1 — Studio-level normalization for digital products.
//
// Digital Product is an OFFER FAMILY, not a single visual style. This module turns
// raw product inputs (title / category / metadata / source / url / digital_format /
// subtype) into a stable, deterministic structure that the rest of the Studio
// pipeline (AI Understanding, Creative Directions, Hidden Prompt, Setup Snapshot)
// can rely on — with NO LLM and NO network calls.
//
// Separation of concerns:
//   OfferFamily        what is being promoted          (digital_product, physical_product, …)
//   DigitalProductType the kind of digital product     (planner, notion_template, course, …)
//   VisualizationMode  how it should be visualized      (paper_preview, device_mockup, …)
//   PinArchetype       what Pin format to generate      (product_preview, preview_breakdown, benefit_info)

// ── Public enums ────────────────────────────────────────────────────────────────

export type OfferFamily =
  | "physical_product"
  | "digital_product"
  | "content"
  | "service"
  | "affiliate"
  | "unknown";

export type DigitalProductType =
  | "planner"
  | "printable"
  | "worksheet"
  | "checklist"
  | "ebook"
  | "guide"
  | "course"
  | "notion_template"
  | "canva_template"
  | "digital_art"
  | "template"
  | "other";

export type VisualizationMode =
  | "paper_preview"
  | "device_mockup"
  | "cover_mockup"
  | "multi_preview_collage"
  | "benefit_info"
  | "framed_art"
  | "lifestyle_scene"
  | "generic_product";

export type PinArchetype =
  | "product_preview"
  | "preview_breakdown"
  | "benefit_info";

// Reference roles, interpreted for digital products (layout/hierarchy — never pose/style).
export type DigitalReferenceRole =
  | "information_pin"
  | "checklist_pin"
  | "template_mockup"
  | "collage"
  | "course_graphic"
  | "lifestyle_scene"
  | "generic_layout_reference";

export type Confidence = "high" | "medium" | "low";

export type NormalizedSource =
  | "upload"
  | "product_idea"
  | "my_product"
  | "url_import"
  | "digital_seed"
  | "unknown";

export type NormalizedCreativeAsset = {
  id: string;
  source: NormalizedSource;
  role: "product" | "reference";
  title?: string;
  imageUrl?: string;
  sourceUrl?: string;
  offerFamily: OfferFamily;
  physicalCategory?: string;
  digitalProductType?: DigitalProductType;
  visualizationMode?: VisualizationMode;
  pinArchetype?: PinArchetype;
  confidence: Confidence;
  signals: string[];
  raw?: unknown;
};

// Loose input shape — compatible with SelectedCreativeAsset and raw asset metadata.
export type NormalizeInput = {
  id?: string;
  role?: "product" | "reference";
  title?: string | null;
  imageUrl?: string | null;
  category?: string | null;
  keyword?: string | null;
  productType?: string | null;     // physical_product | digital_product | service | …
  productSubtype?: string | null;  // printable | template | course | ebook | …
  itemType?: string | null;        // product | content_opportunity | pin_idea | …
  destinationType?: string | null;
  sourceContext?: string | null;
  source?: string | null;
  productUrl?: string | null;
  sourceUrl?: string | null;
  sourceDomain?: string | null;
  digitalFormat?: string | null;   // from the digital seed library (DigitalFormat)
  visualFormat?: string | null;
};

// ── Token banks ─────────────────────────────────────────────────────────────────

const DIGITAL_TOKENS = [
  "printable", "template", "worksheet", "planner", "tracker", "checklist",
  "calendar", "spreadsheet", "notion", "canva", "editable", "download",
  "pdf", "svg", "clipart", "digital paper", "preset", "ebook", "e-book",
  "guide", "printout", "workbook", "course", "lesson", "masterclass",
  "digital download", "lightroom", "mockup template",
];
const PHYSICAL_CATEGORY_TOKENS = [
  "fashion", "outfit", "apparel", "dress", "jeans", "shoe", "bag",
  "home decor", "decor", "furniture", "sofa", "lamp", "rug", "vase",
  "beauty", "makeup", "skincare", "serum", "lipstick",
  "food", "drink", "recipe", "kitchen",
];
const AFFILIATE_TOKENS = ["affiliate", "commission", "amazon associate", "shareasale", "rakuten"];
const SERVICE_TOKENS = ["service", "coaching", "consultation", "booking", "appointment", "session with"];

function lc(s?: string | null): string { return (s ?? "").toLowerCase(); }

function textOf(i: NormalizeInput): string {
  return [i.title, i.category, i.keyword, i.productType, i.productSubtype, i.itemType, i.sourceContext, i.digitalFormat, i.sourceDomain]
    .map(lc).filter(Boolean).join(" ");
}
function has(text: string, tokens: string[]): boolean {
  return tokens.some(t => text.includes(t));
}
function hasImage(i: NormalizeInput): boolean {
  return !!(i.imageUrl && i.imageUrl.trim());
}

// ── Source normalization ─────────────────────────────────────────────────────────

function normalizeSource(i: NormalizeInput): NormalizedSource {
  const s = lc(i.source);
  if (!s) return "unknown";
  if (s.includes("upload")) return "upload";
  if (s.includes("url")) return "url_import";
  if (s.includes("digital_seed") || s.includes("digital_idea")) return "digital_seed";
  if (s.includes("product_idea") || s.includes("product_signal") || s.includes("product_signals")) return "product_idea";
  if (s.includes("my_product") || s.includes("library") || s === "recent") return "my_product";
  return "unknown";
}

// ── deriveOfferFamily ─────────────────────────────────────────────────────────────

export function deriveOfferFamily(input: NormalizeInput): OfferFamily {
  const text = textOf(input);
  const pType = lc(input.productType);

  if (pType === "digital_product" || pType === "digital") return "digital_product";
  if (pType === "physical_product") return "physical_product";
  if (pType === "service") return "service";

  if (has(text, AFFILIATE_TOKENS)) return "affiliate";
  if (lc(input.itemType) === "content_opportunity") return "content";
  if (has(text, SERVICE_TOKENS)) return "service";

  // Digital signals beat physical-category words when both are weak.
  if (has(text, DIGITAL_TOKENS)) return "digital_product";
  if (lc(input.category).includes("digital")) return "digital_product";

  if (has(text, PHYSICAL_CATEGORY_TOKENS)) return "physical_product";
  if (pType) return "physical_product";

  return "unknown";
}

// ── deriveDigitalProductType ──────────────────────────────────────────────────────

const FORMAT_TO_TYPE: Record<string, DigitalProductType> = {
  planner: "planner", printable: "printable", worksheet: "worksheet", checklist: "checklist",
  tracker: "checklist", canva_template: "canva_template", notion_template: "notion_template",
  spreadsheet: "template", pdf_guide: "guide", template: "template",
};
const SUBTYPE_TO_TYPE: Record<string, DigitalProductType> = {
  printable: "printable", template: "template", course: "course", ebook: "ebook",
  digital_download: "other", game_asset: "other", map_asset: "other", software: "other",
};

export function deriveDigitalProductType(input: NormalizeInput): DigitalProductType {
  const fmt = lc(input.digitalFormat);
  if (fmt && FORMAT_TO_TYPE[fmt]) return FORMAT_TO_TYPE[fmt];

  const sub = lc(input.productSubtype);
  if (sub && SUBTYPE_TO_TYPE[sub]) return SUBTYPE_TO_TYPE[sub];

  const t = textOf(input);
  if (/\bnotion\b/.test(t)) return "notion_template";
  if (/\bcanva\b/.test(t)) return "canva_template";
  if (/\bcourse\b|\blesson\b|masterclass|workshop|\bmodule\b/.test(t)) return "course";
  if (/\bebook\b|e-book/.test(t)) return "ebook";
  if (/\bguide\b|workbook|how-to guide/.test(t)) return "guide";
  if (/\bplanner\b|\bagenda\b|\bcalendar\b/.test(t)) return "planner";
  if (/\bworksheet\b/.test(t)) return "worksheet";
  if (/\bchecklist\b|\btracker\b/.test(t)) return "checklist";
  if (/wall art|printable art|digital art|art print|\bposter\b|\bclipart\b|svg art|digital paper/.test(t)) return "digital_art";
  if (/\btemplate\b|instagram template|social template|story template/.test(t)) return "template";
  if (/\bprintable\b|print at home|printout/.test(t)) return "printable";
  if (/\bspreadsheet\b/.test(t)) return "template";
  return "other";
}

// ── deriveVisualizationMode + derivePinArchetype ──────────────────────────────────
// Coupled, deterministic. ebook/guide/other branch on whether a preview image exists.

type VizArch = { visualizationMode: VisualizationMode; pinArchetype: PinArchetype };

function typeToVizArch(type: DigitalProductType, withImage: boolean): VizArch {
  switch (type) {
    case "planner":         return { visualizationMode: "paper_preview",          pinArchetype: "product_preview" };
    case "printable":       return { visualizationMode: "paper_preview",          pinArchetype: "product_preview" };
    case "worksheet":       return { visualizationMode: "paper_preview",          pinArchetype: "product_preview" };
    case "checklist":       return { visualizationMode: "multi_preview_collage",  pinArchetype: "preview_breakdown" };
    case "notion_template": return { visualizationMode: "device_mockup",          pinArchetype: "preview_breakdown" };
    case "canva_template":  return { visualizationMode: "multi_preview_collage",  pinArchetype: "preview_breakdown" };
    case "template":        return { visualizationMode: "multi_preview_collage",  pinArchetype: "preview_breakdown" };
    case "digital_art":     return { visualizationMode: "framed_art",             pinArchetype: "product_preview" };
    case "course":          return { visualizationMode: "benefit_info",           pinArchetype: "benefit_info" };
    case "ebook":
    case "guide":
      return withImage
        ? { visualizationMode: "cover_mockup",  pinArchetype: "product_preview" }
        : { visualizationMode: "benefit_info",  pinArchetype: "benefit_info" };
    case "other":
    default:
      return withImage
        ? { visualizationMode: "generic_product", pinArchetype: "benefit_info" }
        : { visualizationMode: "benefit_info",    pinArchetype: "benefit_info" };
  }
}

export function deriveVisualizationMode(input: NormalizeInput): VisualizationMode {
  return typeToVizArch(deriveDigitalProductType(input), hasImage(input)).visualizationMode;
}
export function derivePinArchetype(input: NormalizeInput): PinArchetype {
  return typeToVizArch(deriveDigitalProductType(input), hasImage(input)).pinArchetype;
}

// ── normalizeProductForStudio ─────────────────────────────────────────────────────

export function normalizeProductForStudio(input: NormalizeInput): NormalizedCreativeAsset {
  const role = input.role === "reference" ? "reference" : "product";
  const offerFamily = deriveOfferFamily(input);
  const signals: string[] = [];
  const base: NormalizedCreativeAsset = {
    id: input.id ?? `asset-${Math.random().toString(36).slice(2, 8)}`,
    source: normalizeSource(input),
    role,
    title: input.title?.trim() || undefined,
    imageUrl: input.imageUrl?.trim() || undefined,
    sourceUrl: input.productUrl?.trim() || input.sourceUrl?.trim() || undefined,
    offerFamily,
    confidence: "low",
    signals,
    raw: input,
  };

  if (offerFamily === "digital_product" || offerFamily === "affiliate") {
    if (offerFamily === "affiliate") {
      base.digitalProductType = "other";
      base.visualizationMode = "benefit_info";
      base.pinArchetype = "benefit_info";
      signals.push("offer:affiliate→benefit_info");
    } else {
      const type = deriveDigitalProductType(input);
      const { visualizationMode, pinArchetype } = typeToVizArch(type, hasImage(input));
      base.digitalProductType = type;
      base.visualizationMode = visualizationMode;
      base.pinArchetype = pinArchetype;
      signals.push(`type:${type}`, `viz:${visualizationMode}`, `archetype:${pinArchetype}`);
    }
    // Confidence: explicit metadata > token inference > category-only.
    const explicit = !!(input.digitalFormat || (input.productSubtype && SUBTYPE_TO_TYPE[lc(input.productSubtype)]) ||
      lc(input.productType) === "digital_product");
    const tokenStrong = /\b(notion|canva|planner|printable|worksheet|checklist|course|ebook|guide|template)\b/.test(textOf(input));
    base.confidence = explicit ? "high" : tokenStrong ? "medium" : "low";
  } else if (offerFamily === "physical_product") {
    base.physicalCategory = input.category?.trim() || undefined;
    base.confidence = input.productType ? "high" : "medium";
    signals.push("offer:physical");
  } else {
    signals.push(`offer:${offerFamily}`);
  }

  return base;
}

// ── Reference interpretation (digital) ────────────────────────────────────────────

function digitalReferenceRole(referenceType?: string | null, referenceText?: string | null): DigitalReferenceRole | null {
  if (!referenceType) return null;
  const t = lc(referenceType);
  const txt = lc(referenceText);
  if (txt.includes("checklist") || txt.includes("tracker")) return "checklist_pin";
  switch (t) {
    case "infographic":     return "information_pin";
    case "tutorial":        return "information_pin";
    case "quote":           return "information_pin";
    case "moodboard":       return "collage";
    case "product_showcase":
    case "flat_lay":
    case "close_up":        return "template_mockup";
    case "room_scene":
    case "lifestyle":
    case "travel_scene":    return "lifestyle_scene";
    default:                return "generic_layout_reference";
  }
}

const REFERENCE_ROLE_GUIDANCE: Record<DigitalReferenceRole, string> = {
  information_pin:          "Reference is an information-rich Pin — borrow its layout, text hierarchy, and panel structure. Do NOT copy its text or product.",
  checklist_pin:           "Reference is a checklist Pin — borrow its list/check structure and hierarchy. Do NOT copy the checklist content.",
  template_mockup:         "Reference is a template/product mockup — borrow its mockup placement and preview structure. Do NOT copy the original template content.",
  collage:                 "Reference is a collage/moodboard — borrow its multi-panel grid rhythm and density only.",
  course_graphic:          "Reference is a course/education graphic — borrow its benefit hierarchy and headline emphasis.",
  lifestyle_scene:         "Reference is a lifestyle desk scene — use it only as supporting environment. Keep the digital product clearly visible; do NOT turn the result into a purely decorative lifestyle image.",
  generic_layout_reference: "Use the reference only for layout skeleton, color palette, and CTA placement. Do NOT interpret it as a fashion pose/style reference.",
};

// ── deriveDigitalCreativeIntent ───────────────────────────────────────────────────

export type DigitalDirectionDescriptor = {
  id: string;
  title: string;
  summary: string;
  archetype: PinArchetype;
  kind: "closest_to_reference" | "product_focused" | "alternative";
  whyThisDirection: string;
  promptHints: string[];
};

export type DigitalCreativeIntent = {
  offerFamily: OfferFamily;          // digital_product | affiliate
  digitalProductType: DigitalProductType;
  visualizationMode: VisualizationMode;
  pinArchetype: PinArchetype;
  hasProductImages: boolean;
  confidence: Confidence;
  signals: string[];
  normalizedProductAssets: NormalizedCreativeAsset[];
  // reference interpretation
  referenceRole: DigitalReferenceRole | null;
  referenceInterpretation: string[];
  // AI Understanding labels
  aiUnderstanding: {
    offer: string;
    type: string;
    visualization: string;
    recommendedPinType: string;
  };
  // ordered directions (default first → follows pinArchetype)
  directions: DigitalDirectionDescriptor[];
  defaultDirectionId: string;
  summary: string;
};

const TYPE_LABEL: Record<DigitalProductType, string> = {
  planner: "Planner", printable: "Printable", worksheet: "Worksheet", checklist: "Checklist",
  ebook: "Ebook", guide: "Guide", course: "Course", notion_template: "Notion Template",
  canva_template: "Canva Template", digital_art: "Digital Art", template: "Template", other: "Digital Product",
};
const VIZ_LABEL: Record<VisualizationMode, string> = {
  paper_preview: "Paper preview", device_mockup: "Device mockup", cover_mockup: "Cover mockup",
  multi_preview_collage: "Multi-preview collage", benefit_info: "Benefit info", framed_art: "Framed art",
  lifestyle_scene: "Lifestyle scene", generic_product: "Product preview",
};
const ARCHETYPE_LABEL: Record<PinArchetype, string> = {
  product_preview: "Product preview", preview_breakdown: "Preview breakdown", benefit_info: "Benefit info",
};

// Canonical 3 digital directions (always present; order is set by archetype default).
function canonicalDigitalDirections(hasReferences: boolean): Record<PinArchetype, DigitalDirectionDescriptor> {
  const refKind = hasReferences ? "closest_to_reference" : "product_focused";
  return {
    product_preview: {
      id: "digital-product-preview",
      title: "Product Preview Mockup",
      archetype: "product_preview",
      kind: "product_focused",
      summary: "Show the digital product as a clean, premium preview/mockup (cover, page, or printable) that is instantly legible and Pinterest-ready.",
      whyThisDirection: "The product has a cover/page/printable that reads well as a single hero preview.",
      promptHints: [
        "Show one clear hero preview (cover / page / printable / framed art).",
        "Keep any on-product text crisp and legible; do not fabricate fake brands.",
      ],
    },
    preview_breakdown: {
      id: "digital-preview-breakdown",
      title: "Multi-page Preview & Feature Breakdown",
      archetype: "preview_breakdown",
      kind: refKind,
      summary: "Present multiple pages/screens as a feature breakdown — device mockup or multi-preview collage that shows everything the bundle includes.",
      whyThisDirection: "Template bundles, Notion dashboards, and multi-page packs are best sold by showing the range of what's inside.",
      promptHints: [
        "Arrange several previews/screens as a tidy collage or device mockup.",
        "Use a clear visual hierarchy that signals the number of pages/features.",
      ],
    },
    benefit_info: {
      id: "digital-benefit-info",
      title: "Benefit-led Information Pin",
      archetype: "benefit_info",
      kind: "alternative",
      summary: "Lead with the benefit and outcome using a clean, mobile-readable information layout — ideal when value matters more than the object.",
      whyThisDirection: "Courses, guides, lead magnets, and affiliate offers convert on outcome/benefit, not on a physical object shot.",
      promptHints: [
        "Lead with the core benefit/outcome as a mobile-readable headline hierarchy.",
        "Do not fabricate a fake physical mockup when there is no real preview asset.",
      ],
    },
  };
}

function orderedDirections(archetype: PinArchetype, hasReferences: boolean): DigitalDirectionDescriptor[] {
  const all = canonicalDigitalDirections(hasReferences);
  const order: PinArchetype[] = [archetype, ...(["product_preview", "preview_breakdown", "benefit_info"] as PinArchetype[]).filter(a => a !== archetype)];
  return order.map(a => all[a]);
}

export type DigitalIntentInput = {
  assets: NormalizeInput[];
  dominantReferenceType?: string | null;
  dominantReferenceText?: string | null;
  hasReferences?: boolean;
  category?: string | null;
  keyword?: string | null;
  refinement?: string | null;
};

/**
 * Returns a structured digital creative intent when the dominant offer is a digital
 * product (or affiliate). Returns null for physical / content / unknown offers so the
 * physical pipeline is never routed through digital logic.
 */
export function deriveDigitalCreativeIntent(input: DigitalIntentInput): DigitalCreativeIntent | null {
  const productInputs = input.assets.filter(a => (a.role ?? "product") === "product");
  const normalizedProducts = productInputs.map(normalizeProductForStudio);
  const digital = normalizedProducts.filter(a => a.offerFamily === "digital_product" || a.offerFamily === "affiliate");

  const categoryIsDigital = lc(input.category).includes("digital");
  const keywordIsDigital = has(lc(input.keyword), DIGITAL_TOKENS);

  let dominant: NormalizedCreativeAsset | null = digital[0] ?? null;

  // No digital product asset, but the category/keyword clearly signals digital
  // (e.g. keyword-led "notion budget template", course landing with no preview image).
  if (!dominant && (categoryIsDigital || keywordIsDigital)) {
    dominant = normalizeProductForStudio({
      title: input.keyword ?? undefined,
      category: input.category ?? "digital-products",
      keyword: input.keyword ?? undefined,
      productType: "digital_product",
    });
  }
  if (!dominant) return null;

  const offerFamily = dominant.offerFamily;
  const digitalProductType = dominant.digitalProductType ?? "other";
  const visualizationMode = dominant.visualizationMode ?? "benefit_info";
  const pinArchetype = dominant.pinArchetype ?? "benefit_info";
  const hasProductImages = normalizedProducts.some(a => !!a.imageUrl);
  const hasReferences = !!input.hasReferences;

  const referenceRole = digitalReferenceRole(input.dominantReferenceType, input.dominantReferenceText);
  const referenceInterpretation = referenceRole
    ? [
        REFERENCE_ROLE_GUIDANCE[referenceRole],
        "Use the reference for layout skeleton, text hierarchy, panel structure, headline style, mockup placement, CTA placement, color palette, visual density, and mobile readability.",
        "Do NOT copy the reference's original text, product, or brand. Do NOT interpret it as a fashion pose/style reference.",
      ]
    : [];

  const directions = orderedDirections(pinArchetype, hasReferences);

  const offerLabel = offerFamily === "affiliate" ? "Affiliate offer" : "Digital Product";
  const summary = `${offerLabel} · ${TYPE_LABEL[digitalProductType]} → ${VIZ_LABEL[visualizationMode]} → ${ARCHETYPE_LABEL[pinArchetype]}`;

  return {
    offerFamily,
    digitalProductType,
    visualizationMode,
    pinArchetype,
    hasProductImages,
    confidence: dominant.confidence,
    signals: dominant.signals,
    normalizedProductAssets: normalizedProducts,
    referenceRole,
    referenceInterpretation,
    aiUnderstanding: {
      offer: offerLabel,
      type: TYPE_LABEL[digitalProductType],
      visualization: VIZ_LABEL[visualizationMode],
      recommendedPinType: ARCHETYPE_LABEL[pinArchetype],
    },
    directions,
    defaultDirectionId: directions[0].id,
    summary,
  };
}
