"use client";

/**
 * PinAICopyPanel — the SHARED AI Copy UI, reused across Create Pins, the Plan
 * single-pin edit modal, and (via the helper) Batch Edit. It owns the Generate /
 * Regenerate button, progressive loading states, success + error states, and the
 * "Context used" disclosure (image summary + recommended-keyword chips + board).
 *
 * It is store-agnostic: it calls generatePinterestPinCopy() and hands the result to
 * onApplyCopy(); the caller decides how to persist. Theme-aware via --app-* vars, so
 * it renders correctly in both the light Create Pins board and the dark Plan drawers.
 *
 * Keyword labeling rule: the Pinterest keyword DB is high-search only (no time series),
 * so chips are labeled "Recommended Pinterest keywords" — NEVER "Trending".
 */

import { forwardRef, useCallback, useImperativeHandle, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Sparkles, Loader2, Check, ChevronDown, ChevronUp } from "lucide-react";
import { toast } from "sonner";
import { AMAZON_PRODUCT_NAME_REQUIRED, generatePinterestPinCopy, isRateLimitError, isTextLimitReachedError } from "@/lib/ai-copy/generatePinCopy";
import { isBusyKey, runWithBusyGuard, subscribeBusyKey } from "@/lib/ai-copy/runWithBusyGuard";
import { SETTINGS_BILLING_PATH } from "@/lib/settingsPaths";
import type { AICopyV2Evidence, CopyContextBundle, PinCopyLength } from "@/lib/ai-copy/types";
import type { PinMetadataDraft } from "@/lib/pinMetadata";
import type { PinterestBoard } from "@/lib/pinterestClient";
import type { SetupSnapshot } from "@/lib/studioPersistence";
import { readResolvedContentLanguage, type LanguageCode } from "@/lib/i18n/config";
import { useLocale } from "@/lib/i18n/LocaleProvider";

/** PRD 7.3 fill-in-the-blank rule: length/language pickers are hidden from this
 *  panel (server keeps defaulting length→"standard", language→resolved content
 *  language) — this constant documents the fixed length sent from the simplified
 *  UI. Settings-level control of length/language may return later; the API
 *  contract (PinCopyLength, `language`) is untouched to support that. */
const FIXED_LENGTH: PinCopyLength = "standard";

const P = {
  surface:  "var(--app-surface, #FFFFFF)",
  surface2: "var(--app-surface-2, #F8FAFC)",
  border:   "var(--app-border, #E2E8F0)",
  text:     "var(--app-text, #0F172A)",
  textSec:  "var(--app-text-sec, #475569)",
  textMuted:"var(--app-text-muted, #94A3B8)",
  success:  "#10B981",
  error:    "#EF4444",
  gradient: "linear-gradient(135deg,#FF4D8D 0%,#D946EF 52%,#7C3AED 100%)",
} as const;

export type PinAICopyResult = {
  title: string;
  description: string;
  altText: string;
  tags: string[];
  destinationUrl: string;
  metadataDraft: PinMetadataDraft;
  context: CopyContextBundle;
  /** True when the user explicitly confirmed replacing non-empty title+description
   *  (PRD 7.3 fill-in-the-blank rule). The caller may then overwrite both fields;
   *  otherwise it should only fill fields that were empty before this run. */
  confirmedReplace: boolean;
};

