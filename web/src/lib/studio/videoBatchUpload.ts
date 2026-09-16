import {
  MAX_VIDEO_UPLOAD_BYTES,
  MAX_VIDEO_UPLOAD_ITEMS,
} from "@/lib/videoUploadLimits";

export const VIDEO_BATCH_UPLOAD_CONCURRENCY = 2;
const VIDEO_TYPES = new Set(["video/mp4", "video/x-m4v", "video/quicktime"]);
const EXTENSION_TYPE: Record<string, "video/mp4" | "video/x-m4v" | "video/quicktime"> = {
  mp4: "video/mp4",
  m4v: "video/x-m4v",
  mov: "video/quicktime",
};

export type VideoBatchItemState = "queued" | "uploading" | "succeeded" | "failed" | "cancelled";
export type VideoBatchStatus = "completed" | "partial" | "failed" | "cancelled" | "running";
export type SafeVideoBatchError = { code: string; requestId?: string };
export type VideoInspection = {
  contentType: "video/mp4" | "video/x-m4v" | "video/quicktime";
  width: number;
  height: number;
  durationMs: number;
  checksumSha256: string;
  posterUrl?: string;
};

export type VideoBatchItem = {
  id: string;
  ordinal: number;
  file: File;
  state: VideoBatchItemState;
  inspection?: VideoInspection;
  error?: SafeVideoBatchError;
  draftIdempotencyKey?: string;
};

export type VideoBatchState = {
  clientBatchId: string;
  items: VideoBatchItem[];
  status: VideoBatchStatus;
};

export type VideoUploadDescriptor = {
  ordinal: number;
  idempotencyKey: string;
  filename: string;
  contentType: "video/mp4" | "video/x-m4v" | "video/quicktime";
  byteSize: number;
  checksumSha256: string;
  width: number;
  height: number;
  durationMs: number;
};

export type SignedVideoUpload = {
  ordinal: number;
  path: string;
  token: string;
  signedUrl: string;
  contentType: string;
  upsert: false;
};

export type VideoBatchSelection = {
  kind: "image" | "video" | "mixed" | "rejected";
  draftMode?: "image-choice" | "separate";
  files?: File[];
  error?: SafeVideoBatchError;
};

function extension(name: string): string {
  const match = /\.([A-Za-z0-9]+)$/.exec(name.trim());
  return match?.[1]?.toLowerCase() ?? "";
}

export function normalizedVideoContentType(file: Pick<File, "name" | "type">): VideoInspection["contentType"] | null {
  const byExtension = EXTENSION_TYPE[extension(file.name)];
  if (!byExtension) return null;
  if (!file.type) return byExtension;
  return file.type === byExtension && VIDEO_TYPES.has(file.type) ? byExtension : null;
}

export function isVideoCandidate(file: Pick<File, "name" | "type">): boolean {
  return file.type.startsWith("video/") || Boolean(EXTENSION_TYPE[extension(file.name)]);
}

/** Decides mode before any browser decode or request. Image-only selections retain their old path. */
export function validateVideoBatchSelection(files: File[], enabled: boolean): VideoBatchSelection {
  const videoFiles = files.filter(isVideoCandidate);
  if (!videoFiles.length) return { kind: "image", draftMode: "image-choice", files };
  if (!enabled) return { kind: "rejected", error: { code: "video_upload_disabled" } };
  if (files.length > MAX_VIDEO_UPLOAD_ITEMS) return { kind: "rejected", error: { code: "batch_limit_exceeded" } };
  for (const file of videoFiles) {
    if (!normalizedVideoContentType(file)) return { kind: "rejected", error: { code: "invalid_video_type" } };
    if (file.size < 1 || file.size > MAX_VIDEO_UPLOAD_BYTES) return { kind: "rejected", error: { code: "video_too_large" } };
  }
  return { kind: videoFiles.length === files.length ? "video" : "mixed", draftMode: "separate", files };
}

export function summarizeVideoBatch(state: Pick<VideoBatchState, "items">): VideoBatchStatus {
  const values = state.items.map(item => item.state);
  if (values.some(value => value === "uploading" || value === "queued")) return "running";
  const succeeded = values.filter(value => value === "succeeded").length;
  const failed = values.filter(value => value === "failed").length;
  const cancelled = values.filter(value => value === "cancelled").length;
  if (cancelled && !failed) return "cancelled";
  if (succeeded && (failed || cancelled)) return "partial";
  if (succeeded) return "completed";
  if (failed) return "failed";
  return "cancelled";
}

export function createVideoBatchState(clientBatchId: string, items: VideoBatchItem[]): VideoBatchState {
  const state: VideoBatchState = {
    clientBatchId,
    items: items.map(item => ({
      ...item,
      draftIdempotencyKey: item.draftIdempotencyKey ?? `video:${clientBatchId}:${item.id}`,
    })),
    status: "running",
  };
  return { ...state, status: summarizeVideoBatch(state) };
}

export type VideoBatchEvent =
  | { type: "uploading"; id: string }
  | { type: "succeeded"; id: string; requestId?: string }
  | { type: "failed"; id: string; error: SafeVideoBatchError }
  | { type: "cancelled"; id: string }
  | { type: "cancel-all" };

