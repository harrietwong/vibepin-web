"use client";

/**
 * Contextual Generate AI Image drawer for Studio Board V2.
 *
 * This relocates the mature Studio generation setup into the Board flow:
 * product images, style references, automatic creative direction, advanced
 * creative controls, model/count/format settings, and the existing asset pickers.
 * Generated outputs are handled by StudioBoard as separate child Pin drafts.
 */

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { ImagePlus, Layers, Loader2, Plus, Sparkles, X } from "lucide-react";
import * as assetStore from "@/lib/assetStore";
import { toProxyUrl } from "@/lib/imageProxy";
import type { PinDraft } from "@/lib/pinDraftStore";
import { buildHiddenPrompt } from "@/lib/studio/hiddenPromptBuilder";
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

type PickerRole = "product" | "style_reference";
export type VariationMode = "distinct" | "similar";

export type AiVersionOptions = {
  prompt: string;
  hiddenPrompt: string;
  productImages: string[];
  referenceImages: string[];
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
  onSetupChange?: (setup: AiVersionDrawerSetup) => void;
  onClose: () => void;
  onGenerate: (opts: AiVersionOptions) => void;
};

const FORMATS = ["Pinterest 2:3", "Pinterest 4:5", "Square 1:1", "Story 9:16"];
const COUNTS = [1, 2, 3, 4];
const MODEL_OPTIONS = [
  { value: "gemini_image", label: MODEL_KEY_TO_LABEL.gemini_image ?? "Gemini Image" },
  { value: "gpt_image", label: MODEL_KEY_TO_LABEL.gpt_image ?? "GPT Image" },
];

function unique(urls: string[]): string[] {
  return Array.from(new Set(urls.filter(Boolean)));
}

