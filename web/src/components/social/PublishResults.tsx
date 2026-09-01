"use client";

/**
 * Per-destination publish results (PRD 0809 §5/§6).
 *
 * Replaces the single Pinterest-shaped "Published successfully" + one global "View Pin".
 * Each destination states its own account, its own status, and gets its own view action —
 * and only when that platform really returned a permalink.
 */

import { CheckCircle2, ExternalLink } from "lucide-react";
import { PlatformIcon } from "@/components/social/PlatformIcon";
import { platformName } from "@/lib/social/platforms";
import { canViewExternally, type PublishResultRow } from "@/lib/studio/publishResults";
import { useLocale } from "@/lib/i18n/LocaleProvider";

const UI = {
  text: "var(--app-text, #E2E8F0)",
  textSec: "var(--app-text-sec, #8892A4)",
  border: "var(--app-border, rgba(255,255,255,0.10))",
  success: "#10B981",
};

export function PublishResults({ rows }: { rows: PublishResultRow[] }) {
  const { t } = useLocale();
  if (!rows.length) return null;

  return (
    <div
      data-testid="publish-results"
      style={{
        border: `1px solid rgba(16,185,129,0.30)`,
        borderRadius: 10,
        background: "rgba(16,185,129,0.08)",
        padding: "10px 12px",
      }}
    >
      <p style={{ margin: "0 0 8px", fontSize: 12, fontWeight: 800, color: UI.text }}>
        {t("publishResults.title")}
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {rows.map(row => {
          const canView = canViewExternally(row);
          return (
            <div
              key={`${row.provider}-${row.postId ?? row.publishedAt ?? ""}`}
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
                    style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 10.5, fontWeight: 700, color: UI.success }}
                  >
                    <CheckCircle2 size={11} strokeWidth={3} />
                    {t("publishResults.published")}
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
