"use client";

/**
 * Contextual Generate AI Image drawer for Studio Board V2.
 *
 * This relocates the mature Studio generation setup into the Board flow:
 * product images, style references, automatic creative direction, advanced
 * creative controls, model/count/format settings, and the existing asset pickers.
 * Generated outputs are handled by StudioBoard as separate child Pin drafts.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ChevronDown, ChevronRight, ExternalLink, Loader2, Plus, Sparkles, X } from "lucide-react";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import type { MessageKey } from "@/lib/i18n/messages/en";
import * as assetStore from "@/lib/assetStore";
import { toProxyUrl } from "@/lib/imageProxy";
import * as pinDraftStore from "@/lib/pinDraftStore";
import type { PinDraft, SelectedCreativeDirection } from "@/lib/pinDraftStore";
import { track } from "@/lib/analytics";
import { buildHiddenPrompt } from "@/lib/studio/hiddenPromptBuilder";
import type { ReferenceRecommendation, InspirationPatternTags, RecommendationBasis } from "@/lib/studio/referenceScoring";
import { analyzeProductSet } from "@/lib/studio/productAnalysis";
import { analyzeReferences } from "@/lib/studio/referenceAnalysis";
import { inferCreativeIntent } from "@/lib/studio/creativeIntent";
import { getCategoryPlaybook } from "@/lib/studio/categoryPlaybooks";
import {
  buildSelectedCreativeAssets,
  getRecommendedCreativeDirections,
  inferCreativeCategory,
  type CreativeDirectionRecommendation,
  type SelectedCreativeAsset,
} from "@/lib/studio/creativeDirections";
import {
  buildCreativeTags,
  buildDirectionBrief,
  buildOutputVariants,
  defaultSelectedTagIds,
  toggleTagSelection,
  type CreativeTag,
  type SelectedCreativeTag,
} from "@/lib/studio/creativeControls";
import { MODEL_KEY_TO_LABEL } from "@/lib/studio/modelLabel";
import type { CreativeDirectionSnapshotV2 } from "@/lib/studioPersistence";
import { CreativeChips } from "@/components/studio/CreativeChips";
import { InlineCreateAssetPicker, type InlineAssetItem } from "@/components/studio/InlineCreateAssetPicker";
import { BUI, fieldStyle, labelStyle } from "@/components/studio/boardUI";
import { addProductToDraft } from "@/lib/pinMetadata";
import { selectionFromAsset, selectionFromLinkedProduct, toLinkedProduct, type CanonicalProductSelection } from "@/lib/studio/productSelection";
import { deriveDestinationUrlForProduct } from "@/lib/studio/destinationUrlDerivation";
import { buildReferenceRequestBody, isCurrentResult, resolveBasis } from "@/lib/studio/recommendationRequest";
import {
  MAX_SELECTED_REFERENCES,
  PINS_PER_REFERENCE_OPTIONS,
  isAtCapacity,
  isSelected as isReferenceSelected,
  mergePickerSelection,
  referenceImageUrls,
  referenceKey,
  removeReference,
  selectedPatternTags,
  toggleReference,
  totalPins as computeTotalPins,
  type SelectedReference,
} from "@/lib/studio/selectedReferences";

type PickerRole = "product" | "style_reference";
export type VariationMode = "distinct" | "similar";

// RecommendationBasis (top-level field of the /api/reference-candidates response)
// is now imported from the data session's canonical module — see the import above.
// product_analysis / product_text → "Recommended for this product";
// category_fallback or a missing field → "Category inspiration".

export type AiVersionOptions = {
  prompt: string;
  hiddenPrompt: string;
  productImages: string[];
  /** Flat URLs, kept for compatibility with existing callers. */
  referenceImages: string[];
  /**
   * The same references with provenance intact. Commit 2 plans one generation
   * group per entry and persists the association onto every resulting Pin.
   */
  selectedReferences: SelectedReference[];
  /** Per-group /api/generate count — the batch total is groups × count. */
  count: number;
  format: string;
  modelKey: string;
  variationMode: VariationMode;
  outputVariants: ReturnType<typeof buildOutputVariants>;
  category: string;
  selectedTags: SelectedCreativeTag[];
  primaryFormatTag?: string;
  directionBrief: string;
  briefManuallyEdited: boolean;
  creativeDirectionMeta: CreativeDirectionSnapshotV2;
  productMetadata: Array<{ title?: string; productUrl?: string }>;
  /**
   * Primary product prefilled from top-level "Select product", if any. Lets the
   * caller derive the resulting Pins' Website URL from a real product record rather
   * than re-deriving it from the flat metadata. Null for the normal in-drawer flow.
   */
  primaryProductSelection?: CanonicalProductSelection | null;
};

export type AiVersionDrawerSetup = {
  productImages: string[];
  referenceImages: string[];
  count: number;
  format: string;
  modelKey: string;
  variationMode: VariationMode;
  selectedDirectionId: string | null;
  selectedTagIds: string[];
  directionBrief: string;
  briefManuallyEdited: boolean;
};

export type AiVersionDrawerProps = {
  draft: PinDraft | null;
  open: boolean;
  generating: boolean;
  title?: string;
  initialSetup?: AiVersionDrawerSetup;
  /**
   * Product to prefill when opening in scratch mode from top-level "Select product".
   * Seeds the Product images strip and (via onGenerate) the resulting Pins' product
   * link + Website URL, and drives recommendations for THIS product — the drawer's
   * existing swapped-product path treats it as a non-draft product, so analysis and
   * recommendations are its own, never a previous product's.
   */
  initialProductSelection?: CanonicalProductSelection | null;
  onSetupChange?: (setup: AiVersionDrawerSetup) => void;
  onClose: () => void;
  onGenerate: (opts: AiVersionOptions) => void;
};

const FORMATS = ["Pinterest 2:3", "Pinterest 4:5", "Square 1:1", "Story 9:16"];
// Output count now comes from PINS_PER_REFERENCE_OPTIONS (1..3): the value is
// per-reference and the batch is capped at 3 references × 3 Pins = 9.
const MODEL_OPTIONS = [
  { value: "gemini_image", label: MODEL_KEY_TO_LABEL.gemini_image ?? "Gemini Image" },
  { value: "gpt_image", label: MODEL_KEY_TO_LABEL.gpt_image ?? "GPT Image" },
];

/**
 * Where a drawer-held product came from. This decides whether it may become a
 * persistable LinkedProduct on the generated Pins:
 *
 *   explicit_picker      — the user chose it (top-level Select product, or the
 *                          drawer's Add/Change product). Persistable.
 *   linked_product       — restored from a draft's existing linkedProducts.
 *                          Persistable (it already was a link).
 *   implicit_draft_image — just the pin's own photo, or a bare restored URL with no
 *                          matching link. A GENERATION INPUT ONLY: persisting it
 *                          would invent a product link the user never made.
 *
 * Internal only — never sent to any API.
 */
export type ProductSelectionOrigin = "explicit_picker" | "linked_product" | "implicit_draft_image";

export type DrawerProductSelection = CanonicalProductSelection & {
  selectionOrigin: ProductSelectionOrigin;
};

/** True when this selection may be persisted as a Pin's LinkedProduct. */
export function isPersistableProduct(sel: DrawerProductSelection | null | undefined): boolean {
  return !!sel && sel.selectionOrigin !== "implicit_draft_image";
}

/**
 * Reduce a URL-level edit (removing a thumbnail from the strip) back onto the
 * canonical selection list. Exported so the drawer and its tests call the SAME
 * implementation rather than a mirrored copy.
 */
export function applyProductUrlEdit(
  prev: DrawerProductSelection[],
  nextUrls: string[],
): DrawerProductSelection[] {
  const keep = new Set(nextUrls);
  const filtered = prev.filter(s => s.imageUrl && keep.has(s.imageUrl));
  // Re-assert primary on the surviving head so removing the primary promotes the next.
  return filtered.map((s, i) => ({ ...s, asPrimary: i === 0 }));
}

