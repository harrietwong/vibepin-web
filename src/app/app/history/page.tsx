"use client";

import { useState, useEffect, useCallback } from "react";
import useSWR from "swr";
import Link from "next/link";
import dynamic from "next/dynamic";
import { CheckCircle2, X } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { markDataReady } from "@/lib/navTiming";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import {
  loadHistory, mergeHistoryEntries,
  fetchGenerationsFromDb,
  deriveEntryStatus,
  resolveStaleRunningEntries,
  updateSessionInDb,
  type HistoryEntry, type PinGroup, type SetupSnapshot, type GenerationErrorType,
} from "@/lib/studioPersistence";
import * as pinStore      from "@/lib/pinStore";
import * as pinDraftStore from "@/lib/pinDraftStore";
import type { PinDraft } from "@/lib/pinDraftStore";
// Canonical status types — generation and planning are independent dimensions.
import type { GenerationStatus } from "@/lib/status/pinStatuses";

// Lazily loaded — a heavy drawer not needed for the initial paint, so keeping
// it out of the main route chunk lets the My Pins page shell mount faster
// after a sidebar nav. Behavior is unchanged: it already renders nothing when
// no draft is open.
const PinDetailsModal = dynamic(() =>
  import("@/components/pin-details/PinDetailsModal").then(m => m.PinDetailsModal), { ssr: false });

// ── Helpers ───────────────────────────────────────────────────────────────────
function toProxyUrl(url: string): string {
  if (!url) return url;
  if (url.startsWith("/") || url.startsWith("data:") || url.startsWith("blob:")) return url;
  const MARKER = "/storage/v1/object/public/generated/studio/";
  const idx = url.indexOf(MARKER);
  if (idx !== -1) return `/api/storage-image?path=studio/${url.slice(idx + MARKER.length)}`;
  return url;
}
function fmtDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
    + " · " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}
