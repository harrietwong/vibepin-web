/**
 * pinMetadata.ts — source-aware metadata draft generation for generated pins.
 * Pure functions; safe for unit tests and client/server use.
 */

import type { SetupSnapshot } from "./studioPersistence";

export type MetadataConfidence = "high" | "medium" | "low";

export type TitleSourceLabel =
  | "Search-informed"
  | "Product-based"
  | "Opportunity-based"
  | "Reference-based"
  | "Image-based"
  | "Low confidence";

export type TitleCandidateEntry = {
  text: string;
  sourceLabel: TitleSourceLabel;
};

export type MetadataTouchedFlags = {
  titleTouched: boolean;
  descriptionTouched: boolean;
  altTextTouched: boolean;
  destinationUrlTouched: boolean;
  plannedDateTouched: boolean;
};

export const EMPTY_TOUCHED: MetadataTouchedFlags = {
  titleTouched: false,
  descriptionTouched: false,
  altTextTouched: false,
  destinationUrlTouched: false,
  plannedDateTouched: false,
};

export type PinMetadataDraft = {
  titleCandidates: string[];
  titleCandidateEntries?: TitleCandidateEntry[];
  selectedTitle: string;
  descriptionCandidates: string[];
  selectedDescription: string;
  altText: string;
  destinationUrl?: string;
  destinationUrlSource?: string;
  plannedDate?: string;
  boardSuggestion?: string;
  topics?: string[];
  confidence: MetadataConfidence;
  sourceReasons: string[];
  updatedAt: string;
};

export type PinMetadataInput = {
  pinIndex?: number;
  groupIndex?: number;
  keyword?: string;
  category?: string;
  opportunityTitle?: string;
  promptSnapshot?: string;
  setupSnapshot?: SetupSnapshot | null;
  referenceLabel?: string;
  referenceVisualFormat?: string;
  imageCaption?: string;
};

const TITLE_MAX = 100;
const DESC_MAX = 800;
const ALT_MAX = 500;

const IMPORT_SOURCES = new Set([
  "url_import", "product_ideas", "product_signals", "shop_signals", "product_signal",
]);

function cap(s: string, max: number): string {
  const t = s.trim();
  if (t.length <= max) return t;
  return t.slice(0, max - 1).trimEnd() + "…";
}

function titleCase(s: string): string {
  return s.split(/\s+/).filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

function cleanTopic(raw: string | undefined): string {
  const v = (raw ?? "").trim();
  if (!v || v === "undefined" || v === "null") return "";
  return v;
}

function extractPromptTopic(prompt: string): string {
  const m = prompt.match(/for\s+"([^"]+)"/i) ?? prompt.match(/for\s+([^.]+)/i);
  if (m?.[1]) return cleanTopic(m[1]);
  const first = prompt.split(/[.!?]/)[0]?.trim() ?? "";
  if (first.length > 8 && first.length < 60) return first;
  return "";
}

function moodFromReference(refFormat?: string, refLabel?: string): string {
  const fmt = (refFormat ?? "").toLowerCase();
  if (fmt.includes("flat")) return "styled flat lay";
  if (fmt.includes("mirror")) return "mirror outfit";
  if (fmt.includes("room")) return "room scene";
  if (fmt.includes("body") || fmt.includes("on_body")) return "on-body styling";
  if (refLabel?.toLowerCase().includes("reference")) return "editorial";
  return "aesthetic";
}

function audienceForCategory(category: string): string {
  const c = category.toLowerCase();
  if (c.includes("fashion") || c.includes("apparel")) return "your wardrobe";
  if (c.includes("wedding")) return "your big day";
  if (c.includes("food")) return "your kitchen";
  if (c.includes("garden")) return "your garden";
  return "your home";
}

function roomOrProduct(topic: string, productTitle: string): string {
  if (productTitle) return productTitle;
  const c = topic.toLowerCase();
  if (c.includes("bedroom")) return "bedroom";
  if (c.includes("living")) return "living room";
  if (c.includes("kitchen")) return "kitchen";
  if (c.includes("bathroom")) return "bathroom";
  return topic || "space";
}

export type PinSourceContext = {
  isSearchInformed: boolean;
  hasOpportunity: boolean;
  hasProductTitle: boolean;
  hasReference: boolean;
  isImageOnly: boolean;
};

const PIN_IDEA_SOURCES = new Set(["viral_pin", "pin_ideas", "pin_idea"]);

