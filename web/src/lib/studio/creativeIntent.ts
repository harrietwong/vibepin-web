// Deterministic user-intent inference (Creative Intelligence — Step 4).
//
// NO LLM. Combines (a) the product category, (b) the dominant reference analysis,
// and (c) whether products/references are present to infer the creative outcome the
// user is most likely trying to achieve — e.g. fashion products + an on-model
// reference → "show the products worn by a model", not a flat lay.

import type { CategoryPlaybookId } from "./creativeDirections";
import { referenceTypeLabel, type ReferenceContext, type ReferenceType } from "./referenceAnalysis";

export type SubjectTreatment =
  | "on_model"
  | "product_only"
  | "flat_lay"
  | "styled_scene"
  | "tutorial_steps"
  | "moodboard";

export type InfluenceTag = "products" | "references" | "category" | "opportunity";

export type CreativeIntent = {
  /** human-readable outcome, shown in "why this direction" copy */
  primaryOutcome: string;
  subject: SubjectTreatment;
  /** short rationale describing how we inferred it */
  rationale: string;
  influencedBy: InfluenceTag[];
  confidence: "high" | "medium" | "low";
  // ── V1 fuller intent object (AI Understanding panel + hidden prompt) ──────────
  userVisibleSummary: string;
  internalIntent: string;
  category: CategoryPlaybookId;
  primarySubject: string;
  recommendedSubjectType: string;
  recommendedScene: string;
  recommendedFormat: string;
  productSetSummary: string;
  referenceSummary: string;
  reasoning: string[];
};

export type IntentInput = {
  category: CategoryPlaybookId;
  references: ReferenceContext;
  hasProducts: boolean;
  hasOpportunity: boolean;
  /** optional richer context (V1) */
  productSetSummary?: string;
  primaryProductTitle?: string;
  keyword?: string;
  refinement?: string;
};

// Reference types that strongly imply the subject treatment regardless of category.
const REF_SUBJECT: Partial<Record<ReferenceType, SubjectTreatment>> = {
  outfit_on_model: "on_model",
  street_style: "on_model",
  mirror_selfie: "on_model",
  editorial: "on_model",
  room_scene: "styled_scene",
  lifestyle: "styled_scene",
  flat_lay: "flat_lay",
  product_showcase: "product_only",
  tutorial: "tutorial_steps",
  recipe: "tutorial_steps",
  moodboard: "moodboard",
  close_up: "product_only",
};

// Default subject treatment per category when no strong reference signal exists.
const CATEGORY_DEFAULT_SUBJECT: Record<CategoryPlaybookId, SubjectTreatment> = {
  fashion: "on_model",
  "home-decor": "styled_scene",
  beauty: "product_only",
  "food-and-drink": "styled_scene",
  "diy-crafts": "tutorial_steps",
  travel: "styled_scene",
  "digital-products": "product_only",
  generic: "styled_scene",
};

function outcomePhrase(category: CategoryPlaybookId, subject: SubjectTreatment): string {
  switch (subject) {
    case "on_model":      return "show the products worn by a model";
    case "product_only":  return "present the products as clean hero shots";
    case "flat_lay":      return "arrange the products as a styled flat lay";
    case "styled_scene":  return category === "home-decor" ? "stage the products in a styled room scene"
                                : category === "travel"     ? "place the subject in an aspirational travel scene"
                                : "stage the products in a lifestyle scene";
    case "tutorial_steps":return category === "food-and-drink" ? "show the recipe as step-by-step content"
                                : "show the process as step-by-step content";
    case "moodboard":     return "build a curated inspiration moodboard";
  }
}

