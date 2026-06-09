import type { SetupSnapshot, HistoryEntry, GenerationErrorType } from "@/lib/studioPersistence";

export type FeedPinStatus = "completed" | "generating" | "failed" | "added";

export type PinDetailStudioPin = {
  id: string;
  url: string;
  planningStatus: string;
  title: string;
  description: string;
};

export type PinDetailSession = {
  id: string;
  savedAt: string;
  keyword: string;
  category: string;
  source: string;
  status: string;
  promptFull?: string;
  setupSnapshot?: SetupSnapshot;
  errorType?: GenerationErrorType;
  errorMessage?: string;
  model?: string;
  format?: string;
  textOverlay?: string;
  groupErrors?: Record<number, { message?: string; errorType?: GenerationErrorType }>;
  groups: { refUrl: string | null; refIndex: number; status: string }[];
};

export type PinDetailEntry = {
  key: string;
  sessionId: string;
  groupIdx: number;
  pinIdx?: number;
  pin?: PinDetailStudioPin;
  status: FeedPinStatus;
  refLabel: string;
  createdAt: string;
  placeholderVariant?: "generating" | "queued" | "failed";
};

export type PinDetailView = {
  pinId: string;
  sessionId: string;
  statusLabel: "Completed" | "Failed" | "Generating" | "Queued" | "Added to Plan";
  generationStatus: string;
  planningStatus: string;
  refLabel: string;
  imageUrl: string | null;
  isPlaceholder: boolean;
  placeholderVariant: "generating" | "queued" | "failed" | null;
  pin: PinDetailStudioPin | null;
  entry: PinDetailEntry;
  session: PinDetailSession;
  promptSnapshot: string | null;
  setupSnapshot: SetupSnapshot | null;
  errorMessage: string | null;
  errorType: string | null;
  model: string;
  format: string;
  textOverlay: string;
  createdAt: string;
  groupIdx: number;
  pinIdx?: number;
  source: string;
};

function nonEmpty(value: string | null | undefined): string | null {
  const v = (value ?? "").trim();
  if (!v || v === "undefined" || v === "null") return null;
  return v;
}

export function resolveStatusLabel(entry: PinDetailEntry): PinDetailView["statusLabel"] {
  if (entry.pin && entry.pin.planningStatus !== "not_added") return "Added to Plan";
  if (entry.status === "added") return "Added to Plan";
  if (entry.status === "failed" || entry.placeholderVariant === "failed") return "Failed";
  if (entry.placeholderVariant === "queued") return "Queued";
  if (entry.status === "generating" || entry.placeholderVariant === "generating") return "Generating";
  return "Completed";
}

export function resolvePinDetail(
  session: PinDetailSession,
  entry: PinDetailEntry,
  historyEntry?: HistoryEntry | null,
): PinDetailView {
  const isPlaceholder = entry.status === "generating" || entry.status === "failed" || !entry.pin;
  const variant = entry.placeholderVariant ?? (entry.status === "failed" ? "failed" : isPlaceholder ? "generating" : null);
  const setup = session.setupSnapshot ?? historyEntry?.setupSnapshot ?? null;
  const promptSnapshot =
    nonEmpty(session.promptFull)
    ?? nonEmpty(setup?.promptSnapshot)
    ?? nonEmpty(historyEntry?.promptFull)
    ?? nonEmpty(historyEntry?.promptExcerpt)
    ?? null;

  const groupError = session.groupErrors?.[entry.groupIdx];
  const errorMessage =
    nonEmpty(groupError?.message)
    ?? nonEmpty(session.errorMessage)
    ?? nonEmpty(historyEntry?.errorMessage)
    ?? (isPlaceholder && variant === "failed" ? null : null);

  const errorType =
    groupError?.errorType
    ?? session.errorType
    ?? historyEntry?.errorType
    ?? null;

  const planningStatus = entry.pin?.planningStatus ?? "not_added";

  return {
    pinId: entry.pin?.id ?? entry.key,
    sessionId: session.id,
    statusLabel: resolveStatusLabel(entry),
    generationStatus: session.status,
    planningStatus,
    refLabel: entry.refLabel,
    imageUrl: entry.pin?.url ?? null,
    isPlaceholder,
    placeholderVariant: isPlaceholder ? (variant ?? "generating") : null,
    pin: entry.pin ?? null,
    entry,
    session,
    promptSnapshot,
    setupSnapshot: setup,
    errorMessage: errorMessage ?? (variant === "failed" ? null : null),
    errorType: errorType ?? null,
    model: session.model ?? "GPT Image 2",
    format: session.format ?? "Pinterest 2:3",
    textOverlay: session.textOverlay ?? (setup?.noTextOverlay === false ? "On" : "Off"),
    createdAt: entry.createdAt || session.savedAt,
    groupIdx: entry.groupIdx,
    pinIdx: entry.pinIdx,
    source: session.source,
  };
}

export function findHistoryEntry(sessionId: string, history: HistoryEntry[]): HistoryEntry | null {
  return history.find(h => h.id === sessionId) ?? null;
}
