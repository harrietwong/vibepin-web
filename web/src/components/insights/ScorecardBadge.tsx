"use client";

/**
 * The Scorecard badge on a published Plan card, and the panel it opens.
 *
 * Why it lives here and not in the Plan components: Plan is about what you are going
 * to publish, and every line of it is written from that side. A scorecard is the
 * opposite direction — what happened to something you already published — so it
 * arrives as one self-contained badge that Plan renders and otherwise knows nothing
 * about. Plan passes a draft; everything else (does a report exist, what does it say,
 * what happens when it is opened) stays inside this file.
 *
 * One request for the whole board. Every card mounts this component, and a fetch per
 * card would be sixty requests for one page; the SWR key is constant, so SWR
 * deduplicates them into a single list call whose result every badge reads. Cards
 * with no report render nothing at all — not a disabled chip, not a placeholder.
 *
 * Opening the panel is what marks the report viewed (the detail endpoint does it, and
 * only on the first read), which is also the moment the row becomes immutable. That
 * is why the badge fetches the body on OPEN and not with the list: rendering a badge
 * is not reading a report, and freezing sixty reports because a page rendered would
 * make `viewed_at` mean nothing.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Award, Sparkles, X } from "lucide-react";
import useSWR from "swr";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import { buildPrefillFromInsight, openCreatePins } from "@/lib/createPinsPrefill";
import * as pinDraftStore from "@/lib/pinDraftStore";
import { readStoredTarget } from "@/lib/studio/publishTarget";
import type { Evidence } from "@/lib/insights/evidence";
import type { I18nText, RecommendationVariable } from "@/lib/insights/recommendations";
import type {
  InsightReportDetail,
  InsightReportSummary,
  ScorecardReportContent,
} from "@/lib/insights/reportTypes";
import type { CSSProperties } from "react";

type Translate = (key: string) => string;

const LIST_URL = "/api/insights/reports?kind=scorecard_t7";

function fill(template: string, values: Record<string, string | number> | undefined): string {
  if (!values) return template;
  return Object.entries(values).reduce(
    (text, [key, value]) => text.replace(new RegExp(`\\{${key}\\}`, "g"), String(value)),
    template,
  );
}

function renderText(text: I18nText | undefined, tr: Translate): string {
  if (!text) return "";
  return fill(tr(text.key), text.params);
}

async function getJson<T>(url: string): Promise<T | null> {
  const response = await fetch(url, { cache: "no-store", credentials: "same-origin" });
  // 401 (signed out) and 403 (free plan) are ordinary answers here, not failures:
  // the badge simply does not exist for that reader.
  if (!response.ok) return null;
  return response.json() as Promise<T>;
}

type ListResponse = { reports?: InsightReportSummary[]; locked?: true };

/**
 * Pin id → report id, for every current T+7 scorecard this user owns.
 *
 * A free plan gets `locked` and an empty list, so the map is empty and no badge is
 * rendered anywhere — the paywall is one server decision, not a check repeated on
 * every card.
 */
export function useScorecardsByPin(): Map<string, string> {
  const { data } = useSWR<ListResponse | null>(LIST_URL, getJson, {
    revalidateOnFocus: false,
    shouldRetryOnError: false,
    dedupingInterval: 60_000,
  });
  return useMemo(() => {
    const map = new Map<string, string>();
    for (const report of data?.reports ?? []) {
      if (report.subjectContentId) map.set(report.subjectContentId, report.id);
    }
    return map;
  }, [data]);
}

function MetricCell({ label, value }: { label: string; value: number | null }) {
  return (
    <div style={{ minWidth: 74 }}>
      <div style={{ fontSize: 10, color: "var(--app-text-muted)", fontWeight: 700, letterSpacing: ".02em" }}>
        {label}
      </div>
      <div style={{ fontSize: 18, fontWeight: 800, color: "var(--app-text)" }}>
        {value === null ? "—" : value.toLocaleString()}
      </div>
    </div>
  );
}

/**
 * A scorecard has no Keep / Change / Test — that shape belongs to the weekly reading,
 * and freezing a second one per Pin would double the surface a translator can drift.
 * So the button synthesises one from what the scorecard DOES carry, and the mapping
 * below is the whole of that synthesis: the flag that fired on this Pin names the
 * variable to change, exactly as it does in the weekly templates (F1 keyword, F2 cta,
 * F3 link). A Pin with no flag still gets a button — its variable is the first image,
 * the one thing every Pin has and every regeneration changes.
 */
const FLAG_VARIABLE: Partial<Record<Evidence["kind"], RecommendationVariable>> = {
  F1: "keyword",
  F2: "cta",
  F3: "link",
};

