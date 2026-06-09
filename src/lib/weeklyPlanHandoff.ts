/**
 * weeklyPlanHandoff.ts — normalize Studio generated pins → Weekly Plan drafts.
 */

import {
  computePlanningStatusFromFields,
  EMPTY_TOUCHED,
  type MetadataTouchedFlags,
  type PinMetadataDraft,
} from "./pinMetadata";
import type { SetupSnapshot, ProductSnapshot, ReferenceSnapshot } from "./studioPersistence";

export type PlanningStatusValue = "ready" | "needs_review";

export type WeeklyPlanItemPayload = {
  pinId: string;
  sessionId: string;
  imageUrl: string;
  title: string;
  description: string;
  altText: string;
  destinationUrl: string;
  plannedDate: string;
  planningStatus: PlanningStatusValue;
  generationStatus: string;
  metadataDraft?: PinMetadataDraft;
  metadataTouched: MetadataTouchedFlags;
  setupSnapshot?: SetupSnapshot;
  promptSnapshot: string;
  opportunity: string;
  selectedProductImages: ProductSnapshot[];
  selectedPinReferences: ReferenceSnapshot[];
  source: string;
  format: string;
  model: string;
  createdAt: string;
  addedToPlanAt: string;
  keyword: string;
  category: string;
};

export type GeneratedPinHandoffInput = {
  pin: {
    id: string;
    url: string;
    title?: string;
    description?: string;
    altText?: string;
    destinationUrl?: string;
    plannedDate?: string;
    planningStatus?: string;
    metadataDraft?: PinMetadataDraft;
    metadataTouched?: MetadataTouchedFlags;
  };
  session: {
    id: string;
    keyword?: string;
    category?: string;
    source?: string;
    status?: string;
    savedAt?: string;
    setupSnapshot?: SetupSnapshot;
    promptFull?: string;
    model?: string;
    format?: string;
  };
  groupStatus: "generating" | "done" | "failed";
  autoPlannedDate?: string;
  keywordFallback?: string;
  categoryFallback?: string;
};

export function sanitizeHandoffField(value: string | null | undefined): string {
  const v = (value ?? "").trim();
  if (!v || v === "undefined" || v === "null") return "";
  return v;
}

export function mapSessionToGenerationStatus(sessionStatus?: string): string {
  if (!sessionStatus) return "completed";
  if (sessionStatus === "generating" || sessionStatus === "queued") return "running";
  if (sessionStatus === "partial") return "partial";
  if (sessionStatus === "failed") return "failed";
  return "completed";
}

export function canAddGeneratedPinToPlan(
  groupStatus: string,
  pin: { url?: string; planningStatus?: string },
): boolean {
  if (groupStatus !== "done") return false;
  if (!sanitizeHandoffField(pin.url)) return false;
  if (pin.planningStatus && pin.planningStatus !== "not_added") return false;
  return true;
}

export function buildWeeklyPlanItemFromGeneratedPin(
  input: GeneratedPinHandoffInput,
): WeeklyPlanItemPayload | null {
  if (!canAddGeneratedPinToPlan(input.groupStatus, input.pin)) return null;

  const setup = input.session.setupSnapshot;
  const meta = input.pin.metadataDraft;
  const plannedDate =
    sanitizeHandoffField(input.pin.plannedDate)
    || sanitizeHandoffField(input.autoPlannedDate)
    || sanitizeHandoffField(meta?.plannedDate)
    || "";

  const title =
    sanitizeHandoffField(input.pin.title)
    || sanitizeHandoffField(meta?.selectedTitle)
    || "";
  const description =
    sanitizeHandoffField(input.pin.description)
    || sanitizeHandoffField(meta?.selectedDescription)
    || "";
  const altText =
    sanitizeHandoffField(input.pin.altText)
    || sanitizeHandoffField(meta?.altText)
    || "";
  const destinationUrl =
    sanitizeHandoffField(input.pin.destinationUrl)
    || sanitizeHandoffField(meta?.destinationUrl)
    || "";

  const planningStatus = computePlanningStatusFromFields({
    title,
    description,
    plannedDate,
    wasAdded: true,
  }) as PlanningStatusValue;

  const now = new Date().toISOString();

  return {
    pinId: input.pin.id,
    sessionId: input.session.id,
    imageUrl: input.pin.url,
    title,
    description,
    altText,
    destinationUrl,
    plannedDate,
    planningStatus,
    generationStatus: mapSessionToGenerationStatus(input.session.status),
    metadataDraft: meta,
    metadataTouched: { ...EMPTY_TOUCHED, ...input.pin.metadataTouched },
    setupSnapshot: setup,
    promptSnapshot:
      sanitizeHandoffField(input.session.promptFull)
      || sanitizeHandoffField(setup?.promptSnapshot)
      || "",
    opportunity:
      sanitizeHandoffField(setup?.opportunityTitle)
      || sanitizeHandoffField(setup?.keyword)
      || "",
    selectedProductImages: setup?.selectedProducts ?? [],
    selectedPinReferences: setup?.selectedReferences ?? [],
    source: sanitizeHandoffField(input.session.source) || sanitizeHandoffField(setup?.createdFrom) || "studio",
    format: sanitizeHandoffField(input.session.format) || "Pinterest 2:3",
    model: sanitizeHandoffField(input.session.model) || "GPT Image 2",
    createdAt: input.session.savedAt || now,
    addedToPlanAt: now,
    keyword:
      sanitizeHandoffField(input.session.keyword)
      || sanitizeHandoffField(setup?.keyword)
      || input.keywordFallback
      || "Pinterest content",
    category:
      sanitizeHandoffField(input.session.category)
      || sanitizeHandoffField(setup?.category)
      || input.categoryFallback
      || "home-decor",
  };
}

export function draftStatusFromPlanningStatus(status: PlanningStatusValue): "ready" | "needs_review" {
  return status === "ready" ? "ready" : "needs_review";
}

export function displayTitle(title: string, fallback = "Generated Pin"): string {
  return sanitizeHandoffField(title) || fallback;
}