export function isSearchInformedContext(input: PinMetadataInput): boolean {
  const setup = input.setupSnapshot;
  const opp = cleanTopic(input.opportunityTitle) || cleanTopic(setup?.opportunityTitle);
  if (opp) return true;

  const kw = cleanTopic(input.keyword) || cleanTopic(setup?.keyword);
  if (kw && kw.toLowerCase() !== "pinterest content") return true;

  const products = setup?.selectedProducts ?? [];
  if (products.some(p =>
    (p.source && IMPORT_SOURCES.has(p.source)) && p.title?.trim(),
  )) return true;

  const refs = setup?.selectedReferences ?? [];
  if (refs.some(r => r.source && PIN_IDEA_SOURCES.has(r.source))) return true;

  return false;
}

export function isImageOnlyContext(input: PinMetadataInput): boolean {
  if (isSearchInformedContext(input)) return false;
  const setup = input.setupSnapshot;
  const products = setup?.selectedProducts ?? [];
  const refs = setup?.selectedReferences ?? [];
  const hasProductMeta = products.some(p => p.title?.trim() || p.productUrl?.trim());
  const hasPrompt = !!(input.promptSnapshot?.trim() || setup?.promptSnapshot?.trim());
  if (hasProductMeta || hasPrompt || refs.length > 0) return false;
  return products.length > 0;
}

export function analyzePinSourceContext(input: PinMetadataInput): PinSourceContext {
  const setup = input.setupSnapshot;
  const products = setup?.selectedProducts ?? [];
  const productTitle = cleanTopic(products.find(p => p.title?.trim())?.title);
  const hasOpportunity = !!(cleanTopic(input.opportunityTitle) || cleanTopic(setup?.opportunityTitle));
  const hasReference = (setup?.selectedReferences?.length ?? 0) > 0;
  return {
    isSearchInformed: isSearchInformedContext(input),
    hasOpportunity,
    hasProductTitle: !!productTitle,
    hasReference,
    isImageOnly: isImageOnlyContext(input),
  };
}

function labelForPattern(
  patternKind: "topic" | "product" | "reference" | "generic",
  ctx: PinSourceContext,
): TitleSourceLabel {
  if (ctx.isImageOnly) return "Image-based";
  if (patternKind === "product" && ctx.hasProductTitle) return "Product-based";
  if (patternKind === "reference" && ctx.hasReference) return "Reference-based";
  if (ctx.isSearchInformed && patternKind === "topic") return "Search-informed";
  if (ctx.hasOpportunity && patternKind === "topic") return "Opportunity-based";
  if (ctx.isSearchInformed) return "Search-informed";
  if (patternKind === "product" && ctx.hasProductTitle) return "Product-based";
  if (patternKind === "reference") return "Reference-based";
  return "Low confidence";
}

function buildTitleCandidates(opts: {
  topic: string;
  productTitle: string;
  category: string;
  mood: string;
  pinIndex: number;
  ctx: PinSourceContext;
}): TitleCandidateEntry[] {
  const { topic, productTitle, category, mood, pinIndex, ctx } = opts;
  const kw = titleCase(topic || productTitle || category.replace(/-/g, " "));
  const audience = audienceForCategory(category);
  const room = roomOrProduct(topic, productTitle);
  const style = mood.split(" ")[0] || "cozy";

  const patterns: { text: string; kind: "topic" | "product" | "reference" | "generic" }[] = [
    { text: `${kw} Ideas for ${audience}`, kind: "topic" },
    { text: `${titleCase(style)} ${titleCase(room)} Inspiration`, kind: "reference" },
    { text: `Best ${productTitle || kw} Finds for ${audience}`, kind: productTitle ? "product" : "topic" },
    {
      text: productTitle
        ? `How to Style ${titleCase(productTitle)} in a ${titleCase(style)} Space`
        : `How to Style ${kw} in a ${titleCase(style)} Space`,
      kind: productTitle ? "product" : "topic",
    },
    { text: `${kw} Ideas to Try This Week`, kind: "topic" },
    { text: `${kw}: ${mood} Pinterest Inspiration`, kind: "reference" },
  ];

  const seen = new Set<string>();
  const out: TitleCandidateEntry[] = [];
  for (let i = 0; i < patterns.length && out.length < 3; i++) {
    const idx = (i + pinIndex) % patterns.length;
    const t = cap(patterns[idx].text, TITLE_MAX);
    if (t && !seen.has(t.toLowerCase())) {
      seen.add(t.toLowerCase());
      out.push({ text: t, sourceLabel: labelForPattern(patterns[idx].kind, ctx) });
    }
  }
  while (out.length < 3) {
    const filler = cap(`${kw} Inspiration ${out.length + 1}`, TITLE_MAX);
    if (!seen.has(filler.toLowerCase())) {
      seen.add(filler.toLowerCase());
      out.push({ text: filler, sourceLabel: ctx.isImageOnly ? "Image-based" : "Low confidence" });
    } else break;
  }
  return out;
}