/**
 * Stable identity for the CURRENT product, used to discard stale async results.
 * Includes the fields that actually change the request, so a same-image product
 * whose title/type/tags differ is still treated as a different request context.
 */
export function productRequestKey(sel: DrawerProductSelection | CanonicalProductSelection | null): string {
  if (!sel) return "";
  const tags = (sel.tags ?? []).join(",");
  return [sel.id ?? "", sel.imageUrl ?? "", sel.title ?? "", sel.productType ?? "", tags].join("|");
}

/**
 * Seed the canonical current-product state when the drawer opens.
 *
 * Priority: a restored setup's product images (rehydrated as bare selections),
 * then a Select-product prefill, then the draft's own linked products, then the
 * draft's image as an implicit product. Later sources are only consulted when the
 * earlier one is empty, so a prefill is never diluted by the draft.
 */
export function buildInitialProductSelections(input: {
  initialSetup?: AiVersionDrawerSetup;
  initialProductSelection?: CanonicalProductSelection | null;
  draft: PinDraft | null;
}): DrawerProductSelection[] {
  const { initialSetup, initialProductSelection, draft } = input;
  const linked = draft?.linkedProducts ?? [];

  // 1. An explicit Select-product choice always wins — it is the freshest signal.
  if (initialProductSelection?.imageUrl) {
    return [{ ...initialProductSelection, asPrimary: true, selectionOrigin: "explicit_picker" }];
  }

  // 2. A restored setup kept only flat URLs. Rehydrate each against the draft's
  //    linked products BY imageUrl so title/productUrl/store/price survive a
  //    reopen; a URL with no matching linked product stays a bare image (it is a
  //    generation input, not a persistable product link).
  if (initialSetup) {
    return initialSetup.productImages.map((imageUrl, i) => {
      const match = linked.find(p => p.imageUrl === imageUrl);
      if (match) {
        return { ...selectionFromLinkedProduct(match), asPrimary: i === 0, selectionOrigin: "linked_product" as const };
      }
      return {
        title: "",
        imageUrl,
        source: "my_products" as const,
        asPrimary: i === 0,
        selectionOrigin: "implicit_draft_image" as const,
      };
    });
  }

  // 3. The draft's own linked products.
  if (linked.length) {
    return linked.map((p, i) => ({ ...selectionFromLinkedProduct(p), asPrimary: i === 0, selectionOrigin: "linked_product" as const }));
  }

  // 4. The draft's image is a GENERATION INPUT only. It is deliberately NOT a
  //    persistable product link — creating a LinkedProduct from "the pin's own
  //    photo" would invent a product the user never linked.
  if (draft?.imageUrl) {
    return [{
      title: draft.title ?? "",
      imageUrl: draft.imageUrl,
      source: "upload" as const,
      category: draft.category ?? undefined,
      asPrimary: true,
      selectionOrigin: "implicit_draft_image",
    }];
  }
  return [];
}

const COMPOSITION_LABEL_KEYS: Record<string, MessageKey> = {
  single_focal: "pinDrawer.styleCue.singleFocus",
  multi_product: "pinDrawer.styleCue.multipleProducts",
  scene: "pinDrawer.styleCue.styledScene",
};
const HUMAN_PRESENCE_LABEL_KEYS: Record<string, MessageKey> = {
  hands: "pinDrawer.styleCue.handsInFrame",
  partial: "pinDrawer.styleCue.personInFrame",
  full: "pinDrawer.styleCue.personInFrame",
};
const TEXT_OVERLAY_LABEL_KEYS: Record<string, MessageKey> = {
  light: "pinDrawer.styleCue.subtleText",
  moderate: "pinDrawer.styleCue.textOverlay",
  heavy: "pinDrawer.styleCue.boldTextOverlay",
};

/** Turn a reference's derived pattern tags into a few plain-language style cues shown to
 *  the user — so it reads as "we borrowed these style elements", never "we copied the image".
 *  Display-only; carries no image data. Needs `tr` since it's called outside React render. */
function describeStyleCues(tags: InspirationPatternTags, tr: (key: MessageKey) => string): string[] {
  const cues: string[] = [];
  const vf = (tags.visualFormat ?? "").trim();
  if (vf) cues.push(vf.replace(/_/g, " "));
  const ct = (tags.compositionType ?? "").trim().toLowerCase();
  if (COMPOSITION_LABEL_KEYS[ct]) cues.push(tr(COMPOSITION_LABEL_KEYS[ct]));
  const hp = (tags.humanPresence ?? "").trim().toLowerCase();
  if (HUMAN_PRESENCE_LABEL_KEYS[hp]) cues.push(tr(HUMAN_PRESENCE_LABEL_KEYS[hp]));
  const to = (tags.textOverlayLevel ?? "").trim().toLowerCase();
  if (TEXT_OVERLAY_LABEL_KEYS[to]) cues.push(tr(TEXT_OVERLAY_LABEL_KEYS[to]));
  const words = (tags.sceneStyleWords ?? []).map(w => w.trim()).filter(Boolean).slice(0, 3);
  if (words.length) cues.push(words.join(", "));
  return Array.from(new Set(cues));
}

/** Minimal, storable summary of a picked direction: id + title + a few concise
 *  scene/style terms drawn from its suggested controls (copy-context only). */
function summarizeDirection(d: CreativeDirectionRecommendation): SelectedCreativeDirection {
  const c = d.suggestedControls ?? {};
  const terms = Array.from(new Set(
    [c.subject, c.scene, c.style, c.framing, c.goal]
      .map(v => (typeof v === "string" ? v.trim() : ""))
      .filter(Boolean),
  )).slice(0, 5);
  return { id: d.id, title: d.title, terms: terms.length ? terms : undefined };
}

function imageTitle(url: string, assets: assetStore.AssetItem[], fallback: string): string {
  return assets.find(a => a.imageUrl === url)?.title || fallback;
}

function selectedTagPayload(tags: CreativeTag[], ids: string[]): SelectedCreativeTag[] {
  const selected = new Set(ids);
  return tags
    .filter(t => selected.has(t.id))
    .map(t => ({ id: t.id, label: t.label, group: t.group }));
}

function buildSnapshot(input: {
  selectedDirection: CreativeDirectionRecommendation | null;
  recommendations: CreativeDirectionRecommendation[];
  selectedAssets: SelectedCreativeAsset[];
  category: string;
  directionBrief: string;
  manualEdited: boolean;
  hiddenPrompt: string;
  selectedTags: SelectedCreativeTag[];
  primaryFormatTag?: string;
  productSet: ReturnType<typeof analyzeProductSet>;
  references: ReturnType<typeof analyzeReferences>;
  intent: ReturnType<typeof inferCreativeIntent>;
  count: number;
  variationMode: VariationMode;
  outputVariants: ReturnType<typeof buildOutputVariants>;
}): CreativeDirectionSnapshotV2 {
  return {
    version: 2,
    selectedDirectionId: input.selectedDirection?.id ?? null,
    selectedDirectionTitle: input.selectedDirection?.title ?? "",
    selectedDirectionSummary: input.selectedDirection?.summary ?? "",
    systemRecommendations: input.recommendations.map(r => ({
      id: r.id,
      title: r.title,
      summary: r.summary,
      category: r.category,
      source: r.source,
      kind: r.kind,
      shortDescription: r.shortDescription,
      whyThisDirection: r.whyThisDirection,
      confidence: r.confidence,
      influencedBy: r.influencedBy,
    })),
    guidedControls: {
      goal: "Saves",
      subject: input.intent.recommendedSubjectType,
      productEmphasis: "Balanced",
      referenceStrength: "Balanced",
      textOverlay: "None",
    },
    customInstructions: input.directionBrief,
    manualBrief: input.directionBrief,
    manualBriefEdited: input.manualEdited,
    inputVersion: input.selectedAssets.map(a => `${a.role}:${a.imageUrl}`).join("|"),
    briefStale: false,
    hiddenPrompt: input.hiddenPrompt,
    productAnalysis: input.productSet,
    referenceAnalysis: input.references.analyses,
    inferredIntent: input.intent,
    creativeControls: {
      selectedTags: input.selectedTags,
      primaryFormatTag: input.primaryFormatTag,
      directionBrief: input.directionBrief,
      outputCount: input.count,
      variationMode: input.variationMode,
      outputVariants: input.outputVariants,
    },
    opportunityContext: { enabled: false, removable: true },
    selectedAssets: input.selectedAssets,
    categoryPlaybookId: input.category,
    fallbackUsed: input.category === "generic" ? "generic" : "category_playbook",
  };
}