function fmtDateShort(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
function capWords(s: string): string {
  return s.replace(/\b\w/g, c => c.toUpperCase());
}

// ── Planning status helpers (distinct from generation status) ─────────────────
// planningStatusSummary: how many pins from this session are in the Weekly Plan.
// This is a PlanningStatus aggregation — completely independent of GenerationStatus.
type SessionPlanSummary = "none" | "partial" | "all";

function getPlanStatus(entry: HistoryEntry): SessionPlanSummary {
  const allPins = entry.groups.flatMap((g: PinGroup) => g.images);
  const sess    = pinStore.getSession(entry.id);
  const added   = sess?.addedCount ?? 0;
  if (added === 0) return "none";
  if (added >= allPins.length) return "all";
  return "partial";
}

/**
 * Add successfully-generated pins to Weekly Plan.
 * Guards:
 *  - Only accepts urls from completed/partial sessions (caller must check genStatus).
 *  - Skips pins that already have a draft (idempotent via pinDraftStore.createDraft).
 *  - Skips empty url lists.
 */
function addUrlsToPlan(entry: HistoryEntry, urls: string[]) {
  if (!urls.length) return;
  // Only add pins that were actually generated (have a URL).
  // urls arriving here come from groups[i].images which only contains successful URLs,
  // so this is already filtered — but we guard defensively.
  const validUrls = urls.filter(u => !!u?.trim());
  if (!validUrls.length) return;

  console.log("[AddToPlan] pin count", validUrls.length, "session", entry.id);
  pinStore.markPinsByImageUrls(validUrls);
  let count = 0;
  for (const url of validUrls) {
    // createDraft is idempotent — skips if a draft for this imageUrl already exists.
    const draft = pinDraftStore.createDraft({
      imageUrl:            url,
      keyword:             entry.keyword,
      category:            entry.category,
      generationSessionId: entry.id,
    });
    count++;
    if (count === 1) console.log("[AddToPlan] first draft id", draft?.id ?? "none");
  }
  const sess = pinStore.getSession(entry.id);
  console.log("[AddToPlan] updated added_count", sess?.addedCount ?? count);
}

// ── Generation status badge ───────────────────────────────────────────────────
function GenStatusBadge({ status }: { status: GenerationStatus }) {
  const cfg = ({
    pending:     { label: "Pending",      color: "var(--app-text-sec)", bg: "rgba(100,116,139,0.08)" },
    completed:   { label: "Completed",    color: "#059669", bg: "rgba(5,150,105,0.08)"   },
    partial:     { label: "Partial",      color: "#D97706", bg: "rgba(217,119,6,0.08)"   },
    failed:      { label: "Failed",       color: "#EF4444", bg: "rgba(239,68,68,0.08)"   },
    running:     { label: "In progress",  color: "#C026D3", bg: "rgba(192,38,211,0.08)"  },
    interrupted: { label: "Interrupted",  color: "var(--app-text-muted)", bg: "rgba(148,163,184,0.1)"  },
  } as Record<GenerationStatus, { label: string; color: string; bg: string }>)[status]
    ?? { label: status, color: "var(--app-text-sec)", bg: "rgba(100,116,139,0.08)" };
  return (
    <span style={{
      fontSize: "9px", fontWeight: 700, color: cfg.color,
      background: cfg.bg, padding: "2px 7px", borderRadius: 20,
      border: `1px solid ${cfg.color}25`, whiteSpace: "nowrap",
      display: "inline-flex", alignItems: "center", gap: 3,
    }}>
      {status === "running" && (
        <span style={{ width: 5, height: 5, borderRadius: "50%", background: "#C026D3", display: "inline-block", animation: "pulse 1.2s ease-in-out infinite" }}/>
      )}
      {cfg.label}
    </span>
  );
}

// ── Error type → user-facing copy ────────────────────────────────────────────
function getErrorCopy(errorType: GenerationErrorType | undefined): { label: string; detail: string } {
  switch (errorType) {
    case "rate_limited":       return { label: "Rate limited",       detail: "The image API was temporarily rate limited. Try regenerating." };
    case "safety_blocked":     return { label: "Safety blocked",     detail: "The model blocked this request. Try a different reference image or simplify the prompt." };
    case "image_load_failed":  return { label: "Product images failed", detail: "Product images could not be downloaded. Re-upload or use different URLs." };
    case "model_returned_text":return { label: "Model returned text", detail: "The model returned a text description instead of an image. Try fewer inputs or a simpler prompt." };
    case "api_auth_error":     return { label: "Auth error",          detail: "Check your LINAPI_KEY in web/.env.local." };
    case "api_payload_error":  return { label: "Payload rejected",    detail: "Try fewer products or a shorter prompt." };
    case "api_server_error":   return { label: "API server error",    detail: "The image API returned a server error. Try again in a few minutes." };
    default:                   return { label: "Unknown error",       detail: "Check the backend terminal for details." };
  }
}

// ── Build "Create More" / "Retry" URL ────────────────────────────────────────
function buildStudioUrl(entry: HistoryEntry, mode?: "retry"): string {
  const base = "/app/studio";
  if (entry.mode === "product_led" && entry.productIds?.length) {
    const params = new URLSearchParams({
      from:       "shop-signal",
      productIds: entry.productIds.join(","),
      keyword:    entry.opportunity ?? entry.keyword ?? "",
      category:   entry.category ?? "",
      ...(mode === "retry" ? { retry: "1" } : {}),
    });
    return `${base}?${params}`;
  }
  const params = new URLSearchParams({
    from:     entry.mode === "plan" ? "plan" : "workspace",
    keyword:  entry.keyword  ?? "",
    category: entry.category ?? "",
    ...(mode === "retry" ? { retry: "1" } : {}),
  });
  return `${base}?${params}`;
}

// ── Derive which ref groups failed (images < expected per ref) ────────────────
function getFailedRefUrls(entry: HistoryEntry): string[] {
  const perRef = entry.imagesPerRef ?? 1;
  return entry.groups
    .filter(g => g.images.length < perRef)
    .map(g => g.refUrl)
    .filter((u): u is string => !!u);
}

// ── Prompt snapshot component ─────────────────────────────────────────────────
function PromptSnapshot({ excerpt, full }: { excerpt?: string; full?: string }) {
  const [expanded, setExpanded] = useState(false);
  const text = full ?? excerpt;
  if (!text) return <p style={{ margin: 0, fontSize: "11px", color: "var(--app-text-muted)" }}>Not available</p>;
  const preview = text.slice(0, 140);
  const hasMore = text.length > 140;
  return (
    <div>
      <p style={{ margin: "0 0 6px", fontSize: "11px", color: "var(--app-text-sec)", lineHeight: 1.6, background: "var(--app-bg)", padding: "8px 10px", borderRadius: 8, border: "1px solid var(--app-surface-3)" }}>
        {expanded ? text : preview}{!expanded && hasMore && "…"}
      </p>
      {hasMore && (
        <button type="button" onClick={() => setExpanded(v => !v)}
          style={{ fontSize: "10px", color: "#7C3AED", fontWeight: 600, background: "none", border: "none", cursor: "pointer", padding: 0 }}>
          {expanded ? "Collapse ↑" : "View full prompt ↓"}
        </button>
      )}
    </div>
  );
}

// ── Session detail modal ──────────────────────────────────────────────────────
function SessionModal({ entry, onClose }: { entry: HistoryEntry; onClose: () => void }) {
  const [planUrls,     setPlanUrls]     = useState<Set<string>>(() => {
    const pins = pinStore.getSessionPins(entry.id);
    return new Set(pins.filter(p => p.status !== "generated").map(p => p.imageUrl));
  });
  const [selectedUrls, setSelectedUrls] = useState<Set<string>>(new Set());
  const [preview,      setPreview]      = useState<string | null>(null);
  const [detailsDraft, setDetailsDraft] = useState<PinDraft | null>(null);

  const allPins       = entry.groups.flatMap((g: PinGroup) => g.images);
  const title         = entry.keyword ? capWords(entry.keyword) : "Generated Session";
  const added         = allPins.filter(u => planUrls.has(u)).length;
  const notAdded      = allPins.filter(u => !planUrls.has(u));
  const genStatus     = deriveEntryStatus(entry);
  const isRunning     = genStatus === "running";
  const isInterrupted = genStatus === "interrupted";
  const expectedTotal = entry.expectedTotal ?? allPins.length;
  const studioUrl     = buildStudioUrl(entry);
  const retryUrl      = buildStudioUrl(entry, "retry");
  const failedRefs    = getFailedRefUrls(entry);

  function addToPlan(urls: string[]) {
    if (!urls.length) return;
    addUrlsToPlan(entry, urls);
    setPlanUrls(prev => new Set([...prev, ...urls]));
    setSelectedUrls(new Set());
  }
  function togglePin(url: string) {
    setSelectedUrls(prev => { const n = new Set(prev); n.has(url) ? n.delete(url) : n.add(url); return n; });
  }
  function downloadAll() {
    allPins.forEach((u, i) => {
      const a = document.createElement("a"); a.href = toProxyUrl(u); a.download = `pin-${i+1}.jpg`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
    });
  }
  function openPinDetails(url: string, groupIdx: number, pinIdx: number) {
    const existing = pinDraftStore.getDraftByImageUrl(url);
    if (existing) { setDetailsDraft(existing); return; }
    const created = pinDraftStore.createDraft({
      imageUrl: url,
      keyword: entry.keyword || "Pinterest content",
      category: entry.category || "home-decor",
      generationSessionId: entry.id,
    });
    const hydrated = pinDraftStore.updateDraft(created.id, {
      pinId: `${entry.id}_g${groupIdx}_p${pinIdx}`,
      setupSnapshot: entry.setupSnapshot,
      promptSnapshot: entry.promptFull ?? entry.promptExcerpt,
      source: "history",
      format: entry.setupSnapshot?.format,
      model: entry.setupSnapshot?.model,
      addedToPlanAt: "",
      scheduledDate: "",
    });
    setDetailsDraft(hydrated ?? created);
  }

  // ── Normalise session data — prefer setup_snapshot, fall back to flat fields ──
  const snap: SetupSnapshot | undefined = entry.setupSnapshot;
  const isLegacy = !snap;

  // Products: snapshot → flat productNames → nothing
  const displayProducts = snap?.selectedProducts?.length
    ? snap.selectedProducts
    : undefined;
  const displayProductNames = displayProducts
    ? displayProducts.map(p => p.title)
    : (entry.productNames ?? []);

  // References: snapshot → groups → nothing
  const displayRefs = snap?.selectedReferences?.length
    ? snap.selectedReferences
    : entry.groups.filter(g => !!g.refUrl).map(g => ({
        imageUrl:     g.refUrl!,
        visualFormat: g.visualFormat,
        humanPresence: g.humanPresence,
      }));

  // Prompt: snapshot → promptFull → promptExcerpt
  const displayPrompt = snap?.promptSnapshot ?? entry.promptFull ?? entry.promptExcerpt;

  console.log("[HistoryModal] session metadata", {
    sessionId:               entry.id,
    selectedProductsCount:   displayProducts?.length ?? 0,
    selectedReferencesCount: displayRefs?.length ?? 0,
    hasPromptSnapshot:       !!displayPrompt,
    referenceGroupsCount:    entry.groups.length,
    isLegacy,
  });

  // Reference images collected from groups (for backward compat)
  const refUrls = entry.groups.map(g => g.refUrl).filter(Boolean) as string[];

  return (
    <>
      <div onClick={onClose} style={{ position:"fixed",inset:0,zIndex:55,background:"rgba(0,0,0,0.5)" }}/>
      <div style={{
        position:"fixed",top:"50%",left:"50%",transform:"translate(-50%,-50%)",
        zIndex:60,width:"min(1000px,97vw)",maxHeight:"93vh",
        background:"var(--app-surface)",borderRadius:16,boxShadow:"0 24px 64px rgba(0,0,0,0.2)",
        display:"flex",flexDirection:"column",overflow:"hidden",
      }}>

        {/* ── Modal header ── */}
        <div style={{ padding:"14px 20px 10px",borderBottom:"1px solid var(--app-surface-3)",flexShrink:0 }}>
          <div style={{ display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:12,marginBottom:10 }}>
            <div>
              <div style={{ display:"flex",alignItems:"center",gap:8,marginBottom:3 }}>
                <p style={{ margin:0,fontSize:"17px",fontWeight:800,color:"var(--app-text)" }}>{title}</p>
                <GenStatusBadge status={genStatus}/>
              </div>
              <p style={{ margin:0,fontSize:"11px",color:"var(--app-text-muted)" }}>
                {fmtDate(entry.savedAt)}
                {" · "}<strong style={{ color: genStatus === "completed" ? "#059669" : genStatus === "partial" ? "#D97706" : isRunning ? "#C026D3" : "var(--app-text-muted)" }}>
                  {isRunning
                    ? `${allPins.length} / ${expectedTotal} pins generating…`
                    : `${allPins.length} of ${expectedTotal} pins generated`}
                </strong>
                {!isRunning && allPins.length > 0 && ` · ${added}/${allPins.length} added to plan`}
              </p>
            </div>
            <button type="button" onClick={onClose}
              style={{ padding:"5px 10px",borderRadius:8,border:"1px solid var(--app-border)",background:"var(--app-surface-2)",cursor:"pointer",fontSize:13,color:"var(--app-text-sec)",flexShrink:0 }}>
              <X style={{ width:13,height:13 }}/>
            </button>
          </div>

          {/* Running progress bar */}
          {isRunning && expectedTotal > 0 && (
            <div style={{ marginBottom:8 }}>
              <div style={{ display:"flex",justifyContent:"space-between",marginBottom:4 }}>
                <span style={{ fontSize:"11px",color:"#C026D3",fontWeight:600 }}>
                  Generating {allPins.length} / {expectedTotal} pins — you can leave this page
                </span>
                <span style={{ fontSize:"10px",color:"var(--app-text-muted)" }}>
                  {Math.min(100, Math.round((allPins.length / expectedTotal) * 100))}%
                </span>
              </div>
              <div style={{ height:4,background:"var(--app-surface-3)",borderRadius:2,overflow:"hidden" }}>
                <div style={{
                  height:"100%",borderRadius:2,
                  width:`${Math.min(100, Math.round((allPins.length / expectedTotal) * 100))}%`,
                  background:"linear-gradient(90deg,#FF4D8D,#7C3AED)",
                  transition:"width 0.4s",
                }}/>
              </div>
            </div>
          )}

          {/* Action bar */}
          <div style={{ display:"flex",gap:8,flexWrap:"wrap" }}>
            {isRunning ? (
              // Running: no add-to-plan yet
              <span style={{ fontSize:"11px",color:"var(--app-text-muted)",padding:"5px 0" }}>
                Generation in progress — pins will appear here as they complete.
              </span>
            ) : isInterrupted && allPins.length === 0 ? (
              // Interrupted with 0 pins: only retry
              <>
                <Link href={retryUrl}
                  style={{ padding:"5px 14px",borderRadius:8,border:"none",background:"linear-gradient(135deg,#FF4D8D,#7C3AED)",color:"#fff",fontSize:"11px",fontWeight:700,textDecoration:"none" }}>
                  ↺ Retry generation
                </Link>
                <span style={{ fontSize:"11px",color:"var(--app-text-muted)",alignSelf:"center" }}>
                  Page was refreshed or connection was lost during generation.
                </span>
              </>
            ) : selectedUrls.size > 0 ? (
              // Pin selection active: add selected
              <>
                <button type="button"
                  onClick={() => {
                    const toAdd = [...selectedUrls].filter(u => !planUrls.has(u));
                    console.log("[AddToPlan] selected pin count", toAdd.length, "session", entry.id);
                    addToPlan(toAdd);
                  }}
                  style={{ padding:"5px 14px",borderRadius:8,border:"none",background:"linear-gradient(135deg,#FF4D8D,#7C3AED)",color:"#fff",fontSize:"11px",fontWeight:700,cursor:"pointer" }}>
                  Add {selectedUrls.size} selected to Plan
                </button>
                <button type="button" onClick={() => setSelectedUrls(new Set())}
                  style={{ padding:"5px 12px",borderRadius:8,border:"1px solid var(--app-border)",background:"var(--app-surface)",color:"var(--app-text-muted)",fontSize:"11px",fontWeight:600,cursor:"pointer" }}>
                  Clear
                </button>
              </>
            ) : (
              // Default action bar
              <>
                {allPins.length > 0 && (added < allPins.length ? (
                  <button type="button"
                    onClick={() => {
                      console.log("[AddToPlan] selected pin count", notAdded.length, "session", entry.id);
                      addToPlan(notAdded);
                    }}
                    style={{ padding:"5px 14px",borderRadius:8,border:"none",background:"linear-gradient(135deg,#FF4D8D,#7C3AED)",color:"#fff",fontSize:"11px",fontWeight:700,cursor:"pointer" }}>
                    {added > 0 ? `Add remaining ${notAdded.length} to Plan` : "+ Add all to Plan"}
                  </button>
                ) : (
                  <Link href="/app/plan"
                    style={{ padding:"5px 14px",borderRadius:8,border:"1px solid rgba(5,150,105,0.3)",background:"rgba(5,150,105,0.06)",color:"#059669",fontSize:"11px",fontWeight:700,textDecoration:"none" }}>
                    View in Weekly Plan →
                  </Link>
                ))}
                {/* Retry failed groups for partial/interrupted with some images */}
                {(genStatus === "partial" || isInterrupted) && failedRefs.length > 0 && (
                  <Link href={retryUrl}
                    style={{ padding:"5px 14px",borderRadius:8,border:"1px solid rgba(217,119,6,0.3)",background:"rgba(217,119,6,0.06)",color:"#D97706",fontSize:"11px",fontWeight:700,textDecoration:"none" }}>
                    ↺ Retry {failedRefs.length} failed group{failedRefs.length !== 1 ? "s" : ""}
                  </Link>
                )}
                <Link href={studioUrl}
                  style={{ padding:"5px 14px",borderRadius:8,border:"none",background:"#7C3AED",color:"#fff",fontSize:"11px",fontWeight:700,textDecoration:"none",display:"flex",alignItems:"center",gap:5 }}>
                  ✦ Create More from this setup
                </Link>
                {allPins.length > 0 && (
                  <button type="button" onClick={downloadAll}
                    style={{ padding:"5px 14px",borderRadius:8,border:"1px solid var(--app-border)",background:"var(--app-surface)",color:"var(--app-text-sec)",fontSize:"11px",fontWeight:600,cursor:"pointer" }}>
                    ↓ Download all
                  </button>
                )}
              </>
            )}
          </div>
        </div>

        {/* ── Body: two-column ── */}
        <div style={{ flex:1,overflowY:"auto",display:"flex",minHeight:0 }}>

          {/* ── Left column: session context ── */}
          <div style={{ width:280,flexShrink:0,borderRight:"1px solid var(--app-surface-3)",overflowY:"auto",padding:"16px 18px",display:"flex",flexDirection:"column",gap:16 }}>

            {/* Session Summary */}
            <div>
              <p style={{ margin:"0 0 8px",fontSize:"11px",fontWeight:800,color:"var(--app-text-sec)",textTransform:"uppercase",letterSpacing:"0.07em" }}>
                Session Summary
              </p>
              <div style={{ display:"flex",flexDirection:"column",gap:5 }}>
                {[
                  ["Opportunity",    entry.opportunity ?? entry.keyword ?? "—"],
                  ["Mode",           entry.mode === "product_led" ? "Product-led" : entry.mode === "plan" ? "Weekly plan" : entry.mode === "batch" ? "Batch" : "Keyword-led"],
                  ["Status",         null as null],
                  ["Expected",       `${expectedTotal} pin${expectedTotal !== 1 ? "s" : ""}`],
                  ["Actual",         `${allPins.length} pin${allPins.length !== 1 ? "s" : ""}`],
                  ["Images / ref",   entry.imagesPerRef ? String(entry.imagesPerRef) : "—"],
                  ["Created",        fmtDate(entry.savedAt)],
                ].map(([k, v]) => (
                  <div key={String(k)} style={{ display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:8 }}>
                    <span style={{ fontSize:"10px",color:"var(--app-text-muted)",flexShrink:0 }}>{k}</span>
                    {k === "Status" ? (
                      <GenStatusBadge status={genStatus}/>
                    ) : (
                      <span style={{ fontSize:"10px",fontWeight:600,color:"var(--app-text-sec)",textAlign:"right",textTransform:k === "Opportunity" || k === "Mode" ? "capitalize" : "none" }}>
                        {String(v)}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* Products */}
            <div>
              <p style={{ margin:"0 0 8px",fontSize:"11px",fontWeight:800,color:"var(--app-text-sec)",textTransform:"uppercase",letterSpacing:"0.07em" }}>
                Products ({displayProducts?.length ?? entry.productCount})
              </p>
              {displayProducts?.length ? (
                <div style={{ display:"flex",flexDirection:"column",gap:5 }}>
                  {displayProducts.map((p, i) => (
                    <div key={i} style={{ display:"flex",alignItems:"center",gap:8,padding:"6px 8px",borderRadius:7,border:"1px solid var(--app-surface-3)",background:"var(--app-surface-2)" }}>
                      <div style={{ width:30,height:30,borderRadius:5,overflow:"hidden",border:"1px solid var(--app-border)",flexShrink:0,background:"var(--app-surface-3)" }}>
                        {p.imageUrl
                          /* eslint-disable-next-line @next/next/no-img-element */
                          ? <img src={toProxyUrl(p.imageUrl)} alt={p.title}
                              style={{ width:"100%",height:"100%",objectFit:"cover" }}
                              onError={e => { e.currentTarget.style.opacity="0"; }}/>
                          : <div style={{ width:"100%",height:"100%",display:"flex",alignItems:"center",justifyContent:"center" }}>
                              <span style={{ fontSize:"9px",color:"var(--app-text-muted)",fontWeight:700 }}>{i+1}</span>
                            </div>}
                      </div>
                      <div style={{ flex:1,minWidth:0 }}>
                        <p style={{ margin:0,fontSize:"11px",fontWeight:600,color:"var(--app-text-sec)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{p.title}</p>
                        {p.source && <p style={{ margin:"1px 0 0",fontSize:"10px",color:"var(--app-text-muted)" }}>{p.source.replace(/^www\./,"").split(".")[0]}</p>}
                      </div>
                    </div>
                  ))}
                </div>
              ) : displayProductNames.length > 0 ? (
                <div style={{ display:"flex",flexDirection:"column",gap:4 }}>
                  {displayProductNames.map((name, i) => (
                    <div key={i} style={{ display:"flex",alignItems:"center",gap:6,padding:"5px 8px",borderRadius:7,border:"1px solid var(--app-surface-3)",background:"var(--app-surface-2)" }}>
                      <div style={{ width:22,height:22,borderRadius:4,background:"var(--app-border)",flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center" }}>
                        <span style={{ fontSize:"9px",color:"var(--app-text-muted)",fontWeight:700 }}>{i+1}</span>
                      </div>
                      <p style={{ margin:0,fontSize:"11px",fontWeight:600,color:"var(--app-text-sec)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{name}</p>
                    </div>
                  ))}
                </div>
              ) : (
                <p style={{ margin:0,fontSize:"11px",color:"var(--app-text-muted)" }}>
                  {entry.productCount > 0
                    ? `${entry.productCount} product${entry.productCount !== 1 ? "s" : ""} used`
                    : isLegacy ? "Not captured in this older session" : "No products used"}
                </p>
              )}
            </div>

            {/* References */}
            <div>
              <p style={{ margin:"0 0 8px",fontSize:"11px",fontWeight:800,color:"var(--app-text-sec)",textTransform:"uppercase",letterSpacing:"0.07em" }}>
                References ({displayRefs?.length ?? (refUrls.length || entry.refCount)})
              </p>
              {displayRefs && displayRefs.length > 0 ? (
                <div style={{ display:"flex",flexDirection:"column",gap:6 }}>
                  {displayRefs.map((ref, i) => {
                    const vf  = ref.visualFormat;
                    const hp  = ref.humanPresence;
                    const src = (ref as { source?: string }).source;
                    const isUpload = src === "user_upload"
                      || ref.imageUrl?.startsWith("data:")
                      || ref.imageUrl?.startsWith("blob:");
                    const fmtLabel =
                      isUpload         ? "Uploaded"     :
                      vf === "on_body"       ? "On-body"      :
                      vf === "mirror_selfie" ? "Mirror style"  :
                      vf === "flat_lay"      ? "Flat lay"      :
                      vf === "room_scene"    ? "Room scene"    :
                      vf === "product_only"  ? "Product only"  : null;
                    const hpLabel =
                      hp === "visible_person" ? "Person" :
                      hp === "no_person"      ? "No person" : null;
                    const badgeColor =
                      isUpload        ? "#059669" :
                      vf === "flat_lay" || vf === "product_only" || hp === "no_person" ? "#2563EB" :
                      "#7C3AED";
                    // Suppress imageUrl if it's a data URL (too long to render as src for proxy)
                    const displayUrl = ref.imageUrl?.startsWith("data:") ? ref.imageUrl : toProxyUrl(ref.imageUrl);
                    return (
                      <div key={i} style={{ display:"flex",alignItems:"center",gap:8 }}>
                        <div style={{ position:"relative",flexShrink:0 }}>
                          <div style={{ width:40,height:56,borderRadius:6,overflow:"hidden",border:"1px solid var(--app-border)",background:"var(--app-surface-3)" }}>
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={displayUrl} alt={`Ref ${i+1}`}
                              style={{ width:"100%",height:"100%",objectFit:"cover" }}
                              onError={e => { e.currentTarget.style.opacity="0"; }}/>
                          </div>
                          <div style={{ position:"absolute",top:2,left:2,width:14,height:14,borderRadius:"50%",background:"#7C3AED",display:"flex",alignItems:"center",justifyContent:"center" }}>
                            <span style={{ fontSize:"7px",fontWeight:800,color:"#fff" }}>{i+1}</span>
                          </div>
                        </div>
                        <div style={{ display:"flex",flexDirection:"column",gap:3 }}>
                          {fmtLabel && (
                            <span style={{ fontSize:"9px",fontWeight:700,color:badgeColor,background:`${badgeColor}12`,padding:"1px 6px",borderRadius:4,whiteSpace:"nowrap",alignSelf:"flex-start",border:`1px solid ${badgeColor}25` }}>
                              {fmtLabel}{hpLabel && ` / ${hpLabel}`}
                            </span>
                          )}
                          {!fmtLabel && hpLabel && (
                            <span style={{ fontSize:"9px",fontWeight:700,color:"#7C3AED",background:"rgba(124,58,237,0.08)",padding:"1px 6px",borderRadius:4,whiteSpace:"nowrap",alignSelf:"flex-start" }}>
                              {hpLabel}
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p style={{ margin:0,fontSize:"11px",color:"var(--app-text-muted)" }}>
                  {entry.refCount > 0
                    ? `${entry.refCount} reference${entry.refCount !== 1 ? "s" : ""} used`
                    : isLegacy ? "Not captured in this older session" : "No references"}
                </p>
              )}
            </div>

            {/* No text overlay */}
            <div style={{ padding:"8px 10px",borderRadius:8,background:"rgba(5,150,105,0.06)",border:"1px solid rgba(5,150,105,0.15)",display:"flex",alignItems:"center",gap:6 }}>
              <CheckCircle2 style={{ width:12,height:12,color:"#059669",flexShrink:0 }}/>
              <span style={{ fontSize:"11px",color:"#059669",fontWeight:600 }}>No text overlay</span>
            </div>

            {/* Prompt */}
            <div>
              <p style={{ margin:"0 0 6px",fontSize:"11px",fontWeight:800,color:"var(--app-text-sec)",textTransform:"uppercase",letterSpacing:"0.07em" }}>
                Prompt Snapshot
              </p>
              {displayPrompt ? (
                <PromptSnapshot excerpt={displayPrompt.slice(0,140)} full={displayPrompt}/>
              ) : (
                <p style={{ margin:0,fontSize:"11px",color:"var(--app-text-muted)" }}>
                  {isLegacy ? "Not captured in this older session" : "Not available"}
                </p>
              )}
            </div>
          </div>

          {/* ── Right column: outputs by reference group ── */}
          <div style={{ flex:1,overflowY:"auto",padding:"16px 20px" }}>

            {/* Partial/failed warning */}
            {genStatus === "partial" && (
              <div style={{ marginBottom:14,padding:"10px 14px",borderRadius:8,background:"rgba(217,119,6,0.07)",border:"1px solid rgba(217,119,6,0.2)",display:"flex",alignItems:"center",gap:8 }}>
                <span style={{ fontSize:"13px" }}>⚠</span>
                <p style={{ margin:0,fontSize:"12px",color:"#92400E",fontWeight:600 }}>
                  This session produced fewer pins than expected ({allPins.length} of {expectedTotal}).
                </p>
              </div>
            )}
            {genStatus === "failed" && (
              <div style={{ marginBottom:14,padding:"10px 14px",borderRadius:8,background:"rgba(239,68,68,0.07)",border:"1px solid rgba(239,68,68,0.2)",display:"flex",alignItems:"center",gap:8 }}>
                <span style={{ fontSize:"13px" }}>✕</span>
                <p style={{ margin:0,fontSize:"12px",color:"#991B1B",fontWeight:600 }}>
                  This session failed to generate any pins.
                </p>
              </div>
            )}

            <p style={{ margin:"0 0 12px",fontSize:"11px",fontWeight:800,color:"var(--app-text-sec)",textTransform:"uppercase",letterSpacing:"0.07em",display:"flex",alignItems:"center",gap:8 }}>
              Outputs by Reference Group
              <span style={{ fontWeight:500,fontSize:"10px",color:"var(--app-text-muted)",textTransform:"none",letterSpacing:"normal" }}>
                {allPins.length} of {expectedTotal} pins generated
              </span>
              <span style={{ marginLeft:"auto",fontSize:"10px",color:genStatus==="completed"?"#059669":"#D97706",fontWeight:600,textTransform:"none",letterSpacing:"normal" }}>
                {genStatus === "completed" ? "✓ Generated" : genStatus === "partial" ? "⚠ Missing" : "✕ Failed"}
              </span>
            </p>

            {entry.groups.map((group, gi) => {
              const perGroupExpected = entry.imagesPerRef
                ?? (expectedTotal > 0 && entry.refCount > 0 ? Math.round(expectedTotal / entry.refCount) : entry.imagesPerRef ?? 2);
              const groupActual  = group.images.length;
              const groupStatus  = groupActual >= perGroupExpected ? "ok" : groupActual > 0 ? "partial" : "missing";
              const groupPins    = group.images.map(toProxyUrl);

              return (
                <div key={gi} style={{ marginBottom: gi < entry.groups.length - 1 ? 24 : 0 }}>
                  {/* Group header */}
                  <div style={{ display:"flex",alignItems:"center",gap:10,marginBottom:8 }}>
                    {group.refUrl ? (
                      <div style={{ width:28,height:40,borderRadius:5,overflow:"hidden",border:"1px solid var(--app-border)",flexShrink:0,background:"var(--app-surface-3)",position:"relative" }}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={toProxyUrl(group.refUrl)} alt=""
                          style={{ width:"100%",height:"100%",objectFit:"cover" }}/>
                        <div style={{ position:"absolute",top:2,left:2,width:12,height:12,borderRadius:"50%",background:"#7C3AED",display:"flex",alignItems:"center",justifyContent:"center" }}>
                          <span style={{ fontSize:"7px",fontWeight:800,color:"#fff" }}>{gi+1}</span>
                        </div>
                      </div>
                    ) : (
                      <div style={{ width:28,height:40,borderRadius:5,border:"1px dashed var(--app-border)",background:"var(--app-bg)",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0 }}>
                        <span style={{ fontSize:"9px",color:"var(--app-text-muted)" }}>{gi+1}</span>
                      </div>
                    )}
                    <div style={{ flex:1,minWidth:0 }}>
                      <div style={{ display:"flex",alignItems:"center",gap:6,flexWrap:"wrap" }}>
                        <p style={{ margin:0,fontSize:"12px",fontWeight:700,color:"var(--app-text)" }}>Reference {gi+1}</p>
                        {(() => {
                          const vf = group.visualFormat;
                          const hp = group.humanPresence;
                          const vfLabel =
                            vf === "on_body"       ? "On-body"      :
                            vf === "mirror_selfie" ? "Mirror style"  :
                            vf === "flat_lay"      ? "Flat lay"      :
                            vf === "room_scene"    ? "Room scene"    :
                            vf === "product_only"  ? "Product only"  : null;
                          const hpLabel =
                            hp === "visible_person" ? "Person" :
                            hp === "no_person"      ? "No person" : null;
                          const label = [vfLabel, hpLabel].filter(Boolean).join(" / ");
                          if (!label) return null;
                          return (
                            <span style={{ fontSize:"9px",fontWeight:700,color:"#7C3AED",background:"rgba(124,58,237,0.08)",padding:"1px 6px",borderRadius:4,whiteSpace:"nowrap" }}>
                              {label}
                            </span>
                          );
                        })()}
                      </div>
                      <p style={{ margin:"2px 0 0",fontSize:"10px",color:"var(--app-text-muted)" }}>
                        {groupActual} of {perGroupExpected} generated
                      </p>
                    </div>
                    <span style={{
                      fontSize:"9px",fontWeight:700,padding:"2px 7px",borderRadius:20,flexShrink:0,
                      background: groupStatus === "ok" ? "rgba(5,150,105,0.08)" : groupStatus === "partial" ? "rgba(217,119,6,0.08)" : "rgba(239,68,68,0.08)",
                      color:      groupStatus === "ok" ? "#059669"              : groupStatus === "partial" ? "#D97706"              : "#EF4444",
                      border:     `1px solid ${groupStatus === "ok" ? "rgba(5,150,105,0.2)" : groupStatus === "partial" ? "rgba(217,119,6,0.2)" : "rgba(239,68,68,0.2)"}`,
                    }}>
                      {groupStatus === "ok" ? "✓ Generated" : groupStatus === "partial" ? "⚠ Partial" : "✗ Missing"}
                    </span>
                    <div style={{ flex:1,height:1,background:"var(--app-surface-3)",marginLeft:8 }}/>
                  </div>

                  {/* Pin grid or empty state */}
                  {groupPins.length > 0 ? (
                    <div style={{ display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(120px,1fr))",gap:8 }}>
                      {groupPins.map((src, imgIdx) => {
                        const orig    = group.images[imgIdx];
                        const inPlan  = planUrls.has(orig);
                        const sel     = selectedUrls.has(orig);
                        return (
                          <div key={imgIdx}
                            onClick={() => togglePin(orig)}
                            style={{
                              borderRadius:10,overflow:"hidden",cursor:"pointer",
                              border:`2px solid ${sel ? "#C026D3" : inPlan ? "rgba(5,150,105,0.3)" : "var(--app-surface-3)"}`,
                              background:"var(--app-surface-2)",display:"flex",flexDirection:"column",
                            }}>
                            <div style={{ aspectRatio:"2/3",position:"relative",background:"var(--app-border)",overflow:"hidden" }}>
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img src={src} alt=""
                                style={{ width:"100%",height:"100%",objectFit:"cover" }}
                                onError={e => { e.currentTarget.style.opacity = "0"; }}/>
                              {/* Checkbox */}
                              <div style={{
                                position:"absolute",top:5,left:5,width:16,height:16,borderRadius:4,
                                background:sel?"#C026D3":"rgba(255,255,255,0.92)",
                                border:`2px solid ${sel?"#C026D3":"rgba(0,0,0,0.15)"}`,
                                display:"flex",alignItems:"center",justifyContent:"center",
                              }}>
                                {sel && <span style={{ fontSize:9,color:"#fff",fontWeight:800 }}>✓</span>}
                              </div>
                              <span style={{
                                position:"absolute",bottom:4,right:4,fontSize:"8px",fontWeight:700,padding:"1px 5px",borderRadius:6,
                                background: inPlan ? "rgba(5,150,105,0.9)" : "rgba(255,255,255,0.88)",
                                color: inPlan ? "#fff" : "var(--app-text-sec)",
                              }}>
                                {inPlan ? "✓" : `#${gi * (entry.imagesPerRef ?? 2) + imgIdx + 1}`}
                              </span>
                            </div>
                            <div style={{ display:"flex",gap:1,padding:"3px 2px",borderTop:"1px solid var(--app-surface-3)",justifyContent:"space-around" }}>
                              <button type="button" onClick={e => { e.stopPropagation(); openPinDetails(orig, gi, imgIdx); }}
                                style={{ flex:1,background:"none",border:"none",cursor:"pointer",fontSize:"9px",color:"#A78BFA",fontWeight:700,padding:"2px 0" }}>
                                Details
                              </button>
                              <button type="button" onClick={e => { e.stopPropagation(); setPreview(src); }}
                                style={{ flex:1,background:"none",border:"none",cursor:"pointer",fontSize:"9px",color:"#9CA3AF",fontWeight:600,padding:"2px 0" }}>
                                View
                              </button>
                              <a href={src} download={`pin-g${gi+1}-${imgIdx+1}.jpg`}
                                onClick={e => e.stopPropagation()}
                                style={{ flex:1,textAlign:"center",textDecoration:"none",fontSize:"9px",color:"#9CA3AF",fontWeight:600,padding:"2px 0",lineHeight:"1.8" }}>
                                ↓ DL
                              </a>
                              {inPlan ? (
                                <Link href="/app/plan" onClick={e => e.stopPropagation()}
                                  style={{ flex:1,textAlign:"center",textDecoration:"none",fontSize:"9px",color:"#059669",fontWeight:700,padding:"2px 0",lineHeight:"1.8" }}>
                                  Plan →
                                </Link>
                              ) : (
                                <button type="button" onClick={e => { e.stopPropagation(); addToPlan([orig]); setPlanUrls(prev => new Set([...prev, orig])); }}
                                  style={{ flex:1,background:"none",border:"none",cursor:"pointer",fontSize:"9px",color:"#C026D3",fontWeight:700,padding:"2px 0" }}>
                                  + Plan
                                </button>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div style={{ padding:"18px",borderRadius:10,border:"1.5px dashed #FCA5A5",background:"rgba(239,68,68,0.03)",textAlign:"center" }}>
                      <p style={{ margin:"0 0 4px",fontSize:"12px",fontWeight:700,color:"#EF4444" }}>No pins generated yet</p>
                      <p style={{ margin:"0 0 10px",fontSize:"11px",color:"var(--app-text-muted)" }}>
                        This reference group did not produce any outputs.
                      </p>
                      <Link href={studioUrl}
                        style={{ padding:"5px 12px",borderRadius:7,border:"none",background:"linear-gradient(135deg,#FF4D8D,#7C3AED)",color:"#fff",fontSize:"11px",fontWeight:700,textDecoration:"none" }}>
                        Retry with this setup
                      </Link>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Lightbox */}
      {preview && (
        <div onClick={() => setPreview(null)}
          style={{ position:"fixed",inset:0,zIndex:70,background:"rgba(0,0,0,0.9)",display:"flex",alignItems:"center",justifyContent:"center" }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={preview} alt="" onClick={e => e.stopPropagation()}
            style={{ maxHeight:"90vh",maxWidth:"min(500px,90vw)",borderRadius:12,objectFit:"contain" }}/>
          <button type="button" onClick={() => setPreview(null)}
            style={{ position:"fixed",top:16,right:16,width:36,height:36,borderRadius:"50%",background:"rgba(255,255,255,0.15)",border:"none",cursor:"pointer",fontSize:16,color:"#fff" }}>
            ✕
          </button>
        </div>
      )}
      <PinDetailsModal
        draft={detailsDraft}
        open={detailsDraft !== null}
        source="my_pins"
        mode="details"
        onClose={() => setDetailsDraft(null)}
        onSaved={setDetailsDraft}
      />
    </>
  );
}

// ── Session card ──────────────────────────────────────────────────────────────
function SessionCard({
  entry, selected, onToggleSelect, onOpen,
}: {
  entry: HistoryEntry;
  selected: boolean;
  onToggleSelect: (e: React.MouseEvent) => void;
  onOpen: () => void;
}) {
  const allPins   = entry.groups.flatMap((g: PinGroup) => g.images);
  const thumbs    = allPins.slice(0, 4);
  const extra     = allPins.length > 4 ? allPins.length - 4 : 0;
  const title     = (entry.opportunity ?? entry.keyword) ? capWords(entry.opportunity ?? entry.keyword) : "Generated Session";
  const dateStr   = fmtDateShort(entry.savedAt);
  const planStatus = getPlanStatus(entry);
  const genStatus  = deriveEntryStatus(entry);
  const expectedTotal = entry.expectedTotal ?? allPins.length;

  const notAdded = allPins.filter(u => {
    const pins = pinStore.getSessionPins(entry.id);
    return !pins.find(p => p.imageUrl === u && p.status !== "generated");
  });
  const isRunning      = genStatus === "running";
  const isInterrupted  = genStatus === "interrupted";
  const canAddToPlan   = !isRunning && allPins.length > 0; // running 0-image: no add
  const failedRefUrls  = getFailedRefUrls(entry);
  const hasRetriable   = (genStatus === "partial" || isInterrupted) && failedRefUrls.length > 0;

  function addAllToPlan(e: React.MouseEvent) {
    e.stopPropagation();
    console.log("[AddToPlan] selected pin count", notAdded.length, "session", entry.id);
    addUrlsToPlan(entry, notAdded);
    window.dispatchEvent(new Event("vp:pin_store_updated"));
  }

  return (
    <div data-testid="generated-pin-card" onClick={onOpen}
      style={{
        background:"var(--app-surface)",borderRadius:14,overflow:"hidden",
        border: selected ? "2px solid #C026D3"
          : isRunning ? "1px solid rgba(192,38,211,0.3)"
          : isInterrupted ? "1px solid #E2E8F0"
          : "1px solid var(--app-border)",
        cursor:"pointer",transition:"box-shadow 0.15s,transform 0.15s",
        display:"flex",flexDirection:"column",position:"relative",
      }}
      onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.boxShadow = "0 4px 20px rgba(0,0,0,0.1)"; (e.currentTarget as HTMLDivElement).style.transform = "translateY(-1px)"; }}
      onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.boxShadow = "none"; (e.currentTarget as HTMLDivElement).style.transform = "none"; }}
    >
      {/* Checkbox */}
      <div data-testid="generated-pin-checkbox" onClick={onToggleSelect}
        style={{
          position:"absolute",top:8,left:8,zIndex:10,
          width:20,height:20,borderRadius:6,
          background: selected ? "#C026D3" : "rgba(255,255,255,0.92)",
          border:`2px solid ${selected ? "#C026D3" : "rgba(0,0,0,0.15)"}`,
          display:"flex",alignItems:"center",justifyContent:"center",
          transition:"all 0.12s",cursor:"pointer",boxShadow:"0 1px 3px rgba(0,0,0,0.12)",
        }}>
        {selected && <span style={{ fontSize:11,color:"#fff",fontWeight:800,lineHeight:1 }}>✓</span>}
      </div>

      {/* Thumbnail grid */}
      <div style={{
        display:"grid",
        gridTemplateColumns: thumbs.length >= 2 ? "1fr 1fr" : "1fr",
        gridTemplateRows:    thumbs.length >= 3 ? "1fr 1fr" : "1fr",
        aspectRatio:"4/3",background:"var(--app-surface-3)",overflow:"hidden",gap:1,
      }}>
        {thumbs.length === 0 ? (
          <div style={{ display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",background:isRunning?"rgba(192,38,211,0.04)":isInterrupted?"var(--app-surface-2)":"var(--app-bg)",gap:6 }}>
            {isRunning ? (
              <>
                <div style={{ width:20,height:20,border:"2px solid rgba(192,38,211,0.3)",borderTopColor:"#C026D3",borderRadius:"50%",animation:"spin 0.8s linear infinite" }}/>
                <span style={{ fontSize:"9px",color:"#C026D3",fontWeight:700 }}>Generating…</span>
              </>
            ) : isInterrupted ? (
              <>
                <span style={{ fontSize:"14px" }}>⚡</span>
                <span style={{ fontSize:"9px",color:"var(--app-text-muted)",fontWeight:600,textAlign:"center",padding:"0 8px" }}>Interrupted</span>
              </>
            ) : (
              <svg width="28" height="28" fill="none" stroke="#CBD5E1" strokeWidth={1.5} viewBox="0 0 24 24">
                <rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/>
                <path d="m21 15-5-5L5 21" strokeLinecap="round"/>
              </svg>
            )}
          </div>
        ) : thumbs.map((src, i) => {
          const isLast = i === thumbs.length - 1 && extra > 0;
          return (
            <div key={i} style={{ position:"relative",overflow:"hidden",background:"var(--app-border)" }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={toProxyUrl(src)} alt="" style={{ width:"100%",height:"100%",objectFit:"cover",display:"block" }}
                onError={e => { e.currentTarget.style.opacity = "0"; }}/>
              {isLast && (
                <div style={{ position:"absolute",inset:0,background:"rgba(15,23,42,0.55)",display:"flex",alignItems:"center",justifyContent:"center" }}>
                  <span style={{ fontSize:"15px",fontWeight:800,color:"#fff" }}>+{extra}</span>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Card footer */}
      <div style={{ padding:"11px 13px 10px",display:"flex",flexDirection:"column",gap:5,flex:1 }}>
        <div style={{ display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:8 }}>
          <p style={{ margin:0,fontSize:"12px",fontWeight:700,color:"var(--app-text)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",flex:1,textTransform:"capitalize" }}>
            {title}
          </p>
          <span style={{ fontSize:"10px",color:"var(--app-text-muted)",flexShrink:0,paddingTop:1 }}>{dateStr}</span>
        </div>

        {/* Context chips */}
        <div style={{ display:"flex",alignItems:"center",gap:5,flexWrap:"wrap" }}>
          {entry.productCount > 0 && (
            <span style={{ fontSize:"9px",color:"var(--app-text-sec)",background:"var(--app-surface-3)",padding:"1px 6px",borderRadius:20,fontWeight:600 }}>
              {entry.productCount} product{entry.productCount !== 1 ? "s" : ""}
            </span>
          )}
          {entry.refCount > 0 && (
            <span style={{ fontSize:"9px",color:"var(--app-text-sec)",background:"var(--app-surface-3)",padding:"1px 6px",borderRadius:20,fontWeight:600 }}>
              {entry.refCount} ref{entry.refCount !== 1 ? "s" : ""}
            </span>
          )}
        </div>

        {/* Pin count + generation status badge */}
        <div style={{ display:"flex",alignItems:"center",gap:5,flexWrap:"wrap" }}>
          <span style={{ fontSize:"9px",fontWeight:700,color: isRunning ? "#C026D3" : genStatus === "partial" ? "#D97706" : genStatus === "failed" || isInterrupted ? "var(--app-text-muted)" : "var(--app-text-sec)" }}>
            {isRunning
              ? `Generating ${allPins.length} / ${expectedTotal} pins`
              : `${allPins.length} / ${expectedTotal} generated`}
          </span>
          <GenStatusBadge status={genStatus}/>
        </div>

        {/* Running progress bar */}
        {isRunning && expectedTotal > 0 && (
          <div style={{ height:3,background:"var(--app-surface-3)",borderRadius:2,overflow:"hidden" }}>
            <div style={{
              height:"100%",borderRadius:2,
              width:`${Math.min(100, Math.round((allPins.length / expectedTotal) * 100))}%`,
              background:"linear-gradient(90deg,#FF4D8D,#7C3AED)",
              transition:"width 0.4s",
            }}/>
          </div>
        )}

        {/* Plan status — dual display with gen status, only when there are pins */}
        {canAddToPlan && (
          <div style={{ display:"flex",alignItems:"center",gap:4 }}>
            <span style={{ fontSize:"9px",color:"var(--app-text-muted)" }}>·</span>
            {planStatus === "all" ? (
              <span style={{ fontSize:"9px",fontWeight:700,color:"#059669" }}>✓ Added to plan</span>
            ) : planStatus === "partial" ? (
              <span style={{ fontSize:"9px",fontWeight:600,color:"#D97706" }}>
                {allPins.length - notAdded.length}/{allPins.length} added
              </span>
            ) : (
              <span style={{ fontSize:"9px",color:"var(--app-text-muted)" }}>Not added</span>
            )}
          </div>
        )}

        {/* Error type notice — shown on failed/partial/interrupted with no images */}
        {(isInterrupted || genStatus === "failed" || (genStatus === "partial" && allPins.length === 0)) && entry.errorType && (
          <p style={{ margin:0,fontSize:"9px",color:"#EF4444",lineHeight:1.4,fontWeight:600 }}>
            {getErrorCopy(entry.errorType).label}
          </p>
        )}
        {isInterrupted && !entry.errorType && allPins.length === 0 && (
          <p style={{ margin:0,fontSize:"9px",color:"var(--app-text-muted)",lineHeight:1.4 }}>
            Page was refreshed or connection lost.
          </p>
        )}

        {/* Actions */}
        <div style={{ display:"flex",gap:5,marginTop:"auto" }} onClick={e => e.stopPropagation()}>
          {isRunning ? (
            // Running: view progress only; no Add to Plan
            <Link href="/app/history"
              style={{ flex:1,padding:"5px 0",borderRadius:7,border:"1px solid rgba(192,38,211,0.25)",background:"rgba(192,38,211,0.06)",color:"#C026D3",fontSize:"10px",fontWeight:700,textDecoration:"none",textAlign:"center" }}>
              View progress →
            </Link>
          ) : isInterrupted && allPins.length === 0 ? (
            // Interrupted with no images: retry only
            <Link href={buildStudioUrl(entry, "retry")}
              style={{ flex:1,padding:"5px 0",borderRadius:7,border:"none",background:"linear-gradient(135deg,#FF4D8D,#7C3AED)",color:"#fff",fontSize:"10px",fontWeight:700,textDecoration:"none",textAlign:"center" }}>
              Retry generation
            </Link>
          ) : planStatus === "all" ? (
            // All added
            <Link href="/app/plan"
              style={{ flex:1,padding:"5px 0",borderRadius:7,border:"1px solid rgba(5,150,105,0.25)",background:"rgba(5,150,105,0.06)",color:"#059669",fontSize:"10px",fontWeight:700,textDecoration:"none",textAlign:"center" }}>
              View in Plan →
            </Link>
          ) : canAddToPlan ? (
            // Has generated pins that aren't all added yet
            <button type="button" onClick={addAllToPlan}
              style={{ flex:1,padding:"5px 0",borderRadius:7,border:"none",background:"linear-gradient(135deg,#FF4D8D,#7C3AED)",color:"#fff",fontSize:"10px",fontWeight:700,cursor:"pointer" }}>
              {planStatus === "partial" ? `Add remaining ${notAdded.length}` : "Add all to Plan"}
            </button>
          ) : (
            // Failed/interrupted 0 images: retry
            <Link href={buildStudioUrl(entry, "retry")}
              style={{ flex:1,padding:"5px 0",borderRadius:7,border:"1px solid var(--app-border)",background:"var(--app-bg)",color:"var(--app-text-sec)",fontSize:"10px",fontWeight:600,textDecoration:"none",textAlign:"center" }}>
              Retry setup →
            </Link>
          )}
          {/* Show retry-failed alongside add-to-plan for partial sessions with known failed refs */}
          {hasRetriable && canAddToPlan && (
            <Link href={buildStudioUrl(entry, "retry")} onClick={e => e.stopPropagation()}
              style={{ padding:"5px 8px",borderRadius:7,border:"1px solid rgba(217,119,6,0.3)",background:"rgba(217,119,6,0.06)",color:"#D97706",fontSize:"9px",fontWeight:700,textDecoration:"none",whiteSpace:"nowrap" }}>
              Retry failed
            </Link>
          )}
          <button type="button" onClick={e => { e.stopPropagation(); onOpen(); }}
            style={{ padding:"5px 10px",borderRadius:7,border:"1px solid var(--app-border)",background:"var(--app-bg)",color:"var(--app-text-sec)",fontSize:"10px",fontWeight:600,cursor:"pointer" }}>
            Open
          </button>
        </div>
      </div>
    </div>
  );
}

// GenTab: generation status filters + one cross-cutting planning status filter ("added").
// "added" is NOT a generation status — it uses planningStatus (getPlanStatus) to filter
// sessions where at least one pin was added to Weekly Plan.
type GenTab = "all" | "in_progress" | "pending" | "completed" | "partial" | "failed" | "interrupted" | "added";
void (undefined as unknown as GenerationStatus); // ensure canonical type is imported + used

// Running/interrupted sessions may have 0 images — include them anyway.
function allowHistoryEntry(e: HistoryEntry): boolean {
  const st = deriveEntryStatus(e);
  return e.groups.some((g: PinGroup) => g.images.length > 0) || st === "running" || st === "interrupted";
}

// SWR-cached merge of DB + storage generation history. Keyed globally (one
// signed-in user's history per session) so navigating away from My Pins and
// back reuses the cached result instead of re-hitting Supabase + the
// history-storage API on every remount.
const HISTORY_ENTRIES_SWR_KEY = "history:generations";

async function fetchMergedHistoryEntries(): Promise<HistoryEntry[]> {
  const [db, storage] = await Promise.all([
    fetchGenerationsFromDb(supabase).catch((): HistoryEntry[] => []),
    fetch("/api/history-storage")
      .then(r => r.json())
      .then((d: { entries: HistoryEntry[] }) => d.entries ?? [])
      .catch((): HistoryEntry[] => []),
  ]);
  return mergeHistoryEntries(db, loadHistory(), storage).filter(allowHistoryEntry);
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function GeneratedPinsPage() {
  const { t: tr } = useLocale();
  // Instant local snapshot (localStorage-backed) shown immediately on mount and
  // while the SWR cache above is cold; superseded by `mergedEntries` once ready.
  const [localEntries, setLocalEntries] = useState<HistoryEntry[]>([]);
  const { data: mergedEntries } = useSWR<HistoryEntry[]>(HISTORY_ENTRIES_SWR_KEY, fetchMergedHistoryEntries, {
    revalidateOnFocus: false,
  });
  const entries = mergedEntries ?? localEntries;
  const loaded  = mergedEntries !== undefined;
  const [search,    setSearch]    = useState("");
  const [tab,       setTab]       = useState<GenTab>("all");
  const [openEntry, setOpenEntry] = useState<HistoryEntry | null>(null);
  const [storeVer,  setStoreVer]  = useState(0);
  const [selected,  setSelected]  = useState<Set<string>>(new Set());

  const reload = useCallback(() => setStoreVer(v => v + 1), []);

  useEffect(() => {
    window.addEventListener("vp:pin_store_updated",          reload);
    window.addEventListener(pinDraftStore.DRAFT_STORE_EVENT, reload);
    return () => {
      window.removeEventListener("vp:pin_store_updated",          reload);
      window.removeEventListener(pinDraftStore.DRAFT_STORE_EVENT, reload);
    };
  }, [reload]);

  useEffect(() => {
    // Resolve stale running sessions (older than 15 min → interrupted). This is a
    // local safety-net check (localStorage-backed), so it still runs fresh on
    // every mount — it's not part of the cached remote fetch above.
    const { staleSessions } = resolveStaleRunningEntries();
    if (staleSessions.length > 0) {
      staleSessions.forEach(sid =>
        updateSessionInDb(supabase, sid, { status: "interrupted", updated_at: new Date().toISOString() }).catch(() => {})
      );
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- instant localStorage snapshot before the SWR cache resolves
    setLocalEntries(loadHistory().filter(allowHistoryEntry));
  }, []);

  useEffect(() => {
    if (mergedEntries) markDataReady("/app/history");
  }, [mergedEntries]);

  void storeVer;

  const filtered = entries.filter(entry => {
    if (search && !entry.keyword?.toLowerCase().includes(search.toLowerCase()) &&
        !entry.opportunity?.toLowerCase().includes(search.toLowerCase())) return false;
    if (tab === "all") return true;
    // "added" filters by planningStatus — how many pins were added to Weekly Plan.
    // This is intentionally a planning status filter, not a generation status filter.
    if (tab === "added") return getPlanStatus(entry) !== "none";
    const genStatus = deriveEntryStatus(entry);
    if (tab === "in_progress")  return genStatus === "running";
    if (tab === "pending")      return genStatus === "pending";
    if (tab === "completed")    return genStatus === "completed";
    if (tab === "partial")      return genStatus === "partial";
    if (tab === "failed")       return genStatus === "failed";
    if (tab === "interrupted")  return genStatus === "interrupted";
    return true;
  });

  const pendingCount      = entries.filter(e => deriveEntryStatus(e) === "pending").length;
  const inProgressCount   = entries.filter(e => deriveEntryStatus(e) === "running").length;
  const completedCount    = entries.filter(e => deriveEntryStatus(e) === "completed").length;
  const partialCount      = entries.filter(e => deriveEntryStatus(e) === "partial").length;
  const failedCount       = entries.filter(e => deriveEntryStatus(e) === "failed").length;
  const interruptedCount  = entries.filter(e => deriveEntryStatus(e) === "interrupted").length;
  // addedCount uses planningStatus (not generationStatus):
  const addedCount        = entries.filter(e => getPlanStatus(e) !== "none").length;

  function toggleSelect(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    setSelected(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }
  function selectAll() {
    setSelected(prev => prev.size === filtered.length ? new Set() : new Set(filtered.map(e => e.id)));
  }
  function bulkAddToPlan() {
    const toAdd = filtered.filter(e => selected.has(e.id));
    for (const entry of toAdd) {
      // Skip sessions that are still running — generation not complete yet.
      const genStatus = deriveEntryStatus(entry);
      if (genStatus === "running" || genStatus === "pending") continue;
      // Only add pins that are actually generated (have a URL in groups[i].images).
      // For partial sessions this naturally excludes failed/missing pins.
      const allPins  = entry.groups.flatMap((g: PinGroup) => g.images);
      const pins     = pinStore.getSessionPins(entry.id);
      const notAdded = allPins.filter(u => !pins.find(p => p.imageUrl === u && p.status !== "generated"));
      addUrlsToPlan(entry, notAdded);
    }
    setSelected(new Set());
    window.dispatchEvent(new Event("vp:pin_store_updated"));
  }

  const selHasUnadded = [...selected].some(id => {
    const e = entries.find(x => x.id === id);
    return e && getPlanStatus(e) !== "all";
  });

  return (
    <div data-testid="generated-pins-page" style={{ display:"flex",flexDirection:"column",height:"100%",background:"var(--app-bg)" }}>

      {/* Page header */}
      <div style={{ padding:"18px 28px 0",borderBottom:"1px solid var(--app-border)",background:"var(--app-surface)",flexShrink:0 }}>
        <div style={{ display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,marginBottom:14 }}>
          <div>
            <p style={{ margin:0,fontSize:"10px",fontWeight:700,textTransform:"uppercase",letterSpacing:"0.1em",color:"var(--app-text-muted)",marginBottom:4 }}>{tr("page.my.title")}</p>
            <h1 style={{ margin:0,fontSize:"19px",fontWeight:800,color:"var(--app-text)" }}>{tr("page.my.title")}</h1>
            <p style={{ margin:"3px 0 0",fontSize:"12px",color:"var(--app-text-sec)" }}>
              {tr("page.my.subtitle")}
            </p>
          </div>
          <Link href="/app/studio"
            style={{ padding:"7px 16px",borderRadius:8,background:"linear-gradient(135deg,#FF4D8D,#7C3AED)",color:"#fff",fontSize:"12px",fontWeight:700,textDecoration:"none",whiteSpace:"nowrap" }}>
            + Create Pins
          </Link>
        </div>

        {/* Search / filter / bulk */}
        {selected.size > 0 ? (
          <div style={{ display:"flex",gap:10,alignItems:"center",paddingBottom:14,flexWrap:"wrap" }}>
            <span style={{ fontSize:"12px",fontWeight:600,color:"var(--app-text-sec)" }}>
              {selected.size} session{selected.size !== 1 ? "s" : ""} selected
            </span>
            {selHasUnadded && (
              <button type="button" data-testid="add-selected-to-plan-button" onClick={bulkAddToPlan}
                style={{ padding:"6px 16px",borderRadius:8,border:"none",background:"linear-gradient(135deg,#FF4D8D,#7C3AED)",color:"#fff",fontSize:"11px",fontWeight:700,cursor:"pointer" }}>
                Add selected to Plan
              </button>
            )}
            <button type="button" onClick={() => setSelected(new Set())}
              style={{ padding:"6px 16px",borderRadius:8,border:"1px solid var(--app-border)",background:"var(--app-surface)",color:"var(--app-text-muted)",fontSize:"11px",fontWeight:600,cursor:"pointer" }}>
              Clear selection
            </button>
          </div>
        ) : (
          <div style={{ display:"flex",gap:10,alignItems:"center",paddingBottom:14,flexWrap:"wrap" }}>
            <div style={{ position:"relative",flex:"1 1 240px",minWidth:0 }}>
              <svg width="14" height="14" fill="none" stroke="var(--app-text-muted)" strokeWidth={2} viewBox="0 0 24 24"
                style={{ position:"absolute",left:10,top:"50%",transform:"translateY(-50%)",pointerEvents:"none" }}>
                <circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35" strokeLinecap="round"/>
              </svg>
              <input value={search} onChange={e => setSearch(e.target.value)}
                placeholder="Search by keyword or opportunity…"
                style={{ width:"100%",boxSizing:"border-box",paddingLeft:32,paddingRight:12,paddingTop:8,paddingBottom:8,borderRadius:8,border:"1px solid var(--app-border)",fontSize:"12px",outline:"none",background:"var(--app-bg)" }}/>
            </div>
            <div style={{ display:"flex",gap:5,flexWrap:"wrap" }}>
              {([
                { key: "all",         label: `All ${entries.length}`                                                          },
                { key: "in_progress", label: inProgressCount  > 0 ? `In progress ${inProgressCount}` : null                   },
                { key: "pending",     label: pendingCount      > 0 ? `Pending ${pendingCount}`        : null                   },
                { key: "completed",   label: `Completed ${completedCount}`                                                     },
                { key: "partial",     label: partialCount      > 0 ? `Partial ${partialCount}`        : null                   },
                { key: "failed",      label: failedCount       > 0 ? `Failed ${failedCount}`          : null                   },
                { key: "interrupted", label: interruptedCount  > 0 ? `Interrupted ${interruptedCount}`: null                   },
                { key: "added",       label: `Added to Plan ${addedCount}`                                          },
              ] as { key: GenTab; label: string | null }[])
                .filter(t => t.label !== null)
                .map(t => (
                  <button key={t.key} type="button" onClick={() => setTab(t.key)}
                    style={{
                      padding:"5px 12px",borderRadius:20,border:"none",cursor:"pointer",
                      fontSize:"11px",fontWeight:600,whiteSpace:"nowrap",
                      background: tab === t.key ? "#7C3AED" : "var(--app-surface-3)",
                      color:      tab === t.key ? "#fff"    : "var(--app-text-sec)",
                    }}>
                    {t.label}
                  </button>
                ))
              }
            </div>
            {filtered.length > 0 && (
              <button type="button" onClick={selectAll}
                style={{ padding:"5px 12px",borderRadius:20,border:"1px solid var(--app-border)",background:"var(--app-surface)",color:"var(--app-text-sec)",fontSize:"11px",fontWeight:600,cursor:"pointer",whiteSpace:"nowrap" }}>
                {selected.size === filtered.length && filtered.length > 0 ? "Deselect all" : "Select all"}
              </button>
            )}
          </div>
        )}
      </div>

      {/* Card grid */}
      <div style={{ flex:1,overflowY:"auto",padding:"24px 28px" }}>
        {!loaded && entries.length === 0 ? (
          <div style={{ display:"flex",alignItems:"center",justifyContent:"center",height:200 }}>
            <div style={{ textAlign:"center" }}>
              <div style={{ width:20,height:20,border:"2px solid var(--app-border)",borderTopColor:"#7C3AED",borderRadius:"50%",animation:"spin 0.8s linear infinite",margin:"0 auto 10px" }}/>
              <p style={{ fontSize:"12px",color:"var(--app-text-muted)" }}>Loading your generation history…</p>
            </div>
          </div>
        ) : filtered.length === 0 ? (
          <div style={{ textAlign:"center",padding:"60px 0" }}>
            <p style={{ fontSize:"14px",color:"var(--app-text-muted)",fontWeight:600 }}>
              {search || tab !== "all" ? "No sessions match" : "No generated pins yet"}
            </p>
            <p style={{ fontSize:"12px",color:"#CBD5E1",marginTop:4 }}>
              {search || tab !== "all" ? "Try a different filter" : "Generated pins will appear here after your first creation"}
            </p>
            {!search && tab === "all" && (
              <Link href="/app/studio"
                style={{ display:"inline-block",marginTop:16,padding:"8px 20px",borderRadius:8,background:"linear-gradient(135deg,#FF4D8D,#7C3AED)",color:"#fff",fontSize:"12px",fontWeight:700,textDecoration:"none" }}>
                Create your first Pins →
              </Link>
            )}
          </div>
        ) : (
          <>
            <div style={{ display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(220px,1fr))",gap:16 }}>
              {filtered.map(entry => (
                <SessionCard
                  key={entry.id}
                  entry={entry}
                  selected={selected.has(entry.id)}
                  onToggleSelect={e => toggleSelect(entry.id, e)}
                  onOpen={() => setOpenEntry(entry)}
                />
              ))}
            </div>
            <p style={{ marginTop:20,fontSize:"11px",color:"var(--app-text-muted)",textAlign:"center" }}>
              Showing {filtered.length} of {entries.length} session{entries.length !== 1 ? "s" : ""}
            </p>
          </>
        )}
      </div>

      {openEntry && (
        <SessionModal entry={openEntry} onClose={() => setOpenEntry(null)}/>
      )}

    </div>
  );
}