export function inferCreativeIntent(input: IntentInput): CreativeIntent {
  const influencedBy: InfluenceTag[] = [];
  if (input.hasProducts) influencedBy.push("products");
  if (input.references.hasReferences) influencedBy.push("references");
  influencedBy.push("category");
  if (input.hasOpportunity) influencedBy.push("opportunity");

  const dom = input.references.dominant;

  // 1. Reference-driven subject (strongest signal when present)
  let subject: SubjectTreatment;
  let rationale: string;
  let confidence: CreativeIntent["confidence"];

  if (dom && REF_SUBJECT[dom.referenceType]) {
    subject = REF_SUBJECT[dom.referenceType]!;
    rationale = `Reference reads as ${referenceTypeLabel(dom.referenceType).toLowerCase()}, so the products should ${outcomePhrase(input.category, subject)}.`;
    confidence = dom.confidence;
  } else {
    subject = CATEGORY_DEFAULT_SUBJECT[input.category];
    rationale = input.references.hasReferences
      ? `Reference signal was weak, so we fell back to the ${input.category.replace(/-/g, " ")} default treatment.`
      : `No reference selected, so we used the ${input.category.replace(/-/g, " ")} category default.`;
    confidence = input.references.hasReferences ? "medium" : "low";
  }

  // 2. Guardrail: an on-model treatment only makes sense for categories that can be worn.
  if (subject === "on_model" && !(input.category === "fashion" || input.category === "beauty")) {
    subject = CATEGORY_DEFAULT_SUBJECT[input.category];
    rationale += " Adjusted away from on-model because the category isn't wearable.";
    confidence = "medium";
  }

  const primaryOutcome = outcomePhrase(input.category, subject);
  const catLabel = input.category.replace(/-/g, " ");

  // ── Human-facing + internal summaries ───────────────────────────────────────
  const productSetSummary = input.productSetSummary ?? (input.hasProducts ? "your selected products" : "no products selected");
  const referenceSummary = dom
    ? `a ${referenceTypeLabel(dom.referenceType).toLowerCase()} reference${dom.mood !== "unknown" ? ` with a ${dom.mood} mood` : ""}`
    : input.references.hasReferences ? "your selected reference" : "no reference";

  const recommendedSubjectType = SUBJECT_LABEL[subject];
  const recommendedScene = dom && dom.sceneType !== "unknown" ? `${dom.sceneType} setting` : sceneFor(input.category);
  const recommendedFormat = primaryOutcome;
  const primarySubject = input.primaryProductTitle?.trim()
    || (input.hasProducts ? "your products" : input.references.hasReferences ? "the reference subject" : catLabel);

  const refClause = dom
    ? `, using the reference for ${[dom.influenceDefaults.framing && "framing", dom.influenceDefaults.pose && "pose", dom.influenceDefaults.scene && "scene", dom.influenceDefaults.mood && "mood", dom.influenceDefaults.styling && "styling"].filter(Boolean).join(", ")}`
    : "";
  const userVisibleSummary = input.hasProducts
    ? `We think you want to ${primaryOutcome}${refClause}${dom?.containsPerson ? " — with an original model, never copying the reference's identity" : ""}.`
    : input.references.hasReferences
      ? `We think you want a ${recommendedSubjectType} inspired by ${referenceSummary}${input.keyword ? `, around "${input.keyword}"` : ""}.`
      : `We think you want a ${catLabel} ${recommendedSubjectType}${input.keyword ? ` around "${input.keyword}"` : ""}.`;

  const internalIntent = [
    `Create a Pinterest-native ${catLabel} image: ${primaryOutcome}.`,
    input.hasProducts ? `Feature ${productSetSummary} as recognizable subjects.` : "",
    dom ? `Use the reference for ${dom.influenceDefaults.pose ? "pose, " : ""}framing, scene, and mood only.` : "",
    dom?.containsPerson ? "Generate an ORIGINAL person — do not copy the reference's identity, face, or likeness." : "",
    input.refinement?.trim() ? `User refinement (high priority): ${input.refinement.trim()}` : "",
  ].filter(Boolean).join(" ");

  const reasoning = [...new Set([rationale,
    input.hasProducts ? `Products read as: ${productSetSummary}.` : "",
    dom ? `Reference read as: ${referenceTypeLabel(dom.referenceType).toLowerCase()} (confidence ${dom.confidence}).` : "",
    input.keyword ? `Opportunity keyword "${input.keyword}" factored in.` : "",
  ].filter(Boolean))];

  return {
    primaryOutcome,
    subject,
    rationale,
    influencedBy,
    confidence,
    userVisibleSummary,
    internalIntent,
    category: input.category,
    primarySubject,
    recommendedSubjectType,
    recommendedScene,
    recommendedFormat,
    productSetSummary,
    referenceSummary,
    reasoning,
  };
}

const SUBJECT_LABEL: Record<SubjectTreatment, string> = {
  on_model: "on-model outfit",
  product_only: "product-focused shot",
  flat_lay: "styled flat lay",
  styled_scene: "styled scene",
  tutorial_steps: "step-by-step layout",
  moodboard: "inspiration moodboard",
};

function sceneFor(category: CategoryPlaybookId): string {
  switch (category) {
    case "home-decor": return "interior room scene";
    case "travel":     return "destination scene";
    case "food-and-drink": return "tabletop scene";
    case "beauty":     return "clean studio scene";
    default:           return "lifestyle scene";
  }
}
