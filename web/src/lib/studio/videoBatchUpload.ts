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
  /** Browser-only cover bytes. Never serialized to recovery or rendered state. */
  posterFile?: File;
  posterPath?: string;
  error?: SafeVideoBatchError;
  draftIdempotencyKey?: string;
  /** A transport attempt is deliberately separate from the durable draft key. */
  attempt?: { id: string; batchId: string; ordinal: number; phase: "prepared" | "finalize_pending" };
  /** A finalized private object which still needs its local board draft written. */
  finalized?: { proxyUrl: string; requestId: string };
  draftId?: string;
  requestId?: string;
};

export type VideoBatchState = {
  clientBatchId: string;
  /** Immutable owner binding; retries must never adopt a later browser session. */
  ownerScope?: { ownerUserId: string; workspaceId: string };
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
  // Per-file MIME/size errors are kept for preflight so a bad sibling never
  // rejects a valid file before it has its own item/error row.
  if (files.length === 1) {
    const file = videoFiles[0];
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
  | { type: "attempt"; id: string; attempt: NonNullable<VideoBatchItem["attempt"]> }
  | { type: "finalized"; id: string; finalized: NonNullable<VideoBatchItem["finalized"]> }
  | { type: "poster"; id: string; posterUrl: string; posterPath: string }
  | { type: "succeeded"; id: string; requestId?: string; draftId?: string }
  | { type: "failed"; id: string; error: SafeVideoBatchError }
  | { type: "cancelled"; id: string }
  | { type: "cancel-all" };

/** Terminal transitions are monotonic: late transport callbacks cannot revive or overwrite a result. */
export function reduceVideoBatch(state: VideoBatchState, event: VideoBatchEvent): VideoBatchState {
  const nextItems = state.items.map(item => {
    if (event.type === "cancel-all") return item.state === "queued" || item.state === "uploading" ? { ...item, state: "cancelled" as const, error: undefined } : item;
    if (item.id !== event.id || item.state === "succeeded" || item.state === "cancelled") return item;
    if (event.type === "uploading") return item.state === "queued" ? { ...item, state: "uploading" as const, error: undefined } : item;
    if (event.type === "attempt") return item.state === "queued" || item.state === "uploading" ? { ...item, attempt: event.attempt } : item;
    if (event.type === "finalized") return item.state === "queued" || item.state === "uploading" ? { ...item, finalized: event.finalized, attempt: undefined } : item;
    if (event.type === "poster") return item.state === "queued" || item.state === "uploading"
      ? { ...item, inspection: item.inspection ? { ...item.inspection, posterUrl: event.posterUrl } : item.inspection, posterPath: event.posterPath }
      : item;
    if (event.type === "succeeded") return item.state === "uploading" ? { ...item, state: "succeeded" as const, error: undefined, requestId: event.requestId, draftId: event.draftId } : item;
    if (event.type === "failed") return item.state === "queued" || item.state === "uploading" ? { ...item, state: "failed" as const, error: event.error } : item;
    return item.state === "queued" || item.state === "uploading" ? { ...item, state: "cancelled" as const, error: undefined } : item;
  });
  const next = { ...state, items: nextItems };
  return { ...next, status: summarizeVideoBatch(next) };
}

export function selectRetryableVideoItems(state: VideoBatchState): VideoBatchItem[] {
  // Decode/metadata failures have no proven local descriptor and cannot be made
  // valid by replaying a remote transfer. A finalized receipt is retryable even
  // after a reload because it only needs a local draft write.
  return state.items.filter(item => item.state === "failed" && Boolean(item.inspection || item.finalized));
}

export function queueFailedVideoItems(state: VideoBatchState): VideoBatchState {
  const next = {
    ...state,
    items: state.items.map(item => item.state === "failed" && (item.inspection || item.finalized)
      ? {
        ...item, state: "queued" as const, error: undefined,
        // A non-finalized failed attempt asks the server to clean its poster. A
        // retry must not attach that soon-to-be-deleted object to a fresh draft.
        ...(!item.finalized && item.attempt?.phase !== "finalize_pending" && item.inspection
          ? { inspection: { ...item.inspection, posterUrl: undefined }, posterPath: undefined, attempt: undefined }
          : {}),
      }
      : item),
  };
  return { ...next, status: summarizeVideoBatch(next) };
}

export function safeVideoBatchError(value: unknown, fallback = "video_upload_failed"): SafeVideoBatchError {
  const record = value && typeof value === "object" ? value as { code?: unknown; requestId?: unknown } : null;
  const code = typeof record?.code === "string" && /^[a-z0-9_]{1,80}$/.test(record.code) ? record.code : fallback;
  const requestId = typeof record?.requestId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(record.requestId) ? record.requestId : undefined;
  return requestId ? { code, requestId } : { code };
}

function descriptorFor(item: VideoBatchItem, attemptNumber: number): VideoUploadDescriptor {
  const inspection = item.inspection;
  if (!inspection) throw Object.assign(new Error("video_decode_failed"), { code: "video_decode_failed" });
  // The local draft key deliberately uses readable `:` separators. The upload RPC
  // accepts only SAFE_ID, so keep a distinct, ordinal-prefixed transport key.
  const transportKey = `upload_${item.ordinal}_${attemptNumber}_${item.draftIdempotencyKey ?? item.id}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 128);
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
  /** Returns a durable acknowledgement. Undefined is retained only for old test seams. */
  createDraft(item: VideoBatchItem, finalized: { proxyUrl: string; requestId: string }): Promise<void | { persisted?: boolean; draftId?: string }> | void | { persisted?: boolean; draftId?: string };
  /** Persist the server transfer receipt before uploading bytes. Throwing fails closed. */
  onAttempt?(item: VideoBatchItem, attempt: NonNullable<VideoBatchItem["attempt"]>): Promise<void> | void;
  /** Persist the finalized recovery receipt before the local draft write. */
  onFinalized?(item: VideoBatchItem, finalized: { proxyUrl: string; requestId: string }): Promise<void> | void;
  /** Called only after an eligible server transfer attempt is durably recorded. */
  preparePoster?(item: VideoBatchItem, signal?: AbortSignal): Promise<{ proxyUrl: string; path: string } | undefined>;
  /** Persist association before transferring bytes; errors fail closed. */
  onPoster?(item: VideoBatchItem, poster: { proxyUrl: string; path: string }): Promise<void> | void;
  /** Best-effort immediate request; server owns durable cleanup responsibility. */
  cleanupPoster?(item: VideoBatchItem): Promise<void> | void;
  onState?(state: VideoBatchState): void;
};

function safePreparedUpload(
  prepared: { batchId: string; uploads: SignedVideoUpload[] },
  descriptor: VideoUploadDescriptor,
): SignedVideoUpload | null {
  if (!prepared || typeof prepared.batchId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(prepared.batchId)
    || !Array.isArray(prepared.uploads) || prepared.uploads.length !== 1) return null;
  const upload = prepared.uploads[0];
  if (!upload || upload.ordinal !== descriptor.ordinal || upload.contentType !== descriptor.contentType
    || upload.upsert !== false || typeof upload.path !== "string" || typeof upload.token !== "string"
    || typeof upload.signedUrl !== "string") return null;
  return upload;
}

function terminalReplayError(error: unknown): boolean {
  const code = safeVideoBatchError(error).code;
  return code === "video_upload_not_uploadable" || code === "video_upload_expired"
    || code === "missing_video_object" || code === "video_upload_failed" || code === "video_upload_not_finalizable";
}

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

  let cursor = 0;
  const worker = async () => {
    while (cursor < pending.length) {
      const queued = pending[cursor++];
      const item = () => state.items.find(current => current.id === queued.id) ?? queued;
      if (deps.signal?.aborted) { transition({ type: "cancelled", id: item().id }); continue; }
      transition({ type: "uploading", id: queued.id });
      let finalized = item().finalized;
      try {
        const previous = item().attempt;
        if (!finalized && previous?.phase === "finalize_pending") {
          try {
            finalized = await deps.finalize(previous.batchId, previous.ordinal);
          } catch (error) {
            // A terminal server result may only be retried by making a new server
            // batch/attempt. Unknown outcomes retain this exact receipt for replay.
            if (!terminalReplayError(error)) throw error;
          }
        }
        if (!finalized) {
          const current = item();
          const descriptor = descriptorFor(current, (current.attempt ? Number(current.attempt.id.split("_").at(-1)) || 0 : 0) + 1);
          const prepared = await deps.prepare([descriptor]);
          const upload = safePreparedUpload(prepared, descriptor);
          if (!upload) throw Object.assign(new Error("video_upload_prepare_failed"), { code: "video_upload_prepare_failed" });
          const attempt = { id: `attempt_${descriptor.ordinal}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, batchId: prepared.batchId, ordinal: descriptor.ordinal, phase: "prepared" as const };
          await deps.onAttempt?.(current, attempt);
          transition({ type: "attempt", id: current.id, attempt });
          if (current.posterFile && !current.inspection?.posterUrl) {
            const poster = await deps.preparePoster?.(current, deps.signal);
            if (poster) {
              transition({ type: "poster", id: current.id, posterUrl: poster.proxyUrl, posterPath: poster.path });
              await deps.onPoster?.(item(), poster);
            }
          }
          const transferItem = item();
          await deps.upload(upload, transferItem, prepared.batchId, deps.signal);
          if (deps.signal?.aborted) {
            if (transferItem.posterPath) { try { await deps.cleanupPoster?.(transferItem); } catch { /* receipt keeps cleanup retry */ } }
            transition({ type: "cancelled", id: transferItem.id });
            continue;
          }
          try {
            finalized = await deps.finalize(prepared.batchId, current.ordinal);
          } catch (error) {
            const pendingAttempt = { ...attempt, phase: "finalize_pending" as const };
            await deps.onAttempt?.(item(), pendingAttempt);
            transition({ type: "attempt", id: current.id, attempt: pendingAttempt });
            throw error;
          }
        }
        if (!finalized) throw Object.assign(new Error("video_upload_failed"), { code: "video_upload_failed" });
        await deps.onFinalized?.(item(), finalized);
        transition({ type: "finalized", id: queued.id, finalized });
        // Once finalized, cancellation cannot discard the durable receipt. The
        // idempotent local draft is either durably written or remains retryable.
        const created = await deps.createDraft(item(), finalized);
        if (created && created.persisted === false) throw Object.assign(new Error("draft_persist_failed"), { code: "draft_persist_failed" });
        transition({ type: "succeeded", id: queued.id, requestId: finalized.requestId, draftId: created?.draftId });
      } catch (error) {
        const current = item();
        if (!current.finalized && current.attempt?.phase !== "finalize_pending" && current.posterPath) {
          try { await deps.cleanupPoster?.(current); } catch { /* durable receipt retries owner cleanup */ }
        }
        // A final result must not be reclassified as cancellation: its receipt
        // needs a future local draft write.
        transition(deps.signal?.aborted && !current.finalized
          ? { type: "cancelled", id: current.id }
          : { type: "failed", id: current.id, error: safeVideoBatchError(error) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(VIDEO_BATCH_UPLOAD_CONCURRENCY, pending.length) }, worker));
  return state;
}
