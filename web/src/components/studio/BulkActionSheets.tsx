"use client";

/**
 * BulkActionSheets — the confirm-and-report surfaces for bulk Publish and bulk Delete
 * (PRD 0826 §19).
 *
 * These are deliberately dumb: every decision (who is ready, who is blocked and why,
 * what deletion means per lifecycle) is made by `lib/studio/bulkActions` and handed in
 * as data. The component only renders it and reports the button press. That split is
 * what lets the same partition drive the sheet AND the executor, so the sheet cannot
 * promise a publish the executor does not perform.
 *
 * No embedded forms here — PRD §19 keeps the bulk bar lightweight; field editing lives
 * in BatchEditDrawer, which the bar opens.
 */

import { X, AlertTriangle, Check, Loader2, Trash2 } from "lucide-react";
import { BUI } from "@/components/studio/boardUI";
import type {
  BulkPublishPartition,
  BulkPublishSummary,
  DeleteImpact,
} from "@/lib/studio/bulkActions";
import type { PublishBlocker } from "@/lib/studio/publishContent";
import type { MessageKey } from "@/lib/i18n/messages/en";

type Translate = (key: MessageKey) => string;

function fill(template: string, values: Record<string, string | number>): string {
  return Object.entries(values).reduce(
    (out, [k, v]) => out.split(`{${k}}`).join(String(v)),
    template,
  );
}

/** English plural suffix; other locales carry the plural inside their own string. */
function plural(n: number): string {
  return n === 1 ? "" : "s";
}

/**
 * A blocker rendered in the merchant's language.
 *
 * The code is the contract; the raw English `message` is used only when a code has no
 * key yet, so a new media rule shipping before its translation still explains itself
 * instead of showing nothing.
 */
const BLOCKER_KEYS: Record<PublishBlocker["code"], MessageKey> = {
  no_destinations: "studioBoard.blocker.no_destinations",
  missing_board: "studioBoard.blocker.missing_board",
  no_account: "studioBoard.blocker.no_account",
  no_media: "studioBoard.blocker.no_media",
  too_many: "studioBoard.blocker.too_many",
  aspect_mismatch: "studioBoard.blocker.aspect_mismatch",
};

export function blockerText(tr: Translate, blocker: PublishBlocker): string {
  const key = BLOCKER_KEYS[blocker.code];
  // An unmapped code (a media rule shipping ahead of its translation) still explains
  // itself with the rule's own English message rather than rendering nothing.
  if (!key) return blocker.message || tr("studioBoard.blocker.unknown");
  return fill(tr(key), { provider: blocker.provider ?? "" }).replace(/\s+/g, " ").trim();
}

const overlay: React.CSSProperties = {
  position: "fixed", inset: 0, zIndex: 380, background: "rgba(15,23,42,0.46)",
  display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
};
const panel: React.CSSProperties = {
  width: "min(560px, 94vw)", maxHeight: "84vh", overflowY: "auto", borderRadius: 16,
  border: `1px solid ${BUI.border}`, background: BUI.surface,
  boxShadow: "0 24px 70px rgba(15,23,42,0.28)", padding: 22,
};
const primaryBtn: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 6, padding: "9px 18px", borderRadius: 10,
  border: 0, background: BUI.gradient, color: "#fff", fontSize: 12.5, fontWeight: 800,
  cursor: "pointer", fontFamily: "inherit",
};
const quietBtn: React.CSSProperties = {
  padding: "9px 16px", borderRadius: 10, border: `1px solid ${BUI.border}`,
  background: BUI.surface, color: BUI.textSec, fontSize: 12.5, fontWeight: 750,
  cursor: "pointer", fontFamily: "inherit",
};
const dangerBtn: React.CSSProperties = {
  ...primaryBtn, background: "#dc2626",
};
const listRow: React.CSSProperties = {
  display: "flex", gap: 8, alignItems: "flex-start", padding: "7px 0",
  borderTop: `1px solid ${BUI.border}`, fontSize: 12, color: BUI.text,
};
const sectionHeading: React.CSSProperties = {
  margin: "16px 0 2px", fontSize: 11.5, fontWeight: 800, color: BUI.text,
};

// ── Publish ───────────────────────────────────────────────────────────────────

export type BulkPublishSheetProps = {
  tr: Translate;
  partition: BulkPublishPartition;
  /** null = still on the confirm step; set = running; summary = done. */
  progress: { current: number; total: number } | null;
  summary: BulkPublishSummary | null;
  onConfirm: () => void;
  onClose: () => void;
};