export function getTitleCandidateEntries(draft: PinMetadataDraft): TitleCandidateEntry[] {
  if (draft.titleCandidateEntries?.length) return draft.titleCandidateEntries;
  return (draft.titleCandidates ?? []).map(text => ({ text, sourceLabel: "Low confidence" as TitleSourceLabel }));
}

export function shouldShowLowConfidenceHint(draft: PinMetadataDraft): boolean {
  const entries = getTitleCandidateEntries(draft);
  return draft.confidence === "low"
    || entries.every(e => e.sourceLabel === "Low confidence" || e.sourceLabel === "Image-based");
}

export function pinNeedsDetailsGeneration(pin: {
  title?: string;
  description?: string;
  altText?: string;
  metadataDraft?: PinMetadataDraft | null;
}): boolean {
  const missingFields = !pin.title?.trim() || !pin.description?.trim() || !pin.altText?.trim();
  return missingFields || !pin.metadataDraft;
}

function buildDescriptionCandidates(opts: {
  topic: string;
  productTitle: string;
  category: string;
  mood: string;
  promptSnippet: string;
}): string[] {
  const { topic, productTitle, category, mood, promptSnippet } = opts;
  const kw = topic || productTitle || category.replace(/-/g, " ");
  const catLabel = category.replace(/-/g, " ");

  const candidates = [
    `Save these ${kw} ideas for your next ${catLabel} refresh. This pin captures a ${mood} look with Pinterest-native styling — perfect for mood boards and weekly inspiration.`,
    `Looking for ${kw} inspiration? This ${mood} pin blends natural light, thoughtful composition, and save-worthy details. Tap to save and revisit when you plan your next post.`,
    promptSnippet
      ? `${promptSnippet.slice(0, 120).trim()}… Discover ${kw} ideas that feel fresh, polished, and ready for your Pinterest boards.`
      : `Discover beautiful ${kw} ideas for your ${catLabel} space. Save this pin for your next project and get inspired!`,
  ];

  return candidates.map(c => cap(c, DESC_MAX)).filter((c, i, arr) => c && arr.indexOf(c) === i).slice(0, 3);
}

function buildAltText(opts: {
  topic: string;
  productTitle: string;
  mood: string;
  imageCaption?: string;
  pinIndex: number;
}): string {
  const { topic, productTitle, mood, imageCaption, pinIndex } = opts;
  if (imageCaption?.trim()) {
    return cap(`${imageCaption.trim()} — ${mood} Pinterest pin.`, ALT_MAX);
  }
  const subject = productTitle || topic || "styled scene";
  const variants = [
    `Vertical Pinterest pin showing ${subject} in a ${mood} setting with soft natural lighting.`,
    `Aesthetic ${mood} photo featuring ${subject}, composed for Pinterest with editorial styling.`,
    `Save-worthy ${subject} inspiration image with ${mood} composition and warm tones.`,
  ];
  return cap(variants[pinIndex % variants.length], ALT_MAX);
}

function resolveDestinationUrl(setup?: SetupSnapshot | null): {
  url?: string;
  source?: string;
  reasons: string[];
} {
  if (!setup?.selectedProducts?.length) return { reasons: [] };

  const urls = setup.selectedProducts
    .map(p => {
      const url = (p as { productUrl?: string }).productUrl?.trim();
      if (url) return { url, source: p.source ?? "product", title: p.title };
      return null;
    })
    .filter((x): x is { url: string; source: string; title: string } => !!x);

  const unique = [...new Set(urls.map(u => u.url))];
  if (unique.length === 1) {
    const match = urls.find(u => u.url === unique[0])!;
    const label = IMPORT_SOURCES.has(match.source) ? `From ${match.source.replace(/_/g, " ")}` : "From product URL";
    return { url: unique[0], source: label, reasons: [] };
  }
  if (unique.length > 1) {
    return { reasons: ["Multiple product URLs found. Choose a destination URL."] };
  }
  return { reasons: [] };
}

