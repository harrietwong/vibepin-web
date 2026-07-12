/**
 * analytics.ts — minimal, SSR-safe client analytics.
 *
 * There is no analytics pipeline in this app yet, so this is intentionally small:
 * every event is (a) logged in dev and (b) dispatched as a `vp:analytics` window
 * CustomEvent so a real sink (PostHog / GA / server beacon) can subscribe later
 * without touching call sites. Never throws; safe to call anywhere.
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
  | "ai_copy_latency_ms";

export type AnalyticsProps = Record<string, string | number | boolean | null | undefined>;

export const ANALYTICS_EVENT = "vp:analytics";

const isDev = process.env.NODE_ENV !== "production";

export function track(event: AnalyticsEvent, props: AnalyticsProps = {}): void {
  const payload = { event, props, ts: Date.now() };
  if (isDev) {
    // eslint-disable-next-line no-console
    console.info(`[analytics] ${event}`, props);
  }
  if (typeof window !== "undefined") {
    try {
      window.dispatchEvent(new CustomEvent(ANALYTICS_EVENT, { detail: payload }));
    } catch { /* CustomEvent unsupported — non-fatal */ }
  }
}

/**
 * Record a latency measurement as an `ai_copy_latency_ms` event. `phase` names the
 * span being measured (e.g. "upload_to_analysis_ready", "generate_click_to_copy").
 */
export function trackLatency(phase: string, ms: number, props: AnalyticsProps = {}): void {
  track("ai_copy_latency_ms", { phase, ms: Math.round(ms), ...props });
}
