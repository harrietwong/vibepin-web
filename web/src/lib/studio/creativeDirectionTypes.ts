// Shared barrel for the Creative Intelligence V1 layer.
// Re-exports the public types/functions so callers import from one place.

export type {
  ProductCategory, ProductAnalysis, ProductSetAnalysis,
} from "./productAnalysis";
export { analyzeProduct, analyzeProductSet, toProductCategory } from "./productAnalysis";

export type {
  ReferenceType, Framing, VisualStyle, SceneType, RefMood,
  ReferenceAnalysis, ReferenceContext,
} from "./referenceAnalysis";
export { analyzeReference, analyzeReferences } from "./referenceAnalysis";

export type { SubjectTreatment, InfluenceTag, CreativeIntent, IntentInput } from "./creativeIntent";
export { inferCreativeIntent } from "./creativeIntent";

export type { CategoryPlaybook, PlaybookControls } from "./categoryPlaybooks";
export { getCategoryPlaybook } from "./categoryPlaybooks";

export type { HiddenPromptInput, HiddenPromptControls, ReferenceInfluenceMode } from "./hiddenPromptBuilder";
export { buildHiddenPrompt, inferReferenceInfluenceMode } from "./hiddenPromptBuilder";

export type {
  CreativeDirectionRecommendation, CategoryPlaybookId, DirectionKind,
  DirectionConfidence, SelectedCreativeAsset, GuidedControls,
} from "./creativeDirections";
export {
  getRecommendedCreativeDirections, inferCreativeCategory, normalizeCategory,
  buildSelectedCreativeAssets, buildManualBrief,
} from "./creativeDirections";
