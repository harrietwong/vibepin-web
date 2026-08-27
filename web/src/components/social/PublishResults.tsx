"use client";

/**
 * Per-destination publish results (PRD 0809 §5/§6).
 *
 * Replaces the single Pinterest-shaped "Published successfully" + one global "View Pin".
 * Each destination states its own account, its own status, and gets its own view action —
 * and only when that platform really returned a permalink.
 *
 * Every row used to render a green check + "Published" REGARDLESS of `row.status`, so a
 * multi-platform publish where Instagram failed reported all-green: the merchant was told
 * a post existed that never did. Status is now the only thing that decides the icon, the
 * wording and the colour — and the panel's own tint follows the worst row, because a
 * failed line inside a success-green box is the same lie one level up.
 *
 * The reason on a failed row is ALWAYS the customer-safe sentence from
 * publishErrorDisplay. `errorMessage` holds the RAW upstream text (Pinterest API
 * internals, ids) and must never reach the DOM — same contract the card obeys in
 * PinBoardCard.renderResultRow.
 */

import { AlertTriangle, CheckCircle2, Clock, ExternalLink, Loader2 } from "lucide-react";
import { PlatformIcon } from "@/components/social/PlatformIcon";
import { platformName } from "@/lib/social/platforms";
import { canViewExternally, type PublishResultRow } from "@/lib/studio/publishResults";
import { getPublishErrorDisplayKey } from "@/lib/studio/publishErrorDisplay";
import { useLocale } from "@/lib/i18n/LocaleProvider";

const UI = {
  text: "var(--app-text, #E2E8F0)",
  textSec: "var(--app-text-sec, #8892A4)",
  border: "var(--app-border, rgba(255,255,255,0.10))",
  success: "#10B981",
  warning: "#D97706",
};

/**
 * Icon + label key + colour per status. Colour is never the only carrier of meaning:
 * each state also has its own icon AND its own words, so it survives a colour-blind
 * reader, a greyscale screenshot and a screen reader.
 */
function statusPresentation(status: PublishResultRow["status"]) {
  switch (status) {
    case "published":
      return { Icon: CheckCircle2, labelKey: "publishResults.published" as const, color: UI.success, spin: false };
    case "failed":
      return { Icon: AlertTriangle, labelKey: "publishResults.failed" as const, color: UI.warning, spin: false };
    case "publishing":
      return { Icon: Loader2, labelKey: "publishResults.publishing" as const, color: UI.textSec, spin: true };
    default:
      return { Icon: Clock, labelKey: "publishResults.pending" as const, color: UI.textSec, spin: false };
  }
}

export function PublishResults({ rows }: { rows: PublishResultRow[] }) {
  const { t } = useLocale();
  if (!rows.length) return null;

  // Green states "this all worked". It is earned only when every destination published.
  const allPublished = rows.every(row => row.status === "published");

  return (
    <div
      data-testid="publish-results"
      data-all-published={allPublished ? "true" : "false"}
      style={{
        border: `1px solid ${allPublished ? "rgba(16,185,129,0.30)" : UI.border}`,
        borderRadius: 10,
        background: allPublished ? "rgba(16,185,129,0.08)" : "rgba(148,163,184,0.08)",
        padding: "10px 12px",
      }}
    >
      <p style={{ margin: "0 0 8px", fontSize: 12, fontWeight: 800, color: UI.text }}>
        {t("publishResults.title")}
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {rows.map((row, index) => {
          const canView = canViewExternally(row);
          const { Icon, labelKey, color, spin } = statusPresentation(row.status);
          return (
            <div
              // A failed row has neither postId nor publishedAt, so the old key collapsed
              // every failure on a platform onto one React key.
              key={`${row.provider}-${index}`}
              data-testid={`publish-result-${row.provider}`}
              style={{ display: "flex", alignItems: "flex-start", gap: 9 }}
            >
              <PlatformIcon provider={row.provider as never} size={20} />

              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <p style={{ margin: 0, fontSize: 12, fontWeight: 750, color: UI.text }}>
                    {platformName(row.provider as never)}
                  </p>
                  <span
                    data-testid={`publish-result-${row.provider}-status`}
                    data-status={row.status}
                    style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 10.5, fontWeight: 700, color }}
                  >
                    <Icon size={11} strokeWidth={3} className={spin ? "animate-spin" : undefined} />
                    {t(labelKey)}
                  </span>
                </div>

                {/* Account and board only when we actually know them — never a placeholder. */}
                {row.accountName && (
                  <p data-testid={`publish-result-${row.provider}-account`}
                    style={{ margin: "1px 0 0", fontSize: 10.5, color: UI.textSec, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {row.accountName}
                  </p>
                )}
                {row.boardName && (
                  <p data-testid={`publish-result-${row.provider}-board`}
                    style={{ margin: "1px 0 0", fontSize: 10.5, color: UI.textSec, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {t("pinDetails.boardLabel")} {row.boardName}
                  </p>
                )}

                {/* Why it failed + where to act. Retry already exists on the card and in
                    the drawer; this row points at it rather than growing a second one. */}
                {row.status === "failed" && (
                  <p data-testid={`publish-result-${row.provider}-reason`}
                    style={{ margin: "2px 0 0", fontSize: 10.5, color: UI.textSec, lineHeight: 1.4 }}>
                    {t(getPublishErrorDisplayKey({ publishError: row.errorMessage ?? undefined, publishErrorCode: row.errorCode ?? undefined }))}
                    {" "}
                    {t("publishResults.retryHint")}
                  </p>
                )}
              </div>

              {/* A view action exists only for a destination with a real permalink. */}
              {canView && (
                <a
                  data-testid={`publish-result-${row.provider}-view`}
                  href={row.postUrl as string}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11.5, fontWeight: 700, color: UI.text, textDecoration: "none", flexShrink: 0, whiteSpace: "nowrap" }}
                >
                  {t("publishResults.viewOnPrefix")}{platformName(row.provider as never)} <ExternalLink size={12} />
                </a>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