export function BulkPublishSheet({ tr, partition, progress, summary, onConfirm, onClose }: BulkPublishSheetProps) {
  const readyCount = partition.ready.length;
  const running = !!progress && !summary;
  const total = readyCount + partition.blocked.length + partition.alreadyPublished.length + partition.generating.length;

  return (
    <div style={overlay} role="dialog" aria-modal="true" aria-labelledby="bulk-publish-title" data-testid="bulk-publish-sheet">
      <div style={panel}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
          <h2 id="bulk-publish-title" style={{ margin: 0, fontSize: 17, color: BUI.text }}>
            {summary
              ? tr("studioBoard.bulkPublish.resultsTitle")
              : fill(tr("studioBoard.bulkPublish.title"), { n: total, plural: plural(total) })}
          </h2>
          {!running && (
            <button type="button" aria-label={tr("studioBoard.bulk.close")} onClick={onClose}
              style={{ border: "none", background: "transparent", color: BUI.textSec, cursor: "pointer", padding: 4 }}>
              <X style={{ width: 17, height: 17 }} />
            </button>
          )}
        </div>

        {summary ? (
          <BulkPublishResults tr={tr} summary={summary} />
        ) : (
          <>
            <p style={{ margin: "8px 0 0", fontSize: 12.5, color: BUI.textSec }}>
              {readyCount > 0
                ? fill(tr("studioBoard.bulkPublish.readyCount"), { n: readyCount })
                : tr("studioBoard.bulkPublish.noneReady")}
            </p>

            {/* The schedule override is stated up front: a bulk publish that silently
                jumped a merchant's scheduled slot is the surprise PRD §19 forbids. */}
            {partition.scheduledNowCount > 0 && (
              <p data-testid="bulk-publish-scheduled-notice"
                style={{ margin: "8px 0 0", fontSize: 12, color: "#b45309", display: "flex", gap: 6, alignItems: "flex-start" }}>
                <AlertTriangle style={{ width: 13, height: 13, flexShrink: 0, marginTop: 1 }} />
                {partition.scheduledNowCount === 1
                  ? tr("studioBoard.bulkPublish.scheduledNoticeOne")
                  : fill(tr("studioBoard.bulkPublish.scheduledNotice"), { n: partition.scheduledNowCount })}
              </p>
            )}

            {partition.blocked.length > 0 && (
              <div data-testid="bulk-publish-blocked">
                <h3 style={sectionHeading}>
                  {fill(tr("studioBoard.bulkPublish.blockedHeading"), { n: partition.blocked.length })}
                </h3>
                {partition.blocked.map(item => (
                  <div key={item.id} style={listRow}>
                    <AlertTriangle style={{ width: 13, height: 13, color: "#b45309", flexShrink: 0, marginTop: 2 }} />
                    <span style={{ minWidth: 0 }}>
                      <strong style={{ fontWeight: 750 }}>{item.title}</strong>
                      <span style={{ display: "block", color: BUI.textSec, fontSize: 11.5 }}>
                        {/* Every reason, not just the first — fixing one and hitting
                            Publish again only to be refused for the next is worse
                            than being told both up front. */}
                        {item.blockers.map(b => blockerText(tr, b)).join(" ")}
                      </span>
                    </span>
                  </div>
                ))}
              </div>
            )}

            {partition.alreadyPublished.length > 0 && (
              <div data-testid="bulk-publish-already">
                <h3 style={sectionHeading}>
                  {fill(tr("studioBoard.bulkPublish.alreadyPublishedHeading"), { n: partition.alreadyPublished.length })}
                </h3>
                {partition.alreadyPublished.map(item => (
                  <div key={item.id} style={listRow}><Check style={{ width: 13, height: 13, color: "#16a34a", flexShrink: 0, marginTop: 2 }} />{item.title}</div>
                ))}
              </div>
            )}

            {partition.generating.length > 0 && (
              <div data-testid="bulk-publish-generating">
                <h3 style={sectionHeading}>
                  {fill(tr("studioBoard.bulkPublish.generatingHeading"), { n: partition.generating.length })}
                </h3>
                {partition.generating.map(item => (
                  <div key={item.id} style={listRow}><Loader2 style={{ width: 13, height: 13, flexShrink: 0, marginTop: 2 }} />{item.title}</div>
                ))}
              </div>
            )}
          </>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 20 }}>
          {summary ? (
            <button type="button" data-testid="bulk-publish-done" onClick={onClose} style={primaryBtn}>
              {tr("studioBoard.bulk.close")}
            </button>
          ) : (
            <>
              <button type="button" data-testid="bulk-publish-cancel" onClick={onClose} disabled={running} style={quietBtn}>
                {tr("studioBoard.bulk.cancel")}
              </button>
              <button type="button" data-testid="bulk-publish-confirm" onClick={onConfirm}
                disabled={running || readyCount === 0}
                style={{ ...primaryBtn, opacity: running || readyCount === 0 ? 0.55 : 1, cursor: running || readyCount === 0 ? "not-allowed" : "pointer" }}>
                {running && progress
                  ? <><Loader2 style={{ width: 13, height: 13 }} className="animate-spin" />
                      {fill(tr("studioBoard.bulkPublish.publishing"), { current: progress.current, total: progress.total })}</>
                  : tr("studioBoard.bulkPublish.confirm")}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function BulkPublishResults({ tr, summary }: { tr: Translate; summary: BulkPublishSummary }) {
  const headline = summary.tone === "all_published"
    ? fill(tr("studioBoard.bulkPublish.resultAllPublished"), { n: summary.publishedCount, plural: plural(summary.publishedCount) })
    : summary.tone === "none_published"
      ? tr("studioBoard.bulkPublish.resultNonePublished")
      : fill(tr("studioBoard.bulkPublish.resultPartial"), { published: summary.publishedCount, problems: summary.problems.length });

  return (
    <div data-testid="bulk-publish-results">
      <p style={{ margin: "8px 0 0", fontSize: 12.5, color: BUI.textSec }}>{headline}</p>
      {/* Named items with their own reason. A summary that said only "2 failed" would
          leave the merchant to find which two, and guess why. */}
      {summary.rows.map(row => (
        <div key={row.id} style={listRow} data-testid={`bulk-publish-result-${row.status}`}>
          {row.status === "published"
            ? <Check style={{ width: 13, height: 13, color: "#16a34a", flexShrink: 0, marginTop: 2 }} />
            : <AlertTriangle style={{ width: 13, height: 13, color: row.status === "failed" ? "#dc2626" : "#b45309", flexShrink: 0, marginTop: 2 }} />}
          <span style={{ minWidth: 0 }}>
            <strong style={{ fontWeight: 750 }}>{row.title}</strong>
            <span style={{ display: "block", color: BUI.textSec, fontSize: 11.5 }}>
              {row.status === "published"
                ? (row.publishedProviders?.length
                    ? fill(tr("studioBoard.bulkPublish.publishedTo"), { providers: row.publishedProviders.join(", ") })
                    : tr("studioBoard.bulkPublish.statusPublished"))
                : row.message}
            </span>
          </span>
        </div>
      ))}
    </div>
  );
}

// ── Delete ────────────────────────────────────────────────────────────────────

export type BulkDeleteConfirmProps = {
  tr: Translate;
  impact: DeleteImpact;
  onConfirm: () => void;
  onClose: () => void;
};

/**
 * One dialog for bulk delete AND single-card delete.
 *
 * The single card used a bare `window.confirm("…cannot be undone")`, which is exactly
 * the wrong thing to say about a Posted Pin: the VibePin record goes, the live post on
 * Pinterest does not, and a merchant reading "cannot be undone" reasonably fears the
 * opposite. Both entry points now say what actually happens.
 */
export function BulkDeleteConfirm({ tr, impact, onConfirm, onClose }: BulkDeleteConfirmProps) {
  const lines: string[] = [];
  if (impact.draftCount > 0) {
    lines.push(fill(tr("studioBoard.bulkDelete.impactDrafts"), { n: impact.draftCount, plural: plural(impact.draftCount) }));
  }
  if (impact.scheduledCount > 0) {
    lines.push(fill(tr("studioBoard.bulkDelete.impactScheduled"), { n: impact.scheduledCount, plural: plural(impact.scheduledCount) }));
  }
  if (impact.postedCount > 0) {
    lines.push(fill(tr("studioBoard.bulkDelete.impactPosted"), { n: impact.postedCount, plural: plural(impact.postedCount) }));
  }

  return (
    <div style={overlay} role="dialog" aria-modal="true" aria-labelledby="bulk-delete-title" data-testid="bulk-delete-confirm">
      <div style={{ ...panel, width: "min(500px, 94vw)" }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
          <h2 id="bulk-delete-title" style={{ margin: 0, fontSize: 17, color: BUI.text }}>
            {impact.total === 1
              ? tr("studioBoard.bulkDelete.titleOne")
              : fill(tr("studioBoard.bulkDelete.title"), { n: impact.total })}
          </h2>
          <button type="button" aria-label={tr("studioBoard.bulk.close")} onClick={onClose}
            style={{ border: "none", background: "transparent", color: BUI.textSec, cursor: "pointer", padding: 4 }}>
            <X style={{ width: 17, height: 17 }} />
          </button>
        </div>
        <ul style={{ margin: "12px 0 0", padding: "0 0 0 18px", display: "flex", flexDirection: "column", gap: 7 }}>
          {lines.map(line => (
            <li key={line} style={{ fontSize: 12.5, color: BUI.textSec, lineHeight: 1.5 }}>{line}</li>
          ))}
        </ul>
        <p style={{ margin: "12px 0 0", fontSize: 12, color: BUI.text, fontWeight: 700 }}>
          {tr("studioBoard.bulkDelete.cannotUndo")}
        </p>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 20 }}>
          <button type="button" data-testid="bulk-delete-cancel" onClick={onClose} style={quietBtn}>
            {tr("studioBoard.bulk.cancel")}
          </button>
          <button type="button" data-testid="bulk-delete-confirm-action" onClick={onConfirm} style={dangerBtn}>
            <Trash2 style={{ width: 13, height: 13 }} /> {tr("studioBoard.bulkDelete.confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