/** Primary topic: opportunity > product title > keyword > prompt topic */
export function resolveMetadataTopic(input: PinMetadataInput): string {
  return cleanTopic(input.opportunityTitle)
    || cleanTopic(input.setupSnapshot?.opportunityTitle)
    || cleanTopic(input.setupSnapshot?.selectedProducts?.find(p => p.title?.trim())?.title)
    || cleanTopic(input.keyword)
    || cleanTopic(input.setupSnapshot?.keyword)
    || extractPromptTopic(input.promptSnapshot ?? input.setupSnapshot?.promptSnapshot ?? "")
    || cleanTopic(input.category?.replace(/-/g, " "));
}

export function generatePinMetadataDraft(input: PinMetadataInput): PinMetadataDraft {
  const now = new Date().toISOString();
  const setup = input.setupSnapshot;
  const category = input.category ?? setup?.category ?? "home-decor";
  const promptSnapshot = input.promptSnapshot ?? setup?.promptSnapshot ?? "";
  const pinIndex = input.pinIndex ?? 0;

  const products = setup?.selectedProducts ?? [];
  const productWithTitle = products.find(p => p.title?.trim());
  const productTitle = cleanTopic(productWithTitle?.title);
  const topic = resolveMetadataTopic(input);

  const ref = setup?.selectedReferences?.[input.groupIndex ?? 0]
    ?? setup?.selectedReferences?.[0];
  const mood = moodFromReference(ref?.visualFormat ?? input.referenceVisualFormat, input.referenceLabel);

  const sourceReasons: string[] = [];
  let confidence: MetadataConfidence = "high";

  const hasImportedProduct = products.some(p =>
    p.title?.trim() && (p.source ? IMPORT_SOURCES.has(p.source) : false),
  );
  const hasProductUrl = products.some(p => !!(p as { productUrl?: string }).productUrl?.trim());
  const uploadedWithoutMeta = products.length > 0 && !productTitle && !hasProductUrl;

  if (input.opportunityTitle || setup?.opportunityTitle) {
    sourceReasons.push("Used opportunity keyword as primary topic.");
  } else if (productTitle) {
    sourceReasons.push("Used product title as primary topic.");
  } else if (promptSnapshot) {
    sourceReasons.push("Used user prompt for topic context.");
    confidence = "medium";
  } else if (ref?.title) {
    sourceReasons.push("Used reference style context for mood words.");
    confidence = "medium";
  }

  if (uploadedWithoutMeta) {
    sourceReasons.push("Product name missing. Add product name or destination URL for better Pin Details.");
    confidence = "low";
  }

  const ctx = analyzePinSourceContext(input);
  if (ctx.isImageOnly) {
    sourceReasons.push("Image-only upload — titles are not search-informed.");
    confidence = "low";
  } else if (!ctx.isSearchInformed && !ctx.hasProductTitle) {
    confidence = confidence === "high" ? "medium" : confidence;
  }

  if (input.imageCaption?.trim()) {
    sourceReasons.push("Image caption used to validate visual content.");
  }

  const dest = resolveDestinationUrl(setup);
  sourceReasons.push(...dest.reasons);

  const titleCandidateEntries = buildTitleCandidates({ topic, productTitle, category, mood, pinIndex, ctx });
  const titleCandidates = titleCandidateEntries.map(e => e.text);
  const descriptionCandidates = buildDescriptionCandidates({
    topic, productTitle, category, mood, promptSnippet: promptSnapshot,
  });
  const altText = buildAltText({ topic, productTitle, mood, imageCaption: input.imageCaption, pinIndex });

  const boardSuggestion = topic
    ? `${titleCase(topic)} Ideas`
    : `${titleCase(category.replace(/-/g, " "))} Inspiration`;

  return {
    titleCandidates,
    titleCandidateEntries,
    selectedTitle: titleCandidates[0] ?? "",
    descriptionCandidates,
    selectedDescription: descriptionCandidates[0] ?? "",
    altText,
    destinationUrl: dest.url,
    destinationUrlSource: dest.source,
    boardSuggestion,
    topics: topic ? [topic] : [],
    confidence,
    sourceReasons,
    updatedAt: now,
  };
}