function AssetStrip({
  label,
  testIdBase,
  helper,
  urls,
  assets,
  emptyText,
  addTestId,
  onAdd,
  onRemove,
}: {
  label: string;
  testIdBase: string;
  helper: string;
  urls: string[];
  assets: assetStore.AssetItem[];
  emptyText: string;
  addTestId: string;
  onAdd: () => void;
  onRemove: (url: string) => void;
}) {
  const { t: tr } = useLocale();
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div>
        <h3 style={{ margin: 0, fontSize: 13, fontWeight: 850, color: BUI.text }}>{label}</h3>
        <p style={{ margin: "2px 0 0", fontSize: 11.5, lineHeight: 1.45, color: BUI.textSec }}>{helper}</p>
      </div>
      <div data-testid={`${testIdBase}-selected`} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        {urls.map(url => (
          <div key={url} style={{ position: "relative", width: 58, height: 74, borderRadius: 10, overflow: "hidden", border: `1px solid ${BUI.border}`, background: BUI.surface3 }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={toProxyUrl(url)} alt={imageTitle(url, assets, tr("pinDrawer.asset.selectedImage"))} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
            <button type="button" aria-label={tr("pinDrawer.asset.removeImage")} onClick={() => onRemove(url)}
              style={{ position: "absolute", top: 4, right: 4, width: 18, height: 18, borderRadius: 999, border: "none", background: "rgba(15,23,42,0.76)", color: "#fff", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <X style={{ width: 11, height: 11 }} />
            </button>
          </div>
        ))}
        <button type="button" data-testid={addTestId} onClick={onAdd}
          style={{ width: 58, height: 74, borderRadius: 10, border: `1px dashed ${BUI.borderHi}`, background: BUI.surface2, color: BUI.purple, cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 4, fontSize: 10.5, fontWeight: 800, fontFamily: "inherit" }}>
          <Plus style={{ width: 15, height: 15 }} /> {tr("pinDrawer.setup.add")}
        </button>
        {!urls.length && <span style={{ fontSize: 11.5, color: BUI.textMuted }}>{emptyText}</span>}
      </div>
    </section>
  );
}

export function AiVersionDrawer({ draft, open, generating, title, initialSetup, initialProductSelection, onSetupChange, onClose, onGenerate }: AiVersionDrawerProps) {
  const { t: tr } = useLocale();
  const resolvedTitle = title ?? tr("pinDrawer.dialogTitle");
  const storedAssets = useSyncExternalStore(assetStore.subscribe, assetStore.getAssets, assetStore.getServerAssets);
  // Canonical current-product state — the source of truth for BOTH the Product
  // images strip and the recommendation/analysis/generation product context. It is
  // initialised from (in priority) a prefilled Select-product selection, then the
  // draft's linked products, then the draft's own image; and it is what the user
  // mutates when they pick, change or clear a product inside the drawer. productUrls
  // is derived from it so the two can never drift (the bug the review caught).
  const [selectedProductSelections, setSelectedProductSelections] = useState<DrawerProductSelection[]>(() =>
    buildInitialProductSelections({ initialSetup, initialProductSelection, draft }),
  );
  // Derived, not stored — keeps the strip and the canonical state atomically in sync.
  const productUrls = selectedProductSelections.map(s => s.imageUrl).filter((u): u is string => !!u);
  const setProductUrls = (next: string[] | ((prev: string[]) => string[])) => {
    // Delegates to the exported reducer so the drawer and its tests share one path.
    setSelectedProductSelections(prev => {
      const prevUrls = prev.map(s => s.imageUrl).filter((u): u is string => !!u);
      const resolved = typeof next === "function" ? next(prevUrls) : next;
      return applyProductUrlEdit(prev, resolved);
    });
  };
  // ONE selection state for every reference entry point — recommended Pins, picker
  // uploads and saved refs all live here (see lib/studio/selectedReferences.ts).
  // Rehydrated from the flat URL list when restoring a prior setup; provenance for
  // recommended Pins is re-attached once recommendations load (effect below).
  const [selectedReferences, setSelectedReferences] = useState<SelectedReference[]>(
    () => (initialSetup?.referenceImages ?? []).map(url => ({
      id: url, imageUrl: url, source: "saved" as const, role: "style_reference" as const,
    })),
  );
  const referenceUrls = referenceImageUrls(selectedReferences);
  const [pickerRole, setPickerRole] = useState<PickerRole | null>(null);
  const [count, setCount] = useState(() => initialSetup?.count ?? 2);
  const [format, setFormat] = useState(() => initialSetup?.format ?? FORMATS[0]);
  const [modelKey, setModelKey] = useState(() => initialSetup?.modelKey ?? "gemini_image");
  const [variationMode, setVariationMode] = useState<VariationMode>(() => initialSetup?.variationMode ?? "distinct");
  const [selectedDirectionId, setSelectedDirectionId] = useState<string | null>(() => initialSetup?.selectedDirectionId ?? null);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>(() => initialSetup?.selectedTagIds ?? []);
  const [directionBrief, setDirectionBrief] = useState(() => initialSetup?.directionBrief ?? "");
  const [briefManuallyEdited, setBriefManuallyEdited] = useState(() => initialSetup?.briefManuallyEdited ?? false);
  // ── Phase B: product-aware recommended references (inspiration only) ──────────
  const [recommendedRefs, setRecommendedRefs] = useState<ReferenceRecommendation[]>([]);
  const [recommendationBasis, setRecommendationBasis] = useState<RecommendationBasis>("category_fallback");
  // "loading" while a request is in flight, "error" when it failed after retries.
  // A failure must NOT fall back to showing the previous product's results (contract
  // §4.9), so the grid shows a retry affordance instead. Defaults to "loading"
  // because an eligible drawer always fetches on open; the fetch effect resolves it
  // to idle/error. (Set in render on product change, not in an effect body.)
  const [recStatus, setRecStatus] = useState<"idle" | "loading" | "error">("loading");
  const [recReloadKey, setRecReloadKey] = useState(0);
  const [recExpanded, setRecExpanded] = useState(true);
  // Derived, never stored separately — this is what keeps the recommendation grid
  // and the top tray from disagreeing about what is selected.
  const selectedRefIds = selectedReferences.filter(r => r.source === "recommended_pin").map(r => r.id);

  // Live view of the source draft: the `draft` prop is a click-time snapshot, but
  // analysis fields fill in asynchronously (and may land after the drawer opened) —
  // recommendations must react to the CURRENT store state, not the snapshot.
  const liveDraft = useSyncExternalStore(
    pinDraftStore.subscribe,
    () => (draft?.id ? pinDraftStore.getDraft(draft.id) ?? draft : draft),
    () => draft,
  );
  const analysisReady = liveDraft?.imageAnalysisStatus === "ready";
  const hasLinkedProducts = (liveDraft?.linkedProducts?.length ?? 0) > 0;

  // Reset per-draft state during render when the drawer switches to another draft
  // (react.dev "adjusting state when props change" — avoids setState inside effects).
  // Shown after a product SWAP (not on first load) so the user understands why the
  // recommendation grid changed under them. Their already-selected references are
  // deliberately kept — only the suggestions refresh. Declared before both reset
  // blocks below, which set it during render.
  const [productChanged, setProductChanged] = useState(false);
  /**
   * Image analysis for a product that is NOT the draft's own image.
   *
   * The draft's stored analysis describes the draft's image, so once the user swaps
   * the Product strip to a different product it no longer applies (and must not be
   * reused — it would recommend for the wrong product). startImageAnalysis() cannot
   * be used here because it is draft-scoped and would overwrite the draft's analysis
   * with a different product's. POST /api/ai-copy/analyze is stateless, so we call it
   * directly and keep the result in memory, keyed by image URL.
   */
  const [swappedProductAnalysis, setSwappedProductAnalysis] = useState<{
    url: string;
    analysis?: { category?: string; style?: string; colors?: string[]; visibleObjects?: string[]; imageSummary?: string };
  } | null>(null);
  const [recDraftId, setRecDraftId] = useState<string | undefined>(draft?.id);
  if (draft?.id !== recDraftId) {
    setRecDraftId(draft?.id);
    // Drop recommended Pins from the previous draft; keep the user's own uploads/saved
    // refs, which are not draft-specific.
    setSelectedReferences(prev => prev.filter(r => r.source !== "recommended_pin"));
    setRecommendedRefs([]);
    setProductChanged(false);
  }

  // Fetch recommendations for ANY draft that has an image — richer context (analysis,
  // linked product) only improves ranking, and the API degrades gracefully on sparse
  // input. Refetches once analysis becomes ready so recs upgrade in place.
  // Empty results never render an empty shell. All failures are silent (best-effort).
  //
  // Recommendations follow the product ACTUALLY selected for generation: when the user
  // swaps the Product images strip away from the pin's own image, the pin's analysis no
  // longer describes the selected product — in that case we drop the stale analysis
  // (honesty) and match on the selected asset's title instead, refetching on change.
  // If nothing can be inferred from it, showing no recommendations beats wrong ones.
  // The primary product drives analysis + recommendations. It comes from the
  // canonical selection state, NOT from a draft — so a scratch drawer opened via
  // Select product (draft === null) still has a primary and still requests
  // recommendations. The draft is optional context only.
  const primarySelection = selectedProductSelections[0] ?? null;
  const primaryProductUrl = primarySelection?.imageUrl ?? productUrls[0] ?? "";
  // Identity of the product each async request was issued for. A ref (not state) so
  // an in-flight callback reads the CURRENT value at resolution time — this is what
  // discards A's response after the user switched to B, even when A resolved before
  // React ran the effect cleanup that aborts it.
  //
  // The ref is synced in a layout effect (never during render — that would be a
  // render-phase ref write). It still updates BEFORE any fetch callback can run,
  // because a resolved promise is a macrotask/microtask after commit, and both
  // request effects re-run on the same commit that changes the key.
  const currentProductKey = productRequestKey(primarySelection);
  const currentProductKeyRef = useRef(currentProductKey);
  useLayoutEffect(() => { currentProductKeyRef.current = currentProductKey; }, [currentProductKey]);
  // Whether the primary product IS the draft's own image (its stored analysis then
  // applies). False for a swapped-in or top-level-selected product.
  const draftImageSelected =
    !!liveDraft?.imageUrl && !!primaryProductUrl && primaryProductUrl === liveDraft.imageUrl;
  const recsEligible = Boolean(primaryProductUrl || liveDraft?.imageUrl);

  // Product selection changed → the old recommendations describe a different product.
  // Clear immediately during render (same pattern as the draft-switch reset above) so
  // stale recs never linger while the refetch is in flight. An analysis-ready upgrade
  // keeps the same key and swaps in place without flashing.
  const productKey = `${draftImageSelected}|${primaryProductUrl}`;
  const [prevProductKey, setPrevProductKey] = useState(productKey);
  if (productKey !== prevProductKey) {
    setPrevProductKey(productKey);
    // Clear the OLD product's results AND basis before the new request lands, so the
    // previous product's recommendations never linger under a new product (§4.1/§4.2).
    setRecommendedRefs([]);
    setRecommendationBasis("category_fallback");
    setRecStatus("loading");
    setProductChanged(true);
  }
  // Analyse a swapped-in product so its recommendations are product-level rather than
  // title/category-only. Best-effort: on failure the request below simply omits
  // imageAnalysis and the API falls back to category_fallback, which the heading
  // then reports honestly as "Category inspiration".
  useEffect(() => {
    // Analyse ANY product that is not the draft's own image — including a scratch /
    // top-level Select-product product (draft === null). draftId is omitted: this is
    // a stateless analysis and must not be written onto any draft.
    if (!open || draftImageSelected || !primaryProductUrl) return;
    if (swappedProductAnalysis?.url === primaryProductUrl) return;
    // Bind this request to the product it was issued for; a late response for a
    // previous product must not overwrite the current one (§4).
    const requestUrl = primaryProductUrl;
    // Safe to read here: the layout effect above syncs the ref before any passive
    // effect runs, so this is THIS render's key, not the previous one's.
    const requestKey = currentProductKeyRef.current;
    const controller = new AbortController();
    // Belt and braces: abort covers the common case, the key check covers a response
    // that lands BEFORE cleanup runs (abort alone would miss it).
    const isStale = () => controller.signal.aborted || !isCurrentResult(requestKey, currentProductKeyRef.current);
    const sel = primarySelection;
    // Prefer the selection's own honest fields; the asset store is a fallback only.
    const asset = assetStore.getAssets().find(a => a.imageUrl === requestUrl);
    const tags = (sel?.tags && sel.tags.length ? sel.tags
      : [sel?.category ?? asset?.category, sel?.keyword ?? asset?.keyword, sel?.visualFormat ?? asset?.visualFormat]
          .map(v => (typeof v === "string" ? v.trim() : "")).filter(Boolean));
    fetch("/api/ai-copy/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        imageUrl: requestUrl,
        category: sel?.category || asset?.category || undefined,
        productTitle: sel?.title || asset?.title || undefined,
        productType: sel?.productType || asset?.productType || undefined,
        productTags: tags.length ? tags : undefined,
      }),
    })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data: { analysis?: { category?: string; style?: string; colors?: string[]; visibleObjects?: string[]; imageSummary?: string } }) => {
        if (isStale()) return; // product changed while this was in flight
        setSwappedProductAnalysis({ url: requestUrl, analysis: data.analysis });
      })
      .catch((e: unknown) => {
        if (e instanceof DOMException && e.name === "AbortError") return;
        if (isStale()) return;
        // Record the attempt (keyed by url) so we don't retry in a loop.
        setSwappedProductAnalysis({ url: requestUrl });
      });
    // Abort a still-inflight analysis when the product changes — its result is stale.
    return () => { controller.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, draftImageSelected, primaryProductUrl, swappedProductAnalysis?.url]);

  useEffect(() => {
    // No draft requirement: recommendations follow the PRIMARY PRODUCT, which exists
    // for a scratch/Select-product drawer too. The draft is optional context.
    if (!open || !recsEligible || !primaryProductUrl) return;
    // Bind this request to the current product. A late response for a previous
    // product is discarded rather than overwriting the current product's results
    // (§4: no stale writes to recommendedRefs / basis / status).
    const requestUrl = primaryProductUrl;
    const requestKey = currentProductKeyRef.current;
    const controller = new AbortController();
    // Abort handles cleanup-ordered cases; the key check additionally rejects a
    // response that resolved BEFORE the effect cleanup aborted it (§1.5/§1.6).
    const isStale = () => controller.signal.aborted || !isCurrentResult(requestKey, currentProductKeyRef.current);
    const d = liveDraft;
    const sel = primarySelection;
    // The draft's own analysis applies ONLY when the primary product IS the draft's
    // image. Otherwise use the swapped-in product's own analysis, keyed by url.
    const swappedProduct = !draftImageSelected && swappedProductAnalysis?.url === requestUrl
      ? swappedProductAnalysis.analysis
      : undefined;
    // Enrich the primary selection with any asset-store fields it lacks (a saved
    // product whose selection was built minimally), without ever fabricating.
    const selectedAsset = draftImageSelected ? undefined : storedAssets.find(a => a.imageUrl === requestUrl);
    const enrichedPrimary: CanonicalProductSelection | null = sel
      ? {
          ...sel,
          title: sel.title?.trim() || selectedAsset?.title?.trim() || "",
          category: sel.category ?? selectedAsset?.category,
          productType: sel.productType ?? selectedAsset?.productType,
          keyword: sel.keyword ?? selectedAsset?.keyword,
          visualFormat: sel.visualFormat ?? selectedAsset?.visualFormat,
        }
      : null;
    const body = buildReferenceRequestBody({
      primary: enrichedPrimary,
      draftImageSelected,
      draftAnalysis: d ? {
        title: d.title,
        category: d.imageCategory || d.category || undefined,
        style: d.style, colors: d.colors, visibleObjects: d.visibleObjects, imageSummary: d.imageSummary,
      } : undefined,
      productAnalysis: swappedProduct,
    });
    // Transient failures (dev recompile 500s, flaky network) must not permanently blank
    // the section for this drawer session — retry a couple of times before giving up.
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const attempt = (retriesLeft: number) => {
      fetch("/api/reference-candidates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify(body),
      })
        .then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((data: { items?: ReferenceRecommendation[]; recommendationBasis?: RecommendationBasis }) => {
          // Guard: the product changed while this was in flight → discard (§4).
          if (isStale()) return;
          setRecommendedRefs(Array.isArray(data.items) ? data.items : []);
          // Field is always present per the final contract; the fallbacks below keep
          // the UI honest against an empty items list, a request failure, or an older
          // API response that predates the field — all three read as Category
          // inspiration, never as a fabricated product-level claim.
          setRecommendationBasis(resolveBasis(data.recommendationBasis));
          setRecStatus("idle");
        })
        .catch((e: unknown) => {
          if (e instanceof DOMException && e.name === "AbortError") return;
          if (isStale()) return;
          if (retriesLeft > 0) { retryTimer = setTimeout(() => attempt(retriesLeft - 1), 1500); return; }
          // Exhausted retries: surface an error+retry state rather than showing an
          // empty grid that looks like a legitimate "no recommendations" (§4.9).
          setRecommendedRefs([]);
          setRecStatus("error");
        });
    };
    attempt(2);
    // Aborting on product change guarantees the previous product's late response
    // cannot write recommendedRefs / basis / status for the new product.
    return () => { controller.abort(); if (retryTimer) clearTimeout(retryTimer); };
    // swappedProductAnalysis is a dep so recommendations upgrade in place once the
    // new product's analysis lands (product_analysis instead of category_fallback).
    // recReloadKey lets the Retry button re-run this effect on demand.
  }, [open, draft?.id, recsEligible, analysisReady, hasLinkedProducts, draftImageSelected, primaryProductUrl, swappedProductAnalysis, recReloadKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const REC_LIMIT = MAX_SELECTED_REFERENCES;
  /**
   * Toggle a recommended Pin as a real Style Reference.
   *
   * Until 2026-07-21 this only recorded an id and fed derived patternTags to the
   * prompt — Pinterest创意智能层 PRD §4 forbade pin_samples images as generation
   * conditioning. The product owner lifted that rule (§4.1); the Pin's imageUrl now
   * enters the batch as role=style_reference alongside role=product images, while
   * patternTags remain an auxiliary signal (§4.1.8) and the Pinterest linkback stays
   * on the card (§4.1.11).
   */
  const handleToggleRecommended = (ref: ReferenceRecommendation) => {
    const entry: SelectedReference = {
      id: ref.id,
      imageUrl: ref.imageUrl,
      source: "recommended_pin",
      sourceUrl: ref.sourceUrl ?? ref.pinterestUrl ?? undefined,
      title: ref.title,
      reason: ref.reason,
      patternTags: ref.patternTags,
      role: "style_reference",
    };
    const wasSelected = isReferenceSelected(selectedReferences, entry);
    // Capacity is shared across ALL reference sources, so a user with 3 uploads
    // cannot add a 4th via the recommendation grid.
    if (!wasSelected && isAtCapacity(selectedReferences)) return;
    const next = toggleReference(selectedReferences, entry);
    setSelectedReferences(next);
    track(wasSelected ? "reference_rejected" : "reference_selected", {
      draftId: draft?.id ?? null,
      referenceId: ref.id,
    });
    if (draft?.id) {
      const prev = pinDraftStore.getDraft(draft.id)?.creativeSelections ?? {};
      const rejected = new Set(prev.rejectedReferenceIds ?? []);
      if (wasSelected) rejected.add(ref.id); else rejected.delete(ref.id);
      pinDraftStore.updateDraft(draft.id, {
        creativeSelections: {
          ...prev,
          selectedReferenceIds: next.filter(r => r.source === "recommended_pin").map(r => r.id),
          rejectedReferenceIds: [...rejected],
        },
      });
    }
  };

  // Derived pattern tags of the SELECTED references — auxiliary prompt signal that
  // now accompanies, rather than replaces, the reference images themselves.
  const inspirationPatterns = useMemo(
    () => selectedPatternTags<InspirationPatternTags>(selectedReferences),
    [selectedReferences],
  );

  useEffect(() => {
    if (!open || !draft?.imageUrl) return;
    assetStore.saveAsset({
      role: "product",
      source: "upload",
      imageUrl: draft.imageUrl,
      title: draft.title || tr("pinDrawer.asset.currentPinImage"),
      category: draft.category || undefined,
      keyword: draft.keyword || undefined,
      sourceContext: "uploaded",
    });
  }, [open, draft?.imageUrl, draft?.title, draft?.category, draft?.keyword]);

  const selectedAssets = useMemo(() => buildSelectedCreativeAssets({
    productUrls,
    referenceUrls,
    storedAssets,
  }), [productUrls, referenceUrls, storedAssets]);

  const category = useMemo(() => inferCreativeCategory({
    explicitCategory: draft?.category,
    assets: selectedAssets,
  }), [draft?.category, selectedAssets]);

  const recommendations = useMemo(() => getRecommendedCreativeDirections({
    category,
    assets: selectedAssets,
  }), [category, selectedAssets]);

  const selectedDirection = useMemo(() => (
    recommendations.find(r => r.id === selectedDirectionId) ?? recommendations[0] ?? null
  ), [recommendations, selectedDirectionId]);

  // A1.4: record the picked creative direction on the source draft (minimal summary)
  // and emit direction_selected. This ONLY persists the choice + analytics — it never
  // changes generation/prompt behavior (that still flows through onGenerate as before).
  const handleSelectDirection = (direction: CreativeDirectionRecommendation) => {
    setSelectedDirectionId(direction.id);
    setBriefManuallyEdited(false);
    const summary = summarizeDirection(direction);
    if (draft?.id) {
      const prev = pinDraftStore.getDraft(draft.id)?.creativeSelections ?? {};
      pinDraftStore.updateDraft(draft.id, { creativeSelections: { ...prev, selectedDirection: summary } });
    }
    track("direction_selected", {
      draftId: draft?.id ?? null,
      directionId: direction.id,
      directionKind: direction.kind ?? null,
    });
  };

  const productSet = useMemo(() => analyzeProductSet(selectedAssets), [selectedAssets]);
  const referenceContext = useMemo(() => analyzeReferences(selectedAssets, {
    productCategory: category,
    isCompleteOutfit: productSet.category === "fashion" && productSet.isCoherentSet,
  }), [selectedAssets, category, productSet.category, productSet.isCoherentSet]);

  const intent = useMemo(() => inferCreativeIntent({
    category,
    references: referenceContext,
    hasProducts: productUrls.length > 0,
    hasOpportunity: false,
    productSetSummary: productSet.setSummary,
    primaryProductTitle: productSet.products[0]?.title,
  }), [category, referenceContext, productUrls.length, productSet.setSummary, productSet.products]);

  const creativeTags = useMemo(() => buildCreativeTags({
    category,
    productTitles: productSet.products.map(p => p.title),
    referenceType: referenceContext.dominant?.referenceType ?? null,
    referenceSceneType: referenceContext.dominant?.sceneType,
    hasReference: referenceContext.hasReferences,
    format,
  }), [category, productSet.products, referenceContext.dominant?.referenceType, referenceContext.dominant?.sceneType, referenceContext.hasReferences, format]);

  const effectiveSelectedTagIds = useMemo(() => {
    if (!selectedTagIds.length) return defaultSelectedTagIds(creativeTags);
    const valid = selectedTagIds.filter(id => creativeTags.some(t => t.id === id));
    return valid.length ? valid : defaultSelectedTagIds(creativeTags);
  }, [creativeTags, selectedTagIds]);

  const selectedTags = useMemo(() => selectedTagPayload(creativeTags, effectiveSelectedTagIds), [creativeTags, effectiveSelectedTagIds]);
  const primaryFormatTag = selectedTags.find(t => t.group === "format")?.label;

  const derivedBrief = useMemo(() => buildDirectionBrief({
    category,
    productTitles: productSet.products.map(p => p.title),
    referenceType: referenceContext.dominant?.referenceType ?? null,
    referenceSceneType: referenceContext.dominant?.sceneType,
    hasReference: referenceContext.hasReferences,
    format,
  }, selectedTags), [category, productSet.products, referenceContext.dominant?.referenceType, referenceContext.dominant?.sceneType, referenceContext.hasReferences, format, selectedTags]);

  const effectiveDirectionBrief = briefManuallyEdited ? directionBrief : derivedBrief;

  const hiddenPrompt = useMemo(() => buildHiddenPrompt({
    direction: selectedDirection,
    productSet,
    references: referenceContext,
    intent,
    playbook: getCategoryPlaybook(category),
    controls: {
      goal: "Saves",
      subject: intent.recommendedSubjectType,
      productEmphasis: "Balanced",
      referenceStrength: "Balanced",
      textOverlay: "None",
    },
    refinement: effectiveDirectionBrief,
    directionBrief: effectiveDirectionBrief,
    selectedTags,
    primaryFormatTag,
    format,
    inspirationPatterns,
  }), [selectedDirection, productSet, referenceContext, intent, category, effectiveDirectionBrief, selectedTags, primaryFormatTag, format, inspirationPatterns]);

  const outputVariants = useMemo(() => buildOutputVariants(count, variationMode, category), [count, variationMode, category]);

  // Section G: the CTA shows the BATCH total; each group still requests `count`.
  const batchTotal = computeTotalPins(selectedReferences.length, count);
  // The drawer closes as soon as placeholders exist, so serial group progress is
  // reported by StudioBoard's batch toast rather than here.
  const generatingLabel = tr("pinDrawer.footer.generatingEllipsis");

  if (!open) return null;

  const currentSetup: AiVersionDrawerSetup = {
    productImages: productUrls,
    referenceImages: referenceUrls,
    count,
    format,
    modelKey,
    variationMode,
    selectedDirectionId,
    selectedTagIds: effectiveSelectedTagIds,
    directionBrief,
    briefManuallyEdited,
  };

  const saveSetup = () => onSetupChange?.(currentSetup);

  const closeDrawer = () => {
    saveSetup();
    onClose();
  };

  const ensureCurrentPinProductAsset = () => {
    if (!draft?.imageUrl) return;
    assetStore.saveAsset({
      role: "product",
      source: "upload",
      imageUrl: draft.imageUrl,
      title: draft.title || tr("pinDrawer.asset.currentPinImage"),
      category: draft.category || undefined,
      keyword: draft.keyword || undefined,
      sourceContext: "uploaded",
    });
  };

  const openProductPicker = () => {
    ensureCurrentPinProductAsset();
    saveSetup();
    setPickerRole("product");
  };

  const openReferencePicker = () => {
    saveSetup();
    setPickerRole("style_reference");
  };

  const confirmPicker = (items: InlineAssetItem[]) => {
    if (pickerRole === "product") {
      // Replace the canonical selection with the picked products (full fields kept),
      // so analysis / recommendations / generation all follow the NEW product. The
      // strip derives from this — no separate product-url store to fall out of sync.
      const picked: DrawerProductSelection[] = items
        .filter(item => item.imageUrl)
        .map((item, i) => ({
          ...selectionFromAsset(item),
          asPrimary: i === 0,
          // A picker choice is explicit → persistable as a LinkedProduct.
          selectionOrigin: "explicit_picker" as const,
        }));
      setSelectedProductSelections(picked);
      // Persist the full product record onto the draft so the Website URL can be
      // derived from it (Section J). Uses the SAME addProductToDraft path as
      // Link/Change product — no parallel product state.
      if (draft?.id && items.length) {
        const current = pinDraftStore.getDraft(draft.id);
        // Only extend an EXISTING metadataDraft — the same guard PinDetailsDrawer
        // uses. There is no empty-draft factory, and synthesising one here would
        // create a half-populated metadata record for a Pin that has not been
        // through copy generation yet.
        const existingMeta = current?.metadataDraft;
        if (existingMeta) {
          let meta = existingMeta;
          const selections = items.map(item => selectionFromAsset(item));
          selections.forEach((selection, i) => {
            // First pick becomes primary only when the draft has none yet
            // (addProductToDraft's `undefined` behaviour); later picks are tagged.
            meta = addProductToDraft(meta, toLinkedProduct(selection), i === 0 ? undefined : false);
          });
          // Derive the Website URL from the PRIMARY selection. Returns null (and we
          // write nothing) when the field is manually edited or already correct.
          const urlChange = deriveDestinationUrlForProduct(
            {
              destinationUrl: meta.destinationUrl,
              destinationUrlSource: meta.destinationUrlSource,
              destinationUrlTouched: current?.metadataTouched?.destinationUrlTouched,
            },
            selections[0],
          );
          if (urlChange) {
            meta = { ...meta, destinationUrl: urlChange.destinationUrl, destinationUrlSource: urlChange.destinationUrlSource };
          }
          pinDraftStore.updateDraft(draft.id, { metadataDraft: meta });
        }
      }
    }
    if (pickerRole === "style_reference") {
      // The picker only knows about stored assets — merge so recommended Pins the
      // user selected in the drawer are not silently dropped by a picker confirm.
      const picked: SelectedReference[] = items.filter(i => i.imageUrl).map(item => ({
        id: item.id || item.imageUrl,
        imageUrl: item.imageUrl,
        source: item.source === "upload" ? "upload" : item.source === "url" ? "url" : "saved",
        sourceUrl: item.sourceUrl,
        title: item.title,
        role: "style_reference",
      }));
      setSelectedReferences(prev => mergePickerSelection(prev, picked, ["upload", "saved", "url"]));
    }
    setPickerRole(null);
  };

  const doGenerate = () => {
    const snapshot = buildSnapshot({
      selectedDirection,
      recommendations,
      selectedAssets,
      category,
      directionBrief: effectiveDirectionBrief,
      manualEdited: briefManuallyEdited,
      hiddenPrompt,
      selectedTags,
      primaryFormatTag,
      productSet,
      references: referenceContext,
      intent,
      count,
      variationMode,
      outputVariants,
    });
    onGenerate({
      prompt: effectiveDirectionBrief.trim() || derivedBrief,
      hiddenPrompt,
      productImages: productUrls,
      referenceImages: referenceUrls,
      selectedReferences,
      count,
      format,
      modelKey,
      variationMode,
      outputVariants,
      category,
      selectedTags,
      primaryFormatTag,
      directionBrief: effectiveDirectionBrief.trim() || derivedBrief,
      briefManuallyEdited,
      creativeDirectionMeta: snapshot,
      productMetadata: selectedAssets
        .filter(a => a.role === "product")
        .map(a => ({ title: a.title, productUrl: a.productUrl })),
      // The CURRENT primary selection — reflects any in-drawer product change,
      // never the immutable prefill. Only an EXPLICIT choice or a restored linked
      // product may become a Pin's LinkedProduct; a bare draft image is a generation
      // input and must not fabricate a product link (§3.4).
      primaryProductSelection: isPersistableProduct(primarySelection) ? primarySelection : null,
    });
  };

  if (pickerRole) {
    return (
      <>
        <div data-testid="ai-version-backdrop" onClick={() => setPickerRole(null)}
          style={{ position: "fixed", inset: 0, zIndex: 90, background: "rgba(15,23,42,0.52)" }} />
        <div data-testid="ai-version-picker-host" role="dialog" aria-label={pickerRole === "product" ? tr("pinDrawer.asset.chooseProductImages") : tr("pinDrawer.asset.choosePinReferences")}
          style={{ position: "fixed", top: 0, right: 0, bottom: 0, zIndex: 92, width: 760, maxWidth: "96vw", background: BUI.surface, borderLeft: `1px solid ${BUI.border}`, boxShadow: "-18px 0 54px rgba(15,23,42,0.24)", display: "flex", flexDirection: "column" }}>
          <InlineCreateAssetPicker
            role={pickerRole}
            currentSelectedUrls={pickerRole === "product" ? productUrls : referenceUrls}
            onClose={() => setPickerRole(null)}
            onConfirm={confirmPicker}
          />
        </div>
      </>
    );
  }

  return (
    <>
      <div data-testid="ai-version-backdrop" onClick={generating ? undefined : closeDrawer}
        style={{ position: "fixed", inset: 0, zIndex: 90, background: "rgba(15,23,42,0.45)" }} />
      <div data-testid="ai-version-drawer" role="dialog" aria-label={resolvedTitle}
        style={{ position: "fixed", top: 0, right: 0, bottom: 0, zIndex: 91, width: 500, maxWidth: "96vw", background: BUI.surface, borderLeft: `1px solid ${BUI.border}`, boxShadow: "-16px 0 48px rgba(15,23,42,0.18)", display: "flex", flexDirection: "column" }}>
        <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 18px", borderBottom: `1px solid ${BUI.border}`, flexShrink: 0 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 15, fontWeight: 850, color: BUI.text }}>{resolvedTitle}</h2>
            <p style={{ margin: "2px 0 0", fontSize: 11.5, color: BUI.textSec }}>{tr("pinDrawer.subtitle")}</p>
          </div>
          <button type="button" data-testid="ai-version-close" aria-label={tr("pinDetails.close")} onClick={closeDrawer} disabled={generating}
            style={{ background: "none", border: "none", cursor: generating ? "default" : "pointer", color: BUI.textSec, padding: 2, display: "flex" }}>
            <X style={{ width: 18, height: 18 }} />
          </button>
        </header>

        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column" }}>
          <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 17 }}>
            <AssetStrip
              label={tr("pinDrawer.asset.productImages")}
              testIdBase="product-images"
              helper={tr("pinDrawer.asset.productImagesHelper")}
              urls={productUrls}
              assets={storedAssets}
              emptyText={tr("pinDrawer.asset.noProductImageSelected")}
              addTestId="ai-version-add-product"
              onAdd={openProductPicker}
              onRemove={url => setProductUrls(prev => prev.filter(x => x !== url))}
            />
            <AssetStrip
              label={tr("pinDrawer.asset.styleReferences")}
              testIdBase="style-references"
              helper={tr("pinDrawer.asset.styleReferencesHelper")}
              urls={referenceUrls}
              assets={storedAssets}
              emptyText={tr("pinDrawer.asset.noReferenceSelected")}
              addTestId="ai-version-add-reference"
              onAdd={openReferencePicker}
              // Removing a thumbnail here also clears the matching recommendation
              // card, because both read the same collection.
              onRemove={url => setSelectedReferences(prev => {
                const match = prev.find(r => r.imageUrl === url);
                return match ? removeReference(prev, referenceKey(match)) : prev;
              })}
            />

            {recsEligible && recStatus === "loading" && recommendedRefs.length === 0 && (
              <section data-testid="recommended-references-loading" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {productChanged && (
                  <p data-testid="recommendations-refreshed-notice"
                    style={{ margin: 0, padding: "6px 9px", borderRadius: 8, background: "rgba(124,58,237,0.10)",
                      border: `1px solid ${BUI.border}`, fontSize: 11, fontWeight: 700, color: BUI.purple }}>
                    {tr("pinDrawer.recommended.refreshedForNewProduct")}
                  </p>
                )}
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
                  {Array.from({ length: 3 }).map((_, i) => (
                    <div key={i} style={{ width: "100%", aspectRatio: "2 / 3", borderRadius: 10, background: BUI.surface3, opacity: 0.5 }} />
                  ))}
                </div>
                <p style={{ margin: 0, fontSize: 11, color: BUI.textSec }}>{tr("pinDrawer.recommended.analyzing")}</p>
              </section>
            )}

            {recsEligible && recStatus === "error" && recommendedRefs.length === 0 && (
              <section data-testid="recommended-references-error" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <p style={{ margin: 0, fontSize: 12, fontWeight: 700, color: BUI.text }}>{tr("pinDrawer.recommended.loadError")}</p>
                <button type="button" data-testid="recommended-retry"
                  onClick={() => { setRecStatus("loading"); setRecReloadKey(k => k + 1); }}
                  style={{ alignSelf: "flex-start", padding: "6px 12px", borderRadius: 8, border: `1px solid ${BUI.border}`, background: BUI.surface2, color: BUI.text, fontSize: 11, fontWeight: 800, cursor: "pointer", fontFamily: "inherit" }}>
                  {tr("pinDetails.retry")}
                </button>
              </section>
            )}

            {recsEligible && recommendedRefs.length > 0 && (
              <section data-testid="recommended-references" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <button type="button" onClick={() => setRecExpanded(v => !v)}
                  style={{ display: "flex", alignItems: "center", gap: 6, background: "none", border: "none", padding: 0, cursor: "pointer", fontFamily: "inherit", textAlign: "left" }}>
                  {recExpanded ? <ChevronDown style={{ width: 14, height: 14, color: BUI.textSec }} /> : <ChevronRight style={{ width: 14, height: 14, color: BUI.textSec }} />}
                  <h3 data-testid="recommended-heading" data-basis={recommendationBasis} style={{ margin: 0, fontSize: 13, fontWeight: 850, color: BUI.text }}>
                    {recommendationBasis === "category_fallback"
                      ? tr("pinDrawer.recommended.headingCategory")
                      : tr("pinDrawer.recommended.heading")}
                  </h3>
                  {selectedRefIds.length > 0 && (
                    <span style={{ fontSize: 10.5, fontWeight: 800, color: BUI.purple }}>{selectedRefIds.length}/{REC_LIMIT}</span>
                  )}
                </button>
                <p style={{ margin: 0, fontSize: 11.5, lineHeight: 1.45, color: BUI.textSec }}>
                  {tr("pinDrawer.recommended.inspirationDisclaimer")}
                </p>
                {productChanged && (
                  <p data-testid="recommendations-refreshed-notice"
                    style={{ margin: 0, padding: "6px 9px", borderRadius: 8, background: "rgba(124,58,237,0.10)",
                      border: `1px solid ${BUI.border}`, fontSize: 11, fontWeight: 700, color: BUI.purple }}>
                    {tr("pinDrawer.recommended.refreshedForNewProduct")}
                  </p>
                )}
                {recExpanded && (
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
                    {recommendedRefs.map(ref => {
                      const sel = selectedRefIds.includes(ref.id);
                      const atCap = !sel && selectedRefIds.length >= REC_LIMIT;
                      const linkback = ref.sourceUrl ?? ref.pinterestUrl ?? undefined;
                      return (
                        <div key={ref.id} data-testid="recommended-reference-card" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                          <button type="button" aria-pressed={sel} disabled={atCap}
                            onClick={() => handleToggleRecommended(ref)}
                            style={{ position: "relative", width: "100%", aspectRatio: "2 / 3", borderRadius: 10, overflow: "hidden", padding: 0,
                              border: `${sel ? 2 : 1}px solid ${sel ? BUI.purple : BUI.border}`, background: BUI.surface3,
                              cursor: atCap ? "default" : "pointer", opacity: atCap ? 0.5 : 1 }}>
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={toProxyUrl(ref.imageUrl)} alt={ref.title} loading="lazy"
                              style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
                            <span style={{ position: "absolute", bottom: 4, left: 4, padding: "1px 6px", borderRadius: 5, background: "rgba(15,23,42,0.72)", color: "#fff", fontSize: 8.5, fontWeight: 800, letterSpacing: "0.02em" }}>Pinterest</span>
                            {sel && (
                              <span style={{ position: "absolute", top: 4, right: 4, width: 17, height: 17, borderRadius: 999, background: BUI.purple, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 900 }}>✓</span>
                            )}
                          </button>
                          <p style={{ margin: 0, fontSize: 10, lineHeight: 1.35, color: BUI.textSec, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{ref.reason}</p>
                          {sel && (() => {
                            const cues = describeStyleCues(ref.patternTags, tr);
                            if (!cues.length) return null;
                            return (
                              <div data-testid="reference-style-cues" style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                                <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: "0.02em", color: BUI.purple }}>{tr("pinDrawer.recommended.styleCuesUsed")}</span>
                                <span style={{ fontSize: 9.5, lineHeight: 1.35, color: BUI.textSec }}>{cues.join(" · ")}</span>
                              </div>
                            );
                          })()}
                          {linkback && (
                            <a href={linkback} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()}
                              style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 9.5, fontWeight: 700, color: BUI.purple, textDecoration: "none" }}>
                              <ExternalLink style={{ width: 9, height: 9 }} /> {tr("pinDrawer.recommended.viewOnPinterest")}
                            </a>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            )}

            <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <h3 style={{ margin: 0, fontSize: 13, fontWeight: 850, color: BUI.text }}>{tr("pinDrawer.directions.heading")}</h3>
              <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                {recommendations.map(direction => {
                  const active = selectedDirection?.id === direction.id;
                  return (
                    <button key={direction.id} type="button" onClick={() => handleSelectDirection(direction)}
                      style={{ textAlign: "left", border: `1px solid ${active ? BUI.purple : BUI.border}`, background: active ? "rgba(124,58,237,0.08)" : BUI.surface2, borderRadius: 10, padding: "8px 10px", cursor: "pointer", fontFamily: "inherit" }}>
                      <span style={{ display: "block", fontSize: 12, fontWeight: 850, color: active ? BUI.purple : BUI.text }}>{direction.title}</span>
                      {active && <span style={{ display: "block", marginTop: 3, fontSize: 11, lineHeight: 1.4, color: BUI.textSec }}>{direction.summary}</span>}
                    </button>
                  );
                })}
              </div>
            </section>
          </div>

          <CreativeChips
            tags={creativeTags}
            selectedTagIds={effectiveSelectedTagIds}
            briefValue={effectiveDirectionBrief}
            briefStale={false}
            onToggleTag={id => {
              setSelectedTagIds(prev => toggleTagSelection(creativeTags, prev.length ? prev : effectiveSelectedTagIds, id));
            }}
            onBriefChange={value => { setDirectionBrief(value); setBriefManuallyEdited(true); }}
            onUpdateBriefFromTags={() => { setDirectionBrief(derivedBrief); setBriefManuallyEdited(false); }}
          />

          <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 14 }}>
            <section>
              <h3 style={{ margin: "0 0 9px", fontSize: 13, fontWeight: 850, color: BUI.text }}>{tr("pinDrawer.settings.heading")}</h3>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <div>
                  <span style={labelStyle}>{tr("pinDrawer.setup.model")}</span>
                  <select data-testid="ai-version-model" value={modelKey} onChange={e => setModelKey(e.target.value)} style={{ ...fieldStyle, cursor: "pointer" }}>
                    {MODEL_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
                <div>
                  {/* Label reflects the actual semantics: with references selected the
                      value is per-reference, so the batch total is refs × value. */}
                  <span style={labelStyle}>
                    {selectedReferences.length > 0
                      ? tr("pinDrawer.settings.pinsPerReference")
                      : tr("pinDrawer.settings.numberOfPins")}
                  </span>
                  <select data-testid="ai-version-count" value={count} onChange={e => setCount(Number(e.target.value))} style={{ ...fieldStyle, cursor: "pointer" }}>
                    {PINS_PER_REFERENCE_OPTIONS.map(n => <option key={n} value={n}>{n}</option>)}
                  </select>
                </div>
                <div>
                  <span style={labelStyle}>{tr("pinDrawer.settings.aspectRatio")}</span>
                  <select data-testid="ai-version-aspect" value={format} onChange={e => setFormat(e.target.value)} style={{ ...fieldStyle, cursor: "pointer" }}>
                    {FORMATS.map(f => <option key={f} value={f}>{f}</option>)}
                  </select>
                </div>
                <div>
                  <span style={labelStyle}>{tr("pinDrawer.settings.resultVariety")}</span>
                  <select data-testid="ai-version-variety" value={variationMode} onChange={e => setVariationMode(e.target.value as VariationMode)} style={{ ...fieldStyle, cursor: "pointer" }}>
                    <option value="distinct">{tr("pinDrawer.settings.distinct")}</option>
                    <option value="similar">{tr("pinDrawer.settings.similar")}</option>
                  </select>
                </div>
              </div>
            </section>

            {/* The Products/References "Prompt weight: 60%/40%" cards were removed
                (create-pin PRD Section H): the percentages were fixed constants, not a
                readout of real weighting. Internal prompt weighting is unchanged. */}
          </div>
        </div>

        <footer style={{ padding: 16, borderTop: `1px solid ${BUI.border}`, flexShrink: 0 }}>
          <button type="button" data-testid="ai-version-generate" disabled={generating || productUrls.length === 0}
            onClick={doGenerate}
            style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, width: "100%", padding: "11px 16px", borderRadius: 11, border: "none", background: BUI.gradient, color: "#fff", fontSize: 13, fontWeight: 850, cursor: generating || productUrls.length === 0 ? "default" : "pointer", opacity: generating || productUrls.length === 0 ? 0.65 : 1, fontFamily: "inherit" }}>
            {generating
              ? <><Loader2 style={{ width: 15, height: 15 }} className="animate-spin" /> {generatingLabel}</>
              : <><Sparkles style={{ width: 15, height: 15 }} /> {(batchTotal === 1 ? tr("pinDrawer.footer.generateCountSingular") : tr("pinDrawer.footer.generateCountPlural")).replace("{n}", String(batchTotal))}</>}
          </button>
          {/* Make the multiplication explicit so "Generate 9 Pins" is never a surprise. */}
          {selectedReferences.length > 0 && (
            <p data-testid="ai-version-batch-math" style={{ margin: "7px 0 0", fontSize: 10.5, textAlign: "center", color: BUI.textSec }}>
              {tr("pinDrawer.footer.batchMath")
                .replace("{refs}", String(selectedReferences.length))
                .replace("{each}", String(count))}
            </p>
          )}
        </footer>
      </div>

    </>
  );
}
