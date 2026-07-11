"use client";

/**
 * ManualPublishActions
 *
 * Fallback export flow for when Pinterest API is not yet approved.
 *
 * Two buttons:
 *   1. "Manual Publish" — downloads the pin image (keyword-date.jpg) AND copies
 *      a formatted Title + Description + Affiliate Link block to the clipboard.
 *      Toast: "Image downloaded & text copied. Ready to paste on Pinterest!"
 *
 *   2. "Mark as Published" — calls `onMarkPublished()` to set the DB status to
 *      'published' / 'done'.  Hidden when `onMarkPublished` is not supplied.
 *
 * Props
 * ─────
 *  imageUrl       — URL of the pin image to download (null = download disabled)
 *  keyword        — Pin title / hashtag seed
 *  description    — Caption / post body (optional)
 *  affiliateLink  — Product / store URL shown as 🔗 in copied text (optional)
 *  onMarkPublished — async fn called when the user confirms manual publish.
 *                   If omitted, the "Mark as Published" button is hidden.
 *  compact        — Show as small icon buttons (default: false = full pill buttons)
 */

import { useState } from "react";
import { Download, CheckCircle2, Loader2 } from "lucide-react";
import { toast } from "sonner";

export interface ManualPublishProps {
  imageUrl:        string | null;
  keyword:         string | null;
  description?:    string | null;
  affiliateLink?:  string | null;
  onMarkPublished?: () => Promise<void>;
  compact?:        boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function toTitleCase(str: string): string {
  return str.replace(/\b\w/g, c => c.toUpperCase());
}

function toHashtags(keyword: string): string {
  return keyword
    .split(/\s+/)
    .filter(Boolean)
    .map(w => `#${w.toLowerCase().replace(/[^a-z0-9]/g, "")}`)
    .join(" ");
}

function buildFilename(keyword: string): string {
  const date = new Date().toISOString().slice(0, 10);
  const slug = keyword
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
  return `${slug}-${date}.jpg`;
}

async function triggerDownload(imageUrl: string, keyword: string): Promise<void> {
  const filename = buildFilename(keyword);
  try {
    const response = await fetch(imageUrl, { mode: "cors" });
    const blob = await response.blob();
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(blobUrl);
  } catch {
    // CORS fallback: open in new tab so user can save manually
    window.open(imageUrl, "_blank");
  }
}

function buildClipboardText(
  keyword: string,
  description: string | null | undefined,
  affiliateLink: string | null | undefined,
): string {
  const title = toTitleCase(keyword);
  const tags  = toHashtags(keyword);

  const lines: string[] = [`✨ ${title}`, ""];

  if (description?.trim()) {
    lines.push(description.trim(), "");
  }

  if (affiliateLink?.trim()) {
    lines.push(`🔗 ${affiliateLink.trim()}`, "");
  }

  lines.push(tags);
  return lines.join("\n");
}

// ── Component ─────────────────────────────────────────────────────────────────

export function ManualPublishActions({
  imageUrl,
  keyword,
  description,
  affiliateLink,
  onMarkPublished,
  compact = false,
}: ManualPublishProps) {
  const [downloading, setDownloading] = useState(false);
  const [marking,     setMarking]     = useState(false);
  const [marked,      setMarked]      = useState(false);

  const canDownload = !!(imageUrl && keyword);

  async function handleManualPublish() {
    if (!canDownload) {
      toast.error("No image or keyword available.");
      return;
    }
    setDownloading(true);
    try {
      await triggerDownload(imageUrl!, keyword!);
      const text = buildClipboardText(keyword!, description, affiliateLink);
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        // Clipboard API unavailable — show text in toast as fallback
        toast.info("Copy this manually:", { description: text.slice(0, 120) + "…", duration: 8000 });
        return;
      }
      toast.success("Image downloaded & text copied. Ready to paste on Pinterest!", {
        duration: 5000,
      });
    } catch (err) {
      toast.error("Export failed: " + String(err));
    } finally {
      setDownloading(false);
    }
  }

  async function handleMarkPublished() {
    if (!onMarkPublished) return;
    setMarking(true);
    try {
      await onMarkPublished();
      setMarked(true);
      toast.success("Marked as published!");
    } catch (err) {
      toast.error("Failed to update status: " + String(err));
    } finally {
      setMarking(false);
    }
  }

  // Already marked — show a simple "Published" badge instead
  if (marked) {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold"
        style={{ background: "rgba(16,185,129,0.08)", color: "#10B981" }}
      >
        <CheckCircle2 className="w-2.5 h-2.5" /> Published
      </span>
    );
  }

  // ── Compact (icon-only) mode ─────────────────────────────────────────────
  if (compact) {
    return (
      <div className="flex items-center gap-0.5">
        <button
          type="button"
          onClick={handleManualPublish}
          disabled={downloading || !canDownload}
          className="rounded-full p-1.5 hover:bg-gray-100 transition-colors disabled:opacity-40"
          title="Download image & copy caption"
        >
          {downloading
            ? <Loader2 className="w-3.5 h-3.5 text-[#C026D3] animate-spin" />
            : <Download className="w-3.5 h-3.5 text-gray-400 hover:text-[#C026D3] transition-colors" />}
        </button>
        {onMarkPublished && (
          <button
            type="button"
            onClick={handleMarkPublished}
            disabled={marking}
            className="rounded-full p-1.5 hover:bg-gray-100 transition-colors disabled:opacity-40"
            title="Mark as published"
          >
            {marking
              ? <Loader2 className="w-3.5 h-3.5 text-[#10B981] animate-spin" />
              : <CheckCircle2 className="w-3.5 h-3.5 text-gray-300 hover:text-[#10B981] transition-colors" />}
          </button>
        )}
      </div>
    );
  }

  // ── Full (pill button) mode ──────────────────────────────────────────────
  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        onClick={handleManualPublish}
        disabled={downloading || !canDownload}
        className="flex items-center justify-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-bold transition-all disabled:opacity-50 hover:brightness-105 active:scale-[0.98]"
        style={{
          background: "rgba(192,38,211,0.08)",
          color:      "#C026D3",
          border:     "1px solid rgba(192,38,211,0.22)",
        }}
      >
        {downloading
          ? <Loader2 className="w-3 h-3 animate-spin" />
          : <Download className="w-3 h-3" />}
        Manual Publish
      </button>

      {onMarkPublished && (
        <button
          type="button"
          onClick={handleMarkPublished}
          disabled={marking}
          className="flex items-center justify-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-semibold text-gray-500 transition-all disabled:opacity-50 hover:bg-gray-50 active:scale-[0.98]"
          style={{ border: "1px solid #E5E7EB" }}
        >
          {marking
            ? <Loader2 className="w-3 h-3 animate-spin" />
            : <CheckCircle2 className="w-3 h-3" />}
          Mark as Published
        </button>
      )}
    </div>
  );
}
