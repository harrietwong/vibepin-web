/**
 * pinLifecycle.ts — Create Pins board status model (studioBoardV2).
 *
 * The ONLY card status values (matches the existing studio PinCardActions model):
 *   generating | failed | unscheduled | scheduled | posted
 *
 * Derived purely from durable draft fields — there is NO "ready" / "need details"
 * card status. Missing fields (title/description/board/url…) never change the card
 * status; a generated-but-undated Pin is simply "unscheduled". Required-field
 * validation is surfaced ONLY inside the edit/schedule modal on publish/schedule.
 *
 * Source ("Uploaded" / "AI Generated") is a SEPARATE badge — never merged with status.
 */

import type { PinDraft } from "@/lib/pinDraftStore";
import { sanitizeHandoffField } from "@/lib/weeklyPlanHandoff";

export type PinLifecycle = "generating" | "failed" | "unscheduled" | "scheduled" | "posted";

function genStatus(d: Pick<PinDraft, "generationStatus">): string {
  return (d.generationStatus ?? "").toLowerCase();
}
function isGenerating(d: Pick<PinDraft, "generationStatus">): boolean {
  const s = genStatus(d);
  return s === "generating" || s === "running" || s === "pending" || s === "queued";
}
function isGenerationFailed(d: Pick<PinDraft, "generationStatus">): boolean {
  const s = genStatus(d);
  return s === "failed" || s === "error";
}

export function isPosted(d: Pick<PinDraft, "postedAt" | "remotePinId">): boolean {
  return !!sanitizeHandoffField(d.postedAt) || !!sanitizeHandoffField(d.remotePinId);
}
export function isScheduledLifecycle(d: Pick<PinDraft, "scheduledDate" | "plannedAt">): boolean {
  return !!sanitizeHandoffField(d.scheduledDate) || !!sanitizeHandoffField(d.plannedAt);
}

/**
 * Derive lifecycle. Order: generating → posted → failed → scheduled → unscheduled.
 * (Missing required fields do NOT produce a status — they stay "unscheduled".)
 */
export function getPinLifecycle(draft: PinDraft): PinLifecycle {
  if (isGenerating(draft)) return "generating";
  if (isPosted(draft)) return "posted";
  if (sanitizeHandoffField(draft.publishError) || isGenerationFailed(draft)) return "failed";
  if (isScheduledLifecycle(draft)) return "scheduled";
  return "unscheduled";
}

export type StatusTone = "info" | "success" | "error" | "scheduled" | "neutral";
export type StatusBadge = { lifecycle: PinLifecycle; label: string; tone: StatusTone };

export function getStatusBadge(draft: PinDraft): StatusBadge {
  const lifecycle = getPinLifecycle(draft);
  switch (lifecycle) {
    case "generating": return { lifecycle, label: "Generating",  tone: "info" };
    case "posted":     return { lifecycle, label: "Posted",      tone: "success" };
    case "failed":     return { lifecycle, label: "Failed",      tone: "error" };
    case "scheduled":  return { lifecycle, label: "Scheduled",   tone: "scheduled" };
    case "unscheduled":
    default:           return { lifecycle, label: "Unscheduled", tone: "neutral" };
  }
}

export type SourceBadge = { label: "Uploaded" | "AI Generated" } | null;

/** Separate source badge (never merged with status). */
export function getSourceBadge(draft: Pick<PinDraft, "source">): SourceBadge {
  if (draft.source === "uploaded_image") return { label: "Uploaded" };
  if (draft.source === "ai_generated_from_upload") return { label: "AI Generated" };
  return null;
}

// ── Shared in-flight publish registry ──────────────────────────────────────────
// Prevents a card publish and a batch publish from running on the same draft at
// once, and drives the transient "Publishing…" BUTTON state (not a card status).

const _inFlight = new Set<string>();
const _listeners = new Set<() => void>();
let _inFlightVersion = 0;

function _notify(): void { _inFlightVersion++; _listeners.forEach(fn => fn()); }

/** Monotonic version — use as the useSyncExternalStore snapshot (the Set ref is stable). */
export function getInFlightVersion(): number { return _inFlightVersion; }

/** Claim a draft for publishing. Returns false if it's already in flight (dedupe). */
export function beginPublish(id: string): boolean {
  if (_inFlight.has(id)) return false;
  _inFlight.add(id);
  _notify();
  return true;
}

/** Release a draft after publish success/failure. */
export function endPublish(id: string): void {
  if (_inFlight.delete(id)) _notify();
}

export function isPublishInFlight(id: string): boolean { return _inFlight.has(id); }

export function getInFlightPublishSet(): ReadonlySet<string> { return _inFlight; }

/** Subscribe to in-flight changes (for React re-render of the publishing button). */
export function subscribeInFlight(cb: () => void): () => void {
  _listeners.add(cb);
  return () => { _listeners.delete(cb); };
}