function imageTitle(url: string, assets: assetStore.AssetItem[], fallback?: string): string {
  return assets.find(a => a.imageUrl === url)?.title || fallback || "Selected image";
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
  helper,
  urls,
  assets,
  emptyText,
  addTestId,
  onAdd,
  onRemove,
}: {
  label: string;
  helper: string;
  urls: string[];
  assets: assetStore.AssetItem[];
  emptyText: string;
  addTestId: string;
  onAdd: () => void;
  onRemove: (url: string) => void;
}) {
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div>
        <h3 style={{ margin: 0, fontSize: 13, fontWeight: 850, color: BUI.text }}>{label}</h3>
        <p style={{ margin: "2px 0 0", fontSize: 11.5, lineHeight: 1.45, color: BUI.textSec }}>{helper}</p>
      </div>
      <div data-testid={`${label.toLowerCase().replace(/\s+/g, "-")}-selected`} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        {urls.map(url => (
          <div key={url} style={{ position: "relative", width: 58, height: 74, borderRadius: 10, overflow: "hidden", border: `1px solid ${BUI.border}`, background: BUI.surface3 }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={toProxyUrl(url)} alt={imageTitle(url, assets)} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
            <button type="button" aria-label="Remove image" onClick={() => onRemove(url)}
              style={{ position: "absolute", top: 4, right: 4, width: 18, height: 18, borderRadius: 999, border: "none", background: "rgba(15,23,42,0.76)", color: "#fff", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <X style={{ width: 11, height: 11 }} />
            </button>
          </div>
        ))}
        <button type="button" data-testid={addTestId} onClick={onAdd}
          style={{ width: 58, height: 74, borderRadius: 10, border: `1px dashed ${BUI.borderHi}`, background: BUI.surface2, color: BUI.purple, cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 4, fontSize: 10.5, fontWeight: 800, fontFamily: "inherit" }}>
          <Plus style={{ width: 15, height: 15 }} /> Add
        </button>
        {!urls.length && <span style={{ fontSize: 11.5, color: BUI.textMuted }}>{emptyText}</span>}
      </div>
    </section>
  );
}

export function AiVersionDrawer({ draft, open, generating, title = "Generate AI Image", initialSetup, onSetupChange, onClose, onGenerate }: AiVersionDrawerProps) {
  const storedAssets = useSyncExternalStore(assetStore.subscribe, assetStore.getAssets, assetStore.getServerAssets);
  const [productUrls, setProductUrls] = useState<string[]>(() => initialSetup ? initialSetup.productImages : draft?.imageUrl ? [draft.imageUrl] : []);
  const [referenceUrls, setReferenceUrls] = useState<string[]>(() => initialSetup?.referenceImages ?? []);
  const [pickerRole, setPickerRole] = useState<PickerRole | null>(null);
  const [count, setCount] = useState(() => initialSetup?.count ?? 2);
  const [format, setFormat] = useState(() => initialSetup?.format ?? FORMATS[0]);
  const [modelKey, setModelKey] = useState(() => initialSetup?.modelKey ?? "gemini_image");
  const [variationMode, setVariationMode] = useState<VariationMode>(() => initialSetup?.variationMode ?? "distinct");
  const [selectedDirectionId, setSelectedDirectionId] = useState<string | null>(() => initialSetup?.selectedDirectionId ?? null);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>(() => initialSetup?.selectedTagIds ?? []);
  const [directionBrief, setDirectionBrief] = useState(() => initialSetup?.directionBrief ?? "");
  const [briefManuallyEdited, setBriefManuallyEdited] = useState(() => initialSetup?.briefManuallyEdited ?? false);

  useEffect(() => {
    if (!open || !draft?.imageUrl) return;
    assetStore.saveAsset({
      role: "product",
      source: "upload",
      imageUrl: draft.imageUrl,
      title: draft.title || "Current Pin image",
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
  }), [selectedDirection, productSet, referenceContext, intent, category, effectiveDirectionBrief, selectedTags, primaryFormatTag, format]);

  const outputVariants = useMemo(() => buildOutputVariants(count, variationMode, category), [count, variationMode, category]);

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
      title: draft.title || "Current Pin image",
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
    const urls = unique(items.map(item => item.imageUrl).filter(Boolean));
    if (pickerRole === "product") setProductUrls(urls);
    if (pickerRole === "style_reference") setReferenceUrls(urls);
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
    });
  };

  if (pickerRole) {
    return (
      <>
        <div data-testid="ai-version-backdrop" onClick={() => setPickerRole(null)}
          style={{ position: "fixed", inset: 0, zIndex: 90, background: "rgba(15,23,42,0.52)" }} />
        <div data-testid="ai-version-picker-host" role="dialog" aria-label={pickerRole === "product" ? "Choose Product Images" : "Choose Pin References"}
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
      <div data-testid="ai-version-drawer" role="dialog" aria-label="Generate AI Image"
        style={{ position: "fixed", top: 0, right: 0, bottom: 0, zIndex: 91, width: 500, maxWidth: "96vw", background: BUI.surface, borderLeft: `1px solid ${BUI.border}`, boxShadow: "-16px 0 48px rgba(15,23,42,0.18)", display: "flex", flexDirection: "column" }}>
        <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 18px", borderBottom: `1px solid ${BUI.border}`, flexShrink: 0 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 15, fontWeight: 850, color: BUI.text }}>{title}</h2>
            <p style={{ margin: "2px 0 0", fontSize: 11.5, color: BUI.textSec }}>Full AI generation workflow, opened only when needed.</p>
          </div>
          <button type="button" data-testid="ai-version-close" aria-label="Close" onClick={closeDrawer} disabled={generating}
            style={{ background: "none", border: "none", cursor: generating ? "default" : "pointer", color: BUI.textSec, padding: 2, display: "flex" }}>
            <X style={{ width: 18, height: 18 }} />
          </button>
        </header>

        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column" }}>
          <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 17 }}>
            <AssetStrip
              label="Product images"
              helper="Main subjects that should appear in the generated Pins."
              urls={productUrls}
              assets={storedAssets}
              emptyText="No product image selected."
              addTestId="ai-version-add-product"
              onAdd={openProductPicker}
              onRemove={url => setProductUrls(prev => prev.filter(x => x !== url))}
            />
            <AssetStrip
              label="Style references"
              helper="Guide the visual style, composition, and mood. Optional."
              urls={referenceUrls}
              assets={storedAssets}
              emptyText="No reference selected."
              addTestId="ai-version-add-reference"
              onAdd={openReferencePicker}
              onRemove={url => setReferenceUrls(prev => prev.filter(x => x !== url))}
            />

            <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <h3 style={{ margin: 0, fontSize: 13, fontWeight: 850, color: BUI.text }}>Recommended directions</h3>
              <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                {recommendations.map(direction => {
                  const active = selectedDirection?.id === direction.id;
                  return (
                    <button key={direction.id} type="button" onClick={() => { setSelectedDirectionId(direction.id); setBriefManuallyEdited(false); }}
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
              <h3 style={{ margin: "0 0 9px", fontSize: 13, fontWeight: 850, color: BUI.text }}>Pin settings</h3>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <div>
                  <span style={labelStyle}>Model</span>
                  <select data-testid="ai-version-model" value={modelKey} onChange={e => setModelKey(e.target.value)} style={{ ...fieldStyle, cursor: "pointer" }}>
                    {MODEL_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
                <div>
                  <span style={labelStyle}>Number of Pins</span>
                  <select data-testid="ai-version-count" value={count} onChange={e => setCount(Number(e.target.value))} style={{ ...fieldStyle, cursor: "pointer" }}>
                    {COUNTS.map(n => <option key={n} value={n}>{n}</option>)}
                  </select>
                </div>
                <div>
                  <span style={labelStyle}>Aspect ratio</span>
                  <select data-testid="ai-version-aspect" value={format} onChange={e => setFormat(e.target.value)} style={{ ...fieldStyle, cursor: "pointer" }}>
                    {FORMATS.map(f => <option key={f} value={f}>{f}</option>)}
                  </select>
                </div>
                <div>
                  <span style={labelStyle}>Result variety</span>
                  <select data-testid="ai-version-variety" value={variationMode} onChange={e => setVariationMode(e.target.value as VariationMode)} style={{ ...fieldStyle, cursor: "pointer" }}>
                    <option value="distinct">Distinct</option>
                    <option value="similar">Similar</option>
                  </select>
                </div>
              </div>
            </section>

            <div data-testid="ai-version-debug-weights" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <div style={{ border: `1px solid ${BUI.border}`, background: BUI.surface2, borderRadius: 10, padding: 9 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, fontWeight: 850, color: BUI.text }}><ImagePlus style={{ width: 13, height: 13 }} /> Products: {productUrls.length}</div>
                <p style={{ margin: "4px 0 0", fontSize: 10.5, color: BUI.textSec }}>Prompt weight: 60%</p>
              </div>
              <div style={{ border: `1px solid ${BUI.border}`, background: BUI.surface2, borderRadius: 10, padding: 9 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, fontWeight: 850, color: BUI.text }}><Layers style={{ width: 13, height: 13 }} /> References: {referenceUrls.length}</div>
                <p style={{ margin: "4px 0 0", fontSize: 10.5, color: BUI.textSec }}>Prompt weight: {referenceUrls.length ? "40%" : "0%"}</p>
              </div>
            </div>
          </div>
        </div>

        <footer style={{ padding: 16, borderTop: `1px solid ${BUI.border}`, flexShrink: 0 }}>
          <button type="button" data-testid="ai-version-generate" disabled={generating || productUrls.length === 0}
            onClick={doGenerate}
            style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, width: "100%", padding: "11px 16px", borderRadius: 11, border: "none", background: BUI.gradient, color: "#fff", fontSize: 13, fontWeight: 850, cursor: generating || productUrls.length === 0 ? "default" : "pointer", opacity: generating || productUrls.length === 0 ? 0.65 : 1, fontFamily: "inherit" }}>
            {generating ? <><Loader2 style={{ width: 15, height: 15 }} className="animate-spin" /> Generating...</> : <><Sparkles style={{ width: 15, height: 15 }} /> Generate {count} Pin{count === 1 ? "" : "s"}</>}
          </button>
        </footer>
      </div>

    </>
  );
}