function scorecardVariable(flags: Evidence[] | undefined): RecommendationVariable {
  for (const flag of flags ?? []) {
    const mapped = FLAG_VARIABLE[flag.kind];
    if (mapped) return mapped;
  }
  return "first_image";
}

/**
 * "Generate based on this insight", on one Pin.
 *
 * WHERE a follow-up publishes comes from the REPORT, not the browser. The report row
 * records the connection it was generated for, so the account is known on any device.
 * The local draft is consulted only for the extras it alone has — the source image and
 * the board the Pin actually went to — and its target wins when present, because a
 * draft that recorded its own account is the more specific fact.
 *
 * Keying this on the local draft (as it first did) meant a cleared cache, a second
 * device, or a pruned store hid the button while the server still had the scorecard.
 * The button now disappears only when the report itself names no account, which is the
 * one case where offering it would mean guessing a profile to publish to.
 */
function GenerateFromScorecard(
  { content, reportConnectionId, tr }:
  { content: ScorecardReportContent; reportConnectionId: string | null; tr: Translate },
) {
  const draftId = content.subject.draftId;
  const draft = draftId ? pinDraftStore.getDraft(draftId) : null;
  const connectionId = readStoredTarget(draft) || reportConnectionId || "";
  if (!connectionId) return null;

  const variable = scorecardVariable(content.flags);
  const onClick = () => {
    openCreatePins(url => { window.location.href = url; }, buildPrefillFromInsight({
      connectionId,
      recommendation: {
        keep: renderText(content.accountHeadline, tr),
        change: {
          variable: tr(`insights.diagnosisPanel.variable.${variable}`),
          phrasing: renderText(content.line, tr),
        },
        test: tr("insights.scorecard.generateTest"),
      },
      sourcePin: {
        imageUrl: draft?.imageUrl,
        title: content.subject.title ?? draft?.title,
        pinId: content.subject.contentId,
        draftId: draftId ?? undefined,
        boardId: draft?.boardId,
        boardName: draft?.boardName,
      },
    }));
  };

  return (
    <button
      type="button"
      data-testid="scorecard-generate-from-insight"
      onClick={onClick}
      style={{
        display: "inline-flex", alignItems: "center", gap: 6,
        marginBottom: 14, padding: "6px 10px", borderRadius: 7,
        border: "1px solid var(--app-border)", background: "rgba(124,58,237,.16)",
        color: "var(--app-text)", fontSize: 12, fontWeight: 700, cursor: "pointer",
      }}
    >
      <Sparkles size={12} aria-hidden />
      {tr("insights.diagnosisPanel.generate")}
    </button>
  );
}

