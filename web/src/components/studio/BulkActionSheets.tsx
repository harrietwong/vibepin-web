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

import { useState } from "react";
import { X, AlertTriangle, Check, Loader2, Trash2, Sparkles } from "lucide-react";
import { PinConfirmList } from "@/components/studio/PinConfirmList";
import { canSubmitConfirmList, remainingIds, type ConfirmListItem } from "@/lib/studio/pinConfirmList";
import { BUI } from "@/components/studio/boardUI";
import type {
  BulkPublishPartition,
  BulkPublishSummary,
  DeleteImpact,
} from "@/lib/studio/bulkActions";
import type { PublishBlocker } from "@/lib/studio/publishContent";
import type { PublishConfirmationSnapshot } from "@/lib/studio/publishConfirmation";
import { platformName } from "@/lib/social/platforms";
import type { MessageKey } from "@/lib/i18n/messages/en";
import type {
  BulkCopyItem,
  BulkCopyPreflight,
  BulkCopySummary,
  CopyField,
  QuotaPreflight,
} from "@/lib/studio/bulkGenerateCopy";

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
  // Never produced by the current platform checks (every platform accepts one image),
  // but part of the media vocabulary — mapped so a caller that starts producing it
  // gets a sentence rather than a raw code.
  too_few: "studioBoard.blocker.too_few",
  too_many: "studioBoard.blocker.too_many",
  aspect_mismatch: "studioBoard.blocker.aspect_mismatch",
  mixed_media: "studioBoard.blocker.aspect_mismatch",
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
  confirmations: Record<string, PublishConfirmationSnapshot>;
  /** null = still on the confirm step; set = running; summary = done. */
  progress: { current: number; total: number } | null;
  summary: BulkPublishSummary | null;
  onConfirm: () => void;
  onClose: () => void;
  /**
   * Per-Pin confirmation list rows for the ready set (ruling 4): thumbnail, title,
   * link, destinations, AI-unedited badge. The host submits only
   * `selectConfirmedTargets(ready, excluded)`.
   */
  confirmItems?: ConfirmListItem[];
  excluded?: ReadonlySet<string>;
  onToggleExclude?: (id: string) => void;
};

