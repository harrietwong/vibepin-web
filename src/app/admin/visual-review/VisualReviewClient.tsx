"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Lock, RefreshCw, ShieldCheck, AlertTriangle, Save, Check } from "lucide-react";
import {
  computeDecisionLabel,
  computeVisualAssetScore,
  DEFAULT_SCORES,
  VISUAL_REVIEW_TAGS,
  type CandidatesResponse,
  type VisualReviewCandidate,
  type VisualReviewDecision,
  type VisualReviewRecord,
  type VisualReviewScores,
  type VisualReviewTag,
} from "@/lib/visualReview";

// ── Local working state ──────────────────────────────────────────────────────

type Edit = VisualReviewScores & { tags: VisualReviewTag[]; note: string };

type SourceFilter = "all" | "pin_products" | "pin_samples";
type DecisionFilter =
  | "all"
  | "PASS"
  | "REVIEW"
  | "REJECT"
  | "ai_like"
  | "product_clear"
  | "pinterest_ready";

function keyOf(c: { source_type: string; source_id: string }): string {
  return `${c.source_type}:${c.source_id}`;
}

function editFromRecord(r: VisualReviewRecord): Edit {
  return {
    human_shot_authenticity_score: r.human_shot_authenticity_score,
    ai_likeness_score: r.ai_likeness_score,
    product_visibility_score: r.product_visibility_score,
    pinterest_native_score: r.pinterest_native_score,
    commercial_clarity_score: r.commercial_clarity_score,
    tags: r.tags,
    note: r.reviewer_note ?? "",
  };
}

function defaultEdit(): Edit {
  return { ...DEFAULT_SCORES, tags: [], note: "" };
}

const DECISION_TONE: Record<VisualReviewDecision, { bg: string; fg: string; border: string }> = {
  PASS: { bg: "rgba(16,185,129,0.12)", fg: "#047857", border: "rgba(16,185,129,0.30)" },
  REVIEW: { bg: "rgba(245,158,11,0.13)", fg: "#B45309", border: "rgba(245,158,11,0.32)" },
  REJECT: { bg: "rgba(239,68,68,0.12)", fg: "#B91C1C", border: "rgba(239,68,68,0.30)" },
};

const SCORE_FIELDS: Array<{
  key: keyof VisualReviewScores;
  label: string;
  min: number;
  max: number;
  hint: string;
}> = [
  { key: "human_shot_authenticity_score", label: "Authenticity", min: 1, max: 5, hint: "1 AI-like · 5 human-shot" },
  { key: "ai_likeness_score", label: "AI-likeness", min: 0, max: 5, hint: "0 not AI · 5 strongly AI" },
  { key: "product_visibility_score", label: "Product visibility", min: 1, max: 5, hint: "1 none · 5 clear subject" },
  { key: "pinterest_native_score", label: "Pinterest-native", min: 1, max: 5, hint: "1 off · 5 save-worthy" },
  { key: "commercial_clarity_score", label: "Commercial clarity", min: 1, max: 5, hint: "1 none · 5 strong angle" },
];

const DECISION_FILTERS: Array<{ id: DecisionFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "PASS", label: "PASS" },
  { id: "REVIEW", label: "REVIEW" },
  { id: "REJECT", label: "REJECT" },
  { id: "ai_like", label: "AI-like" },
  { id: "product_clear", label: "Product clear" },
  { id: "pinterest_ready", label: "Pinterest-ready" },
];

// ── Small controls ───────────────────────────────────────────────────────────

function ScoreSelector({
  value,
  min,
  max,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  const options: number[] = [];
  for (let i = min; i <= max; i++) options.push(i);
  return (
    <div style={{ display: "flex", gap: 3 }}>
      {options.map(opt => {
        const active = opt === value;
        return (
          <button
            key={opt}
            type="button"
            onClick={() => onChange(opt)}
            style={{
              width: 26,
              height: 26,
              borderRadius: 6,
              fontSize: 12,
              fontWeight: 800,
              cursor: "pointer",
              background: active ? "#111827" : "#FFFFFF",
              color: active ? "#FFFFFF" : "#6B7280",
              border: `1px solid ${active ? "#111827" : "#E5E7EB"}`,
            }}
          >
            {opt}
          </button>
        );
      })}
    </div>
  );
}

function DecisionBadge({ decision, score }: { decision: VisualReviewDecision; score: number }) {
  const tone = DECISION_TONE[decision];
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-black uppercase"
      style={{ background: tone.bg, borderColor: tone.border, color: tone.fg }}
    >
      {decision}
      <span style={{ opacity: 0.7 }}>· {score}</span>
    </span>
  );
}

