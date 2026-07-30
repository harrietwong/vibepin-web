/**
 * analytics.ts — SSR-safe client analytics.
 *
 * Every event is (a) logged in dev, (b) dispatched as a `vp:analytics` window
 * CustomEvent (legacy in-page subscribers), and (c) buffered + reported to the
 * durable sink POST /api/analytics/events (PRD v0.2 A4). Reporting is strictly
 * fire-and-forget: it buffers, batches, sends via navigator.sendBeacon (fetch
 * keepalive fallback), swallows every error, and NEVER throws or blocks the caller.
 */

export type AnalyticsEvent =
  | "image_analysis_started"
  | "image_analysis_ready"
  | "image_analysis_failed"
  | "recommended_keywords_ready"
  | "ai_copy_generate_clicked"
  | "ai_copy_success"
  | "ai_copy_quality_failed"
  | "ai_copy_provider_failed"
  // Server returned 429 (per-user AI cost ceiling, Phase 1B PR2). Deliberately its
  // OWN event: before it existed these landed in `ai_copy_quality_failed`, inflating
  // the quality-failure rate with requests the model never even saw.
  | "ai_copy_rate_limited"
  | "image_analysis_rate_limited"
  | "quality_judge_rate_limited"
  | "ai_copy_latency_ms"
  // ── PRD v0.2 Creative-Intelligence events (channel + types ready; wired incrementally) ──
  | "direction_selected"
  | "direction_rejected"
  | "reference_selected"
  | "reference_rejected"
  | "keyword_removed"
  | "generation_kept"
  | "generation_deleted"
  | "generation_judged"
  | "regenerate_clicked"
  | "draft_published";

/**
 * Optional version stamps for an event's payload (PRD v0.2 — "events carry versions").
 * Lets the durable sink attribute an event to the exact prompt / judge / model that
 * produced it, so accumulated analytics stay comparable across iterations. Purely a
 * type-level convention — NOT enforced at every call site; only the events that have a
 * meaningful version attach one. Constants live next to each prompt/judge:
 *   promptVersion → COPY_PROMPT_VERSION (ai-copy/visionServer.ts) or
 *                   HIDDEN_PROMPT_VERSION (studio/hiddenPromptBuilder.ts)
 *   judgeVersion  → JUDGE_VERSION (ai-copy/judgeVerdict.ts)
 */
export type EventVersions = {
  promptVersion?: string;
  judgeVersion?: string;
  modelVersion?: string;
};

/**
 * Event props. A flat bag of scalars, PLUS an optional nested `versions` object. The
 * index-signature union includes EventVersions so `versions` type-checks; every other
 * key stays a scalar. Nested `versions` rides through to the JSONB payload untouched
 * (analyticsIngest.ts accepts nested objects).
 */
export type AnalyticsProps = {
  versions?: EventVersions;
  [key: string]: string | number | boolean | null | undefined | EventVersions;
};

export const ANALYTICS_EVENT = "vp:analytics";

const isDev = process.env.NODE_ENV !== "production";

// ── Durable reporting (fire-and-forget buffer) ─────────────────────────────────

const REPORT_ENDPOINT = "/api/analytics/events";
const FLUSH_AT = 15;          // flush once the buffer reaches this (server cap is 20)
const MAX_BATCH = 20;         // never send more than the server accepts per request
const FLUSH_DEBOUNCE_MS = 2_000;

interface BufferedEvent { event: string; payload: AnalyticsProps; draftId?: string }

let _buffer: BufferedEvent[] = [];
let _flushTimer: ReturnType<typeof setTimeout> | null = null;
let _lifecycleBound = false;

function bindLifecycleFlush(): void {
  if (_lifecycleBound || typeof window === "undefined") return;
  _lifecycleBound = true;
  try {
    // Flush before the page goes away so a hard navigation doesn't drop the buffer.
    window.addEventListener("pagehide", () => flushReports());
    window.addEventListener("visibilitychange", () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") flushReports();
    });
  } catch { /* environments without these events — non-fatal */ }
}

function enqueueReport(event: string, props: AnalyticsProps): void {
  if (typeof window === "undefined") return; // SSR — nothing to report
  const draftId = typeof props.draftId === "string" ? props.draftId : undefined;
  _buffer.push({ event, payload: props, draftId });
  bindLifecycleFlush();
  if (_buffer.length >= FLUSH_AT) { flushReports(); return; }
  if (!_flushTimer) {
    _flushTimer = setTimeout(() => { _flushTimer = null; flushReports(); }, FLUSH_DEBOUNCE_MS);
  }
}

/** Drain up to MAX_BATCH buffered events to the sink. Silent on every failure. */
function flushReports(): void {
  if (typeof window === "undefined") return;
  if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
  if (_buffer.length === 0) return;

  const batch = _buffer.splice(0, MAX_BATCH);
  const body = JSON.stringify({
    events: batch.map(e => ({ event: e.event, payload: e.payload, draftId: e.draftId })),
  });

  let sent = false;
  try {
    if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
      sent = navigator.sendBeacon(REPORT_ENDPOINT, new Blob([body], { type: "application/json" }));
    }
  } catch { sent = false; }

  if (!sent) {
    try {
      void fetch(REPORT_ENDPOINT, {
        method: "POST",
        body,
        headers: { "Content-Type": "application/json" },
        keepalive: true,
        credentials: "include",
      }).catch(() => { /* fire-and-forget */ });
    } catch { /* fetch unavailable — drop silently */ }
  }

  // More than one batch waiting → schedule the remainder.
  if (_buffer.length > 0 && !_flushTimer) {
    _flushTimer = setTimeout(() => { _flushTimer = null; flushReports(); }, FLUSH_DEBOUNCE_MS);
  }
}

// ── Public API ─────────────────────────────────────────────────────────────────

export function track(event: AnalyticsEvent, props: AnalyticsProps = {}): void {
  const payload = { event, props, ts: Date.now() };
  if (isDev) {
    console.info(`[analytics] ${event}`, props);
  }
  if (typeof window !== "undefined") {
    try {
      window.dispatchEvent(new CustomEvent(ANALYTICS_EVENT, { detail: payload }));
    } catch { /* CustomEvent unsupported — non-fatal */ }
  }
  try {
    enqueueReport(event, props);
  } catch { /* reporting must never affect the caller */ }
}

/**
 * Record a latency measurement as an `ai_copy_latency_ms` event. `phase` names the
 * span being measured (e.g. "upload_to_analysis_ready", "generate_click_to_copy").
 */
export function trackLatency(phase: string, ms: number, props: AnalyticsProps = {}): void {
  track("ai_copy_latency_ms", { phase, ms: Math.round(ms), ...props });
}

// ── Test hooks (not used by product code) ──────────────────────────────────────

/** Force an immediate flush (bypasses the debounce). Test-only. */
export function __flushAnalyticsForTests(): void { flushReports(); }

/** Inspect the pending buffer. Test-only. */
export function __getAnalyticsBufferForTests(): BufferedEvent[] { return [..._buffer]; }

/** Clear buffer + timer + lifecycle binding. Test-only. */
export function __resetAnalyticsForTests(): void {
  if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
  _buffer = [];
  _lifecycleBound = false;
}
