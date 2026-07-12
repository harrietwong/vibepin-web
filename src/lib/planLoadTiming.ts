// Dev-only Plan-page load timing. No-ops entirely in production builds.
// Separate from web/src/lib/navTiming.ts (sidebar click → route timing) — this
// tracks the Plan page's own data waterfall (session user → plan row → plan
// items → hydrated) so a slow step is identifiable at a glance.
//
// Logs:
//   [Plan Load] session user ready: Nms userPresent=true
//   [Plan Load] plan row ready: Nms planId=...
//   [Plan Load] plan items ready: Nms count=...
//   [Plan Load] hydrated=true total=Nms
//   [Plan Load] slow step: stepName Nms   (any step over 500ms)
//
// Never logs private user data — only presence booleans, row ids, and counts.

const DEV = process.env.NODE_ENV !== "production";
const SLOW_THRESHOLD_MS = 500;

// NOTE: slow steps are marked inline with a " (slow)" suffix on the single log line
// rather than a separate console.warn. In Next dev, console.warn calls made during
// React's commit phase get wrapped with a full component stack trace, which flooded
// the console with hundreds of lines and buried the actual timing/error output.
export function logPlanStep(step: string, ms: number, detail?: string): void {
  if (!DEV) return;
  const rounded = Math.round(ms);
  const suffix = detail ? ` ${detail}` : "";
  const slow = rounded > SLOW_THRESHOLD_MS ? " (slow)" : "";
  console.log(`[Plan Load] ${step}: ${rounded}ms${suffix}${slow}`);
}

export function logPlanHydrated(ms: number): void {
  if (!DEV) return;
  const rounded = Math.round(ms);
  const slow = rounded > SLOW_THRESHOLD_MS ? " (slow)" : "";
  console.log(`[Plan Load] hydrated=true total=${rounded}ms${slow}`);
}

// ── Post-OAuth-return investigation trace ────────────────────────────────────
// A separate, more granular checkpoint list requested for tracing exactly where
// time goes between "Pinterest OAuth callback lands on /app/plan" and "the
// restored Pin drawer is usable". Distinct tag ([Plan timing]) so it's easy to
// grep independently of the existing [Plan Load] waterfall log above — the two
// overlap in places (e.g. "auth ready" ~= "session user ready") by design, so a
// reader can cross-reference either trace.
//
// Logs:
//   [Plan timing] page mounted: 0ms
//   [Plan timing] auth ready: Nms
//   [Plan timing] workspace ready: 0ms n/a — no workspace partition, plan is keyed by user_id only
//   [Plan timing] weekly plan query started: Nms
//   [Plan timing] weekly plan query response received: Nms queryMs=N
//   [Plan timing] planId resolved: Nms planId=...
//   [Plan timing] drawer restore started: Nms
//   [Plan timing] drawer restore finished: Nms outcome=opened|not_found
export function logPlanTiming(step: string, ms: number, detail?: string): void {
  if (!DEV) return;
  const rounded = Math.round(ms);
  const suffix = detail ? ` ${detail}` : "";
  const slow = rounded > SLOW_THRESHOLD_MS ? " (slow)" : "";
  console.log(`[Plan timing] ${step}: ${rounded}ms${suffix}${slow}`);
}