export type PinAICopyPanelProps = {
  draftId: string;
  imageUrl: string;
  title: string;
  description: string;
  altText: string;
  boardId?: string;
  boardName?: string;
  imageSummary?: string;
  recommendedKeywords?: string[];
  language?: LanguageCode;
  length?: PinCopyLength;
  // Optional richer context (Create Pins carries these so metadataDraft stays accurate).
  category?: string;
  keyword?: string;
  destinationUrl?: string;
  /** The host owns an unsaved, fresher Website URL (Plan drawer): Amazon context reads it. */
  destinationUrlIsCurrent?: boolean;
  setupSnapshot?: SetupSnapshot;
  promptSnapshot?: string;
  opportunity?: string;
  boards?: PinterestBoard[];
  // Upload-time analysis status (drives the pre-generate "Analyzing image…" strip).
  analysisStatus?: "pending" | "ready" | "failed";
  keywordStatus?: "pending" | "ready" | "failed";
  /** True when copy was already generated (labels the button "Regenerate copy"). */
  hasGeneratedBefore?: boolean;
  disabled?: boolean;
  /** Compact secondary treatment for card-level AI tools. */
  compact?: boolean;
  /** Called just before a generate run — e.g. to flush pending manual edits. */
  onBeforeGenerate?: () => void;
  /** Reports the request lifetime to a host that must prevent remounting this panel. */
  onBusyChange?: (busy: boolean) => void;
  onApplyCopy: (result: PinAICopyResult) => void;
  /** Optional: the raw generate error (e.g. a 422 carrying validationReport) for host-side hints. */
  onGenerateError?: (error: unknown) => void;
  /**
   * Sibling action rendered in the SAME row as Generate copy (e.g. Create Pins'
   * "Regenerate image"). Passing it here rather than stacking a second block keeps
   * both buttons compact and on one line, wrapping only when the card is narrow.
   */
  actionsSlot?: React.ReactNode;
};

/** Imperative handle so a host (e.g. per-field regen buttons) can trigger a run. */
export type PinAICopyPanelHandle = { generate: () => void; isBusy: () => boolean };

type Stage = "idle" | "analyzing" | "generating" | "checking" | "done" | "error";

const chip: React.CSSProperties = {
  display: "inline-block", padding: "2px 8px", borderRadius: 999,
  border: `1px solid ${P.border}`, background: P.surface, fontSize: 10.5, fontWeight: 650, color: P.text,
};
const sectionLabel: React.CSSProperties = {
  fontSize: 10, fontWeight: 800, letterSpacing: 0.2, textTransform: "uppercase", color: P.textSec, marginBottom: 3,
};