export type BatchMetadataPinInput = PinMetadataInput & {
  pinId: string;
  touched?: Partial<MetadataTouchedFlags>;
  existingDraft?: Partial<PinMetadataDraft>;
};

export type BatchMetadataOptions = {
  overwriteEdited?: boolean;
  sharedDestinationUrl?: string;
  sharedPlannedDate?: string;
  autoAssignDates?: string[];
};

export function generateBatchMetadataDraft(
  pins: BatchMetadataPinInput[],
  options: BatchMetadataOptions = {},
): Record<string, PinMetadataDraft> {
  const result: Record<string, PinMetadataDraft> = {};

  pins.forEach((pin, i) => {
    const fresh = generatePinMetadataDraft({ ...pin, pinIndex: i });
    const touched = { ...EMPTY_TOUCHED, ...pin.touched };
    const existing = pin.existingDraft;
    const overwrite = options.overwriteEdited ?? false;

    const draft: PinMetadataDraft = { ...fresh };

    if (touched.titleTouched && !overwrite && existing?.selectedTitle) {
      draft.selectedTitle = existing.selectedTitle;
      if (existing.titleCandidates?.length) draft.titleCandidates = existing.titleCandidates;
      if (existing.titleCandidateEntries?.length) draft.titleCandidateEntries = existing.titleCandidateEntries;
    }

    if (touched.descriptionTouched && !overwrite && existing?.selectedDescription) {
      draft.selectedDescription = existing.selectedDescription;
      if (existing.descriptionCandidates?.length) draft.descriptionCandidates = existing.descriptionCandidates;
    }

    if (touched.altTextTouched && !overwrite && existing?.altText) {
      draft.altText = existing.altText;
    }

    if (options.sharedDestinationUrl && (overwrite || !touched.destinationUrlTouched)) {
      draft.destinationUrl = options.sharedDestinationUrl;
      draft.destinationUrlSource = "Applied in batch edit";
    } else if (touched.destinationUrlTouched && !overwrite && existing?.destinationUrl) {
      draft.destinationUrl = existing.destinationUrl;
      draft.destinationUrlSource = existing.destinationUrlSource;
    }

    if (options.sharedPlannedDate && (overwrite || !touched.plannedDateTouched)) {
      draft.plannedDate = options.sharedPlannedDate;
    } else if (options.autoAssignDates?.[i] && (overwrite || !touched.plannedDateTouched)) {
      draft.plannedDate = options.autoAssignDates[i];
    } else if (touched.plannedDateTouched && !overwrite && existing?.plannedDate) {
      draft.plannedDate = existing.plannedDate;
    }

    result[pin.pinId] = draft;
  });

  return result;
}

export function applyDraftToPinFields(draft: PinMetadataDraft): {
  title: string;
  description: string;
  altText: string;
  destinationUrl: string;
  plannedDate: string;
} {
  return {
    title: draft.selectedTitle,
    description: draft.selectedDescription,
    altText: draft.altText,
    destinationUrl: draft.destinationUrl ?? "",
    plannedDate: draft.plannedDate ?? "",
  };
}

export type MetadataReadinessLabel =
  | "Ready"
  | "Needs review"
  | "Missing title"
  | "Missing description"
  | "Missing date"
  | "Added to Plan";

export function metadataReadinessLabel(pin: {
  planningStatus: string;
  title: string;
  description: string;
  plannedDate: string;
}): MetadataReadinessLabel | null {
  if (pin.planningStatus !== "not_added") return "Added to Plan";
  if (!pin.title?.trim()) return "Missing title";
  if (!pin.description?.trim()) return "Missing description";
  if (!pin.plannedDate?.trim()) return "Missing date";
  if (pin.title?.trim() && pin.description?.trim() && pin.plannedDate?.trim()) return "Ready";
  return "Needs review";
}

export function computePlanningStatusFromFields(pin: {
  weeklyPlanItemId?: string | null;
  title: string;
  description: string;
  plannedDate: string;
  wasAdded: boolean;
}): "not_added" | "needs_review" | "ready" {
  if (!pin.wasAdded && !pin.weeklyPlanItemId) return "not_added";
  const hasTitle = !!pin.title?.trim();
  const hasDesc = !!pin.description?.trim();
  const hasDate = !!pin.plannedDate?.trim();
  if (hasTitle && hasDesc && hasDate) return "ready";
  return "needs_review";
}
