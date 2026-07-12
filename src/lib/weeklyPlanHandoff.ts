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
import { resolveModelLabel } from "./studio/modelLabel";

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
  plannedTime?: string;
  plannedAt?: string;
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
  // ── Amazon affiliate product link (creator-owned) ──────────────────────────
  productId?: string;
  creatorProductLinkId?: string;
  sourceProductImageUrl?: string;
  destinationUrlSource?: string;
};

export type GeneratedPinHandoffInput = {
  pin: {
    id: string;
    url: string;
    title?: string;
    description?: string;
    altText?: string;
    destinationUrl?: string;
    destinationUrlSource?: string;
    plannedDate?: string;
    plannedTime?: string;
    plannedAt?: string;
    planningStatus?: string;
    metadataDraft?: PinMetadataDraft;
    metadataTouched?: MetadataTouchedFlags;
    setupSnapshot?: SetupSnapshot | null;
    generationSetup?: SetupSnapshot | null;
    productId?: string;
    creatorProductLinkId?: string;
    sourceProductImageUrl?: string;
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
  groupStatus: "generating" | "done" | "partial" | "failed";
  autoPlannedDate?: string;
  keywordFallback?: string;
  categoryFallback?: string;
};

export function sanitizeHandoffField(value: string | null | undefined): string {
  const v = (value ?? "").trim();
  if (!v || v === "undefined" || v === "null") return "";
  return v;
}

/**
 * Local-time YYYY-MM-DD for a Date — the single source of truth for plan dates.
 *
 * CRITICAL: never use `Date.toISOString().slice(0,10)` to derive a plan date. In any
 * UTC+offset zone (e.g. UTC+8) the local-midnight instant serializes to the PREVIOUS
 * UTC calendar day, so a Pin added "today" is stored as yesterday and then falls
 * outside Weekly Plan's locally-computed week/month — making it invisible. Weekly Plan
 * filters dates in local time (see computeWeekStartISO / dateInWeek), so every stored
 * `scheduledDate` MUST also be a local calendar date. This helper guarantees that.
 */
export function localDateISO(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** localDateISO for "today + n days" — used for default plan-date suggestions. */
export function plannableDateISO(daysFromToday = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + daysFromToday);
  return localDateISO(d);
}

/** Compose local calendar values without converting through UTC. */
export function combineLocalPlannedAt(date: string, time = ""): string {
  const d = sanitizeHandoffField(date);
  if (!d) return "";
  const t = sanitizeHandoffField(time);
  return `${d}T${/^\d{2}:\d{2}$/.test(t) ? t : "00:00"}`;
}

/** Read persisted local plannedAt without timezone shifts. */
export function splitLocalPlannedAt(plannedAt?: string | null): { date: string; time: string } {
  const value = sanitizeHandoffField(plannedAt);
  const match = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}))?/.exec(value);
  return { date: match?.[1] ?? "", time: match?.[2] ?? "" };
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
  if (groupStatus !== "done" && groupStatus !== "partial") return false;
  if (!sanitizeHandoffField(pin.url)) return false;
  if (pin.planningStatus && pin.planningStatus !== "not_added") return false;
  return true;
}

export function buildWeeklyPlanItemFromGeneratedPin(
  input: GeneratedPinHandoffInput,
): WeeklyPlanItemPayload | null {
  if (!canAddGeneratedPinToPlan(input.groupStatus, input.pin)) return null;

  const setup = input.pin.setupSnapshot ?? input.pin.generationSetup ?? input.session.setupSnapshot;
  const compactSetup = setup ? { ...setup, creativeDirectionSnapshot: undefined } : undefined;
  const meta = input.pin.metadataDraft;
  const plannedDate =
    sanitizeHandoffField(input.pin.plannedDate)
    || sanitizeHandoffField(input.autoPlannedDate)
    || sanitizeHandoffField(meta?.plannedDate)
    || "";
  const plannedTime = sanitizeHandoffField(input.pin.plannedTime);
  const plannedAt = sanitizeHandoffField(input.pin.plannedAt) || combineLocalPlannedAt(plannedDate, plannedTime);

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
  // Affiliate product context — carried verbatim so the Pin keeps the same product
  // image + affiliate destination through Add to Plan / Schedule.
  const destinationUrlSource =
    sanitizeHandoffField(input.pin.destinationUrlSource)
    || sanitizeHandoffField(meta?.destinationUrlSource)
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
    setupSnapshot: compactSetup,
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
    model: resolveModelLabel(sanitizeHandoffField(input.session.model), setup?.modelKey),
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
    productId: sanitizeHandoffField(input.pin.productId) || undefined,
    creatorProductLinkId: sanitizeHandoffField(input.pin.creatorProductLinkId) || undefined,
    sourceProductImageUrl: sanitizeHandoffField(input.pin.sourceProductImageUrl) || undefined,
    destinationUrlSource: destinationUrlSource || undefined,
  };
}

export function draftStatusFromPlanningStatus(status: PlanningStatusValue): "ready" | "needs_review" {
  return status === "ready" ? "ready" : "needs_review";
}

export function displayTitle(title: string, fallback = "Generated Pin"): string {
  return sanitizeHandoffField(title) || fallback;
}