export const PinAICopyPanel = forwardRef<PinAICopyPanelHandle, PinAICopyPanelProps>(function PinAICopyPanel(props, ref) {
  const { t: tr } = useLocale();
  const [stage, setStage] = useState<Stage>("idle");
  const [ctxOpen, setCtxOpen] = useState(false);
  // PRD 7.3: when both title + description already have text, confirm before the
  // AI copy overwrites them. Gates the actual generate() call, not just the apply.
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [result, setResult] = useState<{
    summary?: string; imageSummary?: string; recommendedKeywords: string[]; boardName?: string | null; aiCopyV2?: AICopyV2Evidence;
  } | null>(null);
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [generatedThisSession, setGeneratedThisSession] = useState(false);
  const busyRef = useRef(false);
  const subscribeToDraftBusy = useCallback(
    (listener: () => void) => subscribeBusyKey(props.draftId, listener),
    [props.draftId],
  );
  const readDraftBusy = useCallback(() => isBusyKey(props.draftId), [props.draftId]);
  const sharedDraftBusy = useSyncExternalStore(subscribeToDraftBusy, readDraftBusy, () => false);

  const busy = sharedDraftBusy || stage === "analyzing" || stage === "generating" || stage === "checking";
  const isRegen = props.hasGeneratedBefore || generatedThisSession || stage === "done";
  const analysisReady = props.analysisStatus === "ready";

  // Prefer freshly-returned context; fall back to the props (pre-generate display).
  const shownImageSummary = result?.imageSummary ?? props.imageSummary;
  const shownKeywords = result?.recommendedKeywords?.length ? result.recommendedKeywords : (props.recommendedKeywords ?? []);
  const shownBoard = result?.boardName ?? props.boardName;
  const hasContext = !!shownImageSummary || shownKeywords.length > 0 || !!shownBoard || !!result?.aiCopyV2;

  const progressLabel = useMemo(() => {
    if (stage === "analyzing") return analysisReady ? tr("pinForm.usingSavedImageContext") : tr("pinForm.analyzingImage");
    if (stage === "generating") return tr("pinForm.writingCopy");
    if (stage === "checking") return tr("pinForm.checkingQuality");
    if (stage === "done") return tr("pinForm.copyGenerated");
    return "";
  }, [stage, analysisReady, tr]);
  const visibleProgressLabel = progressLabel || (sharedDraftBusy ? tr("pinForm.writingCopy") : "");

  // PRD 7.3 fill-in-the-blank: both fields already have text → this run, once it
  // completes, will overwrite user-written copy. Computed from current props so the
  // confirm dialog and the applied result agree on the same snapshot.
  const willReplaceExisting = !!props.title?.trim() && !!props.description?.trim();

  const runGenerate = useCallback(async (confirmedReplace: boolean) => {
    if (props.disabled) return;
    await runWithBusyGuard(busyRef, props.onBusyChange, props.onBeforeGenerate, async () => {
      setErrorMsg("");
      try {
        const language = props.language ?? readResolvedContentLanguage();
        const res = await generatePinterestPinCopy({
          draftId: props.draftId,
          imageUrl: props.imageUrl,
          title: props.title,
          description: props.description,
          boardId: props.boardId,
          boardName: props.boardName,
          category: props.category,
          keyword: props.keyword,
          destinationUrl: props.destinationUrl,
          ...(props.destinationUrlIsCurrent ? { destinationUrlIsCurrent: true } : {}),
          setupSnapshot: props.setupSnapshot,
          promptSnapshot: props.promptSnapshot,
          opportunity: props.opportunity,
          recommendedKeywords: props.recommendedKeywords,
          boards: props.boards,
          language,
          length: FIXED_LENGTH,
          mode: isRegen ? "regenerate" : "initial",
          onStage: setStage,
        });
        props.onApplyCopy({
          title: res.fields.title,
          description: res.fields.description,
          altText: res.fields.altText,
          tags: res.tags,
          destinationUrl: res.fields.destinationUrl,
          metadataDraft: res.metadataDraft,
          context: res.context,
          confirmedReplace,
        });
        setResult({
          summary: res.context.contextSummary,
          imageSummary: res.context.imageSummary,
          recommendedKeywords: res.context.recommendedKeywords ?? [],
          boardName: res.context.boardName ?? undefined,
          aiCopyV2: res.context.aiCopyV2,
        });
        setStage("done");
        setGeneratedThisSession(true);
        toast.success(isRegen ? tr("pinForm.toastRegenerated") : tr("pinForm.toastGenerated"));
      } catch (err) {
        props.onGenerateError?.(err);
        const msg = (err as { code?: string })?.code === AMAZON_PRODUCT_NAME_REQUIRED
          ? tr("studioBoard.amazon.productNameRequired")
          : (err as Error)?.message || tr("pinForm.genericGenerateError");
        setErrorMsg(msg);
        setStage("error");
        // A 429 (per-user AI cost ceiling) is a "wait a moment", not a failure the user
        // did anything wrong to cause. Softened to the NEUTRAL toast severity, matching
        // how app/app/studio/page.tsx treats /api/generate's user_generation_limit.
        // Reuses the existing rate-limit strings (translated in all 20 locales) rather
        // than the raw server message.
        if (isTextLimitReachedError(err)) {
          // The plan's AI text allowance is spent (PRD v3.2 §6.4). Waiting does not fix
          // it, so this gets the PRD's upgrade sentence and a Billing link rather than
          // the "service busy" wording used for the 429 below. Neutral severity: the
          // user did nothing wrong. Shown ONCE per attempt, like every other branch here.
          const limitMsg = tr("studioBoard.limit.text.allUsed");
          setErrorMsg(limitMsg);
          toast.message(limitMsg, {
            action: {
              label: tr("studioBoard.limit.upgradeCta"),
              onClick: () => { window.location.href = SETTINGS_BILLING_PATH; },
            },
          });
        } else if (isRateLimitError(err)) {
          toast.message(tr("history.error.rateLimited.label"), { description: tr("studio.error.serviceBusy.body") });
        } else {
          toast.error(msg);
        }
      }
    }, props.draftId);
  }, [isRegen, props, tr]);

  // Entry point used by the button + the imperative handle. Gates on the fill-in-
  // the-blank rule: if both title and description already have text, ask first
  // instead of silently overwriting what the user wrote.
  const generate = useCallback(() => {
    if (busyRef.current || busy || props.disabled) return;
    if (willReplaceExisting) { setConfirmOpen(true); return; }
    void runGenerate(false);
  }, [busy, props.disabled, willReplaceExisting, runGenerate]);

  const confirmReplace = useCallback(() => {
    setConfirmOpen(false);
    void runGenerate(true);
  }, [runGenerate]);

  useImperativeHandle(ref, () => ({ generate, isBusy: () => busyRef.current || busy }), [generate, busy]);

  const showPreStrip = (stage === "idle") && (props.analysisStatus === "pending" || props.analysisStatus === "ready");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
      {/* Single primary action — length/language pickers removed from this surface
          (PRD WP-D). The API still accepts both; only the UI was collapsed. */}
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        {/* Content-width when a sibling action shares the row (Create Pins), full-width
            when it is the only action (other surfaces keep their existing look). */}
        <button type="button" data-testid="ai-copy-generate" onClick={generate} disabled={busy || props.disabled}
          // compact  → the borderless inline action the compact Content card uses.
          // otherwise → the gradient primary; content-width when actionsSlot shares
          //             the row (Create Pins), full-width when it is the only action.
          style={props.compact
            ? { flex: "0 0 auto", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 4, padding: "3px 5px", borderRadius: 6, border: "none", background: "transparent", color: "#7C3AED", fontSize: 10.5, fontWeight: 700, cursor: busy || props.disabled ? "default" : "pointer", opacity: props.disabled ? 0.6 : 1, fontFamily: "inherit", whiteSpace: "nowrap" }
            : { flex: props.actionsSlot ? "0 1 auto" : "1 1 160px", minHeight: 38, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6, padding: "9px 14px", borderRadius: 9, border: "none", background: P.gradient, color: "#fff", fontSize: 12, fontWeight: 800, cursor: busy || props.disabled ? "default" : "pointer", opacity: props.disabled ? 0.6 : 1, fontFamily: "inherit", whiteSpace: "nowrap" }}>
          {busy ? <Loader2 style={{ width: 13, height: 13 }} className="animate-spin" /> : <Sparkles style={{ width: 13, height: 13 }} />}
          {busy ? visibleProgressLabel : tr("pinForm.generateCopy")}
        </button>
        {props.actionsSlot}
      </div>

      {/* PRD 7.3 fill-in-the-blank confirm — only shown when both title and
          description already have text, so a click can't silently wipe them. */}
      {confirmOpen && (
        <div data-testid="ai-copy-replace-confirm" role="alertdialog" aria-modal="true"
          style={{ position: "fixed", inset: 0, zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(15,23,42,0.55)" }}>
          <div style={{ width: "min(360px, 90vw)", background: P.surface, border: `1px solid ${P.border}`, borderRadius: 14, padding: 18, boxShadow: "0 20px 50px rgba(0,0,0,0.35)" }}>
            <p style={{ margin: 0, fontSize: 14, fontWeight: 800, color: P.text }}>{tr("pinForm.replaceExistingTitle")}</p>
            <p style={{ margin: "8px 0 0", fontSize: 12, color: P.textSec, lineHeight: 1.5 }}>{tr("pinForm.replaceExistingBody")}</p>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
              <button type="button" data-testid="ai-copy-replace-cancel" onClick={() => setConfirmOpen(false)}
                style={{ padding: "8px 14px", borderRadius: 8, border: `1px solid ${P.border}`, background: "transparent", color: P.text, fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
                {tr("pinForm.cancel")}
              </button>
              <button type="button" data-testid="ai-copy-replace-confirm-btn" onClick={confirmReplace}
                style={{ padding: "8px 14px", borderRadius: 8, border: "none", background: P.gradient, color: "#fff", fontSize: 12, fontWeight: 800, cursor: "pointer", fontFamily: "inherit" }}>
                {tr("pinForm.replaceWithAiCopy")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Pre-generate analysis status (before/without an active run). */}
      {showPreStrip && (
        <div data-testid="ai-copy-analysis-status" style={{ border: `1px solid ${P.border}`, background: P.surface2, borderRadius: 10, padding: "8px 10px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
            {props.analysisStatus === "pending"
              ? <Loader2 style={{ width: 12, height: 12, color: "#7C3AED" }} className="animate-spin" />
              : <Check style={{ width: 12, height: 12, color: P.success }} />}
            <span style={{ flex: 1, fontSize: 11.5, fontWeight: 750, color: P.text }}>
              {props.analysisStatus === "pending"
                ? tr("pinForm.analyzingImage")
                : props.keywordStatus === "ready" && shownKeywords.length ? tr("pinForm.recommendedKeywordsReady") : tr("pinForm.imageAnalyzed")}
            </span>
          </div>
          {props.analysisStatus === "ready" && hasContext && (
            <ContextDisclosure open={ctxOpen} onToggle={() => setCtxOpen(o => !o)}
              imageSummary={shownImageSummary} keywords={shownKeywords} board={shownBoard} language={props.language} />
          )}
        </div>
      )}

      {/* Active / done / error panel */}
      {(busy || stage === "done" || stage === "error") && (
        <div data-testid="ai-copy-status" style={{ border: `1px solid ${stage === "error" ? `${P.error}61` : P.border}`, background: stage === "error" ? `${P.error}14` : P.surface2, borderRadius: 10, padding: "8px 10px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
            {busy && <Loader2 style={{ width: 12, height: 12, color: "#7C3AED" }} className="animate-spin" />}
            {stage === "done" && <Check style={{ width: 12, height: 12, color: P.success }} />}
            <span style={{ flex: 1, fontSize: 11.5, fontWeight: 750, color: stage === "error" ? P.error : P.text }}>
              {stage === "error" ? (errorMsg || tr("pinForm.copyGenerationFailed")) : visibleProgressLabel}
            </span>
          </div>
          {stage === "done" && result?.summary && (
            <p style={{ margin: "5px 0 0", fontSize: 11, color: P.textSec }}>{result.summary}</p>
          )}
          {stage === "done" && hasContext && (
            <ContextDisclosure open={ctxOpen} onToggle={() => setCtxOpen(o => !o)}
              imageSummary={shownImageSummary} keywords={shownKeywords} board={shownBoard} language={props.language} aiCopyV2={result?.aiCopyV2} />
          )}
        </div>
      )}
    </div>
  );
});

function ContextDisclosure({ open, onToggle, imageSummary, keywords, board, language, aiCopyV2 }: {
  open: boolean; onToggle: () => void; imageSummary?: string; keywords: string[]; board?: string | null; language?: LanguageCode; aiCopyV2?: AICopyV2Evidence;
}) {
  const { t: tr } = useLocale();
  // Never imply localized keywords: the DB is English-only.
  const isEnglish = (language ?? "en").toLowerCase().startsWith("en");
  const kwCaption = isEnglish ? tr("pinForm.recommendedPinterestKeywords") : tr("pinForm.englishKeywordContext");
  return (
    <div style={{ marginTop: 6 }}>
      <button type="button" data-testid="ai-copy-context-toggle" onClick={onToggle}
        style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: 0, border: "none", background: "none", color: P.textSec, fontSize: 11, fontWeight: 750, cursor: "pointer", fontFamily: "inherit" }}>
        {tr("pinForm.contextUsed")} {open ? <ChevronUp style={{ width: 12, height: 12 }} /> : <ChevronDown style={{ width: 12, height: 12 }} />}
      </button>
      {open && (
        <div data-testid="ai-copy-context-details" style={{ margin: "7px 0 0", display: "flex", flexDirection: "column", gap: 8 }}>
          {aiCopyV2 && <AICopyV2EvidenceBlock evidence={aiCopyV2} />}
          {imageSummary && (
            <div>
              <div style={sectionLabel}>{tr("pinForm.imageSummary")}</div>
              <p style={{ margin: 0, fontSize: 11, color: P.textSec, lineHeight: 1.45 }}>{imageSummary}</p>
            </div>
          )}
          {keywords.length > 0 && (
            <div>
              <div style={sectionLabel}>{tr("pinForm.recommendedKeywords")}</div>
              <div data-testid="ai-copy-keyword-chips" style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                {keywords.map(k => <span key={k} style={chip}>{k}</span>)}
              </div>
              <p style={{ margin: "4px 0 0", fontSize: 9.5, color: P.textMuted }}>{kwCaption}</p>
            </div>
          )}
          {board && (
            <div>
              <div style={sectionLabel}>{tr("pinForm.board")}</div>
              <p style={{ margin: 0, fontSize: 11, color: P.textSec }}>{board}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function AICopyV2EvidenceBlock({ evidence }: { evidence: AICopyV2Evidence }) {
  const { t: tr } = useLocale();
  const provenanceLabel = evidence.primaryKeyword?.provenance === "official"
    ? tr("trends.badge.official")
    : evidence.primaryKeyword?.provenance === "estimated"
      ? tr("trends.badge.estimated")
      : tr("pinForm.v2DataUnknown");
  return (
    <div data-testid="ai-copy-v2-evidence" style={{ display: "flex", flexDirection: "column", gap: 7, padding: "8px 9px", borderRadius: 8, border: `1px solid ${P.border}`, background: P.surface }}>
      {evidence.mediaEvidenceMode === "video_cover" && (
        <p data-testid="ai-copy-v2-video-cover" style={{ margin: 0, fontSize: 10.5, color: P.textSec }}>Based on the video cover frame</p>
      )}
      <div>
        <div style={sectionLabel}>{tr("pinForm.v2FactBasis")}</div>
        {evidence.facts.length > 0 ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            {evidence.facts.slice(0, 4).map(fact => (
              <div key={fact.factId} style={{ display: "flex", gap: 6, alignItems: "baseline", fontSize: 10.5, lineHeight: 1.4 }}>
                <span style={{ color: P.text, fontWeight: 700 }}>{fact.key}</span>
                <span style={{ color: P.textSec, minWidth: 0 }}>{fact.value}</span>
                <span style={{ color: P.textMuted, fontSize: 9 }}>{fact.source ?? "unknown"} · {fact.trustLevel}</span>
              </div>
            ))}
          </div>
        ) : <p style={{ margin: 0, fontSize: 10.5, color: P.textMuted }}>{tr("pinForm.v2NoClaimsAuthorized")}</p>}
      </div>
      <div>
        <div style={sectionLabel}>{tr("pinForm.v2PrimaryKeyword")}</div>
        {evidence.primaryKeyword ? (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 5, alignItems: "center" }}>
            <span style={chip}>{evidence.primaryKeyword.phrase}</span>
            <span data-testid="ai-copy-v2-provenance" style={{ fontSize: 9.5, color: P.textMuted }}>{provenanceLabel}</span>
          </div>
        ) : <p style={{ margin: 0, fontSize: 10.5, color: P.textMuted }}>{tr("pinForm.v2NoKeywordDemand")}</p>}
      </div>
      {evidence.degradedMode === "no_keyword_demand_data" && (
        <p data-testid="ai-copy-v2-degraded" style={{ margin: 0, fontSize: 10.5, color: P.textSec }}>{tr("pinForm.v2DemandUnavailable")}</p>
      )}
      {evidence.degradedMode === "video_cover_unavailable" && (
        <p data-testid="ai-copy-v2-video-cover-unavailable" style={{ margin: 0, fontSize: 10.5, color: P.textSec }}>Video cover frame unavailable; visual facts were not used.</p>
      )}
      <p data-testid="ai-copy-v2-validation" style={{ margin: 0, fontSize: 10.5, fontWeight: 700, color: evidence.validationReport.valid ? P.text : P.error }}>
        {evidence.validationReport.valid ? tr("pinForm.v2ValidationPassed") : tr("pinForm.v2ValidationFailed")}
      </p>
    </div>
  );
}