// ── Card ─────────────────────────────────────────────────────────────────────

function CandidateCard({
  candidate,
  edit,
  persisted,
  saving,
  savedState,
  persistenceAvailable,
  onChangeScore,
  onToggleTag,
  onChangeNote,
  onSave,
}: {
  candidate: VisualReviewCandidate;
  edit: Edit;
  persisted: VisualReviewRecord | undefined;
  saving: boolean;
  savedState: "ok" | "err" | undefined;
  persistenceAvailable: boolean;
  onChangeScore: (field: keyof VisualReviewScores, value: number) => void;
  onToggleTag: (tag: VisualReviewTag) => void;
  onChangeNote: (value: string) => void;
  onSave: () => void;
}) {
  const score = computeVisualAssetScore(edit);
  const decision = computeDecisionLabel(score, edit.ai_likeness_score);
  const dirty = persisted
    ? JSON.stringify(editFromRecord(persisted)) !== JSON.stringify(edit)
    : JSON.stringify(defaultEdit()) !== JSON.stringify(edit);

  return (
    <div
      className="flex flex-col overflow-hidden rounded-xl border"
      style={{ background: "#FFFFFF", borderColor: "#E5E7EB" }}
    >
      {/* Thumbnail */}
      <div style={{ position: "relative", background: "#F1F5F9", aspectRatio: "1 / 1", overflow: "hidden" }}>
        {/* eslint-disable-next-line @next/next/no-img-element -- external Pinterest/merchant CDN thumbnails, no optimization needed */}
        <img
          src={candidate.image_url}
          alt={candidate.title ?? "candidate"}
          loading="lazy"
          referrerPolicy="no-referrer"
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
        <div style={{ position: "absolute", top: 8, left: 8 }}>
          <span
            className="rounded-full px-2 py-0.5 text-[10px] font-black uppercase"
            style={{
              background: candidate.source_type === "pin_product" ? "rgba(124,58,237,0.9)" : "rgba(37,99,235,0.9)",
              color: "#FFFFFF",
            }}
          >
            {candidate.source_type === "pin_product" ? "pin_product" : "pin_sample"}
          </span>
        </div>
        <div style={{ position: "absolute", top: 8, right: 8 }}>
          <DecisionBadge decision={decision} score={score} />
        </div>
      </div>

      {/* Meta */}
      <div className="border-b px-3 py-2.5" style={{ borderColor: "#F1F5F9" }}>
        <p className="truncate text-[12.5px] font-bold text-gray-900" title={candidate.title ?? undefined}>
          {candidate.title ?? "Untitled"}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10.5px] text-gray-400">
          {candidate.category && <span className="font-semibold text-gray-500">{candidate.category}</span>}
          {candidate.source_pin_id && <span>#{candidate.source_pin_id}</span>}
          {candidate.created_at && <span>{new Date(candidate.created_at).toLocaleDateString()}</span>}
        </div>
      </div>

      {/* Scores */}
      <div className="flex flex-col gap-2 px-3 py-3">
        {SCORE_FIELDS.map(field => (
          <div key={field.key} className="flex items-center justify-between gap-2">
            <div style={{ minWidth: 0 }}>
              <p className="text-[11.5px] font-bold text-gray-700">{field.label}</p>
              <p className="text-[9.5px] text-gray-400">{field.hint}</p>
            </div>
            <ScoreSelector
              value={edit[field.key]}
              min={field.min}
              max={field.max}
              onChange={v => onChangeScore(field.key, v)}
            />
          </div>
        ))}
      </div>

      {/* Tags */}
      <div className="flex flex-wrap gap-1.5 px-3 pb-2">
        {VISUAL_REVIEW_TAGS.map(tag => {
          const active = edit.tags.includes(tag);
          return (
            <button
              key={tag}
              type="button"
              onClick={() => onToggleTag(tag)}
              style={{
                fontSize: 10,
                fontWeight: 700,
                padding: "3px 7px",
                borderRadius: 20,
                cursor: "pointer",
                background: active ? "rgba(17,24,39,0.9)" : "#F8FAFC",
                color: active ? "#FFFFFF" : "#6B7280",
                border: `1px solid ${active ? "#111827" : "#E5E7EB"}`,
              }}
            >
              {tag}
            </button>
          );
        })}
      </div>

      {/* Note + save */}
      <div className="mt-auto flex flex-col gap-2 px-3 pb-3">
        <textarea
          value={edit.note}
          onChange={e => onChangeNote(e.target.value)}
          placeholder="Reviewer note (optional)"
          rows={2}
          className="w-full resize-none rounded-lg border px-2 py-1.5 text-[11.5px]"
          style={{ borderColor: "#E5E7EB", color: "#111827", background: "#FFFFFF" }}
        />
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10.5px] text-gray-400">
            {persisted?.updated_at
              ? `Saved ${new Date(persisted.updated_at).toLocaleString()}`
              : dirty
                ? "Unsaved"
                : "Not reviewed"}
          </span>
          <button
            type="button"
            onClick={onSave}
            disabled={saving || !persistenceAvailable}
            title={persistenceAvailable ? undefined : "Persistence disabled until migration v31 is applied"}
            className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11.5px] font-bold"
            style={{
              cursor: saving || !persistenceAvailable ? "not-allowed" : "pointer",
              background: savedState === "ok" ? "#047857" : "#111827",
              color: "#FFFFFF",
              opacity: !persistenceAvailable ? 0.4 : saving ? 0.7 : 1,
            }}
          >
            {savedState === "ok" ? <Check className="h-3.5 w-3.5" /> : <Save className="h-3.5 w-3.5" />}
            {saving ? "Saving…" : savedState === "ok" ? "Saved" : "Save"}
          </button>
        </div>
        {savedState === "err" && (
          <p className="text-[10.5px] font-semibold text-red-600">Save failed. See console for details.</p>
        )}
      </div>
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function VisualReviewClient() {
  const [data, setData] = useState<CandidatesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [decisionFilter, setDecisionFilter] = useState<DecisionFilter>("all");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");

  const [edits, setEdits] = useState<Record<string, Edit>>({});
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [savedState, setSavedState] = useState<Record<string, "ok" | "err">>({});

  const load = useCallback(async (source: SourceFilter) => {
    setLoading(true);
    setError(null);
    try {
      const resp = await fetch(`/api/admin/visual-review/candidates?source=${source}&limit=60`, {
        credentials: "include",
      });
      if (!resp.ok) {
        setError(resp.status === 403 ? "Forbidden — super admin only." : `Request failed (${resp.status})`);
        setData(null);
        return;
      }
      const body = (await resp.json()) as CandidatesResponse;
      setData(body);
      // Seed working edits from persisted reviews.
      const seeded: Record<string, Edit> = {};
      for (const r of body.reviews) seeded[keyOf(r)] = editFromRecord(r);
      setEdits(seeded);
      setSavedState({});
    } catch (err) {
      setError(String(err));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  // Route/source-driven fetch; the synchronous loading flag inside load() is
  // intentional here (mirrors the app shell's data-fetch effects).
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    void load(sourceFilter);
  }, [load, sourceFilter]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const reviewByKey = useMemo(() => {
    const map = new Map<string, VisualReviewRecord>();
    for (const r of data?.reviews ?? []) map.set(keyOf(r), r);
    return map;
  }, [data]);

  const getEdit = useCallback(
    (c: VisualReviewCandidate): Edit => edits[keyOf(c)] ?? defaultEdit(),
    [edits],
  );

  const updateEdit = useCallback((key: string, patch: Partial<Edit>) => {
    setEdits(prev => ({ ...prev, [key]: { ...(prev[key] ?? defaultEdit()), ...patch } }));
    setSavedState(prev => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  const saveOne = useCallback(
    async (c: VisualReviewCandidate) => {
      const key = keyOf(c);
      const edit = edits[key] ?? defaultEdit();
      setSaving(prev => ({ ...prev, [key]: true }));
      try {
        const resp = await fetch("/api/admin/visual-review", {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            source_type: c.source_type,
            source_id: c.source_id,
            image_url: c.image_url,
            human_shot_authenticity_score: edit.human_shot_authenticity_score,
            ai_likeness_score: edit.ai_likeness_score,
            product_visibility_score: edit.product_visibility_score,
            pinterest_native_score: edit.pinterest_native_score,
            commercial_clarity_score: edit.commercial_clarity_score,
            tags: edit.tags,
            reviewer_note: edit.note,
          }),
        });
        if (!resp.ok) {
          const body = await resp.json().catch(() => ({}));
          console.error("Visual review save failed", resp.status, body);
          setSavedState(prev => ({ ...prev, [key]: "err" }));
          return;
        }
        const body = (await resp.json()) as { review: VisualReviewRecord };
        setData(prev => {
          if (!prev) return prev;
          const others = prev.reviews.filter(r => keyOf(r) !== key);
          return { ...prev, reviews: [...others, body.review] };
        });
        setSavedState(prev => ({ ...prev, [key]: "ok" }));
      } catch (err) {
        console.error("Visual review save error", err);
        setSavedState(prev => ({ ...prev, [key]: "err" }));
      } finally {
        setSaving(prev => ({ ...prev, [key]: false }));
      }
    },
    [edits],
  );

  const filtered = useMemo(() => {
    const candidates = data?.candidates ?? [];
    return candidates.filter(c => {
      if (categoryFilter !== "all" && c.category !== categoryFilter) return false;
      if (decisionFilter === "all") return true;
      const edit = edits[keyOf(c)] ?? defaultEdit();
      if (decisionFilter === "ai_like") return edit.tags.includes("ai_like");
      if (decisionFilter === "product_clear") return edit.tags.includes("product_clear");
      if (decisionFilter === "pinterest_ready") return edit.tags.includes("pinterest_ready");
      const score = computeVisualAssetScore(edit);
      return computeDecisionLabel(score, edit.ai_likeness_score) === decisionFilter;
    });
  }, [data, edits, decisionFilter, categoryFilter]);

  return (
    <main className="h-full overflow-y-auto" style={{ background: "#F8FAFC", color: "#111827" }}>
      <div className="mx-auto max-w-[1400px] px-6 py-7">
        {/* Header */}
        <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
          <div>
            <div
              className="mb-2 inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[11px] font-bold"
              style={{ background: "#FFFFFF", borderColor: "#E5E7EB", color: "#4B5563" }}
            >
              <Lock className="h-3.5 w-3.5" />
              Super Admin only · Internal
            </div>
            <h1 className="text-[25px] font-black tracking-tight text-gray-950">Visual Review v0</h1>
            <p className="mt-1 max-w-[720px] text-[13px] text-gray-500">
              Score existing image candidates for authenticity, AI-likeness, product visibility, Pinterest-nativeness,
              and commercial clarity. Internal only — these scores do not affect ranking, Product Ideas, or Create Pins.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void load(sourceFilter)}
            className="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-[12px] font-bold"
            style={{ background: "#FFFFFF", borderColor: "#E5E7EB", color: "#374151" }}
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </button>
        </div>

        {/* Persistence banner */}
        {data && !data.persistenceAvailable && (
          <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
              <div>
                <p className="text-[13px] font-bold text-amber-900">Scores are UI-only</p>
                <p className="mt-1 text-[12px] text-amber-800">
                  The <code>visual_asset_reviews</code> table is not present. Apply
                  <code> backend/db/migrate_v31_visual_asset_reviews.sql</code> to enable saving. Scoring and the live
                  decision label still work here.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Filters */}
        <div className="mb-4 flex flex-wrap items-center gap-2">
          {/* Source */}
          <div className="inline-flex overflow-hidden rounded-lg border" style={{ borderColor: "#E5E7EB" }}>
            {(["all", "pin_products", "pin_samples"] as SourceFilter[]).map(s => (
              <button
                key={s}
                type="button"
                onClick={() => setSourceFilter(s)}
                className="px-3 py-1.5 text-[12px] font-bold"
                style={{
                  background: sourceFilter === s ? "#111827" : "#FFFFFF",
                  color: sourceFilter === s ? "#FFFFFF" : "#6B7280",
                }}
              >
                {s === "all" ? "All sources" : s}
              </button>
            ))}
          </div>

          {/* Decision / tag filters */}
          <div className="flex flex-wrap gap-1.5">
            {DECISION_FILTERS.map(f => (
              <button
                key={f.id}
                type="button"
                onClick={() => setDecisionFilter(f.id)}
                className="rounded-lg border px-2.5 py-1.5 text-[12px] font-bold"
                style={{
                  background: decisionFilter === f.id ? "#111827" : "#FFFFFF",
                  color: decisionFilter === f.id ? "#FFFFFF" : "#6B7280",
                  borderColor: decisionFilter === f.id ? "#111827" : "#E5E7EB",
                }}
              >
                {f.label}
              </button>
            ))}
          </div>

          {/* Category */}
          {(data?.categories.length ?? 0) > 0 && (
            <select
              value={categoryFilter}
              onChange={e => setCategoryFilter(e.target.value)}
              className="rounded-lg border px-2.5 py-1.5 text-[12px] font-bold"
              style={{ background: "#FFFFFF", borderColor: "#E5E7EB", color: "#374151" }}
            >
              <option value="all">All categories</option>
              {data!.categories.map(c => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          )}

          <span className="ml-auto text-[12px] font-semibold text-gray-400">
            {filtered.length} shown{data ? ` · ${data.candidates.length} loaded` : ""}
          </span>
        </div>

        {/* States */}
        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-[13px] font-semibold text-red-700">
            {error}
          </div>
        )}
        {!error && loading && <p className="py-16 text-center text-[13px] text-gray-400">Loading candidates…</p>}
        {!error && !loading && filtered.length === 0 && (
          <p className="py-16 text-center text-[13px] text-gray-400">No candidates match the current filters.</p>
        )}

        {/* Grid */}
        {!error && !loading && filtered.length > 0 && (
          <div
            className="grid gap-4"
            style={{ gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}
          >
            {filtered.map(c => {
              const key = keyOf(c);
              return (
                <CandidateCard
                  key={key}
                  candidate={c}
                  edit={getEdit(c)}
                  persisted={reviewByKey.get(key)}
                  saving={!!saving[key]}
                  savedState={savedState[key]}
                  persistenceAvailable={data?.persistenceAvailable ?? false}
                  onChangeScore={(field, value) => updateEdit(key, { [field]: value })}
                  onToggleTag={tag =>
                    updateEdit(key, {
                      tags: (edits[key]?.tags ?? []).includes(tag)
                        ? (edits[key]?.tags ?? []).filter(t => t !== tag)
                        : [...(edits[key]?.tags ?? []), tag],
                    })
                  }
                  onChangeNote={value => updateEdit(key, { note: value })}
                  onSave={() => void saveOne(c)}
                />
              );
            })}
          </div>
        )}

        {/* Warnings + footer */}
        {data && data.warnings.length > 0 && (
          <div className="mt-5 rounded-lg border px-4 py-3 text-[11.5px] text-gray-500" style={{ background: "#FFFFFF", borderColor: "#E5E7EB" }}>
            {data.warnings.map((w, i) => (
              <p key={i}>· {w}</p>
            ))}
          </div>
        )}
        <div
          className="mt-5 inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-[12px] font-semibold"
          style={{ background: "#FFFFFF", borderColor: "#E5E7EB", color: "#6B7280" }}
        >
          <ShieldCheck className="h-4 w-4 text-emerald-600" />
          Internal review tool. No crawler, Playwright, product-supply, timer, ranking, or client-UI changes.
        </div>
      </div>
    </main>
  );
}
