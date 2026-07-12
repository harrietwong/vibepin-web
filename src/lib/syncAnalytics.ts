/**
 * syncAnalytics.ts — WP-E telemetry wiring for the account-sync engines.
 *
 * The write-through engines (userStoreSync, pinDraftSync) and the media-offload
 * sweep must stay free of analytics side-effects so the node test harness can
 * exercise them without touching the analytics buffer/timers. They therefore
 * expose injectable telemetry hooks; THIS module builds those hooks on top of the
 * shared analytics.track() sink and the registry installs them at app start.
 *
 * analytics.ts is treated as read-only (another session owns it): its
 * AnalyticsEvent union does not (yet) list these sync events, so the event names
 * are cast to AnalyticsEvent at the single call site here. track() only ever uses
 * the event as an opaque string, so the cast is safe.
 *
 * Events are emitted ONLY on state transitions (not on every retry) — the engines
 * guard that; this module just formats the payloads.
 */

import { track, type AnalyticsEvent } from "./analytics";
import { setSyncTelemetry } from "./userStoreSync";
import { setPinDraftSyncTelemetry } from "./pinDraftSync";
import { setMediaOffloadTelemetry } from "./mediaOffload";

// Event names live only here (not in the analytics union, which is owned elsewhere).
const EV_ERROR_ENTERED = "sync_error_entered" as AnalyticsEvent;
const EV_RECOVERED = "sync_recovered" as AnalyticsEvent;
const EV_QUOTA_REJECTED = "sync_doc_rejected_quota" as AnalyticsEvent;
const EV_OVERSIZE_SKIPPED = "sync_doc_skipped_oversize" as AnalyticsEvent;
const EV_MEDIA_OFFLOAD_FAILED = "media_offload_failed" as AnalyticsEvent;

/** Coarse-grained bucket for a sync-interruption duration (avoids high-cardinality). */
export function downtimeBucket(ms: number): string {
  if (ms < 5_000) return "under_5s";
  if (ms < 30_000) return "under_30s";
  if (ms < 120_000) return "under_2m";
  if (ms < 600_000) return "under_10m";
  return "over_10m";
}

let _installed = false;

/**
 * Install analytics-backed telemetry on all three sync subsystems. Idempotent.
 * Safe to call during SSR (track() itself no-ops server-side).
 */
export function installSyncTelemetry(): void {
  if (_installed) return;
  _installed = true;

  setSyncTelemetry({
    onErrorEntered: (storeKey, failureCount) =>
      track(EV_ERROR_ENTERED, { storeKey, failureCount }),
    onRecovered: (storeKey, downMs) =>
      track(EV_RECOVERED, { storeKey, downMs: Math.round(downMs), downtime: downtimeBucket(downMs) }),
    onQuotaRejected: (storeKey, count) =>
      track(EV_QUOTA_REJECTED, { storeKey, count }),
    onOversizeSkipped: (storeKey, docId) =>
      track(EV_OVERSIZE_SKIPPED, { storeKey, docId }),
  });

  setPinDraftSyncTelemetry({
    onErrorEntered: (failureCount) =>
      track(EV_ERROR_ENTERED, { storeKey: "pin-drafts", failureCount }),
    onRecovered: (downMs) =>
      track(EV_RECOVERED, { storeKey: "pin-drafts", downMs: Math.round(downMs), downtime: downtimeBucket(downMs) }),
    onOversizeSkipped: (draftId) =>
      track(EV_OVERSIZE_SKIPPED, { storeKey: "pin-drafts", docId: draftId }),
  });

  setMediaOffloadTelemetry({
    onSweepFailure: (failureCount) =>
      track(EV_MEDIA_OFFLOAD_FAILED, { failureCount }),
  });
}