export function BulkPublishSheet({ tr, partition, confirmations, progress, summary, onConfirm, onClose, confirmItems, excluded, onToggleExclude }: BulkPublishSheetProps) {
  const [reachedEnd, setReachedEnd] = useState(false);
  const removed = excluded ?? new Set<string>();
  const readyIds = partition.ready.map(item => item.id);
  const readyCount = remainingIds(readyIds, removed).length;
  const canSubmit = canSubmitConfirmList(readyIds, removed, reachedEnd || !confirmItems);
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

            {partition.ready.length > 0 && confirmItems && (
              <div data-testid="bulk-publish-exact-destinations">
                <h3 style={sectionHeading}>{fill(tr("publishConfirm.list.heading"), { n: partition.ready.length })}</h3>
                <p style={{ margin: "2px 0 8px", fontSize: 11.5, color: BUI.textSec }}>{tr("publishConfirm.list.hint")}</p>
                <PinConfirmList items={confirmItems} excluded={removed} onToggleExclude={onToggleExclude}
                  onReachedEnd={() => setReachedEnd(true)} ui={{ text: BUI.text, textSec: BUI.textSec, border: BUI.border }} />
                {readyIds.length > 0 && readyCount === 0 && (
                  <p data-testid="bulk-publish-none-left" style={{ margin: "8px 0 0", fontSize: 11.5, color: "#b45309" }}>{tr("publishConfirm.list.noneLeft")}</p>
                )}
                {!reachedEnd && readyCount > 0 && (
                  <p data-testid="bulk-publish-scroll-hint" style={{ margin: "8px 0 0", fontSize: 11.5, color: BUI.textSec }}>{tr("publishConfirm.list.scrollToConfirm")}</p>
                )}
              </div>
            )}
            {partition.ready.length > 0 && !confirmItems && (
              <div data-testid="bulk-publish-exact-destinations">
                <h3 style={sectionHeading}>{tr("publishConfirm.destinations")}</h3>
                {partition.ready.map(item => {
                  const snapshot = confirmations[item.id];
                  return <div key={item.id} style={listRow}>
                    <span style={{ minWidth: 0 }}><strong style={{ fontWeight: 750 }}>{item.title}</strong>
                      {(snapshot?.publishableDestinations ?? []).map(destination => <span key={destination.id} style={{ display: "block", color: BUI.textSec, fontSize: 11.5, overflowWrap: "anywhere" }}>
                        {platformName(destination.provider)} · {destination.accountLabel || destination.socialConnectionId}{destination.provider === "pinterest" ? ` · ${destination.boardName || destination.boardId}` : ""}
                      </span>)}
                    </span>
                  </div>;
                })}
              </div>
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
                disabled={running || !canSubmit}
                style={{ ...primaryBtn, opacity: running || !canSubmit ? 0.55 : 1, cursor: running || !canSubmit ? "not-allowed" : "pointer" }}>
                {running && progress
                  ? <><Loader2 style={{ width: 13, height: 13 }} className="animate-spin" />
                      {fill(tr("studioBoard.bulkPublish.publishing"), { current: progress.current, total: progress.total })}</>
                  : confirmItems ? fill(tr("publishConfirm.list.publishConfirm"), { n: readyCount }) : tr("studioBoard.bulkPublish.confirm")}
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

// ── Generate copy (T4b: Studio bulk bar entry) ──────────────────────────────────
// Same dumb-panel contract as the two sheets above: every decision (who is ready,
// who is skipped and why, quota math, per-card progress) is made by
// lib/studio/bulkGenerateCopy + bulkCopyDrafts and handed in as data. This component
// only renders it and reports button presses — it never calls the AI Copy client or
// the orchestrator itself (design §4, T4).

const COPY_FIELD_LABEL: Record<CopyField, "title" | "description" | "altText"> = {
  title: "title", description: "description", altText: "altText",
};

export type BulkGenerateCopySheetProps = {
  tr: Translate;
  /** Selection frozen at open time (design: a running batch must not see cards added mid-run). */
  total: number;
  preflight: BulkCopyPreflight;
  quota: QuotaPreflight | null;
  items: Record<string, BulkCopyItem>;
  /** null = still on the start step; set = running or finished. */
  progress: { done: number; total: number } | null;
  summary: BulkCopySummary | null;
  replaceTouched: boolean;
  /** The user just checked "replace text I wrote" — asking for the second confirmation. */
  replacePending: boolean;
  onRequestReplace: () => void;
  onConfirmReplace: () => void;
  onCancelReplace: () => void;
  onStart: () => void;
  onStop: () => void;
  onRetryFailed: () => void;
  onClose: () => void;
  /** Focus returns here on close (0918 PRD NFR: focus never gets lost behind a dismissed sheet). */
  triggerRef?: React.RefObject<HTMLElement | null>;
};

function quotaLine(tr: Translate, quota: QuotaPreflight | null): string | null {
  if (!quota || quota.needed <= 0) return null;
  if (quota.kind === "unknown") return fill(tr("studioBoard.bulkCopy.quotaUnknown"), { n: quota.needed });
  if (quota.kind === "unlimited") return fill(tr("studioBoard.bulkCopy.quotaUnlimited"), { n: quota.needed });
  if (quota.kind === "enough") return fill(tr("studioBoard.bulkCopy.quotaEnough"), { n: quota.needed, remaining: quota.remaining });
  return fill(tr("studioBoard.bulkCopy.quotaShort"), { n: quota.needed, remaining: quota.remaining });
}

export function BulkGenerateCopySheet({
  tr, total, preflight, quota, items, progress, summary, replaceTouched, replacePending,
  onRequestReplace, onConfirmReplace, onCancelReplace, onStart, onStop, onRetryFailed, onClose, triggerRef,
}: BulkGenerateCopySheetProps) {
  const running = !!progress && !summary;
  const failedCount = summary ? summary.items.filter(item => item.status === "failed").length : 0;

  const handleClose = () => {
    if (running) return;
    onClose();
    // Minimal keyboard-accessible focus return (0918 PRD NFR): the trigger button is
    // still in the DOM (the bulk bar does not unmount on close), so give it focus back
    // on the next frame rather than leaving focus on a node the sheet just removed.
    if (triggerRef?.current) requestAnimationFrame(() => triggerRef.current?.focus());
  };

  return (
    <div style={overlay} role="dialog" aria-modal="true" aria-labelledby="bulk-copy-title" data-testid="bulk-copy-sheet"
      onKeyDown={e => { if (e.key === "Escape" && !running) handleClose(); }}>
      <div style={panel}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
          <h2 id="bulk-copy-title" style={{ margin: 0, fontSize: 17, color: BUI.text }}>
            {summary ? tr("studioBoard.bulkCopy.title").replace("{n}", String(total)) : fill(tr("studioBoard.bulkCopy.title"), { n: total })}
          </h2>
          {!running && (
            <button type="button" aria-label={tr("studioBoard.bulkCopy.close")} onClick={handleClose}
              style={{ border: "none", background: "transparent", color: BUI.textSec, cursor: "pointer", padding: 10, minWidth: 44, minHeight: 44 }}>
              <X style={{ width: 17, height: 17 }} />
            </button>
          )}
        </div>

        {!summary && <p style={{ margin: "8px 0 0", fontSize: 12.5, color: BUI.textSec }}>{tr("studioBoard.bulkCopy.intro")}</p>}

        {!summary && (
          <div data-testid="bulk-copy-groups" style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 4 }}>
            {preflight.ready.length > 0 && (
              <p data-testid="bulk-copy-group-ready" style={{ margin: 0, fontSize: 12.5, color: BUI.text }}>
                {fill(tr("studioBoard.bulkCopy.groupReady"), { n: preflight.ready.length })}
              </p>
            )}
            {preflight.needsProductName.length > 0 && (
              <p data-testid="bulk-copy-group-needs-product-name" style={{ margin: 0, fontSize: 12.5, color: "#b45309" }}>
                {fill(tr("studioBoard.bulkCopy.groupNeedsProductName"), { n: preflight.needsProductName.length })}
              </p>
            )}
            {preflight.generating.length > 0 && (
              <p data-testid="bulk-copy-group-generating" style={{ margin: 0, fontSize: 12.5, color: BUI.textSec }}>
                {fill(tr("studioBoard.bulkCopy.groupGenerating"), { n: preflight.generating.length })}
              </p>
            )}
            {preflight.alreadyCopyComplete.length > 0 && (
              <p data-testid="bulk-copy-group-complete" style={{ margin: 0, fontSize: 12.5, color: BUI.textSec }}>
                {fill(tr("studioBoard.bulkCopy.groupComplete"), { n: preflight.alreadyCopyComplete.length })}
              </p>
            )}
          </div>
        )}

        {!summary && quotaLine(tr, quota) && (
          <p data-testid="bulk-copy-quota" style={{ margin: "10px 0 0", fontSize: 12, color: BUI.textSec }}>{quotaLine(tr, quota)}</p>
        )}

        {/* Default: keep the user's own text. Replacing it is a separate, explicit,
            second-confirmed choice (design §4.2 / 0918 §2.5 rule 5). */}
        {!summary && !running && (
          <div style={{ marginTop: 14 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 44, fontSize: 12.5, color: BUI.text, cursor: "pointer" }}>
              <input type="checkbox" data-testid="bulk-copy-replace-toggle" checked={replaceTouched}
                style={{ width: 16, height: 16 }}
                onChange={e => { if (e.target.checked) onRequestReplace(); else onCancelReplace(); }} />
              {tr("studioBoard.bulkCopy.replaceToggle")}
            </label>
            {replacePending && (
              <div data-testid="bulk-copy-replace-confirm" style={{ marginTop: 8, padding: 10, borderRadius: 8, border: `1px solid ${BUI.border}`, background: BUI.surface2 }}>
                <p style={{ margin: 0, fontSize: 12, color: BUI.text, fontWeight: 700 }}>{tr("studioBoard.bulkCopy.replaceConfirmTitle")}</p>
                <p style={{ margin: "4px 0 0", fontSize: 12, color: BUI.textSec }}>{tr("studioBoard.bulkCopy.replaceConfirmBody")}</p>
                <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                  <button type="button" data-testid="bulk-copy-replace-cancel" onClick={onCancelReplace}
                    style={{ ...quietBtn, minHeight: 44 }}>{tr("studioBoard.bulk.cancel")}</button>
                  <button type="button" data-testid="bulk-copy-replace-confirm-action" onClick={onConfirmReplace}
                    style={{ ...dangerBtn, minHeight: 44 }}>{tr("studioBoard.bulkCopy.replaceConfirm")}</button>
                </div>
              </div>
            )}
          </div>
        )}

        {running && progress && (
          <p data-testid="bulk-copy-progress" style={{ margin: "12px 0 0", fontSize: 12.5, color: BUI.text, display: "flex", alignItems: "center", gap: 6 }}>
            <Loader2 style={{ width: 13, height: 13 }} className="animate-spin" />
            {fill(tr("studioBoard.bulkCopy.progress"), { done: progress.done, total: progress.total })}
          </p>
        )}

        {(running || summary) && (
          <div data-testid="bulk-copy-rows" style={{ marginTop: 14, maxHeight: 260, overflowY: "auto" }}>
            {preflight.ready.map(card => {
              const item = items[card.id];
              if (!item) return null;
              return (
                <div key={card.id} style={listRow} data-testid={`bulk-copy-row-${item.status}`}>
                  <span style={{ minWidth: 0, flex: 1 }}>
                    {item.status === "failed"
                      ? <AlertTriangle style={{ width: 13, height: 13, color: "#dc2626", flexShrink: 0, marginTop: 2 }} />
                      : item.status === "succeeded"
                        ? <Check style={{ width: 13, height: 13, color: "#16a34a", flexShrink: 0, marginTop: 2 }} />
                        : item.status === "running"
                          ? <Loader2 style={{ width: 13, height: 13, flexShrink: 0, marginTop: 2 }} className="animate-spin" />
                          : null}
                    <span style={{ display: "inline-block", marginLeft: 6, fontSize: 12.5, color: BUI.text }}>{card.title || tr("studioBoard.bulk.untitled")}</span>
                    <span style={{ display: "block", marginTop: 2, fontSize: 12, color: item.status === "failed" ? "#dc2626" : BUI.textSec }}>
                      {tr(`studioBoard.bulkCopy.status.${item.status}` as MessageKey)}
                      {item.status === "failed" && item.reason ? ` · ${item.reason}` : ""}
                      {item.status !== "failed" && item.status !== "succeeded" && item.reason
                        ? ` · ${tr(`studioBoard.bulkCopy.reason.${item.reason}` as MessageKey)}` : ""}
                    </span>
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {summary && (
          <div data-testid="bulk-copy-summary" style={{ marginTop: 14 }}>
            <p style={{ margin: 0, fontSize: 12.5, color: BUI.text }}>
              {fill(tr("studioBoard.bulkCopy.summary"), {
                succeeded: summary.succeeded, failed: summary.failed,
                skipped: summary.skipped + preflight.needsProductName.length + preflight.generating.length + preflight.alreadyCopyComplete.length,
                notStarted: summary.notStarted,
              })}
            </p>
            {(Object.keys(COPY_FIELD_LABEL) as CopyField[]).some(field => summary.keptByField[field] > 0) && (
              <p data-testid="bulk-copy-kept-fields" style={{ margin: "4px 0 0", fontSize: 12, color: BUI.textSec }}>
                {fill(tr("studioBoard.bulkCopy.keptFields"), {
                  title: summary.keptByField.title, description: summary.keptByField.description, altText: summary.keptByField.altText,
                })}
              </p>
            )}
            {summary.stoppedBy === "text_limit" && (
              <p data-testid="bulk-copy-stopped-text-limit" style={{ margin: "8px 0 0", fontSize: 12, color: "#b45309" }}>{tr("studioBoard.bulkCopy.stoppedTextLimit")}</p>
            )}
            {summary.stoppedBy === "rate_limited" && (
              <p data-testid="bulk-copy-stopped-rate-limited" style={{ margin: "8px 0 0", fontSize: 12, color: "#b45309" }}>{tr("studioBoard.bulkCopy.stoppedRateLimited")}</p>
            )}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 20 }}>
          {summary ? (
            <>
              {failedCount > 0 && (
                <button type="button" data-testid="bulk-copy-retry-failed" onClick={onRetryFailed} style={{ ...quietBtn, minHeight: 44 }}>
                  {tr("studioBoard.bulkCopy.retryFailed")}
                </button>
              )}
              <button type="button" data-testid="bulk-copy-done" onClick={handleClose} style={{ ...primaryBtn, minHeight: 44 }}>
                {tr("studioBoard.bulkCopy.close")}
              </button>
            </>
          ) : running ? (
            <button type="button" data-testid="bulk-copy-stop" onClick={onStop} style={{ ...quietBtn, minHeight: 44 }}>
              {tr("studioBoard.bulkCopy.stop")}
            </button>
          ) : (
            <>
              <button type="button" data-testid="bulk-copy-cancel" onClick={handleClose} style={{ ...quietBtn, minHeight: 44 }}>
                {tr("studioBoard.bulk.cancel")}
              </button>
              <button type="button" data-testid="bulk-copy-start" onClick={onStart} disabled={preflight.ready.length === 0 || replacePending}
                style={{ ...primaryBtn, minHeight: 44, opacity: preflight.ready.length === 0 || replacePending ? 0.55 : 1, cursor: preflight.ready.length === 0 || replacePending ? "not-allowed" : "pointer" }}>
                <Sparkles style={{ width: 13, height: 13 }} /> {fill(tr("studioBoard.bulkCopy.start"), { n: preflight.ready.length })}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