/** Terminal transitions are monotonic: late transport callbacks cannot revive or overwrite a result. */
export function reduceVideoBatch(state: VideoBatchState, event: VideoBatchEvent): VideoBatchState {
  const nextItems = state.items.map(item => {
    if (event.type === "cancel-all") return item.state === "queued" || item.state === "uploading" ? { ...item, state: "cancelled" as const, error: undefined } : item;
    if (item.id !== event.id || item.state === "succeeded" || item.state === "cancelled") return item;
    if (event.type === "uploading") return item.state === "queued" ? { ...item, state: "uploading" as const, error: undefined } : item;
    if (event.type === "succeeded") return item.state === "uploading" ? { ...item, state: "succeeded" as const, error: undefined } : item;
    if (event.type === "failed") return item.state === "queued" || item.state === "uploading" ? { ...item, state: "failed" as const, error: event.error } : item;
    return item.state === "queued" || item.state === "uploading" ? { ...item, state: "cancelled" as const, error: undefined } : item;
  });
  const next = { ...state, items: nextItems };
  return { ...next, status: summarizeVideoBatch(next) };
}

export function selectRetryableVideoItems(state: VideoBatchState): VideoBatchItem[] {
  return state.items.filter(item => item.state === "failed");
}

export function queueFailedVideoItems(state: VideoBatchState): VideoBatchState {
  const next = {
    ...state,
    items: state.items.map(item => item.state === "failed" ? { ...item, state: "queued" as const, error: undefined } : item),
  };
  return { ...next, status: summarizeVideoBatch(next) };
}

export function safeVideoBatchError(value: unknown, fallback = "video_upload_failed"): SafeVideoBatchError {
  const record = value && typeof value === "object" ? value as { code?: unknown; requestId?: unknown } : null;
  const code = typeof record?.code === "string" && /^[a-z0-9_]{1,80}$/.test(record.code) ? record.code : fallback;
  const requestId = typeof record?.requestId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(record.requestId) ? record.requestId : undefined;
  return requestId ? { code, requestId } : { code };
}

function descriptorFor(item: VideoBatchItem): VideoUploadDescriptor {
  const inspection = item.inspection;
  if (!inspection) throw Object.assign(new Error("video_decode_failed"), { code: "video_decode_failed" });
  // The local draft key deliberately uses readable `:` separators. The upload RPC
  // accepts only SAFE_ID, so keep a distinct, ordinal-prefixed transport key.
  const transportKey = `upload_${item.ordinal}_${item.draftIdempotencyKey ?? item.id}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 128);
  return {
    ordinal: item.ordinal,
    idempotencyKey: transportKey,
    filename: item.file.name,
    contentType: inspection.contentType,
    byteSize: item.file.size,
    checksumSha256: inspection.checksumSha256,
    width: inspection.width,
    height: inspection.height,
    durationMs: inspection.durationMs,
  };
}

export type VideoBatchRunDependencies = {
  signal?: AbortSignal;
  prepare(descriptors: VideoUploadDescriptor[]): Promise<{ batchId: string; uploads: SignedVideoUpload[] }>;
  upload(upload: SignedVideoUpload, item: VideoBatchItem, batchId: string, signal?: AbortSignal): Promise<void>;
  finalize(batchId: string, ordinal: number): Promise<{ proxyUrl: string; requestId: string }>;
  createDraft(item: VideoBatchItem, finalized: { proxyUrl: string; requestId: string }): Promise<void> | void;
  onState?(state: VideoBatchState): void;
};

/**
 * Executes only queued items. The caller supplies the private-upload boundary and the
 * idempotent draft writer, keeping signed capabilities out of React state and errors.
 */
export async function runVideoBatch(initial: VideoBatchState, deps: VideoBatchRunDependencies): Promise<VideoBatchState> {
  let state = initial;
  const emit = () => deps.onState?.(state);
  const transition = (event: VideoBatchEvent) => { state = reduceVideoBatch(state, event); emit(); };
  const pending = state.items.filter(item => item.state === "queued");
  if (!pending.length) return state;
  if (deps.signal?.aborted) {
    transition({ type: "cancel-all" });
    return state;
  }

  let prepared: { batchId: string; uploads: SignedVideoUpload[] };
  try {
    prepared = await deps.prepare(pending.map(descriptorFor));
  } catch (error) {
    const safe = safeVideoBatchError(error, "video_upload_prepare_failed");
    for (const item of pending) transition(deps.signal?.aborted ? { type: "cancelled", id: item.id } : { type: "failed", id: item.id, error: safe });
    return state;
  }
  const byOrdinal = new Map(prepared.uploads.map(upload => [upload.ordinal, upload]));
  let cursor = 0;
  const worker = async () => {
    while (cursor < pending.length) {
      const item = pending[cursor++];
      if (deps.signal?.aborted) { transition({ type: "cancelled", id: item.id }); continue; }
      const upload = byOrdinal.get(item.ordinal);
      if (!upload) { transition({ type: "failed", id: item.id, error: { code: "video_upload_prepare_failed" } }); continue; }
      transition({ type: "uploading", id: item.id });
      try {
        await deps.upload(upload, item, prepared.batchId, deps.signal);
        if (deps.signal?.aborted) { transition({ type: "cancelled", id: item.id }); continue; }
        const finalized = await deps.finalize(prepared.batchId, item.ordinal);
        // Finalize is the durable boundary. If cancellation races after it, create
        // the idempotent local draft so a ready private object never becomes orphaned.
        await deps.createDraft(item, finalized);
        transition({ type: "succeeded", id: item.id, requestId: finalized.requestId });
      } catch (error) {
        transition(deps.signal?.aborted ? { type: "cancelled", id: item.id } : { type: "failed", id: item.id, error: safeVideoBatchError(error) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(VIDEO_BATCH_UPLOAD_CONCURRENCY, pending.length) }, worker));
  return state;
}