function ScorecardModal({ reportId, onClose, tr }: { reportId: string; onClose: () => void; tr: Translate }) {
  const [detail, setDetail] = useState<InsightReportDetail | null>(null);
  const [failed, setFailed] = useState(false);
  const [helpful, setHelpful] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    getJson<{ report: InsightReportDetail }>(`/api/insights/reports/${encodeURIComponent(reportId)}`)
      .then(body => {
        if (cancelled) return;
        if (!body?.report) { setFailed(true); return; }
        setDetail(body.report);
        setHelpful(body.report.helpful);
      })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [reportId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const sendFeedback = useCallback((value: boolean) => {
    setHelpful(value);
    fetch(`/api/insights/reports/${encodeURIComponent(reportId)}/feedback`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ helpful: value }),
    }).catch(() => {
      // A thumb that did not reach the server is not worth a dialog. The next one
      // overwrites it anyway.
    });
  }, [reportId]);

  const content = detail?.snapshot.content as ScorecardReportContent | undefined;
  const isT30 = detail?.kind === "scorecard_t30";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={tr(isT30 ? "insights.scorecard.title30" : "insights.scorecard.title7")}
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, zIndex: 1200,
        background: "rgba(0,0,0,.55)", display: "flex",
        alignItems: "center", justifyContent: "center", padding: 16,
      }}
    >
      <div
        onClick={event => event.stopPropagation()}
        style={{
          width: "min(520px, 100%)", maxHeight: "80vh", overflowY: "auto",
          background: "var(--app-surface, #111827)", border: "1px solid var(--app-border)",
          borderRadius: 12, padding: 18,
        }}
      >
        <header style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
          <Award size={16} aria-hidden />
          <strong style={{ fontSize: 14 }}>
            {tr(isT30 ? "insights.scorecard.title30" : "insights.scorecard.title7")}
          </strong>
          {content ? (
            <span style={{ fontSize: 11, color: "var(--app-text-muted)" }}>
              {fill(tr("insights.scorecard.age"), { days: content.subject.ageDays })}
            </span>
          ) : null}
          <button
            type="button"
            onClick={onClose}
            aria-label={tr("insights.scorecard.close")}
            style={{
              marginLeft: "auto", background: "none", border: "none",
              color: "var(--app-text-muted)", cursor: "pointer", padding: 2,
            }}
          >
            <X size={16} />
          </button>
        </header>

        {failed ? (
          <p style={{ fontSize: 12, color: "var(--app-text-muted)" }}>{tr("insights.state.loadFailedBody")}</p>
        ) : !content ? (
          <p style={{ fontSize: 12, color: "var(--app-text-muted)" }}>{tr("insights.scorecard.loading")}</p>
        ) : (
          <>
            {content.subject.title ? (
              <p style={{ fontSize: 13, fontWeight: 700, margin: "0 0 10px" }}>{content.subject.title}</p>
            ) : null}

            <div style={{ display: "flex", gap: 16, marginBottom: 12, flexWrap: "wrap" }}>
              <MetricCell label={tr("insights.metric.seen")} value={content.metrics.impressions} />
              <MetricCell label={tr("insights.metric.saved")} value={content.metrics.saves} />
              <MetricCell label={tr("insights.metric.wentToWebsite")} value={content.metrics.outboundClicks} />
            </div>

            <p style={{ fontSize: 13, lineHeight: 1.5, margin: "0 0 10px" }}>{renderText(content.line, tr)}</p>
            <p style={{ fontSize: 12, color: "var(--app-text-sec)", margin: "0 0 10px" }}>
              {renderText(content.accountHeadline, tr)}
            </p>
            <p style={{ fontSize: 11, color: "var(--app-text-muted)", margin: "0 0 14px" }}>
              {renderText(content.sampleCaveat, tr)}
            </p>

            <GenerateFromScorecard content={content} reportConnectionId={detail?.connectionId ?? null} tr={tr} />

            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 11, color: "var(--app-text-muted)" }}>
                {helpful === null ? tr("insights.thisWeek.helpfulQuestion") : tr("insights.thisWeek.thanks")}
              </span>
              <button
                type="button"
                onClick={() => sendFeedback(true)}
                aria-pressed={helpful === true}
                aria-label={tr("insights.thisWeek.helpfulYes")}
                style={thumbStyle(helpful === true)}
              >
                {"\u{1F44D}"}
              </button>
              <button
                type="button"
                onClick={() => sendFeedback(false)}
                aria-pressed={helpful === false}
                aria-label={tr("insights.thisWeek.helpfulNo")}
                style={thumbStyle(helpful === false)}
              >
                {"\u{1F44E}"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function thumbStyle(active: boolean): CSSProperties {
  return {
    border: `1px solid ${active ? "var(--app-accent, #7c3aed)" : "var(--app-border)"}`,
    background: active ? "rgba(124,58,237,.16)" : "transparent",
    borderRadius: 6,
    cursor: "pointer",
    fontSize: 12,
    lineHeight: 1,
    padding: "3px 6px",
  };
}

/**
 * The badge itself. Renders nothing unless this Pin has a current scorecard, which
 * is the only state most cards will ever be in.
 */
export function ScorecardBadge({
  remotePinId,
  style,
}: {
  remotePinId: string | null | undefined;
  style?: CSSProperties;
}) {
  const { t } = useLocale();
  const tr = t as unknown as Translate;
  const byPin = useScorecardsByPin();
  const [open, setOpen] = useState(false);

  const reportId = remotePinId ? byPin.get(remotePinId) ?? null : null;
  if (!reportId) return null;

  return (
    <>
      <button
        type="button"
        data-testid="plan-card-scorecard"
        title={tr("insights.scorecard.badge")}
        aria-label={tr("insights.scorecard.openLabel")}
        onClick={event => { event.stopPropagation(); event.preventDefault(); setOpen(true); }}
        style={{
          display: "inline-flex", alignItems: "center", gap: 3,
          padding: "1px 5px 1px 4px", borderRadius: 5, border: "none",
          background: "rgba(15,23,42,.72)", color: "#fff",
          fontSize: 9, fontWeight: 800, lineHeight: 1.5, cursor: "pointer",
          ...style,
        }}
      >
        <Award size={9} strokeWidth={3} aria-hidden />
        {tr("insights.scorecard.badge")}
      </button>
      {open ? <ScorecardModal reportId={reportId} onClose={() => setOpen(false)} tr={tr} /> : null}
    </>
  );
}
