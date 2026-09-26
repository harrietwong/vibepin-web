"use client";

/**
 * VideoUploadPlaceholderCard — one board-grid slot per in-flight video upload item
 * (queued/uploading/finalize-pending). Renders card-sized so it holds the grid layout
 * steady while the real draft card is still being created; disappears the instant the
 * real PinBoardCard exists (StudioBoard filters finished items out of the video queue
 * list — see `visibleVideoQueueItems`/`selectVisibleVideoQueueItems`, which already
 * drops `succeeded` items so there is never a placeholder+real-card overlap).
 *
 * Failed items render the same card shape in an error state with Retry / Dismiss,
 * so a failure never needs its own separate top-of-page panel.
 */

import { Loader2, X, RotateCcw } from "lucide-react";
import { BUI, STUDIO_UI } from "@/components/studio/boardUI";
import { videoBatchErrorMessage, type VideoBatchItem } from "@/lib/studio/videoBatchUpload";
import { useLocale } from "@/lib/i18n/LocaleProvider";

export type VideoUploadPlaceholderCardProps = {
  item: VideoBatchItem;
  cancellable: boolean;
  retryable: boolean;
  onCancel: (id: string) => void;
  onRetry: (id: string) => void;
  onDismiss: (id: string) => void;
};

export function VideoUploadPlaceholderCard(props: VideoUploadPlaceholderCardProps) {
  const { item, cancellable, retryable, onCancel, onRetry, onDismiss } = props;
  const { t: tr } = useLocale();
  const failed = item.state === "failed";
  const statusLabel = failed
    ? (videoBatchErrorMessage(item.error?.code ?? "") ?? tr("studioBoard.videoUpload.failedGeneric"))
    : item.state === "uploading"
      ? tr("studioBoard.videoUpload.uploading")
      : tr("studioBoard.videoUpload.waiting");

  return (
    <div
      data-testid={`video-upload-item-${item.id}`}
      title={item.error?.requestId ? `Request ${item.error.requestId}` : undefined}
      data-request-id={item.error?.requestId || undefined}
      data-video-upload-state={item.state}
      style={{
        position: "relative",
        display: "flex",
        flexDirection: "column",
        borderRadius: STUDIO_UI.cardRadius,
        border: `1px solid ${failed ? BUI.error : BUI.border}`,
        background: BUI.surface,
        overflow: "hidden",
      }}
    >
      {cancellable && (
        <button
          type="button"
          data-testid={`video-upload-cancel-${item.id}`}
          onClick={() => onCancel(item.id)}
          aria-label={tr("studioBoard.videoUpload.cancelAria")}
          style={{
            position: "absolute", top: 8, right: 8, zIndex: 1,
            width: 22, height: 22, borderRadius: "50%",
            border: `1px solid ${BUI.border}`, background: BUI.surface,
            color: BUI.textSec, display: "flex", alignItems: "center", justifyContent: "center",
            cursor: "pointer", padding: 0,
          }}
        >
          <X style={{ width: 12, height: 12 }} />
        </button>
      )}
      <div style={{ position: "relative", width: "100%", minHeight: 180, aspectRatio: "1 / 1", background: BUI.surface3, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8 }}>
        {failed ? (
          <div style={{ width: 32, height: 32, borderRadius: "50%", background: "rgba(239,68,68,0.12)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <X style={{ width: 16, height: 16, color: BUI.error }} />
          </div>
        ) : (
          <Loader2 style={{ width: 28, height: 28, color: BUI.purple }} className="animate-spin" />
        )}
        <span style={{ fontSize: 11.5, fontWeight: 700, color: failed ? BUI.error : BUI.textSec, padding: "0 12px", textAlign: "center" }}>
          {statusLabel}
        </span>
      </div>
      <div style={{ padding: "8px 10px 10px", display: "flex", flexDirection: "column", gap: 6 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: BUI.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {item.file.name}
        </span>
        {failed && (
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            {retryable && <button
              type="button"
              data-testid={`video-upload-retry-${item.id}`}
              onClick={() => onRetry(item.id)}
              style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "5px 9px", borderRadius: 7, border: `1px solid ${BUI.border}`, background: BUI.surface2, color: BUI.text, fontSize: 10.5, fontWeight: 800, cursor: "pointer", fontFamily: "inherit" }}
            >
              <RotateCcw style={{ width: 11, height: 11 }} /> {tr("studioBoard.videoUpload.retry")}
            </button>}
            <button
              type="button"
              data-testid={`video-upload-dismiss-${item.id}`}
              onClick={() => onDismiss(item.id)}
              style={{ padding: "5px 9px", borderRadius: 7, border: `1px solid ${BUI.border}`, background: "transparent", color: BUI.textSec, fontSize: 10.5, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}
            >
              {tr("studioBoard.videoUpload.dismiss")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
