"use client";

import { useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { ProductUrlImportApiResponse } from "@/lib/productUrlImportClient";
import {
  autoSelectTopCandidates,
  candidateSelectionKey,
  DEFAULT_MAX_URLS,
  fetchProductUrlImport,
  parseProductImportUrls,
  reasonLabel,
} from "@/lib/productUrlImportClient";

const UI = {
  cardElev:     "var(--app-surface-3, #151F32)",
  border:       "var(--app-border, rgba(255,255,255,0.09))",
  borderStrong: "var(--app-border-hi, rgba(255,255,255,0.14))",
  text:         "var(--app-text, #E5E7EB)",
  textSec:      "var(--app-text-sec, #9CA3AF)",
  muted:        "var(--app-text-muted, #64748B)",
  purple:       "#8B5CF6",
  gradient:     "linear-gradient(135deg,#FF4D8D 0%,#D946EF 52%,#7C3AED 100%)",
};

type Phase = "empty" | "loading" | "review";

type UrlResult = ProductUrlImportApiResponse["results"][number];

function CandidateSkeleton() {
  return (
    <div data-testid="url-import-candidate-skeleton" style={{ borderRadius: 10, overflow: "hidden", border: `1px solid ${UI.border}`, background: UI.cardElev }}>
      <div style={{ aspectRatio: "1/1", background: "rgba(255,255,255,0.05)", animation: "pulse 1.25s ease-in-out infinite" }} />
    </div>
  );
}

function CandidateCard({
  imageUrl, selected, label, onToggle,
}: { imageUrl: string; selected: boolean; label: string; onToggle: () => void }) {
  return (
    <button
      type="button"
      data-testid="url-import-candidate"
      onClick={onToggle}
      style={{
        position: "relative", padding: 0, borderRadius: 10, overflow: "hidden",
        border: selected ? `2px solid ${UI.purple}` : `1px solid ${UI.border}`,
        background: UI.cardElev, cursor: "pointer", textAlign: "left",
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={imageUrl} alt="" style={{ width: "100%", aspectRatio: "1/1", objectFit: "cover", display: "block" }} />
      <span style={{
        position: "absolute", top: 6, right: 6, width: 20, height: 20,
        borderRadius: "50%", border: selected ? "none" : "2px solid rgba(255,255,255,0.7)",
        background: selected ? UI.purple : "rgba(0,0,0,0.35)",
        display: "flex", alignItems: "center", justifyContent: "center",
        color: "#fff", fontSize: 11, fontWeight: 800,
      }}>
        {selected ? "✓" : ""}
      </span>
      <span style={{ display: "block", padding: "4px 6px", fontSize: 9, color: UI.textSec, fontWeight: 600 }}>{label}</span>
    </button>
  );
}

function FallbackActionChips({ actions }: { actions: string[] }) {
  const labels: Record<string, string> = {
    upload_image:           "Upload image",
    paste_direct_image_url: "Paste direct image URL",
    connect_etsy_api:       "Connect Etsy API",
  };
  return (
    <div data-testid="url-import-fallback-actions" style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10 }}>
      {actions.map(a => (
        <span key={a} style={{
          padding: "4px 10px", borderRadius: 6,
          border: `1px solid ${UI.borderStrong}`, background: "rgba(255,255,255,0.04)",
          color: UI.textSec, fontSize: 11, fontWeight: 600,
        }}>
          {labels[a] ?? a}
        </span>
      ))}
    </div>
  );
}

/** Rendered when a Pinterest pin URL lands in the product picker. */
function PinterestWarningCard({ sourceUrl }: { sourceUrl: string }) {
  return (
    <div
      data-testid="url-import-pinterest-warning"
      style={{
        padding: 14, borderRadius: 10,
        border: `1px solid rgba(139,92,246,0.35)`,
        background: "rgba(139,92,246,0.08)",
      }}
    >
      <p style={{ margin: 0, fontSize: 12, fontWeight: 800, color: "#C4B5FD" }}>Pinterest pin detected</p>
      <p style={{ margin: "4px 0 0", fontSize: 11, color: UI.textSec, lineHeight: 1.5 }}>
        Pinterest pins go to <strong style={{ color: UI.text }}>Pin References</strong>, not Product Images.
        Close this panel and click <strong style={{ color: UI.text }}>&quot;Add pin references&quot;</strong> to import{" "}
        <span style={{ wordBreak: "break-all", color: UI.muted }}>{sourceUrl}</span>.
      </p>
    </div>
  );
}

function ResultGroup({
  result,
  role,
  selectedCandidates,
  retryUrl,
  onToggle,
  onRetry,
}: {
  result: UrlResult;
  role: "product" | "reference";
  selectedCandidates: Set<string>;
  retryUrl: string | null;
  onToggle: (sourceUrl: string, candidateId: string) => void;
  onRetry: (sourceUrl: string) => void;
}) {
  // Pinterest pin pasted into product picker
  if (result.assetType === "reference" && role === "product") {
    return (
      <div data-testid="url-import-result-group" style={{ marginBottom: 16 }}>
        <p style={{ margin: "0 0 8px", fontSize: 11, fontWeight: 800, color: "#C4B5FD" }}>
          {result.sourceDomain || result.sourceUrl}
        </p>
        <PinterestWarningCard sourceUrl={result.sourceUrl} />
      </div>
    );
  }

  // Blocked (Etsy 403, Pinterest blocked, etc.)
  if (result.status === "blocked" || result.status === "unsupported") {
    const msg = result.message ?? result.error ?? "This URL could not be imported automatically.";
    return (
      <div data-testid="url-import-result-group" style={{ marginBottom: 16 }}>
        <p style={{ margin: "0 0 8px", fontSize: 11, fontWeight: 800, color: "#C4B5FD" }}>
          {result.sourceDomain || result.sourceUrl}
        </p>
        <div data-testid="url-import-blocked" style={{
          padding: 12, borderRadius: 10,
          border: `1px solid rgba(251,191,36,0.25)`,
          background: "rgba(251,191,36,0.06)",
        }}>
          <p style={{ margin: 0, fontSize: 12, color: "#FDE68A", fontWeight: 700 }}>
            {result.provider === "etsy" ? "Etsy" : result.provider === "pinterest" ? "Pinterest" : "Provider"} blocks automatic extraction
          </p>
          <p style={{ margin: "4px 0 0", fontSize: 11, color: UI.textSec, lineHeight: 1.5 }}>{msg}</p>
          {result.fallbackActions?.length ? <FallbackActionChips actions={result.fallbackActions} /> : null}
        </div>
      </div>
    );
  }

  // General failure
  if (result.status === "failed" || result.status === "error") {
    const msg = result.message ?? result.error ?? "Could not extract product images";
    return (
      <div data-testid="url-import-result-group" style={{ marginBottom: 16 }}>
        <p style={{ margin: "0 0 2px", fontSize: 11, fontWeight: 800, color: "#C4B5FD" }}>
          {result.sourceDomain || result.sourceUrl}
        </p>
        <div style={{ padding: 12, borderRadius: 10, border: `1px solid ${UI.border}`, background: "rgba(248,113,113,0.06)" }}>
          <p style={{ margin: 0, fontSize: 12, color: "#FCA5A5" }}>{msg}</p>
          <button
            type="button"
            data-testid="url-import-retry"
            disabled={retryUrl === result.sourceUrl}
            onClick={() => onRetry(result.sourceUrl)}
            style={{
              marginTop: 8, display: "inline-flex", alignItems: "center", gap: 6,
              padding: "6px 12px", borderRadius: 8,
              border: `1px solid ${UI.borderStrong}`, background: "transparent",
              color: UI.text, fontSize: 11, fontWeight: 700, cursor: "pointer",
            }}
          >
            <RefreshCw style={{ width: 12, height: 12 }} /> Retry
          </button>
        </div>
      </div>
    );
  }

  // Success
  return (
    <div data-testid="url-import-result-group" style={{ marginBottom: 16 }}>
      <p style={{ margin: "0 0 2px", fontSize: 11, fontWeight: 800, color: "#C4B5FD" }}>
        {result.sourceDomain || result.sourceUrl}
      </p>
      {result.title && (
        <p style={{ margin: "0 0 8px", fontSize: 12, fontWeight: 700, color: UI.text }}>{result.title}</p>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(88px,1fr))", gap: 8 }}>
        {(result.candidates ?? []).map(candidate => (
          <CandidateCard
            key={candidate.id}
            imageUrl={candidate.imageUrl}
            selected={selectedCandidates.has(candidateSelectionKey(result.sourceUrl, candidate.id))}
            label={reasonLabel(candidate.reason)}
            onToggle={() => onToggle(result.sourceUrl, candidate.id)}
          />
        ))}
      </div>
    </div>
  );
}

export type ProductUrlImportPanelProps = {
  /** Which asset pool this panel is embedded in — used to detect Pinterest-in-product mismatches. */
  role?: "product" | "reference";
  onSaveSelected: (items: Array<{
    imageUrl: string;
    title: string;
    sourceUrl: string;
    sourceDomain: string;
    productUrl: string;
    extractionReason?: string;
  }>) => void;
  onCancel: () => void;
};

export function ProductUrlImportPanel({ role = "product", onSaveSelected, onCancel }: ProductUrlImportPanelProps) {
  const [urlText,            setUrlText]            = useState("");
  const [phase,              setPhase]              = useState<Phase>("empty");
  const [results,            setResults]            = useState<ProductUrlImportApiResponse["results"]>([]);
  const [loadingUrls,        setLoadingUrls]        = useState<string[]>([]);
  const [selectedCandidates, setSelectedCandidates] = useState<Set<string>>(new Set());
  const [error,              setError]              = useState<string | null>(null);
  const [retryUrl,           setRetryUrl]           = useState<string | null>(null);

  const parsed = useMemo(() => parseProductImportUrls(urlText), [urlText]);

  function toggleCandidate(sourceUrl: string, candidateId: string) {
    const key = candidateSelectionKey(sourceUrl, candidateId);
    setSelectedCandidates(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  async function runExtraction(urls: string[]) {
    if (!urls.length) return;
    setPhase("loading");
    setError(null);
    setLoadingUrls(urls);
    setResults([]);
    setSelectedCandidates(new Set());
    try {
      const data = await fetchProductUrlImport(urls);
      setResults(data.results);
      setSelectedCandidates(autoSelectTopCandidates(data.results));
      setPhase("review");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Import failed");
      setPhase("empty");
    } finally {
      setLoadingUrls([]);
    }
  }

  async function handleRetryUrl(sourceUrl: string) {
    setRetryUrl(sourceUrl);
    setPhase("loading");
    setLoadingUrls([sourceUrl]);
    try {
      const data = await fetchProductUrlImport([sourceUrl]);
      const replacement = data.results[0];
      setResults(prev => prev.map(r => (r.sourceUrl === sourceUrl ? replacement : r)));
      if (replacement?.status === "success" && replacement.candidates?.length) {
        const top = [...replacement.candidates].sort((a, b) => b.score - a.score)[0];
        setSelectedCandidates(prev => {
          const next = new Set(prev);
          for (const key of [...next]) { if (key.startsWith(`${sourceUrl}::`)) next.delete(key); }
          next.add(candidateSelectionKey(sourceUrl, top.id));
          return next;
        });
      }
      setPhase("review");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Retry failed");
      setPhase("review");
    } finally {
      setRetryUrl(null);
      setLoadingUrls([]);
    }
  }

  function handleClear() {
    setUrlText(""); setResults([]); setSelectedCandidates(new Set());
    setPhase("empty"); setError(null); setLoadingUrls([]);
  }

  function handleSaveSelected() {
    const items: Parameters<ProductUrlImportPanelProps["onSaveSelected"]>[0] = [];
    for (const key of selectedCandidates) {
      const [sourceUrl, candidateId] = key.split("::");
      const result    = results.find(r => r.sourceUrl === sourceUrl);
      const candidate = result?.candidates?.find(c => c.id === candidateId);
      if (!result || !candidate || result.status !== "success") continue;
      items.push({
        imageUrl:         candidate.imageUrl,
        title:            result.title ?? `Imported product from ${result.sourceDomain}`,
        sourceUrl:        result.sourceUrl,
        sourceDomain:     result.sourceDomain,
        productUrl:       result.sourceUrl,
        extractionReason: candidate.reason,
      });
    }
    onSaveSelected(items);
    handleClear();
  }

  // Count selectable candidates (exclude blocked/reference results)
  const selectableCount = [...selectedCandidates].filter(key => {
    const [sourceUrl] = key.split("::");
    const result = results.find(r => r.sourceUrl === sourceUrl);
    return result?.status === "success" && (result.assetType !== "reference" || role !== "product");
  }).length;

  return (
    <div data-testid="product-url-import-panel" style={{ marginBottom: 16, borderRadius: 12, border: `1px solid ${UI.borderStrong}`, background: UI.cardElev, overflow: "hidden" }}>
      <div style={{ padding: "14px 16px 10px", borderBottom: `1px solid ${UI.border}` }}>
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 800, color: UI.text }}>Import from URL</h3>
        <p style={{ margin: "4px 0 0", fontSize: 11, color: UI.textSec, lineHeight: 1.5 }}>
          Paste product page URLs or direct image URLs. We&apos;ll extract candidate product images for you to review.
        </p>
      </div>

      <div style={{ padding: 16 }}>
        {(phase === "empty" || phase === "loading") && (
          <>
            <textarea
              data-testid="url-import-textarea"
              value={urlText}
              onChange={e => setUrlText(e.target.value)}
              placeholder="Paste URLs, one per line"
              rows={5}
              style={{
                width: "100%", boxSizing: "border-box", borderRadius: 10,
                border: `1px solid ${UI.borderStrong}`, background: "var(--app-surface-2, #0D1423)",
                color: UI.text, padding: "10px 12px", fontSize: 12, resize: "vertical",
                outline: "none", fontFamily: "inherit",
              }}
            />
            {parsed.overBatchLimit && (
              <p data-testid="url-import-limit-warning" style={{ margin: "8px 0 0", fontSize: 11, color: "#FBBF24", fontWeight: 600 }}>
                You can import up to {DEFAULT_MAX_URLS} URLs at a time.
              </p>
            )}
            {parsed.dedupedCount > 0 && (
              <p style={{ margin: "6px 0 0", fontSize: 11, color: UI.muted }}>
                Removed {parsed.dedupedCount} duplicate URL{parsed.dedupedCount === 1 ? "" : "s"}.
              </p>
            )}
            {parsed.invalidLines.length > 0 && (
              <p style={{ margin: "6px 0 0", fontSize: 11, color: UI.muted }}>
                Skipped {parsed.invalidLines.length} invalid line{parsed.invalidLines.length === 1 ? "" : "s"}.
              </p>
            )}
            <p style={{ margin: "8px 0 0", fontSize: 11, color: UI.muted }}>
              Supports direct image URLs and product pages with product images.
            </p>
            {error && <p style={{ margin: "8px 0 0", fontSize: 11, color: "#F87171" }}>{error}</p>}
            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <button
                type="button"
                data-testid="url-import-extract"
                disabled={!parsed.urls.length || phase === "loading"}
                onClick={() => runExtraction(parsed.urls)}
                style={{
                  padding: "8px 16px", borderRadius: 9, border: "none",
                  background: parsed.urls.length && phase !== "loading" ? UI.gradient : "rgba(148,163,184,0.12)",
                  color:      parsed.urls.length && phase !== "loading" ? "#fff" : UI.muted,
                  fontSize: 12, fontWeight: 800,
                  cursor: parsed.urls.length && phase !== "loading" ? "pointer" : "not-allowed",
                }}
              >
                Extract images
              </button>
              <button
                type="button"
                data-testid="url-import-clear"
                onClick={handleClear}
                style={{
                  padding: "8px 14px", borderRadius: 9,
                  border: `1px solid ${UI.borderStrong}`, background: "transparent",
                  color: UI.text, fontSize: 12, fontWeight: 700, cursor: "pointer",
                }}
              >
                Clear
              </button>
            </div>
          </>
        )}

        {phase === "loading" && loadingUrls.length > 0 && (
          <div data-testid="url-import-loading" style={{ marginTop: 16 }}>
            {loadingUrls.map(url => (
              <div key={url} data-testid="url-import-extracting" style={{ marginBottom: 14 }}>
                <p style={{ margin: "0 0 8px", fontSize: 11, color: UI.textSec, fontWeight: 700 }}>{url}</p>
                <p style={{ margin: "0 0 8px", fontSize: 10, color: UI.muted }}>Extracting…</p>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(88px,1fr))", gap: 8 }}>
                  {Array.from({ length: 3 }).map((_, i) => <CandidateSkeleton key={i} />)}
                </div>
              </div>
            ))}
          </div>
        )}

        {phase === "review" && (
          <div data-testid="url-import-results">
            {results.map(result => (
              <ResultGroup
                key={result.sourceUrl}
                result={result}
                role={role}
                selectedCandidates={selectedCandidates}
                retryUrl={retryUrl}
                onToggle={toggleCandidate}
                onRetry={handleRetryUrl}
              />
            ))}
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <button type="button" data-testid="url-import-back" onClick={() => setPhase("empty")}
                style={{ padding: "8px 14px", borderRadius: 9, border: `1px solid ${UI.borderStrong}`, background: "transparent", color: UI.text, fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
                Edit URLs
              </button>
            </div>
          </div>
        )}
      </div>

      {phase === "review" && (
        <footer style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", borderTop: `1px solid ${UI.border}`, background: "rgba(0,0,0,0.15)" }}>
          <span data-testid="url-import-selected-count" style={{ flex: 1, color: selectableCount ? "#C4B5FD" : UI.textSec, fontSize: 12, fontWeight: 800 }}>
            {selectableCount} image{selectableCount === 1 ? "" : "s"} selected
          </span>
          <button type="button" data-testid="url-import-cancel" onClick={() => { handleClear(); onCancel(); }}
            style={{ padding: "8px 14px", borderRadius: 9, border: `1px solid ${UI.borderStrong}`, background: "transparent", color: UI.text, fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
            Cancel
          </button>
          <button
            type="button"
            data-testid="url-import-save"
            disabled={selectableCount === 0}
            onClick={handleSaveSelected}
            style={{
              padding: "8px 16px", borderRadius: 9, border: "none",
              background: selectableCount ? UI.gradient : "rgba(148,163,184,0.12)",
              color:      selectableCount ? "#fff" : UI.muted,
              fontSize: 12, fontWeight: 800,
              cursor: selectableCount ? "pointer" : "not-allowed",
            }}
          >
            Save selected
          </button>
        </footer>
      )}
    </div>
  );
}
